"""Run inside Docker with PipeWire, WirePlumber, GStreamer and this checkout.

python crates/elsewhere/checks/native-capture.py
Use --sink-async=false to probe immediate sink activation, and --source-clock=false
to disable the native clock provider on plugin versions that expose that property.
Failed trials retain configuration and logs; capture timeouts also save the native graph.
"""
import argparse
import array
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--trials', type=int, default=30)
parser.add_argument('--sink-async', choices=['true', 'false'], default='true')
parser.add_argument('--source-clock', choices=['true', 'false'])
args = parser.parse_args()
if args.trials < 1:
    parser.error('--trials must be positive')
config = Path(__file__).resolve().parents[1] / 'src/audio'
for command in [['pipewire', '--version'], ['wireplumber', '--version'], ['gst-launch-1.0', '--version']]:
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

    def start(command, name):
        with (root / (name + '.log')).open('wb') as log:
            process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
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

    def capture(target, channels, name):
        command = ['gst-launch-1.0', '-q', 'pipewiresrc', 'target-object=' + target, 'num-buffers=20']
        if args.source_clock is not None:
            command.append('provide-clock=' + args.source_clock)
        if channels == 2:
            command.append('stream-properties=properties,stream.capture.sink=(boolean)true')
        command += ['!', f'audio/x-raw,format=F32LE,rate=48000,channels={channels}',
                    '!', 'fdsink', 'fd=1', 'sync=false', 'async=' + args.sink_async]
        with (root / (name + '.log')).open('wb') as log:
            process = subprocess.Popen(command, env=dict(env, GST_DEBUG='pipewire*:5'),
                                       stdout=subprocess.PIPE, stderr=log)
        children.append(process)
        try:
            data, _ = process.communicate(timeout=6)
        except subprocess.TimeoutExpired:
            try:
                (root / 'stalled-graph.json').write_text(json.dumps(graph(), indent=2))
            except (subprocess.SubprocessError, json.JSONDecodeError) as error:
                (root / 'graph-error.txt').write_text(str(error))
            raise AssertionError(f'{name}: capture exceeded six seconds')
        assert process.returncode == 0 and data, f'{name}: capture failed with {process.returncode}'
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
            publisher = start(['gst-launch-1.0', '-q', 'audiotestsrc', 'is-live=true', 'freq=880', 'volume=0.1',
                               '!', 'audioconvert', '!', 'audio/x-raw,rate=48000,channels=1',
                               '!', 'pipewiresink', 'target-object=elsewhere-microphone-input', 'sync=false'],
                              f'publisher-{cycle}')
            tone = capture('elsewhere-microphone', 1, f'tone-{cycle}')
            assert tone[0] > .05, 'live microphone did not deliver the tone'
            stop(publisher)
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
