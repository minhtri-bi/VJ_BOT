import {sessionUser} from '../auth.js';
import {rateLimited} from '../ai-usage.js';
import {streamLLM} from '../llm.js';
import {LIVE_MAX_SEGMENTS, VOICE_COMMANDS, voiceStreamingInstructions} from '../prompt.js';
import {providerFailure, resolveProvider} from '../providers.js';
import {catalogLesson, groundLesson, processingAllowed, resolveTaskReference, teacherCatalog, validFocusReference, validLessonReference, validTaskReference} from '../tutor-context.js';
import {normalizeVoiceText} from './normalizer.js';
import {segmentVoiceText} from './segmenter.js';
import {MAX_VOICE_TEXT, readVoiceBody} from './tts-route.js';

const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const tag = /<(\/?)(ja|vi)>/i;
const tags = /<\/?(?:ja|vi)>/gi;
const tagPrefix = /<\/?(?:[jv][ai]?)?$/i;
// Wait for lookahead after an ASCII period: the next delta may contain a fractional digit.
const sentence = /(?:[。！？!?…][」』”’"')）]*|\.[」』”’"')）]*(?=\s))/u;
const sentenceEnd = /[。！？.!?…][」』”’"')）]*$/u;
const PLAIN_TARGET = 180;
const PLAIN_LOOKAHEAD = 256;
const TAGGED_LOOKAHEAD = 220;

function lengthCut(text, target) {
  const space = text.slice(0, target + 1).search(/\s+\S*$/u);
  return space > 0 ? space : target - Number(/[\uD800-\uDBFF]/.test(text[target - 1]));
}

function plainCut(text) {
  // A normal-length reply can end in the next delta or close at a language marker.
  const end = sentence.exec(text.slice(0, PLAIN_LOOKAHEAD + 1));
  const cut = end ? end.index + end[0].length : 0;
  if (cut && cut <= PLAIN_LOOKAHEAD) return cut;
  return text.length > PLAIN_LOOKAHEAD ? lengthCut(text, PLAIN_TARGET) : 0;
}

export function createSegmentChunker({maxSegments = LIVE_MAX_SEGMENTS, onSegment}) {
  let buffer = '', language = null, overflow = false, spokenLength = 0;
  const segments = [];
  function emit(raw, hint) {
    const text = normalizeVoiceText(raw.replace(tags, ' '));
    // Tags are hints, not proof that upstream kept Japanese and Vietnamese separate.
    const parts = segmentVoiceText(text, 'bilingual', {hint});
    if (!parts) {overflow = true;return;}
    for (const part of parts) {
      const length = part.text.length + `<${part.lang}></${part.lang}>`.length + Number(segments.length > 0);
      if (segments.length >= maxSegments || spokenLength + length > MAX_VOICE_TEXT) {overflow = true;break;}
      spokenLength += length;
      const index = segments.length;
      const boundary = !index ? 'start' : sentenceEnd.test(segments[index - 1].text) ? 'sentence' : 'inline';
      const item = {index, lang:part.lang, boundary, text:part.text};
      segments.push(item);
      onSegment(item);
    }
  }
  function emitBlock(raw) {
    // If a tag or EOF completes the block, split on real sentence endings only.
    while (!language && !overflow) {
      const end = sentence.exec(raw);
      if (!end) break;
      const cut = end.index + end[0].length;
      emit(raw.slice(0, cut), null);
      raw = raw.slice(cut);
    }
    if (!overflow) emit(raw, language);
  }
  function drain(final) {
    while (buffer && !overflow) {
      const marker = tag.exec(buffer);
      if (marker) {
        const raw = buffer.slice(0, marker.index);
        buffer = buffer.slice(marker.index + marker[0].length);
        emitBlock(raw);
        language = marker[1] ? null : marker[2].toLowerCase();
        continue;
      }
      if (final) {
        emitBlock(buffer.replace(tagPrefix, ''));
        buffer = '';
        break;
      }
      const available = buffer.replace(tagPrefix, '');
      let cut;
      if (!language) cut = plainCut(available);
      else {
        if (available.length <= TAGGED_LOOKAHEAD) break;
        const end = sentence.exec(available);
        cut = end ? end.index + end[0].length : lengthCut(available, TAGGED_LOOKAHEAD);
      }
      if (!cut) break;
      emit(buffer.slice(0, cut), language);
      buffer = buffer.slice(cut);
    }
    if (overflow) buffer = '';
  }
  return {
    push(delta) {
      if (overflow) return false;
      buffer += delta;
      drain(false);
      return !overflow;
    },
    flush() {
      drain(true);
      return {fullText:segments.map(part => part.text).join(' '), count:segments.length, overflow};
    }
  };
}

const jsonError = (status, code, detail) => Response.json({code, detail}, {status, headers:{'Cache-Control':'no-store'}});
const invalid = () => jsonError(400, 'live_invalid_request', 'Lượt hội thoại không hợp lệ. Em thử lại nhé.');
const forbidden = () => jsonError(409, 'live_source_unavailable', 'Nguồn này không được dùng để nhờ AI giải thích. Em chọn tài liệu khác nhé.');
const upstreamFailure = (status) => {
  if (status === 429) return {code:'live_quota', detail:'Đã chạm giới hạn lượt dùng của nhà cung cấp. Hãy thử lại sau.'};
  if ([401,402,403].includes(status)) return {code:'live_key_rejected', detail:'Nhà cung cấp từ chối kết nối đã chọn. Kiểm tra Cài đặt.'};
  if (status === 504) return {code:'live_timeout', detail:'Nhà cung cấp phản hồi quá lâu. Em thử lại nhé.'};
  return {code:'live_unavailable', detail:'Chưa kết nối được với thầy. Em thử lại nhé.'};
};

function liveEvents(provider, envelope, system, japaneseOnly, requestSignal) {
  const encoder = new TextEncoder(), stop = new AbortController();
  const signal = AbortSignal.any([requestSignal, stop.signal]);
  const budget = new AbortController();
  const generationSignal = AbortSignal.any([signal, budget.signal]);
  const compact = value => value.replace(/\s+/gu, '');
  const secret = compact(normalizeVoiceText(provider.apiKey));
  const pending = [];
  return new Response(new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      function sendPending(final = false) {
        const joined = pending.map(item => compact(item.text)).join('');
        if (secret && joined.includes(secret)) throw new Error('Invalid provider output');
        // A key prefix at the end may continue across spoken tags or delta boundaries.
        let held = final ? 0 : Math.max(0, Math.min(joined.length, secret.length - 1));
        while (held && !secret.startsWith(joined.slice(-held))) held--;
        let remaining = joined.length - held;
        while (pending.length) {
          const length = compact(pending[0].text).length;
          if (length > remaining) break;
          remaining -= length;
          send('segment', pending.shift());
        }
      }
      const chunker = createSegmentChunker({onSegment:item => {pending.push(item);sendPending();}});
      const tooLong = () => send('error', {code:'live_reply_too_long', detail:'Lượt trả lời quá dài. Em thử hỏi ngắn hơn nhé.'});
      void (async () => {
        try {
          if (signal.aborted) return;
          const result = await streamLLM(provider, {system, turns:[{role:'user', content:envelope}], signal:generationSignal,
            onDelta(delta) {
              if (!chunker.push(delta)) budget.abort();
            }});
          if (signal.aborted) return;
          if (budget.signal.aborted) {tooLong();return;}
          if (!result.ok) {send('error', upstreamFailure(result.status));return;}
          const {fullText, count, overflow} = chunker.flush();
          if (overflow) {tooLong();return;}
          sendPending(true);
          if (!count) send('error', {code:'live_empty_reply', detail:'Thầy chưa trả lời được. Em thử nói lại nhé.'});
          else send('done', {full_text:fullText, count, japanese_only:japaneseOnly});
        } catch {
          send('error', upstreamFailure(502));
        } finally {
          if (!stop.signal.aborted) controller.close();
        }
      })();
    },
    cancel() {stop.abort();}
  }), {headers:{'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
}

export async function liveTurnRoute(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, 'live_sign_in', 'Đăng nhập để nói chuyện với thầy Lâm.');
  if (request.headers.get('X-VJBot-Account') !== user.user_id) return jsonError(409, 'account_changed', 'Tài khoản đã đổi. Hãy tải lại trang.');
  if (request.method !== 'POST') return jsonError(405, 'method_not_allowed', 'Phương thức không được phép.');
  let raw;
  try {raw = await readVoiceBody(request, 20 * 1024, request.signal);}
  catch {return request.signal.aborted ? new Response(null, {status:204}) : invalid();}
  if (raw === null) return jsonError(413, 'live_context_too_large', 'Nội dung quá dài. Em chọn một đoạn ngắn hơn nhé.');
  let data;
  try {data = JSON.parse(raw);} catch {return invalid();}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid();
  const {lesson = null, focus = null, view = 'checks', task, command = null, transcript = '', history = [], japanese_only = false} = data;
  const level = data.level === undefined ? lesson?.level ?? 'N5' : data.level;
  const message = typeof transcript === 'string' ? transcript.replace(tags, ' ').trim() : '';
  if (!LEVELS.includes(level) || typeof transcript !== 'string' || transcript.trim().length > 1500
    || command !== null && (typeof command !== 'string' || command === 'repeat' || !Object.hasOwn(VOICE_COMMANDS, command))
    || !command && !message || typeof japanese_only !== 'boolean'
    || !Array.isArray(history) || history.length > 12
    || history.some(turn => !['user','assistant'].includes(turn?.role) || typeof turn.text !== 'string' || turn.text.length > 600 || !turn.text.trim())
    || !['checks','exam'].includes(view) || Object.hasOwn(data, 'view') && !lesson || view === 'exam' && focus?.kind !== 'question'
    || lesson !== null && (!validLessonReference(lesson) || lesson.level !== level)
    || focus !== null && (!lesson || !validFocusReference(focus))
    || task !== undefined && (focus?.kind !== 'question' || !validTaskReference(task))) return invalid();
  const profile = request.headers.get('X-VJBot-Profile') ?? undefined;
  if (profile !== undefined && Object.hasOwn(data, 'api_connection')) return providerFailure({error:'invalid_connection'});
  let grounded = null;
  if (lesson) {
    const catalog = await teacherCatalog(env, level);
    if (!catalog) return jsonError(503, 'live_catalog_unavailable', 'Chưa tải được bài. Em thử lại nhé.');
    const canonical = catalogLesson(catalog, lesson);
    if (!canonical) return invalid();
    if (!processingAllowed(canonical)) return forbidden();
    if (focus?.kind === 'question') {
      const resolved = resolveTaskReference(canonical, focus, view, task, 'hint');
      if (resolved.error) return jsonError(resolved.status, 'live_task_unavailable', resolved.error);
    } else if (focus) {
      const item = canonical[focus.kind === 'word' ? 'words' : 'examples']?.[focus.index];
      if (!item) return invalid();
      if (!processingAllowed(item)) return forbidden();
    }
    grounded = groundLesson(canonical, focus, view);
    if (!grounded) return forbidden();
  }
  const envelope = JSON.stringify({message:message || null,
    command:command ? {key:command, instruction:VOICE_COMMANDS[command]} : null, japanese_only,
    reference:{level, lesson:grounded, history:history.map(({role,text}) => ({role, text:text.replace(tags, ' ').trim()})).filter(turn => turn.text)}});
  if (envelope.length > 16000) return jsonError(413, 'live_context_too_large', 'Em chọn một mục cụ thể để thầy giải thích nhé.');
  if (request.signal.aborted) return new Response(null, {status:204});
  if (await rateLimited(env, user.user_id)) return jsonError(429, 'live_rate_limited', 'Em hãy đợi một phút rồi thử lại.');
  if (request.signal.aborted) return new Response(null, {status:204});
  const provider = await resolveProvider(env, user.user_id, data.api_connection, profile, {signal:request.signal});
  if (request.signal.aborted) return new Response(null, {status:204});
  const failure = providerFailure(provider);
  if (failure) return failure;
  return liveEvents(provider, envelope, voiceStreamingInstructions(level, {japaneseOnly:japanese_only, preAnswerTask:focus?.kind === 'question'}), japanese_only, request.signal);
}
