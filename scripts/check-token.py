#!/usr/bin/env python3
"""Docker integration check for SQLite token creation, API grants and durable revocation."""
import concurrent.futures
from contextlib import closing
import shutil
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

binary = os.environ.get('ELSEWHERE_BINARY', '/src/target/release/elsewhere')
with tempfile.TemporaryDirectory(prefix='elsewhere-tokens-') as directory:
    root = Path(directory)
    env = {**os.environ, 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'),
           'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_RUNTIME_DIR': str(root / 'runtime')}
    (root / 'runtime').mkdir(mode=0o700)
    database = root / 'config/elsewhere/state.sqlite3'
    origin = 'http://127.0.0.1:18444'
    def cli(environment=env):
        result = subprocess.run([binary, 'token', 'create', '--admin'], env=environment, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr.decode()
        assert re.fullmatch(rb'[0-9a-f]{64}\n', result.stdout), result.stdout
        assert not result.stderr, result.stderr
        return result.stdout.decode().strip()
    def request(path, token='', method='GET', data=None, mime='application/json'):
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
        req = urllib.request.Request(origin + path, data=data, method=method,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': mime})
        try:
            response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            return response.status, json.loads(body) if body and 'application/json' in response.headers.get('Content-Type', '') else body
    def create(permissions, expiry=None):
        status, result = request('/api/tokens', admin, 'POST', {'label': ' Fixture ', 'permissions': permissions, 'expires_at_ms': expiry})
        assert status == 201, (status, result)
        assert result['metadata']['label'] == 'Fixture'
        assert result['metadata']['permissions'] == sorted(set(permissions))
        assert str(uuid.UUID(result['metadata']['id'], version=4)) == result['metadata']['id']
        return result
    def start(log):
        server = subprocess.Popen([binary, '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codec', 'vp8',
            '--screen-size', '320x240', '--listen', '127.0.0.1:18444'], env=env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(150):
            assert server.poll() is None, (root / 'server.log').read_text()
            try:
                if request('/')[0] == 200:
                    return server
            except OSError:
                pass
            time.sleep(.1)
        server.terminate()
        raise AssertionError('server readiness timeout')
    # The same command initializes a fresh store without a running server.
    offline = {**env, 'XDG_CONFIG_HOME': str(root / 'offline')}
    secret = cli(offline)
    with closing(sqlite3.connect(root / 'offline/elsewhere/state.sqlite3')) as db:
        assert db.execute('SELECT secret_hash FROM tokens').fetchone()[0] == hashlib.sha256(secret.encode()).digest()
    with (root / 'server.log').open('wb') as log:
        server = start(log)
        try:
            with closing(sqlite3.connect(database)) as db:
                assert db.execute('SELECT COUNT(*) FROM tokens').fetchone()[0] == 0
            admin = cli()
            status, me = request('/api/me', admin)
            assert status == 200 and me['permissions'] == me['available_permissions']
            assert me['metadata']['expires_at_ms'] is None
            catalog = me['permissions']
            assert request('/api/me', admin.upper())[0] == 401
            assert request('/api/me', 'a' * 63)[0] == 401
            assert request('/api/tokens', admin, 'POST', {'label': 'x', 'permissions': ['unknown']})[0] >= 400
            assert request('/api/tokens', admin, 'POST', {'label': 'x', 'permissions': [], 'preset': 'Admin'})[0] >= 400
            for bad in ['not-a-uuid', me['metadata']['id'].upper(), str(uuid.uuid1())]:
                assert request('/api/tokens/' + bad, admin, 'DELETE')[0] == 400
            empty = create([])
            assert request('/api/me', empty['token'])[0] == 200
            gates = [('desktop.view', '/api/windows', 'GET', None), ('files.browse', '/api/files?path=@transfer', 'GET', None),
                     ('files.upload', '/api/files/probe?path=@transfer', 'PUT', b'probe'), ('files.download', '/api/files/probe?path=@transfer', 'GET', None),
                     ('files.manage', '/api/files/probe?path=@transfer', 'DELETE', None), ('clipboard.read', '/api/clipboard/state', 'GET', None),
                     ('clipboard.write', '/api/clipboard', 'PUT', b'text'), ('tokens.manage', '/api/tokens', 'GET', None),
                     ('desktop.control', '/api/input', 'POST', {'type': 'key', 'keys': 'Escape'}),
                     ('apps.launch', '/api/control', 'POST', {'op': 'launch', 'app': 'missing-fixture'}),
                     ('commands.execute', '/api/control', 'POST', {'op': 'spawn', 'cmd': 'true'}),
                     ('server.manage', '/api/control', 'POST', {'op': 'quit'}),
                     ('broadcasts.manage', '/api/broadcasts', 'GET', None)]
            for permission, path, method, data in gates:
                assert request(path, empty['token'], method, data)[0] == 403, permission
                if permission == 'server.manage':
                    continue
                scoped = create([permission])
                status, body = request(path, scoped['token'], method, data)
                assert status not in (401, 403), (permission, status, body)
            a = create(['clipboard.write', 'files.upload'])
            b = create(['clipboard.write', 'files.upload'])
            assert request('/api/clipboard', b['token'], 'PUT', b'file:///etc/passwd', 'text/uri-list')[0] == 403
            batch = str(uuid.uuid4())
            assert request('/api/drop/' + batch + '/private.txt', a['token'], 'PUT', b'private')[0] == 201
            assert request('/api/clipboard/files', b['token'], 'POST', {'batch': batch, 'names': ['private.txt']})[0] == 403
            uri = ('file://' + str(root / 'cache/elsewhere/drops' / a['metadata']['id'] / batch / 'private.txt')).encode()
            assert request('/api/clipboard', b['token'], 'PUT', uri, 'text/uri-list')[0] == 403
            assert request('/api/tokens/' + a['metadata']['id'], admin, 'DELETE')[0] == 204
            assert request('/api/drop/' + batch + '/dummy.txt', b['token'], 'PUT', b'dummy')[0] == 201
            assert request('/api/clipboard/files', b['token'], 'POST', {'batch': batch, 'names': ['private.txt']})[0] >= 400
            expiring = create([], int(time.time() * 1000) + 300)
            time.sleep(.4)
            assert request('/api/me', expiring['token'])[0] == 401
            assert any(t['id'] == expiring['metadata']['id'] for t in request('/api/tokens', admin)[1]['tokens'])
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                concurrent = list(pool.map(lambda _: cli(), range(6)))
            assert len(set(concurrent)) == 6
            for token in concurrent:
                assert request('/api/me', token)[0] == 200
            self_revoking = create(['tokens.manage'])
            assert request('/api/tokens/' + self_revoking['metadata']['id'], self_revoking['token'], 'DELETE')[0] == 204
            assert request('/api/me', self_revoking['token'])[0] == 401
            victim = create(['desktop.view'])
            assert request('/api/tokens/' + victim['metadata']['id'], admin, 'DELETE')[0] == 204
            assert request('/api/me', victim['token'])[0] == 401
            listing = request('/api/tokens', admin)[1]
            assert 'secret_hash' not in json.dumps(listing) and admin not in json.dumps(listing)
            with closing(sqlite3.connect(database)) as db:
                assert db.execute('PRAGMA foreign_key_check').fetchall() == []
                assert db.execute('SELECT COUNT(*) FROM token_permissions WHERE token_id=?', (victim['metadata']['id'],)).fetchone()[0] == 0
            for path in database.parent.glob('state.sqlite3*'):
                assert path.stat().st_mode & 0o777 == 0o600
                assert admin.encode() not in path.read_bytes()
            server.terminate(); server.wait(timeout=10)
            backup = root / 'backup'
            backup.mkdir()
            for path in database.parent.glob('state.sqlite3*'):
                shutil.copy2(path, backup / path.name)
            after_backup = cli()
            for path in database.parent.glob('state.sqlite3*'):
                path.unlink()
            for path in backup.iterdir():
                shutil.copy2(path, database.parent / path.name)
            server = start(log)
            assert request('/api/me', after_backup)[0] == 401
            assert request('/api/me', admin)[0] == 200
            assert request('/api/me', victim['token'])[0] == 401
        finally:
            server.terminate(); server.wait(timeout=10)
    broken_config = root / 'broken'
    (broken_config / 'elsewhere').mkdir(parents=True)
    (broken_config / 'elsewhere/state.sqlite3').write_bytes(b'not a database')
    failed = subprocess.run([binary, 'token', 'create', '--admin'], env={**env, 'XDG_CONFIG_HOME': str(broken_config)}, capture_output=True, timeout=10)
    assert failed.returncode != 0 and not failed.stdout and failed.stderr
    output = (root / 'server.log').read_text()
    assert 'elsewhere token create --admin' in output and admin not in output
    print('SQLite CLI/API creation, permission gates, batch ownership, expiry, revocation and restart passed')
