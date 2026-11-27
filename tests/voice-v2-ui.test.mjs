import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script=readFileSync('static/voice/voice-player.js','utf8');
const vi={type:'segment',index:0,lang:'vi',boundary:'start',speed:1,audioBase64:'SUQzBA==',mimeType:'audio/mpeg'};
const ja={...vi,index:1,lang:'ja',boundary:'sentence',speed:0.9};
const done={type:'done',count:2};
function response(...rows) {
  const data=rows.map(row=>JSON.stringify(row)+'\n').join('');
  const parts=data.match(/.{1,13}|\n/gu);
  return new Response(new ReadableStream({start(controller){for (const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close();}}),
    {headers:{'Content-Type':'application/x-ndjson'}});
}
function browser(fetch, prepare=async value=>value) {
  const configuration={version:2,mode:'single',admin_override:false};
  const history=[], slots=new Map();
  const context=vm.createContext({TextDecoder,AbortController,Response,
    apiFetch:async (_path,options)=>{history.push(['request',JSON.parse(options.body)]);return fetch(options);},
    speechStatus:message=>history.push(['status',message]), mascotMgr:{setState(){}},
    window:{addEventListener(){},VJVoiceRouting:{stored:()=>configuration,identity:()=> 'account-routing-revision',prepared:prepare},
      VJVoiceStitcher:{create:()=>({append:async part=>{history.push(['audio',part.lang]);},finish:async()=>{},stop(){}})},
      VJVoiceCache:{key:async (identity,text,ref)=>JSON.stringify([identity,text,ref]),get:async key=>slots.get(key),
        put:async (key,parts,persist)=>{history.push(['cache',persist]);slots.set(key,parts);},clearMemory:()=>slots.clear()}},
    taskReference:async task=>({id:task.id,revision:task.revision})});
  context.stopSpeech=()=>context.window.VJVoice.stop();
  vm.runInContext(script,context);
  return {voice:context.window.VJVoice,history};
}

test('fragmented NDJSON plays in order, even on replay, without a second API call or a private disk entry',async()=>{
  const {voice,history}=browser(()=>response(vi,ja,done));
  const options={lesson:{id:'lesson',level:'N5'},focus:{kind:'question',index:0},task:{id:'test',revision:'current'},privateAudio:true};
  await voice.speak('Xin chào. こんにちは。',options);
  await voice.speak('Xin chào. こんにちは。',options);
  assert.equal(history.filter(([event])=>event==='request').length,1);
  assert.deepEqual(history.filter(([event])=>event==='audio').map(([,lang])=>lang),['vi','ja','vi','ja']);
  assert.deepEqual(history.find(([event])=>event==='request')[1].task,options.task);
  assert.deepEqual(history.filter(([event])=>event==='cache'),[['cache',false]]);
});

test('cache separates bilingual and Japanese-only readings of the same text',async()=>{
  const {voice,history}=browser(()=>response({...ja,index:0,boundary:'start'},{type:'done',count:1}));
  const text='DVDを見ます。';
  await voice.speak(text);
  await voice.speak(text,{mode:'ja',reading:'みます'});
  await voice.speak(text,{mode:'ja',reading:'みる'});
  await voice.speak(text,{mode:'ja',reading:'みます'});
  assert.deepEqual(history.filter(([event])=>event==='request').map(([,request])=>[request.mode,request.reading]),[
    ['bilingual',undefined],['ja','みます'],['ja','みる']]);
});

test('partial streams play only available segments, signal failure and do not poison replay',async()=>{
  let count=0;
  const {voice,history}=browser(()=>++count===1?response(vi):response(vi,ja,done));
  await voice.speak('Xin chào. こんにちは。');
  assert.equal(history.some(([event,message])=>event==='status' && message.includes('chưa tải xong')),true);
  assert.equal(history.some(([event])=>event==='cache'),false);
  await voice.speak('Xin chào. こんにちは。');
  assert.equal(count,2);
  assert.deepEqual(history.filter(([event])=>event==='audio').map(([,lang])=>lang),['vi','vi','ja']);
});

test('a long stream replays all parts only after a fresh profile check',async()=>{
  const records=Array.from({length:16},(_,index)=>({...vi,index,lang:index%2?'ja':'vi'}));
  const preparations=[];
  let revoked=false;
  const {voice,history}=browser(()=>response(...records,{type:'done',count:16}),async (config,_signal,{replay})=>{
    preparations.push(replay);
    if (revoked) throw new Error('Kết nối giọng nói đã bị xóa.');
    return config;
  });
  await voice.speak('A bilingual explanation');
  await voice.speak('A bilingual explanation');
  revoked=true;
  await voice.speak('A bilingual explanation');
  assert.deepEqual(preparations,[false,true,true]);
  assert.equal(history.filter(([event])=>event==='request').length,1);
  assert.deepEqual(history.filter(([event])=>event==='audio').map(([,lang])=>lang),[...records,...records].map(row=>row.lang));
  assert.match(history.at(-1)[1],/đã bị xóa/);
});

function settingsFixture(apiFetch,profileReads=[],storage=new Map(),withLive=false) {
  const nodes = new Map();
  function node(tag) {
    return {tag, value:'', children:[], events:{},
      set id(id) {nodes.set(id,id.startsWith('voice-v2-') ? this : undefined);},
      append(...children) {for (const child of children) child.parentElement=this; this.children.push(...children);},
      replaceChildren(...children) {this.children=[];this.append(...children);},
      setAttribute(){}, addEventListener(event,handler){this.events[event]=handler;}};
  }
  const el=id=>nodes.get('voice-v2-'+id);
  for (const id of ['source','mode','slots','status','kind','url','storage','personal','account','remove','routing','preview','settings','key','confirm-title','confirm-description'])
    node('fixture').id='voice-v2-'+id;
  if (withLive) {
    for (const id of ['engine','turn','stt','stt-slot']) node('select').id='voice-v2-live-'+id;
    node('input').id='voice-v2-live-barge';
    node('label').id='voice-v2-live-stt-slot-field';
    node('div').id='voice-v2-live-options';
  }
  const dialog=Object.assign(node('dialog'),{open:false,returnValue:'',
    showModal(){this.open=true;},
    close(value=''){this.open=false;this.returnValue=value;const handler=this.events.close;delete this.events.close;handler?.();}});
  dialog.id='voice-v2-confirm-dialog';
  el('storage').options=[{},{}];
  const owner='learner', removed=[];
  const window = new EventTarget();
  window.removeVoiceProfile=async (...args)=>{removed.push(args);};
  const profiles = [
    {id:'a',scope:'local',name:'ElevenLabs',protocol:'elevenlabs',base_url:'https://api.elevenlabs.io',revision:'1'},
    {id:'b',scope:'local',name:'Gemini',protocol:'gemini',base_url:'https://generativelanguage.googleapis.com',revision:'1'},
    {id:'c',scope:'local',name:'Custom',protocol:'openai_compatible',base_url:'https://tts.example/v1',revision:'1'}
  ];
  const context = vm.createContext({window, signedInUser:{user_id:owner}, Event, CustomEvent, AbortController, AbortSignal, apiFetch,
    VJProfiles:{load:async (_owner,id)=>{profileReads.push('key');return {...profiles.find(profile=>profile.id===id),api_key:'synthetic-fixture-key'};},
      metadata:async (_owner,id)=>{profileReads.push('metadata');return profiles.find(profile=>profile.id===id);}},
    document:{getElementById:id=>nodes.get(id), createElement:node},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  vm.runInContext(readFileSync('static/voice/voice-settings.js','utf8'),context);
  const refresh=()=>window.renderVoiceProfiles(owner,profiles,false,undefined,true);
  refresh();
  function change(id,value) {el(id).value=value;el(id).events.change();}
  return {el,dialog,context,window,profiles,removed,refresh,change,
    saved:()=>JSON.parse(storage.get('vjbot_voice_routing_v2:'+owner)),
    prepare:options=>window.VJVoiceRouting.prepared(JSON.parse(storage.get('vjbot_voice_routing_v2:'+owner)),undefined,options),
    save:()=>el('routing').events.submit({preventDefault(){}}),
    catalog:()=>el('slots').children[0].children.find(child=>child.tag==='button').events.click()};
}

test('saved dual routing preserves single speed across reload without changing either dual speed',()=>{
  const storage=new Map();
  const first=settingsFixture(undefined,[],storage);
  first.change('primary-profile','local:b');
  first.el('primary-speed').value='0.8';
  first.save();
  first.change('mode','dual_same_api');
  first.el('ja-speed').value='1.1';
  first.el('vi-speed').value='0.9';
  first.save();
  const reloaded=settingsFixture(undefined,[],storage);
  reloaded.save();
  assert.deepEqual([reloaded.saved().ja.speed,reloaded.saved().vi.speed],[1.1,0.9]);
  reloaded.change('mode','single');
  reloaded.save();
  assert.equal(reloaded.saved().primary.speed,0.8);
});

test('switches only the affected voice overrides and uses valid speeds for blank inputs',()=>{
  const {el,profiles,refresh,change,save,saved}=settingsFixture();
  change('mode','dual_same_api');change('primary-profile','local:a');
  el('ja-voice').value='old_ja';el('vi-voice').value='old_vi';
  change('primary-profile','local:b');
  el('ja-speed').value=el('vi-speed').value='';
  save();
  assert.deepEqual([saved().ja.speed,saved().vi.speed,saved().ja.voice_id,saved().vi.voice_id],[1,1,undefined,undefined]);
  change('mode','dual_split_api');change('ja-profile','local:a');
  el('ja-voice').value='keep_ja';el('vi-voice').value='old_gemini';
  profiles[1]={...profiles[1],protocol:'openai',base_url:'https://api.openai.com/v1',revision:'2'};
  refresh();
  save();
  assert.deepEqual([saved().primary.provider,saved().ja.voice_id,saved().vi.voice_id],['openai','keep_ja',undefined]);
});

test('hiding split settings in single-voice mode preserves the draft for both languages',()=>{
  const {el,change,save,saved}=settingsFixture();
  change('primary-profile','local:b');
  change('mode','dual_split_api');
  change('ja-profile','local:a');change('vi-profile','local:a');
  el('ja-voice').value='ja_clone';el('vi-voice').value='vi_clone';
  change('mode','single');change('mode','dual_split_api');
  save();
  assert.deepEqual([saved().ja.voice_id,saved().vi.voice_id],['ja_clone','vi_clone']);
});

test('catalog keeps paging after model selection but starts fresh after a profile switch',async()=>{
  const cursors=[];
  const {el,change,catalog}=settingsFixture(async (_path,request)=>{
    const {cursor}=JSON.parse(request.body);cursors.push(cursor);
    return Response.json({models:[{id:'model'}],voices:[{id:cursor?'second':'first',name:'Voice'}],next_cursor:cursor?null:'next'});
  });
  change('primary-profile','local:a');
  await catalog();
  el('primary-model').value='model';
  await catalog();
  change('primary-profile','local:b');change('primary-profile','local:a');
  await catalog();
  assert.deepEqual(cursors,[undefined,'next',undefined]);
  assert.deepEqual(el('voices-primary').children.map(option=>option.value),['first']);
});

test('custom speed is opt-in and cannot follow a selected endpoint change',()=>{
  const {el,change,save,saved,profiles,refresh}=settingsFixture();
  change('primary-profile','local:c');
  el('primary-model').value='custom_model';
  el('primary-voice').value='custom_voice';
  save();
  assert.equal(saved().primary.native_speed,undefined);
  assert.equal(saved().primary.speed,undefined);
  el('primary-speed').value='0.8';
  el('primary-native-speed').checked=true;
  save();
  assert.equal(saved().primary.native_speed,true);
  assert.equal(saved().primary.speed,0.8);
  change('mode','dual_same_api');
  save();
  assert.equal(saved().primary.speed,0.8);
  assert.equal(saved().ja.speed,1);
  change('mode','single');
  save();
  assert.equal(saved().primary.speed,0.8);
  profiles[2]={...profiles[2],base_url:'https://second-tts.example/v1',revision:'2'};
  refresh();
  el('primary-model').value='new_model';
  el('primary-voice').value='new_voice';
  save();
  assert.equal(saved().primary.native_speed,undefined);
});

test('prepared replay reads local metadata but not the key, and rejects a rotated profile',async()=>{
  const reads=[];
  const {change,save,prepare,profiles}=settingsFixture(undefined,reads);
  change('primary-profile','local:b');
  save();
  const replay=await prepare({replay:true});
  assert.deepEqual(reads,['metadata']);
  assert.equal(replay.primary.profile.connection,undefined);
  const synthesis=await prepare();
  assert.equal(synthesis.primary.profile.connection.api_key,'synthetic-fixture-key');
  profiles[1]={...profiles[1],revision:'2'};
  await assert.rejects(prepare({replay:true}),/đã đổi/);
  assert.deepEqual(reads,['metadata','key','metadata']);
});

test('legacy live defaults are immutable; settings change live identity but preserve audio identity',()=>{
  const storage=new Map();
  const key='vjbot_voice_routing_v2:learner';
  storage.set(key,JSON.stringify({version:2,mode:'single',admin_override:false,
    primary:{provider:'gemini',profile:{scope:'local',id:'b'},kanji_mode:'kanji_native'}}));
  const {window,el,change,save,saved}=settingsFixture(undefined,[],storage,true);
  const routing=window.VJVoiceRouting, before=routing.identity(saved()), events=[];
  const liveBefore=routing.liveIdentity(saved());
  const defaults={engine:'cascaded',turn_mode:'vad',barge_in:true,stt_source:'chat',stt_slot:'primary'};
  assert.ok(Object.isFrozen(routing));
  assert.ok(Object.isFrozen(routing.liveConfig(saved())));
  assert.deepEqual({...routing.liveConfig(saved())},defaults);
  assert.deepEqual({...routing.liveConfig({live:{engine:'unknown',turn_mode:1,barge_in:'false',stt_source:'unknown',stt_slot:'xx'}})},defaults);
  assert.equal(el('live-stt-slot-field').hidden,true);
  assert.equal(el('live-stt-slot').disabled,true);
  window.addEventListener('vjbot-voice-changed',event=>events.push(event.detail));
  change('live-stt','voice');
  assert.equal(el('live-stt-slot-field').hidden,false);
  assert.equal(el('live-stt-slot').disabled,false);
  assert.equal(el('live-options').hidden,false);
  el('live-turn').value='ptt';
  el('live-barge').checked=false;
  el('live-stt-slot').value='ja';
  change('live-engine','native');
  assert.equal(el('live-options').hidden,true);
  assert.ok(['turn','barge','stt','stt-slot'].every(name=>el('live-'+name).disabled));
  save();
  const edited={engine:'native',turn_mode:'ptt',barge_in:false,stt_source:'voice',stt_slot:'ja'};
  assert.deepEqual(saved().live,edited);
  assert.equal(routing.identity(saved()),before);
  assert.notEqual(routing.liveIdentity(saved()),liveBefore);
  assert.deepEqual({...events[0].live},edited);
  const again=settingsFixture(undefined,[],storage,true);
  assert.equal(again.el('live-engine').value,'native');
  assert.equal(again.el('live-turn').value,'ptt');
  assert.equal(again.el('live-barge').checked,false);
  assert.equal(again.el('live-stt-slot').value,'ja');
  again.change('live-engine','cascaded');
  assert.equal(again.el('live-options').hidden,false);
  assert.ok(['turn','barge','stt','stt-slot'].every(name=>!again.el('live-'+name).disabled));
  assert.equal(again.el('live-stt-slot').value,'ja');
});

test('saving cascaded voice STT rejects an unsupported split slot without replacing the saved route',()=>{
  const {el,window,profiles,refresh,change,save,saved}=settingsFixture(undefined,[],new Map(),true);
  profiles.push({id:'o',scope:'local',name:'OpenAI',protocol:'openai',base_url:'https://api.openai.com/v1',revision:'1'});
  refresh();
  change('mode','dual_split_api');
  change('primary-profile','local:o');
  change('ja-profile','local:b');
  save();
  const prior=saved();
  let changes=0;
  window.addEventListener('vjbot-voice-changed',()=>{changes++;});
  change('live-stt','voice');
  el('live-stt-slot').value='ja';
  save();
  assert.deepEqual(saved(),prior);
  assert.equal(changes,0);
  assert.match(el('status').textContent,/OpenAI.*Mistral.*ElevenLabs/);
  change('ja-profile','');
  save();
  assert.equal(saved().live.stt_source,'voice');
  assert.equal(saved().live.stt_slot,'ja');
  assert.equal(changes,1);
});

test('explicit STT prepares only the selected effective slot, uses the v2 wire schema and never substitutes an unsupported slot',async()=>{
  const reads=[], requests=[];
  const {window,profiles,refresh}=settingsFixture(async(path,options)=>{
    requests.push({path,options});
    return Response.json({profiles:profiles.filter(row=>row.scope==='server')});
  },reads);
  profiles.push({id:'m',scope:'server',name:'Mistral',protocol:'openai',
    base_url:'https://api.mistral.ai/v1',connection_id:'mistral-confirmed'});
  refresh();
  const routing=window.VJVoiceRouting, primary={provider:'elevenlabs',profile:{scope:'local',id:'a'},voice_id:'reader'};
  const draft={version:2,mode:'dual_split_api',admin_override:false,primary,
    ja:{provider:'mistral',profile:{scope:'server',id:'m'}},vi:{provider:'gemini',profile:{scope:'local',id:'b'}},
    live:{stt_source:'voice',stt_slot:'ja'}};
  const plain=value=>JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(await routing.preparedStt(draft)),{version:2,admin_override:false,provider:'mistral',profile:{scope:'server',id:'m'}});
  assert.deepEqual(reads,[]);
  assert.deepEqual(requests.map(({path})=>path),['/api/ai/profiles']);
  assert.deepEqual(plain(await routing.preparedStt({...draft,ja:{profile:null}})),{
    version:2,admin_override:false,provider:'elevenlabs',profile:{scope:'local',connection:{
      base_url:'https://api.elevenlabs.io',api_key:'synthetic-fixture-key'}}});
  assert.deepEqual(reads,['key','metadata']);
  await assert.rejects(routing.preparedStt({...draft,live:{stt_source:'voice',stt_slot:'vi'}}),/OpenAI.*Mistral.*ElevenLabs/);
  assert.equal(await routing.preparedStt({...draft,live:{stt_source:'browser'}}),null);
  assert.equal(await routing.preparedStt({...draft,live:undefined}),null);
  assert.deepEqual(reads,['key','metadata']);
  assert.equal(requests.length,1);
  await assert.rejects(routing.preparedStt({...draft,ja:{provider:'mistral',profile:{scope:'server',id:'removed'}}}),/đã đổi/);
  assert.equal(requests.length,1);
  const identity=routing.identity({...draft,primary:{...primary,profile:{...primary.profile,connection:{api_key:'synthetic-private'}}}});
  assert.doesNotMatch(identity,/synthetic-private/);
  profiles[0].key_last4='private-tail';
  assert.doesNotMatch(routing.identity(draft),/private-tail/);
});

test('explicit STT rejects in-flight profile, configuration, role and abort revocation',async()=>{
  for(const revoke of ['profile','metadata','config','role','abort']){
    const {el,window,context,profiles,refresh,change,save,saved}=settingsFixture(undefined,[],new Map(),true);
    change('primary-profile','local:a');
    el('primary-voice').value='reader';
    change('live-stt','voice');
    save();
    const controller=new AbortController(), load=context.VJProfiles.load;
    let release;
    context.VJProfiles.load=async(...args)=>{
      const prior=load(...args);
      return new Promise(resolve=>{release=()=>resolve(prior);});
    };
    const pending=window.VJVoiceRouting.preparedStt(saved(),controller.signal);
    if(revoke==='profile') {
      profiles[0]={...profiles[0],revision:'rotated'};
      refresh();
    } else if(revoke==='metadata') {
      profiles[0]={...profiles[0],revision:'rotated-without-refresh'};
    } else if(revoke==='config') {
      el('live-turn').value='ptt';
      save();
    } else if(revoke==='role') {
      context.signedInUser.is_admin=true;
    } else controller.abort();
    release();
    await assert.rejects(pending,/đã đổi|abort/i);
  }
});

test('administrator STT requires an explicit personal override and the current server fingerprint',async()=>{
  let currentId='initial-connection';
  const {context,window,profiles,refresh}=settingsFixture(async()=>Response.json({profiles:[
    {id:'s',protocol:'openai',base_url:'https://api.openai.com/v1',connection_id:currentId}
  ]}));
  context.signedInUser.is_admin=true;
  profiles.push({id:'s',scope:'server',name:'OpenAI',protocol:'openai',
    base_url:'https://api.openai.com/v1',connection_id:currentId});
  refresh();
  const config={version:2,mode:'single',admin_override:true,live:{stt_source:'voice'},
    primary:{provider:'openai',profile:{scope:'server',id:'s'}}};
  assert.equal((await window.VJVoiceRouting.preparedStt(config)).admin_override,true);
  await assert.rejects(window.VJVoiceRouting.preparedStt({...config,admin_override:false}),/Quyền tài khoản/);
  currentId='rotated-connection';
  await assert.rejects(window.VJVoiceRouting.preparedStt(config),/đã đổi/);
});

test('removing a voice profile uses the native dialog and cancels on dismiss or account switch',async()=>{
  const {el,dialog,context,window,removed,change}=settingsFixture();
  change('primary-profile','local:a');
  const first=el('remove').events.click();
  assert.equal(dialog.open,true);
  assert.match(el('confirm-title').textContent,/ElevenLabs/);
  dialog.close('cancel');
  await first;
  assert.deepEqual(removed,[]);
  const confirmed=el('remove').events.click();
  assert.equal(dialog.open,true);
  dialog.close('delete');
  await confirmed;
  assert.deepEqual(removed,[['learner','local','a']]);
  assert.match(el('status').textContent,/Đã xóa kết nối giọng nói/);
  const backed=el('remove').events.click();
  assert.equal(dialog.open,true);
  window.dispatchEvent(new Event('popstate'));
  await backed;
  assert.equal(dialog.open,false);
  const hashed=el('remove').events.click();
  assert.equal(dialog.open,true);
  window.dispatchEvent(new Event('hashchange'));
  await hashed;
  assert.equal(dialog.open,false);
  const switched=el('remove').events.click();
  assert.equal(dialog.open,true);
  context.signedInUser={user_id:'other-learner'};
  window.dispatchEvent(new Event('vjbot-account-ready'));
  await switched;
  assert.equal(dialog.open,false);
  assert.equal(removed.length,1);
});
