// 用站点品牌 logo.svg 重新生成 PWA 图标（icon-192/512/maskable-512/apple-touch-180）
// 做法：Chrome headless 渲染 SVG → 截图成 PNG，白色底 + 紫色品牌图形
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = __dirname;
const logo = fs.readFileSync(path.join(ROOT, 'frontend/logo.svg'), 'utf8');
const OUT = path.join(ROOT, 'frontend/icons');

// 三种规格：普通图标留 14% 边距；maskable 按规范图形须落在中心 80% 安全区内（缩到 62%）
const JOBS = [
  { file: 'icon-512.png', size: 512, scale: 0.86 },
  { file: 'icon-192.png', size: 192, scale: 0.86 },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 0.86 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.62 }
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb']
  });
  const page = await browser.newPage();
  for (const job of JOBS) {
    const px = Math.round(job.size * job.scale);
    const html = `<!DOCTYPE html><html><body style="margin:0">
<div id="box" style="width:${job.size}px;height:${job.size}px;background:#ffffff;display:flex;align-items:center;justify-content:center;overflow:hidden">
  <div style="width:${px}px;height:${px}px">${logo.replace('<svg ', `<svg width="${px}" height="${px}" `)}</div>
</div>
</body></html>`;
    await page.setContent(html);
    await page.setViewport({ width: job.size, height: job.size, deviceScaleFactor: 1 });
    const el = await page.$('#box');
    await el.screenshot({ path: path.join(OUT, job.file), type: 'png' });
    const kb = (fs.statSync(path.join(OUT, job.file)).size / 1024).toFixed(1);
    console.log('OK', job.file, job.size + 'x' + job.size, kb + 'KB');
  }
  await browser.close();
})();
