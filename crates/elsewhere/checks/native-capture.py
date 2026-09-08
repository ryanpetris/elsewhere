"""Run inside Docker with PipeWire, WirePlumber, FFmpeg and this checkout.

python crates/elsewhere/checks/native-capture.py
Failed trials retain configuration and logs; capture timeouts also save the native graph.
"""
import argparse
import array
import json
import os
from pathlib import Path
import shutil
import select
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--trials', type=int, default=30)
args = parser.parse_args()
if args.trials < 1:
    parser.error('--trials must be positive')
config = Path(__file__).resolve().parents[1] / 'src/audio'
for command in [['pipewire', '--version'], ['wireplumber', '--version'], ['ffmpeg', '-version']]:
    subprocess.run(command, check=True, timeout=5)

for trial in range(1, args.trials + 1):
    root = Path(tempfile.mkdtemp(prefix='elsewhere-native-capture-'))
    env = dict(os.environ, HOME=str(root), XDG_RUNTIME_DIR=str(root), PIPEWIRE_RUNTIME_DIR=str(root),
               PIPEWIRE_REMOTE=str(root / 'pipewire-0'), PIPEWIRE_CONFIG_DIR=str(root),
               WIREPLUMBER_CONFIG_DIR=str(root), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_STATE_HOME=str(root / 'state'))
    shutil.copy('/usr/share/pipewire/pipewire.conf', root / 'pipewire.conf')
    shutil.copy('/usr/share/pipewire/client.conf', root / 'client.conf')
    (root / 'pipewire.conf.d').mkdir()
    shutil.copy(config / 'pipewire.conf', root / 'pipewire.conf.d/99-elsewhere.conf')
    (root / 'wireplumber.conf').write_text(Path('/usr/share/wireplumber/wireplumber.conf').read_text()
                                        + '\n' + (config / 'wireplumber.conf').read_text())
    children = []
    passed = False

    def start(command, name, stdin=None, pipe=False):
        with (root / (name + '.log')).open('wb') as log:
            process = subprocess.Popen(command, env=env, stdin=stdin, stdout=subprocess.PIPE if pipe else log, stderr=log)
        children.append(process)
        return process

    def stop(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def graph():
        return json.loads(subprocess.check_output(['pw-dump'], env=env, timeout=3, stderr=subprocess.DEVNULL))

    def capture(target, channels, name, require_tone=False):
        command = ['pw-record', '--target', target, '--raw', '--format=f32', '--rate=48000', f'--channels={channels}', '--latency=20ms',
                   '--properties', '{ node.dont-fallback = true node.linger = true '
                   + ('stream.capture.sink = true ' if channels == 2 else '') + '}']
        command.append('-')
        with (root / (name + '.log')).open('wb') as log:
            process = subprocess.Popen(command, env=env,
                                       stdout=subprocess.PIPE, stderr=log)
        children.append(process)
        try:
            deadline = time.monotonic() + 6
            data = bytearray()
            heard_tone = False
            while len(data) < 20 * 1024 * channels * 4 or (require_tone and not heard_tone):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                    raise subprocess.TimeoutExpired(command, 6)
                block = os.read(process.stdout.fileno(), 65536)
                if not block:
                    break
                data.extend(block)
                if require_tone:
                    samples = array.array('f', block[:len(block) // 4 * 4])
                    heard_tone |= any(abs(sample) > .05 for sample in samples)
            process.send_signal(signal.SIGINT)
            tail, _ = process.communicate(timeout=max(.01, deadline - time.monotonic()))
            data.extend(tail)
        except subprocess.TimeoutExpired:
            try:
                (root / 'stalled-graph.json').write_text(json.dumps(graph(), indent=2))
            except (subprocess.SubprocessError, json.JSONDecodeError) as error:
                (root / 'graph-error.txt').write_text(str(error))
            raise AssertionError(f'{name}: capture exceeded six seconds')
        assert process.returncode in (0, 1) and data, f'{name}: capture failed with {process.returncode}'
        samples = array.array('f')
        samples.frombytes(data)
        assert len(samples) % channels == 0, f'{name}: incomplete frame'
        assert len(samples) // channels >= 20 * 1024, f'{name}: capture ended before the minimum sample duration'
        return max(map(abs, samples)), len(samples) // channels

    try:
        start(['pipewire'], 'pipewire')
        deadline = time.monotonic() + 8
        while not (root / 'pipewire-0').exists():
            assert time.monotonic() < deadline, 'PipeWire socket did not appear'
            time.sleep(.01)
        start(['wireplumber', '--profile=elsewhere'], 'wireplumber')
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                nodes = [item for item in graph() if item['type'].endswith(':Node')]
                if all(any(node['info']['props'].get('node.name') == name and node['info']['state'] == 'running'
                           for node in nodes) for name in ['elsewhere-output', 'elsewhere-microphone']):
                    break
            except (subprocess.SubprocessError, json.JSONDecodeError):
                pass
            time.sleep(.05)
        else:
            raise AssertionError('virtual nodes did not start processing')
        output = capture('elsewhere-output', 2, 'output')
        idle = capture('elsewhere-microphone', 1, 'idle')
        assert max(output[0], idle[0]) < .0001, 'idle devices must deliver silence'
        for cycle in range(2):
            generator = start(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                               'sine=frequency=880:sample_rate=48000', '-af', 'volume=0.8', '-f', 'f32le', 'pipe:1'],
                              f'generator-{cycle}', pipe=True)
            publisher = start(['pw-cat', '--playback', '--raw', '--rate=48000', '--channels=1', '--format=f32',
                               '--target=elsewhere-microphone-input', '--latency=20ms',
                               '--properties', '{ node.name = native-capture-test-tone }', '-'],
                              f'publisher-{cycle}', stdin=generator.stdout)
            generator.stdout.close()
            deadline = time.monotonic() + 3
            while not any(node.get('info', {}).get('props', {}).get('node.name') == 'native-capture-test-tone'
                          and node['info']['state'] == 'running' for node in graph()):
                assert generator.poll() is None and publisher.poll() is None, 'tone publisher exited'
                assert time.monotonic() < deadline, 'tone publisher did not start processing'
                time.sleep(.02)
            tone = capture('elsewhere-microphone', 1, f'tone-{cycle}', require_tone=True)
            assert tone[0] > .05, 'live microphone did not deliver the tone'
            stop(publisher)
            stop(generator)
            quiet = capture('elsewhere-microphone', 1, f'stopped-{cycle}')
            assert quiet[0] < .0001, 'stopped microphone delivered stale samples'
        passed = True
        print(f'trial {trial}: output={output} idle={idle} tone={tone} stopped={quiet}', flush=True)
    except BaseException:
        print(f'FAILED trial {trial}; evidence retained at {root}', flush=True)
        raise
    finally:
        for child in reversed(children):
            stop(child)
        if passed:
            shutil.rmtree(root)
