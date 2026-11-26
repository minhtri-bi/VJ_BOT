import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceTts} from '../src/voice/tts-route.js';

const key = 'synthetic-tts-test-key';
const slot = (provider, voice_id, base_url) => ({provider, voice_id,
  profile:{scope:'local',connection:{api_key:key,...(base_url ? {base_url} : {})}}});
const split = (ja, vi) => ({version:2,mode:'dual_split_api',primary:vi,ja,vi:{profile:null}});
const tts = (body, {env = {}, ...context} = {}) => voiceTts(body, env, {userId:'learner', ...context});
const lines = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));

function intercept(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => {globalThis.fetch = original;});
}

const mp3 = () => new Response(Uint8Array.of(73,68,51,4), {headers:{'Content-Type':'audio/mpeg'}});

test('bilingual stream binds each segment to its selected provider and preserves order and boundaries', async t => {
  const calls = [];
  intercept(t, async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([new URL(url).hostname, body.text ?? body.input, body.language_code]);
    assert.equal(init.redirect, 'manual');
    if (url.includes('mistral.ai')) {
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.equal(body.voice_id, 'voice_3133');
      return Response.json({audio_data:'SUQzBA=='});
    }
    assert.equal(init.headers['xi-api-key'], key);
    assert.match(url, /\/text-to-speech\/vi_voice\?/);
    return mp3();
  });
  const response = await tts({text:'Trợ từ 「は」 → 「{学校|がっこう}に行きます」. <vi>Thử nói nhé.</vi>', mode:'bilingual',stream:true,
    routing:split(slot('mistral','voice_3133'),slot('elevenlabs','vi_voice'))});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^application\/x-ndjson\b/);
  assert.deepEqual((await lines(response)).map(({type,lang,boundary})=>[type,lang,boundary]),[
    ['segment','vi','start'],['segment','ja','inline'],['segment','ja','arrow'],['segment','vi','sentence'],['done',undefined,undefined]]);
  assert.deepEqual(calls, [
    ['api.elevenlabs.io','Trợ từ','vi'], ['api.mistral.ai','「わ」',undefined],
    ['api.mistral.ai','「学校に行きます」.',undefined], ['api.elevenlabs.io','Thử nói nhé.','vi']]);
});

test('Japanese-only listening preserves acronyms in Japanese context and skips Vietnamese', async t => {
  const inputs = [];
  intercept(t, async (_url,init) => {inputs.push(JSON.parse(init.body).input);return mp3();});
  const response = await tts({text:'DVDを見ます。 Em xem DVD. 映画は4Kです。 Em xem NASA\nＪＬＰＴの試験。 USB HDMI対応。 <vi>VI</vi>',mode:'ja',stream:true,
    routing:{version:2,mode:'single',primary:slot('openai','alloy')}});
  assert.equal(response.status,200);
  assert.equal((await lines(response)).at(-1).type,'done');
  assert.deepEqual(inputs,['DVDを見ます。 映画は4Kです。 ＪＬＰＴの試験。 USB HDMI対応。']);
});

test('one ElevenLabs clone receives both language codes; multilingual v2 rejects VI before provider calls', async t => {
  const requests = [];
  intercept(t, async (url, init) => {requests.push([url,JSON.parse(init.body)]);return mp3();});
  const primary = slot('elevenlabs','only_clone','https://api.elevenlabs.io/v1/');
  const body = {text:'こんにちは。 Xin chào.',stream:true,routing:{version:2,mode:'single',primary}};
  assert.equal((await lines(await tts(body))).at(-1).type,'done');
  assert.deepEqual(requests.map(([url,data])=>[new URL(url).pathname,data.language_code]),[
    ['/v1/text-to-speech/only_clone','ja'], ['/v1/text-to-speech/only_clone','vi']]);
  primary.model = 'eleven_multilingual_v2';
  const rejected = await tts(body);
  assert.equal(rejected.status,400);
  assert.equal((await rejected.json()).code,'tts_language_unsupported');
  assert.equal(requests.length,2);
});

test('custom domains fail closed unless operator approved; redirects never receive a second request', async t => {
  const urls = [];
  intercept(t, async (url) => {urls.push(url); return new Response(null,{status:302,headers:{Location:'https://different.example/audio'}});});
  const primary = {...slot('openai_compatible','custom_voice','https://tts.example/v1/audio/speech'),model:'custom_model'};
  const body = {text:'Xin chào.',stream:true,routing:{version:2,mode:'single',primary}};
  assert.equal((await tts(body)).status,403);
  assert.deepEqual(urls,[]);
  const response = await tts(body,{env:{VOICE_ALLOWED_ORIGINS:'https://tts.example'}});
  const result = await lines(response);
  assert.equal(result[0].type,'error');
  assert.equal(result[0].code,'tts_unavailable');
  assert.deepEqual(urls,['https://tts.example/v1/audio/speech']);
});

test('voice catalog discovers ElevenLabs models and voices without synthesis or leaking a provider echo', async t => {
  const calls = [];
  intercept(t, async (url, init) => {
    calls.push([new URL(url).pathname,init.method]);
    return url.includes('/voices?') ? Response.json({voices:[{voice_id:'clone_x',name:'My clone',category:'cloned'},{voice_id:'echo',name:key}],has_more:false})
      : Response.json([{model_id:'eleven_flash_v2_5',can_do_text_to_speech:true,languages:[{language_id:'ja'},{language_id:'vi'}]}, {model_id:'stt_only',can_do_text_to_speech:false}]);
  });
  const response = await tts({action:'catalog',routing:{version:2,mode:'single',primary:slot('elevenlabs','')}});
  const catalog = await response.json();
  assert.deepEqual(catalog.voices,[{id:'clone_x',name:'My clone',category:'cloned'}]);
  assert.deepEqual(catalog.models,[{id:'eleven_flash_v2_5',languages:['ja','vi']}]);
  assert.deepEqual(calls,[['/v1/models','GET'],['/v2/voices','GET']]);
  assert.equal(JSON.stringify(catalog).includes(key),false);
});

test('approved ElevenLabs proxies retain versioned mounts for catalog and speech',async t=>{
  const calls=[];
  intercept(t,async (url,init)=>{
    calls.push(new URL(url).pathname);
    if (init.method==='POST') return mp3();
    return url.includes('/voices?') ? Response.json({voices:[]}) : Response.json([]);
  });
  const routing={version:2,mode:'single',primary:slot('elevenlabs','clone','https://voice.example/gateway/v1/')};
  const context={env:{VOICE_ALLOWED_ORIGINS:'https://voice.example'}};
  assert.equal((await tts({action:'catalog',routing},context)).status,200);
  assert.equal((await lines(await tts({text:'こんにちは。',stream:true,routing},context))).at(-1).type,'done');
  assert.deepEqual(calls,['/gateway/v1/v1/models','/gateway/v1/v2/voices','/gateway/v1/v1/text-to-speech/clone']);
});

test('more than sixteen segments and unauthorized managed routes fail before synthesis', async t => {
  let calls=0;
  intercept(t, async () => {calls++; return mp3();});
  const routing={version:2,mode:'single',primary:slot('elevenlabs','clone')};
  assert.equal((await tts({text:'あ test '.repeat(9),stream:true,routing})).status,413);
  const platform={version:2,mode:'single',primary:{provider:'openai',profile:{scope:'platform',id:'openai'}}};
  assert.equal((await tts({text:'Xin chào.',stream:true,routing:platform},{env:{OPENAI_API_KEY:key}})).status,403);
  assert.equal((await tts({text:'Xin chào.',stream:true,routing},{admin:true,env:{OPENAI_API_KEY:key}})).status,403);
  assert.equal((await tts({text:'あ test '.repeat(5),stream:true,routing:platform},{admin:true,env:{OPENAI_API_KEY:key}})).status,413);
  assert.equal(calls,0);
});

test('a short grammar explanation with thirteen alternating parts stays in one ordered stream',async t=>{
  const calls=[];
  intercept(t,async (_url,init)=>{calls.push(JSON.parse(init.body));return mp3();});
  const text='Trong tiếng Nhật, trợ từ は đánh dấu chủ đề, còn が nhấn mạnh chủ ngữ. Ví dụ 「私は学生です」 và 「誰が来ますか」. Ngoài ra, trợ từ を đi với tân ngữ như 「本を読みます」 nhé!';
  const routing={version:2,mode:'single',primary:slot('elevenlabs','clone')};
  const records=await lines(await tts({text,stream:true,routing}));
  assert.deepEqual(records.at(-1),{type:'done',count:13});
  assert.deepEqual(records.slice(0,-1).map(row=>[row.lang,row.speed]),Array.from({length:13},(_,i)=>[i%2?'ja':'vi',1]));
  assert.equal(calls.length,13);
  assert.equal(calls[1].text,'わ');
});

test('ElevenLabs gates optional text fields by model and splits native and client speed',async t=>{
  const calls=[];
  intercept(t,async (_url,init)=>{calls.push(JSON.parse(init.body));return mp3();});
  for (const [model,lang,context] of [
    ['eleven_flash_v2_5','ja',true],['eleven_multilingual_v2',undefined,true],
    ['eleven_v3','ja',false],['eleven_v4_turbo','ja',false],['eleven_multilingual_v1',undefined,false]
  ]) {
    const primary={...slot('elevenlabs','clone'),model,speed:0.6};
    const records=await lines(await tts({text:'学校 → 教室',mode:'ja',stream:true,routing:{version:2,mode:'single',primary}}));
    const [first,second]=calls.splice(0);
    const limited=model==='eleven_multilingual_v1';
    assert.deepEqual([first.language_code,first.next_text,second.previous_text,first.voice_settings?.speed,records[0].speed],
      [lang,context?'教室':undefined,context?'学校':undefined,limited?undefined:0.7,limited?0.6:0.6/0.7]);
  }
});

test('native OpenAI speed is not applied again, and an authored Japanese reading overrides Kanji',async t=>{
  const calls=[];
  intercept(t,async (_url,init)=>{calls.push(JSON.parse(init.body));return mp3();});
  const primary={...slot('openai','alloy'),speed:0.8,kanji_mode:'kanji_native'};
  const routing={version:2,mode:'single',primary};
  for (const [text,reading] of [['一日','ついたち'],['一日','いちにち'],['一日','invalid reading'],['歯','は']]) {
    const records=await lines(await tts({text,reading,mode:'ja',stream:true,routing}));
    assert.equal(records[0].speed,1);
  }
  primary.kanji_mode='kana_first';
  await lines(await tts({text:'今日・明日',reading:'きょう・あした',mode:'ja',stream:true,routing}));
  assert.deepEqual(calls.map(body=>[body.input,body.speed]),[['ついたち',0.8],['いちにち',0.8],['一日',0.8],['は',0.8],['きょう・あした',0.8]]);
});

test('same ElevenLabs account never exceeds two concurrent syntheses, even for one language', async t => {
  let active=0,peak=0;
  intercept(t,async()=>{
    peak=Math.max(peak,++active);
    await new Promise(resolve=>setImmediate(resolve));
    active--;
    return mp3();
  });
  const primary=slot('elevenlabs','clone');
  const response=await tts({text:'学校 → 教室 → 駅 → 図書館',stream:true,routing:{version:2,mode:'single',primary}});
  const records=await lines(response);
  assert.deepEqual(records.slice(0,-1).map(record=>record.index),[0,1,2,3]);
  assert.equal(records.at(-1).count,4);
  assert.equal(peak,2);
});

test('Mistral catalog returns account clones with an opaque next-page cursor', async t => {
  intercept(t,async (url,init)=>{
    const target=new URL(url);
    assert.equal(target.pathname,'/v2/audio/voices');
    assert.equal(target.searchParams.get('page_token'),'second');
    assert.equal(init.method,'GET');
    return Response.json({data:[{id:'voice_custom',name:'Teacher clone',type:'custom'}],next_page_token:'third'});
  });
  const response=await tts({action:'catalog',cursor:'second',routing:{version:2,mode:'single',primary:slot('mistral','')}});
  assert.deepEqual(await response.json(),{models:[{id:'voxtral-mini-tts-3-0'}],
    voices:[{id:'voice_custom',name:'Teacher clone',category:'cloned'}],verified:false,next_cursor:'third'});
});

test('custom profiles preserve client speed unless opted into native speed', async t => {
  const calls=[], speeds=[];
  intercept(t,async (url,init)=>{
    calls.push(new URL(url).pathname);
    if (init.method==='GET') return Response.json({data:[{id:'owner/model'}]});
    assert.equal(JSON.parse(init.body).model,'owner/model');
    speeds.push(JSON.parse(init.body).speed);
    return Response.json({audioBase64:'SUQzBA==',mimeType:'audio/mpeg'});
  });
  const env={VOICE_ALLOWED_ORIGINS:'https://tts.example'};
  const primary=slot('openai_compatible','custom_voice','https://tts.example/v1');
  const routing={version:2,mode:'single',primary};
  const catalog=await (await tts({action:'catalog',routing},{env})).json();
  assert.deepEqual(catalog.models,[{id:'owner/model'}]);
  primary.model=catalog.models[0].id;
  primary.speed=1.1;
  assert.equal((await lines(await tts({text:'Xin chào.',stream:true,routing},{env})))[0].speed,1.1);
  primary.native_speed=true;
  const records=await lines(await tts({text:'Xin chào.',stream:true,routing},{env}));
  assert.equal(records[0].model,'owner/model');
  assert.equal(records[0].type,'segment');
  assert.equal(records[0].speed,1);
  assert.deepEqual(calls,['/v1/models','/v1/audio/speech','/v1/audio/speech']);
  assert.deepEqual(speeds,[undefined,1.1]);
});
