#!/usr/bin/env python3
"""Docker: Wayland development tools, fetched Cargo sources, Pillow and the release binary.
ELSEWHERE_RENDER_NODE selects hardware.
"""
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from PIL import Image

source = Path(__file__).resolve().parent
binary = os.environ.get("ELSEWHERE_BINARY", str(source.parents[2] / "target/release/elsewhere"))
registry = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/src"
origin = "http://127.0.0.1:18515"
with tempfile.TemporaryDirectory(prefix="elsewhere-decorations-") as directory:
    root = Path(directory)
    for name, pattern in [
        ("xdg-shell", "*/wayland-protocols-*/protocols/stable/xdg-shell/xdg-shell.xml"),
        ("xdg-decoration", "*/wayland-protocols-*/protocols/unstable/xdg-decoration/xdg-decoration-unstable-v1.xml"),
        ("kde-decoration", "*/wayland-protocols-misc-*/protocols/server-decoration.xml"),
    ]:
        xml = sorted(registry.glob(pattern))[-1]
        for mode, suffix in [("client-header", "-client.h"), ("private-code", ".c")]:
            subprocess.run(["wayland-scanner", mode, str(xml), str(root / (name + suffix))], check=True)
    subprocess.run(["cc", "-Wall", "-Wextra", str(source / "decoration-client.c"), *map(str, root.glob("*.c")),
                    "-I", str(root), "-lwayland-client", "-o", str(root / "client")], check=True)
    (root / "runtime").mkdir(mode=0o700)
    env = {**os.environ, "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_CONFIG_HOME": str(root / "config")}
    token = subprocess.check_output([binary, "token", "create", "--admin"], env=env, text=True).strip()
    def request(path, body=None):
        req = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = response.read()
        return data if path.endswith(".png") else json.loads(data) if data else None
    def wait(predicate, label="decoration condition"):
        until = time.monotonic() + 8
        while time.monotonic() < until:
            try:
                value = predicate()
                if value:
                    return value
            except (urllib.error.URLError, FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(.03)
        raise AssertionError(label + " timed out")
    with (root / "server.log").open("w+") as log:
        server = subprocess.Popen([binary, "--no-audio", "--no-rtc", "--no-tls", "--render-node", os.environ.get("ELSEWHERE_RENDER_NODE", "none"), "--codecs", "h264,hevc,vp8",
            "--screen-size", "1920x1080", "--listen", "127.0.0.1:18515"], env=env, stdout=log, stderr=log)
        try:
            wait(lambda: request("/api/me"))
            for mode in sys.argv[1:] or ["none", "xdg", "kde"]:
                command, report = root / (mode + ".command"), root / (mode + ".report")
                request("/api/control", {"op": "spawn", "cmd": shlex.join([str(root / "client"), mode, str(command), str(report)]) + " >" + shlex.quote(str(root / (mode + ".log"))) + " 2>&1"})
                read = lambda: json.loads(report.read_text())
                wait(lambda: report.exists() and read()["configures"])
                win = wait(lambda: next((w for w in request("/api/windows") if w["title"] == "decoration-check"), None))
                current = lambda: next((w for w in request("/api/windows") if w["id"] == win["id"]), None)
                def send(op):
                    next_sequence = read()["sequence"] + 1
                    temporary = command.with_suffix(".new")
                    temporary.write_text(f"{next_sequence} {op}")
                    temporary.replace(command)
                    wait(lambda: not report.exists() if op == "quit" else read()["sequence"] == next_sequence, op)
                    if op.startswith("xdg_") and op != "xdg_destroy":
                        wait(lambda: read()["xdg_mode"] == (1 if op == "xdg_client" else 2), op + " configure event")
                def check(bar, maximized=False, fullscreen=False):
                    def settled():
                        w, r = current(), read()
                        if not w or w["decoration"] != bar or (w["w"], w["h"]) != (r["w"], r["h"]):
                            return False
                        if w["maximized"] != maximized or w["fullscreen"] != fullscreen:
                            return False
                        return not (maximized or fullscreen) or (w["x"], w["y"], w["w"], w["h"]) == (0, bar, 1920, 1080 - bar)
                    wait(settled, f"{mode}: bar={bar}, maximized={maximized}, fullscreen={fullscreen}")
                    w = current()
                    clicks = read()["clicks"]
                    request("/api/input", {"type": "click", "x": w["x"] + 20, "y": w["y"] + 20})
                    wait(lambda: read()["clicks"] > clicks)
                    assert (read()["click_x"], read()["click_y"]) == (20, 20), read()
                    image = Image.open(io.BytesIO(request("/api/screenshot.png"))).convert("RGB")
                    assert image.getpixel((w["x"] + 20, w["y"] + 20)) == (229, 42, 97)
                    if bar:
                        assert image.getpixel((w["x"], w["y"] - 1)) == (43, 43, 48), "focused server bar is painted"
                check(0 if mode == "none" else 32)
                if mode == "kde":
                    assert read()["default_mode"] == read()["kde_mode"] == 2, read()
                if mode == "none":
                    send("xdg_create")
                send("maximize")
                check(32, maximized=True)
                prefix = "kde" if mode == "kde" else "xdg"
                for op, bar in [(prefix + "_client", 0), (prefix + "_server", 32),
                                (prefix + ("_none" if mode == "kde" else "_unset"), 0 if mode == "kde" else 32),
                                (prefix + "_server", 32)]:
                    send(op)
                    check(bar, maximized=True)
                send("fullscreen")
                check(0, maximized=True, fullscreen=True)
                send(prefix + ("_release" if mode == "kde" else "_destroy"))
                check(0, maximized=True, fullscreen=True)
                send("unfullscreen")
                check(0, maximized=True)  # A destroyed decoration must not return when fullscreen ends.
                send(prefix + "_create")
                check(32, maximized=True)
                send(prefix + ("_release" if mode == "kde" else "_destroy"))
                check(0, maximized=True)
                send("unmaximize")
                check(0)
                if mode == "kde":
                    for op, bar in [("kde_create", 32), ("xdg_create", 32), ("xdg_client", 0), ("xdg_destroy", 32), ("kde_release", 0)]:
                        send(op)
                        check(bar)
                send("quit")
                wait(lambda: current() is None)
                print(mode, "creation, modes, destruction, recreation, maximize/fullscreen, pixels and pointer coordinates passed", flush=True)
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            for detail in [*root.glob("*.report"), *root.glob("none.log"), *root.glob("xdg.log"), *root.glob("kde.log")]:
                print(detail.name, detail.read_text(), file=sys.stderr)
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
