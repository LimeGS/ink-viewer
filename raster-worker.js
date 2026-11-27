/* Decode small ink maps in the browser. All other requests go straight to their host. */
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

async function renderTiff(url) {
  const src = new URL(url.searchParams.get('src'));
  if (!['http:', 'https:'].includes(src.protocol) || src.username || src.password) throw Error('Invalid map URL');
  const scale = Number(url.searchParams.get('scale'));
  if (![1, 4, 8].includes(scale)) throw Error('Invalid map scale');
  const res = await fetch(src, {credentials: 'omit', referrerPolicy: 'no-referrer'});
  if (!res.ok) throw Error('Map HTTP ' + res.status);
  // Refuse unbounded downloads, including chunked responses without Content-Length.
  const limit = 32 * 1024 * 1024;
  const reader = res.body.getReader();
  let size = 0;
  const chunks = [];
  if (Number(res.headers.get('Content-Length')) > limit) {
    await reader.cancel(); throw Error('Use the published preview or original TIFF');
  }
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw Error('TIFF exceeds browser download limit'); }
    chunks.push(value);
  }
  const tiff = await GeoTIFF.fromArrayBuffer(await new Blob(chunks).arrayBuffer());
  const image = await tiff.getImage();
  const w = image.getWidth(), h = image.getHeight(), channels = image.getSamplesPerPixel();
  const photo = image.getFileDirectory().getValue('PhotometricInterpretation');
  const bits = image.getBitsPerSample(0);
  const supported = ((channels === 1 && [0, 1].includes(photo)) || (channels === 3 && photo === 2))
    && bits >= 1 && bits <= 16 && Array.from({length: channels}, (_, i) => i)
      .every(i => image.getSampleFormat(i) === 1 && image.getBitsPerSample(i) === bits);
  if (w * h > 16e6 || Math.max(w, h) > 16384 || await tiff.getImageCount() !== 1 ||
      !supported) {
    throw Error('Use the published preview or original TIFF');
  }
  const width = Math.max(1, Math.floor(w / scale)), height = Math.max(1, Math.floor(h / scale));
  const samples = await image.readRasters({width, height, interleave: true});
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
importScripts('./geotiff.js');
