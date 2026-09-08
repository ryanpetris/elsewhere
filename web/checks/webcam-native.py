"""Docker V4L2 loopback check. Pass an unused loopback device exposed to the container.

Build `cargo build -p elsewhere-stream --example webcam-output` first.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

device = sys.argv[1]
binary = "/src/target/debug/examples/webcam-output"
frame_bytes = 1280 * 720 * 2

with tempfile.TemporaryDirectory(prefix="elsewhere-webcam-check-") as directory:
    root = Path(directory)
    source = Path(__file__).with_name("webcam-errors.c")
    library = root / "device-errors.so"
    subprocess.run(["cc", "-shared", "-fPIC", str(source), "-ldl", "-o", str(library)], check=True)
    for pressure in [False, True]:
        env = os.environ.copy()
        if pressure:
            env.update(LD_PRELOAD=str(library), ELSEWHERE_WEBCAM_TEST_DEVICE=device)
        with (root / "writer.log").open("w") as log:
            writer = subprocess.Popen([binary, device], env=env, stdout=log, stderr=log)
        try:
            time.sleep(.2)
            capture = root / "capture.yuyv"
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "video4linux2",
                "-input_format", "yuyv422", "-video_size", "1280x720", "-framerate", "30", "-i", device,
                "-t", "3", "-c:v", "copy", "-f", "rawvideo", "-y", str(capture)], check=True, timeout=6)
            assert writer.wait(timeout=4) == 0, (root / "writer.log").read_text()
            data = capture.read_bytes()
            assert len(data) % frame_bytes == 0
            centers = []
            for offset in range(0, len(data), frame_bytes):
                assert data[offset:offset + 4] == bytes([16, 128, 16, 128]), "left letterbox border"
                at = offset + (360 * 1280 + 640) * 2
                centers.append(data[at])
            assert len(centers) >= (20 if pressure else 50), len(centers)
            assert any(abs(value - 64) <= 2 for value in centers), centers
            assert any(abs(value - 180) <= 2 for value in centers), centers
            assert all(abs(value - 180) <= 2 for value in centers[-15:]), "did not recover after malformed input"
            print(f"webcam pressure={pressure}: {len(centers)} packed frames, aspect fit, VP8 recovery and joined stop passed", flush=True)
        finally:
            if writer.poll() is None:
                writer.kill()
                writer.wait()
    for error in ["EIO", "ENODEV"]:
        failure = subprocess.run([binary, device], env=dict(os.environ, LD_PRELOAD=str(library),
            ELSEWHERE_WEBCAM_TEST_DEVICE=device, ELSEWHERE_WEBCAM_TEST_FAILURE=error), capture_output=True, timeout=4)
        assert failure.returncode != 0 and b"write webcam frame" in failure.stderr, failure.stderr
        if error == "ENODEV":
            assert b"No such device" in failure.stderr, failure.stderr
        print(f"injected {error} after real webcam startup stopped the worker", flush=True)
