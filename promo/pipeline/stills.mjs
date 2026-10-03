// node stills.mjs readme_shots.json out [only] — README screenshots: exact frames after the cast, 2x supersampled.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const shots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3]; const only = process.argv[4]?.split(',');
const W = +(process.env.PW || 1920), H = +(process.env.PH || 1080), Q = +(process.env.Q || 0.92);
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000,
  args: ['--use-angle=d3d11', '--enable-gpu', '--force_high_performance_gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[err]', e.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.app, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.addScriptTag({ path: 'harness.js' });
  await page.evaluate((w, h, r) => __cap.setup({ width: w, height: h, ratio: r }), W, H, s.ratio ?? 2);
  await page.evaluate((s) => {
    if (s.setup) (new Function('app', 'settings', s.setup))(window.app, __cap.state.settings);
    __cap.placeDummies(s.dummies);
    __cap.setCamera(s.camera);
    __cap.resetFrame(); __cap.step(45); __cap.resetFrame();
    __cap.cast(s.element, s.target);
  }, s);
  let at = 0;
  for (const f of s.grab) {
    if (f - at > 1) await page.evaluate((n) => __cap.step(n), f - at - 1);
    const url = await page.evaluate((q) => { __cap.step(1); return __cap.grab('image/jpeg', q); }, Q);
    at = f;
    fs.writeFileSync(`${out}/${s.name}_${f}.jpg`, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  }
  await page.close();
  console.log(`${s.name}: ${s.grab.length} grabs`);
}
await browser.close();
