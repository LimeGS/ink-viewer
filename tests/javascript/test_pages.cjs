const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const bootstrap = fs.readFileSync(path.join(__dirname, '../../static/pages.js'), 'utf8');
const page = 'https://example.org/ink-viewer/';
const root = 'https://data.example.org/run/';
const frame = '../catalog/PHerc123/segments/segment/ink-detection/map.tif';
const entries = [{id: 'series', scroll: 'PHerc123', frames: {0: frame}}];

async function open(source, files) {
  const html = '<header></header><div id="notice"></div><button id="etiq"></button><a id="download"></a>';
  const dom = new JSDOM(html, {url: page + '?source=' + encodeURIComponent(source), runScripts: 'outside-only'});
  const w = dom.window;
  w.fetch = async (target, options) => {
    assert.equal(options.credentials, 'omit');
    const url = new URL(target, page);
    assert(!url.pathname.startsWith('/api/'));
    return Object.hasOwn(files, url.href) ? Response.json(files[url.href]) : new Response(null, {status: 404});
  };
  w.OFFICIAL_FRAME = /^\.\.\/catalog\/.+\/ink-detection\//;
  w.etiqOn = false;
  await w.eval(bootstrap);
  return w;
}

test('official catalog uses its published preview, locks labeling and retains the original TIFF URL', async () => {
  const file = 'PHerc123/segments/segment/ink-detection/map.tif';
  const w = await open('official', {[page + 'official.json']: {root: root.slice(0,-1), entries, previews: {[file]: 'small.jpg'}}});
  try {
    const map = w.VISOR_STATIC.select(frame, 'fixed');
    assert.equal(map.original, root + file);
    assert.equal(w.VISOR_STATIC.mapUrl(frame, 'fixed'), root + 'small.jpg');
    assert.equal(w.document.querySelector('#etiq').disabled, true);
    assert.equal(w.visorPuedeGuardar, false);
    assert.equal(w.document.querySelector('script').src, page + 'viewer-static.js');
  } finally { w.close(); }
});

test('sample and document roots resolve maps, metadata and labels against the chosen dataset', async () => {
  for (const layout of ['sample', 'docroot']) {
    const files = layout === 'sample' ? {
      [root + '_viewer/index-info.json']: {schema: 'vesuvius.viewer-index.v1', layout, scroll: 'PHerc123'},
      [root + '_viewer/manifest.json']: entries
    } : {[root + 'all-gallery/manifest.json']: entries};
    files[root + 'rollos/PHerc123.json'] = {scroll: 'PHerc123', voxel_um: 8.2};
    const w = await open(root, files);
    try {
      const folder = layout === 'sample' ? '' : 'catalog/PHerc123/';
      const png = frame.replace(/\.tif$/, '');
      assert.equal(w.VISOR_STATIC.mapUrl(png, 'global'), root + folder + 'segments/segment/ink-detection/map-global.png');
      assert.equal(w.VISOR_STATIC.select(png, 'fixed').preview, false);
      assert.equal(w.document.querySelector('#etiq').disabled, false);
      assert.equal(w.VISOR_BOOTSTRAP.rollos.PHerc123.voxel_um, 8.2);
      assert(w.visorKey('drawing').includes(root));
    } finally { w.close(); }
  }
});

test('unavailable remote index leaves the source picker usable', async () => {
  const w = await open(root, {});
  try {
    assert.match(w.document.querySelector('#notice').textContent, /Could not open this dataset/);
    assert(w.document.querySelector('header input'));
    assert.equal(w.document.querySelector('script'), null);
  } finally { w.close(); }
});
