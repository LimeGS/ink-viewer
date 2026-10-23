/* ===== depth preload + real depth merge (12-Sep-2026) =====
   In HD mode only the current depth and two neighbours are prefetched into memory. And "Merge depths" becomes a
   real per-pixel maximum over ALL centres, computed in the browser (canvas, 'lighten' composite): for
   laminae loaded from S3 the manifest's `maximum` pointed at centre 0, not at a projection. */
(function(){
 if(typeof group==='undefined'||typeof im==='undefined'){console.warn('precarga: viewer globals missing');return}
 // In-memory only. Never alter the proxy's persistent cache.
 const IM=new Map(),MAXP=new Map();
 const urlDe=dir=>dir?new URL(mapUrl(dir,$('contrast').value),location.href).href:null;
 function img(url){let g=IM.get(url);if(g)IM.delete(url);else{g=new Image();g.decoding='async';g.src=url}IM.set(url,g);
  while(IM.size>4)IM.delete(IM.keys().next().value);return g}
 function vecinos(g){return Object.keys(g.frames||{}).map(Number).sort((a,b)=>Math.abs(a-Number(slider.value))-Math.abs(b-Number(slider.value))).slice(0,3)}
 function precargar(g){if(!window.HD||!g||!g.frames)return;vecinos(g).forEach(c=>img(urlDe(g.frames[c])))}
 let mergeRequest=0;
 async function maxDe(g,cb,rango){if(!g)return;
  const fr=Object.entries(g.frames||{}).map(([c,d])=>[+c,d]).filter(([c])=>!rango||(c>=rango[0]&&c<=rango[1])).sort((a,b)=>a[0]-b[0]).map(([,d])=>urlDe(d));
  const key=fr.join('|');
  const token=++mergeRequest;
  if(MAXP.has(key)){cb(MAXP.get(key));return}
  if(!fr.length)return;
  const c=document.createElement('canvas');const ctx=c.getContext('2d');
  try{
   // Decode and composite one depth at a time: bounded memory and a paint between depths.
   for(let n=0;n<fr.length;n++){
    const image=img(fr[n]);await image.decode();if(token!==mergeRequest)return;
    if(!n){c.width=image.naturalWidth;c.height=image.naturalHeight;ctx.globalCompositeOperation='lighten'}
    if(image.naturalWidth!==c.width||image.naturalHeight!==c.height)throw new Error('Depth images have different sizes');
    ctx.drawImage(image,0,0);await new Promise(requestAnimationFrame);
   }
   const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
   if(token!==mergeRequest||!blob)return;
   const url=URL.createObjectURL(blob);MAXP.set(key,url);cb(url);
   while(MAXP.size>2){const old=MAXP.keys().next().value;URL.revokeObjectURL(MAXP.get(old));MAXP.delete(old)}
  }catch(e){if(token===mergeRequest){$('notice').hidden=false;$('notice').textContent='Could not merge all depths: '+e.message}}
  finally{c.width=c.height=0}
 }
 function mostrarMax(rango){const g=group,contrast=$('contrast').value;
  maxDe(g,blob=>{if(group===g&&projection&&$('contrast').value===contrast)im.src=blob},rango)}
 /* hook: `show` is not reachable as window.show, so react to im.src changes instead */
 let ultimo=null;
 new MutationObserver(()=>{const g=group;if(!g||!im.src||im.src.startsWith('blob:'))return;
  if(g!==ultimo){ultimo=g;mergeRequest++;IM.clear()}
  precargar(g);poolArmar(g);
  if(projection)poolOcultar();else if(POOL.activo!=null&&POOL.activo!==Number(slider.value))poolMostrar(Number(slider.value));
  if(projection)mostrarMax(rangoActual())}).observe(im,{attributes:true,attributeFilter:['src']});
 function aplicarProy(){if(!group)return;
  rangoUI(projection);
  if(projection){mostrarMax(rangoActual());return}
  mergeRequest++;
  if(im.src.startsWith('blob:')){const d=group.frames[String(slider.value)]||group.frames['0'];
    if(d)im.src=urlDe(d)}}
 /* Merge depths con RANGO: el slider de profundidad se congelaba; en su lugar
    aparecen dos manijas para elegir que centros entran en el maximo. */
 let RA=null,RB=null,RLBL=null,RBOX=null;
 const cent=()=>Object.keys(group&&group.frames||{}).map(Number).sort((a,b)=>a-b);
 function rangoActual(){const c=cent();if(!c.length)return null;
  const a=RA?+RA.value:c[0],b=RB?+RB.value:c.at(-1);return [Math.min(a,b),Math.max(a,b)]}
 function rangoUI(on){
  if(!RBOX){RBOX=document.createElement('div');RBOX.id='rangoMezcla';
   RBOX.style.cssText='display:none;align-items:center;gap:6px;padding:2px 4px;font:11px ui-monospace,monospace;color:#9fb3c8';
   RA=document.createElement('input');RB=document.createElement('input');
   [RA,RB].forEach(e=>{e.type='range';e.style.flex='1 1 0';e.title='Depth range to merge'});
   RLBL=document.createElement('span');RLBL.style.cssText='min-width:74px;text-align:right';
   RBOX.append(RA,RB,RLBL);slider.after(RBOX);
   const ch=()=>{const r=rangoActual();if(!r)return;
    RLBL.textContent='c'+(r[0]<0?r[0]:'+'+r[0])+' … c'+(r[1]<0?r[1]:'+'+r[1]);
    if(projection)mostrarMax(r)};
   RA.oninput=RB.oninput=ch}
  RBOX.style.display=on?'flex':'none';
  if(!on)return;
  const c=cent();if(!c.length)return;
  [RA,RB].forEach(e=>{e.min=c[0];e.max=c.at(-1);e.step=1});
  if(RA.dataset.gid!==(group&&group.id)){RA.dataset.gid=group.id;RA.value=c[0];RB.value=c.at(-1)}
  const r=rangoActual();RLBL.textContent='c'+(r[0]<0?r[0]:'+'+r[0])+' … c'+(r[1]<0?r[1]:'+'+r[1])}
 const bMax=$('max');bMax&&bMax.addEventListener('click',()=>setTimeout(aplicarProy,0));
 window.precargaMax=maxDe;
 /* ---- decoded layer pool: one <img> per depth centre, pre-decoded, swapped by visibility. The slider becomes
    instant (no fetch, no decode) once the pool is warm; `im` keeps being updated underneath so masks, filters and
    the rest of the viewer see the same state. Cleared on lamina change. ---- */
 const POOL={id:null,imgs:{},activo:null};
 function poolLimpiar(){Object.values(POOL.imgs).forEach(g=>g.remove());POOL.imgs={};POOL.activo=null;POOL.id=null;im.style.opacity=''}
 function poolArmar(g){if(!window.HD){poolLimpiar();return}if(!g)return;
  const key=Object.values(g.frames).join('|')+'|'+$('contrast').value;if(POOL.id!==key){poolLimpiar();POOL.id=key}
  const near=vecinos(g);
  Object.keys(POOL.imgs).forEach(c=>{if(!near.includes(+c)){POOL.imgs[c].remove();delete POOL.imgs[c];if(POOL.activo===+c)poolOcultar()}});
  near.forEach(c=>{if(POOL.imgs[c])return;const e=document.createElement('img');e.className='poolImg';e.decoding='async';e.draggable=false;
   e.style.cssText='position:absolute;left:0;top:0;max-width:none;user-select:none;pointer-events:none;visibility:hidden;filter:var(--fx)';
   e.src=urlDe(g.frames[c]);e.dataset.c=String(c);POOL.imgs[c]=e;e.decode().then(()=>{e.dataset.ok='1'}).catch(()=>{});im.after(e)})}
 function poolMostrar(c){const e=POOL.imgs[c];if(!e||e.dataset.ok!=='1'){poolOcultar();return false}
  Object.values(POOL.imgs).forEach(o=>o.style.visibility='hidden');e.style.visibility='';POOL.activo=c;im.style.opacity='0';return true}
 function poolOcultar(){Object.values(POOL.imgs).forEach(o=>o.style.visibility='hidden');POOL.activo=null;im.style.opacity=''}
 slider.addEventListener('input',()=>{if(projection||!group)return;poolArmar(group);poolMostrar(Number(slider.value))},true);
 slider.addEventListener('change',()=>{if(projection||!group)return;poolMostrar(Number(slider.value))},true);
 document.addEventListener('click',e=>{if(e.target.closest('#hdBtn'))poolLimpiar()});
 $('contrast').addEventListener('change',poolLimpiar);
 window.precargaPool=()=>({id:POOL.id,decodificadas:Object.values(POOL.imgs).filter(e=>e.dataset.ok==='1').length,activo:POOL.activo});
 /* ---- low-res preview: <dir>/fixed_lo.jpg (1/4 scale JPEG, ~30 KB, all of them cached on the Mac) shown at once
    while the full-res PNG loads; hidden as soon as the full image (or the pool frame) is up. ---- */
 const lo=document.createElement('img');lo.id='lowres';lo.decoding='async';lo.draggable=false;
 lo.style.cssText='position:absolute;left:0;top:0;max-width:none;user-select:none;pointer-events:none;visibility:hidden;filter:var(--fx);image-rendering:auto';
 im.before(lo);
 /* tiered: 1/8 first (~10 KB), then 1/4 once it is decoded, then the HD png hides both */
 lo.onload=()=>{if(lo.dataset.for!==im.src)return;const f=/(_lo8|-ds8)\.jpg$/.test(lo.src)?8:4;lo.style.width=(lo.naturalWidth*f)+'px';lo.style.height=(lo.naturalHeight*f)+'px';
  if(!(im.complete&&im.naturalWidth)&&POOL.activo==null)lo.style.visibility='';
  if(f===8){const u4=lo.src.replace(/_lo8\.jpg$/,'_lo.jpg').replace(/-ds8\.jpg$/,'-ds4.jpg'),pre=new Image();pre.onload=()=>{if(lo.dataset.for===im.src&&lo.style.visibility!=='hidden')lo.src=u4};pre.src=u4}};
 lo.onerror=()=>{if(/(_lo8|-ds8)\.jpg$/.test(lo.src)){lo.src=lo.src.replace(/_lo8\.jpg$/,'_lo.jpg').replace(/-ds8\.jpg$/,'-ds4.jpg');return}lo.style.visibility='hidden'};
 const loMostrar=()=>{if(!im.src||im.src.startsWith('blob:')){lo.style.visibility='hidden';return}
  const u=previewOf(im.src,8);if(!u)return;lo.dataset.for=im.src;lo.style.visibility='hidden';lo.src=u};
 const loOcultar=()=>{lo.style.visibility='hidden'};
 new MutationObserver(()=>{if(POOL.activo!=null&&!projection)return;loMostrar()}).observe(im,{attributes:true,attributeFilter:['src']});
 im.addEventListener('load',loOcultar);
 /* black screen while a new image loads (only if it takes longer than 150 ms), and a timer next to the loader */
 let t0=0,tick=0;const timer=document.createElement('span');timer.id='cargaTimer';timer.style.cssText='margin-left:8px;font:12px ui-monospace,monospace;color:#86dcd5';
 const notice=$('notice');if(notice)notice.after(timer);
 let hideT=0;const ocultar=()=>{if(POOL.activo!=null&&!projection)return;clearTimeout(hideT);hideT=setTimeout(()=>{im.style.visibility='hidden';if(lo.style.visibility!=='hidden')stage.style.background='';document.querySelectorAll('.pane img').forEach(g=>g.style.visibility='hidden');stage.style.background='#000';
  t0=performance.now();clearInterval(tick);tick=setInterval(()=>{timer.textContent='loading '+((performance.now()-t0)/1000).toFixed(1)+' s'},100);timer.textContent='loading 0.0 s'},150)};
 const mostrar=ok=>{clearTimeout(hideT);clearInterval(tick);im.style.visibility='';document.querySelectorAll('.pane img').forEach(g=>g.style.visibility='');
  timer.textContent=ok?'loaded in '+((performance.now()-t0)/1000).toFixed(1)+' s':'load failed';setTimeout(()=>{if(timer.textContent.startsWith('loaded'))timer.textContent=''},4000)};
 new MutationObserver(()=>{if(im.src&&!(im.complete&&im.naturalWidth))ocultar()}).observe(im,{attributes:true,attributeFilter:['src']});
 im.addEventListener('load',()=>mostrar(true));im.addEventListener('error',()=>mostrar(false));
 /* data tokens from manifest labels, translated for display only (the regexes keep parsing the originals) */
 const TOK=[[/ centros\b/g,' centres'],[/recurso remoto \(cache local\)/g,'remote resource (local cache)'],[/pozo_(\d+): limpia vs/g,'well_$1: clean vs'],[/NO entreno con esta lamina/g,'NOT trained on this lamina'],[/SI entreno con esta lamina/g,'trained on this lamina'],
  [/orientaci[oó]n /g,'orientation '],[/\(normal corregido a 'adentro' en el render\)/g,'(normal forced inward in the render)'],[/\bCORRECTA\b/g,'CORRECT'],[/\bINVERTIDA\b/g,'INVERTED'],[/Render p[uú]blico/g,'Public render'],[/l[aá]mina nueva/g,'new lamina'],
  [/\(ckpt publico\)/g,'(public ckpt)'],[/Claude p[uú]blicos/g,'Claude public'],[/\(malla p[uú]blica\)/g,'(public mesh)'],[/render nuevo con filas ya corregidas/g,'new render with rows already corrected'],
  [/ENTRENAMIENTO: (\d+) % de la malla a <(\d+) vox de/g,'TRAINING: $1 % of the mesh within <$2 vox of'],[/\(\+(\d+) % de ic_padre5a, (\d+) % de ic_canon_s(\d+), (\d+) % de malla_iC_full\)/g,'(+$1 % of ic_padre5a, $2 % of ic_canon_s$3, $4 % of malla_iC_full)'],
  [/malla nombrada, re-aplanada --keep=(\d+) \(lote reaplanar_lote_(\d+)\.md\)/g,'named mesh, re-flattened --keep=$1 (batch reaplanar_lote_$2.md)'],[/malla nombrada \(nucleo de (\d+): ([^)]*), SIN ([^)]*)\)/g,'named mesh (core of $1: $2, WITHOUT $3)'],[/malla nombrada/g,'named mesh'],
  [/\bheld-out\b/g,'held-out'],[/[aá]rea sin catalogar/g,'area not catalogued'],[/segmento publico/g,'public segment'],[/\(Scroll (\d+): otro rollo fisico, limpio por construccion\)/g,'(Scroll $1: another physical scroll, clean by construction)'],
  [/LOO limpio: ([\d,.]+) % de solape con (\S+) y con (\S+) \(medido\)/g,'clean LOO: $1 % overlap with $2 and with $3 (measured)'],[/iC carta A \(malla completa\)/g,'iC letter A (full mesh)'],[/\(gemelo sin esta hoja\)/g,'(twin without this sheet)'],[/\(gemelo de (\d+) hojas\)/g,'($1-sheet twin)'],
  [/CANDIDATA AL ENVIO \((\d+) figuras(, (\d+) controles)?\)/g,(m,a,b,c)=>'SUBMISSION CANDIDATE ('+a+' figures'+(c?', '+c+' controls':'')+')'],[/ESPEJADA a mano \(prueba: el render tenia signo -(\d+)\)/g,'MIRRORED by hand (test: the render had sign -$1)'],[/ESPEJADA a mano/g,'MIRRORED by hand'],
  [/malla correcta grandes_lime, signo -(\d+)/g,'correct mesh grandes_lime, sign -$1'],[/espejo VERTICAL \(filas invertidas\)/g,'VERTICAL mirror (rows inverted)'],[/rotada (\d+) grados/g,'rotated $1 degrees'],[/con esta lamina/g,'with this lamina'],
  [/\bsin certificar\b/g,'uncertified'],[/\bcert\+valida\b/g,'cert+valid'],[/\bcertificada\b/g,'certified'],[/\borientaci[oó]n\b/g,'orientation'],[/normal corregido a 'adentro' en el render/g,"normal forced inward in the render"],[/limpia vs V00/g,'clean vs V00'],[/\bsin medir\b/g,'unmeasured'],[/\bvalidez\b/g,'validity'],[/\bcapa (\d+)\b/g,'layer $1'],[/\bcompuerta\b/g,'gate'],[/\bno medido\b/g,'unmeasured']];
 const trNode=n=>{if(n.nodeType!==3)return;let t=n.nodeValue,o=t;TOK.forEach(([r,e])=>{t=t.replace(r,e)});if(t!==o)n.nodeValue=t};
 const trTree=root=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())trNode(n);
  (root.querySelectorAll?[root,...root.querySelectorAll('[title]')]:[]).forEach(e=>{if(!e.title)return;let t=e.title,o=t;TOK.forEach(([r,x])=>{t=t.replace(r,x)});if(t!==o)e.title=t})};
 const raiz=[$('tree'),$('info'),$('meta'),$('panel')].filter(Boolean);
 raiz.forEach(r=>{trTree(r);new MutationObserver(ms=>ms.forEach(m=>{m.addedNodes.forEach(a=>a.nodeType===1?trTree(a):trNode(a));if(m.type==='characterData')trNode(m.target)})).observe(r,{childList:true,subtree:true,characterData:true})});
 console.log('precarga: active');
})();
