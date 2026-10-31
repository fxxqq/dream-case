/**
 * SEO 渲染模块
 * - 服务于搜索引擎与社交分享的 HTML 片段生成
 * - 纯函数，不依赖 express，便于单测
 */
'use strict';

const SITE_NAME = '造梦橱窗';
const SITE_TAGLINE = '让好作品被更多人看见';
const SITE_SLOGAN = SITE_TAGLINE;
// 结构化数据 / RSS 用的事实性描述（标题用标语，描述仍写清收录范围更利于搜索展现）
const SITE_DESC = '收录大家的网站、小程序、App 与智能体作品，支持搜索、分类浏览、作品榜单与免费投稿。';

const TYPE_ICONS = { '网站': '🌐', '小程序': '📱', 'App': '📲', '智能体': '🤖', '桌面应用': '🖥️', '浏览器扩展': '🧩', '工具': '🛠️', '游戏': '🎮', '其他': '✨' };
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
  '开发工具': 'DeveloperApplication',
  '其他': 'UtilitiesApplication'
};
const OS_BY_TYPE = {
  '网站': 'Web', '小程序': 'WeChat', 'App': 'iOS, Android', '智能体': 'Web',
  '桌面应用': 'Windows, macOS, Linux', '浏览器扩展': 'Chrome, Edge', '工具': 'Web', '游戏': 'Web, Windows', '其他': 'Web'
};

/** 作品形态：兼容旧的单值 type，返回数组 */
function typesOf(w) {
  if (Array.isArray(w.types) && w.types.length) return w.types;
  return [w.type || '网站'];
}
function typeText(w, sep = ' · ') {
  return typesOf(w).map(t => `${TYPE_ICONS[t] || '✨'} ${t}`).join(sep);
}
function typeBadges(w) {
  return typesOf(w)
    .map(t => `<span class="badge-type">${TYPE_ICONS[t] || '✨'} ${esc(t)}</span>`)
    .join('');
}
const LINK_LABELS = {
  '网站': '🌐 打开网站', '小程序': '📱 打开小程序', 'App': '📲 前往下载',
  '智能体': '🤖 体验智能体', '桌面应用': '🖥️ 下载客户端', '浏览器扩展': '🧩 前往安装',
  '游戏': '🎮 开始游戏', '其他': '🔗 访问作品'
};
function linkLabelOf(w) {
  const t = typesOf(w);
  for (const k of ['网站', '小程序', 'App', '智能体', '桌面应用', '浏览器扩展', '游戏', '其他']) if (t.indexOf(k) !== -1) return LINK_LABELS[k];
  return '🔗 访问作品';
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

  const robots = noindex
    ? 'noindex,nofollow'
    : 'index,follow,max-image-preview:large,max-snippet:-1';

  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    keywords ? `<meta name="keywords" content="${esc(keywords)}" />` : '',
    `<meta name="robots" content="${robots}" />`,
    `<meta name="theme-color" content="#4f46e5" />`,
    canonical ? `<link rel="canonical" href="${esc(canonical)}" />` : '',
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
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
/** 开源 / 闭源 徽章（未标注返回空串） */
function osBadgeHtml(w) {
  if (w.openSource === true) return '<span class="os-badge open" title="开放源代码">🔓 开源</span>';
  if (w.openSource === false) return '<span class="os-badge closed" title="未开放源代码">🔒 闭源</span>';
  return '';
}

// 付费标识：默认免费不输出，只有标注收费才显示
function paidBadgeHtml(w) {
  return w.paid ? '<span class="os-badge paid" title="需要付费或含付费版本">💰 付费</span>' : '';
}

function cardHtml(w, suffix = '') {
  return `<a class="card seo-card" href="/w/${esc(w.id)}${suffix}">
  <div class="card-img-wrap">
    <img class="card-img" src="${esc(w.thumb || w.image)}" alt="${esc(w.title)} - ${esc((w.category || '') + typesOf(w).join('/'))}作品封面" loading="lazy" decoding="async" />
    <span class="type-badge" title="${esc(typesOf(w).join(' / '))}">${typeText(w)}</span>
  </div>
  <div class="card-body">
    <div class="card-title">${esc(w.title)}</div>
    <div class="card-meta"><span>@${esc(w.author)}</span><span class="card-tags"><span class="card-cat">${esc(w.category || '')}</span>${osBadgeHtml(w)}${paidBadgeHtml(w)}</span></div>
  </div>
</a>`;
}

/** 作品详情页的服务端渲染正文
 *  opts.full = true 时输出「完整页面」形态：完整展示宣传图，并给出在橱窗内互动/返回的入口。
 *  两种形态共用同一个 canonical（/w/:id），避免被搜索引擎当成重复页面。 */
function workArticle(base, w, trail, related = [], opts = {}) {
  const linkLabel = linkLabelOf(w);
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

  return `<div id="seoContent" class="seo-wrap${full ? ' seo-full' : ''}" data-full="${full ? '1' : '0'}">
  ${breadcrumbHtml(base, trail)}
  <article class="seo-article">
    <h1>${esc(w.title)}</h1>
    <div class="seo-meta">
      ${typeBadges(w)}
      <span class="badge-cat">${esc(w.category || '')}</span>
      ${osBadgeHtml(w)}
      ${paidBadgeHtml(w)}
      ${w.featured ? '<span class="badge-featured">✨ 精选</span>' : ''}
    </div>
    <p class="seo-author">作者：<a href="/u/${encodeURIComponent(w.author)}" rel="author">@${esc(w.author)}</a>
      · ${w.likes || 0} 点赞 · ${w.favs || 0} 人收藏 · ${w.commentCount || 0} 评论 · ${w.views || 0} 浏览${date ? ' · ' + esc(date) : ''}</p>
    <img class="seo-cover" src="${esc(w.image)}" alt="${esc(w.title)} 作品截图" />
    ${gallery}
    <div class="seo-intro">${esc(w.intro || '').replace(/\n/g, '<br>') || '<p>作者暂未填写作品介绍。</p>'}</div>
    <div class="seo-actions">
      ${w.link ? `<a class="btn-primary" href="${esc(w.link)}" target="_blank" rel="nofollow noopener">${linkLabel}</a>` : ''}
      ${w.repo ? `<a class="btn-ghost" href="${esc(w.repo)}" target="_blank" rel="nofollow noopener">📁 源码仓库</a>` : ''}
      ${full ? `<a class="btn-ghost" href="/w/${esc(w.id)}">在橱窗里打开（点赞 / 收藏 / 评论）</a>` : ''}
      <a class="btn-ghost" href="/c/${encodeURIComponent(w.category || '其他')}">更多${esc(w.category || '')}作品</a>
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
    description: truncate(w.intro || `${w.title}，由 ${w.author} 提交的${w.category}类${typesOf(w).join('/')}作品。`, 300),
    url: pageUrl,
    image: absolute(base, w.image),
    applicationCategory: APP_CATEGORY[w.category] || 'UtilitiesApplication',
    operatingSystem: OS_BY_TYPE[typesOf(w)[0]] || 'Web',
    inLanguage: 'zh-CN',
    datePublished: w.createdAt,
    author: { '@type': 'Person', name: w.author, url: absolute(base, '/u/' + encodeURIComponent(w.author)) },
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

/** 首页/列表页的静态可视区块（JS 关闭也能浏览，爬虫可抓链接） */
function homeBlock(base, { works, categories, types }) {
  return `<div id="seoContent" class="seo-wrap seo-home">
  <section class="seo-links">
    <div class="seo-links-group">
      <span class="seo-links-title">按分类浏览</span>
      ${categories.map(c => `<a href="/c/${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
    </div>
    <div class="seo-links-group">
      <span class="seo-links-title">按形态浏览</span>
      ${types.map(t => `<a href="/t/${encodeURIComponent(t)}">${TYPE_ICONS[t] || ''} ${esc(t)}</a>`).join('')}
    </div>
  </section>
  <h2 class="seo-h2">最新收录</h2>
  <div class="gallery">${works.map(cardHtml).join('')}</div>
  <p class="seo-more"><a href="/rank">查看作品榜单 →</a></p>
</div>`;
}

/** 独立列表页（/c/:cat、/t/:type），完全服务端渲染 */
function listPage(base, { title, description, h1, activeName, kind = 'c', subtitle, items, trail, page, hasMore, prevHref, nextHref, canonical, categories, types }) {
  const chipHref = c => '/' + kind + '/' + encodeURIComponent(c);
  const headHtml = head({
    title,
    description,
    keywords: [h1, '作品集合', '工具导航', '网站推荐', '小程序收录'].join(','),
    canonical,
    type: 'website',
    jsonLd: [
      breadcrumbLd(base, trail),
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
        <a class="nav-btn" href="/rank">榜单</a>
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
    <nav class="seo-pager">
      ${prevHref ? `<a class="btn-ghost" href="${esc(prevHref)}">← 上一页</a>` : ''}
      ${nextHref ? `<a class="btn-ghost" href="${esc(nextHref)}">下一页 →</a>` : ''}
    </nav>
    <div class="seo-footer-links">
      <span>按形态浏览：</span>
      ${types.map(t => `<a href="/t/${encodeURIComponent(t)}">${TYPE_ICONS[t] || ''} ${esc(t)}</a>`).join('')}
    </div>
  </main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-meta">
        <span>${SITE_NAME} · 收录大家的网站、小程序、App 与智能体作品</span>
        <a class="footer-icp" href="https://beian.miit.gov.cn/" target="_blank" rel="nofollow noopener noreferrer">沪ICP备2026057999号</a>
      </div>
      <a href="/sitemap.xml" class="footer-link">站点地图</a>
      <a href="/?feedback=1" class="footer-link">意见反馈</a>
    </div>
  </footer>
</body>
</html>`;
}

function sitemapXml(base, { works, categories, types, authors }) {
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

  add('/', new Date().toISOString(), '1.0', 'daily');
  add('/rank', new Date().toISOString(), '0.8', 'daily');
  categories.forEach(c => add('/c/' + encodeURIComponent(c), new Date().toISOString(), '0.7', 'weekly'));
  types.forEach(t => add('/t/' + encodeURIComponent(t), new Date().toISOString(), '0.6', 'weekly'));
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
      <description>${esc(truncate(w.intro || w.title, 200))}</description>
      <category>${esc(w.category || '')}</category>
      <author>${esc(w.author)}</author>
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
      url: base + '/',
      logo: base + '/favicon.svg',
      description: SITE_TAGLINE
    }
  ];
}

module.exports = {
  SITE_NAME, SITE_TAGLINE, SITE_SLOGAN, TYPE_ICONS, APP_CATEGORY, OS_BY_TYPE, setTypeIcons,
  esc, truncate, baseUrl, absolute, head,
  breadcrumbHtml, breadcrumbLd, cardHtml,
  workArticle, workLd, homeBlock, listPage,
  sitemapXml, robotsTxt, rssXml, websiteLd
};
