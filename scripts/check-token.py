#!/usr/bin/env python3
"""Docker check: explicit token reads and token-free startup/rotation output."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

binary = os.environ.get('ELSEWHERE_BINARY', '/src/target/release/elsewhere')
with tempfile.TemporaryDirectory(prefix='elsewhere-token-') as directory:
    root = Path(directory)
    env = {**os.environ, 'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'),
           'XDG_RUNTIME_DIR': str(root / 'runtime')}
    def command(*args, environment=env):
        return subprocess.run([binary, 'token', *args], env=environment, capture_output=True, timeout=5)
    missing = command()
    assert missing.returncode != 0 and not missing.stdout
    assert not (root / 'config').exists() and not (root / 'runtime').exists()
    home_tokens = root / 'home' / '.config' / 'elsewhere'
    home_tokens.mkdir(parents=True)
    (home_tokens / 'token').write_text('control-fixture\n')
    (home_tokens / 'viewer-token').write_text('viewer-fixture\n')
    home_env = {key: value for key, value in env.items() if key != 'XDG_CONFIG_HOME'}
    for args, expected in [((), b'control-fixture\n'), (('--viewer',), b'viewer-fixture\n')]:
        result = command(*args, environment=home_env)
        assert result.returncode == 0 and result.stdout == expected and not result.stderr
    assert not (root / 'runtime').exists()
    (home_tokens / 'token').write_text(' \n')
    empty = command(environment=home_env)
    assert empty.returncode != 0 and not empty.stdout
    (root / 'runtime').mkdir(mode=0o700)
    log_path = root / 'server.log'
    with log_path.open('wb') as log:
        server = subprocess.Popen([binary, '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none',
                                   '--codec', 'vp8', '--screen-size', '320x240', '--listen', '127.0.0.1:18444'],
                                  env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            url = 'http://127.0.0.1:18444'
            for _ in range(100):
                assert server.poll() is None, 'server exited before readiness'
                try:
                    with urllib.request.urlopen(url, timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError('server readiness timed out')
            def tokens():
                results = [command(), command('--viewer')]
                assert all(result.returncode == 0 and not result.stderr for result in results)
                return [result.stdout.decode().strip() for result in results]
            before = tokens()
            assert before == [(root / 'config' / 'elsewhere' / name).read_text().strip()
                              for name in ['token', 'viewer-token']]
            request = urllib.request.Request(url + '/api/token/rotate', method='POST',
                                             headers={'Authorization': 'Bearer ' + before[0]})
            with urllib.request.urlopen(request, timeout=5) as response:
                rotated = json.load(response)
            after = tokens()
            assert after == [rotated['token'], rotated['viewer_token']]
            assert all(old != new for old, new in zip(before, after))
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
    output = log_path.read_text()
    assert all(token not in output for token in before + after), 'server output contains a token'
    assert '#token=' not in output
    assert 'elsewhere token --viewer' in output and 'tokens rotated' in output
print('Token reads, missing/empty files, HOME/XDG lookup and secret-free startup/rotation passed')
