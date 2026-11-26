import contextlib
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from ink_viewer.deployment import deploy_runtime
from ink_viewer.server import s3cache_proxy as proxy
from ink_viewer.server import vast_server
from test_fuentes import servidor


class HandlerGuards(unittest.TestCase):
    def test_preview_health_headers_and_legacy_write_restrictions(self):
        deployment = {"commit": "a" * 40, "preview": True, "channel": "preview"}
        handler = deploy_runtime.handler_for(proxy, deployment, preview=True)
        with servidor(handler) as (_, base):
            with urllib.request.urlopen(
                urllib.request.Request(base + "/api/deploy", method="HEAD")
            ) as response:
                self.assertEqual(response.read(), b"")
                self.assertEqual(response.headers["X-Visor-Version"], "a" * 40)
            with urllib.request.urlopen(base + "/api/origen") as response:
                self.assertFalse(json.load(response)["escritura"])
            for path in ("/api/origen", "/api/mascara-par/x"):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(
                        urllib.request.Request(base + path, data=b"{}", method="POST")
                    )
                self.assertEqual(error.exception.code, 403)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(
                    urllib.request.Request(
                        base + "/api/deploy", headers={"Host": "external.invalid"}
                    )
                )
            self.assertEqual(error.exception.code, 403)

    def test_vast_entrypoint_binds_loopback_and_loads_existing_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp)
            (site / "cache/_viewer").mkdir(parents=True)
            (site / "cache/_viewer/manifest.json").write_text('[{"id":"fixture"}]')
            with (
                patch("sys.argv", ["vast", "--site", str(site), "--port", "18102"]),
                patch.object(vast_server, "VastSource") as source,
                patch.object(proxy, "configurar"),
                patch.object(proxy, "LOG_FILE", None),
                patch.object(vast_server, "ThreadingHTTPServer") as server,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                vast_server.main()
                source.return_value.verificar.assert_called_once()
                self.assertEqual(server.call_args.args[0], ("127.0.0.1", 18102))
                self.assertEqual(server.return_value.runs, [{"id": "fixture"}])
                server.return_value.serve_forever.assert_called_once()
