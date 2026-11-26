"""Start/stop only this deployment; no system service, firewall or GPU changes."""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from ink_viewer.paths import SOURCE_ROOT


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["start", "stop", "status", "refresh"])
    p.add_argument("--site", required=True)
    a = p.parse_args()
    site = Path(a.site).resolve()
    state = site / "process.json"
    code = SOURCE_ROOT

    def running():
        if not state.exists():
            return None
        d = json.loads(state.read_text())
        pid = d["pid"]
        try:
            status = Path(f"/proc/{pid}/status").read_text()
            if any(line.startswith("State:") and "Z" in line for line in status.splitlines()):
                return None
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        except FileNotFoundError:
            return None
        if (
            b"ink_viewer.server.vast_server" not in cmd
            or str(site).encode() not in cmd
            or Path(f"/proc/{pid}/cwd").resolve() != code
        ):
            raise RuntimeError("PID reutilizado; no se toca ese proceso")
        return d

    d = running()
    if a.action == "refresh":
        if d:
            raise RuntimeError("Detener sólo este visor antes de actualizar el índice")
        subprocess.run(
            [sys.executable, "-B", "-m", "ink_viewer.catalog.vast_catalog", "--site", str(site)],
            check=True,
            cwd=code,
            env=dict(os.environ, PYTHONPATH=str(code / "src")),
        )
        return
    if a.action == "stop":
        if d:
            os.kill(d["pid"], signal.SIGTERM)
            for _ in range(50):
                if not Path(f"/proc/{d['pid']}").exists():
                    break
                time.sleep(0.1)
        print(json.dumps({"stopped": bool(d), "site": str(site)}))
        return
    if a.action == "start" and not d:
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", 8798))
        finally:
            s.close()
        env = dict(
            os.environ,
            PYTHONPATH=str(code / "src"),
            CUDA_VISIBLE_DEVICES="",
            OMP_NUM_THREADS="1",
            OPENBLAS_NUM_THREADS="1",
            MKL_NUM_THREADS="1",
        )
        with (site / "server.log").open("ab") as log:
            proc = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-m",
                    "ink_viewer.server.vast_server",
                    "--site",
                    str(site),
                    "--port",
                    "8798",
                ],
                stdout=log,
                stderr=log,
                env=env,
                cwd=code,
                start_new_session=True,
                preexec_fn=lambda: os.nice(10),
            )
        d = {
            "pid": proc.pid,
            "site": str(site),
            "port": 8798,
            "bind": "127.0.0.1",
            "read_only": True,
            "GPU": False,
        }
        state.write_text(json.dumps(d, indent=2))
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError("El visor terminó; revisar server.log")
            try:
                with urllib.request.urlopen("http://127.0.0.1:8798/api/inventario", timeout=1) as f:
                    json.load(f)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("El visor no respondió al inicio")
    print(json.dumps(d or {"running": False, "site": str(site)}))


if __name__ == "__main__":
    main()
