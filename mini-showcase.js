/**
 * 小程序体验页（/mini/:id）的渲染模块
 *
 * 为什么单独做这一页（而不是直接把广告/推广位指向详情页 /w/:id）：
 * 1. 页面上放的是「造梦橱窗」小程序码 —— 扫码直达小程序里这件作品的详情页（scene=w:<作品id>，
 *    走 /api/mini/poster 生成，服务端有缓存）；详情页里有作者自己的小程序码，长按即可打开作品本体。
 *    也就是两级入口：本页码 → 造梦小程序详情页 → 作者的小程序。
 * 2. 详情页（/w/:id）是「首页 + 弹窗」的 SPA 结构，站外点进来先看到站点导航与作品列表，
 *    真正要做的动作（扫码）藏在弹窗里，还常常要往下滚才能看到 —— 站外流量在这种页面上的流失是必然的。
 * 3. 这一页只讲三件事：这是什么 / 用起来长什么样 / 怎么扫码进去，首屏就把码放大摆出来。
 * 4. 自带样式、不依赖全站 style.css 与 app.js（广告落地页要快、要稳，不能因为 SPA 初始化
 *    慢或某个接口挂了就白屏）。类名统一 mw- 前缀，避免和站内样式互相污染。
 *
 * SEO 口径：不收录（noindex），canonical 指回 /w/:id —— 这一页是同一件作品的另一个视图，
 * 让它和详情页一起进索引只会互相稀释，真要被搜到的是详情页。
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

const STYLE = `
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f7f7fb; color: #1f2330; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  img { display: block; }
  a { color: inherit; }
  .mw { max-width: 1000px; margin: 0 auto; padding: 0 18px 0; }

  /* 顶栏：只留品牌 + 一句「这是什么页面」，不做站内导航（站外流量不需要） */
  .mw-bar { display: flex; align-items: center; gap: 10px; padding: 18px 0 14px; }
  .mw-brand { font-weight: 700; font-size: 16px; color: #5b5bd6; text-decoration: none; letter-spacing: .01em; }
  .mw-bar-tag { font-size: 12px; color: #7a8095; background: #fff; border: 1px solid #e6e8f0; border-radius: 999px; padding: 3px 10px; }
  .mw-bar-sp { flex: 1; }
  .mw-bar-link { font-size: 13px; color: #7a8095; text-decoration: none; }
  .mw-bar-link:hover { color: #5b5bd6; }

  /* 扫码卡：整页唯一的动作，码放在最显眼的位置 */
  .mw-scan { margin-top: 24px; display: grid; grid-template-columns: 268px minmax(0, 1fr); gap: 30px;
    align-items: center; background: #fff; border: 1px solid #e6e8f0; border-radius: 24px; padding: 26px 30px; }
  .mw-qr { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .mw-qr-box { width: 100%; max-width: 236px; aspect-ratio: 1 / 1; padding: 11px; background: #fff;
    border: 1px solid #e6e8f0; border-radius: 18px; box-shadow: 0 12px 26px -20px rgba(35,32,90,.6); }
  .mw-qr-box img { width: 100%; height: 100%; object-fit: contain; }
  .mw-qr-cap { font-size: 12.5px; color: #7a8095; text-align: center; }
  .mw-qr-empty { width: 100%; max-width: 236px; aspect-ratio: 1 / 1; display: grid; place-items: center;
    text-align: center; padding: 18px; font-size: 13px; line-height: 1.8; color: #8a8fa3;
    background: #f7f7fb; border: 1px dashed #d8dae6; border-radius: 18px; }
  .mw-scan h2 { font-size: 21px; line-height: 1.4; margin-bottom: 8px; }
  .mw-scan .mw-lead { font-size: 13.5px; color: #6b7185; margin-bottom: 15px; }
  .mw-steps { list-style: none; display: grid; gap: 10px; }
  .mw-steps li { display: flex; align-items: flex-start; gap: 10px; font-size: 13.5px; color: #3b3f55; }
  .mw-steps b { flex: none; width: 21px; height: 21px; border-radius: 50%; background: #eeeefc; color: #4747c2;
    font-size: 12px; font-weight: 700; display: grid; place-items: center; margin-top: 1px; }
  .mw-tip { margin-top: 15px; font-size: 12.5px; color: #4a4ac4; background: #f4f4ff;
    border: 1px dashed #d8d8f8; border-radius: 12px; padding: 9px 12px; line-height: 1.75; }
  .mw-tip.lock { color: #8a5a00; background: #fff8ec; border-color: #f3ddb0; }

  /* 窄屏：扫码卡改纵向单列，码放最上面 */
  @media (max-width: 760px) {
    .mw-scan { grid-template-columns: 1fr; gap: 20px; padding: 22px 20px; }
    .mw-qr-box { max-width: 200px; }
    .mw-qr-empty { max-width: 200px; }
    .mw-scan h2 { font-size: 19px; }
  }
  .mw-foot { padding: 26px 0 40px; text-align: center; font-size: 12px; color: #9aa0b4; line-height: 1.9; }
  .mw-foot a { color: #8a8fa3; text-decoration: none; }
  .mw-foot a:hover { color: #5b5bd6; }
</style>`;

/**
 * 生成整页 HTML（自包含：样式内联，只有一个统计用的小脚本）
 * @param {object} p
 * @param {string} p.seoHead  由 seo.head() 生成的 <head> 内容
 * @param {object} p.w        作品对象（publicWork 的产物）
 * @param {boolean} p.inWeChat  访客是不是在微信里打开（微信里文案要变成「长按识别」）
 */
function render({ seoHead, w, inWeChat }) {
  const title = w.title || '未命名作品';
  const locked = !!w.lampLocked;
  // 作品形态分两路：小程序作品讲「扫码进小程序打开作品」；iOS / 安卓（App）作品
  // 讲「进小程序详情页复制下载链接，到手机浏览器里安装」——码是同一个（造梦橱窗小程序）。
  const wTypes = Array.isArray(w.types) ? w.types : [];
  const isMiniWork = wTypes.includes('小程序');

  // 扫码区文案分三态：正常（展示造梦小程序码）/ 灯火锁着（不给入口）/ ——
  // 码本身是「造梦橱窗」小程序的（SSR 先放静态站标码兜底，页面 JS 再换成 scene 直达本作品详情页的动态码，
  // 见 POST /api/mini/poster；服务端有缓存，同一作品只真正调微信一次）
  const hasAuthorQr = !!(w.qrcode || w.qrSrc);
  const step3Text = isMiniWork
    ? (hasAuthorQr ? '详情页里有作者的小程序码，长按就能打开作品本体' : '详情页里有完整的介绍、截图和作者的其他作品')
    : '详情页里有下载链接，复制到手机浏览器打开就能安装';
  const scanBody = locked
    ? `<h2>这件作品要先解锁</h2>
      <p class="mw-lead">作者给作品设了门槛，入口不对未解锁的访客开放。</p>
      <p class="mw-tip lock">需要用 <b>${Number(w.lampPrice) || 0} 盏灯火</b> 解锁后才能看到入口。登录后到作品页点「用灯火解锁」即可。</p>`
    : `<h2>微信扫一扫，直达「${esc(title)}」</h2>
      <p class="mw-lead" id="mw-lead">这是「造梦橱窗」小程序的码，扫开直达这件作品的详情页。</p>
      <ol class="mw-steps">
        <li><b>1</b><span>打开微信，点右上角「+」→「扫一扫」</span></li>
        <li><b>2</b><span id="mw-step2">直达「${esc(title)}」的作品详情页</span></li>
        <li><b>3</b><span>${step3Text}</span></li>
      </ol>
      <p class="mw-tip">${inWeChat
        ? '你正在微信里：直接<b>长按二维码</b> → 「识别小程序码」就能进，不用再扫码。'
        : '在电脑前？掏出手机扫屏上的码就行；手机看的话，把这一屏截图，到微信「扫一扫 → 相册」选这张图。'}</p>`;

  const qrBlock = !locked
    ? `<div class="mw-qr">
        <div class="mw-qr-box"><img id="mw-qr-img" src="/promo-icons/mini-qr.png" alt="造梦橱窗小程序码" /></div>
        <p class="mw-qr-cap" id="mw-qr-cap">造梦橱窗小程序</p>
      </div>`
    : `<div class="mw-qr">
        <div class="mw-qr-empty">解锁后显示小程序入口</div>
        <p class="mw-qr-cap">登录后用灯火解锁</p>
      </div>`;

  // 统计：只发一次，走站内已有的 /api/track（不带 action → 记一次站点 PV + 作品浏览），
  // 保证推广/广告带来的流量在后台和作者看板里看得见；失败静默，不影响页面。
  const track = `<script>
(function () {
  try {
    var payload = JSON.stringify({
      path: location.pathname,
      workId: ${JSON.stringify(String(w.id || ''))},
      entry: true,
      ref: document.referrer || ''
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
    }
  } catch (e) {}
})();
</script>`;

  // 码升级：SSR 先放静态站标码（兜底，扫码进小程序首页），页面加载后再换成
  // scene 直达本作品详情页的动态码（/api/mini/poster，服务端按 scene 内存缓存，
  // 同一作品只真正调微信出码一次）。失败就保持静态码，文案同步改成「进首页后搜作品名」，
  // 两条路都能到详情页，不会出现「码挂了页面就没用」的情况。
  const posterSwap = `<script>
(function () {
  var img = document.getElementById('mw-qr-img');
  var cap = document.getElementById('mw-qr-cap');
  var lead = document.getElementById('mw-lead');
  var step2 = document.getElementById('mw-step2');
  if (!img || !window.fetch) return;
  fetch('/api/mini/poster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId: ${JSON.stringify(String(w.id || ''))} })
  }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('qr')); }).then(function (d) {
    if (!d || !d.qr || d.mock) return;   // mock 占位图不能盖掉真码（本地未配微信时的兜底）
    img.src = d.qr;
    if (cap) cap.textContent = '扫码直达作品详情页';
  }).catch(function () {
    if (lead) lead.textContent = '扫码打开「造梦橱窗」小程序，进去搜「${esc(title)}」就能到详情页。';
    if (step2) step2.textContent = '打开「造梦橱窗」小程序';
    if (cap) cap.textContent = '造梦橱窗小程序';
  });
})();
</script>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${seoHead}
  ${STYLE}
</head>
<body>
<div class="mw">
  <header class="mw-bar">
    <a class="mw-brand" href="/">造梦橱窗</a>
    <span class="mw-bar-tag">${isMiniWork ? '小程序体验页' : '手机端体验页'}</span>
    <span class="mw-bar-sp"></span>
    <a class="mw-bar-link" href="/mini">更多小程序 →</a>
  </header>

  <main>
    <section class="mw-scan" id="scan">
      ${qrBlock}
      <div>${scanBody}</div>
    </section>
  </main>

  <footer class="mw-foot">
    <p>本页是「${esc(title)}」的体验入口，小程序内容与版权归作者所有。</p>
    <p><a href="/">造梦橱窗</a> · 独立开发者的小程序与作品收录站</p>
  </footer>
</div>
${track}
${posterSwap}
</body>
</html>`;
}

module.exports = { render };
