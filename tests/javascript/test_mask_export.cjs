const {read, root} = require('./source.cjs');
// Run with: node tests/javascript/test_mask_export.cjs
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=read('viewer.js');
const section=(from,to)=>{const a=html.indexOf(from),b=to===null?html.length:html.indexOf(to,a);assert(a>=0&&b>a);return html.slice(a,b)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const element=()=>({style:{},dataset:{},classList:{toggle(){}},setAttribute(){},removeAttribute(){},parentElement:{append(){},insertBefore(){}}});

async function checkExport(){
 const encodings=[],downloads=[],requests=[],acknowledged=[],messages=[],objects=new Map(),els={exp:element()};
 let current=new Uint8ClampedArray([10,220,10,255,220,10,10,255,0,0,0,0]),revision=10;
 class Canvas{
  constructor(){this.context={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:img=>{this.pixels=img.data}}}
  getContext(){return this.context}
  toBlob(callback,type){assert.equal(type,'image/png');encodings.push(()=>callback(new Blob([JSON.stringify({pixels:[...this.pixels]})],{type})))}
 }
 class Reader{
  readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result='data:image/png;base64,'+Buffer.from(bytes).toString('base64');this.onload()},err=>{this.error=err;this.onerror()})}
 }
 const owner={id:'runA',scroll:'PHerc0800',catalogMeta:{lam:'segmentA',scroll:'PHerc0800'}};
 const ctx=vm.createContext({Blob,FileReader:Reader,crypto:require('node:crypto').webcrypto,Uint32Array,
  setTimeout(){},URL:{createObjectURL:b=>{const id='blob:'+objects.size;objects.set(id,b);return id},revokeObjectURL(){}},
  document:{createElement:tag=>tag==='canvas'?new Canvas():tag==='a'?{click(){downloads.push({name:this.download,blob:objects.get(this.href)})}}:element()},
  $:id=>els[id]||(els[id]=element()),grisCanvas(){},meta:g=>g.catalogMeta,
  segId:n=>n,nombreEtiquetas:(lam,type)=>lam+'_'+type+'.png',segRuta:g=>({base:'catalog/'+g.scroll+'/segments/'+g.catalogMeta.lam}),
  msg:s=>messages.push(s),visorTexto:s=>s,visorPuedeGuardar:true,ROLLO:'PHerc0800',projection:false,slider:{value:'2'},
  H:{nombre:'segmentA|c2',w:3,h:1},group:owner,mctx:{getImageData:()=>({data:current.slice()})},
  fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({ok:true,clave:'labels/a.png',clave_profundidad:'labels/c+02/a.png'})}},window:{}});
 ctx.window.mascaraDueno={nombre:ctx.H.nombre,group:owner,centro:'2',w:3,h:1};
 ctx.window.mascaraCorridaInfo=(cen,w,h)=>({segmento:'segmentA',run_id:owner.id,profundidad:cen??'2',ancho:w,alto:h,orientacion:{correccion:[0,0,0]}});
 ctx.window.pngConCorrida=async(blob,info)=>new Blob([JSON.stringify({...JSON.parse(await blob.text()),info})],{type:'image/png'});
 ctx.window.vetoGuardado=()=>null;ctx.window.revisionMascara=()=>revision;ctx.window.guardarCorridaJson=async(info,savedRevision)=>acknowledged.push({info,revision:savedRevision});
 ctx.window.annotationImageReady=()=>false;
 vm.runInContext(section('(function(){\n if(typeof grisCanvas', null),ctx);
 els.exp.onclick();assert.equal(encodings.length,0);assert.equal(downloads.length,0);
 assert.match(messages.at(-1),/restored mask/);
 ctx.window.annotationImageReady=()=>true;
 els.exp.onclick();
 assert.equal(encodings.length,2);
 current.fill(0);ctx.group={id:'runB',catalogMeta:{lam:'segmentB'}};ctx.H={nombre:'segmentB|c8',w:3,h:1};
 ctx.slider.value='8';ctx.window.mascaraDueno={nombre:ctx.H.nombre,group:ctx.group,centro:'8',w:3,h:1};
 encodings.splice(0).forEach(f=>f());await tick();await tick();
 assert.deepEqual(downloads.map(d=>d.name),['segmentA_inklabels.png','segmentA_supervision_mask.png']);
 const downloaded=await Promise.all(downloads.map(async d=>JSON.parse(await d.blob.text())));
 assert.deepEqual(downloaded[0].pixels,[255,255,255,255,0,0,0,255,0,0,0,255]);
 assert.deepEqual(downloaded[1].pixels,[255,255,255,255,255,255,255,255,0,0,0,255]);
 assert.deepEqual(downloaded[0].info,downloaded[1].info);
 assert.equal(downloaded[0].info.run_id,'runA');assert.equal(downloaded[0].info.profundidad,'2');
 assert.match(downloaded[0].info.par_id,/^[0-9a-f]{32}$/);
 ctx.H={nombre:'segmentA|c2',w:3,h:1};ctx.group=owner;
 ctx.window.mascaraDueno={nombre:ctx.H.nombre,group:owner,centro:'2',w:3,h:1};
 current.set([10,220,10,255,220,10,10,255,0,0,0,0]);
 const upload=ctx.window.subirParS3();
 current.fill(0);revision=11;ctx.slider.value='99';owner.scroll='PHerc0306B';await tick();
 encodings.splice(0).forEach(f=>f());await upload;
 assert.equal(requests.length,1);assert.match(requests[0].url,/^\/api\/mascara-par\/segmentA\?c=2&base=/);
 assert.match(requests[0].url,/rollo=PHerc0800$/);assert.equal(requests[0].options.headers['Content-Type'],'application/json');
 const body=JSON.parse(requests[0].options.body);
 const ink=JSON.parse(Buffer.from(body.inklabels,'base64')),sup=JSON.parse(Buffer.from(body.supervision_mask,'base64'));
 assert.deepEqual(ink.info,sup.info);assert.deepEqual(ink.info,body.corrida);
 assert.equal(acknowledged.length,1);assert.equal(ink.pixels[0],255);assert.equal(sup.pixels[4],255);
 assert.equal(acknowledged[0].revision,10,'later edits must not change the acknowledged snapshot revision');
 await assert.rejects(ctx.window.subirParS3(),/empty mask/);assert.equal(requests.length,1);
 current.set([10,220,10,255,220,10,10,255,0,0,0,0]);
 ctx.fetch=async()=>({ok:false,text:async()=> 'Atomic mask storage unavailable'});
 const failure=ctx.window.subirParS3();await tick();encodings.splice(0).forEach(f=>f());
 await assert.rejects(failure,/Atomic mask storage unavailable/);assert.equal(acknowledged.length,1);
 ctx.window.mascaraDueno.nombre='different';await assert.rejects(ctx.window.subirParS3(),/owner is unknown/);
 ctx.window.mascaraDueno.nombre=ctx.H.nombre;ctx.slider.value='2';
 let reads=0;ctx.idb=()=>{reads++;throw Error('The active canvas must not be read from stale IndexedDB')};
 ctx.db=Promise.resolve({transaction:()=>({objectStore:()=>({getAllKeys:()=>{const rq={};setImmediate(()=>{rq.result=['segmentA|c2'];rq.onsuccess()});return rq}})})});
 ctx.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({ok:true,clave:'labels/a.png'})}};
 revision=12;const all=ctx.window.subirTodasS3();current.fill(0);revision=13;
 await tick();encodings.splice(0).forEach(f=>f());assert.match(await all,/1 depths saved/);
 assert.equal(reads,0);assert.equal(acknowledged.at(-1).revision,12);
 const savedAll=JSON.parse(requests.at(-1).options.body);
 assert.equal(JSON.parse(Buffer.from(savedAll.inklabels,'base64')).pixels[0],255,'save all snapshots the active canvas before awaiting storage');
 current.set([10,220,10,255,220,10,10,255,0,0,0,0]);revision=14;
 let finishFetch,sendCount=0;
 ctx.fetch=async()=>{sendCount++;if(sendCount===1)await new Promise(resolve=>{finishFetch=resolve});return {ok:true,json:async()=>({ok:true,clave:'labels/a.png'})}};
 const older=ctx.window.subirParS3();revision=15;const newer=ctx.window.subirParS3();
 await tick();assert.equal(encodings.length,2,'only the first upload can encode before it commits');
 encodings.splice(0).forEach(f=>f());await tick();assert.equal(sendCount,1);
 finishFetch();await older;await tick();assert.equal(encodings.length,2);
 encodings.splice(0).forEach(f=>f());await newer;
 assert.deepEqual(acknowledged.slice(-2).map(x=>x.revision),[14,15],'upload acknowledgments stay in snapshot order');
}

async function checkRevisionAck(){
 const tools=read('etiq_herramientas.js');
 const pick=(from,to)=>{const a=tools.indexOf(from),b=tools.indexOf(to,a);assert(a>=0&&b>a);return tools.slice(a,b)};
 const ctx=vm.createContext({window:{},H:{nombre:'sheet|c0'},Date:{now:()=>1000},localStorage:{getItem:()=>null,setItem(){}},
  visorKey:k=>k,$h:()=>null,pintarCorrida(){},GUARDADA:{},claveG:i=>i.segmento,visorPuedeGuardar:true});
 vm.runInContext(pick('const KP=', '/* ---------- lienzo'),ctx);
 vm.runInContext(pick('window.guardarCorridaJson=', '/* lo que work-3'),ctx);
 vm.runInContext("marcarEdicion(); const info={clave_local:H.nombre,profundidad:0,segmento:'sheet'}; const old=window.revisionMascara(info); marcarEdicion(); const latest=window.revisionMascara(info)",ctx);
 assert.equal(vm.runInContext('latest',ctx),1001,'edits in the same millisecond receive distinct revisions');
 await vm.runInContext('window.guardarCorridaJson(info,old)',ctx);
 assert.equal(vm.runInContext('window.revisionMascara(info)',ctx),1001,'an earlier save cannot clear later pending edits');
 await vm.runInContext('window.guardarCorridaJson(info,latest)',ctx);
 assert.equal(vm.runInContext('window.revisionMascara(info)',ctx),0);
}

function checkHD(){
 const els={},loaders=[];const get=id=>els[id]||(els[id]=element());
 const ctx=vm.createContext({window:{HD:false},localStorage:{getItem(){return null},setItem(){}},
  document:{getElementById:get,createElement:()=>{const e=element();Object.defineProperty(e,'id',{set(id){els[id]=e}});return e}},$:get,console:{log(){},warn(){}},
  Image:class{constructor(){this.naturalWidth=3;this.naturalHeight=1;loaders.push(this)}},
  group:{id:'run',catalogMeta:{},frames:{0:'depth0',1:'depth1'}},slider:{value:'0',min:0,max:1},projection:false,
  request:0,fullresReady:0,fullresGroup:null,fullresDepth:null,maskReady:true,H:{w:3,h:1},curW:3,curH:1,etiqOn:false,pintar:false,
  im:{style:{},naturalWidth:3,naturalHeight:1},vp:{clientWidth:300,clientHeight:100},fitted:false,
  mapUrl:d=>d+'/fixed.png',signed:String,pintarBanda(){},syncHash(){},ensureContrast(){},fit(){},paint(){},fxPedir(){},
  trasFrame(){},cargandoOff(){},oriDims:(o,w,h)=>[w,h],oriEf(){return null},setTimeout,fetch(){throw Error('Preview must not load during annotation')}});
 get('chkMapa').checked=true;get('mapOp').value=1;
 vm.runInContext(section('window.annotationImageReady=', '\n/* ===== orientacion'),ctx);
 vm.runInContext(section('function show(reset=false)', '\n/* multi-rollo'),ctx);
 vm.runInContext(read('hd.js'),ctx);
 ctx.etiqOn=true;ctx.window.requireAnnotationHD(true);
 assert.equal(ctx.window.HD,true);assert.equal(get('hdBtn').disabled,true);
 assert.equal(loaders.length,1);assert.equal(ctx.window.annotationImageReady(),false);
 loaders[0].onload();assert.equal(ctx.window.annotationImageReady(),false);
 ctx.im.onload();assert.equal(ctx.window.annotationImageReady(),true);
 get('hdBtn').onclick();assert.equal(ctx.window.HD,true);assert.equal(loaders.length,1);
 ctx.slider.value='1';ctx.show();assert.equal(ctx.window.annotationImageReady(),false);
 loaders[1].onload();ctx.im.onload();assert.equal(ctx.window.annotationImageReady(),true);
 ctx.maskReady=false;assert.equal(ctx.window.annotationImageReady(),false);
 ctx.maskReady=true;ctx.slider.value='0';ctx.show();loaders[2].onerror();assert.equal(ctx.window.annotationImageReady(),false);
 ctx.slider.value='1';ctx.show();const stale=loaders[3];ctx.slider.value='0';ctx.show();stale.onload();assert.equal(ctx.window.annotationImageReady(),false);
 loaders[4].onload();ctx.im.onload();assert.equal(ctx.window.annotationImageReady(),true);
}
function checkPaneGrid(){
 const image={complete:true,naturalWidth:2,naturalHeight:1,src:'http://localhost/a.png'};
 const pane={querySelector:()=>image},current={key:'sheetA'},other={key:'sheetB'};
 const ctx=vm.createContext({URL,location:{href:'http://localhost/'},PANES:[{modelo:'other'}],
  group:current,H:{w:2,h:1,nombre:'sheetA|c0'},slider:{value:'0'},projection:false,im:{src:image.src},
  $:()=>({children:[pane]}),grupoDeModelo:()=>other,srcDeModelo:()=>'/a.png',claveLienzo:g=>g.key});
 vm.runInContext(section('function paneAnnotationReady(', 'window.annotationPointerReady='),ctx);
 ctx.pane=pane;
 assert.equal(vm.runInContext('paneAnnotationReady(pane)',ctx),false);
 other.key='sheetA';assert.equal(vm.runInContext('paneAnnotationReady(pane)',ctx),true);
 image.naturalWidth=3;assert.equal(vm.runInContext('paneAnnotationReady(pane)',ctx),false);
 image.naturalWidth=2;image.complete=false;assert.equal(vm.runInContext('paneAnnotationReady(pane)',ctx),false);
 image.complete=true;image.src='http://localhost/old.png';assert.equal(vm.runInContext('paneAnnotationReady(pane)',ctx),false);
}
(async()=>{await checkExport();await checkRevisionAck();checkHD();checkPaneGrid();console.log('PASS: immutable mask pair, active-depth save, revision acknowledgments, ordered uploads, HD readiness and pane grid guard')})().catch(e=>{console.error(e);process.exitCode=1});
