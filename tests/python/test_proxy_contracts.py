"""Failure and cache contracts of the proxy helpers; external calls are stand-ins."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from ink_viewer.catalog import exportar_compuertas as gates
from ink_viewer.server import s3cache_proxy as proxy
from ink_viewer.server.fuentes import Fuente, guardar_json, url_http


class ProxyContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.addCleanup(patch.stopall)
        patch.object(proxy, "LOG_FILE", self.root / "log").start()

    def test_physical_metadata_comes_from_the_source(self):
        with self.assertRaises(ValueError):
            proxy.cargar_rollo("../outside")
        (self.root / "rollos").mkdir()
        source = Fuente(str(self.root))
        f = self.root / "rollos/PHercA.json"
        f.write_text('{"scroll":"PHercA","voxel_um":7.91}')
        self.assertEqual(proxy.cargar_rollo("PHercA", source)["voxel_um"], 7.91)
        f.write_text('{"scroll":"PHercB","voxel_um":7.91}')
        with self.assertRaises(ValueError):
            proxy.cargar_rollo("PHercA", source)
        f.unlink()
        (self.root / "rollos/PHercA").mkdir()
        (self.root / "rollos/PHercA/rollo.json").write_text('{"scroll":"PHercA","voxel_um":0}')
        with self.assertRaises(ValueError):
            proxy.cargar_rollo("PHercA", source)
        # Unknown stays unknown: no source or no metadata never guesses a scale.
        self.assertIsNone(proxy.cargar_rollo("PHercC", source)["voxel_um"])
        self.assertIsNone(proxy.cargar_rollo("PHercA")["voxel_um"])

    def test_manifest_and_gzip_negotiation_reject_bad_input(self):
        source = MagicMock()
        source.indice.return_value = {}
        with self.assertRaises(ValueError):
            proxy.manifest_bytes.__wrapped__(source, None)
        self.assertFalse(proxy.accepts_gzip("gzip;q=invalid"))
        self.assertFalse(proxy.accepts_gzip("gzip;q=0"))
        self.assertTrue(proxy.accepts_gzip("br, gzip"))

    def test_input_validation_atomic_json_and_mask_history(self):
        for value in (
            "https://host/a/../b",
            "ftp://host",
            "https://user:pass@host",
            "https://host/?q=1",
        ):
            with self.assertRaises(ValueError):
                url_http(value)
        for origin, kwargs in (
            ("", {}),
            ("s3://", {}),
            ("ftp://host", {}),
            (str(self.root), {"perfil": True}),
            (str(self.root), {"region": "x"}),
            (str(self.root), {"anotaciones": str(self.root / "missing")}),
        ):
            with self.subTest(origin=origin, kwargs=kwargs), self.assertRaises(ValueError):
                Fuente(origin, **kwargs)
        file = self.root / "atomic.json"
        file.write_text('{"old":true}')
        with (
            patch("ink_viewer.server.fuentes.os.replace", side_effect=OSError("disk failure")),
            self.assertRaises(OSError),
        ):
            guardar_json(file, {"new": True})
        self.assertEqual(json.loads(file.read_text()), {"old": True})
        self.assertEqual(list(self.root.iterdir()), [file])
        labels = self.root / "labels"
        labels.mkdir()
        source = Fuente(str(self.root), anotaciones=str(labels))
        source.guardar_mascara("x.png", b"old")
        source.guardar_mascara("x.png", b"new")
        self.assertEqual(source.mascara_local("x.png").read_bytes(), b"new")
        history = source.mascara_local("x.png").parent / ".history"
        self.assertEqual(next(history.iterdir()).read_bytes(), b"old")
        with self.assertRaises(PermissionError):
            Fuente(str(self.root)).guardar_mascara("x.png", b"x")

    def test_gate_export_rejects_unbound_and_conflicting_receipts(self):
        tasks = self.root / "tasks"
        receipts = self.root / "receipts"
        meta = self.root / "segments/s/mesh/tifxyz/meta.json"
        meta.parent.mkdir(parents=True)
        meta.write_text("{}")
        import hashlib

        digest = {"meta.json": hashlib.sha256(meta.read_bytes()).hexdigest()}
        (self.root / "segments/s/catalog-entry.json").write_text(
            json.dumps({"mesh_inputs_sha256": digest})
        )
        task = {
            "unidad": "u",
            "sha": digest,
            "etiqueta": {
                "aliases": [
                    {"segment_id": "../bad", "sha": digest},
                    {"segment_id": "missing", "sha": digest},
                    {"segment_id": "s", "sha": digest},
                ]
            },
        }
        tasks.write_text(json.dumps(task) + "\n")
        receipt = {
            "unidad": "u",
            "sha_entradas": digest,
            "capa": "0",
            "estado": "PASS",
            "metricas": {"area_cm2": 8},
        }
        receipts.write_text(
            json.dumps(receipt) + "\n" + json.dumps(dict(receipt, estado="FAIL")) + "\n"
        )
        with self.assertRaises(ValueError):
            gates.export(self.root, tasks, receipts)
        receipts.write_text(json.dumps(dict(receipt, sha_entradas={})) + "\n")
        self.assertFalse(gates.export(self.root, tasks, receipts)["laminas"])
        output = self.root / "output.json"
        with patch.object(gates, "__name__", "test-fixture"):
            import runpy
            import sys

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "export",
                        "--catalogo",
                        str(self.root),
                        "--tareas",
                        str(tasks),
                        "--filas",
                        str(receipts),
                        "--salida",
                        str(output),
                    ],
                ),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                runpy.run_module("ink_viewer.catalog.exportar_compuertas", run_name="__main__")
        self.assertEqual(json.loads(output.read_text())["laminas"], {})
