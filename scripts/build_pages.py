"""Build the static viewer and official index. No data files or credentials go into the site."""

import argparse
import gzip
import json
import re
import shutil
import sys
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from ink_viewer.catalog.official_index import construir_oficial  # noqa: E402
from ink_viewer.paths import VIEWER_TOOLS, WEB_ROOT  # noqa: E402

BUCKET = "https://vesuvius-challenge-open-data.s3.amazonaws.com"


def build(out, metadata):
    entries, _, previews = construir_oficial(metadata)
    if not entries:
        raise ValueError("Official metadata contains no ink maps")
    out.mkdir(parents=True, exist_ok=True)
    for name in ("css", "fonts", "images"):
        shutil.copytree(WEB_ROOT / name, out / name, dirs_exist_ok=True)
    for name in ("pages.js", "tiff-worker.js"):
        shutil.copyfile(ROOT / "static" / name, out / name)
    codec = ROOT / "node_modules/geotiff"
    shutil.copyfile(codec / "dist-browser/geotiff.js", out / "geotiff.js")
    shutil.copyfile(codec / "LICENSE", out / "LICENSE-geotiff.txt")
    for name in ("LICENSE", "LICENSE-Inter.txt"):
        shutil.copyfile(ROOT / name, out / name)
    browser = [
        tool
        for tool in VIEWER_TOOLS
        if tool not in {"inksdk.js", "corte.js", "recorte.js", "hd.js"}
    ]
    scripts = ["rollo_visor.js", "etiquetar.js", "etiq_vc3d.js", "viewer.js", *browser]
    (out / "viewer-static.js").write_text(
        "\n;\n".join((WEB_ROOT / "js" / name).read_text() for name in scripts), encoding="utf-8"
    )
    html = (WEB_ROOT / "index.html").read_text()
    blocks = {
        "preloads": "",
        "badge": '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'; '
        "object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'self'\">",
        "startup": '<link rel="stylesheet" href="css/responsive.css?v=20261004-compact-labeling">\n<script defer src="pages.js"></script>',
    }
    for marker, replacement in blocks.items():
        pattern = f"<!-- server {marker} -->.*?<!-- end server {marker} -->"
        html, count = re.subn(pattern, replacement, html, flags=re.DOTALL)
        if count != 1:
            raise ValueError(f"Expected one {marker} block in index.html")
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "official.json").write_text(
        json.dumps(
            {"root": BUCKET, "entries": entries, "previews": previews}, separators=(",", ":")
        ),
        encoding="utf-8",
    )
    print(f"{len(entries)} official series, {len(previews)} published previews in {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--metadata", type=Path, help="Local official metadata.json (optionally gzipped)"
    )
    args = parser.parse_args()
    if args.metadata:
        raw = args.metadata.read_bytes()
    else:
        with urlopen(BUCKET + "/metadata.json", timeout=120) as response:
            raw = response.read()
    build(args.output, json.loads(gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw))
