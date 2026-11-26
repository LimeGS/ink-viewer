import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from ink_viewer.catalog.exportar_compuertas import export, gates


class Gates(unittest.TestCase):
    def test_pending_is_not_failed(self):
        g = gates(
            {
                "7": {"estado": "PASS"},
                "3": {"estado": "NOT_MEASURED"},
                "2": {"estado": "FAIL"},
                "8": {"estado": "NOT_APPLICABLE"},
                "0": {"estado": "PASS", "metricas": {"area_cm2": 1.5}},
            }
        )
        self.assertTrue(g["geometry_ok"])
        self.assertIsNone(g["physical_ok"])
        self.assertFalse(g["plano_ok"])
        self.assertEqual(g["continuidad"], {})
        self.assertEqual(g["cm2"], 1.5)

    def test_binding_rejects_changed_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segments/s"
            mesh = seg / "mesh/tifxyz"
            mesh.mkdir(parents=True)
            (mesh / "meta.json").write_bytes(b"{}")
            sha = {"meta.json": hashlib.sha256(b"{}").hexdigest()}
            (seg / "catalog-entry.json").write_text(json.dumps({"mesh_inputs_sha256": sha}))
            tasks = root / "tasks.jsonl"
            receipts = root / "rows.jsonl"
            tasks.write_text(
                json.dumps(
                    {
                        "unidad": "u",
                        "sha": sha,
                        "etiqueta": {"aliases": [{"segment_id": "s", "sha": sha}]},
                    }
                )
                + "\n"
            )
            receipts.write_text(
                json.dumps({"unidad": "u", "sha_entradas": sha, "capa": "7", "estado": "PASS"})
                + "\n"
            )
            self.assertTrue(export(root, tasks, receipts)["laminas"]["s"]["geometry_ok"])
            (mesh / "meta.json").write_bytes(b"changed")
            self.assertEqual(export(root, tasks, receipts)["laminas"], {})


if __name__ == "__main__":
    unittest.main()
