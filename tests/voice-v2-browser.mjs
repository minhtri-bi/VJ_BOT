import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const executable = process.env.BROWSER;
assert.ok(executable, 'Set BROWSER to a Chromium browser executable.');
const assets = ['/speech.js','/voice/audio-cache.js','/voice/audio-stitcher.js','/voice/voice-player.js'];
const liveAssets = ['/classroom-vfx.css','/live-transcript.js','/voice/vad-worklet.js','/voice/live-cascaded.js','/live.js'];
const scripts = new Map(await Promise.all([...assets,...liveAssets].map(async path => [path, await readFile(`static${path}`)])));
const html = `<!doctype html><meta charset="utf-8"><div id="speech-notice" hidden><span id="speech-status"></span><button id="speech-stop"></button></div>
${assets.map(path => `<script src="${path}"></script>`).join('')}
<script>
const config = {admin_override:false};
window.VJVoiceRouting = {stored:()=>config, identity:()=> 'fixture', prepared:async value=>value};
const apiFetch = (path, init) => fetch(path, init);
window.Audio = class {constructor(){throw new Error('Detached media metadata is unavailable in this fixture');}};
let mp3Playback=false;
const states = [];
const mascotMgr = {setState:value=>states.push(value)};
const createSource = AudioContext.prototype.createBufferSource;
AudioContext.prototype.createBufferSource = function () {
  const source = createSource.call(this);
  const start=source.start;
  let scheduled;
  source.start=(...args)=>{scheduled=args;return start.apply(source,args);};
  source.addEventListener('ended',()=>{
    const [when,offset,duration]=scheduled || [];
    const rate=source.playbackRate.value, length=source.buffer.duration;
    const samples=source.buffer.getChannelData(0), sampleRate=source.buffer.sampleRate;
    const audible=value=>Math.abs(value)>=10**(-42/20);
    const first=samples.findIndex(audible), last=samples.findLastIndex(audible);
    const expectedStart=Math.max(0,first/sampleRate-0.015);
    const expectedEnd=Math.min(length,(last+1)/sampleRate+0.025);
    if (first<0 || ![when,offset,duration].every(Number.isFinite)
      || Math.abs(offset-expectedStart)>0.002 || Math.abs(offset+duration-expectedEnd)>0.002
      || this.currentTime+0.008<when+duration/rate) {
      states.push('clipped:'+offset+'+'+duration);
      return;
    }
    if (mp3Playback) {states.push('mp3:'+rate.toFixed(1));return;}
    let rising=0;
    for (let i=first;i<=last;i++) if (i>0 && samples[i-1]<=0 && samples[i]>0) rising++;
    const frequency=Math.round(rising*sampleRate/(last-first+1));
    states.push('ended:'+frequency+'@'+rate.toFixed(1));
  },{once:true});
  return source;
};
(async()=>{
  let error = '';
  try {
    const replay=location.search==='?replay';
    const japanese='DVDを見ます。';
    const existingBilingual='Xin chào. おはよう。';
    if (!replay) {
      const prior=await fetch('/prior-cache').then(response=>response.json());
      for (const [mode,text] of [['ja',japanese],['bilingual',existingBilingual]]) {
        const parts=['fixture',text,{mode}];
        if (mode==='ja') parts.push('ja-synthesis-2');
        const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts)));
        const oldKey=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
        await VJVoiceCache.put(oldKey,prior[mode],true);
        VJVoiceCache.clearMemory();
        if (!(await VJVoiceCache.get(oldKey,true))) throw new Error(mode+': prior disk fixture was not seeded');
      }
      VJVoiceCache.clearMemory();
    }
    for (const [mode,text,order] of [
      ['bilingual','Chào em. こんにちは。','ended:660@1.0,ended:440@1.0,idle'],
      ['bilingual',existingBilingual,'ended:550@1.0,ended:880@1.0,idle'],
      ['ja',japanese,'ended:770@1.0,idle'],
      ['bilingual','Đọc qua MP3.','mp3:1.0,idle']
    ]) {
      mp3Playback=text==='Đọc qua MP3.';
      await VJVoice.speak(text,{mode,cacheAudio:true});
      const status=document.getElementById('speech-status').textContent;
      const events=states.splice(0).filter(state=>state!=='speaking');
      if (status || events.join(',')!==order) throw new Error(mode+': '+(status || 'Playback stopped or played stale audio: '+events));
    }
    if (!replay) {location.search='?replay';return;}
    location.href='/?live#classroom';return;
  } catch (failure) {error=failure.message;}
  await fetch('/result',{method:'POST',body:error});
})();
</script>`;
const liveMarkup = (await readFile('static/index.html','utf8')).match(/<section id="classroom-voice"[\s\S]*?<\/section>/)?.[0];
assert.ok(liveMarkup,'Expected the real Classroom voice controls.');
const liveHtml = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/classroom-vfx.css">
<div id="speech-notice" hidden><span id="speech-status"></span><button id="speech-stop"></button></div>
<main id="panel-classroom"><div class="classroom-chat-window"><button data-chat-mode="live">Voice</button><div id="classroom-text"></div>${liveMarkup}</div></main>
${assets.map(path => `<script src="${path}"></script>`).join('')}
<script>
const signedInUser={user_id:'browser-fixture',is_admin:true};
const activeCurriculumLevel='N5';
let chatLessonContext=null,holdProbe=false,pendingProbe=false;
const routing={version:2,admin_override:true,mode:'single',primary:{provider:'mistral'}};
window.VJVoiceRouting={stored:()=>routing,liveIdentity:()=> 'fixture',liveConfig:()=>({engine:'cascaded',turn_mode:'ptt',barge_in:true,stt_source:'voice',stt_slot:'primary'}),
  prepared:async()=>routing,preparedStt:async()=>({version:2,admin_override:true,provider:'mistral',profile:{scope:'server',id:'fixture'}})};
const apiFetch=(path,init)=>{
  if(holdProbe && path==='/api/stt')pendingProbe=true;
  return fetch(path,init);
};
let microphone;
const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia=async constraints=>(microphone=await getUserMedia(constraints));
const output=[];
const createBufferSource=AudioContext.prototype.createBufferSource;
AudioContext.prototype.createBufferSource=function(){
  const source=createBufferSource.call(this),start=source.start,stop=source.stop;
  let item;
  source.start=(when,offset,duration)=>{
    const pcm=source.buffer.getChannelData(0);
    let crossings=0,first=-1,last=-1;
    for(let i=1;i<pcm.length;i++)if(pcm[i]>0.025 && pcm[i-1]<=0.025){
      if(first<0)first=i;
      last=i;crossings++;
    }
    item={frequency:Math.round((crossings-1)*source.buffer.sampleRate/(last-first)/10)*10,context:this,when,
      until:when+duration/source.playbackRate.value,stopped:false,ended:false};
    output.push(item);return start.call(source,when,offset,duration);
  };
  source.stop=(...args)=>{item.stopped=true;return stop.apply(source,args);};
  source.addEventListener('ended',()=>{item.ended=true;},{once:true});
  return source;
};
</script>
<script src="/live-transcript.js"></script><script src="/voice/live-cascaded.js"></script><script src="/live.js"></script>
<script>
const click=id=>document.getElementById(id).click();
const must=(value,message)=>{if(!value)throw new Error(message);};
const wait=async predicate=>{
  const deadline=performance.now()+5000;
  while(!predicate()){
    if(performance.now()>deadline)throw new Error('Live state timed out: '+document.getElementById('live-status').textContent);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
};
(async()=>{
  let error='';
  try{
    document.querySelector('[data-chat-mode="live"]').click();
    const talk=document.getElementById('live-talk'),mode=document.getElementById('live-turn-mode');
    click('live-start');
    await wait(()=>output.length===3 && output.every(item=>item.ended));
    const context=output[0].context;
    const openingOrder=output.map(item=>item.frequency).join(',');
    must(openingOrder==='440,550,660' && output.every(item=>item.context===context),'Out-of-order batches or multiple AudioContexts: '+openingOrder);
    must(output[1].when>=output[0].until && output[2].when>=output[1].until,'Audio intervals overlap or are scheduled out of order');
    must(!talk.hidden && mode.value==='ptt' && talk.getBoundingClientRect().height>=44,'Push-to-talk is not available as a touch control');
    must(document.querySelector('.live-turn.assistant')?.textContent.includes('最初'), 'Opening caption did not reach the actual timeline');
    await wait(()=>document.getElementById('live-stage').dataset.turn==='you');
    must(document.querySelectorAll('#live-commands button:not([disabled])').length===7,'A quick command is unavailable');
    document.querySelector('[data-command="repeat"]').click();
    await wait(()=>output.length===6 && output.slice(3).every(item=>item.ended));
    must(output.slice(3).map(item=>item.frequency).join(',')==='440,550,660','Replay did not preserve audio order');
    await wait(()=>document.getElementById('live-stage').dataset.turn==='you');
    document.querySelector('[data-command="hint"]').click();
    await wait(()=>output.length===7 && document.getElementById('live-stage').dataset.turn==='teacher');
    await wait(()=>context.currentTime>output[6].when+0.025);
    must(context.currentTime<output[6].until,'The hint already ended before the interruption test');
    click('live-talk');
    must(output[6].stopped && context.state==='running' && talk.getAttribute('aria-pressed')==='true','Barge-in did not stop playback while keeping the shared context unlocked');
    await new Promise(resolve=>setTimeout(resolve,520));
    click('live-talk');
    await wait(()=>output.length===8 && output[7].ended);
    must(output[7].frequency===770 && output[7].context===context,'The next turn did not play in the original context');
    must(document.querySelector('.live-turn.user')?.textContent.includes('昨日映画を見ました。'),'The microphone transcript did not reach Classroom');
    click('live-mute');
    must(microphone.getAudioTracks().every(track=>!track.enabled) && talk.disabled,'Mute did not disable microphone capture or push-to-talk');
    mode.value='vad';mode.dispatchEvent(new Event('change'));
    must(talk.hidden,'Switching to automatic listening left push-to-talk visible');
    click('live-end');
    await wait(()=>context.state==='closed' && talk.hidden && mode.hidden);
    must(!document.getElementById('live-start').disabled,'End did not restore the Start control');
    must(microphone.getTracks().every(track=>track.readyState==='ended'),'End left a microphone track running');
    must(document.getElementById('live-privacy').textContent.includes('gửi câu trả lời đến Mistral'),'Idle disclosure reverted to the native engine');
    holdProbe=true;
    click('live-start');
    await wait(()=>pendingProbe);
    chatLessonContext={id:'fixture:other-lesson',level:'N5'};
    await wait(()=>microphone.getTracks().every(track=>track.readyState==='ended') && !document.getElementById('live-start').disabled);
    must(/đã thay đổi/.test(document.getElementById('live-status').textContent),'A pending setup survived a lesson change');
  }catch(failure){error=failure.message;}
  await fetch('/result',{method:'POST',body:error});
})();
</script>`;

function tone(frequency) {
  const pcm = Buffer.alloc(4800);
  for (let i=0;i<pcm.length/2;i++) pcm.writeInt16LE(Math.round(7000*Math.sin(2*Math.PI*frequency*i/24000)),i*2);
  return pcm;
}
function wavTone(frequency) {
  const wav=Buffer.concat([Buffer.from('524946460000000057415645666d74201000000001000100c05d000080bb0000020010006461746100000000','hex'),tone(frequency)]);
  wav.writeUInt32LE(wav.length-8,4);
  wav.writeUInt32LE(wav.length-44,40);
  return wav.toString('base64');
}
const rows = [
  {type:'segment',index:0,lang:'vi',boundary:'start',speed:1,mimeType:'audio/wav',audioBase64:wavTone(660)},
  {type:'segment',index:1,lang:'ja',boundary:'sentence',speed:1,mimeType:'audio/L16;rate=24000',audioBase64:tone(440).toString('base64')},
  {type:'done',count:2}
];
const alternate = [{...rows[0],audioBase64:wavTone(550)},{...rows[1],audioBase64:tone(880).toString('base64')},rows[2]];
const prior = {
  ja:[{...rows[0],lang:'ja',speed:1.2,audioBase64:wavTone(990)}],
  bilingual:rows.slice(0,-1).map(row=>({...row,speed:1.2}))
};
const padded = Buffer.concat([Buffer.alloc(2880),tone(770),Buffer.alloc(2880)]);
const japanese = [{...rows[1],index:0,boundary:'start',audioBase64:padded.toString('base64')},{type:'done',count:1}];
// Synthetic 660 Hz tone encoded with LAME, without a Xing/Info seek header.
const mp3 = [{...rows[0],mimeType:'audio/mpeg',
  audioBase64:'//NAxAAPQIaYB1gQAG4A5bluW5bluW/7/xt/HIYYuxiDuSlKsxlOkjgwzAQUZY/kYjFILDgYGBgYPvEAIAh//////8v7un/+GOlMQU1FAwAJCAAEAAAAAAAAAAAAAAAAAAAAAAAAAAD/80LEABbRayJfm6kC4HA4HA4HA4HA4HAAAALzGAgX//mFjAEC///MOOTmGP7n5AbgL4GHASBgYEvvhyQXPBgL8Y0UCKBId/jnDLEyRUgP/mRFiLGJdLpl//l4vIomKgab/lQkDQlOh0D/80DEABUYeigL33gAFD///6wpccFNSIACwwE0ACAgCcYByBrmCvARpgCYSeYcAmEHlnI35lGIvkY22DvGCNgSBgWAJKYHIBCmApADZgDYCEYBiAEPmvhDSanv////R//9KYgpqKAAAP/zQsQAE2h+JArn9oQsP///shViLWmAgiDRMIiGOm4QL0wzaDAoA5cw5dsQORZYnzBchCsx2cKSMIoBIzBEwJw5pdNdNDNBkxkARgU6XK71n///Uz//1f4302piCmooGABIQAAgAAAAAP/zQMQAEyh+JADn9IT///mFphYAKZloDE4lMoEw0OgTajOOw1swqwLCMgpPQT93UBQx8ICVMIuC2DANQS0EASw5RFVhAXIAyGbB2oSfn///////////9f/dQmIKaigYAEhAACAAAAAA//NCxAAS4Ho5nt+0hAgAIAssAA///XIWs0vkhkOBJANCMzCi8Fb8wDR7jFO6nP3jW4qkNGfAJOYioPRhAAenDOGiFgY0X5c+C4apX0///hf96f+L7/sv3LTEFNRQMACQgABAAAAAAAAA//NAxAAV4JasHmaSaQU5aACYhiWmEhKJaYRC8BwhsvbAmAg2YcufZ6EDFls3dAGAuPkBggcjegxHqmiA4ieWIliJdplpllpnBAjwzwwzwz3ret7knkmnte1jzDzDD3Pe5pzfO8TEFND/80LEABYIVsxeGkyDG+S3b8CNrtlCjVQzYpERg6WAlEiSokqFElyxxyiwp4ss0ss0swwaKGmmnGnEyRVhvFhthpKiSosscsccscosWWaUWKGiho0UNFHHGnEiRUkVJkm2EuLDbCYgpoA='},{type:'done',count:1}];
const profile = await mkdtemp(join(tmpdir(),'vjbot-voice-browser-'));
const {promise: completed, resolve: result} = Promise.withResolvers();
const requests = [], pages = [];
const liveRequests = [], liveBatches = [];
let releaseFirstBatch;
const replyEvents = segments => [
  ...segments.map(([lang,text],index)=>['segment',{index,lang,text,boundary:index?'sentence':'start'}]),
  ['done',{count:segments.length,full_text:segments.map(([,text])=>text).join(' '),japanese_only:false}]
].map(([name,item])=>`event: ${name}\ndata: ${JSON.stringify(item)}\n\n`).join('');
const opener = [['ja','最初です。'],['vi','Chào em.'],['ja','続けましょう。']];
const server = createServer(async (req,res)=>{
  if (req.url==='/' || req.url==='/?replay') {
    pages.push(req.url);
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html);
  }
  if (req.url==='/?live') {
    pages.push(req.url);
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(liveHtml);
  }
  if (scripts.has(req.url)) return res.writeHead(200,{'Content-Type':req.url.endsWith('.css')?'text/css':'application/javascript'}).end(scripts.get(req.url));
  if (req.url==='/prior-cache') {
    return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(prior));
  }
  if (['/api/live/turn','/api/stt','/api/tts'].includes(req.url) && req.method==='POST') {
    let body='';
    for await (const chunk of req) body+=chunk;
    const data=JSON.parse(body), {mode,text}=data;
    if(req.url==='/api/stt'){
      const capability=data.action==='capabilities';
      liveRequests.push(['stt',capability?'capabilities':'transcribe',data.stt_routing?.provider,data.stt_routing?.profile,capability || Boolean(data.audio?.length>512)]);
      if(capability && liveRequests.filter(([,action])=>action==='capabilities').length>1)return;
      return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(capability
        ? {supported:true,provider:'mistral',model:'voxtral-mini-transcribe-3'}:{text:'昨日映画を見ました。'}));
    }
    if(req.url==='/api/live/turn'){
      const {command,transcript}=data;
      liveRequests.push(['turn',command ?? transcript]);
      const utterance=command==='start'?opener:command==='hint'?[['ja','ゆっくり話しましょう。']]:[['ja','映画ですね。']];
      return res.writeHead(200,{'Content-Type':'text/event-stream'}).end(replyEvents(utterance));
    }
    const records = (pairs,long=false)=>[
      ...pairs.map(([lang,frequency],index)=>({...rows[1],lang,index,boundary:index?'sentence':'start',
        audioBase64:(long?Buffer.concat(Array.from({length:20},()=>tone(frequency))):tone(frequency)).toString('base64')})),
      {type:'done',count:pairs.length}];
    const send=segments=>res.writeHead(200,{'Content-Type':'application/x-ndjson'}).end(segments.map(row=>JSON.stringify(row)+'\n').join(''));
    if(text?.includes('最初です。')){
      liveRequests.push(['speak','opening-first']);
      releaseFirstBatch=()=>{liveBatches.push('first');send(records([['ja',440]]));};
      return;
    }
    if(text?.includes('続けましょう。')){
      liveRequests.push(['speak','opening-rest']);
      liveBatches.push('rest');send(records([['vi',550],['ja',660]]));
      if(releaseFirstBatch)releaseFirstBatch();
      return;
    }
    if(text?.includes('ゆっくり話しましょう。') || text?.includes('映画ですね。')){
      const hint=text.includes('ゆっくり話しましょう。');
      liveRequests.push(['speak',hint?'hint':'answer']);
      return send(records([['ja',hint?880:770]],hint));
    }
    requests.push([mode,text]);
    const segments=mode==='ja' ? japanese : text==='Đọc qua MP3.' ? mp3 : text==='Xin chào. おはよう。' ? alternate : rows;
    send(segments);
  } else if (req.url==='/result' && req.method==='POST') {
    let body='';
    for await (const chunk of req) body+=chunk;
    res.end();result(body);
  } else res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
// Keep Chromium's decoder and playback clock, without depending on a physical audio device.
const browser = spawn(executable,['--headless','--disable-gpu','--disable-audio-output','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--window-size=560,860',
  '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{stdio:['ignore','ignore','pipe']});
let diagnostics='',debuggerUrl;
browser.stderr.on('data',chunk=>{
  diagnostics=(diagnostics+chunk).slice(-2000);
  debuggerUrl??=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/.exec(diagnostics)?.[1];
});
const exit = once(browser,'exit');
async function exitWithin(ms) {
  let deadline;
  try{return await Promise.race([exit.then(()=>true,()=>false),new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),ms);})]);}
  finally{clearTimeout(deadline);}
}
async function closeChromium() {
  if(!debuggerUrl)return;
  const socket=new WebSocket(debuggerUrl);
  socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Browser.close'})),{once:true});
  try{await exitWithin(2500);}finally{socket.close();}
}
let timer;
let failure;
try {
  const error = await Promise.race([completed,
    exit.then(([code])=>{throw new Error(`Browser exited early (${code}): ${diagnostics}`);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Playback timed out (pages ${pages}; synthesis ${requests}): ${diagnostics}`)),25000);})]);
  assert.equal(error,'');
  assert.deepEqual(pages,['/','/?replay','/?live'],'Replay must survive navigation before the Live browser smoke');
  assert.deepEqual(requests,[['bilingual','Chào em. こんにちは。'],['bilingual','Xin chào. おはよう。'],
    ['ja','DVDを見ます。'],['bilingual','Đọc qua MP3.']],
    'Old synthesis revisions must miss once; every new recording must replay from disk after reload');
  console.log('Chromium played WAV, PCM with retained padding, and MP3 without metadata; refreshed stale recordings and replayed them from IndexedDB.');
  assert.deepEqual(liveBatches,['rest','first'],'The second HTTP response must finish before the first');
  const sttProfile={scope:'server',id:'fixture'};
  assert.deepEqual(liveRequests,[['stt','capabilities','mistral',sttProfile,true],['turn','start'],['speak','opening-first'],
    ['speak','opening-rest'],['turn','hint'],['speak','hint'],['stt','transcribe','mistral',sttProfile,true],['turn','昨日映画を見ました。'],
    ['speak','answer'],['stt','capabilities','mistral',sttProfile,true]],'STT must use the selected profile and replay must not call the network');
  console.log('Chromium Classroom ordered inverted TTS batches, replayed locally, interrupted playback and sent a real browser recording through the stubbed STT endpoint.');
} catch(error) {
  failure=error;
  throw error;
} finally {
  clearTimeout(timer);
  server.close();
  server.closeAllConnections();
  try {
    if(browser.pid && browser.exitCode===null && browser.signalCode===null)await closeChromium();
    if (browser.pid && browser.exitCode===null && browser.signalCode===null) {
      if (process.platform==='win32') {
        // Browser children can keep inherited pipe handles open even after taskkill exits.
        try {await promisify(execFile)('taskkill.exe',['/pid',String(browser.pid),'/t','/f'],{timeout:5000});}
        catch(error){
          let running=browser.exitCode===null && browser.signalCode===null;
          if(running)try{process.kill(browser.pid,0);}catch(check){if(check.code==='ESRCH')running=false;else throw check;}
          if(running && !browser.kill('SIGKILL'))throw error;
        }
        browser.stderr.destroy();browser.unref();
      } else {
        browser.kill('SIGKILL');
        if(!await exitWithin(4000))throw new Error('Browser did not exit after termination');
      }
    }
    await rm(profile,{recursive:true,force:true,maxRetries:12});
  } catch(error) {
    if(!failure)throw error;
    console.error(error);
  } finally {clearTimeout(timer);}
}
