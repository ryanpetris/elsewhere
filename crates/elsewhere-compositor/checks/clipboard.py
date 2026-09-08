#!/usr/bin/env python3
"""Docker: release binary, C compiler, wayland-scanner and Wayland client development files."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root = Path(tempfile.mkdtemp(prefix="elsewhere-clipboard-bridge-"))
(root / "runtime").mkdir(mode=0o700)
source = Path(__file__).resolve().parent
xml = "/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml"
subprocess.run(["wayland-scanner", "client-header", xml, str(root / "xdg-shell-client-protocol.h")], check=True)
subprocess.run(["wayland-scanner", "private-code", xml, str(root / "xdg-shell-protocol.c")], check=True)
subprocess.run(["cc", "-I" + str(root), str(source / "clipboard-client.c"), str(root / "xdg-shell-protocol.c"), "-lwayland-client", "-o", str(root / "owner")], check=True)
origin = "http://127.0.0.1:8098"
env = {**os.environ, "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_CONFIG_HOME": str(root / "config")}
command, payload = root / "command", root / "payload"
command.write_text(""); payload.write_bytes(b"")
log = (root / "server.log").open("wb")
server = subprocess.Popen([os.environ.get("ELSEWHERE_BINARY", "/src/target/release/elsewhere"), "--no-audio", "--no-rtc", "--no-tls", "--render-node", "none", "--codec", "vp8", "--listen", "127.0.0.1:8098", "--socket-name", "wayland-clipboard-check", "--exec", shlex.join([str(root / "owner"), str(command), str(payload)])], env=env, stdout=log, stderr=log, start_new_session=True)
token = ""

def request(path, data=None, mime="application/json", key=None, headers=None):
    req = urllib.request.Request(origin + path, data=data, headers={"Authorization": "Bearer " + (token if key is None else key), "Content-Type": mime, **(headers or {})})
    if data is not None:
        req.method = "PUT" if path == "/api/clipboard" else "POST"
    try:
        response = urllib.request.urlopen(req, timeout=3)
    except urllib.error.HTTPError as error:
        response = error
    return response.status, response.headers, response.read()

def api(path, body=None):
    status, _, data = request(path, None if body is None else json.dumps(body).encode())
    assert 200 <= status < 300, (path, status)
    return json.loads(data) if data else None

def wait(predicate, seconds=6):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.03)
    raise AssertionError("clipboard condition timed out")

def state():
    return api("/api/clipboard/state")

sequence = 0
def offer(mode, data=b""):
    global sequence
    before = state()["observation"]
    api("/api/input", {"type": "key", "keys": "Return"})
    payload.write_bytes(data)
    sequence += 1
    temporary = command.with_suffix(".new")
    temporary.write_text(f"{sequence} {mode}")
    temporary.replace(command)
    if mode != "flush":
        wait(lambda: state()["observation"] != before)

def settled(preview, present=True, seconds=6):
    return wait(lambda: (s if s["preview"] == preview and s["present"] == present else None) if (s := state()) else None, seconds)

def put(data, mime="text/plain;charset=utf-8"):
    status, _, body = request("/api/clipboard", data, mime)
    assert status == 202
    operation = json.loads(body)["operation"]
    wait(lambda: state()["operation"] == operation)
    return operation

try:
    token_file = root / "config/elsewhere/token"
    wait(lambda: token_file.exists())
    token = token_file.read_text().strip()
    viewer = (root / "config/elsewhere/viewer-token").read_text().strip()
    owner = wait(lambda: next((w for w in api("/api/windows") if w["app_id"] == "clipboard-source"), None))
    api("/api/control", {"id": owner["id"], "op": "activate"})
    assert state()["present"] is False
    first = put(b"from API")
    assert request("/api/clipboard")[2] == b"from API"
    assert first.startswith(state()["observation"].split(":")[0] + ":")
    offer("text", b" \n\t")
    settled("available")
    assert request("/api/clipboard")[2] == b" \n\t"
    old = state()["observation"]
    offer("empty"); settled("empty", False)
    assert request("/api/clipboard")[2] == b""
    assert request("/api/clipboard", headers={"If-Match": '"' + old + '"'})[0] == 412
    offer("unsupported"); unsupported = settled("unavailable")
    assert unsupported["mime"] == "application/clipboard-check" and unsupported["size"] is None
    assert request("/api/clipboard")[0] == 409
    offer("nomime"); unknown = settled("unavailable")
    assert unknown["mime"] == "application/octet-stream" and unknown["present"] is True

    for replacement in ["unsupported", "clear"]:
        offer("slow", b"stale data"); settled("loading")
        offer(replacement)
        settled("unavailable" if replacement == "unsupported" else "empty", replacement != "clear")
        current = state()["observation"]
        offer("flush", b"stale data")
        time.sleep(.15)
        assert state()["observation"] == current
        assert request("/api/clipboard")[0] == (409 if replacement == "unsupported" else 204)
    offer("slow"); settled("loading"); settled("unavailable", seconds=12)
    offer("text", b"x" * ((1 << 20) + 1)); settled("unavailable")
    assert request("/api/clipboard")[0] == 409
    offer("text", b"current"); settled("available")
    assert request("/api/clipboard")[2] == b"current"
    offer("destroy"); settled("empty", False)
    assert any(w["pid"] == owner["pid"] for w in api("/api/windows"))
    offer("slow"); settled("loading")
    offer("destroy"); settled("empty", False)
    current = state()["observation"]
    offer("flush", b"late bytes")
    time.sleep(.15)
    assert state()["observation"] == current

    copied = root / "copied.txt"; copied.write_text("copied file")
    put((copied.as_uri() + "\n").encode(), "text/uri-list")
    status, _, metadata = request("/api/clipboard/state", key=viewer)
    assert status == 200 and json.loads(metadata)["preview"] == "restricted"
    assert request("/api/clipboard", key=viewer)[0] == 403
    assert request("/api/clipboard/files/0", key=viewer)[0] == 403
    assert request("/api/clipboard", b"forbidden", key=viewer)[0] == 403
    assert request("/api/clipboard/files/0")[2] == b"copied file"
    put(b""); settled("empty", False); assert copied.read_text() == "copied file"
    offer("text", b"owned"); settled("available")
    os.kill(owner["pid"], signal.SIGTERM)
    settled("empty", False)
    command.write_text("")
    api("/api/control", {"op": "spawn", "cmd": shlex.join(["env", "GDK_BACKEND=x11", "python3", str(source / "clipboard-x11.py"), str(command), str(payload)])})
    x11 = wait(lambda: next((w for w in api("/api/windows") if w["app_id"] == "clipboard-x11"), None))
    offer("text", b"X11 contents"); settled("available")
    assert request("/api/clipboard")[2] == b"X11 contents"
    offer("clear"); settled("empty", False)
    offer("text", b"X11 owner exit"); settled("available")
    os.kill(x11["pid"], signal.SIGTERM)
    settled("empty", False)
    print("clipboard bridge: observed writes, whitespace/empty, unsupported and cleared owners, stale reads, timeout/size failure, conditional previews, restricted files, Wayland source destruction and X11 owner clear/exit passed")
finally:
    try:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=5)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        os.killpg(server.pid, signal.SIGKILL); server.wait()
    log.close()
