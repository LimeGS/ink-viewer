const {read, root, sourcePath} = require('./source.cjs');
// Run: node tests/javascript/test_navigation.cjs. Exercise production navigation and cross-scroll persistence.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const html=read('viewer.js'),tools=read('etiq_herramientas.js');
function pick(text,a,b){const i=text.indexOf(a),j=text.indexOf(b,i);assert(i>=0&&j>i,a);return text.slice(i,j)}
const metadata={PHercA:{scroll:'PHercA',voxel_um:7,paso_hoja_um:[50,100]},PHercB:{scroll:'PHercB',voxel_um:14}};
const location={href:'http://localhost/all-gallery/index.html#id=old&vista=pos',search:'',hash:'#id=old&vista=pos'};
const ctx=vm.createContext({URL,URLSearchParams,location,Map,Promise,console,
 VISOR_ORIGEN:{scroll:'PHercA'},XMLHttpRequest:class{open(m,u){this.scroll=new URL(u,'http://localhost').searchParams.get('rollo')}send(){this.status=200;this.responseText='window.ROLLO_SERVIDOR='+JSON.stringify(metadata[this.scroll]||{scroll:this.scroll,voxel_um:null})+';'}},
 history:{replaceState(a,b,u){const url=new URL(u,location.href);Object.assign(location,{href:url.href,search:url.search,hash:url.hash})}},
 pintar:false,release(){throw Error('no active stroke')},flush(){},clearTimeout(){},mskTimer:null,mskGuardar(){},
 abrirDb:r=>Promise.resolve(r),actualizarDataset(){},actualizarBandas(){},request:2,tokenM:2});
ctx.window=ctx;
vm.runInContext(read('rollo_visor.js'),ctx,{filename:sourcePath('rollo_visor.js')});
vm.runInContext(pick(html,'function irARollo(', 'function select('),ctx);
assert.equal(ctx.ROLLO,'PHercA');assert.equal(ctx.VOXEL_UM,7);
assert.equal(ctx.irARollo('PHercA','same'),false);assert.equal(location.search,'');
ctx.irARollo('PHercB','other');assert.equal(ctx.ROLLO,'PHercB');assert.equal(ctx.VOXEL_UM,14);assert.equal(ctx.PASO_HOJA_UM,null);
assert.equal(new URL(location.href).searchParams.get('scroll'),'PHercB');assert.equal(location.hash,'#id=old&vista=pos');
assert.equal(ctx.visorUmPorPixel({scroll:'PHercA'}),7,'old-owner provenance retains its calibration');
ctx.irARollo('PHercUnknown','unknown');assert.equal(ctx.VOXEL_UM,null);assert.equal(ctx.PASO_HOJA_UM,null);
ctx.irARollo('PHercA','back');assert.equal(ctx.VOXEL_UM,7);assert.deepEqual([...ctx.PASO_HOJA_UM],[50,100]);
assert.equal(ctx.irARollo('unknown','invalid'),false);assert.equal(ctx.ROLLO,'PHercA');

async function storage(){
 const stores=new Map(),timers=[],blobs=[],messages=[];
 const elements={'#imp':{before(){}},'#impFile':{}};
 const c=vm.createContext({fetch:async()=>({ok:true,json:async()=>({canonical_masks:false})}),console,URL,URLSearchParams,Map,Promise,Blob,Uint8Array,Uint8ClampedArray,DataView,
  window:{ROLLO:'PHercA',ROLLO_CORTO:'A'},H:null,setTimeout:f=>{timers.push(f);return timers.length},clearTimeout(){},
  document:{querySelector:s=>elements[s]||null,createElement:()=>({setAttribute(){},width:1,height:1,getContext:()=>({drawImage(){}}),toBlob:f=>blobs.push(()=>f(new Blob(['pixels'])))} )},
  indexedDB:{open(name){if(!stores.has(name))stores.set(name,new Map());const map=stores.get(name),r={};queueMicrotask(()=>{r.result={transaction:()=>({objectStore:()=>({put(blob,key){map.set(key,blob);const q={};queueMicrotask(()=>q.onsuccess());return q},get(key){const q={result:map.get(key)};queueMicrotask(()=>q.onsuccess());return q}})})};r.onsuccess()});return r}},
  $(){},msg:m=>messages.push(m)});
 vm.runInContext(read('etiquetar.js'),c,{filename:sourcePath('etiquetar.js')});
 vm.runInContext("H={nombre:'same|c0',w:1,h:1,scroll:'PHercA',database:db};mask={width:1,height:1};mctx={};",c);
 c.autoguardar();vm.runInContext("window.ROLLO='PHercB';window.ROLLO_CORTO='B';db=abrirDb('B');H={nombre:'same|c0',w:1,h:1,scroll:'PHercB',database:db};",c);
 timers.shift()();blobs.shift()();await new Promise(setImmediate);
 assert(stores.get('etiqA').has('same|c0'));assert(!stores.get('etiqB').has('same|c0'),'delayed autosave cannot write to the new scroll');
 c.autoguardar();timers.shift()();blobs.shift()();await new Promise(setImmediate);assert(stores.get('etiqB').has('same|c0'));
 vm.runInContext("pendingTest=0;pendiente=true;H.scroll='PHercA';H.database=abrirDb('A');db=abrirDb('B');",c);
 vm.runInContext(pick(html,'function flush(', 'async function montarMascara('),c);c.flush();
 vm.runInContext("db=abrirDb('B')",c);blobs.shift()();await new Promise(setImmediate);
 assert.equal(stores.get('etiqA').size,1);assert.equal(stores.get('etiqB').size,1);
}
async function revisions(){
 const c=vm.createContext({window:{ROLLO:'PHercA'},H:{nombre:'same|c0',scroll:'PHercA'},Date,localStorage:{getItem:()=>null,setItem(){}},
  visorKey:k=>k,$h:()=>null,visorPuedeGuardar:true,pintarCorrida(){},GUARDADA:{},claveG:i=>i.scroll+'|'+i.segmento});
 vm.runInContext(pick(tools,'const KP=', '/* ---------- lienzo'),c);
 vm.runInContext(pick(tools,'window.guardarCorridaJson=', '/* lo que work-3'),c);
 vm.runInContext("marcarEdicion();infoA={scroll:'PHercA',segmento:'same',clave_local:H.nombre,profundidad:0};revA=window.revisionMascara(infoA);H={nombre:'same|c0',scroll:'PHercB'};window.ROLLO='PHercB';marcarEdicion();infoB={...infoA,scroll:'PHercB'};revB=window.revisionMascara(infoB)",c);
 await vm.runInContext('window.guardarCorridaJson(infoA,revA)',c);
 assert.equal(vm.runInContext('window.revisionMascara(infoA)',c),0);assert(vm.runInContext('window.revisionMascara(infoB)',c)>0,'old-scroll acknowledgment cannot clear new-scroll edits');
}
(async()=>{await storage();await revisions();console.log('PASS: in-page scroll switches, missing calibration, old-owner metadata, separate mask stores and pending revisions')})().catch(e=>{console.error(e);process.exitCode=1});
