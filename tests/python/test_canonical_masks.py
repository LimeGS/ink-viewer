import base64
import hashlib
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import ink_viewer.server.canonical_masks as cm
import ink_viewer.server.s3cache_proxy as proxy
from ink_viewer.server.fuentes import Fuente
from test_fuentes import servidor
from test_mask_pair import png


class CanonicalMasks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = Fuente(str(self.root))
        self.records = []
        self.add_record("a", 0)

    def add_record(self, identity, ink):
        assets = []
        for role, value in [("I", ink), ("S", 255)]:
            path = (
                self.root
                / "catalog/PHerc1447/segments/s/labels/series"
                / identity
                / (role + ".png")
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            body = png(value)
            path.write_bytes(body)
            assets.append(
                {
                    "role": role,
                    "canonical": str(path),
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "bytes": len(body),
                }
            )
        self.records.append(
            {
                "id": identity,
                "roll": "PHerc1447",
                "segment": "s",
                "depth": 0,
                "type": "automatic_proposal",
                "series": identity,
                "assets": assets,
            }
        )
        index = self.root / cm.INDEX
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_text(json.dumps({"schema": "canonical-masks.v1", "records": self.records}))

    def get(self, base, path):
        with urllib.request.urlopen(base + path) as response:
            return response.read()

    def test_immutable_content_and_external_paths(self):
        asset = self.records[0]["assets"][0]
        self.assertEqual(cm.read_asset(self.source, asset), png(0))
        Path(asset["canonical"]).write_bytes(png(255))
        with self.assertRaises(ValueError):
            cm.read_asset(self.source, asset)
        external = self.root / "external.png"
        external.write_bytes(png())
        with self.assertRaises(ValueError):
            cm.asset_path(self.source, {"canonical": str(external)})

    def test_list_raw_pair_and_explicit_versions(self):
        with servidor(proxy.Handler, self.source) as (_, base):
            rows = json.loads(self.get(base, "/api/mascaras-canonicas?rollo=PHerc1447"))
            self.assertEqual(rows["total"], 1)
            self.assertEqual(self.get(base, rows["records"][0]["assets"][0]["url"]), png(0))
            url = "/api/mascara-par/s?c=0&rollo=PHerc1447&base=PHerc1447/segments/s"
            pair = json.loads(self.get(base, url))
            self.assertEqual(base64.b64decode(pair["inklabels"]), png(0))
            self.add_record("b", 255)
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.get(base, url)
            self.assertEqual(e.exception.code, 409)
            pair = json.loads(self.get(base, url + "&version=b"))
            self.assertEqual(base64.b64decode(pair["inklabels"]), png(255))
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.get(base, url + "&version=wrong")
            self.assertEqual(e.exception.code, 404)

    def test_tiff_pages_are_lossless_and_explicit(self):
        import io

        from PIL import Image

        output = io.BytesIO()
        Image.new("L", (3, 2), 17).save(
            output, format="TIFF", save_all=True, append_images=[Image.new("L", (3, 2), 255)]
        )
        body = output.getvalue()
        self.assertEqual(cm.tiff_view(body)["frames"], 2)
        for page, value in [(0, 17), (1, 255)]:
            with Image.open(io.BytesIO(cm.tiff_view(body, page))) as im:
                self.assertEqual(list(im.getdata()), [value] * 6)
        with self.assertRaises(ValueError):
            cm.tiff_view(body, 2)

    def test_zarr_preview_depth_integrity_and_http(self):
        asset = dict(self.records[0]["assets"][0], z=10)
        index = self.root / "catalog/_viewer/canonical-zarr-masks.json"
        index.write_text(json.dumps({"records": [{"id": "family-I", "previews": [asset]}]}))
        with servidor(proxy.Handler, self.source) as (_, base):
            self.assertEqual(self.get(base, "/api/mascaras-zarr/family-I/10"), png(0))
            for path in ("/api/mascaras-zarr/family-I/11", "/api/mascaras-zarr/unknown/10"):
                with self.assertRaises(urllib.error.HTTPError):
                    self.get(base, path)
        Path(asset["canonical"]).write_bytes(png(255))
        with self.assertRaises(ValueError):
            cm.zarr_preview(self.source, "family-I", 10)

    def test_no_fallback_to_archive_or_other_depth(self):
        external = self.root / "archive/inklabels.png"
        external.parent.mkdir()
        external.write_bytes(png())
        with servidor(proxy.Handler, self.source) as (_, base):
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.get(base, "/archive/inklabels.png")
            self.assertEqual(e.exception.code, 403)
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.get(base, "/api/mascara-par/s?c=1&rollo=PHerc1447&base=PHerc1447/segments/s")
            self.assertEqual(e.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
