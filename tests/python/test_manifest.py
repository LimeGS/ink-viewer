"""python -m unittest discover -s tests/python -p 'test_manifest.py': real filesystem/HTTP, paginated S3, TIFF and receipts."""
import hashlib
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from ink_viewer.server.fuentes import Fuente
from ink_viewer.catalog.generar_manifest import construir, main, render_grid_de
import ink_viewer.server.s3cache_proxy as p
from test_fuentes import servidor


def fixture(root, sample='PHerc0306B'):
    base = root / sample
    ink = base / 'segments/shared/ink-detection'; ink.mkdir(parents=True)
    stem = f'{sample}-shared-8.64um-1.2m-116keV-volume-20250521133212-20260927003530-base-tile256-stride128'
    names = [stem + suffix + '.png' for suffix in ('-c+00', '-c+00-global', '-c+02', '')]
    for name in names:
        Image.new('L', (80, 40), 111).save(ink / name)
    (ink / 'downsampled').mkdir(); (ink / 'downsampled/preview.jpg').write_bytes(b'ignored')
    (ink / 'mask.png').write_bytes(b'not an ink-map name')
    mesh = base / 'segments/shared/mesh/tifxyz'; mesh.mkdir(parents=True)
    hashes = {}
    for name in ('x.tif', 'y.tif', 'z.tif', 'meta.json'):
        data = b'{}' if name == 'meta.json' else name.encode()
        (mesh / name).write_bytes(data); hashes[name] = hashlib.sha256(data).hexdigest()
    grid = {'schema': 'vesuvius.render-grid.v1', 'fixture': 1}
    grid['grid_id'] = hashlib.sha256(json.dumps(grid,sort_keys=True,separators=(',', ':')).encode()).hexdigest()
    receipt = {'schema': 'helena.ink-run.v1', 'stem': stem, 'sample': sample, 'segment': 'shared',
               'catalog_mesh': '/mnt/ct/catalog/' + sample + '/segments/shared/mesh/tifxyz',
               'mesh_inputs_sha256': hashes, 'files': names + [stem + '-c-04.png'], 'recipe': {'direction': ['forward']},
               'render_grid': grid}
    (ink / (stem + '.json')).write_text(json.dumps(receipt))
    (base / 'segments/mesh-only/mesh/tifxyz').mkdir(parents=True)
    tifs = base / 'segments/public/ink-detection'; tifs.mkdir(parents=True)
    tif = f'{sample}-public-8.64um-1.2m-116keV-volume-20250521133212-20260927003530-canonical-2um-tile256-stride82.tif'
    Image.new('L', (80, 40), 187).save(tifs / tif)
    (base / 'volumes/example.zarr/0').mkdir(parents=True)
    (base / 'representations/predictions/surfaces/example.zarr').mkdir(parents=True)
    (base / 'segment.tar.zst').write_bytes(b'not unpacked')
    labels = base / 'segments/shared/labels/por-profundidad/shared/c+00'
    labels.mkdir(parents=True)
    Image.new('L', (80, 40), 255).save(labels / 'shared_inklabels.png')
    return base, stem, tif


class Manifest(unittest.TestCase):
    def test_grid_digest_and_browser_number_roundtrip(self):
        doc = {'render_grid': {'schema': 'vesuvius.render-grid.v1', 'pitch': 1.0}}
        fields = {'schema': 'vesuvius.render-grid.v1', 'pitch': 1}
        doc['render_grid']['grid_id'] = hashlib.sha256(json.dumps(fields,sort_keys=True,separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(render_grid_de(doc)['pitch'], 1.0)
        self.assertIsNone(render_grid_de({'render_receipt': '/legacy/receipt.json'}))
        doc['render_grid']['pitch'] = 2
        with self.assertRaises(ValueError): render_grid_de(doc)

    def test_files_roots_receipts_and_no_destructive_regeneration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); sample, stem, _ = fixture(root)
            entries, report = construir(Fuente(str(sample)))
            self.assertEqual((report['segments'], report['segments_with_maps'], report['series'], report['maps'], report['depths']), (3, 2, 2, 5, 2))
            self.assertEqual(report['layout'], 'sample'); self.assertEqual(report['scroll'], 'PHerc0306B')
            self.assertEqual(report['samples']['PHerc0306B']['segments_without_maps'], ['mesh-only'])
            self.assertEqual(report['verified'], 0)
            self.assertTrue(next(g for g in entries if g['catalogMeta']['lam']=='shared')['maskAvailable'])
            self.assertEqual(next(g for g in entries if g['catalogMeta']['lam']=='shared')['renderGrid']['schema'], 'vesuvius.render-grid.v1')
            self.assertFalse(next(g for g in entries if g['catalogMeta']['lam']=='public')['maskAvailable'])
            self.assertEqual({p['reason'] for p in report['problems']}, {'Map declared in receipt is missing', 'Unrecognized or conflicting ink-map name'})
            self.assertEqual(construir(Fuente(str(root)), verificar_mallas=True)[1]['verified'], 1)
            fixture(root, 'PHerc0800')
            all_entries, report = construir(Fuente(str(root)))
            self.assertEqual((report['segments'], report['series']), (6, 4))
            self.assertEqual(len({g['id'] for g in all_entries}), 4)
            (sample / 'segments/shared/mesh/tifxyz/x.tif').write_bytes(b'changed')
            self.assertEqual(construir(Fuente(str(sample)), verificar_mallas=True)[1]['verified'], 0)
            with patch('builtins.print'):
                main(['--origen', str(sample), '--dry-run'])
                self.assertFalse((sample / '_viewer').exists())
                main(['--origen', str(sample)])
                original = (sample / '_viewer/manifest.json').read_bytes()
                with self.assertRaises(SystemExit): main(['--origen', str(sample)])
                self.assertEqual((sample / '_viewer/manifest.json').read_bytes(), original)
                (sample / 'segments/shared/ink-detection' / (stem + '-c+02.png')).unlink()
                main(['--source', str(sample), '--replace'])
                self.assertEqual(json.loads((sample / '_viewer/index-info.json').read_text())['depths'], 1)

    def test_proxy_local_http_and_tiff(self):
        import http.server
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); sample, stem, tif = fixture(root)
            with patch('builtins.print'): main(['--origen', str(sample)])

            class Remote(http.server.SimpleHTTPRequestHandler):
                def __init__(self, *a, **kw): super().__init__(*a, directory=str(root), **kw)
                def log_message(self, *a): pass

            with servidor(Remote) as (_, remote):
                for source in (Fuente(str(sample)), Fuente(remote + '/PHerc0306B')):
                    source.verificar()
                    self.assertEqual(source.info()['scroll'], 'PHerc0306B')
                    with self.subTest(source=source.tipo), servidor(p.Handler, source) as (_, base):
                        with urllib.request.urlopen(base + '/all-gallery/manifest.js') as response:
                            self.assertIn(b'canonical-2um', response.read())
                        url = base + '/catalog/PHerc0306B/segments/shared/ink-detection/' + stem + '-c+00.png'
                        with urllib.request.urlopen(url) as response:
                            self.assertEqual(Image.open(response).getpixel((0, 0)), 111)
                        with urllib.request.urlopen(base + '/api/rollo.js') as response:
                            self.assertIn(b'PHerc0306B', response.read())
                        path = '/api/mapa/catalog/PHerc0306B/segments/public/ink-detection/' + tif + '?escala=8'
                        with urllib.request.urlopen(base + path) as response:
                            im = Image.open(response); self.assertEqual(im.size, (10, 5)); self.assertEqual(im.getpixel((0, 0)), 187)
                        with self.assertRaises(urllib.error.HTTPError):
                            urllib.request.urlopen(base + '/catalog/PHerc0800/segments/shared/ink-detection/' + stem + '-c+00.png')

    def test_s3_paginated_discovery_and_same_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); sample, _, _ = fixture(root)
            expected, _ = construir(Fuente(str(sample)))
            objects = {'prefix/PHerc0306B/' + p.relative_to(sample).as_posix(): p.read_bytes()
                       for p in sample.rglob('*') if p.is_file()}
            # S3 prefixes represent directories only when they contain an object.
            objects['prefix/PHerc0306B/segments/mesh-only/mesh/tifxyz/meta.json'] = b'{}'
            objects['prefix/PHerc0306B/volumes/example.zarr/.zattrs'] = b'{}'
            objects['prefix/PHerc0306B/representations/predictions/a.json'] = b'{}'
            calls = []

            class S3:
                def get_paginator(self, name): return self
                def paginate(self, Bucket, Prefix, Delimiter):
                    calls.append(Prefix)
                    items = sorted({(k[len(Prefix):].split('/')[0], '/' in k[len(Prefix):]) for k in objects if k.startswith(Prefix)})
                    mid = max(1, len(items) // 2)
                    for part in (items[:mid], items[mid:]):
                        yield {'CommonPrefixes': [{'Prefix': Prefix + n + '/'} for n, d in part if d],
                               'Contents': [{'Key': Prefix + n} for n, d in part if not d]}
                def get_object(self, Bucket, Key, **kw):
                    if Key not in objects: raise FileNotFoundError(Key)
                    data = objects[Key]
                    return {'ContentLength': len(data), 'Body': io.BytesIO(data)}

            source = Fuente('s3://test-bucket/prefix/PHerc0306B'); source._s3 = S3()
            entries, report = construir(source)
            self.assertEqual(entries, expected)
            self.assertEqual((report['segments'], report['segments_with_maps']), (3, 2))
            self.assertTrue(all('.zarr/' not in p and '/representations/predictions/' not in p for p in calls))
            self.assertEqual(construir(source, verificar_mallas=True)[1]['verified'], 1)


if __name__ == '__main__':
    unittest.main()
