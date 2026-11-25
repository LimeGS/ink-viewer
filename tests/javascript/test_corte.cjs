const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {read,sourcePath}=require('./source.cjs');

const VOL='20250821151531';
const FRAME='../catalog/PHerc0841/segments/seg-1/ink-detection/PHerc0841-seg-1-9.366um-1.2m-113keV-volume-'+VOL+'-20261113203332-ink_9um_reader-v3-fwd-tile128-stride64';
const GROUP={catalogMeta:{lam:'seg-1',scroll:'PHerc0841'},frames:{0:FRAME}};

async function page({group=GROUP,reply,html,noRp}={}){
 const dom=new JSDOM(html??'<div class="toolbar"><div class="group"><a id="download">Open PNG</a></div></div><div id="viewport"></div>',
  {url:'http://localhost/all-gallery/index.html',runScripts:'outside-only'});
 const w=dom.window,calls=[];
 w.HTMLDialogElement.prototype.show=function(){this.open=true};
 w.URL.createObjectURL=()=> 'blob:corte';
 w.fetch=async url=>{calls.push(String(url));const r=reply||{status:200,headers:{'X-Corte':JSON.stringify({z:14.2,proportional:true})},body:{}};
  return {ok:r.status<300,status:r.status,headers:{get:k=>(r.headers||{})[k]||null},json:async()=>{if(r.badJson)throw new Error('x');return r.body},blob:async()=>new w.Blob(['png'])}};
 const context=dom.getInternalVMContext();
 vm.runInContext((group?'var group='+JSON.stringify(group)+';':'')+'var curW=80,curH=36;'+(noRp?'':'function rp(e){return [8.4,11.6]}'),context);
 vm.runInContext(read('corte.js'),context,{filename:sourcePath('corte.js')});
 await w.corteVista.ready;
 return {w,calls,$:id=>w.document.getElementById(id)};
}
const click=(w,el,x,y,down=[x,y])=>{el.dispatchEvent(new w.MouseEvent('pointerdown',{clientX:down[0],clientY:down[1],bubbles:true}));
 el.dispatchEvent(new w.MouseEvent('click',{clientX:x,clientY:y,bubbles:true}))};
const settle=()=>new Promise(r=>setTimeout(r,10));

test('button toggles the mode; a click (not a drag) fetches the slice for the map point',async()=>{
 const p=await page();
 const b=p.$('corteBtn');assert.equal(b.nextElementSibling.id,'download');
 click(p.w,p.$('viewport'),5,5);await settle();assert.equal(p.calls.length,0,'mode off: nothing');
 b.click();assert.equal(b.getAttribute('aria-pressed'),'true');
 click(p.w,p.$('viewport'),50,50,[10,10]);await settle();assert.equal(p.calls.length,0,'a drag is ignored');
 click(p.w,p.$('viewport'),5,5);await settle();
 assert.equal(p.calls[0],'/api/corte?rollo=PHerc0841&segmento=seg-1&volumen='+VOL+'&u=8&v=12&w=80&h=36&res=9.366&dist=1.2&kev=113');
 assert.equal(p.$('corteDlg').open,true);assert.equal(p.$('corteImg').hidden,false);
 assert.match(p.$('corteEstado').textContent,/CT z 14.*proportional/);
 b.click();assert.equal(b.getAttribute('aria-pressed'),'false');
});

test('errors and missing context are explained',async()=>{
 const err=await page({reply:{status:404,body:{error:'No mesh of seg-1 on volume '+VOL}}});
 await err.w.corteVista.mostrar([1,2]);assert.match(err.$('corteEstado').textContent,/No cross-section: No mesh/);
 const bad=await page({reply:{status:501,badJson:true}});
 await bad.w.corteVista.mostrar([1,2]);assert.match(bad.$('corteEstado').textContent,/No cross-section: 501/);
 const none=await page({group:null});
 await none.w.corteVista.mostrar([1,2]);assert.match(none.$('corteEstado').textContent,/Open a catalog segment first/);
 const unnamed=await page({group:{catalogMeta:{lam:'s',scroll:'PHerc1'},frames:{0:'../catalog/x/ink-detection/m'}}});
 await unnamed.w.corteVista.mostrar([1,2]);assert.match(unnamed.$('corteEstado').textContent,/does not name its CT volume/);
 assert.equal(unnamed.w.corteVista.volumeOf({maximum:FRAME}),VOL);assert.deepEqual({...unnamed.w.corteVista.scanOf(null)},{});assert.equal(unnamed.w.corteVista.volumeOf(null),null);
});

test('toolbar without Open PNG or viewport, and no rp()',async()=>{
 const p=await page({html:'<div class="toolbar"><button id="label">Label</button></div>',noRp:true});
 assert.equal(p.$('corteBtn').previousElementSibling.id,'label');
 const q=await page({noRp:true});q.$('corteBtn').click();
 click(q.w,q.$('viewport'),5,5);await settle();assert.equal(q.calls.length,0);
});

test('on a crop, the point and the map size refer to the whole map',async()=>{
 const p=await page();
 p.w.recorteVista={info:()=>({x:100,y:200,ancho:4096,alto:4096,ancho_mapa:9000,alto_mapa:8000})};
 await p.w.corteVista.mostrar([1.2,2.4]);
 assert.match(p.calls[0],/[?&]u=101&v=202&w=9000&h=8000&/);
});
