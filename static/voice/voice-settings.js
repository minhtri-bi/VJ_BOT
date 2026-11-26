(function () {
  const el=id=>document.getElementById('voice-v2-'+id);
  const prefix='vjbot_voice_routing_v2:';
  const bases={elevenlabs:'https://api.elevenlabs.io',mistral:'https://api.mistral.ai/v1',openai:'https://api.openai.com/v1',gemini:'https://generativelanguage.googleapis.com',openai_compatible:''};
  const titles={primary:'Kết nối chính',ja:'Tiếng Nhật',vi:'Tiếng Việt'};
  const source=el('source'), mode=el('mode'), slots=el('slots'), status=el('status'), kind=el('kind'), url=el('url');
  const controls=new Map(), catalogs=new Map(), selectedAccounts=new Map();
  let rows=[], metadataOwner, drawnIdentity, busy=false;
  const owner=()=>signedInUser?.user_id;
  const admin=()=>signedInUser?.is_admin===true;
  const ref=row=>`${row.scope}:${row.id}`;
  const provider=row=>row.protocol==='openai' && row.base_url===bases.mistral ? 'mistral' : row.protocol;
  const roleKey=()=>JSON.stringify([owner(),admin()]);
  const modes=['single','dual_same_api','dual_split_api'];
  const voiceChanged=()=>window.dispatchEvent(new CustomEvent('vjbot-voice-changed',{detail:{source:'routing-v2'}}));
  const fingerprint=row=>[row.base_url,row.connection_id,row.key_last4,row.revision];
  const reloadProfiles=()=>window.loadVoiceProfiles?.({personalVoice:true});
  function stored() {
    if (!owner()) return null;
    const raw=localStorage.getItem(prefix+owner());
    if (!raw) return null;
    const value=JSON.parse(raw);
    if (value?.version!==2 || !modes.includes(value.mode) || typeof value.admin_override!=='boolean') throw new Error('Cấu hình đã lưu không hợp lệ. Hãy lưu lại trong Âm thanh.');
    if (value.admin_override!==admin()) throw new Error('Quyền tài khoản đã thay đổi. Chọn lại nguồn giọng đọc.');
    // An empty speed input was previously saved as zero.
    for (const slot of ['ja','vi']) if (value[slot]?.speed===0) value[slot].speed=1;
    return value;
  }
  function save(value) {
    if (!owner()) throw new Error('Đăng nhập để chọn giọng đọc.');
    if (value) localStorage.setItem(prefix+owner(),JSON.stringify(value));
    else localStorage.removeItem(prefix+owner());
    voiceChanged();
  }
  function input(parent,label,id,type='text') {
    const wrapper=document.createElement('label'), control=document.createElement(type==='select'?'select':'input');
    control.id='voice-v2-'+id;
    if (type!=='select') control.type=type;
    wrapper.textContent=label; wrapper.append(control); parent.append(wrapper);
    return control;
  }
  function option(value,label) {
    const node=document.createElement('option');node.value=value;node.textContent=label;return node;
  }
  function redrawAccounts() {
    for (const [slot,control] of controls) {
      const selected=control.profile.value;
      control.profile.replaceChildren(option('',slot==='primary'?'Chọn kết nối đã lưu':'Dùng kết nối chính'));
      for (const row of rows) control.profile.append(option(ref(row),row.name));
      if (selected && !rows.some(row=>ref(row)===selected)) control.profile.append(option(selected,'Kết nối không còn dùng được'));
      control.profile.value=selected;
    }
  }
  function layout() {
    for (const [slot,control] of controls) {
      control.section.hidden=slot!=='primary' && mode.value==='single';
      control.profile.parentElement.hidden=slot!=='primary' && mode.value!=='dual_split_api';
      control.profile.disabled=control.profile.parentElement.hidden || control.section.hidden;
      for (const field of [control.model,control.voice,control.speed,control.reading]) if (field) field.disabled=control.section.hidden;
    }
  }
  function effectiveAccount(slot) {
    const {profile}=controls.get(slot);
    return (!profile.disabled && profile.value) || controls.get('primary').profile.value;
  }
  function updateAccounts(reset=false) {
    for (const [slot,control] of controls) {
      if (!reset && control.section.hidden) continue;
      const reference=effectiveAccount(slot);
      const previous=selectedAccounts.get(slot), row=rows.find(row=>ref(row)===reference);
      const custom=row?.protocol==='openai_compatible' && !control.profile.disabled && Boolean(control.profile.value);
      control.nativeSpeed.parentElement.hidden=!custom;
      control.nativeSpeed.disabled=!custom || control.section.hidden;
      const endpoint=row ? JSON.stringify([provider(row),row.base_url]) : null;
      const revision=row ? JSON.stringify(fingerprint(row)) : null;
      const changed=reference!==previous?.reference || (endpoint && previous?.endpoint && endpoint!==previous.endpoint);
      if (reset || changed || revision!==previous?.revision) {
        if (!reset && changed) {
          control.model.value=control.voice.value='';
          control.nativeSpeed.checked=false;
        }
        control.modelList.replaceChildren();control.voiceList.replaceChildren();
        control.catalog.textContent='Tải giọng & model';
        catalogs.delete(slot);
        selectedAccounts.set(slot,{reference,endpoint:endpoint || (!changed && previous?.endpoint),revision});
      }
    }
  }
  for (const [slot,title] of Object.entries(titles)) {
    const section=document.createElement('fieldset'), legend=document.createElement('legend');
    legend.textContent=title;section.append(legend);slots.append(section);
    const profile=input(section,'Kết nối',slot+'-profile','select');
    const model=input(section,'ID model (để trống nếu dùng mặc định)',slot+'-model');model.maxLength=100;
    const voice=input(section,'ID giọng (để trống nếu dùng mặc định)',slot+'-voice');voice.maxLength=100;
    const modelList=document.createElement('datalist'), voiceList=document.createElement('datalist');
    modelList.id='voice-v2-models-'+slot;voiceList.id='voice-v2-voices-'+slot;
    model.setAttribute('list',modelList.id);voice.setAttribute('list',voiceList.id);section.append(modelList,voiceList);
    const speed=slot!=='primary' ? input(section,'Tốc độ phát',slot+'-speed','number') : null;
    if (speed) Object.assign(speed,{min:'0.5',max:'2',step:'0.01',value:'1'});
    const nativeSpeed=input(section,'Máy chủ tùy chỉnh hỗ trợ chỉnh tốc độ',slot+'-native-speed','checkbox');
    const reading=slot!=='vi' ? input(section,'Cách đọc Kanji',slot+'-reading','select') : null;
    reading?.append(option('kanji_native','Giữ Kanji'),option('kana_first','Ưu tiên kana'));
    const catalog=document.createElement('button');catalog.type='button';catalog.className='stage-btn';catalog.textContent='Tải giọng & model';section.append(catalog);
    controls.set(slot,{section,profile,model,voice,speed,nativeSpeed,reading,catalog,modelList,voiceList});
    catalog.addEventListener('click',()=>loadCatalog(slot));
    profile.addEventListener('change',()=>updateAccounts());
  }
  function capture() {
    const config={version:2,mode:mode.value,admin_override:admin()};
    for (const [slot,control] of controls) {
      if (slot!=='primary' && config.mode==='single') continue;
      const reference=control.profile.disabled ? '' : control.profile.value;
      const row=rows.find(row=>ref(row)===reference);
      if ((slot==='primary' || reference) && !row) throw new Error('Chọn kết nối đã lưu cho '+titles[slot]+'.');
      const settings={profile:row ? {scope:row.scope,id:row.id} : null};
      if (row) settings.provider=provider(row);
      const model=control.model.value.trim(), voice=control.voice.value.trim();
      if (model) settings.model=model;
      if (voice) settings.voice_id=voice;
      if (!control.nativeSpeed.disabled && control.nativeSpeed.checked) settings.native_speed=true;
      if (control.speed) {
        const speed=control.speed.value==='' ? 1 : Number(control.speed.value);
        if (!Number.isFinite(speed) || speed<0.5 || speed>2) throw new Error('Tốc độ phải từ 0.5 đến 2.');
        settings.speed=speed;
      }
      if (control.reading) settings.kanji_mode=control.reading.value;
      config[slot]=settings;
    }
    for (const [lang,slot] of Object.entries(config.mode==='single' ? {ja:config.primary,vi:config.primary} : {ja:config.ja,vi:config.vi})) {
      const effective=slot.profile ? slot : {...config.primary,...slot,provider:config.primary.provider};
      if (['elevenlabs','openai_compatible'].includes(effective.provider) || effective.provider==='mistral' && config.mode==='single') {
        if (!effective.voice_id) throw new Error(`Nhập ID giọng cho ${titles[lang]}.`);
      }
      if (effective.provider==='openai_compatible' && !effective.model) throw new Error(`Nhập ID model cho ${titles[lang]}.`);
      if (effective.provider==='elevenlabs' && lang==='vi' && effective.model==='eleven_multilingual_v2')
        throw new Error('Eleven Multilingual v2 không hỗ trợ tiếng Việt. Chọn model khác.');
    }
    return config;
  }
  function restore() {
    redrawAccounts();
    let config;
    try {config=stored();}
    catch (error) {status.textContent=error.message;}
    source.value=config?'personal':'legacy';el('personal').hidden=!config;
    mode.value=config?.mode || 'single';
    for (const [slot,control] of controls) {
      const value=config?.[slot] || {};
      if (value.profile) {
        const key=ref(value.profile);
        if (!rows.some(row=>ref(row)===key)) control.profile.append(option(key,'Kết nối không còn dùng được'));
        control.profile.value=key;
      } else control.profile.value='';
      control.model.value=value.model || '';control.voice.value=value.voice_id || '';
      if (control.speed) control.speed.value=value.speed ?? 1;
      control.nativeSpeed.checked=value.native_speed===true;
      if (control.reading) control.reading.value=value.kanji_mode || 'kanji_native';
    }
    layout();
    catalogs.clear();updateAccounts(true);
  }
  const rowFor=slot=>rows.find(row=>ref(row)===ref(slot.profile) && provider(row)===slot.provider);
  async function prepared(config,signal,{replay=false}={}) {
    const identity=roleKey(), user=owner(), result={...config}, loaded=new Map();
    if (metadataOwner!==user) throw new Error('Chưa tải được danh sách kết nối giọng nói.');
    let server;
    if (['primary','ja','vi'].some(name=>config[name]?.profile?.scope==='server')) {
      const response=await apiFetch('/api/ai/profiles',{signal});
      if (!response.ok) throw new Error('Chưa kiểm tra được kết nối giọng nói trên máy chủ.');
      const data=await response.json();
      if (roleKey()!==identity || signal?.aborted || !Array.isArray(data.profiles)) throw new Error('Kết nối giọng nói đã đổi.');
      server=new Map(data.profiles.map(row=>[row.id,row]));
    }
    for (const name of ['primary','ja','vi']) {
      const slot=config[name];
      if (!slot?.profile) continue;
      const row=rowFor(slot);
      if (!row) throw new Error('Kết nối giọng nói đã đổi hoặc đã bị xóa.');
      if (row.scope==='server') {
        const latest=server.get(row.id);
        if (latest && latest.connection_id && latest.connection_id===row.connection_id && latest.base_url===row.base_url && provider(latest)===slot.provider) continue;
        void reloadProfiles()?.catch(()=>{});
        throw new Error('Kết nối giọng nói đã đổi hoặc đã bị xóa.');
      }
      const profile=loaded.get(row.id) || await (replay ? VJProfiles.metadata(user,row.id) : VJProfiles.load(user,row.id));
      loaded.set(row.id,profile);
      if (roleKey()!==identity || signal?.aborted || provider(profile)!==slot.provider || profile.base_url!==row.base_url
        || profile.revision!==row.revision || !rowFor(slot)) {
        void reloadProfiles()?.catch(()=>{});
        throw new Error('Kết nối giọng nói đã đổi.');
      }
      if (replay) continue;
      result[name]={...slot,profile:{scope:'local',connection:{base_url:profile.base_url,api_key:profile.api_key}}};
    }
    return result;
  }
  function identity(config) {
    return JSON.stringify([roleKey(),config,...['primary','ja','vi'].flatMap(name=>{
      const slot=config[name];if (!slot?.profile) return [];
      const row=rowFor(slot);
      if (!row || metadataOwner!==owner()) throw new Error('Kết nối giọng nói đã đổi hoặc chưa tải.');
      return [fingerprint(row)];
    })]);
  }
  async function loadCatalog(slot) {
    if (busy) return;
    const control=controls.get(slot), role=roleKey();
    busy=true;control.catalog.disabled=true;
    try {
      const selection=selectedAccounts.get(slot);
      const selectedRef=effectiveAccount(slot);
      const row=rows.find(row=>ref(row)===selectedRef);
      if (!row) throw new Error('Chọn kết nối đã lưu cho '+titles[slot]+'.');
      const config={version:2,mode:'single',admin_override:admin(),primary:{profile:{scope:row.scope,id:row.id},provider:provider(row)}};
      const start=identity(config), cached=catalogs.get(slot);
      const all=cached?.identity===start ? cached : {identity:start,models:new Map(),voices:new Map()};
      status.textContent='Đang tải giọng và model. Không tạo âm thanh.';
      const routing=await prepared(config);
      const response=await apiFetch('/api/tts',{voiceRouting:true,method:'POST',headers:{'Content-Type':'application/json'},
        signal:AbortSignal.timeout(30000),body:JSON.stringify({action:'catalog',routing,...(all.cursor?{cursor:all.cursor}:{})})});
      const data=await response.json();
      if (role!==roleKey() || selection!==selectedAccounts.get(slot) || start!==identity(config)) return;
      if (!response.ok) throw new Error(data.detail || 'Không tải được giọng và model.');
      if (!Array.isArray(data.models) || !Array.isArray(data.voices)) throw new Error('Danh sách giọng không hợp lệ.');
      for (const row of data.models) all.models.set(row.id,row);
      for (const row of data.voices) all.voices.set(row.id,row);
      all.cursor=data.next_cursor;
      catalogs.set(slot,all);
      control.modelList.replaceChildren(...[...all.models.values()].map(row=>option(row.id,row.languages ? row.languages.join(' · ') : row.id)));
      control.voiceList.replaceChildren(...[...all.voices.values()].map(row=>option(row.id,row.name)));
      control.catalog.textContent=all.cursor?'Tải thêm giọng':'Tải giọng & model';
      status.textContent=`${all.models.size} model · ${all.voices.size} giọng${all.cursor?' · còn kết quả':''}. Chưa thử tạo âm thanh.`;
    } catch (error) {if (role===roleKey()) status.textContent=error.message;}
    finally {busy=false;control.catalog.disabled=false;}
  }
  function activeIdentity() {
    try {
      const config=stored();
      return config ? identity(config) : null;
    } catch {return null;}
  }
  const old=window.renderVoiceProfiles;
  window.renderVoiceProfiles=(user,data,canStore,platform,profilesLoaded=false)=>{
    old?.(user,data,canStore,platform);
    if (user!==owner() || admin() && !profilesLoaded) return;
    const previous=activeIdentity();
    metadataOwner=user;rows=data.filter(row=>Object.hasOwn(bases,provider(row)) && (row.protocol!=='openai' || [bases.openai,bases.mistral].includes(row.base_url)) && (row.protocol!=='gemini' || row.base_url===bases.gemini));
    el('storage').options[1].disabled=!canStore;
    if (drawnIdentity!==roleKey()) {drawnIdentity=roleKey();restore();} else {redrawAccounts();updateAccounts();}
    if (previous!==activeIdentity()) voiceChanged();
  };
  source.addEventListener('change',()=>{
    try {
      if (source.value==='legacy') {save(null);el('personal').hidden=true;status.textContent='Đã chọn nguồn giọng mặc định.';}
      else {el('personal').hidden=false;status.textContent='Chọn kết nối, rồi lưu cấu hình trước khi phát.';reloadProfiles();}
    } catch (error) {status.textContent=error.message;}
  });
  mode.addEventListener('change',()=>{layout();updateAccounts();});
  kind.addEventListener('change',()=>{url.placeholder=bases[kind.value] || 'https://tts.example.com/v1';url.required=kind.value==='openai_compatible';url.value='';});
  el('account').addEventListener('submit',async event=>{
    event.preventDefault();if (busy) return;
    const user=owner(), role=roleKey(), button=event.submitter;
    busy=true;if (button) button.disabled=true;
    try {
      const result=await window.saveVoiceProfile(user,{version:2,name:el('name').value.trim(),protocol:kind.value,
        base_url:url.value.trim() || undefined,api_key:el('key').value.trim()},el('storage').value);
      if (role!==roleKey()) return;
      if (!controls.get('primary').profile.value) controls.get('primary').profile.value=ref(result);
      updateAccounts();
      el('key').value='';status.textContent='Đã lưu kết nối. Chọn giọng và lưu cấu hình đọc.';
    } catch (error) {if (role===roleKey()) status.textContent=error.message;}
    finally {busy=false;if (button) button.disabled=false;}
  });
  el('remove').addEventListener('click',async()=>{
    if (busy) return;
    const row=rows.find(row=>ref(row)===controls.get('primary').profile.value);
    if (!row || row.model) {status.textContent='Chọn một kết nối giọng nói riêng để xóa.';return;}
    if (!window.confirm(`Xóa kết nối ${row.name}? Các cấu hình dùng kết nối này sẽ ngừng phát cho đến khi chọn lại.`)) return;
    const user=owner(), role=roleKey();
    busy=true;
    try {
      await window.removeVoiceProfile(user,row.scope,row.id);
      if (role===roleKey()) status.textContent='Đã xóa kết nối giọng nói. Chọn lại nếu cấu hình đang dùng kết nối này.';
    } catch (error) {if (role===roleKey()) status.textContent=error.message;}
    finally {busy=false;}
  });
  el('routing').addEventListener('submit',event=>{
    event.preventDefault();
    try {save(capture());status.textContent='Đã lưu cấu hình song ngữ.';}
    catch (error) {status.textContent=error.message;}
  });
  el('preview').addEventListener('click',()=>{
    try {
      const config=stored();
      if (!config || JSON.stringify(capture())!==JSON.stringify(config)) throw new Error('Lưu cấu hình trước khi nghe thử.');
      window.VJVoice.speak('Xin chào! こんにちは、いっしょに練習しましょう。',{preview:true});
    } catch (error) {status.textContent=error.message;}
  });
  el('settings').addEventListener('toggle',()=>{
    if (el('settings').open && source.value==='personal' && owner()) reloadProfiles();
  });
  window.addEventListener('vjbot-account-ready',()=>{
    if (drawnIdentity===roleKey()) return;
    metadataOwner=null;rows=[];catalogs.clear();el('key').value='';drawnIdentity=roleKey();restore();
    if (owner() && source.value==='personal') reloadProfiles();
  });
  window.addEventListener('storage',event=>{
    if (owner() && (event.key===prefix+owner() || event.key===null)) {
      restore();voiceChanged();
    }
  });
  window.VJVoiceRouting=Object.freeze({stored,prepared,identity});
  restore();
})();
