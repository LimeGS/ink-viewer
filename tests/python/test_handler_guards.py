import json
import unittest
import urllib.error
import urllib.request

from ink_viewer.deployment import deploy_runtime
from ink_viewer.server import s3cache_proxy as proxy
from test_fuentes import servidor


class HandlerGuards(unittest.TestCase):
    def test_preview_health_headers_and_write_restrictions(self):
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
            # The preview source is fixed; with no source nothing can be saved.
            for path, code in (("/api/origen", 403), ("/api/mascara-par/x", 503)):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(
                        urllib.request.Request(base + path, data=b"{}", method="POST")
                    )
                self.assertEqual(error.exception.code, code)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(
                    urllib.request.Request(
                        base + "/api/deploy", headers={"Host": "external.invalid"}
                    )
                )
            self.assertEqual(error.exception.code, 403)
