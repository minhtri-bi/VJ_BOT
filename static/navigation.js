const learningLevels=['N5','N4','N3','N2','N1'];
const learningSkills=['kana','grammar','vocabulary','kanji','reading','listening','production'];
let navigationVersion=0,currentLesson=null;
function parseAppRoute(hash){
  let parts;
  try{parts=hash.replace(/^#/,'').split('/').map(decodeURIComponent);}catch{return {tab:'landing'};}
  const [tab,level,view,skill,id]=parts;
  if(tab==='settings')return {tab:'settings',view:['account','api','admin','sound','data'].includes(level)?level:'account'};
  if(['kaiwa','kanji','flashcards','quiz'].includes(tab)){
    const validLevel=learningLevels.includes(level)?level:undefined;
    if(validLevel && view==='lesson' && skill && ['kaiwa','flashcards','quiz'].includes(tab))return {tab:'lesson',owner:tab,level,skill:tab==='flashcards'?'vocabulary':tab==='kaiwa'?'listening':'reading',id:skill};
    return {tab,level:validLevel,view:['practice','simulation','review','session','catalog'].includes(view)?view:undefined,id:skill};
  }
  if(tab!=='curriculum')return {tab:Object.hasOwn(TAB_TITLES,tab) && tab!=='lesson'?tab:'landing'};
  if(!level)return {tab:'curriculum'};
  if(!learningLevels.includes(level))return {tab:'curriculum'};
  if(view==='lesson' && learningSkills.includes(skill) && id)return {tab:'lesson',level,skill,id,
    ...(parts[5]==='review' && parts[6]?{reviewTaskId:parts[6]}:{})};
  if(view==='library')return {tab:'curriculum',level,view:'library',skill:learningSkills.includes(skill)?skill:'grammar'};
  return {tab:'curriculum',level,view:'plan'};
}
function appRouteHash(tab,route={}){
  if(tab==='settings' && route.view && route.view!=='account')return `#settings/${route.view}`;
  if(['kaiwa','kanji','flashcards','quiz'].includes(tab) && route.level)return `#${tab}/${route.level}${route.view?`/${route.view}/${encodeURIComponent(route.id || '0')}`:''}`;
  if(tab==='lesson' && route.owner)return `#${route.owner}/${route.level}/lesson/${encodeURIComponent(route.id)}`;
  if(tab==='lesson')return `#curriculum/${route.level}/lesson/${route.skill}/${encodeURIComponent(route.id)}${route.reviewTaskId?`/review/${encodeURIComponent(route.reviewTaskId)}`:''}`;
  if(tab==='curriculum' && route.level)return `#curriculum/${route.level}${route.view==='library'?`/library/${route.skill || 'grammar'}`:''}`;
  return `#${tab}`;
}
function openLevelCourse(level,view='plan',skill='grammar',fromHistory=false){
  switchTab('curriculum',{level,view,skill,fromHistory});
}
function returnToCourse(){
  if(currentLesson?.owner){switchTab(currentLesson.owner,{level:currentLesson.level});return;}
  if(currentLesson?.returnTab==='kanji'){switchTab('kanji',{level:currentLesson.level});return;}
  const level=currentLesson?.level || activeCurriculumLevel;
  const view=currentLesson?.returnView || 'plan';
  openLevelCourse(level,view,view==='library'?currentLesson?.skill || 'grammar':'grammar');
}
async function restoreAppRoute(){
  const route=parseAppRoute(location.hash);
  if(!authorizePage(route.tab,route))return;
  if(route.tab!=='lesson'){switchTab(route.tab,{...route,fromHistory:true});return;}
  if(switchTab('lesson',{...route,fromHistory:true})===false)return;
  const version=navigationVersion;
  const host=document.getElementById('modal-lesson-body');host.textContent='Đang tải bài học…';
  document.getElementById('modal-lesson-title').textContent='Bài học';
  document.getElementById('modal-lesson-badge').textContent=route.level;
  currentLesson={level:route.level,skill:route.skill,returnView:'plan'};
  try{
    await Promise.all([ensureLessons(route.level),loadPracticalCourse()]);
    if(version!==navigationVersion)return;
    if(route.owner){const item=findFeatureLesson(route.owner,route.level,route.id);if(!item)throw new Error('missing');showLessonDetail(item,route.level,route.skill,true,route.owner);return;}
    const units=createStudyPlan(route.level);
    const lessons=[...units.flatMap(u=>u.steps.filter(s=>!s.kind).map(s=>s.lesson)),...(window.JLPT_DATA.curriculum[route.level].skills[route.skill]||[])];
    let item=lessons.find(l=>activityId(l,route.level,route.skill)===route.id);
    if(!item && route.id.startsWith('jlpt:'))item=officialResourceLesson(route.level,route.id.split(':').at(-1),route.id.split(':')[1]);
    if(!item && route.id.startsWith('erin:')){const source=erinResources.lessons.find(l=>l.id===route.id);if(source)item=erinResourceLesson(source);}
    if(!item)throw new Error('missing');
    if(route.reviewTaskId){
      const tasks=lessonQuestions(item,route.level,route.skill),index=tasks.findIndex(task=>task.task_id===route.reviewTaskId && task.exchange?.stage==='delayed');
      if(index<0 || item.delayed_review_task_id!==route.reviewTaskId)throw new Error('missing');
      const response=await apiFetch('/api/progress');if(!response.ok)throw new Error('progress');
      const progress=await response.json(),revisions=new Map(await Promise.all(tasks.map(async task=>[task.task_id,(await taskReference(task)).revision])));
      if(version!==navigationVersion)return;
      const later=delayedReviewState(item,tasks,progress.evidence,revisions);
      if(!later?.due)throw new Error('not due');
      item={...item,reviewQuestionIndex:index,delayedReview:true};
    }
    showLessonDetail(item,route.level,route.skill,true);
  }catch{
    if(version!==navigationVersion)return;
    host.textContent='Chưa mở được bài học. ';
    const retry=document.createElement('button');retry.className='stage-btn';retry.textContent='Thử lại';retry.onclick=restoreAppRoute;host.append(retry);
  }
}
function officialResourceLesson(level,type,year='2018'){
  const main=jlptResources.resources.find(r=>r.id===`jlpt:${year}:${level}:${type}`);
  if(!main || !['V','G','R','L'].includes(type))return null;
  return {id:main.id,title:`${level} · ${main.title} · ${year}`,sourceLabel:'JLPT · tài liệu chính thức',summary:'Làm bài trên tài liệu gốc, đối chiếu đáp án, rồi đánh dấu đã xem ở đây.',externalResources:jlptResources.resources.filter(r=>r.level===level && r.year===year && (r.id===main.id || /:(answer|sheet)$/.test(r.id) || (type==='L' && (r.kind==='audio' || r.id.endsWith(':script')))))};
}
function erinResourceLesson(lesson){
  return {id:lesson.id,title:lesson.title,lesson:lesson.number,sourceLabel:'Japan Foundation · Erin',summary:'Hội thoại, từ vựng và văn hóa tại Japan Foundation.',externalResources:lesson.resources};
}
async function renderLevelCards(){
  const host=document.getElementById('level-cards');
  host.setAttribute('aria-busy','true');
  host.textContent='Đang tải khóa học…';
  try{
    await loadPracticalCourse();
    const descriptions=[['Bắt đầu','Chữ cái, giới thiệu bản thân và những câu dùng hằng ngày.'],['Nền tảng','Kể chuyện, diễn đạt dự định và xử lý tình huống quen thuộc.'],['Kết nối','Đọc thông tin, trình bày ý kiến và giao tiếp tự nhiên hơn.'],['Mở rộng','Theo dõi lập luận, đọc bài báo và diễn đạt sắc thái.'],['Chuyên sâu','Phân tích quan điểm, hàm ý và văn phong trang trọng.']];
    host.replaceChildren();
    for(const [index,level] of learningLevels.entries()){
      const [title,description]=descriptions[index];
      const chapters=courseChapters.chapters.filter(c=>c.level===level).length;
      const units=practicalCourse.units.filter(u=>u.level===level).length;
      const card=document.createElement('a');card.className='level-course-card';card.href=appRouteHash('curriculum',{level});
      card.innerHTML=`<div class="level-cover" data-level="${level}" aria-hidden="true"><img src="assets/courses/${level.toLowerCase()}.svg" alt="" width="300" height="168"></div><div class="level-card-content"><h2>${level} <span>${title}</span></h2><p>${description}</p><div class="level-card-footer"><span>${chapters} chương · ${units} bài tình huống</span><span aria-hidden="true">↗</span></div></div>`;
      card.onclick=event=>{if(event.button===0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey){event.preventDefault();openLevelCourse(level);}};host.append(card);
    }
  }catch{
    host.textContent='Chưa tải được khóa học. ';
    const retry=document.createElement('button');retry.className='stage-btn';retry.textContent='Thử lại';retry.onclick=renderLevelCards;host.append(retry);
  }finally{host.setAttribute('aria-busy','false');}
}
function setupSidebar(){
  const sidebar=document.getElementById('app-sidebar'),toggle=document.getElementById('btn-mobile-sidebar'),backdrop=document.getElementById('sidebar-backdrop'),railToggle=document.getElementById('sidebar-toggle');
  const mobile=matchMedia('(max-width: 739px)');
  const wide=matchMedia('(min-width: 1100px)');
  let expanded=localStorage.getItem('vjbot_sidebar_expanded')===null?wide.matches:localStorage.getItem('vjbot_sidebar_expanded')==='true';
  const paths={
    admin:'<path d="M12 3l7 3v5.5c0 4.5-3 7.3-7 8.5-4-1.2-7-4-7-8.5V6z"/><path d="M10.5 12l1.2 1.2 2.8-3"/>',
    dashboard:'<path d="M4 5.5h7v13H4zM13 5.5h7v13h-7z"/><path d="M6.5 9h2M6.5 12h2M15.5 9h2M15.5 12h2"/>',
    landing:'<path d="M4 5.5h7v13H4zM13 5.5h7v13h-7z"/><path d="M6.5 9h2M6.5 12h2M15.5 9h2M15.5 12h2"/>',
    curriculum:'<path d="M5 4h6l2 2 2-2h5v16h-5l-2 2-2-2H5z"/><path d="M12 6v14M14.5 7h3M7.5 7v5l1.5-1 1.5 1V7"/>',
    classroom:'<path d="M4 4h16v11H4z"/><path d="M7 8h6M7 11h3M11 15l-3 5M13 15l3 5"/><path d="M17 5.5l1.2-1.2M18.5 9h1.5"/>',
    mastery:'<path d="M12 20v-8"/><path d="M12 12c-4 0-6-2-6-5 3.5 0 5.5 1.5 6 5zM12 9c0-3.5 2-5 5-5 0 3-2 5-5 5z"/><path d="M7 20h10"/>',
    flashcards:'<path d="M7 3h12v14H7z"/><path d="M5 7v14h12"/><path d="M10.5 12h5M13 9.5v5"/>',
    kanji:'<path d="M5 5h14M12 3v4"/><path d="M7 9c3 5 7 8 10 10M17 9c-3 5-7 8-10 10"/>',
    kaiwa:'<path d="M4 4h11v9H8l-4 4z"/><path d="M15 7h5v9h-4l-2 2v-2"/><path d="M7 7.5h5M7 10h3"/>',
    quiz:'<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.5"/><path d="M13.5 10.5L19 5M19 5h-3M19 5v3"/>',
    settings:'<path d="M5 7h10M19 7h1M5 12h2M11 12h9M5 17h10M19 17h1"/><circle cx="17" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'
  };
  const iconSvg=(tab,cls)=>`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[tab]}</svg>`;
  for(const button of sidebar.querySelectorAll('[data-tab]')){
    const label=button.textContent.trim();button.setAttribute('aria-label',label);button.title=label;
    if(!button.querySelector('.rail-icon'))button.insertAdjacentHTML('afterbegin',iconSvg(button.dataset.tab,'rail-icon'));
  }
  for(const button of document.querySelectorAll('.mobile-bottom-item[data-tab]')){
    const label=button.textContent.trim();button.setAttribute('aria-label',label);button.title=label;
    if(!button.querySelector('.m-icon'))button.insertAdjacentHTML('afterbegin',`<span class="m-icon" aria-hidden="true">${iconSvg(button.dataset.tab,'rail-icon')}</span>`);
  }
  function draw(open=false){
    document.body.classList.toggle('sidebar-expanded',expanded);
    sidebar.classList.toggle('open',mobile.matches && open);backdrop.classList.toggle('active',mobile.matches && open);
    sidebar.inert=mobile.matches && !open;
    const isOpen=mobile.matches?open:expanded;
    for(const control of [toggle,railToggle]){control.setAttribute('aria-expanded',String(isOpen));control.setAttribute('aria-label',isOpen?'Thu gọn menu':'Mở menu');control.title=isOpen?'Thu gọn menu':'Mở menu';}
    document.querySelector('.app-main').inert=mobile.matches && open;
    document.querySelector('.mobile-bottom-bar').inert=mobile.matches && open;
  }
  window.closeAppSidebar=()=>draw(false);
  toggle.onclick=()=>{if(mobile.matches){draw(!sidebar.classList.contains('open'));document.getElementById('sidebar-close').focus();}else{expanded=!expanded;localStorage.setItem('vjbot_sidebar_expanded',String(expanded));draw();}};
  railToggle.onclick=toggle.onclick;
  const close=document.getElementById('sidebar-close');close.onclick=()=>{draw(false);toggle.focus();};
  backdrop.onclick=()=>{draw(false);toggle.focus();};
  document.addEventListener('keydown',event=>{
    if(!mobile.matches || !sidebar.classList.contains('open'))return;
    if(event.key==='Escape'){draw(false);toggle.focus();}
    if(event.key==='Tab'){
      const buttons=[...sidebar.querySelectorAll('button,a[href]')].filter(e=>e.getClientRects().length),first=buttons[0],last=buttons.at(-1);
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  mobile.addEventListener('change',()=>draw(false));
  wide.addEventListener('change',()=>{if(localStorage.getItem('vjbot_sidebar_expanded')===null)expanded=wide.matches;draw(false);});draw();
}
