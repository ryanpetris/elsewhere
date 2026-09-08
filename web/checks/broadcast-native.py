"""Run in Docker after cargo build -p elsewhere-stream --example broadcast-source.

Checks the native broadcaster through local RTMP receivers and TLS proxies. The
TLS checks temporarily add two test certificates to the container's trust store.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time

ROOT = Path(tempfile.mkdtemp(prefix="elsewhere-broadcast-native-"))
BINARY = os.environ.get("BROADCAST_SOURCE", "/src/target/debug/examples/broadcast-source")
children = []


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def source(url, seconds, **env):
    result = subprocess.run([BINARY, url, str(seconds)], capture_output=True, text=True,
                            env={**os.environ, **env}, timeout=seconds + 5)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "credential-sentinel" not in result.stdout + result.stderr
    match = re.search(r"stop_ms=(\d+) state=Stopped", result.stdout)
    assert match and int(match[1]) < 2000, result.stdout
    assert int(re.search(r"max_submit_ms=(\d+)", result.stdout)[1]) < 100, result.stdout
    return result.stdout


def ingest(name, listen_port=None):
    p = listen_port or port()
    with (ROOT / (name + ".log")).open("w") as log:
        child = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "warning", "-listen", "1", "-i",
                                  f"rtmp://127.0.0.1:{p}/live/credential-sentinel", "-c", "copy", "-y",
                                  str(ROOT / (name + ".flv"))], stdout=log, stderr=log)
    children.append(child)
    time.sleep(.3)
    return p, child


class Proxy:
    def __init__(self, upstream=None, certificate=None, pause_after=None):
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.listener.listen()
        self.sockets = []
        self.stopped = False
        self.accepted = 0
        self.client_bytes = 0
        self.context = None
        self.server_names = []
        if certificate:
            self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.context.load_cert_chain(str(certificate) + ".crt", str(certificate) + ".key")
            self.context.set_servername_callback(lambda socket, name, context: self.server_names.append(name))
        self.upstream, self.pause_after = upstream, pause_after
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while not self.stopped:
                client, _ = self.listener.accept()
                self.sockets.append(client)
                if self.context:
                    try:
                        client = self.context.wrap_socket(client, server_side=True)
                        self.sockets.append(client)
                    except (ssl.SSLError, OSError):
                        client.close()
                        continue
                self.accepted += 1
                if self.upstream is None:
                    continue
                remote = socket.create_connection(("127.0.0.1", self.upstream))
                self.sockets.append(remote)
                start = time.monotonic()
                while not self.stopped:
                    if self.pause_after is not None and time.monotonic() - start > self.pause_after:
                        time.sleep(.02)
                        continue
                    ready, _, _ = select.select([client, remote], [], [], .1)
                    ended = False
                    for connection in ready:
                        data = connection.recv(65536)
                        if not data:
                            ended = True
                            break
                        if connection is client:
                            self.client_bytes += len(data)
                        (remote if connection is client else client).sendall(data)
                    if ended:
                        break
                client.close()
                remote.close()
        except OSError:
            pass

    def close(self):
        self.stopped = True
        self.listener.close()
        for connection in self.sockets:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        self.thread.join(timeout=1)


def certificate(name, hostname):
    path = ROOT / name
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", f"/CN={hostname}", "-addext", f"subjectAltName=DNS:{hostname}",
                    "-keyout", str(path) + ".key", "-out", str(path) + ".crt"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return path


trusted = []
proxies = []
try:
    p, receiver = ingest("idle")
    duration = max(6, float(os.environ.get("BROADCAST_DURATION", "6")))
    assert "state=Sending" in source(f"rtmp://127.0.0.1:{p}/live/credential-sentinel", duration)
    receiver.wait(timeout=3)
    info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_packets", "-of", "json", str(ROOT / "idle.flv")]))
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert video["codec_name"] == "h264" and audio["codec_name"] == "aac"
    assert (video["width"], video["height"]) == (640, 360)
    assert int(audio["sample_rate"]) == 44100 and audio["channels"] == 2
    v = [p for p in info["packets"] if p["stream_index"] == video["index"]]
    a = [p for p in info["packets"] if p["stream_index"] == audio["index"]]
    duration = float(v[-1]["pts_time"]) - float(v[0]["pts_time"])
    assert 29 < (len(v) - 1) / duration < 31
    assert .8 * 800000 < sum(int(p["size"]) for p in v) * 8 / duration < 1.2 * 800000
    keys = [float(p["pts_time"]) for p in v if "K" in p["flags"]]
    assert len(keys) >= 3 and all(1.8 < b-a < 2.2 for a, b in zip(keys, keys[1:]))
    assert abs(float(v[0]["pts_time"]) - float(a[0]["pts_time"])) < .05
    assert abs(float(v[-1]["pts_time"]) - float(a[-1]["pts_time"])) < .1
    pixels = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(ROOT / "idle.flv"), "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])
    sample = lambda x, y: tuple(pixels[(y * 640 + x)*3:(y*640+x+1)*3])
    assert max(sample(20, 180)) < 25, "aspect-fit border is not black"
    for x, channel in [(150, 2), (320, 1), (490, 0)]:
        color = sample(x, 180)
        assert color[channel] > 180 and all(c < 60 for n, c in enumerate(color) if n != channel), color
    print("Idle CBR, cadence, aspect fit, color and A/V timestamps passed", flush=True)

    blackhole = Proxy()
    proxies.append(blackhole)
    assert "state=Sending" not in source(f"rtmp://127.0.0.1:{blackhole.port}/live/credential-sentinel", .5)
    assert "state=Sending" not in source(f"rtmp://127.0.0.1:{port()}/live/credential-sentinel", .5)
    assert "state=Sending" not in source("rtmp://elsewhere-test.invalid/live/credential-sentinel", .5)
    (ROOT / "slow-dns.c").write_text('''#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result) {
    if (node && !strcmp(node, "slow-dns.test")) {
        struct timespec delay = {.tv_sec = 20}; nanosleep(&delay, 0); return EAI_AGAIN;
    }
    int (*original)(const char*, const char*, const struct addrinfo*, struct addrinfo**) = dlsym(RTLD_NEXT, "getaddrinfo");
    return original(node, service, hints, result);
}
ssize_t write(int fd, const void *data, size_t size) {
    ssize_t (*original)(int, const void*, size_t) = dlsym(RTLD_NEXT, "write");
    static int acknowledgements;
    const char *partial = getenv("BROADCAST_TEST_PARTIAL_ACK");
    if (fd == 1 && size == 8 && partial && ++acknowledgements == atoi(partial)) { original(fd, data, 3); _exit(42); }
    return original(fd, data, size);
}
''')
    subprocess.run(["cc", "-shared", "-fPIC", str(ROOT / "slow-dns.c"), "-o", str(ROOT / "slow-dns.so"), "-ldl"], check=True)
    assert "state=Sending" not in source("rtmp://slow-dns.test/live/credential-sentinel", .5, LD_PRELOAD=str(ROOT / "slow-dns.so"))
    assert "state=Reconnecting" in source("rtmp://slow-dns.test/live/credential-sentinel", 5.6, LD_PRELOAD=str(ROOT / "slow-dns.so"))
    # Adopt the helper so this test also reaps it after deliberately killing its parent.
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER
    parent = subprocess.Popen([BINARY, "rtmp://slow-dns.test/live/credential-sentinel", "30"],
                              env={**os.environ, "LD_PRELOAD": str(ROOT / "slow-dns.so")},
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    children.append(parent)
    deadline = time.monotonic() + 2
    helpers = []
    while not helpers and time.monotonic() < deadline:
        helpers = [int(pid) for task in Path(f"/proc/{parent.pid}/task").glob("*/children") for pid in task.read_text().split()]
        time.sleep(.01)
    assert len(helpers) == 1
    parent.kill()
    parent.wait(timeout=2)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        reaped, _ = os.waitpid(helpers[0], os.WNOHANG)
        if reaped:
            break
        time.sleep(.01)
    assert reaped == helpers[0], "broadcast helper survived its parent"
    for ack in [1, 3]:
        p, receiver = ingest(f"partial-ack-{ack}")
        assert "state=Sending" not in source(f"rtmp://127.0.0.1:{p}/live/credential-sentinel", .6,
                                             LD_PRELOAD=str(ROOT / "slow-dns.so"), BROADCAST_TEST_PARTIAL_ACK=str(ack))
    p, receiver = ingest("helper-death")
    parent = subprocess.Popen([BINARY, f"rtmp://127.0.0.1:{p}/live/credential-sentinel", "3"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    children.append(parent)
    time.sleep(.6)
    helpers = [int(pid) for task in Path(f"/proc/{parent.pid}/task").glob("*/children") for pid in task.read_text().split()]
    assert len(helpers) == 1
    os.kill(helpers[0], 9)
    output, errors = parent.communicate(timeout=6)
    assert parent.returncode == 0 and "state=Reconnecting" in output, output + errors
    assert "credential-sentinel" not in output + errors
    copied = ROOT / "broadcast-source"
    shutil.copy2(BINARY, copied)
    p, receiver = ingest("unlinked-binary")
    parent = subprocess.Popen([str(copied), f"rtmp://127.0.0.1:{p}/live/credential-sentinel", "6"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    children.append(parent)
    time.sleep(.6)
    copied.unlink()
    helpers = [int(pid) for task in Path(f"/proc/{parent.pid}/task").glob("*/children") for pid in task.read_text().split()]
    assert len(helpers) == 1
    os.kill(helpers[0], 9)
    receiver.wait(timeout=3)
    ingest("unlinked-reconnect", p)
    output, errors = parent.communicate(timeout=8)
    assert parent.returncode == 0 and "state=Reconnecting" in output and "state=Sending" in output.split("state=Reconnecting", 1)[-1], output + errors
    assert "credential-sentinel" not in output + errors
    p, receiver = ingest("write-stall")
    stalled = Proxy(p, pause_after=1)
    proxies.append(stalled)
    assert "state=Sending" in source(f"rtmp://127.0.0.1:{stalled.port}/live/credential-sentinel", 3, BROADCAST_TEST_BITRATE="50000", BROADCAST_TEST_SUBMIT="1")
    stalled.close()
    print("Handshake, refusal, DNS and stalled-write cancellation passed", flush=True)

    for name, hostname, trust, success in [("trusted", "localhost", True, True), ("untrusted", "localhost", False, False), ("wrong-host", "elsewhere-test.invalid", True, False)]:
        cert = certificate(name, hostname)
        if trust:
            subprocess.run(["trust", "anchor", str(cert)+".crt"], check=True)
            trusted.append(cert)
            subprocess.run(["update-ca-trust"], check=True)
        p, receiver = ingest(name)
        proxy = Proxy(p, certificate=cert)
        proxies.append(proxy)
        output = source(f"rtmps://localhost:{proxy.port}/live/credential-sentinel", 2)
        assert ("state=Sending" in output) == success, output
        assert (proxy.client_bytes > 0) == success, name
        assert proxy.server_names and all(name == "localhost" for name in proxy.server_names), proxy.server_names
        proxy.close()
        if success:
            receiver.wait(timeout=3)
        else:
            receiver.terminate()
    print("Trusted TLS, untrusted certificate and hostname mismatch passed", flush=True)
    print("Artifacts:", ROOT)
finally:
    for proxy in proxies:
        proxy.close()
    for child in children:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
    for cert in trusted:
        subprocess.run(["trust", "anchor", "--remove", str(cert)+".crt"], check=False)
    if trusted:
        subprocess.run(["update-ca-trust"], check=False)
