#!/usr/bin/env python3
"""Docker: GTK 3/4 introspection, PyQt 5/6 Wayland plugins, GSettings, Pillow and the release binary."""
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
origin = "http://127.0.0.1:18516"
with tempfile.TemporaryDirectory(prefix="elsewhere-toolkits-") as directory:
    root = Path(directory)
    (root / "runtime").mkdir(mode=0o700)
    env = {**os.environ, "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_CONFIG_HOME": str(root / "config")}
    (root/'config').mkdir()
    (root/'config'/'unrelated-setting').write_text('preserved')
    data_dir, schema_dir = root/'extra-data',root/'explicit-schemas'
    for directory, schema_id, value in [(data_dir/'glib-2.0/schemas','SchemaCheck','from data dirs'),(schema_dir,'SchemaDirectoryCheck','from schema dir')]:
        directory.mkdir(parents=True)
        (directory/'check.gschema.xml').write_text(f'<schemalist><schema id="org.elsewhere.{schema_id}" path="/org/elsewhere/{schema_id}/"><key name="value" type="s"><default>"{value}"</default></key></schema></schemalist>')
        subprocess.run(['glib-compile-schemas','--strict',str(directory)],check=True)
    env.update({'GSETTINGS_BACKEND':'keyfile','GSETTINGS_SCHEMA_DIR':str(schema_dir),'XDG_DATA_DIRS':str(data_dir)+':/usr/local/share:/usr/share'})
    system_keys = set(subprocess.check_output(['gsettings','list-keys','org.gnome.desktop.wm.preferences'],env=env,text=True).splitlines())
    data_mode = os.environ.get('CHECK_DATA_DIRS')
    if data_mode == 'unset':
        env.pop('XDG_DATA_DIRS')
    elif data_mode == 'empty':
        env['XDG_DATA_DIRS'] = ''
    if os.environ.get('CHECK_USER_PREFERENCES'):
        subprocess.run(['gsettings','set','org.gnome.desktop.wm.preferences','button-layout','close:'],env=env,check=True)
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
        raise AssertionError("Decoration condition timed out")
    with (root / "server.log").open("w+") as log:
        server = subprocess.Popen([binary, "--no-audio", "--no-rtc", "--no-tls", "--render-node", "none", "--codecs", "vp8",
            "--screen-size", "1920x1080", "--listen", "127.0.0.1:18516", *(["--kiosk"] if os.environ.get("CHECK_KIOSK") else [])], env=env, stdout=log, stderr=log)
        try:
            wait(lambda: request("/api/me"))
            cases = [(kind, backend, 'normal') for kind in ['gtk3','gtk4','qt5','qt6'] for backend in ['wayland','x11']]
            cases += [(kind,'wayland',mode) for kind in ['gtk3','gtk4'] for mode in ['fixed','dialog','fullscreen']]
            if os.environ.get('CHECK_USER_PREFERENCES') or os.environ.get('CHECK_KIOSK') or os.environ.get('CHECK_GTK_WAYLAND') or data_mode:
                cases = [(kind,'wayland','normal') for kind in ['gtk3','gtk4']]
            for kind, backend, mode in cases:
                title = f'{kind}-{backend}-{mode}'
                report = root / (title + '.report')
                command = shlex.join(['env', 'GDK_BACKEND='+backend, 'QT_QPA_PLATFORM='+('xcb' if backend=='x11' else 'wayland'),
                    'python3', str(source/'toolkit-client.py'),kind,title,mode,str(report)])
                request('/api/control', {'op':'spawn','cmd':command+' >'+shlex.quote(str(root/(title+'.log')))+' 2>&1'})
                read = lambda: json.loads(report.read_text())
                wait(lambda: report.exists())
                current = lambda: next((w for w in request('/api/windows') if w['title']==title),None)
                win = wait(current)
                def state(key,value):
                    wait(lambda: current() and current()[key]==value and (key!='maximized' or read()['maximized']==value))
                if kind.startswith('gtk'):
                    expected_layout = 'close:' if os.environ.get('CHECK_USER_PREFERENCES') else 'menu:minimize,maximize,close'
                    assert read()['wm_layout'] == expected_layout, (title,read())
                    assert read()['layout'].replace('icon', 'menu') == expected_layout, (title,read())
                    assert system_keys <= set(read()['wm_keys']), ('Bundled schema lacks system keys', system_keys - set(read()['wm_keys']))
                    assert read()['modifier'] == '<Super>', read()
                    assert read()['custom']==(None if data_mode else 'from data dirs') and read()['schema_dir_value']=='from schema dir', read()
                    assert read()['config_home']==env['XDG_CONFIG_HOME'] and read()['schema_dir']==env['GSETTINGS_SCHEMA_DIR'], read()
                    assert read()['data_dirs'].endswith(':'+('/usr/local/share:/usr/share' if data_mode else env['XDG_DATA_DIRS'])), read()
                    state('decoration',0)
                else:
                    state('decoration',32)
                if mode=='fullscreen' or os.environ.get('CHECK_KIOSK'):
                    state('fullscreen',True)
                    state('decoration',0)
                    assert (current()['w'],current()['h'])==(1920,1080), current()
                def buttons(name):
                    return [b for b in read()['buttons'] if name in b['css'] and b['mapped'] and b['visible'] and b['sensitive']]
                if kind.startswith('gtk') and (mode!='normal' or os.environ.get('CHECK_USER_PREFERENCES') or os.environ.get('CHECK_KIOSK')):
                    wait(lambda: not buttons('maximize'))
                    if mode in ('dialog','fullscreen') or os.environ.get('CHECK_USER_PREFERENCES') or os.environ.get('CHECK_KIOSK'):
                        assert not buttons('minimize'), (title,read())
                else:
                    def click(name):
                        w = current()
                        if w['maximized']:
                            wait(lambda: read()['width']==current()['w'])
                        if kind.startswith('gtk'):
                            b = wait(lambda: next(iter(buttons(name)),None))
                            x,y,width,height=b['rect']
                            x,y=w['x']-w['geo_x']+x+width/2,w['y']-w['geo_y']+y+height/2
                        else:
                            x,y=w['x']+w['w']-{'maximize':48,'minimize':80,'close':16}[name],w['y']-16
                        request('/api/input',{'type':'click','x':x,'y':y})
                    click('maximize');state('maximized',True)
                    click('maximize');state('maximized',False)
                    click('minimize');state('minimized',True)
                    request('/api/control',{'id':win['id'],'op':'activate'});state('minimized',False)
                    click('close');wait(lambda: current() is None)
                for w in reversed(request('/api/windows')):
                    request('/api/control',{'id':w['id'],'op':'close'})
                wait(lambda: not request('/api/windows'))
                print(title,'layout, decoration and applicable native controls passed',flush=True)
            assert (root/'config'/'unrelated-setting').read_text()=='preserved'
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            for detail in [*root.glob("*.report"), *root.glob("gtk*.log"), *root.glob("qt*.log")]:
                print(detail.name, detail.read_text(), file=sys.stderr)
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
