#!/usr/bin/env python3
"""Decode a fresh keyframe from each advertised software codec of an installed release."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import urllib.request


port, token_file = sys.argv[1:]
token = Path(token_file).read_bytes().strip()
request = urllib.request.Request(f"http://127.0.0.1:{port}/api/codecs",
                                 headers={"Authorization": "Bearer " + token.decode()})
with urllib.request.urlopen(request, timeout=10) as response:
    available = json.load(response)


def send(sock, payload, opcode=2):
    mask = os.urandom(4)
    size = len(payload)
    length = bytes([size | 128]) if size < 126 else b"\xfe" + struct.pack(">H", size)
    sock.sendall(bytes([128 | opcode]) + length + mask
                 + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))


def read(stream, size):
    data = stream.read(size)
    assert len(data) == size, "viewer socket ended before a keyframe"
    return data


def fresh_key(codec, choice):
    with socket.create_connection(("127.0.0.1", int(port)), timeout=15) as sock:
        key = base64.b64encode(os.urandom(16))
        sock.sendall(b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                     b"Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "
                     + key + b"\r\n\r\n")
        stream = sock.makefile("rb")
        assert stream.readline().startswith(b"HTTP/1.1 101 "), "WebSocket upgrade failed"
        headers = {}
        while (line := stream.readline()) != b"\r\n":
            assert line, "incomplete upgrade response"
            name, value = line.split(b":", 1)
            headers[name.lower()] = value.strip()
        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        assert headers.get(b"sec-websocket-accept") == accept
        send(sock, b"\x80" + token)
        send(sock, bytes([0x81, 0, 1 << (choice - 1), choice, 3]))
        config, fragment = None, bytearray()
        while True:
            flags, size = read(stream, 2)
            assert not size & 128, "server frames must be unmasked"
            if size == 126:
                size = struct.unpack(">H", read(stream, 2))[0]
            elif size == 127:
                size = struct.unpack(">Q", read(stream, 8))[0]
            assert size <= 16 * 1024 * 1024, "oversized server frame"
            payload = read(stream, size)
            opcode = flags & 15
            assert opcode != 8, "viewer closed before a keyframe"
            if opcode == 9:
                send(sock, payload, 10)
                continue
            if opcode == 10:
                continue
            assert opcode in (0, 2)
            fragment.extend(payload)
            if not flags & 128:
                continue
            payload, fragment = bytes(fragment), bytearray()
            if payload[0] == 1:
                config = json.loads(payload[1:])
            elif payload[0] == 2:
                assert config and payload[1] & 1, f"{codec} did not start with a keyframe"
                return config, payload[12:]


families = ["h264", "hevc", "vp9", "av1", "vp8"]
assert available, "release advertises no software codec"
for entry in available:
    codec = entry["codec"]
    config, payload = fresh_key(codec, families.index(codec) + 1)
    width, height = config["width"], config["height"]
    assert (width, height) == (320, 240)
    if codec in ("vp8", "vp9", "av1"):
        fourcc = {"vp8": b"VP80", "vp9": b"VP90", "av1": b"AV01"}[codec]
        payload = (struct.pack("<4sHH4sHHIIII", b"DKIF", 0, 32, fourcc, width, height, 30, 1, 1, 0)
                   + struct.pack("<IQ", len(payload), 0) + payload)
        demuxer = "ivf"
    else:
        demuxer = codec
    decoded = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-f", demuxer, "-i", "pipe:0",
                              "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                             input=payload, capture_output=True, timeout=20, check=True).stdout
    assert len(decoded) == width * height * 3, f"{codec} did not decode a complete picture"
    print(f"{codec}: fresh {width}x{height} viewer keyframe decoded")
