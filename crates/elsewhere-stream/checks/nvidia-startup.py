"""Run in the NVIDIA Docker rig with a release build and C compiler.

Driver stubs cover discovery and startup errors, not physical multi-NVIDIA encoding.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile

node = Path(os.environ['ELSEWHERE_RENDER_NODE'])
meta = node.stat()
device = Path('/sys/dev/char') / f'{os.major(meta.st_rdev)}:{os.minor(meta.st_rdev)}' / 'device'
assert (device / 'driver').resolve().name == 'nvidia', 'ELSEWHERE_RENDER_NODE must select an NVIDIA device'
pci = device.resolve().name
binary = os.environ.get('ELSEWHERE_BINARY', '/src/target/release/elsewhere')
root = Path(tempfile.mkdtemp(prefix='elsewhere-nvidia-startup-'))


def library(name, source):
    directory = root / name
    directory.mkdir()
    path = directory / name
    subprocess.run(['cc', '-shared', '-fPIC', '-x', 'c', '-', '-ldl', '-o', str(path)], input=source, text=True, check=True)
    return path


cuda = library('libcuda.so.1', r'''
#include <stdio.h>
#include <stdlib.h>
int cuInit(unsigned flags) { return 0; }
int cuDeviceGetCount(int *count) { *count = 2; return 0; }
int cuDeviceGet(int *device, int ordinal) { *device = ordinal + 10; return 0; }
int cuDeviceGetPCIBusId(char *address, int length, int device) {
    int match = atoi(getenv("TEST_CUDA_ORDINAL"));
    snprintf(address, length, "%s", device - 10 == match ? getenv("TEST_CUDA_PCI") : "ffff:ff:ff.7");
    return 0;
}
''')
encode = library('libnvidia-encode.so.1', r'''
int NvEncodeAPIGetMaxSupportedVersion(unsigned *version) { *version = 0; return 0; }
int NvEncodeAPICreateInstance(void *functions) { return 1; }
''')
hide = library('hide.so', r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
void *dlopen(const char *name, int flags) {
    void *(*open_real)(const char *, int) = dlsym(RTLD_NEXT, "dlopen");
    const char *hidden = getenv("TEST_HIDE_LIBRARY");
    if (name && hidden && strcmp(name, hidden) == 0)
        return open_real("/nonexistent/elsewhere-hidden-driver-library", flags);
    return open_real(name, flags);
}
''')


def reject(name, expected, environment=None, render_node=node):
    runtime = root / name
    runtime.mkdir(mode=0o700)
    result = subprocess.run([binary, '--no-audio', '--no-rtc', '--no-tls', '--render-node', str(render_node), '--codecs', 'h264'],
        env={**os.environ, 'NO_COLOR': '1', 'RUST_LOG': 'info', 'XDG_RUNTIME_DIR': str(runtime), 'XDG_CONFIG_HOME': str(runtime / 'config'), **(environment or {})},
        capture_output=True, text=True, timeout=30)
    output = result.stdout + result.stderr
    (root / (name + '.log')).write_text(output)
    assert result.returncode > 0, (name, result.returncode, output)
    for pattern in expected:
        assert re.search(pattern, output, re.I), (name, pattern, output)
    assert 'verified video encoders' not in output.lower(), (name, output)
    print(name, 'passed', flush=True)


reject('missing-device', ["render node .* isn't there", "--render-node none"], render_node=root / 'missing-render-node')
reject('hidden-cuda', ['CUDA device discovery failed|not visible to CUDA', 'CUDA_VISIBLE_DEVICES'], {'CUDA_VISIBLE_DEVICES': '-1'})
for ordinal in (0, 1):
    reject(f'cuda-ordinal-{ordinal}', [rf'matched NVIDIA encoder device[^\n]*ordinal={ordinal}', rf'Nvenc\({ordinal}\)', 'software-encoding'],
        {'LD_LIBRARY_PATH': str(cuda.parent), 'TEST_CUDA_ORDINAL': str(ordinal), 'TEST_CUDA_PCI': pci})
reject('cuda-no-match', ['not visible to CUDA', 'CUDA_VISIBLE_DEVICES'],
    {'LD_LIBRARY_PATH': str(cuda.parent), 'TEST_CUDA_ORDINAL': '-1', 'TEST_CUDA_PCI': pci})
for name, expected in [('libcuda.so.1', ['load NVIDIA CUDA driver', 'compute access']),
                       ('libnvidia-encode.so.1', ['Cannot load libnvidia-encode.so.1', 'software-encoding'])]:
    reject('missing-' + name, expected, {'LD_PRELOAD': str(hide), 'TEST_HIDE_LIBRARY': name})
reject('nvenc-api-mismatch', ['Driver does not support the required nvenc API version', 'Required:', 'Found: 0.0', 'minimum required Nvidia driver', 'software-encoding'],
    {'LD_LIBRARY_PATH': str(encode.parent)})
print('NVIDIA discovery and startup checks passed; artifacts', root)
