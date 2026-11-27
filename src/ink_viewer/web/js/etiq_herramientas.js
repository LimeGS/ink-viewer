/* ===== Herramientas de máscara (25-sep-2026) — etiq_herramientas.js =====
   Pedido del usuario: «seleccionar el negro y que todo lo del mismo color pase a no-tinta», y máscaras más fáciles de hacer.
   1. Varita (W): clic sobre el mapa = valor del PNG de tinta en ese píxel; selecciona lo parecido (± tolerancia): «conectada»
      (relleno 4-conexo desde el clic) o «todo lo parecido», siempre DENTRO de la vista o de la zona marcada (R). Clase = la del
      pincel: 1 tinta · 2 no-tinta · 3 borrar (= sin etiquetar). Arrastrar mueve la vista; shift+clic suma otra selección.
   2. Umbral: «< t → no-tinta» y «≥ T → tinta» dentro de la vista o la zona.
      Varita y umbral muestran una vista previa amarilla (celeste si borra): Enter / «aplicar» la vuelca, Esc / «cancelar» la
      descarta, ctrl+Z la deshace. Por defecto NO pisan lo ya pintado (tilde «pisan lo ya pintado»).
   3. Pincel inteligente (I): el pincel de tinta solo pinta donde el mapa ≥ T; el de no-tinta solo donde el mapa < t. Con
      varios mapas a la vista (vista de modelos) manda el más restrictivo de los que comparten la grilla de la máscara (8.).
   4. Meta del holdout (arriba del panel): supervisado, tinta y no-tinta en mm² (voxel del rollo por píxel: rollo.json
      voxel_um, 8,64 µm en PHerc1447) y trazos = componentes
      8-conexas de tinta de ≥ 100 px (las menores se cuentan aparte, como motas). Meta: ≥ 40 trazos y ≥ 30 mm² supervisados.
   5. Máscara atada a su corrida: cada guardado lleva los datos de su corrida (run_id, medidas, profundidad, orientación de la
      grilla) DENTRO de los dos PNG (iTXt 'vesuvius:mascara_corrida') y en <segmento>_mascara_corrida.json al lado del par (este
      último solo si work-3 lo acepta: el catalog_writer del 25-sep solo acepta .png en labels/). «cargar guardada (work-3)» y «paste JSON» BLOQUEAN una máscara de otra
      corrida de la misma lámina con otra grilla u orientación (mismas medidas: se cargaría espejada sin que se note).
      index.html guarda el par para la corrida DUEÑA de la máscara (window.mascaraDueno, puesto acá al montarla).
   6. Guardado seguro (coordinador 25-sep), para todas las láminas: se sube solo una profundidad con ediciones humanas pendientes
      (el auto-guardado salta con cualquier pointerup, incluso al mover la vista); nunca con otra lámina ni con otras medidas que
      las de la corrida dueña; cambiar de lámina con cambios sin subir pregunta antes; autoguardar toma la clave IndexedDB al
      llamar (antes podía guardar la máscara vieja bajo la clave de la lámina nueva).
   7. Una máscara por lámina, GRILLA y profundidad (25-sep, bug «la máscara desaparece con BASE de principal»): las corridas
      del catálogo de una lámina con las mismas medidas, corrección de orientación, cara y sha de malla comparten el lienzo
      (clave de index.html/claveLienzo) y se ven y editan igual con cualquiera de principal; pasar a la hermana cambia el
      dueño de la máscara (ya no hay que «cargar guardada») y guardar desde ella no pide «reemplazar». Con otra grilla, todo
      sigue bloqueado como antes. Los lienzos viejos por corrida (run_xxx|c<N>) se suman al de la grilla sin borrarlos.
   8. Pincel inteligente sobre los mapas a la vista (25-sep, pedido 2): con la vista de varios modelos, t y T se miden en el
      mapa de la máscara y en el de cada panel que comparte su GRILLA (misma lámina, cara, sha, corrección y medidas; los de
      otra grilla quedan afuera y el panel lo dice) y manda el más restrictivo, como una superposición: tinta solo donde
      min(v) ≥ T; no-tinta solo donde max(v) < t; un píxel sin datos en alguno no se pinta. El panel dice qué mapas usa el
      límite («límite: r3f_lectura ∧ base_lectura»). Con un solo mapa, como antes. Varita, zona y umbral no cambian.
   GRILLA: todo se calcula en la grilla ORIGINAL del PNG, que es la de la máscara. Los clics pasan por rp() (oriAGrilla) y la
   vista previa y la zona viven en #stage con la misma matriz --ori que el mapa y la máscara: vale igual con «vista corregida»
   y con voltear ↕/↔. Con paneles divididos (#stage oculto) varita, zona y umbral se deshabilitan con aviso; el pincel
   inteligente sí anda.
   VALORES: se lee el PNG del mapa a resolución completa (no el preview 1/4 del modo sin HD): gris 0-255; alfa < 128 = sin datos. */
(function(){
'use strict';
const $h=id=>document.getElementById(id);
if(typeof iniciarMascara!=='function'||typeof trazo!=='function'||typeof empezar!=='function'||typeof contar!=='function'||typeof rp!=='function'||
   typeof oriAGrilla!=='function'||typeof mapUrl!=='function'||typeof prepararUndo!=='function'||!$h('panel')||!$h('stage')){
 console.warn('etiq_herramientas: falta el núcleo del etiquetador; no se instala');return}

const umDe=g=>window.visorUmPorPixel?visorUmPorPixel(g):(+window.VOXEL_UM>0?+window.VOXEL_UM:null);
const umActual=()=>umDe(grupoMascara()),mm2Actual=()=>{const um=umActual();return um==null?NaN:um*um*1e-6};
const META={trazos:40,mm2:30},MIN_TRAZO=100;          // meta del holdout; trazo = componente de tinta de al menos 100 px
const KEY='vesuvius.etiq.herramientas.v1';
const CFG={tol:12,tb:128,ta:128,alcance:'parecidos',dentro:'vista'};
try{const s=JSON.parse(localStorage.getItem(KEY)||'{}');
 if(Number.isInteger(s.tol)&&s.tol>=0&&s.tol<=128)CFG.tol=s.tol;
 if(Number.isInteger(s.tb)&&s.tb>=0&&s.tb<=255)CFG.tb=s.tb;
 if(Number.isInteger(s.ta)&&s.ta>=0&&s.ta<=255)CFG.ta=s.ta;
 if(s.alcance==='conectada'||s.alcance==='parecidos')CFG.alcance=s.alcance;
 if(s.dentro==='vista')CFG.dentro='vista'}catch(e){}
CFG.inteligente=false;CFG.sobre=false;               // nunca se recuerdan: arrancan apagados en cada carga
const guardarCfg=()=>{try{localStorage.setItem(KEY,JSON.stringify({tol:CFG.tol,tb:CFG.tb,ta:CFG.ta,alcance:CFG.alcance,dentro:CFG.dentro}))}catch(e){}};

let HERR='',HERR_ANT='',ZONA=null,PREV=null,ARR=null,CONF=null,CAPA=null,CARGA=null,tMeta=0,tRe=0,avisoInt=0;
const CACHE_V=new Map();                              // url del PNG -> {w,h,val,ok} (las 2 últimas)
const NOMBRE={tinta:'ink',no:'non-ink',borrar:"unlabelled (erase)"};
const fmt=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'unknown';
const ent=v=>Number(v).toLocaleString('en-US');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cStr=c=>c==null||c==='max'?'max':'c'+(+c>=0?'+':'-')+String(Math.abs(+c)).padStart(2,'0');
const val01=v=>fmt(v/255,2);
function estado(t,aviso){const e=$h('htEstado');if(!e)return;e.textContent=visorTexto(t);e.classList.toggle('htAviso',!!aviso)}
const dueno=()=>{const d=window.mascaraDueno;return d&&H&&d.nombre===H.nombre?d:null};
const grupoMascara=()=>{const d=dueno();return d&&d.group?d.group:group};
const centroMascara=()=>{const d=dueno();return d&&d.centro!=null?d.centro:(projection?'max':String(slider.value))};
const panelesAbiertos=()=>typeof PANES!=='undefined'&&PANES&&PANES.length>0;
const claseDelPincel=()=>modo==='tinta'?'tinta':modo==='no'?'no':modo==='borrar'?'borrar':null;
const oriCargada=()=>{if(typeof ORI!=='object'||!ORI)return false;for(const k in ORI)return true;return false};
/* corrección de VISTA de una corrida = cómo está su PNG respecto de la lectura; [0,0,0] = directo; null = no se sabe todavía */
function correccionDe(g){if(!oriCargada())return null;const a=g&&ORI[g.id];return a?[+a[0],+a[1],+a[2]]:null}

/* ---------- valores del mapa (PNG completo, grilla original) ---------- */
function urlMapaDe(g){if(!g)return null;const c=centroMascara();const dir=c==='max'?g.maximum:(g.frames||{})[Number(c)];   /* en la profundidad de la máscara */
 return dir?mapUrl(dir,$h('contrast').value):null}
function urlMapa(){return urlMapaDe(grupoMascara())}
function valoresListos(){const u=urlMapa(),v=u&&CACHE_V.get(u);return v&&H&&v.w===H.w&&v.h===H.h?v:null}
const CARGAS=new Map();   /* url -> lectura en curso (una por PNG a la vez) */
function cargarValores(){return cargarValoresDe(urlMapa())}
async function cargarValoresDe(u){
 if(!u)throw new Error("This depth has no map");
 if(CACHE_V.has(u))return CACHE_V.get(u);
 if(CARGAS.has(u))return CARGAS.get(u);
 const t0=performance.now();estado("Reading the full-resolution map (a few seconds)…");
 const p=(async()=>{
  const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);
  const bm=await createImageBitmap(await r.blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
  const w=bm.width,h=bm.height,c=document.createElement('canvas');c.width=w;c.height=h;
  const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(bm,0,0);if(bm.close)bm.close();
  const d=g.getImageData(0,0,w,h).data;c.width=c.height=0;
  const n=w*h,val=new Uint8Array(n),ok=new Uint8Array(n);
  for(let i=0,j=0;i<n;i++,j+=4){val[i]=(d[j]+d[j+1]+d[j+2]+1)/3|0;ok[i]=d[j+3]>=128?1:0}
  return {url:u,w,h,val,ok}})();
 CARGAS.set(u,p);
 try{const v=await p;CACHE_V.set(u,v);while(CACHE_V.size>4)CACHE_V.delete(CACHE_V.keys().next().value);   /* 4: dos mapas a la vista, dos profundidades */
  estado('mapa listo: '+v.w+'×'+v.h+" px (read in "+fmt((performance.now()-t0)/1000,1)+' s)');return v}
 finally{CARGAS.delete(u)}
}
async function obtenerValores(){const v=await cargarValores();
 if(!H||v.w!==H.w||v.h!==H.h)throw new Error("the map mide "+v.w+'×'+v.h+"; mask "+(H?H.w+'×'+H.h:'—')+": Value tools deshabilitadas");return v}
/* ---------- 8. límite del pincel inteligente: el mapa de la máscara y, en la vista de modelos, los de los paneles ---------- */
let LIM=null,PREP=null;   /* LIM = {clave,w,h,lo,hi,ok,nombres,fuera}: lo = mínimo y hi = máximo de los mapas; ok = con datos en todos */
const modeloDe=g=>(typeof meta==='function'&&meta(g).modelo)||g.id;
function mapasLimite(){const g=grupoMascara(),u0=urlMapaDe(g);if(!u0)return [];const out=[{g,url:u0,nombre:modeloDe(g)}];
 if(panelesAbiertos()&&typeof grupoDeModelo==='function')for(const p of PANES){if(!p.modelo)continue;const gp=grupoDeModelo(p.modelo),u=urlMapaDe(gp);
  if(gp&&u&&!out.some(o=>o.url===u))out.push({g:gp,url:u,nombre:modeloDe(gp)})}
 return out}
function mismaGrillaQue(a,b){if(String(correccionDe(a))!==String(correccionDe(b)))return false;const ca=a.catalogMeta,cb=b.catalogMeta;
 if(!ca||!cb)return !ca&&!cb;   /* hojas del kit: mismo raster para todos sus modelos */
 return ca.lam===cb.lam&&(ca.cara||'')===(cb.cara||'')&&((a.meshAssociation||{}).meshSha256||'')===((b.meshAssociation||{}).meshSha256||'')}
const claveLimite=ms=>ms.map(m=>m.url).join('|');
function limiteListo(){const L=LIM;return L&&H&&L.w===H.w&&L.h===H.h&&L.clave===claveLimite(mapasLimite())?L:null}
function prepararLimite(){const ms=mapasLimite();if(!ms.length)return Promise.reject(new Error("This depth has no map"));
 const clave=claveLimite(ms);if(LIM&&H&&LIM.clave===clave&&LIM.w===H.w&&LIM.h===H.h)return Promise.resolve(LIM);
 if(PREP&&PREP.clave===clave)return PREP.p;
 const p=(async()=>{const usar=[],fuera=[];
  for(const m of ms){const v=await cargarValoresDe(m.url);
   if(!H||v.w!==H.w||v.h!==H.h){if(m===ms[0])throw new Error("the map mide "+v.w+'×'+v.h+"; mask "+(H?H.w+'×'+H.h:'—'));fuera.push(m.nombre+' (mide '+v.w+'×'+v.h+')');continue}
   if(m!==ms[0]&&!mismaGrillaQue(m.g,ms[0].g)){fuera.push(m.nombre+" (another grid)");continue}
   usar.push({m,v})}
  const w=usar[0].v.w,h=usar[0].v.h;
  if(usar.length===1)return {clave,w,h,lo:usar[0].v.val,hi:usar[0].v.val,ok:usar[0].v.ok,nombres:[usar[0].m.nombre],fuera};
  const n=w*h,lo=new Uint8Array(n).fill(255),hi=new Uint8Array(n),ok=new Uint8Array(n).fill(1);
  for(const {v} of usar){const a=v.val,o=v.ok;for(let i=0;i<n;i++){if(!o[i]){ok[i]=0;continue}const q=a[i];if(q<lo[i])lo[i]=q;if(q>hi[i])hi[i]=q}}
  return {clave,w,h,lo,hi,ok,nombres:usar.map(u=>u.m.nombre),fuera}})();
 PREP={clave,p};pintarLimite();
 return p.then(L=>{if(PREP&&PREP.clave===clave)PREP=null;LIM=L;pintarLimite();return L},e=>{if(PREP&&PREP.clave===clave)PREP=null;pintarLimite();throw e})}
function pintarLimite(){const el=$h('htIntMapas');if(!el)return;const ms=mapasLimite(),L=limiteListo();
 if(!ms.length){el.textContent='';return}
 const nombres=L?L.nombres:ms.map(m=>m.nombre);
 el.textContent="Scope: "+nombres.join(' ∧ ')+(L?(L.fuera.length?"; excluded: "+L.fuera.join(', '):''):PREP?" (reading maps…)":" (read when using smart brush)");
 el.title=nombres.length>1?"With multiple maps, use the strictest value: ink only where every map ≥ T; non-ink only where every map < t. Missing-data pixels are not painted."
  :"Single map: ink where map ≥ T; non-ink where map < t."}

/* ---------- vista y zona (grilla original) ---------- */
function recortar(x0,y0,x1,y1){x0=Math.max(0,Math.floor(x0));y0=Math.max(0,Math.floor(y0));x1=Math.min(H.w,Math.ceil(x1));y1=Math.min(H.h,Math.ceil(y1));
 return x1>x0&&y1>y0?[x0,y0,x1,y1]:null}
/* lo que se ve (sin el panel, que tapa la derecha): esquinas de la caja -> vista de la imagen -> grilla. Las orientaciones son
   trasposiciones/espejos, así que el rectángulo de las dos esquinas llevadas a la grilla es exacto. */
function rectVista(){
 const cu=cajaUtil(),pn=$h('panel');let W=cu[0];const Hc=cu[1];
 if(pn&&!pn.hidden&&!panelesAbiertos()){const r=vp.getBoundingClientRect(),q=pn.getBoundingClientRect();   /* 25-sep: el panel ya no tapa el viewport; solo se descuenta si flota encima (pantallas angostas) */
  W=Math.max(1,W-Math.max(0,Math.min(r.right,q.right)-Math.max(r.left,q.left)))}
 const o=oriEf(group),a=oriAGrilla(o,curW,curH,-x/zoom,-y/zoom),b=oriAGrilla(o,curW,curH,(W-x)/zoom,(Hc-y)/zoom);
 return recortar(Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1]))}
function dibujarZona(r){const ov=$h('regionOverlay');if(!ov)return;let el=$h('htZona');
 if(!r||!etiqOn){if(el)el.remove();return}
 if(!el){el=document.createElementNS('http://www.w3.org/2000/svg','rect');el.id='htZona';ov.append(el)}
 el.setAttribute('x',r[0]);el.setAttribute('y',r[1]);el.setAttribute('width',r[2]-r[0]);el.setAttribute('height',r[3]-r[1])}
function zonaTemporal(a,b){dibujarZona(a&&b?[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]:ZONA)}
function fijarZona(a,b){
 const r=recortar(Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1]));
 if(!r||r[2]-r[0]<3||r[3]-r[1]<3){dibujarZona(ZONA);estado("Region too small: drag a rectangle",true);return}
 ZONA=r;CFG.dentro='zona';dibujarZona(ZONA);fijarHerr(HERR_ANT==='varita'?'varita':'');pintarUI();
 estado("Region of "+ent(r[2]-r[0])+'×'+ent(r[3]-r[1])+' px ('+fmt((r[2]-r[0])*(r[3]-r[1])*mm2Actual())+" mm²): wand and threshold operate inside it");
 recalcular()}
function quitarZona(){ZONA=null;dibujarZona(null);if(CFG.dentro==='zona')CFG.dentro='vista';pintarUI();recalcular()}

/* ---------- selección ---------- */
/* ¿el píxel j (RGBA de la máscara) cambia al asignarle `clase`? sin «pisar», solo se toca lo sin etiquetar; borrar solo lo etiquetado */
function cambiaPx(d,j,clase,sobre){const et=d[j+3]>=128,esT=et&&d[j+1]>d[j];
 if(clase==='borrar')return et;
 if(et&&!sobre)return false;
 return clase==='tinta'?!esT:!(et&&!esT)}
/* relleno 4-conexo por renglones sobre la máscara binaria m (w×h) desde (sx,sy) */
function relleno4(m,w,h,sx,sy){const out=new Uint8Array(w*h);if(!m[sy*w+sx])return out;const pila=[sx,sy];
 while(pila.length){const py=pila.pop(),px=pila.pop(),f=py*w;if(out[f+px]||!m[f+px])continue;
  let l=px;while(l>0&&m[f+l-1]&&!out[f+l-1])l--;let r=px;while(r<w-1&&m[f+r+1]&&!out[f+r+1])r++;
  for(let k=l;k<=r;k++)out[f+k]=1;
  for(const ny of [py-1,py+1]){if(ny<0||ny>=h)continue;const f2=ny*w;let k=l;
   while(k<=r){if(m[f2+k]&&!out[f2+k]){pila.push(k,ny);while(k<=r&&m[f2+k]&&!out[f2+k])k++}else k++}}}
 return out}
function unir(A,B){const x0=Math.min(A.x0,B.x0),y0=Math.min(A.y0,B.y0),x1=Math.max(A.x0+A.w,B.x0+B.w),y1=Math.max(A.y0+A.h,B.y0+B.h),w=x1-x0,h=y1-y0,c=new Uint8Array(w*h);
 for(const P of [A,B])for(let yy=0;yy<P.h;yy++){const o=(P.y0+yy-y0)*w+(P.x0-x0),s=yy*P.w;for(let xx=0;xx<P.w;xx++)if(P.cambia[s+xx])c[o+xx]=1}
 let nc=0;for(let i=0;i<c.length;i++)nc+=c[i];const partes=(A.partes||1)+1;
 return {nombre:A.nombre,x0,y0,w,h,cambia:c,nc,nsel:nc,clase:A.clase,desc:"wand · "+partes+' selecciones sumadas',orig:B.orig,sobre:A.sobre,union:true,partes}}
function calcular(orig,sumar){
 if(!H||!mctx||!group||!mascaraLista())return estado('Wait for the full-resolution image and mask',true);
 if(panelesAbiertos())return estado("Close split panels to use wand, region and threshold previews; smart brush still works",true);
 const du=dueno();if(du&&du.group!==group&&String(correccionDe(du.group))!==String(correccionDe(group)))return estado("Wait for the run to finish loading",true);
 const V=valoresListos();
 if(!V){const nom=H.nombre;obtenerValores().then(()=>{if(H&&H.nombre===nom&&valoresListos())calcular(orig,sumar)}).catch(e=>estado("Could not read the map: "+e.message,true));return}
 let A;
 if(CFG.dentro==='zona'){if(!ZONA)return estado("No region: mark one with R or select In view",true);A=ZONA}
 else{A=rectVista();if(!A)return estado("The view does not cover the segment",true)}
 const ax0=A[0],ay0=A[1],w=A[2]-A[0],h=A[3]-A[1],n=w*h;
 let lo,hi,desc,sx=-1,sy=-1;
 if(orig.tipo==='varita'){
  const gx=Math.floor(orig.g[0]),gy=Math.floor(orig.g[1]);
  if(gx<0||gy<0||gx>=V.w||gy>=V.h)return estado("The click is outside the segment",true);
  const g0=gy*V.w+gx;if(!V.ok[g0])return estado("The map has no data there (transparent)",true);
  const v0=V.val[g0];lo=Math.max(0,v0-CFG.tol);hi=Math.min(255,v0+CFG.tol);
  desc="wand "+(CFG.alcance==='conectada'?'connected':"all similar values")+"; value "+v0+' ±'+CFG.tol+' ('+lo+'–'+hi+')';
  if(CFG.alcance==='conectada'){
   if(gx<A[0]||gx>=A[2]||gy<A[1]||gy>=A[3])return estado("The click is outside "+(CFG.dentro==='zona'?"the region":"the view"),true);
   sx=gx-ax0;sy=gy-ay0}
 }else if(orig.tipo==='bajo'){if(CFG.tb<=0)return estado("t = 0: no values fall below it",true);lo=0;hi=CFG.tb-1;desc="threshold: value < t = "+CFG.tb+' ('+val01(CFG.tb)+')'}
 else{lo=CFG.ta;hi=255;desc="threshold: value ≥ T = "+CFG.ta+' ('+val01(CFG.ta)+')'}
 desc+=CFG.dentro==='zona'?" · in region":" · in view";
 let sel=new Uint8Array(n);
 for(let yy=0;yy<h;yy++){let gi=(ay0+yy)*V.w+ax0,li=yy*w;for(let xx=0;xx<w;xx++,gi++,li++)if(V.ok[gi]){const v=V.val[gi];if(v>=lo&&v<=hi)sel[li]=1}}
 if(sx>=0)sel=relleno4(sel,w,h,sx,sy);
 const md=mctx.getImageData(ax0,ay0,w,h).data,cambia=new Uint8Array(n);let nsel=0,nc=0;
 for(let i=0,j=0;i<n;i++,j+=4){if(!sel[i])continue;nsel++;if(cambiaPx(md,j,orig.clase,CFG.sobre)){cambia[i]=1;nc++}}
 let P={nombre:H.nombre,x0:ax0,y0:ay0,w,h,cambia,nc,nsel,clase:orig.clase,desc,orig,sobre:CFG.sobre,union:false};
 if(sumar&&PREV&&PREV.nombre===P.nombre&&PREV.clase===P.clase&&PREV.sobre===P.sobre)P=unir(PREV,P);
 PREV=P;pintarPrev();
 estado(P.nc?"Enter applies; Esc cancels"+(orig.tipo==='varita'?"; Shift+click adds another selection":''):"The selection changes nothing",!P.nc);
}
function recalcular(){if(!PREV||PREV.union)return;const o=PREV.orig;clearTimeout(tRe);tRe=setTimeout(()=>{if(PREV&&PREV.orig===o)calcular(o,false)},120)}
function varita(g,sumar){const clase=claseDelPincel();
 if(!clase)return estado("The wand uses the brush class: choose 1 ink, 2 non-ink or 3 erase (unlabelled)",true);
 calcular({tipo:'varita',g,clase},sumar)}

/* ---------- vista previa: capa del tamaño de la máscara con la matriz --ori; el lienzo solo cubre el rectángulo ---------- */
function asegurarCapa(){
 if(!CAPA){CAPA=document.createElement('div');CAPA.id='htCapa';CAPA.append(document.createElement('canvas'));
  const ov=$h('regionOverlay');if(ov&&ov.parentNode===stage)stage.insertBefore(CAPA,ov);else stage.append(CAPA)}
 CAPA.style.width=H.w+'px';CAPA.style.height=H.h+'px';return CAPA.firstChild}
function pintarPrev(){
 const box=$h('htPrevBox');
 if(!PREV||!H||PREV.nombre!==H.nombre){if(CAPA){CAPA.hidden=true;const c=CAPA.firstChild;c.width=c.height=0}if(box)box.hidden=true;return}
 const P=PREV,cv=asegurarCapa();CAPA.hidden=false;
 cv.width=P.w;cv.height=P.h;cv.style.left=P.x0+'px';cv.style.top=P.y0+'px';
 const g=cv.getContext('2d'),img=g.createImageData(P.w,P.h),d=img.data,col=P.clase==='borrar'?[0,229,255]:[255,214,0];
 for(let i=0,j=0;i<P.cambia.length;i++,j+=4)if(P.cambia[i]){d[j]=col[0];d[j+1]=col[1];d[j+2]=col[2];d[j+3]=255}
 g.putImageData(img,0,0);
 if(box){box.hidden=false;
  const resto=P.nsel-P.nc,nota=resto>0?' · '+ent(resto)+" selected pixels already had this label"+(P.sobre||P.clase==='borrar'?'':" or were already labelled (not overwritten)"):'';
  $h('htPrevTxt').innerHTML="<b>preview</b> · "+esc(P.desc)+'<br>'+(P.nc?'<b>'+ent(P.nc)+'</b> px ('+fmt(P.nc*mm2Actual(),3)+' mm²) → <b>'+esc(NOMBRE[P.clase])+'</b>'+esc(nota):"Nothing to change"+esc(nota));
  $h('htAplicar').disabled=!P.nc}}
function cancelarPrev(txt){if(!PREV)return;PREV=null;pintarPrev();if(txt)estado(txt)}
function agendarGuardado(){   /* el mismo temporizador de 20 s de etiq_extra.js (escucha pointerup en #viewport): un solo guardado */
 if(typeof pintar!=='undefined'&&pintar)return;try{vp.dispatchEvent(new PointerEvent('pointerup',{pointerId:-25}))}catch(e){}}
function aplicarPrev(){
 if(!mascaraLista())return estado('Wait for the full-resolution image and mask',true);
 const P=PREV;if(!P)return;
 if(!H||!mctx||H.nombre!==P.nombre){cancelarPrev("Preview discarded: the mask changed");return}
 if(!P.nc){cancelarPrev("Nothing to apply");return}
 prepararUndo();bbox=[P.x0,P.y0,P.x0+P.w,P.y0+P.h];redoS=[];
 const im2=mctx.getImageData(P.x0,P.y0,P.w,P.h),d=im2.data,col=COLOR[P.clase];let n=0;
 for(let i=0,j=0;i<P.cambia.length;i++,j+=4){if(!P.cambia[i]||!cambiaPx(d,j,P.clase,P.sobre))continue;   /* se re-verifica contra la máscara de AHORA */
  if(P.clase==='borrar'){d[j]=d[j+1]=d[j+2]=d[j+3]=0}else{d[j]=col[0];d[j+1]=col[1];d[j+2]=col[2];d[j+3]=255}n++}
 mctx.putImageData(im2,P.x0,P.y0);
 guardarUndo();dirty=true;autoguardar();contar();espejarMascara();
 PREV=null;pintarPrev();
 if(n){marcarEdicion();s3Pend=true;if(typeof mskGuardarPronto==='function')mskGuardarPronto();agendarGuardado()}
 msg(P.desc+': '+ent(n)+' px → '+NOMBRE[P.clase]+" (Ctrl+Z undoes)");
 estado("Applied: "+ent(n)+' px ('+fmt(n*mm2Actual(),3)+' mm²) → '+NOMBRE[P.clase]+" · Ctrl+Z undoes")}

/* ---------- confirmación en el panel ---------- */
function pedirConf(txt,fn){CONF=fn;$h('htConfTxt').textContent=visorTexto(txt);$h('htConf').hidden=false}
function cerrarConf(){CONF=null;const c=$h('htConf');if(c)c.hidden=true}

/* ---------- meta: mm² y trazos (componentes 8-conexas de tinta) sobre la máscara completa ---------- */
function componentes(bin,w,h,min){const vis=new Uint8Array(w*h),pila=[];let n=0,motas=0;
 for(let i=0;i<w*h;i++){if(!bin[i]||vis[i])continue;let area=0;pila.length=0;pila.push(i%w,(i/w)|0);
  while(pila.length){const py=pila.pop(),px=pila.pop(),f=py*w;if(vis[f+px]||!bin[f+px])continue;
   let l=px;while(l>0&&bin[f+l-1]&&!vis[f+l-1])l--;let r=px;while(r<w-1&&bin[f+r+1]&&!vis[f+r+1])r++;
   for(let k=l;k<=r;k++)vis[f+k]=1;area+=r-l+1;const l2=Math.max(0,l-1),r2=Math.min(w-1,r+1);
   for(const ny of [py-1,py+1]){if(ny<0||ny>=h)continue;const f2=ny*w;let k=l2;
    while(k<=r2){if(bin[f2+k]&&!vis[f2+k]){pila.push(k,ny);while(k<=r2&&bin[f2+k]&&!vis[f2+k])k++}else k++}}}
  if(area>=min)n++;else motas++}
 return {n,motas}}
function agendarMeta(){clearTimeout(tMeta);tMeta=setTimeout(calcularMeta,700)}
function calcularMeta(){
 const el=$h('htMeta');if(!el)return;
 if(!H||!mctx||!mask||!mask.width){el.innerHTML="<span class=\"muted\">No mask</span>";return}
 if(typeof etiqOn!=='undefined'&&!etiqOn)return;
 const W=H.w,Hh=H.h,n=W*Hh,d=mctx.getImageData(0,0,W,Hh).data,bin=new Uint8Array(n);let t=0,no=0;
 for(let i=0,j=3;i<n;i++,j+=4){if(d[j]<128)continue;if(d[j-2]>d[j-3]){bin[i]=1;t++}else no++}
 pintarMeta(t,no,componentes(bin,W,Hh,MIN_TRAZO))}
function pintarMeta(t,no,c){
 const UM=umActual(),el=$h('htMeta'),sm=(t+no)*mm2Actual(),okS=sm>=META.mm2,okT=c.n>=META.trazos,pc=v=>Math.min(100,Math.round(v*100));
 if(UM==null){el.textContent='supervised '+ent(t+no)+' px · ink '+ent(t)+' px · non-ink '+ent(no)+' px · '+ent(c.n)+' strokes · physical scale unknown';el.title='Provide source calibration to measure physical areas';return}
 el.innerHTML=
  '<div class="htFila'+(okS?' htOk':'')+"\"><span>supervised</span><b>"+fmt(sm)+'</b><span>/ '+META.mm2+' mm²'+(okS?' ✓':'')+'</span></div>'+
  '<div class="htBarra'+(okS?' ok':'')+'"><i style="width:'+pc(sm/META.mm2)+'%"></i></div>'+
  '<div class="htFila'+(okT?' htOk':'')+"\"><span>strokes</span><b>"+ent(c.n)+'</b><span>/ '+META.trazos+(okT?' ✓':'')+'</span></div>'+
  '<div class="htBarra'+(okT?' ok':'')+'"><i style="width:'+pc(c.n/META.trazos)+'%"></i></div>'+
  "<div class=\"muted\">ink "+fmt(t*mm2Actual())+" mm² · non-ink "+fmt(no*mm2Actual())+' mm²'+(c.motas?' · '+ent(c.motas)+" specks &lt;"+MIN_TRAZO+" px (not counted)":'')+'</div>';
 el.title=fmt(UM,2)+" µm per pixel: 1 px = "+fmt(UM*UM,2)+" µm². Supervised = ink + non-ink (included in supervision_mask). "+
  "Stroke = 8-connected ink component of at least "+MIN_TRAZO+' px ('+fmt(MIN_TRAZO*mm2Actual(),4)+" mm²); smaller components are specks and are not counted. "+
  "Holdout target: ≥ "+META.trazos+" strokes and ≥ "+META.mm2+" supervised mm²."}

/* ---------- corrida: info, JSON al lado del par, verificación ---------- */
function infoDeGrupo(g,c,w,h,clave){
 const t=(typeof meta==='function'&&meta(g))||{},lam=t.lam||g.id,seg=typeof segId==='function'?segId(lam):lam,
       ruta=typeof segRuta==='function'?segRuta(g):null,cor=correccionDe(g),a=oriCargada()?ORI[g.id]:null,cn=c==null||c==='max'?'max':Number(c),
       grid=g.renderGrid||(g.catalogMeta&&g.catalogMeta.render_grid)||null;
 return {formato:'vesuvius.mascara_corrida.v1',
  nota:"The mask stays in the original PNG grid. Different grid orientation or dimensions require a separate mask.",
  lamina:lam,segmento:seg,scroll:ruta?ruta.base.split('/')[0]:(g.scroll||g.catalogMeta?.scroll||window.ROLLO),base:ruta?ruta.base:null,run_id:g.id,modelo:t.modelo||null,cara:t.cara||null,
  etiqueta_corrida:g.label||null,directorio_fuente:g.sourceDirectory||null,malla_sha256:(grid&&grid.mesh_sha256)||(g.meshAssociation&&g.meshAssociation.meshSha256)||null,
  grid_id:grid&&grid.grid_id||null,render_grid:grid,
  ancho:w,alto:h,um_por_px:umDe(g),profundidad:cn,carpeta_profundidad:cn==='max'?null:cStr(cn),
  orientacion:{correccion:cor,clase:a?String(a[3]||''):(cor?'SIN_CORRECCION':'DESCONOCIDA'),
   regla:"Orientation metadata: [transpose, flip rows, flip columns]. Zero means reading orientation or no inventory entry; null means the inventory could not be read."},
  vista_al_guardar:{corregida:!!(ORI_AUTO&&a),voltear_filas:!!(VOLT&&VOLT.f),voltear_columnas:!!(VOLT&&VOLT.c),nota:"Display only; the mask grid is unchanged"},
  ...(globalThis.recorteVista&&globalThis.recorteVista.info()?{recorte:globalThis.recorteVista.info()}:{}),
  clave_local:clave||null,archivos:[seg+'_inklabels.png',seg+'_supervision_mask.png']}}
/* datos de la corrida DUEÑA de la máscara, tomados en el momento de llamar (index.html los pide al empezar un guardado) */
window.mascaraCorridaInfo=function(cen,w,h){if(!H)return null;const g=grupoMascara();if(!g)return null;
 return infoDeGrupo(g,cen!=null?String(cen):centroMascara(),w||H.w,h||H.h,H.nombre)};
/* Los mismos datos van DENTRO de cada PNG del par (fragmento iTXt 'vesuvius:mascara_corrida'; los lectores de imagen lo ignoran,
   PIL lo muestra en Image.open(f).text). Así la máscara lleva su corrida aunque el JSON de al lado no se pueda guardar: el
   catalog_writer de work-3 (25-sep) solo acepta .png en labels/. Sin fecha adentro: guardar dos veces lo mismo da los mismos bytes. */
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc32=u8=>{let c=0xFFFFFFFF;for(let i=0;i<u8.length;i++)c=CRC[(c^u8[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0};
const CLAVE_PNG='vesuvius:mascara_corrida';
window.pngConCorrida=async function(blob,info){
 {const b=new Uint8Array(await blob.arrayBuffer()),n=b.length,te=new TextEncoder();
  if(!info||n<33||![137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v)||String.fromCharCode(b[n-8],b[n-7],b[n-6],b[n-5])!=='IEND')throw new Error('PNG export requires valid image and mask provenance');
  const header=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(header.getUint32(16)!==info.ancho||header.getUint32(20)!==info.alto)throw new Error('PNG dimensions do not match captured mask provenance');
  const kw=te.encode(CLAVE_PNG),txt=te.encode(JSON.stringify(info)),data=new Uint8Array(kw.length+5+txt.length);
  data.set(kw,0);data.set(txt,kw.length+5);   /* keyword \0 · sin comprimir (0,0) · idioma '' \0 · clave traducida '' \0 · texto UTF-8 */
  const tipo=te.encode('iTXt'),tc=new Uint8Array(4+data.length);tc.set(tipo,0);tc.set(data,4);
  const ch=new Uint8Array(12+data.length),dv=new DataView(ch.buffer);dv.setUint32(0,data.length);ch.set(tc,4);dv.setUint32(8+data.length,crc32(tc));
  const out=new Uint8Array(n+ch.length);out.set(b.subarray(0,n-12),0);out.set(ch,n-12);out.set(b.subarray(n-12),n-12+ch.length);
  return new Blob([out],{type:'image/png'})}};
function corridaDePNG(u8){   /* busca el iTXt de arriba en los bytes de un PNG (entero o solo su cola) */
 const kw=new TextEncoder().encode(CLAVE_PNG+'\0');
 for(let i=u8.length-8;i>=4;i--){if(u8[i]!==0x69||u8[i+1]!==0x54||u8[i+2]!==0x58||u8[i+3]!==0x74)continue;
  const len=((u8[i-4]<<24)|(u8[i-3]<<16)|(u8[i-2]<<8)|u8[i-1])>>>0,d=u8.subarray(i+4,i+4+len);if(d.length<len)continue;
  let ok=true;for(let j=0;j<kw.length;j++)if(d[j]!==kw[j]){ok=false;break}if(!ok)continue;
  let o=kw.length+2;while(o<d.length&&d[o]!==0)o++;o++;while(o<d.length&&d[o]!==0)o++;o++;
  try{return JSON.parse(new TextDecoder().decode(d.subarray(o)))}catch(e){return null}}
 return null}
window.corridaDePNG=corridaDePNG;
window.guardarCorridaJson=async function(info,revision){const el=$h('htCorridaEst');
 GUARDADA[claveG(info)]=info;   /* el par ya se guardó y lleva estos datos adentro */
 {const kp=clavePorInfo(info);if(PEND[kp]&&PEND[kp]===revision){delete PEND[kp];guardarPend()}pintarPendiente()}   /* Only the captured edit revision was saved; newer strokes stay pending. */
 if(el){el.textContent="Mask pair and provenance saved together · "+info.run_id+' · '+(info.carpeta_profundidad||'max');el.classList.remove('htAviso')}
 pintarCorrida();return true};
/* lo que work-3 ya tiene para esta lámina y profundidad (su JSON de corrida), leído al montar: si es de OTRA grilla, el guardado
   (a mano o el automático de 20 s) NO lo reemplaza sin confirmar. undefined = no se sabe (no se leyó): se guarda como siempre. */
const GUARDADA={},PERMISO=new Set();
const claveG=info=>(info.scroll?info.scroll+'|':'')+info.segmento+'|'+(info.carpeta_profundidad||'max');
async function leerGuardada(){
 const info=H&&window.mascaraCorridaInfo(null,H.w,H.h);if(!info||info.profundidad==='max')return;
 const k=claveG(info);
 try{const par=await obtenerParMascara(info.segmento,info.profundidad,info.base,false,info.scroll,true);
  GUARDADA[k]=par.corrida||{sinJson:true}}
 catch(e){if(/HTTP (204|404)$/.test(e.message))GUARDADA[k]=null}
 pintarCorrida()}
/* ---------- ediciones pendientes (coordinador 25-sep): se sube a work-3 solo una profundidad que ALGUIEN editó ----------
   El auto-guardado de etiq_extra.js salta 20 s después de CUALQUIER pointerup en modo etiqueta (también al mover la vista):
   sin este registro subía lienzos sin cambios (p. ej. una máscara automática recién cargada como «corregida»). Marcan edición
   solo las acciones humanas: trazos, región (4), fondo alrededor, deshacer/rehacer, varita/umbral, paste JSON e import PNG. No
   marcan: abrir, importar propuesta, cargar la guardada. Clave = la del lienzo (IndexedDB); persiste en localStorage hasta que
   esa profundidad se sube bien, así un recargue no pierde lo pendiente. */
const KP=visorKey('vesuvius.etiq.pendientes.v1');let PEND={};
try{const s=JSON.parse(localStorage.getItem(KP)||'{}');if(s&&typeof s==='object')PEND=s}catch(e){}
const rolloPendInicial=window.ROLLO||'';
const clavePend=(nombre,scroll=H?.scroll||window.ROLLO||'')=>{const key=scroll?scroll+'|'+nombre:nombre;return !PEND[key]&&scroll===rolloPendInicial&&PEND[nombre]?nombre:key};
const guardarPend=()=>{try{localStorage.setItem(KP,JSON.stringify(PEND))}catch(e){}};
function marcarEdicion(){if(!H||!H.nombre)return;PEND[clavePend(H.nombre)]=Math.max(Date.now(),(PEND[clavePend(H.nombre)]||0)+1);guardarPend();pintarPendiente()}
const clavePorInfo=info=>clavePend(String(info.clave_local||'').replace(/\|c[^|]*$/,'')+'|c'+(info.profundidad==='max'?'max':String(info.profundidad)),info.scroll||H?.scroll||window.ROLLO||'');
window.revisionMascara=info=>PEND[clavePorInfo(info)]||0;
function pintarPendiente(){const el=$h('htPend');if(!el)return;const p=!!(H&&PEND[clavePend(H.nombre)]);
 el.textContent=p?(visorPuedeGuardar?visorTexto("Unsaved changes for this depth in annotation storage"):"Changes saved only in this browser"):'';el.hidden=!p}
/* ---------- lienzo de la GRILLA (25-sep, bug BASE/r3f): se le suman los lienzos viejos por corrida ----------
   Hasta hoy cada corrida del catálogo guardaba su lienzo como run_xxx|c<N>; ahora las hermanas de la misma grilla comparten
   uno (index.html/claveLienzo). Al abrir una profundidad se le suman los lienzos viejos de las HERMANAS (misma lámina, cara,
   corrección de orientación y sha de malla; las medidas se comprueban en cada PNG): el más pintado primero y los demás solo
   donde sigue sin etiquetar, nunca encima de lo pintado. Las otras profundidades de esas corridas se suman igual, en segundo
   plano. Cada lienzo viejo se suma UNA vez (localStorage guarda cuál y con qué tamaño en bytes; si cambió, se vuelve a sumar),
   así lo que se borre después en el lienzo de la grilla no reaparece. Los lienzos viejos NO se borran ni se escriben nunca.
   Si alguno tenía cambios sin subir a work-3, el pendiente pasa al lienzo de la grilla. */
const KMIG=visorKey('vesuvius.lienzos.migrados.v1');let MIG={};
try{const s=JSON.parse(localStorage.getItem(KMIG)||'{}');if(s&&typeof s==='object')MIG=s}catch(e){}
const guardarMig=()=>{try{localStorage.setItem(KMIG,JSON.stringify(MIG))}catch(e){}};
const partir=k=>{const m=/^(.*)\|c([^|]*)$/.exec(String(k||''));return m?{base:m[1],cen:m[2]}:null};
const claveMig=(nombre,store=db)=>{const key=store.scroll?store.scroll+'|'+nombre:nombre;return !MIG[key]&&store.scroll===rolloPendInicial&&MIG[nombre]?nombre:key};
const MIGRANDO=new Set();   /* bases de grilla cuyas otras profundidades ya se revisaron en esta sesión */
function hermanasDe(g){const cm=g&&g.catalogMeta;if(!cm||!oriCargada()||typeof manifest==='undefined')return [];
 const sha=(g.meshAssociation||{}).meshSha256||'',cor=String(correccionDe(g)),cara=cm.cara||'';
 return manifest.filter(q=>{const c2=q.catalogMeta;return !!c2&&visorRolloDe(q)===visorRolloDe(g)&&c2.lam===cm.lam&&(c2.cara||'')===cara&&((q.meshAssociation||{}).meshSha256||'')===sha&&String(correccionDe(q))===cor})}
const clavesIdb=()=>db.then(d=>new Promise((ok,er)=>{const rq=d.transaction('m','readonly').objectStore('m').getAllKeys();rq.onsuccess=()=>ok(rq.result||[]);rq.onerror=()=>er(rq.error)}));
/* base de grilla del lienzo `nombre` si es de la corrida principal y la clave nueva está activa; si no, null */
function baseDeGrilla(nombre){const p=partir(nombre),g=group;if(!p||!g||!g.catalogMeta||!window.lienzoPorGrilla||typeof window.claveLienzo!=='function')return null;
 return p.base!==g.id&&window.claveLienzo(g,curW||(H&&H.w),curH||(H&&H.h))===p.base?p.base:null}
/* lienzos viejos de las hermanas para la profundidad `cen` que todavía no se sumaron a `dest` (o que cambiaron desde entonces) */
async function viejasPara(dest,cen,ids,claves,store=db){const hechas=MIG[claveMig(dest,store)]||{},out=[];
 for(const id of ids){const k=id+'|c'+cen;if(!claves.includes(k))continue;
  const b=await idb('readonly',s=>s.get(k),store).catch(()=>null);if(b&&hechas[k]!==b.size)out.push({k,b})}
 return out}
async function decodificar(viejas,w,h){const r=[];
 for(const v of viejas){const bm=await createImageBitmap(v.b).catch(()=>null);if(!bm)continue;
  if(bm.width!==w||bm.height!==h){v.otra=bm.width+'×'+bm.height;if(bm.close)bm.close();continue}v.bm=bm;r.push(v)}
 return r}
/* SIN await adentro: nadie puede pintar entre la lectura y la escritura del lienzo `cx` */
function sumarEn(cx,w,h,lista){const t=document.createElement('canvas');t.width=w;t.height=h;const tg=t.getContext('2d',{willReadFrequently:true});
 const datos=v=>{tg.clearRect(0,0,w,h);tg.drawImage(v.bm,0,0);return tg.getImageData(0,0,w,h).data};
 for(const v of lista){const d=datos(v);let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>=128)n++;v.n=n}
 const usar=lista.filter(v=>v.n>0).sort((a,b)=>b.n-a.n);let puestos=0;
 if(usar.length){const out=cx.getImageData(0,0,w,h),o=out.data;
  for(const v of usar){const s=datos(v);for(let i=0;i<o.length;i+=4)if(o[i+3]<128&&s[i+3]>=128){o[i]=s[i];o[i+1]=s[i+1];o[i+2]=s[i+2];o[i+3]=s[i+3];puestos++}}
  if(puestos)cx.putImageData(out,0,0)}
 t.width=t.height=0;for(const v of lista)if(v.bm&&v.bm.close)v.bm.close();
 return {usar,puestos}}
function anotarMigracion(dest,viejas,store=db){const key=claveMig(dest,store),r=MIG[key]=MIG[key]||{};let p=0;
 for(const v of viejas){r[v.k]=v.b.size;if(PEND[clavePend(v.k,store.scroll)])p=Math.max(p,PEND[clavePend(v.k,store.scroll)])}
 guardarMig();if(p){PEND[clavePend(dest,store.scroll)]=Math.max(PEND[clavePend(dest,store.scroll)]||0,p);guardarPend();pintarPendiente()}}
async function migrarLienzo(nombre){
 const store=db,g0=group,h0=H;const base=baseDeGrilla(nombre);if(!base||!H||H.nombre!==nombre||!mctx)return;
 const ids=hermanasDe(group).map(q=>q.id);if(!ids.length)return;
 const claves=await clavesIdb().catch(()=>null);if(!claves||H!==h0||group!==g0||H.nombre!==nombre)return;
 const cen=partir(nombre).cen,w=H.w,h=H.h,vigente=()=>H===h0&&group===g0&&H.nombre===nombre&&!!mctx;
 const viejas=await viejasPara(nombre,cen,ids,claves,store);
 if(viejas.length){const lista=await decodificar(viejas,w,h);if(!vigente()){lista.forEach(v=>v.bm&&v.bm.close&&v.bm.close());return}
  const r=sumarEn(mctx,w,h,lista);anotarMigracion(nombre,viejas,store);
  if(r.puestos){dirty=true;autoguardar();contar();espejarMascara();
   const de=r.usar.map(v=>v.k.split('|')[0]+' ('+ent(v.n)+' px)').join(' + ');
   msg("Mask at "+cStr(cen)+' recuperada de '+de+": now shared by runs with the same grid");
   estado("Mask at "+cStr(cen)+" recovered from run canvases ("+de+"); original canvases remain intact in this browser")}
  const otras=viejas.filter(v=>v.otra);if(otras.length)estado("Canvases with different dimensions were not merged: "+otras.map(v=>v.k+' '+v.otra).join(', '),true)}
 if(!MIGRANDO.has(claveMig(base,store))){MIGRANDO.add(claveMig(base,store));migrarResto(base,ids,claves,w,h,store).catch(e=>console.warn('migración de lienzos:',e))}}
async function migrarResto(base,ids,claves,w,h,store=db){   /* las otras profundidades, sin montarlas */
 const cens=new Set();for(const k of claves){const p=partir(k);if(p&&ids.includes(p.base))cens.add(p.cen)}
 for(const cen of cens){const dest=base+'|c'+cen;if(H&&H.database===store&&H.nombre===dest)continue;   /* la montada la resuelve su propio montaje */
  const viejas=await viejasPara(dest,cen,ids,claves,store);if(!viejas.length)continue;
  const lista=await decodificar(viejas,w,h);
  const c=document.createElement('canvas');c.width=w;c.height=h;const cx=c.getContext('2d',{willReadFrequently:true});
  const previo=await idb('readonly',s=>s.get(dest),store).catch(()=>null);
  if(previo){const bm=await createImageBitmap(previo).catch(()=>null);if(bm){if(bm.width===w&&bm.height===h)cx.drawImage(bm,0,0);if(bm.close)bm.close()}}
  const r=sumarEn(cx,w,h,lista);
  if(r.puestos){const blob=await new Promise(ok=>c.toBlob(ok,'image/png'));
   if(!blob||(H&&H.database===store&&H.nombre===dest)){c.width=c.height=0;continue}   /* se montó mientras tanto: la resuelve su montaje */
   await idb('readwrite',s=>s.put(blob,dest),store);anotarMigracion(dest,viejas,store);
   msg("Mask at "+cStr(cen)+" also migrated to the grid canvas")}
  else anotarMigracion(dest,viejas,store);
  c.width=c.height=0}}
/* Veto (index.html lo consulta al empezar CADA subida, con los datos tomados en ese momento):
   1. sin dueño conocido, o la clave del lienzo no es de la corrida dueña -> no se sube (nunca con otra lámina);
   2. medidas del PNG distintas de las de la corrida dueña -> no se sube;
   3. esa profundidad no tiene ediciones pendientes -> no se sube ('sin cambios…');
   4. work-3 guarda UN par por lámina y profundidad; el lienzo es uno por GRILLA (7.): guardar desde una corrida de OTRA grilla,
      o desde una sin datos para comparar, reemplaza aquella máscara por este lienzo (con otra grilla quedaría espejada; con un
      lienzo casi vacío pisaría horas de trabajo). Se pide confirmar una vez por lámina y profundidad en esta sesión. Desde la
      corrida hermana de la MISMA grilla (misma lámina, cara, medidas, orientación y sha) es la misma máscara: no se pregunta. */
window.vetoGuardado=function(info){
 if(!info)return "Not uploaded: the mask run is unknown";
 const du=dueno();
 if(!du||!du.group||du.group.id!==info.run_id)return "Not uploaded: mask has no known run binding; wait for loading to finish";
 const k0=String(info.clave_local||'').replace(/\|c[^|]*$/,''),h0=typeof hojaDe==='function'?hojaDe(du.group.id):null,
       esperado=(typeof window.claveLienzo==='function'?window.claveLienzo(du.group,du.w,du.h):(h0&&h0.nombre||(typeof baseId==='function'?baseId(du.group.id):du.group.id)))+(globalThis.recorteVista?globalThis.recorteVista.key():'');   /* a crop's canvas key carries its window */
 if(k0!==esperado)return "Not uploaded: canvas ("+k0+") does not belong to run "+du.group.id+" (another segment or grid)";
 if(+info.ancho!==+du.w||+info.alto!==+du.h)return "Not uploaded: mask dimensions "+info.ancho+'×'+info.alto+"; run dimensions "+du.w+'×'+du.h;
 const kp=clavePorInfo(info);
 if(!PEND[kp])return "No changes at "+(info.carpeta_profundidad||'max')+" since the last save: not uploaded (this depth was not edited)";
 const k=claveG(info),sc=GUARDADA[k];
 if(!sc||sc.sinJson||PERMISO.has(k)||sc.run_id===info.run_id||hermanaMismaGrilla(sc,info))return null;   /* sin datos de corrida no se sabe de quién es: se guarda como siempre */
 const v=verificar(sc,info),otraGrilla=v.ok===false;
 s3Pend=true;setTimeout(()=>{s3Pend=true},0);   /* sigue pendiente (IndexedDB tiene los trazos, work-3 no); diferido porque el auto-guardado de etiq_extra.js lo apaga justo después de su clic */
 const txt="Annotation storage already has at "+(info.carpeta_profundidad||'max')+" a mask saved from "+v.txt+". Saving from this run REPLACES it with this canvas (the previous version stays in history)."+
  (otraGrilla?'':" To continue the same mask in this run, cancel and load the saved mask first.");
 const el=$h('htCorridaEst');if(el){el.textContent=visorTexto("NOT saved: "+txt+" Confirm in Value tools.");el.classList.add('htAviso')}
 pedirConf(txt+" Replace?",()=>{PERMISO.add(k);const b=$h('guardarMascaraServidor');if(b&&!b.disabled)b.click()});
 return "Confirmation required to replace a mask saved from "+v.txt};
const claveGrilla=s=>{const c=s&&s.orientacion&&s.orientacion.correccion;return Array.isArray(c)&&c.length>=3&&c.slice(0,3).every(v=>v===0||v===1)?c.slice(0,3).join(','):null};
function descGrilla(s){const c=s&&s.orientacion&&s.orientacion.correccion;
 if(!Array.isArray(c))return "unknown orientation";if(!+c[0]&&!+c[1]&&!+c[2])return "direct (no recorded correction)";
 return String(s.orientacion.clase||'corregida').toLowerCase().replace(/_/g,' ')+" relative to reading orientation"}
function verificar(sc,cur){
 if(!sc||typeof sc!=='object'||!cur)return {ok:null,txt:"Missing mask metadata: sheet, sample, depth and grid cannot be verified"};
 const missing=[];
 if(sc.grid_id&&cur.grid_id&&sc.grid_id!==cur.grid_id)return {ok:false,txt:'Different render grid identity'};
 if(!!sc.grid_id!==!!cur.grid_id)missing.push('render grid identity');
 for(const key of ['ancho','alto','lamina','segmento','profundidad','cara']){
  if(!Object.hasOwn(sc,key)||!Object.hasOwn(cur,key)){missing.push(key);continue}
  if(String(sc[key])!==String(cur[key]))return {ok:false,txt:'Different '+key+': mask '+sc[key]+'; current '+cur[key]}}
 const sample=s=>s.scroll||s.rollo||s.sample||(s.base&&s.base.split('/')[0]);
 if(!sample(sc)||!sample(cur))missing.push('sample');
 else if(sample(sc)!==sample(cur))return {ok:false,txt:'Different sample: mask '+sample(sc)+'; current '+sample(cur)};
 if(sc.base&&cur.base&&sc.base!==cur.base)return {ok:false,txt:'Different segment base'};
 if(+sc.um_por_px>0&&+cur.um_por_px>0&&+sc.um_por_px!==+cur.um_por_px)return {ok:false,txt:'Different grid pixel spacing'};
 const a=claveGrilla(sc),b=claveGrilla(cur),quien="another run ("+sc.run_id+(sc.modelo?' · '+sc.modelo:'')+')';
 if(a==null||b==null)missing.push('grid orientation');
 else if(a!==b)return {ok:false,txt:quien+" with a DIFFERENT grid ("+descGrilla(sc)+' vs '+descGrilla(cur)+"): loading would mirror or rotate the mask"};
 const firma=x=>typeof x==='object'&&x?JSON.stringify(Object.keys(x).sort().map(k=>[k,x[k]])):String(x);
 if(!sc.malla_sha256||!cur.malla_sha256)missing.push('mesh identity');
 else if(firma(sc.malla_sha256)!==firma(cur.malla_sha256))return {ok:false,txt:quien+" on a DIFFERENT mesh (SHA mismatch)"};
 // An exact recorded run and original PNG source use the same native grid even if
 // reading-orientation metadata is unavailable. Never extend this to another run.
 const exactOriginal=sc.run_id&&sc.run_id===cur.run_id&&sc.directorio_fuente&&sc.directorio_fuente===cur.directorio_fuente&&sc.malla_sha256&&cur.malla_sha256&&firma(sc.malla_sha256)===firma(cur.malla_sha256);
 if(exactOriginal&&missing.length===1&&missing[0]==='grid orientation')return {ok:true,txt:'same recorded run, original PNG source, mesh, dimensions and depth; reading orientation unknown'};
 if(missing.length)return {ok:null,txt:'Missing metadata: '+missing.join(', ')+'; mask alignment cannot be verified'};
 if(sc.run_id===cur.run_id)return {ok:true,txt:"same run, sheet, sample, depth and grid"};
 return {ok:true,txt:quien+" with matching grid and dimensions"}}
window.verificarCorridaMascara=verificar;
/* la guardada es de una corrida HERMANA con la misma grilla (misma lámina, cara, medidas, orientación y sha): comparten el lienzo (7.) */
function hermanaMismaGrilla(sc,cur){if(!sc||!cur||!H||!baseDeGrilla(H.nombre)||verificar(sc,cur).ok!==true)return false;   /* solo con el lienzo de la grilla montado (index.html nuevo y censo cargado) */
 const a=claveGrilla(sc);
 return a!=null&&a===claveGrilla(cur)&&(sc.lamina||'')===(cur.lamina||'')&&(sc.cara||'')===(cur.cara||'')&&(sc.malla_sha256||'')===(cur.malla_sha256||'')}
function pintarCorrida(){
 const el=$h('htCorrida');if(!el)return;
 if(!H||!group){el.textContent='—';return}
 const info=window.mascaraCorridaInfo(null,H.w,H.h);if(!info){el.textContent='—';return}
 const g=grupoMascara();let aviso='';
 if(g&&g.catalogMeta&&oriCargada()){const k=String(correccionDe(g)),otras={};
  for(const g2 of manifest){if(g2===g||!g2.catalogMeta||g2.catalogMeta.lam!==g.catalogMeta.lam)continue;
   if(String(correccionDe(g2))!==k){const a=ORI[g2.id],cl=a?String(a[3]).toLowerCase().replace(/_/g,' '):"direct";otras[cl]=(otras[cl]||0)+1}}
  const ks=Object.keys(otras);
  if(ks.length)aviso="<div class=\"htAviso\">Warning: this segment has runs with a DIFFERENT grid ("+ks.map(k2=>otras[k2]+' '+esc(k2)).join(', ')+"). One mask cannot serve both grids. Saves record the run in PNG metadata and sidecar JSON; loading blocks incompatible grids.</div>"}
 const trans=typeof oriEf==='function'&&oriEf(group)?"<div class=\"muted\">Transformed view ("+esc(typeof oriTexto==='function'?oriTexto(group):'')+"): mask and tools retain the original PNG grid</div>":'';
 let gw='';const sc=info.profundidad==='max'?undefined:GUARDADA[claveG(info)];
 if(sc===null)gw='<div class="muted">annotations '+esc(info.carpeta_profundidad)+": no saved pair readable by the viewer</div>";
 else if(sc&&sc.sinJson)gw='<div class="htAviso">annotations '+esc(info.carpeta_profundidad)+": a saved pair has NO run metadata; its run and grid are unknown. Saving replaces it and adds metadata.</div>";
 else if(sc){const v=verificar(sc,info),cuando=sc.guardado?' · '+esc(String(sc.guardado).slice(0,16).replace('T',' '))+' UTC':'';
  gw=sc.run_id===info.run_id?'<div class="muted">annotations '+esc(info.carpeta_profundidad)+": saved from this run"+cuando+'</div>'
    :hermanaMismaGrilla(sc,info)?'<div class="muted">annotations '+esc(info.carpeta_profundidad)+": saved from sibling run "+esc(sc.run_id+(sc.modelo?' · '+sc.modelo:''))+" (matching grid and dimensions): this is the same mask"+cuando+'</div>'
    :'<div class="htAviso">annotations '+esc(info.carpeta_profundidad)+": saved mask belongs to "+esc(v.txt)+cuando+". Saving here replaces it (confirmation required)"+
     (v.ok===false?'.':"; to continue this mask, load the saved mask in this run.")+'</div>'}
 el.innerHTML=esc(info.run_id)+(info.modelo?' · '+esc(info.modelo):'')+'<br>'+info.ancho+'×'+info.alto+' px · '+cStr(info.profundidad)+"<br>PNG grid: "+esc(descGrilla(info))+trans+aviso+visorTexto(gw)}
function hayTrazos(){if(!mctx||!H)return false;const d=mctx.getImageData(0,0,H.w,H.h).data;for(let i=3;i<d.length;i+=4)if(d[i]>=128)return true;return false}
async function cargarGuardada(){
 const destino=destinoMascara();if(!destino||!group||!mascaraLista())return;
 const info=destino.info;if(!info)return;
 if(info.profundidad==='max')return estado("Maximum projection has no depth-specific saved mask: choose a depth",true);
 const btn=$h('htCargar'),t0=btn.textContent;btn.disabled=true;btn.textContent=visorTexto("Reading saved pair…");
 try{
  const par=await obtenerParMascara(info.segmento,info.profundidad,info.base,false,info.scroll),blobs=par.blobs;
  const sc=par.corrida||corridaDePNG(new Uint8Array(await blobs[0].arrayBuffer()));
  const v=verificar(sc,info);
  if(v.ok===false){estado("BLOCKED: "+v.txt,true);msg("Saved mask NOT loaded: "+v.txt);return}
  const out=await leerParMascara(blobs,destino.w,destino.h);
  if(!destinoVigente(destino))return estado("Mask changed during reading: nothing was loaded",true);
  if(!await confirmarMetadatosMascara(blobs,info,'Saved mask load')||!destinoVigente(destino))return;
  const hacer=()=>{
   if(!destinoVigente(destino)||!mascaraLista())return estado("Mask changed: nothing was loaded",true);
   let nt=0,nn=0;for(let i=0;i<out.data.length;i+=4)if(out.data[i+3]===255){if(esTinta(out.data,i))nt++;else nn++}
   PREV=null;pintarPrev();if(!reemplazarMascara(out,destino))return;
   if(typeof mskGuardarPronto==='function')mskGuardarPronto();
   PERMISO.add(claveG(info));   /* la trajo a propósito a esta corrida: guardarla desde acá ya no pide confirmar */
   estado("Loaded saved mask ("+info.carpeta_profundidad+'): '+ent(nt)+" ink pixels, "+ent(nn)+" non-ink pixels · "+v.txt+" · Ctrl+Z undoes",v.ok===null);
   msg("Saved mask loaded ("+info.carpeta_profundidad+')')};
  const avisos=[];if(hayTrazos())avisos.push("The current mask has strokes and will be REPLACED (Ctrl+Z restores it)");
  if(avisos.length)pedirConf(avisos.join(' · ')+". Load anyway?",hacer);else hacer()}
 catch(e){estado("Saved mask load BLOCKED: "+String(e.message||e).slice(0,120),true)}
 finally{btn.disabled=false;btn.textContent=t0}}

/* ---------- ganchos sobre el núcleo (etiquetar.js / index.html / etiq_extra.js), sin reescribirlo ---------- */
const iniciar0=iniciarMascara;
iniciarMascara=async function(h){   /* montar una máscara: registrar su dueño (corrida + centro) y limpiar lo que era de la anterior */
 const antes=window.mascaraDueno,g=group,cen=((h&&h.nombre||'').match(/\|c([^|]*)$/)||[])[1];
 PREV=null;pintarPrev();cerrarConf();ARR=null;
 window.mascaraDueno={nombre:h.nombre,group:g,centro:cen!=null?cen:(projection?'max':String(slider.value)),w:h.w,h:h.h};
 if(ZONA&&(!antes||antes.group!==g||antes.w!==h.w||antes.h!==h.h)){ZONA=null;dibujarZona(null);if(CFG.dentro==='zona')CFG.dentro='vista';pintarUI()}
 const r=await iniciar0.apply(this,arguments);
 pintarCorrida();agendarMeta();leerGuardada();pintarPendiente();
 if(HERR)obtenerValores().catch(()=>{});
 if(CFG.inteligente)prepararLimite().catch(()=>{});pintarLimite();
 return r};
/* 7. lienzo de la grilla: al montar se le suman los lienzos viejos por corrida (queda por dentro de etiq_vc3d.js, que envuelve
   restaurar en DOMContentLoaded); y pasar a la corrida hermana con la MISMA clave (misma grilla) no remonta: cambia el dueño */
if(typeof restaurar==='function'){const rest0=restaurar;
 restaurar=async function(nombre){const r=await rest0.apply(this,arguments);try{await migrarLienzo(nombre)}catch(e){console.warn('migración de lienzos:',e)}return r}}
if(typeof trasFrame==='function'){const tf0=trasFrame;
 trasFrame=function(){const r=tf0.apply(this,arguments);
  try{const d=window.mascaraDueno;
   if(d&&H&&d.nombre===H.nombre&&group&&d.group!==group&&window.lienzoPorGrilla&&typeof window.claveLienzo==='function'&&
      H.nombre===window.claveLienzo(group,curW,curH)+(globalThis.recorteVista?globalThis.recorteVista.key():'')+'|c'+(projection?'max':String(slider.value))){
    d.group=group;PREV=null;pintarPrev();pintarCorrida();leerGuardada();
    estado("Mask at "+cStr(d.centro)+" shared with "+(meta(group).modelo||group.id)+" (matching grid and dimensions)")}
   pintarLimite()}
  catch(e){console.warn('dueño de la máscara:',e)}
  return r}}
const trazo0=trazo;
trazo=function(x0,y0,x1,y1){   /* pincel inteligente: pinta como siempre y devuelve lo que no cumple el umbral (en todos los mapas del límite, 8.) */
 if(!mascaraLista())return;
 if(!CFG.inteligente||(modo!=='tinta'&&modo!=='no')||!H||!mctx)return trazo0.apply(this,arguments);
 const L=limiteListo();
 if(!L){if(!PREP)prepararLimite().catch(e=>estado("smart brush: "+e.message,true));
  const t=performance.now();if(t-avisoInt>1500){avisoInt=t;msg("smart brush: esperando "+(mapasLimite().length>1?"the maps":"the map")+" at full resolution (painting waits until loading completes)")}return}
 const r=brocha/2+2,bx0=Math.max(0,Math.floor(Math.min(x0,x1)-r)),by0=Math.max(0,Math.floor(Math.min(y0,y1)-r)),
       bx1=Math.min(H.w,Math.ceil(Math.max(x0,x1)+r)),by1=Math.min(H.h,Math.ceil(Math.max(y0,y1)+r)),w=bx1-bx0,h=by1-by0;
 if(w<=0||h<=0)return trazo0.apply(this,arguments);
 const a=mctx.getImageData(bx0,by0,w,h).data;
 trazo0.apply(this,arguments);
 const im2=mctx.getImageData(bx0,by0,w,h),d=im2.data,tinta=modo==='tinta',thr=tinta?CFG.ta:CFG.tb;let rev=false;
 for(let yy=0;yy<h;yy++){let gi=(by0+yy)*L.w+bx0,j=yy*w*4;
  for(let xx=0;xx<w;xx++,gi++,j+=4){if(d[j]===a[j]&&d[j+1]===a[j+1]&&d[j+2]===a[j+2]&&d[j+3]===a[j+3])continue;
   if(L.ok[gi]&&(tinta?L.lo[gi]>=thr:L.hi[gi]<thr))continue;   /* tinta: todos ≥ T (mínimo); no-tinta: todos < t (máximo) */
   d[j]=a[j];d[j+1]=a[j+1];d[j+2]=a[j+2];d[j+3]=a[j+3];rev=true}}
 if(rev)mctx.putImageData(im2,bx0,by0)};
const empezar0=empezar;
empezar=function(){if(PREV)cancelarPrev("Preview discarded: brush painting changed the mask");return empezar0.apply(this,arguments)};
/* ediciones humanas -> pendiente de subir (ver PEND) */
if(typeof terminar==='function'){const terminar0=terminar;   /* fin de trazo: solo si el trazo pintó algo (bbox; el pincel inteligente puede no pintar) */
 terminar=function(){const hubo=typeof pintando!=='undefined'&&pintando&&typeof bbox!=='undefined'&&!!bbox;const r=terminar0.apply(this,arguments);if(hubo)marcarEdicion();return r}}
if(typeof aplicarRegion==='function'){const ar0=aplicarRegion;aplicarRegion=function(){const hubo=typeof regIni!=='undefined'&&!!regIni&&!!regFin;const r=ar0.apply(this,arguments);if(hubo)marcarEdicion();return r}}
if(typeof anilloFondo==='function'){const af0=anilloFondo;anilloFondo=function(){const u=undoS.length;const r=af0.apply(this,arguments);if(undoS.length!==u||undoS.length===20)marcarEdicion();return r}}
{const fi=$h('impFile');if(fi&&typeof fi.onchange==='function'){const oc0=fi.onchange;fi.onchange=async function(e){const r=await oc0.apply(this,arguments);if(r===true)marcarEdicion();return r}}}
if(typeof aplicar==='function'){const aplicar0=aplicar;
 aplicar=function(pila){if(PREV)cancelarPrev("preview descartada (deshacer / rehacer)");const hubo=!!(pila&&pila.length);const r=aplicar0.apply(this,arguments);if(hubo)marcarEdicion();return r}}
const contar0=contar;
contar=function(){const r=contar0.apply(this,arguments);agendarMeta();return r};
/* cambiar de LÁMINA con cambios sin subir: avisar (coordinador 25-sep). Aceptar = se suben ya a la lámina de la máscara (su
   dueña, nunca la nueva) y se cambia; Cancelar = no se cambia. Cambiar de profundidad no pregunta: montarMascara la sube sola. */
if(typeof select==='function'){const select0=select;
 select=function(i){
  try{const g2=manifest[i],du=dueno();
   if(visorPuedeGuardar&&g2&&du&&du.group&&H&&PEND[clavePend(H.nombre)]&&typeof meta==='function'&&(meta(g2).lam!==meta(du.group).lam||visorRolloDe(g2)!==visorRolloDe(du.group))){
    const c=cStr(du.centro),lam=meta(du.group).lam;
    if(!confirm(visorTexto("There are unsaved annotation changes for "+lam+' '+c+".\n\nOK: save to THAT segment before switching.\nCancel: stay on this segment."))){
     if(typeof syncHash==='function')syncHash();estado("Segment unchanged: unsaved changes at "+c,true);return}
    if(window.subirParS3){s3Pend=false;window.subirParS3(du.centro).then(()=>msg("Annotations saved: "+lam+' '+c)).catch(e=>msg('Annotation save failed for '+lam+' '+c+': '+String(e).slice(0,100)))}}}
  catch(e){}
  return select0.apply(this,arguments)}}
addEventListener('beforeunload',e=>{if(window.VISOR_STATIC?pendiente:H&&PEND[clavePend(H.nombre)]){e.preventDefault();e.returnValue="There are unsaved annotation changes"}});
if(typeof modoEtiq==='function'){const modoEtiq0=modoEtiq;
 modoEtiq=function(v){const r=modoEtiq0.apply(this,arguments);
  if(v){agendarMeta();pintarCorrida();dibujarZona(ZONA)}else{fijarHerr('');cancelarPrev();cerrarConf();dibujarZona(null)}return r}}
if(typeof window.oriBotones==='function'){const ob0=window.oriBotones;window.oriBotones=function(){const r=ob0.apply(this,arguments);pintarCorrida();return r}}
if(typeof aJson==='function'){const aJson0=aJson;
 aJson=function(){const s=aJson0.apply(this,arguments);try{const j=JSON.parse(s);j.corrida=window.mascaraCorridaInfo(null,H.w,H.h);return JSON.stringify(j)}catch(e){return s}}}
if(typeof pegarJson==='function'){const pegar0=pegarJson;
 pegarJson=function(texto){   /* paste JSON: bloquea otra corrida con otra grilla; ahora con undo */
  let j=null;try{j=JSON.parse(texto)}catch(e){}
  if(!j||!H||j.ancho!==H.w||j.alto!==H.h)return pegar0.apply(this,arguments);   /* el núcleo reporta el error */
  const cur=window.mascaraCorridaInfo(null,H.w,H.h),sc=j.corrida&&typeof j.corrida==='object'?j.corrida:null,v=verificar(sc,cur);
  if(v.ok===false){msg("paste JSON BLOCKED: "+v.txt);estado('paste JSON bloqueado: '+v.txt,true);return}
  if(v.ok===null&&!confirm('Paste JSON: '+v.txt+'. Verify the source image and depth. Import anyway?'))return false;
  PREV=null;pintarPrev();
  const r=pegar0.apply(this,arguments);
  if(r!==true)return r;
  s3Pend=true;espejarMascara();marcarEdicion();
  if(v.ok===null&&v.txt)estado('ojo (paste JSON): '+v.txt,true);
  return r}}

/* ---------- panel ---------- */
const css=document.createElement('style');css.id='htCss';css.textContent=
 '#htSec .htSeg{gap:0!important}#htSec .htSeg button{border-radius:0}#htSec .htSeg button:first-child{border-radius:5px 0 0 5px}#htSec .htSeg button:last-child{border-radius:0 5px 5px 0}'+
 '#htSec .htSeg button.on{background:#0f3b3a;border-color:#60d4c6;color:#86dcd5}#htSec label b{font-variant-numeric:tabular-nums;font-weight:600}'+
 '#htIntMapas{font:11px ui-monospace,monospace;color:#9bacbe;margin:0 0 6px 19px;word-break:break-word}'+
 '#htSec .htChk{display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:1.3}#htSec .htChk input{margin:2px 0 0;flex:none}'+
 '#htVarita.on,#htMarcar.on{background:#4a3a12;border-color:#d9a441;color:#f2dca8}#panel .fila button.htMini{flex:0 0 auto;min-width:26px}'+
 '#htPrevBox,#htConf{border:1px solid #d9a441;background:#2a2210;border-radius:6px;padding:6px;margin:6px 0;font-size:12px;color:#f2dca8;line-height:1.35}'+
 '#htConf{border-color:#a05555;background:#2a1414;color:#f3c4c4}#htAplicar:not(:disabled){background:#1d4a35;border-color:#3f8f66}'+
 '#htEstado,#htCorridaEst{font:11px ui-monospace,monospace;color:#9bacbe;margin-top:4px;word-break:break-word}.htAviso{color:#e0913c!important}'+
 '#htMeta{font-size:12px;line-height:1.35}#htMeta .htFila{display:flex;gap:6px;align-items:baseline}#htMeta .htFila b{font-size:14px;font-variant-numeric:tabular-nums}'+
 '#htMeta .htFila span:first-child{min-width:78px;color:#b8c8d8}#htMeta .htOk,#htMeta .htOk span:first-child{color:#6fd39a}'+
 '#htMeta .htBarra{height:5px;background:#182330;border-radius:3px;overflow:hidden;margin:2px 0 6px}#htMeta .htBarra i{display:block;height:100%;background:#d9a441}#htMeta .htBarra.ok i{background:#3f8f66}'+
 '#htCorrida{font:11px ui-monospace,monospace;color:#b8c8d8;line-height:1.45;word-break:break-all}#htCorrida .muted{font:inherit}'+
 '#htCapa{position:absolute;left:0;top:0;transform-origin:0 0;transform:var(--ori,none);pointer-events:none}'+
 '#htCapa canvas{position:absolute;image-rendering:pixelated;animation:htPulso .9s ease-in-out infinite alternate}@keyframes htPulso{from{opacity:.35}to{opacity:.85}}'+
 '#regionOverlay rect#htZona{fill:#00e5ff12;stroke:#00e5ff;stroke-width:2;stroke-dasharray:3 3;vector-effect:non-scaling-stroke;pointer-events:none}'+
 'body.etiq.htModoVarita #viewport{cursor:cell}';
document.head.append(css);
const panel=$h('panel');
const sec=document.createElement('div');sec.id='htSec';
sec.innerHTML=
 "<div class=\"fila\"><button id=\"htVarita\" title=\"Wand (W): select similar values with the brush class (1 ink, 2 non-ink, 3 erase). Drag to pan; Shift+click adds a selection. Limited to the view or region.\">wand (W)</button>"+
 "<button id=\"htMarcar\" title=\"Mark region (R): drag a rectangle on the map. Wand and threshold operate inside it.\">region (R)</button><button id=\"htQuitar\" class=\"htMini\" title=\"Clear the marked region\">×</button></div>"+
 "<div class=\"fila htSeg\" id=\"htAlc\"><button data-v=\"conectada\" title=\"Select only pixels connected to the click (4-connected fill), within the view or region\">connected</button><button data-v=\"parecidos\" title=\"Select all similar values within the view or region, connected or not\">all similar values</button></div>"+
 "<div class=\"fila htSeg\" id=\"htDen\"><button data-v=\"vista\" title=\"Within the visible image, excluding this panel\">in view</button><button data-v=\"zona\" title=\"Within the region marked with R\">in region</button></div>"+
 "<label title=\"The wand samples map value v (0–255) at the click and selects values from v − tolerance to v + tolerance\">tolerance ± <b id=\"htTolV\"></b><input type=\"range\" id=\"htTol\" min=\"0\" max=\"128\" step=\"1\"></label>"+
 "<label title=\"Non-ink threshold: values strictly below t (0–255; normalized value in parentheses)\">t · non-ink below <b id=\"htTbV\"></b><input type=\"range\" id=\"htTb\" min=\"0\" max=\"255\" step=\"1\"></label>"+
 "<label title=\"Ink threshold: values greater than or equal to T (0–255; normalized value in parentheses)\">T · ink from <b id=\"htTaV\"></b><input type=\"range\" id=\"htTa\" min=\"0\" max=\"255\" step=\"1\"></label>"+
 "<div class=\"fila\"><button id=\"htBajo\" title=\"Select values below t within the view or region; apply to label them non-ink\">&lt; t → non-ink</button><button id=\"htAlto\" title=\"Select values at or above T within the view or region; apply to label them ink\">≥ T → ink</button></div>"+
 "<label class=\"htChk\" title=\"Smart brush labels ink only where the map ≥ T and non-ink only where the map < t. Erase is unchanged. Requires the full PNG.\">"+
  "<input type=\"checkbox\" id=\"htInt\"><span>Smart brush (I): ink where map ≥ T; non-ink where map < t (all visible maps must agree)</span></label>"+
 '<div id="htIntMapas" class="muted"></div>'+
 "<label class=\"htChk\" title=\"Unchecked: wand and threshold affect only unlabelled pixels. Erase always clears selected pixels.\"><input type=\"checkbox\" id=\"htSobre\"><span>Wand and threshold overwrite existing labels</span></label>"+
 "<div id=\"htPrevBox\" hidden><div id=\"htPrevTxt\"></div><div class=\"fila\"><button id=\"htAplicar\">apply (Enter)</button><button id=\"htCancelar\">cancel (Esc)</button></div></div>"+
 "<div id=\"htConf\" hidden><div id=\"htConfTxt\"></div><div class=\"fila\"><button id=\"htConfSi\">confirm</button><button id=\"htConfNo\">cancel</button></div></div>"+
 '<div id="htEstado"></div>';
const hSec=document.createElement('h3');hSec.textContent="Value tools";
const h3sup=[...panel.querySelectorAll('h3')].find(h=>/^\s*supervision\s*$/i.test(h.textContent));
if(h3sup)h3sup.before(hSec,sec);else panel.append(hSec,sec);
const hMeta=document.createElement('h3');hMeta.textContent="Holdout metadata";const dMeta=document.createElement('div');dMeta.id='htMeta';
panel.prepend(hMeta,dMeta);
const hCor=document.createElement('h3');hCor.textContent="Mask run";
const dCor=document.createElement('div');dCor.id='htCorrida';
const fCor=document.createElement('div');fCor.className='fila';
fCor.innerHTML=visorTexto("<button id=\"htCargar\" title=\"Load the saved mask pair for this segment and depth. Incompatible grids or dimensions are blocked. Replaces current strokes; Ctrl+Z restores them.\">load saved mask</button>");
const eCor=document.createElement('div');eCor.id='htCorridaEst';
const pCor=document.createElement('div');pCor.id='htPend';pCor.className='htAviso';pCor.hidden=true;pCor.style.cssText='font:11px ui-monospace,monospace;margin-top:4px';
const stats=$h('stats');if(stats)stats.before(hCor,dCor,pCor,fCor,eCor);else panel.append(hCor,dCor,pCor,fCor,eCor);
const atajos=document.createElement('div');atajos.className='muted';atajos.style.marginTop='4px';
atajos.textContent="W wand; R mark region; I smart brush; Enter apply; Esc cancel; Shift+click add";
const hAt=[...panel.querySelectorAll('h3')].find(h=>/^\s*shortcuts\s*$/i.test(h.textContent));
if(hAt&&hAt.nextElementSibling)hAt.nextElementSibling.after(atajos);else panel.append(atajos);

function pintarUI(){
 $h('htVarita').classList.toggle('on',HERR==='varita');$h('htMarcar').classList.toggle('on',HERR==='zona');$h('htQuitar').disabled=!ZONA;
 sec.querySelectorAll('#htAlc button').forEach(b=>b.classList.toggle('on',b.dataset.v===CFG.alcance));
 sec.querySelectorAll('#htDen button').forEach(b=>b.classList.toggle('on',b.dataset.v===CFG.dentro));
 $h('htTol').value=CFG.tol;$h('htTolV').textContent=CFG.tol;
 $h('htTb').value=CFG.tb;$h('htTbV').textContent=CFG.tb+' ('+val01(CFG.tb)+')';
 $h('htTa').value=CFG.ta;$h('htTaV').textContent=CFG.ta+' ('+val01(CFG.ta)+')';
 $h('htInt').checked=CFG.inteligente;$h('htSobre').checked=CFG.sobre;pintarLimite()}
function fijarHerr(h){
 if(h&&panelesAbiertos()){estado("Close split panels to use wand and region previews",true);h=''}
 if(h==='zona'&&HERR!=='zona')HERR_ANT=HERR;
 HERR=h;ARR=null;document.body.classList.toggle('htModoVarita',h==='varita');pintarUI();
 if(h==='varita'){const c=claseDelPincel();estado("Wand: click the map; brush class: "+(c?NOMBRE[c]:"choose 1, 2 or 3")+"; drag to pan; W or Esc exits");
  obtenerValores().catch(e=>estado("Could not read the map: "+e.message,true))}
 else if(h==='zona')estado("Region: drag a rectangle on the map; R or Esc exits")}
function alternarInteligente(v){CFG.inteligente=v==null?!CFG.inteligente:!!v;pintarUI();
 if(CFG.inteligente){const varios=mapasLimite().length>1;
  estado("Smart brush: ink only where "+(varios?"all visible maps":"the map")+' ≥ T='+CFG.ta+", non-ink only where "+(varios?'all maps':"the map")+' < t='+CFG.tb);
  prepararLimite().catch(e=>estado("smart brush: "+e.message,true))}
 else estado("Smart brush off")}
const soltarFoco=el=>el.addEventListener('change',()=>el.blur());   /* que los atajos (1/2/3, W, Enter…) sigan andando después de tocar un control */
$h('htVarita').onclick=()=>fijarHerr(HERR==='varita'?'':'varita');
$h('htMarcar').onclick=()=>fijarHerr(HERR==='zona'?HERR_ANT:'zona');
$h('htQuitar').onclick=quitarZona;
sec.querySelectorAll('#htAlc button').forEach(b=>b.onclick=()=>{CFG.alcance=b.dataset.v;guardarCfg();pintarUI();recalcular()});
sec.querySelectorAll('#htDen button').forEach(b=>b.onclick=()=>{if(b.dataset.v==='zona'&&!ZONA){fijarHerr('zona');return}CFG.dentro=b.dataset.v;guardarCfg();pintarUI();recalcular()});
for(const [id,k] of [['htTol','tol'],['htTb','tb'],['htTa','ta']]){const el=$h(id);soltarFoco(el);
 el.oninput=()=>{CFG[k]=+el.value;guardarCfg();pintarUI();if(PREV&&(k==='tol'?PREV.orig.tipo==='varita':PREV.orig.tipo===(k==='tb'?'bajo':'alto')))recalcular()}}
$h('htBajo').onclick=()=>calcular({tipo:'bajo',clase:'no'},false);
$h('htAlto').onclick=()=>calcular({tipo:'alto',clase:'tinta'},false);
soltarFoco($h('htInt'));$h('htInt').onchange=e=>alternarInteligente(e.target.checked);
soltarFoco($h('htSobre'));$h('htSobre').onchange=e=>{CFG.sobre=e.target.checked;recalcular()};
$h('htAplicar').onclick=aplicarPrev;$h('htCancelar').onclick=()=>cancelarPrev("preview cancelada");
$h('htConfSi').onclick=()=>{const f=CONF;cerrarConf();if(f)f()};$h('htConfNo').onclick=()=>{cerrarConf();estado("Cancelled")};
$h('htCargar').disabled=!!window.VISOR_STATIC;
$h('htCargar').onclick=cargarGuardada;
{const pa=document.getElementById('panes');if(pa)new MutationObserver(()=>{pintarLimite();if(CFG.inteligente&&!limiteListo()&&!PREP)prepararLimite().catch(()=>{})}).observe(pa,{childList:true})}   /* 8. paneles nuevos o cerrados: otro límite */
{const moMo=new MutationObserver(()=>{if(HERR==='varita'){const c=claseDelPincel();estado("Wand; brush class: "+(c?NOMBRE[c]:"choose 1 ink, 2 non-ink or 3 erase"),!c)}});
 ['mTinta','mNo','mBorrar','mRegion'].forEach(id=>{const b=$h(id);if(b)moMo.observe(b,{attributes:true,attributeFilter:['class']})})}   /* solo los botones de modo (setModo) */
pintarUI();

/* ---------- puntero y teclado (fase de captura: con varita o zona activas, el pincel del núcleo no recibe el clic) ---------- */
const enVista=e=>{const t=e.target;return !!(t&&t.closest&&vp.contains(t)&&!t.closest('#panel')&&!t.closest('.pact'))};
addEventListener('pointerdown',e=>{
 if(!HERR||typeof etiqOn==='undefined'||!etiqOn||!mctx||!H||e.button!==0||espacio||!enVista(e))return;
 e.stopPropagation();e.preventDefault();
 if(!mascaraLista())return estado('Wait for the full-resolution image and mask',true);
 if(panelesAbiertos()){estado("Close split panels to use previews",true);return}
 ARR={id:e.pointerId,x:e.clientX,y:e.clientY,mov:0,g0:rp(e)};try{vp.setPointerCapture(e.pointerId)}catch(_){}
 if(HERR==='zona')zonaTemporal(ARR.g0,ARR.g0)},true);
addEventListener('pointermove',e=>{
 if(!ARR||e.pointerId!==ARR.id)return;e.stopPropagation();
 const dx=e.clientX-ARR.x,dy=e.clientY-ARR.y;ARR.mov+=Math.abs(dx)+Math.abs(dy);ARR.x=e.clientX;ARR.y=e.clientY;
 if(HERR==='zona')zonaTemporal(ARR.g0,rp(e));
 else if(ARR.mov>4){x+=dx;y+=dy;fitted=false;paint();vp.classList.add('dragging')}},true);
const soltar=e=>{
 if(!ARR||e.pointerId!==ARR.id)return;e.stopPropagation();const a=ARR;ARR=null;vp.classList.remove('dragging');
 try{vp.releasePointerCapture(e.pointerId)}catch(_){}
 if(e.type==='pointercancel'){zonaTemporal(null,null);return}
 if(HERR==='zona')fijarZona(a.g0,rp(e));else if(HERR==='varita'&&a.mov<=4)varita(a.g0,e.shiftKey)};
addEventListener('pointerup',soltar,true);addEventListener('pointercancel',soltar,true);
addEventListener('dblclick',e=>{if(HERR&&typeof etiqOn!=='undefined'&&etiqOn&&enVista(e)){e.stopPropagation();e.preventDefault()}},true);
addEventListener('keydown',e=>{
 if(typeof etiqOn==='undefined'||!etiqOn||!group||e.ctrlKey||e.metaKey||e.altKey)return;
 const t=e.target||{},tag=t.tagName||'';
 if(tag==='TEXTAREA'||tag==='SELECT'||(tag==='INPUT'&&!/^(range|checkbox)$/.test(t.type)))return;
 if(e.key==='Enter'&&PREV){e.preventDefault();e.stopImmediatePropagation();aplicarPrev();return}
 if(e.key==='Escape'){if(CONF){cerrarConf();estado("Cancelled")}else if(PREV)cancelarPrev("preview cancelada");else if(HERR)fijarHerr(HERR==='zona'?HERR_ANT:'');else return;
  e.preventDefault();e.stopImmediatePropagation();return}
 if(tag==='INPUT')return;                      /* letras: como el núcleo, no con el foco en un control */
 const k=e.key.toLowerCase();
 if(k==='w')fijarHerr(HERR==='varita'?'':'varita');else if(k==='r')fijarHerr(HERR==='zona'?HERR_ANT:'zona');else if(k==='i')alternarInteligente();else return;
 e.preventDefault();e.stopImmediatePropagation()},true);
/* 7. con la migración ya instalada, index.html/claveLienzo usa la clave de la grilla; si algo se montó antes con la vieja, se remonta */
window.lienzoPorGrilla=true;
if(typeof reclavar==='function'){try{reclavar()}catch(e){console.warn('reclavar:',e)}}
console.log("etiq_herramientas: wand, zona, umbral, smart brush, meta, corrida y lienzo por grilla instalados");
})();
