/* 23-sep: map URLs. A frame is a legacy folder (<dir>/<contrast>.png, previews <contrast>_lo.jpg / _lo8.jpg) or an
   official catalog map under ../catalog/<sample>/segments/<segment>/ink-detection/<stem>[-c±NN] (fixed .png, global
   -global.png, previews downsampled/<name>-ds4.jpg / -ds8.jpg). See catalog_names.py. */
const OFFICIAL_FRAME=/^(?:\.\.\/)?catalog\/.+\/ink-detection\/[^/]+$/;
function previewOf(url,scale){
 const legacy=url.replace(/\/(fixed|global)\.png$/,'/$1_lo'+(scale===8?'8':'')+'.jpg');
 if(legacy!==url)return legacy;
 const m=/^(.*\/ink-detection)\/([^/]+)\.png$/.exec(url);
 return m?m[1]+'/downsampled/'+m[2]+'-ds'+scale+'.jpg':null;
}
function mapUrl(frame,contrast,scale){
 if(!frame)return null;
 if(!OFFICIAL_FRAME.test(frame))return frame+'/'+contrast+(scale===4?'_lo.jpg':scale===8?'_lo8.jpg':'.png');
 const ext=/\.(png|tiff?)$/i.exec(frame);
 const url=ext?frame.slice(0,-ext[0].length)+(contrast==='global'?'-global':'')+ext[0]:frame+(contrast==='global'?'-global':'')+'.png';
 if(ext&&/^tiff?$/i.test(ext[1]))return '/api/mapa/'+url.replace(/^\.\.\//,'').split('/').map(encodeURIComponent).join('/')+'?escala='+(scale||1);
 return scale?previewOf(url,scale):url;
}
/* The catalog publisher supplies this explicit association; names and paths alone never establish it. */
const hasVerifiedMeshAssociation=g=>{
 const m=g.catalogMeta, a=g.meshAssociation||m?.meshAssociation;
 return (g.mapAvailable??m?.mapAvailable)===true&&a?.status==='VERIFIED'&&['meshId','meshPath','receiptPath'].every(k=>typeof a[k]==='string'&&a[k].trim())&&Object.keys(g.frames||{}).length;
};
/* multi-rollo (29-sep): el visor carga TODAS las series del manifest (manifest-work3.js trae las de todos los rollos, cada
   una con su `scroll`); el filtro por rollo vive en el explorer (explorer_pro.js, F.rollo). Al abrir una serie de otro rollo
   irARollo actualiza la escala y el almacenamiento sin recargar la página. */
const catalogTotalSeries=manifest.length;
/* Configured catalogs without verified bindings open in browsing mode; warnings remain.
   Explicit preferences and deep links still control whether unverified maps are shown. */
/* 25-sep: &sinverificar=1 en el link las lista solo en esa carga (sin tocar la preferencia guardada) */
function mostrarSinVerificar(entries,source,saved,hash){
 const fallback=!!source&&entries.some(g=>g.catalogMeta)&&!entries.some(hasVerifiedMeshAssociation);
 return hash==='1'||(saved!==null?saved==='1':fallback);
}
const SIN_VERIFICAR=mostrarSinVerificar(manifest,window.VISOR_ORIGEN,localStorage.getItem('vesuvius.sinVerificar'),new URLSearchParams(location.hash.slice(1)).get('sinverificar'));
manifest.splice(0,manifest.length,...manifest.filter(g=>hasVerifiedMeshAssociation(g)||SIN_VERIFICAR&&Object.keys(g.frames||{}).length));
const $=id=>document.getElementById(id), vp=$('viewport'), im=$('map'), slider=$('depth'), stage=$('stage');
let group,zoom=1,x=0,y=0,fitted=true,projection=false,request=0,drag=null,fullresReady=0,fullresGroup=null,fullresDepth=null,maskReady=false;
window.annotationImageReady=()=>window.HD===true&&fullresReady===request&&fullresGroup===group&&fullresDepth===(projection?'max':String(slider.value))&&maskReady&&!!H&&H.w===curW&&H.h===curH;
/* ===== orientacion de VISTA (25-sep) =====
   render_vc3d.py dibujo en el orden de la grilla de la malla hasta el 25-sep 02:09:17 UTC: esas corridas salen espejadas o
   giradas. orientacion_vista.json (pipeline/06-tinta/orientacion_vista.py: censo orientacion_corridas_20260925.tsv +
   extension) da por corrida [traspuesta, invertir_filas, invertir_columnas, clase] de render_vc3d.orientacion(): trasponer y
   despues invertir. Se aplica SOLO a lo que se ve (matriz CSS / canvas): el PNG, la mascara (grilla ORIGINAL del PNG, el
   pincel pasa por oriAGrilla), las descargas y el catalogo no cambian. Encima se componen los botones voltear ↕ / ↔
   (a mano, localStorage). Boton «vista corregida» o tecla O: ver la orientacion original de la corrida. */
var ORI={},ORI_AUTO=true,VOLT={f:0,c:0};
try{const v=JSON.parse(localStorage.getItem('vesuvius.voltear')||'{}');VOLT={f:v.f?1:0,c:v.c?1:0}}catch(e){}
const oriAutoDe=g=>g&&ORI[g.id]||null;
/* orientacion efectiva [t,f,c] de una serie (correccion si esta activa, y voltear a mano encima); null = el PNG tal cual.
   Voltear filas/columnas de la VISTA despues de trasponer conmuta con las inversiones: se componen por XOR. */
function oriEf(g){const a=ORI_AUTO&&oriAutoDe(g),t=a?+a[0]:0,f=(a?+a[1]:0)^VOLT.f,c=(a?+a[2]:0)^VOLT.c;return t||f||c?[t,f,c]:null}
const oriDims=(o,w,h)=>o&&o[0]?[h,w]:[w,h];
/* grilla del PNG (px,py) -> vista: trasponer (X=py, Y=px) y despues invertir filas (Y=alto-Y) y/o columnas (X=ancho-X) */
function oriMatriz(o,w,h){if(!o)return 'none';const[t,f,c]=o;
 return t?`matrix(0,${f?-1:1},${c?-1:1},0,${c?h:0},${f?w:0})`:`matrix(${c?-1:1},0,0,${f?-1:1},${c?w:0},${f?h:0})`}
function oriAVista(o,w,h,px,py){if(!o)return[px,py];const[t,f,c]=o,[W,H]=oriDims(o,w,h),[X,Y]=t?[py,px]:[px,py];return[c?W-X:X,f?H-Y:Y]}
function oriAGrilla(o,w,h,X,Y){if(!o)return[X,Y];const[t,f,c]=o,[W,H]=oriDims(o,w,h);X=c?W-X:X;Y=f?H-Y:Y;return t?[Y,X]:[X,Y]}
const oriSimbolo=a=>a[0]?(a[1]&&a[2]?"⤢ anti-transpose":a[1]?'↺ 90°':a[2]?'↻ 90°':"⤡ transpose"):a[1]&&a[2]?'↻ 180°':a[1]?'↕':'↔';
function oriTexto(g){const a=ORI_AUTO&&oriAutoDe(g),p=[];if(a)p.push("corrected view "+oriSimbolo(a));if(VOLT.f)p.push("flip ↕");if(VOLT.c)p.push("flip ↔");return p.join(' · ')}
const signed=v=>Number(v)>0?'+'+v:String(v);
/* ===== regla fisica (11-sep) =====
   El render es isotropico a un voxel por pixel de imagen (TARGET_UM del renderizador = voxel_um del rollo.json del
   rollo, 25-sep; 8,64 um en PHerc1447), asi que 1 cm = 10000/voxel px de imagen (1157,4 a 8,64 um). En pantalla, un pixel
   de imagen ocupa `zoom` pixeles, de modo que 1 cm son 1157,4*zoom px de pantalla. La regla elige un paso
   "redondo" (1, 2, 5 mm, 1, 2, 5 cm...) que caiga entre 60 y 220 px de pantalla. */
let UM_POR_PX = VOXEL_UM, PX_POR_CM = 10000 / UM_POR_PX;   // 1157,41 a 8,64 um
function pasoLindo(pxPorCm){
 const cand=[.1,.2,.5,1,2,5,10,20,50];           // en cm
 for(const c of cand){const px=c*pxPorCm; if(px>=60&&px<=220)return c;}
 return cand.reduce((a,b)=>Math.abs(a*pxPorCm-120)<Math.abs(b*pxPorCm-120)?a:b);
}
function rotuloCm(c){return c<1?Math.round(c*10)+' mm':(Number.isInteger(c)?c:c.toFixed(1))+' cm';}
function pintarRegla(){
 const cx=$('reglaX').firstElementChild, cy=$('reglaY').firstElementChild;
 if(!cx||!cy||!im.naturalWidth){return}
 const dpr=devicePixelRatio||1, W=vp.clientWidth, H=vp.clientHeight-26;
 for(const [cv,w,h] of [[cx,W,26],[cy,46,H]]){if(cv.width!==Math.round(w*dpr))cv.width=Math.round(w*dpr);if(cv.height!==Math.round(h*dpr))cv.height=Math.round(h*dpr);const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);}
 if(!(UM_POR_PX>0)||group?.catalogMeta?.physicalScaleVerified===false)return;
 const pxcm=PX_POR_CM*zoom, paso=pasoLindo(pxcm), pasoPx=paso*pxcm;
 if(!isFinite(pasoPx)||pasoPx<=0)return;
 const gx=cx.getContext('2d'); gx.strokeStyle='#64ddd1'; gx.fillStyle='#9bacbe'; gx.font='10px ui-monospace,monospace'; gx.lineWidth=1;
 // x = posicion en pantalla del pixel 0 de la imagen
 let i0=Math.ceil((0-x)/pasoPx);
 for(let i=i0;;i++){const sx=x+i*pasoPx; if(sx>W)break; if(sx<0)continue;
  gx.beginPath();gx.moveTo(sx+.5,26);gx.lineTo(sx+.5,26-(i%5?7:13));gx.stroke();
  if(!(i%5)){const t=rotuloCm(i*paso);gx.fillText(t,Math.min(sx+3,W-34),11);}}
 const gy=cy.getContext('2d'); gy.strokeStyle='#64ddd1'; gy.fillStyle='#9bacbe'; gy.font='10px ui-monospace,monospace';
 let j0=Math.ceil((0-y)/pasoPx);
 for(let j=j0;;j++){const sy=y+j*pasoPx; if(sy>H)break; if(sy<0)continue;
  gy.beginPath();gy.moveTo(0,sy+.5);gy.lineTo((j%5?7:13),sy+.5);gy.stroke();
  if(!(j%5)){gy.fillText(rotuloCm(j*paso),15,Math.min(sy+10,H-2));}}
 gx.fillStyle='#64ddd1'; gx.fillText(rotuloCm(paso)+'/div',4,23);
}
/* 16-sep: changing lamina used to leave the previous image on screen while the new one loaded, so a
   sheet already drawn could be mistaken for the one still coming. Blank to grey until the new frame lands. */
function cargandoOn(){vp.classList.add('cargando')}
function cargandoOff(){vp.classList.remove('cargando')}
let paintFrame=0;
function paint(){if(!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;paintNow()})}
function paintNow(){stage.style.transform=`translate(${x}px,${y}px) scale(${zoom})`;stage.style.setProperty('--ori',oriMatriz(oriEf(group),curW||im.naturalWidth,curH||im.naturalHeight));if(window.oriMarcar)oriMarcar();$('zoom').value=Math.round(zoom*1000)/10+'%';pintarRegla();if(window.pintarPanes)pintarPanes()}
addEventListener('resize',()=>{pintarRegla();if(window.pintarPanes)pintarPanes()});
/* ===== reparto de pantalla (25-sep) =====
   El panel de etiquetado vivía DENTRO de #viewport (absoluto a la derecha) y tapaba el mapa de la derecha en la vista de varios
   modelos. Ahora es la columna derecha de #main: el viewport (y con él cajaUtil, rp, pintarPanes, la regla y fit) tiene solo el
   ancho libre. En pantallas angostas (<= 900 px) el panel sigue flotando encima, como antes.
   - Borde izquierdo del panel arrastrable (#panelTirador): de 240 px hasta dejar 320 px de mapa.
   - Separador entre las columnas de mapas (#panesSep): fraccion del ancho para la columna izquierda (15-85 %); doble clic =
     partes iguales. Con 3 o 4 mapas vale para las dos filas (el tercero sigue ocupando todo el ancho de abajo).
   - Todos los paneles comparten x, y, zoom (cada uno relativo a su caja): cajaUtil da la caja MAS ANGOSTA, asi fit() encuadra
     la imagen entera en todos; rp y el zoom con la rueda usan aPanel para saber en que panel cae el puntero.
   localStorage 'vesuvius.reparto.v1'. Cambiar un ancho repinta todo (ResizeObserver del viewport, fit() si estaba encuadrado,
   paint): mascara, espejos, pincel, vistas previas y guias siguen en la grilla con la misma matriz. */
var REPARTO={panel:0,panes:.5};
try{const s=JSON.parse(localStorage.getItem('vesuvius.reparto.v1')||'{}');if(+s.panel>=240)REPARTO.panel=+s.panel;if(+s.panes>=.15&&+s.panes<=.85)REPARTO.panes=+s.panes}catch(e){}
function guardarReparto(){try{localStorage.setItem('vesuvius.reparto.v1',JSON.stringify(REPARTO))}catch(e){}}
function corteX(W){return Math.round(W*REPARTO.panes)}   /* x del viewport donde empieza la columna derecha de mapas */
function cajasPanes(W,H,n){const c=corteX(W);
 return n===1?[[0,0,W,H]]:n===2?[[0,0,c,H],[c,0,W-c,H]]:n===3?[[0,0,c,H/2],[c,0,W-c,H/2],[0,H/2,W,H/2]]
  :[[0,0,c,H/2],[c,0,W-c,H/2],[0,H/2,c,H/2],[c,H/2,W-c,H/2]]}
/* punto del viewport (cx,cy) -> coordenadas dentro del panel de mapa que lo contiene */
function aPanel(cx,cy){const W=vp.clientWidth,H=vp.clientHeight,n=PANES.length,c=corteX(W),abajo=n>=3&&cy>=H/2,der=(n===2||n===4||(n===3&&!abajo))&&cx>=c;
 return [cx-(der?c:0),cy-(abajo?H/2:0)]}
window.aPanel=aPanel;window.corteX=corteX;
function cajaUtil(){/* tamano de la caja donde se encuadra: el viewport, o el panel de mapa mas angosto (25-sep: separador arrastrable) */
 const n=(typeof PANES!=='undefined'&&PANES)?PANES.length:0, W=vp.clientWidth, H=vp.clientHeight;
 if(n<=1)return[W,H];
 const c=corteX(W),w=Math.min(c,W-c);
 return n===2?[w,H]:[w,H/2]}
function fit(){if(!im.naturalWidth)return;const[W,H]=cajaUtil(),[iw,ih]=oriDims(oriEf(group),im.naturalWidth,im.naturalHeight);   /* traspuesta: ancho y alto de la vista se cruzan */
 zoom=Math.min(W/iw,H/ih)*.96;
 x=(W-iw*zoom)/2;y=(H-ih*zoom)/2;fitted=true;paint()}
function scaleTo(z,cx=vp.clientWidth/2,cy=vp.clientHeight/2){z=Math.max(.005,Math.min(20,z));let ratio=z/zoom;x=cx-(cx-x)*ratio;y=cy-(cy-y)*ratio;zoom=z;fitted=false;paint()}
function ensureContrast(){for(const o of $('contrast').options){o.dataset.originalLabel ||= o.textContent;o.textContent=group?.catalogMeta?.originalContrast&&o.value==='fixed'?'Original image':o.dataset.originalLabel}if(!group?.frameContrasts)return;const dir=projection?group.maximum:group.frames[Number(slider.value)],modes=group.frameContrasts[dir]||group.availableContrasts||[];for(const o of $('contrast').options)o.disabled=!modes.includes(o.value);if(modes.length&&!modes.includes($('contrast').value))$('contrast').value=modes[0]}
function show(reset=false){if(!group)return;if(pintar)release();if(!group.catalogMeta)for(const o of $('contrast').options)o.disabled=false;ensureContrast();let n=Number(slider.value),dir=projection?group.maximum:group.frames[n];$('offset').value=projection?'Max.':group.catalogMeta?.depthKnown===false?'Map':signed(n);pintarBanda(n);syncHash();if(projection){const o=group.maximumOffsets||[];$('projection').textContent='Maximum '+(o.length?signed(Math.min(...o))+'…'+signed(Math.max(...o)):'across depths')+' · can merge strokes from different sheets or artefacts.'}$('prev').disabled=projection||n<=Number(slider.min);$('next').disabled=projection||n>=Number(slider.max);slider.disabled=projection||group.catalogMeta?.depthKnown===false;$('projection').hidden=!projection;$('max').classList.toggle('active',projection);$('max').setAttribute('aria-pressed',String(projection));let token=++request;fullresReady=0;$('notice').hidden=false;im.style.opacity='.3';
 if(!dir){$('notice').textContent='This centre is not available yet';im.hidden=true;$('download').removeAttribute('href');return}
 const url=mapUrl(dir,$('contrast').value);$('notice').textContent='Loading image…';const loader=new Image();
 loader.onload=()=>{if(token!==request)return;let changed=im.naturalWidth!==loader.naturalWidth||im.naturalHeight!==loader.naturalHeight;im.onload=()=>{if(token!==request)return;fullresReady=token;fullresGroup=group;fullresDepth=projection?'max':String(n);if(reset||changed||fitted)fit();else paint();fxPedir(true)};im.src=url;im.hidden=false;im.style.opacity=$('chkMapa').checked?$('mapOp').value:0;$('notice').hidden=true;$('download').href=url;im.alt=group.id+' · '+(projection?'maximum across depths':'centre '+signed(n));$('title').textContent=group.id+' · '+loader.naturalWidth+' × '+loader.naturalHeight+' px';if(reset||changed||fitted){const[lw,lh]=oriDims(oriEf(group),loader.naturalWidth,loader.naturalHeight);zoom=Math.min(vp.clientWidth/lw,vp.clientHeight/lh)*.96;x=(vp.clientWidth-lw*zoom)/2;y=(vp.clientHeight-lh*zoom)/2;fitted=true;paint()}trasFrame(loader.naturalWidth,loader.naturalHeight)};
 /* 24-nov: a TIFF map too large for full resolution in a browser (official whole segments reach gigapixels) opens as a
    reduced, browse-only view: the 1/4 map, or the published 1/8 JPEG. fullresReady stays 0, so labeling stays locked. */
 const reduced=()=>{if(token!==request)return;const W=loader.naturalWidth,H=loader.naturalHeight,changed=im.naturalWidth!==W||im.naturalHeight!==H;
  im.onload=()=>{if(token!==request)return;if(reset||changed||fitted)fit();else paint();fxPedir(true)};
  im.src=loader.src;im.hidden=false;im.style.opacity=$('chkMapa').checked?$('mapOp').value:0;$('download').href=loader.src;
  $('notice').hidden=false;$('notice').textContent='Reduced view: this map is too large for full resolution in a browser. Browse only; labeling is off.';
  im.alt=group.id+' · reduced view';$('title').textContent=group.id+' · reduced view '+W+' × '+H+' px · browse only';trasFrame(W,H)};
 loader.onerror=()=>{if(token!==request)return;
  if(/\.tiff?$/i.test(dir||'')&&!loader.reduced){loader.reduced=true;$('notice').textContent='Too large for full resolution: loading a reduced view…';loader.onload=reduced;loader.src=mapUrl(dir,$('contrast').value,4);return}
  cargandoOff();im.hidden=true;$('notice').textContent='Could not load the image. Change the centre or try again.';$('download').removeAttribute('href')};loader.src=url;
}
/* multi-rollo (29-sep): all selection paths switch context without unloading the viewer. */
function irARollo(rollo){
 if(!rollo||!/^PHerc[0-9A-Za-z]+$/.test(rollo)||rollo===ROLLO)return false;
 if(pintar)release();flush();clearTimeout(mskTimer);mskGuardar();
 visorActivarRollo(rollo);db=abrirDb(ROLLO_CORTO);
 UM_POR_PX=VOXEL_UM;PX_POR_CM=UM_POR_PX>0?10000/UM_POR_PX:NaN;
 actualizarDataset();actualizarBandas();
 clave=null;maskReady=false;fullresReady=0;++request;++tokenM;
 const u=new URL(location.href);u.searchParams.set('rollo',rollo);history.replaceState(null,'',u.href);
 return false;
}
function select(i){if(!manifest[i])return;irARollo(visorRolloDe(manifest[i]));group=manifest[i];projection=!!group.catalogMeta?.projectionOnly;let centres=Object.keys(group.frames).map(Number).sort((a,b)=>a-b);slider.min=centres[0];slider.max=centres.at(-1);slider.step=centres.slice(1).reduce((g,v,i)=>{let b=v-centres[i];while(b){[g,b]=[b,g%b]}return g},0)||1;slider.value=centres.includes(0)?0:centres[0];pintarBandas();$('max').disabled=!group.maximum||!!group.catalogMeta?.projectionOnly;$('count').textContent=(Number(i)+1)+' / '+manifest.length+' series · '+(group.catalogMeta?.depthKnown===false?'depth undocumented':centres.length+' offsets')+(hasVerifiedMeshAssociation(group)?'':' · ⚠ mesh not verified');marcarArbol();avisoContam();avisoOrient();if(window.oriBotones)oriBotones();cargandoOn();show(true)}
$('fit').onclick=fit;$('native').onclick=()=>scaleTo(1);$('minus').onclick=()=>scaleTo(zoom/1.35);$('plus').onclick=()=>scaleTo(zoom*1.35);$('contrast').onchange=()=>show();slider.oninput=()=>show();
function step(d){if(projection||!group)return;const centres=Object.keys(group.frames).map(Number).sort((a,b)=>a-b),n=Number(slider.value),next=d>0?centres.find(c=>c>n):centres.findLast(c=>c<n);if(next!=null){slider.value=next;show()}}
$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);$('max').onclick=()=>{projection=!projection;show()};
vp.addEventListener('wheel',e=>{e.preventDefault();const r=vp.getBoundingClientRect();scaleTo(zoom*Math.exp(-Math.max(-100,Math.min(100,e.deltaY))*.008),e.clientX-r.left,e.clientY-r.top)},{passive:false});
const rp=e=>{const r=vp.getBoundingClientRect();let cx=e.clientX-r.left,cy=e.clientY-r.top;if(PANES&&PANES.length)[cx,cy]=aPanel(cx,cy);return oriAGrilla(oriEf(group),curW,curH,(cx-x)/zoom,(cy-y)/zoom)};   /* 25-sep: vista -> grilla ORIGINAL del PNG (pincel y region) */
vp.addEventListener('contextmenu',e=>{if(etiqOn)e.preventDefault()});
function paneAnnotationReady(pane){
 const i=[...$('panes').children].indexOf(pane),p=PANES&&PANES[i],image=pane.querySelector('img');
 const candidate=p&&p.modelo?grupoDeModelo(p.modelo):group;
 if(!candidate||!image||!image.complete||!image.naturalWidth||!H)return false;
 const source=p&&p.modelo?srcDeModelo(p.modelo):im.src;
 if(!source||image.src!==new URL(source,location.href).href)return false;
 return image.naturalWidth===H.w&&image.naturalHeight===H.h&&
  claveLienzo(candidate,image.naturalWidth,image.naturalHeight)+'|c'+(projection?'max':slider.value)===H.nombre;
}
window.annotationPointerReady=e=>{const pane=e.target.closest('.pane');return !pane||paneAnnotationReady(pane)};
vp.addEventListener('pointerdown',e=>{
 if(!etiqOn||e.button!==0||espacio||e.target.closest('#panel,button,input,select,textarea'))return;
 if(!window.annotationImageReady()||!window.annotationPointerReady(e)){e.preventDefault();e.stopImmediatePropagation();msg('This pane is view-only until its full-resolution image and mask grid match')}
},true);
vp.onpointerdown=e=>{if(e.target.closest('#panel'))return;movido=0;
 if(etiqOn&&mctx&&e.button===0&&!espacio){if(!window.annotationImageReady()){msg('Annotation waits for the full-resolution image and mask to load');return}pintar=true;vp.setPointerCapture(e.pointerId);const p=rp(e);
  if(modo==='region'){regIni=regFin=p;dibujarRegion()}else{prepararUndo();empezar(p[0],p[1])}return}
 if(e.button!==0&&!(etiqOn&&e.button===2))return;
 drag={id:e.pointerId,x:e.clientX,y:e.clientY};vp.setPointerCapture(e.pointerId);vp.classList.add('dragging')};
vp.onpointermove=e=>{if(pintar){const p=rp(e);movido+=9;if(modo==='region'){regFin=p;dibujarRegion()}else{mover(p[0],p[1]);espejarPronto()}return}
 if(!drag||drag.id!==e.pointerId)return;movido+=Math.abs(e.clientX-drag.x)+Math.abs(e.clientY-drag.y);
 x+=e.clientX-drag.x;y+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;fitted=false;paint()};
let s3Pend=false;
function release(e){if(pintar){pintar=false;s3Pend=true;mskGuardarPronto();if(regIni)aplicarRegion(!!(e&&e.shiftKey));else terminar();dibujarRegion();espejarMascara()}drag=null;vp.classList.remove('dragging')}
vp.onpointerup=release;vp.onpointercancel=release;vp.ondblclick=e=>{if(!e.target.closest('#panel'))fit()};
new ResizeObserver(()=>{if(fitted)fit()}).observe(vp);document.addEventListener('keydown',e=>{if(!group||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.key==='ArrowRight'){step(1);e.preventDefault()}if(e.key==='ArrowLeft'){step(-1);e.preventDefault()}
 if(e.key.toLowerCase()==='f')fit();if(e.key==='+')scaleTo(zoom*1.35);if(e.key==='-')scaleTo(zoom/1.35)});
const idParts=id=>id.match(/^(.*?)(_r(?:0|1|2|3|80|90|91|92))?__(fwd|rev)$/);
var vistaModo='mod';   /* vista del arbol: mod | zona | pos (se usa en syncHash/applyHash) */
function syncHash(){if(!group)return;const m=group.catalogMeta?null:idParts(group.id);
 const q=m?'hoja='+m[1]+'&cara='+m[3]+'&modelo='+(m[2]?m[2].slice(1):'base'):'id='+encodeURIComponent(group.id);
 history.replaceState(null,'','#'+q+'&centro='+(projection?'max':slider.value)+(etiqOn?'&etiq=1':'')+(vistaModo&&vistaModo!=='mod'?'&vista='+vistaModo:'')+(typeof ETAPAS!=='undefined'&&ETAPAS.every(x=>ET[x.k]==='si')?'&etapas=apta':'')+((typeof PANES!=='undefined'&&PANES&&PANES.length&&!PANES.some(q=>q.modelo))?'&paneles='+encodeURIComponent(PANES.map(q=>q.t).join(',')):'')+((typeof MODSEL!=='undefined'&&MODSEL.length>1)?'&modelos='+encodeURIComponent(MODSEL.join(',')):'')+(typeof fxHash==='function'?fxHash():'')+(SIN_VERIFICAR&&!hasVerifiedMeshAssociation(group)?'&sinverificar=1':''))}
function applyHash(){const p=new URLSearchParams(location.hash.slice(1));if(!p.get('hoja')&&!p.get('id'))return false;
 const mo=p.get('modelo');const id=p.get('id')||p.get('hoja')+(mo&&mo!=='base'?'_'+mo:'')+'__'+(p.get('cara')||'rev');
 /* serie: desempata cuando dos colecciones comparten el mismo id (substring del label).
    Sin el parametro el comportamiento es identico al de antes. */
 const ser=p.get('serie');
 let i=ser?manifest.findIndex(g=>g.id===id&&(g.label||'').includes(ser)):-1;
 if(i<0)i=manifest.findIndex(g=>g.id===id);if(i<0)return false;
 select(i);
 if(group!==manifest[i])return true;
 if(p.get('etiq')==='1'&&!etiqOn)modoEtiq(true);
 const vv=p.get('vista');if((vv==='pos'||vv==='zona'||vv==='mod'||vv==='malla')&&vv!==vistaModo)setVista(vv);
 /* &paneles=Inferno,Invertido,...  restaura la comparacion en cuadrantes (hasta 4) */
 const pv=p.get('paneles');
 if(pv!=null&&typeof FXPRESETS!=='undefined'){
  const q=decodeURIComponent(pv).split(',').map(t=>t.trim()).filter(Boolean).slice(0,4);
  PANES=q.map(t=>{const d=FXPRESETS.find(z=>z.t.toLowerCase()===t.toLowerCase());
    return d?{t:d.t,fx:Object.assign({},FXDEF,d.fx)}:null}).filter(Boolean);
  if(PANES.length){defsPanes();pintarPanes();fxPintarPresets();fit()}}
 if(typeof fxDesdeHash==='function'){fxDesdeHash(p);if(PANES&&PANES.length)pfxDesdeHash(p)}
 /* &modelos=r3f,r5c,... restaura el mosaico de modelos (hasta 4) de la lamina abierta */
 const mv=p.get('modelos');
 if(mv!=null){const q=decodeURIComponent(mv).split(',').map(t=>t.trim()).filter(Boolean).slice(0,4);
  setTimeout(()=>{if(!group)return;const e=LAM.get(lamActual());if(!e)return;const t=meta(group);const mods=[...new Set(e.items.map(v=>v.modelo))];
   const ok=q.filter(m=>mods.includes(m));if(ok.length>1){MODSEL=ok;llenarModelos(mods,t.modelo,t.lam);if(typeof pintarModsSum==='function')pintarModsSum();panesDeModelos();if(typeof pfxDesdeHash==='function')pfxDesdeHash(p);syncHash()}},500)}
 /* etapas=apta: deep link al atajo "fit for submission" (las 5 etapas en pasa). Sin el
    parametro no se toca nada y vale lo que haya en localStorage, igual que antes. */
 const ev=p.get('etapas');
 if(false&&ev==='apta'){
  ETAPAS.forEach(x=>ET[x.k]='si');etGuardar();
  if(typeof etapasAUI==='function')etapasAUI();pintarArbol()}
 const c=p.get('centro');
 if(c!=null&&c!==''){if(c==='max'){if(group.maximum)projection=true}else if(group.frames[Number(c)]){slider.value=Number(c)}show(true)}
 return true}
addEventListener('hashchange',applyHash);

/* ===== unificado: capas del kit, mascara compartida (etiquetar.js) y seleccion de regiones ===== */
let DATASET=window.VISOR_METADATA&&window.VISOR_METADATA.scroll===ROLLO?window.VISOR_METADATA:{};
const datasetNotice=document.createElement('span');datasetNotice.setAttribute('role','status');datasetNotice.textContent=' · Training overlap and measured position are unknown for this dataset.';datasetNotice.hidden=!!DATASET.scroll;document.querySelector('footer').append(datasetNotice);
let KIT=DATASET.kit||'../annotation-kit/';   /* kit de capas (hojas.json): lo sirve el docroot o el espejo work-3 DEL ROLLO */
/* ===== medidas por lamina (25-sep, generalizar-por-rollo) =====
   TABLA, CAND, CONTAM*, ORIENT, POS y PAR son MEDIDAS o decisiones sobre laminas de PHerc1447 (nombres como g00021, V00 o
   fr_c00 se repiten en otros rollos): valen solo en el visor de ese rollo. En otro rollo quedan vacias = no medido. */
let MEDIDAS_DE=DATASET.scroll||null,MEDIDO=ROLLO===MEDIDAS_DE;   /* multi-rollo: ROLLO = ?rollo= o PHerc1447 por defecto (rollo_visor.js) */
/* entradas viejas / publicas que no tienen sufijo __cara -> nombre de hoja en hojas.json.
   Gancho para los publicos: cuando pista-publicos deje el render de 55 capas
   (S3 PHerc1447/cribado/r2_render/<id>/layers/), correr kit_etiquetado.py, sumar la hoja a
   hojas.json con ese nombre y estas entradas quedan con capas sin tocar codigo. */
let TABLA=DATASET.TABLA||{};
const NS='http://www.w3.org/2000/svg';
let HOJAS=[],alias={},capasImg=[],clave=null,curW=0,curH=0,tokenM=0;
let etiqOn=false,renderBg=false,espacio=false,pintar=false,movido=0;
/* ===== mascaras persistentes (11-sep) =====
   Antes la mascara solo existia en memoria y se exportaba a mano; si cerrabas la pestana se
   perdia. Ahora cada trazo se guarda solo en localStorage bajo la clave (lamina, centro), y
   el arbol las lista colgadas de su malla. Se guarda el PNG del canvas, que es lo mismo que
   exporta el boton "download PNG", asi que lo guardado y lo exportado son el mismo objeto. */
/* Nombres segun la convencion oficial: la carpeta del segmento y el prefijo del archivo
   tienen que coincidir exactamente. Un segmento 20260909175654 va en una carpeta
   20260909175654/ y sus etiquetas se llaman 20260909175654_inklabels.png y
   20260909175654_supervision_mask.png. El pipeline descubre segmentos y etiquetas por ese
   nombre: si el prefijo no coincide con la carpeta, no las encuentra.
   `alias.json` traduce nuestros nombres viejos (hoja3_c1_c2, fr_c00...) al segment_id. */
var ALIAS={};
fetch('alias.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{if(d){ALIAS=d;pintarArbol();if(window.xpRepintar)window.xpRepintar()}}).catch(()=>{});
const segId=lam=>ALIAS[lam]||lam;
const nombreEtiquetas=(lam,tipo)=>segId(lam)+'_'+(tipo||'inklabels')+'.png';
const MSKKEY=visorKey('vesuvius.mascaras.v1');
var MSK={};
try{MSK=JSON.parse(localStorage.getItem(MSKKEY)||'{}')}catch(e){MSK={}}
const mskClave=()=>{if(!group)return null;const t=meta(group);
 return t.lam+'|'+(projection?'max':slider.value)};
let mskTimer=null;
function mskGuardarPronto(){clearTimeout(mskTimer);mskTimer=setTimeout(mskGuardar,800)}
function mskGuardar(){
 const k=mskClave(); if(!k||!mask||!mask.width)return;
 try{
  /* PERF 12-sep: no PNG here (the pixels are in IndexedDB per depth); only a stamp so the tree/explorer know the lamina is labelled */
  if(window.mascaraVacia&&mascaraVacia()){if(MSK[k]){delete MSK[k];mskPersistir();pintarArbol()}return}
  const nuevo=!MSK[k];
  MSK[k]={ts:Date.now(),w:mask.width,h:mask.height};
  mskPersistir(); if(nuevo)pintarArbol();
 }catch(e){}
}
function mskPersistir(){
 try{localStorage.setItem(MSKKEY,JSON.stringify(MSK))}
 catch(e){ /* cuota llena: tiro las mas viejas antes que perder las nuevas */
  const ks=Object.keys(MSK).sort((a,b)=>MSK[a].ts-MSK[b].ts);
  while(ks.length>1){delete MSK[ks.shift()];
   try{localStorage.setItem(MSKKEY,JSON.stringify(MSK));return}catch(e2){}}
 }
}
function mskCargar(k){
 const m=MSK[k]; if(!m||!mctx||!m.png)return;   /* masks now load from IndexedDB when the depth opens */
 const im=new Image();
 im.onload=()=>{mctx.clearRect(0,0,mask.width,mask.height);mctx.drawImage(im,0,0)};
 im.src=m.png;
}
/* 16-sep: referenced since 12-sep by mskGuardar and by the mask remount, but never defined, so both
   guards silently did nothing. True when no pixel of the working mask is painted. */
window.mascaraVacia=function(){const m=$('mask'); if(!m||!m.width||!m.height)return true;
 const d=m.getContext('2d',{willReadFrequently:true}).getImageData(0,0,m.width,m.height).data;
 for(let i=3;i<d.length;i+=4)if(d[i]>=128)return false;
 return true};
function mskPorLamina(lam){return Object.keys(MSK).filter(k=>k.slice(0,k.lastIndexOf('|'))===lam)}

const baseId=id=>{const m=idParts(id);return m?m[1]:id};
const hojaDe=id=>alias[TABLA[id]]||alias[baseId(id)]||null;
/* 15-sep: keys under which a mask for <sheet>|c<depth> may have been saved earlier (gallery id of a model view of the same sheet) */
window.clavesLegado=k=>{const m=k.match(/^(.*)\|c(.*)$/);if(!m)return[];const lam=m[1],c=m[2],out=[];
 for(const g of manifest){const id=g.id;if(id===lam)continue;const h=hojaDe(id);if((h&&h.nombre===lam)||baseId(id)===lam||id.startsWith(lam+'_')){out.push(id+'|c'+c);const s=id.replace(/__base\d+$/,'');if(s!==id)out.push(s+'|c'+c)}}
 return out};
/* 25-sep (bug «la máscara desaparece con BASE de principal»): el lienzo de una corrida del CATÁLOGO se guardaba con su run_id
   (run_xxx|c<N>), así que la corrida hermana abría otro lienzo, vacío. Ahora la clave es la de su GRILLA: lámina, cara, medidas
   del PNG, corrección de orientación (orientacion_vista.json) y sha de la malla. Las corridas que coinciden en todo eso (lo que
   verificar() de etiq_herramientas.js llama «misma grilla y medidas») comparten UNA máscara por profundidad; con otra grilla la
   clave es otra y siguen los bloqueos. Sin el censo de orientación todavía cargado queda la clave vieja (por corrida) y
   reclavar() la cambia cuando llega. Los lienzos viejos run_xxx|c<N> no se borran ni se escriben: etiq_herramientas.js los
   copia al de la grilla la primera vez que este se abre. Hojas del kit y alias (etiq_vc3d.js) siguen como antes. */
function claveLienzo(g,w,h){const hoja=hojaDe(g.id);if(hoja)return hoja.nombre;
 if(!g.catalogMeta||!window.lienzoPorGrilla)return baseId(g.id);   /* lienzoPorGrilla: lo prende etiq_herramientas.js, que trae la migración; sin él, la clave vieja */
 let censo=false;for(const k in ORI){censo=true;break}
 if(!censo||!(w>0)||!(h>0))return g.id;
 const a=ORI[g.id],o=a?(+a[0]?1:0)+''+(+a[1]?1:0)+(+a[2]?1:0):'000',sha=((g.meshAssociation||{}).meshSha256||'').slice(0,12)||'sinsha';
 return meta(g).lam+'|'+(g.catalogMeta.cara||'-')+'|'+w+'x'+h+'|o'+o+'|m'+sha}
window.claveLienzo=claveLienzo;

let aliasKit=[];const rolloKitInicial=ROLLO;
function cargarKit(){const rollo=ROLLO,kit=KIT;
 aliasKit.forEach(k=>delete alias[k]);aliasKit=[];HOJAS=[];
 if(!DATASET.scroll&&rollo!==rolloKitInicial)return;
 fetch(kit+'hojas.json').then(r=>r.ok?r.json():null).then(hs=>{if(rollo!==ROLLO||kit!==KIT||!Array.isArray(hs))return;HOJAS=hs;
  hs.forEach(h=>{alias[h.nombre]=h;aliasKit.push(h.nombre);Object.values(h.frames||{}).forEach(f=>{const m=/([^/]+)__(fwd|rev)_$/.exec(f.dir);if(m){alias[m[1]]=h;aliasKit.push(m[1])}})});
  clave=null;if(!vp.classList.contains('cargando'))trasFrame()}).catch(()=>{});
}
cargarKit();
function actualizarDataset(){
 DATASET=window.VISOR_METADATA?.scroll===ROLLO?window.VISOR_METADATA:{};
 datasetNotice.hidden=!!DATASET.scroll;KIT=DATASET.kit||'../annotation-kit/';
 MEDIDAS_DE=DATASET.scroll||null;MEDIDO=ROLLO===MEDIDAS_DE;TABLA=DATASET.TABLA||{};
 CAND=new Set(DATASET.CAND||[]);MODNOM=DATASET.MODNOM||{};MODCORTO=DATASET.MODCORTO||{};
 CONTAM=Object.fromEntries(Object.entries(DATASET.CONTAM||{}).map(([m,h])=>[m,new Set(Array.isArray(h)?h:[])]));
 CONTAM_SOLAPE=Object.fromEntries(Object.entries(DATASET.CONTAM_SOLAPE||{}).map(([m,h])=>[m,new Set(Array.isArray(h)?h:[])]));
 CONTAM_TXT=DATASET.CONTAM_TXT||{};ORIENT=DATASET.ORIENT||{};POS=DATASET.POS||{};
 PAR=DATASET.PAR||[];PAR_EXTRA=DATASET.PAR_EXTRA||[];
 PARES=PAR.map(p=>({a:p[0],b:p[1],v:p[2],d:p[3],f:p[4],nota:null})).concat(PAR_EXTRA.map(p=>({a:p[0],b:p[1],v:p[2],d:p[3],f:p[4],nota:p[5]})));
 CARPETAS.clear();ORDEN.forEach(k=>CARPETAS.set(k,[]));
 LAM.forEach(e=>{e.carpeta=e.hojas.map(h=>carpeta({...e,lam:h})).sort((a,b)=>ordCarpeta(a)-ordCarpeta(b))[0];if(!CARPETAS.has(e.carpeta))CARPETAS.set(e.carpeta,[]);CARPETAS.get(e.carpeta).push(e)});
 CARPETAS.forEach(v=>v.sort(compareV5Lamina));ARB=armar(vistaModo);
 cargarKit();if(window.visorAliasCorridas)window.visorAliasCorridas();
}


function trasFrame(w,h){cargandoOff();
 if(!group)return;
 curW=w||curW||im.naturalWidth;curH=h||curH||im.naturalHeight;
 if(!curW)return;
 /* one mask per DEPTH (12-sep): the sheet key carries the centre, so changing depth swaps the working mask (IndexedDB) */
 const hoja=hojaDe(group.id),k=claveLienzo(group,curW,curH)+'|c'+(projection?'max':slider.value);   /* 25-sep: clave de la grilla (ver claveLienzo) */
 if(k!==clave){clave=k;montarCapas(hoja);montarMascara(hoja,k,curW,curH)}
 const svg=$('regionOverlay');svg.setAttribute('viewBox','0 0 '+curW+' '+curH);svg.setAttribute('width',curW);svg.setAttribute('height',curH);
 dibujarRegion();
}
/* 25-sep: si el censo de orientación llega después de montar la máscara, la clave pasa de la vieja (por corrida) a la de la grilla */
function reclavar(){if(!group||!curW||vp.classList.contains('cargando'))return;
 const hoja=hojaDe(group.id),k=claveLienzo(group,curW,curH)+'|c'+(projection?'max':slider.value);
 if(k!==clave){clave=k;montarCapas(hoja);montarMascara(hoja,k,curW,curH)}}

/* la mascara vive por hoja fisica Y centro (una por profundidad); mismo raster para BASE/r1 y fwd/rev */
function flush(){if(!pendiente||!H||!mask)return;pendiente=false;clearTimeout(tSave);const n=H.nombre,store=H.database||db;
 /* capture SYNCHRONOUSLY: toBlob is async and the canvas is reset by the next iniciarMascara before the blob exists (lost strokes on depth change) */
 const snap=document.createElement('canvas');snap.width=mask.width;snap.height=mask.height;snap.getContext('2d').drawImage(mask,0,0);snap.toBlob(b=>{if(b)idb('readwrite',s=>s.put(b,n),store).catch(e=>msg('Browser mask save failed: '+e.message))})}
async function montarMascara(hoja,k,w,h){
 maskReady=false;
 if(s3Pend&&H&&mctx&&window.subirParS3&&visorPuedeGuardar){const cen=(H.nombre.match(/\|c(.+)$/)||[])[1];s3Pend=false;subirParS3(cen).then(()=>msg("Saved annotations: c"+cen)).catch(e=>msg((/^sin cambios/.test(String(e))?'':'FALLÓ el guardado de c'+cen+': ')+String(e).slice(0,100)))}   /* 25-sep herramientas */
 flush();const t=++tokenM;
 if(hoja&&(hoja.w!==w||hoja.h!==h))msg('ojo: frame '+w+'x'+h+' != sheet '+hoja.w+'x'+hoja.h);
 await iniciarMascara({nombre:k,w:hoja?hoja.w:w,h:hoja?hoja.h:h,um_px:hoja?hoja.um_px:null},$('mask'));
 if(t!==tokenM)return;
 /* 16-sep: mounting clears the canvas synchronously but restores from IndexedDB asynchronously, so a mount
    that starts while this one is awaiting the store wipes the mask we just restored and the sheet opens blank
    with its pixels still safe on disk. Once we are the last mount standing, re-restore if nothing came back. */
 if(window.mascaraVacia&&mascaraVacia()){await restaurar(k); if(t!==tokenM)return; if(window.contar)contar()}
 $('mask').style.opacity=$('mkOp').value;
 maskReady=true;
 espejarMascara();   /* split panes show the restored mask at once (before: only on the next paint/mouse move) */
}

/* capas del kit como <img> apiladas bajo el mapa de tinta: mismo raster, mismo transform */
function montarCapas(hoja){
 capasImg.forEach(i=>i.remove());capasImg=[];$('capas').innerHTML='';
 $('render').disabled=!(hoja&&hoja.capas&&hoja.capas.length);renderBg=false;$('render').classList.remove('active');
 if($('render').disabled)return;
 hoja.capas.forEach(c=>{
  const img=new Image();img.onload=()=>fxPedir(true);img.src=KIT+c.f;img.style.opacity=c.op;img.hidden=true;   // arrancan apagadas: el visor por defecto muestra tinta
  stage.insertBefore(img,im);capasImg.push(img);
  const row=document.createElement('div');row.className='capaRow';
  row.innerHTML='<input type=checkbox><span></span><input type=range min=0 max=1 step=.05>';
  row.children[1].textContent=c.label||c.nombre||String(c.f||'').split('/').pop().replace(/\.png$/,'');row.children[2].value=c.op;   /* kit layers without a label showed as blank rows (12-sep) */
  row.children[0].onchange=e=>{img.hidden=!e.target.checked};
  row.children[2].oninput=e=>{img.style.opacity=e.target.value};
  $('capas').append(row)});
}

function dibujarRegion(){let r=$('regbox');
 if(!regIni||!regFin){if(r)r.remove();return}
 if(!r){r=document.createElementNS(NS,'rect');r.id='regbox';$('regionOverlay').append(r)}
 r.setAttribute('x',Math.min(regIni[0],regFin[0]));r.setAttribute('y',Math.min(regIni[1],regFin[1]));
 r.setAttribute('width',Math.abs(regFin[0]-regIni[0]));r.setAttribute('height',Math.abs(regFin[1]-regIni[1]))}

function modoEtiq(v){etiqOn=v;$('panel').hidden=!v;document.body.classList.toggle('etiq',v);
 if(window.requireAnnotationHD)window.requireAnnotationHD(v);
 $('etiq').classList.toggle('active',v);$('etiq').setAttribute('aria-pressed',String(v));
 $('mask').style.display=v?'block':'none';espejarMascara();syncHash()}
$('etiq').onclick=()=>modoEtiq(!etiqOn);
$('mkOp').oninput=e=>{$('mask').style.opacity=e.target.value;espejarMascara()};
window.addEventListener('beforeunload',e=>{if(s3Pend){e.preventDefault();e.returnValue='Strokes not yet saved to S3'}});
$('chkMapa').onchange=e=>{im.style.opacity=e.target.checked?$('mapOp').value:0};
$('mapOp').oninput=e=>{if($('chkMapa').checked)im.style.opacity=e.target.value};
$('render').onclick=()=>{renderBg=!renderBg;$('render').classList.toggle('active',renderBg);
 $('chkMapa').checked=!renderBg;$('chkMapa').onchange({target:$('chkMapa')});
 const row=$('capas').firstElementChild;if(row){row.children[0].checked=renderBg;row.children[0].onchange({target:row.children[0]})}};
addEventListener('keydown',e=>{if(!group||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
 if(e.code==='Space'&&etiqOn){espacio=true;e.preventDefault();return}
 if(e.key==='e'||e.key==='E'){modoEtiq(!etiqOn);return}
 if(!etiqOn)return;
 if(e.key==='1')setModo('tinta');else if(e.key==='2')setModo('no');else if(e.key==='3')setModo('borrar');
 else if(e.key==='4')setModo('region');
 else if(e.key==='[')setBrocha(brocha-Math.max(1,brocha*.2));else if(e.key===']')setBrocha(brocha+Math.max(1,brocha*.2));
 else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?aplicar(redoS,undoS):aplicar(undoS,redoS)}});
addEventListener('keyup',e=>{if(e.code==='Space')espacio=false});
setModo('tinta');setBrocha(24);
/* ===== arbol de carpetas: se deriva de id + label, el manifest no cambia ===== */
let CAND=new Set(DATASET.CAND||[]);
const ORDEN=['Candidates with writing','Single sheet (union of laminae)','Family fr_ / c / union (by name, >=4 cm2)','Vuelta interior (>=4 cm2)','New laminae','Group stitching (>=4 cm2)','Publicas (>=4 cm2)','Inventario >=4 cm2','Laminae 2-4 cm2','Laminas <2 cm2','Public renders of the user','Trials and versions'];
const MODORD={base:0,r1:1,r2:2,r0:3,r90:4,r91:5,r92:6};
const MODS=['base','r1','r2','r0','r80','r90','r91','r92'];
let MODNOM=DATASET.MODNOM||{};
/* nombre corto para el desplegable de modelo */
let MODCORTO=DATASET.MODCORTO||{};
const modCorto=m=>MODCORTO[m]||m;
const modNom=m=>MODNOM[m]||m;
/* pares (lamina, modelo) donde ESA lamina se uso para entrenar ESE modelo: no es evidencia.
   r1: entrenar_r1_20260909.md §1 (5 mascaras) · r2: entrenar_r2_20260910.md §1 (3 mascaras;
   la mascara del disco dice ic_padre3 pero se aplico sobre ic_padre5b) · BASE nunca vio 1447. */
let CONTAM=Object.fromEntries(Object.entries(DATASET.CONTAM||{}).map(([model,sheets])=>[model,new Set(Array.isArray(sheets)?sheets:[])]));
/* laminas que NO se usaron para entrenar pero coinciden en el espacio con una que si:
   hoja_unica tiene el 58 % de su superficie a <=5 vox de ic_padre5b (hoja_unica_20260910.md §4). */
let CONTAM_SOLAPE=Object.fromEntries(Object.entries(DATASET.CONTAM_SOLAPE||{}).map(([model,sheets])=>[model,new Set(Array.isArray(sheets)?sheets:[])]));
let CONTAM_TXT=DATASET.CONTAM_TXT||{};
const esContam=(lam,mod)=>!!((CONTAM[mod]&&CONTAM[mod].has(lam))||(CONTAM_SOLAPE[mod]&&CONTAM_SOLAPE[mod].has(lam)));
const CONTAM_TIT='Training lamina of this model: what it shows here is not evidence and cannot be submitted.';
/* orientacion de la normal contra el umbilicus de 1447 (data/spiral/mediciones/agentes/
   orientation_registry_20260910.json + cara_correcta_20260910.md §1/§5).
   ADENTRO = convencion fisica correcta (27-ago): fwd/rev grabados NO estan cruzados.
   AFUERA = vc_render_tifxyz no oriento la normal de esa familia de malla: fwd/rev grabados
   SI estan cruzados respecto de la cara fisica (la etiqueta correcta es la opuesta).
   25-sep: medido solo en PHerc1447 (MEDIDO); en otro rollo no hay registro y no se avisa nada. */
let ORIENT=DATASET.ORIENT||{};
const orientKey=lam=>lam.replace(/__dup.*$/,'').replace(/__(fwd|rev)$/,'');
function avisoOrient(){const a=$('orientAviso');if(!group){a.hidden=true;return}
 const t=meta(group),o=ORIENT[orientKey(t.lam)];
 a.hidden=!o;
 if(!o)return;
 const cruzada=o.correcta!==t.cara;
 a.style.background=cruzada?'#7c2d12':'#4b5563';
 a.textContent='Normal measured pointing '+o.v+' (orientation_registry_20260910.json) · correct face = '+o.correcta.toUpperCase()+
  (cruzada?' · THIS VIEW ('+t.cara.toUpperCase()+') HAS ITS LABELS INVERTED with respect to the physical convention':' · this view is already the correct face')}
function avisoContam(){const a=$('contamAviso');if(!group){a.hidden=true;return}
 const t=meta(group),c=esContam(t.lam,t.modelo);a.hidden=!c;
 if(c)a.textContent=CONTAM_TXT[t.lam]||('CONTAMINATED · '+t.lam+' was used for TRAINING '+(MODCORTO[t.modelo]||t.modelo.toUpperCase())+': what you see here is not evidence and cannot be submitted.')}
function meta(g){if(g.catalogMeta)return {...g.catalogMeta,cm:null,z:'',est:''};const m=idParts(g.id),ps=(g.label||'').split(' · ');let cm=null,z='',est='';
 ps.forEach(t=>{const a=/^([\d.,]+)\s*cm²$/.exec(t);if(a)cm=parseFloat(a[1].replace(',','.'));
  if(/^z≈/.test(t))z=t;if(/^(cert\+valida|certificada|sin certificar)$/.test(t))est=t});
 if(!z){const a=/z≈\s*(\d+)/.exec(g.label||'');if(a)z='z≈'+a[1]}
 /* r3 rounds are 17-centre entries named <lamina>_r3x__base17: model r3x of that lamina (12-sep) */
 let lam0=g.id.replace(/__base17$/,''),mod0='base';const rr=/^(.*)_(r[3-9][a-z]?(?:_e\d+)?(?:_t)?|consu?)$/.exec(lam0);if(!m&&rr){lam0=rr[1];mod0=rr[2]}
 return{lam:m?m[1]:lam0,modelo:m&&m[2]?m[2].slice(1):mod0,cara:m?m[3]:'only',fam:ps[0]||'',cm,z,est}}
function carpeta(e){if(e.catalog)return 'Catalog imports · physical metadata unverified';const l=e.lam,cm=e.cm==null?0:e.cm;
 if(CAND.has(l))return ORDEN[0];
 if(l==='hoja_unica')return 'Single sheet (union of laminae)';
 if(e.fam==='Public render'||e.fam==='CT enlarged')return 'Public renders of the user';
 if(/^fr_/.test(l))return /^fr_G/.test(l)?'New laminae':'Family fr_ / c / union (by name, >=4 cm2)';
 if(/^V\d/.test(l))return cm>=4?'Vuelta interior (>=4 cm2)':'Laminae 2-4 cm2';
 if(e.fam==='Claude stitching')return cm>=4?'Group stitching (>=4 cm2)':'Laminae 2-4 cm2';
 if(/^pub_/.test(l))return 'Publicas (>=4 cm2)';
 if(e.fam==='Claude 9-Sep')return 'Trials and versions';
 if(cm>=4)return /^(c\d|ic|iC|icx|union)/.test(l)?'Family fr_ / c / union (by name, >=4 cm2)':'Inventario >=4 cm2';
 return cm>=2?'Laminae 2-4 cm2':'Laminas <2 cm2'}
/* 24-sep: one row per SEGMENT. A series belongs to the catalog segment folder its maps live in
   (catalog/<sample>/segments/<segment>/ink-detection/); series outside that layout (_unresolved) keep their lamina name.
   The old lamina name stays on every map as `hoja`: masks, gates, v5, stars and CONTAM are still keyed by it. */
const segRuta=g=>{for(const f of Object.values(g.frames||{})){const m=/catalog\/([^/]+)\/segments\/([^/]+)\/ink-detection\//.exec(f);if(m)return{scroll:m[1],seg:m[2],base:m[1]+'/segments/'+m[2]}}return null};
const SEG_ROLLOS=new Map();manifest.forEach(g=>{const s=segRuta(g);if(s){if(!SEG_ROLLOS.has(s.seg))SEG_ROLLOS.set(s.seg,new Set());SEG_ROLLOS.get(s.seg).add(s.scroll)}});
const segmentKey=s=>SEG_ROLLOS.get(s.seg)?.size>1?s.scroll+'/'+s.seg:s.seg;
const filaDe=g=>{const s=segRuta(g);return s?segmentKey(s):meta(g).lam};
const LAM=new Map(),FILA_DE_HOJA={};
manifest.forEach((g,i)=>{const t=meta(g),s=segRuta(g),k=s?segmentKey(s):t.lam;let e=LAM.get(k);
 if(!e)LAM.set(k,e={lam:k,cm:t.cm,z:t.z,est:t.est,fam:t.fam,catalog:true,scroll:s?.scroll||g.catalogMeta?.scroll||null,items:[],hojas:[]});
 if(e.cm==null)e.cm=t.cm;if(!e.z)e.z=t.z;if(!e.est)e.est=t.est;e.catalog=e.catalog&&!!g.catalogMeta;
 if(!e.hojas.includes(t.lam))e.hojas.push(t.lam);FILA_DE_HOJA[t.lam]=k;
 e.items.push({i,modelo:t.modelo,cara:t.cara,hoja:t.lam})});
const ordCarpeta=c=>{const i=ORDEN.indexOf(c);return i<0?99:i};
LAM.forEach(e=>{e.carpeta=e.hojas.map(h=>carpeta({...e,lam:h})).sort((a,b)=>ordCarpeta(a)-ordCarpeta(b))[0];e.items.sort((a,b)=>(MODORD[a.modelo]??9)-(MODORD[b.modelo]??9)||a.cara.localeCompare(b.cara))});
const CARPETAS=new Map(ORDEN.map(k=>[k,[]]));
[...LAM.values()].forEach(e=>{if(!CARPETAS.has(e.carpeta))CARPETAS.set(e.carpeta,[]);CARPETAS.get(e.carpeta).push(e)});
CARPETAS.forEach(v=>v.sort((a,b)=>(b.cm||0)-(a.cm||0)||a.lam.localeCompare(b.lam)));
let prefModelo='base',prefCara='rev';
/* un nodo = (lamina, modelo): la lamina aparece bajo cada modelo que tenga disponible */
const NODOS=[];LAM.forEach(e=>[...new Set(e.items.map(v=>v.modelo))].sort((a,b)=>(MODORD[a]??9)-(MODORD[b]??9)).forEach(m=>NODOS.push({e,mod:m})));
/* ===== VISTA POR POSICION (10-sep) =====
   Agrupa por DONDE esta la lamina en el rollo, no por quien la produjo.
   Fuente: data/spiral/mediciones/union_20260910/geometria.json (medido, NO se recalcula aca)
   + 2 laminas del visor con tifxyz local que faltaban ahi (fr_c05, malla_iC_full), calculadas
   con el mismo codigo (atlas_1447.py: umbilicus/load_xyz/geometria) el 10-sep
   + hoja_unica, DERIVADA de sus 6 miembros certificados (su tifxyz vive en la caja remota):
     z/ang/r = promedio pesado por cm2 de g00021 g00027 g00037 g00102 g00124 g00202.
   z, r en mm; ang en grados alrededor del umbilicus. f: medida | derivada.
   Las que no estan aca caen a la z del rotulo (z≈, en voxeles x 8,64 um) SOLO para la banda de
   altura, y a "angle unmeasured"; y si tampoco hay rotulo, a "no measured position". */
let POS=DATASET.POS||{};
let PAR=DATASET.PAR||[];
const PARTXT={MISMA_HOJA:['same sheet','si'],MISMA_HOJA_DEBIL:['same sheet (weak)','si'],NO_MISMA_HOJA:['different sheets','no'],VUELTA_VECINA:['neighbouring wrap','vv'],SOLAPE_MEDIDO:['overlap measured, sheet verdict NOT closed','vv']};
/* Extra dataset relationships come from metadata.json. */
let PAR_EXTRA=DATASET.PAR_EXTRA||[];
let PARES=PAR.map(p=>({a:p[0],b:p[1],v:p[2],d:p[3],f:p[4],nota:null}))
  .concat(PAR_EXTRA.map(p=>({a:p[0],b:p[1],v:p[2],d:p[3],f:p[4],nota:p[5]})));
const ZPASO=10,APASO=90;   /* ver visor_posicion_20260910.md: elegidos mirando la distribucion real */
const SINANG='angle unmeasured',SINPOS='no measured position';
const nb=z=>Math.floor(z/ZPASO)*ZPASO;
const bandaZ=z=>nb(z)+'–'+(nb(z)+ZPASO)+' mm';
const sector=a=>{const s=Math.floor(((a%360)+360)%360/APASO)*APASO;return s+'°–'+(s+APASO)+'°'};
/* z del rotulo (z≈ NNNN voxeles) como respaldo: solo para la banda de altura, nunca para angulo */
function zRotulo(e){if(!(UM_POR_PX>0))return null;const m=/(\d+(?:[.,]\d+)?)/.exec(e.z||'');return m?parseFloat(m[1].replace(',','.'))*UM_POR_PX/1000:null}   /* voxel del rollo */
/* {z,a,r,f} o null. f: medida | derivada | rotulo */
function posDe(e){const p=POS[e.lam];if(p)return{z:p.z,a:p.a,r:p.r,zi:p.zi,za:p.za,ri:p.ri,ra:p.ra,a5:p.a5,a95:p.a95,f:p.f};
 const z=zRotulo(e);return z==null?null:{z,a:null,r:null,f:'rotulo'}}
function carpetaPos(e){const p=posDe(e);if(!p)return[SINPOS,'—'];
 return[bandaZ(p.z),p.a==null?SINANG:sector(p.a)]}
/* orden: bandas de z de menor a mayor, "no measured position" al final;
   dentro de la banda, sectores por angulo y "angle unmeasured" ultimo */
const ordZ=n=>n===SINPOS?1e9:parseFloat(n);
const ordA=n=>n===SINANG?1e9:n==='—'?1e9:parseFloat(n);
const fmt=(x,d)=>x==null?'':x.toFixed(d);
/* linea gris de la vista por posicion: el RADIO es lo que distingue vueltas distintas */
function lineaPos(e){const p=posDe(e);if(!p)return'no measured position';
 if(p.f==='rotulo')return'z≈'+fmt(p.z,1)+' mm (label) · angle and radius unmeasured';
 return'z '+fmt(p.z,1)+' mm · ang '+fmt(p.a,0)+'° · r '+fmt(p.r,2)+' mm'+(p.f==='derivada'?' (derived)':'')}
function tituloPos(e){const p=posDe(e);if(!p)return'No measured position: the label has no z and there is no measured geometry for this lamina.';
 if(p.f==='rotulo')return'z≈'+fmt(p.z,1)+' mm taken from the label (z≈ in voxels × '+UM_POR_PX+' µm). Angle and radius NOT measured: that is why it falls under «'+SINANG+'».';
 return'z '+fmt(p.zi,1)+'–'+fmt(p.za,1)+' mm (median '+fmt(p.z,1)+') · mean angle '+fmt(p.a,1)+'° (p5–p95 '+fmt(p.a5,0)+'–'+fmt(p.a95,0)+'°) · radius '+fmt(p.ri,2)+'–'+fmt(p.ra,2)+' mm (median '+fmt(p.r,2)+')'+(p.f==='derivada'?' — DERIVED from the weighted mean of its 6 members, not measured on the united mesh.':' — measured on the mesh (union_20260910/geometria.json).')}
/* pares ya medidos entre las laminas visibles de esta carpeta. HUECO se omite: son 216 de 265
   y solo dicen "do not touch". */
function paresDe(lams){const S=new Set(lams);
 return PARES.filter(p=>S.has(p.a)&&S.has(p.b))}
function bloquePares(lams){const ps=paresDe(lams);if(!ps.length)return null;
 const d=document.createElement('div');d.className='pares';
 const h=document.createElement('div');h.innerHTML='<b>Already measured between these laminae</b> <i>(union_20260910/pares.json; «gap» pairs are not listed)</i>';d.append(h);
 ps.forEach(p=>{const [txt,cls]=PARTXT[p.v]||[p.v,''],l=document.createElement('div');
  l.innerHTML=p.a+' ↔ '+p.b+': <span class="'+cls+'">'+txt+'</span>';
  const ex=[];if(p.d!=null)ex.push('d '+fmt(p.d,1)+' vox');if(p.f!=null)ex.push((p.nota||fmt(p.f*100,0)+' % a <3 vox'));
  if(ex.length)l.innerHTML+=' <i>('+ex.join(' · ')+')</i>';
  d.append(l)});
 return d}
/* misma funcion de armado, con el orden de los dos niveles invertido */
function compareV5Lamina(a,b){
 const scores=typeof LEG==='object'&&LEG?LEG:{};
 const x=Number.isFinite(scores[a.lam]?.max)?scores[a.lam].max:-1;
 const y=Number.isFinite(scores[b.lam]?.max)?scores[b.lam].max:-1;
 return (b.cm??-1)-(a.cm??-1) || y-x || a.lam.localeCompare(b.lam);
}
function armar(modo){const porMod=modo==='mod',pos=modo==='pos';
 if(modo==='malla'){
  /* Nivel 1 = la MALLA (la lamina fisica). Nivel 2 = 'Laminae' (sus mapas de tinta, uno por
     modelo y cara) y 'Masks' (las que dibujaste sobre ella). Es la vista que pidio el
     usuario: todo lo derivado colgado de la malla de la que salio. */
  const out=new Map();
  NODOS.forEach(n=>{const lam=n.e.lam;
   if(!out.has(lam))out.set(lam,new Map([['Laminae',[]],['Masks',[]]]));
   out.get(lam).get('Laminae').push(n)});
  Object.keys(MSK).forEach(k=>{const h=k.slice(0,k.lastIndexOf('|')),lam=FILA_DE_HOJA[h]||h;
   if(!out.has(lam))out.set(lam,new Map([['Laminae',[]],['Masks',[]]]));
   out.get(lam).get('Masks').push({msk:k,hoja:h,e:(LAM.get(lam)||{lam,cm:null,items:[],hojas:[h]}),mod:'base'})});
  out.forEach(m=>{m.get('Laminae').sort((x,y)=>(MODORD[x.mod]??9)-(MODORD[y.mod]??9)||String(x.cara).localeCompare(String(y.cara)));
   if(!m.get('Masks').length)m.delete('Masks')});
  return new Map([...out].sort((x,y)=>compareV5Lamina(LAM.get(x[0])||{lam:x[0]},LAM.get(y[0])||{lam:y[0]})));
 }
 const A=pos?[]:porMod?MODS.map(modNom):ORDEN,B=pos?[]:porMod?['']:MODS.map(modNom);
 const out=new Map(A.map(a=>[a,new Map(B.map(b=>[b,[]]))]));
 NODOS.forEach(n=>{const mn=modNom(n.mod);let a,b;
  if(pos){const c=n.e.carpetaPos;a=c[0];b=c[1]}else{a=porMod?mn:n.e.carpeta;b=porMod?'':mn}
  if(!out.has(a))out.set(a,new Map());const m=out.get(a);if(!m.has(b))m.set(b,[]);m.get(b).push(n)});
 out.forEach(m=>m.forEach(v=>v.sort((x,y)=>compareV5Lamina(x.e,y.e))));
 if(!pos)return out;
 /* las carpetas de posicion se ordenan por altura y por angulo, no por el orden de insercion */
 const ord=new Map([...out].sort((x,y)=>ordZ(x[0])-ordZ(y[0])));
 ord.forEach((m,k)=>ord.set(k,new Map([...m].sort((x,y)=>ordA(x[0])-ordA(y[0])))));
 return ord}
LAM.forEach(e=>{if(!POS[e.lam]){const h=e.hojas.find(h=>POS[h]);if(h)POS[e.lam]=POS[h]}e.carpetaPos=carpetaPos(e)});
let ARB=armar(vistaModo);
const lamActual=()=>group?filaDe(group):null;   /* the explorer row (segment) */
const hojaActual=()=>group?meta(group).lam:null;   /* the lamina of the map on screen */
/* ===== compuertas nuevas: frac_ct (hay CT debajo) y aplanado (isometria + corte) =====
   Se cargan de all-gallery/compuertas.json APARTE del manifest, a proposito: asi un
   viewer.build_all() de otro agente no puede dejar un marcador sin reemplazar dentro del
   <script>. Si el archivo no esta, el visor funciona igual y todo queda 'unmeasured'.
   ct_ok / plano_ok pueden ser null = NO MEDIDO, que no es lo mismo que 'fail'. */
let CG={},CGum={frac_ct_min:0.95,iso_p95_max:2,corte_p95_max:0.05};
const cg=e=>CG[e.lam]||null;
const cgCT=e=>{const g=cg(e);return g?g.ct_ok:null};
const cgPL=e=>{const g=cg(e);return g?g.plano_ok:null};
const cgTxt=e=>{const g=cg(e);if(!g)return 'unmeasured';
 const a=g.frac_ct==null?'CT ?':'CT '+(g.frac_ct*100).toFixed(g.frac_ct>=0.999?0:1)+'%';
 const b=g.iso_f==null?'flat ?':'flat '+Math.max(g.iso_f,g.iso_c??g.iso_f).toFixed(1)+'% / shear '+(g.corte==null?'?':Number(g.corte).toFixed(2));
 return a+(g.ct_ok===false?' ✗':g.ct_ok===true?' ✓':'')+' · '+b+(g.plano_ok===false?' ✗':g.plano_ok===true?' ✓':'')};
const cgTitulo=e=>{const g=cg(e);if(!g)return 'Unmeasured: this lamina is missing one of the two new gates. It does NOT mean it fails.';
 return 'frac_ct '+g.frac_ct+' (threshold >= '+CGum.frac_ct_min+'; fraction of the geometry with a CT chunk in the PUBLISHED VOLUME, not in the local mirror)'
 +'\nisometry p95 rows '+g.iso_f+' % / cols '+g.iso_c+' % (threshold <= '+CGum.iso_p95_max+' %)'
 +'\nshear p95 |cos| '+g.corte+' (threshold <= '+CGum.corte_p95_max+')'
 +(g.via?'\nmeasured as: '+g.via:'')+(g.lam&&g.lam!==e.lam?'\ninventory: '+g.lam:'')};

/* ===== filtro por etapas de la compuerta (10-sep) =====
   Reemplaza el desplegable unico "Certificacion" por 5 controles INDEPENDIENTES, uno por
   etapa, cada uno con CUATRO estados: sin filtrar | pasa | no pasa | no medido. "unmeasured"
   es un estado propio, nunca se cuela dentro de "fail" (confundirlos es justo el error que
   dejo entrar 62 laminas de aire al inventario, m7-corner-bug/inventario-etiquetas).
   Fuente de cada etapa, TODAS ya cargadas en el visor, ninguna se recalcula aca:
    1) cert   -> e.est (viene de meta()/manifest): 'cert+valida' o 'certificada' = paso
                 GEOMETRY_CERTIFIED; 'sin certificar' = GEOMETRY_REJECTED_* (incluye el
                 rechazo por salto de lamina); vacio = esta lamina no tiene registro en el
                 inventario de certificacion (renders publicos, mallas nombradas) = no medido.
    2) valida -> tambien de e.est, pero es la etapa DE ADENTRO: 'cert+valida' = paso valida
                 (prior_en_0 numerico + ct_pico_offset dentro de umbral); 'certificada' a
                 secas = geometria ok pero valida NO paso; 'sin certificar' o vacio = valida
                 nunca se corrio (no medido), porque depende de haber pasado el paso 1.
    3) ct     -> cgCT(e): frac_ct >= umbral (compuertas.json, agregado por compuertas-envio).
    4) plano  -> cgPL(e): isometria p95 + corte p95 (mismo origen).
    5) area   -> e.cm >= 4 cm², el minimo del premio First Letters.
   Cada calc() devuelve true=pasa, false=no pasa, null=no medido. */
const ETAPAS=[
 {k:'cert',t:'Geometric certification (GEOMETRY_CERTIFIED vs rejected for lamina switch)',short:'Cert',g:'G',
  calc:e=>{const v=e.est||'';if(!v)return null;if(v==='sin certificar')return false;return true}},
 {k:'valida',t:'Validity (numeric prior_en_0 + ct_pico_offset)',short:'Valid',g:'V',
  calc:e=>{const v=e.est||'';if(v==='cert+valida')return true;if(v==='certificada')return false;return null}},
 {k:'ct',t:'Published CT beneath (frac_ct ≥ threshold)',short:'CT',g:'T',calc:e=>cgCT(e)},
 {k:'plano',t:'Flattening (isometry p95 + shear p95)',short:'Flattening',g:'P',calc:e=>cgPL(e)},
 {k:'area',t:'Area ≥ 4 cm² (prize minimum)',short:'Area',g:'A',calc:e=>e.cm==null?null:e.cm>=4}
];
const ETSEL=[['fEtCert','cert'],['fEtValida','valida'],['fEtCt','ct'],['fEtPlano','plano'],['fEtArea','area']];
const ETKEY=visorKey('vesuvius.etapas.v1');
let ET={};ETAPAS.forEach(x=>ET[x.k]='');
/* clave vieja 'vesuvius.cert.v1' (desplegable unico, ya retirado): se ignora sin romper nada
   si todavia esta en localStorage de una sesion anterior. */
try{const v=JSON.parse(localStorage.getItem(ETKEY)||'null');
 if(v&&typeof v==='object')ETAPAS.forEach(x=>{if(['','si','no','nomed'].includes(v[x.k]))ET[x.k]=v[x.k]})}catch(e){}
const etGuardar=()=>{try{localStorage.setItem(ETKEY,JSON.stringify(ET))}catch(e){}};
const etPasa=(r,s)=>s===''?true:s==='si'?r===true:s==='no'?r===false:r===null;
const etapasOK=()=>true;   /* RETIRADA 15-sep: los desplegables de etapas estan
  ocultos desde que el explorer los reemplazo, pero seguian filtrando el arbol, y
  un link con &etapas=apta los prendia y los GUARDABA. Un filtro invisible es un
  bug: el unico filtro ahora es el del explorer (window.XPVIS). */
const etapasOK_vieja=e=>ETAPAS.every(x=>etPasa(x.calc(e),ET[x.k]));
const ET_GLIFO={true:'✓',false:'✗',null:'?'};
const etapasTxt=e=>ETAPAS.map(x=>x.g+ET_GLIFO[x.calc(e)]).join(' ');
const etapasTitulo=e=>ETAPAS.map(x=>x.t+': '+({true:'pass',false:'fail',null:'unmeasured'})[x.calc(e)]).join('\n')+'\n\n'+cgTitulo(e);
function pintarArbol(){if($('tree').hidden||$('tree').style.display==='none')return;const q=$('buscar').value.trim().toLowerCase(),t=$('tree'),act=lamActual(),actMod=group?meta(group).modelo:null;t.innerHTML='';
 const passSet=new Set();
 NODOS.forEach(n=>{if((!q||n.e.lam.toLowerCase().includes(q))&&etapasOK(n.e)&&(!window.XPVIS||window.XPVIS.has(n.e.lam)))passSet.add(n.e.lam)});
 const evEl=$('etapasVisible');if(evEl)evEl.textContent=passSet.size+' of '+LAM.size+' laminae visible with this filter';
 const hay=n=>n.e.lam===act&&n.mod===actMod;let prim=true;
 ARB.forEach((sub,nom1)=>{
  const pasa=n=>(!q||n.e.lam.toLowerCase().includes(q))&&(n.msk?true:etapasOK(n.e))&&(!window.XPVIS||window.XPVIS.has(n.e.lam));
  const vis=[...sub].map(([b,ns])=>[b,ns.filter(pasa)]).filter(p=>p[1].length);
  if(!vis.length)return;
  const distintas=ns=>new Set(ns.map(n=>(n.e&&n.e.lam)||n.lam||n)).size;
  const tot=distintas(vis.flatMap(p=>p[1]));
  const d=document.createElement('details');d.open=!!q||prim||vis.some(p=>p[1].some(hay));prim=false;
  const su=document.createElement('summary');su.textContent=nom1+' ('+tot+')';d.append(su);
  vis.forEach(([nom2,ns])=>{let d2;
   if(nom2===''){d2=d}  /* vista por modelo: sin segundo nivel */
   else{d2=document.createElement('details');d2.open=!!q||ns.some(hay);
    const s2=document.createElement('summary');s2.textContent=nom2+' ('+distintas(ns)+')';d2.append(s2)}
   const leaf=n=>{
    if(n.msk){   /* nodo de mascara: centro + cuando se guardo */
     const b=document.createElement('button');b.className='lam msk';
     const cen=n.msk.slice(n.msk.lastIndexOf('|')+1);
     b.textContent='mask c'+(cen==='max'?'max':(+cen>=0?'+':'')+cen)+(n.hoja&&n.hoja!==n.e.lam?' · '+n.hoja:'');
     const s2=document.createElement('small');
     s2.textContent=new Date(MSK[n.msk].ts).toLocaleString('en-US',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
     b.append(s2);
     b.title='Open the lamina at that centre and load this mask';
     b.onclick=()=>{const e2=LAM.get(n.e.lam),it=e2&&e2.items.find(v=>v.hoja===n.hoja); if(it)select(it.i);else if(e2)irA(e2,'base');
      const c=n.msk.slice(n.msk.lastIndexOf('|')+1);
      if(c!=='max'){slider.value=c;show()}
      if(!etiqOn)modoEtiq(true);
      setTimeout(()=>mskCargar(n.msk),400)};
     d2.append(b); return}
    const e=n.e,ct=(e.hojas||[e.lam]).some(h=>esContam(h,n.mod)),b=document.createElement('button');b.className='lam'+(hay(n)?' sel':'')+(ct?' contam':'');
    b.textContent=(vistaModo==='malla'?(MODCORTO[n.mod]||n.mod)+' · '+(n.cara||''):e.lam);
    if(ct){b.title=CONTAM_TIT;const g=document.createElement('i');g.className='tag';g.textContent='TRAINING';b.append(g)}
    const s=document.createElement('small');
    const lg=LEG[e.lam], lgTxt=lg?('v5 '+lg.max.toFixed(3)+' @c'+lg.mejor_centro):'';
    s.textContent=vistaModo==='pos'
      ?[e.cm!=null?e.cm.toFixed(2)+' cm²':'',lineaPos(e),lgTxt,etapasTxt(e)].filter(Boolean).join(' · ')
      :[e.cm!=null?e.cm.toFixed(2)+' cm²':'',e.est,cgTxt(e),e.z,lgTxt,etapasTxt(e)].filter(Boolean).join(' · ');
    if(lg)s.title=(s.title?s.title+'\n\n':'')+'Legibility index v5-R2B (EXPERIMENTAL): maximum '+lg.max.toFixed(3)+' over 512-px windows at centre '+lg.mejor_centro+'.\nIt is an UNCALIBRATED RANKING: it orders laminae, it does not claim there are letters.';
    if(!ct)s.title=etapasTitulo(e);
    if(vistaModo==='pos'&&!ct)b.title=tituloPos(e);
    if(s.textContent)b.append(s);
    b.onclick=()=>irA(e,n.mod);d2.append(b)};
   let drawn=0,scheduled=false;
   const populate=()=>{if(scheduled||!d.open||!d2.open||drawn>=ns.length)return;scheduled=true;
    requestAnimationFrame(()=>{scheduled=false;if(!d.isConnected||!d.open||!d2.open)return;
     const limit=Math.min(ns.length,drawn+40);while(drawn<limit)leaf(ns[drawn++]);
     if(drawn===ns.length&&vistaModo==='pos'){const bp=bloquePares([...new Set(ns.flatMap(n=>n.e.hojas||[n.e.lam]))]);if(bp)d2.append(bp)}
     populate()})};
   d.addEventListener('toggle',populate);if(d2!==d)d2.addEventListener('toggle',populate);populate();
   if(d2!==d)d.append(d2)});
  t.append(d)})}
function irA(e,mod){const m=mod||prefModelo,h=hojaActual();
 const it=e.items.find(v=>v.hoja===h&&v.modelo===m&&v.cara===prefCara)||e.items.find(v=>v.modelo===m&&v.cara===prefCara)||e.items.find(v=>v.modelo===m)||e.items.find(v=>v.cara===prefCara)||e.items[0];
 prefModelo=it.modelo;prefCara=it.cara;select(it.i)}
function setVista(m){vistaModo=m;ARB=armar(m);
 [['vModelo','mod'],['vZona','zona'],['vMalla','malla'],['vPos','pos']].forEach(([id,k])=>{const on=k===m;$(id).classList.toggle('active',on);$(id).setAttribute('aria-pressed',String(on))});
 pintarArbol();const b=$('tree').querySelector('.lam.sel');if(b)b.scrollIntoView({block:'nearest'})}
const clicVista=m=>{setVista(m);syncHash()};
$('vMalla').onclick=()=>clicVista('malla');$('vModelo').onclick=()=>clicVista('mod');$('vZona').onclick=()=>clicVista('zona');$('vPos').onclick=()=>clicVista('pos');
function marcarArbol(){const e=LAM.get(lamActual());if(!e)return;const t=meta(group);prefModelo=t.modelo;prefCara=t.cara;
 const mods=[...new Set(e.items.map(v=>v.modelo))],caras=[...new Set(e.items.map(v=>v.cara))];
 llenar($('selModelo'),mods,t.modelo,t.lam);llenar($('selCara'),caras,t.cara);
 if(!MODSEL.includes(t.modelo))MODSEL=[t.modelo];
 llenarModelos(mods,t.modelo,t.lam);
 if(MODSEL.length>1)panesDeModelos();
 pintarArbol();const b=[...$('tree').querySelectorAll('.lam.sel')][0];if(b)b.scrollIntoView({block:'nearest'})}
function llenar(sel,vals,cur,lam){sel.innerHTML='';vals.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=modCorto(v)+(lam&&esContam(lam,v)?' ⚠ training':'');sel.append(o)});sel.value=cur;sel.disabled=vals.length<2}
function cambiarVariante(){const e=LAM.get(lamActual());if(!e)return;const h=hojaActual(),m=$('selModelo').value,c=$('selCara').value;
 const it=e.items.find(v=>v.hoja===h&&v.modelo===m&&v.cara===c)||e.items.find(v=>v.modelo===m&&v.cara===c);
 /* 25-sep: otro modelo de la misma lámina y cara se queda en la MISMA profundidad (antes volvía a c+00 y la máscara de esa profundidad «desaparecía») */
 const g0=group,c0=projection||!g0?null:Number(slider.value);
 if(it){select(it.i);if(c0!=null&&c0!==Number(slider.value)&&!projection&&meta(g0).cara===meta(group).cara&&group.frames[c0]){slider.value=c0;show()}}else marcarArbol()}
$('selModelo').onchange=cambiarVariante;$('selCara').onchange=cambiarVariante;
$('buscar').oninput=()=>{pintarArbol();if(window.pintarPresets)pintarPresets()};
/* ===== explorador colapsable (11-sep) =====
   El arbol ocupaba un ancho fijo y no se podia achicar: con cuatro cuadrantes de comparacion
   la imagen queda chica. Ahora se colapsa con el boton, con la tecla C o con el de la toolbar,
   y se puede arrastrar el borde para elegir el ancho. El estado y el ancho se recuerdan. */
const ARBKEY=visorKey('vesuvius.arbol.v1');
function arbolAplicar(st){
 const a=$('arbol');
 a.hidden=!!st.oculto;
 $('abrirArbol').hidden=!st.oculto;
 if(st.ancho)a.style.setProperty('--sidebar-width',st.ancho+'px');
 $('carpetas').classList.toggle('active',!st.oculto);
 $('carpetas').setAttribute('aria-pressed',String(!st.oculto));
 try{localStorage.setItem(ARBKEY,JSON.stringify(st))}catch(e){}
 if(fitted)fit(); if(window.pintarPanes)pintarPanes();
}
let ARB_ST={oculto:false,ancho:0};
try{Object.assign(ARB_ST,JSON.parse(localStorage.getItem(ARBKEY)||'{}'))}catch(e){}
const arbolToggle=()=>arbolAplicar(Object.assign(ARB_ST,{oculto:!ARB_ST.oculto}));
$('colapsar').onclick=arbolToggle;
$('abrirArbol').onclick=arbolToggle;
addEventListener('keydown',e=>{
 if(e.key!=='c'&&e.key!=='C')return;
 if(/^(INPUT|TEXTAREA|SELECT)$/.test((e.target||{}).tagName||''))return;
 arbolToggle()});
(function(){const t=$('tirador');let x0=0,w0=0,arr=false;
 t.addEventListener('pointerdown',e=>{arr=true;x0=e.clientX;w0=$('arbol').offsetWidth;t.setPointerCapture(e.pointerId);e.preventDefault()});
 t.addEventListener('pointermove',e=>{if(!arr)return;
  const w=Math.max(300,Math.min(700,innerWidth-24,w0+(e.clientX-x0)));
  $('arbol').style.setProperty('--sidebar-width',w+'px');ARB_ST.ancho=w;if(window.pintarPanes)pintarPanes()});
 t.addEventListener('pointerup',()=>{if(!arr)return;arr=false;arbolAplicar(ARB_ST)});})();
arbolAplicar(ARB_ST);
$('carpetas').onclick=arbolToggle;
$('buscar').value='';/* el navegador recuerda el search y dejaria el arbol filtrado al recargar */

/* ===== filtros de imagen =====
   gamma / brillo / contraste / invertir salen gratis con filter: de CSS (el gamma via feComponentTransfer).
   umbral y falso color piden pixeles: se resuelven con UNA tabla de 256 entradas sobre el gris,
   porque las cuatro operaciones de tono son puntuales y colapsan en la misma LUT.
   Fuente = composicion de las <img> visibles del stage (mapa de tinta + capas del kit), asi el
   umbral funciona igual sobre el render de la capa 27 que sobre el mapa. Alpha se preserva:
   fuera de la hoja el PNG es transparente y sin esto el umbral la pintaria de blanco. */
const PAL={viridis:[[68,1,84],[71,45,123],[59,82,139],[44,114,142],[33,145,140],[40,174,128],[94,201,98],[173,220,48],[253,231,37]],
           inferno:[[0,0,4],[27,12,65],[74,12,107],[120,28,109],[165,44,96],[207,68,70],[237,105,37],[251,155,6],[252,255,164]]};
const FXDEF={gamma:1,brillo:1,contraste:1,invertir:false,umbralOn:false,umbral:128,paleta:'',local:0,radio:12,abierto:false};
const FXCTL=[['fGamma','gamma','num'],['fBrillo','brillo','num'],['fContraste','contraste','num'],['fUmbral','umbral','num'],
             ['fLocal','local','num'],['fRadio','radio','num'],['fInvertir','invertir','bool'],['fUmbralOn','umbralOn','bool'],['fPaleta','paleta','str']];
const FXOUT=[['vGamma','gamma',2],['vBrillo','brillo',2],['vContraste','contraste',2],['vUmbral','umbral',0],['vLocal','local',1],['vRadio','radio',0]];
const FXKEY='vesuvius.filtros.v1';
let FX=Object.assign({},FXDEF);
try{const s=JSON.parse(localStorage.getItem(FXKEY)||'{}');for(const k in FXDEF)if(k in s)FX[k]=s[k]}catch(e){}
const fxGuardar=()=>{try{localStorage.setItem(FXKEY,JSON.stringify(FX))}catch(e){};if(typeof syncHash==='function'&&typeof group!=='undefined'&&group)try{syncHash()}catch(e){}};
/* deep links: &fx= (global image filters that differ from the defaults) and &pfx= (one diff per pane) */
const fxDiff=f=>{const d={};for(const k in FXDEF){if(k==='abierto')continue;if(f&&f[k]!==undefined&&JSON.stringify(f[k])!==JSON.stringify(FXDEF[k]))d[k]=f[k]}return d};
const fxHash=()=>{const g=fxDiff(FX);let h=Object.keys(g).length?'&fx='+encodeURIComponent(JSON.stringify(g)):'';
 if(typeof PANES!=='undefined'&&PANES&&PANES.length){const ps=PANES.map(q=>fxDiff(q.fx));if(ps.some(x=>Object.keys(x).length))h+='&pfx='+encodeURIComponent(JSON.stringify(ps))}return h};
const fxDesdeHash=p=>{const g=p.get('fx');if(g){try{const d=JSON.parse(decodeURIComponent(g));FX=Object.assign({},FXDEF,d,{abierto:FX.abierto});fxGuardar();fxAUI();fxPedir()}catch(e){}}};
const pfxDesdeHash=p=>{const v=p.get('pfx');if(!v||!PANES||!PANES.length)return;try{const ps=JSON.parse(decodeURIComponent(v));ps.forEach((d,i)=>{if(PANES[i])PANES[i].fx=Object.assign({},FXDEF,d)});defsPanes();pintarPanes();if(window.fxPintarPresets)fxPintarPresets()}catch(e){}};
let fxG=null,fxA=null,fxOut=null,fxW=0,fxH=0,fxCtx=null,fxRaf=0,fxAviso='',fxDentro=false;

/* solo el umbral y el falso color necesitan canvas; el resto es CSS */
const fxCanvas=()=>FX.umbralOn||!!FX.paleta;
const fxEstado=t=>{$('fEstado').textContent=t};
function fxCss(canvas){const p=[];
 if(!canvas){/* con canvas activo el tono ya viaja dentro de la LUT: no se aplica dos veces */
  if(+FX.gamma!==1)p.push('url(#fxG)');
  if(+FX.brillo!==1)p.push('brightness('+FX.brillo+')');
  if(+FX.contraste!==1)p.push('contrast('+FX.contraste+')');
  if(FX.invertir)p.push('invert(1)')}
 if(+FX.local>0)p.push('url(#fxL)');
 return p.length?p.join(' '):'none'}
function fxDefs(){document.querySelectorAll('#fxG feFuncR,#fxG feFuncG,#fxG feFuncB').forEach(f=>f.setAttribute('exponent',1/Math.max(.01,+FX.gamma)));
 $('fxBlur').setAttribute('stdDeviation',+FX.radio);
 $('fxComp').setAttribute('k2',1+ +FX.local);$('fxComp').setAttribute('k3',-FX.local)}
function fxLut(){const l=new Uint32Array(256),g=Math.max(.01,+FX.gamma),br=+FX.brillo,co=+FX.contraste,um=+FX.umbral/255,pal=PAL[FX.paleta];
 for(let v=0;v<256;v++){let t=v/255;
  if(g!==1)t=Math.pow(t,1/g);
  t=(t*br-.5)*co+.5;
  if(FX.invertir)t=1-t;
  t=t<0?0:t>1?1:t;
  if(FX.umbralOn)t=t>=um?1:0;
  let r,gg,b;
  if(pal){const x=t*(pal.length-1),k=Math.min(pal.length-2,x|0),f=x-k;
   r=pal[k][0]+(pal[k+1][0]-pal[k][0])*f;gg=pal[k][1]+(pal[k+1][1]-pal[k][1])*f;b=pal[k][2]+(pal[k+1][2]-pal[k][2])*f}
  else r=gg=b=t*255;
  l[v]=(r&255)|((gg&255)<<8)|((b&255)<<16)}
 return l}
/* imagenes visibles del stage, en el mismo orden de apilado que ve el usuario */
const fxFuentes=()=>[...capasImg,im].filter(e=>!e.hidden&&e.naturalWidth&&(e.style.opacity===''||parseFloat(e.style.opacity)>0));
function fxExtraer(){
 fxG=fxA=fxOut=null;const es=fxFuentes();if(!es.length){fxAviso='no visible image';return false}
 const w=Math.max(...es.map(e=>e.naturalWidth)),h=Math.max(...es.map(e=>e.naturalHeight)),n=w*h;
 if(n>40e6){fxAviso=w+'×'+h+': too large for threshold / false color';return false}
 const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
 es.forEach(e=>{g.globalAlpha=e.style.opacity===''?1:parseFloat(e.style.opacity);g.drawImage(e,0,0)});
 let d;try{d=g.getImageData(0,0,w,h)}catch(err){c.width=c.height=0;fxAviso='the browser will not let the PNG be read (canvas tainted)';return false}
 c.width=c.height=0;                      // libera el respaldo del canvas de composicion
 const p=d.data;fxG=new Uint8Array(n);fxA=new Uint8Array(n);
 for(let i=0,j=0;i<n;i++,j+=4){fxG[i]=p[j];fxA[i]=p[j+3]}   // los PNG son gris en RGBA: R=G=B
 fxOut=new ImageData(w,h);fxW=w;fxH=h;fxAviso='';return true}
function fxDibujar(){
 const cv=$('fx'),canvas=fxCanvas();
 fxDentro=true;
 fxDefs();stage.style.setProperty('--fx',fxCss(canvas));
 if(!canvas){stage.classList.remove('fxon');cv.style.display='none';fxG=fxA=fxOut=null;fxEstado('');fxDentro=false;return}
 if(!fxG&&!fxExtraer()){stage.classList.remove('fxon');cv.style.display='none';fxEstado(fxAviso);fxDentro=false;return}
 const t0=performance.now(),lut=fxLut(),o=new Uint32Array(fxOut.data.buffer),g=fxG,a=fxA,n=g.length;
 for(let i=0;i<n;i++)o[i]=lut[g[i]]|(a[i]<<24);
 if(cv.width!==fxW||cv.height!==fxH){cv.width=fxW;cv.height=fxH;fxCtx=cv.getContext('2d')}
 (fxCtx||(fxCtx=cv.getContext('2d'))).putImageData(fxOut,0,0);
 cv.style.display='block';stage.classList.add('fxon');
 fxEstado(fxW+'×'+fxH+' · '+Math.round(performance.now()-t0)+' ms');fxDentro=false}
/* un cuadro por rAF: al arrastrar un deslizador sobre 20 Mpx los cuadros sobrantes se descartan */
function fxPedir(recargar){if(recargar)fxG=fxA=fxOut=null;
 if(fxRaf)return;fxRaf=requestAnimationFrame(()=>{fxRaf=0;fxDibujar()})}
/* cualquier cambio de visibilidad/opacidad/src de una <img> del stage rehace la composicion
   (capas del kit, boton "Render layer 27", casilla del mapa de tinta) */
new MutationObserver(ms=>{if(!fxDentro&&ms.some(m=>m.target.tagName==='IMG'))fxPedir(true)})
 .observe(stage,{subtree:true,attributes:true,attributeFilter:['hidden','style','src']});
function fxAUI(){FXCTL.forEach(([id,k,t])=>{const el=$(id);if(t==='bool')el.checked=!!FX[k];else el.value=FX[k]});
 FXOUT.forEach(([id,k,d])=>{$(id).textContent=(+FX[k]).toFixed(d)});
 $('filtros').hidden=!FX.abierto;$('filtrosBtn').classList.toggle('active',FX.abierto);
 $('filtrosBtn').setAttribute('aria-pressed',String(FX.abierto));$('filtrosBtn').setAttribute('aria-expanded',String(FX.abierto));
 const n=[+FX.gamma!==1,+FX.brillo!==1,+FX.contraste!==1,FX.invertir,FX.umbralOn,!!FX.paleta,+FX.local>0].filter(Boolean).length;
 $('filtrosBtn').textContent=n?'Filters ('+n+')':'Filters'}
FXCTL.forEach(([id,k,t])=>{const el=$(id),ev=t==='str'?'onchange':(t==='bool'?'onchange':'oninput');
 el[ev]=e=>{FX[k]=t==='bool'?e.target.checked:(t==='str'?e.target.value:+e.target.value);fxGuardar();fxAUI();fxPedir();if(window.fxAPaneles&&PANES&&PANES.length){fxAPaneles()}if(window.fxPintarPresets)fxPintarPresets()}});
/* 17-sep: Reset = vista cruda y nada aplicado EN NINGUN LADO. Antes solo volvia a neutro el ajuste
   global: cada panel se quedaba con su propio filtro, asi que la pantalla seguia mostrando filtros
   despues de resetear. Los paneles FIJADOS son la excepcion: el pin le gana tambien al Reset. */
$('fReset').onclick=()=>{const ab=FX.abierto;FX=Object.assign({},FXDEF,{abierto:ab});fxGuardar();fxAUI();fxPedir();
 if(PANES&&PANES.length)PANES.forEach(p=>{if(!p.fija)p.fx=Object.assign({},FXDEF)});
 if(window.defsPanes&&PANES&&PANES.length){defsPanes();pintarPanes();if(window.fxDestinoAUI)fxDestinoAUI()}
 if(window.fxPintarPresets)fxPintarPresets()};
/* ===== presets visuales (11-sep) =====
   Cada boton fija de una todos los controles de arriba. Los sliders siguen funcionando:
   tocar uno a mano deja de coincidir con el preset y el boton se apaga. */
const FXPRESETS=[
 {t:'Raw', d:'Everything neutral: the map as it came out of the model, no boost. The honest starting point to decide whether something is there.',
  fx:{}},
 {t:'Soft boost', d:'Gamma 1.6 and a touch of contrast. Lifts the mid-greys without burning the extremes: for sweeping a whole lamina to find where to look closely.',
  fx:{gamma:1.6,contraste:1.2,brillo:1.05}},
 {t:'Fine stroke', d:'Strong local contrast with a small radius (high-frequency unsharp). Separates the stroke from the background when the ink is faint. Beware: it also boosts noise and the weave of the render.',
  fx:{local:1.6,radio:8,contraste:1.3}},
 {t:'High contrast', d:'Hard contrast and low gamma. To confirm the shape of a figure you already saw, not to discover it: it crushes everything in between.',
  fx:{contraste:2.2,gamma:0.85}},
 {t:'Threshold', d:'Binarizes at 140: white above, black below. Answers one question only: is the stroke continuous or scattered blobs.',
  fx:{umbralOn:true,umbral:140}},
 {t:'Viridis', d:'Perceptually uniform false color: colour jumps are real intensity jumps. Best for judging whether a figure has relief or is flat.',
  fx:{paleta:'viridis',gamma:1.2}},
 {t:'Inferno', d:'False color with more range in the highs. Makes ink maxima pop over a muted background.',
  fx:{paleta:'inferno',contraste:1.4}},
 {t:'Inverted', d:'Light ink on dark background flipped. The eye reads dark letters on light much better, and sometimes a shape appears that is invisible the other way.',
  fx:{invertir:true,gamma:1.3}}
];
const FXCLAVES=Object.keys(FXDEF).filter(k=>k!=='abierto');
const fxPresetActivo=p=>FXCLAVES.every(k=>{const q=(k in p.fx)?p.fx[k]:FXDEF[k];
 return typeof q==='boolean'?!!FX[k]===q:(typeof q==='number'?+FX[k]===q:FX[k]===q)});
/* ===== comparacion en cuadrantes (11-sep) =====
   Tocar un preset visual ya no pisa la configuracion: AGREGA un cuadrante, hasta 4.
   Cada cuadrante muestra la MISMA imagen con el mismo encuadre, filtrada distinto, para
   comparar de un vistazo. Se implementa con un filtro SVG por cuadrante cuya tabla de
   256 valores sale de la misma LUT que usa el modo de una sola vista (fxLut), asi que
   umbral y falso color -- que no se pueden hacer con filtros CSS -- salen igual. */
var PANES=[];   // [{t, fx}]
/* Los sliders de arriba son un AJUSTE GLOBAL que se compone sobre el preset de cada
   cuadrante, no una vista aparte: gamma/brillo/contraste multiplican, invertir alterna,
   y umbral / falso color / contraste local, si estan puestos a mano, mandan sobre el preset.
   Con los sliders en su valor neutro la composicion devuelve el preset intacto. */
function fxCompuesto(base){
 const o=Object.assign({},base);
 o.gamma     = (+base.gamma)     * (+FX.gamma);
 o.brillo    = (+base.brillo)    * (+FX.brillo);
 o.contraste = (+base.contraste) * (+FX.contraste);
 if(FX.invertir) o.invertir = !base.invertir;
 if(FX.umbralOn){o.umbralOn=true; o.umbral=+FX.umbral}
 if(FX.paleta)  o.paleta=FX.paleta;
 if(+FX.local>0){o.local=+FX.local; o.radio=+FX.radio}
 return o}
function lutDe(fx){
 const l=[[],[],[]], g=Math.max(.01,+fx.gamma), br=+fx.brillo, co=+fx.contraste,
       um=+fx.umbral/255, pal=PAL[fx.paleta];
 for(let v=0;v<256;v++){let t=v/255;
  if(g!==1)t=Math.pow(t,1/g);
  t=(t*br-.5)*co+.5;
  if(fx.invertir)t=1-t;
  t=t<0?0:t>1?1:t;
  if(fx.umbralOn)t=t>=um?1:0;
  let r,gg,b;
  if(pal){const x=t*(pal.length-1),k=Math.min(pal.length-2,x|0),f=x-k;
   r=pal[k][0]+(pal[k+1][0]-pal[k][0])*f; gg=pal[k][1]+(pal[k+1][1]-pal[k][1])*f; b=pal[k][2]+(pal[k+1][2]-pal[k][2])*f;
   r/=255; gg/=255; b/=255}
  else r=gg=b=t;
  l[0].push(r.toFixed(4)); l[1].push(gg.toFixed(4)); l[2].push(b.toFixed(4))}
 return l}
function defsPanes(){
 let d=$('panesDefs');
 if(!d){const svg=document.querySelector('svg[aria-hidden]')||document.querySelector('svg');
  d=document.createElementNS('http://www.w3.org/2000/svg','defs'); d.id='panesDefs'; svg&&svg.append(d)}
 if(!d)return;
 d.innerHTML='';
 PANES.forEach((p,i)=>{
  const fxc=p.fija?p.fx:fxCompuesto(p.fx), l=lutDe(fxc), NS='http://www.w3.org/2000/svg';
  const f=document.createElementNS(NS,'filter');
  f.id='fxPane'+i; f.setAttribute('color-interpolation-filters','sRGB');
  if(+fxc.local>0){
   const bl=document.createElementNS(NS,'feGaussianBlur');
   bl.setAttribute('in','SourceGraphic'); bl.setAttribute('stdDeviation',+fxc.radio); bl.setAttribute('result','bl');
   const co=document.createElementNS(NS,'feComposite');
   co.setAttribute('in','SourceGraphic'); co.setAttribute('in2','bl'); co.setAttribute('operator','arithmetic');
   co.setAttribute('k1',0); co.setAttribute('k2',1+ +fxc.local); co.setAttribute('k3',-fxc.local); co.setAttribute('k4',0);
   co.setAttribute('result','uns'); f.append(bl,co)}
  const ct=document.createElementNS(NS,'feComponentTransfer');
  if(+fxc.local>0)ct.setAttribute('in','uns');
  ['R','G','B'].forEach((c,k)=>{const fn=document.createElementNS(NS,'feFunc'+c);
   fn.setAttribute('type','table'); fn.setAttribute('tableValues',l[k].join(' ')); ct.append(fn)});
  f.append(ct); d.append(f)})}

/* ===== comparar MODELOS en mosaico (14-sep) =====
   El mosaico existente comparaba presets de filtro sobre UNA imagen. Ahora un panel puede
   traer su propia imagen: tildando 2-4 modelos en el desplegable se ve la misma lamina, a la
   misma profundidad y con el mismo zoom, con cada modelo en un cuadrante. Con uno tildado
   vuelve a la vista simple de siempre. */
var MODSEL=[];
/* 25-sep: la serie (corrida) que muestra el panel de un modelo; su orientacion de vista es la suya, no la de la principal */
function grupoDeModelo(m){
 const e=LAM.get(lamActual()); if(!e)return null;
 const h=hojaActual(),it=e.items.find(v=>v.hoja===h&&v.modelo===m&&v.cara===prefCara)||e.items.find(v=>v.hoja===h&&v.modelo===m)||e.items.find(v=>v.modelo===m&&v.cara===prefCara)||e.items.find(v=>v.modelo===m);
 return it&&manifest[it.i]||null;
}
function srcDeModelo(m){
 const g=grupoDeModelo(m); if(!g)return null;
 const dir=projection?g.maximum:g.frames[Number(slider.value)];
 return mapUrl(dir,$('contrast').value);
}
//

document.addEventListener('DOMContentLoaded',()=>{
 fxDestinoAUI();
});
function panesDeModelos(){
 if(MODSEL.length>1){
  PANES=MODSEL.slice(0,4).map(m=>({t:modCorto(m),fx:Object.assign({},FX),modelo:m}));
 } else if(PANES.some(p=>p.modelo)) PANES=[];
 defsPanes();pintarPanes();if(window.fxPintarPresets)fxPintarPresets();fxDestinoAUI();fit();
}

function modsFiltrar(){
 const c=$('modsList'); if(!c)return;
 const q=(($('modsBuscar')||{}).value||'').trim().toLowerCase();
 let n=0;
 c.querySelectorAll('.modrow').forEach(l=>{
  const m=l.dataset.m, txt=l.textContent.toLowerCase();
  const ok=!q||txt.includes(q)||MODSEL.includes(m);
  l.hidden=!ok; if(ok)n++});
 let v=c.querySelector('.vacio');
 if(!n){ if(!v){v=document.createElement('div');v.className='vacio';c.append(v)}
         v.textContent='no model matches “'+q+'”'; v.hidden=false }
 else if(v) v.hidden=true;
}
function pintarModsSum(){
 const s=$('modsSum'); if(!s)return;
 s.textContent = MODSEL.length>1 ? MODSEL.length+' models · compare' : (MODSEL.length?modCorto(MODSEL[0]):'Model');
 s.title = MODSEL.length>1 ? 'Comparing: '+MODSEL.map(modCorto).join(' · ')
                           : 'Pick one model, or tick up to 4 to compare them side by side';
}
function llenarModelos(mods,cur,lam){
 const c=$('modsList'); if(!c)return;
 if(!MODSEL.length||!MODSEL.every(m=>mods.includes(m)))MODSEL=[cur];
 const q0=($('modsBuscar')||{}).value||'';
 c.innerHTML='';
 const wrap=document.createElement('div'); wrap.id='modsBuscarWrap';
 const bus=document.createElement('input'); bus.id='modsBuscar'; bus.type='search';
 bus.placeholder='search model…'; bus.value=q0; bus.autocomplete='off';
 bus.oninput=()=>modsFiltrar(); bus.onclick=e=>e.stopPropagation();
 bus.onkeydown=e=>{if(e.key==='Escape'){bus.value='';modsFiltrar();e.stopPropagation()}};
 wrap.append(bus); c.append(wrap);
 mods.forEach(m=>{
  const l=document.createElement('label'); l.className='modrow'; l.dataset.m=m;
  const i=document.createElement('input'); i.type='checkbox'; i.checked=MODSEL.includes(m);
  const t=document.createElement('span'); t.className='modtxt'; t.textContent=modCorto(m);
  if(lam&&esContam(lam,m)){const w=document.createElement('span');w.className='cont';w.textContent=' ⚠ training';t.append(w)}
  if(!i.checked&&MODSEL.length>=4)l.classList.add('lleno');
  i.onchange=()=>{
   if(i.checked){ if(MODSEL.length>=4){i.checked=false;return} MODSEL.push(m); }
   else { if(MODSEL.length===1){i.checked=true;return}       // siempre queda uno
          MODSEL=MODSEL.filter(v=>v!==m); }
   // el modelo "principal" (el que manda en la imagen de fondo, la mascara y la descarga) es el primero
   if($('selModelo').value!==MODSEL[0]){$('selModelo').value=MODSEL[0];cambiarVariante()}
   llenarModelos(mods,MODSEL[0],lam);pintarModsSum();panesDeModelos();
  };
  l.append(i,t);c.append(l)});
 const pie=document.createElement('div'); pie.className='pie';
 pie.textContent = MODSEL.length>1 ? 'Comparing '+MODSEL.length+' models. Untick to go back to a single view.'
                                   : 'Tick a second model to compare them side by side (up to 4).';
 c.append(pie);
 modsFiltrar();
 pintarModsSum();
}
document.addEventListener('click',e=>{const d=$('modsWrap');if(d&&d.open&&!d.contains(e.target))d.open=false});

/* ===== a que panel le pega el filtro (14-sep) =====
   Antes cada panel guardaba una copia CONGELADA del filtro y los controles editaban solo el
   global: mover un slider no cambiaba nada en el mosaico. Ahora lo que tocas va a los paneles
   seleccionados (click en la etiqueta del panel) o, si no hay ninguno, a todos. */
function fxObjetivos(){
 if(!PANES||!PANES.length)return[];
 return PANES.map((p,i)=>[p,i]).filter(([p])=>!p.fija).map(([,i])=>i);   /* 16-sep: todos menos los fijados */
}
function fxAPaneles(){
 const ob=fxObjetivos(); if(!ob.length)return;
 ob.forEach(i=>{PANES[i].fx=Object.assign({},FX)});
 defsPanes();pintarPanes();fxDestinoAUI();
}
function fxDestinoAUI(){
 /* 16-sep: se retira elegir a mano a que panel le pegan los filtros. Los filtros van SIEMPRE a todos
    los paneles; el unico que se salva es el que tiene el pin puesto. Una sola regla, sin estado oculto. */
 if(PANES&&PANES.length)[...document.querySelectorAll('#panes .pane')].forEach((el,i)=>{
   const et=el.querySelector('.et'); if(et&&PANES[i])et.textContent=PANES[i].t});
}
/* ===== cerrar y fijar paneles (16-sep) =====
   X cierra ese panel (y destilda su modelo si lo tiene). El pin congela el panel: se queda con
   el filtro que tiene puesto en ese momento y deja de escuchar los controles globales; al
   sacarlo vuelve a la configuracion general. */
function cerrarPane(i){
 if(!PANES||!PANES[i])return;
 const m=PANES[i].modelo;
 PANES.splice(i,1);
 if(m&&typeof MODSEL!=='undefined'){
  MODSEL=MODSEL.filter(v=>v!==m);
  const cb=document.querySelector('#modsList .modrow[data-m="'+(window.CSS&&CSS.escape?CSS.escape(m):m)+'"] input');
  if(cb)cb.checked=false;
  if(typeof pintarModsSum==='function')pintarModsSum();
 }
 defsPanes();pintarPanes();if(window.fxPintarPresets)fxPintarPresets();fxDestinoAUI();fit();
}
function fijarPane(i){
 const p=PANES&&PANES[i]; if(!p)return;
 if(p.fija){p.fija=false;p.fx=Object.assign({},FX)}          /* vuelve a la configuracion general */
 else{p.fx=fxCompuesto(p.fx);p.fija=true}        /* congela lo que se ve ahora */
 defsPanes();pintarPanes();fxDestinoAUI();
}
function pintarPanes(){acomodarReparto();
 const cont=$('panes'); if(!cont)return;
 if(!PANES||!PANES.length){cont.innerHTML=''; stage.style.visibility=''; return}
 stage.style.visibility='hidden';      // en modo comparacion manda el mosaico
 const W=vp.clientWidth, H=vp.clientHeight, n=PANES.length;
 const cajas = cajasPanes(W,H,n);   /* 25-sep: con el separador arrastrable */
 if(cont.children.length!==n){cont.innerHTML='';
  PANES.forEach((p,i)=>{const d=document.createElement('div'); d.className='pane q'+i;
   const g=document.createElement('img'); g.draggable=false;
   g.onload=()=>paint();   /* 25-sep: la matriz de orientacion usa el tamano real de la imagen del panel */
   const om=document.createElement('span'); om.className='om'; om.hidden=true;
   const pm=document.createElement('canvas'); pm.className='pm';
   const e=document.createElement('span'); e.className='et';
   e.title='Filters go to every pane except the pinned ones.';
   const act=document.createElement('span'); act.className='pact';
   const fij=document.createElement('button'); fij.className='fij'; fij.textContent='📌';
   fij.title='Pin: freeze this pane on the filters it has now, so the controls only affect the others. Click again to follow the general settings.';
   fij.onclick=ev=>{ev.stopPropagation();fijarPane([...cont.children].indexOf(d))};
   const cer=document.createElement('button'); cer.textContent='✕'; cer.title='Close this pane';
   cer.onclick=ev=>{ev.stopPropagation();cerrarPane([...cont.children].indexOf(d))};
   act.append(fij,cer);
   d.append(g,pm,e,act,om); cont.append(d)})}
 [...cont.children].forEach((d,i)=>{
  const [L,T,w,h]=cajas[i], p=PANES[i], g=d.querySelector('img');
  Object.assign(d.style,{left:L+'px',top:T+'px',width:w+'px',height:h+'px'});
  const caption=d.querySelector('.et');if(caption.textContent!==p.t)caption.textContent=p.t;
  d.classList.toggle('fija',!!p.fija);
  const fb=d.querySelector('.pact .fij'); if(fb)fb.classList.toggle('on',!!p.fija);
  const fuente=p.modelo?srcDeModelo(p.modelo):im.src;
  if(!fuente){d.querySelector('.et').textContent=p.t+' — no image at this depth';g.removeAttribute('src')}
  else if(g.src!==fuente)g.src=fuente;
  g.style.filter='url(#fxPane'+i+')';
  /* 25-sep: cada panel con la orientacion de SU corrida; el espejo de la mascara con la de la principal (su grilla) */
  const gp=p.modelo?grupoDeModelo(p.modelo):group,op=oriEf(gp),oMain=oriEf(group),base=`translate(${x}px,${y}px) scale(${zoom})`;
  g.style.transform=op?base+' '+oriMatriz(op,g.naturalWidth||curW,g.naturalHeight||curH):base;
  const pm=d.querySelector('.pm');if(pm)pm.style.transform=oMain?base+' '+oriMatriz(oMain,curW,curH):base;
  const mk=d.querySelector('.om');if(mk){const t=op?oriTexto(gp):'';mk.hidden=!t;if(mk.textContent!==t)mk.textContent=t}});
 espejarMascara()}
/* copy the label mask into the per-pane mirrors (display only; the mask itself stays the single source) */
let tEsp=0;function espejarMascara(){const ms=$('mask');if(!ms)return;document.querySelectorAll('#panes .pane .pm').forEach(pm=>{const on=etiqOn&&ms.width>0&&paneAnnotationReady(pm.closest('.pane'));pm.style.display=on?'block':'none';if(!on)return;if(pm.width!==ms.width||pm.height!==ms.height){pm.width=ms.width;pm.height=ms.height}pm.style.opacity=ms.style.opacity||'.55';const g=pm.getContext('2d');g.clearRect(0,0,pm.width,pm.height);g.drawImage(ms,0,0)})}
function espejarPronto(){const t=performance.now();if(t-tEsp<120)return;tEsp=t;espejarMascara()}
/* a canvas has no change event: while labelling in split view, refresh the mirrors 10x/s (GPU copies, ~ms) so undo, region fill,
   import and every other mask edit show up without a zoom/pan */
setInterval(()=>{if(etiqOn&&PANES&&PANES.length)espejarMascara()},100);
/* 25-sep reparto de pantalla: separador entre columnas de mapas y borde del panel, los dos en #main (fuera del viewport, asi
   ningun pincel ni herramienta toma el arrastre como clic sobre el mapa) */
function acomodarReparto(){const m=$('main'),s=$('panesSep'),t=$('panelTirador'),p=$('panel');if(!m)return;
 const n=(typeof PANES!=='undefined'&&PANES)?PANES.length:0;
 if(s){if(n<2)s.hidden=true;else{const W=vp.clientWidth,H=vp.clientHeight;s.hidden=false;s.style.left=(vp.offsetLeft+corteX(W)-4)+'px';s.style.top=vp.offsetTop+'px';s.style.height=(n===3?H/2:H)+'px'}}
 if(t&&p){t.hidden=p.hidden||getComputedStyle(p).position==='absolute';if(!t.hidden)t.style.left=(p.offsetLeft-4)+'px'}}
(function(){const m=$('main');if(!m)return;
 if(REPARTO.panel)m.style.setProperty('--panel-ancho',REPARTO.panel+'px');
 const s=document.createElement('div');s.id='panesSep';s.hidden=true;s.title="Drag to resize map panels; double-click for equal widths";
 const t=document.createElement('div');t.id='panelTirador';t.hidden=true;t.title="Drag to resize the annotation panel";
 m.append(s,t);
 const repintar=()=>{if(fitted)fit();else paint()};
 const arrastrar=(el,mover)=>el.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();
  try{el.setPointerCapture(e.pointerId)}catch(_){}el.classList.add('activo');
  const mv=ev=>{ev.stopPropagation();mover(ev)},fin=()=>{el.classList.remove('activo');el.removeEventListener('pointermove',mv);el.removeEventListener('pointerup',fin);el.removeEventListener('pointercancel',fin);guardarReparto();acomodarReparto()};
  el.addEventListener('pointermove',mv);el.addEventListener('pointerup',fin);el.addEventListener('pointercancel',fin)});
 arrastrar(s,ev=>{const r=vp.getBoundingClientRect();if(!r.width)return;REPARTO.panes=Math.max(.15,Math.min(.85,(ev.clientX-r.left)/r.width));repintar();acomodarReparto()});
 s.addEventListener('dblclick',e=>{e.stopPropagation();REPARTO.panes=.5;guardarReparto();repintar();acomodarReparto()});
 arrastrar(t,ev=>{const r=m.getBoundingClientRect(),a=$('arbol'),libre=r.width-(a&&!a.hidden&&getComputedStyle(a).position!=='absolute'?a.offsetWidth:0)-320;   /* al mapa le quedan 320 px */
  REPARTO.panel=Math.round(Math.max(240,Math.min(r.right-ev.clientX,Math.max(240,libre))));m.style.setProperty('--panel-ancho',REPARTO.panel+'px');acomodarReparto()});
 addEventListener('resize',acomodarReparto);acomodarReparto()})();
/* ===== 25-sep: orientacion de vista — botones «vista corregida» (tecla O), «voltear ↕», «voltear ↔» y la carga del JSON ===== */
function oriCambiar(fn){
 /* el punto de la imagen que esta en el centro de la caja sigue en el centro despues de voltear o girar */
 const[W,H]=cajaUtil(),hay=!!(im.naturalWidth&&curW),g0=hay?oriAGrilla(oriEf(group),curW,curH,(W/2-x)/zoom,(H/2-y)/zoom):null;
 fn();oriBotones();
 if(hay&&!fitted){const v=oriAVista(oriEf(group),curW,curH,g0[0],g0[1]);x=W/2-v[0]*zoom;y=H/2-v[1]*zoom;paint()}
 else if(hay)fit();else paint();
 if(window.superDibujar&&document.getElementById('super'))superDibujar()}
function voltear(k){oriCambiar(()=>{VOLT[k]^=1;try{localStorage.setItem('vesuvius.voltear',JSON.stringify(VOLT))}catch(e){}})}
function oriAlternar(){if(oriAutoDe(group))oriCambiar(()=>{ORI_AUTO=!ORI_AUTO})}
window.voltear=voltear;window.oriAlternar=oriAlternar;
window.oriBotones=function(){const a=oriAutoDe(group),b=$('oriAuto');
 if(b){b.hidden=!a;if(a){b.textContent=ORI_AUTO?"corrected view "+oriSimbolo(a):"original orientation";b.classList.toggle('corr',ORI_AUTO);b.classList.toggle('orig',!ORI_AUTO);b.setAttribute('aria-pressed',String(ORI_AUTO));
  b.title=(ORI_AUTO?"This run was rendered in mesh-grid order ("+a[3]+", September 25 inventory): displayed in reading orientation.":"The PNG is displayed as rendered, in the mesh grid ("+a[3]+').')+" The PNG and mask remain in the original grid. Click or press O: "+(ORI_AUTO?"ver la original orientation.":"volver a la corrected view.")}}
 [['f','voltF'],['c','voltC']].forEach(([k,id])=>{const e=$(id);if(e){e.classList.toggle('active',!!VOLT[k]);e.setAttribute('aria-pressed',String(!!VOLT[k]))}});
 oriMarcar()};
window.oriMarcar=function(){let m=$('oriMarca');if(!m){m=document.createElement('div');m.id='oriMarca';m.setAttribute('role','status');m.hidden=true;vp.append(m)}
 const t=PANES&&PANES.length?'':oriTexto(group);m.hidden=!t;if(m.textContent!==t)m.textContent=t};   /* en paneles cada uno lleva su marca */
document.addEventListener('keydown',e=>{if(!group||e.ctrlKey||e.metaKey||e.altKey||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
 if(e.key==='o'||e.key==='O'){oriAlternar();e.preventDefault()}});
addEventListener('DOMContentLoaded',()=>{const lab=$('etiq');if(!lab)return;   /* junto a Label / Open PNG (ui_modos ya armo los grupos) */
 const mk=(id,txt,tit,fn)=>{const b=document.createElement('button');b.id=id;b.type='button';b.textContent=txt;b.title=tit;b.onclick=fn;lab.parentElement.insertBefore(b,lab);return b};
 mk('oriAuto','','',oriAlternar).hidden=true;
 mk('voltF',"flip ↕","Flip displayed rows vertically. Display only; PNG and mask grids remain unchanged. Remembered across runs.",()=>voltear('f'));
 mk('voltC',"flip ↔","Flip displayed columns horizontally. Display only; PNG and mask grids remain unchanged. Remembered across runs.",()=>voltear('c'));
 oriBotones()});
fetch('orientacion_vista.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{if(d&&d.corridas){oriCambiar(()=>{ORI=d.corridas});reclavar()}}).catch(()=>{});   /* 25-sep: reclavar = lienzo de la grilla */
function fxPintarPresets(){const c=$('fxPresets');if(!c)return;c.innerHTML='';
 FXPRESETS.forEach(p=>{const b=document.createElement('button');b.textContent=p.t;b.title=p.d;
  if(fxPresetActivo(p))b.classList.add('on');
  if(false&&!FXCLAVES.every(k=>{const q=FXDEF[k];return typeof q==='boolean'?!!FX[k]===q:(typeof q==='number'?+FX[k]===q:FX[k]===q)}))b.title=p.d+'\n\n(with manual adjustments on top)';
  b.onclick=(ev)=>{
   /* 14-sep: a preset only applies its properties to what is on screen. It never opens or closes panes. */
   const ab=FX.abierto;const fx=Object.assign({},FX,p.fx,{abierto:ab});
   if(PANES&&PANES.length){fxObjetivos().forEach(i=>{PANES[i].fx=Object.assign({},PANES[i].fx,p.fx)});FX=Object.assign({},fx);fxGuardar();fxAUI();fxPedir();defsPanes();pintarPanes()}
   else{FX=fx;fxGuardar();fxAUI();fxPedir()}
   fxPintarPresets()};
  c.append(b)})}
$('filtrosBtn').onclick=()=>{FX.abierto=!FX.abierto;fxGuardar();fxAUI();if(fitted)fit()};
fxAUI();fxPedir();fxPintarPresets();window.fxPintarPresets=fxPintarPresets;window.pintarPanes=pintarPanes;window.defsPanes=defsPanes;

/* ===== bandas de paso de hoja sobre el deslizador de profundidad =====
   Fundamento: el paso de hoja MEDIDO del rollo (rollo.json: paso_hoja_um = [verde, amarillo] en um y
   paso_hoja_origen; PHerc1447 mide 104-121 um, union_20260910/informe.md) y la capa del escaneo = voxel_um
   del rollo (8,64 um en PHerc1447). Si el centro elegido se aleja mas que un paso de hoja, lo que
   se esta mirando puede ser la hoja VECINA, no la propia.
   25-sep generalizar-por-rollo: un rollo sin paso medido no tiene bandas (SIN_PASO); nunca se inventa un paso.
   Convencion: el deslizador ya esta en VOXELES CON SIGNO y coincide 1:1 con la convencion
   c+NN / c-NN de las carpetas del usuario (frames['-1'] -> ..._c-01, frames['4'] -> ..._c+04):
   NO hay corrimiento de una capa. El paso entre offsets cambia por serie (1, 2 o 4 voxeles),
   pero eso no toca la conversion, porque lo que se convierte es el VALOR del offset y no el
   indice del cuadro; una serie de paso 4 en +16 son 16 capas = 138 um igual que cualquier otra. */
let UM_CAPA=VOXEL_UM, BKEY='vesuvius.bandas.v1:'+ROLLO, BDEF=VOXEL_UM>0&&PASO_HOJA_UM?{verde:PASO_HOJA_UM[0],amarillo:PASO_HOJA_UM[1],abierto:false}:null, SIN_PASO=!BDEF;
const rolloBandasInicial=ROLLO;let BD;
function actualizarBandas(){
 UM_CAPA=VOXEL_UM;BKEY='vesuvius.bandas.v1:'+ROLLO;
 BDEF=VOXEL_UM>0&&PASO_HOJA_UM?{verde:PASO_HOJA_UM[0],amarillo:PASO_HOJA_UM[1],abierto:false}:null;SIN_PASO=!BDEF;
 BD=Object.assign({},BDEF||{verde:0,amarillo:0,abierto:false});
 try{const o=JSON.parse(localStorage.getItem(BKEY)||(ROLLO===rolloBandasInicial?localStorage.getItem('vesuvius.bandas.v1'):null)||'null');if(!SIN_PASO&&o&&+o.verde>0&&+o.amarillo>=+o.verde)BD={verde:+o.verde,amarillo:+o.amarillo,abierto:!!o.abierto}}catch(e){}
 bandasAUI();
}
const bGuardar=()=>{try{localStorage.setItem(BKEY,JSON.stringify(BD))}catch(e){}};
const BCOL=['#2f8f63','#9a7d1e','#a3453c'];
const BNOM=['within the sheet','at the limit, ambiguous','beyond the sheet pitch: may be the neighbouring sheet'];
const BCORTO=['inside','edge','outside'];
const bandaDe=um=>um<BD.verde?0:(um<=BD.amarillo?1:2);
/* cuantas capas enteras entran en cada banda (solo para mostrar; el corte real es en um) */
const capasVerde=()=>{const x=BD.verde/UM_CAPA;return Number.isInteger(x)?x-1:Math.floor(x)};
const capasAmar =()=>Math.floor(BD.amarillo/UM_CAPA+1e-9);
function pintarBandas(){const el=$('bandas');if(!el)return;
 if(group?.catalogMeta){el.style.background='#182330';return}
 if(SIN_PASO){el.style.background='#182330';return}
 const lo=Number(slider.min),hi=Number(slider.max);
 if(!isFinite(lo)||!isFinite(hi)||hi<=lo){el.style.background='#182330';return}
 const pct=o=>Math.max(0,Math.min(100,(o-lo)/(hi-lo)*100));
 const v=BD.verde/UM_CAPA,a=BD.amarillo/UM_CAPA;
 const cortes=[[BCOL[2],pct(-a)],[BCOL[1],pct(-v)],[BCOL[0],pct(v)],[BCOL[1],pct(a)],[BCOL[2],100]];
 let prev=0;const partes=[];
 cortes.forEach(([c,p])=>{p=Math.max(prev,p);partes.push(c+' '+prev.toFixed(3)+'%',c+' '+p.toFixed(3)+'%');prev=p});
 el.style.background='linear-gradient(to right,'+partes.join(',')+')'}
function pintarBanda(n){const s=$('banda');if(!s)return;
 if(group?.catalogMeta){s.textContent=group.catalogMeta.depthKnown?'Offset '+signed(n):'Depth undocumented';s.className='';s.title='Catalog import: physical depth spacing and sheet orientation not verified.';return}
 if(projection){s.textContent='—';s.className='';
  s.title='The maximum merges several depths: there is no single offset to classify.';return}
 const capas=Math.abs(Number(n)),um=capas*UM_CAPA;
 if(SIN_PASO){s.textContent=um.toFixed(0)+' µm';s.className='';
  s.title=capas+' layers × '+UM_CAPA+' µm = '+um.toFixed(1)+' µm. Sheet pitch not measured for '+ROLLO+' (its rollo.json has no paso_hoja_um): no bands.';return}
 const b=bandaDe(um);
 s.textContent=um.toFixed(0)+' µm · '+BCORTO[b];s.className='b'+b;
 s.title=capas+' layers × '+UM_CAPA+' µm = '+um.toFixed(1)+' µm — '+BNOM[b]+
  '. Cuts: green < '+BD.verde+' µm, yellow up to '+BD.amarillo+' µm, red above.'+
  ' Sheet pitch measured on '+ROLLO+': '+PASO_HOJA_UM[0]+'–'+PASO_HOJA_UM[1]+' µm.'}
/* texto del panel «Bands…»: el paso medido del rollo y su fuente (rollo.json), o que no esta medido */
function textoPaso(){const e=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
  capa='<b>'+e(String(UM_CAPA).replace('.',','))+' µm</b>',org=ROLLO_JSON.paso_hoja_origen;
 return SIN_PASO?'<b>Sheet pitch</b> — not measured for '+e(ROLLO)+' (its rollo.json has no paso_hoja_um): no bands on the depth slider; each scan layer is '+capa+'.'
  :'<b>Sheet pitch</b> — '+e(ROLLO)+' measures <b>'+PASO_HOJA_UM[0]+'–'+PASO_HOJA_UM[1]+' µm</b> per sheet'+(org?' ('+e(org)+')':'')+'; each scan layer is '+capa+'.'}
function bandasAUI(){
 $('bPaso').innerHTML=textoPaso();
 if(SIN_PASO){['bVerde','bAmar','bReset'].forEach(i=>{$(i).disabled=true});$('bReset').title='No measured sheet pitch for '+ROLLO;
  $('bVerdeCap').textContent=$('bAmarCap').textContent=$('bEstado').textContent=''}
 else{$('bReset').title='Back to '+BDEF.verde+' / '+BDEF.amarillo+' µm';
 $('bVerde').value=BD.verde;$('bAmar').value=BD.amarillo;
 $('bVerdeCap').textContent='(|offset| ≤ '+capasVerde()+' layers)';
 $('bAmarCap').textContent='(|offset| ≤ '+capasAmar()+' layers)';
 $('bEstado').textContent='green ≤'+capasVerde()+' · yellow '+(capasVerde()+1)+'–'+capasAmar()+' · red ≥'+(capasAmar()+1)+' layers'}
 $('bandasCfg').hidden=!BD.abierto;
 $('bandasBtn').classList.toggle('active',BD.abierto);
 $('bandasBtn').setAttribute('aria-pressed',String(BD.abierto));
 $('bandasBtn').setAttribute('aria-expanded',String(BD.abierto));
 pintarBandas();if(group)pintarBanda(slider.value)}
function bandasDeUI(){
 let v=Math.max(1,+$('bVerde').value||BDEF.verde);
 let a=Math.max(v,+$('bAmar').value||BDEF.amarillo);
 BD.verde=v;BD.amarillo=a;bGuardar();bandasAUI();if(fitted)fit()}
$('bVerde').onchange=bandasDeUI;$('bAmar').onchange=bandasDeUI;
$('bReset').onclick=()=>{BD=Object.assign({},BDEF,{abierto:BD.abierto});bGuardar();bandasAUI();if(fitted)fit()};
$('bandasBtn').onclick=()=>{BD.abierto=!BD.abierto;bGuardar();bandasAUI();if(fitted)fit()};
actualizarBandas();

/* ===== conteos y control del filtro por etapas ===== */
function etapasAUI(){
 ETSEL.forEach(([id,k])=>{const s=$(id);if(s)s.value=ET[k]});
 const c={};ETAPAS.forEach(x=>c[x.k]={si:0,no:0,nomed:0});
 LAM.forEach(e=>ETAPAS.forEach(x=>{const r=x.calc(e);c[x.k][r===true?'si':r===false?'no':'nomed']++}));
 $('etapasInfo').innerHTML=ETAPAS.map(x=>'<b>'+x.short+'</b> '+c[x.k].si+' pass / '+c[x.k].no+' fail / '+c[x.k].nomed+' unmeasured').join('<br>');
 $('etapasInfo').title='«unmeasured» is a state of its own: it never counts as «fail» (confusing them '
  +'let 62 laminae of air into the inventory). CT/flattening thresholds: frac_ct >= '+CGum.frac_ct_min
  +' · isometry p95 <= '+CGum.iso_p95_max+' % on both axes · shear p95 <= '+CGum.corte_p95_max+'.';
}
ETSEL.forEach(([id,k])=>{const s=$(id);if(!s)return;
 s.onchange=()=>{ET[k]=s.value;etGuardar();pintarArbol();if(window.pintarPresets)pintarPresets();syncHash();
  const b=$('tree').querySelector('.lam.sel');if(b)b.scrollIntoView({block:'nearest'})}});
/* ===== presets de filtros (11-sep) =====
   Cada preset fija las 5 etapas y, si trae 'q', tambien el buscador. Los desplegables de arriba
   siguen funcionando: tocar uno a mano simplemente deja de coincidir con el preset y se apaga. */
const PRESETS=[
 {id:'envio', t:'Submission', q:'',
  d:'All 5 stages «pass»: geometric certification, validity, CT beneath, flattening and area ≥4 cm². This is the First Letters prize bar.',
  et:{cert:'si',valida:'si',ct:'si',plano:'si',area:'si'}},
 {id:'entren', t:'Training', q:'',
  d:'Certified, valid, CT beneath and healthy flattening, WITHOUT requiring 4 cm². The area minimum only applies to the submitted lamina: a 1 cm² one is fine for training.',
  et:{cert:'si',valida:'si',ct:'si',plano:'si',area:''}},
 {id:'soloarea', t:'Only area missing', q:'',
  d:'Passes the four physical gates but measures under 4 cm². Candidates to grow at their frontier or to be stitched with a neighbour.',
  et:{cert:'si',valida:'si',ct:'si',plano:'si',area:'no'}},
 {id:'reaplanar', t:'To re-flatten', q:'',
  d:'Geometry certified and CT beneath, but the flattening distorts too much. These are usually recovered by re-flattening with flatboi.',
  et:{cert:'si',valida:'si',ct:'si',plano:'no',area:''}},
 {id:'rechazo', t:'Rejected by geometry', q:'',
  d:'Rejected by the geometric gate, almost always for lamina switch: the surface crosses to the neighbouring sheet. Not even usable for training.',
  et:{cert:'no',valida:'',ct:'',plano:'',area:''}},
 {id:'pendiente', t:'Unmeasured', q:'',
  d:'No validity measured. This is the pending work queue: until measured they are neither good nor bad, they are unknown.',
  et:{cert:'',valida:'nomed',ct:'',plano:'',area:''}},
 {id:'fina', t:'Depth step 1', q:'base17',
  d:'Laminae that have all 17 centres from −8 to +8 in steps of 1. With steps of 2 or 4, strokes in between get lost.',
  et:{cert:'',valida:'',ct:'',plano:'',area:''}},
 {id:'limpiar', t:'Clear', q:'', limpiar:true,
  d:'Resets the 5 stages to «unfiltered» and clears the search box.',
  et:{cert:'',valida:'',ct:'',plano:'',area:''}}
];
const presetActivo=p=>ETAPAS.every(x=>ET[x.k]===(p.et[x.k]||''))&&$('buscar').value.trim()===p.q;
function pintarPresets(){const c=$('etapasBtns');if(!c)return;c.innerHTML='';
 PRESETS.forEach(p=>{const b=document.createElement('button');b.textContent=p.t;b.title=p.d;
  if(p.limpiar)b.className='limpiar';
  if(!p.limpiar&&presetActivo(p))b.classList.add('on');
  b.onclick=()=>{ETAPAS.forEach(x=>ET[x.k]=p.et[x.k]||'');etGuardar();
   const bu=$('buscar');if(bu&&(p.q||p.limpiar))bu.value=p.q;
   etapasAUI();pintarArbol();pintarPresets();syncHash();
   const s=$('tree').querySelector('.lam.sel');if(s)s.scrollIntoView({block:'nearest'})};
  c.append(b)})}
pintarPresets();window.pintarPresets=pintarPresets;
etapasAUI();
/* Carga asincrona de las dos compuertas nuevas. Si falla, el visor queda como estaba y todo
   figura como 'unmeasured' — nunca como 'fail'. */
/* indice de legibilidad v5-R2B: RANKING sin calibrar (ordena, no afirma que haya letras).
   Si el archivo no esta, el visor funciona igual y no se muestra ningun score. */
var LEG={};
/* 27-sep: + legibilidad-fl22.json (v5 por segmento y por modelo de PHerc0800/0306B/1218/1447 por cuadraditos de 1 cm,
   campana_fl22/catalogo/v5_visor.py en work-3, copiado a all-gallery/). LEG_V5M = las entradas con por_modelo (auto + fl22)
   para el selector «v5 de» del explorador; sin el archivo el visor queda como antes. */
var LEG_V5M={};
Promise.all(['legibilidad.json','../catalog/_viewer/legibilidad-auto.json','legibilidad-fl22.json','../catalog/'+ROLLO+'/_viewer/legibilidad-auto.json'].map(url=>fetch(url,{cache:'no-cache'}).then(r=>r.ok?r.json():null).catch(()=>null))).then(([base,auto,fl22,sample])=>{
 LEG_V5M={...(auto&&auto.laminas||{}),...(fl22&&fl22.laminas||{}),...(sample&&sample.laminas||{})};
 const d=base||auto||fl22||sample?{laminas:{...(auto&&auto.laminas||{}),...(fl22&&fl22.laminas||{}),...(base&&base.laminas||{}),...(sample&&sample.laminas||{})}}:null;
 if(d&&d.laminas){LEG=d.laminas;const seg={};LAM.forEach(e=>{const b=[e.lam,...e.hojas].map(h=>LEG[h]).filter(l=>l&&Number.isFinite(l.max)).sort((a,b)=>b.max-a.max)[0];if(b)seg[e.lam]=b});Object.assign(LEG,seg);CARPETAS.forEach(v=>v.sort(compareV5Lamina));ARB=armar(vistaModo);pintarArbol();if(window.xpRepintar)window.xpRepintar();if(window.v5HistRepintar)window.v5HistRepintar();}}).catch(()=>{});
Promise.all(['compuertas.json','compuertas-painting.json','compuertas-work3.json','../catalog/_viewer/compuertas-auto.json','../catalog/'+ROLLO+'/_viewer/compuertas-auto.json'].map(url=>fetch(url,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null))).then(([legacy,painting,work3,auto,sample])=>{
 const d={laminas:{...(auto&&auto.laminas||{}),...(legacy&&legacy.laminas||{}),...(painting&&painting.laminas||{}),...(work3&&work3.laminas||{}),...(sample&&sample.laminas||{})},umbrales:legacy&&legacy.umbrales};
 if(!d||!d.laminas)return;CG=d.laminas;if(d.umbrales)CGum=d.umbrales;
 {const seg={};LAM.forEach(e=>{const h=e.hojas.filter(h=>h!==e.lam&&CG[h]).sort((a,b)=>(CG[b].cm2??-1)-(CG[a].cm2??-1))[0];if(h)seg[e.lam]={...CG[h],...(CG[e.lam]||{})}});Object.assign(CG,seg)}
 /* 12-sep: estado y area vienen de compuertas.json cuando existen; el label queda como respaldo */
  LAM.forEach(e=>{const g=CG[e.lam];if(!g)return;if(g.estado_inv)e.est=g.estado_inv;if(g.cm2!=null)e.cm=g.cm2;});
  etapasAUI();pintarArbol();
  /* las areas llegan DESPUES del primer pintado: el explorer sumaba 2192 de 3046 cm2 */
  if(window.xpRepintar)try{window.xpRepintar()}catch(e){}
 const b=$('tree').querySelector('.lam.sel');if(b)b.scrollIntoView({block:'nearest'})}).catch(()=>{});

addEventListener('DOMContentLoaded',()=>{
 if(manifest.length){if(!applyHash()){
  /* multi-rollo: sin hash, abrir una serie del ?rollo= pedido (si la hay); si no, la primera de siempre */
  const ped=new URLSearchParams(location.search).get('rollo');
  const i=ped?manifest.findIndex(g=>(g.scroll||(g.catalogMeta&&g.catalogMeta.scroll))===ped):-1;
  if(i>=0)select(i);else{const pri=CARPETAS.get(ORDEN[0]);pri&&pri.length?irA(pri[0]):select(0)}}}else {
  $('notice').textContent=catalogTotalSeries?'No verified mesh associations are available in this view. Enable Unverified in the explorer to browse the available maps.':'No maps are available in the loaded manifest.';
  $('notice').hidden=false;im.hidden=true;$('download').removeAttribute('href');
  $('count').textContent='0 sheets · '+catalogTotalSeries+' unlinked series hidden';
  document.querySelectorAll('.toolbar button:not(#carpetas),.toolbar select,.toolbar input,.depth button,.depth input,.depth select').forEach(el=>el.disabled=true);
 }
 pintarArbol();
},{once:true});

/* ===== nombres oficiales para las etiquetas (11-sep-2026) =====
   El motor ya guarda los tres estados en un PNG gris: 255 = tinta, 0 = mirado y sin tinta,
   128 = no mirado. El pipeline oficial no lee eso: quiere DOS archivos, y descubre segmentos
   y etiquetas por el nombre, que tiene que empezar exactamente igual que la carpeta del
   segmento. Un segmento 20260910211456 va en 20260910211456/ con:
       20260910211456_inklabels.png        255 donde hay tinta
       20260910211456_supervision_mask.png 255 donde miraste (haya tinta o no)
   Los dos salen del mismo lienzo; el que baja el motor ('mascara_<id>.png') no lo encuentra.
   `alias.json` traduce nuestros nombres viejos al segment_id. */
(function(){
 if(typeof grisCanvas!=='function')return;
 const capa=(cual,d,W,Hh)=>{
  const o=document.createElement('canvas'); o.width=W; o.height=Hh;
  const g=o.getContext('2d'), img=g.createImageData(W,Hh);
  for(let i=0;i<d.length;i+=4){
   const mirado=d[i+3]>=128, tinta=mirado&&d[i+1]>d[i];
   const v=(cual==='inklabels')?(tinta?255:0):(mirado?255:0);
   img.data[i]=img.data[i+1]=img.data[i+2]=v; img.data[i+3]=255;
  }
  g.putImageData(img,0,0); return o;
 };
 /* 25-sep herramientas (etiq_herramientas.js): el par se guarda para la corrida DUENA de la mascara (la que la monto), no para
    la seleccion actual: al cambiar de lamina con trazos pendientes, el guardado subia la mascara vieja con el nombre de la
    lamina nueva. Sin etiq_herramientas.js (sin window.mascaraDueno) queda como antes. */
 const grupoDueno=()=>{const d=window.mascaraDueno;return d&&H&&d.nombre===H.nombre&&d.group?d.group:null};
 const nombreDe=(cual,group)=>{
  const lam=group?meta(group).lam:(H&&H.nombre)||'segmento';
  return (typeof nombreEtiquetas==='function')?nombreEtiquetas(lam,cual)
        :((typeof segId==='function'?segId(lam):lam)+'_'+cual+'.png');
 };
 const carpetaDe=group=>{
  const lam=group?meta(group).lam:(H&&H.nombre)||'segmento';
  return (typeof segId==='function')?segId(lam):lam;
 };
 const TIPOS=['inklabels','supervision_mask'];
 /* Owner, depth, names, provenance and pixels are captured before either asynchronous PNG encoding. */
 const capturar=(cen,ctx,W,Hh)=>{
  if(!H||!(ctx||mctx))throw new Error('no mask to save');
  if(!window.mascaraCorridaInfo||!window.pngConCorrida)throw new Error('Mask provenance tools are unavailable');
  W=W||H.w;Hh=Hh||H.h;const group=grupoDueno(),info=window.mascaraCorridaInfo(cen,W,Hh);
  if(!group||!info||info.run_id!==group.id)throw new Error('The mask owner is unknown');
  if(W!==window.mascaraDueno.w||Hh!==window.mascaraDueno.h)throw new Error('Mask dimensions do not match the owner grid');
  const corrida=JSON.parse(JSON.stringify(info));corrida.par_id=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
  const d=(ctx||mctx).getImageData(0,0,W,Hh).data;
  const ruta=segRuta(group),rollo=group.scroll||group.catalogMeta?.scroll||ROLLO;
  return {corrida,revision:window.revisionMascara?window.revisionMascara(corrida):0,vacia:!d.some((v,i)=>i%4===3&&v>=128),
   nombres:TIPOS.map(t=>nombreDe(t,group)),capas:TIPOS.map(t=>capa(t,d,W,Hh)),
   url:'/api/mascara-par/'+encodeURIComponent(carpetaDe(group))+'?c='+encodeURIComponent(corrida.profundidad)+(ruta?'&base='+encodeURIComponent(ruta.base):'')+'&rollo='+encodeURIComponent(rollo)};
 };
 const codificar=par=>Promise.all(par.capas.map(c=>new Promise((ok,mal)=>c.toBlob(b=>{
  if(!b)return mal(new Error('PNG encoding failed'));
  window.pngConCorrida(b,par.corrida).then(ok,mal);
 },'image/png'))));
 const descargar=(b,nombre)=>{const u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=nombre;a.click();setTimeout(()=>URL.revokeObjectURL(u),4000)};
 $('exp').onclick=()=>{
  if(!window.annotationImageReady()){msg('Download waits for the full-resolution image and restored mask');return}
  let par;try{par=capturar()}catch(e){msg(String(e.message||e));return}
  codificar(par).then(blobs=>{blobs.forEach((b,i)=>descargar(b,par.nombres[i]));msg('Downloaded mask pair · '+par.corrida.run_id+' · depth '+par.corrida.profundidad)}).catch(e=>msg('Download failed: '+String(e.message||e)));
 };
 $('exp').textContent='download pair';
 $('exp').title='Download inklabels and supervision PNGs from one snapshot, with matching depth and grid metadata. Allow multiple downloads in the browser.';
 const base64=b=>new Promise((ok,mal)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=()=>mal(r.error||new Error('Could not read PNG'));r.readAsDataURL(b)});
 // ponytail: one upload queue preserves snapshot order; per-destination queues if throughput matters.
 let subiendo=Promise.resolve();
 /* The server validates and commits both PNGs and their provenance as a single pair. */
 const subirCapturado=async par=>{
  if(!visorPuedeGuardar)throw new Error('Read-only: configure an annotation folder');
  if(par.vacia)throw new Error('empty mask (nothing painted): not uploaded');
  const veto=window.vetoGuardado?window.vetoGuardado(par.corrida):null;if(veto)throw new Error(veto);
  const tarea=subiendo.catch(()=>{}).then(async()=>{
  const blobs=await codificar(par),datos=await Promise.all(blobs.map(base64));
  const body=JSON.stringify({inklabels:datos[0],supervision_mask:datos[1],corrida:par.corrida});
  if(new Blob([body]).size>64*1024*1024)throw new Error('Mask pair exceeds the 64 MiB upload limit');
  const r=await fetch(par.url,{method:'POST',headers:{'Content-Type':'application/json'},body});
  if(!r.ok)throw new Error(await r.text());const result=await r.json();
  if(result.ok!==true)throw new Error(result.motivo||'The server did not confirm the mask pair');
  if(window.guardarCorridaJson)await window.guardarCorridaJson(par.corrida,par.revision);
  return [result];
  });subiendo=tarea;return tarea;
 };
 const subirPar=async(cen,ctx,W,Hh)=>subirCapturado(capturar(cen,ctx,W,Hh));
 window.subirParS3=cen=>subirPar(cen);
 window.subirTodasS3=async()=>{if(!H)return 'no sheet';const nombre=H.nombre,owner=grupoDueno(),store=H.database||db,pref=H.nombre.replace(/\|c[^|]*$/,'')+'|c';
  const actual=capturar();let n=0,v=0;
  const sinCambios=e=>/empty mask|sin cambios|No changes/.test(String(e));
  try{await subirCapturado(actual);n++}catch(e){if(sinCambios(e))v++;else throw e}
  const d=await store;const keys=await new Promise((ok,er)=>{const rq=d.transaction('m','readonly').objectStore('m').getAllKeys();rq.onsuccess=()=>ok(rq.result);rq.onerror=()=>er(rq.error)});
  const mias=keys.filter(k=>typeof k==='string'&&k.startsWith(pref)&&k!==nombre);
  for(const k of mias){const b=await idb('readonly',s=>s.get(k),store);if(!b)continue;const bm=await createImageBitmap(b);const c=document.createElement('canvas');c.width=bm.width;c.height=bm.height;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(bm,0,0);
   const cen=k.slice(pref.length);
   try{if(!H||H.nombre!==nombre||grupoDueno()!==owner)throw new Error('Mask owner changed during saving: remaining depths were not uploaded');await subirPar(cen,g,c.width,c.height);n++;if(typeof msg==='function')msg("Saved annotations: c"+cen+' ('+n+'/'+mias.length+')')}   /* 25-sep herramientas */
   catch(e){if(sinCambios(e)){v++;continue}throw e}}   /* 25-sep herramientas: «sin cambios» no es un fallo */
  return n+" depths saved to annotation storage"+(v?', '+v+" empty or unchanged (not uploaded)":'')};
 /* 25-sep herramientas: rotulos «save pair», que es lo que hacen (el proxy escribe en work-3, no en S3) */
 const b4=document.createElement('button');b4.id='guardarTodasMascaras';b4.textContent=visorTexto("save all depths");b4.title=visorTexto("Save every locally labelled depth in this run, with its depth and run metadata.");b4.disabled=!visorPuedeGuardar;
 b4.onclick=()=>{b4.disabled=true;b4.textContent="Saving all…";subirTodasS3().then(r=>{if(typeof msg==='function')msg(r)}).catch(e=>{if(typeof msg==='function')msg("Failed: "+String(e).slice(0,120))}).finally(()=>{b4.disabled=!visorPuedeGuardar;b4.textContent=visorTexto("save all depths")})};
 $('exp').parentElement && $('exp').parentElement.append(b4);
 const b3=document.createElement('button');b3.id='guardarMascaraServidor';b3.disabled=!visorPuedeGuardar;
 b3.textContent=visorTexto("save pair");
 b3.title=visorPuedeGuardar?visorTexto("Save the mask pair and provenance together; previous versions remain in annotation history."):"Read-only: configure an annotation folder";
 b3.onclick=()=>{
  if(!H||!mctx){ if(typeof msg==='function')msg('no mask to save'); return; }
  b3.disabled=true; b3.textContent='Saving pair…';   /* 25-sep herramientas */
  subirPar()
   .then(rs=>{ if(typeof msg==='function')msg("Saved annotations: "+(rs[0].clave_profundidad||rs[0].clave).replace(/\/[^/]*$/,'/')+(rs[0].clave_profundidad?'':" (no depth: maximum projection)")); })
   .catch(e=>{ if(typeof msg==='function')msg((/^sin cambios/.test(String(e))?'':"Save failed: ")+String(e).slice(0,140)); })   /* 25-sep herramientas: «sin cambios» no es un fallo */
   .finally(()=>{ b3.disabled=!visorPuedeGuardar; b3.textContent=visorTexto("save pair"); });
 };
 $('exp').parentElement && $('exp').parentElement.append(b3);
})();
