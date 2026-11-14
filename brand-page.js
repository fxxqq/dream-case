// ---------- 品牌橱窗页（/brand/:slug）：企业合作内容的落地页（服务端整页渲染） ----------
// 2026-11-12 定的「中改」口径：
//   · 站内露出仍然走既有广告位、仍然标「广告」——这一层不改，改了就是欺骗读者；
//   · 但企业不必交横幅素材：广告位的跳转地址直接填 /brand/<slug>，点进来先读产品故事，
//     读完再决定要不要去站外。本质还是投放，只是「素材」从一条横幅变成一页内容。
// 2026-11-12 晚补的一条支线：/enterprise 的免费入驻也落在这一页，所以这一页分两种身份，
// 由 brand.paid 决定（默认 false = 免费入驻）：
//   · paid=true  收费投放：首屏标「广告」、整页 noindex；
//   · paid=false 免费入驻：首屏标「企业合作（未收费）」、允许索引。
//   收钱就标广告、没收钱不冒充广告，两种都不许伪装成站内精选。
// 三条硬线（任何身份都不能破）：
//   1. 首屏第一行自曝身份 + 页脚免责说明，绝不伪装成站内精选/推荐；
//   2. 外链一律 rel="nofollow sponsored noopener"，target 新窗口——不留「买一条站内链」的口子；
//   3. 付费页不进索引（也避免被当成买链接），站内 sitemap 同样不收；免费入驻页不设此限。
// 数据存 data/brands.json（deploy 排除 data/，线上那份由后台「品牌橱窗」tab 维护，改完即生效不重启）。
// 与 /ads、/enterprise 的关系：/ads 卖位置（收费），/enterprise 请企业（免费），这里是交付物（企业那一页）。
'use strict';

module.exports = { register };

function register(deps) {
  const {
    app, seo, shell, sendHtml,
    requireAdmin, upload, compressUploads,
    readJSON, writeJSON,
  } = deps;

  const FILE = 'brands.json';
  let brands = readJSON(FILE, []);
  if (!Array.isArray(brands)) brands = [];
  const saveBrands = () => writeJSON(FILE, brands);

  // slug 只收小写字母/数字/连字符：它既是网址也是广告位里填的跳转地址，中文和空格只会让链接长得没法贴
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const clip = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
  const lines = (s, max) => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, max);
  // 图片只认两种来源：本站上传目录、外部 http(s)。不收 data:（太大）/ javascript:（危险）
  const imgOk = u => /^\/uploads\/[\w.\-]+$/.test(u) || /^https?:\/\//i.test(u);
  const imgUrl = (u, w) => (String(u || '').indexOf('/uploads/') === 0
    ? '/t/' + w + '/' + String(u).slice('/uploads/'.length) : String(u || ''));

  // 后台表单（都是字符串）→ 落盘结构。分段的规矩写在后台的输入框提示里，
  // 这里做最后一道清洗：长度上限、图片协议、链接协议，任何一条不合法就退成空值，不报错也不存脏数据。
  function fromForm(b) {
    const raw = b || {};
    const story = String(raw.story || '').split(/\n{2,}/)
      .map(s => s.trim()).filter(Boolean).slice(0, 12)
      .map(s => s.slice(0, 1200));
    const splitPair = l => {
      const i = l.indexOf('|');
      return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    };
    const points = lines(raw.points, 4).map(l => {
      const [t, d] = splitPair(l);
      return { t: t.trim().slice(0, 24), d: d.trim().slice(0, 120) };
    }).filter(p => p.t);
    const shots = lines(raw.shots, 6).map(l => {
      const [src, cap] = splitPair(l);
      return { src: src.trim(), cap: cap.trim().slice(0, 60) };
    }).filter(s => imgOk(s.src));
    return {
      slug: String(raw.slug || '').trim().toLowerCase(),
      name: clip(raw.name, 40),
      tagline: clip(raw.tagline, 80),
      lead: clip(raw.lead, 240),
      story, points, shots,
      audience: lines(raw.audience, 8).map(s => s.slice(0, 40)),
      logo: imgOk(String(raw.logo || '').trim()) ? String(raw.logo).trim() : '',
      cover: imgOk(String(raw.cover || '').trim()) ? String(raw.cover).trim() : '',
      ctaLabel: clip(raw.ctaLabel, 24),
      ctaUrl: /^https?:\/\//i.test(String(raw.ctaUrl || '').trim()) ? String(raw.ctaUrl).trim() : '',
      note: clip(raw.note, 80),
      // 收没收钱决定这一页怎么标（2026-11-12 加）：
      //   收费 = 「广告」+ noindex（法律要求标识，也不给"买链接"留口子）；
      //   免费入驻 = 「企业合作」+ 可索引（没收钱就不是广告，别乱标；企业也能靠这页被搜到）
      paid: !(raw.paid === false || raw.paid === '0' || raw.paid === 0 || raw.paid == null),
      active: !(raw.active === false || raw.active === '0' || raw.active === 0),
    };
  }

  const bySlug = slug => brands.find(b => b && b.slug === slug);
  const publicList = () => brands.filter(b => b && b.active !== false && b.name);

  // ---------- 前台：品牌橱窗页 ----------
  function renderBrand(b, base) {
    // 收没收钱，标识完全不同（别把免费入驻也标成「广告」，也别把付费的洗成「合作」）
    const paid = b.paid === true;
    const flagText = paid ? '广告' : '企业合作';
    const flagSub = paid ? '品牌橱窗 · 企业合作内容（付费展示）' : '品牌橱窗 · 企业合作内容（未收费）';
    const desc = seo.truncate(b.lead || b.tagline || `${b.name} 的产品故事`, 150);
    const headHtml = seo.head({
      title: `${b.name}${b.tagline ? ' · ' + b.tagline : ''} - 品牌橱窗 - ${seo.SITE_NAME}`,
      description: desc,
      // 付费页不进索引：它是一页商业内容，不该靠搜索白拿自然流量（也是不给「买链接」留口子）；
      // 免费入驻页不设这个限制——没收钱就不是广告，企业也该能被搜到
      noindex: paid ? 'follow' : '',
      canonical: base + '/brand/' + b.slug,
      image: b.cover ? seo.absolute(base, imgUrl(b.cover, 1200)) : '',
      imageAlt: b.name,
      type: 'website',
      jsonLd: [
        seo.breadcrumbLd(base, [
          { name: '首页', href: '/' }, { name: '品牌橱窗' }, { name: b.name },
        ]),
        // 明确告诉搜索/聚合方：这是一页企业合作内容，不是站方编辑推荐
        {
          '@context': 'https://schema.org', '@type': 'WebPage',
          name: `${b.name} · 品牌橱窗`, url: base + '/brand/' + b.slug,
          description: desc, isAccessibleForFree: true,
          about: { '@type': 'Brand', name: b.name },
          disclaimer: paid
            ? '企业合作内容（广告），由品牌方提供内容并支付展示费用。'
            : '企业合作内容，由品牌方提供内容，站方未收取展示费用。',
        },
      ],
    });

    const cta = b.ctaUrl ? `<a class="btn-primary brand-btn" href="${seo.esc(b.ctaUrl)}"
        target="_blank" rel="nofollow sponsored noopener">${seo.esc(b.ctaLabel || '去官网看看')} ↗</a>` : '';
    const ctaFoot = b.ctaUrl ? `<a class="btn-primary brand-btn" href="${seo.esc(b.ctaUrl)}"
        target="_blank" rel="nofollow sponsored noopener">${seo.esc(b.ctaLabel || '去官网看看')} ↗</a>` : '';

    // logo 走 400 档：/t/ 只认 400/800/1200/1600（见 server.js THUMB_SIZES），写 200 会 404 破图
    const logoHtml = b.logo
      ? `<img class="brand-logo-img" src="${seo.esc(imgUrl(b.logo, 400))}" alt="${seo.esc(b.name)}" />`
      : `<span class="brand-logo-txt" aria-hidden="true">${seo.esc(String(b.name || '?').slice(0, 1))}</span>`;

    const coverStyle = b.cover ? ` style="--brand-cover:url('${seo.esc(imgUrl(b.cover, 1600))}')"` : '';

    const storyHtml = b.story && b.story.length
      ? `<section class="brand-story">
          <h2>产品故事</h2>
          <div class="brand-prose">${b.story.map(p => `<p>${seo.esc(p)}</p>`).join('')}</div>
        </section>` : '';

    const pointsHtml = b.points && b.points.length
      ? `<section class="brand-points">
          ${b.points.map(p => `<div class="brand-point">
            <h3>${seo.esc(p.t)}</h3>${p.d ? `<p>${seo.esc(p.d)}</p>` : ''}
          </div>`).join('')}
        </section>` : '';

    const shotsHtml = b.shots && b.shots.length
      ? `<section class="brand-shots">
          ${b.shots.map(s => `<figure class="brand-shot">
            <img src="${seo.esc(imgUrl(s.src, 1200))}" alt="${seo.esc(s.cap || b.name)}" loading="lazy" />
            ${s.cap ? `<figcaption>${seo.esc(s.cap)}</figcaption>` : ''}
          </figure>`).join('')}
        </section>` : '';

    const whoHtml = b.audience && b.audience.length
      ? `<section class="brand-who">
          <h2>适合谁用</h2>
          <ul>${b.audience.map(a => `<li>${seo.esc(a)}</li>`).join('')}</ul>
        </section>` : '';

    const block = `<div id="seoContent" class="seo-wrap brand-page">
    ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '品牌橱窗' }, { name: b.name }])}

    <header class="brand-hero${b.cover ? ' has-cover' : ''}"${coverStyle}>
      <!-- 「广告 / 企业合作」必须在首屏、在标题之前读得到：读者有权第一眼就知道这是什么内容 -->
      <div class="brand-flag-row">
        <span class="brand-flag${paid ? '' : ' is-coop'}">${flagText}</span>
        <span class="brand-flag-txt">${flagSub}${b.note ? ' · ' + seo.esc(b.note) : ''}</span>
      </div>
      <div class="brand-hero-main">
        <div class="brand-logo">${logoHtml}</div>
        <div class="brand-hero-id">
          <h1>${seo.esc(b.name)}</h1>
          ${b.tagline ? `<p class="brand-tagline">${seo.esc(b.tagline)}</p>` : ''}
        </div>
      </div>
      ${b.lead ? `<p class="brand-lead">${seo.esc(b.lead)}</p>` : ''}
      <div class="brand-cta-row">
        ${cta}
        <a class="btn-ghost brand-btn-ghost" href="/">继续逛橱窗 →</a>
      </div>
    </header>

    ${storyHtml}
    ${pointsHtml}
    ${shotsHtml}
    ${whoHtml}

    <section class="brand-final">
      <h2>${b.ctaUrl ? '想自己试试？' : '想找他们聊聊？'}</h2>
      <p>产品信息与图片由品牌方提供；本站只按档期展示，不代为背书。用着不对，随时去站内提反馈。</p>
      <div class="brand-cta-row">
        ${ctaFoot || '<a class="btn-primary brand-btn" href="/">回橱窗逛逛</a>'}
      </div>
    </section>

    <p class="brand-disclaimer">
      ${paid
        ? `本页为<b>企业合作内容（广告）</b>：${seo.esc(b.name)} 购买了造梦橱窗的展示位，页面内容由品牌方提供，
      站方按《互联网广告管理办法》标识。它不代表站内编辑推荐，也不影响站里的作品排序。
      <a href="/ads">了解投放方式</a>`
        : `本页为<b>企业合作内容</b>：${seo.esc(b.name)} 通过站内入驻通道提交，站方<b>未收取展示费用</b>，
      内容由品牌方提供、按当期展示，不代为背书。它不代表站内编辑推荐，也不影响站里的作品排序。
      <a href="/enterprise">了解入驻方式</a>`}
    </p>
  </div>`;
    return shell(headHtml, block);
  }

  app.get('/brand/:slug', (req, res) => {
    const b = bySlug(String(req.params.slug || '').toLowerCase());
    // 下线/不存在都回 404 页（不 302 回首页：免得以为链接有效，也让搜索引擎干净地丢掉）
    if (!b || b.active === false) return notFoundPage(req, res);
    sendHtml(res, renderBrand(b, seo.baseUrl(req)));
  });

  function notFoundPage(req, res) {
    const base = seo.baseUrl(req);
    const headHtml = seo.head({
      title: `品牌橱窗不存在 - ${seo.SITE_NAME}`,
      description: '这一页品牌橱窗不存在或已下线。',
      noindex: 'nofollow',
      canonical: base + '/brand/',
    });
    const block = `<div id="seoContent" class="seo-wrap brand-page">
      ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '品牌橱窗' }])}
      <section class="brand-missing">
        <h1>这一页已经下线了</h1>
        <p>品牌橱窗按投放档期展示，档期结束后页面就会撤掉。想看看橱窗里还有什么，回首页逛一圈。</p>
        <p><a class="btn-primary brand-btn" href="/">回首页</a></p>
      </section>
    </div>`;
    sendHtml(res, shell(headHtml, block), 404);
  }

  // ---------- 后台：品牌橱窗的增删改查 ----------
  const brief = () => brands.map(b => ({
    id: b.id, slug: b.slug, name: b.name, tagline: b.tagline,
    active: b.active !== false, paid: b.paid === true, updatedAt: b.updatedAt || '',
    hasCover: !!b.cover, story: (b.story || []).length,
  }));

  app.get('/api/admin/brands', requireAdmin, (req, res) => res.json({ brands: brief() }));

  app.get('/api/admin/brands/:id', requireAdmin, (req, res) => {
    const b = brands.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: '找不到这一页' });
    res.json(b);
  });

  // 图片上传：只存盘返回地址，字段由前端自己拼进表单（logo / cover / 截图共用这一个入口）
  app.post('/api/admin/brands/upload', requireAdmin, (req, res) => {
    upload(req, res, async err => {
      if (err) return res.status(400).json({ error: '上传失败：' + err.message });
      await compressUploads(req);
      const f = (req.files && (req.files.image || req.files.images) || [])[0];
      if (!f) return res.status(400).json({ error: '没有收到图片' });
      res.json({ url: '/uploads/' + f.filename });
    });
  });

  app.post('/api/admin/brands', requireAdmin, (req, res) => {
    const p = fromForm(req.body);
    if (!SLUG_RE.test(p.slug)) return res.status(400).json({ error: 'slug 只能用 2-41 位小写字母、数字或连字符（它会变成 /brand/xxx 这个网址）' });
    if (!p.name) return res.status(400).json({ error: '品牌 / 产品名必填' });
    if (!p.story.length && !p.points.length) return res.status(400).json({ error: '至少要有一段产品故事或一条卖点，否则这页没内容可读' });
    const id = String((req.body || {}).id || '');
    const dup = brands.find(x => x.slug === p.slug && x.id !== id);
    if (dup) return res.status(400).json({ error: 'slug 已被「' + dup.name + '」占用，换一个' });
    let b = id ? brands.find(x => x.id === id) : null;
    if (id && !b) return res.status(404).json({ error: '找不到这一页' });
    if (!b) {
      b = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() };
      brands.push(b);
    }
    Object.assign(b, p, { updatedAt: new Date().toISOString() });
    saveBrands();
    res.json({ ok: true, brands: brief() });
  });

  app.delete('/api/admin/brands/:id', requireAdmin, (req, res) => {
    const i = brands.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: '找不到这一页' });
    brands.splice(i, 1);
    saveBrands();
    res.json({ ok: true, brands: brief() });
  });

  // 给 /ads 之类的外面用：站点有几页品牌橱窗在展示（数字不对外保证，只是让人知道这个形态真的在用）
  return { count: () => publicList().length };
}
