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

async function open(source, files, version, decoder = false) {
  const html = '<header><span id="count"></span></header><footer><span id="title"></span></footer><div id="notice"></div><button id="etiq"></button><a id="download"></a>';
  const dom = new JSDOM(html, {url: page + '?source=' + encodeURIComponent(source), runScripts: 'outside-only'});
  const w = dom.window;
  if (version) Object.defineProperty(w.document, 'currentScript', {value: {src: page + 'pages.js?v=' + version}});
  w.fetch = async (target, options) => {
    assert.equal(options.credentials, 'omit');
    const url = new URL(target, page);
    assert(!url.pathname.startsWith('/api/'));
    const body = files[url.href];
    if (typeof body === 'string') return new Response(body, {headers: {'Content-Type':'application/xml'}});
    return Object.hasOwn(files, url.href) ? Response.json(body) : new Response(null, {status: 404});
  };
  if (decoder) Object.defineProperty(w.navigator, 'serviceWorker', {
    value: {register: async () => ({}), controller: {scriptURL: page + 'raster-worker.js'}},
  });
  w.OFFICIAL_FRAME = /^\.\.\/catalog\/.+\/ink-detection\//;
  w.etiqOn = false;
  w.previewOf = () => null;
  await w.eval(bootstrap);
  return w;
}

test('official catalog uses its published preview, locks labeling and retains the original TIFF URL', async () => {
  const file = 'PHerc123/segments/segment/ink-detection/map.tif';
  const w = await open('official', {[page + 'official.json']: {root: root.slice(0,-1), entries, previews: {[file]: 'small.jpg'}}}, 'test-version');
  try {
    assert.equal(w.VISOR_STATIC.defaultSeriesId, 'official_0181c8dd4c267c2b5e04');
    const map = w.VISOR_STATIC.select(frame, 'fixed');
    assert.equal(map.original, root + file);
    assert.equal(w.VISOR_STATIC.mapUrl(frame, 'fixed'), root + 'small.jpg?viewer=cors');
    assert.equal(w.document.querySelector('#etiq').disabled, true);
    assert.equal(w.visorPuedeGuardar, false);
    assert(w.document.querySelector('#count').hidden);
    assert(w.document.querySelector('#title').hidden);
    assert.equal(w.document.querySelector('script').src, page + 'viewer-static.js?v=test-version');
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
      assert.equal(w.VISOR_STATIC.defaultSeriesId, null);
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

test('source picker exposes the presets and asks for a path only in custom mode', async () => {
  const preview = 'https://huggingface.co/datasets/test/resolve/main/entry/preview.jpg';
  const w = await open('ink-labels', {[page + 'ink-labels.json']: {root, entries}});
  try {
    const select = w.document.querySelector('header select'), input = w.document.querySelector('header input');
    assert.deepEqual(Array.from(select.options, o => o.value), ['official', 'ink-labels', 'custom']);
    assert.equal(select.value, 'ink-labels');
    assert.equal(select.selectedOptions[0].textContent, 'VSKinox Label Collection');
    assert(input.hidden);
    select.value = 'custom'; select.dispatchEvent(new w.Event('change'));
    assert(!input.hidden && input.required);
    assert.equal(w.VISOR_STATIC.select(preview, 'fixed').preview, true);
    assert.equal(w.VISOR_STATIC.mapUrl(preview, 'fixed'), preview);
    assert(w.document.querySelector('#etiq').disabled);
  } finally { w.close(); }
});

test('S3 image paths and a standalone HTTP manifest resolve to the published objects', async () => {
  const s3 = await open('s3://demo.bucket/images/paper.png', {});
  const http = await open(root + 'scans.json', {[root + 'scans.json']: [{...entries[0], frames: {0: 'nested/paper.png'}}]});
  try {
    assert.equal(s3.manifest[0].frames[0], 'https://s3.amazonaws.com/demo.bucket/images/paper.png');
    assert.equal(http.VISOR_STATIC.mapUrl('nested/paper.png','fixed'), root + 'nested/paper.png');
  } finally { s3.close(); http.close(); }
});

test('unindexed S3 prefix consumes every result page and preserves encoded image keys', async () => {
  const bucket = 'https://example-bucket.s3.amazonaws.com/';
  const list = bucket + '?list-type=2&encoding-type=url&prefix=maps%2F';
  const w = await open('s3://example-bucket/maps/', {
    [list]: '<ListBucketResult><Contents><Key>maps%2Fa%2Bb.png</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>',
    [list + '&continuation-token=next']: '<ListBucketResult><Contents><Key>maps%2Fb%20c.tif</Key></Contents><Contents><Key>maps%2Findex.txt</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'
  });
  try {
    assert.deepEqual(Array.from(w.manifest, e => e.frames[0]), [bucket + 'maps/a%2Bb.png',bucket + 'maps/b%20c.tif']);
  } finally { w.close(); }
});

test('Label switches the published comparison to the native style A grid', async () => {
  const preview = 'https://huggingface.co/datasets/test/resolve/main/entry/preview.jpg';
  const w = await open('ink-labels', {[page + 'ink-labels.json']: {root, entries}}, undefined, true);
  try {
    const viewer = w.VISOR_STATIC, button = w.document.querySelector('#etiq');
    w.show = () => viewer.select(preview, 'fixed');
    assert.equal(viewer.select(preview, 'fixed').preview, true);
    assert.equal(button.disabled, false);
    viewer.prepareLabel();
    assert.equal(viewer.reduced, false);
    const label = new URL('labels/style_A.png', preview).href;
    assert.equal(viewer.publishedLabel, label);
    assert.equal(new URL(viewer.mapUrl(preview, 'fixed')).searchParams.get('src'), label);
  } finally { w.close(); }
});
