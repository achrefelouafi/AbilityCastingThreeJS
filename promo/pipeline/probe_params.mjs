// For each ability: freeze mid-cast, nudge every control in its editor folder, measure how much the frame changes.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const shots = JSON.parse(fs.readFileSync('final.json', 'utf8'));
const PAUSE = { shark: 85, chains: 100, dragon: 290, gyro: 192, amethyst: 120, tome: 228, reliquary: 216, lance: 144, wolf: 80 };
const only = process.argv[2] ? process.argv[2].split(',') : null;
const W = 480, H = 242;
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000,
  args: ['--use-angle=d3d11', '--enable-gpu', '--force_high_performance_gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`] });
const results = {};
for (const shot of shots) {
  if (only && !only.includes(shot.name)) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('console', (m) => m.text().startsWith('noise') && console.log(m.text()));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.app, { timeout: 240000 });
  await new Promise(r => setTimeout(r, 2000));
  await page.addScriptTag({ path: 'harness.js' });
  await page.evaluate(() => __cap.setup({ width: 480, height: 242, ratio: 1 }));
  const res = await page.evaluate((s, pauseAt) => {
    const app = window.app;
    __cap.placeDummies(s.dummies);
    __cap.setCamera(s.camera);
    __cap.resetFrame();
    __cap.step(30);
    __cap.resetFrame();
    if (s.setup) (new Function('app', 'settings', s.setup))(app, __cap.state.settings);
    __cap.cast(s.element, s.target);
    __cap.step(pauseAt);
    app.paused = true;
    __cap.state.settings.post.grain = 0;
    { const cam = __cap.state.cam, f0 = __cap.state.frame; __cap.state.cam = () => cam(f0); }
    __cap.step(2);
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 80;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const snap = () => { __cap.step(1); cx.drawImage(app.renderer.gl.domElement, 0, 0, 160, 80); return cx.getImageData(0, 0, 160, 80).data; };
    let base = snap();
    const noise = [];
    for (let i = 0; i < 3; i++) { const a = snap(); let d = 0; for (let j = 0; j < a.length; j += 4) d += Math.abs(a[j] - base[j]) + Math.abs(a[j+1] - base[j+1]) + Math.abs(a[j+2] - base[j+2]); noise.push(+(d / (160*80*3)).toFixed(3)); }
    console.log('noise', noise.join(','));
    base = snap();
    const diff = (a) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - base[i]) + Math.abs(a[i + 1] - base[i + 1]) + Math.abs(a[i + 2] - base[i + 2]); return d / (160 * 80 * 3); };
    const label = { shark: 'Abyssal', chains: 'Chains', dragon: 'Dragonfire', gyro: 'Stormheart', amethyst: 'Amethyst', tome: 'Astral Tome', reliquary: 'Wildroot', lance: 'Starbreaker', wolf: 'Astral Fang' }[s.element];
    const folder = app.editor.gui.folders.find((f) => f._title.includes(label));
    if (!folder) return { error: 'no folder ' + label, titles: app.editor.gui.folders.map(f => f._title) };
    const out = [];
    const rot = (hex) => {
      const n = parseInt(hex.slice(1), 16); let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      // rotate hue 150deg via RGB matrix
      const a = 150 * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), k = 1 / 3, q = Math.sqrt(k);
      const m = (x, y, z) => Math.min(1, Math.max(0, x));
      const R = r * (c + (1 - c) * k) + g * (k * (1 - c) - q * sn) + b * (k * (1 - c) + q * sn);
      const G = r * (k * (1 - c) + q * sn) + g * (c + k * (1 - c)) + b * (k * (1 - c) - q * sn);
      const B = r * (k * (1 - c) - q * sn) + g * (k * (1 - c) + q * sn) + b * (c + k * (1 - c));
      const h = (v) => Math.round(m(v) * 255).toString(16).padStart(2, '0');
      return '#' + h(R) + h(G) + h(B);
    };
    for (const ctl of folder.controllersRecursive()) {
      const obj = ctl.object, key = ctl.property, v0 = obj[key];
      let v1 = null, kind = '';
      if (typeof v0 === 'number' && ctl._max !== undefined) {
        kind = 'num';
        const span = ctl._max - ctl._min;
        v1 = (v0 - ctl._min) / span > 0.5 ? ctl._min + span * 0.1 : Math.min(ctl._max, v0 + span * 0.5);
      } else if (typeof v0 === 'string' && /^#[0-9a-f]{6}$/i.test(v0)) { kind = 'color'; v1 = rot(v0); }
      else continue;
      obj[key] = v1;
      const d = diff(snap());
      obj[key] = v0;
      snap();
      const path = []; let p = ctl.parent; while (p && p !== folder) { path.unshift(p._title); p = p.parent; }
      out.push({ path: path.join(' / '), name: ctl._name, key, kind, v0, v1, min: ctl._min, max: ctl._max, step: ctl._step, d: +d.toFixed(3) });
    }
    out.sort((a, b) => b.d - a.d);
    return out;
  }, shot, PAUSE[shot.name]);
  results[shot.name] = res;
  console.log(shot.name, Array.isArray(res) ? res.slice(0, 14).map(r => `${r.d} ${r.kind} [${r.path}] ${r.name} (${r.key}) ${r.v0}->${r.v1}`).join('\n  ') : JSON.stringify(res));
  await page.close();
}
fs.writeFileSync('params.json', JSON.stringify(results, null, 1));
await browser.close();
