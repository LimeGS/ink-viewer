// Run: node test_scale.cjs
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/rollo_visor.js','utf8');
function scale(metadata){
  const context={window:{ROLLO_SERVIDOR:metadata},location:{search:'?rollo=PHercTEST'},URLSearchParams,
    XMLHttpRequest:class{open(){}send(){this.status=404}}};
  vm.runInNewContext(source,context);
  return context.window;
}
assert.equal(scale(null).VOXEL_UM,null);
assert.equal(scale(null).PASO_HOJA_UM,null);
assert.equal(scale({scroll:'other',voxel_um:99}).VOXEL_UM,null);
assert.equal(scale({scroll:'PHercTEST',voxel_um:7}).VOXEL_UM,7);
const context={fmt:(n,d)=>Number(n).toFixed(d)};
vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname+'/guias_medicion.js','utf8').match(/^const mmTxt=.*$/m)[0],context);
assert.equal(vm.runInContext('mmTxt(50,{um:null,ver:false})',context),'50.0 px (scale unknown)');
assert.equal(vm.runInContext('mmTxt(50,{um:20,ver:true})',context),'1.00 mm');
console.log('PASS: unknown physical scale stays unknown; known scale and pixel measurements preserved');
