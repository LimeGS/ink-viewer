/* Decode ink maps and full-resolution TIFF windows in the browser. All other requests go straight to their host. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
const labelPath = new URL('ink-label.png', self.registration.scope).href;
const rasterPath = new URL('tiff.png', self.registration.scope).href;
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  const path = url.origin + url.pathname;
  const render = path === labelPath ? renderLabel : path === rasterPath ? renderTiff : null;
  if (render) event.respondWith(render(url).catch(error => new Response(error.message, {status: 422})));
});

// Published label PNGs encode four categorical values nearly indistinguishable in greyscale.
async function renderLabel(url) {
  const src = new URL(url.searchParams.get('src'));
  if (src.origin !== 'https://huggingface.co' || !src.pathname.startsWith('/datasets/vincentl065/herculaneum-ink-labels/resolve/') ||
      !/\/labels\/style_[A-D]\.png$/.test(src.pathname)) throw Error('Invalid label URL');
  const response = await fetch(src, {credentials: 'omit'});
  if (!response.ok) throw Error('Label HTTP ' + response.status);
  const image = await createImageBitmap(await response.blob(), {colorSpaceConversion: 'none'});
  try {
    if (image.width * image.height > 16e6) throw Error('Label is too large');
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height);
    const colors = {0: [48, 86, 120], 1: [255, 216, 64], 2: [163, 163, 163], 255: [10, 10, 10]};
    for (let i = 0; i < pixels.data.length; i += 4) {
      const color = colors[pixels.data[i]];
      if (!color) throw Error('Unexpected label class');
      pixels.data[i] = color[0]; pixels.data[i+1] = color[1]; pixels.data[i+2] = color[2];
    }
    ctx.putImageData(pixels, 0, 0);
    return new Response(await canvas.convertToBlob({type: 'image/png'}), {headers: {'Content-Type': 'image/png'}});
  } finally { image.close(); }
}

const maxTiffBytes = 32 * 1024 * 1024;
async function readBounded(response, limit) {
  const reader = response.body.getReader();
  if (Number(response.headers.get('Content-Length')) > limit) {
    await reader.cancel();
    throw Error('TIFF exceeds browser download limit');
  }
  let size = 0;
  const chunks = [];
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Error('TIFF exceeds browser download limit');
    }
    chunks.push(value);
  }
  return new Blob(chunks).arrayBuffer();
}

function openTiffByRange(src) {
  let requested = 0;
  const client = {
    async request({headers, signal}) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
      const length = match ? Number(match[2]) - Number(match[1]) + 1 : 0;
      if (!(length > 0) || (requested += length) > maxTiffBytes) throw Error('Crop exceeds the range download limit');
      const response = await fetch(src, {
        headers, signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
      });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw Error('The TIFF host must support byte-range requests');
      }
      return {ok: true, status: 206, getHeader: name => response.headers.get(name),
        getData: () => readBounded(response, length)};
    }
  };
  return GeoTIFF.fromCustomClient(client, {blockSize: 65536, cacheSize: 64, allowFullFile: false});
}

async function renderTiff(url) {
  const src = new URL(url.searchParams.get('src'));
  if (!['http:', 'https:'].includes(src.protocol) || src.username || src.password) throw Error('Invalid map URL');
  const scale = Number(url.searchParams.get('scale'));
  if (![1, 4, 8].includes(scale)) throw Error('Invalid map scale');
  const dimensions = url.searchParams.get('mode') === 'dimensions';
  const crop = url.searchParams.get('crop');
  let tiff;
  if (dimensions || crop !== null) tiff = await openTiffByRange(src);
  else {
    const response = await fetch(src, {credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (!response.ok) throw Error('Map HTTP ' + response.status);
    tiff = await GeoTIFF.fromArrayBuffer(await readBounded(response, maxTiffBytes));
  }
  const image = await tiff.getImage();
  const w = image.getWidth(), h = image.getHeight(), channels = image.getSamplesPerPixel();
  const photo = image.getFileDirectory().getValue('PhotometricInterpretation');
  const bits = image.getBitsPerSample(0);
  const supported = ((channels === 1 && [0, 1].includes(photo)) || (channels === 3 && photo === 2))
    && bits >= 1 && bits <= 16 && Array.from({length: channels}, (_, i) => i)
      .every(i => image.getSampleFormat(i) === 1 && image.getBitsPerSample(i) === bits);
  if (!supported || await tiff.getImageCount() !== 1) throw Error('Unsupported TIFF format');
  if (dimensions) return Response.json({w, h});

  let width, height, window;
  if (crop !== null) {
    if (scale !== 1 || !/^\d+,\d+,\d+,\d+$/.test(crop)) throw Error('Invalid TIFF crop');
    const [x, y, cw, ch] = crop.split(',').map(Number);
    if (![x,y,cw,ch].every(Number.isSafeInteger) || cw < 1 || ch < 1 ||
        Math.max(cw,ch) > 2048 || x + cw > w || y + ch > h) throw Error('TIFF crop is outside the map');
    const tw = image.getTileWidth(), th = image.getTileHeight();
    const tilesAcross = Math.ceil((x + cw) / tw) - Math.floor(x / tw);
    const tilesDown = Math.ceil((y + ch) / th) - Math.floor(y / th);
    if (tw * th * tilesAcross * tilesDown * channels * Math.ceil(bits / 8) > maxTiffBytes)
      throw Error('The TIFF blocks are too large to decode this crop');
    window = [x, y, x + cw, y + ch];
    width = cw;
    height = ch;
  } else {
    if (w * h > 16e6 || Math.max(w, h) > 16384) throw Error('Use the published preview or original TIFF');
    width = Math.max(1, Math.floor(w / scale));
    height = Math.max(1, Math.floor(h / scale));
  }
  const samples = await image.readRasters({window, width, height, interleave: true});
  const toByte = 255 / (2 ** bits - 1);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(width, height);
  for (let i = 0, j = 0; i < samples.length; i += channels, j += 4) {
    const first = samples[i] * toByte;
    pixels.data[j] = photo === 0 ? 255 - first : first;
    pixels.data[j + 1] = channels === 1 ? pixels.data[j] : samples[i + 1] * toByte;
    pixels.data[j + 2] = channels === 1 ? pixels.data[j] : samples[i + 2] * toByte;
    pixels.data[j + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return new Response(await canvas.convertToBlob({type: 'image/png'}), {headers: {'Content-Type': 'image/png'}});
}
importScripts('./geotiff.js' + self.location.search);
