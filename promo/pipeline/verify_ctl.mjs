// Measure how much each chosen control changes the frozen frame at its showcase pause point.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const CANDS = process.env.CANDS ? JSON.parse(fs.readFileSync(process.env.CANDS, 'utf8')) : null;
const shots = JSON.parse(fs.readFileSync('solo.json', 'utf8')).filter((s) => !CANDS || CANDS[s.name]).map((s) => (CANDS ? { ...s, controls: CANDS[s.name] } : s));
const LABEL = { shark: 'Abyssal', chains: 'Chains', dragon: 'Dragonfire', gyro: 'Stormheart', amethyst: 'Amethyst', tome: 'Astral Tome', reliquary: 'Wildroot', lance: 'Starbreaker', wolf: 'Astral Fang' };
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000,
  args: ['--use-angle=d3d11', '--force_high_performance_gpu', '--ignore-gpu-blocklist'] });
for (const s of shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 241 });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.app, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.addScriptTag({ path: 'harness.js' });
  await page.evaluate(() => __cap.setup({ width: 480, height: 241, ratio: 1 }));
  const r = await page.evaluate((s, label) => {
    const folder = app.editor.gui.folders.find((f) => f._title.includes(label));
    const all = folder.controllersRecursive();
    __cap.state.settings.global.timeScale = s.timeScale;
    __cap.state.settings.post.grain = 0;
    __cap.placeDummies(s.dummies); __cap.setCamera(s.camera); __cap.resetFrame(); __cap.step(30); __cap.resetFrame();
    __cap.cast(s.element, s.target); __cap.step(s.skip + s.pause);
    app.paused = true;
    { const cam = __cap.state.cam, f0 = __cap.state.frame; __cap.state.cam = () => cam(f0); }
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 80; const cx = cv.getContext('2d', { willReadFrequently: true });
    const snap = () => { __cap.step(1); cx.drawImage(app.renderer.gl.domElement, 0, 0, 160, 80); return cx.getImageData(0, 0, 160, 80).data; };
    const base = snap();
    const diff = (a) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - base[i]) + Math.abs(a[i + 1] - base[i + 1]) + Math.abs(a[i + 2] - base[i + 2]); return +(d / (160 * 80 * 3)).toFixed(2); };
    return s.controls.map(([key, v1]) => {
      const c = all.find((c) => c.property === key && typeof c.object[key] === 'number');
      if (!c) return key + ': NOT FOUND';
      const v0 = c.object[key]; c.object[key] = v1; const d = diff(snap()); c.object[key] = v0; snap();
      return `${c._name} ${v0}->${v1}: ${d}`;
    }).join(' | ');
  }, s, LABEL[s.name]);
  console.log(s.name.padEnd(10), r);
  await page.close();
}
await browser.close();
