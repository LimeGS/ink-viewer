/* ===== UI layout + Simple/Advanced modes (12-Sep-2026) =====
   Regroups the toolbar into labelled clusters (Explorer · View · Image · Actions) without renaming any id, so
   every module keeps its hooks. One global mode, persisted:
     Simple   - image filters show 6 curated presets. (The explorer is NOT affected: its filters are always visible.)
     Advanced - every image slider and preset group. */
(function(){
 const $=id=>document.getElementById(id);const KEY='vesuvius.ui.modo';
 let modo=localStorage.getItem(KEY)||'advanced';
 /* 14-sep: the user asked for the pro filters back by default. Migrate a stored 'simple' once. */
 try{if(!localStorage.getItem(KEY+'.adv14')){modo='advanced';localStorage.setItem(KEY,'advanced');localStorage.setItem(KEY+'.adv14','1')}}catch(e){}
 const st=document.createElement('style');st.textContent=
  '.toolbar{gap:6px 0;padding:6px 12px}.tbg{display:flex;align-items:center;gap:5px;padding:2px 12px 2px 0;margin-right:12px;border-right:1px solid #263342}'+
  '.tbg:last-child{border:0;margin:0 0 0 auto;padding-right:0}.tbg .tbl{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-right:4px;user-select:none}'+
  '#uiModo{display:inline-flex;border:1px solid #344254;border-radius:12px;overflow:hidden}#uiModo button{border:0;border-radius:0;padding:2px 9px;font-size:11px;background:#0f151d}#uiModo button.on{background:#124a3a;color:#c6f2e2}'+
  'body.ui-simple #fxAdvanced,body.ui-simple #fxPresetSection{display:none!important}#fxSimple{display:flex;flex-wrap:wrap;gap:6px;align-items:center}#fxSimple .tbl{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.5}'+
  'body.ui-adv #fxSimple{display:none!important}'+
  '#arbol:not([hidden]){display:flex;flex-direction:column}#xp{flex:1 1 auto;min-height:0}#xpList{flex:1 1 auto;min-height:0;overflow:auto}#xp .lnk{color:#86dcd5;cursor:pointer;font-size:11px;margin-left:auto}';
 document.head.append(st);
 /* toolbar groups */
 const tb=document.querySelector('.toolbar');if(!tb)return;
 const G=(label,ids)=>{const g=document.createElement('div');g.className='tbg';if(label){const l=document.createElement('span');l.className='tbl';l.textContent=label;g.append(l)}
  ids.forEach(id=>{const e=$(id);if(e)g.append(e)});return g};
 const toggle=document.createElement('span');toggle.id='uiModo';toggle.title='Image filters only. Simple: curated presets. Advanced: every slider and preset group. The explorer filters are always visible.';
 ['simple','advanced'].forEach(m=>{const b=document.createElement('button');b.textContent=m==='simple'?'Simple':'Advanced';b.dataset.m=m;b.onclick=()=>setModo(m);toggle.append(b)});
 const carp=$('carpetas');if(carp)carp.textContent='Explorer';
 const groups=[G('',['carpetas']),G('view',['fit','native','minus','zoom','plus']),G('image',['hdBtn','render','max','superBtn','super','filtrosBtn']),G('',['etiq','download'])];

 [...tb.querySelectorAll('.separator')].forEach(s=>s.remove());
 groups.forEach(g=>tb.append(g));
 /* explorer: which rows are advanced (the explorer re-renders its rows, so re-mark on every mutation) */
 const xp=$('xp');const SIMPLE_PRE=/^(Submission|Training pool|Most legible|Repaired|Clear)$/;
 function marcarXp(){if(!xp)return;
  [...xp.querySelectorAll(':scope>.row')].forEach(r=>{const t=r.textContent.trim();r.classList.toggle('xpAdv',/Cert|cm²|^z|repaired/.test(t)&&!/Submission|\bof\b/.test(t))});
  xp.querySelectorAll('.pre').forEach(b=>b.classList.toggle('xpAdv',!SIMPLE_PRE.test(b.textContent.trim())&&b.id!=='xpDir'));
  const pr=[...xp.querySelectorAll(':scope>.row')].find(r=>/Submission/.test(r.textContent));
  if(pr&&!pr.querySelector('.lnk')){const a=document.createElement('span');a.className='lnk';a.onclick=()=>setModo(modo==='simple'?'advanced':'simple');pr.append(a)}
  xp.querySelectorAll('.lnk').forEach(a=>a.textContent=modo==='simple'?'Advanced ▸':'◂ Simple')}
 /* 14-sep: the mode never touches the explorer; its filters are always visible */
 /* Super belongs immediately before Filters, including when loaded later. */
 new MutationObserver(()=>{[...tb.children].forEach(c=>{if(!c.classList.contains('tbg')){if(c.id==='super'||c.id==='superBtn')groups[2].insertBefore(c,$('filtrosBtn'));else groups[3].append(c)}})}).observe(tb,{childList:true});
 /* image filters: curated simple row */
 const P=$('filtros');
 if(P){const row=document.createElement('div');row.id='fxSimple';const l=document.createElement('span');l.className='tbl';l.textContent='presets';row.append(l);
  /* simple = exclusive: one preset on the single large view (no panes), never additive */
  const aplicar=fx=>{PANES=[];const ab=FX.abierto;FX=Object.assign({},FXDEF,fx,{abierto:ab});fxGuardar();fxAUI();fxPedir();
   if(window.defsPanes)defsPanes();if(window.pintarPanes)pintarPanes();if(window.fxPintarPresets)fxPintarPresets();if(typeof fit==='function')fit()};
  const marcar=b=>row.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
  ['Raw','Auto levels','S-curve','High-pass','Inverted high-pass','Viridis'].forEach(t=>{const b=document.createElement('button');b.textContent=t;b.onclick=()=>{
   const pr=(window.FXPRESETS||FXPRESETS).find(z=>z.t===t);if(!pr)return;aplicar(pr.fx);marcar(b)};row.append(b)});
  const rs=document.createElement('button');rs.id='fxSimpleReset';rs.textContent='Reset view';rs.title='Unfiltered view: every filter neutral, no panes';rs.style.marginLeft='8px';
  rs.onclick=()=>{aplicar({});marcar(null)};row.append(rs);
  const adv=document.createElement('span');adv.className='lnk';adv.style.cssText='color:#86dcd5;cursor:pointer;font-size:11px;margin-left:auto';adv.textContent='Advanced ▸';adv.onclick=()=>setModo('advanced');row.append(adv);
  P.prepend(row)}
 // Reparent the existing controls: keep their listeners, values and IDs intact.
 if(P){
  const head=document.createElement('div');head.id='fxHeader';
  const title=document.createElement('strong');title.textContent='Image filters';
  const source=document.createElement('label');source.className='fxSource';source.append('Contrast source ', $('contrast'));
  $('fReset').textContent='Reset filters';
  head.append(title,source,toggle);P.prepend(head);
  const presets=document.createElement('section');presets.id='fxPresetSection';
  const preset=document.createElement('select');preset.id='fxPresetSelect';preset.setAttribute('aria-label','Apply filter preset');
  preset.append(new Option('Apply preset…',''));
  let presetGroup;
  FXPRESETS.forEach(p=>{if(!presetGroup||presetGroup.label!==p.g){presetGroup=document.createElement('optgroup');presetGroup.label=p.g; preset.append(presetGroup)}presetGroup.append(new Option(p.t,p.t))});
  preset.onchange=()=>{const name=preset.value;preset.value='';[...$('fxPresets').querySelectorAll('button')].find(b=>b.textContent===name)?.click()};
  $('fxPresets').hidden=true;presets.append(preset,$('fxPresets'));head.append(presets,$('fReset'));
  const advanced=$('filtrosPro');advanced.id='fxAdvanced';advanced.removeAttribute('style');advanced.hidden=false;
  const tabs=document.createElement('div');tabs.id='fxTabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Filter controls');advanced.append(tabs);
  const sections=[
   ['Tone',['fGamma','fBrillo','fContraste','fCurva','fCentro']],
   ['Levels',['fNegro','fBlanco','fAuto','fxHist']],
   ['Detail & edges',['fLocal','fRadio','fPasaalto','fDog','fBorde']],
   ['Color & threshold',['fPaleta','fInvertir','fUmbral','fPoster']],
   ['Compare with original',['fMezcla','fBlink']]
  ];
  const cards=[];
  const selectTab=index=>{cards.forEach((card,i)=>{const selected=i===index;card.hidden=!selected;const tab=tabs.children[i];tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1})};
  for(const [index,[name,ids]] of sections.entries()){
   const card=document.createElement('section');card.className='fxCard';card.id='fxControls'+index;card.setAttribute('role','tabpanel');card.setAttribute('aria-labelledby','fxTab'+index);
   const tab=document.createElement('button');tab.type='button';tab.id='fxTab'+index;tab.textContent=name;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',card.id);
   tab.onclick=()=>selectTab(index);tabs.append(tab);cards.push(card);
   for(const id of ids){const el=$(id);if(el)card.append(el.closest('label')||el)}
   for(const id of ['fPasaalto','fDog'])card.querySelector('#'+id)?.closest('label').classList.add('fxWide');
   advanced.append(card);
  }
  selectTab(0);
  tabs.onkeydown=e=>{let index=[...tabs.children].indexOf(document.activeElement);if(index<0)return;
   if(e.key==='ArrowRight')index=(index+1)%cards.length;else if(e.key==='ArrowLeft')index=(index+cards.length-1)%cards.length;
   else if(e.key==='Home')index=0;else if(e.key==='End')index=cards.length-1;else return;
   e.preventDefault();selectTab(index);tabs.children[index].focus()};
  advanced.querySelectorAll(':scope>.sep').forEach(el=>el.remove());
  $('fxBar').append($('fEstado'));P.append(advanced,$('fxBar'));
  P.querySelectorAll(':scope>.sep').forEach(el=>el.remove());
 }
 function setModo(m){modo=m;localStorage.setItem(KEY,m);document.body.classList.toggle('ui-simple',m==='simple');document.body.classList.toggle('ui-adv',m!=='simple');
  toggle.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));if(typeof marcarXp==='function')marcarXp()}
 setModo(modo);console.log('ui_modos: '+modo);
})();
