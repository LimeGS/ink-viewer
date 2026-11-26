"""Build inventories from disposable files, including corrupt and missing evidence."""

import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from ink_viewer.catalog import vast_catalog as catalog
from test_manifest import fixture


class VastCatalogBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.site = self.root / "site"
        self.roots = [self.root / "operations", self.root / "hcnet", self.root / "absent"]
        for root in self.roots[:2]:
            root.mkdir()
        self.canonical = self.root / "canonical"
        self.canonical.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(catalog, "ROOTS", self.roots).start()
        patch.object(catalog, "CANONICAL", self.canonical).start()

    def image(self, path, value=111):
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("L", (8, 4), value).save(path)
        return path

    def doc(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return path

    def test_receipts_masks_missing_outputs_and_mesh_resources(self):
        image = self.image(self.roots[0] / "run/map_on_CT.png")
        manifest = self.doc(
            self.roots[0] / "input.json",
            {"files": [{"path": str(self.roots[0] / "PHercA.tifxyz/x.tif"), "sha256": "a" * 64}]},
        )
        self.doc(
            image.with_name("map.json"),
            {
                "scroll": "PHercA",
                "segment": "s",
                "centre": 2,
                "direction": "forward",
                "input_manifest": {"path": str(manifest)},
                "orientation": "declared",
                "outputs": {image.name: "0" * 64, "missing.png": "1" * 64},
                "files": [{"path": "another-missing.jpg", "sha256": "2" * 64}],
            },
        )
        self.image(self.roots[1] / "model/result.jpg")
        self.doc(self.roots[1] / "model/receipt.json", {"roll": "invalid!", "depth": "unknown"})
        self.image(self.roots[0] / "published-map.tif")
        self.image(self.roots[0] / "node_modules/ignored.png")
        bad = self.roots[0] / "corrupt.png"
        bad.write_bytes(b"not an image")
        bad.with_suffix(".json").write_text("{invalid")
        self.doc(self.roots[0] / "published-map.json", ["not a receipt"])
        masks = self.roots[0] / "annotation/labels/s/c+02"
        self.image(masks / "I.png", 255)
        self.image(masks / "S.png", 255)
        self.doc(self.roots[0] / "annotation/provenance/original/source.json", {"original": True})
        for name in ("x.tif", "y.tif", "z.tif"):
            self.image(self.roots[0] / "PHercA.tifxyz" / name)
        self.doc(self.roots[0] / "PHercA.tifxyz/meta.json", {"scroll": "PHercA"})
        (self.roots[0] / "missing.tifxyz").mkdir()
        before = {
            str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for root in self.roots[:2]
            for p in root.rglob("*")
            if p.is_file()
        }
        report = catalog.build(self.site)
        registry = json.loads((self.site / "cache/_viewer/vast-assets.json").read_text())
        runs = json.loads((self.site / "cache/_viewer/manifest.json").read_text())
        pairs = json.loads((self.site / "cache/catalog/_viewer/canonical-masks.json").read_text())[
            "records"
        ]
        self.assertEqual(registry["assets"][str(image)]["state"], "HASH_MISMATCH")
        self.assertEqual(registry["assets"][str(bad)]["state"], "UNREADABLE")
        self.assertEqual(registry["assets"][str(image.parent / "missing.png")]["state"], "MISSING")
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["depth"], 2)
        self.assertEqual(pairs[0]["unit"], "I/S")
        self.assertTrue(pairs[0]["localEvidence"]["original_metadata"])
        self.assertEqual(report["mesh_entries"], 2)
        self.assertTrue(any(e["error"] == "Root absent" for e in report["errors"]))
        self.assertTrue(any(r["localEvidence"].get("mesh_files_declared") for r in runs))
        self.assertTrue(any(r["scroll"] == "unknown" for r in runs))
        self.assertFalse(any("ignored.png" in r["label"] for r in runs))
        for path, digest in before.items():
            self.assertEqual(catalog.sha(path), digest)
        self.assertTrue(catalog.allowed(image))
        self.assertFalse(catalog.allowed(self.root / "outside"))
        self.assertFalse(report["new_inference"])
        self.assertEqual(report["source_copies"], 0)

    def test_canonical_build_retains_registration_errors_and_measured_scores(self):
        catalog.build(self.site)
        sample, stem, _ = fixture(self.canonical)
        ink = sample / "segments/shared/ink-detection"
        receipt = ink / (stem + ".json")
        document = json.loads(receipt.read_text())
        document["model"] = {"name": "base"}
        document["scores"] = {"v5": {"max": 0.8, "modelo": "base"}}
        receipt.write_text(json.dumps(document))
        self.doc(
            sample / "segments/shared/catalog-entry.json",
            {"mesh_inputs_sha256": {"meta.json": "f" * 64}},
        )
        (sample / "segments/public/catalog-entry.json").write_text("{broken")
        (sample / "segments/plain-file").write_text("not a segment")
        (self.canonical / "PHercEmpty").mkdir()
        (sample / "segments/link").symlink_to(sample / "segments/shared", target_is_directory=True)
        rd = ink / (stem + ".receipts") / "run"
        self.doc(rd / "ok.json", {"evidence": "unchanged"})
        (rd / "broken.json").write_text("{broken")
        missing_stem = stem + "-c+02-global"
        self.image(ink / "downsampled" / (missing_stem + "-ds4.jpg"))
        original = catalog.build_v5_index
        with (
            patch.object(
                catalog, "build_v5_index", side_effect=lambda runs: original(runs, self.canonical)
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            catalog.build_canonical(self.site)
        registry = json.loads((self.site / "cache/_viewer/vast-assets.json").read_text())
        scores = json.loads((self.site / "cache/_viewer/legibilidad-auto.json").read_text())
        runs = json.loads((self.site / "cache/_viewer/manifest.json").read_text())
        report = json.loads((self.site / "coverage.json").read_text())
        self.assertEqual(report["canonical_segments"], 3)
        self.assertEqual(scores["laminas"]["shared"]["max"], 0.8)
        self.assertTrue(report["canonical_errors"])
        shared = next(r for r in runs if r["catalogMeta"]["lam"] == "shared")
        self.assertTrue(shared["localEvidence"]["run_receipts"])
        self.assertFalse(shared["localEvidence"]["automatic_orientation_transform"])
        missing = registry["assets"][str(ink / (missing_stem + ".png"))]
        self.assertEqual(missing["state"], "MISSING")
        self.assertTrue(missing["preview"].endswith("-ds4.jpg"))
        self.assertFalse((self.canonical / "_viewer").exists())
        self.assertEqual(catalog.quote_path("catalog/a b/c+0.png"), "catalog/a%20b/c%2B0.png")
