"""Local folders, HTTP directories and S3 prefixes with the same viewer layout."""
import contextlib
import fcntl
import hashlib
import json
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit


_annotation_locks, _annotation_guard = {}, threading.Lock()

ZARR_META = frozenset({'.zarray', '.zattrs', '.zgroup'})


def ruta_dentro(root, rel, zarr_meta=False):
    """Resolve rel inside root. Hidden names are refused; zarr_meta=True admits only a final zarr v2 metadata name."""
    parts = rel.split('/') if rel else []
    hidden = [i for i, p in enumerate(parts) if p.startswith('.')]
    allowed = zarr_meta and hidden == [len(parts) - 1] and parts[-1] in ZARR_META
    if not rel or rel.startswith('/') or '\\' in rel or any(p in ('.', '..') for p in parts) or (hidden and not allowed):
        raise ValueError('Ruta de datos invalida')
    path = (root / rel).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('La ruta sale de la carpeta elegida')
    return path


def url_http(value):
    u = urlsplit(value)
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError('Usa una URL HTTP/HTTPS base, sin credenciales, query ni fragmento')
    if any(p in ('.', '..') for p in u.path.split('/')):
        raise ValueError('URL base invalida')
    return value.rstrip('/')


def guardar_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
            name = f.name
            json.dump(data, f, indent=2, ensure_ascii=True)
            f.write('\n')
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def fsync_directorio(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_ruta(path, root):
    while True:
        fsync_directorio(path)
        if path == root:
            break
        path = path.parent


class Fuente:
    def __init__(self, origen, perfil='', endpoint='', region='', anotaciones=''):
        if not isinstance(origen, str) or not origen.strip():
            raise ValueError('Falta la carpeta o URL de origen')
        origen = origen.strip()
        if origen.startswith(('http://', 'https://')):
            self.tipo, self.origen = 'http', url_http(origen)
        elif origen.startswith('s3://'):
            u = urlsplit(origen)
            if not u.netloc or u.query or u.fragment or u.username or u.password:
                raise ValueError('Usa s3://bucket/prefijo')
            prefix = u.path.strip('/')
            if prefix:
                ruta_dentro(Path('/'), prefix)
            self.tipo, self.origen = 's3', 's3://' + u.netloc + ('/' + prefix if prefix else '')
        else:
            if '://' in origen:
                raise ValueError('Origen admitido: carpeta local, HTTP/HTTPS o s3://')
            root = Path(origen).expanduser().resolve()
            if not root.is_dir():
                raise ValueError('La carpeta local no existe')
            self.tipo, self.origen = 'local', str(root)
        for value in (perfil, endpoint, region, anotaciones):
            if not isinstance(value, str):
                raise ValueError('Los campos de configuracion deben ser texto')
        if self.tipo != 's3' and (perfil or endpoint or region):
            raise ValueError('Perfil, endpoint y region son opciones de S3')
        self.perfil, self.endpoint, self.region = perfil.strip(), url_http(endpoint) if endpoint else '', region.strip()
        self.anotaciones = str(Path(anotaciones).expanduser().resolve()) if anotaciones else ''
        if self.anotaciones and not Path(self.anotaciones).is_dir():
            raise ValueError('La carpeta de anotaciones debe existir')
        self.id = hashlib.sha256((self.origen + '\n' + self.endpoint).encode()).hexdigest()[:20]
        self._s3, self._lock = None, threading.Lock()
        with _annotation_guard:
            self.mascara_lock = _annotation_locks.setdefault((self.anotaciones, self.id), threading.RLock())
        self.layout, self.scroll = 'docroot', None
        self.manifest_rel = None

    def listado(self, rel=''):
        """One directory level; never descend into CT/Zarr chunks to discover maps."""
        if rel:
            ruta_dentro(Path('/'), rel)
        if self.tipo == 'local':
            root = Path(self.origen)
            directory = ruta_dentro(root, rel) if rel else root
            if not directory.is_dir():
                return []
            return sorted((p.name, p.is_dir()) for p in directory.iterdir()
                          if not p.name.startswith('.') and not p.is_symlink())
        if self.tipo == 'http':
            raise ValueError('HTTP no ofrece un listado estandar: genera el manifiesto en la carpeta del servidor')
        u = urlsplit(self.origen)
        prefix = '/'.join(filter(None, (u.path.strip('/'), rel)))
        prefix += '/' if prefix else ''
        entries = set()
        for page in self.s3().get_paginator('list_objects_v2').paginate(Bucket=u.netloc, Prefix=prefix, Delimiter='/'):
            entries.update((p['Prefix'][len(prefix):].rstrip('/'), True) for p in page.get('CommonPrefixes', []))
            entries.update((p['Key'][len(prefix):], False) for p in page.get('Contents', []) if p['Key'] != prefix)
        return sorted((name, directory) for name, directory in entries if name and not name.startswith('.'))

    def ruta_catalogo(self, rel):
        ruta_dentro(Path('/'), rel)
        if not rel.startswith('catalog/') or self.layout == 'docroot':
            return rel
        tail = rel[len('catalog/'):]
        if self.layout == 'catalog':
            return tail
        sample, sep, path = tail.partition('/')
        if not sep or sample != self.scroll:
            raise FileNotFoundError('El archivo pertenece a otro rollo')
        return path

    def config(self):
        return {k: getattr(self, k) for k in ('origen', 'perfil', 'endpoint', 'region', 'anotaciones')}

    def rutas_visor(self, rel):
        """Read catalog-owned metadata without requiring another all-gallery copy."""
        names = {'alias.json', 'alias_presets.json', 'compuertas.json', 'compuertas-painting.json',
                 'compuertas-work3.json', 'hojas.json', 'legibilidad.json', 'legibilidad-fl22.json',
                 'orientacion_vista.json', 'mascaras.json', 'objetivo.json', 'metadata.json'}
        paths = [self.ruta_catalogo(rel)]
        if rel.startswith('all-gallery/') and rel[len('all-gallery/'):] in names:
            prefix = 'catalog/_viewer/' if self.layout == 'docroot' else '_viewer/'
            paths.append(prefix + rel[len('all-gallery/'):])
        return paths

    def info(self):
        return dict(self.config(), tipo=self.tipo, id=self.id, escritura=bool(self.anotaciones),
                    layout=self.layout, scroll=self.scroll, atomic_pair=bool(self.anotaciones))

    def s3(self):
        with self._lock:
            if self._s3 is None:
                try:
                    import boto3
                    from botocore.config import Config
                except ImportError as e:
                    raise RuntimeError('El modo S3 necesita boto3: instala requirements.txt') from e
                session = boto3.Session(profile_name=self.perfil or None)
                self._s3 = session.client('s3', endpoint_url=self.endpoint or None, region_name=self.region or None,
                                         config=Config(connect_timeout=10, read_timeout=30, retries={'max_attempts': 2}))
        return self._s3

    @contextlib.contextmanager
    def abrir(self, rel, rango=None, head=False, zarr_meta=False):
        ruta_dentro(Path('/'), rel, zarr_meta)
        if rango and not re.fullmatch(r'bytes=\d*-\d*', rango):
            raise ValueError('Range invalido')
        if self.tipo == 'local':
            path = ruta_dentro(Path(self.origen), rel, zarr_meta)
            if not path.is_file():
                # Existing local copies can have the official catalog names in an index.
                if rel.startswith('catalog/'):
                    alias = self.indice('mac_cache_index.json').get(rel)
                    if alias:
                        path = ruta_dentro(Path(self.origen), alias)
                if not path.is_file():
                    raise FileNotFoundError(rel)
            size = path.stat().st_size
            start, end, status = 0, size - 1, 200
            headers = {'Content-Type': mimetypes.guess_type(rel)[0] or 'application/octet-stream', 'Accept-Ranges': 'bytes'}
            if rango and not head:
                a, b = rango[6:].split('-')
                if not a and not b:
                    raise ValueError('Range vacio')
                start, end = (int(a), min(int(b), end) if b else end) if a else (max(0, size - int(b)), end)
                if start > end or start >= size:
                    raise urllib.error.HTTPError(rel, 416, 'Range fuera del archivo', {}, None)
                status = 206
                headers['Content-Range'] = f'bytes {start}-{end}/{size}'
            headers['Content-Length'] = str(max(0, end - start + 1))
            with path.open('rb') as body:
                body.seek(start)
                yield status, headers, body
        elif self.tipo == 'http':
            req = urllib.request.Request(self.origen + '/' + quote(rel, safe='/'), method='HEAD' if head else 'GET',
                                         headers={'Range': rango} if rango and not head else {})
            with urllib.request.urlopen(req, timeout=30) as response:
                yield response.status, response.headers, response
        else:
            u = urlsplit(self.origen)
            args = {'Bucket': u.netloc, 'Key': '/'.join(filter(None, (u.path.strip('/'), rel)))}
            if rango and not head:
                args['Range'] = rango
            try:
                response = (self.s3().head_object if head else self.s3().get_object)(**args)
            except Exception as e:
                status = getattr(e, 'response', {}).get('ResponseMetadata', {}).get('HTTPStatusCode')
                if status:
                    raise urllib.error.HTTPError(rel, status, 'S3 rechazo la lectura', {}, None) from e
                raise
            headers = {'Content-Type': response.get('ContentType', mimetypes.guess_type(rel)[0] or 'application/octet-stream'),
                       'Content-Length': str(response['ContentLength']), 'Accept-Ranges': 'bytes'}
            if response.get('ContentRange'):
                headers['Content-Range'] = response['ContentRange']
            if response.get('ETag'):
                headers['ETag'] = response['ETag']
            body = response.get('Body')
            try:
                yield response.get('ResponseMetadata', {}).get('HTTPStatusCode', 200), headers, body
            finally:
                if body:
                    body.close()

    def indice(self, name, limite=16 * 2**20):
        try:
            with self.abrir(name) as (_, _, body):
                data = body.read(limite + 1)
            if len(data) > limite:
                raise ValueError(f'Indice mayor a {limite // 2**20} MiB')
            return json.loads(data)
        except FileNotFoundError:
            return {}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}
            raise

    def verificar(self):
        denied = None
        try:
            info = self.indice('_viewer/index-info.json')
            if isinstance(info, dict) and info.get('schema') == 'vesuvius.viewer-index.v1':
                layout, scroll = info.get('layout'), info.get('scroll')
                if layout not in ('sample', 'catalog', 'docroot') or layout == 'sample' and not re.fullmatch(r'PHerc[A-Za-z0-9]+', scroll or ''):
                    raise ValueError('Layout del indice invalido')
                data = self.indice('_viewer/manifest.json', limite=256 * 2**20)
                if not isinstance(data, list):
                    raise ValueError('El manifiesto generado debe ser una lista')
                self.layout, self.scroll, self.manifest_rel = layout, scroll, '_viewer/manifest.json'
                return
        except urllib.error.HTTPError as e:
            if not (e.code == 403 and self.tipo == 's3'):
                raise
        for rel in ('all-gallery/manifest.js', 'all-gallery/manifest.json', 'catalog/_viewer/manifest-work3.json', 'catalog/_viewer/manifest-work3.js'):
            try:
                with self.abrir(rel, rango='bytes=0-1023') as (_, _, body):
                    start = body.read(1024).lstrip()
                if (rel.endswith('.js') and b'manifest' in start and not start.startswith(b'<')) or (rel.endswith('.json') and start.startswith(b'[')):
                    if rel == 'catalog/_viewer/manifest-work3.json':
                        self.manifest_rel = rel  # Serve the catalog index with gzip/ETag; never regenerate it.
                    return
            except FileNotFoundError:
                pass
            except urllib.error.HTTPError as e:
                # S3 without ListBucket can return 403 for an absent optional manifest.
                if e.code == 403 and self.tipo == 's3':
                    denied = e
                elif e.code != 404:
                    raise
        if denied:
            raise denied
        raise ValueError('No hay manifiesto: ejecuta generar_manifest.py sobre la carpeta del catalogo o usa all-gallery/')

    def mascara_local(self, rel):
        if not self.anotaciones:
            return None
        root = ruta_dentro(Path(self.anotaciones), self.id)
        return ruta_dentro(root, rel)

    def guardar_mascara(self, rel, body):
        path = self.mascara_local(rel)
        if path is None:
            raise PermissionError('Origen de solo lectura: configura una carpeta de anotaciones')
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.mascara_lock:
            name = None
            try:
                if path.exists():
                    history = path.parent / '.history'
                    if not history.resolve().is_relative_to((Path(self.anotaciones) / self.id).resolve()):
                        raise ValueError('Carpeta de historial invalida')
                    history.mkdir(exist_ok=True)
                    shutil.copy2(path, history / (path.name + '.' + str(time.time_ns())))
                with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
                    name = f.name
                    f.write(body)
                os.replace(name, path)
            finally:
                if name and os.path.exists(name):
                    os.unlink(name)


    @contextlib.contextmanager
    def _escritura_mascaras(self):
        root = ruta_dentro(Path(self.anotaciones), self.id)
        root.mkdir(parents=True, exist_ok=True)
        path = root / '.annotation.lock'
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('Lock de anotaciones invalido')
        with self.mascara_lock, path.open('a+b') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def guardar_par(self, directories, files):
        """Publish immutable pairs by atomically switching each directory alias.

        A crash between aliases can leave official/depth at different versions, but each
        alias always contains a complete pair. Previous generations remain on disk.
        """
        if not self.anotaciones:
            raise PermissionError('Origen de solo lectura: configura una carpeta de anotaciones')
        root = ruta_dentro(Path(self.anotaciones), self.id)
        if any('/' in name or name.startswith('.') for name in files):
            raise ValueError('Nombre de mascara invalido')
        with self._escritura_mascaras():
            targets = [root / rel for rel in dict.fromkeys(directories)]
            for rel in directories:
                ruta_dentro(root, rel)
            generations = root / '.mask-generations'
            if not generations.resolve().is_relative_to(root.resolve()):
                raise ValueError('Carpeta de generaciones invalida')
            generations.mkdir(parents=True, exist_ok=True)
            generation = Path(tempfile.mkdtemp(prefix='pair-', dir=generations))
            previous, published, temporary = [], [], []
            try:
                # ponytail: hard-link directory snapshots grow with saved history; prune only through an explicit retention policy.
                for target in targets:
                    if target.is_dir():
                        for old in target.iterdir():
                            if old.is_file() and old.name not in files:
                                if not old.resolve().is_relative_to(root.resolve()):
                                    raise ValueError('Archivo de mascara fuera de anotaciones')
                                if not (generation / old.name).exists():
                                    os.link(old, generation / old.name)
                        history = generation / '.history'
                        history.mkdir(exist_ok=True)
                        for name in files:
                            old = target / name
                            if old.is_file():
                                if not old.resolve().is_relative_to(root.resolve()):
                                    raise ValueError('Historial de mascara fuera de anotaciones')
                                os.link(old, history / (name + '.' + uuid.uuid4().hex))
                for name, body in files.items():
                    with (generation / name).open('wb') as stream:
                        stream.write(body)
                        stream.flush()
                        os.fsync(stream.fileno())
                fsync_directorio(generation)
                fsync_directorio(generations)
                fsync_directorio(root)
                fsync_directorio(root.parent)
                for target in targets:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    pending = target.parent / ('.pair-' + uuid.uuid4().hex)
                    pending.symlink_to(os.path.relpath(generation, target.parent), target_is_directory=True)
                    temporary.append(pending)
                    archived = None
                    if target.is_symlink():
                        old = os.readlink(target)
                    elif target.exists():
                        # Archive the intact legacy directory; a crash here loses an alias, never half a pair.
                        archived = generations / ('legacy-' + uuid.uuid4().hex)
                        old = None
                        os.replace(target, archived)
                    else:
                        old = None
                    previous.append((target, old, archived))
                    os.replace(pending, target)
                    published.append(target)
                    fsync_ruta(target.parent, root)
            except Exception:
                for target, old, archived in reversed(previous):
                    if archived:
                        if target.is_symlink():
                            target.unlink()
                        os.replace(archived, target)
                    elif old is not None:
                        pending = target.parent / ('.pair-' + uuid.uuid4().hex)
                        pending.symlink_to(old, target_is_directory=True)
                        temporary.append(pending)
                        os.replace(pending, target)
                    elif target in published and target.is_symlink():
                        target.unlink()
                    fsync_directorio(target.parent)
                shutil.rmtree(generation)
                raise
            finally:
                for pending in temporary:
                    if pending.is_symlink():
                        pending.unlink()
