(function () {
  const floor=10**(-42/20), rmsTarget=10**(-18/20), peakLimit=0.98;
  const pause={start:0,inline:0.055,sentence:0.2,arrow:0.26};
  const maxSeconds=90;
  function bounded(promise,signal,milliseconds,detail) {
    return new Promise((resolve,reject)=>{
      if (signal.aborted) {reject(signal.reason);return;}
      const timer=setTimeout(()=>finish(reject,new Error(detail)),milliseconds);
      const cancel=()=>finish(reject,signal.reason);
      function finish(settle,value) {clearTimeout(timer);signal.removeEventListener('abort',cancel);settle(value);}
      signal.addEventListener('abort',cancel,{once:true});
      promise.then(value=>finish(resolve,value),error=>finish(reject,error));
    });
  }
  async function readDuration(bytes,mime,signal) {
    const url=URL.createObjectURL(new Blob([bytes],{type:mime})), media=new Audio();
    try {
      const loaded=new Promise((resolve,reject)=>{
        media.onloadedmetadata=()=>resolve(media.duration);
        media.onerror=()=>reject(new Error('Định dạng âm thanh không đọc được.'));
        media.preload='metadata';media.src=url;
      });
      return await bounded(loaded,signal,5000,'Không đọc được thời lượng âm thanh.');
    } finally {
      media.onloadedmetadata=media.onerror=null;media.removeAttribute('src');media.load();URL.revokeObjectURL(url);
    }
  }
  function create() {
    const Context=window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Trình duyệt không hỗ trợ ghép âm thanh.');
    const abort=new AbortController(), context=new Context({sampleRate:24000});
    const ready=bounded(context.resume(),abort.signal,5000,'Trình duyệt chưa cho phát âm thanh. Bấm Nghe lại.');
    ready.catch(()=>{});
    let next=0, closed=false;
    const active=new Set();
    let tail=Promise.resolve();
    async function append(segment) {
      await ready;
      if (closed) return;
      if (active.size>=2) await active.values().next().value.done;
      if (closed) return;
      const uri=audioDataUrl(segment);
      const encoded=Uint8Array.from(atob(uri.slice(uri.indexOf(',')+1)),character=>character.charCodeAt(0));
      const durationHint=await readDuration(encoded,uri.slice(5,uri.indexOf(';')),abort.signal);
      if (!Number.isFinite(durationHint) || durationHint<=0 || durationHint>maxSeconds)
        throw new Error('Đoạn âm thanh quá dài. Hãy chọn đoạn ngắn hơn.');
      const buffer=await context.decodeAudioData(encoded.buffer);
      if (closed) return;
      if (buffer.duration>maxSeconds || ![1,2].includes(buffer.numberOfChannels))
        throw new Error('Định dạng hoặc thời lượng đoạn âm thanh không được hỗ trợ.');
      const channels=Array.from({length:buffer.numberOfChannels},(_,index)=>buffer.getChannelData(index));
      let first=buffer.length,last=-1;
      for (const channel of channels) {
        for (let i=0;i<first;i++) if (Math.abs(channel[i])>=floor) {first=i;break;}
        for (let i=channel.length-1;i>last;i--) if (Math.abs(channel[i])>=floor) {last=i;break;}
      }
      if (last<first) throw new Error('Nhà cung cấp trả về đoạn âm thanh im lặng.');
      const samples=last-first+1;
      let squares=0,peak=0;
      for (const channel of channels) for(let i=first;i<=last;i++) {
        const sample=channel[i];squares+=sample*sample;peak=Math.max(peak,Math.abs(sample));
      }
      const gain=Math.min(rmsTarget/Math.sqrt(squares/(samples*channels.length)),peakLimit/peak,4);
      const source=context.createBufferSource(), volume=context.createGain();
      source.buffer=buffer;source.playbackRate.value=segment.speed;
      source.connect(volume).connect(context.destination);
      const start=Math.max(context.currentTime+0.015,next+(pause[segment.boundary] || 0));
      const seconds=samples/buffer.sampleRate, duration=seconds/segment.speed, fade=Math.min(0.012,duration/2);
      volume.gain.setValueAtTime(0,start);volume.gain.linearRampToValueAtTime(gain,start+fade);
      volume.gain.setValueAtTime(gain,start+duration-fade);volume.gain.linearRampToValueAtTime(0,start+duration);
      next=start+duration;
      let settle;
      const entry={source,done:new Promise(resolve=>{settle=resolve;}),finish(){
        if (!active.delete(entry)) return;
        source.onended=null;source.disconnect();volume.disconnect();settle();
      }};
      active.add(entry);source.onended=entry.finish;tail=entry.done;
      source.start(start,first/buffer.sampleRate,seconds);
    }
    function stop() {
      if (closed) return;
      closed=true;abort.abort();
      for (const entry of active) {
        try {entry.source.stop();} catch { /* Already ended. */ }
        entry.finish();
      }
      context.close().catch(()=>{});
    }
    return {append,finish:()=>tail,stop};
  }
  window.VJVoiceStitcher=Object.freeze({create});
})();
