"""``--source official``: the Vesuvius Challenge open-data bucket, indexed from the bucket's own metadata.json.

Maps are read anonymously over HTTPS straight from the bucket. The index is derived locally: on start (and when the
cached copy is older than VISOR_OFFICIAL_MAX_AGE_HOURS, default 24) the server downloads metadata.json, builds the
manifest with ink_viewer.catalog.official_index and keeps it under VISOR_OFFICIAL_CACHE
(default ~/.cache/ink-viewer/official). New team runs therefore appear on the next refresh, with nothing to
maintain by hand. If a refresh fails, the previous index is kept.
"""

import contextlib
import gzip
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from ink_viewer.catalog.official_index import construir_oficial
from ink_viewer.server.fuentes import Fuente, guardar_json, ruta_dentro

OFFICIAL = "official"
BUCKET_HTTP = "https://vesuvius-challenge-open-data.s3.amazonaws.com"
CACHED = ("_viewer/manifest.json", "_viewer/index-info.json")
METADATA_LIMIT = 512 * 2**20


def cache_dir():
    return Path(
        os.environ.get("VISOR_OFFICIAL_CACHE") or Path.home() / ".cache/ink-viewer/official"
    ).expanduser()


class FuenteOficial(Fuente):
    def __init__(self, origen=OFFICIAL, perfil="", endpoint="", region="", anotaciones=""):
        if (origen or "").strip().lower() != OFFICIAL:
            raise ValueError("FuenteOficial only serves --source official")
        super().__init__(
            os.environ.get("VISOR_OFFICIAL_BUCKET") or BUCKET_HTTP,
            perfil,
            endpoint,
            region,
            anotaciones,
        )
        self.cache = cache_dir()
        self.max_age = float(os.environ.get("VISOR_OFFICIAL_MAX_AGE_HOURS") or 24) * 3600
        self.previews = {}

    def config(self):
        return dict(super().config(), origen=OFFICIAL)

    def info(self):
        info = self.indice("_viewer/index-info.json") if (self.cache / CACHED[1]).is_file() else {}
        return dict(
            super().info(),
            bucket=self.origen,
            generated=info.get("generated"),
            series=info.get("series"),
        )

    def preparar(self, force=False):
        """Make sure a usable index exists; rebuild it from metadata.json when missing or stale."""
        manifest = self.cache / CACHED[0]
        if (
            manifest.is_file()
            and not force
            and time.time() - manifest.stat().st_mtime < self.max_age
        ):
            self._cargar_previews()
            return False
        try:
            with urllib.request.urlopen(self.origen + "/metadata.json", timeout=120) as response:
                raw = response.read(METADATA_LIMIT + 1)
            if len(raw) > METADATA_LIMIT:
                raise ValueError("metadata.json larger than expected")
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            entries, report, previews = construir_oficial(json.loads(raw))
        except Exception as e:
            if manifest.is_file():
                print(
                    f"Official index refresh failed; using the cached index: {e}",
                    file=sys.stderr,
                    flush=True,
                )
                self._cargar_previews()
                return False
            raise ValueError(
                f"Could not build the official index from {self.origen}/metadata.json: {e}"
            ) from e
        report["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        report["bucket"] = self.origen
        guardar_json(self.cache / "_viewer/previews.json", previews)
        guardar_json(manifest, entries)
        guardar_json(self.cache / CACHED[1], report)
        self.previews = previews
        return True

    def _cargar_previews(self):
        path = self.cache / "_viewer/previews.json"
        self.previews = json.loads(path.read_text()) if path.is_file() else {}

    def verificar(self):
        self.preparar()
        return super().verificar()

    def preview(self, rel, scale):
        """Published 1/8 JPEG for a full-resolution official map, or None."""
        return self.previews.get(rel) if scale == 8 else None

    def indice(self, name, limite=16 * 2**20):
        if name in CACHED:
            path = self.cache / name
            return json.loads(path.read_text()) if path.is_file() else {}
        return super().indice(name, limite)

    def listado(self, rel=""):
        """One level of the public bucket through S3's anonymous ListObjectsV2 over HTTPS (plain HTTP sources cannot
        list). ink-sdk jobs use it to find a segment's surface-volumes/."""
        import urllib.parse
        import urllib.request
        import xml.etree.ElementTree as ET

        if rel:
            ruta_dentro(Path("/"), rel)
        prefix = rel.strip("/") + "/" if rel.strip("/") else ""
        entries, token = set(), None
        while True:
            query = {"list-type": "2", "delimiter": "/", "prefix": prefix}
            if token:
                query["continuation-token"] = token
            with urllib.request.urlopen(
                self.origen.rstrip("/") + "/?" + urllib.parse.urlencode(query), timeout=60
            ) as response:
                root = ET.fromstring(response.read())

            def tag(element, name):
                return element.find("{*}" + name)

            for item in root.findall("{*}CommonPrefixes"):
                entries.add((tag(item, "Prefix").text[len(prefix) :].rstrip("/"), True))
            for item in root.findall("{*}Contents"):
                key = tag(item, "Key").text
                if key != prefix:
                    entries.add((key[len(prefix) :], False))
            more = tag(root, "IsTruncated")
            token = tag(root, "NextContinuationToken")
            if more is None or more.text != "true" or token is None:
                break
            token = token.text
        return sorted(
            (name, directory) for name, directory in entries if name and not name.startswith(".")
        )

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
        with super().abrir(rel, rango, head, zarr_meta) as response:
            yield response
