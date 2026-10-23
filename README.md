# Ink Viewer

[![Dependency audit](https://github.com/LimeGS/ink-viewer/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/LimeGS/ink-viewer/actions/workflows/audit.yml)
[![Coverage ≥90%](https://github.com/LimeGS/ink-viewer/actions/workflows/tests.yml/badge.svg?branch=main&label=coverage%20%E2%89%A590%25)](https://github.com/LimeGS/ink-viewer/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Explore, compare and annotate 2D ink-detection maps from Vesuvius scroll datasets in your browser.**

Ink Viewer helps researchers inspect model predictions, compare runs and depths, review existing quality measurements, and create ink/non-ink annotations on the original image grid. It runs on your own Mac, Linux workstation or server, with data in local folders, an HTTP server, Amazon S3 or an S3-compatible store. No GPU or cloud provider is required.

This repository contains the application and tests. Bring your own maps and dataset metadata; research data, annotations, credentials and machine configuration stay outside the repository.

## Contents

- [What you can do](#what-you-can-do)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Prepare a dataset](#prepare-a-dataset)
- [Connect to public S3](#connect-to-public-s3)
- [Authenticated S3 and compatible storage](#authenticated-s3-and-compatible-storage)
- [Configuration](#configuration)
- [Deploy on your own server](#deploy-on-your-own-server)
- [Managed releases, previews and rollback](#managed-releases-previews-and-rollback)
- [Annotation formats and integrity](#annotation-formats-and-integrity)
- [Troubleshooting](#troubleshooting)
- [Development and contribution](#development-and-contribution)
- [Licenses](#licenses)

## What you can do

- Browse scrolls, segments, model runs and available depth offsets in one explorer, with search, sorting, filters and thumbnails.
- Compare models side by side, pin filter settings, or use the Super mosaic to compare many display treatments.
- Inspect existing v5 scores and quality gates when the dataset supplies them. Missing measurements remain unknown; the viewer does not calculate model scores or run scientific audits.
- Adjust contrast, gamma, thresholds and colour maps for inspection. Display filters do not rewrite source maps.
- Paint ink and reviewed non-ink, select regions, undo changes, import masks, and export a matched annotation pair with grid provenance.
- Add measurement guides. Physical units require documented calibration; image dimensions alone do not establish a physical scale.
- Browse using previews and lazy thumbnails, then load the original image for annotation. Browser metadata is compressed and cached, and visible explorer rows are reused.

The application works with prepared Vesuvius catalogs and viewer manifests. It is not a general image-folder browser. It does not run inference or training, decode CT/Zarr volumes, convert DICOM, or render 3D meshes. An ink prediction is not proof that a region contains readable text.

## How it works

```text
Browser: explorer, comparison tools and annotation canvas
                       |
             HTTP on 127.0.0.1:8797
                       |
                  Python server
                 /             \
     local / HTTP / S3       local annotation folder
        source data          separate from originals
```

The frontend uses JavaScript, HTML, CSS and native browser APIs. Python serves the application, reads datasets, validates mask saves and provides catalog/deployment commands. Web assets ship with the Python package; there is no frontend build step. Node.js is needed only for development tests.

Local, HTTP and S3 origins use the same browser interface. The server reads remote data on behalf of the browser, so normal source access does not require browser-to-bucket CORS configuration. In the standard source mode described here, annotation saves go to the configured **local folder on the server**, even when the maps come from S3. They do not upload changes to the source bucket.

## Quick start

### Requirements

- macOS or Linux, Python **3.10+**, and Git to install from this repository.
- A prepared dataset with a viewer manifest, or a local Vesuvius catalog that can be indexed as described below.
- A current browser with Canvas and IndexedDB support.

Data is not bundled. Memory and network requirements depend on the dimensions of the maps you open; annotation loads the full-resolution image.

### Install

```sh
git clone https://github.com/LimeGS/ink-viewer.git
cd ink-viewer
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
```

### Open a prepared local dataset

Replace the example path with your dataset root:

```sh
ink-viewer --origen /absolute/path/to/dataset
```

Open **[http://127.0.0.1:8797/all-gallery/index.html](http://127.0.0.1:8797/all-gallery/index.html)**. Keep the terminal process running; use `Ctrl+C` to stop it. `python -m ink_viewer` is an equivalent entry point.

To enable server-side annotation saves, create a separate folder and restart with it:

```sh
mkdir -p "$HOME/ink-viewer-annotations"
ink-viewer --origen /absolute/path/to/dataset \
  --anotaciones "$HOME/ink-viewer-annotations"
```

Both local paths must exist. Omitting `--anotaciones` disables server-side saves; browser-local editing and downloads remain available. IndexedDB belongs to that browser profile and origin, so use exported files or server saves for annotations you need to retain.

## Prepare a dataset

### Catalog layout

The indexer supports a catalog root containing `PHerc...` sample folders, an individual sample root containing `segments/`, or a document root containing `catalog/`.

```text
catalog/
  PHerc0306B/
    segments/
      <segment-id>/
        ink-detection/
          <catalog-map-name>-c+00.png
          <catalog-map-name>-c+02.png
          <catalog-map-name>-c+00-global.png     # optional alternate contrast
          downsampled/                         # optional browsing previews
        mesh/tifxyz/                           # optional mesh inputs and metadata
        labels/                                # optional existing labels
    volumes/                                   # not decoded by this viewer
  _viewer/
    manifest.json                              # generated
    index-info.json                            # generated
    metadata.json                              # optional dataset metadata
```

Map discovery expects the catalog naming convention, including sample, segment, run, model, tile, stride and optional depth. For example:

```text
PHerc0306B-example-volume-unknown-20261001000000-base-tile256-stride128-c+00.png
```

This file belongs in `PHerc0306B/segments/example/ink-detection/`. PNG and single-page integer TIFF maps are supported. Arbitrarily named images are reported as unrecognized rather than assigned invented provenance. See [the filename parser](src/ink_viewer/catalog/catalog_names.py) for accepted names and [the manifest generator](src/ink_viewer/catalog/generar_manifest.py) for the schema.

Inspect discovery, then create the index at the same root you will pass to the viewer:

```sh
ink-viewer-manifest --origen /absolute/path/to/catalog --dry-run
ink-viewer-manifest --origen /absolute/path/to/catalog
ink-viewer --origen /absolute/path/to/catalog
```

The generator writes `_viewer/manifest.json` and `_viewer/index-info.json`; it does not rewrite maps. Review the reported counts and problems. Use `--reemplazar` only when intentionally replacing an existing generated index. For a renamed sample folder, pass its explicit identity with `--scroll PHerc0306B`.

Optional `--verificar-mallas` checks render receipts against mesh-input SHA-256 values and can read substantial data. Ordinary discovery leaves mesh associations unverified. Neither mode proves ink detection or scientific validity.

### Existing viewer layouts and metadata

Prepared datasets can also use `all-gallery/manifest.json` or the compatible `manifest.js` layout. Keep dataset-relative paths intact:

```text
dataset/
  all-gallery/
    manifest.json
    metadata.json                 # optional measurements and model history
    alias.json                    # optional segment aliases
    orientacion_vista.json        # optional grid orientation
    compuertas.json               # optional measured quality gates
    legibilidad.json              # optional measured scores
  catalog/PHerc0306B/segments/...
  rollos/PHerc0306B/rollo.json      # optional documented physical scale
```

Catalog-owned metadata can live under `_viewer/` instead. `metadata.json` uses `scroll` and optional `TABLA`, `CAND`, `MODNOM`, `MODCORTO`, `CONTAM`, `CONTAM_SOLAPE`, `CONTAM_TXT`, `ORIENT`, `POS`, `PAR` and `PAR_EXTRA` fields. Contamination maps contain arrays of sheet IDs. Missing scores, calibration or orientation must remain unknown. Preserve the producer's original metadata and receipts when moving a dataset.

## Connect to public S3

### Browse an already indexed public bucket without AWS credentials

Use the bucket's **HTTPS object endpoint** as the source. Replace the uppercase placeholders, including the region and any prefix; omit the final prefix if the dataset is at the bucket root:

```sh
ink-viewer --origen \
  "https://YOUR_BUCKET.s3.YOUR_REGION.amazonaws.com/YOUR_DATASET_PREFIX"
```

Use the dataset root, not an individual PNG, the AWS Console URL, or an S3 bucket-listing page. The same command works with a public HTTP dataset or CDN base URL. See the [AWS object URL format](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html#virtual-hosted-style-access).

For a generated catalog index, these objects must be readable at that base URL:

```text
_viewer/index-info.json
_viewer/manifest.json
PHerc0306B/segments/...             # catalog layout example
```

`index-info.json` records whether the root is a catalog, sample or document root; preserve that layout when publishing. Every map referenced by the manifest must also be readable. You can check the index before starting:

```sh
curl --fail "https://YOUR_BUCKET.s3.YOUR_REGION.amazonaws.com/YOUR_DATASET_PREFIX/_viewer/index-info.json"
curl --fail "https://YOUR_BUCKET.s3.YOUR_REGION.amazonaws.com/YOUR_DATASET_PREFIX/_viewer/manifest.json"
```

**Public objects alone are not enough:** the HTTP reader needs a prepared viewer index and cannot discover a catalog by listing an HTTP directory. The current `s3://` client uses SDK authentication; it has no dedicated anonymous/unsigned CLI mode. Use HTTPS for credential-free public browsing.

### Publish an index for a bucket you maintain

You can index a local copy of the catalog and publish the two `_viewer/` files alongside the same relative map paths. Alternatively, scan S3 with a profile allowed to list and read that prefix:

```sh
ink-viewer-manifest --origen s3://YOUR_BUCKET/YOUR_DATASET_PREFIX \
  --s3-perfil dataset-maintainer --s3-region YOUR_REGION \
  --salida /absolute/path/to/generated-index
```

This writes local output only. It does not publish files or change bucket permissions. If you use the separately installed [AWS CLI](https://docs.aws.amazon.com/cli/latest/reference/s3/cp.html), upload just the generated index:

```sh
aws s3 cp /absolute/path/to/generated-index/_viewer/manifest.json \
  s3://YOUR_BUCKET/YOUR_DATASET_PREFIX/_viewer/manifest.json --profile dataset-maintainer
aws s3 cp /absolute/path/to/generated-index/_viewer/index-info.json \
  s3://YOUR_BUCKET/YOUR_DATASET_PREFIX/_viewer/index-info.json --profile dataset-maintainer
```

Use the dataset owner's existing publication policy to make the intended index and map objects readable. Once published, readers can use the HTTPS command above without listing permission or AWS credentials. Do not attempt to publish indexes into a third-party dataset you do not maintain.

## Authenticated S3 and compatible storage

For an indexed bucket accessed through the AWS SDK:

```sh
ink-viewer --origen s3://YOUR_BUCKET/YOUR_DATASET_PREFIX \
  --s3-perfil research --s3-region YOUR_REGION
```

Omit `--s3-perfil` to use the [standard Boto3 credential chain](https://docs.aws.amazon.com/boto3/latest/guide/credentials.html), including an already configured workload role. Credentials are used by Python, not embedded in browser code. Configure them for the OS account that actually runs the service.

For an S3-compatible store, provide its endpoint and region as required by that store:

```sh
ink-viewer --origen s3://YOUR_BUCKET/YOUR_DATASET_PREFIX \
  --s3-endpoint https://storage.example.org \
  --s3-region YOUR_REGION --s3-perfil research
```

Normal indexed browsing reads objects. Manifest generation also needs bucket listing permission for the selected prefix. Annotation saves still require a separate local `--anotaciones` directory; source-bucket write access is not needed.

## Configuration

The **Change source** dialog accepts local folders, HTTP/HTTPS roots and S3 prefixes. It validates a source before selecting it and remembers settings outside the repository. Failed changes leave the active source intact; requests do not fall back to a different origin.

The default settings path is `~/.config/vesuvius-visor/config.json`. You can manage an explicit JSON file instead:

```json
{
  "origen": "https://YOUR_BUCKET.s3.YOUR_REGION.amazonaws.com/YOUR_DATASET_PREFIX",
  "perfil": "",
  "endpoint": "",
  "region": "",
  "anotaciones": ""
}
```

```sh
ink-viewer --config /absolute/path/to/origin.json
```

Keep the Spanish field and flag names shown here; they are the current CLI/API names. `anotaciones` is an existing local directory or an empty string for no server saves. `perfil`, `endpoint` and `region` apply only to `s3://` sources, so leave them empty for HTTPS. Never put secret keys in this JSON.

| CLI option | Environment variable | Purpose |
| --- | --- | --- |
| `--origen` | `VISOR_ORIGEN` | Local folder, HTTP/HTTPS root or S3 prefix |
| `--anotaciones` | `VISOR_ANOTACIONES` | Separate local annotation directory |
| `--s3-perfil` | `VISOR_S3_PERFIL` | AWS SDK profile name |
| `--s3-endpoint` | `VISOR_S3_ENDPOINT` | S3-compatible service endpoint |
| `--s3-region` | `VISOR_S3_REGION` | S3 region |
| `--config` | `VISOR_CONFIG` | Persistent source settings path |
| `--port` | `S3CACHE_PORT` | Loopback HTTP port; default `8797` |
| `--scroll` | `SCROLL` | Default scroll selection |

An explicit `--origen` selects a source at startup instead of loading the saved source. To resume the dialog's saved selection, start with `--config` alone and no `VISOR_ORIGEN` override. `--dry-run` prints resolved settings without starting HTTP or checking remote connectivity; do not confuse it with a successful data read.

## Deploy on your own server

### Workstation, VM or dedicated host

Install Python and the application on that machine using the quick-start commands. Give its service account read access to the dataset and, if needed, write access to a separate annotation directory. Run the same `ink-viewer` command there; no provider-specific configuration or GPU is required.

The server listens on **127.0.0.1** and checks localhost host/origin headers. For access from your laptop, forward the same port over SSH:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8797:127.0.0.1:8797 user@your-server
```

Then open `http://127.0.0.1:8797/all-gallery/index.html` on the laptop. The viewer must be running remotely, and the SSH session must stay open. If that local port is occupied, choose another port on **both** sides and start the remote viewer with the matching `--port`; changing only the forwarded client port conflicts with the current Host checks.

### Run continuously with systemd on Linux

The example below assumes the package is installed in `/opt/ink-viewer/.venv`, a dedicated OS account named `ink-viewer` exists, and an indexed dataset is readable at `/srv/ink-viewer/catalog`. Create writable state and annotation directories for that account first. Save this unit as `/etc/systemd/system/ink-viewer.service`:

```ini
[Unit]
Description=Ink Viewer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ink-viewer
Group=ink-viewer
WorkingDirectory=/var/lib/ink-viewer
ExecStart=/opt/ink-viewer/.venv/bin/python -m ink_viewer --origen /srv/ink-viewer/catalog --anotaciones /srv/ink-viewer/annotations --config /var/lib/ink-viewer/origin.json --port 8797
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

For read-only service operation, omit `--anotaciones` from `ExecStart`. For remote storage, replace the explicit origin/options or use a prepared `--config` file. Credentials and profiles must be available to the service account rather than only to your interactive shell.

```sh
sudo install -d -o ink-viewer -g ink-viewer /var/lib/ink-viewer /srv/ink-viewer/annotations
sudo systemctl daemon-reload
sudo systemctl enable --now ink-viewer
sudo systemctl status ink-viewer
sudo journalctl -u ink-viewer -n 50
```

The SSH tunnel remains the access method. On macOS, the foreground quick start works directly; a persistent service can be managed by your own process supervisor.

### Sharing and application boundaries

This is a tool for a trusted operator, not a multi-user hosting service: it has no user accounts, per-user data permissions or collaborative edit conflict resolution. The source picker acts with the server account's filesystem and storage permissions. Keep access private through SSH or another access-controlled deployment.

A public reverse proxy needs an authentication/access policy and deliberate handling of the application's Host and Origin checks. Merely exposing the loopback port or adding HTTPS does not provide those features. A static S3 website alone cannot host the complete application: the Python API is required for source access and validated server saves.

## Managed releases, previews and rollback

For Git-based deployments, the optional release manager keeps immutable source releases, process state and production/preview pointers in an external directory. Use it as an alternative to running the same port through the foreground/systemd example.

From a clone with dependencies installed:

```sh
ink-viewer-deploy --site /absolute/path/to/deployment init \
  --origin /absolute/path/to/catalog --annotations /absolute/path/to/annotations
ink-viewer-deploy --site /absolute/path/to/deployment update --ref origin/main
ink-viewer-deploy --site /absolute/path/to/deployment status
```

For HTTP/S3 settings, use `init --source-config /absolute/path/to/origin.json` instead of `--origin`. `init` runs once and refuses to overwrite an existing machine profile. `update` fetches committed code and starts a preview on port **8897** by default. Inspect `http://127.0.0.1:8897/all-gallery/index.html` locally, or forward that same port over SSH for a remote machine.

After reviewing the preview:

```sh
ink-viewer-deploy --site /absolute/path/to/deployment promote
# To return to the previous managed release:
ink-viewer-deploy --site /absolute/path/to/deployment rollback
```

Production defaults to **8797**. Preview annotation storage is isolated from production; promotion retains the previous source release. Rollback switches application code, not dataset contents or annotation history. Machine-owned settings stay outside Git. The controller refuses to take over an unrelated occupied production port; plan an explicit handoff if another service already uses it.

The controller uses the Python environment recorded at initialization. Keep its dependencies compatible with each selected release. It requires a Git checkout; a runtime wheel installation alone does not provide source release history. For reboot persistence, integrate the selected deployment with your process supervisor; starting a managed child process does not install a boot service.

For publication from another machine, `ink-viewer-publish --help` describes sending a committed source bundle over SSH to an already initialized deployment. Publication checks the selected Git history, refuses runtime data in the bundle and refuses to overwrite a dirty or unrelated remote checkout. Configure the remote machine's data and credentials separately.

## Annotation formats and integrity

Annotations use the **full-resolution original raster**. Previews are browsing aids. Zoom, display filters, flips and transpose change the view, not the stored mask grid.

Choose the import format explicitly:

| Format | Files and pixel values | Meaning |
| --- | --- | --- |
| Binary pair | `<segment>_inklabels.png` + `<segment>_supervision_mask.png`; opaque grayscale `0` or `255` | Ink must be a subset of supervision. Supervised non-ink is reviewed background; unsupervised pixels are unknown. |
| Ink-only | One opaque grayscale PNG; `0` or `255` | `255` is ink; `0` is unknown/IGNORE, not reviewed background. |
| Tri-state | One opaque grayscale PNG; `0`, `128` or `255` | `0` is reviewed non-ink, `128` is unknown/IGNORE, `255` is ink. |

Import requires exact dimensions and compatible sheet, sample, depth and grid provenance. Unexpected colours, transparency, intermediate values and stale asynchronous destinations are rejected. Unknown legacy provenance requires an explicit decision and is not treated as verified alignment. Replacement imports can be undone.

Pair downloads capture ink and supervision from one snapshot and embed matching run/depth/grid metadata in both PNGs. Server saves validate the pair as one request and publish complete local generations while retaining previous versions. Browser storage and server annotation paths are separated by source identity; changing a source URL can therefore select a different annotation namespace.

Back up the complete external annotation directory. Source data, physical metadata and model history need their own backup policy. Training consumers must read both mask layers to distinguish reviewed non-ink from IGNORE and use original CT data through their own intensity-preserving pipeline.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| “No manifest” or an empty dataset | Use the indexed dataset root; generate the local catalog index or ask the publisher for a compatible one. Review discovery counts and unrecognized filenames. |
| Public S3 returns `403`/`404` | Check the regional HTTPS endpoint, prefix, both index objects and referenced maps. A private or absent optional object can return `403` on S3. |
| SDK reports missing credentials for a public bucket | Use its HTTPS root for anonymous browsing. The `s3://` mode currently uses SDK authentication. |
| Index loads, images fail | Preserve relative paths and the layout in `index-info.json`; confirm that each referenced object is readable. |
| Remote page/API returns `403` | Use the documented localhost tunnel and matching local/remote ports. A custom Host header or cross-origin proxy needs explicit integration. |
| Port already in use | Choose another `--port` and matching tunnel; managed deployments do not stop unrelated listeners. |
| Save button disabled | Configure an existing writable local `--anotaciones` folder. Reading maps from S3 does not enable bucket writes. |
| Brush waits or a comparison pane is view-only | Wait for the native image and restored mask. Annotation requires the selected pane to match the original mask grid. |
| v5 score, area or physical depth is missing | Supply the actual dataset measurements and compatible sidecars. Missing values are not estimated by the viewer. |
| New settings disappear on restart | An explicit `--origen` or environment override takes precedence over the saved source. |

Use `ink-viewer --help`, `ink-viewer-manifest --help` and `ink-viewer-deploy --help` for all current options. Source-mode logs are written next to the selected config as `visor.log`; managed deployment logs live under `<deployment>/state/<channel>/`.

## Development and contribution

Contributions are welcome through [issues](https://github.com/LimeGS/ink-viewer/issues) and pull requests. For a bug report, include the expected/actual behaviour, OS, Python/Node/browser versions, steps to reproduce, and a small synthetic fixture when possible. Redact credentials, private URLs, tokens and unpublished research data.

### Set up a development checkout

Fork the repository for your own contributions, clone it, create a branch, and use an editable install:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'
npm ci
git switch -c describe-your-change
```

JavaScript tests require Node **22.22.2+, 24.15.0+, or 26+** in the supported even-numbered release lines; CI uses Node 24. npm packages are development dependencies, not a browser build pipeline.

### Source layout

```text
src/ink_viewer/
  server/              HTTP routing, data sources and validated mask storage
  catalog/             discovery, manifests, inventory and measured metadata
  deployment/          source releases, previews and process management
  web/
    index.html         page markup and startup configuration
    js/                explorer, image tools and annotation behaviour
    css/               layout, theme and responsive styles
    fonts/             bundled Inter font
    images/            interface branding
  paths.py             shared package and asset paths
tests/
  python/              catalog, HTTP, storage and deployment tests
  javascript/          interaction and integrity tests
docs/architecture.md   component boundaries and browser loading
```

Read [the architecture notes](docs/architecture.md) before changing shared browser state or deployment behaviour. Keep application code under `src/`; put generated indexes, maps, masks, caches, local profiles and secrets outside the code checkout. Keep changes focused and preserve original image coordinates, mask ownership and documented physical calibration.

### Run checks

```sh
python -m coverage erase
python -m coverage run -m unittest discover -s tests/python -p 'test_*.py'
python -m coverage combine
python -m coverage report
npm run test:coverage
python -m pip_audit . --strict
npm audit --audit-level=low
```

For a faster test run without coverage, use `python -m unittest discover -s tests/python -p 'test_*.py'` and `npm test`.

CI enforces **at least 90% line coverage separately for the complete Python package and all browser JavaScript files**, including unexecuted modules. This is not a 90% branch-coverage claim. Reports are available from the workflow's artifacts. The audit badge reports known dependency advisories found by `pip-audit` and `npm audit`; it is not a full code-security certification.

Tests use temporary datasets, local HTTP stand-ins and a simulated browser DOM with canvas/image replacements. For UI changes, also check a real browser with a small dataset: image loading, source switching, depth/model navigation, annotation import/export and save/reload where applicable. Unit coverage does not establish visual correctness, scientific quality or performance on your full dataset.

Before submitting a pull request, explain the problem, resulting behaviour and validation. Add meaningful tests for changed behaviour, keep both coverage gates passing, and include screenshots for visible changes. Do not commit real dataset files, generated reports or credentials. Documentation corrections are welcome without adding implementation-mirroring tests.

## Licenses

Application code is distributed under the [MIT License](LICENSE). The bundled [Inter font](https://github.com/rsms/inter) retains its [SIL Open Font License](LICENSE-Inter.txt).

Dataset access, model outputs, labels and other research assets retain their owners' licenses and usage conditions. The application's MIT license does not grant rights to third-party data.
