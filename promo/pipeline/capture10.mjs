// node capture10.mjs solo.json [only] — 10 s showcase per ability, with a live-edit pause.
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import fs from 'fs';
import { stateAt, rotateHue } from './timeline.mjs';
const shots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const only = process.argv[3] ? process.argv[3].split(',') : null;
const W = 1920, H = 964;
const LABEL = { shark: 'Abyssal', chains: 'Chains', dragon: 'Dragonfire', gyro: 'Stormheart', amethyst: 'Amethyst', tome: 'Astral Tome', reliquary: 'Wildroot', lance: 'Starbreaker', wolf: 'Astral Fang' };
fs.mkdirSync('solo', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000,
  args: ['--use-angle=d3d11', '--enable-gpu', '--force_high_performance_gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
});
for (const shot of shots) {
  if (only && !only.includes(shot.name)) continue;
  const t0 = Date.now();
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[err]', e.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.app, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.addScriptTag({ path: 'harness.js' });
  await page.evaluate((w, h) => __cap.setup({ width: w, height: h, ratio: 2 }), W, H);

  // Find the editor's own controllers for the chosen keys, and the palette.
  const meta = await page.evaluate((s, label) => {
    const folder = app.editor.gui.folders.find((f) => f._title.includes(label));
    const all = folder.controllersRecursive();
    const pathOf = (ctl) => { const p = []; let n = ctl.parent; while (n && n !== folder) { p.unshift(n._title); n = n.parent; } return p.join(' / '); };
    window.__ctl = [];
    const rows = s.controls.map(([key, v1]) => {
      const ctl = all.find((c) => c.property === key && typeof c.object[key] === 'number');
      window.__ctl.push(ctl);
      return { key, path: pathOf(ctl), label: ctl._name, min: ctl._min, max: ctl._max, step: ctl._step, v0: ctl.object[key], v1 };
    });
    window.__pal = all.filter((c) => typeof c.object[c.property] === 'string' && /^#[0-9a-f]{6}$/i.test(c.object[c.property])
      && !/reticle|locked|invalid/i.test(c.property) && !/bod/i.test(pathOf(c)));
    const palette = window.__pal.map((c) => ({ key: c.property, name: c._name, path: pathOf(c), orig: c.object[c.property] }));
    return { rows, palette, title: folder._title };
  }, shot, LABEL[shot.name]);

  await page.evaluate((s) => {
    __cap.state.settings.global.timeScale = s.timeScale;
    __cap.placeDummies(s.dummies);
    __cap.setCamera(s.camera);
    __cap.resetFrame();
    __cap.step(45);
    __cap.resetFrame();
    __cap.cast(s.element, s.target);
    if (s.skip) __cap.step(s.skip);
  }, shot);

  const out = `solo/${shot.name}.mp4`;
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '10', '-pix_fmt', 'yuv444p', '-r', '60', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((r) => ff.on('close', r));
  const frames = [];
  for (let f = 0; f < shot.frames; f++) {
    const st = stateAt(f, shot.pause, shot.pauseLen);
    const vals = meta.rows.map((r, i) => r.v0 + (r.v1 - r.v0) * st.s[i]);
    const hue = shot.hue * st.s[2];
    const cols = meta.palette.map((p) => rotateHue(p.orig, hue));
    frames.push({ paused: st.paused, vals, hue, panel: st.panel, swatches: cols.slice(0, 6) });
    const url = await page.evaluate((st, vals, cols) => {
      window.__ctl.forEach((c, i) => (c.object[c.property] = vals[i]));
      window.__pal.forEach((c, i) => (c.object[c.property] = cols[i]));
      app.paused = st.paused;
      __cap.state.shift = st.shift;
      __cap.step(1);
      return __cap.grab();
    }, st, vals, cols);
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  fs.writeFileSync(`solo/${shot.name}.json`, JSON.stringify({ meta, pause: shot.pause, pauseLen: shot.pauseLen, frames }));
  await page.close();
  console.log(`${shot.name}: ${shot.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s  rows=${meta.rows.map(r => r.path + '/' + r.label).join(' | ')}  palette=${meta.palette.length}`);
}
await browser.close();
