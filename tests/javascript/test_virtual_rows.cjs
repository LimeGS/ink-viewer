const {read, root} = require('./source.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=read('explorer_pro.js');
const fn=code.slice(code.indexOf(' function pintarVentana(){'),code.indexOf('\n function abrir(r)'));
const list={scrollTop:0,clientHeight:100,style:{setProperty(){}},replaces:0,replaceChildren(f){this.children=f.children;this.replaces++}};
let builds=0;
const node=()=>({children:[],style:{},classList:{toggle(){}},setAttribute(){},append(x){this.children.push(x)}});
const context=vm.createContext({Map,document:{createDocumentFragment:node,createElement:node},list,
 $:id=>id==='xpList'?list:null,F:{modo:'list',thumbs:false},FLAT:Array.from({length:100},(_,i)=>({sub:true,it:{i},r:{}})),
 OFF:Array.from({length:101},(_,i)=>i*26),idxDe:y=>Math.floor(y/26),paintedWindow:null,visibleRows:new Map(),
 RHT:250,lamActual:()=>null,group:{},manifest:Array.from({length:100},()=>({})),subFila:()=>{builds++;return node()}});
vm.runInContext(fn+';pintarVentana()',context);
const first=list.children[1],initialBuilds=builds;
list.scrollTop=1;vm.runInContext('pintarVentana()',context);
assert.equal(list.replaces,1,'scrolling inside the same virtual window must not rebuild DOM');
list.scrollTop=26;vm.runInContext('pintarVentana()',context);
assert.equal(list.children[1],first,'overlapping rows must retain their DOM and image nodes');
assert.equal(builds,initialBuilds+1,'only the entering row should be created');
context.paintedWindow=null;context.visibleRows.clear();vm.runInContext('pintarVentana()',context);
assert.notEqual(list.children[1],first,'data invalidation must rebuild the displayed content');
console.log('PASS: virtual scrolling reuses rows and refreshes after invalidation');
