"""Mirror saved annotations to a Hugging Face dataset (``--annotations-hf user/dataset``).

The local annotations folder stays the source of truth: a pair is validated and written there first, then queued
here and pushed as one commit (inklabels, supervision mask and provenance, at the same paths as on disk). Pushes run
in a background thread, so drawing never waits on the network; a failed push is reported in /api/origen info and
retried with the next save. The token comes from HF_TOKEN or ``hf auth login`` and never reaches the browser.
A dataset that does not exist yet is created private.
"""
import io
import queue
import threading
import time


class HFSync:
    def __init__(self, repo, api=None, operation=None):
        if not isinstance(repo, str) or repo.count('/') != 1 or not all(repo.split('/')):
            raise ValueError('--annotations-hf expects user/dataset')
        if api is None:
            try:
                from huggingface_hub import HfApi
            except ImportError as e:
                raise RuntimeError('--annotations-hf needs huggingface_hub: pip install "ink-viewer[hf]"') from e
            api = HfApi()
        if operation is None:
            from huggingface_hub import CommitOperationAdd as operation
        self.repo, self.api, self.operation = repo, api, operation
        self.pending, self.failed = {}, {}
        self.status = {'repo': repo, 'pushed': 0, 'last_push': None, 'last_error': None}
        self._lock, self._queue = threading.Lock(), queue.Queue()
        self.api.create_repo(repo, repo_type='dataset', private=True, exist_ok=True)
        threading.Thread(target=self._worker, daemon=True, name='hf-sync').start()

    def submit(self, files, message):
        """Queue {path in repo: bytes} for one commit; later saves of the same path replace earlier queued ones."""
        with self._lock:
            self.pending.update(files)
        self._queue.put(message)

    def info(self):
        with self._lock:
            return dict(self.status, queued=len(self.pending), failed=len(self.failed))

    def flush(self, timeout=30):
        """Wait until the queue is drained (tests and orderly shutdown)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._queue.unfinished_tasks == 0:
                return True
            time.sleep(0.02)
        return False

    def _worker(self):
        while True:
            message = self._queue.get()
            try:
                with self._lock:
                    files, self.pending = {**self.failed, **self.pending}, {}
                    self.failed = {}
                if not files:
                    continue
                try:
                    operations = [self.operation(path_in_repo=p, path_or_fileobj=io.BytesIO(b)) for p, b in sorted(files.items())]
                    self.api.create_commit(self.repo, repo_type='dataset', operations=operations, commit_message=message)
                    with self._lock:
                        self.status.update(pushed=self.status['pushed'] + len(files), last_error=None,
                                           last_push=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
                except Exception as e:  # keep the files for the next save; local copies are already safe
                    with self._lock:
                        self.failed = files
                        self.status['last_error'] = str(e)[:300]
            finally:
                self._queue.task_done()
