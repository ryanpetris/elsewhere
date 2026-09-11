// Docker: one Elsewhere H.264 packet decoded by FFmpeg and software WebCodecs.
// --diagnose also records the native headed hardware path, including upstream color errors.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';
const root = await mkdtemp('/tmp/elsewhere-color-isolation-');
const children = [], logs = [], browsers = [];
const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const diagnose = process.argv.includes('--diagnose');
assert(process.env.ELSEWHERE_RENDER_NODE, 'set ELSEWHERE_RENDER_NODE to the source render node, or none');
const expected = [229, 42, 97];
const matches = pixel => pixel?.length >= 3 && expected.every((value, channel) => Math.abs(pixel[channel] - value) <= 4);
await writeFile(root + '/environment.json', JSON.stringify({
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  chromium: execFileSync('chromium', ['--version'], { encoding: 'utf8' }).trim(),
}, null, 2));
async function desktop(name, port, node, codec, software = false) {
  const home = `${root}/${name}`; await mkdir(home, {mode: 0o700});
  const log = await open(home + '/server.log', 'w'); logs.push(log);
  const child = spawn(binary, ['--no-audio', '--no-rtc', '--no-tls', '--listen', `127.0.0.1:${port}`, '--render-node', node,
    '--codecs', codec, '--socket-name', name, '--screen-size', '1346x908', ...(software ? ['--software-encoding'] : [])],
    {env: {...process.env, XDG_RUNTIME_DIR:home, XDG_CONFIG_HOME: home+'/config'}, stdio:['ignore',log.fd,log.fd]});
  children.push(child);
  for (let i=0;i<300;i++) {
    try {if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return home;} catch {}
    assert(child.exitCode === null && child.signalCode === null, `${name} exited; see ${home}/server.log`); await new Promise(r=>setTimeout(r,50));
  }
  throw Error('startup timeout');
}
try {
  const source = await desktop('color-source',8860,process.env.ELSEWHERE_RENDER_NODE,'h264');
  const host = await desktop('color-host',8861,process.env.ELSEWHERE_BROWSER_RENDER_NODE || '/dev/dri/renderD128','vp8',true);
  const token = await createToken(source);
  const browser = await chromium.launch({executablePath:'/usr/bin/chromium', args:['--no-sandbox']}); browsers.push(browser);
  const context = await browser.newContext();
  await context.addInitScript(()=>{
    const Native = VideoDecoder;
    window.keys=[]; window.VideoDecoder=class extends Native {
      configure(config) {this.config=config; super.configure(config);}
      decode(chunk) {
        if(chunk.type==='key') {const bytes=new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); keys.push({config:this.config, bytes:[...bytes], timestamp:chunk.timestamp});}
        super.decode(chunk);
      }
    };
  });
  const main = await context.newPage(); await main.goto('http://127.0.0.1:8860/#token='+token);
  await main.waitForFunction(()=>elsewhere.store.get().stats.frames>0);
  execFileSync('cc',['/src/crates/elsewhere-compositor/checks/x11-placement.c','-lX11','-o',root+'/client']);
  await writeFile(root+'/command','');
  await main.evaluate(cmd=>elsewhere.spawn(cmd),`${root}/client managed 1 ${root}/command ${root}/report`);
  await main.waitForFunction(()=>elsewhere.store.get().windows.some(w=>w.title==='x11-placement-check'));
  const id=await main.evaluate(()=>elsewhere.store.get().windows.find(w=>w.title==='x11-placement-check').id);
  const windowPage=await context.newPage(); await windowPage.goto(`http://127.0.0.1:8860/?window=${id}#token=${token}`);
  await windowPage.waitForFunction(()=>keys.length>0 && elsewhere.store.get().stats.frames>0);
  await windowPage.waitForTimeout(500);
  const snapshot = await windowPage.evaluate(async id => {
    const image = await createImageBitmap(await elsewhere.snapshot(id));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); image.close();
    return { rgb: [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3), png: canvas.toDataURL() };
  }, id);
  assert.deepEqual(snapshot.rgb, expected, 'source compositor PNG');
  await writeFile(root + '/source.png', Buffer.from(snapshot.png.split(',')[1], 'base64'));
  const packet=await windowPage.evaluate(()=>keys.at(-1));
  await writeFile(root+'/packet.h264',Buffer.from(packet.bytes));
  await writeFile(root+'/packet.json',JSON.stringify(packet));
  const rgb=execFileSync('ffmpeg',['-v','error','-i',root+'/packet.h264','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',root+'/packet.h264'],{encoding:'utf8'})).streams[0];
  const offset=(Math.floor(probe.height/2)*probe.width+Math.floor(probe.width/2))*3;
  const reference = [...rgb.subarray(offset, offset + 3)];
  assert(matches(reference), 'FFmpeg mixed saturated color: ' + reference);
  assert.equal(probe.color_space, 'bt709');
  assert.equal(probe.color_range, 'tv');
  console.log('ffmpeg', JSON.stringify({ rgb: reference, stream: probe }));
  const results = [];
  await browser.close(); browsers.pop();
  for(const mode of ['headless', 'headed-no-hw-decode', ...(diagnose ? ['headed'] : [])]) {
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:mode==='headless',
      args:['--no-sandbox',...(mode==='headless'?[]:['--ozone-platform=wayland']),
        ...(mode==='headed-no-hw-decode'?['--disable-accelerated-video-decode']:[])],
      env:{...process.env,XDG_RUNTIME_DIR:host,WAYLAND_DISPLAY:'color-host'}}); browsers.push(browser);
    if (mode !== 'headless') {
      const session = await browser.newBrowserCDPSession();
      const { gpu } = await session.send('SystemInfo.getInfo');
      console.log('browser GPU', JSON.stringify({ mode, features: gpu.featureStatus, renderer: gpu.auxAttributes.glRenderer }));
      if (mode === 'headed-no-hw-decode') {
        assert.equal(gpu.featureStatus.gpu_compositing, 'enabled', 'workaround retains GPU compositing');
        assert.equal(gpu.featureStatus['2d_canvas'], 'enabled', 'workaround retains accelerated Canvas2D');
        assert.notEqual(gpu.featureStatus.video_decode, 'enabled', 'hardware video decode is disabled');
        assert(typeof gpu.auxAttributes.glRenderer === 'string' && gpu.auxAttributes.glRenderer.length > 0, 'browser reports its GL renderer');
        assert(!/swiftshader|llvmpipe|software/i.test(gpu.auxAttributes.glRenderer), 'workaround uses a hardware GL renderer');
      }
      await session.detach();
    }
    const page=await browser.newPage();
    await page.route('http://127.0.0.1:8861/replay', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto('http://127.0.0.1:8861/replay');
    for(const acceleration of ['no-preference','prefer-software','prefer-hardware']) {
      const result=await page.evaluate(async ({packet,acceleration})=>{
        const config={...packet.config,hardwareAcceleration:acceleration};
        if(!(await VideoDecoder.isConfigSupported(config)).supported)return {supported:false};
        const reads=[]; let error;
        const decoder=new VideoDecoder({output(frame){reads.push((async()=>{
          try {
            const x=Math.floor(frame.displayWidth/2),y=Math.floor(frame.displayHeight/2);
            const canvas=document.createElement('canvas');canvas.width=frame.displayWidth;canvas.height=frame.displayHeight;
            const ctx=canvas.getContext('2d');ctx.drawImage(frame,0,0);
            const result={format:frame.format,colorSpace:frame.colorSpace.toJSON(),canvas:[...ctx.getImageData(x,y,1,1).data]};
            const rgba=new Uint8Array(frame.allocationSize({format:'RGBA'}));
            const layout=await frame.copyTo(rgba,{format:'RGBA',colorSpace:'srgb'});
            const offset=layout[0].offset+y*layout[0].stride+x*4;result.copyRGBA=[...rgba.slice(offset,offset+4)];
            if(frame.format) {
              const raw=new Uint8Array(frame.allocationSize());const layout=await frame.copyTo(raw);
              if (frame.format === 'I420' || frame.format === 'NV12') result.planes=layout.map((p,i)=>[...raw.slice(p.offset+Math.floor(y/(i?2:1))*p.stride+Math.floor(x/(i?2:1))*(frame.format==='NV12'&&i?2:1),p.offset+Math.floor(y/(i?2:1))*p.stride+Math.floor(x/(i?2:1))*(frame.format==='NV12'&&i?2:1)+2)]);
              const memoryFrame=new VideoFrame(raw,{format:frame.format,codedWidth:frame.visibleRect.width,codedHeight:frame.visibleRect.height,timestamp:0,layout,colorSpace:frame.colorSpace.toJSON()});
              ctx.drawImage(memoryFrame,0,0);result.memoryCanvas=[...ctx.getImageData(x,y,1,1).data];memoryFrame.close();
            }
            return result;
          }finally{frame.close();}
        })());},error(e){error=e.message;}});
        try{decoder.configure(config);decoder.decode(new EncodedVideoChunk({type:'key',timestamp:packet.timestamp,data:new Uint8Array(packet.bytes)}));await decoder.flush();return {supported:true,frames:await Promise.all(reads),error};}
        catch(e){return {supported:true,error:String(e)};}
        finally{if(decoder.state!=='closed')decoder.close();}
      },{packet,acceleration});
      const row = { mode, acceleration, ...result };
      const required = acceleration !== 'prefer-hardware' && (mode !== 'headed' || acceleration === 'prefer-software');
      if (required) {
        assert.equal(result.supported, true, JSON.stringify(row));
        assert.equal(result.error, undefined, JSON.stringify(row));
        assert.equal(result.frames.length, 1, JSON.stringify(row));
        for (const frame of result.frames) {
          for (const field of ['canvas', 'copyRGBA', 'memoryCanvas']) assert(matches(frame[field]), `${mode}/${acceleration}/${field}: ${frame[field]}`);
          assert.deepEqual(frame.colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
        }
      }
      row.colorMatches = result.frames?.length > 0 && result.frames.every(frame => matches(frame.canvas) && matches(frame.copyRGBA) && (!frame.format || matches(frame.memoryCanvas)));
      results.push(row);
      console.log(JSON.stringify(row));
      await writeFile(root + '/results.json', JSON.stringify(results, null, 2));
    }
    await browser.close();browsers.pop();
  }
}finally{
  for(const browser of browsers)await browser.close().catch(()=>{});
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer);
  }
  await Promise.all(logs.map(log=>log.close()));console.log('Color artifacts',root);
}
