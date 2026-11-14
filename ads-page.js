// ---------- 投放合作（/ads）：面向站外广告主的现金刊例（服务端渲染） ----------
// 2026-11-11 从 server.js 原样拆出（server.js 渐进拆分第一步，行为零变化，不引构建）。
// 这一页只做「展示效果 + 留资」：站外客户没有站内账号、也没法用灯火，所以不接在线支付，
// 成交走反馈弹窗（游客可提交、带联系方式）私聊定档期。和站内作者用灯火兑换的推荐位
// （REDEEM_SLOTS）是两套账，互不影响，改这里不会动到兑换价格。
// 所有统计数字实时算自 visits / works / workVisits，页面里不手写一个数——
// 数据随站点增长自动更新，招商材料永远不会过期。
// 口径与页脚一致：网页 + 小程序分开计 PV、UV 跨端去重并套用站长排除名单。
// 依赖注入说明：
//   app / seo / shell / sendHtml / truncateText  公共设施，只读；
//   visits / workVisits                          常引用对象（字段原地更新），引用一致；
//   redemptions                                  启动载入的数组，后续只 push / 改元素，不整体重赋；
//   visitExcludeSet / visitStats / visibleWorks / authorEntries / uncountedPvOf
//                                                统计口径函数，原样注入。
module.exports = { register };

function register(deps) {
  const {
    app, seo, shell, sendHtml, truncateText,
    visits, workVisits, redemptions,
    visitExcludeSet, visitStats, visibleWorks, authorEntries, uncountedPvOf,
  } = deps;

  // 价格口径：按周起投、整数元。ADV_SLOTS 是唯一价格源——位置卡、刊例表、按钮提示、
  // SEO 描述全部从这里取，改价只改这一处。
  // 【首发价】站还小，先把门槛压到「一周一顿饭」，让人愿意试；流量涨起来再按比例提。
  const ADV_BOOK_NOTE = '首发价 · 2026 年 11 月版';
  const ADV_TRIAL = 0.5;                 // 首周试投折扣
  const ADV_SLOTS = [
    {
      no: '01', name: '首页头部横幅', tag: '流量最大',
      where: '首页 Hero 正下方、本周精选之上',
      form: '整条横幅，可配背景图', size: '1400 × 280',
      rule: '每周只接 1 条，独占',
      week: 100, month: 300,
      pitch: '每个进首页的人，都是先看到它，才看到作品。',
      note: '全站流量的第一入口。适合新品首发、活动预告这类「只要被看见就成立」的信息。'
    },
    {
      no: '02', name: '页脚上方通栏', tag: '覆盖面最广',
      where: '所有页面底部、页脚之上',
      form: '通栏文字条，全站同款', size: '1400 × 200',
      rule: '每周 2 条，轮播',
      week: 50, month: 150,
      pitch: '你打开每一个页面，底部都有它。',
      note: '首页、榜单、酒馆、详情页、编辑页，全站每一页都出现。适合长期曝光，把名字混成熟脸。'
    },
    {
      no: '03', name: '作品详情页', tag: '意图最强',
      where: '作品详情内、评论区上方',
      form: '横幅，可配图', size: '1200 × 240',
      rule: '每周 3 条，轮播',
      week: 50, month: 150,
      pitch: '点进一个作品的人，正在认真地挑工具。',
      note: '进到详情页的人已经点开了别人的作品，注意力最集中、判断最具体。适合和具体作品做对照的产品。'
    },
    {
      no: '04', name: '小程序三处打包', tag: '手机端 · 打开即到',
      where: '小程序首页顶部 / 作品详情页 / 星梦榜与发现页',
      form: '横幅 1 处 + 文字行 2 处', size: '1080 × 360 · 文字行',
      rule: '一次购买，三处轮展',
      week: 130, month: 400,
      pitch: '手机上没有别的窗口，打开就是它。',
      note: '小程序是真机、全屏、无广告拦截，一次打开就是一次完整曝光。三处打包，一次买齐手机上的三个入口。'
    }
  ];
  // 一排小骨架图：给每个位置配一张「它长在页面哪儿」的示意图，比文字描述快得多。
  // 只画灰条不画真内容——广告主看的是位置，不是作品。
  function advSkel(kind) {
    const hot = (label) => `<span class="adv-sk-hot">${label}</span>`;
    if (kind === 'mini') {
      return `<div class="adv-sk is-phone" aria-hidden="true">
        <span class="adv-sk-nav"></span>
        ${hot('广告')}
        <span class="adv-sk-line w70"></span>
        <span class="adv-sk-cards two"><i></i><i></i><i></i><i></i></span>
      </div>`;
    }
    const nav = '<span class="adv-sk-nav"></span>';
    const lines = '<span class="adv-sk-line w70"></span><span class="adv-sk-line w45"></span>';
    const cards = '<span class="adv-sk-cards"><i></i><i></i><i></i></span>';
    const foot = '<span class="adv-sk-foot"></span>';
    if (kind === 'top') return `<div class="adv-sk" aria-hidden="true">${nav}${hot('广告')}${lines}${cards}${foot}</div>`;
    if (kind === 'footer') return `<div class="adv-sk" aria-hidden="true">${nav}${lines}${cards}${hot('广告')}${foot}</div>`;
    if (kind === 'detail') return `<div class="adv-sk" aria-hidden="true">${nav}${lines}${cards}<span class="adv-sk-layer">${hot('广告')}</span>${foot}</div>`;
    return `<div class="adv-sk" aria-hidden="true">${nav}${lines}${cards}${foot}</div>`;
  }

  app.get('/ads', (req, res) => {
    const base = seo.baseUrl(req);
    const ex = visitExcludeSet();
    const keys7 = Object.keys(visits.days).sort().slice(-7);
    let pv7 = 0, miniPv7 = 0;
    const uv7 = new Set();
    keys7.forEach(k => {
      const d = visits.days[k] || {};
      pv7 += (d.pv || 0) - uncountedPvOf(d, ex);
      Object.keys(d.uv || {}).forEach(x => { if (!ex.has(x)) uv7.add(x); });
      if (d.mini) {
        miniPv7 += (d.mini.pv || 0) - uncountedPvOf(d.mini, ex);
        Object.keys(d.mini.uv || {}).forEach(x => { if (!ex.has(x)) uv7.add(x); });
      }
    });
    const stats = visitStats();
    const allVisible = visibleWorks();
    const worksCount = allVisible.length;
    const authorsCount = authorEntries().length;
    const totalPv7 = pv7 + miniPv7;
    const pvPerUv = uv7.size ? Math.round((totalPv7 / uv7.size) * 10) / 10 : 0;
    // 站里都在做什么：分类 Top 6，让广告主自己判断「我的人在不在这」
    const catMap = new Map();
    allVisible.forEach(w => { const k = w.category || '其他'; catMap.set(k, (catMap.get(k) || 0) + 1); });
    const catTop = Array.from(catMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    // 社会证明：站内已经发生过多少次真实投放、此刻有多少条在轮播（不是编的数字，是订单表算的）
    const adOrders = Array.isArray(redemptions) ? redemptions.length : 0;
    const adRunning = Array.isArray(redemptions) ? redemptions.filter(r => r && r.status === 'active').length : 0;
    // 本周最受欢迎作品（内容氛围样本，只报名字和曝光，不掺评价）
    const topWorks = allVisible
      .map(w => {
        const rec = workVisits[w.id] || {};
        let p = 0;
        keys7.forEach(k => { const x = (rec.days || {})[k]; if (x) p += x.pv || 0; });
        return { title: w.title, pv7: p };
      })
      .sort((a, b) => b.pv7 - a.pv7).slice(0, 3)
      .filter(t => t.pv7 > 0);

    const headHtml = seo.head({
      title: `投放合作 · 广告位招租 - 头部 / 页脚 / 详情页 / 小程序，四个位置的实样和刊例都在这 - ${seo.SITE_NAME}`,
      description: truncateText(
        `造梦橱窗广告位招租：首页头部横幅、全站页脚通栏、作品详情页、小程序三处打包，按周起投，首周最低 25 元。` +
        `曝光和点击每天可查，随时可停。已运营 ${stats.runDays} 天，近 7 天 ${uv7.size} 位访客、${totalPv7} 次浏览。`, 150),
      keywords: '投放合作,广告位招租,独立开发者,开发者社区广告,小程序广告位,造梦橱窗',
      canonical: base + '/ads',
      type: 'website',
      jsonLd: [
        seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '投放合作' }]),
        { '@context': 'https://schema.org', '@type': 'WebPage', name: '投放合作 · 广告位招租', url: base + '/ads' }
      ]
    });

    const statCell = (num, label) => `<div class="adv-stat"><b>${num}</b><span>${label}</span></div>`;
    const fbHint = '说一下你想推的产品、想投哪个位置、大概投多久，留个微信或邮箱，站长看到会回你档期和刊例。';

    // 位置卡：示意 + 真样式样张 + 参数 + 价格
    // 样张里带一个假的关闭按钮：真实广告位右上角就有它，「可以随手关掉」是这条广告最大的卖点，
    // 图上直接摆出来比文案解释有用
    const demoX = '<span class="adv-demo-x" aria-hidden="true">✕</span>';
    const demoOf = (no) => {
      // 头部横幅给两种样子：不配图（纯色条，默认）和配图（满幅背景）。广告主一眼知道自己要交什么
      if (no === '01') return `<div class="adv-demo is-banner">
        <div class="ad-card">
          <span class="ad-body">
            <span class="ad-badge">广告</span>
            <b class="ad-title">你的产品名</b>
            <span class="ad-desc">一句话说清给谁用、解决什么问题</span>
            <span class="ad-cta">去看看 →</span>
          </span>${demoX}
        </div>
        <div class="ad-card is-photo">
          <span class="ad-photo" aria-hidden="true"></span>
          <span class="ad-body">
            <span class="ad-badge">广告</span>
            <b class="ad-title">配图版</b>
            <span class="ad-desc">给一张图，右侧铺一层淡底纹</span>
            <span class="ad-cta">去看看 →</span>
          </span>${demoX}
        </div>
      </div>`;
      if (no === '04') return `<div class="adv-demo is-phone">
        <div class="ad-card">
          <span class="ad-body"><span class="ad-badge">广告</span><b class="ad-title">你的产品名</b><span class="ad-cta">打开 →</span></span>${demoX}
        </div>
        <div class="adv-demo-line"><span class="ad-badge">广告</span><b>一行文字位：一句话标题也能投</b></div>
      </div>`;
      return `<div class="adv-demo">
        <div class="ad-card ad-text-card">
          <span class="ad-body">
            <span class="ad-badge">广告</span>
            <b class="ad-title">你的产品名</b>
            <span class="ad-desc">一句话介绍：给谁用、解决什么问题，建议 30 字以内</span>
            <span class="ad-cta">去看看 →</span>
          </span>${demoX}
        </div>
      </div>`;
    };

    const posCard = (s, i) => {
      const trial = Math.round(s.week * ADV_TRIAL);
      const skelKind = s.no === '01' ? 'top' : s.no === '02' ? 'footer' : s.no === '03' ? 'detail' : 'mini';
      return `<article class="adv-pos${i % 2 ? ' is-flip' : ''}" id="pos-${s.no}">
        <div class="adv-pos-map">
          ${advSkel(skelKind)}
          <span class="adv-pos-map-cap">它长在页面的这个位置</span>
        </div>
        <div class="adv-pos-main">
          <div class="adv-pos-head">
            <span class="adv-pos-no">${s.no}</span>
            <h3>${seo.esc(s.name)}</h3>
            <span class="adv-pos-tag">${seo.esc(s.tag)}</span>
          </div>
          <p class="adv-pos-pitch">${seo.esc(s.pitch)}</p>
          ${demoOf(s.no)}
          <dl class="adv-spec">
            <div><dt>出现在</dt><dd>${seo.esc(s.where)}</dd></div>
            <div><dt>形态</dt><dd>${seo.esc(s.form)}</dd></div>
            <div><dt>尺寸</dt><dd>${seo.esc(s.size)}</dd></div>
            <div><dt>档期</dt><dd>${seo.esc(s.rule)}</dd></div>
          </dl>
          <p class="adv-pos-note">${seo.esc(s.note)}</p>
          <div class="adv-pos-buy">
            <span class="adv-price">¥${s.week}<small>/ 周</small><em>首周 ¥${trial} 试投</em><i>包月 ¥${s.month}</i></span>
            <button type="button" class="btn-primary adv-btn" data-fb="广告投放" data-fb-title="广告投放咨询" data-fb-hint="想订「${seo.esc(s.name)}」：说一下你想推的产品、大概投多久，留个微信或邮箱，站长看到会回你档期和报价。">订这个位置</button>
          </div>
        </div>
      </article>`;
    };

    const tableRows = ADV_SLOTS.map(s => `<tr>
        <td class="adv-td-no">${s.no}</td>
        <td><b>${seo.esc(s.name)}</b><span class="adv-td-sub">${seo.esc(s.where)}</span><span class="adv-td-sub adv-td-rule">${seo.esc(s.rule)}</span></td>
        <td class="adv-td-rule">${seo.esc(s.rule)}</td>
        <td class="adv-td-price">¥${s.week}</td>
        <td class="adv-td-price">¥${s.month}</td>
        <td class="adv-td-trial">¥${Math.round(s.week * ADV_TRIAL)}</td>
      </tr>`).join('');

    const block = `<div id="seoContent" class="seo-wrap adv-page">
    ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '投放合作' }])}

    <section class="adv-hero">
      <div class="adv-hero-txt">
        <span class="adv-eyebrow">广告位招租 · ${seo.esc(ADV_BOOK_NOTE)}</span>
        <h1>把产品放进一个<br /><em>人人都在找工具</em>的橱窗</h1>
        <p class="adv-sub">造梦橱窗收录独立开发者自己做的网站、小程序、智能体和软件。来这里的人不是刷信息流的，
        是在找工具、找灵感、找同行——你的产品出现在这里，更像一条内容，不像一次打扰。</p>
        <div class="adv-cta-row">
          <button type="button" class="btn-primary adv-btn" data-fb="广告投放" data-fb-title="广告投放咨询" data-fb-hint="${fbHint}">拿刊例和档期</button>
          <a class="btn-ghost adv-btn adv-cta-sub" href="#adv-positions">先看四个位置长什么样</a>
        </div>
        <p class="adv-trust"><span>四个位置可单独投</span><span>按周起投，首周最低 ¥${Math.round(50 * ADV_TRIAL)}</span><span>曝光点击每天可查</span><span>不满意随时停</span></p>
      </div>
      <div class="adv-showcase" aria-hidden="true">
        <div class="adv-showcase-pc">
          <div class="adv-showcase-bar"><i></i><i></i><i></i><span>idea.v5pc.com</span></div>
          <span class="adv-slot-hi">01 · 首页头部横幅</span>
          <span class="adv-sk-line w60"></span>
          <span class="adv-sk-line w35"></span>
          <span class="adv-showcase-tiles"><i></i><i></i><i></i><i></i><i></i><i></i><em class="adv-showcase-layer">03 · 详情页</em></span>
          <span class="adv-slot-hi is-foot">02 · 页脚通栏</span>
        </div>
        <div class="adv-showcase-phone">
          <span class="adv-slot-hi">04 · 小程序</span>
          <span class="adv-showcase-tiles two"><i></i><i></i><i></i><i></i><i></i><i></i></span>
        </div>
      </div>
    </section>

    <div class="adv-stats">
      ${statCell(stats.runDays, '天 · 已运营')}
      ${statCell(uv7.size, '近 7 天访客')}
      ${statCell(totalPv7, '近 7 天浏览')}
      ${statCell(worksCount, '件在架作品')}
      <!-- 创作者数暂时不展示：量级还小，等数字好看了再放回来 -->
    </div>
    <p class="adv-foot-note">数字实时算自站内访问统计，剔除了站长本人的访问；网页端与小程序端分开计浏览、访客跨端去重。
    近 7 天人均浏览 ${pvPerUv} 页。${topWorks.length ? `这周被打开最多的是《${seo.esc(topWorks[0].title)}》（${topWorks[0].pv7} 次）。` : ''}</p>

    <section class="adv-why">
      <div class="adv-why-card">
        <span class="adv-why-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s7-4.5 7-10a7 7 0 1 0-14 0c0 5.5 7 10 7 10Z"/><circle cx="12" cy="11" r="2.6"/></svg>
        </span>
        <h3>看到的，就是做产品的人</h3>
        <p>站里 ${worksCount} 件作品全是独立开发者自己发的：${catTop.map(c => `${seo.esc(c[0])} ${c[1]}`).join('、')}。
        会点开作品看的人，和你想要的那批人高度重合——不是泛流量买来的数字。</p>
      </div>
      <div class="adv-why-card">
        <span class="adv-why-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h6M7 14h10"/></svg>
        </span>
        <h3>长得像内容，不像广告</h3>
        <p>全站统一的浅色细条 +「广告」角标，不弹窗、不遮内容、不自动播放，用户随手就能关掉。
        品牌不会因为一条广告挨骂——这是长期投的基础。</p>
      </div>
      <div class="adv-why-card">
        <span class="adv-why-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
        </span>
        <h3>效果当天就能算清</h3>
        <p>每次曝光、每次点击、每个访客都单独记账，投放期内随时给你一份按天的数据。
        不做「包年包量」的话术，额度用完就停，看不下去随时撤。</p>
      </div>
    </section>

    <div class="adv-sec-head" id="adv-positions">
      <h2>四个位置，长这样</h2>
      <p>下面每张都是站内真实样式（演示内容不可点击）。位置、形态、尺寸、档期都写清楚了，看到就知道自己的素材要做什么。${adOrders ? `\n    这几个位置不是摆着好看的：上线至今站内已经发生 ${adOrders} 次真实投放，此刻有 ${adRunning} 条正在轮播。` : ''}</p>
    </div>
    <div class="adv-pos-list">${ADV_SLOTS.map(posCard).join('')}</div>

    <div class="adv-sec-head">
      <h2>刊例</h2>
      <p>按周起投，先投一周试水也可以。${seo.esc(ADV_BOOK_NOTE)}，包月或多位置打包另议。</p>
    </div>
    <div class="adv-table-wrap">
      <table class="adv-table">
        <thead><tr><th>#</th><th>位置</th><th>档期</th><th>周</th><th>月</th><th>首周试投</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <p class="adv-foot-note">价格为刊例价，含素材上架、按天数据、投放期内的调整；不含素材设计（你给图就上）。
    同一位置同期只接有限条数，满了就排下一档期。</p>

    <div class="adv-sec-head" id="adv-brand">
      <h2>不想只放一条横幅？那就做一页「品牌橱窗」</h2>
      <p>位置照旧买，素材换一种：不交横幅图，改成做一页产品故事页（网址是 <b>/brand/你的产品名</b>）。
      广告位点进去先读你的产品为什么做、解决什么问题、长什么样，读完再决定要不要去站外——
      对真有产品的公司，这比一条 1400×280 的图有用得多。</p>
    </div>
    <section class="adv-swap adv-brand-form">
      <div class="adv-swap-card">
        <h3>还是「广告」，标识一点不少</h3>
        <p>广告位上的角标照旧写「广告」；橱窗页首屏第一行也写明「广告 · 企业合作内容」，页面不进搜索索引，
        外链带 sponsored。想让人信任，靠的是写清楚自己是谁，不是把标识藏起来。</p>
      </div>
      <div class="adv-swap-card">
        <h3>你要交的东西变了</h3>
        <p>不用出设计稿：一段产品故事（为什么做它）、三句卖点、几张截图和一个官网链接就够了，
        排版我们来。原型机、参数表、团队照片这些想放也放得下。</p>
      </div>
      <div class="adv-swap-card">
        <h3>怎么算钱</h3>
        <p>橱窗页不单卖：按上面的位置档期买曝光，页面跟着位置走。页面制作、改稿和位置一起谈，
        换季改文案不额外收费，下线时页面一起撤。</p>
      </div>
    </section>
    <div class="adv-swap-cta">
      <button type="button" class="btn-primary adv-btn" data-fb="品牌橱窗" data-fb-title="品牌橱窗页咨询" data-fb-hint="说一下你的产品、官网链接、想投哪个位置和大概档期；产品故事有现成的就发一份，没有的话聊两句我们帮你理。">我想做一页品牌橱窗</button>
      <span>横幅让人看见，页面让人看懂。</span>
    </div>
    <p class="adv-foot-note">产品确实做得好、只是暂时不想花钱买位置的，走另一条路：
    <a href="/enterprise">企业产品入驻</a>——不收费、不谈预算，把产品发过来我们真用一遍，合适就排一页。
    两条路不互相绑定，买了位置也不会因此更容易入驻。</p>

    <div class="adv-sec-head" id="adv-swap">
      <h2>自带流量？可以不谈钱，谈互换</h2>
      <p>这一条专门留给「在别处也带着一群做产品的人」：公众号、社群、B 站、小红书、播客都算。
      你往这里导一波，我们在站里给你等价的位置——谁也不欠谁，预算双方都省下来。</p>
    </div>
    <section class="adv-swap">
      <div class="adv-swap-card">
        <h3>怎么个换法</h3>
        <p>按上面的刊例价折算，两边对等：你的渠道带来的量值多少，就在站里给你等价的位置和时长。
        不是「互挂友链」那种含糊账，值多少、换多久，摆到桌面上算。</p>
      </div>
      <div class="adv-swap-card">
        <h3>你能拿到什么</h3>
        <p>和付费客户完全一样的待遇：四个位置任选、统一样式上架、带「广告」角标、按天的曝光和点击数据照给。
        先换两周试试，跑得好再续，随时可停。</p>
      </div>
      <div class="adv-swap-card">
        <h3>什么样的号合适</h3>
        <p>人群重合比粉丝数重要：独立开发、效率工具、AI、建站、出海这类受众优先。
        不用先准备报价，链接和量级甩过来，聊两句就知道合不合适。</p>
      </div>
    </section>
    <div class="adv-swap-cta">
      <button type="button" class="btn-primary adv-btn" data-fb="资源互换" data-fb-title="资源互换洽谈" data-fb-hint="说一下你的平台和链接、粉丝量 / 阅读量大概什么量级、想换哪个位置；合适的话互相挂位，不花现金。">聊聊资源互换</button>
      <span>预算留给产品，流量这件事我们互相帮衬。</span>
    </div>

    <div class="adv-sec-head"><h2>怎么上</h2></div>
    <ol class="adv-steps">
      <li><b>1</b><div><h3>说清要推什么</h3><p>私聊留下产品一句话、想投的位置和时长。有档期就当天回你。</p></div></li>
      <li><b>2</b><div><h3>交素材</h3><p>标题 + 一句介绍 + 一张图（或不用图）+ 落地链接。样式由站内统一渲染，和页面气质一致。
      不想出图，就交一篇产品故事，我们排成一页品牌橱窗当落地页（见上面那节）。</p></div></li>
      <li><b>3</b><div><h3>上线，看数</h3><p>上架后每天可查曝光、点击、访客和关闭次数。周结或月结都行。</p></div></li>
    </ol>

    <div class="adv-rules">
      <h2>我们不接这些</h2>
      <ul>
        <li>违法、灰产、赌博、贷款导流，以及任何要「先加微信领资料」的钩子</li>
        <li>诱导分享、诱导下载、伪装成站内功能的素材（角标必须写「广告」）</li>
        <li>和独立开发者人群明显无关的推广——硬投也是浪费你的预算</li>
      </ul>
      <p>素材审核只看两条：真实、不骗人。改稿不额外收费。</p>
    </div>

    <section class="adv-final">
      <h2>这周还有档期</h2>
      <p>位置按周排，先到先上。把要推的东西告我一句，今天就能给你留位。</p>
      <div class="adv-cta-row">
        <button type="button" class="btn-primary adv-btn" data-fb="广告投放" data-fb-title="广告投放咨询" data-fb-hint="${fbHint}">留个联系方式</button>
        <a class="btn-ghost adv-btn" href="/">先逛逛橱窗</a>
      </div>
    </section>
  </div>`;
    // 整页 SSR：内容必须落在 <main> 直属的 SEO_BODY（第二个参数），
    // 落到第三个参数会塞进 #homeView 内的首页栏目里，跟首页卡片叠在一起——
    // 老版 /ads 就是这个毛病（先看到一整屏首页，才看到投放合作）。
    sendHtml(res, shell(headHtml, block));
  });
}
