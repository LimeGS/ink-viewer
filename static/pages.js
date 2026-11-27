/* GitHub Pages entry point. Dataset indexes are JSON; only scripts shipped with this viewer run. */
(async function () {
  const page = new URL(location.href), source = page.searchParams.get('source') || 'official';
  const header = document.querySelector('header'), picker = document.createElement('form');
  const input = document.createElement('input'), open = document.createElement('button');
  input.type = 'text'; input.value = source; input.required = true;
  input.setAttribute('aria-label', 'Dataset URL or official'); input.placeholder = 'Dataset URL or official';
  open.textContent = 'Open source'; picker.className = 'staticSource'; picker.append(input, open); header.append(picker);
  const notice = document.getElementById('notice');
  const say = text => { notice.hidden = false; notice.textContent = text; };
  picker.onsubmit = event => {
    event.preventDefault();
    const next = new URL(location.href); next.search = ''; next.hash = '';
    if (input.value.trim() !== 'official') next.searchParams.set('source', input.value.trim());
    location.assign(next);
  };
  function httpURL(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use a public HTTP(S) dataset URL.');
    return url;
  }
  async function getJSON(url, optional = false) {
    const res = await fetch(url, {credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (optional && [403, 404].includes(res.status)) return null;
    if (!res.ok) throw Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }
  let root, info, entries, previews = {};
  const official = source === 'official' || [
    's3://vesuvius-challenge-open-data',
    'https://vesuvius-challenge-open-data.s3.amazonaws.com'
  ].includes(source.replace(/\/+$/, ''));
  try {
    say('Loading dataset…');
    if (official) {
      const catalog = await getJSON(new URL('official.json', page));
      root = httpURL(catalog.root + '/'); entries = catalog.entries; previews = catalog.previews;
      info = {layout: 'catalog'};
    } else {
      root = httpURL(source); root.pathname = root.pathname.replace(/\/?$/, '/');
      if (root.search || root.hash) throw Error('Enter the indexed dataset root URL without a query or fragment.');
      info = await getJSON(new URL('_viewer/index-info.json', root), true);
      if (!info) {
        info = {layout: 'docroot'};
        entries = await getJSON(new URL('all-gallery/manifest.json', root), true)
          || await getJSON(new URL('catalog/_viewer/manifest-work3.json', root));
      } else {
        if (info.schema !== 'vesuvius.viewer-index.v1' || !['catalog', 'sample', 'docroot'].includes(info.layout) ||
            (info.layout === 'sample' && !/^PHerc[0-9A-Za-z]+$/.test(info.scroll))) {
          throw Error('Invalid ink-viewer index.');
        }
        entries = await getJSON(new URL('_viewer/manifest.json', root));
      }
    }
    if (!Array.isArray(entries) || !entries.length || !entries.every(g => typeof g?.id === 'string' &&
        (!g.scroll || /^PHerc[0-9A-Za-z]+$/.test(g.scroll)) &&
        (!g.catalogMeta?.scroll || /^PHerc[0-9A-Za-z]+$/.test(g.catalogMeta.scroll)) &&
        g.frames && typeof g.frames === 'object' && Object.values(g.frames).every(f => typeof f === 'string'))) {
      throw Error('The dataset has no readable viewer manifest.');
    }
    function resource(path) {
      // The shared viewer speaks paths relative to all-gallery. Match Fuente.ruta_catalogo.
      const virtual = new URL(path, 'https://viewer.invalid/all-gallery/');
      if (virtual.origin !== 'https://viewer.invalid') return httpURL(virtual.href).href;
      let rel = virtual.pathname.slice(1);
      if (info.layout !== 'docroot' && rel.startsWith('catalog/')) {
        rel = rel.slice(8);
        if (info.layout === 'sample') {
          if (rel.startsWith('_viewer/')) return new URL('./' + rel + virtual.search, root).href;
          if (!rel.startsWith(info.scroll + '/')) throw Error('Map belongs to a different scroll');
          rel = rel.slice(info.scroll.length + 1);
        }
      }
      return new URL('./' + rel + virtual.search, root).href;
    }
    // Only published, positive calibration values may supply a physical ruler.
    if (!official) {
      const scrolls = [...new Set(entries.map(g => g.scroll || g.catalogMeta?.scroll).filter(Boolean))];
      const rollos = {};
      async function calibration(scroll) {
        try {
          const data = await getJSON(new URL('rollos/' + scroll + '/rollo.json', root), true)
            || await getJSON(new URL('rollos/' + scroll + '.json', root), true);
          if (data?.scroll === scroll && Number.isFinite(data.voxel_um) && data.voxel_um > 0) {
            rollos[scroll] = {scroll, voxel_um: data.voxel_um, paso_hoja_um: data.paso_hoja_um};
          }
        } catch { /* Calibration is optional. */ }
      }
      for (let i = 0; i < scrolls.length; i += 8) await Promise.all(scrolls.slice(i, i + 8).map(calibration));
      window.VISOR_BOOTSTRAP = {rollos};
    }
    const worker = navigator.serviceWorker;
    let decode = false;
    if (worker) {
      try {
        const registration = await worker.register('./tiff-worker.js');
        const controlsPage = () => worker.controller?.scriptURL === new URL('tiff-worker.js', page).href;
        if (!controlsPage() && registration) await new Promise(resolve => {
          worker.addEventListener('controllerchange', resolve, {once: true});
          setTimeout(resolve, 2000);
        });
        decode = controlsPage();
      } catch { /* Published JPEGs and PNGs also work without a service worker. */ }
    }
    let wantOriginal = !official, selectedURL;
    const full = document.createElement('button');
    full.textContent = 'Full resolution'; full.hidden = true;
    full.onclick = () => { wantOriginal = !wantOriginal; show(true); };
    document.getElementById('download').before(full);
    function image(frame, contrast) {
      if (!OFFICIAL_FRAME.test(frame)) {
        const direct = /\.(?:png|jpe?g|webp|tiff?)$/i.test(new URL(frame, root).pathname);
        return resource(direct ? frame : frame + '/' + contrast + '.png');
      }
      const ext = /\.(png|tiff?)$/i.exec(frame);
      return resource((ext ? frame.slice(0, -ext[0].length) : frame) +
        (contrast === 'global' ? '-global' : '') + (ext ? ext[0] : '.png'));
    }
    function preview(original) {
      const key = decodeURIComponent(new URL(original).pathname.slice(root.pathname.length));
      if (official) return Object.hasOwn(previews, key) ? new URL('./' + previews[key], root).href : null;
      return previewOf(original.replace(/\.tiff?$/i, '.png'), 8);
    }
    window.VISOR_STATIC = {
      readyEvent: 'ink-viewer-ready', reduced: false, resource,
      setReduced(value) {
        this.reduced = value;
        if (value) wantOriginal = false;
        full.textContent = wantOriginal ? 'Show preview' : 'Full resolution';
        const label = document.getElementById('etiq'); label.disabled = value;
        if (value && etiqOn) modoEtiq(false);
      },
      select(frame, contrast) {
        const original = image(frame, contrast), tiff = /\.tiff?$/i.test(new URL(original).pathname);
        if (selectedURL !== original) { selectedURL = original; wantOriginal = !official; }
        const fallback = tiff && preview(original);
        const usePreview = !!(fallback && (!wantOriginal || !decode));
        full.hidden = !(tiff && fallback && decode);
        document.getElementById('download').textContent = tiff ? 'Open TIFF ↗' : 'Open image ↗';
        this.setReduced(usePreview);
        return {original, preview: usePreview, fallback};
      },
      mapUrl(frame, contrast, scale) {
        const original = image(frame, contrast);
        if (/\.tiff?$/i.test(new URL(original).pathname)) {
          const jpg = preview(original);
          if (jpg && (scale || !decode || !wantOriginal)) return jpg;
          if (!decode) return original;
          const route = new URL('tiff.png', page);
          route.searchParams.set('src', original); route.searchParams.set('scale', scale || 1);
          return route.href;
        }
        return scale ? previewOf(original, scale) || original : original;
      }
    };
    window.visorFetchData = (name, options) => {
      if (official) return Promise.resolve(new Response(null, {status: 404}));
      const read = url => fetch(url, {...options, credentials: 'omit'});
      if (name.includes('/')) return read(resource(name));
      if (info.layout === 'docroot') return read(resource(name)).then(res =>
        [403, 404].includes(res.status) ? read(resource('../catalog/_viewer/' + name)) : res);
      return read(new URL('_viewer/' + name, root));
    };
    window.manifest = entries; window.VISOR_METADATA = {};
    const scroll = /^PHerc[0-9A-Za-z]+$/.test(info.scroll) ? info.scroll : entries[0].scroll || entries[0].catalogMeta?.scroll;
    window.VISOR_ORIGEN = {tipo: 'http', origen: root.href, id: root.href, layout: info.layout, scroll, escritura: false};
    window.visorKey = key => key + '@' + root.href;
    window.visorTexto = String; window.visorPuedeGuardar = false; window.HD = true;
    const script = document.createElement('script');
    script.src = 'viewer-static.js';
    script.onload = () => document.dispatchEvent(new Event(VISOR_STATIC.readyEvent, {bubbles: true}));
    script.onerror = () => say('Could not load the viewer scripts.');
    document.body.append(script);
  } catch (error) {
    say('Could not open this dataset. ' + error.message + ' Check its URL and cross-origin access (CORS).');
  }
})();
