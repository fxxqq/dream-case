// 造梦橱窗 - 前端逻辑
'use strict';

// ---------- 客户端形态上报 ----------
// 后台要看「最后活跃的端」，但服务端从 UA 只能分出微信内/手机/平板/电脑：
// 装到桌面的 PWA 用的是同一个浏览器 UA，display-mode 只有在页面里才知道。
// 做法：standalone 时落一个 dm_cli=pwa 的 cookie（一年），普通浏览器打开时顺手清掉。
// 用 cookie 而不是请求头，是因为它跟着每一个请求自动走 —— fetch / sendBeacon / XHR / 图片都不用管。
(function () {
  try {
    const standalone = (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches)) || window.navigator.standalone === true;
    const has = document.cookie.indexOf('dm_cli=') !== -1;
    if (standalone && !has) document.cookie = 'dm_cli=pwa; path=/; max-age=31536000; SameSite=Lax';
    // 浏览器里打开 → 之前装的 PWA 标记要清掉，否则卸载掉桌面图标后还会一直被算成 PWA
    else if (!standalone && has) document.cookie = 'dm_cli=; path=/; max-age=0; SameSite=Lax';
  } catch { /* 拿不到就退回按 UA 判断，不影响页面 */ }
})();

// 站点图标（统一在 /icons.js 里定义）：取不到就返回空串，不影响页面其他内容
const ic = (name, size) => (window.Icons ? Icons.icon(name, size) : '');

// 图片地址：本站上传的图走 /t/<宽>/<文件名>（服务端按需转 webp 并缓存），
// 站外图片（广告位、外链封面）原样返回。卡片只给 400 档，详情页才给 1200。
function imgUrl(u, width) {
  u = String(u || '');
  if (u.indexOf('/uploads/') !== 0) return u;
  return '/t/' + width + '/' + u.slice('/uploads/'.length);
}
// 响应式候选：手机 45vw / 平板 30vw / 桌面 260px 左右
function imgSet(u) {
  return `${imgUrl(u, 400)} 400w, ${imgUrl(u, 800)} 800w`;
}

// GitHub 优质原创作者勋章：star 达标 + 归属已验证 → 服务端提报，站长在后台「用户 → 标签」里确认后才有
// （见 server.js 的 applyGithubBadge 与 /api/admin/users/tags）。卡片 / 列表空间小，只挂一个金色小奖章；详情页和作者主页用文字胶囊（.author-tag.gh）。
const GH_BADGE_TAG = 'GitHub 优质原创作者';
const GH_MEDAL =
  '<svg viewBox="0 0 20 20" aria-hidden="true">' +
  '<circle cx="10" cy="9" r="6.2" fill="#e2a63c"/>' +
  '<path d="M10 5.2l1.15 2.33 2.57.37-1.86 1.81.44 2.56L10 11.06 7.7 12.27l.44-2.56-1.86-1.81 2.57-.37z" fill="#fff"/>' +
  '<path d="M7.1 14.2l-1.05 3.5 3.95-1.75 3.95 1.75-1.05-3.5" fill="#c8881d"/>' +
  '</svg>';
const hasGhBadge = tags => Array.isArray(tags) && tags.includes(GH_BADGE_TAG);
const ghMedalHtml = tags => (hasGhBadge(tags) ? `<i class="gh-medal" title="${GH_BADGE_TAG}">${GH_MEDAL}</i>` : '');

let CATEGORIES = ['全部'];
let SCENES = [];   // 场景（上班干活/学习充电/过日子…）：{ key, name, desc, count }，来自 /api/scene-meta，只含已配置且有作品的
let typeCounts = {}, catCounts = {}, totalWorks = 0; let osCounts = { open: 0, closed: 0 }; // 筛选下拉选项的计数
let TYPES = ['全部', 'Web', 'iOS', 'Android', 'macOS', 'Windows', 'Linux', '小程序', '浏览器插件', '机器人', 'API'];
let renderCatPickerFn = null; // 投稿表单的分类胶囊渲染（loadCategories 后刷新）
const MAX_CATS = 3;           // 应用分类最多可选个数

// ---------- 排序记忆（dm_sort） ----------
// 用户亲手点过「随便逛逛 / 最新 / 最热」，就记在本机，下次打开首页还是这个排序；
// 口径跟卡片/列表（dm_view）、每行 4/5/6 列（dm_cols）一致：记浏览器，换设备不跟随。
// 只记「亲手点的」——搜索 / 筛选 / 收藏 / 投稿完成后程序自动切到「最新」（wanderBreakoutLatest、
// 投稿成功跳列表）属于一次性跳转，不写这条记忆，否则用户只是搜过一次，习惯就被永久改掉了。
const SORT_KEY = 'dm_sort';
const SORT_VALUES = ['wander', 'latest', 'hot'];
function readSavedSort() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORT_VALUES.includes(v) ? v : 'wander';   // 没记过 / 记的值不认识 → 默认随便逛逛
  } catch { return 'wander'; }                        // 隐私模式读不到 localStorage：回默认
}
function saveSort(v) {
  if (!SORT_VALUES.includes(v)) return;               // 只认这三个值，别的写进来一律忽略
  try { localStorage.setItem(SORT_KEY, v); } catch { /* 隐私模式存不了，本次会话内照样生效 */ }
}
// PC 排序按钮的点亮态跟着 state.sort：index.html 里不写死 active（写死「随便逛逛」的话，
// 记着最新/最热的用户会先看到错的按钮亮一下），首屏由下面的 try 立刻点亮
function syncSortToggle() {
  document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === state.sort));
}

const state = {
  sort: readSavedSort(),   // 默认随便逛逛：分层随机推荐（docs/discover-spec-v1.md）；点过最新/最热则按记忆来
  type: '全部',
  category: '全部',
  scene: '全部',      // 场景筛选：全部 / work / study / life / create / relax / family（key 由 /api/scene-meta 下发）
  openSource: '全部', // 是否开源筛选：全部 / 开源 / 闭源（后端 os=open|closed，可见性不受影响）
  range: '全部',      // 发布时间筛选：全部 / 近3天 / 近7天 / 近30天
  q: '',
  page: 1,
  hasMore: false,
  currentWork: null,
  commentKind: 'comment', // 发言类型：comment 评论 / question 提问
  replyTo: null,          // 正在回复的评论：{ rootId, targetId }
  tools: [],
  user: null,
  providers: {}, // 可用的第三方登录：{ github: true }（服务端没配 GitHub 应用时为 false）
  favs: [], // 当前登录用户收藏的作品 id（服务端存储，按收藏时间倒序）
  blocked: [], // 当前登录用户屏蔽过的作品 id（服务端存储，同步过来用于展示数量）
  blockedUsers: [], // 当前登录用户拉黑的作者用户名（TA 的所有作品都不再展示给我）
  myClaims: [], // 我的作品认领申请 [{ workId, status }]
  pendingClaim: '', // 匿名投稿者点「存到我名下」带来的投稿凭据，登录/注册成功后自动认领
  myFeedback: [], // 我提过的意见反馈（含与站长的往来），来自 /api/me/feedback 与 /api/feedback/mine
  // 展示方式：card 卡片网格 / list 一行一个的紧凑列表（记住用户的选择）
  // 2026-11-07：手机端默认「列表」，与小程序首页一致；PC 仍默认卡片。
  // 用户手动切过的以本机记录为准，改默认值不覆盖老用户的选择。
  view: (() => {
    const saved = localStorage.getItem('dm_view');
    if (saved === 'card' || saved === 'list') return saved;
    return window.matchMedia('(max-width: 640px)').matches ? 'list' : 'card';
  })(),
  // 卡片网格每行几个：4 / 5 / 6（记住用户的选择，窄屏自动回落到响应式列数）
  cols: [4, 5, 6].includes(Number(localStorage.getItem('dm_cols'))) ? Number(localStorage.getItem('dm_cols')) : 5
};

// app.js 在 body 末尾同步加载，这里 DOM 已经齐了：先按记忆的排序点亮排序按钮，
// 不等 route()/setupHeader()（中间还要 await 登录态），否则刷新时「随便逛逛」会先亮一下再跳走。
try { syncSortToggle(); } catch { /* 排序按钮不在本页 DOM 上就算了，不影响首屏 */ }

// 从作品详情弹窗退回列表页时置为 true：列表 DOM 仍然完整，route() 不要重新拉取，
// 否则已加载的分页会丢失、「展示更多」按钮重新出现，看起来像整页刷新
let skipNextListReload = false;
// 详情回退导航的防重入标记：连点 ✕ 时不能把 history.back() 打两份，否则会多退一页
let detailLeaving = false;

const $ = id => document.getElementById(id);
const gallery = $('gallery');
// 卡片网格列数：4 / 5 / 6 由用户选（存本机），窄屏由 CSS 回落到响应式列数
function applyGalleryCols() {
  if (!gallery) return;
  gallery.classList.toggle('cols-4', state.cols === 4);
  gallery.classList.toggle('cols-5', state.cols === 5);
  gallery.classList.toggle('cols-6', state.cols === 6);
}
// 一页加载「4 行」：每行几列取当前真实栅格（桌面按用户选的 4/5，窄屏按 CSS 自适应回落），
// 这样首屏正好铺满 4 行，不会出现加载完还剩半行、或者一屏全是骨架的情况。
// 列数变化（切 4/5 列、窗口跨断点）必须从第 1 页重新拉，否则分页偏移会重复/漏项。
const ROWS_PER_PAGE = 4;
function galleryCols() {
  if (state.view === 'list') return 1;           // 列表模式一行一条，按固定条数更自然
  if (!gallery) return state.cols;
  const tpl = (getComputedStyle(gallery).gridTemplateColumns || '').trim();
  const n = tpl ? tpl.split(/\s+/).filter(Boolean).length : 0;
  return n >= 1 && n <= 6 ? n : state.cols;
}
function pageSizeOf(page = state.page) {
  if (state.view === 'list') return ROWS_PER_PAGE * 5;   // 列表模式一屏 20 条
  const base = galleryCols() * ROWS_PER_PAGE;            // 4 列 16 条 / 5 列 20 条
  // 首格宣传卡也占一格：第 1 页少拉一件，首屏才是整 4 行（否则 16+1=17 卡会多出一条尾巴）；
  // 「加载更多」的后续页没有宣传卡，按整页条数拉，保证网格继续对齐
  const promoCell = page === 1 && listPromoAd() ? 1 : 0;
  return Math.max(1, base - promoCell);
}
const detailModal = $('detailModal');
const uploadModal = $('uploadModal');
const submitChoiceModal = $('submitChoiceModal');
const reportModal = $('reportModal');
const blockedModal = $('blockedModal');
const blockWorkModal = $('blockWorkModal');
const statsModal = $('statsModal');
const nickModal = $('nickModal');
const slugModal = $('slugModal');
const toast = $('toast');

const TYPE_ICONS = { 'Web': '🌐', 'iOS': '🍎', 'Android': '🤖', 'macOS': '💻', 'Windows': '🪟', 'Linux': '🐧', '小程序': '📱', '浏览器插件': '🧩', '机器人': '🦾', 'API': '🔌' };
// 形态的 SVG 图标（icons.js）：UI 控件（下拉/角标/表单胶囊）优先用它；
// 没映射的形态回退 emoji；纯文本场景（typeText，会被 escapeHtml）始终用 emoji
const TYPE_SVG = {
  'Web': 'web', 'iOS': 'ios', 'Android': 'android', 'macOS': 'mac', 'Windows': 'win',
  'Linux': 'linux', '小程序': 'mini', '浏览器插件': 'ext', '机器人': 'robot', 'API': 'api'
};
function typeIcoHtml(t) {
  const k = TYPE_SVG[t];
  return `<span class="ico tico">${ic(k || 'other')}</span>`;
}

// ---------- 弹窗滚动锁定 ----------
// 锁定背景滚动，但用 padding-right 补偿滚动条宽度，
// 这样打开弹窗时滚动条占位不消失、页面不跳动。
let scrollLockCount = 0;
let scrollLockY = 0;
function lockScroll() {
  if (++scrollLockCount > 1) return;
  scrollLockY = window.scrollY;
  // html 上有 scrollbar-gutter: stable 时，滚动条隐藏后槽位仍然保留，内容宽度不变，
  // 不需要再补 padding-right（补了反而会让居中内容左移一个槽位宽）
  const hasGutter = window.CSS && CSS.supports && CSS.supports('scrollbar-gutter', 'stable');
  const gap = hasGutter ? 0 : (window.innerWidth - document.documentElement.clientWidth);
  document.body.classList.add('scroll-locked');
  if (gap > 0) document.body.style.paddingRight = gap + 'px';
}
function unlockScroll() {
  if (!scrollLockCount) return;
  if (--scrollLockCount) return;
  document.body.classList.remove('scroll-locked');
  document.body.style.paddingRight = '';
  window.scrollTo(0, scrollLockY);
}
function showModal(el) {
  const wasOpen = el.style.display === 'flex';
  el.style.display = 'flex';
  if (!wasOpen) lockScroll(); // 已开着就不重复计数，避免解锁失衡
}
function hideModal(el) {
  if (el.style.display === 'none') return;
  el.style.display = 'none';
  unlockScroll();
}
// 点遮罩关闭弹窗：必须「按下的位置在遮罩上 + 点击落在遮罩上 + 全程位移不超过 12px」才算数。
// 原来直接挂在 click 上，手机在遮罩上滑动、滚动、拖一下再松手，浏览器都会合成一次 click，窗口就没了
// ——这是站里误触的主要来源。改成记录按下点、在 click 时比对全程位移后，只有真正在原地轻点才关。
// 用 click 收尾（而不是 pointerup）是因为鼠标按下稍有位移时浏览器会发 pointercancel 取消序列，
// 若靠 pointerup 判定会把「手抖的正常点击」也吞掉。
const MASK_CLOSE_SLOP = 12;
function bindMaskClose(el, onClose) {
  if (!el || el.dataset.maskCloseBound) return;
  el.dataset.maskCloseBound = '1';
  // 极老浏览器没有 PointerEvent：退回纯 click（行为等同改造前，至少不会关不掉）
  if (!window.PointerEvent) {
    el.addEventListener('click', e => { if (e.target === el) onClose(e); });
    return;
  }
  let downX = 0, downY = 0, dist = 0, downOnMask = false;
  el.addEventListener('pointerdown', e => {
    // 只认主指针：双指缩放的第二根手指不参与判定；按在弹窗内容里的也不算
    downOnMask = e.isPrimary !== false && e.target === el;
    dist = 0;
    downX = e.clientX;
    downY = e.clientY;
  });
  el.addEventListener('pointermove', e => {
    if (!downOnMask) return;
    // 记最大偏移：来回滑动也算动过，不能因为起止点重合就判成点击
    dist = Math.max(dist, Math.hypot(e.clientX - downX, e.clientY - downY));
  });
  el.addEventListener('click', e => {
    const armed = downOnMask;
    downOnMask = false;                   // 一次按下只消费一次
    if (!armed || e.target !== el) return; // 在弹窗里按下、松手落到遮罩上，算拖拽不算点遮罩
    if (dist > MASK_CLOSE_SLOP) return;    // 滑过了，是误触
    onClose(e);
  });
}
// 移动端形态：宣传图按手机竖屏比例展示与压缩；其余按 PC 宽幅
const MOBILE_TYPES = ['小程序', 'iOS', 'Android'];
const LINK_LABEL = {
  'Web': '🌐 打开网站', 'iOS': '🍎 App Store', 'Android': '🤖 Android 版',
  'macOS': '💻 Mac 版', 'Windows': '🪟 Windows 版', 'Linux': '🐧 Linux 版',
  '小程序': '📱 微信扫码打开', '浏览器插件': '🧩 前往安装', '机器人': '🦾 体验机器人', 'API': '🔌 查看文档'
};
// 收费形式（标注「需要付费」时可选）→ 中文标签
const PAID_MODELS = { freemium: '部分免费', member: '会员专享', onetime: '单篇购买', subscription: '订阅制', buyout: '一次买断', trial: '试用后付费', lamp: '灯火解锁' };
// 灯火解锁不是「付费墙」：作品本身不标价，所以 paid 标记为 false，单独看 paidModel
// （送灯火 donation 2026-11-07 下线：打赏是全站通用能力，不再作为作品标注）
const NON_PAID_MODELS = ['lamp'];
// 各形态的访问方式规则：Web → 链接必填；其他形态链接选填；小程序 → 二维码必填
const TYPE_LINK_FIELD = {
  'Web':   { link: true,  qr: false, label: '网站地址 *',   ph: 'https://你的网站地址' },
  '小程序': { link: false, qr: true },
  'iOS':   { link: false, qr: false, label: '下载链接（选填）', ph: 'https://App Store / 下载页链接' },
  'Android': { link: false, qr: false, label: '下载链接（选填）', ph: 'https://下载页 / 应用商店链接' },
  'macOS': { link: false, qr: false, label: '下载链接（选填）', ph: 'https://官网下载页 / 安装包链接' },
  'Windows': { link: false, qr: false, label: '下载链接（选填）', ph: 'https://官网下载页 / 安装包链接' },
  'Linux': { link: false, qr: false, label: '下载链接（选填）', ph: 'https://官网下载页 / 安装包链接' },
  '浏览器插件': { link: false, qr: false, label: '安装链接（选填）', ph: 'https://Chrome / Edge 商店链接' },
  '机器人': { link: false, qr: false, label: '体验链接（选填）', ph: 'https://机器人对话页链接' },
  'API':   { link: false, qr: false, label: '文档链接（选填）', ph: 'https://API 文档地址' }
};
// 链接必填的形态：只有 Web
const LINK_REQUIRED_TYPES = ['Web'];

// 源码仓库白名单：开源标注是站方的门面，仓库地址必须落在真实的代码托管站上（与 server.js 的
// REPO_HOSTS 保持一致；服务端才是最终关口，这里只负责点提交前立刻告诉用户）
const REPO_HOSTS = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'sourceforge.net', 'codeberg.org', 'git.sr.ht', 'huggingface.co',
  'gitee.com', 'gitcode.com', 'atomgit.com', 'codeup.aliyun.com', 'coding.net', 'gitlink.org.cn'
];
const REPO_HINT_OK = '只收国内外开源代码托管站的仓库页面：GitHub、Gitee、GitLab、Bitbucket、GitCode、AtomGit、Codeberg、SourceForge、CODING、阿里云效等。';
const REPO_HINT_BAD = '这个站点不在名单里：请填 GitHub / Gitee / GitLab / Bitbucket / GitCode / AtomGit 等开源代码托管站的仓库页；自建 GitLab 请联系站长人工核验。';
const REPO_HINT_LEGACY = '这是原来填的仓库地址（不在开源托管站名单内）。不改就保持原样；要改请换成 GitHub、Gitee 等开源代码托管站的仓库页。';
// 允许子域名（gist.github.com / codeup.aliyun.com），"github.com.xx.com" 这种冒充的不算
function repoHostOk(v) {
  const s = String(v || '').trim();
  if (!s) return true;                     // 空值交给「必填」校验，不在这里报错
  let host = '';
  try {
    host = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return false; }
  return REPO_HOSTS.some(base => host === base || host.endsWith('.' + base));
}
// 老数据原样保存放行：否则改个标题都过不了校验
function repoValueOk(v) {
  const s = String(v || '').trim();
  return !s || s === repoBaseline || repoHostOk(s);
}

// 作品形态可多选：types 数组为主，兼容旧的单值 type
function typesOf(w) {
  if (Array.isArray(w.types) && w.types.length) return w.types;
  return [w.type || 'Web'];
}
function typeText(w) {
  return typesOf(w).map(t => escapeHtml(t)).join(' · ');
}
// 同 typeText，但已映射 SVG 的形态内联成图标（卡片封面上的深色胶囊用，放不进纯文本上下文）
function typeTextHtml(w) {
  return typesOf(w).map(t => {
    const k = TYPE_SVG[t];
    return `<span class="ico tico">${ic(k || 'other')}</span> ${escapeHtml(t)}`;
  }).join(' · ');
}
function linkLabelOf(types) {
  for (const t of types) if (LINK_LABEL[t]) return LINK_LABEL[t].replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '');
  return '访问作品';
}
// 每个形态对应的访问按钮图标（按钮里用 SVG，不用 emoji）
const LINK_ICON = {
  'Web': 'web', 'iOS': 'ios', 'Android': 'android', 'macOS': 'mac', 'Windows': 'win',
  'Linux': 'linux', '小程序': 'mini', '浏览器插件': 'ext', '机器人': 'robot', 'API': 'api'
};
// ---------- 按形态的多个链接（多平台应用：iOS/Android/macOS… 各填各的） ----------
function linkConfOf(t) {
  return TYPE_LINK_FIELD[t] || { label: '作品链接（选填）', ph: 'https://...' };
}
// 读取表单里所有按形态的链接输入框 → { 类型: 地址 }
function collectLinkValues(root) {
  const out = {};
  (root || document.getElementById('uploadForm')).querySelectorAll('input[data-ltype]').forEach(i => {
    const v = i.value.trim();
    if (v) out[i.dataset.ltype] = v;
  });
  return out;
}
// 草稿/编辑回填时先暂存，applyTypeFields 渲染链接输入框时消费
let pendingLinkValues = null;
function renderLinkInputs(types, values) {
  const box = $('linkInputs');
  if (!box) return;
  const prev = values || pendingLinkValues || collectLinkValues();
  pendingLinkValues = null;
  const nonMini = types.filter(t => t !== '小程序');
  if (!nonMini.length) { box.innerHTML = ''; return; }
  if (nonMini.length === 1) {
    const t = nonMini[0], c = linkConfOf(t);
    $('linkLabel').textContent = c.label;
    box.innerHTML = `<input type="text" name="link" data-ltype="${escapeHtml(t)}" maxlength="500"
      placeholder="${escapeHtml(c.ph)}" value="${escapeHtml(prev[t] || '')}" />`;
  } else {
    $('linkLabel').textContent = '各平台链接（选填，哪个平台有就填哪个）';
    box.innerHTML = nonMini.map(t => {
      const c = linkConfOf(t);
      return `<div class="lpt-row">
        <span class="lpt-name">${typeIcoHtml(t)} ${escapeHtml(t)}</span>
        <input type="text" name="link_${escapeHtml(t)}" data-ltype="${escapeHtml(t)}" maxlength="500"
          placeholder="${escapeHtml(c.ph.replace(' *', ''))}" value="${escapeHtml(prev[t] || '')}" />
      </div>`;
    }).join('');
  }
  // 只有 Web 的地址必填（表单 novalidate，配合提交时的中文校验提示）
  const web = box.querySelector('input[data-ltype="Web"]');
  if (web) web.required = true;
}
// 多形态合并规则：含小程序 → 需要二维码；含网站 → 链接必填；其他形态链接选填
function ruleOfTypes(types) {
  const qr = types.indexOf('小程序') !== -1;
  const link = types.indexOf('Web') !== -1;
  // 除纯小程序外都展示链接框（后台新增的自定义形态同样支持填链接）
  const other = types.filter(t => t !== '小程序');
  const hasLinkField = other.length > 0;
  const t = other.find(x => TYPE_LINK_FIELD[x]) || other[0];
  const base = (t && TYPE_LINK_FIELD[t]) || { link: false, qr: false, label: '作品链接（选填）', ph: 'https://...' };
  return { link, qr, hasLinkField, label: base.label, ph: base.ph };
}
function isMobileTypes(types) { return types.some(t => MOBILE_TYPES.indexOf(t) !== -1); }

// ---------- 基础工具 ----------
// action（可选）：{ label, onClick } —— 在 toast 右侧挂一个按钮，用于「撤销」这类可回退操作。
// 挂了按钮的 toast 停留时间拉长到 6 秒，否则手还没移到按钮上提示就没了。
function showToast(msg, ms, type, action) {   // type: 'ok' 绿勾 | 'err' 红叹号 | 不传 = 纯文字
  toast.innerHTML = '';
  if (type === 'ok' || type === 'err') {
    const ic = document.createElement('span');
    ic.className = 'toast-ic ' + type;
    ic.textContent = type === 'ok' ? '✓' : '!';
    toast.appendChild(ic);
  }
  const span = document.createElement('span');
  span.textContent = msg;
  toast.appendChild(span);
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.onclick = e => {
      e.stopPropagation();
      toast.classList.remove('show');
      try { action.onClick(); } catch { /* 撤销失败由调用方自己提示 */ }
    };
    toast.appendChild(btn);
  }
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), ms || (action ? 6000 : 2400));
}
// 展示名：作品带 authorName（服务端按账号查昵称），评论带 displayName；
// 账号（author/username）只用于链接和身份判定，界面上尽量不直接露出来
const dname = w => (w && (w.authorName || w.author)) || '';
// 作品作者行的展示文本：匿名发布的作品不带 @ 前缀，只显示「匿名」
const aname = w => (w && w.anonymous ? '匿名' : '@' + dname(w));
// 带「头像圆点」一起出现时的作者名：@ 前缀省掉，避免「创 @创客77」这种重复感
const anamePlain = w => (w && w.anonymous ? '匿名' : dname(w));
const cname = c => (c && (c.displayName || c.username)) || '';

// ---------- 兜底头像着色 ----------
// 没有真实头像时按稳定 key 生成固定底色：同人永远同色，不同人颜色不同。
// key 优先用账号名（唯一且不随改名变化），显示名只在没有账号信息时兜底；
// 匿名楼层不走这里，保持灰底。
function avaColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 62%, 48%)`;
}
// ---------- 头像节点 ----------
// 只认站内 /uploads/av-*：第三方链接一律不渲染（防盗链、追踪像素、挂马图都挡在外面）。
// 服务端已经存成 256 见方的 webp，前端不用再挑尺寸。
const AVA_RE = /^\/uploads\/av-[A-Za-z0-9_-]+\.webp$/;
function safeAvatarUrl(u) { return typeof u === 'string' && AVA_RE.test(u) ? u : ''; }

// 字母块打底，有图就盖一层 <img>，图挂了由 onerror 自己摘掉 —— 底下的字母和底色自然露出来。
// 不用 JS 记「这张图加载失败过」：URL 会变（换头像/删图），记状态反而会记错。
function avaHtml(name, avatar, cls, noColor, colorKey) {
  const text = escapeHtml((name || '?').slice(0, 1).toUpperCase());
  const key = colorKey || name;
  const bg = noColor ? '' : (key ? `background:${avaColor('u:' + key)};color:#fff` : '');
  const url = safeAvatarUrl(avatar);
  const img = url
    ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="${cls}"${bg ? ` style="${bg}"` : ''}>${text}${img}</span>`;
}

// 已经渲染好的头像容器（作者页 / 我的页那种固定节点）走这里重刷内容
function paintAvatar(el, name, avatar) {
  if (!el) return;
  el.style.background = name ? avaColor('u:' + name) : '';
  el.style.color = '#fff';
  el.innerHTML = escapeHtml((name || '?').slice(0, 1).toUpperCase())
    + (safeAvatarUrl(avatar)
      ? `<img src="${escapeHtml(safeAvatarUrl(avatar))}" alt="" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function formatDate(iso) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 3600e3) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  if (diff < 86400e3) return Math.round(diff / 3600e3) + ' 小时前';
  if (diff < 7 * 86400e3) return Math.round(diff / 86400e3) + ' 天前';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 收藏（需登录，存服务端 user.favs，跨设备同步） ----------
// 页面上所有展示收藏数的地方都带 data-fav-count=作品id，改一处即可全局同步
function paintFavCount(id, n) {
  const val = Math.max(0, parseInt(n, 10) || 0);
  document.querySelectorAll(`[data-fav-count="${CSS.escape(String(id))}"]`).forEach(el => {
    el.dataset.count = val;
    el.textContent = (el.dataset.prefix || '') + val;
  });
  // 计数归零时把整段藏起来（零值不展示的口径，见 cardStatsHtml）
  document.querySelectorAll(`[data-fav-seg="${CSS.escape(String(id))}"]`).forEach(el =>
    el.classList.toggle('is-zero', val === 0));
  if (state.currentWork && state.currentWork.id === id) state.currentWork.favs = val;
}
// 评论数同步（卡片/列表/详情共用，发评论或删评论后调用）
function paintCommentCount(id, n) {
  const val = Math.max(0, parseInt(n, 10) || 0);
  document.querySelectorAll(`[data-comment-count="${CSS.escape(String(id))}"]`).forEach(el => {
    el.dataset.count = val;
    el.textContent = (el.dataset.prefix || '') + val;
  });
  document.querySelectorAll(`[data-cmt-seg="${CSS.escape(String(id))}"]`).forEach(el =>
    el.classList.toggle('is-zero', val === 0));
  if (state.currentWork && state.currentWork.id === id) state.currentWork.commentCount = val;
}
function bumpFavCount(id, delta) {
  const el = document.querySelector(`[data-fav-count="${CSS.escape(String(id))}"]`);
  let base = 0;
  if (el) base = parseInt(el.dataset.count, 10) || 0;
  else if (state.currentWork && state.currentWork.id === id) base = state.currentWork.favs || 0;
  else return;
  paintFavCount(id, base + delta);
}
// 未登录时点收藏，记住是哪个作品，登录成功后自动补上
let pendingFavId = null;

function isFav(id) { return (state.favs || []).includes(id); }

// 返回 true=已收藏 / false=已取消 / null=未执行（未登录或失败）
async function toggleFav(id) {
  if (!state.user) {
    pendingFavId = id;
    openAuth('login');
    showToast('登录后才能收藏，收藏会跟着账号走');
    return null;
  }
  const added = !isFav(id);
  // 本机先生效，服务端返回真实总数后再校准
  if (added) state.favs.unshift(id);
  else state.favs = state.favs.filter(x => x !== id);
  bumpFavCount(id, added ? 1 : -1);
  try {
    const res = await fetch('/api/works/' + encodeURIComponent(id) + '/fav', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: added })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '收藏失败');
    if (typeof d.favs === 'number') paintFavCount(id, d.favs);
    // 在收藏页（/favs）里取消收藏：卡片当场摘掉，别让已取消的还挂在「我的收藏」里
    if (!added && location.pathname === '/favs') {
      document.querySelectorAll(`.card[data-id="${id}"], .work-row[data-id="${id}"]`).forEach(el => el.remove());
      const fg = $('favGallery'), fe = $('favEmpty');
      if (fg && !fg.children.length && fe) fe.style.display = 'block';
    }
    return added;
  } catch (err) {
    // 失败回滚，避免界面和服务端不一致
    if (added) state.favs = state.favs.filter(x => x !== id);
    else state.favs.unshift(id);
    bumpFavCount(id, added ? -1 : 1);
    showToast(err.message || '操作失败，请稍后再试', undefined, 'err');
    return null;
  }
}

// 详情页点赞按钮态：图标红底 + 文案「点赞 / 已赞」一起变。
// 点赞从 2026-11-08 起可取消，所以必须让用户看得出当前是已赞状态，否则第二下点了像没反应。
function paintLikeBtn(w, liked) {
  const btn = $('detailLike');
  if (!btn) return;
  btn.classList.toggle('liked', !!liked);
  const lb = $('detailLikeLabel');
  if (lb) lb.textContent = liked ? '已赞' : '点赞';
  btn.title = liked ? '再点一次取消点赞' : '给这件作品点个赞';
  btn.setAttribute('aria-label', liked ? '取消点赞' : '点赞');
  if (w) w.liked = !!liked;
}

// 详情「点赞」按钮上的数字：0 不显示（零值不展示的口径与卡片一致），
// 按钮宽度靠 min-width 稳住，数字出现/消失不会挤动旁边
function paintDetailLikes(n) {
  const el = $('detailLikes');
  if (!el) return;
  const v = Math.max(0, parseInt(n, 10) || 0);
  el.textContent = v;
  el.classList.toggle('is-zero', v === 0);
}

// 同步某个作品在页面上的所有 ★ 按钮状态
function paintFavButtons(id) {
  document.querySelectorAll(`[data-fav="${CSS.escape(String(id))}"]`).forEach(btn =>
    btn.classList.toggle('active', isFav(id)));
}
// 全量刷新已渲染的 ★（合并本机收藏、退出登录后用）
function repaintAllFavStars() {
  document.querySelectorAll('[data-fav]').forEach(btn =>
    btn.classList.toggle('active', isFav(btn.dataset.fav)));
}

// 把本机旧版（收藏不需要登录那会儿）的收藏并入当前账号，只补不删
async function mergeLocalFavs() {
  let local = [];
  try { local = JSON.parse(localStorage.getItem('favWorks') || '[]'); } catch { local = []; }
  if (!Array.isArray(local) || !local.length) return;
  try {
    const res = await fetch('/api/favs/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: local })
    });
    const d = await res.json();
    if (!res.ok) return; // 失败就留着旧数据，下次登录再补
    if (Array.isArray(d.favs)) state.favs = d.favs;
    localStorage.removeItem('favWorks');
    repaintAllFavStars();
    if (d.added) showToast(`已把本机 ${d.added} 个收藏同步到账号`, undefined, 'ok');
  } catch {}
}
function renderDetailFav(id) {
  const el = document.getElementById('detailFav');
  if (!el) return;
  const faved = isFav(id);
  el.classList.toggle('faved', faved);
  el.title = faved ? '已收藏，再点一次取消' : '收藏后可在「我的收藏」里找到';
  // 2026-11-13：按钮只剩「图标 + 数字」，文字收进 .sr-label（读屏 + 悬停提示）。
  // 数字节点必须原地改字，不能重绘 innerHTML——paintFavCount 靠 data-fav-count 定位它。
  const lb = el.querySelector('.sr-label');
  if (lb) { lb.textContent = faved ? '已收藏' : '收藏'; return; }
  el.innerHTML = `<span class="ico b-ico">${ic('fav')}</span> ${faved ? '已收藏' : '收藏'}`;
}

// ---------- 登录 / 注册 ----------
// 注册昵称预填：空着最差——不填的人会顶着随手拼的账号名上墙（账号名还可能像手机号）。
// 直接给一个带站点调性的名字（做小程序的老张 / 写代码的小李），不满意自己改或点「换一个」。
// 词库与 server.js 的老用户补名保持一致（同一套名字，新老用户风格统一）
// 组合数 = 45 个动作 × 65 个称呼 = 2925 种（原来 11×14=154 太少，几十人必撞名）。
// 前 11 个动作 / 前 14 个称呼是原始词库，别删别改顺序。
const NICK_ACTS = [
  // —— 原始词库（保留）——
  '做小程序', '做网站', '做 AI 应用', '做插件', '做游戏', '写代码', '做工具', '折腾 AI', '独立开发', '做产品', '做设计',
  // —— 扩充：端上 / 模型 / 数据 / 内容 / 增长 ——
  '做 App', '写前端', '写后端', '做自动化', '做机器人', '训练模型', '调模型', '玩提示词', '做副业', '做开源',
  '做笔记', '做效率工具', '做浏览器插件', '做小工具', '做数据看板', '做落地页', '做知识库', '做 Agent', '做工作流', '写脚本',
  '做爬虫', '做 SaaS', '做公众号', '做视频', '做内容', '做自媒体', '做增长', '做界面', '画原型', '做导航站',
  '做书签', '做翻译工具', '做问答机器人', '做语音应用'
];
const NICK_WHO = [
  // —— 原始词库（保留）——
  '老张', '小李', '小王', '老陈', '阿May', '小周', '阿灿', '小满', '阿吉', '大鹏', '阿星', '小鹿', '老白', '阿飞',
  // —— 扩充：老X / 小X / 阿X / 大X 四组 ——
  '老刘', '老李', '老王', '老赵', '老孙', '老徐', '老黄', '老吴', '老郑', '老马', '老范', '老许',
  '小陈', '小林', '小杨', '小黄', '小徐', '小郭', '小何', '小高', '小罗', '小郑', '小梁', '小宋', '小唐', '小冯', '小苏', '小丁',
  '阿杰', '阿伟', '阿涛', '阿锋', '阿亮', '阿龙', '阿明', '阿华', '阿坤', '阿诚', '阿哲', '阿宁', '阿原', '阿泽', '阿木', '阿海', '阿德', '阿俊', '阿峰',
  '大熊', '大伟', '大康', '大川'
];
let lastNick = '';
function randomNick() {
  // 起手把 n 设成上一次的值：保证至少进一次循环（否则第二次调用会原地返回空串）
  let n = lastNick;
  for (let i = 0; i < 20 && n === lastNick; i++) {
    const act = NICK_ACTS[(Math.random() * NICK_ACTS.length) | 0];
    const who = NICK_WHO[(Math.random() * NICK_WHO.length) | 0];
    // 「折腾 AI」这种英文字母收尾的，和「的」之间留个空格，不然挤成「AI的」
    n = act + (/[\w]$/.test(act) ? ' 的' : '的') + who;
  }
  lastNick = n;
  return n;
}
// force=false：只在输入框空着、或上次是自动填的时候换（别冲掉用户自己写的名字）
function fillRegNick(force) {
  const inp = $('regNick');
  if (!inp) return;
  if (!force && (inp.value.trim() && inp.dataset.auto !== '1')) return;
  const n = randomNick();
  if (!n) return;   // 兜底：摇不出名字就别把用户已经有的名字清掉
  inp.value = n;
  inp.dataset.auto = '1';
}

const authModal = document.getElementById('authModal');
let pendingPublish = false;
let editId = null; // 编辑模式下的作品 id
// 编辑时的原仓库地址：老数据的仓库可能不在白名单里，没改动就放行，别让人改个标题都保存不了
let repoBaseline = '';
let editWorkFn = null; // setupUploadForm 内部注入
// 「一眼看懂」折叠块的对外句柄：setupUploadForm 里注入实现，编辑器之外（重置/回填）也能用。
// 用空实现兜底，保证在任何调用顺序下都不会因为「还没初始化」而炸掉。
const qlUI = { setOpen: () => {}, paint: () => {} };
// 站长账号编辑任意作品：详情里「灯火解锁」作品的 link / 二维码是空的，直接拿它回填会把它们存丢。
// 点入口时单独要一份未锁定的编辑数据（?edit=1 只对站长账号生效），再交给同一套编辑器。
async function openAdminEdit(w) {
  if (!w) return;
  if (!editWorkFn) { showToast('编辑器还没准备好，刷新页面再试', undefined, 'err'); return; }
  try {
    const r = await fetch(`/api/works/${encodeURIComponent(w.id)}?edit=1`, { cache: 'no-store' });
    const full = await r.json().catch(() => ({}));
    if (!r.ok || full.error) { showToast(full.error || '作品加载失败，请重试', undefined, 'err'); return; }
    full.adminEdit = true;   // 服务端已带；这里再兜一层，防止中间层改写了标记
    editWorkFn(full);
  } catch {
    showToast('网络异常，请稍后再试', undefined, 'err');
  }
}
let resetUploadForm = () => {}; // setupUploadForm 内部注入（afterAuth 等外部也会调用）
let restoreUploadDraft = () => false; // 恢复本地草稿（闭包内注入）
let clearUploadDraft = () => {}; // 清除草稿（提交成功后调用）
let refreshDraftHint = () => {}; // 重新数一遍草稿份数（setupUploadForm 内部注入）

// ---------- 草稿角标：告诉用户「草稿箱里还有几份没提交」----------
// 之前草稿完全隐形（只有点「＋ 提交作品」才自动续填），用户根本不知道入口在哪。
// 角标挂在头部「＋ 提交作品」和手机「我的」页的「提交作品」格子上，达到 DRAFT_DOT_MIN 才显示。
// 只显示数字、不放「草稿」二字：头部按钮在 641–700px 会被 font-size:0 压成单个「＋」，
// 带文字的角标会跟着消失；绝对定位的小圆点在所有断点都不动布局。
// 只有 1 份时不挂角标：点进去本来就是续填它，没有「挑哪份」的问题，常驻一个「1」纯属催人
// （作者反馈：看着像永远清不掉的待办）。2 份以上才有得选，才值得提醒；表单顶部草稿条仍会说明在续填哪份。
const DRAFT_DOT_MIN = 2;
let draftHint = 0;   // 已知的草稿份数（缓存在内存里，「我的」页重渲染时用它同步回填）
function paintDraftHint() {
  document.querySelectorAll('[data-draft-dot]').forEach(el => {
    if (draftHint >= DRAFT_DOT_MIN) {
      el.textContent = draftHint > 9 ? '9+' : String(draftHint);
      el.hidden = false;
      el.title = `还有 ${draftHint} 份草稿待续填`;
    } else {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
    }
  });
}
let applyTypeFieldsFn = () => {}; // setupUploadForm 内部注入：按形态切换链接/二维码字段
let updateRepoFieldFn = () => {}; // setupUploadForm 内部注入：开源时显示/必填源码仓库
let resetTipPanel = () => {}; // setupDetailActions 内部注入：换作品时重置打赏面板（openWork 调用）
let openAuthorTipPanelHook = null; // setupDetailActions 内部注入：作者页直送灯火面板（loadAuthor 调用；null = 还没初始化完）

// ---------- 登录态快照：消除刷新时右上角登录区「从空到满」的闪动 ----------
// loadMe 要等 /api/me 一个来回，期间 #authBox 是空的，刷新时「签到 / 灯火 / 铃铛 / 头像」
// 会突然蹦出来，整个头部跟着晃一下。把上次登录态的轻量快照存 localStorage，init() 一开始
// 就按快照先画一版（首绘之前，视觉上无跳变），等 /api/me 回来再用真实数据重画校准。
// 会话过期 / 换号时快照画错一下下就被真实接口纠正，代价可接受。
const ME_SNAPSHOT_KEY = 'dm_me_snapshot';
function saveMeSnapshot() {
  try {
    if (!state.user) { localStorage.removeItem(ME_SNAPSHOT_KEY); return; }
    const u = state.user;
    localStorage.setItem(ME_SNAPSHOT_KEY, JSON.stringify({
      username: u.username, nickname: u.nickname || '',
      points: u.points || 0, checkin: u.checkin || {},
      unreadNotices: Number(u.unreadNotices || 0),
      passSet: u.passSet !== false,
      providers: state.providers || {}
    }));
  } catch { /* 隐私模式存不了就算了，最多闪一下 */ }
}
function restoreMeSnapshot() {
  try {
    const raw = localStorage.getItem(ME_SNAPSHOT_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || !s.username) return;
    state.user = {
      username: s.username, nickname: s.nickname || '',
      points: s.points || 0, checkin: s.checkin || {},
      unreadNotices: Number(s.unreadNotices || 0),
      passSet: s.passSet !== false,
      noticePrefs: { announce: true }
    };
    state.providers = s.providers || {};
    renderAuthBox();   // 只为视觉占位：blocked/favs 等仍为空，接口回来后由 loadMe 校准
  } catch { /* 快照坏了就当没有 */ }
}

function renderAuthBox() {
  const box = $('authBox');
  if (state.user) {
    const n = (state.blocked || []).length + (state.blockedUsers || []).length;
    const ck = state.user.checkin || {};
    const ckDone = !!ck.done;
    const pts = Number(state.user.points || 0);
    const unread = Number(state.user.unreadNotices || 0);
    box.innerHTML =
      `<button class="link-btn checkin-entry${ckDone ? ' is-done' : ' is-todo'}" id="checkinBtn"
         title="${ckDone ? `今天已签 · 连续 ${ck.streak || 0} 天 · 点开看进度和签到累计榜` : `每日签到领 ${ck.todayPoints || 5} 盏灯火，越签越多 · 点开签到`}">${ckDone ? '' : `<span class="lb-ico"><span class="ico">${ic('checkin')}</span></span><span class="ck-label">签到 +${ck.todayPoints || 5}</span>`}<span class="ck-pts" title="灯火余额，看明细走签到弹窗或头像菜单里的「灯光明细」"><span class="ico">${ic('lamp')}</span>${pts}</span></button>` +
      `<button class="link-btn notice-entry${unread ? ' has-new' : ''}" id="noticeBtn" title="${unread ? unread + ' 条未读消息' : '站内消息'}"><span class="nb-ico"><span class="ico">${ic('bell')}</span></span><span class="nb-dot"${unread ? '' : ' style="display:none"'}>${unread > 99 ? '99+' : unread}</span></button>` +
      `<div class="user-menu" id="userMenu">
        <button class="user-chip" id="userMenuBtn" title="个人菜单">${ic('user')} <span class="uc-name">${escapeHtml(state.user.nickname || state.user.username)}</span><span class="um-caret">▾</span></button>
        <div class="user-dropdown" id="userDropdown">
          <a class="ud-item" href="/u/${encodeURIComponent(state.user.slug || state.user.id || state.user.username)}" data-nav>${ic('home', 15)} 我的主页</a>
          <button class="ud-item" id="favDrop">${ic('fav', 15)} 我的收藏</button>
          <button class="ud-item" id="likeDrop">${ic('heart', 15)} 我的点赞</button>
          <div class="ud-sep"></div>
          <button class="ud-item" id="statsBtn">${ic('bars', 15)} 作品数据</button>
          <button class="ud-item" id="pointsBtn">${ic('lamp', 15)} 灯光明细<span class="ud-pts">${pts}</span></button>
          <button class="ud-item" id="promoBtn">${ic('promo', 15)} 推荐自己的作品</button>
          <div class="ud-sep"></div>
          <a class="ud-item" href="/settings" data-nav>${ic('gear', 15)} 账号设置</a>
          ${state.user.isAdmin ? `<a class="ud-item" href="/admin" target="_blank" rel="noopener" title="管理后台（新标签页打开）">${ic('shield', 15)} 管理后台</a>` : ''}
          <button class="ud-item ud-logout" id="logoutBtn">${ic('logout', 15)} 退出登录</button>
        </div>
      </div>`;
    // 下拉菜单：点 chip 开合，点外面 / Esc 关闭（document 监听只挂一次）
    const menu = $('userMenu');
    $('userMenuBtn').onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
    menu.querySelectorAll('.ud-item').forEach(el => {
      el.addEventListener('click', () => menu.classList.remove('open'));
    });
    if (!document.__userMenuOutside) {
      document.__userMenuOutside = true;
      document.addEventListener('click', e => {
        const m = document.querySelector('.user-menu.open');
        if (m && !m.contains(e.target)) m.classList.remove('open');
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { const m = document.querySelector('.user-menu.open'); if (m) m.classList.remove('open'); }
      });
    }
    $('logoutBtn').onclick = doLogout;
    // 我的收藏：从顶部导航收进头像下拉（独立页 /favs，高亮跟当前路由走）
    const favDrop = $('favDrop');
    if (favDrop) {
      favDrop.classList.toggle('active', location.pathname === '/favs');
      favDrop.onclick = () => { menu.classList.remove('open'); toggleFavorites(); };
    }
    // 我的点赞：与「我的收藏」同一套交互（独立页 /likes）
    const likeDrop = $('likeDrop');
    if (likeDrop) {
      likeDrop.classList.toggle('active', location.pathname === '/likes');
      likeDrop.onclick = () => { menu.classList.remove('open'); toggleLiked(); };
    }
    $('statsBtn').onclick = () => openStats('data');
    // 灯光明细：PC 端原来只能从「我的」页（手机端）或分享成绩里的余额卡绕进去，
    // 顶栏的灯火数字反而点不出底账，这里给一个直达入口
    $('pointsBtn').onclick = () => openStats('points');
    // 推荐直达：点「推荐」直接弹兑换弹窗，不再先进推荐面板绕一层
    $('promoBtn').onclick = () => openRedeem();
    // 签到独立成弹窗：签到卡 + 签到累计榜，不再和推荐混在一个弹窗里
    $('checkinBtn').onclick = () => openStats('checkin');
    $('noticeBtn').onclick = openNotices;
    // 昵称 / 密码 / 绑定 / 屏蔽这些设置项已收进独立页面 /settings（renderSettingsPage）。
    // 弹窗里改完都会走 renderAuthBox 刷新头部，这里顺手把开着的设置页行内状态（昵称、绑定、开关）一起刷掉
    const sv = $('settingsView');
    if (sv && sv.style.display === 'block') renderSettingsPage();
  } else {
    // 「登录 / 注册」按钮的点击走 authBox 上的事件委托（init 里绑一次）：
    // index.html 里 authBox 预置了同款按钮，游客刷新时首绘就有按钮，不用等 /api/me 回来才蹦出来
    box.innerHTML = '<button type="button" class="btn-ghost auth-open" id="loginEntry">登录 / 注册</button>';
  }
}

// 每日签到：领灯火（一轮由服务端 CHECKIN_REWARDS 决定，现在是 7 天 5/5/10/10/20/20/30），
// 断签时服务端会带 reset:true 回来，前端据此把「回到第 1 天」说清楚。成功后原地刷新顶部按钮状态
async function doCheckin(after) {
  if (!state.user) { openAuth('login'); return; }
  if (state.user.checkin && state.user.checkin.done) { showToast('今天已经签过了，明天再来'); return; }
  const btn = $('checkinBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/me/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 服务端说「已签过」时响应里带最新签到状态，顺手纠正顶部按钮（防止页面状态过期）
      if (d && d.done && state.user) {
        state.user.checkin = d;
        if (typeof d.points === 'number') state.user.points = d.points;
        renderAuthBox();
      }
      throw new Error(d.error || '签到失败');
    }
    state.user.checkin = d;
    if (typeof d.points === 'number') state.user.points = d.points;
    renderAuthBox();
    const nextReward = Array.isArray(d.schedule) ? d.schedule[d.dayInCycle % (d.cycle || 7)] : 0;
    // 断签这一下必须当场说清楚：用户最容易以为「断签后从第 5 天（20 盏）接着算」，
    // 实际是回到第 1 天、又是起步档。所以 reset 时单独给一句话，不和普通签到共用。
    if (d.reset) {
      showToast(`签到成功 +${d.reward} 盏 · 中间断了一天，从第 1 天重新开始（之前拿到的不倒扣）${nextReward ? `，明天 +${nextReward} 盏` : ''}`, undefined, 'ok');
    } else {
      showToast(d.dayInCycle === d.cycle
        ? `签到成功 +${d.reward} 盏灯火 · 连续 ${d.streak} 天，${d.cycle || 7} 天一轮拿满 ${Array.isArray(d.schedule) ? d.schedule.reduce((a, b) => a + b, 0) : ''} 盏`
        : `签到成功 +${d.reward} 盏灯火 · 连续 ${d.streak} 天${nextReward ? `，明天 +${nextReward} 盏` : ''}`, undefined, 'ok');
    }
    if (typeof after === 'function') after(d);
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast(err.message || '签到失败，请稍后再试', undefined, 'err');
  }
}

// 把签到档位压成一句人话：「第 1、2 天各 5 盏、第 3、4 天各 10 盏、第 5、6 天各 20 盏、第 7 天 30 盏」。
// 不写死天数和金额：服务端改 CHECKIN_REWARDS 或改周期长度，这句话自动跟着变。
// 为什么要写成「第几天各多少」：只写「5 盏起步」，用户会当成「第 5 天」，断签还以为能拿 20。
function scheduleLadder(schedule) {
  const parts = [];
  let i = 0;
  while (i < schedule.length) {
    let j = i;
    while (j + 1 < schedule.length && schedule[j + 1] === schedule[i]) j++;
    const dayTxt = j > i ? `第 ${i + 1}、${j + 1} 天各` : `第 ${i + 1} 天`;
    parts.push(`${dayTxt} ${schedule[i]} 盏`);
    i = j + 1;
  }
  return parts.join('、');
}

// 签到卡片（数据看板顶部那一块）：一轮 7 天的进度（每天标注当日奖励）+ 一键签到。
// 格子数是 cycle，服务端改 CHECKIN_REWARDS 长度就跟着变，前端不写死天数。
function checkinCardHtml(ck) {
  const cycle = ck.cycle || 7;
  const day = ck.dayInCycle || 1;
  const done = !!ck.done;
  const filled = done ? day : day - 1;
  const schedule = Array.isArray(ck.schedule) && ck.schedule.length === cycle
    ? ck.schedule
    : Array.from({ length: cycle }, () => ck.todayPoints || 5);   // 旧数据兜底
  const dots = Array.from({ length: cycle }, (_, i) => {
    const n = i + 1;
    const cls = ['ck-dot'];
    if (n <= filled) cls.push('is-filled');
    if (n === day) cls.push('is-today');
    if (n === cycle) cls.push('is-bonus');
    // 已签过 → ✓，今天还没签 → 「今」，其余写第几天；金额直接亮在格子里
    // （签到送灯火不明显，光靠底部一句 tip 谁都不看，进度条本身就是价目表）。
    // 天次按真实的第几天走，大奖格只靠金色区分，不写死「今」（写死会在第 1 天就顶着大奖，
    // 让人以为今天就是最后一天）。
    const label = n <= filled ? '✓' : (n === day ? '今' : n);
    return `<span class="${cls.join(' ')}" title="第 ${n} 天 +${schedule[n - 1]} 盏"><i>${label}</i><b>+${schedule[n - 1]}</b></span>`;
  }).join('');
  // 到访那一笔：不需要动作就自动到账，写在签到上面，避免用户以为「只有签到才有灯火」
  const ar = ck.arrive || {};
  const arriveLine = ar.points
    ? `<div class="ck-arrive${ar.done ? ' is-done' : ''}">${ic('lamp', 14)}<span>每天打开站点自动 +${ar.points} 盏${ar.done ? '，今天已到账' : ''}——不用点，签到再额外领下面的</span></div>`
    : '';
  return `
    <div class="checkin-card${done ? ' is-done' : ''}">
      <div class="ck-head">
        <div class="ck-title"><span class="ico">${ic('checkin')}</span> 每日签到${ck.streak ? `<span class="ck-streak">连续 ${ck.streak} 天</span>` : ''}</div>
        <button type="button" class="checkin-go" id="checkinGo"${done ? ' disabled' : ''}>${done ? '今日已签 ✓' : `签到 +${ck.todayPoints || 5}`}</button>
      </div>
      <div class="ck-days">${dots}</div>
      ${arriveLine}
      <div class="ck-tip">一轮 ${cycle} 天共 ${schedule.reduce((a, b) => a + b, 0)} 盏，断签从头记。攒的灯火可以换<span style="white-space:nowrap">「推荐」</span>的曝光位，也可以送给喜欢的作品，给作者点一盏灯。</div>
      ${ckAdHtml(ck)}
      <div class="ck-promise">${ic('heart', 13)}<span>灯火只送不卖：签到、看广告、分享邀请都能免费拿，也没有付费买灯火的入口。</span></div>
    </div>`;
}

// 签到卡里的「看广告领灯火」：网页（尤其 PC）播不了微信激励视频，这一块只做一道门——
// 出小程序码把人送进「我的」页那张看视频卡，回来靠 /api/me/checkin 的 adReward.used 自动认账。
// 额度是服务端给的（每天 3 次、30/30/40 递增），这里只负责把「还剩几次」说清楚，不自己算规则。
function ckAdOnce(ck) {
  const ar = (ck && ck.adReward) || {};
  return Number(ar.each || ar.once || (Array.isArray(ar.schedule) ? ar.schedule[0] : 0)) || 30;
}

function ckAdHtml(ck) {
  const ar = (ck && ck.adReward) || {};
  const once = ckAdOnce(ck);
  const limit = Number(ar.limit || (Array.isArray(ar.schedule) ? ar.schedule.length : 0)) || 3;
  const left = ar.left == null ? limit : Math.max(0, Number(ar.left) || 0);
  const total = Number(ar.total) || once * limit;
  const sched = Array.isArray(ar.schedule) ? ar.schedule : [];
  const stepTxt = sched.some(v => v !== sched[0]) ? `，按 ${sched.join('/')} 递增` : '';
  const done = left <= 0;
  return `
    <div class="ck-ad${done ? ' is-done' : ''}">
      <span class="ck-ad-ico">${ic('mini', 14)}</span>
      <span class="ck-ad-main">
        <b>${done ? '今天的看广告奖励已领完' : `看广告 +${once} 盏`}</b>
        <span>${done
          ? `每天 ${limit} 次都领完了，明天 0 点刷新`
          : `每天 ${limit} 次 · 今天还剩 ${left} 次${stepTxt}，单日最多 ${total} 盏 · 在小程序里看，看完自动到账`}</span>
      </span>
      <button type="button" class="ck-ad-go" id="ckAdBtn"${done ? ' disabled' : ''}>${done ? '今日已领完' : '去小程序看 ›'}</button>
    </div>`;
}

// 签到卡里的看广告按钮：未登录先去登录（灯火记在账号上），登录了才出码
function bindCkAdBtn(root) {
  const b = (root || document).querySelector('#ckAdBtn');
  if (!b) return;
  b.onclick = () => { if (!state.user) openAuth('login'); else openCheckinAdQr(); };
}

// 看广告到账后把签到卡里那一块原地重画（弹窗开着时也顺带更新「还剩几次」）
function refreshCkAdBlock(ck) {
  document.querySelectorAll('.checkin-card .ck-ad').forEach(el => {
    const tmp = document.createElement('div');
    tmp.innerHTML = ckAdHtml(ck);
    const node = tmp.firstElementChild;
    el.replaceWith(node);
    bindCkAdBtn(node);
  });
}

// 签到累计榜（推荐面板里的小榜）：按累计签到灯火排，前 5 名，自己不在榜内就补一行真实名次。
// 和「灯火达人榜」分开口径：那张榜比带来多少人，这张比来得有多勤，新人签几次也能露脸。
function checkinBoardHtml(list, rank) {
  const rows = Array.isArray(list) ? list : [];
  const me = (state.user && state.user.username) || '';
  const rk = rank || { rank: 0, points: 0, totalRanked: 0 };
  const top = rows.slice(0, 5);
  const inTop = top.some(r => r.username === me);
  // 整行就是站内链接：当前页跳作者主页（data-nav 惯例），PC 想 new tab 的人 Ctrl+点 / 中键自己来
  const row = (b, mine) => `
        <a class="board-row${mine ? ' is-me' : ''}" href="/u/${encodeURIComponent(b.uid || b.username || me)}" data-nav>
          <span class="board-rank${b.rank <= 3 ? ' top' : ''}">${b.rank}</span>
          <span class="board-name">${escapeHtml(b.name)}${mine ? '<i class="ck-you">你</i>' : ''}</span>
          <span class="board-num">${b.days ? `累计签到 ${b.days} 天` : '—'}</span>
          <b class="board-pts">${b.points}<i>灯火</i></b>
        </a>`;
  const body = top.length
    ? top.map(b => row(b, b.username === me)).join('')
    : '<div class="board-row"><span class="board-name">还没有人签到，今天签一次就是榜一</span></div>';
  // 前 5 里没有我：底下补一行自己的真实名次，别让人只看得见别人
  const mineRow = (!inTop && rk.rank > 0)
    ? '<div class="ck-board-gap">⋯</div>' + row({
        rank: rk.rank,
        name: (state.user && (state.user.nickname || state.user.username)) || '你',
        points: rk.points,
        days: rk.days || (state.user && state.user.checkin && state.user.checkin.days) || 0
      }, true)
    : '';
  const foot = rk.rank > 0
    ? `你目前第 <b>${rk.rank}</b> 名 · 累计 ${rk.points} 盏${rk.totalRanked ? `，共 ${rk.totalRanked} 人上榜` : ''}`
    : '你还没签过到，今天签一次就能上榜（第 1 天 +2 盏）。';
  return `
    <div class="ck-board">
      <div class="stats-works-head">签到累计榜</div>
      <p class="board-note">按<b>累计签到拿到的灯火</b>排名，断签只清连续天数、不清累计——每天点一下，累计就多一点。</p>
      <div class="board-list">${body}${mineRow}</div>
      <p class="ck-board-foot">${foot}</p>
    </div>`;
}

function openAuth(mode = 'login', thenPublish = false) {
  pendingPublish = thenPublish;
  switchAuth(mode);
  showModal(authModal);
  setTimeout(() => authModal.querySelector(mode === 'login' ? '#loginForm input' : '#registerForm input').focus(), 50);
}

function switchAuth(mode) {
  $('authTitle').textContent = mode === 'login' ? '登录造梦橱窗' : '注册造梦橱窗';
  $('loginForm').style.display = mode === 'login' ? 'block' : 'none';
  $('registerForm').style.display = mode === 'login' ? 'none' : 'block';
  setLoginErr('');                       // 切换视图清掉上一次的报错
  const upgrade = $('loginUpgrade'); if (upgrade) upgrade.style.display = 'none';
  // 账号名只用于登录，作品上展示的是昵称（可改），别让人以为名字一注册就定死了
  const hint = $('authHint');
  if (hint) {
    hint.textContent = mode === 'login'
      ? '登录后才能投稿 · 作品上显示的是你的昵称，随时能改'
      : '注册就能投稿 · 昵称先给一个，不满意点「换一个」';
  }
  // 切到注册页就把昵称填上，用户不用再想一个名字
  if (mode === 'register') fillRegNick(false);
}

// 未登录投稿：先问「注册（免审直发）还是匿名（需审核）」
let submitChoiceResolve = null;
function askSubmitChoice() {
  return new Promise(resolve => {
    submitChoiceResolve = resolve;
    showModal(submitChoiceModal);
  });
}
function closeSubmitChoice(result) {
  hideModal(submitChoiceModal);
  const r = submitChoiceResolve;
  submitChoiceResolve = null;
  if (r) r(result);
}
function setupSubmitChoice() {
  $('choiceRegister').onclick = () => closeSubmitChoice('auth');
  $('choiceAnon').onclick = () => closeSubmitChoice('anon');
  $('choiceCancel').onclick = () => closeSubmitChoice('cancel');
  bindMaskClose(submitChoiceModal, () => closeSubmitChoice('cancel'));
}

// 微信等 OAuth 建的临时号（还没设密码）：登录成功后主动弹一次「账号与密码」引导完善。
// 防骚扰：本机每个账号只主动弹一次（localStorage 记账），关掉不再弹，入口始终在用户菜单里。
function maybeNudgePassSetup() {
  const u = state.user;
  if (!u || u.passSet !== false) return;
  const key = 'dm_pass_nudge_' + (u.username || u.id);   // 统一用 username 作键：afterAuth 响应里没有 id，用 id 会和 loadMe 的键对不上，导致刷新后重复弹
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch { /* 隐私模式拿不到 localStorage 就不主动弹 */ return; }
  // 等欢迎 toast 先说完话再弹，别两个叠在一起
  setTimeout(() => {
    // 用户正忙着投稿（投稿弹窗开着）就先不打扰，入口始终在用户菜单里
    if (uploadModal && uploadModal.style.display === 'flex') return;
    // 「这些作品是你投的吗」正开着：先让 TA 处理认领，设密码的引导下次登录再弹
    if ($('ipClaimModal') && $('ipClaimModal').style.display === 'flex') return;
    if (state.user && state.user.passSet === false && $('passModal') && $('passModal').style.display !== 'flex') {
      openPassModal();
    }
  }, 2300);
}

// 「我的」页正开着就重画：移动端登录入口和退出入口都在「我的」页里，
// 登录/退出后不重画的话页面会一直停在旧视图（登录完还显示「登录造梦橱窗」）
async function refreshMeViewIfActive() {
  const meView = $('meView');
  if (!meView || meView.style.display === 'none') return;
  await loadMe();   // 登录：补齐 checkin/points/worksCount（登录响应里没有）；退出：拿回未登录态
  renderMePage();
}

async function afterAuth(data) {
  state.user = {
    id: data.id || '', username: data.username, nickname: data.nickname || '',
    // 登录响应里可能没有头像（走 afterAuth 的接口不止 /api/me），缺了就当首字母，
    // 下一次 loadMe 会补上真实值
    avatar: data.avatar || '', avatarSrc: data.avatarSrc || '', avatarSrcLabel: data.avatarSrcLabel || '',
    noticePrefs: data.noticePrefs || { announce: true },   // 系统消息提示开关（登录/注册响应里带回来）
    // 登录响应（/api/login、微信扫码轮询）必须带 passSet / 别名：这里不走 loadMe，
    // 缺了 passSet 会把没设过密码的 OAuth 临时号误判成已设密码，弹窗里冒出「当前密码」
    passSet: data.passSet !== false,
    alias: data.alias || '',
    aliasNextAt: Number(data.aliasNextAt || 0),
    wechat: data.wechat || null
  };
  state.favs = Array.isArray(data.favs) ? data.favs : [];
  renderAuthBox();
  hideModal(authModal);
  const gnb = $('guestNoticeBar'); if (gnb) gnb.hidden = true;   // 登录后走铃铛，收起游客公告条
  showToast(data.invited
    ? `欢迎，${data.nickname || data.username}！你的邀请人获得了 +${data.invitePoints} 盏灯火`
    : `欢迎，${data.nickname || data.username}！`, undefined, 'ok');
  // 登录/注册成功后立刻拉一次站内消息：有未读就点亮铃铛并弹提示。
  // 不拉的话要等最长 60 秒的轮询，而且轮询首轮不弹提示（noticeUnreadSeen 还是 -1），消息就"静默"了
  loadNotices(true).then(() => {
    // 只提示没被屏蔽的那部分（屏蔽的公告不弹窗）
    const unread = noticeItems.filter(x => !x.read && !x.muted).length;
    if (unread > 0) setTimeout(() => showToast(`你有 ${unread} 条新消息，${noticeTipText()}`, 5000), 600);
  });
  // 先把本机旧收藏并入账号，再补上登录前点的那颗星
  await mergeLocalFavs();
  if (pendingFavId) {
    const id = pendingFavId;
    pendingFavId = null;
    if (!isFav(id)) {
      const added = await toggleFav(id);
      if (added) showToast('已加入收藏', undefined, 'ok');
    }
    paintFavButtons(id);
    renderDetailFav(id);
  }
  // 详情弹窗如果开着，刷新一次：评论区、编辑/删除按钮、认领入口等依赖登录态的内容
  loadMyClaims().then(() => {
    if (detailModal.style.display === 'flex' && state.currentWork) {
      openWork(state.currentWork.id, false);
    }
  });
  if (pendingPublish) {
    pendingPublish = false;
    resetUploadForm();
    const restored = restoreUploadDraft();
    showModal(uploadModal);
    if (restored) showToast('已恢复上次未提交的草稿（图片需重新选择）', undefined, 'ok');
  }
  // 登录/注册成功立刻重画「我的」页（正开着的话），别让人登录完还看着未登录视图
  await refreshMeViewIfActive();
  // 收藏/点赞独立页正开着的话，登录后把列表补上（未登录进来时是空壳）
  if (location.pathname === '/favs') loadFavPage();
  else if (location.pathname === '/likes') loadLikedPage();
  // 微信等 OAuth 建的临时号：登录成功后主动弹一次「账号与密码」引导完善
  maybeNudgePassSetup();
  // 从投稿进度页带着凭据来的：登录/注册一成功就把那件匿名作品认到名下
  if (state.pendingClaim) await runPendingClaim();
  // 匿名投过稿、但当时没账号：按投稿 IP 认出来问一句「这些是你投的吗」，确认即当场归属
  await maybeOfferIpClaim();
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  state.user = null;
  state.favs = [];
  state.myClaims = [];
  renderAuthBox();
  saveMeSnapshot();   // 退出即清快照，下次刷新首绘直接是「登录 / 注册」
  refreshDraftHint(); // 草稿挂在账号上，退出后角标必须收掉（否则下一个人会看到别人的份数）
  showToast('已退出登录');
  loadGuestNotices();  // 退出后又变回游客：公告条重新挂出来（已关过的不再弹）
  await refreshMeViewIfActive();   // 退出入口在「我的」页里，同步重画回未登录视图
  // 星标依赖登录态，退出后同步刷新当前列表
  if (location.pathname === '/') loadWorks();
  if (location.pathname === '/favs') loadFavPage();
  else if (location.pathname === '/likes') loadLikedPage();
  if (detailModal.style.display === 'flex' && state.currentWork) {
    renderDetailFav(state.currentWork.id);
    openWork(state.currentWork.id, false); // 评论区、认领入口等也依赖登录态
  }
}

async function loadMe() {
  try {
    const data = await (await fetch('/api/me')).json();
    state.user = data.username
      ? { id: data.id || '', username: data.username, nickname: data.nickname || '',
          avatar: data.avatar || '', avatarSrc: data.avatarSrc || '', avatarSrcLabel: data.avatarSrcLabel || '',
          checkin: data.checkin || {}, points: data.points || 0,
          arrive: data.arrive || {},   // 今日到访那 2 盏（given=true 表示这一趟刚发）
          unreadNotices: Number(data.unreadNotices || 0),   // 顶部铃铛未读数
          worksCount: Number(data.worksCount || 0),   // 带上签到状态、积分和作品数，顶部按钮 / 注销弹窗要用
          passSet: data.passSet !== false,            // false = OAuth 建的号（GitHub / Google）还没设过密码
          isSiteOwner: data.isSiteOwner === true,     // 站长标记：编辑弹窗据此隐藏承诺勾选框
          isAdmin: data.isAdmin === true,             // 管理员标记（站长或名单管理员）：头像下拉据此显隐「管理后台」入口
          alias: data.alias || '',                    // 登录别名（自己起的好记登录名）
          aliasNextAt: Number(data.aliasNextAt || 0),
          // 个性地址（作者页 /u/<自定义>）：slug 空 = 还在用 /u/账号id；
          // slugEligible 由服务端按「有已上线作品」现算，前端只拿它切提示文案，不当授权用
          slug: data.slug || '',
          slugPath: data.slugPath || '',
          slugNextAt: Number(data.slugNextAt || 0),
          slugEligible: data.slugEligible === true,
          links: Array.isArray(data.links) ? data.links : [],   // 我的链接（GitHub/知乎/…），作者主页档案行下面那排
          noticePrefs: data.noticePrefs || { announce: true },   // 系统消息提示开关（屏蔽后仍收消息、不弹窗）
          wechat: data.wechat || null,
          github: data.github || null,
          google: data.google || null }
      : null;
    state.providers = (data && data.providers) || {};
    state.favs = Array.isArray(data.favs) ? data.favs : [];
    state.blocked = Array.isArray(data.blocked) ? data.blocked : [];
    state.blockedUsers = Array.isArray(data.blockedUsers) ? data.blockedUsers : [];
  } catch { state.user = null; state.providers = {}; state.favs = []; state.blocked = []; state.blockedUsers = []; }
  await loadMyClaims();
  if (state.user) await mergeLocalFavs(); // 本机遗留的旧收藏（换设备/重新登录都会补一次）
  applyAuthProviders();
  renderAuthBox();
  saveMeSnapshot();   // 登录态有变（登录/退出/灯火数变动）就更新快照，供下次刷新首绘用
  refreshDraftHint();   // 登录态一变就重新数草稿：刷新后不打开表单也能看见「还有几份」
  // 到访奖励：每天第一次打开站点，服务端在 /api/me 里自动发 2 盏，不用点任何按钮。
  // 只在真的发放那一趟提示（given 由服务端给），否则每次刷新都会弹。
  if (state.user && state.user.arrive && state.user.arrive.given) {
    showToast(`欢迎回来，今天到访 +${state.user.arrive.points || 2} 盏灯火`, 3600, 'ok');
  }
  // 刷新页面 / OAuth 回跳建立的登录态同样要引导：临时号主动弹一次「账号与密码」
  maybeNudgePassSetup();
}

// 第三方登录入口是否显示：服务端配置了 clientId/secret 才亮出来，
// 否则点了也只会报「未配置」，不如藏起来。GitHub / Google 各自独立开关。
function applyAuthProviders() {
  const ghOn = !!(state.providers && state.providers.github);
  const gOn = !!(state.providers && state.providers.google);
  const wxOn = !!(state.providers && state.providers.wechat);
  // 手机端：微信登录保留——码是小程序码，手机上可以「长按保存到相册 → 微信扫一扫从相册识别」
  // （微信内打开还能长按直接识别，一步跳小程序确认）。GitHub 不放：用户群是创作者不是开发者，
  // 手机浏览器跳 GitHub 授权要输密码/两步验证，转化极低。Google 是整页跳转授权，手机上没障碍。
  const onMobile = window.innerWidth <= 640;
  const ghShow = ghOn && !onMobile;
  const wxShow = wxOn;
  const box = $('authOauth');
  if (box) box.style.display = (ghShow || gOn || wxShow) ? '' : 'none';
  const ghBtn = $('ghLoginBtn');
  if (ghBtn) ghBtn.style.display = ghShow ? '' : 'none';
  const gBtn = $('gLoginBtn');
  if (gBtn) gBtn.style.display = gOn ? '' : 'none';
  const wxBtn = $('wxScanBtn');
  if (wxBtn) wxBtn.style.display = wxShow ? '' : 'none';
  if ((ghShow || gOn || wxShow) && window.Icons) Icons.hydrate(box);   // 弹窗是隐藏状态时插入的 SVG 占位，这里补渲染
}

// ---------- 站内消息 ----------
// 铃铛里不再是「一锅炖」：顶部按 系统 / 投放 / 灯火 / 消息 / 营销 分栏（营销垫底），各自算未读。
// 2026-11-13：分栏原叫「广告」，和右侧站方群发的「营销」容易混——这一栏装的其实是
// 自己那单推荐位在走流程（上线 / 排队 / 投完 / 被撤），改成「投放」，落点是「我的位子」而不是广告业务。
// 分区口径由服务端下发（notice.cat），这里只留一份兜底表给老接口 / 本地缓存的旧数据用。
let noticeTimer = null;
let noticeItems = [];
let noticeUnreadSeen = -1;
let noticeCat = 'all';                 // 当前分栏
let noticeCounts = {};                 // { [cat]: { n, u } } 条数与未读数

const NOTICE_TABS = [
  { key: 'all',    name: '全部', icon: 'bell',      title: '还没有消息',     empty: '灯火有变动、站长回信或有新活动，都会在这里通知你' },
  { key: 'system', name: '系统', icon: 'bell',      title: '还没有系统通知', empty: '规则调整、上线公告会记在这里' },
  { key: 'ad',     name: '投放', icon: 'promo',     title: '还没有投放记录', empty: '用灯火换过推荐位后，上线 / 排队 / 投完都会通知你' },
  { key: 'points', name: '灯火', icon: 'lamp',      title: '还没有灯火变动', empty: '签到、投稿、分享攒下的灯火都会记在这' },
  { key: 'msg',    name: '消息', icon: 'chat',      title: '还没有人给你留言', empty: '' },
  { key: 'promo',  name: '营销', icon: 'megaphone', title: '还没有营销消息', empty: '站里有活动、上新或优惠时会推到这里' }
];
const NOTICE_CAT_OF_KIND = {
  promo: 'promo', ad: 'ad', points: 'points',
  announce: 'system', system: 'system', tag: 'system',
  'bar-reply': 'msg'
};
// 「消息」这一栏里其实混着几个场子：作品评论 / 提问、站长私信、意见反馈、酒馆回应。
// 只有酒馆需要单独点明出处——它不是「我的作品有人说话」，点进去也不在作品详情。
// 不给它开第七栏：480px 的弹窗塞 6 个两字标签已经到底了，手机端连图标都让位了；
// 一枚小标签足够，未读照样计入「消息」。
const NOTICE_KIND_TAG = { 'bar-reply': { name: '酒馆', cls: 'bar' } };
function noticeCatOf(n) {
  return (n && n.cat) || NOTICE_CAT_OF_KIND[(n && n.kind) || ''] || 'msg';
}

// 「你有 N 条新消息」toast 的后半句：PC 走右上角铃铛，手机端头部没有铃铛，入口在「我的」页菜单里
function noticeTipText() {
  return window.innerWidth <= 640 ? '去「我的」页查看' : '点右上角铃铛查看';
}

// 未读数只算「真的想看」的那部分：分栏角标统一用未读数，读完了就地消失，
// 不拿总条数糊在标签上（6 个数字挤在 480px 里反而看不清哪个要处理）。
function noticeCountsOf(items) {
  const cats = {};
  ['all', 'promo', 'system', 'ad', 'points', 'msg'].forEach(c => { cats[c] = { n: 0, u: 0 }; });
  items.forEach(n => {
    const c = noticeCatOf(n);
    cats.all.n++; cats[c].n++;
    if (!n.read) { cats.all.u++; cats[c].u++; }
  });
  return cats;
}

function renderNoticeTabs() {
  const box = $('noticeTabs');
  if (!box) return;
  box.querySelectorAll('.nt-tab').forEach(btn => {
    const c = btn.dataset.cat || 'all';
    const st = noticeCounts[c] || { n: 0, u: 0 };
    const on = c === noticeCat;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    const chip = btn.querySelector('.nt-n');
    if (chip) {
      chip.textContent = st.u > 99 ? '99+' : String(st.u || '');
      chip.hidden = !st.u;
    }
  });
  const readAll = $('noticeReadAll');
  if (readAll) readAll.textContent = noticeCat === 'all' ? '全部标记已读' : '标记本栏已读';
}

function renderNoticeBadge(n) {
  const btn = $('noticeBtn');
  if (!btn) return;
  const num = Number(n || 0);
  const dot = btn.querySelector('.nb-dot');
  btn.classList.toggle('has-new', num > 0);
  btn.title = num ? `${num} 条未读消息` : '站内消息';
  if (dot) {
    dot.style.display = num > 0 ? '' : 'none';
    dot.textContent = num > 99 ? '99+' : String(num);
  }
}

// 系统消息（站方公告）是否屏蔽了提示：屏蔽 ≠ 拒收，消息照样进铃铛，只是不弹窗
function noticeMuted() {
  return !!(state.user && state.user.noticePrefs && state.user.noticePrefs.announce === false);
}

async function toggleNoticeMute() {
  if (!state.user) { openAuth('login'); return; }
  const nextMuted = !noticeMuted();          // 这次要变成「屏蔽」还是「恢复正常」
  try {
    const r = await fetch('/api/me/notices/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announce: !nextMuted })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '设置失败');
    state.user.noticePrefs = d.noticePrefs || { announce: !nextMuted };
    renderAuthBox();
    showToast(nextMuted ? '已屏蔽系统消息提示，消息仍会进铃铛列表' : '已恢复系统消息提示');
  } catch (e) { showToast(e.message || '设置失败', undefined, 'err'); }
}

async function loadNotices(silent) {
  if (!state.user) { noticeItems = []; return null; }
  try {
    const d = await (await fetch('/api/me/notices')).json();
    noticeItems = Array.isArray(d.items) ? d.items : [];
    const unread = Number(d.unread || 0);
    // 分栏未读以服务端为准（它算的是全部消息，不受列表截断影响）
    noticeCounts = d.cats || noticeCountsOf(noticeItems);
    renderNoticeTabs();
    // 只统计「没被屏蔽」的未读：屏蔽的公告照常进列表，但不该触发弹窗
    const loud = noticeItems.filter(x => !x.read && !x.muted).length;
    state.user.unreadNotices = unread;
    renderNoticeBadge(unread);
    // 后台轮询发现有新的、可提示的未读：直接弹一条提示，不用等用户点铃铛
    if (silent && noticeUnreadSeen >= 0 && loud > noticeUnreadSeen) {
      const first = noticeItems.find(x => !x.read && !x.muted);
      showToast(first && first.title ? `新消息：${first.title}` : '你有一条新消息', 5000);
    }
    noticeUnreadSeen = loud;
    return d;
  } catch { return null; }   // 消息拉不到不影响页面
}

function startNoticePoll() {
  if (noticeTimer) return;
  noticeTimer = setInterval(() => { if (state.user) loadNotices(true); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user) loadNotices(true);
  });
}

function fmtNoticeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  const d = new Date(t);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function renderNoticeList() {
  const box = $('noticeList');
  if (!box) return;
  const tab = NOTICE_TABS.find(t => t.key === noticeCat) || NOTICE_TABS[0];
  const items = noticeCat === 'all' ? noticeItems : noticeItems.filter(n => noticeCatOf(n) === noticeCat);
  if (!items.length) {
    box.innerHTML = `
    <div class="notice-empty">
      <div class="ne-art"><i class="ico" data-ico="${tab.icon || 'bell'}" data-ico-size="24"></i><i class="ico ne-spark" data-ico="sparkle" data-ico-size="12"></i></div>
      <div class="ne-title">${tab.title || '这里还空着'}</div>
      ${tab.empty ? `<div class="ne-text">${tab.empty}</div>` : ''}
    </div>`;
    try { if (window.Icons && Icons.hydrate) Icons.hydrate(box); } catch { /* 图标脚本没加载就先裸占位 */ }
    return;
  }
  box.innerHTML = items.map(n => {
    const goto = n.workId || n.link || '';
    // 可对话的通知：精选 / 管理员回复 / 意见反馈的回复 / 自己发起的私信站长
    const hasThread = n.kind === 'featured' || n.kind === 'reply' || n.kind === 'feedback' || n.kind === 'dm';
    // 「全部」里给每条补一个分区小标签：营销 / 系统 / 灯火混在一起时，得一眼看出这条是谁发的
    // 酒馆回应跨栏都挂自己的标签（在「消息」栏里也要能和作品评论分开）
    const own = NOTICE_KIND_TAG[n.kind];
    const catName = own ? own.name
      : (noticeCat === 'all' && (NOTICE_TABS.find(t => t.key === noticeCatOf(n)) || {}).name);
    const catCls = own ? own.cls : noticeCatOf(n);
    return `
    <div class="notice-item${n.read ? '' : ' is-unread'}${Number(n.delta || 0) > 0 ? ' is-plus' : (Number(n.delta || 0) < 0 ? ' is-minus' : '')}${goto ? ' is-link' : ''}${hasThread ? ' has-thread' : ''}"${n.workId ? ` data-goto="${escapeHtml(n.workId)}"` : (n.link ? ` data-link="${escapeHtml(n.link)}"` : '')}>
      <div class="notice-top">
        <span class="notice-title">${catName ? `<span class="nc-tag nc-${catCls}">${catName}</span>` : ''}${escapeHtml(n.title || '消息')}${goto ? ' <span class="notice-go">查看 ›</span>' : ''}</span>
        ${n.muted ? '<span class="notice-mute">已屏蔽</span>' : ''}
        <span class="notice-time">${fmtNoticeTime(n.createdAt)}</span>
      </div>
      <div class="notice-text">${escapeHtml(n.text || '')}</div>
      ${hasThread ? `<button type="button" class="notice-reply-btn" data-reply="${escapeHtml(n.threadId)}">${n.kind === 'dm' ? '查看对话' : '回复'}</button>` : ''}
    </div>`;
  }).join('');
  // 带 workId 的消息（评论 / 提问 / 回复通知）点了直接打开对应作品详情
  box.querySelectorAll('.notice-item[data-goto]').forEach(el => {
    el.onclick = () => {
      closeNoticePanel();   // 顺手结掉当前分栏的已读：点了就是看过了
      openWork(el.dataset.goto);
    };
  });
  // 带 link 的公告（如编年史）：点了跳站内页面
  // 酒馆回应的 link 形如 /bar?p=帖子id：走站内路由直接弹那一楼，别整页刷新
  // （route('/bar') 自己会接住 ?p= 并在列表就绪后 focusChatPost）
  box.querySelectorAll('.notice-item[data-link]').forEach(el => {
    el.onclick = () => {
      const link = el.dataset.link || '';
      closeNoticePanel();
      const m = /^\/bar\?p=([^&]+)/.exec(link);
      if (!m) { location.href = link; return; }
      const pid = decodeURIComponent(m[1]);
      if (location.pathname === '/bar') focusChatPost(pid);
      else navigate(link);
    };
  });
  box.querySelectorAll('.notice-reply-btn').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); openNoticeReply(btn.dataset.reply); };
  });
}

// ---------- 游客公告条 ----------
// 站内消息只有登录后能看到；未登录的访客走这条公开通道：页面顶部的公告条，谁都能看。
// 关掉的公告按 key 记在本机（localStorage），下架 / 新增由后台「群发通知」页管理。
const GN_DISMISS_KEY = 'dm_guest_notice_dismissed';
function gnDismissedList() {
  try { return JSON.parse(localStorage.getItem(GN_DISMISS_KEY) || '[]'); }
  catch { return []; }
}
function gnMarkDismissed(key) {
  try {
    const list = gnDismissedList().filter(k => k !== key);
    list.unshift(key);
    localStorage.setItem(GN_DISMISS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch { /* 隐私模式记不住，至少本次先关掉 */ }
  const bar = $('guestNoticeBar');
  if (bar) bar.hidden = true;
}
async function loadGuestNotices() {
  const bar = $('guestNoticeBar');
  if (!bar) return;
  if (state.user) { bar.hidden = true; return; }   // 登录用户走铃铛，不重复挂横幅
  let items = [];
  try { items = (await (await fetch('/api/guest-notices')).json()).items || []; }
  catch { return; }                                // 拿不到就不展示，无害
  const dismissed = new Set(gnDismissedList());
  const n = items.find(x => x && !dismissed.has(x.key) && (x.title || x.text));
  if (!n) { bar.hidden = true; return; }
  bar.innerHTML =
    '<span class="gnb-ico"><i class="ico" data-ico="sparkle"></i></span>' +
    '<div class="gnb-main">' +
      (n.title ? '<b>' + escapeHtml(n.title) + '</b>' : '') +
      (n.text ? '<span>' + escapeHtml(n.text) + '</span>' : '') +
    '</div>' +
    (n.link ? '<a class="gnb-link" href="' + escapeHtml(n.link) + '">去看看</a>' : '') +
    '<button type="button" class="gnb-close" aria-label="关闭公告">✕</button>';
  bar.querySelector('.gnb-close').onclick = () => gnMarkDismissed(n.key);
  bar.hidden = false;
  if (window.Icons) Icons.hydrate(bar);
}

// 回复管理员的精选 / 消息通知（双向会话：消息都挂在会话容器通知的 thread 上）
function openNoticeReply(threadId) {
  let container = noticeItems.find(n => n.id === threadId);
  if (!container) container = noticeItems.find(n => n.threadId === threadId && (n.thread || []).length);
  if (!container) { showToast('对话不存在', undefined, 'err'); return; }
  const mask = $('replyModal');
  const threadBox = $('replyThread');
  const input = $('replyText');
  const sendBtn = $('replySend');
  // 副标题：让用户知道这段对话挂在哪条消息 / 哪件作品上
  $('replySub').textContent = container.title || '与管理员的对话';
  const renderThread = () => {
    const msgs = container.thread || [];
    threadBox.innerHTML = msgs.length ? msgs.map(m => `
      <div class="reply-msg reply-${m.from}">
        <span class="reply-from">${m.from === 'admin' ? '管理员' : '我'}</span>
        <p class="reply-text">${escapeHtml(m.text)}</p>
        <span class="reply-time">${fmtNoticeTime(m.at)}</span>
      </div>`).join('') : '<div class="reply-empty">还没有对话，发送第一条吧</div>';
    threadBox.scrollTop = threadBox.scrollHeight;
  };
  renderThread();
  input.value = '';
  sendBtn.onclick = async () => {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const r = await fetch('/api/me/notices/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, text }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); showToast(e.error || '发送失败', undefined, 'err'); }
      else {
        container.thread = container.thread || [];
        container.thread.push({ from: 'user', fromId: (state.user && state.user.id) || '', fromName: (state.user && state.user.username) || '作者', text, at: new Date().toISOString(), read: false });
        input.value = '';
        renderThread();
      }
    } catch { showToast('网络错误', undefined, 'err'); }
    sendBtn.disabled = false;
  };
  input.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendBtn.onclick(); };
  $('closeReply').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  showModal(mask);
  setTimeout(() => input.focus(), 50);
}

// 私信站长：复用回复弹窗。第一条消息 POST /api/me/dm 新建会话容器，
// 之后续聊走 /api/me/notices/reply——和精选 / 管理员回复的对话是同一套链路。
function openDmToOwner() {
  const mask = $('replyModal');
  const threadBox = $('replyThread');
  const input = $('replyText');
  const sendBtn = $('replySend');
  $('replySub').textContent = '给站长的留言';
  let threadId = null;         // 发出第一条后才有
  const msgs = [];             // 本地回显，发一条补一条
  const renderThread = () => {
    threadBox.innerHTML = msgs.length ? msgs.map(m => `
      <div class="reply-msg reply-${m.from}">
        <span class="reply-from">${m.from === 'admin' ? '站长' : '我'}</span>
        <p class="reply-text">${escapeHtml(m.text)}</p>
        <span class="reply-time">${fmtNoticeTime(m.at)}</span>
      </div>`).join('') : '<div class="reply-empty">还没有对话，写下第一条吧</div>';
    threadBox.scrollTop = threadBox.scrollHeight;
  };
  renderThread();
  input.value = '';
  sendBtn.onclick = async () => {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const url = threadId ? '/api/me/notices/reply' : '/api/me/dm';
      const body = threadId ? { threadId, text } : { text };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(d.error || '发送失败', undefined, 'err'); }
      else {
        if (!threadId) threadId = d.threadId;
        msgs.push({ from: 'user', text, at: new Date().toISOString() });
        input.value = '';
        renderThread();
        loadNotices(true);   // 静默刷新，让会话容器出现在消息列表里
      }
    } catch { showToast('网络错误', undefined, 'err'); }
    sendBtn.disabled = false;
  };
  input.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendBtn.onclick(); };
  $('closeReply').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  showModal(mask);
  setTimeout(() => input.focus(), 50);
}

// 标记一个分栏已读（'all' = 全读）。接口和本地状态一起改：
// 只改本地不改服务端，下次轮询（60 秒）会把未读又刷回来。
async function markNoticeRead(cat) {
  const scope = cat && cat !== 'all' ? cat : 'all';
  try {
    await fetch('/api/me/notices/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cat: scope })
    });
  } catch { /* 接口挂了也先把本地收干净，轮询会再对齐 */ }
  noticeItems = noticeItems.map(n =>
    (scope === 'all' || noticeCatOf(n) === scope) ? { ...n, read: true } : n);
  noticeCounts = noticeCountsOf(noticeItems);
  state.user.unreadNotices = noticeCounts.all.u;
  // 弹窗提示的基准是「没被屏蔽的未读」，读完了要一起回落，否则下一轮会重弹
  noticeUnreadSeen = noticeItems.filter(x => !x.read && !x.muted).length;
  renderNoticeBadge(noticeCounts.all.u);
  renderNoticeTabs();
  renderNoticeList();
}

// 关窗结算已读：把「你正在看的这一栏」标掉（停在「全部」就是全读）。
// 不在打开时立刻全标掉——那样分栏角标一闪就没，用户根本来不及看「哪一类有新消息」。
// 关窗才结算还有个好处：看完顺手关掉，红点自然消失，和旧版「打开即已读」的体感一致。
function closeNoticePanel() {
  const mask = $('noticeMask');
  if (!mask || mask.style.display === 'none') return;
  markNoticeRead(noticeCat);   // 不 await：先关窗，标记在后台走完
  hideModal(mask);
}

async function openNotices() {
  if (!state.user) { openAuth('login'); return; }
  const mask = $('noticeMask');
  $('closeNotice').onclick = closeNoticePanel;
  if ($('noticeDm')) $('noticeDm').onclick = () => openDmToOwner();
  // 分栏切换：只切列表，不结算已读（已读统一在关窗时结）
  const tabs = $('noticeTabs');
  if (tabs) {
    tabs.querySelectorAll('.nt-tab').forEach(btn => {
      btn.onclick = () => {
        const next = btn.dataset.cat || 'all';
        if (next === noticeCat) return;
        noticeCat = next;
        renderNoticeTabs();
        renderNoticeList();
      };
    });
  }
  $('noticeReadAll').onclick = () => markNoticeRead(noticeCat);
  bindMaskClose(mask, closeNoticePanel);
  showModal(mask);
  renderNoticeTabs();
  renderNoticeList();
  const d = await loadNotices();
  renderNoticeTabs();
  renderNoticeList();
}

// 我的认领申请（用于详情里显示「审核中 / 已认领」状态）
async function loadMyClaims() {
  if (!state.user) { state.myClaims = []; return; }
  try { state.myClaims = await (await fetch('/api/me/claims')).json(); }
  catch { state.myClaims = []; }
}
function myClaimOf(workId) {
  const list = Array.isArray(state.myClaims) ? state.myClaims : [];
  return list.find(c => c.workId === workId && c.status === 'pending')
      || list.find(c => c.workId === workId && c.status === 'approved') || null;
}

// 登录报错内联显示：贴着登录按钮，不用 toast 飘在别处
function setLoginErr(msg) {
  const el = $('loginErr');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}

function setupAuthForms() {
  $('closeAuth').onclick = () => { stopWxScanPoll(); wxScanBackToForms(); hideModal(authModal); pendingPublish = false; };
  // 密码可见切换：登录、注册两个框共用一套逻辑（点一下显示，再点隐藏）
  const wirePwEye = (eyeId, inputId) => {
    const eye = $(eyeId), input = $(inputId);
    if (!eye || !input) return;
    eye.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.classList.toggle('is-on', show);
      input.focus();
    };
  };
  wirePwEye('loginPassEye', 'loginPass');
  wirePwEye('regPassEye', 'regPass');
  // 登录/注册弹窗不绑遮罩点击关闭：填了一半的账号密码不该被一次误触清掉，只留右上 ✕ 关闭
  $('toRegister').onclick = e => { e.preventDefault(); switchAuth('register'); };
  $('toLogin').onclick = e => { e.preventDefault(); switchAuth('login'); };
  // 昵称：自己动手改过就不再自动覆盖，「换一个」随时可重摇
  const regNick = $('regNick');
  const dice = $('regNickDice');
  if (regNick) regNick.addEventListener('input', () => { regNick.dataset.auto = ''; });
  if (dice) dice.onclick = () => {
    fillRegNick(true);
    dice.classList.remove('is-roll');
    void dice.offsetWidth;   // 强制回流，动画才重新播
    dice.classList.add('is-roll');
  };
  const ghBtn = $('ghLoginBtn');
  if (ghBtn) ghBtn.onclick = startGithubLogin;
  const gBtn = $('gLoginBtn');
  if (gBtn) gBtn.onclick = startGoogleLogin;
  const wxBtn = $('wxScanBtn');
  if (wxBtn) wxBtn.onclick = startWxScanLogin;
  const wxBack = $('wxScanBack');
  if (wxBack) wxBack.onclick = () => { stopWxScanPoll(); wxScanBackToForms(); };
  const wxRefresh = $('wxScanRefreshBtn');
  if (wxRefresh) wxRefresh.onclick = (e) => { e.preventDefault(); startWxScanLogin(); };

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('loginUpgrade');
    if (box) box.style.display = 'none'; // 重新提交时先收起上次的转注册提示
    setLoginErr('');
    const btn = $('loginBtn2');
    btn.disabled = true; btn.textContent = '登录中...';
    try {
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      payload.remember = !!fd.get('remember');
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        // 用户名不存在：给出「用这个名字和刚输的密码直接注册」的确认入口（不静默创建，防手滑打错名字多出账号）
        if (data.notFound) { showLoginUpgrade(String(fd.get('username') || ''), String(fd.get('password') || ''), payload.remember); return; }
        throw new Error(data.error || '登录失败');
      }
      afterAuth(data);
    } catch (err) { setLoginErr(err.message); }
    finally { btn.disabled = false; btn.textContent = '登录'; }
  });

// 登录时用户名不存在 → 展示「一键转注册」确认区（复用刚输入的用户名和密码，走完整注册校验）
function showLoginUpgrade(username, password, remember) {
  const box = $('loginUpgrade');
  if (!box || !username) { showToast('该用户名还没有注册', undefined, 'err'); return; }
  $('loginUpgradeText').innerHTML =
    `用户名「<b>${escapeHtml(username)}</b>」还没注册。要直接用它创建账号吗？（密码就是刚输入的这个，至少 6 位）`;
  $('upgradeRegBtn').onclick = async () => {
    const btn = $('upgradeRegBtn');
    btn.disabled = true; btn.textContent = '注册中...';
    try {
      const res = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 一键注册也带上随机昵称：否则展示名就是刚输的账号名，可能是个随手拼的字符串
        // nickAuto=1：这个名字是系统摇的，撞了别人的昵称请服务端直接换一个
        body: JSON.stringify({ username, password, nickname: randomNick(), nickAuto: 1, remember: !!remember, ref: (refStore() || {}).ref || '' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '注册失败');
      afterAuth(data);
    } catch (err) { showToast(err.message, undefined, 'err'); }
    finally { btn.disabled = false; btn.textContent = '一键注册并登录'; }
  };
  $('upgradeCancel').onclick = () => { box.style.display = 'none'; };
  box.style.display = '';
}

  $('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('registerBtn');
    btn.disabled = true; btn.textContent = '注册中...';
    try {
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      payload.remember = !!fd.get('remember');
      // 带上来路分享者：注册后由服务端判断是否给邀请人加分（同 IP 有严格上限）
      payload.ref = (refStore() || {}).ref || '';
      // 告诉服务端这个名字是系统摇的还是用户自己写的：摇出来的撞了名可以让服务端直接换，自己写的要尊重
      const regNickEl = $('regNick');
      payload.nickAuto = regNickEl && regNickEl.dataset.auto === '1' ? 1 : 0;
      const res = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        // 昵称撞了别人的账号名（随机名偶尔会撞）：换一个再让用户点，别停在一个用不了的名字上
        const msg = String(data.error || '注册失败');
        if (msg.includes('昵称') && payload.nickAuto) {
          fillRegNick(true);
          throw new Error(msg + '，已经换了一个，再点一次就好');
        }
        throw new Error(msg);
      }
      afterAuth(data);
      // 预填的随机名刚好被别人占了：服务端换了一个，告诉用户一声（名字变了别以为是 bug）
      if (data.nickAdjusted && data.nickname) showToast(`「${payload.nickname}」刚被别人用了，给你换成了「${data.nickname}」`, undefined, 'ok');
    } catch (err) { showToast(err.message, undefined, 'err'); }
    finally { btn.disabled = false; btn.textContent = '注册并登录'; }
  });
}

// ---------- GitHub / Google 登录与绑定 ----------
// 回调错误码 → 人话（服务端 /api/auth/*/callback 重定向时带在 ?auth_error= 上）
const AUTH_ERRORS = {
  github_disabled: '站点还没有配置 GitHub 登录',
  google_disabled: '站点还没有配置 Google 登录',
  denied: '你取消了授权',
  state_invalid: '授权链接已过期，重新点一次登录就好',
  bind_need_login: '请先登录，再绑定',
  github_already_bound: '这个账号已经绑定过 GitHub 了',
  google_already_bound: '这个账号已经绑定过 Google 了',
  github_taken: '这个 GitHub 已经绑在别的账号上了',
  google_taken: '这个 Google 已经绑在别的账号上了',
  oauth_error: '授权失败，稍后再试',
  too_frequent: '操作太频繁，稍等一下再试'
};

// 整页跳到后端 /start，由后端 302 到 GitHub；授权完由 /callback 写会话再跳回来
function startGithubLogin() {
  // 本来就是点了「投稿」才来登录的：跨页面跳转会丢掉这个意图，先记在本机
  if (pendingPublish) {
    try { localStorage.setItem('dm_pending_publish', '1'); } catch { /* 隐私模式无视 */ }
  }
  const next = location.pathname + location.search;
  location.href = '/api/auth/github/start?mode=login&next=' + encodeURIComponent(next);
}

// Google 同款：整页跳后端 /start，后端 302 到 Google 授权页
function startGoogleLogin() {
  if (pendingPublish) {
    try { localStorage.setItem('dm_pending_publish', '1'); } catch { /* 隐私模式无视 */ }
  }
  const next = location.pathname + location.search;
  location.href = '/api/auth/google/start?mode=login&next=' + encodeURIComponent(next);
}

// ---------- 微信扫码登录 ----------
// 不离开页面：弹窗里显示小程序码，手机确认后轮询自动登录（后端 /api/auth/wxscan/*）
let wxScanTimer = null;
function stopWxScanPoll() {
  if (wxScanTimer) { clearInterval(wxScanTimer); wxScanTimer = null; }
}
// 从二维码视图回到表单视图（关弹窗 / 点返回时都会调，幂等）
function wxScanBackToForms() {
  stopWxScanPoll();
  const panel = $('wxScanPanel');
  if (panel) panel.style.display = 'none';
  const oauth = $('authOauth');
  // 回到表单：第三方区块按当前端和已配置的 provider 重新决定显不显示（别在手机端亮出空的分隔线）
  if (oauth) applyAuthProviders();
  // 表单显示状态交给 switchAuth：按当前标题恢复（登录/注册保持原样）
  const mode = ($('authTitle') && $('authTitle').textContent.indexOf('注册') === 0) ? 'register' : 'login';
  const lf = $('loginForm'), rf = $('registerForm');
  if (lf) lf.style.display = mode === 'login' ? 'block' : 'none';
  if (rf) rf.style.display = mode === 'login' ? 'none' : 'block';
  const st = $('wxScanStatus');
  if (st) st.classList.remove('is-waiting');
}
async function startWxScanLogin() {
  stopWxScanPoll();
  const img = $('wxScanImg'), status = $('wxScanStatus'), refresh = $('wxScanRefresh');
  const panel = $('wxScanPanel'), oauth = $('authOauth');
  const loading = $('wxScanLoading'), loadingText = $('wxScanLoadingText');
  if (!panel || !img || !status) return;
  // 登录码就是小程序码：PC 是「手机扫码」，手机端扫不了自己的屏幕，改用两条路——
  //  ① 微信内打开：长按二维码 → 识别图中二维码，直接跳小程序确认（最顺）
  //  ② 普通浏览器：长按/按钮把码存到相册 → 微信扫一扫 → 相册选这张图
  const onMobile = window.innerWidth <= 640;
  const inWx = /MicroMessenger/i.test(navigator.userAgent);
  const tip = panel.querySelector('.wxscan-tip');
  const saveBtn = $('wxScanSave');
  if (tip) {
    tip.textContent = onMobile
      ? (inWx ? '长按上方二维码 → 识别图中二维码，确认后这里自动登录' : '长按二维码保存到手机相册 → 微信扫一扫 → 从相册选这张图')
      : '微信扫一扫 · 手机上确认后电脑自动登录';
  }
  if (saveBtn) saveBtn.style.display = (onMobile && !inWx) ? '' : 'none';
  $('loginForm').style.display = 'none';
  $('registerForm').style.display = 'none';
  if (oauth) oauth.style.display = 'none';
  panel.style.display = 'block';
  img.style.display = 'none';
  img.removeAttribute('src');
  refresh.style.display = 'none';
  // 点按钮就立刻亮占位：生成小程序码要几秒，晚一步弹窗会先空出一块，像点了没反应
  if (loading) loading.style.display = 'flex';
  if (loadingText) loadingText.textContent = '正在生成登录码…';
  status.style.display = '';
  status.classList.remove('is-waiting');
  status.textContent = '请稍候…';   // 占位卡已经说清在做什么，这行只兜个底，别重复念一遍
  // 保存到相册：iOS 上 <a download> 只会掉进「文件」App，相册里翻不到这张图，
  // 微信扫一扫的「相册」也就选不到——所以统一交给 saveImage 走系统分享面板
  if (saveBtn && !saveBtn._bound) {
    saveBtn._bound = 1;
    saveBtn.onclick = () => {
      const src = img && img.src;
      if (!src) return;
      saveImage(src, {
        name: '造梦橱窗登录码.png',
        iosHint: '登录二维码',
        toastOk: '已保存 · 打开微信扫一扫，点右上角相册选这张图'
      });
    };
  }
  try {
    const res = await fetch('/api/auth/wxscan/start', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '生成二维码失败');
    // 二维码图片本身要加载几秒：占位转圈一直留着，img onload 再换图，避免一块白底傻等
    img.style.display = 'none';
    if (loading) loading.style.display = 'flex';
    if (loadingText) loadingText.textContent = '二维码加载中…';
    status.style.display = '';
    img.onload = () => {
      if (loading) loading.style.display = 'none';
      img.style.display = '';
      prefetchSaveBlob(img.src);   // 真点了「保存」，share 才来得及在点击手势里弹面板
      status.style.display = '';
      status.classList.add('is-waiting');   // 出码后转成「等待中」：小转圈说明这边一直在轮询
      status.textContent = onMobile
        ? '在微信里打开确认页点确认，这里会自动登录（3 分钟内有效）'
        : '等待扫码中…（二维码 3 分钟内有效）';
    };
    img.onerror = () => {
      // 加载失败（少见）：不傻等，直接给刷新入口
      if (loading) loading.style.display = 'none';
      status.classList.remove('is-waiting');
      status.style.display = 'none';
      refresh.style.display = '';
    };
    img.src = d.qr;
    const ticket = d.ticket;
    const t0 = Date.now();
    wxScanTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/auth/wxscan/poll/' + encodeURIComponent(ticket), { cache: 'no-store' });
        const s = await r.json();
        if (s.status === 'ok') {
          stopWxScanPoll();
          wxScanBackToForms();
          afterAuth(s);   // 结构与 /api/login 响应一致（username/nickname/displayName）
          // 这个微信没绑过账号时后端会直接建号登录（不再让用户在手机上二选一），
          // 得说一句，不然用户会纳闷"我什么时候注册的"；老账号的收藏和作品能在小程序里合并过来
          if (s.created) {
            showToast(`已用这个微信创建新账号（${s.nickname || s.username}）。以前有账号的话，到小程序「我的 → 绑定已有账号」可以把作品和收藏合并过来，灯火留两边多的那份，另补 300 盏绑定奖励`, 8000);
          }
          return;
        }
        if (s.status === 'expired') {
          stopWxScanPoll();
          status.classList.remove('is-waiting');
          status.style.display = 'none';
          refresh.style.display = '';
          return;
        }
      } catch { /* 单次轮询失败不终止，下一轮继续 */ }
      if (Date.now() - t0 > 210000) {   // 兜底：超过 ticket 寿命还没结果就当作过期
        stopWxScanPoll();
        status.classList.remove('is-waiting');
        status.style.display = 'none';
        refresh.style.display = '';
      }
    }, 2000);
  } catch (err) {
    showToast(err.message, undefined, 'err');
    wxScanBackToForms();
  }
}

// OAuth 回来后的收尾：提示结果、清掉地址栏参数、补上跳转前没做完的事
function afterLoadAuth() {
  const p = new URLSearchParams(location.search);
  const err = p.get('auth_error');
  const okGh = p.get('github');
  const okG = p.get('google');
  if (err || okGh || okG) {
    p.delete('auth_error');
    p.delete('github');
    p.delete('google');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    if (err) {
      showToast(AUTH_ERRORS[err] || '第三方登录失败，请重试', undefined, 'err');
    } else {
      // github / google 两个参数只会来一个；文案按渠道分别写
      const via = okGh ? 'github' : 'google';
      const viaName = okGh ? 'GitHub' : 'Google';
      const prof = via === 'github' ? state.user && state.user.github : state.user && state.user.google;
      if (!state.user) showToast(`${viaName} 登录状态已失效，请重新登录`, undefined, 'err');
      else if ((okGh || okG) === 'bound') showToast(`${viaName} 已绑定：${(prof && (prof.login || prof.email || prof.name)) || ''}`);
      else if ((okGh || okG) === 'new') showToast(state.user.nickname
        ? `已用 ${viaName} 建号，作品上署名「${state.user.nickname}」，记得设个密码`
        : `已用 ${viaName} 建号 @${state.user.username}，头像菜单里能设昵称、设密码`);
      else showToast(`欢迎回来，${state.user.nickname || state.user.username}`, undefined, 'ok');
    }
  }
  // 第三方登录是整页跳转，登录前点的「投稿」在这里接上
  try {
    if (state.user && localStorage.getItem('dm_pending_publish') === '1') {
      localStorage.removeItem('dm_pending_publish');
      resetUploadForm();
      showModal(uploadModal);
    }
  } catch { /* 忽略 */ }
}

/* 独立页（/medals 等不接 SPA 的页面）把「登录 / 注册」写成 /?login=1 跳回来：
   落到首页后这里把登录框直接弹出来，不用再让人找一遍头部按钮。参数顺手清掉，
   免得刷新/后退又弹一次。 */
function openAuthFromQuery() {
  let p;
  try { p = new URLSearchParams(location.search); } catch { return; }
  if (p.get('login') !== '1' || state.user) return;
  p.delete('login');
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  openAuth('login');
}

function openGhModal() {
  if (!state.user) { openAuth('login'); return; }
  const mask = $('ghModal');
  const body = $('ghBody');
  const gh = state.user.github;
  const enabled = !!(state.providers && state.providers.github);
  const boundAt = gh && gh.connectedAt ? new Date(gh.connectedAt) : null;
  const dateText = boundAt && !isNaN(boundAt) ? `${boundAt.getFullYear()}-${String(boundAt.getMonth() + 1).padStart(2, '0')}-${String(boundAt.getDate()).padStart(2, '0')} 绑定` : '';

  if (!enabled) {
    body.innerHTML = `<p class="nick-tip">这个站点还没有配置 GitHub 应用，暂时用不了 GitHub 登录。<br />需要设置 <code>GITHUB_CLIENT_ID</code> / <code>GITHUB_CLIENT_SECRET</code> 后重启服务（见 DEPLOY.md）。</p>`;
  } else if (gh) {
    body.innerHTML = `
      <div class="gh-card">
        <img class="gh-avatar" src="${escapeHtml(gh.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" />
        <div class="gh-meta">
          <a class="gh-login" href="${escapeHtml(gh.url)}" target="_blank" rel="noopener">@${escapeHtml(gh.login)}</a>
          <span class="gh-sub">${dateText || '已绑定'}</span>
        </div>
      </div>
      <p class="nick-tip">绑定后可以直接用 GitHub 一键登录这个账号；作品、灯火、收藏都不会变。</p>
      <p class="nick-msg" id="ghMsg"></p>
      <div class="nick-actions">
        <button type="button" class="btn-ghost" id="ghUnbind">解绑 GitHub</button>
        <button type="button" class="btn-primary" id="ghClose2">关闭</button>
      </div>`;
    $('ghClose2').onclick = () => hideModal(mask);
    const un = $('ghUnbind');
    un.onclick = async () => {
      const msg = $('ghMsg');
      // GitHub 建的号还没设密码：解绑就彻底进不来了，后端也会拦，这里提前说清楚
      if (state.user.passSet === false) {
        if (msg) { msg.className = 'nick-msg err'; msg.textContent = '请先设置登录密码再解绑，否则解绑后就没法登录了'; }
        return;
      }
      if (!confirm(`确定解绑 @${gh.login} 吗？解绑后就不能再用 GitHub 登录这个账号了。`)) return;
      un.disabled = true;
      try {
        const r = await fetch('/api/me/github/unbind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (msg) { msg.className = 'nick-msg err'; msg.textContent = d.error || '解绑失败'; }
          return;
        }
        state.user.github = null;
        renderAuthBox();
        showToast('已解绑 GitHub', undefined, 'ok');
        openGhModal();   // 重渲染成「未绑定」态
      } catch {
        if (msg) { msg.className = 'nick-msg err'; msg.textContent = '网络异常，稍后再试'; }
      } finally { un.disabled = false; }
    };
  } else {
    body.innerHTML = `
      <p class="nick-tip">把 GitHub 绑到当前账号 <b>@${escapeHtml(state.user.username)}</b> 上，以后就能用 GitHub 一键登录，不用记这个站点的密码。</p>
      <p class="nick-tip">只会读取你的 GitHub 公开资料（用户名、头像），不会碰仓库和邮箱。</p>
      <div class="nick-actions">
        <button type="button" class="btn-ghost" id="ghCancel">取消</button>
        <button type="button" class="btn-primary btn-github-inline" id="ghBind"><span class="ico" data-ico="github"></span> 绑定 GitHub</button>
      </div>`;
    $('ghCancel').onclick = () => hideModal(mask);
    $('ghBind').onclick = () => {
      const next = location.pathname + location.search;
      location.href = '/api/auth/github/start?mode=bind&next=' + encodeURIComponent(next);
    };
    if (window.Icons) Icons.hydrate(body);
  }

  $('closeGh').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  showModal(mask);
}

// Google 绑定弹窗（与 GitHub 版同构）：已绑定展示资料 + 解绑；未绑定给一个绑定按钮
function openGModal() {
  if (!state.user) { openAuth('login'); return; }
  const mask = $('gModal');
  const body = $('gBody');
  const g = state.user.google;
  const enabled = !!(state.providers && state.providers.google);
  const boundAt = g && g.connectedAt ? new Date(g.connectedAt) : null;
  const dateText = boundAt && !isNaN(boundAt) ? `${boundAt.getFullYear()}-${String(boundAt.getMonth() + 1).padStart(2, '0')}-${String(boundAt.getDate()).padStart(2, '0')} 绑定` : '';
  const showName = g && (g.emailVerified ? g.email : (g.email || g.name || ''));

  if (!enabled) {
    body.innerHTML = `<p class="nick-tip">这个站点还没有配置 Google 应用，暂时用不了 Google 登录。<br />需要设置 <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> 后重启服务（见 DEPLOY.md）。</p>`;
  } else if (g) {
    body.innerHTML = `
      <div class="gh-card">
        <img class="gh-avatar" src="${escapeHtml(g.picture)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" />
        <div class="gh-meta">
          <span class="gh-login">${escapeHtml(showName || g.name || '已绑定')}</span>
          <span class="gh-sub">${dateText || '已绑定'}</span>
        </div>
      </div>
      <p class="nick-tip">绑定后可以直接用 Google 一键登录这个账号；作品、灯火、收藏都不会变。</p>
      <p class="nick-msg" id="gMsg"></p>
      <div class="nick-actions">
        <button type="button" class="btn-ghost" id="gUnbind">解绑 Google</button>
        <button type="button" class="btn-primary" id="gClose2">关闭</button>
      </div>`;
    $('gClose2').onclick = () => hideModal(mask);
    const un = $('gUnbind');
    un.onclick = async () => {
      const msg = $('gMsg');
      // Google 建的号还没设密码：解绑就彻底进不来了，后端也会拦，这里提前说清楚
      if (state.user.passSet === false) {
        if (msg) { msg.className = 'nick-msg err'; msg.textContent = '请先设置登录密码再解绑，否则解绑后就没法登录了'; }
        return;
      }
      if (!confirm(`确定解绑 ${showName || 'Google 账号'} 吗？解绑后就不能再用 Google 登录这个账号了。`)) return;
      un.disabled = true;
      try {
        const r = await fetch('/api/me/google/unbind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (msg) { msg.className = 'nick-msg err'; msg.textContent = d.error || '解绑失败'; }
          return;
        }
        state.user.google = null;
        renderAuthBox();
        showToast('已解绑 Google', undefined, 'ok');
        openGModal();   // 重渲染成「未绑定」态
      } catch {
        if (msg) { msg.className = 'nick-msg err'; msg.textContent = '网络异常，稍后再试'; }
      } finally { un.disabled = false; }
    };
  } else {
    body.innerHTML = `
      <p class="nick-tip">把 Google 账号绑到当前账号 <b>@${escapeHtml(state.user.username)}</b> 上，以后就能用 Google 一键登录，不用记这个站点的密码。</p>
      <p class="nick-tip">只会读取你的 Google 公开资料（昵称、头像、邮箱），不会碰网盘、通讯录等任何其他数据。</p>
      <div class="nick-actions">
        <button type="button" class="btn-ghost" id="gCancel">取消</button>
        <button type="button" class="btn-primary btn-google-inline" id="gBind"><span class="ico" data-ico="google"></span> 绑定 Google</button>
      </div>`;
    $('gCancel').onclick = () => hideModal(mask);
    $('gBind').onclick = () => {
      const next = location.pathname + location.search;
      location.href = '/api/auth/google/start?mode=bind&next=' + encodeURIComponent(next);
    };
    if (window.Icons) Icons.hydrate(body);
  }

  $('closeG').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  showModal(mask);
}

// ---------- 卡片渲染 ----------
// 开源徽章：闭源是默认状态，不标注——没信息量，纯视觉噪音
function osBadgeHtml(w, cls = '') {
  if (w.openSource === true) return `<span class="os-badge open ${cls}" title="开放源代码"><span class="ico">${ic('lock-open')}</span> 开源</span>`;
  return '';
}

// 付费徽章：默认免费不显示（打赏人人可送，不再有「可送灯火」徽章）；灯火解锁单独说
function paidBadgeHtml(w, cls = '') {
  if (w.paidModel === 'lamp' && w.lampPrice) {
    return `<span class="os-badge paid ${cls}" title="需要用 ${w.lampPrice} 盏灯火解锁，才能看到网页 / 下载 / 小程序入口"><span class="ico">${ic('lock')}</span> ${w.lampPrice} 盏解锁</span>`;
  }
  if (!w.paid) return '';
  const label = PAID_MODELS[w.paidModel] || '付费';
  const tip = PAID_MODELS[w.paidModel] ? `付费作品（${label}）` : '需要付费或含付费版本';
  return `<span class="os-badge paid ${cls}" title="${tip}"><span class="ico">${ic('coin')}</span> ${escapeHtml(label)}</span>`;
}

// 作品阶段：live 已上线 / reviewing 等平台上架审核 / wip 还在做（预告）
// 与服务端 stageOf 保持一致；老数据没有这个字段一律当 live
function stageOf(w) {
  return w && ['live', 'reviewing', 'wip'].includes(w.stage) ? w.stage : 'live';
}
function isComing(w) { return stageOf(w) !== 'live'; }
// 阶段徽标：预告是蓝色「开发中 · 65%」，平台上架审核是琥珀色「等上架审核」
function stageBadgeHtml(w, cls = '') {
  const st = stageOf(w);
  if (st === 'live') return '';
  if (st === 'wip') {
    const pct = typeof w.progress === 'number' ? ` · ${w.progress}%` : '';
    return `<span class="stage-badge is-wip ${cls}" title="作者还在做，点进去可以订阅上线提醒"><span class="ico">${ic('construction')}</span> 开发中${pct}</span>`;
  }
  return `<span class="stage-badge is-review ${cls}" title="正在应用商店 / 平台的审核中，通过后才能访问">等上架审核</span>`;
}
// 预告卡的进度条 + 催更数（上线后这几行就不显示了）
function comingMetaHtml(w) {
  if (!isComing(w)) return '';
  const pct = typeof w.progress === 'number' ? w.progress : 0;
  const eta = w.eta ? ` · 预计 ${w.eta.replace(/^\d{4}-/, '').replace('-', '/')} 上线` : '';
  return `
    <div class="coming-bar"><span style="width:${pct}%"></span></div>
    <div class="coming-meta">
      <span><span class="ico">${ic('bell')}</span> ${w.watchCount || 0} 人等着${eta}</span>
    </div>`;
}

// 作者首字母头像：没有上传头像体系，用昵称首字做一个彩色圆点，比纯文字更有「人在场」
// 颜色按账号名稳定 hash：同人永远同色，同名不同人颜色不同（匿名作品按住不着色）
function avaChip(w) {
  const nm = anamePlain(w);
  const ch = (nm || '?').slice(0, 1).toUpperCase();
  const key = w && !w.anonymous ? (w.author || dname(w)) : '';
  const style = key ? ` style="background:${avaColor('u:' + key)}"` : '';
  return `<span class="ava-chip" aria-hidden="true"${style}>${escapeHtml(ch)}</span>`;
}

// 卡片数据行：零值不渲染（2026-11-09）。
// 一件刚上架的作品最常被看到的不是「有人在用」，而是「0 赞 0 收藏」——这是首屏最贵的劝退。
// 没有任何互动时，这一行只留发布时间；有数据才把对应的段显出来。
// 收藏段必须始终留在 DOM 里（data-fav-count / data-fav-seg 要靠它实时改数），用 is-zero 隐藏。
function cardStatsHtml(w) {
  const cc = w.commentCount || 0;
  const seg = [];
  if (w.likes > 0) seg.push(`<span class="stat-seg"><span class="ico s-ico">${ic('heart')}</span>${w.likes}</span>`);
  seg.push(`<span class="stat-seg fav-seg${(w.favs || 0) > 0 ? '' : ' is-zero'}" data-fav-seg="${w.id}"><span class="ico s-ico">${ic('star')}</span><span class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</span></span>`);
  if (w.views > 0) seg.push(`<span class="stat-seg"><span class="ico s-ico">${ic('eye')}</span>${w.views}</span>`);
  // 评论段常驻 DOM：刚有人评论时要从 0 变 1（paintCommentCount 负责显隐），不能在渲染时就砍掉
  seg.push(`<span class="stat-seg cmt-seg${cc > 0 ? '' : ' is-zero'}" data-cmt-seg="${w.id}"><span class="ico s-ico">${ic('chat')}</span><span class="cmt-num" data-comment-count="${w.id}" data-count="${cc}" data-prefix="">${cc}</span></span>`);
  return seg.join('');
}

// 卡片标题两行：存库 title = 投稿表单「名字 wname（最长 20，汉字算 2）+ 一句话介绍 wtag（≤20字）」
// 两框合一，中间是唯一的分隔符 —— 一个空格（TITLE_SEP）。卡片要把介绍挪到第二行灰字，
// 所以只认这一个空格拆分。
// 2026-11-10 晚（用户拍板）：标点 / 短横线的「猜着拆」全部下掉 —— 「敲敲键 KeyQiao，教孩子…」
// 这类标题到底哪儿该断，站长在后台自己切（名字、一句话介绍两个框），不再由渲染时猜。
// 只保留表单自己的产物「名字 介绍」这一条，否则新投稿的卡片第二行介绍会整条消失。
// 防误拆：名字 ≤10 字且不含空格 / 连字符，介绍 ≤20 字，且介绍必须以中文开头
//   ——「敲敲键 KeyQiao，教孩子免费趣味练打字」「油小猴 AI 侧边栏 - 浏览器智能体」
//   这类第二段是英文/标点开头的，说明不是表单拼出来的，一律不拆；
//   纯英文名字（vibeoffice、knovum）放宽：名字 ≥3 字符才拆，「AI 女装试穿网站」不拆。
// 拆不开的整条当名字，第二行退详情摘要（introText）。
const CJK_RE = /[\u4e00-\u9fff]/;
function splitCardTitle(t) {
  const s = String(t || '').trim();
  const m = s.match(/^([^\s-]{1,10})\s+(.{1,20})$/);
  if (m && CJK_RE.test(m[2][0]) && (CJK_RE.test(m[1]) || m[1].length >= 3)) return [m[1], m[2]];
  return [s, ''];
}
// 卡片两行文案：第一行名字，第二行「一句话介绍优先，没有退详情摘要」（都没有就是空占位行，保对齐）
// 优先用表单存下的拆分（w.titleName / w.titleTag）：站长在后台手切的名字 + 一句话介绍
// 原样生效，不受「介绍必须以中文开头」这类防误拆规则限制（如「日影 / mac活动追踪器-31天免试用」）。
// 老数据没有这两个字段，才回落到 splitCardTitle 猜一次。
// 第二行用 cardDesc（服务端按句读切好的首句，约 22 字）：卡片是单行 nowrap，
// 拿 160 字的 introText 来必然被 CSS 二次切断，出「…才能定位到原文的具体段」这种半句。
function cardTitleLines(w) {
  const intro = (w.cardDesc || w.introText || '').replace(/\s+/g, ' ').trim();
  const savedTag = String(w.titleTag || '').trim();
  if (savedTag) return [String(w.titleName || w.title || '').trim(), savedTag];
  const [name, tag] = splitCardTitle(w.title);
  return [name, tag || intro];
}

// 详情弹窗标题拆分：口径同卡片（titleName / titleTag 优先，老数据按空格猜一次），
// 但猜不开时不退 introText——详情下方本来就渲染完整介绍，标题里再来一遍就重复了。
// 拆不开就整条当名字，展示效果和以前完全一样。
function detailTitleParts(w) {
  const savedTag = String(w.titleTag || '').trim();
  if (savedTag) return [String(w.titleName || w.title || '').trim(), savedTag];
  return splitCardTitle(w.title);
}

// ---------- 卡片上的「众判中 N」角标 ----------
// 什么时候挂由服务端 jury.card 决定（认定票 sus 多于反对票 ok，且达到 JURY_CARD_MIN）。
// 前端一个字都别自己比：站长改后端门槛时，列表和详情要跟着一起变。
// 角标是按钮：点一下直接开详情并展开众判投票区 —— 挂牌的意思就是「喊人来判」，
// 点开却停在折叠的「参与众判 ›」上，等于白挂。
function juryChipHtml(w, inline) {
  const j = w.jury;
  if (!j || !j.card) return '';
  const n = Number(j.sus) || 0;
  const okN = Number(j.ok) || 0;
  const gap = Number(j.gap) || 5;
  const tip = `${n} 人觉得像站外推广、${okN} 人认为不像推广：推广票比反对票多 ${gap} 票就下架整改。点这里参与众判`;
  return inline
    ? `<button type="button" class="jury-chip-inline" data-jury-jump="${escapeHtml(w.id)}" title="${escapeHtml(tip)}">众判中 ${n} ›</button>`
    : `<button type="button" class="jury-chip" data-jury-jump="${escapeHtml(w.id)}" title="${escapeHtml(tip)}">众判中 ${n} ›</button>`;
}

// 我的主页卡片下的作者操作行（2026-11-14）：编辑 / 上架·下架 / 推荐 / 小程序详情页。
// 只在作者主页的作品 tab 渲染（ownerTools 且 w.owned 双保险），首页/榜单的同款卡片不受影响。
// 上架·下架是一颗按钮：下架走的是详情弹窗同一条 visibility 接口，数据全保留。
function cardOwnerToolsHtml(w) {
  const hid = !!w.hidden;
  return `<div class="card-own-tools">
    <button type="button" class="cot-btn is-edit" data-ow-edit title="修改作品信息、图片和链接">${ic('edit', 13)} 编辑</button>
    <button type="button" class="cot-btn${hid ? ' is-relist' : ' is-quiet'}" data-ow-toggle="${w.id}" data-ow-hidden="${hid ? 1 : 0}" title="${hid ? '重新上架：作品恢复公开，重新进首页/榜单/搜索' : '下架后别人看不到，只有你自己能看；数据保留，随时可重新上架'}">${ic('eye', 13)} ${hid ? '上架' : '下架'}</button>
    <button type="button" class="cot-btn is-promo" data-ow-promo title="用灯火把这件作品换到首页、榜单等推荐位">${ic('promo', 13)} 推荐</button>
    <button type="button" class="cot-btn" data-ow-mini="${w.id}" data-ow-title="${escapeHtml(w.title)}" title="出一张小程序码，扫码直达小程序里这件作品的详情页">${ic('mini', 13)} 小程序详情页</button>
  </div>`;
}

function cardHtml(w, opts = {}) {
  const types = typesOf(w);
  const cc = w.commentCount || 0;
  const [ctName, ctIntro] = cardTitleLines(w);
  const ownTools = !!opts.ownerTools && !!w.owned;
  return `
    <div class="card${opts.rank ? ' rank-card' : ''}${ownTools && w.hidden ? ' is-self-hidden' : ''}" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <div class="card-img-wrap">
        ${juryChipHtml(w)}
        ${opts.rank ? `<span class="rank-num${opts.rank <= 3 ? ' top3 r' + opts.rank : ''}" aria-label="第 ${opts.rank} 名">${opts.rank}</span>` : ''}
        <img class="card-img" src="${imgUrl(w.thumb, 400)}" srcset="${imgSet(w.thumb)}"
             sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 260px"
             alt="${escapeHtml(w.title)}"${opts.eager ? ' fetchpriority="high"' : ' loading="lazy"'} />
        <span class="type-badge" title="${escapeHtml(types.join(' / '))}">${typeTextHtml(w)}</span>
        ${w.pinned ? '<span class="pin-badge">置顶</span>' : ''}
        ${stageBadgeHtml(w, 'card-stage')}
        ${paidBadgeHtml(w, 'img-paid')}
        ${isComing(w) ? '' : `<button class="fav-star ${isFav(w.id) ? 'active' : ''}" data-fav="${w.id}" title="收藏">${ic('fav')}</button>`}
        ${isComing(w) ? '' : `<button class="fav-star card-share" data-share-work="${w.id}" title="分享：生成带二维码的分享图，发朋友圈/小红书都行">${ic('sharecard')}</button>`}
        ${w.owned ? '' : `<button class="fav-star card-block" data-blockwork="${w.id}" data-bw-title="${escapeHtml(w.title)}" title="不再看这个作品（只对你生效）" aria-label="不再看这个作品">${ic('block')}</button>`}
      </div>
      <div class="card-body">
        ${ownTools && w.hidden ? '<div class="self-hidden-note" title="你自主下架的作品：只有你自己能看到，点下方「上架」恢复公开">已下架 · 仅自己可见</div>' : ''}
        <div class="card-title">${escapeHtml(ctName)}</div>
        <div class="card-desc">${escapeHtml(ctIntro)}</div>
        <div class="card-meta">
          <span class="card-author">${avaChip(w)}${ghMedalHtml(w.authorTags)}<span class="author-name">${escapeHtml(anamePlain(w))}</span></span>
          <span class="card-tags"><span class="card-cat">${escapeHtml(w.category)}</span>${osBadgeHtml(w)}</span>
        </div>
        ${opts.metricLabel ? `<div class="card-rank-metric"><span class="card-rank-metric-label">${escapeHtml(opts.metricLabel)}</span><b class="card-rank-metric-val">${opts.metricValue}</b></div>` : ''}
        ${comingMetaHtml(w)}
        <div class="card-meta card-foot">
          <span class="stat-line">${cardStatsHtml(w)}</span>
          <span>${formatDate(w.createdAt)}</span>
        </div>
        ${ownTools ? cardOwnerToolsHtml(w) : ''}
      </div>
    </div>`;
}

// 列表视图：一行一个作品，紧凑排版（参考 Product Hunt 风格）
function listHtml(w) {
  const cc = w.commentCount || 0;
  const [ctName, ctIntro] = cardTitleLines(w);
  const juryChip = juryChipHtml(w, true);   // 认定票占多数才出（口径见 juryChipHtml）；放 meta 行首，
  // H5 的 .row-meta 是 nowrap+ellipsis，放行尾会被整段截掉，入口等于不存在
  return `
    <div class="work-row" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <img class="row-thumb" src="${imgUrl(w.thumb, 400)}" alt="${escapeHtml(w.title)}" loading="lazy" />
      <div class="row-main">
        <div class="row-title">${w.pinned ? '<span class="pin-badge row-pin">置顶</span>' : ''}${escapeHtml(ctName)}</div>
        ${ctIntro ? `<div class="row-intro">${escapeHtml(ctIntro)}</div>` : ''}
        <div class="row-meta">${juryChip ? `${juryChip} · ` : ''}${escapeHtml(typeText(w))} · ${ghMedalHtml(w.authorTags)}${escapeHtml(aname(w))} · ${escapeHtml(w.category)}${w.openSource === true ? ` · <span class="ico">${ic('lock-open')}</span> 开源` : ''}${w.paidModel === 'lamp' && w.lampPrice ? ` · <span class="ico">${ic('lock')}</span> ${w.lampPrice} 盏解锁` : ''}${w.paid ? ` · <span class="ico">${ic('coin')}</span> ${escapeHtml(PAID_MODELS[w.paidModel] || '付费')}` : ''}</div>
      </div>
      <div class="row-stats">
        ${/* 四段全部常驻 DOM，0 值挂 is-zero（visibility:hidden 占位不显示）——
             行与行之间右列数据才对得齐；此前赞/浏览 0 值直接不渲染，整列会左右漂（2026-11-11） */''}
        <span class="row-stat${(w.likes || 0) > 0 ? '' : ' is-zero'}">${ic('heart')} <b>${w.likes || 0}</b></span>
        <span class="row-stat fav-seg${(w.favs || 0) > 0 ? '' : ' is-zero'}" data-fav-seg="${w.id}">${ic('star')} <b class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</b></span>
        <span class="row-stat${(w.views || 0) > 0 ? '' : ' is-zero'}">${ic('eye')} <b>${w.views || 0}</b></span>
        <span class="row-stat cmt-seg${cc ? '' : ' is-zero'}" data-cmt-seg="${w.id}">${ic('chat')} <b class="cmt-num" data-comment-count="${w.id}" data-count="${cc}" data-prefix="">${cc}</b></span>
      </div>
      <button class="row-fav ${isFav(w.id) ? 'active' : ''}" data-fav="${w.id}" title="收藏">${ic('fav')}</button>
      ${/* 自己的作品不放「不看这个」，但按钮本体要留着占位（visibility:hidden），
            否则这一行右侧比别人窄、收藏圆钮和别的行对不齐（2026-11-11 站长截图反馈） */''}
      <button class="row-block${w.owned ? ' is-owned' : ''}" data-blockwork="${w.id}" data-bw-title="${escapeHtml(w.title)}" title="不再看这个作品（只对你生效）" aria-label="不再看这个作品"${w.owned ? ' tabindex="-1" aria-hidden="true"' : ''}>${ic('block')}</button>
    </div>`;
}

// 封面统一比例（4:3，cover 裁切，CSS 里定义）：横图、竖版手机截图都裁成同一块画面，
// 列表节奏整齐，也不会再出现「小图 + 大片留白」的观感差异。
// 以前对竖版图做过 contain + 模糊底图的补丁，这里不再需要，已移除。

// ---------- 卡片滚动渐显（样式在 style.css 的 html.rv-on .rv） ----------
// 只在真正能动的环境里启用：没有 IntersectionObserver 或用户要求减少动效时，
// rvSupported 为 false，html 不会加 rv-on，CSS 里的隐藏规则就不会生效，列表照常直接显示。
const rvSupported = typeof IntersectionObserver === 'function'
  && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const rvIO = rvSupported ? new IntersectionObserver(entries => {
  entries.forEach(en => {
    if (!en.isIntersecting) return;
    en.target.classList.add('in');
    rvIO.unobserve(en.target);   // 只进场一次，回头再滚不重播
  });
}, { rootMargin: '0px 0px 120px 0px', threshold: 0.01 }) : null;   // 底部放宽 120px：卡片在进入视口之前就解锁，避免屏幕最下沿先露出一块空白
if (rvIO) document.documentElement.classList.add('rv-on');

let rvSeq = 0;   // 同一批卡片错位浮现，最多错开 275ms，别让最后一张等太久
function revealCards(container) {
  if (!rvIO || !container || !container.querySelectorAll) return;
  const vh = window.innerHeight || 800;
  container.querySelectorAll('.card, .rk-row, .work-row, .rank-item').forEach(el => {
    if (el.classList.contains('rv') || el.classList.contains('is-rv-skip')) return;
    const r = el.getBoundingClientRect();
    if (r.top < vh * 0.92) {
      // 已经在首屏里：立刻显示，不参与动画（这些卡很可能就是首屏的 LCP 元素）
      el.classList.add('rv', 'in');
      return;
    }
    el.style.setProperty('--rv-d', (rvSeq++ % 6) * 55 + 'ms');
    el.classList.add('rv');
    rvIO.observe(el);
  });
}

// 单张卡片的交互（点开详情 / 收藏 / 分享 / 屏蔽）。
// 整批渲染（bindCards）和「编辑保存后就地换掉一张卡」（patchWorkInList）共用这一份，
// 换卡片时只绑新节点，别再把整批重绑一遍——重复绑会让收藏按钮一次点出两次请求，等于点了又取消
function bindCardNode(el) {
  if (!el) return;
  if (el.classList.contains('promo-card') || el.classList.contains('promo-row')) return;   // 推荐卡自己管点击
  el.addEventListener('click', e => {
    if (e.target.dataset.fav || e.target.dataset.shareWork) return;
    // 卡片里有一层真实链接（卡片底部 <a class="card-link">）：
    // Ctrl/⌘/Shift 点击交给浏览器在新标签打开完整页面，普通点击仍用弹窗
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openWork(el.dataset.id);
  });
  el.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.fav;
      const added = await toggleFav(id);
      if (added === null) return; // 未登录（已弹登录框）或失败（已提示）
      paintFavButtons(id);
      showToast(added ? '已加入收藏' : '已取消收藏', undefined, 'ok');
    });
  });
  el.querySelectorAll('[data-share-work]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      shareWorkDirect(btn.dataset.shareWork);
    });
  });
  el.querySelectorAll('[data-jury-jump]').forEach(btn => {
    btn.addEventListener('click', e => {
      // 角标铺在 .card-link（z-index:2）上面，不 stop 就会先被卡片的统一点击接走，
      // 那样只会打开详情、停在折叠状态，「去投票」等于没去
      e.stopPropagation();
      e.preventDefault();
      openWork(btn.dataset.juryJump, true, { jury: true });
    });
  });
  el.querySelectorAll('[data-blockwork]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      askBlockWork(btn.dataset.blockwork, btn.dataset.bwTitle || '', btn);
    });
  });
  // ---------- 我的主页卡片操作行（编辑 / 上架·下架 / 推荐 / 小程序详情页） ----------
  // 编辑：拉一份完整作品数据再交给编辑器（和详情弹窗「编辑作品」同一套链路）
  el.querySelectorAll('[data-ow-edit]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      const id = el.dataset.id;
      if (!id) return;
      try {
        const r = await fetch(`/api/works/${encodeURIComponent(id)}`, { cache: 'no-store' });
        const full = await r.json().catch(() => ({}));
        if (!r.ok || full.error) { showToast(full.error || '作品加载失败，请重试', undefined, 'err'); return; }
        if (full.adminEdit === true && !full.owned) return openAdminEdit(full);
        if (editWorkFn) editWorkFn(full);
        else showToast('编辑器还没准备好，刷新页面再试', undefined, 'err');
      } catch { showToast('网络异常，请稍后再试', undefined, 'err'); }
    });
  });
  // 上架 / 下架：和详情弹窗的 toggleHide 同一条接口；成功后就地换卡（按钮文案随 hidden 翻转）
  el.querySelectorAll('[data-ow-toggle]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.owToggle;
      const hiding = btn.dataset.owHidden !== '1';   // 当前没藏 → 这次要藏；已藏 → 这次要上架
      const cached = authorTabState.works.find(x => String(x.id) === String(id));
      const title = cached ? cached.title : '这件作品';
      if (hiding && !confirm(`确定下架「${title}」吗？下架后别人看不到，只有你自己能看；数据保留，随时可重新上架。`)) return;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/works/${encodeURIComponent(id)}/visibility`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hidden: hiding })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { showToast(d.error || '操作失败', undefined, 'err'); return; }
        showToast(d.hidden ? '已下架 · 现在只有你自己能看到' : '已重新上架，作品恢复公开', undefined, 'ok');
        const hit = authorTabState.works.findIndex(x => String(x.id) === String(id));
        if (hit >= 0) authorTabState.works[hit] = d;   // d 是完整 publicWork，直接顶掉旧数据
        patchWorkInList(d);
      } catch { showToast('网络异常，请稍后再试', undefined, 'err'); }
      finally { btn.disabled = false; }
    });
  });
  // 推荐：与全站各处入口同一条链路（未登录先弹登录，再进 /promote 选位投放）
  el.querySelectorAll('[data-ow-promo]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      openRedeem();
    });
  });
  // 小程序详情页：出一张直达本站小程序详情页（pages/detail/index，scene=w:<id>）的小程序码。
  // 浏览器打不开小程序，码是唯一通道——和分享海报用的是同一个接口，能直接吃缓存。
  el.querySelectorAll('[data-ow-mini]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.owMini;
      const title = btn.dataset.owTitle || '这件作品';
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await fetch('/api/mini/poster', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workId: id })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.qr) throw new Error(d.error || '码暂时取不到，稍后再试');
        openQrZoom(d.qr, `微信扫一扫，直达小程序里「${title}」的详情页`);
      } catch (err) { showToast(err.message || '网络异常，请稍后再试', undefined, 'err'); }
      finally { btn.disabled = false; }
    });
  });
}

function bindCards(container) {
  container.querySelectorAll('.card, .work-row, .rk-row').forEach(bindCardNode);
  // 卡片渲染完再挂渐显：新插进来的卡在视口下方才会被标记，首屏卡直接显示
  revealCards(container);
}

// ---------- 不再看这个作品（永久屏蔽，只影响我自己的列表） ----------
// 个人屏蔽 = user.blocked 里的一个作品 id，没有过期时间、不会自动恢复，
// 只能在「我的主页 / 账号设置 → 屏蔽管理」里手动恢复。
// 别把它和 server.js 的「屏蔽降权计票」混为一谈：那是另一套票数（每张票 30 天内有效），
// 只影响首页「最新」的展示位置，既不是「30 天后自动恢复」，也不改变个人屏蔽是否生效。
// 这里只做一件事——把它从我的列表里摘掉，随时可恢复。
let pendingBlock = null;   // { id, title, btn }
function askBlockWork(id, title, btn) {
  if (!state.user) { openAuth('login'); return; }
  pendingBlock = { id, title, btn };
  $('blockWorkTitle').innerHTML = `<span class="ico">${ic('block')}</span>《${escapeHtml(title || '这个作品')}》`;
  $('closeBlockWork').onclick = cancelBlockWork;
  $('blockWorkCancel').onclick = cancelBlockWork;
  bindMaskClose(blockWorkModal, cancelBlockWork);
  $('blockWorkConfirm').onclick = doBlockWork;
  showModal(blockWorkModal);
}

function cancelBlockWork() {
  pendingBlock = null;
  hideModal(blockWorkModal);
}

async function doBlockWork() {
  const p = pendingBlock;
  if (!p) return;
  const btn = $('blockWorkConfirm');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/works/${encodeURIComponent(p.id)}/block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '操作失败');
    state.blocked = Array.isArray(data.blocked) ? data.blocked : state.blocked;
    pendingBlock = null;
    hideModal(blockWorkModal);
    renderAuthBox();
    removeWorkFromList(p.id);
    showToast('已隐藏，之后不再出现在你的列表里', undefined, 'ok', {
      label: '撤销',
      onClick: () => undoBlockWork(p.id)
    });
  } catch (err) {
    showToast(err.message || '操作失败，请稍后重试', undefined, 'err');
  } finally {
    btn.disabled = false;
  }
}

// 就地把卡片/列表行摘掉，不整页重载——否则已加载的分页和滚动位置都会丢
function removeWorkFromList(id) {
  let removed = 0;
  document.querySelectorAll(`.card[data-id="${id}"], .work-row[data-id="${id}"]`).forEach(el => {
    el.remove();
    removed++;
  });
  if (!removed) return;
  const cnt = $('workCount');
  const cur = parseInt((cnt.textContent.match(/\d+/) || [0])[0], 10) || 0;
  if (cur > 0) cnt.textContent = `共 ${cur - removed} 件`;
  const empty = $('empty');
  if (empty && !gallery.children.length) empty.style.display = 'block';
}

// 编辑保存后只换掉列表里的那卡，不重拉整页——否则首页会被清空重画、滚动位置钳回顶部，
// 站长在首页中间改一件作品，关掉弹窗就被甩回页首，看着像页面重载了一次。
// 只认首页 #gallery 和作者主页 #authorGallery（卡片 / 列表行都是 cardHtml、listHtml 渲的）；
// 榜单行（.rk-row）按名次和热度分渲染，就地换会丢掉名次和分数，留给下次自然刷新。
// 返回换到了几张，0 表示当前页面没有这张卡。
function patchWorkInList(w) {
  if (!w || !w.id) return 0;
  const id = CSS.escape(String(w.id));
  let hit = 0;
  ['#gallery', '#authorGallery'].forEach(sel => {
    const box = document.querySelector(sel);
    if (!box) return;
    box.querySelectorAll(`.card[data-id="${id}"], .work-row[data-id="${id}"]`).forEach(el => {
      const isRow = el.classList.contains('work-row');
      // 随便逛逛的「重温 / 新」角标是渲染时才挂的（作品数据里没有），换卡时原地读出来再贴回去
      const wasRevisit = !!el.querySelector('.wander-re');
      // 作者主页的作品卡带操作行：编辑保存 / 上下架后就地换卡时，操作行要跟回去（首页 #gallery 不带）
      const ownerTools = !isRow && !!w.owned && !!el.closest('#authorGallery');
      const raw = isRow ? listHtml(w) : cardHtml(w, ownerTools ? { ownerTools: true } : {});
      const tpl = document.createElement('div');
      tpl.innerHTML = decorateWanderCard(raw, w, isRow, wasRevisit);
      const fresh = tpl.firstElementChild;
      if (!fresh) return;
      el.replaceWith(fresh);
      bindCardNode(fresh);   // 只绑新节点：整批重绑会让收藏按钮一次点出两次请求
      hit++;
    });
    if (hit) revealCards(box);   // revealCards 只标记还没挂过 .rv 的节点，对老卡无副作用
  });
  return hit;
}

async function undoBlockWork(id) {
  try {
    const res = await fetch(`/api/works/${encodeURIComponent(id)}/block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '恢复失败');
    state.blocked = Array.isArray(data.blocked) ? data.blocked : state.blocked;
    renderAuthBox();
    showToast('已恢复显示', undefined, 'ok');
    // 撤销要把刚摘掉的卡片放回来，重新拉一遍当前列表最省事
    if (location.pathname.startsWith('/w/')) route();
    else loadWorks(true);
  } catch (err) {
    showToast(err.message || '恢复失败，去「屏蔽管理」里试试', undefined, 'err');
  }
}

// 列表顶部那条「已隐藏 N 件」已去掉：列表保持干净，入口统一放「我的主页 → 屏蔽管理」

// ---------- 数据加载 ----------
// 场景表：服务端已经把「哪些场景有作品、各多少件」算好了（判定规则在 server.js 的 sceneKeysOf），
// 前端只负责展示和传参，不在本地再抄一份归类规则——两边各写一套迟早会对不上。
async function loadScenes() {
  try {
    const list = await (await fetch('/api/scene-meta', { cache: 'no-store' })).json();
    SCENES = Array.isArray(list) ? list : [];
  } catch { SCENES = []; }
  // 选中的场景没了（后台改了配置/作品下线）：退回全部，别让下拉里挂着一个筛不出东西的空项
  if (state.scene !== '全部' && !SCENES.some(s => s.key === state.scene)) state.scene = '全部';
}
function sceneNameOf(key) {
  const s = SCENES.find(x => x.key === key);
  return s ? s.name : '全部场景';
}

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    CATEGORIES = await res.json();
  } catch {
    CATEGORIES = ['全部', '效率工具', '生活助手', '内容创作', '学习教育', '娱乐游戏', '开发工具'];
  }
  if (!CATEGORIES.includes(state.category)) state.category = '全部';
  // 榜单的分类筛选跟分类表对齐：URL 带来的旧分类/已删除的分类不保留，免得下拉里挂着一个空选项
  if (rankState.cat !== '全部' && !CATEGORIES.includes(rankState.cat)) rankState.cat = '全部';
  if (renderCatPickerFn) renderCatPickerFn(); // 表单里的分类胶囊同步刷新
  // 统计各形态/分类的作品数，筛选下拉选项后面带数字
  try {
    // 全量拉取统计各分类/形态数量（pageSize=all 表示不分页）
    const list = (await (await fetch('/api/works?pageSize=all')).json()).items || [];
    typeCounts = {}; catCounts = {}; osCounts = { open: 0, closed: 0 };
    list.forEach(w => {
      const cats = Array.isArray(w.categories) && w.categories.length ? w.categories : (w.category ? [w.category] : []);
      cats.forEach(c => { catCounts[c] = (catCounts[c] || 0) + 1; }); // 多分类各计一次
      typesOf(w).forEach(t => { typeCounts[t] = (typeCounts[t] || 0) + 1; });
      if (w.openSource === true) osCounts.open++; else osCounts.closed++;
    });
    totalWorks = list.length;
  } catch { /* 统计失败不影响筛选 */ }
  await loadScenes();   // 场景选项与计数（失败就是空数组：筛选条少一项，其余照常）
  renderFilters();
  if (location.pathname === '/rank' && !isH5View()) {   // 榜单下拉的数字与图标/选项补齐
    renderRankTypePanel();
    renderRankCatPanel();
  }
  renderCategorySelect();
}

async function loadTools() {
  try { state.tools = await (await fetch('/api/tools')).json(); } catch { state.tools = []; }
}

// ---------- 广告位 ----------
// 页面上有 5 个固定的空位（data-ad-slot），内容全部来自后台「广告位」。
// 同一位置挂多支广告时：详情页 / 榜单页顶部每次随机挑一条展示（各家机会均等），
// 其余位置轮流播放或并列显示；一个都没有就保持隐藏，不留白。
const AD_ROTATE_MS = 7000;
// 页脚「广告位招租」占位卡：只在广告位没卖满时补位。2026-11-12 站长口径改成「对外招商别摆在正常用户眼前」，
// 这条卡默认关（关掉后没卖满就是普通留白，页脚广告位照样渲染真实投放的广告）。
// 要恢复就把这里改成 true——两处调用点都读这个开关，不用改别处代码。
const AD_RENT_CARD = false;
let ADS = [];
const adSeen = new Set();   // 本次浏览已上报过曝光的广告 id
let adObserver = null;

// 访客可以关掉不想看的广告：只记在本地，不影响后台统计。
// 按「内容指纹」记而不是只记 id——后台改了这条广告的文案/图片，就算新内容，会重新出现。
const AD_CLOSED_KEY = 'dm_ads_closed';
const AD_CLOSED_TTL = 90 * 24 * 3600e3;   // 90 天后自动过期，免得永久看不见
let adClosedMem = null;                   // localStorage 不可用时的兜底

// ---- 招商位的曝光频控（2026-11-09）----
// 只作用于「内容看完之后」的两个位次：首页作品列表底部、全站页脚上方。
// 首页顶部 / 首页第一格 / 详情 / 榜单 这四个位是作者用灯火买的曝光，
// 绝对不能在这里限流——少给一次曝光就是少交付一次，属于违约。所以那些槽位一律不受这个闸门影响。
// 规则：游客第 3 次到访（按天算，同一天刷新不算新到访）才第一次看到；每人每天最多 1 次。
// 页脚 footer 位不同：站长口径「反正在页脚」，对所有人（含游客）都展示，只做一个防刷上限——
// 默认一天 5 次，超过当天不再出；具体数字以后台「广告位」页的设置为准（data/ad-gate.json）。
// 设成 0 = 不限制，等于每次都出。
const AD_GATE_SLOTS = ['home-bottom', 'footer'];
const AD_GATE_KEY = 'dm_adgate';
const AD_GATE_GUEST_DAYS = 3;   // 游客累计到访满 3 天
let AD_GATE_DAILY = { 'home-bottom': 1, footer: 5 };   // 每天最多展示次数，按槽位分开记；会被 /api/ads 的 gate 覆盖
const AD_GATE_GUEST_ONLY = ['home-bottom'];              // 只有这些位对游客设「到访满 3 天」门槛

function adGatePass(slot) {
  if (!AD_GATE_SLOTS.includes(slot)) return true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const s = JSON.parse(localStorage.getItem(AD_GATE_KEY) || '{}');
    const days = s.days || (s.days = {});
    const shown = s.shown || (s.shown = {});
    days[today] = 1;
    // 只留最近 60 天的到访记录，别让这个键无限长
    Object.keys(days).forEach(k => {
      if (k !== today && (new Date(today) - new Date(k)) > 60 * 864e5) delete days[k];
    });
    localStorage.setItem(AD_GATE_KEY, JSON.stringify(s));
    if ((s.closedUntil || 0) > Date.now()) return false;              // 用户明确不想看广告
    // 计数按「槽位+日期」分开存，页脚刷 5 次不会把首页底部的额度吃掉
    const key = slot + ':' + today;
    const cap = AD_GATE_DAILY[slot];
    // 后台把它设成 0 = 不限制，每次都出
    if (typeof cap === 'number' && cap > 0 && (shown[key] || 0) >= cap) return false;
    if (AD_GATE_GUEST_ONLY.includes(slot) && !state.user &&
        Object.keys(days).length < AD_GATE_GUEST_DAYS) return false;   // 游客头两次只给内容
    shown[key] = (shown[key] || 0) + 1;
    localStorage.setItem(AD_GATE_KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    return true;   // localStorage 存不了（隐私模式）就照常展示，别把位置变成永久空
  }
}

function adFingerprint(a) {
  const s = [a.title, a.desc, a.url, a.image, a.cta].join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function adClosedMap() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(AD_CLOSED_KEY) || '{}'); }
  catch (e) { raw = adClosedMem; }
  if (!raw || typeof raw !== 'object') raw = {};
  const now = Date.now();
  Object.keys(raw).forEach(k => {
    if (!raw[k] || now - (raw[k].ts || 0) > AD_CLOSED_TTL) delete raw[k];
  });
  return raw;
}

function saveAdClosed(map) {
  try { localStorage.setItem(AD_CLOSED_KEY, JSON.stringify(map)); }
  catch (e) { adClosedMem = map; }   // 隐私模式等写入失败，退回内存
}

function isAdClosed(a, map) {
  const rec = map[a.id];
  return !!rec && rec.fp === adFingerprint(a);
}

// ---------- 点击包频控：点过一次的作品推荐，本机不再推（2026-11-11） ----------
// 只对「纯点击包」的灯火兑换位生效（服务端 publicAd 标了 clickBased）：
// 点开过作品的人不需要再看这条广告，额度自动留给没看过的新访客。
// 曝光包不受影响——看一眼就走不该终结一条广告的投放；曝光侧的频控走上面的 AD_VIEW_CAP。
// 记录在本机 localStorage（与「不想看」同一套机制），不按服务端 IP 累计——
// 公司/校园共享出口 IP 会把一群人误伤成一「个人」。180 天滚动过期，
// 后台改了广告内容（指纹变了）也重新给机会。
const AD_CLICKED_KEY = 'dm_ads_clicked';
const AD_CLICKED_TTL = 180 * 24 * 3600e3;
let adClickedMem = null;                  // localStorage 不可用时的兜底
function adClickedMap() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(AD_CLICKED_KEY) || '{}'); }
  catch (e) { raw = adClickedMem; }
  if (!raw || typeof raw !== 'object') raw = {};
  const now = Date.now();
  Object.keys(raw).forEach(k => {
    if (!raw[k] || now - (raw[k].ts || 0) > AD_CLICKED_TTL) delete raw[k];
  });
  return raw;
}
function saveAdClicked(map) {
  try { localStorage.setItem(AD_CLICKED_KEY, JSON.stringify(map)); }
  catch (e) { adClickedMem = map; }
}
function isAdClickDone(a, map) {
  const rec = map[a.id];
  return !!rec && rec.fp === adFingerprint(a);
}
// 点击时记录：只记 clickBased 的兑换位
function markAdClicked(a) {
  if (!a || !a.clickBased) return;
  const map = adClickedMap();
  map[a.id] = { fp: adFingerprint(a), ts: Date.now() };
  saveAdClicked(map);
}

function closeAd(id) {
  const a = ADS.find(x => x.id === id);
  if (!a) return;
  const map = adClosedMap();
  map[id] = { fp: adFingerprint(a), ts: Date.now() };
  saveAdClosed(map);
  // 关了什么告诉服务端一声：后台统计「多少人不想看这条」（本地照旧记 90 天不再出现）
  adTrack(id, 'close');
  // 榜单页同一槽位有两个容器（页头通栏 + 宽屏右栏），关广告要两处都重渲染（各容器的 _adOpts 自己恢复）
  document.querySelectorAll(`[data-ad-slot="${a.slot}"]`).forEach(el => renderAdSlot(el, a.slot));
  // 首页第一格不是 .ad-slot 容器，是插进作品列表的一张原生卡：单独重挂。
  // 顺手按新的 pageSize 把作品补满这一格（listPromoAd 从此会返回 null，多拉一件作品）。
  if (a.slot === 'list-first') {
    // 关掉这条后还有剩余：原地重挂，从剩下的里随机挑一条补上；彻底空了才按新的 pageSize 重拉作品补满这一格
    if (state.page === 1 && isPlainListView() && !listPromoAds().length) loadWorks(true);
    else mountListPromo();
  }
  showToast('已关闭这条广告，之后不再显示');
}

// ---------- 首页第一格：看腻了就不再显示（本机频控，2026-11-06） ----------
// 同一访客 7 天里看过这张卡 3 次（同一天最多算 1 次）后，这台浏览器不再显示它，这一格让回普通作品。
// 只影响展示，不换广告、不动排队、不动服务端计费：服务端本来就按「一人一天最多扣 1 次曝光额度」，
// 第 2 次以后的展示不扣灯火，藏掉既不亏投放者，也省得同一张卡反复糊在同一个人脸上。
// 7 天是滚动窗口，过期后重新有机会看到；后台改了广告内容（指纹变了）也重新计数。
const AD_VIEW_KEY = 'dm_promo_views';
const AD_VIEW_CAP = 3;
const AD_VIEW_TTL = 7 * 24 * 3600e3;
let adViewMem = null;                     // localStorage 不可用时的兜底
function adViewMap() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(AD_VIEW_KEY) || '{}'); }
  catch (e) { raw = adViewMem; }
  if (!raw || typeof raw !== 'object') raw = {};
  const now = Date.now();
  Object.keys(raw).forEach(k => {
    const r = raw[k];
    if (!r || !Array.isArray(r.days)) { delete raw[k]; return; }
    r.days = r.days.filter(t => typeof t === 'number' && now - t < AD_VIEW_TTL);
    if (!r.days.length) delete raw[k];
  });
  return raw;
}
function saveAdViews(map) {
  try { localStorage.setItem(AD_VIEW_KEY, JSON.stringify(map)); }
  catch (e) { adViewMem = map; }
}
function isAdViewCapped(a, map) {
  const r = map[a.id];
  return !!r && r.fp === adFingerprint(a) && r.days.length >= AD_VIEW_CAP;
}
// 卡片真的插进首屏才算「看过一次」；同一天重复渲染（loadAds / loadWorks 各一次、刷新）只记 1 次，
// 避免后台同步、筛选切换或用户狂刷把次数刷满。
function bumpAdView(a) {
  const map = adViewMap();
  const now = Date.now(), day = Math.floor(now / 86400e3);
  const fp = adFingerprint(a);
  let r = map[a.id];
  if (!r || r.fp !== fp) r = { fp, days: [] };
  if (r.days.some(t => Math.floor(t / 86400e3) === day)) return;
  r.days.push(now);
  map[a.id] = r;
  saveAdViews(map);
}

let adsReady = null;   // 广告数据的首拉 Promise：loadWorks 第 1 页要等它，pageSize 才能把推荐卡那格算进去
function ensureAds() {
  if (!adsReady) adsReady = loadAds();
  return adsReady;
}

async function loadAds() {
  try {
    const data = await (await fetch('/api/ads')).json();
    ADS = Array.isArray(data.ads) ? data.ads : [];
    // 频控次数由后台配置（后台「广告位」页可改），拿不到就用默认值
    if (data.gate && typeof data.gate === 'object') {
      Object.keys(AD_GATE_DAILY).forEach(k => {
        const v = Number(data.gate[k]);
        if (Number.isFinite(v) && v >= 0) AD_GATE_DAILY[k] = v;
      });
    }
  } catch { ADS = []; }
  renderAllAdSlots();
  mountListPromo();   // 第一格宣传卡跟着广告数据一起刷新
}

function adHtml(a, opts) {
  // 两种形式：图文（图片铺底的大横幅）｜纯文字（浅色卡片，不发图片请求）。
  // 推荐位（灯火兑换的自荐位）不再单独做一套白底小条：站内推荐和外链推荐并排时
  // 一浅一深像两个东西（2026-11-10 用户拍板统一）。现在两者都走横幅，
  // 只有徽标颜色（推荐=暖色 / 广告=白）和 CTA 文案（看看这个作品 / 打开链接）不同。
  const isText = a.kind === 'text';
  const hasImg = !isText && a.image;
  // compact = 半宽并排时用（标题一行、描述铺满第二行），见 style.css 的 .ad-compact
  const compact = !!(opts && opts.compact);
  const img = hasImg
    ? `<img class="ad-bg" src="${escapeHtml(imgUrl(a.image, 1200))}" alt="" loading="lazy" />`
    : '';
  // 品牌橱窗页（/brand/xxx）是站内页：同一标签页打开，读起来像「内容」而不是「跳广告」。
  // 站外链接与其他站内地址维持新窗口（既有行为，别顺手改）。
  const isBrand = String(a.url || '').startsWith('/brand/');
  // 站内作品的推荐位（url = /w/xxx）不新开标签：点了原地弹详情、关掉回到原页面。
  // 原来一律 target=_blank 整页打开 /w/xxx，新标签里没有任何 history 来源，
  // 点 ✕ 只能走兜底回首页（2026-11-14 用户报「榜单页点上面那条推荐，关了跳首页」）。
  // href 保留 /w/xxx 给没 JS 的兜底，data-ad-work 交给下方全局捕获点击处理。
  const adWorkId = !a.extUrl && /^\/w\//.test(String(a.url || ''))
    ? (a.workId || decodeURIComponent(String(a.url).slice(3))) : '';
  const newTab = !isBrand && !adWorkId;
  return `<div class="ad-card-wrap">
    <a class="ad-card${hasImg ? ' has-img' : ''}${isText ? ' ad-text-card' : ''}${compact ? ' ad-compact' : ''}" href="${escapeHtml(a.url)}"
      ${newTab ? 'target="_blank" ' : ''}rel="noopener nofollow sponsored" data-ad="${escapeHtml(a.id)}"${adWorkId ? ` data-ad-work="${escapeHtml(adWorkId)}"` : ''}>
      ${img}
      <span class="ad-body">
        <span class="ad-badge${a.source === 'redeem' ? ' is-redeem' : ''}">${a.source === 'redeem' ? '推荐' : '广告'}</span>
        ${a.title ? `<b class="ad-title">${escapeHtml(a.title)}</b>` : ''}
        ${a.desc ? `<span class="ad-desc">${escapeHtml(a.desc)}</span>` : ''}
        <span class="ad-cta">${escapeHtml(a.cta || '了解更多')} →</span>
      </span>
    </a>
    <button class="ad-close" type="button" data-ad-close="${escapeHtml(a.id)}"
      aria-label="关闭这条广告" title="不想看，关掉">
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
    </button>
    ${adTipHtml(a)}
  </div>`;
}

// 悬停完整文案：标题/描述经常被省略号截断（页脚细行、榜单多列并排最狠），
// 每张卡都带一个完整内容的浮层；是否真的截断由 markTruncAds 实测溢出后打标记，
// 没截断的浮层永远不出现，不会把看得见的字再念一遍。
function adTipHtml(a) {
  const bits = [];
  if (a.title) bits.push(`<b>${escapeHtml(a.title)}</b>`);
  if (a.desc) bits.push(`<span>${escapeHtml(a.desc)}</span>`);
  return bits.length ? `<span class="ad-tip" aria-hidden="true">${bits.join('')}</span>` : '';
}

function markTruncAds(scope) {
  (scope || document).querySelectorAll('.ad-card-wrap').forEach(wrap => {
    const card = wrap.querySelector('.ad-card');
    if (!card) return;
    const clipped = Array.from(card.querySelectorAll('.ad-title, .ad-desc'))
      .some(t => t.scrollWidth > t.clientWidth + 1);
    if (!clipped) { delete wrap.dataset.trunc; delete wrap.dataset.edge; return; }
    wrap.dataset.trunc = '1';
    // 贴近视口右缘的卡（多列并排时常见）：浮层改从右缘对齐，避免探出屏幕
    const r = wrap.getBoundingClientRect();
    wrap.dataset.edge = (r.right + 500 > window.innerWidth) ? 'right' : 'left';
  });
}

// 页脚「广告位招租」卡：不是付费广告，是站方自留的库存位——不参与曝光/点击计费、没有关闭按钮。
// 点开直达招商页 /ads（四个位置的实样、档期、周价和首周试投价都写在那页），留资走那页的按钮。
// 2026-11-12 起默认不展示（AD_RENT_CARD=false）：页脚是全站每页都露出的位置，看见它的正常访客远多于广告主，
// 站长不想把「本站接广告」这件事摆到日常访客眼前。函数保留，恢复只需把开关打开。
// 文案刻意极短：这张卡和别的文字广告并排时只占 1/3 宽（约 380px），
// desc 那格到手只剩几十像素，写长了全被省略号吃掉，不如把话交给 CTA。
// 卡片自己不复述价格：价格唯一源是服务端 ADV_SLOTS，页脚多说一个数字就会和刊例打架。
function adRentHtml() {
  return `<div class="ad-card-wrap ad-rent-wrap">
    <a class="ad-card ad-text-card ad-rent" href="/ads"
      title="页脚这块位置还空着：按周起投，四个位置的实样、档期和周价都在「投放合作」页">
      <span class="ad-body">
        <span class="ad-badge is-rent">招租</span>
        <b class="ad-title">页脚这块位置还空着</b>
        <span class="ad-desc">按周起投</span>
        <span class="ad-cta">看价格 →</span>
      </span>
    </a>
  </div>`;
}

// 推荐位旁的「我也想推荐」小入口：看到别人的作品挂在这里，谁都可能想排队。
// 统一走 openRedeem()（未登录先弹登录），跳独立页 /promote；不做计费埋点，
// 这行小字不是广告，是给作者的邀请函。
function promoJoinHtml() {
  return `<div class="ad-join"><a href="javascript:void(0)" data-join-promote
    title="用灯火给自己的作品换个推荐位">✦ 我也想推荐自己的作品 ›</a></div>`;
}

// 推荐位空着（一条可展示的内容都没有）时的「虚位以待」示例条：
// 明确标「示例」、虚线框，不冒充真推荐；点开同样跳 /promote。
// 和页脚「招租」卡同一思路——位置空着，读者和想投的人都不知道这里能投，
// 不如自己给自己招商；文案里用《你的作品》占位，看的都是「换成我的」的想象空间。
function promoDemoHtml() {
  return `<div class="ad-card-wrap ad-vacant-wrap">
    <a class="ad-card ad-text-card ad-vacant" href="javascript:void(0)" data-join-promote
      title="用灯火给自己的作品换个推荐位">
      <span class="ad-body">
        <span class="ad-badge is-vacant">示例</span>
        <b class="ad-title">这条推荐位还空着</b>
        <span class="ad-desc">上线一件作品，用灯火就能把《你的作品》挂到这里</span>
        <span class="ad-cta">我也想推荐自己的作品 →</span>
      </span>
    </a>
  </div>`;
}

// 曝光埋点：真正滚到视野里（露出一半）并且是当前轮播到的那条，才计一次曝光；
// 同一次浏览里同一支广告只报一次（服务端按访客去重算 UV，每次上报算 1 个 PV）。
function adInView(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 0);
}

function maybeReportAd(el) {
  if (!el || el.dataset.adSeen === '1') return;
  const slide = el.closest ? el.closest('.ad-slide') : null;
  if (slide && !slide.classList.contains('show')) return; // 轮播里还没轮到它，先不算
  if (!adInView(el)) return;
  el.dataset.adSeen = '1';
  const id = el.dataset.ad;
  if (!id || adSeen.has(id)) return;
  adSeen.add(id);
  adTrack(id, 'impression');
}

function observeAds(root) {
  if (!('IntersectionObserver' in window)) return;
  if (!adObserver) {
    adObserver = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) maybeReportAd(en.target); });
    }, { threshold: 0.5 });
  }
  root.querySelectorAll('a.ad-card, .promo-card[data-ad]').forEach(el => adObserver.observe(el));
}

// 推荐小条的缩略图兜底处理器已随白底小条样式一起下线（2026-11-10 统一走图文横幅，
// 横幅的图挂掉由 .ad-bg 自身的深色底兜着，不会露出破图布局）

function sendBeaconSafe(url) {
  try {
    if (navigator.sendBeacon) { navigator.sendBeacon(url); return; }
    fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  } catch { /* 埋点失败不影响浏览 */ }
}

// 访客标识：广告计费认的「人」。
// 按 IP 认人的老口径在共享出口（公司 / 校园 / 运营商 CGNAT）下会把几千人并成一个人，
// 一天只扣 1 次曝光额度，投放者买的次数永远消耗不完；改成本机 ID 后一人一账。
// 同一个浏览器换网络也还是同一个访客（不会因为切 4G 重复扣投放者的灯火）。
const VID_KEY = 'dm_vid';
let vidMem = '';
function visitorId() {
  if (vidMem) return vidMem;
  try {
    let v = localStorage.getItem(VID_KEY) || '';
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(v)) {
      v = Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(VID_KEY, v);
    }
    vidMem = v;
  } catch (e) {
    // 隐私模式等写不进存储：退化成内存 ID，本次浏览内仍按一个人算
    vidMem = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  return vidMem;
}

// 广告埋点统一带上访客 ID（服务端按它去重计费；没带的走老的 IP 口径兜底）
function adTrack(id, action) {
  // 点击包频控：点过「纯点击包」兑换位的本机记录一笔，之后这条不再推给这台浏览器
  if (action === 'click') markAdClicked(ADS.find(x => x.id === id));
  sendBeaconSafe('/api/ads/' + encodeURIComponent(id) + '/' + action
    + '?vid=' + encodeURIComponent(visitorId()));
}

// ---------- 投放者本机自验证 ----------
// 榜单页顶部是随机展示，投放者刷新时不一定撞见自己那条，就没法确认投放是否生效。
// 兑换成功后，只在他自己的浏览器里把刚投的那条临时钉住（10 分钟），刷新榜单页即可验证；
// 其他访客看到的仍是随机结果，曝光分配与后端扣费限流都不变。
const MY_AD_PREVIEW_KEY = 'myAdPreview';
const MY_AD_PREVIEW_MS = 10 * 60 * 1000;
function setMyAdPreview(ad, slot) {
  if (!ad || !ad.id || slot !== 'rank') return;
  try {
    sessionStorage.setItem(MY_AD_PREVIEW_KEY, JSON.stringify({
      id: ad.id, slot, until: Date.now() + MY_AD_PREVIEW_MS
    }));
  } catch { /* 隐私模式下 sessionStorage 不可用，忽略即可 */ }
}
function myAdPreview(slot, list) {
  if (slot !== 'rank') return null;
  try {
    const raw = sessionStorage.getItem(MY_AD_PREVIEW_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || p.slot !== slot || !(p.until > Date.now())) return null;
    // 自己关掉 / 已下线 / 额度用完的推荐不在 list 里，自然退回随机
    return list.find(a => a.id === p.id) || null;
  } catch { return null; }
}

function renderAdSlot(el, slot, opts = {}) {
  if (!el) return;
  // 这个槽位的渲染参数要记在节点上：关广告（renderAdSlot 只带 slot 重渲染）和
  // renderAllAdSlots 整页刷都不传 opts，不记下来散座栏的单张上限就丢了。
  // HTML 里也可以直接写 data-ad-maxcols / data-ad-stack（榜单右栏竖排 5 条用的就是这个），首次渲染记进 _adOpts
  if (opts.maxCols == null && el.dataset && el.dataset.adMaxcols) opts.maxCols = Number(el.dataset.adMaxcols) || undefined;
  if (opts.stack == null && el.dataset && el.dataset.adStack) opts.stack = true;
  if (opts.maxCols != null || opts.stack) el._adOpts = { maxCols: opts.maxCols, stack: opts.stack };
  else if (el._adOpts) opts = el._adOpts;
  clearInterval(el._adTimer);           // 重新渲染前先停掉旧的轮播
  el._adTimer = null;
  // 详情位特殊：点开的是自己的作品时不展示（给自己推自己的广告很怪）
  if (slot === 'detail' && state.currentWork && state.currentWork.owned) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  const closed = adClosedMap();
  const clicked = adClickedMap();
  // 点击包频控：本机点过的「纯点击包」兑换位不再出现在任何槽位（曝光包/运营广告不受影响）
  let list = ADS.filter(a => a.slot === slot && !isAdClosed(a, closed) && !isAdClickDone(a, clicked));
  // 和首页第一格同口径：用户永久屏蔽过的作品，不该在榜单位 / 详情位的推荐里再露面。
  // 只认站内作品卡（带 workId 或 /w/ 链接）；纯外链广告没有对应作品，不受影响。
  list = list.filter(a => {
    const wid = a.workId || String(a.url || '').split('/w/')[1] || '';
    return !wid || !(state.blocked || []).includes(wid);
  });
  // 详情位：正在浏览的作品不给自己打广告（推荐恰好推广的就是当前作品时排除）
  if (slot === 'detail' && state.currentWork && state.currentWork.id) {
    const curUrl = '/w/' + encodeURIComponent(state.currentWork.id);
    list = list.filter(a => a.url !== curUrl);
  }
  if (!list.length) {
    // 页脚：以前没卖出广告也会补一张「招租」卡自己给自己招商，现在默认不补（AD_RENT_CARD=false）。
    // 页脚是全站每页都露出的位置，正常访客看得比广告主多，不该天天看见「这块位置还空着，看价格」。
    if (AD_RENT_CARD && slot === 'footer' && adGatePass(slot)) {
      el.style.display = 'block';
      el.innerHTML = `<div class="ad-stack">${adRentHtml()}</div>`;
      return;
    }
    // 榜单/酒馆顶部、详情底栏空位：放一条「虚位以待」示例条（自己给自己招商），
    // 别直接消失——想投的人看不到这里能投，想被看到的人不知道有这扇门。
    if (slot === 'rank' || slot === 'detail') {
      el.style.display = 'block';
      el.innerHTML = promoDemoHtml();
      return;
    }
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  // 招商位频控：没过闸就当这个位置不存在（不留白、不占位）
  if (!adGatePass(slot)) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  if (slot === 'rank') {
    // 榜单顶部 + 酒馆顶部的定位是「推荐站内作品」：只要有人在投的作品推荐（推荐/积分兑换），
    // 就只在这些里挑，运营横幅退位；同组内仍随机，各家机会均等。
    // 一条作品推荐都没有时才回落到运营广告，位置不留白。
    const redeemList = list.filter(a => a.source === 'redeem');
    if (redeemList.length) list = redeemList;
  }
  if (slot === 'detail' || slot === 'rank') {
    // 详情位 / 榜单+酒馆顶部：每次渲染随机挑，各家曝光机会均等。
    // 刻意不走等时轮播——轮播里第一条立刻展示先吃满曝光，排后面的可能一次都轮不到，
    // 同样灯火买到的额度消耗速度会差一大截。
    // 例外：刚兑换成功的作者，本机 10 分钟内优先看到自己那条（setMyAdPreview），
    // 用来验证投放是否生效；其他访客仍走随机，不受影响。
    const mine = myAdPreview(slot, list);
    let core = '';
    if (slot === 'detail') {
      // 详情位（作品详情页底栏）宽屏一次并排 2 条（2026-11-06 由单条改 2 条）：
      // 每条各自独立曝光/关闭；窄屏或不足 2 条退回单条通栏，保持原观感。
      if (list.length > 1 && window.innerWidth > 900) {
        const pick = mine ? [mine] : [];
        const rest = list.filter(a => !mine || a.id !== mine.id).slice();
        while (pick.length < 2 && rest.length) {
          pick.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
        }
        core = `<div class="ad-row2">${pick.map(a => adHtml(a, { compact: true })).join('')}</div>`;
      } else {
        core = adHtml(mine || list[Math.floor(Math.random() * list.length)]);
      }
    } else if (slot === 'rank' && list.length > 1 && window.innerWidth > 900) {
      // rank 位（榜单页顶部 + 榜单右栏 + 酒馆散座栏共用）。条数策略（2026-11-12 站长拍板）：
      // 榜单页顶部通栏 PC 宽屏一次并排 2-4 条（视口 ≥1180 放 4 条，900-1180 放 3 条，1 条退回通栏；
      // 窄屏仍是单条，避免撑高首屏）；榜单页右栏（data-ad-maxcols=5）竖排最多 5 条；
      // H5 / 小程序口径不动。并排/竖排的每条都真实可见 → 一次浏览给 N 家各扣一次额度，
      // 同屏条数就是消耗倍率。
      // 竖排（酒馆右栏 maxCols=2、榜单右栏 stack）：窄容器里并排会把标题挤碎，改走 .ad-stack，
      // 每条仍各自独立曝光/关闭；榜单页主容器宽，照旧并排
      const maxCols = Math.min(opts.maxCols || (window.innerWidth >= 1180 ? 4 : 3), 5);
      const want = Math.min(maxCols, list.length);
      const pick = mine ? [mine] : [];
      const rest = list.filter(a => !mine || a.id !== mine.id).slice();
      while (pick.length < want && rest.length) {
        pick.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
      }
      if (pick.length > 1) {
        // 竖排容器（酒馆右栏 / 榜单右栏）：.ad-stack 的 auto-fit（列宽下限 340px）在窄容器里天然退成单列，直接复用
        if (opts.maxCols === 2 || opts.stack) {
          core = `<div class="ad-stack">${pick.map(a => adHtml(a, { compact: true })).join('')}</div>`;
        } else {
          const cols = pick.length > 3 ? ' cols-4' : pick.length > 2 ? ' cols-3' : '';
          core = `<div class="ad-row2${cols}">${pick.map(a => adHtml(a, { compact: true })).join('')}</div>`;
        }
      } else {
        core = adHtml(pick[0], { compact: true });   // 单条不套 .ad-row2（那是两列 grid，一张卡会缩在半宽里）
      }
    } else {
      core = adHtml(mine || list[Math.floor(Math.random() * list.length)]);
    }
    // 条组下方带一行「我也想推荐自己的作品」小入口：看到别人上榜 → 自己也想排队，
    // 一路直达 /promote（未登录先弹登录）。这行不是广告，不参与计费与关闭。
    el.innerHTML = core + promoJoinHtml();
  } else if (slot === 'footer' && list.every(a => a.kind === 'text')) {
    // 页脚：纯文字广告一行并排，最多 3 格；没卖满时不再补「招租」占位（见 AD_RENT_CARD 口径），
    // 有几条就排几条，没卖出去的那格空着就空着——真实投放的广告照常展示。
    const picked = list.slice(0, 3);
    const cards = picked.map(a => adHtml(a));
    if (AD_RENT_CARD && picked.length < 3) cards.push(adRentHtml());
    el.innerHTML = `<div class="ad-stack">${cards.join('')}</div>`;
  } else if ((slot === 'home-top' || slot === 'home-bottom') && list.length > 1) {
    // 首页横幅位：多条不轮播，一行并排两条（更多自动换行续排），都真实可见、各自计曝光
    el.innerHTML = `<div class="ad-row2">${list.map(a => adHtml(a)).join('')}</div>`;
  } else if (list.length === 1) {
    el.innerHTML = adHtml(list[0]);
  } else if (list.every(a => a.kind === 'text')) {
    // 全是纯文字（脚注式细行）时并列展示：两条同时可见，各自独立曝光/关闭
    el.innerHTML = `<div class="ad-stack">${list.map(a => adHtml(a)).join('')}</div>`;
  } else {
    el.innerHTML =
      `<div class="ad-carousel">${list.map((a, i) =>
        `<div class="ad-slide${i === 0 ? ' show' : ''}">${adHtml(a)}</div>`).join('')}</div>` +
      `<div class="ad-dots">${list.map((_, i) =>
        `<span class="ad-dot${i === 0 ? ' active' : ''}"></span>`).join('')}</div>`;
    const slides = el.querySelectorAll('.ad-slide');
    const dots = el.querySelectorAll('.ad-dot');
    let idx = 0;
    el._adTimer = setInterval(() => {
      slides[idx].classList.remove('show');
      dots[idx].classList.remove('active');
      idx = (idx + 1) % slides.length;
      slides[idx].classList.add('show');
      dots[idx].classList.add('active');
      maybeReportAd(slides[idx].querySelector('a.ad-card')); // 轮到的这条才算曝光
    }, AD_ROTATE_MS);
  }
  markTruncAds(el);   // 实测哪些广告的文字被截断，打上 hover 浮层的标记
  observeAds(el);
}

function renderAllAdSlots() {
  // 招商页本身就是来卖广告位的：页脚通栏在这里不渲染。
  // 否则一边报价卖位置、一边在底部挂「这块位置还空着」的招租卡，自己拆自己台。
  const onSalesPage = location.pathname === '/ads';
  document.querySelectorAll('[data-ad-slot]').forEach(el => {
    if (onSalesPage && el.dataset.adSlot === 'footer') return;
    renderAdSlot(el, el.dataset.adSlot);
  });
}

// ---------- 首页第一格：推荐卡（独占位，用原生卡片而不是横幅） ----------
// 这是积分兑换买来的位置，卡片样式跟普通作品卡一致，只多一个「宣传」角标，
// 点进去还是作品详情页，不做站外跳转——观感上不像广告，也不会把首页撑坏。
function isPlainListView() {
  return !state.q &&
    state.category === '全部' && state.type === '全部' && state.openSource === '全部' &&
    state.scene === '全部';
}

// 首页第一格同时最多 3 条在投，但一次只显示一条（2026-11-11 站长拍板：不做自动轮播切换）：
// 每次挂载随机挑一条（各家机会均等，与详情/榜单位同口径），浏览期间静止不动；
// 访客叉掉当前条后 closeAd 重跑 mountListPromo，从剩下的里再随机挑一条补上。
// 返回过滤后、最多 LIST_FIRST_MAX 条在投推荐（作者自荐 redeem / 后台 admin）：
// 过滤掉访客叉过的、7 天内看过≥3 次的、被永久屏蔽作品的。随便逛逛也走这里（它是普通列表视图）。
const LIST_FIRST_MAX = 3;
function listPromoAds() {
  if (!isPlainListView()) return [];
  const closed = adClosedMap();
  const views = adViewMap();
  const clicked = adClickedMap();
  const blocked = state.blocked || [];
  return (ADS || [])
    .filter(x => x.slot === 'list-first' && (x.source === 'redeem' || x.source === 'admin'))
    .filter(a => !isAdClosed(a, closed))
    .filter(a => !isAdViewCapped(a, views))
    .filter(a => !isAdClickDone(a, clicked))     // 点击包：本机点过一次就不再推
    .filter(a => {
      // 永久屏蔽：屏蔽过的作品就算正在买首页第一格，也不该换个「推荐」角标又冒出来。
      // 弹窗承诺的是「不会再出现在你的首页」，投放位不能变成绕过后门。
      const wid = a.workId || String(a.url || '').split('/w/')[1] || '';
      return !wid || !blocked.includes(wid);
    })
    .slice(0, LIST_FIRST_MAX);
}
// 兼容旧调用点（pageSize / 随便逛逛首屏等只需要「有没有」一个布尔）：随机返回一条，没有则 null。
function listPromoAd() {
  const ads = listPromoAds();
  return ads.length ? ads[Math.floor(Math.random() * ads.length)] : null;
}

function promoCardHtml(a) {
  // 推荐（积分兑换）：默认点开作品详情弹窗；外链单（extUrl）整卡当链接、新标签打开
  const internal = !a.extUrl && (!!a.workId || /^\/w\//.test(String(a.url || '')));
  const id = a.workId || String(a.url || '').split('/w/')[1] || '';
  // 「不想看」叉号：第一格以前没有关闭入口，访客只能一直看同一张卡。
  // 走和横幅广告同一套本地记录（90 天）+ 关闭上报，后台能看见多少人不想看。
  const xBtn = `<button class="promo-x" type="button" data-ad-close="${escapeHtml(a.id)}"
      aria-label="不想看，关掉这条推荐" title="不想看，关掉">
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
    </button>`;
  // 列表视图：跟作品行同一套排版（一行缩略图 + 标题 + 一句话），
  // 不再塞网格大卡——不然一张手机截图竖图会把列表撑出老高
  if (state.view === 'list') {
    const open = internal
      ? `<div class="work-row promo-row" data-id="${escapeHtml(id)}" data-ad="${escapeHtml(a.id)}">`
      : `<a class="work-row promo-row promo-ext" href="${escapeHtml(a.url)}" target="_blank" rel="noopener nofollow sponsored" data-ad="${escapeHtml(a.id)}">`;
    return `${open}
      ${internal ? `<a class="card-link" href="/w/${escapeHtml(id)}" aria-label="查看《${escapeHtml(a.title)}》"></a>` : ''}
      ${a.image ? `<img class="row-thumb" src="${escapeHtml(imgUrl(a.image, 400))}" alt="${escapeHtml(a.title)}" loading="lazy" />` : `<span class="row-thumb row-thumb-empty"><span class="ico">${ic('megaphone')}</span></span>`}
      <div class="row-main">
        <div class="row-title"><span class="promo-row-flag">推荐</span>${escapeHtml(a.title)}</div>
        ${a.desc ? `<div class="row-intro">${escapeHtml(a.desc)}</div>` : ''}
        <div class="row-meta">${a.source === 'redeem' ? `<span class="promo-join" data-join-promote title="用灯火给自己的作品换个推荐位">我也想推荐自己的作品</span> · ` : '广告 · '}${a.extUrl ? '打开链接 ↗' : '看看 →'}</div>
      </div>
      ${xBtn}
    </${internal ? 'div' : 'a'}>`;
  }
  // 推荐（积分兑换）：点开作品详情弹窗；运营广告：可能是外链，整卡当链接
  const open = internal
    ? `<div class="card promo-card" data-id="${escapeHtml(id)}" data-ad="${escapeHtml(a.id)}">`
    : `<a class="card promo-card promo-ext" href="${escapeHtml(a.url)}" target="_blank" rel="noopener nofollow sponsored" data-ad="${escapeHtml(a.id)}">`;
  return `${open}
      ${internal ? `<a class="card-link" href="/w/${escapeHtml(id)}" aria-label="查看《${escapeHtml(a.title)}》"></a>` : ''}
      <div class="card-img-wrap">
        ${a.image ? `<img class="card-img" src="${escapeHtml(imgUrl(a.image, 400))}" srcset="${imgSet(a.image)}" sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 260px" alt="${escapeHtml(a.title)}" loading="lazy" />` : `<div class="promo-noimg"><span class="ico">${ic('megaphone')}</span></div>`}
        <span class="promo-flag">推荐</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(a.title)}</div>
        ${a.desc ? `<div class="promo-desc">${escapeHtml(a.desc)}</div>` : ''}
        <div class="card-meta promo-foot">
          ${a.source === 'redeem'
            ? `<span class="promo-tip promo-join" data-join-promote title="用灯火给自己的作品换个推荐位">我也想推荐自己的作品</span>`
            : `<span class="promo-tip">广告</span>`}
          <span class="promo-go">${a.extUrl ? '打开链接 ↗' : '看看 →'}</span>
        </div>
      </div>
      ${xBtn}
    </${internal ? 'div' : 'a'}>`;   // 站内卡是 <div>，外链卡才是 <a>，别一律用 </a> 收尾
}

// 插到第一格（第一件是置顶作品时排它后面，别抢运营手动置顶的位）
// 一次只显 1 条：多条在投时随机挑一条（各家机会均等），浏览期间静止不切换；
// 访客叉掉当前条后 closeAd 重跑这里，从剩下的里再随机挑一条补上。
function mountListPromo() {
  if (!gallery) return;
  if (state.sort === 'wander') return;   // 随便逛逛自己插首屏推荐卡（mountWanderPromo），别走这里重复插
  const old = gallery.querySelector('.promo-slot');
  if (old) old.remove();
  const ad = listPromoAd();
  if (!ad) return;
  const wrap = document.createElement('div');
  wrap.className = 'promo-slot';
  bumpAdView(ad);   // 真的插进首屏才算「看过一次」，同一天只记一次
  wrap.innerHTML = promoCardHtml(ad);
  wirePromoClick(wrap.firstElementChild);
  const first = gallery.querySelector('.card, .work-row');
  if (first && first.querySelector('.pin-badge') && first.nextSibling) gallery.insertBefore(wrap, first.nextSibling);
  else if (first) gallery.insertBefore(wrap, first);
  else gallery.appendChild(wrap);
  observeAds(wrap);   // 真正曝光埋点：卡滚进视野才算一次，同一次浏览只报一次
}

// 首格推荐卡点击：站内卡点开作品详情；运营外链卡本身是 <a>，只记点击。
function wirePromoClick(node) {
  if (!node) return;
  if (node.classList.contains('promo-ext')) {
    node.addEventListener('click', () => adTrack(node.dataset.ad, 'click'));
  } else {
    node.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // 交给浏览器开新标签
      e.preventDefault();
      adTrack(node.dataset.ad, 'click');
      if (node.dataset.id) openWork(node.dataset.id);
    });
  }
}

// 随便逛逛首屏：复用首页第一格那张推荐卡，插到网格最前面（只插一张）。
// 它只是展示位——wanderObserve 跳过 .promo-card、曝光走 adTrack，绝不污染 n；
// 拔掉 data-id 让随便逛逛的曝光观测/去重/点进详情统计都不把它当作品。
function mountWanderPromo() {
  const g = $('gallery');
  if (!g) return;
  if (g.querySelector('.promo-slot')) return;   // 已插，不重复（首格推荐卡统一用 .promo-slot 包裹）
  const a = listPromoAd();
  if (!a) return;
  const wrap = document.createElement('div');
  wrap.className = 'promo-slot';
  wrap.innerHTML = promoCardHtml(a);
  const node = wrap.firstElementChild;
  if (!node) return;
  wireWanderPromo(node, a);   // 去 data-id、接点击/曝光、记一次看过
  g.insertBefore(wrap, g.firstChild);
}

// 随便逛逛：首屏之外的批次里随机插几张「作者灯火自荐位」卡（= 推荐，绝非后台广告）。
// 只插 source==='redeem'（作者用灯火换的曝光），绝不插 source==='admin' 后台广告；
// 优先推给「每看过的人」：排除本地已关闭 / 7天看过≥3次的，其余按本机看过次数最少优先；
// 同一次浏览不重复插同一张；带小「推荐」角标、走 adTrack 曝光、wanderObserve 跳过 —— 绝不污染 n。
const WANDER_PROMO_PER_BATCH = 1;            // 每批(约一屏)最多插几张，保持稀疏，别太多
let wanderInsertedPromoIds = new Set();      // 本页会话已插过的推荐卡 id，避免重复
// 同一件作品可能同时投了多个位（首屏 list-first + 榜单 rank + 详情 detail），
// 只按广告条目去重会让它在一次浏览里出现两三次，同一张脸硬塞给同一个人。
// 再按作品收一道：一个作品在一次浏览里最多露一次（首屏已插过的，后面批次全排掉）。
const wanderInsertedPromoWorkIds = new Set();
function promoWorkKey(a) {
  return a.workId || String(a.url || '').split('/w/')[1] || '';
}

function wanderPromoPool() {
  const closed = adClosedMap();
  const views = adViewMap();
  const clicked = adClickedMap();
  const blocked = state.blocked || [];
  const pool = (ADS || []).filter(a =>
    a.source === 'redeem' &&                          // 只投作者自荐位（灯火兑换），不是后台广告
    a.slot !== 'list-first' &&                        // 首屏那张已经在最前面了，别重复
    !wanderInsertedPromoIds.has(a.id) &&              // 本次浏览插过这条了（下面还有按作品的兜底，这里先收一道）
    !String(a.slot || '').startsWith('mini-') &&      // 小程序专属槽位不进网页随便逛逛
    !(a.workId && blocked.includes(a.workId)) &&      // 用户屏蔽过的作品不插
    !isAdClosed(a, closed) &&                         // 本地关过的不再出现
    !isAdViewCapped(a, views) &&                      // 7天看过≥3次的让回普通作品
    !isAdClickDone(a, clicked) &&                     // 点击包：本机点过一次就不再推
    !(promoWorkKey(a) && wanderInsertedPromoWorkIds.has(promoWorkKey(a)))  // 同一作品本次浏览只插一次
  );
  // 「优先推给每看过的人」：本机看过次数最少的排前面
  pool.sort((x, y) => ((views[x.id] && views[x.id].days.length) || 0) - ((views[y.id] && views[y.id].days.length) || 0));
  return pool;
}

function buildWanderBatchHtml(works, allowPromos) {
  const items = works.map(wanderCardHtml);
  if (!allowPromos) return items.join('');
  const pool = wanderPromoPool();
  if (!pool.length || !items.length) return items.join('');
  const used = new Set();
  const slots = [];
  const n = Math.min(WANDER_PROMO_PER_BATCH, pool.length);
  for (let i = 0; i < n; i++) {
    let cand = null;
    for (const a of pool) {
      if (!used.has(a.id) && !wanderInsertedPromoIds.has(a.id)) { cand = a; break; }
    }
    if (!cand) break;
    used.add(cand.id);
    const idx = Math.floor(Math.random() * (items.length + 1));   // 本批作品里随机一个位置
    slots.push({ idx, html: promoCardHtml(cand) });
  }
  // 从靠后的位置往前插，保证前面索引不偏移
  slots.sort((a, b) => b.idx - a.idx);
  for (const s of slots) items.splice(s.idx, 0, s.html);
  return items.join('');
}

function wireWanderPromo(node, a) {
  const id = a.workId || String(a.url || '').split('/w/')[1] || '';
  node.removeAttribute('data-id');             // 推荐卡不是作品，别被 wander 曝光/去重/点进详情误当作品
  node.dataset.wired = '1';
  if (node.classList.contains('promo-ext')) {
    node.addEventListener('click', () => adTrack(node.dataset.ad, 'click'));   // 外链卡：整卡即链接
  } else {
    node.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // 交给浏览器开新标签
      e.preventDefault();
      adTrack(node.dataset.ad, 'click');
      if (id) openWork(id);                    // 站内作品：点开详情
    });
  }
  if (adObserver) adObserver.observe(node);
  else observeAds(document);
  bumpAdView(a);                               // 真插进随便逛逛才算「看过一次」，7天看过≥3次后停投
  wanderInsertedPromoIds.add(a.id);
  if (id) wanderInsertedPromoWorkIds.add(id);   // 记作品，同一作品换了投放位也不再插第二次
}

function wireWanderPromos(g) {
  g.querySelectorAll('.promo-card, .promo-row').forEach(node => {
    if (node.dataset.wired === '1') return;
    const a = (ADS || []).find(x => x.id === node.dataset.ad);
    if (a) wireWanderPromo(node, a);
  });
}

// 点击埋点：用事件委托，广告是新渲染出来的也能记到。
// 必须走捕获阶段：首页第一格的整张卡自己挂了 click（点开作品详情），
// 叉号要在事件到达卡片之前拦下并 stopPropagation，否则会「关掉广告的同时弹出作品详情」。
document.addEventListener('click', e => {
  // 关闭按钮（不在 a 里，不会被算成点击广告）
  const x = e.target.closest && e.target.closest('[data-ad-close]');
  if (x) {
    e.preventDefault();
    e.stopPropagation();
    closeAd(x.dataset.adClose);
    return;
  }
  const a = e.target.closest && e.target.closest('a.ad-card');
  if (!a || !a.dataset.ad) return;
  adTrack(a.dataset.ad, 'click');
  // 站内作品的推荐位：原地弹详情（压一条历史），关掉就回到当前这页——
  // 别整页跳 /w/xxx，那样关详情时没有来源可回，只能兜底回首页。
  if (a.dataset.adWork) {
    e.preventDefault();
    openWork(a.dataset.adWork);
  }
}, true);

// 推荐位的「我也想推荐自己的作品」入口 + 空位「虚位以待」示例条：
// 全站委托一次，统一走 openRedeem()（未登录先弹登录），跳独立页 /promote。
// 必须走捕获阶段（同下方叉号）：推荐卡整卡挂了 click 点开作品详情，
// 冒泡阶段的话事件先到卡片节点弹了作品详情，这里再 stopPropagation 已经晚了。
document.addEventListener('click', e => {
  const j = e.target.closest && e.target.closest('[data-join-promote]');
  if (!j) return;
  e.preventDefault();
  e.stopPropagation();
  openRedeem();
}, true);

// 服务端渲染的作品页（搜索引擎落地页）上的按钮：单独委托一次，
// 否则从搜索进来的人点了「访问/下载」全落在统计之外——那批人恰恰是最真实的用户
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('#seoContent a[data-act]');
  if (!a) return;
  const m = location.pathname.match(/^\/w\/([A-Za-z0-9_-]+)/);
  if (m) trackAction(m[1], a.dataset.act, a.dataset.atype);
}, true);

// 后台改了广告 → 前台静默换掉（不用手动刷新）
(function watchAdChanges() {
  const refresh = () => loadAds();
  if ('BroadcastChannel' in window) {
    try {
      const bc = new BroadcastChannel('dm-sync');
      bc.onmessage = e => { if (e.data === 'ads-changed') refresh(); };
    } catch { /* ignore */ }
  }
  window.addEventListener('storage', e => { if (e.key === 'dm_ads_changed') refresh(); });
})();


// 形态由后台管理：从接口拿名称 + 图标，动态渲染投稿 chips 与筛选下拉
async function loadTypeMeta() {
  try {
    const meta = await (await fetch('/api/type-meta')).json();
    if (Array.isArray(meta) && meta.length) {
      TYPES = ['全部', ...meta.map(t => t.name)];
      meta.forEach(t => {
        TYPE_ICONS[t.name] = t.icon || '✨';
        // 后台给形态配了图标 key 就用 SVG（单色、可随 CSS 转白），否则回退 emoji
        if (t.svg) TYPE_SVG[t.name] = t.svg;
      });
    }
  } catch { /* 用本地兜底列表 */ }
  renderTypePicker();
  renderFilters();
}

function renderTypePicker() {
  const box = $('typePicker');
  if (!box) return;
  const checked = [...box.querySelectorAll('input[name="types"]:checked')].map(i => i.value);
  const names = TYPES.filter(t => t !== '全部');
  box.innerHTML = names.map((t, i) => {
    const on = checked.length ? checked.indexOf(t) !== -1 : i === 0; // 默认勾第一个
    return `<label class="type-opt"><input type="checkbox" name="types" value="${escapeHtml(t)}"${on ? ' checked' : ''} /><span>${typeIcoHtml(t)} ${escapeHtml(t)}</span></label>`;
  }).join('')
  + `<button type="button" class="type-opt cat-add" id="typeAddBtn" title="创建并选择新形态"><span>＋ 新形态</span></button>`;
  // 「＋ 新形态」：展开起名输入框（不再保留「其他」兜底项，列表里没有的就直接建）
  const addBtn = $('typeAddBtn');
  if (addBtn) addBtn.onclick = e => {
    e.preventDefault();
    const inp = $('newTypeInput');
    if (inp) { inp.style.display = 'block'; inp.focus(); }
  };
}

// 精选区：数据没变就不动 DOM（静默刷新），避免闪烁与滚动位置跳动
let featuredSig = null; // 初始 null：精选为空时 sig='' 也不能命中，必须走到隐藏分支收起骨架
// 详情弹窗图片切换：封面图 + 宣传图合成一个列表，左右箭头循环
let galState = { list: [], offset: 1, idx: 0 }; // offset：宣传图在 list 中的起始下标
function setDetailImage(i) {
  const { list, offset } = galState;
  if (!list.length) return;
  galState.idx = (i + list.length) % list.length;
  $('detailImg').src = imgUrl(list[galState.idx], 1200);
  document.querySelectorAll('#detailGallery img').forEach((im, k) =>
    im.classList.toggle('active', offset + k === galState.idx));
  const active = document.querySelector('#detailGallery img.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

// 缩略图条两端箭头：只有在对应方向还能滚时才显示
function updateThumbArrows() {
  const gal = $('detailGallery');
  if (!gal || gal.style.display === 'none') return;
  const max = gal.scrollWidth - gal.clientWidth;
  $('thumbPrev').style.visibility = gal.scrollLeft > 2 ? 'visible' : 'hidden';
  $('thumbNext').style.visibility = max > 2 && gal.scrollLeft < max - 2 ? 'visible' : 'hidden';
}
// H5 手势：大图上左右滑动切换（缩略图条在手机上隐藏了，滑一滑是最顺手的翻图方式）
(function setupDetailSwipe() {
  const img = $('detailImg');
  if (!img) return;
  let sx = 0, sy = 0, tracking = false;
  img.addEventListener('touchstart', e => {
    if (galState.list.length < 2) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; tracking = true;
  }, { passive: true });
  img.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    // 横向位移够大且明显大于纵向，才算一次翻图，避免和上下滚动冲突
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      detailSwipeAt = Date.now();  // 刚滑完的 touchend 后浏览器还会补一个 click，别当成「点开全屏」
      setDetailImage(galState.idx + (dx < 0 ? 1 : -1));
    }
  }, { passive: true });
})();
// 详情大图全屏查看：点详情弹窗里的大图进入。与详情弹窗画廊共用 galState，
// 全屏里翻图（箭头 / ←→ 键 / 左右滑动）详情那张同步跟着走，关掉后无缝衔接；
// 点空白处或 Esc 关闭，右上角 ✕ 也行
let imgFullEl = null;
let detailSwipeAt = 0;
function openImgFull() {
  if (!galState.list.length || imgFullEl) return;
  const multi = galState.list.length > 1;
  const box = document.createElement('div');
  box.className = 'img-full';
  box.innerHTML = `
    <button class="img-full-close" title="关闭 (Esc)">✕</button>
    <img src="${escapeHtml(imgUrl(galState.list[galState.idx], 1600))}" alt="全屏大图" />
    ${multi ? '<button class="gal-arrow gal-prev" title="上一张 (←)">‹</button><button class="gal-arrow gal-next" title="下一张 (→)">›</button><span class="img-full-count"></span>' : ''}
    <span class="img-full-hint">点空白处或按 Esc 关闭${multi ? ' · 左右滑动翻图' : ''}</span>`;
  box.onclick = closeImgFull;
  box.querySelector('.img-full-close').onclick = e => { e.stopPropagation(); closeImgFull(); };
  // 全屏图要 1600 高清档；线上缩略服务还没这档时（THUMB_SIZES 未发新版）退回 1200 详情档
  box.querySelector('img').onerror = function () {
    this.onerror = null;
    this.src = imgUrl(galState.list[galState.idx], 1200);
  };
  document.body.appendChild(box);
  imgFullEl = box;   // 先挂上再刷内容：imgFullShow 里要查 imgFullEl，顺序反了首帧计数会是空的
  if (multi) {
    box.querySelector('.gal-prev').onclick = e => { e.stopPropagation(); imgFullShow(galState.idx - 1); };
    box.querySelector('.gal-next').onclick = e => { e.stopPropagation(); imgFullShow(galState.idx + 1); };
    imgFullShow(galState.idx); // 把「1 / N」计数刷出来
    // 左右滑动翻图：和详情弹窗大图同款手势、同款阈值
    let sx = 0, sy = 0, tracking = false;
    box.addEventListener('touchstart', e => {
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; tracking = true;
    }, { passive: true });
    box.addEventListener('touchend', e => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5)
        imgFullShow(galState.idx + (dx < 0 ? 1 : -1));
    }, { passive: true });
  }
  lockScroll();
  document.addEventListener('keydown', imgFullKey);
}
function imgFullShow(i) {
  if (!imgFullEl || !galState.list.length) return;
  setDetailImage(i);  // 详情弹窗那张一起同步（弹窗在全屏层底下看不见，但关掉后就在这张上）
  const im = imgFullEl.querySelector('img');
  im.onerror = function () {   // 每次换图都要重挂兜底：1600 档没上线时退 1200
    this.onerror = null;
    this.src = imgUrl(galState.list[galState.idx], 1200);
  };
  im.src = imgUrl(galState.list[galState.idx], 1600);
  const cnt = imgFullEl.querySelector('.img-full-count');
  if (cnt) cnt.textContent = (galState.idx + 1) + ' / ' + galState.list.length;
}
function closeImgFull() {
  if (!imgFullEl) return;
  imgFullEl.remove();
  imgFullEl = null;
  unlockScroll();
  document.removeEventListener('keydown', imgFullKey);
}
function imgFullKey(e) {
  if (e.key === 'Escape') closeImgFull();
  else if (e.key === 'ArrowLeft') imgFullShow(galState.idx - 1);
  else if (e.key === 'ArrowRight') imgFullShow(galState.idx + 1);
}
// 精选入选理由：告诉用户「它为什么被选进来」，而不是只丢一堆数据。
// 后端按 分数 = 获赞×5 + 收藏×8 + 评论×3 + 灯火人数×10 + 访客×2 逐项算，
// 哪个乘完权重最大就给哪个徽章（tip/fav/like/cmt/uv）；全零走 new，手选无数据走 edit
const FEAT_REASONS = {
  pick: { text: '本周热门', cls: 'is-pick', tip: '综合热度不错的作品之一' },
  edit: { text: '编辑精选', cls: 'is-pick', tip: '编辑手动收录的作品' },
  like: { text: '人气最高', cls: 'is-like', tip: '近 7 天获赞最多的作品之一' },
  fav: { text: '收藏飙升', cls: 'is-fav', tip: '近 7 天被收藏最多的作品之一' },
  cmt: { text: '话题热议', cls: 'is-cmt', tip: '近 7 天被评论最多的作品之一' },
  tip: { text: '灯火最亮', cls: 'is-tip', tip: '近 7 天收到灯火支持最多的作品之一' },
  uv: { text: '本周热看', cls: 'is-uv', tip: '近 7 天打开人数最多的作品之一' },
  new: { text: '新晋上榜', cls: 'is-new', tip: '综合热度不错，本周新进入精选' }
};
function featReasonHtml(w) {
  const r = FEAT_REASONS[w.featReason] || FEAT_REASONS.new;
  return `<span class="feat-reason ${r.cls}" title="${r.tip}">${r.text}</span>`;
}
// 精选卡的作者行：首字母头像 + 昵称（和主列表卡片保持一致的「作者在场」）
function featAuthorHtml(w) {
  const name = anamePlain(w);
  return `<span class="feat-author" title="作者 ${escapeHtml(name)}">${avaChip(w)}<span class="fa-name">${escapeHtml(name)}</span></span>`;
}

// 「本周精选」一行最多 20 个：按近 7 天综合分选出，顺序每天洗一次牌（服务端按日期做种子，当天固定）；
// `.feat-no` 只是展示序号（1~20），不再对应分数名次。
// 卡上的数据是累计口径（打开次数 / 看过人数都是全历史），近 7 天数据只用于选谁进来；
// 精选卡版式：首页「本周精选」和发现页共用（点击开详情由调用方绑定）
function featCardHtml(w, i) {
  return `
      <div class="featured-card" data-id="${w.id}">
        <span class="feat-no">${i + 1}</span>
        <img src="${imgUrl(w.thumb, 400)}" srcset="${imgSet(w.thumb)}" sizes="(max-width: 640px) 45vw, 240px" alt="${escapeHtml(w.title)}" loading="lazy" />
        <div class="featured-body">
          <div class="featured-title" title="${escapeHtml(w.title)}">${escapeHtml(w.title)}</div>
          <div class="feat-sub">${featReasonHtml(w)}${featAuthorHtml(w)}</div>
          ${w.introText ? `<div class="featured-intro">${escapeHtml(w.introText)}</div>` : ''}
          <div class="featured-meta" title="累计：详情页被打开 ${w.pvAll || 0} 次，共 ${w.uvAll || 0} 位访客打开过（同一人只算 1 个，作者本人打开不计）"><span class="fm-i" title="累计被打开的次数：同一个人反复打开也会累加"><span class="ico s-ico">${ic('eye')}</span>${w.pvAll || 0} 次打开</span><span class="fm-i" title="累计有多少人打开过：同一个人只算 1 个，作者本人打开不计"><span class="ico s-ico">${ic('person')}</span>${w.uvAll || 0} 人看过</span>${(w.favs || 0) > 0 ? `<span class="fm-i" title="被收藏次数"><span class="ico s-ico">${ic('star')}</span>${w.favs}</span>` : ''}</div>
        </div>
        <span class="feat-arrow"><span class="ico">${ic('arrowout')}</span></span>
      </div>`;
}

async function loadFeatured() {
  try {
    const data = await (await fetch('/api/featured', { cache: 'no-store' })).json();
    const list = Array.isArray(data.list) ? data.list : [];
    const sig = list.map(w => w.id).join(',');
    if (sig === featuredSig) return;
    featuredSig = sig;
    const section = $('featuredSection');
    const row = $('featRow');
    if (!list.length) {
      row.innerHTML = '';
      section.hidden = true;   // 别用 style.display：内联样式会压掉移动端隐藏整个区块的媒体查询
      return;
    }
    section.hidden = false;
    const keepLeft = row.scrollLeft;   // 原地替换内容时保留轮播位置，不把用户拉回第一张
    row.innerHTML = list.map(featCardHtml).join('');
    row.querySelectorAll('.featured-card').forEach(el =>
      el.addEventListener('click', () => {
        // 在简介上拖选了文字就别当点击处理：否则复制一句文案顺手把详情弹窗打开了
        const sel = window.getSelection ? String(window.getSelection()) : '';
        if (sel && sel.trim()) return;
        openWork(el.dataset.id);
      }));
    setupFeatInfo();
    setupFeatCarousel();
    row.scrollLeft = keepLeft;
    updateFeatNav();
  } catch { /* ignore */ }
}

// 规则说明（ⓘ）：桌面端悬停即弹（CSS），触屏/键盘走点按开关；点空白处或 Esc 关闭
function setupInfoPop(wrapId, btnId) {
  const wrap = $(wrapId), btn = $(btnId);
  if (!wrap || !btn || btn._infoInit) return;
  btn._infoInit = 1;
  // 屏幕边缘回弹：窄屏（H5）下气泡可能伸出右边缘被截断，打开时测一下，超边就平移
  const clampPop = () => {
    const pop = wrap.querySelector('.feat-info-pop');
    if (!pop) return;
    pop.style.left = '';   // 先还原，再按当前布局测
    const r = pop.getBoundingClientRect();
    if (!r.width) return;
    const pad = 8;
    // 用布局视口宽而不是 innerWidth：手机端有页面缩放/滚动条时 innerWidth 会失真
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const overR = r.right - (vw - pad);
    const overL = pad - r.left;
    if (overR > 0) pop.style.left = (parseFloat(getComputedStyle(pop).left) - overR) + 'px';
    else if (overL > 0) pop.style.left = (parseFloat(getComputedStyle(pop).left) + overL) + 'px';
  };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) clampPop();
  });
  document.addEventListener('click', e => {
    if (!wrap.classList.contains('open') || wrap.contains(e.target)) return;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !wrap.classList.contains('open')) return;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
}
function setupFeatInfo() {
  setupInfoPop('featInfo', 'featInfoBtn');      // 本周精选规则
  setupInfoPop('countInfo', 'countInfoBtn');    // 全部作品排序说明（新老作品雨露均沾）
  setupInfoPop('titleInfo', 'titleInfoBtn');    // 投稿表单「作品名字」旁的标题写法提示（触屏/键盘走点按，桌面 hover 即弹）
  const rl = $('resetSeenLink');
  if (rl) rl.onclick = wanderResetSeen;         // 气泡里给的「反悔」入口，跟池空状态共用一段逻辑
}

// 精选轮播：左右箭头 + 拖拽滚动（一行 10 张，窄屏滑动看）
function setupFeatCarousel() {
  const row = $('featRow');
  const prev = $('featPrev'), next = $('featNext');
  const step = () => {
    const card = row.querySelector('.featured-card');
    return card ? (card.offsetWidth + 14) * 2 : 400;
  };
  prev.onclick = () => row.scrollBy({ left: -step(), behavior: 'smooth' });
  next.onclick = () => row.scrollBy({ left: step(), behavior: 'smooth' });
  // 进度条：拖动滑块 / 点轨道空白处直接定位（只绑定一次）
  setupFeatBar(row);
  updateFeatNav();
  // 鼠标按住拖拽滑动（拖动中禁用卡片点击，松手即恢复）；只绑定一次
  if (!row._dragInit) {
    row._dragInit = 1;
    let down = null;
    // 按在简介上时让位给文字拖选：不接管滚动，让浏览器正常选字（简介已放开 user-select）
    row.addEventListener('pointerdown', e => {
      down = { x: e.clientX, l: row.scrollLeft, onIntro: !!(e.target.closest && e.target.closest('.featured-intro')) };
    });
    window.addEventListener('pointermove', e => {
      if (!down || down.onIntro) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 6) { row.classList.add('dragging'); row.scrollLeft = down.l - dx; }
    });
    window.addEventListener('pointerup', () => { down = null; row.classList.remove('dragging'); });
  }
}
function updateFeatNav() {
  const row = $('featRow');
  if (!row || !row.children.length) return;
  const max = row.scrollWidth - row.clientWidth;
  const noOverflow = max <= 4;
  // 卡片有 scroll-snap，最右端会差十几像素对不齐，容差放大到 24 避免箭头一直亮着
  const TOL = 24;
  $('featPrev').disabled = row.scrollLeft <= TOL;
  $('featNext').disabled = row.scrollLeft >= max - TOL;
  // 不溢出时用 visibility 隐藏箭头：保留占位，切换精选时页面不会跳
  document.querySelector('.featured-nav').style.visibility = noOverflow ? 'hidden' : 'visible';
  updateFeatBar(row);
}

// 精选横滑进度条：滑块长度 = 可视宽 / 内容宽，位置 = 已滚比例
function updateFeatBar(row) {
  const bar = $('featBar'), thumb = $('featThumb');
  if (!bar || !thumb) return;
  const max = row.scrollWidth - row.clientWidth;
  const noOverflow = max <= 4;
  bar.hidden = noOverflow;              // 一屏放得下就没有"往哪滑"的问题，整条藏掉
  if (noOverflow) return;
  const trackW = bar.clientWidth;
  if (!trackW) return;
  const w = Math.max(34, Math.round(trackW * (row.clientWidth / row.scrollWidth)));
  bar._trackW = trackW;
  bar._thumbW = w;
  thumb.style.width = w + 'px';
  thumb.style.left = Math.round((trackW - w) * (row.scrollLeft / max)) + 'px';
}

function setupFeatBar(row) {
  const bar = $('featBar');
  if (!bar || bar._barInit) return;
  bar._barInit = 1;
  let dragging = false;
  // 把指针横坐标换算成滚动位置：让滑块中心跟手
  const seek = clientX => {
    const r = bar.getBoundingClientRect();
    const tw = bar._trackW || r.width, w = bar._thumbW || 34;
    const span = tw - w;
    if (span <= 0) return;
    const x = Math.min(Math.max(clientX - r.left - w / 2, 0), span);
    row.scrollLeft = (x / span) * (row.scrollWidth - row.clientWidth);
  };
  bar.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
    dragging = true;
    bar.classList.add('is-drag');
    row.classList.add('dragging');   // 拖拽期间关掉 scroll-snap，否则每松一下都会被吸回去
    seek(e.clientX);
  });
  bar.addEventListener('pointermove', e => { if (dragging) seek(e.clientX); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('is-drag');
    row.classList.remove('dragging');
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}

// ---------- 即将上线（预告 / 平台上架审核中）----------
// 2026-11-13 从首页横滑版块挪进酒馆 /bar 右栏：还在做和等平台审核的作者本就不该被
// 首页那条"预备区"劝退，挪到酒馆当右栏卡片（紧跟推荐位下面），主列表只收真正上线的作品。
// 用「上线提醒我」把这份期待留到上线当天（上线时服务端会给所有订阅者发站内消息）。
let upcomingSig = '';

// 右栏行卡：小方图 + 标题行（阶段徽标并进标题，52px 方图盖不下徽标）+ 进度条 + 预计时间 + 提醒按钮
function upcomingCardHtml(w) {
  const st = stageOf(w);
  const pct = typeof w.progress === 'number' ? w.progress : 0;
  const eta = w.eta
    ? `预计 ${w.eta.slice(5).replace('-', '/')} 上线`
    : (st === 'reviewing' ? '等平台审核通过' : '上线时间待定');
  return `
    <div class="up-card is-${st}" data-id="${escapeHtml(w.id)}">
      <div class="up-img">
        <img src="${imgUrl(w.thumb, 400)}" alt="${escapeHtml(w.title)}" loading="lazy" />
      </div>
      <div class="up-body">
        <div class="up-title-row">${stageBadgeHtml(w, 'up-stage')}<span class="up-title">${escapeHtml(w.title)}</span></div>
        ${st === 'wip' ? `<div class="coming-bar"><span style="width:${pct}%"></span></div>` : ''}
        <div class="up-foot">
          <span class="up-eta">${escapeHtml(eta)}</span>
          <button type="button" class="up-watch${w.watched ? ' is-on' : ''}" data-watch="${escapeHtml(w.id)}">${w.watched ? '✓ 已订阅' : `<span class="ico">${ic('bell')}</span> 提醒我`}${w.watchCount ? ` · ${w.watchCount}` : ''}</button>
        </div>
      </div>
    </div>`;
}

// ---------- 首页「随便逛逛」：分层随机推荐（docs/discover-spec-v1.md） ----------
// 接口 404（后台关了）→ 整段不渲染；state=empty → 空状态三出口；partial → 补齐卡打「重温」。
// 曝光口径：可视区 ≥50% 持续 500ms 才算，同作品 5 分钟只报一次，300ms 合并批量上报。
// 首屏闸门：刷新出来就摆在屏幕里的卡先不记「看过」，用户往下滚了才按同一口径补记——
// 否则 5 列一屏两行 10 张，用户一行没翻就被消耗掉（2026-11-09 线上踩过）。
const WANDER_STATE_KEY = 'wanderRandom';       // sessionStorage：随便翻翻的 nonce/模式，24h 有效
const WANDER_STATE_TTL = 24 * 3600 * 1000;
const WANDER_REFETCH_GAP = 10 * 60 * 1000;     // 防静默刷新反复取卡推进队列：10 分钟内不重拉
let wanderMode = 'pool';
// 随便逛逛的两张卡脸：PC/手机网格是 .card，手机列表模式是 .work-row（推广行是
// .work-row.promo-row，要排除——它走 adTrack 自己的曝光，绝不混进有机口径）。
// 2026-11-10 修：此前所有地方只查 .card，手机列表模式的行卡曝光完全不上报，
// 「加载更多」的追加去重也漏掉行卡，同名作品会重复渲染。
const WANDER_CARD_SEL = '.card:not(.promo-card), .work-row:not(.promo-row)';

let wanderPage = 0;
let wanderRandSize = 0;                      // 随机翻翻全程共用的一屏张数（换 size 会让按页发牌漏项）
let wanderNonce = '';
let wanderBusy = false;
let wanderLastAt = 0;
let wanderObserver = null;
let wanderFlushTimer = null;
let wanderFoldGate = null;                     // Set<id>：本轮渲染首屏已可见的卡，滚动前不计数
let wanderFoldY = 0;                           // 建闸时的滚动位置：位移超过阈值才算「人真的滚了」
const wanderPending = new Set();               // 待批量上报的曝光 ids
const wanderSeen5m = new Map();                // id -> ts：同作品 5 分钟内只报一次
// 「还有 N 件没逛过」实时口径（2026-11-10）：服务端只给「没看过的总数」（不再按批预扣），
// 前端每真实看完一件就在本地减一，滚动时数字实时往下走；下次取数由服务端重新校准。
let wanderTotal = 0;
let wanderLeft = 0;
const wanderRevisitIds = new Set();            // 服务端标过「重温」的 id：本就在已看名单，不该递减 left

// 用户滚动了 → 放行首屏闸门：把首屏里 ≥50% 可见的卡按正常口径补记
function releaseWanderFold() {
  const gate = wanderFoldGate;
  wanderFoldGate = null;
  if (!gate || !gate.size) return;
  document.querySelectorAll('#gallery ' + WANDER_CARD_SEL).forEach(el => {
    const id = el.dataset.id;
    if (!id || !gate.has(id)) return;
    if (wanderCardShown(el) >= 0.5) wanderMarkSeen(id);
  });
}
// 位移阈值 8px：手机上地址栏收起/回弹、惯性残余也会抛 scroll，别让这种抖动提前放闸
window.addEventListener('scroll', () => {
  if (wanderFoldGate && Math.abs(window.scrollY - wanderFoldY) > 8) releaseWanderFold();
}, { passive: true });

// 进页面先看有没有未过期的「随便翻翻」状态：有就直接继续随机（spec §6.5）
(function wanderRestoreState() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(WANDER_STATE_KEY) || 'null');
    if (raw && raw.mode === 'random' && /^[A-Za-z0-9_-]{1,64}$/.test(String(raw.nonce || '')) &&
        Date.now() - (raw.at || 0) < WANDER_STATE_TTL) {
      wanderMode = 'random';
      wanderNonce = raw.nonce;
    }
  } catch { /* ignore */ }
})();
function wanderSaveState() {
  try {
    sessionStorage.setItem(WANDER_STATE_KEY, JSON.stringify({ mode: wanderMode, nonce: wanderNonce, at: Date.now() }));
  } catch { /* ignore */ }
}
function wanderClearState() {
  try { sessionStorage.removeItem(WANDER_STATE_KEY); } catch { /* ignore */ }
}
function wanderNewNonce() {
  wanderNonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  wanderMode = 'random';
  wanderPage = 0;
  wanderSaveState();
}

// 一屏张数：后端不感知列数（spec §3.3），按列表分页口径算满页条数（4 列 16 / 5 列 20）。
// 但推广卡也占一格：首屏 mountWanderPromo 必插一张，后续批次最多插 WANDER_PROMO_PER_BATCH 张。
// 让格逻辑跟 pageSizeOf() 同一口径 —— 满页 20 件再插 1 张 = 21 张卡，最后一行只剩孤零零一张
//（2026-11-09 二次踩：最新列表靠 pageSizeOf 让格修过同一个坑，随便逛逛这边写死了 pageSizeOf(2) 绕开它）
function wanderPromoReserve(reset) {
  if (reset) return listPromoAd() ? 1 : 0;
  return wanderPromoPool().length ? WANDER_PROMO_PER_BATCH : 0;
}
function wanderSize(reserve = 0) {
  return Math.min(30, Math.max(4, pageSizeOf(2) - reserve));
}

// 空状态出口：切回主列表的排序并滚过去。清掉翻翻状态，别下次进页还停在随机模式
// 这里的「去最新 / 去看最热」也是用户亲手点的 → 一样写进排序记忆
function wanderGoSort(sort) {
  wanderClearState();
  wanderFoldGate = null;   // 切走清闸，残留的放行回调不能误记最新列表的卡
  wanderMode = 'pool'; wanderPage = 0;
  state.sort = sort;
  saveSort(sort);
  syncSortToggle();
  loadWorks();
  const head = $('worksHead');
  if (head && head.scrollIntoView) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 清空已看名单：两个入口共用——① 池空状态文字链 ② ⓘ 排序气泡里的链接。
// 清完回池模式重取一屏；浏览/访客统计（/api/track）不动，服务端也只清 users[key].ids
async function wanderResetSeen() {
  if (!confirm('清空已看名单？之后全站作品会重新推荐给你（浏览 / 访客统计不受影响）。')) return;
  try {
    const r = await fetch('/api/discover/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid: visitorId() })
    });
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) return showToast((d && d.error) || '没清成，稍后再试', undefined, 'err');
    showToast(d.cleared ? `已清空 ${d.cleared} 件，重新给你挑` : '已清空，重新给你挑');
    if (state.sort === 'wander') {
      wanderClearState();
      wanderMode = 'pool'; wanderPage = 0;
      loadWanderIntoGallery(true);
    }
  } catch { showToast('网络异常，稍后再试', undefined, 'err'); }
}

// 从随便逛逛切回最新（点筛选/搜索/收藏时调用——随便逛逛不认识这些筛选，硬套会货不对板）
// 程序自己切的不写 dm_sort：这是「这次列表需要最新」，不是用户改了排序习惯
function wanderBreakoutLatest() {
  if (state.sort !== 'wander') return;
  state.sort = 'latest';
  syncSortToggle();
}

// 「新」口径：服务端给的 freshSince（这个人上次来逛的时间点，见 server.js wanderFreshSince）。
// 为什么不按固定的「7 天内」：小站一次批量上架几十件，固定窗口会让半屏卡片都挂「新」——
// 2026-11-12 实测 31 张卡里 16 张命中，等于没标。相对「上次来」才是「这里有新作」的本意。
// 只给随便逛逛打标：「最新」排序本来就按时间排，再贴「新」是同义反复。
let WANDER_FRESH_SINCE = 0;
function isWanderNew(w) {
  if (!WANDER_FRESH_SINCE) return false;
  const t = Date.parse((w && w.createdAt) || '');
  return !!t && t >= WANDER_FRESH_SINCE;
}

// 随便逛逛的两种卡脸各贴各的角标：
// - 网格卡：角标进图区右上角（左上角是形态胶囊，右下是收藏/分享，都占着）
// - 列表行（手机默认视图）：没有封面图，「新」做成标题前的小 chip
// 「新」优先于「重温」：一件作品既新又被看过时，先说更用得上信息量的那个。
// revisit 默认取作品上的标记（取卡接口给的），换卡时就地传进 DOM 里读到的值。
function wanderCardHtml(item) {
  const html = state.view === 'list' ? listHtml(item) : cardHtml(item, {});
  return decorateWanderCard(html, item, state.view === 'list');
}

function decorateWanderCard(html, w, isRow, revisit = !!(w && w.revisit)) {
  if (isRow) {
    return isWanderNew(w)
      ? html.replace('<div class="row-title">', '<div class="row-title"><span class="row-new">新</span>')
      : html;
  }
  const isNew = isWanderNew(w);
  if (!isNew && !revisit) return html;
  // 右上角可能已经有「开发中 / 等上架审核」徽标：新作品撞上它的概率不低，
  // 撞了就往下让一行（is-below），别两个胶囊叠成一坨。
  // 两个角标都 pointer-events:none（别挡卡片点击），所以不挂 title——hover 不到等于没有
  const below = isComing(w) ? ' is-below' : '';
  const badge = isNew
    ? `<span class="wander-new${below}">新</span>`
    : `<span class="wander-re${below}">重温</span>`;
  return html.replace('<div class="card-img-wrap">', '<div class="card-img-wrap">' + badge);
}

// 点进详情统计：主列表上只统计随便逛逛批次的点击（最新/最热不算曝光点击）。全局只绑一次
let wanderClickBound = false;
function bindWanderClicks() {
  if (wanderClickBound) return;
  wanderClickBound = true;
  $('gallery').addEventListener('click', e => {
    if (state.sort !== 'wander') return;
    // 与 bindCards 同一套豁免：收藏/分享/屏蔽按钮不是「点进详情」（图标无 dataset，按类名找）
    if (e.target.closest && e.target.closest('.fav-star')) return;
    const el = e.target.closest('.card, .work-row');
    if (el && el.dataset.id) trackExpoClick(el.dataset.id);
  }, true);
}

async function loadWanderIntoGallery(reset = true, force = true) {
  const g = $('gallery');
  if (!g || wanderBusy) return;
  if (!force && Date.now() - wanderLastAt < WANDER_REFETCH_GAP) return;   // 静默同步节流，别反复推进队列
  wanderBusy = true;
  // 加载态放在最前面（点「随便逛逛 / 随便翻翻」立刻有反馈）：
  // 空状态原地压暗 / 空容器放「点灯」，然后才等广告数据——2026-11-10 修：
  // 原来这两步排在 ensureAds 之后，点了按钮画面一小段什么都不动，接着空状态突然消失、
  // loading 在视线外冒出来，观感就是「这东西居然从下边出来了」
  const seq = reset ? listLoadingStart() : 0;
  // 和 loadWorks 同一理由：先套上 4/5/6 列选择，再量栅格列数，否则首屏按 CSS 自适应的列数算
  //（1080 宽会量到 4 列、真渲染是 5 列），拉回来的条数跟实际列数对不上，尾巴又歪了
  applyGalleryCols();
  if (reset) {
    g.classList.toggle('list-mode', state.view === 'list');
    renderListLoader();   // 只在容器全空且空状态没挂着时才放「点灯」；空状态挂着就原地压暗
  }
  await ensureAds();   // 随便逛逛首屏要插首页第一格那张推荐卡，先等广告数据到位
  try {
    const reserve = wanderPromoReserve(reset);
    let size = wanderSize(reserve);
    // 随机翻翻是「同 nonce 按 size 切片发牌」，同一轮里换 size 会漏项；整轮锁死首屏那次算出来的张数
    if (wanderMode === 'random') {
      if (reset || !wanderRandSize) wanderRandSize = size;
      else size = wanderRandSize;
    }
    const q = new URLSearchParams({ size: String(size), vid: visitorId() });
    if (wanderMode === 'random') {
      q.set('mode', 'random');
      q.set('seed', wanderNonce);
      q.set('page', String(wanderPage));
    } else if (!reset) {
      // 「加载更多」把屏上已有的 id 一起发过去，让服务端别再把它们发回来。
      // 只靠「已看名单」去重是不够的：追加的卡在视口下方，不会上报曝光，服务端那边
      // 池子毫无变化 → 每批都重新随机抽同一批没看过的，前端去重后只剩两三张新卡，
      // 按钮永远点不完（2026-11-13 手机端复现）。带上 exclude 每批都是整屏新卡。
      // 200 个上限：约 2.4KB，够翻完整站又不会把 URL 撑爆
      const onScreen = Array.from($('gallery').querySelectorAll(WANDER_CARD_SEL), el => el.dataset.id)
        .filter(Boolean).slice(-200);
      if (onScreen.length) q.set('exclude', onScreen.join(','));
    }
    const res = await fetch('/api/discover?' + q.toString(), { cache: 'no-store' });
    if (res.status === 404) {
      // 后台把模块关了：回落到最新，不留死档位（模块都可能关掉，这条兜底不写进排序记忆，
      // 否则下次打开先请求 wander、再 404、再跳最新，白闪一下）
      state.sort = 'latest';
      syncSortToggle();
      return loadWorks();
    }
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) return;
    // 等待网络期间用户切走了（点了最新/最热、搜索、收藏）：这批是过时数据，
    // 别再覆盖人家的新列表。加载态由 finally 统一收掉，这里直接放弃渲染。
    if (state.sort !== 'wander' || state.q || !isPlainListView()) return;
    wanderLastAt = Date.now();
    wanderTotal = data.total || 0;
    wanderLeft = typeof data.left === 'number' ? data.left : 0;
    // 「新」角标分界线：首屏锁一次，后续批次沿用（服务端半小时内返回同一个值，
    // 所以翻到后面「新」也不会时有时无）；没有这个字段（老接口/模块降级）就一律不标
    if (reset || !WANDER_FRESH_SINCE) {
      const fs = Number(data.freshSince) || 0;
      if (fs > 0) WANDER_FRESH_SINCE = fs;
    }
    (Array.isArray(data.revisit) ? data.revisit : []).forEach(id => wanderRevisitIds.add(id));
    const list = Array.isArray(data.list) ? data.list : [];
    const emptyBox = $('empty');
    // 清理上一轮残留（有内容时要撤掉空状态的按钮/说明，切回普通列表也别留着）
    emptyBox.querySelectorAll('.wander-empty-btns, .wander-empty-sub, .wander-empty-reset').forEach(n => n.remove());
    emptyBox.classList.remove('wander-empty');
    // 优先池空（这个人把全站看完了）→ 空状态给三个出口，不硬凑重复内容（spec §6.4）
    if (wanderMode === 'pool' && data.state === 'empty') {
      const ghBefore = Math.round(g.getBoundingClientRect().height);
      if (reset) g.innerHTML = '';
      g.classList.remove('list-mode');
      const emptyP = emptyBox.querySelector('p');
      if (emptyP) { emptyP.textContent = '全站的作品你都看过了'; emptyP.className = 'wander-empty-title'; }
      emptyBox.classList.add('wander-empty');
      // 结构：标题 → 一句说明（副标题）→ 三个出口按钮 → 清空已看重置链接，间距交给 CSS 统一控
      emptyBox.insertAdjacentHTML('beforeend', `
        <p class="wander-empty-sub">「随便翻翻」是全站乱序翻页，看过的也会出现</p>
        <div class="wander-empty-btns">
          <button class="btn-primary" id="wanderBtnRandom" type="button">随便翻翻</button>
          <button class="btn-ghost" id="wanderBtnNew" type="button">去最新</button>
          <button class="btn-ghost" id="wanderBtnHot" type="button">去看最热</button>
        </div>
        <p class="wander-empty-reset"><a href="javascript:void(0)" id="wanderResetSeen">清空已看，重新推荐</a></p>`);
      emptyBox.style.display = 'block';
      $('wanderBtnRandom').onclick = () => { wanderNewNonce(); loadWanderIntoGallery(true); };
      $('wanderBtnNew').onclick = () => wanderGoSort('latest');
      $('wanderBtnHot').onclick = () => wanderGoSort('hot');
      $('wanderResetSeen').onclick = wanderResetSeen;
      easeGalleryShrink(ghBefore);   // 列表换成空状态高度塌一大截，缓动放掉别「啪」一下
      $('workCount').textContent = `共 ${data.total} 件`;
      $('loadMore').style.display = 'none';
      return;
    }
    // 随机翻翻翻到底 → 页内提示 + 出口，加载更多收起来
    if (wanderMode === 'random' && !list.length) {
      $('loadMore').style.display = 'none';
      if (!reset) {
        g.insertAdjacentHTML('beforeend', `
          <div class="wander-foot">
            <button class="btn-primary" id="wanderAgain" type="button">从头再翻</button>
            <button class="btn-ghost" id="wanderBack" type="button">回到随便逛逛</button>
            <span class="wander-foot-hint">这一轮翻完了</span>
          </div>`);
        $('wanderAgain').onclick = () => { wanderNewNonce(); loadWanderIntoGallery(true); };
        $('wanderBack').onclick = () => { wanderClearState(); wanderMode = 'pool'; wanderPage = 0; loadWanderIntoGallery(true); };
      }
      return;
    }
    const ghBefore = Math.round(g.getBoundingClientRect().height);   // 替换前高度，给高度缓动用
    if (reset) { g.innerHTML = ''; $('empty').style.display = 'none'; }   // 数据到手再替换，加载期间空状态/旧卡原地留着，高度稳定
    // 追加批次去重：正常不会再撞（请求带了 exclude），这里留一道兜底，
    // 防的是「点了加载更多、同时自动触发也发了一次」这种并发双发
    const existing = new Set(Array.from(g.querySelectorAll(WANDER_CARD_SEL), el => el.dataset.id));
    const fresh = reset ? list : list.filter(w => !existing.has(w.id));
    if (!reset && !fresh.length) {
      // 服务端已经把屏上的全排掉了还给不出新卡 = 没看过的都在页面里了。
      // 以前这里静默 return，按钮原地留着 → 用户能一直点、每点一次什么都不动（线上那个 bug）。
      wanderBusy = false;
      state.hasMore = false;
      $('loadMore').style.display = 'none';
      return;
    }
    g.classList.toggle('list-mode', state.view === 'list');
    // 随便逛逛：首屏(reset)只放首图推广，其余批次随机插几张「推荐」卡（作者灯火自荐位，非后台广告）
    g.insertAdjacentHTML('beforeend', buildWanderBatchHtml(fresh, !reset));
    bindCards(g);
    wanderObserve(g);
    wireWanderPromos(g);   // 给本批新插的推荐卡接点击/曝光（首屏那张由 mountWanderPromo 接）
    // 首屏闸门：整屏重取（刷新/切回）时，屏幕里已有的卡先不计数；「加载更多」说明
    // 用户在往下翻，立即放行（追加的卡本来就在视口下方，走正常观测）
    if (reset) {
      wanderFoldGate = new Set();
      wanderFoldY = window.scrollY || 0;
      g.querySelectorAll(WANDER_CARD_SEL).forEach(el => {
        if (!el.dataset.id || el.classList.contains('promo-card') || el.classList.contains('promo-row')) return;
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) wanderFoldGate.add(el.dataset.id);
      });
      if (!wanderFoldGate.size) wanderFoldGate = null;
    } else if (wanderFoldGate) {
      releaseWanderFold();
    }
    if (reset) mountWanderPromo();   // 首屏最前面插首页第一格推荐卡（只插一张，其余全是正常作品）
    if (reset) easeGalleryShrink(ghBefore);   // 新一批比旧一批矮时把「缩上来」变成缓动，不抖
    $('listTitle').textContent = state.q ? `搜索「${state.q}」` : '全部作品';
    // 排序说明 ⓘ 2026-11-11（二次挪）：常驻挂在「全部作品」计数行（HTML 里随 workCount），
    // 不再按池模式显隐——它解释的排序规则在最新/最热下也成立（一键筛选/搜索会切回最新）。
    // hasMore：left 是「没看过的总数」，屏上已有的没看过卡（含本批）都算已经发给他了——
    // 两者相等就说明没看过的全在页面里，再点也只会拿到重复卡，按钮该收起来。
    // 旧口径是「left > 本批张数」，每批都成立 → 按钮永远亮着，这是线上那个能一直点的根因。
    if (wanderMode === 'pool') {
      const renderedUnseen = Array.from(g.querySelectorAll(WANDER_CARD_SEL))
        .filter(el => el.dataset.id && !wanderRevisitIds.has(el.dataset.id)).length;
      state.hasMore = wanderLeft > renderedUnseen;
    } else {
      state.hasMore = true;   // 随机翻翻：服务端洗牌按页发牌，翻到头会回空批次给「从头再翻」出口
    }
    $('loadMore').style.display = state.hasMore ? 'inline-block' : 'none';
    // 计数文案跟着按钮一起收：翻完了就别再说「还有 80 件没逛过」——没看过的都在屏上，
    // 再配一条「已全部翻完」才不打架（滚下去曝光的递减也只在 hasMore 为真时才改写）
    $('workCount').textContent = wanderMode === 'pool'
      ? (state.hasMore ? `共 ${wanderTotal} 件 · 还有 ${wanderLeft} 件没逛过` : `共 ${wanderTotal} 件 · 已全部翻完`)
      : `随机翻翻 · 第 ${wanderPage + 1} 批`;

  } catch { /* 统计失败不影响页面 */ } finally {
    wanderBusy = false;
    listLoadingEnd(seq);   // 成功失败都收工：撤掉压暗，计数已被真实数字覆盖
  }
}

// 卡片当前可见比例（0~1）。用几何量实测，不依赖 IntersectionObserver 的回调时机
function wanderCardShown(el) {
  if (!el || !el.isConnected) return 0;
  const r = el.getBoundingClientRect();
  if (r.height <= 0) return 0;
  const vh = window.innerHeight || 1;
  return (Math.min(r.bottom, vh) - Math.max(r.top, 0)) / r.height;
}

// 曝光观测：可视 ≥50% 持续 500ms 才算（挡预加载/快速滚过），离开视口就取消
// 2026-11-10 修：手机上惯性快速滑动时，「离开视口」的回调可能比 500ms 定时器晚到，
// 定时器先响就把划过去的卡记成「看过」——一屏七八张却显示看了十几个。
// 所以定时器响的那一刻再用几何位置复核一次：卡已经滚出视口就作废，不记账。
function wanderObserve(grid) {
  if (wanderObserver) wanderObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;
  wanderObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      const id = en.target && en.target.dataset && en.target.dataset.id;
      if (!id) continue;
      if (en.isIntersecting && en.intersectionRatio >= 0.5) {
        if (!en.target._wanderTimer) en.target._wanderTimer = setTimeout(() => {
          en.target._wanderTimer = null;
          if (wanderCardShown(en.target) < 0.5) return;   // 复核：慢了一拍的回调不算数
          wanderMarkSeen(id);
        }, 500);
      } else if (en.target._wanderTimer) {
        clearTimeout(en.target._wanderTimer);
        en.target._wanderTimer = null;
      }
    }
  }, { threshold: [0.5] });
  grid.querySelectorAll(WANDER_CARD_SEL).forEach(el => {
    if (el.classList.contains('promo-card') || el.classList.contains('promo-row')) return;   // 推荐卡不算随便逛逛有机曝光
    wanderObserver.observe(el);
  });
}
function wanderMarkSeen(id) {
  if (wanderFoldGate && wanderFoldGate.has(id)) return;   // 首屏闸：用户滚动前不记录
  const now = Date.now();
  if (now - (wanderSeen5m.get(id) || 0) < 5 * 60 * 1000) return;   // 防抖：来回滚动不刷计数
  wanderSeen5m.set(id, now);
  if (wanderSeen5m.size > 300) {   // 内存兜底：只留最近的
    const cut = now - 5 * 60 * 1000;
    for (const [k, t] of wanderSeen5m) if (t < cut) wanderSeen5m.delete(k);
  }
  wanderPending.add(id);
  if (!wanderFlushTimer) wanderFlushTimer = setTimeout(wanderFlushExpo, 300);
  // 「还有 N 件没逛过」实时递减：真实看完一件减一件。重温卡本就在已看名单，不减；
  // 每次取数服务端会按已看名单重算 left，本地数字最多飘一小段就被校准。
  if (state.sort === 'wander' && wanderMode === 'pool' && !wanderRevisitIds.has(id) && wanderLeft > 0) {
    wanderLeft--;
    const wc = $('workCount');
    // 翻完（按钮已收）时计数改成「已全部翻完」，往下滚别再改回「还有 N 件没逛过」
    if (wc && state.hasMore) wc.textContent = `共 ${wanderTotal} 件 · 还有 ${wanderLeft} 件没逛过`;
  }

}
function wanderFlushExpo() {
  wanderFlushTimer = null;
  if (!wanderPending.size) return;
  const ids = [...wanderPending];
  wanderPending.clear();
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ path: location.pathname + location.search, action: 'expo', ids, vid: visitorId() })
    }).catch(() => {});
  } catch { /* ignore */ }
}
// 详情点击上报：单独字段，不改 n、不消耗曝光名额（方案 A）
function trackExpoClick(id) {
  if (!id) return;
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ path: location.pathname + location.search, action: 'expoClick', workId: id, vid: visitorId() })
    }).catch(() => {});
  } catch { /* ignore */ }
}

async function loadUpcoming() {
  const sec = $('barUpcoming'), row = $('barUpList');
  if (!sec || !row) return;   // 只在酒馆页有这个容器，别的页面不白拉接口
  try {
    const d = await (await fetch('/api/upcoming?limit=4')).json();
    const items = (d && d.items) || [];
    // 签名一致就不动 DOM：静默刷新时不打断用户点「提醒我」
    const sig = items.map(w => `${w.id}:${w.watchCount}:${w.watched ? 1 : 0}:${w.progress}`).join('|');
    if (sig === upcomingSig) return;
    upcomingSig = sig;
    if (!items.length) { sec.hidden = true; row.innerHTML = ''; return; }
    row.innerHTML = items.map(upcomingCardHtml).join('');
    sec.hidden = false;
    bindUpcoming(row);
  } catch { sec.hidden = true; }
}

function bindUpcoming(row) {
  row.querySelectorAll('.up-card').forEach(el => {
    el.onclick = e => { if (e.target.closest('[data-watch]')) return; openWork(el.dataset.id); };
  });
  row.querySelectorAll('[data-watch]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!state.user) { openAuth('login'); return; }
      const on = !btn.classList.contains('is-on');
      btn.disabled = true;
      try {
        const r = await fetch('/api/works/' + encodeURIComponent(btn.dataset.watch) + '/watch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on })
        });
        const d = await r.json();
        if (!r.ok) { showToast(d.error || '操作失败', undefined, 'err'); return; }
        btn.classList.toggle('is-on', !!d.watched);
        btn.innerHTML = `${d.watched ? '✓ 已订阅' : `<span class="ico">${ic('bell')}</span> 提醒我`}${d.watchCount ? ` · ${d.watchCount}` : ''}`;
        upcomingSig = '';   // 计数变了，下次刷新重画一次
        showToast(d.watched ? '上线当天会给你发站内消息' : '已取消上线提醒', undefined, 'ok');
      } catch { showToast('操作失败，请稍后重试', undefined, 'err'); }
      finally { btn.disabled = false; }
    };
  });
}

// 后台改了精选/置顶/审核/删除 → 前台静默同步（不整页重载、不打断浏览）
// 同浏览器多标签：BroadcastChannel + localStorage 双通道即时通知；其他设备：切回标签页/聚焦时拉一次
(function setupSilentSync() {
  const refresh = () => {
    // 只刷新精选区（数据没变连 DOM 都不动）＋详情弹窗里的精选标签，
    // 不重载页面、不打断浏览，滚动位置和轮播位置都保留。
    // 榜单/酒馆/作者页上没有精选区，别白拉两个接口（pageshow 在首次加载时也会触发一次）
    if (location.pathname === '/bar') { loadUpcoming(); return; }   // 酒馆右栏「即将上线」跟着后台静默同步
    const needFeat = location.pathname === '/' || location.pathname.startsWith('/w/');
    if (!needFeat) return;
    loadFeatured();
    if (state.sort === 'wander') loadWanderIntoGallery(true, false);   // 节流版：聚焦时不会反复取卡推进队列
  };
  if ('BroadcastChannel' in window) {
    try {
      const bc = new BroadcastChannel('dm-sync');
      bc.onmessage = e => { if (e.data === 'works-changed') refresh(); };
    } catch { /* ignore */ }
  }
  window.addEventListener('storage', e => { if (e.key === 'dm_works_changed') refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
})();

// ---------- 列表刷新中的加载态（2026-11-10）----------
// 点「随便逛逛 / 最新 / 最热」、切筛选、换视图都会走到这里，做两件事：
//   ① 计数位立刻转小圈 + 「加载中…」：点了就有反馈，不再干等；
//   ② 旧卡片原地留着、整块压暗（.is-loading）：不清空容器＝高度一点不变，
//      数据到了再整体替换，页面不会先塌一下再长回来（那就是「抖动」的来源）。
// 首屏容器本来就空，压暗没意义，交给 renderListLoader 放「点灯」动画（不再铺骨架卡）。
// seq 是防串台令牌：慢的旧请求回来时，不许把后发起那次加载的加载态收掉。
let listLoadSeq = 0;
const LIST_DIM_DELAY = 140;   // 本地/缓存秒回的那几次别压暗闪一下，只有真等网络才压
function listLoadingStart() {
  const seq = ++listLoadSeq;
  const g = $('gallery');
  const em = $('empty');
  // 有真卡片才压暗；空容器（只有「点灯」动画）压暗没意义，反而把动画也一起压灰了。
  // 空状态还挂着的（池空出口 / 无结果）也原地压暗：点了按钮画面不动，数据到了再换——
  // 2026-11-10 修：原来空状态被瞬间藏掉、loading 插到视线外，看起来像「从下面冒出来」
  const gDim = !!(g && g.children.length && !g.querySelector('.dm-load'));
  const emDim = !!(g && em && em.style.display !== 'none');
  if (gDim || emDim) {
    clearTimeout(g._dimTimer);
    g._dimTimer = setTimeout(() => {
      if (seq !== listLoadSeq) return;   // 期间又有新加载接手就别压了
      if (gDim) g.classList.add('is-loading');
      if (emDim) em.classList.add('is-loading');
    }, LIST_DIM_DELAY);   // 本地/缓存秒回的那几次别压暗闪一下，只有真等网络才压
  }
  const wc = $('workCount');
  if (wc) wc.innerHTML = '<i class="list-spin" aria-hidden="true"></i>加载中…';
  return seq;
}
function listLoadingEnd(seq) {
  if (seq != null && seq !== listLoadSeq) return;   // 已被更新的那次加载接手，别抢着收
  const g = $('gallery');
  if (g) { clearTimeout(g._dimTimer); g.classList.remove('is-loading'); }
  const em = $('empty');
  if (em) em.classList.remove('is-loading');
}

// 高度缓动（FLIP 思路）：整批替换列表时，新内容比旧内容矮的话页面会「啪」一下缩上来，
// 底部内容瞬间跳一截——这就是「点随便逛逛页面抖动一下」的另一半来源（空池/短列表最明显）。
// 做法：换完内容量一下新旧高度，把 min-height 从旧高度缓动到新高度再撤掉，
// 页面下方的内容就是滑上去的，不是跳上去的。变高不用动（往下长不挡视线，也不抖）。
function easeGalleryShrink(before) {
  const g = $('gallery');
  if (!g || !g.animate) return;
  g._shrinkAnim?.cancel();   // 上一次缓动还没放完又换内容：先撤，别拿旧高度压新列表
  const after = Math.round(g.getBoundingClientRect().height);
  if (after >= before - 4) return;
  const anim = g.animate(
    [{ minHeight: before + 'px' }, { minHeight: after + 'px' }],
    { duration: 260, easing: 'ease', fill: 'both' }
  );
  anim.onfinish = () => anim.cancel();   // 撤掉后自然高度就是 after，不会回跳
  g._shrinkAnim = anim;
}

// 「点灯」占位块（文案可定制）：首页列表和作者主页共用同一枚动画，别各画一套 loading。
// 容器里独占一整行（.dm-load 有 grid-column:1/-1），内容回来往下长，页面不会先塌再撑开。
function dmLoadHtml(text) {
  return `<div class="dm-load" role="status" aria-live="polite">
    <div class="dm-load-win" aria-hidden="true"><i></i><i></i><i></i></div>
    <p class="dm-load-txt">${text}</p>
  </div>`;
}

// 容器还是空的（首屏、或清空后的重载）时，放一枚「点灯」小动画占位。
// 不再铺一屏假骨架卡：假卡尺寸是猜的，数据回来还得整块换掉，短列表时反而更容易跳；
// 点灯只占一小块高度，内容回来是往下长，页面不会先塌一下再撑开。
// 已经有真卡片时不动——那种情况交给 .is-loading 压暗，旧内容原地留着，高度一点不变。
function renderListLoader() {
  const g = $('gallery');
  if (!g || g.children.length) return;   // 有内容（含 index.html 里预置的那枚动画）就不动
  const em = $('empty');
  if (em && em.style.display !== 'none') return;   // 空状态挂着就让它原地压暗等结果，别再往别处插一枚点灯
  em.style.display = 'none';
  g.insertAdjacentHTML('beforeend', dmLoadHtml('正在点亮橱窗…'));
}

async function loadWorks(reset = true) {
  applyGalleryCols();   // 先套上列数选择，下面量栅格列数才准（首屏在样式生效前也会走这里）
  // 随便逛逛：主列表直连取卡（筛选/搜索的入口都会先 wanderBreakoutLatest 切回最新，这里兜一层底）
  if (state.sort === 'wander' && isPlainListView() && !state.q) {
    return loadWanderIntoGallery(reset);
  }
  if (wanderObserver) wanderObserver.disconnect();   // 切回最新/最热就别再观测曝光了
  wanderFoldGate = null;
  // 第 1 页要给推荐卡留格：广告数据必须先到手，pageSize 才能算准。
  // 之前 route() 比 loadAds() 先跑，listPromoAd() 读到的是空 ADS，
  // 有推荐时第 1 页仍按满页拉，推荐卡插进来就多出一条尾巴（16+1=17）。
  let loadSeq = 0;
  // 加载态先行（点排序/筛选立刻有反馈）：压暗 + 计数位转圈 + 空容器放「点灯」/空状态原地压暗，
  // 然后才等广告数据——2026-11-10 修：原来顺序反着，点了按钮先没动静，loading 再从下面钻出来
  if (reset) { loadSeq = listLoadingStart(); state.page = 1; renderListLoader(); }
  // 第 1 页要给推荐卡留格：广告数据必须先到手，pageSize 才能算准。
  // 之前 route() 比 loadAds() 先跑，listPromoAd() 读到的是空 ADS，
  // 有推荐时第 1 页仍按满页拉，推荐卡插进来就多出一条尾巴（16+1=17）。
  if (reset && isPlainListView() && !adsReady) await ensureAds();
  const params = new URLSearchParams({
    sort: state.sort, type: state.type, category: state.category,
    page: state.page, pageSize: pageSizeOf()
  });
  if (state.q) params.set('q', state.q);
  if (state.scene !== '全部') params.set('scene', state.scene);
  if (state.openSource === '开源') params.set('os', 'open');
  else if (state.openSource === '闭源') params.set('os', 'closed');
  const rangeParam = RANGE_PARAM[state.range];
  if (rangeParam) params.set('range', rangeParam);
  // 带上本机标识：未登录时后端靠它把「这次搜索」记到具体一个人头上（行为流水），
  // 登录用户后端优先按账号认人，这个参数会被忽略。不影响列表内容，也不参与服务端缓存。
  params.set('vid', visitorId());

  try {
    // 收藏/点赞已收编成独立页面 /favs、/likes（2026-11-12），首页列表只管筛选与搜索
    const data = await (await fetch('/api/works?' + params)).json();

    // 首屏第一张卡片是 LCP 主要候选：给它 fetchpriority=high 且不 lazy，
    // 其余卡片继续懒加载（首屏之外的一张都别抢带宽）
    const html = data.items.map((w, i) => state.view === 'list'
      ? listHtml(w)
      : cardHtml(w, { eager: reset && i === 0 })).join('');
    gallery.classList.toggle('list-mode', state.view === 'list');
    const ghBefore = Math.round(gallery.getBoundingClientRect().height);
    if (reset) gallery.innerHTML = ''; // 数据到手再替换，旧内容保留期间页面高度稳定
    gallery.insertAdjacentHTML('beforeend', html);
    bindCards(gallery);
    if (reset) easeGalleryShrink(ghBefore);   // 结果比原来矮时把「缩上来」变成缓动（与随便逛逛同一口径）

    const emptyBox = $('empty');
    emptyBox.classList.remove('wander-empty');
    emptyBox.querySelectorAll('.wander-empty-btns, .wander-empty-sub, .wander-empty-reset, .findbot-inline-btn').forEach(n => n.remove());
    const emptyP = emptyBox.querySelector('p');
    // 搜索 0 结果：字面命中的死胡同，这里接一句「让找找用一句话找」——
    // 用户往往只是说法和作者的用词不一样（搜「录音」而作品写的是「语音转文字」）
    const noHitSearch = !!state.q && !gallery.children.length;
    if (emptyP) {
      emptyP.className = '';
      emptyP.textContent = noHitSearch ? '字面对不上，可能只是说法不一样' : '没有找到作品，换个关键词或分类试试？';
    }
    if (noHitSearch) {
      const askBtn = document.createElement('button');
      askBtn.type = 'button';
      askBtn.className = 'findbot-inline-btn';
      askBtn.textContent = '让「找找」用一句话帮我找';
      askBtn.onclick = () => { openFindBot(state.q); fbAsk(state.q); };
      emptyBox.appendChild(askBtn);
    }
    emptyBox.style.display = gallery.children.length ? 'none' : 'block';
    $('workCount').textContent = `共 ${data.total} 件`;
    // 场景和分类会叠加（场景=过日子 + 分类=生活助手），标题把两层都说清楚，别让人以为筛选没生效
    const catLabel = state.category === '全部' ? '全部作品' : state.category;
    $('listTitle').textContent = state.q
      ? `搜索「${state.q}」`
      : (state.scene === '全部' ? catLabel : `${sceneNameOf(state.scene)} · ${catLabel}`);
    state.hasMore = !!data.hasMore;
    $('loadMore').style.display = state.hasMore ? 'inline-block' : 'none';
    if (reset) mountListPromo();   // 只在第一页插第一格宣传，加载更多不重复插
  } catch {
    // 只剩「点灯」动画说明是首次加载就失败：清掉占位、给出空态，别让灯一直亮着转
    if ([...gallery.children].every(el => el.classList.contains('dm-load'))) gallery.innerHTML = '';
    $('empty').style.display = gallery.children.length ? 'none' : 'block';
    if (!$('workCount').textContent.trim() || $('workCount').textContent === '加载中…') $('workCount').textContent = '';
    showToast('加载失败，请检查网络或服务状态', undefined, 'err');
  } finally {
    if (reset) listLoadingEnd(loadSeq);   // 成功失败都收工，别让列表一直压着暗
  }
}

// ---------- 筛选栏（与微信小程序橱窗同款） ----------
// 一行文字 tab，点哪个就在栏下方展开共享的胶囊面板：点选项即生效并收起、再点同一个 tab 收起、
// 点面板外任意位置收起（照搬小程序 pages/index 的交互，桌面/手机同一套）。
// 发布时间筛选：中文标签 ↔ 接口参数（服务端按 createdAt 卡时间）
const RANGE_OPTS = ['全部', '近3天', '近7天', '近30天'];
const RANGE_PARAM = { '近3天': '3d', '近7天': '7d', '近30天': '30d' };
// 面板/按钮上的文案跟小程序一致：「全部」在时间维度读作「全部时间」
const RANGE_LABEL = { '全部': '全部时间', '近3天': '近 3 天', '近7天': '近 7 天', '近30天': '近 30 天' };
// 排序文案：tab 上短（随便逛逛/最新/最热），面板里跟小程序一致（随便逛逛/最新发布/最多点赞）
const SORT_OPTS = [
  { value: 'wander', label: '随便逛逛' },
  { value: 'latest', label: '最新发布' },
  { value: 'hot', label: '最多点赞' }
];

function closeFilterBars() {
  document.querySelectorAll('.fbar-wrap.open').forEach(w => {
    w.classList.remove('open');
    const p = w.querySelector('.fbar-panel');
    if (p) p.hidden = true;
  });
}

// 通用筛选栏（首页和榜单共用）：
//   wrap   —— .fbar-wrap 容器（.fbar 与 .fbar-panel 由这里整块重绘）
//   conf   —— [{ kind, text(), active(), current(), options(), apply(v) }]
//   onPick —— 任一选项变更后回调（首页重载作品列表 / 榜单重载榜单列表）
// 每次调用都换新 DOM，事件不会重复绑定。
function mountFilterBar(wrap, conf, onPick) {
  if (!wrap) return;
  let openKind = null;
  // 复用 index.html 里已有的 .fbar / .fbar-panel 节点（不要整块重绘容器，否则节点 id 会被冲掉）
  let bar = wrap.querySelector('.fbar');
  let panel = wrap.querySelector('.fbar-panel');
  if (!bar) { bar = document.createElement('div'); bar.className = 'fbar'; wrap.appendChild(bar); }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'fbar-panel';
    panel.hidden = true;
    panel.innerHTML = '<div class="fbar-chips"></div>';
    wrap.appendChild(panel);
  }
  let chips = panel.querySelector('.fbar-chips');
  if (!chips) { chips = document.createElement('div'); chips.className = 'fbar-chips'; panel.appendChild(chips); }
  // 重绘即收起：换筛选条件后列表已经变了，面板不该继续挂在那儿
  panel.hidden = true;
  wrap.classList.remove('open');
  const paintBar = () => {
    bar.innerHTML = conf.map(c => `
      <button type="button" class="fbar-item${c.active() ? ' is-on' : ''}${openKind === c.kind ? ' is-open' : ''}" data-kind="${c.kind}">
        <span class="fbar-text">${escapeHtml(c.text())}</span><span class="fbar-caret">▾</span>
      </button>`).join('');
  };
  const close = () => {
    openKind = null;
    wrap.classList.remove('open');
    panel.hidden = true;
    paintBar();
  };
  const open = kind => {
    const c = conf.find(x => x.kind === kind);
    if (!c) return;
    openKind = kind;
    const cur = String(c.current());
    chips.innerHTML = c.options().map(o => `
      <button type="button" class="fbar-chip${String(o.value) === cur ? ' is-on' : ''}" data-v="${escapeHtml(String(o.value))}">${escapeHtml(o.label)}</button>`).join('');
    panel.hidden = false;
    wrap.classList.add('open');
    paintBar();
  };
  // 用 onclick 赋值而不是 addEventListener：这个函数每次筛选都会重跑，
  // 节点是复用的，addEventListener 会越绑越多，点一下等于点好几下
  bar.onclick = e => {
    const item = e.target.closest('.fbar-item');
    if (!item) return;
    e.stopPropagation();
    const kind = item.dataset.kind;
    // 以面板的真实显隐为准（点外部收起走的是 DOM 层的 closeFilterBars，不会重置 openKind）：
    // 面板没开 → 直接开；开着且点的是同一个 tab → 收起；开着但点的是别的 tab → 直接切换
    if (!panel.hidden && openKind === kind) close();
    else { openKind = null; open(kind); }
  };
  chips.onclick = e => {
    const chip = e.target.closest('.fbar-chip');
    if (!chip) return;
    e.stopPropagation();
    const c = conf.find(x => x.kind === openKind);
    const v = chip.dataset.v;
    close();
    if (!c || String(c.current()) === v) return;   // 点已选项＝没变化，不重载列表
    c.apply(v);
    onPick();
  };
  // 面板内部点击不冒泡到 document，否则点一下面板就收起
  panel.onclick = e => e.stopPropagation();
  paintBar();
}

// 分端开关：≤640px 视为 H5 移动端（与 style.css 断点一致）。
// H5 用小程序橱窗同款 tab 栏，PC 保持原来的四个下拉胶囊，两边互不影响。
function isH5View() { return window.matchMedia('(max-width: 640px)').matches; }

// ---------- PC 端筛选：形态 / 分类 / 开源 / 时间 四个下拉胶囊（原有实现，PC 观感不变） ----------
// 筛选区：形态 / 分类 / 开源 / 时间 四个下拉胶囊（参考「分类 ▾」式紧凑布局）
function closeAllDD() {
  document.querySelectorAll('.dd-filter.open').forEach(x => x.classList.remove('open'));
}
function renderFiltersPC() {
  const row = $('filterRow');
  if (!row) return;
  // 形态下拉按大家习惯的顺序（后台配置顺序，与投稿表单勾选一致），不按数量排序
  // 只列出有作品的形态：0 件的形态点进去是空列表，纯属噪音；
  // 已选中的形态即使为 0 也保留，否则刷新后下拉里会「找不到自己选的那项」
  // 计数还没拉回来时（totalWorks=0）先全量展示，避免下拉闪成只剩「全部」
  const typeOpts = totalWorks > 0
    ? TYPES.filter(t => t === '全部' || (typeCounts[t] || 0) > 0 || t === state.type)
    : TYPES;
  // 分类下拉同样只列有作品的项：新建的分类在作品有作品上线前不进筛选条，避免一次性名字把下拉塞满
  const catOpts = totalWorks > 0
    ? CATEGORIES.filter(c => c === '全部' || (catCounts[c] || 0) > 0 || c === state.category)
    : CATEGORIES;
  // 场景排在最前：逛的人先想「我现在要干嘛」（上班/学习/过日子/做内容…），
  // 再想「要网页还是 App」。形态是创作者的口径，退到第二位。
  // 没有配置或一条作品都没归进场景时整项不渲染，不留一个只有「全部场景」的空下拉。
  const sceneOpts = ['全部'].concat(SCENES.map(s => s.name));
  const conf = [
    ...(SCENES.length ? [{
      kind: 'scene', icon: 'sparkle', label: '场景',
      value: state.scene === '全部' ? '全部场景' : sceneNameOf(state.scene),
      active: state.scene !== '全部',
      opts: sceneOpts
    }] : []),
    {
      kind: 'type', icon: 'shapes', label: '形态',
      value: state.type === '全部' ? '全部形态' : `${TYPE_ICONS[state.type] || ''} ${state.type}`,
      active: state.type !== '全部',
      opts: typeOpts
    },
    {
      kind: 'category', icon: 'folder', label: '分类',
      value: state.category, active: state.category !== '全部',
      opts: catOpts
    },
    {
      kind: 'os', icon: 'lock-open', label: '开源',
      value: state.openSource, active: state.openSource !== '全部',
      opts: ['全部', '开源', '闭源']
    },
    {
      kind: 'range', icon: 'clock', label: '时间',
      value: state.range, active: state.range !== '全部',
      opts: RANGE_OPTS
    }
  ];
  row.innerHTML = conf.map(c => {
    const cur = c.kind === 'type' ? state.type
      : c.kind === 'range' ? state.range
      : c.kind === 'os' ? state.openSource
      : c.kind === 'scene' ? (state.scene === '全部' ? '全部' : sceneNameOf(state.scene))
      : state.category;
    // 选中值带 SVG 图标时走 valueHtml（含 HTML），其余仍是纯文本 value
    const valHtml = c.kind === 'type' && state.type !== '全部' && TYPE_SVG[state.type]
      ? `${typeIcoHtml(state.type)} ${escapeHtml(state.type)}` : null;
    return `
    <div class="dd-filter" data-kind="${c.kind}">
      <button type="button" class="dd-btn${c.active ? ' has-value' : ''}">
        <span class="dd-ico"><span class="ico">${ic(c.icon)}</span></span><span class="dd-label">${c.label}</span>
        <b class="dd-value">${valHtml || escapeHtml(c.value)}</b><span class="dd-caret">▾</span>
      </button>
      <div class="dd-panel">
        ${c.opts.map(o => {
          let n;
          if (c.kind === 'range') n = null;   // 时间档没有可用的现成计数，不显示数字
          else if (o === '全部') n = totalWorks;
          else if (c.kind === 'type') n = typeCounts[o] || 0;
          else if (c.kind === 'os') n = o === '开源' ? (osCounts.open || 0) : (osCounts.closed || 0);
          else if (c.kind === 'scene') n = (SCENES.find(s => s.name === o) || {}).count || 0;
          else n = catCounts[o] || 0;
          const icon = c.kind === 'type' && o !== '全部' ? typeIcoHtml(o) + ' ' : '';
          return `
          <button type="button" class="dd-opt${o === cur ? ' active' : ''}" data-v="${escapeHtml(o)}">
            <span class="dd-opt-label">${icon}${escapeHtml(o)}</span>
            ${n == null ? '' : `<span class="dd-count">${n}</span>`}
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  row.querySelectorAll('.dd-filter').forEach(dd => {
    const kind = dd.dataset.kind;
    dd.querySelector('.dd-btn').addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = dd.classList.contains('open');
      closeAllDD();
      if (!wasOpen) dd.classList.add('open');
    });
    dd.querySelectorAll('.dd-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        if (kind === 'type') state.type = opt.dataset.v;
        else if (kind === 'range') state.range = opt.dataset.v;
        else if (kind === 'os') state.openSource = opt.dataset.v;
        else if (kind === 'scene') {
          // 下拉里显示的是场景名，传参要的是 key：按名字反查，查不到就回全部
          const hit = SCENES.find(s => s.name === opt.dataset.v);
          state.scene = hit ? hit.key : '全部';
          wanderBreakoutLatest();   // 随便逛逛不认识筛选，点场景就切回最新（与 H5 同一口径）
        }
        else { state.category = opt.dataset.v; }
        closeAllDD();
        renderFilters();
        loadWorks();
      });
    });
  });
}

// ---------- H5 移动端筛选：小程序橱窗同款 tab 栏 ----------
function renderFiltersH5() {
  const wrap = $('filterWrap');
  if (!wrap) return;
  // 形态按大家习惯的顺序（后台配置顺序，与投稿表单勾选一致），不按数量排序
  // 只列出有作品的形态：0 件的形态点进去是空列表，纯属噪音；
  // 已选中的形态即使为 0 也保留，否则刷新后下拉里会「找不到自己选的那项」
  // 计数还没拉回来时（totalWorks=0）先全量展示，避免下拉闪成只剩「全部」
  const typeOpts = totalWorks > 0
    ? TYPES.filter(t => t === '全部' || (typeCounts[t] || 0) > 0 || t === state.type)
    : TYPES;
  // 分类同样只列有作品的项：新建的分类在作品上线前不进筛选条，避免一次性名字把下拉塞满
  const catOpts = totalWorks > 0
    ? CATEGORIES.filter(c => c === '全部' || (catCounts[c] || 0) > 0 || c === state.category)
    : CATEGORIES;
  const asOpts = list => list.map(v => ({ value: v, label: v }));
  const conf = [
    // 场景排第一：手机屏幕上「我现在想干嘛」比「什么形态」更像逛的人会先点的那个
    // （没有配置/没作品时整项不渲染，别留一个只有「全部场景」的空面板）
    ...(SCENES.length ? [{
      kind: 'scene', current: () => state.scene, active: () => state.scene !== '全部',
      // 手机上这一格只有 ~54px：选中后改成显示场景名（「上班干活」四个字）必被截成「上班…」，
      // 所以这里固定写「场景」，靠紫色高亮表示已生效；当前是哪个场景看下面的列表标题（「过日子 · 全部作品」）。
      text: () => '场景',
      options: () => [{ value: '全部', label: '全部场景' }]
        .concat(SCENES.map(s => ({ value: s.key, label: s.name }))),
      apply: v => { state.scene = v; wanderBreakoutLatest(); }
    }] : []),
    {
      kind: 'type', current: () => state.type, active: () => state.type !== '全部',
      text: () => state.type === '全部' ? '形态' : state.type,
      options: () => asOpts(typeOpts), apply: v => { state.type = v; wanderBreakoutLatest(); }
    },
    {
      kind: 'category', current: () => state.category, active: () => state.category !== '全部',
      text: () => state.category === '全部' ? '分类' : state.category,
      options: () => asOpts(catOpts),
      apply: v => { state.category = v; wanderBreakoutLatest(); }
    },
    {
      kind: 'os', current: () => state.openSource, active: () => state.openSource !== '全部',
      text: () => state.openSource === '全部' ? '开源' : state.openSource,
      options: () => asOpts(['全部', '开源', '闭源']), apply: v => { state.openSource = v; wanderBreakoutLatest(); }
    },
    {
      kind: 'range', current: () => state.range, active: () => state.range !== '全部',
      text: () => state.range === '全部' ? '时间' : RANGE_LABEL[state.range],
      options: () => RANGE_OPTS.map(v => ({ value: v, label: RANGE_LABEL[v] })),
      apply: v => { state.range = v; wanderBreakoutLatest(); }
    },
    {
      kind: 'sort', current: () => state.sort, active: () => false,
      text: () => state.sort === 'hot' ? '最热' : state.sort === 'wander' ? '随便逛逛' : '最新',
      options: () => SORT_OPTS,
      // H5 的排序 tab 也是「用户亲手点的」：同样记在本机，跟 PC 的按钮共用同一条记忆
      apply: v => { state.sort = v; saveSort(v); }
    }
  ];
  mountFilterBar(wrap, conf, () => { renderFilters(); loadWorks(); });
}
// 分端入口：H5 走 tab 栏，PC 走下拉胶囊（共用同一个 state，切屏宽后状态一致）
function renderFilters() {
  if (isH5View()) renderFiltersH5(); else renderFiltersPC();
}
// 点面板外任意位置收起筛选面板
document.addEventListener('click', closeFilterBars);

function renderCategorySelect() {
  if (renderCatPickerFn) renderCatPickerFn(); // 分类已改为表单内胶囊多选，这里只负责同步刷新
}

// ---------- 路由 ----------
const SITE_NAME = '造梦橱窗';
const DEFAULT_TITLE = `${SITE_NAME} - 独立开发者作品收录榜 · 免费投稿网站/小程序/软件`;

function setTitle(t) { document.title = t ? `${t} - ${SITE_NAME}` : DEFAULT_TITLE; }

// 是否处于「完整页面」形态（/w/:id?full=1，用于分享与搜索引擎收录）
function isFullView() {
  return new URLSearchParams(location.search).get('full') === '1';
}

// 服务端预渲染的内容块：只有「整页 SSR」那种（挂在 <main> 上）才需要清掉。
// 落在 #homeView 内的 SSR 区块是首页常驻的「最新收录」栏目，必须保留——
// 真人与爬虫共用同一份 HTML，切到别的视图时它会随 homeView 一起隐藏。
function removeSeoBlock() {
  // 整页 SSR 的区块挂在主内容区直属；#homeView 内的那份是常驻栏目，不能删
  const el = document.querySelector('main > #seoContent');
  if (el) el.remove();
}

function navigate(path) {
  history.pushState({}, '', path);
  route();
}

// 「我的收藏 / 我的点赞」已收编成独立页面 /favs、/likes（2026-11-12），
// 原先从其他页跳首页再滚到列表区的 scrollWorksHeadSoon 不再有使用场景，函数已删。

function closeAllViews() {
  ['homeView', 'rankView', 'wishView', 'miniView', 'guideView', 'howtoView', 'authorView', 'promoteView', 'discoverView', 'meView', 'settingsView', 'favView', 'likeView'].forEach(id => { $(id).style.display = 'none'; });
  hideModal(detailModal);
  hideModal(statsModal);   // 灯火/数据面板是弹层：路由切走（比如点了榜单行去作者主页）必须一起收，别盖在新页面上
  closeQrZoom();   // 详情被关掉时二维码放大层一起收，别留一张盖住全屏的图
  closeImgFull();  // 全屏看图层同理：详情关了它必须跟着收
}

// 导航高亮：榜单页亮「榜单」，造梦酒馆页亮「造梦酒馆」，外宣指南页亮「外宣指南」，
// 收藏/点赞独立页亮头像下拉里对应的那条，其余按当前排序亮对应按钮
function updateNavActive() {
  const onRank = location.pathname === '/rank';
  const onWish = location.pathname === '/bar';
  const onGuide = location.pathname === '/guide';
  // PC 顶导「发现」入口暂缓：高亮逻辑先留着（querySelector 找不到按钮就是空操作），按钮加回来即生效
  const onDiscover = location.pathname === '/discover';
  const onMini = location.pathname === '/mini';
  const onColumn = location.pathname === '/column' || location.pathname.startsWith('/column/');
  // 移动端底部 Tab 高亮：橱窗=首页/作品详情/作者页，其余按路径精确匹配
  const p = location.pathname;
  const tabKey = p === '/discover' ? 'discover'
    : p === '/me' ? 'me'
    : onRank ? 'rank'
    : (p === '/' || p.startsWith('/w/') || p.startsWith('/u/')) ? 'home'
    : (onWish || onGuide || onMini || onColumn) ? ''   // 酒馆/指南/小程序专栏/精选专栏不占 Tab，全部不亮
    : 'home';
  document.querySelectorAll('.tab-item').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabKey));
  const rankLink = document.querySelector('.nav-btn[href="/rank"]');
  if (rankLink) rankLink.classList.toggle('active', onRank);
  const wishLink = document.querySelector('.nav-btn[href="/bar"]');
  if (wishLink) wishLink.classList.toggle('active', onWish);
  const miniLink = document.querySelector('.nav-btn[href="/mini"]');
  if (miniLink) miniLink.classList.toggle('active', onMini);
  const guideLink = document.querySelector('.nav-btn[href="/guide"]');
  if (guideLink) guideLink.classList.toggle('active', onGuide);
  const discoverLink = document.querySelector('.nav-btn[href="/discover"]');
  if (discoverLink) discoverLink.classList.toggle('active', onDiscover);
  const columnLink = document.querySelector('.nav-btn[href="/column"]');
  if (columnLink) columnLink.classList.toggle('active', onColumn);
  // PC 排序按钮的选中态跟着 state.sort（H5 上这个按钮不显示，同步了也看不到）
  document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
    b.classList.toggle('active', !onRank && !onWish && !onGuide && b.dataset.sort === state.sort));
  const favDrop = $('favDrop');
  if (favDrop) favDrop.classList.toggle('active', location.pathname === '/favs');
  const likeDrop = $('likeDrop');
  if (likeDrop) likeDrop.classList.toggle('active', location.pathname === '/likes');
}

// ---------- 发现页（移动端 Tab）：精选 + 平台专栏 ----------
// Android/iOS 顺序按手机机型排（UA 判断）；各专栏取热度前 6，空的自动隐藏，不占位
// ---------- 发现页（对齐小程序版式）：顶部胶囊切专栏，栏头 + 说明 + 数据条 + 双列卡片 ----------
// 顺序按用户要求：精选 → iOS → 安卓 → 小程序（2026-11-05）；Web 专区随后加入（2026-11-06）
const DISC_BASE_COLS = [
  { key: '精选', label: '精选', eyebrow: 'WEEKLY FEATURED', title: '本周精选', btn: '查看详情', statUnit: '件精选作品',
    desc: '按近 7 天访客、点赞、收藏的热度挑出来的作品，每天换一批顺序，总有一款合胃口。' },
  { key: 'iOS', label: 'iOS', eyebrow: 'iOS COLUMN', title: 'iOS 专栏', btn: '立即体验', statUnit: '个 iOS 作品',
    desc: 'iPhone 上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。' },
  { key: 'Android', label: '安卓', eyebrow: 'ANDROID COLUMN', title: '安卓专栏', btn: '立即体验', statUnit: '个安卓作品',
    desc: '安卓手机上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。' },
  { key: '小程序', label: '小程序', eyebrow: 'MINI PROGRAM COLUMN', title: '小程序专栏', btn: '扫码体验', statUnit: '个小程序', statScan: '个能扫码体验',
    desc: '小程序在浏览器里点不开，所以这里挑出来的作品都备了小程序码——点卡片上的「扫码体验」，长按就能识别，也能一键存到相册。' },
  { key: 'Web', label: 'Web', eyebrow: 'WEB COLUMN', title: 'Web 专区', btn: '立即体验', statUnit: '个 Web 作品',
    desc: '浏览器里打开就能用的网页作品，电脑手机都通吃。点「立即体验」直达详情页，里面有对应的网址入口和完整介绍。' },
  // 游戏专栏起：分类维度专栏（其余都是形态维度）——按「娱乐游戏」等分类聚合，跨平台。
  // 取数走 /api/works?category=…（loadDiscover 里有专属分支，DISC_CAT_COLS 登记在案），
  // 不与平台专栏互斥，一件作品可以同时出现在平台专栏和分类专栏。
  { key: '游戏', label: '游戏', eyebrow: 'GAMES COLUMN', title: '游戏专栏', btn: '立即体验', statUnit: '个游戏作品',
    desc: '能直接开玩的小游戏都在这儿：休闲闯关、双人对战、解谜互动，手机电脑都能玩。点「立即体验」直达详情页，联机对战记得看说明里的玩法。' },
  { key: '效率工具', label: '效率', eyebrow: 'PRODUCTIVITY COLUMN', title: '效率工具专栏', btn: '立即体验', statUnit: '个效率工具',
    desc: '提升效率的小工具都在这儿：记一下、算一算、理一理，电脑手机都能用。点「立即体验」直达详情页，里面有对应的入口和完整介绍。' },
  { key: '学习教育', label: '学习', eyebrow: 'LEARNING COLUMN', title: '学习教育专栏', btn: '立即体验', statUnit: '个学习作品',
    desc: '能学到东西的小作品：背单词、练题、查资料，碎片时间刚好用。点「立即体验」直达详情页，里面有对应的入口和完整介绍。' },
  { key: '开发工具', label: '开发', eyebrow: 'DEV TOOLS COLUMN', title: '开发工具专栏', btn: '立即体验', statUnit: '个开发工具',
    desc: '给开发者的小工具：格式转换、正则调试、接口测试，写代码路上顺手就用上。点「立即体验」直达详情页，里面有对应的入口和完整介绍。' },
  { key: '悠闲放松', label: '放松', eyebrow: 'RELAX COLUMN', title: '悠闲放松专栏', btn: '立即体验', statUnit: '个放松作品',
    desc: '白噪音、呼吸练习、电子宠物、减压小游戏……没有 KPI，纯粹让你歇口气，点开即用。适合工作间隙两分钟或睡前慢慢翻。' }
  // 「AI 应用」暂不上：数据里没有这个分类、作品也没有 tags 字段，筛不出来；等给作品打好标再开。
];
// 「其他形态」专栏（macOS / Windows / Linux / 浏览器插件 / 机器人 / API + 后台自定义形态）：
// 从 /api/type-meta 动态补齐，只补有作品的（count=0 的点进去是空列表，纯属噪音——与 PC 首页筛选同口径）。
// 会话内缓存一次；形态元数据拉不到就维持上面 5 个固定专栏，不新增。
// 分类维度专栏的 key 登记表：这些胶囊按分类取数（跨形态聚合），其余胶囊按形态 type 筛。
// 「游戏」的 key 与分类名不同（分类叫「娱乐游戏」），特判翻译；其余 key 即分类名。
const DISC_CAT_COLS = ['游戏', '效率工具', '学习教育', '开发工具', '悠闲放松'];
let discExtraCols = null;
async function discColsAll() {
  if (discExtraCols) return DISC_BASE_COLS.concat(discExtraCols);
  try {
    const meta = await (await fetch('/api/type-meta', { cache: 'no-store' })).json();
    const fixed = DISC_BASE_COLS.map(c => c.key);
    const DESC = {
      'macOS': 'Mac 上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。',
      'Windows': 'Windows 上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。',
      'Linux': 'Linux 上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。',
      '浏览器插件': '装进浏览器就能用的插件作品，点「立即体验」直达详情页，里面有对应的安装入口和完整介绍。',
      '机器人': '能直接对话聊天的机器人作品，点「立即体验」直达详情页，里面有对应的体验入口和完整介绍。',
      'API': '给开发者调用的 API 服务，点「立即体验」直达详情页，里面有对应的文档入口和完整介绍。'
    };
    discExtraCols = (Array.isArray(meta) ? meta : [])
      .filter(t => t && t.name && fixed.indexOf(t.name) === -1 && (t.count || 0) > 0)
      .map(t => ({
        key: t.name, label: t.name, eyebrow: 'TYPE COLUMN', title: t.name + ' 专栏', btn: '立即体验', statUnit: '个' + t.name + '作品',
        desc: DESC[t.name] || ('「' + t.name + '」形态的作品都在这里，点「立即体验」直达详情页，里面有对应的入口和完整介绍。')
      }));
  } catch { discExtraCols = []; }
  return DISC_BASE_COLS.concat(discExtraCols);
}
let discTab = '';      // 当前选中的胶囊；空 = 未初始化（进页面时按 UA 选默认）
let discCache = {};    // key -> { items, total, scan }：会话内缓存，来回切胶囊不重复拉接口
let discLoaded = '';   // 上一次渲染的专栏，前进/后退回到同页不重渲染（滚动位置不丢）
function defaultDiscKey() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  return '小程序';
}
function discCardHtml(w, col) {
  const scan = !!(w.qrcode || w.qrSrc);
  const [ctName, ctIntro] = cardTitleLines(w);
  return `
    <div class="card disc-card" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <div class="card-img-wrap">
        <img class="card-img" src="${imgUrl(w.thumb, 400)}" srcset="${imgSet(w.thumb)}"
             sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 260px"
             alt="${escapeHtml(w.title)}" loading="lazy" />
        ${col.key === '小程序' && scan ? '<span class="disc-scan-badge">可扫码</span>' : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(ctName)}</div>
        ${ctIntro ? `<div class="disc-intro">${escapeHtml(ctIntro)}</div>` : ''}
        <div class="card-meta disc-meta">
          <span class="card-author"><span class="author-name">@${escapeHtml(anamePlain(w))}</span></span>
          <span class="disc-favs"><span class="ico s-ico">${ic('fav')}</span>${w.favs || 0}</span>
        </div>
        <button type="button" class="disc-btn" data-disc-open="${w.id}" data-disc-qr="${scan ? 1 : 0}">${col.btn}</button>
      </div>
    </div>`;
}
function renderDiscPanel(col, data) {
  const items = data.items || [];
  const panel = $('discPanel');
  if (!items.length) {
    panel.innerHTML = '<div class="comment-empty">这个专栏还在等第一批作品，快来提交～</div>';
    return;
  }
  panel.innerHTML = `
    <section class="disc-col">
      <span class="disc-eyebrow">${col.eyebrow}</span>
      <h2 class="disc-title">${escapeHtml(col.title)}</h2>
      <p class="disc-desc">${escapeHtml(col.desc)}</p>
      <div class="disc-stats">
        <div class="disc-stat"><b>${data.total}</b><span>${col.statUnit}</span></div>
        ${col.statScan ? `<div class="disc-stat-sep"></div><div class="disc-stat"><b>${data.scan}</b><span>${col.statScan}</span></div>` : ''}
      </div>
      <div class="disc-grid">${items.map(w => discCardHtml(w, col)).join('')}</div>
    </section>`;
  bindCards(panel);
  panel.querySelectorAll('[data-disc-open]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.discOpen;
      if (btn.dataset.discQr !== '1') { openWork(id); return; }
      // 有码：直接弹大码（和详情页「放大」同款），记一次扫码意图
      const w = items.find(x => String(x.id) === String(id));
      if (!w) { openWork(id); return; }
      trackAction(id, 'scan_intent', 'discover');
      openQrZoom(w.qrSrc || w.qrcode, col.key === '小程序' ? '用微信扫一扫打开小程序，长按可保存' : '手机扫码打开作品');
    });
  });
}
async function loadDiscover() {
  const chips = $('discChips');
  if (!discTab) discTab = defaultDiscKey();
  const colsAll = await discColsAll();
  const drawChips = () => {
    chips.innerHTML = colsAll.map(c =>
      `<button type="button" class="disc-chip${c.key === discTab ? ' active' : ''}" data-disc-tab="${escapeHtml(c.key)}" role="tab" aria-selected="${c.key === discTab}">${escapeHtml(c.label)}</button>`).join('');
  };
  drawChips();
  chips.querySelectorAll('[data-disc-tab]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.discTab === discTab) return;
      discTab = b.dataset.discTab;
      drawChips();
      loadDiscover();
    };
  });
  const col = colsAll.find(c => c.key === discTab);
  if (discLoaded === col.key && discCache[col.key]) return;
  discLoaded = col.key;
  $('discPanel').innerHTML = '<div class="comment-empty">加载中…</div>';
  try {
    if (!discCache[col.key]) {
      if (col.key === '精选') {
        const d = await (await fetch('/api/featured', { cache: 'no-store' })).json();
        const items = Array.isArray(d.list) ? d.list : [];
        discCache[col.key] = { items, total: items.length };
      } else if (DISC_CAT_COLS.indexOf(col.key) !== -1) {
        // 分类专栏按分类取数，跨形态聚合；「游戏」→ 娱乐游戏，其余 key 即分类名
        const cat = col.key === '游戏' ? '娱乐游戏' : col.key;
        const d = await (await fetch(`/api/works?sort=hot&category=${encodeURIComponent(cat)}&page=1&pageSize=100`, { cache: 'no-store' })).json();
        const items = Array.isArray(d.items) ? d.items : [];
        discCache[col.key] = { items, total: d.total || items.length };
      } else {
        const d = await (await fetch(`/api/works?sort=hot&type=${encodeURIComponent(col.key)}&page=1&pageSize=100`, { cache: 'no-store' })).json();
        const items = Array.isArray(d.items) ? d.items : [];
        discCache[col.key] = { items, total: d.total || items.length, scan: items.filter(w => w.qrcode || w.qrSrc).length };
      }
    }
    renderDiscPanel(col, discCache[col.key]);
  } catch {
    $('discPanel').innerHTML = '<div class="comment-empty">加载失败，稍后再来，或回橱窗逛逛～</div>';
  }
}

// ---------- 我的页（移动端 Tab）：深色版式——用户卡 + 数据条 + 四宫格 + 签到横幅 + 快捷入口 ----------
// 手机端把右下角三颗浮标收进「我的」页快捷宫格：这里只做入口转发，
// PWA 安装 / 小程序弹窗 / 反馈红点等逻辑仍全部挂在原按钮上，PC 端浮标照常显示。
const ME_FAB_TILES = [
  ['installFab', 'mobile', '装到桌面'],
  ['miniFab', 'mini', '小程序'],
  ['feedbackBtn', 'mail', '反馈'],
];
function meFabTilesHtml() {
  const hasNew = !!document.querySelector('#feedbackBtn.has-new');
  return ME_FAB_TILES.map(([id, icon, label]) =>
    `<button type="button" class="me-quick-card me-quick-fab${id === 'feedbackBtn' && hasNew ? ' has-new' : ''}" data-fab="${id}"><span class="me-quick-ico">${ic(icon, 20)}</span>${label}</button>`
  ).join('');
}
function bindMeFabTiles(root) {
  root.querySelectorAll('[data-fab]').forEach(b => {
    b.onclick = () => { const t = $(b.dataset.fab); if (t) t.click(); };
  });
}

// ---------- 账号设置页（/settings） ----------
// 原来塞在头像下拉的二级展开里，设置项以后只会变多，收成独立页面。
// 每行只做「入口」：点行打开各自的弹窗（昵称/密码/绑定/屏蔽），不在页内重复造表单。
function renderSettingsPage() {
  const body = $('settingsBody');
  if (!state.user) {
    body.innerHTML = `
      <div class="st-login">
        <p>登录后才能改昵称、密码、消息提示这些</p>
        <button type="button" class="btn-primary" id="settingsLoginBtn">先登录</button>
      </div>`;
    $('settingsLoginBtn').onclick = () => openAuth('login');
    return;
  }
  const u = state.user;
  const ghOn = !!(state.providers && state.providers.github);
  const gOn = !!(state.providers && state.providers.google);
  const nBlocked = (state.blocked || []).length + (state.blockedUsers || []).length;
  body.innerHTML = `
    <button type="button" class="st-row" id="stAva">
      <span class="st-ico">${ic('user', 18)}</span>
      <span class="st-main"><b>头像</b><i>用 GitHub 头像、传一张图，或者就用名字首字</i></span>
      <span class="st-val${u.avatar ? '' : ' st-dim'}">${u.avatar ? escapeHtml(u.avatarSrcLabel || '已设置') : '首字母'}</span>
      <span class="st-more">›</span>
    </button>
    <button type="button" class="st-row" id="stNick">
      <span class="st-ico">${ic('edit', 18)}</span>
      <span class="st-main"><b>${u.nickname ? '改昵称' : '设个昵称'}</b><i>别人看到的名字，不设就显示账号名</i></span>
      <span class="st-val${u.nickname ? '' : ' st-dim'}">${u.nickname ? escapeHtml(u.nickname) : '未设置'}</span>
      <span class="st-more">›</span>
    </button>
    <button type="button" class="st-row" id="stSlug">
      <span class="st-ico">${ic('link', 18)}</span>
      <span class="st-main"><b>个性地址</b><i>作者页链接换成好念的名字，印在名片、README 上也记得住</i></span>
      <span class="st-val${u.slug ? '' : ' st-dim'}">${u.slug ? '/u/' + escapeHtml(u.slug) : '未设置'}</span>
      <span class="st-more">›</span>
    </button>
    <button type="button" class="st-row" id="stPass">
      <span class="st-ico">${ic('key', 18)}</span>
      <span class="st-main"><b>账号与密码</b><i>登录名（别名）和密码都在这里改</i></span>
      <span class="st-more">›</span>
    </button>
    <button type="button" class="st-row" id="stMute" role="switch" aria-checked="${!noticeMuted()}" aria-label="系统消息提示开关">
      <span class="st-ico">${ic('bell', 18)}</span>
      <span class="st-main"><b>系统消息提示</b><i>关掉后消息仍会进铃铛，只是不再弹提示</i></span>
      <span class="ud-switch${noticeMuted() ? '' : ' is-on'}"><i></i></span>
    </button>
    ${ghOn ? `
    <button type="button" class="st-row" id="stGh">
      <span class="st-ico">${ic('github', 18)}</span>
      <span class="st-main"><b>GitHub 绑定</b><i>绑定后可以一键登录，不用再输密码</i></span>
      <span class="st-val${u.github ? '' : ' st-dim'}">${u.github ? '已绑定' : '未绑定'}</span>
      <span class="st-more">›</span>
    </button>` : ''}
    ${gOn ? `
    <button type="button" class="st-row" id="stG">
      <span class="st-ico">${ic('google', 18)}</span>
      <span class="st-main"><b>Google 绑定</b><i>绑定后可以一键登录，不用再输密码</i></span>
      <span class="st-val${u.google ? '' : ' st-dim'}">${u.google ? '已绑定' : '未绑定'}</span>
      <span class="st-more">›</span>
    </button>` : ''}
    <button type="button" class="st-row" id="stBlocked">
      <span class="st-ico">${ic('block', 18)}</span>
      <span class="st-main"><b>屏蔽管理</b><i>屏蔽的作品和用户都在这里恢复</i></span>
      ${nBlocked ? `<span class="st-val">${nBlocked} 项</span>` : ''}
      <span class="st-more">›</span>
    </button>`;
  $('stAva').onclick = openAvaModal;
  $('stNick').onclick = openNickModal;
  $('stSlug').onclick = openSlugModal;
  $('stPass').onclick = openPassModal;
  $('stMute').onclick = async () => { await toggleNoticeMute(); if (state.user) renderSettingsPage(); };
  const ghRow = $('stGh'); if (ghRow) ghRow.onclick = openGhModal;
  const gRow = $('stG'); if (gRow) gRow.onclick = openGModal;
  $('stBlocked').onclick = () => openBlockedList('works');
}

function renderMePage() {
  const card = $('meUserCard'), menu = $('meMenu');
  if (!state.user) {
    card.innerHTML = `
      <div class="me-hero me-hero-guest">
        <div class="me-hero-user">
          <span class="me-ava2 me-ava2-user">${ic('user')}</span>
          <div class="me-hero-main">
            <b>登录造梦橱窗</b>
            <span>一个账号，签到、收藏、投稿都跟着你走</span>
          </div>
        </div>
        <button type="button" class="me-login-big" id="meLogin">登录 / 注册</button>
      </div>
      <div class="me-perks">
        <button type="button" class="me-perk"><span class="me-perk-ico">${ic('coin', 20)}</span><b>签到领灯火</b><i>每天打卡攒资源</i></button>
        <button type="button" class="me-perk"><span class="me-perk-ico">${ic('fav', 20)}</span><b>收藏云同步</b><i>换设备也不会丢</i></button>
        <button type="button" class="me-perk"><span class="me-perk-ico">${ic('edit', 20)}</span><b>投稿免审核</b><i>登录后发布即上线</i></button>
        <button type="button" class="me-perk"><span class="me-perk-ico">${ic('bars', 20)}</span><b>作品数据板</b><i>访问/下载/扫码</i></button>
      </div>
      <div class="me-tiles">
        <button type="button" class="me-tile" id="meSubmit"><span class="me-tile-ico">${ic('edit', 20)}</span>提交作品<i class="draft-dot" data-draft-dot hidden></i></button>
        <a class="me-tile" href="/howto" data-nav><span class="me-tile-ico">${ic('mail', 20)}</span>投稿指南</a>
        <a class="me-tile me-tile-guide" href="/guide" data-nav><span class="me-tile-ico">${ic('megaphone', 20)}</span>外宣指南</a>
        <a class="me-tile" href="/bar" data-nav><span class="me-tile-ico">${ic('wish', 20)}</span>造梦酒馆</a>
      </div>
      <div class="me-quick me-quick-guest">${meFabTilesHtml()}</div>`;
    // 手机端头部已移掉，提交入口收进「我的」页（未登录也允许打开投稿表单，匿名需审核）
    $('meSubmit').onclick = () => $('openUpload').click();
    $('meLogin').onclick = () => openAuth('login');
    // 浮标收起后，游客版「我的」页也要能点装到桌面 / 小程序 / 反馈
    bindMeFabTiles(card);
    // 权益卡点了也是去登录
    card.querySelectorAll('.me-perk').forEach(p => { p.onclick = () => openAuth('login'); });
    menu.innerHTML = '';
    menu.style.display = 'none';
    return;
  }
  menu.style.display = '';
  menu.innerHTML = '';
  const ck = state.user.checkin || {};
  const ckDone = !!ck.done;
  const ar = state.user.arrive || {};   // 今日到访那 2 盏（自动到账，不用点）
  const pts = Number(state.user.points || 0);
  const unread = Number(state.user.unreadNotices || 0);
  const works = Number(state.user.worksCount || 0);
  const favs = (state.favs || []).length;
  const name = state.user.nickname || state.user.username;
  // 手机端不放「我的想法」「我的收藏」两个区块（用户要求去掉；PC 保留），
  // 收藏预览的请求也一并跳过，省一次全量拉取
  const onMobileMe = window.innerWidth <= 640;
  card.innerHTML = `
    <div class="me-hero">
      <div class="me-hero-user">
        ${avaHtml(name, state.user.avatar, 'me-ava2 me-ava2-user', false, state.user.username || name)}
        <div class="me-hero-main">
          <b>${escapeHtml(name)}</b>
          <span>@${escapeHtml(state.user.username || '')}</span>
        </div>
      </div>
      <div class="me-stats">
        <a class="me-stat" href="/u/${encodeURIComponent(state.user.slug || state.user.id || state.user.username)}" data-nav><b>${works}</b><span>我的作品</span></a>
        <i class="me-stat-sep"></i>
        <button type="button" class="me-stat" id="meStatFavs"><b>${favs}</b><span>我的收藏</span></button>
        <i class="me-stat-sep"></i>
        <button type="button" class="me-stat" id="mePoints" title="灯光明细：每笔从哪来、花到哪去"><b>${pts}</b><span>灯火 ›</span></button>
      </div>
    </div>
    <div class="me-tiles">
      <button type="button" class="me-tile" id="meSubmit"><span class="me-tile-ico">${ic('edit', 20)}</span>提交作品<i class="draft-dot" data-draft-dot hidden></i></button>
      <a class="me-tile" href="/u/${encodeURIComponent(state.user.slug || state.user.id || state.user.username)}" data-nav><span class="me-tile-ico">${ic('home', 20)}</span>我的主页</a>
      <button type="button" class="me-tile" id="meStats"><span class="me-tile-ico">${ic('bars', 20)}</span>作品数据</button>
      <button type="button" class="me-tile" id="meFav"><span class="me-tile-ico">${ic('fav', 20)}</span>我的收藏</button>
    </div>
    <div class="me-ck-card">
      <div class="me-ck-left">
        <b>每日签到激励</b>
        <span>${ck.streak ? `连续签到 ${ck.streak} 天` : '今天还没签到'}</span>
      </div>
      <span class="me-ck-lamp">${ic('lamp')}</span>
      <button type="button" class="me-ck-btn me-checkin${ckDone ? ' is-done' : ''}" id="meCheckin"${ckDone ? ' disabled' : ''}>${ckDone ? '今日已签 ✓' : `签到 +${ck.todayPoints || 5} 灯火`}</button>
      <p class="me-ck-tip">${ar.points ? `每天打开站点自动 +${ar.points} 盏${ar.done ? '（今天已到账）' : ''} · ` : ''}灯火可兑换推荐位曝光 · <button type="button" class="me-ck-adlink" id="meCkAd">小程序看广告 +${ckAdOnce(ck)} 盏 ›</button></p>
    </div>
    <div class="me-quick">
      <button type="button" class="me-quick-card" id="meNotices"><span class="me-quick-ico">${ic('bell', 20)}</span>站内消息${unread ? `<span class="me-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</button>
      <button type="button" class="me-quick-card" id="meStar" title="同步我名下所有开源作品的 GitHub star，按 1:1 换灯火"><span class="me-quick-ico">${ic('github', 20)}</span>更新<br />star 奖励</button>
      <button type="button" class="me-quick-card" id="meGift"><span class="me-quick-ico">${ic('gift', 20)}</span>兑换码<br />领灯火</button>
      <button type="button" class="me-quick-card" id="mePromo" title="用灯火给自己的作品换个推荐位"><span class="me-quick-ico">${ic('promo', 20)}</span>推荐<br />自己的作品</button>
      <a class="me-quick-card" href="/medals.html" title="看看攒了几枚、还差什么"><span class="me-quick-ico">${ic('medal', 20)}</span>我的勋章</a>
      <a class="me-quick-card" href="/bar" data-nav><span class="me-quick-ico">${ic('wish', 20)}</span>造梦酒馆</a>
      <a class="me-quick-card" href="/invite"><span class="me-quick-ico">${ic('share', 20)}</span>邀请收录</a>
      ${meFabTilesHtml()}
    </div>
    ${onMobileMe ? '' : `
    <div class="me-sec">
      <div class="me-sec-head"><h3>我的想法</h3></div>
      <a class="me-idea-card" href="/bar" data-nav>还没想过表达，去造梦酒馆看看大家在想什么 <i>›</i></a>
    </div>
    <div class="me-sec">
      <div class="me-sec-head"><h3>我的收藏</h3><span class="me-sec-count">${favs} 件</span></div>
      <div class="me-fav-list" id="meFavList"><div class="me-fav-empty">加载中…</div></div>
    </div>`}
    <div class="me-foot">
      <button type="button" class="me-foot-btn" id="meAbout">${ic('globe', 15)} 关于本站</button>
      <a class="me-foot-btn" href="/settings" data-nav>${ic('gear', 15)} 账号设置</a>
      <button type="button" class="me-foot-btn me-logout" id="meLogout">${ic('logout', 15)} 退出登录</button>
    </div>`;
  // 手机端头部已移掉，提交入口收进「我的」页（复用「＋ 提交作品」的完整打开逻辑：草稿恢复等）
  $('meSubmit').onclick = () => $('openUpload').click();
  paintDraftHint();   // 本页是重渲染出来的，角标要用内存里已知的份数同步补上（不额外发请求）
  // 收藏：独立页 /favs（toggleFavorites 里带未登录先登录的引导）
  const goFavs = () => toggleFavorites();
  $('meFav').onclick = goFavs;
  $('meStatFavs').onclick = goFavs;
  $('meStats').onclick = () => openStats('data');
  $('mePoints').onclick = () => openStats('points');
  $('meNotices').onclick = openNotices;
  $('meStar').onclick = () => openStarSync();
  $('meGift').onclick = openGiftCode;
  $('mePromo').onclick = openRedeem;
  // 我的页签到按钮：之前漏绑 onclick，点了没反应；签到成功后原地重渲染本页（按钮变「今日已签」、连签天数更新）
  $('meCheckin').onclick = () => doCheckin(() => renderMePage());
  // 「我的」页也放一条看广告入口：手机 H5 从微信打开时正好在这个页面，扫码/长按识别最顺手
  const meCkAd = $('meCkAd');
  if (meCkAd) meCkAd.onclick = () => openCheckinAdQr();
  $('meAbout').onclick = openSiteInfo;
  bindMeFabTiles(card);
  $('meLogout').onclick = doLogout;
  // 收藏预览：拉一次收藏作品，铺 3 条缩略卡 + 「查看全部」（手机端不渲染这块，跳过）
  const favListBox = $('meFavList');
  if (favListBox) (async () => {
    if (!favs) {
      favListBox.innerHTML = '<button type="button" class="me-fav-empty" id="meFavGo">还没有收藏的作品——遇到喜欢的点卡片右上角 ★ <i>›</i></button>';
      const go = $('meFavGo'); if (go) go.onclick = goFavs;
      return;
    }
    try {
      const all = await (await fetch('/api/works?fav=1&pageSize=all&sort=latest', { cache: 'no-store' })).json();
      const map = new Map((all.items || []).map(w => [w.id, w]));
      const items = (state.favs || []).map(id => map.get(id)).filter(Boolean);
      if (!items.length) { favListBox.innerHTML = '<div class="me-fav-empty">收藏的作品暂时看不到了</div>'; return; }
      favListBox.innerHTML =
        items.slice(0, 3).map(w => `
          <a class="me-fav-row" href="/w/${w.id}" data-nav>
            <img class="me-fav-thumb" src="${imgUrl(w.thumb, 400)}" alt="" loading="lazy" />
            <span class="me-fav-title">${escapeHtml(w.title)}</span>
            <i>›</i>
          </a>`).join('') +
        (items.length > 3 ? `<button type="button" class="me-fav-more" id="meFavMore">查看全部 ${items.length} 件 <i>›</i></button>` : '');
      const more = $('meFavMore'); if (more) more.onclick = goFavs;
    } catch {
      favListBox.innerHTML = '<div class="me-fav-empty">收藏列表加载失败，稍后再试</div>';
    }
  })();
}

// ---------- 分享归因：?ref= 落地 ----------
// 分享链接形如 /w/xxx?ref=账号名。落地时把 ref 记在本机（7 天有效），
// 并向服务端报一次「有效访问」——是否真加分由服务端按 IP 去重后决定，前端说了不算。
const REF_KEY = 'dm_ref';
const REF_TTL = 7 * 24 * 3600e3;
function refStore() {
  try {
    const r = JSON.parse(localStorage.getItem(REF_KEY) || 'null');
    if (!r || !r.ref) return null;
    if (Date.now() - Number(r.at || 0) > REF_TTL) return null;
    return r;
  } catch { return null; }
}
// 当前用户自己的分享身份：优先用用户 id（纯 ASCII，链接干净），旧汉字账号名链接服务端仍兼容
function myRefName() {
  return state.user ? (state.user.id || state.user.username) : '';
}
// 给链接挂上分享者身份
function withRef(url) {
  const me = myRefName();
  if (!me) return url;
  try {
    const u = new URL(url, location.origin);
    u.searchParams.set('ref', me);
    return u.toString();
  } catch { return url; }
}
let refReported = '';
function reportRefVisit(ref, workId) {
  const key = ref + '|' + (workId || '');
  if (refReported === key) return;   // 同一次页面生命周期内只报一次
  refReported = key;
  try {
    fetch('/api/ref/visit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, workId: workId || '' }), keepalive: true
    }).catch(() => {});
  } catch { /* 归因失败不影响访问 */ }
}
function captureRef() {
  let url;
  try { url = new URL(location.href); } catch { return; }
  const ref = String(url.searchParams.get('ref') || '').trim();
  if (!ref) return;
  const workId = (location.pathname.match(/^\/w\/([A-Za-z0-9_-]+)/) || [])[1] || '';
  const ok = /^[\w\u4e00-\u9fa5·]{2,20}$/.test(ref);
  if (ok) {
    try {
      localStorage.setItem(REF_KEY, JSON.stringify({ ref, workId, at: Date.now() }));
    } catch { /* 隐私模式写不进就算了 */ }
    reportRefVisit(ref, workId);
  }
  // 地址栏里的 ref 用完就摘掉：不污染统计路径，也不会被二次转发放大
  url.searchParams.delete('ref');
  history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''));
}

// ---------- 匿名投稿「存到我名下」：?claimToken=xxx ----------
// 入口在投稿进度页（/s/<token>）。凭据只在地址栏露一次，捕获后立刻摘掉；
// 没登录先弹窗说明，登录/注册成功后再真正调接口认领（见 afterAuth）。
// ---------- 我投过的作品凭据（只存本机） ----------
// 匿名投稿成功后把 /s/<token> 里的令牌记在这台浏览器里，进度页靠它决定要不要显示「存到我名下」。
// 转发出去的链接在别人设备上没有这条记录，就不会出现认领入口。不上报、不参与统计。
// 换设备/换浏览器就看不到，只能联系站长（后台仍能手动绑定归属），这是有意为之的取舍。
const CLAIM_TOKENS_KEY = 'dm_my_claim_tokens';
function saveMyClaimToken(token, title) {
  if (!token) return;
  try {
    const list = JSON.parse(localStorage.getItem(CLAIM_TOKENS_KEY) || '[]');
    const next = [{ token: String(token), title: String(title || ''), at: Date.now() }]
      .concat((Array.isArray(list) ? list : []).filter(x => x && x.token !== token))
      .slice(0, 20);
    localStorage.setItem(CLAIM_TOKENS_KEY, JSON.stringify(next));
  } catch {}
}
function hasMyClaimToken(token) {
  if (!token) return false;
  try {
    const list = JSON.parse(localStorage.getItem(CLAIM_TOKENS_KEY) || '[]');
    return Array.isArray(list) && list.some(x => x && x.token === token);
  } catch { return false; }
}

function captureClaimToken() {
  let url;
  try { url = new URL(location.href); } catch { return; }
  const token = String(url.searchParams.get('claimToken') || '').trim();
  if (!token) return;
  state.pendingClaim = token;
  url.searchParams.delete('claimToken');
  history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''));
}

function showClaimPrompt() {
  const el = $('claimOwnModal');
  if (!el) return;
  const token = state.pendingClaim;
  const trusted = hasMyClaimToken(token);
  // 不是本机投的稿：挂黄色警示，但不硬拦（换设备的人还得能继续），真正的闸门在后台审核
  const warn = $('claimOwnWarn');
  if (warn) warn.style.display = trusted ? 'none' : '';
  // 顺手把作品名亮出来：同时开着几个进度页时不至于点错
  const workEl = $('claimOwnWork');
  if (workEl) {
    workEl.style.display = 'none';
    workEl.textContent = '';
    if (token) {
      fetch('/api/claim/preview?token=' + encodeURIComponent(token))
        .then(r => r.json())
        .then(d => {
          if (!d || !d.title) return;
          workEl.innerHTML = '<b>' + escapeHtml(d.title) + '</b>' + (d.claimed ? ' · 已经有归属了' : '');
          workEl.style.display = '';
        })
        .catch(() => {});
    }
  }
  const go = $('claimOwnGo');
  go.textContent = state.user ? '确认提交认领' : '登录 / 注册后提交';
  go.onclick = () => {
    hideModal(el);
    // 已登录也要先经过这个弹窗确认，不再打开链接就静默提交
    if (state.user) runPendingClaim();
    else openAuth('login');
  };
  $('claimOwnSkip').onclick = () => { state.pendingClaim = ''; hideModal(el); };
  $('claimOwnClose').onclick = () => { state.pendingClaim = ''; hideModal(el); };
  bindMaskClose(el, () => $('claimOwnClose').click());
  showModal(el);
}

async function runPendingClaim() {
  const token = state.pendingClaim;
  if (!token) return;
  state.pendingClaim = '';
  const el = $('claimOwnModal');
  try {
    const res = await fetch('/api/claim/by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(d.error || '认领失败', 6000, 'err'); return; }
    if (d.already) { showToast('这件作品已经在你的名下了', undefined, 'ok'); return; }
    if (d.pending) {
      loadMyClaims();
      if (el) hideModal(el);
      // 登录成功后「你有 N 条新消息」的 toast 会在 600~800ms 后自己弹一次，
      // 直接弹会被它顶掉——晚 1.3 秒再报认领结果，保证用户看得到。
      setTimeout(() => showToast(`「${d.title}」的认领已提交，管理员确认后就会归到你名下`, 6000, 'ok'), 1300);
      return;
    }
  } catch {
    showToast('认领失败，请稍后再试', undefined, 'err');
  } finally {
    if (el) hideModal(el);
  }
}

// ---------- 注册后按 IP 认领：这个网络匿名投过的作品是你的吗 ----------
// 匿名投稿时服务端记了投稿 IP 指纹（work.submitIp）。用户用同一个网络注册/登录后，
// 把「这个 IP 投的、还没有归属的作品」列出来问一句；勾选确认就当场归属，
// 不走人工审核（服务端会按 IP 再核一遍，并把这次认领记进后台认领列表 channel='ip'）。
// 每个账号只问一次：认了或点「都不是我的」都会记账（user.ipClaimAnsweredAt）。
let ipClaimChecking = false;

function anyMaskOpen() {
  return Array.from(document.querySelectorAll('.modal-mask')).some(el => el.style.display === 'flex');
}

async function maybeOfferIpClaim() {
  if (!state.user || ipClaimChecking) return;
  ipClaimChecking = true;
  try {
    const res = await fetch('/api/claim/ip-candidates');
    if (!res.ok) return;
    const d = await res.json();
    const items = (d && Array.isArray(d.items)) ? d.items : [];
    if (!items.length) return;
    // 先让「欢迎回来」的 toast 说完话；这期间用户自己开了弹窗（投稿 / 详情 / 凭据认领）就不插队，
    // 也不记账——下次登录还会再问一次，不会漏掉。
    setTimeout(() => {
      if (anyMaskOpen()) return;
      showIpClaimPrompt(items);
    }, 1300);
  } catch { /* 拉不到就当没有，不打扰 */ }
  finally { ipClaimChecking = false; }
}

function showIpClaimPrompt(items) {
  const modal = $('ipClaimModal');
  const listEl = $('ipClaimList');
  if (!modal || !listEl) return;
  listEl.innerHTML = items.map(w => `
    <label class="ip-claim-item">
      <input type="checkbox" value="${escapeHtml(w.id)}" checked />
      ${w.thumb ? `<img src="${escapeHtml(w.thumb)}" alt="" loading="lazy" />` : '<span class="ip-claim-noimg"></span>'}
      <span class="ip-claim-main">
        <b>${escapeHtml(w.title || '未命名作品')}</b>
        <em>${w.createdAt ? '投稿于 ' + escapeHtml(String(w.createdAt).slice(0, 10)) : ''}${w.stage === 'wip' ? ' · 预告卡' : ''}</em>
      </span>
    </label>`).join('');
  const go = $('ipClaimGo');
  go.disabled = false;
  go.textContent = '确认认领';
  go.onclick = () => submitIpClaim();
  const no = async () => {
    hideModal(modal);
    try { await fetch('/api/claim/ip-dismiss', { method: 'POST' }); } catch { /* 记账失败下次再问，无妨 */ }
  };
  $('ipClaimNo').onclick = no;
  $('ipClaimClose').onclick = no;
  bindMaskClose(modal, no);
  showModal(modal);
}

async function submitIpClaim() {
  const modal = $('ipClaimModal');
  const ids = Array.from(document.querySelectorAll('#ipClaimList input[type=checkbox]:checked')).map(x => x.value);
  if (!ids.length) { showToast('先勾上确实是你投的作品', undefined, 'err'); return; }
  const go = $('ipClaimGo');
  go.disabled = true; go.textContent = '认领中...';
  try {
    const res = await fetch('/api/claim/ip-claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || '认领失败');
    hideModal(modal);
    const claimed = Array.isArray(d.claimed) ? d.claimed : [];
    const titles = claimed.map(c => `「${c.title}」`).join('、');
    const reward = claimed.reduce((s, c) => s + Number(c.uploadInstant || 0) + Number(c.osBonus || 0) + Number(c.settledTips || 0), 0);
    // 登录后「你有 N 条新消息」的 toast 会晚一步弹，认领结果推到 1.3 秒后说，别被顶掉
    setTimeout(() => showToast(`${titles}已归到你名下${reward > 0 ? `，${reward} 盏灯火已到账` : ''}，可以到「我的作品」里管理了`, 6000, 'ok'), 1300);
    await loadMe();
    loadMyClaims();
    await refreshMeViewIfActive();
    if (location.pathname === '/') loadWorks();
  } catch (err) {
    go.disabled = false; go.textContent = '确认认领';
    showToast(err.message, undefined, 'err');
  }
}

// ---------- 外宣渠道归因：?fr=平台key 落地 ----------
// 外宣包生成的文案里，本站链接会同时带 ?fr=<平台> 和 ?ref=<作者>。
// 访问本身不发灯火（复制粘贴式传播容易被自己刷），上报只做两件事：
//   1) 记渠道来源（后台看板 + 作者自己的「外宣带来多少人」）；
//   2) 把这台机器的来路记下，之后从这里注册会给邀请人渠道加成。
const FR_KEY = 'dm_fr';
const FR_TTL = 7 * 24 * 3600e3;
function frStore() {
  try {
    const r = JSON.parse(localStorage.getItem(FR_KEY) || 'null');
    if (!r || !r.fr) return null;
    if (Date.now() - Number(r.at || 0) > FR_TTL) return null;
    return r;
  } catch { return null; }
}
let frReported = '';
function reportFrVisit(fr, workId, ref) {
  const key = fr + '|' + (workId || '') + '|' + (ref || '');
  if (frReported === key) return;
  frReported = key;
  try {
    fetch('/api/fr/visit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fr, workId: workId || '', ref: ref || '' }), keepalive: true
    }).catch(() => {});
  } catch { /* 统计失败不影响访问 */ }
}
function captureFr() {
  let url;
  try { url = new URL(location.href); } catch { return; }
  const fr = String(url.searchParams.get('fr') || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(fr)) return;
  const workId = (location.pathname.match(/^\/w\/([A-Za-z0-9_-]+)/) || [])[1] || '';
  // 本次落地地址里就带 ref 时优先用它（captureFr 跑在 captureRef 前面，refStore 这时还是空的）
  const ref = String(url.searchParams.get('ref') || '').trim() || ((refStore() || {}).ref || '');
  try { localStorage.setItem(FR_KEY, JSON.stringify({ fr, workId, at: Date.now() })); }
  catch { /* 隐私模式写不进就算了 */ }
  reportFrVisit(fr, workId, ref);
  // 摘掉 fr，保持地址栏干净（不参与路径统计，也不会被二次转发带上）
  url.searchParams.delete('fr');
  history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''));
}
// 给本站链接挂渠道标记（外站链接不加：对方不认这个参数，只会显得像营销链接）
function withFr(url, fr) {
  if (!url || !fr) return url;
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return url;
    u.searchParams.set('fr', fr);
    return u.toString();
  } catch { return url; }
}
// 外宣文案里的本站链接要同时挂两个参数：fr 是渠道（统计用），ref 是作品作者（外宣来的注册算在作者头上）。
// 只挂 fr 的话，作者把文案发出去带回来的注册没法归属，等于白发。
// ref 由调用方传作品作者（w.author），不默认取当前登录者——按钮已经只给作者看，
// 但归因不能靠「谁在看这条链接」来定，否则一旦露出给访客就会把作者的注册算到别人头上。
function promoUrl(url, fr, ref) {
  if (!url || !fr) return url;
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return url;
    u.searchParams.set('fr', fr);
    const who = ref || myRefName();
    if (who) u.searchParams.set('ref', who);
    return u.toString();
  } catch { return url; }
}

// ---------- 访问统计：页面浏览上报（PV；UV 由后端按账号/IP 去重） ----------
let lastTrack = { path: '', at: 0 };
let lastWorkTrack = { id: '', at: 0 };
// 来源页 + 落地页只在「本次打开的第一屏」报一次：document.referrer 在整个 SPA 生命周期里
// 都是落地那一刻的值，站内跳转再报的话，首页/详情页会被全部算成来路和落地页。
let entryPending = true;
function trackPageView() {
  const p = location.pathname + location.search;
  const now = Date.now();
  if (p === lastTrack.path && now - lastTrack.at < 1500) return; // 同路径 1.5s 内不重复计
  lastTrack = { path: p, at: now };
  const body = { path: p, vid: visitorId() };
  if (entryPending) {
    entryPending = false;
    body.entry = true;
    body.ref = document.referrer || '';
  }
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), keepalive: true
    }).catch(() => {});
  } catch { /* 统计失败不影响页面 */ }
}

// 只计作品维度的浏览（在首页/榜单等以弹窗方式打开作品时用，不重复计站点 PV）
function trackWorkView(id) {
  if (!id) return;
  const now = Date.now();
  if (id === lastWorkTrack.id && now - lastWorkTrack.at < 2000) return;
  lastWorkTrack = { id, at: now };
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: location.pathname + location.search, workId: id, site: false, vid: visitorId() }), keepalive: true
    }).catch(() => {});
  } catch { /* 统计失败不影响页面 */ }
}

// 动作埋点：真的点了「访问/下载」，或真的要「看/存小程序码」。
// 和浏览量分开记——浏览量是「看到了」，这里才是「去用了」，两者不能混成一个数。
// 下载类形态单独算 download，其余算 visit；小程序记 scan（网页侧只能拿到扫码意图）
const DOWNLOAD_TYPES = { 'iOS': 1, 'Android': 1, 'macOS': 1, 'Windows': 1, 'Linux': 1, '浏览器插件': 1 };
function actionOfType(t, site) {
  if (site) return 'visit';
  return DOWNLOAD_TYPES[t] ? 'download' : 'visit';
}
let lastActionAt = {};
function trackAction(id, action, type) {
  if (!id || !action) return;
  // 同一个人 800ms 内连点同一个按钮只算一次（手抖双击不该记两次）
  const key = id + '|' + action + '|' + (type || '');
  const now = Date.now();
  if (lastActionAt[key] && now - lastActionAt[key] < 800) return;
  lastActionAt[key] = now;
  if (Object.keys(lastActionAt).length > 200) lastActionAt = { [key]: now };
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: location.pathname + location.search, workId: id, action, type: type || '' }), keepalive: true
    }).catch(() => {});
  } catch { /* 统计失败不影响跳转 */ }
}

// 小程序码「放大 / 保存」：扫码本身仍然零摩擦（码一直露着），
// 这两个入口只是给「想拿近点扫 / 想存下来发人」的人用，同时让我们能记到一次扫码意图
let qrZoomEl = null;
function openQrZoom(src, tip) {
  closeQrZoom();
  const box = document.createElement('div');
  box.className = 'qr-zoom';
  box.innerHTML = `<div class="qr-zoom-card">
      <img src="${escapeHtml(src)}" alt="二维码大图" />
      <p>${escapeHtml(tip || '扫码打开作品')}</p>
      <span class="qr-zoom-hint">点任意处关闭 · 手机可长按图片保存</span>
    </div>`;
  box.onclick = closeQrZoom;
  document.body.appendChild(box);
  qrZoomEl = box;
  lockScroll();
  document.addEventListener('keydown', qrZoomEsc);
}
function closeQrZoom() {
  if (!qrZoomEl) return;
  qrZoomEl.remove();
  qrZoomEl = null;
  unlockScroll();
  document.removeEventListener('keydown', qrZoomEsc);
}
function qrZoomEsc(e) { if (e.key === 'Escape') closeQrZoom(); }
// 上传表单的图片放大：封面 / 二维码 / 宣传图缩略图点开看大图。
// 复用二维码放大层的遮罩、Esc 关闭和滚动锁定，套 save-full 变体按长边自适应（竖版手机截图不会被压成正方形）
function openImgZoom(src, tip) {
  if (!src) return;
  closeQrZoom();
  const box = document.createElement('div');
  box.className = 'qr-zoom save-full';
  box.innerHTML = `<div class="qr-zoom-card">
      <img src="${escapeHtml(src)}" alt="图片大图" />
      ${tip ? `<p>${escapeHtml(tip)}</p>` : ''}
      <span class="qr-zoom-hint">点任意处关闭 · 手机可长按图片保存</span>
    </div>`;
  box.onclick = closeQrZoom;
  document.body.appendChild(box);
  qrZoomEl = box;
  lockScroll();
  document.addEventListener('keydown', qrZoomEsc);
}
// ---------- 保存图片（统一入口） ----------
// iOS 没有任何「写入相册」的 API：<a download> 只会落到「文件」App，装成 PWA 后
// 甚至会把 App 顶成一个没有返回按钮的裸图视图。能进相册的只有两个口子——
//   ① navigator.share 唤起系统面板，用户点「存储图像」
//   ② 全屏大图长按，「存储到照片」
// 所以 iOS 走这两条，桌面和安卓保持原来的 <a download>，行为一点没变。
function isIOSDevice() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ 的 UA 伪装成 MacIntel，只能靠触点数认出来
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
// 手机上优先走系统分享面板：iOS 是唯一的相册入口，安卓也能一步「保存到相册」，
// 比丢进下载目录再翻文件管理器顺手。桌面保持下载——桌面弹分享面板反而多余。
function preferShareSheet() {
  return isIOSDevice() || /Android/i.test(navigator.userAgent || '');
}

// 图片在弹窗一打开就先预取成 Blob：iOS 的 share 必须紧贴点击手势触发，
// 等按下按钮再去 fetch 一张几百 KB 的码图，手势可能已过期，面板就不弹了。
const saveBlobCache = new Map();
function prefetchSaveBlob(src) {
  if (!src || !preferShareSheet() || saveBlobCache.has(src)) return;
  srcToBlob(src).then(b => { if (b) saveBlobCache.set(src, b); }).catch(() => {});
}

function dataUrlToBlob(url) {
  const i = url.indexOf(',');
  if (i < 0) return null;
  const head = url.slice(0, i), body = url.slice(i + 1);
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
  if (!/;base64/i.test(head)) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
  return new Blob([buf], { type: mime });
}

async function srcToBlob(src) {
  if (!src) return null;
  if (src instanceof Blob) return src;
  if (/^data:/i.test(src)) return dataUrlToBlob(src);
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('fetch ' + res.status);
  return res.blob();
}

// iOS 的兜底：把图摊成全屏，长按「存储到照片」。复用二维码放大层的底色和关闭方式
let saveOverlayEl = null;
function showSaveOverlay(blob, hint) {
  closeSaveOverlay();
  const url = URL.createObjectURL(blob);
  const box = document.createElement('div');
  box.className = 'qr-zoom save-full';
  box.innerHTML = `<div class="qr-zoom-card">
      <img src="${url}" alt="长按保存这张图片" />
      <p>${escapeHtml(hint || '图片已放大')}</p>
      <span class="qr-zoom-hint">长按图片 →「存储到照片」即可存进相册 · 点空白处关闭</span>
    </div>`;
  box.onclick = closeSaveOverlay;
  document.body.appendChild(box);
  saveOverlayEl = { box, url };
  lockScroll();
  document.addEventListener('keydown', saveOverlayEsc);
}
function saveOverlayEsc(e) { if (e.key === 'Escape') closeSaveOverlay(); }
function closeSaveOverlay() {
  if (!saveOverlayEl) return;
  const { box, url } = saveOverlayEl;
  saveOverlayEl = null;
  box.remove();
  unlockScroll();
  document.removeEventListener('keydown', saveOverlayEsc);
  // 长按菜单可能还开着，图源先别回收，否则「存储到照片」会存出个空图
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 普通下载：桌面 / 安卓，以及 iOS 拿不到字节时的最后兜底
function downloadDirect(src, name, opts = {}) {
  const isUrl = typeof src === 'string';
  const a = document.createElement('a');
  a.href = isUrl ? src : URL.createObjectURL(src);
  a.download = name;
  a.rel = 'noopener';
  // 跨域图带 download 会被忽略（变成导航），干脆开新标签让用户自己长按存
  try {
    if (new URL(a.href, location.href).origin !== location.origin) a.target = '_blank';
  } catch { /* data:/blob: 不用管 */ }
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!isUrl) setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  if (opts.toastOk) showToast(opts.toastOk, undefined, 'ok');
}

/**
 * 保存一张图。
 * @param {Blob|string} input Blob / data URL / 图片地址
 * @param {{name?:string, iosHint?:string, toastOk?:string, fallback?:(blob:Blob)=>void}} opts
 *        fallback：iOS 上无法唤起分享面板时用什么代替长按大图（分享卡片用自己的覆盖层）
 */
async function saveImage(input, opts = {}) {
  const name = opts.name || 'image.png';
  let blob = input instanceof Blob ? input : saveBlobCache.get(input);
  if (!blob) {
    try { blob = await srcToBlob(input); } catch { blob = null; }
  }
  if (blob && typeof input === 'string') saveBlobCache.set(input, blob);
  if (!blob) { downloadDirect(input, name, opts); return; }

  if (preferShareSheet()) {
    try {
      const file = new File([blob], name, { type: blob.type || 'image/png' });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;   // 面板里点「存储图像」就进相册了，不用再额外提示
      }
    } catch (e) {
      // 用户自己按了取消就别硬塞大图；其余失败（手势过期、系统拒了）走长按兜底
      if (e && e.name === 'AbortError') return;
    }
    if (typeof opts.fallback === 'function') opts.fallback(blob);
    else showSaveOverlay(blob, opts.iosHint);
    return;
  }

  downloadDirect(blob, name, opts);
}

// 保存二维码：iOS 上没有相册写入权限，交给 saveImage 走分享面板 / 长按存储
function saveQrImage(src, id) {
  saveImage(src, {
    name: 'aiworks-qr-' + String(id || 'work') + '.png',
    iosHint: '二维码已放大',
    toastOk: '二维码已保存，可以直接发给朋友'
  });
}

function route() {
  const path = location.pathname;
  detailLeaving = false; // back() 已落地，防重入标记解除
  // 从详情弹窗退回：列表视图原样保留，不重新拉数据（分页、滚动位置、「展示更多」都不动）
  const keepList = skipNextListReload;
  skipNextListReload = false;
  const keepScrollY = keepList ? window.scrollY : 0; // 视图隐藏再显示会把滚动位置钳回顶部，这里记下来还原
  const restoreScroll = () => { if (keepList) requestAnimationFrame(() => window.scrollTo(0, keepScrollY)); };
  // 先把视图藏干净、删掉 SSR 区块，最后才摘 data-page 标记（顺序不能反）：
  // 旧顺序是先摘标记再收拾视图，中途任何一步抛错，页面就会永远停在
  // 「首页内容 + 底部挂着 /rank 的 SEO 作品榜单区块」的半路状态（用户真的撞见过）
  closeAllViews();
  const isWorkPage = path.startsWith('/w/');
  // 服务端渲染整页的静态页：/chronicle（编年史）、/rules（作品规范）、/install（安装到桌面）、/invite（邀请收录）、/column（精选专栏）——SPA 只负责藏首页、给标题
  const isChronicle = path === '/chronicle';
  const isColumn = path === '/column' || path.startsWith('/column/');
  // 品牌橱窗页：企业合作内容的落地页，标题由服务端按品牌写好，SPA 不覆盖
  const isBrandPage = path.startsWith('/brand/');
  const isStaticPage = isChronicle || isColumn || isBrandPage || path === '/rules' || path === '/install' || path === '/invite' || path === '/ads' || path === '/enterprise' || path === '/open';
  document.body.classList.toggle('on-work', isWorkPage);
  if (!isWorkPage && !isStaticPage) removeSeoBlock();
  document.documentElement.removeAttribute('data-page');
  try { trackPageView(); } catch (e) { /* 统计挂了不能连累切页 */ }

  if (isStaticPage) {
    const seoEl = document.querySelector('main > #seoContent');
    if (seoEl) {
      seoEl.style.display = '';
      $('homeView').style.display = 'none';
      // 品牌橱窗页的 title 由服务端按品牌生成（「品牌名 · 一句话 - 品牌橱窗」），这里别覆盖成「作品规范」
      if (!isBrandPage) setTitle(isChronicle ? '造梦编年史'
        : isColumn ? '精选专栏'
        : (path === '/install' ? '安装到桌面'
        : path === '/ads' ? '投放合作'
        : path === '/enterprise' ? '企业产品入驻'
        : path === '/open' ? '开源好物'
        : (path === '/invite' ? '邀请你来收录作品' : '作品规范')));
      updateNavActive();
      return;
    }
    // SPA 内部跳到静态页（页面里没注入服务端内容）：整页加载一次，别把首页当兜底。
    // sessionStorage 做一次防抖，避免「没有内容 → 重载 → 还是没有内容」的死循环。
    const guard = 'seoReload:' + path;
    if (sessionStorage.getItem(guard)) { sessionStorage.removeItem(guard); return; }
    sessionStorage.setItem(guard, '1');
    location.assign(path);
    return;
  }

  if (isWorkPage) {
    // 完整页面模式（?full=1）：直接展示服务端渲染的整页，不自动弹窗
    const seoEl = document.querySelector('main > #seoContent');
    if (isFullView() && seoEl && seoEl.dataset.full === '1') {
      $('homeView').style.display = 'none';
      document.body.classList.remove('on-work');
      updateNavActive();
      return;
    }
    $('homeView').style.display = 'block';
    openWork(path.slice(3), false);
    updateNavActive();
    return;
  }
  if (path.startsWith('/u/')) {
    $('authorView').style.display = 'block';
    if (!keepList) loadAuthor(decodeURIComponent(path.slice(3)));
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/rank') {
    $('rankView').style.display = 'block';
    setTitle(isH5View() ? '榜单' : '星梦榜');
    // 支持 /rank?period=week&by=likes&type=Web&category=效率工具 这类可分享、可被收录的筛选链接（H5 / PC 共用 period·by·type）
    const rqs = new URLSearchParams(location.search);
    const rt = rqs.get('type'); if (rt) { rankH5.type = rt; rankState.type = rt; }
    const rc = rqs.get('category'); if (rc) rankState.cat = rc;
    const rp = rqs.get('period'); if (['weekhot', 'week', 'month', 'all', 'peak'].includes(rp)) { rankH5.period = rp; rankState.period = rp; }
    const rb = rqs.get('by'); if (['hot', 'likes', 'favs', 'tips', 'uv'].includes(rb)) { rankH5.by = rb; rankState.by = rb; }
    if (!keepList) {
      loadRankView(); // 不重置筛选，保留用户上次选的那一套
    } else {
      // 详情开着时页面可能被重载过（微信下拉刷新 / 内核回收重开），列表 DOM 已随重载清空——空了就重拉
      const curList = isH5View() ? $('rankListH5') : $('rankList');
      if (!curList || !curList.children.length) loadRankView();
    }
    // 榜单页推荐位（2026-11-12 改两栏）：页头通栏 + PC 宽屏右栏两个容器同用 rank 槽位，各自重抽渲染；
    // 同屏只显一处（CSS ≥1100px 显右栏、页头那条让位），藏着的容器不参与曝光计费（IntersectionObserver 不命中）。
    // 投放者本机的自验证优先级在 renderAdSlot 内处理，这里不额外判断
    document.querySelectorAll('#rankView [data-ad-slot="rank"]').forEach(el => renderAdSlot(el, 'rank'));
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/bar') {
    $('wishView').style.display = 'block';
    setTitle('造梦酒馆');
    setupWish();
    // 楼层深链（/bar?p=帖子id）：先记下再动地址栏——下面 ?compose 的清理会把参数抹掉
    const pParam = (new URLSearchParams(location.search).get('p') || '').trim();
    // ?compose=want|chat：从头部 / 底部那颗加号点进来的，落地就停在对应的输入框。
    // 参数用完即摘（replaceState），刷新或后退回来不再重复抢焦点、也不再改用户自己选过的心情。
    // 深链的 ?p= 要保留（摘完参数原样放回）
    const cmpParam = new URLSearchParams(location.search).get('compose');
    if (cmpParam === 'want' || cmpParam === 'chat') {
      setBarCompose(cmpParam);
      focusBarComposer();
      history.replaceState({}, '', '/bar' + (pParam ? '?p=' + encodeURIComponent(pParam) : ''));
    }
    // ?want=…：找找没翻到东西时把他的原话带过来，落地就填进想法框——他改两个字就能发，
    // 不用到了酒馆再从头想一遍怎么写。同样用完即摘，别让刷新/后退重复灌一次。
    const wantParam = (new URLSearchParams(location.search).get('want') || '').trim().slice(0, 80);
    if (wantParam) {
      setBarCompose('want');
      const wi = $('wishInput');
      if (wi) wi.value = wantParam;
      focusBarComposer();
      history.replaceState({}, '', '/bar' + (pParam ? '?p=' + encodeURIComponent(pParam) : ''));
      showToast('已经放进想法框，改两个字就能发', 2600);
    }
    // 话题过滤只活在这一次停留里：从别处重新进酒馆就回全部闲聊，
    // 免得上次看某个话题、过两天回来发现列表还是被filter住的（keepList 走的是返回，保留过滤）
    if (!keepList && feedState.tag) { feedState.tag = ''; feedState.tagTotal = 0; renderTopicBar(); }
    // 想法与闲聊合流：一次请求两路数据、前端归并渲染（不再按 tab 懒加载）。
    // keepList（详情返回/回跳）时保留现有列表与滚动位置，列表空了才重拉
    const feedReady = (!keepList || !$('wishList').children.length)
      ? loadFeed(true) : Promise.resolve();
    // 深链定位：列表就绪后再滚过去展开；首屏没有的那条由 focusChatPost 向接口点名要
    if (pParam) feedReady.then(() => focusChatPost(pParam));
    loadBarBoard();   // 近7日热门 / 书架：普通访客进门先有得看（一次请求）
    loadUpcoming();   // 右栏「即将上线」：还在做 / 等平台上架审核（2026-11-13 从首页挪来）
    // 酒馆推荐位：与榜单页顶部共用 rank 槽位（一次购买两处轮展），每次进入重抽（各家机会均等）；
    // 摆在右栏「近7日热门」上方（2026-11-12 从散座话题流搬来），半屏栏竖排 2 条（340px 并排会挤碎标题；
    // .ad-stack 的 auto-fit 在窄容器里天然退成单列）。榜单页仍是 2-4 条并排
    renderAdSlot($('wishView').querySelector('[data-ad-slot="rank"]'), 'rank', { maxCols: 2 });
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/mini') {
    $('miniView').style.display = 'block';
    setTitle('小程序专栏');
    setupMiniColumn();
    if (!keepList) loadMiniColumn();
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/guide') {
    $('guideView').style.display = 'block';
    setTitle('外宣指南');
    loadGuide();
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/howto') {
    $('howtoView').style.display = 'block';
    setTitle('投稿指南');
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/promote') {
    $('promoteView').style.display = 'block';
    setTitle('推荐');
    loadRedeemPanel();
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/discover') {
    $('discoverView').style.display = 'block';
    setTitle('发现');
    if (!keepList) loadDiscover();
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/me') {
    $('meView').style.display = 'block';
    setTitle('我的');
    renderMePage();
    updateNavActive();
    return;
  }
  if (path === '/settings') {
    $('settingsView').style.display = 'block';
    setTitle('账号设置');
    renderSettingsPage();
    updateNavActive();
    restoreScroll();
    return;
  }
  // 我的收藏 / 我的点赞：独立页面（2026-11-12 从首页「只看收藏/点赞」过滤态收编成专属路由，
  // 首页不再承载收藏与点赞操作）。都是登录态内容，未登录直接空列表 + 弹登录。
  if (path === '/favs' || path === '/likes') {
    const isFav = path === '/favs';
    $(isFav ? 'favView' : 'likeView').style.display = 'block';
    setTitle(isFav ? '我的收藏' : '我的点赞');
    if (!state.user) {
      openAuth('login');
      showToast(isFav ? '登录后可查看你的收藏' : '登录后可查看你点赞的作品');
    }
    if (isFav) loadFavPage(); else loadLikedPage();
    updateNavActive();
    return;
  }
  $('homeView').style.display = 'block';
  setTitle(state.q ? `搜索「${state.q}」` : '');
  if (!keepList || !document.querySelector('#gallery .card, #gallery .work-row')) {
    // 详情开着时页面若被重载过，#gallery 里只剩骨架屏——这时不能沿用 keepList，得重拉
    loadFeatured();
    loadWorks();
  }
  updateNavActive();
  restoreScroll();
}

// ---------- 作者主页（创作者档案页） ----------
// 万级数字缩写：灯火了、访客量上千后别让数字块挤爆（10 → 1万+）
function fmtStatNum(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}
// 勋章胶囊：图标取不到单独 SVG（勋章图集只在勋章页），用层级色点 + 名字表达；
// hover 提示获取条件，点击进勋章页看完整规则。t: L1 金 / L2 紫 / L3 金棕（与勋章页 TIERS 同色）
const AUTHOR_BADGE_TIER_COLOR = { L1: '#f59e0b', L2: '#5b5bd6', L3: '#8a6d1f' };
function authorBadgesHtml(badges) {
  if (!Array.isArray(badges) || !badges.length) return '';
  return badges.map(b =>
    `<button type="button" class="author-badge" data-badge="${escapeHtml(b.key)}"
        title="${escapeHtml(b.name)} · ${b.t === 'L3' ? '站长授予' : '已点亮'}"
        style="--badge-c:${AUTHOR_BADGE_TIER_COLOR[b.t] || '#5b5bd6'}"
        onclick="location.href='/medals.html'">
      <span class="ab-dot" aria-hidden="true"></span>${escapeHtml(b.name)}
    </button>`
  ).join('');
}
// 数据看板的六个格子：作品 / 获赞 / 被收藏 / 访客 / 点亮人数 / 评论。
// 2026-11-14 一度收成四格（只留作品/获赞/访客/点亮），站长看到截图说「这个样式挺好的呀」——
// 六格带图标、带竖分隔线才是他要的信息密度，撤掉的两项在「作品数据」面板里有，但一眼能看到更好。看板恢复六格。
// 结构固定，加载态只把数字换成「–」，高度不变（避免数据回来时整块往上跳）
const AUTHOR_STAT_CELLS = [
  { ico: 'edit', label: '作品', key: 'total' },
  { ico: 'heart', label: '获赞', key: 'totalLikes' },
  { ico: 'fav', label: '被收藏', key: 'totalFavs' },
  { ico: 'eye', label: '访客', key: 'totalUv', tip: '各作品访客合计：同一人看多件会重复计入' },
  { ico: 'lamp', label: '点亮人数', key: 'totalTips', tip: '送过灯火的人数，同一人多笔只算一人' },
  { ico: 'chat', label: '评论', key: 'totalComments' }
];
function authorStatGridHtml(d) {
  return AUTHOR_STAT_CELLS.map(c =>
    `<div class="as-cell"${c.tip ? ` title="${c.tip}"` : ''}>
      <span class="as-ico">${ic(c.ico, 15)}</span>
      <b class="as-val">${fmtStatNum(d[c.key])}</b>
      <span class="as-label">${c.label}</span>
    </div>`
  ).join('');
}
// 加载态：同一批格子、同一个图标，数字位先写「–」（不是假数据，是「还不知道」）
function authorStatSkeletonHtml() {
  return AUTHOR_STAT_CELLS.map(c =>
    `<div class="as-cell is-ph">
      <span class="as-ico">${ic(c.ico, 15)}</span>
      <b class="as-val">–</b>
      <span class="as-label">${c.label}</span>
    </div>`
  ).join('');
}
// 入驻时间与常写分类的 meta 行：一句话交代「这位是谁」
function authorMetaHtml(d) {
  const bits = [];
  if (d.since) {
    const dt = new Date(d.since);
    bits.push(`<span>${dt.getFullYear()} 年 ${dt.getMonth() + 1} 月入驻</span>`);
  }
  if (Array.isArray(d.cats) && d.cats.length) {
    const cats = d.cats.slice(0, 3).map(c => escapeHtml(c.name)).join(' / ');
    bits.push(`<span>常做 ${cats}</span>`);
  }
  if (d.openCount > 0) bits.push(`<span>${d.openCount} 件开源</span>`);
  return bits.length ? bits.map(s => `<span class="am-item">${s}</span>`).join('') : '';
}
// 外部主页链接（GitHub / 知乎 / 掘金 / V2EX / 微博）：档案行下面一排小胶囊。
// 只渲染服务端发下来的白名单结果（url 一定是 https + 固定域名），所以这里不必再校验；
// rel 里带 nofollow：这不是站内推荐，不该给外站分权重。
function authorLinksHtml(links) {
  return (Array.isArray(links) ? links : []).map(l =>
    `<a class="al-link" href="${escapeHtml(l.url)}" target="_blank" rel="nofollow noopener noreferrer"
       title="在 ${escapeHtml(l.label)} 看 TA">${escapeHtml(l.label)}</a>`
  ).join('');
}

// ---------- 作者主页（本人视角）：tab + 功能入口（2026-11-14） ----------
// 参考了站长给的排版：统计 + 「编辑主页」→ 一行四个功能图标 → 作品/收藏/喜欢三个 tab。
// 只有本人主页有这三样：收藏、点赞、灯火、推荐记录都是私事，访客不该看到入口（更不该看到内容）。
const authorTabState = { tab: 'works', works: [], favs: null, likes: null, req: 0 };
const AU_TAB_LOAD = { favs: '正在点亮收藏…', likes: '正在点亮喜欢…' };

// 本人主页的三组入口统一在这里显隐 + 绑事件（访客全部收起来）
function bindAuthorOwnerTools(isMe) {
  const editBtn = $('authorEditBtn'), acts = $('authorActs'), tabs = $('authorTabs');
  if (!editBtn || !acts || !tabs) return;
  editBtn.style.display = isMe ? '' : 'none';
  acts.style.display = isMe ? '' : 'none';
  tabs.style.display = isMe ? '' : 'none';
  if (!isMe) return;
  editBtn.onclick = openAuthorEditSheet;
  acts.querySelectorAll('[data-auact]').forEach(btn => {
    btn.onclick = () => {
      const k = btn.dataset.auact;
      if (k === 'promo') goMyPromotions();
      else if (k === 'wallet') openStats('points');
      else if (k === 'mini') { const m = $('miniModal'); if (m) showModal(m); }
      else openAuthorMoreSheet();
    };
  });
  tabs.querySelectorAll('[data-autab]').forEach(btn => {
    btn.onclick = () => { if (authorTabState.tab !== btn.dataset.autab) setAuthorTab(btn.dataset.autab); };
  });
}

function setAuthorTab(tab) {
  authorTabState.tab = tab;
  const bar = $('authorTabs');
  if (bar) bar.querySelectorAll('[data-autab]').forEach(b => b.classList.toggle('is-on', b.dataset.autab === tab));
  renderAuthorTab(tab);
}

// 三个 tab 共用 #authorGallery：切 tab 只换内容，不换页面、不改地址（分享链接永远指向作品 tab）
async function renderAuthorTab(tab) {
  const box = $('authorGallery');
  if (!box) return;
  const token = ++authorTabState.req;   // 连点：只认最后一次的结果
  box.classList.remove('list-mode');
  if (tab === 'works') {
    // ownerTools：作者本人主页的作品 tab 才挂操作行（编辑/上下架/推荐/小程序详情页）；
    // 卡片里的 w.owned 再兜一层，别人主页的卡片就算走到这里也不会出按钮
    box.innerHTML = authorTabState.works.map(w => cardHtml(w, { ownerTools: true })).join('') ||
      '<div class="empty" style="grid-column:1/-1"><p>这位作者还没有作品</p></div>';
    bindCards(box);
    return;
  }
  const key = tab === 'favs' ? 'favs' : 'likes';
  if (authorTabState[key]) { paintAuthorList(authorTabState[key], tab); return; }
  box.innerHTML = dmLoadHtml(AU_TAB_LOAD[tab] || '正在点亮…');
  try {
    const items = await fetchAuthorList(tab);
    if (token !== authorTabState.req) return;
    authorTabState[key] = items;
    paintAuthorList(items, tab);
  } catch {
    if (token !== authorTabState.req) return;
    box.innerHTML = `<div class="empty" style="grid-column:1/-1"><p>${tab === 'favs' ? '收藏' : '点赞'}列表加载失败，稍后再试</p></div>`;
  }
}

// 收藏 / 点赞列表：都走 /api/works 的现成参数（与 /favs、/likes 两个独立页同一套接口）
async function fetchAuthorList(tab) {
  if (tab === 'favs') {
    const d = await (await fetch('/api/works?fav=1&pageSize=all&sort=latest', { cache: 'no-store' })).json();
    const map = new Map((d.items || []).map(w => [w.id, w]));
    // state.favs 是「我刚收藏的顺序」，接口结果只用来查详情——收藏页要保持这个顺序
    return (state.favs || []).map(id => map.get(id)).filter(Boolean);
  }
  const d = await (await fetch('/api/works?liked=1&pageSize=all&sort=latest', { cache: 'no-store' })).json();
  return Array.isArray(d.items) ? d.items : [];
}

function paintAuthorList(items, tab) {
  const box = $('authorGallery');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = tab === 'favs'
      ? `<div class="empty" style="grid-column:1/-1"><p>还没有收藏的作品——遇到喜欢的点卡片右上角 ★，收藏跟着账号走，换设备也在</p>
          <p class="au-empty-act"><button type="button" class="btn-primary" id="auEmptyGo">去逛逛</button></p></div>`
      : `<div class="empty" style="grid-column:1/-1"><p>还没有点过赞的作品——在作品页点一下 ♡，喜欢过的都会攒在这里</p>
          <p class="au-empty-act"><button type="button" class="btn-primary" id="auEmptyGo">去逛逛</button></p></div>`;
    const go = $('auEmptyGo');
    if (go) go.onclick = () => navigate('/');
    return;
  }
  box.innerHTML = items.map(w => cardHtml(w)).join('');
  bindCards(box);
}

// 通用动作弹层：编辑主页 / 全部功能共用一张（都是「一列可点的行」，没必要写两套）
let auSheetEl = null;
function openAuthorActionSheet(title, items) {
  if (!auSheetEl) {
    auSheetEl = document.createElement('div');
    auSheetEl.className = 'modal-mask';
    document.body.appendChild(auSheetEl);
    bindMaskClose(auSheetEl, () => hideModal(auSheetEl));
  }
  auSheetEl.innerHTML = `
    <div class="modal au-sheet">
      <button type="button" class="close-btn" aria-label="关闭">×</button>
      <h3 class="au-sheet-title">${escapeHtml(title)}</h3>
      <div class="au-sheet-list">${items.map((it, i) => `
        <button type="button" class="au-sheet-row" data-aureg="${i}">
          <span class="au-sheet-ico">${ic(it.icon || 'arrowout', 18)}</span>
          <span class="au-sheet-main"><b>${escapeHtml(it.label)}</b>${it.sub ? `<i>${escapeHtml(it.sub)}</i>` : ''}</span>
          ${it.badge ? `<span class="au-sheet-badge">${it.badge}</span>` : ''}
          <span class="au-sheet-more">›</span>
        </button>`).join('')}</div>
    </div>`;
  auSheetEl.querySelector('.close-btn').onclick = () => hideModal(auSheetEl);
  auSheetEl.querySelectorAll('[data-aureg]').forEach(btn => {
    btn.onclick = () => {
      const it = items[Number(btn.dataset.aureg)];
      hideModal(auSheetEl);
      if (it && typeof it.on === 'function') it.on();
    };
  });
  showModal(auSheetEl);
}

// 「编辑主页」：头像 / 昵称 / 个性地址——三件事原来散在三个入口，主页上给一个总口
function openAuthorEditSheet() {
  const u = state.user || {};
  const ls = Array.isArray(u.links) ? u.links : [];
  openAuthorActionSheet('编辑主页', [
    { icon: 'user', label: '换个头像', sub: u.avatar ? '当前已有自定义头像' : '现在是名字首字母', on: openAvaModal },
    { icon: 'edit', label: '修改昵称', sub: u.nickname ? `现在叫「${u.nickname}」` : '还没设过昵称', on: openNickModal },
    { icon: 'link', label: '个性地址', sub: u.slug ? `/u/${u.slug}` : '把 /u/ 后面的编号换成好记的词', on: openSlugModal },
    { icon: 'globe', label: '我的链接', sub: ls.length ? ls.map(l => l.label).join(' / ') : 'GitHub、知乎、掘金… 填了才显示', on: openLinksModal },
    { icon: 'gear', label: '账号设置', sub: '密码、绑定、消息提醒', on: () => navigate('/settings') }
  ]);
}

// 「我的链接」：三个输入框，贴链接就行，展示文案由服务端按域名算（GitHub / 知乎 / 掘金 / V2EX / 微博）。
// 为什么不是「每个平台一个框」：68 个账号里资料区目前只有入驻时间和分类，一次摆五个空框，
// 大多数人只会填一个，剩下四个空着反而让弹层变长、显得没填完。三个通用槽位够用也收得住。
let linksModalEl = null;
function openLinksModal() {
  if (!state.user) { openAuth('login'); return; }
  const cur = (Array.isArray(state.user.links) ? state.user.links : []).map(l => l.url);
  if (!linksModalEl) {
    linksModalEl = document.createElement('div');
    linksModalEl.className = 'modal-mask';
    document.body.appendChild(linksModalEl);
    bindMaskClose(linksModalEl, () => hideModal(linksModalEl));
  }
  const PH = [
    'https://github.com/你的名字',
    'https://www.zhihu.com/people/你的名字',
    'https://juejin.cn/user/…'
  ];
  linksModalEl.innerHTML = `
    <div class="modal links-modal">
      <button type="button" class="close-btn" aria-label="关闭">×</button>
      <h3 class="links-title">我的链接</h3>
      <p class="links-hint">最多 3 个，会显示在你的主页上。只认 GitHub / 知乎 / 掘金 / V2EX / 微博——不开自由网址，免得这里变成广告位。</p>
      <div class="links-rows">${[0, 1, 2].map(i => `
        <input class="links-inp" type="url" inputmode="url" autocomplete="off" spellcheck="false"
          placeholder="${PH[i]}" value="${escapeHtml(cur[i] || '')}">`).join('')}
      </div>
      <p class="links-msg" id="linksMsg"></p>
      <button type="button" class="btn-primary links-save" id="linksSave">保存</button>
    </div>`;
  linksModalEl.querySelector('.close-btn').onclick = () => hideModal(linksModalEl);
  const btn = linksModalEl.querySelector('#linksSave');
  btn.onclick = () => submitLinks(btn);
  if (!cur.length) {
    const first = linksModalEl.querySelector('.links-inp');
    setTimeout(() => { if (first) first.focus(); }, 60);
  }
  showModal(linksModalEl);
}

async function submitLinks(btn) {
  const box = linksModalEl;
  if (!box) return;
  const msg = box.querySelector('#linksMsg');
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'links-msg' + (kind ? ' ' + kind : ''); };
  const vals = Array.from(box.querySelectorAll('.links-inp')).map(i => i.value.trim()).filter(Boolean);
  btn.disabled = true;
  say('保存中…');
  try {
    const r = await fetch('/api/me/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: vals })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { say(d.error || '保存失败，稍后再试', 'err'); return; }
    state.user.links = Array.isArray(d.links) ? d.links : [];
    hideModal(box);
    showToast(vals.length ? '链接已更新' : '链接已清空', undefined, 'ok');
    // 在自己的主页上改的：卡片和 tab 不用重拉，只把档案行下面那排刷新一下
    if (location.pathname.startsWith('/u/')) loadAuthor(decodeURIComponent(location.pathname.slice(3)));
  } catch {
    say('网络异常，稍后再试', 'err');
  } finally {
    btn.disabled = false;
  }
}

// 「全部功能」：主页上放不下的入口都收在这里（不新造功能，全是已有入口的集合）
function openAuthorMoreSheet() {
  const unread = Number((state.user && state.user.unreadNotices) || 0);
  const nb = (state.blocked || []).length, ub = (state.blockedUsers || []).length;
  openAuthorActionSheet('全部功能', [
    { icon: 'bell', label: '站内消息', sub: unread ? `${unread} 条未读` : '审核、评论、灯火通知都在这', badge: unread ? (unread > 99 ? '99+' : String(unread)) : '', on: openNotices },
    { icon: 'gift', label: '兑换码领灯火', sub: '有兑换码就填在这里', on: openGiftCode },
    { icon: 'medal', label: '我的勋章', sub: '看看攒了几枚、还差什么', on: () => { location.href = '/medals.html'; } },
    { icon: 'share', label: '邀请收录', sub: '拉朋友来投稿，双方都有灯火', on: () => { location.href = '/invite'; } },
    { icon: 'chat', label: '造梦酒馆', sub: '散座闲聊、吧台提想法', on: () => navigate('/bar') },
    { icon: 'block', label: '屏蔽管理', sub: (nb || ub) ? `已隐藏 ${nb} 件作品${ub ? ` · 拉黑 ${ub} 位作者` : ''}` : '还没有屏蔽任何作品', on: () => openBlockedList(nb ? 'works' : (ub ? 'users' : 'works')) },
    { icon: 'gear', label: '账号设置', sub: '密码、绑定、消息提醒', on: () => navigate('/settings') },
    { icon: 'logout', label: '退出登录', sub: '本机登录状态会清掉', on: doLogout }
  ]);
}

// 「我的推荐」= 站长口中的「我的订单」：不在主页重造一份记录，直接落到 /promote 的「我的投放」区块
let promoFocusMine = false;
function goMyPromotions() {
  if (!state.user) { openAuth('login'); return; }
  promoFocusMine = true;
  navigate('/promote');
}

async function loadAuthor(name) {
  // URL 现在传的是账号 id 或作者自设的个性地址（老链接是账号名）：三种都认，认出「这是不是我自己的主页」
  const isMine = !!(state.user && (state.user.id === name || state.user.username === name || state.user.slug === name));
  // 先渲染再拉数据：自己的页面直接显示昵称，别先闪一下账号名
  const first = (isMine && state.user.nickname) || name;
  $('authorName').textContent = '@' + first;
  $('authorAvatar').textContent = first.slice(0, 1).toUpperCase();
  $('authorAvatar').style.background = avaColor('u:' + name);
  $('authorAvatar').style.color = '#fff';
  setTitle(`@${name} 的作品`);
  // 加载态（2026-11-12）：/u/ 是整页换数据——名字和头像先出来，作品、看板要等接口。
  // 两件事必须同时做：① 先把上一位作者留下的内容清干净（不清会闪一下别人作品、别人的工具行）；
  // ② 作品区放同款「点灯」，看板铺同结构的「–」占位撑住高度（不等高的话数据回来整块会往上跳）。
  const agEl = $('authorGallery');
  agEl.classList.remove('list-mode');
  agEl.innerHTML = dmLoadHtml('正在点亮作品…');
  $('authorStatGrid').innerHTML = authorStatSkeletonHtml();
  $('authorMeta').innerHTML = '';
  $('authorBadges').innerHTML = '';
  $('authorStats').hidden = true;
  $('authorJoin').style.display = 'none';
  $('authorTools').style.display = 'none';
  $('authorTools').innerHTML = '';
  $('authorNickBtn').style.display = 'none';
  $('authorDangerRow').style.display = 'none';
  // 「编辑主页」/ 功能图标行 / 三个 tab 都是本人专属：换到别人的主页先全部收起来（文案也别留着上一位的）
  $('authorEditBtn').style.display = 'none';
  $('authorActs').style.display = 'none';
  $('authorTabs').style.display = 'none';
  const tabBar = $('authorTabs');
  if (tabBar) tabBar.querySelectorAll('[data-autab]').forEach(b => b.classList.toggle('is-on', b.dataset.autab === 'works'));
  authorTabState.tab = 'works';
  authorTabState.works = [];
  authorTabState.favs = null;
  authorTabState.likes = null;
  authorTabState.req++;
  // 作品数据入口侧栏只在本人主页出现：换到别人的页面先收起来
  $('authorSide').style.display = 'none';
  try {
    const data = await (await fetch('/api/authors/' + encodeURIComponent(name))).json();
    // 地址栏矫正（2026-11-13）：站内 data-nav 跳进来的还是 /u/<账号id> 或老地址，服务端 301 够不着
    //（那只管整页加载）。接口认出作者后，把地址栏 replaceState 成 canonical（个性地址优先），不刷新页面。
    if (data.slug && name !== data.slug && location.pathname.startsWith('/u/')) {
      history.replaceState({}, '', '/u/' + encodeURIComponent(data.slug) + location.search);
    }
    // 有昵称就显示昵称（地址栏是 /u/id，链接不会失效）
    const shown = data.displayName || name;
    // 荣誉标签（含自动颁发的 GitHub 勋章）：名字旁挂胶囊
    $('authorName').innerHTML = '@' + escapeHtml(shown) +
      (Array.isArray(data.tags) ? data.tags.map(t => `<i class="author-tag${t === GH_BADGE_TAG ? ' gh' : ''}" title="${t === GH_BADGE_TAG ? 'GitHub 优质原创作者勋章' : '站点荣誉标签'}">${escapeHtml(t)}</i>`).join('') : '');
    // 头像：有图就盖上去，图挂了自动露出底下的首字母（不再留一块空白）
    paintAvatar($('authorAvatar'), shown, data.avatar);
    setTitle(`@${shown} 的作品`);
    // 自己的主页：名字旁显示「修改昵称」入口，页面底部放「注销账号」（低调、防误触）
    // 服务端回了 uid（id / 名字两种链接都认），双保险按它判
    const isMe = isMine || !!(state.user && data.uid && state.user.id === data.uid);
    // 2026-11-14：本人主页的「修改昵称 / 个性地址」两个胶囊撤掉——都收进右上角「编辑主页」那个弹层了。
    // 留着会和「编辑主页」重复，手机端三个入口还会挤成两行（名字行 flex-wrap）
    const nickBtn = $('authorNickBtn');
    nickBtn.style.display = 'none';
    if (isMe) nickBtn.onclick = openNickModal;
    const slugBtn = $('authorSlugBtn');
    if (slugBtn) {
      slugBtn.style.display = 'none';
      if (isMe) {
        const cur = state.user.slug;
        slugBtn.innerHTML = `<span class="ico">${ic('link')}</span> ${escapeHtml(cur ? '/u/' + cur : '个性地址')}`;
        slugBtn.onclick = openSlugModal;
      }
    }
    const dangerRow = $('authorDangerRow');
    dangerRow.style.display = isMe ? 'block' : 'none';
    if (isMe) $('authorDelBtn').onclick = openDelAcc;
    // 数据看板替换旧的一句话统计（句子版元素保留兜底，接口没给新字段时退回旧文案）
    const grid = $('authorStatGrid');
    if (grid && data.totalUv !== undefined) {
      grid.innerHTML = authorStatGridHtml(data);
      $('authorStats').hidden = true;
    } else {
      $('authorStats').hidden = false;
      $('authorStats').innerHTML = `作品 ${data.total} · 累计获赞 ${data.totalLikes} · 被收藏 ${data.totalFavs || 0}`;
    }
    $('authorMeta').innerHTML = authorMetaHtml(data);
    // 外部主页：访客和本人都看得到（关注不了作者，至少给个能追过去的地方）；没填就整行收起来
    const linksEl = $('authorLinks');
    if (linksEl) {
      const ls = Array.isArray(data.links) ? data.links : [];
      linksEl.innerHTML = authorLinksHtml(ls);
      linksEl.hidden = !ls.length;
    }
    $('authorBadges').innerHTML = authorBadgesHtml(data.badges);
    // 右栏（2026-11-13）：勋章墙从档案卡挪到右边，「作品数据」入口卡的下面。
    // 作品数据卡仅本人可见；勋章墙人人可见（点亮过才显示）。
    // 两张卡一张都没有时整个右栏收起来，别留一列空白
    const hasBadges = Array.isArray(data.badges) && data.badges.length > 0;
    $('creatorCard').style.display = isMe ? '' : 'none';
    $('authorMedalsCard').style.display = hasBadges ? '' : 'none';
    $('authorSide').style.display = (isMe || hasBadges) ? '' : 'none';
    // 别人的主页 + 作者绑定了账号：给「送灯火」直送入口（2026-11-13）。
    // 匿名作者（没绑账号）收不了直送，不显示——想支持就去作品详情页点「送灯火」，灯火记在作品上。
    const tipBtn = $('authorTipBtn');
    if (tipBtn) {
      const canTip = !isMe && !!data.uid;
      tipBtn.style.display = canTip ? 'inline-flex' : 'none';
      if (canTip) tipBtn.onclick = () => {
        if (!state.user) { openAuth('login'); return; }
        if (typeof openAuthorTipPanelHook === 'function') openAuthorTipPanelHook(data.uid, shown);
      };
    }
    // 自己的主页（2026-11-14 改版）：「编辑主页」+ 一行四个功能入口 + 作品/收藏/喜欢三个 tab。
    // 旧的「我的点赞 / 屏蔽管理」胶囊行撤掉——点赞变成 tab，屏蔽管理收进「全部功能」，主页更干净
    const toolsEl = $('authorTools');
    toolsEl.style.display = 'none';
    toolsEl.innerHTML = '';
    bindAuthorOwnerTools(isMe);
    // 作品数据入口卡（右栏，仅本人的卡）：一键打开「作品数据」面板（浏览/点赞/收藏/评论 + 近 7 天趋势）。
    // 右栏整体显隐与勋章墙一起在上方统一处理，这里只绑事件
    $('ccEnterBtn').onclick = () => openStats('data');
    // 作品流：三个 tab 共用 #authorGallery，数据先备好（收藏/点赞按需拉，切过去才请求）
    authorTabState.works = Array.isArray(data.works) ? data.works : [];
    authorTabState.favs = null;
    authorTabState.likes = null;
    if (isMe) setAuthorTab('works');
    else {
      $('authorGallery').innerHTML = authorTabState.works.map(w => cardHtml(w)).join('') ||
        '<div class="empty" style="grid-column:1/-1"><p>这位作者还没有作品</p></div>';
      bindCards($('authorGallery'));
    }
    // 入驻引导：只给「还没入驻的访客」看（本人和已登录作者都不需要被推销）
    const joinEl = $('authorJoin');
    if (joinEl) {
      joinEl.style.display = isMe || state.user ? 'none' : '';
      if (!isMe && !state.user) {
        // 与右上角「＋ 提交作品」同一条打开链路（含草稿恢复），注册引导在弹窗里完成
        $('authorJoinBtn').onclick = () => $('openUpload').click();
      }
    }
  } catch {
    // 失败也要把加载态收干净：占位的「–」留着会让人以为这位作者数据全是空的
    $('authorStatGrid').innerHTML = '';
    $('authorGallery').innerHTML = '<div class="empty" style="grid-column:1/-1"><p>作者不存在</p></div>';
  }
}

// ---------- 榜单 ----------
// H5 榜单页：真正的「榜」——按周期（周榜/月榜/总榜）+ 维度（综合/点赞/收藏/灯火/访客）排名，
// 数据走专用接口 /api/rank（与 PC 排行榜同一套后端），形态作次级筛选。
// 不再是首页换皮：首页是「浏览」（形态/分类/时间/最新），榜单是「排名」（周期+维度）。
// 默认高光榜：老作品的最好一周永久留档，新作品发布当天也能参与（窗口不足 7 天按实际天数算），
// 榜单常驻有内容；2026-11-08 起「本周热榜」下线（与新作周榜高度重叠，且对老作品不友好），后端代码保留、旧链接仍可用。
const rankH5 = { type: '全部', period: 'peak', by: 'hot' };
let rankPage = 1;
let rankHasMore = false;
// 周期：周榜=近 7 天上架 / 月榜=近 30 天 / 总榜=全部作品 / 高光=历史最佳 7 天
// （weekhot 不再提供选项，但保留在 URL 白名单里，老分享链接 /rank?period=weekhot 仍能打开）
const RANK_PERIODS = [
  { value: 'peak', label: '高光' },
  { value: 'week', label: '周榜' },
  { value: 'month', label: '月榜' },
  { value: 'all', label: '总榜' }
];
// 排序维度：与 PC 排行榜的 by 一一对应（hot/likes/favs/tips/uv）。
// 胶囊文案**不带「榜」字**（2026-11-13 站长要求）：五个两字词在 375 宽的手机上一行放得下；
// 带「榜」字时多出 10 个字宽，最后一个「访客榜」被挤出屏幕、整行要横滑，行高也被撑起来。
// hint 是选这个维度后显示在胶囊下方的计分说明（与小程序榜单页同款文案）
const RANK_BYS = [
  { value: 'hot', label: '综合', hint: '获赞×5 ＋ 收藏×8 ＋ 评论×3 ＋ 灯火人数×10 ＋ 访客×2（访客按人去重，一个人只算一次）' },
  { value: 'likes', label: '点赞', hint: '按点赞数排序，同一人重复点赞只算一次' },
  { value: 'favs', label: '收藏', hint: '按收藏数排序，收藏需要登录账号' },
  { value: 'tips', label: '灯火', hint: '按送过灯火的人数排序：同一人多笔只算 1 人，人数打平比灯火总额' },
  { value: 'uv', label: '访客', hint: '按访客人数排序，一个人只算一位；网页 / 小程序 / App 同一套认人规则' }
];
// 当前行右侧的分数文案（与小程序榜单页同口径）：综合=热度，其余=人数口径；高光榜=高光分
function rankMetricText(by, w) {
  if (by === 'likes') return (w.likes || 0) + ' 人点赞';
  if (by === 'favs') return (w.favs || 0) + ' 人收藏';
  if (by === 'tips') return (w.tipsTippers || 0) + ' 人点亮';
  if (by === 'uv') return (w.uv || 0) + ' 人访问';
  if (rankH5.period === 'peak') return '高光 ' + (w.hotScore || 0);
  return '热度 ' + (w.hotScore || 0);
}

// ---------- 榜单页动态条 ----------
// 榜单页顶部的一行动态数字。口径＝近 7 天（今天 + 前 6 天，自然日），和周榜对齐，
// 也避免「今天 0 件新作品」把整行显示得冷冷清清；文案直接写「近 7 天」，
// 别写「本周」——那是自然周（周一起算）的读法，会和实际数字对不上。
// 老接口没有 week 字段时退回今日口径。
let rankTodayData = null;
let rankTodayFetchedAt = 0;
function renderRankToday() {
  const box = $('rankToday');
  if (!box) return;
  const d = rankTodayData;
  if (!d) { box.innerHTML = ''; return; } // 接口没回来/失败时整条不显示，容器靠 :empty 自动收起
  const w = d.week || null;
  const wk = w || d;
  const bits = [];
  if (wk.works) bits.push(`<b>${Number(wk.works) || 0}</b> 件新作品上架`);
  if (wk.tips) bits.push(`<b>${Number(wk.tips) || 0}</b> 盏灯火被点亮`);
  if (wk.comments) bits.push(`<b>${Number(wk.comments) || 0}</b> 条新评论`);
  if (wk.visitors) bits.push(`<b>${Number(wk.visitors) || 0}</b> 位朋友来逛过`);
  // 小程序同款：素净的一行灰字（计分口径说明在维度胶囊下方的 rk-hint，不挤这里）。
  // 右侧缀一句态度文案：榜单不是编辑挑的，是访客用访问和灯火投出来的（手机端换行铺满一行）
  const motto = `<span class="rank-today-motto">✦ 谁的作品最闪，由大家的每一次到访和每一份喜欢说了算</span>`;
  box.innerHTML = bits.length ? `${w ? '近 7 天' : '今日'} ${bits.join(' · ')}${motto}` : motto;
}

async function loadRankToday() {
  // 切换周期/排序会反复调 loadRank，今日数字 1 分钟取一次就够
  if (Date.now() - rankTodayFetchedAt < 60000) return;
  rankTodayFetchedAt = Date.now();
  try {
    const d = await (await fetch('/api/today')).json();
    rankTodayData = d;
    renderRankToday();
  } catch { /* 点缀信息，拉不到就不显示，不影响榜单 */ }
}

// 榜单筛选栏（参考小程序榜单页）：周期分段器 + 维度胶囊行 + 计分说明。
// 形态筛选不再放到 H5 榜单页（小程序同款没有；/api/rank 的 type 参数仍支持，URL 带参可分享）
function renderRankFilterBarH5() {
  // 周期分段器（周榜/月榜/总榜）：胶囊容器里三段平分，选中项白底浮起
  const periodRow = $('rankPeriodRow');
  if (periodRow) {
    periodRow.innerHTML = RANK_PERIODS.map(p =>
      `<button type="button" class="rk-seg-item${rankH5.period === p.value ? ' on' : ''}" data-period="${p.value}">${p.label}</button>`
    ).join('');
    periodRow.onclick = e => {
      const b = e.target.closest('.rk-seg-item');
      if (!b || rankH5.period === b.dataset.period) return;
      rankH5.period = b.dataset.period;
      renderRankFilterBarH5();
      renderRankToday();
      loadRankListH5(true);
    };
  }
  // 维度胶囊行（综合/点赞/收藏/灯火/访客），下方一行计分说明跟着选中维度变
  const byRow = $('rankByRow');
  if (byRow) {
    byRow.innerHTML = RANK_BYS.map(b =>
      `<button type="button" class="rk-dim${rankH5.by === b.value ? ' on' : ''}" data-by="${b.value}">${b.label}</button>`
    ).join('');
    byRow.onclick = e => {
      const b = e.target.closest('.rk-dim');
      if (!b || rankH5.by === b.dataset.by) return;
      rankH5.by = b.dataset.by;
      renderRankFilterBarH5();
      loadRankListH5(true);
    };
    // 维度胶囊较多时右边缘渐隐提示可横滑（不溢出则不显示，末项完整）
    requestAnimationFrame(() => {
      byRow.classList.toggle('can-scroll', byRow.scrollWidth > byRow.clientWidth + 1);
    });
  }
  const hintLine = $('rankHintLine');
  if (hintLine) {
    // 计分说明跟着「排序 + 周期」走（与 PC 图例同文案）
    hintLine.textContent = byLegend(rankH5.by, rankH5.period);
  }
}

// 进入榜单/切换筛选：回到第 1 页重新拉
async function loadRankH5() {
  renderRankFilterBarH5();
  renderRankToday();   // 口径提示跟着筛选栏即时变
  loadRankToday();     // 今日数字内部有 1 分钟缓存，不会重复请求
  await loadRankListH5(true);
}

// 排名列表行（参考小程序榜单页）：名次 + 封面 + 标题/作者/标签 + 右侧分数与时间
// 高光区间文本：起始日期一律带年份（2026-10-31~11-06），跨年时结束日期也带年份
function peakRangeTxt(from, to) {
  const f = String(from || '');
  const t = String(to || '');
  if (!f) return t;
  if (!t) return f;
  return f + '~' + (f.slice(0, 4) === t.slice(0, 4) ? t.slice(5) : t);
}

function rankRowHtml(w, i) {
  const top = i < 3 ? ' top' + (i + 1) : '';   // 前三名金银铜
  // 三行结构（2026-11-12 用户反馈）：第一行名字，第二行一句话简介（小一号浅灰，和名字区分开），
  // 第三行作者 · 形态 + 分类胶囊。拆分口径与首页卡片一致（cardTitleLines）。
  const [rkName, rkIntro] = cardTitleLines(w);
  const cover = w.thumb
    ? `<img class="rk-cover" src="${imgUrl(w.thumb, 400)}" srcset="${imgSet(w.thumb)}" sizes="(max-width: 640px) 30vw, 96px" alt="${escapeHtml(w.title)}" loading="lazy" />`
    : `<div class="rk-cover rk-cover-empty">${escapeHtml((w.title || '?').slice(0, 1))}</div>`;
  const isNew = w.isNew ? '<span class="rk-new">NEW</span>' : '';
  // 高光榜：首次进榜 7 天内的作品标「新晋」，右侧副行换成高光区间（哪几天、用了几天）
  const entry = w.isNewEntry && rankH5.period === 'peak' ? '<span class="rk-new">新晋</span>' : '';
  const feat = w.featured ? '<span class="rk-tag">精选</span>' : '';
  // 高光榜副行：区间 + 天数分两行（窄屏 10px 下「高光 2026-10-28~11-03 · 7 天」会把标题挤没）
  const sub = rankH5.period === 'peak' && w.peakFrom
    ? `<span class="rk-date">${peakRangeTxt(w.peakFrom, w.peakTo)}</span><span class="rk-days">${w.peakDays} 天</span>`
    : formatDate(w.createdAt);
  return `
    <div class="rk-row" data-id="${w.id}">
      <span class="rk-num${top}">${i + 1}</span>
      ${cover}
      <div class="rk-main">
        <div class="rk-title-line"><span class="rk-title">${escapeHtml(rkName)}</span>${isNew}${entry}</div>
        ${rkIntro ? `<div class="rk-intro">${escapeHtml(rkIntro)}</div>` : ''}
        <div class="rk-meta-line"><span class="rk-sub">${escapeHtml(w.authorName || '匿名')} · ${escapeHtml(w.type || '')}</span><span class="rk-tags"><span class="rk-tag">${escapeHtml(w.category)}</span>${feat}</span></div>
      </div>
      <div class="rk-metric">
        <span class="rk-metric-text">${rankMetricText(rankH5.by, w)}</span>
        <span class="rk-metric-sub">${sub}</span>
      </div>
    </div>`;
}

// 榜单列表：走专用排名接口 /api/rank（与 PC 排行榜同一套后端），按周期+维度排序
async function loadRankListH5(reset) {
  const box = $('rankListH5');
  if (!box) return;
  const tParam = rankH5.type !== '全部' ? `&type=${encodeURIComponent(rankH5.type)}` : '';
  try {
    // /api/rank 不支持翻页（一次性返回 limit 条），榜单取前 100 直接渲染，无「加载更多」
    const url = `/api/rank?period=${rankH5.period}&by=${rankH5.by}&limit=100${tParam}`;
    const list = await (await fetch(url)).json();
    box.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>'
        + (rankH5.period === 'peak'
          ? '高光榜还在攒数据：作品最亮的 7 天里访客满 10 人、有真实互动（赞/藏/评/灯火）才会留档，先看看别的榜？'
          : '这个榜单还没有作品，换个周期或筛选试试？')
        + '</p></div>';
    } else {
      box.innerHTML = list.map((w, i) => rankRowHtml(w, i)).join('');
      bindCards(box);
    }
    const more = $('rankMoreH5');
    if (more) more.style.display = 'none';
  } catch {
    showToast('榜单加载失败', undefined, 'err');
  }
}

// ---------- 榜单（PC）----------
// PC 保持原来的综合分排行榜：形态 / 周期 / 排序维度 / 数量 四个下拉 + 排行榜行。
// H5 移动端走上面那套小程序橱窗同款筛选栏（loadRankH5），两套互不影响，共用「今日动态」。
const rankState = { period: 'peak', by: 'hot', limit: 20, type: '全部', cat: '全部' };
// PC 排序下拉按钮上显示的是「排序：xxx」，不再带「按」字，避免「排序 按访问次数」读着别扭
const BY_SHORT = { hot: '综合', likes: '点赞', favs: '收藏', tips: '打赏人数', pv: '访问次数', uv: '访问人数' };
// 榜单行右侧（窄屏）只显示当前维度的一个大数字，label 跟着排序走
const BY_SCORE_LABEL = { hot: '热度', likes: '获赞', favs: '收藏', tips: '灯火', pv: '访问', uv: '访客' };
// 图例一句话说明跟着排序走：选什么排序，下面就解释什么
const BY_LEGEND = {
  hot: '综合分 = 获赞×5 + 收藏×8 + 评论×3 + 灯火人数×10 + 访客人数×2',
  likes: '按累计获赞数排序：作品上架以来收到的点赞，同一身份只计 1 次',
  favs: '按累计被收藏数排序：作品上架以来被收藏的次数',
  tips: '按送过灯火的人数排序：同一人多笔只算 1 人，人数打平比灯火总额；送灯火 = 为作品投票，每位送过的朋友折 10 分进综合分',
  pv: '按访问次数排序：所选周期内详情页被打开的次数，同一个人反复打开也会累加；访问次数只做展示，计分用的是访客人数',
  uv: '按访客人数排序：所选周期内有多少人打开过详情页，一个人只算 1 个；综合分里的访客分就是它 ×2（网页 / 小程序 / App 同一套认人规则）'
};
// weekhot 已下线不再出现在选项里，但 SHORT/HINT/byLegend 三处保留映射：
// 老分享链接 /rank?period=weekhot 打开时，标签和图例仍能正常显示而不是显示 undefined
const PERIOD_SHORT = { weekhot: '本周热榜', week: '新作周榜', month: '新作月榜', all: '总榜', peak: '高光榜' };
const PERIOD_HINT = {
  weekhot: '本周热榜 · 近 7 天有互动的作品，老作品也能上榜',
  week: '新作周榜 · 近 7 天上架',
  month: '新作月榜 · 近 30 天上架',
  all: '总榜 · 全部作品',
  peak: '高光榜 · 每件作品最亮的 7 天，高光时刻永久留档'
};
// 图例一句话说明跟着「排序 + 周期」走（weekhot 分支仅剩旧链接会用到）
function byLegend(by, period) {
  if (period === 'weekhot') {
    if (by === 'hot') return '本周热度 = 本周获赞×5 + 本周收藏×8 + 本周评论×3 + 本周灯火人数×10 + 本周访客×2';
    if (by === 'likes') return '按本周新增获赞排序（点赞时间戳自 2026-11-07 起记录，之前的赞不参与）';
    if (by === 'favs') return '按本周新增被收藏数排序';
    if (by === 'tips') return '按本周送过灯火的人数排序：同一人多笔只算 1 人，人数打平比灯火总额';
  }
  if (period === 'peak') {
    if (by === 'hot') return '高光分 = 窗口获赞×5 + 收藏×8 + 评论×3 + 灯火人数×10 + 窗口访客×2，取上架以来最亮的连续 7 天';
    if (by === 'likes') return '按最佳窗口内的获赞数排序（不足 7 天按实际天数算）';
    if (by === 'favs') return '按最佳窗口内的被收藏数排序';
    if (by === 'tips') return '按最佳窗口内送过灯火的人数排序：同一人多笔只算 1 人，人数打平比灯火总额';
    if (by === 'pv') return '按最佳窗口内的访问次数排序';
    if (by === 'uv') return '按最佳窗口内的独立访客数排序，同一人只算 1 个';
  }
  return BY_LEGEND[by] || BY_LEGEND.hot;
}

// 榜单「形态」下拉：与首页形态下拉同一套数据（TYPES / typeCounts），
// 只列有作品的形态，已选中的即使为 0 也保留，避免下拉里找不到自己选的那项。
// 条数口径跟「周期」走：周榜显示的是近 7 天上架的作品数，不是全站总量
// （数据来自 /api/rank/counts，按周期缓存；没回来前先退回全站数，回来后重绘补上）。
const rankCountsCache = {};   // period -> { total, counts }
async function loadRankTypeCounts() {
  const p = rankState.period;
  if (rankCountsCache[p]) return;
  try {
    rankCountsCache[p] = await (await fetch('/api/rank/counts?period=' + p)).json();
    renderRankTypePanel();   // 条数按周期修正后重绘一次（勾选态不变）
    renderRankCatPanel();    // 分类下拉同一次返回里带 cats，一起补数字
  } catch { /* 拉不到就沿用全站数，不影响筛选 */ }
}
function renderRankTypePanel() {
  const panel = $('rankTypePanel');
  if (!panel) return;
  const pc = rankCountsCache[rankState.period];
  // 候选形态：周期计数（pc）回来后按它过滤，0 条的形态不再展示
  // （避免周榜里出现「Linux 0」这种选项）；计数没回来时退回全站口径。
  // 已选中的形态即使 0 也保留，避免下拉里找不到自己选的那项。
  const cntOf = t => pc ? (pc.counts[t] || 0) : (typeCounts[t] || 0);
  const opts = (totalWorks > 0 || pc)
    ? TYPES.filter(t => t === '全部' || cntOf(t) > 0 || t === rankState.type)
    : TYPES;
  panel.innerHTML = opts.map(t => {
    const n = t === '全部'
      ? (pc ? pc.total : totalWorks)
      : cntOf(t);
    const icon = t !== '全部' ? typeIcoHtml(t) + ' ' : '';
    return `
    <button type="button" class="dd-opt${t === rankState.type ? ' active' : ''}" data-type="${escapeHtml(t)}">
      <span class="dd-opt-label">${icon}${escapeHtml(t === '全部' ? '全部形态' : t)}</span>
      <span class="dd-count">${n}</span>
    </button>`;
  }).join('');
  const val = $('rankTypeValue');
  if (val) {
    val.innerHTML = rankState.type === '全部'
      ? '全部形态'
      : `${typeIcoHtml(rankState.type)} ${escapeHtml(rankState.type)}`;
  }
  const btn = $('rankTypeBtn');
  if (btn) btn.classList.toggle('has-value', rankState.type !== '全部');
}

// 榜单「分类」下拉：选项来自 /api/categories（与首页分类下拉同一份），
// 数字口径跟「形态」一样按当前周期走（/api/rank/counts 的 cats 字段）；
// 作品可同时属于 1-3 个分类，命中任意一个即算（与 /api/rank?category= 的服务端口径一致）。
// 只列本周期有作品的分类：0 条的选项点进去是空榜，纯属噪音；已选中的即使为 0 也保留。
function renderRankCatPanel() {
  const panel = $('rankCatPanel');
  if (!panel) return;
  const pc = rankCountsCache[rankState.period];
  const periodCats = pc && pc.cats;
  const cntOf = c => periodCats ? (periodCats[c] || 0) : (catCounts[c] || 0);
  const opts = (totalWorks > 0 || periodCats)
    ? CATEGORIES.filter(c => c === '全部' || cntOf(c) > 0 || c === rankState.cat)
    : CATEGORIES;
  panel.innerHTML = opts.map(c => {
    const n = c === '全部' ? (pc ? pc.total : totalWorks) : cntOf(c);
    return `
    <button type="button" class="dd-opt${c === rankState.cat ? ' active' : ''}" data-cat="${escapeHtml(c)}">
      <span class="dd-opt-label">${escapeHtml(c === '全部' ? '全部分类' : c)}</span>
      <span class="dd-count">${n}</span>
    </button>`;
  }).join('');
  const val = $('rankCatValue');
  if (val) val.textContent = rankState.cat === '全部' ? '全部分类' : rankState.cat;
  const btn = $('rankCatBtn');
  if (btn) btn.classList.toggle('has-value', rankState.cat !== '全部');
}

// 排行榜行里的分类文案：一件作品可属 1-3 个分类，全写出来。
// 只写主分类会有个坑——按「效率工具」筛选后，主分类是「开发工具」的作品也上榜，
// 行里却看不到「效率工具」，看着像筛错了
function rankCatsText(w) {
  const arr = Array.isArray(w.categories) && w.categories.length ? w.categories : (w.category ? [w.category] : []);
  return arr.join(' / ');
}

async function loadRank(period, by, limit, type, cat) {
  if (period) rankState.period = period;
  if (by) rankState.by = by;
  if (limit) rankState.limit = limit;
  if (type) rankState.type = type;
  if (cat) rankState.cat = cat;
  // 周期/排序/数量都已收进下拉胶囊：同步面板勾选态与按钮上的当前值
  document.querySelectorAll('#rankPeriodPanel .dd-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.period === rankState.period));
  const periodVal = $('rankPeriodValue');
  if (periodVal) periodVal.textContent = PERIOD_SHORT[rankState.period] || rankState.period;
  document.querySelectorAll('#rankByPanel .dd-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.by === rankState.by));
  const byVal = $('rankByValue');
  if (byVal) byVal.textContent = BY_SHORT[rankState.by] || rankState.by;
  const legendText = $('rankLegendText');
  if (legendText) legendText.textContent = byLegend(rankState.by, rankState.period);
  document.querySelectorAll('#rankLimitPanel .dd-opt').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.limit) === rankState.limit));
  const limitVal = $('rankLimitValue');
  if (limitVal) limitVal.textContent = rankState.limit + ' 条';
  renderRankTypePanel();   // 形态下拉的勾选态与按钮当前值跟着变
  renderRankCatPanel();    // 分类下拉同理
  loadRankTypeCounts();    // 条数按当前周期修正（有缓存，切回来不用再请求）
  renderRankToday();   // 周期口径提示跟着下拉即时变
  loadRankToday();     // 今日数字内部有 1 分钟缓存，不会重复请求
  try {
    const tParam = rankState.type !== '全部' ? `&type=${encodeURIComponent(rankState.type)}` : '';
    const cParam = rankState.cat !== '全部' ? `&category=${encodeURIComponent(rankState.cat)}` : '';
    const list = await (await fetch(`/api/rank?period=${rankState.period}&by=${rankState.by}&limit=${rankState.limit}${tParam}${cParam}`)).json();
    const cur = rankState.by;
    // 窄屏行尾的大分数：只展示当前排序维度的那一个值（宽屏隐藏，改显示整排指标）
    const scoreOf = w => cur === 'hot' ? (w.hotScore || 0)
      : cur === 'likes' ? (w.likes || 0)
      : cur === 'favs' ? (w.favs || 0)
      : cur === 'tips' ? (w.tipsTippers || 0)
      : cur === 'pv' ? (w.pv || 0) : (w.uv || 0);
    const scoreLabel = cur === 'hot' && rankState.period === 'peak' ? '高光' : (BY_SCORE_LABEL[cur] || '热度');
    $('rankList').innerHTML = list.length ? list.map(w => {
      // 与 H5 榜单行同口径：第一行名字，第二行一句话简介（小一号浅灰），第三行 meta 不动
      const [rkName, rkIntro] = cardTitleLines(w);
      return `
      <div class="rank-item" data-id="${w.id}">
        <div class="rank-no rank-no-${w.rank <= 3 ? w.rank : 'n'}">${w.rank}</div>
        <img src="${imgUrl(w.thumb, 400)}" alt="" loading="lazy" />
        <div class="rank-main">
          <div class="rank-title">${escapeHtml(rkName)}${w.isNew ? '<span class="rank-fresh" title="今天刚上架的作品">今日上新</span>' : ''}${w.isNewEntry && rankState.period === 'peak' ? '<span class="rank-fresh" title="首次进入高光榜前 20，7 天内显示">新晋</span>' : ''}</div>
          ${rkIntro ? `<div class="rank-intro">${escapeHtml(rkIntro)}</div>` : ''}
          <div class="rank-meta">${escapeHtml(typeText(w))} · ${escapeHtml(aname(w))} · ${escapeHtml(rankCatsText(w))}${rankState.period === 'peak' && w.peakFrom ? ` · <span title="这件作品最亮的 7 天">高光 ${peakRangeTxt(w.peakFrom, w.peakTo)} · ${w.peakDays} 天</span>` : ''}</div>
        </div>
        <div class="rank-score">
          <span class="${cur === 'likes' ? 'on' : ''}" title="获赞数">${ic('heart')} ${w.likes || 0}</span>
          <span class="${cur === 'favs' ? 'on' : ''}" title="被收藏数">${ic('star')} ${w.favs || 0}</span>
          ${w.commentCount ? `<span title="评论与提问数">${ic('chat')} ${w.commentCount}</span>` : ''}
          <span class="${cur === 'tips' ? 'on' : ''}" title="打赏人数：累计有多少个不同用户送过灯火，同一人多笔只算 1 人${cur === 'tips' ? '（排序依据）' : ''}">${ic('lamp')} ${w.tipsTippers || 0}</span>
          ${cur === 'hot' ? `<span class="on" title="综合分 = 获赞×5 + 收藏×8 + 评论×3 + 灯火人数×10 + 访客人数×2；灯火按送过的人数算，同一人送多笔只算 1 人；访客按人去重——登录按账号、小程序按设备、网页和 App 按本机标识，一个人只算 1 个，反复刷新不加分，系数 2 是各项最低的（点开看一眼比点赞、收藏轻得多）；同一身份只能赞一次，匿名评论不计分">${ic('bolt')} ${w.hotScore || 0}</span>` : ''}
          <span class="${cur === 'pv' ? 'on' : ''}" title="访问次数：本周期详情页被打开的次数，同一个人反复打开也会累加（排序依据）">${ic('bars')} ${w.pv || 0}</span>
          <span class="${cur === 'uv' ? 'on' : ''}" title="访问人数：本周期有多少人打开过这件作品的详情页，同一个人只算 1 个（排序依据）">${ic('person')} ${w.uv || 0}</span>
        </div>
        <div class="rank-score-m" title="${escapeHtml(byLegend(cur, rankState.period))}"><span>${scoreLabel}</span><b>${scoreOf(w)}</b></div>
        <button class="rank-share" data-share-work="${w.id}" title="分享：生成带二维码的分享图，发朋友圈/小红书都行">${ic('sharecard')}<span>分享</span></button>
      </div>`;
    }).join('') : `<div class="empty"><p>${rankState.cat !== '全部'
        ? `「${escapeHtml(rankState.cat)}」这个周期内还没有作品上榜，换个分类、周期或形态看看`
        : rankState.period === 'peak'
          ? '高光榜还在攒数据：作品最亮的 7 天里访客满 10 人、有真实互动才会留档'
          : '暂无上榜作品'}</p></div>`;
    // PC 榜单不是走 bindCards 的（每行自己接点击），渐显要在这里单独挂一次
    revealCards($('rankList'));
    $('rankList').querySelectorAll('.rank-item').forEach(el =>
      el.addEventListener('click', () => openWork(el.dataset.id)));
    $('rankList').querySelectorAll('[data-share-work]').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        shareWorkDirect(btn.dataset.shareWork);
      }));
  } catch { showToast('榜单加载失败', undefined, 'err'); }
}

// 分端入口：H5 走橱窗式列表，PC 走综合分排行榜
function loadRankView() {
  if (isH5View()) return loadRankH5();
  return loadRank();
}

// ---------- 作品详情 ----------
// 用灯火解锁作品（送灯火才能体验）：扣自己的灯火，全额转给作者，然后重新拉一次详情把入口换出来。
// 重新渲染走 openWork 但 noTrack——解锁不是一次新访问，不能把作者的 PV 刷高。
async function unlockWorkByLamp(w) {
  if (!state.user) { openAuth('login'); return; }
  const price = Number(w.lampPrice) || 0;
  const bal = Number(state.user.points || 0);
  if (bal < price) {
    showToast(`灯火不够：还差 ${price - bal} 盏。签到、分享作品、上传作品都能攒灯火`, 4000, 'err');
    return;
  }
  if (!confirm(`用 ${price} 盏灯火解锁「${w.title}」？\n\n解锁后网页 / 下载 / 小程序入口全部可见，永久有效；灯火全额转给作者，站方不抽成。`)) return;
  const btn = $('lampUnlockBtn');
  if (btn) { btn.disabled = true; btn.textContent = '解锁中...'; }
  try {
    const r = await fetch('/api/works/' + encodeURIComponent(w.id) + '/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showToast(d.error || '解锁失败，稍后再试', 4000, 'err');
      if (btn) { btn.disabled = false; btn.textContent = `用 ${price} 盏解锁`; }
      return;
    }
    if (typeof d.points === 'number') refreshPointsUI(d.points);
    showToast(d.already ? '你之前已经解锁过这件作品了' : '解锁成功，入口已打开');
    await openWork(w.id, false, { noTrack: true });
  } catch {
    showToast('网络异常，稍后再试', 3000, 'err');
    if (btn) { btn.disabled = false; btn.textContent = `用 ${price} 盏解锁`; }
  }
}

// 双击同一张卡 / 快速连点两张卡时 openWork 会被连发两次：
// ① 两次 fetch 竞态，后完成者覆盖先完成者——弹窗里显示的不是先点的那件（「错号」）；
// ② 两条 /w/xxx 历史被压进栈，关掉一次弹窗 history.back() 又落回另一条记录，
//    route() 里再 openWork 一次，看起来就是「关掉后先弹另一个详情页」，要关两次；
// ③ 这一关一弹之间滚动锁反复加解锁，最后回列表滚动位置就丢成回到顶部。
// 「一眼看懂」：五件套拆两处渲染（2026-11-13）
// 定位句 → 标题下的副标题（一行字不值得套一张描边卡）；其余四件 → 详情页的速览卡。
// 内容口径与 seo.js 的 quickLookHtml 一致（服务端那份给爬虫看，改一处记得改另一处）。
function quickLookParts(w) {
  return {
    pos: String(w.positioning || '').trim(),
    rows: [
      ['解决什么', w.problem],
      ['适合谁', w.audience],
      ['和同类比', w.diff]
    ].filter(r => String(r[1] || '').trim()),
    steps: (Array.isArray(w.steps) ? w.steps : []).filter(s => String(s || '').trim())
  };
}
function renderQuickLook(w) {
  const lead = $('detailLead');
  const box = $('detailQuick');
  const { pos, rows, steps } = quickLookParts(w);
  // 定位句和「标题里那句简介」占的是同一个位置（都是「一句话说这是什么」）：
  // 标题带了简介 → 定位句退回速览卡第一行，不再在标题下叠一行；
  // 标题没有简介 → 定位句补位当副标题，卡片里就不重复它。同一件事只说一遍。
  const hasTitleTag = !!String(detailTitleParts(w)[1] || '').trim();
  const leadText = hasTitleTag ? '' : pos;
  if (lead) {
    lead.textContent = leadText;
    lead.style.display = leadText ? '' : 'none';
  }
  if (hasTitleTag && pos) rows.unshift(['它是什么', pos]);
  if (!box) return;
  if (!rows.length && !steps.length) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  const dl = rows.length
    ? `<dl class="ql-dl">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`
    : '';
  const ol = steps.length
    ? `<div class="ql-steps"><span class="ql-steps-title">上手${steps.length === 3 ? '三' : ''}步</span>
        <ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol></div>`
    : '';
  box.innerHTML = `<div class="ql-head"><span class="ql-badge"><span class="ico">${ic('search')}</span> 一眼看懂</span></div>${dl}${ol}`;
  box.style.display = '';
}

// ---------- 众人小法官（疑似推广众判） ----------
// 票数、门槛、资格全部由服务端算好（w.jury），前端只负责文案与按钮态。
// 千万别在前端另写一份门槛 / 注册时长判断，否则改后端参数时两边会漂移。
function paintJury(w) {
  const box = $('detailJury');
  if (!box) return;
  const j = w.jury || {};
  const sus = Number(j.sus) || 0;
  const okN = Number(j.ok) || 0;
  // gap = 下架门槛（净差几票），lead = 当前净差（服务端已把负数按 0 夹住）；都别在前端另算
  const gap = Number(j.gap) || 5;
  const lead = Number.isFinite(Number(j.lead)) ? Number(j.lead) : Math.max(0, sus - okN);
  const signed = sus - okN;   // 带符号的净差，只用来选文案（领先 / 持平 / 落后）
  const removed = j.removed === true;
  const mine = j.mine || '';
  // 有票 / 自己投过 / 已被判下架时自动展开；完全没人碰过就折叠成一行，不打扰看作品
  const open = sus > 0 || okN > 0 || !!mine || removed;
  box.style.display = '';
  box.classList.toggle('is-open', open);
  box.classList.toggle('is-removed', removed);

  const tag = $('juryTag');
  // 「疑似推广」这顶帽子只在认定票占多数时才戴（和卡片角标同一个 jury.card 口径）：
  // 有人投了一两票但反对票更多时，页面只报票数，不给作品定性
  if (tag) tag.style.display = (j.card || removed) ? '' : 'none';
  const openBtn = $('juryOpen');
  if (openBtn) openBtn.style.display = open ? 'none' : '';

  const gauge = $('juryGaugeFill');
  // 进度条量的是「净差离下架还有多远」，不是认定票总数：5:5 是 0%，8:3 是 100%
  if (gauge) gauge.style.width = Math.min(100, Math.round(lead / gap * 100)) + '%';

  const count = $('juryCount');
  if (count) {
    const rest = gap - lead;
    const leadLine = signed > 0
      ? (rest > 0 ? `净差 <b>${signed}</b> 票，再领先 <b>${rest}</b> 票即下架整改` : `净差 <b>${signed}</b> 票，已达下架门槛`)
      : signed === 0
        ? `票数持平，净差满 <b>${gap}</b> 票即下架整改`
        : `暂时落后 <b>${-signed}</b> 票（净差满 ${gap} 票才下架整改）`;
    count.innerHTML = removed
      ? `已由众判下架（<b>${sus}</b> 票认定 / ${okN} 票认为不像推广，净差 ${signed} 票）。作者按规范整改后重新提交，审核通过即可恢复。`
      : (sus || okN)
        ? `<b>${sus}</b> 人认为疑似推广 · <span class="jury-ok-num">${okN}</span> 人认为不像推广<span class="jury-need">${leadLine}</span>`
        : `疑似广告、刷量或硬推广？交给大家一起看。「像推广」的票比「不像推广」多 ${gap} 票，作品下架待整改。`;
  }

  const note = $('juryNote');
  const own = w.owned === true;
  let tip = '';
  if (removed) tip = '';
  else if (own) tip = '这是你的作品，不能给自己投票；有异议可在作品页底部「意见建议」申诉。';
  else if (!state.user) tip = '登录后才能投票：一个账号一票，可以改票，投票永久保密。';
  else if (j.why === 'fresh') tip = `账号注册满 ${j.minAgeH || 24} 小时后才能参与众判（防小号刷票）。`;
  else tip = '一个账号一票，可以改票；投票永久保密——对外只统计票数，不公开谁投的。';
  if (note) { note.textContent = tip; note.style.display = tip ? '' : 'none'; }

  box.querySelectorAll('.jury-btn').forEach(b => {
    const v = b.dataset.jury;
    b.classList.toggle('active', mine === v);
    // 未登录不禁用：点一下引导登录更顺（禁用按钮在手机上连提示都没有）
    b.disabled = removed || own || (!!state.user && j.canVote === false);
  });

  // 反馈行的两个众判入口（感觉像推广 / 不像推广）也同步亮起我投过的那票，
  // 两处状态永远一致；已下架后不再亮（没什么可改的了）
  document.querySelectorAll('#detailVote [data-jury-entry]').forEach(b => {
    b.classList.toggle('active', !removed && mine === b.dataset.juryEntry);
    b.classList.toggle('is-mine', !removed && mine === b.dataset.juryEntry);
  });
}


// 从卡片上的「众判中 N」点进来（openWork 的 opts.jury）：详情打开后直接把众判块摊开、
// 滚到两个投票按钮上。别指望用户自己再点一次「参与众判 ›」——他是被角标喊来投票的。
function openJuryBox() {
  const box = $('detailJury');
  if (!box) return;
  box.classList.add('is-open');
  const openBtn = $('juryOpen');
  if (openBtn) openBtn.style.display = 'none';
}

function focusJuryVote() {
  openJuryBox();
  if (!$('detailJury')) return;
  const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // 弹窗刚 show 出来，高度还没排完：等一帧再滚，否则会滚到半成品的位置
  setTimeout(() => {
    const target = $('juryActs') || $('detailJury');
    try { target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' }); }
    catch { target.scrollIntoView(); }
  }, 120);
}

// 众判投票：下方众判块的两个按钮、反馈行的「感觉像推广 / 不像推广」两个入口共用这一条路。
// 一个账号一票（服务端按账号去重）、可以改票（再点另一边就换）、投票永久保密（不存也不回传账号名）。
async function submitJuryVote(vote) {
  const w = state.currentWork;
  const box = $('detailJury');
  if (!w || !box || (vote !== 'sus' && vote !== 'ok')) return;
  if (!state.user) { showToast('登录后才能参与众判，投票永久保密', undefined, 'err'); openAuth('login'); return; }
  box.querySelectorAll('.jury-btn').forEach(b => (b.disabled = true));
  try {
    const res = await fetch(`/api/works/${encodeURIComponent(w.id)}/jury`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || '投票失败', undefined, 'err');
      // 失败原因（注册不满 24h / 自己的作品等）写在众判块里，摊开让人看见
      openJuryBox();
      return;
    }
    w.jury = data.jury || w.jury;
    if (data.removed) {
      showToast('票数够了：作品已下架，等作者整改', 3200, 'ok');
      // 弹窗保持原样（看着作品突然消失更慌），背后的列表悄悄把那件撤掉
      loadWorks(true).catch(() => {});
    } else if (data.changed === false) {
      showToast('你已经投过这一票了');
    } else {
      showToast(vote === 'sus'
        ? '已投「感觉像推广」，谢谢参与；想改票随时点另一边'
        : '已投「不像推广」，谢谢参与；想改票随时点另一边', undefined, 'ok');
    }
  } catch {
    showToast('投票失败，请稍后重试', undefined, 'err');
  } finally {
    paintJury(state.currentWork || w);   // 按最新票数 / 资格重设按钮态
  }
}

// 相关作品：站内导流（同分类优先、不足补同作者，算法在服务端 relatedWorksOf）。
// 点一条直接换到那件作品的详情：push 让浏览器后退回到上一件，而不是一下关掉弹窗；
// 换完把 .detail-info 滚回顶部，否则会停在上一件的评论区位置。
function renderDetailRelated(w) {
  const box = $('detailRelated');
  if (!box) return;
  const list = (Array.isArray(w.related) ? w.related : []).filter(x => x && x.id);
  if (!list.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  // 缩略图走 400 档（服务端 THUMB_SIZES 只有 400/800/1200/1600，160 会直接 404 → 破图）；
  // no-referrer：作品封面可能是 B 站 / 微信图床的外链，带本站 Referer 会被防盗链拒成 403；
  // 加载失败只藏图标、保留占位方块，别让文字行跟着上下窜。
  const thumbHtml = x => {
    const u = x.thumb || x.image;
    return u
      ? `<img class="related-thumb" src="${escapeHtml(imgUrl(u, 400))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />`
      : '<span class="related-thumb" aria-hidden="true"></span>';
  };
  box.innerHTML = `<div class="related-head">相关作品</div>
    <div class="related-list">${list.map(x => `
      <button type="button" class="related-item" data-related="${escapeHtml(x.id)}">
        ${thumbHtml(x)}
        <span class="related-main">
          <b class="related-name">${escapeHtml(x.titleName || x.title || '')}</b>
          <span class="related-desc">${escapeHtml(x.cardDesc || x.introText || '')}</span>
        </span>
      </button>`).join('')}</div>`;
  box.querySelectorAll('[data-related]').forEach(el => {
    el.onclick = () => {
      openWork(el.dataset.related);
      const scroller = document.querySelector('.detail-info');
      if (scroller) scroller.scrollTop = 0;
    };
  });
}

// 用 seq 令牌只让最后一次请求渲染，配合同 id 短窗去重，一次点击只压一条历史。
let openWorkSeq = 0;
let openWorkLastClick = { id: '', at: 0 };
const OPEN_WORK_DBLCICK_MS = 800;   // 同卡双击判定的窗口：两次点击间隔小于它就只算一次

async function openWork(id, push = true, opts = {}) {
  if (push) {
    // 弹窗已经开着同一件作品：再点不重开（不然又压一条历史，关一次又弹回来）
    if (state.currentWork && state.currentWork.id === id && detailModal.style.display === 'flex') return;
    const now = Date.now();
    if (id === openWorkLastClick.id && now - openWorkLastClick.at < OPEN_WORK_DBLCICK_MS) return;   // 同卡双击只算一次
    openWorkLastClick = { id, at: now };
  }
  // 去重拦掉的调用不能走到这里自增 seq，否则在途的那次会被误判作废、弹窗一次都开不出来
  const seq = ++openWorkSeq;
  try {
    const w = await (await fetch('/api/works/' + id)).json();
    if (w.error) { showToast(w.error, undefined, 'err'); return; }
    // 期间用户又点了别的作品（或按了后退触发 route 重开）：这次结果作废，不渲染不压栈不计 PV
    if (seq !== openWorkSeq) return;
    state.currentWork = w;
    // 作品维度 PV：以弹窗方式打开时单独上报一次；/w/xxx 直链已由 trackPageView 计入，不重复
    // 作者自己打开自己的作品不计数（后端同样会拦一道），否则预览几次就把自己的数据刷高了
    // opts.noTrack：解锁后原地重渲染，这种「同一个人同一次访问」不该再计一次
    if (!opts.noTrack && !w.owned && (push || location.pathname !== '/w/' + id)) trackWorkView(id);
    if (push) {
      // 记下打开详情前的来源页（pushState.from + sessionStorage 各存一份）：
      // 真机内核可能在详情开着时把页面重载掉、history.state 随之丢失，
      // 关详情时靠这份备份才能回到原来的列表页，而不是兜底回首页
      const from = { path: location.pathname, search: location.search, at: Date.now() };
      history.pushState({ dm: 'work', from }, '', '/w/' + id);
      try { sessionStorage.setItem('dmDetailFrom', JSON.stringify(from)); } catch { /* 隐私模式写不进就算了 */ }
      // 不再用 on-work 隐藏首页内容（会让页面塌陷、滚动条消失并跳动），
      // 背景内容保留、由下方 showModal 锁定滚动
    }
    setTitle(w.title);

    $('detailImg').src = imgUrl(w.image, 1200);
    // 标题：名字保持原大小，「一句话简介」拆出来小一号浅灰（.detail-intro，2026-11-10 用户反馈）；
    // 开源作品在标题后面直接跟一颗可点的「源码」小徽标
    const [dtName, dtTag] = detailTitleParts(w);
    $('detailTitle').innerHTML = escapeHtml(dtName) +
      (dtTag ? ` <span class="detail-intro">${escapeHtml(dtTag)}</span>` : '') +
      (w.repo ? ` <a class="badge-repo badge-repo-inline" href="/out/${encodeURIComponent(w.id)}?k=repo" target="_blank" rel="nofollow noopener" title="打开源码仓库"><span class="ico">${ic('folder')}</span> 源码</a>` : '') +
      (typeof w.stars === 'number' ? `<span class="badge-star" title="GitHub 仓库的 star 数（作者 ${w.starsAt ? String(w.starsAt).slice(0, 10) : '最近'} 同步时的数值，非实时；star 涨了由作者点「更新 star 奖励」领取）"><span class="ico">${ic('star')}</span> ${w.stars}</span>` : '');
    $('detailCategory').innerHTML =
      typesOf(w).map(t => `<span class="badge-type">${typeIcoHtml(t)} ${escapeHtml(t)}</span>`).join('') +
      `<span class="badge-cat">${escapeHtml(w.category)}</span>` +
      osBadgeHtml(w) +
      paidBadgeHtml(w) +
      (w.featured ? `<span class="badge-featured"><span class="ico">${ic('sparkle')}</span> 精选</span>` : '');
    // 勋章默认只露一枚，其余折成「+N」（2026-11-13）：三枚金胶囊并排会把作者名挤成配角。
    // 完整名单放 title，悬停可看；不另做展开交互——这行里已经有太多可点目标了。
    const aTags = w.authorTags || [];
    const tagHtml = (t) => ` <i class="author-tag${t === GH_BADGE_TAG ? ' gh' : ''}" title="${t === GH_BADGE_TAG ? 'GitHub 优质原创作者勋章' : '站点荣誉标签'}">${escapeHtml(t)}</i>`;
    $('detailAuthor').innerHTML = `${escapeHtml(aname(w))}` +
      (aTags.length ? tagHtml(aTags[0]) : '') +
      (aTags.length > 1 ? `<i class="author-tag-more" title="全部勋章：${escapeHtml(aTags.join('、'))}">+${aTags.length - 1}</i>` : '');

    // 阶段横幅：预告 / 等平台上架审核的作品，先把「为什么现在点不了」讲清楚；
    // 作者自主下架的作品（仅作者本人能打开）给一条专属提示
    const wStage = stageOf(w);
    const stageBanner = $('detailStage');
    if (w.hidden) {
      stageBanner.style.display = 'block';
      stageBanner.className = 'detail-stage is-hidden';
      // 站长看别人被下架的作品：前台没有「重新上架」按钮（作者专属），别指一个点不到的地方
      stageBanner.innerHTML = (w.adminEdit === true && !w.owned)
        ? '<b>已下架 · 站长视图</b>：这件作品已从首页、列表、榜单和搜索撤下，普通访客打不开这个页面。数据都保留着，点下方「站长编辑」可以改内容；要重新上架请到后台作品管理操作。'
        : '<b>已下架 · 仅自己可见</b>：作品已从首页、列表、榜单和搜索撤下，别人打不开这个页面。浏览、点赞、灯火等数据都保留着，点下方「重新上架」即可恢复公开。';
    } else if (wStage !== 'live') {
      stageBanner.style.display = 'block';
      stageBanner.className = 'detail-stage is-' + wStage;
      if (wStage === 'wip') {
        const pct = typeof w.progress === 'number' ? w.progress : 0;
        const log = (w.progressLog || [])[0];
        stageBanner.innerHTML = `<span class="ico">${ic('construction')}</span> <b>作者还在做</b> · 完成度 ${pct}% · ${w.eta ? `预计 <b>${escapeHtml(w.eta)}</b> 上线` : '上线时间待定'}
          ${log ? `<div style="margin-top:6px;opacity:.85">最近更新：${escapeHtml(log.text)}</div>` : ''}
          <div class="ds-bar"><span style="width:${pct}%"></span></div>`;
      } else {
        stageBanner.innerHTML = '<b>正在应用商店 / 平台审核中</b>，链接现在打不开。点「上线提醒我」，通过后会收到站内通知。';
      }
    } else {
      stageBanner.style.display = 'none';
      stageBanner.className = 'detail-stage';
      stageBanner.innerHTML = '';
    }
    // 数据行只留按钮里没有的数字：点赞 / 收藏 / 评论已经在按钮上，
    // 同一批数字在相邻两行各说一遍，是之前最显眼的一处「乱」（2026-11-13）
    $('detailStats').innerHTML = `<span class="ico s-ico">${ic('eye')}</span>${w.views} 浏览 · <span class="ico s-ico">${ic('lamp')}</span><span id="detailTipsNum">${w.tipsTotal || 0}</span> 盏灯火 · ${formatDate(w.createdAt)}`;
    // 简介支持 Markdown：接口已把源码渲染成白名单 HTML（introHtml）；
    // 老数据/缓存里没有 introHtml 时退回纯文本，按换行显示
    renderQuickLook(w);   // 「一眼看懂」在简介之前：短句速览比长介绍更适合先看
    const dp = $('detailPrompt');
    dp.classList.add('md-body');
    dp.innerHTML = w.introHtml || (w.intro ? escapeHtml(w.intro).replace(/\n/g, '<br>') : '');
    paintDetailLikes(w.likes);
    // 收藏数挂到「收藏」按钮上（数据行不再重复展示）：带 data-fav-count，
    // 点收藏后 paintFavCount 能就地改数字；data-fav-seg 让它跟着 0/非 0 自动显隐
    const dfn = $('detailFavNum');
    if (dfn) {
      dfn.dataset.favCount = w.id;
      dfn.dataset.favSeg = w.id;
      dfn.dataset.count = w.favs || 0;
      dfn.dataset.prefix = '';
      dfn.textContent = w.favs || 0;
      dfn.classList.toggle('is-zero', !(w.favs > 0));
    }
    // 操作栏「评论 N」上的数字：挂 data-comment-count，发/删评论时 paintCommentCount 会一起更新；
    // data-cmt-seg 让 0 条时不显示数字（零值不展示，和卡片口径一致）
    const dcn = $('detailCmtNum');
    dcn.dataset.commentCount = w.id;
    dcn.dataset.cmtSeg = w.id;
    dcn.dataset.count = w.commentCount || 0;
    dcn.textContent = w.commentCount || 0;
    dcn.classList.toggle('is-zero', !(w.commentCount > 0));

    // 访问/下载按钮：每个填了链接的形态各一个（多平台应用 iOS/Android/macOS… 分开展示）
    // 旧数据没有按形态的 links 时，退回单个按钮沿用原文案
    const tl = typesOf(w);
    // 纯小程序作品没有可点的外链，唯一入口是小程序码。老数据残留的 link 只能标「了解详情」，
    // 不能标「打开小程序」—— 点开的是网页，不是小程序
    const miniOnly = tl.length > 0 && tl.every(t => t === '小程序');
    const linkEntries = tl
      .map(t => ({ t, k: t, url: (w.links && w.links[t]) || '' }))
      .filter(e => e.url);
    if (!linkEntries.length && w.link) linkEntries.push({ t: null, k: 'link', url: w.link, miniIntro: miniOnly });
    // 官网按钮：填了官网且没有和某个平台链接重复时，放在最前面
    const siteUrl = String(w.site || '').trim();
    if (siteUrl && !linkEntries.some(e => e.url === siteUrl)) linkEntries.unshift({ t: null, k: 'site', url: siteUrl, site: true });
    // 每个按钮带动作标记：点了算「访问」还是「下载」，按形态自动判（iOS/Android/桌面端=下载，其余=访问）
    // 埋点后不影响跳转——target=_blank + keepalive，新标签打开时上报也能发出去
    // href 走 /out 出口网关：真实地址在服务端按作品数据现查，这里不暴露直链（nofollow/黑名单/点击留痕都在网关做）
    let linksHtml = linkEntries.map(e => {
      const act = actionOfType(e.t, e.site);
      const atype = e.site ? '官网' : (e.t || '作品链接');
      return `<a class="btn-link" target="_blank" rel="nofollow noopener" href="/out/${encodeURIComponent(w.id)}?k=${encodeURIComponent(e.k || '')}" data-act="${act}" data-atype="${escapeHtml(atype)}"><span class="ico b-ico">${ic(e.site ? 'globe' : (e.t && LINK_ICON[e.t]) || 'link')}</span> ${
        e.site ? '官网' : e.miniIntro ? '了解详情' : e.t ? escapeHtml((LINK_LABEL[e.t] || '访问作品').replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '')) : escapeHtml(linkLabelOf(tl))
      }</a>`;
    }).join('');
    // 纯小程序、既没码也没介绍页：说明现状，别让详情页空着让人不知道点哪
    if (miniOnly && !w.qrcode && !linkEntries.length && !w.lampLocked) {
      linksHtml = '<span class="link-locked"><span class="ico">' + ic('mobile') + '</span> 作者还没上传小程序码，暂时打不开</span>';
    }
    // 灯火解锁：服务端已经把链接和码都收走了，这里补一张解锁卡——
    // 光秃秃不显示按钮会让人以为作品坏了，得说清「要花几盏、解锁后有什么」。
    if (w.lampLocked) {
      const price = Number(w.lampPrice) || 0;
      const bal = state.user ? Number(state.user.points || 0) : null;
      linksHtml = `<div class="lamp-lock">
        <span class="ico lamp-lock-ico">${ic('lock')}</span>
        <div class="lamp-lock-main">
          <b>用 ${price} 盏灯火解锁</b>
          <span>解锁后显示网页链接、下载链接和小程序码，一次解锁永久有效${w.lampUnlocks ? ` · 已有 ${w.lampUnlocks} 人解锁` : ''}</span>
        </div>
        <button type="button" class="btn-primary btn-sm lamp-unlock-btn" id="lampUnlockBtn">${bal === null ? '登录后解锁' : (bal < price ? `还差 ${price - bal} 盏` : `用 ${price} 盏解锁`)}</button>
      </div>`;
    }
    // 平台上架审核中：链接已经存在但打不开，这里锁死不给点
    $('detailLinks').innerHTML = w.linkLocked
      ? '<span class="link-locked">平台上架审核中，暂时不能打开</span>'
      : linksHtml;

    // 平台入口太多（>3 个按钮）时收起来：只露前 3 个，其余折进「更多平台」，
    // 避免一排实心按钮把详情页头部挤成按钮墙
    const dlinks = $('detailLinks');
    // 锁定卡是整块横幅：入口容器被 .detail-links 的 flex-shrink:0 定死不许收缩，长文案会把它撑出弹窗；
    // 锁定态单独放开收缩并切成块级，卡片按弹窗内容宽排、文案自动换行
    if (w.lampLocked) {
      dlinks.style.display = 'block';
      dlinks.style.flexShrink = '1';
      dlinks.style.minWidth = '0';
    }
    // 点击埋点绑在真实跳转上：先上报再放行，锚点默认行为不动
    dlinks.querySelectorAll('.btn-link[data-act]').forEach(a => {
      a.addEventListener('click', () => trackAction(w.id, a.dataset.act, a.dataset.atype));
    });
    // 解锁按钮：未登录先去登录；余额不足只提示怎么攒；够就直接扣（二次确认写清「全额转给作者」）
    const lampBtn = dlinks.querySelector('#lampUnlockBtn');
    if (lampBtn) lampBtn.addEventListener('click', () => unlockWorkByLamp(w));
    const linkBtns = Array.from(dlinks.querySelectorAll('.btn-link'));
    if (linkBtns.length > 3) {
      const extra = linkBtns.slice(3);
      extra.forEach(b => { b.style.display = 'none'; });
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn-link btn-more-links';
      more.textContent = `更多平台（${extra.length}）▾`;
      more.onclick = () => {
        const open = more.classList.toggle('is-open');
        extra.forEach(b => { b.style.display = open ? '' : 'none'; });
        more.textContent = open ? '收起平台 ▴' : `更多平台（${extra.length}）▾`;
      };
      dlinks.appendChild(more);
    }

    // 上线提醒：预告 / 审核中的作品才有。作者看到的是「我上线了」，访客是订阅提醒
    const wBtn = $('detailWatch');
    if (wStage !== 'live') {
      wBtn.style.display = 'inline-flex';
      if (w.owned) {
        wBtn.className = 'btn-like btn-watch';
        wBtn.textContent = '我上线了（通知催更的人）';
        wBtn.onclick = async () => {
          wBtn.disabled = true;
          try {
            const r = await fetch('/api/works/' + encodeURIComponent(w.id) + '/stage', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stage: 'live', note: '作者确认已上线' })
            });
            const d = await r.json();
            if (!r.ok) { showToast(d.error || '还不能上线，先在「编辑」里补上作品链接', undefined, 'err'); return; }
            upcomingSig = '';
            showToast('已上线，催更的人已收到通知', undefined, 'ok');
            openWork(w.id, false);   // 重开详情，横幅和按钮切回上线态
          } catch { showToast('操作失败，请稍后重试', undefined, 'err'); }
          finally { wBtn.disabled = false; }
        };
      } else {
        wBtn.className = 'btn-like btn-watch' + (w.watched ? ' is-on' : '');
        wBtn.innerHTML = `${w.watched ? '✓ 已订阅上线提醒' : `<span class="ico">${ic('bell')}</span> 上线提醒我`} · ${w.watchCount || 0}`;
        wBtn.onclick = async () => {
          if (!state.user) { openAuth('login'); return; }
          const on = !wBtn.classList.contains('is-on');
          wBtn.disabled = true;
          try {
            const r = await fetch('/api/works/' + encodeURIComponent(w.id) + '/watch', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on })
            });
            const d = await r.json();
            if (!r.ok) { showToast(d.error || '操作失败', undefined, 'err'); return; }
            wBtn.classList.toggle('is-on', !!d.watched);
            wBtn.innerHTML = `${d.watched ? '✓ 已订阅上线提醒' : `<span class="ico">${ic('bell')}</span> 上线提醒我`} · ${d.watchCount || 0}`;
            w.watched = d.watched;
            w.watchCount = d.watchCount;
            upcomingSig = '';   // 酒馆右栏那块的计数下次刷新跟着变
            showToast(d.watched ? '上线当天会给你发站内消息' : '已取消上线提醒', undefined, 'ok');
          } catch { showToast('操作失败，请稍后重试', undefined, 'err'); }
          finally { wBtn.disabled = false; }
        };
      }
    } else {
      wBtn.style.display = 'none';
      wBtn.onclick = null;
    }

    // （源码入口已上移到标题标签行 badge-repo，按钮行不再重复放）

    // 兑换码按钮：作品挂了码就显示领取入口；作者/管理员显示管理入口
    renderCodeButtons(w);

    // 外宣包：把作品信息拼成各平台的投稿文案，只给作者本人看。
    // 文案是第一人称（"我做了 X"）、链接里的 ref 归作品作者，别人拿去发等于冒充作者投稿，
    // 带回来的注册还会记在复制者头上。想帮作者传播走「分享卡片」（ref=分享者，扫码给分享者 +3 盏）。
    const pkBtn = $('promoKitBtn');
    if (pkBtn) {
      pkBtn.style.display = w.owned ? '' : 'none';
      pkBtn.onclick = w.owned ? () => openPromoKit(w) : null;
    }

    // 完整页面（独立 URL，可分享、可被搜索引擎收录）
    $('fullPageBtn').href = '/w/' + encodeURIComponent(w.id) + '?full=1';

    const qrBox = $('detailQrBox');
    const qrZoomBtn = $('qrZoom');
    const qrSaveBtn = $('qrSave');
    const qrTabs = $('qrTabs');
    // 两种码：作者上传的小程序码（扫码在微信里，只能记「意图」），
    // 以及系统自动生成的短链码（扫码先落到 /go/xxx，服务端能记到真实次数）
    const qrSrc = w.qrSrc || w.qrcode || '';
    const qrReal = !!w.qrReal;
    // 自动码：每个入口形态一张（官网 / iOS / Android…），扫码分别计数，作者能看到「哪个平台真被扫了」
    const qrList = (qrReal && Array.isArray(w.qrTargets) ? w.qrTargets : []).filter(t => t && t.src);
    if (qrSrc) {
      // 标签和提示文案按入口定制：直接套按钮文案会拼出「前往 打开网站」这种怪句子
      const QR_LABEL = {
        'site': '官网', 'Web': '网页版', 'iOS': 'App Store', 'Android': 'Android 版',
        'macOS': 'Mac 版', 'Windows': 'Windows 版', 'Linux': 'Linux 版',
        '浏览器插件': '浏览器插件', '机器人': '机器人', 'API': 'API 文档'
      };
      const shortLabel = t => QR_LABEL[t] || String((LINK_LABEL[t] || t).replace(/^[^A-Za-z\u4e00-\u9fa5]+/, ''));
      const tipOf = t => t === 'site' ? '手机扫码打开官网'
        : t === 'Web' ? '手机扫码在手机上打开'
        : t === 'API' ? '手机扫码查看文档'
        : `手机扫码前往 ${shortLabel(t)}`;
      // 有下载链接（App Store / 安卓 / 桌面安装包）时，默认就停在那张码上：
      // 想装 App 的人远多于想看官网的人，停在「官网」等于让他多点一次
      const DL_TYPES = ['iOS', 'Android', 'macOS', 'Windows', 'Linux'];
      const dlIdx = qrList.findIndex(t => DL_TYPES.includes(t.t));
      const defIdx = (qrList.length > 1 && dlIdx > 0) ? dlIdx : 0;
      let curSrc = qrSrc, curTip = qrReal ? '手机扫码打开' : (miniOnly ? '用微信扫一扫打开小程序' : '扫码打开作品');
      if (qrList.length > 1 && qrList[defIdx]) {
        curSrc = qrList[defIdx].src;
        curTip = tipOf(qrList[defIdx].t);
      }
      // 码图加载失败（作者删了图 / 生成异常）就整块收起，别留一个破图框在页面上
      $('detailQr').onerror = () => { qrBox.style.display = 'none'; };
      $('detailQr').src = curSrc;
      prefetchSaveBlob(curSrc);   // 提前取字节，iOS 上点「保存二维码」才能立刻弹分享面板
      $('detailQrTip').textContent = curTip;
      qrBox.style.display = 'block';
      qrBox.classList.toggle('is-auto', qrReal);
      // 二维码直接展开（2026-11-13 晚站长要求去掉折叠行）：折叠状态下访客常常找不到码，
      // 「换到手机打开」虽低频，但找不到就等于没有。手机端的系统自动码仍由
      // style.css 的 .detail-qr.is-auto 窄屏规则隐藏，不会占手机屏幕。
      qrBox.classList.add('is-open');
      const qrEntry = miniOnly ? '小程序' : '二维码';
      // 自动码的真实扫码在 /go/ 里记，这里点放大/保存不再重复计数；只有小程序原码才记意图
      const noteScan = () => { if (!qrReal) trackAction(w.id, 'scan_intent', qrEntry); };
      qrZoomBtn.onclick = () => { noteScan(); openQrZoom(curSrc, curTip); };
      qrSaveBtn.onclick = () => { noteScan(); saveQrImage(curSrc, w.id); };
      // 多个入口才需要切换：一个入口直接显示，别给用户多一步
      if (qrList.length > 1) {
        qrTabs.innerHTML = qrList.map((t, i) =>
          `<button type="button" class="qr-tab${i === defIdx ? ' is-on' : ''}" data-i="${i}">${escapeHtml(shortLabel(t.t))}</button>`
        ).join('');
        qrTabs.style.display = 'flex';
        qrTabs.onclick = e => {
          const b = e.target.closest('.qr-tab');
          if (!b) return;
          const t = qrList[Number(b.dataset.i)];
          if (!t) return;
          curSrc = t.src; curTip = tipOf(t.t);
          $('detailQr').src = curSrc;
      prefetchSaveBlob(curSrc);   // 提前取字节，iOS 上点「保存二维码」才能立刻弹分享面板
          $('detailQrTip').textContent = curTip;
          [...qrTabs.children].forEach(el => el.classList.toggle('is-on', el === b));
        };
      } else {
        qrTabs.innerHTML = '';
        qrTabs.style.display = 'none';
        qrTabs.onclick = null;
      }
    } else {
      qrBox.style.display = 'none';
      qrBox.classList.remove('is-auto');
      qrTabs.innerHTML = '';
      qrTabs.style.display = 'none';
      $('detailQr').onerror = null;
      qrZoomBtn.onclick = null;
      qrSaveBtn.onclick = null;
    }

    // 宣传图画廊：左右箭头循环切换大图，缩略图点击直达；缩略图比例跟随作品形态
    const gal = $('detailGallery');
    const isMobile = isMobileTypes(typesOf(w));
    detailModal.querySelector('.modal').classList.toggle('is-mobile', isMobile);
    gal.classList.toggle('is-mobile', isMobile);
    const imgs = w.images || [];
    // 缩略图条把封面也放进第一位：list = [封面, ...宣传图]，缩略图与 list 一一对应（offset=0）
    galState.list = (w.image ? [w.image] : []).concat(imgs);
    galState.offset = 0;
    galState.idx = 0;
    const hasArrow = galState.list.length > 1;
    $('galPrev').style.display = hasArrow ? 'flex' : 'none';
    $('galNext').style.display = hasArrow ? 'flex' : 'none';
    if (imgs.length) {
      gal.innerHTML = galState.list.map((src, i) =>
        `<img src="${escapeHtml(src)}" data-src="${escapeHtml(src)}" alt="${escapeHtml(w.title)} ${i === 0 && w.image ? '封面' : '宣传图' + i}" loading="lazy" />`).join('');
      gal.style.display = 'flex';
      gal.querySelectorAll('img').forEach((im, k) => {
        im.onclick = () => setDetailImage(galState.offset + k);
      });
      setDetailImage(galState.idx); // 打开时同步一次缩略图高亮（封面在第一位）
      $('thumbStrip').style.display = 'block';
      requestAnimationFrame(updateThumbArrows);
    } else {
      gal.style.display = 'none';
      $('thumbStrip').style.display = 'none';
    }

    // 同级工具推荐位
    const tools = state.tools.length ? state.tools : [];
    if (tools.length) {
      $('detailTools').style.display = 'block';
      $('detailToolList').innerHTML = tools.slice(0, 3).map(t =>
        `<a class="tool-item" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">
           <b>${escapeHtml(t.name)}</b><span>${escapeHtml(t.desc || '')}</span>
         </a>`).join('');
    } else $('detailTools').style.display = 'none';

    // 站内相关作品（同分类优先、不足补同作者）：放在工具推荐位前面渲染，
    // 数据来自 /api/works/:id 的 related，和 SSR 详情页共用同一份算法
    renderDetailRelated(w);

    // 已赞态以服务端为准（换设备也记得你赞过哪件）；匿名没有账号，只能看本地标记
    paintLikeBtn(w, state.user ? w.liked === true : localStorage.getItem('liked:' + w.id) === '1');
    renderDetailFav(w.id);
    paintJury(w);
    if (opts.jury) focusJuryVote();   // 卡片角标点进来的：直接摊开投票区
    // 自己的作品不显示点赞/收藏按钮（统计数字还在数据区，只是不给自己提供操作入口）
    $('detailLike').style.display = w.owned ? 'none' : '';
    $('detailFav').style.display = w.owned ? 'none' : '';

    // 三选一轻反馈：自己的作品不显示；投过的保持高亮（myVote 由服务端按当前身份带回来）
    const voteRow = $('detailVote');
    if (voteRow) {
      voteRow.style.display = w.owned ? 'none' : '';
      voteRow.querySelectorAll('.vote-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.vote === (w.myVote || '')));
    }

    // 打赏：自己的作品不显示；匿名/游客投稿的作品也能送灯火（灯火记在作品上，不转给任何人）
    const tipBtn = $('detailTip');
    tipBtn.style.display = w.owned ? 'none' : '';
    tipBtn.classList.remove('is-off');
    tipBtn.title = w.claimed
      ? '用灯火支持作者，灯火会直接转到作者账上'
      : '为这件作品点亮一盏灯火，灯火会记在作品上（作者还没绑定账号）';
    tipBtn.innerHTML = `<i class="ico b-ico">${ic('lamp')}</i> <span class="tip-word">送灯火</span>`;
    resetTipPanel(w);
    // 作者名点击回归「进作者主页」（2026-11-13 改回）：送灯火入口收进作者主页，
    // 悬浮提示同步这个行为（自己的作品点名字进我的主页）
    const authorBtn = $('detailAuthor');
    authorBtn.title = w.owned ? '查看我的主页' : `访问 @${dname(w)} 的主页`;

    // 自己的作品：数据区下方显示高亮管理条（编辑 / 下架 / 删除）；别人的作品：登录后可屏蔽，有账号的作者可拉黑
    // 站长账号看别人的作品：同样出这条（浅琥珀色），但只留「站长编辑」——
    // 下架 / 删除走后台（那边有二次确认和完整上下文），前台不给一键删别人东西的口子
    const canManage = !!w.owned;
    const siteEdit = w.adminEdit === true && !canManage;
    const ownerBar = $('ownerBar');
    ownerBar.style.display = (canManage || siteEdit) ? 'flex' : 'none';
    ownerBar.classList.toggle('is-admin', siteEdit);
    const barText = $('ownerBarText');
    if (barText) barText.textContent = siteEdit ? '站长视角 · 可直接编辑这件作品' : '这是你的作品';
    // 自己的开源作品才给「更新 star」：详情页本来就有 star 徽章，入口放管理条里最顺手
    const dStarBtn = $('detailStarSync');
    if (dStarBtn) dStarBtn.style.display = (canManage && w.openSource === true) ? '' : 'none';
    // 「推荐」入口只给作者本人：站长视角条不放（投放是作者自己的灯火，站内角色不代操作）
    const promoEntry = $('ownerPromoBtn');
    if (promoEntry) promoEntry.style.display = canManage ? '' : 'none';
    const hideBtn = $('toggleHide');
    hideBtn.innerHTML = `<i class="ico b-ico">${ic('eye')}</i> ${w.hidden ? '重新上架' : '下架'}`;
    // 站长模式把这些作者专属动作收起来；切回自己的作品时要还原（openWork 会被反复调用）
    $('editWork').innerHTML = `<i class="ico b-ico">${ic('edit')}</i> ${siteEdit ? '站长编辑' : '编辑作品'}`;
    hideBtn.style.display = siteEdit ? 'none' : '';
    $('delWork').style.display = siteEdit ? 'none' : '';
    // 站长编辑入口回到顶部管理条里（站长视角条的右侧）：浅琥珀「站长编辑」，和作者自己的「编辑作品」同一颗按钮、同一套编辑器
    $('editWork').style.display = '';
    const ownerSep = ownerBar.querySelector('.owner-bar-sep');
    if (ownerSep) ownerSep.style.display = siteEdit ? 'none' : '';
    $('blockWork').style.display = (!canManage && !siteEdit && state.user) ? 'inline-block' : 'none';
    const blockedAuthor = state.user && (state.blockedUsers || []).includes(w.author);
    $('blockAuthor').style.display = (!canManage && !siteEdit && state.user && w.claimed && w.author && w.author !== '匿名')
      ? 'inline-block' : 'none';
    $('blockAuthor').innerHTML = `<span class="ico b-ico">${ic('block')}</span> ${blockedAuthor ? '已拉黑作者 · 恢复' : '拉黑作者'}`;

    // 推荐位：自己的作品不给自己展示（换了作品重开详情要重算一次）
    renderAdSlot(document.querySelector('.ad-slot-detail'), 'detail');

    // 认领入口：只有管理员开放了认领的作品才显示（自己的作品不显示）
    const entry = $('claimEntry');
    const mine = myClaimOf(w.id);
    if (canManage || w.owned || (!w.claimable && !w.claimAuthMine)) {
      entry.style.display = 'none';
    } else if (w.claimAuthMine) {
      // 站长预先授权过的作者：一键认领，不用交证据
      entry.style.display = 'inline-block';
      entry.className = 'claim-entry is-auth';
      entry.disabled = false;
      entry.innerHTML = `<span class="ico">${ic('claim')}</span> 站长已授权你认领这件作品 · 一键认领 →`;
    } else if (mine && mine.status === 'pending') {
      entry.style.display = 'inline-block';
      entry.className = 'claim-entry is-pending';
      entry.textContent = '认领申请审核中';
      entry.disabled = true;
    } else {
      entry.style.display = 'inline-block';
      entry.className = 'claim-entry';
      entry.disabled = false;
      entry.innerHTML = state.user ? `<span class="ico">${ic('claim')}</span> 这是我做的，认领作品 →` : `<span class="ico">${ic('claim')}</span> 这是你的作品？登录后认领 →`;
    }

    loadComments(w.id);

    showModal(detailModal);
  } catch { showToast('作品加载失败', undefined, 'err'); }
}

// ---------- 评论与提问 ----------
const COMMENT_EMPTY = '<div class="comment-empty">还没有人说话，来问第一个问题吧～</div>';

function commentBadges(c) {
  const out = [];
  if (c.isAuthor) out.push('<span class="cmt-badge author">作者</span>');
  if (c.kind === 'question') {
    // Bug / 建议本质也是提问（走提问的排序与回复闭环），只是标签不同
    const qLabel = c.qtype === 'bug' ? 'Bug' : c.qtype === 'sug' ? '建议' : '提问';
    out.push(`<span class="cmt-badge q${c.qtype ? ' ' + c.qtype : ''}">${c.answered ? '已回复' : qLabel}</span>`);
  }
  if (c.anon) out.push('<span class="cmt-badge anon">匿名</span>');
  // 仅作者可见（私密反馈）：能出现在列表里的人本来就都是被允许看的
  if (c.priv) out.push('<span class="cmt-badge priv">仅作者可见</span>');
  return out.join('');
}

function commentItemHtml(c, replies) {
  return `
    <div class="comment-item${c.kind === 'question' ? ' is-question' : ''}" data-id="${escapeHtml(c.id)}">
      ${avaHtml(cname(c), c.anon ? '' : c.avatar, 'comment-avatar' + (c.anon ? ' anon' : ''), !!c.anon, c.username)}
      <div class="comment-body">
        <div class="comment-meta">
          <b>@${escapeHtml(cname(c))}</b>${commentBadges(c)}
          <span>${formatDate(c.createdAt)}</span>
          <span class="comment-acts">
            <button type="button" class="comment-reply" data-reply="${escapeHtml(c.id)}" data-rid="${escapeHtml(c.id)}">回复</button>
            ${c.owned ? '<button type="button" class="comment-del">删除</button>' : ''}
          </span>
        </div>
        <div class="comment-text">${escapeHtml(c.text)}</div>
        ${(replies || []).length ? `<div class="comment-replies">${replies.map(r => commentReplyHtml(r, c.id)).join('')}</div>` : ''}
      </div>
    </div>`;
}

function commentReplyHtml(r, rootId) {
  return `
    <div class="comment-reply-item" data-id="${escapeHtml(r.id)}">
      ${avaHtml(cname(r), r.anon ? '' : r.avatar, 'comment-avatar sm' + (r.anon ? ' anon' : ''), !!r.anon, r.username)}
      <div class="comment-body">
        <div class="comment-meta">
          <b>@${escapeHtml(cname(r))}</b>${commentBadges(r)}
          ${r.replyToName ? `<span class="reply-to">回复 @${escapeHtml(r.replyToName)}</span>` : ''}
          <span>${formatDate(r.createdAt)}</span>
          <span class="comment-acts">
            <button type="button" class="comment-reply" data-reply="${escapeHtml(rootId)}" data-rid="${escapeHtml(r.id)}">回复</button>
            ${r.owned ? '<button type="button" class="comment-del">删除</button>' : ''}
          </span>
        </div>
        <div class="comment-text">${escapeHtml(r.text)}</div>
      </div>
    </div>`;
}

function renderCommentList(listEl, countEl, list) {
  countEl.textContent = list.length ? `(${list.length})` : '';
  if (!list.length) { listEl.innerHTML = COMMENT_EMPTY; return; }
  const tops = list.filter(c => !c.parentId);
  const byParent = new Map();
  list.filter(c => c.parentId).forEach(c => {
    if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
    byParent.get(c.parentId).push(c);
  });
  listEl.innerHTML = tops.map(c => commentItemHtml(c, byParent.get(c.id) || [])).join('');
}

// 切换「评论 / 提问 / Bug / 建议」
const COMMENT_PLACEHOLDER = {
  comment: '说点什么，或提出你的问题…',
  question: '把问题写清楚，作者更容易回答…',
  bug: '遇到什么问题？写清操作步骤、预期和实际结果，作者改得更快…',
  sug: '说说你的想法：哪里可以更好、你期望的样子…'
};

function syncCommentKindUI() {
  document.querySelectorAll('#commentKind .ck-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.kind === state.commentKind));
  const input = $('commentInput');
  if (!input) return;
  // 「仅作者可见」：登录用户在 提问/Bug/建议 下才出现（匿名没有身份，私密了对方回复也送不到）；回复模式下不出现（跟楼层走）
  const privWrap = $('commentPrivWrap');
  if (privWrap) {
    privWrap.style.display = (!state.replyTo && state.user && state.commentKind !== 'comment') ? '' : 'none';
    if (state.replyTo) $('commentPriv').checked = false;
  }
  if (state.replyTo) return; // 回复模式下 placeholder 由 startReply 控制
  input.placeholder = COMMENT_PLACEHOLDER[state.commentKind] || COMMENT_PLACEHOLDER.comment;
}

// 进入 / 退出「回复某条评论」
function startReply(rootId, targetId) {
  const listEl = $('commentList');
  const el = listEl.querySelector(`[data-id="${CSS.escape(String(targetId))}"] b`);
  const name = el ? el.textContent.replace(/^@/, '') : '这条评论';
  state.replyTo = { rootId, targetId };
  state.commentKind = 'comment'; // 回复只能是评论
  syncCommentKindUI();
  $('commentReplyTip').style.display = 'flex';
  $('commentReplyName').textContent = '@' + name;
  const input = $('commentInput');
  input.placeholder = `回复 @${name}…`;
  input.focus();
}

function cancelReply() {
  state.replyTo = null;
  const tip = $('commentReplyTip');
  if (tip) tip.style.display = 'none';
  syncCommentKindUI();
}

// 「评论 / 提问」切换：事件委托绑在 document 上，独立于 setupDetailActions——
// 即使详情弹窗其他按钮的绑定因 HTML/JS 版本错位抛错，这里也不受牵连（曾因此点提问没反应）
function setupCommentKindTabs() {
  try {
    document.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('#commentKind .ck-btn');
      if (!btn) return;
      if (state.replyTo) cancelReply();
      state.commentKind = btn.dataset.kind;
      syncCommentKindUI();
      const inp = $('commentInput');
      if (inp) inp.focus();
    });
  } catch (err) { console.warn('评论类型切换绑定失败', err); }
}

// 评论框表情（2026-11-13）：固定一小排常用表情，选中后以纯文本插进输入框光标处。
// 不做图片表情/上传，就是普通字符，评论的后端和渲染（escapeHtml）零改动。
const COMMENT_EMOJIS = ['😄','😆','😊','😂','🤔','😅','😍','😭','🙄','😴','👍','👏','🙏','💪','🤝','✌️','🎉','🔥','❤️','💔','✅','❓','🍉','🚀'];

// 纯文本表情插进单行输入框的光标处（评论框和闲聊回应框共用）：不动后端、不动渲染，就是个字符
function insertAtCaret(input, text, maxLen) {
  if (!input) return;
  const s = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + text + input.value.slice(end);
  if (maxLen && input.value.length > maxLen) input.value = input.value.slice(0, maxLen); // 跟 maxlength 对齐
  const caret = Math.min(s + text.length, input.value.length);
  input.focus();
  try { input.setSelectionRange(caret, caret); } catch { /* 老环境不支持就算了 */ }
}

// 表情浮层（2026-11-14）：闲聊弹窗的 body 是可滚动容器，内嵌的 absolute 面板会被裁掉或撑出滚动条，
// 所以这里挂到 body 上做 fixed 浮层——按按钮位置往上弹，上面放不下就朝下。全站只留一个。
let emojiFloatEl = null;

function closeEmojiFloat() {
  if (!emojiFloatEl) return;
  emojiFloatEl.remove();
  emojiFloatEl = null;
}

function openEmojiFloat(anchor, onPick) {
  closeEmojiFloat();
  const pop = document.createElement('div');
  pop.className = 'emoji-pop emoji-float';
  pop.innerHTML = COMMENT_EMOJIS.map(e =>
    `<button type="button" data-emoji="${e}" title="${e}">${e}</button>`).join('');
  document.body.appendChild(pop);
  emojiFloatEl = pop;
  pop._anchor = anchor;
  // 一行 8 个、约 290px 宽：默认面板右边缘对齐按钮（跟 PC 习惯一致），
  // 手机上右对齐会顶出屏幕，就改成以按钮为中心再按视口夹一下
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const maxLeft = Math.max(8, innerWidth - w - 8);
  let left = a.right - w;
  if (left < 8) left = a.left + a.width / 2 - w / 2;
  pop.style.left = Math.min(Math.max(8, left), maxLeft) + 'px';
  let top = a.top - h - 6;
  if (top < 8) top = Math.min(a.bottom + 6, Math.max(8, innerHeight - h - 8));
  pop.style.top = top + 'px';
  pop.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button[data-emoji]');
    if (!b) return;
    e.stopPropagation();
    onPick(b.dataset.emoji);
    closeEmojiFloat();
  });
}

// 点浮层外面、页面/容器滚动、窗口缩放都收起：fixed 浮层不跟着滚，留着会飘到别的地方
function setupEmojiFloatDismiss() {
  document.addEventListener('click', e => {
    if (!emojiFloatEl) return;
    if (emojiFloatEl.contains(e.target)) return;
    if (emojiFloatEl._anchor && emojiFloatEl._anchor.contains(e.target)) return;
    closeEmojiFloat();
  });
  window.addEventListener('scroll', () => { if (emojiFloatEl) closeEmojiFloat(); }, true);
  window.addEventListener('resize', () => { if (emojiFloatEl) closeEmojiFloat(); });
}

function setupCommentEmoji() {
  const btn = $('commentEmojiBtn');
  const pop = $('emojiPop');
  if (!btn || !pop) return;
  pop.innerHTML = COMMENT_EMOJIS.map(e =>
    `<button type="button" data-emoji="${e}" title="${e}">${e}</button>`).join('');
  btn.addEventListener('click', e => {
    e.stopPropagation(); // 别触发下面的「点别处收起」
    pop.style.display = pop.style.display === 'none' ? 'grid' : 'none';
  });
  pop.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button[data-emoji]');
    if (!b) return;
    insertAtCaret($('commentInput'), b.dataset.emoji, 500);
    pop.style.display = 'none';
  });
  // 点面板外面收起
  document.addEventListener('click', e => {
    if (pop.style.display === 'none') return;
    if (!pop.contains(e.target) && !btn.contains(e.target)) pop.style.display = 'none';
  });
}

async function loadComments(workId) {
  const listEl = $('commentList');
  const countEl = $('commentCount');
  const input = $('commentInput');
  const nick = $('commentNickname');
  input.value = '';
  cancelReply();
  state.commentKind = 'comment'; // 每次打开作品都回到「评论」：上一个作品里选的「提问」不带入（曾因此评论模式下提问tab高亮）
  if (state.user) {
    nick.style.display = 'none';
    $('commentHint').textContent = `以 @${state.user.nickname || state.user.username} 的身份发言`;
  } else {
    nick.style.display = '';
    nick.value = localStorage.getItem('cmtNick') || '';
    // 匿名也能发言，但作者回复你时收不到提醒 —— 先说清楚，别让人以为石沉大海
    $('commentHint').textContent = '无需登录，填个昵称就能发言；登录后作者回复你会收到提醒';
  }
  syncCommentKindUI();
  try {
    const list = await fetch(`/api/works/${workId}/comments`).then(r => r.json());
    renderCommentList(listEl, countEl, Array.isArray(list) ? list : []);
  } catch {
    listEl.innerHTML = '<div class="comment-empty">评论加载失败</div>';
    countEl.textContent = '';
  }
}

// ---------- 发布 / 编辑 ----------
function setupUploadForm() {
  const form = $('uploadForm');
  const newCatInput = $('newCategoryInput');
  const MAX_GALLERY = 9;          // 服务端宣传图上限（详情页除封面外最多 9 张）
  const MAX_GALLERY_ITEMS = 10;   // 上传列表总容量：第 1 张自动当封面 + 9 张宣传图

  // ---- 作品形态（多选）----
  function selectedTypes() {
    return [...form.querySelectorAll('input[name="types"]:checked')].map(i => i.value);
  }
  function setSelectedTypes(list) {
    const want = (list || []).slice();
    // 允许中途全部取消（换思路时先清空再挑），提交时才校验「必选一个」
    form.querySelectorAll('input[name="types"]').forEach(i => { i.checked = want.indexOf(i.value) !== -1; });
    applyTypeFields();
  }
  // ---- 应用分类（多选，最多 3 个）----
  const catPicker = $('catPicker');
  const catHint = $('catHint');
  let pickedCats = []; // 有序：第 0 个为主分类（先点先得）
  function selectedCats() { return pickedCats.slice(); }
  function markCatOrder() {
    if (!catPicker) return;
    catPicker.querySelectorAll('label.type-opt').forEach(lbl => {
      const cb = lbl.querySelector('input[name="cats"]');
      const span = lbl.querySelector('span');
      if (!cb || !span) return;
      const old = span.querySelector('.cat-idx');
      if (old) old.remove();
      const idx = pickedCats.indexOf(cb.value);
      lbl.classList.toggle('is-main', idx === 0);
      if (idx !== -1) {
        const b = document.createElement('i');
        b.className = 'cat-idx';
        b.textContent = idx === 0 ? '主' : String(idx + 1);
        span.appendChild(b);
      }
    });
  }
  function updateCatHint() {
    if (!catHint) return;
    const n = pickedCats.length;
    const base = n ? `已选 ${n}/${MAX_CATS} 个，主分类：${pickedCats[0]}` : `最多选择 ${MAX_CATS} 个，先点的是主分类`;
    // 选了「个人站」时顺带提示怎么投才不被退回（判定标准见投稿指南第 4 条）
    catHint.textContent = pickedCats.includes('个人站')
      ? `${base} · 封面用首页首屏截图，介绍写清「为解决什么问题而做」`
      : base;
  }
  function renderCatPicker() {
    if (!catPicker) return;
    const checked = selectedCats();
    catPicker.innerHTML = CATEGORIES.filter(c => c !== '全部').map(c =>
      `<label class="type-opt"><input type="checkbox" name="cats" value="${escapeHtml(c)}"${checked.includes(c) ? ' checked' : ''} /><span>${escapeHtml(c)}</span></label>`
    ).join('')
    + `<button type="button" class="type-opt cat-add" id="catAddBtn" title="创建并选择新分类"><span>＋ 新分类</span></button>`;
    const addBtn = $('catAddBtn');
    if (addBtn) addBtn.onclick = e => {
      e.preventDefault();
      newCatInput.style.display = 'block';
      newCatInput.focus();
    };
    markCatOrder();
  }
  function setCats(list) {
    const want = (list || []).filter(c => CATEGORIES.includes(c)).slice(0, MAX_CATS);
    pickedCats = want.slice();
    form.querySelectorAll('input[name="cats"]').forEach(i => { i.checked = want.includes(i.value); });
    markCatOrder();
    updateCatHint();
  }
  catPicker.addEventListener('change', e => {
    if (e.target.name !== 'cats') return;
    if (e.target.checked) {
      if (!pickedCats.includes(e.target.value)) {
        if (pickedCats.length >= MAX_CATS) {
          e.target.checked = false;
          showToast(`最多选择 ${MAX_CATS} 个应用分类`, undefined, 'err');
          return;
        }
        pickedCats.push(e.target.value);
      }
    } else {
      pickedCats = pickedCats.filter(c => c !== e.target.value);
    }
    markCatOrder();
    updateCatHint();
  });

  // ---- 搜索关键词（作者可增删的标签）----
  // 三条交互约定：
  //   1) 标题 / 分类填好后，没配过关键词就悄悄按它们配几个（不打断填写）
  //   2) 作者一旦动过手（加过、删过），就不再自动生成 —— 别跟人抢方向盘
  //   3) 「自动生成」是显式动作：按当前内容重算一份整组替换，作者不满意再改
  const kwChips = $('kwChips');
  const kwInput = $('kwInput');
  const kwHidden = $('kwHidden');
  const KW_MAX_UI = 6;
  const KW_MAXLEN_UI = 12;
  let kwList = [];
  let kwTouched = false;   // 作者动过手（增删）→ 不再自动补
  let kwSig = '';          // 上次自动生成时的「标题|分类」签名，避免每敲一个字都请求

  function syncKw() {
    if (kwHidden) kwHidden.value = JSON.stringify(kwList);
    if (kwChips) {
      kwChips.innerHTML = kwList.map((k, i) =>
        `<span class="kw-chip"><b>${escapeHtml(k)}</b><button type="button" data-kw="${i}" aria-label="删除关键词">✕</button></span>`
      ).join('');
    }
  }
  function setKeywords(list) {
    kwList = (list || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, KW_MAX_UI);
    syncKw();
  }
  function addKeyword(word) {
    const k = String(word || '').replace(/[<>]/g, '').trim().slice(0, KW_MAXLEN_UI);
    if (!k) return;
    if (kwList.some(x => x.toLowerCase() === k.toLowerCase())) return;
    if (kwList.length >= KW_MAX_UI) { showToast(`最多 ${KW_MAX_UI} 个关键词`, undefined, 'err'); return; }
    kwList.push(k);
    kwTouched = true;
    syncKw();
  }
  function commitKwInput() {
    const raw = (kwInput && kwInput.value || '').trim();
    if (!raw) return;
    raw.split(/[,，、\s]+/).filter(Boolean).forEach(addKeyword);
    kwInput.value = '';
  }
  if (kwChips) kwChips.addEventListener('click', e => {
    const btn = e.target.closest('button[data-kw]');
    if (!btn) return;
    kwList.splice(Number(btn.dataset.kw), 1);
    kwTouched = true;
    syncKw();
  });
  if (kwInput) {
    kwInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === '、') {
        e.preventDefault();
        commitKwInput();
      } else if (e.key === 'Backspace' && !kwInput.value && kwList.length) {
        // 空输入框里退格 = 删掉最后一个胶囊（标签输入的常规手感）
        kwList.pop();
        kwTouched = true;
        syncKw();
      }
    });
    kwInput.addEventListener('blur', commitKwInput);
  }
  // ---- 标题两框合一 ----
  // 表单里是「作品名字 wname（最长 20，汉字/全角算 2）+ 一句话介绍 wtag（≤20 字）」两个框，
  // 存库仍是一个 title 字段：提交/存草稿时拼成「名字 介绍」。
  // 分隔符只用一个空格，不用标点：卡片标题少一个字符更短，读起来也不像句子被截断。
  const TITLE_SEP = ' ';
  function workTitleVal() {
    const n = ((form.wname && form.wname.value) || '').trim();
    const t = ((form.wtag && form.wtag.value) || '').trim();
    return n + (t ? TITLE_SEP + t : '');
  }
  // 编辑/草稿回填：整条标题进「作品名字」框、介绍框留空 —— 哪儿该断由作者自己切，
  // 渲染时不再猜。传作品对象时优先用存下来的拆分（w.titleName / w.titleTag），
  // 这样作者手切的两行下次打开、前台卡片都还原得住；传字符串（极速填写 / AI 识别）照旧整条进名字框。
  // 注意：名字框不再用 HTML maxlength（它只数字符、数不了宽度），加权上限由下面的 input 监听把关，
  // 程序带入的超长老值不截断，保存原样保留（服务端保存标题时还有同口径兜底）。
  // 名字上限（2026-11-13）：最长 20，汉字/全角算 2、其他算 1。
  const WNAME_MAX = 20;
  const WIDE_RE = /[\u2E80-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFFEF]/;
  const wideLen = s => { let n = 0; for (const ch of String(s)) n += WIDE_RE.test(ch) ? 2 : 1; return n; };
  const wideSlice = (s, max) => {
    let n = 0, out = '';
    for (const ch of String(s)) {
      const w = WIDE_RE.test(ch) ? 2 : 1;
      if (n + w > max) break;
      n += w; out += ch;
    }
    return out;
  };
  if (form.wname) form.wname.addEventListener('input', () => {
    if (wideLen(form.wname.value) > WNAME_MAX) form.wname.value = wideSlice(form.wname.value, WNAME_MAX);
  });
  function fillWorkTitle(w) {
    const src = (w && typeof w === 'object') ? w : { title: w };
    // maxlength（名字 20 加权 / 介绍 20）只管手输；回填的老标题可能超上限，
    // 临时把上限放宽到当前长度，否则作者改名字尾巴时键盘敲不进字（值已顶满上限）。
    const put = (el, v, max) => {
      if (!el) return;
      el.value = v;
      el.maxLength = Math.max(max, v.length);
    };
    put(form.wname, String(src.titleName || src.title || '').trim(), WNAME_MAX);
    put(form.wtag, String(src.titleTag || '').trim(), 20);
  }
  // 极速填写 / AI 识别：外部页面标题常是「名字 介绍」拼法，帮作者预切一刀（填的是新表单，
  // 作者会过目再提交）。只认空格且第二段以中文开头，防「敲敲键 KeyQiao，…」「OB Commander」被切半。
  // 名字段放宽到加权 20（汉字算 2），与新上限一致；超加权 20 的第一段不认，整条进名字框。
  function splitWorkTitle(t) {
    const s = String(t || '').trim();
    const m = s.match(/^([^\s-]{1,20})\s+(.{1,20})$/);
    if (m && CJK_RE.test(m[2][0]) && (CJK_RE.test(m[1]) || m[1].length >= 3) && wideLen(m[1]) <= WNAME_MAX) return [m[1], m[2]];
    return [s, ''];
  }

  // 关键词建议：服务端纯规则生成（见 keywords.js），不花 AI 额度
  async function suggestKeywords(force) {
    const title = workTitleVal();
    const prompt = (form.prompt.value || '').trim();
    const cats = selectedCats();
    const sig = title + '|' + cats.join('/');
    if (!title && !prompt && !cats.length) return;
    if (!force && (sig === kwSig || kwTouched || kwList.length)) return;
    kwSig = sig;
    try {
      const r = await fetch('/api/work/keywords', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, prompt, categories: cats, types: selectedTypes() })
      });
      if (!r.ok) return;
      const d = await r.json();
      const list = Array.isArray(d.keywords) ? d.keywords : [];
      if (!list.length) return;
      if (force) {
        setKeywords(list);
        kwTouched = false;
        showToast(`已按标题和分类配了 ${list.length} 个关键词，可改可删`);
      } else if (!kwTouched && !kwList.length) {
        setKeywords(list);
      }
    } catch { /* 生成失败就留空，服务端提交时还会再配一次 */ }
  }
  // 标题失焦时悄悄配一次（只在还没配过、作者也没手动改过时生效）
  ['wname', 'wtag'].forEach(k => {
    if (form[k]) form[k].addEventListener('blur', () => { if (!kwTouched && !kwList.length) suggestKeywords(false); });
  });
  const kwRegenBtn = $('kwRegen');
  if (kwRegenBtn) kwRegenBtn.addEventListener('click', () => suggestKeywords(true));
  // 新分类：回车确认后先创建，再自动勾选
  newCatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmNewCat(); }
  });
  newCatInput.addEventListener('blur', () => { if (!newCatInput.value.trim()) newCatInput.style.display = 'none'; });
  async function confirmNewCat() {
    const name = newCatInput.value.trim();
    if (!name) { newCatInput.style.display = 'none'; return; }
    try {
      const r = await fetch('/api/categories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (err.error !== '分类已存在') { showToast(err.error || '新增分类失败', undefined, 'err'); return; }
      }
      await loadCategories(); // 内部会重新渲染胶囊
      const box = [...form.querySelectorAll('input[name="cats"]')].find(i => i.value === name);
      if (box) {
        if (!box.checked && pickedCats.length >= MAX_CATS) {
          showToast(`最多选择 ${MAX_CATS} 个应用分类`, undefined, 'err');
        } else {
          box.checked = true;
          if (!pickedCats.includes(name)) pickedCats.push(name);
        }
      }
      markCatOrder();
      updateCatHint();
      newCatInput.style.display = 'none';
      newCatInput.value = '';
    } catch { showToast('新增分类失败', undefined, 'err'); }
  }
  renderCatPickerFn = renderCatPicker;
  renderCatPicker();

  // ---- 1 分钟极速填写：粘贴介绍 / 从网址读取，都只回填候选值，绝不自动提交 ----
  // 形态胶囊默认会勾第一个，那种「用户没碰过」的状态不算已填，AI 可以直接替换。
  let typesTouched = false;
  const typePickerBox = $('typePicker');
  if (typePickerBox) typePickerBox.addEventListener('change', e => {
    if (e.target && e.target.name === 'types') typesTouched = true;
  });
  const aiFillBox = $('aiFillBox');
  const aiFillToggle = $('aiFillToggle');
  const aiFillBody = $('aiFillBody');
  const aiFillText = $('aiFillText');
  const aiFillUrl = $('aiFillUrl');
  const aiFillGo = $('aiFillGo');
  const aiFillStatus = $('aiFillStatus');
  const aiFillOverwrite = $('aiFillOverwrite');
  const aiFillCover = $('aiFillCover');
  const aiFillCoverBtn = $('aiFillCoverBtn');
  if (aiFillBox && aiFillToggle && aiFillBody && aiFillGo && aiFillText && aiFillUrl) {
    let aiMode = 'text';
    let pendingCover = null;
    const aiStatus = (msg, kind) => {
      aiFillStatus.textContent = msg || '';
      aiFillStatus.className = 'ai-fill-status' + (kind ? ' is-' + kind : '');
    };
    const flash = el => {
      if (!el) return;
      el.classList.remove('ai-fill-flash');
      void el.offsetWidth;              // 强制重排，连续识别时动画能重播
      el.classList.add('ai-fill-flash');
    };
    aiFillToggle.addEventListener('click', () => {
      const open = aiFillBody.hidden;
      aiFillBody.hidden = !open;
      aiFillBox.classList.toggle('is-open', open);
      aiFillToggle.setAttribute('aria-expanded', String(open));
      if (open) (aiMode === 'text' ? aiFillText : aiFillUrl).focus();
    });
    document.querySelectorAll('.ai-fill-tab').forEach(btn => btn.addEventListener('click', () => {
      aiMode = btn.dataset.aimode;
      document.querySelectorAll('.ai-fill-tab').forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      $('aiFillPaneText').hidden = aiMode !== 'text';
      $('aiFillPaneUrl').hidden = aiMode !== 'url';
      aiFillGo.textContent = aiMode === 'url' ? '读取网站并填表' : '识别并回填';
      aiStatus('');
      aiFillCover.hidden = true;
      pendingCover = null;
      (aiMode === 'text' ? aiFillText : aiFillUrl).focus();
    }));
    // 把服务端的候选值写进表单；网址模式额外填网站地址，并把 og:image 留给用户自己决定要不要当封面
    const applyFill = d => {
      const overwrite = !!(aiFillOverwrite && aiFillOverwrite.checked);
      const applied = [], skipped = [];
      const put = (label, el, val) => {
        if (!val || !el) return;
        if (!overwrite && el.value.trim()) { skipped.push(label); return; }
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true })); // 草稿 / Markdown 预览同步
        flash(el);
        applied.push(label);
      };
      // 名称可能自带「名字，介绍」结构，能拆就拆进两个框，拆不开整段落名字框
      {
        const parts = splitWorkTitle(d.name || '');
        if (parts[1]) {
          put('作品名字', form.wname, parts[0]);
          put('一句话介绍', form.wtag, parts[1]);
        } else {
          put('作品名字', form.wname, d.name || '');
        }
      }
      put('作品介绍', form.prompt, d.summary || '');
      if (Array.isArray(d.categories) && d.categories.length) {
        if (!overwrite && selectedCats().length) skipped.push('应用分类');
        else { setCats(d.categories); applied.push('应用分类'); flash($('catPicker')); }
      }
      const curTypes = selectedTypes();
      const isDefaultTypes = !typesTouched && curTypes.length === 1 && curTypes[0] === TYPES[1];
      if (Array.isArray(d.types) && d.types.length) {
        if (!overwrite && !isDefaultTypes && curTypes.length) skipped.push('作品形态');
        else { setSelectedTypes(d.types); applied.push('作品形态'); flash(typePickerBox); }
      }
      // 关键词：AI 识别时按识别出来的名字 / 简介配的词，勾了「覆盖」就整组替换
      if (Array.isArray(d.keywords) && d.keywords.length) {
        if (!overwrite && kwList.length) skipped.push('搜索关键词');
        else { setKeywords(d.keywords); kwTouched = true; applied.push('搜索关键词'); flash($('kwEditor')); }
      }
      if (d.site && d.site.url) {
        const webInput = form.querySelector('input[data-ltype="Web"]');
        if (webInput) {
          if (!overwrite && webInput.value.trim()) skipped.push('网站地址');
          else {
            webInput.value = d.site.url;
            webInput.dispatchEvent(new Event('input', { bubbles: true }));
            flash(webInput);
            applied.push('网站地址');
          }
        }
      }
      const bits = [];
      if (applied.length) bits.push('已回填：' + applied.join('、') + '。');
      if (skipped.length) bits.push('已填的 ' + skipped.join('、') + ' 保持不变，想替换请勾「覆盖已填内容」。');
      if (Array.isArray(d.missing) && d.missing.length) bits.push('没认出来：' + d.missing.join('、') + '，留空了自己填。');
      if (d.degraded) bits.push('AI 暂不可用（' + (d.reason || '已降级') + '），这版是关键词粗识别，请重点核对。');
      if (d.notice) bits.push(d.notice + '。');
      if (d.cover && d.cover.dataUrl) bits.push('检测到网站图片，可点「用网站图片做封面」。');
      if (!applied.length && !skipped.length) bits.push('没提取到可用信息，手动填一下吧。');
      bits.push('没替你提交，检查完再点下面的按钮。');
      aiStatus(bits.join(''), d.degraded ? 'warn' : 'ok');
      pendingCover = d.cover && d.cover.dataUrl ? d.cover : null;
      aiFillCover.hidden = !pendingCover;
    };
    if (aiFillCoverBtn) aiFillCoverBtn.addEventListener('click', () => {
      if (!pendingCover) return;
      fetch(pendingCover.dataUrl).then(r => r.blob()).then(blob => {
        const mime = pendingCover.mime || 'image/jpeg';
        const ext = mime.split('/')[1].replace('jpeg', 'jpg');
        const file = new File([blob], 'website-cover.' + ext, { type: mime });
        if (galleryItems.length >= MAX_GALLERY_ITEMS) {
          showToast(`作品图片最多 ${MAX_GALLERY_ITEMS} 张，先删一张再试`, undefined, 'err');
          return;
        }
        // 插到列表第 0 位 → 自动成为首图/封面
        galleryItems.unshift({ kind: 'new', file, src: URL.createObjectURL(file) });
        renderGalleryPreviews();
        syncCoverFromGallery();
        aiFillCover.hidden = true;
        showToast('已把网站图片加为首图（封面），建议换成首页截图', undefined, 'ok');
      }).catch(() => showToast('封面读取失败，请手动上传', undefined, 'err'));
    });
    // ---- 读取进度卡：已用秒数 + 步骤清单 + 顶部细进度条 ----
    // 接口是一次性返回、拿不到真实进度，所以步骤推进按典型耗时模拟：
    // 网址模式下抓网页通常几秒内完成，之后主要在等 AI；收到响应立刻全部打勾。
    const aiProgress = $('aiFillProgress');
    const aiProgressBar = $('aiProgressBar');
    const aiProgressTitle = $('aiProgressTitle');
    const aiProgressTime = $('aiProgressTime');
    const aiProgressSteps = $('aiProgressSteps');
    let progressTimer = null;
    const stopProgress = () => {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      if (aiProgress) aiProgress.hidden = true;
    };
    const startProgress = (mode, url) => {
      if (!aiProgress || !aiProgressSteps) return;
      const steps = mode === 'url'
        ? ['抓取网页，读标题与描述', 'AI 提取名字、介绍与分类', '整理关键词与封面候选']
        : ['AI 识别介绍文字', '提取名字、简介与分类'];
      let host = '';
      if (mode === 'url' && url) { try { host = new URL(url).hostname; } catch { host = ''; } }
      aiProgressTitle.textContent = host ? 'AI 正在读取 ' + host : 'AI 正在识别介绍';
      aiProgressSteps.innerHTML = steps.map(s =>
        '<li><span class="dot" aria-hidden="true"></span><span>' + s + '</span></li>').join('');
      const lis = [...aiProgressSteps.children];
      const mark = i => lis.forEach((li, idx) => {
        li.classList.toggle('is-done', idx < i);
        li.classList.toggle('is-active', idx === i);
      });
      mark(0);
      const step2At = mode === 'url' ? 2500 : Infinity; // 第 1 步完成的估算时间
      const t0 = Date.now();
      let advanced = false;
      aiProgressTime.textContent = '已用 0 秒';
      aiProgressBar.style.width = '3%';
      aiProgress.hidden = false;
      progressTimer = setInterval(() => {
        const ms = Date.now() - t0;
        aiProgressTime.textContent = '已用 ' + Math.floor(ms / 1000) + ' 秒';
        aiProgressBar.style.width = Math.min(90, 3 + ms / 1000 * 4) + '%';
        if (!advanced && ms >= step2At && lis.length > 1) { advanced = true; mark(1); }
      }, 500);
    };
    // 成功收尾：全部打勾 + 进度条拉满，停半秒让用户看见，再收回卡片
    const finishProgress = () => {
      if (!aiProgress || aiProgress.hidden) return;
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      [...aiProgressSteps.children].forEach(li => { li.classList.remove('is-active'); li.classList.add('is-done'); });
      aiProgressBar.style.width = '100%';
      setTimeout(stopProgress, 650);
    };
    aiFillGo.addEventListener('click', async () => {
      const isUrl = aiMode === 'url';
      const text = aiFillText.value.trim();
      const url = aiFillUrl.value.trim();
      if (isUrl ? !url : text.length < 8) {
        aiStatus(isUrl ? '先填作品网址' : '至少写 8 个字再识别', 'err');
        (isUrl ? aiFillUrl : aiFillText).focus();
        return;
      }
      aiFillGo.disabled = true;
      aiStatus(isUrl ? '正在读取网站…' : '正在识别…');
      startProgress(aiMode, url);
      aiFillCover.hidden = true;
      pendingCover = null;
      try {
        const r = await fetch(isUrl ? '/api/work/parse-url' : '/api/work/parse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isUrl ? { url } : { text })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { stopProgress(); aiStatus(d.error || '识别失败，请手动填写', 'err'); return; }
        finishProgress();
        applyFill(d);
      } catch {
        stopProgress();
        aiStatus('网络异常，识别没成功，请手动填写', 'err');
      } finally {
        aiFillGo.disabled = false;
      }
    });
  }

  // 宣传图统一为一个「有序列表」，支持拖拽/箭头调整顺序：
  //   { kind:'old', url }  编辑模式下服务器上已有的图
  //   { kind:'new', file, src }  本次新选/粘贴的图
  let galleryItems = [];
  let originalImages = []; // 编辑模式：服务器上原有的宣传图（用于计算删除项）
  let qrCleared = false;   // 编辑模式：二维码被删除
  let pasteTarget = 'images'; // 当前粘贴目标：images / qrcode（封面不再单独传，跟随第一张作品图）

  // ---- 「第一张图当首图」----
  // 作品图片列表的第 0 项就是封面：加图 / 拖动排序 / 删图时自动把第一张塞进封面位，
  // 作者单独传过封面（coverAutoSet=false）后就不再联动。
  let coverAutoSet = true;     // 封面是否跟着第一张作品图走
  let coverTakenFrom = null;   // 当前封面取自哪一张作品图（对象引用相等才剔除，防误伤）
  let syncingCover = false;    // 自动塞封面触发的 change 事件不算「手动选封面」

  // 要发给服务端的宣传图列表：封面自动落在第一张图上时把第 0 项剔除，
  // 否则同一张图既是封面又在宣传图里，详情页会重复展示
  function gallerySendItems() {
    if (!coverAutoSet || !galleryItems.length) return galleryItems;
    return coverTakenFrom === galleryItems[0] ? galleryItems.slice(1) : galleryItems;
  }

  // 把封面同步成第一张作品图（加图 / 排序 / 删图后调用）
  function syncCoverFromGallery() {
    if (!coverAutoSet || syncingCover) return;
    const first = galleryItems[0];
    if (!first) { coverTakenFrom = null; return; }
    if (first.kind === 'new') {
      if (form.image.files[0] === first.file) { coverTakenFrom = first; return; }
      syncingCover = true;
      const ok = setFileInput(form.image, first.file);   // 触发 change：表单级监听会跟着存草稿
      syncingCover = false;
      if (ok) coverTakenFrom = first;
      return;
    }
    // 已有图（编辑 / 草稿续填）：封面地址和第一张一致就不用动
    if (!form.image.files.length && coverUrl === first.url) { coverTakenFrom = first; return; }
    if (coverTakenFrom === first) return;   // 已经取回中
    // 服务端图取回来当封面文件，提交时作为新封面传上去
    fetch(first.url).then(r => r.blob()).then(blob => {
      if (!coverAutoSet || galleryItems[0] !== first) return;   // 期间列表又变了就作废
      const f = new File([blob], 'cover.jpg', { type: blob.type || 'image/jpeg' });
      syncingCover = true;
      const ok = setFileInput(form.image, f);
      syncingCover = false;
      if (!ok) return;
      coverTakenFrom = first;
      coverUrl = first.url;
    }).catch(() => {});
  }

  // ---- 服务端草稿（登录用户）----
  // 匿名用户没有账号可挂，仍走浏览器本地草稿（localStorage），换设备就没了。
  // 登录用户的草稿存在服务端、图片一起存：换设备/换浏览器接着填，图不用重挑。
  let draftId = null;      // 正在编辑的草稿 id（null = 还没建）
  let coverUrl = '';       // 服务端已有的封面（草稿续填或刚才保存上来的）
  let qrUrl = '';          // 服务端已有的二维码
  let draftTimer = null;   // 输入防抖
  let draftBusy = false;   // 串行化：同一时刻只跑一个保存请求
  let draftAgain = false;  // 保存期间又有改动 → 完事再来一次
  let draftMax = 3;        // 服务端草稿上限（/api/drafts 会回真实值，这里只是兜底）

  // ---- 粘贴上传 ----
  function setPasteTarget(t) {
    pasteTarget = t;
    document.querySelectorAll('.upload-dropzone[data-paste]').forEach(el => {
      el.classList.toggle('paste-active', el.dataset.paste === t);
    });
  }

  // 从剪贴板事件里取第一张图片
  function clipboardImage(cd) {
    if (!cd) return null;
    for (const it of [...(cd.items || [])]) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
    for (const f of [...(cd.files || [])]) if (f.type && f.type.startsWith('image/')) return f;
    return null;
  }

  // 把 File 塞进 <input type="file">，后续预览/提交逻辑完全复用
  function setFileInput(input, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) { return false; }
  }

  function applyPastedImage(target, file) {
    if (!file) return;
    // 二维码字段隐藏时（网站 / App 等形态）自动落到作品图片列表
    if (target === 'qrcode' && $('qrField').style.display === 'none') target = 'images';
    // 小程序码：塞进 form.qrcode，预览与 qr-guard 体检都由它的 change 处理器接管
    if (target === 'qrcode') {
      if (!setFileInput(form.qrcode, file)) { showToast('这张图没粘进来，请点上传按钮选图', undefined, 'err'); return; }
      showToast('已粘贴小程序码', undefined, 'ok');
      return;
    }
    if (galleryItems.length >= MAX_GALLERY_ITEMS) { showToast(`作品图片最多 ${MAX_GALLERY_ITEMS} 张`, undefined, 'err'); return; }
    addGalleryFile(file);
    showToast(`已粘贴作品图片 ${galleryItems.length}/${MAX_GALLERY_ITEMS}${galleryItems.length === 1 ? '，已自动设为封面' : ''}`, undefined, 'ok');
  }

  // 按作品形态显示/隐藏 链接 / 二维码 字段，并切换预览比例（支持多选；全部取消时先都收起）
  function applyTypeFields() {
    const types = selectedTypes();
    const rule = types.length ? ruleOfTypes(types) : { link: false, qr: false };
    const nonMini = types.filter(t => t !== '小程序');
    $('linkField').style.display = nonMini.length ? 'block' : 'none';
    $('qrField').style.display = rule.qr ? 'block' : 'none';
    // Web 形态的「网站地址」就是作品入口，官网字段纯属重复 → 勾了 Web 就隐藏
    $('siteField').style.display = types.includes('Web') ? 'none' : 'block';
    renderLinkInputs(types);
    // 移动端形态：宣传图缩略图按手机竖屏比例
    const mobile = isMobileTypes(types);
    $('galleryPreviews').classList.toggle('mobile', mobile);
  }
  applyTypeFieldsFn = applyTypeFields;

  // ---- 作品当前状态（已上线 / 等平台上架审核 / 还在做）----
  // 这个选择决定提交后的去向：live 进主列表；reviewing 进「即将上线」且链接锁住；
  // wip 进「即将上线」收催更，并且不要求链接/二维码。
  function currentStage() {
    const el = form.querySelector('input[name="stage"]:checked');
    return el ? el.value : 'live';
  }
  function applyStageFields() {
    const stage = currentStage();
    const wip = stage === 'wip';
    $('wipFields').style.display = wip ? 'block' : 'none';
    // 状态说明统一显示在胶囊下面一行（选项里不再放两行文案，收成一行）
    const hint = $('stageHint');
    if (hint) {
      hint.style.display = 'block';
      hint.textContent = stage === 'live'
        ? '已经上线：现在就能打开体验，进主列表。'
        : wip
          ? '还在做：先发预告，攒一批催更的人；链接和二维码可以留空，介绍里写清做到哪一步（至少 8 个字），每人最多同时挂 2 张预告卡。'
          : '等平台上架审核：商店/平台审核中，链接还打不开；链接照常填，展示时会锁住不给点，通过后点「我上线了」转到正式列表。';
    }
  }
  $('stagePicker').addEventListener('change', applyStageFields);
  $('progressRange').addEventListener('input', e => {
    $('progressVal').textContent = e.target.value + '%';
  });
  applyStageFields();

  // 追加一张新图（保持在列表末尾，可在预览里拖动调整位置）
  function addGalleryFile(f) {
    if (!f || !f.type || !f.type.startsWith('image/')) return;
    if (galleryItems.length >= MAX_GALLERY_ITEMS) return;
    galleryItems.push({ kind: 'new', file: f, src: URL.createObjectURL(f) });
    renderGalleryPreviews();
    syncCoverFromGallery();   // 第一张图自动当封面
  }

  // 把第 from 项移动到第 to 项的位置
  function moveGalleryItem(from, to) {
    if (from === to || from < 0 || to < 0 || from >= galleryItems.length || to >= galleryItems.length) return;
    const [it] = galleryItems.splice(from, 1);
    galleryItems.splice(to, 0, it);
    renderGalleryPreviews();
    syncCoverFromGallery();   // 排了谁在第一位，谁就是封面
    scheduleDraftSave(400);
  }

  let dragFrom = -1; // 拖拽起始位置

  // ---- 首图裁剪：把第一张作品图框选成 4:3（列表卡的原生比例）----
  // 全程浏览器本地 canvas 完成，不动服务端。裁完替换列表第 0 项的文件，
  // 之后 syncCoverFromGallery / 草稿保存 / 提交照旧走原链路。
  // 注意：详情页大图是 contain 完整展示，裁剪只影响列表卡——所以只在首图（第 0 项）提供入口。
  const CROP_RATIO = 4 / 3;
  const clampCrop = (v, a, b) => Math.max(a, Math.min(b, v));
  let cropMask = null, cropRef = null, cropTarget = -1;

  function closeCropModal() {
    if (cropMask) { cropMask.hidden = true; cropRef.img.src = ''; }
    cropTarget = -1;
  }

  function ensureCropModal() {
    if (cropRef) return cropRef;
    cropMask = document.createElement('div');
    cropMask.className = 'crop-mask';
    cropMask.hidden = true;
    cropMask.innerHTML =
      '<div class="crop-modal" role="dialog" aria-modal="true" aria-label="裁剪首图">' +
        '<div class="crop-head"><b>裁剪首图为 4:3</b><button type="button" class="crop-close" title="关闭">✕</button></div>' +
        '<div class="crop-stage-wrap"><div class="crop-stage">' +
          '<img class="crop-img" alt="" draggable="false" />' +
          '<div class="crop-box"><span class="crop-tag">4:3</span><i class="crop-handle"></i></div>' +
        '</div></div>' +
        '<div class="crop-foot"><span class="crop-hint">拖动选框换位置，拖右下角圆点调大小</span>' +
          '<div class="crop-btns"><button type="button" class="crop-btn crop-cancel">取消</button>' +
          '<button type="button" class="crop-btn crop-ok">应用裁剪</button></div></div>' +
      '</div>';
    document.body.appendChild(cropMask);
    const img = cropMask.querySelector('.crop-img');
    const stage = cropMask.querySelector('.crop-stage');
    const box = cropMask.querySelector('.crop-box');
    cropRef = { img, stage, box, pos: { x: 0, y: 0, w: 0 }, disp: { w: 0, h: 0 }, nat: { w: 0, h: 0 } };

    const applyBox = () => {
      const r = cropRef;
      r.box.style.left = r.pos.x + 'px';
      r.box.style.top = r.pos.y + 'px';
      r.box.style.width = r.pos.w + 'px';
      r.box.style.height = Math.round(r.pos.w / CROP_RATIO) + 'px';
    };
    const centerBox = () => {
      const r = cropRef;
      r.pos.w = Math.min(r.disp.w, Math.round(r.disp.h * CROP_RATIO));
      r.pos.x = Math.round((r.disp.w - r.pos.w) / 2);
      r.pos.y = Math.round((r.disp.h - r.pos.w / CROP_RATIO) / 2);
      applyBox();
    };
    // centerBox 要在 openCoverCrop 里调用（图片 onload 后才知道显示尺寸），挂到 cropRef 上跨函数用
    cropRef.centerBox = centerBox;

    let mode = null, sx = 0, sy = 0, sp = null;
    const onMove = e => {
      if (!mode) return;
      const r = cropRef;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'move') {
        r.pos.x = clampCrop(Math.round(sp.x + dx), 0, r.disp.w - r.pos.w);
        r.pos.y = clampCrop(Math.round(sp.y + dy), 0, r.disp.h - r.pos.w / CROP_RATIO);
      } else {
        const maxW = Math.min(r.disp.w - r.pos.x, (r.disp.h - r.pos.y) * CROP_RATIO);
        r.pos.w = clampCrop(Math.round(sp.w + dx), 48, maxW);
      }
      applyBox();
    };
    const onUp = () => { mode = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    const startDrag = (e, m) => {
      e.preventDefault(); e.stopPropagation();
      mode = m; sx = e.clientX; sy = e.clientY;
      sp = { ...cropRef.pos };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    box.addEventListener('pointerdown', e => { if (e.target.closest('.crop-handle')) return; startDrag(e, 'move'); });
    cropMask.querySelector('.crop-handle').addEventListener('pointerdown', e => startDrag(e, 'resize'));
    // 点遮罩空白处关闭（点弹窗内部不关）
    cropMask.addEventListener('pointerdown', e => { if (e.target === cropMask) closeCropModal(); });
    cropMask.querySelector('.crop-close').onclick = closeCropModal;
    cropMask.querySelector('.crop-cancel').onclick = closeCropModal;
    cropMask.querySelector('.crop-ok').onclick = applyCrop;
    return cropRef;
  }

  function openCoverCrop(i) {
    const it = galleryItems[i];
    if (!it) return;
    cropTarget = i;
    const r = ensureCropModal();
    r.img.onload = () => {
      r.nat.w = r.img.naturalWidth; r.nat.h = r.img.naturalHeight;
      const maxW = Math.min(window.innerWidth - 56, 860);
      const maxH = Math.max(240, Math.min(window.innerHeight * 0.52, 560));
      const s = Math.min(maxW / r.nat.w, maxH / r.nat.h, 1);
      r.disp.w = Math.round(r.nat.w * s); r.disp.h = Math.round(r.nat.h * s);
      r.stage.style.width = r.disp.w + 'px';
      r.stage.style.height = r.disp.h + 'px';
      r.centerBox();
    };
    r.img.src = it.kind === 'new' ? it.src : it.url;
    cropMask.hidden = false;
  }

  function applyCrop() {
    const r = cropRef;
    if (!r || !r.img.naturalWidth) return;
    const it = galleryItems[cropTarget];
    if (!it) { closeCropModal(); return; }
    const scale = r.nat.w / r.disp.w;
    const sx0 = Math.round(r.pos.x * scale), sy0 = Math.round(r.pos.y * scale);
    const sw = Math.round(r.pos.w * scale), sh = Math.round(r.pos.w / CROP_RATIO * scale);
    const outW = Math.min(sw, 1600), outH = Math.round(outW / CROP_RATIO);
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    cv.getContext('2d').drawImage(r.img, sx0, sy0, sw, sh, 0, 0, outW, outH);
    const isPng = (it.kind === 'new' ? it.file.type : '') === 'image/png';
    cv.toBlob(blob => {
      if (!blob) { showToast('裁剪失败，请重试', undefined, 'err'); return; }
      const base = ((it.kind === 'new' && it.file.name) || 'cover').replace(/\.[^.]+$/, '');
      const f = new File([blob], `${base}-4x3.${isPng ? 'png' : 'jpg'}`, { type: isPng ? 'image/png' : 'image/jpeg' });
      if (it.kind === 'new') URL.revokeObjectURL(it.src);
      galleryItems[cropTarget] = { kind: 'new', file: f, src: URL.createObjectURL(f) };
      renderGalleryPreviews();
      syncCoverFromGallery();   // 裁好的图重新走一遍封面同步
      scheduleDraftSave(400);
      closeCropModal();
      showToast('首图已裁成 4:3，列表里不再被自动裁切', undefined, 'ok');
    }, isPng ? 'image/png' : 'image/jpeg', 0.92);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && cropMask && !cropMask.hidden) closeCropModal(); });


  function renderGalleryPreviews() {
    const box = $('galleryPreviews');
    const total = galleryItems.length;
    // 每行最多 5 张；1~4 张时按实际张数平分整行（否则宽屏下右边全空、图被压成一条）；
    // 最少 3 列，免得只放 1 张时铺满整行变成一个巨大的预览
    box.style.setProperty('--gal-cols', Math.min(5, Math.max(3, total)));
    $('galleryText').innerHTML = total
      ? `已选 ${total}/${MAX_GALLERY_ITEMS} 张，点击可继续添加<br /><small>第一张就是封面 · 拖动可换顺序 · 点「裁剪」裁成 4:3</small>`
      : '添加作品图片<br /><small>第一张就是封面，支持多选</small>';
    box.innerHTML = galleryItems.map((it, i) => `
      <div class="gallery-thumb" draggable="true" data-index="${i}" title="${i === 0 ? '首图：这张会作为作品封面，拖动可换' : '拖动可调整顺序'}">
        <img src="${it.kind === 'old' ? it.url : it.src}" alt="" />
        <span class="gallery-order${i === 0 ? ' is-cover' : ''}">${i === 0 ? '首图' : i + 1}</span>
        ${i === 0 ? '<button type="button" class="gallery-crop" data-i="' + i + '" title="把首图裁成 4:3，列表展示更完整">裁剪</button>' : ''}
        <button type="button" class="gallery-move prev" data-move="${i}:-1" title="前移">‹</button>
        <button type="button" class="gallery-move next" data-move="${i}:1" title="后移">›</button>
        <button type="button" class="gallery-remove" data-i="${i}" title="删除这张">✕</button>
      </div>`).join('');

    box.querySelectorAll('.gallery-remove').forEach(btn => {
      btn.onclick = e => {
        e.preventDefault();
        const i = +btn.dataset.i;
        const [it] = galleryItems.splice(i, 1);
        if (it && it.kind === 'new') URL.revokeObjectURL(it.src);
        renderGalleryPreviews();
        syncCoverFromGallery();   // 删掉第一张后，新的第一张顶上来当封面
        scheduleDraftSave(400);
      };
    });
    box.querySelectorAll('.gallery-move').forEach(btn => {
      btn.onclick = e => {
        e.preventDefault();
        const [i, d] = btn.dataset.move.split(':').map(Number);
        moveGalleryItem(i, i + d);
      };
    });
    // 点缩略图放大看大图（排序/删除按钮各自有 onclick，互不影响）
    box.querySelectorAll('.gallery-thumb img').forEach(img => {
      img.onclick = e => { e.preventDefault(); openImgZoom(img.src); };
    });
    // 首图裁剪入口（只有第 0 张有，见 openCoverCrop）
    box.querySelectorAll('.gallery-crop').forEach(btn => {
      btn.onclick = e => { e.preventDefault(); openCoverCrop(+btn.dataset.i); };
    });

    // 拖拽排序（桌面端）
    box.querySelectorAll('.gallery-thumb').forEach(el => {
      el.addEventListener('dragstart', e => {
        dragFrom = +el.dataset.index;
        el.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(dragFrom)); // Firefox 需要
        } catch (_) {}
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        box.querySelectorAll('.gallery-thumb').forEach(x => x.classList.remove('drag-over'));
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (+el.dataset.index !== dragFrom) el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const to = +el.dataset.index;
        if (dragFrom >= 0 && dragFrom !== to) moveGalleryItem(dragFrom, to);
      });
    });
  }

  // ---- 二维码图本地体检 ----
  // 只挡「明显不是码」的情况（空白图 / 整片深色 / 只有一小块内容 / 图太小），
  // 圆形菊花码、标准二维码、拿不准的截图一律放行。判定逻辑在 qr-guard.js，这里只负责画提示。
  let qrCheckSeq = 0;   // 体检序号：期间换图/删图就把旧结果作废（不靠对象引用判断，DataTransfer 赋值后引用不保证相等）
  function hideQrTip() {
    qrCheckSeq++;
    const tip = $('qrGuardTip');
    if (tip) { tip.hidden = true; tip.textContent = ''; }
  }
  function inspectQr(file) {
    hideQrTip();                 // 内部会 ++，等于作废上一次还在跑的体检
    const seq = qrCheckSeq;
    if (!file || !window.QrGuard) return;
    window.QrGuard.inspect(file).then(res => {
      if (seq !== qrCheckSeq) return;   // 结果回来时已经换图 / 删图 / 重置了
      if (!res || res.level !== 'warn') return;
      const tip = $('qrGuardTip');
      if (!tip) return;
      tip.textContent = '⚠ ' + res.reason;
      tip.hidden = false;
    }).catch(() => { /* 体检失败不影响投稿 */ });
  }

  // 删除已上传的二维码，或清空本次选择
  $('qrClear').onclick = e => {
    e.preventDefault();
    form.qrcode.value = '';
    qrUrl = '';
    $('qrPreviewImg').removeAttribute('src');
    $('qrPreviewBox').style.display = 'none';
    hideQrTip();
    qrCleared = true;   // 编辑模式下：提交时真正删除服务器上的二维码
    showToast('已删除二维码', undefined, 'ok');
    scheduleDraftSave(300);
  };

  // 点预览图放大看大图（✕ 删除按钮不在 img 上，不受影响）
  $('qrPreviewImg').onclick = e => {
    e.preventDefault();
    openImgZoom($('qrPreviewImg').getAttribute('src'), '二维码预览');
  };

  // 投稿承诺两套文案：新投稿完整承诺（服务端记 agreeAt），编辑轻量重申（服务端记 agreeAtEdited）
  const AGREE_LABEL_NEW = '我已阅读并同意 <a href="/rules" target="_blank" rel="noopener">《作品规范》</a>，不放置个人微信、公众号、收款码、外链下载码等违规入口；确认这是本人创作或已获作者授权代发，截图与文字不侵犯他人著作权';
  const AGREE_LABEL_EDIT = '继续遵守 <a href="/rules" target="_blank" rel="noopener">《作品规范》</a>，本次修改后的内容由我负责';
  function setAgreeMode(mode) {
    const label = document.querySelector('label[for="agreeRules"]');
    if (label) label.innerHTML = mode === 'edit' ? AGREE_LABEL_EDIT : AGREE_LABEL_NEW;
    // 新投稿必须手动勾选（agreeAt 是合规凭据，预勾选会废掉证据效力）；编辑默认勾上，作者可自行取消
    $('agreeRules').checked = mode === 'edit';
    // 站长不显示承诺框：改自己的作品没有「向平台承诺」的对手方，代改别人的作品服务端本来就不记 agreeAtEdited。
    // 隐藏只是视觉处理，checkbox 仍保持勾选，提交校验和服务端 agreeAtEdited 照常走，不动合规链路。
    // 新投稿（mode='new'）永远显示：agreeAt 是合规凭据，站长投稿也要留。
    const agreeBox = document.querySelector('.agree-box');
    if (agreeBox) agreeBox.style.display = (mode === 'edit' && state.user && state.user.isSiteOwner) ? 'none' : '';
  }

  function resetUploadForm() {
    setAgreeMode('new');
    editId = null;
    repoBaseline = '';
    // 草稿状态整体归零：换弹窗内容时不能把上一份草稿的图和 id 带过去
    draftId = null;
    syncDraftDiscardBtn();   // 没有草稿就别显示「删除这份草稿」
    coverUrl = '';
    qrUrl = '';
    clearTimeout(draftTimer);
    draftAgain = false;
    $('modalTitle').textContent = '提交作品';
    // 审核规则不在表单顶部唠叨，留到点「提交」时的选择弹窗里再说
    $('formHint').textContent = state.user ? `作者：${state.user.nickname || state.user.username}` : '';
    $('formHint').style.display = state.user ? 'block' : 'none';
    $('authorField').style.display = state.user ? 'none' : 'block';
    form.reset();
    // 回填长标题时临时放宽过 maxlength（见 fillWorkTitle），新投稿前恢复建议上限
    if (form.wname) form.wname.maxLength = 20;
    if (form.wtag) form.wtag.maxLength = 20;
    updatePaidModelField(); // form.reset 会还原 radio 默认值，收费形式区一并收起
    newCatInput.style.display = 'none';
    newCatInput.value = '';
    const nti = $('newTypeInput');
    if (nti) { nti.style.display = 'none'; nti.value = ''; }
    setCats([]);
    setKeywords([]);      // 关键词跟着清空，并恢复「可以自动生成」的状态
    kwTouched = false;
    kwSig = '';
    if (kwInput) kwInput.value = '';
    $('qrPreviewBox').style.display = 'none';
    hideQrTip();   // 换作品/清空表单时把上一张码的体检结论一起收掉
    $('submitBtn').textContent = '提交';
    galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
    galleryItems = [];
    originalImages = [];
    qrCleared = false;
    coverAutoSet = true;      // 封面重新跟着第一张作品图走
    coverTakenFrom = null;
    renderGalleryPreviews();
    // 状态回到默认「已上线」，预告字段一并收起
    const liveRadio = form.querySelector('input[name="stage"][value="live"]');
    if (liveRadio) liveRadio.checked = true;
    $('progressRange').value = 40;
    $('progressVal').textContent = '40%';
    $('etaInput').value = '';
    applyStageFields();
    setSelectedTypes(['Web']);
    setPasteTarget('images');
    // 「一眼看懂」回到收起态，计数归零（form.reset 已经清空 value，但计数是 JS 画的）
    qlUI.setOpen(false);
    qlUI.paint();
  }
  resetUploadForm = resetUploadForm; // 暴露给外部（afterAuth 用）
  restoreUploadDraft = restoreDraft;
  clearUploadDraft = clearDraft;

  // 角标校准：草稿只在登录用户这边存在（匿名走 localStorage，没有「份数」概念）。
  // 增删草稿、登录/退出、打开投稿表单之后都调一次，宁可多一个轻量 GET 也不让数字骗人。
  refreshDraftHint = async function () {
    if (!state.user) { draftHint = 0; paintDraftHint(); return; }
    try {
      const data = await (await fetch('/api/drafts', { cache: 'no-store' })).json();
      draftHint = ((data && data.items) || []).length;
      paintDraftHint();
    } catch { /* 拿不到就保持现状，别为了个角标打扰用户 */ }
  };

  // 「删除这份草稿」按钮：只有正在续填、或已经自动存出草稿（draftId 有值）时才出现。
  // 选择层里的 ✕ 只在 2 份以上才看得到，单份草稿以前根本没有删除出口。
  function syncDraftDiscardBtn() {
    const btn = $('draftDiscard');
    if (btn) btn.style.display = (state.user && draftId) ? '' : 'none';
    syncDraftBar();
  }

  // 表单顶部草稿条：有草稿在手上就告诉用户在续填哪一份，并给「再开一份」的出口。
  // 只有 1 份草稿时 openUpload 会直接续填、不弹选择层，没有这条就变成「想开第二件只能覆盖旧草稿」。
  function syncDraftBar() {
    const bar = $('draftBar');
    if (!bar) return;
    if (!state.user || !draftId) { bar.style.display = 'none'; return; }
    const t = workTitleVal();
    const txt = $('draftBarTxt');
    if (txt) {
      txt.innerHTML = `正在续填草稿${t ? `「<b>${escapeHtml(t.slice(0, 30))}</b>」` : ''}，改动自动保存`;
    }
    const nb = $('draftNewBtn');
    if (nb) {
      const full = draftHint >= draftMax;
      nb.disabled = full;
      nb.textContent = full ? `已存满 ${draftMax} 份` : '再开一份';
    }
    bar.style.display = '';
  }

  // ---- 关闭保护 + 草稿 ----
  // 分两条路：登录用户存服务端（最多 3 份、跨设备、连图片一起存），
  // 匿名用户没有账号可挂，只能存浏览器本地 localStorage（换设备就没了）。
  const DRAFT_KEY = 'upload_draft';
  // 「一眼看懂」五件套：读出来 / 填回去。草稿、编辑回填、提交前都走这一份口径，
  // 免得三处各写一遍字段名，漏一个就白填。
  const QL_FIELDS = ['positioning', 'problem', 'audience', 'steps', 'diff'];
  function quickLookValues() {
    const out = {};
    QL_FIELDS.forEach(k => { out[k] = form[k] ? String(form[k].value || '') : ''; });
    return out;
  }
  function setQuickLookValues(src) {
    if (!src) return false;
    let any = false;
    QL_FIELDS.forEach(k => {
      const el = form[k];
      if (!el) return;
      let v = src[k];
      if (k === 'steps' && Array.isArray(v)) v = v.join('\n');   // 服务端存数组，表单里是一行一步
      el.value = v == null ? '' : String(v);
      if (el.value.trim()) any = true;
    });
    qlUI.setOpen(any);   // 有内容就展开，别让编辑老作品的人以为字段丢了
    qlUI.paint();
    return any;
  }
  let localDraftTimer = null;
  function uploadDirty() {
    if (['wname', 'wtag', 'link', 'prompt', 'positioning', 'problem', 'audience', 'steps', 'diff']
      .some(k => form[k] && form[k].value.trim())) return true;
    if (form.image.files.length || (form.qrcode && form.qrcode.files.length)) return true;
    if (coverUrl || qrUrl) return true;
    if (galleryItems.length) return true;
    return false;
  }
  // ===== 本地草稿（匿名）=====
  function saveDraft() {
    if (editId || state.user) return; // 编辑模式 / 登录用户都不写本地草稿
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        types: selectedTypes(), title: workTitleVal(),
        // 名字 / 一句话介绍分开存一份：续填时两框各归各位（title 只用来判断"有没有填过东西"）
        titleName: (form.wname ? form.wname.value.trim() : ''),
        titleTag: (form.wtag ? form.wtag.value.trim() : ''),
        newType: $('newTypeInput').style.display !== 'none' ? $('newTypeInput').value.trim() : '',
        cats: selectedCats(), customCat: newCatInput.style.display !== 'none' ? newCatInput.value.trim() : '',
        keywords: kwList,
        openSource: (form.querySelector('input[name="openSource"]:checked') || {}).value || '',
        repo: form.repo.value,
        paid: (form.querySelector('input[name="paid"]:checked') || {}).value || '',
        paidModel: paidChoice().paidModel,
        lampPrice: form.lampPrice ? form.lampPrice.value : '',
        prompt: form.prompt.value, site: form.site.value, links: collectLinkValues(form), t: Date.now(),
        // 「一眼看懂」五件套：匿名草稿存本地，续填时不能白填一遍
        quick: quickLookValues()
      }));
    } catch {}
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
  function restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d) return false;
      const hasLink = (d.links && Object.keys(d.links).length) || (d.link || '').trim();
      if (!['title', 'prompt'].some(k => (d[k] || '').trim()) && !hasLink) return false;
      if (Array.isArray(d.types) && d.types.length) setSelectedTypes(d.types);
      else if (d.type) setSelectedTypes([d.type]);
      fillWorkTitle(d);
      setCats(Array.isArray(d.cats) && d.cats.length ? d.cats : (d.category ? [d.category] : []));
      setKeywords(Array.isArray(d.keywords) ? d.keywords : []);
      if (d.customCat) { newCatInput.style.display = 'block'; newCatInput.value = d.customCat; }
      else { newCatInput.style.display = 'none'; newCatInput.value = ''; }
      // 「＋ 新形态」起名输入框：草稿里存了名字就恢复显示
      {
        const nti = $('newTypeInput');
        if (nti && d.newType) { nti.style.display = 'block'; nti.value = d.newType; }
        else if (nti) { nti.style.display = 'none'; nti.value = ''; }
      }
      form.prompt.value = d.prompt || '';
      form.site.value = d.site || '';
      setQuickLookValues(d.quick);   // 老草稿没有 quick 字段，传 undefined 就是全部清零
      // 兼容旧草稿的单 link 字段：填进当前主形态的输入框
      if (d.links && Object.keys(d.links).length) pendingLinkValues = d.links;
      else if (d.link && d.link.trim()) {
        const t = ((d.types || []).filter(x => x !== '小程序')[0]) || 'Web';
        pendingLinkValues = { [t]: d.link.trim() };
      }
      pendingLinkValues = pendingLinkValues || null;
      const osDraft = form.querySelector(`input[name="openSource"][value="${d.openSource || ''}"]`);
      if (osDraft) osDraft.checked = true;
      const paidDraft = form.querySelector(`input[name="paid"][value="${d.paid || ''}"]`);
      if (paidDraft) paidDraft.checked = true;
      if (form.lampPrice && d.lampPrice) form.lampPrice.value = d.lampPrice;
      setPaidRadios(d.paid === '1' || d.paid === true, d.paidModel);
      updatePaidModelField();
      form.repo.value = d.repo || '';
      applyTypeFields();
      updateRepoFieldFn();
      return true;
    } catch { return false; }
  }

  // ===== 服务端草稿（登录用户）=====
  // 表单变化先防抖 1.2s 再存；选图/删图/关弹窗则立刻存。
  // 每次保存成功后把「本地新选的图」换成服务端地址，避免同一张图被反复上传。
  function scheduleDraftSave(delay) {
    if (editId || !state.user) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { syncDraft(); }, delay || 1200);
  }
  async function syncDraft() {
    if (!state.user || editId) return true;   // 这两种情况都不用服务端草稿
    if (!uploadDirty()) return true;
    if (draftBusy) { draftAgain = true; return true; }   // 串行：跑完再补一次
    draftBusy = true;
    try {
      const fd = new FormData();
      if (draftId) fd.set('draftId', draftId);
      fd.set('title', workTitleVal());
      // 拆分一起存：续填时「作品名字 / 一句话介绍」两框还原，不用再猜标题从哪儿断
      if (form.wname) fd.set('wname', form.wname.value);
      if (form.wtag) fd.set('wtag', form.wtag.value);
      fd.set('prompt', form.prompt.value);
      fd.set('site', form.site.value);
      // 「一眼看懂」五件套：steps 按原样传（一行一步），服务端统一拆成数组存
      const ql = quickLookValues();
      fd.set('positioning', ql.positioning);
      fd.set('problem', ql.problem);
      fd.set('audience', ql.audience);
      fd.set('diff', ql.diff);
      fd.set('steps', ql.steps);
      fd.set('repo', form.repo.value);
      fd.set('types', JSON.stringify(selectedTypes()));
      fd.set('categories', JSON.stringify(selectedCats()));
      fd.set('keywords', JSON.stringify(kwList));   // 草稿也存关键词，续填不用重配
      fd.set('links', JSON.stringify(collectLinkValues(form)));
      const osEl = form.querySelector('input[name="openSource"]:checked');
      fd.set('openSource', osEl ? osEl.value : '');
      const paidPick = paidChoice();
      fd.set('paid', paidPick.paid);
      fd.set('paidModel', paidPick.paidModel);
      fd.set('lampPrice', paidPick.paidModel === 'lamp' && form.lampPrice ? form.lampPrice.value : '');
      const stEl = form.querySelector('input[name="stage"]:checked');
      fd.set('stage', stEl ? stEl.value : 'live');
      fd.set('progress', $('progressRange').value);
      fd.set('eta', $('etaInput').value || '');

      // 宣传图：已有图（含之前存上来的）走 keepExisting，新选的按顺序追加。
      // 封面自动取自第一张图时，第 0 项不进宣传图（它单独走封面字段）
      const sendItems = gallerySendItems();
      const newFiles = sendItems.filter(it => it.kind === 'new');
      const keptUrls = sendItems.filter(it => it.kind === 'old').map(it => it.url);
      const removedImages = originalImages.filter(u => !keptUrls.includes(u));
      if (newFiles.length || removedImages.length) {
        fd.set('keepExisting', '1');
        if (removedImages.length) fd.set('removedImages', JSON.stringify(removedImages));
        let n = -1;
        fd.set('imageOrder', JSON.stringify(sendItems.map(it => it.kind === 'old' ? it.url : `__new__${++n}`)));
        for (let i = 0; i < newFiles.length; i++) {
          const g = await resizeImage(newFiles[i].file, 1600, 0.82);
          fd.append('images', g || newFiles[i].file, `gallery-${i}.jpg`);
        }
      }
      const coverFile = form.image.files[0];
      if (coverFile && coverFile.type && coverFile.type.startsWith('image/')) {
        const main = await resizeImage(coverFile, 1600, 0.85);
        const thumb = await resizeImage(coverFile, 960, 0.82);
        // 压缩失败就用原图，别让草稿丢封面
        fd.set('image', main || coverFile, 'cover.jpg');
        fd.set('thumb', thumb || main || coverFile, 'thumb.jpg');
      }
      const qrFile = form.qrcode.files[0];
      if (qrFile && qrFile.type && qrFile.type.startsWith('image/')) fd.set('qrcode', qrFile, 'qr.jpg');

      const res = await fetch('/api/drafts', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 存不上不该打断投稿：超上限要说清楚，其余静默（控制台留痕）
        if (data.code === 'draft-full') showToast(data.error, 4200, 'err');
        else console.warn('[draft]', data.error || res.status);
        return false;
      }
      if (data.draft && data.draft.id) {
        const isNewDraft = !draftId;
        draftId = data.draft.id;
        syncDraftDiscardBtn();   // 自动存出草稿了 → 允许在表单里直接删掉它
        if (isNewDraft) refreshDraftHint();   // 第一份草稿刚建上：角标该亮起来了
      }
      // 回写图片地址：本地 File 已经变成服务端图，下次保存不用再传一遍
      if (data.image) {
        coverUrl = data.image;
        form.image.value = '';
      }
      if (data.qrcode !== undefined) {
        qrUrl = data.qrcode || '';
        if (qrUrl) { form.qrcode.value = ''; $('qrPreviewImg').src = qrUrl; $('qrPreviewBox').style.display = 'block'; }
      }
      if ((data.image || Array.isArray(data.images)) && galleryItems.some(it => it.kind === 'new')) {
        galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
        const rest = Array.isArray(data.images) ? data.images : [];
        originalImages = rest.slice();
        // 封面跟着第一张图走时，把服务端封面拼回列表第 0 位（界面上它仍是「首图」）
        galleryItems = (data.image && coverAutoSet)
          ? [{ kind: 'old', url: data.image }].concat(rest.map(u => ({ kind: 'old', url: u })))
          : rest.map(u => ({ kind: 'old', url: u }));
        if (data.image && coverAutoSet) coverTakenFrom = galleryItems[0];
        renderGalleryPreviews();
      }
      return true;
    } catch (e) {
      console.warn('[draft]', e.message);
      return false;
    } finally {
      draftBusy = false;
      if (draftAgain) { draftAgain = false; scheduleDraftSave(600); }
    }
  }
  // 把服务端草稿填回表单（图片直接指向服务端地址，不用重选）
  function applyDraft(d) {
    if (!d) return false;
    draftId = d.id;
    syncDraftDiscardBtn();   // 正在续填这份草稿 → 「删除这份草稿」可以出场了
    if (Array.isArray(d.types) && d.types.length) setSelectedTypes(d.types);
    fillWorkTitle(d);
    form.prompt.value = d.prompt || '';
    form.site.value = d.site || '';
    setQuickLookValues(d);   // 服务端草稿把五件套存在草稿对象自己身上（applyContentFields）
    pendingLinkValues = (d.links && Object.keys(d.links).length) ? d.links
      : (d.link ? { [((d.types || []).filter(x => x !== '小程序')[0]) || 'Web']: d.link } : null);
    setCats(Array.isArray(d.categories) ? d.categories : []);
    // 草稿里存过关键词就照原样恢复，并标成「作者已定稿」，别让自动生成再覆盖一遍
    setKeywords(Array.isArray(d.keywords) ? d.keywords : []);
    kwTouched = kwList.length > 0;
    const osv = d.openSource === true ? '1' : d.openSource === false ? '0' : '';
    const osi = form.querySelector(`input[name="openSource"][value="${osv}"]`);
    if (osi) osi.checked = true;
    setPaidRadios(!!d.paid, d.paidModel);
    if (form.lampPrice && d.lampPrice) form.lampPrice.value = d.lampPrice;
    updatePaidModelField();
    form.repo.value = d.repo || '';
    updateRepoFieldFn();
    const stv = form.querySelector(`input[name="stage"][value="${d.stage || 'live'}"]`);
    if (stv) stv.checked = true;
    if (typeof d.progress === 'number') {
      $('progressRange').value = d.progress;
      $('progressVal').textContent = d.progress + '%';
    }
    $('etaInput').value = d.eta || '';
    applyStageFields();
    applyTypeFields();

    coverUrl = d.image || '';
    qrUrl = d.qrcode || '';
    if (qrUrl) {
      $('qrPreviewImg').src = qrUrl;
      $('qrPreviewBox').style.display = 'block';
    }
    originalImages = Array.isArray(d.images) ? d.images.slice() : [];
    // 封面跟着第一张图走：把封面拼回列表第 0 位，界面上它仍是「首图」
    coverAutoSet = true;
    coverTakenFrom = null;
    galleryItems = (coverUrl && coverAutoSet)
      ? [{ kind: 'old', url: coverUrl }].concat(originalImages.map(u => ({ kind: 'old', url: u })))
      : originalImages.map(u => ({ kind: 'old', url: u }));
    if (coverUrl) coverTakenFrom = galleryItems[0];
    renderGalleryPreviews();
    syncDraftBar();   // 标题这时才填进表单，草稿条要在这之后刷新一次
    return true;
  }
  form.addEventListener('input', () => {
    clearTimeout(localDraftTimer);
    localDraftTimer = setTimeout(saveDraft, 400);
    scheduleDraftSave();
    if (draftId) syncDraftBar();   // 草稿条上的标题跟着改
  });
  form.addEventListener('change', () => {
    saveDraft();
    scheduleDraftSave(400);
  });

  // 标注开源时必须填写源码仓库地址，且必须落在开源代码托管站上（边填边提示，别等提交）
  function refreshRepoHint() {
    const el = $('repoHint');
    if (!el) return;
    const v = (form.repo.value || '').trim();
    const legacy = !!v && v === repoBaseline && !repoHostOk(v);
    const bad = !!v && !legacy && !repoHostOk(v);
    el.classList.toggle('err', bad);
    el.textContent = bad ? REPO_HINT_BAD : (legacy ? REPO_HINT_LEGACY : REPO_HINT_OK);
  }
  function updateRepoField() {
    const os = (form.querySelector('input[name="openSource"]:checked') || {}).value || '';
    const show = os === '1';
    $('repoField').style.display = show ? 'block' : 'none';
    const hint = $('osBonusHint');
    if (hint) hint.style.display = show ? 'block' : 'none';   // 开源奖励说明跟着显示
    form.repo.required = show;
    if (!show) form.repo.value = '';
    refreshRepoHint();
  }
  form.repo.addEventListener('input', refreshRepoHint);
  form.repo.addEventListener('blur', refreshRepoHint);
  form.querySelectorAll('input[name="openSource"]').forEach(r => r.addEventListener('change', updateRepoField));
  updateRepoFieldFn = updateRepoField;

  // 收费选择：三个并列选项（需要付费 / 灯火解锁 / 免费），「需要付费」排第一并注明形式可选
  // 只有「需要付费」展开收费形式；只有「需要灯火解锁」露出盏数输入。其余一律收起并把值清干净，
  // 否则用户来回切几下会残留「lamp + 形式=会员专享」这种互相矛盾的组合。
  function paidChoice() {
    const v = (form.querySelector('input[name="paid"]:checked') || {}).value || '';
    if (v === 'lamp') return { paid: '', paidModel: 'lamp' };
    if (v === '1') return { paid: '1', paidModel: (form.querySelector('input[name="paidModel"]:checked') || {}).value || '' };
    return { paid: '', paidModel: '' };
  }
  function updatePaidModelField() {
    const v = (form.querySelector('input[name="paid"]:checked') || {}).value || '';
    const picker = $('paidModelPicker');
    if (picker) picker.style.display = v === '1' ? 'flex' : 'none';
    if (v !== '1') {
      const none = form.querySelector('input[name="paidModel"][value=""]');
      if (none) none.checked = true;
    }
    const lampField = $('lampPriceField');
    if (lampField) lampField.style.display = v === 'lamp' ? 'block' : 'none';
    const hint = $('paidHint');
    if (hint) {
      hint.textContent = v === 'lamp'
        ? '灯火解锁：访客要先花灯火解锁，才看得到网页链接、下载链接和小程序码。卡片上会标「N 盏解锁」。'
        : v === '1'
          ? '需要付费：卡片上打「付费」标记，下方可选具体收费形式——部分免费 / 会员专享 / 单篇购买 / 订阅制 / 一次买断 / 试用后付费（拿不准就选「形式不定」）。站内不代收钱，费用结算在你自己那边。'
          : '免费作品不显示任何收费标记，访客随时能在详情页给作者送灯火；想设门槛就选「需要灯火解锁」或「需要付费（形式可选）」。';
    }
  }
  form.querySelectorAll('input[name="paid"]').forEach(r => r.addEventListener('change', updatePaidModelField));
  form.querySelectorAll('input[name="paidModel"]').forEach(r => r.addEventListener('change', () => {
    if (r.value) {
      const paidYes = form.querySelector('input[name="paid"][value="1"]');
      if (paidYes) paidYes.checked = true;
    }
    updatePaidModelField();
  }));
  // 编辑/草稿回填时把「作品上存的状态」映射回单选项：lamp 占一格，其余看 paid
  // 旧数据里的 donation（送灯火）已下线 → 回退成「免费（不标注）」
  function setPaidRadios(paidVal, paidModel) {
    const v = paidModel === 'lamp' ? 'lamp' : (paidVal ? '1' : '');
    const el = form.querySelector(`input[name="paid"][value="${v}"]`);
    if (el) el.checked = true;
    const pm = form.querySelector(`input[name="paidModel"][value="${paidModel === 'lamp' ? '' : (paidModel || '')}"]`);
    if (pm) pm.checked = true;
    updatePaidModelField();
  }

  editWorkFn = startEdit;
  function startEdit(w) {
    editId = w.id;
    // 站长代改别人的作品：弹窗里把身份说清楚，免得改完以为是自己的
    const adminEdit = w.adminEdit === true && !w.owned;
    setAgreeMode('edit');   // 编辑默认勾上：首次投稿已留过 agreeAt 凭据，这里只做轻量重申
    hideModal(detailModal);
    $('modalTitle').textContent = adminEdit ? '站长编辑作品' : '编辑作品';
    $('formHint').textContent = adminEdit
      ? `站长编辑 · 作者：${dname(w)} · 保存后立即生效`
      : `作者：${dname(w)} · 修改后立即生效`;
    $('formHint').style.display = 'block';
    setSelectedTypes(typesOf(w));
    fillWorkTitle(w);
    form.prompt.value = w.intro || '';
    form.site.value = w.site || ''; // 官网回填
    setQuickLookValues(w);   // 「一眼看懂」回填（老作品多半是空的，空着就保持收起）
    // 编辑回填：按形态的 links 优先，旧数据的单 link 落到第一个非小程序形态的输入框
    {
      const nonMini = typesOf(w).filter(t => t !== '小程序');
      const pv = Object.assign({}, w.links || {});
      if (w.link && nonMini.length && !Object.keys(pv).length) pv[nonMini[0]] = w.link;
      pendingLinkValues = Object.keys(pv).length ? pv : null;
    }
    setCats(Array.isArray(w.categories) && w.categories.length ? w.categories : [w.category].filter(Boolean));
    // 关键词回填：显示服务端存下的那一组（老作品上线时已自动配过），作者直接在上面改
    setKeywords(Array.isArray(w.keywords) ? w.keywords : []);
    kwTouched = true;   // 编辑状态下不再自动生成，免得把作者已经调好的词刷掉
    if (kwInput) kwInput.value = '';
    const osVal = w.openSource === true ? '1' : w.openSource === false ? '0' : '';
    const osInput = form.querySelector(`input[name="openSource"][value="${osVal}"]`);
    if (osInput) osInput.checked = true;
    setPaidRadios(!!w.paid, w.paidModel);
    if (form.lampPrice) form.lampPrice.value = w.lampPrice || 1;
    updatePaidModelField();
    form.repo.value = w.repo || '';
    repoBaseline = form.repo.value.trim();
    updateRepoFieldFn();
    newCatInput.style.display = 'none';
    $('submitBtn').textContent = '保存修改';
    galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
    originalImages = (w.images || []).slice();
    // 封面跟着第一张图走：把原封面拼回列表第 0 位当「首图」，拖动换位即换封面
    coverAutoSet = true;
    coverTakenFrom = null;
    coverUrl = w.image || '';
    galleryItems = (coverUrl && coverAutoSet)
      ? [{ kind: 'old', url: coverUrl }].concat(originalImages.map(u => ({ kind: 'old', url: u })))
      : originalImages.map(u => ({ kind: 'old', url: u }));
    if (coverUrl) coverTakenFrom = galleryItems[0];
    qrCleared = false;
    renderGalleryPreviews();
    // 当前状态回填：预告作品打开编辑页时能直接改完成度 / 预计上线 / 一键转正
    const stRadio = form.querySelector(`input[name="stage"][value="${stageOf(w)}"]`);
    if (stRadio) stRadio.checked = true;
    if (typeof w.progress === 'number') {
      $('progressRange').value = w.progress;
      $('progressVal').textContent = w.progress + '%';
    } else {
      $('progressRange').value = 40;
      $('progressVal').textContent = '40%';
    }
    $('etaInput').value = w.eta || '';
    applyStageFields();
    applyTypeFields();
    if (w.qrcode) {
      $('qrPreviewImg').src = w.qrcode;
      $('qrPreviewBox').style.display = 'block';
    } else {
      $('qrPreviewBox').style.display = 'none';
    }
    showModal(uploadModal);
  }

  async function tryCloseUpload() {
    if (!editId && uploadDirty()) {
      if (state.user) {
        // 服务端草稿是真存（连图片），存好再关，不用拿「会不会丢」去问用户
        const ok = await syncDraft();
        if (ok) showToast('已存进草稿箱，下次打开接着填', undefined, 'ok');
        else if (!confirm('草稿没存上（网络异常或草稿已满 3 份），现在关闭会丢掉这次填的内容。确定关闭吗？')) return;
      } else {
        saveDraft();
        if (!confirm('内容还没提交，已存为浏览器草稿，下次打开「提交作品」会恢复（图片需重新选择）。确定关闭吗？')) return;
      }
    }
    hideModal(uploadModal);
    resetUploadForm();
  }

  // ---- 草稿选择层：只有 2 份以上才弹，1 份直接续填不打扰 ----
  function draftTimeText(iso) {
    const t = new Date(iso || 0).getTime();
    if (!t) return '';
    const d = Date.now() - t;
    if (d < 60e3) return '刚刚保存';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    return new Date(t).toLocaleDateString('zh-CN');
  }
  async function showDraftPicker(list) {
    const body = $('draftPickBody');
    const rows = list.map(d => `
      <div class="draft-row" data-id="${escapeHtml(d.id)}">
        <div class="draft-thumb">${d.cover ? `<img src="${escapeHtml(d.cover)}" alt="" />` : '<span>无封面</span>'}</div>
        <div class="draft-info">
          <b>${escapeHtml(d.title || '未命名草稿')}</b>
          <span>${draftTimeText(d.updatedAt)}${d.imageCount ? ` · ${d.imageCount} 张宣传图` : ''}</span>
        </div>
        <button type="button" class="draft-del" data-del="${escapeHtml(d.id)}" title="删除这份草稿">✕</button>
      </div>`).join('');
    const full = list.length >= draftMax;   // 存满 3 份时「新建」只剩提示作用，点了别把人送进空白表单
    body.innerHTML = rows + `
      <div class="draft-row draft-new${full ? ' draft-new-full' : ''}" data-id="">
        <div class="draft-thumb draft-thumb-new">＋</div>
        <div class="draft-info"><b>${full ? `草稿箱已满（${draftMax} 份）` : '新建一份'}</b><span>${full ? '先点右上角 ✕ 删掉一份，才能再开新的' : '从空白开始，上面这些草稿继续留着'}</span></div>
      </div>`;
    body.querySelectorAll('.draft-del').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        const id = btn.dataset.del;
        if (!confirm('删除这份草稿？里面的图片也会一起删掉，不能恢复。')) return;
        try {
          const r = await fetch('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || '删除失败'); }
          const left = list.filter(x => x.id !== id);
          draftHint = left.length;   // 删完立刻把角标数字改对
          paintDraftHint();
          if (!left.length) {
            hideModal($('draftPickModal'));
            resetUploadForm();
            showModal(uploadModal);
            return;
          }
          showDraftPicker(left);   // 重绘剩下的
        } catch (err) { showToast(err.message, undefined, 'err'); }
      };
    });
    body.querySelectorAll('.draft-row').forEach(row => {
      row.onclick = async () => {
        const id = row.dataset.id;
        // 满格时先拦下，别 hideModal 之后才发现开不了新的（选择层一起没了）
        if (!id && full) { showToast(`草稿最多存 ${draftMax} 份，先点 ✕ 删掉一份`, 4200, 'err'); return; }
        hideModal($('draftPickModal'));
        if (!id) {   // 新建
          resetUploadForm();
          showModal(uploadModal);
          return;
        }
        try {
          const r = await fetch('/api/drafts/' + encodeURIComponent(id));
          const data = await r.json();
          if (!r.ok || !data.draft) throw new Error(data.error || '草稿打不开了');
          resetUploadForm();
          applyDraft(data.draft);
          showModal(uploadModal);
          showToast('已恢复草稿，文字和图片都在', undefined, 'ok');
        } catch (err) { showToast(err.message, undefined, 'err'); }
      };
    });
    showModal($('draftPickModal'));
  }
  const draftPickModalEl = $('draftPickModal');
  if (draftPickModalEl) {
    const closePick = () => { hideModal(draftPickModalEl); resetUploadForm(); };
    $('closeDraftPick').onclick = closePick;
    draftPickModalEl.onclick = e => { if (e.target === draftPickModalEl) closePick(); };
  }

  // 作品介绍「AI 帮写」：只回填草稿，不提交、不写库；生成后作者随便改
  let aiIntroDraft = '';
  const aiIntroBtn = document.getElementById('aiIntroBtn');
  if (aiIntroBtn) aiIntroBtn.onclick = async () => {
    const form = document.getElementById('uploadForm');
    if (!form) return;
    const nameEl = form.querySelector('[name="wname"]');
    const tagEl = form.querySelector('[name="wtag"]');
    const nt = ((nameEl && nameEl.value) || '').trim();
    const tt = ((tagEl && tagEl.value) || '').trim();
    const title = nt + (tt ? ' ' + tt : '');
    if (title.length < 2) {
      showToast('先填作品名字，AI 才知道写什么', undefined, 'err');
      if (nameEl) nameEl.focus();
      return;
    }
    const ta = form.querySelector('textarea[name="prompt"]');
    if (!ta) return;
    const picked = sel => Array.from(document.querySelectorAll(sel + ' input:checked')).map(i => i.value).filter(Boolean);
    const linkEl = form.querySelector('[name="site"]');
    const old = ta.value.trim();
    const label = aiIntroBtn.innerHTML;
    aiIntroBtn.disabled = true;
    aiIntroBtn.textContent = '生成中…';
    try {
      const r = await fetch('/api/ai/intro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          categories: picked('#catPicker'),
          types: picked('#typePicker'),
          link: linkEl ? linkEl.value.trim() : ''
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(d.error || '生成失败，先手动写一句吧', undefined, 'err'); return; }
      if (old) {
        // 原文还在：不直接动文本框，弹选择框让作者决定「替换」还是「追加」
        aiIntroDraft = d.text || '';
        const pv = $('aiIntroPreview');
        if (pv) pv.textContent = aiIntroDraft;
        showModal($('aiIntroPickModal'));
      } else {
        ta.value = d.text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));   // 让字数/预览跟着刷新
        showToast('草稿已填入，改完再提交', undefined, 'ok');
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* ignore */ }
      }
    } catch {
      showToast('网络异常，先手动写一句吧', undefined, 'err');
    } finally {
      aiIntroBtn.disabled = false;
      aiIntroBtn.innerHTML = label;
    }
  };

  // AI 帮写选择框：替换 / 追加二选一，直接关掉就不动原文
  const aiIntroPickEl = $('aiIntroPickModal');
  if (aiIntroPickEl) {
    const applyIntro = mode => {
      const form = document.getElementById('uploadForm');
      const ta = form && form.querySelector('textarea[name="prompt"]');
      hideModal(aiIntroPickEl);
      if (!ta) return;
      if (mode === 'replace') {
        ta.value = aiIntroDraft;
      } else {
        const cur = ta.value.trim();
        ta.value = (cur ? cur + '\n\n' : '') + aiIntroDraft;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));   // 让字数/预览跟着刷新
      showToast(mode === 'replace' ? '已替换原文，改完再提交' : '草稿已追加在下面，改完再提交', undefined, 'ok');
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* ignore */ }
    };
    $('aiIntroReplace').onclick = () => applyIntro('replace');
    $('aiIntroAppend').onclick = () => applyIntro('append');
    $('closeAiIntroPick').onclick = () => hideModal(aiIntroPickEl);
    aiIntroPickEl.onclick = e => { if (e.target === aiIntroPickEl) hideModal(aiIntroPickEl); };
  }

  // 「一眼看懂」折叠块：默认收起（不吓人），填过内容就自动展开（编辑老作品时直接看到现状）。
  // 五个框全是选填，服务端不拦；这里只管展开/收起和字数，别加校验。
  {
    const qlBody = $('qlBody');
    const qlToggle = $('qlToggle');
    if (qlBody && qlToggle) {
      const setOpen = open => {
        qlBody.hidden = !open;
        qlToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        qlToggle.classList.toggle('is-open', !!open);
      };
      qlToggle.onclick = () => setOpen(qlBody.hidden);
      const paint = () => {
        qlBody.querySelectorAll('[maxlength]').forEach(el => {
          const out = qlBody.querySelector(`.ql-count[data-for="${el.id}"]`);
          if (!out) return;
          // 步骤按「行数」算更有意义（写满 5 行就是上限），其余按字数
          const isSteps = el.id === 'qlSteps';
          const n = isSteps
            ? el.value.split('\n').filter(x => x.trim()).length
            : el.value.trim().length;
          const max = isSteps ? 5 : el.maxLength;
          out.textContent = isSteps ? `${n}/${max} 步` : `${n}/${max}`;
          out.classList.toggle('is-full', n >= max);
        });
      };
      qlBody.addEventListener('input', paint);
      qlUI.setOpen = setOpen;
      qlUI.paint = paint;
      setOpen(false);
      paint();
    }
  }

  // 「AI 补这四项」：解决什么 / 适合谁 / 上手几步 / 和同类比（定位句一般已经有了）。
  // 只把文案填进输入框 —— 不提交、不写库，作者核对后自己保存；
  // 已经有内容的框一律不覆盖（作者手写的优先），AI 只补空位，原文没依据的项留空。
  {
    const qlAiBtn = $('qlAiBtn');
    if (qlAiBtn) qlAiBtn.onclick = async () => {
      const form = document.getElementById('uploadForm');
      if (!form) return;
      const nameEl = form.querySelector('[name="wname"]');
      const tagEl = form.querySelector('[name="wtag"]');
      const ta = form.querySelector('textarea[name="prompt"]');
      const title = (((nameEl && nameEl.value) || '').trim() + ' ' + ((tagEl && tagEl.value) || '').trim()).trim();
      if (title.length < 2) {
        showToast('先填作品名字，AI 才知道写什么', undefined, 'err');
        if (nameEl) nameEl.focus();
        return;
      }
      const promptText = ((ta && ta.value) || '').trim();
      if (promptText.length < 30) {
        showToast('先在「作品介绍」里写两三句（做什么、怎么用），AI 才有依据；介绍太短它只会编', undefined, 'err');
        if (ta) ta.focus();
        return;
      }
      const picked = sel => Array.from(document.querySelectorAll(sel + ' input:checked')).map(i => i.value).filter(Boolean);
      const cats = picked('#catPicker');
      const posEl = $('qlPositioning');
      const label = qlAiBtn.innerHTML;
      qlAiBtn.disabled = true;
      qlAiBtn.innerHTML = '<i class="ico" data-ico="bolt"></i> 生成中…';
      try {
        const r = await fetch('/api/ai/quicklook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            prompt: promptText,
            positioning: posEl ? posEl.value.trim() : '',
            category: cats[0] || '',
            types: picked('#typePicker')
          })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(d.error || '生成失败，先手动填吧', undefined, 'err'); return; }
        if (d.empty) { showToast(d.error || '原文信息太少，AI 提炼不出有依据的内容', undefined, 'err'); return; }

        const filled = [], kept = [], blank = [];
        const put = (id, name, val) => {
          const el = $(id);
          if (!el) return;
          if (el.value.trim()) { kept.push(name); return; }   // 作者写过的不动
          if (!val) { blank.push(name); return; }
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));   // 让字数/预览跟着刷新
          filled.push(name);
        };
        put('qlProblem', '解决什么', d.problem);
        put('qlAudience', '适合谁', d.audience);
        put('qlSteps', '上手几步', Array.isArray(d.steps) ? d.steps.join('\n') : '');
        put('qlDiff', '和同类比', d.diff);

        if (filled.length) {
          if (qlUI.setOpen) qlUI.setOpen(true);
          if (qlUI.paint) qlUI.paint();
          const block = $('qlBlock');
          if (block) block.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        const tail = blank.length ? `；原文没依据：${blank.join('、')}` : '';
        if (filled.length) showToast(`已补 ${filled.length} 项（${filled.join('、')}）${kept.length ? `，${kept.join('、')} 原有内容没动` : ''}${tail}。保存前请核对`, undefined, 'ok');
        else if (kept.length) showToast(`这四项都已有内容，AI 没有覆盖${tail}`, undefined, 'ok');
        else showToast(`AI 没能提炼出有依据的内容${tail}，建议手动补两句介绍`, undefined, 'err');
      } catch {
        showToast('网络异常，先手动填吧', undefined, 'err');
      } finally {
        qlAiBtn.disabled = false;
        qlAiBtn.innerHTML = label;
      }
    };
  }

  $('openUpload').onclick = async () => {
    // 未登录也允许打开投稿表单（匿名需审核），登录后再提交换免审
    resetUploadForm();
    if (state.user) {
      // 登录用户走服务端草稿：0 份空白、1 份直接续填、多份让用户挑
      let list = [];
      try {
        const r = await fetch('/api/drafts');
        const data = await r.json();
        list = (data && data.items) || [];
        draftMax = Number(data && data.max) || draftMax;
      } catch {}
      draftHint = list.length;   // 顺手校准角标，省一次请求
      paintDraftHint();
      if (list.length >= 2) { showDraftPicker(list); return; }
      if (list.length === 1) {
        try {
          const r2 = await fetch('/api/drafts/' + encodeURIComponent(list[0].id));
          const d2 = await r2.json();
          if (d2 && d2.draft && applyDraft(d2.draft)) {
            showModal(uploadModal);
            showToast('已恢复草稿，文字和图片都在', undefined, 'ok');
            return;
          }
        } catch {}
      }
      showModal(uploadModal);
      return;
    }
    const restored = restoreDraft();
    showModal(uploadModal);
    if (restored) showToast('已恢复上次未提交的草稿（图片需重新选择）', undefined, 'ok');
  };
  $('closeUpload').onclick = tryCloseUpload;

  // 「删除这份草稿」：以前只有 2 份以上才在草稿选择层里能删，只有 1 份时没有任何出口
  // （关弹窗只会再存一遍）。这里补上：删服务端草稿 + 连图片文件一起删 + 表单和角标一起归零。
  const draftDiscardBtn = $('draftDiscard');
  if (draftDiscardBtn) draftDiscardBtn.onclick = async () => {
    if (!draftId) return;
    if (!confirm('删除这份草稿？里面的图片也会一起删掉，不能恢复。')) return;
    draftDiscardBtn.disabled = true;
    // 先把还在飞的自动保存等完：否则它可能在删除之后才写回，
    // 服务端发现 draftId 不存在就会当成「新草稿」凭空复活一份。
    clearTimeout(draftTimer);
    draftAgain = false;
    for (let i = 0; i < 40 && draftBusy; i++) await new Promise(r => setTimeout(r, 80));
    try {
      const id = draftId;
      const r = await fetch('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || '删除失败'); }
      draftId = null;
      clearDraft();              // 匿名的浏览器本地草稿也一起清掉，别留个幽灵
      resetUploadForm();         // 表单归零，顺便把本按钮收起来
      hideModal(uploadModal);
      showToast('草稿已删除', undefined, 'ok');
      refreshDraftHint();        // 右上角角标跟着减
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      draftDiscardBtn.disabled = false;
    }
  };
  // 草稿条上的「删除」：和底部「删除这份草稿」同一个动作，只是入口提到草稿条——
  // 底部按钮在长表单最下面，很多作者滚不到、根本不知道能删。草稿条只在 draftId
  // 有值时显示，所以直接触发底部按钮即可（确认、连图片一起删、角标归零都在那边）。
  const draftBarDel = $('draftBarDel');
  if (draftBarDel && draftDiscardBtn) draftBarDel.onclick = () => draftDiscardBtn.click();

  // 「再开一份」：手上这件还在筹划，另外再开一件，不能靠先删掉旧草稿腾位置。
  // 顺序很重要——先把当前这份存稳，再断开 draftId；直接 resetUploadForm 会把没落盘的改动丢掉。
  const draftNewBtn = $('draftNewBtn');
  if (draftNewBtn) draftNewBtn.onclick = async () => {
    if (!draftId) return;
    if (draftHint >= draftMax) {
      showToast(`草稿最多存 ${draftMax} 份，先在草稿箱里删掉一份`, 4500, 'err');
      return;
    }
    draftNewBtn.disabled = true;
    clearTimeout(draftTimer);
    draftAgain = false;
    for (let i = 0; i < 40 && draftBusy; i++) await new Promise(r => setTimeout(r, 80));
    try {
      if (uploadDirty()) {
        // 存不上就别开新的：否则旧草稿停在上次的内容，这次填的就白填了
        const ok = await syncDraft();
        if (!ok) { showToast('这份草稿还没存上，检查网络后再试', 4500, 'err'); return; }
      }
      draftId = null;
      resetUploadForm();      // draftId 已归零，草稿条一起收起来
      showToast('已开一份新的；刚才那份还在草稿箱里，下次点「＋ 提交作品」能选它', 4500, 'ok');
      if (form.wname) form.wname.focus();
    } finally {
      draftNewBtn.disabled = false;
    }
  };
  bindMaskClose(uploadModal, tryCloseUpload);

  // 投稿指南页的 CTA：复用「＋ 提交作品」的完整打开逻辑（草稿恢复等）
  const howtoCta = $('howtoCta');
  if (howtoCta) howtoCta.onclick = () => $('openUpload').click();

  // 「第一次投稿？」提示条：点「不再提示」后写 localStorage，下次打开弹窗不再显示
  const howtoHint = $('howtoHint');
  if (howtoHint) {
    let hintDismissed = false;
    try { hintDismissed = localStorage.getItem('howtoHintDismissed') === '1'; } catch {}
    if (hintDismissed) howtoHint.style.display = 'none';
    const howtoHintClose = $('howtoHintClose');
    if (howtoHintClose) howtoHintClose.onclick = () => {
      howtoHint.style.display = 'none';
      try { localStorage.setItem('howtoHintDismissed', '1'); } catch {}
    };
  }

  $('typePicker').addEventListener('change', e => {
    if (e.target.name !== 'types') return;
    // 一个都不选不拦，提交时才提示「至少选择一种」
    applyTypeFields();
  });

  // 「＋ 新形态」起名输入框：回车确认后创建（已存在直接勾上）
  const newTypeInput = $('newTypeInput');
  newTypeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmNewType(); }
  });
  newTypeInput.addEventListener('blur', () => { if (!newTypeInput.value.trim()) newTypeInput.style.display = 'none'; });
  async function confirmNewType() {
    const name = newTypeInput.value.trim();
    if (!name) { newTypeInput.style.display = 'none'; return true; }
    try {
      const r = await fetch('/api/types', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (err.error !== '该形态已存在') { showToast(err.error || '新增形态失败', undefined, 'err'); return false; }
      }
      await loadTypeMeta(); // 重新拉形态列表并渲染胶囊（已勾选状态保留）
      const box = [...form.querySelectorAll('input[name="types"]')].find(i => i.value === name);
      if (box) {
        box.checked = true;
        newTypeInput.style.display = 'none';
        newTypeInput.value = '';
        showToast(`已新增形态「${name}」`, undefined, 'ok');
      } else {
        showToast('形态已存在，请直接在列表里勾选');
      }
      applyTypeFields();
      return true;
    } catch { showToast('新增形态失败', undefined, 'err'); return false; }
  }

  // form.image 是隐藏输入：由 syncCoverFromGallery 自动填第一张作品图，不再有手动 change 入口
  form.qrcode.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    qrCleared = false;
    $('qrPreviewImg').src = URL.createObjectURL(file);
    $('qrPreviewBox').style.display = 'block';
    inspectQr(file);   // 本地体检：这图里到底有没有码
  });
  form.images.addEventListener('change', e => {
    for (const f of e.target.files) {
      if (galleryItems.length >= MAX_GALLERY_ITEMS) { showToast(`作品图片最多 ${MAX_GALLERY_ITEMS} 张`, undefined, 'err'); break; }
      addGalleryFile(f);
    }
    e.target.value = ''; // 允许再次选择时重复追加
  });

  // 鼠标移到某个上传区、或点它一下，即把它设为粘贴目标（触屏没有 hover，靠点击/聚焦）
  document.querySelectorAll('.upload-dropzone[data-paste]').forEach(dz => {
    const pick = () => setPasteTarget(dz.dataset.paste);
    dz.addEventListener('mouseenter', pick);
    dz.addEventListener('pointerdown', pick);
    dz.addEventListener('focusin', pick);
  });

  // 点在别处（比如去填标题）就把粘贴目标收回作品图片列表：
  // 否则「刚才 hover 过码区」会让之后粘进来的截图默默覆盖二维码
  document.addEventListener('pointerdown', e => {
    if (e.target && e.target.closest && e.target.closest('.upload-dropzone[data-paste]')) return;
    if (pasteTarget !== 'images') setPasteTarget('images');
  }, true);

  // 全局 Ctrl+V：投稿弹窗打开时，粘贴图片自动填入当前目标
  document.addEventListener('paste', e => {
    if (uploadModal.style.display === 'none') return;
    const ae = document.activeElement;
    // 正在输入框里粘文字时不拦截
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && ae.type !== 'file'
        && e.clipboardData && e.clipboardData.getData('text')) return;
    const file = clipboardImage(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    applyPastedImage(pasteTarget, file);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();

    // 先把还在飞的草稿保存等完：否则它可能在作品创建成功之后才写回，
    // 服务端发现草稿已被转正删除，就会当成「新草稿」凭空复活一份。
    clearTimeout(draftTimer);
    draftAgain = false;
    for (let i = 0; i < 40 && draftBusy; i++) await new Promise(r => setTimeout(r, 80));

    // 基础必填（表单已加 novalidate，统一用中文提示，避免浏览器默认气泡）
    if (!(form.wname.value || '').trim()) {
      showToast('请填写作品名字', undefined, 'err');
      form.wname.focus();
      return;
    }
    // 一句话介绍必填：卡片/榜单上就靠它说清作品是干嘛的，缺了读者点不进来。
    // 编辑老作品时标题可能拆不出介绍，不卡（否则改个链接都存不了）。
    if (!editId && !(form.wtag.value || '').trim()) {
      showToast('再写一句话介绍：它帮谁做什么，20 字以内', undefined, 'err');
      form.wtag.focus();
      return;
    }

    // 「其他」填了具体名字：先创建成新形态并替换勾选，再走下面的校验
    if ($('newTypeInput').style.display !== 'none' && $('newTypeInput').value.trim()) {
      const ok = await confirmNewType();
      if (!ok) return;
    }

    // 形态必选校验：编辑过程中可以清空，提交时必须至少勾一个
    const pickedTypes = selectedTypes();
    if (!pickedTypes.length) {
      showToast('请至少选择一种作品形态', undefined, 'err');
      $('typePicker').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // 形态必填校验：只有网站需要链接，小程序需要二维码
    // 「还在做」的预告没有链接和二维码，改成要求一句进度说明（至少 8 字）
    const submitStage = currentStage();
    const curTypes = pickedTypes;
    if (submitStage === 'wip') {
      const note = form.prompt.value.trim();
      if (note.length < 8) {
        showToast('请写一句进度说明（至少 8 个字）：做到哪一步了', undefined, 'err');
        form.prompt.focus();
        $('wipFields').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    } else {
      if (LINK_REQUIRED_TYPES.some(t => curTypes.indexOf(t) !== -1)) {
        const webInput = form.querySelector('input[data-ltype="Web"]');
        if (!webInput || !webInput.value.trim()) {
          showToast(submitStage === 'reviewing' ? '等上架审核也要填链接：审核通过后别人从这里打开' : '形态含「网站」，请填写网站地址', undefined, 'err');
          if (webInput) webInput.focus();
          return;
        }
      }
      if (curTypes.indexOf('小程序') !== -1) {
        const hasQr = form.qrcode.files.length > 0 ||
          (!qrCleared && $('qrPreviewBox').style.display !== 'none');
        if (!hasQr) {
          showToast('形态含「小程序」，请上传小程序码 / 二维码', undefined, 'err');
          $('qrDrop').scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
      }
    }

    // 标注开源：源码仓库地址必填，且必须是开源代码托管站的页面
    if (((form.querySelector('input[name="openSource"]:checked') || {}).value || '') === '1' &&
        !form.repo.value.trim()) {
      showToast('标注开源请填写源码仓库地址', undefined, 'err');
      form.repo.focus();
      $('repoField').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (!repoValueOk(form.repo.value)) {
      showToast('源码仓库地址只能是 GitHub / Gitee / GitLab 等开源代码托管站的页面', undefined, 'err');
      refreshRepoHint();
      form.repo.focus();
      $('repoField').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // 应用分类：至少选 1 个，最多 3 个
    const selCats = selectedCats();
    if (!selCats.length) {
      showToast('请至少选择一个应用分类', undefined, 'err');
      $('catPicker').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // 封面：新建时必须有一张（编辑/草稿续填时保留已有的即可）。
    // 第一张作品图会自动当封面（加图时就塞进封面位了），列表为空才真的没有
    if (!editId && !galleryItems.length && !form.image.files.length && !coverUrl) {
      showToast('请上传作品图片：第一张将自动作为封面', undefined, 'err');
      $('galleryDrop').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // 投稿承诺：每次提交都要重新确认（编辑改的也是内容，同样受规范约束）。
    // 勾选会随 FormData 一起发给服务端，作为「已同意」的留痕。
    if (!$('agreeRules').checked) {
      showToast('请先阅读并勾选投稿承诺', undefined, 'err');
      $('agreeRules').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // 未登录：先让用户选「注册免审直发」还是「匿名提交等审核」
    if (!state.user && !editId) {
      const choice = await askSubmitChoice();
      if (choice === 'auth') {
        saveDraft();
        pendingPublish = true;
        openAuth('register', true);
        return;
      }
      if (choice !== 'anon') return; // 取消/关闭：留在表单继续改
    }

    const btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = '提交中...';
    try {
      // 自定义分类：填了就先创建，再并入所选（服务器最多收 3 个）
      let cats = selCats.slice();
      if (newCatInput.style.display !== 'none') {
        const name = newCatInput.value.trim();
        if (name && !cats.includes(name)) {
          const r = await fetch('/api/categories', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (err.error !== '分类已存在') throw new Error(err.error || '新增分类失败');
          }
          await loadCategories();
          cats.push(name);
        }
        newCatInput.style.display = 'none';
        newCatInput.value = '';
      }
      if (cats.length > MAX_CATS) cats = cats.slice(0, MAX_CATS);

      // 客户端压缩 + 生成缩略图，避免上传原图过大
      const fd = new FormData(form);
      // 标题两框合一：名字 + 一句话介绍拼成一个 title 再上传（上面必填校验已保证名字非空）。
      // wname / wtag 照原样一起传：服务端把拆分单独存下来，卡片直接分两行，
      // 不用再回头猜「日影 mac活动追踪器-31天免试用」这类英文开头的介绍该从哪儿断。
      fd.set('title', workTitleVal());
      // 收费选项是单选框（paid=lamp/1/空），服务端要的是 paid + paidModel 两字段，这里转一次
      const paidPick = paidChoice();
      fd.set('paid', paidPick.paid);
      fd.set('paidModel', paidPick.paidModel);
      if (paidPick.paidModel === 'lamp') {
        const lp = Math.round(Number(form.lampPrice && form.lampPrice.value));
        if (!Number.isFinite(lp) || lp < 1 || lp > 50) {
          btn.disabled = false;
          btn.textContent = editId ? '保存修改' : '提交';
          return toast('灯火解锁要填一个解锁价：1～50 盏灯火');
        }
        fd.set('lampPrice', String(lp));
      } else {
        fd.delete('lampPrice');
      }
      fd.set('categories', JSON.stringify(cats)); // 多分类（第 0 个为主分类，提交顺序即选中顺序）
      fd.set('category', cats[0]);                // 兼容老字段
      // 关键词：编辑时整组照传（空数组＝作者清空了，服务端不再自动补）；
      // 新投稿一个都没有就不传 —— 让服务端按标题 / 简介 / 分类自动配，别用空数组把自动生成顶掉
      if (editId || kwList.length) fd.set('keywords', JSON.stringify(kwList));
      else fd.delete('keywords');
      fd.set('stage', submitStage);               // 已上线 / 等平台审核 / 还在做
      if (submitStage === 'wip') {
        fd.set('progress', $('progressRange').value);
        fd.set('eta', $('etaInput').value || '');
      } else {
        fd.delete('progress');
        fd.delete('eta');
      }
      fd.delete('newCategory');
      fd.delete('images'); // 宣传图单独压缩后追加
      // 按形态的多个链接：收集后统一走 links 字段，散的 link/link_xxx 不单独传
      const linkValues = collectLinkValues(form);
      Object.keys(linkValues).forEach(t => fd.delete('link_' + t));
      fd.delete('link');
      fd.set('links', JSON.stringify(linkValues));

      // 编辑模式 / 草稿续填：没选新图就不传文件字段，让服务端沿用已有的图；
      // 宣传图告知服务器要删掉哪几张（keepExisting + removedImages）
      // 封面自动取自第一张图时，第 0 项单独走封面字段，不进宣传图列表
      const qrAllowed = ruleOfTypes(selectedTypes()).qr;
      const sendItems = gallerySendItems();
      const newFiles = sendItems.filter(it => it.kind === 'new').map(it => it.file);
      const keptUrls = sendItems.filter(it => it.kind === 'old').map(it => it.url);
      // 原有但已被删掉的宣传图
      const removedImages = originalImages.filter(u => !keptUrls.includes(u));
      if (editId || draftId) {
        if (!form.image.files.length) fd.delete('image');
        if (!qrAllowed || !form.qrcode.files.length) fd.delete('qrcode');
        fd.set('keepExisting', '1');
        if (removedImages.length) fd.set('removedImages', JSON.stringify(removedImages));
        // 二维码被手动删除（且没选新的），或改了形态不再需要二维码
        if (!form.qrcode.files.length && (qrCleared || !qrAllowed)) fd.set('removeQrcode', '1');
      } else if (!qrAllowed) {
        fd.delete('qrcode');
      }
      // 草稿转正：告诉服务端这份内容来自哪份草稿，图片从草稿里取，成功后草稿自动消失
      if (draftId && !editId) fd.set('draftId', draftId);

      // 宣传图最终顺序：已有图为 URL，新图为 __new__<下标>（下标对应下面 append 的顺序）
      if (sendItems.length) {
        let n = -1;
        fd.set('imageOrder', JSON.stringify(sendItems.map(it =>
          it.kind === 'old' ? it.url : `__new__${++n}`)));
      }

      const file = form.image.files[0];
      if (file && file.type.startsWith('image/')) {
        const main = await resizeImage(file, 1600, 0.85);
        const thumb = await resizeImage(file, 960, 0.82);
        if (main) { fd.set('image', main, 'cover.jpg'); }
        if (thumb) { fd.set('thumb', thumb, 'thumb.jpg'); }
      }

      // 宣传图：按界面顺序逐张压缩后追加（最多 9 张）。
      // 长边统一压到 1600：PC 宽幅图得 1600 宽，手机竖屏图得约 730×1600，各自清晰
      for (let i = 0; i < newFiles.length; i++) {
        const g = await resizeImage(newFiles[i], 1600, 0.82);
        fd.append('images', g || newFiles[i], `gallery-${i}.jpg`);
      }

      const res = await fetch(editId ? '/api/works/' + editId : '/api/works', {
        method: editId ? 'PUT' : 'POST', body: fd
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '提交失败');

      const wasEdit = !!editId;
      const editedId = wasEdit ? editId : null;   // resetUploadForm 会把 editId 清掉，先留一份
      if (!wasEdit) { clearDraft(); refreshDraftHint(); }   // 草稿已转正（服务端也删了），角标要跟着减
      hideModal(uploadModal);
      resetUploadForm();
      const bonus = Number(data.osBonus) || 0;
      // 首件上传奖励拆两笔：上线即到 100 盏（可直接去「推荐」换推荐位），余款 24 小时后到账；
      // 后续每件 +50 仍是 48 小时后全额到账。
      const upReward = Number(data.uploadReward) || 0;
      const upInstant = Number(data.uploadRewardInstant) || 0;
      const upRest = Number(data.uploadRewardRest) || 0;
      const upHours = Number(data.uploadRewardReadyHours) || 0;
      let rewardHint = '';
      if (upInstant > 0) {
        rewardHint = ` 首件上传奖励 +${upInstant} 盏灯火已到账，可以去「推荐自己的作品」用灯火换个推荐位${upRest > 0 ? `；剩下 ${upRest} 盏 ${upHours} 小时无投诉后到账` : ''}。`;
      } else if (upReward > 0 && data.needReview) {
        rewardHint = upReward >= 200
          ? ` 首件上传奖励共 ${upReward} 盏：审核通过上线后先到 100 盏，余款 ${upHours} 小时后到账。`
          : ` 上传奖励 +${upReward} 盏将在审核通过上线 48 小时后到账。`;
      } else if (upReward > 0) {
        rewardHint = ` 上传奖励 +${upReward} 盏灯火将在 ${upHours || 48} 小时无投诉后到账。`;
      }
      const instantLive = !wasEdit && !data.anonymous && !data.needReview;
      showToast(
        wasEdit
          ? (bonus > 0 ? '修改已保存，开源奖励 +50 盏灯火已到账' : '修改已保存')
        : data.anonymous ? (data.status === 'approved' ? '提交成功，已通过 AI 初审直接上线' : '已提交，审核通过后上线（注册可免审直发）')
        : data.needReview ? '提交成功，AI 初审未通过，等待人工审核后展示'
        : bonus > 0 ? `提交成功，开源奖励 +50 盏灯火已到账 ·${rewardHint}作品页可点「外宣包」做宣传`
        : `提交成功 ·${rewardHint}作品页可点「外宣包」做宣传`,
        instantLive ? 4200 : undefined, 'ok');
      if (bonus > 0 || Number(data.uploadRewardInstant) > 0) loadMe();   // 开源 / 首件即时到账后立刻刷新头部灯火数
      // 匿名投稿没有账号可查：直接打开「投稿进度」页，链接可收藏，之后随时回来看
      if (!wasEdit && data.statusUrl) {
        // 先把令牌记在本机：进度页只对这台设备显示「存到我名下」，链接转发出去不会带认领入口
        saveMyClaimToken(String(data.statusUrl).split('/s/')[1] || '', data.title);
        showToast('已提交，正在打开你的投稿进度页…', 2400, 'ok');
        setTimeout(() => { location.href = data.statusUrl; }, 1400);
        return;
      }
      // 编辑保存：就地换掉那一张卡，别整页重来。
      // 以前这里和「新投稿」共用 route()：列表清空重拉、排序切到「最新」、视图一藏一显把
      // 滚动位置钳回顶部——站长在首页中间改完一件作品，关掉弹窗就被甩回页首，像重载了一次。
      // 编辑不改变作品集合，只换内容；详情弹窗开着就把内容刷成刚存下的样子，也不重走整页路由。
      if (wasEdit) {
        // 改成预告 / 等平台上架后，作品就不该留在首页信息流里了：就地摘掉，别留一张过期的卡
        if (data.hidden || (data.stage || 'live') !== 'live') removeWorkFromList(editedId);
        else patchWorkInList(data);
        // 详情弹窗还开着（URL 仍是 /w/xxx）就把内容刷成刚存下的样子；?full=1 整页模式不弹窗，
        // 和以前 route() 在整页视图直接 return 的口径一致
        if (location.pathname === '/w/' + encodeURIComponent(editedId) && !isFullView()) openWork(editedId, false);
      } else {
        // 投完跳去「最新」看自己的作品：这是程序跳转，不写 dm_sort——
        // 用户可能习惯「最热」，不该因为投了一次稿就把习惯改掉
        state.sort = 'latest';
        renderFilters();   // 筛选栏「最新」tab 的文案跟着回到默认
        syncSortToggle();  // PC 排序按钮同步点亮「最新」
        route();
        // 即时上线的登录投稿：弹「发布成功」，顺手把新作品同步到酒馆
        if (instantLive && (data.stage || 'live') === 'live') openPublishOk(data);
      }
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '提交';
    }
  });
}

// ---------- 发布成功弹窗 ----------
// 登录投稿且即时上线才弹（见提交成功分支的调用条件）：匿名件没有账号、发不了酒馆；
// 审核中 / 预告的作品还没进公开列表，酒馆的「关联作品」也认不了它，所以一律不弹。
// 「转发到酒馆」复用散座发帖接口 /api/bar/posts：正文可留空（留空代写一句），
// workRef 传作品页链接，服务端解析出作品卡挂在帖子下面。
let pubokWork = null;
function openPublishOk(data) {
  const m = $('publishOkModal');
  if (!m || !state.user) return;
  pubokWork = data;
  const cnt = $('pubokCount');
  if (cnt) cnt.textContent = Math.max(1, Number(data.myWorks) || 1);
  paintAvatar($('pubokAva'), state.user.nickname || state.user.username || '?', state.user.avatar);
  const ta = $('pubokText');
  if (ta) ta.value = '';
  const btn = $('pubokSend');
  btn.disabled = false;
  btn.textContent = '发到酒馆';
  $('closePubOk').onclick = () => hideModal(m);
  bindMaskClose(m, () => { hideModal(m); pubokWork = null; });
  showModal(m);
}

async function submitPubok() {
  if (!pubokWork) return;
  const btn = $('pubokSend');
  if (btn.disabled) return;
  const ta = $('pubokText');
  let text = ((ta && ta.value) || '').trim();
  if (!text) {
    const t = String(pubokWork.title || '新作品').slice(0, 60);
    text = `刚上架新作品《${t}》，来碰杯！`;
  }
  if (text.length < 2) return showToast('至少写两个字', undefined, 'err');
  btn.disabled = true;
  try {
    const r = await fetch('/api/bar/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, workRef: location.origin + '/w/' + pubokWork.id })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '没发出去，再试一次');
    btn.textContent = '已发到酒馆 ✓';
    showToast('已同步到酒馆，散座里挂上了你的新作品卡', undefined, 'ok');
  } catch (err) {
    btn.disabled = false;
    showToast(err.message, undefined, 'err');
  }
}

async function copyPubokLink() {
  if (!pubokWork) return;
  const url = location.origin + '/w/' + pubokWork.id;
  try {
    await navigator.clipboard.writeText(url);
    showToast('作品链接已复制', undefined, 'ok');
  } catch {
    // 老浏览器 / 非 https 的兜底
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('作品链接已复制', undefined, 'ok'); }
    catch { showToast('复制失败，手动选中复制一下', undefined, 'err'); }
    ta.remove();
  }
}

let pubokBound = false;
function setupPublishOk() {
  if (pubokBound) return;
  pubokBound = true;
  $('pubokSend').onclick = submitPubok;
  $('pubokCopy').onclick = copyPubokLink;
  $('pubokCard').onclick = () => {
    if (!pubokWork) return;
    shareWorkDirect(pubokWork.id);   // 分享图弹窗在 DOM 里排在本弹窗后面，直接叠上去
  };
}

// 用 canvas 缩放图片，返回 Blob（失败时返回 null，让原图上传）
function resizeImage(file, maxSize, quality) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => resolve(b), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---------- 作品简介：Markdown 编辑器 ----------
// 表单里仍是同一个 textarea 存 Markdown 源码（提交字段名不变，后端照旧存 prompt）；
// 「预览」Tab 用与详情页同一份渲染器（/md.js）现算，所见即所得、不发额外请求。
function setupMdEditor() {
  const box = $('mdEditor');
  if (!box || box._mdInit) return;
  box._mdInit = 1;
  const ta = box.querySelector('textarea[name="prompt"]');
  const preview = $('mdPreview');
  const tabs = Array.from(box.querySelectorAll('.md-tab'));
  if (!ta || !preview || !tabs.length) return;
  const renderPreview = () => {
    const src = ta.value.trim();
    if (!src) { preview.innerHTML = '<p class="md-empty">还没有内容，切回「写」开始输入</p>'; return; }
    preview.innerHTML = window.MiniMd ? MiniMd.render(src) : escapeHtml(src).replace(/\n/g, '<br>');
  };
  tabs.forEach(btn => btn.addEventListener('click', () => {
    const isPreview = btn.dataset.mdTab === 'preview';
    tabs.forEach(b => b.classList.toggle('active', b === btn));
    ta.style.display = isPreview ? 'none' : '';
    preview.hidden = !isPreview;
    if (isPreview) renderPreview();
  }));
}

// ---------- 投诉 / 复制链接 ----------
// 详情弹窗关闭后的回退导航（✕ 关闭 / 屏蔽作品 / 拉黑作者三处共用）。
// 首选 history.back()：详情是 pushState 进来的，退回原页，列表原样保留。
// 但真机上 history.state 可能丢（微信等内核在详情开着时重载页面不保留 state），
// 这时不能再兜底「回首页」——改用来源页就地 replaceState 回去。
// 来源按可信度排：同源 referrer（整页打开时它才是真的来源）→ 打开详情前记下的
// sessionStorage → 都没有才回首页（/w/ 直链落地）。
const DETAIL_FROM_TTL = 30 * 60e3;   // sessionStorage 里的来源只认半小时，别拿上次停留的旧页面乱回
function leaveDetailNav(keepList) {
  if (!location.pathname.startsWith('/w/')) return;
  if (detailLeaving) return; // 连点 ✕：别把 back() 打两份，多退一页就窜到别的页面了
  if (history.state && history.state.dm === 'work') {
    detailLeaving = true;
    if (keepList) skipNextListReload = true; // 列表还在页面上，退回时别重载
    history.back();
    return;
  }
  // 走到这里说明详情是「整页」打开的（新标签 / 站内别的页直接链到 /w/xxx / 重载后 state 丢了）：
  // 同源 referrer 就是真正的来源页，优先级高于可能过期的 sessionStorage 备份
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.origin === location.origin && ref.pathname && !ref.pathname.startsWith('/w/')) {
      history.replaceState({}, '', ref.pathname + (ref.search || ''));
      route(); // 整页打开时列表是空的，route 里会按需重拉
      return;
    }
  } catch { /* referrer 畸形就当没有 */ }
  let from = (history.state && history.state.from) || null;
  if (!from) {
    try { from = JSON.parse(sessionStorage.getItem('dmDetailFrom') || 'null'); } catch { from = null; }
  }
  if (from && from.at && Date.now() - from.at > DETAIL_FROM_TTL) from = null;   // 过期的旧来源不可信
  if (from && from.path && !String(from.path).startsWith('/w/')) {
    history.replaceState({}, '', from.path + (from.search || ''));
    route();
    return;
  }
  history.pushState({}, '', '/'); route();
}

function setupDetailActions() {
  $('closeDetail').onclick = () => {
    hideModal(detailModal);
    // 弹窗是从首页/榜单/作者页打开的（history.state.dm === 'work'）就回退到原页面，
    // state 丢了就按打开前记下的来源页回去，只有从 /w/xxx 直链打开时才回首页
    leaveDetailNav(true);
  };
  bindMaskClose(detailModal, () => $('closeDetail').click());
  $('galPrev').onclick = () => setDetailImage(galState.idx - 1);
  $('galNext').onclick = () => setDetailImage(galState.idx + 1);
  // 点大图全屏看：刚滑完翻图手势的那一下不算点击
  $('detailImg').onclick = () => {
    if (Date.now() - detailSwipeAt < 600) return;
    openImgFull();
  };

  // 缩略图条左右滚动箭头：按需显隐，点击平滑滚动
  const galEl = $('detailGallery');
  $('thumbPrev').onclick = () => galEl.scrollBy({ left: -260, behavior: 'smooth' });
  $('thumbNext').onclick = () => galEl.scrollBy({ left: 260, behavior: 'smooth' });
  galEl.addEventListener('scroll', updateThumbArrows, { passive: true });
  window.addEventListener('resize', updateThumbArrows);

  // 操作栏「评论 N」→ 滚到评论区并聚焦输入框；评论区在截图和介绍之后，不滚很难被发现
  $('detailCmt').onclick = () => {
    const box = document.getElementById('detailComments');
    if (!box) return;
    try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch { box.scrollIntoView(); }
    const input = document.getElementById('commentInput');
    if (!input) return;
    // 等滚动落定再聚焦，否则手机键盘弹出会把页面顶回去
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } }, 380);
  };

  // 三选一轻反馈：点一下就是一条评论（作者会收到通知），不用组织语言。
  // 同一身份可改选，服务端只保留一条，不会刷屏。
  const voteBox = $('detailVote');
  if (voteBox) {
    voteBox.addEventListener('click', async e => {
      const w = state.currentWork;
      // 众判入口（感觉像推广 / 不像推广）：先摊开下方众判块让人看到进度与规则，
      // 再按所选立场直接计票。必须先拦下——下面三选一的 closest('.vote-btn') 会误捞到这两个按钮
      const entry = e.target.closest('[data-jury-entry]');
      if (entry && w) {
        if (!state.user) { showToast('登录后才能参与众判，投票永久保密', undefined, 'err'); openAuth('login'); return; }
        focusJuryVote();
        await submitJuryVote(entry.dataset.juryEntry);
        return;
      }
      const btn = e.target.closest('.vote-btn');
      if (!btn || !w || btn.classList.contains('active')) return;
      const vote = btn.dataset.vote;
      const all = voteBox.querySelectorAll('.vote-btn');
      all.forEach(b => (b.disabled = true));
      try {
        const res = await fetch(`/api/works/${encodeURIComponent(w.id)}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showToast(data.error || '提交失败', undefined, 'err'); return; }
        w.myVote = data.vote;
        all.forEach(b => b.classList.toggle('active', b.dataset.vote === data.vote));
        showToast(vote === 'useful' ? '已记下，谢谢反馈' : '已记下，作者会看到', undefined, 'ok');
        await loadComments(w.id);
        paintCommentCount(w.id, $('commentList').querySelectorAll('[data-id]').length);
      } catch {
        showToast('提交失败，请稍后重试', undefined, 'err');
      } finally {
        all.forEach(b => (b.disabled = false));
      }
    });
  }

  // 众人小法官：折叠条展开 + 两个众判按钮。和上面的三选一轻反馈是两条独立通道
  // （那条落成评论给作者看，这条算合规票、会被服务端用来判下架），别合并。
  const juryBox = $('detailJury');
  if (juryBox) {
    $('juryOpen').onclick = () => openJuryBox();
    juryBox.addEventListener('click', async e => {
      const btn = e.target.closest('.jury-btn');
      const w = state.currentWork;
      if (!btn || !w || btn.disabled) return;
      await submitJuryVote(btn.dataset.jury);
    });
  }

  $('detailLike').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    // 点赞 / 取消点赞：按钮上是什么态就按反态发（不再像以前那样点赞过就直接 return，
    // 那时候点第二下是纯死点击，用户根本不知道发生了什么）
    const likedNow = $('detailLike').classList.contains('liked');
    const res = await fetch(`/api/works/${w.id}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: !likedNow })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || '操作失败', undefined, 'err'); return; }
    if (data.self) { showToast('不能给自己的作品点赞', undefined, 'err'); return; }
    const now = data.liked === true;
    paintDetailLikes(data.likes);
    paintLikeBtn(w, now);
    // 匿名访客没有账号，只能把已赞态记在本机；登录用户的已赞态由服务端按账号下发
    try {
      if (now) localStorage.setItem('liked:' + w.id, '1');
      else localStorage.removeItem('liked:' + w.id);
    } catch { /* 隐私模式写不进就算了 */ }
    showToast(now ? '已点赞' : '已取消点赞', undefined, 'ok');
  };

  // 详情弹窗里的收藏按钮（需登录，与卡片 ★ 和顶部「收藏」列表同源）
  $('detailFav').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    const added = await toggleFav(w.id);
    if (added === null) return;
    renderDetailFav(w.id);
    paintFavButtons(w.id);
    showToast(added ? '已加入收藏' : '已取消收藏', undefined, 'ok');
  };

  // ---------- 打赏（灯火转移） ----------
  // 档位与服务端一致；余额、档位选择、最近打赏名单都归这个面板管。
  // 防洗分在服务端：登录限定、固定档位、每人/每设备每天转出上限、同设备对同作者限量。
  const TIP_AMOUNTS = [1, 2, 5, 10];
  let tipSelAmount = 0;
  let tipAuthorTarget = null;   // 非 null = 作者页直送模式（送给人，不挂作品）；作品打赏时保持 null

  // 档位按钮：作品打赏和作者直送共用同一套
  const renderTipAmounts = () => {
    $('tipAmounts').innerHTML = TIP_AMOUNTS.map(a =>
      `<button type="button" class="tip-amount" data-amount="${a}">${a} 盏</button>`).join('');
    $('tipAmounts').querySelectorAll('.tip-amount').forEach(b => {
      b.onclick = () => {
        tipSelAmount = Number(b.dataset.amount);
        $('tipAmounts').querySelectorAll('.tip-amount').forEach(x => x.classList.toggle('active', x === b));
        $('tipSend').disabled = false;
      };
    });
    $('tipSend').disabled = true;
  };

  // 注入到顶层：openWork 每次换作品时调用（弹窗收起、档位清空、余额重画）
  resetTipPanel = function (w) {
    hideModal($('tipPanel'));
    tipSelAmount = 0;
    tipAuthorTarget = null;
    // 匿名/游客投稿的作品也能送灯火：文案改成「记在作品上」，不承诺转给作者
    const claimed = !!(w && w.claimed);
    $('tipPanelTitle').textContent = claimed ? '为作者点亮一盏灯火' : '为这件作品点亮一盏灯火';
    $('tipNote').textContent = claimed
      ? '灯火全额记到作者账上；每人每天给同一位作者最多送 50 盏（同一网络下也一样，最多分 5 笔）。'
      : '作者还没绑定账号，你的灯火会记在这件作品上（计入作品灯火数与榜单综合分），不转给任何人；每人每天转出有上限，同一网络下一件作品最多送 5 笔。';
    renderTipAmounts();
    // 作者主页入口：详情页「送灯火」按钮打开面板时兜底一个主页跳转
    const home = $('tipAuthorHome');
    if (claimed && w && w.author && w.author !== '匿名') {
      home.style.display = '';
      home.textContent = `访问 @${dname(w)} 的主页 →`;
    } else home.style.display = 'none';
    $('tipRecent').innerHTML = '';
    updateTipBalance();
  }

  function updateTipBalance() {
    const pts = state.user ? Number(state.user.points || 0) : 0;
    $('tipBalance').innerHTML = state.user ? `我的灯火 <b>${pts}</b> 盏` : '登录后才能送灯火';
  }

  // 作者页直送：不挂作品，灯火全额转到作者账上（2026-11-13）
  function openAuthorTipPanel(uid, shown) {
    tipAuthorTarget = uid;
    tipSelAmount = 0;
    $('tipPanelTitle').textContent = `给 @${shown} 送灯火`;
    $('tipNote').textContent = '灯火全额转到作者账上；每人每天给同一位作者最多送 50 盏（同一网络下也一样，最多分 5 笔）。';
    $('tipAuthorHome').style.display = 'none';
    renderTipAmounts();
    $('tipRecent').innerHTML = '';
    showModal($('tipPanel'));
    updateTipBalance();
  }
  openAuthorTipPanelHook = openAuthorTipPanel;   // 顶层钩子：作者主页（loadAuthor）从这里进面板

  async function openTipPanel(w) {
    const p = $('tipPanel');
    // 居中弹窗：点「送灯火」立刻有反馈，不会再被当成点了没反应
    showModal(p);
    updateTipBalance();
    // 最近打赏名单（打开时拉一次），顺手校准总额（别人可能刚打赏过）
    try {
      const r = await fetch(`/api/works/${w.id}/tips`);
      const d = await r.json();
      if (r.ok) {
        $('tipRecent').innerHTML = (d.recent || []).map(t => {
          const date = new Date(t.at);
          const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          return `<div>${escapeHtml(t.name)} 送了 <b>${t.amount}</b> 盏 <span style="opacity:.7">· ${md}</span></div>`;
        }).join('');
        const num = $('detailTipsNum');
        if (num && typeof d.total === 'number') num.textContent = d.total;
      }
    } catch { /* 名单拉不到不影响打赏 */ }
  }

  $('detailTip').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    if (w.owned) { showToast('自己的作品就不用送灯火啦'); return; }
    if (!state.user) { openAuth('login'); return; }
    openTipPanel(w);
  };
  $('tipClose').onclick = () => { hideModal($('tipPanel')); };
  // 「小程序看广告替送 50 盏」入口：关掉本面板，开小程序码弹窗；
  // 用户扫码进小程序 → 打开这件作品 → 详情页底部「看广告替作品点灯」，平台代送不扣自己的余额
  $('tipMiniAd').onclick = () => {
    hideModal($('tipPanel'));
    const m = $('miniModal');
    if (m) showModal(m);
  };
  // 点遮罩空白处也能关
  bindMaskClose($('tipPanel'), () => $('tipClose').click());

  $('tipSend').onclick = async () => {
    if (!tipSelAmount) return;
    const btn = $('tipSend');
    btn.disabled = true;
    try {
      // 作者页直送：送给人，不挂作品；面板由 openAuthorTipPanel 打开
      if (tipAuthorTarget) {
        const res = await fetch(`/api/authors/${encodeURIComponent(tipAuthorTarget)}/tip`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: tipSelAmount })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || '送灯火失败');
        refreshPointsUI(d.points);
        updateTipBalance();
        showToast(`已送出 ${d.amount} 盏灯火，作者会收到站内消息`, undefined, 'ok');
        hideModal($('tipPanel'));
        tipAuthorTarget = null;
        tipSelAmount = 0;
        return;
      }
      const w = state.currentWork;
      if (!w) return;
      const res = await fetch(`/api/works/${w.id}/tip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: tipSelAmount })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '送灯火失败');
      refreshPointsUI(d.points);       // 头部灯火徽章、推荐面板余额卡就地刷新
      updateTipBalance();
      w.tipsTotal = d.tipsTotal;
      w.tipsCount = d.tipsCount;
      const num = $('detailTipsNum');
      if (num) num.textContent = d.tipsTotal;
      showToast(d.anonymousWork
        ? `已送出 ${d.amount} 盏灯火，记在这件作品上`
        : `已送出 ${d.amount} 盏灯火，作者会收到站内消息`, undefined, 'ok');
      hideModal($('tipPanel'));
      tipSelAmount = 0;
    } catch (err) {
      showToast(err.message, undefined, 'err');
      btn.disabled = false;   // 余额不足等可重试错误：保留档位选择
    }
  };

  $('detailAuthor').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    // 点作者名 = 进作者主页（2026-11-13 改回）；送灯火在主页有直送入口，详情页「送灯火」按钮照旧
    hideModal(detailModal);
    navigate('/u/' + encodeURIComponent(w.authorId || w.author));
  };
  // 送灯火面板里的「作者主页」入口：关掉面板和详情一起跳
  $('tipAuthorHome').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    hideModal($('tipPanel'));
    hideModal(detailModal);
    navigate('/u/' + encodeURIComponent(w.authorId || w.author));
  };

  // ---- 兑换码：访客领取 ----
  $('detailRedeem').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    const btn = $('detailRedeem');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/works/${w.id}/redeem`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '领取失败');
      $('codeDisplay').textContent = d.code;
      showModal($('codeModal'));
      if (!d.again && w.codesLeft > 0) { w.codesLeft = Math.max(0, w.codesLeft - 1); btn.textContent = w.codesLeft > 0 ? `兑换码（剩 ${w.codesLeft}）` : '查看我领的码'; }
    } catch (err) { showToast(err.message, undefined, 'err'); }
    finally { btn.disabled = false; }
  };

  $('closeCode').onclick = () => hideModal($('codeModal'));
  bindMaskClose($('codeModal'), () => hideModal($('codeModal')));
  $('copyCodeBtn').onclick = async () => {
    const code = $('codeDisplay').textContent;
    try { await navigator.clipboard.writeText(code); showToast('兑换码已复制', undefined, 'ok'); }
    catch { showToast(code); }
  };

  // ---- 兑换码：作者管理 ----
  $('detailCodes').onclick = () => {
    if (!state.currentWork) return;
    $('codeAddInput').value = '';
    $('codeManageList').innerHTML = '<div class="code-empty">加载中…</div>';
    showModal($('codeManageModal'));
    loadCodeManage();
  };
  $('closeCodeManage').onclick = () => hideModal($('codeManageModal'));
  bindMaskClose($('codeManageModal'), () => hideModal($('codeManageModal')));

  $('codeAddBtn').onclick = async () => {
    const w = state.currentWork;
    const text = $('codeAddInput').value.trim();
    if (!w || !text) { showToast('先粘贴或输入兑换码'); return; }
    const btn = $('codeAddBtn');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/works/${w.id}/codes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: text })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '添加失败');
      $('codeAddInput').value = '';
      showToast(d.dup ? `添加 ${d.added} 个，跳过重复 ${d.dup} 个` : `已添加 ${d.added} 个兑换码`, undefined, 'ok');
      loadCodeManage();
      if (w.codesTotal !== undefined) { w.codesTotal += d.added; w.codesLeft += d.added; renderCodeButtons(w); }
    } catch (err) { showToast(err.message, undefined, 'err'); }
    finally { btn.disabled = false; }
  };

  async function loadCodeManage() {
    const w = state.currentWork;
    if (!w) return;
    try {
      const res = await fetch(`/api/works/${w.id}/codes`, { credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '加载失败');
      const list = d.codes || [];
      $('codeManageList').innerHTML = list.length
        ? list.map(c => `<div class="code-row${c.status === 'taken' ? ' taken' : ''}">
            <span class="code-val">${escapeHtml(c.code)}</span>
            <span class="code-state">${c.status === 'taken' ? '已被领取' : '未领取'}</span>
            ${c.status === 'taken' ? '' : `<button type="button" class="code-del" data-code="${escapeHtml(c.code)}">删除</button>`}
          </div>`).join('')
        : '<div class="code-empty">还没有兑换码，在上面粘贴添加吧</div>';
    } catch (err) { $('codeManageList').innerHTML = `<div class="code-empty">${escapeHtml(err.message)}</div>`; }
  }

  $('codeManageList').addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('.code-del');
    if (!b) return;
    const w = state.currentWork;
    if (!w) return;
    try {
      const res = await fetch(`/api/works/${w.id}/codes/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: b.dataset.code })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '删除失败');
      showToast('已删除', undefined, 'ok');
      loadCodeManage();
    } catch (err) { showToast(err.message, undefined, 'err'); }
  });

  $('copyLinkBtn').onclick = async () => {
    // 登录用户分享时带上自己的 ref：好友通过它访问 / 注册，会算到你的分享成绩里
    const url = withRef(location.origin + '/w/' + state.currentWork.id);
    try {
      await navigator.clipboard.writeText(url);
      showToast(state.user ? '链接已复制（带你的分享码，好友访问会计入你的分享）' : '链接已复制，可以分享给朋友了', undefined, 'ok');
    } catch {
      showToast(url);
    }
  };

  // 分享卡片：Canvas 现场生成，带截图/简介/二维码
  $('shareCardBtn').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    if (window.ShareCard) window.ShareCard.open(w);
    else showToast('分享卡片加载中，稍后再试');
  };

  $('openReport').onclick = () => { showModal(reportModal); };
  $('closeReport').onclick = () => { hideModal(reportModal); };
  bindMaskClose(reportModal, () => hideModal(reportModal));

  // ---- 认领作品 ----
  const claimModal = $('claimModal');
  const claimFormEl = $('claimForm');
  // 按钮文案跟着「有没有填暗号」走：填了暗号 = 立即认领，别再让人以为还要等审核
  const syncClaimBtn = () => {
    const btn = $('claimBtn');
    if (!btn || btn.disabled) return;
    const hasCode = !!(claimFormEl.code && claimFormEl.code.value.trim());
    btn.textContent = hasCode ? '用暗号立即认领' : '提交认领申请';
  };
  if (claimFormEl.code) claimFormEl.code.addEventListener('input', syncClaimBtn);
  $('claimEntry').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    if (!state.user) { openAuth('login'); return; }
    if (w.claimAuthMine) {
      // 授权一键认领：站长已把作品授权给当前登录账号，确认后直接归到名下（服务端复验身份）
      if (!confirm(`站长已把「${w.title}」授权给你。\n确定一键认领到自己名下吗？\n认领后：署名、「我的作品 / 数据看板」、编辑与推广权限都归你。`)) return;
      const btn = $('claimEntry');
      btn.disabled = true;
      try {
        const res = await fetch('/api/works/' + w.id + '/claim', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showToast(data.error || '认领失败', undefined, 'err'); btn.disabled = false; return; }
        state.myClaims.push({ workId: w.id, status: 'approved', createdAt: new Date().toISOString() });
        showToast('认领成功，作品已归到你名下', undefined, 'ok');
        openWork(w.id, false); // 刷新详情：认领入口消失、管理条出现
      } catch { showToast('提交失败，请检查网络', undefined, 'err'); btn.disabled = false; }
      return;
    }
    claimFormEl.reset();
    $('claimWorkTitle').value = w.title;
    // 暗号输入框只在「这件作品设了暗号」时出现（服务端只回「有没有」，暗号本身不下发）
    const codeBox = $('claimCodeBox');
    if (codeBox) codeBox.style.display = w.claimCodeOn ? '' : 'none';
    // 暗号认领额外奖励：站长给这件作品单独承诺的一笔，认领前先把「多少、为什么给」讲清楚，
    // 别让作者认领完才发现多了一笔不知从哪来的灯火。没有这项就整块藏掉。
    const bonusTip = $('claimBonusTip');
    if (bonusTip) {
      const b = (w.claimCodeOn && w.claimBonus && w.claimBonus.points > 0) ? w.claimBonus : null;
      if (b) {
        bonusTip.innerHTML = `填对暗号并认领成功，额外送 <b>${b.points} 盏灯火</b>`
          + (b.reason ? `：${escapeHtml(b.reason)}` : '')
          + '（默认的上传奖励照发，这是另外加的一笔）';
        bonusTip.style.display = '';
      } else {
        bonusTip.style.display = 'none';
        bonusTip.textContent = '';
      }
    }
    syncClaimBtn();
    showModal(claimModal);
    setTimeout(() => {
      const codeInput = claimModal.querySelector('input[name="code"]');
      if (w.claimCodeOn && codeInput) codeInput.focus();
      else claimModal.querySelector('textarea[name="evidence"]').focus();
    }, 60);
  };
  $('closeClaim').onclick = () => hideModal(claimModal);
  bindMaskClose(claimModal, () => hideModal(claimModal));

  $('claimForm').addEventListener('submit', async e => {
    e.preventDefault();
    const w = state.currentWork;
    if (!w) return;
    const form = e.target;
    const code = String(form.code ? form.code.value : '').trim();
    const evidence = form.evidence.value.trim();
    const btn = $('claimBtn');
    if (!code && evidence.length < 10) {
      showToast('没有口令的话，请提供更具体的创作证据（至少 10 个字）', undefined, 'err');
      form.evidence.focus(); return;
    }
    btn.disabled = true; btn.textContent = code ? '认领中…' : '提交中…';
    try {
      const res = await fetch('/api/works/' + w.id + '/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, evidence, contact: form.contact.value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || '提交失败', undefined, 'err'); return; }
      // 填对口令：服务端当场归属（data.claimed），不用等审核
      if (data.claimed) {
        state.myClaims.push({ workId: w.id, status: 'approved', createdAt: new Date().toISOString() });
        hideModal(claimModal);
        showToast('认领成功，作品已归到你名下'
          + (data.bonusPoints ? `，另有 ${data.bonusPoints} 盏暗号认领额外奖励到账` : ''), undefined, 'ok');
        openWork(w.id, false); // 刷新详情：认领入口消失、管理条出现
        return;
      }
      state.myClaims.push({ workId: w.id, status: 'pending', createdAt: new Date().toISOString() });
      hideModal(claimModal);
      showToast('已提交，管理员审核通过后作品就归你了', undefined, 'ok');
      openWork(w.id, false); // 刷新认领入口为「审核中」
    } catch { showToast('提交失败，请检查网络', undefined, 'err'); }
    finally { btn.disabled = false; syncClaimBtn(); }
  });

  // 用暗号直接认领：数据看板空状态点「认领」进来的入口。作者手里只有站长发的暗号，
  // 不用先在站内翻到那件作品——填对暗号服务端自己找作品，当场归属，不用等审核。
  // openClaimByCode 是顶层函数（openStats 的空状态也会调它），这里只做弹窗绑定。
  const claimByCodeModal = $('claimByCodeModal');
  const claimByCodeForm = $('claimByCodeForm');
  if (claimByCodeModal) {
    $('closeClaimByCode').onclick = () => hideModal(claimByCodeModal);
    bindMaskClose(claimByCodeModal, () => $('closeClaimByCode').click());
    claimByCodeForm.addEventListener('submit', async e => {
      e.preventDefault();
      const code = String(claimByCodeForm.code.value || '').trim();
      if (!code) { showToast('请填写站长发你的认领暗号', undefined, 'err'); claimByCodeForm.code.focus(); return; }
      const btn = $('claimByCodeBtn');
      btn.disabled = true; btn.textContent = '认领中…';
      try {
        const res = await fetch('/api/claim/by-code', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showToast(data.error || '认领失败，请稍后再试', 6000, 'err'); return; }
        hideModal(claimByCodeModal);
        showToast(`「${data.title}」认领成功，作品已归到你名下`
          + (data.bonusPoints ? `，另有 ${data.bonusPoints} 盏暗号认领额外奖励到账` : ''), undefined, 'ok');
        loadMe();            // 顶部「我的作品」计数等跟着刷新
        openStats('data');   // 重开数据看板：刚认领的作品数据当场就能看见
      } catch { showToast('提交失败，请检查网络', undefined, 'err'); }
      finally { btn.disabled = false; btn.textContent = '用暗号立即认领'; }
    });
  }

  // 屏蔽这个作品：加入本人的屏蔽列表，列表/榜单/精选里立刻消失
  // 两个较新的按钮加存在性守卫：旧缓存 HTML 里可能没有，缺失就跳过，
  // 别让 TypeError 把后面的评论区绑定全部带崩
  const blockWorkBtn = $('blockWork');
  if (blockWorkBtn) blockWorkBtn.onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    if (!state.user) { openAuth('login'); return; }
    const res = await fetch(`/api/works/${w.id}/block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || '操作失败', undefined, 'err'); return; }
    state.blocked = Array.isArray(data.blocked) ? data.blocked : state.blocked;
    renderAuthBox();
    hideModal(detailModal);
    // 就地移除被屏蔽作品的卡片，避免整页重载把已加载的分页清空
    document.querySelectorAll(`.card[data-id="${w.id}"], .work-row[data-id="${w.id}"]`).forEach(el => el.remove());
    const cnt = $('workCount');
    const cur = parseInt((cnt.textContent.match(/\d+/) || [0])[0], 10) || 0;
    if (cur > 0) cnt.textContent = `共 ${cur - 1} 件`;
    // 回到上一页（首页/榜单/作者页），由 popstate 触发；列表 DOM 已更新，不再重载
    leaveDetailNav(true);
    showToast('已屏蔽，可在「我的主页 → 屏蔽管理」里恢复', undefined, 'ok');
  };

  // 拉黑 / 取消拉黑作者：TA 的所有作品都不再展示给我（含以后新发的）
  const blockAuthorBtn = $('blockAuthor');
  if (blockAuthorBtn) blockAuthorBtn.onclick = async () => {
    const w = state.currentWork;
    if (!w || !w.author) return;
    if (!state.user) { openAuth('login'); return; }
    const btn = $('blockAuthor');
    const turningOff = (state.blockedUsers || []).includes(w.author); // 已拉黑 → 本次是恢复
    btn.disabled = true;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(w.author)}/block`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !turningOff })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || '操作失败', undefined, 'err'); return; }
      state.blockedUsers = Array.isArray(data.blockedUsers) ? data.blockedUsers : state.blockedUsers;
      renderAuthBox();
      hideModal(detailModal);
      if (turningOff) {
        showToast('已取消拉黑，该作者的作品恢复显示', undefined, 'ok');
        if (!location.pathname.startsWith('/w/')) route();
      } else {
        // 拉黑生效：回到列表页重新渲染（重新带过滤条件），作者的全部作品都会消失
        if (location.pathname.startsWith('/w/')) {
          leaveDetailNav(false); // 不保留列表：拉黑后要按新过滤重拉
        } else {
          route();
        }
        showToast(`已拉黑 @${w.author}，TA 的作品不再展示给你，可在「我的主页 → 屏蔽管理」里恢复`);
      }
    } catch { showToast('操作失败，请稍后再试', undefined, 'err'); }
    finally { btn.disabled = false; }
  };

  $('commentReplyCancel').onclick = () => { cancelReply(); $('commentInput').focus(); };

  // 评论列表内的「回复 / 删除」（事件委托，列表重渲染也不用重新绑定）
  $('commentList').addEventListener('click', async e => {
    const del = e.target.closest('.comment-del');
    if (del) {
      const item = del.closest('[data-id]');
      if (!confirm('确定删除这条吗？它下面的回复会一起删除')) return;
      const res = await fetch('/api/comments/' + item.dataset.id, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || '删除失败', undefined, 'err'); return; }
      const w = state.currentWork;
      if (w) {
        const draft = $('commentInput').value;
        await loadComments(w.id);
        $('commentInput').value = draft;
        paintCommentCount(w.id, $('commentList').querySelectorAll('[data-id]').length);
      }
      showToast(data.removed > 1 ? `已删除，含 ${data.removed - 1} 条回复` : '已删除', undefined, 'ok');
      return;
    }
    const rep = e.target.closest('.comment-reply');
    if (rep) startReply(rep.dataset.reply, rep.dataset.rid);
  });

  // 发表评论 / 提问（登录或匿名均可）
  $('commentSend').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    const input = $('commentInput');
    const text = input.value.trim();
    if (!text) { showToast('先写点内容再发送吧'); return; }
    if (!state.user && text.length < 2) { showToast('至少写 2 个字吧'); return; }

    const payload = { text, kind: state.replyTo ? 'comment' : state.commentKind };
    // 「仅作者可见」只有登录用户能勾（服务端也会再拦一层）
    if (!state.replyTo && state.user) payload.priv = $('commentPriv').checked;
    if (state.replyTo) {
      payload.parentId = state.replyTo.rootId;
      payload.replyToId = state.replyTo.targetId;
    }
    const nick = $('commentNickname');
    if (!state.user && nick && nick.value.trim()) {
      payload.nickname = nick.value.trim();
      localStorage.setItem('cmtNick', nick.value.trim());
    }

    const btn = $('commentSend');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const res = await fetch(`/api/works/${w.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '发送失败');
      input.value = '';
      const cb = $('commentPriv');
      if (cb) cb.checked = false;
      cancelReply();
      // 重拉列表：提问要按「未回答置顶」重新排序，回复要挂到对应楼层
      await loadComments(w.id);
      paintCommentCount(w.id, $('commentList').querySelectorAll('[data-id]').length);
      const SENT_TOAST = { question: '提问已发布，等作者来答', bug: '反馈已发布，等作者处理', sug: '建议已发布，感谢反馈' };
      showToast(SENT_TOAST[payload.kind] || '已发布', undefined, 'ok');
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '发送';
    }
  };
  $('commentInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('commentSend').click();
  });

  // 编辑 / 删除自己的作品
  $('detailStarSync').onclick = () => openStarSync();
  // 推荐位入口：和发布菜单里的 promoBtn 同一条链路（openRedeem：未登录先弹登录，再进 /promote；路由切换会顺手关掉详情弹窗）
  const ownerPromoBtn = $('ownerPromoBtn');
  if (ownerPromoBtn) ownerPromoBtn.onclick = () => openRedeem();
  $('editWork').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    if (w.adminEdit === true && !w.owned) return openAdminEdit(w);
    if (editWorkFn) editWorkFn(w);
  };
  $('toggleHide').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    const hiding = !w.hidden;
    if (hiding && !confirm(`确定下架「${w.title}」吗？下架后别人看不到，只有你自己能看；数据保留，随时可重新上架。`)) return;
    try {
      const res = await fetch(`/api/works/${w.id}/visibility`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: hiding })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(d.error || '操作失败', undefined, 'err'); return; }
      showToast(d.hidden ? '已下架 · 现在只有你自己能看到' : '已重新上架，作品恢复公开', undefined, 'ok');
      openWork(w.id, false); // 重新拉取并刷新弹窗内容（按钮文案 + 横幅）
    } catch { showToast('网络异常，请稍后再试', undefined, 'err'); }
  };

  $('delWork').onclick = async () => {
    const w = state.currentWork;
    if (!w || !confirm(`确定删除「${w.title}」吗？删除后不可恢复。`)) return;
    const res = await fetch('/api/works/' + w.id, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || '删除失败', undefined, 'err'); return; }
    hideModal(detailModal);
    showToast('作品已删除', undefined, 'ok');
    route();
  };

  $('reportForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('reportBtn');
    btn.disabled = true; btn.textContent = '提交中...';
    try {
      const res = await fetch(`/api/works/${state.currentWork.id}/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData($('reportForm'))))
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '提交失败');
      hideModal(reportModal);
      hideModal(detailModal);
      $('reportForm').reset();
      showToast(data.message || '投诉已提交', undefined, 'err');
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '提交投诉';
    }
  });
}

// ---------- 已屏蔽作品 ----------
// ---------- 造梦酒馆 ----------
// 「你有什么想法，让大家实现吗」：一句话发想法 → 别人点「我也想要」→ 创作者认领 → 做完挂作品
// 列表展示见下方「合流时间线」：想法与闲聊一行一条混排，不再分版块、不再按热度切 tab
let ideaDoneId = '';
let ideaDetailId = '';
let ideaDetailData = null;
let ideaDiscussKind = 'scene';
let similarIdea = null;
let hotItemsCache = [];
const IDEA_DISCUSS_KIND_TEXT = { scene: '补充场景', solution: '推荐方案', progress: '进展更新' };
const IDEA_DISCUSS_PLACEHOLDER = {
  scene: '说说你会在什么情况下用它、现在是怎么凑合解决的…',
  solution: '推荐一个现成工具或类似作品，说清楚好用的地方…',
  progress: '做到哪一步了？还差什么？大概什么时候能挂作品…'
};

// 相对时间：列表卡片和抽屉时间线共用，不引入第三方库
function wishWhen(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t || Number.isNaN(t)) return '';
  const d = Math.max(0, Date.now() - t);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const dt = new Date(t);
  return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
}

function wishStatusHtml(i) {
  if (i.status === 'done' && i.work) {
    return `<a class="wish-status is-done" href="/w/${encodeURIComponent(i.work.id)}"
      onclick="event.stopPropagation()">✓ 已实现「${escapeHtml(i.work.title)}」</a>`;
  }
  if (i.status === 'claimed' && i.claimer) {
    return `<span class="wish-status is-claimed"><span class="ico">${ic('gear')}</span> @${escapeHtml(i.claimer.name)} 正在做</span>`;
  }
  return `<span class="wish-status is-open"><span class="ico">${ic('flag')}</span> 征集中</span>`;
}

// 大卡片版的想法卡（wishCardHtml）已随合流改版退役：列表走 feedRowHtml 的一行式，
// 想法的完整动作（我也想要 / 我来实现 / 讨论区）都在详情抽屉里。

// 大家最近在搜：服务端已把「真实搜索 + 冷启动种子」合并好，这里只负责画
// 只拉一次（榜单变化很慢）；拉失败就把整块收起来，别在页面上留一个空框
let hotSearchLoaded = false;
function renderHotItems() {
  const box = $('hotList');
  if (!box) return;
  box.innerHTML = hotItemsCache.map((it, i) => {
    const rank = i + 1;
    // 前 8 条按近 30 天搜过的人数、后 4 条按近 7 天人数（win7）排；数字跟着各自窗口走
    // 口径是人数：同一人反复搜同一个词只算 1，防刷
    // 人数：服务端组榜时已经定好（种子词 5-12 随机、真实词按去重人数），照它显示；
    // 只有服务端给 0（老记录认不出人）才用词名散列兜一个稳定的小数字——
    // 主榜 5-12、新位 1-3，跟种子区间对齐，别让一串「1 人」把榜单压得没人气
    const n0 = (it.win7 ? it.n7 : it.n30) || 0;
    let n = n0;
    if (!n) {
      let hsh = 0;
      for (let ci = 0; ci < it.w.length; ci++) hsh = (hsh * 31 + it.w.charCodeAt(ci)) >>> 0;
      const lo = it.win7 ? 1 : 5, hi = it.win7 ? 3 : 12;
      n = lo + (hsh % (hi - lo + 1));
    }
    const shown = n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n);
    // 人数为 0 就不挂数字（榜单里理论上不会出现，留着防止后端口径回退）
    const nHtml = n > 0 ? `<span class="hot-n">${shown}<i>人</i></span>` : '';
    // zero = 搜过但站内没结果：这种词不该把人送去一个空搜索页，改成「一键转成想法」
    const zero = !!it.zero;
    // 角标仿「大家都在搜」：主榜贴「热」，近 7 天补位贴「新」，0 结果的贴「缺」
    const badge = it.win7
      ? '<span class="hot-badge is-new7">新</span>'
      : zero ? '' : '<span class="hot-badge is-hot">热</span>';
    return `<button type="button" class="hot-item${rank <= 3 ? ' is-top' : ''}${zero ? ' is-zero' : ''}"
      data-kw="${escapeHtml(it.w)}" data-zero="${zero ? '1' : '0'}"
      title="${zero ? '站内还没搜到，点一下把它变成想法' : (it.win7 ? '近 7 天 ' + n + ' 人搜过，点一下去橱窗搜' : '近 30 天 ' + n + ' 人搜过，点一下去橱窗搜')}">
      <span class="hot-no">${rank}</span>
      <span class="hot-word">${escapeHtml(it.w)}</span>
      ${badge}
      ${zero ? '<span class="hot-zero">缺</span>' : ''}
      ${nHtml}
    </button>`;
  }).join('');
  applyHotFold();   // 重画（首次 / 换一换）之后把收起状态复原，别因为换一批就自己展开
}

// ---------- 热搜榜收起 / 展开（2026-11-13）----------
// 12 条全摊开：手机端 2 列要 6 行，把「提想法」的输入框整个顶到屏幕外；PC 也要 3 行。
// 所以默认只露 4 条（宽屏一行、手机两行），下面那条「展开全部 12 条」点开看全。
// 露几条不写死：列数跟着断点走（2 / 4 / 5 列），按实际 grid 列数算才不会留半行。
// 展开状态记在本机（dm_hot_open）：真去点开的人，下次进来别再给他收起来。
let hotOpen = false;
try { hotOpen = localStorage.getItem('dm_hot_open') === '1'; } catch { /* 隐私模式记不住，每次默认收起 */ }

function hotCols() {
  const box = $('hotList');
  if (!box) return 0;
  // getComputedStyle 会把 repeat() 解析成每个列宽（"150px 150px ..."），空格数就是列数
  const cols = (getComputedStyle(box).gridTemplateColumns || '').trim().split(/\s+/).filter(Boolean).length;
  return cols > 0 ? cols : 4;
}

// 收起时露几条：宽屏一行就是一屏的量；手机一行只放得下 2 个词，只露 2 条太寒酸，给两行
function hotFoldLimit() {
  const cols = hotCols();
  return cols >= 3 ? cols : cols * 2;
}

function applyHotFold() {
  const box = $('hotList'), board = $('hotBoard'), btn = $('hotToggle');
  if (!box || !board || !btn) return;
  const items = box.querySelectorAll('.hot-item');
  const total = items.length;
  const fold = hotFoldLimit();
  // 一屏都装得下就没有可展开的东西，按钮直接不出现
  const foldable = total > fold;
  const limit = (hotOpen || !foldable) ? total : fold;
  items.forEach((el, i) => { el.hidden = i >= limit; });
  board.classList.toggle('is-open', hotOpen && foldable);
  btn.hidden = !foldable;
  btn.setAttribute('aria-expanded', hotOpen && foldable ? 'true' : 'false');
  const label = btn.querySelector('span');
  if (label) label.textContent = hotOpen && foldable ? '收起' : `展开全部 ${total} 条`;
}

function toggleHotFold() {
  hotOpen = !hotOpen;
  try { localStorage.setItem('dm_hot_open', hotOpen ? '1' : '0'); } catch { /* 记不住就算了 */ }
  applyHotFold();
}

async function loadHotSearch() {
  const box = $('hotList');
  if (!box || hotSearchLoaded) return;
  hotSearchLoaded = true;
  try {
    const r = await fetch('/api/search/hot?limit=12');
    if (!r.ok) throw new Error('hot');
    const d = await r.json();
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) { $('hotBoard').style.display = 'none'; return; }
    hotItemsCache = items;
    renderHotItems();
    renderWishSuggest();
  } catch {
    hotSearchLoaded = false;   // 下次进页面再试
    box.innerHTML = '';
    $('hotBoard').style.display = 'none';
  }
}

// 换一换：服务端每次组榜都重新抽（9 条种子 + 3 条近期真被搜过的词，人数也跟着重抽），
// 所以这里重新要一批（roll=1 绕过 60s 缓存 + 浏览器缓存），不是本地洗牌。
// 只有拉失败才退回归宿：把手里这 12 条洗个顺序，至少点下去有反应、不至于一点动静都没有。
let hotRolling = false;
async function shuffleHotItems() {
  if (!hotItemsCache.length || hotRolling) return;
  hotRolling = true;
  try {
    const r = await fetch('/api/search/hot?limit=12&roll=1', { cache: 'no-store' });
    if (!r.ok) throw new Error('roll');
    const d = await r.json();
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) throw new Error('empty');
    hotItemsCache = items;
    renderHotItems();
    renderWishSuggest();
    hotRolling = false;
    return;
  } catch { /* 网络/接口不行：往下走本地洗牌 */ }
  for (let i = hotItemsCache.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [hotItemsCache[i], hotItemsCache[j]] = [hotItemsCache[j], hotItemsCache[i]];
  }
  renderHotItems();
  hotRolling = false;
}

// ---------- 造梦酒馆：近7日热门 / 书架 ----------
// 一次请求画两块（见 /api/bar/board）：热门条、书架一排。
// 失败就整块收起——宁可少一块，也别在页面上留一个空框子。
let barBoardLoaded = false;
async function loadBarBoard(force) {
  const hot = $('barHot'), shelf = $('barShelf');
  if (!hot || !shelf) return;
  if (barBoardLoaded && !force) return;
  barBoardLoaded = true;
  try {
    const r = await fetch('/api/bar/board', { cache: 'no-store' });
    if (!r.ok) throw new Error('board');
    const d = await r.json();
    renderBarHot(d);
    renderBarShelf(d);
  } catch {
    barBoardLoaded = false;   // 失败不缓存，下次进酒馆再试
    hot.hidden = true;
    shelf.hidden = true;
  }
}

// 2026-11-13 起热门只出两类：想法、闲聊（作品有自己的综合榜，不再复述）。
// 且按类型分两组摆（想要的归想要的、闲聊的归闲聊），组内按热度排、序号各自从 1 开始。
// 保留 work/done 的渲染分支只是为了老缓存响应不至于画崩，正常不会再进来。
const BH_KIND = { work: '作品', idea: '想要', done: '已实现', chat: '闲聊' };
const BH_GROUP = { idea: '想法 · 还在征集', chat: '闲聊 · 散座' };

  // 一张热门卡；i 是组内序号（从 0 起）。showKind=true 时带类型角标——
  // 只在「只有一个分组」时用得上，有组标题时角标是重复信息。
  // 闲聊卡角标跟散座分流同步（2026-11-14）：带作品的标「安利」、求工具的标「找工具」，其余照旧
  function barHotCardHtml(it, i, showKind) {  const chatBadge = it.kind !== 'chat' ? '' : (it.work ? '安利' : it.seek ? '找工具' : '');
  const chatBadgeCls = it.kind !== 'chat' ? '' : (it.work ? ' is-rec' : it.seek ? ' is-seek' : '');
  const chatKindLabel = chatBadge || (BH_KIND[it.kind] || '推荐');
  const badge = showKind ? `<span class="bh-kind is-${it.kind}${chatBadgeCls}">${chatKindLabel}</span>` : '';
  const icon = it.kind === 'chat' ? ic('chat', 18) : it.kind === 'idea' ? ic('wish', 18) : ic('check-circle', 18);
  const thumb = it.thumb
    ? `<span class="bh-thumb"><img src="${escapeHtml(it.thumb)}" alt="" loading="lazy" decoding="async" /></span>`
    : `<span class="bh-thumb is-text">${icon}</span>`;
  // 闲聊卡带的关联作品胶囊：点胶囊原地开作品详情弹窗（带来源记录，关掉回酒馆），
  // 点卡片其余部分弹帖子弹窗（全文 + 回应）
  const workChip = it.kind === 'chat' && it.work
    ? `<span class="bh-work" data-bwork="${escapeHtml(it.work.id)}" title="看这条闲聊关联的作品">作品 · ${escapeHtml(it.work.title)}</span>` : '';
  const inner = `<span class="bh-body"><span class="bh-title-row">${badge}<span class="bh-name">${escapeHtml(it.title)}</span></span>` +
    `<small class="bh-meta">${escapeHtml(it.meta || '')}</small>${workChip}</span>`;
  // 三种去向：作品/已实现 → 作品详情；想法 → 同页抽屉；闲聊 → 帖子弹窗
  // （闲聊的 id 不是作品 id，绝不能拼成 /w/ 链接，否则点了是 404）
  // is-first：每组第 1 条序号标红（原来靠 :first-child，现在组标题插在前面就不准了）
  const cls = 'bh-card' + (i === 0 ? ' is-first' : '');
  const no = `<span class="bh-no">${i + 1}</span>`;
  if (it.kind === 'idea') return `<button type="button" class="${cls}" data-bidea="${escapeHtml(it.id)}">${no}${thumb}${inner}</button>`;
  if (it.kind === 'chat') return `<button type="button" class="${cls}" data-bchat="${escapeHtml(it.id)}">${no}${thumb}${inner}</button>`;
  return `<a class="${cls}" href="/w/${encodeURIComponent(it.kind === 'done' ? it.workId : it.id)}">${no}${thumb}${inner}</a>`;
}

function renderBarHot(d) {
  const box = $('barHot');
  if (!box) return;
  const hot = Array.isArray(d && d.hot) ? d.hot : [];
  if (!hot.length) { box.hidden = true; return; }
  box.hidden = false;
  // 已知类型按「闲聊 → 想法」排（2026-11-13 站长定：闲聊放上边，散座是进门就能接话的那层），
  // 未知类型（老缓存）兜在最后
  const groups = ['chat', 'idea']
    .map(k => ({ kind: k, list: hot.filter(x => x.kind === k) }))
    .filter(g => g.list.length);
  const rest = hot.filter(x => x.kind !== 'idea' && x.kind !== 'chat');
  if (rest.length) groups.push({ kind: '', list: rest });
  // 只有一类时不摆组标题（那几天只剩闲聊，多一行标题纯占地方），改回卡上角标
  const showHead = groups.length > 1;
  $('bhList').innerHTML = groups.map(g => {
    const head = showHead && g.kind
      ? `<div class="bh-group">${BH_GROUP[g.kind] || ''}<i>${g.list.length}</i></div>` : '';
    return head + g.list.map((it, i) => barHotCardHtml(it, i, !showHead)).join('');
  }).join('');
}

function renderBarShelf(d) {
  const box = $('barShelf'), list = $('bsList');
  if (!box || !list) return;
  const items = Array.isArray(d && d.shelf) ? d.shelf : [];
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  // 卡片形式与「本周热门」统一（2026-11-12 站长定的）：图标 + 标题行（右侧个数）+ 一行描述。
  // 不再是单行横排——右栏三块（推荐位 / 热门 / 书架）从此是一套卡片语言
  list.innerHTML = items.map(s => `<a class="bs-card" href="${escapeHtml(s.href)}">
    <span class="bs-ico">${ic('folder', 18)}</span>
    <span class="bs-body">
      <span class="bs-title-row"><span class="bs-name">${escapeHtml(s.title)}</span>${s.n ? `<i class="bs-n">${s.n} 个</i>` : ''}</span>
      <small class="bs-sub">${escapeHtml(s.sub || '')}</small>
    </span>
  </a>`).join('');
}

// ---------- 造梦酒馆 · 合流时间线（想法 + 闲聊） ----------
// 展示上合成一条论坛式时间线：一行一条、按时间归并。数据仍分表——
// 想法池的「N 人想要」不能被闲聊稀释，这里只是前端归并渲染。
// 想法行点击开详情抽屉；闲聊行点击原地展开回应/碰杯。
const feedState = {
  // 时间线：想法与闲聊由服务端 /api/bar/feed 合并成一条按时间倒序的流，
  // 前端只按顺序铺；翻页拿下一段直接 append 到尾部，不再整表重绘。
  // rows 统一是 { kind:'idea'|'chat', at, id, idea|post }。
  rows: [], next: '', rendered: 0,
  ideaTotal: 0, chatTotal: 0, loading: false,
  // 还没下发的那部分里有多少条想法：想法池冷的时候它们会被几十句闲聊压到最末页，
  // 「加载更早的」按钮上要能看见「还有 N 条想法」，不然等于没有入口
  leftIdeas: 0, leftChats: 0,
  // 话题：点任一标签就进这个话题（只留闲聊），tag 为空表示看全部。
  // 规则与服务端 barTagsOf 对齐：# + 话题名（1~20 字，不含空格/#/常见标点），
  // 空格、标点或写到句尾即收尾（微博/小红书写法，2026-11-13 定的）；一条最多 3 个。
  tag: '', tagTotal: 0
};
const BAR_TAG_MAX = 3;
const BAR_TAG_STOP = '\\s#，。！？、；：·「」『』（）【】《》,.;:!?"\'()\\[\\]{}<>';
const BAR_TAG_RE_SRC = '#([^' + BAR_TAG_STOP + ']{1,20})(?=[' + BAR_TAG_STOP + ']|$)';
let barTagsCache = [];   // [{tag, n}]，话题栏与输入框联想共用

function barTagsOf(text) {
  const out = [];
  const s = String(text || '');
  if (s.indexOf('#') < 0) return out;
  const re = new RegExp(BAR_TAG_RE_SRC, 'g');
  let m;
  while ((m = re.exec(s)) && out.length < BAR_TAG_MAX) {
    const t = m[1].trim();
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
// 整条只剩标签 = 开个话题（只发一个 #xxx 的帖子）
function barIsTopicStart(text) {
  const s = String(text || '');
  if (!barTagsOf(s).length) return false;
  return !/[\p{L}\p{N}]/u.test(s.replace(new RegExp(BAR_TAG_RE_SRC, 'g'), ''));
}
// 散座角标分流（2026-11-14）：以前只有「话题/闲聊」两种，一屏全是「闲聊」太单调。
// 按现有数据分档，不动数据结构、不迁移老帖：
//   关联了作品 → 「安利」（行上本来就挂着作品入口，标出来别淹没）；
//   整条只剩 #标签 → 「话题」；
//   带 #找工具 / #求工具 / #找资源 → 「找工具」（散座里求工具的不少，别跟闲聊混成一片）；
//   其余 → 「闲聊」。
// 优先级 带作品 > 话题 > 找工具：正文里的 #标签 胶囊照样可点进话题，不吃亏。
// 找工具只认显式标签，不做「有没有人做过」这种句式识别——误伤太多（服务端 barPostSeek 同口径）。
const BAR_SEEK_TAGS = ['找工具', '求工具', '找资源'];
function barChatKindOf(p, topicStart) {
  if (p && p.work) return 'rec';
  if (topicStart) return 'topic';
  if (p && p.seek) return 'seek';
  if (p && BAR_SEEK_TAGS.some(s => barTagsOf(p.text).some(t => t.toLowerCase() === s))) return 'seek';
  return 'chat';
}
const BAR_CHAT_KIND_LABEL = { rec: '安利', topic: '话题', seek: '找工具', chat: '闲聊' };
const BAR_CHAT_KIND_CLS = { rec: 'br-kind-rec', topic: 'br-kind-topic', seek: 'br-kind-seek', chat: 'br-kind-chat' };
const BAR_CHAT_KIND_TITLE = {
  rec: '带着作品的闲聊：点作品名就能进去看',
  topic: '只发了话题标签，等于开个话题等人来接',
  seek: '在找一个能干活的工具（带 #找工具 标签的帖子）'
};
// 正文 → 带话题标签的 HTML：标签是可点的胶囊，点了看这个话题下的所有闲聊。
// 第 4 个起不再解析，原样当文字，免得有人拿标签刷屏。
function barTextHtml(text) {
  const s = String(text || '');
  const re = new RegExp(BAR_TAG_RE_SRC, 'g');
  let html = '', last = 0, m, n = 0;
  while ((m = re.exec(s))) {
    if (n >= BAR_TAG_MAX) break;
    n++;
    const tag = m[1].trim();
    html += escapeHtml(s.slice(last, m.index));
    const on = feedState.tag && feedState.tag.toLowerCase() === tag.toLowerCase();
    html += `<button type="button" class="br-tag${on ? ' is-on' : ''}" data-tag="${escapeHtml(tag)}"
      title="${on ? '再看全部闲聊' : '看这个话题下的闲聊'}">#${escapeHtml(tag)}</button>`;
    last = m.index + m[0].length;
  }
  html += escapeHtml(s.slice(last));
  return html;
}

// 行渲染统一收 /api/bar/feed 给的 { kind, at, id, idea|post } 包装对象
function feedRowHtml(w) {
  if (w.kind === 'idea') {
    const i = w.idea;
    const id = escapeHtml(i.id);
    return `<div class="bar-row is-idea${i.status === 'done' ? ' is-done' : ''}" data-type="idea" data-id="${id}" data-at="${escapeHtml(w.at || i.createdAt || '')}">
      <div class="br-line">
        <span class="br-kind">想法</span>
        <button type="button" class="br-title" data-open="${id}">${escapeHtml(i.title)}</button>
        ${wishStatusHtml(i)}
        <span class="br-meta">
          <span class="br-author">@${escapeHtml(i.author)}</span>
          <span class="br-when">${escapeHtml(wishWhen(i.createdAt))}</span>
          <span class="br-stat" title="想要的人">${ic('thumb', 12)} ${i.wants || 0}</span>
          <span class="br-stat" title="讨论数">${ic('chat', 12)} ${i.discussionCount || 0}</span>
        </span>
        ${i.mine ? `<button type="button" class="br-del" data-del="${id}" title="删除这个想法">✕</button>` : ''}
      </div>
    </div>`;
  }
  const p = w.post;
  const id = escapeHtml(p.id);
  const topicStart = p.topicStart != null ? !!p.topicStart : barIsTopicStart(p.text);
  const kind = barChatKindOf(p, topicStart);
  return `<div class="bar-row is-chat${topicStart ? ' is-topic' : ''}" data-type="chat" data-id="${id}" data-at="${escapeHtml(w.at || p.createdAt || '')}">
      <div class="br-line">
        <span class="br-kind ${BAR_CHAT_KIND_CLS[kind]}"${BAR_CHAT_KIND_TITLE[kind] ? ` title="${BAR_CHAT_KIND_TITLE[kind]}"` : ''}>${BAR_CHAT_KIND_LABEL[kind]}</span>
        <span class="br-title">${barTextHtml(p.text)}</span>
        ${p.work ? `<a class="br-work" href="/w/${encodeURIComponent(p.work.id)}" title="看这条闲聊关联的作品">${ic('check-circle', 12)} ${escapeHtml(p.work.title)}</a>` : ''}
        <span class="br-meta">
          <span class="br-author">@${escapeHtml(p.author)}</span>
          <span class="br-when">${escapeHtml(wishWhen(p.createdAt))}</span>
          <!-- 行首计数收编成按钮（2026-11-13）：碰杯数一点就是碰杯、回应数一点直接展开回应区，不用先展开再找下面的钮 -->
          <button type="button" class="br-stat br-stat-btn br-stat-like${p.liked ? ' is-on' : ''}" data-like="${id}"
            title="碰个杯，表示你有同感">${ic('heart', 12)} <b>${p.likes || 0}</b></button>
          <button type="button" class="br-stat br-stat-btn" data-focus-reply="${id}"
            title="看回应，点这儿打开这条帖子">${ic('chat', 12)} <b>${p.replyCount || 0}</b></button>
        </span>
        ${p.mine ? `<button type="button" class="br-del" data-del-chat="${id}" title="删掉这句">✕</button>` : ''}
      </div>
    </div>`;
}

// 时间线已经是排好序的（服务端按时间倒序合并），这里不再二次归并。
function feedRows() { return feedState.rows; }

// append=true 时只把「还没铺过的那几条」接到列表尾部——翻页专用，保住已有 DOM、
// 展开态和滚动位置；整表重绘只在首屏、话题切换、以及单条数据被替换时发生。
function renderFeed(opts = {}) {
  const list = $('wishList');
  if (!list) return;
  const count = $('feedCount');
  const moreBtn = $('wishMore');
  const tagMode = !!feedState.tag;
  // 话题过滤态里没有「想法」什么事，冷启动补位卡一起收掉
  const sug = $('wishSuggest');
  if (tagMode && sug) sug.hidden = true;
  if (count) {
    count.textContent = tagMode
      ? `话题 #${feedState.tag}# · ${feedState.tagTotal || feedState.rows.length} 句闲聊`
      : ((feedState.ideaTotal || feedState.chatTotal)
        ? `${feedState.ideaTotal || 0} 个想法 · ${feedState.chatTotal || 0} 句闲聊` : '');
  }
  const rows = feedRows();
  if (!rows.length) {
    list.innerHTML = tagMode
      ? `<div class="wish-empty">话题 #${escapeHtml(feedState.tag)}# 下还没有闲聊，下面这一句可以是你说的
          <button type="button" class="wish-empty-back" data-tag="">× 看全部闲聊</button></div>`
      : '<div class="wish-empty">还没有人发言——在上面提个想法，或者随便说一句</div>';
    feedState.rendered = 0;
    if (moreBtn) moreBtn.style.display = 'none';
    if (!tagMode) renderWishSuggest();
    return;
  }
  // 追加前先核一下 DOM 跟记录对不对得上（别处整块换过 innerHTML 时退回全量重绘，宁可慢一次也不能错位）
  const domRows = list.querySelectorAll('.bar-row').length;
  const start = (opts.append && domRows && domRows === feedState.rendered)
    ? Math.min(feedState.rendered, rows.length) : 0;
  if (start > 0) {
    if (rows.length > start) list.insertAdjacentHTML('beforeend', rows.slice(start).map(feedRowHtml).join(''));
  } else {
    list.innerHTML = rows.map(feedRowHtml).join('');
  }
  feedState.rendered = rows.length;
  // 话题模式下「还有 N 句更早的」：以前只有一次 30 句的硬顶，现在能一直往下翻，
  // 这条提示只剩「翻到底但确实还有」的兜底作用（正常不会出现）
  const oldNote = list.querySelector('.bar-tag-more');
  if (oldNote) oldNote.remove();
  if (tagMode && feedState.tagTotal > rows.length && !feedState.next) {
    list.insertAdjacentHTML('beforeend',
      `<div class="bar-tag-more">这个话题下还有 ${feedState.tagTotal - rows.length} 句更早的闲聊</div>`);
  }
  if (moreBtn) {
    // 一条流一个游标：还有 next 就能翻，翻完按钮自己消失，不再出现「一直点、数字不动」
    const left = Math.max(0, (tagMode ? feedState.tagTotal : (feedState.ideaTotal + feedState.chatTotal)) - rows.length);
    moreBtn.style.display = feedState.next ? '' : 'none';
    if (feedState.next) {
      // 想法被闲聊压到后面时，按钮上直接点明「还有 N 条想法」——
      // 只写「还有 15 条」没人知道里面藏着想法（11-14 站长反馈）
      const li = tagMode ? 0 : (feedState.leftIdeas || 0);
      const lc = tagMode ? left : Math.max(0, left - li);
      moreBtn.textContent = li > 0
        ? `加载更早的（还有 ${li} 条想法${lc > 0 ? ` · ${lc} 条闲聊` : ''}）→`
        : (left ? `加载更早的（还有 ${left} 条）→` : '加载更早的 →');
    }
  }
  if (!tagMode) renderWishSuggest();
}

// 只重画一行（盖楼后的局部刷新）：整表重绘会丢展开态、长列表还要重排一遍。
// 行内事件都是 #wishList 上的委托，换掉节点不会断绑定。
function reRenderFeedRow(id) {
  const row = feedState.rows.find(x => x.id === id);
  const el = document.querySelector(`#wishList .bar-row[data-id="${id}"]`);
  if (!row || !el) { renderFeed(); return; }
  el.outerHTML = feedRowHtml(row);
}

// ---------- 话题栏：点标签看这个话题下的闲聊 ----------
// 一排就够，不做话题页：酒馆是聊天的地方，点一下原地过滤比跳页顺手。
// 话题多了以后前 8 个放不下，加个「搜话题」：展开全部（最多 40 个）边打边滤，
// 回车进第一个匹配的；搜不到就明说「写 #话题名 发一句就开了」。
let topicSearchOpen = false;
let topicSearchQ = '';
const TOPIC_BAR_LIMIT = 8;      // 平时一排最多摆几个
const TOPIC_SEARCH_LIMIT = 40;  // 搜索展开时最多列几个，再多的靠关键字缩小范围

function renderTopicBar() {
  const box = $('barTopics');
  if (!box) return;
  if (feedState.tag) {
    topicSearchOpen = false;
    // 选中话题只做高亮（is-on），其他话题照常摆着、点了直接切换；
    // 选中件不在前 8 时补进来，保证它不被挤没。
    const cur = feedState.tag.toLowerCase();
    let pool = barTagsCache.slice(0, TOPIC_BAR_LIMIT);
    const hit = barTagsCache.find(t => t.tag.toLowerCase() === cur);
    if (hit && !pool.includes(hit)) pool = pool.slice(0, TOPIC_BAR_LIMIT - 1).concat(hit);
    const n = feedState.tagTotal || (hit && hit.n) || 0;
    const chips = pool.map(t => {
      const on = t.tag.toLowerCase() === cur;
      const cnt = on ? (n || t.n) : t.n;
      return `<button type="button" class="bt-chip${on ? ' is-on' : ''}" data-tag="${escapeHtml(t.tag)}"
        title="${on ? '再点一下回到全部闲聊' : '看这个话题下的闲聊'}">#${escapeHtml(t.tag)} <i>${cnt}</i></button>`;
    }).join('');
    box.innerHTML = '<span class="bt-label">话题</span>' + chips +
      `<button type="button" class="bt-clear" data-tag="">× 看全部闲聊</button>`;
    return;
  }
  const searching = topicSearchOpen;
  const pool = barTagsCache.slice(0, searching ? TOPIC_SEARCH_LIMIT : TOPIC_BAR_LIMIT);
  if (!pool.length && !searching) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const q = topicSearchQ.trim().toLowerCase();
  const chips = pool.map(t => {
    const hide = searching && q && !t.tag.toLowerCase().includes(q) ? ' is-hidden' : '';
    return `<button type="button" class="bt-chip${hide}" data-tag="${escapeHtml(t.tag)}"
      title="看这个话题下的闲聊">#${escapeHtml(t.tag)} <i>${t.n}</i></button>`;
  }).join('');
  const searchBtn = `<button type="button" class="bt-search-toggle${searching ? ' is-open' : ''}"
    title="${searching ? '收起话题搜索' : '搜已有话题'}">${searching ? '收起' : '搜话题'}</button>`;
  // 搜索态的补充说明：话题太多截断了说一声；打了字但一个都没匹配上说「没有这个话题」
  let note = '';
  if (searching && barTagsCache.length > TOPIC_SEARCH_LIMIT) {
    note = `<span class="bt-search-none">共 ${barTagsCache.length} 个话题，只列了前 ${TOPIC_SEARCH_LIMIT} 个，输入关键字缩小范围</span>`;
  } else if (searching && q) {
    note = '<span class="bt-search-none" data-none hidden></span>';
  }
  box.innerHTML = '<span class="bt-label">话题</span>' +
    (searching ? `<input type="text" class="bt-search" placeholder="搜已有话题，回车进第一个" value="${escapeHtml(topicSearchQ)}">` : '') +
    chips + searchBtn + note +
    '<span class="bt-hint">写 #话题 加空格收尾，就能归到一起</span>';
  if (searching) wireTopicSearch(box);
}

// 搜索框是 renderTopicBar 重画出来的，每次渲染完都得重新接事件；
// 过滤只切 is-hidden 不重画 HTML，不然打一个字焦点就丢了。
function wireTopicSearch(box) {
  const input = box.querySelector('.bt-search');
  if (!input) return;
  const none = box.querySelector('[data-none]');
  const sync = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    box.querySelectorAll('.bt-chip').forEach(c => {
      const on = !q || c.dataset.tag.toLowerCase().includes(q);
      c.classList.toggle('is-hidden', !on);
      if (on) shown++;
    });
    if (none) {
      const raw = input.value.trim();
      none.hidden = !(q && !shown);
      if (q && !shown) none.textContent = `没有 #${raw.slice(0, 20)} 这个话题，写 #话题名 发一句就开了`;
    }
  };
  input.addEventListener('input', () => { topicSearchQ = input.value; sync(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = box.querySelector('.bt-chip:not(.is-hidden)');
      if (first) { topicSearchOpen = false; topicSearchQ = ''; setBarTag(first.dataset.tag); }
    } else if (e.key === 'Escape') {
      topicSearchOpen = false; topicSearchQ = '';
      renderTopicBar();
    }
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function loadBarTags() {
  try {
    const r = await fetch('/api/bar/tags', { cache: 'no-store' });
    if (!r.ok) throw new Error('tags');
    const d = await r.json();
    barTagsCache = Array.isArray(d.items) ? d.items : [];
  } catch { /* 拉不到就沿用上次的，别把话题栏整块撤掉 */ }
  renderTopicBar();
  updateChatTagHint();
}

// 进/出话题：点标签进、再点同一个（或点「看全部」）回全部。
// 光标位置一律回到话题栏，否则在长列表中点标签，人还停在原来的滚动位置，像没反应。
function setBarTag(tag) {
  const t = String(tag || '').trim().slice(0, 20);
  const same = t && feedState.tag && t.toLowerCase() === feedState.tag.toLowerCase();
  const next = (same || !t) ? '' : t;
  if (next === feedState.tag) return;
  feedState.tag = next;
  feedState.rows = [];
  feedState.next = '';
  feedState.rendered = 0;
  feedState.tagTotal = 0;
  renderTopicBar();
  loadFeed(true);
  const anchor = $('barTopics') || $('wishList');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let feedSeq = 0;   // 请求序号：话题切换/发布后重拉时，晚到的旧响应不许覆盖新结果

async function loadFeed(reset) {
  const list = $('wishList');
  if (!list) return;
  if (!reset && feedState.loading) return;   // 连点「加载更早的」不重复发请求
  const tagMode = !!feedState.tag;
  const q = new URLSearchParams();
  // 一页 20 条：首屏够看，翻页也够快；话题模式给 30（只出闲聊）
  q.set('limit', tagMode ? '30' : '20');
  if (tagMode) q.set('tag', feedState.tag);
  if (!reset && feedState.next) q.set('before', feedState.next);
  const seq = ++feedSeq;
  feedState.loading = true;
  try {
    const r = await fetch('/api/bar/feed?' + q.toString(), { cache: 'no-store' });
    if (seq !== feedSeq) return;
    const d = r.ok ? await r.json() : {};
    const items = Array.isArray(d.items) ? d.items : [];
    if (reset) {
      feedState.rows = items;
      feedState.rendered = 0;
    } else {
      // 游标翻页本身不重不漏；刚好有新帖落在边界上时按 id 兜一道去重
      const seen = new Set(feedState.rows.map(x => x.id));
      items.forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); feedState.rows.push(x); } });
    }
    feedState.next = d.next || '';
    if (d.total) {
      feedState.ideaTotal = d.total.ideas || 0;
      feedState.chatTotal = d.total.chats || 0;
    }
    if (d.left) {
      feedState.leftIdeas = d.left.ideas || 0;
      feedState.leftChats = d.left.chats || 0;
    } else if (!d.next) {
      feedState.leftIdeas = 0; feedState.leftChats = 0;
    }
    feedState.tagTotal = tagMode ? feedState.chatTotal : 0;
    // 统计与「愿望成真」只在第一页返回；翻页时别拿空值把它们清掉
    if (d.stats) renderWishStats(d.stats);
    if (d.doneList) renderWishDone(d.doneList);
    renderFeed({ append: !reset });
  } catch {
    if (reset) list.innerHTML = '<div class="wish-empty">加载失败，稍后再试</div>';
  } finally {
    if (seq === feedSeq) feedState.loading = false;
  }
}

function updateChatCount() {
  const ta = $('chatInput'), box = $('chatCount');
  if (!ta || !box) return;
  box.textContent = `${ta.value.length}/200`;
}

// 写的时候就把话题说出来：正文里的 #话题 一下就能看出会被归到哪儿，
// 已存在的话题显示已有几句（点进去就能接话），新话题明说「发出去就有了」。
// 写错姿势（话题名夹空格/标点、太长）也要当场教，
// 不然提示直接消失，用户对着一个 # 不知道下一步干嘛。
function updateChatTagHint() {
  const ta = $('chatInput'), box = $('chatTagHint');
  if (!ta || !box) return;
  const tags = barTagsOf(ta.value);
  if (!tags.length) {
    const v = ta.value;
    const hashN = (v.match(/#/g) || []).length;
    let teach = '';
    if (hashN >= 1) {
      if (/#\s*$/.test(v)) {
        // # 刚打完还没写名字：差的就是话题名
        teach = '<span class="cth-lead">在 # 后面写话题名，写完空格收尾</span>' +
          '<span class="cth-chip" title="照这样写就会归到一个话题下">比如 #AI绘画 </span>';
      } else {
        // # 后面夹了空格/标点，名字没连上
        teach = '<span class="cth-lead">这样还不算话题</span>' +
          '<span class="cth-chip" title="话题名 1~20 个字，中间不能有空格和标点">话题名 1~20 字、不能有空格，如 #AI绘画</span>';
      }
    }
    if (teach) { box.hidden = false; box.innerHTML = teach; }
    else { box.hidden = true; box.innerHTML = ''; }
    return;
  }
  const alone = barIsTopicStart(ta.value);
  // 带了 #找工具/#求工具/#找资源 的帖子角标会变成「找工具」——提前说一句，别让人以为白写了
  const isSeek = tags.some(t => BAR_SEEK_TAGS.includes(t.toLowerCase()));
  box.hidden = false;
  box.innerHTML = `<span class="cth-lead">${alone ? '只发话题，等于开个话题等人来接' : (isSeek ? '会归到 · 角标显示「找工具」' : '会归到')}</span>` +
    tags.map(t => {
      const hit = barTagsCache.find(x => x.tag.toLowerCase() === t.toLowerCase());
      return `<span class="cth-chip${hit ? ' is-exist' : ''}"
        title="${hit ? `这个话题已经有 ${hit.n} 句闲聊` : '新话题，发出去就有了'}">#${escapeHtml(t)}<i>${hit ? '已有 ' + hit.n + ' 句' : '新话题'}</i></span>`;
    }).join('');
}

// 「＋ 话题」：不逼人背语法——插一个 # 把光标放后面；选中了字就直接裹上并空格收尾
function insertChatTag() {
  const ta = $('chatInput');
  if (!ta) return;
  const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const e = ta.selectionEnd == null ? s : ta.selectionEnd;
  const picked = ta.value.slice(s, e).trim().replace(/[#\s]/g, '').slice(0, 20);
  const ins = picked ? `#${picked} ` : '#';
  ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
  const caret = s + ins.length;
  ta.focus();
  try { ta.setSelectionRange(caret, caret); } catch { /* 老浏览器不支持就算了 */ }
  updateChatCount();
  updateChatTagHint();
}

// 散座的推广位已搬去右栏「本周热门」上方（2026-11-12），DOM 里就在 bar-rail 里安家，
// renderAdSlot 直接渲染、不再往话题流里搬——散座楼层保持纯聊天，一处推荐不重复计曝光。

async function submitChat() {
  const ta = $('chatInput');
  if (!ta) return;
  const text = ta.value.trim();
  if (text.length < 2) return showToast('至少写两个字', undefined, 'err');
  if (!state.user) { openAuth('login'); return; }
  const btn = $('chatSend');
  btn.disabled = true;
  try {
    const workRefEl = $('chatWorkRef');
    const workRef = workRefEl ? workRefEl.value.trim() : '';
    const r = await fetch('/api/bar/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, workRef })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '没发出去，再试一次');
    ta.value = '';
    chatRefReset(true);   // 关联作品连 chip 一起清掉，发布框回到收起态
    updateChatCount();
    updateChatTagHint();
    // 正在看某个话题时发了句别的：别让人「发完就找不着」——回到全部，同时把新话题说出来
    const posted = Array.isArray(d.tags) ? d.tags : barTagsOf(d.text || '');
    const inTopic = feedState.tag && posted.some(t => t.toLowerCase() === feedState.tag.toLowerCase());
    if (feedState.tag && !inTopic) { feedState.tag = ''; feedState.tagTotal = 0; renderTopicBar(); }
    showToast(d.work
      ? `说完了，已关联作品「${d.work.title}」`
        : (posted.length
          ? `说完了，归到话题 ${posted.map(t => '#' + t).join(' ')}`
          : '说完了，等有人接话'), undefined, 'ok');
    loadFeed(true);
    loadBarTags();   // 话题栏的句数跟着改，新话题也立刻出现在上面
  } catch (e) { showToast(e.message, undefined, 'err'); }
  finally { btn.disabled = false; }
}

async function chatLike(id) {
  if (!state.user) { openAuth('login'); return; }
  try {
    const r = await fetch(`/api/bar/posts/${encodeURIComponent(id)}/like`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '操作失败');
    const p = feedState.rows.find(x => x.kind === 'chat' && x.id === id);
    if (p && p.post) { p.post.likes = d.likes; p.post.liked = d.liked; }
    // 行首计数徽标和弹窗里的碰杯钮都是 [data-like]，一起对齐（数都包在 <b> 里）
    document.querySelectorAll(`.bar-row[data-id="${id}"] [data-like], #chatModalBody [data-like]`).forEach(btn => {
      btn.classList.toggle('is-on', !!d.liked);
      const b = btn.querySelector('b');
      if (b) b.textContent = d.likes;
    });
  } catch (e) { showToast(e.message, undefined, 'err'); }
}

async function sendChatReply(id, input, btn) {
  const text = input.value.trim();
  if (!text) return;
  if (!state.user) { openAuth('login'); return; }
  btn.disabled = true;
  try {
    const r = await fetch(`/api/bar/posts/${encodeURIComponent(id)}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '回应没发出去');
    const row = feedState.rows.find(x => x.kind === 'chat' && x.id === id);
    if (row) row.post = d;
    reRenderFeedRow(id);
    // 弹窗开着的就是这条：刷新回应区，聚焦回输入框接着聊
    if (chatModalId === id) {
      chatModalData = d;
      renderChatPost();
      const inp = $('cpInput');
      if (inp) inp.focus();
    }
  } catch (e) { showToast(e.message, undefined, 'err'); }
  finally { btn.disabled = false; }
}

async function deleteChat(id) {
  if (!confirm('删掉自己说的这句？')) return;
  try {
    const r = await fetch(`/api/bar/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '删除失败');
    feedState.rows = feedState.rows.filter(x => x.id !== id);
    feedState.chatTotal = Math.max(0, feedState.chatTotal - 1);
    if (chatModalId === id) closeChatPost();   // 删的是弹窗里这条：关窗再重画列表
    renderFeed();
    loadBarTags();   // 删掉的那句可能是某个话题里唯一一条，话题栏得跟着退场
  } catch (e) { showToast(e.message, undefined, 'err'); }
}

// ---------- 统一发布入口：一颗加号，四条出路（2026-11-12） ----------
// 头部（PC / 平板）和手机底部 Tab 中间是同一个按钮、同一份 #pubMenu，打开/收起只维护一处状态。
// 四条路都不新开业务：提交作品 = 原来的投稿弹窗；提想法 / 随便聊 = 酒馆那个发布框的两种模式；
// 企业产品入驻 = /ads 的「品牌橱窗」那节（企业交产品故事做一页，不是买横幅）。这里只做入口收口。
// 企业这条按「产品 / 合作」说：菜单上不出现刊例、广告位字样，纯广告招商仍只在页脚「投放合作」和 /ads。
let pubMenuOpen = false;

function setPubMenu(open) {
  const menu = $('pubMenu');
  if (!menu) return;
  const mask = $('pubMask');
  pubMenuOpen = !!open;
  menu.hidden = !pubMenuOpen;
  if (mask) mask.hidden = !pubMenuOpen;
  [$('pubBtn'), $('tabPub')].forEach(b => {
    if (!b) return;
    b.classList.toggle('is-open', pubMenuOpen);
    b.setAttribute('aria-expanded', pubMenuOpen ? 'true' : 'false');
  });
}

// 去酒馆写点什么：已经在酒馆就地切模式（不重载列表、不丢滚动位置），否则跳过去带一个 compose 参数，
// 由 route 里的 /bar 分支落地后切模式 + 聚焦（见 route）。
function goCompose(mode) {
  const m = mode === 'chat' ? 'chat' : 'want';
  if (location.pathname === '/bar') {
    setBarCompose(m);
    focusBarComposer();
  } else {
    navigate('/bar?compose=' + m);
  }
}

// 滚到发布框并把光标放进对应输入框：从菜单点进来的人下一步就是打字，
// 别让他自己再找一次框（手机上发布框排在「热门 / 书架」后面，往往在一屏之外）。
// 必须等第一屏列表回来再滚：数据没到时发布框还挂在页顶，量出来的位置是错的（实测会滚到 0）。
function focusBarComposer() {
  setTimeout(() => {
    const wrap = document.querySelector('.cmp-wrap');
    if (!wrap) return;
    const input = barComposeMode === 'chat' ? $('chatInput') : $('wishInput');
    try { wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { wrap.scrollIntoView(); }
    // 移动端软键盘弹出会抢焦点，等滚动坐稳再 focus；preventScroll 免得把刚滚好的位置又甩走
    if (input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } }, 320);
  }, 380);
}

function setupPublishMenu() {
  const menu = $('pubMenu');
  if (!menu) return;
  const toggle = () => setPubMenu(!pubMenuOpen);
  [$('pubBtn'), $('tabPub')].forEach(b => {
    if (b) b.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  });
  if ($('pubMask')) $('pubMask').addEventListener('click', () => setPubMenu(false));
  // 菜单项点完就收起：投稿那条走它自己原来的 onclick（本监听在冒泡阶段，不拦它）
  menu.addEventListener('click', e => {
    const item = e.target.closest('.pub-item');
    if (!item) return;
    setPubMenu(false);
    const mode = item.dataset.pub;
    if (mode === 'want' || mode === 'chat') { e.preventDefault(); goCompose(mode); }
    // 推荐自己的作品：和头像菜单里的 promoBtn 同一条链路（openRedeem：未登录先弹登录，再进 /promote）
    if (mode === 'promo') { e.preventDefault(); openRedeem(); }
  });
  // 点空白 / 按 Esc 收起。用 closest 判断，点菜单内部不误关
  document.addEventListener('click', e => {
    if (!pubMenuOpen) return;
    if (e.target.closest('#pubMenu') || e.target.closest('#pubBtn') || e.target.closest('#tabPub')) return;
    setPubMenu(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pubMenuOpen) setPubMenu(false); });
  // 视口一变（手机横竖屏、PC 缩放）菜单的定位前提就变了，直接收起最省事
  window.addEventListener('resize', () => { if (pubMenuOpen) setPubMenu(false); });
}

// 统一发布器：一个输入窗口，两种心情。提想法走想法池（可被认领），随便聊进散座。
// 数据仍分表（想法池的「N 人想要」不被闲聊稀释），切换只换表单、不换位置；
// 选过就记住，下次进来还停在那个心情（默认提想法）。
let barComposeMode = 'want';
function setBarCompose(mode) {
  barComposeMode = mode === 'chat' ? 'chat' : 'want';
  const want = document.querySelector('.cmp-want'), chat = document.querySelector('.cmp-chat');
  if (!want || !chat) return;
  want.hidden = barComposeMode !== 'want';
  chat.hidden = barComposeMode !== 'chat';
  document.querySelectorAll('.cmp-tab').forEach(b => {
    const on = b.dataset.mode === barComposeMode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { localStorage.setItem('dm_bar_compose', barComposeMode); } catch { /* 隐私模式 */ }
}

// 「随便聊」输入框的绑定（列表交互都在 wishList 的容器代理里，见 setupWish）
// 关联作品联想：打字查 /api/works?q=，点词条回填 /w/ 链接——服务端解析 workRef
// 链接优先、按名字是精确匹配的兜底，联想选中走链接最稳，不怕重名。
let refSuggestSeq = 0;
let refSuggestTimer = 0;
function refSuggestClose() {
  const p = $('refSuggest');
  if (p) { p.hidden = true; p.innerHTML = ''; }
}
function refSuggestQuery(q) {
  const panel = $('refSuggest');
  if (!panel) return;
  const seq = ++refSuggestSeq;
  fetch('/api/works?q=' + encodeURIComponent(q) + '&pageSize=6', { cache: 'no-store' })
    .then(r => r.json())
    .then(d => {
      if (seq !== refSuggestSeq) return;   // 过期请求：字可能已经改了，别拿旧结果盖新的
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) {
        panel.innerHTML = '<div class="rs-none">没找到叫这个的作品，可以直接粘贴作品页链接</div>';
        panel.hidden = false;
        return;
      }
      panel.innerHTML = items.map(w => {
        const an = (w.anonymous ? '匿名' : (w.authorName || w.author || ''));
        return `<button type="button" class="rs-item" data-wid="${encodeURIComponent(w.id)}"
          data-wtitle="${escapeHtml(w.title || '')}"
          title="选这件关联到帖子上"><b>${escapeHtml(w.title || '')}</b>${an ? `<i>${escapeHtml(an)}</i>` : ''}</button>`;
      }).join('');
      panel.hidden = false;
    })
    .catch(() => { if (seq === refSuggestSeq) refSuggestClose(); });
}

// 关联作品的选中态：输入框收起，换成一行「🔗《作品名》✕」——裸的 /w/xxx 链接留着没人看得懂。
// chatWorkRef 输入框仍是唯一事实源（提交照旧读它），chip 只是外皮。
function chatRefShowChip(title) {
  const ref = $('chatWorkRef'), chip = $('chatRefChip'), name = $('chatRefChipName'), btn = $('chatRefBtn');
  if (!ref || !chip || !name) return;
  name.textContent = title ? `《${title}》` : ref.value;
  chip.hidden = false;
  ref.hidden = true;
  if (btn) btn.hidden = true;
  refSuggestClose();
}
function chatRefReset(collapse) {
  const ref = $('chatWorkRef'), chip = $('chatRefChip'), btn = $('chatRefBtn');
  if (!ref) return;
  ref.value = '';
  ref.hidden = !!collapse;
  if (chip) chip.hidden = true;
  if (btn) btn.hidden = false;
  refSuggestClose();
}
function setupBarComposer() {
  $('chatSend').onclick = () => submitChat();
  $('chatInput').addEventListener('input', updateChatCount);
  $('chatInput').addEventListener('input', updateChatTagHint);
  $('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitChat();
  });
  // 「＋ 话题」：不要求用户先学会语法，插一对 # 光标放中间；选中文字就直接裹上
  if ($('chatTagBtn')) $('chatTagBtn').onclick = insertChatTag;
  // 关联作品：平时收起（foot 上一个「🔗 关联作品」小按钮），点了才展开输入。
  // 打字 280ms 防抖联想；粘了 /w/ 链接就拉作品名，把输入框换成「🔗《作品名》✕」chip。
  const refInput = $('chatWorkRef');
  let refLinkTimer = 0, refLinkId = '';
  if (refInput) {
    refInput.addEventListener('input', () => {
      const q = refInput.value.trim();
      clearTimeout(refSuggestTimer);
      clearTimeout(refLinkTimer);
      const m = q.match(/\/w\/([A-Za-z0-9_-]+)/);
      if (!q) { refSuggestSeq++; refSuggestClose(); return; }
      if (m) {
        // 完整链接已经写明白，不弹联想菜单；静默拉一次作品名换 chip 显示。
        // 同一个 id 只拉一次，拉不到（下架/链接残缺）就留着原样，提交时服务端会给明确报错
        refSuggestSeq++; refSuggestClose();
        if (m[1] !== refLinkId) {
          refLinkTimer = setTimeout(() => {
            fetch('/api/works/' + encodeURIComponent(m[1]) + '?nopv=1', { cache: 'no-store' })
              .then(r => r.json())
              .then(w => { if (!w.error && w.id === m[1]) { refLinkId = m[1]; chatRefShowChip(w.title); } })
              .catch(() => { /* 拉不到就留着链接原样 */ });
          }, 350);
        }
        return;
      }
      refLinkId = '';
      refSuggestTimer = setTimeout(() => refSuggestQuery(q), 280);
    });
    refInput.addEventListener('blur', () => setTimeout(() => {
      refSuggestClose();
      // 展开着却一个字没写就走神了：收回去，别让选填框一直杵在正文下面
      if (refInput && !refInput.value && !refInput.hidden) {
        refInput.hidden = true;
        if ($('chatRefBtn')) $('chatRefBtn').hidden = false;
      }
    }, 180));
    refInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { refSuggestSeq++; refSuggestClose(); }
    });
  }
  // 「🔗 关联作品」：展开输入框（空着失焦会自己收回去，见 blur）
  const refBtn = $('chatRefBtn');
  if (refBtn) refBtn.onclick = () => {
    if (!refInput) return;
    refInput.hidden = false;
    try { refInput.focus({ preventScroll: true }); } catch { refInput.focus(); }
  };
  // chip 上的 ✕：清空关联、收回输入框回到收起态
  const chipDel = $('chatRefChipDel');
  if (chipDel) chipDel.onclick = () => chatRefReset(true);
  // 联想面板用 mousedown 选词：先 preventDefault 留住输入框焦点，blur 不触发，选中不闪
  const rsPanel = $('refSuggest');
  if (rsPanel) rsPanel.addEventListener('mousedown', e => {
    const b = e.target.closest('.rs-item');
    if (!b) return;
    e.preventDefault();
    const ref = $('chatWorkRef');
    if (ref) ref.value = '/w/' + b.dataset.wid;
    chatRefShowChip(b.dataset.wtitle || '');
  });
}

// 楼层深链定位：从「本周热门」闲聊卡或 /bar?p=帖子id 进来时用（2026-11-13 起改为弹窗）。
// 帖子不在时间线里（首屏装不下的老帖子）就向接口点名要这一条、插回时间线，
// 然后直接弹帖子弹窗——深链不能只对前 15 条有效；已删/隐藏的帖子安静失败，不为死链折腾页面。
async function focusChatPost(id) {
  if (!id) return;
  if (!feedState.rows.some(x => x.kind === 'chat' && x.id === id)) {
    try {
      const r = await fetch('/api/bar/posts?id=' + encodeURIComponent(id), { cache: 'no-store' });
      const d = await r.json();
      if (r.ok && Array.isArray(d.items) && d.items[0] && !feedState.rows.some(x => x.id === id)) {
        const post = d.items[0];
        // 深链要的那楼可能比已加载的都老：按时间插回它该在的位置（服务端这条流的排序口径：时间倒序 + id 倒序）
        feedState.rows.push({ kind: 'chat', at: post.createdAt, id: post.id, post });
        feedState.rows.sort((a, b) => (new Date(b.at || 0) - new Date(a.at || 0)) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        renderFeed();
      }
    } catch { /* 拉不到就当没有 */ }
  }
  openChatPost(id);
}

// ---------- 闲聊帖子弹窗（2026-11-13）：正文从「一行截断」的列表里解放出来 ----------
// 列表只留一行摘要（两行截断），全文、全部回应、回应输入框都在弹窗里；分享链接仍指向 ?p=。
let chatModalId = '';
let chatModalData = null;

function chatPostById(id) {
  const hit = feedState.rows.find(x => x.kind === 'chat' && x.id === id);
  return hit && hit.post ? hit.post : null;
}

function chatRepliesHtml(p) {
  const list = (p && p.replies) || [];
  if (!list.length) return '<div class="cp-empty">还没有回应——下面那句可以是你的</div>';
  return list.map(r => `<div class="cc-reply">
      <b>@${escapeHtml(r.author)}</b><span>${escapeHtml(r.text)}</span>
      <small>${escapeHtml(wishWhen(r.at))}</small>
    </div>`).join('');
}

function renderChatPost() {
  const p = chatModalData;
  const box = $('chatModalBody');
  if (!p || !box) return;
  closeEmojiFloat();   // 面板挂在 body 上、绑的是上一份按钮，重画前先收掉
  const id = escapeHtml(p.id);
  const topicStart = p.topicStart != null ? !!p.topicStart : barIsTopicStart(p.text);
  const kind = barChatKindOf(p, topicStart);
  box.innerHTML = `
    <div class="cp-main">
      <p class="cp-text">${barTextHtml(p.text)}</p>
      ${p.work ? `<a class="cp-work" href="/w/${encodeURIComponent(p.work.id)}" title="看这条闲聊关联的作品">${ic('check-circle', 13)} ${escapeHtml(p.work.title)}</a>` : ''}
      <div class="cp-meta">
        <span class="br-kind ${BAR_CHAT_KIND_CLS[kind]}"${BAR_CHAT_KIND_TITLE[kind] ? ` title="${BAR_CHAT_KIND_TITLE[kind]}"` : ''}>${BAR_CHAT_KIND_LABEL[kind]}</span>
        <span class="br-author">@${escapeHtml(p.author)}</span>
        <span>${escapeHtml(wishWhen(p.createdAt))}</span>
      </div>
      <div class="cp-acts">
        <button type="button" class="cc-act${p.liked ? ' is-on' : ''}" data-like="${id}"
          title="碰个杯，表示你有同感">${ic('heart', 13)} 碰杯 <b>${p.likes || 0}</b></button>
        <button type="button" class="cc-act" data-share="${id}"
          title="复制这条帖子的链接，发出去直接打开这条帖子">${ic('link', 13)} 分享</button>
        ${p.mine ? `<button type="button" class="cc-act cc-del" data-del-chat="${id}" title="删掉自己说的这句">删除</button>` : ''}
      </div>
      <div class="cp-replies" id="cpReplies">${chatRepliesHtml(p)}</div>
      <div class="cc-form cp-form">
        <input id="cpInput" maxlength="140" placeholder="接一句……说点有用的，别只发表情" />
        <button type="button" class="cc-emoji" id="cpEmojiBtn" title="插入表情" aria-label="插入表情">😊</button>
        <button type="button" class="cc-send" data-send="${id}">回应</button>
      </div>
    </div>`;
  const inp = $('cpInput');
  if (inp) inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const send = box.querySelector('.cc-send');
      if (send) sendChatReply(id, inp, send);
    }
  });
  // 表情键（2026-11-14）：跟评论框同一排字，选中插到光标处；面板是 body 上的浮层（见 openEmojiFloat）
  const emojiBtn = $('cpEmojiBtn');
  if (emojiBtn && inp) {
    // 按下别抢输入框焦点：手机上焦点一跑，键盘就收了
    emojiBtn.addEventListener('mousedown', e => e.preventDefault());
    emojiBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (emojiFloatEl && emojiFloatEl._anchor === emojiBtn) { closeEmojiFloat(); return; }
      openEmojiFloat(emojiBtn, em => insertAtCaret(inp, em, 140));
    });
  }
}

function openChatPost(id) {
  const p = chatPostById(id);
  if (!p) return;
  chatModalId = id;
  chatModalData = p;
  renderChatPost();
  showModal($('chatModal'));
  syncChatDeepLink(id);
}

function closeChatPost() {
  closeEmojiFloat();
  hideModal($('chatModal'));
  chatModalId = '';
  chatModalData = null;
  syncChatDeepLink('');
}

// 帖子深链的地址栏同步：展开哪楼就把 ?p= 指到哪楼，收起就摘掉。replaceState 不产生历史记录
function syncChatDeepLink(id) {
  try {
    const u = new URL(location.href);
    if (id) u.searchParams.set('p', id); else u.searchParams.delete('p');
    history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : ''));
  } catch { /* 老环境不支持就算了 */ }
}

// 复制某楼的分享链接；clipboard 不可用（http/老浏览器）时退回 execCommand 老法子
async function copyChatLink(id) {
  const url = location.origin + '/bar?p=' + encodeURIComponent(id);
  const okMsg = '链接已复制，发出去就能定位到这一楼';
  try {
    await navigator.clipboard.writeText(url);
    return showToast(okMsg, undefined, 'ok');
  } catch { /* 走兜底 */ }
  const ta = document.createElement('textarea');
  ta.value = url;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 真不行 */ }
  ta.remove();
  showToast(ok ? okMsg : '复制没成功，可以直接从地址栏复制（链接里带 ?p=）', undefined, ok ? 'ok' : 'err');
}

// 页头数字：这里能把想法做成作品，先把结果摆出来，比一句口号有说服力
// 2026-11-12 站长要求先去掉这行数字：index.html 里的 #barStats 容器已撤，
// 这里靠 `!box` 自然短路（不再渲染）。要恢复就把 index.html 那行 div 取消注释，函数不用动。
function renderWishStats(s) {
  const box = $('barStats');
  if (!box || !s) return;
  box.hidden = !s.total;
  if (!s.total) return;
  box.innerHTML = `
    <span class="bs-total"><b>${s.total}</b> 个想法</span>
    <span class="bs-done"><b>${s.done}</b> 个已实现</span>
    <span class="bs-claimed"><b>${s.claimed}</b> 个正在做</span>
    <span class="bs-open"><b>${s.open}</b> 个征集中</span>
    <span class="bs-week">本周新增 <b>${s.weekNew}</b></span>`;
}

// 愿望成真：已经被做成作品的想法，每条都挂作品链接
function renderWishDone(list) {
  const box = $('wishDoneBox');
  if (!box) return;
  const items = Array.isArray(list) ? list : [];
  box.hidden = !items.length;
  if (!items.length) return;
  box.innerHTML = `<div class="wd-head"><h3>愿望成真</h3><span>这些想法真的被做出来了，点开就能用</span></div>
    <div class="wd-list">${items.map(d => `<a class="wd-item" href="/w/${encodeURIComponent(d.work.id)}">
      <span class="wd-check">✓</span>
      <span class="wd-title">${escapeHtml(d.title)}</span>
      <span class="wd-work">${escapeHtml(d.work.title)} →</span>
    </a>`).join('')}</div>`;
}

// 冷启动补位：想法还少的时候，把「搜过但站内没结果」的词摆出来，点一下就能变成想法
function renderWishSuggest() {
  const box = $('wishSuggest');
  if (!box) return;
  const list = $('wishList');
  const count = list ? list.querySelectorAll('.bar-row.is-idea').length : 0;
  const zeros = hotItemsCache.filter(x => x.zero).slice(0, 6);
  if (count > 6 || !zeros.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="ws-head"><h3>有人找过，但站内还没有</h3><span>点一下，把你的想法接上去</span></div>
    <div class="ws-chips">${zeros.map(z => `<button type="button" class="ws-chip" data-sug="${escapeHtml(z.w)}">${escapeHtml(z.w)} <i>＋ 我想要</i></button>`).join('')}</div>`;
}

function openWishExtra(force) {
  const ta = $('wishDetail');
  const btn = $('wishExtraToggle');
  if (!ta || !btn) return;
  const show = force === true || ta.hidden;
  ta.hidden = !show;
  btn.setAttribute('aria-expanded', show ? 'true' : 'false');
  btn.textContent = show ? '− 收起补充说明' : '＋ 补充使用场景（选填，让创作者更懂你）';
  if (show) ta.focus();
}

// 热搜 zero 词 / 引导卡 → 想法输入框：把「没搜到」这个死胡同接回发布框
function fillIdeaFromKeyword(kw) {
  const input = $('wishInput');
  if (!input) return;
  const word = String(kw || '').slice(0, 40);
  input.value = word;
  openWishExtra(true);
  input.focus();
  try { input.setSelectionRange(word.length, word.length); } catch { /* 忽略 */ }
  showToast(`站内还没搜到「${word}」，把想要的东西说具体一点就能发`, 3800);
}

// loadIdeas 已退役：想法列表改走 loadFeed（与闲聊合流归并渲染），动作后的刷新也统一调 loadFeed(true)

async function toggleWishWant(id, btn) {
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(id)}/want`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) return showToast(d.error || '操作失败', undefined, 'err');
    const b = btn.querySelector('b');
    if (b) b.textContent = d.wants;
    btn.classList.toggle('is-on', !!d.wanted);
    if (d.wanted && !state.user) showToast('已记下你想要，登录后这个支持会算在你账号上');
  } catch { showToast('网络不太好，再试一次', undefined, 'err'); }
}

async function claimWish(id) {
  if (!state.user) { openAuth('login'); return; }
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(id)}/claim`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) return showToast(d.error || '认领失败', undefined, 'err');
    showToast('认领成功！做完记得回来点「我来标记已实现」', undefined, 'ok');
    loadFeed(true);
  } catch { showToast('网络不太好，再试一次', undefined, 'err'); }
}

async function deleteWish(id) {
  if (!confirm('删除这个想法？')) return;
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) return showToast(d.error || '删除失败', undefined, 'err');
    loadFeed(true);
  } catch { showToast('网络不太好，再试一次', undefined, 'err'); }
}

function openWishDone(id) {
  ideaDoneId = id;
  $('ideaDoneInput').value = '';
  $('ideaDoneMsg').textContent = '';
  showModal($('ideaDoneModal'));
  setTimeout(() => { try { $('ideaDoneInput').focus(); } catch { /* 忽略 */ } }, 80);
}

async function saveWishDone() {
  const btn = $('ideaDoneSave');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(ideaDoneId)}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workId: $('ideaDoneInput').value.trim() })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '保存失败');
    hideModal($('ideaDoneModal'));
    showToast(d.status === 'done' ? '已标记实现，谢谢你把想法做出来' : '已退回「征集中」', undefined, 'ok');
    loadFeed(true);
  } catch (err) {
    $('ideaDoneMsg').textContent = err.message;
  } finally { btn.disabled = false; }
}

async function submitWish(opts = {}) {
  const input = $('wishInput');
  const title = input.value.trim();
  const detail = $('wishDetail') ? $('wishDetail').value.trim() : '';
  if (title.length < 4) return showToast('想法至少 4 个字，说清楚一点', undefined, 'err');
  if (!state.user) { openAuth('login'); return; }
  const btn = $('wishSubmit');
  btn.disabled = true;
  try {
    const r = await fetch('/api/ideas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, detail, ackSimilar: !!opts.ackSimilar })
    });
    const d = await r.json();
    // 服务端拦下相似想法：先给「去顶一下」的岔路，用户明确选「仍然发布」才带 ack 重发
    if (r.status === 409 && d.code === 'similar') {
      similarIdea = d.idea;
      const tip = $('wishSimilarTip');
      if (tip) tip.textContent = `「${d.idea.title}」已经有 ${d.idea.wants || 0} 人想要了。去顶一下，比再发一条更容易被做出来。`;
      showModal($('wishSimilarModal'));
      return;
    }
    if (!r.ok) throw new Error(d.error || '发布失败');
    input.value = '';
    if ($('wishDetail')) $('wishDetail').value = '';
    showToast('想法已发布，等着有人来接', undefined, 'ok');
    loadFeed(true);
    loadBarBoard(true);   // 近7日口径跟着变（新想法 +1），别让它停在旧数字
  } catch (err) { showToast(err.message, undefined, 'err'); }
  finally { btn.disabled = false; }
}

async function wantSimilarIdea() {
  const i = similarIdea;
  hideModal($('wishSimilarModal'));
  if (!i) return;
  if (i.wanted) {
    showToast('你之前已经点过想要啦，再等等看有没有人来接', undefined, 'ok');
    openIdeaDetail(i.id);
    return;
  }
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(i.id)}/want`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '操作失败');
    showToast('已经帮你顶了一下，这下更容易被创作者看到', undefined, 'ok');
    loadFeed(true);
    openIdeaDetail(i.id);
  } catch (err) { showToast(err.message, undefined, 'err'); }
}

function setupWish() {
  const sec = $('wishView');
  if (!sec || sec._init) return;
  sec._init = 1;
  // 统一发布器的两种心情切换（绑一次）；上次用哪个就停在哪
  $('cmpTabs').addEventListener('click', e => {
    const b = e.target.closest('.cmp-tab');
    if (b) setBarCompose(b.dataset.mode);
  });
  let savedCompose = 'want';
  try { savedCompose = localStorage.getItem('dm_bar_compose') || 'want'; } catch { /* 隐私模式 */ }
  setBarCompose(savedCompose);
  setupBarComposer();
  $('wishSubmit').onclick = () => submitWish();
  $('wishInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitWish(); });
  $('wishDetail').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitWish();
  });
  $('wishExtraToggle').onclick = () => openWishExtra();

  // 大家最近在搜：搜得到的直接去搜；zero 词（站内没结果）不再送人去空搜索页
  loadHotSearch();
  // 话题栏：点标签原地过滤散座；「× 看全部闲聊」回全量
  loadBarTags();
  if ($('barTopics')) {
    $('barTopics').addEventListener('click', e => {
      const t = e.target.closest('.bt-search-toggle');
      if (t) { topicSearchOpen = !topicSearchOpen; if (!topicSearchOpen) topicSearchQ = ''; renderTopicBar(); return; }
      const b = e.target.closest('button[data-tag]');
      if (b) setBarTag(b.dataset.tag);
    });
  }
  // 本周热门里的想法卡片：打开同页抽屉，不跳走；闲聊卡片：直接弹帖子弹窗（全文 + 回应）。
  // 闲聊卡上的关联作品胶囊优先：点它去作品详情，不触发帖子弹窗
  $('bhList').addEventListener('click', e => {
    const wk = e.target.closest('.bh-work');
    if (wk) { openWork(wk.dataset.bwork); return; }
    const idea = e.target.closest('button[data-bidea]');
    if (idea) return openIdeaDetail(idea.dataset.bidea);
    const chat = e.target.closest('button[data-bchat]');
    if (chat) openChatPost(chat.dataset.bchat);
  });
  $('hotList').addEventListener('click', e => {
    const b = e.target.closest('button[data-kw]');
    if (!b) return;
    if (b.dataset.zero === '1') fillIdeaFromKeyword(b.dataset.kw);
    else applySearch(b.dataset.kw);
  });
  const hotShuffleBtn = $('hotShuffle');
  if (hotShuffleBtn) hotShuffleBtn.addEventListener('click', shuffleHotItems);
  const hotToggleBtn = $('hotToggle');
  if (hotToggleBtn) hotToggleBtn.addEventListener('click', toggleHotFold);
  // 断点一变列数就变（5 / 4 / 2 列），收起时露几条要跟着重算，否则 1080→390 会只剩半行
  let hotFoldRaf = 0;
  window.addEventListener('resize', () => {
    if (hotFoldRaf) return;
    hotFoldRaf = requestAnimationFrame(() => { hotFoldRaf = 0; applyHotFold(); });
  });
  $('wishSuggest').addEventListener('click', e => {
    const b = e.target.closest('button[data-sug]');
    if (b) fillIdeaFromKeyword(b.dataset.sug);
  });
  // 合流时间线的容器代理（一次绑定，重渲染不丢）：
  // 想法行 → 详情抽屉；闲聊行 → 弹帖子弹窗（全文 + 碰杯 + 回应都在弹窗里）；动作按钮按 data-* 分发
  $('wishList').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) {
      // 话题标签优先：它是行内的小胶囊，不能连带着把帖子弹窗叫起来
      if (btn.hasAttribute('data-tag')) return setBarTag(btn.dataset.tag);
      if (btn.dataset.open) openIdeaDetail(btn.dataset.open);
      else if (btn.dataset.like) return chatLike(btn.dataset.like);
      else if (btn.dataset.focusReply) return openChatPost(btn.dataset.focusReply);
      else if (btn.dataset.delChat) return deleteChat(btn.dataset.delChat);
      else if (btn.dataset.del) deleteWish(btn.dataset.del);
      return;
    }
    if (e.target.closest('a')) return;   // 「已实现」是作品链接，交给浏览器
    const row = e.target.closest('.bar-row');
    if (!row) return;
    if (row.dataset.type === 'idea') {
      openIdeaDetail(row.dataset.id);
      return;
    }
    // 闲聊行：点一下弹帖子弹窗——正文两行截断，全文和回应去弹窗看
    openChatPost(row.dataset.id);
  });
  $('wishMore').onclick = () => {
    $('wishMore').style.display = 'none';
    loadFeed(false);
  };
  // 闲聊帖子弹窗：关闭走关窗（顺手摘掉 ?p= 深链）；内部动作按 data-* 分发，
  // 话题标签点了先关窗再切话题，别让人被罩在弹窗底下看列表
  $('closeChatModal').onclick = closeChatPost;
  bindMaskClose($('chatModal'), closeChatPost);
  $('chatModalBody').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-tag')) { closeChatPost(); return setBarTag(btn.dataset.tag); }
    if (btn.dataset.like) return chatLike(btn.dataset.like);
    if (btn.dataset.share) return copyChatLink(btn.dataset.share);
    if (btn.dataset.delChat) return deleteChat(btn.dataset.delChat);
    if (btn.dataset.send) {
      const inp = $('cpInput');
      return sendChatReply(btn.dataset.send, inp, btn);
    }
  });
  $('closeIdeaDone').onclick = () => hideModal($('ideaDoneModal'));
  $('ideaDoneCancel').onclick = () => hideModal($('ideaDoneModal'));
  $('ideaDoneSave').onclick = saveWishDone;
  bindMaskClose($('ideaDoneModal'), () => hideModal($('ideaDoneModal')));

  // 相似想法二次确认
  $('closeWishSimilar').onclick = () => hideModal($('wishSimilarModal'));
  $('wishSimilarGo').onclick = wantSimilarIdea;
  $('wishSimilarKeep').onclick = () => {
    hideModal($('wishSimilarModal'));
    submitWish({ ackSimilar: true });
  };
  bindMaskClose($('wishSimilarModal'), () => hideModal($('wishSimilarModal')));

  // 想法详情抽屉
  $('closeIdeaDetail').onclick = closeIdeaDetail;
  bindMaskClose($('ideaDetailModal'), closeIdeaDetail);
  setupIdeaDetail();
}

// ---------- 造梦酒馆：想法详情抽屉 ----------
// 抽屉而不是新页面：想法只有一两句话，弹窗尺寸刚好；不动 /bar 的 SSR，移动端也不跳页。
// 里面只放三种结构化发言，不做自由评论区——需求池要有信息量，不要「+1 蹲一个」。
function ideaTimelineHtml(i) {
  const nodes = [
    { on: true, title: '提出想法', desc: `@${i.author} · ${wishWhen(i.createdAt)}` },
    { on: (i.wants || 0) > 0, title: `${i.wants || 0} 人点了「我也想要」`, desc: '想要的人越多，越容易被创作者看到' }
  ];
  if (i.status === 'done' && i.work) {
    nodes.push({ on: true, title: '已经做出来了', desc: wishWhen(i.updatedAt) });
    nodes.push({ on: true, cls: 'is-done', title: `作品「${i.work.title}」`, desc: '' });
  } else if (i.status === 'claimed' && i.claimer) {
    nodes.push({ on: true, cls: 'is-now', title: `@${i.claimer.name} 认领了，正在做`, desc: wishWhen(i.updatedAt) });
    nodes.push({ on: false, title: '等待作品挂上来', desc: '做完会在这里放作品链接' });
  } else {
    nodes.push({ on: false, title: '还在征集想要的人', desc: '你也可以点「我来实现」' });
  }
  return `<ol class="id-timeline">${nodes.map(n => `<li class="${n.on ? 'is-on' : ''} ${n.cls || ''}">
    <span class="id-tl-dot"></span>
    <div><b>${escapeHtml(n.title)}</b>${n.desc ? `<small>${escapeHtml(n.desc)}</small>` : ''}</div>
  </li>`).join('')}</ol>`;
}

function ideaDetailHtml(i) {
  const acts = [];
  const id = escapeHtml(i.id);
  acts.push(`<button type="button" class="wish-want${i.wanted ? ' is-on' : ''}" data-dwant="${id}"
    title="想要的人越多，越容易被做出来"><span class="ico">${ic('thumb')}</span> 我也想要 <b>${i.wants || 0}</b></button>`);
  if (i.status !== 'done') {
    if (i.claimer && i.claimer.mine) {
      acts.push(`<button type="button" class="wish-claim is-mine" data-ddone="${id}">我来标记已实现</button>`);
    } else if (!i.claimer && !i.mine) {
      acts.push(`<button type="button" class="wish-claim" data-dclaim="${id}">我来实现</button>`);
    }
  }
  return `<div class="id-hero">
    <div class="id-top">${i.category ? `<span class="wish-cat">${escapeHtml(i.category)}</span>` : ''}${wishStatusHtml(i)}</div>
    <h3 class="id-title">${escapeHtml(i.title)}</h3>
    ${i.detail
      ? `<p class="id-detail">${escapeHtml(i.detail)}</p>`
      : '<p class="id-detail is-empty">提出者还没补充使用场景，你可以在下面补一句</p>'}
    <div class="id-meta">@${escapeHtml(i.author)} · ${escapeHtml(wishWhen(i.createdAt))} · ${i.discussionCount || 0} 条讨论</div>
    <div class="id-acts">${acts.join('')}</div>
  </div>
  <section class="id-sec">
    <h4>进展</h4>
    ${ideaTimelineHtml(i)}
  </section>
  <section class="id-sec">
    <h4>一起把这个想法说清楚 <span id="idDiscussCount"></span></h4>
    <p class="id-sec-note">这里只收三种有用的话：补场景、荐方案、报进展。想说「我也想要」，点上面的按钮。</p>
    <div class="id-discuss-list" id="idDiscussList"><div class="id-loading">正在加载讨论…</div></div>
    <div class="id-form">
      <div class="id-kinds" id="idKinds">
        <button type="button" class="id-kind is-on" data-kind="scene">补一句场景</button>
        <button type="button" class="id-kind" data-kind="solution">推荐现成方案</button>
        <button type="button" class="id-kind" data-kind="progress">更新进展</button>
      </div>
      <textarea id="idDiscussText" maxlength="300" rows="3" placeholder="${escapeHtml(IDEA_DISCUSS_PLACEHOLDER.scene)}"></textarea>
      <div class="id-form-foot">
        <span class="id-form-msg" id="idDiscussMsg"></span>
        <button type="button" class="btn-primary" id="idDiscussSubmit">发布</button>
      </div>
    </div>
  </section>`;
}

async function openIdeaDetail(id) {
  const box = $('ideaDetailBody');
  if (!box) return;
  ideaDetailId = id;
  ideaDetailData = null;
  ideaDiscussKind = 'scene';
  box.innerHTML = '<div class="id-loading">正在打开想法…</div>';
  showModal($('ideaDetailModal'));
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error('想法不存在或已下架');
    const i = await r.json();
    if (ideaDetailId !== id) return;   // 期间又点了别的想法
    ideaDetailData = i;
    box.innerHTML = ideaDetailHtml(i);
    syncIdeaKind();
    loadIdeaDiscussions();
  } catch (err) {
    box.innerHTML = `<div class="id-loading">${escapeHtml(err.message)}</div>`;
  }
}

function closeIdeaDetail() {
  hideModal($('ideaDetailModal'));
  ideaDetailId = '';
  ideaDetailData = null;
}

function syncIdeaKind() {
  document.querySelectorAll('#idKinds .id-kind').forEach(b => {
    b.classList.toggle('is-on', b.dataset.kind === ideaDiscussKind);
  });
  const ta = $('idDiscussText');
  if (ta) ta.placeholder = IDEA_DISCUSS_PLACEHOLDER[ideaDiscussKind] || '';
  // 进展更新只有认领者 / 提出者能发，服务端也会再拦一道
  const canProgress = !!(ideaDetailData &&
    (ideaDetailData.mine || (ideaDetailData.claimer && ideaDetailData.claimer.mine)));
  const pb = document.querySelector('#idKinds .id-kind[data-kind="progress"]');
  if (pb) {
    pb.disabled = !canProgress;
    pb.title = canProgress ? '' : '只有认领者或提出者能更新进展';
  }
}

async function loadIdeaDiscussions() {
  const box = $('idDiscussList');
  if (!box || !ideaDetailId) return;
  const id = ideaDetailId;
  box.innerHTML = '<div class="id-loading">正在加载讨论…</div>';
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(id)}/discussions`);
    const d = await r.json();
    if (ideaDetailId !== id) return;
    const items = Array.isArray(d.items) ? d.items : [];
    const c = $('idDiscussCount');
    if (c) c.textContent = items.length ? `${items.length} 条` : '';
    if (!items.length) {
      box.innerHTML = '<div class="id-empty">还没有人补充。你的一句使用场景，可能就是创作者动手的理由。</div>';
      return;
    }
    box.innerHTML = items.map(x => `<div class="id-item">
      <div class="id-item-top">
        <span class="id-kind-tag k-${x.kind}">${IDEA_DISCUSS_KIND_TEXT[x.kind] || '补充场景'}</span>
        <span class="id-item-author">@${escapeHtml(x.author)}${x.isAuthor ? ' · 提出者' : (x.isClaimer ? ' · 认领者' : '')}</span>
        <span class="id-item-when">${escapeHtml(wishWhen(x.createdAt))}</span>
        ${x.mine
          ? `<button type="button" class="id-item-del" data-ddel="${escapeHtml(x.id)}" title="删除">✕</button>`
          : `<button type="button" class="id-item-report" data-dreport="${escapeHtml(x.id)}">举报</button>`}
      </div>
      <p class="id-item-text">${escapeHtml(x.text)}</p>
    </div>`).join('');
  } catch {
    box.innerHTML = '<div class="id-empty">讨论加载失败，稍后再试</div>';
  }
}

async function submitIdeaDiscussion() {
  const ta = $('idDiscussText');
  const msg = $('idDiscussMsg');
  if (!ta || !ideaDetailId) return;
  const text = ta.value.trim();
  if (text.length < 4) { if (msg) msg.textContent = '至少写 4 个字，说清楚一点'; return; }
  if (!state.user) { openAuth('login'); return; }
  const btn = $('idDiscussSubmit');
  btn.disabled = true;
  if (msg) msg.textContent = '';
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(ideaDetailId)}/discussions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: ideaDiscussKind, text })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '发布失败');
    ta.value = '';
    loadIdeaDiscussions();
    loadFeed(true);   // 卡片上的讨论数也要跟着变
    showToast('已发布，谢谢帮这个想法说得更清楚', undefined, 'ok');
  } catch (err) { if (msg) msg.textContent = err.message; }
  finally { btn.disabled = false; }
}

async function deleteIdeaDiscussion(did) {
  if (!confirm('删除这条发言？')) return;
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(ideaDetailId)}/discussions/${encodeURIComponent(did)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '删除失败');
    loadIdeaDiscussions();
    loadFeed(true);
  } catch (err) { showToast(err.message, undefined, 'err'); }
}

function openIdeaReportMenu(btn, did) {
  const item = btn.closest('.id-item');
  if (!item) return;
  const old = item.querySelector('.id-report-menu');
  if (old) { old.remove(); return; }
  document.querySelectorAll('.id-report-menu').forEach(m => m.remove());
  const box = document.createElement('div');
  box.className = 'id-report-menu';
  box.innerHTML = '<span>举报原因：</span>' + ['违法违规', '涉嫌侵权', '内容不当', '垃圾广告', '其他']
    .map(r => `<button type="button" data-reason="${r}">${r}</button>`).join('');
  item.appendChild(box);
  box.addEventListener('click', async e => {
    const b = e.target.closest('button[data-reason]');
    if (!b) return;
    try {
      const r = await fetch(`/api/ideas/${encodeURIComponent(ideaDetailId)}/discussions/${encodeURIComponent(did)}/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: b.dataset.reason })
      });
      const d = await r.json();
      showToast(d.message || d.error || '已提交', undefined, r.ok ? 'ok' : 'err');
      if (r.ok) box.remove();
    } catch { showToast('网络不太好，再试一次', undefined, 'err'); }
  });
}

function setupIdeaDetail() {
  const body = $('ideaDetailBody');
  if (!body || body._init) return;
  body._init = 1;
  body.addEventListener('click', async e => {
    const kindBtn = e.target.closest('.id-kind');
    if (kindBtn && !kindBtn.disabled) {
      ideaDiscussKind = kindBtn.dataset.kind;
      syncIdeaKind();
      return;
    }
    if (e.target.closest('#idDiscussSubmit')) { submitIdeaDiscussion(); return; }
    const want = e.target.closest('[data-dwant]');
    if (want) {
      await toggleWishWant(want.dataset.dwant, want);
      if (ideaDetailId) openIdeaDetail(ideaDetailId);
      return;
    }
    const claim = e.target.closest('[data-dclaim]');
    if (claim) {
      await claimWish(claim.dataset.dclaim);
      if (ideaDetailId) openIdeaDetail(ideaDetailId);
      return;
    }
    const done = e.target.closest('[data-ddone]');
    if (done) { openWishDone(done.dataset.ddone); return; }
    const del = e.target.closest('[data-ddel]');
    if (del) { await deleteIdeaDiscussion(del.dataset.ddel); return; }
    const rep = e.target.closest('[data-dreport]');
    if (rep) { openIdeaReportMenu(rep, rep.dataset.dreport); return; }
  });
}

// ---------- 小程序专栏 ----------
// 为什么单独一页：小程序在浏览器里点不开，普通列表点进去只能看到一张截图。
// 这一页的核心动作是「扫码」，所以有作者原码的作品优先，没码的明说缺什么，别让人以为是坏链。
let miniLoadedAt = 0;

function miniCardHtml(w) {
  const qr = w.qrcode || '';
  const title = escapeHtml(w.title);
  const href = `/w/${encodeURIComponent(w.id)}`;
  return `<article class="mini-card" data-id="${escapeHtml(w.id)}">
    <a class="mini-cover" href="${href}" aria-label="看《${title}》详情">
      ${w.thumb ? `<img src="${escapeHtml(w.thumb)}" alt="" loading="lazy" />` : ''}
    </a>
    <div class="mini-body">
      <a class="mini-name" href="${href}">${title}</a>
      <p class="mini-desc">${escapeHtml(w.introText || '')}</p>
      ${qr ? '' : '<div class="mini-miss">作者还没补小程序码，暂时只能看详情</div>'}
      <div class="mini-row">
        <span class="mini-author">@${escapeHtml(w.authorName || w.author || '')}</span>
        ${qr
          ? `<button type="button" class="mini-qr-btn" data-qr="${escapeHtml(qr)}" data-qr-work="${escapeHtml(w.id)}" data-qr-title="${title}">扫码体验</button>`
          : `<a class="mini-qr-btn is-off" href="${href}">看详情</a>`}
      </div>
    </div>
  </article>`;
}

async function loadMiniColumn() {
  const box = $('miniList');
  if (!box) return;
  // 一分钟内重复进入不重新拉（专栏内容变动很慢）
  if (miniLoadedAt && Date.now() - miniLoadedAt < 60000 && box.dataset.ready) return;
  box.innerHTML = '<div class="mini-loading">正在加载小程序…</div>';
  try {
    const r = await fetch(`/api/works?type=${encodeURIComponent('小程序')}&pageSize=48&sort=hot`);
    const data = await r.json();
    const items = (data.items || []).slice();
    // 置顶优先，其次是有作者小程序码的（能扫码才是这一页的价值），同档保持接口给的热度序
    items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.qrcode ? 1 : 0) - (a.qrcode ? 1 : 0));
    const withQr = items.filter((i) => i.qrcode).length;
    const missing = items.length - withQr;
    if ($('miniStats')) {
      $('miniStats').innerHTML = [
        `<span class="mini-stat"><b>${items.length}</b> 个小程序</span>`,
        `<span class="mini-stat"><b>${withQr}</b> 个能扫码直开</span>`,
        '<span class="mini-stat">持续收录中</span>',
      ].join('');
    }
    if ($('miniBarNote')) {
      $('miniBarNote').textContent = !items.length ? '' : (missing ? `${missing} 个还没补码` : '都能直接扫码打开');
    }
    if (!items.length) {
      box.innerHTML = '<div class="mini-empty">专栏里还没有小程序——第一个把作品放上来吧</div>';
      box.dataset.ready = '1';
      miniLoadedAt = Date.now();
      return;
    }
    box.innerHTML = items.map(miniCardHtml).join('');
    box.querySelectorAll('.mini-qr-btn[data-qr]').forEach((btn) => {
      btn.onclick = () => {
        openQrZoom(btn.dataset.qr, '微信扫一扫，打开「' + btn.dataset.qrTitle + '」');
        trackAction(btn.dataset.qrWork, 'scan_intent', 'mini');
      };
    });
    box.dataset.ready = '1';
    miniLoadedAt = Date.now();
  } catch {
    box.innerHTML = '<div class="mini-empty">加载失败，稍后再试</div>';
  }
}

// 本站小程序自己的码：专栏里第一个真能扫的，先证明这条路走得通
async function loadMiniSelfQr() {
  const box = $('miniSelfQr');
  if (!box || box.dataset.loading) return;
  box.dataset.loading = '1';
  try {
    const r = await fetch('/api/mini/self-qr');
    const d = await r.json();
    if (!r.ok || !d.qr) throw new Error(d.error || 'no qr');
    box.innerHTML = `<img src="${d.qr}" alt="造梦橱窗小程序码" />`;
    const img = box.querySelector('img');
    if (img) img.onclick = () => openQrZoom(d.qr, '微信扫一扫，打开造梦橱窗小程序');
  } catch {
    box.innerHTML = '<span class="mini-qr-loading">码暂时取不到</span>';
    box.dataset.loading = '';
  }
}

function setupMiniColumn() {
  const sec = $('miniView');
  if (!sec || sec._init) return;
  sec._init = 1;
  const submit = $('miniSubmit');
  if (submit) submit.onclick = () => $('openUpload').click();
  loadMiniSelfQr();
}

// ---------- 外宣指南 + 外宣包 ----------
// 平台清单来自服务端 /api/platforms（promo-guide.js 单一数据源），这里只负责渲染和按平台拼投稿文案。
let guideData = null;

// 平台清单只拉一次，指南页和外宣包共用
async function loadPlatforms() {
  if (guideData) return guideData;
  try { guideData = await (await fetch('/api/platforms')).json(); }
  catch { guideData = null; }
  return guideData;
}

async function loadGuide() {
  const list = $('guideList');
  const data = await loadPlatforms();
  if (!data) { list.innerHTML = '<div class="empty">平台清单加载失败，刷新再试</div>'; return; }
  const ps = data.platforms || [];
  list.innerHTML = ps.map((p, i) => `
    <article class="guide-card">
      <div class="guide-card-head">
        <span class="guide-no">${i + 1}</span>
        <div class="guide-title-wrap">
          <h3>${platIco(p)} ${escapeHtml(p.name)}</h3>
          <span class="guide-region">${escapeHtml(p.region || '')}</span>
        </div>
        <a class="guide-go" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">去投稿 <span class="ico b-ico">${ic('arrowout')}</span></a>
      </div>
      <p class="guide-fits"><b>适合形态：</b>${p.openSourceOnly ? '开源项目（需填源码仓库）' : (p.types && p.types.length ? escapeHtml(p.types.join(' / ')) : '不限形态')}</p>
      <p class="guide-fits"><b>适合投：</b>${escapeHtml(p.fits || '')}</p>
      <p class="guide-tip">${escapeHtml(p.tip || '')}</p>
      <div class="guide-tags">${(p.tags || []).map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
    </article>`).join('');
  $('guideNote').textContent = guideData.extra || '';
}

// 作品简介转成可读的段落：保留原断句。
// 以前用 .replace(/\s+/g,' ') 把换行压成空格，会把「…在播放器中跟随观看⏎导入视频」粘成一句，
// 投稿出去就是一段没有标点的长句，V2EX / HN 上很吃亏。
function sentencesOf(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map(x => x.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .map(x => (/[。！？!?；;…”』】]$/.test(x) ? x : x + '。'))
    .join('');
}

// 作品 → 投稿文案
function promoBase(w) {
  const types = (w.types && w.types.length ? w.types : [w.type]).filter(Boolean).join(' / ') || '作品';
  const one = sentencesOf(w.introText || (window.MiniMd ? MiniMd.plain(w.intro || '') : (w.intro || '')));
  const page = location.origin + '/w/' + w.id;
  const links = w.links || {};
  const firstLink = w.site || Object.values(links).filter(Boolean)[0] || w.link || page;
  return {
    name: w.title,
    types,
    one: one || '（详情页里还没有简介，建议先补一句）',
    short: (one.split('。')[0] || w.title).slice(0, 40) || w.title,
    cat: w.category || '',
    page,
    link: firstLink,
    sameLink: firstLink === page,   // 没有独立官网时两者会重合，文案里就不重复贴同一个地址
    repo: w.repo || ''
  };
}

// 每个平台一种排版；key 与 promo-guide.js 保持一致，缺 key 时用通用模板兜底
const PROMO_TPL = {
  producthunt: b => `【Product Hunt 投放素材】

Tagline（60 字符内，英文最好）
${b.name} – ${b.short}

一句话介绍
${b.name} 是一个${b.cat}类的${b.types}。${b.one}

First comment（发布后自己回第一条，别浪费）
Hi hunters! I built ${b.name} because …
· 解决什么问题：
· 和同类比不一样在哪：
· 价格 / 是否免费：

链接：${b.link}
详情页（截图可直接从这里取）：${b.page}

封面建议 1270×760，再附 3 张真实截图或 1 段 GIF。`,

  hn: b => `【Hacker News · Show HN】

Title（固定格式，一句话说清它是什么）
Show HN: ${b.name} – <one-line English pitch>

正文（英文短句即可，别用营销词）
${b.one}

What it does: <两三句，具体到能做什么>
How it's built: <技术栈一句话，HN 很吃这个>
Link: ${b.link}${b.repo ? `\nSource: ${b.repo}` : ''}

提醒：被质疑时在评论区老实回答技术细节，比帖子本身更能拉分。`,

  v2ex: b => `【V2EX · 分享创造】

节点：分享创造
标题：${b.name} —— ${b.short}

正文：
（第一段写痛点，别用「大家好我做了个 X」开头 —— V2EX 对自我推广很敏感，开场就推销容易被踩）
一直想解决的事：（写一个你自己真实遇到的具体场景，越具体越好，比如「每周要整理 3 小时录音」）

所以我做了 ${b.name}，一个${b.cat}类的${b.types}。

${b.one}

现在能做什么（说人话，别只罗列功能名）：
· 
· 

地址：${b.link}
${b.repo ? `源码：${b.repo}\n` : ''}${b.sameLink ? '' : `站内详情：${b.page}\n`}欢迎拍砖，问题我在评论区回。`,

  juejin: b => `【掘金 · Vibe Work 文章大纲】

标题建议：${b.name}：<一句话说清做了个什么>（${b.types}）

开头：
${b.one}

正文结构：
一、为什么做：写一句你遇到的具体问题
二、怎么做的：技术栈 + 关键实现思路（掘金吃干货，这段越具体越容易被推荐）
三、踩过的坑：列 1~3 个真实坑和解法
四、现在能干什么：配 2~3 张截图或 GIF

结尾：
在线体验：${b.link}
${b.repo ? `源码开源：${b.repo}\n` : ''}${b.sameLink ? '' : `详细介绍：${b.page}\n`}评论区有人问就认真答，互动决定推荐量。`,

  sspai: b => `【少数派投稿大纲】

标题建议：${b.name}：<一句话说出它帮你省掉了什么麻烦>

一、我原来被这件事怎么折磨（真实场景）
二、它现在能做什么（配 3~5 张真实使用截图）
三、我平时怎么用它（写一个具体场景，比如周一早上整理素材）
四、不适合谁（诚实写边界，编辑很看重这个）

开头段落可以直接用：
${b.one}

素材：${b.page}（截图、GIF 都在详情页里）`,

  appinn: b => `【小众软件自荐】

主题：自荐一个小工具：${b.name}（${b.types}）

你好，我是 ${b.name} 的作者。

一句话：${b.one}

· 平台：${b.types}
· 价格：<免费 / 付费，写清楚>
· 地址：${b.link}
· 截图：<附 2~3 张>

简短就好，别写成长篇软文。`,

  coolapk: b => `【酷安发布素材】

应用名：${b.name}
一句话简介（30 字内）：${b.short}

详细介绍：
${b.one}

· 主要功能：
· 权限说明：<为什么需要这些权限，酷安用户很在意>
· 隐私政策：<链接>

首次版本更新说明：
1. 首个版本上线

下载 / 地址：${b.link}`,

  jike: b => `【即刻文案】

${b.name}，${b.short}

${b.one}

做了 X 天，踩到的坑：
· 
· 

链接放评论区，主楼先讲故事。

#独立开发 #产品 #${b.cat}`,

  hellogithub: b => `【HelloGitHub 自荐 issue】

标题：[自荐] ${b.name} - ${b.short}

正文：
· 项目地址：${b.repo || b.link}
· 一句话介绍：${b.one}
· 适用人群：
· 亮点（3 条）：
  1. 
  2. 
· 是否有中文文档：是 / 否
· 截图：<附 1~2 张>

README 记得补一句话简介 + 截图 + 快速上手命令，这是被收录的硬门槛。`
};

const PROMO_GENERIC = b => `【通用投稿文案】

标题：${b.name} —— ${b.short}

${b.one}

· 形态：${b.types}
· 分类：${b.cat}
· 地址：${b.link}
${b.repo ? `· 源码：${b.repo}\n` : ''}· 详情：${b.page}`;

let pkState = { work: null, key: '', touched: false };

// 平台与作品是否匹配：types 缺省 = 不限形态；openSourceOnly = 只对开源（填了仓库）有意义
function platformFits(p, w) {
  if (!p) return true;
  if (p.openSourceOnly) return Boolean(w.repo || w.openSource === true);
  if (!p.types || !p.types.length) return true;
  return typesOf(w).some(t => p.types.indexOf(t) !== -1);
}

function openPromoKit(w) {
  if (!w) return;
  pkState.work = w;
  pkState.touched = false;
  const ps = (guideData && guideData.platforms) || [];
  pkState.key = (ps.find(p => platformFits(p, w)) || ps[0] || {}).key || 'generic';
  showModal($('promoKitModal'));
  renderPromoKit();
  // 平台清单还没拉到：弹窗先出来，拉完再补上标签和对应模板（用户没手动选过才自动切到第一个合适的）
  if (!guideData) loadPlatforms().then(() => {
    const list = (guideData && guideData.platforms) || [];
    if (!pkState.touched && list.length) pkState.key = (list.find(p => platformFits(p, w)) || list[0]).key;
    renderPromoKit();
  });
}

// 平台图标：优先用站点本地的 favicon 图，没有就退回 emoji
function platIco(p, cls) {
  return p.icon
    ? `<img class="${cls || 'pk-ico'}" src="${escapeHtml(p.icon)}" alt="" loading="lazy">`
    : `<span class="pk-emoji"><span class="ico">${ic('globe')}</span></span>`;
}

// 站长建议：按作品形态给一条投放优先级（外宣包弹窗顶部，告诉作者先去哪、后去哪）
function promoAdviceOf(w) {
  const types = typesOf(w);
  const has = t => types.indexOf(t) !== -1;
  const tips = [];
  if (has('Web')) tips.push('Web 作品先投 V2EX「分享创造」听真实反馈，备好英文素材后再冲 Product Hunt 抢海外第一波');
  if (has('小程序')) tips.push('小程序扫码即用，优先发即刻和掘金——读者手边就是微信，看到就能试');
  if (w.repo || w.openSource === true) tips.push('开源项目记得跑一遍 HelloGitHub 和 Hacker News——这两处吃 star 和技术讨论，长尾流量最久');
  if (has('iOS') || has('macOS')) tips.push('苹果端投少数派和 Product Hunt——少数派吃体验长文，过稿后有长期搜索流量');
  if (has('Android')) tips.push('安卓版记得投酷安——用户年轻爱尝鲜，真机截图和更新日志写细一点');
  if (has('Windows') || has('Linux')) tips.push('桌面端先自荐小众软件——一封邮件讲清「解决什么、支持哪些平台、是否免费」');
  if (!tips.length) tips.push('先去掘金发一篇「我做了个 XX」讲讲实现思路，拿反馈打磨文案，再去其他平台');
  return tips.slice(0, 3);
}

function renderPromoKit() {
  const w = pkState.work;
  if (!w) return;
  const ps = (guideData && guideData.platforms) || [];
  // 适合的平台排前面，不适合的置灰排后面（不隐藏，供参考；悬停有说明）
  const tabHtml = (p, dim) =>
    `<button type="button" class="pk-tab${p.key === pkState.key ? ' active' : ''}${dim ? ' dim' : ''}" data-key="${escapeHtml(p.key)}"${dim ? ` title="按作品形态看，这个平台不太适合投：${escapeHtml(p.fits || '')}。仍可选用，仅供参考。"` : ''}>
       <span>${platIco(p)}</span>${escapeHtml(p.name.split(' · ')[0])}${dim ? '<i class="pk-dim-mark">?</i>' : ''}
     </button>`;
  const ok = ps.filter(p => platformFits(p, w));
  const notOk = ps.filter(p => !platformFits(p, w));
  $('pkTabs').innerHTML = ok.map(p => tabHtml(p, false)).join('') + notOk.map(p => tabHtml(p, true)).join('');
  const p = ps.find(x => x.key === pkState.key);
  const base = promoBase(w);
  // 文案里的本站链接带 ?fr=<平台>&ref=<作者>：访客从该平台进来时能认出渠道，也能把注册归给作者
  const authorRef = w.author || '';
  const b = { ...base, page: promoUrl(base.page, pkState.key, authorRef), link: promoUrl(base.link, pkState.key, authorRef) };
  const tpl = PROMO_TPL[pkState.key];
  $('pkCopy').textContent = (tpl || PROMO_GENERIC)(b);
  const fitted = platformFits(p, w);
  $('pkMeta').innerHTML = p
    ? (fitted
        ? `${escapeHtml(p.region || '')} · 适合投：${escapeHtml((p.fits || '').slice(0, 60))}`
        : `<span class="pk-warn"><span class="ico">${ic('warn')}</span> 按作品形态（${escapeHtml(typesOf(w).join(' / '))}）看，${escapeHtml(p.name)} 可能不是好的投放渠道，仅供参考</span>`)
    : '通用模板';
  const advEl = $('pkAdvice');
  const advice = promoAdviceOf(w);
  if (advice.length) {
    advEl.style.display = '';
    advEl.innerHTML = `<span class="pk-advice-title"><span class="ico">${ic('sparkle')}</span> 站长建议先投这些</span><ul>${advice.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
  } else { advEl.style.display = 'none'; advEl.innerHTML = ''; }
  const go = $('pkGo');
  if (p) { go.href = p.url; go.style.display = ''; go.innerHTML = `去 ${escapeHtml(p.name.split(' · ')[0])} 投稿 <span class="ico b-ico">${ic('arrowout')}</span>`; }
  else { go.style.display = 'none'; }
}

async function copyPromoText() {
  const text = $('pkCopy').textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('文案已复制，去对应平台粘贴即可', undefined, 'ok');
  } catch {
    // 老浏览器 / 非 https 的兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('文案已复制', undefined, 'ok'); }
    catch { showToast('复制失败，手动选中复制一下', undefined, 'err'); }
    ta.remove();
  }
}

let pkBound = false;
function setupPromoKit() {
  if (pkBound) return;
  pkBound = true;
  $('closePromoKit').onclick = () => hideModal($('promoKitModal'));
  bindMaskClose($('promoKitModal'), () => hideModal($('promoKitModal')));
  $('pkCopyBtn').onclick = copyPromoText;
  $('pkTabs').addEventListener('click', e => {
    const b = e.target.closest('.pk-tab');
    if (!b) return;
    pkState.key = b.dataset.key;
    pkState.touched = true;
    renderPromoKit();
  });
}
// 规则：用分享积分买「被看到」的次数，每真实曝光一次扣 1 次，投完自动下线；
// 内容只能取自自己名下、已过审的作品，不能自定义文案或挂站外链接。
const REDEEM_STATUS = {
  active: { text: '投放中', cls: 'on' },
  queued: { text: '排队中', cls: 'queue' },
  used_up: { text: '曝光已投完', cls: 'done' },
  expired: { text: '已到期', cls: 'done' },
  cancelled: { text: '已撤下', cls: 'done' },
  removed: { text: '后台下架', cls: 'done' }
};
// mode 是第 3 步「选套餐」的结果，也是整个面板唯一的计费模式开关：
//   view  = 曝光包（按被看到扣，点击不计费、去向固定站内详情页）
//   click = 点击包（按被点开扣，去向可在第 4 步选站内 / 外链）
// 后面所有互斥都由「步骤顺序 + normalizeRedeemSel() 单点归一化」保证，事件处理只改自己那一个字段。
let redeemSel = { workId: '', mode: 'view', views: 0, clicks: 0, slot: 'detail', ext: false, link: '', days: 0 };
let redeemData = null;
// 投放效果榜数据：loadRedeemPanel 并行拉好存这里，renderRedeem 每次重绘都带上（选择操作会整版重绘）
let promoBoardData = null;
// 「为什么这个推荐位值」折叠卡的展开状态：切作品/位置/套餐都会整版重绘，别让人展开一次就被打回
let redeemValueOpen = false;

function redeemMode() { return redeemSel.mode === 'click' ? 'click' : 'view'; }

// 当前选中作品在推荐面板里的信息（works[].site = 投稿时登记的官网/下载链接）
function curRedeemWork() {
  const works = (redeemData && Array.isArray(redeemData.works)) ? redeemData.works : [];
  return works.find(w => w.id === redeemSel.workId) || null;
}

// 当前作品可跳的外链候选（带形态标签）：官网在最前，其后各形态各自的下载/安装链接。
// 服务端 redeemPayload 的 works[].links 就是这份清单（workLinkEntriesOf），老缓存没有时退回单个 site
function curRedeemLinks() {
  const w = curRedeemWork();
  if (!w) return [];
  const list = Array.isArray(w.links) && w.links.length ? w.links : (w.site ? [{ t: '', url: w.site }] : []);
  return list.filter(e => e && e.url);
}

// 外链候选 pill 上显示的短地址：只取域名（去掉 www.），完整地址在下面的 rt-link 里原样展示
function linkHostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u || '').slice(0, 40); }
}

// 点击单价：去向选「官网/下载链接」用外链价（站内 ×2），否则站内价。
// 只有点击包才存在点击单价；曝光包归一化后 clicks=0，这里也不会把外链价带进合计。
function effClickUnit() {
  const cfg = curSlotCfg();
  const ext = redeemMode() === 'click' && redeemSel.ext;
  return ext ? (cfg.extClickPoints || (cfg.clickPoints || 2) * 2) : (cfg.clickPoints || 2);
}

// 当前选中的位置配置（单价 / 档位 / 是否独占，都跟着位置走）
function curSlotCfg() {
  const slots = (redeemData && redeemData.slots) || [];
  return slots.find(s => s.key === redeemSel.slot) || slots[0] || {
    key: 'detail', showViews: 1, showPoints: 1, clickPoints: 30, extClickPoints: 60,
    showPacks: [50, 100, 200], clickPacks: [10, 20, 50], exclusive: false
  };
}

function redeemDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 作品发布多久了（小时）：拿不到发布时间返回 null，宁可不出提醒，也不拿坏数据误伤正常下单
function workAgeHours(w) {
  const t = w && w.createdAt ? new Date(w.createdAt).getTime() : 0;
  if (!t || isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 3600e3);
}
// 「刚发布就买首页第一格」的提醒：首页默认按最新排，这件作品本来就占着置顶之后的第一张卡，
// 这时买第一格多出来的主要是「推荐」角标，不是位置。多少小时内算刚发布由服务端 slots[].freshHours 给，
// 前端不写死数字——以后要调松紧只改 server.js 一处。
function freshWarnOf(cfg, w) {
  const fh = (cfg && cfg.freshHours) || 0;
  const age = workAgeHours(w);
  if (!fh || age === null || age >= fh) return null;
  return { freshHours: fh, ageHours: age, leftHours: Math.max(1, Math.ceil(fh - age)) };
}

// ---------- 按作品形态给「投放途径」建议 ----------
// 一个位置投的是「哪个端的人」：网页端的位给电脑/手机浏览器访客，小程序端的位给微信里的真机用户。
// 手机上的产品（Android / iOS / 小程序）投到小程序端，点开就是能用的东西；投到网页端，
// 一半以上的访客在电脑前，点进来装不上也没有小程序码可扫，同样的灯火买到的人更少。
// 反过来 Web / 桌面产品投网页端更顺——两端都只是「建议」，不锁死：面板里所有位置照常可点、可买。
const MOBILE_FORM_RE = /小程序|android|安卓|ios|iphone|ipad|^app$|\bapp\b|移动端|手机/i;
const DESKTOP_FORM_RE = /web|网页|网站|macos|windows|linux|桌面|浏览器插件|浏览器扩展|api|机器人|智能体/i;
// 形态 → 客群在哪一端：{ family: 'mini'|'web'|'both', types: [...] }，没形态或不认识返回 null（不出建议）
function workFormFit(w) {
  const types = (w && (Array.isArray(w.types) && w.types.length ? w.types : (w.type ? [w.type] : []))) || [];
  const list = types.map(t => String(t || '').trim()).filter(Boolean);
  if (!list.length) return null;
  const mobile = list.filter(t => MOBILE_FORM_RE.test(t));
  const desktop = list.filter(t => DESKTOP_FORM_RE.test(t));
  if (!mobile.length && !desktop.length) return null;
  const family = mobile.length && desktop.length ? 'both' : (mobile.length ? 'mini' : 'web');
  return { family, types: list };
}
// 位置分组的标题（顺着「端」讲，而不是「网页页 / 小程序」这种产品内部叫法）
const SLOT_GROUPS = {
  web: { title: '网页端位置', hint: '电脑浏览器打开的人（手机浏览器也算网页）' },
  mini: { title: '手机端位置 · 小程序', hint: '访客都在手机上：小程序作品扫一扫直达，App 作品复制下载链接到手机浏览器就能装' }
};
function platOfSlot(s) { return s && s.platform === 'mini' ? 'mini' : 'web'; }
// 建议条：把「为什么这一端更值」讲清楚，同时明说另一端也能投
function promoAdviceOf(w) {
  const fit = workFormFit(w);
  if (!fit) return '';
  const label = escapeHtml(fit.types.join(' / '));
  if (fit.family === 'mini') {
    return `<b>${label}</b> 是手机上用的产品：看的人基本都在手机里。<b>建议优先投手机端（小程序）的位置</b>——访客点开就是作品详情页：小程序扫一扫直达，App 复制下载链接到手机浏览器就能装。
      网页端的位置也能投，只是那里电脑访客更多，手机产品投过去，点进来的人多半用不上。`;
  }
  if (fit.family === 'web') {
    return `<b>${label}</b> 主要在电脑上用：<b>建议优先投网页端的位置</b>，那里是它真正的使用场景。
      手机端的位置也能投，只是小程序里的访客多数是随手刷，落到桌面产品上容易看一眼就走。`;
  }
  return `<b>${label}</b> 手机、电脑都能用：<b>两端都可以投</b>——想让手机用户直接打开就先投小程序端，想覆盖电脑访客就投网页端。`;
}

// 单价文案：现在口径是「1 盏 = 1 次曝光」（showViews=1），直接写「X 盏/次」；
// 老配置「每 N 次 X 盏」也能照常显示，不用改一行渲染代码。
function unitPriceText(sp, sv) {
  const n = sv || 1;
  return n === 1 ? `${sp} 盏/次` : `${sp} 盏 / ${n} 次`;
}

// 唯一的归一化入口：把「步骤顺序」翻译成状态约束，事件处理只改自己那一个字段、不再各自兜底。
//   1 作品 / 2 位置先合法化 → 3 计费模式决定显示哪组档位 → 4 去向只在点击包下能选外链。
function normalizeRedeemSel() {
  const slots = (redeemData && Array.isArray(redeemData.slots)) ? redeemData.slots : [];
  const works = (redeemData && Array.isArray(redeemData.works)) ? redeemData.works : [];
  if (!slots.some(s => s.key === redeemSel.slot)) redeemSel.slot = slots[0] ? slots[0].key : 'detail';
  if (!works.some(w => w.id === redeemSel.workId)) redeemSel.workId = works.length ? works[0].id : '';
  const cfg = curSlotCfg();
  const showPacks = cfg.showPacks || [];
  const clickPacks = (cfg.clickPacks || []).filter(v => v > 0);
  const links = curRedeemLinks();
  const mode = redeemMode();
  redeemSel.mode = mode;
  if (mode === 'view') {
    // 曝光包：点击不计费，去向固定站内详情页，外链一律关掉
    redeemSel.ext = false;
    redeemSel.link = '';
    redeemSel.clicks = 0;
    // 次数不锁档位：1..showMax 之间任意整数都行（预设档只是快捷键）；越界 / 非法回落到第一个预设档
    const showMax = cfg.showMax || Math.max(0, ...showPacks);
    const v = Math.round(Number(redeemSel.views));
    redeemSel.views = Number.isFinite(v) && v >= 1 && v <= showMax ? v : (showPacks[0] || 0);
  } else {
    redeemSel.views = 0;
    const clickMax = cfg.clickMax || Math.max(0, ...clickPacks);
    const c = Math.round(Number(redeemSel.clicks));
    redeemSel.clicks = Number.isFinite(c) && c >= 1 && c <= clickMax ? c : (clickPacks[0] || 0);
    // 外链要「点击包 + 非小程序位 + 作品登记了地址」三样齐了才成立
    if (redeemSel.ext && (cfg.internalOnly || !links.length)) redeemSel.ext = false;
    if (!redeemSel.ext) redeemSel.link = '';
    else if (!links.some(e => e.url === redeemSel.link)) redeemSel.link = links[0].url;
  }
  // 第 5 步（只有两个「首页第一格」独占位才有）：投放期限 1..maxDays，默认给满额。
  // 天数不改价格，只决定这单最多挂多久；不是自选位就固定兜底天数，字段照旧带上（服务端也按位置兜底）。
  const maxDays = cfg.maxDays || 7;
  if (cfg.daysPick) {
    const d = Math.round(Number(redeemSel.days));
    redeemSel.days = Number.isFinite(d) && d > 0 ? Math.min(maxDays, Math.max(1, d)) : maxDays;
  } else {
    redeemSel.days = maxDays;
  }
  return cfg;
}

// 总价 = 第 3 步选中的那个档位的价格（按第 2 步位置的单价算，曝光 / 点击二选一）
function redeemTotal() {
  if (!redeemData) return { price: 0, views: 0, clicks: 0, showPrice: 0, clickPrice: 0 };
  const cfg = curSlotCfg();
  const mode = redeemMode();
  const views = mode === 'view' ? (redeemSel.views || (cfg.showPacks || [])[0] || 0) : 0;
  const clicks = mode === 'click' ? (redeemSel.clicks || (cfg.clickPacks || []).filter(v => v > 0)[0] || 0) : 0;
  const sv = cfg.showViews || 1, sp = cfg.showPoints || 1;
  const showPrice = Math.round(views / sv * sp);
  const clickPrice = clicks * effClickUnit();
  return { price: showPrice + clickPrice, views, clicks, showPrice, clickPrice };
}

// 撤下能退回多少：与服务端 refundRedemption 同一口径（剩余次数 × 下单时锁住的单价，
// 新订单单价是整盏/次，退多少一分不差；老订单 0.2 / 0.5 盏/次靠 Math.round 兜底取整）。
// 排队中没开投的单子全额退。单价用的是下单时锁住的价格，后来调价不影响已付的订单。
function redeemRefundOf(r) {
  if (!r) return 0;
  const sv = r.showViews || 1, sp = r.showPoints || 1, cp = r.clickPoints || 2;
  const left = Math.max(0, r.left || 0);
  const leftClicks = Math.max(0, r.clickLeft || 0);
  const back = Math.round(left / sv * sp) + leftClicks * cp;
  return Math.min(back, r.price || 0);
}

// 底部「合计 + 购买按钮」单独成函数，方便局部刷新
function redeemFootHtml() {
  const d = redeemData;
  const cfg = curSlotCfg();
  const works = (d && Array.isArray(d.works)) ? d.works : [];
  const mine = (d && Array.isArray(d.mine)) ? d.mine : [];
  const { price, views, clicks, showPrice, clickPrice } = redeemTotal();
  const enough = ((d && d.points) || 0) >= price;
  const noWork = !works.length;
  const myQueuedHere = mine.some(r => r.slot === cfg.key && r.status === 'queued');
  const myActiveHere = mine.some(r => r.slot === cfg.key && r.status === 'active');
  const blocked = cfg.exclusive && (myQueuedHere || myActiveHere);
  const occupied = !!cfg.exclusive && !!cfg.occupied && !cfg.occupiedMine;
  // 审核期的位置：按钮照常可点（点了给一句人话），但不置灰、不下单
  const soon = cfg.onSale === false;
  return `
      <div class="redeem-total">
        <span>合计</span><b>${price}</b><i>灯火</i>
        <em>可用 ${d.points || 0} 盏 · ${clicks > 0 ? `${redeemSel.ext ? '外链点击' : '点击'} ${clickPrice} 灯火 · ${clicks} 次点击` : `曝光 ${showPrice} 灯火 · ${views} 次曝光`}${cfg.daysPick ? ` · 投 ${redeemSel.days} 天` : ''}</em>
      </div>
      <button type="button" class="btn-primary${soon ? ' is-soon' : ''}" id="redeemGo"${noWork || (!soon && (!enough || blocked)) ? ' disabled' : ''}>
        ${soon ? '小程序内测中 · 暂未开放'
          : noWork ? '先提交作品'
          : blocked ? '该位置你已在投 / 排队'
          : !enough ? `还差 ${price - ((d && d.points) || 0)} 灯火`
          : occupied ? `排队预约 · 花 ${price} 灯火` : `花 ${price} 灯火上推荐`}
      </button>`;
}

// 推荐面板入口：各处按钮统一跳独立页面 /promote（没登录先弹登录）
function openRedeem() {
  if (!state.user) { openAuth('login'); return; }
  navigate('/promote');
}

// /promote 页面的内容加载：拉兑换位、作品、我的投放，再整版渲染。
// 投放效果榜并行拉：登没登录都展示——激励正是要给还没投过的人看
async function loadRedeemPanel() {
  const body = $('redeemBody');
  if (!body) return;
  const boardP = fetch('/api/promo/board?days=30', { cache: 'no-store' })
    .then(r => r.json())
    .then(b => { promoBoardData = b; return b; })
    .catch(() => { promoBoardData = null; return null; });
  if (!state.user) {
    const board = await boardP;
    body.innerHTML = `
      <div class="redeem-hero" style="display:block">
        <p class="rh-tip" style="min-width:0">登录后才能投放：选一件自己的作品，用灯火换首页第一格、榜单、发现页这些位置上的曝光。<br />还没灯火？<b>注册送 100 盏</b>，签到、分享和开源作品的 star 也能攒。</p>
        <div class="rh-links" style="text-align:left"><button type="button" class="btn-primary" id="promoteLoginBtn">先登录</button></div>
      </div>` + promoBoardHtml(board);
    const lb = $('promoteLoginBtn');
    if (lb) lb.onclick = () => openAuth('login');
    bindPromoBoard(body, 'login');
    return;
  }
  body.innerHTML = '<div class="stats-loading">加载中…</div>';
  try {
    // 榜单和面板一起等齐再渲染：renderRedeem 重绘频繁，榜单数据没到手就画会漏掉，等下次重绘才能补上
    const [res] = await Promise.all([fetch('/api/redeem/options', { cache: 'no-store' }), boardP]);
    redeemData = await res.json();
  } catch {
    body.innerHTML = '<div class="stats-loading">加载失败，请稍后重试</div>';
    return;
  }
  renderRedeem();
}

// 投放效果榜（/promote 页首）：近 30 天用灯火投放的作品，曝光 / 点击 / 点击率各排前 5。
// 数据来自 /api/promo/board（后台 redeem-overview 同一本账）；三张榜都没数据就不渲染，不占地方。
// 2026-11-13：加了「点击率」榜——前两张榜比的都是量（谁买得多），只有点击率这栏小预算也能上，
// 衡量的是封面标题吸不吸引人。三栏并排会把每行压到读不出作者名（手机更糟），所以改成 tab 切着看。
// 数字口径（2026-11-14 改）：曝光与点击率都走「人次 PV」，跟后台「投放单」页同一本账——
// 两边各显示一个同名指标却差一倍，是站长最容易当成 bug 报上来的事。扣费口径（计费曝光）
// 只在样本门槛和「怎么选」的换算里用，不对外露。详见服务端 promoBoardOf。
function promoBoardHtml(b) {
  if (!b) return '';
  const lists = { shows: b.shows, clicks: b.clicks, ctrs: b.ctrs };
  const countOf = k => (Array.isArray(lists[k]) ? lists[k].length : 0);
  // 总账条（2026-11-14）：近 N 天全部投放的曝光 / 点击 / 点击率——后台同款数据摆到明面上，
  // 数字本身就是最有说服力的推广文案。pv 为 0 说明窗口内一次投放都没跑，不渲染免得摆零。
  const t = b.totals && b.totals.pv > 0 ? b.totals : null;
  if (!countOf('shows') && !countOf('clicks') && !countOf('ctrs') && !t) return '';
  const days = b.days || 7;
  const minBill = b.minBill || 30;
  const fmt = n => (n || 0).toLocaleString('en-US');
  // 总账条：曝光 / 点击 / 点击率 / 触达人数各一格，手机上两行换行排。
  // 点击率的分母就是同一行的曝光数，口径跟「怎么选」的打平点一致（都换算到人次尺子）。
  const totalsHtml = t ? `
      <div class="pb-totals">
        <span class="pb-tot"><i>${fmt(t.pv)}</i><small>次曝光</small></span>
        <span class="pb-tot"><i>${fmt(t.clicks)}</i><small>次点击</small></span>
        ${t.ctr ? `<span class="pb-tot"><i>${t.ctr}%</i><small>点击率</small></span>` : ''}
        ${t.people ? `<span class="pb-tot"><i>${fmt(t.people)}</i><small>位访客</small></span>` : ''}
        <small class="pb-tot-note">近 ${days} 天所有灯火投放的真实效果，曝光按人次算（同一位访客一天看几次都计数，跟后台统计是同一本账）；「位访客」是这些人去重后的人数。</small>
      </div>` : '';
  // 点击率只在样本够（bill ≥ minBill）时才挂在行上展示——点击榜按点击数排，会把「8 曝光 8 点击 = 100%」
  // 这种小样本行带进来（2026-11-13 knovum 实例），不设门槛的话「怎么选」的打平点对照就被假百分比污染
  const ctrShown = x => x.ctr && x.bill >= minBill ? `点击率 ${x.ctr}%` : '';
  // 曝光榜只写「点击率 6.8%」看不出分子，把点击次数一起带上，读者能自己对上 32 / 472
  const ctrWithHits = x => x.ctr && x.bill >= minBill ? `${fmt(x.clicks)} 次点击（${x.ctr}%）` : '';
  // 三张榜的数字、单位、副标题各不相同，收在一张表里，免得三处各写一遍
  const SPEC = {
    shows: {
      label: '曝光最多', unit: '次曝光',
      num: x => fmt(x.pv),
      meta: x => [x.author, x.people ? `${x.people} 人看到` : '', ctrWithHits(x)].filter(Boolean).join(' · '),
      note: '1 次曝光 = 作品被真实访客看到一次，同一个人一天看几次就计几次（跟后台统计同口径）；后面的人数是背后不同的访客，一个人看好几次也只算 1 个。'
    },
    clicks: {
      label: '点击最多', unit: '次点击',
      num: x => fmt(x.clicks),
      // 带上曝光数：点击率才有分母可对，不然「点击率 6.8%」是 6.8% of what
      meta: x => [x.author, `${fmt(x.pv)} 次曝光`, ctrShown(x)].filter(Boolean).join(' · '),
      note: '1 次点击 = 有人真的点开了你的作品，同一个人 60 秒内连点只算 1 次；点击率 = 点击 ÷ 曝光。'
    },
    ctrs: {
      label: '点击率最高', unit: '点击率',
      num: x => `${x.ctr}%`,
      meta: x => [x.author, `${x.clicks} 次点击 / ${x.pv} 次曝光`].filter(Boolean).join(' · '),
      // 榜面只显示最高的 5 件，容易让人觉得「点击率都 10%+」；补一句全体中位数当参照，
      // 数据来自服务端 ctrMedian（全部曝光满 minBill 的作品，含 0 点击的），样本不够就不写
      note: `真扣过 ${minBill} 次曝光额度的作品才入榜，分母太小的百分比不算数`
        + (b.ctrMedian != null && b.ctrMedianN >= 2 ? `；全部 ${b.ctrMedianN} 件已投作品里，正中间那件是 ${b.ctrMedian}%（一半比它高）` : '')
    }
  };
  const rows = key => {
    const list = lists[key] || [], sp = SPEC[key];
    if (!list.length) {
      return `<div class="pb-empty">${key === 'ctrs'
        ? `还没有真扣过 ${minBill} 次曝光额度的作品，样本够了就上榜`
        : `近 ${days} 天还没有数据，空位等你来占`}</div>`;
    }
    return list.map((x, i) => `
        <div class="pb-row${i < 3 ? ' is-podium' : ''}" data-goto-w="${escapeHtml(x.workId || '')}" title="点开看这件作品">
          ${i < 3
            ? `<span class="pb-medal pb-medal-${['gold', 'silver', 'bronze'][i]}" title="第 ${i + 1} 名"><span class="ico">${ic('medal')}</span></span>`
            : `<span class="pb-rank">${i + 1}</span>`}
          ${x.thumb ? `<img class="pb-thumb" src="${escapeHtml(x.thumb)}" alt="" loading="lazy" />` : '<span class="pb-thumb is-noimg">无图</span>'}
          <span class="pb-info">
            <b class="pb-title">${escapeHtml(x.title || '未命名作品')}${x.active ? '<i class="pb-live">在投</i>' : ''}</b>
            <small class="pb-meta">${escapeHtml(sp.meta(x))}</small>
          </span>
          <span class="pb-num"><i>${sp.num(x)}</i><small>${sp.unit}</small></span>
        </div>`).join('');
  };
  const KEYS = ['shows', 'clicks', 'ctrs'];
  const tabs = KEYS.map((k, i) => `<button type="button" class="pb-tab${i === 0 ? ' is-on' : ''}" role="tab" aria-selected="${i === 0}" data-pbtab="${k}">${SPEC[k].label} ${countOf(k) || 5}</button>`).join('');
  const panes = KEYS.map((k, i) => `
        <div class="pb-col pb-pane${i === 0 ? ' is-on' : ''}" role="tabpanel" data-pbpane="${k}">
          ${SPEC[k].note ? `<div class="pb-note">${SPEC[k].note}</div>` : ''}${rows(k)}
        </div>`).join('');
  return `
    <div class="promo-board" id="promoBoard">
      <div class="pb-head">
        <span class="pb-head-t"><span class="ico">${ic('rank')}</span> 投放效果榜 · 近 ${days} 天</span>
        <small>真实访客数据，只算别人看的——投了就上这张榜</small>
      </div>
      ${totalsHtml}
      <div class="pb-tabs" role="tablist" aria-label="投放效果榜分类">${tabs}</div>
      <div class="pb-panes">${panes}</div>
      <div class="pb-foot">每一条都是花灯火投出来的。<a href="javascript:void(0)" data-board-join>我也要投 →</a></div>
    </div>`;
}

// 榜单行点开作品详情；tab 切换三张榜；底部「我也要投」：未登录弹登录，已登录滚到第 1 步选作品
function bindPromoBoard(scope, joinMode) {
  scope.querySelectorAll('#promoBoard [data-goto-w]').forEach(el => {
    el.onclick = () => { if (el.dataset.gotoW) openWork(el.dataset.gotoW); };
  });
  // tab 只在当前这块榜里切，别用全局选择器——/promote 页登录态变化时会整块重渲染，旧节点可能还挂着
  const tabs = scope.querySelectorAll('#promoBoard .pb-tab');
  const panes = scope.querySelectorAll('#promoBoard .pb-pane');
  tabs.forEach(t => {
    t.onclick = () => {
      tabs.forEach(o => {
        const on = o === t;
        o.classList.toggle('is-on', on);
        o.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panes.forEach(p => p.classList.toggle('is-on', p.dataset.pbpane === t.dataset.pbtab));
    };
  });
  const join = scope.querySelector('#promoBoard [data-board-join]');
  if (join) join.onclick = () => {
    if (joinMode === 'login') { openAuth('login'); return; }
    const sec = document.querySelector('#redeemBody .redeem-sec');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function renderRedeem() {
  const body = $('redeemBody');
  const d = redeemData;
  if (!body || !d) return;
  const slots = Array.isArray(d.slots) ? d.slots : [];
  const works = Array.isArray(d.works) ? d.works : [];
  const mine = Array.isArray(d.mine) ? d.mine : [];
  // 一次归一化：作品 → 位置 → 套餐模式 → 去向。所有互斥关系都在这里收口
  const cfg = normalizeRedeemSel();
  const mode = redeemMode();
  const selWork = works.find(w => w.id === redeemSel.workId) || null;
  const selLinks = curRedeemLinks();
  const noWork = !works.length;
  const cp = cfg.clickPoints || 2;
  const extCp = cfg.extClickPoints || cp * 2;
  const showUnit = unitPriceText(cfg.showPoints, cfg.showViews);
  // 位置差价说明按配置实时取，别在文案里写死数字（调价后文案不会说谎）
  const lfCfg = slots.find(x => x.key === 'list-first');
  const dtCfg = slots.find(x => x.key === 'detail');
  const rankCfg = slots.find(x => x.key === 'rank');
  const tier = [lfCfg, rankCfg, dtCfg].filter(Boolean);
  const priceNote = (new Set(tier.map(x => x.showPoints))).size > 1
    ? `位置价格不同：${tier.map(x => `${x.name} ${x.showPoints} 盏/次曝光`).join('，')}——位置越靠前、同屏同时可见的条数越多，曝光越值钱，贵的那部分换的就是位置。`
    : '';
  // 预览示意图里填上真实选中的作品：用户买之前就能看到自己的广告长什么样
  // 独占位已经有人在投：这一单只能排队。买之前把「要等谁、等多久」摆在明面上
  const occupied = !!cfg.exclusive && !!cfg.occupied && !cfg.occupiedMine;
  const myQueuedHere = mine.some(r => r.slot === cfg.key && r.status === 'queued');
  const myActiveHere = mine.some(r => r.slot === cfg.key && r.status === 'active');
  const blocked = cfg.exclusive && (myQueuedHere || myActiveHere);

  const worksHtml = noWork
    ? `<div class="redeem-empty">你还没有上线中的作品。推荐位只能推自己的作品——先提交一件，通过后就能投放。</div>`
    : `<div class="redeem-works">${works.map(w => `
        <button type="button" class="redeem-work${w.id === redeemSel.workId ? ' is-on' : ''}" data-rwork="${escapeHtml(w.id)}">
          ${w.thumb ? `<img src="${escapeHtml(w.thumb)}" alt="" loading="lazy" />` : '<span class="rw-noimg">无图</span>'}
          <span class="rw-title">${escapeHtml(w.title)}</span>
          ${w.id === redeemSel.workId ? '<span class="rw-check">✓</span>' : ''}
        </button>`).join('')}</div>`;

  // 位置卡：可点切换。独占位把占用情况和队列人数写在卡里，用户不必自己猜。
  // 按「投给哪一端的人」分组：作品是手机形态（Android / iOS / 小程序）时，把手机端的位排到前面并标一句
  // 「建议优先」；两端的位置都照常渲染、照常可买——只给建议，不锁死任何位置。
  const formFit = workFormFit(selWork);
  const prefPlat = formFit && formFit.family !== 'both' ? formFit.family : '';
  const groupOrder = prefPlat === 'mini' ? ['mini', 'web'] : ['web', 'mini'];
  const slotCardHtml = s => {
    const on = s.key === redeemSel.slot;
    const busy = !!s.exclusive && !!s.occupied && !s.occupiedMine;
    const soon = s.onSale === false;   // 小程序位：审核期先展示，买不了
    // 刚发布的作品买「首页第一格」：位置本来就被自己的新作品占着，先在卡里说清楚（下单前还会再确认一次）
    const fresh = freshWarnOf(s, selWork);
    return `<button type="button" class="redeem-slot${on ? ' is-on' : ''}${soon ? ' is-soon' : ''}" data-rslot="${escapeHtml(s.key)}">
        <span class="rs-main"><b>${escapeHtml(s.name)}${s.exclusive ? '<i class="rs-exclusive">独占</i>' : ''}${soon ? '<i class="rs-soon">内测中</i>' : ''}${s.platform === 'mini' ? `<span class="rs-peek" data-slotqr="${escapeHtml(s.key)}" role="button" title="小程序里的页面网页上看不到：点开出一张码，扫码直达这个页面，亲眼看看你的广告长什么样、在哪儿">查看投放效果 ›</span>` : ''}</b>
          <small>${escapeHtml(s.where || '')}</small>
          ${s.note ? `<small class="rs-note">${escapeHtml(s.note)}</small>` : ''}
          ${!s.exclusive && s.activeCount > 0 ? `<small class="rs-busy">在投 ${s.activeCount} 条 · ${s.onePerView ? '每次进页面随机展示一条，浏览期间不换' : '上后大家一起随机轮展'}</small>` : ''}
          ${!s.exclusive && !(s.activeCount > 0) ? '<small class="rs-free">现在还没有人在投，你上就是第一条</small>' : ''}
          ${fresh ? `<small class="rs-fresh"><span class="ico">${ic('warn')}</span> 这件刚发布 ${Math.max(1, Math.round(fresh.ageHours))} 小时，本来就排在第一屏，投这里买到的主要是角标</small>` : ''}
          ${busy ? `<small class="rs-busy">当前在投：${escapeHtml(s.occupiedBy || '其他作品')}${s.freeAt ? ` · 最迟 ${redeemDate(s.freeAt)} 空出` : ''}${s.queueLen ? ` · 已排 ${s.queueLen} 位` : ''}</small>`
            : (s.exclusive && !soon ? '<small class="rs-free">现在空着，买到就能上首页第一格</small>' : '')}
        </span>
        <span class="rs-price"><small>曝光单价</small>${s.showPoints}<i>盏 / ${(s.showViews || 1) === 1 ? '次曝光' : `${s.showViews} 次曝光`}</i></span>
      </button>`;
  };
  const slotsHtml = `<div class="redeem-slots">${groupOrder.map(k => {
    const list = slots.filter(s => platOfSlot(s) === k);
    if (!list.length) return '';
    const meta = SLOT_GROUPS[k];
    const rec = prefPlat === k;
    // 小程序分组：给一个「预览效果」的出口——打开当前选中作品的手机端体验页（/mini/:id），
    // 里面有直达小程序详情页的小程序码，投之前就能亲眼看到访客扫了码会落到哪儿。
    // /mini/:id 收小程序和 iOS / 安卓作品（App 作品进详情页复制下载链接到手机浏览器安装），
    // 纯网页 / 桌面形态会跳回详情页，所以只有选中的是手机端作品时才出这个按钮
    const selTypes = (() => {
      if (!selWork) return [];
      return (Array.isArray(selWork.types) && selWork.types.length ? selWork.types : (selWork.type ? [selWork.type] : []))
        .map(t => String(t || '').trim());
    })();
    const isMiniWork = selTypes.includes('小程序');
    const isMobileWork = isMiniWork || selTypes.includes('iOS') || selTypes.includes('Android');
    const peek = k === 'mini' && isMobileWork
      ? `<a class="rs-peek-mini" href="/mini/${escapeHtml(selWork.id)}" target="_blank" rel="noopener" title="${isMiniWork
          ? `打开「${escapeHtml(selWork.title)}」的手机端体验页：里面有小程序码，扫码就能进小程序，亲眼看看作品详情页长什么样`
          : `打开「${escapeHtml(selWork.title)}」的手机端体验页：扫码进小程序详情页，里面有下载链接，复制到手机浏览器就能安装`}">预览${isMiniWork ? '小程序' : '手机端'}效果 →</a>`
      : '';
    return `<div class="rs-group${rec ? ' is-rec' : ''}">
        <div class="rs-group-head">
          <span class="ico">${ic(k === 'mini' ? 'mobile' : 'web')}</span><b>${meta.title}</b>
          ${rec ? '<i class="rs-rec">建议优先</i>' : (prefPlat ? '<em>也可以投</em>' : '')}
          ${peek}
          <small>${meta.hint}</small>
        </div>
        ${list.map(slotCardHtml).join('')}
      </div>`;
  }).join('')}</div>`;
  // 建议条：作品有形态就按形态把「优先投哪一端」讲明白（两端都能投，下面说得清楚）
  const adviceHtml = formFit
    ? `<div class="rs-advice"><span class="ico">${ic('sparkle')}</span><p>${promoAdviceOf(selWork)}</p></div>`
    : '';

  // ---------- 第 3 步：先定计费方式，再定档位；同一时刻只出现一组档位 ----------
  const modeHtml = `<div class="redeem-modes">
      <button type="button" class="redeem-mode${mode === 'view' ? ' is-on' : ''}" data-rmode="view">
        <b>曝光包</b><small>按「被看到」扣 · ${showUnit}</small>
      </button>
      <button type="button" class="redeem-mode${mode === 'click' ? ' is-on' : ''}" data-rmode="click">
        <b>点击包</b><small>按「被点开」扣 · 站内 ${cp} 盏/次</small>
      </button>
    </div>`;
  // 自定义数量：预设档只是快捷键，1..上限之间任意整数都能填（上限由服务端 slots[].showMax/clickMax 给）
  const showMax = cfg.showMax || Math.max(0, ...(cfg.showPacks || []));
  const clickMax = cfg.clickMax || Math.max(0, ...(cfg.clickPacks || []).filter(v => v > 0));
  const isCustomView = mode === 'view' && !(cfg.showPacks || []).includes(redeemSel.views);
  const isCustomClick = mode === 'click' && !(cfg.clickPacks || []).filter(v => v > 0).includes(redeemSel.clicks);
  const packsHtml = mode === 'view'
    ? `<div class="redeem-packs">${(cfg.showPacks || []).map(v => `
        <button type="button" class="redeem-pack${v === redeemSel.views ? ' is-on' : ''}" data-rviews="${v}">
          <b>${v} 次曝光</b><small>${Math.round(v / (cfg.showViews || 1) * (cfg.showPoints || 1))} 灯火</small>
        </button>`).join('')}
        <label class="redeem-pack rp-custom${isCustomView ? ' is-on' : ''}" title="自己填次数：1-${showMax} 之间任意整数都行">
          <b><input type="number" class="rp-input" data-rqty="views" inputmode="numeric" min="1" max="${showMax}" value="${isCustomView && redeemSel.views ? redeemSel.views : ''}" placeholder="自定义" /></b>
          <small>1-${showMax} 次${isCustomView && redeemSel.views ? ` · ${Math.round(redeemSel.views / (cfg.showViews || 1) * (cfg.showPoints || 1))} 灯火` : ''}</small>
        </label></div>`
    : `<div class="redeem-packs">${(cfg.clickPacks || []).filter(v => v > 0).map(v => `
        <button type="button" class="redeem-pack${v === redeemSel.clicks ? ' is-on' : ''}" data-rclicks="${v}">
          <b>${v} 次点击</b><small>${v * effClickUnit()} 灯火</small>
        </button>`).join('')}
        <label class="redeem-pack rp-custom${isCustomClick ? ' is-on' : ''}" title="自己填次数：1-${clickMax} 之间任意整数都行">
          <b><input type="number" class="rp-input" data-rqty="clicks" inputmode="numeric" min="1" max="${clickMax}" value="${isCustomClick && redeemSel.clicks ? redeemSel.clicks : ''}" placeholder="自定义" /></b>
          <small>1-${clickMax} 次${isCustomClick && redeemSel.clicks ? ` · ${redeemSel.clicks * effClickUnit()} 灯火` : ''}</small>
        </label></div>`;
  // 「怎么选」：打平点（等价 CTR = 曝光单价 ÷ 点击单价）单独报出来会唬人，所以把服务端算的该位
  // 近 90 天实测点击率（slots[].realCtr，样本 realBill<200 时不用）标成「系统统计」摆出来，按数据分四种口径：
  // 实测明显高于打平点（≥1.2 倍）→ 曝光包更省；明显低于（≤0.8 倍）→ 点击包更稳；
  // 两者咬得紧 → 说清两边成本差不多；没数据 → 退回只报打平点的通用话术。
  // 2026-11-12 点击价改成「曝光价 × 30」后，各位置打平点统一 3.3%，不再需要「首页 10% 特别唬人」那套特殊口径，
  // 三个分支纯粹由该位的实际 CTR 说话。
  // 2026-11-14 口径统一：realCtr 与打平点都用「人次 PV」（跟效果榜、跟后台同一个尺子）。
  // 打平点本身是按扣费推的（1 灯火 1 次扣费曝光 / 30 灯火 1 次点击 → 3.3%），换到人次尺子要乘
  // 该位的 bill/pv（服务端 ctrScale，≈0.53）：100 人次曝光作者只为其中约 53 次付钱，所以
  // 打平点变成 1.7~1.8%。两个数同乘一个比例，比值不变——四个分支的判断结论跟改之前完全一样。
  const ctrScale = cfg.ctrScale > 0 ? cfg.ctrScale : 0.55;
  const equivCtr = Math.round(1000 * (cfg.showPoints || 1) / (cfg.clickPoints || 30) * ctrScale) / 10;
  const equivCtrHits = Math.max(1, Math.round(equivCtr));
  const realCtr = cfg.realCtr || 0, realBill = cfg.realBill || 0;
  const realOk = realBill >= 200 && realCtr > 0;
  const ctrRatio = realOk && equivCtr > 0 ? realCtr / equivCtr : 0;
  const viewWin = ctrRatio >= 1.2;   // 实测已超过打平点：同样的钱买曝光更省
  const clickWin = realOk && ctrRatio <= 0.8;
  const modePickHtml = `<div class="redeem-modepick">${viewWin
    ? `<b>怎么选：</b>系统统计的这个位近 90 天<b>实测点击率约 ${realCtr}%</b>，已经高过打平点 <b>${equivCtr}%</b>（每 100 次曝光被点开约 ${equivCtrHits} 次就打平）——同样的钱在这里选<b>曝光包</b>更省；只有你的封面明显比这个位的平均水平更不吸引人，才换成<b>点击包</b>。`
    : clickWin
    ? `<b>怎么选：</b>这个位两种包「花同样的钱」对应的点击率约 <b>${equivCtr}%</b>（每 100 次曝光被点开约 ${equivCtrHits} 次就打平），而系统统计的近 90 天<b>实测点击率约 ${realCtr}%</b>，比打平点低——多数作品在这里选<b>点击包</b>更稳，只为真点开的人付费；<b>曝光包</b>只适合封面特别炸、预估能明显超过 ${equivCtr}% 的作品。`
    : realOk
    ? `<b>怎么选：</b>这个位两种包「花同样的钱」对应的点击率约 <b>${equivCtr}%</b>（每 100 次曝光被点开约 ${equivCtrHits} 次就打平），系统统计的近 90 天<b>实测点击率约 ${realCtr}%</b>——两个数咬得很紧，选哪边成本都差不多：想攒曝光选<b>曝光包</b>，只想为真点开的人付费就选<b>点击包</b>。`
    : `<b>怎么选：</b>封面标题够亮眼、看一眼就想点的作品，选<b>曝光包</b>更划算——点得多，按曝光算反而便宜；要访客多看几次才会点的作品（工具、需要琢磨的东西），选<b>点击包</b>更稳——只为真点开的人付费。这个位两种包「花同样的钱」对应的点击率约是 <b>${equivCtr}%</b>（每 100 次曝光被点开约 ${equivCtrHits} 次就打平）：预估你的作品能明显超过它就选曝光包，够不着或拿不准就选点击包。`}</div>`;
  const modeNote = mode === 'view'
    ? '曝光包：被看到一次扣一次，点开的人只计数、<b>不另收费</b>；去向固定为作品详情页。'
    : `点击包：只有被点开才扣。去向在下一步选${cfg.internalOnly ? '，这个位置只跳站内详情页' : `：站内 ${cp} 盏/次，跳官网 / 下载 ${extCp} 盏/次`}。`;
  // 投放期限（只有两个「首页第一格」独占位才有）：1..maxDays 天，默认给满额。
  // 天数不改价格——仍按次买，天数只决定这单最多挂多久；到期没投完的照样按原价退余额，
  // 所以选短了不亏灯火，只是把位置更早让给排队的人（独占位库存只有 1，这点很关键）。
  const maxPickDays = cfg.maxDays || 7;
  const daysHtml = cfg.daysPick ? `
    <div class="redeem-days">
      <div class="rd-head"><b>投放期限</b><small>这单最多挂几天 · 从开始投放那天算起${occupied ? '，排队等待不算' : ''}</small></div>
      <div class="rd-picks">${Array.from({ length: maxPickDays }, (_, i) => i + 1).map(n => `
        <button type="button" class="redeem-day${n === redeemSel.days ? ' is-on' : ''}" data-rdays="${n}">
          <b>${n} 天</b>${n === maxPickDays ? '<small>最长</small>' : ''}
        </button>`).join('')}</div>
      <p class="rd-tip">${occupied
        ? `你选的是<b>${redeemSel.days} 天</b>：现在先排队，<b>从轮到你那天</b>才开始算天数，等待期不占。`
        : `按次扣费不变，随时可以撤下，没用完的按原价退回；<b>${redeemSel.days} 天</b>后自动下线，剩下的灯火一起退回。`}</p>
    </div>` : '';

  // ---------- 第 4 步：能选什么去向，由第 3 步的模式决定 ----------
  // 曝光包下不报任何点击价，外链项直接锁死并给「回第 3 步」的入口；
  // 点击包下才出现两个可选项与真实点击单价（小程序位不报外链价，因为那儿买不到）。
  const extMiniTitle = '小程序里打开外链只能复制到剪贴板，这个位只跳站内详情页';
  const extViewTitle = '曝光包按「被看到」计费、点击不计费，带不了外链；请先在第 3 步选「点击包」';
  const extDisabledTitle = cfg.internalOnly ? extMiniTitle : extViewTitle;
  const extSmall = cfg.internalOnly ? '小程序位只跳站内详情页'
    : (!selLinks.length ? '这件作品没填官网 / 下载链接' : `跳作品自己的地址 · 点击 ${extCp} 盏/次`);
  const linkPillsHtml = selLinks.length > 1 ? `<div class="rt-links">${selLinks.map(e => `
      <button type="button" class="rt-link-pill${e.url === redeemSel.link ? ' is-on' : ''}" data-rlink="${escapeHtml(e.url)}" title="${escapeHtml(e.url)}">
        <b><span class="ico p-ico">${ic(e.t && LINK_ICON[e.t] ? LINK_ICON[e.t] : 'globe')}</span>${escapeHtml(e.t || '官网')}</b>
        <small>${escapeHtml(linkHostOf(e.url))}</small>
      </button>`).join('')}</div>` : '';
  const linkRowHtml = selLinks.length ? `<p class="rt-link">点击广告将打开：<a href="${escapeHtml(redeemSel.link || selLinks[0].url)}" target="_blank" rel="noopener nofollow sponsored">${escapeHtml(redeemSel.link || selLinks[0].url)}</a>（投稿时登记的地址${selLinks.length > 1 ? '，点上面可换' : ''}）</p>` : '';
  const targetHtml = mode === 'view'
    ? `<div class="redeem-targets">
        <button type="button" class="redeem-target is-on" data-rtarget="in">
          <b>作品详情页</b><small>站内跳转 · 点击不另收费</small>
        </button>
        <button type="button" class="redeem-target" data-rtarget="ext" disabled title="${escapeHtml(extDisabledTitle)}">
          <b>官网 / 下载链接 ↗</b><small>只有点击包能选</small>
        </button>
      </div>
      ${cfg.internalOnly ? '<p class="rt-hint">这个位置在小程序里，点开只跳站内作品详情页。</p>'
        : '<p class="rt-hint">想跳到作品自己的官网 / 下载页？<button type="button" class="rt-switch" data-rmode="click">回第 3 步选「点击包」→</button></p>'}`
    : `<div class="redeem-targets">
        <button type="button" class="redeem-target${redeemSel.ext ? '' : ' is-on'}" data-rtarget="in">
          <b>作品详情页</b><small>站内跳转 · 点击 ${cp} 盏/次</small>
        </button>
        <button type="button" class="redeem-target${redeemSel.ext ? ' is-on' : ''}" data-rtarget="ext"${cfg.internalOnly || !selLinks.length ? ` disabled title="${escapeHtml(cfg.internalOnly ? extMiniTitle : '这件作品没填官网 / 下载链接，先去编辑作品补一个')}"` : ''}>
          <b>官网 / 下载链接 ↗</b><small>${escapeHtml(extSmall)}</small>
        </button>
      </div>
      ${redeemSel.ext ? linkPillsHtml + linkRowHtml : ''}`;

  const mineHtml = mine.length ? `<div class="redeem-list">${mine.map(r => {
    const st = REDEEM_STATUS[r.status] || { text: r.status, cls: 'done' };
    const comp = r.comp === true;   // 站长代投：不计费，没有额度进度
    const clickOnly = !comp && (r.views || 0) === 0 && (r.clicks || 0) > 0;   // 纯点击包：没有曝光额度
    const queued = r.status === 'queued';
    // 排队中：进度条一律 0，foot 写清排第几位、前一位什么时候空出来
    const pct = comp ? 0 : (queued ? 0 : (clickOnly
      ? Math.min(100, Math.round((r.clickUsed || 0) / r.clicks * 100))
      : (r.views ? Math.min(100, Math.round(r.used / r.views * 100)) : 0)));
    const progress = comp
      ? (queued ? `排队第 ${r.queuePos || 1} 位 · 站长代投，轮到后开始计时`
        : `站长代投 · 不消耗灯火`)
      : (queued
      ? `排队第 ${r.queuePos || 1} 位 · 前面这一单投完自动开始（灯火已扣，不消耗）`
      : (clickOnly
        ? `已点击 ${r.clickUsed || 0}/${r.clicks} 次`
        : `已曝光 ${r.used}/${r.views} 次${r.clicks ? ` · 点击 ${r.clickUsed}/${r.clicks} 次` : ''}`));
    // 投放中：把「已消耗多少 / 撤下能退多少」直接写出来，花了和退的永远对得上账
    const canBack = comp ? 0 : (r.status === 'active' ? redeemRefundOf(r) : (queued ? (r.price || 0) : 0));
    const spent = comp ? 0 : Math.max(0, (r.price || 0) - canBack);
    const foot = comp
      ? (r.status === 'active'
        ? [r.endsAt ? `最迟 ${redeemDate(r.endsAt)} 下线` : '', '站长代投（不消耗灯火）'].filter(Boolean).join(' · ')
        : '站长代投 · 不涉及灯火')
      : (r.status === 'active'
      ? [r.endsAt ? `${r.daysPicked ? `投 ${r.days} 天 · ` : ''}最迟 ${redeemDate(r.endsAt)} 下线` : '', `已消耗 ${spent} 盏`, canBack > 0 ? `撤下可退 ${canBack} 盏` : '额度已用完']
          .filter(Boolean).join(' · ')
      : queued ? `随时可撤，全额退回 ${canBack} 盏${r.daysPicked ? ` · 轮到后投 ${r.days} 天` : ''}`
        : (r.refunded ? `已消耗 ${(r.price || 0) - (r.refunded || 0)} 盏 · 已退回 ${r.refunded} 盏灯火` : ''));
    return `<div class="redeem-item${queued ? ' is-queued' : ''}">
        <div class="ri-top">
          <span class="ri-title">${escapeHtml(r.workTitle)}${comp ? '<i class="ri-ext" title="站长代投：不消耗灯火，到期自动下线">站长代投</i>' : ''}${r.extLink ? `<i class="ri-ext" title="${escapeHtml(r.link || '')}">外链 ↗</i>` : ''}</span>
          <span class="ri-status is-${st.cls}">${st.text}</span>
        </div>
        <div class="ri-meta">${escapeHtml(r.slotName)} · ${progress}</div>
        <div class="ri-bar"><span style="width:${pct}%"></span></div>
        <div class="ri-foot">
          <span>${foot}</span>
          <span class="ri-foot-btns">
            ${r.status === 'active' ? `<button type="button" class="ri-peek" data-rpeek="${escapeHtml(r.slot)}" title="亲眼看看你的广告现在长什么样、在哪儿"><span class="ico">${ic('eye')}</span> 看效果</button>` : ''}
            ${(r.status === 'active' || queued) ? `<button type="button" class="ri-cancel" data-rcancel="${escapeHtml(r.id)}">${queued ? '取消排队' : '撤下'}</button>` : ''}
          </span>
        </div>
      </div>`;
  }).join('')}</div>` : '<div class="redeem-empty">还没有投放记录。换一次推荐位，作品就会出现在你选的位置上。</div>';

  // 签到这条每天白拿、比分享更省事，放进「怎么获得灯火」第一条；档位跟服务端 schedule 走，不写死数字
  const ckSched = (state.user && state.user.checkin && Array.isArray(state.user.checkin.schedule) && state.user.checkin.schedule.length)
    ? state.user.checkin.schedule : [5, 5, 10, 10, 20, 20, 30];
  const ckDays = ckSched.length;
  const ckSum = ckSched.reduce((a, b) => a + b, 0);

  body.innerHTML = `
    <div class="redeem-topline">
      <span class="rt-bal">可用灯火 <b>${d.points || 0}</b> 盏</span>
      <button type="button" class="rh-link" id="promoStatsLink">看分享成绩与达人榜 →</button>
    </div>
    <div class="redeem-faq">
      <details class="rfq-item">
        <summary>怎么获得灯火？</summary>
        <div class="rfq-a">
          <p>最省事的是<b>每天签到</b>：网页右上角「签到」、小程序「我的」页的签到卡，点一下就行。${scheduleLadder(ckSched)}，${ckDays} 天一共 <b>${ckSum} 盏</b>。断一天就从第 1 天重新开始，已经拿到的不倒扣。</p>
          <p>最快的一招是<b>把作品分享给朋友</b>：好友通过你的分享链接访问 <b>+1 盏</b>、<b>扫码打开 +3 盏</b>（每人每天只计一次）、注册 <b>+100 盏</b>。</p>
          <div class="rh-share-row"><span>一条分享链接就够：</span><button type="button" class="rh-share-btn" id="shareMyWork"><span class="ico">${ic('share')}</span> 去分享作品</button></div>
          <p>投稿过审也有奖励（首件最多 +200 盏、之后每件 +50 盏），老账号绑定微信一次性 +300 盏。<b>不用充值。</b></p>
        </div>
      </details>
      <details class="rfq-item">
        <summary>怎么扣灯火、能不能退？</summary>
        <div class="rfq-a">
          <p><b>曝光包</b>按「被看到」扣、<b>点击包</b>按「被点开」扣，用完自动下线；没投完的随时能撤，剩下的按原价退回。位置都在真实访客每天经过的地方，先投一小档试试水，看数据再加量。</p>
          <p>一件作品可以同时投几个位置，<b>每个位置单独计</b>：同一个人先在首页看到、点进详情又看到，就是两笔，各扣各自那一单——两块位置确实都露了面，不是同一笔重复收。同一笔投放哪怕在几个展示面都出现，同一个人一天也仍只扣一次。</p>
          <p><a class="rfq-jump" href="javascript:void(0)" data-rv-jump>什么才算看见、会不会重复扣？看完整口径 ↓</a></p>
        </div>
      </details>
    </div>
    ${promoBoardHtml(promoBoardData)}
    <div class="redeem-sec">
      <div class="redeem-sec-head">1. 选作品<span>只能推自己名下、已上线的作品</span></div>
      ${worksHtml}
    </div>
    <div class="redeem-sec redeem-sec-slots">
      <div class="redeem-sec-head">2. 选位置<span>${cfg.exclusive ? '这个位置全站只有一个，买到即独占；有人在投时排队等' : cfg.key === 'rank' ? '同一个位置多人买，PC 星梦榜右栏一次竖排最多 5 条同时曝光（手机一条），各家机会均等' : '同一个位置多人买，PC 一次并排 2-4 条同时曝光（手机一条），各家机会均等'}</span></div>
      ${adviceHtml}
      ${slotsHtml}
      <div class="redeem-preview" aria-hidden="true">
        ${cfg.key === 'list-first' ? `
        <!-- 首页第一格：投放的是信息流原生卡（大封面+标题+推荐角标），预览要跟真实样式对上 -->
        <div class="rp-card">
          <div class="rp-cover">${selWork && selWork.thumb ? `<img class="rp-cover-img" src="${escapeHtml(selWork.thumb)}" alt="" />` : ''}<span class="rp-flag">推荐</span></div>
          <div class="rp-cbody">
            <div class="rp-ctitle${selWork ? ' rp-real' : ''}">${selWork ? escapeHtml(selWork.title) : ''}</div>
            <div class="rp-cmeta"><i></i><i></i></div>
            <div class="rp-cfoot"><span>我也想推荐自己的作品</span><b>看看 →</b></div>
          </div>
          <div class="rp-ad"><span class="ico">${ic('promo')}</span> 你的作品卡（第一格）</div>
        </div>` : (cfg.key === 'mini-home-first' || cfg.key === 'mini-bar') ? `
        <!-- 小程序·首页第一格 / 造梦酒馆：手机壳里的作品流，第一格是原生作品卡 -->
        <div class="rp-phone">
          <div class="rp-phone-screen">
            <div class="rp-mbar"></div>
            <div class="rp-mcard">
              <div class="rp-mcover">${selWork && selWork.thumb ? `<img src="${escapeHtml(selWork.thumb)}" alt="" />` : ''}<span class="rp-flag">推荐</span></div>
              <div class="rp-mcbody">
                <div class="rp-mctitle${selWork ? ' rp-real' : ' rp-ph'}">${selWork ? escapeHtml(selWork.title) : '你的作品标题'}</div>
                <div class="rp-mcfoot"><span>我也想推荐自己的作品</span><b>看看 →</b></div>
              </div>
            </div>
            <div class="rp-mcard is-ghost"><div class="rp-mcover"></div><div class="rp-mcbody"><div class="rp-mctitle"></div></div></div>
          </div>
        </div>` : (cfg.key === 'mini-rank-line' || cfg.key === 'mini-detail') ? `
        <!-- 小程序·一行文字：手机壳里一条文字推荐 + 下面的普通内容 -->
        <div class="rp-phone">
          <div class="rp-phone-screen">
            <div class="rp-mbar"></div>
            <div class="rp-mline">
              <span class="rp-mline-mark">推荐</span>
              <span class="rp-mline-title${selWork ? ' rp-real' : ' rp-ph'}">${selWork ? escapeHtml(selWork.title) : '你的作品标题'}</span>
              <span class="rp-mline-go">›</span>
            </div>
            <div class="rp-mlist"><i></i><i></i><i></i><i></i></div>
          </div>
        </div>` : cfg.key === 'rank' ? `
        <!-- 榜单页顶部 + 造梦酒馆（共用槽位）：横幅夹在页头和内容之间，预览要能看出「不占名次/排序」 -->
        <div class="rp-modal">
          <div class="rp-head"><i></i><i></i></div>
          <div class="rp-body">
            <div class="rp-ad"><span class="ico">${ic('promo')}</span> 你的作品推荐横幅</div>
            <div class="rp-cmt"><i></i><i></i></div>
            <div class="rp-cmt"><i></i><i></i></div>
          </div>
        </div>` : `
        <div class="rp-modal">
          <div class="rp-head"><i></i><i></i></div>
          <div class="rp-body">
            <div class="rp-top"><span class="rp-thumb"></span><span class="rp-lines"><i></i><i></i></span></div>
            <div class="rp-btns"><i></i><i></i><i></i></div>
            <div class="rp-ad">${selWork && selWork.thumb ? `<img class="rp-ad-img" src="${escapeHtml(selWork.thumb)}" alt="" />` : ''}<span class="rp-ad-txt"><span class="ico">${ic('promo')}</span> 你的作品广告${selWork ? ` · ${escapeHtml(selWork.title)}` : ''}</span></div>
            <div class="rp-cmt"><i></i><i></i></div>
          </div>
        </div>`}
        <div class="rp-note">${cfg.key === 'mini-bar'
            ? '↑ 作品卡出现在小程序造梦酒馆顶部，<br />一次展示一条，多位投放时每次随机一条'
        : cfg.key === 'list-first'
          ? '↑ 你的作品会以一张原生卡片出现在<br />首页作品列表的第一个位置'
          : cfg.key === 'mini-home-first'
            ? '↑ 你的作品会以一张原生卡片出现在<br />小程序首页作品流的第一个位置（独占）'
            : cfg.key === 'mini-rank-line'
              ? '↑ 一行文字同时在两处轮展：星梦榜分段栏下方 + 发现页顶部，<br />多位投放时每次随机展示一条'
              : cfg.key === 'mini-detail'
                  ? '↑ 一行文字出现在小程序作品详情页，<br />评论区上方；点开作品的人才看得到，曝光少但都是真在挑作品的人'
          : cfg.key === 'rank'
            ? '↑ 横幅同时在两个页面轮展：星梦榜页（PC 宽屏在右栏竖排、最多 5 条）+ 造梦酒馆页头下方，<br />手机各一条，不占名次/想法排序，带「推荐」角标'
            : '↑ 广告展示在这里：作品详情弹窗内，<br />作品简介和评论区之间。它只出现在<b>别人的</b>作品详情页，<br />投出去后用「我的投放 → 看效果」亲眼确认'}</div>
      </div>
    </div>
    <div class="redeem-sec">
      <div class="redeem-sec-head">3. 选套餐<span>先定按什么计费，再选买多少（次数可以自己填）· 下面是「${escapeHtml(cfg.name || '')}」的单价</span></div>
      ${modeHtml}
      ${modePickHtml}
      ${packsHtml}
      ${daysHtml}
      <p class="rmode-note">${modeNote}</p>
      <div class="redeem-cap-tip">
        <b>防刷保护</b>
        <span>同一个人（登录按账号，没登录按这台设备的浏览器），一天最多消耗你 <i>${d.dayCapViews || 1} 次曝光</i>、<i>${d.dayCapClicks || 3} 次点击</i>；超出后作品照常展示、点击照常记录，但<b>不再扣你的灯火</b>。你买的次数只会被更多不同的人消耗。另外你自己点自己的作品，也一样不消耗灯火。</span>
      </div>
      ${occupied ? `<div class="redeem-warn">
        ${escapeHtml(cfg.occupiedBy || '别人的作品')} 正占着这个位置${cfg.freeAt ? `，最迟 ${redeemDate(cfg.freeAt)} 空出` : ''}${cfg.queueLen ? `，队里已有 ${cfg.queueLen} 位` : ''}。
        你现在下单就是<b>排队预约</b>：灯火先扣但不消耗，轮到你才自动开始；等待期随时可以取消，<b>全额退回</b>。
      </div>` : ''}
      ${blocked ? `<div class="redeem-warn">你这个位置已经有「在投」或「排队中」的单子了，等这一单结束再来。</div>` : ''}
    </div>
    <div class="redeem-sec">
      <div class="redeem-sec-head">4. 选去向<span>${mode === 'view' ? '曝光包固定跳站内作品详情页' : '点广告的人去哪儿：站内详情，或作品自己的官网 / 下载页'}</span></div>
      ${targetHtml}
    </div>
    <details class="redeem-value" id="redeemValue"${redeemValueOpen ? ' open' : ''}>
      <summary>
        <span class="rv-tag">为什么值</span>
        <span class="rv-lead"><b>只有真人真的看见了，才花你一盏灯火。</b>看不见的不算、重复看的不算、自己看的不算。</span>
        <span class="rv-more"><span class="rv-more-open">展开看怎么算 ↓</span><span class="rv-more-close">收起 ↑</span></span>
      </summary>
      <div class="rv-body">
        <ul>
          <li><b>看见才算，没看见不收。</b>作品卡要真的滚进屏幕、露出一半以上，才记一次。这一步由浏览器自带的 IntersectionObserver（可见性检测）盯着：挂在页面底部没滑到、轮播里还没轮到它，都不计数、也不扣灯火。</li>
          <li><b>同一个人不重复收。</b>同一个访客一天只计一次（登录按账号、未登录按这台设备认人），反复刷新、来回翻都不重复扣；超过当天上限后作品照常展示，但不再扣灯火，换来的次数只会被更多不同的人消耗。</li>
          <li><b>自己看自己不收。</b>你打开自己的作品不消耗灯火，正在看的这件作品也不会在详情页里给自己推自己。</li>
          <li><b>没用完能退。</b>额度用完自动下线；没投完随时可以撤下，剩下的按原价退回灯火，一分不差。${cfg.daysPick ? `你选的 ${redeemSel.days} 天到期` : `${d.maxDays} 天内`}没投完，也会自动下线并退回。</li>
          <li><b>只在推荐卡上算。</b>只有带「推荐」角标的那张卡被看到、被点开才扣灯火。作品在「最新」「最热」「随便逛逛」里被正常浏览、点开、点赞收藏，都不扣你的灯火；投放也不会改变这几处的排序——不会让作品插队、也不会给它加分，那几处只按作品自己收到的赞、收藏、评论和真实访问排。</li>
          <li><b>按位置各算各的。</b>一件作品同时投首页第一格和详情页，是两个位置：同一个人先在首页看到一次、点进详情又看到一次，就是两笔，各扣各自那一单。反过来，同一笔投放还可能在榜单页和酒馆、或在「随便逛逛」里多露一次面，同一个人一天仍只扣 1 次——露得多不会重复收。</li>
        </ul>
        <p class="rv-terms">一次买好、按次扣减，投放期间不再额外扣灯火；额度用完只计数、不再计费。每人同时最多 ${d.maxActive} 条在投（网页和小程序共用这个名额），同一件作品在同一个位置只能挂一条；花了多少、退多少都会列出来。${priceNote}</p>
        <p class="rv-kicker">一句话：灯火只花在「被真人看见」上，不为没人看的位置买单。</p>
      </div>
    </details>
    <div class="redeem-foot">${redeemFootHtml()}
    </div>
    <div class="redeem-sec" id="promoMine">
      <div class="redeem-sec-head">我的投放</div>
      ${mineHtml}
    </div>`;

  // 「为什么值」折叠卡：切作品/位置/套餐会整版重绘，记住展开状态别弹回去
  const rv = $('redeemValue');
  if (rv) {
    rv.addEventListener('toggle', () => { if (rv.isConnected) redeemValueOpen = rv.open; });
    // 页首 FAQ 里的「看完整口径」：就地展开并滚过去，省得用户自己在四步里翻
    const rvJump = body.querySelector('[data-rv-jump]');
    if (rvJump) rvJump.onclick = () => {
      rv.open = true; redeemValueOpen = true;
      requestAnimationFrame(() => rv.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
  }
  bindPromoBoard(body, 'scroll');
  body.querySelectorAll('[data-rwork]').forEach(el => {
    el.onclick = () => {
      redeemSel.workId = el.dataset.rwork;
      // 换作品后链接候选可能变了，统一交给 normalizeRedeemSel() 兜底
      renderRedeem();
    };
  });
  // 第 3 步的模式开关（两个卡片 + 第 4 步「回第 3 步选点击包」的快捷入口共用这一套绑定）
  body.querySelectorAll('[data-rmode]').forEach(el => {
    el.onclick = () => {
      const m = el.dataset.rmode === 'click' ? 'click' : 'view';
      if (m === redeemMode()) return;
      redeemSel.mode = m;
      redeemSel.views = 0; redeemSel.clicks = 0;   // 让归一化挑该模式下的默认档位
      renderRedeem();
    };
  });
  // 第 4 步：只有点击包才走到这里能选外链；曝光包下 ext 是 disabled，浏览器不会派发 click
  body.querySelectorAll('[data-rtarget]').forEach(el => {
    el.onclick = () => {
      if (el.disabled) return;
      if (redeemMode() === 'view') { showToast('要跳官网 / 下载链接，请先在第 3 步选「点击包」', undefined, 'err'); return; }
      const ext = el.dataset.rtarget === 'ext';
      if (ext === redeemSel.ext) return;
      if (ext) {
        if (!curRedeemLinks().length) { showToast('这件作品还没填官网 / 下载链接，先去编辑作品补一个', undefined, 'err'); return; }
        redeemSel.link = '';   // 归一化会默认挑官网（没有官网则第一个形态的链接）
      }
      redeemSel.ext = ext;
      renderRedeem();
    };
  });
  body.querySelectorAll('[data-rlink]').forEach(el => {
    el.onclick = () => {
      if (el.dataset.rlink === redeemSel.link) return;
      redeemSel.link = el.dataset.rlink;   // 只换去向地址，不触发整版重渲染（选中态手工翻转即可）
      body.querySelectorAll('[data-rlink]').forEach(x => x.classList.toggle('is-on', x === el));
      const rt = body.querySelector('.rt-link a');
      if (rt) { rt.href = redeemSel.link; rt.textContent = redeemSel.link; }
    };
  });
  body.querySelectorAll('[data-rslot]').forEach(el => {
    el.onclick = () => {
      if (el.dataset.rslot === redeemSel.slot) return;
      redeemSel.slot = el.dataset.rslot;
      // 计费模式保留，只把档位清空换该位置的默认档；小程序位不支持外链由归一化统一处理
      redeemSel.views = 0; redeemSel.clicks = 0;
      redeemSel.days = 0;   // 期限回到该位置的默认（自选位给满额），别把上一位的天数带过来
      renderRedeem();
    };
  });
  body.querySelectorAll('[data-rviews]').forEach(el => {
    el.onclick = () => {
      redeemSel.mode = 'view';
      redeemSel.views = parseInt(el.dataset.rviews, 10) || 0;
      redeemSel.clicks = 0;
      renderRedeem();
    };
  });
  body.querySelectorAll('[data-rclicks]').forEach(el => {
    el.onclick = () => {
      redeemSel.mode = 'click';
      redeemSel.clicks = parseInt(el.dataset.rclicks, 10) || 0;
      redeemSel.views = 0;
      renderRedeem();
    };
  });
  // 自定义次数输入框（预设档旁边的「自定义」）：输入实时改档位、只刷新合计不整版重绘（整版重绘会丢焦点）；
  // 失焦时把数字钳回 1..上限，清空了就把框里恢复成当前档位，别让人以为没填上。
  body.querySelectorAll('.rp-input').forEach(el => {
    const kind = el.dataset.rqty === 'clicks' ? 'clicks' : 'views';
    const max = parseInt(el.max, 10) || 0;
    const packEl = el.closest('.redeem-pack');
    const priceEl = packEl ? packEl.querySelector('small') : null;
    const syncCustom = () => {
      const v = Math.round(parseFloat(el.value));
      const valid = Number.isFinite(v) && v >= 1 && v <= max;
      const attr = kind === 'views' ? 'rviews' : 'rclicks';
      let onPreset = false;
      body.querySelectorAll(kind === 'views' ? '[data-rviews]' : '[data-rclicks]').forEach(b => {
        const hit = valid && parseInt(b.dataset[attr], 10) === v;
        b.classList.toggle('is-on', hit);
        if (hit) onPreset = true;
      });
      if (packEl) packEl.classList.toggle('is-on', valid && !onPreset);
      if (priceEl && valid) priceEl.textContent = kind === 'views'
        ? `1-${max} 次 · ${Math.round(v / (curSlotCfg().showViews || 1) * (curSlotCfg().showPoints || 1))} 灯火`
        : `1-${max} 次 · ${v * effClickUnit()} 灯火`;
      // 合计和购买按钮在 .redeem-foot 里，单独重绘 + 重绑（同 renderRedeem 尾部的绑法）
      const foot = body.querySelector('.redeem-foot');
      if (foot) {
        foot.innerHTML = redeemFootHtml();
        const go = $('redeemGo');
        if (go) go.onclick = () => submitRedeem(go);
      }
    };
    el.addEventListener('input', () => {
      const v = Math.round(parseFloat(el.value));
      if (!Number.isFinite(v) || v < 1) return;   // 删到一半的半截状态别误清档位
      const clamped = Math.min(max, v);
      if (kind === 'views') { redeemSel.mode = 'view'; redeemSel.views = clamped; redeemSel.clicks = 0; }
      else { redeemSel.mode = 'click'; redeemSel.clicks = clamped; redeemSel.views = 0; }
      syncCustom();
    });
    el.addEventListener('change', () => {
      const v = Math.round(parseFloat(el.value));
      if (!Number.isFinite(v) || v < 1) { el.value = kind === 'views' ? (redeemSel.views || '') : (redeemSel.clicks || ''); syncCustom(); return; }
      el.value = Math.max(1, Math.min(max, v));
      syncCustom();
    });
  });
  // 投放期限（只有两个首页第一格有这排按钮）：只改天数，价格不动
  body.querySelectorAll('[data-rdays]').forEach(el => {
    el.onclick = () => {
      redeemSel.days = parseInt(el.dataset.rdays, 10) || 0;
      renderRedeem();
    };
  });
  body.querySelectorAll('[data-rcancel]').forEach(el => {
    el.onclick = () => cancelRedeem(el.dataset.rcancel);
  });
  body.querySelectorAll('[data-rpeek]').forEach(el => {
    el.onclick = () => peekRedeem(el.dataset.rpeek);
  });
  // 位置卡标题旁的「查看投放效果」：出一张直达该小程序页面的码（stopPropagation 别误选这个位）
  body.querySelectorAll('[data-slotqr]').forEach(el => {
    el.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      openMiniPeekQr(el.dataset.slotqr);
    };
  });
  const smb = $('shareMyWork');
  if (smb) smb.onclick = openSharePick;
  const psl = $('promoStatsLink');
  if (psl) psl.onclick = () => openStats('promo');
  const go = $('redeemGo');
  if (go) go.onclick = () => submitRedeem(go);
  // 从「我的主页 → 我的推荐」跳过来的：直接滚到「我的投放」记录区，
  // 别让人自己在一整页选作品/选位置里找账本（只滚一次，后续重绘不再抢滚动位置）
  if (promoFocusMine) {
    promoFocusMine = false;
    const mineEl = $('promoMine');
    if (mineEl) setTimeout(() => mineEl.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
  }
}

// ---------- 「看效果」：投出去了，带用户亲眼确认广告真的在跑 ----------
// 详情位的广告只出现在别人的作品详情页（打开自己的作品时不展示，多条广告每次随机抽一条），
// 用户自己刷半天可能碰不到，所以这里直接随机打开一件别人的作品让他看；
// 榜单位/首页第一格位置固定，直接带过去看。
async function peekRedeem(slot) {
  if (slot === 'rank') {
    navigate('/rank');
    showToast('你的横幅就在星梦榜页（PC 宽屏在右栏竖排展示，手机在页头下方）');
    return;
  }
  if (slot === 'list-first' || slot === 'mini-home-first') {
    if (location.pathname !== '/') navigate('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast(slot === 'list-first' ? '你的作品卡就在首页列表第一格' : '你的作品卡在小程序首页作品流第一格（网页上看不到，要在微信里打开小程序）');
    return;
  }
  if (slot === 'mini-rank-line') {
    showToast('这个位展示在微信小程序里（网页上看不到）；上线后打开小程序，星梦榜和发现页都能看到你那一行');
    return;
  }
  // 详情位：随机开一件别人的热门作品
  try {
    const items = (await (await fetch('/api/works?pageSize=all&sort=hot')).json()).items || [];
    const others = items.filter(w => !w.owned);
    if (!others.length) { showToast('暂时没有其他作品可以看，稍后再试'); return; }
    showToast('详情页广告每次随机展示，多打开几个别人的作品就能刷到你的');
    openWork(others[Math.floor(Math.random() * others.length)].id);
  } catch {
    showToast('加载失败，请稍后再试', undefined, 'err');
  }
}

// ---------- 「查看投放效果」：小程序位专用 ----------
// 小程序里的页面在网页上看不到（这里不是 /mini/:id 那种能直接打开的体验页），
// 就按位出一张直达对应页面的码：首页 / 酒馆 / 详情 / 星梦榜 / 发现，扫码亲眼确认。
// 弹窗懒建一次复用；码由 /api/mini/peek-qr 出，服务端按位缓存，同一位只真正调微信一次。
const MINI_PEEK_TIPS = {
  'mini-home-first': '扫开直达小程序首页：你的作品卡就在作品流第一格',
  'mini-bar': '扫开直达小程序造梦酒馆：你的卡位在页头下方、热搜板上方',
  'mini-detail': '扫开直达小程序一件作品详情页：你的一行文字在评论区上方',
  'mini-rank-line': '扫开直达小程序星梦榜：你的一行文字在分段栏下方（发现页顶部同步轮展）',
  'mini-feat-line': '扫开直达小程序发现页：你的一行文字在页面顶部（星梦榜下方同步轮展）',
  'promo-ad': '扫开直达小程序「我的」页：点亮「推广补灯」卡，看完广告 +50 盏立即到账（每天最多 3 次）',
  'ck-ad': '扫开直达小程序「我的」页：点签到卡里的「看视频领灯火」，看完立即到账'
};
let miniPeekModal = null;

// 一张码的加载过程：先摆骨架（转圈 + 一句话），图真加载完了再亮出来。
// 微信生码第一次要一两秒，对着一个白框干等会让人以为点坏了。
// raw=1 让服务端直接吐图片，浏览器能缓存，同一个位第二次打开是瞬开。
function loadPeekQr(block, key, head, again) {
  const img = block.querySelector('img');
  const cap = block.querySelector('.mpk-cap');
  const skelText = block.querySelector('.mpk-skel span:last-child');
  block.classList.remove('is-ready', 'is-err');
  skelText.textContent = again ? '重新生成中…' : '正在生成小程序码…';
  cap.classList.remove('mpk-retry');
  cap.onclick = null;
  cap.textContent = head + '小程序码生成中…';
  img.onload = () => {
    block.classList.add('is-ready');
    cap.textContent = head + (MINI_PEEK_TIPS[key] || '微信扫码直达对应页面');
  };
  img.onerror = () => {
    block.classList.add('is-err');
    skelText.textContent = '这次没出来';
    cap.textContent = '生成失败，点这里重试';
    cap.classList.add('mpk-retry');
    cap.onclick = () => loadPeekQr(block, key, head, true);
  };
  img.src = '/api/mini/peek-qr?slot=' + encodeURIComponent(key) + '&raw=1' + (again ? '&r=' + Date.now() : '');
}

function openMiniPeekQr(slot) {
  if (!miniPeekModal) {
    miniPeekModal = document.createElement('div');
    miniPeekModal.className = 'modal-mask';
    miniPeekModal.style.display = 'none';
    miniPeekModal.innerHTML = `
      <div class="modal modal-mini-peek">
        <div class="modal-head">
          <h2>查看投放效果</h2>
          <button type="button" class="close-btn" title="关闭">✕</button>
        </div>
        <div class="mpk-body">
          <div class="mpk-blocks"></div>
          <p class="mpk-tip">微信扫一扫（在微信里打开本页则长按识别），直达小程序对应页面，亲眼看看你的广告出现在哪。</p>
        </div>
      </div>`;
    document.body.appendChild(miniPeekModal);
    miniPeekModal.querySelector('.close-btn').onclick = () => hideModal(miniPeekModal);
    bindMaskClose(miniPeekModal, () => hideModal(miniPeekModal));
  }
  const blocksBox = miniPeekModal.querySelector('.mpk-blocks');
  const slots = redeemData && Array.isArray(redeemData.slots) ? redeemData.slots : [];
  const s = slots.find(x => x.key === slot);
  // 合并槽（榜单 + 发现一行文字）两处都投：出两张码，一张直达星梦榜、一张直达发现页
  const targets = slot === 'mini-rank-line'
    ? [{ key: 'mini-rank-line', label: '星梦榜页' }, { key: 'mini-feat-line', label: '发现页' }]
    : [{ key: slot, label: '' }];
  blocksBox.innerHTML = targets.map(() => `
    <div class="mpk-block">
      <div class="mpk-qr">
        <span class="mpk-skel"><span class="spin"></span><span>正在生成小程序码…</span></span>
        <img alt="小程序码" />
      </div>
      <p class="mpk-cap"></p>
    </div>`).join('');
  const blocks = Array.from(blocksBox.querySelectorAll('.mpk-block'));
  showModal(miniPeekModal);
  targets.forEach((t, i) => {
    const head = (s ? s.name + ' · ' : '') + (t.label ? t.label + '：' : '');
    loadPeekQr(blocks[i], t.key, head, false);
  });
}

// ---------- 推广补灯引导：兑换页灯火不够时弹出 ----------
// 下单差钱被服务端拒（带 promoAdUnlocked），这次差钱解锁了今天的推广补灯（单次 +50、每天最多 3 次）。
// 弹窗出一张直达小程序「我的」页的码（scene=pad，页内自动亮推广补灯卡），
// 微信内长按识别、PC 微信扫码，领完回来刷新本页就能继续下单——和登录码同一套路径，不开新链路。
// 次数与上限都归服务端（promoAd.left / total），这里只负责把「最多能补到多少」讲清楚。
let promoTopupModal = null;

function openPromoTopup(need, balance, left) {
  const needTxt = Number(need) > 0 ? `这一单要 ${need} 盏，你还有 ${balance != null ? balance : '?'} 盏` : '这一单的灯火还不够';
  const gap = (Number(need) > 0 && balance != null) ? Math.max(0, Number(need) - Number(balance)) : 0;
  if (!promoTopupModal) {
    promoTopupModal = document.createElement('div');
    promoTopupModal.className = 'modal-mask';
    promoTopupModal.style.display = 'none';
    promoTopupModal.innerHTML = `
      <div class="modal modal-mini-peek">
        <div class="modal-head">
          <h2 class="ptop-head">灯火不够？看广告每次补 50 盏</h2>
          <button type="button" class="close-btn" title="关闭">✕</button>
        </div>
        <div class="mpk-body">
          <p class="ptop-need"></p>
          <div class="mpk-block">
            <div class="mpk-qr">
              <span class="mpk-skel"><span class="spin"></span><span>正在生成小程序码…</span></span>
              <img alt="小程序码" />
            </div>
            <p class="mpk-cap"></p>
          </div>
          <p class="mpk-tip"></p>
          <p class="ptop-back">领完回来刷新本页，余额就是新数字，可以接着下单。<br />签到、分享作品、上传作品也都能攒灯火。</p>
        </div>
      </div>`;
    document.body.appendChild(promoTopupModal);
    promoTopupModal.querySelector('.close-btn').onclick = () => hideModal(promoTopupModal);
    bindMaskClose(promoTopupModal, () => hideModal(promoTopupModal));
  }
  const block = promoTopupModal.querySelector('.mpk-block');
  const tip = promoTopupModal.querySelector('.mpk-tip');
  const back = promoTopupModal.querySelector('.ptop-back');
  promoTopupModal.querySelector('.ptop-head').textContent = '灯火不够？看广告每次补 50 盏';

  // left 只有服务端真给过才用；没给（老接口 / 未登录）就按「有次数」处理，不要凭空说人领完了
  if (left === 0) {
    // 当天 3 次已经用完了：出码没用，改成直说还能怎么攒，别让人白扫一趟
    block.style.display = 'none';
    tip.textContent = '今天的 3 次推广补灯已经用完了（每天最多补 150 盏），明天在兑换页再差一次钱就能重新解锁。';
    back.innerHTML = '这一单可以先改小一点：少买几档曝光 / 点击，或换个便宜点的位置。<br />签到、分享作品、上传作品也都能攒灯火。';
    promoTopupModal.querySelector('.ptop-need').textContent = needTxt + '——广告这条今天到头了：';
    showModal(promoTopupModal);
    return;
  }

  block.style.display = '';
  tip.textContent = '微信扫一扫（在微信里打开本页则长按识别）→ 直达小程序「我的」页 → 点亮「推广补灯」卡，看完广告 +50 盏立即到账。'
    + '每天最多 3 次、最多补 150 盏，只有下单差钱那天才能领。';
  back.innerHTML = '领完回来刷新本页，余额就是新数字，可以接着下单。<br />签到、分享作品、上传作品也都能攒灯火。';
  // 缺口超过 150（3 次的上限）时直说补不满：别让人一支一支看完三支才发现还差
  const capTxt = gap > 150 ? `差 ${gap} 盏，广告最多补 150 盏，剩下的还得靠签到 / 分享 / 投稿攒。` : '用广告灯补缺口：';
  promoTopupModal.querySelector('.ptop-need').textContent = needTxt + '——' + capTxt;
  showModal(promoTopupModal);
  loadPeekQr(block, 'promo-ad', '', false);
}

// ---------- 签到卡「看广告领灯火」：出码 → 小程序里看 → 回来自动认账 ----------
// 为什么不在网页上放一个「我看完了」的按钮：激励视频只有微信里能播，网页侧的「完成」回调纯属自证，
// 谁都能伪造。所以这里只出码，认账只看服务端额度——adReward.used 真的多了一格才算看过。
// 弹窗开着时每 4 秒拉一次 /api/me/checkin（只读内存里的 share.json，很轻），
// 扫完回来看网页自己就变了，不用教用户「按 F5」。
// 和推广补灯是两笔账：那边是下单差钱才解锁的补灯（单次 +50、最多 3 次），这边是每天都有的 3 次 30/30/40。
let ckAdModal = null;
let ckAdTimer = null;
let ckAdSeen = 0;

function stopCkAdPoll() {
  if (ckAdTimer) { clearInterval(ckAdTimer); ckAdTimer = null; }
}

function closeCkAdModal() {
  stopCkAdPoll();
  if (ckAdModal) hideModal(ckAdModal);
}

function paintCkAdState(ar) {
  const el = ckAdModal && ckAdModal.querySelector('.ckad-state');
  if (!el) return;
  const a = ar || {};
  const left = a.left == null ? null : Number(a.left);
  const sched = Array.isArray(a.schedule) ? a.schedule : [];
  const stepTxt = sched.some(v => v !== sched[0]) ? `，按 ${sched.join('/')} 递增` : '，每次 30 盏';
  el.textContent = left == null
    ? `每天 3 次${stepTxt.slice(1)}`
    : (left > 0
      ? `今天还剩 ${left} 次（已领 ${Number(a.used) || 0} 次）${stepTxt}，单日最多 ${Number(a.total) || 100} 盏`
      : '今天的 3 次已经领完，明天 0 点刷新');
}

function openCheckinAdQr() {
  if (!state.user) { openAuth('login'); return; }
  const ar = (state.user.checkin && state.user.checkin.adReward) || {};
  if (ar.left != null && Number(ar.left) <= 0) { showToast('今天的 3 次看完了，明天 0 点刷新'); return; }
  if (!ckAdModal) {
    ckAdModal = document.createElement('div');
    ckAdModal.className = 'modal-mask';
    ckAdModal.style.display = 'none';
    ckAdModal.innerHTML = `
      <div class="modal modal-mini-peek">
        <div class="modal-head">
          <h2>看支广告领灯火</h2>
          <button type="button" class="close-btn" title="关闭">✕</button>
        </div>
        <div class="mpk-body">
          <p class="ckad-lead">激励视频只能在微信里播，这一步借小程序走一趟：扫码直达「我的」页，点那张「看视频领灯火」，看完立刻到账。</p>
          <div class="mpk-block">
            <div class="mpk-qr">
              <span class="mpk-skel"><span class="spin"></span><span>正在生成小程序码…</span></span>
              <img alt="小程序码" />
            </div>
            <p class="mpk-cap"></p>
          </div>
          <p class="mpk-tip">微信扫一扫（在微信里打开本页则长按识别）。看完不用截图、也不用回来点按钮——这个窗口开着就会自己认账，余额和「还剩几次」一起变。</p>
          <p class="ckad-state"></p>
        </div>
      </div>`;
    document.body.appendChild(ckAdModal);
    ckAdModal.querySelector('.close-btn').onclick = closeCkAdModal;
    bindMaskClose(ckAdModal, closeCkAdModal);
  }
  paintCkAdState(ar);
  showModal(ckAdModal);
  loadPeekQr(ckAdModal.querySelector('.mpk-block'), 'ck-ad', '', false);
  // 起点是「现在已用几次」，只认变大（跨天 / 多设备都安全）
  ckAdSeen = Number(ar.used || 0);
  stopCkAdPoll();
  ckAdTimer = setInterval(ckAdPoll, 4000);
}

function ckAdPoll() {
  if (!state.user || !ckAdModal || ckAdModal.style.display === 'none') { stopCkAdPoll(); return; }
  fetch('/api/me/checkin', { headers: { 'Cache-Control': 'no-cache' } })
    .then(r => r.json())
    .then(d => {
      const a = d && d.adReward;
      if (!a) return;
      const used = Number(a.used) || 0;
      if (used <= ckAdSeen) { paintCkAdState(a); return; }   // 顺带把冷启动时拿到旧额度的情况纠正过来
      // 递增档（30/30/40）下「次数 × 单价」不再成立：按档位把这一段实实在在加出来
      const sched = Array.isArray(a.schedule) ? a.schedule : [30, 30, 40];
      const gained = sched.slice(ckAdSeen, used).reduce((s, v) => s + (Number(v) || 0), 0);
      ckAdSeen = used;
      state.user.checkin = Object.assign({}, state.user.checkin, d);
      if (typeof d.points === 'number') state.user.points = d.points;
      renderAuthBox();          // 顶部灯火数当场变
      refreshCkAdBlock(d);      // 签到卡里的「还剩几次」跟着变
      paintCkAdState(a);
      showToast(`+${gained} 盏灯火到账 · 今天还能看 ${Number(a.left) || 0} 次`, undefined, 'ok');
      if (!Number(a.left)) stopCkAdPoll();
    })
    .catch(() => { /* 网络抖一下不打断，下一轮再试 */ });
}

// ---------- 从推荐弹窗引导分享：选作品 → 出分享卡片 ----------
// 分享卡片需要作品完整信息（图/简介/作者），列表里只有 id/标题/缩略图，选中后按 id 拉详情
async function shareWorkDirect(id) {
  try {
    const w = await (await fetch('/api/works/' + encodeURIComponent(id) + '?nopv=1')).json();
    if (w.error) { showToast(w.error, undefined, 'err'); return; }
    if (window.ShareCard) window.ShareCard.open(w);
    else showToast('分享卡片加载中，稍后再试');
  } catch {
    showToast('分享卡片生成失败，请重试', undefined, 'err');
  }
}

function openSharePick() {
  const works = redeemData && Array.isArray(redeemData.works) ? redeemData.works : [];
  if (!works.length) { showToast('先提交一件作品，上线后就能分享啦'); return; }
  if (works.length === 1) { shareWorkDirect(works[0].id); return; }
  const modal = $('sharePickModal');
  const body = $('sharePickBody');
  body.innerHTML = works.map(w => `
    <button type="button" class="spp-item" data-spid="${escapeHtml(w.id)}">
      ${w.thumb ? `<img src="${escapeHtml(w.thumb)}" alt="" loading="lazy" />` : '<span class="rw-noimg">无图</span>'}
      <span class="spp-name">${escapeHtml(w.title)}</span>
      <span class="spp-go">生成分享图 ›</span>
    </button>`).join('');
  body.querySelectorAll('[data-spid]').forEach(el => {
    el.onclick = () => { hideModal(modal); shareWorkDirect(el.dataset.spid); };
  });
  $('closeSharePick').onclick = () => hideModal(modal);
  bindMaskClose(modal, () => hideModal(modal));
  showModal(modal);
}

// 「刚发布就买首页第一格」的确认弹窗：首页默认按最新排，这件作品本来就占着置顶之后的第一张卡，
// 这个位置放的正是同一块屏——买它多出来的主要是「推荐」角标，不是位置。
// 不硬拦：灯火是作者自己的，所以留一个「仍然要投」的出口，点它带 ackFresh 重新下单。
let freshPending = null;
function openFreshWarn(info, btn) {
  const m = $('freshModal');
  if (!m) return;
  const ageH = Math.max(1, Math.round((info && info.ageHours) || 0));
  const leftH = Math.max(1, Math.ceil(((info && info.freshHours) || 0) - ((info && info.ageHours) || 0)));
  const isMini = redeemSel.slot === 'mini-home-first';
  const where = isMini ? '小程序首页作品流' : '首页最新列表';
  const slotName = isMini ? '小程序·首页第一格' : '首页第一格';
  const txt = $('freshWarnText');
  if (txt) {
    txt.innerHTML = `
      <p>这件作品刚发布 <b>${ageH} 小时</b>，现在本来就排在${where}的第一屏（置顶作品之后的第一张就是它）。</p>
      <p>「${slotName}」放的正好是同一个位置：花灯火买它，多出来的主要是一张「推荐」角标，位置并没有多。</p>
      <div class="fresh-tip">更划算的做法：先把灯火花在<b>详情页</b>或<b>榜单页顶部</b>——那是新作品自己到不了的地方；等 <b>${leftH} 小时</b>后再回来买第一格，那时它已经被后来的作品顶下去，买的才是真位置。</div>`;
  }
  freshPending = { btn, info };
  $('closeFresh').onclick = () => hideModal(m);
  bindMaskClose(m, () => hideModal(m));
  // 先投详情页：只切位置、不替用户下单，套餐和价钱都留在面板上让他自己确认
  $('freshGoOther').onclick = () => {
    hideModal(m);
    freshPending = null;
    redeemSel.slot = 'detail';
    redeemSel.ext = false;
    redeemSel.link = '';
    renderRedeem();
    showToast('已切到「作品详情页」：新作品自己到不了那儿，这盏灯火花得不重复', undefined, 'ok');
  };
  $('freshGoAnyway').onclick = () => {
    hideModal(m);
    const p = freshPending;
    freshPending = null;
    if (!p || !p.btn || !p.btn.isConnected) return;
    submitRedeem(p.btn, { ackFresh: true });   // 用户自己决定要买：带 ackFresh 放行
  };
  showModal(m);
}

async function submitRedeem(btn, opts) {
  // 小程序位还在审核：位置能看、能预览，但点了只提示，绝不扣灯火、不生成订单
  const curCfg = curSlotCfg();
  if (curCfg && curCfg.onSale === false) {
    showToast(curCfg.pendingNote || '小程序内测中，暂未开放');
    return;
  }
  normalizeRedeemSel();   // 下单前再归一一次：绕过界面改状态也拿不到「曝光包 + 外链」这种组合
  if (!redeemSel.workId) { showToast('先选一件作品', undefined, 'err'); return; }
  const w = curRedeemWork();
  // 外链去向：传面板上选中的那个登记地址（服务端会再核一遍，不是登记地址直接拒单）
  const link = redeemSel.ext ? (redeemSel.link || (w && w.site) || '') : '';
  if (redeemSel.ext && !link) { showToast('这件作品还没填官网 / 下载链接，换回「作品详情页」或先去补链接', undefined, 'err'); return; }
  // 外链必须按点击买：曝光包没有点击额度，服务端会拒单，这里先拦一道给出人话
  const { views: buyViews, clicks: buyClicks } = redeemTotal();
  if (link && buyViews > 0) { showToast('跳官网 / 下载链接只能买点击包：曝光包不按点击计费，带不了外链流量', undefined, 'err'); return; }
  if (link && !buyClicks) { showToast('跳官网 / 下载链接要先选一个点击包', undefined, 'err'); return; }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '兑换中…';
  try {
    const res = await fetch('/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workId: redeemSel.workId, views: redeemSel.views, clicks: redeemSel.clicks, slot: redeemSel.slot, link,
        // 投放期限（只有两个首页第一格认这个参数）：1-7 天，不改价格；其它位服务端按兜底天数算
        days: redeemSel.days,
        // 用户在「这件作品现在就在第一屏」的弹窗里点了「仍然要投」：带上 ackFresh 才放行
        ackFresh: !!(opts && opts.ackFresh) || undefined
      })
    });
    const d = await res.json();
    // 刚发布的作品买首页第一格：服务端回 409，弹一次确认（规则在服务端，前端只负责讲人话）
    if (res.status === 409 && d.code === 'fresh') {
      openFreshWarn(d, btn);
      return;
    }
    if (!res.ok) {
      // 灯火不够：这次差钱给今天解锁了推广补灯档（服务端标记），弹引导而非干巴巴的 toast——
      // 扫码进小程序看支广告 +50 盏回来就能继续下单；当天 3 次已用完时 left=0，改讲「补不上了」
      if (d.promoAdUnlocked) { openPromoTopup(d.need, d.balance, d.promoAdLeft); }
      else { showToast(d.error || '兑换失败，请稍后重试', undefined, 'err'); }
      return;
    }
    redeemData = d;
    redeemSel.mode = 'view';   // 下一单回到第 3 步的默认值，别把上单的点击包 / 外链带过来
    redeemSel.views = (curSlotCfg().showPacks || [])[0] || 0;
    redeemSel.clicks = 0;
    redeemSel.ext = false;
    redeemSel.link = '';
    redeemSel.days = 0;   // 期限也回到默认满额，别把上单选的天数带过去
    renderRedeem();
    // 榜单页顶部是随机展示：给刚投放的作者在本机钉住自己那条，刷新即可验证生效；
    // 排队中的单子还没上线，不设置（等轮到他自动开始投放后再说）
    if (!d.queued && d.ad && d.ad.id) setMyAdPreview(d.ad, redeemSel.slot);
    showToast(d.queued
      ? `已排上队（第 ${d.queuePos || 1} 位），轮到你就自动开始投放`
      : (redeemSel.slot === 'list-first' ? '兑换成功，你的作品已经挂到首页第一格了'
        : redeemSel.slot === 'rank' ? '兑换成功，已投到星梦榜页；刷新榜单页就能看到你那条（PC 宽屏在右栏）'
        // 其余位置（含小程序四个位）用位置名拼，别让小程序位也说成「详情页推荐位」
        : `兑换成功，已投到「${((redeemData.slots || []).find(x => x.key === redeemSel.slot) || {}).name || '推荐位'}」了`), undefined, 'ok');
    loadAds();   // 立刻刷新页面上的广告位
  } catch {
    showToast('兑换失败，请检查网络后重试', undefined, 'err');
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

async function cancelRedeem(id) {
  const r = ((redeemData && redeemData.mine) || []).find(x => x.id === id);
  const back = redeemRefundOf(r);
  const queued = r && r.status === 'queued';
  const spent = r ? Math.max(0, (r.price || 0) - back) : 0;
  const usedTxt = r && !r.comp && (r.views || 0) === 0 && (r.clicks || 0) > 0
    ? `已点击 ${r.clickUsed || 0} 次`
    : `已曝光 ${r ? r.used || 0 : 0} 次${r && r.clicks ? ` · 已点击 ${r.clickUsed || 0} 次` : ''}`;
  // 站长代投单没有灯火往来，确认话术单独一套
  const msg = r && r.comp
    ? (queued ? '取消排队？\n\n这是站长代投的推荐，不涉及灯火，取消后轮到别人。' : '撤下这条推荐？\n\n这是站长代投的推荐（不消耗灯火），撤下后前台立即不再展示。')
    : (queued
    ? `取消排队？\n\n这一单还没开始投放，${back} 盏灯火会全额退回，立即到账。`
    : `撤下这条推荐？\n\n这一单花了 ${r ? r.price || 0 : 0} 盏，${usedTxt}，对应消耗 ${spent} 盏；剩下没用的部分退回 ${back} 盏灯火，立即到账。`);
  if (!confirm(msg)) return;
  try {
    const res = await fetch('/api/me/ads/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '撤下失败', undefined, 'err'); return; }
    redeemData = d;
    renderRedeem();
    showToast(d.refunded ? `已撤下，退回 ${d.refunded} 盏灯火` : '已撤下', undefined, 'ok');
    loadAds();
  } catch {
    showToast('撤下失败，请检查网络后重试', undefined, 'err');
  }
}

// ---------- 活动兑换码：输入码领灯火 ----------
// 头部的灯火徽章、下拉菜单里的余额、推荐面板的余额卡，三处显示的都是同一个数，一起刷
function syncPointsBadge(points) {
  const chip = document.querySelector('.checkin-entry .ck-pts');
  if (chip) chip.innerHTML = `<span class="ico">${ic('lamp')}</span>${points}`;
  const udPts = document.querySelector('#pointsBtn .ud-pts');
  if (udPts) udPts.textContent = points;
  const pc = $('pointsCard');
  if (pc && pc.querySelector('b')) pc.querySelector('b').textContent = points;
}

// 兑换成功后就地刷新头部灯火徽章、推荐面板的余额卡，并提示到账金额
function refreshPointsUI(points) {
  if (state.user) state.user.points = points;
  syncPointsBadge(points);
}

function openGiftCode() {
  if (!state.user) { openAuth('login'); return; }
  const m = $('giftModal');
  if (!m) return;
  const msg = $('giftMsg');
  msg.style.display = 'none';
  msg.className = 'gift-msg';
  $('giftCodeInput').value = '';
  $('closeGift').onclick = () => hideModal(m);
  bindMaskClose(m, () => hideModal(m));
  $('giftCodeBtn').onclick = submitGiftCode;
  $('giftCodeInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submitGiftCode(); } };
  showModal(m);
  setTimeout(() => $('giftCodeInput').focus(), 60);
}

async function submitGiftCode() {
  const input = $('giftCodeInput');
  const btn = $('giftCodeBtn');
  const msg = $('giftMsg');
  const code = input.value.trim();
  if (!code) {
    msg.style.display = 'block';
    msg.className = 'gift-msg bad';
    msg.textContent = '先填兑换码再点兑换';
    return;
  }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '兑换中…';
  try {
    const r = await fetch('/api/gift/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '兑换失败，稍后再试');
    msg.style.display = 'block';
    msg.className = 'gift-msg ok';
    msg.innerHTML = `兑换成功，<b>+${d.reward}</b> 盏灯火已到账 · 当前余额 <b>${d.points}</b> 盏`;
    input.value = '';
    refreshPointsUI(d.points);
    showToast(`兑换成功 +${d.reward} 盏灯火`, undefined, 'ok');
  } catch (err) {
    msg.style.display = 'block';
    msg.className = 'gift-msg bad';
    msg.textContent = err.message || '兑换失败，稍后再试';
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- 作者数据看板 ----------
// 只看自己的作品（发布 + 认领后归属自己的）：累计数据 + 近 14 天浏览趋势
// days 一起带上：行内小趋势图悬停/点按要显示「哪一天、多少次」，没有日期就只报数值
function statsSparkline(values, days, w = 88, h = 24) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) =>
    `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`).join(' ');
  const dayLabels = (days || []).map(k => k.slice(5).replace('-', '/')).join(',');
  return `<span class="sw-spark-wrap" data-vals="${values.join(',')}"${dayLabels ? ` data-days="${dayLabels}"` : ''}>
    <svg class="sw-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linejoin="round" stroke-linecap="round" /></svg></span>`;
}

// 行内小趋势图的数值提示：和顶部大图同款交互——桌面悬停、手机点一下，
// 点它本身不再触发整行跳作品详情（点行其他空白处仍然跳）
function bindRowSpark(body) {
  body.querySelectorAll('.sw-spark-wrap').forEach(wrap => {
    const svg = wrap.querySelector('svg');
    const vals = (wrap.dataset.vals || '').split(',').map(Number);
    const dayLabels = (wrap.dataset.days || '').split(',');
    const n = vals.length;
    if (!svg || !n) return;
    const tip = document.createElement('div');
    tip.className = 'sw-spark-tip';
    wrap.appendChild(tip);
    let pinTimer = 0;

    const show = idx => {
      const v = vals[idx] || 0;
      const label = dayLabels[idx] || '';
      tip.innerHTML = `<b>${v}</b> 次浏览${label ? `<i>${escapeHtml(label)}</i>` : ''}`;
      // 对齐到折线上的第 idx 个点（statsSparkline 的坐标算法：w=88, h=24）
      // 贴弹窗右缘时往里收：按整个内容区钳制，别让日期被弹窗边裁掉
      const wRect = wrap.getBoundingClientRect();
      const host = wrap.closest('#statsBody');
      const hRect = host ? host.getBoundingClientRect() : wRect;
      const offX = wRect.left - hRect.left;
      const x = n > 1 ? (idx / (n - 1)) * wRect.width : wRect.width / 2;
      const half = tip.offsetWidth / 2 + 2;
      const absX = Math.min(Math.max(offX + x, half), Math.max(half, hRect.width - half));
      tip.style.left = (absX - offX) + 'px';
      tip.style.top = -26 + 'px';
      tip.classList.add('is-on');
      // 高亮当前点：画个小圆点钉在折线上
      let dot = svg.querySelector('.sw-spark-dot');
      if (!dot) {
        dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'sw-spark-dot');
        dot.setAttribute('r', '2.6');
        svg.appendChild(dot);
      }
      const max = Math.max(...vals, 1);
      const vb = svg.viewBox.baseVal;
      const step = n > 1 ? vb.width / (n - 1) : vb.width;
      dot.setAttribute('cx', (idx * step).toFixed(1));
      dot.setAttribute('cy', (vb.height - (v / max) * (vb.height - 3) - 1.5).toFixed(1));
    };
    const hide = () => {
      tip.classList.remove('is-on');
      const dot = svg.querySelector('.sw-spark-dot');
      if (dot) dot.remove();
    };

    svg.addEventListener('mousemove', e => {
      const r = svg.getBoundingClientRect();
      const ratio = r.width ? (e.clientX - r.left) / r.width : 0;
      show(Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))));
    });
    svg.addEventListener('mouseleave', () => { clearTimeout(pinTimer); hide(); });
    // 手机上没法悬停：点一下出数并停 2.6 秒；拦住冒泡，别把整行点进作品详情
    svg.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const ratio = r.width ? (e.clientX - r.left) / r.width : 0;
      show(Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))));
      clearTimeout(pinTimer);
      pinTimer = setTimeout(hide, 2600);
    });
  });
}

// 趋势图的数值提示：原生 title 要悬停 1 秒才弹、手机点不出来，改成自绘气泡
function bindStatsBars(body) {
  const chart = body.querySelector('.stats-chart');
  const barsBox = body.querySelector('.stats-bars');
  if (!chart || !barsBox) return;
  const tip = document.createElement('div');
  tip.className = 'stats-bar-tip';
  chart.appendChild(tip);
  let pinTimer = 0;

  const show = wrap => {
    const bar = wrap.querySelector('.stats-bar');
    if (!bar) return;
    const v = Number(wrap.dataset.val) || 0;
    const cRect = chart.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    const bRect = bar.getBoundingClientRect();
    tip.innerHTML = `<b>${v}</b> 次浏览<i>${wrap.dataset.day}</i>`;
    // 水平对齐柱子中心；贴边时往回收，别被弹窗裁掉（按气泡实际宽度算，日期长的时候也不会出界）
    const half = tip.offsetWidth / 2 + 2;
    const left = Math.min(Math.max(wRect.left + wRect.width / 2 - cRect.left, half), Math.max(half, cRect.width - half));
    tip.style.left = left + 'px';
    // 停在柱顶上方；最高的那根会顶到标题行，钳在 0 也不出界
    tip.style.top = Math.max(0, bRect.top - cRect.top - 30) + 'px';
    tip.classList.add('is-on');
    barsBox.classList.add('is-focused');
    // 相邻柱子切换时先摘掉上一根的 highlight，不然会同时亮两根
    body.querySelectorAll('.stats-bar-wrap.is-hot').forEach(el => { if (el !== wrap) el.classList.remove('is-hot'); });
    wrap.classList.add('is-hot');
  };
  const hide = () => {
    tip.classList.remove('is-on');
    barsBox.classList.remove('is-focused');
    body.querySelectorAll('.stats-bar-wrap.is-hot').forEach(el => el.classList.remove('is-hot'));
  };

  body.querySelectorAll('.stats-bar-wrap').forEach(wrap => {
    wrap.addEventListener('mouseenter', () => { clearTimeout(pinTimer); show(wrap); });
    wrap.addEventListener('focus', () => show(wrap));
    wrap.addEventListener('blur', hide);
    // 手机上没法悬停：点一下出数，2.6 秒后自己收
    wrap.addEventListener('click', e => {
      e.stopPropagation();
      show(wrap);
      clearTimeout(pinTimer);
      pinTimer = setTimeout(hide, 2600);
    });
  });
  barsBox.addEventListener('mouseleave', () => { clearTimeout(pinTimer); hide(); });
}

// 灯光明细：余额 + 逐笔流水。和「作品数据」无关，没作品也能看，所以单独拉接口。
// 同一「天 + 来源 + 作品」的流水合并成一行——分享访问是一次 +1，一天几十次不合并会把 60 条流水刷满，
// 反而看不出哪笔是打赏、哪笔是买推荐位（那才是用户想找的）。
function pointsLogHtml(d) {
  const pts = Number(d.points || 0);
  const log = Array.isArray(d.log) ? d.log : [];
  const head = `
    <div class="pt-head">
      <div class="pt-bal"><b>${pts}</b><span>当前可用灯火</span></div>
      <button type="button" class="pt-go" id="ptGoRedeem">用灯火换推荐位 <i>›</i></button>
    </div>`;
  if (!log.length) {
    return head + `<div class="stats-empty">
        <div class="stats-empty-icon"><span class="ico">${ic('lamp')}</span></div>
        <p>还没有灯火流水。</p>
        <p class="stats-empty-sub">每日签到、分享作品、邀请好友注册、上传作品都能攒灯火；攒到的每一笔都会记在这里。</p>
      </div>
      <p class="stats-tip">这里只记「已经到账」的灯火，到账即有站内消息提醒。</p>`;
  }
  const dayKeyOf = t => {
    const d0 = new Date(t);
    const m = String(d0.getMonth() + 1).padStart(2, '0');
    const dd = String(d0.getDate()).padStart(2, '0');
    return `${d0.getFullYear()}-${m}-${dd}`;
  };
  const todayK = dayKeyOf(Date.now());
  const yestK = dayKeyOf(Date.now() - 864e5);
  // 先按「天 + 来源 + 作品」聚合，保持流水本身的时间倒序
  const groups = new Map();
  log.forEach(e => {
    const t = Number(e.t) || 0;
    const key = `${dayKeyOf(t)}|${e.kind}|${e.work ? e.work.id : ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { day: dayKeyOf(t), kind: e.kind, work: e.work, text: e.text, n: 0, sum: 0, lastT: t };
      groups.set(key, g);
    }
    g.n += 1;
    g.sum += Number(e.points) || 0;
    if (t > g.lastT) g.lastT = t;
  });
  const rows = [...groups.values()];
  const dayLabel = k => k === todayK ? '今天' : k === yestK ? '昨天' : `${Number(k.slice(5, 7))} 月 ${Number(k.slice(8, 10))} 日`;
  const hm = t => { const d0 = new Date(t); return `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`; };
  const bodyRows = rows.map(g => {
    const amt = g.sum;
    const cls = amt >= 0 ? 'is-in' : 'is-out';
    const sign = amt > 0 ? '+' : '';
    const work = g.work
      ? `<a class="pt-work" href="/w/${encodeURIComponent(g.work.id)}" data-nav title="${escapeHtml(g.work.title)}">${escapeHtml(g.work.title)}</a>`
      : '';
    const times = g.n > 1 ? ` ×${g.n} 笔` : '';
    return `<div class="pt-row">
        <div class="pt-main">
          <span class="pt-text">${escapeHtml(g.text)}${times}</span>
          ${work ? `<span class="pt-sub">${work}</span>` : ''}
        </div>
        <div class="pt-right"><span class="pt-time">${hm(g.lastT)}</span><b class="pt-amt ${cls}">${sign}${amt}</b></div>
      </div>`;
  });
  let out = head;
  let lastDay = '';
  bodyRows.forEach((row, i) => {
    const day = rows[i].day;
    if (day !== lastDay) { out += `<div class="pt-day">${dayLabel(day)}</div>`; lastDay = day; }
    out += row;
  });
  // 合计只统计「看得见的这些笔」，说清楚口径，别让用户拿它跟余额对账
  const inSum = rows.reduce((a, g) => a + (g.sum > 0 ? g.sum : 0), 0);
  const outSum = rows.reduce((a, g) => a + (g.sum < 0 ? -g.sum : 0), 0);
  out += `<p class="stats-tip pt-tip">
      这里是最近 <b>${d.max || 60}</b> 笔流水（更早的不再保留）：进账 <b class="pt-in">${inSum}</b> 盏、花掉 <b class="pt-out">${outSum}</b> 盏——只是这段区间的合计，不等于余额。
      <br />灯火到账即生效，不用领取、也不会过期；每笔到账都有站内消息，这里是可以随时翻回去的底账。
    </p>`;
  return out;
}

// 更新 star 奖励：「我的」页 / 作品详情两处直达（2026-11-12 下拉瘦身，个人菜单入口已收编进「我的」页）。
// 原来只能「推荐弹窗 → 看分享成绩与达人榜 → 开源奖励卡」绕三层，全站路径文案还写成
// 旧文案把两个并列弹窗写成了父子路径，作者在站内完全找不到同步入口。
// 现在有自己的 mode='star' 弹窗（标题就是「GitHub star 奖励」），不再借「分享成绩与达人榜」的壳——
// 点「更新 star」却看到一堆分享数据、达人榜，用户会以为点错了入口。
async function openStarSync() {
  if (!state.user) { openAuth('login'); return; }
  const dm = document.getElementById('detailModal');
  if (dm) hideModal(dm);                        // 从作品详情点进来时先关详情，别两个弹窗叠着
  await openStats('star');                      // 打开即自动同步一次，逻辑在 mode='star' 分支里
}

// 用暗号直接认领：数据看板空状态点「认领」进来的入口。作者手里只有站长发的暗号，
// 不用先在站内翻到那件作品——填对暗号服务端自己找作品，当场归属，不用等审核。
function openClaimByCode() {
  if (!state.user) { openAuth('login'); return; }
  const form = $('claimByCodeForm');
  const modal = $('claimByCodeModal');
  if (!form || !modal) return;
  form.reset();
  showModal(modal);
  setTimeout(() => { const el = form.querySelector('input[name="code"]'); if (el) el.focus(); }, 60);
}

async function openStats(mode) {
  mode = ['data', 'promo', 'checkin', 'points', 'star'].includes(mode) ? mode : 'data';   // data = 作品数据 / promo = 分享成绩与达人榜 / checkin = 每日签到 / points = 灯光明细 / star = GitHub star 奖励
  if (!state.user) { openAuth('login'); return; }
  const body = $('statsBody');
  $('statsTitle').textContent = mode === 'promo' ? '分享成绩与达人榜'
    : mode === 'checkin' ? '每日签到'
    : mode === 'points' ? '灯光明细'
    : mode === 'star' ? 'GitHub star 奖励'
    : '作品数据';
  body.innerHTML = '<div class="stats-loading">加载中…</div>';
  $('closeStats').onclick = () => hideModal(statsModal);
  bindMaskClose(statsModal, () => hideModal(statsModal));
  showModal(statsModal);

  // 灯光明细有自己的接口：不必等 /api/me/stats 那一大坨（作品、榜单、签到全在里面）
  if (mode === 'points') {
    let pd;
    try {
      pd = await (await fetch('/api/me/points-log', { cache: 'no-store' })).json();
    } catch {
      body.innerHTML = '<div class="stats-loading">加载失败，请稍后重试</div>';
      return;
    }
    if (!Array.isArray(pd.log)) {
      body.innerHTML = '<div class="stats-loading">加载失败，请稍后重试</div>';
      return;
    }
    body.innerHTML = pointsLogHtml(pd) + `
      <button type="button" class="pt-star-hint" id="ptGoStar" title="开源作品的 GitHub star 能换灯火：star 涨了由作者点「更新 star 奖励」领取">
        <span class="ico">${ic('lock-open')}</span>
        <span><b>作品标注开源、源码在 GitHub？star 能换灯火</b>：star 涨了以后在「我的」页点「更新 star 奖励」，按 1:1 到账；掉星不扣、回升不重发，没绑 GitHub 的超过 100 star 转站长核定（绑了又是自己仓库的放宽到 500，再多也要核一次）。</span>
        <i>›</i>
      </button>
      <div class="stats-actions">
        <button type="button" class="stats-redeem" id="ptGoRedeem2">用灯火换推荐位</button>
        <button type="button" class="stats-gift-link" id="ptGoGift"><span class="ico">${ic('ticket')}</span> 有兑换码？点这里领灯火</button>
      </div>`;
    const go = () => { hideModal(statsModal); openRedeem(); };
    const g1 = $('ptGoRedeem'); if (g1) g1.onclick = go;
    const g2 = $('ptGoRedeem2'); if (g2) g2.onclick = go;
    const g3 = $('ptGoGift'); if (g3) g3.onclick = () => openGiftCode();
    const g4 = $('ptGoStar'); if (g4) g4.onclick = () => openStats('promo');
    return;
  }

  let data;
  try {
    data = await (await fetch('/api/me/stats')).json();
  } catch {
    body.innerHTML = '<div class="stats-loading">加载失败，请稍后重试</div>';
    return;
  }
  if (!Array.isArray(data.works)) {
    body.innerHTML = '<div class="stats-loading">加载失败，请稍后重试</div>';
    return;
  }
  const { totals, days, trend, works } = data;
  const share = data.share || { points: 0, visits: 0, regs: 0, rank: 0 };
  if (state.user && typeof share.points === 'number') {
    state.user.points = share.points;   // 同步头部灯火徽章 + 菜单余额
    syncPointsBadge(share.points);
  }
  const board = Array.isArray(data.board) ? data.board : [];
  const shareCards = `
      <div class="stat-card is-share"><b>${share.visits || 0}</b><span>分享带来访问</span></div>
      <div class="stat-card is-share"><b>${share.scans || 0}</b><span>扫码带来的人</span></div>
      <div class="stat-card is-share"><b>${share.regs || 0}</b><span>邀请注册</span></div>
      <div class="stat-card is-share"><b>${share.promoVisits || 0}</b><span>外宣带来来访</span></div>
      <div class="stat-card is-share" id="pointsCard"><b>${share.points || 0}</b><span>灯火余额${share.rank ? ` · 分享第 ${share.rank} 名` : ''}</span></div>`;
  // 外宣渠道看板：访问本身不发灯火（复制粘贴太容易被自己刷），但要让作者看到哪个平台真的带来了人
  const promoBy = share.promoBy || {};
  const promoTotal = share.promoVisits || 0;
  const promoNeed = share.promoMilestoneAt || 100;
  const plats = (guideData && guideData.platforms) || [];
  const promoCh = Object.keys(promoBy)
    .sort((a, b) => promoBy[b] - promoBy[a]).slice(0, 4)
    .map(k => {
      const p = plats.find(x => x.key === k);
      return escapeHtml(p ? String(p.name).split(' · ')[0] : k) + ' ' + promoBy[k];
    })
    .join(' · ');
  const promoLine = `<p class="stats-tip"><span class="ico">${ic('megaphone')}</span> 外宣包带来 <b>${promoTotal}</b> 人来访${promoCh ? `（${promoCh}）` : ''}`
    + `${share.promoRegs ? `，其中注册 ${share.promoRegs} 人` : ''}。`
    + `${share.promoMilestone ? '外宣里程碑奖励已到账' : `累计满 ${promoNeed} 人可领一次性里程碑奖励；外宣来的注册，邀请人额外 +${share.promoRegBonus || 50} 盏。`}</p>`;
  // 签到卡：7 天进度 + 一键签到（签到后原地刷新卡片和积分数字）
  const ckCard = checkinCardHtml(data.checkin || state.user.checkin || {});
  const ckBoard = checkinBoardHtml(data.checkinBoard, data.checkinRank);
  const bindCheckin = () => {
    bindCkAdBtn();   // 卡片里的「看广告领灯火」按钮（和签到按钮各管各的）
    const b = $('checkinGo');
    if (!b) return;
    b.onclick = () => doCheckin(d => {
      const card = document.querySelector('#statsBody .checkin-card');
      if (card) {
        const tmp = document.createElement('div');
        tmp.innerHTML = checkinCardHtml(d);
        card.replaceWith(tmp.firstElementChild);
        bindCheckin();
      }
      const pc = $('pointsCard');
      if (pc) pc.querySelector('b').textContent = d.points;
      // 签到后小榜原地重画：累计和名次当场变，不用关掉重开
      const cb = document.querySelector('#statsBody .ck-board');
      if (cb && Array.isArray(d.checkinBoard)) {
        const tmp = document.createElement('div');
        tmp.innerHTML = checkinBoardHtml(d.checkinBoard, d.checkinRank);
        cb.replaceWith(tmp.firstElementChild);
      }
    });
  };
  const boardHtml = board.length ? `
    <div class="stats-works-head">灯火达人榜</div>
    <p class="board-note">只统计<b>推广挣来的</b>灯火（分享访问 / 扫码 / 邀请注册 / 外宣里程碑）——系统赠送、签到、兑换码都不算，这里比的是带来多少真实的人。</p>
    <div class="board-list">
      ${board.map(b => `
        <a class="board-row${b.username === state.user.username ? ' is-me' : ''}" href="/u/${encodeURIComponent(b.uid || b.username)}" data-nav>
          <span class="board-rank${b.rank <= 3 ? ' top' : ''}">${b.rank}</span>
          <span class="board-name">${escapeHtml(b.name)}</span>
          <span class="board-num">${b.visits} 访问 · ${b.regs} 邀请</span>
          <b class="board-pts">${b.points}<i>灯火</i></b>
        </a>`).join('')}
    </div>` : '';
  // 小程序转发引导：网页里分享要复制链接 / 生成卡片 / 让别人扫码，微信里却能直接把小程序卡片转给好友，
  // 好友点开同样按「分享访问 +1 盏」入账（小程序详见 pages/detail 的 onShareAppMessage，带 ref=自己的用户 id）。
  // 放达人榜下面：刚看完「谁靠推广挣了灯火」，正好告诉他还有这条更省事的路。
  const miniShareCard = `
    <button type="button" class="mini-share-card" id="miniShareCard" title="看造梦橱窗小程序码">
      <span class="msc-ico ico">${ic('wechat')}</span>
      <span class="msc-main">
        <b>微信里转发小程序，一样计灯火</b>
        <span>在小程序里打开作品 → 点底部「分享给朋友」→ 发给好友或群（也能发朋友圈）。好友点开就算一次分享访问 <b>+1 盏</b>，和网页链接同一个账。</span>
        <i class="msc-fine">小程序里先登录自己的账号，转发才记得上是你带来的</i>
      </span>
      <span class="msc-go">看小程序码 ›</span>
    </button>`;
  // 今天的额度进度：进了递减区也要说清楚「还在计」，别让作者以为分享白做了
  const st = share.today || {};
  // 访问不设每日上限；扫码按人数去重后计分，只报今天的实数
  const todayBits = [];
  if ((st.visits || 0) > 0) todayBits.push(`<b>${st.visits}</b> 次访问`);
  if ((st.scans || 0) > 0) todayBits.push(`<b>${st.scans}</b> 个扫码的人`);
  const todayLine = todayBits.length
    ? `今日已计入 ${todayBits.join(' · ')} · <b>${st.points || 0}</b> 盏灯火${(st.regs || 0) > 0 ? `（今天已带 ${st.regs} 个注册）` : ''}`
    : '';
  const shareTip = `分享奖励：好友通过你的链接访问 +1 盏灯火，<b>扫码打开 +3 盏</b>（同一人同一作品每天只计一次，同一设备每天最多计 10 次），好友注册 +100 盏灯火，<b>访问奖励不设每日上限</b>——带来多少人就记多少盏。
      只做「同一个人不重复计」：同一 IP 对同一分享者每天最多计 3 次、同一 IP 全站每天最多 30 次、同一 IP 最多计入 2 个邀请注册；登录用户同一作品终身只计一次。换浏览器、清缓存刷不动，但真实的新读者一个都不会漏。
      ${todayLine ? `<br /><span class="share-today">${todayLine}</span>` : ''}<br />
      外宣包（V2EX / HN 等）发出去带来的访问不单独计灯火，但会按「来了多少人」累计：满 100 人一次性 +50 盏；
      外宣链接带来的注册，邀请人额外 +50 盏。`;

  // 开源作品奖励：标注开源自动 +50（一件一次）；GitHub star 由作者自己点「同步」结算。
  // 站长拍板（2026-11-07）：取消 6 小时定时自动同步，改手动；同步入口与「已同步多少」都在这张卡里。
  // withApply=false 用在没有作品的地方（空状态）：连仓库都还没有，就别先给他「同步」的按钮
  const STAR_APPLY_AUTO_MAX = 100;   // 与 server.js 的 STAR_AUTO_APPLY_MAX 保持一致
  const STAR_APPLY_VERIFIED_MAX = 500;   // 与 server.js 的 STAR_VERIFIED_AUTO_MAX 保持一致（归属已验证的单次人工线）

  const starAgo = (iso) => {
    if (!iso) return '还没同步过';
    const d = Date.now() - (Date.parse(iso) || 0);
    if (!Number.isFinite(d) || d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    return Math.floor(d / 86400e3) + ' 天前';
  };

  // 「已同步多少」：每件开源作品列出当前 star / 已结算 / 待结算 / 上次同步时间
  const loadStarStatus = async () => {
    const box = $('starStatusBox');
    if (!box) return;
    try {
      const r = await fetch('/api/star/status', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { box.innerHTML = '<span class="ob-status-empty">登录后可查看同步状态</span>'; return; }
      const list = d.works || [];
      if (!list.length) {
        box.innerHTML = '<span class="ob-status-empty">名下还没有开源作品，提交一件并填好源码地址就能同步 star</span>';
        return;
      }
      const withStars = list.filter(w => typeof w.stars === 'number');
      const totalStars = withStars.reduce((n, w) => n + w.stars, 0);
      const totalSettled = withStars.reduce((n, w) => n + w.settled, 0);
      const totalPending = withStars.reduce((n, w) => n + w.pending, 0);
      const rows = list.map(w => {
        const bits = [];
        if (typeof w.stars === 'number') bits.push(`当前 ${w.stars} star`);
        else bits.push('还没同步');
        bits.push(`已结算 ${w.settled}`);
        if (typeof w.pending === 'number' && w.pending > 0) bits.push(`待结算 ${w.pending}`);
        if (w.verified) bits.push(`归属已验证 · 单次 ${STAR_APPLY_VERIFIED_MAX} 以内免人工`);
        else if (!w.isGithub) bits.push('其他托管站 · 站长人工核对');
        else if (w.repoExists === false) bits.push('仓库链接打不开');
        else if (w.needsReview) bits.push('待站长核定');
        return `<div class="ob-status-row"><b>${escapeHtml(w.title)}</b><span>${bits.join(' · ')}</span><i>${starAgo(w.lastSyncAt)}</i></div>`;
      }).join('');
      const sumHead = withStars.length
        ? `<b>已同步 ${totalSettled} / ${totalStars} 个 star</b><span>${totalPending > 0 ? `还有 ${totalPending} 个待结算` : '全部已结算'}</span>`
        : '<b>还没同步过 star</b><span>点下面按钮同步一次，就能看到已结算多少</span>';
      box.innerHTML = `
        <div class="ob-status-sum">${sumHead}</div>
        <div class="ob-status-rows">${rows}</div>`;
    } catch {
      box.innerHTML = '<span class="ob-status-empty">同步状态加载失败，稍后再试</span>';
    }
  };

  const syncStarReward = async (btn) => {
    const old = btn.innerHTML;
    const res = $('starSyncResult');            // 只在 mode='star' 弹窗顶部有：本次结算结果就地显示，不用只靠 4 秒 toast
    btn.disabled = true;
    btn.textContent = '正在同步 star…';
    try {
      const r = await fetch('/api/star/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (res) { res.className = 'star-res is-err'; res.textContent = d.error || '同步失败，稍后再试'; }
        showToast(d.error || '同步失败，稍后再试', undefined, 'err');
        return;
      }
      const got = (d.auto || []).reduce((s, x) => s + (x.awarded || 0), 0);
      const wait = d.manual || [];
      const bits = [];
      if (got > 0) bits.push(`已到账 ${got} 盏灯火`);
      if (wait.length) bits.push(`${wait.length} 件超过 ${STAR_APPLY_AUTO_MAX} star 或归属待核对，已提交站长核定`);
      if (!bits.length) bits.push((d.skipped && d.skipped[0] && d.skipped[0].reason) || '没有新的 star 可结算');
      showToast(bits.join('，'), 4200, got > 0 ? 'ok' : undefined);
      if (res) {
        res.className = 'star-res' + (got > 0 ? '' : ' is-muted');
        res.innerHTML = got > 0
          ? `本次到账 <b>+${got}</b> 盏灯火${d.points ? ` · 当前余额 <b>${d.points}</b> 盏` : ''}${wait.length ? `<br />另有 ${wait.length} 件已提交站长核定` : ''}`
          : bits.join('，');
      }
      if (got > 0) {
        const pc = $('pointsCard');
        if (pc && d.points) pc.querySelector('b').textContent = d.points;
        if (d.points && typeof state.user === 'object') { state.user.points = d.points; syncPointsBadge(d.points); }
      }
      await loadStarStatus();   // 同步完立刻刷新「已同步多少」
    } catch {
      if (res) { res.className = 'star-res is-err'; res.textContent = '网络不给力，稍后再试'; }
      showToast('网络不给力，稍后再试', undefined, 'err');
    } finally {
      btn.innerHTML = old;
      btn.disabled = false;
    }
  };

  const osBonusCard = (opts = {}) => `
    <div class="os-bonus">
      <div class="ob-head"><span class="ico">${ic('lock-open')}</span> 开源作品奖励</div>
      ${opts.compact ? `<p>star 涨了点下面的按钮同步（<b>同一件作品每天一次</b>），<b>按还没结算的部分 1:1 发灯火</b>；掉星不扣、回升不重发，同一仓库每天最多 2000 盏。超过 ${STAR_APPLY_AUTO_MAX} star（绑定 GitHub 且仓库在自己名下放宽到 ${STAR_APPLY_VERIFIED_MAX}）转站长核定。</p>` : `
      <p><b>标注「开源」自动送 50 盏</b>：一件作品一次，同一个源码仓库只认第一次。灯火能直接拿去「推荐」换个推荐位。</p>
      <p><b>GitHub star 自己同步、自己领。</b>star 涨了以后点下面的「同步 GitHub star 奖励」，系统按还没结算的部分 1:1 发灯火；<b>掉星不扣、回升不重发</b>，<b>同一件作品每天只能同步一次</b>（点入口时自动同步，当天再涨的 star 第二天再领），同一仓库每天最多 2000 盏。没绑 GitHub 的 ${STAR_APPLY_AUTO_MAX} star 以内当场到账、超过 ${STAR_APPLY_AUTO_MAX} 由站长核定；绑定 GitHub 且仓库在自己名下的单次放宽到 ${STAR_APPLY_VERIFIED_MAX} star，再多也转站长抽查一次——归属验证证明仓库是你的，但 star 真假还得看一眼。</p>
      <p><b>其他托管站走人工。</b>Gitee、GitLab、AtomGit 等平台读不到 star，同步后由站长人工核对发放。仓库链接打不开、或提交时归属存疑的，也会转人工核对。</p>`}
      <div class="ob-status" id="starStatusBox"><span class="ob-status-empty">读取同步状态…</span></div>
      ${opts.withApply === false ? '' : `<button type="button" class="ob-btn" id="starSyncBtn"><span class="ico">${ic('coin')}</span> 同步 GitHub star 奖励</button>`}
    </div>`;
  const osBonusHtml = osBonusCard();

  // GitHub star 奖励（「我的」页「更新 star 奖励」直达）：只讲 star 结算，不掺分享成绩和达人榜。
  // 打开即自动同步一次，结果写在顶部结果条里，明细在下面逐件列出。
  if (mode === 'star') {
    body.innerHTML = `
      <div class="star-res" id="starSyncResult">正在同步 star…</div>
      ${osBonusCard({ compact: true })}
      <div class="stats-actions">
        <button type="button" class="stats-gift-link" id="starGoPromo"><span class="ico">${ic('bars', 15)}</span> 分享成绩与达人榜</button>
        <button type="button" class="stats-gift-link" id="starGoRedeem"><span class="ico">${ic('coin')}</span> 用灯火换推荐位 →</button>
      </div>`;
    $('starGoPromo').onclick = () => openStats('promo');
    $('starGoRedeem').onclick = () => { hideModal(statsModal); openRedeem(); };
    loadStarStatus();
    const sb = $('starSyncBtn');
    if (sb) syncStarReward(sb);            // 用户点的就是「更新 star」，进来直接跑，不用再点第二次
    return;
  }

  // 每日签到弹窗（头部「签到」按钮直达）：签到卡 + 签到累计榜，攒灯火的入口都收在这里
  if (mode === 'checkin') {
    body.innerHTML = `
      ${ckCard}
      <button type="button" class="stats-gift-link" id="goPoints"><span class="ico">${ic('lamp', 15)}</span> 现在共 ${Number(state.user.points || 0)} 盏灯火 · 点这里看明细（每笔从哪来、花到哪去）</button>
      ${ckBoard}
      <div class="stats-actions">
        <button type="button" class="stats-redeem" id="goRedeem">攒够了？给自己的作品换个推荐位</button>
        <button type="button" class="stats-gift-link" id="goPromoStats"><span class="ico">${ic('bars', 15)}</span> 看分享成绩与达人榜</button>
      </div>`;
    $('goRedeem').onclick = () => { hideModal(statsModal); openRedeem(); };
    $('goPromoStats').onclick = () => openStats('promo');
    $('goPoints').onclick = () => openStats('points');
    bindCheckin();
    return;
  }

  // 分享成绩与达人榜（从「推荐」弹窗进来）：积分 + 分享成绩 + 灯火达人榜（和作品数据无关，没有作品也能看）
  if (mode === 'promo') {
    body.innerHTML = `
      <div class="stats-summary">${shareCards}</div>
      ${osBonusHtml}
      <div class="stats-actions">
        <button type="button" class="stats-redeem" id="goRedeem">用灯火换推荐位</button>
        <button type="button" class="stats-gift-link" id="goGiftCode"><span class="ico">${ic('ticket')}</span> 有兑换码？点这里领灯火</button>
      </div>
      ${boardHtml}
      ${miniShareCard}
      ${promoLine}
      <p class="stats-tip">${shareTip}</p>`;
    $('goRedeem').onclick = () => { hideModal(statsModal); openRedeem(); };
    $('goGiftCode').onclick = () => openGiftCode();
    // 卡片本身是个入口：换到小程序码弹窗（站点里唯一那张造梦橱窗小程序码），
    // 两步弹窗不能同时开，所以先关这张再开那张，和「用灯火换推荐位」同一套做法
    const msc = $('miniShareCard');
    if (msc) {
      msc.onclick = () => {
        const m = $('miniModal');
        if (!m) return;
        hideModal(statsModal);
        showModal(m);
      };
    }
    // 手动同步 GitHub star：小额后端直接到账，大额自动转站长核定，同步后刷新卡片状态
    const starBtn = $('starSyncBtn');
    if (starBtn) starBtn.onclick = () => syncStarReward(starBtn);
    loadStarStatus();
    // 灯火余额卡本身也是个入口：想知道「这 200 盏是哪来的」，点它就翻底账
    const ptCard = $('pointsCard');
    if (ptCard) {
      ptCard.classList.add('is-click');
      ptCard.title = '看灯光明细：每笔从哪来、花到哪去';
      ptCard.onclick = () => openStats('points');
    }
    return;
  }

  // 作品数据：只放作品相关的浏览/点赞/收藏/评论
  if (!works.length) {
    body.innerHTML = `
      <div class="stats-empty">
        <div class="stats-empty-icon"><span class="ico">${ic('chart')}</span></div>
        <p>你还没有归属自己的作品。</p>
        <p class="stats-empty-sub">提交新作品，或对已收录的作品发起<button type="button" class="stats-claim-link" id="statsGoClaim">「认领」</button>，通过后这里就会显示它的浏览、点赞与收藏数据。</p>
        <button class="btn-primary" id="statsGoSubmit">＋ 去提交作品</button>
      </div>
      <div class="stats-empty-reward">${osBonusCard({ withApply: false })}</div>`;
    $('statsGoSubmit').onclick = () => { hideModal(statsModal); $('openUpload').click(); };
    $('statsGoClaim').onclick = () => { hideModal(statsModal); openClaimByCode(); };
    loadStarStatus();
    return;
  }

  const max = Math.max(...trend, 1);
  const bars = trend.map((v, i) => {
    const hPct = v ? Math.max(6, Math.round((v / max) * 100)) : 2;
    return `<div class="stats-bar-wrap" tabindex="0" data-day="${days[i]}" data-val="${v}"
        aria-label="${days[i]}：${v} 次浏览">
      <div class="stats-bar ${v ? '' : 'is-empty'}" style="height:${hPct}%"></div>
      <span class="stats-bar-x">${i % 3 === 0 || i === trend.length - 1 ? days[i].slice(5).replace('-', '/') : ''}</span>
    </div>`;
  }).join('');

  // 体验维度：浏览是「多少人看到」，访问/下载/扫码是「多少人真的去用了」。
  // 扫码是真实扫码（扫码先落到 /go/ 短链，服务器亲眼数到）；小程序码只能记「点开看/存」的意图
  const actionLine = w => {
    const a = w.actions || {};
    const parts = [];
    if (a.visit) parts.push(`访问 ${a.visit}`);
    if (a.download) parts.push(`下载 ${a.download}`);
    if (a.scan) parts.push(`扫码人数 ${a.scan}`);
    if (a.scan_intent) parts.push(`小程序码查看 ${a.scan_intent}`);
    return parts.length ? ' · ' + parts.join(' · ') : '';
  };

  // 入口构成：把 byType 拆给作者看——「官网 访问 3 · App Store 扫码 2」比光一个总数有用。
  // 键是「动作:形态」（scan:iOS / visit:官网），每个入口标清是点开的、下载的还是扫进来的；
  // 旧数据没有动作前缀，按混合口径原样展示
  const typeLine = w => {
    const bt = (w.actions && w.actions.byType) || {};
    const VERB = { visit: '访问', download: '下载', scan: '扫码人数', scan_intent: '查看' };
    const entries = Object.keys(bt).map(k => {
      const i = k.indexOf(':');
      return i < 0 ? { act: '', t: k, n: bt[k] } : { act: k.slice(0, i), t: k.slice(i + 1), n: bt[k] };
    });
    if (!entries.length) return '';
    entries.sort((a, b) => b.n - a.n);
    const parts = entries.map(e => `${escapeHtml(e.t)}${e.act ? ' ' + (VERB[e.act] || e.act) : ''} ${e.n}`);
    return `<div class="sw-types">入口构成：${parts.join(' · ')}</div>`;
  };

  const rows = works.map(w => {
    // 状态标签：站内审核（审核中/已下架）与作者进度（开发中/等上架审核）合起来给一句人话
    const chip = w.status === 'rejected' ? '<span class="sw-badge is-bad">已下架</span>'
      : w.hidden ? '<span class="sw-badge is-hidden" title="你自主下架的：别人看不到，数据保留，可在作品详情里重新上架">已下架 · 仅自己可见</span>'
      : w.status === 'pending' ? '<span class="sw-badge">审核中</span>'
      : w.stage === 'wip' ? `<span class="sw-badge is-wip">开发中${typeof w.progress === 'number' ? ' ' + w.progress + '%' : ''}</span>`
      : w.stage === 'reviewing' ? '<span class="sw-badge is-review">等上架审核</span>'
      : '';
    const reason = w.reason ? `<div class="sw-reason">下架原因：${escapeHtml(w.reason)}</div>` : '';
    return `
    <div class="stats-work" data-id="${escapeHtml(w.id)}">
      <img src="${escapeHtml(w.thumb)}" alt="" loading="lazy" />
      <div class="sw-main">
        <div class="sw-title">${escapeHtml(w.title)}${chip}</div>
        ${reason}
        <div class="sw-meta">浏览 ${w.views} · 访客 ${w.uv} · <span class="ico">${ic('heart')}</span> ${w.likes} · <span class="ico">${ic('star')}</span> ${w.favs} · <span class="ico">${ic('chat')}</span> ${w.comments}${
          actionLine(w)} · <span class="ico">${ic('link')}</span> 分享 ${w.shareVisits || 0}${w.watch ? ` · <span class="ico">${ic('bell')}</span> ${w.watch} 人催更` : ''}</div>
        ${typeLine(w)}
        <div class="sw-star" data-star-id="${escapeHtml(w.id)}" hidden></div>
      </div>
      <div class="sw-right">
        ${statsSparkline(w.trend, days)}
        <span class="sw-7d">7 天 ${w.pv7}</span>
        <div class="sw-btns">
          ${(w.status !== 'rejected' && (w.stage === 'wip' || w.stage === 'reviewing'))
            ? `<button type="button" class="sw-share sw-go" data-go="${escapeHtml(w.id)}" title="确认已经上线：转到正式列表，并通知所有催更的人">我上线了</button>`
            : ''}
          <button type="button" class="sw-share sw-edit" data-edit="${escapeHtml(w.id)}" title="改标题、简介、链接、宣传图，改完立即生效">编辑</button>
          <button type="button" class="sw-share" data-share="${escapeHtml(w.id)}" title="生成带二维码的分享卡片图片">分享</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // 顶部汇总：压成一行文字（放不下自动换行），不再占两排大卡——这排是「看一眼」的信息，不值得抢版面
  // 动作指标（访问/下载/扫码）保留绿色、意图下限灰色，和明细行 sw-meta 的口径一致；
  // 不用「·」分隔：换行时点号会孤零零落在行首，靠间距分组就够了
  const sumItem = (label, val, cls = '') =>
    `<span class="ss-item${cls ? ' ' + cls : ''}">${label} <b>${val}</b></span>`;
  const summaryLine = [
    sumItem('作品', totals.works),
    sumItem('累计浏览', totals.views),
    sumItem('点开访问', totals.visit, 'is-act'),
    sumItem('下载', totals.download, 'is-act'),
    sumItem('扫码人数', totals.scan, 'is-act'),
    ...(totals.scanIntent ? [sumItem('小程序码查看', totals.scanIntent, 'is-act is-intent')] : []),
    sumItem('近 7 天', totals.pv7),
    sumItem('点赞', totals.likes),
    sumItem('收藏', totals.favs),
    sumItem('评论', totals.comments)
  ].join('');

  // 近 7 天成绩单（账单卡）：近 7 天有新曝光才出卡——0 新增不出，免得「没人看」反过来打击续传动力。
  // 窗口是「今天往前推 6 天 ~ 今天」的滚动 7 天，不是自然周（周一起算），所以文案统一写「近 7 天」，别写「本周」。
  // 数字全部来自 /api/me/stats 的真实统计（pv7/uv7/rank7），不带任何报价或付费字样。
  const weekTop = works.filter(w => w.pv7 > 0).sort((a, b) => b.pv7 - a.pv7);
  let weekBill = '';
  if (weekTop.length) {
    const pv7sum = weekTop.reduce((s, w) => s + w.pv7, 0);
    const top = weekTop[0];
    const r7 = top.rank7 || null;
    // 超越比例：相对全站全部作品算（含近 7 天没曝光的），这样「超过 80%」才站得住
    const beat = r7 && r7.total > 1 ? Math.round(((r7.total - r7.rank) / r7.total) * 100) : 0;
    const range = `${days[days.length - 7].slice(5).replace('-', '/')} – ${days[days.length - 1].slice(5).replace('-', '/')}`;
    weekBill = `
    <div class="week-bill">
      <div class="wb-head"><span class="wb-title">近 7 天成绩单</span><span class="wb-range">${range}</span></div>
      <p class="wb-line">最近 7 天你的作品被看了 <b>${pv7sum}</b> 次${weekTop.length > 1 ? `（最热门的是下面这件）` : ''}。</p>
      <p class="wb-top">最受欢迎的是<a href="/w/${escapeHtml(top.id)}" data-nav>《${escapeHtml(top.title)}》</a>：近 7 天 <b>${top.pv7}</b> 次曝光 · <b>${top.uv7}</b> 位访客${r7 ? ` · 全站第 <b>${r7.rank}</b> / ${r7.total} 名${beat ? `，超过 <b>${beat}%</b> 的作品` : ''}` : ''}。</p>
    </div>`;
  }

  body.innerHTML = `
    <div class="stats-summary is-line">${summaryLine}</div>
    ${weekBill}
    <div class="stats-star-bar" id="dataStarBar" hidden>
      <span>开源作品的 GitHub star 按 1:1 换灯火，点一下同步你名下所有开源作品</span>
      <button type="button" class="sw-share" id="dataStarSync">更新 star 奖励</button>
    </div>
    <div class="stats-chart">
      <div class="stats-chart-head">近 14 天浏览趋势<span class="stats-chart-hint">${
        window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches ? '点柱子看每日数值' : '悬停柱子看每日数值'}</span></div>
      <div class="stats-bars">${bars}</div>
    </div>
    <div class="stats-works-head">作品明细</div>
    <div class="stats-works">${rows}</div>
    <p class="stats-tip">
      数据统计包含弹窗与独立页面两种浏览方式；「访客」按登录账号 / IP 去重。<br />
      签到和分享成绩在顶部「签到」按钮与「推荐」弹窗里。
    </p>
    <p class="stats-tip stats-act-tip">
      <b>浏览</b>是「多少人看到」，<b>点开访问 / 下载 / 扫码人数</b>是「多少人真的去用了」——都按真实动作计数，自己点自己的不算。<br />
      <b>扫码人数</b>：详情页的二维码是站内短链码，扫码会先经过我们服务器再跳转；同一台设备 / 同一网络对同一作品一天只算 1 个人，所以这是「多少人扫过」，不是「扫了多少次」（早期数据按次数统计，之后按人数）。<br />
      <b>小程序码查看</b>：小程序码由作者上传，扫码发生在微信里、网页看不到，只能统计「点了放大 / 保存二维码」的人，是真实扫码数的<b>下限</b>，别和访问数直接对比。
    </p>
    <p class="stats-tip stats-promo-tip">
      作品想被更多人看到？<a href="/guide" class="stats-promo-link">看外宣指南 →</a>
      8 个适合发新品的地方，每个都配好了现成文案；也可以打开作品详情页点「外宣包」一键生成。
    </p>`;

  bindStatsBars(body);
  bindRowSpark(body);

  // 作品明细：每行开源作品显示自己的 star 账；「更新 star 奖励」只放一个。
  // 后端 /api/star/sync 是按人全量结算（一次跑完名下所有开源作品），逐行放按钮会让人
  // 误以为只同步那一件，而且逐件点很快撞上「一小时 6 次」限流，所以按钮收在顶部一处。
  (async () => {
    let list = [];
    try {
      const r = await fetch('/api/star/status', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && Array.isArray(d.works)) list = d.works;
    } catch { return; }
    const bar = $('dataStarBar');
    if (bar && list.length) bar.hidden = false;      // 没有开源作品就不占版面
    const btn = $('dataStarSync');
    if (btn) btn.onclick = () => openStarSync();
    const slots = [...body.querySelectorAll('.sw-star')];
    for (const s of list) {
      const el = slots.find(x => x.dataset.starId === String(s.id));
      if (!el) continue;
      const bits = [];
      bits.push(typeof s.stars === 'number' ? `★ ${s.stars} star` : '还没同步过 star');
      bits.push(`已结算 ${s.settled}`);
      if (typeof s.pending === 'number' && s.pending > 0) bits.push(`待结算 ${s.pending}`);
      if (!s.isGithub) bits.push('其他托管站 · 人工核对');
      else if (s.repoExists === false) bits.push('仓库链接打不开');
      else if (s.needsReview) bits.push('待站长核定');
      el.textContent = bits.join(' · ');
      el.hidden = false;
    }
  })();

  body.querySelectorAll('.sw-share[data-share]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const id = btn.dataset.share;
      // 和详情弹窗的「分享卡片」一样：拉取作品完整信息后现场生成分享图片
      try {
        btn.disabled = true;
        const w = await (await fetch('/api/works/' + encodeURIComponent(id) + '?nopv=1')).json();
        if (w.error) { showToast(w.error, undefined, 'err'); return; }
        if (window.ShareCard) window.ShareCard.open(w);
        else showToast('分享卡片加载中，稍后再试');
      } catch {
        showToast('分享卡片生成失败，请重试', undefined, 'err');
      } finally {
        btn.disabled = false;
      }
    };
  });
  // 作品明细里的「编辑」：直接打开投稿表单并回填（不用先回列表页翻详情）
  // 走 /api/me/works/:id —— 待审 / 已下架的作品在公开详情接口是 404，作者本人也得能改
  body.querySelectorAll('.sw-edit').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const id = btn.dataset.edit;
      if (!editWorkFn) { showToast('编辑器还没准备好，刷新页面再试'); return; }
      btn.disabled = true;
      try {
        const w = await (await fetch('/api/me/works/' + encodeURIComponent(id))).json();
        if (w.error) { showToast(w.error, undefined, 'err'); return; }
        hideModal(statsModal);
        editWorkFn(w);
      } catch {
        showToast('打开编辑器失败，请重试', undefined, 'err');
      } finally {
        btn.disabled = false;
      }
    };
  });
  body.querySelectorAll('.sw-go').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        const r = await fetch('/api/works/' + encodeURIComponent(btn.dataset.go) + '/stage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'live', note: '作者确认已上线' })
        });
        const d = await r.json();
        if (!r.ok) { showToast(d.error || '还不能上线，先补上作品链接', undefined, 'err'); return; }
        showToast('已上线，催更的人已收到通知', undefined, 'ok');
        upcomingSig = '';
        openStats('data');   // 重刷「作品数据」，状态标签跟着变
      } catch { showToast('操作失败，请稍后重试', undefined, 'err'); }
      finally { btn.disabled = false; }
    };
  });
  body.querySelectorAll('.stats-work').forEach(row => {
    row.onclick = () => {
      hideModal(statsModal);
      openWork(row.dataset.id);
    };
  });
}

let blockedTab = 'works'; // 当前停在哪个标签：works 作品 / users 作者

async function openBlockedList(tab) {
  if (!state.user) { openAuth('login'); return; }
  blockedTab = tab || blockedTab;
  const box = $('blockedList');
  const ubox = $('blockedUserList');
  $('blockedTabWorks').classList.toggle('is-on', blockedTab === 'works');
  $('blockedTabUsers').classList.toggle('is-on', blockedTab === 'users');
  $('blockedTabWorks').onclick = () => openBlockedList('works');
  $('blockedTabUsers').onclick = () => openBlockedList('users');
  box.style.display = blockedTab === 'works' ? '' : 'none';
  ubox.style.display = blockedTab === 'users' ? '' : 'none';
  $('closeBlocked').onclick = () => hideModal(blockedModal);
  bindMaskClose(blockedModal, () => hideModal(blockedModal));
  showModal(blockedModal);
  if (blockedTab === 'works') loadBlockedWorks(box); else loadBlockedUsers(ubox);
}

async function loadBlockedWorks(box) {
  box.innerHTML = '<div class="blocked-empty">加载中…</div>';
  try {
    const list = await (await fetch('/api/blocked')).json();
    if (!Array.isArray(list)) { box.innerHTML = '<div class="blocked-empty">加载失败，请稍后重试</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="blocked-empty">还没有屏蔽任何作品</div>'; return; }
    box.innerHTML = list.map(w => `
      <div class="blocked-item" data-id="${escapeHtml(w.id)}">
        <img src="${escapeHtml(w.thumb)}" alt="${escapeHtml(w.title)}" loading="lazy" />
        <div class="blocked-main">
          <div class="blocked-title">${escapeHtml(w.title)}</div>
          <div class="blocked-meta">${escapeHtml(typeText(w))} · ${escapeHtml(aname(w))}</div>
        </div>
        <button type="button" class="btn-ghost blocked-undo" data-id="${escapeHtml(w.id)}">恢复显示</button>
      </div>`).join('');
    box.querySelectorAll('.blocked-undo').forEach(btn => {
      btn.onclick = () => unblockWork(btn.dataset.id, btn);
    });
  } catch {
    box.innerHTML = '<div class="blocked-empty">加载失败，请稍后重试</div>';
  }
}

async function loadBlockedUsers(box) {
  box.innerHTML = '<div class="blocked-empty">加载中…</div>';
  try {
    const list = await (await fetch('/api/blocked-users')).json();
    if (!Array.isArray(list)) { box.innerHTML = '<div class="blocked-empty">加载失败，请稍后重试</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="blocked-empty">还没有拉黑任何作者</div>'; return; }
    box.innerHTML = list.map(u => `
      <div class="blocked-item" data-name="${escapeHtml(u.username)}">
        <span class="blocked-avatar">${ic('user', 22)}</span>
        <div class="blocked-main">
          <div class="blocked-title">@${escapeHtml(u.nickname)}</div>
          <div class="blocked-meta">现有 ${u.works} 件作品对你隐藏（含以后新发的）</div>
        </div>
        <button type="button" class="btn-ghost blocked-undo" data-name="${escapeHtml(u.username)}">取消拉黑</button>
      </div>`).join('');
    box.querySelectorAll('.blocked-undo').forEach(btn => {
      btn.onclick = () => unblockUser(btn.dataset.name, btn);
    });
  } catch {
    box.innerHTML = '<div class="blocked-empty">加载失败，请稍后重试</div>';
  }
}

async function unblockUser(name, btn) {
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(name)}/block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '操作失败');
    state.blockedUsers = Array.isArray(data.blockedUsers) ? data.blockedUsers : state.blockedUsers;
    renderAuthBox();
    const item = btn.closest('.blocked-item');
    if (item) item.remove();
    const box = $('blockedUserList');
    if (box && !box.querySelector('.blocked-item')) box.innerHTML = '<div class="blocked-empty">还没有拉黑任何作者</div>';
    showToast(`已取消拉黑 @${name}，TA 的作品恢复显示`, undefined, 'ok');
    if (!location.pathname.startsWith('/w/')) route();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '取消拉黑';
    showToast(err.message, undefined, 'err');
  }
}

async function unblockWork(id, btn) {
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    const res = await fetch(`/api/works/${id}/block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '操作失败');
    state.blocked = Array.isArray(data.blocked) ? data.blocked : state.blocked;
    renderAuthBox();
    const item = btn.closest('.blocked-item');
    if (item) item.remove();
    const box = $('blockedList');
    if (box && !box.querySelector('.blocked-item')) box.innerHTML = '<div class="blocked-empty">还没有屏蔽任何作品</div>';
    showToast('已恢复显示', undefined, 'ok');
    if (!location.pathname.startsWith('/w/')) route();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '恢复显示';
    showToast(err.message, undefined, 'err');
  }
}

// ---------- 顶部交互 ----------
// 我的收藏：独立页面 /favs（2026-11-12 从首页「只看收藏」过滤态收编成专属路由）。
// 收藏跟着账号走，未登录先登录。
function toggleFavorites() {
  if (!state.user) {
    openAuth('login');
    showToast('登录后可查看你的收藏');
    return;
  }
  if (location.pathname !== '/favs') navigate('/favs');
  else loadFavPage();
}

// 我的点赞：独立页面 /likes（与 /favs 同一批改造）。
// 点赞跟身份走（like-dedup），登录后跨设备同步；游客的赞只存本地，服务端不认识
function toggleLiked() {
  if (!state.user) {
    openAuth('login');
    showToast('登录后可查看你点赞的作品');
    return;
  }
  if (location.pathname !== '/likes') navigate('/likes');
  else loadLikedPage();
}

// /favs 页列表：服务端 fav=1 过滤，再按 state.favs 的收藏时间倒序重排（与原首页过滤同一口径）。
// 卡片/列表行复用首页的 cardHtml / listHtml，收藏星、分享、屏蔽等交互由 bindCards 统一接管
async function loadFavPage() {
  const g = $('favGallery'), em = $('favEmpty');
  if (!g) return;
  g.innerHTML = dmLoadHtml('正在点亮橱窗…');
  g.classList.remove('list-mode');
  em.style.display = 'none';
  try {
    let items = [];
    if (state.user) {
      const all = await (await fetch('/api/works?fav=1&pageSize=all&sort=latest', { cache: 'no-store' })).json();
      const map = new Map((all.items || []).map(w => [w.id, w]));
      items = (state.favs || []).map(id => map.get(id)).filter(Boolean);
    }
    g.innerHTML = items.map(w => state.view === 'list' ? listHtml(w) : cardHtml(w)).join('');
    g.classList.toggle('list-mode', state.view === 'list');
    bindCards(g);
    em.style.display = items.length ? 'none' : 'block';
  } catch {
    g.innerHTML = '';
    em.style.display = 'block';
    showToast('加载失败，请检查网络或服务状态', undefined, 'err');
  }
}

// /likes 页列表：服务端 liked=1 过滤 + 点赞时间倒序（like-dedup 按账号去重，like-log 供排序）
async function loadLikedPage() {
  const g = $('likeGallery'), em = $('likeEmpty');
  if (!g) return;
  g.innerHTML = dmLoadHtml('正在点亮橱窗…');
  g.classList.remove('list-mode');
  em.style.display = 'none';
  try {
    let items = [];
    if (state.user) {
      const data = await (await fetch('/api/works?liked=1&pageSize=all', { cache: 'no-store' })).json();
      items = data.items || [];
    }
    g.innerHTML = items.map(w => state.view === 'list' ? listHtml(w) : cardHtml(w)).join('');
    g.classList.toggle('list-mode', state.view === 'list');
    bindCards(g);
    em.style.display = items.length ? 'none' : 'block';
  } catch {
    g.innerHTML = '';
    em.style.display = 'block';
    showToast('加载失败，请检查网络或服务状态', undefined, 'err');
  }
}

/* ---------- 搜索下拉：最近搜索 / 在搜这些 ---------- */
const SEARCH_HIST_KEY = 'dm_search_hist';
const SEARCH_HIST_MAX = 8;

function readSearchHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(SEARCH_HIST_KEY) || '[]');
    return Array.isArray(list)
      ? list.filter(w => typeof w === 'string' && w.trim()).slice(0, SEARCH_HIST_MAX)
      : [];
  } catch { return []; }
}

function writeSearchHistory(list) {
  try { localStorage.setItem(SEARCH_HIST_KEY, JSON.stringify(list.slice(0, SEARCH_HIST_MAX))); } catch { /* 隐私模式下存不了，不影响搜索 */ }
}

function pushSearchHistory(word) {
  const w = String(word || '').trim();
  if (!w) return;
  const list = readSearchHistory().filter(x => x !== w);
  list.unshift(w);
  writeSearchHistory(list);
}

// 热词用站点真实分类（按作品数排序），不是拍脑袋编的词，点进去一定有内容
function hotSearchWords() {
  const cats = CATEGORIES.filter(c => c && c !== '全部');
  const ranked = cats.slice().sort((a, b) => (catCounts[b] || 0) - (catCounts[a] || 0));
  const out = ranked.filter(c => (catCounts[c] || 0) > 0).slice(0, 7);
  return out.length ? out : (cats.length ? cats.slice(0, 7) : ['效率工具', '内容创作', '开发工具']);
}

// 搜索 = 一次全局查询：顺手把场景/形态/分类/开源/时间筛选复位。
// 不复位的话，上次筛着「学习教育」再搜「小程序」会得到 0 条——看着像搜不到，其实是被筛选挡住了。
function resetListFilters() {
  state.scene = '全部';
  state.category = '全部';
  state.type = '全部';
  state.openSource = '全部';
  state.range = '全部';
  renderFilters();
}

function applySearch(word) {
  const q = String(word || '').trim();
  state.q = q;
  // 搜索词同步回头部输入框：从酒馆热搜榜等外部入口发起的搜索不走输入框，
  // 不补这一下的话结果页搜着「多少度」、点开搜索层框里却是空的（手机端尤其明显）
  const searchInp = $('searchInput');
  if (searchInp && searchInp.value.trim() !== q) searchInp.value = q;
  if (q) { resetListFilters(); wanderBreakoutLatest(); }   // 搜索结果按最新排，随便逛逛不认识关键词
  if (location.pathname !== '/') navigate('/'); else loadWorks();
}

function setupSearchSuggest() {
  const input = $('searchInput');
  const panel = $('searchSuggest');
  if (!input || !panel) return;

  // placeholder 两档：平时框太窄只显示「搜索」，聚焦/展开时才给完整提示（失焦还原）
  const PH_SHORT = '搜索';
  const PH_FULL = '搜索作品、作者、关键词…';
  input.placeholder = PH_SHORT;
  input.addEventListener('focus', () => { input.placeholder = PH_FULL; });
  input.addEventListener('blur', () => { input.placeholder = PH_SHORT; });

  const chip = (word, hot) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.kw = word;
    b.className = hot ? 'sg-hot' : '';
    b.textContent = word;
    return b;
  };

  const render = () => {
    const hist = readSearchHistory();
    const histBlock = $('sgHistBlock');
    if (histBlock) histBlock.hidden = !hist.length;
    const histBox = $('sgHist');
    if (histBox) {
      histBox.textContent = '';
      hist.forEach(w => histBox.appendChild(chip(w, false)));
    }
    const hotBox = $('sgHot');
    if (hotBox) {
      hotBox.textContent = '';
      hotSearchWords().forEach(w => hotBox.appendChild(chip(w, true)));
    }
  };

  const open = () => { render(); panel.hidden = false; };
  const close = () => { panel.hidden = true; };

  // 手机端头部一行版：搜索框藏进放大镜，点开整条头部变成搜索覆盖层（页面内容不动），取消/再点收起
  const inner = input.closest('.header-inner');
  const mBtn = $('mSearchBtn');
  // 输入框里有词时覆盖层不自动收：手机端一旦收起，当前搜的词就被藏进放大镜，
  // 结果页看着搜着东西、输入框却是空的。所以点外面 / 回车 / 点词条 / Esc 都不收，
  // 收起的出口只留「取消」按钮（force）和清空文字（没词了点外面自然能收）。
  const collapseMobile = force => { if (inner && (force || !input.value.trim())) inner.classList.remove('search-open'); };
  if (inner && mBtn) {
    mBtn.addEventListener('click', () => {
      const show = !inner.classList.contains('search-open');
      inner.classList.toggle('search-open', show);
      if (show) input.focus();
      else { input.blur(); close(); }
    });
    // 手机端首页的常驻搜索胶囊：点了打开头部搜索覆盖层（跟放大镜同一个入口）
    const heroBtn = $('heroSearchBtn');
    if (heroBtn) heroBtn.addEventListener('click', () => {
      inner.classList.add('search-open');
      input.focus();
    });
    const cancel = $('searchCancel');
    if (cancel) cancel.addEventListener('click', () => {
      collapseMobile(true);  // 「取消」是带词时的唯一手动收起出口，强制收
      input.blur();
      close();
    });
    // 搜索覆盖层开着时，点它以外的地方收掉下拉、键盘，但不把这一下点透传给底下的卡片/按钮；
    // 输入框里有词时覆盖层保持展开（collapseMobile 里管），只有「取消」能带词收起
    const box = panel.closest('.search-box');
    document.addEventListener('click', e => {
      if (!inner.classList.contains('search-open')) return;
      if (box.contains(e.target) || mBtn.contains(e.target)) return;
      e.stopPropagation();
      collapseMobile();
      input.blur();
      close();
    }, true);
    // Esc 也能退出搜索覆盖层（顺便照顾平板横屏）；有词时不收，出口只留「取消」
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { collapseMobile(); input.blur(); close(); }
    });
  }

  input.addEventListener('focus', open);
  // 清空输入时把下拉叫回来，方便直接挑一个词
  input.addEventListener('input', () => {
    if (input.value.trim()) close(); else open();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      pushSearchHistory(input.value);
      close();
      input.blur();
      collapseMobile(); // 手机端：搜完收起展开的搜索行（有词时按上面的规则不收，键盘先收回去）
    }
  });

  panel.addEventListener('click', e => {
    const btn = e.target.closest('button[data-kw]');
    if (!btn) return;
    const kw = btn.dataset.kw;
    input.value = kw;
    pushSearchHistory(kw);
    close();
    collapseMobile(); // 手机端：没词才收起展开的搜索行（有词保持展开，见 collapseMobile）
    applySearch(kw);
  });

  const clearBtn = $('sgClearHist');
  if (clearBtn) clearBtn.onclick = () => { writeSearchHistory([]); render(); };

  // 点面板外关闭；失焦留 150ms，否则点击词条会先被 blur 抢走
  // （手机端收起搜索覆盖层由上面捕获阶段的处理器负责：覆盖层开着时它会 stopPropagation，
  //   根本走不到这里，所以这里不用管覆盖层）
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== input) close();
  });
  input.addEventListener('blur', () => {
    // 离开输入框视为一次搜索完成：把当前关键词记进历史（点结果、点空白都算）
    if (input.value.trim()) pushSearchHistory(input.value);
    setTimeout(() => { if (document.activeElement !== input) close(); }, 150);
  });
  window.addEventListener('hashchange', close);
}

// ---------- 找找：用一句话找作品 ----------
// 搜索框只认字面命中（搜「录音」找不到「语音转文字」），这一层把整句描述交给 /api/find：
// 服务端把话翻成检索条件，再从真实作品里本地检索。前端不参与筛选——两处各写一套打分，
// 早晚会跟搜索框不一致。
const FIND_FALLBACK_CHIPS = ['效率工具', '小程序', '开源'];
const findBotState = { open: false, busy: false };

function fbLog() { return $('fbLog'); }

function fbScrollEnd() {
  const el = fbLog();
  if (el) el.scrollTop = el.scrollHeight;
}

function fbMsg(cls, text) {
  const box = fbLog();
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'fb-msg ' + cls;
  div.textContent = text;
  box.appendChild(div);
  fbScrollEnd();
  return div;
}

function openFindBot(prefill) {
  const box = $('findBot');
  if (!box || findBotState.open) return;
  findBotState.open = true;
  box.hidden = false;
  lockScroll();
  // 手机端：从头部搜索覆盖层进来，先把覆盖层收掉，别两层叠在一起
  const inner = document.querySelector('.header-inner');
  if (inner && inner.classList.contains('search-open')) inner.classList.remove('search-open');
  const panel = $('searchSuggest');
  if (panel) panel.hidden = true;
  if (!fbLog().children.length) fbMsg('tip', '不用记作品名，说你想要什么就行');
  const inp = $('fbInput');
  if (inp) { inp.value = prefill || ''; setTimeout(() => inp.focus(), 30); }
}

function closeFindBot() {
  const box = $('findBot');
  if (!box || !findBotState.open) return;
  findBotState.open = false;
  box.hidden = true;
  unlockScroll();
}

function fbChips(words) {
  const box = fbLog();
  if (!box || !words || !words.length) return;
  const row = document.createElement('div');
  row.className = 'fb-chips';
  words.forEach(w => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.fbKw = w;
    b.textContent = w;
    row.appendChild(b);
  });
  box.appendChild(row);
  fbScrollEnd();
}

function fbRenderItems(items) {
  const box = fbLog();
  if (!box) return;
  const wrap = document.createElement('div');
  wrap.className = 'fb-items';
  wrap.innerHTML = items.map(it => {
    // title 是「名字 + 一句话」拼起来的老字段，两行都放它就会出现同一句话写两遍
    const name = it.titleName || it.title || '';
    const desc = it.titleTag || it.cardDesc || '';
    const meta = (it.categories && it.categories[0]) || (it.types && it.types[0]) || '';
    return `<a class="fb-item" href="/w/${encodeURIComponent(it.id)}">
      <img class="fb-it-img" src="${imgUrl(it.thumb, 120)}" alt="" loading="lazy" />
      <span class="fb-it-body">
        <span class="fb-it-t">${escapeHtml(name)}</span>
        ${desc ? `<span class="fb-it-d">${escapeHtml(desc)}</span>` : ''}
      </span>
      <span class="fb-it-meta">${escapeHtml(meta)}</span>
    </a>`;
  }).join('');
  box.appendChild(wrap);
  fbScrollEnd();
}

// 没真对上时给一条出口：把这句话原话带进酒馆的想法框（/bar?want=…）。
// 不许它自己编一件作品出来，那就别让人白问一趟——到了酒馆他改两个字就能发出去等认领。
function fbWishAct(q) {
  const box = fbLog();
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'fb-acts';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fb-wish-btn';
  b.dataset.fbWish = q;   // dataset 直接赋字符串，不经过 HTML 解析，原话里有引号也不会破
  b.innerHTML = ic('wish', 15) + '<span>去酒馆许个愿，等作者认领</span>';
  row.appendChild(b);
  box.appendChild(row);
  fbScrollEnd();
}

async function fbAsk(text) {
  const q = String(text || '').trim().slice(0, 100);
  if (!q || findBotState.busy) return;
  const inp = $('fbInput');
  const btn = $('fbSend');
  if (inp) inp.value = '';
  fbMsg('me', q);
  findBotState.busy = true;
  if (btn) btn.disabled = true;
  const thinking = fbMsg('tip', '翻一翻…');
  try {
    const r = await fetch('/api/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q })
    });
    const d = await r.json();
    if (thinking) thinking.remove();
    if (!r.ok) { fbMsg('bot', d.error || '找找这会儿不在，先用上面的搜索框试试'); return; }
    fbMsg('bot', d.reply || '');
    if (d.items && d.items.length) fbRenderItems(d.items);
    const chips = d.chips && d.chips.length ? d.chips : (d.empty ? FIND_FALLBACK_CHIPS : []);
    fbChips(chips);
    if (!d.solid) fbWishAct(q);
  } catch {
    if (thinking) thinking.remove();
    fbMsg('bot', '网络不太顺，再说一次试试');
  } finally {
    findBotState.busy = false;
    if (btn) btn.disabled = false;
    if (findBotState.open && inp) inp.focus();
  }
}

function setupFindBot() {
  const box = $('findBot');
  if (!box) return;
  box.querySelectorAll('[data-fb-close]').forEach(el => el.addEventListener('click', closeFindBot));
  const form = $('fbForm');
  if (form) form.addEventListener('submit', e => {
    e.preventDefault();
    fbAsk($('fbInput').value);
  });
  const log = fbLog();
  if (log) log.addEventListener('click', e => {
    const chip = e.target.closest('[data-fb-kw]');
    if (chip) { fbAsk(chip.dataset.fbKw); return; }
    const wish = e.target.closest('[data-fb-wish]');
    if (wish) {
      const w = wish.dataset.fbWish || '';
      closeFindBot();
      navigate('/bar?want=' + encodeURIComponent(w));
      return;
    }
    const item = e.target.closest('a.fb-item');
    if (!item) return;
    e.preventDefault();
    const href = item.getAttribute('href');
    closeFindBot();
    if (href) navigate(href);
  });
  // 入口：搜索下拉底部。框里已经有词就直接问，省一次输入
  const ask = $('sgAsk');
  if (ask) ask.addEventListener('click', () => {
    const seed = ($('searchInput') && $('searchInput').value.trim()) || '';
    openFindBot(seed);
    if (seed.length >= 2) fbAsk(seed);
  });
  // 入口：首页 hero 那颗「说不清叫什么？问找找」。搜索框在桌面是给「知道名字」的人用的，
  // 不知道叫什么的人第一眼看到的是 hero，得在那儿给他一条路。
  const heroFind = $('heroFindBtn');
  if (heroFind) heroFind.addEventListener('click', () => openFindBot(''));
  document.addEventListener('keydown', e => {
    if (!findBotState.open || e.key !== 'Escape') return;
    e.stopPropagation();
    closeFindBot();
  }, true);
}

function setupHeader() {
  // 首页 hero 的三个动作词：提交作品开投稿弹窗（跟右上角「＋ 提交作品」同一个入口）；
  // 投递灵感是 /bar、星梦榜是 /rank，都是带 data-nav 的普通链接不用绑；
  // 点亮灯火未登录先拉登录，已登录提示去作品卡片送灯火（别跳榜，主行动是送灯火）
  const heroSubmit = $('heroSubmitLink');
  if (heroSubmit) heroSubmit.onclick = () => $('openUpload').click();
  const heroLight = $('heroLightLink');
  if (heroLight) heroLight.onclick = () => {
    if (state.user) showToast('去作品卡片送出一盏灯火，为喜欢的创作者加油吧');
    else openAuth('login');
  };

  let timer;
  $('searchInput').addEventListener('input', e => {
    clearTimeout(timer);
    const val = e.target.value.trim();
    timer = setTimeout(() => applySearch(val), 320);
  });

  setupSearchSuggest();
  setupFindBot();

  // PC：最新 / 最热 排序切换（H5 由筛选栏的「最新」tab 承担，这个按钮在 H5 上不显示）
  // 点一下就把排序记在本机：下次打开首页还是这个排序，不用每次重新点
  document.querySelectorAll('#sortToggle .st-btn').forEach(btn => {
    btn.onclick = () => {
      state.sort = btn.dataset.sort;
      saveSort(state.sort);
      syncSortToggle();
      if (location.pathname !== '/') navigate('/'); else loadWorks();
    };
  });

  // 「我的收藏」现在在头像下拉里，入口函数见 toggleFavorites()

  // 造梦酒馆：回首页并平滑滚到造梦酒馆区块，短暂高亮提示位置
  // 展示方式切换：卡片网格 / 一行一个的列表（选择存 localStorage）
  document.querySelectorAll('#viewToggle .vt-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
    btn.onclick = () => {
      if (state.view === btn.dataset.view) return;
      state.view = btn.dataset.view;
      localStorage.setItem('dm_view', state.view);
      document.querySelectorAll('#viewToggle .vt-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      loadWorks();
    };
  });

  // 每行显示 4 / 5 个（选择存 localStorage；列数变了页大小也变，要按新页大小从头拉，
  // 否则已加载的分页偏移会重复或漏项）
  applyGalleryCols();
  document.querySelectorAll('#colsToggle .ct-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.cols) === state.cols);
    btn.onclick = () => {
      const n = Number(btn.dataset.cols);
      if (n === state.cols) return;
      state.cols = n;
      localStorage.setItem('dm_cols', String(n));
      document.querySelectorAll('#colsToggle .ct-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      applyGalleryCols();
      if (location.pathname === '/') loadWorks();
    };
  });

  // 窗口跨断点时实际列数会变（桌面 4/5 列 ↔ 平板 3 列 ↔ 手机 2 列），页大小跟着变，
  // 同样需要重载首页；只比较列数，滚动时地址栏伸缩引起的 resize 不会误触发。
  let lastCols = galleryCols(), resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const now = galleryCols();
      if (now === lastCols) return;
      lastCols = now;
      if (location.pathname === '/') loadWorks();
    }, 250);
  });

  // 随便逛逛模式：加载更多 = 再取一批（pool 换新面孔 / random 翻下一页），不走 /api/works 分页
  bindWanderClicks();
  // 「加载下一页」统一入口：手动点按钮和滚动自动触发共用。autoMoreBusy 防重入——
  // 自动触发没有点击那种天然节流，观察器可能在结果回来前连着报，必须自己上闸。
  // 随便逛逛另有 wanderBusy 闸（翻到底的收尾逻辑在它内部），这里再套一层不冲突。
  let autoMoreBusy = false;
  const loadNextPage = async () => {
    if (autoMoreBusy || !state.hasMore) return;
    autoMoreBusy = true;
    try {
      if (state.sort === 'wander' && !state.q) {
        if (wanderMode === 'random') wanderPage += 1;   // 随机翻翻按页发牌，别忘了推进页码
        await loadWanderIntoGallery(false, true);
      } else { state.page += 1; await loadWorks(false); }
    } finally { autoMoreBusy = false; }
  };
  $('loadMore').onclick = loadNextPage;
  // 滚动自动加载：滚到「加载更多」附近（提前约半屏）就开始拉下一页，不用等真踩到底。
  // 按钮保留：自动触发失败/没触发时用户仍可手动点。按钮 display:none（翻到底）时
  // 观察器不会报 isIntersecting，天然停机；追加后按钮被新内容顶出监测区，滚回来再触发。
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) loadNextPage();
    }, { rootMargin: '500px 0px' }).observe($('loadMore'));
  }

  // 榜单五个下拉（形态/周期/排序/数量/分类）共用一套开合逻辑
  [['rankTypeBtn', 'rankTypeDD', 'rankTypePanel', 'type'],
   ['rankPeriodBtn', 'rankPeriodDD', 'rankPeriodPanel', 'period'],
   ['rankByBtn', 'rankByDD', 'rankByPanel', 'by'],
   ['rankLimitBtn', 'rankLimitDD', 'rankLimitPanel', 'limit'],
   ['rankCatBtn', 'rankCatDD', 'rankCatPanel', 'cat']].forEach(([btnId, ddId, panelId, attr]) => {
    $(btnId).addEventListener('click', e => {
      e.stopPropagation();
      const dd = $(ddId);
      const wasOpen = dd.classList.contains('open');
      closeAllDD();
      if (!wasOpen) dd.classList.add('open');
    });
    $(panelId).addEventListener('click', e => {
      const t = e.target.closest('.dd-opt');
      if (!t || !t.dataset[attr]) return;
      closeAllDD();
      loadRank(t.dataset.period || null, t.dataset.by || null,
        t.dataset.limit ? Number(t.dataset.limit) : null, t.dataset.type || null,
        t.dataset.cat || null);
    });
  });

  // PC 榜单：形态 / 周期 / 排序 / 数量 四个下拉（移动端由 tab 栏承担，这套不显示）
  // 榜单规则弹窗：图例行里的按钮进出
  const rankRulesModal = $('rankRulesModal');
  $('rankRulesBtn').onclick = () => showModal(rankRulesModal);
  $('closeRankRules').onclick = () => hideModal(rankRulesModal);
  bindMaskClose(rankRulesModal, () => hideModal(rankRulesModal));

  // H5 榜单「加载更多」：只追加下一页，筛选条件不变
  const rankMoreH5 = $('rankMoreH5');
  if (rankMoreH5) rankMoreH5.onclick = () => { rankPage += 1; loadRankListH5(false); };

  // 酒馆里的作品链接统一走站内详情弹窗：openWork 会记下来源页（/bar），
  // 关详情 history.back() 回酒馆、列表和滚动位置都还在。之前这些是整页跳转 /w/xxx，
  // 详情页关掉没有来源记录，只会兜底回首页（2026-11-13 站长反馈「点错就回首页了」）。
  // 只拦普通左键：Ctrl/Cmd/Shift/Alt+点 和中键保持浏览器默认，想 new tab 的人自己来
  document.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a.br-work, a.bh-card, a.wish-status.is-done');
    if (!a) return;
    const m = (a.getAttribute('href') || '').match(/^\/w\/([A-Za-z0-9_-]+)$/);
    if (!m) return;
    e.preventDefault();
    openWork(decodeURIComponent(m[1]));
  });

  // SPA 链接拦截（只拦普通左键：Ctrl/Cmd/Shift/Alt+点 和中键保持浏览器默认，让人自己决定要不要 new tab）
  document.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[data-nav]');
    if (a && a.origin === location.origin) {
      e.preventDefault();
      navigate(a.pathname);
    }
  });

  // 浏览器后退键关闭详情：此时弹窗还开着、地址还是 /w/xxx，同样保留列表不重载
  window.addEventListener('popstate', () => {
    if (detailModal.style.display === 'flex' && !location.pathname.startsWith('/w/')) {
      skipNextListReload = true;
    }
    route();
  });
}

// ---------- 修改昵称 ----------
// 只改「显示成什么」，登录账号不变：作品归属、收藏、作者主页、作者徽章都不受影响
function setNickMsg(text, kind) {
  const el = $('nickMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'nick-msg' + (kind ? ' ' + kind : '');
}

function openNickModal() {
  if (!state.user) { openAuth('login'); return; }
  const inp = $('nickInput');
  inp.value = state.user.nickname || '';
  $('nickAccount').textContent = '@' + state.user.username;
  setNickMsg('');
  $('closeNick').onclick = () => hideModal(nickModal);
  bindMaskClose(nickModal, () => hideModal(nickModal));
  $('nickSave').onclick = () => submitNick(false);
  $('nickReset').onclick = () => submitNick(true);
  inp.onkeydown = e => { if (e.key === 'Enter') submitNick(false); };
  showModal(nickModal);
  setTimeout(() => { inp.focus(); inp.select(); }, 60);
}

async function submitNick(reset) {
  const inp = $('nickInput');
  const val = reset ? '' : inp.value.trim();
  if (!reset) {
    if (val.length < 2) return setNickMsg('昵称至少 2 个字', 'err');
    if (val === state.user.username) return submitNick(true);   // 填回账号名 = 恢复默认
    if (val === state.user.nickname) return setNickMsg('这就是你现在的昵称');
  }
  const btn = $('nickSave');
  btn.disabled = true;
  setNickMsg('保存中…');
  try {
    const r = await fetch('/api/me/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: val })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { setNickMsg(data.error || '保存失败，稍后再试', 'err'); return; }
    state.user.nickname = data.nickname || '';
    renderAuthBox();
    hideModal(nickModal);
    showToast(data.nickname ? `昵称已改成「${data.nickname}」` : '已恢复默认，显示账号名', undefined, 'ok');
    // 自己的作品署名跟着换，重新拉一次当前列表
    if (location.pathname === '/') loadWorks();
    // 在自己主页改的：作者页标题同步刷新
    if (location.pathname.startsWith('/u/')) loadAuthor(decodeURIComponent(location.pathname.slice(3)));
  } catch {
    setNickMsg('网络异常，稍后再试', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 个性地址（作者页 /u/<自定义>） ----------
// 校验规则只有一份，在服务端（slugParse）：长度/字符集/保留词/敏感词/与账号名互斥/退役地址保护期。
// 前端只做三件事——输入折小写、边打字边查重、保存后把地址栏与 state 同步。
// 「有作品才能设」前端只负责提示文案（state.user.slugEligible 来自 /api/me），
// 真正的闸门在服务端：作品可能刚好在这一刻下架，不能拿缓存里的布尔值当授权。
function setSlugMsg(text, kind) {
  const el = $('slugMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'nick-msg' + (kind ? ' ' + kind : '');
}

function slugCooldownText(nextAt) {
  const days = Math.ceil((Number(nextAt) - Date.now()) / 864e5);
  return days > 0 ? `个性地址 30 天只能改一次，还有 ${days} 天可以再改` : '';
}

let slugCheckTimer = null;
let slugCheckSeq = 0;

function openSlugModal() {
  if (!state.user) { openAuth('login'); return; }
  const inp = $('slugInput');
  const cur = state.user.slug || '';
  inp.value = cur;
  // 没设过就没有「取消」可言；设过就把它放出来（取消 = 回到 /u/账号id，旧地址仍跳转 90 天）
  $('slugClear').style.display = cur ? '' : 'none';
  const cd = slugCooldownText(state.user.slugNextAt);
  if (state.user.slugEligible) {
    setSlugMsg(cd || `当前地址：${location.host}/u/${cur || state.user.id}`);
  } else {
    setSlugMsg('发布至少 1 件已上线的作品后就能设置个性地址', 'err');
  }
  $('closeSlug').onclick = () => hideModal(slugModal);
  bindMaskClose(slugModal, () => hideModal(slugModal));
  $('slugSave').onclick = () => submitSlug(false);
  $('slugClear').onclick = () => submitSlug(true);
  inp.oninput = () => {
    // 输入阶段就规范掉：大写折小写、非法字符直接吞掉（粘贴一段网址时尤其明显）
    inp.value = inp.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    scheduleSlugCheck();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') submitSlug(false); };
  showModal(slugModal);
  setTimeout(() => { inp.focus(); inp.select(); }, 60);
}

// 查重防抖 400ms：每次按键都打接口既费流量又会让提示乱跳；
// seq 用来丢弃过期响应——打字快时后发的请求先回，旧结果不能盖掉新结果。
function scheduleSlugCheck() {
  const inp = $('slugInput');
  const val = inp.value.trim();
  clearTimeout(slugCheckTimer);
  if (!val) { setSlugMsg(`未设置，作者页还是 /u/${state.user.slug || state.user.id}`); return; }
  if (val === (state.user.slug || '')) { setSlugMsg('这就是你现在的地址'); return; }
  if (val.length < 4) { setSlugMsg('至少 4 位', 'err'); return; }
  if (!state.user.slugEligible) { setSlugMsg('发布至少 1 件已上线的作品后就能设置个性地址', 'err'); return; }
  setSlugMsg('检查中…');
  const seq = ++slugCheckSeq;
  slugCheckTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/me/slug/check?slug=' + encodeURIComponent(val), { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== slugCheckSeq) return;
      if (d.ok) setSlugMsg(`${location.host}/u/${d.slug} 可以用`, 'ok');
      else setSlugMsg(d.error || '这个地址不能用', 'err');
    } catch {
      // 网络抖动不拦人：保存时服务端还会再判一次，这里静默让用户自己点保存
      if (seq === slugCheckSeq) setSlugMsg('');
    }
  }, 400);
}

async function submitSlug(clear) {
  const inp = $('slugInput');
  const oldSlug = state.user.slug || '';
  const val = clear ? '' : inp.value.trim().toLowerCase();
  if (clear) {
    if (!oldSlug) return hideModal(slugModal);
  } else {
    if (val.length < 4) return setSlugMsg('至少 4 位', 'err');
    if (val === oldSlug) return setSlugMsg('这就是你现在的地址');
  }
  // 当前是不是停在自己的作者页（改完地址要跟着换，不然刷新一下又回旧链接）
  const ref = location.pathname.startsWith('/u/') ? decodeURIComponent(location.pathname.slice(3)) : '';
  const onMyPage = !!ref && (ref === state.user.id || ref === oldSlug || ref === state.user.username);
  const btn = $('slugSave');
  btn.disabled = true;
  setSlugMsg('保存中…');
  try {
    const r = await fetch('/api/me/slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: val })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setSlugMsg(d.error || '保存失败，稍后再试', 'err'); return; }
    state.user.slug = d.slug || '';
    state.user.slugPath = d.path || '';
    state.user.slugNextAt = d.slugNextAt || 0;
    hideModal(slugModal);
    showToast(d.slug ? `个性地址已设为 /u/${d.slug}` : '已取消个性地址，回到 /u/' + state.user.id, undefined, 'ok');
    if (onMyPage && d.path) {
      // 用 replaceState 而不是 navigate：改地址是「同一页换了门牌号」，
      // 不该在浏览器历史里留一条「按返回键回到旧地址」的坑
      history.replaceState({}, '', d.path);
      route();
    } else if (location.pathname === '/settings') {
      renderSettingsPage();
    }
  } catch {
    setSlugMsg('网络异常，稍后再试', 'err');
  } finally {
    btn.disabled = false;
  }
}


// ---------- 头像 ----------
// 三个来源都落到服务端（/uploads/av-*.webp）：上传拿文件、GitHub 由服务端回源下载、
// 微信只能在小程序里用 chooseAvatar 选（网页端没有这个能力，所以这里只给「上传」这条通用路，
// 用户想用微信头像就把那张图存下来传进来，效果一样）。
let AVA_BUSY = false;

function setAvaMsg(text, kind) {
  const el = $('avaMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'nick-msg' + (kind ? ' ' + kind : '');
}

function paintAvaPreview() {
  const u = state.user || {};
  paintAvatar($('avaPreview'), u.nickname || u.username || '', u.avatar);
  const ghBtn = $('avaGh');
  if (ghBtn) {
    // 没配 GitHub 登录的站直接藏掉；配了但没绑定就留着可点——点了给一句「先去绑定」，
    // 比一个点不动的灰按钮好懂（禁用态连 title 都弹不出来）
    ghBtn.style.display = (state.providers && state.providers.github) ? '' : 'none';
    ghBtn.disabled = false;
    ghBtn.textContent = u.avatarSrc === 'github' ? '重新取一次 GitHub 头像' : '用 GitHub 头像';
  }
  // 「恢复首字母」没有头像时无意义：直接藏掉，别摆一个灰按钮让人猜为什么点不动
  const rs = $('avaReset');
  if (rs) rs.style.display = u.avatar ? '' : 'none';
}

function openAvaModal() {
  if (!state.user) { openAuth('login'); return; }
  setAvaMsg('');
  paintAvaPreview();
  const mask = $('avaModal');
  $('closeAva').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  $('avaGh').onclick = useGithubAvatar;
  $('avaReset').onclick = resetAvatar;
  $('avaFile').onchange = onAvaFile;
  showModal(mask);
}

async function onAvaFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';   // 清掉 value：同一个文件改完再选一次也要能触发 change
  if (!f || AVA_BUSY) return;
  if (!/^image\//.test(f.type || '')) return setAvaMsg('只能选图片文件', 'err');
  if (f.size > 8 * 1024 * 1024) return setAvaMsg('图片不能超过 8MB，先压一下再传', 'err');
  const fd = new FormData();
  fd.append('avatar', f);
  await saveAvatar('/api/me/avatar', { method: 'POST', body: fd }, '上传中…', '头像已更新');
}

function useGithubAvatar() {
  if (AVA_BUSY) return;
  if (!(state.user && state.user.github)) {
    return setAvaMsg('这个账号还没绑 GitHub——关掉这里，在「GitHub 绑定」那一行绑一下就能用', 'err');
  }
  saveAvatar('/api/me/avatar/github', { method: 'POST' }, '正在从 GitHub 取头像…', '已换成 GitHub 头像');
}

function resetAvatar() {
  if (AVA_BUSY) return;
  saveAvatar('/api/me/avatar/reset', { method: 'POST' }, '恢复中…', '已恢复名字首字');
}

// 头像保存：处理中锁住三个入口（连点没意义），成功后**直接关弹窗 + toast**。
// 之前在弹窗里留一行小字「头像已更新」，站长看完的原话是「我其实并不知道我这个时候保存成功了没」——
// 预览图本来就是他刚选的那张，光靠图变不出确认感；关掉弹窗才是最无歧义的完成信号。
async function saveAvatar(url, init, pendingText, doneText) {
  AVA_BUSY = true;
  const actions = document.querySelector('.ava-actions');
  const pv = $('avaPreview');
  if (actions) actions.classList.add('is-busy');
  if (pv) pv.classList.add('is-busy');
  setAvaMsg(pendingText, 'busy');
  try {
    const r = await fetch(url, init);
    const data = await r.json().catch(() => ({}));
    // 失败就留在弹窗里：错误贴着按钮显示，人还站在原地能立刻改
    if (!r.ok) { setAvaMsg(data.error || '保存失败，稍后再试', 'err'); return; }
    state.user.avatar = data.avatar || '';
    state.user.avatarSrc = data.avatarSrc || '';
    state.user.avatarSrcLabel = data.avatarSrcLabel || '';
    paintAvaPreview();
    afterAvatarChange();
    const mask = $('avaModal');
    if (mask) hideModal(mask);
    showToast(doneText || '头像已更新', 2200, 'ok');
  } catch {
    setAvaMsg('网络异常，稍后再试', 'err');
  } finally {
    AVA_BUSY = false;
    if (actions) actions.classList.remove('is-busy');
    if (pv) pv.classList.remove('is-busy');
  }
}

// 头像变了要刷的地方：设置页那一行、我的页大图、自己的作者页
function afterAvatarChange() {
  if (location.pathname === '/settings') renderSettingsPage();
  if (location.pathname === '/me') renderMePage();
  if (location.pathname.startsWith('/u/')) {
    const who = decodeURIComponent(location.pathname.slice(3));
    if (state.user && (state.user.id === who || state.user.username === who)) {
      paintAvatar($('authorAvatar'), state.user.nickname || state.user.username, state.user.avatar);
    } else {
      loadAuthor(who);
    }
  }
}

// ---------- 修改密码 ----------
// 微信验证重设模式：绑了微信的号忘了密码，切到这个模式免旧密码直接设新的
// （服务端要求当前会话是微信登录签发且 10 分钟内，见 /api/me/password）
let PASS_WX_RESET = false;

function setPassMsg(text, kind) {
  const el = $('passMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'nick-msg' + (kind ? ' ' + kind : '');
}

function openPassModal() {
  if (!state.user) { openAuth('login'); return; }
  const noPass = state.user.passSet === false;   // OAuth 建的号：没有密码可填，直接设一个新的
  const src = state.user.wechat ? '微信' : (state.user.google ? 'Google' : 'GitHub');
  ['passCurrent', 'passNew', 'passNew2'].forEach(id => { $(id).value = ''; });
  PASS_WX_RESET = false;
  $('passCurrentLabel').style.display = noPass ? 'none' : '';
  $('passCurrent').style.display = noPass ? 'none' : '';
  // 绑了微信且已设过密码：提供「忘了密码 → 微信验证重设」入口（没设过密码的号本来就不需要旧密码）
  const canWxReset = !!(state.user.wechat && state.user.wechat.openid) && !noPass;
  $('passWxReset').style.display = canWxReset ? '' : 'none';
  $('aliasInput').style.display = '';
  $('aliasTip').style.display = '';
  document.querySelector('label[for="aliasInput"]').style.display = '';
  $('aliasInput').value = state.user.alias || '';
  $('aliasInput').disabled = !!state.user.alias && state.user.aliasNextAt > Date.now();
  $('aliasTip').textContent = state.user.alias
    ? `当前登录名：${state.user.alias}。登录时「登录名 + 密码」和「系统账号名 + 密码」都能进。`
    : '登录时「登录名 + 密码」和「系统账号名 + 密码」都能进。设一次就行，之后 30 天才能改。';
  $('passModal').querySelector('.modal-head h2').textContent = '账号与密码';
  $('passSave').textContent = '保存';
  $('passTip').textContent = noPass
    ? `你这个账号是${src}登录时自动创建的，设一个登录名和密码，换设备也能用「登录名 + 密码」进。`
    : '不想改密码就把密码两栏留空；改了密码后，其他设备会自动退出登录，当前这台设备不受影响。';
  setPassMsg('');
  $('closePass').onclick = () => hideModal($('passModal'));
  $('passCancel').onclick = () => hideModal($('passModal'));
  bindMaskClose($('passModal'), () => hideModal($('passModal')));
  // 忘了密码 → 切到微信验证重设：收起旧密码和登录名，只留新密码两栏
  $('passWxResetBtn').onclick = () => {
    PASS_WX_RESET = true;
    $('passCurrentLabel').style.display = 'none';
    $('passCurrent').style.display = 'none';
    $('passWxReset').style.display = 'none';
    $('aliasInput').style.display = 'none';
    $('aliasTip').style.display = 'none';
    document.querySelector('label[for="aliasInput"]').style.display = 'none';
    $('passTip').textContent = '正在用微信验证重设密码：刚用微信登录过（10 分钟内）就可以不输旧密码直接设新的。如果提示验证过期，退出后重新用微信扫码登录再回来即可。';
    setPassMsg('');
    $('passNew').focus();
  };
  $('passSave').onclick = submitPass;
  $('passNew2').onkeydown = e => { if (e.key === 'Enter') submitPass(); };
  showModal($('passModal'));
  setTimeout(() => $(noPass && !state.user.alias ? 'aliasInput' : (noPass ? 'passNew' : 'passCurrent')).focus(), 60);
}

async function submitPass() {
  const noPass = state.user && state.user.passSet === false;
  const wxReset = PASS_WX_RESET;   // 微信验证重设：不输旧密码、不改登录名
  const cur = $('passCurrent').value;
  const p1 = $('passNew').value;
  const p2 = $('passNew2').value;
  const alias = $('aliasInput').value.trim();
  const aliasChanged = !wxReset && alias && (!state.user.alias || alias.toLowerCase() !== String(state.user.alias).toLowerCase());
  if (aliasChanged && !NAME_OK(alias)) return setPassMsg('登录名需 2-20 位，可为中文、字母、数字、下划线', 'err');
  // 密码选填：两栏都空 = 只保存登录名；填了就按改密码校验
  const wantPass = !!(p1 || p2);
  if (!aliasChanged && !wantPass) return setPassMsg(wxReset ? '输入两遍新密码' : '没有要改的内容，填一下登录名或新密码吧', 'err');
  if (wxReset) {
    // 微信重设：身份由服务端按会话核验（微信登录签发且 10 分钟内），这里只校验新密码本身
    if (!wantPass) return setPassMsg('输入两遍新密码', 'err');
    if (p1.length < 6) return setPassMsg('新密码至少 6 位', 'err');
    if (p1.length > 64) return setPassMsg('新密码最多 64 位', 'err');
    if (p1 !== p2) return setPassMsg('两次输入的新密码不一样', 'err');
  } else if (wantPass || !noPass) {
    if (!noPass && !cur) return setPassMsg('请先输入当前密码', 'err');
    if (p1.length < 6) return setPassMsg('新密码至少 6 位', 'err');
    if (p1.length > 64) return setPassMsg('新密码最多 64 位', 'err');
    if (p1 !== p2) return setPassMsg('两次输入的新密码不一样', 'err');
    if (!noPass && p1 === cur) return setPassMsg('新密码不能和当前密码一样', 'err');
  }
  const btn = $('passSave');
  btn.disabled = true;
  setPassMsg('提交中…');
  let kicked = 0;
  try {
    if (aliasChanged) {
      const ra = await fetch('/api/me/alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, currentPassword: cur })
      });
      const da = await ra.json().catch(() => ({}));
      if (!ra.ok) { setPassMsg(da.error || '登录名保存失败，稍后再试', 'err'); return; }
      state.user.alias = da.alias || alias;
      state.user.aliasNextAt = da.aliasNextAt || 0;
    }
    if (wantPass || !noPass) {
      const r = await fetch('/api/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wxReset ? { wechatReset: true, newPassword: p1 } : { currentPassword: cur, newPassword: p1 })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setPassMsg(data.error || '修改失败，稍后再试', 'err'); return; }
      if (state.user) state.user.passSet = true;
      kicked = data.kicked || 0;
    }
    hideModal($('passModal'));
    showToast(wxReset
      ? '密码已重设，以后可用「登录名 + 密码」或账号名 + 密码登录'
      : (aliasChanged && wantPass
      ? '登录名和密码已保存，以后可用「登录名 + 密码」登录'
      : (aliasChanged ? '登录名已保存，以后可用「登录名 + 密码」登录' : (noPass
        ? '密码已设置，以后也能用账号名 + 密码登录'
        : (kicked ? `密码已修改，${kicked} 台其他设备已退出登录` : '密码已修改')))), undefined, 'ok');
  } catch {
    setPassMsg('网络异常，稍后再试', 'err');
  } finally {
    btn.disabled = false;
  }
}
// 登录名的形状校验（与服务端 NAME_RE 一致；进页面时才用，失败服务端还会兜一道）
function NAME_OK(s) { return /^[\w\u4e00-\u9fa5·]{2,20}$/.test(s); }

// ---------- 注销账号 ----------
// 双确认（账号名 + 密码）；作品可选「保留（解除归属）」或「一并删除」，成功后本机立即变游客态
let confirmedWipeWorks = false;   // 勾了「连同作品一起删除」时，需要再点一次才真正提交

function setDelAccMsg(text, kind) {
  const el = $('delAccMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'nick-msg' + (kind ? ' ' + kind : '');
}

function openDelAcc() {
  if (!state.user) { openAuth('login'); return; }
  const u = state.user;
  const noPass = u.passSet === false;   // GitHub 建号还没设密码：这一栏不显示，服务端也只校验账号名
  $('delAccName').textContent = u.username;
  $('delAccNameHint').textContent = u.username;
  $('delAccPts').textContent = Number(u.points || 0);
  $('delAccWorks').textContent = Number(u.worksCount || 0);
  $('delAccNameInput').value = '';
  $('delAccPass').value = '';
  $('delAccPass').style.display = noPass ? 'none' : '';
  $('delAccPassLabel').style.display = noPass ? 'none' : '';
  const first = document.querySelector('#delWorkChoice input[name="delWorks"][value="keep"]');
  if (first) first.checked = true;
  confirmedWipeWorks = false;
  setDelAccMsg('');
  $('delAccSubmit').disabled = false;
  document.querySelectorAll('#delWorkChoice input[name="delWorks"]').forEach(r => {
    r.onchange = () => { confirmedWipeWorks = false; setDelAccMsg(''); };
  });
  $('closeDelAcc').onclick = () => hideModal($('delAccModal'));
  $('delAccCancel').onclick = () => hideModal($('delAccModal'));
  bindMaskClose($('delAccModal'), () => hideModal($('delAccModal')));
  $('delAccSubmit').onclick = submitDelAcc;
  $('delAccNameInput').onkeydown = e => { if (e.key === 'Enter') { if (noPass) submitDelAcc(); else $('delAccPass').focus(); } };
  $('delAccPass').onkeydown = e => { if (e.key === 'Enter') submitDelAcc(); };
  showModal($('delAccModal'));
  setTimeout(() => $('delAccNameInput').focus(), 60);
}

async function submitDelAcc() {
  if (!state.user) return;
  const name = $('delAccNameInput').value.trim();
  const pass = $('delAccPass').value;
  if (!name) return setDelAccMsg('请先输入账号名确认', 'err');
  // 账号名或登录别名都行（alias 用户多半不知道自己的 wx_xxx 系统账号名）
  const nameOk = name === state.user.username
    || (state.user.alias && name.toLowerCase() === state.user.alias.toLowerCase());
  if (!nameOk) {
    return setDelAccMsg('账号名不一致，请完整输入「' + (state.user.alias || state.user.username) + '」', 'err');
  }
  if (state.user.passSet !== false && !pass) return setDelAccMsg('请输入登录密码', 'err');
  const checked = document.querySelector('#delWorkChoice input[name="delWorks"]:checked');
  const wipe = (checked && checked.value) === 'wipe';
  if (wipe && !confirmedWipeWorks) {
    // 删除作品这一步再加一道确认，避免手滑把作品全删了
    confirmedWipeWorks = true;
    setDelAccMsg('再点一次「永久注销」确认：作品和图片会一起删除，无法找回', 'err');
    return;
  }
  const btn = $('delAccSubmit');
  btn.disabled = true;
  setDelAccMsg('正在注销…');
  try {
    const r = await fetch('/api/me/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmName: name, password: pass, deleteWorks: wipe })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setDelAccMsg(d.error || '注销失败，稍后再试', 'err'); return; }
    hideModal($('delAccModal'));
    confirmedWipeWorks = false;
    state.user = null;
    state.favs = [];
    state.blocked = [];
    state.blockedUsers = [];
    state.myClaims = [];
    renderAuthBox();
    if (detailModal.style.display === 'flex') hideModal(detailModal);
    showToast(wipe && d.worksDeleted ? `账号已注销，${d.worksDeleted} 件作品已删除` : '账号已注销，感谢你来过', undefined, 'ok');
    if (location.pathname === '/') loadWorks();
  } catch {
    setDelAccMsg('网络异常，稍后再试', 'err');
  } finally {
    btn.disabled = false;
  }
}


function renderCodeButtons(w) {
  const rb = $('detailRedeem'), mb = $('detailCodes');
  if (!rb || !mb) return;
  if (w.codesTotal > 0) {
    rb.style.display = 'inline-block';
    rb.textContent = w.codesLeft > 0 ? `兑换码（剩 ${w.codesLeft}）` : '查看我领的码';
  } else {
    rb.style.display = 'none';
  }
  // 管理入口在作者管理条里：显示时撤掉 inline display，交给 .owner-btn 的 inline-flex；隐藏时仍必须 none
  mb.style.display = w.owned ? '' : 'none';
}

// ---------- 意见反馈（用户 ↔ 站长，双向对话） ----------
// 一条反馈就是一个会话：提交后站长能在这里回复，你也能接着说。
// 登录用户按账号查；游客把 {id, token} 留在本机，换不了设备但回得来。
const FB_STORE = 'dm_my_feedback';
function fbStore() {
  try { return JSON.parse(localStorage.getItem(FB_STORE) || '[]'); } catch { return []; }
}
function fbStoreAdd(rec) {
  try {
    const list = fbStore().filter(x => x.id !== rec.id);
    list.unshift(rec);
    localStorage.setItem(FB_STORE, JSON.stringify(list.slice(0, 20)));
  } catch { /* 隐私模式记不住，本次照样能用 */ }
}
function fbTokenOf(id) {
  const it = fbStore().find(x => x.id === id);
  return it ? it.token : '';
}

// 拉我的反馈：本机凭证 + 登录账号，两边合并（peek=true 只数未读，不标已读）
async function fbLoadMine(peek) {
  const local = fbStore();
  let items = [];
  let fetched = false;
  if (local.length) {
    try {
      const r = await fetch('/api/feedback/mine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: local.map(x => ({ id: x.id, token: x.token })), peek: !!peek })
      });
      if (r.ok) { items = (await r.json()).items || []; fetched = true; }
    } catch { /* 拿不到就只显示账号里的 */ }
  }
  if (state.user) {
    try {
      const d = await (await fetch('/api/me/feedback' + (peek ? '?peek=1' : ''))).json();
      const seen = new Set(items.map(x => x.id));
      (d.items || []).forEach(x => { if (!seen.has(x.id)) items.push(x); });
    } catch { /* 忽略 */ }
  }
  items.sort((a, b) => new Date(b.lastAt || b.createdAt) - new Date(a.lastAt || a.createdAt));
  // 本机凭证跟着服务端走：反馈被后台删了就把这条凭证一起清掉（只在真拉到结果时做）
  if (fetched && !peek) {
    const alive = new Set(items.map(x => x.id));
    const keep = local.filter(x => alive.has(x.id));
    if (keep.length !== local.length) { try { localStorage.setItem(FB_STORE, JSON.stringify(keep)); } catch { /* 忽略 */ } }
  }
  state.myFeedback = items;
  return items;
}

// 反馈悬浮球上的小红点：有站长回复没看就亮着（登录用户 / 本机留过反馈的游客）
async function fbRefreshDot() {
  const btn = $('feedbackBtn');
  if (!btn) return;
  // 手机端浮标已收进「我的」页宫格，红点要同步到那一格上，不然站长回复没人看见
  const syncDot = (on) => {
    btn.classList.toggle('has-new', on);
    document.querySelectorAll('.me-quick-fab[data-fab="feedbackBtn"]').forEach(t => t.classList.toggle('has-new', on));
  };
  if (!state.user && !fbStore().length) { syncDot(false); return; }
  let unread = 0;
  try {
    unread = (await fbLoadMine(true)).reduce((s, x) => s + (Number(x.unread) || 0), 0);
  } catch { return; }
  syncDot(unread > 0);
  btn.title = unread ? `有 ${unread} 条反馈回复，点开看看` : '意见反馈，帮助我们把网站做得更好';
}

function setupFeedback() {
  const modal = $('feedbackModal');
  const form = $('feedbackForm');
  if (!modal || !form) return;
  const tabForm = modal.querySelector('[data-fbtab="form"]');
  const tabMine = modal.querySelector('[data-fbtab="mine"]');
  let curId = '';   // 当前展开的反馈会话

  function hintText(preset) {
    if (preset && preset.hint) return escapeHtml(preset.hint);
    const who = state.user
      ? `当前身份：<b>@${escapeHtml(state.user.nickname || state.user.username)}</b>，站长回复会推到右上角消息里`
      : '匿名也能提；之后在「我的反馈」里能看回复、接着聊';
    return `用着不顺手、想要什么功能、发现 bug，都可以说一句。${who}`;
  }

  function setView(view) {
    tabForm.classList.toggle('is-on', view === 'form');
    tabMine.classList.toggle('is-on', view === 'mine');
    $('fbViewForm').hidden = view !== 'form';
    $('fbViewMine').hidden = view !== 'mine';
    if (view === 'mine') renderList();
  }

  function openFeedback(preset) {
    // 标题跟着入口走：招商页点「订这个位置」不该弹「意见反馈」，那样像在让人提 bug
    const t = $('fbTitle');
    if (t) t.textContent = (preset && preset.title) || '意见反馈';
    // 招商入口下「写反馈」不对味，换成「填写需求」；书架提交入口走 tabText，其余保持原样
    const tabForm1 = modal.querySelector('[data-fbtab="form"]');
    if (tabForm1) tabForm1.textContent = (preset && preset.tabText) || ((preset && preset.title) ? '填写需求' : '写反馈');
    $('feedbackHint').innerHTML = hintText(preset);
    if (preset && preset.type) {
      const sel = form.querySelector('select[name="type"]');
      // 预选类型：合作洽谈等入口带过来，找不到对应 option 就落到「合作/其他」（友链申请已独立成弹窗，不再走反馈）
      const has = Array.from(sel.options).some(o => o.value === preset.type);
      sel.value = has ? preset.type : '合作/其他';
    }
    setView('form');
    showModal(modal);
    setTimeout(() => form.content.focus(), 60);
  }
  function closeFeedback() { hideModal(modal); }

  function renderList() {
    const box = $('fbList');
    $('fbDetail').hidden = true;
    box.hidden = false;
    const items = state.myFeedback || [];
    $('fbMineDot').hidden = !items.some(x => Number(x.unread) > 0);
    if (!items.length) {
      box.innerHTML = '<div class="notice-empty">还没有提交过反馈。有什么不顺手的地方，说一句就好。</div>';
      return;
    }
    box.innerHTML = items.map(f => {
      const last = (f.thread && f.thread.length) ? f.thread[f.thread.length - 1] : null;
      const lastLine = last && last.from === 'admin' ? '站长：' + last.text : (last ? '我：' + last.text : '');
      return `
      <button type="button" class="fb-row" data-fb-open="${escapeHtml(f.id)}">
        <span class="fb-row-top">
          <b>${escapeHtml(f.type || '反馈')}</b>
          <span>${fmtNoticeTime(f.lastAt || f.createdAt)}</span>
          ${f.status === '已处理' ? '<span class="fb-done">已回复</span>' : ''}
          ${Number(f.unread) > 0 ? `<span class="fb-new">${Number(f.unread)}</span>` : ''}
        </span>
        <span class="fb-row-text">${escapeHtml(f.content || '')}</span>
        ${lastLine ? `<span class="fb-row-last">${escapeHtml(lastLine.length > 60 ? lastLine.slice(0, 60) + '…' : lastLine)}</span>` : ''}
      </button>`;
    }).join('');
    box.querySelectorAll('[data-fb-open]').forEach(el => {
      el.onclick = () => openThread(el.dataset.fbOpen);
    });
  }

  function renderThread(f) {
    const box = $('fbThread');
    const msgs = (f && f.thread) || [];
    box.innerHTML = msgs.length ? msgs.map(m => `
      <div class="reply-msg reply-${m.from === 'admin' ? 'admin' : 'user'}">
        <span class="reply-from">${m.from === 'admin' ? '站长' : '我'}</span>
        <p class="reply-text">${escapeHtml(m.text)}</p>
        <span class="reply-time">${fmtNoticeTime(m.at)}</span>
      </div>`).join('') : '<div class="reply-empty">还没有往来消息</div>';
    box.scrollTop = box.scrollHeight;
  }

  function openThread(id) {
    const f = (state.myFeedback || []).find(x => x.id === id);
    if (!f) return;
    curId = id;
    f.unread = 0;                       // 点开就算看过
    $('fbMineDot').hidden = true;
    $('fbList').hidden = true;
    $('fbDetail').hidden = false;
    $('fbDetailHead').textContent =
      `${f.type || '反馈'} · 提交于 ${new Date(f.createdAt).toLocaleString('zh-CN')}` +
      (f.status === '已处理' ? ' · 站长已回复' : ' · 等待查看');
    renderThread(f);
    $('fbReplyText').value = '';
    setTimeout(() => $('fbReplyText').focus(), 60);
  }

  tabForm.onclick = () => setView('form');
  tabMine.onclick = async () => {
    setView('mine');
    $('fbList').innerHTML = '<div class="notice-empty">加载中…</div>';
    await fbLoadMine(false);          // 打开就算看过：未读标记清掉
    renderList();
    $('fbMineDot').hidden = true;     // 列表里的「N 条新」还留着提示，标签上的红点可以灭了
    fbRefreshDot();
  };
  $('fbBack').onclick = () => { curId = ''; renderList(); };

  $('feedbackBtn').onclick = () => openFeedback();
  $('closeFeedback').onclick = closeFeedback;
  bindMaskClose(modal, closeFeedback);

  // 会话里继续回复
  $('fbReplySend').onclick = async () => {
    const ta = $('fbReplyText');
    const text = ta.value.trim();
    if (!text || !curId) return;
    const btn = $('fbReplySend');
    btn.disabled = true;
    try {
      const r = await fetch('/api/feedback/' + encodeURIComponent(curId) + '/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, token: fbTokenOf(curId) })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '发送失败');
      const f = (state.myFeedback || []).find(x => x.id === curId);
      if (f) {
        f.thread = d.thread || f.thread;
        f.lastAt = new Date().toISOString();
        f.status = '待查看';
        f.unread = 0;
      }
      ta.value = '';
      renderThread(f || { thread: d.thread });
      showToast('已发送，站长看到会回你', undefined, 'ok');
    } catch (e) { showToast(e.message, undefined, 'err'); }
    btn.disabled = false;
  };
  $('fbReplyText').onkeydown = e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('fbReplySend').onclick();
  };

  // 滚动时收起右下角悬浮球（装到桌面 / 小程序 / 反馈）：它们固定压在右下角，滚动中会盖住卡片右下角的分享/收藏按钮。
  // 三颗现在同属 .fab-stack，整组一起淡出；没有容器的旧页面退回逐颗隐藏。
  // 停止滚动 1.2 秒后再浮出；弹窗锁滚动期间不会触发 window scroll，悬浮球保持可见。
  let fabHideTimer = null;
  window.addEventListener('scroll', () => {
    const stack = $('fabStack');
    const fabs = stack ? [stack] : document.querySelectorAll('.feedback-fab, .mini-fab, .install-fab');
    if (!fabs.length) return;
    fabs.forEach(f => f.classList.add('fab-hidden'));
    clearTimeout(fabHideTimer);
    fabHideTimer = setTimeout(() => fabs.forEach(f => f.classList.remove('fab-hidden')), 1200);
  }, { passive: true });

  // 页脚等处的 /?feedback=1 链接：原地开弹窗，不整页跳转（跳转会把滚动位置丢回顶部）
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href*="feedback=1"]');
    if (!a) return;
    e.preventDefault();
    history.replaceState(null, '', '/?feedback=1');
    openFeedback();
  });

  // 页脚「合作洽谈」等按钮：打开反馈弹窗并预选类型、替换提示语（「申请友链」独立成弹窗，见 setupFriendApply）
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-fb]');
    if (!b) return;
    e.preventDefault();
    openFeedback({ type: b.dataset.fb, hint: b.dataset.fbHint || '', title: b.dataset.fbTitle || '', tabText: b.dataset.fbTabText || '' });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('feedbackSubmit');
    const content = form.content.value.trim();
    if (content.length < 5) { showToast('多写两句吧，至少 5 个字', undefined, 'err'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '提交中…';
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: form.type.value, content, contact: form.contact.value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '提交失败');
      form.reset();
      // 本机留底：游客靠它回来看回复（登录用户也会按账号查到）
      if (data.id && data.token) fbStoreAdd({ id: data.id, token: data.token, createdAt: new Date().toISOString() });
      await fbLoadMine(true);
      if (data.id && !(state.myFeedback || []).some(x => x.id === data.id)) {
        // 服务端还没回来的兜底：先把刚提交的这条摆进列表
        state.myFeedback.unshift({
          id: data.id, type: form.type.value || '反馈', content, status: '待查看',
          createdAt: new Date().toISOString(), lastAt: new Date().toISOString(),
          thread: [{ from: 'user', fromName: '我', text: content, at: new Date().toISOString() }], unread: 0
        });
      }
      showToast(data.message || '收到啦，谢谢你的反馈！', undefined, 'err');
      setView('mine');
      if (data.id) openThread(data.id);
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  // 支持 /?feedback=1 直接打开（SEO 页底部入口用）
  if (new URLSearchParams(location.search).get('feedback') === '1') {
    setTimeout(() => openFeedback(), 300);
  }
}

// ---------- 安装到桌面（PWA） ----------
// Chrome/Edge/安卓会派发 beforeinstallprompt，攒起来给「一键安装」按钮用；
// iOS Safari 不派发，只能走扫码 + 手动添加到主屏幕的指引
let installPromptEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPromptEvent = e;
});

function setupInstall() {
  const modal = $('installModal');
  if (!modal) return;

  // 已经装成 App 在用（桌面 Chrome / 安卓 standalone，或 iOS 主屏打开）就别再打扰：藏起右下角浮标，页脚入口保留
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    const fab = $('installFab');
    if (fab) fab.style.display = 'none';
  }

  function openInstall() {
    // 二维码指向当前站点地址：线上就是 https://idea.v5pc.com，扫码直达
    const box = $('installQrBox');
    if (!box.dataset.done && typeof qrcode === 'function') {
      try {
        const qr = qrcode(0, 'M');
        qr.addData(location.origin);
        qr.make();
        box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
        box.dataset.done = '1';
      } catch { box.innerHTML = '<div class="install-qr-err">二维码生成失败，直接在浏览器输入网址也可以</div>'; }
    }
    // 一键安装入口下线（2026-11-08）：不再亮「一键安装」，引导改为去小程序（见页脚与弹窗底部横幅）。
    // beforeinstallprompt 仍照常攒着、onclick 逻辑留着，哪天要恢复只改这一行。
    const native = $('installNative');
    native.style.display = 'none';
    native.onclick = async () => {
      if (!installPromptEvent) return;
      installPromptEvent.prompt();
      try {
        const { outcome } = await installPromptEvent.userChoice;
        if (outcome === 'accepted') showToast('装好了，桌面见', undefined, 'ok');
      } catch { /* 用户关闭选择框，不用管 */ }
      installPromptEvent = null;
      native.style.display = 'none';
    };
    showModal(modal);
  }
  function closeInstall() { hideModal(modal); }

  // 右下角浮标 + 页脚入口，两处都能打开
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('#installEntry, #installFab');
    if (!a) return;
    e.preventDefault();
    openInstall();
  });

  // 复制链接：发给电脑上的自己 / 微信里长按粘贴，去手机浏览器装
  $('installCopyLink').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.origin);
      showToast('链接已复制，去手机浏览器打开就能装', undefined, 'ok');
    } catch {
      // 剪贴板 API 被拒（非 HTTPS / 旧浏览器）的兜底
      const ta = document.createElement('textarea');
      ta.value = location.origin;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('链接已复制，去手机浏览器打开就能装', undefined, 'ok'); }
      catch { showToast('复制没成功，直接在浏览器输入网址也可以', undefined, 'err'); }
      ta.remove();
    }
  };

  $('closeInstall').onclick = closeInstall;
  $('installKnow').onclick = closeInstall;
  bindMaskClose(modal, closeInstall);

  // 小程序弹窗：和 PWA 指引互切，一次只开一个
  const mini = $('miniModal');
  if (mini) {
    const openMini = () => { hideModal(modal); showModal(mini); };
    const closeMini = () => hideModal(mini);
    $('openMiniModal').onclick = openMini;
    // 页脚「小程序版体验更佳」：同一个小程序弹窗，里面就是本站小程序码
    const footerMini = $('footerMiniLink');
    if (footerMini) footerMini.onclick = openMini;
    // hero 一句话里的「小程序版更顺手」：PC 在副标题、手机在定位文案行，同一个弹窗
    document.querySelectorAll('.hero-mini-open').forEach(n => { n.onclick = openMini; });
    // 编年史「小程序正式上架」条目里的「扫码即达」：点了也开这一个小程序弹窗
    document.querySelectorAll('.chron-mini-open').forEach(n => { n.onclick = openMini; });
    // 右下角「小程序」浮标：直接开小程序弹窗，不用先经过安装弹窗
    $('miniFab').onclick = openMini;
    $('closeMini').onclick = closeMini;
    $('miniKnow').onclick = closeMini;
    bindMaskClose(mini, closeMini);
    $('miniToInstall').onclick = () => { closeMini(); openInstall(); };
  }
}

// ---------- PWA 安装奖励 ----------
// 在已添加到主屏幕的 App（standalone）里打开且已登录，一次性领 200 盏灯火。
// 服务端保证每账号只发一次：重复调用返回 already:true，前端静默不弹提示。
function isStandalonePwa() {
  // 安卓/桌面 Chrome 看显示模式；iOS Safari 加到主屏后 navigator.standalone 为 true
  return (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches))
    || window.navigator.standalone === true;
}
async function claimPwaBonus() {
  if (!isStandalonePwa() || !state.user) return;
  try {
    const r = await (await fetch('/api/me/pwa-bonus', { method: 'POST' })).json();
    if (r && r.ok && !r.already && r.reward) {
      // 延后 2 秒再提示：新用户常带着「你有 N 条新消息」的 toast，别把它顶掉
      setTimeout(() => showToast(`用桌面图标打开成功，送你 ${r.reward} 盏灯火`, 5000, 'ok'), 2000);
    }
  } catch { /* 离线或失败不领，下次用桌面图标打开再试 */ }
}

// ---------- 启动 ----------
async function init() {
  // SEO 预渲染区块立刻移除（不等任何接口）：它顶在页面上几百像素，等数据回来才塌掉是最大的抖动源
  // 作品详情页 /w/ 除外（完整页面模式要展示它，route 里再处理）；编年史 /chronicle、作品规范 /rules、
  // 安装页 /install、邀请页 /invite、精选专栏 /column 整页靠它渲染，也保留
  // 注意：这里和 route() 里的 isStaticPage 是两份判断，改路由时两处要同步
  const keepSeo = location.pathname.startsWith('/w/') ||
    location.pathname === '/chronicle' || location.pathname === '/rules' || location.pathname === '/install' || location.pathname === '/invite' ||
    location.pathname === '/ads' ||
    location.pathname === '/enterprise' ||   // 企业产品入驻页：同样整页 SSR
    location.pathname.startsWith('/brand/') ||   // 品牌橱窗页：整页 SSR，删了这块就只剩空首页
    location.pathname === '/open' ||
    location.pathname === '/column' || location.pathname.startsWith('/column/');
  if (!keepSeo) removeSeoBlock();
  // 先按上次的登录态快照把右上角画出来（此刻首绘还没发生，视觉上零跳变），
  // 再等 /api/me 校准；顺手把「登录 / 注册」按钮的点击绑成事件委托（预置按钮也要能点）
  restoreMeSnapshot();
  $('authBox').addEventListener('click', e => {
    if (e.target.closest('.auth-open')) { e.stopPropagation(); openAuth('login'); }
  });
  captureFr();    // 再处理 ?fr=：只记渠道来源，不加分
  captureRef();   // 先处理 ?ref=：记下分享者并上报，再把参数从地址栏摘掉
  captureClaimToken();   // 匿名投稿进度页带来的 ?claimToken=：投稿人本人才能认领那个作品
  loadFooterFriends();  // 页脚友情链接（后台可配，空则不展示）
  loadFooterStats();    // 页脚站点 PV/UV + 提交作品引导
  loadPlatforms();      // 外宣指南平台清单：顺手预取，详情页点「外宣包」时不用等
  // 支持 /?q=关键词 直接进入搜索结果（与站点搜索结构化数据一致）
  const q = (new URLSearchParams(location.search).get('q') || '').trim();
  if (q) {
    state.q = q;
    $('searchInput').value = q;
  }
  // 登录态 + 形态元数据并行等（都只有几百字节）：形态图标/名字在画卡片时就要用
  await Promise.all([loadMe(), loadTypeMeta()]);
  // 带着投稿凭据回来的匿名作者：先弹窗确认，再决定登录还是直接提交。
  // 以前已登录就静默提交，链接被转发时对方打开页面就替人把队列占了，所以一律先问一句。
  if (state.pendingClaim) showClaimPrompt();
  loadGuestNotices();  // 未登录访客：顶部公告条（登录用户不展示，走铃铛）
  startNoticePoll();   // 有未读消息就点亮铃铛，之后每 60 秒补一次
  if (state.user && Number(state.user.unreadNotices || 0) > 0) {
    setTimeout(() => showToast(`你有 ${state.user.unreadNotices} 条新消息，${noticeTipText()}`, 5000), 800);
    loadNotices(true);
  }
  claimPwaBonus();  // PWA（添加到主屏幕）里打开且已登录：一次性领 200 盏灯火
  // 先绑详情动作区（含作者页「送灯火」的钩子），再渲染页面：
  // 它对分类/工具/广告数据零依赖，放后面纯属历史原因——直进作者页时按钮先出来、
  // 钩子要等几个元数据请求回来才注入，期间点击被静默吞掉（「点了没反应」就是这么来的）。
  setupDetailActions();
  // 先把当前页面画出来：该页自己的数据（榜单/列表/详情）立刻开始拉。
  // 原来这行在 6 个接口串行 await 的最后，/rank 要等 5 个来回才开始请求榜单，
  // 4G 节流下实测白等 2.6 秒，期间屏幕上还是首页——「换页总先加载首页」就是这么来的。
  route();
  // 剩下的都是「补齐类」元数据：分类、工具清单、广告位，并行拉，回来后再刷新依赖它们的面板
  await Promise.all([loadCategories(), loadTools(), ensureAds()]);
  // 分类/形态选项补齐后重绘榜单筛选栏（H5 重绘 tab 栏，PC 只补形态下拉的数字）
  if (location.pathname === '/rank') { if (isH5View()) renderRankFilterBarH5(); else renderRankTypePanel(); }
  setupHeader();
  setupPublishMenu();      // 头部加号 / 手机底部加号：一个入口，四条发布出路
  setupUploadForm();
  refreshDraftHint();      // 草稿角标：loadMe 比 setupUploadForm 早，这里补一次（首屏就要能看见）
  setupMdEditor();         // 简介的 Markdown「写 / 预览」切换
  setupCommentKindTabs(); // 先绑评论/提问切换，别被详情弹窗其他绑定的问题牵连
  setupCommentEmoji();     // 评论框的表情面板（只在详情弹窗里，绑一次就够）
  setupEmojiFloatDismiss(); // 闲聊回应框的表情浮层：点外面/滚动时收起（全局只绑一次）
  setupAuthForms();
  setupSubmitChoice();
  setupFeedback();
  fbRefreshDot();  // 反馈悬浮球：有站长回复没看就亮个小红点（异步，不挡首屏）
  setupInstall();
  afterLoadAuth();  // GitHub 授权回来的提示 + 补上登录前点的「投稿」
  openAuthFromQuery();  // /?login=1 从独立页（勋章页等）跳回来：直接弹登录框
  setupPromoKit();  // 外宣包弹窗（按钮在详情页，弹窗只需要绑一次）
  setupPublishOk();  // 发布成功弹窗（投稿即时上线后弹出，按钮绑一次）
  setupFriendApply();  // 申请友链弹窗（页脚友链行的入口，独立于反馈）
  // 本屏 hero 进场动画播完后记账：之后本标签页刷新不再重播（head 内联脚本读到标记就关动画）
  setTimeout(() => { try { sessionStorage.setItem('dm_hero_played', '1'); } catch { /* 隐私模式就算了 */ } }, 1500);
  // 造梦酒馆是独立页面，进入 /bar 时再初始化（见 route）
  // 本周精选：滚动/窗口变化时同步箭头状态
  $('featRow').addEventListener('scroll', updateFeatNav, { passive: true });
  window.addEventListener('resize', updateFeatNav);
  // route() 已经在上面（登录态就绪后）跑过了，这里不能再调一次：重复调 = 重复拉一遍榜单/列表
}

// ---------- 友情链接（页脚，后台「友情链接」配置） ----------
// 行尾固定挂「申请友链」入口（独立弹窗，后台审批）：一条友链都没有时
// 入口本身成了这一行的主角，所以 catch / 空列表也不能把整行藏掉。
// 2026-11-14 改两行制：站名一行（加粗深色）+ 一句话简介一行（12px 淡灰）。
// 以前站名和简介拼在同一个字符串里（"解压小站-解压小游戏在线合集"），条目之间又用「·」，
// 「-」「·」同一灰度同一字重，整行糊成一片，谁是谁分不清 —— 现在分栏靠留白，不靠符号。
async function loadFooterFriends() {
  const box = $('footerFriends');
  if (!box) return;
  // 「＋」而不是「→」：点开的是站内弹窗，不是跳走；也让它在友链名单里一眼看出是个动作
  const applyBtn = '<button type="button" class="footer-link ff-apply" data-friend-apply="1">＋ 申请友链</button>';
  box.style.display = '';
  try {
    const list = await (await fetch('/api/friends')).json();
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = '<span class="ff-label">友情链接</span><span class="ff-empty">虚位以待</span>' + applyBtn;
      return;
    }
    box.innerHTML = '<span class="ff-label">友情链接</span><div class="ff-list">' +
      list.map(f => {
        // desc 可空（老数据 / 站长没填）：没有就只显示站名，别留一行空白
        const desc = String(f.desc || '').trim();
        return '<a class="ff-item" href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener nofollow">' +
          '<span class="ff-name">' + escapeHtml(f.name) + '</span>' +
          (desc ? '<span class="ff-desc">' + escapeHtml(desc) + '</span>' : '') +
          '</a>';
      }).join('') + '</div>' + applyBtn;
  } catch {
    // 列表拉不到就只展示申请入口，无害
    box.innerHTML = '<span class="ff-label">友情链接</span>' + applyBtn;
  }
}

// ---------- 申请友情链接弹窗 ----------
// 入口在页脚友链行（loadFooterFriends 渲染）；「关于本站」弹窗克隆的节点
// 也带 data-friend-apply，所以委托挂 document 级，克隆节点同样能开。
// 上次提交的申请只记在本机 localStorage：还在审核中就把内容填回去，改完再提交＝原地更新
// 那条申请（服务端认人：登录账号 / 同 IP / 联系方式），不重复占位。
// 没有「撤回申请」这回事 —— 用户 2026-11-08 拍板：只给编辑，不给取消审核的入口。
const FRIEND_LAST_KEY = 'dm_friend_last';
function readLastFriendApply() {
  try { return JSON.parse(localStorage.getItem(FRIEND_LAST_KEY) || 'null'); } catch { return null; }
}
function writeLastFriendApply(v) {
  try { v ? localStorage.setItem(FRIEND_LAST_KEY, JSON.stringify(v)) : localStorage.removeItem(FRIEND_LAST_KEY); } catch { /* 隐私模式无视 */ }
}
function openFriendModal() {
  const mask = $('friendModal');
  if (!mask) return;
  // 联系方式只向未登录的人要：登录用户审批结果直接发站内私信（未登录收不到私信）
  const logged = !!(state.user && state.user.username);
  const box = mask.querySelector('#friendContactBox');
  if (box) box.style.display = logged ? 'none' : '';
  const form = mask.querySelector('#friendForm');
  const hint = mask.querySelector('#friendHint');
  // 填回上次提交的内容：只在表单是空的时候填，别盖掉用户正在打的字
  const last = readLastFriendApply();
  if (last && last.url && form && !form.url.value) {
    form.url.value = last.url;
    form.intro.value = last.intro || '';
    if (!logged && box && last.contact) form.contact.value = last.contact;
  }
  if (hint) {
    hint.textContent = last && last.url
      ? '上次提交过：改完内容再提交＝更新那条申请，不会重复排队'
      : (logged
        ? '提交后由站长人工审批，通过前不会出现在页脚；结果会发站内私信给你'
        : '未登录提交，请留一个联系方式接收审批结果；登录后提交可直接收站内私信');
  }
  showModal(mask);
  setTimeout(() => { const i = mask.querySelector('input[name="url"]'); if (i) i.focus(); }, 60);
}
function setupFriendApply() {
  const mask = $('friendModal'), form = $('friendForm');
  if (!mask || !form) return;
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-friend-apply]');
    if (!b) return;
    e.preventDefault();
    openFriendModal();
  });
  $('closeFriendModal').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('friendSubmit');
    const url = form.url.value.trim();
    const intro = form.intro.value.trim();
    // 未登录（联系方式框露着）必须留联系方式，否则审批结果没处发
    const contactBox = mask.querySelector('#friendContactBox');
    const needContact = !!(contactBox && contactBox.style.display !== 'none');
    const contact = needContact ? form.contact.value.trim() : '';
    if (!url) { showToast('填一下网址', undefined, 'err'); return; }
    if (needContact && !contact) { showToast('留个联系方式，好把审批结果发给你', undefined, 'err'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '提交中…';
    try {
      // 名称不带上去：服务端自己抓对方 <title> 解析，失败退回域名
      const res = await fetch('/api/friends/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 联系方式只在未登录时带（登录用户结果走站内私信）
        body: JSON.stringify(needContact ? { url, intro, contact } : { url, intro })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 已经在友链列表里了：本机那条「上次提交」的记录也就没用了，清掉别下次又提示
        if (data.code === 'listed') writeLastFriendApply(null);
        throw new Error(data.error || '提交失败');
      }
      // 记住这次填的内容，下次打开弹窗能接着改（服务端只在同账号 / 同 IP / 同联系方式时认作编辑）
      const prev = readLastFriendApply();
      writeLastFriendApply({ url, intro, contact: contact || (prev && prev.contact) || '' });
      form.reset();
      hideModal(mask);
      showToast(data.message || '已提交，等待站长审批');
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

// 页脚站点统计：今日/累计 PV·UV（公开接口，无明细；提交引导头部已有，页脚不再重复）
async function loadFooterStats() {
  const el = $('footerStats');
  if (!el) return;
  try {
    const s = await (await fetch('/api/site-stats')).json();
    const fmt = n => (n || 0).toLocaleString('en-US');   // 千分位：3994 → 3,994，大数字更好读
    // 编年史入口挂在「已运营 N 天」上：语义天然贴合（天数→这一路怎么长起来的），也比埋在「参与」链接堆里好找
    el.innerHTML =
      `<a class="fs-item fs-link" href="/chronicle" title="造梦橱窗大事记：这一路是怎么长起来的">` +
        (s.runDays
          ? `已运营 <b>${s.runDays}</b> 天${s.launchDate ? `（${s.launchDate} 起）` : ''}<span class="fs-chron">· 造梦编年史 ↗</span>`
          : `造梦编年史 ↗`) +
      `</a>` +
      // 竖线把三块数据隔开：编年史 | 网页 | 小程序，块内「今日 · 累计」成对出现，扫读有落点
      `<span class="fs-sep" aria-hidden="true"></span>` +
      // 「访问数据」组标签：先告诉读者「下面这串是站点访问数据」，再进渠道明细
      `<span class="fs-item"><span class="fs-tag fs-label">${ic('bars', 12)}访问数据</span><span class="fs-tag">网页</span>今日 <b>${fmt(s.pvToday)}</b> 次 / <b>${fmt(s.uvToday)}</b> 人<span class="fs-dot">·</span>累计 <b>${fmt(s.pv)}</b> 次 / <b>${fmt(s.uv)}</b> 人</span>` +
      `<span class="fs-sep" aria-hidden="true"></span>` +
      // 小程序渠道单独一组（接口里 mini* 与上面网页口径分开算）；「小程序」三个字点了开小程序弹窗
      `<span class="fs-item"><span class="fs-tag fs-mini" title="点开看看本站小程序">小程序</span>今日 <b>${fmt(s.miniPvToday)}</b> 次 / <b>${fmt(s.miniUvToday)}</b> 人<span class="fs-dot">·</span>累计 <b>${fmt(s.miniPv)}</b> 次 / <b>${fmt(s.miniUv)}</b> 人</span>`;
    // 「小程序」三个字 → 打开小程序码弹窗（与页脚「小程序版体验更佳」同一个 #miniModal）
    el.querySelectorAll('.fs-mini').forEach(node => {
      node.onclick = () => { const m = $('miniModal'); if (m) showModal(m); };
    });
    // ⓘ 圆圈感叹号挂在「访问数据」组标签后面（2026-11-10 晚用户拍板：从组末尾挪到标签后，
    //   先亮「这是访问数据 + 点这里看口径」，再进具体数字）。说明面板（.fs-pop）是 hover 浮层：绝对定位在 ⓘ 正上方，
    //   不占文档流、不推页脚内容（2026-11-10 用户明确要求回到 hover 提示形态，不要占流展开块）。
    //   开合逻辑走 document 委托（bindFsInfoToggle），「关于本站」弹窗克隆出来的节点也能响应。
    const fsInfoHtml = ` <span class="fs-info" tabindex="0" role="button" aria-expanded="false" aria-label="统计口径与防刷规则">${ic('info', 14)}</span>`;
    const fsPopHtml =
      `<span class="fs-pop" role="note">` +
        `<b>怎么算的</b>` +
        `<span>「次」= 访问次数：页面被打开的次数，同一个人反复打开也会累加。</span>` +
        `<span>「人」= 访客数：有多少个不同的人来过，同一个人一天只算 1 个。</span>` +
        // 认人规则（2026-11-12 用户要求补上）：说清「人」是怎么去重的，读者才知道数字为什么比想象的低/高。
        // 与后端一致：登录按账号 u:<id>；网页未登录按 IP；小程序按本机 deviceId（手机多在运营商 NAT 后面）
        `<b>怎么认人</b>` +
        `<span>登录了按账号算：同一账号换设备、换网络都还是同一个人。</span>` +
        `<span>没登录按 IP 算：同一网络（公司 / 学校 / 运营商出口）下多人共用只算 1 个人，换个网络会算成新访客。</span>` +
        `<span>小程序按本机设备算，不按 IP。</span>` +
        `<b>防刷规则</b>` +
        `<span>已过滤爬虫与脚本请求，脚本刷的量不进统计。</span>` +
        `<span>同一访客一天最多计 50 次访问，超出后照常浏览、但不再计数。</span>` +
        `<span>网页与小程序两边分开统计，互不合并。</span>` +
      `</span>`;
    // 挂在「访问数据」组标签（.fs-label）后面：紧跟组名、在「网页」角标之前。
    //   注意别用 querySelector('.fs-item')——第一个 .fs-item 是「已运营 N 天」那条编年史 <a>，
    //   ⓘ 掉进去会变成链接触发跳转；用 .fs-label 反查它所在的 span 才是「访问数据」组。
    const label = el.querySelector('.fs-label');
    if (label && !label.parentElement.querySelector('.fs-info')) {
      label.insertAdjacentHTML('afterend', fsInfoHtml);
      // 浮层挂在 .footer-meta 里、数据行之后（定位锚点是 .footer-meta，见 style.css）
      el.insertAdjacentHTML('afterend', fsPopHtml);
    }
    el.style.display = '';
  } catch {
    // 统计拉不到也不能把编年史入口一起弄丢（它现在只挂在这一行上）
    el.innerHTML = `<a class="fs-item fs-link" href="/chronicle">造梦编年史 ↗</a>`;
    el.style.display = '';
  }
}

// ⓘ 说明浮层的开合：鼠标 hover 弹出（2026-11-10 用户要求回到 hover 提示的形态），
//   触屏点按、键盘 Enter/Space 同效，点页面其他地方或焦点移开就收起。
//   浮层是绝对定位的（.fs-pop），不占文档流 —— 早期「占流展开」会推动页脚、指针下的元素换来换去而闪跳，
//   现在没有这个问题，hover 才敢用。
//   全走 document 委托：「关于本站」弹窗克隆出来的节点也能响应，不用重复绑定。
(function bindFsInfoToggle() {
  if (window.__fsInfoBound) return;
  window.__fsInfoBound = true;
  // 只有真 hover 设备（鼠标/触控板）走 hover；触屏靠点击，否则 tap 的 mouseover + click 会互相抵消
  const canHover = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  let closeTimer = 0;
  const popOf = info => {
    const host = info.closest('.footer-meta');
    return host ? host.querySelector('.fs-pop') : null;
  };
  // 浮层默认贴左，这里按 ⓘ 的实际位置把卡片摆到图标正上方（左右夹在页脚宽度内），
  // 小三角用 --fs-caret-x 指回图标，不至于「弹出来一大块不知道在说谁」
  const placePop = (info, pop) => {
    const host = pop.parentElement;      // .footer-meta（position: relative 的定位锚点）
    if (!host) return;
    const hr = host.getBoundingClientRect(), ir = info.getBoundingClientRect();
    const w = pop.offsetWidth || 336;
    const center = ir.left - hr.left + ir.width / 2;
    const left = Math.max(0, Math.min(center - w / 2, hr.width - w));
    pop.style.left = left + 'px';
    pop.style.setProperty('--fs-caret-x', Math.min(Math.max(center - left, 14), w - 14) + 'px');
  };
  const setOpen = (info, open) => {
    // 弹窗里（.site-info-body）面板恒展开，状态不随 hover 变，免得图标一冷一热
    if (info.closest('.site-info-body')) return;
    const pop = popOf(info);
    info.classList.toggle('open', open);
    info.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (pop) pop.classList.toggle('open', open);
    if (open && pop) placePop(info, pop);   // 先 display 再量宽，否则 offsetWidth 是 0
  };
  const openNow = info => { clearTimeout(closeTimer); if (!info.classList.contains('open')) setOpen(info, true); };
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => document.querySelectorAll('.fs-info.open').forEach(n => setOpen(n, false)), 160);
  };
  if (canHover) {
    // 指针移进 ⓘ 就开；移到别处 160ms 后收起（缓冲一下，扫过图标不会一路闪）。
    // 浮层自己 pointer-events:none，指针挪到它上面等于离开 ⓘ —— 这样它盖住上方友链/推荐位时
    // 也不会把用户的点击吃掉（工具提示只负责读）
    document.addEventListener('mouseover', e => {
      const t = e.target;
      if (!t.closest) return;
      const info = t.closest('.fs-info');
      if (info) { openNow(info); return; }
      if (document.querySelector('.fs-info.open')) closeSoon();
    });
  }
  document.addEventListener('click', e => {
    const info = e.target.closest && e.target.closest('.fs-info');
    if (info) {
      // 键盘触发的 click（detail=0）与触屏点按走开合；有 hover 时鼠标点击别跟 hover 抢
      if (!canHover || e.detail === 0) setOpen(info, !info.classList.contains('open'));
      return;
    }
    document.querySelectorAll('.fs-info.open').forEach(n => setOpen(n, false));
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const info = e.target.closest && e.target.closest('.fs-info');
    if (info) { e.preventDefault(); setOpen(info, !info.classList.contains('open')); }
  });
  // 键盘 Tab 走后别把浮层留在屏幕上
  document.addEventListener('focusout', e => {
    if (e.target.closest && e.target.closest('.fs-info')) closeSoon();
  });
})();

// 「关于本站」弹窗：把页脚 .footer-inner 的活节点整块克隆进来（运营统计/站点描述/
// 链接组/友链/备案号），页脚以后增删内容这里自动同步，不用维护两份。
// 意见建议/合作洽谈/安装到桌面等都是 document 级委托监听，克隆节点事件直接生效。
// 移动端页脚本体只留一行备案号，其余内容都从这里看（入口在「我的」页）。
function openSiteInfo() {
  const mask = $('siteInfoModal'), body = $('siteInfoBody');
  const src = document.querySelector('.site-footer .footer-inner');
  if (!mask || !src) return;
  body.innerHTML = '';
  const clone = src.cloneNode(true);
  clone.classList.remove('container');   // 弹窗自带宽度约束，去掉 container 的居中留白
  clone.classList.add('si-inner');
  // 点进来的每一下都有去处（链接/反馈弹窗/安装弹窗），本弹窗顺手收掉，别叠两层。
  // 这个监听先于 document 委托触发，收掉后再开新弹窗，滚动锁计数不会失衡
  clone.addEventListener('click', e => {
    if (e.target.closest('a, button')) hideModal(mask);
  });
  body.appendChild(clone);
  // 统计口径面板在弹窗里恒展开（CSS 把 .site-info-body .fs-pop 改成静态块）：
  // 移动端页脚不显示数据行，这里就是唯一能读到口径的地方。ⓘ 一并置成 open，图标颜色与状态对得上
  const clonePop = clone.querySelector('.fs-pop');
  if (clonePop) clonePop.classList.add('open');
  const cloneInfo = clone.querySelector('.fs-info');
  if (cloneInfo) { cloneInfo.classList.add('open'); cloneInfo.setAttribute('aria-expanded', 'true'); }
  $('closeSiteInfo').onclick = () => hideModal(mask);
  bindMaskClose(mask, () => hideModal(mask));
  showModal(mask);
}

// ---------- PWA：注册 Service Worker 与自动更新 ----------
// localhost 与 https 下才可用；admin 页面用的是独立 admin.html，不会执行到这里
let __swReg = null;        // SW registration
let __swReloaded = false;  // 本轮已自动刷新过，防止反复刷新

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  window.addEventListener('load', async () => {
    try {
      __swReg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    } catch (err) { return; } // 注册失败（隐私模式、存储被禁）不影响正常浏览

    // 新 SW 接管后自动刷新一次页面，让正在看的页面立刻换上新代码。
    // 首次安装时页面原本没有 controller，跳过刷新避免装完就刷。
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !__swReloaded) {
        __swReloaded = true;
        location.reload();
      }
      hadController = true;
    });

    // 桌面 PWA 冷启动少、浏览器自动检查不及时：打开页面和每次回到前台都主动查一次
    const check = () => { if (__swReg) __swReg.update().catch(() => {}); };
    check();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  });
}
registerServiceWorker();

// 屏宽跨越 640px 断点（用户转屏、拉窗口）时切一套 UI：筛选栏形态、榜单列表都要重画
let __h5View = window.matchMedia('(max-width: 640px)').matches;
window.addEventListener('resize', () => {
  const now = window.matchMedia('(max-width: 640px)').matches;
  if (now === __h5View) return;
  __h5View = now;
  renderFilters();
  if (location.pathname === '/rank') loadRankView();
});

init();
