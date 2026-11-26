"""Paths shared by HTTP assets and immutable source releases."""

from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = PACKAGE_ROOT.parent.parent
WEB_ROOT = PACKAGE_ROOT / "web"
RELEASE_FILES = (
    "pyproject.toml",
    "src/ink_viewer/server/s3cache_proxy.py",
    "src/ink_viewer/deployment/deploy_runtime.py",
    "src/ink_viewer/deployment/viewerctl.py",
    "src/ink_viewer/web/index.html",
)


def web_asset(name):
    """Resolve only known source asset types; the HTTP handler applies its allowlist."""
    suffix = Path(name).suffix
    folder = {
        ".js": "js",
        ".css": "css",
        ".woff2": "fonts",
        ".html": "pages",
        ".webp": "images",
    }.get(suffix)
    return name if name == "index.html" else f"{folder}/{name}"


# Existing immutable releases remain valid rollback targets.
LEGACY_RELEASE_FILES = ("index.html", "s3cache_proxy.py", "deploy_runtime.py", "viewerctl.py")
