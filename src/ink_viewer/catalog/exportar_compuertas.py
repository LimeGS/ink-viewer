"""Export existing layer receipts to the viewer; never runs scientific controls."""

import argparse
import hashlib
import json
import math
from pathlib import Path


def state(row):
    return {"PASS": True, "FAIL": False}.get((row or {}).get("estado"))


def lines(path):
    with path.open() as f:
        yield from f


def gates(rows):
    area = (rows.get("0", {}).get("metricas") or {}).get("area_cm2")
    continuity = state(rows.get("8"))
    return {
        "geometry_ok": state(rows.get("7")),
        "physical_ok": state(rows.get("3")),
        "ct_ok": state(rows.get("1")),
        "plano_ok": state(rows.get("2")),
        "cm2": area
        if isinstance(area, (int, float)) and math.isfinite(area) and area >= 0
        else None,
        "continuidad": {"veredicto": "PASA" if continuity else "NO_PASA"}
        if continuity is not None
        else {},
        "layer_states": {k: r["estado"] for k, r in rows.items()},
    }


def export(catalog, tasks, receipts):
    candidates = {}
    for line in lines(tasks):
        t = json.loads(line)
        for alias in t.get("etiqueta", {}).get("aliases", []):
            seg, sha = alias.get("segment_id"), alias.get("sha")
            if not seg or Path(seg).name != seg or sha != t.get("sha"):
                continue
            base = catalog / "segments" / seg
            try:
                entry = json.loads((base / "catalog-entry.json").read_text())
                if entry.get("mesh_inputs_sha256") != sha:
                    continue
                if hashlib.sha256(
                    (base / "mesh/tifxyz/meta.json").read_bytes()
                ).hexdigest() != sha.get("meta.json"):
                    continue
            except (OSError, ValueError):
                continue
            candidates.setdefault(t["unidad"], []).append((seg, sha))
    grouped = {}
    for line in lines(receipts):
        r = json.loads(line)
        for seg, sha in candidates.get(r.get("unidad"), []):
            if r.get("sha_entradas") != sha or r.get("capa") not in ("0", "1", "2", "3", "7", "8"):
                continue
            layers = grouped.setdefault(seg, {})
            key = r["capa"]
            if key in layers and layers[key]["estado"] != r["estado"]:
                raise ValueError("Conflicting receipts: " + seg + " layer " + key)
            layers[key] = r
    return {
        "schema": "vesuvius.viewer-gates.v1",
        "source": str(receipts),
        "binding": "receipt SHA-256 matches catalog-entry; current metadata SHA-256 checked; XYZ not rehashed",
        "laminas": {
            seg: dict(gates(rows), run_id=next(iter(rows.values())).get("run_id"))
            for seg, rows in grouped.items()
        },
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--catalogo", type=Path, required=True)
    ap.add_argument("--tareas", type=Path, required=True)
    ap.add_argument("--filas", type=Path, required=True)
    ap.add_argument("--salida", type=Path, required=True)
    a = ap.parse_args()
    data = export(a.catalogo, a.tareas, a.filas)
    with a.salida.open("x") as f:
        json.dump(data, f)
    print(json.dumps({"segments_with_controls": len(data["laminas"]), "output": str(a.salida)}))
