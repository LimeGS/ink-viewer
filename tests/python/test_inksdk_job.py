"""ink-sdk jobs: surface-volume discovery, level-0 copy, catalog naming, generated index and the HTTP endpoints.

ink-sdk itself is replaced by a stub package on PYTHONPATH (no GPU, no weights)."""
import json
import os
import sys
import tempfile
import textwrap
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import ink_viewer.server.inksdk_job as job
import ink_viewer.server.s3cache_proxy as proxy
from ink_viewer.catalog.catalog_names import parse
from ink_viewer.server.fuentes import Fuente
from test_fuentes import servidor

SV = '9.362um-1.2m-113keV-volume-20250820143440.zarr'
STUB = {
    'ink_sdk/__init__.py': '',
    'ink_sdk/registry.py': '''
        from types import SimpleNamespace as N
        def list_profiles():
            mk = lambda i, a, s, t, d: N(id=i, adapter=a, input=N(scale_um=s, scale_tolerance_um=t, depth=d, tile=128, overlap=0.5),
                                         execution=N(direction='both'))
            return [mk('ink_9um@reader-v3', 'ink9um', 9.362, 0.75, 17), mk('hecate@2.4um', 'hecate', 2.4, 0.048, 64)]
    ''',
    'ink_sdk/cli.py': '''
        import json, os, sys
        from pathlib import Path
        import numpy as np
        a = sys.argv[1:]
        if os.environ.get('STUB_FAIL'):
            sys.exit('boom')
        out = Path(a[a.index('-o') + 1]); sv = Path(a[a.index('--surface-volume') + 1])
        shape = json.loads((sv / '0' / '.zarray').read_text())['shape']  # ink-sdk reads a group with array '0'
        out.mkdir(parents=True)
        p = np.zeros(shape[1:], np.float32); p[1, 1] = 1.0
        np.save(out / 'probability.npy', p); np.save(out / 'probability_reverse.npy', p[None] * 0.5)
        (out / 'INK_SDK_RECEIPT.json').write_text(json.dumps({'schema': 'ink-sdk.receipt.v1', 'argv': a,
                                                             'input': {'shape_zyx': shape}}))
        if __name__ == '__main__':
            pass
    ''',
}


def stub(root):
    for rel, text in STUB.items():
        path = root / rel; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(textwrap.dedent(text))
    return root


def catalogo(root, level0=True, missing=(), dims=(6, 4, 5)):
    """A catalog root with one segment, one surface volume (zarr v2, raw uint8 chunks) and a generated index."""
    seg = root / 'PHerc0500P2/segments/20250825181859--1'
    arr = seg / 'surface-volumes' / SV / ('0' if level0 else '')
    arr.mkdir(parents=True)
    (seg / 'surface-volumes' / 'not-a-volume.zarr').mkdir()
    chunks = [4, 2, 3]
    (arr / '.zarray').write_text(json.dumps({'zarr_format': 2, 'shape': list(dims), 'chunks': chunks, 'dtype': '|u1',
                                             'compressor': None, 'fill_value': 0, 'order': 'C', 'filters': None,
                                             'dimension_separator': '/'}))
    (arr / '.zattrs').write_text('{}')
    import itertools, math
    for idx in itertools.product(*[range(math.ceil(s / c)) for s, c in zip(dims, chunks)]):
        if idx in missing:
            continue
        p = arr.joinpath(*map(str, idx)); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(bytes(24))
    (root / '_viewer').mkdir()
    (root / '_viewer/manifest.json').write_text('[]')
    (root / '_viewer/index-info.json').write_text(json.dumps({'schema': 'vesuvius.viewer-index.v1', 'layout': 'catalog', 'scroll': None}))
    return seg


class InkSdkJob(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); t = Path(self.tmp.name)
        self.root, self.notes, self.cache = t / 'catalog', t / 'notes', t / 'cache'
        self.root.mkdir(); self.notes.mkdir()
        self.stub = stub(t / 'stub')
        self.env = patch.dict(os.environ, {'INK_SDK_PYTHON': sys.executable, 'INK_VIEWER_SV_CACHE': str(self.cache),
                                           'PYTHONPATH': os.pathsep.join([str(self.stub), os.environ.get('PYTHONPATH', '')])})
        self.env.start(); job._profiles_cache.clear()

    def tearDown(self):
        self.env.stop(); job._profiles_cache.clear(); self.tmp.cleanup()

    def fuente(self, notes=True):
        f = Fuente(str(self.root), anotaciones=str(self.notes) if notes else ''); f.verificar(); return f

    def test_disponible_and_profiles(self):
        self.assertEqual(job.disponible(), (True, ''))
        ids = [p['id'] for p in job.perfiles()]
        self.assertEqual(ids, ['ink_9um@reader-v3', 'hecate@2.4um'])
        self.assertTrue(job.compatible(job.perfiles()[0], '8.64'))
        self.assertFalse(job.compatible(job.perfiles()[1], '9.362'))
        with patch.dict(os.environ, {'INK_SDK_PYTHON': ''}):
            self.assertEqual(job.disponible()[0], False)
            with self.assertRaises(RuntimeError):
                job.perfiles()
        with patch.dict(os.environ, {'INK_SDK_PYTHON': str(self.root / 'nope')}):
            self.assertIn('does not exist', job.disponible()[1])
        job._profiles_cache.clear()
        with patch.dict(os.environ, {'PYTHONPATH': ''}), self.assertRaises(RuntimeError):
            job.perfiles()

    def test_volumes_copy_level0_and_missing_chunks(self):
        catalogo(self.root, missing={(1, 1, 1)}); f = self.fuente()
        vols = job.volumenes(f, 'PHerc0500P2', '20250825181859--1')
        self.assertEqual([(v['res'], v['dist'], v['kev'], v['volume']) for v in vols], [('9.362', '1.2', '113', '20250820143440')])
        with self.assertRaises(ValueError):
            job.volumenes(f, '../x', 'y')
        dst = job.copiar_volumen(f, vols[0]['rel'], self.cache / 'v')
        self.assertTrue((dst / job.DONE).is_file() and (dst / '0/.zarray').is_file() and (dst / '.zgroup').is_file())
        self.assertTrue((dst / '0/0/0/0').is_file())
        self.assertFalse((dst / '0/1/1/1').exists())
        self.assertEqual(job.copiar_volumen(f, vols[0]['rel'], dst), dst)  # cached
        with self.assertRaises(ValueError):
            job.copiar_volumen(f, vols[0]['rel'], self.cache / 'w', max_bytes=10)
        with self.assertRaises(FileNotFoundError):
            job.copiar_volumen(f, vols[0]['rel'] + '/nothing', self.cache / 'x')

    def test_plain_array_and_shape_guard(self):
        catalogo(self.root, level0=False, dims=(6, 4)); f = self.fuente()
        rel = job.volumenes(f, 'PHerc0500P2', '20250825181859--1')[0]['rel']
        with self.assertRaises(ValueError):
            job.copiar_volumen(f, rel, self.cache / 'v')

    def test_zarr_metadata_is_the_only_hidden_name_admitted(self):
        from ink_viewer.server.fuentes import ruta_dentro
        root = Path('/data')
        self.assertEqual(ruta_dentro(root, 'a.zarr/0/.zarray', zarr_meta=True), root / 'a.zarr/0/.zarray')
        for rel, flag in (('a.zarr/0/.zarray', False), ('.git/config', True), ('a/.hidden', True),
                          ('.zarray/x', True), ('a/../.zarray', True), ('a/.zattrs/.zarray', True)):
            with self.assertRaises(ValueError, msg=rel):
                ruta_dentro(root, rel, zarr_meta=flag)

    def test_names_parse_as_catalog_maps(self):
        vol = {'res': '9.362', 'dist': '1.2', 'kev': '113', 'volume': '20250820143440'}
        name = job.nombre('PHerc0500P2', '20250825181859--1', vol, '20261113120000', 'ink_9um@reader-v3', 'reverse', 128, 64) + '.png'
        d = parse(name)
        self.assertEqual((d['sample'], d['segment'], d['model'], d['tile'], d['stride'], d['volume']),
                         ('PHerc0500P2', '20250825181859--1', 'ink_9um_reader-v3-rev', '128', '64', '20250820143440'))
        self.assertTrue(d['official'])
        self.assertIsNotNone(parse(job.nombre('PHerc1', 's', dict(vol, dist=None), '20261113120000', 'hecate@2.4um', 'forward', 128, 64) + '.png'))

    def test_run_writes_catalog_maps_index_and_serves_nothing_outside(self):
        catalogo(self.root); f = self.fuente()
        j = {'id': 'x', 'rollo': 'PHerc0500P2', 'segmento': '20250825181859--1', 'volumen': SV, 'perfil': 'ink_9um@reader-v3'}
        job.ejecutar(j, f, log=lambda m: None)
        self.assertEqual(j['estado'], 'listo'); self.assertEqual(len(j['mapas']), 2); self.assertEqual(j['series'], 2)
        manifest = job.manifest_generado(f)
        self.assertEqual({e['catalogMeta']['cara'] for e in manifest}, {'fwd', 'rev'})
        self.assertTrue(all(e['catalogMeta']['fam'] == 'ink-sdk (generated here)' for e in manifest))
        frame = manifest[0]['frames']['0'].removeprefix('../') + '.png'
        self.assertTrue(job.archivo_generado(f, frame).is_file())
        self.assertIsNone(job.archivo_generado(f, 'catalog/../../etc/passwd'))
        self.assertIsNone(job.archivo_generado(f, 'all-gallery/x.png'))
        stem = j['mapas'][0][:-4]
        receipt = json.loads((job.raiz_generada(f) / 'PHerc0500P2/segments/20250825181859--1/ink-detection' / (stem + '.json')).read_text())
        self.assertEqual(receipt['depth_window'], {'layers_available': 6, 'depth': 17, 'start_inferred': -5})
        self.assertTrue((job.raiz_generada(f) / 'PHerc0500P2/segments/20250825181859--1/ink-detection/downsampled' / (stem + '-ds4.jpg')).is_file())
        self.assertFalse(any(p.name.endswith('.png') for p in self.root.rglob('*')), 'nothing written to the source')

    def test_run_errors(self):
        catalogo(self.root); f = self.fuente()
        base = {'id': 'x', 'rollo': 'PHerc0500P2', 'segmento': '20250825181859--1', 'volumen': SV}
        for bad, error in ((dict(base, perfil='nope@x'), ValueError), (dict(base, perfil='hecate@2.4um'), ValueError),
                           (dict(base, perfil='ink_9um@reader-v3', volumen='1um-1keV-volume-20250101000000.zarr'), FileNotFoundError)):
            with self.assertRaises(error):
                job.ejecutar(bad, f)
        with patch.dict(os.environ, {'STUB_FAIL': '1'}), self.assertRaises(RuntimeError):
            job.ejecutar(dict(base, perfil='ink_9um@reader-v3'), f)
        with patch.dict(os.environ, {'VILLA_PY': sys.executable}), patch.object(job, 'DIRECTIONS', {'forward': ('absent.npy', 'fwd')}), \
                self.assertRaises(RuntimeError):
            job.ejecutar(dict(base, perfil='ink_9um@reader-v3'), f)
        self.assertEqual(job.manifest_generado(self.fuente(notes=False)), [])
        with self.assertRaises(PermissionError):
            job.raiz_generada(self.fuente(notes=False))

    def test_queue_records_errors_and_keeps_serving(self):
        catalogo(self.root); f = self.fuente()
        seen = []
        def runner(j, fuente, log):
            seen.append(j['id'])
            if len(seen) == 1:
                raise RuntimeError('first fails')
            j['estado'] = 'listo'
        t = job.Trabajos(runner)
        a = t.crear(f, 'PHerc0500P2', '20250825181859--1', SV, 'ink_9um@reader-v3')
        b = t.crear(f, 'PHerc0500P2', '20250825181859--1', SV, 'ink_9um@reader-v3')
        for _ in range(100):
            states = {j['id']: j['estado'] for j in t.lista()}
            if states.get(a['id']) == 'error' and states.get(b['id']) == 'listo':
                break
            time.sleep(0.05)
        self.assertEqual(states, {a['id']: 'error', b['id']: 'listo'})
        with self.assertRaises(ValueError):
            t.crear(f, 'PHerc0500P2', '../x', SV, 'p@q')
        with self.assertRaises(PermissionError):
            t.crear(self.fuente(notes=False), 'PHerc0500P2', 's', SV, 'p@q')

    def test_http_endpoints_merge_and_serve_generated_maps(self):
        catalogo(self.root); f = self.fuente()
        with servidor(proxy.Handler, f) as (_, url):
            info = json.load(urllib.request.urlopen(url + '/api/inksdk'))
            self.assertTrue(info['disponible']); self.assertEqual(len(info['perfiles']), 2)
            vols = json.load(urllib.request.urlopen(url + '/api/inksdk/volumenes?rollo=PHerc0500P2&segmento=20250825181859--1'))
            self.assertEqual(vols[0]['perfiles'], ['ink_9um@reader-v3']); self.assertNotIn('rel', vols[0])
            headers = {'X-Visor-Origen': f.id, 'Content-Type': 'application/json'}
            body = json.dumps({'rollo': 'PHerc0500P2', 'segmento': '20250825181859--1', 'volumen': SV, 'perfil': 'ink_9um@reader-v3'}).encode()
            with patch.object(job, 'TRABAJOS', job.Trabajos()):
                r = urllib.request.urlopen(urllib.request.Request(url + '/api/inksdk/trabajos', data=body, headers=headers, method='POST'))
                self.assertEqual(r.status, 202)
                for _ in range(200):
                    jobs = json.load(urllib.request.urlopen(url + '/api/inksdk/trabajos'))
                    if jobs[0]['estado'] in ('listo', 'error'):
                        break
                    time.sleep(0.05)
                self.assertEqual(jobs[0]['estado'], 'listo', jobs[0].get('error'))
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(urllib.request.Request(url + '/api/inksdk/trabajos', data=b'[]', headers=headers, method='POST'))
                self.assertEqual(e.exception.code, 400)
            manifest = urllib.request.urlopen(url + '/all-gallery/manifest.js').read().decode()
            self.assertIn('ink-sdk (generated here)', manifest)
            entry = json.loads(manifest[len('window.manifest='):].rstrip().rstrip(';'))[0]
            png = urllib.request.urlopen(url + '/' + entry['frames']['0'].removeprefix('../') + '.png')
            self.assertEqual(png.headers['X-Fuente'], 'ink-sdk')
            dims = json.load(urllib.request.urlopen(url + '/api/dims/' + entry['frames']['0'].removeprefix('../') + '.png'))
            self.assertEqual(dims, {'w': 5, 'h': 4})
            with patch.dict(os.environ, {'INK_SDK_PYTHON': ''}):
                self.assertFalse(json.load(urllib.request.urlopen(url + '/api/inksdk'))['disponible'])
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(urllib.request.Request(url + '/api/inksdk/trabajos', data=body, headers=headers, method='POST'))
                self.assertEqual(e.exception.code, 503)


if __name__ == '__main__':
    unittest.main()
