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
const scripts = new Map(await Promise.all(assets.map(async path => [path, await readFile(`static${path}`)])));
const html = `<!doctype html><meta charset="utf-8"><div id="speech-notice" hidden><span id="speech-status"></span><button id="speech-stop"></button></div>
${assets.map(path => `<script src="${path}"></script>`).join('')}
<script>
const config = {admin_override:false};
window.VJVoiceRouting = {stored:()=>config, identity:()=> 'fixture', prepared:async value=>value};
const apiFetch = (path, init) => fetch(path, init);
const states = [];
const mascotMgr = {setState:value=>states.push(value)};
const createSource = AudioContext.prototype.createBufferSource;
AudioContext.prototype.createBufferSource = function () {
  const source = createSource.call(this);
  source.addEventListener('ended',()=>states.push('ended:'+source.playbackRate.value.toFixed(1)),{once:true});
  return source;
};
(async()=>{
  let error = '';
  try {
    const replay=location.search==='?replay';
    const japanese='DVDを見ます。';
    if (!replay) {
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['fixture',japanese,{mode:'ja'}])));
      const oldKey=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
      const stale=await fetch('/stale-audio').then(response=>response.json());
      await VJVoiceCache.put(oldKey,[stale],true);
      VJVoiceCache.clearMemory();
      if (!(await VJVoiceCache.get(oldKey,true))) throw new Error('Stale disk fixture was not seeded');
      VJVoiceCache.clearMemory();
    }
    for (const [mode,text,order] of [
      ['bilingual','Chào em. こんにちは。','ended:1.0,ended:0.9,idle'],
      ['ja',japanese,'ended:0.9,idle']
    ]) {
      await VJVoice.speak(text,{mode,cacheAudio:true});
      const status=document.getElementById('speech-status').textContent;
      const events=states.splice(0).filter(state=>state!=='speaking');
      if (status || events.join(',')!==order) throw new Error(mode+': '+(status || 'Playback stopped or played stale audio: '+events));
    }
    if (!replay) {location.search='?replay';return;}
  } catch (failure) {error=failure.message;}
  await fetch('/result',{method:'POST',body:error});
})();
</script>`;

function tone(frequency) {
  const pcm = Buffer.alloc(4800);
  for (let i=0;i<pcm.length/2;i++) pcm.writeInt16LE(Math.round(7000*Math.sin(2*Math.PI*frequency*i/24000)),i*2);
  return pcm;
}
const pcm = tone(440);
const wav = Buffer.concat([Buffer.from('524946460000000057415645666d74201000000001000100c05d000080bb0000020010006461746100000000','hex'),tone(660)]);
wav.writeUInt32LE(wav.length-8,4);
wav.writeUInt32LE(wav.length-44,40);
const rows = [
  {type:'segment',index:0,lang:'vi',boundary:'start',speed:1,mimeType:'audio/wav',audioBase64:wav.toString('base64')},
  {type:'segment',index:1,lang:'ja',boundary:'sentence',speed:0.9,mimeType:'audio/L16;rate=24000',audioBase64:pcm.toString('base64')},
  {type:'done',count:2}
];
const profile = await mkdtemp(join(tmpdir(),'vjbot-voice-browser-'));
const {promise: completed, resolve: result} = Promise.withResolvers();
const requests = [], pages = [];
const server = createServer(async (req,res)=>{
  if (req.url==='/' || req.url==='/?replay') {
    pages.push(req.url);
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html);
  }
  if (scripts.has(req.url)) return res.writeHead(200,{'Content-Type':'application/javascript'}).end(scripts.get(req.url));
  if (req.url==='/stale-audio') {
    return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...rows[0],lang:'ja',speed:1.2}));
  }
  if (req.url==='/api/tts' && req.method==='POST') {
    let body='';
    for await (const chunk of req) body+=chunk;
    const {mode}=JSON.parse(body);
    requests.push(mode);
    const segments=mode==='ja' ? [{...rows[1],index:0,boundary:'start'},{type:'done',count:1}] : rows;
    res.writeHead(200,{'Content-Type':'application/x-ndjson'}).end(segments.map(row=>JSON.stringify(row)+'\n').join(''));
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
  `--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{stdio:['ignore','ignore','pipe']});
let diagnostics = '';
browser.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-2000);});
const exit = once(browser,'exit');
let timer;
try {
  const error = await Promise.race([completed,
    exit.then(([code])=>{throw new Error(`Browser exited early (${code}): ${diagnostics}`);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Playback timed out (pages ${pages}; synthesis ${requests}): ${diagnostics}`)),25000);})]);
  assert.equal(error,'');
  assert.deepEqual(pages,['/','/?replay'],'Replay must survive navigation');
  assert.deepEqual(requests,['bilingual','ja'],'Stale Japanese audio must miss; reloaded audio must hit');
  console.log('Chromium decoded WAV and PCM in order, replaced stale Japanese audio, and replayed from IndexedDB after reload.');
} finally {
  clearTimeout(timer);
  server.close();
  if (browser.pid && browser.exitCode===null && browser.signalCode===null) {
    if (process.platform==='win32') {
      await promisify(execFile)('taskkill.exe',['/pid',String(browser.pid),'/t','/f'],{timeout:5000})
        .catch(error=>{if (error.code!==128) throw error;});
    } else browser.kill('SIGKILL');
    try {
      await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Browser did not exit after termination')),4000);})]);
    } finally {clearTimeout(timer);}
  }
  await rm(profile,{recursive:true,force:true,maxRetries:3});
}
