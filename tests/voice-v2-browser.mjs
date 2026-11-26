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
  } catch (failure) {error=failure.message;}
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
const server = createServer(async (req,res)=>{
  if (req.url==='/' || req.url==='/?replay') {
    pages.push(req.url);
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html);
  }
  if (scripts.has(req.url)) return res.writeHead(200,{'Content-Type':'application/javascript'}).end(scripts.get(req.url));
  if (req.url==='/prior-cache') {
    return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(prior));
  }
  if (req.url==='/api/tts' && req.method==='POST') {
    let body='';
    for await (const chunk of req) body+=chunk;
    const {mode,text}=JSON.parse(body);
    requests.push([mode,text]);
    const segments=mode==='ja' ? japanese : text==='Đọc qua MP3.' ? mp3 : text==='Xin chào. おはよう。' ? alternate : rows;
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
  assert.deepEqual(requests,[['bilingual','Chào em. こんにちは。'],['bilingual','Xin chào. おはよう。'],
    ['ja','DVDを見ます。'],['bilingual','Đọc qua MP3.']],
    'Old synthesis revisions must miss once; every new recording must replay from disk after reload');
  console.log('Chromium played WAV, PCM with retained padding, and MP3 without metadata; refreshed stale recordings and replayed them from IndexedDB.');
} finally {
  clearTimeout(timer);
  server.close();
  if (browser.pid && browser.exitCode===null && browser.signalCode===null) {
    let terminationError;
    if (process.platform==='win32') {
      await promisify(execFile)('taskkill.exe',['/pid',String(browser.pid),'/t','/f'],{timeout:5000})
        .catch(error=>{terminationError=error;});
    } else browser.kill('SIGKILL');
    try {
      await Promise.race([exit,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Browser did not exit after termination',{cause:terminationError})),4000);
      })]);
    } finally {clearTimeout(timer);}
  }
  await rm(profile,{recursive:true,force:true,maxRetries:3});
}
