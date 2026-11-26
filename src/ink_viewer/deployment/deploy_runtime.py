"""Serve one immutable release with a machine-owned configuration outside Git."""

import json
import os
import secrets
import threading
from pathlib import Path
from urllib.parse import urlsplit

from ink_viewer.paths import SOURCE_ROOT


def handler_for(proxy, deployment, preview=False):
    class DeploymentHandler(proxy.Handler):
        def end_headers(self):
            self.send_header("X-Visor-Version", deployment["commit"])
            self.send_header("X-Visor-Channel", deployment["channel"])
            super().end_headers()

        def _codigo(self, head=False):
            if urlsplit(self.path).path == "/api/deploy":
                if not self._host_local():
                    self.send_error(403)
                elif head:
                    self._send_bytes(
                        json.dumps(deployment).encode(), "application/json", "deployment", True
                    )
                else:
                    self._json(deployment)
                return True
            return super()._codigo(head)

        def _origen_info(self):
            info = super()._origen_info()
            if preview and info["tipo"] == "legacy":
                info["escritura"] = False
            return info

        def _cambiar_origen(self):
            if preview:
                return self._json(
                    {"error": "Preview source is fixed; production configuration is unchanged"}, 403
                )
            return super()._cambiar_origen()

        def do_POST(self):
            if (
                preview
                and not getattr(self.server, "fuente", None)
                and urlsplit(self.path).path != "/api/origen"
            ):
                return self._json({"error": "Legacy preview is read-only"}, 403)
            return super().do_POST()

    return DeploymentHandler


def serve(site, channel, nonce):
    from ink_viewer.deployment.viewerctl import load_settings, verify_release
    from ink_viewer.server.fuentes import Fuente

    site = Path(site).expanduser().resolve()
    settings = load_settings(site)
    release = (site / channel).resolve(strict=True)
    if release != SOURCE_ROOT:
        raise ValueError("The running code is not the selected release")
    version = verify_release(release)
    for name, value in settings.get("env", {}).items():
        os.environ[name] = value
    import ink_viewer.server.s3cache_proxy as proxy

    runtime = site / "state" / channel
    runtime.mkdir(parents=True, exist_ok=True)
    preview = channel == "preview"
    config_path = site / "origin.json"
    source = None
    if settings["mode"] == "source":
        config = json.loads(config_path.read_text())
        if preview:
            annotations = runtime / "annotations"
            annotations.mkdir(exist_ok=True)
            config["anotaciones"] = str(annotations)
            config_path = runtime / "origin.json"
        source = Fuente(**config)
        source.verificar()
    proxy.configurar(settings.get("scroll"), settings.get("legacy_root"), source)
    proxy.CACHE = Path(settings.get("cache") or runtime / "cache")
    proxy.LOG_FILE = runtime / "visor.log"
    port = settings["preview_port"] if preview else settings["port"]
    deployment = {
        "commit": version["commit"],
        "channel": channel,
        "site": settings["name"],
        "nonce": nonce,
        "port": port,
        "origin": source.origen if source else str(proxy.ROOT),
        "preview": preview,
    }
    if preview:

        def no_external_write(*args, **kwargs):
            raise PermissionError("Preview cannot write to the production catalog")

        proxy.writer_put = proxy.s3_once = no_external_write
    srv = proxy.ThreadingHTTPServer(("127.0.0.1", port), handler_for(proxy, deployment, preview))
    srv.fuente, srv.config_path = source, config_path
    srv.config_token, srv.config_lock = secrets.token_urlsafe(32), threading.Lock()
    srv.daemon_threads = True
    proxy.log(
        f"{settings['name']}: {channel} {version['commit'][:12]} on 127.0.0.1:{port}; assets {deployment['origin']}"
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
