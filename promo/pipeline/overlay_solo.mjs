// node overlay_solo.mjs <ability> <outdir> [frame,frame...]
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { rotateHue } from './timeline.mjs';
const INFO = {
  shark: ['Abyssal Maw', '#3fd8ff', 'K', 'TARGETED CAST'], chains: ['Chains of Penance', '#ffb547', 'L', 'TARGETED CAST'],
  dragon: ['Dragonfire Circle', '#ff6a2a', 'I', 'AREA CAST'], gyro: ['Stormheart Gyroscope', '#a77bff', 'O', 'AREA CAST'],
  amethyst: ['Amethyst Verdict', '#c07bff', 'U', 'TARGETED CAST'], tome: ['Astral Tome', '#4f9dff', ';', 'AREA CAST'],
  reliquary: ['Wildroot Reliquary', '#3fffd0', "'", 'TARGETED CAST'], lance: ['Starbreaker Lance', '#7fe6ff', 'Y', 'TARGETED CAST'],
  wolf: ['Astral Fang', '#5fe8ff', 'B', 'TARGETED CAST']
};
const [name, outDir, only] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(`solo/${name}.json`, 'utf8'));
const [label, accent, key, tag] = INFO[name];
// Swatches: the six most saturated colours of the palette, rotated by the frame's hue.
const sat = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255]; const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx * (mx / 255) : 0; };
const picks = data.meta.palette.map((p) => p.orig).sort((a, b) => sat(b) - sat(a)).slice(0, 6);
for (const fr of data.frames) fr.swatches = picks.map((h) => rotateHue(h, fr.hue));
const cfg = { ...data, name: label, accent, key, tag };
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--force-color-profile=srgb'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.resolve('overlay_solo.html')).href, { waitUntil: 'load', timeout: 90000 });
await page.evaluate(async (c) => { await document.fonts.ready; init(c); }, cfg);
const list = only ? only.split(',').map(Number) : [...Array(data.frames.length).keys()];
for (const f of list) {
  await page.evaluate((f) => render(f), f);
  await page.screenshot({ path: path.join(outDir, only ? `f_${f}.png` : `o_${String(f).padStart(4, '0')}.png`), omitBackground: true });
}
await browser.close();
