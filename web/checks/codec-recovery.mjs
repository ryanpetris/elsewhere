// Docker: inject returned FFmpeg errors into real desktop/window encoders, without a GPU reset.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp('/tmp/elsewhere-codec-recovery-');
const mode = root + '/mode';
const renderNode = process.env.ELSEWHERE_RENDER_NODE ?? 'none';
const backup = renderNode === 'none' ? 'vp8' : 'hevc';
const backupWire = wire => backup === 'vp8' ? wire === 'vp8' : wire.startsWith('hev1');
const binary = process.env.ELSEWHERE_BINARY ?? '/src/target/release/elsewhere';
await mkdir(root + '/home'); await mkdir(root + '/runtime', { mode: 0o700 });
await writeFile(mode, '');
await writeFile(root + '/fault.c', `
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
static int fault(AVCodecContext *c, const char *operation) {
    if (c->width == 320 && c->height == 180) return 0; /* startup probe */
    char mode[80] = {0}; FILE *f = fopen(getenv("ELSEWHERE_TEST_FAULT"), "r");
    if (f) { fgets(mode, sizeof(mode), f); fclose(f); }
    int fail = !strcmp(mode, "all") || (c->codec_id == AV_CODEC_ID_H264 && !strcmp(mode, operation));
    if (fail) fprintf(stderr, "injected %s failure codec=%d frames=%ld\\n", operation, c->codec_id, (long)c->frame_num);
    return fail;
}
int avcodec_open2(AVCodecContext *c, const AVCodec *codec, AVDictionary **opts) {
    int (*real)(AVCodecContext*, const AVCodec*, AVDictionary**) = dlsym(RTLD_NEXT, "avcodec_open2");
    if (fault(c, "open")) return AVERROR(EIO);
    return real(c, codec, opts);
}
int avcodec_send_frame(AVCodecContext *c, const AVFrame *frame) {
    int (*real)(AVCodecContext*, const AVFrame*) = dlsym(RTLD_NEXT, "avcodec_send_frame");
    if (frame && c->frame_num >= 1 && fault(c, "encode")) return AVERROR(EIO);
    return real(c, frame);
}
`);
execFileSync('cc', ['-shared', '-fPIC', '-o', root + '/fault.so', root + '/fault.c', '-ldl']);
const log = await open(root + '/server.log', 'w');
const origin = `http://127.0.0.1:${process.env.ELSEWHERE_TEST_PORT ?? 8092}`;
const env = { ...process.env, HOME: root + '/home', XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime', LD_PRELOAD: root + '/fault.so', ELSEWHERE_TEST_FAULT: mode };
const server = spawn(binary, ['--no-audio', '--no-tls', '--no-rtc', '--render-node', renderNode, '--codecs', `${backup},h264,${backup}`, '--screen-size', '320x240', '--listen', origin.slice(7), '--exec', 'foot --app-id=codec-recovery'], { env, stdio: ['ignore', log.fd, log.fd] });
const sockets = [];
const wait = async predicate => {
  for (let n = 0; n < 300; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); }
  throw Error('codec recovery timed out');
};
let keyTimer;
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = await createToken(root);
  const headers = { Authorization: `Bearer ${token}` };
  assert.deepEqual((await (await fetch(origin + '/api/codecs', { headers })).json()).map(c => c.codec), ['h264', backup]);
  let windowId;
  await wait(async () => { windowId = (await (await fetch(origin + '/api/windows', { headers })).json()).find(w => w.app_id === 'codec-recovery')?.id; return windowId; });
  const connect = async (id, codecs) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws' + (id ? '/window/' + id : ''));
    sockets.push(socket); socket.binaryType = 'arraybuffer';
    const states = [], configs = [], frames = [];
    socket.addEventListener('message', ({ data }) => {
      const bytes = new Uint8Array(data);
      if (bytes[0] === 0x0c) states.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
      if (bytes[0] === 1) configs.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
      if (bytes[0] === 2) frames.push({ key: !!(bytes[1] & 1), config: configs.at(-1) });
    });
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const json = (tag, data) => socket.send(new Uint8Array([tag, ...new TextEncoder().encode(JSON.stringify(data))]));
    socket.send(new Uint8Array([0x80, ...new TextEncoder().encode(token)]));
    json(0x81, { codecs });
    return { socket, states, configs, frames, choose: codecs => json(0x8f, { codecs }) };
  };
  keyTimer = setInterval(() => { for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array([0x88])); }, 100);
  for (const id of [null, windowId]) {
    const viewer = await connect(id, [backup, 'h264']);
    await wait(() => viewer.frames.length);
    assert.equal(viewer.states[0].codec, backup, 'client order overrides server probe order');
    assert(viewer.frames[0].key);
    for (const failure of ['open', 'encode']) {
      await writeFile(mode, failure);
      viewer.states.length = 0; viewer.frames.length = 0;
      viewer.choose(['h264', backup]);
      await wait(() => viewer.states.some(s => s.status === 'switching' && s.codec === backup) && viewer.frames.some(f => backupWire(f.config.codec)));
      assert.deepEqual(viewer.states.filter(s => ['starting', 'retrying', 'switching'].includes(s.status)).map(s => [s.status, s.codec]), [['starting', 'h264'], ['retrying', 'h264'], ['switching', backup]]);
      if (failure === 'encode') assert(viewer.frames.some(f => f.config.codec.startsWith('avc1')), 'a keyframe precedes each injected encoding failure');
      assert.equal(viewer.socket.readyState, WebSocket.OPEN);
    }
    await writeFile(mode, 'all');
    viewer.states.length = 0;
    viewer.choose(['h264', backup]);
    await wait(() => viewer.states.some(s => s.status === 'failed'));
    const lastAttempt = viewer.states.at(-1).attempt;
    assert.equal(viewer.states.at(-1).codec, null);
    assert.equal(viewer.states.filter(s => s.status === 'retrying').length, 2);
    await new Promise(r => setTimeout(r, 350)); // keyframe requests must not revive exhausted encoders
    assert.equal(viewer.states.at(-1).attempt, lastAttempt);
    assert.equal(viewer.socket.readyState, WebSocket.OPEN);
    await writeFile(mode, '');
    viewer.frames.length = 0;
    viewer.choose(['h264', backup]);
    await wait(() => viewer.frames.some(f => f.config.codec.startsWith('avc1')));
    assert(viewer.states.at(-1).attempt > lastAttempt);
    viewer.choose([backup]); viewer.choose(['h264']); viewer.choose([backup]);
    await wait(() => viewer.states.at(-1).codec === backup && viewer.states.at(-1).status === 'streaming');
    viewer.choose([]);
    await wait(() => viewer.states.at(-1).status === 'failed');
    viewer.choose([backup]);
    await wait(() => viewer.states.at(-1).status === 'streaming');
    viewer.socket.close();
    await wait(() => viewer.socket.readyState === WebSocket.CLOSED);
  }
  for (const value of ['', 'bogus', 'h264,']) {
    assert.throws(() => execFileSync(binary, ['--codecs', value], { env, stdio: 'pipe', timeout: 5000 }), error => error.status === 2, `reject invalid allowlist ${JSON.stringify(value)}`);
  }
  console.log('real desktop/window codec ordering, twice-failure fallback, keyframe history, exhaustion, retry and rapid selections passed');
} catch (error) {
  await writeFile('/tmp/elsewhere-codec-recovery-failure.log', await readFile(root + '/server.log'));
  throw error;
} finally {
  clearInterval(keyTimer);
  for (const socket of sockets) socket.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  await log.close(); await rm(root, { recursive: true, force: true });
}
