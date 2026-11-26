"""Cross-sections: a CT slice through a map point with the segment's mesh drawn on it.

A curve that follows the layering is a surface sitting on a sheet; one that cuts across it has crossed to the next
sheet. Ported from Volumen's cortes.py (Paulo Sergio Camillo, MIT): one axial (z) slice, a window around the point,
the mesh crossing of that slice as an ordered curve.

Layout (public bucket and its local copies): ``<sample>/segments/<seg>/mesh/<seg-id>-on-<volume>-<res>um.tifxyz/``
(one mesh per CT volume, ``meta.json`` scale = grid step per map pixel) and ``<sample>/volumes/<volume>-*.zarr``. They are read from the map source, or from ``--ct-origen`` when given (a
local copy of the maps rarely holds the CT; the public bucket over HTTPS does)
(level 0 read chunk by chunk through the viewer's Fuente). Sources that cannot list (HTTP) use the deterministic public
names, built from the map name's resolution, distance and energy. The map names its volume (``-volume-<id>-``), so the mesh
and the CT are the ones the map was rendered from. Needs numpy, tifffile and numcodecs (extra ``corte``).
"""

import io
import json
import math
import re
import threading
import urllib.error
from collections import OrderedDict

MESH = re.compile(r".+-on-(?P<volume>\d{14})-(?P<res>\d+(?:\.\d+)?)um\.tifxyz")
VOLUME = re.compile(r"(?P<volume>\d{14})-.+\.zarr")
SAMPLE = re.compile(r"PHerc[A-Za-z0-9]+")
SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]*")
TAM, MAX_TAM, JUMP = 512, 1024, 60

_lock = threading.Lock()
_meshes, _chunks = OrderedDict(), OrderedDict()


def fuente_ct(origen):
    """Read-only source for meshes and CT (--ct-origen), laid out as a root of PHerc... folders; None if unset."""
    if not origen:
        return None
    from ink_viewer.server.fuentes import Fuente

    source = Fuente(origen)
    source.layout = "catalog"
    return source


def _cache(store, key, make, limit):
    with _lock:
        if key in store:
            store.move_to_end(key)
            return store[key]
    value = make()
    with _lock:
        store[key] = value
        while len(store) > limit:
            store.popitem(last=False)
    return value


def _read(fuente, rel, zarr_meta=False):
    with fuente.abrir(rel, zarr_meta=zarr_meta) as (_, _, body):
        return body.read()


def _check(sample, segment, volume):
    if (
        not SAMPLE.fullmatch(sample or "")
        or not SEGMENT.fullmatch(segment or "")
        or not re.fullmatch(r"\d{14}", volume or "")
    ):
        raise ValueError("Expected rollo, segmento and a 14-digit volumen")


def _listado(fuente, base):
    """Directory listing, or None when the source cannot list (HTTP)."""
    try:
        return fuente.listado(base)
    except ValueError:
        return None


def malla_rel(fuente, sample, segment, volume, res=None):
    base = fuente.ruta_catalogo(f"catalog/{sample}/segments/{segment}/mesh")
    entries = _listado(fuente, base)
    if entries is None and res:  # no listing: the public naming is deterministic
        return f"{base}/{segment[:14]}-on-{volume}-{res}um.tifxyz"
    for name, directory in entries or []:
        m = MESH.fullmatch(name)
        if directory and m and m["volume"] == volume:
            return base + "/" + name
    raise FileNotFoundError(f"No mesh of {segment} on volume {volume}")


def volumen_rel(fuente, sample, volume, res=None, dist=None, kev=None):
    base = fuente.ruta_catalogo(f"catalog/{sample}/volumes")
    entries = _listado(fuente, base)
    if entries is None and res and dist and kev:
        return f"{base}/{volume}-{res}um-{dist}m-{kev}keV-masked.zarr"
    for name, directory in entries or []:
        m = VOLUME.fullmatch(name)
        if directory and m and m["volume"] == volume:
            return base + "/" + name
    raise FileNotFoundError(f"No CT volume {volume} in {sample}/volumes")


def malla(fuente, rel):
    """(x, y, z, valid, scale) of a tifxyz mesh; cached per source and path."""

    def make():
        import numpy as np
        import tifffile

        xyz = [
            tifffile.imread(io.BytesIO(_read(fuente, f"{rel}/{c}.tif"))).astype(np.float64)
            for c in "xyz"
        ]
        meta = json.loads(_read(fuente, f"{rel}/meta.json"))
        scale = [float(s) for s in meta.get("scale", [1, 1])]
        valid = (xyz[0] > 0) & (xyz[1] > 0) & (xyz[2] > 0)  # -1 sentinel
        return (*xyz, valid, scale)

    return _cache(_meshes, (fuente.id, rel), make, 8)


def punto(mesh, u, v, w=None, h=None):
    """Map pixel (u, v) -> (x, y, z) voxel by bilinear interpolation on the mesh grid.

    The grid step per map pixel is the mesh scale; when the map size is given and does not match grid/scale within
    2 %, the map is taken to span the grid proportionally instead (returned flag 'proportional')."""
    x, y, z, valid, (sx, sy) = mesh
    H, W = valid.shape
    proportional = bool(
        w and h and (abs(w * sx - (W - 1)) > 0.02 * W + 1 or abs(h * sy - (H - 1)) > 0.02 * H + 1)
    )
    gj, gi = (
        (u * (W - 1) / max(w - 1, 1), v * (H - 1) / max(h - 1, 1))
        if proportional
        else (u * sx, v * sy)
    )
    if not (0 <= gi <= H - 1 and 0 <= gj <= W - 1):
        raise ValueError("The point is outside the mesh")
    i0, j0 = min(int(gi), H - 2), min(int(gj), W - 2)
    ti, tj = gi - i0, gj - j0
    corners = [
        (i0, j0, (1 - ti) * (1 - tj)),
        (i0 + 1, j0, ti * (1 - tj)),
        (i0, j0 + 1, (1 - ti) * tj),
        (i0 + 1, j0 + 1, ti * tj),
    ]
    good = [(i, j, wgt) for i, j, wgt in corners if valid[i, j]]
    if not good:
        raise ValueError("No mesh at this point")
    total = sum(wgt for _, _, wgt in good)
    if total < 1e-9:  # only zero-weight corners are valid: take one of them as is
        good, total = [(good[0][0], good[0][1], 1.0)], 1.0
    p = [sum(a[i, j] * wgt for i, j, wgt in good) / total for a in (x, y, z)]
    return p, proportional


def curva(mesh, z_target):
    """Ordered curve where the mesh crosses slice z_target, one crossing per grid column (from Volumen)."""
    import numpy as np

    x, y, z, valid, _ = mesh
    H, W = z.shape
    out = []
    for j in range(W):
        for i in range(H - 1):
            if not (valid[i, j] and valid[i + 1, j]):
                continue
            a0, a1 = z[i, j], z[i + 1, j]
            if (a0 - z_target) * (a1 - z_target) > 0:
                continue
            t = 0.0 if abs(a1 - a0) < 1e-6 else (z_target - a0) / (a1 - a0)
            out.append(
                (x[i, j] + t * (x[i + 1, j] - x[i, j]), y[i, j] + t * (y[i + 1, j] - y[i, j]))
            )
            break
    return np.asarray(out, dtype=np.float64).reshape(-1, 2)


def _array_meta(fuente, rel):
    return _cache(
        _chunks,
        (fuente.id, rel, "meta"),
        lambda: json.loads(_read(fuente, rel + "/0/.zarray", True)),
        4096,
    )


def ventana(fuente, rel, zi, y0, y1, x0, x1):
    """Level-0 values of plane zi over [y0, y1) x [x0, x1); chunks decoded with numcodecs, absent = fill_value."""
    import numpy as np

    meta = _array_meta(fuente, rel)
    shape, chunks, dtype = meta["shape"], meta["chunks"], np.dtype(meta["dtype"])
    sep, fill = meta.get("dimension_separator", "."), meta.get("fill_value") or 0
    if meta.get("order", "C") != "C" or meta.get("filters"):
        raise ValueError("Only C-order zarr v2 arrays without filters are supported")
    out = np.full((y1 - y0, x1 - x0), fill, dtype)
    cz = zi // chunks[0]

    def chunk(key):
        def make():
            try:
                raw = _read(fuente, f"{rel}/0/{key}")
            except FileNotFoundError:
                return None
            except urllib.error.HTTPError as e:
                if e.code in (403, 404):
                    return None
                raise
            if meta.get("compressor"):
                import numcodecs

                raw = numcodecs.get_codec(meta["compressor"]).decode(raw)
            return np.frombuffer(raw, dtype).reshape(chunks)

        return _cache(_chunks, (fuente.id, rel, key), make, 256)

    for cy in range(y0 // chunks[1], math.ceil(y1 / chunks[1])):
        for cx in range(x0 // chunks[2], math.ceil(x1 / chunks[2])):
            block = chunk(sep.join(map(str, (cz, cy, cx))))
            if block is None:
                continue
            by0, bx0 = cy * chunks[1], cx * chunks[2]
            ya, yb = max(y0, by0), min(y1, by0 + chunks[1], shape[1])
            xa, xb = max(x0, bx0), min(x1, bx0 + chunks[2], shape[2])
            out[ya - y0 : yb - y0, xa - x0 : xb - x0] = block[
                zi - cz * chunks[0], ya - by0 : yb - by0, xa - bx0 : xb - bx0
            ]
    return out, shape


def corte_png(
    fuente, sample, segment, volume, u, v, w=None, h=None, tam=TAM, res=None, dist=None, kev=None
):
    """PNG of the CT slice at the point's z, window `tam` voxels, mesh curve in orange, point in cyan."""
    import numpy as np
    from PIL import Image, ImageDraw

    _check(sample, segment, volume)
    for value in (res, dist, kev):
        if value is not None and not re.fullmatch(r"\d+(?:\.\d+)?", str(value)):
            raise ValueError("res, dist and kev are numbers")
    tam = max(64, min(int(tam), MAX_TAM))
    mesh = malla(fuente, malla_rel(fuente, sample, segment, volume, res))
    (px, py, pz), proportional = punto(mesh, float(u), float(v), w and int(w), h and int(h))
    rel = volumen_rel(fuente, sample, volume, res, dist, kev)
    shape = _array_meta(fuente, rel)["shape"]
    zi = int(round(pz))
    if not 0 <= zi < shape[0]:
        raise ValueError("The point lies outside the CT volume")
    half = tam // 2
    y0, y1 = max(0, int(py) - half), min(shape[1], int(py) + half)
    x0, x1 = max(0, int(px) - half), min(shape[2], int(px) + half)
    a, _ = ventana(fuente, rel, zi, y0, y1, x0, x1)
    a = a.astype(np.float32)
    nz = a[a > 0]
    lo, hi = np.percentile(nz, [2, 99]) if nz.size else (0.0, 1.0)
    img = Image.fromarray(
        (np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)
    ).convert("RGB")
    d = ImageDraw.Draw(img)
    uv = curva(mesh, zi) - [x0, y0]
    for (u0, v0), (u1, v1) in zip(uv[:-1], uv[1:]):
        if abs(u1 - u0) > JUMP or abs(v1 - v0) > JUMP:
            continue  # a hole in the mesh, not a stroke
        d.line([u0, v0, u1, v1], fill=(255, 150, 20), width=2)
    cx, cy = px - x0, py - y0
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], outline=(40, 220, 255), width=2)
    d.text((6, 6), f"{segment} · volume {volume}", fill=(255, 255, 255))
    d.text(
        (6, img.size[1] - 16),
        f"z={zi}  x={x0}..{x1}  y={y0}..{y1}"
        + ("  (map-to-mesh: proportional)" if proportional else ""),
        fill=(255, 255, 255),
    )
    stream = io.BytesIO()
    img.save(stream, format="PNG")
    return stream.getvalue(), {
        "x": px,
        "y": py,
        "z": pz,
        "window": [x0, x1, y0, y1],
        "proportional": proportional,
    }
