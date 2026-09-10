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
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="PATCH" if path == "/api/display" and body is not None else None)
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
                            wait(lambda: read()["sequence"] == next_sequence and (op.startswith(("begin", "extents")) or read()["events"] > previous["events"]))
                    def rect():
                        return tuple(read()[key] for key in ("x", "y", "w", "h"))
                    def painted(expected):
                        image = Image.open(io.BytesIO(request("/api/screenshot.png"))).convert("RGB")
                        channels = [channel.point(lambda v, target=target: 255 if v == target else 0) for channel, target in zip(image.split(), (229, 42, 97))]
                        mask = ImageChops.multiply(ImageChops.multiply(channels[0], channels[1]), channels[2])
                        return mask.getbbox() == expected
                    if mode == "managed":
                        win = wait(lambda: next((w for w in request("/api/windows") if w["title"] == "x11-placement-check"), None))
                        current = lambda: next(w for w in request("/api/windows") if w['id']==win['id'])
                        control = lambda op, **values: request('/api/control', {'id':win['id'],'op':op,**values})
                        left, top, width_extra, height_extra = (9,13,20,28) if extents else (0,0,0,0)
                        def check(expected):
                            wait(lambda: rect()==expected)
                            x,y,w,h=expected
                            wait(lambda: (current()['x'],current()['y'],current()['w'],current()['h'])==(x+left,y+top,w-width_extra,h-height_extra))
                            # The solid buffer includes shadow margins, which paint above server chrome.
                            wait(lambda: painted((max(0,x),max(0,y),min(1920,x+w),min(1080,y+h))))
                        wait(lambda: rect()[2:]==(400,240))
                        initial_size=rect()[2:]
                        control('move',x=400,y=250)
                        x,y=400-left,250-top
                        check((x,y,*initial_size))
                        for iteration in range(3):
                            for op, size in [('raise',(400,240)),('size 400 240',(400,240)),('width 460',(460,240)),
                                ('height 280',(460,280)),('move 10 20',(460,280)),('size 400 240',(400,240))]:
                                send(op);check((x,y,*size))
                        clicks=read()['clicks']
                        request('/api/input',{'type':'click','x':x+30,'y':y+30})
                        wait(lambda: read()['clicks']==clicks+1)
                        assert (read()['click_x'],read()['click_y'])==(30,30),read()
                        def drag(op,dx,dy):
                            before=rect();px,py=before[0]+30,before[1]+30
                            request('/api/input',{'type':'move','x':px,'y':py})
                            request('/api/input',{'type':'button','button':'left','pressed':True})
                            send(f'{op} {px} {py}')
                            request('/api/input',{'type':'move','x':px+dx,'y':py+dy})
                            request('/api/input',{'type':'button','button':'left','pressed':False})
                        drag('beginmove',30,20);x+=30;y+=20;check((x,y,400,240))
                        drag('beginresize',20,10);x+=20;y+=10;check((x,y,380,230))
                        control('resize',w=420,h=260)
                        check((x,y,420+width_extra,260+height_extra))
                        control('resize',w=440,h=270)
                        control('move',x=500,y=300)
                        x,y=500-left,300-top
                        check((x,y,440+width_extra,270+height_extra))
                        saved=rect()
                        for op, undo in [('maximize','unmaximize'),('fullscreen','unfullscreen')]:
                            control(op)
                            bar=current()['decoration'] if op=='maximize' else 0
                            check((-left,bar-top,1920+width_extra,1080-bar+height_extra))
                            # Exercise both values, then restore this case's extents for the next phase.
                            for enabled in (0,1,extents):
                                send(f'extents {enabled}')
                                left,top,width_extra,height_extra=(9,13,20,28) if enabled else (0,0,0,0)
                                bar=32 if op=='maximize' else 0
                                check((-left,bar-top,1920+width_extra,1080-bar+height_extra))
                            control(undo);check(saved)
                        request('/api/display', {'kiosk':True})
                        check((-left,-top,1920+width_extra,1080+height_extra))
                        request('/api/display', {'kiosk':False});check(saved)
                        control('resize',w=50,h=50);check((x,y,300,180))
                        control('resize',w=900,h=800);check((x,y,500,400))
                        drag('beginresize',1000,1000);x+=200;y+=220;check((x,y,300,180))
                        send('extents 0')
                        left=top=width_extra=height_extra=0
                        check((x,y,300,180))
                        send('extents 1')
                        left,top,width_extra,height_extra=9,13,20,28
                        check((x,y,300,180))
                    else:
                        wait(lambda: painted((400, 250, 520, 340)))
                        send("move 600 350")
                        wait(lambda: rect() == (600, 350, 120, 90))
                        wait(lambda: painted((600, 350, 720, 440)))
                    print(mode, "frame extents", extents, "passed", flush=True)
                    send("quit")
        except BaseException:
            for report_file in root.glob('*.report'):
                print(report_file.name, report_file.read_text(), file=sys.stderr)
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
