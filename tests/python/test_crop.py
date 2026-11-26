"""Labeling by crop: full-resolution windows of maps too large to label whole.
Run: python -m unittest discover -s tests/python -p 'test_crop.py'"""

import io
import json
import os
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import numpy as np
import tifffile
from PIL import Image

import ink_viewer.server.s3cache_proxy as p
import test_mask_pair
import test_official
from ink_viewer.server.fuentes import Fuente
from ink_viewer.server.tiff_header import tiff_region
from test_fuentes import servidor
from test_mask_pair import png

CROP = {"x": 10, "y": 20, "ancho": 2, "alto": 2}


class Parsing(unittest.TestCase):
    def test_crop_parameter_paths_and_identity(self):
        self.assertIsNone(p.leer_recorte({}))
        self.assertEqual(p.leer_recorte({"recorte": ["10,20,2,2"]}), CROP)
        for bad in ("1,2,3", "-1,0,2,2", "a,b,c,d", "0,0,0,5", "0,0,9000,9000"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                p.leer_recorte({"recorte": [bad]})
        self.assertEqual(
            p.ubicacion_par("lam", "PHercX/segments/s", "max", recorte=CROP),
            "catalog/PHercX/segments/s/labels/etiquetas/lam/recorte-x10-y20-2x2",
        )
        self.assertEqual(
            p.ubicacion_par("lam", "PHercX/segments/s", 4, recorte=CROP),
            "catalog/PHercX/segments/s/labels/por-profundidad/lam/c+04/recorte-x10-y20-2x2",
        )
        info = {
            "ancho": 2,
            "alto": 2,
            "segmento": "lam",
            "lamina": "lam",
            "profundidad": "max",
            "recorte": dict(CROP, ancho_mapa=900, alto_mapa=700),
        }
        p.validar_corrida(info, (2, 2), "lam", "PHercX/segments/s", "max", None, CROP)
        for recorte, window in (
            (None, info["recorte"]),
            (CROP, None),
            (dict(CROP, x=11), info["recorte"]),
            (CROP, "x"),
        ):
            with self.subTest(recorte=recorte, window=window), self.assertRaises(ValueError):
                p.validar_corrida(
                    dict(info, recorte=window),
                    (2, 2),
                    "lam",
                    "PHercX/segments/s",
                    "max",
                    None,
                    recorte,
                )


class Region(unittest.TestCase):
    def test_reads_only_the_window_of_strips_and_tiles(self):
        a = np.random.default_rng(0).integers(0, 250, (517, 1033)).astype(np.uint8)
        for kw in (
            {},
            {"compression": "zlib", "predictor": True},
            {"rowsperstrip": 7, "compression": "lzw"},
            {"tile": (32, 64), "compression": "zstd"},
        ):
            stream = io.BytesIO()
            tifffile.imwrite(stream, a, **kw)
            for x, y, w, h in (
                (0, 0, 1033, 517),
                (5, 3, 100, 50),
                (1000, 500, 33, 17),
                (63, 31, 2, 2),
            ):
                with self.subTest(kw=kw, at=(x, y)):
                    stream.seek(0)
                    np.testing.assert_array_equal(
                        tiff_region(stream, x, y, w, h), a[y : y + h, x : x + w]
                    )
        stream = io.BytesIO()
        tifffile.imwrite(stream, a)
        stream.seek(0)
        with self.assertRaisesRegex(ValueError, "outside"):
            tiff_region(stream, 1000, 0, 100, 10)
        stream = io.BytesIO()
        tifffile.imwrite(stream, np.zeros((4, 4, 3), np.uint8))
        stream.seek(0)
        with self.assertRaisesRegex(ValueError, "grayscale"):
            tiff_region(stream, 0, 0, 2, 2)


class ServedCrop(unittest.TestCase):
    setUp, tearDown = test_official.OfficialSource.setUp, test_official.OfficialSource.tearDown

    def get(self, base, query):
        with urllib.request.urlopen(
            base + f"/api/mapa/catalog/{test_official.TIF}?" + query
        ) as response:
            return np.asarray(Image.open(io.BytesIO(response.read())))

    def test_crop_is_full_resolution_and_downloads_once(self):
        p._TIFF_LOCAL["key"] = None
        a = (np.arange(40 * 80) % 251).astype(np.uint8).reshape(40, 80)
        tifffile.imwrite(self.bucket / test_official.TIF, a, compression="zlib", rowsperstrip=3)
        source = Fuente("official")
        source.verificar()
        opened = []
        real = source.abrir
        with (
            patch.object(source, "abrir", lambda rel, **kw: opened.append(rel) or real(rel, **kw)),
            patch.object(p, "FULLRES_PIXELS", 1000),
            test_official.servidor(p.Handler, source) as base,
        ):
            np.testing.assert_array_equal(
                self.get(base, "escala=1&recorte=5,7,30,20"), a[7:27, 5:35]
            )
            np.testing.assert_array_equal(
                self.get(base, "escala=1&recorte=50,0,30,40"), a[:, 50:80]
            )
            self.assertEqual(
                sum(rel.endswith(".tif") for rel in opened),
                1,
                "the second crop reuses the local copy",
            )
            for query in (
                "escala=4&recorte=0,0,2,2",
                "escala=1&recorte=70,0,20,2",
                "escala=1&recorte=1,2",
            ):
                with self.subTest(query=query), self.assertRaises(urllib.error.HTTPError) as error:
                    self.get(base, query)
                self.assertEqual(error.exception.code, 400)

    def test_local_copy_is_replaced_and_bounded(self):
        source = Fuente("official")
        source.verificar()
        rel = source.ruta_catalogo("catalog/" + test_official.TIF)
        first = p._tiff_local(source, rel)
        p._TIFF_LOCAL["key"] = None  # another map was cropped since
        second = p._tiff_local(source, rel)
        self.assertFalse(os.path.exists(first))
        self.assertTrue(os.path.exists(second))
        p._TIFF_LOCAL["key"] = None
        with self.assertRaisesRegex(ValueError, "256 MiB"):
            p._tiff_local(source, rel, limit=10)
        self.assertTrue(os.path.exists(second), "a failed download keeps the previous copy")

    def test_without_tifffile_or_codecs(self):
        source = Fuente("official")
        source.verificar()
        p._TIFF_LOCAL["key"] = None
        with test_official.servidor(p.Handler, source) as base:
            with patch.object(p, "tiff_region", side_effect=ImportError("no tifffile")):
                self.assertEqual(
                    self.get(base, "escala=1&recorte=1,2,3,4").shape,
                    (4, 3),
                    "Pillow crops maps it can decode",
                )
                for patched, query in (
                    (patch.object(p, "MAP_PIXELS", 100), "escala=1&recorte=1,2,3,4"),
                    (patch.object(p, "MAP_PIXELS", 10**9), "escala=1&recorte=79,2,3,4"),
                ):
                    with (
                        self.subTest(query=query),
                        patched,
                        self.assertRaises(urllib.error.HTTPError) as error,
                    ):
                        self.get(base, query)
                    self.assertEqual(error.exception.code, 400)
            with (
                patch.object(
                    p,
                    "tiff_region",
                    side_effect=ValueError("COMPRESSION.LZW requires the 'imagecodecs' package"),
                ),
                self.assertRaises(urllib.error.HTTPError) as error,
            ):
                self.get(base, "escala=1&recorte=1,2,3,4")
            self.assertIn(b"ink-viewer[crop]", error.exception.read())


class CropPair(unittest.TestCase):
    setUp, payload, pedir = (
        test_mask_pair.MaskPair.setUp,
        test_mask_pair.MaskPair.payload,
        test_mask_pair.MaskPair.pedir,
    )

    def test_crop_pairs_live_apart_from_the_whole_map(self):
        meta = dict(self.meta, recorte=dict(CROP, ancho_mapa=900, alto_mapa=700))
        crop_q = self.query + "&recorte=10,20,2,2"
        with servidor(p.Handler, self.source) as (_, base):
            url = base + "/api/mascara-par/lam"
            saved = json.loads(self.pedir(url + crop_q, self.payload(meta=meta), self.headers)[2])
            self.assertTrue(
                all("/recorte-x10-y20-2x2/" in key for key in saved["claves"]), saved["claves"]
            )
            self.assertEqual(
                json.loads(self.pedir(url + crop_q + "&metadata=1")[2]), {"corrida": meta}
            )
            self.assertEqual(
                self.pedir(url + self.query + "&metadata=1&opcional=1")[0],
                204,
                "the whole map has no pair yet",
            )
            self.assertEqual(
                self.pedir(
                    url + self.query.replace("?", "?recorte=10,21,2,2&") + "&metadata=1&opcional=1"
                )[0],
                204,
            )
            for query, body in ((self.query, self.payload(meta=meta)), (crop_q, self.payload())):
                with self.subTest(query=query), self.assertRaises(urllib.error.HTTPError) as error:
                    self.pedir(url + query, body, self.headers)
                self.assertEqual(error.exception.code, 400)
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.pedir(
                    base + "/api/mascara/lam/lam_extra.png" + crop_q,
                    png(0, corrida=meta),
                    self.headers,
                )
            self.assertEqual(error.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
