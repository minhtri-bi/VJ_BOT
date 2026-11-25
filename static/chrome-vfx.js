// App-chrome scene cuts: a fast ink sweep while the existing router swaps panels.
(function(){
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  const wipe=document.createElement('div');
  wipe.className='chrome-scene-wipe';
  wipe.setAttribute('aria-hidden','true');
  document.body.append(wipe);
  const started=Date.now();
  let timer;

  function panel(){return document.querySelector('.tab-panel.active');}
  function sceneIn(){
    if(reduce.matches)return;
    const active=panel();
    if(!active)return;
    active.classList.remove('chrome-scene-in');
    wipe.classList.remove('run');
    void wipe.offsetWidth;
    active.classList.add('chrome-scene-in');
    wipe.classList.add('run');
    clearTimeout(timer);
    timer=setTimeout(()=>{
      active.classList.remove('chrome-scene-in');
      wipe.classList.remove('run');
    },360);
  }
  function sceneOut(){
    if(reduce.matches)return;
    const active=panel();
    if(!active)return;
    active.classList.add('chrome-panel-out');
    setTimeout(()=>active.classList.remove('chrome-panel-out'),150);
  }

  const observer=new MutationObserver(()=>{
    if(Date.now()-started<900){return;}
    sceneIn();
  });
  observer.observe(document.body,{attributes:true,attributeFilter:['data-page']});

  document.addEventListener('pointerdown',event=>{
    const control=event.target.closest?.('.sidebar-nav-item[data-tab],.mobile-bottom-item[data-tab]');
    if(!control||control.classList.contains('active'))return;
    sceneOut();
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    const control=event.target.closest?.('.sidebar-nav-item[data-tab],.mobile-bottom-item[data-tab]');
    if(!control||control.classList.contains('active'))return;
    sceneOut();
  },true);
})();
