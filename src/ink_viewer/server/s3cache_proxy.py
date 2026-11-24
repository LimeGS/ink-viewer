#!/usr/bin/env python3
"""Serve the viewer code independently from local, HTTP or S3 image sources.

Use --origen CARPETA|https://servidor/prefijo|s3://bucket/prefijo and optionally
--anotaciones CARPETA for validated annotation pairs. Source metadata is read from
rollos/<sample>/rollo.json or rollos/<sample>.json; unknown measurements stay unknown.
/api/origen can select and persist a source in --config. No image data is bundled.

Legacy catalog streaming is opt-in through S3CACHE_WORK3_BASE, ARCHIVO_S3,
CAMPANA_S3, S3CACHE_BUCKET/S3CACHE_PROFILE and CATALOG_WRITER_TOKEN. Its external
writer does not support atomic annotation pairs; configure local annotations.
"""
import argparse, base64, binascii, io, json, os, re, secrets, shutil, struct, tempfile, threading, time, urllib.error, urllib.request
import gzip, hashlib, math
from functools import lru_cache
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit
from ink_viewer.server.fuentes import Fuente, guardar_json, ruta_dentro
import ink_viewer.server.canonical_masks as canonical
import ink_viewer.catalog.master_inventory as master
import ink_viewer.server.inksdk_job as inksdk
import ink_viewer.server.corte as corte
from ink_viewer.server.tiff_header import tiff_dims
from ink_viewer.server.hf_sync import HFSync

# Largest TIFF map decoded on the server, and largest sent at full resolution (a browser cannot hold gigapixel images;
# larger maps open as a reduced, browse-only view).
MAP_PIXELS = int(float(os.environ.get('VISOR_MAX_MAP_PIXELS') or 1e9))
FULLRES_PIXELS = int(float(os.environ.get('VISOR_MAX_FULLRES_PIXELS') or 4e8))


class MapTooLarge(ValueError):
    pass

from ink_viewer.paths import WEB_ROOT, web_asset

# Dataset state is independent of the installed Python package and static assets.
ROOT = Path.cwd().resolve()
CODE = WEB_ROOT
STATIC = {str(path.relative_to(CODE)) for path in CODE.rglob('*')
          if path.is_file() and path.suffix in {'.js', '.css', '.html', '.woff2', '.webp'}}
VIEWER_TOOLS = ('filtros_pro.js', 'super_mosaico.js', 'precarga.js', 'fallo_visible.js',
                'explorer_pro.js', 'ui_modos.js', 'hist_v5.js', 'spinner.js', 'etiq_extra.js',
                'hd.js', 'etiq_herramientas.js', 'guias_medicion.js', 'responsive.js', 'inksdk.js', 'corte.js')
CACHE = ROOT / '.s3cache'
LOG_FILE = ROOT / 's3cache_proxy.log'
# buckets privados (GENERALIZAR.md regla 3): URIs completas sin barra final
ARCHIVO_S3 = os.environ.get('ARCHIVO_S3', '')
CAMPANA_S3 = os.environ.get('CAMPANA_S3', '')


def partir_s3(uri):
    """s3://bucket/clave -> (bucket, clave sin barras en los bordes)."""
    if not uri.startswith('s3://'):
        raise ValueError(f'no es una URI s3://: {uri}')
    bucket, _, clave = uri[len('s3://'):].partition('/')
    return bucket, clave.strip('/')


BUCKET = os.environ.get('S3CACHE_BUCKET') or (partir_s3(ARCHIVO_S3)[0] if ARCHIVO_S3 else '')
PERFIL = os.environ.get('S3CACHE_PROFILE', '')
# work-3 (nginx, LAN): lectura de solo lectura; escritura solo con token (catalog_writer)
WORK3_BASE = os.environ.get('S3CACHE_WORK3_BASE', '')
WORK3_TIMEOUT = float(os.environ.get('S3CACHE_WORK3_TIMEOUT', 30))
TOKEN_FILE = Path(os.environ['CATALOG_WRITER_TOKEN']).expanduser() if os.environ.get('CATALOG_WRITER_TOKEN') else None
# Optional metadata for paths without an explicit sample.
SCROLL = ROLLO = None
ESPEJO = None           # espejo nginx de all-gallery-backing en work-3: <clave de CAMPANA_S3>/<rollo>/all-gallery-backing/
LABELS_UNKNOWN = None   # base de etiquetas de una lamina sin segmento conocido: _unresolved/<rollo>
PORT = int(os.environ.get('S3CACHE_PORT', 8797))
# Listen address; keep loopback by default. The Docker image sets 0.0.0.0 and the
# host should publish the port on 127.0.0.1 only (writes are loopback-gated).
BIND = os.environ.get('S3CACHE_BIND', '127.0.0.1')
TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg'}


def espejo_de(sample):
    """espejo nginx de all-gallery-backing en work-3 para un sample: <clave de CAMPANA_S3>/<sample>/all-gallery-backing/."""
    prefix = partir_s3(CAMPANA_S3)[1] if CAMPANA_S3 else ''
    return '/'.join(filter(None, (prefix, sample, 'all-gallery-backing'))) + '/'


def sample_de(rel):
    """Sample de un path de visor: catalog/<sample>/... o catalog/_unresolved/<sample>/...; None si el path no lo trae
    (rutas legacy de la galeria, que van al sample del docroot)."""
    m = re.match(r'(?:\.\./)?catalog/_unresolved/([^/]+)/', rel)
    if m:
        return m.group(1)
    m = re.match(r'(?:\.\./)?catalog/([^/]+)/', rel)
    return m.group(1) if m and m.group(1) != 'segments' else None


def sample_default():
    """Sample explicitly selected for legacy paths; otherwise unknown."""
    return SCROLL or 'unknown'


def cargar_rollo(scroll, fuente=None):
    """Physical metadata belongs to the selected dataset; no parent checkout is required."""
    if not re.fullmatch(r'PHerc[0-9A-Za-z]+', scroll or ''):
        raise ValueError('Identificador de rollo invalido')
    for rel in (f'rollos/{scroll}/rollo.json', f'rollos/{scroll}.json'):
        if fuente:
            info = fuente.indice(rel)
        else:
            path = ROOT / rel
            info = json.loads(path.read_text()) if path.is_file() else {}
        if info:
            if info.get('scroll') != scroll or not float(info.get('voxel_um', 0)) > 0:
                raise ValueError('Metadatos fisicos del rollo invalidos')
            return info
    # Deployment profiles may retain explicit metadata imported from a running viewer.
    if os.environ.get('TRAZADO_WORK'):
        path = Path(os.environ['TRAZADO_WORK']) / scroll / 'rollo.json'
        if path.is_file():
            info = json.loads(path.read_text())
            if info.get('scroll') != scroll or not float(info.get('voxel_um') or 0) > 0:
                raise ValueError('Metadatos fisicos del rollo invalidos')
            return info
    # Existing installations may explicitly select their pipeline metadata directory.
    if os.environ.get('PIPELINE'):
        path = Path(os.environ['PIPELINE']) / 'rollos' / f'{scroll}.json'
        if path.is_file():
            info = json.loads(path.read_text())
            if info.get('scroll') == scroll and float(info.get('voxel_um', 0)) > 0:
                return info
    return {'scroll': scroll, 'voxel_um': None}


MASK_LIMIT = 64 * 2**20
MASK_PIXELS = 64 * 2**20
PNG_META = 'vesuvius:mascara_corrida'


def leer_mascara(body):
    """Decode real PNG pixels, including alpha, before any file is staged."""
    from PIL import Image, ImageChops
    if not 0 < len(body) <= MASK_LIMIT:
        raise ValueError('PNG vacio o mayor a 64 MiB')
    if len(body) < 33 or body[:8] != b'\x89PNG\r\n\x1a\n' or body[8:16] != b'\x00\x00\x00\x0dIHDR' or body[24] != 8:
        raise ValueError('La mascara debe ser un PNG con profundidad de 8 bits')
    try:
        with Image.open(io.BytesIO(body)) as image:
            if image.format != 'PNG' or image.mode not in ('L', 'LA', 'P', 'RGB', 'RGBA') or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('La mascara debe ser un PNG 2D de clases de 8 bits')
            if image.width * image.height > MASK_PIXELS:
                raise ValueError('Mascara mayor a 64 megapixeles')
            image.verify()
        with Image.open(io.BytesIO(body)) as image:
            image.load()
            raw = image.info.get(PNG_META)
            corrida = json.loads(raw) if raw else None
            if corrida is not None and not isinstance(corrida, dict):
                raise ValueError('Metadatos PNG invalidos')
            red, green, blue, alpha = image.convert('RGBA').split()
            if alpha.getextrema() != (255, 255) or ImageChops.difference(red, green).getbbox() or ImageChops.difference(red, blue).getbbox():
                raise ValueError('La mascara debe ser opaca y gris: canales RGB identicos')
            colors = red.getcolors(3)
            if colors is None or any(value not in (0, 255) for _, value in colors):
                raise ValueError('Clases de mascara invalidas: solo 0 y 255')
            return red, corrida
    except (OSError, SyntaxError, Image.DecompressionBombError) as e:
        raise ValueError('PNG invalido o incompleto') from e


def validar_corrida(info, size, lamina, base, depth, rollo=None):
    if info is None:
        return
    if not isinstance(info, dict):
        raise ValueError('Corrida debe ser un objeto JSON')
    if any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in size):
        raise ValueError('Dimensiones de corrida invalidas')
    if any(type(info.get(key)) is not int for key in ('ancho', 'alto')) or (info.get('ancho'), info.get('alto')) != size:
        raise ValueError('Las dimensiones de corrida y PNG no coinciden')
    if info.get('segmento') != lamina or not isinstance(info.get('lamina'), str) or not info['lamina']:
        raise ValueError('La corrida pertenece a otra lamina/segmento')
    if info.get('base') and info['base'] != base:
        raise ValueError('La corrida pertenece a otra base')
    sample = base.split('/')[1] if base.startswith('_unresolved/') else base.split('/')[0]
    if rollo and sample != rollo or info.get('rollo') and info['rollo'] != sample or info.get('scroll') and info['scroll'] != sample:
        raise ValueError('La corrida pertenece a otro rollo')
    if info.get('profundidad') != depth or depth != 'max' and type(info.get('profundidad')) is not int:
        raise ValueError('La corrida pertenece a otra profundidad')


def validar_par(inkbody, supbody, info, lamina, base, depth, rollo=None):
    from PIL import ImageChops
    ink, imeta = leer_mascara(inkbody)
    sup, smeta = leer_mascara(supbody)
    if ink.size != sup.size:
        raise ValueError('Las dimensiones de inklabels y supervision_mask no coinciden')
    if ImageChops.subtract(ink, sup).getbbox():
        raise ValueError('Hay tinta fuera de supervision_mask')
    if imeta != smeta or info is not None and imeta != info:
        raise ValueError('El par PNG y su corrida no tienen los mismos metadatos')
    corrida = info if info is not None else imeta
    validar_corrida(corrida, ink.size, lamina, base, depth, rollo)
    return corrida


def profundidad(params):
    value = params.get('c', ['max'])[0]
    if value == 'max':
        return 'max'
    if not re.fullmatch(r'[+-]?\d{1,6}', value):
        raise ValueError('Profundidad invalida')
    return int(value)


def ubicacion_par(lamina, base, depth, propuesta=False):
    if not re.fullmatch(r'[A-Za-z0-9][\w.-]*', lamina) or '..' in lamina:
        raise ValueError('Lamina invalida')
    prefix = f'catalog/{base}/labels/'
    if depth == 'max':
        return prefix + 'etiquetas/' + lamina
    return prefix + 'por-profundidad/' + ('_propuestas/' if propuesta else '') + f'{lamina}/c{depth:+03d}'


def configurar(scroll=None, raiz=None, fuente=None):
    """Sin scroll: el proxy sirve TODOS los rollos del docroot (el sample sale del path). Con scroll: como antes."""
    global SCROLL, ROLLO, ESPEJO, LABELS_UNKNOWN, ROOT, CACHE, LOG_FILE
    if raiz:
        ROOT = Path(raiz).resolve()
        CACHE, LOG_FILE = ROOT / '.s3cache', ROOT / 's3cache_proxy.log'
    if scroll:
        ROLLO = cargar_rollo(scroll, fuente)
        SCROLL = ROLLO['scroll']
        ESPEJO = espejo_de(SCROLL)
        LABELS_UNKNOWN = f'_unresolved/{SCROLL}'
    else:
        ROLLO = SCROLL = ESPEJO = LABELS_UNKNOWN = None
    return {'scroll': SCROLL, 'voxel_um': (ROLLO or {}).get('voxel_um'), 'paso_hoja_um': (ROLLO or {}).get('paso_hoja_um'),
            'raiz': str(ROOT), 'log': str(LOG_FILE), 'bucket': BUCKET, 'perfil': PERFIL, 'campana_s3': CAMPANA_S3,
            'work3_base': WORK3_BASE, 'espejo_work3': ESPEJO, 'etiquetas_sin_segmento': LABELS_UNKNOWN,
            'token_writer': str(TOKEN_FILE) if TOKEN_FILE else '',
            'indices': {n: (ROOT / n).exists() for n in ('catalog_asset_index.json', 'mac_cache_index.json',
                        's3_on_demand_index.json', 'lamina_labels_index.json', 'propuestas.json')}}

_locks, _guard = {}, threading.Lock()
# files brought from S3 whose write to work-3 failed: kept in memory (bounded) and written again on the next request,
# so a failure never costs a second S3 download
_pending, PENDING_MAX = {}, 256 * 2**20


def log(msg):
    line = f'{time.strftime("%Y-%m-%d %H:%M:%S")} {msg}'
    print(line, flush=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')


_indexes = {}
def index(name):
    """A JSON index next to the proxy, reloaded when the file changes; {} if it does not exist."""
    path = ROOT / name
    stamp = path.stat().st_mtime_ns if path.exists() else None
    # 25-sep: a file that never existed gave KeyError (None == the default stamp, so nothing was cached): every request
    # outside the docroot crashed in the docroot of a new scroll, which has none of these indexes yet
    if name not in _indexes or _indexes[name][1] != stamp:
        _indexes[name] = (json.loads(path.read_text()) if stamp else {}, stamp)
    return _indexes[name][0]

def load_catalog_index(): return index('catalog_asset_index.json')
def load_mac_index(): return index('mac_cache_index.json')          # ruta oficial -> copia en la Mac (D6)
def load_s3_once_index(): return index('s3_on_demand_index.json')   # ruta oficial -> clave S3 (F5)
def load_labels_index(): return index('lamina_labels_index.json')   # lamina del visor -> base en el catalogo (D4)

_s3 = None
def s3():
    """Solo para bajar una vez a work-3 lo que falta (F5). Nunca para servir desde S3 sin dejarlo en work-3."""
    global _s3
    if _s3 is None:
        import boto3
        from botocore.config import Config
        ses = boto3.Session(profile_name=PERFIL) if PERFIL else boto3.Session()
        _s3 = ses.client('s3', config=Config(max_pool_connections=32, retries={'max_attempts': 2}))
    return _s3


def catalog_url(record):
    path = record['path']
    if path.startswith('/') or '..' in Path(path).parts:
        raise ValueError('Invalid catalog path')
    return WORK3_BASE.rstrip('/') + '/viewer-catalog/' + quote(path, safe='/')

def work3_url(rel):
    """Where work-3 serves a viewer path: the official catalog layout, the catalog reader, or the gallery mirror."""
    if rel.startswith('catalog/'):  # official layout: /mnt/ct/catalog/<sample>/segments/<segment>/... on work-3
        return WORK3_BASE.rstrip('/') + '/' + quote(rel, safe='/')
    record = load_catalog_index().get(rel)
    espejo = espejo_de(sample_de(rel) or sample_default())
    return catalog_url(record) if record else WORK3_BASE.rstrip('/') + '/' + quote(espejo + rel, safe='/')


def writer_put(rel, body):
    """PUT a file into the catalog on work-3 (catalog_writer); returns (status, json)."""
    if not WORK3_BASE or TOKEN_FILE is None:
        raise PermissionError('Configura S3CACHE_WORK3_BASE y CATALOG_WRITER_TOKEN para el escritor legacy')
    req = urllib.request.Request(WORK3_BASE.rstrip('/') + '/catalog-write/' + quote(rel, safe='/'), data=body, method='PUT',
                                 headers={'X-Catalog-Token': TOKEN_FILE.read_text().strip()})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def s3_once(rel, key):
    """Bring one official file from S3 to work-3 exactly once (concurrent requests wait for the first); returns bytes."""
    with _guard:
        lock = _locks.setdefault(rel, threading.Lock())
    with lock:
        try:  # another request may have just stored it
            with urllib.request.urlopen(work3_url(rel), timeout=WORK3_TIMEOUT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
        body = _pending.get(rel)
        if body is None:
            body = s3().get_object(Bucket=BUCKET, Key=key)['Body'].read()
        status, reply = writer_put(rel.removeprefix('catalog/'), body)
        log(f'S3 -> work-3 {rel} ({len(body) / 2**20:.2f} MiB): {status} {reply.get("status") or reply.get("error")}')
        if status < 300:
            _pending.pop(rel, None)
        else:
            _pending[rel] = body
            while sum(map(len, _pending.values())) > PENDING_MAX:
                _pending.pop(next(iter(_pending)))
        return body


def labels_base(lamina, base=None, rollo=None, fuente=None):
    """labels/ folder for a mask: the segment the viewer names (?base=<sample>/segments/<segment>, taken from the map's own
    catalog path, 24-sep), else the lamina index (D4), else _unresolved/<rollo>. Multi-rollo: un indice de otro rollo se
    ignora cuando el rollo es conocido, para que una lamina repetida entre rollos no aterrice en el segmento de otro."""
    if base:
        if not re.fullmatch(r'[A-Za-z0-9][\w.-]*/segments/[A-Za-z0-9][\w.-]*', base) or '..' in base:
            raise ValueError('Base de segmento invalida')
        if rollo and base.split('/')[0] != rollo:
            raise ValueError('La base pertenece a otro rollo')
        return base
    rollo = rollo or SCROLL or None
    indexed = (fuente.indice('lamina_labels_index.json') if fuente else load_labels_index()).get(lamina)
    if indexed:
        dueno = sample_de(indexed) or indexed.split('/')[0]
        if not rollo or dueno == rollo:
            return indexed            # sin rollo conocido (docroot de un solo rollo) manda el indice, como antes
    return f'_unresolved/{rollo or sample_default()}'


@lru_cache(maxsize=2)
def manifest_bytes(source, revision):
    data = source.indice(source.manifest_rel, limite=256 * 2**20)
    if not isinstance(data, list):
        raise ValueError('The manifest must be a list')
    if hasattr(source, 'browser_manifest'):
        data = source.browser_manifest(data)
    body = ('window.manifest=' + json.dumps(data, separators=(',', ':')) + ';\n').encode()
    return encoded_bytes(body)


def file_revision(path):
    # Cache key for the lru_cache readers below. Filesystem timestamps can be coarser
    # than their nanosecond fields (one kernel tick on many Linux setups), so two
    # same-size rewrites of one file within a tick can share a revision.
    stat = Path(path).stat()
    return stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size


def encoded_bytes(body):
    return body, gzip.compress(body, compresslevel=6, mtime=0), hashlib.sha256(body).hexdigest()


@lru_cache(maxsize=32)
def file_bytes(path, revision):
    return encoded_bytes(Path(path).read_bytes())


@lru_cache(maxsize=2)
def tools_bytes(parts):
    return encoded_bytes(b'\n;\n'.join(b'/* ' + Path(path).name.encode() + b' */\n' + Path(path).read_bytes()
                                        for path, revision in parts))


def accepts_gzip(header):
    for item in header.lower().split(','):
        name, *params = item.strip().split(';')
        if name != 'gzip':
            continue
        try:
            return all(float(p.split('=', 1)[1]) > 0 for p in params if p.strip().startswith('q='))
        except (ValueError, IndexError):
            return False
    return False


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # the viewer's index.html embeds the manifest: a cached copy hides freshly loaded laminae (14-sep)
        if self.path.split('?')[0].endswith(('.html', '.js', '.json', '.css', '/')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        pass  # el log propio (log()) ya cubre lo que importa; no duplicar el access log

    def do_HEAD(self):
        self.fuente = getattr(self.server, 'fuente', None)
        if self._codigo(head=True): return
        if self.fuente:
            if not self._host_local(): return self.send_error(403)
            return self._fuente_get(head=True)
        path = unquote(urlsplit(self.path).path).lstrip('/')
        if '..' in Path(path).parts or (ROOT / path).exists() or (CACHE / path).is_file():
            return super().do_HEAD()
        self._stream(work3_url(path), head=True)

    def _stream(self, url, head=False, missing_ok=False):
        """Relay work-3's answer as is (Range included) without keeping a copy on the Mac. With missing_ok a 404 is
        returned to the caller instead of being sent, so it can fall back to S3 once."""
        headers = {'Range': self.headers['Range']} if self.headers.get('Range') else {}
        try:
            response = urllib.request.urlopen(urllib.request.Request(url, headers=headers, method='HEAD' if head else 'GET'),
                                              timeout=WORK3_TIMEOUT)
        except urllib.error.HTTPError as e:
            if missing_ok and e.code == 404:
                return 404
            return self.send_error(e.code, 'No esta en la Mac ni en work-3' if e.code == 404 else None)
        except Exception as e:
            log(f'!! work-3 no responde ({url}): {str(e)[:120]}')
            return self.send_error(502, 'work-3 no responde')
        with response:
            try:
                self.send_response(response.status)
                for key in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag'):
                    if response.headers.get(key): self.send_header(key, response.headers[key])
                self.send_header('X-Fuente', 'work-3')
                self.end_headers()
                if not head: shutil.copyfileobj(response, self.wfile, length=262144)
            except (BrokenPipeError, ConnectionResetError): pass
        return response.status

    def _send_bytes(self, body, ctype, fuente, head=False, etag=None, gzipped=None):
        encoded = gzipped is not None and accepts_gzip(self.headers.get('Accept-Encoding', ''))
        if encoded:
            body = gzipped
        if etag:
            etag = '"' + etag + ('-gzip' if encoded else '') + '"'
        not_modified = etag and any(v.strip().removeprefix('W/') in (etag, '*')
                                   for v in self.headers.get('If-None-Match', '').split(','))
        self.send_response(304 if not_modified else 200)
        if etag:
            self.send_header('ETag', etag)
        if gzipped is not None:
            self.send_header('Vary', 'Accept-Encoding')
        if encoded:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Type', ctype)
        if not not_modified:
            self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Fuente', fuente)
        self.end_headers()
        if not head and not not_modified:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def _host_local(self):
        return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

    def _codigo(self, head=False):
        path = unquote(urlsplit(self.path).path).lstrip('/')
        if not path:
            self.send_response(302); self.send_header('Location', '/all-gallery/index.html'); self.end_headers(); return True
        name = path.removeprefix('all-gallery/') if path.startswith('all-gallery/') else path
        if path == 'all-gallery/': name = 'index.html'
        if name in ('viewer-tools.js', 'js/viewer-tools.js'):
            parts = tuple((str(CODE / web_asset(item)), file_revision(CODE / web_asset(item))) for item in VIEWER_TOOLS)
            body, compressed, etag = tools_bytes(parts)
            self._send_bytes(body, 'application/javascript', 'viewer-code', head, etag, compressed)
            return True
        if name not in STATIC: name = web_asset(name)
        if name not in STATIC: return False
        self._serve_file(CODE / name, head)
        return True

    def _origen_info(self):
        source = getattr(self.server, 'fuente', None)
        info = source.info() if source else {'tipo': 'legacy', 'id': '', 'origen': str(ROOT), 'anotaciones': '',
                                            'perfil': '', 'endpoint': '', 'region': '', 'escritura': False, 'atomic_pair': False}
        sync = getattr(self.server, 'hf_sync', None)
        return dict(info, hf=sync.info() if sync else None, canonical_masks=canonical.inventory(source) is not None, token=getattr(self.server, 'config_token', ''),
                    config=str(getattr(self.server, 'config_path', '') or ''))

    def _cambiar_origen(self):
        global LOG_FILE
        token = getattr(self.server, 'config_token', None)
        if not token or not self._host_local() or self.headers.get('X-Visor-Config') != token:
            return self._json({'error': 'Solicitud de configuracion no autorizada'}, 403)
        if self.headers.get('Origin') not in (None, 'http://' + self.headers['Host']):
            return self._json({'error': 'Origen del navegador no autorizado'}, 403)
        try:
            n = int(self.headers.get('Content-Length', 0))
            if not 0 < n <= 16384 or self.headers.get_content_type() != 'application/json':
                raise ValueError('Esperaba configuracion JSON de hasta 16 KiB')
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or set(data) - {'origen', 'perfil', 'endpoint', 'region', 'anotaciones'}:
                raise ValueError('Campos de configuracion invalidos')
            source = Fuente(**data)
            source.verificar()
            # Validate and persist before replacing the active source; failed changes leave it intact.
            with self.server.config_lock:
                current = getattr(self.server, 'fuente', None)
                if self.headers.get('X-Visor-Origen', '') != (current.id if current else ''):
                    return self._json({'error': 'El origen cambio en otra pestana; recarga el visor'}, 409)
                if self.server.config_path:
                    guardar_json(self.server.config_path, source.config())
                    LOG_FILE = self.server.config_path.parent / 'visor.log'
                self.server.fuente = source
            return self._json(self._origen_info())
        except (ValueError, TypeError, OSError) as e:
            return self._json({'error': str(e)}, 400)
        except Exception as e:
            return self._json({'error': str(e)}, 502)

    def _fuente_archivo(self, rel, head=False):
        source = self.fuente
        canonical_data = canonical.inventory(source)
        if canonical_data is not None and re.search(r'inklabels|supervision|mascara|mask|^(I|S)\.', Path(rel).name, re.I) and Path(rel).suffix.lower() in ('.png','.tif','.tiff'):
            try:
                canonical.asset_path(source, {'canonical': str(Path(source.origen) / rel)})
            except (ValueError, OSError):
                return self._json({'error':'Masks must be read from canonical catalog labels'}, 403)
        mask = None if canonical_data is not None else source.mascara_local(rel) if rel.startswith('catalog/') and '/labels/' in rel else None
        if mask:
            with source.mascara_lock:
                mask = source.mascara_local(rel)
                if mask.is_file():
                    with mask.open('rb') as body:
                        return self._fuente_stream(200, {'Content-Length': str(mask.stat().st_size), 'Content-Type': self.guess_type(str(mask))}, body, head)
        generated = inksdk.archivo_generado(source, rel)
        if generated:
            with generated.open('rb') as body:
                return self._fuente_stream(200, {'Content-Length': str(generated.stat().st_size),
                                                 'Content-Type': self.guess_type(str(generated))}, body, head, fuente='ink-sdk')
        candidates = source.rutas_visor(rel)
        for index, candidate in enumerate(candidates):
            try:
                with source.abrir(candidate, rango=self.headers.get('Range'), head=head) as (status, headers, body):
                    return self._fuente_stream(status, headers, body, head)
            except (FileNotFoundError, urllib.error.HTTPError) as e:
                if getattr(e, 'code', 404) != 404 or index == len(candidates) - 1:
                    raise

    def _mapa_tiff(self, rel, scale, head=False):
        if scale not in (1, 4, 8) or not re.fullmatch(r'catalog/[^/]+/segments/[^/]+/ink-detection/[^/]+\.tiff?', rel, re.I):
            raise ValueError('Ruta TIFF o escala invalida')
        source_rel = self.fuente.ruta_catalogo(rel)
        preview = getattr(self.fuente, 'preview', None)

        def published(jpg):
            with self.fuente.abrir(jpg, head=head) as (status, headers, body):
                return self._fuente_stream(status, headers, body, head)

        # The official bucket publishes a 1/8 JPEG beside each map: thumbnails need not download the full TIFF.
        jpg = preview(source_rel, 8) if preview and scale == 8 else None
        if jpg:
            return published(jpg)
        try:
            pixels = math.prod(tiff_dims(self.fuente, source_rel))
        except (ValueError, OSError, struct.error):
            pixels = None  # unknown size: decode as before and let Pillow's limit decide
        if pixels and scale > 1 and pixels > MAP_PIXELS:
            # Too large to decode here: a 1/4 request (always a preview) gets the published 1/8 JPEG when there is one.
            jpg = preview(source_rel, 8) if preview else None
            if jpg:
                return published(jpg)
        if pixels and (pixels > FULLRES_PIXELS if scale == 1 else pixels > MAP_PIXELS):
            raise MapTooLarge(f'Map too large for this scale: {pixels / 1e6:.0f} Mpx at 1/{scale}')
        import warnings
        from PIL import Image
        # Whole-segment maps reach a few hundred megapixels (an official 2.4 um map is 14760 x 18520); allow them as
        # canonical_masks and the Vast catalog do. The byte cap below still bounds what is read.
        Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, MAP_PIXELS)
        # Only decode a requested 2D ink map, never CT volumes or TIFXYZ mesh coordinates.
        with tempfile.SpooledTemporaryFile(max_size=8 * 2**20) as image_file:
            with self.fuente.abrir(source_rel) as (_, _, body):
                total = 0
                for block in iter(lambda: body.read(2**20), b''):
                    total += len(block)
                    if total > 256 * 2**20:
                        raise ValueError('Mapa TIFF mayor a 256 MiB: genera previews PNG')
                    image_file.write(block)
            image_file.seek(0)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', Image.DecompressionBombWarning)
                image = Image.open(image_file)
            with image:
                if image.format != 'TIFF' or getattr(image, 'n_frames', 1) != 1 or image.mode == 'F':
                    raise ValueError('Se admite TIFF 2D entero; exporta los stacks o float a PNG')
                if scale != 1:
                    image.thumbnail((max(1, image.width // scale), max(1, image.height // scale)))
                with tempfile.SpooledTemporaryFile(max_size=8 * 2**20) as output:
                    image.save(output, format='PNG')
                    length = output.tell(); output.seek(0)
                    return self._fuente_stream(200, {'Content-Length': str(length), 'Content-Type': 'image/png'}, output, head)

    def _fuente_stream(self, status, headers, body, head=False, fuente=None):
        etag = headers.get('ETag')
        if status == 200 and etag and any(value.strip().removeprefix('W/') in (etag, '*')
                                         for value in self.headers.get('If-None-Match', '').split(',')):
            self.send_response(304)
            for key in ('ETag', 'Last-Modified', 'Cache-Control'):
                if headers.get(key): self.send_header(key, headers[key])
            self.end_headers()
            return
        self.send_response(status)
        for key in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Cache-Control'):
            if headers.get(key): self.send_header(key, headers[key])
        self.send_header('X-Fuente', fuente or self.fuente.tipo)
        self.end_headers()
        if head: return
        remaining = int(headers.get('Content-Length', 2**63))
        while remaining:
            chunk = body.read(min(262144, remaining))
            if not chunk: break
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def _fuente_get(self, head=False):
        path = unquote(urlsplit(self.path).path).lstrip('/')
        params = parse_qs(urlsplit(self.path).query)
        optional = path.startswith('api/etiqueta/') and params.get('opcional') == ['1']
        try:
            ruta_dentro(Path('/'), path)
            if path == 'all-gallery/manifest.js' and self.fuente.manifest_rel:
                if self.fuente.tipo == 'local':
                    manifest_root = self.fuente.site/'cache' if hasattr(self.fuente,'vast_index_root') else Path(self.fuente.origen)
                    stat = ruta_dentro(manifest_root, self.fuente.manifest_rel).stat()
                    revision = (stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
                    body, compressed, etag = manifest_bytes(self.fuente, revision)
                else:
                    body, compressed, etag = manifest_bytes.__wrapped__(self.fuente, None)
                extra = inksdk.manifest_generado(self.fuente)
                if extra:  # maps generated here by ink-sdk jobs live beside the annotations, never in the source
                    data = json.loads(body.decode()[len('window.manifest='):].rstrip().rstrip(';')) + extra
                    body, compressed, etag = encoded_bytes(('window.manifest=' + json.dumps(data, separators=(',', ':')) + ';\n').encode())
                return self._send_bytes(body, 'application/javascript', self.fuente.tipo, head,
                                        etag=etag, gzipped=compressed)
            if self.fuente.manifest_rel and path in ('catalog/_viewer/manifest-work3.js', 'all-gallery/derived-c019/manifest-c019-local.js'):
                return self._send_bytes(b'// Generated index is authoritative.\n', 'application/javascript', self.fuente.tipo, head)
            if path.startswith('api/mapa/'):
                return self._mapa_tiff(path[len('api/mapa/'):], int(params.get('escala', ['1'])[0]), head)
            if path == 'api/inksdk':
                ok, why = inksdk.disponible()
                return self._json({'disponible': ok, 'motivo': why, 'escritura': bool(self.fuente.anotaciones),
                                   'perfiles': inksdk.perfiles() if ok else []})
            if path == 'api/inksdk/volumenes':
                vols = inksdk.volumenes(self.fuente, params.get('rollo', [''])[0], params.get('segmento', [''])[0])
                ok, _ = inksdk.disponible()
                profiles = inksdk.perfiles() if ok else []
                return self._json([dict({k: v for k, v in v.items() if k != 'rel'},
                                        perfiles=[p['id'] for p in profiles if inksdk.compatible(p, v['res'])]) for v in vols])
            if path == 'api/inksdk/trabajos':
                return self._json(inksdk.TRABAJOS.lista())
            if path == 'api/corte':
                q = {k: v[0] for k, v in params.items()}
                try:
                    body, info = corte.corte_png(getattr(self.server, 'ct_fuente', None) or self.fuente, q.get('rollo'), q.get('segmento'), q.get('volumen'),
                                                 q.get('u', ''), q.get('v', ''), q.get('w'), q.get('h'), q.get('tam', corte.TAM),
                                                 q.get('res'), q.get('dist'), q.get('kev'))
                except ImportError as e:
                    return self._json({'error': 'Cross-sections need numpy, tifffile and numcodecs (pip install ".[corte]"): ' + str(e)}, 501)
                except (ValueError, FileNotFoundError) as e:
                    return self._json({'error': str(e)}, 404 if isinstance(e, FileNotFoundError) else 400)
                self.send_response(200)
                for k, v in (('Content-Type', 'image/png'), ('Content-Length', str(len(body))), ('X-Corte', json.dumps(info)),
                             ('Cache-Control', 'private, max-age=3600')):
                    self.send_header(k, v)
                self.end_headers()
                if not head:
                    self.wfile.write(body)
                return
            if path == 'api/inventario':
                return self._json(master.listing(self.fuente, params))
            if path == 'api/inventario-mapa':
                return self._json(master.map_request(self.fuente, params))
            if path == 'api/inventario-overlay':
                return self._json(master.overlay(self.fuente, params, validar_par))
            if path == 'api/inventario-display':
                return self._send_bytes(master.display_asset(self.fuente,params,validar_par),'image/png','canonical-display',head)
            if path == 'api/inventario-nativa':
                if params.get('preview') == ['1']:
                    return self._send_bytes(master.native_info(self.fuente,params,True),'image/png','canonical',head)
                return self._json(master.native_info(self.fuente,params))
            if path.startswith('api/inventario/'):
                return self._json(master.detail(self.fuente,path.split('/')[-1]))
            if path == 'api/mascaras-zarr':
                return self._json(canonical.zarr_inventory(self.fuente))
            if path.startswith('api/mascaras-zarr/'):
                _, _, identity, depth = path.split('/')
                return self._send_bytes(canonical.zarr_preview(self.fuente, identity, int(depth)), 'image/png', 'canonical', head)
            if path == 'api/mascaras-canonicas' or path.startswith('api/mascaras-canonicas/'):
                data = canonical.inventory(self.fuente)
                if data is None: return self._json({'error':'Canonical inventory unavailable'},404)
                if path != 'api/mascaras-canonicas':
                    _, _, identity, role = path.split('/')
                    record = data['by_id'].get(identity)
                    if not record: return self._json({'error':'Unknown mask version'},404)
                    asset = next((a for a in record['assets'] if a['role'] == role),None)
                    if asset is None: return self._json({'error':'Unknown mask role'},404)
                    body = canonical.read_asset(self.fuente, asset)
                    if Path(asset['canonical']).suffix.lower() in ('.tif','.tiff'):
                        if params.get('metadata') == ['1']: return self._json(canonical.tiff_view(body))
                        if params.get('preview') == ['1']: return self._send_bytes(canonical.tiff_view(body,int(params.get('frame',['0'])[0])), 'image/png', 'canonical', head)
                    return self._send_bytes(body, TYPES.get(Path(asset['canonical']).suffix,'application/octet-stream'),'canonical',head)
                rows = [r for r in data['records'] if r.get('unit') != 'filesystem_metadata']
                roll = params.get('rollo',[None])[0]
                if roll: rows = [r for r in rows if r['roll'] == roll]
                query = params.get('q',[''])[0].lower()
                if query: rows = [r for r in rows if query in ' '.join(str(r.get(k,'')) for k in ('segment','declared_surface','depth','depth_declared','series','type')).lower()]
                offset = max(0,int(params.get('offset',['0'])[0]))
                return self._json({'total':len(rows),'records':[canonical.public_record(r) for r in rows[offset:offset+100]]})
            if path == 'api/propuestas':
                registry = canonical.inventory(self.fuente)
                if registry is not None:
                    return self._json(sorted({r['segment'] for r in registry['records'] if r.get('segment') and ('auto' in r.get('type','').lower() or 'propuesta' in r.get('I',''))}))
                data = self.fuente.indice('propuestas.json')
                return self._json(sorted(data) if isinstance(data, list) else [])
            if path.startswith('api/dims/'):
                generated = inksdk.archivo_generado(self.fuente, path[len('api/dims/'):])
                if generated:
                    with generated.open('rb') as body:
                        hdr = body.read(24)
                elif re.search(r'\.tiff?$', path, re.I):
                    w, h = tiff_dims(self.fuente, self.fuente.ruta_catalogo(path[len('api/dims/'):]))
                    return self._json({'w': w, 'h': h})
                else:
                    with self.fuente.abrir(self.fuente.ruta_catalogo(path[len('api/dims/'):]), rango='bytes=0-23') as (_, _, body):
                        hdr = body.read(24)
                if len(hdr) != 24 or hdr[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError('No es una cabecera PNG')
                w, h = struct.unpack('>II', hdr[16:24])
                return self._json({'w': w, 'h': h})
            if path.startswith('api/etiqueta/'):
                rel = path[len('api/etiqueta/'):]
                base = labels_base(rel.split('/')[0], params.get('base', [None])[0], params.get('rollo', [None])[0], self.fuente)
                path = f'catalog/{base}/labels/por-profundidad/' + ('_propuestas/' if params.get('propuesta') == ['1'] else '') + rel
            return self._fuente_archivo(path, head)
        except (FileNotFoundError, urllib.error.HTTPError) as e:
            code = getattr(e, 'code', 404)
            if code == 404 and optional:
                self.send_response(204); self.end_headers(); return
            if (code == 404 or code == 403 and self.fuente.tipo == 's3') and path == 'all-gallery/manifest.js' and not head:
                try:
                    data = self.fuente.indice('all-gallery/manifest.json', limite=256 * 2**20)
                    if code == 403 and not isinstance(data, list):
                        return self.send_error(403, 'S3 rechazo la lectura del manifiesto')
                    return self._send_bytes(('window.manifest=' + json.dumps(data if isinstance(data, list) else []) + ';\n').encode(), 'application/javascript', self.fuente.tipo)
                except Exception as ex:
                    return self.send_error(502, str(ex))
            if code == 404 and path in ('catalog/_viewer/manifest-work3.js', 'all-gallery/derived-c019/manifest-c019-local.js') and not head:
                return self._send_bytes(b'// Optional manifest absent.\n', 'application/javascript', self.fuente.tipo)
            return self.send_error(code, 'El archivo no existe en el origen elegido' if code == 404 else str(e))
        except ValueError as e:
            return self.send_error(400, str(e))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            return self.send_error(502, str(e))

    def do_GET(self):
        self.fuente = getattr(self.server, 'fuente', None)
        path = unquote(urlsplit(self.path).path).lstrip('/')
        if self.fuente or path == 'api/origen':
            if not self._host_local(): return self.send_error(403)
        if path == 'api/origen':
            return self._json(self._origen_info())
        if self._codigo(): return
        if path.startswith('api/mascara-par/'):
            return self._leer_par(path[len('api/mascara-par/'):])
        if urlsplit(self.path).path == '/api/rollo.js':
            # Query metadata for the requested sample; no physical scale is guessed.
            q = parse_qs(urlsplit(self.path).query).get('rollo', [None])[0] or (self.fuente.scroll if self.fuente else None)
            if q:
                try:
                    src = cargar_rollo(q, self.fuente)
                except (ValueError, FileNotFoundError):
                    return self.send_error(404, f'no existe el rollo {q}')
                except Exception as e:
                    return self.send_error(502, str(e))
                proxy = {'tipo': self.fuente.tipo, 'origen': self.fuente.origen} if self.fuente else {'espejo_work3': espejo_de(src['scroll']), 'etiquetas_sin_segmento': f'_unresolved/{src["scroll"]}'}
                info = dict(src, proxy=proxy)
            elif ROLLO:
                info = dict(ROLLO, proxy={'espejo_work3': ESPEJO, 'etiquetas_sin_segmento': LABELS_UNKNOWN})
            else:
                info = {}
            body = ('window.ROLLO_SERVIDOR=' + json.dumps(info, ensure_ascii=True) + ';\n').encode()
            return self._send_bytes(body, 'application/javascript; charset=utf-8', 'proxy')
        if self.fuente:
            return self._fuente_get()
        if self.path.startswith('/api/propuestas'):
            # GET /api/propuestas -> ["<lamina>", ...] con etiquetas propuestas (labels/por-profundidad/_propuestas/ en work-3)
            laminas = index('propuestas.json')
            return self._json(sorted(laminas) if isinstance(laminas, list) else [])
        if self.path.startswith('/api/etiqueta/'):
            # GET /api/etiqueta/<lamina>/<c+NN>/<file>.png[?propuesta=1] -> la etiqueta desde work-3 (oficial o _propuestas/)
            q = urlsplit(self.path); rel = unquote(q.path[len('/api/etiqueta/'):]); prop = 'propuesta=1' in (q.query or '')
            if '..' in rel.split('/'):
                return self.send_error(400, 'Invalid path')
            params = parse_qs(q.query)
            base = labels_base(rel.split('/')[0], params.get('base', [None])[0], params.get('rollo', [None])[0])
            url = work3_url(f'catalog/{base}/labels/por-profundidad/' + ('_propuestas/' if prop else '') + rel)
            if 'opcional=1' in (q.query or ''):   # 25-sep (etiq_herramientas.js): lo que puede no existir -> 204, sin error en la consola
                if self._stream(url, missing_ok=True) == 404:
                    self.send_response(204)
                    self.end_headers()
                return
            return self._stream(url)
        if self.path.startswith('/api/dims/'):
            # GET /api/dims/<rel>.png -> {"w","h"} from the PNG header (24 bytes: Mac file, else a work-3 Range). Lets the viewer
            # show the 1/4 preview upscaled to the EXACT full-res size without downloading the PNG (12-sep, HD off by default).
            rel = unquote(self.path[len('/api/dims/'):].split('?')[0])
            try:
                if '..' in Path(rel).parts: raise ValueError('Invalid path')
                mac = load_mac_index().get(rel)
                loc = next((q for q in (ROOT / rel, CACHE / rel, ROOT / mac if mac else None) if q and q.is_file()), None)
                if loc:
                    hdr = loc.open('rb').read(24)
                else:
                    try:
                        req = urllib.request.Request(work3_url(rel), headers={'Range': 'bytes=0-23'})
                        with urllib.request.urlopen(req, timeout=WORK3_TIMEOUT) as response: hdr = response.read(24)
                    except urllib.error.HTTPError as e:
                        key = load_s3_once_index().get(rel)
                        if e.code != 404 or not key: raise
                        hdr = s3_once(rel, key)[:24]
                if hdr[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError('Not a PNG header')
                w, h = struct.unpack('>II', hdr[16:24])
                return self._json({'w': w, 'h': h})
            except Exception as e:
                return self.send_error(404, str(e)[:120])
        path = unquote(urlsplit(self.path).path).lstrip('/')
        if '..' in Path(path).parts:
            return self.send_error(400, 'Invalid path')
        if (ROOT / path).is_file() or (ROOT / path / 'index.html').is_file():
            return super().do_GET()
        if (CACHE / path).is_file():
            return self._serve_file(CACHE / path)
        mac = load_mac_index().get(path)
        if mac and (ROOT / mac).is_file():
            return self._serve_file(ROOT / mac)
        key = load_s3_once_index().get(path) if path.startswith('catalog/') else None
        if not key:
            return self._stream(work3_url(path))
        if self._stream(work3_url(path), missing_ok=True) == 404:
            try:
                body = s3_once(path, key)
            except Exception as e:
                log(f'!! S3 -> work-3 fallo {path}: {str(e)[:160]}')
                return self.send_error(502, 'no se pudo traer de S3 a work-3')
            self._send_bytes(body, TYPES.get(Path(path).suffix, 'application/octet-stream'), 's3->work-3')

    def _datos_par(self, lamina):
        params = parse_qs(urlsplit(self.path).query)
        rollo = params.get('rollo', [None])[0]
        if rollo and not re.fullmatch(r'PHerc[A-Za-z0-9]+', rollo):
            raise ValueError('Rollo invalido')
        base = labels_base(lamina, params.get('base', [None])[0], rollo, self.fuente)
        depth = profundidad(params)
        folder = ubicacion_par(lamina, base, depth, params.get('propuesta') == ['1'])
        ruta_dentro(Path('/'), folder)
        return params, base, depth, rollo, folder

    def _leer_par(self, lamina):
        if self.fuente and self.headers.get('X-Visor-Origen') not in (None, self.fuente.id):
            return self._json({'error': 'El origen cambio; recarga antes de importar mascaras'}, 409)
        try:
            params, base, depth, rollo, folder = self._datos_par(lamina)
            candidates = canonical.select(self.fuente, rollo or base.split('/')[0], base.split('/')[-1], depth, params.get('propuesta') == ['1'])
            if candidates is not None:
                identity = params.get('version',[None])[0]
                if identity: candidates = [r for r in candidates if r['id'] == identity]
                if not candidates:
                    if params.get('opcional') == ['1']:
                        self.send_response(204); self.end_headers(); return
                    return self._json({'error':'No canonical mask pair for this surface and depth'},404)
                if len(candidates) != 1:
                    return self._json({'error':'Choose a canonical mask series/version','versions':[canonical.public_record(r) for r in candidates]},409)
                record = candidates[0]
                bodies = [canonical.read_asset(self.fuente,a) for a in record['assets']]
                info = validar_par(*bodies,None,lamina,base,depth,rollo)
                if params.get('metadata') == ['1']: return self._json({'corrida':info,'canonical_version':record['id']})
                return self._json(dict(zip(('inklabels','supervision_mask'),[base64.b64encode(b).decode('ascii') for b in bodies]),corrida=info,canonical_version=record['id']))
            bodies = []
            # Resolve both generation members under one lock, never through separate HTTP snapshots.
            with self.fuente.mascara_lock if self.fuente else _guard:
                local_folder = self.fuente.mascara_local(folder) if self.fuente else None
                for suffix in ('inklabels', 'supervision_mask'):
                    rel = folder + '/' + lamina + '_' + suffix + '.png'
                    local = local_folder / (lamina + '_' + suffix + '.png') if local_folder else None
                    try:
                        if local and local.is_file():
                            body = local.read_bytes()
                        elif self.fuente:
                            with self.fuente.abrir(self.fuente.ruta_catalogo(rel)) as (_, _, stream):
                                body = stream.read(MASK_LIMIT + 1)
                        else:
                            with urllib.request.urlopen(work3_url(rel), timeout=WORK3_TIMEOUT) as stream:
                                body = stream.read(MASK_LIMIT + 1)
                        bodies.append(body)
                    except (FileNotFoundError, urllib.error.HTTPError) as error:
                        if getattr(error, 'code', 404) != 404:
                            raise
                        bodies.append(None)
                if all(body is None for body in bodies):
                    if params.get('opcional') == ['1']:
                        self.send_response(204); self.end_headers(); return
                    return self._json({'error': 'No hay par de mascaras guardado'}, 404)
                if any(body is None for body in bodies):
                    return self._json({'error': 'Par incompleto: falta inklabels o supervision_mask'}, 409)
                info = validar_par(*bodies, None, lamina, base, depth, rollo)
            if params.get('metadata') == ['1']:
                return self._json({'corrida': info})
            return self._json(dict(zip(('inklabels', 'supervision_mask'), [base64.b64encode(body).decode('ascii') for body in bodies]), corrida=info))
        except (ValueError, TypeError) as error:
            return self._json({'error': str(error)}, 400)
        except Exception as error:
            return self._json({'error': str(error)}, 502)

    def _guardar_par(self, lamina):
        if not self.fuente:
            return self._json({'error': 'El escritor legacy no ofrece transacciones de pares. Configura una carpeta local de anotaciones.'}, 501)
        try:
            n = int(self.headers.get('Content-Length', 0))
            if self.headers.get_content_type() != 'application/json' or not 0 < n <= MASK_LIMIT:
                raise ValueError('Esperaba JSON de par de hasta 64 MiB')
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or set(data) - {'inklabels', 'supervision_mask', 'corrida'}:
                raise ValueError('Campos de par invalidos')
            bodies = []
            for key in ('inklabels', 'supervision_mask'):
                if not isinstance(data.get(key), str) or len(data[key]) > ((MASK_LIMIT + 2) // 3) * 4:
                    raise ValueError('Falta PNG base64 o supera 64 MiB')
                bodies.append(base64.b64decode(data[key], validate=True))
            _, base, depth, rollo, folder = self._datos_par(lamina)
            info = data.get('corrida')
            if not isinstance(info, dict) or not isinstance(info.get('par_id'), str) or not info['par_id'] or not isinstance(info.get('run_id'), str) or not info['run_id']:
                raise ValueError('El par requiere corrida con run_id y par_id')
            orientation = info.get('orientacion')
            correction = orientation.get('correccion') if isinstance(orientation, dict) else None
            if 'cara' not in info or not isinstance(orientation, dict) or 'correccion' not in orientation or correction is not None and (not isinstance(correction, list) or len(correction) != 3 or any(type(v) is not int or v not in (0, 1) for v in correction)):
                raise ValueError('El par requiere cara y orientacion explicitamente registradas')
            if 'base' not in info:
                raise ValueError('El par requiere base de origen registrada')
            info = validar_par(*bodies, info, lamina, base, depth, rollo)
            if not leer_mascara(bodies[1])[0].getbbox():
                raise ValueError('No se guarda un par sin pixeles supervisados')
            directories = [ubicacion_par(lamina, base, 'max'), folder]
            files = dict(zip((lamina + '_inklabels.png', lamina + '_supervision_mask.png'), bodies))
            if info is not None:
                files[lamina + '_mascara_corrida.json'] = json.dumps(info, ensure_ascii=True).encode()
            # All class, geometry and provenance validation completes before this first write.
            self.fuente.guardar_par(directories, files)
            claves = [directory.removeprefix('catalog/') + '/' + name for directory in dict.fromkeys(directories) for name in files]
            sync = getattr(self.server, 'hf_sync', None)
            if sync:  # mirror after the local write; the local folder stays the source of truth
                prefix = 'official' if self.fuente.config().get('origen') == 'official' else self.fuente.id
                sync.submit({prefix + '/' + clave: files[clave.rsplit('/', 1)[1]] for clave in claves},
                            f'Annotations: {lamina}, depth {depth}')
            return self._json({'ok': True, 'destino': 'anotaciones-locales', 'hf': sync.repo if sync else None, 'claves': claves,
                               'clave': claves[0], 'clave_profundidad': folder.removeprefix('catalog/') + '/' + lamina + '_inklabels.png'})
        except (ValueError, TypeError, binascii.Error) as error:
            return self._json({'error': str(error)}, 400)
        except (OSError, PermissionError) as error:
            return self._json({'error': str(error)}, 500)

    def do_POST(self):
        path = unquote(urlsplit(self.path).path).lstrip('/')
        if path == 'api/origen':
            return self._cambiar_origen()
        self.fuente = getattr(self.server, 'fuente', None)
        if not self._host_local(): return self.send_error(403)
        if self.headers.get('Origin') not in (None, 'http://' + self.headers['Host']):
            return self._json({'error': 'Origen del navegador no autorizado'}, 403)
        if self.fuente:
            if self.headers.get('X-Visor-Origen') != self.fuente.id:
                return self._json({'error': 'Origen distinto o pestana desactualizada; recarga antes de guardar'}, 409)
            if not self.fuente.anotaciones:
                return self._json({'error': 'Origen de solo lectura: configura una carpeta de anotaciones'}, 403)
        if path.startswith('api/mascara-par/'):
            return self._guardar_par(path[len('api/mascara-par/'):])
        if path == 'api/inksdk/trabajos':
            if not self.fuente:
                return self._json({'error': 'ink-sdk jobs need a configured source'}, 400)
            ok, why = inksdk.disponible()
            if not ok:
                return self._json({'error': why}, 503)
            try:
                n = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(n)) if 0 < n <= 4096 else None
                if not isinstance(data, dict):
                    raise ValueError('Expected a JSON object')
                job = inksdk.TRABAJOS.crear(self.fuente, data.get('rollo'), data.get('segmento'), data.get('volumen'),
                                            data.get('perfil'), log)
            except (ValueError, TypeError, PermissionError) as error:
                return self._json({'error': str(error)}, 400)
            return self._json(job, 202)
        if not path.startswith('api/mascara/'):
            return self.send_error(404)
        rel = path[len('api/mascara/'):]
        if not re.fullmatch(r'[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*\.(png|json)', rel) or '..' in rel:
            return self.send_error(400, 'esperaba <lamina>/<archivo>.png o .json')
        try:
            n = int(self.headers.get('Content-Length', 0))
            if not 0 < n <= MASK_LIMIT:
                raise ValueError('Cuerpo vacio o mayor a 64 MiB')
            body = self.rfile.read(n)
            lamina, name = rel.split('/')
            _, base, depth, rollo, folder = self._datos_par(lamina)
            if rel.endswith('.png'):
                image, info = leer_mascara(body)
                validar_corrida(info, image.size, lamina, base, depth, rollo)
            else:
                info = json.loads(body)
                if not isinstance(info, dict):
                    raise ValueError('JSON de corrida invalido')
                # A lone sidecar must bind the destination too; complete PNG geometry is checked by the pair endpoint.
                validar_corrida(info, (info.get('ancho'), info.get('alto')), lamina, base, depth, rollo)
            claves = [ubicacion_par(lamina, base, 'max').removeprefix('catalog/') + '/' + name]
            if depth != 'max':
                claves.append(folder.removeprefix('catalog/') + '/' + name)
            if name.endswith(('_inklabels.png', '_supervision_mask.png', '_mascara_corrida.json')):
                return self._json({'error': 'Los miembros de un par se guardan juntos: usa /api/mascara-par'}, 409)
            if self.fuente and any((Path(self.fuente.anotaciones) / self.fuente.id / ('catalog/' + key)).parent.is_symlink() for key in claves):
                return self._json({'error': 'Esta mascara pertenece a un par: usa /api/mascara-par para conservar la transaccion'}, 409)
        except (ValueError, TypeError) as error:
            return self._json({'error': str(error)}, 400)
        for key in claves:
            try:
                if self.fuente:
                    self.fuente.guardar_mascara('catalog/' + key, body)
                    status, reply = 201, {'status': 'created'}
                else:
                    status, reply = writer_put(key, body)
            except (OSError, ValueError, PermissionError) as error:
                return self._json({'error': str(error)}, 500)
            if status >= 300:
                if rel.endswith('.json') and status == 400:
                    return self._json({'ok': False, 'motivo': 'catalog_writer no acepta JSON; usa un par con metadatos PNG'})
                return self._json({'error': 'No se pudo guardar en el escritor legacy'}, 502)
        return self._json({'ok': True, 'destino': 'anotaciones-locales' if self.fuente else 'work-3',
                           'clave': claves[0], 'clave_profundidad': claves[1] if len(claves) > 1 else None})

    def _serve_file(self, fp: Path, head=False):
        ctype = self.guess_type(str(fp))
        try:
            revision = file_revision(fp)
            if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json', 'image/svg+xml'):
                body, compressed, etag = file_bytes(str(fp), revision)
                return self._send_bytes(body, ctype, 'mac-cache', head, etag, compressed)
            with fp.open('rb') as body:
                headers = {'Content-Type': ctype, 'Content-Length': str(revision[3]),
                           'ETag': '"' + '-'.join(str(value) for value in revision) + '"',
                           'Cache-Control': 'private, no-cache'}
                return self._fuente_stream(200, headers, body, head, fuente='mac-cache')
        except OSError:
            self.send_error(404)
            return


def main():
    global PORT, LOG_FILE
    ap = argparse.ArgumentParser(description='Proxy del visor (todos los rollos del docroot; ver el docstring del modulo).')
    ap.add_argument('--scroll', default=os.environ.get('SCROLL'), help='opcional: fija el default de este proxy; sin el sirve todos los rollos')
    ap.add_argument('--port', type=int, default=PORT, help='puerto (S3CACHE_PORT; 8797 por defecto)')
    ap.add_argument('--raiz', default=os.environ.get('VISOR_RAIZ'),
                    help='docroot con all-gallery/ y los indices (VISOR_RAIZ; por defecto el directorio actual)')
    ap.add_argument('--dry-run', action='store_true', help='imprime lo resuelto (JSON) y sale sin abrir el puerto ni tocar la red')
    ap.add_argument('--origen', '--source', dest='origen', default=os.environ.get('VISOR_ORIGEN'), help='dataset root: local folder, HTTP/HTTPS URL, s3://bucket/prefix, or "official" for the Vesuvius Challenge open-data bucket; no fallback to another source')
    ap.add_argument('--anotaciones', '--annotations', dest='anotaciones', default=os.environ.get('VISOR_ANOTACIONES', ''), help='separate local folder for saved masks; omitted = read-only')
    ap.add_argument('--s3-perfil', '--s3-profile', dest='s3_perfil', default=os.environ.get('VISOR_S3_PERFIL', ''), help='AWS profile; omitted = the standard SDK credential chain')
    ap.add_argument('--s3-endpoint', default=os.environ.get('VISOR_S3_ENDPOINT', ''), help='endpoint HTTP/HTTPS de un S3 compatible, por ejemplo MinIO')
    ap.add_argument('--s3-region', default=os.environ.get('VISOR_S3_REGION', ''), help='region del origen S3')
    ap.add_argument('--ct-origen', '--ct-source', dest='ct_origen', default=os.environ.get('VISOR_CT_ORIGEN', ''),
                    help='where cross-sections read meshes and CT when the map source lacks them: a root holding PHerc... '
                         'folders, e.g. https://vesuvius-challenge-open-data.s3.amazonaws.com (read-only)')
    ap.add_argument('--annotations-hf', default=os.environ.get('VISOR_ANNOTATIONS_HF', ''),
                    help='also push each saved mask pair to this Hugging Face dataset (user/dataset, created private if absent); '
                         'needs --annotations, which stays the source of truth; token from HF_TOKEN or `hf auth login`')
    ap.add_argument('--config', default=os.environ.get('VISOR_CONFIG', str(Path.home() / '.config/vesuvius-visor/config.json')), help='archivo JSON que recuerda el origen elegido desde el visor')
    a = ap.parse_args()
    config_path = Path(a.config).expanduser().resolve()
    try:
        if a.origen:
            source = Fuente(a.origen, a.s3_perfil, a.s3_endpoint, a.s3_region, a.anotaciones)
        elif config_path.is_file():
            data = json.loads(config_path.read_text())
            for key, value in (('anotaciones', a.anotaciones), ('perfil', a.s3_perfil), ('endpoint', a.s3_endpoint), ('region', a.s3_region)):
                if value: data[key] = value
            source = Fuente(**data)
        else:
            source = None  # The source picker remains available; legacy routing requires explicit environment configuration.
        if source and a.raiz:
            ap.error('--raiz es del modo legacy; usa --origen para elegir la carpeta de datos')
    except (ValueError, TypeError, OSError) as e:
        ap.error(str(e))
    info = configurar(a.scroll, a.raiz, source)
    PORT = info['port'] = a.port
    if source:
        info = dict(source.info(), port=a.port, config=str(config_path), codigo=str(CODE))
    try:
        ct_source = corte.fuente_ct(a.ct_origen)
    except (ValueError, TypeError, OSError) as e:
        ap.error('--ct-origen: ' + str(e))
    info['ct_origen'] = ct_source.origen if ct_source else ''
    if a.annotations_hf and not (source and source.anotaciones):
        ap.error('--annotations-hf mirrors saved masks: it needs --annotations')
    info['annotations_hf'] = a.annotations_hf
    if a.dry_run:
        print(json.dumps(info, indent=1, ensure_ascii=False))
        return
    if source:
        source.verificar()
        config_path.parent.mkdir(parents=True, exist_ok=True)
        LOG_FILE = config_path.parent / 'visor.log'
        log(f'arrancando en :{PORT}; origen {source.tipo}: {source.origen}; anotaciones: {source.anotaciones or "solo lectura"}')
    else:
        log(f'arrancando {"todos los rollos" if not SCROLL else SCROLL} en :{PORT}, docroot={ROOT}; imagenes: Mac -> work-3 '
            f'({WORK3_BASE}) -> S3 una vez a work-3; etiquetas en work-3' + (f' (sin segmento: {LABELS_UNKNOWN})' if LABELS_UNKNOWN else ''))
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.fuente, srv.config_path, srv.ct_fuente = source, config_path, ct_source
    srv.config_token, srv.config_lock = secrets.token_urlsafe(32), threading.Lock()
    srv.daemon_threads = True
    if a.annotations_hf:
        try:
            srv.hf_sync = HFSync(a.annotations_hf)
        except Exception as e:
            ap.error('--annotations-hf: ' + str(e))
        log(f'anotaciones espejadas en https://huggingface.co/datasets/{a.annotations_hf}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
