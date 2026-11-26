"""Run: python -m unittest discover -s tests/python -p 'test_mask_pair.py'."""

import base64
import io
import json
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from PIL import Image, PngImagePlugin

import ink_viewer.server.s3cache_proxy as p
import test_fuentes
from ink_viewer.server.fuentes import Fuente
from test_fuentes import servidor


def png(value=0, size=(2, 2), corrida=None, mode="L"):
    stream = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    if corrida is not None:
        info.add_itxt(p.PNG_META, json.dumps(corrida))
    Image.new(mode, size, value).save(stream, format="PNG", pnginfo=info)
    return stream.getvalue()


class MaskPair(unittest.TestCase):
    pedir = test_fuentes.Fuentes.pedir

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data, self.annotations = self.root / "data", self.root / "annotations"
        self.data.mkdir()
        self.annotations.mkdir()
        self.source = Fuente(str(self.data), anotaciones=str(self.annotations))
        self.meta = {
            "lamina": "lam",
            "segmento": "lam",
            "base": "PHercX/segments/s",
            "ancho": 2,
            "alto": 2,
            "profundidad": 4,
            "par_id": "pair-one",
            "run_id": "run_x",
            "cara": None,
            "orientacion": {"correccion": [0, 0, 0]},
        }
        self.query = "?c=4&base=PHercX/segments/s&rollo=PHercX"
        self.headers = {"X-Visor-Origen": self.source.id, "Content-Type": "application/json"}

    def payload(self, ink=None, sup=None, meta=None):
        info = self.meta if meta is None else meta
        ink = png(255, corrida=info) if ink is None else ink
        sup = png(255, corrida=info) if sup is None else sup
        return json.dumps(
            {
                "inklabels": base64.b64encode(ink).decode(),
                "supervision_mask": base64.b64encode(sup).decode(),
                "corrida": info,
            }
        ).encode()

    def test_roundtrip_and_pair_members_are_immutable(self):
        with servidor(p.Handler, self.source) as (_, base):
            url = base + "/api/mascara-par/lam" + self.query
            saved = json.loads(self.pedir(url, self.payload(), self.headers)[2])
            pair = json.loads(self.pedir(url)[2])
            self.assertEqual(pair["corrida"], self.meta)
            self.assertEqual(json.loads(self.pedir(url + "&metadata=1")[2]), {"corrida": self.meta})
            self.assertEqual(
                self.pedir(
                    base + "/api/mascara-par/absent" + self.query + "&metadata=1&opcional=1"
                )[0],
                204,
            )
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.pedir(url, headers={"X-Visor-Origen": "stale"})
            self.assertEqual(e.exception.code, 409)
            self.assertEqual(base64.b64decode(pair["inklabels"]), png(255, corrida=self.meta))
            rel = "catalog/" + saved["clave_profundidad"]
            generation = self.source.mascara_local(rel).parent
            self.assertTrue((Path(self.annotations) / self.source.id / rel).parent.is_symlink())
            self.assertEqual(
                (generation / "lam_supervision_mask.png").read_bytes(), png(255, corrida=self.meta)
            )
            self.pedir(url, self.payload(png(0, corrida=self.meta)), self.headers)
            self.assertEqual(
                (generation / "lam_inklabels.png").read_bytes(), png(255, corrida=self.meta)
            )
            self.assertEqual(self.source.mascara_local(rel).read_bytes(), png(0, corrida=self.meta))
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.pedir(
                    base + "/api/mascara/lam/lam_inklabels.png" + self.query, png(0), self.headers
                )
            self.assertEqual(e.exception.code, 409)
            self.assertTrue(
                any(self.source.mascara_local(rel).parent.joinpath(".history").iterdir())
            )

    def test_invalid_payloads_do_not_write(self):
        good = png(255, corrida=self.meta)
        palette = Image.new("P", (2, 2), 1)
        palette.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
        palette_metadata = PngImagePlugin.PngInfo()
        palette_metadata.add_itxt(p.PNG_META, json.dumps(self.meta))
        stream = io.BytesIO()
        palette.save(stream, format="PNG", bits=1, pnginfo=palette_metadata)
        palette_png = stream.getvalue()
        self.assertEqual(palette_png[24], 1)
        cases = [
            self.payload(palette_png, good),
            self.payload(b"not a PNG", good),
            self.payload(png(128, corrida=self.meta), good),
            self.payload(png((255, 0, 0), corrida=self.meta, mode="RGB"), good),
            self.payload(png((0, 0, 0, 0), corrida=self.meta, mode="RGBA"), good),
            self.payload(png(255, (3, 2), self.meta), good),
            self.payload(good, png(0, corrida=self.meta)),
            self.payload(png(0, corrida=self.meta), png(0, corrida=self.meta)),
            json.dumps(
                {
                    "inklabels": base64.b64encode(png(255)).decode(),
                    "supervision_mask": base64.b64encode(png(255)).decode(),
                }
            ).encode(),
        ]
        for key, value in [
            ("segmento", "other"),
            ("base", "PHercY/segments/s"),
            ("profundidad", 8),
            ("ancho", 4),
            ("rollo", "PHercY"),
        ]:
            info = dict(self.meta, **{key: value})
            cases.append(self.payload(meta=info))
        with servidor(p.Handler, self.source) as (_, base):
            for body in cases:
                with self.subTest(body=body[:60]), self.assertRaises(urllib.error.HTTPError) as e:
                    self.pedir(base + "/api/mascara-par/lam" + self.query, body, self.headers)
                self.assertEqual(e.exception.code, 400)
                self.assertEqual(list(self.annotations.iterdir()), [])
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.pedir(
                    base
                    + "/api/mascara-par/lam"
                    + self.query.replace("PHercX/segments/s", "PHercY/segments/s"),
                    self.payload(),
                    self.headers,
                )
            self.assertEqual(e.exception.code, 400)

    def test_staging_failure_and_pointer_failure_restore_old_pair(self):
        dirs = [
            "catalog/PHercX/segments/s/labels/etiquetas/lam",
            "catalog/PHercX/segments/s/labels/por-profundidad/lam/c+04",
        ]
        files = {"lam_inklabels.png": png(255), "lam_supervision_mask.png": png(255)}
        self.source.guardar_par(dirs, files)
        paths = [self.source.mascara_local(d + "/" + name) for d in dirs for name in files]
        old_open = Path.open

        def broken_open(path, *args, **kw):
            if path.name == "lam_supervision_mask.png" and args and args[0] == "wb":
                raise OSError("second PNG staging failed")
            return old_open(path, *args, **kw)

        with patch.object(Path, "open", broken_open), self.assertRaises(OSError):
            self.source.guardar_par(dirs, {name: png(0) for name in files})
        self.assertEqual([path.read_bytes() for path in paths], [png(255)] * 4)
        replace = p.os.replace
        count = 0

        def broken_replace(src, dest):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("second alias publication failed")
            return replace(src, dest)

        with (
            patch("ink_viewer.server.fuentes.os.replace", broken_replace),
            self.assertRaises(OSError),
        ):
            self.source.guardar_par(dirs, {name: png(0) for name in files})
        self.assertEqual(
            [
                self.source.mascara_local(d + "/" + name).read_bytes()
                for d in dirs
                for name in files
            ],
            [png(255)] * 4,
        )

    def test_concurrent_reads_get_one_complete_generation(self):
        with servidor(p.Handler, self.source) as (_, base):
            url = base + "/api/mascara-par/lam" + self.query
            self.pedir(url, self.payload(), self.headers)
            errors = []

            def writer():
                try:
                    for number, value in enumerate((0, 255, 0, 255)):
                        info = dict(self.meta, par_id="concurrent-" + str(number))
                        self.pedir(
                            url,
                            self.payload(
                                png(value, corrida=info), png(255, corrida=info), meta=info
                            ),
                            self.headers,
                        )
                except Exception as e:
                    errors.append(e)

            thread = threading.Thread(target=writer)
            thread.start()
            while thread.is_alive():
                pair = json.loads(self.pedir(url)[2])
                self.assertEqual(
                    p.leer_mascara(base64.b64decode(pair["inklabels"]))[1], pair["corrida"]
                )
                self.assertEqual(
                    p.leer_mascara(base64.b64decode(pair["supervision_mask"]))[1], pair["corrida"]
                )
            thread.join()
            self.assertEqual(errors, [])

    def test_process_death_between_aliases_keeps_each_pair_complete(self):
        dirs = [
            "catalog/PHercX/segments/s/labels/etiquetas/lam",
            "catalog/PHercX/segments/s/labels/por-profundidad/lam/c+04",
        ]
        files = {"lam_inklabels.png": png(255), "lam_supervision_mask.png": png(255)}
        self.source.guardar_par(dirs, files)
        replace = p.os.replace
        count = 0

        class ProcessDied(BaseException):
            pass

        def interrupted_replace(src, dest):
            nonlocal count
            count += 1
            if count == 2:
                raise ProcessDied()
            return replace(src, dest)

        with (
            patch("ink_viewer.server.fuentes.os.replace", interrupted_replace),
            self.assertRaises(ProcessDied),
        ):
            self.source.guardar_par(dirs, {name: png(0) for name in files})
        for directory in dirs:
            resolved = self.source.mascara_local(directory)
            self.assertEqual(
                (resolved / "lam_inklabels.png").read_bytes(),
                (resolved / "lam_supervision_mask.png").read_bytes(),
            )

    def test_pair_save_without_source_is_refused(self):
        with servidor(p.Handler) as (_, base):
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.pedir(
                    base + "/api/mascara-par/lam" + self.query,
                    self.payload(),
                    {"Content-Type": "application/json"},
                )
            self.assertEqual(e.exception.code, 503)
            self.assertFalse(json.loads(self.pedir(base + "/api/origen")[2])["atomic_pair"])
        self.assertFalse(any(self.annotations.rglob("*.png")))


class MaskDecoding(unittest.TestCase):
    """leer_mascara refuses every malformed upload before anything is staged."""

    def test_rejects_malformed_masks(self):
        truncated = png()[:40]
        bad_meta = png(corrida=[1, 2])
        cases = {
            b"": "64 MiB",
            truncated: "PNG",
            bad_meta: "PNG",
            png(mode="I;16"): "8-bit",
        }
        for body, message in cases.items():
            with self.subTest(size=len(body)), self.assertRaisesRegex(ValueError, message):
                p.leer_mascara(body)
        with patch.object(p, "MASK_PIXELS", 3), self.assertRaisesRegex(ValueError, "megapixel"):
            p.leer_mascara(png())


if __name__ == "__main__":
    unittest.main()
