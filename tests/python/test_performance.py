import copy
import gzip
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import ink_viewer.server.s3cache_proxy as proxy
from ink_viewer.server.fuentes import Fuente
from ink_viewer.server.vast_server import ReadOnlyHandler, VastSource
from test_fuentes import servidor


class Performance(unittest.TestCase):
    def test_browser_projection_keeps_rendering_and_scientific_metadata(self):
        source = object.__new__(VastSource)
        route = "catalog/PHerc0175A/segments/s/ink-detection/map.png"
        source.registry = {
            "routes": {route: "native"},
            "assets": {"native": {"state": "AVAILABLE", "dimensions": [3800, 3220]}},
        }
        runs = [
            {
                "id": "run",
                "frames": {"0": route},
                "maximum": route,
                "availableContrasts": ["fixed", "global"],
                "frameContrasts": {route: ["fixed"]},
                "sourceDirectory": "exact-source",
                "renderGrid": {"width": 3800},
                "meshAssociation": {"id": "mesh"},
                "catalogMeta": {"modelo": "base", "um_por_px": 7.91},
                "localEvidence": ["large receipt"],
                "vastAsset": "native",
                "vastEntry": "s",
                "maskPaths": ["internal"],
            }
        ]
        original = copy.deepcopy(runs)
        result = source.browser_manifest(runs)
        self.assertEqual(runs, original)
        for key in (
            "id",
            "frames",
            "maximum",
            "availableContrasts",
            "frameContrasts",
            "sourceDirectory",
            "renderGrid",
            "meshAssociation",
            "catalogMeta",
        ):
            self.assertEqual(result[0][key], runs[0][key])
        self.assertNotIn("localEvidence", result[0])
        self.assertEqual(
            result[0]["frameDimensions"],
            {"0": {"fixed": [3800, 3220]}, "max": {"fixed": [3800, 3220]}},
        )

    def test_http_bootstrap_compression_revalidation_and_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "cache/_viewer").mkdir(parents=True)
            scores = root / "cache/_viewer/legibilidad-auto.json"
            scores.write_text(
                json.dumps({"laminas": {"s": {"max": 0.832}}, "padding": "same " * 2000})
            )
            (root / "index.html").write_text(
                '<html><head></head><script src="/api/rollo.js"></script></html>'
            )
            (root / "test.js").write_text('window.sample="' + "repeat " * 1000 + '";')
            (root / "sample.png").write_bytes(b"original image")
            source = Fuente(tmp)
            source.site = root
            metadata = {"scroll": "PHerc0175A", "literal": "</script>", "um_por_px": 7.91}
            source.indice = lambda key, **kw: metadata if key == "all-gallery/metadata.json" else {}
            with (
                patch.object(proxy, "CODE", root),
                patch.object(proxy, "STATIC", proxy.STATIC | {"test.js", "sample.png"}),
                servidor(ReadOnlyHandler, source) as (srv, base),
            ):
                srv.runs = [{"scroll": "PHerc0175A"}]

                def get(path, headers=None, method="GET"):
                    return urllib.request.urlopen(
                        urllib.request.Request(base + path, headers=headers or {}, method=method)
                    )

                with get("/all-gallery/index.html", {"Accept-Encoding": "gzip"}) as response:
                    page = gzip.decompress(response.read()).decode()
                    self.assertNotIn('src="/api/rollo.js"', page)
                    bootstrap = json.loads(
                        page.split("window.VISOR_BOOTSTRAP=", 1)[1].split(
                            ";window.ROLLO_SERVIDOR", 1
                        )[0]
                    )
                    self.assertEqual(bootstrap["metadata"], metadata)
                    self.assertEqual(bootstrap["rollos"]["PHerc0175A"]["voxel_um"], None)
                    self.assertNotIn(
                        "</script>",
                        page.split("window.VISOR_BOOTSTRAP=", 1)[1].split(
                            ";window.ROLLO_SERVIDOR", 1
                        )[0],
                    )
                for url, path in (
                    ("/catalog/_viewer/legibilidad-auto.json", scores),
                    ("/all-gallery/test.js", root / "test.js"),
                    ("/all-gallery/sample.png", root / "sample.png"),
                ):
                    with get(url, {"Accept-Encoding": "gzip"}) as response:
                        encoded = response.read()
                        etag = response.headers["ETag"]
                        content = (
                            gzip.decompress(encoded)
                            if response.headers.get("Content-Encoding") == "gzip"
                            else encoded
                        )
                        self.assertEqual(content, path.read_bytes())
                        if path.suffix != ".png":
                            self.assertLess(len(encoded), len(content) // 2)
                    with get(url, {"Accept-Encoding": "gzip"}, "HEAD") as response:
                        self.assertEqual(response.read(), b"")
                        self.assertEqual(int(response.headers["Content-Length"]), len(encoded))
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        get(url, {"Accept-Encoding": "gzip", "If-None-Match": etag})
                    self.assertEqual(error.exception.code, 304)
                    path.write_bytes(path.read_bytes() + b" ")
                    with get(url, {"Accept-Encoding": "gzip", "If-None-Match": etag}) as response:
                        self.assertEqual(response.status, 200)
                        self.assertNotEqual(response.headers["ETag"], etag)

    def test_combined_tools_parse_and_invalidate(self):
        parts = tuple(
            (
                str(proxy.CODE / proxy.web_asset(name)),
                proxy.file_revision(proxy.CODE / proxy.web_asset(name)),
            )
            for name in proxy.VIEWER_TOOLS
        )
        body, compressed, _ = proxy.tools_bytes(parts)
        self.assertEqual(gzip.decompress(compressed), body)
        if shutil.which("node"):
            subprocess.run(["node", "--check"], input=body, check=True, capture_output=True)
        self.assertEqual(
            [body.index(("/* " + name + " */").encode()) for name in proxy.VIEWER_TOOLS],
            sorted(body.index(("/* " + name + " */").encode()) for name in proxy.VIEWER_TOOLS),
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "module.js"
            path.write_text("window.version=1;")
            first = proxy.tools_bytes(((str(path), proxy.file_revision(path)),))
            path.write_text("window.version=2;")
            # Same size and inode, written within one filesystem clock tick: move mtime
            # forward as a later real edit would, so the test does not depend on timing.
            later = path.stat().st_mtime_ns + 1_000_000_000
            os.utime(path, ns=(later, later))
            second = proxy.tools_bytes(((str(path), proxy.file_revision(path)),))
            self.assertNotEqual(first[2], second[2])


if __name__ == "__main__":
    unittest.main()
