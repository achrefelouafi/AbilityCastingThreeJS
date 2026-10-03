// node capture.mjs <shots.json> [only,comma,list]
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import fs from 'fs';
const shots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const only = process.argv[3] ? process.argv[3].split(',') : null;
const W = +(process.env.PW || 1080), H = +(process.env.PH || 524);
const PREVIEW = process.env.PREVIEW ? process.env.PREVIEW.split(',').map(Number) : null;
fs.mkdirSync('clips', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', protocolTimeout: 600000,
  args: ['--use-angle=d3d11', '--enable-gpu', '--force_high_performance_gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
});
async function freshPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[err]', e.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.app, { timeout: 240000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.addScriptTag({ path: 'harness.js' });
  await page.evaluate((w, h) => __cap.setup({ width: w, height: h, ratio: 2 }), W, H);
  return page;
}
for (const shot of shots) {
  if (only && !only.includes(shot.name)) continue;
  const t0 = Date.now();
  // A fresh page per shot: every clip starts from the same untouched state.
  const page = await freshPage();
  await page.evaluate((s) => {
    __cap.placeDummies(s.dummies);
    __cap.setCamera(s.camera);
    __cap.resetFrame();
    __cap.step(s.preroll ?? 45); // let the idle settle in the shot's own camera
    __cap.resetFrame();
    if (s.setup) (new Function('app', 'settings', s.setup))(window.app, __cap.state.settings);
    __cap.cast(s.element, s.target);
  }, shot);
  if (PREVIEW) {
    if (shot.skip) await page.evaluate((n) => __cap.step(n), shot.skip);
    let at = 0;
    fs.mkdirSync('prev', { recursive: true });
    for (const frac of PREVIEW) {
      const f = Math.round(frac * shot.frames);
      if (f - at > 1) await page.evaluate((n) => __cap.step(n), f - at - 1);
      const url = await page.evaluate(() => { __cap.step(1); return __cap.grab('image/jpeg', 0.9); });
      at = f;
      fs.writeFileSync(`prev/${shot.name}_${frac}.jpg`, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    }
    await page.close();
    console.log(`${shot.name}: preview`);
    continue;
  }
  const out = `${shot.dir ?? 'clips'}/${shot.name}.mp4`;
  fs.mkdirSync(shot.dir ?? 'clips', { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '9', '-pix_fmt', 'yuv444p', '-r', '60', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise(r => ff.on('close', r));
  if (shot.skip) await page.evaluate((n) => __cap.step(n), shot.skip);
  for (let f = 0; f < shot.frames; f++) {
    const url = await page.evaluate(() => { __cap.step(1); return __cap.grab(); });
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  await page.close();
  console.log(`${shot.name}: ${shot.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await browser.close();
