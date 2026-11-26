import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import ink_viewer.server.s3cache_proxy as p
from ink_viewer.server.fuentes import Fuente
from test_fuentes import datos, servidor


class Scrolls(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        for name in ("SCROLL", "ROLLO", "LOG_FILE"):
            patch.object(p, name, getattr(p, name)).start()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        datos(self.root)
        self.source = Fuente(str(self.root))

    def test_sample_comes_from_the_path(self):
        self.assertEqual(
            p.sample_de("catalog/PHerc0800/segments/s/ink-detection/x.png"), "PHerc0800"
        )
        self.assertEqual(
            p.sample_de("catalog/_unresolved/PHerc0800/q/ink-detection/x.png"), "PHerc0800"
        )
        self.assertEqual(
            p.sample_de("../catalog/PHerc1447/segments/s/ink-detection/x.png"), "PHerc1447"
        )
        self.assertIsNone(p.sample_de("col/gallery/lam/base_c+00/fixed.png"))

    def test_default_scroll_reads_the_source_metadata(self):
        info = p.configurar("PHerc0800", self.source)
        self.assertEqual(
            (info["scroll"], info["voxel_um"], p.SCROLL), ("PHerc0800", 7.5, "PHerc0800")
        )
        # No metadata: the scale stays unknown, never guessed.
        self.assertIsNone(p.configurar("PHerc1447", self.source)["voxel_um"])
        self.assertIsNone(p.configurar(None, self.source)["scroll"])
        self.assertIsNone(p.SCROLL)
        with self.assertRaises(ValueError):
            p.configurar("../etc", self.source)

    def test_labels_base_never_lands_in_another_scroll(self):
        index = {"lam": "PHerc1447/segments/s"}
        with patch.object(
            self.source, "indice", lambda rel, **kw: index if "labels" in rel else {}
        ):
            # The segment named by the viewer wins.
            self.assertEqual(
                p.labels_base("lam", "PHerc0800/segments/t", fuente=self.source),
                "PHerc0800/segments/t",
            )
            with self.assertRaises(ValueError):
                p.labels_base("lam", "PHerc1447/segments/t", "PHerc0800", self.source)
            with self.assertRaises(ValueError):
                p.labels_base("lam", "PHerc0800/segments/../t", fuente=self.source)
            # The index of another scroll is ignored when the scroll is known.
            self.assertEqual(
                p.labels_base("lam", rollo="PHerc0800", fuente=self.source),
                "_unresolved/PHerc0800",
            )
            self.assertEqual(
                p.labels_base("lam", rollo="PHerc1447", fuente=self.source),
                "PHerc1447/segments/s",
            )
            self.assertEqual(p.labels_base("lam", fuente=self.source), "PHerc1447/segments/s")
            self.assertEqual(p.labels_base("other", fuente=self.source), "_unresolved/unknown")


class NoSource(unittest.TestCase):
    """Without a source the page opens empty with the source picker; data paths answer 503."""

    def get(self, base, path, method="GET"):
        return urllib.request.urlopen(urllib.request.Request(base + path, method=method))

    def test_page_loads_and_data_paths_are_refused(self):
        with servidor(p.Handler) as (_, base):
            with self.get(base, "/api/origen") as response:
                info = json.load(response)
            self.assertEqual((info["tipo"], info["origen"], info["escritura"]), ("none", "", False))
            with self.get(base, "/all-gallery/manifest.js") as response:
                self.assertEqual(response.read(), b"window.manifest=[];\n")
            with self.get(base, "/catalog/_viewer/manifest-work3.js") as response:
                self.assertTrue(response.read().startswith(b"//"))
            with self.get(base, "/all-gallery/index.html") as response:
                self.assertEqual(response.status, 200)
            with self.get(base, "/api/rollo.js?rollo=PHerc0800") as response:
                self.assertIn(b'"voxel_um": null', response.read())
            for path, method in (
                ("/catalog/PHerc0800/segments/s/ink-detection/x.png", "GET"),
                ("/catalog/PHerc0800/segments/s/ink-detection/x.png", "HEAD"),
                ("/api/mascara-par/lam", "GET"),
                ("/api/inventario", "GET"),
            ):
                with self.subTest(path=path, method=method):
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        self.get(base, path, method)
                    self.assertEqual(error.exception.code, 503)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(
                    urllib.request.Request(base + "/api/mascara-par/lam", data=b"{}", method="POST")
                )
            self.assertEqual(error.exception.code, 503)
            self.assertIn("--source", json.load(error.exception)["error"])

    def test_requests_for_another_host_are_refused(self):
        with servidor(p.Handler) as (_, base):
            for path in ("/catalog/x.png", "/api/origen"):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(
                        urllib.request.Request(base + path, headers={"Host": "evil.invalid"})
                    )
                self.assertEqual(error.exception.code, 403)
