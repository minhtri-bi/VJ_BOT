// GPT-Live deltas carry approximate session offsets, not completed-turn events.
(function(){
  window.createLiveTranscript=host=>{
    let segments=[],last={user:null,assistant:null},seen=new Set(),owner=null,sequence=0,accepting=false;
    const clock=ms=>{const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
    function render(segment){
      const follow=host.scrollHeight-host.scrollTop-host.clientHeight<60;
      if(!segment.row){
        const row=segment.row=document.createElement('article');row.className='live-turn '+segment.role;
        const meta=document.createElement('header'),name=document.createElement('strong'),time=segment.time=document.createElement('span');
        name.textContent=segment.role==='user'?'Em':'Thầy Lâm';meta.append(name,time);
        segment.original=document.createElement('p');segment.original.className='live-original';
        row.append(meta,segment.original);
        const next=segments.find(s=>s.start>segment.start && s.row?.parentNode===host);host.insertBefore(row,next?.row || null);
        host.dataset.empty='false';
      }
      segment.time.textContent=clock(segment.start)+' – '+clock(segment.end);
      segment.time.setAttribute('aria-label','Mốc thời gian xấp xỉ '+clock(segment.start)+' đến '+clock(segment.end));
      segment.original.textContent=segment.text;
      group();
      if(follow)host.scrollTop=host.scrollHeight;
    }
    // Consecutive sentences from one speaker form a single turn: the first row carries the stamp for the whole turn.
    function group(){
      let head=null;
      for(const segment of segments){
        if(!segment.row)continue;
        if(head && head.role===segment.role){
          head.last=Math.max(head.last,segment.end);segment.row.dataset.cont='true';segment.time.textContent='';
        }else{head=segment;head.first=segment.start;head.last=segment.end;segment.row.dataset.cont='false';}
        head.time.textContent=clock(head.first)+' – '+clock(head.last);
        head.time.setAttribute('aria-label','Cả lượt nói, mốc thời gian xấp xỉ '+clock(head.first)+' đến '+clock(head.last));
      }
    }
    function stop(){accepting=false;}
    return {
      reset(){stop();owner=signedInUser?.user_id;segments=[];sequence=0;last={user:null,assistant:null};seen=new Set();accepting=true;host.replaceChildren();host.dataset.empty='true';},
      add(event){
        if(!accepting || owner!==signedInUser?.user_id || !['session.input_transcript.delta','session.output_transcript.delta'].includes(event.type)
          || typeof event.delta!=='string' || !event.delta || event.delta.length>1200
          || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms<0 || event.end_ms<event.start_ms || event.end_ms>660000)return;
        if(event.event_id && seen.has(event.event_id))return;
        if(event.event_id){seen.add(event.event_id);if(seen.size>4000)seen.delete(seen.values().next().value);}
        const role=event.type==='session.input_transcript.delta'?'user':'assistant';
        let segment=last[role];
        const sentence=segment && /[。！？!?][」』）]*\s*$/.test(segment.text) && event.delta.trim() && !/^[」』）…。！？!?、,.\s]+$/.test(event.delta);
        if(!segment || sentence || event.start_ms-segment.end>1200 || event.start_ms-segment.start>=8000 || event.start_ms<segment.start || segment.text.length+event.delta.length>1200){
          segment={id:'caption_'+sequence++,role,start:event.start_ms,end:event.end_ms,text:''};
          segments.push(segment);segments.sort((a,b)=>a.start-b.start);last[role]=segment;
          if(segments.length>300){const removed=segments.shift();removed.row?.remove();}
        }
        segment.text+=event.delta;segment.end=Math.max(segment.end,event.end_ms);
        render(segment);
      },
      finish(){accepting=false;},
      stop,
      accountChanged(){if(owner!==signedInUser?.user_id || !signedInUser){stop();owner=null;segments=[];host.replaceChildren();host.dataset.empty='true';}}
    };
  };
})();
