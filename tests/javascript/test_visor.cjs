const {read, root} = require('./source.cjs');
// Run with: node tests/javascript/test_visor.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = read('viewer.js'), explorer = read('explorer_pro.js');
const section = (text, from, to) => {
  const start = text.indexOf(from), end = text.indexOf(to, start);
  assert(start >= 0 && end > start, `Missing source section: ${from}`);
  return text.slice(start, end);
};

for (const name of fs.readdirSync(require('node:path').join(root, 'js')).filter(name => name.endsWith('.js')))
  new vm.Script(read(name), {filename: name});
for (const match of read('index.html').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  new vm.Script(match[1], {filename: 'index.html'});
assert.equal((explorer.match(/function v5De\(/g) || []).length, 1);
assert.equal((explorer.match(/id="xpV5m"/g) || []).length, 1);
const page=read('index.html');
assert(page.indexOf('manifest-c019-local.js') < page.indexOf('src="js/viewer.js"'));
assert(page.indexOf('src="js/viewer.js"') < page.indexOf('src="js/viewer-tools.js"'));

const context = vm.createContext({URL, URLSearchParams});
const run = code => vm.runInContext(code, context);
const meshContext=vm.createContext({window:{VISOR_ORIGEN:{origen:'/workspace/catalog/PHerc0306B',layout:'sample',scroll:'PHerc0306B'}}});
vm.runInContext(section(explorer,'function meshLocation(', 'function subFila('),meshContext);
const mesh={meshAssociation:{meshPath:'../catalog/PHerc0306B/segments/s/mesh/tifxyz'}};
meshContext.mesh=mesh;
assert.equal(vm.runInContext('meshLocation(mesh)',meshContext),'/workspace/catalog/PHerc0306B/segments/s/mesh/tifxyz');
assert.equal(vm.runInContext('meshLocation({})',meshContext),'Mesh path unavailable');
vm.runInContext("window.VISOR_ORIGEN={origen:'s3://bucket',layout:'catalog'}",meshContext);
assert.equal(vm.runInContext('meshLocation(mesh)',meshContext),'s3://bucket/PHerc0306B/segments/s/mesh/tifxyz');
run(section(html, 'const OFFICIAL_FRAME=', '/* The catalog publisher'));
assert.equal(run('mapUrl("../catalog/PHerc0306B/segments/s/ink-detection/public.tif","fixed",8)'),
  '/api/mapa/catalog/PHerc0306B/segments/s/ink-detection/public.tif?escala=8');
assert.equal(run('mapUrl("../catalog/PHerc0306B/segments/s/ink-detection/public.tiff","global")'),
  '/api/mapa/catalog/PHerc0306B/segments/s/ink-detection/public-global.tiff?escala=1');
assert.equal(run('mapUrl("../catalog/PHerc0306B/segments/s/ink-detection/public.png","fixed")'),
  '../catalog/PHerc0306B/segments/s/ink-detection/public.png');
const grouping = vm.createContext({manifest: ['PHerc0306B','PHerc0800'].map(scroll =>
  ({frames:{0:`../catalog/${scroll}/segments/shared/ink-detection/map`},
    catalogMeta:{lam:'shared',modelo:'base',cara:'fwd',scroll}})), meta:g=>g.catalogMeta});
vm.runInContext(section(html, 'const segRuta=', 'const ordCarpeta='), grouping);
assert.equal(vm.runInContext('LAM.size', grouping), 2);
assert.deepEqual([...vm.runInContext('[...LAM.keys()]', grouping)], ['PHerc0306B/shared','PHerc0800/shared']);
run(`let F={thumbs:true},FLAT=[],VIS=[],ABIERTAS=new Set();
  const manifest=[
    {frames:{0:'../catalog/PHerc0800/segments/s/ink-detection/base-c+00'}},
    {frames:{0:'legacy/ra_c+00'}},
    {frames:{0:'legacy/r3f_c+00'}},
    {frames:{'-4':'legacy/base_c-04','2':'legacy/base_c+02'}}
  ];`);
run(section(explorer, 'const RHT=250', 'function plegar'));
run(`VIS=[{lam:'s',e:{items:[{i:0,hoja:'s',modelo:'base'}]}},
  {lam:'t',e:{items:[{i:1,hoja:'t',modelo:'ra_congelado'}]}}];
  ABIERTAS.add('s');armarFlat();`);
assert.deepEqual([...run('OFF')], [0,250,276,526]);
assert.deepEqual([0,249,250,275,276,525,526].map(y => run(`idxDe(${y})`)), [0,0,1,1,2,2,3]);
run('F.thumbs=false;armarFlat()');
assert.deepEqual([...run('OFF')], [0,26,52,78]);
run('VIS=[];armarFlat()');
assert.deepEqual([...run('OFF')], [0]);
assert.equal(run('idxDe(100)'), 0);
assert.equal(run('thumbDe({e:{items:[]}})'), null);
run(`const row={e:{items:[{i:0,modelo:'base'},{i:1,modelo:'ra_congelado'},
  {i:3,modelo:'r3f-evo'},{i:2,modelo:'r3f_etiq'}]}};`);
assert.equal(run('thumbDe(row).u'), 'legacy/r3f_c+00/fixed_lo8.jpg');
assert.equal(run('thumbDe(row,/base/i).u'), '../catalog/PHerc0800/segments/s/ink-detection/downsampled/base-c+00-ds8.jpg');
assert.equal(run('thumbDe(row,/missing/i)'), null);
run('row.e.items.pop()');
assert.equal(run('thumbDe(row).u'), 'legacy/ra_c+00/fixed_lo8.jpg');
assert.equal(run('thumbDe({e:{items:[{i:3,modelo:"base"}]}}).u'), 'legacy/base_c+02/fixed_lo8.jpg');
assert.equal(run('thumbDe({e:{items:[{i:0,modelo:"base"}]}}).zoom'),
  '../catalog/PHerc0800/segments/s/ink-detection/downsampled/base-c+00-ds4.jpg');

run(`const location={href:'http://localhost/all-gallery/index.html',search:'',hash:''};`);
run(section(html, 'const hasVerifiedMeshAssociation=', '/* multi-rollo (29-sep)'));
run(section(html,'function mostrarSinVerificar(', 'const SIN_VERIFICAR='));
assert.equal(run('mostrarSinVerificar([{catalogMeta:{},frames:{0:"x"}}],{},null,null)'),true);
assert.equal(run('mostrarSinVerificar([{catalogMeta:{},frames:{0:"x"}}],{},"0",null)'),false);
assert.equal(run('mostrarSinVerificar([{catalogMeta:{},frames:{0:"x"}}],null,null,null)'),false);
assert.equal(run('mostrarSinVerificar([],null,"0","1")'),true);
run(`let group={id:'unverified',catalogMeta:{},frames:{0:'x'}}, projection=false,
  slider={value:0},etiqOn=false,vistaModo='mod',SIN_VERIFICAR=true;
  const history={replaceState(a,b,url){this.url=url}};const idParts=()=>null;`);
run(section(html, 'function syncHash(', 'function applyHash('));
run('syncHash()');
assert.equal(new URLSearchParams(run('history.url').slice(1)).get('sinverificar'), '1');
run(`group={id:'verified',catalogMeta:{},mapAvailable:true,frames:{0:'x'},
  meshAssociation:{status:'VERIFIED',meshId:'m',meshPath:'p',receiptPath:'r'}};syncHash()`);
assert.equal(new URLSearchParams(run('history.url').slice(1)).has('sinverificar'), false);
const redirectContext=vm.createContext({URLSearchParams,location:{hash:'#id=target&centro=4'},
  manifest:[{id:'target'}],group:undefined,select(){}});
vm.runInContext(section(html,'function applyHash(',"addEventListener('hashchange'"),redirectContext);
assert.equal(vm.runInContext('applyHash()',redirectContext),true);
redirectContext.group={id:'previous'};
assert.equal(vm.runInContext('applyHash()',redirectContext),true);
console.log('PASS: viewer syntax, thumbnail priorities/depth/URLs, variable rows, scroll navigation and unverified links');
