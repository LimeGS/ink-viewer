/* Keep floating panels anchored and refit only when the user is in Fit mode. */
(function(){
 const byId=id=>document.getElementById(id),root=document.documentElement;
 const toolbar=document.querySelector('.toolbar'),models=byId('modsWrap');
 let pending=0;
 function layout(){
  pending=0;
  root.style.setProperty('--toolbar-bottom',Math.ceil(toolbar.getBoundingClientRect().bottom+6)+'px');
  const top=byId('modsSum').getBoundingClientRect().top;
  root.style.setProperty('--models-bottom',Math.max(8,innerHeight-top+8)+'px');
  root.style.setProperty('--models-height',Math.max(40,Math.min(560,top-16))+'px');
  if(typeof fitted!=='undefined'&&fitted&&typeof fit==='function')fit();
  else if(typeof paint==='function')paint();
 }
 const schedule=()=>{if(!pending)pending=requestAnimationFrame(layout)};
 const observer=new ResizeObserver(schedule);
 [toolbar,byId('viewport'),document.querySelector('.depth')].forEach(el=>observer.observe(el));
 addEventListener('resize',schedule);
 const close=document.createElement('button');close.id='fxClose';close.textContent='Close filters ×';
 close.onclick=()=>{byId('filtrosBtn').click();byId('filtrosBtn').focus()};(byId('fxHeader')||byId('filtros')).append(close);
 document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||byId('super'))return;
  if(models?.open){models.open=false;byId('modsSum').focus()}
  else if(!byId('filtros').hidden)close.click();
 });
 byId('etiq').addEventListener('click',()=>{
  if(innerWidth<=900&&!byId('panel').hidden&&!byId('arbol').hidden)byId('carpetas').click();
 });
 schedule();
})();

/* Reparent label controls after every tool has registered its handlers. */
addEventListener(window.VISOR_STATIC?.readyEvent || 'DOMContentLoaded',()=>{
 const $=id=>document.getElementById(id),panel=$('panel'),groups=new Map();
 if(!panel||!$('htSec')||!$('gmSec')||!$('impFormato'))return;
 let nodes=[];groups.set('',{nodes});
 for(const el of [...panel.children]){
  if(el.tagName==='H3'){nodes=[];groups.set(el.textContent.trim().toLowerCase(),{heading:el,nodes})}
  else nodes.push(el);
 }
 const take=k=>{const g=groups.get(k);groups.delete(k);return g?.nodes||[]};
 const sections=document.createElement('div');sections.id='labelSections';panel.append(sections);
 const section=(id,title,nodes)=>{const d=document.createElement('details'),s=document.createElement('summary'),body=document.createElement('div');
  d.id=id;s.textContent=title;body.className='labelBody';body.append(...nodes);d.append(s,body);sections.append(d);return d};
 const header=document.createElement('div');header.id='labelHeader';
 const title=document.createElement('strong');title.textContent='Labeling';
 const close=document.createElement('button');close.type='button';close.textContent='×';close.title='Close labeling';close.setAttribute('aria-label','Close labeling');
 close.onclick=()=>{$('etiq').click();$('etiq').focus()};header.append(title,close);
 const brush=document.createElement('section');brush.id='labelBrush';brush.setAttribute('aria-label','Brush controls');brush.append(...take('brush'));panel.append(brush);
 const modes=document.createElement('div');modes.id='labelModes';
 ['mTinta','mNo','mBorrar','mRegion'].forEach(id=>{const b=$(id);b.type='button';modes.append(b)});brush.prepend(modes);
 ['sz','mkOp','htTol','htTb','htTa'].forEach(id=>$(id).closest('label').classList.add('labelSlider'));
 const valueTools=section('labelValues','Value tools',take('value tools'));
 section('labelGuides','Lines & measurements',take('lines and measurements'));
 section('labelSupervision','Supervision',take('supervision'));
 const layers=section('labelDisplay','Layers & colours',take('kit layers'));layers.lastElementChild.append($('etiqColores'));
 const files=section('labelFiles','Mask files',take('saved'));
 const fileBody=files.lastElementChild;
 const format=document.createElement('label');format.className='labelFormat';format.append('PNG format',$('impFormato'));
 const imports=document.createElement('div');imports.className='fila';imports.append($('imp'),$('htCargar'));
 const exports=document.createElement('div');exports.className='fila';exports.append($('verPng'));
 if(!window.VISOR_STATIC)exports.append($('guardarTodasMascaras'));
 fileBody.prepend(format,imports,$('impProp'),exports);
 const jsonActions=document.createElement('div');jsonActions.className='fila';jsonActions.append($('copJson'),$('pegJson'));
 const json=section('labelJson','Mask JSON',[jsonActions,$('ta')]);fileBody.append(json);
 const metaHeading=groups.get('holdout metadata')?.heading,runHeading=groups.get('mask run')?.heading;
 const metadata=section('labelMetadata','Metadata & statistics',[
  ...[metaHeading].filter(Boolean),...take('holdout metadata'),...[runHeading].filter(Boolean),...take('mask run')]);
 section('labelShortcuts','Shortcuts',take('shortcuts'));
 // Keep any ungrouped controls; only empty layout rows are removed.
 for(const {heading,nodes} of groups.values())sections.append(...[heading].filter(Boolean),...nodes);
 const warnings=document.createElement('div');warnings.id='labelWarnings';warnings.setAttribute('role','status');warnings.hidden=true;
 const footer=document.createElement('div');footer.id='labelFooter';
 const actions=document.createElement('div');actions.className='fila';if(!window.VISOR_STATIC)actions.append($('guardarMascaraServidor'));actions.append($('exp'));
 const storage=document.createElement('small');storage.hidden=!!window.VISOR_STATIC;storage.textContent=visorPuedeGuardar?'Inklabels + supervision PNGs':'Read-only annotation storage';
 const status=document.createElement('div');status.id='labelStatus';status.setAttribute('role','status');
 ['msg','htCorridaEst','htEstado','gmEstado'].forEach(id=>{const e=$(id);if(e)status.append(e)});
 footer.append(actions,storage,status);panel.replaceChildren(header,$('htPend'),warnings,brush,sections,footer);panel.classList.add('labelCompact');
 panel.querySelectorAll('.fila:empty').forEach(e=>e.remove());
 const reveal=()=>{if(!$('htPrevBox').hidden||!$('htConf').hidden)valueTools.open=true;
  const text=[...$('htCorrida').querySelectorAll('.htAviso')].map(e=>e.textContent).join('\n');
  warnings.textContent=text;warnings.hidden=!text};
 new MutationObserver(reveal).observe($('htSec'),{subtree:true,attributes:true,attributeFilter:['hidden']});
 new MutationObserver(reveal).observe($('htCorrida'),{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});
 const syncModes=()=>modes.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.classList.contains('on'))));
 new MutationObserver(syncModes).observe(modes,{subtree:true,attributes:true,attributeFilter:['class']});syncModes();reveal();
},{once:true});
