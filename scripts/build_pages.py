"""Build the static viewer and official index. No data files or credentials go into the site."""

import argparse
import csv
import gzip
import hashlib
import json
import re
import shutil
import sys
from io import StringIO
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from ink_viewer.catalog.official_index import construir_oficial  # noqa: E402
from ink_viewer.paths import VIEWER_TOOLS, WEB_ROOT  # noqa: E402
from ink_viewer.server.fuente_etiquetas import DATASET, construir  # noqa: E402

BUCKET = "https://vesuvius-challenge-open-data.s3.amazonaws.com"


def build(out, metadata, label_rows):
    entries, _, previews = construir_oficial(metadata)
    if not entries:
        raise ValueError("Official metadata contains no ink maps")
    out.mkdir(parents=True, exist_ok=True)
    for name in ("css", "fonts", "images"):
        shutil.copytree(WEB_ROOT / name, out / name, dirs_exist_ok=True)
    shutil.copyfile(ROOT / "static/pages.js", out / "pages.js")
    shutil.copyfile(ROOT / "static/raster-worker.js", out / "raster-worker.js")
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
    # Pages caches individual assets across deployments, including on ordinary page reloads.
    digest = hashlib.sha256()
    for name in (
        "pages.js",
        "viewer-static.js",
        "raster-worker.js",
        "geotiff.js",
        "css/responsive.css",
    ):
        digest.update((out / name).read_bytes())
    version = digest.hexdigest()[:16]
    html = html.replace('src="pages.js"', f'src="pages.js?v={version}"').replace(
        "css/responsive.css?v=20261004-compact-labeling", f"css/responsive.css?v={version}"
    )
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "official.json").write_text(
        json.dumps(
            {"root": BUCKET, "entries": entries, "previews": previews}, separators=(",", ":")
        ),
        encoding="utf-8",
    )
    labels, report, _ = construir(label_rows)
    if not labels or report["problems"]:
        raise ValueError(f"Incomplete ink-labels index: {report['problems'][:3]}")
    for entry in labels:
        folder = entry["inkLabels"]["path"]
        frame = f"{DATASET}/{folder}/preview.jpg"
        entry.update(frames={"0": frame}, frameContrasts={frame: ["fixed"]})
        # The published comparison combines three panels on a single browse-only image.
        entry["catalogMeta"].update(depthKnown=False, physicalScaleVerified=False)
    (out / "ink-labels.json").write_text(
        json.dumps({"root": DATASET, "entries": labels}, separators=(",", ":")), encoding="utf-8"
    )
    print(f"{len(labels)} ink-label entries")
    print(f"{len(entries)} official series, {len(previews)} published previews in {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--metadata", type=Path, help="Local official metadata.json (optionally gzipped)"
    )
    parser.add_argument("--ink-labels-csv", type=Path, help="Local ink-labels entries.csv")
    args = parser.parse_args()
    if args.metadata:
        raw = args.metadata.read_bytes()
    else:
        with urlopen(BUCKET + "/metadata.json", timeout=120) as response:
            raw = response.read()
    if args.ink_labels_csv:
        labels = args.ink_labels_csv.read_text(encoding="utf-8-sig")
    else:
        with urlopen(DATASET + "/entries.csv", timeout=120) as response:
            labels = response.read().decode("utf-8-sig")
    build(
        args.output,
        json.loads(gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw),
        csv.DictReader(StringIO(labels)),
    )
