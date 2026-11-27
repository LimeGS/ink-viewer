/* ===== modo Súper: mosaico de ~100 variantes de filtro a la vez (12-sep-2026) =====
   Una region de la lamina (la que se esta mirando) dibujada en decenas de baldosas, cada una con un
   filtro distinto, en pantalla completa, navegable: arrastrar mueve la region en TODAS las baldosas a la
   vez, la rueda cambia el zoom (los radios de los filtros se reescalan para seguir midiendo lo mismo en
   micrones). Clic en una baldosa la agrega como cuadrante a la vista normal. Esc cierra. Tecla M abre.
   Cada baldosa es un canvas chico dibujado con ctx.filter = url(#svg): el costo es por baldosa (220 px),
   no por imagen entera, asi que 100 filtros con blur entran en un cuadro. Requiere filtros_pro.js. */
(function(){
 if(typeof fxArmarFiltro!=='function'){console.warn('super_mosaico: falta filtros_pro.js');return}
 const NS='http://www.w3.org/2000/svg';
 /* ---- variantes: familias x barridos de parametros (~100) ---- */
 function variantes(){
  /* Combinaciones CRUZADAS de familias con rangos amplios: cada baldosa cambia varias propiedades a la vez, para que
     lo que una sola no muestra aparezca en el cruce. Familia de frecuencia (13) x tono (5) = 65, con paleta e
     inversion rotando; + 20 estructura/bordes; + 12 extremos de una sola propiedad. Ventana 96-160 tras PA/DoG. */
  const V=[];const add=(g,t,fx)=>V.push({g,t,fx});
  const FREQ=[['raw',{}],['PA6 x6',{pasaalto:6,pasaGan:6}],['PA6 x15',{pasaalto:6,pasaGan:15}],['PA15 x6',{pasaalto:15,pasaGan:6}],['PA15 x15',{pasaalto:15,pasaGan:15}],
   ['PA40 x8',{pasaalto:40,pasaGan:8}],['PA90 x5',{pasaalto:90,pasaGan:5}],['DoG3 x8',{dog:1,dogRadio:3,dogGan:8}],['DoG3 x20',{dog:1,dogRadio:3,dogGan:20}],['DoG8 x8',{dog:1,dogRadio:8,dogGan:8}],
   ['DoG8 x20',{dog:1,dogRadio:8,dogGan:20}],['DoG16 x10',{dog:1,dogRadio:16,dogGan:10}],['unsharp3 r12',{local:3,radio:12}]];
  const TONO=[['p2',{auto:'p2'}],['S k8',{auto:'p2',curva:8,centro:0.5}],['S k30',{auto:'p2',curva:30,centro:0.5}],['post5',{poster:5}],['S k30 c.35',{curva:30,centro:0.35}]];
  const PAL=['','viridis','turbo','diverge','magma','','cividis','hot','inferno',''];
  let k=0;
  FREQ.forEach(([ft,ff])=>TONO.forEach(([tt,tf])=>{const fx=Object.assign({},ff,tf);
   if(ff.pasaalto||ff.dog){delete fx.auto;fx.negro=96;fx.blanco=160}
   const pal=PAL[k%PAL.length];if(pal)fx.paleta=pal;if(k%3===2)fx.invertir=true;k++;
   add('Cross',ft+' · '+tt+(pal?' · '+pal:'')+(fx.invertir?' · inv':''),fx)}));
  [['relief',{borde:'relieve',auto:'p2'}],['relief PA15',{borde:'relieve',pasaalto:15,pasaGan:8,negro:96,blanco:160}],['lap x2',{borde:'lap',auto:'p2',contraste:2.5}],['lap DoG8',{borde:'lap',dog:1,dogRadio:8,dogGan:10,negro:96,blanco:160}],
   ['sobel',{borde:'sobel',auto:'p2'}],['sobel inv',{borde:'sobel',auto:'p2',invertir:true}],['iso4',{poster:4,borde:'lap',auto:'p2',contraste:3}],['iso8 turbo',{poster:8,borde:'lap',paleta:'turbo',auto:'p2'}],
   ['iso6 DoG8',{poster:6,borde:'lap',dog:1,dogRadio:8,dogGan:8,negro:96,blanco:160}],['relief turbo',{borde:'relieve',paleta:'turbo',auto:'p2'}],['relief S30',{borde:'relieve',curva:30,centro:0.5,auto:'p2'}],['lap inv S20',{borde:'lap',invertir:true,curva:20,centro:0.5,auto:'p2'}],
   ['threshold120',{umbralOn:true,umbral:120}],['threshold150',{umbralOn:true,umbral:150}],['threshold180',{umbralOn:true,umbral:180}],['threshold PA15',{umbralOn:true,umbral:132,pasaalto:15,pasaGan:10}],
   ['post3 diverge',{poster:3,paleta:'diverge',auto:'p2'}],['post8 magma S8',{poster:8,paleta:'magma',curva:8,centro:0.5,auto:'p2'}],['blend50 DoG8',{dog:1,dogRadio:8,dogGan:12,negro:96,blanco:160,mezcla:50}],['blend30 PA15 inv',{pasaalto:15,pasaGan:12,negro:96,blanco:160,mezcla:30,invertir:true}]]
   .forEach(([t,fx])=>add('Structure',t,fx));
  [['gamma0.4',{gamma:0.4}],['gamma3',{gamma:3}],['contrast4',{contraste:4}],['levels 0-60',{negro:0,blanco:60}],['levels 40-120',{negro:40,blanco:120}],['levels 100-255',{negro:100,blanco:255}],
   ['p10 inv',{auto:'p10',invertir:true}],['S k40 c.6',{curva:40,centro:0.6}],['S k40 c.3',{curva:40,centro:0.3}],['turbo raw',{paleta:'turbo'}],['diverge p10',{paleta:'diverge',auto:'p10'}],['hot S8',{paleta:'hot',curva:8,centro:0.5,auto:'p2'}]]
   .forEach(([t,fx])=>add('Extremes',t,fx));
  // Put the presets that preserve readable strokes before the more aggressive experiments.
  const readingOrder = [
   'sobel inv', 'iso4', 'iso8 turbo', 'iso6 DoG8', 'relief turbo', 'lap inv S20',
   'raw · p2', 'raw · S k8 · viridis', 'raw · S k30 c.35 · magma', 'raw · post5 · diverge',
   'unsharp3 r12 · p2', 'unsharp3 r12 · S k8 · viridis', 'unsharp3 r12 · S k30 c.35 · magma',
   'unsharp3 r12 · post5 · diverge', 'post8 magma S8', 'contrast4',
   'threshold120', 'threshold150', 'threshold180', 'gamma0.4', 'gamma3',
   'levels 0-60', 'levels 40-120', 'levels 100-255', 'S k40 c.6', 'S k40 c.3',
   'p10 inv', 'post3 diverge', 'diverge p10', 'turbo raw', 'hot S8',
   'relief', 'relief S30', 'lap x2', 'sobel', 'blend50 DoG8', 'blend30 PA15 inv',
   'raw · S k30 · turbo · inv', 'unsharp3 r12 · S k30 · turbo · inv'
  ];
  const rank = new Map(readingOrder.map((name, index) => [name, index]));
  const position = variant => rank.get(variant.t) ?? readingOrder.length;
  return V.sort((a,b) => position(a) - position(b))}
 /* ---- estado y DOM ---- */
 let ov=null,grid=null,defs=null,V=[],cx=0,cy=0,z=0.5,tam=300,raf=0,zDefs=-1,drag=null;
 /* 25-sep: orientacion de vista (corrida corregida + voltear a mano, index.html). Las baldosas muestran la VISTA: el
    recorte se pide en la grilla del PNG y el canvas lo dibuja volteado/girado; oS = la ultima usada, para que el centro
    siga sobre el mismo punto de la imagen si cambia (tecla O, voltear ↕/↔). */
 let oS=null;const oriSuper=()=>typeof oriEf==='function'&&typeof group!=='undefined'?oriEf(group):null;
 let gridObserver=null;
 let conMax=localStorage.getItem('vesuvius.super.max')==='1';   /* depth-merge (max) column: off by default, toggle in the bar */
 const PAD=96;   /* margen oculto: los blur ven transparente fuera del canvas y dejan un halo en el borde */
 /* fuentes: la profundidad elegida en el mosaico (independiente del slider principal) y la union de profundidades */
 let prof=0,imgC=null,imgM=null;const CACHE={};let MAXP={id:null,canvas:null,listo:false};
 const urlDe=dir=>dir?new URL(mapUrl(dir,$('contrast').value),location.href).href:null;
 function obtener(url){if(!url)return null;let g=CACHE[url];if(!g){g=CACHE[url]=new Image();g.crossOrigin='anonymous';while(Object.keys(CACHE).length>4)delete CACHE[Object.keys(CACHE)[0]];g.onload=()=>pedir();g.src=url}return g}
 /* union de profundidades REAL: maximo pixel a pixel de todos los centros de la lamina (el manifest de las
    laminas cargadas desde S3 apunta 'maximum' al centro 0, no a una proyeccion). Se calcula una vez por lamina
    en un canvas con composicion 'lighten' (= max por canal) y se cachea. */
 function maxProj(){if(!group)return null;const key=Object.values(group.frames||{}).join('|')+'|'+$('contrast').value;if(MAXP.id===key)return MAXP.listo?MAXP.canvas:null;
  const entry=MAXP={id:key,canvas:null,listo:false};const fr=Object.values(group.frames||{}).map(urlDe).filter(Boolean);if(!fr.length)return null;
  const imgs=fr.map(obtener);let n=0;const listo=()=>{if(++n<imgs.length||MAXP!==entry)return;
   const w=Math.max(...imgs.map(i=>i.naturalWidth)),h=Math.max(...imgs.map(i=>i.naturalHeight));if(!w||imgs.some(i=>i.naturalWidth!==w||i.naturalHeight!==h))return;
   const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.globalCompositeOperation='lighten';
   imgs.forEach(i=>{try{g.drawImage(i,0,0)}catch(e){}});MAXP.canvas=c;MAXP.listo=true;pedir()};
  imgs.forEach(i=>{if(i.naturalWidth)listo();else i.addEventListener('load',listo,{once:true})});return null}
 function fuentes(){if(!group)return;imgC=obtener(urlDe(group.frames&&group.frames[String(prof)]));imgM=conMax?maxProj():null}
 function abrir(){
  if(!im||!im.naturalWidth){if(typeof msg==='function')msg('no image');return}
  if(ov){cerrar();return}
  V=variantes();
  const W=vp.clientWidth,H=vp.clientHeight;
  cx=(W/2-x)/zoom;cy=(H/2-y)/zoom;z=Math.max(zoom,0.25);prof=projection?0:Number(slider.value)||0;fuentes();
  /* 25-sep: (cx,cy) es un punto de la VISTA (orientacion de vista de index.html); con traspuesta ancho y alto se cruzan */
  oS=oriSuper();const[vw,vh]=oS&&oS[0]?[im.naturalHeight,im.naturalWidth]:[im.naturalWidth,im.naturalHeight];
  if(!(cx>0&&cx<vw&&cy>0&&cy<vh)){cx=vw/2;cy=vh/2}
  ov=document.createElement('div');ov.id='super';
  ov.innerHTML='<div id="superBar"><b>Super</b> <span id="superN"></span> · drag = move · wheel = zoom · double-click = main · right-click = Split view · Esc = close'+
   ' <label>tile <select id="superTam"><option value="220">220</option><option value="300" selected>300</option><option value="400">400</option><option value="500">500</option></select></label>'+
   ' <label title="Depth of the left column; the right one is always the depth merge (maximum)">depth <input type="range" id="superProf" min="'+(slider.min||-8)+'" max="'+(slider.max||8)+'" step="1" value="'+prof+'"> <output id="superProfV">'+(prof>0?'+':'')+prof+'</output></label> <button id="superMax" title="Show/hide a second column per filter with the depth merge (maximum over all depths)">merge column</button>'+
   " <button id=\"superVF\" title=\"Flip displayed rows vertically\">flip ↕</button> <button id=\"superVC\" title=\"Flip displayed columns horizontally\">flip ↔</button> <span id=\"superOri\" style=\"color:#f2dca8\" hidden></span>"+
   ' <span id="superZoom"></span> <button id="superPng" title="Download one PNG with every tile as shown (depth | max), titles included">PNG ↓</button> <button id="superCerrar">✕</button></div><div id="superGrid"></div>';
  document.body.append(ov);
  const st=document.createElement('style');st.id='superCss';st.textContent=
   '#super{position:fixed;inset:0;background:#05080c;z-index:10000;color:#c9d6e2;font:12px ui-monospace,monospace;overflow:hidden;display:flex;flex-direction:column}'+
   '#superBar{padding:6px 10px;background:#0b1016;border-bottom:1px solid #344254;display:flex;gap:10px;align-items:center;flex:0 0 auto}'+
   '#superBar button,#superBar select{font:inherit;background:#141c26;color:#c9d6e2;border:1px solid #344254;border-radius:4px;padding:2px 8px}#superBar button.on{background:#124a3a;border-color:#2d8a6d;color:#c6f2e2}'+
   '#superGrid{flex:1 1 auto;overflow:auto;display:grid;gap:4px;padding:4px;align-content:start;cursor:grab}#superGrid.drag{cursor:grabbing}'+
   '.sup{position:relative;background:#000;border:1px solid #1e2a38;display:flex;gap:2px}.sup .cel{position:relative;overflow:hidden;flex:0 0 auto}.sup canvas{display:block;position:absolute;left:-'+PAD+'px;top:-'+PAD+'px}.sup:hover{border-color:#86dcd5}'+
   '.sup .cel i{position:absolute;right:3px;top:2px;font:10px ui-monospace,monospace;font-style:normal;background:#0b1016aa;padding:0 4px;border-radius:3px;color:#9fb3c8;pointer-events:none}'+
   '.sup span{position:absolute;left:3px;bottom:2px;font-size:10px;background:#0b1016cc;padding:0 4px;border-radius:3px;color:#86dcd5;pointer-events:none}';
  document.head.append(st);
  grid=$('superGrid');defs=document.createElementNS(NS,'svg');defs.setAttribute('width',0);defs.setAttribute('height',0);defs.style.position='absolute';
  defs.innerHTML='<defs id="superDefs"></defs>';ov.append(defs);
  armarGrid();
  gridObserver=new ResizeObserver(()=>{closeMenu();columnas();pedir()});gridObserver.observe(grid);
  $('superCerrar').onclick=cerrar;$('superMax').onclick=()=>{conMax=!conMax;localStorage.setItem('vesuvius.super.max',conMax?'1':'0');$('superMax').classList.toggle('on',conMax);fuentes();armarGrid()};$('superMax').classList.toggle('on',conMax);$('superPng').onclick=()=>superPng(true);
  if(typeof window.voltear==='function'){$('superVF').onclick=()=>window.voltear('f');$('superVC').onclick=()=>window.voltear('c')}else{$('superVF').hidden=$('superVC').hidden=true}$('superTam').onchange=e=>{tam=+e.target.value;armarGrid()};
  $('superProf').oninput=e=>{prof=+e.target.value;$('superProfV').textContent=(prof>0?'+':'')+prof;fuentes();pedir()};
  grid.addEventListener('wheel',e=>{e.preventDefault();z=Math.max(.05,Math.min(8,z*Math.exp(-Math.max(-100,Math.min(100,e.deltaY))*.004)));pedir()},{passive:false});
  grid.addEventListener('scroll',pedir,{passive:true});
  grid.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,m:0};grid.setPointerCapture(e.pointerId);grid.classList.add('drag')};
  grid.onpointermove=e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;drag.m+=Math.abs(dx)+Math.abs(dy);cx-=dx/z;cy-=dy/z;pedir()};
  grid.onpointerup=e=>{const m=drag?drag.m:99;drag=null;grid.classList.remove('drag');
   };
  grid.ondblclick=e=>{const t=e.target.closest('.sup');if(t)principal(+t.dataset.i)};
  grid.oncontextmenu=e=>{const t=e.target.closest('.sup');if(!t)return;e.preventDefault();menu(e.clientX,e.clientY,+t.dataset.i)};
  document.addEventListener('keydown',tecla);pedir()}
 function cerrar(){if(!ov)return;gridObserver?.disconnect();gridObserver=null;closeMenu();ov.remove();ov=grid=defs=null;$('superCss')&&$('superCss').remove();document.removeEventListener('keydown',tecla);cancelAnimationFrame(raf);raf=0;zDefs=-1}
 function tecla(e){if(e.key==='Escape')cerrar();else if(e.key==='ArrowLeft'){cx-=60/z;pedir()}else if(e.key==='ArrowRight'){cx+=60/z;pedir()}else if(e.key==='ArrowUp'){cy-=60/z;pedir()}else if(e.key==='ArrowDown'){cy+=60/z;pedir()}}
 function columnas(){if(!grid)return;const ancho=conMax?2*tam+4:tam;const cols=Math.max(1,Math.floor((grid.clientWidth-8)/(ancho+4)));grid.style.gridTemplateColumns='repeat('+cols+','+ancho+'px)'}
 function armarGrid(){grid.innerHTML='';const ancho=conMax?2*tam+4:tam;columnas();
  V.forEach((v,i)=>{const d=document.createElement('div');d.className='sup';d.dataset.i=i;d.style.width=ancho+'px';d.style.height=tam+'px';d.title=v.g+' · '+v.t+'\n'+JSON.stringify(v.fx);
   (conMax?['prof','max']:['prof']).forEach(k=>{const cel=document.createElement('div');cel.className='cel';cel.style.width=cel.style.height=tam+'px';
    const c=document.createElement('canvas');c.dataset.k=k;c.width=c.height=1;c.style.width=c.style.height=(tam+2*PAD)+'px';
    const et=document.createElement('i');et.textContent=k==='max'?'max':'c';cel.append(c,et);d.append(cel)});
   const s=document.createElement('span');s.textContent=v.t;d.append(s);grid.append(d)});
  $('superN').textContent=V.length+' filters';zDefs=-1;pedir()}
 function escalar(fx){const o=Object.assign({},fx);['radio','pasaalto','dogRadio'].forEach(k=>{if(o[k])o[k]=Math.max(0.3,o[k]*z)});return o}
 function pedir(){if(raf)return;raf=requestAnimationFrame(()=>{raf=0;dibujar()})}
 function dibujar(all=false){if(!ov||!grid||!defs)return;
  if(zDefs!==z){defs.querySelector('defs').replaceChildren();zDefs=z}
  const oN=oriSuper(),iw=im.naturalWidth,ih=im.naturalHeight;
  if(String(oN)!==String(oS)&&iw){const gp=oriAGrilla(oS,iw,ih,cx,cy);[cx,cy]=oriAVista(oN,iw,ih,gp[0],gp[1])}
  oS=oN;
  const vf=$('superVF'),vc=$('superVC'),so=$('superOri');
  if(vf&&typeof VOLT!=='undefined'){vf.classList.toggle('on',!!VOLT.f);vc.classList.toggle('on',!!VOLT.c)}
  if(so&&typeof oriTexto==='function'){const t=oriTexto(group);so.textContent=t;so.hidden=!t}
  $('superZoom').textContent=Math.round(z*100)+'% · centre '+Math.round(cx)+','+Math.round(cy)+' · '+(VOXEL_UM>0?(tam/z*VOXEL_UM/1000).toFixed(2)+' mm per tile':Math.round(tam/z)+' px per tile (scale unknown)');
  const T=tam+2*PAD,sw=T/z,sx=cx-sw/2,sy=cy-sw/2;const A=(imgC&&imgC.complete&&imgC.naturalWidth)?imgC:null,B=conMax?(imgM||maxProj()):null;const bounds=grid.getBoundingClientRect();
  grid.querySelectorAll('.sup').forEach((d,i)=>{
   const rect=d.getBoundingClientRect();
   if(!all&&(rect.bottom<bounds.top||rect.top>bounds.bottom)){
    d.querySelectorAll('canvas').forEach(c=>{if(c.width>1)c.width=c.height=1});return}
   if(!defs.querySelector('#sup'+i))defs.querySelector('defs').append(fxArmarFiltro('sup'+i,Object.assign({},FXDEF,escalar(V[i].fx))));
   d.querySelectorAll('canvas').forEach(c=>{if(c.width!==T)c.width=c.height=T;const src=c.dataset.k==='max'?B:A;const g=c.getContext('2d');g.clearRect(0,0,T,T);
   if(!src||!(src.naturalWidth||src.width)){g.fillStyle='#9fb3c8';g.font='14px sans-serif';g.fillText('Loading image…',PAD+12,PAD+28);return}g.filter='url(#sup'+i+')';
   try{if(oS){const w=src.naturalWidth||src.width,h=src.naturalHeight||src.height,p=oriAGrilla(oS,w,h,sx,sy),q=oriAGrilla(oS,w,h,sx+sw,sy+sw),[ot,of,oc]=oS;
     g.setTransform(ot?0:(oc?-1:1),ot?(of?-1:1):0,ot?(oc?-1:1):0,ot?0:(of?-1:1),oc?T:0,of?T:0);   /* la misma matriz que la vista, en una baldosa T x T */
     g.drawImage(src,Math.min(p[0],q[0]),Math.min(p[1],q[1]),sw,sw,0,0,T,T)}
    else g.drawImage(src,sx,sy,sw,sw,0,0,T,T)}catch(e){}g.setTransform(1,0,0,1,0,0);g.filter='none'});
   const et=d.querySelector('.cel i');if(et)et.textContent='c'+(prof>0?'+':'')+prof})}
 /* one giant PNG of the whole mosaic: every tile pair (depth | max) copied from its on-screen canvas (already filtered),
    laid out roughly square (not the screen's column count), title under each pair, tag on each tile */
 window.superPng=function(bajar){if(!grid)return null;dibujar(true);const sups=[...grid.querySelectorAll('.sup')];if(!sups.length)return null;
  const W=conMax?2*tam+4:tam,Hc=tam+22,GAP=8,N=sups.length,cols=Math.max(1,Math.round(Math.sqrt(N*Hc/(W+GAP)))),rows=Math.ceil(N/cols);
  const HEAD=34,c=document.createElement('canvas');c.width=cols*(W+GAP)+GAP;c.height=HEAD+rows*(Hc+GAP)+GAP;const g=c.getContext('2d');
  g.fillStyle='#0b1016';g.fillRect(0,0,c.width,c.height);g.fillStyle='#c9d6e2';g.font='bold 15px ui-monospace,monospace';
  const lam=(typeof group!=='undefined'&&group&&group.id)||'lamina';
  g.fillText('Super · '+lam+' · centre '+Math.round(cx)+','+Math.round(cy)+' · zoom '+Math.round(z*100)+'% · left = depth c'+(prof>0?'+':'')+prof+' · right = depth merge (max) · '+N+' filters · '+(VOXEL_UM>0?(tam/z*VOXEL_UM/1000).toFixed(2)+' mm per tile':Math.round(tam/z)+' px per tile (scale unknown)'),GAP,22);
  sups.forEach((d,n)=>{const x0=GAP+(n%cols)*(W+GAP),y0=HEAD+GAP+Math.floor(n/cols)*(Hc+GAP);
   d.querySelectorAll('canvas').forEach((cv,k)=>{const x=x0+k*(tam+4);g.drawImage(cv,PAD,PAD,tam,tam,x,y0,tam,tam);
    g.fillStyle='rgba(0,0,0,.55)';g.fillRect(x,y0,46,16);g.fillStyle='#8ef0c8';g.font='11px ui-monospace,monospace';g.fillText(k?'max':'c'+(prof>0?'+':'')+prof,x+4,y0+12)});
   g.fillStyle='#c9d6e2';g.font='12px ui-monospace,monospace';const t=(V[+d.dataset.i]||{}).t||'';g.fillText(t.slice(0,60),x0+2,y0+tam+15)});
  if(bajar){const a=document.createElement('a');a.download='super_'+lam+'_c'+(prof>0?'+':'')+prof+'_z'+Math.round(z*100)+'.png';
   c.toBlob(b=>{a.href=URL.createObjectURL(b);a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)},'image/png')}
  return c};
 function paneDe(i){const v=V[i];return v?{t:'Super: '+v.t,fx:Object.assign({},FXDEF,v.fx)}:null}
 function terminar(t){cerrar();defsPanes();pintarPanes();fxPintarPresets();if(typeof fit==='function')fit();if(typeof msg==='function')msg(t)}
 function principal(i){
  const preset=V[i];if(!preset)return;
  if(MODSEL.length>1){
   const picker=$('selModelo'), model=picker.value||MODSEL[0];
   MODSEL=[model];
   llenarModelos(Array.from(picker.options,option=>option.value),model,lamActual());
  }
  PANES=[];
  FX=Object.assign({},FXDEF,preset.fx,{abierto:FX.abierto});
  fxGuardar();fxAUI();fxPedir();
  terminar('Main view: '+preset.t)
 }
 /* Split view: se AGREGA a los cuadrantes que ya estan (hasta 4; lleno reemplaza el ultimo) */
 function llevar(i){const p=paneDe(i);if(!p)return;const j=PANES.findIndex(q=>q.t===p.t);if(j<0){if(PANES.length<4)PANES.push(p);else PANES[3]=p}terminar('split view: '+p.t)}
 let menuEl=null;
 function closeMenu(){menuEl?.remove();menuEl=null;document.removeEventListener('pointerdown',dismissMenu)}
 function dismissMenu(event){if(menuEl&&!menuEl.contains(event.target))closeMenu()}
 function menu(px,py,i){closeMenu();menuEl=document.createElement('div');menuEl.style.cssText='position:fixed;z-index:10001;left:'+px+'px;top:'+py+'px;background:var(--grilli-panel,#0b1016);border:1px solid var(--grilli-control-border,#344254);border-radius:4px;padding:4px;font:12px var(--grilli-font,ui-monospace);color:var(--grilli-text,#c9d6e2);box-shadow:0 4px 18px #000a';
  [['Split view (add to the viewer)',()=>llevar(i)],['Set as main view',()=>principal(i)],['Cancel',()=>{}]].forEach(([t,f])=>{const b=document.createElement('div');b.textContent=t;b.style.cssText='padding:5px 12px;cursor:pointer;border-radius:4px';
   b.onmouseenter=()=>b.style.background='var(--grilli-raised,#1e2a38)';b.onmouseleave=()=>b.style.background='';b.onclick=ev=>{ev.stopPropagation();closeMenu();f()};menuEl.append(b)});
  menuEl.id='superMenu';document.body.append(menuEl);
  const bounds=menuEl.getBoundingClientRect();menuEl.style.left=Math.max(8,Math.min(px,innerWidth-bounds.width-8))+'px';menuEl.style.top=Math.max(8,Math.min(py,innerHeight-bounds.height-8))+'px';document.addEventListener('pointerdown',dismissMenu)}
 /* ---- boton y tecla ---- */
 const b=document.createElement('button');b.id='superBtn';b.textContent='Super';b.title='Mosaic of ~100 filters at once over the region you are looking at (key M)';
 b.onclick=abrir;const fb=$('filtrosBtn');fb&&fb.after(b);
 document.addEventListener('keydown',e=>{if(e.key==='m'&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))abrir()});
 window.superAbrir=abrir;
 window.superDebug=()=>({ov:!!ov,defs:!!defs,grid:!!grid,imgC:imgC&&imgC.naturalWidth,imgM:imgM&&(imgM.width||imgM.naturalWidth),maxp:{id:MAXP.id,listo:MAXP.listo,canvas:!!MAXP.canvas},z,cx,cy,prof,V:V.length,zDefs});
 window.superDibujar=()=>{try{dibujar();return 'ok'}catch(e){return e.stack}};
})();
