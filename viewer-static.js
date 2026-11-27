/* Per-scroll physical scale comes from the selected dataset. Missing scale stays unknown. */
(function(){
 var pedido=new URLSearchParams(location.search).get('rollo');
 var porOrigen=window.VISOR_ORIGEN?.scroll||window.ROLLO_SERVIDOR?.scroll;
 var rollo=(pedido&&/^PHerc[0-9A-Za-z]+$/.test(pedido))?pedido:porOrigen||'PHerc1447';
 window.ROLLO=rollo;window.ROLLO_CORTO=rollo.replace(/^PHerc/,'');
 var cache=new Map(Object.entries(window.VISOR_BOOTSTRAP?.rollos||{})),srv=window.ROLLO_SERVIDOR||null;
 if(srv&&srv.scroll)cache.set(srv.scroll,srv);
 window.visorRolloDe=function(g){return g?.scroll||g?.catalogMeta?.scroll||
  Object.values(g?.frames||{}).map(f=>/catalog\/(PHerc[0-9A-Za-z]+)\//.exec(f)?.[1]).find(Boolean)||window.VISOR_METADATA?.scroll||rollo};
 window.visorMetadataRollo=function(r){
  if(cache.has(r))return cache.get(r);
  var d={scroll:r,voxel_um:null};
  /* The same metadata endpoint serves startup and in-page scroll switches. Never reuse another scroll's scale. */
  if(!window.VISOR_STATIC && /^PHerc[0-9A-Za-z]+$/.test(r)){
  try{var x=new XMLHttpRequest();x.open('GET','/api/rollo.js?rollo='+encodeURIComponent(r),false);x.send();
   if(x.status===200){var t=x.responseText.replace(/^\s*window\.ROLLO_SERVIDOR=/,'').replace(/;\s*$/,'');var info=JSON.parse(t);
    if(info&&info.scroll===r)d=info;}}catch(e){}
  }
  cache.set(r,d);return d;
 };
 window.visorActivarRollo=function(r){
  var d=window.visorMetadataRollo(r),p=d.paso_hoja_um;
  window.ROLLO=r;window.ROLLO_CORTO=r.replace(/^PHerc/,'');window.ROLLO_JSON=d;
  window.VOXEL_UM=Number.isFinite(+d.voxel_um)&&+d.voxel_um>0?+d.voxel_um:null;
  window.PASO_HOJA_UM=window.VOXEL_UM&&Array.isArray(p)&&p.length===2&&p.every(function(x){return +x>0})&&+p[0]<=+p[1]?[+p[0],+p[1]]:null;
 };
 window.visorUmPorPixel=function(g){
  for(var v of [g?.um_por_px,g?.catalogMeta?.um_por_px])if(v!=null&&v!==''&&Number.isFinite(+v)&&+v>0)return +v;
  var d=window.visorMetadataRollo(window.visorRolloDe(g));return Number.isFinite(+d.voxel_um)&&+d.voxel_um>0?+d.voxel_um:null;
 };
 window.visorActivarRollo(rollo);
})();

;
/* Nucleo compartido del etiquetador de tinta (escrito para PHerc1447; desde el 25-sep sirve a cualquier rollo).
   Lo usan el etiquetador clasico (claude-hojas-20260909/etiquetar/index.html, con su propia copia vieja en la carpeta
   del kit) y el visor unificado (all-gallery/index.html, que desde el 25-sep carga ESTA copia de al lado).
   Es un script CLASICO: comparte el scope lexico global con el script inline de cada pagina,
   asi que ninguna pagina debe redeclarar estos nombres.
   Mascara en RGBA: verde = tinta, rojo = no tinta, alfa < 128 = sin etiquetar.
   Exporta gris 255 / 0 / 128. IndexedDB 'etiq<rollo>' store 'm', clave = nombre de HOJA FISICA:
   'etiq' + el numero del rollo del visor (window.ROLLO_CORTO, de rollo_visor.js), o sea 'etiq1447' para PHerc1447, la
   base de siempre. Sin rollo no se abre ninguna base (el visor ya frena antes, en rollo_visor.js). */

let canonicalMaskModePromise;
function canonicalMaskMode() {
  if (window.VISOR_STATIC) return Promise.resolve(false);
  return canonicalMaskModePromise ||= fetch('/api/origen').then(r=>{if(!r.ok)throw new Error('Cannot verify canonical mask source');return r.json()}).then(j=>!!j.canonical_masks);
}
const $q = s => document.querySelector(s);
const conectar = (s, ev, fn) => { const el = $q(s); if (el) el[ev] = fn; return el; };
const COLOR = {tinta:[60,220,90], no:[230,60,60]};
const esTinta = (d, i) => d[i+3] >= 128 && d[i+1] > d[i];

let H = null, mask = null, mctx = null;
let modo = 'tinta', brocha = 24, dirty = true;
let undoS = [], redoS = [], previo = null;
let pintando = false, ult = null, bbox = null;
let regIni = null, regFin = null;

const msg = t => { const el = $q('#msg'); if (el) el.textContent = window.visorTexto?visorTexto(t):t; };
const mascaraLista = () => !window.annotationImageReady || window.annotationImageReady();
function destinoMascara() {
  return H && mctx && mask ? {hoja:H, lienzo:mask, ctx:mctx, nombre:H.nombre, w:H.w, h:H.h,
    database:H.database||db, scroll:H.scroll||window.ROLLO,
    grupo:typeof group === 'undefined' ? null : group,
    info:window.mascaraCorridaInfo ? window.mascaraCorridaInfo(null,H.w,H.h) : null} : null;
}
function destinoVigente(d) {
  return !!d && H === d.hoja && mask === d.lienzo && mctx === d.ctx && H.nombre === d.nombre &&
    H.w === d.w && H.h === d.h && mask.width === d.w && mask.height === d.h &&
    (typeof group === 'undefined' || group === d.grupo);
}
/* One decoder for downloaded, saved and proposed labels. Unknown is always transparent in the working canvas. */
function decodificarPixelesMascara(ink, sup = null) {
  const {width:w,height:h} = ink;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || ink.data.length !== w*h*4)
    throw new Error('invalid mask dimensions');
  if (sup && (sup.width !== w || sup.height !== h || sup.data.length !== ink.data.length))
    throw new Error('ink and supervision dimensions differ');
  const out = {width:w,height:h,data:new Uint8ClampedArray(w*h*4)};
  for (const im of sup ? [ink,sup] : [ink]) {
    for (let i = 0; i < im.data.length; i += 4) {
      const d = im.data, v = d[i];
      if (d[i+3] !== 255 || d[i+1] !== v || d[i+2] !== v ||
          !(v === 0 || v === 255 || !sup && v === 128))
        throw new Error('mask must be opaque grayscale with exact ' + (sup ? '0/255' : '0/128/255') + ' values (pixel ' + i/4 + ')');
    }
  }
  for (let i = 0; i < ink.data.length; i += 4) {
    const v = ink.data[i];
    if (sup && v === 255 && sup.data[i] !== 255) throw new Error('ink outside supervision (pixel ' + i/4 + ')');
    const c = v === 255 ? COLOR.tinta : (sup ? sup.data[i] === 255 : v === 0) ? COLOR.no : null;
    if (c) { out.data.set(c,i); out.data[i+3] = 255; }
  }
  return out;
}
async function leerPngMascara(blob,w,h) {
  const head = new Uint8Array(await blob.slice(0,33).arrayBuffer());
  if (head.length !== 33 || ![137,80,78,71,13,10,26,10].every((v,i) => head[i] === v) ||
      String.fromCharCode(...head.slice(12,16)) !== 'IHDR') throw new Error('only PNG masks are accepted');
  const dv = new DataView(head.buffer,head.byteOffset,head.byteLength);
  if (head[24] !== 8) throw new Error('mask PNG must use 8-bit class values');
  if (dv.getUint32(16) !== w || dv.getUint32(20) !== h) throw new Error('mask dimensions must match exactly: ' + w + 'x' + h);
  const bm = await createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
  try {
    if (bm.width !== w || bm.height !== h) throw new Error('decoded mask dimensions differ');
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d',{willReadFrequently:true}); cx.clearRect(0,0,w,h); cx.drawImage(bm,0,0);
    return cx.getImageData(0,0,w,h);
  } finally { if (bm.close) bm.close(); }
}
async function leerParMascara(blobs,w,h) {
  const [ink,sup] = await Promise.all(blobs.map(b => leerPngMascara(b,w,h)));
  return decodificarPixelesMascara(ink,sup);
}
function conservarEdiciones(propuesta,actual) {
  for (let i = 0; i < actual.data.length; i += 4)
    if (actual.data[i+3] >= 128) propuesta.data.set(actual.data.subarray(i,i+4),i);
  return propuesta;
}
function reemplazarMascara(out,d) {
  if (!destinoVigente(d)) { msg('Mask changed during loading: nothing imported'); return false; }
  prepararUndo(); bbox = [0,0,d.w,d.h]; redoS = [];
  const image = d.ctx.createImageData(d.w,d.h); image.data.set(out.data); d.ctx.putImageData(image,0,0);
  guardarUndo(); dirty = true; autoguardar(); contar();
  if (typeof espejarMascara === 'function') espejarMascara();
  return true;
}
async function confirmarMetadatosMascara(blobs,info,label) {
  const entries = await Promise.all(blobs.map(async b => window.corridaDePNG ? window.corridaDePNG(new Uint8Array(await b.arrayBuffer())) : null));
  if (entries.length === 2 && entries.some(sc => sc && sc.par_id) &&
      (!entries[0]?.par_id || entries[0].par_id !== entries[1]?.par_id)) throw new Error('ink and supervision belong to different mask pairs');
  let warning = entries.length === 2 && !entries[0]?.par_id ? 'Pair identity is missing; verify both files belong to the same export' : '';
  for (const sc of entries) {
    const v = window.verificarCorridaMascara ? window.verificarCorridaMascara(sc,info) : {ok:null,txt:'Run, sheet, depth and grid metadata cannot be verified'};
    if (v.ok === false) throw new Error(v.txt);
    if (v.ok === null) warning = v.txt;
  }
  if (warning && !confirm(label + ': ' + warning + '. Verify the source image and depth before continuing. Import anyway?')) return false;
  return true;
}
async function obtenerParMascara(lam,c,base,propuesta = false,rollo = window.ROLLO,soloMetadata = false) {
  if (window.VISOR_STATIC) return null;
  const q = new URLSearchParams({c:String(c),rollo:String(rollo || '')});
  if (base) q.set('base',base); if (propuesta) q.set('propuesta','1');
  const crop = globalThis.recorteVista && globalThis.recorteVista.info(); if (crop) q.set('recorte',[crop.x,crop.y,crop.ancho,crop.alto].join(','));
  if (soloMetadata) { q.set('metadata','1'); q.set('opcional','1'); }
  let r = await fetch('/api/mascara-par/' + encodeURIComponent(lam) + '?' + q,{cache:'no-store'});
  if (r.status === 409 && !soloMetadata) {
    const details = await r.clone().json();
    if (details.versions) {
      const identity = await new Promise(resolve => {
        const dialog = document.createElement('dialog'), title = document.createElement('p'), select = document.createElement('select');
        title.textContent = 'Choose mask series / version'; dialog.append(title);
        for (const v of details.versions) {const option = document.createElement('option');option.value=v.id;option.textContent=v.series+' · '+v.type+' · '+v.id.slice(0,12);select.append(option)}
        dialog.append(select);const ok=document.createElement('button'),cancel=document.createElement('button');ok.textContent='Load';cancel.textContent='Cancel';dialog.append(ok,cancel);
        ok.onclick=()=>{const id=select.value;dialog.close();resolve(id);dialog.remove()};cancel.onclick=()=>{dialog.close();resolve(null);dialog.remove()};dialog.oncancel=()=>{resolve(null);dialog.remove()};document.body.append(dialog);dialog.showModal();
      });
      if (!identity) throw new Error('Mask load cancelled');q.set('version',identity);
      r = await fetch('/api/mascara-par/' + encodeURIComponent(lam) + '?' + q,{cache:'no-store'});
    }
  }
  if (!r.ok || r.status === 204) throw new Error('mask pair HTTP ' + r.status);
  const j = await r.json();
  if (soloMetadata) return {corrida:j.corrida || null};
  const blobs = ['inklabels','supervision_mask'].map(k => {
    if (typeof j[k] !== 'string') throw new Error('mask pair is incomplete');
    return new Blob([Uint8Array.from(atob(j[k]),v => v.charCodeAt(0))],{type:'image/png'});
  });
  return {blobs,corrida:j.corrida || null};
}

/* ---------- IndexedDB: una tabla, clave = nombre de hoja ---------- */
const basesMascara = new Map();
function abrirDb(rollo) {
  if (basesMascara.has(rollo)) return basesMascara.get(rollo);
  const promise = new Promise((ok, err) => {
    if (!rollo) return err(new Error('etiquetar.js: missing scroll'));
    const r = indexedDB.open(window.visorKey?visorKey('etiq' + rollo):'etiq' + rollo, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error);
  });
  promise.scroll = 'PHerc' + rollo;basesMascara.set(rollo,promise);return promise;
}
let db = abrirDb(window.ROLLO_CORTO);
const idb = async (modo, fn, store = db) => {
  const d = await store, t = d.transaction('m', modo), s = t.objectStore('m');
  return new Promise((ok, err) => { const q = fn(s); q.onsuccess = () => ok(q.result); q.onerror = () => err(q.error); });
};

const cargarImg = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

/* Prepara la mascara de una hoja fisica. `lienzo` opcional: el canvas ya montado en el DOM
   (visor unificado); sin el se crea uno fuera de pantalla (etiquetador clasico). */
async function iniciarMascara(h, lienzo) {
  h.database = db; h.scroll = window.ROLLO || db.scroll;
  H = h;
  mask = lienzo || document.createElement('canvas');
  mask.width = h.w; mask.height = h.h;              // asignar width/height limpia el canvas
  mctx = mask.getContext('2d', {willReadFrequently:true});
  undoS = []; redoS = []; previo = null; bbox = null; pintando = false;
  await restaurar(h.nombre);
  contar();
  return mask;
}

/* ---------- pincel ---------- */
function marcarBBox(x, y, r) {
  const b = [Math.floor(x - r), Math.floor(y - r), Math.ceil(x + r), Math.ceil(y + r)];
  bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b;
}
function trazo(x0, y0, x1, y1) {
  if (!mascaraLista()) return;
  const r = brocha / 2;
  mctx.lineCap = mctx.lineJoin = 'round'; mctx.lineWidth = brocha;
  // reemplazar, no mezclar: primero borro, despues pinto la clase
  for (const op of ['destination-out', 'source-over']) {
    if (op === 'source-over' && modo === 'borrar') break;
    mctx.globalCompositeOperation = op;
    const c = COLOR[modo] || COLOR.tinta;
    mctx.strokeStyle = mctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},1)`;
    mctx.beginPath(); mctx.moveTo(x0, y0); mctx.lineTo(x1, y1); mctx.stroke();
    mctx.beginPath(); mctx.arc(x1, y1, r, 0, 7); mctx.fill();
  }
  mctx.globalCompositeOperation = 'source-over';
  marcarBBox(x0, y0, r); marcarBBox(x1, y1, r);
  dirty = true;
}
function empezar(x, y) {
  if (!mascaraLista()) return msg('Wait for the full-resolution image and mask to finish loading');
  pintando = true; ult = [x, y]; bbox = null; redoS = [];
  trazo(x, y, x, y);
}
function mover(x, y) {
  if (!pintando) return;
  trazo(ult[0], ult[1], x, y); ult = [x, y];
}
function terminar() {
  if (!pintando) return;
  pintando = false;
  guardarUndo(); autoguardar(); contar();
}

/* undo: se copia la mascara entera al empezar el trazo y se archiva solo el bbox tocado (20 pasos).
   ponytail: el getImageData de 20 MPx por trazo cuesta ~50 ms; si molesta, snapshot incremental por segmento. */
function prepararUndo() { if (mctx) previo = mctx.getImageData(0, 0, H.w, H.h); }
function guardarUndo() {
  if (!previo || !bbox) return;
  const b = [Math.max(0, bbox[0]), Math.max(0, bbox[1]), Math.min(H.w, bbox[2]), Math.min(H.h, bbox[3])];
  const w = b[2] - b[0], h = b[3] - b[1];
  if (w <= 0 || h <= 0) { previo = null; return; }
  const antes = mctx.createImageData(w, h);
  for (let r = 0; r < h; r++) {
    const src = ((b[1] + r) * H.w + b[0]) * 4;
    antes.data.set(previo.data.subarray(src, src + w * 4), r * w * 4);
  }
  undoS.push({b, antes}); if (undoS.length > 20) undoS.shift();
  previo = null;
}
function aplicar(pila, otra) {
  if (!mascaraLista()) return msg('Wait for the full-resolution image and mask to finish loading');
  const e = pila.pop(); if (!e || !mctx) return;
  const [x, y] = e.b, w = e.b[2] - x, h = e.b[3] - y;
  const actual = mctx.getImageData(x, y, w, h);
  mctx.putImageData(e.antes, x, y);
  otra.push({b: e.b, antes: actual}); if (otra.length > 20) otra.shift();
  dirty = true; autoguardar(); contar();
}

const setModo = m => {
  modo = m; regIni = regFin = null;
  for (const [id, v] of [['#mTinta','tinta'],['#mNo','no'],['#mBorrar','borrar'],['#mRegion','region']]) {
    const el = $q(id); if (el) el.classList.toggle('on', v === m);
  }
};
const setBrocha = v => {
  brocha = Math.max(2, Math.min(200, Math.round(v)));
  const s = $q('#sz'), l = $q('#szLbl');
  if (s) s.value = brocha; if (l) l.textContent = brocha;
};

/* ---------- region supervisada (tutorial 5: la region cubre los trazos Y el fondo limpio) ----------
   el gris (sin etiquetar) NO entrena; dentro de la region todo gris pasa a "no tinta" y la tinta queda intacta.
   con shift la misma region devuelve a gris lo que era "no tinta", sin tocar la tinta. */
function aplicarRegion(shift) {
  if (!mascaraLista()) return msg('Wait for the full-resolution image and mask to finish loading');
  const a = regIni, b = regFin; regIni = regFin = null; dirty = true;
  if (!a || !b || !H || !mctx) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]))), y0 = Math.max(0, Math.floor(Math.min(a[1], b[1])));
  const x1 = Math.min(H.w, Math.ceil(Math.max(a[0], b[0]))), y1 = Math.min(H.h, Math.ceil(Math.max(a[1], b[1])));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return msg('empty region');
  prepararUndo(); bbox = [x0, y0, x1, y1];
  const im = mctx.getImageData(x0, y0, w, h), d = im.data, c = COLOR.no;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (esTinta(d, i)) continue;                                  // blanco 255: se conserva
    if (shift) { if (d[i+3] >= 128) { d[i+3] = 0; n++; } }         // negro -> gris
    else if (d[i+3] < 128) { d[i] = c[0]; d[i+1] = c[1]; d[i+2] = c[2]; d[i+3] = 255; n++; }  // gris -> negro
  }
  mctx.putImageData(im, x0, y0);
  guardarUndo(); autoguardar(); contar();
  msg((shift ? 'un-supervised ' : 'supervised ') + n.toLocaleString() + ' px');
}

/* dilata la clase tinta r px y pinta de negro lo que sea gris ahi (resta la propia clase tinta).
   ponytail: elemento estructurante CUADRADO (2r+1) por dilatacion separable en potencias de dos
   (~24 drawImage, corre en 5000x5000); si hace falta el disco exacto, hacer EDT. */
function anilloFondo(r) {
  if (!mascaraLista()) return msg('Wait for the full-resolution image and mask to finish loading');
  if (!H || !mctx) return;
  r = Math.round(r);
  if (!(r > 0)) return msg('invalid radius');
  const t0 = performance.now();
  const o = document.createElement('canvas'); o.width = H.w; o.height = H.h;
  const og = o.getContext('2d', {willReadFrequently:true});
  const src = mctx.getImageData(0, 0, H.w, H.h), sd = src.data;
  const bin = og.createImageData(H.w, H.h), bd = bin.data;
  let tinta = 0;
  for (let i = 0; i < sd.length; i += 4) if (esTinta(sd, i)) { bd[i] = bd[i+1] = bd[i+2] = bd[i+3] = 255; tinta++; }
  if (!tinta) return msg('no ink painted');
  og.putImageData(bin, 0, 0);
  for (const eje of [0, 1]) {
    let acum = 0, paso = 1;
    while (acum < r) {                        // cada paso une {-p,0,+p}: la cobertura queda contigua
      const p = Math.min(paso, r - acum);
      og.drawImage(o, eje ? 0 : -p, eje ? -p : 0);
      og.drawImage(o, eje ? 0 :  p, eje ?  p : 0);
      acum += p; paso *= 2;
    }
  }
  const dil = og.getImageData(0, 0, H.w, H.h).data, c = COLOR.no;
  let n = 0;
  for (let i = 0; i < sd.length; i += 4) {
    if (dil[i+3] === 0 || sd[i+3] >= 128) continue;   // fuera del anillo, o ya etiquetado
    sd[i] = c[0]; sd[i+1] = c[1]; sd[i+2] = c[2]; sd[i+3] = 255; n++;
  }
  prepararUndo(); bbox = [0, 0, H.w, H.h];
  mctx.putImageData(src, 0, 0);
  guardarUndo(); dirty = true; autoguardar(); contar();
  msg('background r=' + r + ': ' + n.toLocaleString() + ' px in ' + Math.round(performance.now() - t0) + ' ms');
}

/* ---------- conteo ---------- */
let tCont = 0;
function contar() {
  clearTimeout(tCont);
  tCont = setTimeout(() => {
    const el = $q('#stats'); if (!el || !H || !mctx) return;
    const d = mctx.getImageData(0, 0, H.w, H.h).data;
    let t = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 128) continue; d[i+1] > d[i] ? t++ : n++; }
    const cm2 = p => H.um_px ? '  ' + (p * (H.um_px*1e-4) ** 2).toFixed(3) + ' cm2' : '';
    el.textContent =
      `${H.nombre}  ${H.w}x${H.h}\nink     ${t.toLocaleString()} px${cm2(t)}\nno ink   ${n.toLocaleString()} px${cm2(n)}\nunlabelled ${(H.w*H.h-t-n).toLocaleString()} px`;
  }, 350);
}

/* ---------- persistencia ---------- */
let tSave = 0, pendiente = false;   // pendiente: hay cambios sin volcar (lo mira flush() del visor unificado)
function autoguardar() {
  const d = destinoMascara(); if (!d) return;
  const saved = document.createElement('canvas'); saved.width = d.w; saved.height = d.h; saved.getContext('2d').drawImage(d.lienzo,0,0);
  pendiente = true; clearTimeout(tSave);
  tSave = setTimeout(() => { pendiente = false; saved.toBlob(b => {
    if (!b) return msg('Mask encoding failed; changes remain on the canvas');
    idb('readwrite',s => s.put(b,d.nombre),d.database).then(() => msg('saved ' + d.nombre)).catch(err => msg('Browser mask save failed: ' + err.message));
  },'image/png'); },1500);
}
async function restaurar(nombre) {
  if (await canonicalMaskMode()) return;
  const d = destinoMascara(); if (!d || d.nombre !== nombre) return;
  let b = await idb('readonly', s => s.get(nombre),d.database).catch(() => null);
  if (!destinoVigente(d)) return;
  // 15-sep: a mask painted while viewing a model map whose gallery was not yet recognised as a variant of this sheet
  // (e.g. *_r7j_t before the regex change) was saved under the gallery id; look there and migrate it to the sheet key
  let recovered = null;
  if (!b && typeof window.clavesLegado === 'function') {
    for (const k of window.clavesLegado(nombre)) {
      b = await idb('readonly', s => s.get(k),d.database).catch(() => null);
      if (!destinoVigente(d)) return;
      if (b) { recovered = k; break; }
    }
  }
  if (!b) return;
  const url = URL.createObjectURL(b);
  try {
    const im = await cargarImg(url);
    if (!destinoVigente(d)) return;
    if (!im) return msg('Stored mask could not be decoded');
    if ((im.naturalWidth || im.width) !== d.w || (im.naturalHeight || im.height) !== d.h)
      return msg('Stored mask dimensions differ: nothing restored');
    d.ctx.clearRect(0,0,d.w,d.h); d.ctx.drawImage(im,0,0); dirty = true;
    if (recovered) { msg('mask recovered from ' + recovered); idb('readwrite',s => s.put(b,nombre),d.database).catch(() => {}); }
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- exportar / importar (gris: 255 tinta, 0 no tinta, 128 sin etiquetar) ---------- */
// gris 1:1 en un canvas propio; unico lugar que traduce RGBA -> 255/0/128
function grisCanvas() {
  const o = document.createElement('canvas'); o.width = H.w; o.height = H.h;
  const og = o.getContext('2d'), img = og.createImageData(H.w, H.h), d = mctx.getImageData(0, 0, H.w, H.h).data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i+3] < 128 ? 128 : (d[i+1] > d[i] ? 255 : 0);
    img.data[i] = img.data[i+1] = img.data[i+2] = v; img.data[i+3] = 255;
  }
  og.putImageData(img, 0, 0);
  return o;
}

/* ---------- JSON de corridas (RLE row-major sobre 0/128/255) ---------- */
function aJson() {
  const g = grisCanvas().getContext('2d').getImageData(0, 0, H.w, H.h).data;
  const runs = []; let v = g[0], n = 0;
  for (let i = 0; i < g.length; i += 4) {
    if (g[i] === v) { n++; continue; }
    runs.push([v, n]); v = g[i]; n = 1;
  }
  runs.push([v, n]);
  return JSON.stringify({hoja: H.nombre, ancho: H.w, alto: H.h, escala_um: H.um_px, runs});
}
function pegarJson(texto) {
  if (!H || !mctx || !mascaraLista()) return false;
  let j; try { j = JSON.parse(texto); } catch (e) { return msg('invalid JSON: ' + e.message); }
  if (!j || typeof j !== 'object') return msg('invalid mask JSON');
  if (j.ancho !== H.w || j.alto !== H.h) return msg(`size ${j.ancho}x${j.alto} != ${H.w}x${H.h}`);
  if (!Array.isArray(j.runs) || j.runs.some(r => !Array.isArray(r) || r.length !== 2 || ![0,128,255].includes(r[0]) || !Number.isSafeInteger(r[1]) || r[1] <= 0) ||
      j.runs.reduce((n,r) => n+r[1],0) !== H.w*H.h) return msg('invalid mask class values or run lengths');
  if (!window.verificarCorridaMascara) {
    if (j.hoja && j.hoja !== H.nombre) return msg('different sheet: mask JSON not imported');
    if (!confirm('Mask JSON has no verified sample, depth or grid metadata. Verify the source image before importing. Import anyway?')) return false;
  }
  const out = mctx.createImageData(H.w, H.h);
  let i = 0;
  for (const [v, n] of j.runs) {
    const c = v === 255 ? COLOR.tinta : (v === 0 ? COLOR.no : null);
    if (c) for (let k = 0; k < n; k++, i += 4) { out.data[i] = c[0]; out.data[i+1] = c[1]; out.data[i+2] = c[2]; out.data[i+3] = 255; }
    else i += n * 4;
  }
  if (i !== out.data.length) return msg(`runs add up to ${i/4} px, expected ${H.w*H.h}`);
  if (!reemplazarMascara(out,destinoMascara())) return false;
  msg('pasted ' + (j.hoja || '')); return true;
}

/* ---------- cableado comun de botones (cada pagina usa los mismos ids; los que falten se ignoran) ---------- */
conectar('#mTinta', 'onclick', () => setModo('tinta'));
conectar('#mNo', 'onclick', () => setModo('no'));
conectar('#mBorrar', 'onclick', () => setModo('borrar'));
conectar('#mRegion', 'onclick', () => setModo('region'));
conectar('#sz', 'oninput', e => setBrocha(+e.target.value));
conectar('#undo', 'onclick', () => aplicar(undoS, redoS));
conectar('#redo', 'onclick', () => aplicar(redoS, undoS));
conectar('#btnAnillo', 'onclick', () => anilloFondo(+$q('#anilloR').value));
async function exportarPngMascara(ver = false) {
  const d = destinoMascara(); if (!d || !mascaraLista()) return;
  const canvas = grisCanvas(), info = d.info;
  try {
    if (!info || !window.pngConCorrida) throw new Error('mask provenance is unavailable; wait for loading');
    const b = await new Promise(ok => canvas.toBlob(ok,'image/png'));
    if (!b) throw new Error('PNG encoding failed');
    const png = await window.pngConCorrida(b,{...info,formato_mascara:'tri-state'}), u = URL.createObjectURL(png);
    if (ver) { if (!window.open(u,'_blank')) msg('the browser blocked the tab; allow popups'); }
    else { const a = document.createElement('a'); a.href = u; a.download = 'mascara_' + d.nombre.replace(/[^a-zA-Z0-9_.+-]/g,'_') + '.png'; a.click(); }
  } catch (err) { msg('Mask export BLOCKED: ' + err.message); }
}
conectar('#exp', 'onclick', () => exportarPngMascara());
// descargas bloqueadas -> abrir el PNG en una pestana y guardarlo con boton derecho
conectar('#verPng', 'onclick', () => exportarPngMascara(true));
conectar('#copJson', 'onclick', async () => {
  if (!H || !mascaraLista()) return;
  const t = aJson(), ta = $q('#ta'); ta.value = t; ta.select();
  const kb = (new Blob([t]).size / 1024).toFixed(1);
  try { await navigator.clipboard.writeText(t); msg('copied ' + kb + ' KB'); }
  catch { msg((document.execCommand('copy') ? 'copied ' : 'manual copy (ctrl+C) ') + kb + ' KB'); }
});
conectar('#pegJson', 'onclick', () => H && pegarJson($q('#ta').value));
conectar('#imp', 'onclick', () => $q('#impFile').click());
const formatoImportacion = document.createElement('select');
formatoImportacion.id = 'impFormato'; formatoImportacion.setAttribute('aria-label','Mask import format');
formatoImportacion.innerHTML = '<option value="">Choose mask format…</option><option value="ink">Ink-only PNG: 0 unlabeled / 255 ink</option><option value="tri">Tri-state PNG: 0 non-ink / 128 IGNORE / 255 ink</option><option value="par">PNG pair: inklabels + supervision_mask</option>';
if ($q('#imp')) $q('#imp').before(formatoImportacion);
formatoImportacion.onchange = () => { if ($q('#impFile')) { $q('#impFile').multiple = formatoImportacion.value === 'par'; $q('#impFile').value = ''; } };
conectar('#impFile', 'onchange', async e => {
  const d = destinoMascara(), files = Array.from(e.target.files || []), format = formatoImportacion.value;
  try {
    if (!d || !files.length || !mascaraLista()) return false;
    let ordered;
    if (format === 'par') {
      ordered = ['inklabels','supervision_mask'].map(k => files.find(f => new RegExp('(?:^|_)' + k + '(?: ?\\(\\d+\\))?\\.png$','i').test(f.name)));
      if (files.length !== 2 || ordered.some(f => !f) || ordered[0] === ordered[1]) throw new Error('Select one inklabels.png and its matching supervision_mask.png');
    } else if (format === 'tri' || format === 'ink') {
      if (files.length !== 1) throw new Error('Select one PNG for this mask format');
      if (/(?:inklabels|supervision_mask)(?: ?\(\d+\))?\.png$/i.test(files[0].name) && format === 'tri') throw new Error('A binary ink mask needs PNG pair or the explicit ink-only format');
      if (/supervision_mask(?: ?\(\d+\))?\.png$/i.test(files[0].name) && format === 'ink') throw new Error('A supervision mask is not an ink-only mask; select PNG pair');
      ordered = files;
    } else throw new Error('Choose ink-only PNG, tri-state PNG or PNG pair before importing');
    let out;
    if (format === 'par') out = await leerParMascara(ordered,d.w,d.h);
    else { const ink = await leerPngMascara(ordered[0],d.w,d.h); out = decodificarPixelesMascara(ink,format === 'ink' ? ink : null); }
    if (!destinoVigente(d)) return false;
    if (!await confirmarMetadatosMascara(ordered,d.info,'Mask import') || !destinoVigente(d) || !mascaraLista()) return false;
    if (!reemplazarMascara(out,d)) return false;
    msg('imported ' + ordered.map(f => f.name).join(' + ') + (format === 'ink' ? ' · black is unlabelled; no reviewed non-ink is included' : '') + ' · Ctrl+Z restores the previous mask'); return true;
  } catch (err) { msg('Mask import BLOCKED: ' + err.message); return false; }
  finally { e.target.value = ''; }
});

;
/* ===== etiq_2509 (25-sep-2026): corregir a mano las mascaras AUTOMATICAS de las laminas de entrenamiento de r3b/r3f =====
   Corridas del catalogo <seg>_{base,r3f,r3b}_etiq (campana_1447_20260924): BASE / r3f / r3b sobre el render de la cadena
   r3b_vc3d (VC3D 1 px = 1 voxel, 36 capas, orientacion de lectura), la MISMA grilla que las propuestas v3 regeneradas ahi.
   Su lamina de etiquetas es '<seg>__vc3d_lectura' y no el segmento pelado: el segmento ya tiene propuestas y etiquetas en
   OTRA grilla (render_sv del 13-sep: otra escala y otra orientacion) y compartir carpeta las mezclaria.
     automatica (el visor NUNCA la escribe)
       catalog/<rollo>/segments/<seg>/labels/por-profundidad/_propuestas/<seg>__vc3d_lectura/c±NN/<seg>__vc3d_lectura_{inklabels,supervision_mask}.png
     corregida (la escribe el visor al pintar: 'save to S3', 20 s despues del ultimo trazo; el proxy la pone en work-3)
       catalog/<rollo>/segments/<seg>/labels/por-profundidad/<seg>__vc3d_lectura/c±NN/...   la de trabajo, por profundidad
       catalog/<rollo>/segments/<seg>/labels/etiquetas/<seg>__vc3d_lectura/...              la ultima guardada
       catalog/<rollo>/segments/<seg>/labels/.history/...                                     cada version reemplazada
     (<rollo> = la muestra de la ruta del mapa; en campana_1447_20260924, PHerc1447)
   Lo que agrega (solo a esas corridas; el resto del visor no cambia):
   1. las tres corridas de una lamina comparten el lienzo de la mascara (IndexedDB '<seg>__vc3d_lectura|c<N>');
   2. al abrir una profundidad con el lienzo vacio carga la corregida de work-3 si existe; si no, la automatica. Cargar no
      guarda nada: la corregida nace con el primer trazo;
   3. 'import proposal' queda deshabilitado ahi (la automatica ya se carga sola; re-importarla sobre una correccion
      volveria a pintar la tinta borrada);
   4. marca r3f_etiq / r3b_etiq como entrenados con estas laminas (aviso CONTAMINATED y '⚠ training' del visor);
   5. guardado: el visor sube el lienzo 20 s despues de CUALQUIER pointerup en modo etiqueta (tambien al mover la vista con el
      boton derecho) y, al cambiar de lamina con trazos pendientes, sube el lienzo viejo con el nombre de la lamina nueva.
      Para estas laminas se corta en fetch: no sube una profundidad que nadie edito (no hay entrada en IndexedDB ni trazo en
      esta sesion: la automatica no se copia como «corregida») ni un PNG con otras medidas que las de la lamina;
   6. el par debe ser PNG opaco binario de la grilla exacta; una máscara inválida bloquea la carga. */
(function(){
 const SUF='__vc3d_lectura',RX=/_etiq$/;
 const EDITADO={};   /* clave del lienzo -> hubo un trazo/edicion en esta sesion */
 const rutaSeg=g=>{for(const f of Object.values(g.frames||{})){const m=/catalog\/([^/]+)\/segments\/([^/]+)\/ink-detection\//.exec(f);if(m)return{seg:m[2],base:m[1]+'/segments/'+m[2],rollo:m[1]}}return null};
 const nuestras=[];   /* Recognize every scroll before building the multi-scroll explorer. */
 if(typeof manifest!=='undefined')for(const g of manifest){const cm=g.catalogMeta;if(!cm||!RX.test(cm.modelo||''))continue;
  const s=rutaSeg(g);if(!s)continue;cm.lam=s.seg+SUF;cm.etiq2509=s;nuestras.push(g)}
 const esNuestra=g=>!!(g&&g.catalogMeta&&g.catalogMeta.etiq2509);
 const claveEstado=nombre=>(typeof H!=='undefined'&&H?.scroll||window.ROLLO)+'|'+nombre;
 const ESTADO={};   /* clave del lienzo -> de donde salio la mascara al abrir */
 window.ETIQ2509={SUF,corridas:nuestras.map(g=>g.id),estado:ESTADO};
 const TXT={auto:'opened from the AUTOMATIC v3 proposal · strokes are saved as the corrected version',
            corr:'opened from your CORRECTED version in annotation storage · new strokes replace it, the old version stays in history',
            local:'opened from this browser (IndexedDB)',nada:'no mask at this depth (only the loaded depths have one)'};
 function marca(){let m=document.getElementById('etiqMarca');const vp=document.getElementById('viewport');if(!vp)return;
  if(!m){m=document.createElement('div');m.id='etiqMarca';m.setAttribute('role','status');
   m.style.cssText='position:absolute;left:12px;top:42px;z-index:4;pointer-events:none;background:#12324ae6;border:1px solid #4aa3d9;border-radius:6px;padding:2px 8px;font:12px ui-monospace,monospace;color:#cfe8f7;white-space:nowrap';vp.append(m)}
  const e=(typeof H!=='undefined'&&H)?ESTADO[claveEstado(H.nombre)]:null,on=typeof etiqOn!=='undefined'&&etiqOn&&esNuestra(typeof group!=='undefined'?group:null)&&e;
  m.hidden=!on;m.style.display=on?'block':'none';if(on)m.textContent='mask '+(cen(H.nombre)||'')+': '+TXT[e]}
 function cen(nombre){const m=/\|c(-?\d+)$/.exec(nombre||'');if(!m)return null;const c=+m[1];return 'c'+(c<0?'-':'+')+String(Math.abs(c)).padStart(2,'0')}
 async function par(lam,c,base,prop){
  try{return await obtenerParMascara(lam,Number(c.slice(1)),base,prop)}
  catch(e){if(/HTTP (404|204)$/.test(e.message))return null;throw e}}
 async function dibujar(p,destino){
  const out=await leerParMascara(p.blobs,destino.w,destino.h);
  if(!destinoVigente(destino)||!mascaraVacia())return null;
  if(!await confirmarMetadatosMascara(p.blobs,destino.info,'Automatic mask load'))return null;
  if(!destinoVigente(destino)||!mascaraVacia())return null;
  const image=destino.ctx.createImageData(destino.w,destino.h);image.data.set(out.data);
  let ni=0,nn=0;for(let i=0;i<out.data.length;i+=4)if(out.data[i+3]===255){if(esTinta(out.data,i))ni++;else nn++}
  destino.ctx.putImageData(image,0,0);dirty=true;
  if(typeof contar==='function')contar();if(typeof espejarMascara==='function')espejarMascara();
  return [ni,nn]}
 window.visorAliasCorridas=()=>{
  if(typeof alias!=='undefined')for(const g of nuestras)alias[g.id]={nombre:g.catalogMeta.lam,get w(){return curW},get h(){return curH},get um_px(){return window.visorUmPorPixel?visorUmPorPixel(g):null},capas:[]};
  if(typeof MEDIDO!=='undefined'&&MEDIDO)for(const g of nuestras.filter(g=>visorRolloDe(g)===MEDIDAS_DE)){
   for(const m of ['r3f_etiq','r3b_etiq']){CONTAM[m]=CONTAM[m]||new Set();CONTAM[m].add(g.catalogMeta.lam)}
   CONTAM_TXT[g.catalogMeta.lam]='TRAINING SHEET · r3f and r3b were trained on this sheet with its AUTOMATIC mask (the one being corrected): their maps here repeat what they learned. BASE never saw '+MEDIDAS_DE+'.';
  }
 };
 document.addEventListener(window.VISOR_STATIC?.readyEvent || 'DOMContentLoaded',()=>{
  /* 1. un lienzo por lamina y profundidad para las tres corridas (trasFrame: clave = hoja.nombre + '|c' + centro) */
  window.visorAliasCorridas();
  /* 2. carga de work-3 cuando el lienzo abre vacio */
  if(typeof restaurar==='function'){const r0=restaurar;
   restaurar=async function(nombre){
    const destino=destinoMascara();
    await r0(nombre);
    if(!destinoVigente(destino)||H.nombre!==nombre||!esNuestra(group)||nombre.split('|')[0]!==group.catalogMeta.lam)return;
    if(!mascaraVacia()){ESTADO[claveEstado(nombre)]=ESTADO[claveEstado(nombre)]||'local';marca();return}
    const c=cen(nombre);if(!c){ESTADO[claveEstado(nombre)]='nada';marca();return}
    const {base}=group.catalogMeta.etiq2509,lam=group.catalogMeta.lam;
    for(const [prop,e] of [[false,'corr'],[true,'auto']]){
     try{const p=await par(lam,c,base,prop);if(!destinoVigente(destino))return;
      if(!p)continue;if(!mascaraVacia())return;
      const n=await dibujar(p,destino);if(!n)return;
      ESTADO[claveEstado(nombre)]=e;marca();msg(c+': '+TXT[e]+' — ink '+n[0].toLocaleString()+' px, no-ink '+n[1].toLocaleString()+' px');return}
     catch(err){msg('Mask load BLOCKED: '+err.message);return}}
    ESTADO[claveEstado(nombre)]='nada';marca()}}
  /* 3. 'import proposal' fuera de juego en estas corridas */
  const bi=document.getElementById('impProp'),mapa=document.getElementById('map');
  const boton=()=>{if(bi&&esNuestra(group)){bi.disabled=true;bi.textContent='automatic mask loads on open';bi.title='These runs load the automatic v3 proposal (or your corrected version) by themselves when a depth opens. Importing again would re-paint the ink you erased.'}marca()};
  if(mapa)new MutationObserver(boton).observe(mapa,{attributes:true,attributeFilter:['src']});
  setTimeout(boton,1500);setInterval(marca,1000);
  /* 4. r3f y r3b se entrenaron con la mascara automatica de estas laminas. 25-sep generalizar-por-rollo: eso se sabe de las
     corridas _etiq de campana_1447_20260924, o sea solo en el visor del rollo con las medidas de index.html (MEDIDO); en
     otro rollo unas _etiq no traen esa marca (no se sabe con que se entrenaron: no se afirma nada). */
  /* 5. guardas de guardado para estas laminas (solo POST /api/mascara/<seg>__vc3d_lectura/...png; lo demas pasa igual) */
  const vp=document.getElementById('viewport');
  const marcar=()=>{try{if(H&&H.nombre&&H.nombre.split('|')[0].endsWith(SUF))EDITADO[claveEstado(H.nombre)]=true}catch(e){}};
  if(vp){vp.addEventListener('pointerdown',e=>{if(typeof etiqOn!=='undefined'&&etiqOn&&e.button===0&&!(typeof espacio!=='undefined'&&espacio)&&!e.target.closest('#panel'))marcar()},true)}
  if(typeof autoguardar==='function'){const ag0=autoguardar;autoguardar=function(){marcar();return ag0.apply(this,arguments)}}
  const f0=window.fetch.bind(window);
  window.fetch=async function(u,o){
   try{const url=typeof u==='string'?u:(u&&u.url)||'';const m=/\/api\/mascara\/([^/?]+)\/[^/?]+\.png(?:\?|$)/.exec(url);
    if(m&&o&&String(o.method||'').toUpperCase()==='POST'){const lam=decodeURIComponent(m[1]);
     if(lam.endsWith(SUF)){const seg=lam.slice(0,-SUF.length),q=new URLSearchParams(url.split('?')[1]||''),cq=q.get('c');
      const clave=lam+'|c'+(cq==null||cq===''?'max':cq);
      const owner=window.mascaraDueno,dimensions=owner&&owner.nombre===clave?[owner.w,owner.h]:(H&&H.nombre===clave?[H.w,H.h]:null);
      if(!dimensions)throw new Error('not saved: the mask owner is no longer mounted');
      if(o.body&&o.body.slice){const hd=new DataView(await o.body.slice(16,24).arrayBuffer());const w=hd.getUint32(0),h=hd.getUint32(4);
       if(w!==dimensions[0]||h!==dimensions[1])throw new Error('not saved: mask '+w+'x'+h+' differs from its frame '+dimensions.join('x'))}
      let hay=!!EDITADO[(q.get('rollo')||window.ROLLO)+'|'+clave];if(!hay){const b=await idb('readonly',s=>s.get(clave)).catch(()=>null);hay=!!b}
      if(!hay)throw new Error('nothing to save at '+(cen(clave)||'max')+': no edits (the automatic mask is not copied as corrected)')}}}
   catch(e){return Promise.reject(e)}
   return f0(u,o)};
 },{once:true});
})();

;
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
 if(globalThis.VISOR_STATIC)return VISOR_STATIC.mapUrl(frame,contrast,scale);
 if(!OFFICIAL_FRAME.test(frame))return frame+'/'+contrast+(scale===4?'_lo.jpg':scale===8?'_lo8.jpg':'.png');
 const ext=/\.(png|tiff?)$/i.exec(frame);
 const url=ext?frame.slice(0,-ext[0].length)+(contrast==='global'?'-global':'')+ext[0]:frame+(contrast==='global'?'-global':'')+'.png';
 if(ext&&/^tiff?$/i.test(ext[1]))return '/api/mapa/'+url.replace(/^\.\.\//,'').split('/').map(encodeURIComponent).join('/')+'?escala='+(scale||1)+(!scale&&globalThis.recorteVista?globalThis.recorteVista.query(frame):'');
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
 if(globalThis.VISOR_STATIC?.reduced||!(UM_POR_PX>0)||group?.catalogMeta?.physicalScaleVerified===false)return;
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
function show(reset=false){if(!group)return;if(globalThis.recorteVista)globalThis.recorteVista.showing();if(pintar)release();if(!group.catalogMeta)for(const o of $('contrast').options)o.disabled=false;ensureContrast();let n=Number(slider.value),dir=projection?group.maximum:group.frames[n];$('offset').value=projection?'Max.':group.catalogMeta?.depthKnown===false?'Map':signed(n);pintarBanda(n);syncHash();if(projection){const o=group.maximumOffsets||[];$('projection').textContent='Maximum '+(o.length?signed(Math.min(...o))+'…'+signed(Math.max(...o)):'across depths')+' · can merge strokes from different sheets or artefacts.'}$('prev').disabled=projection||n<=Number(slider.min);$('next').disabled=projection||n>=Number(slider.max);slider.disabled=projection||group.catalogMeta?.depthKnown===false;$('projection').hidden=!projection;$('max').classList.toggle('active',projection);$('max').setAttribute('aria-pressed',String(projection));let token=++request;fullresReady=0;$('notice').hidden=false;im.style.opacity='.3';
 if(!dir){$('notice').textContent='This centre is not available yet';im.hidden=true;$('download').removeAttribute('href');return}
 const staticMap=globalThis.VISOR_STATIC?.select(dir,$('contrast').value);
 const url=mapUrl(dir,$('contrast').value);$('notice').textContent='Loading image…';const loader=new Image();loader.crossOrigin='anonymous';
 loader.onload=()=>{if(token!==request)return;if(globalThis.recorteVista)globalThis.recorteVista.reduced(null);let changed=im.naturalWidth!==loader.naturalWidth||im.naturalHeight!==loader.naturalHeight;im.onload=()=>{if(token!==request)return;fullresReady=token;fullresGroup=group;fullresDepth=projection?'max':String(n);if(reset||changed||fitted)fit();else paint();fxPedir(true)};im.src=url;im.hidden=false;im.style.opacity=$('chkMapa').checked?$('mapOp').value:0;$('notice').hidden=true;$('download').href=staticMap?.original||url;im.alt=group.id+' · '+(projection?'maximum across depths':'centre '+signed(n));$('title').textContent=group.id+' · '+loader.naturalWidth+' × '+loader.naturalHeight+' px'+(globalThis.recorteVista?globalThis.recorteVista.title():'');if(reset||changed||fitted){const[lw,lh]=oriDims(oriEf(group),loader.naturalWidth,loader.naturalHeight);zoom=Math.min(vp.clientWidth/lw,vp.clientHeight/lh)*.96;x=(vp.clientWidth-lw*zoom)/2;y=(vp.clientHeight-lh*zoom)/2;fitted=true;paint()}trasFrame(loader.naturalWidth,loader.naturalHeight)};
 /* 24-nov: a TIFF map too large for full resolution in a browser (official whole segments reach gigapixels) opens as a
    reduced, browse-only view: the 1/4 map, or the published 1/8 JPEG. fullresReady stays 0, so labeling stays locked. */
 const reduced=()=>{if(token!==request)return;const W=loader.naturalWidth,H=loader.naturalHeight,changed=im.naturalWidth!==W||im.naturalHeight!==H;
  im.onload=()=>{if(token!==request)return;if(reset||changed||fitted)fit();else paint();fxPedir(true)};
  im.src=loader.src;im.hidden=false;im.style.opacity=$('chkMapa').checked?$('mapOp').value:0;$('download').href=staticMap?.original||loader.src;
  $('notice').hidden=false;$('notice').textContent=staticMap?'Published preview · browse only. Open the original TIFF for its native grid.':'Reduced view: this map is too large for full resolution in a browser. To label it, use Label a crop.';
  if(globalThis.recorteVista)globalThis.recorteVista.reduced({url,w:W,h:H});im.alt=group.id+' · reduced view';$('title').textContent=group.id+' · reduced view '+W+' × '+H+' px · browse only';trasFrame(W,H)};
 if(staticMap?.preview){loader.reduced=true;loader.onload=reduced}
 loader.onerror=()=>{if(token!==request)return;if(globalThis.recorteVista&&globalThis.recorteVista.failed())return show(true);
  if(/\.tiff?$/i.test(dir||'')&&!loader.reduced&&(!staticMap||staticMap.fallback)){loader.reduced=true;$('notice').textContent='Too large for full resolution: loading a reduced view…';loader.onload=reduced;if(staticMap)VISOR_STATIC.setReduced(true);loader.src=mapUrl(dir,$('contrast').value,4);return}
  if(staticMap){cargandoOff();im.hidden=true;$('download').href=staticMap.original;$('notice').textContent='Cannot display this map. Check browser access (CORS), or open the original file.';return}
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
(globalThis.visorFetchData || fetch)('alias.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{if(d){ALIAS=d;pintarArbol();if(window.xpRepintar)window.xpRepintar()}}).catch(()=>{});
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
 const k=mskClave(); if(globalThis.VISOR_STATIC?.reduced||!k||!mask||!mask.width)return;
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
 (globalThis.visorFetchData || fetch)(kit+'hojas.json').then(r=>r.ok?r.json():null).then(hs=>{if(rollo!==ROLLO||kit!==KIT||!Array.isArray(hs))return;HOJAS=hs;
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
 if(globalThis.VISOR_STATIC?.reduced){maskReady=false;montarCapas(null);return}
 /* one mask per DEPTH (12-sep): the sheet key carries the centre, so changing depth swaps the working mask (IndexedDB) */
 const hoja=hojaDe(group.id),k=claveLienzo(group,curW,curH)+(globalThis.recorteVista?globalThis.recorteVista.key():'')+'|c'+(projection?'max':slider.value);   /* 25-sep: clave de la grilla (ver claveLienzo) */
 if(k!==clave){clave=k;montarCapas(hoja);montarMascara(hoja,k,curW,curH)}
 const svg=$('regionOverlay');svg.setAttribute('viewBox','0 0 '+curW+' '+curH);svg.setAttribute('width',curW);svg.setAttribute('height',curH);
 dibujarRegion();
}
/* 25-sep: si el censo de orientación llega después de montar la máscara, la clave pasa de la vieja (por corrida) a la de la grilla */
function reclavar(){if(globalThis.VISOR_STATIC?.reduced||!group||!curW||vp.classList.contains('cargando'))return;
 const hoja=hojaDe(group.id),k=claveLienzo(group,curW,curH)+(globalThis.recorteVista?globalThis.recorteVista.key():'')+'|c'+(projection?'max':slider.value);
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
  const img=new Image();img.crossOrigin='anonymous';img.onload=()=>fxPedir(true);img.src=globalThis.VISOR_STATIC?VISOR_STATIC.resource(KIT+c.f):KIT+c.f;img.style.opacity=c.op;img.hidden=true;   // arrancan apagadas: el visor por defecto muestra tinta
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

function modoEtiq(v){if(v&&globalThis.VISOR_STATIC?.reduced)return;etiqOn=v;$('panel').hidden=!v;document.body.classList.toggle('etiq',v);
 if(window.requireAnnotationHD)window.requireAnnotationHD(v);
 $('etiq').classList.toggle('active',v);$('etiq').setAttribute('aria-pressed',String(v));
 $('mask').style.display=v?'block':'none';espejarMascara();syncHash()}
$('etiq').onclick=()=>modoEtiq(!etiqOn);
$('mkOp').oninput=e=>{$('mask').style.opacity=e.target.value;espejarMascara()};
window.addEventListener('beforeunload',e=>{if(s3Pend && !globalThis.VISOR_STATIC){e.preventDefault();e.returnValue='Strokes not yet saved to S3'}});
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

document.addEventListener(window.VISOR_STATIC?.readyEvent || 'DOMContentLoaded',()=>{
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
   const g=document.createElement('img'); g.crossOrigin='anonymous';g.draggable=false;
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
addEventListener(window.VISOR_STATIC?.readyEvent || 'DOMContentLoaded',()=>{const lab=$('etiq');if(!lab)return;   /* junto a Label / Open PNG (ui_modos ya armo los grupos) */
 const mk=(id,txt,tit,fn)=>{const b=document.createElement('button');b.id=id;b.type='button';b.textContent=txt;b.title=tit;b.onclick=fn;lab.parentElement.insertBefore(b,lab);return b};
 mk('oriAuto','','',oriAlternar).hidden=true;
 mk('voltF',"flip ↕","Flip displayed rows vertically. Display only; PNG and mask grids remain unchanged. Remembered across runs.",()=>voltear('f'));
 mk('voltC',"flip ↔","Flip displayed columns horizontally. Display only; PNG and mask grids remain unchanged. Remembered across runs.",()=>voltear('c'));
 oriBotones()});
(globalThis.visorFetchData || fetch)('orientacion_vista.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{if(d&&d.corridas){oriCambiar(()=>{ORI=d.corridas});reclavar()}}).catch(()=>{});   /* 25-sep: reclavar = lienzo de la grilla */
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
Promise.all(['legibilidad.json','../catalog/_viewer/legibilidad-auto.json','legibilidad-fl22.json','../catalog/'+ROLLO+'/_viewer/legibilidad-auto.json'].map(url=>(globalThis.visorFetchData || fetch)(url,{cache:'no-cache'}).then(r=>r.ok?r.json():null).catch(()=>null))).then(([base,auto,fl22,sample])=>{
 LEG_V5M={...(auto&&auto.laminas||{}),...(fl22&&fl22.laminas||{}),...(sample&&sample.laminas||{})};
 const d=base||auto||fl22||sample?{laminas:{...(auto&&auto.laminas||{}),...(fl22&&fl22.laminas||{}),...(base&&base.laminas||{}),...(sample&&sample.laminas||{})}}:null;
 if(d&&d.laminas){LEG=d.laminas;const seg={};LAM.forEach(e=>{const b=[e.lam,...e.hojas].map(h=>LEG[h]).filter(l=>l&&Number.isFinite(l.max)).sort((a,b)=>b.max-a.max)[0];if(b)seg[e.lam]=b});Object.assign(LEG,seg);CARPETAS.forEach(v=>v.sort(compareV5Lamina));ARB=armar(vistaModo);pintarArbol();if(window.xpRepintar)window.xpRepintar();if(window.v5HistRepintar)window.v5HistRepintar();}}).catch(()=>{});
Promise.all(['compuertas.json','compuertas-painting.json','compuertas-work3.json','../catalog/_viewer/compuertas-auto.json','../catalog/'+ROLLO+'/_viewer/compuertas-auto.json'].map(url=>(globalThis.visorFetchData || fetch)(url,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null))).then(([legacy,painting,work3,auto,sample])=>{
 const d={laminas:{...(auto&&auto.laminas||{}),...(legacy&&legacy.laminas||{}),...(painting&&painting.laminas||{}),...(work3&&work3.laminas||{}),...(sample&&sample.laminas||{})},umbrales:legacy&&legacy.umbrales};
 if(!d||!d.laminas)return;CG=d.laminas;if(d.umbrales)CGum=d.umbrales;
 {const seg={};LAM.forEach(e=>{const h=e.hojas.filter(h=>h!==e.lam&&CG[h]).sort((a,b)=>(CG[b].cm2??-1)-(CG[a].cm2??-1))[0];if(h)seg[e.lam]={...CG[h],...(CG[e.lam]||{})}});Object.assign(CG,seg)}
 /* 12-sep: estado y area vienen de compuertas.json cuando existen; el label queda como respaldo */
  LAM.forEach(e=>{const g=CG[e.lam];if(!g)return;if(g.estado_inv)e.est=g.estado_inv;if(g.cm2!=null)e.cm=g.cm2;});
  etapasAUI();pintarArbol();
  /* las areas llegan DESPUES del primer pintado: el explorer sumaba 2192 de 3046 cm2 */
  if(window.xpRepintar)try{window.xpRepintar()}catch(e){}
 const b=$('tree').querySelector('.lam.sel');if(b)b.scrollIntoView({block:'nearest'})}).catch(()=>{});

addEventListener(window.VISOR_STATIC?.readyEvent || 'DOMContentLoaded',()=>{
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
   url:'/api/mascara-par/'+encodeURIComponent(carpetaDe(group))+'?c='+encodeURIComponent(corrida.profundidad)+(ruta?'&base='+encodeURIComponent(ruta.base):'')+'&rollo='+encodeURIComponent(rollo)+(corrida.recorte?'&recorte='+[corrida.recorte.x,corrida.recorte.y,corrida.recorte.ancho,corrida.recorte.alto].join(','):'')};
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
   .catch(e=>{ const t=String(e&&e.message||e); if(typeof msg==='function')msg((/^(sin cambios|No changes)/.test(t)?'':"Save failed: ")+t.slice(0,140)); })   /* nothing new since the last save (the 20 s autosave, usually) is not a failure */
   .finally(()=>{ b3.disabled=!visorPuedeGuardar; b3.textContent=visorTexto("save pair"); });
 };
 $('exp').parentElement && $('exp').parentElement.append(b3);
})();

;
/* ===== filtros pro (12-sep-2026) =====
   Extiende los filtros visuales del visor SIN tocar su codigo: agrega campos a FX, controles al
   panel, paletas, y redefine las funciones de dibujo (lutDe, fxLut, defsPanes, fxCompuesto,
   fxDibujar, fxAUI, fxPintarPresets) para que TODO pase por filtros SVG (GPU, sin el tope de
   40 Mpx del canvas) con una sola cadena:

     imagen -> [unsharp | pasa-alto | pasa-banda (DoG)] -> [borde] -> LUT -> [mezcla con el crudo]

   LUT (tabla de 256): niveles (negro/blanco o percentiles automaticos) -> gamma -> brillo/contraste
   -> curva S (sigmoide alrededor de un centro) -> posterizar -> invertir -> umbral -> falso color.

   Que ayuda al ojo con tinta tenue, y por que esta cada cosa:
   - niveles por percentil: el mapa usa 10 % del rango; estirar p2-p98 es lo primero que hay que hacer.
   - pasa-alto / DoG: sacan el fondo lento (variacion de iluminacion del render) y dejan el trazo, que
     tiene ~25-45 px de ancho a 8,64 um; el DoG con radio 6 (sigma 6 / 18) esta afinado a eso.
   - tras pasa-alto/DoG la imagen vive alrededor de 0,5 (gris medio): la ventana de niveles va 96-160, no los
     percentiles del crudo (que quedarian planos).
   - curva S: contraste concentrado alrededor del nivel del fondo, sin quemar extremos.
   - paletas perceptuales (viridis/magma/cividis) y divergente (azul bajo / rojo alto alrededor del
     centro): el ojo separa mejor tonos que grises.
   - relieve / laplaciano / isolineas: bordes y mesetas; sirven para decidir si una mancha tiene forma.
   - parpadeo: alterna filtrado/crudo a 2,5 Hz; el sistema visual detecta lo que cambia mucho mejor que
     lo que esta quieto. */
(function(){
 if(typeof FXDEF==='undefined'||typeof PANES==='undefined'){console.warn('filtros_pro: visor sin FX');return}
 const NS='http://www.w3.org/2000/svg';
 /* ---- campos nuevos (persisten en localStorage por la misma via que los viejos) ---- */
 const NUEVOS={negro:0,blanco:255,auto:'',curva:0,centro:0.5,poster:0,pasaalto:0,pasaGan:4,dog:0,dogRadio:6,dogGan:3,borde:'',mezcla:100};
 Object.assign(FXDEF,NUEVOS); for(const k in NUEVOS)if(!(k in FX))FX[k]=NUEVOS[k];
 FXCLAVES.length=0; Object.keys(FXDEF).filter(k=>k!=='abierto').forEach(k=>FXCLAVES.push(k));
 /* ---- paletas ---- */
 Object.assign(PAL,{
  magma:[[0,0,4],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,135,97],[254,194,135],[252,253,191]],
  cividis:[[0,32,77],[26,51,102],[60,71,110],[89,92,114],[118,114,120],[149,136,116],[182,159,106],[216,183,88],[255,234,70]],
  turbo:[[48,18,59],[70,105,224],[40,180,226],[28,225,164],[112,247,87],[195,236,45],[253,194,35],[237,111,16],[122,4,3]],
  diverge:[[33,102,172],[103,169,207],[209,229,240],[247,247,247],[253,219,199],[239,138,98],[178,24,43]],
  hot:[[0,0,0],[87,0,0],[172,0,0],[255,0,0],[255,85,0],[255,170,0],[255,255,0],[255,255,128],[255,255,255]]});
 /* ---- histograma de la imagen visible (512 px de ancho, cacheado por src) ---- */
 let HIST={src:'',h:null,pct:{}};
 function fxHist(){
  const src=im&&im.src; if(!src||!im.naturalWidth)return null;
  if(HIST.src===src&&HIST.h)return HIST.h;
  const scale=Math.min(1,512/Math.max(im.naturalWidth,im.naturalHeight));
  const w=Math.max(1,Math.round(im.naturalWidth*scale)),h=Math.max(1,Math.round(im.naturalHeight*scale));
  const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
  let d;try{g.drawImage(im,0,0,w,h);d=g.getImageData(0,0,w,h).data}catch(e){return null}
  const H=new Float64Array(256);let n=0;
  for(let i=0;i<d.length;i+=4){if(d[i+3]<128)continue;H[d[i]]++;n++}
  const pct={};if(n){let acc=0,q=[1,2,5,10,90,95,98,99],j=0;
   for(let v=0;v<256&&j<q.length;v++){acc+=H[v];while(j<q.length&&acc/n>=q[j]/100){pct['p'+q[j]]=v;j++}}}
  HIST={src,h:H,n,pct};return H}
 const fxPct=p=>{fxHist();return HIST.pct[p]};
 /* ---- niveles efectivos (auto por percentil pisa negro/blanco) ---- */
 function niveles(fx){
  let lo=+fx.negro,hi=+fx.blanco;
  if(fx.auto){const a={p1:['p1','p99'],p2:['p2','p98'],p5:['p5','p95'],p10:['p10','p90']}[fx.auto];
   if(a){const l=fxPct(a[0]),h=fxPct(a[1]);if(l!=null&&h!=null&&h>l){lo=l;hi=h}}}
  if(hi<=lo)hi=lo+1;return[lo/255,hi/255]}
 /* ---- LUT unica para SVG (floats) y canvas (Uint32) ---- */
 function lutPro(fx){
  const g=Math.max(.01,+fx.gamma),br=+fx.brillo,co=+fx.contraste,um=+fx.umbral/255,pal=PAL[fx.paleta],
        [lo,hi]=niveles(fx),k=+fx.curva,c0=+fx.centro,ps=+fx.poster|0,out=[];
  const sig=k>0?(t=>{const s=x=>1/(1+Math.exp(-k*(x-c0)));const a=s(0),b=s(1);return (s(t)-a)/(b-a||1)}):null;
  for(let v=0;v<256;v++){let t=v/255;
   t=(t-lo)/(hi-lo); t=t<0?0:t>1?1:t;
   if(g!==1)t=Math.pow(t,1/g);
   t=(t*br-.5)*co+.5;
   t=t<0?0:t>1?1:t;
   if(sig)t=sig(t);
   if(ps>=2)t=Math.min(1,Math.floor(t*ps)/(ps-1));
   if(fx.invertir)t=1-t;
   if(fx.umbralOn)t=t>=um?1:0;
   let r,gg,b;
   if(pal){const x=t*(pal.length-1),q=Math.min(pal.length-2,x|0),f=x-q;
    r=(pal[q][0]+(pal[q+1][0]-pal[q][0])*f)/255;gg=(pal[q][1]+(pal[q+1][1]-pal[q][1])*f)/255;b=(pal[q][2]+(pal[q+1][2]-pal[q][2])*f)/255}
   else r=gg=b=t;
   out.push([r,gg,b])}
  return out}
 window.lutDe=function(fx){const o=lutPro(fx),l=[[],[],[]];o.forEach(([r,g,b])=>{l[0].push(r.toFixed(4));l[1].push(g.toFixed(4));l[2].push(b.toFixed(4))});return l};
 window.fxLut=function(){const o=lutPro(FX),l=new Uint32Array(256);o.forEach(([r,g,b],v)=>{l[v]=((r*255)&255)|(((g*255)&255)<<8)|(((b*255)&255)<<16)});return l};
 /* ---- composicion: ajustes globales encima del preset de cada cuadrante ---- */
 window.fxCompuesto=function(base){
  const o=Object.assign({},FXDEF,base);
  o.gamma=(+o.gamma)*(+FX.gamma); o.brillo=(+o.brillo)*(+FX.brillo); o.contraste=(+o.contraste)*(+FX.contraste);
  if(FX.invertir)o.invertir=!o.invertir;
  if(FX.umbralOn){o.umbralOn=true;o.umbral=+FX.umbral}
  if(FX.paleta)o.paleta=FX.paleta;
  if(+FX.local>0){o.local=+FX.local;o.radio=+FX.radio}
  if(+FX.negro!==0)o.negro=+FX.negro; if(+FX.blanco!==255)o.blanco=+FX.blanco; if(FX.auto)o.auto=FX.auto;
  if(+FX.curva>0){o.curva=+FX.curva;o.centro=+FX.centro}
  if(+FX.poster>=2)o.poster=+FX.poster;
  if(+FX.pasaalto>0){o.pasaalto=+FX.pasaalto;o.pasaGan=+FX.pasaGan}
  if(+FX.dog>0){o.dog=1;o.dogRadio=+FX.dogRadio;o.dogGan=+FX.dogGan}
  if(FX.borde)o.borde=FX.borde;
  o.mezcla=(+o.mezcla)*(+FX.mezcla)/100;
  return o};
 /* ---- cadena SVG ---- */
 const el=(t,a)=>{const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);return e};
 function armarFiltro(id,fxc){
  const f=el('filter',{id,'color-interpolation-filters':'sRGB',x:'-5%',y:'-5%',width:'110%',height:'110%'});
  let src='SourceGraphic';
  if(+fxc.local>0){f.append(el('feGaussianBlur',{in:src,stdDeviation:+fxc.radio,result:'bl'}),
   el('feComposite',{in:src,in2:'bl',operator:'arithmetic',k1:0,k2:1+ +fxc.local,k3:-fxc.local,k4:0,result:'uns'}));src='uns'}
  /* g*src - g*blur + 0.5 with k4 on feComposite also hits ALPHA (0.5 -> premultiplied clipping = white): move the
     offset and the negative gain into a linear transfer of the blur so the composite's alpha sums to >= 1 */
  const neg=(inp,g,res)=>{const ct=el('feComponentTransfer',{in:inp,result:res});['R','G','B'].forEach(c=>ct.append(el('feFunc'+c,{type:'linear',slope:-g,intercept:0.5})));return ct};
  if(+fxc.pasaalto>0){const g=+fxc.pasaGan;f.append(el('feGaussianBlur',{in:src,stdDeviation:+fxc.pasaalto,result:'pa'}),neg('pa',g,'pan'),
   el('feComposite',{in:src,in2:'pan',operator:'arithmetic',k1:0,k2:g,k3:1,k4:0,result:'hp'}));src='hp'}
  if(+fxc.dog>0){const r=+fxc.dogRadio,g=+fxc.dogGan;
   f.append(el('feGaussianBlur',{in:src,stdDeviation:r,result:'d1'}),el('feGaussianBlur',{in:src,stdDeviation:r*3,result:'d2'}),neg('d2',g,'d2n'),
    el('feComposite',{in:'d1',in2:'d2n',operator:'arithmetic',k1:0,k2:g,k3:1,k4:0,result:'dog'}));src='dog'}
  if(fxc.borde){const K={relieve:'-2 -1 0 -1 1 1 0 1 2',lap:'0 -1 0 -1 4 -1 0 -1 0',sobel:'-1 -2 -1 0 0 0 1 2 1'}[fxc.borde];
   if(K){f.append(el('feConvolveMatrix',{in:src,order:3,kernelMatrix:K,divisor:1,bias:fxc.borde==='emboss'?0:0.5,preserveAlpha:'true',result:'bd'}));src='bd'}}
  const l=lutDe(fxc),ct=el('feComponentTransfer',{in:src,result:'lut'});
  ['R','G','B'].forEach((c,k)=>ct.append(el('feFunc'+c,{type:'table',tableValues:l[k].join(' ')})));f.append(ct);
  const m=Math.max(0,Math.min(1,(+fxc.mezcla)/100));
  if(m<1)f.append(el('feComposite',{in:'lut',in2:'SourceGraphic',operator:'arithmetic',k1:0,k2:m,k3:1-m,k4:0}));
  return f}
 function defsRaiz(){let d=$('panesDefs');
  if(!d){const svg=document.querySelector('svg[aria-hidden]')||document.querySelector('svg');d=el('defs',{id:'panesDefs'});svg&&svg.append(d)}return d}
 window.defsPanes=function(){const d=defsRaiz();if(!d)return;d.innerHTML='';
  PANES.forEach((p,i)=>d.append(armarFiltro('fxPane'+i,fxCompuesto(p.fx))));
  d.append(armarFiltro('fxSolo',fxCompuesto({})))};
 /* ---- vista unica: misma cadena SVG, sin canvas ---- */
 const neutro=()=>FXCLAVES.every(k=>{const q=FXDEF[k];return typeof q==='boolean'?!!FX[k]===q:(typeof q==='number'?+FX[k]===q:FX[k]===q)});
 window.fxDibujar=function(){
  const cv=$('fx');fxDentro=true;
  cv.style.display='none';stage.classList.remove('fxon');fxG=fxA=fxOut=null;
  if(neutro()){stage.style.setProperty('--fx','none');fxEstado('');fxDentro=false;pintarHist();return}
  defsPanes();stage.style.setProperty('--fx','url(#fxSolo)');
  const a=[];if(FX.auto){const[lo,hi]=niveles(FX);a.push('levels '+Math.round(lo*255)+'–'+Math.round(hi*255))}
  fxEstado((a.length?a.join(' · ')+' · ':'')+'SVG/GPU');fxDentro=false;pintarHist()};
 /* ---- controles nuevos en el panel ---- */
 const P=$('filtros');
 const fila=document.createElement('div');fila.id='filtrosPro';fila.style.cssText='display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;width:100%;margin-top:4px';
 fila.innerHTML=
  '<label title="Level mapped to black (trims the background)">black <input type="range" id="fNegro" min="0" max="254" step="1" value="0"><output id="vNegro">0</output></label>'+
  '<label title="Level mapped to white (stretches the highs)">white <input type="range" id="fBlanco" min="1" max="255" step="1" value="255"><output id="vBlanco">255</output></label>'+
  '<label title="Automatic levels by percentile of the visible image: override black/white">auto <select id="fAuto"><option value="">—</option><option value="p1">p1–p99</option><option value="p2">p2–p98</option><option value="p5">p5–p95</option><option value="p10">p10–p90</option></select></label>'+
  '<canvas id="fxHist" width="256" height="36" title="Histogram of the visible image; marks = effective black/white" style="background:#0b1016;border:1px solid #344254;border-radius:4px"></canvas>'+
  '<span class="sep"></span>'+
  '<label title="Sigmoid: concentrates contrast around the centre (0 = off)">S-curve <input type="range" id="fCurva" min="0" max="24" step="0.5" value="0"><output id="vCurva">0.0</output></label>'+
  '<label title="S-curve centre (background level, 0–1)">centre <input type="range" id="fCentro" min="0.05" max="0.95" step="0.01" value="0.5"><output id="vCentro">0.50</output></label>'+
  '<label title="Quantizes to N levels (0 = off): plateaus and isolines">posterize <input type="range" id="fPoster" min="0" max="16" step="1" value="0"><output id="vPoster">0</output></label>'+
  '<span class="sep"></span>'+
  '<label title="Subtracts the smoothed background (sigma in px, 0 = off) and amplifies the residual: only the fine detail remains">high-pass <input type="range" id="fPasaalto" min="0" max="60" step="1" value="0"><output id="vPasaalto">0</output> px · gain <input type="range" id="fPasaGan" min="1" max="12" step="0.5" value="4"><output id="vPasaGan">4.0</output></label>'+
  '<label title="Difference of Gaussians sigma / 3·sigma: boosts structures the width of a stroke"><input type="checkbox" id="fDog"> band-pass <input type="range" id="fDogRadio" min="2" max="30" step="1" value="6"><output id="vDogRadio">6</output> px · gain <input type="range" id="fDogGan" min="1" max="8" step="0.5" value="3"><output id="vDogGan">3.0</output></label>'+
  '<label>edge <select id="fBorde"><option value="">—</option><option value="emboss">emboss</option><option value="lap">Laplacian</option><option value="sobel">sobel</option></select></label>'+
  '<span class="sep"></span>'+
  '<label title="Filter intensity: 100 = filtered only, 0 = raw">blend <input type="range" id="fMezcla" min="0" max="100" step="5" value="100"><output id="vMezcla">100</output>%</label>'+
  '<button id="fBlink" type="button" title="Alternates filtered / raw at 2.5 Hz: the eye detects what changes (key B)">blink</button>';
 P.append(fila);
 [['fNegro','negro','num'],['fBlanco','blanco','num'],['fAuto','auto','str'],['fCurva','curva','num'],['fCentro','centro','num'],['fPoster','poster','num'],
  ['fPasaalto','pasaalto','num'],['fPasaGan','pasaGan','num'],['fDog','dog','bool'],['fDogRadio','dogRadio','num'],['fDogGan','dogGan','num'],['fBorde','borde','str'],['fMezcla','mezcla','num']].forEach(x=>FXCTL.push(x));
 [['vNegro','negro',0],['vBlanco','blanco',0],['vCurva','curva',1],['vCentro','centro',2],['vPoster','poster',0],['vPasaalto','pasaalto',0],['vPasaGan','pasaGan',1],['vDogRadio','dogRadio',0],['vDogGan','dogGan',1],['vMezcla','mezcla',0]].forEach(x=>FXOUT.push(x));
 const refrescar=()=>{fxGuardar();fxAUI();fxPedir();if(PANES&&PANES.length){defsPanes();pintarPanes()}fxPintarPresets()};
 FXCTL.slice(-13).forEach(([id,k,t])=>{const e=$(id),ev=t==='num'?'oninput':'onchange';
  e[ev]=ev2=>{FX[k]=t==='bool'?(ev2.target.checked?1:0):(t==='str'?ev2.target.value:+ev2.target.value);refrescar()}});
 /* el checkbox de DoG guarda 0/1 en FX.dog */
 const fxAUI0=window.fxAUI;
 window.fxAUI=function(){FXCTL.forEach(([id,k,t])=>{const e=$(id);if(!e)return;if(t==='bool')e.checked=!!(+FX[k]||FX[k]===true);else e.value=FX[k]});
  FXOUT.forEach(([id,k,d])=>{const e=$(id);if(e)e.textContent=(+FX[k]).toFixed(d)});
  $('filtros').hidden=!FX.abierto;$('filtrosBtn').classList.toggle('active',FX.abierto);
  $('filtrosBtn').setAttribute('aria-pressed',String(FX.abierto));$('filtrosBtn').setAttribute('aria-expanded',String(FX.abierto));
  const n=FXCLAVES.filter(k=>{const q=FXDEF[k];return typeof q==='boolean'?!!FX[k]!==q:(typeof q==='number'?+FX[k]!==q:FX[k]!==q)}).length;
  $('filtrosBtn').textContent=n?'Filters ('+n+')':'Filters';pintarHist()};
 function pintarHist(){const c=$('fxHist');if(!c)return;const g=c.getContext('2d');g.clearRect(0,0,256,36);
  const H=fxHist();if(!H)return;let mx=0;for(let v=1;v<255;v++)mx=Math.max(mx,H[v]);if(!mx)return;
  g.fillStyle='#4f8b86';for(let v=0;v<256;v++){const y=Math.min(1,Math.log1p(H[v])/Math.log1p(mx))*34;g.fillRect(v,36-y,1,y)}
  const[lo,hi]=niveles(FX);g.fillStyle='#ffb347';g.fillRect(Math.round(lo*255),0,1,36);g.fillRect(Math.round(hi*255),0,1,36)}
 /* ---- parpadeo ---- */
 let blink=0;const st=document.createElement('style');st.textContent='.parpadeo #stage img,.parpadeo .pane img{filter:none!important}';document.head.append(st);
 const togglBlink=()=>{if(blink){clearInterval(blink);blink=0;document.body.classList.remove('blink');$('fBlink').classList.remove('active');return}
  $('fBlink').classList.add('active');blink=setInterval(()=>document.body.classList.toggle('blink'),200)};
 $('fBlink').onclick=togglBlink;
 document.addEventListener('keydown',e=>{if(e.key==='b'&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))togglBlink()});
 /* ---- presets, agrupados ---- */
 const GRUPOS=[
  ['Basics',[
   {t:'Raw',d:'Everything neutral: the map as it came out of the model. The honest starting point.',fx:{}},
   {t:'Auto levels',d:'Stretches p2–p98 of the visible image to black–white. The first thing to do: the map uses a fraction of the range.',fx:{auto:'p2'}},
   {t:'Soft boost',d:'Gamma 1.6 and a touch of contrast over auto levels. For sweeping a whole lamina.',fx:{auto:'p2',gamma:1.6,contraste:1.2,brillo:1.05}}]],
  ['Contrast',[
   {t:'S-curve',d:'Sigmoid k=8 centred on the background level, over p2–p98 levels. Concentrates contrast where faint ink lives without burning the extremes.',fx:{auto:'p2',curva:8,centro:0.5}},
   {t:'High contrast',d:'Hard contrast and low gamma. To confirm a shape already seen, not to discover it.',fx:{contraste:2.2,gamma:0.85}},
   {t:'Threshold',d:'Binarizes at 140. One question only: is the stroke continuous or scattered blobs?',fx:{umbralOn:true,umbral:140}},
   {t:'Soft threshold',d:'Very steep sigmoid (k=20): almost binary but with a graded edge; shows how sure the model is near the cut.',fx:{curva:20,centro:0.55}}]],
  ['Stroke (frequency)',[
   {t:'Fine stroke',d:'Unsharp mask, radius 8. Separates the stroke from the background when ink is faint; also boosts the render weave.',fx:{local:1.6,radio:8,contraste:1.3}},
   {t:'High-pass',d:'Subtracts the smoothed background (σ 20 px) and amplifies the residual: removes the slow render illumination and keeps only the fine detail.',fx:{pasaalto:20,pasaGan:6,negro:96,blanco:160}},
   {t:'Stroke band-pass',d:'Difference of Gaussians σ6/σ18, tuned to a stroke width (25–45 px at 8.64 µm). Anything not that size disappears.',fx:{dog:1,dogRadio:6,dogGan:6,negro:96,blanco:160}},
   {t:'Emboss',d:'Turns edges into shading. Good for seeing whether a blob has a defined outline.',fx:{borde:'emboss'}},
   {t:'Laplacian',d:'Second derivative: edges only. Letters show as double outlines; noise as grain.',fx:{borde:'lap',contraste:1.6}}]],
  ['False color',[
   {t:'Viridis',d:'Perceptually uniform: colour jumps = real intensity jumps.',fx:{paleta:'viridis',gamma:1.2}},
   {t:'Inferno',d:'More range in the highs: makes the maxima pop over a muted background.',fx:{paleta:'inferno',contraste:1.4}},
   {t:'Magma',d:'Like inferno but softer in the mids, over auto levels.',fx:{paleta:'magma',auto:'p2'}},
   {t:'Turbo',d:'High-contrast rainbow: maximum tone separation; not uniform, exploration only.',fx:{paleta:'turbo',auto:'p2'}},
   {t:'Diverging',d:'Blue = below the centre, red = above, white = background (p5–p95). Shows what sits above and below the background.',fx:{paleta:'diverge',auto:'p5'}},
   {t:'Isolines',d:'6 levels + Laplacian: contour lines of the map. A letter gives nested closed contours.',fx:{poster:6,borde:'lap',contraste:2}}]],
  ['Other',[
   {t:'Inverted',d:'Dark ink on light: how the eye reads.',fx:{invertir:true,gamma:1.3}},
   {t:'Inverted high-pass',d:'High-pass + inverted: dark strokes on a flat light background, closest to reading paper.',fx:{invertir:true,pasaalto:20,pasaGan:6,negro:96,blanco:160}}]]];
 FXPRESETS.length=0;GRUPOS.forEach(([g,ps])=>ps.forEach(p=>{p.g=g;FXPRESETS.push(p)}));
 window.fxPintarPresets=function(){const c=$('fxPresets');if(!c)return;c.innerHTML='';c.removeAttribute('style');
  let g0='',section=null;FXPRESETS.forEach(p=>{
   if(p.g!==g0){g0=p.g;section=document.createElement('div');section.className='fxPresetGroup';const heading=document.createElement('h4');heading.textContent=g0;section.append(heading);c.append(section)}
   const b=document.createElement('button');b.textContent=p.t;b.title=p.d;
   if(fxPresetActivo(p))b.classList.add('on');
   b.onclick=()=>{const ab=FX.abierto;const fx=Object.assign({},FX,p.fx,{abierto:ab});
    if(PANES&&PANES.length){fxObjetivos().forEach(i=>{PANES[i].fx=Object.assign({},PANES[i].fx,p.fx)});FX=Object.assign({},fx);fxGuardar();fxAUI();fxPedir();defsPanes();pintarPanes()}
    else{FX=fx;fxGuardar();fxAUI();fxPedir()}
    fxPintarPresets()};
   section.append(b)})};
 (globalThis.visorFetchData || fetch)('alias_presets.json',{cache:'no-store'}).then(r=>r.ok?r.json():{}).then(d=>{window.PRESET_ALIAS=d}).catch(()=>{});
 window.fxArmarFiltro=armarFiltro; window.fxNiveles=niveles; window.fxLutPro=lutPro;   /* para super_mosaico.js */
 /* ---- low-friction additions: advanced rows collapsed, named favourites (FX + panes), pane hover toolbar ---- */
 (function(){
  const FAVKEY='vesuvius.filtros.favoritos.v1';let FAV={};try{FAV=JSON.parse(localStorage.getItem(FAVKEY)||'{}')}catch(e){}
  const bar=document.createElement('div');bar.id='fxBar';bar.style.cssText='display:flex;gap:8px;align-items:center;width:100%;margin:2px 0';
  bar.innerHTML='<span>Favourites</span><span id="fxFavs"></span><button id="fxFavSave" type="button" title="Save the current global adjustments + panes under a name">Save setup…</button>';
  $('filtros').append(bar);
  const pintarFav=()=>{const c=$('fxFavs');c.innerHTML='';Object.keys(FAV).sort().forEach(n=>{const b=document.createElement('button');b.type='button';b.textContent=n;b.title='click: apply · shift+click: delete';
   b.onclick=e=>{if(e.shiftKey){delete FAV[n];localStorage.setItem(FAVKEY,JSON.stringify(FAV));pintarFav();return}
    const f=FAV[n];FX=Object.assign({},FXDEF,f.fx,{abierto:FX.abierto});PANES=(f.panes||[]).map(p=>({t:p.t,fx:Object.assign({},FXDEF,p.fx)}));fxGuardar();fxAUI();fxPedir();defsPanes();pintarPanes();fxPintarPresets();if(typeof fit==='function')fit()};c.append(b)})};
  $('fxFavSave').onclick=()=>{const n=prompt('Name for this filter setup (global adjustments + panes):');if(!n)return;FAV[n]={fx:Object.assign({},FX),panes:PANES.map(p=>({t:p.t,fx:p.fx}))};localStorage.setItem(FAVKEY,JSON.stringify(FAV));pintarFav()};
  pintarFav();
  /* pane toolbar on hover: remove / make main */
  const css=document.createElement('style');css.textContent='.pane .tb{position:absolute;right:6px;bottom:6px;display:none;gap:4px;z-index:4}.pane:hover .tb{display:flex}.pane .tb button{font:11px ui-monospace,monospace;background:#0b1016cc;color:#c9d6e2;border:1px solid #344254;border-radius:4px;padding:1px 6px;cursor:pointer}';document.head.append(css);
  const pintarPanes0=window.pintarPanes;
  window.pintarPanes=function(){pintarPanes0.apply(this,arguments);document.querySelectorAll('#panes .pane').forEach((d,i)=>{if(d.querySelector('.tb'))return;const tb=document.createElement('div');tb.className='tb';
   const bm=document.createElement('button');bm.textContent='main';bm.title='Keep only this pane';bm.onclick=e=>{e.stopPropagation();PANES=[PANES[i]];defsPanes();pintarPanes();fxPintarPresets();fit()};
   const bx=document.createElement('button');bx.textContent='×';bx.title='Remove this pane';bx.onclick=e=>{e.stopPropagation();PANES.splice(i,1);defsPanes();pintarPanes();fxPintarPresets();fit()};
   tb.append(bm,bx);d.append(tb)})};
 })();
 /* ---- zoom en modo cuadrantes: el ancla del zoom (rueda o botones +/-) llegaba en coordenadas del
    viewport entero, pero x,y son relativas a UN cuadrante (fit() encuadra en cajaUtil): con zoom la imagen
    se iba fuera del cuadrante y los 4 quedaban negros. Se convierte el ancla al cuadrante bajo el cursor. */
 const scaleTo0=window.scaleTo;
 window.scaleTo=function(z,cx,cy){
  if(PANES&&PANES.length){const[w,h]=cajaUtil(),W=vp.clientWidth,H=vp.clientHeight,n=PANES.length;
   if(cx==null||cy==null){cx=w/2;cy=h/2}
   else if(typeof window.aPanel==='function')[cx,cy]=window.aPanel(cx,cy);   /* 25-sep: corte arrastrable entre columnas de mapas (index.html) */
   else{const abajo=n>=3&&cy>=H/2,der=(n===2||n===4||(n===3&&!abajo))&&cx>=W/2;
    cx-=der?W/2:0;cy-=abajo?H/2:0}}
  return scaleTo0(z,cx,cy)};
 /* ---- arranque: reconstruir con la cadena nueva ---- */
 new MutationObserver(()=>{HIST.src='';pintarHist()}).observe(im,{attributes:true,attributeFilter:['src']});
 im.addEventListener('load',()=>{HIST.src='';if(FX.auto||PANES.some(p=>p.fx.auto)){fxPedir();if(PANES.length){defsPanes()}}pintarHist()});
 /* el deep link (&paneles=) se aplico antes de que existieran los presets nuevos: re-resolverlo */
 try{const u0=((performance.getEntriesByType('navigation')[0]||{}).name)||location.href;   /* el visor ya reescribio el hash: usar la URL con la que se llego */
  const pv=new URLSearchParams((u0.split('#')[1]||'')).get('paneles');
  if(pv){const q=decodeURIComponent(pv).split(',').map(t=>t.trim()).filter(Boolean).slice(0,4);
   const AL=(window.PRESET_ALIAS||{});const nuevos=q.map(t=>{t=AL[t]||t;const d=FXPRESETS.find(z=>z.t.toLowerCase()===t.toLowerCase());return d?{t:d.t,fx:Object.assign({},FXDEF,d.fx)}:null}).filter(Boolean);
   if(nuevos.length>PANES.length)PANES=nuevos}}catch(e){}
 fxAUI();fxPintarPresets();if(PANES&&PANES.length){defsPanes();pintarPanes();if(typeof fit==='function')fit()}fxPedir();
 console.log('filtros_pro: activo, '+FXPRESETS.length+' presets');
})();

;
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
  return V}
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
  gridObserver=new ResizeObserver(()=>{menuEl?.remove();menuEl=null;columnas();pedir()});gridObserver.observe(grid);
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
 function cerrar(){if(!ov)return;gridObserver?.disconnect();gridObserver=null;menuEl?.remove();menuEl=null;ov.remove();ov=grid=defs=null;$('superCss')&&$('superCss').remove();document.removeEventListener('keydown',tecla);cancelAnimationFrame(raf);raf=0;zDefs=-1}
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
 /* doble clic: esa configuracion como vista principal (unico cuadrante) */
 function principal(i){const p=paneDe(i);if(!p)return;PANES=[p];terminar('main view: '+p.t)}
 /* Split view: se AGREGA a los cuadrantes que ya estan (hasta 4; lleno reemplaza el ultimo) */
 function llevar(i){const p=paneDe(i);if(!p)return;const j=PANES.findIndex(q=>q.t===p.t);if(j<0){if(PANES.length<4)PANES.push(p);else PANES[3]=p}terminar('split view: '+p.t)}
 let menuEl=null;
 function menu(px,py,i){if(menuEl)menuEl.remove();menuEl=document.createElement('div');menuEl.style.cssText='position:fixed;z-index:10001;left:'+px+'px;top:'+py+'px;background:var(--grilli-panel,#0b1016);border:1px solid var(--grilli-control-border,#344254);border-radius:4px;padding:4px;font:12px var(--grilli-font,ui-monospace);color:var(--grilli-text,#c9d6e2);box-shadow:0 4px 18px #000a';
  [['Split view (add to the viewer)',()=>llevar(i)],['Set as main view',()=>principal(i)],['Cancel',()=>{}]].forEach(([t,f])=>{const b=document.createElement('div');b.textContent=t;b.style.cssText='padding:5px 12px;cursor:pointer;border-radius:4px';
   b.onmouseenter=()=>b.style.background='var(--grilli-raised,#1e2a38)';b.onmouseleave=()=>b.style.background='';b.onclick=ev=>{ev.stopPropagation();menuEl.remove();menuEl=null;f()};menuEl.append(b)});
  menuEl.id='superMenu';document.body.append(menuEl);
  const bounds=menuEl.getBoundingClientRect();menuEl.style.left=Math.max(8,Math.min(px,innerWidth-bounds.width-8))+'px';menuEl.style.top=Math.max(8,Math.min(py,innerHeight-bounds.height-8))+'px';setTimeout(()=>document.addEventListener('pointerdown',()=>{menuEl&&menuEl.remove();menuEl=null},{once:true}),0)}
 /* ---- boton y tecla ---- */
 const b=document.createElement('button');b.id='superBtn';b.textContent='Super';b.title='Mosaic of ~100 filters at once over the region you are looking at (key M)';
 b.onclick=abrir;const fb=$('filtrosBtn');fb&&fb.after(b);
 document.addEventListener('keydown',e=>{if(e.key==='m'&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))abrir()});
 window.superAbrir=abrir;
 window.superDebug=()=>({ov:!!ov,defs:!!defs,grid:!!grid,imgC:imgC&&imgC.naturalWidth,imgM:imgM&&(imgM.width||imgM.naturalWidth),maxp:{id:MAXP.id,listo:MAXP.listo,canvas:!!MAXP.canvas},z,cx,cy,prof,V:V.length,zDefs});
 window.superDibujar=()=>{try{dibujar();return 'ok'}catch(e){return e.stack}};
})();

;
/* ===== depth preload + real depth merge (12-Sep-2026) =====
   In HD mode only the current depth and two neighbours are prefetched into memory. And "Merge depths" becomes a
   real per-pixel maximum over ALL centres, computed in the browser (canvas, 'lighten' composite): for
   laminae loaded from S3 the manifest's `maximum` pointed at centre 0, not at a projection. */
(function(){
 if(typeof group==='undefined'||typeof im==='undefined'){console.warn('precarga: viewer globals missing');return}
 // In-memory only. Never alter the proxy's persistent cache.
 const IM=new Map(),MAXP=new Map();
 const urlDe=dir=>dir?new URL(mapUrl(dir,$('contrast').value),location.href).href:null;
 function img(url){let g=IM.get(url);if(g)IM.delete(url);else{g=new Image();g.crossOrigin='anonymous';g.decoding='async';g.src=url}IM.set(url,g);
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

;
/* Cuando una imagen no carga, el visor dejaba la anterior en pantalla y solo ponia
   'load failed' en letra chica: se confunde con un mapa real. Esto tapa el area con
   un cartel inequivoco y el URL que fallo. ponytail: overlay unico, sin estado extra. */
(function(){
  const $=id=>document.getElementById(id);
  const im=$('map')||$('im'), stage=$('stage')||(im&&im.parentElement);
  if(!im||!stage)return;
  const cap=document.createElement('div');
  cap.id='falloCarga'; cap.hidden=true;
  cap.style.cssText='position:absolute;inset:0;display:none;flex-direction:column;align-items:center;'+
    'justify-content:center;gap:10px;background:#1a0d10;color:#ff9aa4;z-index:40;'+
    'font:600 20px ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px;pointer-events:none';
  cap.innerHTML="<div style=\"font-size:38px\">⚠︎</div><div id=\"falloQue\">Could not load the image</div>"+
    '<div id="falloUrl" style="font:400 12px ui-monospace,monospace;color:#c98c93;word-break:break-all;max-width:80%"></div>';
  if(getComputedStyle(stage).position==='static')stage.style.position='relative';
  stage.appendChild(cap);
  const mostrar=u=>{ $('falloUrl').textContent=u||''; cap.hidden=false;cap.style.display='flex';
    im.style.visibility='hidden';
    document.querySelectorAll('.pane img, #lowres').forEach(g=>g.style.visibility='hidden'); };
  const ocultar=()=>{ cap.hidden=true;cap.style.display='none'; };
  const previa=u=>/_lo8?\.jpg(\?|$)/.test(u||'');   /* la vista previa .jpg puede faltar a proposito: no es un fallo */
  im.addEventListener('error',()=>{const u=im.currentSrc||im.src; if(!previa(u))mostrar(u)});
  im.addEventListener('load',ocultar);
  // paneles: cada <img> de .pane avisa por su cuenta
  new MutationObserver(ms=>{ for(const m of ms) for(const n of m.addedNodes){
      if(n.tagName==='IMG'&&n.closest('.pane')){ n.addEventListener('error',()=>{const u=n.currentSrc||n.src; if(!previa(u))mostrar(u)}); n.addEventListener('load',ocultar); } } })
    .observe(document.body,{childList:true,subtree:true});
  window.falloCargaVisible=()=>!cap.hidden;
})();

;
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

;
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

;
/* ===== v5 per-depth bar under the depth slider (12-Sep-2026) =====
   Informational only: one cell per depth centre, coloured by the lamina's v5 legibility at that depth
   (legibilidad.json por_centro; max over faces). White outline = the depth being viewed. */
(function(){
 const $=id=>document.getElementById(id);const wrap=$('depthWrap'),sl=$('depth'),im=$('map');
 if(!wrap||!sl||!im||typeof LEG==='undefined'){console.warn('hist_v5: viewer globals missing');return}
 const st=document.createElement('style');st.textContent='#depthWrap{display:flex;flex-direction:column;gap:3px}#v5hist{display:flex;gap:1px;height:8px;cursor:default}#v5hist i{flex:1;border-radius:1px;background:#182230}#v5hist i.cur{outline:1px solid #fff;outline-offset:-1px}';
 document.head.append(st);
 const bar=document.createElement('div');bar.id='v5hist';bar.title='v5 legibility per depth (informational, not clickable)';wrap.append(bar);
 const lamOf=id=>id.replace(/__base\d+$/,'').replace(/__(fwd|rev)$/,'');
 const mix=(p,q,k)=>p.map((v,i)=>Math.round(v+(q[i]-v)*k));
 const col=s=>{if(s==null)return '#182230';const t=Math.max(0,Math.min(1,s/0.6));const a=[16,35,58],b=[31,138,112],c=[255,209,102];const r=t<.5?mix(a,b,t*2):mix(b,c,(t-.5)*2);return 'rgb('+r.join(',')+')'};
 function pintar(){if(typeof group==='undefined'||!group)return;
  const name=group.catalogMeta?.lam||lamOf(group.id);
  const record=LEG[group.scroll+'/'+name]||LEG[name]||{};
  const score=group.catalogMeta?record.por_modelo?.[group.catalogMeta.modelo]:record;
  const pc={...(score?.por_centro||{})},centre=score?.mejor_centro;
  if(centre!=null&&centre!==''&&Number.isInteger(+centre)&&Number.isFinite(score?.max)){
   const key=(+centre<0?'-':'+')+String(Math.abs(+centre)).padStart(2,'0');
   if(!(key in pc))pc[key]=score.max;
  }
  const cur=+sl.value;bar.innerHTML='';
  for(const c of Object.keys(group.frames).map(Number).sort((a,b)=>a-b)){   /* the lamina's real centres (some step by 2) */const k=(c<0?'-':'+')+String(Math.abs(c)).padStart(2,'0');const s=pc[k];const i=document.createElement('i');i.style.background=col(s);
   i.title='c'+(c>0?'+':'')+c+(s!=null?' · v5 '+(+s).toFixed(3):' · no score');if(c===cur)i.classList.add('cur');bar.append(i)}}
 window.v5HistRepintar=pintar;
 new MutationObserver(pintar).observe(im,{attributes:true,attributeFilter:['src']});sl.addEventListener('input',pintar);pintar();
})();

;
/* ===== loading spinners with a seconds counter (14-sep-2026) =====
   One big spinner over the viewport while the main image loads, and one per pane in the model
   mosaic, each with the elapsed seconds in the middle. Hooks the existing signals only: the
   'Loading image…' notice + the <img> load/error events of the stage and of every pane. */
(function(){
 const st=document.createElement('style');st.textContent=
  '.spin[hidden]{display:none!important}.spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}'+
  '.spin .ring{position:relative;width:96px;height:96px;border-radius:50%;border:6px solid #2b3a4b;border-top-color:#64ddd1;animation:spin 1s linear infinite;box-shadow:0 0 0 6px #090e14aa}'+
  '.spin .sec{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 22px ui-monospace,monospace;color:#bff5f0;text-shadow:0 0 6px #000}'+
  '.spin.chico .ring{width:64px;height:64px;border-width:5px}.spin.chico .sec{font-size:16px}'+
  '@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin .ring{animation-duration:3s}}';
 document.head.append(st);
 function crear(host,chico,img){const d=document.createElement('div');d.className='spin'+(chico?' chico':'');d.hidden=true;
  const r=document.createElement('div');r.className='ring';const s=document.createElement('div');s.className='sec';s.textContent='0 s';d.append(r,s);host.append(d);
  let t0=0,timer=null;
  const listo=()=>img?(!img.getAttribute('src')||(img.complete&&img.naturalWidth>0)):false;   // no img: the caller decides
  const off=()=>{if(d.hidden)return;clearInterval(timer);timer=null;d.hidden=true};
  const on=()=>{if(listo())return off();if(!d.hidden)return;t0=performance.now();d.hidden=false;s.textContent='0 s';
   timer=setInterval(()=>{if(listo())return off();s.textContent=Math.round((performance.now()-t0)/1000)+' s'},250)};
  if(img){img.addEventListener('load',off);img.addEventListener('error',off);
   new MutationObserver(()=>{listo()?off():on()}).observe(img,{attributes:true,attributeFilter:['src']})}
  return{on,off,el:d}}
 /* main image: the viewer writes 'Loading image…' into #notice and clears it on load */
 const vp=document.getElementById('viewport'),notice=document.getElementById('notice'),im=document.getElementById('map')||document.querySelector('#stage img');
 if(vp&&notice){
  /* the main image keeps its old src while a hidden loader downloads the new one, so the <img>
     never looks "loading": the viewer's own 'Loading…' notice is the signal. Self-healing: the
     tick turns it off as soon as the notice no longer says loading, or in the mosaic. */
  const S=crear(vp,false,null);
  const enMosaico=()=>typeof PANES!=='undefined'&&PANES&&PANES.length>1;
  /* the viewer hides the notice on load but leaves its text as 'Loading image…' (and when the new
     src equals the old one the <img> fires no load event at all): a hidden notice is never 'loading' */
  const cargando=()=>!notice.hidden&&/loading/i.test(notice.textContent)&&!enMosaico();
  new MutationObserver(()=>{cargando()?S.on():S.off()}).observe(notice,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  /* a new image landing on the stage ends the wait no matter what the notice says: the preview
     fallback path of the viewer can leave 'Loading image…' behind when the _lo previews are missing */
  if(im){im.addEventListener('load',()=>{S.off();if(/loading/i.test(notice.textContent))notice.textContent=''})}
  setInterval(()=>{if(!cargando())S.off()},300)}
 /* panes: each <img> gets its own spinner, started when its src changes and it is not complete yet */
 const panes=document.getElementById('panes');
 if(panes){const vistos=new WeakMap();
  function armar(g){if(vistos.has(g))return;vistos.set(g,crear(g.parentElement,true,g))}
  new MutationObserver(()=>panes.querySelectorAll('.pane img').forEach(armar)).observe(panes,{childList:true,subtree:true});
  panes.querySelectorAll('.pane img').forEach(armar)}
})();

;
/* ===== Label extras (12-Sep-2026): user-chosen display colours for ink / no-ink =====
   The stored mask keeps its encoding (green = ink, red = no ink; etiquetar.js classifies by G > R), so the colour
   choice is DISPLAY ONLY: an SVG feColorMatrix maps the two stored colours to the two chosen ones on #mask and on
   the per-pane mirrors. Persisted in localStorage. */
(function(){
 const $=id=>document.getElementById(id);const KEY='vesuvius.etiq.colores';const G=[60,220,90],R=[230,60,60];   // stored colours (COLOR in etiquetar.js)
 let C={tinta:'#3cdc5a',no:'#e63c3c'};try{Object.assign(C,JSON.parse(localStorage.getItem(KEY)||'{}'))}catch(e){}
 const NS='http://www.w3.org/2000/svg';const svg=document.querySelector('svg[aria-hidden]')||document.querySelector('svg');
 const f=document.createElementNS(NS,'filter');f.id='maskRecolor';f.setAttribute('color-interpolation-filters','sRGB');const cm=document.createElementNS(NS,'feColorMatrix');cm.setAttribute('type','matrix');f.append(cm);
 (svg.querySelector('defs')||svg).append(f);
 const st=document.createElement('style');st.textContent='#panel .fila{display:flex;flex-wrap:wrap;gap:4px}#panel .fila button{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;padding:4px 6px}#panel .capaRow span{min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}#mask,.pane .pm{filter:url(#maskRecolor)}#etiqColores{display:flex;gap:10px;align-items:center;margin:4px 0}#etiqColores input{width:28px;height:22px;padding:0;border:1px solid #344254;background:#0b1016}';document.head.append(st);
 const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
 function matriz(){const A=hex(C.tinta),B=hex(C.no);const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];const gg=dot(G,G),gr=dot(G,R),rr=dot(R,R),det=gg*rr-gr*gr;
  // u,v in span{G,R}: u·G=1,u·R=0 ; v·G=0,v·R=1  -> M = A u^T + B v^T maps G->A, R->B
  const u=[0,1,2].map(i=>(rr*G[i]-gr*R[i])/det),v=[0,1,2].map(i=>(-gr*G[i]+gg*R[i])/det);
  const M=[0,1,2].map(i=>[0,1,2].map(j=>A[i]*u[j]+B[i]*v[j]));
  cm.setAttribute('values',M.map(r=>r.map(x=>x.toFixed(4)).join(' ')+' 0 0').join(' ')+' 0 0 0 1 0');
  const bt=$('mTinta'),bn=$('mNo');if(bt)bt.style.background=C.tinta;if(bn)bn.style.background=C.no;if(bt)bt.style.color='#000';if(bn)bn.style.color='#000'}
 const fila=document.createElement('div');fila.id='etiqColores';fila.innerHTML='<span style="opacity:.6;font-size:11px">colours</span> <label title="Display colour for ink">ink <input type="color" id="colTinta"></label> <label title="Display colour for no-ink">no ink <input type="color" id="colNo"></label> <button id="colReset" title="Back to green / red">↺</button>';
 const ancla=$('mTinta')&&$('mTinta').closest('.fila');if(ancla)ancla.after(fila);else ($('panel')||document.body).append(fila);
 $('colTinta').value=C.tinta;$('colNo').value=C.no;
 const guardar=()=>{localStorage.setItem(KEY,JSON.stringify(C));matriz()};
 $('colTinta').oninput=e=>{C.tinta=e.target.value;guardar()};$('colNo').oninput=e=>{C.no=e.target.value;guardar()};
 $('colReset').onclick=()=>{C={tinta:'#3cdc5a',no:'#e63c3c'};$('colTinta').value=C.tinta;$('colNo').value=C.no;guardar()};
 matriz();
 /* masks made before 12-sep were keyed by sheet only; the working key is now sheet|c<N>. If the new key has nothing,
    fall back to the old per-sheet mask (once per depth, it is then saved under the new key). */
 if(typeof restaurar==='function'){const restaurar0=restaurar;
  /* guarded restore: a slow IndexedDB read from a depth you already left must never draw on the next depth's canvas */
  restaurar=async function(nombre){if(await canonicalMaskMode())return;const destino=destinoMascara();const b0=await idb('readonly',s=>s.get(nombre),destino.database).catch(()=>null);if(!destinoVigente(destino)||H.nombre!==nombre)return;
   const dibujarLocal=async b=>{const bm=await createImageBitmap(b);try{if(!destinoVigente(destino)||!mascaraVacia())return false;
    if(bm.width!==destino.w||bm.height!==destino.h){msg('Stored mask dimensions differ: nothing restored');return false}mctx.drawImage(bm,0,0);dirty=true;return true}finally{if(bm.close)bm.close()}};
   if(b0)await dibujarLocal(b0);
   if(!destinoVigente(destino))return;
   if(!mascaraVacia())return;
   /* 15-sep: a mask painted on a model view whose gallery was not yet recognised as this sheet (e.g. *_r7j_t before the regex
      change) was saved under the gallery id: try those keys and migrate the first hit to the sheet key */
   if(typeof window.clavesLegado==='function'){for(const k of window.clavesLegado(nombre)){const bk=await idb('readonly',s=>s.get(k),destino.database).catch(()=>null);if(!bk)continue;if(!H||H.nombre!==nombre)return;
     if(!await dibujarLocal(bk))return;pendiente=true;if(typeof autoguardar==='function')autoguardar();
     if(typeof msg==='function')msg('mask recovered from '+k+' (saved again under this sheet)');return}}
   const viejo=nombre.replace(/\|c[^|]*$/,'');if(viejo===nombre)return;
   const b=await idb('readonly',s=>s.get(viejo),destino.database).catch(()=>null);if(!b||!H||H.nombre!==nombre)return;
   if(!await dibujarLocal(b))return;pendiente=true;if(typeof autoguardar==='function')autoguardar();if(typeof espejarMascara==='function')espejarMascara();
   await idb('readwrite',s=>s.delete(viejo),destino.database).catch(()=>{});   /* one-time migration: the old per-sheet mask now lives ONLY at this depth */
   if(typeof msg==='function')msg('mask restored from the per-sheet label ('+viejo+') into this depth')}}
/* ===== PERF (12-sep): the label core copied the WHOLE 20-Mpx mask on every stroke start (getImageData 80 MB),
    counted every pixel after every stroke, and the viewer PNG-encoded the mask into localStorage. Replaced by
    GPU copies (drawImage) and 1/4-scale counts. Same behaviour, ~10x less main-thread time. ===== */
 let prevC=null,cntC=null;
 const lienzo=(ref,w,h)=>{if(!ref||ref.width!==w||ref.height!==h){ref=document.createElement('canvas');ref.width=w;ref.height=h}return ref};
 if(typeof prepararUndo==='function'){
  prepararUndo=function(){if(!mctx)return;prevC=lienzo(prevC,mask.width,mask.height);const g=prevC.getContext('2d',{willReadFrequently:true});g.clearRect(0,0,mask.width,mask.height);g.drawImage(mask,0,0);previo=true};
  guardarUndo=function(){if(!previo||!bbox)return;const b=[Math.max(0,bbox[0]),Math.max(0,bbox[1]),Math.min(H.w,bbox[2]),Math.min(H.h,bbox[3])];const w=b[2]-b[0],h=b[3]-b[1];
   if(w<=0||h<=0){previo=null;return}const antes=prevC.getContext('2d',{willReadFrequently:true}).getImageData(b[0],b[1],w,h);undoS.push({b,antes});if(undoS.length>20)undoS.shift();previo=null};
  contar=function(){clearTimeout(tCont);tCont=setTimeout(()=>{const el=document.querySelector('#stats');if(!el||!H||!mctx)return;const f=4,w=Math.ceil(H.w/f),h=Math.ceil(H.h/f);cntC=lienzo(cntC,w,h);
   const g=cntC.getContext('2d',{willReadFrequently:true});g.clearRect(0,0,w,h);g.drawImage(mask,0,0,w,h);const d=g.getImageData(0,0,w,h).data;let t=0,n=0;
   for(let i=0;i<d.length;i+=4){if(d[i+3]<128)continue;d[i+1]>d[i]?t++:n++}t*=f*f;n*=f*f;const cm2=p=>H.um_px?'  '+(p*(H.um_px*1e-4)**2).toFixed(3)+' cm2':'';
   el.textContent=`${H.nombre}  ${H.w}x${H.h}\nink     ~${t.toLocaleString()} px${cm2(t)}\nno ink   ~${n.toLocaleString()} px${cm2(n)}\nunlabelled ~${(H.w*H.h-t-n).toLocaleString()} px`},600)}}
 window.mascaraVacia=function(){if(!mctx||!mask.width)return true;const w=64,h=64;cntC=lienzo(cntC,w,h);const g=cntC.getContext('2d',{willReadFrequently:true});g.clearRect(0,0,w,h);g.drawImage(mask,0,0,w,h);const d=g.getImageData(0,0,w,h).data;for(let i=3;i<d.length;i+=4)if(d[i]>0)return false;return true};
/* ===== import a PROPOSED mask (tutorial 5: predictions -> conservative labels -> human edit) for the current depth ===== */
 if (window.VISOR_STATIC) return;
 const bi=document.createElement('button');bi.id='impProp';bi.textContent='import proposal';bi.title='Load the automatic proposal for this lamina and depth from the selected source: ink where strokes are repeatable, no-ink on clean background. Then edit with the brush and save.';
 bi.onclick=async()=>{const destino=destinoMascara();if(!destino||!mascaraLista()){msg('Wait for the full-resolution image and mask');return}
  const lam=destino.grupo?(typeof meta==='function'?meta(destino.grupo).lam:destino.grupo.id):null;const seg=(typeof segId==='function')?segId(lam):lam;const cen=(destino.nombre.match(/\|c(.+)$/)||[])[1];
  const c=cen==='max'?'cmax':('c'+(cen>=0?'+':'-')+String(Math.abs(+cen)).padStart(2,'0'));bi.disabled=true;bi.textContent='loading...';
  try{const ruta=typeof segRuta==='function'&&destino.grupo?segRuta(destino.grupo):null;
   const par=await obtenerParMascara(seg,cen,ruta&&ruta.base,true);
   const out=await leerParMascara(par.blobs,destino.w,destino.h);
   if(!destinoVigente(destino))throw new Error('mask changed during loading');
   if(!await confirmarMetadatosMascara(par.blobs,destino.info,'Proposal import'))return;
   if(!destinoVigente(destino))throw new Error('mask changed during loading');
   conservarEdiciones(out,destino.ctx.getImageData(0,0,destino.w,destino.h));
   if(reemplazarMascara(out,destino))msg('proposal imported for '+c+' (all existing ink and non-ink strokes kept; Ctrl+Z undoes)')}
  catch(e){msg('no proposal for this depth ('+String(e).slice(0,60)+')');bi.textContent='no proposal for this depth';setTimeout(()=>{bi.textContent='import proposal'},3000)}finally{bi.disabled=false}};
 const anc=$('mTinta')&&$('mTinta').closest('.fila');if(anc)anc.after(bi);
 /* PROPS_ETIQ: which laminae have proposals; the button says so instead of silently doing nothing */
 let PROPS_E=new Set();const refrescarProp=()=>{const lam=(typeof group!=='undefined'&&group)?(typeof meta==='function'?meta(group).lam:group.id):null;const seg=lam&&(typeof segId==='function')?segId(lam):lam;
  const hay=seg&&(PROPS_E.has(seg)||PROPS_E.has(lam));bi.disabled=!hay;bi.textContent=hay?'import proposal':'no proposal for this lamina';bi.title=hay?'Load the automatic proposal for this depth (ink where strokes are repeatable, no-ink on clean background), then edit and save.':'Proposals exist only for laminae marked 📋 in the explorer'};
 fetch('/api/propuestas',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(l=>{PROPS_E=new Set(l);refrescarProp()}).catch(()=>{});
 new MutationObserver(refrescarProp).observe($('map'),{attributes:true,attributeFilter:['src']});
 /* auto 'save to S3' 20 s after the last stroke (the official pair goes to Virginia without remembering the button) */
 let autoS3=0;const vp=$('viewport');
 vp&&vp.addEventListener('pointerup',()=>{if(typeof etiqOn==='undefined'||!etiqOn)return;clearTimeout(autoS3);autoS3=setTimeout(()=>{const b=$('guardarMascaraServidor')||[...document.querySelectorAll('#panel button')].find(x=>/^save to S3$|^saving\.\.\.$|^guardar \(work-3\)$|^guardando…$/.test(x.textContent));if(b&&!b.disabled){b.click();if(typeof s3Pend!=='undefined')s3Pend=false}},20000)});
})();

;
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

;
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
function escala(){if(window.VISOR_STATIC?.reduced)return {um:null,fuente:'preview',ver:false};const g=hayGrupo()?group:null,c=g&&g.catalogMeta,ver=!(c&&c.physicalScaleVerified===false);
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

;
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
 const exports=document.createElement('div');exports.className='fila';exports.append($('verPng'),$('guardarTodasMascaras'));
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
 const actions=document.createElement('div');actions.className='fila';actions.append($('guardarMascaraServidor'),$('exp'));
 const storage=document.createElement('small');storage.textContent=visorPuedeGuardar?'Inklabels + supervision PNGs':'Read-only annotation storage';
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
