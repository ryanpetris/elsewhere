#!/usr/bin/env python3
"""Keep one viewer's TCP receive window blocked, replacing it after its send deadline."""
import base64
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time

port, token_file, codec = sys.argv[1:]
token = Path(token_file).read_bytes().strip()
choice = ["h264", "hevc", "vp9", "av1", "vp8"].index(codec) + 1


def event(phase, **fields):
    print(json.dumps({"at": time.time_ns() // 1_000_000, "phase": phase, **fields}), flush=True)


def read(sock, size):
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise EOFError("viewer ended")
        data.extend(chunk)
    return data


def send(sock, payload, opcode=2):
    mask = os.urandom(4)
    assert len(payload) < 126
    sock.sendall(bytes([128 | opcode, 128 | len(payload)]) + mask
                 + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))


while True:
    try:
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_WINDOW_CLAMP, 4096)
            sock.settimeout(10)
            sock.connect(("127.0.0.1", int(port)))
            key = base64.b64encode(os.urandom(16))
            sock.sendall(b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         b"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + b"\r\n\r\n")
            headers = bytearray()
            while not headers.endswith(b"\r\n\r\n"):
                headers.extend(read(sock, 1))
            assert headers.startswith(b"HTTP/1.1 101 "), "WebSocket upgrade failed"
            send(sock, b"\x80" + token)
            send(sock, bytes([0x81, 0, 1 << (choice - 1), choice, 3]))
            while True:
                flags, size = read(sock, 2)
                assert not size & 128
                if size == 126:
                    size = struct.unpack(">H", read(sock, 2))[0]
                elif size == 127:
                    size = struct.unpack(">Q", read(sock, 8))[0]
                assert size <= 16 * 1024 * 1024
                data = read(sock, size)
                if flags & 15 == 9:
                    send(sock, data, 10)
                elif flags & 15 == 8:
                    raise EOFError("viewer closed before its first picture")
                elif flags & 15 == 2 and data[0] == 2:
                    event("blocked", receive_buffer=sock.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF))
                    time.sleep(20)  # Allow the send buffer to fill and the ten-second deadline to expire.
                    sock.settimeout(.1)
                    deadline, closed = time.monotonic() + 3, False
                    while time.monotonic() < deadline:
                        try:
                            if not sock.recv(65536):
                                closed = True
                                break
                        except socket.timeout:
                            pass
                    event("replaced", server_closed=closed)
                    break
    except (OSError, EOFError) as error:
        event("retry", error=str(error))
        time.sleep(.1)
