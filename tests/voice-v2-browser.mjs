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
const appHtml = await readFile('static/index.html');
const assetTypes = {css:'text/css',js:'application/javascript',json:'application/json',
  svg:'image/svg+xml',png:'image/png',ico:'image/x-icon'};
const voiceProfile = {id:'fixture',name:'Mistral kiểm thử',protocol:'openai',
  base_url:'https://api.mistral.ai/v1',connection_id:'fixture-voice',purpose:'speech'};
const html = `<!doctype html><meta charset="utf-8"><div id="speech-notice" hidden><span id="speech-status"></span><button id="speech-stop"></button></div>
<button type="button" id="playback-check">Start playback check</button>
${assets.map(path => `<script src="${path}"></script>`).join('')}
<script>
const config = {admin_override:false};
window.VJVoiceRouting = {stored:()=>config, identity:()=> 'fixture', prepared:async value=>value, legacyCacheKey:async()=>null};
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
document.getElementById('playback-check').addEventListener('click',async event=>{
  if(!event.isTrusted)return;
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
},{once:true});
</script>`;
// Observe the real media objects without changing the app's account, navigation, or controls.
function observeLiveMedia(){
  const media=window.voiceSmoke={microphone:null,output:[],keyboardClicks:[],resumes:[]};
  const resume=AudioContext.prototype.resume;
  AudioContext.prototype.resume=function(){
    media.resumes.push({activation:navigator.userActivation.isActive,hasMicrophone:Boolean(media.microphone)});
    return resume.call(this);
  };
  const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>(media.microphone=await getUserMedia(constraints));
  document.addEventListener('click',event=>{
    if(event.isTrusted && event.detail===0)media.keyboardClicks.push(event.target.closest('button')?.id);
  },true);
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
      media.output.push(item);return start.call(source,when,offset,duration);
    };
    source.stop=(...args)=>{if(item)item.stopped=true;return stop.apply(source,args);};
    source.addEventListener('ended',()=>{if(item)item.ended=true;},{once:true});
    return source;
  };
}

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let testSocket;
async function runLiveBrowser(debuggerUrl,origin){
  const socket=testSocket=new WebSocket(debuggerUrl),pending=new Map(),consoleErrors=[];
  let sequence=0,sessionId;
  socket.addEventListener('message',({data})=>{
    const message=JSON.parse(data);
    if(message.id){
      const request=pending.get(message.id);
      pending.delete(message.id);
      if(message.error)request?.reject(new Error(`${request.method}: ${message.error.message}`));
      else request?.resolve(message.result);
    }else if(message.sessionId===sessionId){
      if(message.method==='Runtime.exceptionThrown')
        consoleErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if(message.method==='Runtime.consoleAPICalled' && message.params.type==='error')
        consoleErrors.push(message.params.args.map(arg=>arg.value ?? arg.description).join(' '));
    }
  });
  socket.addEventListener('close',()=>{
    for(const {method,reject} of pending.values())reject(new Error(`DevTools closed during ${method}`));
    pending.clear();
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;
    socket.send(JSON.stringify({id,method,params,sessionId}));
    pending.set(id,{method,resolve,reject});
  });
  const observe=async (fn,...args)=>{
    const {result,exceptionDetails}=await send('Runtime.evaluate',{
      expression:`(${fn})(${args.map(value=>JSON.stringify(value)).join(',')})`,returnByValue:true});
    if(exceptionDetails)throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until=async (label,predicate)=>{
    const deadline=performance.now()+5000;
    do{
      const value=await predicate();
      if(value)return value;
      await pause(20);
    }while(performance.now()<deadline);
    const status=await observe(()=>document.querySelector('#live-status')?.textContent);
    throw new Error(`${label} timed out${status?`: ${status}`:''}${consoleErrors.length?` · ${consoleErrors.join('; ')}`:''}`);
  };
  const visible=selector=>observe(s=>document.querySelector(s)?.checkVisibility(),selector);
  const press=async (key,{shift=false}={})=>{
    const keys={Tab:9,Enter:13,Escape:27,Home:36,ArrowUp:38,ArrowDown:40,' ':32};
    const text=key==='Enter'?'\r':key===' '?' ':undefined;
    const params={key,code:key===' '?'Space':key,windowsVirtualKeyCode:keys[key],modifiers:shift?8:0};
    await send('Input.dispatchKeyEvent',{...params,type:text?'keyDown':'rawKeyDown',text});
    await send('Input.dispatchKeyEvent',{...params,type:'keyUp'});
  };
  const tabTo=async (selector,{shift=false}={})=>{
    const active=()=>observe(s=>document.activeElement.matches(s),selector);
    for(let i=0;!await active();i++){
      assert.ok(i<75,`Tab did not reach ${selector}`);
      await press('Tab',{shift});
    }
    assert.ok(await observe(()=>document.activeElement.matches(':focus-visible')),`${selector} did not acquire keyboard focus`);
  };
  const click=async selector=>{
    await until(`${selector} visible`,()=>visible(selector));
    const {root}=await send('DOM.getDocument',{depth:0});
    const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector});
    await send('DOM.scrollIntoViewIfNeeded',{nodeId});
    const point=await until(`${selector} hit target`,()=>observe(s=>{
      const element=document.querySelector(s),r=element.getBoundingClientRect();
      const x=(Math.max(r.left,0)+Math.min(r.right,innerWidth))/2;
      const y=(Math.max(r.top,0)+Math.min(r.bottom,innerHeight))/2;
      return element.contains(document.elementFromPoint(x,y)) && {x,y};
    },selector));
    await send('Input.dispatchMouseEvent',{...point,type:'mousePressed',button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{...point,type:'mouseReleased',button:'left',clickCount:1});
  };
  const choose=async (selector,value)=>{
    await tabTo(selector);
    const index=await observe((s,v)=>Array.from(document.querySelector(s).options).findIndex(option=>option.value===v),selector,value);
    assert.ok(index>=0,`${selector} has no ${value} option`);
    await press('Home');
    for(let i=0;i<index;i++)await press('ArrowDown');
    assert.equal(await observe(s=>document.querySelector(s).value,selector),value);
  };
  const width=async value=>{
    await send('Emulation.setDeviceMetricsOverride',{width:value,height:860,deviceScaleFactor:1,mobile:false});
    await until(`viewport and sidebar breakpoint at ${value}px`,()=>observe(w=>
      innerWidth===w && (document.querySelector('#app-sidebar')?.inert ?? (w===390))===(w===390),value));
  };
  const playing=()=>observe(()=>window.voiceSmoke.output.filter(item=>item.ended).length);
  const turn=()=>observe(()=>document.querySelector('#live-stage').dataset.turn);
  const talkPressed=()=>observe(()=>document.querySelector('#live-talk').getAttribute('aria-pressed'));
  try{
    await new Promise((resolve,reject)=>{
      socket.addEventListener('open',resolve,{once:true});
      socket.addEventListener('error',()=>reject(new Error('Could not open loopback DevTools socket')),{once:true});
    });
    const {targetInfos}=await send('Target.getTargets');
    const target=targetInfos.find(info=>info.type==='page' && info.url===`${origin}/`);
    assert.ok(target,'Playback fixture tab was not found');
    ({sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
    await send('Runtime.enable');
    await click('#playback-check');
    await until('read-aloud reload',()=>observe(()=>location.search==='?replay' && Boolean(document.querySelector('#playback-check'))));
    await click('#playback-check');
    assert.equal(await completed,'');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await width(1440);
    const navigation=await send('Page.navigate',{url:`${origin}/?live#settings/sound`});
    assert.equal(navigation.errorText,undefined);
    await until('full app Sound settings',()=>observe(()=>document.body?.dataset.page==='settings' && !document.querySelector('#app-loading-screen')));
    assert.deepEqual(await observe(()=>Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .filter(link=>new URL(link.href).origin===location.origin && !link.sheet).map(link=>link.href)),[],
      'A local stylesheet from the original app shell did not load');
    await observe(observeLiveMedia);
    await click('#voice-v2-settings > summary');
    await choose('#voice-v2-source','personal');
    await until('loopback voice profile metadata',()=>observe(()=>Boolean(document.querySelector('#voice-v2-primary-profile option[value="server:fixture"]'))));
    await choose('#voice-v2-primary-profile','server:fixture');
    await tabTo('#voice-v2-primary-voice');
    await send('Input.insertText',{text:'fixture-voice'});
    await choose('#voice-v2-live-turn','ptt');
    await choose('#voice-v2-live-stt','voice');
    await click('#voice-v2-routing button[type="submit"]');
    await until('saved routing through Sound settings',()=>observe(()=>document.querySelector('#voice-v2-status').textContent.includes('Đã lưu')));
    await click('#tab-btn-classroom');
    await until('Classroom chat ready',()=>observe(()=>document.querySelector('.classroom-chat-window').dataset.ai==='ready'));
    await width(390);
    await click('#btn-mobile-sidebar');
    assert.ok(await observe(()=>document.querySelector('.app-main').inert && document.activeElement.id==='sidebar-close'));
    await press('Tab',{shift:true});
    assert.ok(await observe(()=>Boolean(document.activeElement.closest('#app-sidebar'))),'Drawer let keyboard focus escape');
    await press('Escape');
    assert.ok(await observe(()=>!document.querySelector('.app-main').inert && document.activeElement.id==='btn-mobile-sidebar'),
      'Escape did not close the drawer and return focus');
    await tabTo('#btn-voice-input');
    await press('Enter');
    await until('Voice panel',()=>visible('#classroom-voice'));
    assert.ok(!await visible('#classroom-text'),'Live did not replace text mode');
    const motion=()=>observe(()=>{
      const style=getComputedStyle(document.querySelector('.live-orb'));
      return [matchMedia('(prefers-reduced-motion: reduce)').matches,style.animationName,style.transitionProperty];
    });
    assert.equal((await motion())[1],'orb-breathe','Idle Voice should exercise a real animation before reduction');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.deepEqual(await motion(),[true,'none','none'],'Reduced motion did not stop the Voice orb animation and transition');
    await tabTo('#live-start');
    await press('Enter');
    assert.deepEqual(await observe(()=>window.voiceSmoke.resumes[0]),{activation:true,hasMicrophone:false},
      'Start must resume the actual AudioContext during a trusted gesture, before obtaining the microphone');
    await until('opening playback',async()=>await playing()===3 && await turn()==='you');
    assert.deepEqual(await observe(()=>{
      const {output}=window.voiceSmoke,[a,b,c]=output;
      return [output.map(item=>item.frequency),output.every(item=>item.context===a.context),b.when>=a.until && c.when>=b.until];
    }),[[440,550,660],true,true],'Opening batches must play in order without overlap in a shared AudioContext');
    assert.ok(await observe(()=>document.querySelector('.live-turn.assistant')?.textContent.includes('最初')),'Opening caption did not reach the transcript');

    // Exact widths in docs/CONTRIBUTING.md; check the same live call without reconnecting.
    for(const w of [390,768,1024,1440]){
      await width(w);
      const layout=await observe(()=>{
        const nodes=[...document.querySelectorAll('#live-talk,#live-turn-mode,#live-mute,#live-end,#live-commands button')];
        const sidebar=document.querySelector('#app-sidebar'),r=sidebar.getBoundingClientRect();
        const section=document.querySelector('#classroom-voice').getBoundingClientRect();
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,rail:!sidebar.inert && r.width>0 && r.right>0,
          inert:document.querySelector('.app-main').inert,
          controls:nodes.map(node=>{
            const r=node.getBoundingClientRect(),name=node.id || node.dataset.command;
            return {name,visible:node.checkVisibility() && r.width>0 && r.height>0 && r.left>=-1 && r.right<=innerWidth+1 &&
              r.left>=section.left-1 && r.right<=section.right+1 && r.top>=section.top-1 && r.bottom<=section.bottom+1,
              enabled:!node.disabled,height:r.height};
          })};
      });
      assert.equal(layout.width,w);
      assert.ok(!layout.overflow && !layout.inert && layout.rail===(w!==390),`Classroom shell overflow or incorrect drawer/rail at ${w}px`);
      assert.equal(layout.controls.length,11);
      for(const {name,visible,enabled,height} of layout.controls){
        assert.ok(visible && enabled,`${name} unavailable at ${w}px`);
        if(w===390 && ['live-talk','live-turn-mode','live-mute','live-end'].includes(name))
          assert.ok(height>=44,`${name} is below the 44px touch height at ${w}px`);
      }
    }
    await width(390);
    await tabTo('[data-command="repeat"]');
    await press('Enter');
    await until('local replay',async()=>await playing()===6 && await turn()==='you');
    assert.deepEqual(await observe(()=>window.voiceSmoke.output.slice(3).map(item=>item.frequency)),[440,550,660]);
    await tabTo('[data-command="hint"]',{shift:true});
    await press('Enter');
    await tabTo('#live-talk');
    await until('audible hint',()=>observe(()=>{
      const item=window.voiceSmoke.output[6];
      return item && item.context.currentTime>item.when+0.025;
    }));
    assert.ok(await observe(()=>{const item=window.voiceSmoke.output[6];return item.context.currentTime<item.until;}),'Hint ended before the interruption');
    await press(' ');
    assert.equal(await talkPressed(),'true');
    assert.ok(await observe(()=>window.voiceSmoke.output[6].stopped && window.voiceSmoke.output[6].context.state==='running'),
      'Barge-in did not stop playback and preserve the running context');
    await pause(520);
    await press(' ');
    await until('transcribed reply',async()=>await playing()===8 && await turn()==='you');
    assert.ok(await observe(()=>{
      const {output,keyboardClicks}=window.voiceSmoke;
      return output[7].frequency===770 && output[7].context===output[0].context &&
        document.querySelector('.live-turn.user')?.textContent.includes('昨日映画を見ました。') &&
        keyboardClicks.includes('live-start') && keyboardClicks.filter(id=>id==='live-talk').length===2;
    }),'Trusted Start/PTT actions, captured transcript, or reply playback missing');
    await tabTo('#live-mute',{shift:true});
    await press('Enter');
    assert.ok(await observe(()=>window.voiceSmoke.microphone.getAudioTracks().every(track=>!track.enabled) &&
      document.querySelector('#live-talk').disabled),'Mute did not disable capture and push-to-talk');
    await tabTo('#live-turn-mode');
    assert.equal(await observe(()=>document.querySelector('#live-turn-mode').value),'ptt');
    await press('ArrowUp');
    assert.equal(await observe(()=>document.querySelector('#live-turn-mode').value),'vad','ArrowUp did not switch the native Live mode select');
    assert.deepEqual(await observe(()=>{
      const button=document.querySelector('#live-talk');
      return [button.hidden,getComputedStyle(button).display];
    }),[true,'none'],'Automatic listening must hide push-to-talk in the full stylesheet cascade');
    await tabTo('#live-end',{shift:true});
    await press('Enter');
    await until('End released Live audio and microphone',()=>observe(()=>{
      const {microphone,output}=window.voiceSmoke;
      return output[0].context.state==='closed' && microphone.getTracks().every(track=>track.readyState==='ended') &&
        document.querySelector('#live-talk').hidden && document.querySelector('#live-turn-mode').hidden &&
        !document.querySelector('#live-start').disabled;
    }));
    assert.ok(await observe(()=>document.querySelector('#live-privacy').textContent.includes('gửi câu trả lời đến Mistral')),
      'Idle disclosure reverted to the native engine');
    await tabTo('[data-chat-mode="text"]',{shift:true});
    await press('Enter');
    assert.ok(await visible('#classroom-text') && !await visible('#classroom-voice'),'Return to text did not restore the composer view');

    await width(1440);
    await click('#tab-btn-curriculum');
    await click('#level-cards [data-level="N5"]');
    await click('#study-plan .plan-unit[open] .plan-talk');
    await until('lesson-scoped Classroom',()=>visible('#chat-lesson-context'));
    await click('#btn-voice-input');
    await click('#live-start');
    await until('held STT capability request',()=>liveRequests.filter(([,action])=>action==='capabilities').length===2);
    const general='#chat-lesson-context > button:nth-of-type(2)';
    assert.equal(await observe(s=>document.querySelector(s).textContent,general),'Trò chuyện chung');
    await click(general);
    await until('lesson change cancelled setup',()=>observe(()=>window.voiceSmoke.microphone.getTracks().every(track=>track.readyState==='ended') &&
      !document.querySelector('#live-start').disabled && /đã thay đổi/.test(document.querySelector('#live-status').textContent)));
    assert.deepEqual(consoleErrors,[],'Unexpected JavaScript errors in the Classroom app shell');
  }finally{
    socket.close();
  }
}

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
const platform={configured:true};
const appResponses={
  '/api/auth/session':{user:{user_id:'browser-fixture',name:'Học viên kiểm thử',is_admin:true}},
  '/api/auth/config':{client_id:'',local_admin:false},
  '/api/profile':{level:'N5'},
  '/api/progress':{items:[]},
  '/api/next-topic':{},
  '/api/completions':{items:[]},
  '/api/ai/settings':{source:'platform',is_admin:true,platform},
  '/api/ai/profiles':{profiles:[voiceProfile],active_id:null,is_admin:true,can_store:false,platform}
};
const server = createServer(async (req,res)=>{
  if (req.url==='/' || req.url==='/?replay') {
    pages.push(req.url);
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html);
  }
  if (req.url==='/?live') {
    pages.push(req.url);
    // Keep index.html byte-for-byte; the production tag order loads the full local cascade.
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"}).end(appHtml);
  }
  if (scripts.has(req.url)) return res.writeHead(200,{'Content-Type':'application/javascript'}).end(scripts.get(req.url));
  if (req.method==='GET') {
    const {pathname,searchParams}=new URL(req.url,'http://127.0.0.1');
    const payload=pathname==='/api/history'
      ? (searchParams.has('lesson_id') ? [{role:'assistant',content:'Em sẵn sàng chưa?'}] : [])
      : Object.hasOwn(appResponses,pathname) ? appResponses[pathname] : undefined;
    if(payload!==undefined)return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(payload));
    // Serve only static public assets, never local config or fixtures outside static/.
    const file=pathname.match(/^\/(?:[\w-]+\/)*[\w-]+\.([a-z]+)$/);
    if(file && Object.hasOwn(assetTypes,file[1])){
      try{
        const bytes=await readFile(`static${pathname}`);
        return res.writeHead(200,{'Content-Type':assetTypes[file[1]]}).end(bytes);
      }catch(error){
        if(error.code!=='ENOENT')return res.writeHead(500).end();
      }
    }
  }
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
const origin=`http://127.0.0.1:${server.address().port}`;
// Keep Chromium's decoder and playback clock, without depending on a physical audio device.
const browser = spawn(executable,['--headless','--disable-gpu','--disable-audio-output','--no-first-run','--no-default-browser-check','--autoplay-policy=document-user-activation-required',
  '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--window-size=560,860',
  '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
  '--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  `--user-data-dir=${profile}`,`${origin}/`],{stdio:['ignore','ignore','pipe']});
let diagnostics='',debuggerUrl;
const {promise:debuggerReady,resolve:resolveDebugger}=Promise.withResolvers();
browser.stderr.on('data',chunk=>{
  diagnostics=(diagnostics+chunk).slice(-2000);
  if(!debuggerUrl){
    debuggerUrl=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/.exec(diagnostics)?.[1];
    if(debuggerUrl)resolveDebugger(debuggerUrl);
  }
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
  await Promise.race([debuggerReady.then(url=>runLiveBrowser(url,origin)),
    exit.then(([code])=>{throw new Error(`Browser exited early (${code}): ${diagnostics}`);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Browser smoke timed out (pages ${pages}; synthesis ${requests}; live ${liveRequests}): ${diagnostics}`)),25000);})]);
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
  console.log('Chromium full Classroom shell: 390/768/1024/1440px, reduced motion, trusted keyboard, ordered TTS, local replay and synthetic STT.');
} catch(error) {
  failure=error;
  throw error;
} finally {
  clearTimeout(timer);
  testSocket?.close();
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
