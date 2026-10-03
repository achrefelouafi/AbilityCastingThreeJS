// node overlay.mjs <cfg.json> <outdir> [singleTime]
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outDir = process.argv[3];
const single = process.argv[4];
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--force-color-profile=srgb'] });
const page = await browser.newPage();
await page.setViewport({ width: +(process.env.OW || 1080), height: +(process.env.OH || 1920), deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.resolve(process.env.OHTML || 'overlay.html')).href, { waitUntil: 'load', timeout: 90000 });
await page.evaluate(async (c) => { await document.fonts.ready; init(c); }, cfg);
const frames = Math.round(cfg.duration * 60);
const times = single ? single.split(',').map(Number) : [...Array(frames).keys()].map((f) => f / 60);
let i = 0;
for (const t of times) {
  await page.evaluate((t) => render(t), t);
  await page.screenshot({ path: path.join(outDir, single ? `t_${t}.png` : `o_${String(i).padStart(4, '0')}.png`), omitBackground: true });
  i++;
}
console.log(await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + f.weight).join(',')));
await browser.close();
