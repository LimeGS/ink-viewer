const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {read,sourcePath}=require('./source.cjs');

const MAP='/api/mapa/catalog/PHercX/segments/seg-1/ink-detection/m.tif?escala=1';
const FRAME='../catalog/PHercX/segments/seg-1/ink-detection/m';

async function page({html,dims={ok:true,body:{w:10000,h:5000}},point=[60,40]}={}){
 const dom=new JSDOM(html??'<div class="toolbar"><a id="download">Open PNG</a></div><div id="viewport"></div>',
  {url:'http://localhost/all-gallery/index.html',runScripts:'outside-only'});
 const w=dom.window,calls={fetch:[],show:0,msg:[]};
 w.fetch=async url=>{calls.fetch.push(String(url));return {ok:dims.ok,json:async()=>dims.body}};
 w.show=()=>{calls.show++};w.msg=t=>{calls.msg.push(t)};
 const context=dom.getInternalVMContext();
 vm.runInContext('var group={id:"run",catalogMeta:{lam:"seg-1"}};function rp(e){return '+JSON.stringify(point)+'}',context);
 vm.runInContext(read('recorte.js'),context,{filename:sourcePath('recorte.js')});
 return {w,calls,r:w.recorteVista,$:id=>w.document.getElementById(id),run:code=>vm.runInContext(code,context)};
}
const plain=o=>JSON.parse(JSON.stringify(o));   // objects from the page's realm
const click=(w,el,x,y,down=[x,y])=>{el.dispatchEvent(new w.MouseEvent('pointerdown',{clientX:down[0],clientY:down[1],bubbles:true}));
 el.dispatchEvent(new w.MouseEvent('click',{clientX:x,clientY:y,bubbles:true}))};
const settle=()=>new Promise(r=>setTimeout(r,10));

test('the button appears on the reduced view and a click there opens a full-resolution crop',async()=>{
 const p=await page(),b=p.$('recorteBtn');
 assert.equal(b.nextElementSibling.id,'download');assert.equal(b.hidden,true,'hidden on full-resolution maps');
 p.r.reduced({url:MAP,w:100,h:50});assert.equal(b.hidden,false);assert.equal(b.textContent,'Label a crop');
 click(p.w,p.$('viewport'),5,5);await settle();assert.equal(p.calls.fetch.length,0,'not picking: clicks pan as usual');
 b.click();assert.equal(b.getAttribute('aria-pressed'),'true');assert.equal(b.textContent,'Click the map…');
 click(p.w,p.$('viewport'),50,50,[10,10]);await settle();assert.equal(p.calls.fetch.length,0,'a drag is ignored');
 click(p.w,p.$('viewport'),5,5);await settle();
 assert.deepEqual(p.calls.fetch,['/api/dims/catalog/PHercX/segments/seg-1/ink-detection/m.tif']);
 // (60, 40) on the 100 x 50 view is (6000, 4000) on the 10000 x 5000 map; an 8192 window on the 4096 grid, inside the map
 assert.deepEqual(plain(p.r.info()),{x:0,y:0,ancho:8192,alto:5000,ancho_mapa:10000,alto_mapa:5000});
 assert.equal(p.calls.show,1);assert.match(p.calls.msg.at(-1),/Loading a full-resolution crop/);
 assert.equal(p.r.query(FRAME),'&recorte=0,0,8192,5000');
 assert.equal(p.r.query(FRAME.replace('seg-1','seg-2')),'','other segments are never cropped');
 assert.equal(p.r.key(),'|r0,0');assert.equal(p.r.title(),' · crop at 0, 0 of 10000 × 5000');
 p.r.reduced(null);assert.equal(b.hidden,false);assert.equal(b.textContent,'Whole map');
 b.click();assert.equal(p.r.info(),null);assert.equal(p.calls.show,2,'back to the reduced view');
 assert.equal(p.r.key(),'');assert.equal(p.r.query(FRAME),'');assert.equal(p.r.title(),'');
});

test('picking works while the labeling panel blocks the viewport',async()=>{
 const p=await page(),vp=p.$('viewport');let reached=0;
 vp.addEventListener('pointerdown',e=>{reached++;e.stopImmediatePropagation()},true);   // as viewer.js does while labeling waits
 p.r.reduced({url:MAP,w:100,h:50});click(p.w,vp,5,5);assert.equal(reached,1,'not picking: the viewer still gets the press');
 p.$('recorteBtn').click();click(p.w,vp,5,5);await settle();
 assert.equal(reached,1,'picking: the press stays with the crop button');assert.equal(p.calls.show,1);
});

test('crops follow their segment and fall back when they cannot load',async()=>{
 const p=await page({point:[1,1]});
 assert.equal(p.r.failed(),false,'no crop: nothing to undo');
 p.r.reduced({url:MAP,w:100,h:50});p.$('recorteBtn').click();click(p.w,p.$('viewport'),5,5);await settle();
 assert.deepEqual(plain(p.r.info()),{x:0,y:0,ancho:8192,alto:5000,ancho_mapa:10000,alto_mapa:5000},'clamped to the corner');
 p.r.showing();assert.notEqual(p.r.info(),null,'same segment keeps the crop');
 assert.equal(p.r.failed(),true);assert.equal(p.r.info(),null);assert.match(p.calls.msg.at(-1),/could not be loaded/);
 p.r.reduced({url:MAP,w:100,h:50});p.$('recorteBtn').click();click(p.w,p.$('viewport'),5,5);await settle();
 p.run('group={id:"other",catalogMeta:{lam:"seg-2"}}');p.r.showing();assert.equal(p.r.info(),null,'another segment drops it');
 const big={w:40000,h:20000},view={w:100,h:50},at=q=>plain(p.r.windowAt(q,big,view));
 assert.deepEqual(at([60,40]),{x:20480,y:11808,ancho:8192,alto:8192,ancho_mapa:40000,alto_mapa:20000},'grid start; clamped at the bottom edge');
 assert.deepEqual(at([61,41]),at([60,40]),'a nearby click reopens the same crop');
 assert.equal(at([70,40]).x,24576,'farther away: the next grid window');
 assert.deepEqual(plain(p.r.windowAt([5,5],{w:300,h:200},{w:30,h:20})),{x:0,y:0,ancho:300,alto:200,ancho_mapa:300,alto_mapa:200},'small maps: the whole map');
 p.r.reduced(null);p.r.state.picking=true;await p.r.pick([1,1]);assert.equal(p.r.state.picking,false);assert.equal(p.r.info(),null,'nothing to crop without a reduced view');
});

test('a map whose size cannot be read is not cropped; no toolbar anchor still works',async()=>{
 const p=await page({html:'<div class="toolbar"></div>',dims:{ok:false}});
 assert.equal(p.w.document.querySelector('.toolbar').lastElementChild.id,'recorteBtn');
 p.r.reduced({url:MAP,w:100,h:50});await p.r.pick([1,1]);
 assert.equal(p.r.info(),null);assert.match(p.calls.msg.at(-1),/size could not be read/);assert.equal(p.calls.show,0);
});
