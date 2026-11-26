"""CLI and lifecycle behavior: no real process, network or deployment is modified."""

import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from ink_viewer.deployment import deploy_runtime, publish_preview, viewerctl
from ink_viewer.server import s3cache_proxy as proxy


class Commands(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        (self.data / "all-gallery").mkdir()
        (self.data / "all-gallery/manifest.json").write_text("[]")
        self.addCleanup(patch.stopall)
        for name in (
            "ROOT",
            "CACHE",
            "LOG_FILE",
            "SCROLL",
            "ROLLO",
            "ESPEJO",
            "LABELS_UNKNOWN",
            "PORT",
            "writer_put",
            "s3_once",
        ):
            patch.object(proxy, name, getattr(proxy, name)).start()

    def invoke(self, module, args):
        output = io.StringIO()
        with patch.object(sys, "argv", ["command", *args]), contextlib.redirect_stdout(output):
            module.main()
        return output.getvalue()

    def test_server_cli_source_config_legacy_and_validation(self):
        cfg = self.root / "settings/source.json"
        flags = ["--config", str(cfg), "--origen", str(self.data)]
        info = json.loads(self.invoke(proxy, [*flags, "--dry-run"]))
        self.assertEqual(info["origen"], str(self.data))
        self.assertFalse(cfg.exists())
        cfg.parent.mkdir()
        cfg.write_text(json.dumps({"origen": str(self.data)}))
        annotations = self.root / "labels"
        annotations.mkdir()
        info = json.loads(
            self.invoke(
                proxy, ["--config", str(cfg), "--anotaciones", str(annotations), "--dry-run"]
            )
        )
        self.assertTrue(info["escritura"])
        with patch.object(proxy, "ThreadingHTTPServer") as factory:
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            self.invoke(proxy, flags)
            self.assertEqual(factory.call_args.args[0][0], "127.0.0.1")
            self.assertTrue(factory.return_value.fuente)
            cfg.unlink()
            self.invoke(proxy, ["--config", str(cfg), "--raiz", str(self.data)])
        info = json.loads(
            self.invoke(proxy, ["--config", str(cfg), "--raiz", str(self.data), "--dry-run"])
        )
        self.assertEqual(info["raiz"], str(self.data))
        for args in ([*flags, "--raiz", str(self.data)], [*flags, "--s3-endpoint", "invalid"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.invoke(proxy, args)
        english = json.loads(
            self.invoke(
                proxy,
                [
                    "--config",
                    str(cfg),
                    "--source",
                    str(self.data),
                    "--annotations",
                    str(annotations),
                    "--dry-run",
                ],
            )
        )
        self.assertEqual(english["origen"], str(self.data))
        self.assertTrue(english["escritura"])
        hf = [
            "--config",
            str(cfg),
            "--source",
            str(self.data),
            "--annotations",
            str(annotations),
            "--annotations-hf",
            "me/labels",
        ]
        self.assertEqual(
            json.loads(self.invoke(proxy, [*hf, "--dry-run"]))["annotations_hf"], "me/labels"
        )
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.invoke(
                proxy,
                [
                    "--config",
                    str(cfg),
                    "--source",
                    str(self.data),
                    "--annotations-hf",
                    "me/labels",
                    "--dry-run",
                ],
            )
        with (
            patch.object(proxy, "ThreadingHTTPServer") as factory,
            patch.object(proxy, "HFSync") as sync,
        ):
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            self.invoke(proxy, hf)
            sync.assert_called_once_with("me/labels")
            self.assertIs(factory.return_value.hf_sync, sync.return_value)
            sync.side_effect = RuntimeError("no token")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.invoke(proxy, hf)
        with patch.object(proxy, "main") as main, patch.object(sys, "argv", ["ink-viewer"]):
            runpy.run_module("ink_viewer", run_name="__main__")
            main.assert_called_once()

    def test_deployment_cli_routes_commands_and_preserves_errors(self):
        site = self.root / "site"
        settings = {"name": "fixture", "port": 18101, "preview_port": 18102, "mode": "source"}
        mocks = {
            name: MagicMock(return_value={})
            for name in (
                "init_site",
                "prepare",
                "start",
                "stop",
                "promote",
                "load_settings",
                "verify_release",
                "health",
            )
        }
        mocks["prepare"].return_value = "a" * 40
        mocks["load_settings"].return_value = settings
        mocks["verify_release"].return_value = {"commit": "a" * 40}
        with contextlib.ExitStack() as stack:
            for name, value in mocks.items():
                stack.enter_context(patch.object(viewerctl, name, value))
            base = ["--site", str(site)]
            for args in (
                ["init", "--origin", str(self.data)],
                ["update", "--prepare-only", "--no-fetch"],
                ["update"],
                ["start"],
                ["stop"],
                ["promote"],
                ["rollback"],
                ["status"],
            ):
                self.assertTrue(self.invoke(viewerctl, [*base, *args]))
            mocks["health"].side_effect = OSError("offline")
            self.assertIn("null", self.invoke(viewerctl, [*base, "status"]))
            mocks["start"].side_effect = ValueError("occupied")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.invoke(viewerctl, [*base, "start"])
            with patch.object(deploy_runtime, "serve") as serve:
                self.invoke(
                    viewerctl, [*base, "serve", "--channel", "preview", "--nonce", "fixture"]
                )
                serve.assert_called_once_with(site, "preview", "fixture")

    def test_deployment_runtime_uses_external_state_and_readonly_preview(self):
        site = self.root / "site"
        release = self.root / "release"
        release.mkdir()
        site.mkdir()
        (site / "preview").symlink_to(release, target_is_directory=True)
        settings = {
            "name": "fixture",
            "mode": "source",
            "preview_port": 18102,
            "port": 18101,
            "env": {},
        }
        (site / "origin.json").write_text(json.dumps({"origen": str(self.data)}))
        with (
            patch.object(viewerctl, "load_settings", return_value=settings),
            patch.object(viewerctl, "verify_release", return_value={"commit": "a" * 40}),
            patch.object(deploy_runtime, "SOURCE_ROOT", release),
            patch.object(proxy, "ThreadingHTTPServer") as factory,
        ):
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            deploy_runtime.serve(site, "preview", "nonce")
            self.assertEqual(factory.call_args.args[0], ("127.0.0.1", 18102))
            self.assertEqual(factory.return_value.config_path, site / "state/preview/origin.json")
            self.assertTrue(factory.return_value.fuente.anotaciones.endswith("preview/annotations"))
            with self.assertRaises(PermissionError):
                proxy.writer_put("x", b"x")
            factory.return_value.server_close.assert_called_once()
            settings["mode"] = "legacy"
            settings["env"] = {"PIPELINE": "fixture"}
            with patch.dict(os.environ, {}, clear=False):
                deploy_runtime.serve(site, "preview", "nonce")
            self.assertIsNone(factory.return_value.fuente)
        with (
            patch.object(viewerctl, "load_settings", return_value=settings),
            patch.object(deploy_runtime, "SOURCE_ROOT", self.root / "other"),
            self.assertRaises(ValueError),
        ):
            deploy_runtime.serve(site, "preview", "nonce")

    def test_publish_cli_builds_selected_bundle_and_safe_remote_command(self):
        commit = "a" * 40
        with (
            patch.object(
                publish_preview.subprocess,
                "check_output",
                side_effect=[commit + "\n", "git@github.com:example/viewer.git\n"],
            ),
            patch.object(publish_preview.subprocess, "run") as run,
            patch.object(publish_preview, "code_bundle") as bundle,
        ):

            def write_bundle(repo, ref, dest):
                dest.write_bytes(b"fixture bundle")

            bundle.side_effect = write_bundle
            self.invoke(
                publish_preview,
                [
                    "--host",
                    "user@example.invalid",
                    "--remote-site",
                    "/srv/site",
                    "--remote-code",
                    "/srv/code",
                    "--ssh-port",
                    "2222",
                    "--identity",
                    str(self.root / "key"),
                ],
            )
            args = run.call_args.args[0]
            self.assertIn("-p", args)
            self.assertIn("2222", args)
            self.assertIn("-i", args)
            self.assertEqual(args[-2], "user@example.invalid")
            self.assertIn("python3 -c ", args[-1])
            self.assertIn("/srv/site", args[-1])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.invoke(
                publish_preview,
                ["--host", "bad;host", "--remote-site", "/s", "--remote-code", "/c"],
            )
        with self.assertRaises(ValueError):
            publish_preview.code_bundle(self.root, "invalid", self.root / "bad.bundle")

