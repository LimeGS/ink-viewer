"""Run: python -m unittest discover -s tests/python -p 'test_fuentes.py' (boto3 required for the signed S3 check)."""

import contextlib
import http.server
import io
import json
import os
import secrets
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

import ink_viewer.server.s3cache_proxy as p
from ink_viewer.server.fuentes import Fuente


@contextlib.contextmanager
def servidor(handler, fuente=None, config=None):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    srv.fuente, srv.config_path = fuente, config
    srv.config_token, srv.config_lock = secrets.token_urlsafe(32), threading.Lock()
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv, f"http://127.0.0.1:{srv.server_port}"
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


def datos(root):
    paths = {
        "all-gallery/manifest.json": b"[]",
        "catalog/PHerc0800/segments/s/ink-detection/test + c+00.png": b"\x89PNG\r\n\x1a\n"
        + b"\0" * 8
        + struct.pack(">II", 321, 123)
        + b"pixels",
        "rollos/PHerc0800/rollo.json": json.dumps(
            {"scroll": "PHerc0800", "voxel_um": 7.5}
        ).encode(),
    }
    for rel, body in paths.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    return paths


def png(value=0):
    from PIL import Image

    stream = io.BytesIO()
    Image.new("L", (2, 2), value).save(stream, format="PNG")
    return stream.getvalue()


class Fuentes(unittest.TestCase):
    def pedir(self, url, body=None, headers=None, method=None):
        req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
        with urllib.request.urlopen(req) as response:
            return response.status, dict(response.headers), response.read()

    def test_local_http_and_signed_s3(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            objects = root / "test-bucket" / "prefix + space"
            files = datos(objects)
            signed = []

            class Remote(http.server.SimpleHTTPRequestHandler):
                def __init__(self, *a, **kw):
                    super().__init__(*a, directory=str(root), **kw)

                def log_message(self, *a):
                    pass

                def do_GET(self):
                    signed.append(self.headers.get("Authorization", ""))
                    if self.headers.get("Authorization") and self.path.endswith("/manifest.js"):
                        self.send_error(403, "S3 missing key without ListBucket")
                        return
                    super().do_GET()

            with servidor(Remote) as (_, remote):
                sources = [
                    Fuente(str(objects)),
                    Fuente(remote + "/test-bucket/prefix%20%2B%20space"),
                    Fuente("s3://test-bucket/prefix + space", endpoint=remote, region="us-east-1"),
                ]
                with patch.dict(
                    os.environ,
                    {
                        "AWS_ACCESS_KEY_ID": "test-key",
                        "AWS_SECRET_ACCESS_KEY": "test-secret",
                        "AWS_EC2_METADATA_DISABLED": "true",
                    },
                ):
                    for source in sources:
                        with (
                            self.subTest(tipo=source.tipo),
                            servidor(p.Handler, source) as (_, base),
                        ):
                            source.verificar()
                            rel = next(x for x in files if x.endswith(".png"))
                            self.assertEqual(
                                self.pedir(base + "/" + urllib.parse.quote(rel))[2], files[rel]
                            )
                            self.assertEqual(
                                self.pedir(base + "/" + urllib.parse.quote(rel), method="HEAD")[2],
                                b"",
                            )
                            self.assertEqual(
                                json.loads(
                                    self.pedir(base + "/api/dims/" + urllib.parse.quote(rel))[2]
                                ),
                                {"w": 321, "h": 123},
                            )
                            self.assertEqual(
                                self.pedir(base + "/all-gallery/manifest.js")[2],
                                b"window.manifest=[];\n",
                            )
                            self.assertIn(
                                b"7.5", self.pedir(base + "/api/rollo.js?rollo=PHerc0800")[2]
                            )
                            self.assertIn(
                                b"Vesuvius", self.pedir(base + "/all-gallery/index.html")[2]
                            )
                            self.assertEqual(
                                self.pedir(base + "/all-gallery/index.html", method="HEAD")[2], b""
                            )
                            with self.assertRaises(urllib.error.HTTPError) as e:
                                self.pedir(base + "/absent.png")
                            self.assertEqual(e.exception.code, 404)
                            with self.assertRaises(urllib.error.HTTPError) as e:
                                self.pedir(
                                    base + "/api/mascara/lam/lam.png",
                                    b"x",
                                    {"X-Visor-Origen": source.id},
                                )
                            self.assertEqual(e.exception.code, 403)
                self.assertTrue(any(x.startswith("AWS4-HMAC-SHA256") for x in signed))
                # Local Range must return only the requested bytes, including suffix ranges.
                with servidor(p.Handler, sources[0]) as (_, base):
                    rel = next(x for x in files if x.endswith(".png"))
                    status, headers, body = self.pedir(
                        base + "/" + urllib.parse.quote(rel), headers={"Range": "bytes=16-23"}
                    )
                    self.assertEqual((status, body), (206, struct.pack(">II", 321, 123)))
                    self.assertIn("bytes 16-23/", headers["Content-Range"])
                    self.assertEqual(
                        self.pedir(
                            base + "/" + urllib.parse.quote(rel), headers={"Range": "bytes=-6"}
                        )[2],
                        b"pixels",
                    )

    def test_configuration_masks_and_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b, annotations = root / "a", root / "b", root / "annotations"
            datos(a)
            datos(b)
            annotations.mkdir()
            source = Fuente(str(a), anotaciones=str(annotations))
            config = root / "config.json"
            with (
                patch.object(p, "LOG_FILE", root / "proxy.log"),
                servidor(p.Handler, source, config) as (srv, base),
            ):
                headers = {"Content-Type": "application/json", "X-Visor-Origen": source.id}
                mask = "/api/mascara/lam/lam.png?base=PHerc0800/segments/s&rollo=PHerc0800&c=4"
                out = json.loads(self.pedir(base + mask, png(0), headers)[2])
                self.assertEqual(out["destino"], "anotaciones-locales")
                self.assertEqual(
                    self.pedir(base + "/api/etiqueta/lam/c%2B04/lam.png?base=PHerc0800/segments/s")[
                        2
                    ],
                    png(0),
                )
                self.pedir(base + mask, png(255), headers)
                saved = source.mascara_local("catalog/" + out["clave"])
                self.assertEqual(saved.read_bytes(), png(255))
                self.assertEqual(next((saved.parent / ".history").iterdir()).read_bytes(), png(0))
                self.assertFalse(any(a.rglob("lam.png")))
                request = json.dumps({"origen": str(b), "anotaciones": str(annotations)}).encode()
                with self.assertRaises(urllib.error.HTTPError) as e:
                    self.pedir(base + "/api/origen", request, headers)
                self.assertEqual(e.exception.code, 403)
                headers["X-Visor-Config"] = srv.config_token
                bad = json.dumps({"origen": str(root / "absent")}).encode()
                with self.assertRaises(urllib.error.HTTPError) as e:
                    self.pedir(base + "/api/origen", bad, headers)
                self.assertEqual(e.exception.code, 400)
                self.assertIs(srv.fuente, source)
                changed = json.loads(self.pedir(base + "/api/origen", request, headers)[2])
                self.assertNotEqual(changed["id"], source.id)
                self.assertEqual(Fuente(**json.loads(config.read_text())).id, changed["id"])
                with self.assertRaises(urllib.error.HTTPError) as e:
                    self.pedir(base + mask, b"WRONG", headers)
                self.assertEqual(e.exception.code, 409)
                self.assertEqual(
                    self.pedir(
                        base
                        + "/api/etiqueta/lam/c%2B04/lam.png?base=PHerc0800/segments/s&opcional=1"
                    )[0],
                    204,
                )
                headers["X-Visor-Origen"] = changed["id"]
                self.pedir(base + mask, png(0), headers)
                self.assertEqual(saved.read_bytes(), png(255))
                with self.assertRaises(urllib.error.HTTPError) as e:
                    self.pedir(base + "/api/origen", headers={"Host": "untrusted.example"})
                self.assertEqual(e.exception.code, 403)
                with self.assertRaises(urllib.error.HTTPError) as e:
                    self.pedir(base + "/%2e%2e/secret")
                self.assertEqual(e.exception.code, 400)

    def test_reject_escaping_paths_and_invalid_sources(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            datos(root)
            Path(outside, "secret.png").write_bytes(b"SECRET")
            (root / "escape").symlink_to(outside)
            source = Fuente(tmp)
            with self.assertRaises(ValueError), source.abrir("escape/secret.png"):
                pass
            for origin in (
                "ftp://server/folder",
                "https://user:password@server/folder",
                "http://server/data?token=x",
                "s3://bucket/../secret",
            ):
                with self.subTest(origin=origin), self.assertRaises(ValueError):
                    Fuente(origin)


if __name__ == "__main__":
    unittest.main()
