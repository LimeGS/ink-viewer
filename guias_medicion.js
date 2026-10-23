/* ===== Renglones y medición (25-sep-2026) — guias_medicion.js =====
   Pedido del usuario: «líneas imaginarias para dibujar los renglones» y «un instrumento de medición entre puntos».
   1. Líneas de renglón (L): dos clics, o clic y arrastrar, marcan una recta (puede ir inclinada). «de borde a borde» las
      prolonga hasta el borde de la imagen (el tramo marcado queda más grueso). Clic sobre una línea la selecciona;
      arrastrarla la corre paralela a sí misma; arrastrar una punta la gira o la alarga; Supr/Backspace borra la
      seleccionada; «borrar líneas» borra todas (pide un segundo clic). Entre líneas consecutivas casi paralelas (≤ 5°) se ve
      la separación perpendicular en mm (promedio de la distancia del punto medio de cada una a la recta de la otra) y el
      panel da el interlineado de arriba abajo y su media. «repetir paralela» (P) copia la seleccionada al mismo
      interlineado, del lado donde no tiene vecina: P seguidas anticipan los renglones siguientes.
   2. Medir (D; la M ya abre el mosaico Súper): dos clics, o clic y arrastrar, dejan un segmento con su largo en mm y en px y
      su inclinación en grados respecto de la horizontal de la pantalla (positivo = sube hacia la derecha). Mientras se
      busca el segundo punto la medida se ve en vivo. Clic sobre una medida la selecciona; Supr la borra; «borrar medidas».
   ESCALA: um_por_px de la corrida si el manifiesto lo trae; si no, el voxel del rollo por píxel (TARGET_UM del renderizador,
      la de la regla: voxel_um del rollo.json vía rollo_visor.js; 8,64 µm en PHerc1447). Si el catálogo marca la escala física de la corrida como NO verificada (physicalScaleVerified=false, la regla
      se oculta), los mm llevan «≈».
   SOLO AYUDAS VISUALES: nunca tocan la máscara (inklabels / supervision_mask), ni su deshacer, ni el guardado en work-3. Con
      L o D activas, los clics izquierdos sobre la imagen son de la herramienta (fase de captura + stopPropagation: el pincel
      del núcleo, el auto-guardado de etiq_extra.js y la marca de edición de etiq_vc3d.js no los ven), así que no quedan
      ediciones de máscara pendientes. Mover la vista: botón derecho o espacio + arrastrar, como al pintar, y la rueda para
      el zoom (el arrastre izquierdo marca). Esc cancela lo que está a medio hacer, después la selección, después la
      herramienta. Elegir un modo del pincel (1/2/3/4 o sus botones), la varita (W) o la zona (R) sale de la herramienta.
   GRILLA: se guardan en la grilla ORIGINAL del PNG (clics por rp() = oriAGrilla) y se dibujan en un <svg> dentro de #stage
      con la misma matriz --ori que el mapa y la máscara: quedan pegadas con zoom, paneo, «vista corregida» y voltear ↕/↔.
      Los rótulos van en una capa de pantalla (#gmTxt) para que el texto no salga espejado; se recolocan en cada paintNow.
      Con paneles divididos se dibujan en cada panel con la matriz de la corrida principal (la del espejo de la máscara) y
      se usan igual.
   PERSISTENCIA: localStorage 'vesuvius.guias.v1:<lámina>|<ancho>x<alto>|<corrección>': una por lámina para todas sus
      profundidades, y por grilla: dos corridas de la misma lámina con la misma grilla las comparten; con otra corrección de
      orientación u otras medidas no aparecen (se verían espejadas). «JSON de guías» copia y pega (pegar bloquea otra grilla). */
(function(){
'use strict';
const $g=id=>document.getElementById(id);
if(typeof rp!=='function'||typeof oriAVista!=='function'||typeof oriAGrilla!=='function'||typeof oriEf!=='function'||typeof oriMatriz!=='function'||
   typeof paintNow!=='function'||typeof modoEtiq!=='function'||typeof vp==='undefined'||typeof stage==='undefined'||!$g('panel')){
 console.warn('guias_medicion: falta el núcleo del visor; no se instala');return}

const NS='http://www.w3.org/2000/svg',ANG=5,LIM=ANG*Math.PI/180,MOV=4;
const COL={l:'#ff4fd8',m:'#ffb020'};                  // magenta = renglones, ámbar = medidas (la máscara es verde/roja)
const KEY=visorKey('vesuvius.guias.v1')+':',KCFG='vesuvius.guias.cfg.v1';
const CFG={ext:true,ver:true};
try{const s=JSON.parse(localStorage.getItem(KCFG)||'{}');if(typeof s.ext==='boolean')CFG.ext=s.ext;if(typeof s.ver==='boolean')CFG.ver=s.ver}catch(e){}
const guardarCfg=()=>{try{localStorage.setItem(KCFG,JSON.stringify(CFG))}catch(e){}};
const fmt=(v,d=2)=>Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const r2=v=>Math.round(v*100)/100;
const etiqActivo=()=>typeof etiqOn!=='undefined'&&!!etiqOn;
const hayGrupo=()=>typeof group!=='undefined'&&!!group;
const panelesAbiertos=()=>typeof PANES!=='undefined'&&!!PANES&&PANES.length>0;
function estado(t,aviso){const e=$g('gmEstado');if(!e)return;e.textContent=t||'';e.classList.toggle('gmAviso',!!aviso)}

let HERR='',CLAVE=null,D=vacio(),SEL=null,PEND=null,ARR=null,CUR=null,IGN=null,infoAnt='';
/* D = guías de la lámina y grilla actuales; SEL = {t:'l'|'m',id}; PEND = primer punto de dos clics {t,a};
   ARR = arrastre en curso; CUR = último puntero sobre la imagen (línea elástica); IGN = puntero de un arrastre cancelado */
function vacio(){return {lineas:[],medidas:[],n:0}}

/* ---------- escala ---------- */
function escala(){const g=hayGrupo()?group:null,c=g&&g.catalogMeta,ver=!(c&&c.physicalScaleVerified===false);
 for(const v of [g&&g.um_por_px,c&&c.um_por_px]){const n=Number(v);if(v!=null&&v!==''&&isFinite(n)&&n>0)return {um:n,fuente:"from the run",ver}}
 const um=window.visorUmPorPixel?visorUmPorPixel(g):+window.VOXEL_UM;return {um:um>0?um:null,fuente:um>0?"from the dataset":"unknown",ver:ver&&um>0}}
const mmTxt=(px,es)=>es.um>0?(es.ver?'':'≈')+fmt(px*es.um/1000,2)+' mm':fmt(px,1)+' px (scale unknown)';

/* ---------- clave por lámina y grilla, lectura y guardado ---------- */
function correccion(){if(typeof ORI!=='object'||!ORI||!hayGrupo())return null;let hay=false;for(const k in ORI){hay=true;break}if(!hay)return null;
 const a=ORI[group.id];return a?[+a[0]?1:0,+a[1]?1:0,+a[2]?1:0]:[0,0,0]}   /* null = el censo de orientación no cargó */
function claveActual(){if(!hayGrupo()||!(curW>0)||!(curH>0))return null;
 const t=typeof meta==='function'?meta(group):null,c=correccion();
 return (window.visorRolloDe?visorRolloDe(group):window.ROLLO)+'|'+((t&&t.lam)||group.id)+'|'+curW+'x'+curH+'|'+(c?c.join(''):'?')}
const okP=p=>Array.isArray(p)&&p.length>=2&&typeof p[0]==='number'&&typeof p[1]==='number'&&isFinite(p[0])&&isFinite(p[1]);
function leer(k){const d=vacio();if(!k)return d;
 try{let raw=localStorage.getItem(KEY+k);
  if(!raw&&hayGrupo()){const lam=typeof meta==='function'?meta(group).lam:group.id,scroll=window.visorRolloDe?visorRolloDe(group):window.ROLLO;
   const duplicate=typeof manifest!=='undefined'&&manifest.some(g=>g!==group&&(typeof meta==='function'?meta(g).lam:g.id)===lam&&window.visorRolloDe&&visorRolloDe(g)!==scroll);
   if(!duplicate)raw=localStorage.getItem(KEY+k.slice(k.indexOf('|')+1));}
  const s=JSON.parse(raw||'null');
  if(s&&typeof s==='object')for(const c of ['lineas','medidas'])if(Array.isArray(s[c]))for(const o of s[c])if(o&&okP(o.a)&&okP(o.b))d[c].push({id:++d.n,a:[o.a[0],o.a[1]],b:[o.b[0],o.b[1]]})}
 catch(e){}
 return d}
const plano=o=>({a:[r2(o.a[0]),r2(o.a[1])],b:[r2(o.b[0]),r2(o.b[1])]});
function guardar(){if(!CLAVE)return;
 try{if(!D.lineas.length&&!D.medidas.length)localStorage.removeItem(KEY+CLAVE);
  else localStorage.setItem(KEY+CLAVE,JSON.stringify({formato:'vesuvius.guias.v1',guardado:new Date().toISOString(),lineas:D.lineas.map(plano),medidas:D.medidas.map(plano)}))}
 catch(e){estado("Could not save guides in this browser ("+String(e&&e.message||e).slice(0,80)+')',true)}}
/* otra lámina, otra grilla o la imagen recién cargada: se leen sus guías (nunca se escribe al cambiar) */
function sincronizar(){const k=claveActual();if(k===CLAVE)return;CLAVE=k;D=leer(k);SEL=PEND=ARR=null;pintarUI()}

/* ---------- geometría (grilla original; --ori es una isometría, así que distancias y paralelismo valen igual en la vista) ---------- */
const lista=t=>t==='l'?D.lineas:D.medidas;
const buscarObj=(t,id)=>lista(t).find(o=>o.id===id)||null;
const tipoHerr=()=>HERR==='lineas'?'l':HERR==='medir'?'m':'';
const largo=o=>Math.hypot(o.b[0]-o.a[0],o.b[1]-o.a[1]);
function recorte(a,b){   /* la recta por a y b dentro de la imagen [0,ancho]×[0,alto] (Liang–Barsky sin límites de t) */
 const dx=b[0]-a[0],dy=b[1]-a[1];if(!dx&&!dy)return null;let t0=-Infinity,t1=Infinity;
 for(const [p,q] of [[-dx,a[0]],[dx,curW-a[0]],[-dy,a[1]],[dy,curH-a[1]]]){if(p===0){if(q<0)return null;continue}const r=q/p;if(p<0){if(r>t0)t0=r}else if(r<t1)t1=r}
 return t0<=t1?[[a[0]+t0*dx,a[1]+t0*dy],[a[0]+t1*dx,a[1]+t1*dy]]:null}
const tramo=(o,t)=>t==='l'&&CFG.ext?(recorte(o.a,o.b)||[o.a,o.b]):[o.a,o.b];
function distSeg(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l2=dx*dx+dy*dy;let t=l2?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l2:0;t=Math.max(0,Math.min(1,t));
 return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)}
const aVista=p=>oriAVista(oriEf(group),curW,curH,p[0],p[1]);
const aPant=p=>{const v=aVista(p);return [x+zoom*v[0],y+zoom*v[1]]};   /* grilla -> píxel de la caja (#viewport o el panel) */
function inclinacion(o){const a=aVista(o.a),b=aVista(o.b);let g=Math.atan2(-(b[1]-a[1]),b[0]-a[0])*180/Math.PI;   /* como se ve: antihorario */
 if(g>90)g-=180;else if(g<=-90)g+=180;return Math.abs(g)<.05?0:g}   /* sin «-0,0°» */
/* la línea o medida más cerca del puntero g: primero las puntas (las de la seleccionada antes), después el cuerpo */
function tocar(g,t){if(!t||!g)return null;const tp=9/zoom,tc=6/zoom,sel=SEL&&SEL.t===t?buscarObj(t,SEL.id):null;let m=null;
 const puntas=o=>{for(const k of ['a','b']){const d=Math.hypot(g[0]-o[k][0],g[1]-o[k][1]);if(d<=tp&&(!m||d<m.d))m={o,k,d}}};
 if(sel){puntas(sel);if(m)return m}
 for(const o of lista(t))puntas(o);if(m)return m;
 for(const o of lista(t)){const e=tramo(o,t),d=distSeg(g,e[0],e[1]);if(d<=tc&&(!m||d<m.d))m={o,k:null,d}}
 return m}
/* series de líneas casi paralelas (≤ ANG), ordenadas de arriba abajo EN LA VISTA (de izquierda a derecha si son verticales),
   y la separación entre consecutivas */
const difAng=(a,b)=>{const d=Math.abs(a-b)%Math.PI;return Math.min(d,Math.PI-d)};
const dRecta=(p,e)=>Math.abs(e.u[0]*(p[1]-e.l.a[1])-e.u[1]*(p[0]-e.l.a[0]));
const pie=(p,e)=>{const s=(p[0]-e.l.a[0])*e.u[0]+(p[1]-e.l.a[1])*e.u[1];return [e.l.a[0]+s*e.u[0],e.l.a[1]+s*e.u[1]]};
function series(){
 const L=D.lineas.map(l=>{const dx=l.b[0]-l.a[0],dy=l.b[1]-l.a[1],n=Math.hypot(dx,dy)||1;let th=Math.atan2(dy,dx);if(th<0)th+=Math.PI;if(th>=Math.PI)th-=Math.PI;
  return {l,u:[dx/n,dy/n],th,m:[(l.a[0]+l.b[0])/2,(l.a[1]+l.b[1])/2]}});
 const G=[];for(const e of L){let g=G.find(h=>difAng(h.th,e.th)<=LIM);if(!g)G.push(g={th:e.th,ls:[]});g.ls.push(e)}
 const o=oriEf(group);
 for(const g of G){let cx=0,cy=0;for(const e of g.ls){cx+=Math.cos(2*e.th);cy+=Math.sin(2*e.th)}
  const th=Math.atan2(cy,cx)/2,n=[-Math.sin(th),Math.cos(th)],m0=g.ls[0].m,
        v0=oriAVista(o,curW,curH,m0[0],m0[1]),v1=oriAVista(o,curW,curH,m0[0]+n[0],m0[1]+n[1]),vx=v1[0]-v0[0],vy=v1[1]-v0[1],
        s=vy<-1e-6||(Math.abs(vy)<=1e-6&&vx<0)?-1:1;
  g.ls.sort((p,q)=>s*((p.m[0]-q.m[0])*n[0]+(p.m[1]-q.m[1])*n[1]));
  g.pares=[];for(let i=0;i+1<g.ls.length;i++){const p=g.ls[i],q=g.ls[i+1];if(difAng(p.th,q.th)<=LIM)g.pares.push({p,q,sep:(dRecta(q.m,p)+dRecta(p.m,q))/2})}}
 return G}

/* ---------- dibujo: <svg> en #stage (matriz --ori) + rótulos en pantalla ---------- */
function capaSvg(){let s=$g('gmCapa');if(!s){s=document.createElementNS(NS,'svg');s.id='gmCapa';s.setAttribute('aria-hidden','true')}
 if(s.parentNode!==stage)stage.append(s);
 const vb='0 0 '+curW+' '+curH;if(s.getAttribute('viewBox')!==vb){s.setAttribute('viewBox',vb);s.setAttribute('width',curW);s.setAttribute('height',curH)}
 return s}
function capaTxt(){let d=$g('gmTxt');if(!d){d=document.createElement('div');d.id='gmTxt';d.setAttribute('aria-hidden','true');vp.append(d)}return d}
function limpiarPaneles(){for(const e of document.querySelectorAll('#panes .gmPane,#panes .gmPaneTxt'))e.remove()}
/* paneles divididos: la misma capa en cada panel, con la transformación del espejo de la máscara (grilla de la corrida principal) */
function paneles(svgTxt,rot){const oM=oriEf(group),base='translate('+x+'px,'+y+'px) scale('+zoom+')',tr=oM?base+' '+oriMatriz(oM,curW,curH):base;
 for(const d of document.querySelectorAll('#panes .pane')){let s=d.querySelector(':scope>svg.gmPane');
  if(!s){s=document.createElementNS(NS,'svg');s.setAttribute('class','gmPane');s.setAttribute('aria-hidden','true');d.append(s)}
  s.setAttribute('viewBox','0 0 '+curW+' '+curH);s.setAttribute('width',curW);s.setAttribute('height',curH);s.style.transform=tr;s.innerHTML=svgTxt;
  let t=d.querySelector(':scope>.gmPaneTxt');if(!t){t=document.createElement('div');t.className='gmPaneTxt';d.append(t)}t.innerHTML=rot}}
function previa(){if(!CUR)return null;const c=rp({clientX:CUR.x,clientY:CUR.y});   /* la que se está marcando: del primer punto al puntero */
 if(ARR&&ARR.modo==='nueva'&&ARR.mov>MOV)return {t:ARR.t,a:ARR.g0,b:c};
 if(PEND)return {t:PEND.t,a:PEND.a,b:c};return null}
function rotMedida(o,sel,es){const A=aPant(o.a),B=aPant(o.b),M=[(A[0]+B[0])/2,(A[1]+B[1])/2];let nx=-(B[1]-A[1]),ny=B[0]-A[0];const nl=Math.hypot(nx,ny)||1;nx/=nl;ny/=nl;
 if(ny>0||(ny===0&&nx>0)){nx=-nx;ny=-ny}   /* del lado de arriba en pantalla (a la izquierda si es vertical) */
 const l=largo(o);
 return {p:M,c:'gmRotM '+(Math.abs(ny)>=.5?'gmArr':nx<0?'gmIzq':'gmDer')+(sel?' gmSel':''),h:'<b>'+mmTxt(l,es)+'</b> · '+fmt(l,1)+' px · '+fmt(inclinacion(o),1)+'°'}}
function dibujar(){
 sincronizar();
 const s=capaSvg(),t=capaTxt(),on=etiqActivo()&&CFG.ver&&!!CLAVE,pv=on?previa():null;
 if(!on||(!D.lineas.length&&!D.medidas.length&&!pv)){if(s.firstChild)s.textContent='';s.style.display='none';if(t.firstChild)t.textContent='';limpiarPaneles();if(etiqActivo())pintarInfo();return}
 const z=zoom>0?zoom:1,W=v=>+(v/z).toPrecision(4),S=[],R=[],es=escala(),th=tipoHerr(),G=series();   /* W: px de pantalla -> px de grilla */
 const lin=(p,q,col,w,extra)=>S.push('<line x1="'+r2(p[0])+'" y1="'+r2(p[1])+'" x2="'+r2(q[0])+'" y2="'+r2(q[1])+'" stroke="'+col+'" stroke-width="'+w+'" stroke-linecap="round"'+(extra||'')+'/>');
 const punto=(p,col,sel)=>S.push('<circle cx="'+r2(p[0])+'" cy="'+r2(p[1])+'" r="'+W(sel?5.5:3.2)+'" fill="'+(sel?'#fff':col)+'" stroke="'+(sel?col:'#000')+'" stroke-width="'+W(sel?2:1)+'"/>');
 const halo=' stroke-opacity=".55"',guion=' stroke-dasharray="'+W(7)+' '+W(5)+'"';
 /* separación entre renglones consecutivos: conector punteado y rótulo en el medio (sin rótulo si en pantalla no entra) */
 for(const g of G)for(const r of g.pares){const M=[(r.p.m[0]+r.q.m[0])/2,(r.p.m[1]+r.q.m[1])/2],a=pie(M,r.p),b=pie(M,r.q);
  lin(a,b,'#000',W(3),halo);lin(a,b,COL.l,W(1.2),' stroke-dasharray="'+W(2)+' '+W(3)+'"');
  if(r.sep*z>=14)R.push({p:aPant(M),c:'gmRotL gmCen',h:'<b>'+mmTxt(r.sep,es)+'</b>'})}
 const selL=SEL&&SEL.t==='l'?SEL.id:null,selM=SEL&&SEL.t==='m'?SEL.id:null;
 const dibL=(o,sel,prev)=>{const e=tramo(o,'l'),d=prev?guion:'',prolongada=e[0]!==o.a||e[1]!==o.b;
  lin(e[0],e[1],'#000',W(sel?5.5:3.8),halo+d);lin(e[0],e[1],COL.l,W(sel?2.6:1.5),d);
  if(prolongada)lin(o.a,o.b,COL.l,W(sel?3.6:2.4),d)};
 const dibM=(o,sel,prev)=>{const l=largo(o);if(!l)return;const n=[-(o.b[1]-o.a[1])/l*W(6),(o.b[0]-o.a[0])/l*W(6)],d=prev?guion:'';
  lin(o.a,o.b,'#000',W(sel?5.5:3.8),halo+d);
  for(const p of [o.a,o.b]){const u=[p[0]-n[0],p[1]-n[1]],v=[p[0]+n[0],p[1]+n[1]];lin(u,v,'#000',W(3.4),halo);lin(u,v,COL.m,W(1.6))}   /* topes */
  lin(o.a,o.b,COL.m,W(sel?2.6:1.6),d);R.push(rotMedida(o,sel,es))};
 for(const o of D.lineas)dibL(o,o.id===selL,false);
 for(const o of D.medidas)dibM(o,o.id===selM,false);
 if(th)for(const o of lista(th)){const sel=SEL&&SEL.t===th&&SEL.id===o.id;punto(o.a,COL[th],sel);punto(o.b,COL[th],sel)}   /* puntas: solo las de la herramienta activa */
 if(pv){const o={a:pv.a,b:pv.b};if(pv.t==='l')dibL(o,false,true);else dibM(o,false,true);punto(pv.a,COL[pv.t],false)}
 const svgTxt=S.join('');s.innerHTML=svgTxt;s.style.display='';
 const rot=R.map(r=>'<div class="gmRot '+r.c+'" style="left:'+r.p[0].toFixed(1)+'px;top:'+r.p[1].toFixed(1)+'px">'+r.h+'</div>').join('');
 if(panelesAbiertos()){if(t.firstChild)t.textContent='';paneles(svgTxt,rot)}else{limpiarPaneles();t.innerHTML=rot}
 pintarInfo(G)}

/* ---------- acciones ---------- */
function crear(t,p,q){const l=Math.hypot(q[0]-p[0],q[1]-p[1]);
 if(l*zoom<6){estado((t==='l'?'line':'measurement')+" too short: mark two separate points",true);return null}
 const o={id:++D.n,a:[p[0],p[1]],b:[q[0],q[1]]};lista(t).push(o);guardar();
 estado(t==='l'?"Line marked ("+D.lineas.length+')'+(D.lineas.length<2?"; mark a neighbouring line to show spacing":''):"Measurement: "+mmTxt(l,escala())+' · '+fmt(l,1)+' px · '+fmt(inclinacion(o),1)+'°');
 return o}
function borrarSel(){if(!SEL)return;const L=lista(SEL.t),i=L.findIndex(o=>o.id===SEL.id),t=SEL.t;if(i>=0)L.splice(i,1);SEL=null;guardar();dibujar();pintarUI();
 estado(t==='l'?"Line deleted":"Measurement deleted")}
function borrarTodas(t){const n=lista(t).length;lista(t).length=0;if(SEL&&SEL.t===t)SEL=null;if(PEND&&PEND.t===t)PEND=null;guardar();dibujar();pintarUI();
 estado(n+(t==='l'?" lines deleted":" measurements deleted"))}
function repetirParalela(){
 const o=SEL&&SEL.t==='l'?buscarObj('l',SEL.id):null;
 if(!o)return estado("Repeat parallel: select a line with a near-parallel neighbour",true);
 const g=series().find(h=>h.ls.some(e=>e.l===o));if(!g)return;
 const ant=g.pares.find(r=>r.q.l===o),sig=g.pares.find(r=>r.p.l===o);
 if(!ant&&!sig)return estado("repetir paralela: hace falta otra line casi paralela (≤ "+ANG+"°) al lado para saber el line spacing",true);
 if(ant&&sig)return estado("Repeat parallel: select the first or last line in the series",true);
 const r=ant||sig,vec=ant?ant.p:sig.q,e=ant?ant.q:sig.p,n=[-e.u[1],e.u[0]],
       lado=Math.sign((vec.m[0]-o.a[0])*n[0]+(vec.m[1]-o.a[1])*n[1])||1,dx=-lado*r.sep*n[0],dy=-lado*r.sep*n[1],
       a=[o.a[0]+dx,o.a[1]+dy],b=[o.b[0]+dx,o.b[1]+dy];
 if(!recorte(a,b))return estado("Repeat parallel: the next line is outside the image",true);
 const nueva={id:++D.n,a,b};D.lineas.push(nueva);SEL={t:'l',id:nueva.id};guardar();dibujar();pintarUI();
 estado('paralela a '+mmTxt(r.sep,escala())+' ('+fmt(r.sep,1)+' px) · P otra vez sigue la serie')}
function cancelarArrastre(){const a=ARR;ARR=null;if(!a)return;IGN=a.id;if(a.obj&&a.orig){a.obj.a=a.orig.a;a.obj.b=a.orig.b}
 try{vp.releasePointerCapture(a.id)}catch(_){}}
/* varita y zona (etiq_herramientas.js) no conviven con estas: se apagan con sus propios botones */
function apagarOtras(){for(let i=0;i<3;i++){const v=$g('htVarita'),z=$g('htMarcar');if(z&&z.classList.contains('on'))z.click();else if(v&&v.classList.contains('on'))v.click();else break}}
const AYUDA={lineas:"Lines: click two points or drag; click a line to select; drag it or an endpoint; Delete removes it; P repeats it; right-click or Space pans; Esc exits",
            medir:"Measure: click two points or drag; click a measurement to select; Delete removes it; right-click or Space pans; Esc exits"};
function fijarHerr(h){
 if(h&&!etiqActivo())return;
 if(h)apagarOtras();
 if(h!==HERR){cancelarArrastre();PEND=null;SEL=null}
 HERR=h;document.body.classList.toggle('gmActivo',!!h);vp.classList.remove('gmPunta','gmCuerpo');
 if(h&&!CFG.ver){CFG.ver=true;guardarCfg()}
 pintarUI();dibujar();estado(h?AYUDA[h]:'')}

/* ---------- panel ---------- */
function confirmar(b,txt,fn){   /* borrar todo o reemplazar: un segundo clic antes de 3,5 s */
 if(b.dataset.conf){clearTimeout(+b.dataset.t);delete b.dataset.conf;b.textContent=b.dataset.txt;b.classList.remove('gmConf');fn();return}
 b.dataset.txt=b.textContent;b.dataset.conf='1';b.textContent=txt;b.classList.add('gmConf');
 b.dataset.t=String(setTimeout(()=>{delete b.dataset.conf;b.textContent=b.dataset.txt;b.classList.remove('gmConf')},3500))}
function textoInfo(G){
 if(!CLAVE)return "<span class=\"muted\">No image</span>";
 const es=escala(),p=[],nL=D.lineas.length,nM=D.medidas.length,conPares=G.filter(g=>g.pares.length);
 p.push(nL+" line"+(nL===1?'':'s')+' · '+nM+" measurement"+(nM===1?'':'s'));
 for(const g of conPares){const s=g.pares.map(r=>r.sep),med=s.reduce((a,b)=>a+b,0)/s.length;
  p.push("line spacing"+(conPares.length>1?" (series at "+fmt(inclinacion(g.ls[0].l),1)+'°)':'')+", top to bottom: "+s.map(v=>es.um>0?fmt(v*es.um/1000,2):fmt(v,1)).join(' · ')+(es.um>0?" mm; mean <b>":" px; mean <b>")+mmTxt(med,es)+'</b> = '+fmt(med,1)+' px')}
 const sel=SEL?buscarObj(SEL.t,SEL.id):null;
 if(sel&&SEL.t==='l'){const v=[];for(const g of G)for(const r of g.pares)if(r.p.l===sel||r.q.l===sel)v.push(mmTxt(r.sep,es));
  p.push("Selected: angle "+fmt(inclinacion(sel),1)+"°; marked segment "+mmTxt(largo(sel),es)+(v.length?' · '+v.join(' and ')+' from '+(v.length>1?"its neighbours":"its neighbour"):"; no near-parallel neighbour"))}
 else if(sel)p.push("Selected: <b>"+mmTxt(largo(sel),es)+'</b> · '+fmt(largo(sel),1)+' px · '+fmt(inclinacion(sel),1)+'°');
 p.push("<span class=\"muted\">"+(es.um>0?"scale "+fmt(es.um,2)+' µm/px '+es.fuente+(es.ver?'':"; ≈: this run’s physical scale is UNVERIFIED"):"Physical scale unknown; measurements are in pixels")+'</span>');
 return p.join('<br>')}
function pintarInfo(G){const el=$g('gmInfo');if(!el)return;const h=textoInfo(G||series());if(h!==infoAnt){infoAnt=h;el.innerHTML=h}}
function pintarUI(){const bL=$g('gmLineas');if(!bL)return;
 bL.classList.toggle('on',HERR==='lineas');$g('gmMedir').classList.toggle('on',HERR==='medir');
 $g('gmExt').checked=CFG.ext;$g('gmVer').checked=CFG.ver;
 const sel=SEL?buscarObj(SEL.t,SEL.id):null;
 $g('gmParalela').disabled=!(sel&&SEL.t==='l');$g('gmBorrarSel').disabled=!sel;
 $g('gmBorrarL').disabled=!D.lineas.length;$g('gmBorrarM').disabled=!D.medidas.length;
 pintarInfo()}
async function copiarJson(){if(!CLAVE||!hayGrupo())return estado("No image",true);
 const es=escala(),t=typeof meta==='function'?meta(group):{},j={formato:'vesuvius.guias.v1',
  nota:"Visual guides only, not labels. Pixel coordinates in the original PNG grid.",
  lamina:t.lam||group.id,run_id:group.id,ancho:curW,alto:curH,correccion:correccion(),um_por_px:es.um,escala_verificada:es.ver,
  de_borde_a_borde:CFG.ext,lineas:D.lineas.map(plano),medidas:D.medidas.map(plano)};
 const s=JSON.stringify(j),ta=$g('gmTa'),cuenta=' ('+D.lineas.length+" lines, "+D.medidas.length+" measurements)";ta.value=s;ta.select();
 try{await navigator.clipboard.writeText(s);estado('copiado'+cuenta)}
 catch(e){let ok=false;try{ok=document.execCommand('copy')}catch(_){}estado((ok?'copiado':'copialo a mano (ctrl+C)')+cuenta)}}
function pegarJson(){let j;try{j=JSON.parse($g('gmTa').value)}catch(e){return estado("Invalid JSON: "+e.message,true)}
 if(!j||j.formato!=='vesuvius.guias.v1')return estado("no es un Guide JSON (formato vesuvius.guias.v1)",true);
 if(!CLAVE)return estado("No image",true);
 if(+j.ancho!==curW||+j.alto!==curH)return estado("BLOCKED: guides belong to an image of "+j.ancho+'×'+j.alto+"; current image "+curW+'×'+curH,true);
 const c=correccion(),cj=Array.isArray(j.correccion)?j.correccion.slice(0,3).map(v=>+v?1:0):null;
 if(c&&cj&&c.join()!==cj.join())return estado("BLOCKED: guides belong to a DIFFERENT grid (correction "+cj.join(',')+"; this run "+c.join(',')+"): they would appear mirrored or rotated",true);
 const hacer=()=>{const n=vacio();for(const k of ['lineas','medidas'])if(Array.isArray(j[k]))for(const o of j[k])if(o&&okP(o.a)&&okP(o.b))n[k].push({id:++n.n,a:[o.a[0],o.a[1]],b:[o.b[0],o.b[1]]});
  cancelarArrastre();D=n;SEL=PEND=null;guardar();dibujar();pintarUI();
  const lam=typeof meta==='function'?meta(group).lam:'',otra=!!(j.lamina&&j.lamina!==lam);
  estado('pegadas '+n.lineas.length+" lines y "+n.medidas.length+" measurements"+(otra?' · ojo: vienen de '+j.lamina:''),otra)};
 if(D.lineas.length||D.medidas.length)confirmar($g('gmPegar'),"Replace "+(D.lineas.length+D.medidas.length)+"? Click again",hacer);else hacer()}

const css=document.createElement('style');css.id='gmCss';css.textContent=
 '#gmCapa{pointer-events:none;overflow:visible}#gmTxt{position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden}#viewport.cargando #gmTxt{visibility:hidden}'+
 '.pane .gmPane{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;overflow:visible}.pane .gmPaneTxt{position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden}'+
 '.gmRot{position:absolute;white-space:nowrap;font:11px ui-monospace,monospace;line-height:1.35;padding:1px 5px;border-radius:4px;background:#090e14d9;pointer-events:none}'+
 '.gmRot b{font-weight:600;color:#fff}.gmRotM{color:#ffd48a;border:1px solid #ffb020}.gmRotL{color:#ffc2f1;border:1px solid #ff4fd8}.gmRot.gmSel{background:#241a08f2;box-shadow:0 0 0 1px #fff9}'+
 '.gmCen{transform:translate(-50%,-50%)}.gmArr{transform:translate(-50%,calc(-100% - 7px))}.gmIzq{transform:translate(calc(-100% - 9px),-50%)}.gmDer{transform:translate(9px,-50%)}'+
 'body.etiq.gmActivo #viewport{cursor:crosshair}body.etiq.gmActivo #viewport.gmPunta{cursor:move}body.etiq.gmActivo #viewport.gmCuerpo{cursor:grab}body.etiq.gmActivo #viewport.dragging{cursor:grabbing}'+
 '#gmLineas.on{background:#3a1636;border-color:#ff4fd8;color:#ffd0f4}#gmMedir.on{background:#3a2a0c;border-color:#ffb020;color:#ffe2a8}'+
 '#gmSec .gmChk{display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:1.3;margin:3px 0}#gmSec .gmChk input{margin:2px 0 0;flex:none}'+
 '#gmInfo{font-size:12px;line-height:1.4;color:#c9d6e3;margin:4px 0;word-break:break-word}#gmInfo b{font-variant-numeric:tabular-nums}#gmInfo .muted{font-size:11px}'+
 '#gmAviso{font-size:11px;margin:2px 0 4px}#gmEstado{font:11px ui-monospace,monospace;color:#9bacbe;margin-top:4px;word-break:break-word}#gmEstado.gmAviso{color:#e0913c}'+
 '#gmJson summary{cursor:pointer;font-size:12px;color:#8fa2b6;margin:4px 0}#gmTa{width:100%;height:60px;background:#050a10;color:#e8c9f0;border:1px solid #344254;border-radius:6px;font:10px ui-monospace,monospace}'+
 '#panel button.gmConf{background:#5a2626;border-color:#a05555;color:#f3c4c4}';
document.head.append(css);
const panel=$g('panel');
const hSec=document.createElement('h3');hSec.textContent="Lines and measurements";
const sec=document.createElement('div');sec.id='gmSec';
sec.innerHTML=
 "<div class=\"fila\"><button id=\"gmLineas\" title=\"Text lines (L): click two points or drag. Drag lines or endpoints to adjust; Delete removes the selection. Spacing is shown between near-parallel lines. Visual guides only, not mask labels.\">text lines (L)</button>"+
 "<button id=\"gmMedir\" title=\"Measure (D): click two points or drag to measure length in mm and pixels and angle in degrees. Click to select; Delete removes it. Visual guides only. M opens Super mosaic.\">measure (D)</button></div>"+
 "<div class=\"muted\" id=\"gmAviso\">D measures; M opens Super mosaic. Visual guides only; masks are unchanged</div>"+
 "<label class=\"gmChk\" title=\"Extend text lines to image edges; marked segments remain thicker. Display only.\"><input type=\"checkbox\" id=\"gmExt\"><span>edge-to-edge lines</span></label>"+
 "<label class=\"gmChk\" title=\"Show or hide lines and measurements without deleting them.\"><input type=\"checkbox\" id=\"gmVer\"><span>show lines and measurements</span></label>"+
 "<div class=\"fila\"><button id=\"gmParalela\" title=\"Repeat parallel (P): copy the first or last selected line using its neighbour’s spacing.\">repeat parallel (P)</button>"+
 "<button id=\"gmBorrarSel\" title=\"Delete the selected line or measurement (Delete or Backspace)\">delete selected</button></div>"+
 "<div class=\"fila\"><button id=\"gmBorrarL\" title=\"Clear all text lines for this segment (click again to confirm)\">clear lines</button>"+
 "<button id=\"gmBorrarM\" title=\"Clear all measurements for this segment (click again to confirm)\">clear measurements</button></div>"+
 '<div id="gmInfo"></div>'+
 "<details id=\"gmJson\"><summary title=\"Guides are stored in this browser per segment and grid. Export JSON to transfer them; incompatible grids and dimensions are blocked.\">Guide JSON</summary>"+
 "<textarea id=\"gmTa\" spellcheck=\"false\" placeholder=\"JSON of this segment’s lines and measurements\"></textarea>"+
 "<div class=\"fila\"><button id=\"gmCopiar\" title=\"Copy lines and measurements in the original PNG grid to the clipboard and this field\">copy</button>"+
 "<button id=\"gmPegar\" title=\"Replace lines and measurements from this JSON. Incompatible grids or dimensions are blocked.\">paste (replace)</button></div></details>"+
 '<div id="gmEstado"></div>';
const h3sup=[...panel.querySelectorAll('h3')].find(h=>/^\s*supervision\s*$/i.test(h.textContent));
if(h3sup)h3sup.before(hSec,sec);else panel.append(hSec,sec);   /* después de «herramientas por valor» */
{const at=document.createElement('div');at.className='muted';at.style.marginTop='4px';
 at.textContent="L text lines; D measure; M Super mosaic; P repeat parallel; Delete removes the selected guide";
 const hAt=[...panel.querySelectorAll('h3')].find(h=>/^\s*shortcuts\s*$/i.test(h.textContent));
 if(hAt){let u=hAt;while(u.nextElementSibling&&u.nextElementSibling.tagName==='DIV')u=u.nextElementSibling;u.after(at)}else panel.append(at)}
const soltarFoco=el=>el.addEventListener('change',()=>el.blur());   /* que Supr, L, D… sigan andando después de tocar un control */
$g('gmLineas').onclick=()=>fijarHerr(HERR==='lineas'?'':'lineas');
$g('gmMedir').onclick=()=>fijarHerr(HERR==='medir'?'':'medir');
soltarFoco($g('gmExt'));$g('gmExt').onchange=e=>{CFG.ext=e.target.checked;guardarCfg();dibujar();estado(CFG.ext?"edge-to-edge lines":"Lines limited to marked segments")};
soltarFoco($g('gmVer'));$g('gmVer').onchange=e=>{CFG.ver=e.target.checked;guardarCfg();if(!CFG.ver&&HERR)fijarHerr('');dibujar();estado(CFG.ver?"Lines and measurements visible":"Lines and measurements hidden (not deleted)")};
$g('gmParalela').onclick=repetirParalela;$g('gmBorrarSel').onclick=borrarSel;
$g('gmBorrarL').onclick=e=>{const n=D.lineas.length;if(n<2)borrarTodas('l');else confirmar(e.currentTarget,"Delete "+n+"? Click again",()=>borrarTodas('l'))};
$g('gmBorrarM').onclick=e=>{const n=D.medidas.length;if(n<2)borrarTodas('m');else confirmar(e.currentTarget,"Delete "+n+"? Click again",()=>borrarTodas('m'))};
$g('gmCopiar').onclick=copiarJson;$g('gmPegar').onclick=pegarJson;
sec.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('button');if(b)b.blur()});

/* ---------- ganchos sobre el visor (sin reescribirlo) ---------- */
{const pn0=paintNow;paintNow=function(){const r=pn0.apply(this,arguments);try{dibujar()}catch(e){console.warn('guias_medicion:',e)}return r}}   /* zoom, paneo, --ori, imagen nueva */
{const pan=$g('panes');if(pan)new MutationObserver(()=>{try{dibujar()}catch(e){}}).observe(pan,{childList:true})}   /* paneles rehechos sin repintar */
{const me0=modoEtiq;modoEtiq=function(v){const r=me0.apply(this,arguments);if(!v&&HERR)fijarHerr('');try{dibujar()}catch(e){}return r}}
{const mo=new MutationObserver(()=>{if(!HERR)return;const on=id=>{const b=$g(id);return !!(b&&b.classList.contains('on'))};if(on('htVarita')||on('htMarcar'))fijarHerr('')});
 ['htVarita','htMarcar'].forEach(id=>{const b=$g(id);if(b)mo.observe(b,{attributes:true,attributeFilter:['class']})})}   /* W / R: sale de estas */
['mTinta','mNo','mBorrar','mRegion'].forEach(id=>{const b=$g(id);if(b)b.addEventListener('click',()=>{if(HERR)fijarHerr('')})});   /* un modo del pincel: a pintar */

/* ---------- puntero y teclado (fase de captura: con L o D activas, el pincel del núcleo no recibe el clic) ---------- */
const enVista=e=>{const t=e.target;return !!(t&&t.closest&&vp.contains(t)&&!t.closest('#panel')&&!t.closest('.pact')&&!t.closest('.et'))};
addEventListener('pointerdown',e=>{
 if(!HERR||!etiqActivo()||!hayGrupo()||e.button!==0||(typeof espacio!=='undefined'&&espacio)||!enVista(e))return;
 e.stopPropagation();e.preventDefault();sincronizar();
 if(!CLAVE){estado("Wait for the image to load",true);return}
 const g=rp(e),t=tipoHerr();CUR={x:e.clientX,y:e.clientY};
 let modo='nueva',h=null;
 if(PEND&&PEND.t===t)modo='segundo';else{h=tocar(g,t);if(h)modo=h.k?'punta':'mover'}
 ARR={id:e.pointerId,x:e.clientX,y:e.clientY,mov:0,g0:g,modo,t,obj:h?h.o:null,k:h?h.k:null,orig:h?{a:h.o.a.slice(),b:h.o.b.slice()}:null,habiaSel:!!SEL};
 if(h)SEL={t,id:h.o.id};
 try{vp.setPointerCapture(e.pointerId)}catch(_){}
 dibujar();pintarUI()},true);
addEventListener('pointermove',e=>{
 if(IGN!=null&&e.pointerId===IGN){e.stopPropagation();return}
 if(ARR&&e.pointerId===ARR.id){e.stopPropagation();
  ARR.mov+=Math.abs(e.clientX-ARR.x)+Math.abs(e.clientY-ARR.y);ARR.x=e.clientX;ARR.y=e.clientY;CUR={x:e.clientX,y:e.clientY};
  if(ARR.obj&&ARR.mov>MOV){const g=rp(e),dx=g[0]-ARR.g0[0],dy=g[1]-ARR.g0[1],o=ARR.obj,q=ARR.orig;
   if(ARR.modo==='punta')o[ARR.k]=[q[ARR.k][0]+dx,q[ARR.k][1]+dy];else{o.a=[q.a[0]+dx,q.a[1]+dy];o.b=[q.b[0]+dx,q.b[1]+dy]}}
  dibujar();return}
 if(!HERR||!etiqActivo()||!enVista(e))return;   /* sin detener: el paneo del núcleo (botón derecho o espacio) sigue igual */
 CUR={x:e.clientX,y:e.clientY};if(PEND)dibujar();
 const h=typeof drag!=='undefined'&&drag?null:tocar(rp(e),tipoHerr());vp.classList.toggle('gmPunta',!!(h&&h.k));vp.classList.toggle('gmCuerpo',!!(h&&!h.k))},true);
const soltar=e=>{
 if(IGN!=null&&e.pointerId===IGN){e.stopPropagation();IGN=null;return}
 if(!ARR||e.pointerId!==ARR.id)return;e.stopPropagation();
 const a=ARR;ARR=null;try{vp.releasePointerCapture(e.pointerId)}catch(_){}
 if(e.type==='pointercancel'){if(a.obj&&a.orig){a.obj.a=a.orig.a;a.obj.b=a.orig.b}dibujar();pintarUI();return}
 const g=rp(e),clic=a.mov<=MOV;
 if(a.modo==='segundo'){const p=PEND?PEND.a:a.g0;PEND=null;crear(a.t,p,g)}
 else if(a.modo==='nueva'){
  if(!clic){SEL=null;crear(a.t,a.g0,g)}
  else if(a.habiaSel){SEL=null;estado("No selection; click two points to mark another")}
  else{PEND={t:a.t,a:a.g0};estado("First point: click the second (Esc cancels); right-click or Space pans")}}
 else if(!clic){guardar();estado(a.modo==='punta'?'punta movida':a.t==='l'?"Line moved":"Measurement moved")}
 else estado(a.t==='l'?"Line selected: drag it or an endpoint; Delete removes it; P repeats it":"Measurement selected; Delete removes it");
 dibujar();pintarUI()};
addEventListener('pointerup',soltar,true);addEventListener('pointercancel',soltar,true);
addEventListener('dblclick',e=>{if(HERR&&etiqActivo()&&enVista(e)){e.stopPropagation();e.preventDefault()}},true);   /* dos clics rápidos no encuadran */
addEventListener('keydown',e=>{
 if(!etiqActivo()||!hayGrupo()||e.ctrlKey||e.metaKey||e.altKey)return;
 const t=e.target||{},tag=t.tagName||'';
 if(tag==='TEXTAREA'||tag==='SELECT'||t.isContentEditable||(tag==='INPUT'&&!/^(range|checkbox)$/.test(t.type)))return;
 const parar=()=>{e.preventDefault();e.stopImmediatePropagation()};
 if(e.key==='Escape'){
  if(ARR){cancelarArrastre();estado("Cancelled")}else if(PEND){PEND=null;estado("Point cancelled")}else if(SEL){SEL=null;estado("No selection")}else if(HERR){fijarHerr('');parar();return}else return;
  dibujar();pintarUI();parar();return}
 if((e.key==='Delete'||e.key==='Backspace')&&HERR&&SEL){if(!e.repeat)borrarSel();parar();return}
 if(tag==='INPUT')return;                          /* letras: como el núcleo, no con el foco en un control */
 const k=(e.key||'').toLowerCase();
 if(k==='l'||k==='d'){const h=k==='l'?'lineas':'medir';if(!e.repeat)fijarHerr(HERR===h?'':h);parar();return}
 if(k==='p'&&HERR==='lineas'){if(!e.repeat)repetirParalela();parar();return}
 if(HERR&&/^[1-4]$/.test(e.key))fijarHerr('')},true);   /* modo del pincel: sale de la herramienta y la tecla sigue al núcleo */

/* para inspeccionar desde la consola (no cambia nada) */
window.guiasMedicion={estado:()=>({herr:HERR,clave:CLAVE,lineas:D.lineas.map(plano),medidas:D.medidas.map(plano),sel:SEL&&{t:SEL.t,id:SEL.id},pend:!!PEND,arrastre:!!ARR,
 de_borde_a_borde:CFG.ext,visibles:CFG.ver,escala:escala()}),series:()=>series().map(g=>({lineas:g.ls.length,sep_px:g.pares.map(r=>r2(r.sep))}))};
pintarUI();dibujar();
console.log("guias_medicion: text lines (L) y medición (D) instaladas");
})();
