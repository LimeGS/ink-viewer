const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const {read,sourcePath}=require('./source.cjs');

async function viewer(options={}){
 const errors=[];
 const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error));
 const dom=new JSDOM(read('index.html'),{url:'http://localhost/all-gallery/index.html?rollo=PHerc0175A',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;
 Object.assign(w,{indexedDB:new (require('fake-indexeddb').IDBFactory)(),IDBKeyRange:require('fake-indexeddb').IDBKeyRange,Request,Headers,Response,Blob,TextEncoder,TextDecoder,fetch:async url=>({ok:true,status:200,json:async()=>String(url).includes('api/deploy')?(options.preview?{preview:true,site:'fixture',commit:'fixture',origin:'/fixture'}:null):String(url).includes('/api/propuestas')?[]:{},blob:async()=>new Blob(),arrayBuffer:async()=>new ArrayBuffer(24)}),
  confirm:()=>true,prompt:()=> 'Fixture',open:()=>({}),alert:()=>{},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),ResizeObserver:class{observe(){}disconnect(){}},
  createImageBitmap:async()=>({width:8,height:4,close(){}})});
 w.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height??data.length/4/width}};
 w.HTMLAnchorElement.prototype.click=function(){};
 Object.defineProperties(w.HTMLElement.prototype,{clientWidth:{get(){return this.id==='viewport'?800:400}},clientHeight:{get(){return 500}}});
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {left:0,top:0,right:800,bottom:500,width:800,height:500}};
 let clipboard='';Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{clipboard=text},readText:async()=>clipboard}});
 w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLElement.prototype.setPointerCapture=function(){};w.HTMLElement.prototype.releasePointerCapture=function(){};
 const pixels=(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)});
 w.HTMLCanvasElement.prototype.getContext=function(){
  if(this._ctx)return this._ctx;const canvas=this;
  const dataFor=(x,y,width,height)=>{const out=pixels(width,height),data=canvas._pixels;for(let row=0;row<height;row++)for(let col=0;col<width;col++){const from=((y+row)*canvas.width+x+col)*4,to=(row*width+col)*4;if(data&&from>=0&&from+4<=data.length)out.data.set(data.subarray(from,from+4),to)}return out};
  return this._ctx=new Proxy({canvas,getImageData:dataFor,createImageData:pixels,clearRect(){canvas._pixels=null},putImageData(image){canvas._pixels=new Uint8ClampedArray(image.data)},drawImage(source){if(source instanceof w.HTMLImageElement){const d=pixels(canvas.width,canvas.height);for(let i=0;i<d.data.length;i+=4){const v=(i/4)%2?200:20;d.data.set([v,v,v,255],i)}canvas._pixels=d.data}else if(source._pixels)canvas._pixels=new Uint8ClampedArray(source._pixels)},measureText:t=>({width:String(t).length*6}),
   createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}}),getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),isPointInPath:()=>false},
   {get:(target,key)=>key in target?target[key]:()=>{}});
 };
 w.HTMLCanvasElement.prototype.toBlob=function(cb){cb(new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAFUlEQVR4nGNkYGD4z4AHMOGTpI4CAIIUAQeqcFo1AAAAAElFTkSuQmCC','base64')],{type:'image/png'}))};
 w.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/png;base64,aA==';
 Object.defineProperties(w.HTMLImageElement.prototype,{naturalWidth:{get(){return 8}},naturalHeight:{get(){return 4}},complete:{get(){return true}},
  src:{get(){return this.getAttribute('src')||''},set(value){this.setAttribute('src',value);queueMicrotask(()=>{if(this.onload)this.onload(new w.Event('load'))})}}});
 w.HTMLImageElement.prototype.decode=async()=>{};
 w.VISOR_BOOTSTRAP={origen:{tipo:'local',id:'fixture',origen:'/fixture',layout:'catalog',escritura:!!options.writable,canonical_masks:false},metadata:{},rollos:{PHerc0175A:{scroll:'PHerc0175A',voxel_um:null},PHerc1447:{scroll:'PHerc1447',voxel_um:null}}};
 w.ROLLO_SERVIDOR={};
 w.manifest=[{id:'fixture-run',scroll:'PHerc0175A',maximum:'../catalog/PHerc0175A/segments/s/ink-detection/map-c+00',frames:{0:'../catalog/PHerc0175A/segments/s/ink-detection/map-c+00',2:'../catalog/PHerc0175A/segments/s/ink-detection/map-c+02'},availableContrasts:['fixed','global'],
  catalogMeta:{lam:'s',modelo:'base',scroll:'PHerc0175A',cara:'fwd',depthKnown:true,physicalScaleVerified:false},frameDimensions:{0:{fixed:[8,4]},2:{fixed:[8,4]}},renderGrid:{},meshAssociation:{status:'UNVERIFIED'}}];
 if(options.legacy)w.manifest[0].catalogMeta.modelo='base_etiq';
 if(options.models)for(const model of ['r3f','ra_congelado']){const run=JSON.parse(JSON.stringify(w.manifest[0]));run.id='fixture-'+model;run.catalogMeta.modelo=model;w.manifest.push(run)}
 if(options.calibrated){w.VISOR_BOOTSTRAP.rollos.PHerc0175A={scroll:'PHerc0175A',voxel_um:10,paso_hoja_um:[20,40]};w.manifest.forEach(g=>{g.catalogMeta.physicalScaleVerified=true;g.catalogMeta.um_por_px=10})}
 const context=dom.getInternalVMContext();
 const run=name=>vm.runInContext(read(name),context,{filename:sourcePath(name)});
 try{for(const name of ['deploy_badge.js','origen.js','rollo_visor.js','etiquetar.js','etiq_vc3d.js','viewer.js',
  'filtros_pro.js','super_mosaico.js','precarga.js','fallo_visible.js','explorer_pro.js','ui_modos.js','hist_v5.js','spinner.js','etiq_extra.js','hd.js','etiq_herramientas.js','guias_medicion.js','responsive.js'])if(!(options.skip||[]).includes(name))run(name)}catch(error){console.error(error.stack);dom.window.close();throw error};
 await new Promise(resolve=>setTimeout(resolve,30));
 return {dom,w,context,errors};
}

test('whole viewer initializes and supports explorer and depth navigation',async()=>{
 const app=await viewer();
 try{
  assert.deepEqual(app.errors,[]);

  assert(app.w.document.querySelector('#xpList'));
  const title=app.w.document.querySelector('#title');
  assert.match(title.textContent,/fixture-run/);
  app.w.document.querySelector('#next').click();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(app.w.document.querySelector('#depth').value,'2');
 }finally{app.dom.window.close()}
});

const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
async function waitFor(predicate){const deadline=Date.now()+2000;while(!await predicate()){assert(Date.now()<deadline,'Timed out waiting for viewer state');await settle()}}
function input(w,id,value,type='input'){
 const el=w.document.getElementById(id);assert(el,id);
 if(el.type==='checkbox')el.checked=Boolean(value);else el.value=String(value);
 el.dispatchEvent(new w.Event(type,{bubbles:true}));return el;
}
function click(w,id){const el=w.document.getElementById(id);assert(el,id);el.click();return el}

test('filters, source dialog and Super mosaic retain usable UI state',async()=>{
 const {dom,w,errors}=await viewer();
 try{
  click(w,'filtrosBtn');
  for(const id of ['fGamma','fBrillo','fContraste','fCurva','fCentro','fNegro','fBlanco','fRadio','fPasaalto','fPasaGan','fDogRadio','fDogGan','fUmbral','fPoster','fMezcla']){
   const el=w.document.getElementById(id);input(w,id,el.min||'1');input(w,id,el.max||'2');
  }
  for(const id of ['fAuto','fLocal','fBorde','fPaleta']){const el=w.document.getElementById(id);if(el.options)for(const option of [...el.options])input(w,id,option.value,'change');else click(w,id)}
  for(const id of ['fDog','fInvertir','fUmbralOn','fBlink']){input(w,id,true,'change');input(w,id,false,'change')}
  for(const el of [...w.document.querySelectorAll('#fxPresetSelect option')].slice(1))input(w,'fxPresetSelect',el.value,'change');
  click(w,'fxFavSave');click(w,'fReset');click(w,'fxSimpleReset');
  for(const id of ['fxTab0','fxTab1','fxTab2','fxTab3','fxTab4'])click(w,id);
  click(w,'superBtn');await settle();
  assert(w.superDebug().V>80);assert(w.document.querySelectorAll('#superGrid .sup').length>80);
  input(w,'superTam','220','change');input(w,'superProf','2');click(w,'superMax');
  click(w,'superVF');click(w,'superVC');w.superDibujar();
  const exported=w.superPng(false);assert(exported);
  click(w,'superCerrar');assert.equal(w.superDebug().ov,false);
  click(w,'origenAbrir');assert(w.document.getElementById('origenDialog').open);
  input(w,'origenTipo','s3','change');input(w,'origenTipo','http','change');input(w,'origenTipo','local','change');
  click(w,'origenCancelar');assert.equal(w.document.getElementById('origenDialog').open,false);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('annotation tools open on the native grid and undo remains available',async()=>{
 const {dom,w,context,errors}=await viewer();
 try{
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  assert.equal(vm.runInContext('H.w',context),8);assert.equal(vm.runInContext('H.h',context),4);assert(w.annotationImageReady());
  for(const id of ['mTinta','mNo','mBorrar','mRegion','htVarita','htMarcar','htQuitar'])click(w,id);
  for(const id of ['htTol','htTb','htTa','htBajo','htAlto'])input(w,id,'1');
  for(const id of ['htInt','htSobre','chkMapa']){input(w,id,true,'change');input(w,id,false,'change')}
  click(w,'htAplicar');click(w,'htCancelar');click(w,'undo');click(w,'redo');
  input(w,'sz','3');input(w,'mkOp','0.5');input(w,'mapOp','0.5');
  for(const id of ['gmLineas','gmMedir','gmParalela','gmBorrarSel','gmCopiar','gmPegar','gmBorrarL','gmBorrarM'])click(w,id);
  click(w,'colReset');click(w,'verPng');click(w,'exp');
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

function pointer(app,type,gx,gy,target=app.w.document.getElementById('viewport')){
 const point=vm.runInContext(`({x:x+zoom*${gx},y:y+zoom*${gy}})`,app.context);
 const event=new app.w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:point.x,clientY:point.y});
 Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);
}
function dragGrid(app,x0,y0,x1,y1){pointer(app,'pointerdown',x0,y0);pointer(app,'pointermove',x1,y1);pointer(app,'pointerup',x1,y1)}

test('brush history, mask JSON and guide geometry use the original grid',async()=>{
 const app=await viewer(),{w,context,dom,errors}=app;
 try{
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());assert(w.annotationImageReady());
  for(const id of ['mTinta','mNo','mBorrar']){click(w,id);dragGrid(app,1,1,4,2)}
  assert(vm.runInContext('undoS.length',context)>0);
  click(w,'undo');assert(vm.runInContext('redoS.length',context)>0);click(w,'redo');
  click(w,'copJson');await settle();assert.match(w.document.getElementById('ta').value,/8/);
  click(w,'pegJson');
  click(w,'gmLineas');dragGrid(app,.5,.5,6,1);
  
  assert.equal(w.guiasMedicion.estado().lineas.length,1);
  dragGrid(app,.5,2,6,2.5);assert.equal(w.guiasMedicion.estado().lineas.length,2);
  click(w,'gmParalela');assert(w.guiasMedicion.estado().lineas.length>=2);
  click(w,'gmMedir');dragGrid(app,1,1,4,3);assert.equal(w.guiasMedicion.estado().medidas.length,1);
  click(w,'gmCopiar');await settle();const exported=w.document.getElementById('gmTa').value;assert(exported.includes('lineas'));
  click(w,'gmPegar');await settle();assert.equal(w.guiasMedicion.estado().medidas.length,1);
  input(w,'gmExt',true,'change');input(w,'gmVer',false,'change');input(w,'gmVer',true,'change');
  click(w,'gmBorrarSel');click(w,'gmBorrarL');click(w,'gmBorrarL');click(w,'gmBorrarM');
  assert.equal(w.guiasMedicion.estado().lineas.length,0);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('depth preload bounds decoded layers and merges only matching grids',async()=>{
 const app=await viewer(),{w,context,dom,errors}=app;
 try{
  vm.runInContext(read('precarga.js'),context,{filename:sourcePath('precarga.js')});
  click(w,'hdBtn');await settle();
  input(w,'depth','2');await settle();
  assert(w.precargaPool().decodificadas<=3);
  await new Promise(resolve=>w.precargaMax(w.manifest[0],blob=>{assert.match(blob,/blob:/);resolve()}));
  click(w,'max');await settle();assert(w.document.getElementById('rangoMezcla'));
  click(w,'max');await settle();
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('model comparison pins panels, applies filters and preserves measured depth bands',async()=>{
 const {dom,w,context,errors}=await viewer({models:true,calibrated:true,preview:true,writable:true});
 try{
  assert(w.document.getElementById('viewerPreview'));
  const checks=[...w.document.querySelectorAll('#modsList input[type=checkbox]')];
  assert(checks.length>=3);
  for(const model of ['base','r3f','ra_congelado']){const checkbox=w.document.querySelector('#modsList [data-m="'+model+'"] input');if(!checkbox.checked){checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change',{bubbles:true}))}}
  await settle();assert.equal(w.document.querySelectorAll('#panes .pane').length,3);
  w.fijarPane(0);assert.equal(vm.runInContext('PANES[0].fija',context),true);
  w.fijarPane(0);assert.equal(vm.runInContext('PANES[0].fija',context),false);
  click(w,'filtrosBtn');input(w,'fGamma','1.2');click(w,'fReset');
  w.voltear('f');w.voltear('c');w.oriAlternar();
  w.cerrarPane(1);assert.equal(w.document.querySelectorAll('#panes .pane').length,2);
  w.cerrarPane(1);w.cerrarPane(0);assert.equal(w.document.querySelectorAll('#panes .pane').length,0);
  click(w,'bandasBtn');input(w,'bVerde','25');input(w,'bAmar','50');click(w,'bReset');
  assert.equal(vm.runInContext('UM_CAPA',context),10);
  for(const select of ['xpView','xpSort','xpV5m'])for(const option of [...w.document.getElementById(select).options])input(w,select,option.value,'change');
  input(w,'xpView','list','change');click(w,'xpClear');
  input(w,'xpQ','not-a-segment');assert.equal(w.document.getElementById('xpCount').textContent,'0 segments / 0 ink maps / 0 depths');
  input(w,'xpQ','');click(w,'xpThumbs');click(w,'xpThumbs');click(w,'xpDir');
  for(const id of ['xpAmin','xpAmax','xpV5','xpV5max','xpZmin','xpZmax','xpIso','xpCt']){input(w,id,'1');input(w,id,'')}
  click(w,'xpClear');assert.equal(w.document.getElementById('xpCount').textContent,'1 segment / 3 ink maps / 6 depths');
  const map=w.manifest[0];map.catalogMeta.depthKnown=false;map.frames={0:map.frames[0]};w.xpRepintar();
  assert.equal(w.document.getElementById('xpCount').textContent,'1 segment / 3 ink maps / 5 depths');
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('value selections, supervised regions and clipboard export keep annotation ownership',async()=>{
 const app=await viewer({writable:true}),{w,context,dom,errors}=app;
 try{
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());assert(w.annotationImageReady());
  click(w,'mRegion');dragGrid(app,0,0,7,3);click(w,'undo');click(w,'redo');
  click(w,'mTinta');click(w,'htMarcar');dragGrid(app,0,0,7,3);
  assert(w.document.getElementById('htZona'));
  click(w,'htVarita');await settle();pointer(app,'pointerdown',2,2);pointer(app,'pointerup',2,2);await settle();
  click(w,'htAplicar');click(w,'htBajo');await settle();click(w,'htCancelar');
  click(w,'htAlto');await settle();click(w,'htAplicar');click(w,'htQuitar');
  for(const button of w.document.querySelectorAll('#htAlc button,#htDentro button'))button.click();
  input(w,'htInt',true,'change');await settle();dragGrid(app,1,1,4,2);input(w,'htInt',false,'change');
  click(w,'btnAnillo');click(w,'copJson');await settle();click(w,'pegJson');
  assert(vm.runInContext('H.nombre',context).includes('|c0'));
  assert.equal(vm.runInContext('H.w',context),8);
  assert.equal(vm.runInContext('H.h',context),4);
  for(const key of ['w','r','i','Escape','1','2','3','4'])w.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true}));
  await settle();assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('base filters remain available when optional advanced filters are absent',async()=>{
 const {dom,w,context,errors}=await viewer({models:true,skip:['filtros_pro.js','super_mosaico.js','ui_modos.js']});
 try{
  click(w,'filtrosBtn');
  for(const id of ['fGamma','fBrillo','fContraste']){input(w,id,'1.5');input(w,id,'1')}
  input(w,'fInvertir',true,'change');input(w,'fUmbralOn',true,'change');input(w,'fUmbral','130');
  for(const option of [...w.document.getElementById('fPaleta').options])input(w,'fPaleta',option.value,'change');
  for(const id of ['fLocal','fRadio'])input(w,id,'2');
  w.fxPedir(true);await settle();
  for(const model of ['r3f','ra_congelado']){const checkbox=w.document.querySelector('#modsList [data-m="'+model+'"] input');checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change',{bubbles:true}))}
  await settle();assert.equal(w.document.querySelectorAll('#panes .pane').length,3);
  assert.deepEqual(Array.from(vm.runInContext('lutDe(FX).map(channel=>channel.length)',context)),[256,256,256]);
  w.defsPanes();w.pintarPanes();
  for(let i=0;i<3;i++)w.cerrarPane(0);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('PNG provenance round trips and blocks mismatched native dimensions',async()=>{
 const {dom,w,context,errors}=await viewer({writable:true});
 try{
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  const canvas=w.document.getElementById('mask');
  const blob=await new Promise(resolve=>canvas.toBlob(resolve));
  const info=w.mascaraCorridaInfo(null,8,4);
  assert.equal(info.ancho,8);assert.equal(info.alto,4);
  const tagged=await w.pngConCorrida(blob,info);
  const decoded=w.corridaDePNG(new Uint8Array(await tagged.arrayBuffer()));
  assert.equal(decoded.run_id,info.run_id);assert.equal(decoded.profundidad,0);
  assert.equal(w.verificarCorridaMascara(decoded,info).ok,null);
  const documented={...info,malla_sha256:'fixture-mesh',grid_id:'fixture-grid',orientacion:{correccion:[0,0,0]}};
  assert.equal(w.verificarCorridaMascara(documented,documented).ok,true);
  assert.equal(w.verificarCorridaMascara({...decoded,ancho:9},info).ok,false);
  await assert.rejects(w.pngConCorrida(blob,{...info,ancho:9}),/dimensions/);
  await w.guardarCorridaJson({...info,guardado:'2026-01-01T00:00:00Z'},0);
  await w.exportarPngMascara();
  assert.equal(vm.runInContext('H.w',context),8);assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('legacy browser masks migrate by matching grid without overwriting original canvases',async()=>{
 const {dom,w,context,errors}=await viewer({models:true});
 try{
  const pixels=new Uint8ClampedArray(8*4*4);for(let i=0;i<pixels.length;i+=4)pixels.set([60,220,90,255],i);
  const canvas=w.document.createElement('canvas');canvas.width=8;canvas.height=4;
  const blob=await new Promise(resolve=>canvas.toBlob(resolve));
  w.createImageBitmap=async()=>({width:8,height:4,_pixels:pixels,close(){}});
  const idb=vm.runInContext('idb',context);
  for(const depth of ['0','2'])await idb('readwrite',s=>s.put(blob,'fixture-run|c'+depth));
  vm.runInContext("ORI=Object.fromEntries(manifest.map(g=>[g.id,[0,0,0,'direct']]));manifest.forEach(g=>{g.meshAssociation.meshSha256='fixture-mesh';g.renderGrid={grid_id:'fixture-grid'}})",context);
  w.reclavar();click(w,'etiq');await waitFor(()=>w.annotationImageReady());
  const name=vm.runInContext('H.nombre',context);assert.notEqual(name,'fixture-run|c0');assert(name.includes('8x4'));
  const original=await idb('readonly',s=>s.get('fixture-run|c0'));assert.equal(original.size,blob.size);
  const migration=JSON.parse(w.localStorage.getItem(w.visorKey('vesuvius.lienzos.migrados.v1'))||'{}');
  assert(Object.keys(migration).length>0);
  input(w,'depth','2');await settle();
  assert.equal(vm.runInContext('H.w',context),8);assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});


test('pan, zoom, deep links and mask stamps preserve selected depth',async()=>{
 const app=await viewer({models:true}),{w,context,dom,errors}=app;
 try{
  const vp=w.document.getElementById('viewport');
  for(const id of ['native','plus','minus','fit'])click(w,id);
  vp.dispatchEvent(new w.WheelEvent('wheel',{deltaY:30,clientX:400,clientY:250,bubbles:true,cancelable:true}));
  pointer(app,'pointerdown',0,0);pointer(app,'pointermove',2,1);pointer(app,'pointerup',2,1);
  for(const key of ['ArrowRight','ArrowLeft','f','+','-'])w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true}));
  assert.equal(w.document.getElementById('depth').value,'0');
  w.history.replaceState(null,'','#id=fixture-run&centro=2&etiq=1&paneles=Inferno,Invertido');
  assert.equal(w.applyHash(),true);await waitFor(()=>w.annotationImageReady());assert.equal(w.document.getElementById('depth').value,'2');
  const canonical=new URL(w.location.href);
  assert.equal(canonical.searchParams.get('scroll'),'PHerc0175A');
  assert(!canonical.searchParams.has('rollo'));
  assert(!canonical.hash.includes('centro='));
  assert.equal(new URLSearchParams(canonical.hash.slice(1)).get('depth'),'2');
  assert(w.annotationImageReady());
  const c=w.document.getElementById('mask'),ctx=c.getContext('2d'),data=ctx.createImageData(8,4);data.data.set([60,220,90,255]);ctx.putImageData(data,0,0);
  w.mskGuardar();assert.equal(w.mskPorLamina('s').length,1);
  ctx.clearRect(0,0,8,4);w.mskGuardar();assert.equal(w.mskPorLamina('s').length,0);
  vm.runInContext("MSK['old|0']={png:'data:image/png;base64,aA=='}",context);w.mskCargar('old|0');await settle();
  assert.equal(ctx.getImageData(0,0,8,4).data[3],255);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('source form rejects wrong types and displays server errors without changing origin',async()=>{
 const {dom,w,errors}=await viewer();
 try{
  click(w,'origenAbrir');input(w,'origenTipo','local','change');input(w,'origenRuta','s3://fixture/maps');
  const form=w.document.getElementById('origenForm');
  await form.onsubmit(new w.Event('submit',{cancelable:true}));
  assert.match(w.document.getElementById('origenError').textContent,/does not match/);
  input(w,'origenTipo','s3','change');input(w,'origenGuardar',true,'change');input(w,'origenAnotaciones','/fixture/annotations');
  w.fetch=async()=>({ok:false,json:async()=>({error:'Fixture source unavailable'})});
  await form.onsubmit(new w.Event('submit',{cancelable:true}));
  assert.equal(w.document.getElementById('origenError').textContent,'Fixture source unavailable');
  assert.equal(w.location.pathname,'/all-gallery/index.html');assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('legacy automatic mask runs block untouched, wrong-grid and detached-owner uploads',async()=>{
 const app=await viewer({legacy:true}),{dom,w,context,errors}=app;
 try{
  assert.deepEqual(Array.from(w.ETIQ2509.corridas),['fixture-run']);
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  const name=vm.runInContext('H.nombre',context);assert.equal(name,'s__vc3d_lectura|c0');
  const url='/api/mascara/s__vc3d_lectura/s.png?c=0';
  const c=w.document.getElementById('mask'),blob=await new Promise(resolve=>c.toBlob(resolve));
  await assert.rejects(w.fetch(url,{method:'POST',body:blob}),/no edits/);
  const bad=new Uint8Array(await blob.arrayBuffer());new DataView(bad.buffer).setUint32(16,9);
  await assert.rejects(w.fetch(url,{method:'POST',body:new Blob([bad])}),/differs from its frame/);
  await assert.rejects(w.fetch(url.replace('c=0','c=9'),{method:'POST',body:blob}),/no longer mounted/);
  pointer(app,'pointerdown',1,1);pointer(app,'pointerup',1,1);
  const response=await w.fetch(url,{method:'POST',body:blob});assert.equal(response.ok,true);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('mask provenance rejects changes to every recorded grid dimension',async()=>{
 const {dom,w,errors}=await viewer();
 try{
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  const info={...w.mascaraCorridaInfo(null,8,4),malla_sha256:'fixture-mesh',grid_id:'fixture-grid',orientacion:{correccion:[0,0,0]}};
  for(const [key,value] of Object.entries({ancho:9,alto:5,lamina:'other',segmento:'other',profundidad:2,cara:'rev',scroll:'PHerc1447',base:'other',grid_id:'other',malla_sha256:'other',orientacion:{correccion:[1,0,0]}})){
   assert.equal(w.verificarCorridaMascara({...info,[key]:value},info).ok,false,key);
  }
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('stored per-sheet masks restore once into a depth and keep display colors separate',async()=>{
 const {dom,w,context,errors}=await viewer();
 try{
  const idb=vm.runInContext('idb',context),canvas=w.document.createElement('canvas');canvas.width=8;canvas.height=4;
  const blob=await new Promise(resolve=>canvas.toBlob(resolve));
  const pixels=new Uint8ClampedArray(8*4*4);pixels.set([60,220,90,255]);
  w.createImageBitmap=async()=>({width:8,height:4,_pixels:pixels,close(){}});
  click(w,'etiq');await waitFor(()=>w.annotationImageReady());
  await idb('readwrite',s=>s.put(blob,'fixture-run'));
  await w.restaurar(vm.runInContext('H.nombre',context));
  assert.equal(w.document.getElementById('mask').getContext('2d').getImageData(0,0,8,4).data[3],255);
  await waitFor(async()=>await idb('readonly',s=>s.get('fixture-run'))===undefined);
  input(w,'colTinta','#112233');input(w,'colNo','#445566');
  assert.equal(JSON.parse(w.localStorage.getItem('vesuvius.etiq.colores')).tinta,'#112233');
  assert.equal(w.document.getElementById('mask').getContext('2d').getImageData(0,0,8,4).data[1],220);
  click(w,'colReset');assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('saved mask load rejects another grid, then replaces a matching grid with undo',async()=>{
 const {dom,w,context,errors}=await viewer();
 try{
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  const info={...w.mascaraCorridaInfo(null,8,4),malla_sha256:'fixture-mesh',grid_id:'fixture-grid',orientacion:{correccion:[0,0,0]}};
  let decoded=0;
  w.obtenerParMascara=async()=>({blobs:[],corrida:{...info,ancho:9}});
  w.leerParMascara=async()=>{decoded++;return {width:8,height:4,data:new Uint8ClampedArray(8*4*4)}};
  click(w,'htCargar');await settle();assert.equal(decoded,0);
  // Test the loading coordinator with an unprovenanced pair; PNG decoding and
  // provenance decisions have their own binary import tests.
  w.obtenerParMascara=async()=>({blobs:[],corrida:info});
  w.confirmarMetadatosMascara=async()=>true;
  click(w,'htCargar');await settle();assert.equal(decoded,1);
  assert(vm.runInContext('undoS.length',context)>0);click(w,'undo');
  assert.equal(vm.runInContext('H.w',context),8);assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});

test('a crop labels under its own canvas key and provenance, and the upload owner check accepts it',async()=>{
 const {dom,w,context,errors}=await viewer();
 try{
  const crop={x:5,y:6,ancho:8,alto:4,ancho_mapa:80,alto_mapa:40};
  w.recorteVista={key:()=>'|r5,6',info:()=>({...crop}),query:()=>'',showing(){},reduced(){},failed:()=>false,title:()=>' · crop at 5, 6 of 80 × 40'};
  vm.runInContext('clave=null;show(true)',context);
  click(w,'etiq');await waitFor(()=>w.document.getElementById('panel').hidden||w.annotationImageReady());
  const name=vm.runInContext('H.nombre',context);assert.match(name,/\|r5,6\|c[^|]+$/,'crop window before the depth suffix');
  assert.match(w.document.getElementById('title').textContent,/crop at 5, 6 of 80 × 40/);
  const info=w.mascaraCorridaInfo(null,8,4);assert.deepEqual(JSON.parse(JSON.stringify(info.recorte)),crop);
  assert.doesNotMatch(String(w.vetoGuardado({...info,clave_local:name})),/does not belong/);
  delete w.recorteVista;
  assert.equal(w.mascaraCorridaInfo(null,8,4).recorte,undefined,'whole maps carry no crop');
  assert.deepEqual(errors,[]);
 }finally{dom.window.close()}
});
