"""Read immutable mask versions exclusively from a published local catalog index."""

import hashlib
import json
from pathlib import Path

INDEX = "catalog/_viewer/canonical-masks.json"
_cache = {}


def inventory(source):
    if not source or source.tipo != "local":
        return None
    path = (
        source.vast_index_root / "_viewer/canonical-masks.json"
        if hasattr(source, "vast_index_root")
        else Path(source.origen) / INDEX
    )
    if not path.exists():
        return None
    stat = path.stat()
    key = (str(path), stat.st_ino, stat.st_mtime_ns, stat.st_size)
    if key not in _cache:
        value = json.loads(path.read_text())
        if value.get("schema") != "canonical-masks.v1":
            raise ValueError("Invalid canonical mask inventory")
        value["by_id"] = {r["id"]: r for r in value["records"]}
        _cache.clear()
        _cache[key] = value
    return _cache[key]


def asset_path(source, asset):
    if hasattr(source, "vast_asset_path"):
        return source.vast_asset_path(asset)
    root = (Path(source.origen) / "catalog").resolve()
    path = Path(asset["canonical"]).resolve(strict=True)
    rel = path.relative_to(root)
    parts = rel.parts
    allowed = (len(parts) >= 5 and parts[1] == "segments" and parts[3] == "labels") or (
        len(parts) >= 4 and parts[0] == "_unresolved" and parts[2] == "labels"
    )
    if not allowed:
        raise ValueError("Mask path is outside canonical labels")
    return path


def read_asset(source, asset):
    body = asset_path(source, asset).read_bytes()
    if len(body) != asset["bytes"] or hashlib.sha256(body).hexdigest() != asset["sha256"]:
        raise ValueError("Canonical mask changed since inventory publication")
    return body


def select(source, roll, segment, depth, proposal=False):
    data = inventory(source)
    if data is None:
        return None
    found = [
        r
        for r in data["records"]
        if r["roll"] == roll
        and r.get("segment") == segment
        and r.get("depth") == (None if depth == "max" else depth)
        and len(r["assets"]) == 2
        and r.get("unit") != "filesystem_metadata"
    ]
    if proposal:
        found = [
            r for r in found if "auto" in r.get("type", "").lower() or "propuesta" in r.get("I", "")
        ]
    # Repeated origin references do not make duplicate versions in the picker.
    unique = {}
    for r in found:
        unique.setdefault(tuple(a["sha256"] for a in r["assets"]), r)
    return list(unique.values())


def public_record(r):
    return {
        k: r.get(k)
        for k in (
            "id",
            "roll",
            "segment",
            "depth",
            "depth_declared",
            "declared_surface",
            "series",
            "type",
            "association",
        )
    } | {
        "assets": [
            {
                "role": a["role"],
                "bytes": a["bytes"],
                "sha256": a["sha256"],
                "format": Path(a["canonical"]).suffix.lower(),
                "url": "/api/mascaras-canonicas/" + r["id"] + "/" + a["role"],
            }
            for a in r["assets"]
        ],
        "overlay_qualified": False,
    }


def zarr_inventory(source):
    if not source or source.tipo != "local":
        return {"records": []}
    path = Path(source.origen) / "catalog/_viewer/canonical-zarr-masks.json"
    return json.loads(path.read_text()) if path.exists() else {"records": []}


def zarr_preview(source, identity, depth):
    record = next((r for r in zarr_inventory(source)["records"] if r["id"] == identity), None)
    if record is None:
        raise FileNotFoundError("Unknown canonical Zarr mask")
    asset = next((a for a in record["previews"] if a["z"] == depth), None)
    if asset is None:
        raise ValueError("Depth outside canonical Zarr mask")
    return read_asset(source, asset)


def tiff_view(body, frame=None):
    import io

    from PIL import Image

    # Scientific masks have verified source hashes and may exceed Pillow's photo limit.
    Image.MAX_IMAGE_PIXELS = 1_000_000_000
    with Image.open(io.BytesIO(body)) as im:
        if frame is None:
            return {"frames": im.n_frames, "mode": im.mode, "size": list(im.size)}
        if frame < 0 or frame >= im.n_frames:
            raise ValueError("TIFF page outside file")
        im.seek(frame)
        if im.mode not in ("1", "L", "LA", "RGB", "RGBA", "I;16", "I;16B", "I;16L"):
            raise ValueError("TIFF mode cannot be displayed losslessly")
        output = io.BytesIO()
        im.save(output, format="PNG")
        return output.getvalue()
