// Classroom-only presentation effects: idle sprite frames and a lightweight typing bubble.
(function(){
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  const mascot=document.querySelector('#panel-classroom .welcome-mascot');
  if(mascot){
    const base='assets/lam/pixel/display/idle/';
    const frames=[0,1,2,3].map(i=>base+i+'.png');
    frames.forEach(src=>{const image=new Image();image.src=src;});
    let frame=0;
    setInterval(()=>{
      if(document.hidden||reduce.matches||!mascot.isConnected||mascot.closest('[hidden]'))return;
      frame=(frame+1)%frames.length;
      mascot.src=frames[frame];
    },560);
    reduce.addEventListener?.('change',()=>{if(reduce.matches)mascot.src=base+'0.png';});
  }

  const windowEl=document.querySelector('#panel-classroom .classroom-chat-window');
  const log=document.getElementById('chat-messages');
  const status=document.getElementById('chat-connection-status');
  if(!windowEl||!log)return;
  const typing=document.createElement('div');
  typing.className='chat-bubble-row bot-row classroom-typing-row';
  typing.setAttribute('aria-hidden','true');
  typing.innerHTML='<div class="bubble-avatar-box"><img src="assets/lam/pixel/display/south.png" alt="" class="bubble-avatar-img pixel-sprite"></div><div class="bubble-speech-card bot classroom-typing-bubble"><i></i><i></i><i></i></div>';
  function syncTyping(){
    const busy=windowEl.getAttribute('aria-busy')==='true' && (status?.textContent||'').includes('trả lời');
    if(busy&&!typing.isConnected)log.append(typing),log.scrollTop=log.scrollHeight;
    if(!busy)typing.remove();
  }
  new MutationObserver(syncTyping).observe(windowEl,{attributes:true,attributeFilter:['aria-busy']});
  if(status)new MutationObserver(syncTyping).observe(status,{childList:true,characterData:true,subtree:true});
  syncTyping();
})();
