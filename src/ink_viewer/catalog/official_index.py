"""Viewer index for the Vesuvius Challenge open-data bucket, built from the bucket's own metadata.json.

The team publishes metadata.json at the bucket root: every sample, segment and data item with its path, model id
and provenance. Ink maps are items of type ``ink-detection`` under
``<sample>/segments/<segment folder>/ink-detection/<catalog name>.tif``, with ``ink-detection-downsampled``
previews beside them. This module turns those items into viewer manifest entries; it reads nothing else and
never touches the bucket itself.
"""

import hashlib
import re

from ink_viewer.catalog.catalog_names import parse

BUCKET = "s3://vesuvius-challenge-open-data"
SCHEMA = "vesuvius.viewer-index.v1"
INK = "ink-detection"
PREVIEW = "ink-detection-downsampled"
EXTENSION = re.compile(r"(?:-c[+-]\d+)?(?:-global)?\.(?:png|tiff?)$", re.I)


def bucket_paths(item):
    """Paths of an item that live in the open-data bucket (older items may point to other hosts)."""
    out = []
    for origin in item.get("origins") or []:
        roots = origin.get("access_roots") or []
        if isinstance(origin.get("path"), str) and any(
            r.get("url") == BUCKET for r in roots if isinstance(r, dict)
        ):
            out.append(origin["path"])
    return out


def provenance(item):
    creation = item.get("creation_info") or {}
    prov = creation.get("provenance") or {}
    params = prov.get("parameters") or {}
    return {
        "created": creation.get("date"),
        "direction": params.get("direction"),
        "checkpoint": params.get("checkpoint"),
        "model_id": (item.get("parameters") or {}).get("model_id"),
        "target_volume": (item.get("parameters") or {}).get("target_volume"),
    }


def construir_oficial(meta):
    """Return (manifest, report, previews) for every ink map published in the open-data bucket.

    previews maps a full-resolution map path to its published 1/8 JPEG, so thumbnails need not decode the TIFF.
    """
    samples = meta.get("samples") if isinstance(meta, dict) else None
    if not isinstance(samples, dict):
        raise ValueError("metadata.json without samples")
    models = meta.get("models") if isinstance(meta.get("models"), dict) else {}
    manifest, previews = [], {}
    report = {
        "schema": SCHEMA,
        "layout": "catalog",
        "scroll": None,
        "source": "metadata.json",
        "samples": {},
        "problems": [],
        "series": 0,
        "maps": 0,
        "depths": 0,
        "verified": 0,
    }
    for sample_id, sample in sorted(samples.items()):
        segments = sample.get("segments") if isinstance(sample, dict) else None
        if not isinstance(segments, dict):
            continue
        inventory = {
            "segments": len(segments),
            "segments_with_maps": 0,
            "segments_without_maps": [],
        }
        for segment_id, segment in sorted(segments.items()):
            items = segment.get("data") if isinstance(segment, dict) else None
            items = items if isinstance(items, list) else []
            jpgs = {
                p
                for it in items
                if isinstance(it, dict) and it.get("type") == PREVIEW
                for p in bucket_paths(it)
            }
            meshes = [
                p
                for it in items
                if isinstance(it, dict) and it.get("type") == "tifxyz"
                for p in bucket_paths(it)
            ]
            found = 0
            for item in items:
                if not isinstance(item, dict) or item.get("type") != INK:
                    continue
                for path in bucket_paths(item):
                    parts = path.split("/")
                    if (
                        len(parts) != 5
                        or parts[0] != sample_id
                        or parts[1] != "segments"
                        or parts[3] != INK
                    ):
                        report["problems"].append(
                            {"path": path, "reason": "Unexpected ink-map location"}
                        )
                        continue
                    folder, name = parts[2], parts[4]
                    fields = parse(name)
                    if not fields or fields["kind"] != "map" or fields["sample"] != sample_id:
                        report["problems"].append(
                            {"path": path, "reason": "Unrecognized ink-map name"}
                        )
                        continue
                    stem = EXTENSION.sub("", name)
                    frame = f"../catalog/{sample_id}/segments/{folder}/{INK}/" + re.sub(
                        r"-global(?=\.)", "", name
                    )
                    if fields["extension"].lower() == "png":
                        frame = frame[:-4]
                    jpg = f"{sample_id}/segments/{folder}/{INK}/downsampled/{stem}-ds8.jpg"
                    if jpg in jpgs:
                        previews[path] = jpg
                    info = provenance(item)
                    model = models.get(str(info["model_id"]), {}) if info["model_id"] else {}
                    face = {"forward": "fwd", "reverse": "rev"}.get(info["direction"], "unknown")
                    centre = fields["centre"]
                    frames = {"0" if centre is None else str(centre): frame}
                    mesh = (
                        meshes[0].rstrip("/")
                        if meshes
                        else f"{sample_id}/segments/{folder}/mesh/tifxyz"
                    )
                    entry = {
                        "id": "official_" + hashlib.sha256(path.encode()).hexdigest()[:20],
                        "scroll": sample_id,
                        "label": f"Official · {sample_id} · {folder} · {fields['model']}",
                        "frames": frames,
                        "frameContrasts": {frame: [fields["contrast"]]},
                        "availableContrasts": [fields["contrast"]],
                        "catalogMeta": {
                            "lam": folder,
                            "modelo": fields["model"],
                            "cara": face,
                            "scroll": sample_id,
                            "fam": "Official catalog",
                            "depthKnown": centre is not None,
                            "physicalScaleVerified": False,
                            "projectionOnly": False,
                        },
                        "mapAvailable": True,
                        "renderGrid": None,
                        "sourceDirectory": f"{sample_id}/segments/{folder}/{INK}/{stem}",
                        "maskAvailable": False,
                        "maskPaths": [],
                        "meshAssociation": {
                            "status": "UNVERIFIED",
                            "meshId": folder,
                            "meshPath": "../catalog/" + mesh,
                            "receiptPath": "",
                            "basis": "official metadata.json; mesh not verified",
                        },
                        "official": dict(
                            info,
                            path=path,
                            segment_id=segment_id,
                            model_name=model.get("suffix") or fields["model"],
                        ),
                    }
                    manifest.append(entry)
                    report["maps"] += 1
                    report["depths"] += centre is not None
                    found += 1
            if found:
                inventory["segments_with_maps"] += 1
            else:
                inventory["segments_without_maps"].append(segment_id)
        if inventory["segments_with_maps"]:
            report["samples"][sample_id] = inventory
    report["series"] = len(manifest)
    report["segments"] = sum(v["segments"] for v in report["samples"].values())
    report["segments_with_maps"] = sum(v["segments_with_maps"] for v in report["samples"].values())
    return manifest, report, previews
