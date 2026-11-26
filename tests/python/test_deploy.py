import argparse
import base64
import json
import shutil
import socket
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import ink_viewer.server.s3cache_proxy as proxy
from ink_viewer.deployment import deploy_runtime, publish_preview, viewerctl
from ink_viewer.server.fuentes import Fuente
from test_fuentes import servidor
from test_mask_pair import png


class Deployment(unittest.TestCase):
    def test_publication_excludes_other_refs_and_rejects_deleted_data_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()

            def git(*args):
                return subprocess.check_output(
                    ["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL, text=True
                ).strip()

            git("init")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            (repo / "index.html").write_text("viewer source")
            for name in (
                "src/ink_viewer/__init__.py",
                "src/ink_viewer/web/js/viewer.js",
                "tests/python/test_fixture.py",
                ".github/workflows/tests.yml",
                "docs/architecture.md",
                "docs/guide.md",
                "pyproject.toml",
                "package.json",
                "package-lock.json",
                ".c8rc.json",
                ".github/workflows/audit.yml",
                # Repository metadata the real history holds (publication refused it before).
                ".github/workflows/lint.yml",
                "Dockerfile",
                ".dockerignore",
                "docs/images/ui-overview.jpg",
            ):
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text("source fixture")
            (repo / "LICENSE").write_text("project license")
            (repo / "LICENSE-Inter.txt").write_text("font license")
            (repo / "inter-17fe38ab302c7e5d.woff2").write_bytes(b"font fixture")
            git("add", ".")
            git("commit", "-m", "source")
            good = git("rev-parse", "HEAD")
            initial_branch = git("branch", "--show-current")
            git("checkout", "-b", "unrelated")
            (repo / "local-config.json").write_text('{"fixture":true}')
            git("add", ".")
            git("commit", "-m", "unrelated data")
            git("update-ref", "refs/remotes/origin/source-only", good)
            git("branch", "-D", initial_branch)
            refs_before = git("show-ref")
            bundle = root / "source.bundle"
            publish_preview.code_bundle(repo, good, bundle)
            self.assertEqual(git("show-ref"), refs_before, "Publication must preserve local refs")
            self.assertEqual(git("bundle", "list-heads", str(bundle)).split()[0], good)
            clone = root / "clone"
            subprocess.run(["git", "clone", "-q", str(bundle), str(clone)], check=True)
            self.assertTrue((clone / "index.html").is_file())
            self.assertTrue((clone / "src/ink_viewer/web/js/viewer.js").is_file())
            self.assertTrue((clone / "docs/guide.md").is_file())
            self.assertEqual((clone / "inter-17fe38ab302c7e5d.woff2").read_bytes(), b"font fixture")
            self.assertTrue((clone / "LICENSE-Inter.txt").is_file())
            self.assertFalse((clone / "local-config.json").exists())
            self.assertTrue((clone / "docs/images/ui-overview.jpg").is_file())
            git("rm", "local-config.json")
            git("commit", "-m", "remove data at tip")
            blocked = root / "blocked.bundle"
            with self.assertRaisesRegex(ValueError, "data/configuration"):
                publish_preview.code_bundle(repo, git("rev-parse", "HEAD"), blocked)
            self.assertFalse(blocked.exists())

    def args(self, data_root, **extra):
        values = dict(
            origin=str(data_root),
            source_config=None,
            annotations=None,
            scroll=None,
            from_port=None,
            name="fixture",
            port=18797,
            preview_port=18897,
        )
        values.update(extra)
        return argparse.Namespace(**values)

    def test_update_and_rollback_pointers_preserve_configuration_and_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, site, data = root / "repo", root / "deploy", root / "assets"
            repo.mkdir()
            data.mkdir()
            (data / "map.png").write_bytes(b"original-map")

            def git(*args):
                return subprocess.check_output(
                    ["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL, text=True
                ).strip()

            git("init")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            for file in viewerctl.LEGACY_RELEASE_FILES:
                (repo / file).write_text("first")
            git("add", ".")
            git("commit", "-m", "first")
            first = git("rev-parse", "HEAD")
            viewerctl.init_site(site, self.args(data))
            before = {name: (site / name).read_bytes() for name in ("site.json", "origin.json")}
            self.assertEqual(viewerctl.prepare(site, repo, "HEAD", False), first)
            # Old immutable releases must keep their script entry point for rollback.
            with (
                patch.object(viewerctl.subprocess, "Popen") as launch,
                patch.object(viewerctl.socket, "socket") as sock,
                patch.object(viewerctl.secrets, "token_hex", return_value="fixture"),
                patch.object(viewerctl, "health", return_value={"nonce": "fixture"}),
            ):
                sock.return_value.__enter__.return_value.connect_ex.return_value = 1
                launch.return_value.poll.return_value = None
                launch.return_value.pid = 999999
                viewerctl.start(site, "preview")
                self.assertEqual(
                    launch.call_args.args[0][2], str((site / "preview").resolve() / "viewerctl.py")
                )
                self.assertEqual(
                    launch.call_args.kwargs["env"]["PYTHONPATH"], str((site / "preview").resolve())
                )
            viewerctl.point(site, "current", (site / "preview").resolve())
            (repo / "index.html").write_text("second")
            git("add", ".")
            git("commit", "-m", "second")
            second = viewerctl.prepare(site, repo, "HEAD", False)
            self.assertNotEqual(first, second)
            self.assertEqual((site / "current").resolve().name, first)
            with (
                patch.object(viewerctl, "health", return_value={"commit": second, "preview": True}),
                patch.object(viewerctl, "stop"),
                patch.object(viewerctl, "start", return_value={"ok": True}),
            ):
                viewerctl.promote(site)
                self.assertEqual((site / "current").resolve().name, second)
                self.assertEqual((site / "previous").resolve().name, first)
                viewerctl.promote(site, rollback=True)
                self.assertEqual((site / "current").resolve().name, first)
            for name, body in before.items():
                self.assertEqual((site / name).read_bytes(), body)
            self.assertEqual((data / "map.png").read_bytes(), b"original-map")
            with self.assertRaises(ValueError):
                viewerctl.init_site(site, self.args(data))
            (site / "preview/index.html").write_text("uncommitted-edit")
            with self.assertRaises(ValueError):
                viewerctl.verify_release((site / "preview").resolve())

    def test_release_process_uses_packaged_source_and_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, site, data = root / "repo", root / "site", root / "data"
            repo.mkdir()
            (data / "all-gallery").mkdir(parents=True)
            (data / "all-gallery/manifest.json").write_text("[]")
            checkout = Path(__file__).resolve().parents[2]
            shutil.copytree(
                checkout / "src/ink_viewer",
                repo / "src/ink_viewer",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
            shutil.copyfile(checkout / "pyproject.toml", repo / "pyproject.toml")

            def git(*args):
                return subprocess.check_output(
                    ["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL, text=True
                ).strip()

            git("init")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            git("add", ".")
            git("commit", "-m", "packaged release")
            sockets = [socket.socket(), socket.socket()]
            try:
                for sock in sockets:
                    sock.bind(("127.0.0.1", 0))
                port, preview_port = [sock.getsockname()[1] for sock in sockets]
            finally:
                for sock in sockets:
                    sock.close()
            viewerctl.init_site(site, self.args(data, port=port, preview_port=preview_port))
            commit = viewerctl.prepare(site, repo, "HEAD", False)
            started = False
            try:
                health = viewerctl.start(site, "preview")
                started = True
                self.assertEqual(health["commit"], commit)
                with urllib.request.urlopen(health["url"]) as response:
                    self.assertIn(b'src="js/viewer.js"', response.read())
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{preview_port}/all-gallery/js/viewer.js"
                ) as response:
                    self.assertEqual(
                        response.read(), (repo / "src/ink_viewer/web/js/viewer.js").read_bytes()
                    )
                self.assertFalse((site / "current").exists())
                self.assertEqual((data / "all-gallery/manifest.json").read_text(), "[]")
            finally:
                if started:
                    viewerctl.stop(site, "preview")

    def test_preview_annotations_do_not_touch_source_and_cannot_change_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data, annotations = root / "assets", root / "preview-annotations"
            (data / "all-gallery").mkdir(parents=True)
            annotations.mkdir()
            (data / "all-gallery/manifest.json").write_text("[]")
            source = Fuente(str(data), anotaciones=str(annotations))
            handler = deploy_runtime.handler_for(
                proxy, dict(commit="a" * 40, channel="preview", preview=True), True
            )
            with (
                patch.object(proxy, "LOG_FILE", root / "log"),
                servidor(handler, source, root / "production-config.json") as (_, base),
            ):

                def request(path, body=None, headers=None):
                    return urllib.request.urlopen(
                        urllib.request.Request(base + path, data=body, headers=headers or {})
                    )

                with request("/api/deploy") as response:
                    self.assertTrue(json.load(response)["preview"])
                headers = {"X-Visor-Origen": source.id, "Content-Type": "application/json"}
                metadata = {
                    "lamina": "lam",
                    "segmento": "lam",
                    "base": "PHerc0306B/segments/s",
                    "ancho": 2,
                    "alto": 2,
                    "profundidad": 4,
                    "run_id": "fixture-run",
                    "par_id": "preview-pair",
                    "cara": None,
                    "orientacion": {"correccion": [0, 0, 0]},
                }
                image = base64.b64encode(png(255, corrida=metadata)).decode()
                payload = json.dumps(
                    {"inklabels": image, "supervision_mask": image, "corrida": metadata}
                ).encode()
                with request(
                    "/api/mascara-par/lam?c=4&base=PHerc0306B/segments/s&rollo=PHerc0306B",
                    payload,
                    headers,
                ) as response:
                    saved = json.load(response)
                    self.assertEqual(saved["destino"], "anotaciones-locales")
                self.assertFalse(any(data.rglob("*.png")))
                self.assertEqual(
                    source.mascara_local("catalog/" + saved["clave_profundidad"]).read_bytes(),
                    png(255, corrida=metadata),
                )
                with self.assertRaises(urllib.error.HTTPError) as e:
                    request("/api/origen", b"{}", headers)
                self.assertEqual(e.exception.code, 403)
                self.assertFalse((root / "production-config.json").exists())
                with request("/index.html") as response:
                    self.assertEqual(response.headers["X-Visor-Version"], "a" * 40)

    def test_catalog_metadata_alias_uses_only_selected_local_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "catalog/_viewer").mkdir(parents=True)
            (root / "catalog/_viewer/compuertas.json").write_text(
                '{"laminas":{"local":{"fisico":"PASS"}}}'
            )
            (root / "catalog/_viewer/metadata.json").write_text(
                '{"scroll":"PHercX","TABLA":{"local":[1,2]}}'
            )
            source = Fuente(tmp)
            with servidor(proxy.Handler, source) as (_, base):
                with urllib.request.urlopen(base + "/all-gallery/compuertas.json") as response:
                    self.assertEqual(json.load(response)["laminas"]["local"]["fisico"], "PASS")
                with urllib.request.urlopen(base + "/all-gallery/metadata.json") as response:
                    self.assertEqual(json.load(response)["TABLA"]["local"], [1, 2])
                (root / "all-gallery").mkdir()
                (root / "all-gallery/compuertas.json").write_text('{"local-copy":true}')
                with urllib.request.urlopen(base + "/all-gallery/compuertas.json") as response:
                    self.assertTrue(json.load(response)["local-copy"])
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(base + "/all-gallery/secret.json")
                self.assertEqual(e.exception.code, 404)

    def test_running_source_import_keeps_assets_annotations_and_scroll_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data, annotations = root / "assets", root / "labels"
            (data / "all-gallery").mkdir(parents=True)
            annotations.mkdir()
            (data / "all-gallery/manifest.json").write_text("[]")
            (data / "rollos/PHerc1447").mkdir(parents=True)
            physical = {"scroll": "PHerc1447", "voxel_um": 3.4, "paso_hoja_um": 17}
            (data / "rollos/PHerc1447/rollo.json").write_text(json.dumps(physical))
            source = Fuente(str(data), anotaciones=str(annotations))
            with servidor(proxy.Handler, source) as (srv, _):
                viewerctl.init_site(
                    root / "deploy", self.args(data, origin=None, from_port=srv.server_port)
                )
            imported = json.loads((root / "deploy/origin.json").read_text())
            self.assertEqual(imported["origen"], str(data.resolve()))
            self.assertEqual(imported["anotaciones"], str(annotations.resolve()))
            self.assertEqual(viewerctl.load_settings(root / "deploy")["env"], {})
            # Physical metadata stays with the source; the profile keeps no copy.
            self.assertFalse((root / "deploy/rollos").exists())
            self.assertEqual(proxy.cargar_rollo("PHerc1447", Fuente(imported["origen"])), physical)
            self.assertNotIn("token", imported)


if __name__ == "__main__":
    unittest.main()
