# Architecture

The application is a Python package with a server-rendered entry page and browser-side JavaScript. It uses the existing HTTP server and native browser APIs. Web assets ship inside the Python package; no frontend build step is required.

## Component boundaries

- `server`: HTTP routing, data-source access, canonical mask validation and the read-only Vast adapter. It serves source assets from `web`, independently of the selected dataset.
- `catalog`: filename conventions, inventory discovery, generated manifests, existing measured v5 scores and imported scientific gates. Generated indexes live at the selected dataset or deployment, outside the code checkout.
- `deployment`: immutable Git releases, preview isolation, promotion/rollback and the existing Vast process controller. It operates on explicit deployment directories and preserves machine-owned settings and data.
- `web`: markup, styles, browser behavior and bundled branding. `js/viewer.js` contains the main viewer logic previously embedded in the HTML; the remaining UI tools retain their original modules and execution order.

`paths.py` owns static asset and release locations. Imports use the `ink_viewer` namespace. Runtime data, annotations, caches, credentials and machine profiles do not belong in `src`.

## Browser loading

The page keeps its `/all-gallery/index.html` URL and dataset-relative links. Assets use `/all-gallery/js`, `/all-gallery/css`, `/all-gallery/fonts` and `/all-gallery/images`. Existing flat asset URLs remain aliases for cached clients. The server still generates `manifest.js` and the ordered `js/viewer-tools.js` bundle, with compression and ETag revalidation.

The main script and UI tools remain classic scripts: they share established viewer state. Changing them to ES modules requires explicitly separating that state and is a subsequent behavior change, not part of this directory migration. Native image coordinates, annotation ownership, physical metadata and score provenance remain unchanged.

## Running and testing

Install with `python -m pip install -e .` in a virtual environment. Use `ink-viewer` or `python -m ink_viewer`; all CLI entry points are declared in `pyproject.toml`. Python tests use unittest and temporary local datasets; JavaScript tests use Node's built-in test runner through `npm test`.

Source releases are complete Git archives, including `src` and package metadata. The release manager also recognizes flat immutable releases, preserving existing rollback targets. New child processes load the selected release's `src` directory explicitly rather than the development checkout. Preview publication checks the full selected Git history against source-only paths, including the old flat layout for existing history. Deployment commands require a source checkout; installing the runtime wheel does not create a Git repository.

The GitHub workflow installs the distributable package before testing, exercising package imports and installed static assets. A development change should pass both suites and a local browser check before deployment. Reorganizing this repository does not migrate the running Vast service or its external SSH launcher automatically.
