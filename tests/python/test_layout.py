"""Integration checks for installed package paths and browser asset URLs."""

import gzip
import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from ink_viewer.paths import WEB_ROOT
from ink_viewer.server import s3cache_proxy as proxy
from ink_viewer.server.fuentes import Fuente
from test_fuentes import servidor


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "link", "img"):
            value = attrs.get("src") or attrs.get("href")
            if (
                value
                and not value.startswith(("data:", "/", "../", "derived-"))
                and value != "manifest.js"
            ):
                self.urls.add(value)


class PackageLayout(unittest.TestCase):
    def test_entrypoint_runs_outside_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ink_viewer",
                    "--origen",
                    tmp,
                    "--config",
                    str(Path(tmp) / "source.json"),
                    "--dry-run",
                ],
                cwd=tmp,
                text=True,
                capture_output=True,
                check=True,
            )
            config = json.loads(result.stdout)
            self.assertEqual(config["codigo"], str(WEB_ROOT))
            self.assertEqual(config["origen"], str(Path(tmp).resolve()))
            self.assertFalse((Path(tmp) / "source.json").exists())

    def test_page_assets_and_legacy_aliases_are_served(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "all-gallery").mkdir()
            (root / "all-gallery/manifest.json").write_text("[]")
            with servidor(proxy.Handler, Fuente(tmp)) as (_, base):

                def get(url):
                    with urllib.request.urlopen(
                        urllib.request.Request(
                            base + "/all-gallery/" + url, headers={"Accept-Encoding": "gzip"}
                        )
                    ) as response:
                        data = response.read()
                        return (
                            gzip.decompress(data)
                            if response.headers.get("Content-Encoding") == "gzip"
                            else data
                        )

                page = get("index.html").decode()
                parser = Assets()
                parser.feed(page)
                self.assertIn("js/viewer.js", parser.urls)
                self.assertIn("css/viewer.css", parser.urls)
                self.assertNotIn("function select(", page)
                for url in sorted(parser.urls):
                    with self.subTest(url=url):
                        body = get(url)
                        self.assertTrue(body)
                        if url != "js/viewer-tools.js":
                            self.assertEqual(body, (WEB_ROOT / urlsplit(url).path).read_bytes())
                self.assertEqual(get("js/explorer_pro.js"), get("explorer_pro.js"))
                self.assertEqual(get("css/grilli.css"), get("grilli.css"))
                self.assertTrue(get("fonts/inter-17fe38ab302c7e5d.woff2").startswith(b"wOF2"))
                with self.assertRaises(urllib.error.HTTPError):
                    get("server/s3cache_proxy.py")


if __name__ == "__main__":
    unittest.main()
