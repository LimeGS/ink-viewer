#!/usr/bin/env python3
"""Prepare, preview and promote viewer releases without copying machine data/config."""

import argparse
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from ink_viewer.paths import LEGACY_RELEASE_FILES, RELEASE_FILES, SOURCE_ROOT

ENV_NAMES = {
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_DEFAULT_REGION",
}
SCHEMA = "ink-viewer.deploy.v1"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
        json.dump(value, f, indent=2)
        f.write("\n")
    os.replace(f.name, path)


def load_settings(site):
    settings = json.loads((site / "site.json").read_text())
    if settings.get("schema") != SCHEMA or settings.get("mode") not in ("source", "legacy"):
        raise ValueError("Invalid deployment profile")
    if settings["mode"] == "legacy":
        raise ValueError(
            "This profile uses the removed legacy docroot mode: run init again with --origin"
        )
    unsupported = set(settings.get("env", {})) - ENV_NAMES
    if unsupported:
        raise ValueError(
            "Unsupported deployment environment variable: " + ", ".join(sorted(unsupported))
        )
    if settings["port"] == settings["preview_port"]:
        raise ValueError("Production and preview ports must differ")
    return settings


def init_site(site, args):
    repo = SOURCE_ROOT
    if site.is_relative_to(repo):
        raise ValueError("Deployment state must be outside the Git checkout")
    if (site / "site.json").exists() or (site / "origin.json").exists():
        raise ValueError("Profile already exists; init never overwrites machine configuration")
    if args.from_port:
        if args.origin or args.source_config:
            raise ValueError("--from-port cannot be combined with another source option")
        with urllib.request.urlopen(
            f"http://127.0.0.1:{args.from_port}/api/origen", timeout=5
        ) as response:
            running = json.load(response)
        if not running.get("origen"):
            raise ValueError("The running viewer has no source to import")
        source = {
            k: running.get(k, "") for k in ("origen", "perfil", "endpoint", "region", "anotaciones")
        }
    else:
        config = (
            Path(args.source_config).expanduser()
            if args.source_config
            else Path.home() / ".config/vesuvius-visor/config.json"
        )
        if args.origin:
            source = dict(origen=args.origin, anotaciones=args.annotations or "")
        elif config.is_file():
            source = json.loads(config.read_text())
        else:
            raise ValueError("Provide --origin or --source-config for this machine")
    from ink_viewer.server.fuentes import Fuente

    source = Fuente(**source).config()
    env = {k: os.environ[k] for k in ENV_NAMES if k in os.environ}
    mode = "source"
    settings = dict(
        schema=SCHEMA,
        name=args.name or socket.gethostname(),
        mode=mode,
        port=args.port,
        preview_port=args.preview_port,
        python=str(Path(sys.executable).absolute()),
        env=env,
    )
    if args.scroll:
        settings["scroll"] = args.scroll
    if settings["port"] == settings["preview_port"] or not all(
        0 < p < 65536 for p in (settings["port"], settings["preview_port"])
    ):
        raise ValueError("Choose two different valid ports")
    site.mkdir(parents=True, exist_ok=True)
    save(site / "origin.json", source)
    save(site / "site.json", settings)
    return {
        "site": str(site),
        "mode": mode,
        "production_port": args.port,
        "preview_port": args.preview_port,
    }


def verify_release(release):
    version = json.loads((release / "RELEASE.json").read_text())
    if not re.fullmatch(r"[0-9a-f]{40}", version.get("commit", "")):
        raise ValueError("Invalid release commit")
    for name, expected in version["files"].items():
        path = release / name
        if (
            not path.resolve().is_relative_to(release.resolve())
            or hashlib.sha256(path.read_bytes()).hexdigest() != expected
        ):
            raise ValueError(f"Release changed: {name}")
    return version


def point(site, name, target):
    site, target = site.resolve(), target.resolve()
    link = site / ("." + name + "-" + secrets.token_hex(6))
    link.symlink_to(os.path.relpath(target, site))
    os.replace(link, site / name)


def prepare(site, repo, ref, fetch=True):
    load_settings(site)

    def git(*args, binary=False):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=not binary).strip()

    if fetch:
        subprocess.run(["git", "-C", str(repo), "fetch", "origin"], check=True)
    commit = git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Reference is not a commit")
    destination = site / "releases" / commit
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
            temp = Path(temp)
            archive = git("archive", "--format=tar", commit, binary=True)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                for entry in tar:
                    target = temp / entry.name
                    if (
                        Path(entry.name).is_absolute()
                        or ".." in Path(entry.name).parts
                        or not (entry.isdir() or entry.isfile())
                    ):
                        raise ValueError("Unsafe path in Git archive")
                    if entry.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with tar.extractfile(entry) as body, target.open("wb") as out:
                            shutil.copyfileobj(body, out)
                        target.chmod(entry.mode & 0o777)
            required = RELEASE_FILES if (temp / "src/ink_viewer").is_dir() else LEGACY_RELEASE_FILES
            for name in required:
                if not (temp / name).is_file():
                    raise ValueError(f"Release lacks {name}")
            files = {
                str(p.relative_to(temp)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in temp.rglob("*")
                if p.is_file()
            }
            save(temp / "RELEASE.json", {"commit": commit, "files": files})
            temp.rename(destination)
    verify_release(destination)
    # Code pointers only: site.json, origin.json, state, annotations and assets are untouched.
    point(site, "preview", destination)
    return commit


def health(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/deploy", timeout=3) as response:
        return json.load(response)


def stop(site, channel):
    record = site / "state" / channel / "process.json"
    if not record.exists():
        return
    data = json.loads(record.read_text())
    try:
        os.kill(data["pid"], 0)
    except ProcessLookupError:
        record.unlink()
        return
    try:
        live = health(data["port"])
    except Exception as e:
        raise ValueError("Cannot identify running process; refusing to stop it") from e
    if live.get("nonce") != data["nonce"]:
        raise ValueError("Port belongs to another process; refusing to stop it")
    os.kill(data["pid"], signal.SIGTERM)
    for _ in range(50):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", data["port"])) != 0:
                record.unlink()
                return
        time.sleep(0.1)
    raise ValueError("Process did not release the port")


def start(site, channel):
    settings = load_settings(site)
    release = (site / channel).resolve(strict=True)
    version = verify_release(release)
    port = settings["preview_port"] if channel == "preview" else settings["port"]
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            raise ValueError(
                f"Port {port} is occupied; existing services are never stopped automatically"
            )
    runtime = site / "state" / channel
    runtime.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_hex(24)
    packaged = (release / "src/ink_viewer/deployment/viewerctl.py").is_file()
    entry = (
        ["-m", "ink_viewer.deployment.viewerctl"] if packaged else [str(release / "viewerctl.py")]
    )
    python_path = release / "src" if packaged else release
    with (runtime / "process.log").open("ab") as log:
        process = subprocess.Popen(
            [
                settings["python"],
                "-B",
                *entry,
                "--site",
                str(site),
                "serve",
                "--channel",
                channel,
                "--nonce",
                nonce,
            ],
            stdout=log,
            stderr=log,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            cwd=release,
            env=dict(os.environ, PYTHONPATH=str(python_path)),
        )
    for _ in range(200):
        if process.poll() is not None:
            raise ValueError(f"Viewer failed to start; see {runtime / 'process.log'}")
        try:
            info = health(port)
            if info.get("nonce") == nonce:
                save(
                    runtime / "process.json",
                    dict(pid=process.pid, port=port, nonce=nonce, commit=version["commit"]),
                )
                return dict(info, url=f"http://127.0.0.1:{port}/all-gallery/index.html")
        except Exception:
            pass
        time.sleep(0.2)
    process.terminate()
    raise ValueError("Viewer did not become ready within 40 seconds")


def promote(site, rollback=False):
    settings = load_settings(site)
    target = (site / ("previous" if rollback else "preview")).resolve(strict=True)
    version = verify_release(target)
    if not rollback:
        live = health(settings["preview_port"])
        if live["commit"] != version["commit"] or not live.get("preview"):
            raise ValueError("Preview has not been started for this release")
    previous = (site / "current").resolve() if (site / "current").exists() else None
    with socket.socket() as sock:
        occupied = sock.connect_ex(("127.0.0.1", settings["port"])) == 0
    if occupied and not (site / "state/current/process.json").exists():
        raise ValueError(
            "Production port belongs to the old deployment; perform the initial handoff explicitly"
        )
    stop(site, "current")
    point(site, "current", target)
    try:
        info = start(site, "current")
    except Exception:
        if previous:
            point(site, "current", previous)
            start(site, "current")
        else:
            (site / "current").unlink()
        raise
    if previous and previous != target:
        point(site, "previous", previous)
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--site", default=str(Path.home() / ".local/share/ink-viewer"))
    sub = ap.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Import this machine configuration once; never overwrite it")
    for flag in (
        "name",
        "origin",
        "source-config",
        "annotations",
        "scroll",
    ):
        init.add_argument("--" + flag)
    init.add_argument("--port", type=int, default=8797)
    init.add_argument("--preview-port", type=int, default=8897)
    init.add_argument(
        "--from-port",
        type=int,
        help="Import the currently running local viewer source and scroll configuration",
    )
    update = sub.add_parser("update", help="Fetch committed code and start a separate preview")
    update.add_argument("--ref", default="origin/main")
    update.add_argument("--no-fetch", action="store_true")
    update.add_argument("--prepare-only", action="store_true")
    for command in ("start", "stop"):
        parser = sub.add_parser(command)
        parser.add_argument("--channel", choices=("preview", "current"), default="preview")
    sub.add_parser("status")
    sub.add_parser(
        "promote",
        help="Explicitly switch production to the running preview; retains previous release",
    )
    sub.add_parser("rollback", help="Explicitly return production to the previous managed release")
    internal = sub.add_parser("serve", help=argparse.SUPPRESS)
    internal.add_argument("--channel", choices=("preview", "current"), required=True)
    internal.add_argument("--nonce", required=True)
    args = ap.parse_args()
    site = Path(args.site).expanduser().resolve()
    try:
        if args.command == "init":
            result = init_site(site, args)
        elif args.command == "update":
            commit = prepare(site, SOURCE_ROOT, args.ref, not args.no_fetch)
            result = {"commit": commit, "preview_prepared": True}
            if not args.prepare_only:
                stop(site, "preview")
                result = start(site, "preview")
        elif args.command == "start":
            result = start(site, args.channel)
        elif args.command == "stop":
            stop(site, args.channel)
            result = {"stopped": args.channel}
        elif args.command in ("promote", "rollback"):
            result = promote(site, args.command == "rollback")
        elif args.command == "serve":
            from ink_viewer.deployment.deploy_runtime import serve

            serve(site, args.channel, args.nonce)
            return
        else:
            settings = load_settings(site)
            result = {"site": str(site), "name": settings["name"]}
            for channel in ("current", "preview", "previous"):
                if (site / channel).exists():
                    result[channel] = verify_release((site / channel).resolve())["commit"]
            for channel, port in (
                ("current", settings["port"]),
                ("preview", settings["preview_port"]),
            ):
                try:
                    result[channel + "_running"] = health(port)
                except Exception:
                    result[channel + "_running"] = None
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as e:
        ap.exit(1, str(e) + "\n")


if __name__ == "__main__":
    main()
