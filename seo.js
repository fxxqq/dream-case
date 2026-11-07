/**
 * SEO 渲染模块
 * - 服务于搜索引擎与社交分享的 HTML 片段生成
 * - 纯函数，不依赖 express，便于单测
 */
'use strict';

// 站内图标库（与前端同一份：SSR 出来的图标和客户端水合后完全一致）
const Icons = require('./frontend/icons.js');
const md = require('./frontend/md.js');   // 简介是 Markdown：展示用 render，摘要/meta/RSS 用 plain
const svgIco = key => `<span class="ico${key === 'megaphone' || key === 'chart' || key === 'palette' ? '' : ' tico'}">${Icons.ICONS[key] || ''}</span>`;

const SITE_NAME = '造梦橱窗';
const SITE_TAGLINE = '让好作品被更多人看见';
const SITE_SLOGAN = SITE_TAGLINE;
// 结构化数据 / RSS 用的事实性描述（标题用标语，描述仍写清收录范围更利于搜索展现）
const SITE_DESC = '收录大家的网站、个人站、小程序、桌面客户端、机器人等作品，支持搜索、分类浏览、作品榜单与免费投稿。';

const TYPE_ICONS = { 'Web': '🌐', 'iOS': '🍎', 'Android': '🤖', 'macOS': '💻', 'Windows': '🪟', 'Linux': '🐧', '小程序': '📱', '浏览器插件': '🧩', '机器人': '🦾', 'API': '🔌' };
// 形态 → 图标 key（HTML 里一律输出 SVG；TYPE_ICONS 只留给纯文本 / canvas 分享卡这类放不进 SVG 的场景）
// 没映射的自定义形态统一回退 other 图标（见 typeTextHtml / typeBadges）
const TYPE_SVG = {
  'Web': 'web', 'iOS': 'ios', 'Android': 'android', 'macOS': 'mac', 'Windows': 'win',
  'Linux': 'linux', '小程序': 'mini', '浏览器插件': 'ext', '机器人': 'robot', 'API': 'api'
};
// 后台可增删形态：启动/变更时用服务端的 [{name, icon}] 覆盖图标映射
function setTypeIcons(map) {
  if (!map || typeof map !== 'object') return;
  Object.assign(TYPE_ICONS, map);
}

// schema.org 应用分类映射
const APP_CATEGORY = {
  '效率工具': 'BusinessApplication',
  '生活助手': 'LifestyleApplication',
  '内容创作': 'MultimediaApplication',
  '学习教育': 'EducationalApplication',
  '娱乐游戏': 'GameApplication',
  '开发工具': 'DeveloperApplication'
};
const OS_BY_TYPE = {
  'Web': 'Web', 'iOS': 'iOS', 'Android': 'Android', 'macOS': 'macOS', 'Windows': 'Windows', 'Linux': 'Linux',
  '小程序': 'WeChat', '浏览器插件': 'Chrome, Edge', '机器人': 'Web', 'API': 'Web'
};

/** 作品形态：兼容旧的单值 type，返回数组 */
function typesOf(w) {
  if (Array.isArray(w.types) && w.types.length) return w.types;
  return [w.type || 'Web'];
}
function typeText(w, sep = ' · ') {
  return typesOf(w).join(sep);
}
// HTML 版：形态名带 SVG 图标（页面内展示用，不用 emoji）
function typeTextHtml(w, sep = ' · ') {
  return typesOf(w).map(t => `${svgIco(TYPE_SVG[t] || 'other')} ${esc(t)}`).join(sep);
}
function typeBadges(w) {
  return typesOf(w)
    .map(t => `<span class="badge-type">${svgIco(TYPE_SVG[t] || 'other')} ${esc(t)}</span>`)
    .join('');
}
const LINK_LABELS = {
  'Web': '🌐 打开网站', 'iOS': '🍎 App Store 下载', 'Android': '🤖 前往下载',
  'macOS': '💻 下载 Mac 版', 'Windows': '🪟 下载 Windows 版', 'Linux': '🐧 下载 Linux 版',
  '小程序': '📱 微信扫码打开', '浏览器插件': '🧩 前往安装', '机器人': '🦾 体验机器人', 'API': '🔌 查看文档'
};
function linkLabelOf(w) {
  const t = typesOf(w);
  // 标签里不带 emoji：图标由调用方用 SVG 补（emoji 在按钮里跟字号/字色都不一致）
  for (const k of ['Web', 'iOS', 'Android', 'macOS', 'Windows', 'Linux', '小程序', '浏览器插件', '机器人', 'API']) if (t.indexOf(k) !== -1) return LINK_LABELS[k].replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '');
  return '访问作品';
}
// 纯小程序作品只能微信扫码打开，没有可点的外链；残留的 link 只是一张介绍页
function isMiniOnly(w) {
  const t = typesOf(w);
  return t.length > 0 && t.every(x => x === '小程序');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function truncate(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return str.slice(0, n - 1).replace(/[，,。.、\s]+$/, '') + '…';
}

function baseUrl(req) {
  const fromEnv = process.env.SITE_URL;
  const raw = fromEnv || (req.protocol + '://' + req.get('host'));
  return raw.replace(/\/+$/, '');
}

function absolute(base, p) {
  if (!p) return base;
  if (/^https?:\/\//i.test(p)) return p;
  return base + (p.startsWith('/') ? '' : '/') + p;
}

/** 生成 <head> 内的全部 SEO 标签 */
function head(opts) {
  const {
    title, description, keywords, canonical, image, imageAlt,
    type = 'website', publishedTime, modifiedTime, noindex = false,
    jsonLd = [], extra = ''
  } = opts;

  // noindex: 'follow' 用于稀疏聚合页：不收录这一页，但页面里的作品链接仍要能被顺着抓到
  const robots = noindex
    ? (noindex === 'follow' ? 'noindex,follow' : 'noindex,nofollow')
    : 'index,follow,max-image-preview:large,max-snippet:-1';

  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    keywords ? `<meta name="keywords" content="${esc(keywords)}" />` : '',
    `<meta name="robots" content="${robots}" />`,
    `<meta name="theme-color" content="#5b5bd6" />`,
    canonical ? `<link rel="canonical" href="${esc(canonical)}" />` : '',
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />`,
    `<link rel="manifest" href="/manifest.webmanifest" />`,
    `<meta name="mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default" />`,
    `<meta name="apple-mobile-web-app-title" content="${esc(SITE_NAME)}" />`,
    `<link rel="alternate" type="application/rss+xml" title="${esc(SITE_NAME)} 最新作品" href="/feed.xml" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:locale" content="zh_CN" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    canonical ? `<meta property="og:url" content="${esc(canonical)}" />` : '',
    image ? `<meta property="og:image" content="${esc(image)}" />` : '',
    image ? `<meta property="og:image:alt" content="${esc(imageAlt || title)}" />` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    image ? `<meta name="twitter:image" content="${esc(image)}" />` : '',
    publishedTime ? `<meta property="article:published_time" content="${esc(publishedTime)}" />` : '',
    modifiedTime ? `<meta property="article:modified_time" content="${esc(modifiedTime)}" />` : ''
  ].filter(Boolean);

  const ld = jsonLd.filter(Boolean).map(obj =>
    `<script type="application/ld+json">${JSON.stringify(obj)}</script>`
  );

  return tags.concat(ld).join('\n  ') + (extra ? '\n  ' + extra : '');
}

/** 面包屑 HTML */
function breadcrumbHtml(base, trail) {
  const parts = trail.map((t, i) => {
    const isLast = i === trail.length - 1;
    return isLast || !t.href
      ? `<span>${esc(t.name)}</span>`
      : `<a href="${esc(t.href)}">${esc(t.name)}</a>`;
  });
  return `<nav class="breadcrumb" aria-label="面包屑">${parts.join('<i>›</i>')}</nav>`;
}

function breadcrumbLd(base, trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: t.href ? absolute(base, t.href) : undefined
    }))
  };
}

/** 作品卡片（静态、可被爬虫抓取的链接版） */
/** 开源徽章：闭源是默认状态，不标注（与前台 app.js 口径一致）；未标注返回空串 */
function osBadgeHtml(w) {
  if (w.openSource === true) return `<span class="os-badge open" title="开放源代码">${svgIco('lock-open')} 开源</span>`;
  return '';
}

// 付费标识：默认免费不输出，只有标注收费才显示
function paidBadgeHtml(w) {
  return w.paid ? `<span class="os-badge paid" title="需要付费或含付费版本">${svgIco('coin')} 付费</span>` : '';
}

// 展示名：有昵称用昵称，没有就用账号名（链接/作者页仍按账号）
function nameOf(w) { return w.anonymous ? '匿名' : (w.authorName || w.author); }

function cardHtml(w, suffix = '') {
  return `<a class="card seo-card" href="/w/${esc(w.id)}${suffix}">
  <div class="card-img-wrap">
    <img class="card-img" src="${esc(w.thumb || w.image)}" alt="${esc(w.title)} - ${esc((w.category || '') + typesOf(w).join('/'))}作品封面" loading="lazy" decoding="async" />
    <span class="type-badge" title="${esc(typesOf(w).join(' / '))}">${typeTextHtml(w)}</span>
  </div>
  <div class="card-body">
    <div class="card-title">${esc(w.title)}</div>
    <div class="card-meta"><span>@${esc(nameOf(w))}</span><span class="card-tags"><span class="card-cat">${esc(w.category || '')}</span>${osBadgeHtml(w)}${paidBadgeHtml(w)}</span></div>
  </div>
</a>`;
}

/** 作品详情页的服务端渲染正文
 *  opts.full = true 时输出「完整页面」形态：完整展示宣传图，并给出在橱窗内互动/返回的入口。
 *  两种形态共用同一个 canonical（/w/:id），避免被搜索引擎当成重复页面。 */
function workArticle(base, w, trail, related = [], opts = {}) {
  const miniOnly = isMiniOnly(w);
  // 小程序没有可点的外链，按钮不能写成「打开小程序」—— 那是网页，会骗人
  const linkLabel = miniOnly ? '了解详情' : linkLabelOf(w);
  // 按钮图标：按作品形态给（iOS 给苹果标、Web 给浏览器窗口），纯小程序给链接图标
  const linkIco = miniOnly ? 'link' : (TYPE_SVG[typesOf(w)[0]] || 'link');
  const full = !!opts.full;
  const suffix = full ? '?full=1' : '';

  const date = String(w.createdAt || '').slice(0, 10);
  const relatedHtml = related.length ? `<section class="seo-related">
    <h2>同类作品推荐</h2>
    <div class="gallery">${related.map(x => cardHtml(x, suffix)).join('')}</div>
  </section>` : '';

  // 完整页展示全部宣传图，橱窗弹窗里已经能看到，这里补齐给分享/收录
  const gallery = (w.images || []).length ? `<div class="seo-gallery">
    ${w.images.map((src, i) => `<img src="${esc(src)}" alt="${esc(w.title)} 宣传图 ${i + 1}" loading="lazy" />`).join('')}
  </div>` : '';

  // 小程序码：纯小程序作品唯一的真实入口，服务端页也要给出来（点链接是进不了小程序的）
  // qrSrc 是服务端算好的展示码：作者原码优先，没有就是自动短链码（扫码可数）
  const qrImg = w.qrSrc || w.qrcode;
  const qrHtml = qrImg ? `<div class="seo-qr">
    <img src="${esc(qrImg)}" alt="${esc(w.title)} 小程序码" />
    <p>${miniOnly ? '用微信扫一扫打开小程序' : (w.qrReal ? '手机扫码打开' : '扫码打开作品')}</p>
  </div>` : '';
  const miniNoEntry = (miniOnly && !w.qrcode && !w.link)
    ? `<p class="seo-mini-empty">${svgIco('mobile')} 作者还没上传小程序码，暂时打不开。</p>` : '';

  // 服务端页同样要记动作埋点：搜索引擎落地页是重要入口，不能只有橱窗弹窗有数
  const firstType = typesOf(w)[0] || 'Web';
  const DL = { 'iOS': 1, 'Android': 1, 'macOS': 1, 'Windows': 1, 'Linux': 1, '浏览器插件': 1 };
  const actAttr = `data-act="${DL[firstType] ? 'download' : 'visit'}" data-atype="${esc(firstType)}"`;

  return `<div id="seoContent" class="seo-wrap${full ? ' seo-full' : ''}" data-full="${full ? '1' : '0'}">
  ${breadcrumbHtml(base, trail)}
  <article class="seo-article">
    <h1>${esc(w.title)}</h1>
    <div class="seo-meta">
      ${typeBadges(w)}
      <span class="badge-cat">${esc(w.category || '')}</span>
      ${osBadgeHtml(w)}
      ${paidBadgeHtml(w)}
      ${(w.featured && (!w.featuredUntil || new Date(w.featuredUntil).getTime() > Date.now())) ? `<span class="badge-featured">${svgIco('sparkle')} 精选</span>` : ''}
    </div>
    <p class="seo-author">作者：${w.anonymous
      ? '<span rel="author">匿名</span>'
      : `<a href="/u/${encodeURIComponent(w.author)}" rel="author">@${esc(nameOf(w))}</a>`}
      · ${w.likes || 0} 点赞 · ${w.favs || 0} 人收藏 · ${w.commentCount || 0} 评论 · ${w.views || 0} 浏览${date ? ' · ' + esc(date) : ''}</p>
    <img class="seo-cover" src="${esc(w.image)}" alt="${esc(w.title)} 作品截图" />
    ${gallery}
    ${qrHtml}
    ${miniNoEntry}
    <div class="seo-intro md-body">${w.introHtml || (w.intro ? esc(w.intro).replace(/\n/g, '<br>') : '<p>作者暂未填写作品介绍。</p>')}</div>
    <div class="seo-actions">
      ${w.link ? `<a class="${miniOnly ? 'btn-ghost' : 'btn-primary'}" href="${esc(w.link)}" target="_blank" rel="nofollow noopener" ${actAttr}>${svgIco(linkIco)} ${linkLabel}</a>` : ''}
      ${w.repo ? `<a class="btn-ghost" href="${esc(w.repo)}" target="_blank" rel="nofollow noopener">${svgIco('folder')} 源码仓库</a>` : ''}
      ${full ? `<a class="btn-ghost" href="/w/${esc(w.id)}">在橱窗里打开（点赞 / 收藏 / 评论）</a>` : ''}
      ${w.category ? `<a class="btn-ghost" href="/c/${encodeURIComponent(w.category)}">更多${esc(w.category)}作品</a>` : ''}
      <a class="btn-ghost" href="/">返回首页</a>
    </div>
  </article>
  ${relatedHtml}
</div>`;
}

function workLd(base, w, pageUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: w.title,
    description: truncate(md.plain(w.intro || '') || `${w.title}，由 ${nameOf(w)} 提交的${w.category}类${typesOf(w).join('/')}作品。`, 300),
    url: pageUrl,
    image: absolute(base, w.image),
    applicationCategory: APP_CATEGORY[w.category] || 'UtilitiesApplication',
    operatingSystem: OS_BY_TYPE[typesOf(w)[0]] || 'Web',
    inLanguage: 'zh-CN',
    datePublished: w.createdAt,
    author: w.anonymous
      ? { '@type': 'Person', name: '匿名' }
      : { '@type': 'Person', name: nameOf(w), url: absolute(base, '/u/' + encodeURIComponent(w.author)) },
    interactionStatistic: [
      {
        '@type': 'InteractionCounter',
        interactionType: { '@type': 'LikeAction' },
        userInteractionCount: w.likes || 0
      },
      {
        '@type': 'InteractionCounter',
        interactionType: { '@type': 'ViewAction' },
        userInteractionCount: w.views || 0
      }
    ],
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: base + '/' }
  };
}

/** 首页底部的站点索引：真人与爬虫同一份 HTML，JS 关闭也能顺着链接逛。
 *  刻意只输出纯文字、不输出封面卡——首屏主列表已经是一组完整作品流，
 *  这里再来 8 张大卡等于「首页下面又抄了一遍首页」，观感累赘还会拉长页面。
 *  24 个 /w/ 内链、全部分类 / 形态聚合页入口照旧留在 HTML 里，爬虫拿到的信息不打折；
 *  链接不折叠、不 display:none，百度 / Google 都能正常抓取。 */
function homeBlock(base, { works, categories, types }) {
  const row = (label, links, cls = '') =>
    `<div class="seo-index-row ${cls}"><span class="seo-index-label">${label}</span>` +
    `<span class="seo-index-links">${links.join('')}</span></div>`;
  return `<div id="seoContent" class="seo-wrap seo-home seo-index">
  <nav class="seo-index-nav" aria-label="站点索引">
    ${row('按分类浏览', categories.map(c => `<a href="/c/${encodeURIComponent(c)}">${esc(c)}</a>`))}
    ${row('按形态浏览', types.map(t => `<a href="/t/${encodeURIComponent(t)}">${esc(t)}</a>`))}
    ${row('最新收录', works.map(w => `<a href="/w/${esc(w.id)}">${esc(w.title)}</a>`), 'seo-index-works')}
  </nav>
</div>`;
}

/** 聚合页答案块：数字全部取自站内真实统计，给 AI 搜索一段可引用的事实，不写空泛套话 */
function collectionFaq({ kind, name, facts }) {
  const label = kind === 'c' ? `「${name}」分类` : `「${name}」形态`;
  const qa = [
    {
      q: `${label}里收录了哪些作品？`,
      a: `这里共收录 ${facts.count} 件${label}作品，最新一件是《${esc(facts.latestTitle)}》（${facts.latestDate} 收录）。` +
         `其中 ${facts.webCount} 件是 Web 作品，可以直接在浏览器打开；${facts.miniCount} 件是微信小程序，需要扫码使用。`
    },
    {
      q: `${label}的作品免费吗，有开源的吗？`,
      a: `${facts.openSource} 件标注了开源并附源码地址，${facts.paid} 件标注含付费版本，` +
         `其余 ${Math.max(0, facts.count - facts.openSource - facts.paid)} 件未标注收费信息。是否收费以各作品详情页的说明为准。`
    },
    {
      q: `怎样把自己的作品收进${label}？`,
      a: `在首页点「提交作品」，填写名称、封面、简介并选择形态与分类即可；注册用户提交后立即上线，匿名投稿需要人工审核。` +
         `<a href="/howto">投稿指南</a>和<a href="/rules">作品规范</a>写明了材料与审核要求。`
    }
  ];
  return {
    html: `<section class="seo-faq">
  <h2>关于${esc(label)}，你可能想问</h2>
  <dl>${qa.map(x => `<dt>${esc(x.q)}</dt><dd>${x.a}</dd>`).join('')}</dl>
</section>`,
    ld: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: qa.map(x => ({
        '@type': 'Question',
        name: x.q,
        acceptedAnswer: { '@type': 'Answer', text: x.a.replace(/<[^>]+>/g, '') }
      }))
    }
  };
}

/** 独立列表页（/c/:cat、/t/:type），完全服务端渲染 */
function listPage(base, { title, description, h1, activeName, kind = 'c', subtitle, items, trail, page, hasMore, prevHref, nextHref, canonical, categories, types, noindex = false, facts = null }) {
  const chipHref = c => '/' + kind + '/' + encodeURIComponent(c);
  const faq = facts ? collectionFaq({ kind, name: activeName, facts }) : null;
  const headHtml = head({
    title,
    description,
    keywords: [h1, '作品集合', '工具导航', '网站推荐', '小程序收录'].join(','),
    canonical,
    type: 'website',
    noindex,
    jsonLd: [
      breadcrumbLd(base, trail),
      faq && faq.ld,
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        description,
        url: canonical,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: base + '/' },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: items.length,
          itemListElement: items.map((w, i) => ({
            '@type': 'ListItem',
            position: (page - 1) * 24 + i + 1,
            url: absolute(base, '/w/' + w.id),
            name: w.title
          }))
        }
      }
    ]
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${headHtml}
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="/">✦ ${SITE_NAME}</a>
      <nav class="main-nav">
        <a class="nav-btn" href="/">首页</a>
        <a class="nav-btn" href="/rank">星梦榜</a>
        <a class="btn-primary" href="/">＋ 提交作品</a>
      </nav>
    </div>
  </header>
  <main class="container">
    <div class="page-head">
      ${breadcrumbHtml(base, trail)}
      <h1>${esc(h1)}</h1>
      <p>${esc(subtitle)}</p>
    </div>
    <div class="type-bar">
      ${categories.map(c => `<a class="chip${c === activeName ? ' active' : ''}" href="${chipHref(c)}">${esc(c)}</a>`).join('')}
    </div>
    <div class="gallery">${items.map(cardHtml).join('') || '<div class="empty"><p>该分类下暂无作品</p></div>'}</div>
    ${faq ? faq.html : ''}
    <nav class="seo-pager">
      ${prevHref ? `<a class="btn-ghost" href="${esc(prevHref)}">← 上一页</a>` : ''}
      ${nextHref ? `<a class="btn-ghost" href="${esc(nextHref)}">下一页 →</a>` : ''}
    </nav>
    <div class="seo-footer-links">
      <span>按形态浏览：</span>
      ${types.map(t => `<a href="/t/${encodeURIComponent(t)}">${svgIco(TYPE_SVG[t] || 'other')} ${esc(t)}</a>`).join('')}
    </div>
  </main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-meta">
        <span>${SITE_NAME} · 收录大家的网站、个人站、小程序、桌面客户端、机器人等作品</span>
        <a class="footer-icp" href="https://beian.miit.gov.cn/" target="_blank" rel="nofollow noopener noreferrer">沪ICP备2026057999号</a>
      </div>
      <!-- 与 SPA 页脚同一口径：不显示额外标识，rel 保留 nofollow sponsored -->
      <div class="footer-host">
        <span>服务器部署在</span>
        <a href="https://www.aliyun.com/minisite/goods?userCode=tw6ffyfu" target="_blank" rel="nofollow sponsored noopener noreferrer">阿里云 <span aria-hidden="true">↗</span></a>
      </div>
      <div class="footer-oss">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
        <span>本站已开源，欢迎</span>
        <a href="https://github.com/fxxqq/dream-case" target="_blank" rel="noopener noreferrer">Star / Fork / PR <span aria-hidden="true">↗</span></a>
      </div>
      <a href="/sitemap.xml" class="footer-link">站点地图</a>
      <a href="/?feedback=1" class="footer-link">意见反馈</a>
    </div>
  </footer>
</body>
</html>`;
}

function sitemapXml(base, { works, categories, types, authors, siteUpdated, categoryLastmod = {}, typeLastmod = {} }) {
  const urls = [];
  const add = (loc, lastmod, priority, changefreq, image) => {
    const lines = [
      '  <url>',
      `    <loc>${esc(absolute(base, loc))}</loc>`,
      lastmod ? `    <lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` : '',
      `    <changefreq>${changefreq || 'weekly'}</changefreq>`,
      `    <priority>${priority}</priority>`,
      image ? `    <image:image><image:loc>${esc(absolute(base, image))}</image:loc></image:image>` : '',
      '  </url>'
    ].filter(Boolean);
    urls.push(lines.join('\n'));
  };

  // lastmod 必须是内容真的变过的日子：固定页跟着最新作品走，聚合页跟着各自分类的最新作品走。
  // 早先全部写「今天」会让搜索引擎忽略这个字段（它们会自己识别出不真实并退回抓取时间）。
  const updated = siteUpdated || (works[0] && works[0].createdAt) || new Date().toISOString();
  add('/', updated, '1.0', 'daily');
  add('/rank', updated, '0.8', 'daily');
  add('/mini', updated, '0.8', 'weekly'); // 小程序专栏
  add('/bar', updated, '0.7', 'daily');
  add('/chronicle', updated, '0.5', 'weekly'); // 造梦编年史（站点大事记）
  add('/install', updated, '0.5', 'monthly');  // 安装到桌面（PWA + 小程序码落地页）
  add('/invite', updated, '0.7', 'weekly');    // 邀请收录页（可生成分享海报）
  categories.forEach(c => add('/c/' + encodeURIComponent(c), categoryLastmod[c] || updated, '0.7', 'weekly'));
  types.forEach(t => add('/t/' + encodeURIComponent(t), typeLastmod[t] || updated, '0.6', 'weekly'));
  works.forEach(w => add('/w/' + w.id, w.createdAt, '0.9', 'monthly', w.image));
  authors.forEach(a => add('/u/' + encodeURIComponent(a.name), a.lastmod, '0.5', 'weekly'));

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.join('\n')}
</urlset>`;
}

function robotsTxt(base) {
  return `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/

User-agent: Baiduspider
Allow: /
Disallow: /admin
Disallow: /api/

User-agent: Googlebot
Allow: /
Disallow: /admin
Disallow: /api/

Sitemap: ${base}/sitemap.xml
`;
}

function rssXml(base, works) {
  const items = works.map(w => `    <item>
      <title>${esc(w.title)}</title>
      <link>${esc(absolute(base, '/w/' + w.id))}</link>
      <guid isPermaLink="true">${esc(absolute(base, '/w/' + w.id))}</guid>
      <description>${esc(truncate(md.plain(w.intro || w.title), 200))}</description>
      <category>${esc(w.category || '')}</category>
      <author>${esc(nameOf(w))}</author>
      <pubDate>${new Date(w.createdAt).toUTCString()}</pubDate>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(SITE_NAME)} - ${esc(SITE_TAGLINE)}</title>
    <link>${esc(base + '/')}</link>
    <description>${esc(SITE_DESC)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

function websiteLd(base) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      alternateName: '大家作品集',
      url: base + '/',
      description: SITE_DESC,
      inLanguage: 'zh-CN',
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: base + '/?q={search_term_string}' },
        'query-input': 'required name=search_term_string'
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      // 站点早期叫「大家作品集」，把别名写进实体，避免 AI 搜索把它当成另一个站点
      alternateName: '大家作品集',
      url: base + '/',
      logo: base + '/favicon.svg',
      description: SITE_DESC,
      inLanguage: 'zh-CN'
      // sameAs 需要真实可核实的官方账号/主页才写，没有就不编
    }
  ];
}

module.exports = {
  SITE_NAME, SITE_TAGLINE, SITE_SLOGAN, TYPE_ICONS, TYPE_SVG, APP_CATEGORY, OS_BY_TYPE, setTypeIcons,
  svgIco, esc, truncate, baseUrl, absolute, head,
  breadcrumbHtml, breadcrumbLd, cardHtml,
  workArticle, workLd, homeBlock, listPage,
  sitemapXml, robotsTxt, rssXml, websiteLd
};
