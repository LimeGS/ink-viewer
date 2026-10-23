const {read, root, sourcePath} = require('./source.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
  constructor() { this.children = []; this.style = {}; this.classList = {add(){}}; }
  append(element) { this.children.push(element); }
  set innerHTML(value) { this.children = []; }
  addEventListener() {}
}
const elements = {depthWrap: new Element(), depth: new Element(), map: new Element()};
elements.depth.value = '0';
const context = {
  window: {}, console,
  document: {head: new Element(), getElementById: id => elements[id], createElement: () => new Element()},
  MutationObserver: class { observe() {} },
  LEG: {},
  group: {id: 'catalog_opaque_hash', catalogMeta: {lam: 'sheet--rev-123', modelo: 'base'}, frames: {'-2':'a','0':'b','2':'c'}},
};
vm.runInNewContext(read('hist_v5.js'), context,{filename:sourcePath('hist_v5.js')});
const bar = elements.depthWrap.children[0];
assert.deepEqual(bar.children.map(item => item.title), ['c-2 · no score','c0 · no score','c+2 · no score']);
context.LEG['sheet--rev-123'] = {max: 0.9, por_modelo: {
  base: {max: 0.15, mejor_centro: 0}, r3f: {max: 0.8, mejor_centro: 0}
}};
context.window.v5HistRepintar();
assert.deepEqual(bar.children.map(item => item.title), ['c-2 · no score','c0 · v5 0.150','c+2 · no score']);
context.group.catalogMeta.modelo = 'r3f';
context.window.v5HistRepintar();
assert.equal(bar.children[1].title, 'c0 · v5 0.800');
context.group.catalogMeta.modelo = 'unmeasured';
context.window.v5HistRepintar();
assert.equal(bar.children[1].title, 'c0 · no score');
context.group.scroll = 'PHerc0306B';
context.group.catalogMeta.modelo = 'base';
context.LEG['PHerc0306B/sheet--rev-123'] = {por_modelo: {base: {max: 0.4, mejor_centro: 0}}};
context.window.v5HistRepintar();
assert.equal(bar.children[1].title, 'c0 · v5 0.400');
context.group = {id: 'legacy__base17', frames: {'-2':'a','0':'b','2':'c'}};
context.LEG.legacy = {max: 0.7, mejor_centro: 2, por_centro: {'-02':0.2,'+00':0.3}};
context.window.v5HistRepintar();
assert.deepEqual(bar.children.map(item => item.title), ['c-2 · v5 0.200','c0 · v5 0.300','c+2 · v5 0.700']);
console.log('PASS: async score arrival, exact segment/model, measured centres only, legacy depth scores');
