#!/usr/bin/env python3
"""Serve the viewer code independently from local, HTTP or S3 image sources.

Use --origen CARPETA|https://servidor/prefijo|s3://bucket/prefijo and optionally
--anotaciones CARPETA for validated annotation pairs. Source metadata is read from
rollos/<sample>/rollo.json or rollos/<sample>.json; unknown measurements stay unknown.
/api/origen can select and persist a source in --config. No image data is bundled.
"""

import argparse
import base64
import binascii
import gzip
import hashlib
import io
import json
import math
import os
import re
import secrets
import struct
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import ink_viewer.catalog.master_inventory as master
import ink_viewer.server.canonical_masks as canonical
import ink_viewer.server.corte as corte
import ink_viewer.server.inksdk_job as inksdk
from ink_viewer.paths import VIEWER_TOOLS, WEB_ROOT, web_asset
from ink_viewer.server.fuentes import Fuente, guardar_json, ruta_dentro
from ink_viewer.server.hf_sync import HFSync
from ink_viewer.server.tiff_header import tiff_dims, tiff_region

# Largest TIFF map decoded on the server, and largest sent at full resolution (a browser cannot hold gigapixel images;
# larger maps open as a reduced, browse-only view).
MAP_PIXELS = int(float(os.environ.get("VISOR_MAX_MAP_PIXELS") or 1e9))
# Full-resolution labeling keeps the map and its mask as canvases (~4 bytes/px each): Chrome refuses canvases
# over 2**28 px, and around 200 Mpx painting already lags, so larger maps open as the reduced, browse-only view.
FULLRES_PIXELS = int(float(os.environ.get("VISOR_MAX_FULLRES_PIXELS") or 1.5e8))


class MapTooLarge(ValueError):
    pass


CODE = WEB_ROOT
STATIC = {
    str(path.relative_to(CODE))
    for path in CODE.rglob("*")
    if path.is_file() and path.suffix in {".js", ".css", ".html", ".woff2", ".webp"}
}
LOG_FILE = None  # set by main() next to the --config file


# Optional metadata for paths without an explicit sample.
SCROLL = ROLLO = None
PORT = int(os.environ.get("S3CACHE_PORT", 8797))
# Listen address; keep loopback by default. The Docker image sets 0.0.0.0 and the
# host should publish the port on 127.0.0.1 only (writes are loopback-gated).
BIND = os.environ.get("S3CACHE_BIND", "127.0.0.1")
TYPES = {".png": "image/png", ".jpg": "image/jpeg"}
NO_SOURCE = "No data source: start with --source or choose one with Change source"
# Optional manifests the page always requests; they are empty unless a source provides them.
OPTIONAL_MANIFESTS = (
    "catalog/_viewer/manifest-work3.js",
    "all-gallery/derived-c019/manifest-c019-local.js",
)


def sample_de(rel):
    """Sample of a viewer path: catalog/<sample>/... or catalog/_unresolved/<sample>/...; None otherwise."""
    m = re.match(r"(?:\.\./)?catalog/_unresolved/([^/]+)/", rel)
    if m:
        return m.group(1)
    m = re.match(r"(?:\.\./)?catalog/([^/]+)/", rel)
    return m.group(1) if m and m.group(1) != "segments" else None


def cargar_rollo(scroll, fuente=None):
    """Physical metadata belongs to the selected dataset; no parent checkout is required."""
    if not re.fullmatch(r"PHerc[0-9A-Za-z]+", scroll or ""):
        raise ValueError("Invalid scroll identifier")
    for rel in (f"rollos/{scroll}/rollo.json", f"rollos/{scroll}.json"):
        info = fuente.indice(rel) if fuente else {}
        if info:
            if info.get("scroll") != scroll or not float(info.get("voxel_um", 0)) > 0:
                raise ValueError("Invalid physical metadata for the scroll")
            return info
    return {"scroll": scroll, "voxel_um": None}


MASK_LIMIT = 64 * 2**20
MASK_PIXELS = 64 * 2**20
PNG_META = "vesuvius:mascara_corrida"


def leer_mascara(body):
    """Decode real PNG pixels, including alpha, before any file is staged."""
    from PIL import Image, ImageChops

    if not 0 < len(body) <= MASK_LIMIT:
        raise ValueError("PNG empty or over 64 MiB")
    if (
        len(body) < 33
        or body[:8] != b"\x89PNG\r\n\x1a\n"
        or body[8:16] != b"\x00\x00\x00\x0dIHDR"
        or body[24] != 8
    ):
        raise ValueError("The mask must be an 8-bit PNG")
    try:
        with Image.open(io.BytesIO(body)) as image:
            if (
                image.format != "PNG"
                or image.mode not in ("L", "LA", "P", "RGB", "RGBA")
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError("The mask must be a 2D PNG of 8-bit classes")
            if image.width * image.height > MASK_PIXELS:
                raise ValueError("Mask over 64 megapixels")
            image.verify()
        with Image.open(io.BytesIO(body)) as image:
            image.load()
            raw = image.info.get(PNG_META)
            corrida = json.loads(raw) if raw else None
            if corrida is not None and not isinstance(corrida, dict):
                raise ValueError("Invalid PNG metadata")
            red, green, blue, alpha = image.convert("RGBA").split()
            if (
                alpha.getextrema() != (255, 255)
                or ImageChops.difference(red, green).getbbox()
                or ImageChops.difference(red, blue).getbbox()
            ):
                raise ValueError("The mask must be opaque grey: identical RGB channels")
            colors = red.getcolors(3)
            if colors is None or any(value not in (0, 255) for _, value in colors):
                raise ValueError("Invalid mask classes: only 0 and 255")
            return red, corrida
    except (OSError, SyntaxError, Image.DecompressionBombError) as e:
        raise ValueError("Invalid or incomplete PNG") from e


_TIFF_LOCAL = {"key": None, "path": None}
_TIFF_LOCAL_LOCK = threading.Lock()


def _tiff_local(fuente, rel, limit=256 * 2**20):
    """Local copy of the last TIFF map cropped: successive crops of a 254 MB official map download it once."""
    key = (fuente.id, rel)
    with _TIFF_LOCAL_LOCK:
        if (
            _TIFF_LOCAL["key"] == key
            and _TIFF_LOCAL["path"]
            and os.path.exists(_TIFF_LOCAL["path"])
        ):
            return _TIFF_LOCAL["path"]
        fd, part = tempfile.mkstemp(prefix="ink-viewer-crop-", suffix=".tif")
        try:
            with os.fdopen(fd, "wb") as out, fuente.abrir(rel) as (_, _, body):
                total = 0
                for block in iter(lambda: body.read(2**20), b""):
                    total += len(block)
                    if total > limit:
                        raise ValueError("TIFF map over 256 MiB")
                    out.write(block)
        except BaseException:
            os.unlink(part)
            raise
        if _TIFF_LOCAL["path"] and os.path.exists(_TIFF_LOCAL["path"]):
            os.unlink(_TIFF_LOCAL["path"])
        _TIFF_LOCAL.update(key=key, path=part)
        return part


def leer_recorte(params):
    """?recorte=x,y,w,h: a full-resolution window of a map too large to label whole (labeling by crop)."""
    raw = params.get("recorte", [None])[0]
    if raw is None:
        return None
    m = re.fullmatch(r"(\d{1,7}),(\d{1,7}),(\d{1,6}),(\d{1,6})", raw)
    if not m:
        raise ValueError("Crop must be x,y,width,height")
    x, y, w, h = map(int, m.groups())
    if not w or not h or w * h > MASK_PIXELS:
        raise ValueError(f"Crop must be 1 to {MASK_PIXELS} pixels")
    return {"x": x, "y": y, "ancho": w, "alto": h}


def validar_corrida(info, size, lamina, base, depth, rollo=None, recorte=None):
    if info is None:
        return
    if not isinstance(info, dict):
        raise ValueError("The run must be a JSON object")
    if any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in size):
        raise ValueError("Invalid run dimensions")
    if (
        any(type(info.get(key)) is not int for key in ("ancho", "alto"))
        or (info.get("ancho"), info.get("alto")) != size
    ):
        raise ValueError("Run and PNG dimensions differ")
    if (
        info.get("segmento") != lamina
        or not isinstance(info.get("lamina"), str)
        or not info["lamina"]
    ):
        raise ValueError("The run belongs to another lamina/segment")
    if info.get("base") and info["base"] != base:
        raise ValueError("The run belongs to another base")
    sample = base.split("/")[1] if base.startswith("_unresolved/") else base.split("/")[0]
    if (
        rollo
        and sample != rollo
        or info.get("rollo")
        and info["rollo"] != sample
        or info.get("scroll")
        and info["scroll"] != sample
    ):
        raise ValueError("The run belongs to another scroll")
    if (
        info.get("profundidad") != depth
        or depth != "max"
        and type(info.get("profundidad")) is not int
    ):
        raise ValueError("The run belongs to another depth")
    # A crop mask never stands in for the whole map, nor for another crop: its window is part of its identity.
    window = info.get("recorte")
    if (
        (recorte is None) != (window is None)
        or recorte
        and (not isinstance(window, dict) or {k: window.get(k) for k in recorte} != recorte)
    ):
        raise ValueError("The run belongs to another crop of this map")


def validar_par(inkbody, supbody, info, lamina, base, depth, rollo=None, recorte=None):
    from PIL import ImageChops

    ink, imeta = leer_mascara(inkbody)
    sup, smeta = leer_mascara(supbody)
    if ink.size != sup.size:
        raise ValueError("inklabels and supervision_mask dimensions differ")
    if ImageChops.subtract(ink, sup).getbbox():
        raise ValueError("Ink outside supervision_mask")
    if imeta != smeta or info is not None and imeta != info:
        raise ValueError("The PNG pair and its run have different metadata")
    corrida = info if info is not None else imeta
    validar_corrida(corrida, ink.size, lamina, base, depth, rollo, recorte)
    return corrida


def profundidad(params):
    value = params.get("c", ["max"])[0]
    if value == "max":
        return "max"
    if not re.fullmatch(r"[+-]?\d{1,6}", value):
        raise ValueError("Invalid depth")
    return int(value)


def ubicacion_par(lamina, base, depth, propuesta=False, recorte=None):
    if not re.fullmatch(r"[A-Za-z0-9][\w.-]*", lamina) or ".." in lamina:
        raise ValueError("Invalid lamina")
    prefix = f"catalog/{base}/labels/"
    # Each crop keeps its own pair beside the whole-map one, never on top of it.
    window = "/recorte-x{x}-y{y}-{ancho}x{alto}".format(**recorte) if recorte else ""
    if depth == "max":
        return prefix + "etiquetas/" + lamina + window
    return (
        prefix
        + "por-profundidad/"
        + ("_propuestas/" if propuesta else "")
        + f"{lamina}/c{depth:+03d}"
        + window
    )


def configurar(scroll=None, fuente=None):
    """Optionally pin a default scroll, used when a request names none."""
    global SCROLL, ROLLO
    ROLLO = cargar_rollo(scroll, fuente) if scroll else None
    SCROLL = ROLLO["scroll"] if ROLLO else None
    return {
        "scroll": SCROLL,
        "voxel_um": (ROLLO or {}).get("voxel_um"),
        "paso_hoja_um": (ROLLO or {}).get("paso_hoja_um"),
        "log": str(LOG_FILE) if LOG_FILE else "",
    }


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    if LOG_FILE:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")


def labels_base(lamina, base=None, rollo=None, fuente=None):
    """labels/ folder for a mask: the segment the viewer names (?base=<sample>/segments/<segment>, taken from
    the map's own catalog path), else the source's lamina index, else _unresolved/<rollo>. When the scroll is
    known, an index entry of another scroll is ignored, so a lamina name shared by two scrolls never lands
    in the other scroll's segment."""
    if base:
        if (
            not re.fullmatch(r"[A-Za-z0-9][\w.-]*/segments/[A-Za-z0-9][\w.-]*", base)
            or ".." in base
        ):
            raise ValueError("Invalid segment base")
        if rollo and base.split("/")[0] != rollo:
            raise ValueError("The base belongs to another scroll")
        return base
    rollo = rollo or SCROLL or None
    indexed = fuente.indice("lamina_labels_index.json").get(lamina)
    if indexed:
        owner = sample_de(indexed) or indexed.split("/")[0]
        if not rollo or owner == rollo:
            return indexed
    return f"_unresolved/{rollo or 'unknown'}"


@lru_cache(maxsize=2)
def manifest_bytes(source, revision):
    data = source.indice(source.manifest_rel, limite=256 * 2**20)
    if not isinstance(data, list):
        raise ValueError("The manifest must be a list")
    body = ("window.manifest=" + json.dumps(data, separators=(",", ":")) + ";\n").encode()
    return encoded_bytes(body)


def file_revision(path):
    # Cache key for the lru_cache readers below. Filesystem timestamps can be coarser
    # than their nanosecond fields (one kernel tick on many Linux setups), so two
    # same-size rewrites of one file within a tick can share a revision.
    stat = Path(path).stat()
    return stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size


def encoded_bytes(body):
    return body, gzip.compress(body, compresslevel=6, mtime=0), hashlib.sha256(body).hexdigest()


@lru_cache(maxsize=32)
def file_bytes(path, revision):
    return encoded_bytes(Path(path).read_bytes())


@lru_cache(maxsize=2)
def tools_bytes(parts):
    return encoded_bytes(
        b"\n;\n".join(
            b"/* " + Path(path).name.encode() + b" */\n" + Path(path).read_bytes()
            for path, revision in parts
        )
    )


def accepts_gzip(header):
    for item in header.lower().split(","):
        name, *params = item.strip().split(";")
        if name != "gzip":
            continue
        try:
            return all(float(p.split("=", 1)[1]) > 0 for p in params if p.strip().startswith("q="))
        except (ValueError, IndexError):
            return False
    return False


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # the viewer's index.html embeds the manifest: a cached copy hides freshly loaded laminae (14-sep)
        if self.path.split("?")[0].endswith((".html", ".js", ".json", ".css", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(CODE), **kw)

    def log_message(self, fmt, *args):
        pass  # log() records what matters; no per-request access log

    def _inesperado(self, error):
        """An unexpected failure: the client gets its message, the log keeps the traceback."""
        log(f"!! {self.command} {self.path}: {error!r}\n{traceback.format_exc().rstrip()}")
        return str(error)

    def do_HEAD(self):
        self.fuente = getattr(self.server, "fuente", None)
        if self._codigo(head=True):
            return
        if not self._host_local():
            return self.send_error(403)
        if not self.fuente:
            return self._sin_origen(head=True)
        return self._fuente_get(head=True)

    def _sin_origen(self, head=False):
        """No source yet: the page loads with an empty list and the source picker; data paths answer 503."""
        path = unquote(urlsplit(self.path).path).lstrip("/")
        if path == "all-gallery/manifest.js":
            return self._send_bytes(
                b"window.manifest=[];\n", "application/javascript", "none", head
            )
        if path in OPTIONAL_MANIFESTS:
            return self._send_bytes(
                b"// No source configured.\n", "application/javascript", "none", head
            )
        if path.startswith("api/"):
            return self._json({"error": NO_SOURCE}, 503)
        return self.send_error(503, NO_SOURCE)

    def _send_bytes(self, body, ctype, fuente, head=False, etag=None, gzipped=None):
        encoded = gzipped is not None and accepts_gzip(self.headers.get("Accept-Encoding", ""))
        if encoded:
            body = gzipped
        if etag:
            etag = '"' + etag + ("-gzip" if encoded else "") + '"'
        not_modified = etag and any(
            v.strip().removeprefix("W/") in (etag, "*")
            for v in self.headers.get("If-None-Match", "").split(",")
        )
        self.send_response(304 if not_modified else 200)
        if etag:
            self.send_header("ETag", etag)
        if gzipped is not None:
            self.send_header("Vary", "Accept-Encoding")
        if encoded:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Type", ctype)
        if not not_modified:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Fuente", fuente)
        self.end_headers()
        if not head and not not_modified:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _host_local(self):
        return self.headers.get("Host") in (
            f"127.0.0.1:{self.server.server_port}",
            f"localhost:{self.server.server_port}",
        )

    def _codigo(self, head=False):
        path = unquote(urlsplit(self.path).path).lstrip("/")
        if not path:
            self.send_response(302)
            self.send_header("Location", "/all-gallery/index.html")
            self.end_headers()
            return True
        name = path.removeprefix("all-gallery/") if path.startswith("all-gallery/") else path
        if path == "all-gallery/":
            name = "index.html"
        if name in ("viewer-tools.js", "js/viewer-tools.js"):
            parts = tuple(
                (str(CODE / web_asset(item)), file_revision(CODE / web_asset(item)))
                for item in VIEWER_TOOLS
            )
            body, compressed, etag = tools_bytes(parts)
            self._send_bytes(body, "application/javascript", "viewer-code", head, etag, compressed)
            return True
        if name not in STATIC:
            name = web_asset(name)
        if name not in STATIC:
            return False
        self._serve_file(CODE / name, head)
        return True

    def _origen_info(self):
        source = getattr(self.server, "fuente", None)
        info = (
            source.info()
            if source
            else {
                "tipo": "none",
                "id": "",
                "origen": "",
                "anotaciones": "",
                "perfil": "",
                "endpoint": "",
                "region": "",
                "escritura": False,
                "atomic_pair": False,
            }
        )
        sync = getattr(self.server, "hf_sync", None)
        return dict(
            info,
            hf=sync.info() if sync else None,
            canonical_masks=canonical.inventory(source) is not None,
            token=getattr(self.server, "config_token", ""),
            config=str(getattr(self.server, "config_path", "") or ""),
        )

    def _cambiar_origen(self):
        global LOG_FILE
        token = getattr(self.server, "config_token", None)
        if not token or not self._host_local() or self.headers.get("X-Visor-Config") != token:
            return self._json({"error": "Unauthorized configuration request"}, 403)
        if self.headers.get("Origin") not in (None, "http://" + self.headers["Host"]):
            return self._json({"error": "Unauthorized browser origin"}, 403)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if not 0 < n <= 16384 or self.headers.get_content_type() != "application/json":
                raise ValueError("Expected JSON configuration up to 16 KiB")
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or set(data) - {
                "origen",
                "perfil",
                "endpoint",
                "region",
                "anotaciones",
            }:
                raise ValueError("Invalid configuration fields")
            source = Fuente(**data)
            source.verificar()
            # Validate and persist before replacing the active source; failed changes leave it intact.
            with self.server.config_lock:
                current = getattr(self.server, "fuente", None)
                if self.headers.get("X-Visor-Origen", "") != (current.id if current else ""):
                    return self._json(
                        {"error": "Source changed in another tab; reload the viewer"}, 409
                    )
                if self.server.config_path:
                    guardar_json(self.server.config_path, source.config())
                    LOG_FILE = self.server.config_path.parent / "visor.log"
                self.server.fuente = source
            return self._json(self._origen_info())
        except (ValueError, TypeError, OSError) as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:
            return self._json({"error": self._inesperado(e)}, 502)

    def _fuente_archivo(self, rel, head=False):
        source = self.fuente
        canonical_data = canonical.inventory(source)
        if (
            canonical_data is not None
            and re.search(r"inklabels|supervision|mascara|mask|^(I|S)\.", Path(rel).name, re.I)
            and Path(rel).suffix.lower() in (".png", ".tif", ".tiff")
        ):
            try:
                canonical.asset_path(source, {"canonical": str(Path(source.origen) / rel)})
            except (ValueError, OSError):
                return self._json(
                    {"error": "Masks must be read from canonical catalog labels"}, 403
                )
        mask = (
            None
            if canonical_data is not None
            else source.mascara_local(rel)
            if rel.startswith("catalog/") and "/labels/" in rel
            else None
        )
        if mask:
            with source.mascara_lock:
                mask = source.mascara_local(rel)
                if mask.is_file():
                    with mask.open("rb") as body:
                        return self._fuente_stream(
                            200,
                            {
                                "Content-Length": str(mask.stat().st_size),
                                "Content-Type": self.guess_type(str(mask)),
                            },
                            body,
                            head,
                        )
        generated = inksdk.archivo_generado(source, rel)
        if generated:
            with generated.open("rb") as body:
                return self._fuente_stream(
                    200,
                    {
                        "Content-Length": str(generated.stat().st_size),
                        "Content-Type": self.guess_type(str(generated)),
                    },
                    body,
                    head,
                    fuente="ink-sdk",
                )
        candidates = source.rutas_visor(rel)
        for index, candidate in enumerate(candidates):
            try:
                with source.abrir(candidate, rango=self.headers.get("Range"), head=head) as (
                    status,
                    headers,
                    body,
                ):
                    return self._fuente_stream(status, headers, body, head)
            except (FileNotFoundError, urllib.error.HTTPError) as e:
                if getattr(e, "code", 404) != 404 or index == len(candidates) - 1:
                    raise

    def _mapa_tiff(self, rel, scale, head=False, recorte=None):
        if scale not in (1, 4, 8) or not re.fullmatch(
            r"catalog/[^/]+/segments/[^/]+/ink-detection/[^/]+\.tiff?", rel, re.I
        ):
            raise ValueError("Invalid TIFF path or scale")
        source_rel = self.fuente.ruta_catalogo(rel)
        if recorte:
            if scale != 1:
                raise ValueError("A crop is always full resolution")
            return self._recorte_tiff(source_rel, recorte, head)
        preview = getattr(self.fuente, "preview", None)

        def published(jpg):
            with self.fuente.abrir(jpg, head=head) as (status, headers, body):
                return self._fuente_stream(status, headers, body, head)

        # The official bucket publishes a 1/8 JPEG beside each map: thumbnails need not download the full TIFF.
        jpg = preview(source_rel, 8) if preview and scale == 8 else None
        if jpg:
            return published(jpg)
        try:
            pixels = math.prod(tiff_dims(self.fuente, source_rel))
        except (ValueError, OSError, struct.error):
            pixels = None  # unknown size: decode as before and let Pillow's limit decide
        if pixels and scale > 1 and pixels > MAP_PIXELS:
            # Too large to decode here: a 1/4 request (always a preview) gets the published 1/8 JPEG when there is one.
            jpg = preview(source_rel, 8) if preview else None
            if jpg:
                return published(jpg)
        if pixels and (pixels > FULLRES_PIXELS if scale == 1 else pixels > MAP_PIXELS):
            raise MapTooLarge(f"Map too large for this scale: {pixels / 1e6:.0f} Mpx at 1/{scale}")
        import warnings

        from PIL import Image

        # Whole-segment maps reach a few hundred megapixels (an official 2.4 um map is 14760 x 18520); allow them as
        # canonical_masks does. The byte cap below still bounds what is read.
        Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, MAP_PIXELS)
        # Only decode a requested 2D ink map, never CT volumes or TIFXYZ mesh coordinates.
        with tempfile.SpooledTemporaryFile(max_size=8 * 2**20) as image_file:
            with self.fuente.abrir(source_rel) as (_, _, body):
                total = 0
                for block in iter(lambda: body.read(2**20), b""):
                    total += len(block)
                    if total > 256 * 2**20:
                        raise ValueError("TIFF map over 256 MiB: generate PNG previews")
                    image_file.write(block)
            image_file.seek(0)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", Image.DecompressionBombWarning)
                image = Image.open(image_file)
            with image:
                if (
                    image.format != "TIFF"
                    or getattr(image, "n_frames", 1) != 1
                    or image.mode == "F"
                ):
                    raise ValueError(
                        "Only 2D integer TIFF is supported; export stacks or floating-point maps to PNG"
                    )
                if scale != 1:
                    image.thumbnail((max(1, image.width // scale), max(1, image.height // scale)))
                with tempfile.SpooledTemporaryFile(max_size=8 * 2**20) as output:
                    image.save(output, format="PNG")
                    length = output.tell()
                    output.seek(0)
                    return self._fuente_stream(
                        200,
                        {"Content-Length": str(length), "Content-Type": "image/png"},
                        output,
                        head,
                    )

    def _recorte_tiff(self, source_rel, recorte, head=False):
        """Full-resolution PNG of one window of a TIFF map, for labeling maps too large to label whole."""
        from PIL import Image

        x, y, w, h = (recorte[k] for k in ("x", "y", "ancho", "alto"))
        path = _tiff_local(self.fuente, source_rel)
        try:
            with open(path, "rb") as fh:
                array = tiff_region(fh, x, y, w, h)
            image = Image.fromarray(array)
        except ValueError as error:
            if "imagecodecs" in str(error):
                raise ValueError(
                    'This map\'s compression needs imagecodecs: pip install "ink-viewer[crop]"'
                ) from error
            raise
        except ImportError:
            # Without tifffile, Pillow decodes the whole map: fine below the decode limit, refused above it.
            width, height = tiff_dims(self.fuente, source_rel)
            if width * height > MAP_PIXELS:
                raise ValueError(
                    'Labeling by crop on maps this large needs tifffile: pip install "ink-viewer[crop]"'
                ) from None
            if x + w > width or y + h > height:
                raise ValueError(f"Crop {x},{y} {w}x{h} outside the {width}x{height} map") from None
            import warnings

            Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, MAP_PIXELS)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", Image.DecompressionBombWarning)
                with Image.open(path) as whole:
                    image = whole.crop((x, y, x + w, y + h))
        with tempfile.SpooledTemporaryFile(max_size=8 * 2**20) as output:
            image.save(output, format="PNG")
            length = output.tell()
            output.seek(0)
            return self._fuente_stream(
                200, {"Content-Length": str(length), "Content-Type": "image/png"}, output, head
            )

    def _fuente_stream(self, status, headers, body, head=False, fuente=None):
        etag = headers.get("ETag")
        if (
            status == 200
            and etag
            and any(
                value.strip().removeprefix("W/") in (etag, "*")
                for value in self.headers.get("If-None-Match", "").split(",")
            )
        ):
            self.send_response(304)
            for key in ("ETag", "Last-Modified", "Cache-Control"):
                if headers.get(key):
                    self.send_header(key, headers[key])
            self.end_headers()
            return
        self.send_response(status)
        for key in (
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "ETag",
            "Last-Modified",
            "Cache-Control",
        ):
            if headers.get(key):
                self.send_header(key, headers[key])
        self.send_header("X-Fuente", fuente or self.fuente.tipo)
        self.end_headers()
        if head:
            return
        remaining = int(headers.get("Content-Length", 2**63))
        while remaining:
            chunk = body.read(min(262144, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def _fuente_get(self, head=False):
        path = unquote(urlsplit(self.path).path).lstrip("/")
        params = parse_qs(urlsplit(self.path).query)
        optional = path.startswith("api/etiqueta/") and params.get("opcional") == ["1"]
        try:
            ruta_dentro(Path("/"), path)
            if path == "all-gallery/manifest.js" and self.fuente.manifest_rel:
                if self.fuente.tipo == "local":
                    stat = ruta_dentro(Path(self.fuente.origen), self.fuente.manifest_rel).stat()
                    revision = (stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
                    body, compressed, etag = manifest_bytes(self.fuente, revision)
                else:
                    body, compressed, etag = manifest_bytes.__wrapped__(self.fuente, None)
                extra = inksdk.manifest_generado(self.fuente)
                if extra:  # maps generated here by ink-sdk jobs live beside the annotations, never in the source
                    data = (
                        json.loads(body.decode()[len("window.manifest=") :].rstrip().rstrip(";"))
                        + extra
                    )
                    body, compressed, etag = encoded_bytes(
                        (
                            "window.manifest=" + json.dumps(data, separators=(",", ":")) + ";\n"
                        ).encode()
                    )
                return self._send_bytes(
                    body,
                    "application/javascript",
                    self.fuente.tipo,
                    head,
                    etag=etag,
                    gzipped=compressed,
                )
            if self.fuente.manifest_rel and path in OPTIONAL_MANIFESTS:
                return self._send_bytes(
                    b"// Generated index is authoritative.\n",
                    "application/javascript",
                    self.fuente.tipo,
                    head,
                )
            if path.startswith("api/mapa/"):
                return self._mapa_tiff(
                    path[len("api/mapa/") :],
                    int(params.get("escala", ["1"])[0]),
                    head,
                    leer_recorte(params),
                )
            if path == "api/inksdk":
                ok, why = inksdk.disponible()
                return self._json(
                    {
                        "disponible": ok,
                        "motivo": why,
                        "escritura": bool(self.fuente.anotaciones),
                        "perfiles": inksdk.perfiles() if ok else [],
                    }
                )
            if path == "api/inksdk/volumenes":
                vols = inksdk.volumenes(
                    self.fuente, params.get("rollo", [""])[0], params.get("segmento", [""])[0]
                )
                ok, _ = inksdk.disponible()
                profiles = inksdk.perfiles() if ok else []
                return self._json(
                    [
                        dict(
                            {k: v for k, v in v.items() if k != "rel"},
                            perfiles=[p["id"] for p in profiles if inksdk.compatible(p, v["res"])],
                        )
                        for v in vols
                    ]
                )
            if path == "api/inksdk/trabajos":
                return self._json(inksdk.TRABAJOS.lista())
            if path == "api/corte":
                q = {k: v[0] for k, v in params.items()}
                try:
                    body, info = corte.corte_png(
                        getattr(self.server, "ct_fuente", None) or self.fuente,
                        q.get("rollo"),
                        q.get("segmento"),
                        q.get("volumen"),
                        q.get("u", ""),
                        q.get("v", ""),
                        q.get("w"),
                        q.get("h"),
                        q.get("tam", corte.TAM),
                        q.get("res"),
                        q.get("dist"),
                        q.get("kev"),
                    )
                except ImportError as e:
                    return self._json(
                        {
                            "error": 'Cross-sections need numpy, tifffile and numcodecs (pip install ".[corte]"): '
                            + str(e)
                        },
                        501,
                    )
                except (ValueError, FileNotFoundError) as e:
                    return self._json(
                        {"error": str(e)}, 404 if isinstance(e, FileNotFoundError) else 400
                    )
                self.send_response(200)
                for k, v in (
                    ("Content-Type", "image/png"),
                    ("Content-Length", str(len(body))),
                    ("X-Corte", json.dumps(info)),
                    ("Cache-Control", "private, max-age=3600"),
                ):
                    self.send_header(k, v)
                self.end_headers()
                if not head:
                    self.wfile.write(body)
                return
            if path == "api/inventario":
                return self._json(master.listing(self.fuente, params))
            if path == "api/inventario-mapa":
                return self._json(master.map_request(self.fuente, params))
            if path == "api/inventario-overlay":
                return self._json(master.overlay(self.fuente, params, validar_par))
            if path == "api/inventario-display":
                return self._send_bytes(
                    master.display_asset(self.fuente, params, validar_par),
                    "image/png",
                    "canonical-display",
                    head,
                )
            if path == "api/inventario-nativa":
                if params.get("preview") == ["1"]:
                    return self._send_bytes(
                        master.native_info(self.fuente, params, True),
                        "image/png",
                        "canonical",
                        head,
                    )
                return self._json(master.native_info(self.fuente, params))
            if path.startswith("api/inventario/"):
                return self._json(master.detail(self.fuente, path.split("/")[-1]))
            if path == "api/mascaras-zarr":
                return self._json(canonical.zarr_inventory(self.fuente))
            if path.startswith("api/mascaras-zarr/"):
                _, _, identity, depth = path.split("/")
                return self._send_bytes(
                    canonical.zarr_preview(self.fuente, identity, int(depth)),
                    "image/png",
                    "canonical",
                    head,
                )
            if path == "api/mascaras-canonicas" or path.startswith("api/mascaras-canonicas/"):
                data = canonical.inventory(self.fuente)
                if data is None:
                    return self._json({"error": "Canonical inventory unavailable"}, 404)
                if path != "api/mascaras-canonicas":
                    _, _, identity, role = path.split("/")
                    record = data["by_id"].get(identity)
                    if not record:
                        return self._json({"error": "Unknown mask version"}, 404)
                    asset = next((a for a in record["assets"] if a["role"] == role), None)
                    if asset is None:
                        return self._json({"error": "Unknown mask role"}, 404)
                    body = canonical.read_asset(self.fuente, asset)
                    if Path(asset["canonical"]).suffix.lower() in (".tif", ".tiff"):
                        if params.get("metadata") == ["1"]:
                            return self._json(canonical.tiff_view(body))
                        if params.get("preview") == ["1"]:
                            return self._send_bytes(
                                canonical.tiff_view(body, int(params.get("frame", ["0"])[0])),
                                "image/png",
                                "canonical",
                                head,
                            )
                    return self._send_bytes(
                        body,
                        TYPES.get(Path(asset["canonical"]).suffix, "application/octet-stream"),
                        "canonical",
                        head,
                    )
                rows = [r for r in data["records"] if r.get("unit") != "filesystem_metadata"]
                roll = params.get("rollo", [None])[0]
                if roll:
                    rows = [r for r in rows if r["roll"] == roll]
                query = params.get("q", [""])[0].lower()
                if query:
                    rows = [
                        r
                        for r in rows
                        if query
                        in " ".join(
                            str(r.get(k, ""))
                            for k in (
                                "segment",
                                "declared_surface",
                                "depth",
                                "depth_declared",
                                "series",
                                "type",
                            )
                        ).lower()
                    ]
                offset = max(0, int(params.get("offset", ["0"])[0]))
                return self._json(
                    {
                        "total": len(rows),
                        "records": [
                            canonical.public_record(r) for r in rows[offset : offset + 100]
                        ],
                    }
                )
            if path == "api/propuestas":
                registry = canonical.inventory(self.fuente)
                if registry is not None:
                    return self._json(
                        sorted(
                            {
                                r["segment"]
                                for r in registry["records"]
                                if r.get("segment")
                                and (
                                    "auto" in r.get("type", "").lower()
                                    or "propuesta" in r.get("I", "")
                                )
                            }
                        )
                    )
                data = self.fuente.indice("propuestas.json")
                return self._json(sorted(data) if isinstance(data, list) else [])
            if path.startswith("api/dims/"):
                generated = inksdk.archivo_generado(self.fuente, path[len("api/dims/") :])
                if generated:
                    with generated.open("rb") as body:
                        hdr = body.read(24)
                elif re.search(r"\.tiff?$", path, re.I):
                    w, h = tiff_dims(
                        self.fuente, self.fuente.ruta_catalogo(path[len("api/dims/") :])
                    )
                    return self._json({"w": w, "h": h})
                else:
                    with self.fuente.abrir(
                        self.fuente.ruta_catalogo(path[len("api/dims/") :]), rango="bytes=0-23"
                    ) as (_, _, body):
                        hdr = body.read(24)
                if len(hdr) != 24 or hdr[:8] != b"\x89PNG\r\n\x1a\n":
                    raise ValueError("Not a PNG header")
                w, h = struct.unpack(">II", hdr[16:24])
                return self._json({"w": w, "h": h})
            if path.startswith("api/etiqueta/"):
                rel = path[len("api/etiqueta/") :]
                base = labels_base(
                    rel.split("/")[0],
                    params.get("base", [None])[0],
                    params.get("rollo", [None])[0],
                    self.fuente,
                )
                path = (
                    f"catalog/{base}/labels/por-profundidad/"
                    + ("_propuestas/" if params.get("propuesta") == ["1"] else "")
                    + rel
                )
            return self._fuente_archivo(path, head)
        except (FileNotFoundError, urllib.error.HTTPError) as e:
            code = getattr(e, "code", 404)
            if code == 404 and optional:
                self.send_response(204)
                self.end_headers()
                return
            if (
                (code == 404 or code == 403 and self.fuente.tipo == "s3")
                and path == "all-gallery/manifest.js"
                and not head
            ):
                try:
                    data = self.fuente.indice("all-gallery/manifest.json", limite=256 * 2**20)
                    if code == 403 and not isinstance(data, list):
                        return self.send_error(403, "S3 refused to read the manifest")
                    return self._send_bytes(
                        (
                            "window.manifest="
                            + json.dumps(data if isinstance(data, list) else [])
                            + ";\n"
                        ).encode(),
                        "application/javascript",
                        self.fuente.tipo,
                    )
                except Exception as ex:
                    return self.send_error(502, self._inesperado(ex))
            if code == 404 and path in OPTIONAL_MANIFESTS and not head:
                return self._send_bytes(
                    b"// Optional manifest absent.\n", "application/javascript", self.fuente.tipo
                )
            return self.send_error(
                code, "The file does not exist in the selected source" if code == 404 else str(e)
            )
        except ValueError as e:
            return self.send_error(400, str(e))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            return self.send_error(502, self._inesperado(e))

    def do_GET(self):
        self.fuente = getattr(self.server, "fuente", None)
        path = unquote(urlsplit(self.path).path).lstrip("/")
        if not self._host_local():
            return self.send_error(403)
        if path == "api/origen":
            return self._json(self._origen_info())
        if self._codigo():
            return
        if not self.fuente and path != "api/rollo.js":
            return self._sin_origen()
        if path.startswith("api/mascara-par/"):
            return self._leer_par(path[len("api/mascara-par/") :])
        if urlsplit(self.path).path == "/api/rollo.js":
            # Query metadata for the requested sample; no physical scale is guessed.
            q = parse_qs(urlsplit(self.path).query).get("rollo", [None])[0] or (
                self.fuente.scroll if self.fuente else None
            )
            if q:
                try:
                    src = cargar_rollo(q, self.fuente)
                except (ValueError, FileNotFoundError):
                    return self.send_error(404, f"Unknown scroll {q}")
                except Exception as e:
                    return self.send_error(502, self._inesperado(e))
                proxy = (
                    {"tipo": self.fuente.tipo, "origen": self.fuente.origen} if self.fuente else {}
                )
                info = dict(src, proxy=proxy)
            elif ROLLO:
                info = dict(ROLLO, proxy={})
            else:
                info = {}
            body = ("window.ROLLO_SERVIDOR=" + json.dumps(info, ensure_ascii=True) + ";\n").encode()
            return self._send_bytes(body, "application/javascript; charset=utf-8", "proxy")
        return self._fuente_get()

    def _datos_par(self, lamina):
        params = parse_qs(urlsplit(self.path).query)
        rollo = params.get("rollo", [None])[0]
        if rollo and not re.fullmatch(r"PHerc[A-Za-z0-9]+", rollo):
            raise ValueError("Invalid scroll")
        base = labels_base(lamina, params.get("base", [None])[0], rollo, self.fuente)
        depth = profundidad(params)
        recorte = leer_recorte(params)
        folder = ubicacion_par(lamina, base, depth, params.get("propuesta") == ["1"], recorte)
        ruta_dentro(Path("/"), folder)
        return params, base, depth, rollo, folder, recorte

    def _leer_par(self, lamina):
        if self.headers.get("X-Visor-Origen") not in (None, self.fuente.id):
            return self._json({"error": "Source changed; reload before importing masks"}, 409)
        try:
            params, base, depth, rollo, folder, recorte = self._datos_par(lamina)
            # Canonical pairs cover whole maps; a crop only ever reads its own saved pair.
            candidates = (
                None
                if recorte
                else canonical.select(
                    self.fuente,
                    rollo or base.split("/")[0],
                    base.split("/")[-1],
                    depth,
                    params.get("propuesta") == ["1"],
                )
            )
            if candidates is not None:
                identity = params.get("version", [None])[0]
                if identity:
                    candidates = [r for r in candidates if r["id"] == identity]
                if not candidates:
                    if params.get("opcional") == ["1"]:
                        self.send_response(204)
                        self.end_headers()
                        return
                    return self._json(
                        {"error": "No canonical mask pair for this surface and depth"}, 404
                    )
                if len(candidates) != 1:
                    return self._json(
                        {
                            "error": "Choose a canonical mask series/version",
                            "versions": [canonical.public_record(r) for r in candidates],
                        },
                        409,
                    )
                record = candidates[0]
                bodies = [canonical.read_asset(self.fuente, a) for a in record["assets"]]
                info = validar_par(*bodies, None, lamina, base, depth, rollo)
                if params.get("metadata") == ["1"]:
                    return self._json({"corrida": info, "canonical_version": record["id"]})
                return self._json(
                    dict(
                        zip(
                            ("inklabels", "supervision_mask"),
                            [base64.b64encode(b).decode("ascii") for b in bodies],
                        ),
                        corrida=info,
                        canonical_version=record["id"],
                    )
                )
            bodies = []
            # Resolve both generation members under one lock, never through separate HTTP snapshots.
            with self.fuente.mascara_lock:
                local_folder = self.fuente.mascara_local(folder)
                for suffix in ("inklabels", "supervision_mask"):
                    rel = folder + "/" + lamina + "_" + suffix + ".png"
                    local = local_folder / (lamina + "_" + suffix + ".png")
                    try:
                        if local.is_file():
                            body = local.read_bytes()
                        else:
                            with self.fuente.abrir(self.fuente.ruta_catalogo(rel)) as (
                                _,
                                _,
                                stream,
                            ):
                                body = stream.read(MASK_LIMIT + 1)
                        bodies.append(body)
                    except (FileNotFoundError, urllib.error.HTTPError) as error:
                        if getattr(error, "code", 404) != 404:
                            raise
                        bodies.append(None)
                if all(body is None for body in bodies):
                    if params.get("opcional") == ["1"]:
                        self.send_response(204)
                        self.end_headers()
                        return
                    return self._json({"error": "No saved mask pair"}, 404)
                if any(body is None for body in bodies):
                    return self._json(
                        {"error": "Incomplete pair: inklabels or supervision_mask is missing"}, 409
                    )
                info = validar_par(*bodies, None, lamina, base, depth, rollo, recorte)
            if params.get("metadata") == ["1"]:
                return self._json({"corrida": info})
            return self._json(
                dict(
                    zip(
                        ("inklabels", "supervision_mask"),
                        [base64.b64encode(body).decode("ascii") for body in bodies],
                    ),
                    corrida=info,
                )
            )
        except (ValueError, TypeError) as error:
            return self._json({"error": str(error)}, 400)
        except Exception as error:
            return self._json({"error": self._inesperado(error)}, 502)

    def _guardar_par(self, lamina):
        try:
            n = int(self.headers.get("Content-Length", 0))
            if self.headers.get_content_type() != "application/json" or not 0 < n <= MASK_LIMIT:
                raise ValueError("Expected pair JSON up to 64 MiB")
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or set(data) - {
                "inklabels",
                "supervision_mask",
                "corrida",
            }:
                raise ValueError("Invalid pair fields")
            bodies = []
            for key in ("inklabels", "supervision_mask"):
                if (
                    not isinstance(data.get(key), str)
                    or len(data[key]) > ((MASK_LIMIT + 2) // 3) * 4
                ):
                    raise ValueError("Base64 PNG missing or over 64 MiB")
                bodies.append(base64.b64decode(data[key], validate=True))
            _, base, depth, rollo, folder, recorte = self._datos_par(lamina)
            info = data.get("corrida")
            if (
                not isinstance(info, dict)
                or not isinstance(info.get("par_id"), str)
                or not info["par_id"]
                or not isinstance(info.get("run_id"), str)
                or not info["run_id"]
            ):
                raise ValueError("The pair needs a run with run_id and par_id")
            orientation = info.get("orientacion")
            correction = orientation.get("correccion") if isinstance(orientation, dict) else None
            if (
                "cara" not in info
                or not isinstance(orientation, dict)
                or "correccion" not in orientation
                or correction is not None
                and (
                    not isinstance(correction, list)
                    or len(correction) != 3
                    or any(type(v) is not int or v not in (0, 1) for v in correction)
                )
            ):
                raise ValueError("The pair needs explicitly recorded face and orientation")
            if "base" not in info:
                raise ValueError("The pair needs a recorded source base")
            info = validar_par(*bodies, info, lamina, base, depth, rollo, recorte)
            if not leer_mascara(bodies[1])[0].getbbox():
                raise ValueError("A pair without supervised pixels is not saved")
            directories = [ubicacion_par(lamina, base, "max", recorte=recorte), folder]
            files = dict(zip((lamina + "_inklabels.png", lamina + "_supervision_mask.png"), bodies))
            if info is not None:
                files[lamina + "_mascara_corrida.json"] = json.dumps(
                    info, ensure_ascii=True
                ).encode()
            # All class, geometry and provenance validation completes before this first write.
            self.fuente.guardar_par(directories, files)
            claves = [
                directory.removeprefix("catalog/") + "/" + name
                for directory in dict.fromkeys(directories)
                for name in files
            ]
            sync = getattr(self.server, "hf_sync", None)
            if sync:  # mirror after the local write, at the same paths as <annotations>/; the local folder stays the source of truth
                sync.submit(
                    {
                        f"{self.fuente.id}/{directory}/{name}": body
                        for directory in dict.fromkeys(directories)
                        for name, body in files.items()
                    },
                    f"Annotations: {lamina}, depth {depth}",
                )
            return self._json(
                {
                    "ok": True,
                    "destino": "anotaciones-locales",
                    "hf": sync.repo if sync else None,
                    "claves": claves,
                    "clave": claves[0],
                    "clave_profundidad": folder.removeprefix("catalog/")
                    + "/"
                    + lamina
                    + "_inklabels.png",
                }
            )
        except (ValueError, TypeError, binascii.Error) as error:
            return self._json({"error": str(error)}, 400)
        except (OSError, PermissionError) as error:
            return self._json({"error": str(error)}, 500)

    def do_POST(self):
        path = unquote(urlsplit(self.path).path).lstrip("/")
        if path == "api/origen":
            return self._cambiar_origen()
        self.fuente = getattr(self.server, "fuente", None)
        if not self._host_local():
            return self.send_error(403)
        if self.headers.get("Origin") not in (None, "http://" + self.headers["Host"]):
            return self._json({"error": "Unauthorized browser origin"}, 403)
        if not self.fuente:
            return self._json({"error": NO_SOURCE}, 503)
        if self.headers.get("X-Visor-Origen") != self.fuente.id:
            return self._json(
                {"error": "Different source or outdated tab; reload before saving"},
                409,
            )
        if not self.fuente.anotaciones:
            return self._json({"error": "Read-only source: configure an annotation folder"}, 403)
        if path.startswith("api/mascara-par/"):
            return self._guardar_par(path[len("api/mascara-par/") :])
        if path == "api/inksdk/trabajos":
            ok, why = inksdk.disponible()
            if not ok:
                return self._json({"error": why}, 503)
            try:
                n = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(n)) if 0 < n <= 4096 else None
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object")
                job = inksdk.TRABAJOS.crear(
                    self.fuente,
                    data.get("rollo"),
                    data.get("segmento"),
                    data.get("volumen"),
                    data.get("perfil"),
                    log,
                )
            except (ValueError, TypeError, PermissionError) as error:
                return self._json({"error": str(error)}, 400)
            return self._json(job, 202)
        if not path.startswith("api/mascara/"):
            return self.send_error(404)
        rel = path[len("api/mascara/") :]
        if (
            not re.fullmatch(r"[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*\.(png|json)", rel)
            or ".." in rel
        ):
            return self.send_error(400, "Expected <lamina>/<file>.png or .json")
        try:
            n = int(self.headers.get("Content-Length", 0))
            if not 0 < n <= MASK_LIMIT:
                raise ValueError("Body empty or over 64 MiB")
            body = self.rfile.read(n)
            lamina, name = rel.split("/")
            _, base, depth, rollo, folder, recorte = self._datos_par(lamina)
            if recorte:
                raise ValueError("Crop masks are saved as pairs: use /api/mascara-par")
            if rel.endswith(".png"):
                image, info = leer_mascara(body)
                validar_corrida(info, image.size, lamina, base, depth, rollo)
            else:
                info = json.loads(body)
                if not isinstance(info, dict):
                    raise ValueError("Invalid run JSON")
                # A lone sidecar must bind the destination too; complete PNG geometry is checked by the pair endpoint.
                validar_corrida(
                    info, (info.get("ancho"), info.get("alto")), lamina, base, depth, rollo
                )
            claves = [ubicacion_par(lamina, base, "max").removeprefix("catalog/") + "/" + name]
            if depth != "max":
                claves.append(folder.removeprefix("catalog/") + "/" + name)
            if name.endswith(("_inklabels.png", "_supervision_mask.png", "_mascara_corrida.json")):
                return self._json(
                    {"error": "Pair members are saved together: use /api/mascara-par"}, 409
                )
            if any(
                (
                    Path(self.fuente.anotaciones) / self.fuente.id / ("catalog/" + key)
                ).parent.is_symlink()
                for key in claves
            ):
                return self._json(
                    {
                        "error": "This mask belongs to a pair: use /api/mascara-par to keep the transaction"
                    },
                    409,
                )
        except (ValueError, TypeError) as error:
            return self._json({"error": str(error)}, 400)
        for key in claves:
            try:
                self.fuente.guardar_mascara("catalog/" + key, body)
            except (OSError, ValueError, PermissionError) as error:
                return self._json({"error": str(error)}, 500)
        return self._json(
            {
                "ok": True,
                "destino": "anotaciones-locales",
                "clave": claves[0],
                "clave_profundidad": claves[1] if len(claves) > 1 else None,
            }
        )

    def _serve_file(self, fp: Path, head=False):
        ctype = self.guess_type(str(fp))
        try:
            revision = file_revision(fp)
            if ctype.startswith("text/") or ctype in (
                "application/javascript",
                "application/json",
                "image/svg+xml",
            ):
                body, compressed, etag = file_bytes(str(fp), revision)
                return self._send_bytes(body, ctype, "mac-cache", head, etag, compressed)
            with fp.open("rb") as body:
                headers = {
                    "Content-Type": ctype,
                    "Content-Length": str(revision[3]),
                    "ETag": '"' + "-".join(str(value) for value in revision) + '"',
                    "Cache-Control": "private, no-cache",
                }
                return self._fuente_stream(200, headers, body, head, fuente="mac-cache")
        except OSError:
            self.send_error(404)
            return


def main():
    global PORT, LOG_FILE
    ap = argparse.ArgumentParser(
        description="Serve the ink viewer for a local, HTTP, S3 or official data source."
    )
    ap.add_argument(
        "--scroll",
        default=os.environ.get("SCROLL"),
        help="default scroll when a request names none",
    )
    ap.add_argument("--port", type=int, default=PORT, help="port (S3CACHE_PORT; default 8797)")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print the resolved settings (JSON) and exit, without opening the port or touching the network",
    )
    ap.add_argument(
        "--source",
        "--origen",
        dest="origen",
        default=os.environ.get("VISOR_ORIGEN"),
        help='dataset root: local folder, HTTP/HTTPS URL, s3://bucket/prefix, "official" for the Vesuvius Challenge open-data bucket, or "ink-labels" for the Herculaneum ink-label dataset on Hugging Face; no fallback to another source',
    )
    ap.add_argument(
        "--annotations",
        "--anotaciones",
        dest="anotaciones",
        default=os.environ.get("VISOR_ANOTACIONES", ""),
        help="separate local folder for saved masks; omitted = read-only",
    )
    ap.add_argument(
        "--s3-profile",
        "--s3-perfil",
        dest="s3_perfil",
        default=os.environ.get("VISOR_S3_PERFIL", ""),
        help="AWS profile; omitted = the standard SDK credential chain",
    )
    ap.add_argument(
        "--s3-endpoint",
        default=os.environ.get("VISOR_S3_ENDPOINT", ""),
        help="HTTP/HTTPS endpoint of an S3-compatible store, e.g. MinIO",
    )
    ap.add_argument(
        "--s3-region", default=os.environ.get("VISOR_S3_REGION", ""), help="region of the S3 source"
    )
    ap.add_argument(
        "--ct-source",
        "--ct-origen",
        dest="ct_origen",
        default=os.environ.get("VISOR_CT_ORIGEN", ""),
        help="where cross-sections read meshes and CT when the map source lacks them: a root holding PHerc... "
        "folders, e.g. https://vesuvius-challenge-open-data.s3.amazonaws.com (read-only)",
    )
    ap.add_argument(
        "--annotations-hf",
        default=os.environ.get("VISOR_ANNOTATIONS_HF", ""),
        help="also push each saved mask pair to this Hugging Face dataset (user/dataset, created private if absent); "
        "needs --annotations, which stays the source of truth; token from HF_TOKEN or `hf auth login`",
    )
    ap.add_argument(
        "--config",
        default=os.environ.get(
            "VISOR_CONFIG", str(Path.home() / ".config/vesuvius-visor/config.json")
        ),
        help="JSON file that remembers the source chosen in the viewer",
    )
    a = ap.parse_args()
    config_path = Path(a.config).expanduser().resolve()
    try:
        if a.origen:
            source = Fuente(a.origen, a.s3_perfil, a.s3_endpoint, a.s3_region, a.anotaciones)
        elif config_path.is_file():
            data = json.loads(config_path.read_text())
            for key, value in (
                ("anotaciones", a.anotaciones),
                ("perfil", a.s3_perfil),
                ("endpoint", a.s3_endpoint),
                ("region", a.s3_region),
            ):
                if value:
                    data[key] = value
            source = Fuente(**data)
        else:
            source = None  # the page opens with the source picker
    except (ValueError, TypeError, OSError) as e:
        ap.error(str(e))
    try:
        info = configurar(a.scroll, source)
    except (ValueError, TypeError, OSError) as e:
        ap.error("--scroll: " + str(e))
    PORT = info["port"] = a.port
    if source:
        info = dict(source.info(), port=a.port, config=str(config_path), codigo=str(CODE))
    try:
        ct_source = corte.fuente_ct(a.ct_origen)
    except (ValueError, TypeError, OSError) as e:
        ap.error("--ct-source: " + str(e))
    info["ct_origen"] = ct_source.origen if ct_source else ""
    if a.annotations_hf and not (source and source.anotaciones):
        ap.error("--annotations-hf mirrors saved masks: it needs --annotations")
    info["annotations_hf"] = a.annotations_hf
    if a.dry_run:
        print(json.dumps(info, indent=1, ensure_ascii=False))
        return
    config_path.parent.mkdir(parents=True, exist_ok=True)
    LOG_FILE = config_path.parent / "visor.log"
    if source:
        source.verificar()
        log(
            f"starting on :{PORT}; source {source.tipo}: {source.origen}; "
            f"annotations: {source.anotaciones or 'read-only'}"
        )
    else:
        log(f"starting on :{PORT} with no source; choose one in the viewer (Change source)")
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.fuente, srv.config_path, srv.ct_fuente = source, config_path, ct_source
    srv.config_token, srv.config_lock = secrets.token_urlsafe(32), threading.Lock()
    srv.daemon_threads = True
    if a.annotations_hf:
        try:
            srv.hf_sync = HFSync(a.annotations_hf)
        except Exception as e:
            ap.error("--annotations-hf: " + str(e))
        log(f"annotations mirrored to https://huggingface.co/datasets/{a.annotations_hf}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
