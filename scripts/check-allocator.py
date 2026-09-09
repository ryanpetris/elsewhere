#!/usr/bin/env python3
"""Run in Docker with a release binary and a C compiler to check glibc startup policy."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

binary = os.environ.get('ELSEWHERE_BINARY', '/src/target/release/elsewhere')
with tempfile.TemporaryDirectory(prefix='elsewhere-allocator-') as directory:
    root = Path(directory)
    source = root / 'probe.c'
    source.write_text(r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
int mallopt(int parameter, int value) {
    int (*next)(int, int) = dlsym(RTLD_NEXT, "mallopt");
    int result = getenv("ELSEWHERE_ALLOCATOR_FAIL") ? 0 : next(parameter, value);
    const char *path = getenv("ELSEWHERE_ALLOCATOR_LOG");
    if (!path) abort();
    FILE *log = fopen(path, "a");
    if (!log) abort();
    fprintf(log, "%d %d %d\n", parameter == M_ARENA_MAX, value, result);
    fclose(log);
    return result;
}
''')
    library = root / 'probe.so'
    subprocess.run(['cc', '-shared', '-fPIC', str(source), '-ldl', '-o', str(library)], check=True)
    cases = [({}, True), ({'MALLOC_ARENA_MAX': '4'}, False), ({'MALLOC_ARENA_MAX': '0'}, False),
             ({'GLIBC_TUNABLES': 'glibc.malloc.arena_max=4'}, False),
             ({'GLIBC_TUNABLES': 'glibc.malloc.trim_threshold=131072:glibc.malloc.arena_max=4'}, False),
             ({'GLIBC_TUNABLES': 'glibc.malloc.trim_threshold=131072'}, True),
             ({'MALLOC_ARENA_MAX': ''}, True), ({'GLIBC_TUNABLES': 'glibc.malloc.arena_max='}, True),
             ({'GLIBC_TUNABLES': 'glibc.malloc.arena_max=0'}, False),
             ({'ELSEWHERE_ALLOCATOR_FAIL': '1'}, True)]
    for index, (overrides, expected) in enumerate(cases):
        case = root / str(index)
        case.mkdir()
        runtime = case / 'runtime'
        runtime.mkdir(mode=0o700)
        receipt = case / 'allocator.log'
        env = {key: value for key, value in os.environ.items()
               if key not in ('MALLOC_ARENA_MAX', 'GLIBC_TUNABLES', 'LD_PRELOAD', 'ELSEWHERE_ALLOCATOR_FAIL')}
        env.update(XDG_CONFIG_HOME=str(case / 'config'), XDG_RUNTIME_DIR=str(runtime),
                   LD_PRELOAD=str(library), ELSEWHERE_ALLOCATOR_LOG=str(receipt))
        env.update(overrides)
        token = subprocess.check_output([binary, 'token', 'create', '--admin'], env={**os.environ, 'XDG_CONFIG_HOME': str(case / 'config')}, text=True).strip()
        with (case / 'server.log').open('wb') as log:
            server = subprocess.Popen([binary, '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none',
                                       '--codecs', 'vp8', '--screen-size', '320x240', '--listen', '127.0.0.1:18445'],
                                      env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    assert server.poll() is None, (case / 'server.log').read_text()
                    try:
                        request = urllib.request.Request('http://127.0.0.1:18445/api/windows',
                                                         headers={'Authorization': 'Bearer ' + token})
                        with urllib.request.urlopen(request, timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise AssertionError('server readiness timed out')
                calls = receipt.read_text().splitlines() if receipt.exists() else []
                failed = 'ELSEWHERE_ALLOCATOR_FAIL' in overrides
                assert calls == ([f'1 2 {0 if failed else 1}'] if expected else []), (overrides, calls)
                assert ('warning: allocation arena limit unavailable' in (case / 'server.log').read_text()) == failed
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
        print('Passed allocator startup:', overrides or 'application default')
