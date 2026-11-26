import {compatibleSpeechModel, DEFAULT_SPEECH_MODEL, MISTRAL_SPEECH_BASE, MISTRAL_SPEECH_MODEL} from '../speech.js';
import {DEFAULT_BASES, listModels} from '../llm.js';

export const MAX_AUDIO = 5 * 1024 * 1024;
const MAX_CATALOG = 1024 * 1024;
const alphabet = /^[\w.:-]+$/;
const id = value => typeof value === 'string' && value.length <= 100 && alphabet.test(value);
const presets = {ja:'voice_3133', vi:'voice_3144'};
const openaiModel = 'gpt-4o-mini-tts';
const elevenModel = 'eleven_flash_v2_5';
const safeMessage = {
  tts_unavailable:'Không tạo được giọng đọc. Hệ thống không đổi nhà cung cấp.',
  tts_key_rejected:'Nhà cung cấp từ chối khóa hoặc quyền giọng nói đã chọn.',
  tts_quota:'Nhà cung cấp giọng nói đang giới hạn lượt dùng.',
  tts_voice_unavailable:'Không dùng được giọng hoặc model đã chọn với tài khoản này.',
  tts_audio_limit:'Âm thanh trả về vượt giới hạn.',
  tts_language_unsupported:'Model đã chọn không hỗ trợ ngôn ngữ của đoạn cần đọc.'
};

export class VoiceError extends Error {
  constructor(code, status, detail = safeMessage[code]) {
    super(detail); this.code = code; this.status = status;
  }
}

export const VOICE_BASES = Object.freeze({elevenlabs:'https://api.elevenlabs.io', mistral:MISTRAL_SPEECH_BASE,
  gemini:DEFAULT_BASES.gemini, openai:DEFAULT_BASES.openai, openai_compatible:''});

export function audioMime(raw) {
  const type = (typeof raw === 'string' ? raw : '').split(';',1)[0].trim().toLowerCase();
  if (/^audio\/(?:mpeg|mp3|wav|x-wav|ogg|opus)$/.test(type)) return type;
  if (type !== 'audio/l16') return null;
  const rate = Number(raw.match(/;\s*rate=(\d+)(?:;|$)/i)?.[1] || 24000);
  const channels = Number(raw.match(/;\s*channels=(\d+)(?:;|$)/i)?.[1] || 1);
  return rate >= 8000 && rate <= 192000 && [1,2].includes(channels) ? `audio/L16;rate=${rate};channels=${channels}` : null;
}

async function readBytes(response, limit) {
  if (!response.body) throw new VoiceError('tts_unavailable',502);
  if (Number(response.headers.get('Content-Length')) > limit) {
    await response.body.cancel();
    throw new VoiceError('tts_audio_limit',502);
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {await reader.cancel(); throw new VoiceError('tts_audio_limit',502);}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  if (!size) throw new VoiceError('tts_unavailable',502);
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {result.set(chunk, offset); offset += chunk.byteLength;}
  return result;
}

async function readJson(response, limit = MAX_CATALOG) {
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(response,limit)));
}

function normalizeAudio(value, mimeType) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new VoiceError('tts_unavailable',502);
  const bytes = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (bytes > MAX_AUDIO) throw new VoiceError('tts_audio_limit',502);
  if (!mimeType) throw new VoiceError('tts_unavailable',502);
  return {audioBase64:value,mimeType,bytes};
}

async function audioData(response, {jsonField, mime}) {
  const type = response.headers.get('Content-Type');
  if (jsonField && /^application\/(?:json|[\w.+-]+\+json)(?:;|$)/i.test(type || '')) {
    const document = await readJson(response, Math.ceil(MAX_AUDIO / 3) * 4 + 65536);
    const part = jsonField(document);
    return normalizeAudio(part.data,audioMime(part.mimeType ?? mime));
  }
  const format = audioMime(type) || (type?.split(';',1)[0] === 'application/octet-stream' ? audioMime(mime) : null);
  if (!format) {await response.body?.cancel(); throw new VoiceError('tts_unavailable',502);}
  const chunks = await readBytes(response,MAX_AUDIO);
  let binary = '';
  for (let i = 0; i < chunks.length; i += 8192) binary += String.fromCharCode(...chunks.subarray(i,i + 8192));
  return {audioBase64:btoa(binary),mimeType:format,bytes:chunks.length};
}

function headersFor(provider) {
  if (provider.kind === 'elevenlabs') return {'xi-api-key':provider.apiKey};
  if (provider.kind === 'gemini') return {'x-goog-api-key':provider.apiKey};
  return {Authorization:`Bearer ${provider.apiKey}`};
}

async function send(provider, path, signal, body) {
  const headers = headersFor(provider);
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(provider.baseUrl + path, {method:body ? 'POST' : 'GET', headers, redirect:'manual',
    cache:'no-store', signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]), body:body && JSON.stringify(body)});
  if (response.ok) return response;
  await response.body?.cancel();
  if ([401,402,403].includes(response.status)) throw new VoiceError('tts_key_rejected',403);
  if ([404,422].includes(response.status)) throw new VoiceError('tts_voice_unavailable',409);
  if (response.status === 429) throw new VoiceError('tts_quota',429);
  throw new VoiceError('tts_unavailable',502);
}

const langModel = (model, lang) => !(lang === 'vi' && model === 'eleven_multilingual_v2') &&
  (!['eleven_flash_v2','eleven_turbo_v2'].includes(model) || !['ja','vi'].includes(lang));

export function voiceSettings(kind, slot, lang, single) {
  const model = slot.model || ({elevenlabs:elevenModel,mistral:MISTRAL_SPEECH_MODEL,openai:openaiModel,gemini:DEFAULT_SPEECH_MODEL})[kind];
  const voice = slot.voice_id || ({mistral:single ? null : presets[lang],openai:'alloy',gemini:'Charon'})[kind];
  const format = slot.format ?? (kind === 'elevenlabs' ? 'mp3_44100_128' : undefined);
  if (!id(model) || !id(voice) || (kind === 'elevenlabs' && !['mp3_44100_128','mp3_22050_32'].includes(format)) ||
      (kind === 'gemini' && (voice !== 'Charon' || !compatibleSpeechModel(model))) ||
      (kind === 'openai' && (model !== openaiModel || !/^[a-z]+$/.test(voice))) ||
      (kind === 'mistral' && model !== MISTRAL_SPEECH_MODEL)) throw new VoiceError('tts_invalid_settings',400,'Chọn model và giọng đọc hợp lệ cho nhà cung cấp này.');
  if (kind === 'elevenlabs' && !langModel(model,lang)) throw new VoiceError('tts_language_unsupported',400);
  return {model,voice,format};
}

const registry = {
  elevenlabs: {
    async synthesize({text,lang,model,voice,format,prevText,nextText}, provider, signal) {
      const response = await send(provider,`/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`,signal,{
        text,model_id:model,...(model === 'eleven_multilingual_v2' ? {} : {language_code:lang}),
        ...(prevText ? {previous_text:prevText} : {}),...(nextText ? {next_text:nextText} : {})
      });
      return audioData(response,{mime:'audio/mpeg'});
    },
    async listCatalog(provider, signal, cursor) {
      const query = new URLSearchParams({page_size:'100',include_total_count:'false'});
      if (cursor) query.set('next_page_token',cursor);
      const [models, voices] = await Promise.all([
        send(provider,'/v1/models',signal).then(response => readJson(response)),
        send(provider,'/v2/voices?' + query,signal).then(response => readJson(response))
      ]);
      if (!Array.isArray(models) || !Array.isArray(voices?.voices)) throw new VoiceError('tts_unavailable',502);
      return {models:models.filter(model => model?.can_do_text_to_speech === true).map(model => ({id:model.model_id,
        languages:Array.isArray(model.languages) ? ['ja','vi'].filter(lang => model.languages.some(row => row?.language_id === lang)) : undefined})),
      voices:voices.voices.map(row => ({id:row?.voice_id,name:row?.name,category:row?.category})),
      next_cursor:voices.has_more && typeof voices.next_page_token === 'string' ? voices.next_page_token : null};
    }
  },
  mistral: {
    async synthesize({text,model,voice}, provider, signal) {
      return audioData(await send(provider,'/audio/speech',signal,{model,voice_id:voice,input:text,response_format:'mp3'}),
        {mime:'audio/mpeg',jsonField:body => ({data:body?.audio_data})});
    },
    async listCatalog() {return {models:[{id:MISTRAL_SPEECH_MODEL}],voices:[{id:presets.ja,name:'Haruto',lang:'ja'},{id:presets.vi,name:'Huong',lang:'vi'}]};}
  },
  openai_compatible: {
    async synthesize({text,model,voice}, provider, signal) {
      return audioData(await send(provider,'/audio/speech',signal,{model,voice,input:text,response_format:'mp3'}),{
        mime:'audio/mpeg',jsonField:body => ({data:body?.audio_data ?? body?.audioBase64 ?? body?.audio,mimeType:body?.mime_type ?? body?.mimeType})});
    },
    async listCatalog(provider,signal) {
      const document = await readJson(await send(provider,'/models',signal));
      if (!Array.isArray(document?.data)) throw new VoiceError('tts_unavailable',502);
      return {models:document.data.map(row => ({id:row?.id})),voices:[]};
    }
  },
  openai: {
    async synthesize({text,lang,model,voice}, provider, signal) {
      const instructions = lang === 'ja' ? 'Read exactly as written with natural native Japanese pronunciation.' : 'Read exactly as written with native Vietnamese tones and pronunciation.';
      return audioData(await send(provider,'/audio/speech',signal,{model,voice,input:text,response_format:'mp3',instructions}),{mime:'audio/mpeg'});
    },
    async listCatalog() {return {models:[{id:openaiModel}],voices:['alloy','marin','cedar'].map(id => ({id,name:id}))};}
  },
  gemini: {
    async synthesize({text,lang,model,voice}, provider, signal) {
      const style = lang === 'ja' ? '日本語の標準的な発音で、原文だけを自然に読んでください。' : 'Chỉ đọc nguyên văn, dùng phát âm tiếng Việt bản ngữ rõ thanh điệu.';
      return audioData(await send(provider,`/v1beta/models/${encodeURIComponent(model)}:generateContent`,signal,{
        contents:[{role:'user',parts:[{text,speech_metadata:{style}}]}],
        generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}}}
      }),{mime:'audio/l16',jsonField:body => body?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data)?.inlineData ?? {}});
    },
    async listCatalog(provider) {
      const result = await listModels({protocol:'gemini',baseUrl:provider.baseUrl,apiKey:provider.apiKey});
      if (result.status) throw new VoiceError(result.status === 429 ? 'tts_quota' : 'tts_unavailable',result.status === 429 ? 429 : 502);
      return {models:result.models.filter(compatibleSpeechModel).map(id => ({id})),voices:[{id:'Charon',name:'Charon'}],truncated:result.truncated};
    }
  }
};

export function synthesizeVoice(segment, provider, signal) {
  return registry[provider.kind].synthesize(segment,provider,signal);
}

export async function voiceCatalog(provider, signal, cursor) {
  const result = await registry[provider.kind].listCatalog(provider,signal,cursor);
  const safe = value => typeof value === 'string' && !value.includes(provider.apiKey);
  const models = result.models.filter(row => id(row.id) && safe(row.id)).slice(0,1000);
  const voices = result.voices.filter(row => id(row.id) && safe(row.id) && safe(row.name)).slice(0,150).map(row => ({id:row.id,
    name:row.name.slice(0,120),...(['cloned','premade','professional','generated'].includes(row.category) ? {category:row.category} : {}),
    ...(['ja','vi'].includes(row.lang) ? {lang:row.lang} : {})}));
  return {models,voices,verified:false,...(safe(result.next_cursor) && result.next_cursor.length <= 512 ? {next_cursor:result.next_cursor} : {}),
    ...(result.truncated ? {truncated:true} : {})};
}
