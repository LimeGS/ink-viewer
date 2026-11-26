"""--source ink-labels: VSkinox's ink-label dataset as a viewer catalog, read from a copy with the dataset's layout.
Run: python -m unittest discover -s tests/python -p 'test_ink_labels.py'"""

import base64
import csv
import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import numcodecs
import numpy as np
from PIL import Image

import ink_viewer.server.s3cache_proxy as p
from ink_viewer.server import fuente_etiquetas as fe
from ink_viewer.server.fuentes import Fuente
from test_official import servidor

ENTRY = "ec_0_1113394962_1_3"
PATH = f"PHerc0500P2/20250919184431-0500P2-wrap04_0919/{ENTRY}"
BARE = "bare_0_0"  # an entry published without its CT layers


def write_dataset(root):
    rows = [
        {
            "scroll": "PHerc0500P2",
            "segment": "20250919184431-0500P2-wrap04_0919",
            "entry": ENTRY,
            "family": "ecarts",
            "path": PATH,
            "quality": "5",
            "role": "reference",
        },
        {
            "scroll": "PHercParis4_Scroll1",
            "segment": "w1",
            "entry": BARE,
            "family": "can24net",
            "path": f"PHercParis4_Scroll1/w1/{BARE}",
            "quality": "3",
            "role": "machine",
        },
        {
            "scroll": "Fragments",
            "segment": "f",
            "entry": BARE,
            "family": "x",
            "path": "dup",
            "quality": "5",
            "role": "reference",
        },
        {
            "scroll": "PHerc0139",
            "segment": "s",
            "entry": "../bad",
            "family": "x",
            "path": "bad",
            "quality": "1",
            "role": "machine",
        },
    ]
    with open(root / "entries.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    label = np.full((32, 48), 0, np.uint8)
    label[4:10, 4:20] = 1
    label[12:16, :] = 2
    label[28:, 40:] = 255
    for entry_path in (PATH, f"PHercParis4_Scroll1/w1/{BARE}"):
        labels = root / entry_path / "labels"
        labels.mkdir(parents=True)
        for style in "ABCD":
            Image.fromarray(label).save(labels / f"style_{style}.png")
    layers = (np.arange(21 * 32 * 48) % 251).astype(np.uint8).reshape(21, 32, 48)
    zarr = root / PATH / "layers.zarr"
    zarr.mkdir()
    codec = numcodecs.Blosc(cname="zstd", clevel=5, shuffle=2)
    (zarr / ".zarray").write_text(
        json.dumps(
            {
                "shape": [21, 32, 48],
                "chunks": [21, 16, 32],
                "dtype": "|u1",
                "fill_value": 0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
                "compressor": codec.get_config(),
                "zarr_format": 2,
            }
        )
    )
    (zarr / ".zattrs").write_text(
        json.dumps({"surface_layer_in_this_array": 11, "um_per_px": 9.362})
    )
    for y in range(2):
        for x in range(2):
            block = np.zeros((21, 16, 32), np.uint8)
            part = layers[:, y * 16 : (y + 1) * 16, x * 32 : (x + 1) * 32]
            block[:, : part.shape[1], : part.shape[2]] = part
            if (y, x) != (1, 1):  # one absent chunk reads as fill_value
                (zarr / f"0.{y}.{x}").write_bytes(codec.encode(block.tobytes()))
    layers[:, 16:, 32:] = 0
    return label, layers


class InkLabels(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.data, self.cache, self.annotations = (
            root / "data",
            root / "cache",
            root / "annotations",
        )
        self.data.mkdir()
        self.annotations.mkdir()
        self.label, self.layers = write_dataset(self.data)
        env = patch.dict(
            os.environ,
            {"VISOR_INKLABELS_URL": str(self.data), "VISOR_INKLABELS_CACHE": str(self.cache)},
        )
        env.start()
        self.addCleanup(env.stop)

    def source(self, **kw):
        source = Fuente("ink-labels", anotaciones=str(self.annotations), **kw)
        source.verificar()
        return source

    def get(self, base, rel):
        with urllib.request.urlopen(base + "/" + rel) as response:
            return response.read()

    def test_index_from_entries_csv(self):
        source = self.source()
        self.assertIsInstance(source, fe.FuenteEtiquetas)
        self.assertEqual(
            (source.layout, source.config()["origen"], source.info()["style"]),
            ("catalog", "ink-labels", "A"),
        )
        manifest = source.indice("_viewer/manifest.json")
        self.assertEqual([e["id"] for e in manifest], ["inklabels_" + ENTRY, "inklabels_" + BARE])
        first = manifest[0]
        self.assertEqual(
            (first["scroll"], first["catalogMeta"]["lam"], first["catalogMeta"]["modelo"]),
            ("PHerc0500P2", ENTRY, "q5-reference-ecarts"),
        )
        self.assertEqual(sorted(map(int, first["frames"])), list(range(-11, 10)))
        self.assertEqual(manifest[1]["scroll"], "PHercParis4")
        self.assertEqual(fe.sample_id("Fragments"), "PHercFragments")
        report = source.indice("_viewer/index-info.json")
        self.assertEqual((report["series"], len(report["problems"])), (2, 2))
        self.assertEqual(source.info()["series"], 2)
        self.assertFalse(source.preparar(), "a fresh index is reused")
        reopened = self.source()
        self.assertEqual(reopened.paths, source.paths, "paths come back from the cache")

    def test_ct_layers_and_thumbnails_through_the_server(self):
        source = self.source()
        frame = "catalog/PHerc0500P2/segments/" + ENTRY + "/ink-detection/"
        with servidor(p.Handler, source) as base:
            for c in (-11, 0, 9):
                image = np.asarray(
                    Image.open(io.BytesIO(self.get(base, frame + f"ct-c{c:+03d}.png")))
                )
                np.testing.assert_array_equal(image, self.layers[11 + c])
            thumb = Image.open(io.BytesIO(self.get(base, frame + "downsampled/ct-c+00-ds8.jpg")))
            self.assertEqual((thumb.format, thumb.size), ("JPEG", (6, 4)))
            bare = np.asarray(
                Image.open(
                    io.BytesIO(
                        self.get(
                            base,
                            "catalog/PHercParis4/segments/" + BARE + "/ink-detection/ct-c+00.png",
                        )
                    )
                )
            )
            self.assertEqual(
                (bare[5, 5], bare[0, 0], bare[13, 0]),
                (200, 60, 110),
                "no layers: the label stands in",
            )
            for rel in (
                frame + "ct-c+10.png",
                "catalog/PHerc0500P2/segments/unknown/ink-detection/ct-c+00.png",
            ):
                with self.subTest(rel=rel), self.assertRaises(urllib.error.HTTPError) as error:
                    self.get(base, rel)
                self.assertEqual(error.exception.code, 404)
        self.assertIs(source.capas(ENTRY), source.capas(ENTRY), "decoded layers are cached")

    def test_dataset_label_opens_as_the_mask_pair_and_corrections_win(self):
        source = self.source()
        query = f"?c=-2&base=PHerc0500P2/segments/{ENTRY}&rollo=PHerc0500P2"
        headers = {"X-Visor-Origen": source.id, "Content-Type": "application/json"}
        with servidor(p.Handler, source) as base:
            url = base + "/api/mascara-par/" + ENTRY + query
            pair = json.loads(self.get(base, "api/mascara-par/" + ENTRY + query))
            ink, sup = (
                np.asarray(Image.open(io.BytesIO(base64.b64decode(pair[k]))))
                for k in ("inklabels", "supervision_mask")
            )
            np.testing.assert_array_equal(ink, (self.label == 1) * 255)
            np.testing.assert_array_equal(sup, np.isin(self.label, (0, 1)) * 255)
            manifest = {e["id"]: e for e in source.indice("_viewer/manifest.json")}
            entry = manifest["inklabels_" + ENTRY]
            self.assertEqual(
                (
                    pair["corrida"]["run_id"],
                    pair["corrida"]["directorio_fuente"],
                    pair["corrida"]["malla_sha256"],
                ),
                (entry["id"], entry["sourceDirectory"], entry["meshAssociation"]["meshSha256"]),
                "the browser recognises the label as this entry's own mask",
            )
            self.assertEqual(
                (pair["corrida"]["profundidad"], pair["corrida"]["base"]),
                (-2, f"PHerc0500P2/segments/{ENTRY}"),
            )
            corrected = dict(
                pair["corrida"],
                corregido=True,
                run_id="run_x",
                par_id="pair-one",
                cara=None,
                orientacion={"correccion": [0, 0, 0]},
            )
            # the dataset PNGs carry the dataset's metadata: a correction is saved with the browser's own run metadata
            from test_mask_pair import png

            body = json.dumps(
                {
                    "inklabels": base64.b64encode(png(0, (48, 32), corrected)).decode(),
                    "supervision_mask": base64.b64encode(png(255, (48, 32), corrected)).decode(),
                    "corrida": corrected,
                }
            ).encode()
            request = urllib.request.Request(url, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.status, 200)
            except urllib.error.HTTPError as e:
                self.fail(e.read())
            saved = json.loads(self.get(base, "api/mascara-par/" + ENTRY + query))
            self.assertTrue(
                saved["corrida"]["corregido"], "the saved correction replaces the dataset label"
            )
            self.assertFalse(
                any(self.data.rglob("*_inklabels.png")), "the dataset is never written"
            )

    def test_style_choice_stale_index_and_failures(self):
        with patch.dict(os.environ, {"VISOR_INKLABELS_STYLE": "c"}):
            self.assertEqual(self.source().style, "C")
        with (
            patch.dict(os.environ, {"VISOR_INKLABELS_STYLE": "E"}),
            self.assertRaisesRegex(ValueError, "A, B, C or D"),
        ):
            Fuente("ink-labels")
        with self.assertRaisesRegex(ValueError, "only serves"):
            fe.FuenteEtiquetas("official")
        source = self.source()
        with patch.dict(os.environ, {"VISOR_INKLABELS_MAX_AGE_HOURS": "0"}):
            stale = Fuente("ink-labels")
            (self.data / "entries.csv").write_text("scroll,entry\n")
            self.assertFalse(stale.preparar(), "an empty refresh keeps the previous index")
            self.assertEqual(stale.paths, source.paths)
            (self.cache / "_viewer/manifest.json").unlink()
            with self.assertRaisesRegex(ValueError, "no entries"):
                stale.preparar()
        self.assertEqual(Fuente("ink-labels").info()["series"], 2)
        with self.assertRaises(FileNotFoundError):
            source.etiqueta("nope")
        with self.assertRaises(FileNotFoundError), source.abrir("_viewer/manifest.json"):
            pass
        (self.data / PATH / "layers.zarr/.zarray").write_text(
            json.dumps({"shape": [2, 2], "dtype": "|u1", "chunks": [2, 2]})
        )
        source._layers.clear()
        with self.assertRaisesRegex(ValueError, "Unexpected layers.zarr"):
            source.capas(ENTRY)


if __name__ == "__main__":
    unittest.main()
