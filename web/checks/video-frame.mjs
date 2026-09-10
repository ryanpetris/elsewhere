// Docker: native VideoFrame views and Canvas 2D, with synthetic edge landmarks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', req.url === '/video-frame.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/video-frame.js' ? await readFile(new URL('../src/video-frame.js', import.meta.url)) : '<!doctype html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(async () => {
    const { visibleVideoFrame } = await import('/video-frame.js');
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const results = [];
    for (const [width, height, codedWidth, codedHeight, x, y, cropped] of [
      [1920, 1080, 1920, 1088, 0, 0, false],
      [1346, 908, 1408, 912, 0, 0, false],
      [64, 48, 64, 48, 0, 0, false],
      [62, 46, 64, 48, 0, 0, true],
      [61, 45, 68, 54, 2, 4, false],
      [61, 45, 68, 54, 2, 4, true],
    ]) {
      const data = new Uint8Array(codedWidth * codedHeight * 4);
      for (let row = 0; row < codedHeight; row++) for (let col = 0; col < codedWidth; col++) {
        const inside = col >= x && row >= y && col < x + width && row < y + height;
        const color = !inside ? [0, 255, 0, 255] : row === y ? [255, 0, 0, 255] :
          col === x ? [0, 0, 255, 255] : row === y + height - 1 ? [255, 255, 0, 255] :
          col === x + width - 1 ? [255, 0, 255, 255] : [40, 60, 80, 255];
        data.set(color, (row * codedWidth + col) * 4);
      }
      const storage = new VideoFrame(data, { format: 'RGBA', codedWidth, codedHeight, timestamp: 12345, duration: 33333,
        colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true } });
      const frame = new VideoFrame(storage, {
        visibleRect: { x, y, width: cropped ? width : codedWidth - x, height: cropped ? height : codedHeight - y },
        displayWidth: cropped ? width : codedWidth - x, displayHeight: cropped ? height : codedHeight - y });
      storage.close();
      check(frame.visibleRect.x === x && frame.visibleRect.y === y, 'fixture has nonzero origin');
      const color = JSON.stringify(frame.colorSpace.toJSON());
      const output = visibleVideoFrame(frame, { width, height });
      check(output.displayWidth === width && output.displayHeight === height, 'display size');
      check(output.visibleRect.x === x && output.visibleRect.y === y, 'visible origin');
      check(output.timestamp === 12345 && output.duration === 33333, 'timing preserved');
      check(JSON.stringify(output.colorSpace.toJSON()) === color, 'color preserved');
      check(output === frame || frame.codedWidth === 0, 'replaced reference closed');
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
      ctx.drawImage(output, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) for (let c = 0; c < 4; c++) {
        check(pixels[(row * width + col) * 4 + c] === data[((row + y) * codedWidth + col + x) * 4 + c], `pixel ${col},${row},${c}`);
      }
      check(visibleVideoFrame(output, { width, height }) === output, 'no double crop');
      output.close(); check(output.codedWidth === 0, 'view released');
      results.push({ width, height, codedWidth, codedHeight, x, y, cropped });
    }
    for (const format of ['I420', 'NV12']) {
      const data = new Uint8Array(96).fill(128); data.fill(64, 0, 64);
      const storage = new VideoFrame(data, { format, codedWidth: 8, codedHeight: 8, timestamp: 3 });
      const source = new VideoFrame(storage, { visibleRect: { x: 2, y: 2, width: 6, height: 6 } }); storage.close();
      const output = visibleVideoFrame(source, { width: 3, height: 3 });
      check(output.visibleRect.x === 2 && output.visibleRect.y === 2, 'subsampled visible origin');
      check(source.codedWidth === 0, 'subsampled original released');
      const pixels = new Uint8Array(output.allocationSize()); await output.copyTo(pixels); output.close();
      check(pixels.slice(0, 9).every(v => v === 64) && pixels.slice(9).every(v => v === 128), 'odd subsampled crop pixels');
    }
    for (const size of [{ width: 65, height: 48 }, { width: 64, height: 49 }, { width: 0, height: 48 }, { width: NaN, height: 48 }, { width: 1.5, height: 48 }]) {
      const frame = new VideoFrame(new Uint8Array(64 * 48 * 4), { format: 'RGBA', codedWidth: 64, codedHeight: 48, timestamp: 1 });
      let failed = false;
      try { visibleVideoFrame(frame, size); } catch { failed = true; }
      check(failed && frame.codedWidth === 0, 'invalid geometry releases frame');
    }
    // Correct pixel extent with incorrect aspect metadata still needs square-pixel display sizing.
    const stretched = new VideoFrame(new Uint8Array(64 * 48 * 4), { format: 'RGBA', codedWidth: 64, codedHeight: 48, displayWidth: 128, displayHeight: 48, timestamp: 2 });
    const square = visibleVideoFrame(stretched, { width: 64, height: 48 });
    check(square.displayWidth === 64 && stretched.codedWidth === 0, 'square pixel geometry'); square.close();
    return results;
  });
  assert.equal(results.length, 6);
  console.log('Native VideoFrame crop: exact edge pixels, existing crop/origin, odd sizes, timing/color, ownership and invalid geometry passed', results);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
