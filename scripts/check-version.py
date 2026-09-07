#!/usr/bin/env python3
"""Exercise Git-derived versions in a disposable repository. Run in Docker."""
import pathlib
import subprocess
import tempfile

script = pathlib.Path(__file__).with_name('version.sh').resolve()
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    def git(*args):
        return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
    def version():
        return subprocess.check_output(['sh', str(script)], cwd=root, text=True).strip()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Version check')
    git('config', 'user.email', 'check@example.invalid')
    (root / '.gitignore').write_text('/dist\n')
    git('add', '.')
    git('commit', '-qm', 'Initial fixture')
    failure = subprocess.run(['sh', str(script)], cwd=root, capture_output=True)
    assert failure.returncode != 0 and b'No vX.Y.Z release tags' in failure.stderr
    git('tag', 'v0.1.2')
    git('commit', '--allow-empty', '-qm', 'Tagged descendant')
    git('tag', 'v9.9.9')
    git('reset', '--hard', '-q', 'HEAD~1')
    git('tag', '-d', 'v0.1.2')
    failure = subprocess.run(['sh', str(script)], cwd=root, capture_output=True)
    assert failure.returncode != 0 and b'No reachable release tag' in failure.stderr
    git('tag', '-d', 'v9.9.9')
    git('tag', 'v0.1.2')
    assert version() == 'v0.1.2'
    (root / 'untracked').touch()
    assert version() == 'v0.1.2-dirty'
    (root / 'untracked').unlink()
    (root / '.gitignore').write_text('/dist\n/ignored\n')
    assert version() == 'v0.1.2-dirty'
    git('add', '.')
    assert version() == 'v0.1.2-dirty'
    git('commit', '-qm', 'Fixture change')
    for _ in range(2):
        git('commit', '--allow-empty', '-qm', 'Fixture increment')
    assert version() == 'v0.1.2.3'
    (root / 'dist').mkdir()
    (root / 'dist' / 'artifact').touch()
    assert version() == 'v0.1.2.3'
    (root / 'untracked').touch()
    assert version() == 'v0.1.2.3-dirty'
    (root / 'untracked').unlink()
    git('tag', 'v0.2.0-rc1')
    git('tag', 'v1.2.3.4')
    assert version() == 'v0.1.2.3'
    git('tag', '-am', 'Fixture release', 'v0.2.0')
    assert version() == 'v0.2.0'
    git('checkout', '--detach', '-q', 'HEAD')
    assert version() == 'v0.2.0'
    git('clone', '-q', '--depth=1', root.as_uri(), str(root / 'shallow'))
    assert subprocess.run(['sh', str(script)], cwd=root / 'shallow', capture_output=True).returncode != 0
print('Version checks passed: tags, distance, detached HEAD, dirty states and ignored output')
