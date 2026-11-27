/* GitHub Pages entry point. Dataset indexes are JSON; only scripts shipped with this viewer run. */
(async function () {
  const page = new URL(location.href), source = page.searchParams.get('source') || 'official';
  const header = document.querySelector('header'), picker = document.createElement('form');
  document.getElementById('count').hidden = true;
  document.getElementById('title').hidden = true;
  const assetQuery = document.currentScript ? new URL(document.currentScript.src).search : '';
  const officialRoot = 'https://vesuvius-challenge-open-data.s3.amazonaws.com';
  const official = ['official', 's3://vesuvius-challenge-open-data', officialRoot].includes(source.replace(/\/+$/, ''));
  const labels = source === 'ink-labels';
  const modes = document.createElement('select'), input = document.createElement('input'), open = document.createElement('button');
  modes.setAttribute('aria-label', 'Data source');
  for (const [name, key] of [['All official maps', 'official'], ['VSKinox Label Collection', 'ink-labels'], ['Custom HTTP / S3', 'custom']]) {
    modes.add(new Option(name, key));
  }
  modes.value = official ? 'official' : labels ? 'ink-labels' : 'custom';
  input.type = 'text'; input.value = modes.value === 'custom' ? source : '';
  input.setAttribute('aria-label', 'Custom HTTP or S3 path'); input.placeholder = 'https://… or s3://…';
  open.textContent = 'Open'; picker.className = 'staticSource'; picker.append(modes, input, open); header.append(picker);
  function updatePicker() {
    const custom = modes.value === 'custom';
    input.hidden = open.hidden = !custom; input.required = custom;
  }
  function navigate(value) {
    const next = new URL(location.href); next.search = ''; next.hash = '';
    if (value !== 'official') next.searchParams.set('source', value);
    location.assign(next);
  }
  updatePicker();
  modes.onchange = () => {
    updatePicker();
    if (modes.value === 'custom') input.focus(); else navigate(modes.value);
  };
  picker.onsubmit = event => {
    event.preventDefault();
    navigate(modes.value === 'custom' ? input.value.trim() : modes.value);
  };
  const notice = document.getElementById('notice');
  const say = text => { notice.hidden = false; notice.textContent = text; };
  function httpURL(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use a public HTTP(S) dataset URL.');
    return url;
  }
  async function getJSON(url, optional = false) {
    let res;
    try { res = await fetch(url, {credentials: 'omit', referrerPolicy: 'no-referrer'}); }
    catch (error) { if (optional) return null; throw error; }
    if (optional && [403, 404].includes(res.status)) return null;
    if (!res.ok) throw Error('HTTP ' + res.status + ' for ' + url);
    if (optional && res.headers.get('Content-Type')?.includes('text/html')) return null;
    return res.json();
  }
  const raster = /\.(?:png|jpe?g|webp|tiff?)$/i;
  function customURL(value) {
    const url = new URL(value);
    if (url.protocol !== 's3:') return httpURL(value);
    if (url.username || url.password || url.port || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(url.hostname)) {
      throw Error('Invalid S3 bucket name.');
    }
    const endpoint = url.hostname.includes('.') ? 'https://s3.amazonaws.com/' + url.hostname
      : 'https://' + url.hostname + '.s3.amazonaws.com';
    return new URL(endpoint + url.pathname + url.search + url.hash);
  }
  function imageEntry(url) {
    const path = decodeURIComponent(url.pathname);
    const name = path.split('/').pop().replace(/[<>&"']/g, '_');
    const scroll = path.match(/(?:^|\/)(PHerc[0-9A-Za-z]+)(?:\/|$)/)?.[1] || 'PHercCustom';
    return {id: 'image_' + encodeURIComponent(url.href), scroll, label: name, frames: {'0': url.href},
      frameContrasts: {[url.href]: ['fixed']}, mapAvailable: true,
      catalogMeta: {lam: name, modelo: 'Original', fam: 'Custom images', cara: 'unknown', scroll,
        depthKnown: false, physicalScaleVerified: false, originalContrast: true}};
  }
  async function listS3(bucket, prefix) {
    const query = new URL(bucket);
    query.searchParams.set('list-type', '2'); query.searchParams.set('encoding-type', 'url'); query.searchParams.set('prefix', prefix);
    const images = [];
    for (;;) {
      const response = await fetch(query, {credentials: 'omit'});
      if (!response.ok) throw Error('S3 prefix listing requires public ListBucket and CORS, or a published viewer index.');
      const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
      if (xml.documentElement.localName !== 'ListBucketResult') throw Error('Invalid S3 listing.');
      for (const item of xml.getElementsByTagName('Key')) {
        const key = decodeURIComponent(item.textContent);
        if (raster.test(key)) images.push(imageEntry(new URL(key.split('/').map(encodeURIComponent).join('/'), bucket)));
      }
      if (xml.querySelector('IsTruncated')?.textContent !== 'true') return images;
      const token = xml.querySelector('NextContinuationToken')?.textContent;
      if (!token || token === query.searchParams.get('continuation-token')) throw Error('Incomplete S3 listing.');
      query.searchParams.set('continuation-token', token);
    }
  }
  let root, info, entries, previews = {}, builtIn = official || labels, sidecars = !builtIn, manifestRelative = false;
  try {
    say('Loading dataset…');
    const address = builtIn ? null : customURL(source);
    const officialPrefix = address?.origin === officialRoot && !raster.test(address.pathname) && !address.pathname.endsWith('.json');
    if (builtIn || officialPrefix) {
      const catalog = await getJSON(new URL(labels ? 'ink-labels.json' : 'official.json', page));
      root = httpURL(catalog.root + '/'); entries = catalog.entries; previews = catalog.previews || {};
      info = {layout: 'catalog'};
      if (officialPrefix) {
        const prefix = decodeURIComponent(address.pathname.slice(1)).replace(/\/?$/, '/');
        entries = entries.filter(g => g.official.path.startsWith(prefix));
        if (entries.length) { builtIn = true; sidecars = false; }
      }
    }
    if (!builtIn) {
      root = address; info = {layout: 'docroot'};
      if (root.hash) throw Error('Enter a source path without a fragment.');
      if (raster.test(root.pathname)) {
        entries = [imageEntry(root)]; sidecars = false;
      } else if (root.pathname.endsWith('.json')) {
        entries = await getJSON(root);
        const isIndex = root.pathname.endsWith('/_viewer/manifest.json');
        const gallery = root.pathname.endsWith('/all-gallery/manifest.json');
        const work3 = root.pathname.endsWith('/catalog/_viewer/manifest-work3.json');
        manifestRelative = !isIndex && !gallery && !work3;
        root = new URL(work3 ? '../../' : isIndex || gallery ? '../' : './', root);
        if (isIndex) info = await getJSON(new URL('_viewer/index-info.json', root));
      } else {
        root.pathname = root.pathname.replace(/\/?$/, '/');
        if (root.search) throw Error('Enter the indexed dataset root URL without a query.');
        info = await getJSON(new URL('_viewer/index-info.json', root), true);
        if (info) {
          entries = await getJSON(new URL('_viewer/manifest.json', root));
        } else {
          info = {layout: 'docroot'};
          entries = await getJSON(new URL('all-gallery/manifest.json', root), true)
            || await getJSON(new URL('catalog/_viewer/manifest-work3.json', root), true);
          if (!entries) {
            const pathStyle = /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(root.hostname);
            if (!(pathStyle || /\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(root.hostname))) {
              throw Error('No viewer index found. Enter an indexed HTTP root, a JSON manifest, or an image URL.');
            }
            const bucket = new URL(pathStyle ? root.pathname.split('/').slice(0,2).join('/')+'/' : '/', root);
            entries = await listS3(bucket, decodeURIComponent(root.pathname.slice(bucket.pathname.length)));
            sidecars = false;
          }
        }
      }
      if (!['catalog', 'sample', 'docroot'].includes(info?.layout) ||
          (info.schema && info.schema !== 'vesuvius.viewer-index.v1') ||
          (info.layout === 'sample' && !/^PHerc[0-9A-Za-z]+$/.test(info.scroll))) throw Error('Invalid ink-viewer index.');
    }
    if (!Array.isArray(entries) || !entries.length || !entries.every(g => typeof g?.id === 'string' &&
        (!g.scroll || /^PHerc[0-9A-Za-z]+$/.test(g.scroll)) &&
        (!g.catalogMeta?.scroll || /^PHerc[0-9A-Za-z]+$/.test(g.catalogMeta.scroll)) &&
        g.frames && typeof g.frames === 'object' && Object.values(g.frames).every(f => typeof f === 'string'))) {
      throw Error('The dataset has no readable viewer manifest.');
    }
    function resource(path) {
      // The shared viewer speaks paths relative to all-gallery. Match Fuente.ruta_catalogo.
      if (/^s3:\/\//i.test(path)) return customURL(path).href;
      if (manifestRelative) return httpURL(new URL(path, root).href).href;
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
    if (sidecars) {
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
        const workerURL = new URL('raster-worker.js' + assetQuery, page).href;
        const registration = await worker.register(workerURL);
        const controlsPage = () => worker.controller?.scriptURL === workerURL;
        if (!controlsPage() && registration) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); worker.removeEventListener('controllerchange', changed); resolve(); };
          const changed = () => { if (controlsPage()) finish(); };
          const timer = setTimeout(finish, 10000);
          worker.addEventListener('controllerchange', changed);
          changed();
        });
        decode = controlsPage();
      } catch { /* Published JPEGs and PNGs also work without a service worker. */ }
    }
    let wantOriginal = !builtIn, selectedURL;
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
      if (builtIn) {
        if (!Object.hasOwn(previews, key)) return null;
        // Older clients cached opaque explorer thumbnails at the bare S3 URL.
        const jpg = new URL('./' + previews[key], root); jpg.searchParams.set('viewer', 'cors');
        return jpg.href;
      }
      return previewOf(original.replace(/\.tiff?$/i, '.png'), 8);
    }
    let style, entryLink;
    const labelLegend = document.createElement('span');
    if (labels) {
      style = document.createElement('select'); style.setAttribute('aria-label', 'Ink-label view');
      style.add(new Option('CT + labels A / C', 'preview'));
      if (decode) for (const name of ['A', 'B', 'C', 'D']) style.add(new Option('Label style ' + name, name));
      style.onchange = () => show(true);
      entryLink = document.createElement('a'); entryLink.textContent = 'Dataset files ↗';
      entryLink.target = '_blank'; entryLink.rel = 'noopener';
      document.getElementById('download').before(style, entryLink);
      const credit = document.createElement('a');
      credit.href = 'https://huggingface.co/datasets/vincentl065/herculaneum-ink-labels';
      credit.textContent = 'VSkinox & original label authors · CC BY-NC 4.0'; credit.target = '_blank'; credit.rel = 'noopener';
      document.querySelector('footer')?.append(labelLegend, credit);
    }
    function labelURL(frame) {
      return style.value === 'preview' ? frame : new URL('labels/style_' + style.value + '.png', frame).href;
    }
    window.VISOR_STATIC = {
      readyEvent: 'ink-viewer-ready', reduced: false, resource,
      hasPublishedLabels: labels && decode,
      maskUploadModule: new URL('mask-hub.js' + assetQuery, page).href,
      prepareLabel() {
        if (labels && decode && style.value === 'preview') {
          style.value = 'A';
          show(true);
        } else if (!labels && this.reduced && !full.hidden && !document.getElementById('etiq').disabled) {
          wantOriginal = true;
          show(true);
        }
      },
      // The PHercParis4 map for segment 20230929220926 shows readable text at preview resolution.
      defaultSeriesId: official ? 'official_0181c8dd4c267c2b5e04' : null,
      setReduced(value, canOpenNative = false) {
        this.reduced = value;
        if (value) wantOriginal = false;
        full.textContent = wantOriginal ? 'Show preview' : 'Full resolution';
        const label = document.getElementById('etiq'); label.disabled = value && !canOpenNative;
        label.title = label.disabled ? 'Labeling requires a supported native-resolution image.' : '';
        if (value && etiqOn) modoEtiq(false);
      },
      select(frame, contrast) {
        if (labels) {
          const overview = style.value === 'preview';
          entryLink.href = new URL('./', frame).href.replace('/resolve/main/', '/tree/main/');
          labelLegend.textContent = overview ? '' : 'Yellow: ink · blue: background · grey: ignore · black: outside. ';
          document.getElementById('download').textContent = overview ? 'Open comparison ↗' : 'Open raw label ↗';
          this.publishedLabel = overview ? null : labelURL(frame);
          this.setReduced(overview, decode);
          return {original: labelURL(frame), preview: overview,
            caption: 'Published comparison · CT | label A | label C'};
        }
        const original = image(frame, contrast), tiff = /\.tiff?$/i.test(new URL(original).pathname);
        if (selectedURL !== original) { selectedURL = original; wantOriginal = !builtIn; }
        const fallback = tiff && preview(original);
        const usePreview = !!(fallback && (!wantOriginal || !decode));
        full.hidden = !(tiff && fallback && decode);
        document.getElementById('download').textContent = tiff ? 'Open TIFF ↗' : 'Open image ↗';
        this.setReduced(usePreview, !full.hidden);
        return {original, preview: usePreview, fallback};
      },
      mapUrl(frame, contrast, scale) {
        if (labels) {
          if (scale || style.value === 'preview') return frame;
          const url = new URL('ink-label.png', page);
          url.searchParams.set('src', labelURL(frame)); return url.href;
        }
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
      if (!sidecars) return Promise.resolve(new Response(null, {status: 404}));
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
    script.src = 'viewer-static.js' + assetQuery;
    script.onload = () => document.dispatchEvent(new Event(VISOR_STATIC.readyEvent, {bubbles: true}));
    script.onerror = () => say('Could not load the viewer scripts.');
    document.body.append(script);
  } catch (error) {
    say('Could not open this dataset. ' + error.message + ' Check its URL and cross-origin access (CORS).');
  }
})();
