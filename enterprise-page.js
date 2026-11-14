// ---------- 企业产品入驻（/enterprise）：不谈钱、只看产品的入驻邀请页（服务端整页渲染） ----------
// 2026-11-12 站长口径：企业不一定非得是来买广告的，有真产品也该有一扇门，而且这扇门不该是价目表。
// 所以这一页和 /ads 是两条独立的路：
//   · /ads        = 收钱的广告位（标「广告」、按周起投、有刊例）
//   · /enterprise = 不收钱的入驻（标「企业合作」、看产品、不承诺位置和曝光）
// 三条自我约束（改这一页别破）：
//   1. 不写价格、不写"套餐"、不写"加急"——一写就变回刊例页，这页的存在意义就没了；
//   2. 不承诺位置和曝光：只说「合适就安排」，不是流量采买；
//   3. 说清代价：外链 nofollow、不冒充站内精选、页面上标「企业合作」。
// 留资复用站内反馈通道（data-fb，游客可提交、能留联系方式），不新做表单、不存第二条数据。
'use strict';

module.exports = { register };

function register(deps) {
  const { app, seo, shell, sendHtml, visibleWorks, authorEntries } = deps;

  // 入口按钮的留资话术：写清「写什么」，比写「快来联系」有用
  const fbHint = '写清四件事就够了：产品是什么、给谁用、官网或下载地址、有没有免费额度或试用。'
    + '留一个能联系上的微信或邮箱，一周内回你；不合适也会说一句为什么。';

  app.get('/enterprise', (req, res) => {
    const base = seo.baseUrl(req);
    const worksCount = typeof visibleWorks === 'function' ? visibleWorks().length : 0;
    const authorCount = typeof authorEntries === 'function' ? authorEntries().length : 0;
    // 2026-11-12 晚站长改口径：数量直接展示实数，不再做「x00+」模糊取整（原口径作废）

    const headHtml = seo.head({
      title: `企业产品入驻 - 只看产品 - ${seo.SITE_NAME}`,
      description: seo.truncate(
        '造梦橱窗的企业入驻通道：不收费，只看产品本身。'
        + '产品交过来我们真用一遍，合适就排一页品牌橱窗，不合适直说。'
        + '站里现在有 ' + worksCount + ' 件个人创作者的作品。', 150),
      keywords: '企业产品入驻,品牌橱窗,独立开发者社区,产品合作,造梦橱窗',
      canonical: base + '/enterprise',
      type: 'website',
      jsonLd: [
        seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '企业产品入驻' }]),
        {
          '@context': 'https://schema.org', '@type': 'WebPage',
          name: '企业产品入驻', url: base + '/enterprise',
          description: '不收费、只看产品的企业入驻通道：交产品，我们真用一遍，合适就做一页品牌橱窗。',
        },
      ],
    });

    const ctaBtn = (label, extra) => `<button type="button" class="btn-primary ent-btn" data-fb="企业入驻"
      data-fb-title="企业产品入驻申请" data-fb-hint="${seo.esc(fbHint)}">${label}</button>${extra || ''}`;

    const block = `<div id="seoContent" class="seo-wrap ent-page">
    ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '企业产品入驻' }])}

    <section class="ent-hero">
      <span class="ent-eyebrow">企业产品入驻 · 长期开放</span>
      <h1>只要产品够硬，<br /><em>尽管提交</em></h1>
      <p class="ent-sub">这里是个人创作者的橱窗，也留了几格给认真做产品的团队。
      如果你做出了真有人用的东西，只是还没什么人知道——发过来，我们看看。
      入驻<b>不收费</b>，能不能上，只看产品本身。</p>
      <div class="ent-cta-row">
        ${ctaBtn('提交产品')}
        <a class="btn-ghost ent-btn-ghost" href="/">先看看站里都收了什么</a>
      </div>
      <p class="ent-chips"><span>不收费</span><span>只看产品本身</span><span>一周内有回音</span><span>不合适直说</span></p>
    </section>

    <p class="ent-fact">站里现在有 <b>${worksCount}</b> 件作品、<b>${authorCount}</b> 位做过东西的人。
    他们来这儿是找工具、找灵感、找同行的——不是刷信息流的。</p>

    <section class="ent-sec">
      <div class="ent-sec-head">
        <h2>什么样的产品，我们会请进来</h2>
        <p>四条不用全占，但至少要占三条。判断标准很土：我们自己会不会用。</p>
      </div>
      <div class="ent-cards">
        <div class="ent-card"><h3>自己做的，不是贴牌</h3><p>团队自己写代码、自己做设计。换皮套壳、白牌代工、拿模板拼出来的站，不算。</p></div>
        <div class="ent-card"><h3>有人在维护</h3><p>有更新记录、有文档、有人回消息。上一个版本停在两年前的，先别来。</p></div>
        <div class="ent-card"><h3>对个人用户友好</h3><p>能免费用、有免费额度，或者价格写得清清楚楚。不搞「联系销售才知道多少钱」。</p></div>
        <div class="ent-card"><h3>愿意给社区一点实在的</h3><p>试用码、折扣、开放文档、开源组件，什么都好。不给也能谈，但给了更容易被记住。</p></div>
      </div>
    </section>

    <section class="ent-sec">
      <div class="ent-sec-head">
        <h2>这几种，先别来</h2>
        <p>省得双方白花时间。下面这些不是「审核不过」，是根本不在这一页的射程里。</p>
      </div>
      <ul class="ent-no">
        <li><b>纯导流的落地页、聚合站、返利站</b><span>产品不是自己的，来了也只是多一个入口。</span></li>
        <li><b>想买一条能传权重的外链</b><span>这里的外链一律 nofollow，不做 SEO 资源，多少钱都不做。</span></li>
        <li><b>灰产、贷款导流、夸大宣传</b><span>「稳赚不赔」「三天见效」这类，一句都不行。</span></li>
        <li><b>只想要一个 logo 挂在首页</b><span>内容全丢给站方写的，做不出能读的一页，也就不必占这个位置。</span></li>
      </ul>
    </section>

    <section class="ent-sec">
      <div class="ent-sec-head">
        <h2>进来之后，你拿到什么</h2>
        <p>只有三样，但都是真的。多的一句不承诺。</p>
      </div>
      <div class="ent-cards is-three">
        <div class="ent-card">
          <h3>一页品牌橱窗</h3>
          <p>网址是 <b>/brand/你的产品名</b>：产品故事、三句卖点、几张截图、适合谁用。
          内容你确认，排版我们做，不收任何费用。</p>
        </div>
        <div class="ent-card">
          <h3>站内一个自然的入口</h3>
          <p>          合适的展示位会安排（首页、榜单、详情位看当期情况）。
          <b>不承诺固定位置，也不承诺曝光量</b>——这里的门是靠产品打开的，不靠预算。</p>
        </div>
        <div class="ent-card">
          <h3>真实用户的第一反应</h3>
          <p>站里的人会点开、会试用、会挑刺。比一份投放报告更直接：
          他们要么留下，要么说清楚为什么不用。</p>
        </div>
      </div>
      <p class="ent-note">所有企业合作内容都会在页面上标注<b>「企业合作」</b>：不冒充站内精选，
      不参与编辑推荐，也不影响站里的作品排序。想让人信任，靠写清楚自己是谁，不靠把标识藏起来。</p>
    </section>

    <section class="ent-sec">
      <div class="ent-sec-head">
        <h2>怎么进来</h2>
        <p>三步，不用先准备一堆材料。</p>
      </div>
      <ol class="ent-steps">
        <li><b>1</b><div><h3>发一段话</h3><p>写清产品是什么、给谁用、官网或下载地址、有没有免费额度，留个微信或邮箱。
        点下面的按钮，走站内反馈通道，游客也能提交。</p></div></li>
        <li><b>2</b><div><h3>我们自己用一遍</h3><p>一到两周，装在自己机器上真用，不看你给的 PPT。
        合适就排期；不合适会直说，不吊着。</p></div></li>
        <li><b>3</b><div><h3>排期上线</h3><p>页面内容你先过一遍再发。之后想改文案、换截图，随时说，不另收费。</p></div></li>
      </ol>
      <div class="ent-cta-row">
        ${ctaBtn('提交产品')}
        <span class="ent-cta-hint">一封邮件的信息量就够，不用做材料。</span>
      </div>
    </section>

    <section class="ent-sec">
      <div class="ent-sec-head"><h2>你可能想问</h2></div>
      <div class="ent-faq">
        <details><summary>真的不收钱？</summary>
          <p>真的。这一页不会出现任何价格。之后如果你想买站内广告位，那是另一件事，
          写在 <a href="/ads">投放合作</a> 那页，和入驻互不绑定——不买广告也照样能入驻。</p></details>
        <details><summary>能给 dofollow 外链吗？</summary>
          <p>不能。所有站外链接都是 <code>rel="nofollow sponsored"</code>，不传权重。
          指望拿这一页做 SEO 的，别浪费时间，我们也不想把站做成一个卖链接的地方。</p></details>
        <details><summary>能保证多少曝光？</summary>
          <p>不能，也不承诺。位置按当期情况排，产品合适就上，排满了就等下一期。
          谁跟你说能保底多少 PV，都是在卖数字，不是在帮你做产品。</p></details>
        <details><summary>多久有回复？</summary>
          <p>一周内。没通过也会说一句为什么——通常就一句话：产品不对路，或者内容对不上。</p></details>
        <details><summary>已经在投广告的，还能入驻吗？</summary>
          <p>能，但两套账分得很清：广告位标「广告」、按周付费、有曝光数据；
          入驻页标「企业合作」、不收费、不进广告统计。两者不互相打折，也不互相绑定。</p></details>
      </div>
    </section>

    <section class="ent-final">
      <h2>把一个产品，讲成一页能读完的东西</h2>
      <p>不用做素材、不用写 Brief，把产品链接丢过来就行，剩下的我们自己看。</p>
      <div class="ent-cta-row">
        ${ctaBtn('提交产品')}
        <a class="btn-ghost ent-btn-ghost" href="/">先逛逛橱窗</a>
      </div>
    </section>

    <p class="ent-disclaimer">本站保留拒绝权：产品不合规、宣传不实，或和站内读者明显无关的，不会上。
    企业合作内容由品牌方提供、页面首屏标注「企业合作」，站方按当期展示，不代为背书。
    想直接买广告位（按周付费、标「广告」）的，看 <a href="/ads">投放合作</a>。</p>
  </div>`;

    // 整页 SSR：内容必须落在 <main> 直属的 SEO_BODY（第二个参数），
    // 落到第三个参数会塞进 #homeView 里，跟首页卡片叠在一起
    sendHtml(res, shell(headHtml, block));
  });
}
