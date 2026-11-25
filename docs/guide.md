# User and deployment guide

Detailed reference for dataset publishers, self-hosted deployments and contributors. Start with the [README](../README.md) for installation and everyday use.

- [Prepare a dataset](#prepare-a-dataset)
- [Browse the official Vesuvius Challenge maps](#browse-the-official-vesuvius-challenge-maps)
- [Connect to public S3](#connect-to-public-s3)
- [Authenticated S3 and compatible storage](#authenticated-s3-and-compatible-storage)
- [Configuration](#configuration)
- [Deploy on your own server](#deploy-on-your-own-server)
- [Managed releases, previews and rollback](#managed-releases-previews-and-rollback)
- [Annotation formats and integrity](#annotation-formats-and-integrity)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Development reference](#development-reference)

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

This file belongs in `PHerc0306B/segments/example/ink-detection/`. PNG and single-page integer TIFF maps are supported. Arbitrarily named images are reported as unrecognized rather than assigned invented provenance. See [the filename parser](../src/ink_viewer/catalog/catalog_names.py) for accepted names and [the manifest generator](../src/ink_viewer/catalog/generar_manifest.py) for the schema.

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

## Browse the official Vesuvius Challenge maps

`--source official` opens every ink map the team publishes in the open-data bucket, with no download and no credentials:

```sh
ink-viewer --source official
```

The index comes from the bucket's own `metadata.json` (the team's catalog of samples, segments and data items). On start, and when the cached copy is older than `VISOR_OFFICIAL_MAX_AGE_HOURS` (default 24), the server downloads it, keeps one entry per `ink-detection` item with its model, volume and direction, and caches the result under `VISOR_OFFICIAL_CACHE` (default `~/.cache/ink-viewer/official`). New team runs therefore appear on the next refresh; if a refresh fails, the previous index is kept. Maps are read from the bucket over HTTPS; 1/8-scale views use the JPEG the team publishes beside each map instead of decoding the full-resolution TIFF. Maps too large for a browser at full resolution (over `VISOR_MAX_FULLRES_PIXELS`, default 150 Mpx; Chrome refuses canvases over 268 Mpx and labeling lags well before that; whole PHercParis4 segments reach 2.4 Gpx) open as a reduced, browse-only view: the 1/4 map, or the published 1/8 JPEG when the map is also over `VISOR_MAX_MAP_PIXELS` (default 1 Gpx). Labeling needs full resolution: on these maps press **Label a crop**, then click the reduced view, and an 8192 px full-resolution window opens there that labels like any map (**Whole map** goes back). Each crop keeps its own mask pair under `labels/.../recorte-x<x>-y<y>-<width>x<height>/`, with the window and the whole map's size recorded as `recorte` in its provenance, so crops never overwrite each other or a whole-map pair; cross-sections from a crop map back to the whole map. Cropping maps over 1 Gpx reads only the strips or tiles inside the window and needs `pip install "ink-viewer[crop]"` (tifffile and imagecodecs). Cross-sections on the reduced view use the proportional mapping. Mesh association is reported as unverified. Annotations work as with any other source when `--annotations` is given.

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
| `--origen` | `VISOR_ORIGEN` | Local folder, HTTP/HTTPS root, S3 prefix or `official` |
| `--anotaciones` | `VISOR_ANOTACIONES` | Separate local annotation directory |
| `--annotations-hf` | `VISOR_ANNOTATIONS_HF` | Also push each saved mask pair to a Hugging Face dataset (`user/dataset`) |
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

See [Security](#security) before sharing access. A static S3 website alone cannot host the complete application: the Python API is required for source access and validated server saves.

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

## Generate maps with ink-sdk (optional)

The viewer can run a public ink model on a segment through [ink-sdk](https://github.com/LimeGS/ink-sdk) and show the result like any catalog map. It is off unless you point it at a Python environment where ink-sdk is installed (GPU and checkpoints are ink-sdk's own requirements):

```sh
python -m pip install -e ".[inksdk]"     # numpy, used to write the generated maps
export INK_SDK_PYTHON=/path/to/ink-sdk/.venv/bin/python
export VILLA=/path/to/villa VILLA_PY=/path/to/villa/ink-detection/.venv/bin/python   # 9 um models only
ink-viewer --origen /absolute/path/to/catalog --anotaciones ~/ink-notes   # or any indexed HTTP/S3 source
```

Inputs are the segment's published surface volumes, `<sample>/segments/<segment>/surface-volumes/<res>um-[<dist>m-]<keV>keV-volume-<id>.zarr`, read through the same source (local, HTTP or S3). Only level 0 is used; it is copied chunk by chunk into `INK_VIEWER_SV_CACHE` (default `~/.cache/ink-viewer/surface-volumes`, refused above `INK_VIEWER_SV_MAX_GB`, default 16). A model is offered for a volume only when the volume's resolution is within the model's declared scale tolerance.

Outputs are never written to the source. Each job writes, under the annotations folder at `<anotaciones>/<source id>/generated/`, one catalog-named PNG per depth direction (model field `<profile>-fwd` / `-rev`), browsing previews, a receipt with the full ink-sdk receipt and the depth window, and a generated index that the server appends to the manifest (`fam`: `ink-sdk (generated here)`). Without an annotations folder the source is read-only and jobs are refused. Jobs run one at a time.

In the viewer, a **Run model** button appears in the toolbar only when ink-sdk is available and the source has an annotations folder. It opens a dialog for the open catalog segment: pick one of its surface volumes and a compatible model, then Run. The dialog follows the job and reloads the page when the maps are ready; they appear in the segment's list beside the source's own maps.

| Endpoint | Purpose |
|---|---|
| `GET /api/inksdk` | availability, reason, profiles |
| `GET /api/inksdk/volumenes?rollo=&segmento=` | surface volumes of a segment and the compatible profiles |
| `GET /api/inksdk/trabajos` | jobs and their state (`en cola`, `copiando`, `inferencia`, `listo`, `error`) |
| `POST /api/inksdk/trabajos` | `{"rollo", "segmento", "volumen", "perfil"}`; same origin and `X-Visor-Origen` checks as annotation writes |

The depth window matters: moving a 9 um model's 17-layer window by one layer can change the map noticeably, and stacks with an even number of layers have no single centre. The receipt records the window ink-sdk used, so maps read from different windows are not compared blind.

## Cross-sections (optional)

The **Cross-section** button turns on a mode where clicking a point on the map opens a slice of the raw CT through that point, with the segment's mesh drawn in orange and the point in cyan. A curve that follows the layers is a surface sitting on a sheet; one that cuts across them has crossed to another sheet, so a mark there may belong to the neighbouring sheet. Click and drag still pans; only a click without movement opens the slice.

It needs `python -m pip install -e ".[corte]"` (numpy, tifffile, numcodecs) and a source with the public layout: `<sample>/segments/<segment>/mesh/<segment-id>-on-<volume>-<res>um.tifxyz/` and `<sample>/volumes/<volume>-...zarr`. The map's catalog name says which CT volume it was rendered from (`-volume-<id>-`), and the mesh and the CT with that id are used; maps without a volume id cannot be matched. The slice is axial (one z plane, 512 voxels around the point, level 0), read chunk by chunk through the same source; only the chunks under the window are fetched. The map point is placed on the mesh grid with the mesh scale; when the map size does not match the mesh, the mapping falls back to proportional and the slice says so. Sources that cannot list folders (HTTP) use the public naming, built from the map name's resolution, distance and energy; volumes with an extra tag in their name (for example `-pag0-`) need a local or S3 source.

A local copy of the maps rarely holds the CT, so meshes and CT can come from another, read-only root of `PHerc...` folders: `--ct-origen https://vesuvius-challenge-open-data.s3.amazonaws.com` (or `VISOR_CT_ORIGEN`) reads them from the public bucket without credentials, fetching only the chunks under each slice. Without it they are read from the map source.

`GET /api/corte?rollo=&segmento=&volumen=&u=&v=[&w=&h=&tam=]` returns the PNG, with `X-Corte` (point in voxels, window, mapping) as a header.

Ported from the cross-section view of [Volumen](https://github.com/pscamillo/volumen) (MIT).

## Annotation formats and integrity

Annotations use the **full-resolution original raster**. Previews are browsing aids. Zoom, display filters, flips and transpose change the view, not the stored mask grid.

### Mirror annotations to Hugging Face

`--annotations-hf user/dataset` (with `--annotations`) also pushes every saved mask pair to a Hugging Face dataset, one commit per save: inklabels, supervision mask and the provenance JSON, at the same paths as in the local annotations folder, so a downloaded copy can be used as `--annotations` directly. The local folder stays the source of truth: the pair is validated and written there first, and the push runs in the background, so a slow or failed push never loses a save; failed files go out with the next one, and `/api/origen` reports the mirror's state. Install with `pip install "ink-viewer[hf]"`; the token comes from `HF_TOKEN` or `hf auth login` and stays on the server. A dataset that does not exist yet is created private.

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

## Security

### Deployment and data access

Ink Viewer assumes a trusted operator. It has no user accounts, per-user authorization or collaborative write isolation. The source picker can read local files and request remote URLs using the server account's permissions. Access to the application therefore grants more than access to the currently selected dataset.

- Keep the listener on loopback and use the documented SSH tunnel. A shared/public deployment needs an access-control layer and integration with the existing Host and Origin checks; HTTPS alone is not authentication.
- Run under a dedicated, unprivileged account with access only to the required data and annotation directories. Use read-only storage credentials for browsing; local annotation saves do not require source-bucket write permission.
- Keep credentials in the SDK's credential mechanisms, outside Git and browser code. Do not put keys in source URLs, config JSON, screenshots or reports. Review logs and dataset paths before sharing them.
- Back up external annotations and retain original data. Grid validation and atomic pair saves reduce annotation mistakes; they do not replace backups or establish scientific correctness.

The dependency audit runs on pushes and pull requests. A passing badge means the configured tools found no known dependency advisories at that time; it does not certify that application code or a deployment is vulnerability-free. Re-run the [documented checks](#run-checks) when updating dependencies.

### Report a vulnerability

Use **Report a vulnerability** on the repository's [Security tab](https://github.com/LimeGS/ink-viewer/security) if private reporting is available. If that option is unavailable, open a minimal issue asking the maintainers for a private reporting channel, without disclosing exploit steps or sensitive data publicly.

In the private report, include the affected version or commit, deployment context, expected and actual behaviour, impact, and a minimal reproduction using synthetic data. Redact credentials and private dataset details. Test only systems you own or are authorized to assess, and coordinate disclosure with the maintainers before publishing technical details.

## Development reference

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

Read [the architecture notes](architecture.md) before changing shared browser state or deployment behaviour. Keep application code under `src/`; put generated indexes, maps, masks, caches, local profiles and secrets outside the code checkout. Keep changes focused and preserve original image coordinates, mask ownership and documented physical calibration.

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

CI enforces **at least 90% line coverage separately for the complete Python package and all browser JavaScript files**, including unexecuted modules. This is not a 90% branch-coverage claim. Reports are available from the workflow's artifacts.

Tests use temporary datasets, local HTTP stand-ins and a simulated browser DOM with canvas/image replacements. For UI changes, also check a real browser with a small dataset: image loading, source switching, depth/model navigation, annotation import/export and save/reload where applicable. Unit coverage does not establish visual correctness, scientific quality or performance on your full dataset.


## Run with Docker

Build once, then point the container at a prepared dataset. Publish the port on
127.0.0.1 only: the server accepts saves and configuration changes only from loopback.

```sh
docker build -t ink-viewer .
docker run --rm --user "$(id -u):$(id -g)" -p 127.0.0.1:8797:8797 \
  -v /absolute/path/to/dataset:/data:ro \
  -v "$HOME/ink-viewer-annotations":/annotations \
  ink-viewer
```

`--user` lets the container read a catalog prepared on the host (the manifest generator
writes `_viewer/*.json` as 0600) and keeps saved masks owned by you.

Open http://127.0.0.1:8797/all-gallery/index.html. For a public S3 or HTTP dataset, skip
the `/data` mount and pass the origin instead, for example
`ink-viewer --origen https://YOUR_BUCKET.s3.YOUR_REGION.amazonaws.com/PREFIX --anotaciones /annotations`.
Outside Docker nothing changes: the server still listens on 127.0.0.1 unless `S3CACHE_BIND` is set.
