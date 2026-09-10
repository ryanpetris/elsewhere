#!/usr/bin/env python3
"""Docker: X11 development files, Pillow, and the release binary. Optional argument: managed or popup."""
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
from PIL import Image, ImageChops

source = Path(__file__).resolve().parent
binary = os.environ.get("ELSEWHERE_BINARY", str(source.parents[2] / "target/release/elsewhere"))
origin = "http://127.0.0.1:18514"
with tempfile.TemporaryDirectory(prefix="elsewhere-x11-placement-") as directory:
    root = Path(directory)
    (root / "runtime").mkdir(mode=0o700)
    env = {**os.environ, "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_CONFIG_HOME": str(root / "config")}
    subprocess.run(["cc", str(source / "x11-placement.c"), "-lX11", "-o", str(root / "client")], check=True)
    token = subprocess.check_output([binary, "token", "create", "--admin"], env=env, text=True).strip()
    def request(path, body=None):
        req = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = response.read()
        return data if path.endswith(".png") else json.loads(data) if data else None
    def wait(predicate):
        until = time.monotonic() + 8
        while time.monotonic() < until:
            try:
                value = predicate()
                if value:
                    return value
            except (urllib.error.URLError, FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(.03)
        raise AssertionError("X11 placement condition timed out")
    with (root / "server.log").open("w+") as log:
        server = subprocess.Popen([binary, "--no-audio", "--no-rtc", "--no-tls", "--render-node", "none", "--codecs", "vp8",
            "--screen-size", "1920x1080", "--listen", "127.0.0.1:18514"], env=env, stdout=log, stderr=log)
        try:
            wait(lambda: request("/api/me"))
            for mode in sys.argv[1:] or ["managed", "popup"]:
                assert mode in ("managed", "popup")
                for extents in (0, 1):
                    command, report = root / f"{mode}-{extents}.command", root / f"{mode}-{extents}.report"
                    command.write_text("")
                    report.unlink(missing_ok=True)
                    request("/api/control", {"op": "spawn", "cmd": shlex.join([str(root / "client"), mode, str(extents), str(command), str(report)])})
                    read = lambda: json.loads(report.read_text())
                    wait(lambda: report.exists())
                    def send(op):
                        previous = read()
                        next_sequence = previous["sequence"] + 1
                        temporary = command.with_suffix(".new")
                        temporary.write_text(f"{next_sequence} {op}")
                        temporary.replace(command)
                        if op == "quit":
                            wait(lambda: not report.exists())
                        else:
                            wait(lambda: read()["sequence"] == next_sequence and read()["events"] > previous["events"])
                    def rect():
                        return tuple(read()[key] for key in ("x", "y", "w", "h"))
                    if mode == "managed":
                        win = wait(lambda: next((w for w in request("/api/windows") if w["title"] == "x11-placement-check"), None))
                        request("/api/control", {"id": win["id"], "op": "move", "x": 400, "y": 250})
                        wait(lambda: rect()[:2] == (400, 250))
                        send("size 400 240")
                        wait(lambda: rect() == (400, 250, 400, 240))
                        for iteration in range(3):
                            for op, expected in [("raise", (400, 250, 400, 240)), ("size 400 240", (400, 250, 400, 240)),
                                ("width 460", (400, 250, 460, 240)), ("height 280", (400, 250, 460, 280)),
                                ("move 10 20", (400, 250, 460, 280)), ("size 400 240", (400, 250, 400, 240))]:
                                send(op)
                                wait(lambda: rect() == expected)
                        if not extents:
                            request("/api/input", {"type": "move", "x": 450, "y": 234})
                            request("/api/input", {"type": "button", "button": "left", "pressed": True})
                            request("/api/input", {"type": "move", "x": 480, "y": 254})
                            request("/api/input", {"type": "button", "button": "left", "pressed": False})
                            wait(lambda: rect()[:2] == (430, 270))
                            request("/api/control", {"id": win["id"], "op": "resize", "w": 420, "h": 260})
                            wait(lambda: rect() == (430, 270, 420, 260))
                            saved = rect()
                            request("/api/control", {"id": win["id"], "op": "maximize"})
                            wait(lambda: rect()[2] == 1920)
                            request("/api/control", {"id": win["id"], "op": "unmaximize"})
                            wait(lambda: rect() == saved)
                    else:
                        def painted(expected):
                            image = Image.open(io.BytesIO(request("/api/screenshot.png"))).convert("RGB")
                            channels = [channel.point(lambda v, target=target: 255 if v == target else 0) for channel, target in zip(image.split(), (229, 42, 97))]
                            mask = ImageChops.multiply(ImageChops.multiply(channels[0], channels[1]), channels[2])
                            return mask.getbbox() == expected
                        wait(lambda: painted((400, 250, 520, 340)))
                        send("move 600 350")
                        wait(lambda: rect() == (600, 350, 120, 90))
                        wait(lambda: painted((600, 350, 720, 440)))
                    print(mode, "frame extents", extents, "passed", flush=True)
                    send("quit")
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
