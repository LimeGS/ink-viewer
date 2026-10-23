# Ink viewer

A browser viewer and annotator for 2D ink maps, with local, HTTP and S3 data origins. This repository contains viewer source and tests only. Maps, CT volumes, masks, dataset metadata, caches, credentials and machine settings belong outside Git.

## Run

Run the local server on macOS or Linux.

```sh
python3 -m pip install -r requirements.txt
python3 s3cache_proxy.py --origen /absolute/path/to/data --anotaciones /absolute/path/to/annotations
```

Both folders must already exist. Open `http://127.0.0.1:8797/all-gallery/index.html`.
Omit `--anotaciones` for read-only browsing. The Change source dialog also accepts local folders, HTTP/HTTPS URLs and `s3://bucket/prefix` origins. S3 credentials use the standard AWS SDK credential chain or `--s3-perfil`; keys are never embedded in source or browser configuration. Private endpoints, legacy proxy URLs and token paths must be explicitly configured through environment variables or CLI options.

## Existing Vast deployment

`vast_server.py` is the read-only adapter used by the green explorer on Vast. It reads the canonical `/workspace/catalog` and the deployment's existing asset registry and generated indexes. These external files are not part of the repository.

For an already configured deployment, with this checkout in its `code/` directory:

```sh
python3 -B vast_ctl.py status --site /absolute/path/to/deployment
python3 -B vast_ctl.py start --site /absolute/path/to/deployment
```

The service binds to `127.0.0.1:8798`, disables GPU access and limits numerical library threads. Use the machine's existing SSH configuration to forward a loopback port; open `http://127.0.0.1:8798/all-gallery/index.html` on the client. No public listener is needed. The Linux-only controller checks the recorded process identity before stopping it. `refresh` rebuilds deployment indexes and requires this viewer to be stopped first; it reads existing maps and measured v5 sidecars, without running inference or training.

The current source includes measured v5 scores by model, the single green explorer, compressed and cached browser metadata, a combined tools script, lazy thumbnails and reuse of visible explorer rows. Full-resolution images and physical metadata retain their original values; preview images remain browsing aids.

Runtime source settings are stored outside this checkout by default; select another location with `--config`. Sources are isolated: missing files do not fall back to another origin, and annotations are separated from originals and partitioned by source identity.

## External data layout

A legacy docroot can contain:

```text
data-root/
  all-gallery/
    manifest.json
    metadata.json                 # optional dataset-specific measurements and model history
    alias.json                    # optional segment aliases
    orientacion_vista.json        # optional original-grid orientation
    compuertas.json               # optional scientific gate results
    legibilidad.json              # optional measured scores
  catalog/
    PHercNNNN/segments/<segment>/ink-detection/<map>.png
    PHercNNNN/segments/<segment>/ink-detection/downsampled/<map>-ds4.jpg
  rollos/PHercNNNN/rollo.json       # dataset physical scale; do not infer it from image size
```

Official catalog roots and individual sample roots are also supported. Use `generar_manifest.py --origen /absolute/path/to/catalog --dry-run` to inspect discovery before generating an external `_viewer/manifest.json`. PNG and single-page integer TIFF maps are supported. The viewer does not decode CT/Zarr, convert DICOM, render 3D meshes, or establish that a map contains ink.

Dataset metadata stays at the selected origin. `metadata.json` uses a `scroll` plus optional `TABLA`, `CAND`, `MODNOM`, `MODCORTO`, `CONTAM`, `CONTAM_SOLAPE`, `CONTAM_TXT`, `ORIENT`, `POS`, `PAR` and `PAR_EXTRA` fields. Contamination maps contain arrays of sheet IDs. Missing measurements remain unknown; source selection and manifest discovery do not establish scientific verification. When migrating an older checkout, retain its external metadata and original volumes alongside the dataset.

## Annotation integrity

Annotation requires the full-resolution map; thumbnails and JPEG previews are for browsing. Zoom, flips and transpose affect display only: masks retain the original image grid.

Use the explicit import format selector:

- **Binary pair:** select matching `<segment>_inklabels.png` and `<segment>_supervision_mask.png` together. Both use opaque grayscale values exactly 0 or 255. Ink must be a subset of supervision.
- **Ink-only:** select one opaque grayscale PNG with exactly 0 (unlabelled/IGNORE) or 255 (ink). Black pixels remain unknown; this import includes no reviewed non-ink. Use a binary pair to retain reviewed background.
- **Tri-state:** select one opaque grayscale PNG with exactly 0 (reviewed non-ink), 128 (unreviewed/IGNORE) or 255 (ink), including the viewer's tri-state downloads. This encoding differs from ink-only PNGs; choose it explicitly.

Imports require exact dimensions and matching sheet, depth and grid provenance. Unexpected colors, transparency, intermediate values and stale asynchronous loads are rejected. Replacement imports can be undone. Unknown legacy provenance requires an explicit decision; it is never treated as verified alignment.

The pair download captures both layers from one mask snapshot and embeds shared run, depth and grid metadata in both PNGs. Server saves send a single validated pair request. Writable local annotation storage publishes complete mask generations, retaining previous versions; legacy remote writers without pair-transaction support cannot accept pair saves.

Training must use both mask layers to distinguish reviewed non-ink from IGNORE and must read original CT data through its own intensity-preserving pipeline. Viewer previews are not training CT inputs.

## Checks

```sh
python3 -m unittest discover -p 'test_*.py'
for check in test_*.cjs; do node "$check" || exit; done
```

Tests use temporary datasets and local service stand-ins. Browser PNG decoding and a deployment write/read check are separate verification steps. `exportar_compuertas.py` imports existing receipts into viewer gate metadata; it does not run scientific controls.

## Managed releases and previews

`viewerctl.py` keeps immutable releases, production and preview pointers, process state and machine settings in an external deployment directory. A preview uses its own annotation folder; it cannot change the production source or write to the legacy catalog.

```sh
python3 viewerctl.py --site /absolute/path/to/deployment init --origin /absolute/path/to/data --annotations /absolute/path/to/annotations
# Or import an existing local viewer's explicit source and physical metadata:
python3 viewerctl.py --site /absolute/path/to/deployment init --from-port 8797
python3 viewerctl.py --site /absolute/path/to/deployment update --ref origin/main
python3 viewerctl.py --site /absolute/path/to/deployment status
# After checking the preview URL:
python3 viewerctl.py --site /absolute/path/to/deployment promote
python3 viewerctl.py --site /absolute/path/to/deployment rollback
```

Run one `init` command per machine; it refuses to overwrite an existing profile. Production and preview use different ports (8797 and 8897 by default). Release hashes are checked before startup and promotion. Imported scroll measurements remain external under the deployment's `rollos/` directory and are used only when the selected source has no measurements for that scroll; unknown scales remain unknown.

`publish_preview.py` can send committed code to an initialized remote deployment over SSH and update its preview. It refuses a dirty or unrelated remote checkout. Only the selected ref is bundled; publication rejects non-source paths anywhere in its history. Assets, credentials, caches, masks and local configuration must stay outside the code repository; the release tools never copy the working tree.

## Licenses

Viewer code uses the repository's MIT license. The bundled [Inter font](https://github.com/rsms/inter) retains its SIL Open Font License in `LICENSE-Inter.txt`.
