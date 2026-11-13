"""Optional ink-sdk jobs: run a public ink model on a segment's surface volume and file the result as a catalog map.

Off unless INK_SDK_PYTHON names a Python environment with ink-sdk installed. Nothing here is imported by ink-sdk
or needs a GPU at import time; the viewer runs unchanged without it.

- Inputs: ``<sample>/segments/<segment>/surface-volumes/<res>um-[<dist>m-]<keV>keV-volume-<id>.zarr`` read through the
  viewer's Fuente (local folder, HTTP or S3). Level 0 only: one zarr array is copied chunk by chunk into a local cache.
- Outputs: never written to the source. They go to ``<anotaciones>/<fuente.id>/generated/`` with the catalog layout
  and naming, plus a receipt beside each map, and a generated index the server merges into the manifest.
- One job runs at a time (one GPU); further jobs wait in a queue.

Environment: INK_SDK_PYTHON (required), VILLA and VILLA_PY (9 um lane, passed through to ink-sdk),
INK_VIEWER_SV_CACHE (default ~/.cache/ink-viewer/surface-volumes), INK_VIEWER_SV_MAX_GB (default 16).
"""
import itertools
import json
import math
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import uuid
from datetime import datetime, timezone
from pathlib import Path

from ink_viewer.server.fuentes import guardar_json, ruta_dentro

SV_NAME = re.compile(r'(?P<res>\d+(?:\.\d+)?)um-(?:(?P<dist>\d+(?:\.\d+)?)m-)?(?P<kev>\d+)keV-volume-(?P<volume>\d{14})\.zarr')
SAMPLE = re.compile(r'PHerc[A-Za-z0-9]+')
SEGMENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.+-]*')
PROFILE = re.compile(r'[A-Za-z0-9_.-]+@[A-Za-z0-9_.+-]+')
DIRECTIONS = {'forward': ('probability.npy', 'fwd'), 'reverse': ('probability_reverse.npy', 'rev')}

_PROFILES_SNIPPET = r'''
import json
from ink_sdk.registry import list_profiles
print(json.dumps([{"id": p.id, "adapter": p.adapter, "scale_um": p.input.scale_um,
                   "tolerance_um": p.input.scale_tolerance_um, "depth": p.input.depth,
                   "tile": p.input.tile, "overlap": p.input.overlap, "direction": p.execution.direction}
                  for p in list_profiles()]))
'''


def config():
    return {'python': os.environ.get('INK_SDK_PYTHON', ''),
            'cache': Path(os.environ.get('INK_VIEWER_SV_CACHE', Path.home() / '.cache/ink-viewer/surface-volumes')).expanduser(),
            'max_bytes': float(os.environ.get('INK_VIEWER_SV_MAX_GB', '16')) * 2**30}


def disponible():
    """(available, reason). Available means ink-sdk is installed; GPU and checkpoints are checked by ink-sdk itself."""
    py = config()['python']
    if not py:
        return False, 'INK_SDK_PYTHON is not set'
    if not Path(py).is_file():
        return False, f'INK_SDK_PYTHON does not exist: {py}'
    return True, ''


_profiles_cache = {}


def perfiles():
    ok, why = disponible()
    if not ok:
        raise RuntimeError(why)
    py = config()['python']
    if py not in _profiles_cache:
        out = subprocess.run([py, '-c', _PROFILES_SNIPPET], capture_output=True, text=True, timeout=120)
        if out.returncode:
            raise RuntimeError('ink-sdk did not list its profiles: ' + (out.stderr or out.stdout)[-500:])
        _profiles_cache[py] = json.loads(out.stdout)
    return _profiles_cache[py]


def compatible(profile, res_um):
    return abs(float(profile['scale_um']) - float(res_um)) <= float(profile['tolerance_um']) + 1e-9


def _segment_rel(fuente, sample, segment, *tail):
    if not SAMPLE.fullmatch(sample or '') or not SEGMENT.fullmatch(segment or ''):
        raise ValueError('Invalid sample or segment')
    return fuente.ruta_catalogo('/'.join(('catalog', sample, 'segments', segment) + tail))


def volumenes(fuente, sample, segment):
    rel = _segment_rel(fuente, sample, segment, 'surface-volumes')
    rows = []
    for name, directory in fuente.listado(rel):
        m = SV_NAME.fullmatch(name)
        if directory and m:
            rows.append(dict(m.groupdict(), name=name, rel=rel + '/' + name))
    return rows


def _read(fuente, rel):
    with fuente.abrir(rel, zarr_meta=True) as (_, _, body):
        return body.read()


def _array_rel(fuente, rel):
    """The level-0 array of a surface volume: the zarr itself, or its '0' member."""
    for candidate in (rel, rel + '/0'):
        try:
            return candidate, json.loads(_read(fuente, candidate + '/.zarray'))
        except (FileNotFoundError, urllib.error.HTTPError):
            continue
    raise FileNotFoundError(f'No zarr v2 array at {rel} or {rel}/0')


DONE = '.complete-group-v1'   # layout marker: a cache written by another layout is copied again


def copiar_volumen(fuente, rel, destino, max_bytes=None):
    """Copy the level-0 array chunk by chunk into destino/0 of a zarr v2 group (the layout ink-sdk reads).
    Absent chunks stay absent (= fill). Group attributes (pixel size, multiscales) are kept when the source has them."""
    destino = Path(destino)
    if (destino / DONE).is_file():
        return destino
    array_rel, meta = _array_rel(fuente, rel)
    shape, chunks = meta['shape'], meta['chunks']
    if len(shape) != 3:
        raise ValueError(f'Expected a ZYX surface volume, got shape {shape}')
    itemsize = int(re.sub(r'\D', '', meta['dtype']) or 1)
    size = math.prod(shape) * itemsize
    limit = config()['max_bytes'] if max_bytes is None else max_bytes
    if size > limit:
        raise ValueError(f'Surface volume is {size / 2**30:.1f} GiB, above the {limit / 2**30:.1f} GiB cache limit')
    array_dir = destino / '0'
    array_dir.mkdir(parents=True, exist_ok=True)
    (destino / '.zgroup').write_text('{"zarr_format": 2}\n')
    copies = [(array_rel + '/.zarray', array_dir / '.zarray'), (array_rel + '/.zattrs', array_dir / '.zattrs')]
    if array_rel != rel:
        copies.append((rel + '/.zattrs', destino / '.zattrs'))
    for source_rel, target in copies:
        try:
            target.write_bytes(_read(fuente, source_rel))
        except (FileNotFoundError, urllib.error.HTTPError):
            continue
    sep = meta.get('dimension_separator', '.')
    grid = [range(math.ceil(s / c)) for s, c in zip(shape, chunks)]
    for index in itertools.product(*grid):
        key = sep.join(map(str, index))
        target = array_dir.joinpath(*key.split('/'))
        if target.is_file():
            continue
        try:
            body = _read(fuente, array_rel + '/' + key)
        except FileNotFoundError:
            continue
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                continue
            raise
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + '.part')
        part.write_bytes(body)
        os.replace(part, target)
    (destino / DONE).write_text(json.dumps({'source': fuente.origen, 'rel': array_rel, 'shape': shape}) + '\n')
    return destino


def modelo(profile_id, direction):
    """Catalog model field: [A-Za-z0-9_-] only, with the depth direction (each direction is its own series)."""
    return re.sub(r'[^A-Za-z0-9_-]', '_', profile_id) + '-' + DIRECTIONS[direction][1]


def nombre(sample, segment, vol, run, profile_id, direction, tile, stride):
    dist = f"{vol['dist']}m-" if vol.get('dist') else ''
    return (f"{sample}-{segment}-{vol['res']}um-{dist}{vol['kev']}keV-volume-{vol['volume']}-{run}-"
            f'{modelo(profile_id, direction)}-tile{tile}-stride{stride}')


def raiz_generada(fuente):
    if not fuente.anotaciones:
        raise PermissionError('Read-only source: configure an annotations folder to keep generated maps')
    return ruta_dentro(Path(fuente.anotaciones), fuente.id + '/generated')


def archivo_generado(fuente, rel):
    """A catalog path ('catalog/<sample>/...') served from generated maps, or None."""
    if not fuente or not fuente.anotaciones or not rel.startswith('catalog/'):
        return None
    try:
        path = ruta_dentro(raiz_generada(fuente), rel[len('catalog/'):])
    except ValueError:
        return None
    return path if path.is_file() else None


def manifest_generado(fuente):
    if not fuente or not fuente.anotaciones:
        return []
    path = raiz_generada(fuente) / '_viewer' / 'manifest.json'
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def reindexar(fuente):
    from ink_viewer.catalog.generar_manifest import construir
    from ink_viewer.server.fuentes import Fuente
    root = raiz_generada(fuente)
    manifest, report = construir(Fuente(str(root)))
    for entry in manifest:
        entry['catalogMeta']['fam'] = 'ink-sdk (generated here)'
        entry['label'] = entry['label'].replace('Catalog ·', 'ink-sdk ·', 1)
    guardar_json(root / '_viewer' / 'manifest.json', manifest)
    guardar_json(root / '_viewer' / 'index-info.json', report)
    return len(manifest)


def _png(prob, path):
    """Full-resolution PNG (uint8 = round(255 p)) plus the viewer's browsing previews downsampled/<stem>-ds4/8.jpg."""
    import numpy as np
    from PIL import Image
    p = np.nan_to_num(np.asarray(prob, np.float32), nan=0.0)
    p = p if p.ndim == 2 else p.reshape(p.shape[-2:])
    image = Image.fromarray(np.clip(np.rint(p * 255), 0, 255).astype(np.uint8))
    image.save(path, format='PNG')
    previews = path.parent / 'downsampled'
    previews.mkdir(exist_ok=True)
    for scale in (4, 8):
        small = image.copy()
        small.thumbnail((max(1, image.width // scale), max(1, image.height // scale)))
        small.save(previews / f'{path.stem}-ds{scale}.jpg', format='JPEG', quality=90)


def ejecutar(job, fuente, log=print):
    """Run one job to completion. Raises on failure; the caller records the error."""
    cfg = config()
    profile = next((p for p in perfiles() if p['id'] == job['perfil']), None)
    if profile is None:
        raise ValueError(f"Unknown ink-sdk profile {job['perfil']}")
    vol = next((v for v in volumenes(fuente, job['rollo'], job['segmento']) if v['name'] == job['volumen']), None)
    if vol is None:
        raise FileNotFoundError(f"No surface volume {job['volumen']} in {job['rollo']}/{job['segmento']}")
    if not compatible(profile, vol['res']):
        raise ValueError(f"{profile['id']} reads {profile['scale_um']} ± {profile['tolerance_um']} um; this volume is {vol['res']} um")
    job['estado'] = 'copiando'
    cache = cfg['cache'] / fuente.id / job['rollo'] / job['segmento'] / vol['name']
    sv = copiar_volumen(fuente, vol['rel'], cache)
    job['estado'] = 'inferencia'
    run = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    with tempfile.TemporaryDirectory(prefix='ink-sdk-job-') as tmp:
        out = Path(tmp) / 'out'
        cmd = [cfg['python'], '-m', 'ink_sdk.cli', 'infer', '-p', profile['id'], '--surface-volume', str(sv),
               '--voxel-um', str(vol['res']), '--on-degenerate', 'warn', '-o', str(out)]
        if os.environ.get('VILLA_PY') and profile['adapter'] == 'ink9um':
            cmd += ['--python', os.environ['VILLA_PY']]
        done = subprocess.run(cmd, capture_output=True, text=True)
        job['log'] = (done.stdout + done.stderr)[-4000:]
        if done.returncode:
            raise RuntimeError('ink-sdk failed: ' + (done.stderr or done.stdout)[-1000:])
        receipt = json.loads((out / 'INK_SDK_RECEIPT.json').read_text())
        dest = raiz_generada(fuente) / job['rollo'] / 'segments' / job['segmento'] / 'ink-detection'
        dest.mkdir(parents=True, exist_ok=True)
        stride = int(round(int(profile['tile']) * (1 - float(profile['overlap']))))
        layers = receipt.get('input', {}).get('shape_zyx', [None])[0]
        written = []
        for direction, (filename, _) in DIRECTIONS.items():
            if not (out / filename).is_file():
                continue
            import numpy as np
            stem = nombre(job['rollo'], job['segmento'], vol, run, profile['id'], direction, profile['tile'], stride)
            _png(np.load(out / filename), dest / (stem + '.png'))
            guardar_json(dest / (stem + '.json'), {
                'schema': 'ink-viewer.ink-sdk-job.v1', 'sample': job['rollo'], 'segment': job['segmento'], 'stem': stem,
                'files': [stem + '.png'], 'recipe': {'direction': [direction], 'profile': profile['id']},
                'surface_volume': {'name': vol['name'], 'source': fuente.origen, 'level': 0},
                # ink-sdk hands the whole stack to the model's own loader; for the 9 um lane upstream reads
                # `depth` layers from n//2 - depth//2. Recorded so maps read from different windows are not compared blind.
                'depth_window': ({'layers_available': layers, 'depth': profile['depth'],
                                  'start_inferred': layers // 2 - int(profile['depth']) // 2}
                                 if profile['adapter'] == 'ink9um' and layers else None),
                'ink_sdk_receipt': receipt,
                'non_claims': ['A probability map is not OCR and does not prove ink or letters.']})
            written.append(stem + '.png')
    if not written:
        raise RuntimeError('ink-sdk wrote no probability map')
    job['mapas'] = written
    job['series'] = reindexar(fuente)
    job['estado'] = 'listo'
    log(f"ink-sdk job {job['id']}: {', '.join(written)}")


class Trabajos:
    """In-memory job list with a single worker thread (one GPU)."""

    def __init__(self, runner=ejecutar):
        self.runner, self.jobs, self.lock, self.cola = runner, {}, threading.Lock(), queue.Queue()
        self.worker = None

    def crear(self, fuente, rollo, segmento, volumen, perfil, log=print):
        if not SAMPLE.fullmatch(rollo or '') or not SEGMENT.fullmatch(segmento or '') or not SV_NAME.fullmatch(volumen or '') \
                or not PROFILE.fullmatch(perfil or ''):
            raise ValueError('Expected rollo, segmento, volumen and perfil')
        raiz_generada(fuente)  # read-only sources fail here, before queueing
        job = {'id': uuid.uuid4().hex[:12], 'rollo': rollo, 'segmento': segmento, 'volumen': volumen, 'perfil': perfil,
               'estado': 'en cola', 'creado': time.time(), 'error': None, 'mapas': []}
        with self.lock:
            self.jobs[job['id']] = job
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._loop, daemon=True)
                self.worker.start()
        self.cola.put((job, fuente, log))
        return dict(job)

    def _loop(self):
        while True:
            try:
                job, fuente, log = self.cola.get(timeout=5)
            except queue.Empty:
                with self.lock:
                    if self.cola.empty():
                        self.worker = None
                        return
                continue
            try:
                self.runner(job, fuente, log)
            except Exception as e:  # recorded for the UI; the worker keeps serving the queue
                job['estado'], job['error'] = 'error', str(e)[:1000]
            finally:
                self.cola.task_done()

    def lista(self):
        with self.lock:
            return sorted((dict(j) for j in self.jobs.values()), key=lambda j: j['creado'], reverse=True)


TRABAJOS = Trabajos()
