#!/usr/bin/env python3
"""Index official sample/catalog roots without modifying any scientific input."""

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

from ink_viewer.catalog.catalog_names import parse
from ink_viewer.server.fuentes import Fuente, guardar_json

MESH_FILES = ("x.tif", "y.tif", "z.tif", "meta.json")
SAMPLE = re.compile(r"PHerc[A-Za-z0-9]+")


def join(*parts):
    return "/".join(p for p in parts if p)


def render_grid_de(doc):
    """Propagate only a content-bound grid; old receipts keep their unknown binding."""
    receipt = doc.get("render_receipt")
    grid = doc.get("render_grid") or (
        receipt.get("render_grid") if isinstance(receipt, dict) else None
    )
    if grid is None:
        return None

    def normalize(v):
        if isinstance(v, dict):
            return {k: normalize(x) for k, x in v.items()}
        if isinstance(v, list):
            return [normalize(x) for x in v]
        if type(v) is float and math.isfinite(v) and v.is_integer():
            return int(v)
        return v

    if not isinstance(grid, dict) or grid.get("schema") != "vesuvius.render-grid.v1":
        raise ValueError("Invalid render grid schema")
    raw = json.dumps(
        normalize({k: v for k, v in grid.items() if k != "grid_id"}),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode()
    if grid.get("grid_id") != hashlib.sha256(raw).hexdigest():
        raise ValueError("Render grid identity does not match its receipt")
    return grid


def construir(source, scroll=None, verificar_mallas=False):
    top = source.listado()
    directories = {name for name, directory in top if directory}
    base = ""
    if "segments" in directories:
        inferred = Path(unquote(urlsplit(source.origen).path)).name
        scroll = scroll or inferred
        if not SAMPLE.fullmatch(scroll):
            raise ValueError(
                "A folder holding segments/ needs a PHerc... name or --scroll PHerc..."
            )
        layout, samples = "sample", [(scroll, "")]
    else:
        if "catalog" in directories:
            base, layout = "catalog", "docroot"
        else:
            layout = "catalog"
        samples = [
            (name, join(base, name))
            for name, directory in source.listado(base)
            if directory and SAMPLE.fullmatch(name) and (not scroll or name == scroll)
        ]
        if not samples:
            raise ValueError("The source has no segments/ or PHerc... folders")
        scroll = None
    report = {
        "schema": "vesuvius.viewer-index.v1",
        "layout": layout,
        "scroll": scroll,
        "samples": {},
        "problems": [],
        "series": 0,
        "maps": 0,
        "depths": 0,
        "verified": 0,
    }
    manifest, hash_cache = [], {}

    def digest(rel):
        if rel not in hash_cache:
            h = hashlib.sha256()
            with source.abrir(rel) as (_, _, body):
                for block in iter(lambda: body.read(4 * 2**20), b""):
                    h.update(block)
            hash_cache[rel] = h.hexdigest()
        return hash_cache[rel]

    for sample, prefix in samples:
        segments = [
            name for name, directory in source.listado(join(prefix, "segments")) if directory
        ]
        inventory = {
            "segments": len(segments),
            "segments_with_maps": 0,
            "segments_without_maps": [],
            "volumes": [n for n, _ in source.listado(join(prefix, "volumes"))],
            "representations": [n for n, _ in source.listado(join(prefix, "representations"))],
        }
        report["samples"][sample] = inventory
        for seg in segments:
            ink = join(prefix, "segments", seg, "ink-detection")
            groups = {}
            entries = source.listado(ink)
            names = {name for name, directory in entries if not directory}
            for name, directory in entries:
                if directory or not name.lower().endswith((".png", ".tif", ".tiff")):
                    continue
                fields = parse(name)
                if not fields or fields["sample"] != sample or fields["segment"] != seg:
                    report["problems"].append(
                        {
                            "path": join(ink, name),
                            "reason": "Unrecognized or conflicting ink-map name",
                        }
                    )
                    continue
                stem = re.sub(r"(?:-c[+-]\d+)?(?:-global)?\.(?:png|tiff?)$", "", name, flags=re.I)
                groups.setdefault((stem, fields["extension"].lower()), []).append((name, fields))
            if groups:
                inventory["segments_with_maps"] += 1
            else:
                inventory["segments_without_maps"].append(seg)
            masks = []
            labels = join(prefix, "segments", seg, "labels", "por-profundidad", seg)
            for centre, directory in source.listado(labels):
                if directory and re.fullmatch(r"c[+-]\d+", centre):
                    masks.extend(
                        join(labels, centre, name)
                        for name, directory in source.listado(join(labels, centre))
                        if not directory and name.endswith("_inklabels.png")
                    )
            for (stem, extension), files in sorted(groups.items()):
                head = files[0][1]
                virtual = f"../catalog/{sample}/segments/{seg}/ink-detection/"
                frames, contrasts, maximum = {}, {}, None
                for name, fields in files:
                    frame = virtual + re.sub(r"-global(?=\.)", "", name)
                    if extension == "png":
                        frame = frame[:-4]
                    contrasts.setdefault(frame, set()).add(fields["contrast"])
                    if fields["centre"] is None:
                        maximum = frame
                    else:
                        frames[str(fields["centre"])] = frame
                projection_only = not frames
                if projection_only:
                    frames["0"] = maximum
                receipt_rel = join(ink, stem + ".json")
                try:
                    doc = source.indice(receipt_rel)
                    if not isinstance(doc, dict):
                        raise ValueError("Receipt must be an object")
                except Exception as e:
                    report["problems"].append({"path": receipt_rel, "reason": str(e)[:200]})
                    doc = {}
                mesh_rel = join(prefix, "segments", seg, "mesh", "tifxyz")
                expected = f"{sample}/segments/{seg}/mesh/tifxyz"
                claimed = doc.get("mesh_inputs_sha256")
                claimed = claimed if isinstance(claimed, dict) else {}
                declared = doc.get("files")
                declared = declared if isinstance(declared, list) else []
                for name in declared:
                    if (
                        isinstance(name, str)
                        and "/" not in name
                        and parse(name)
                        and name not in names
                    ):
                        report["problems"].append(
                            {
                                "path": join(ink, name),
                                "reason": "Map declared in receipt is missing",
                            }
                        )
                verified = False
                basis = "discovered files; mesh not verified"
                if verificar_mallas:
                    association = (
                        doc.get("schema") == "helena.ink-run.v1"
                        and doc.get("sample") == sample
                        and doc.get("segment") == seg
                        and doc.get("stem") == stem
                        and str(doc.get("catalog_mesh", "")).endswith("/" + expected)
                        and all(name in declared for name, _ in files)
                    )
                    try:
                        verified = bool(
                            association
                            and all(
                                claimed.get(n) and digest(join(mesh_rel, n)) == claimed[n]
                                for n in MESH_FILES
                            )
                        )
                    except Exception as e:
                        report["problems"].append({"path": mesh_rel, "reason": str(e)[:200]})
                    basis = (
                        "render receipt and mesh SHA-256"
                        if verified
                        else "receipt absent, conflicting or mesh SHA-256 not matched"
                    )
                modes = sorted(set().union(*contrasts.values()))
                try:
                    grid = render_grid_de(doc)
                except (ValueError, TypeError) as e:
                    report["problems"].append({"path": receipt_rel, "reason": str(e)[:200]})
                    continue
                recipe = doc.get("recipe")
                direction = recipe.get("direction") if isinstance(recipe, dict) else None
                face = (
                    "fwd"
                    if direction == ["forward"]
                    else "rev"
                    if direction == ["reverse"]
                    else "unknown"
                )
                meta = {
                    "lam": seg,
                    "modelo": head["model"],
                    "cara": face,
                    "scroll": sample,
                    "fam": "Official catalog",
                    "depthKnown": not projection_only,
                    "physicalScaleVerified": False,
                    "projectionOnly": False,
                }
                entry = {
                    "id": "catalog_"
                    + hashlib.sha256(
                        (sample + "/" + seg + "/" + stem + "." + extension).encode()
                    ).hexdigest()[:20],
                    "scroll": sample,
                    "label": f"Catalog · {sample} · {seg} · {head['model']}",
                    "frames": frames,
                    "frameContrasts": {k: sorted(v) for k, v in contrasts.items()},
                    "availableContrasts": modes,
                    "catalogMeta": meta,
                    "mapAvailable": True,
                    "renderGrid": grid,
                    "sourceDirectory": join(ink, stem),
                    "maskAvailable": bool(masks),
                    "maskPaths": masks,
                    "meshAssociation": {
                        "status": "VERIFIED" if verified else "UNVERIFIED",
                        "meshId": seg,
                        "meshPath": "../catalog/" + expected,
                        "receiptPath": "../catalog/"
                        + sample
                        + "/segments/"
                        + seg
                        + "/ink-detection/"
                        + stem
                        + ".json",
                        "basis": basis,
                    },
                }
                # A lone public prediction has undocumented depth, not necessarily a maximum projection.
                if maximum and not projection_only:
                    entry["maximum"] = maximum
                manifest.append(entry)
                report["maps"] += len(files)
                report["depths"] += 0 if projection_only else len(frames)
                report["verified"] += verified
    report["series"] = len(manifest)
    report["segments"] = sum(v["segments"] for v in report["samples"].values())
    report["segments_with_maps"] = sum(v["segments_with_maps"] for v in report["samples"].values())
    return manifest, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--source",
        "--origen",
        dest="origen",
        required=True,
        help="sample folder, catalog root or s3://bucket/prefix",
    )
    ap.add_argument("--scroll", help="explicit sample for a renamed folder, or catalog filter")
    ap.add_argument(
        "--output",
        "--salida",
        dest="salida",
        help="local root for _viewer/ outputs; required for S3 (then publish both files yourself)",
    )
    ap.add_argument("--s3-profile", "--s3-perfil", dest="s3_perfil", default="")
    ap.add_argument("--s3-endpoint", default="")
    ap.add_argument("--s3-region", default="")
    ap.add_argument(
        "--verify-meshes",
        "--verificar-mallas",
        dest="verificar_mallas",
        action="store_true",
        help="read/hash mesh inputs against render receipts; may be expensive",
    )
    ap.add_argument("--dry-run", action="store_true", help="scan and print counts, without writing")
    ap.add_argument(
        "--replace",
        "--reemplazar",
        dest="reemplazar",
        action="store_true",
        help="explicitly replace an existing generated index",
    )
    a = ap.parse_args(argv)
    try:
        source = Fuente(a.origen, a.s3_perfil, a.s3_endpoint, a.s3_region)
        output = (
            Path(a.salida or source.origen).expanduser().resolve()
            if source.tipo == "local" or a.salida
            else None
        )
        if not a.dry_run and output is None:
            raise ValueError("S3 needs --output; index an HTTP source on the server's disk")
        if (
            output
            and not a.reemplazar
            and not a.dry_run
            and any((output / "_viewer" / n).exists() for n in ("manifest.json", "index-info.json"))
        ):
            raise ValueError("A generated index already exists; use --replace to regenerate it")
        manifest, report = construir(source, a.scroll, a.verificar_mallas)
        if not a.dry_run:
            guardar_json(output / "_viewer" / "manifest.json", manifest)
            guardar_json(output / "_viewer" / "index-info.json", report)
        summary = {k: v for k, v in report.items() if k not in ("samples", "problems")}
        summary["segments_without_maps"] = report["segments"] - report["segments_with_maps"]
        summary["problems"] = len(report["problems"])
        summary["output"] = str(output / "_viewer") if output and not a.dry_run else None
        print(json.dumps(summary, indent=2))
    except (OSError, ValueError) as e:
        ap.error(str(e))


if __name__ == "__main__":
    main()
