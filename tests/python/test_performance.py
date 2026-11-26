import gzip
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import ink_viewer.server.s3cache_proxy as proxy


class Performance(unittest.TestCase):
    def test_combined_tools_parse_and_invalidate(self):
        parts = tuple(
            (
                str(proxy.CODE / proxy.web_asset(name)),
                proxy.file_revision(proxy.CODE / proxy.web_asset(name)),
            )
            for name in proxy.VIEWER_TOOLS
        )
        body, compressed, _ = proxy.tools_bytes(parts)
        self.assertEqual(gzip.decompress(compressed), body)
        if shutil.which("node"):
            subprocess.run(["node", "--check"], input=body, check=True, capture_output=True)
        self.assertEqual(
            [body.index(("/* " + name + " */").encode()) for name in proxy.VIEWER_TOOLS],
            sorted(body.index(("/* " + name + " */").encode()) for name in proxy.VIEWER_TOOLS),
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "module.js"
            path.write_text("window.version=1;")
            first = proxy.tools_bytes(((str(path), proxy.file_revision(path)),))
            path.write_text("window.version=2;")
            # Same size and inode, written within one filesystem clock tick: move mtime
            # forward as a later real edit would, so the test does not depend on timing.
            later = path.stat().st_mtime_ns + 1_000_000_000
            os.utime(path, ns=(later, later))
            second = proxy.tools_bytes(((str(path), proxy.file_revision(path)),))
            self.assertNotEqual(first[2], second[2])


if __name__ == "__main__":
    unittest.main()
