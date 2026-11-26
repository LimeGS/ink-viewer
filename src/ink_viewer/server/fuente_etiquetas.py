"""``--source ink-labels``: VSkinox's Herculaneum ink-label dataset on Hugging Face, ready to review and correct.

The dataset (https://huggingface.co/datasets/vincentl065/herculaneum-ink-labels, CC BY-NC 4.0) holds 512 px squares on
the 9.362 µm surface grid: ``<scroll>/<segment>/<entry>/`` with the CT surface layers (``layers.zarr``, 21 layers) and
labels in five styles (0 sure background, 1 sure ink, 2 ignore, 255 outside papyrus). ``entries.csv`` lists every entry
with its quality (1-5) and role (reference / machine_1um / machine).

The viewer reads it like any catalog, with nothing to prepare:
- every entry is one series, ``catalog/<sample>/segments/<entry>/``; its depth frames are the CT layers, decoded from the
  zarr chunks on request (``ink-detection/ct-c±NN.png`` and the 1/4 and 1/8 thumbnails beside it);
- opening Label on an entry with no saved pair loads the dataset label as the viewer's mask pair, exactly the
  dataset's own training conversion: inklabels = (v == 1) * 255, supervision_mask = (v in {0, 1}) * 255. Corrections
  are saved as ordinary pairs in the annotations folder; the dataset itself is never written.

VISOR_INKLABELS_STYLE picks the style (A by default), VISOR_INKLABELS_URL another copy of the dataset (a local folder or
HTTP root with the same layout), VISOR_INKLABELS_CACHE the index cache (~/.cache/ink-viewer/ink-labels).
"""

import contextlib
import csv
import io
import json
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path

from ink_viewer.server.fuentes import Fuente, guardar_json, ruta_dentro

INK_LABELS = "ink-labels"
DATASET = "https://huggingface.co/datasets/vincentl065/herculaneum-ink-labels/resolve/main"
CACHED = ("_viewer/manifest.json", "_viewer/index-info.json")
SURFACE = (
    11  # surface layer of the 21 stored ones (``surface_layer_in_this_array`` in each layers.zarr)
)
LAYERS = 21
PNG_META = "vesuvius:mascara_corrida"
CT = re.compile(
    r"(?P<sample>[^/]+)/segments/(?P<entry>[^/]+)/ink-detection/(?:downsampled/)?ct-c(?P<c>[+-]\d+)"
    r"(?:-ds(?P<scale>[48])\.jpg|\.png)"
)
PAIR = re.compile(
    r"(?P<sample>[^/]+)/segments/(?P<entry>[^/]+)/labels/por-profundidad/(?P=entry)/c(?P<c>[+-]\d+)/"
    r"(?P=entry)_(?P<member>inklabels|supervision_mask)\.png"
)


def cache_dir():
    return Path(
        os.environ.get("VISOR_INKLABELS_CACHE") or Path.home() / ".cache/ink-viewer/ink-labels"
    ).expanduser()


def sample_id(scroll):
    """Viewer sample id for a dataset scroll folder: PHercParis4_Scroll1 -> PHercParis4, Fragments -> PHercFragments."""
    head = re.sub(r"[^A-Za-z0-9]", "", scroll.split("_")[0])
    return head if head.startswith("PHerc") else "PHerc" + head


def frame(sample, entry, c):
    return f"../catalog/{sample}/segments/{entry}/ink-detection/ct-c{c:+03d}"


def construir(rows):
    """(manifest, report, paths) for the rows of entries.csv; paths maps each entry to its folder in the dataset."""
    manifest, paths, problems = [], {}, []
    for row in rows:
        entry, path = row.get("entry") or "", row.get("path") or ""
        if not re.fullmatch(r"[A-Za-z0-9][\w.-]*", entry) or not path or entry in paths:
            problems.append({"entry": entry, "reason": "Invalid or duplicated entry name"})
            continue
        sample = sample_id(row.get("scroll") or "")
        quality, role, family = (
            row.get("quality") or "?",
            row.get("role") or "?",
            row.get("family") or "?",
        )
        frames = {str(c): frame(sample, entry, c) for c in range(-SURFACE, LAYERS - SURFACE)}
        paths[entry] = path
        manifest.append(
            {
                "id": "inklabels_" + entry,
                "scroll": sample,
                "label": f"Ink labels · {row.get('scroll')} · {row.get('segment')} · {family} · q{quality} · {role}",
                "frames": frames,
                "frameContrasts": {f: ["fixed"] for f in frames.values()},
                "availableContrasts": ["fixed"],
                "catalogMeta": {
                    "lam": entry,
                    "modelo": f"q{quality}-{role}-{family}",
                    "cara": "unknown",
                    "scroll": sample,
                    "fam": "Ink labels (VSkinox)",
                    "depthKnown": True,
                    "physicalScaleVerified": True,
                    "projectionOnly": False,
                },
                "mapAvailable": True,
                "renderGrid": None,
                "sourceDirectory": f"{sample}/segments/{entry}/ink-detection",
                "maskAvailable": True,
                "maskPaths": [],
                "meshAssociation": {
                    "status": "UNVERIFIED",
                    "meshId": row.get("segment") or "",
                    "meshPath": "",
                    "receiptPath": "",
                    "basis": "ink-labels dataset entry",
                },
                "inkLabels": {
                    "scroll": row.get("scroll"),
                    "segment": row.get("segment"),
                    "entry": entry,
                    "path": path,
                    "family": family,
                    "quality": quality,
                    "role": role,
                },
            }
        )
    report = {
        "schema": "vesuvius.viewer-index.v1",
        "layout": "catalog",
        "scroll": None,
        "source": "entries.csv",
        "series": len(manifest),
        "maps": len(manifest),
        "depths": len(manifest) * LAYERS,
        "problems": problems,
    }
    return manifest, report, paths


class FuenteEtiquetas(Fuente):
    def __init__(self, origen=INK_LABELS, perfil="", endpoint="", region="", anotaciones=""):
        if (origen or "").strip().lower() != INK_LABELS:
            raise ValueError("FuenteEtiquetas only serves --source ink-labels")
        super().__init__(
            os.environ.get("VISOR_INKLABELS_URL") or DATASET, perfil, endpoint, region, anotaciones
        )
        self.cache = cache_dir()
        self.max_age = float(os.environ.get("VISOR_INKLABELS_MAX_AGE_HOURS") or 24) * 3600
        self.style = (os.environ.get("VISOR_INKLABELS_STYLE") or "A").upper()
        if self.style not in "ABCD" or len(self.style) != 1:
            raise ValueError("VISOR_INKLABELS_STYLE must be A, B, C or D")
        self.paths, self._layers, self._layers_lock = {}, OrderedDict(), threading.Lock()

    def config(self):
        return dict(super().config(), origen=INK_LABELS)

    def info(self):
        info = self.indice("_viewer/index-info.json") if (self.cache / CACHED[1]).is_file() else {}
        return dict(
            super().info(),
            dataset=self.origen,
            generated=info.get("generated"),
            series=info.get("series"),
            style=self.style,
        )

    def preparar(self, force=False):
        """Make sure a usable index exists; rebuild it from entries.csv when missing or stale."""
        manifest = self.cache / CACHED[0]
        if (
            manifest.is_file()
            and not force
            and time.time() - manifest.stat().st_mtime < self.max_age
        ):
            self._cargar_rutas()
            return False
        try:
            with super().abrir("entries.csv") as (_, _, body):
                rows = list(csv.DictReader(io.StringIO(body.read(64 * 2**20).decode("utf-8-sig"))))
            entries, report, paths = construir(rows)
            if not entries:
                raise ValueError("entries.csv lists no entries")
        except Exception as e:
            if manifest.is_file():
                self._cargar_rutas()
                return False
            raise ValueError(
                f"Could not build the ink-labels index from {self.origen}/entries.csv: {e}"
            ) from e
        report["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        report["dataset"] = self.origen
        guardar_json(self.cache / "_viewer/paths.json", paths)
        guardar_json(manifest, entries)
        guardar_json(self.cache / CACHED[1], report)
        self.paths = paths
        return True

    def _cargar_rutas(self):
        path = self.cache / "_viewer/paths.json"
        self.paths = json.loads(path.read_text()) if path.is_file() else {}

    def verificar(self):
        self.preparar()
        return super().verificar()

    def indice(self, name, limite=16 * 2**20):
        if name in CACHED:
            path = self.cache / name
            return json.loads(path.read_text()) if path.is_file() else {}
        return super().indice(name, limite)

    # --- the dataset, read through the parent source -------------------------------------------------------------------

    def _carpeta(self, entry):
        path = self.paths.get(entry)
        if not path:
            raise FileNotFoundError(entry)
        return path

    def _leer(self, rel, limit=64 * 2**20):
        with super().abrir(rel, zarr_meta=rel.endswith((".zarray", ".zattrs"))) as (_, _, body):
            data = body.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f"{rel} is larger than expected")
        return data

    def capas(self, entry):
        """The entry's CT layers as a (layers, h, w) uint8 array, decoded from its zarr chunks; None without layers."""
        import urllib.error

        with self._layers_lock:
            if entry in self._layers:
                self._layers.move_to_end(entry)
                return self._layers[entry]
        import numcodecs
        import numpy as np

        root = self._carpeta(entry) + "/layers.zarr/"
        try:
            meta = json.loads(self._leer(root + ".zarray", 2**20))
        except (FileNotFoundError, urllib.error.HTTPError) as e:
            if getattr(e, "code", 404) != 404:
                raise
            return None
        try:
            attrs = json.loads(self._leer(root + ".zattrs", 2**20))
        except (FileNotFoundError, urllib.error.HTTPError, ValueError):
            attrs = {}
        shape, chunks = meta["shape"], meta["chunks"]
        if (
            len(shape) != 3
            or meta.get("dtype") != "|u1"
            or shape[0] * shape[1] * shape[2] > 64 * 2**20
        ):
            raise ValueError("Unexpected layers.zarr: expected (layers, height, width) uint8")
        codec = numcodecs.get_codec(meta["compressor"]) if meta.get("compressor") else None
        sep = meta.get("dimension_separator", ".")
        out = np.full(shape, meta.get("fill_value") or 0, np.uint8)
        for k in range(0, shape[0], chunks[0]):
            for y in range(0, shape[1], chunks[1]):
                for x in range(0, shape[2], chunks[2]):
                    key = sep.join(str(v) for v in (k // chunks[0], y // chunks[1], x // chunks[2]))
                    try:
                        raw = self._leer(root + key)
                    except (FileNotFoundError, urllib.error.HTTPError) as e:
                        if getattr(e, "code", 404) != 404:
                            raise
                        continue
                    block = np.frombuffer(codec.decode(raw) if codec else raw, np.uint8).reshape(
                        chunks
                    )
                    view = out[k : k + chunks[0], y : y + chunks[1], x : x + chunks[2]]
                    view[...] = block[: view.shape[0], : view.shape[1], : view.shape[2]]
        result = (out, int(attrs.get("surface_layer_in_this_array", SURFACE)))
        with self._layers_lock:
            self._layers[entry] = result
            while len(self._layers) > 16:
                self._layers.popitem(last=False)
        return result

    def etiqueta(self, entry):
        """The chosen label style as a 2D uint8 array of classes 0/1/2/255."""
        import numpy as np
        from PIL import Image

        with Image.open(
            io.BytesIO(self._leer(self._carpeta(entry) + f"/labels/style_{self.style}.png"))
        ) as image:
            return np.asarray(image.convert("L"))

    def capa_png(self, entry, c, scale=1):
        """Image bytes of one CT layer (offset c from the surface); an entry without layers shows its label instead."""
        from PIL import Image

        layers = self.capas(entry)
        if layers is None:
            label = self.etiqueta(entry)
            image = Image.fromarray(
                ((label == 1) * 200 + (label == 0) * 60 + (label == 2) * 110).astype("uint8")
            )
        else:
            stack, surface = layers
            index = surface + c
            if not 0 <= index < stack.shape[0]:
                raise FileNotFoundError(f"layer {c:+d} not in this entry")
            image = Image.fromarray(stack[index])
        stream = io.BytesIO()
        if scale == 1:
            image.save(stream, format="PNG")
        else:
            image.resize(
                (max(1, image.width // scale), max(1, image.height // scale)), Image.BILINEAR
            ).save(stream, format="JPEG", quality=85)
        return stream.getvalue()

    def par(self, sample, entry, c, member):
        """One member of the dataset label as a viewer mask pair, with the run metadata the viewer validates."""
        import numpy as np
        from PIL import Image, PngImagePlugin

        label = self.etiqueta(entry)
        values = (label == 1) if member == "inklabels" else np.isin(label, (0, 1))
        info = {
            "lamina": entry,
            "segmento": entry,
            "base": f"{sample}/segments/{entry}",
            "rollo": sample,
            "ancho": int(label.shape[1]),
            "alto": int(label.shape[0]),
            "profundidad": c,
            "origen": f"ink-labels dataset style {self.style}",
            "dataset_path": self._carpeta(entry),
        }
        meta = PngImagePlugin.PngInfo()
        meta.add_itxt(PNG_META, json.dumps(info))
        stream = io.BytesIO()
        Image.fromarray((values * 255).astype(np.uint8)).save(stream, format="PNG", pnginfo=meta)
        return stream.getvalue()

    @contextlib.contextmanager
    def abrir(self, rel, rango=None, head=False, zarr_meta=False):
        if rel in CACHED:
            path = ruta_dentro(self.cache, rel)
            if not path.is_file():
                raise FileNotFoundError(rel)
            with path.open("rb") as body:
                yield (
                    200,
                    {
                        "Content-Length": str(path.stat().st_size),
                        "Content-Type": "application/json",
                    },
                    body,
                )
            return
        ct, pair = CT.fullmatch(rel), PAIR.fullmatch(rel)
        if ct or pair:
            m = ct or pair
            if m["entry"] not in self.paths:
                raise FileNotFoundError(rel)
            if ct:
                scale = int(ct["scale"] or 1)
                data, kind = (
                    self.capa_png(m["entry"], int(m["c"]), scale),
                    "image/png" if scale == 1 else "image/jpeg",
                )
            else:
                data, kind = (
                    self.par(m["sample"], m["entry"], int(m["c"]), pair["member"]),
                    "image/png",
                )
            yield (
                200,
                {"Content-Length": str(len(data)), "Content-Type": kind},
                io.BytesIO(b"" if head else data),
            )
            return
        with super().abrir(rel, rango, head, zarr_meta) as response:
            yield response
