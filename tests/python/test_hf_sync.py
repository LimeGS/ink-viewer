"""Run: python -m unittest discover -s tests/python -p 'test_hf_sync.py'"""

import json
import sys
import unittest
from unittest.mock import patch

import ink_viewer.server.s3cache_proxy as p
import test_mask_pair
from ink_viewer.server.hf_sync import HFSync
from test_fuentes import servidor


class Op:
    def __init__(self, path_in_repo, path_or_fileobj):
        assert isinstance(path_or_fileobj, bytes), "buffered IO would bypass Xet"
        self.path, self.body = path_in_repo, path_or_fileobj


class FakeApi:
    def __init__(self, fail=0):
        self.repos, self.commits, self.fail = [], [], fail

    def create_repo(self, repo, **kw):
        self.repos.append((repo, kw))

    def create_commit(self, repo, repo_type, operations, commit_message):
        if self.fail:
            self.fail -= 1
            raise OSError("network down")
        self.commits.append((repo, repo_type, {o.path: o.body for o in operations}, commit_message))


class Queue(unittest.TestCase):
    def test_push_retry_and_validation(self):
        api = FakeApi(fail=1)
        sync = HFSync("me/labels", api=api, operation=Op)
        self.assertEqual(
            api.repos, [("me/labels", {"repo_type": "dataset", "private": True, "exist_ok": True})]
        )
        sync.submit({"a/x.png": b"1"}, "first")
        self.assertTrue(sync.flush())
        self.assertEqual(api.commits, [])
        self.assertIn("network down", sync.info()["last_error"])
        self.assertEqual(sync.info()["failed"], 1)
        sync.submit({"a/y.png": b"2", "a/x.png": b"3"}, "second")
        self.assertTrue(sync.flush())
        self.assertEqual(
            api.commits,
            [("me/labels", "dataset", {"a/x.png": b"3", "a/y.png": b"2"}, "second")],
            "the failed file rides along with the next save; the newer version wins",
        )
        info = sync.info()
        self.assertEqual(
            (info["pushed"], info["failed"], info["queued"], info["last_error"]), (2, 0, 0, None)
        )
        sync._queue.put("nothing pending")
        self.assertTrue(sync.flush())
        self.assertEqual(len(api.commits), 1, "an empty queue makes no commit")
        for bad in ("labels", "me/", "a/b/c", None):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                HFSync(bad, api=api, operation=Op)
        with patch.dict(sys.modules, {"huggingface_hub": None}), self.assertRaises(RuntimeError):
            HFSync("me/labels")


class SavedPairs(unittest.TestCase):
    setUp, payload, pedir = (
        test_mask_pair.MaskPair.setUp,
        test_mask_pair.MaskPair.payload,
        test_mask_pair.MaskPair.pedir,
    )

    def test_saved_pair_is_mirrored(self):
        api = FakeApi()
        sync = HFSync("me/labels", api=api, operation=Op)
        with servidor(p.Handler, self.source) as (srv, base):
            srv.hf_sync = sync
            saved = json.loads(
                self.pedir(
                    base + "/api/mascara-par/lam" + self.query, self.payload(), self.headers
                )[2]
            )
            self.assertEqual(saved["hf"], "me/labels")
            info = json.loads(self.pedir(base + "/api/origen")[2])
            self.assertEqual(info["hf"]["repo"], "me/labels")
        self.assertTrue(sync.flush())
        ((repo, kind, files, message),) = api.commits
        self.assertEqual(
            (repo, kind, message), ("me/labels", "dataset", "Annotations: lam, depth 4")
        )
        self.assertEqual(
            sorted(files), sorted(self.source.id + "/catalog/" + c for c in saved["claves"])
        )
        for path, body in files.items():  # same paths and bytes as the local annotations folder
            self.assertEqual((self.annotations / path).read_bytes(), body, path)


if __name__ == "__main__":
    unittest.main()
