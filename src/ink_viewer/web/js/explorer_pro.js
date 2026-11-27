/* ===== Explorer "List" mode (12-Sep-2026) =====
   A flat, sortable, filterable list of laminae built for working sessions: one search box, gate
   selectors (any / pass / fail / unmeasured), numeric ranges typed as numbers (area, v5, isometry, z, CT %), flags (repaired,
   piece, labelled, starred, 17 centres), sort by any column, one-click presets that just SET the controls
   (so they stay editable), stars and "seen" persisted, j/k to move, Enter to open. The folder tree stays
   available behind the "Tree" button. Reads the viewer's own data (LAM, CG, LEG, MSK) - nothing duplicated. */
(function(){
 if(typeof LAM==='undefined'||typeof irA!=='function'){console.warn('explorer_pro: viewer globals missing');return}
 let OBJ=null,EXCL={},PROPS=new Set();if (!window.VISOR_STATIC) fetch('/api/propuestas',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(l=>{PROPS=new Set(l);pintar()}).catch(()=>{});
let MASC=new Set();(globalThis.visorFetchData || fetch)('mascaras.json',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(l=>{MASC=new Set(l);pintar()}).catch(()=>{});
(globalThis.visorFetchData || fetch)('objetivo.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{if(d){OBJ=d.objetivo;EXCL=d.excluir||{};pintar()}}).catch(()=>{});
 const CKEY='vesuvius.explorer.cols.v1';
 /* 16-sep: star, name(flexible), cm2, v5, gates. Defaults fit one line at the panel's own width. */
 const CDEF=[14,46,40,88];let COLS=CDEF.slice();
 try{const v=JSON.parse(localStorage.getItem(CKEY)||'null');if(Array.isArray(v)&&v.length===4)COLS=v.map(Number)}catch(e){}
 const colsCss=()=>{const r=document.documentElement.style;COLS.forEach((w,i)=>r.setProperty('--xpc'+i,w+'px'))};
 const colsSave=()=>{try{localStorage.setItem(CKEY,JSON.stringify(COLS))}catch(e){}};
 const KEY=visorKey('vesuvius.explorer.v1'),SKEY=visorKey('vesuvius.stars.v1'),VKEY=visorKey('vesuvius.seen.v1');
 const DEF={q:'',rollo:'',cert:'',valid:'',ct:'',flat:'',cont:'',a4:'',amin:'',amax:'',v5min:'',v5max:'',isomax:'',zmin:'',zmax:'',ctmin:'',c17:false,rep:'',piece:'',lab:'',star:'',unseen:false,sort:'area_v5',desc:true,modo:'list',v5m:'',thumbs:true};
 let F=Object.assign({},DEF);try{Object.assign(F,JSON.parse(localStorage.getItem(KEY)||'{}'))}catch(e){}
 try{if(!localStorage.getItem(KEY+'.list14')){F.modo='list';localStorage.setItem(KEY+'.list14','1')}}catch(e){}   /* 12-sep: land on the List explorer once after the Tree/List fix; Tree stays one click away */
 try{if(!localStorage.getItem(KEY+'.area-v5-20260920')){F.sort='area_v5';F.desc=true;localStorage.setItem(KEY+'.area-v5-20260920','1')}}catch(e){}
 let STARS=new Set(),SEEN={};try{STARS=new Set(JSON.parse(localStorage.getItem(SKEY)||'[]'));SEEN=JSON.parse(localStorage.getItem(VKEY)||'{}')}catch(e){}
 /* 24-sep: rows are segments; stars and "seen" were kept per lamina: carry them to the segment row */
 {const f=k=>(typeof FILA_DE_HOJA!=='undefined'&&FILA_DE_HOJA[k])||k;STARS=new Set([...STARS].map(f));
  for(const k of Object.keys(SEEN)){const r=f(k);if(r!==k){SEEN[r]=Math.max(SEEN[r]||0,SEEN[k]);delete SEEN[k]}}}
 const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(F));localStorage.setItem(SKEY,JSON.stringify([...STARS]));localStorage.setItem(VKEY,JSON.stringify(SEEN))}catch(e){}};
 /* ---- one record per lamina, from the viewer's data ---- */
 const tri=v=>v===true?'pass':v===false?'fail':'';
 function fila(e){const hs=[e.lam,...(e.hojas||[]).filter(h=>h!==e.lam)],g=(typeof CG!=='undefined'&&CG[e.lam])||{},l=(typeof LEG!=='undefined'&&LEG[e.lam])||null;
  const est=g.estado_inv||e.est||'';const cert=Object.hasOwn(g,'geometry_ok')?g.geometry_ok:est?est!=='sin certificar':null;const valid=Object.hasOwn(g,'physical_ok')?g.physical_ok:est==='cert+valida'?true:est==='certificada'?false:null;
  const cm=g.cm2!=null?+g.cm2:e.cm;const z=(()=>{const m=/z≈\s*(\d+)/.exec(e.z||'');return m?+m[1]:null})();
  const cont=(g.continuidad||{}).veredicto;const nc=Math.max(...e.items.map(it=>Object.keys(manifest[it.i].frames||{}).length));
  /* labelled = a mask painted in this browser (MSK) OR one exported to disk (mascaras.json) */
  const lab=hs.some(h=>MASC.has(h)||LABS.has(h))||e.items.some(it=>manifest[it.i].maskAvailable===true);
  return{e,lam:e.lam,hs,cm,z,cert,valid,meshQuality:g.mesh_quality||null,ct:g.ct_ok==null?null:!!g.ct_ok,flat:g.plano_ok==null?null:!!g.plano_ok,cont:cont==null?null:cont==='PASA',
   a4:cm==null?null:cm>=4,iso:g.iso_ventana_pct!=null?+g.iso_ventana_pct:(g.iso_f!=null?Math.max(+g.iso_f,+g.iso_c||0):(g.iso_pct!=null?+g.iso_pct:null)),isoV:g.iso_ventana_pct!=null?+g.iso_ventana_pct:null,ctp:g.frac_ct!=null?+g.frac_ct*100:null,...v5De(e,l),
   nc,rollo:e.scroll?e.scroll.replace(/^PHerc/,''):(m=>m?m[1]:ROLLO_CORTO)(hs.map(h=>/^(?:crec|PHerc)?(1218|0306B|0800)(?:_|$)/.exec(h)).find(Boolean)),rep:hs.some(h=>/_B100$/.test(h)),piece:hs.some(h=>/_p\d+_B100/.test(h)),lab,star:STARS.has(e.lam),seen:!!SEEN[e.lam]}}
 /* 27-sep: v5 por modelo (campana_fl22: por_modelo y pct en LEG_V5M). F.v5m '' = como antes (el mejor de la fila);
    base / ra_congelado / r3f_evo = el max de ese modelo; pct = el mayor percentil dentro de (rollo, modelo), como fraccion. */
 function v5De(e,l){const N={v5:null,v5c:null,v5p:null,v5m:null},P=o=>o&&(o.pct??o.pct_rollo_modelo)!=null?+(o.pct??o.pct_rollo_modelo):null,
  x=(typeof LEG_V5M!=='undefined'&&LEG_V5M[e.lam])||l,pm=x&&x.por_modelo;
  if(!F.v5m)return l&&Number.isFinite(+l.max)?{v5:+l.max,v5c:l.mejor_centro,v5p:P(l),v5m:l.modelo||null}:N;
  if(!pm)return N;
  if(F.v5m==='pct'){let b=null;for(const [m,y] of Object.entries(pm)){const p=P(y);if(p!=null&&(!b||p>b.v5p))b={v5:p/100,v5c:0,v5p:p,v5m:m}}return b||N}
  const y=pm[F.v5m];return y&&Number.isFinite(+y.max)?{v5:+y.max,v5c:0,v5p:P(y),v5m:F.v5m}:N}
 const okTri=(f,v)=>f===''||(f==='pass'?v===true:f==='fail'?v===false:f==='unm'?v==null:true);
 const okFlag=(f,v)=>f===''||(f==='yes'?v:!v);
 function filtrar(rows){const q=F.q.trim().toLowerCase();return rows.filter(r=>{
  if(F.rollo&&r.rollo!==F.rollo)return false;
  if(q&&!(r.hs.some(h=>h.toLowerCase().includes(q))||(r.e.fam||'').toLowerCase().includes(q)))return false;
  if(!okTri(F.cert,r.cert)||!okTri(F.valid,r.valid)||!okTri(F.ct,r.ct)||!okTri(F.flat,r.flat)||!okTri(F.cont,r.cont)||!okTri(F.a4,r.a4))return false;
  if(F.amin!==''&&!(r.cm!=null&&r.cm>=+F.amin))return false;if(F.amax!==''&&!(r.cm!=null&&r.cm<=+F.amax))return false;
  if(F.v5min!==''&&!(r.v5!=null&&r.v5>=+F.v5min))return false;if(F.v5max!==''&&!(r.v5!=null&&r.v5<=+F.v5max))return false;if(F.isomax!==''&&!(r.iso!=null&&r.iso<=+F.isomax))return false;
  if(F.zmin!==''&&!(r.z!=null&&r.z>=+F.zmin))return false;if(F.zmax!==''&&!(r.z!=null&&r.z<=+F.zmax))return false;
  if(F.ctmin!==''&&!(r.ctp!=null&&r.ctp>=+F.ctmin))return false;if(F.c17&&r.nc<17)return false;
  if(!okFlag(F.rep,r.rep)||!okFlag(F.piece,r.piece)||!okFlag(F.lab,r.lab)||!okFlag(F.star,r.star))return false;if(F.unseen&&r.seen)return false;return true})}
 const ORD={sizescore:r=>(r.cm??0)*(r.v5??-1),area:r=>r.cm??-1,v5:r=>r.v5??-1,iso:r=>r.iso??1e9,z:r=>r.z??-1,name:r=>r.lam,ct:r=>r.ctp??-1};
 function ordenar(rows){if(F.sort==='area_v5')return rows.sort((a,b)=>{for(const key of ['cm','v5']){const x=a[key],y=b[key],vx=Number.isFinite(x),vy=Number.isFinite(y);if(vx!==vy)return vx?-1:1;if(vx&&x!==y)return F.desc?y-x:x-y}return a.lam.localeCompare(b.lam)});const k=ORD[F.sort]||ORD.area;rows.sort((a,b)=>{const x=k(a),y=k(b);return typeof x==='string'?x.localeCompare(y):x-y});if(F.desc)rows.reverse();return rows}
 /* ---- presets: they SET the controls, nothing hidden ---- */
 const PRE=[['Submission',{cert:'pass',valid:'pass',ct:'pass',flat:'pass',cont:'pass',a4:'pass',sort:'area',desc:true},'All gates pass and area >= 4 cm2: the First Letters bar'],
  ["Submission (validity unmeasured)",{cert:'pass',valid:'',ct:'pass',flat:'pass',cont:'pass',a4:'pass',sort:'area',desc:true},"All five measured gates pass and area ≥ 4 cm², without requiring validity. Shows segments blocked only by unmeasured validity, not a failed gate."],
  ['Training pool',{cert:'pass',valid:'pass',ct:'pass',flat:'pass',cont:'pass',a4:'',sort:'area',desc:true},'All physical gates pass, any area'],
  ['Only area missing',{cert:'pass',valid:'pass',ct:'pass',flat:'pass',cont:'pass',a4:'fail',sort:'area',desc:true},'Clean but under 4 cm2: grow or stitch'],
  ['To re-flatten',{cert:'pass',valid:'pass',ct:'pass',flat:'fail',isomax:'5',sort:'iso',desc:false},'Certified, CT ok, flattening 2-5 %: usually recovered with flatboi'],
  ['Most legible',{v5min:'0.2',sort:'v5',desc:true},'v5 legibility index >= 0.2 (uncalibrated ranking)'],
  ['With a mask',{lab:'yes',sort:'area',desc:true},'Laminae with at least one mask: painted in this browser or exported to disk (mascaras.json)'],['Starred',{star:'yes'},'Your stars'],['Repaired',{rep:'yes',sort:'area',desc:true},'_B100 versions (re-flattened / cut pieces)'],
  ['Clear',{},'Reset every filter']];
 /* ---- DOM ---- */
 const aside=$('arbol');const panel=document.createElement('div');panel.id='xp';panel.hidden=false;
 const st=document.createElement('style');st.textContent=
  '#xp{display:flex;flex-direction:column;gap:6px;padding:4px 6px;font:12px system-ui,sans-serif;color:#c9d6e2;flex:1 1 auto;min-height:0}'+
  '#xp .row{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}#xp input[type=text],#xp input[type=number],#xp select{background:#0b1016;color:#c9d6e2;border:1px solid #344254;border-radius:4px;padding:2px 5px;font:inherit}'+
  '#xp input[type=number]{width:58px}#xp input.on,#xp select.pass{background:#124a3a;border-color:#2d8a6d}#xp select.fail{background:#4a1c1c;border-color:#8a3d3d}#xp select.unm{background:#2a2f3a;border-color:#5a6170}#xp select.yes{background:#123a4a;border-color:#2d6d8a}'+
  '#xp .tally{display:block;line-height:1.4;font-size:11px}'+
  '#xp .pre{background:#141c26;border:1px solid #344254;border-radius:4px;padding:2px 8px;cursor:pointer}#xp .pre:hover{border-color:#86dcd5}#xp .lbl{opacity:.6}'+
  '#arbol.xpTree #xp{flex:0 0 auto;min-height:auto;overflow:visible}'+
  '#arbol.xpTree #tree{flex:1 1 auto;min-height:0;overflow:auto}'+
  '#xp{overflow:hidden}'+
  '#xpList{flex:1 1 auto;min-height:0;overflow:auto;border-top:1px solid #1e2a38}#xpList .r,#xpHead{display:grid;grid-template-columns:var(--xpc0) minmax(0,1fr) var(--xpc1) var(--xpc2) var(--xpc3);gap:4px;align-items:center;padding:2px 4px}#xpList .r{height:26px;box-sizing:border-box;line-height:20px;cursor:pointer;border-bottom:1px solid #121a24}#xpHead{position:sticky;top:0;z-index:2;background:#0c131b;border-bottom:1px solid #2b3a4b;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8fa2b6;user-select:none}#xpHead span{position:relative;overflow:hidden;white-space:nowrap}#xpHead i.hh{position:absolute;left:-4px;top:-3px;bottom:-3px;width:7px;cursor:col-resize}#xpHead i.hh:hover{background:#60d4c655}#xpList .g{white-space:nowrap}'+
  '#xpList .r:hover{background:#141c26}#xpList .r.sel{background:#173a36;outline:1px solid #2d8a6d}#xpList .r.seen .n{opacity:.7}#xpList .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#xpList .g{letter-spacing:0;font-size:11px;font-weight:600}#xpList .g b{color:#4ade80;font-weight:700}#xpList .g s{color:#f87171;text-decoration:line-through;text-decoration-thickness:1px}#xpList .g u{color:#95a2b3;text-decoration:underline;text-decoration-style:dotted}'+
  '#xpList .r.sub{color:#9fb3c8}#xpList .r.sub .n{padding-left:14px}#xpList .tg{color:#86dcd5;cursor:pointer;font-size:10px}'+'#xpList .star{color:#556;cursor:pointer}#xpList .star.on{color:#ffb347}#xp .num{text-align:right;opacity:.9}';
 document.head.append(st);
 st.textContent+='#xpList .r.th{height:var(--xpth);align-items:start;grid-template-rows:20px 1fr}#xpList .thumbs{grid-column:2/-1;grid-row:2;display:flex;gap:6px;min-width:0;height:calc(var(--xpth) - 30px)}#xpList .thumbs figure{flex:1;min-width:0;margin:0;display:flex;flex-direction:column}#xpList .thumbs figcaption{font-size:11px;height:18px;color:#9eb4c4}#xpList .r.th img.th{height:calc(100% - 18px);width:100%;object-fit:contain;object-position:left center;background:#05080c;border:1px solid #1e2a38;border-radius:3px}';
 /* 16-sep: one table for the chip word, the row badge and the tally, so the badge letter is always the
    initial of the word on the chip. Before: chips said Cert/Flat/≥4cm² while the badges said G/P/A. */
 const GATES=[['cert','Geom','G','geometric certification: no seam, interpenetration or fold-back'],
  ['valid','Valid','V','validity against CT and prior: CT peak within ±2 voxels of the centre'],
  ['ct','CT','CT','CT beneath: ≥95 % of the geometry covered by the published volume'],
  ['flat','Flat','F','flattening distortion: isometry p95 ≤ 2 % and shear ≤ 0.05'],
  ['cont','Cont','C','parametrisation continuity: no jumps between neighbouring cells'],
  ['a4','Area','A','area ≥ 4 cm², the First Letters bar (a submission gate, not a training one)']];
 const chips=GATES.map(([k,n])=>[k,n]);const flags=[['rep','repaired'],['piece','piece'],['lab','mask'],['star','★']];
 panel.innerHTML='<div class="row" id="xpSearch"><input type="search" id="xpQ" placeholder="Search segment, lamina or family" aria-label="Search segments" autocomplete="off"><select id="xpRollo" aria-label="Scroll"><option value="">All scrolls</option>'+[...new Set([ROLLO_CORTO,'1218','0306B','0800'])].map(r=>'<option value="'+r+'">'+r+'</option>').join('')+'</select></div>'+
  '<div class="row" id="xpOrder"><label>Sort <select id="xpSort"><option value="area_v5">Area, then v5</option><option value="area">Area</option><option value="sizescore">Size × score</option><option value="v5">v5</option><option value="iso">Isometry</option><option value="z">z</option><option value="ct">CT %</option><option value="name">Name</option></select></label><button id="xpDir" class="pre" aria-label="Reverse sort direction">↓</button><label>v5 <select id="xpV5m" title="Which v5 feeds the column, filter and sorting. Percentiles are within scroll and model. v5 R2B is experimental: ranking, not certification."><option value="">Best run</option><option value="base">BASE</option><option value="ra_congelado">R-A congelado</option><option value="r3f">r3f</option><option value="r3f_evo">r3f-evo (R-D)</option><option value="pct">Percentile</option></select></label></div>'+
  '<div id="xpControls"><div class="row" id="xpPre"><select id="xpPreset" aria-label="Apply explorer preset"><option value="">Apply preset…</option>'+PRE.slice(0,-1).map(([t,,d],i)=>'<option value="'+i+'" title="'+d+'">'+t+'</option>').join('')+'</select><button id="xpClear" class="pre">Clear</button></div><div id="xpActive" class="row" aria-label="Active filters" hidden></div>'+
  '<div class="xpSections"><details id="xpFilters"><summary>Filters <span id="xpFilterCount"></span></summary><div class="xpFilterBody"><fieldset><legend>Quality gates</legend><div id="xpChips" class="xpFields"></div></fieldset>'+
  '<fieldset><legend>Numeric ranges</legend><div class="xpRanges"><label>Area (cm²) <input type="number" id="xpAmin" aria-label="Minimum area in square centimetres" placeholder="min" step="0.1"><input type="number" id="xpAmax" aria-label="Maximum area in square centimetres" placeholder="max" step="0.1"></label><label>v5 score <input type="number" id="xpV5" aria-label="Minimum v5 score" placeholder="min" step="0.01"><input type="number" id="xpV5max" aria-label="Maximum v5 score" placeholder="max" step="0.05"></label><label>Depth z <input type="number" id="xpZmin" aria-label="Minimum z" placeholder="min" step="100"><input type="number" id="xpZmax" aria-label="Maximum z" placeholder="max" step="100"></label><label>Isometry ≤ % <input type="number" id="xpIso" aria-label="Maximum isometry percentage" placeholder="2" step="0.1"></label><label>CT coverage ≥ % <input type="number" id="xpCt" aria-label="Minimum CT coverage percentage" placeholder="95" step="1"></label></div></fieldset>'+
  '<fieldset><legend>Annotations & status</legend><div id="xpFlags" class="xpFields"></div><div class="row xpChecks"><label><input type="checkbox" id="xpC17"> 17 centres</label><label><input type="checkbox" id="xpUnseen"> Unseen</label></div></fieldset></div></details>'+
  '<details id="xpStats"><summary>Data & counts</summary><div class="row xpChecks"><label title="Also list series whose mesh association is unverified. Reloads the page."><input type="checkbox" id="xpSinVer"> Unverified meshes</label><button id="xpWarm" class="pre" title="Download every depth of the listed segments into the proxy cache. Click again to stop.">Warm cache</button></div><div id="xpTally" class="tally"></div></details></div></div>'+
  '<div class="row" id="xpResults"><b id="xpCount"></b><span class="lbl" id="xpHint">j/k move · Enter open · s star</span></div><div id="xpHead"><span></span><span>segment</span><span class="num"><i class="hh" data-c="1"></i>cm²</span><span class="num"><i class="hh" data-c="2"></i>v5</span><span><i class="hh" data-c="3"></i>gates</span></div><div id="xpList"></div>';
 const bThumb=document.createElement('button');bThumb.id='xpThumbs';bThumb.className='pre';bThumb.textContent='Thumbnails';
 bThumb.title='Show segment thumbnails (r3f, then R-A congelado, then BASE; fixed contrast, nearest to c+00)';
 const vista=$('vista'),view=document.createElement('select');view.id='xpView';view.setAttribute('aria-label','Explorer view');
 const viewButtons={mod:'vModelo',zona:'vZona',malla:'vMalla',pos:'vPos'};
 [['list','Segments'],['mod','By model'],['zona','By zone'],['malla','By mesh'],['pos','By position']].forEach(([v,t])=>{const o=new Option(t,v);o.title=v==='list'?'Flat, sortable segment list':$(viewButtons[v]).title;view.add(o)});
 const syncView=()=>{view.value=F.modo==='list'?'list':vistaModo;view.title=view.selectedOptions[0]?.title||''};
 const viewLabel=document.createElement('label');viewLabel.append('View ',view);
 const bTree=document.createElement('button');bTree.id='xpToggle';bTree.hidden=true;
 if(vista){[...vista.children].forEach(b=>b.hidden=true);vista.prepend(viewLabel,bThumb);vista.append(bTree)}
 view.onchange=()=>{if(view.value==='list')modo('list');else $(viewButtons[view.value]).click()};
 new MutationObserver(syncView).observe(vista,{subtree:true,attributes:true,attributeFilter:['aria-pressed']});
 const tree=$('tree');const ocultos=['etapasFiltro','etapasBtns','etapasInfo','etapasVisible','buscar'].map(id=>$(id)).filter(Boolean);
 tree.parentNode.insertBefore(panel,tree);
 /* Shared controls apply to both the segment list and every tree grouping.
    The original tree-only filters stay retired. */
 function modo(m){F.modo=m;save();const list=m==='list';panel.hidden=false;panel.style.display='';
  const roll=$('xpRollo');for(const name of [...new Set([...LAM.values()].map(e=>fila(e).rollo))].sort()){if(![...roll.options].some(o=>o.value===name))roll.add(new Option(name==='unknown'?'unidentified scroll':name,name))}
  const xl=$('xpList');if(xl){xl.hidden=!list;xl.style.display=list?'':'none'}
  const hd=$('xpHead');if(hd){hd.hidden=!list;hd.style.display=list?'':'none'}
  aside.classList.toggle('xpTree',!list);
  tree.hidden=list;tree.style.display=list?'none':'';if(list)tree.replaceChildren();ocultos.forEach(e=>{e.hidden=true;e.style.display='none'});bTree.textContent=list?'Tree':'List';pintar()}
 $('xpList').tabIndex=0;$('xpList').setAttribute('aria-label','Segments');
 colsCss();
 $('xpHead').addEventListener('pointerdown',ev=>{const h=ev.target.closest('i.hh');if(!h)return;
  ev.preventDefault();const c=+h.dataset.c,x0=ev.clientX,w0=COLS[c];h.setPointerCapture(ev.pointerId);
  const mv=e=>{const otros=COLS.reduce((a,w,i)=>a+(i===c?0:w),0);
   const tope=Math.max(24,$('xpHead').clientWidth-8-16-otros-70);   /* 70 px siempre para el nombre */
   COLS[c]=Math.max(24,Math.min(tope,Math.round(w0+(x0-e.clientX))));colsCss()};
  const up=()=>{colsSave();h.removeEventListener('pointermove',mv);h.removeEventListener('pointerup',up)};
  h.addEventListener('pointermove',mv);h.addEventListener('pointerup',up)});
 $('xpHead').addEventListener('dblclick',ev=>{const h=ev.target.closest('i.hh');if(!h)return;
  COLS[+h.dataset.c]=CDEF[+h.dataset.c];colsCss();colsSave()});   /* double click on a divider: back to the default */
 bTree.onclick=()=>modo(F.modo==='list'?'tree':'list');
 /* los 4 modos de vista solo pintan el arbol: desde List no se veia nada */
 ['vModelo','vZona','vMalla','vPos'].forEach(id=>{const b=$(id);
  b&&b.addEventListener('click',()=>{if(F.modo!=='tree')modo('tree')})});
 /* Explicit native choices keep pass, fail and unmeasured distinct. */
 const gateLabels={cert:'Geometry',valid:'Validity',ct:'CT coverage',flat:'Flattening',cont:'Continuity',a4:'Area ≥4 cm²'};
 const flagLabels={rep:'Repaired',piece:'Pieces',lab:'Masks',star:'Starred'};
 for(const [items,parent,labels,options] of [[chips,'xpChips',gateLabels,[['','Any'],['pass','Pass'],['fail','Fail'],['unm','Unmeasured']]],[flags,'xpFlags',flagLabels,[['','Any'],['yes','Yes'],['no','No']]]]){
  items.forEach(([k])=>{const label=document.createElement('label'),select=document.createElement('select');select.id='xpFilter_'+k;
   label.append(labels[k],select);options.forEach(([v,t])=>select.add(new Option(t,v)));
   label.title=(GATES.find(g=>g[0]===k)||[])[3]||'';select.onchange=()=>{F[k]=select.value;pintar()};$(parent).append(label)})}
 function pintarChips(){[...chips,...flags].forEach(([k])=>{const s=$('xpFilter_'+k);s.value=F[k];s.className=F[k]||''})}
 const applyPreset=i=>{F=Object.assign({},DEF,{modo:'list'},PRE[i][1]);modo('list')};
 $('xpPreset').onchange=e=>{const value=e.target.value;e.target.value='';if(value!=='')applyPreset(+value)};
 $('xpClear').onclick=()=>applyPreset(PRE.length-1);
 function activeFilters(){const active=$('xpActive');active.replaceChildren();
  const names={...gateLabels,...flagLabels,amin:'Area ≥',amax:'Area ≤',v5min:'v5 ≥',v5max:'v5 ≤',isomax:'Isometry ≤',zmin:'z ≥',zmax:'z ≤',ctmin:'CT ≥',c17:'17 centres',unseen:'Unseen'};
  for(const [k,n] of Object.entries(names)){const v=F[k];if(v===''||v===false)continue;
   const b=document.createElement('button');b.type='button';b.className='xpBadge '+(v==='pass'||v==='yes'?'pass':v==='fail'||v==='no'?'fail':'');
   b.textContent=n+(v===true?'':v==='pass'?' ✓':v==='fail'||v==='no'?' ✗':v==='unm'?' ?':v==='yes'?'':' '+v)+' ×';
   b.title='Remove filter: '+b.textContent.slice(0,-2);b.setAttribute('aria-label',b.title);b.onclick=()=>{const i=[...active.children].indexOf(b);F[k]=DEF[k];pintar();(active.children[i]||active.lastElementChild||$('xpFilters').querySelector('summary')).focus()};active.append(b)}
  active.hidden=!active.childElementCount;$('xpFilterCount').textContent=active.childElementCount?'('+active.childElementCount+')':''}
 /* Warm cache: every depth of every listed lamina through the proxy (server-side .s3cache). Progress is
    counted in DEPTHS (one depth = its full PNGs + previews), shown in a bar under the controls. */
 let WARM=null;
 if (window.VISOR_STATIC) $('xpWarm').disabled=true;
 $('xpWarm').onclick=async()=>{const b=$('xpWarm');if(WARM){WARM.stop=true;return}
  const deps=new Map();VIS.forEach(r=>r.e.items.forEach(it=>{const fr=manifest[it.i].frames||{};Object.entries(fr).forEach(([c,d])=>{const base=d.replace(/^\.\.\//,'');if(!deps.has(base))deps.set(base,{lam:r.lam,c,files:[['fixed'],['global'],['fixed',4],['fixed',8],['global',4],['global',8]].map(([c,k])=>mapUrl(d,c,k).replace(/^\.\.\//,''))})})}));
  const D=[...deps.values()],lams=new Set(D.map(d=>d.lam));if(!D.length)return;
  let bar=$('xpWarmBar');if(!bar){bar=document.createElement('div');bar.id='xpWarmBar';bar.style.cssText='margin:2px 0 4px;font:11px ui-monospace,monospace;color:#9fb3c8';bar.innerHTML='<div style="height:6px;background:#1b2531;border-radius:3px;overflow:hidden"><div id="xpWarmFill" style="height:100%;width:0;background:#2d8a6d;transition:width .2s"></div></div><div id="xpWarmTxt"></div>';b.closest('.row').after(bar)}
  bar.hidden=false;const fill=$('xpWarmFill'),txt=$('xpWarmTxt');WARM={stop:false};let done=0,i=0,ok=0;b.classList.add('on');b.textContent='Stop';
  const paint=(cur)=>{fill.style.width=(100*done/D.length).toFixed(1)+'%';txt.textContent=done+'/'+D.length+' depths · '+lams.size+' laminae'+(cur?' · '+cur.lam+' c'+cur.c:'')};paint(null);
  const worker=async()=>{while(i<D.length&&!WARM.stop){const d=D[i++];paint(d);for(const f of d.files){if(WARM.stop)break;try{const r=await fetch('/'+f,{cache:'no-store'});ok+=r.ok?1:0}catch(e){}}done++;paint(d)}};
  await Promise.all([0,1,2].map(worker));
  txt.textContent=(WARM.stop?'stopped at ':'done: ')+done+'/'+D.length+' depths · '+lams.size+' laminae · '+ok+' files';b.classList.remove('on');b.textContent='Warm cache';WARM=null};
 const ctl=[['xpQ','q','text'],['xpRollo','rollo','text'],['xpSort','sort','text'],['xpAmin','amin','num'],['xpAmax','amax','num'],['xpV5','v5min','num'],['xpV5max','v5max','num'],['xpIso','isomax','num'],['xpZmin','zmin','num'],['xpZmax','zmax','num'],['xpCt','ctmin','num'],['xpC17','c17','bool'],['xpUnseen','unseen','bool'],['xpV5m','v5m','text']];
 ctl.forEach(([id,k,t])=>{const e=$(id);e.oninput=()=>{F[k]=t==='bool'?e.checked:e.value;pintar()}});$('xpDir').onclick=()=>{F.desc=!F.desc;pintar()};
 bThumb.onclick=()=>{F.thumbs=!F.thumbs;save();armarFlat();$('xpList').scrollTop=0;pintarVentana();sync()};
 window.xpRepintar=()=>pintar();
 const sv=$('xpSinVer');sv.checked=SIN_VERIFICAR;sv.title='Show maps with unverified mesh associations. Warnings remain; this does not verify a mesh.';sv.parentElement.title=sv.title;sv.onchange=()=>{localStorage.setItem('vesuvius.sinVerificar',sv.checked?'1':'0');const url=new URL(location.href),hash=new URLSearchParams(url.hash.slice(1));hash.delete('sinverificar');url.hash=hash.toString();history.replaceState(null,'',url.href);location.reload()};
 function sync(){ctl.forEach(([id,k,t])=>{const e=$(id);if(t==='bool')e.checked=!!F[k];else if(document.activeElement!==e)e.value=F[k];if(t==='num')e.classList.toggle('on',F[k]!=='')});syncView();$('xpDir').textContent=F.desc?'↓':'↑';$('xpDir').title=F.desc?'Descending — reverse sort':'Ascending — reverse sort';activeFilters();bThumb.classList.toggle('on',!!F.thumbs);bThumb.setAttribute('aria-pressed',String(!!F.thumbs))}
 let ROWS=[],VIS=[],FLAT=[],LABS=new Set();const ABIERTAS=new Set();
 /* 24-sep: a segment row unfolds into its maps (one per lamina x model x face), the segment's own maps first */
 // Segment thumbnails are tall; expanded map rows keep their compact height.
 const RHT=250;let OFF=[0],paintedWindow=null,visibleRows=new Map();const altoDe=r=>r.sub||!F.thumbs?26:RHT;
 function armarOff(){OFF=[0];FLAT.forEach(r=>OFF.push(OFF[OFF.length-1]+altoDe(r)))}
 function idxDe(y){let lo=0,hi=FLAT.length;while(lo<hi){const m=(lo+hi)>>1;if(OFF[m+1]<=y)lo=m+1;else hi=m}return lo}
 function thumbDe(r,model){const its=r.e.items||[],it=model?its.find(x=>model.test(x.modelo||'')):its.find(x=>/^r3f(?![-_ ]?evo)/i.test(x.modelo||''))||its.find(x=>/ra_congelado/i.test(x.modelo||''))||its.find(x=>/base/i.test(x.modelo||''))||its[0];
  if(!it||typeof mapUrl!=='function')return null;const fr=(manifest[it.i]||{}).frames||{};
  const k=fr['0']!=null?'0':Object.keys(fr).sort((a,b)=>Math.abs(a)-Math.abs(b))[0];
  if(k==null)return null;
  const frame=fr[k], contrasts=manifest[it.i]?.frameContrasts?.[frame]||[], contrast=contrasts.includes('fixed')?'fixed':contrasts[0]||'fixed';
  const fallback=globalThis.VISOR_STATIC&&!/\.tiff?$/i.test(frame)?mapUrl(frame,contrast):null;
  return {u:mapUrl(frame,contrast,8),zoom:mapUrl(frame,contrast,4),fallback,m:it.modelo,c:k}}
 function armarFlat(){paintedWindow=null;visibleRows.clear();FLAT=[];VIS.forEach(r=>{FLAT.push(r);if(ABIERTAS.has(r.lam))[...r.e.items].sort((a,b)=>(a.hoja!==r.lam)-(b.hoja!==r.lam)||a.hoja.localeCompare(b.hoja)).forEach(it=>FLAT.push({sub:true,r,it}))});armarOff()}
 function plegar(r){if(ABIERTAS.has(r.lam))ABIERTAS.delete(r.lam);else ABIERTAS.add(r.lam);armarFlat();pintarVentana()}
 function meshLocation(g){const p=g?.meshAssociation?.meshPath;if(!p)return 'Mesh path unavailable';const cfg=window.VISOR_ORIGEN;if(!cfg?.origen||!p.startsWith('../catalog/'))return p;
  let rel=p.slice(3);if(cfg.layout==='catalog')rel=rel.slice('catalog/'.length);else if(cfg.layout==='sample'){const prefix='catalog/'+cfg.scroll+'/';if(!rel.startsWith(prefix))return p;rel=rel.slice(prefix.length)}
  return cfg.origen.replace(/\/$/,'')+'/'+rel}
 function meshTooltip(items){return 'Mesh location (association may be unverified):\n'+[...new Set(items.map(it=>meshLocation(manifest[it.i])))].join('\n')}
 function subFila({r,it}){const g=manifest[it.i],d=document.createElement('div');d.className='r sub'+(g===group?' sel':'');d.dataset.i=it.i;d.title=meshTooltip([it]);
  d.innerHTML='<span></span><span class="n" title="'+g.id+'">↳ '+(LABS.has(it.hoja)||MASC.has(it.hoja)?'<span style="color:#ffb347">✎</span> ':'')+(it.hoja!==r.lam?it.hoja+' · ':'')+modCorto(it.modelo)+' · '+it.cara+' · '+Object.keys(g.frames||{}).length+' c</span><span></span><span></span><span></span>';
  d.querySelector('.n').title=g.id+'\n'+d.title;d.onclick=()=>{SEEN[r.lam]=Date.now();r.seen=true;save();select(it.i)};return d}
 function marca(r){if(r.meshQuality){const q=r.meshQuality, entries=Object.entries(q.gates),pass=entries.filter(([,s])=>s==='PASS').length,na=entries.filter(([,s])=>s==='NOT_APPLICABLE').length,fail=entries.filter(([,s])=>s==='FAIL').length;
   const label=pass+' pass'+(na?' · '+na+' N/A':'')+(fail?' · '+fail+' fail':'')+(entries.length-pass-na-fail?' · '+(entries.length-pass-na-fail)+' pending':'');
   const title='Mesh quality · '+q.profile+' profile · selection snapshot\n'+entries.map(([k,s])=>k+': '+s).join('\n')+'\nInk validation and target/training allocation remain separate.';
   return '<span class="g" title="'+title+'">'+label+' · '+q.profile+'</span>'}
  return '<span class="g" title="'+GATES.map(([k,n,L])=>L+' '+n+': '+(r[k]===true?'pass':r[k]===false?'fail':'unmeasured')).join('\n')+'">'
  +GATES.map(([k,,L])=>{const v=r[k];return v===true?'<b>'+L+'</b>':v===false?'<s>'+L+'</s>':'<u>'+L+'</u>'}).join(' ')+'</span>'}
 function pintar(){save();sync();pintarChips();LABS=new Set(Object.keys(typeof MSK!=='undefined'?MSK:{}).map(k=>k.slice(0,k.lastIndexOf('|'))));ROWS=[...LAM.values()].map(fila);VIS=ordenar(filtrar(ROWS));armarFlat();const act=typeof lamActual==='function'?lamActual():null;
  const tot=VIS.reduce((s,r)=>s+(r.cm||0),0);
  const areas=VIS.filter(r=>r.cm!=null).length;
  {const T=GATES.map(([k])=>{let p=0,f=0,u=0;ROWS.forEach(r=>{r[k]===true?p++:r[k]===false?f++:u++});
    return '<tr><th scope="row">'+gateLabels[k]+'</th><td class="p">'+p+'</td><td class="f">'+f+'</td><td class="u">'+u+'</td></tr>'}).join('');
   $('xpTally').innerHTML='<table><caption>All segments · quality gates</caption><thead><tr><th>Gate</th><th>Pass</th><th>Fail</th><th>Unmeasured</th></tr></thead><tbody>'+T+'</tbody></table>'}const nf=['rollo','cert','valid','ct','flat','cont','a4','amin','amax','v5min','v5max','isomax','zmin','zmax','ctmin','rep','piece','lab','star'].filter(k=>F[k]!=='').length+(F.c17?1:0)+(F.unseen?1:0)+(F.q.trim()?1:0);/* 24-sep: segment (row) > map (lamina x model x face, nested) > depth */
 let nGal=0,nProf=0;
 VIS.forEach(r=>{nGal+=r.e.items.length;
  r.e.items.forEach(it=>{const g=manifest[it.i];if(g.catalogMeta?.depthKnown!==false)nProf+=Object.keys(g.frames||{}).length})});
    window.XPVIS=nf?new Set(VIS.map(r=>r.lam)):null;
 if(F.modo==='tree'&&typeof pintarArbol==='function')try{pintarArbol()}catch(e){}
 $('xpCount').innerHTML=VIS.length+' of '+ROWS.length+' segments · '+(areas?tot.toFixed(1)+' cm²'+(areas<VIS.length?' ('+areas+' measured)':''):'area unmeasured')
  +'<span class="lbl"> — '+nGal+' maps · '+nProf+' depths</span>'
  +(nf?' · '+nf+' filter'+(nf>1?'s':'')+' active':'');
  $('xpList').scrollTop=0;pintarVentana()}
 function pintarVentana(){
  const L=$('xpList'),z=$('xpZoom');if(z)z.hidden=true;if(F.modo!=='list')return;
  L.style.setProperty('--xpth',RHT+'px');const start=Math.max(0,idxDe(L.scrollTop)-4);
  const end=Math.min(FLAT.length,idxDe(L.scrollTop+(L.clientHeight||500))+6);
  const act=typeof lamActual==='function'?lamActual():null,key=[start,end,act,F.thumbs].join('|');
  if(paintedWindow===key)return;
  const nextRows=new Map();
  const frag=document.createDocumentFragment();
  const spacer=h=>{const d=document.createElement('div');d.style.height=h+'px';d.setAttribute('aria-hidden','true');return d};
  frag.append(spacer(OFF[start]));
  FLAT.slice(start,end).forEach(r=>{const rowKey=r.sub?'run:'+r.it.i:'segment:'+r.lam,cached=visibleRows.get(rowKey);
   if(cached){cached.classList.toggle('sel',r.sub?manifest[r.it.i]===group:r.lam===act);cached.classList.toggle('seen',!!(r.sub?r.r.seen:r.seen));frag.append(cached);nextRows.set(rowKey,cached);return}
   if(r.sub){const d=subFila(r);frag.append(d);nextRows.set(rowKey,d);return}const d=document.createElement('div');d.className='r'+(F.thumbs?' th':'')+(r.lam===act?' sel':'')+(r.seen?' seen':'');d.dataset.lam=r.lam;
   d.innerHTML='<span class="star'+(r.star?' on':'')+'">★</span><span class="n" title="'+r.lam+(r.e.fam?' · '+r.e.fam:'')+(r.z!=null?' · z '+r.z:'')+(r.iso!=null?' · iso '+r.iso.toFixed(2)+' %':'')+(r.ctp!=null?' · CT '+r.ctp.toFixed(1)+' %':'')+(r.nc?' · '+r.nc+' centres':'')+(r.hs.length>1?' · laminae: '+r.hs.slice(1).join(', '):'')+'">'+'<span class="tg" title="show / hide its maps">'+(ABIERTAS.has(r.lam)?'▾':'▸')+r.e.items.length+'</span> '+(r.hs.some(h=>PROPS.has(h)||PROPS.has((typeof segId==='function')?segId(h):h))?'<span title="automatic mask proposal available: Label > import proposal">📋</span> ':'')+(r.hs.includes(OBJ)?'<span title="TARGET lamina">🎯</span> ':((x=>x!=null?'<span style="color:#f08a95" title="overlaps the target mesh '+EXCL[x]+' % - excluded from training">⊘</span> ':'')(r.hs.find(h=>EXCL[h]!=null))))+(r.rep?'<span style="color:#86dcd5">↻</span> ':'')+(r.lab?'<span style="color:#ffb347">✎</span> ':'')+r.lam+(r.hs.length>1?'<span class="lbl"> · '+r.hs[1]+(r.hs.length>2?' +'+(r.hs.length-2):'')+'</span>':'')+'</span>'+
    '<span class="num">'+(r.cm!=null?r.cm.toFixed(2):'—')+'</span><span class="num" title="v5 legibility'+(r.v5c!=null?' @c'+r.v5c:'')+(r.v5m?' · '+r.v5m:'')+(r.v5p!=null?' · p'+r.v5p.toFixed(1)+' within scroll and model':'')+'">'+(r.v5==null?'—':F.v5m==='pct'?'p'+r.v5p.toFixed(1):r.v5.toFixed(3))+'</span>'+marca(r);
   d.title=meshTooltip(r.e.items);d.querySelector('.n').title+='\n'+d.title;
   if(F.thumbs){const first=thumbDe(r),base=thumbDe(r,/base/i),thumbs=[first,...(base&&base.u!==first?.u?[base]:[])].filter(Boolean),box=document.createElement('div');box.className='thumbs';d.append(box);thumbs.forEach(t=>{if(t.u){const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=modCorto(t.m)+' · c'+(+t.c>=0?'+':'')+t.c;figure.append(caption);box.append(figure);const im=document.createElement('img');im.className='th';im.alt=modCorto(t.m)+' preview';im.decoding='async';im.tabIndex=0;
    im.title=modCorto(t.m)+' \u00b7 c'+(+t.c>=0?'+':'')+t.c+' \u00b7 preview';im.loading='lazy';im.fetchPriority='low';im.src=t.u;
    im.onerror=()=>{if(t.fallback&&im.src!==t.fallback){im.src=t.fallback;t.zoom=t.fallback}
      else im.style.visibility='hidden'};
    im.onmouseenter=im.onfocus=()=>{let z=$('xpZoom');if(!z){z=document.createElement('img');z.id='xpZoom';z.alt='';
     z.style.cssText='position:fixed;z-index:9999;max-width:min(62vw,900px);max-height:86vh;border:1px solid #2d8a6d;background:#05080c;box-shadow:0 8px 30px #000a;pointer-events:none';
     z.onerror=()=>{z.hidden=true};document.body.append(z)}const b=im.getBoundingClientRect();z.src=t.zoom;
     z.style.left=Math.max(8,Math.min(b.right+12,innerWidth-Math.min(innerWidth*.62,900)-8))+'px';
     z.style.top=Math.max(8,Math.min(b.top,innerHeight*.14-8))+'px';z.hidden=false};
    im.onmouseleave=im.onblur=()=>{const z=$('xpZoom');if(z)z.hidden=true};figure.append(im)}})}
   d.querySelector('.star').onclick=ev=>{ev.stopPropagation();if(STARS.has(r.lam))STARS.delete(r.lam);else STARS.add(r.lam);save();pintar()};
   d.querySelector('.tg').onclick=ev=>{ev.stopPropagation();plegar(r)};
   d.onclick=()=>{ABIERTAS.clear();ABIERTAS.add(r.lam);armarFlat();abrir(r)};frag.append(d);nextRows.set(rowKey,d)});frag.append(spacer(OFF[FLAT.length]-OFF[end]));L.replaceChildren(frag);visibleRows=nextRows;paintedWindow=key}
 function abrir(r){SEEN[r.lam]=Date.now();r.seen=true;save();irA(r.e,(F.v5m&&F.v5m!=='pct'?F.v5m:r.v5m)||undefined);
  if(F.unseen){pintar();return}revelarSeleccion()}
 function revelarSeleccion(){const L=$('xpList'),act=typeof lamActual==='function'?lamActual():null;
  const i=FLAT.findIndex(r=>!r.sub&&r.lam===act);if(i>=0){const y=OFF[i],h=OFF[i+1]-y;if(y<L.scrollTop)L.scrollTop=y;else if(y+h>L.scrollTop+L.clientHeight)L.scrollTop=Math.max(0,y+h-L.clientHeight)}pintarVentana()}
 let scrollFrame=0;
 $('xpList').addEventListener('scroll',()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;pintarVentana()})},{passive:true});
 new ResizeObserver(()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;pintarVentana()})}).observe($('xpList'));
 document.addEventListener('keydown',e=>{if(F.modo!=='list'||/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)||e.ctrlKey||e.metaKey)return;
  const act=typeof lamActual==='function'?lamActual():null;const i=VIS.findIndex(r=>r.lam===act);
  if(e.key==='j'&&VIS[i+1])abrir(VIS[i+1]);else if(e.key==='k'&&i>0)abrir(VIS[i-1]);else if(e.key==='Enter'&&i>=0)abrir(VIS[i]);else if(e.key==='s'&&act){if(STARS.has(act))STARS.delete(act);else STARS.add(act);save();pintar()}});
 /* keep the selection mark in sync when the viewer changes lamina by other means */
 new MutationObserver(()=>{if(F.modo!=='list')return;const act=typeof lamActual==='function'?lamActual():null,gi=manifest.indexOf(group);$('xpList').querySelectorAll('.r').forEach(d=>d.classList.toggle('sel',d.dataset.i!=null?+d.dataset.i===gi:d.dataset.lam===act));}).observe($('count')||document.body,{childList:true,characterData:true,subtree:true});
 /* 27-sep: #xprollo=0800&xpsort=v5&xpv5m=ra_congelado (tambien xpdesc=0|1, xpv5min, xpq) fija el explorador al abrir */
 {const h=new URLSearchParams(location.hash.slice(1)),M={xprollo:'rollo',xpsort:'sort',xpv5m:'v5m',xpv5min:'v5min',xpq:'q'};let hay=false;
  for(const [k,f] of Object.entries(M))if(h.has(k)){F[f]=h.get(k);hay=true}
  if(h.has('xpdesc')){F.desc=h.get('xpdesc')!=='0';hay=true}
  if(hay){F.modo='list';save()}}
 window.explorerPro={pintar,filtro:()=>F};
 modo(F.modo);
 /* gates / legibility files load asynchronously: repaint when they land */

 console.log('explorer_pro: active');
})();
