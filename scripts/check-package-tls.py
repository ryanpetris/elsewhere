#!/usr/bin/env python3
"""Run as root in a disposable Docker installation of the native package.

Check the packaged broadcast helper against trusted, untrusted and wrong-host TLS certificates.
This tests TLS establishment, not a complete RTMP broadcast.
"""
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading

assert Path('/.dockerenv').exists() and os.geteuid() == 0, 'requires a disposable Docker container as root'
binary = os.environ.get('ELSEWHERE_BINARY', '/usr/bin/elsewhere')
debian = Path('/etc/debian_version').exists()
bundle = Path('/etc/ssl/certs/ca-certificates.crt')
assert bundle.is_file() and bundle.stat().st_size > 0, 'package installation did not supply a CA bundle'
with tempfile.TemporaryDirectory(prefix='elsewhere-package-tls-') as directory:
    root = Path(directory)
    anchors = []
    def update_trust():
        subprocess.run(['update-ca-certificates'] if debian else ['update-ca-trust'], check=True,
                       stdout=subprocess.DEVNULL)
    try:
        for name, hostname, trusted in [('trusted', 'localhost', True), ('untrusted', 'localhost', False),
                                        ('wrong-host', 'elsewhere-test.invalid', True)]:
            cert, key = root / f'{name}.crt', root / f'{name}.key'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-subj', f'/CN={hostname}', '-addext', f'subjectAltName=DNS:{hostname}',
                            '-keyout', str(key), '-out', str(cert)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if trusted:
                if debian:
                    anchor = Path('/usr/local/share/ca-certificates') / f'{root.name}-{name}.crt'
                    shutil.copyfile(cert, anchor)
                else:
                    anchor = cert
                    subprocess.run(['trust', 'anchor', str(anchor)], check=True)
                anchors.append(anchor)
                update_trust()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                listener.listen(1)
                listener.settimeout(7)
                def serve():
                    try:
                        connection, _ = listener.accept()
                        with connection:
                            connection.settimeout(7)
                            with context.wrap_socket(connection, server_side=True) as tls:
                                tls.recv(1)
                    except (OSError, ssl.SSLError):
                        pass
                thread = threading.Thread(target=serve)
                thread.start()
                try:
                    url = f'tls://localhost:{listener.getsockname()[1]}'.encode()
                    result = subprocess.run([binary, '--broadcast-output-worker'],
                                            input=len(url).to_bytes(4, 'little') + url,
                                            capture_output=True, timeout=10)
                finally:
                    thread.join(timeout=8)
                assert not thread.is_alive(), 'TLS listener did not finish'
            success = name == 'trusted'
            assert (result.returncode == 0 and result.stdout == bytes(8)) == success, (name, result.returncode, result.stderr)
            if not success:
                assert result.returncode != 0 and result.stdout == b'', (name, result.stdout)
            print(f'Passed packaged TLS: {name}', flush=True)
    finally:
        for anchor in anchors:
            if debian:
                anchor.unlink()
            else:
                subprocess.run(['trust', 'anchor', '--remove', str(anchor)], check=True)
        if anchors:
            update_trust()
