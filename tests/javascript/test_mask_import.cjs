const {read, root, sourcePath} = require('./source.cjs');
// Run: node tests/javascript/test_mask_import.cjs. Exercises production decoder/import code without a browser or dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = read('etiquetar.js');
const tools = read('etiq_herramientas.js');
const pixels = values => ({width:values.length,height:1,data:Uint8ClampedArray.from(values.flatMap(v => [v,v,v,255]))});
const clone = image => ({...image,data:new Uint8ClampedArray(image.data)});
function canvas() {
  const c = {width:0,height:0,image:null};
  c.getContext = () => ({
    clearRect(){c.image = {width:c.width,height:c.height,data:new Uint8ClampedArray(c.width*c.height*4)}},
    drawImage(bm){c.image = clone(bm.image)},
    getImageData(){return clone(c.image || {width:c.width,height:c.height,data:new Uint8ClampedArray(c.width*c.height*4)})},
    createImageData(w,h){return {width:w,height:h,data:new Uint8ClampedArray(w*h*4)}},
    putImageData(im){c.image = clone(im)}
  });
  c.toBlob=callback=>{const b=new Blob(['stored mask']);b.image=clone(c.image);callback(b)};
  return c;
}
const elements = {'#impFile':{},'#imp':{before(){}},'#msg':{}};
const ctx = {fetch:async()=>({ok:true,json:async()=>({canonical_masks:false})}),console,Blob,URL,URLSearchParams,DataView,Uint8Array,Uint8ClampedArray,TextEncoder,TextDecoder,
  setTimeout:()=>0,clearTimeout(){},confirm:()=>true,
  window:{ROLLO_CORTO:'test'},indexedDB:{open(){ctx.dbRequest={};return ctx.dbRequest}},
  document:{querySelector:s=>elements[s] || null,createElement:t=>t==='canvas'?canvas():{setAttribute(){}}},
  createImageBitmap:async b=>({width:b.image.width,height:b.image.height,image:b.image,close(){}})};
vm.createContext(ctx);
vm.runInContext(core,ctx,{filename:sourcePath('etiquetar.js')});
const capturedAutosave=ctx.autoguardar;
vm.runInContext(tools.slice(tools.indexOf('const claveGrilla='),tools.indexOf('function verificar(')),ctx);
vm.runInContext(tools.slice(tools.indexOf('function verificar('),tools.indexOf('/* la guardada es de una corrida HERMANA')),ctx);
const decode = ctx.decodificarPixelesMascara;
const info = {run_id:'run',scroll:'sample',base:'sample/segments/sheet',lamina:'sheet',segmento:'sheet',
  profundidad:0,cara:'only',ancho:3,alto:1,malla_sha256:'mesh',orientacion:{correccion:[0,0,0]}};
ctx.window.verificarCorridaMascara = ctx.verificar;
ctx.window.corridaDePNG = b => ctx.metadata;
ctx.metadata = {...info,par_id:'pair'};
ctx.window.mascaraCorridaInfo = () => info;
function mount(image = pixels([128,128,128])) {
  const c = canvas();c.width=image.width;c.height=image.height;c.image=clone(image);ctx.c=c;
  vm.runInContext("H={nombre:'sheet|c0',w:c.width,h:c.height};mask=c;mctx=c.getContext('2d');undoS=[];redoS=[];autoguardar=()=>{};contar=()=>{}",ctx);
  return c;
}
function png(image,depth=8) {
  const head = new Uint8Array(33);head.set([137,80,78,71,13,10,26,10]);head.set([73,72,68,82],12);
  const d = new DataView(head.buffer);d.setUint32(16,image.width);d.setUint32(20,image.height);head[24]=depth;
  const b = new Blob([head],{type:'image/png'});b.image=image;b.name='mask.png';return b;
}
async function main() {
  const tri = decode(pixels([0,128,255]));
  assert.deepEqual(Array.from(tri.data),[230,60,60,255,0,0,0,0,60,220,90,255]);
  const pair = decode(pixels([0,0,255]),pixels([255,0,255]));
  assert.deepEqual(Array.from(pair.data),Array.from(tri.data),'binary pair preserves IGNORE');
  assert.throws(()=>decode(pixels([0]),pixels([255,0])),/dimensions/);
  assert.throws(()=>decode(pixels([255]),pixels([0])),/outside supervision/);
  for (const value of [1,127,129,254]) assert.throws(()=>decode(pixels([value])),/exact/);
  assert.throws(()=>decode(pixels([128]),pixels([255])),/exact/);
  for (const alpha of [0,127,254]) {const im=pixels([0]);im.data[3]=alpha;assert.throws(()=>decode(im),/opaque/)}
  const red=pixels([255]);red.data[1]=red.data[2]=0;assert.throws(()=>decode(red),/grayscale/);
  await assert.rejects(()=>ctx.leerPngMascara(new Blob(['JPEG']),3,1),/only PNG/);
  await assert.rejects(()=>ctx.leerPngMascara(png(pixels([0]),16),1,1),/8-bit/);
  await assert.rejects(()=>ctx.leerPngMascara(png(pixels([0])),3,1),/exactly/);
  for (const [key,value] of [['lamina','other'],['segmento','other'],['scroll','other'],['profundidad',1],['cara','back'],['ancho',4],['malla_sha256','other']])
    assert.equal(ctx.verificar({...info,[key]:value},info).ok,false,'same run must not bypass '+key);
  assert.equal(ctx.verificar({...info,orientacion:{correccion:[1,0,0]}},info).ok,false);
  assert.equal(ctx.verificar({...info,um_por_px:2},{...info,um_por_px:1}).ok,false);
  assert.equal(ctx.verificar({...info,grid_id:'old'},{...info,grid_id:'new'}).ok,false);
  assert.equal(ctx.verificar(info,{...info,grid_id:'new'}).ok,null,'missing render identity cannot be confirmed');
  assert.equal(ctx.verificar({...info,grid_id:'same'},{...info,grid_id:'same'}).ok,true);
  assert.equal(ctx.verificar(info,info).ok,true);
  const exact={...info,directorio_fuente:'same/original/png/run'};
  assert.equal(ctx.verificar(exact,{...exact,orientacion:{correccion:null}}).ok,true);
  assert.equal(ctx.verificar(exact,{...exact,run_id:'other',orientacion:{correccion:null}}).ok,null);
  assert.equal(ctx.verificar(exact,{...exact,directorio_fuente:'different/source',orientacion:{correccion:null}}).ok,null);
  assert.equal(ctx.verificar({...info,malla_sha256:null},info).ok,null,'missing metadata needs confirmation');
  const human=clone(tri),proposal=decode(pixels([255,255,0]),pixels([255,255,255]));
  const merged=ctx.conservarEdiciones(proposal,human);
  assert.deepEqual(Array.from(merged.data.slice(0,4)),Array.from(human.data.slice(0,4)),'human no-ink survives proposed ink');
  assert.deepEqual(Array.from(merged.data.slice(8)),Array.from(human.data.slice(8)),'human ink survives proposed non-ink');
  ctx.formatoImportacion = vm.runInContext('formatoImportacion',ctx);ctx.formatoImportacion.value='tri';
  const original=decode(pixels([255,0,128])),c=mount(original),f=png(pixels([0,128,255]));
  assert.equal(await elements['#impFile'].onchange({target:{files:[f],value:'file'}}),true);
  assert.deepEqual(Array.from(c.image.data),Array.from(tri.data));
  vm.runInContext('aplicar(undoS,redoS)',ctx);
  assert.deepEqual(Array.from(c.image.data),Array.from(original.data),'replacement undo restores the entire mask');
  f.name='sheet_inklabels.png';
  assert.equal(await elements['#impFile'].onchange({target:{files:[f],value:'file'}}),false,'ink-only export is not tri-state');
  ctx.formatoImportacion.value='ink';
  const binaryInk=png(pixels([255,0,0]));binaryInk.name='c019_inklabels.png';
  assert.equal(await elements['#impFile'].onchange({target:{files:[binaryInk],value:'file'}}),true,'ink-only filenames are accepted only with explicit mode');
  assert.deepEqual(Array.from(c.image.data),[60,220,90,255,0,0,0,0,0,0,0,0],'white is ink and black remains unlabelled, never non-ink');
  assert.match(elements['#msg'].textContent,/no reviewed non-ink/);
  assert.equal(await elements['#impFile'].onchange({target:{files:[f],value:'file'}}),false,'ink-only mode rejects gray 128 instead of guessing');
  binaryInk.name='c019_supervision_mask.png';
  assert.equal(await elements['#impFile'].onchange({target:{files:[binaryInk],value:'file'}}),false,'supervision layer cannot masquerade as ink-only');
  binaryInk.name='c019_supervision_mask (2).png';
  assert.equal(await elements['#impFile'].onchange({target:{files:[binaryInk],value:'file'}}),false,'a browser-renamed supervision layer cannot masquerade either');
  const inkFile=png(pixels([0,0,255])),supFile=png(pixels([255,0,255]));
  inkFile.name='sheet_inklabels.png';supFile.name='sheet_supervision_mask.png';
  ctx.formatoImportacion.value='par';
  assert.equal(await elements['#impFile'].onchange({target:{files:[supFile,inkFile],value:'file'}}),true,'pair order follows class filenames');
  assert.deepEqual(Array.from(c.image.data),Array.from(tri.data),'pair importer preserves unknown background');
  inkFile.name='sheet_inklabels (1).png';supFile.name='sheet_supervision_mask (1).png';
  assert.equal(await elements['#impFile'].onchange({target:{files:[supFile,inkFile],value:'file'}}),true,'a re-downloaded pair renamed by the browser still imports');
  assert.deepEqual(Array.from(c.image.data),Array.from(tri.data));
  inkFile.name='sheet_inklabels.png';supFile.name='sheet_supervision_mask.png';
  let calls=0;ctx.window.corridaDePNG=()=>({...info,par_id:++calls===1?'first':'second'});
  assert.equal(await elements['#impFile'].onchange({target:{files:[inkFile,supFile],value:'file'}}),false,'mixed pair generations are rejected');
  assert.deepEqual(Array.from(c.image.data),Array.from(tri.data));
  ctx.window.corridaDePNG=()=>ctx.metadata;ctx.formatoImportacion.value='tri';
  f.name='mask.png';ctx.metadata=null;ctx.confirm=()=>false;
  assert.equal(await elements['#impFile'].onchange({target:{files:[f],value:'file'}}),false,'missing provenance cannot silently paste');
  ctx.metadata={...info,par_id:'pair'};ctx.confirm=()=>true;
  let release;ctx.createImageBitmap=b=>new Promise(resolve=>{release=()=>resolve({width:b.image.width,height:b.image.height,image:b.image,close(){}})});
  const stale=elements['#impFile'].onchange({target:{files:[f],value:'file'}});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const next=mount(original);release();assert.equal(await stale,false);
  assert.deepEqual(Array.from(next.image.data),Array.from(original.data),'stale import never draws on the new canvas');
  const badJson=JSON.stringify({hoja:'sheet|c0',ancho:3,alto:1,runs:[[0,1],[128,1],[42,1]]});
  assert.notEqual(ctx.pegarJson(badJson),true);assert.deepEqual(Array.from(next.image.data),Array.from(original.data));
  const timers=[],writes=[];ctx.setTimeout=fn=>{timers.push(fn);return timers.length};
  ctx.dbRequest.result={transaction:()=>({objectStore:()=>({put(b,n){writes.push({b,n});const r={};queueMicrotask(()=>r.onsuccess());return r}})})};ctx.dbRequest.onsuccess();
  mount(original);capturedAutosave();mount(tri);vm.runInContext("H.nombre='other|c1'",ctx);timers.shift()();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes[0].n,'sheet|c0','autosave retains the old sheet and depth');
  assert.deepEqual(Array.from(writes[0].b.image.data),Array.from(original.data),'autosave retains the old pixels');
  const restoreImages=[];ctx.Image=class {set src(url){restoreImages.push(this)}};
  const stored=new Blob(['saved']);
  ctx.dbRequest.result.transaction=()=>({objectStore:()=>({get(){const r={result:stored};queueMicrotask(()=>r.onsuccess());return r}})});
  mount(original);const restoring=ctx.restaurar('sheet|c0');
  while(!restoreImages.length)await new Promise(resolve=>setImmediate(resolve));
  const destination=mount(original),decoded=restoreImages.shift();
  Object.assign(decoded,{width:3,height:1,naturalWidth:3,naturalHeight:1,image:tri});decoded.onload();await restoring;
  assert.deepEqual(Array.from(destination.image.data),Array.from(original.data),'stale IndexedDB restoration cannot draw into a new canvas');
  const wrongSize=ctx.restaurar('sheet|c0');
  while(!restoreImages.length)await new Promise(resolve=>setImmediate(resolve));
  const tooSmall=restoreImages.shift();Object.assign(tooSmall,{width:1,height:1,naturalWidth:1,naturalHeight:1,image:pixels([255])});tooSmall.onload();await wrongSize;
  assert.deepEqual(Array.from(destination.image.data),Array.from(original.data),'stored masks with different dimensions are never stretched or partially pasted');
  console.log('Mask import checks passed: PNG/classes/dimensions/subset/IGNORE, provenance, proposal edits, undo and stale destination.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
