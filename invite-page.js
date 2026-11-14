/**
 * 邀请收录页（/invite）的页面渲染模块
 *
 * 设计取舍：
 * 1. 走服务端 SSR 的独立静态页，真人与爬虫看到同一份 HTML，能被搜索引擎收录、
 *    也能直接把 URL 转发到群里；页面里的所有内容都是真实可查的站内口径，不编造奖励数字。
 * 2. 样式全部内联并以 .iv- 前缀收口（自包含，含完整响应式断点），不改全站 style.css，
 *    避免和首页/榜单的既有样式互相污染。
 * 3. 海报由 /invite-card.js 在浏览器里用 Canvas 现场绘制，本页面只负责容器与数据注入。
 * 4. 站内规则明确「不设代收录通道」，所以这一页的受邀对象就是作者本人，
 *    分享话术统一写成「把这一页转给做东西的朋友，让 TA 自己来收录」。
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

/** 页面内联样式：类名统一 iv- 前缀，自带 960 / 640 / 400 三档断点 */
const STYLE = `
<style>
  .iv-wrap { max-width: 1080px; }
  .iv-wrap * { box-sizing: border-box; }
  .iv-wrap .iv-hero { position: relative; overflow: hidden; padding: 46px 46px 40px; margin: 18px 0 26px;
    border: 1px solid #e6e8f0; border-radius: 22px;
    background: radial-gradient(720px 340px at 8% -12%, rgba(91,91,214,.16), transparent 70%),
                radial-gradient(620px 420px at 102% 18%, rgba(168,85,247,.13), transparent 72%), #fff; }
  .iv-kicker { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600;
    letter-spacing: .04em; color: #4a4ac4; background: #eeeefc; border-radius: 999px; padding: 6px 13px; }
  .iv-kicker::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #5b5bd6; }
  .iv-hero h1 { margin: 18px 0 14px; font-size: clamp(30px, 5vw, 48px); line-height: 1.22;
    letter-spacing: -.02em; color: #1f2330; }
  .iv-hero h1 em { font-style: normal; color: #5b5bd6; }
  .iv-hero .iv-lead { max-width: 680px; font-size: 15.5px; line-height: 1.9; color: #5b6072; margin: 0; }
  .iv-hero .iv-lead b { color: #2b2e3f; font-weight: 600; }
  .iv-actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0 16px; }
  .iv-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 42px; padding: 10px 20px; border-radius: 11px; font-size: 14px; font-weight: 600;
    cursor: pointer; text-decoration: none; transition: background .15s, border-color .15s, transform .15s; }
  .iv-btn:focus-visible { outline: 3px solid rgba(91,91,214,.42); outline-offset: 2px; }
  .iv-btn-main { background: #5b5bd6; color: #fff; border: 1px solid #5b5bd6; }
  .iv-btn-main:hover { background: #4747c2; }
  .iv-btn-ghost { background: #fff; color: #3b3f55; border: 1px solid #dcdfea; }
  .iv-btn-ghost:hover { border-color: #5b5bd6; color: #4747c2; }
  .iv-btn svg { flex: none; }
  .iv-stat { margin: 0; font-size: 13px; color: #7a8095; }
  .iv-stat b { color: #4747c2; font-weight: 700; font-size: 15px; }

  /* 海报工作区：左文案 / 右实时预览，窄屏纵向堆叠 */
  .iv-section { margin: 0 0 30px; }
  .iv-section > h2 { font-size: 21px; line-height: 1.4; color: #1f2330; margin: 0 0 8px; }
  .iv-section > .iv-sub { font-size: 14px; line-height: 1.85; color: #6b7185; margin: 0 0 18px; }
  .iv-share { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 26px; align-items: start;
    background: #fff; border: 1px solid #e6e8f0; border-radius: 20px; padding: 26px; }
  .iv-share h2 { font-size: 21px; margin: 0 0 10px; color: #1f2330; }
  .iv-share p { font-size: 14px; line-height: 1.85; color: #5b6072; margin: 0 0 14px; }
  .iv-share .iv-note { font-size: 12.5px; color: #8a8fa3; line-height: 1.7; }
  .iv-tpls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 4px 0 16px; }
  .iv-tpls-label { font-size: 12.5px; color: #7a8095; margin-right: 2px; }
  .iv-tpl { border: 1px solid #dcdfea; background: #fff; color: #4a4f63; border-radius: 999px;
    padding: 6px 14px; font-size: 12.5px; cursor: pointer; transition: all .15s; }
  .iv-tpl:hover { border-color: #5b5bd6; }
  .iv-tpl[aria-pressed="true"] { background: #eeeefc; border-color: #5b5bd6; color: #4747c2; font-weight: 600; }
  .iv-tpl:focus-visible { outline: 3px solid rgba(91,91,214,.42); outline-offset: 2px; }
  .iv-share-actions { display: flex; flex-wrap: wrap; gap: 9px; }
  .iv-poster { position: relative; width: 100%; border-radius: 14px; overflow: hidden;
    background: #f2f1fb; border: 1px solid #e6e8f0; box-shadow: 0 12px 30px rgba(38,34,92,.12); }
  .iv-poster canvas { display: block; width: 100%; height: auto; }
  .iv-poster .iv-loading { position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 13px; color: #6b6c88; background: rgba(247,246,253,.82); }
  .iv-poster.is-ready .iv-loading { display: none; }
  /* iOS 长按保存兜底：盖一张真实 <img>，点一下恢复 canvas */
  .iv-poster .iv-save-overlay { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: contain; background: #fff; display: none; cursor: zoom-out; }
  .iv-poster .iv-save-overlay.show { display: block; }
  .iv-poster-cap { margin: 9px 0 0 !important; font-size: 12px !important; text-align: center; color: #8a8fa3 !important; }

  /* 收录范围标签 */
  .iv-types { display: flex; flex-wrap: wrap; gap: 8px; }
  .iv-type { font-size: 13px; color: #4a4ac4; background: #f1f0ff; border: 1px solid #e3e1fb;
    border-radius: 9px; padding: 7px 13px; }

  /* 三栏价值点 / 三步流程 */
  .iv-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .iv-card { background: #fff; border: 1px solid #e6e8f0; border-radius: 15px; padding: 18px 18px 20px; }
  .iv-card .iv-num { display: inline-grid; place-items: center; width: 26px; height: 26px;
    border-radius: 8px; background: #eeeefc; color: #4747c2; font-size: 13px; font-weight: 700; }
  .iv-card h3 { font-size: 15.5px; margin: 11px 0 7px; color: #1f2330; }
  .iv-card p { font-size: 13.5px; line-height: 1.8; color: #5b6072; margin: 0; }
  .iv-card p b { color: #2b2e3f; }

  /* 规则提示：口径和 /rules 保持一致，避免误导 */
  .iv-rule { margin: 0 0 26px; padding: 16px 18px; border-radius: 14px; font-size: 13.5px;
    line-height: 1.85; color: #5b5334; background: #fffaed; border: 1px solid #f0e3b8; }
  .iv-rule b { color: #4a4327; }
  .iv-rule a { color: #4747c2; text-decoration: underline; text-underline-offset: 2px; }
  .iv-end { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 22px 0 30px; }
  .iv-end .iv-end-tip { font-size: 13px; color: #7a8095; }

  @media (max-width: 960px) {
    .iv-share { grid-template-columns: minmax(0, 1fr) 280px; gap: 20px; padding: 20px; }
    .iv-hero { padding: 34px 30px 32px; }
  }
  @media (max-width: 640px) {
    .iv-hero { padding: 28px 20px 26px; border-radius: 18px; margin: 12px 0 20px; }
    .iv-hero h1 { font-size: 30px; }
    .iv-hero .iv-lead { font-size: 14px; }
    .iv-actions .iv-btn { flex: 1 1 auto; }
    .iv-share { grid-template-columns: minmax(0, 1fr); padding: 18px; }
    .iv-poster { max-width: 340px; margin: 0 auto; }
    .iv-grid { grid-template-columns: minmax(0, 1fr); }
    .iv-section > h2, .iv-share h2 { font-size: 19px; }
  }
  @media (max-width: 400px) {
    .iv-share-actions .iv-btn { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .iv-btn, .iv-tpl { transition: none; }
  }
</style>`;

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 21h16"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4"/><path d="M15.4 6.5l-6.8 4"/></svg>';

/**
 * @param {object} o
 * @param {object} o.seo        seo 模块（用它的 esc / breadcrumbHtml / breadcrumbLd / SITE_NAME）
 * @param {string} o.base       站点根地址（由 seo.baseUrl(req) 生成，不写死域名）
 * @param {string} o.shareBase  海报固定印的正式站点根地址（本地预览也印线上域名，转发出去才打得开）
 * @param {number} o.count      当前已收录的公开作品数
 * @param {number} o.authors    创作者数
 * @param {string[]} o.types    站内配置的作品形态
 */
function render(o) {
  const seo = o.seo;
  const base = o.base;
  const shareBase = String(o.shareBase || '').replace(/\/+$/, '');
  const count = Number(o.count) || 0;
  const authors = Number(o.authors) || 0;
  const types = (o.types || []).slice(0, 12);

  const head = {
    title: `邀请你来收录作品 - 把做过的东西放进造梦橱窗 - ${seo.SITE_NAME}`,
    description: '造梦橱窗免费收录独立开发者与创作者自制的网站、小程序、App、智能体、软件、游戏。提交作品过审后就有独立主页，可被搜索、分享与扫码直达；这一页可以生成邀请海报，转给做东西的朋友。',
    keywords: '作品收录,免费投稿,作品集,独立开发者,创作者,邀请海报,造梦橱窗',
    canonical: base + '/invite',
    type: 'website',
    image: base + '/invite-og.jpg',
    imageAlt: '造梦橱窗邀请你把作品收录进来',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '邀请收录' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: '邀请你来收录作品',
        description: '免费把作品收录进造梦橱窗，并可生成邀请海报分享给其他创作者。',
        url: base + '/invite'
      }
    ]
  };

  const typeChips = types.map(t => `<span class="iv-type">${esc(t)}</span>`).join('');

  const block = `<div id="seoContent" class="seo-wrap iv-wrap" data-count="${count}" data-authors="${authors}" data-share-base="${esc(shareBase)}">
  ${STYLE}
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '邀请收录' }])}

  <!-- 首屏：一句定位 + 两个主行动 -->
  <header class="iv-hero">
    <span class="iv-kicker">造梦橱窗 · 公开邀请</span>
    <h1>你做的东西，<br />值得<em>被更多人看见</em></h1>
    <p class="iv-lead">这里<b>免费收录</b>独立开发者和创作者亲手做的网站、小程序、App、智能体、软件、游戏。不用报名、不用付费，提交过审后就有自己的独立主页——能被搜到、被分享、被扫码打开。<br />
    如果你身边有正在做东西的朋友，把这一页转给 TA，让 TA 自己来收录。</p>
    <div class="iv-actions">
      <a class="iv-btn iv-btn-main" href="/" data-iv-submit>提交我的作品 ${ICON_SHARE}</a>
      <button type="button" class="iv-btn iv-btn-ghost" id="ivJumpPoster">生成邀请海报 ${ICON_DOWNLOAD}</button>
    </div>
    <!-- 不写「N 位创作者」的数字：这个数只统计已投稿作者，对外容易被误读成站点注册账号总数 -->
    <p class="iv-stat">目前已收录 <b>${count}</b> 件作品，独立开发者与创作者仍在陆续加入</p>
  </header>

  <!-- 海报工作区：页面内实时预览，不弹窗，扫一眼就知道转发出去是什么样 -->
  <section class="iv-section" id="ivPosterSection" aria-labelledby="ivPosterTitle">
    <div class="iv-share">
      <div>
        <h2 id="ivPosterTitle">顺手把这张海报转给同好</h2>
        <p>海报上的二维码指向站内首页，朋友扫一下就能进站逛作品、直接点投稿。已登录时二维码会自动带上你的邀请身份，好友从这张海报进来注册，灯火会记到你名下。</p>
        <div class="iv-tpls" role="group" aria-label="选择海报配色">
          <span class="iv-tpls-label">配色</span>
          <button type="button" class="iv-tpl" data-tpl="grad" aria-pressed="true">渐变</button>
          <button type="button" class="iv-tpl" data-tpl="light" aria-pressed="false">浅色</button>
          <button type="button" class="iv-tpl" data-tpl="dark" aria-pressed="false">深色</button>
        </div>
        <div class="iv-share-actions">
          <button type="button" class="iv-btn iv-btn-main" id="ivSave">${ICON_DOWNLOAD} 保存海报</button>
          <button type="button" class="iv-btn iv-btn-ghost" id="ivCopyText">${ICON_COPY} 复制邀请文案</button>
          <button type="button" class="iv-btn iv-btn-ghost" id="ivCopyLink">${ICON_COPY} 复制链接</button>
        </div>
        <p class="iv-note" id="ivLampTip" style="margin-top:14px">正在读取登录状态…</p>
      </div>
      <div>
        <div class="iv-poster" id="ivPosterBox">
          <canvas id="ivCanvas" width="1080" height="1350" role="img"
            aria-label="造梦橱窗邀请海报：扫码来收录你的作品"></canvas>
          <div class="iv-loading">海报生成中…</div>
        </div>
        <p class="iv-poster-cap">1080 × 1350 · 保存后可直接发朋友圈 / 群里</p>
      </div>
    </div>
  </section>

  <!-- 收录范围：直接读后台配置的形态，后台改了这里跟着变 -->
  <section class="iv-section" aria-labelledby="ivScopeTitle">
    <h2 id="ivScopeTitle">什么能被收录</h2>
    <p class="iv-sub">不用是「大项目」，一个先解决了自己问题的小工具，认真做完也算。只要是你本人创作（或已获授权），并且能给别人一个用得上的入口。<br />下面是站内归类用的作品形态，提交时选合适的就好。</p>
    <div class="iv-types">${typeChips || '<span class="iv-type">网站</span><span class="iv-type">小程序</span><span class="iv-type">智能体</span>'}</div>
  </section>

  <!-- 收录后得到什么 -->
  <section class="iv-section" aria-labelledby="ivGainTitle">
    <h2 id="ivGainTitle">收录之后，你会得到什么</h2>
    <div class="iv-grid">
      <article class="iv-card"><span class="iv-num">01</span>
        <h3>一个独立主页</h3>
        <p>作品有自己固定的网址，简介、截图、体验入口、二维码都放在一起。发给别人时不用再从头解释一遍。</p></article>
      <article class="iv-card"><span class="iv-num">02</span>
        <h3>被搜到、被逛到</h3>
        <p>进首页、分类与形态列表、榜单，也能被搜索引擎收录。别人按关键词或分类逛，就有机会撞见它。</p></article>
      <article class="iv-card"><span class="iv-num">03</span>
        <h3>能分享、能看数据</h3>
        <p>每件作品都能生成分享卡片与二维码，作者看板里能看到访问、点赞、收藏等反馈，知道谁真的来过。</p></article>
    </div>
  </section>

  <!-- 三步参与 -->
  <section class="iv-section" aria-labelledby="ivStepsTitle">
    <h2 id="ivStepsTitle">怎么参与</h2>
    <div class="iv-grid">
      <article class="iv-card"><span class="iv-num">1</span>
        <h3>备好材料</h3>
        <p>一句话简介、1–2 张能说明用途的公开截图，加上作品的体验入口（链接或小程序码）。</p></article>
      <article class="iv-card"><span class="iv-num">2</span>
        <h3>提交作品</h3>
        <p>回首页点「提交我的作品」，填简介、选形态和分类，确认是本人创作或已获授权后提交。</p></article>
      <article class="iv-card"><span class="iv-num">3</span>
        <h3>等着被看见</h3>
        <p>审核通过后作品上架，之后可以在「我的」里随时编辑、查看它的表现。</p></article>
    </div>
  </section>

  <!-- 口径对齐 /rules：不设代收录通道，别让转达的人白忙 -->
  <p class="iv-rule"><b>先说清楚两件事</b>：橱窗不设代收录通道，<b>想推荐别人的作品，把这一页发给作者本人</b>就好；站内已有的条目，原作者可以用「认领」归到自己名下。投稿免费，具体要求请看<a href="/howto">投稿指南</a>与<a href="/rules">作品规范</a>。</p>

  <div class="iv-end">
    <a class="iv-btn iv-btn-main" href="/" data-iv-submit>去提交我的作品</a>
    <a class="iv-btn iv-btn-ghost" href="/howto">先看投稿指南</a>
    <span class="iv-end-tip">也可以把上面的海报直接存下来发出去。</span>
  </div>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a>&nbsp;&nbsp;<a class="btn-ghost" href="/bar">去造梦酒馆投递灵感 →</a></p>

  <!-- 海报绘制脚本：放在内容之后，此时容器已解析完；app.js 在 </body> 前才加载，
       所以脚本自己取登录态，不依赖 app.js 的 state -->
  <script src="/invite-card.js"></script>
</div>`;

  return { head, block };
}

module.exports = { render };
