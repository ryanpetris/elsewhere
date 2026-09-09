import { createToken } from './token-fixture.mjs';
// Run inside the Docker rig: node checks/rtc-endpoint.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const root = await mkdtemp(tmpdir() + '/elsewhere-rtc-endpoint-');
await mkdir(root + '/runtime', { mode: 0o700 });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--host-resolver-rules=MAP viewer.example.test 127.0.0.1, MAP viewer.example.test. 127.0.0.1', '--unsafely-treat-insecure-origin-as-secure=http://viewer.example.test:8097', '--no-proxy-server'] });
try {
  for (const [host, args, expectedPort] of [
    ['127.0.0.1', [], 8097],
    ['localhost', [], 8097],
    ['viewer.example.test', [], 8097],
    ['[::1]', [], 8097],
    ['viewer.example.test', ['--rtc-port', '8098'], 8098],
    ['localhost', ['--rtc-addr', '127.0.0.1', '--rtc-port', '8098'], 8098],
  ]) {
    const log = await open(root + '/desktop.log', 'w');
    const desktop = spawn((process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere'), ['--no-audio', '--no-tls', '--render-node', 'none', '--codec', 'vp8', '--listen', '[::]:8097', ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' },
      stdio: ['ignore', log.fd, log.fd],
    });
    const exited = new Promise(resolve => desktop.once('exit', resolve));
    const context = await browser.newContext();
    try {
      const origin = `http://${host}:8097`;
      let ready = false;
      for (let i = 0; i < 200; i++) {
        try { if ((await fetch('http://127.0.0.1:8097')).ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(ready, await readFile(root + '/desktop.log', 'utf8'));
      const token = await createToken(root);
      await context.addInitScript(() => {
        window.endpointReplies = [];
        const Socket = WebSocket;
        window.WebSocket = class extends Socket {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({data}) => {
              const bytes = new Uint8Array(data);
              if (bytes[0] === 0x0d) endpointReplies.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
            });
          }
        };
        const Original = RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(...args) { super(...args); window.testPeer = this; }
          setRemoteDescription(answer) { window.appliedAnswer = answer.sdp; return super.setRemoteDescription(answer); }
        };
      });
      const page = await context.newPage();
      await page.goto(`${origin}/#token=${token}`);
      await page.waitForFunction(() => window.elsewhere?.store.get().rtcAvailable);
      await page.evaluate(() => elsewhere.setTransport('webrtc'));
      await page.waitForFunction(() => elsewhere.store.get().videoVia === 'webrtc', null, { timeout: 15000 });
      const remote = await page.evaluate(async () => {
        const stats = await testPeer.getStats();
        const pair = [...stats.values()].find(s => s.type === 'candidate-pair' && s.nominated);
        return stats.get(pair.remoteCandidateId);
      });
      assert.equal(remote.port, expectedPort);
      const expected = host === '[::1]' ? ['::1'] : host === 'localhost' && !args.includes('--rtc-addr') ? ['127.0.0.1', '::1'] : ['127.0.0.1'];
      const candidates = await page.evaluate(() => appliedAnswer.split('\r\n').filter(l => l.startsWith('a=candidate:')).map(l => l.split(/\s+/)));
      assert.equal(candidates.length, 1);
      for (const candidate of candidates) {
        assert.equal(candidate[4], args.includes('--rtc-addr') ? '127.0.0.1' : host.replace(/^\[|\]$/g, ''));
        assert.equal(Number(candidate[5]), expectedPort);
      }
      const config = await page.evaluate(() => endpointReplies.find(v => v.ice_servers));
      assert.equal(config.port, expectedPort);
      assert.equal(config.host, args.includes('--rtc-addr') ? '127.0.0.1' : undefined);
      assert(expected.includes(remote.address), JSON.stringify(remote));
      console.log(`${host}, ${args.join(' ') || 'page hostname'}: connected to ${remote.address}:${remote.port}`);
    } finally {
      await context.close();
      desktop.kill('SIGTERM');
      await exited;
      await log.close();
    }
  }
} finally {
  await browser.close();
  await rm(root, { recursive: true, force: true });
}
