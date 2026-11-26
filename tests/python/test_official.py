"""Run: python -m unittest discover -s tests/python -p 'test_official.py'"""

import contextlib
import gzip
import http.server
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import ink_viewer.server.s3cache_proxy as p
from ink_viewer.catalog.official_index import BUCKET, construir_oficial
from ink_viewer.server.fuente_oficial import FuenteOficial
from ink_viewer.server.fuentes import Fuente
from ink_viewer.server.tiff_header import tiff_dims

SEG = "20261007213123-concat_w047-w048"
NAME = "PHerc0343-20261007213123-8.64um-1.2m-116keV-volume-20250521140437-20261117205746-argus-v3-tile384-stride192"
TIF = f"PHerc0343/segments/{SEG}/ink-detection/{NAME}.tif"
JPG = f"PHerc0343/segments/{SEG}/ink-detection/downsampled/{NAME}-ds8.jpg"


def item(kind, path, root=BUCKET, direction="forward"):
    return {
        "type": kind,
        "origins": [{"path": path, "access_roots": [{"type": "s3", "url": root}]}],
        "parameters": {"target_volume": "20250521140437", "model_id": "20261117205746"},
        "creation_info": {
            "date": "2026-11-18T16:56:45Z",
            "provenance": {
                "parameters": {"direction": direction, "checkpoint": "s3://x/argus-v3.pth"}
            },
        },
    }


def metadata():
    return {
        "models": {"20261117205746": {"suffix": "argus-v3"}},
        "samples": {
            "PHerc0343": {
                "segments": {
                    "20261007213123": {
                        "data": [
                            item("ink-detection", TIF),
                            item("ink-detection-downsampled", JPG),
                            item("tifxyz", f"PHerc0343/segments/{SEG}/mesh/tifxyz/"),
                            item(
                                "ink-detection",
                                "samples/PHerc0343/old.tif",
                                root="https://data.aws.ash2txt.org",
                            ),
                            item(
                                "ink-detection",
                                f"PHerc0343/segments/{SEG}/ink-detection/not-a-catalog-name.tif",
                            ),
                            item("ink-detection", "PHerc0343/elsewhere/ink.tif"),
                        ]
                    },
                    "20261007213124": {"data": [item("obj", "PHerc0343/segments/x/mesh.obj")]},
                }
            },
            "PHerc9999": {"segments": {}},
            "PHerc0001": "not a sample",
        },
    }


def image(fmt, size, value):
    stream = io.BytesIO()
    Image.new("L", size, value).save(stream, format=fmt)
    return stream.getvalue()


@contextlib.contextmanager
def servidor(handler, fuente=None):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    srv.fuente, srv.config_path, srv.config_token, srv.config_lock = (
        fuente,
        None,
        "token",
        threading.Lock(),
    )
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}"
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


class OfficialIndex(unittest.TestCase):
    def test_builds_entries_from_metadata(self):
        manifest, report, previews = construir_oficial(metadata())
        self.assertEqual(len(manifest), 1)
        e = manifest[0]
        frame = f"../catalog/{TIF}"
        self.assertEqual(e["frames"], {"0": frame})
        self.assertNotIn(
            "maximum", e, "a lone published map has undocumented depth, as in generar_manifest"
        )
        self.assertEqual(e["catalogMeta"]["cara"], "fwd")
        self.assertEqual(e["catalogMeta"]["modelo"], "argus-v3")
        self.assertEqual(e["catalogMeta"]["lam"], SEG)
        self.assertFalse(e["catalogMeta"]["depthKnown"])
        self.assertEqual(e["meshAssociation"]["status"], "UNVERIFIED")
        self.assertEqual(
            e["meshAssociation"]["meshPath"], f"../catalog/PHerc0343/segments/{SEG}/mesh/tifxyz"
        )
        self.assertEqual(e["official"]["model_name"], "argus-v3")
        self.assertEqual(e["official"]["path"], TIF)
        self.assertEqual(previews, {TIF: JPG})
        reasons = sorted(x["reason"] for x in report["problems"])
        self.assertEqual(reasons, ["Unexpected ink-map location", "Unrecognized ink-map name"])
        self.assertEqual(
            (report["series"], report["maps"], report["segments_with_maps"]), (1, 1, 1)
        )
        self.assertEqual(
            report["samples"]["PHerc0343"]["segments_without_maps"], ["20261007213124"]
        )
        self.assertNotIn("PHerc9999", report["samples"])

    def test_direction_png_depth_and_missing_preview(self):
        png = f"PHerc0343/segments/{SEG}/ink-detection/{NAME}-c+02-global.png"
        meta = {
            "samples": {
                "PHerc0343": {
                    "segments": {
                        "s": {
                            "data": [
                                item("ink-detection", png, direction="reverse"),
                                item("ink-detection", TIF, direction=None),
                            ]
                        }
                    }
                }
            }
        }
        manifest, report, previews = construir_oficial(meta)
        by = {e["official"]["path"]: e for e in manifest}
        frame = f"../catalog/PHerc0343/segments/{SEG}/ink-detection/{NAME}-c+02"
        self.assertEqual(by[png]["frames"], {"2": frame})
        self.assertEqual(by[png]["availableContrasts"], ["global"])
        self.assertEqual(by[png]["catalogMeta"]["cara"], "rev")
        self.assertTrue(by[png]["catalogMeta"]["depthKnown"])
        self.assertEqual(by[TIF]["catalogMeta"]["cara"], "unknown")
        self.assertEqual(
            by[TIF]["official"]["model_name"], "argus-v3", "model name falls back to the file name"
        )
        self.assertEqual(previews, {})
        self.assertEqual(report["depths"], 1)

    def test_rejects_metadata_without_samples(self):
        with self.assertRaises(ValueError):
            construir_oficial({"models": {}})


class TiffHeader(unittest.TestCase):
    def test_dims_from_header_only(self):
        import numpy as np
        import tifffile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = Fuente(tmp)
            Image.new("L", (37, 21)).save(root / "pil.tif", compression="tiff_deflate")
            tifffile.imwrite(root / "big.tif", np.zeros((9, 13), np.uint8), bigtiff=True)
            tifffile.imwrite(root / "mm.tif", np.zeros((5, 300), np.uint16), byteorder=">")
            (root / "no.tif").write_bytes(b"not a tiff at all")
            (root / "odd.tif").write_bytes(b"II" + (99).to_bytes(2, "little") + bytes(12))
            (root / "tagless.tif").write_bytes(
                b"II*\x00\x08\x00\x00\x00" + (1).to_bytes(2, "little") + bytes(12) + bytes(4)
            )
            self.assertEqual(tiff_dims(source, "pil.tif"), (37, 21))
            self.assertEqual(tiff_dims(source, "big.tif"), (13, 9))
            self.assertEqual(tiff_dims(source, "mm.tif"), (300, 5))
            for bad in ("no.tif", "odd.tif", "tagless.tif"):
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    tiff_dims(source, bad)


class TiffHeaderOverHttp(unittest.TestCase):
    def test_servers_that_ignore_range(self):
        import ink_viewer.server.tiff_header as th

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Image.new("L", (37, 21)).save(root / "pil.tif")
            (root / "short.tif").write_bytes(b"II*\x00" + (1000).to_bytes(4, "little") + bytes(8))

            class Plain(
                http.server.SimpleHTTPRequestHandler
            ):  # answers 200 with the whole file, ignoring Range
                def __init__(self, *a, **kw):
                    super().__init__(*a, directory=tmp, **kw)

                def log_message(self, *a):
                    pass

            with servidor(Plain) as url:
                source = Fuente(url)
                self.assertEqual(tiff_dims(source, "pil.tif"), (37, 21))
                with self.assertRaises(ValueError):
                    tiff_dims(source, "short.tif")
                with patch.object(th, "SKIP_LIMIT", 4), self.assertRaises(ValueError):
                    tiff_dims(source, "pil.tif")


class OfficialSource(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.bucket, self.cache = root / "bucket", root / "cache"
        for rel, body in {
            TIF: image("TIFF", (80, 40), 187),
            JPG: image("JPEG", (10, 5), 99),
            "metadata.json": gzip.compress(json.dumps(metadata()).encode()),
        }.items():
            path = self.bucket / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        bucket = str(self.bucket)

        class Bucket(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=bucket, **kw)

            def log_message(self, *a):
                pass

        self.remote = servidor(Bucket)
        url = self.remote.__enter__()
        self.env = patch.dict(
            os.environ, {"VISOR_OFFICIAL_BUCKET": url, "VISOR_OFFICIAL_CACHE": str(self.cache)}
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.remote.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_source_builds_index_and_serves_maps(self):
        source = Fuente("Official")
        self.assertIsInstance(source, FuenteOficial)
        source.verificar()
        self.assertEqual((source.layout, source.manifest_rel), ("catalog", "_viewer/manifest.json"))
        self.assertEqual(source.config()["origen"], "official")
        self.assertIsInstance(
            Fuente(**source.config()), FuenteOficial, "saved config reopens the official source"
        )
        info = source.info()
        self.assertEqual(info["series"], 1)
        self.assertTrue(info["generated"])
        self.assertEqual(len(source.indice("_viewer/manifest.json")), 1)
        self.assertEqual(source.preview(TIF, 8), JPG)
        self.assertIsNone(source.preview(TIF, 4))
        with source.abrir("_viewer/index-info.json") as (status, headers, body):
            self.assertEqual((status, json.loads(body.read())["series"]), (200, 1))
        with servidor(p.Handler, source) as base:
            with urllib.request.urlopen(base + f"/api/mapa/catalog/{TIF}?escala=8") as response:
                im = Image.open(io.BytesIO(response.read()))
                self.assertEqual((im.format, im.size), ("JPEG", (10, 5)))
            with urllib.request.urlopen(base + f"/api/mapa/catalog/{TIF}?escala=4") as response:
                im = Image.open(response)
                self.assertEqual((im.format, im.size), ("PNG", (20, 10)))
                self.assertEqual(im.getpixel((0, 0)), 187)

    def test_large_maps_are_not_refused_as_decompression_bombs(self):
        import warnings

        source = Fuente("official")
        source.verificar()
        with (
            patch.object(Image, "MAX_IMAGE_PIXELS", 100),
            warnings.catch_warnings(),
            servidor(p.Handler, source) as base,
        ):
            warnings.simplefilter(
                "error"
            )  # a server where warnings are errors must still decode a 3200-pixel map
            with urllib.request.urlopen(base + f"/api/mapa/catalog/{TIF}?escala=4") as response:
                self.assertEqual(Image.open(response).size, (20, 10))

    def test_size_limits_choose_full_preview_or_refusal(self):
        source = Fuente("official")
        source.verificar()
        big = TIF.replace(".tif", "-big.tif")  # a second map without a published preview
        Image.new("L", (80, 40), 5).save(self.bucket / big)
        with servidor(p.Handler, source) as base:
            with urllib.request.urlopen(base + f"/api/dims/catalog/{TIF}") as response:
                self.assertEqual(json.loads(response.read()), {"w": 80, "h": 40})
            with patch.object(p, "FULLRES_PIXELS", 1000), patch.object(p, "MAP_PIXELS", 2000):
                for path in (
                    f"/api/mapa/catalog/{TIF}?escala=1",
                    f"/api/mapa/catalog/{big}?escala=4",
                ):
                    with (
                        self.subTest(path=path),
                        self.assertRaises(urllib.error.HTTPError) as error,
                    ):
                        urllib.request.urlopen(base + path)
                    self.assertEqual(error.exception.code, 400)
                    self.assertIn(b"too large", error.exception.read())
                with urllib.request.urlopen(base + f"/api/mapa/catalog/{TIF}?escala=4") as response:
                    self.assertEqual(
                        Image.open(io.BytesIO(response.read())).format,
                        "JPEG",
                        "too large to decode: the published preview",
                    )
            with patch.object(p, "FULLRES_PIXELS", 1000), patch.object(p, "MAP_PIXELS", 4000):
                with urllib.request.urlopen(base + f"/api/mapa/catalog/{TIF}?escala=4") as response:
                    self.assertEqual(
                        Image.open(io.BytesIO(response.read())).size,
                        (20, 10),
                        "decodable: the real 1/4 map",
                    )

    def test_refresh_policy(self):
        source = Fuente("official")
        self.assertTrue(source.preparar())
        self.assertFalse(source.preparar(), "a fresh index is reused")
        (self.bucket / "metadata.json").write_bytes(
            json.dumps({"samples": {}}).encode()
        )  # plain JSON is accepted too
        self.assertTrue(source.preparar(force=True))
        self.assertEqual(source.indice("_viewer/manifest.json"), [])
        (self.bucket / "metadata.json").unlink()
        self.assertFalse(source.preparar(force=True), "a failed refresh keeps the previous index")
        self.assertEqual(source.indice("_viewer/manifest.json"), [])
        fresh = Fuente("official")
        fresh.cache = Path(self.tmp.name) / "empty"
        self.assertEqual(fresh.indice("_viewer/manifest.json"), {})
        with self.assertRaises(FileNotFoundError), fresh.abrir("_viewer/manifest.json"):
            pass
        with self.assertRaises(ValueError):
            fresh.preparar()

    def test_only_official_origin(self):
        with self.assertRaises(ValueError):
            FuenteOficial("https://example.org")


if __name__ == "__main__":
    unittest.main()


class OfficialListing(unittest.TestCase):
    """ink-sdk jobs list a segment's surface-volumes/: the official source pages S3's anonymous ListObjectsV2."""

    def test_lists_one_level_across_pages(self):
        seen = []
        pages = {
            None: (
                "<CommonPrefixes><Prefix>S/surface-volumes/2.4um-a.zarr/</Prefix></CommonPrefixes>"
                "<Contents><Key>S/surface-volumes/</Key></Contents><IsTruncated>true</IsTruncated>"
                "<NextContinuationToken>t2</NextContinuationToken>"
            ),
            "t2": (
                "<CommonPrefixes><Prefix>S/surface-volumes/8.64um-b.zarr/</Prefix></CommonPrefixes>"
                "<Contents><Key>S/surface-volumes/notes.txt</Key></Contents>"
                "<Contents><Key>S/surface-volumes/.hidden</Key></Contents><IsTruncated>false</IsTruncated>"
            ),
        }

        class S3(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                from urllib.parse import parse_qs, urlsplit

                query = parse_qs(urlsplit(self.path).query)
                seen.append(query)
                body = (
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                    + pages[query.get("continuation-token", [None])[0]]
                    + "</ListBucketResult>"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        with servidor(S3) as url, patch.dict(os.environ, {"VISOR_OFFICIAL_BUCKET": url}):
            source = Fuente("official")
            self.assertEqual(
                source.listado("S/surface-volumes"),
                [("2.4um-a.zarr", True), ("8.64um-b.zarr", True), ("notes.txt", False)],
            )
            self.assertEqual(
                [(q["prefix"], q["delimiter"], q["list-type"]) for q in seen],
                [(["S/surface-volumes/"], ["/"], ["2"])] * 2,
            )
            with self.assertRaises(ValueError):
                source.listado("../etc")
