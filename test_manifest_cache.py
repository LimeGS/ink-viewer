import gzip
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import s3cache_proxy as p
from fuentes import Fuente
from test_fuentes import servidor


class ManifestCache(unittest.TestCase):
    def test_existing_work3_catalog_json_is_the_authoritative_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'catalog/_viewer').mkdir(parents=True)
            data=[{'id':'local-work3','scroll':'PHerc1447'}]
            (root/'catalog/_viewer/manifest-work3.json').write_text(json.dumps(data))
            (root/'catalog/_viewer/manifest-work3.js').write_text('window.manifest_work3=[{"id":"stale"}]')
            source=Fuente(tmp); source.verificar()
            self.assertEqual(source.manifest_rel,'catalog/_viewer/manifest-work3.json')
            with servidor(p.Handler,source) as (_,base):
                with urllib.request.urlopen(base+'/all-gallery/manifest.js') as response:
                    self.assertIn(b'local-work3',response.read())
                with urllib.request.urlopen(base+'/catalog/_viewer/manifest-work3.js') as response:
                    self.assertNotIn(b'stale',response.read())

    def test_gzip_etag_head_identity_and_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '_viewer').mkdir()
            file = root / '_viewer/manifest.json'
            data = [{'id': 'test', 'label': 'repeated text ' * 2000}]
            file.write_text(json.dumps(data))
            source = Fuente(str(root))
            source.manifest_rel = '_viewer/manifest.json'
            p.manifest_bytes.cache_clear()
            with servidor(p.Handler, source) as (_, base):
                url = base + '/all-gallery/manifest.js'
                def request(headers=None, method='GET'):
                    return urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}, method=method))
                with request({'Accept-Encoding': 'gzip'}) as response:
                    encoded = response.read()
                    etag = response.headers['ETag']
                    self.assertEqual(response.headers['Content-Encoding'], 'gzip')
                    self.assertEqual(response.headers['Vary'], 'Accept-Encoding')
                    self.assertIn('no-cache', response.headers['Cache-Control'])
                    raw = gzip.decompress(encoded)
                    self.assertLess(len(encoded), len(raw) // 10)
                    self.assertEqual(json.loads(raw.decode().removeprefix('window.manifest=').removesuffix(';\n')), data)
                with self.assertRaises(urllib.error.HTTPError) as result:
                    request({'Accept-Encoding': 'gzip', 'If-None-Match': etag})
                self.assertEqual(result.exception.code, 304)
                self.assertEqual(result.exception.read(), b'')
                with request({'Accept-Encoding': 'gzip'}, 'HEAD') as response:
                    self.assertEqual(int(response.headers['Content-Length']), len(encoded))
                    self.assertEqual(response.read(), b'')
                with request({'Accept-Encoding': 'gzip;q=0'}) as response:
                    self.assertIsNone(response.headers.get('Content-Encoding'))
                    self.assertEqual(response.read(), raw)
                self.assertEqual(p.manifest_bytes.cache_info().misses, 1)
                file.write_text(json.dumps([{'id': 'updated'}]))
                with request({'Accept-Encoding': 'gzip', 'If-None-Match': etag}) as response:
                    self.assertEqual(response.status, 200)
                    self.assertNotEqual(response.headers['ETag'], etag)
                    self.assertIn(b'updated', gzip.decompress(response.read()))


if __name__ == '__main__':
    unittest.main()
