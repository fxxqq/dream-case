// 造梦橱窗 - 前端逻辑
'use strict';

// 站点图标（统一在 /icons.js 里定义）：取不到就返回空串，不影响页面其他内容
const ic = (name, size) => (window.Icons ? Icons.icon(name, size) : '');

// 认证创作者徽章：圆形底 + 白色对勾（卡片、列表、作者主页、详情弹窗共用一个样式）
const VERIFIED_BADGE =
  '<svg class="vf-ico" viewBox="0 0 20 20" aria-hidden="true">' +
  '<circle cx="10" cy="10" r="9" fill="#5b5bd6"/>' +
  '<path d="M6.2 10.4l2.4 2.4 5.2-5.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

let CATEGORIES = ['全部'];
let typeCounts = {}, catCounts = {}, totalWorks = 0; let osCounts = { open: 0, closed: 0 }; // 筛选下拉选项的计数
let TYPES = ['全部', 'Web', 'iOS', 'Android', 'macOS', 'Windows', 'Linux', '小程序', '浏览器插件', '机器人', 'API'];
let renderCatPickerFn = null; // 投稿表单的分类胶囊渲染（loadCategories 后刷新）
const MAX_CATS = 3;           // 应用分类最多可选个数

const state = {
  sort: 'latest',
  type: '全部',
  category: '全部',
  openSource: '全部', // 是否开源筛选：全部 / 开源 / 闭源（后端 os=open|closed，可见性不受影响）
  range: '全部',      // 发布时间筛选：全部 / 近3天 / 近7天 / 近30天
  q: '',
  page: 1,
  hasMore: false,
  favoritesOnly: false,
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

// 从作品详情弹窗退回列表页时置为 true：列表 DOM 仍然完整，route() 不要重新拉取，
// 否则已加载的分页会丢失、「展示更多」按钮重新出现，看起来像整页刷新
let skipNextListReload = false;

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
const PAID_MODELS = { freemium: '部分免费', member: '会员专享', onetime: '单篇购买', subscription: '订阅制', trial: '试用后付费', donation: '送灯火' };
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
  if (state.currentWork && state.currentWork.id === id) state.currentWork.favs = val;
}
// 评论数同步（卡片/列表/详情共用，发评论或删评论后调用）
function paintCommentCount(id, n) {
  const val = Math.max(0, parseInt(n, 10) || 0);
  document.querySelectorAll(`[data-comment-count="${CSS.escape(String(id))}"]`).forEach(el => {
    el.dataset.count = val;
    el.textContent = (el.dataset.prefix || '') + val;
  });
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
  el.innerHTML = `<span class="ico b-ico">${ic('fav')}</span> ${faved ? '已收藏' : '收藏'}`;
  el.classList.toggle('faved', faved);
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
let resetUploadForm = () => {}; // setupUploadForm 内部注入（afterAuth 等外部也会调用）
let restoreUploadDraft = () => false; // 恢复本地草稿（闭包内注入）
let clearUploadDraft = () => {}; // 清除草稿（提交成功后调用）
let applyTypeFieldsFn = () => {}; // setupUploadForm 内部注入：按形态切换链接/二维码字段
let updateRepoFieldFn = () => {}; // setupUploadForm 内部注入：开源时显示/必填源码仓库
let resetTipPanel = () => {}; // setupDetailActions 内部注入：换作品时重置打赏面板（openWork 调用）

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
         title="${ckDone ? `今天已签 · 连续 ${ck.streak || 0} 天 · 点开看进度和签到累计榜` : `每日签到领 ${ck.todayPoints || 2} 盏灯火，越签越多 · 点开签到`}">${ckDone ? '' : `<span class="lb-ico"><span class="ico">${ic('checkin')}</span></span><span class="ck-label">签到 +${ck.todayPoints || 2}</span>`}<span class="ck-pts"><span class="ico">${ic('lamp')}</span>${pts}</span></button>` +
      `<button class="link-btn notice-entry${unread ? ' has-new' : ''}" id="noticeBtn" title="${unread ? unread + ' 条未读消息' : '站内消息'}"><span class="nb-ico"><span class="ico">${ic('bell')}</span></span><span class="nb-dot"${unread ? '' : ' style="display:none"'}>${unread > 99 ? '99+' : unread}</span></button>` +
      `<div class="user-menu" id="userMenu">
        <button class="user-chip" id="userMenuBtn" title="个人菜单">${ic('user')} <span class="uc-name">${escapeHtml(state.user.nickname || state.user.username)}</span><span class="um-caret">▾</span></button>
        <div class="user-dropdown" id="userDropdown">
          <a class="ud-item" href="/u/${encodeURIComponent(state.user.username)}" data-nav>${ic('home', 15)} 我的主页</a>
          <button class="ud-item" id="favDrop">${ic('fav', 15)} 我的收藏</button>
          <button class="ud-item" id="statsBtn">${ic('bars', 15)} 作品数据</button>
          <div class="ud-sep"></div>
          <button class="ud-item" id="promoBtn">${ic('promo', 15)} 推荐自己的作品</button>
          <button class="ud-item" id="giftBtn">${ic('ticket', 15)} 兑换码领灯火</button>
          <a class="ud-item" href="/invite">${ic('share', 15)} 邀请收录</a>
          <div class="ud-sep"></div>
          <button class="ud-item ud-sub-toggle" id="settingsBtn" aria-expanded="false">${ic('gear', 15)} 账号设置<span class="ud-arrow">▸</span></button>
          <div class="ud-sub" id="settingsSub" hidden>
            <button class="ud-item" id="nickBtn">${ic('edit', 15)} ${state.user.nickname ? '改昵称' : '设个昵称'}</button>
            <button class="ud-item" id="passBtn">${ic('key', 15)} 账号与密码</button>
            <button class="ud-item" id="muteNoticeBtn" title="屏蔽后系统消息仍会进铃铛，只是不再弹提示">${ic('bell', 15)} 系统消息提示<span class="ud-ok${noticeMuted() ? ' is-muted' : ''}">${noticeMuted() ? '已屏蔽' : '正常'}</span></button>
            ${state.providers && state.providers.github ? `<button class="ud-item" id="ghBtn">${ic('github', 15)} GitHub 绑定${state.user.github ? '<span class="ud-ok">已绑定</span>' : ''}</button>` : ''}
            ${state.providers && state.providers.google ? `<button class="ud-item" id="gBtn">${ic('google', 15)} Google 绑定${state.user.google ? '<span class="ud-ok">已绑定</span>' : ''}</button>` : ''}
            ${n ? `<button class="ud-item" id="blockedBtn">${ic('block', 15)} 屏蔽管理</button>` : ''}
          </div>
          <div class="ud-sep"></div>
          <button class="ud-item ud-logout" id="logoutBtn">${ic('logout', 15)} 退出登录</button>
        </div>
      </div>`;
    // 下拉菜单：点 chip 开合，点外面 / Esc 关闭（document 监听只挂一次）
    const menu = $('userMenu');
    $('userMenuBtn').onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
    menu.querySelectorAll('.ud-item').forEach(el => {
      if (el.id === 'settingsBtn') return;   // 「账号设置」是展开/收起，不关整个菜单
      el.addEventListener('click', () => menu.classList.remove('open'));
    });
    // 账号设置：就地展开二级（桌面/手机同一套行为，不做浮层，窄屏也不会溢出）
    const settingsBtn = $('settingsBtn');
    const settingsSub = $('settingsSub');
    settingsBtn.onclick = e => {
      e.stopPropagation();
      const open = settingsBtn.getAttribute('aria-expanded') === 'true';
      settingsBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
      settingsSub.hidden = open;
    };
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
    // 我的收藏：从顶部导航收进头像下拉（列表过滤态 + 导航高亮都跟着它）
    const favDrop = $('favDrop');
    if (favDrop) {
      favDrop.classList.toggle('active', state.favoritesOnly);
      favDrop.onclick = () => { menu.classList.remove('open'); toggleFavorites(); };
    }
    $('statsBtn').onclick = () => openStats('data');
    // 推荐直达：点「推荐」直接弹兑换弹窗，不再先进推荐面板绕一层
    $('promoBtn').onclick = () => openRedeem();
    const giftEntry = $('giftBtn');
    if (giftEntry) giftEntry.onclick = () => openGiftCode();
    // 签到独立成弹窗：签到卡 + 签到累计榜，不再和推荐混在一个弹窗里
    $('checkinBtn').onclick = () => openStats('checkin');
    $('noticeBtn').onclick = openNotices;
    $('passBtn').onclick = openPassModal;
    const nickEntry = $('nickBtn');
    if (nickEntry) nickEntry.onclick = openNickModal;
    const ghEntry = $('ghBtn');
    if (ghEntry) ghEntry.onclick = openGhModal;
    const gEntry = $('gBtn');
    if (gEntry) gEntry.onclick = openGModal;
    const muteEntry = $('muteNoticeBtn');
    if (muteEntry) muteEntry.onclick = toggleNoticeMute;
    const bb = $('blockedBtn');
    if (bb) bb.onclick = () => openBlockedList('works');
  } else {
    // 「登录 / 注册」按钮的点击走 authBox 上的事件委托（init 里绑一次）：
    // index.html 里 authBox 预置了同款按钮，游客刷新时首绘就有按钮，不用等 /api/me 回来才蹦出来
    box.innerHTML = '<button type="button" class="btn-ghost auth-open" id="loginEntry">登录 / 注册</button>';
  }
}

// 每日签到：领积分（连续第 7 天有额外奖励），成功后原地刷新顶部按钮状态
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
    showToast(d.dayInCycle === d.cycle
      ? `签到成功 +${d.reward} 盏灯火 · 连续 ${d.streak} 天，7 天拿满 ${Array.isArray(d.schedule) ? d.schedule.reduce((a, b) => a + b, 0) : ''} 盏`
      : `签到成功 +${d.reward} 盏灯火 · 连续 ${d.streak} 天${nextReward ? `，明天 +${nextReward} 盏` : ''}`, undefined, 'ok');
    if (typeof after === 'function') after(d);
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast(err.message || '签到失败，请稍后再试', undefined, 'err');
  }
}

// 签到卡片（数据看板顶部那一块）：7 天进度（每天标注当日奖励）+ 一键签到
function checkinCardHtml(ck) {
  const cycle = ck.cycle || 7;
  const day = ck.dayInCycle || 1;
  const done = !!ck.done;
  const filled = done ? day : day - 1;
  const schedule = Array.isArray(ck.schedule) && ck.schedule.length === cycle
    ? ck.schedule
    : Array.from({ length: cycle }, () => ck.todayPoints || 2);   // 旧数据兜底
  const dots = Array.from({ length: cycle }, (_, i) => {
    const n = i + 1;
    const cls = ['ck-dot'];
    if (n <= filled) cls.push('is-filled');
    if (n === day) cls.push('is-today');
    if (n === cycle) cls.push('is-bonus');
    const tip = n === cycle ? `第 ${n} 天 +${schedule[n - 1]} 盏` : `第 ${n} 天 +${schedule[n - 1]} 盏`;
    return `<span class="${cls.join(' ')}" title="${tip}">${n <= filled ? '✓' : (n === cycle ? '今' : n)}</span>`;
  }).join('');
  return `
    <div class="checkin-card${done ? ' is-done' : ''}">
      <div class="ck-head">
        <div class="ck-title"><span class="ico">${ic('checkin')}</span> 每日签到${ck.streak ? `<span class="ck-streak">连续 ${ck.streak} 天</span>` : ''}</div>
        <button type="button" class="checkin-go" id="checkinGo"${done ? ' disabled' : ''}>${done ? '今日已签 ✓' : `签到 +${ck.todayPoints || 2}`}</button>
      </div>
      <div class="ck-days">${dots}</div>
      <div class="ck-tip">连签 ${cycle} 天依次领 ${schedule.join(' → ')} 盏，断签从 ${schedule[0]} 盏重新算。攒下的灯火既能换<span style="white-space:nowrap">「推荐」</span>的曝光位，也能送给别人的作品，为喜欢的创作者点一盏灯。</div>
    </div>`;
}

// 签到累计榜（推荐面板里的小榜）：按累计签到灯火排，前 5 名，自己不在榜内就补一行真实名次。
// 和「灯火达人榜」分开口径：那张榜比带来多少人，这张比来得有多勤，新人签几次也能露脸。
function checkinBoardHtml(list, rank) {
  const rows = Array.isArray(list) ? list : [];
  const me = (state.user && state.user.username) || '';
  const rk = rank || { rank: 0, points: 0, totalRanked: 0 };
  const top = rows.slice(0, 5);
  const inTop = top.some(r => r.username === me);
  const row = (b, mine) => `
        <div class="board-row${mine ? ' is-me' : ''}">
          <span class="board-rank${b.rank <= 3 ? ' top' : ''}">${b.rank}</span>
          <span class="board-name">${escapeHtml(b.name)}${mine ? '<i class="ck-you">你</i>' : ''}</span>
          <span class="board-num">${b.streak ? `连续 ${b.streak} 天` : '—'}</span>
          <b class="board-pts">${b.points}<i>灯火</i></b>
        </div>`;
  const body = top.length
    ? top.map(b => row(b, b.username === me)).join('')
    : '<div class="board-row"><span class="board-name">还没有人签到，今天签一次就是榜一</span></div>';
  // 前 5 里没有我：底下补一行自己的真实名次，别让人只看得见别人
  const mineRow = (!inTop && rk.rank > 0)
    ? '<div class="ck-board-gap">⋯</div>' + row({
        rank: rk.rank,
        name: (state.user && (state.user.nickname || state.user.username)) || '你',
        points: rk.points,
        streak: (state.user && state.user.checkin && state.user.checkin.streak) || 0
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
  // 微信等 OAuth 建的临时号：登录成功后主动弹一次「账号与密码」引导完善
  maybeNudgePassSetup();
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  state.user = null;
  state.favs = [];
  state.myClaims = [];
  renderAuthBox();
  saveMeSnapshot();   // 退出即清快照，下次刷新首绘直接是「登录 / 注册」
  showToast('已退出登录');
  loadGuestNotices();  // 退出后又变回游客：公告条重新挂出来（已关过的不再弹）
  await refreshMeViewIfActive();   // 退出入口在「我的」页里，同步重画回未登录视图
  // 星标依赖登录态，退出后同步刷新当前列表
  if (location.pathname === '/') loadWorks();
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
          checkin: data.checkin || {}, points: data.points || 0,
          unreadNotices: Number(data.unreadNotices || 0),   // 顶部铃铛未读数
          worksCount: Number(data.worksCount || 0),   // 带上签到状态、积分和作品数，顶部按钮 / 注销弹窗要用
          passSet: data.passSet !== false,            // false = OAuth 建的号（GitHub / Google）还没设过密码
          alias: data.alias || '',                    // 登录别名（自己起的好记登录名）
          aliasNextAt: Number(data.aliasNextAt || 0),
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
// 目前主要是积分变动（管理员送分/扣分）的系统通知：顶部铃铛显示未读数，点开看列表，打开即已读
let noticeTimer = null;
let noticeItems = [];
let noticeUnreadSeen = -1;

// 「你有 N 条新消息」toast 的后半句：PC 走右上角铃铛，手机端头部没有铃铛，入口在「我的」页菜单里
function noticeTipText() {
  return window.innerWidth <= 640 ? '去「我的」页查看' : '点右上角铃铛查看';
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
  if (!noticeItems.length) { box.innerHTML = '<div class="notice-empty">还没有消息，灯火有变动时会在这里通知你</div>'; return; }
  box.innerHTML = noticeItems.map(n => {
    const goto = n.workId || n.link || '';
    // 可对话的通知：精选 / 管理员回复 / 意见反馈的回复
    const hasThread = n.kind === 'featured' || n.kind === 'reply' || n.kind === 'feedback';
    return `
    <div class="notice-item${n.read ? '' : ' is-unread'}${Number(n.delta || 0) > 0 ? ' is-plus' : (Number(n.delta || 0) < 0 ? ' is-minus' : '')}${goto ? ' is-link' : ''}${hasThread ? ' has-thread' : ''}"${n.workId ? ` data-goto="${escapeHtml(n.workId)}"` : (n.link ? ` data-link="${escapeHtml(n.link)}"` : '')}>
      <div class="notice-top">
        <span class="notice-title">${escapeHtml(n.title || '消息')}${goto ? ' <span class="notice-go">查看 ›</span>' : ''}</span>
        ${n.muted ? '<span class="notice-mute">已屏蔽</span>' : ''}
        <span class="notice-time">${fmtNoticeTime(n.createdAt)}</span>
      </div>
      <div class="notice-text">${escapeHtml(n.text || '')}</div>
      ${hasThread ? `<button type="button" class="notice-reply-btn" data-reply="${escapeHtml(n.threadId)}">回复</button>` : ''}
    </div>`;
  }).join('');
  // 带 workId 的消息（评论 / 提问 / 回复通知）点了直接打开对应作品详情
  box.querySelectorAll('.notice-item[data-goto]').forEach(el => {
    el.onclick = () => {
      hideModal($('noticeMask'));
      openWork(el.dataset.goto);
    };
  });
  // 带 link 的公告（如编年史）：点了跳站内页面
  box.querySelectorAll('.notice-item[data-link]').forEach(el => {
    el.onclick = () => {
      hideModal($('noticeMask'));
      location.href = el.dataset.link;
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

async function openNotices() {
  if (!state.user) { openAuth('login'); return; }
  const mask = $('noticeMask');
  $('closeNotice').onclick = () => hideModal(mask);
  $('noticeReadAll').onclick = async () => {
    try { await fetch('/api/me/notices/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* 忽略 */ }
    noticeItems = noticeItems.map(n => ({ ...n, read: true }));
    state.user.unreadNotices = 0;
    noticeUnreadSeen = 0;
    renderNoticeList();
    renderNoticeBadge(0);
  };
  bindMaskClose(mask, () => hideModal(mask));
  showModal(mask);
  renderNoticeList();
  const d = await loadNotices();
  renderNoticeList();
  // 打开即视为已读（列表先渲染出来，再静默标记，避免闪一下）
  if (d && d.unread) {
    try { await fetch('/api/me/notices/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* 忽略 */ }
    noticeItems = noticeItems.map(n => ({ ...n, read: true }));
    state.user.unreadNotices = 0;
    noticeUnreadSeen = 0;
    renderNoticeList();
    renderNoticeBadge(0);
  }
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
          return;
        }
        if (s.status === 'needAccount') {
          // 这个微信还没绑账号：手机上的确认页会引导「绑定已有 / 创建新的」，绑完自动继续，这里只改提示别傻等
          if (status.textContent.indexOf('还没绑定账号') === -1) {
            status.textContent = '这个微信还没绑定账号——请在微信的确认页选择「绑定已有账号」或「创建新账号」，完成后这里会自动登录';
          }
          return;   // 继续轮询：手机上确认完 status 会变成 ok
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

// 付费徽章：默认免费不显示，只有作者标注「需要付费」才出现；选了收费形式则带上
function paidBadgeHtml(w, cls = '') {
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
function avaChip(w) {
  const nm = anamePlain(w);
  const ch = (nm || '?').slice(0, 1).toUpperCase();
  return `<span class="ava-chip" aria-hidden="true">${escapeHtml(ch)}</span>`;
}

function cardHtml(w, opts = {}) {
  const types = typesOf(w);
  const cc = w.commentCount || 0;
  return `
    <div class="card${opts.rank ? ' rank-card' : ''}" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <div class="card-img-wrap">
        ${opts.rank ? `<span class="rank-num${opts.rank <= 3 ? ' top3 r' + opts.rank : ''}" aria-label="第 ${opts.rank} 名">${opts.rank}</span>` : ''}
        <img class="card-img" src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />
        <span class="type-badge" title="${escapeHtml(types.join(' / '))}">${typeTextHtml(w)}</span>
        ${w.pinned ? '<span class="pin-badge">置顶</span>' : ''}
        ${stageBadgeHtml(w, 'card-stage')}
        ${isComing(w) ? '' : `<button class="fav-star ${isFav(w.id) ? 'active' : ''}" data-fav="${w.id}" title="收藏">${ic('fav')}</button>`}
        ${isComing(w) ? '' : `<button class="fav-star card-share" data-share-work="${w.id}" title="分享：生成带二维码的分享图，发朋友圈/小红书都行">${ic('sharecard')}</button>`}
        ${w.owned ? '' : `<button class="fav-star card-block" data-blockwork="${w.id}" data-bw-title="${escapeHtml(w.title)}" title="不再看这个作品（只对你生效）" aria-label="不再看这个作品">${ic('block')}</button>`}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(w.title)}</div>
        <div class="card-meta">
          <span class="card-author">${avaChip(w)}${w.verified ? `<i class="verified" title="认证创作者">${VERIFIED_BADGE}</i>` : ''}<span class="author-name">${escapeHtml(anamePlain(w))}</span></span>
          <span class="card-tags"><span class="card-cat">${escapeHtml(w.category)}</span>${osBadgeHtml(w)}${paidBadgeHtml(w)}</span>
        </div>
        ${opts.metricLabel ? `<div class="card-rank-metric"><span class="card-rank-metric-label">${escapeHtml(opts.metricLabel)}</span><b class="card-rank-metric-val">${opts.metricValue}</b></div>` : ''}
        ${comingMetaHtml(w)}
        <div class="card-meta card-foot">
          <span class="stat-line"><span class="ico s-ico">${ic('heart')}</span>${w.likes} · <span class="ico s-ico">${ic('star')}</span><span class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</span> · <span class="ico s-ico">${ic('eye')}</span>${w.views}${cc ? ` · <span class="ico s-ico">${ic('chat')}</span><span class="cmt-num" data-comment-count="${w.id}" data-count="${cc}" data-prefix="">${cc}</span>` : ''}</span>
          <span>${formatDate(w.createdAt)}</span>
        </div>
      </div>
    </div>`;
}

// 列表视图：一行一个作品，紧凑排版（参考 Product Hunt 风格）
function listHtml(w) {
  const cc = w.commentCount || 0;
  return `
    <div class="work-row" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <img class="row-thumb" src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />
      <div class="row-main">
        <div class="row-title">${w.pinned ? '<span class="pin-badge row-pin">置顶</span>' : ''}${escapeHtml(w.title)}</div>
        ${w.introText ? `<div class="row-intro">${escapeHtml(w.introText)}</div>` : ''}
        <div class="row-meta">${escapeHtml(typeText(w))} · ${w.verified ? `<i class="verified" title="认证创作者">${VERIFIED_BADGE}</i>` : ''}${escapeHtml(aname(w))} · ${escapeHtml(w.category)}${w.openSource === true ? ` · <span class="ico">${ic('lock-open')}</span> 开源` : ''}${w.paid ? ` · <span class="ico">${ic('coin')}</span> ${escapeHtml(PAID_MODELS[w.paidModel] || '付费')}` : ''}</div>
      </div>
      <div class="row-stats">
        <span class="row-stat">${ic('heart')} <b>${w.likes}</b></span>
        <span class="row-stat">${ic('star')} <b class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</b></span>
        <span class="row-stat">${ic('eye')} <b>${w.views}</b></span>
        ${cc ? `<span class="row-stat">${ic('chat')} <b class="cmt-num" data-comment-count="${w.id}" data-count="${cc}" data-prefix="">${cc}</b></span>` : ''}
      </div>
      <button class="row-fav ${isFav(w.id) ? 'active' : ''}" data-fav="${w.id}" title="收藏">${ic('fav')}</button>
      ${w.owned ? '' : `<button class="row-block" data-blockwork="${w.id}" data-bw-title="${escapeHtml(w.title)}" title="不再看这个作品（只对你生效）" aria-label="不再看这个作品">${ic('block')}</button>`}
    </div>`;
}

// 封面统一比例（4:3，cover 裁切，CSS 里定义）：横图、竖版手机截图都裁成同一块画面，
// 列表节奏整齐，也不会再出现「小图 + 大片留白」的观感差异。
// 以前对竖版图做过 contain + 模糊底图的补丁，这里不再需要，已移除。

function bindCards(container) {
  container.querySelectorAll('.card, .work-row, .rk-row').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.fav || e.target.dataset.shareWork) return;
      // 卡片里有一层真实链接（卡片底部 <a class="card-link">）：
      // Ctrl/⌘/Shift 点击交给浏览器在新标签打开完整页面，普通点击仍用弹窗
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openWork(el.dataset.id);
    });
  });
  container.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.fav;
      const added = await toggleFav(id);
      if (added === null) return; // 未登录（已弹登录框）或失败（已提示）
      paintFavButtons(id);
      showToast(added ? '已加入收藏' : '已取消收藏', undefined, 'ok');
    });
  });
  container.querySelectorAll('[data-share-work]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      shareWorkDirect(btn.dataset.shareWork);
    });
  });
  container.querySelectorAll('[data-blockwork]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      askBlockWork(btn.dataset.blockwork, btn.dataset.bwTitle || '', btn);
    });
  });
}

// ---------- 不再看这个作品（只影响我自己的列表，完全不动排序） ----------
// 为什么是「隐藏」而不是「降权」：首页默认按发布时间排，名次是排序的结果不是可加的输入，
// 按名次挪等于篡改发布时间；而且屏蔽是个人偏好，不该改写别人看到的顺序。
// 所以这里只做一件事——把它从我的列表里摘掉，随时可恢复。
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
async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    CATEGORIES = await res.json();
  } catch {
    CATEGORIES = ['全部', '效率工具', '生活助手', '内容创作', '学习教育', '娱乐游戏', '开发工具'];
  }
  if (!CATEGORIES.includes(state.category)) state.category = '全部';
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
  renderFilters();
  if (location.pathname === '/rank' && !isH5View()) renderRankTypePanel();  // 榜单形态下拉的数字与图标补齐
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
let ADS = [];
const adSeen = new Set();   // 本次浏览已上报过曝光的广告 id
let adObserver = null;

// 访客可以关掉不想看的广告：只记在本地，不影响后台统计。
// 按「内容指纹」记而不是只记 id——后台改了这条广告的文案/图片，就算新内容，会重新出现。
const AD_CLOSED_KEY = 'dm_ads_closed';
const AD_CLOSED_TTL = 90 * 24 * 3600e3;   // 90 天后自动过期，免得永久看不见
let adClosedMem = null;                   // localStorage 不可用时的兜底

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

function closeAd(id) {
  const a = ADS.find(x => x.id === id);
  if (!a) return;
  const map = adClosedMap();
  map[id] = { fp: adFingerprint(a), ts: Date.now() };
  saveAdClosed(map);
  // 关了什么告诉服务端一声：后台统计「多少人不想看这条」（本地照旧记 90 天不再出现）
  adTrack(id, 'close');
  renderAdSlot(document.querySelector(`[data-ad-slot="${a.slot}"]`), a.slot);
  // 首页第一格不是 .ad-slot 容器，是插进作品列表的一张原生卡：单独重挂。
  // 顺手按新的 pageSize 把作品补满这一格（listPromoAd 从此会返回 null，多拉一件作品）。
  if (a.slot === 'list-first') {
    if (state.page === 1 && isPlainListView()) loadWorks(true);
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
  } catch { ADS = []; }
  renderAllAdSlots();
  mountListPromo();   // 第一格宣传卡跟着广告数据一起刷新
}

function adHtml(a, opts) {
  // 三种形式：作品推荐（用户用灯火兑换的自荐位：缩略图+标题+一句话的原生小条）｜
  // 图文（图片铺底的大横幅）｜纯文字（浅色卡片，不发图片请求）
  const isText = a.kind === 'text';
  const hasImg = !isText && a.image;
  // 推荐（积分兑换）且不跳外链 = 推广的是站内作品：改走原生作品小条样式，
  // 不再套深色大横幅——观感小、像榜单自己的推荐，点进去还是作品详情
  const isWork = a.source === 'redeem' && !a.extUrl;
  // compact = 半宽并排时用（标题一行、描述铺满第二行），见 style.css 的 .ad-compact
  const compact = !!(opts && opts.compact);
  const img = hasImg && !isWork
    ? `<img class="ad-bg" src="${escapeHtml(a.image)}" alt="" loading="lazy" />`
    : '';
  const workThumb = isWork
    ? (a.image
      ? `<img class="ad-work-thumb" src="${escapeHtml(a.image)}" alt="" loading="lazy" />`
      : `<span class="ad-work-thumb is-empty">${ic('megaphone')}</span>`)
    : '';
  return `<div class="ad-card-wrap">
    <a class="ad-card${hasImg && !isWork ? ' has-img' : ''}${isText ? ' ad-text-card' : ''}${isWork ? ' ad-work' : ''}${compact ? ' ad-compact' : ''}" href="${escapeHtml(a.url)}"
      target="_blank" rel="noopener nofollow sponsored" data-ad="${escapeHtml(a.id)}">
      ${img}${workThumb}
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

// 推荐小条的缩略图挂了（图片被删 / 网络抖动）别露破图图标：换成喇叭占位，布局不塌。
// error 事件不冒泡，必须在捕获阶段接
document.addEventListener('error', e => {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains('ad-work-thumb')) return;
  const ph = document.createElement('span');
  ph.className = 'ad-work-thumb is-empty';
  ph.innerHTML = ic('megaphone');
  el.replaceWith(ph);
}, true);

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

function renderAdSlot(el, slot) {
  if (!el) return;
  clearInterval(el._adTimer);           // 重新渲染前先停掉旧的轮播
  el._adTimer = null;
  // 详情位特殊：点开的是自己的作品时不展示（给自己推自己的广告很怪）
  if (slot === 'detail' && state.currentWork && state.currentWork.owned) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  const closed = adClosedMap();
  let list = ADS.filter(a => a.slot === slot && !isAdClosed(a, closed));
  // 详情位：正在浏览的作品不给自己打广告（推荐恰好推广的就是当前作品时排除）
  if (slot === 'detail' && state.currentWork && state.currentWork.id) {
    const curUrl = '/w/' + encodeURIComponent(state.currentWork.id);
    list = list.filter(a => a.url !== curUrl);
  }
  if (!list.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  if (slot === 'rank') {
    // 榜单顶部的定位是「推荐站内作品」：只要有人在投的作品推荐（推荐/积分兑换），
    // 就只在这些里挑，运营横幅退位；同组内仍随机，各家机会均等。
    // 一条作品推荐都没有时才回落到运营广告，位置不留白。
    const redeemList = list.filter(a => a.source === 'redeem');
    if (redeemList.length) list = redeemList;
  }
  if (slot === 'detail' || slot === 'rank') {
    // 详情位 / 榜单页顶部：每次渲染随机挑，各家曝光机会均等。
    // 刻意不走等时轮播——轮播里第一条立刻展示先吃满曝光，排后面的可能一次都轮不到，
    // 同样灯火买到的额度消耗速度会差一大截。
    // 例外：刚兑换成功的作者，本机 10 分钟内优先看到自己那条（setMyAdPreview），
    // 用来验证投放是否生效；其他访客仍走随机，不受影响。
    const mine = myAdPreview(slot, list);
    if (slot === 'detail') {
      // 详情位（作品详情页底栏）宽屏一次并排 2 条（2026-11-06 由单条改 2 条）：
      // 每条各自独立曝光/关闭；窄屏或不足 2 条退回单条通栏，保持原观感。
      if (list.length > 1 && window.innerWidth > 900) {
        const pick = mine ? [mine] : [];
        const rest = list.filter(a => !mine || a.id !== mine.id).slice();
        while (pick.length < 2 && rest.length) {
          pick.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
        }
        el.innerHTML = `<div class="ad-row2">${pick.map(a => adHtml(a, { compact: true })).join('')}</div>`;
      } else {
        el.innerHTML = adHtml(mine || list[Math.floor(Math.random() * list.length)]);
      }
    } else if (slot === 'rank' && list.length > 1 && window.innerWidth > 900) {
      // 榜单位在 PC 宽屏一次并排 2-4 条（把右侧那片空白用起来，每条各自独立曝光/关闭）：
      // 视口 ≥1180 放 4 条（容器 1200，每张约 275px），900-1180 放 3 条，1 条退回通栏；
      // 窄屏仍是单条，避免撑高首屏。并排的每条都真实可见 → 一次浏览给 N 家各扣一次额度，
      // 同屏条数就是消耗倍率，所以 4 条能切实加快灯火消耗（2026-11-06 3 → 4）。
      const maxCols = window.innerWidth >= 1180 ? 4 : 3;
      const want = Math.min(maxCols, list.length);
      const pick = mine ? [mine] : [];
      const rest = list.filter(a => !mine || a.id !== mine.id).slice();
      while (pick.length < want && rest.length) {
        pick.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
      }
      const cols = pick.length > 3 ? ' cols-4' : pick.length > 2 ? ' cols-3' : '';
      el.innerHTML = `<div class="ad-row2${cols}">${pick.map(a => adHtml(a, { compact: true })).join('')}</div>`;
    } else {
      el.innerHTML = adHtml(mine || list[Math.floor(Math.random() * list.length)]);
    }
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
  observeAds(el);
}

function renderAllAdSlots() {
  document.querySelectorAll('[data-ad-slot]').forEach(el => renderAdSlot(el, el.dataset.adSlot));
}

// ---------- 首页第一格：推荐卡（独占位，用原生卡片而不是横幅） ----------
// 这是积分兑换买来的位置，卡片样式跟普通作品卡一致，只多一个「宣传」角标，
// 点进去还是作品详情页，不做站外跳转——观感上不像广告，也不会把首页撑坏。
function isPlainListView() {
  return !state.favoritesOnly && !state.q &&
    state.category === '全部' && state.type === '全部' && state.openSource === '全部';
}

function listPromoAd() {
  if (!isPlainListView()) return null;
  const a = (ADS || []).find(x => x.slot === 'list-first' && (x.source === 'redeem' || x.source === 'admin'));
  if (!a) return null;
  // 访客明确叉过、或 7 天内看过 3 次：这一格让回普通作品，不再插推荐卡。
  // pageSizeOf() 也走这里，隐藏后会多拉一件作品，网格照样对齐。
  if (isAdClosed(a, adClosedMap())) return null;
  if (isAdViewCapped(a, adViewMap())) return null;
  return a;
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
      ${a.image ? `<img class="row-thumb" src="${escapeHtml(a.image)}" alt="${escapeHtml(a.title)}" loading="lazy" />` : `<span class="row-thumb row-thumb-empty"><span class="ico">${ic('megaphone')}</span></span>`}
      <div class="row-main">
        <div class="row-title"><span class="promo-row-flag">推荐</span>${escapeHtml(a.title)}</div>
        ${a.desc ? `<div class="row-intro">${escapeHtml(a.desc)}</div>` : ''}
        <div class="row-meta">${a.source === 'redeem' ? '作者自荐 · 推荐位' : '广告'} · ${a.extUrl ? '打开链接 ↗' : '看看 →'}</div>
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
        ${a.image ? `<img class="card-img" src="${escapeHtml(a.image)}" alt="${escapeHtml(a.title)}" loading="lazy" />` : `<div class="promo-noimg"><span class="ico">${ic('megaphone')}</span></div>`}
        <span class="promo-flag">推荐</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(a.title)}</div>
        ${a.desc ? `<div class="promo-desc">${escapeHtml(a.desc)}</div>` : ''}
        <div class="card-meta promo-foot">
          <span class="promo-tip">${a.source === 'redeem' ? '作者自荐 · 推荐位' : '广告'}</span>
          <span class="promo-go">${a.extUrl ? '打开链接 ↗' : '看看 →'}</span>
        </div>
      </div>
      ${xBtn}
    </${internal ? 'div' : 'a'}>`;   // 站内卡是 <div>，外链卡才是 <a>，别一律用 </a> 收尾
}

// 插到第一格（第一件是置顶作品时排它后面，别抢运营手动置顶的位）
function mountListPromo() {
  if (!gallery) return;
  const old = gallery.querySelector('.promo-card, .promo-row');
  if (old) old.remove();
  const a = listPromoAd();
  if (!a) return;
  bumpAdView(a);   // 真的插进首屏才算「看过一次」，同一天只记一次
  const first = gallery.querySelector('.card, .work-row');
  const wrap = document.createElement('div');
  wrap.innerHTML = promoCardHtml(a);
  const node = wrap.firstElementChild;
  if (!node) return;
  if (first && first.querySelector('.pin-badge') && first.nextSibling) gallery.insertBefore(node, first.nextSibling);
  else if (first) gallery.insertBefore(node, first);
  else gallery.appendChild(node);

  // 推荐卡：点开作品详情；运营外链卡本身是 <a>，浏览器自己处理
  if (node.classList.contains('promo-ext')) {
    node.addEventListener('click', () => {
      adTrack(node.dataset.ad, 'click');
    });
  } else {
    node.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // 交给浏览器开新标签
      e.preventDefault();
      adTrack(node.dataset.ad, 'click');
      if (node.dataset.id) openWork(node.dataset.id);
    });
  }
  // 真正的曝光埋点：卡滚进视野才算一次，同一次浏览只报一次
  if (adObserver) adObserver.observe(node);
  else observeAds(gallery);
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
  $('detailImg').src = list[galState.idx];
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
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5)
      setDetailImage(galState.idx + (dx < 0 ? 1 : -1));
  }, { passive: true });
})();
// 精选入选理由：告诉用户「它为什么被选进来」，而不是只丢一堆数据
const FEAT_REASONS = {
  pick: { text: '本周热门', cls: 'is-pick', tip: '综合热度不错的作品之一' },
  like: { text: '人气最高', cls: 'is-like', tip: '近 7 天点赞最多的作品之一' },
  fav: { text: '收藏飙升', cls: 'is-fav', tip: '近 7 天被收藏最多的作品之一' },
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

// 「本周精选」一行 10 个：近 7 天打开最多 + 新增收藏最多（收藏＝关注）
// 精选卡版式：首页「本周精选」和发现页共用（点击开详情由调用方绑定）
function featCardHtml(w, i) {
  return `
      <div class="featured-card" data-id="${w.id}">
        <span class="feat-no">${i + 1}</span>
        <img src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />
        <div class="featured-body">
          <div class="featured-title" title="${escapeHtml(w.title)}">${escapeHtml(w.title)}</div>
          <div class="feat-sub">${featReasonHtml(w)}${featAuthorHtml(w)}</div>
          ${w.introText ? `<div class="featured-intro">${escapeHtml(w.introText)}</div>` : ''}
          <div class="featured-meta" title="近 7 天：详情页被打开 ${w.pv7 || 0} 次，共 ${w.uv7 || 0} 位访客打开过（同一人只算 1 个，作者本人打开不计）"><span class="fm-i" title="近 7 天被打开的次数：同一个人反复打开也会累加"><span class="ico s-ico">${ic('eye')}</span>${w.pv7 || 0} 次打开</span><span class="fm-i" title="近 7 天有多少人打开过：同一个人只算 1 个，作者本人打开不计"><span class="ico s-ico">${ic('person')}</span>${w.uv7 || 0} 人看过</span><span class="fm-i" title="被收藏次数"><span class="ico s-ico">${ic('star')}</span>${w.favs || 0}</span></div>
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
      el.addEventListener('click', () => openWork(el.dataset.id)));
    setupFeatInfo();
    setupFeatCarousel();
    row.scrollLeft = keepLeft;
    updateFeatNav();
  } catch { /* ignore */ }
}

// 精选规则说明（ⓘ）：桌面端悬停即弹（CSS），触屏/键盘走点按开关；点空白处或 Esc 关闭
function setupFeatInfo() {
  const wrap = $('featInfo'), btn = $('featInfoBtn');
  if (!wrap || !btn || btn._infoInit) return;
  btn._infoInit = 1;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
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
    row.addEventListener('pointerdown', e => { down = { x: e.clientX, l: row.scrollLeft }; });
    window.addEventListener('pointermove', e => {
      if (!down) return;
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
// 和主列表分开放：主列表只收真正上线的作品，这里收「还在做」和「等平台审核」的，
// 用「上线提醒我」把这份期待留到上线当天（上线时服务端会给所有订阅者发站内消息）。
let upcomingSig = '';

function upcomingCardHtml(w) {
  const st = stageOf(w);
  const pct = typeof w.progress === 'number' ? w.progress : 0;
  const eta = w.eta
    ? `预计 ${w.eta.slice(5).replace('-', '/')} 上线`
    : (st === 'reviewing' ? '等平台审核通过' : '上线时间待定');
  const note = (w.progressLog && w.progressLog[0] && w.progressLog[0].text) || w.introText || '';
  return `
    <div class="up-card is-${st}" data-id="${escapeHtml(w.id)}">
      <div class="up-img">
        <img src="${escapeHtml(w.thumb)}" alt="${escapeHtml(w.title)}" loading="lazy" />
        ${stageBadgeHtml(w, 'up-stage')}
      </div>
      <div class="up-body">
        <div class="up-title">${escapeHtml(w.title)}</div>
        <div class="up-note">${escapeHtml(note)}</div>
        ${st === 'wip' ? `<div class="coming-bar"><span style="width:${pct}%"></span></div>` : ''}
        <div class="up-foot">
          <span class="up-eta">${escapeHtml(eta)}</span>
          <button type="button" class="up-watch${w.watched ? ' is-on' : ''}" data-watch="${escapeHtml(w.id)}">${w.watched ? '✓ 已订阅' : `<span class="ico">${ic('bell')}</span> 提醒我`}${w.watchCount ? ` · ${w.watchCount}` : ''}</button>
        </div>
      </div>
    </div>`;
}

async function loadUpcoming() {
  const sec = $('upcomingSection'), row = $('upcomingRow');
  if (!sec || !row) return;
  try {
    const d = await (await fetch('/api/upcoming?limit=8')).json();
    const items = (d && d.items) || [];
    // 签名一致就不动 DOM：静默刷新时不打断轮播位置和用户操作
    const sig = items.map(w => `${w.id}:${w.watchCount}:${w.watched ? 1 : 0}:${w.progress}`).join('|');
    if (sig === upcomingSig) return;
    upcomingSig = sig;
    if (!items.length) { sec.style.display = 'none'; row.innerHTML = ''; return; }
    const left = row.scrollLeft;
    row.innerHTML = items.map(upcomingCardHtml).join('');
    sec.style.display = '';
    bindUpcoming(row);
    setupUpCarousel();
    row.scrollLeft = left;
    updateUpNav();
  } catch { sec.style.display = 'none'; }
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

function setupUpCarousel() {
  const row = $('upcomingRow');
  const prev = $('upPrev'), next = $('upNext');
  if (!row || !prev || !next) return;
  const step = () => {
    const card = row.querySelector('.up-card');
    return card ? (card.offsetWidth + 14) * 2 : 400;
  };
  prev.onclick = () => row.scrollBy({ left: -step(), behavior: 'smooth' });
  next.onclick = () => row.scrollBy({ left: step(), behavior: 'smooth' });
  row.onscroll = updateUpNav;
  if (!row._dragInit) {
    row._dragInit = 1;
    let down = null;
    row.addEventListener('pointerdown', e => { down = { x: e.clientX, l: row.scrollLeft }; });
    window.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 6) { row.classList.add('dragging'); row.scrollLeft = down.l - dx; }
    });
    window.addEventListener('pointerup', () => { down = null; row.classList.remove('dragging'); });
  }
  updateUpNav();
}

function updateUpNav() {
  const row = $('upcomingRow');
  if (!row || !row.children.length) return;
  const max = row.scrollWidth - row.clientWidth;
  const TOL = 24;
  $('upPrev').disabled = row.scrollLeft <= TOL;
  $('upNext').disabled = row.scrollLeft >= max - TOL;
  const nav = document.querySelector('.upcoming-head .featured-nav');
  if (nav) nav.style.visibility = max <= 4 ? 'hidden' : 'visible';
}

// 后台改了精选/置顶/审核/删除 → 前台静默同步（不整页重载、不打断浏览）
// 同浏览器多标签：BroadcastChannel + localStorage 双通道即时通知；其他设备：切回标签页/聚焦时拉一次
(function setupSilentSync() {
  const refresh = () => {
    // 只刷新精选区（数据没变连 DOM 都不动）＋详情弹窗里的精选标签，
    // 不重载页面、不打断浏览，滚动位置和轮播位置都保留。
    // 榜单/酒馆/作者页上没有精选区，别白拉两个接口（pageshow 在首次加载时也会触发一次）
    const needFeat = location.pathname === '/' || location.pathname.startsWith('/w/');
    if (!needFeat) return;
    loadFeatured();
    loadUpcoming();
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

// 首次进页面数据还没回来时，先铺一排骨架占位卡，避免空容器导致版面错乱
function renderSkeleton() {
  if (gallery.children.length) return; // 已有内容（切换筛选等场景）就不动
  $('workCount').textContent = '加载中…';
  $('empty').style.display = 'none';
  const n = pageSizeOf();  // 骨架条数 = 一页条数（4 行），加载完不会突然跳高/收缩
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<div class="sk-card" aria-hidden="true">
      <div class="sk-img"></div>
      <div class="sk-body">
        <div class="sk-line" style="width:72%"></div>
        <div class="sk-line" style="width:45%"></div>
        <div class="sk-foot"><span class="sk-line" style="width:30%"></span><span class="sk-line" style="width:18%"></span></div>
      </div>
    </div>`;
  }
  gallery.innerHTML = html;
}

async function loadWorks(reset = true) {
  applyGalleryCols();   // 先套上列数选择，下面量栅格列数才准（首屏在样式生效前也会走这里）
  // 第 1 页要给推荐卡留格：广告数据必须先到手，pageSize 才能算准。
  // 之前 route() 比 loadAds() 先跑，listPromoAd() 读到的是空 ADS，
  // 有推荐时第 1 页仍按满页拉，推荐卡插进来就多出一条尾巴（16+1=17）。
  if (reset && state.page === 1 && isPlainListView() && !adsReady) await ensureAds();
  if (reset) { state.page = 1; renderSkeleton(); } // 先不清空容器，等数据到达再替换，避免页面高度塌陷把滚动位置钳回顶部
  const params = new URLSearchParams({
    sort: state.sort, type: state.type, category: state.category,
    page: state.page, pageSize: pageSizeOf()
  });
  if (state.q) params.set('q', state.q);
  if (state.openSource === '开源') params.set('os', 'open');
  else if (state.openSource === '闭源') params.set('os', 'closed');
  const rangeParam = RANGE_PARAM[state.range];
  if (rangeParam) params.set('range', rangeParam);

  try {
    let data;
    if (state.favoritesOnly) {
      // 收藏存在账号上：未登录直接空列表，登录后按 state.favs 的收藏时间倒序排
      if (!state.user) {
        data = { items: [], total: 0, hasMore: false };
      } else {
        const all = await (await fetch('/api/works?fav=1&pageSize=all&sort=latest')).json();
        const map = new Map((all.items || []).map(w => [w.id, w]));
        const items = (state.favs || []).map(id => map.get(id)).filter(Boolean);
        data = { items, total: items.length, hasMore: false };
      }
    } else {
      data = await (await fetch('/api/works?' + params)).json();
    }

    const html = data.items.map(w => state.view === 'list' ? listHtml(w) : cardHtml(w)).join('');
    gallery.classList.toggle('list-mode', state.view === 'list');
    gallery.removeAttribute('aria-busy');
    if (reset) gallery.innerHTML = ''; // 数据到手再替换，旧内容保留期间页面高度稳定
    gallery.insertAdjacentHTML('beforeend', html);
    bindCards(gallery);

    const emptyP = $('empty').querySelector('p');
    if (emptyP) emptyP.textContent = state.favoritesOnly
      ? '还没有收藏的作品——遇到喜欢的点卡片右上角 ★，也可以点亮一盏灯火支持 TA'
      : '没有找到作品，换个关键词或分类试试？';
    $('empty').style.display = gallery.children.length ? 'none' : 'block';
    $('workCount').textContent = `共 ${data.total} 件`;
    $('listTitle').textContent = state.favoritesOnly
      ? '我的收藏'
      : state.q ? `搜索「${state.q}」` : `${state.category === '全部' ? '全部作品' : state.category}`;
    state.hasMore = !!data.hasMore;
    $('loadMore').style.display = state.hasMore ? 'inline-block' : 'none';
    if (reset) mountListPromo();   // 只在第一页插第一格宣传，加载更多不重复插
  } catch {
    // 只剩骨架屏说明是首次加载就失败：清掉占位、给出空态，别让灰卡一直闪
    if ([...gallery.children].every(el => el.classList.contains('sk-card'))) gallery.innerHTML = '';
    $('empty').style.display = gallery.children.length ? 'none' : 'block';
    if (!$('workCount').textContent.trim() || $('workCount').textContent === '加载中…') $('workCount').textContent = '';
    showToast('加载失败，请检查网络或服务状态', undefined, 'err');
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
// 排序文案：tab 上短（最新/最热），面板里跟小程序一致（最新发布/最多点赞）
const SORT_OPTS = [{ value: 'latest', label: '最新发布' }, { value: 'hot', label: '最多点赞' }];

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
  const conf = [
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
        else { state.category = opt.dataset.v; state.favoritesOnly = false; }
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
    {
      kind: 'type', current: () => state.type, active: () => state.type !== '全部',
      text: () => state.type === '全部' ? '形态' : state.type,
      options: () => asOpts(typeOpts), apply: v => { state.type = v; }
    },
    {
      kind: 'category', current: () => state.category, active: () => state.category !== '全部',
      text: () => state.category === '全部' ? '分类' : state.category,
      options: () => asOpts(catOpts),
      apply: v => { state.category = v; state.favoritesOnly = false; }
    },
    {
      kind: 'os', current: () => state.openSource, active: () => state.openSource !== '全部',
      text: () => state.openSource === '全部' ? '开源' : state.openSource,
      options: () => asOpts(['全部', '开源', '闭源']), apply: v => { state.openSource = v; }
    },
    {
      kind: 'range', current: () => state.range, active: () => state.range !== '全部',
      text: () => state.range === '全部' ? '时间' : RANGE_LABEL[state.range],
      options: () => RANGE_OPTS.map(v => ({ value: v, label: RANGE_LABEL[v] })),
      apply: v => { state.range = v; }
    },
    {
      kind: 'sort', current: () => state.sort, active: () => false,
      text: () => state.sort === 'hot' ? '最热' : '最新',
      options: () => SORT_OPTS,
      apply: v => { state.sort = v; state.favoritesOnly = false; }
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
const DEFAULT_TITLE = `${SITE_NAME} - 让好作品被更多人看见`;

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

// 平滑滚到作品列表区（「我的收藏」标题处）。
// 只在开启收藏过滤时调用；延迟等路由/骨架屏渲染完，避免滚了个寂寞或被高度塌陷拽回去。
// 若列表本来就在视野顶部，scrollIntoView 只是微量校正，不会有跳动感。
function scrollWorksHeadSoon() {
  setTimeout(() => {
    const head = $('worksHead');
    if (head) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 350);
}

function closeAllViews() {
  ['homeView', 'rankView', 'wishView', 'miniView', 'guideView', 'howtoView', 'authorView', 'promoteView', 'discoverView', 'meView'].forEach(id => { $(id).style.display = 'none'; });
  hideModal(detailModal);
  closeQrZoom();   // 详情被关掉时二维码放大层一起收，别留一张盖住全屏的图
}

// 导航高亮：榜单页亮「榜单」，造梦酒馆页亮「造梦酒馆」，外宣指南页亮「外宣指南」，其余按当前排序/收藏态亮对应按钮
function updateNavActive() {
  const onRank = location.pathname === '/rank';
  const onWish = location.pathname === '/bar';
  const onGuide = location.pathname === '/guide';
  const onMini = location.pathname === '/mini';
  // 移动端底部 Tab 高亮：橱窗=首页/作品详情/作者页，其余按路径精确匹配
  const p = location.pathname;
  const tabKey = p === '/discover' ? 'discover'
    : p === '/me' ? 'me'
    : onRank ? 'rank'
    : (p === '/' || p.startsWith('/w/') || p.startsWith('/u/')) ? 'home'
    : (onWish || onGuide || onMini) ? ''   // 酒馆/指南/小程序专栏不占 Tab，全部不亮
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
  // PC 排序按钮的选中态跟着 state.sort（H5 上这个按钮不显示，同步了也看不到）
  document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
    b.classList.toggle('active', !onRank && !onWish && !onGuide && b.dataset.sort === state.sort));
  const favDrop = $('favDrop');
  if (favDrop) favDrop.classList.toggle('active', !onRank && !onWish && !onGuide && state.favoritesOnly);
}

// ---------- 发现页（移动端 Tab）：精选 + 平台专栏 ----------
// Android/iOS 顺序按手机机型排（UA 判断）；各专栏取热度前 6，空的自动隐藏，不占位
// ---------- 发现页（对齐小程序版式）：顶部胶囊切专栏，栏头 + 说明 + 数据条 + 双列卡片 ----------
// 顺序按用户要求：精选 → iOS → 安卓 → 小程序（2026-11-05）；Web 专区随后加入（2026-11-06）
const DISC_COLS = [
  { key: '精选', label: '精选', eyebrow: 'WEEKLY FEATURED', title: '本周精选', btn: '查看详情', statUnit: '件精选作品',
    desc: '按近 7 天访客、点赞、收藏的热度挑出来的作品，每天换一批顺序，总有一款合胃口。' },
  { key: 'iOS', label: 'iOS', eyebrow: 'iOS COLUMN', title: 'iOS 专栏', btn: '立即体验', statUnit: '个 iOS 作品',
    desc: 'iPhone 上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。' },
  { key: 'Android', label: '安卓', eyebrow: 'ANDROID COLUMN', title: '安卓专栏', btn: '立即体验', statUnit: '个安卓作品',
    desc: '安卓手机上的精选作品，点「立即体验」直达详情页，里面有对应的下载入口和完整介绍。' },
  { key: '小程序', label: '小程序', eyebrow: 'MINI PROGRAM COLUMN', title: '小程序专栏', btn: '扫码体验', statUnit: '个小程序', statScan: '个能扫码体验',
    desc: '小程序在浏览器里点不开，所以这里挑出来的作品都备了小程序码——点卡片上的「扫码体验」，长按就能识别，也能一键存到相册。' },
  { key: 'Web', label: 'Web', eyebrow: 'WEB COLUMN', title: 'Web 专区', btn: '立即体验', statUnit: '个 Web 作品',
    desc: '浏览器里打开就能用的网页作品，电脑手机都通吃。点「立即体验」直达详情页，里面有对应的网址入口和完整介绍。' }
];
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
  return `
    <div class="card disc-card" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <div class="card-img-wrap">
        <img class="card-img" src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />
        ${col.key === '小程序' && scan ? '<span class="disc-scan-badge">可扫码</span>' : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(w.title)}</div>
        ${w.introText ? `<div class="disc-intro">${escapeHtml(w.introText)}</div>` : ''}
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
  const drawChips = () => {
    chips.innerHTML = DISC_COLS.map(c =>
      `<button type="button" class="disc-chip${c.key === discTab ? ' active' : ''}" data-disc-tab="${c.key}" role="tab" aria-selected="${c.key === discTab}">${c.label}</button>`).join('');
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
  const col = DISC_COLS.find(c => c.key === discTab);
  if (discLoaded === col.key && discCache[col.key]) return;
  discLoaded = col.key;
  $('discPanel').innerHTML = '<div class="comment-empty">加载中…</div>';
  try {
    if (!discCache[col.key]) {
      if (col.key === '精选') {
        const d = await (await fetch('/api/featured', { cache: 'no-store' })).json();
        const items = Array.isArray(d.list) ? d.list : [];
        discCache[col.key] = { items, total: items.length };
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
        <button type="button" class="me-tile" id="meSubmit"><span class="me-tile-ico">${ic('edit', 20)}</span>提交作品</button>
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
        <span class="me-ava2 me-ava2-user">${escapeHtml((name || '?').slice(0, 1).toUpperCase())}</span>
        <div class="me-hero-main">
          <b>${escapeHtml(name)}</b>
          <span>@${escapeHtml(state.user.username || '')}</span>
        </div>
      </div>
      <div class="me-stats">
        <a class="me-stat" href="/u/${encodeURIComponent(state.user.username)}" data-nav><b>${works}</b><span>我的作品</span></a>
        <i class="me-stat-sep"></i>
        <button type="button" class="me-stat" id="meStatFavs"><b>${favs}</b><span>我的收藏</span></button>
        <i class="me-stat-sep"></i>
        <button type="button" class="me-stat" id="mePoints" title="灯光明细：每笔从哪来、花到哪去"><b>${pts}</b><span>灯火 ›</span></button>
      </div>
    </div>
    <div class="me-tiles">
      <button type="button" class="me-tile" id="meSubmit"><span class="me-tile-ico">${ic('edit', 20)}</span>提交作品</button>
      <a class="me-tile" href="/u/${encodeURIComponent(state.user.username)}" data-nav><span class="me-tile-ico">${ic('home', 20)}</span>我的主页</a>
      <button type="button" class="me-tile" id="meStats"><span class="me-tile-ico">${ic('bars', 20)}</span>作品数据</button>
      <button type="button" class="me-tile" id="meFav"><span class="me-tile-ico">${ic('fav', 20)}</span>我的收藏</button>
    </div>
    <div class="me-ck-card">
      <div class="me-ck-left">
        <b>每日签到激励</b>
        <span>${ck.streak ? `连续签到 ${ck.streak} 天` : '今天还没签到'}</span>
      </div>
      <span class="me-ck-lamp">${ic('lamp')}</span>
      <button type="button" class="me-ck-btn me-checkin${ckDone ? ' is-done' : ''}" id="meCheckin"${ckDone ? ' disabled' : ''}>${ckDone ? '今日已签 ✓' : `签到 +${ck.todayPoints || 2} 灯火`}</button>
      <p class="me-ck-tip">灯火可兑换推荐位曝光</p>
    </div>
    <div class="me-quick">
      <button type="button" class="me-quick-card" id="meNotices"><span class="me-quick-ico">${ic('bell', 20)}</span>站内消息${unread ? `<span class="me-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</button>
      <button type="button" class="me-quick-card" id="meGift"><span class="me-quick-ico">${ic('gift', 20)}</span>兑换码<br />领灯火</button>
      <button type="button" class="me-quick-card" id="mePromo" title="用灯火给自己的作品买曝光位"><span class="me-quick-ico">${ic('promo', 20)}</span>推荐<br />自己的作品</button>
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
      <button type="button" class="me-foot-btn me-logout" id="meLogout">${ic('logout', 15)} 退出登录</button>
    </div>`;
  // 手机端头部已移掉，提交入口收进「我的」页（复用「＋ 提交作品」的完整打开逻辑：草稿恢复等）
  $('meSubmit').onclick = () => $('openUpload').click();
  // 收藏：已在收藏筛选态就直接回橱窗，否则走 toggleFavorites（未登录会先弹登录）
  const goFavs = () => { if (!state.favoritesOnly) toggleFavorites(); else navigate('/'); };
  $('meFav').onclick = goFavs;
  $('meStatFavs').onclick = goFavs;
  $('meStats').onclick = () => openStats('data');
  $('mePoints').onclick = () => openStats('points');
  $('meNotices').onclick = openNotices;
  $('meGift').onclick = openGiftCode;
  $('mePromo').onclick = openRedeem;
  // 我的页签到按钮：之前漏绑 onclick，点了没反应；签到成功后原地重渲染本页（按钮变「今日已签」、连签天数更新）
  $('meCheckin').onclick = () => doCheckin(() => renderMePage());
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
            <img class="me-fav-thumb" src="${w.thumb}" alt="" loading="lazy" />
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
  const body = { path: p };
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
      body: JSON.stringify({ path: location.pathname + location.search, workId: id, site: false }), keepalive: true
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
  // 首屏直达的标记用完即摘：之后视图切换完全由下面的内联 display 决定
  // （style.css 里那几条是按 data-page 写的 !important，不摘会压住内联样式）
  document.documentElement.removeAttribute('data-page');
  trackPageView();
  const path = location.pathname;
  // 从详情弹窗退回：列表视图原样保留，不重新拉数据（分页、滚动位置、「展示更多」都不动）
  const keepList = skipNextListReload;
  skipNextListReload = false;
  const keepScrollY = keepList ? window.scrollY : 0; // 视图隐藏再显示会把滚动位置钳回顶部，这里记下来还原
  const restoreScroll = () => { if (keepList) requestAnimationFrame(() => window.scrollTo(0, keepScrollY)); };
  closeAllViews();

  const isWorkPage = path.startsWith('/w/');
  // 服务端渲染整页的静态页：/chronicle（编年史）、/rules（作品规范）、/install（安装到桌面）、/invite（邀请收录）——SPA 只负责藏首页、给标题
  const isChronicle = path === '/chronicle';
  const isStaticPage = isChronicle || path === '/rules' || path === '/install' || path === '/invite';
  document.body.classList.toggle('on-work', isWorkPage);
  if (!isWorkPage && !isStaticPage) removeSeoBlock();

  if (isStaticPage) {
    const seoEl = document.querySelector('main > #seoContent');
    if (seoEl) {
      seoEl.style.display = '';
      $('homeView').style.display = 'none';
      setTitle(isChronicle ? '造梦编年史' : (path === '/install' ? '安装到桌面' : (path === '/invite' ? '邀请你来收录作品' : '作品规范')));
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
    // 支持 /rank?period=week&by=likes&type=Web 这类可分享、可被收录的筛选链接（H5 / PC 共用 period·by·type）
    const rqs = new URLSearchParams(location.search);
    const rt = rqs.get('type'); if (rt) { rankH5.type = rt; rankState.type = rt; }
    const rp = rqs.get('period'); if (['week', 'month', 'all'].includes(rp)) { rankH5.period = rp; rankState.period = rp; }
    const rb = rqs.get('by'); if (['hot', 'likes', 'favs', 'tips', 'uv'].includes(rb)) { rankH5.by = rb; rankState.by = rb; }
    if (!keepList) loadRankView(); // 不重置筛选，保留用户上次选的那一套
    // 榜单页顶部推荐位：每次进入榜单重抽一条（多条投放时各家机会均等，不做顺序轮播）；
    // 投放者本机的自验证优先级在 renderAdSlot 内处理，这里不额外判断
    renderAdSlot(document.querySelector('[data-ad-slot="rank"]'), 'rank');
    updateNavActive();
    restoreScroll();
    return;
  }
  if (path === '/bar') {
    $('wishView').style.display = 'block';
    setTitle('造梦酒馆');
    setupWish();
    if (!keepList) loadIdeas(30);
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
  $('homeView').style.display = 'block';
  setTitle(state.q ? `搜索「${state.q}」` : '');
  if (!keepList) {
    loadFeatured();
    loadUpcoming();
    loadWorks();
  }
  updateNavActive();
  restoreScroll();
}

// ---------- 作者主页 ----------
async function loadAuthor(name) {
  // 先渲染再拉数据：自己的页面直接显示昵称，别先闪一下账号名
  const first = (state.user && state.user.username === name && state.user.nickname) || name;
  $('authorName').textContent = '@' + first;
  $('authorAvatar').textContent = first.slice(0, 1).toUpperCase();
  setTitle(`@${name} 的作品`);
  try {
    const data = await (await fetch('/api/authors/' + encodeURIComponent(name))).json();
    // 有昵称就显示昵称（地址栏仍是 /u/账号，链接不会失效）
    const shown = data.displayName || name;
    // 认证创作者：名字旁挂认证徽章（和卡片/详情一致），统计行不再重复放认证标签
    $('authorName').innerHTML = '@' + escapeHtml(shown) +
      (data.verified ? ` <i class="verified author-verified" title="认证创作者">${VERIFIED_BADGE}</i>` : '') +
      (Array.isArray(data.tags) ? data.tags.map(t => `<i class="author-tag" title="站点荣誉标签">${escapeHtml(t)}</i>`).join('') : '');
    $('authorAvatar').textContent = shown.slice(0, 1).toUpperCase();
    setTitle(`@${shown} 的作品`);
    // 自己的主页：名字旁显示「修改昵称」入口，页面底部放「注销账号」（低调、防误触）
    const isMe = state.user && state.user.username === name;
    const nickBtn = $('authorNickBtn');
    nickBtn.style.display = isMe ? 'inline-flex' : 'none';
    if (isMe) nickBtn.onclick = openNickModal;
    const dangerRow = $('authorDangerRow');
    dangerRow.style.display = isMe ? 'block' : 'none';
    if (isMe) $('authorDelBtn').onclick = openDelAcc;
    $('authorBio').textContent = data.bio || '';
    $('authorStats').innerHTML =
      `作品 ${data.total} · 累计获赞 ${data.totalLikes} · 被收藏 ${data.totalFavs || 0}`;
    // 自己的主页：stats 下面挂一条「屏蔽管理」。放这儿是因为用户找「我屏蔽过什么」时，
    // 第一反应是回自己的主页翻，而不是去右上角头像的下拉里找二级菜单。
    const toolsEl = $('authorTools');
    if (isMe) {
      const nb = (state.blocked || []).length;
      const ub = (state.blockedUsers || []).length;
      const sub = (nb || ub)
        ? `已隐藏 ${nb} 件作品${ub ? ` · 拉黑 ${ub} 位作者` : ''}`
        : '还没有屏蔽任何作品';
      toolsEl.style.display = '';
      toolsEl.innerHTML = `<button type="button" class="author-tool-btn" id="authorBlockBtn"
          title="只对你自己生效：被屏蔽的作品不会出现在你的首页、榜单和搜索里，随时可以恢复">
          <span class="ico">${ic('block')}</span> 屏蔽管理 <span class="at-sub">${sub}</span></button>`;
      $('authorBlockBtn').onclick = () => openBlockedList(nb ? 'works' : (ub ? 'users' : 'works'));
    } else {
      toolsEl.style.display = 'none';
      toolsEl.innerHTML = '';
    }
    $('authorGallery').innerHTML = data.works.map(w => cardHtml(w)).join('') ||
      '<div class="empty"><p>这位作者还没有作品</p></div>';
    bindCards($('authorGallery'));
  } catch {
    $('authorGallery').innerHTML = '<div class="empty"><p>作者不存在</p></div>';
  }
}

// ---------- 榜单 ----------
// H5 榜单页：真正的「榜」——按周期（周榜/月榜/总榜）+ 维度（综合/点赞/收藏/灯火/访客）排名，
// 数据走专用接口 /api/rank（与 PC 排行榜同一套后端），形态作次级筛选。
// 不再是首页换皮：首页是「浏览」（形态/分类/时间/最新），榜单是「排名」（周期+维度）。
// 默认总榜：本地几件作品是几天前上架的，周榜(7天)会空白，总榜始终有内容，方便先本地看效果。
const rankH5 = { type: '全部', period: 'all', by: 'hot' };
let rankPage = 1;
let rankHasMore = false;
// 周期：周榜近 7 天上架 / 月榜近 30 天 / 总榜全部作品
const RANK_PERIODS = [
  { value: 'week', label: '周榜' },
  { value: 'month', label: '月榜' },
  { value: 'all', label: '总榜' }
];
// 排序维度：与 PC 排行榜的 by 一一对应（hot/likes/favs/tips/uv）；移动端用「xx榜」命名更像榜单。
// hint 是选这个维度后显示在胶囊下方的计分说明（与小程序榜单页同款文案）
const RANK_BYS = [
  { value: 'hot', label: '综合榜', hint: '获赞×5 ＋ 收藏×8 ＋ 评论 ＋ 灯火人数×10 ＋ 访问分' },
  { value: 'likes', label: '点赞榜', hint: '按点赞数排序，同一人重复点赞只算一次' },
  { value: 'favs', label: '收藏榜', hint: '按收藏数排序，收藏需要登录账号' },
  { value: 'tips', label: '灯火榜', hint: '按送过灯火的人数排序：同一人多笔只算 1 人，人数打平比灯火总额' },
  { value: 'uv', label: '访客榜', hint: '按独立访客（UV）排序，同一人多次打开只算一位' }
];
// 当前行右侧的分数文案（与小程序榜单页同口径）：综合=热度，其余=人数口径
function rankMetricText(by, w) {
  if (by === 'likes') return (w.likes || 0) + ' 人点赞';
  if (by === 'favs') return (w.favs || 0) + ' 人收藏';
  if (by === 'tips') return (w.tipsTippers || 0) + ' 人点亮';
  if (by === 'uv') return (w.uv || 0) + ' 人访问';
  return '热度 ' + (w.hotScore || 0);
}

// ---------- 榜单页「今日动态」 ----------
// 只报今天的聚合数字，不做日榜、不排名：站点体量小的时候，按天排名会被一两次偶然互动
// 牵着走，而「今天来了几件新作品、点了几盏灯火」既真实又不会显得冷清。
let rankTodayData = null;
let rankTodayFetchedAt = 0;
function renderRankToday() {
  const box = $('rankToday');
  if (!box) return;
  const d = rankTodayData;
  if (!d) { box.innerHTML = ''; return; } // 接口没回来/失败时整条不显示，容器靠 :empty 自动收起
  const bits = [];
  if (d.works) bits.push(`<b>${Number(d.works) || 0}</b> 件新作品上架`);
  if (d.tips) bits.push(`<b>${Number(d.tips) || 0}</b> 盏灯火被点亮`);
  if (d.comments) bits.push(`<b>${Number(d.comments) || 0}</b> 条新评论`);
  if (d.visitors) bits.push(`<b>${Number(d.visitors) || 0}</b> 位朋友来逛过`);
  // 小程序同款：素净的一行灰字（计分口径说明在维度胶囊下方的 rk-hint，不挤这里）
  box.innerHTML = bits.length ? `今日 ${bits.join(' · ')}` : '';
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
  // 维度胶囊行（综合榜/点赞榜/收藏榜/灯火榜/访客榜），下方一行计分说明跟着选中维度变
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
    hintLine.textContent = (RANK_BYS.find(b => b.value === rankH5.by) || RANK_BYS[0]).hint;
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
function rankRowHtml(w, i) {
  const top = i < 3 ? ' top' + (i + 1) : '';   // 前三名金银铜
  const cover = w.thumb
    ? `<img class="rk-cover" src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />`
    : `<div class="rk-cover rk-cover-empty">${escapeHtml((w.title || '?').slice(0, 1))}</div>`;
  const isNew = w.isNew ? '<span class="rk-new">NEW</span>' : '';
  const feat = w.featured ? '<span class="rk-tag">精选</span>' : '';
  return `
    <div class="rk-row" data-id="${w.id}">
      <span class="rk-num${top}">${i + 1}</span>
      ${cover}
      <div class="rk-main">
        <div class="rk-title-line"><span class="rk-title">${escapeHtml(w.title)}</span>${isNew}</div>
        <span class="rk-sub">${escapeHtml(w.authorName || '匿名')} · ${escapeHtml(w.type || '')}</span>
        <div class="rk-tags"><span class="rk-tag">${escapeHtml(w.category)}</span>${feat}</div>
      </div>
      <div class="rk-metric">
        <span class="rk-metric-text">${rankMetricText(rankH5.by, w)}</span>
        <span class="rk-metric-sub">${formatDate(w.createdAt)}</span>
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
      box.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>这个榜单还没有作品，换个周期或筛选试试？</p></div>';
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
const rankState = { period: 'week', by: 'hot', limit: 20, type: '全部' };
// PC 排序下拉按钮上显示的是「排序：xxx」，不再带「按」字，避免「排序 按访问次数」读着别扭
const BY_SHORT = { hot: '综合', likes: '点赞', favs: '收藏', tips: '打赏人数', pv: '访问次数', uv: '访问人数' };
// 榜单行右侧（窄屏）只显示当前维度的一个大数字，label 跟着排序走
const BY_SCORE_LABEL = { hot: '热度', likes: '获赞', favs: '收藏', tips: '灯火', pv: '访问', uv: '访客' };
// 图例一句话说明跟着排序走：选什么排序，下面就解释什么
const BY_LEGEND = {
  hot: '综合分 = 获赞×5 + 收藏×8 + 评论×1 + 灯火人数×10 + 访问分',
  likes: '按累计获赞数排序：作品上架以来收到的点赞，同一身份只计 1 次',
  favs: '按累计被收藏数排序：作品上架以来被收藏的次数',
  tips: '按送过灯火的人数排序：同一人多笔只算 1 人，人数打平比灯火总额；送灯火 = 为作品投票，每位送过的朋友折 10 分进综合分',
  pv: '按访问次数排序：所选周期内详情页被打开的次数，同一个人反复打开也会累加',
  uv: '按访问人数排序：所选周期内有多少人打开过详情页，同一个人只算 1 个'
};
const PERIOD_SHORT = { week: '周榜', month: '月榜', all: '总榜' };
const PERIOD_HINT = {
  week: '周榜 · 近 7 天上架',
  month: '月榜 · 近 30 天上架',
  all: '总榜 · 全部作品'
};

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
  } catch { /* 拉不到就沿用全站数，不影响筛选 */ }
}
function renderRankTypePanel() {
  const panel = $('rankTypePanel');
  if (!panel) return;
  const pc = rankCountsCache[rankState.period];
  const opts = totalWorks > 0
    ? TYPES.filter(t => t === '全部' || (typeCounts[t] || 0) > 0 || t === rankState.type)
    : TYPES;
  panel.innerHTML = opts.map(t => {
    const n = t === '全部'
      ? (pc ? pc.total : totalWorks)
      : (pc ? (pc.counts[t] || 0) : (typeCounts[t] || 0));
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

async function loadRank(period, by, limit, type) {
  if (period) rankState.period = period;
  if (by) rankState.by = by;
  if (limit) rankState.limit = limit;
  if (type) rankState.type = type;
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
  if (legendText) legendText.textContent = BY_LEGEND[rankState.by] || BY_LEGEND.hot;
  document.querySelectorAll('#rankLimitPanel .dd-opt').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.limit) === rankState.limit));
  const limitVal = $('rankLimitValue');
  if (limitVal) limitVal.textContent = rankState.limit + ' 条';
  renderRankTypePanel();   // 形态下拉的勾选态与按钮当前值跟着变
  loadRankTypeCounts();    // 条数按当前周期修正（有缓存，切回来不用再请求）
  renderRankToday();   // 周期口径提示跟着下拉即时变
  loadRankToday();     // 今日数字内部有 1 分钟缓存，不会重复请求
  try {
    const tParam = rankState.type !== '全部' ? `&type=${encodeURIComponent(rankState.type)}` : '';
    const list = await (await fetch(`/api/rank?period=${rankState.period}&by=${rankState.by}&limit=${rankState.limit}${tParam}`)).json();
    const cur = rankState.by;
    // 窄屏行尾的大分数：只展示当前排序维度的那一个值（宽屏隐藏，改显示整排指标）
    const scoreOf = w => cur === 'hot' ? (w.hotScore || 0)
      : cur === 'likes' ? (w.likes || 0)
      : cur === 'favs' ? (w.favs || 0)
      : cur === 'tips' ? (w.tipsTippers || 0)
      : cur === 'pv' ? (w.pv || 0) : (w.uv || 0);
    $('rankList').innerHTML = list.length ? list.map(w => `
      <div class="rank-item" data-id="${w.id}">
        <div class="rank-no rank-no-${w.rank <= 3 ? w.rank : 'n'}">${w.rank}</div>
        <img src="${w.thumb}" alt="" loading="lazy" />
        <div class="rank-main">
          <div class="rank-title">${escapeHtml(w.title)}${w.isNew ? '<span class="rank-fresh" title="今天刚上架的作品">今日上新</span>' : ''}</div>
          <div class="rank-meta">${escapeHtml(typeText(w))} · ${escapeHtml(aname(w))} · ${escapeHtml(w.category)}</div>
        </div>
        <div class="rank-score">
          <span class="${cur === 'likes' ? 'on' : ''}" title="获赞数">${ic('heart')} ${w.likes || 0}</span>
          <span class="${cur === 'favs' ? 'on' : ''}" title="被收藏数">${ic('star')} ${w.favs || 0}</span>
          ${w.commentCount ? `<span title="评论与提问数">${ic('chat')} ${w.commentCount}</span>` : ''}
          <span class="${cur === 'tips' ? 'on' : ''}" title="打赏人数：累计有多少个不同用户送过灯火，同一人多笔只算 1 人${cur === 'tips' ? '（排序依据）' : ''}">${ic('lamp')} ${w.tipsTippers || 0}</span>
          ${cur === 'hot' ? `<span class="on" title="综合分 = 获赞×5 + 收藏×8 + 评论×1 + 灯火人数×10 + 访问分；灯火按送过的人数算，同一人送多笔只算 1 人；访问分最多只算「访客数×4 再加 20」，如 120 个访客封顶 500 分；同一身份只能赞一次，匿名评论不计分，反复刷换不来排名">${ic('bolt')} ${w.hotScore || 0}</span>` : ''}
          <span class="${cur === 'pv' ? 'on' : ''}" title="访问次数：本周期详情页被打开的次数，同一个人反复打开也会累加（排序依据）">${ic('bars')} ${w.pv || 0}</span>
          <span class="${cur === 'uv' ? 'on' : ''}" title="访问人数：本周期有多少人打开过这件作品的详情页，同一个人只算 1 个（排序依据）">${ic('person')} ${w.uv || 0}</span>
        </div>
        <div class="rank-score-m" title="${escapeHtml(BY_LEGEND[cur] || BY_LEGEND.hot)}"><span>${BY_SCORE_LABEL[cur] || '热度'}</span><b>${scoreOf(w)}</b></div>
        <button class="rank-share" data-share-work="${w.id}" title="分享：生成带二维码的分享图，发朋友圈/小红书都行">${ic('sharecard')}<span>分享</span></button>
      </div>`).join('') : '<div class="empty"><p>暂无上榜作品</p></div>';
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
async function openWork(id, push = true) {
  try {
    const w = await (await fetch('/api/works/' + id)).json();
    if (w.error) { showToast(w.error, undefined, 'err'); return; }
    state.currentWork = w;
    // 作品维度 PV：以弹窗方式打开时单独上报一次；/w/xxx 直链已由 trackPageView 计入，不重复
    // 作者自己打开自己的作品不计数（后端同样会拦一道），否则预览几次就把自己的数据刷高了
    if (!w.owned && (push || location.pathname !== '/w/' + id)) trackWorkView(id);
    if (push) {
      history.pushState({ dm: 'work' }, '', '/w/' + id);
      // 不再用 on-work 隐藏首页内容（会让页面塌陷、滚动条消失并跳动），
      // 背景内容保留、由下方 showModal 锁定滚动
    }
    setTitle(w.title);

    $('detailImg').src = w.image;
    // 标题：开源作品在标题后面直接跟一颗可点的「源码」小徽标
    $('detailTitle').innerHTML = escapeHtml(w.title) +
      (w.repo ? ` <a class="badge-repo badge-repo-inline" href="${escapeHtml(w.repo)}" target="_blank" rel="noopener" title="打开源码仓库"><span class="ico">${ic('folder')}</span> 源码</a>` : '') +
      (typeof w.stars === 'number' ? `<span class="badge-star" title="源码仓库在 GitHub 的 star 数（每 6 小时同步一次，每涨 1 star 作者自动得 1 盏灯火）"><span class="ico">${ic('star')}</span> ${w.stars}</span>` : '');
    $('detailCategory').innerHTML =
      typesOf(w).map(t => `<span class="badge-type">${typeIcoHtml(t)} ${escapeHtml(t)}</span>`).join('') +
      `<span class="badge-cat">${escapeHtml(w.category)}</span>` +
      osBadgeHtml(w) +
      paidBadgeHtml(w) +
      (w.featured ? `<span class="badge-featured"><span class="ico">${ic('sparkle')}</span> 精选</span>` : '');
    $('detailAuthor').innerHTML = `${w.verified ? `<i class="verified" title="认证创作者">${VERIFIED_BADGE}</i> ` : ''}${escapeHtml(aname(w))}${(w.authorTags || []).map(t => ` <i class="author-tag" title="站点荣誉标签">${escapeHtml(t)}</i>`).join('')}`;

    // 阶段横幅：预告 / 等平台上架审核的作品，先把「为什么现在点不了」讲清楚；
    // 作者自主下架的作品（仅作者本人能打开）给一条专属提示
    const wStage = stageOf(w);
    const stageBanner = $('detailStage');
    if (w.hidden) {
      stageBanner.style.display = 'block';
      stageBanner.className = 'detail-stage is-hidden';
      stageBanner.innerHTML = '<b>已下架 · 仅自己可见</b>：作品已从首页、列表、榜单和搜索撤下，别人打不开这个页面。浏览、点赞、灯火等数据都保留着，点下方「重新上架」即可恢复公开。';
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
    $('detailStats').innerHTML = `<span class="ico s-ico">${ic('heart')}</span>${w.likes} 点赞 · <span class="ico s-ico">${ic('star')}</span><span class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</span> 人收藏 · <span class="ico s-ico">${ic('chat')}</span><span class="cmt-num" data-comment-count="${w.id}" data-count="${w.commentCount || 0}" data-prefix="">${w.commentCount || 0}</span> 评论 · <span class="ico s-ico">${ic('eye')}</span>${w.views} 浏览 · <span class="ico s-ico">${ic('lamp')}</span><span id="detailTipsNum">${w.tipsTotal || 0}</span> 盏灯火 · ${formatDate(w.createdAt)}`;
    // 简介支持 Markdown：接口已把源码渲染成白名单 HTML（introHtml）；
    // 老数据/缓存里没有 introHtml 时退回纯文本，按换行显示
    const dp = $('detailPrompt');
    dp.classList.add('md-body');
    dp.innerHTML = w.introHtml || (w.intro ? escapeHtml(w.intro).replace(/\n/g, '<br>') : '');
    $('detailLikes').textContent = w.likes;

    // 访问/下载按钮：每个填了链接的形态各一个（多平台应用 iOS/Android/macOS… 分开展示）
    // 旧数据没有按形态的 links 时，退回单个按钮沿用原文案
    const tl = typesOf(w);
    // 纯小程序作品没有可点的外链，唯一入口是小程序码。老数据残留的 link 只能标「了解详情」，
    // 不能标「打开小程序」—— 点开的是网页，不是小程序
    const miniOnly = tl.length > 0 && tl.every(t => t === '小程序');
    const linkEntries = tl
      .map(t => ({ t, url: (w.links && w.links[t]) || '' }))
      .filter(e => e.url);
    if (!linkEntries.length && w.link) linkEntries.push({ t: null, url: w.link, miniIntro: miniOnly });
    // 官网按钮：填了官网且没有和某个平台链接重复时，放在最前面
    const siteUrl = String(w.site || '').trim();
    if (siteUrl && !linkEntries.some(e => e.url === siteUrl)) linkEntries.unshift({ t: null, url: siteUrl, site: true });
    // 每个按钮带动作标记：点了算「访问」还是「下载」，按形态自动判（iOS/Android/桌面端=下载，其余=访问）
    // 埋点后不影响跳转——target=_blank + keepalive，新标签打开时上报也能发出去
    let linksHtml = linkEntries.map(e => {
      const act = actionOfType(e.t, e.site);
      const atype = e.site ? '官网' : (e.t || '作品链接');
      return `<a class="btn-link" target="_blank" rel="noopener" href="${escapeHtml(e.url)}" data-act="${act}" data-atype="${escapeHtml(atype)}"><span class="ico b-ico">${ic(e.site ? 'globe' : (e.t && LINK_ICON[e.t]) || 'link')}</span> ${
        e.site ? '官网' : e.miniIntro ? '了解详情' : e.t ? escapeHtml((LINK_LABEL[e.t] || '访问作品').replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '')) : escapeHtml(linkLabelOf(tl))
      }</a>`;
    }).join('');
    // 纯小程序、既没码也没介绍页：说明现状，别让详情页空着让人不知道点哪
    if (miniOnly && !w.qrcode && !linkEntries.length) {
      linksHtml = '<span class="link-locked"><span class="ico">' + ic('mobile') + '</span> 作者还没上传小程序码，暂时打不开</span>';
    }
    // 平台上架审核中：链接已经存在但打不开，这里锁死不给点
    $('detailLinks').innerHTML = w.linkLocked
      ? '<span class="link-locked">平台上架审核中，暂时不能打开</span>'
      : linksHtml;

    // 平台入口太多（>3 个按钮）时收起来：只露前 3 个，其余折进「更多平台」，
    // 避免一排实心按钮把详情页头部挤成按钮墙
    const dlinks = $('detailLinks');
    // 点击埋点绑在真实跳转上：先上报再放行，锚点默认行为不动
    dlinks.querySelectorAll('.btn-link[data-act]').forEach(a => {
      a.addEventListener('click', () => trackAction(w.id, a.dataset.act, a.dataset.atype));
    });
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
            upcomingSig = '';   // 首页那一栏的计数下次刷新跟着变
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
      let curSrc = qrSrc, curTip = qrReal ? '手机扫码打开' : (miniOnly ? '用微信扫一扫打开小程序' : '扫码打开作品');
      // 码图加载失败（作者删了图 / 生成异常）就整块收起，别留一个破图框在页面上
      $('detailQr').onerror = () => { qrBox.style.display = 'none'; };
      $('detailQr').src = curSrc;
      prefetchSaveBlob(curSrc);   // 提前取字节，iOS 上点「保存二维码」才能立刻弹分享面板
      $('detailQrTip').textContent = curTip;
      qrBox.style.display = 'block';
      qrBox.classList.toggle('is-auto', qrReal);
      const qrEntry = miniOnly ? '小程序' : '二维码';
      // 自动码的真实扫码在 /go/ 里记，这里点放大/保存不再重复计数；只有小程序原码才记意图
      const noteScan = () => { if (!qrReal) trackAction(w.id, 'scan_intent', qrEntry); };
      qrZoomBtn.onclick = () => { noteScan(); openQrZoom(curSrc, curTip); };
      qrSaveBtn.onclick = () => { noteScan(); saveQrImage(curSrc, w.id); };
      // 多个入口才需要切换：一个入口直接显示，别给用户多一步
      if (qrList.length > 1) {
        qrTabs.innerHTML = qrList.map((t, i) =>
          `<button type="button" class="qr-tab${i === 0 ? ' is-on' : ''}" data-i="${i}">${escapeHtml(shortLabel(t.t))}</button>`
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

    $('detailLike').classList.toggle('liked', isFav('liked:' + w.id) || localStorage.getItem('liked:' + w.id) === '1');
    renderDetailFav(w.id);
    // 自己的作品不显示点赞/收藏按钮（统计数字还在数据区，只是不给自己提供操作入口）
    $('detailLike').style.display = w.owned ? 'none' : '';
    $('detailFav').style.display = w.owned ? 'none' : '';

    // 打赏：自己的作品不显示；匿名/游客投稿的作品也能送灯火（灯火记在作品上，不转给任何人）
    const tipBtn = $('detailTip');
    tipBtn.style.display = w.owned ? 'none' : '';
    tipBtn.classList.remove('is-off');
    tipBtn.title = w.claimed
      ? '用灯火支持作者，灯火会直接转到作者账上'
      : '为这件作品点亮一盏灯火，灯火会记在作品上（作者还没绑定账号）';
    tipBtn.innerHTML = `<i class="ico b-ico">${ic('lamp')}</i> 送灯火`;
    resetTipPanel(w);

    // 自己的作品：数据区下方显示高亮管理条（编辑 / 下架 / 删除）；别人的作品：登录后可屏蔽，有账号的作者可拉黑
    const canManage = !!w.owned;
    $('ownerBar').style.display = canManage ? 'flex' : 'none';
    const hideBtn = $('toggleHide');
    hideBtn.innerHTML = `<i class="ico b-ico" data-ico="eye"></i> ${w.hidden ? '重新上架' : '下架'}`;
    $('blockWork').style.display = (!canManage && state.user) ? 'inline-block' : 'none';
    const blockedAuthor = state.user && (state.blockedUsers || []).includes(w.author);
    $('blockAuthor').style.display = (!canManage && state.user && w.claimed && w.author && w.author !== '匿名')
      ? 'inline-block' : 'none';
    $('blockAuthor').innerHTML = `<span class="ico b-ico">${ic('block')}</span> ${blockedAuthor ? '已拉黑作者 · 恢复' : '拉黑作者'}`;

    // 推荐位：自己的作品不给自己展示（换了作品重开详情要重算一次）
    renderAdSlot(document.querySelector('.ad-slot-detail'), 'detail');

    // 认领入口：只有管理员开放了认领的作品才显示（自己的作品不显示）
    const entry = $('claimEntry');
    const mine = myClaimOf(w.id);
    if (canManage || w.owned || !w.claimable) {
      entry.style.display = 'none';
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
  if (c.kind === 'question') out.push(`<span class="cmt-badge q">${c.answered ? '已回复' : '提问'}</span>`);
  if (c.anon) out.push('<span class="cmt-badge anon">匿名</span>');
  return out.join('');
}

function commentItemHtml(c, replies) {
  return `
    <div class="comment-item${c.kind === 'question' ? ' is-question' : ''}" data-id="${escapeHtml(c.id)}">
      <span class="comment-avatar${c.anon ? ' anon' : ''}">${escapeHtml((cname(c) || '?').slice(0, 1).toUpperCase())}</span>
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
      <span class="comment-avatar sm${r.anon ? ' anon' : ''}">${escapeHtml((cname(r) || '?').slice(0, 1).toUpperCase())}</span>
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

// 切换「评论 / 提问」
function syncCommentKindUI() {
  document.querySelectorAll('#commentKind .ck-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.kind === state.commentKind));
  const input = $('commentInput');
  if (!input) return;
  if (state.replyTo) return; // 回复模式下 placeholder 由 startReply 控制
  input.placeholder = state.commentKind === 'question'
    ? '把问题写清楚，作者更容易回答…'
    : '说点什么，或提出你的问题…';
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
    $('commentHint').textContent = '无需登录，填个昵称就能发言';
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
  const MAX_GALLERY = 9;

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
      put('作品名称', form.title, d.name || '');
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
        if (!setFileInput(form.image, file)) {
          showToast('浏览器不支持自动设置封面，请手动上传', undefined, 'err');
          return;
        }
        aiFillCover.hidden = true;
        showToast('已用网站图片做封面，建议换成首页截图', undefined, 'ok');
      }).catch(() => showToast('封面读取失败，请手动上传', undefined, 'err'));
    });
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
      aiFillCover.hidden = true;
      pendingCover = null;
      try {
        const r = await fetch(isUrl ? '/api/work/parse-url' : '/api/work/parse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isUrl ? { url } : { text })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { aiStatus(d.error || '识别失败，请手动填写', 'err'); return; }
        applyFill(d);
      } catch {
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
  let pasteTarget = 'image'; // 当前粘贴目标：image / qrcode / images

  // ---- 服务端草稿（登录用户）----
  // 匿名用户没有账号可挂，仍走浏览器本地草稿（localStorage），换设备就没了。
  // 登录用户的草稿存在服务端、图片一起存：换设备/换浏览器接着填，图不用重挑。
  let draftId = null;      // 正在编辑的草稿 id（null = 还没建）
  let coverUrl = '';       // 服务端已有的封面（草稿续填或刚才保存上来的）
  let qrUrl = '';          // 服务端已有的二维码
  let draftTimer = null;   // 输入防抖
  let draftBusy = false;   // 串行化：同一时刻只跑一个保存请求
  let draftAgain = false;  // 保存期间又有改动 → 完事再来一次

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
    // 二维码字段隐藏时（网站 / App 等形态）自动落到封面
    if (target === 'qrcode' && $('qrField').style.display === 'none') target = 'image';
    if (target === 'images') {
      if (galleryItems.length >= MAX_GALLERY) { showToast(`宣传图最多 ${MAX_GALLERY} 张`, undefined, 'err'); return; }
      addGalleryFile(file);
      showToast(`已粘贴宣传图 ${galleryItems.length}/${MAX_GALLERY}`, undefined, 'ok');
      return;
    }
    const input = target === 'qrcode' ? form.qrcode : form.image;
    if (!setFileInput(input, file)) { showToast('当前浏览器不支持粘贴，请点击上传'); return; }
    showToast(target === 'qrcode' ? '已粘贴二维码' : '已粘贴封面', undefined, 'ok');
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
    // 移动端形态：宣传图/封面预览按手机竖屏比例
    const mobile = isMobileTypes(types);
    $('galleryPreviews').classList.toggle('mobile', mobile);
    $('previewBox').classList.toggle('mobile', mobile);
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
    if (galleryItems.length >= MAX_GALLERY) return;
    galleryItems.push({ kind: 'new', file: f, src: URL.createObjectURL(f) });
    renderGalleryPreviews();
  }

  // 把第 from 项移动到第 to 项的位置
  function moveGalleryItem(from, to) {
    if (from === to || from < 0 || to < 0 || from >= galleryItems.length || to >= galleryItems.length) return;
    const [it] = galleryItems.splice(from, 1);
    galleryItems.splice(to, 0, it);
    renderGalleryPreviews();
    scheduleDraftSave(400);
  }

  let dragFrom = -1; // 拖拽起始位置

  function renderGalleryPreviews() {
    const box = $('galleryPreviews');
    const total = galleryItems.length;
    $('galleryText').innerHTML = total
      ? `已选 ${total}/${MAX_GALLERY} 张，点击继续添加`
      : '添加宣传图片';
    box.innerHTML = galleryItems.map((it, i) => `
      <div class="gallery-thumb" draggable="true" data-index="${i}" title="拖动可调整顺序">
        <img src="${it.kind === 'old' ? it.url : it.src}" alt="" />
        <span class="gallery-order">${i + 1}</span>
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

  // 删除已上传的封面 / 二维码，或清空本次选择
  $('coverClear').onclick = e => {
    e.preventDefault();
    form.image.value = '';
    coverUrl = '';   // 草稿里已存的封面也一并视为移除，下次保存会清掉
    $('previewImg').removeAttribute('src');
    $('previewBox').style.display = 'none';
    $('coverText').innerHTML = editId
      ? '保留原封面，点击可更换<br /><small>也可直接 Ctrl+V 粘贴截图</small>'
      : '点击上传封面图<br /><small>支持 JPG / PNG / WebP，也可直接 Ctrl+V 粘贴截图</small>';
    setPasteTarget('image');
    scheduleDraftSave(300);
  };
  $('qrClear').onclick = e => {
    e.preventDefault();
    form.qrcode.value = '';
    qrUrl = '';
    $('qrPreviewImg').removeAttribute('src');
    $('qrPreviewBox').style.display = 'none';
    qrCleared = true;   // 编辑模式下：提交时真正删除服务器上的二维码
    showToast('已删除二维码', undefined, 'ok');
    scheduleDraftSave(300);
  };

  function resetUploadForm() {
    editId = null;
    repoBaseline = '';
    // 草稿状态整体归零：换弹窗内容时不能把上一份草稿的图和 id 带过去
    draftId = null;
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
    form.image.required = true;
    updatePaidModelField(); // form.reset 会还原 radio 默认值，收费形式区一并收起
    newCatInput.style.display = 'none';
    newCatInput.value = '';
    const nti = $('newTypeInput');
    if (nti) { nti.style.display = 'none'; nti.value = ''; }
    setCats([]);
    $('previewBox').style.display = 'none';
    $('qrPreviewBox').style.display = 'none';
    $('submitBtn').textContent = '提交';
    galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
    galleryItems = [];
    originalImages = [];
    qrCleared = false;
    renderGalleryPreviews();
    $('coverText').innerHTML = '点击上传封面图<br /><small>支持 JPG / PNG / WebP，也可直接 Ctrl+V 粘贴截图</small>';
    // 状态回到默认「已上线」，预告字段一并收起
    const liveRadio = form.querySelector('input[name="stage"][value="live"]');
    if (liveRadio) liveRadio.checked = true;
    $('progressRange').value = 40;
    $('progressVal').textContent = '40%';
    $('etaInput').value = '';
    applyStageFields();
    setSelectedTypes(['Web']);
    setPasteTarget('image');
  }
  resetUploadForm = resetUploadForm; // 暴露给外部（afterAuth 用）
  restoreUploadDraft = restoreDraft;
  clearUploadDraft = clearDraft;

  // ---- 关闭保护 + 草稿 ----
  // 分两条路：登录用户存服务端（最多 3 份、跨设备、连图片一起存），
  // 匿名用户没有账号可挂，只能存浏览器本地 localStorage（换设备就没了）。
  const DRAFT_KEY = 'upload_draft';
  let localDraftTimer = null;
  function uploadDirty() {
    if (['title', 'link', 'prompt'].some(k => form[k] && form[k].value.trim())) return true;
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
        types: selectedTypes(), title: form.title.value,
        newType: $('newTypeInput').style.display !== 'none' ? $('newTypeInput').value.trim() : '',
        cats: selectedCats(), customCat: newCatInput.style.display !== 'none' ? newCatInput.value.trim() : '',
        openSource: (form.querySelector('input[name="openSource"]:checked') || {}).value || '',
        repo: form.repo.value,
        paid: (form.querySelector('input[name="paid"]:checked') || {}).value || '',
        paidModel: (form.querySelector('input[name="paidModel"]:checked') || {}).value || '',
        prompt: form.prompt.value, site: form.site.value, links: collectLinkValues(form), t: Date.now()
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
      form.title.value = d.title || '';
      setCats(Array.isArray(d.cats) && d.cats.length ? d.cats : (d.category ? [d.category] : []));
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
      const pmDraft = form.querySelector(`input[name="paidModel"][value="${d.paidModel || ''}"]`);
      if (pmDraft) pmDraft.checked = true;
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
      fd.set('title', form.title.value);
      fd.set('prompt', form.prompt.value);
      fd.set('site', form.site.value);
      fd.set('repo', form.repo.value);
      fd.set('types', JSON.stringify(selectedTypes()));
      fd.set('categories', JSON.stringify(selectedCats()));
      fd.set('links', JSON.stringify(collectLinkValues(form)));
      const osEl = form.querySelector('input[name="openSource"]:checked');
      fd.set('openSource', osEl ? osEl.value : '');
      const paidEl = form.querySelector('input[name="paid"]:checked');
      fd.set('paid', paidEl ? paidEl.value : '');
      const pmEl = form.querySelector('input[name="paidModel"]:checked');
      fd.set('paidModel', pmEl ? pmEl.value : '');
      const stEl = form.querySelector('input[name="stage"]:checked');
      fd.set('stage', stEl ? stEl.value : 'live');
      fd.set('progress', $('progressRange').value);
      fd.set('eta', $('etaInput').value || '');

      // 宣传图：已有图（含之前存上来的）走 keepExisting，新选的按顺序追加
      const newFiles = galleryItems.filter(it => it.kind === 'new');
      const keptUrls = galleryItems.filter(it => it.kind === 'old').map(it => it.url);
      const removedImages = originalImages.filter(u => !keptUrls.includes(u));
      if (newFiles.length || removedImages.length) {
        fd.set('keepExisting', '1');
        if (removedImages.length) fd.set('removedImages', JSON.stringify(removedImages));
        let n = -1;
        fd.set('imageOrder', JSON.stringify(galleryItems.map(it => it.kind === 'old' ? it.url : `__new__${++n}`)));
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
      if (data.draft && data.draft.id) draftId = data.draft.id;
      // 回写图片地址：本地 File 已经变成服务端图，下次保存不用再传一遍
      if (data.image) {
        coverUrl = data.image;
        form.image.value = '';
        form.image.required = false;
        $('previewImg').src = coverUrl;
        $('previewBox').style.display = 'block';
      }
      if (data.qrcode !== undefined) {
        qrUrl = data.qrcode || '';
        if (qrUrl) { form.qrcode.value = ''; $('qrPreviewImg').src = qrUrl; $('qrPreviewBox').style.display = 'block'; }
      }
      if (Array.isArray(data.images) && galleryItems.some(it => it.kind === 'new')) {
        galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
        galleryItems = data.images.map(u => ({ kind: 'old', url: u }));
        originalImages = data.images.slice();
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
    if (Array.isArray(d.types) && d.types.length) setSelectedTypes(d.types);
    form.title.value = d.title || '';
    form.prompt.value = d.prompt || '';
    form.site.value = d.site || '';
    pendingLinkValues = (d.links && Object.keys(d.links).length) ? d.links
      : (d.link ? { [((d.types || []).filter(x => x !== '小程序')[0]) || 'Web']: d.link } : null);
    setCats(Array.isArray(d.categories) ? d.categories : []);
    const osv = d.openSource === true ? '1' : d.openSource === false ? '0' : '';
    const osi = form.querySelector(`input[name="openSource"][value="${osv}"]`);
    if (osi) osi.checked = true;
    const pv = form.querySelector(`input[name="paid"][value="${d.paid ? '1' : ''}"]`);
    if (pv) pv.checked = true;
    const pmv = form.querySelector(`input[name="paidModel"][value="${d.paidModel || ''}"]`);
    if (pmv) pmv.checked = true;
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
    if (coverUrl) {
      form.image.required = false;
      $('previewImg').src = coverUrl;
      $('previewBox').style.display = 'block';
      $('coverText').innerHTML = '封面已保存<br /><small>点击可更换</small>';
    }
    qrUrl = d.qrcode || '';
    if (qrUrl) {
      $('qrPreviewImg').src = qrUrl;
      $('qrPreviewBox').style.display = 'block';
    }
    originalImages = Array.isArray(d.images) ? d.images.slice() : [];
    galleryItems = originalImages.map(u => ({ kind: 'old', url: u }));
    renderGalleryPreviews();
    return true;
  }
  form.addEventListener('input', () => {
    clearTimeout(localDraftTimer);
    localDraftTimer = setTimeout(saveDraft, 400);
    scheduleDraftSave();
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

  // 收费形式：勾「需要付费」才展开；直接点某个形式也自动勾上「需要付费」；改回免费时清掉形式
  function updatePaidModelField() {
    const paid = (form.querySelector('input[name="paid"]:checked') || {}).value === '1';
    const picker = $('paidModelPicker');
    if (picker) picker.style.display = paid ? 'flex' : 'none';
    if (!paid) {
      const none = form.querySelector('input[name="paidModel"][value=""]');
      if (none) none.checked = true;
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

  editWorkFn = startEdit;
  function startEdit(w) {
    editId = w.id;
    hideModal(detailModal);
    $('modalTitle').textContent = '编辑作品';
    $('formHint').textContent = `作者：${dname(w)} · 修改后立即生效`;
    $('formHint').style.display = 'block';
    setSelectedTypes(typesOf(w));
    form.title.value = w.title;
    form.prompt.value = w.intro || '';
    form.site.value = w.site || ''; // 官网回填
    // 编辑回填：按形态的 links 优先，旧数据的单 link 落到第一个非小程序形态的输入框
    {
      const nonMini = typesOf(w).filter(t => t !== '小程序');
      const pv = Object.assign({}, w.links || {});
      if (w.link && nonMini.length && !Object.keys(pv).length) pv[nonMini[0]] = w.link;
      pendingLinkValues = Object.keys(pv).length ? pv : null;
    }
    setCats(Array.isArray(w.categories) && w.categories.length ? w.categories : [w.category].filter(Boolean));
    const osVal = w.openSource === true ? '1' : w.openSource === false ? '0' : '';
    const osInput = form.querySelector(`input[name="openSource"][value="${osVal}"]`);
    if (osInput) osInput.checked = true;
    const paidInput = form.querySelector(`input[name="paid"][value="${w.paid ? '1' : ''}"]`);
    if (paidInput) paidInput.checked = true;
    const pmInput = form.querySelector(`input[name="paidModel"][value="${w.paidModel || ''}"]`);
    if (pmInput) pmInput.checked = true;
    updatePaidModelField();
    form.repo.value = w.repo || '';
    repoBaseline = form.repo.value.trim();
    updateRepoFieldFn();
    form.image.required = false; // 编辑时可以不换封面
    newCatInput.style.display = 'none';
    $('submitBtn').textContent = '保存修改';
    galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
    originalImages = (w.images || []).slice();
    galleryItems = originalImages.map(u => ({ kind: 'old', url: u }));
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
    $('coverText').innerHTML = '保留原封面，点击可更换<br /><small>也可直接 Ctrl+V 粘贴截图</small>';
    if (w.qrcode) {
      $('qrPreviewImg').src = w.qrcode;
      $('qrPreviewBox').style.display = 'block';
    } else {
      $('qrPreviewBox').style.display = 'none';
    }
    $('previewBox').style.display = 'none'; // 原封面不预览，选新图后再显示
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
    body.innerHTML = rows + `
      <div class="draft-row draft-new" data-id="">
        <div class="draft-thumb draft-thumb-new">＋</div>
        <div class="draft-info"><b>新建一份</b><span>从空白开始，上面这些草稿继续留着</span></div>
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
      } catch {}
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
  bindMaskClose(uploadModal, tryCloseUpload);

  // 投稿指南页的 CTA：复用「＋ 提交作品」的完整打开逻辑（草稿恢复等）
  const howtoCta = $('howtoCta');
  if (howtoCta) howtoCta.onclick = () => $('openUpload').click();

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

  form.image.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    $('previewImg').src = URL.createObjectURL(file);
    $('previewBox').style.display = 'block';
    $('coverText').textContent = file.name;
  });
  form.qrcode.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    qrCleared = false;
    $('qrPreviewImg').src = URL.createObjectURL(file);
    $('qrPreviewBox').style.display = 'block';
  });
  form.images.addEventListener('change', e => {
    for (const f of e.target.files) {
      if (galleryItems.length >= MAX_GALLERY) { showToast(`宣传图最多 ${MAX_GALLERY} 张`, undefined, 'err'); break; }
      addGalleryFile(f);
    }
    e.target.value = ''; // 允许再次选择时重复追加
  });

  // 鼠标移到某个上传区即把它设为粘贴目标
  document.querySelectorAll('.upload-dropzone[data-paste]').forEach(dz => {
    dz.addEventListener('mouseenter', () => setPasteTarget(dz.dataset.paste));
  });

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
    if (!form.title.value.trim()) {
      showToast('请填写作品标题', undefined, 'err');
      form.title.focus();
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

    // 封面：新建时必须有一张（编辑/草稿续填时保留已有的即可）
    if (!editId && !form.image.files.length && !coverUrl) {
      showToast('请上传作品封面 / 截图', undefined, 'err');
      $('coverDrop').scrollIntoView({ block: 'center', behavior: 'smooth' });
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
      fd.set('categories', JSON.stringify(cats)); // 多分类（第 0 个为主分类，提交顺序即选中顺序）
      fd.set('category', cats[0]);                // 兼容老字段
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
      const qrAllowed = ruleOfTypes(selectedTypes()).qr;
      const newFiles = galleryItems.filter(it => it.kind === 'new').map(it => it.file);
      const keptUrls = galleryItems.filter(it => it.kind === 'old').map(it => it.url);
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
      if (galleryItems.length) {
        let n = -1;
        fd.set('imageOrder', JSON.stringify(galleryItems.map(it =>
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
      if (!wasEdit) clearDraft();
      hideModal(uploadModal);
      resetUploadForm();
      const bonus = Number(data.osBonus) || 0;
      // 上传奖励是延迟到账的（48h 无投诉才发），只作预告不报「已到账」
      const upReward = Number(data.uploadReward) || 0;
      const rewardHint = upReward > 0 ? ` 上传奖励 +${upReward} 盏灯火将在 48 小时无投诉后到账${upReward >= 200 ? '（首件大奖）' : ''}。` : '';
      const instantLive = !wasEdit && !data.anonymous && !data.needReview;
      showToast(
        wasEdit
          ? (bonus > 0 ? '修改已保存，开源奖励 +50 盏灯火已到账' : '修改已保存')
        : data.anonymous ? (data.status === 'approved' ? '提交成功，已通过 AI 初审直接上线' : '已提交，审核通过后上线（注册可免审直发）')
        : data.needReview ? '提交成功，AI 初审未通过，等待人工审核后展示'
        : bonus > 0 ? `提交成功，开源奖励 +50 盏灯火已到账 ·${rewardHint}作品页可点「外宣包」做宣传`
        : `提交成功 ·${rewardHint}作品页可点「外宣包」做宣传`,
        instantLive ? 4200 : undefined, 'ok');
      if (bonus > 0) loadMe();   // 头部积分数字立刻刷新
      // 匿名投稿没有账号可查：直接打开「投稿进度」页，链接可收藏，之后随时回来看
      if (!wasEdit && data.statusUrl) {
        showToast('已提交，正在打开你的投稿进度页…', 2400, 'ok');
        setTimeout(() => { location.href = data.statusUrl; }, 1400);
        return;
      }
      state.sort = 'latest';
      renderFilters();   // 筛选栏「最新」tab 的文案跟着回到默认
      route();
    } catch (err) {
      showToast(err.message, undefined, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '提交';
    }
  });
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
function setupDetailActions() {
  $('closeDetail').onclick = () => {
    hideModal(detailModal);
    // 弹窗是从首页/榜单/作者页打开的（history.state.dm === 'work'）就回退到原页面，
    // 只有从 /w/xxx 直链打开时才回首页
    if (location.pathname.startsWith('/w/')) {
      if (history.state && history.state.dm === 'work') {
        skipNextListReload = true; // 列表还在页面上，退回时别重载
        history.back();
      } else { history.pushState({}, '', '/'); route(); }
    }
  };
  bindMaskClose(detailModal, () => $('closeDetail').click());
  $('galPrev').onclick = () => setDetailImage(galState.idx - 1);
  $('galNext').onclick = () => setDetailImage(galState.idx + 1);

  // 缩略图条左右滚动箭头：按需显隐，点击平滑滚动
  const galEl = $('detailGallery');
  $('thumbPrev').onclick = () => galEl.scrollBy({ left: -260, behavior: 'smooth' });
  $('thumbNext').onclick = () => galEl.scrollBy({ left: 260, behavior: 'smooth' });
  galEl.addEventListener('scroll', updateThumbArrows, { passive: true });
  window.addEventListener('resize', updateThumbArrows);

  $('detailLike').onclick = async () => {
    const w = state.currentWork;
    if (!w || localStorage.getItem('liked:' + w.id) === '1') return;
    const res = await fetch(`/api/works/${w.id}/like`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '操作失败', undefined, 'err'); return; }
    localStorage.setItem('liked:' + w.id, '1');
    $('detailLikes').textContent = data.likes;
    $('detailLike').classList.add('liked');
    if (data.deduped) showToast('这个作品你已经赞过了');
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

  // 注入到顶层：openWork 每次换作品时调用（弹窗收起、档位清空、余额重画）
  resetTipPanel = function (w) {
    hideModal($('tipPanel'));
    tipSelAmount = 0;
    // 匿名/游客投稿的作品也能送灯火：文案改成「记在作品上」，不承诺转给作者
    const claimed = !!(w && w.claimed);
    $('tipPanelTitle').textContent = claimed ? '为作者点亮一盏灯火' : '为这件作品点亮一盏灯火';
    $('tipNote').textContent = claimed
      ? '灯火全额记到作者账上；每人每天转出有上限。'
      : '作者还没绑定账号，你的灯火会记在这件作品上（计入作品灯火数与榜单综合分），不转给任何人；每人每天转出有上限。';
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
    $('tipRecent').innerHTML = '';
    updateTipBalance();
  }

  function updateTipBalance() {
    const pts = state.user ? Number(state.user.points || 0) : 0;
    $('tipBalance').innerHTML = state.user ? `我的灯火 <b>${pts}</b> 盏` : '登录后才能送灯火';
  }

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
  // 点遮罩空白处也能关
  bindMaskClose($('tipPanel'), () => $('tipClose').click());

  $('tipSend').onclick = async () => {
    const w = state.currentWork;
    if (!w || !tipSelAmount) return;
    const btn = $('tipSend');
    btn.disabled = true;
    try {
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
    hideModal(detailModal);
    navigate('/u/' + encodeURIComponent(w.author));  };

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
  $('claimEntry').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    if (!state.user) { openAuth('login'); return; }
    $('claimForm').reset();
    $('claimWorkTitle').value = w.title;
    showModal(claimModal);
    setTimeout(() => claimModal.querySelector('textarea[name="evidence"]').focus(), 60);
  };
  $('closeClaim').onclick = () => hideModal(claimModal);
  bindMaskClose(claimModal, () => hideModal(claimModal));

  $('claimForm').addEventListener('submit', async e => {
    e.preventDefault();
    const w = state.currentWork;
    if (!w) return;
    const form = e.target;
    const evidence = form.evidence.value.trim();
    const btn = $('claimBtn');
    if (evidence.length < 10) { showToast('请提供更具体的创作证据（至少 10 个字）', undefined, 'err'); form.evidence.focus(); return; }
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const res = await fetch('/api/works/' + w.id + '/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidence, contact: form.contact.value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || '提交失败', undefined, 'err'); return; }
      state.myClaims.push({ workId: w.id, status: 'pending', createdAt: new Date().toISOString() });
      hideModal(claimModal);
      showToast('已提交，管理员审核通过后作品就归你了', undefined, 'ok');
      openWork(w.id, false); // 刷新认领入口为「审核中」
    } catch { showToast('提交失败，请检查网络', undefined, 'err'); }
    finally { btn.disabled = false; btn.textContent = '提交认领申请'; }
  });

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
    if (location.pathname.startsWith('/w/')) {
      if (history.state && history.state.dm === 'work') {
        skipNextListReload = true;
        history.back();
      } else { history.pushState({}, '', '/'); route(); }
    }
    showToast('已屏蔽，可在顶部「屏蔽管理」里恢复', undefined, 'ok');
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
          if (history.state && history.state.dm === 'work') {
            history.back();
          } else { history.pushState({}, '', '/'); route(); }
        } else {
          route();
        }
        showToast(`已拉黑 @${w.author}，TA 的作品不再展示给你，可在顶部「屏蔽管理」里恢复`);
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
      cancelReply();
      // 重拉列表：提问要按「未回答置顶」重新排序，回复要挂到对应楼层
      await loadComments(w.id);
      paintCommentCount(w.id, $('commentList').querySelectorAll('[data-id]').length);
      showToast(payload.kind === 'question' ? '提问已发布，等作者来答' : '已发布', undefined, 'ok');
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
  $('editWork').onclick = () => {
    if (state.currentWork && editWorkFn) editWorkFn(state.currentWork);
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
let wishSort = 'hot';
let wishShown = 30;
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

function wishCardHtml(i) {
  const acts = [];
  acts.push(`<button type="button" class="wish-want${i.wanted ? ' is-on' : ''}" data-want="${escapeHtml(i.id)}"
    title="想要的人越多，越容易被做出来"><span class="ico">${ic('thumb')}</span> 我也想要 <b>${i.wants || 0}</b></button>`);
  if (i.status !== 'done') {
    if (i.claimer && i.claimer.mine) {
      acts.push(`<button type="button" class="wish-claim is-mine" data-done="${escapeHtml(i.id)}">我来标记已实现</button>`);
    } else if (!i.claimer && !i.mine) {
      acts.push(`<button type="button" class="wish-claim" data-claim="${escapeHtml(i.id)}">我来实现</button>`);
    }
  }
  if (i.mine) acts.push(`<button type="button" class="wish-del" data-del="${escapeHtml(i.id)}" title="删除这个想法">✕</button>`);
  const id = escapeHtml(i.id);
  return `<article class="wish-card${i.status === 'done' ? ' is-done' : ''}" data-card="${id}">
    <div class="wish-card-top">
      ${i.category ? `<span class="wish-cat">${escapeHtml(i.category)}</span>` : ''}
      ${wishStatusHtml(i)}
    </div>
    <button type="button" class="wish-card-title" data-open="${id}">${escapeHtml(i.title)}</button>
    ${i.detail ? `<p class="wish-card-detail">${escapeHtml(i.detail)}</p>` : ''}
    <div class="wish-card-meta">
      <span class="wish-author">@${escapeHtml(i.author)}</span>
      <span class="wish-when">${escapeHtml(wishWhen(i.createdAt))}</span>
      <button type="button" class="wish-discuss-n" data-open="${id}">${i.discussionCount || 0} 条讨论</button>
    </div>
    <div class="wish-card-foot">
      <span class="wish-actions">${acts.join('')}</span>
      <button type="button" class="wish-open" data-open="${id}">查看详情 ›</button>
    </div>
  </article>`;
}

// 大家最近在搜：服务端已把「真实搜索 + 冷启动种子」合并好，这里只负责画
// 只拉一次（榜单变化很慢）；拉失败就把整块收起来，别在页面上留一个空框
let hotSearchLoaded = false;
async function loadHotSearch() {
  const box = $('hotList');
  if (!box || hotSearchLoaded) return;
  hotSearchLoaded = true;
  try {
    const r = await fetch('/api/search/hot?limit=10');
    if (!r.ok) throw new Error('hot');
    const d = await r.json();
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) { $('hotBoard').style.display = 'none'; return; }
    hotItemsCache = items;
    box.innerHTML = items.map((it, i) => {
      const rank = i + 1;
      const badge = it.trend === 'new'
        ? '<span class="hot-badge">NEW</span>'
        : it.trend === 'up' ? '<span class="hot-badge is-up">↑</span>' : '';
      const n = it.n >= 10000 ? (it.n / 10000).toFixed(1) + 'w' : String(it.n);
      // zero = 搜过但站内没结果：这种词不该把人送去一个空搜索页，改成「一键转成想法」
      const zero = !!it.zero;
      return `<button type="button" class="hot-item${rank <= 3 ? ' is-top' : ''}${zero ? ' is-zero' : ''}"
        data-kw="${escapeHtml(it.w)}" data-zero="${zero ? '1' : '0'}"
        title="${zero ? '站内还没搜到，点一下把它变成想法' : '点一下去橱窗搜'}">
        <span class="hot-no">${rank}</span>
        <span class="hot-word">${escapeHtml(it.w)}${badge}</span>
        ${zero ? '<span class="hot-zero">缺</span>' : ''}
        <span class="hot-n">${n}<i>次</i></span>
      </button>`;
    }).join('');
    renderWishSuggest();
  } catch {
    hotSearchLoaded = false;   // 下次进页面再试
    box.innerHTML = '';
    $('hotBoard').style.display = 'none';
  }
}

// 页头数字：这里能把想法做成作品，先把结果摆出来，比一句口号有说服力
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
  const count = list ? list.querySelectorAll('.wish-card').length : 0;
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

async function loadIdeas(limit = wishShown) {
  const list = $('wishList');
  if (!list) return;
  wishShown = limit;
  try {
    const query = wishSort === 'mine'
      ? 'mine=1'
      : `sort=${wishSort === 'open' ? 'hot' : wishSort}${wishSort === 'open' ? '&status=open' : ''}`;
    const resp = await fetch(`/api/ideas?${query}&limit=${limit}`);
    if (resp.status === 401) { openAuth('login'); return; }
    const data = await resp.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const total = data.total || items.length;
    renderWishStats(data.stats);
    renderWishDone(data.doneList);
    if (wishSort === 'mine') {
      $('wishCount').textContent = total ? `我提的 ${total} 条` : '';
      if (!items.length) {
        list.innerHTML = '<div class="wish-empty">你还没提过想法——在上面写一句，等着有人来接</div>';
        $('wishMore').style.display = 'none';
        renderWishSuggest();
        return;
      }
    } else if (wishSort === 'open') {
      $('wishCount').textContent = total ? `${total} 个待认领` : '';
    } else {
      $('wishCount').textContent = total ? `${total} 个想法` : '';
    }
    if (!items.length) {
      list.innerHTML = wishSort === 'open'
        ? '<div class="wish-empty">暂时没有待认领的想法，去「最新想法」看看刚提出来的吧</div>'
        : '<div class="wish-empty">还没有人提想法——第一个说出你想要的吧</div>';
      $('wishMore').style.display = 'none';
      renderWishSuggest();
      return;
    }
    list.innerHTML = items.map(wishCardHtml).join('');
    $('wishMore').style.display = total > items.length ? '' : 'none';
    renderWishSuggest();
  } catch {
    list.innerHTML = '<div class="wish-empty">想法加载失败，稍后再试</div>';
  }
}

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
    loadIdeas();
  } catch { showToast('网络不太好，再试一次', undefined, 'err'); }
}

async function deleteWish(id) {
  if (!confirm('删除这个想法？')) return;
  try {
    const r = await fetch(`/api/ideas/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) return showToast(d.error || '删除失败', undefined, 'err');
    loadIdeas();
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
    loadIdeas();
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
    wishSort = 'new';
    document.querySelectorAll('.wish-tab').forEach(b => b.classList.toggle('active', b.dataset.sort === 'new'));
    loadIdeas(30);
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
    loadIdeas();
    openIdeaDetail(i.id);
  } catch (err) { showToast(err.message, undefined, 'err'); }
}

function setupWish() {
  const sec = $('wishView');
  if (!sec || sec._init) return;
  sec._init = 1;
  $('wishSubmit').onclick = () => submitWish();
  $('wishInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitWish(); });
  $('wishDetail').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitWish();
  });
  $('wishExtraToggle').onclick = () => openWishExtra();

  // 大家最近在搜：搜得到的直接去搜；zero 词（站内没结果）不再送人去空搜索页
  loadHotSearch();
  $('hotList').addEventListener('click', e => {
    const b = e.target.closest('button[data-kw]');
    if (!b) return;
    if (b.dataset.zero === '1') fillIdeaFromKeyword(b.dataset.kw);
    else applySearch(b.dataset.kw);
  });
  $('wishSuggest').addEventListener('click', e => {
    const b = e.target.closest('button[data-sug]');
    if (b) fillIdeaFromKeyword(b.dataset.sug);
  });
  $('wishTabs').addEventListener('click', e => {
    const b = e.target.closest('.wish-tab');
    if (!b) return;
    if (b.dataset.sort === 'mine' && !state.user) { openAuth('login'); return; }
    document.querySelectorAll('.wish-tab').forEach(x => x.classList.toggle('active', x === b));
    wishSort = b.dataset.sort;
    loadIdeas(30);
  });
  $('wishList').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) {
      if (btn.dataset.open) openIdeaDetail(btn.dataset.open);
      else if (btn.dataset.want) toggleWishWant(btn.dataset.want, btn);
      else if (btn.dataset.claim) claimWish(btn.dataset.claim);
      else if (btn.dataset.done) openWishDone(btn.dataset.done);
      else if (btn.dataset.del) deleteWish(btn.dataset.del);
      return;
    }
    if (e.target.closest('a')) return;   // 「已实现」是作品链接，交给浏览器
    const card = e.target.closest('.wish-card');
    if (card && card.dataset.card) openIdeaDetail(card.dataset.card);
  });
  $('wishMore').onclick = () => { $('wishMore').style.display = 'none'; loadIdeas(60); };
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
    loadIdeas();   // 卡片上的讨论数也要跟着变
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
    loadIdeas();
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
let redeemSel = { workId: '', mode: 'view', views: 0, clicks: 0, slot: 'detail', ext: false, link: '' };
let redeemData = null;

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
    key: 'detail', showViews: 1, showPoints: 1, clickPoints: 3, extClickPoints: 6,
    showPacks: [50, 100, 200], clickPacks: [5, 10, 20], exclusive: false
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
    if (!showPacks.includes(redeemSel.views)) redeemSel.views = showPacks[0] || 0;
  } else {
    redeemSel.views = 0;
    if (!clickPacks.includes(redeemSel.clicks)) redeemSel.clicks = clickPacks[0] || 0;
    // 外链要「点击包 + 非小程序位 + 作品登记了地址」三样齐了才成立
    if (redeemSel.ext && (cfg.internalOnly || !links.length)) redeemSel.ext = false;
    if (!redeemSel.ext) redeemSel.link = '';
    else if (!links.some(e => e.url === redeemSel.link)) redeemSel.link = links[0].url;
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
        <em>${clicks > 0 ? `${redeemSel.ext ? '外链点击' : '点击'} ${clickPrice} 灯火 · ${clicks} 次点击` : `曝光 ${showPrice} 灯火 · ${views} 次曝光`}</em>
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

// /promote 页面的内容加载：拉兑换位、作品、我的投放，再整版渲染
async function loadRedeemPanel() {
  const body = $('redeemBody');
  if (!body) return;
  if (!state.user) {
    body.innerHTML = `
      <div class="redeem-hero" style="display:block">
        <p class="rh-tip" style="min-width:0">登录后才能投放：选一件自己的作品，用灯火换首页第一格、榜单、发现页这些位置上的曝光。<br />还没灯火？<b>注册送 100 盏</b>，签到、分享和开源作品的 star 也能攒。</p>
        <div class="rh-links" style="text-align:left"><button type="button" class="btn-primary" id="promoteLoginBtn">先登录</button></div>
      </div>`;
    const lb = $('promoteLoginBtn');
    if (lb) lb.onclick = () => openAuth('login');
    return;
  }
  body.innerHTML = '<div class="stats-loading">加载中…</div>';
  try {
    const res = await fetch('/api/redeem/options', { cache: 'no-store' });
    redeemData = await res.json();
  } catch {
    body.innerHTML = '<div class="stats-loading">加载失败，请稍后重试</div>';
    return;
  }
  renderRedeem();
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
    ? `位置价格不同：${tier.map(x => `${x.name} ${x.showPoints} 盏/次曝光`).join('，')}——位置越靠前、同屏同时可见的条数越多，曝光越值钱，贵的那部分买的就是位置。`
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
        <span class="rs-main"><b>${escapeHtml(s.name)}${s.exclusive ? '<i class="rs-exclusive">独占</i>' : ''}${soon ? '<i class="rs-soon">内测中</i>' : ''}</b>
          <small>${escapeHtml(s.where || '')}</small>
          ${s.note ? `<small class="rs-note">${escapeHtml(s.note)}</small>` : ''}
          ${!s.exclusive && s.activeCount > 0 ? `<small class="rs-busy">在投 ${s.activeCount} 条 · 上后大家一起随机轮展</small>` : ''}
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
    return `<div class="rs-group${rec ? ' is-rec' : ''}">
        <div class="rs-group-head">
          <span class="ico">${ic(k === 'mini' ? 'mobile' : 'web')}</span><b>${meta.title}</b>
          ${rec ? '<i class="rs-rec">建议优先</i>' : (prefPlat ? '<em>也可以投</em>' : '')}
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
  const packsHtml = mode === 'view'
    ? `<div class="redeem-packs">${(cfg.showPacks || []).map(v => `
        <button type="button" class="redeem-pack${v === redeemSel.views ? ' is-on' : ''}" data-rviews="${v}">
          <b>${v} 次曝光</b><small>${Math.round(v / (cfg.showViews || 1) * (cfg.showPoints || 1))} 灯火</small>
        </button>`).join('')}</div>`
    : `<div class="redeem-packs">${(cfg.clickPacks || []).filter(v => v > 0).map(v => `
        <button type="button" class="redeem-pack${v === redeemSel.clicks ? ' is-on' : ''}" data-rclicks="${v}">
          <b>${v} 次点击</b><small>${v * effClickUnit()} 灯火</small>
        </button>`).join('')}</div>`;
  const modeNote = mode === 'view'
    ? '曝光包：被看到一次扣一次，点开的人只计数、<b>不另收费</b>；去向固定为作品详情页。'
    : `点击包：只有被点开才扣。去向在下一步选${cfg.internalOnly ? '，这个位置只跳站内详情页' : `：站内 ${cp} 盏/次，跳官网 / 下载 ${extCp} 盏/次`}。`;

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
    const clickOnly = (r.views || 0) === 0 && (r.clicks || 0) > 0;   // 纯点击包：没有曝光额度
    const queued = r.status === 'queued';
    // 排队中：进度条一律 0，foot 写清排第几位、前一位什么时候空出来
    const pct = queued ? 0 : (clickOnly
      ? Math.min(100, Math.round((r.clickUsed || 0) / r.clicks * 100))
      : (r.views ? Math.min(100, Math.round(r.used / r.views * 100)) : 0));
    const progress = queued
      ? `排队第 ${r.queuePos || 1} 位 · 前面这一单投完自动开始（灯火已扣，不消耗）`
      : (clickOnly
        ? `已点击 ${r.clickUsed || 0}/${r.clicks} 次`
        : `已曝光 ${r.used}/${r.views} 次${r.clicks ? ` · 点击 ${r.clickUsed}/${r.clicks} 次` : ''}`);
    // 投放中：把「已消耗多少 / 撤下能退多少」直接写出来，花了和退的永远对得上账
    const canBack = r.status === 'active' ? redeemRefundOf(r) : (queued ? (r.price || 0) : 0);
    const spent = Math.max(0, (r.price || 0) - canBack);
    const foot = r.status === 'active'
      ? [r.endsAt ? `最迟 ${redeemDate(r.endsAt)} 下线` : '', `已消耗 ${spent} 盏`, canBack > 0 ? `撤下可退 ${canBack} 盏` : '额度已用完']
          .filter(Boolean).join(' · ')
      : queued ? `随时可撤，全额退回 ${canBack} 盏`
        : (r.refunded ? `已消耗 ${(r.price || 0) - (r.refunded || 0)} 盏 · 已退回 ${r.refunded} 盏灯火` : '');
    return `<div class="redeem-item${queued ? ' is-queued' : ''}">
        <div class="ri-top">
          <span class="ri-title">${escapeHtml(r.workTitle)}${r.extLink ? `<i class="ri-ext" title="${escapeHtml(r.link || '')}">外链 ↗</i>` : ''}</span>
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
  }).join('')}</div>` : '<div class="redeem-empty">还没有投放记录。买一次曝光，作品就会出现在你选的位置上。</div>';

  body.innerHTML = `
    <div class="redeem-hero">
      <div class="rh-points"><b>${d.points || 0}</b><span>可用灯火</span></div>
      <p class="rh-tip">好友通过你的分享链接访问 +1 盏灯火，<b>扫码打开 +3 盏</b>（每人每天只计一次），注册 +100 盏灯火。<br />
        <b>曝光包</b>按「被看到」扣、<b>点击包</b>按「被点开」扣，用完自动下线；<b>没投完的部分随时可退</b>。</p>
      <div class="rh-share-row"><span>没灯火？<b>把作品分享给朋友</b>就能赚</span><button type="button" class="rh-share-btn" id="shareMyWork"><span class="ico">${ic('share')}</span> 去分享作品</button></div>
      <div class="rh-links"><button type="button" class="rh-link" id="promoStatsLink">看分享成绩与达人榜 →</button></div>
    </div>
    <div class="redeem-sec">
      <div class="redeem-sec-head">1. 选作品<span>只能推自己名下、已上线的作品</span></div>
      ${worksHtml}
    </div>
    <div class="redeem-sec redeem-sec-slots">
      <div class="redeem-sec-head">2. 选位置<span>${cfg.exclusive ? '这个位置全站只有一个，买到即独占；有人在投时排队等' : '同一个位置多人买，PC 一次并排 2-4 条同时曝光（手机一条），各家机会均等'}</span></div>
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
            <div class="rp-cfoot"><span>作者自荐 · 推荐位</span><b>看看 →</b></div>
          </div>
          <div class="rp-ad"><span class="ico">${ic('promo')}</span> 你的作品卡（第一格）</div>
        </div>` : cfg.key === 'mini-home-first' ? `
        <!-- 小程序·首页第一格：手机壳里的作品流，第一格是原生作品卡 -->
        <div class="rp-phone">
          <div class="rp-phone-screen">
            <div class="rp-mbar"></div>
            <div class="rp-mcard">
              <div class="rp-mcover">${selWork && selWork.thumb ? `<img src="${escapeHtml(selWork.thumb)}" alt="" />` : ''}<span class="rp-flag">推荐</span></div>
              <div class="rp-mcbody">
                <div class="rp-mctitle${selWork ? ' rp-real' : ' rp-ph'}">${selWork ? escapeHtml(selWork.title) : '你的作品标题'}</div>
                <div class="rp-mcfoot"><span>作者自荐 · 推荐位</span><b>看看 →</b></div>
              </div>
            </div>
            <div class="rp-mcard is-ghost"><div class="rp-mcover"></div><div class="rp-mcbody"><div class="rp-mctitle"></div></div></div>
          </div>
        </div>` : (cfg.key === 'mini-rank-line' || cfg.key === 'mini-feat-line' || cfg.key === 'mini-detail') ? `
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
        <!-- 榜单页顶部：横幅夹在标题/筛选栏和榜单列表之间，预览要能看出「不占名次」 -->
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
        <div class="rp-note">${cfg.key === 'list-first'
          ? '↑ 你的作品会以一张原生卡片出现在<br />首页作品列表的第一个位置'
          : cfg.key === 'mini-home-first'
            ? '↑ 你的作品会以一张原生卡片出现在<br />小程序首页作品流的第一个位置（独占）'
            : cfg.key === 'mini-rank-line'
              ? '↑ 一行文字出现在小程序星梦榜顶部，<br />多位投放时每次随机展示一条'
              : cfg.key === 'mini-feat-line'
                ? '↑ 一行文字出现在小程序发现页顶部，<br />多位投放时每次随机展示一条'
                : cfg.key === 'mini-detail'
                  ? '↑ 一行文字出现在小程序作品详情页，<br />评论区上方；点开作品的人才看得到，曝光少但都是真在挑作品的人'
          : cfg.key === 'rank'
            ? '↑ 横幅在榜单标题下方、榜单列表上方，<br />不占名次编号，带「推荐」角标'
            : '↑ 广告展示在这里：作品详情弹窗内，<br />作品简介和评论区之间。它只出现在<b>别人的</b>作品详情页，<br />投出去后用「我的投放 → 看效果」亲眼确认'}</div>
      </div>
    </div>
    <div class="redeem-sec">
      <div class="redeem-sec-head">3. 选套餐<span>先定按什么计费，再选买多少 · 下面是「${escapeHtml(cfg.name || '')}」的单价</span></div>
      ${modeHtml}
      ${packsHtml}
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
    <div class="redeem-foot">${redeemFootHtml()}
    </div>
    <p class="redeem-note">
      一次买好、按次扣减，投放期间不再额外扣灯火；额度用完只计数、不再计费。<br />
      「一次曝光」= 你的作品被一个访客看到一次（登录按账号、未登录按网络去重，同一个人一天只计一次，刷新不会重复扣）。<br />
      ${priceNote ? `${priceNote}<br />` : ''}
      每人同时最多 ${d.maxActive} 条在投；${d.maxDays} 天内没投完会自动下线，<b>剩余额度按原价退回灯火</b>；投放中也可以随时手动撤下，没投完的次数 × 单价原样退回——单价是整盏，退多少一分不差，花了多少、退多少都会列出来。
    </p>
    <div class="redeem-sec">
      <div class="redeem-sec-head">我的投放</div>
      ${mineHtml}
    </div>`;

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
  body.querySelectorAll('[data-rcancel]').forEach(el => {
    el.onclick = () => cancelRedeem(el.dataset.rcancel);
  });
  body.querySelectorAll('[data-rpeek]').forEach(el => {
    el.onclick = () => peekRedeem(el.dataset.rpeek);
  });
  const smb = $('shareMyWork');
  if (smb) smb.onclick = openSharePick;
  const psl = $('promoStatsLink');
  if (psl) psl.onclick = () => openStats('promo');
  const go = $('redeemGo');
  if (go) go.onclick = () => submitRedeem(go);
}

// ---------- 「看效果」：投出去了，带用户亲眼确认广告真的在跑 ----------
// 详情位的广告只出现在别人的作品详情页（打开自己的作品时不展示，多条广告每次随机抽一条），
// 用户自己刷半天可能碰不到，所以这里直接随机打开一件别人的作品让他看；
// 榜单位/首页第一格位置固定，直接带过去看。
async function peekRedeem(slot) {
  if (slot === 'rank') {
    navigate('/rank');
    showToast('你的横幅就在榜单标题下方（PC 上多条推荐并排展示）');
    return;
  }
  if (slot === 'list-first' || slot === 'mini-home-first') {
    if (location.pathname !== '/') navigate('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast(slot === 'list-first' ? '你的作品卡就在首页列表第一格' : '你的作品卡在小程序首页作品流第一格（网页上看不到，要在微信里打开小程序）');
    return;
  }
  if (slot === 'mini-rank-line' || slot === 'mini-feat-line') {
    showToast('这个位展示在微信小程序里（网页上看不到）；上线后打开小程序就能看到你那一行');
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
    if (!res.ok) { showToast(d.error || '兑换失败，请稍后重试', undefined, 'err'); return; }
    redeemData = d;
    redeemSel.mode = 'view';   // 下一单回到第 3 步的默认值，别把上单的点击包 / 外链带过来
    redeemSel.views = (curSlotCfg().showPacks || [])[0] || 0;
    redeemSel.clicks = 0;
    redeemSel.ext = false;
    redeemSel.link = '';
    renderRedeem();
    // 榜单页顶部是随机展示：给刚投放的作者在本机钉住自己那条，刷新即可验证生效；
    // 排队中的单子还没上线，不设置（等轮到他自动开始投放后再说）
    if (!d.queued && d.ad && d.ad.id) setMyAdPreview(d.ad, redeemSel.slot);
    showToast(d.queued
      ? `已排上队（第 ${d.queuePos || 1} 位），轮到你就自动开始投放`
      : (redeemSel.slot === 'list-first' ? '兑换成功，你的作品已经挂到首页第一格了'
        : redeemSel.slot === 'rank' ? '兑换成功，已投到榜单页顶部；刷新榜单页就能看到你那条'
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
  const usedTxt = r && (r.views || 0) === 0 && (r.clicks || 0) > 0
    ? `已点击 ${r.clickUsed || 0} 次`
    : `已曝光 ${r ? r.used || 0 : 0} 次${r && r.clicks ? ` · 已点击 ${r.clickUsed || 0} 次` : ''}`;
  const msg = queued
    ? `取消排队？\n\n这一单还没开始投放，${back} 盏灯火会全额退回，立即到账。`
    : `撤下这条推荐？\n\n这一单花了 ${r ? r.price || 0 : 0} 盏，${usedTxt}，对应消耗 ${spent} 盏；剩下没用的部分退回 ${back} 盏灯火，立即到账。`;
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
// 兑换成功后就地刷新头部灯火徽章、推荐面板的余额卡，并提示到账金额
function refreshPointsUI(points) {
  if (state.user) state.user.points = points;
  const chip = document.querySelector('.checkin-entry .ck-pts');
  if (chip) chip.innerHTML = `<span class="ico">${ic('lamp')}</span>${points}`;
  const pc = $('pointsCard');
  if (pc && pc.querySelector('b')) pc.querySelector('b').textContent = points;
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
      <button type="button" class="pt-go" id="ptGoRedeem">兑换推荐位曝光 <i>›</i></button>
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
        <div class="pt-right"><b class="pt-amt ${cls}">${sign}${amt}</b><span class="pt-time">${hm(g.lastT)}</span></div>
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

async function openStats(mode) {
  mode = ['data', 'promo', 'checkin', 'points'].includes(mode) ? mode : 'data';   // data = 作品数据 / promo = 分享成绩与达人榜 / checkin = 每日签到 / points = 灯光明细
  if (!state.user) { openAuth('login'); return; }
  const body = $('statsBody');
  $('statsTitle').textContent = mode === 'promo' ? '分享成绩与达人榜'
    : mode === 'checkin' ? '每日签到'
    : mode === 'points' ? '灯光明细'
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
      <button type="button" class="pt-star-hint" id="ptGoStar" title="开源作品的 GitHub star 能换灯火：每涨 1 个自动 +1 盏；开始同步前已有的 star 可以申请">
        <span class="ico">${ic('lock-open')}</span>
        <span><b>作品标注开源、源码在 GitHub？star 能换灯火</b>：每涨 1 个自动 +1 盏；开始同步前已有的 star 到「分享成绩」点「申请 star 奖励」，100 star 以内当场到账。</span>
        <i>›</i>
      </button>
      <div class="stats-actions">
        <button type="button" class="stats-redeem" id="ptGoRedeem2">用灯火买曝光</button>
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
    state.user.points = share.points;   // 同步头部灯火徽章
    const chip = document.querySelector('.checkin-entry .ck-pts');
    if (chip) chip.innerHTML = `<span class="ico">${ic('lamp')}</span>${share.points}`;
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
        <div class="board-row${b.username === state.user.username ? ' is-me' : ''}">
          <span class="board-rank${b.rank <= 3 ? ' top' : ''}">${b.rank}</span>
          <span class="board-name">${escapeHtml(b.name)}</span>
          <span class="board-num">${b.visits} 访问 · ${b.regs} 邀请</span>
          <b class="board-pts">${b.points}<i>灯火</i></b>
        </div>`).join('')}
    </div>` : '';
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

  // 开源作品奖励：标注开源自动 +50（一件一次）；GitHub star 涨值自动 1:1，
  // 存量 star / 其他托管站走「申请」：≤100 当场到账，>100 转站长核定（后端 /api/star/apply）
  // withApply=false 用在没有作品的地方（空状态）：连仓库都还没有，就别先给他「申请」的按钮
  const STAR_APPLY_AUTO_MAX = 100;   // 与 server.js 的 STAR_AUTO_APPLY_MAX 保持一致

  const applyStarReward = async (btn) => {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在核对 star…';
    try {
      const r = await fetch('/api/star/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(d.error || '申请失败，稍后再试', undefined, 'err'); return; }
      const got = (d.auto || []).reduce((s, x) => s + (x.awarded || 0), 0);
      const wait = d.manual || [];
      const bits = [];
      if (got > 0) bits.push(`已到账 ${got} 盏灯火`);
      if (wait.length) bits.push(`${wait.length} 件超过 ${STAR_APPLY_AUTO_MAX} star，已提交站长核定`);
      if (!bits.length) bits.push((d.skipped && d.skipped[0] && d.skipped[0].reason) || '没有可申领的 star');
      showToast(bits.join('，'), 4200, got > 0 ? 'ok' : undefined);
      if (got > 0) {
        const pc = $('pointsCard');
        if (pc && d.points) pc.querySelector('b').textContent = d.points;
      }
    } catch {
      showToast('网络不给力，稍后再试', undefined, 'err');
    } finally {
      btn.innerHTML = old;
      btn.disabled = false;
    }
  };

  const osBonusCard = (opts = {}) => `
    <div class="os-bonus">
      <div class="ob-head"><span class="ico">${ic('lock-open')}</span> 开源作品奖励</div>
      <p><b>标注「开源」自动送 50 盏</b>：一件作品一次，同一个源码仓库只认第一次。灯火能直接拿去「推荐」买曝光。</p>
      <p><b>仓库在 GitHub：star 自动换灯火。</b>每涨 1 个 star 自动到账 1 盏，不用申请——系统每 6 小时同步一次，涨多少发多少，掉 star 不扣。同一仓库每天最多 2000 盏，到顶第二天接着算。只结算开始同步之后新涨的部分，<b>上线前就有的 star 不自动补</b>（点下面按钮申请）。</p>
      <p><b>存量 star 与其他托管站：点按钮申请。</b><b>${STAR_APPLY_AUTO_MAX} star 以内系统当场到账</b>（1 star = 1 盏）；超过 ${STAR_APPLY_AUTO_MAX} 的转站长核定后发放。Gitee、GitLab、AtomGit 等平台读不到 star，一律站长人工核对。</p>
      ${opts.withApply === false ? '' : `<button type="button" class="ob-btn" id="starApplyBtn"><span class="ico">${ic('coin')}</span> 申请 star 奖励</button>`}
    </div>`;
  const osBonusHtml = osBonusCard();

  // 每日签到弹窗（头部「签到」按钮直达）：签到卡 + 签到累计榜，攒灯火的入口都收在这里
  if (mode === 'checkin') {
    body.innerHTML = `
      ${ckCard}
      ${ckBoard}
      <div class="stats-actions">
        <button type="button" class="stats-redeem" id="goRedeem">攒够了？给自己的作品买曝光</button>
        <button type="button" class="stats-gift-link" id="goPromoStats"><span class="ico">${ic('bars', 15)}</span> 看分享成绩与达人榜</button>
      </div>`;
    $('goRedeem').onclick = () => { hideModal(statsModal); openRedeem(); };
    $('goPromoStats').onclick = () => openStats('promo');
    bindCheckin();
    return;
  }

  // 分享成绩与达人榜（从「推荐」弹窗进来）：积分 + 分享成绩 + 灯火达人榜（和作品数据无关，没有作品也能看）
  if (mode === 'promo') {
    body.innerHTML = `
      <div class="stats-summary">${shareCards}</div>
      ${osBonusHtml}
      <div class="stats-actions">
        <button type="button" class="stats-redeem" id="goRedeem">用灯火买曝光</button>
        <button type="button" class="stats-gift-link" id="goGiftCode"><span class="ico">${ic('ticket')}</span> 有兑换码？点这里领灯火</button>
      </div>
      ${boardHtml}
      ${promoLine}
      <p class="stats-tip">${shareTip}</p>`;
    $('goRedeem').onclick = () => { hideModal(statsModal); openRedeem(); };
    $('goGiftCode').onclick = () => openGiftCode();
    // 申领存量 star：小额后端直接到账，大额自动转站长核定（结果用 toast 汇总）
    const starBtn = $('starApplyBtn');
    if (starBtn) starBtn.onclick = () => applyStarReward(starBtn);
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
        <p class="stats-empty-sub">提交新作品，或对已收录的作品发起「认领」，通过后这里就会显示它的浏览、点赞与收藏数据。</p>
        <button class="btn-primary" id="statsGoSubmit">＋ 去提交作品</button>
      </div>
      <div class="stats-empty-reward">${osBonusCard({ withApply: false })}</div>`;
    $('statsGoSubmit').onclick = () => { hideModal(statsModal); $('openUpload').click(); };
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

  body.innerHTML = `
    <div class="stats-summary is-line">${summaryLine}</div>
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
// 我的收藏：切换首页列表的「只看收藏」过滤（入口在头像下拉里）
function toggleFavorites() {
  // 收藏跟着账号走，未登录先登录
  if (!state.favoritesOnly && !state.user) {
    openAuth('login');
    showToast('登录后可查看你的收藏');
    return;
  }
  state.favoritesOnly = !state.favoritesOnly;
  const item = $('favDrop');
  if (item) item.classList.toggle('active', state.favoritesOnly);
  if (location.pathname !== '/') {
    navigate('/');
    // 从其他页点收藏：别停在首页顶部，滚到列表区让「我的收藏」直接出现在眼前
    if (state.favoritesOnly) scrollWorksHeadSoon();
  } else {
    // 就在首页：开着过滤时如果列表区不在视野里（比如还在看精选），也带过去
    loadWorks();
    if (state.favoritesOnly) scrollWorksHeadSoon();
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

// 搜索 = 一次全局查询：顺手把形态/分类/开源/时间筛选复位。
// 不复位的话，上次筛着「学习教育」再搜「小程序」会得到 0 条——看着像搜不到，其实是被筛选挡住了。
function resetListFilters() {
  state.category = '全部';
  state.type = '全部';
  state.openSource = '全部';
  state.range = '全部';
  renderFilters();
}

function applySearch(word) {
  const q = String(word || '').trim();
  state.q = q;
  state.favoritesOnly = false;
  if (q) resetListFilters();
  if (location.pathname !== '/') navigate('/'); else loadWorks();
}

function setupSearchSuggest() {
  const input = $('searchInput');
  const panel = $('searchSuggest');
  if (!input || !panel) return;

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
  const collapseMobile = () => { if (inner) inner.classList.remove('search-open'); };
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
      collapseMobile();
      input.blur();
      close();
    });
    // 搜索覆盖层开着时，点它以外的地方只收搜索层，不把这一下点透传给底下的卡片/按钮
    const box = panel.closest('.search-box');
    document.addEventListener('click', e => {
      if (!inner.classList.contains('search-open')) return;
      if (box.contains(e.target) || mBtn.contains(e.target)) return;
      e.stopPropagation();
      collapseMobile();
      input.blur();
      close();
    }, true);
    // Esc 也能退出搜索覆盖层（顺便照顾平板横屏）
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
      collapseMobile(); // 手机端：搜完把展开的搜索行收回去，头部恢复一行
    }
  });

  panel.addEventListener('click', e => {
    const btn = e.target.closest('button[data-kw]');
    if (!btn) return;
    const kw = btn.dataset.kw;
    input.value = kw;
    pushSearchHistory(kw);
    close();
    collapseMobile(); // 手机端：点了词条搜完也收起展开的搜索行
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

function setupHeader() {
  // 首页 hero 的三个动作词：提交作品开投稿弹窗（跟右上角「＋ 提交作品」同一个入口）；
  // 投递灵感是 /bar 普通链接不用绑；点亮灯火未登录先拉登录，已登录提示去作品卡片送灯火
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

  // PC：最新 / 最热 排序切换（H5 由筛选栏的「最新」tab 承担，这个按钮在 H5 上不显示）
  document.querySelectorAll('#sortToggle .st-btn').forEach(btn => {
    btn.onclick = () => {
      state.sort = btn.dataset.sort;
      state.favoritesOnly = false;
      document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
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

  $('loadMore').onclick = () => { state.page += 1; loadWorks(false); };

  // 榜单四个下拉（形态/周期/排序/数量）共用一套开合逻辑
  [['rankTypeBtn', 'rankTypeDD', 'rankTypePanel', 'type'],
   ['rankPeriodBtn', 'rankPeriodDD', 'rankPeriodPanel', 'period'],
   ['rankByBtn', 'rankByDD', 'rankByPanel', 'by'],
   ['rankLimitBtn', 'rankLimitDD', 'rankLimitPanel', 'limit']].forEach(([btnId, ddId, panelId, attr]) => {
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
        t.dataset.limit ? Number(t.dataset.limit) : null, t.dataset.type || null);
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

  // SPA 链接拦截
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-nav]');
    if (a && a.origin === location.origin) {
      e.preventDefault();
      // 点 logo 回首页 = 回到默认浏览态，清掉收藏过滤
      if (a.classList.contains('logo') && state.favoritesOnly) {
        state.favoritesOnly = false;
        const favDrop = $('favDrop');
        if (favDrop) favDrop.classList.remove('active');
      }
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
  mb.style.display = w.owned ? 'inline-block' : 'none';
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
    $('feedbackHint').innerHTML = hintText(preset);
    if (preset && preset.type) {
      const sel = form.querySelector('select[name="type"]');
      // 预选类型：合作洽谈/交换友链等入口带过来，找不到对应 option 就落到「合作/其他」
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

  // 页脚「合作洽谈 / 交换友链」等按钮：打开反馈弹窗并预选类型、替换提示语
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-fb]');
    if (!b) return;
    e.preventDefault();
    openFeedback({ type: b.dataset.fb, hint: b.dataset.fbHint || '' });
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
    // 本设备支持原生安装（桌面 Chrome/Edge、安卓）就亮出一键安装
    const native = $('installNative');
    native.style.display = installPromptEvent ? '' : 'none';
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
  // 作品详情页 /w/ 除外（完整页面模式要展示它，route 里再处理）；编年史 /chronicle、作品规范 /rules、安装页 /install 整页靠它渲染，也保留
  const keepSeo = location.pathname.startsWith('/w/') ||
    location.pathname === '/chronicle' || location.pathname === '/rules' || location.pathname === '/install' || location.pathname === '/invite';
  if (!keepSeo) removeSeoBlock();
  // 先按上次的登录态快照把右上角画出来（此刻首绘还没发生，视觉上零跳变），
  // 再等 /api/me 校准；顺手把「登录 / 注册」按钮的点击绑成事件委托（预置按钮也要能点）
  restoreMeSnapshot();
  $('authBox').addEventListener('click', e => {
    if (e.target.closest('.auth-open')) { e.stopPropagation(); openAuth('login'); }
  });
  captureFr();    // 再处理 ?fr=：只记渠道来源，不加分
  captureRef();   // 先处理 ?ref=：记下分享者并上报，再把参数从地址栏摘掉
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
  loadGuestNotices();  // 未登录访客：顶部公告条（登录用户不展示，走铃铛）
  startNoticePoll();   // 有未读消息就点亮铃铛，之后每 60 秒补一次
  if (state.user && Number(state.user.unreadNotices || 0) > 0) {
    setTimeout(() => showToast(`你有 ${state.user.unreadNotices} 条新消息，${noticeTipText()}`, 5000), 800);
    loadNotices(true);
  }
  claimPwaBonus();  // PWA（添加到主屏幕）里打开且已登录：一次性领 200 盏灯火
  // 先把当前页面画出来：该页自己的数据（榜单/列表/详情）立刻开始拉。
  // 原来这行在 6 个接口串行 await 的最后，/rank 要等 5 个来回才开始请求榜单，
  // 4G 节流下实测白等 2.6 秒，期间屏幕上还是首页——「换页总先加载首页」就是这么来的。
  route();
  // 剩下的都是「补齐类」元数据：分类、工具清单、广告位，并行拉，回来后再刷新依赖它们的面板
  await Promise.all([loadCategories(), loadTools(), ensureAds()]);
  // 分类/形态选项补齐后重绘榜单筛选栏（H5 重绘 tab 栏，PC 只补形态下拉的数字）
  if (location.pathname === '/rank') { if (isH5View()) renderRankFilterBarH5(); else renderRankTypePanel(); }
  setupHeader();
  setupUploadForm();
  setupMdEditor();         // 简介的 Markdown「写 / 预览」切换
  setupCommentKindTabs(); // 先绑评论/提问切换，别被详情弹窗其他绑定的问题牵连
  setupDetailActions();
  setupAuthForms();
  setupSubmitChoice();
  setupFeedback();
  fbRefreshDot();  // 反馈悬浮球：有站长回复没看就亮个小红点（异步，不挡首屏）
  setupInstall();
  afterLoadAuth();  // GitHub 授权回来的提示 + 补上登录前点的「投稿」
  setupPromoKit();  // 外宣包弹窗（按钮在详情页，弹窗只需要绑一次）
  // 本屏 hero 进场动画播完后记账：之后本标签页刷新不再重播（head 内联脚本读到标记就关动画）
  setTimeout(() => { try { sessionStorage.setItem('dm_hero_played', '1'); } catch { /* 隐私模式就算了 */ } }, 1500);
  // 造梦酒馆是独立页面，进入 /bar 时再初始化（见 route）
  // 本周精选：滚动/窗口变化时同步箭头状态
  $('featRow').addEventListener('scroll', updateFeatNav, { passive: true });
  window.addEventListener('resize', updateFeatNav);
  // route() 已经在上面（登录态就绪后）跑过了，这里不能再调一次：重复调 = 重复拉一遍榜单/列表
}

// ---------- 友情链接（页脚，后台「友情链接」配置） ----------
async function loadFooterFriends() {
  try {
    const list = await (await fetch('/api/friends')).json();
    const box = $('footerFriends');
    if (!box || !Array.isArray(list) || !list.length) return;
    box.style.display = '';
    box.innerHTML = '<span class="ff-label">友情链接：</span>' +
      list.map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener nofollow">${escapeHtml(f.name)}</a>`)
        .join('<span class="ff-sep">·</span>');
  } catch { /* 拿不到就不展示，无害 */ }
}

// 页脚站点统计：今日/累计 PV·UV（公开接口，无明细；提交引导头部已有，页脚不再重复）
async function loadFooterStats() {
  const el = $('footerStats');
  if (!el) return;
  try {
    const s = await (await fetch('/api/site-stats')).json();
    // 编年史入口挂在「已运营 N 天」上：语义天然贴合（天数→这一路怎么长起来的），也比埋在「参与」链接堆里好找
    el.innerHTML =
      `<a class="fs-item fs-link" href="/chronicle" title="造梦橱窗大事记：这一路是怎么长起来的">` +
        (s.runDays
          ? `已运营 <b>${s.runDays}</b> 天${s.launchDate ? `（${s.launchDate} 起）` : ''}<span class="fs-chron">· 造梦编年史 →</span>`
          : `造梦编年史 →`) +
      `</a>` +
      `<span class="fs-item">今日 <b>${s.pvToday || 0}</b> 次访问</span>` +
      `<span class="fs-item">今日 <b>${s.uvToday || 0}</b> 位访客</span>` +
      `<span class="fs-item">累计 <b>${s.pv || 0}</b> 次访问</span>` +
      `<span class="fs-item">累计 <b>${s.uv || 0}</b> 位访客</span>`;
    el.style.display = '';
  } catch {
    // 统计拉不到也不能把编年史入口一起弄丢（它现在只挂在这一行上）
    el.innerHTML = `<a class="fs-item fs-link" href="/chronicle">造梦编年史 →</a>`;
    el.style.display = '';
  }
}

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
