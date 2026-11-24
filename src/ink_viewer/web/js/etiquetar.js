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
  const q = new URLSearchParams({c:String(c),rollo:String(rollo || '')});
  if (base) q.set('base',base); if (propuesta) q.set('propuesta','1');
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
