"""Cross-sections: mesh/volume discovery by volume id, map->mesh point, mesh curve, chunked CT window, HTTP endpoint."""

import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import numpy as np
import tifffile
from PIL import Image

import ink_viewer.server.corte as corte
import ink_viewer.server.s3cache_proxy as proxy
from ink_viewer.server.fuentes import Fuente
from test_fuentes import servidor

VOL, SEG = "20250821151531", "20260220214732-auto_grown_20260220144552896"
CT = (40, 96, 96)  # z, y, x
CHUNKS = [16, 32, 32]


def catalogo(root, compressor=True, step=4, scale=0.25, hole=False):
    """One sample with a CT volume (zarr v2, level 0) and a mesh on it: a flat sheet at y = 48, spanning x and z."""
    import numcodecs

    vol = root / "PHerc0841/volumes" / f"{VOL}-9.366um-1.2m-113keV-masked.zarr" / "0"
    vol.mkdir(parents=True)
    codec = numcodecs.Zstd(level=1) if compressor else None
    (vol / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": list(CT),
                "chunks": CHUNKS,
                "dtype": "|u1",
                "compressor": codec.get_config() if codec else None,
                "fill_value": 0,
                "order": "C",
                "filters": None,
                "dimension_separator": "/",
            }
        )
    )
    data = np.full(CT, 60, np.uint8)
    data[:, 46:51, :] = 200  # the sheet
    for cz in range(0, CT[0], CHUNKS[0]):
        for cy in range(0, CT[1], CHUNKS[1]):
            for cx in range(0, CT[2], CHUNKS[2]):
                if (cz, cy, cx) == (0, 64, 64):
                    continue  # absent chunk -> fill
                block = np.zeros(CHUNKS, np.uint8)
                part = data[cz : cz + CHUNKS[0], cy : cy + CHUNKS[1], cx : cx + CHUNKS[2]]
                block[: part.shape[0], : part.shape[1], : part.shape[2]] = part
                raw = block.tobytes()
                p = vol / str(cz // CHUNKS[0]) / str(cy // CHUNKS[1]) / str(cx // CHUNKS[2])
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(codec.encode(raw) if codec else raw)
    mesh = root / "PHerc0841/segments" / SEG / "mesh" / f"20260220214732-on-{VOL}-9.366um.tifxyz"
    mesh.mkdir(parents=True)
    (mesh.parent / "intermediate").mkdir()
    H, W = 9, 20  # rows go along z, columns along x
    i, j = np.mgrid[0:H, 0:W].astype(np.float32)
    x, y, z = 4 + j * step, np.full((H, W), 48, np.float32), 2 + i * step
    if hole:
        x[:, 5:7] = -1
        y[:, 5:7] = -1
        z[:, 5:7] = -1
    for c, a in zip("xyz", (x, y, z)):
        tifffile.imwrite(mesh / f"{c}.tif", a)
    (mesh / "meta.json").write_text(
        json.dumps({"format": "tifxyz", "scale": [scale, scale], "type": "seg"})
    )
    (root / "_viewer").mkdir()
    (root / "_viewer/manifest.json").write_text("[]")
    (root / "_viewer/index-info.json").write_text(
        json.dumps({"schema": "vesuvius.viewer-index.v1", "layout": "catalog", "scroll": None})
    )
    return mesh


class Corte(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        corte._meshes.clear()
        corte._chunks.clear()

    def tearDown(self):
        self.tmp.cleanup()

    def fuente(self):
        f = Fuente(str(self.root))
        f.verificar()
        return f

    def test_finds_mesh_and_volume_by_id(self):
        catalogo(self.root)
        f = self.fuente()
        self.assertTrue(
            corte.malla_rel(f, "PHerc0841", SEG, VOL).endswith(f"-on-{VOL}-9.366um.tifxyz")
        )
        self.assertTrue(corte.volumen_rel(f, "PHerc0841", VOL).endswith("-masked.zarr"))
        with self.assertRaises(FileNotFoundError):
            corte.malla_rel(f, "PHerc0841", SEG, "20990101000000")
        with self.assertRaises(FileNotFoundError):
            corte.volumen_rel(f, "PHerc0841", "20990101000000")
        with self.assertRaises(ValueError):
            corte.corte_png(f, "PHerc0841", "../x", VOL, 0, 0)

    def test_point_curve_and_window(self):
        catalogo(self.root, hole=True)
        f = self.fuente()
        mesh = corte.malla(f, corte.malla_rel(f, "PHerc0841", SEG, VOL))
        (x, y, z), prop = corte.punto(mesh, 8, 12, 80, 36)  # grid (3, 2) at scale 0.25
        self.assertFalse(prop)
        self.assertAlmostEqual(x, 4 + 2 * 4)
        self.assertAlmostEqual(z, 2 + 3 * 4)
        (_, _, z2), prop2 = corte.punto(mesh, 8, 12, 400, 400)  # sizes do not match the scale
        self.assertTrue(prop2)
        (x3, _, _), _ = corte.punto(mesh, 18, 4)  # next to the hole: valid corners only
        self.assertGreater(x3, 0)
        for u, v in ((-1, 0), (1000, 0)):
            with self.assertRaises(ValueError):
                corte.punto(mesh, u, v)
        with self.assertRaises(ValueError):
            corte.punto(mesh, 22, 0.0)  # inside the hole
        c = corte.curva(mesh, 10.0)
        self.assertEqual(len(c), 18)
        self.assertTrue(np.allclose(c[:, 1], 48))
        a, shape = corte.ventana(f, corte.volumen_rel(f, "PHerc0841", VOL), 5, 30, 70, 0, 96)
        self.assertEqual(a.shape, (40, 96))
        self.assertEqual(int(a[18, 10]), 200)
        self.assertEqual(int(a[0, 10]), 60)
        b, _ = corte.ventana(f, corte.volumen_rel(f, "PHerc0841", VOL), 5, 64, 96, 64, 96)
        self.assertEqual(int(b.max()), 0)  # the absent chunk reads as fill

    def test_png_raw_chunks_and_guards(self):
        catalogo(self.root, compressor=False)
        f = self.fuente()
        png, info = corte.corte_png(f, "PHerc0841", SEG, VOL, 8, 12, 80, 36, tam=10)
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.mode, "RGB")
        self.assertEqual(img.size, (44, 64))  # tam clamped to 64, cut at x = 0
        self.assertEqual(round(info["z"]), 14)
        px = np.asarray(img)
        self.assertTrue(
            ((px[..., 0] == 255) & (px[..., 1] == 150)).any(), "orange mesh curve drawn"
        )
        with (
            patch.object(corte, "_array_meta", return_value={"shape": [5, 96, 96]}),
            self.assertRaises(ValueError),
        ):
            corte.corte_png(f, "PHerc0841", SEG, VOL, 8, 12)
        rel = corte.volumen_rel(f, "PHerc0841", VOL)
        with (
            patch.object(
                corte,
                "_array_meta",
                return_value={"shape": list(CT), "chunks": CHUNKS, "dtype": "|u1", "order": "F"},
            ),
            self.assertRaises(ValueError),
        ):
            corte.ventana(f, rel, 0, 0, 8, 0, 8)

    def test_http_absent_chunks_and_errors(self):
        catalogo(self.root)
        f = self.fuente()
        rel = corte.volumen_rel(f, "PHerc0841", VOL)
        corte._chunks.clear()
        real = corte._read

        def flaky(fuente, r, zarr_meta=False):
            if r.endswith("/0/0/1/1"):
                raise urllib.error.HTTPError(r, 403, "denied", {}, None)
            if r.endswith("/0/0/2/2"):
                raise urllib.error.HTTPError(r, 500, "boom", {}, None)
            return real(fuente, r, zarr_meta)

        with patch.object(corte, "_read", flaky):
            a, _ = corte.ventana(f, rel, 0, 32, 64, 32, 64)
            self.assertEqual(int(a.max()), 0)
            with self.assertRaises(urllib.error.HTTPError):
                corte.ventana(f, rel, 0, 64, 70, 64, 70)

    def test_http_source_uses_deterministic_names(self):
        catalogo(self.root)
        f = self.fuente()
        with patch.object(Fuente, "listado", side_effect=ValueError("HTTP no ofrece un listado")):
            png, info = corte.corte_png(
                f, "PHerc0841", SEG, VOL, 8, 12, 80, 36, 64, "9.366", "1.2", "113"
            )
            self.assertEqual(round(info["z"]), 14)
            with self.assertRaises(FileNotFoundError):
                corte.malla_rel(
                    f, "PHerc0841", SEG, VOL
                )  # no listing and no resolution: nothing to try
            with self.assertRaises(FileNotFoundError):
                corte.volumen_rel(f, "PHerc0841", VOL, "9.366")
        with self.assertRaises(ValueError):
            corte.corte_png(f, "PHerc0841", SEG, VOL, 8, 12, res="9.366um/../x")

    def test_endpoint(self):
        catalogo(self.root)
        f = self.fuente()
        with servidor(proxy.Handler, f) as (_, url):
            q = f"/api/corte?rollo=PHerc0841&segmento={SEG}&volumen={VOL}&u=8&v=12&w=80&h=36&tam=64"
            r = urllib.request.urlopen(url + q)
            self.assertEqual(r.headers["Content-Type"], "image/png")
            self.assertEqual(round(json.loads(r.headers["X-Corte"])["z"]), 14)
            self.assertEqual(Image.open(io.BytesIO(r.read())).size, (44, 64))
            for bad, code in (
                (q.replace(VOL, "20990101000000"), 404),
                (q.replace("u=8", "u=9999"), 400),
            ):
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(url + bad)
                self.assertEqual(e.exception.code, code)
            with patch.object(
                corte, "corte_png", side_effect=ImportError("No module named numcodecs")
            ):
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(url + q)
                self.assertEqual(e.exception.code, 501)


class CorteOrigen(unittest.TestCase):
    """--ct-origen: maps in one folder, meshes and CT in another (in practice the public bucket over HTTPS)."""

    def test_maps_here_ct_there(self):
        corte._meshes.clear()
        corte._chunks.clear()
        with tempfile.TemporaryDirectory() as t:
            ct_root, maps = Path(t) / "ct", Path(t) / "maps"
            ct_root.mkdir()
            maps.mkdir()
            catalogo(ct_root)
            for rel in ("_viewer/manifest.json", "_viewer/index-info.json"):
                (maps / rel).parent.mkdir(parents=True, exist_ok=True)
                (maps / rel).write_bytes((ct_root / rel).read_bytes())
            f = Fuente(str(maps))
            f.verificar()
            self.assertIsNone(corte.fuente_ct(""))
            ct = corte.fuente_ct(str(ct_root))
            self.assertEqual(ct.layout, "catalog")
            q = f"/api/corte?rollo=PHerc0841&segmento={SEG}&volumen={VOL}&u=8&v=12&w=80&h=36&tam=64"
            with servidor(proxy.Handler, f) as (srv, url):
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(url + q)  # the map folder has no mesh or CT
                self.assertEqual(e.exception.code, 404)
                srv.ct_fuente = ct
                self.assertEqual(
                    urllib.request.urlopen(url + q).headers["Content-Type"], "image/png"
                )

    def test_command_line(self):
        with tempfile.TemporaryDirectory() as t:
            maps = Path(t)
            catalogo(maps)
            argv = [
                "ink-viewer",
                "--origen",
                str(maps),
                "--ct-origen",
                str(maps),
                "--dry-run",
                "--config",
                str(maps / "c.json"),
            ]
            with patch("sys.argv", argv), patch("sys.stdout", new_callable=io.StringIO) as out:
                proxy.main()
            self.assertEqual(json.loads(out.getvalue())["ct_origen"], str(maps.resolve()))
            with (
                patch("sys.argv", argv[:3] + ["--ct-origen", str(maps / "missing"), "--dry-run"]),
                patch("sys.stderr", new_callable=io.StringIO),
                self.assertRaises(SystemExit),
            ):
                proxy.main()


if __name__ == "__main__":
    unittest.main()
