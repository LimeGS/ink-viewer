const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {read,sourcePath}=require('./source.cjs');

/* inksdk.js against a scripted /api/inksdk server. `routes` maps a URL prefix to a reply (or a function of the request). */
const GROUPED='<div class="toolbar"><div class="group"><button id="label">Label</button><a id="download">Open PNG</a></div></div>';
async function page(routes,group,html=GROUPED){
 const dom=new JSDOM(html,
  {url:'http://localhost/all-gallery/index.html',runScripts:'outside-only'});
 const w=dom.window,calls=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 w.fetch=async(url,init={})=>{
  calls.push({url:String(url),init});
  const key=Object.keys(routes).find(k=>String(url).startsWith(k));
  if(!key)throw new Error('offline');
  let reply=routes[key];if(typeof reply==='function')reply=reply(String(url),init);
  return {ok:reply.status===undefined||reply.status<300,status:reply.status||200,json:async()=>reply.body};
 };
 const context=dom.getInternalVMContext();
 if(group!==undefined)vm.runInContext('var group='+JSON.stringify(group),context);
 vm.runInContext(read('inksdk.js'),context,{filename:sourcePath('inksdk.js')});
 const shown=await w.inksdkJobs.ready;
 w.inksdkJobs.state.interval=1;
 return {w,calls,shown,$:id=>w.document.getElementById(id)};
}
const seg={catalogMeta:{lam:'seg-1',scroll:'PHerc0841'}};
const vol=(name,res,perfiles)=>({name,res,perfiles});

test('button hidden unless ink-sdk is available and the source accepts writes',async()=>{
 for(const body of [{disponible:false,escritura:true},{disponible:true,escritura:false},null]){
  const p=await page({'/api/inksdk':{body}},seg);
  assert.equal(p.shown,false);assert.equal(p.$('inksdkBtn'),null);
 }
 const offline=await page({},seg);
 assert.equal(offline.shown,false);
});

test('button goes beside Open PNG inside a regrouped toolbar, or at the end of a toolbar without it',async()=>{
 const routes={'/api/inksdk':{body:{disponible:true,escritura:true}}};
 const grouped=await page(routes,seg);
 assert.equal(grouped.$('inksdkBtn').parentNode.className,'group');assert.equal(grouped.$('inksdkBtn').nextElementSibling.id,'download');
 const bare=await page(routes,seg,'<div class="toolbar"><button id="label">Label</button></div>');
 assert.equal(bare.$('inksdkBtn').previousElementSibling.id,'label');
});

test('dialog lists volumes and compatible models, runs a job and reloads when done',async()=>{
 let polls=0,reloaded=false;
 const p=await page({
  '/api/inksdk/volumenes':{body:[vol('9.366um-1.2m-113keV-volume-20250821151531.zarr','9.366',['ink_9um@reader-v3','ink_9um@rectina-m4']),
                                 vol('2.403um-0.2m-77keV-volume-20260319130212.zarr','2.403',[])]},
  '/api/inksdk/trabajos':(url,init)=>init.method==='POST'?{status:202,body:{id:'j1'}}
   :{body:[{id:'j1',estado:['en cola','copiando','inferencia','otro','listo'][Math.min(polls++,4)],mapas:['a.png','b.png']}]},
  '/api/inksdk':{body:{disponible:true,escritura:true}}},seg);
 assert.equal(p.shown,true);
 const button=p.$('inksdkBtn');assert.equal(button.nextElementSibling.id,'download');
 p.w.inksdkJobs.state.reload=()=>{reloaded=true};
 await p.w.inksdkJobs.abrir();
 assert.equal(p.$('inksdkDlg').open,true);
 assert.match(p.calls.at(-1).url,/rollo=PHerc0841&segmento=seg-1$/);
 assert.deepEqual([...p.$('inksdkPerfil').options].map(o=>o.value),['ink_9um@reader-v3','ink_9um@rectina-m4']);
 assert.equal(p.$('inksdkRun').disabled,false);
 p.$('inksdkVol').value='2.403um-0.2m-77keV-volume-20260319130212.zarr';p.$('inksdkVol').onchange();
 assert.equal(p.$('inksdkRun').disabled,true);assert.match(p.$('inksdkEstado').textContent,/No model reads 2.403/);
 p.$('inksdkVol').value='9.366um-1.2m-113keV-volume-20250821151531.zarr';p.$('inksdkVol').onchange();
 await p.w.inksdkJobs.correr();
 const post=p.calls.find(c=>c.init.method==='POST');
 assert.deepEqual(JSON.parse(post.init.body),{rollo:'PHerc0841',segmento:'seg-1',volumen:'9.366um-1.2m-113keV-volume-20250821151531.zarr',perfil:'ink_9um@reader-v3'});
 assert.equal(reloaded,true);assert.match(p.$('inksdkEstado').textContent,/Done: 2 maps/);
});

test('errors are shown and leave the Run button usable',async()=>{
 const routes={'/api/inksdk/volumenes':{body:[vol('v.zarr','9.362',['p@x'])]},
  '/api/inksdk/trabajos':(url,init)=>init.method==='POST'?{status:400,body:{error:'Invalid sample or segment'}}:{body:[]},
  '/api/inksdk':{body:{disponible:true,escritura:true}}};
 const p=await page(routes,seg);
 await p.w.inksdkJobs.abrir();await p.w.inksdkJobs.correr();
 assert.match(p.$('inksdkEstado').textContent,/Error: Invalid sample/);assert.equal(p.$('inksdkRun').disabled,false);
 routes['/api/inksdk/trabajos']=(url,init)=>init.method==='POST'?{status:503,body:{}}:{body:[]};
 await p.w.inksdkJobs.correr();assert.match(p.$('inksdkEstado').textContent,/Error: 503/);
 await p.w.inksdkJobs.seguir('gone');assert.match(p.$('inksdkEstado').textContent,/no longer known/);
 routes['/api/inksdk/trabajos']={body:[{id:'j9',estado:'error',error:'ink-sdk failed: boom'}]};
 await p.w.inksdkJobs.seguir('j9');assert.match(p.$('inksdkEstado').textContent,/Error: ink-sdk failed: boom/);
 assert.equal(p.$('inksdkRun').disabled,false);
});

test('no segment open, or a segment without surface volumes',async()=>{
 const routes={'/api/inksdk/volumenes':{body:[]},'/api/inksdk':{body:{disponible:true,escritura:true}}};
 const none=await page(routes);
 await none.w.inksdkJobs.abrir();assert.match(none.$('inksdkEstado').textContent,/Open a catalog segment first/);
 const empty=await page(routes,seg);
 await empty.w.inksdkJobs.abrir();assert.match(empty.$('inksdkEstado').textContent,/no surface-volumes/);
 assert.equal(empty.$('inksdkRun').disabled,true);
 empty.$('inksdkBtn').click();assert.equal(empty.$('inksdkDlg').open,true);
});
