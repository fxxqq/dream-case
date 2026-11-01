// 造梦橱窗 - 前端逻辑
'use strict';

let CATEGORIES = ['全部'];
let typeCounts = {}, catCounts = {}, totalWorks = 0; let osCounts = { open: 0, closed: 0 }; // 筛选下拉选项的计数
let TYPES = ['全部', '网站', '小程序', 'App', '智能体', '桌面应用', '浏览器扩展', '其他'];
let CUSTOM_MODE = false;

const state = {
  sort: 'latest',
  type: '全部',
  category: '全部',
  openSource: '全部', // 是否开源筛选：全部 / 是 / 否
  q: '',
  page: 1,
  hasMore: false,
  favoritesOnly: false,
  currentWork: null,
  commentKind: 'comment', // 发言类型：comment 评论 / question 提问
  replyTo: null,          // 正在回复的评论：{ rootId, targetId }
  tools: [],
  user: null,
  favs: [], // 当前登录用户收藏的作品 id（服务端存储，按收藏时间倒序）
  blocked: [], // 当前登录用户屏蔽过的作品 id（服务端存储，同步过来用于展示数量）
  myClaims: [], // 我的作品认领申请 [{ workId, status }]
  // 展示方式：card 卡片网格 / list 一行一个的紧凑列表（记住用户的选择）
  view: localStorage.getItem('dm_view') === 'list' ? 'list' : 'card'
};

// 从作品详情弹窗退回列表页时置为 true：列表 DOM 仍然完整，route() 不要重新拉取，
// 否则已加载的分页会丢失、「展示更多」按钮重新出现，看起来像整页刷新
let skipNextListReload = false;

const $ = id => document.getElementById(id);
const gallery = $('gallery');
const detailModal = $('detailModal');
const uploadModal = $('uploadModal');
const submitChoiceModal = $('submitChoiceModal');
const reportModal = $('reportModal');
const blockedModal = $('blockedModal');
const statsModal = $('statsModal');
const toast = $('toast');

const TYPE_ICONS = { '网站': '🌐', '小程序': '📱', 'App': '📲', '智能体': '🤖', '桌面应用': '🖥️', '浏览器扩展': '🧩', '工具': '🛠️', '游戏': '🎮', '其他': '✨' };

// ---------- 弹窗滚动锁定 ----------
// 锁定背景滚动，但用 padding-right 补偿滚动条宽度，
// 这样打开弹窗时滚动条占位不消失、页面不跳动。
let scrollLockCount = 0;
let scrollLockY = 0;
function lockScroll() {
  if (++scrollLockCount > 1) return;
  scrollLockY = window.scrollY;
  const gap = window.innerWidth - document.documentElement.clientWidth;
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
// 移动端形态：宣传图按手机竖屏比例展示与压缩；其余按 PC 宽幅
const MOBILE_TYPES = ['小程序', 'App'];
const LINK_LABEL = {
  '网站': '🌐 打开网站', '小程序': '📱 打开小程序', 'App': '📲 前往下载',
  '智能体': '🤖 体验智能体', '桌面应用': '🖥️ 下载客户端', '浏览器扩展': '🧩 前往安装',
  '工具': '🛠️ 打开工具', '游戏': '🎮 开始游戏', '其他': '🔗 访问作品'
};
// 各形态的访问方式规则：网站 → 链接必填；其他形态链接选填；小程序 → 二维码必填
const TYPE_LINK_FIELD = {
  '网站':  { link: true,  qr: false, label: '网站地址 *',   ph: 'https://你的网站地址' },
  '小程序': { link: false, qr: true },
  'App':   { link: false, qr: false, label: '下载链接（选填）', ph: 'https://下载页 / 应用商店链接' },
  '智能体': { link: false, qr: false, label: '体验链接（选填）', ph: 'https://智能体对话页链接' },
  '桌面应用': { link: false, qr: false, label: '下载链接（选填）', ph: 'https://官网下载页 / 安装包链接' },
  '浏览器扩展': { link: false, qr: false, label: '安装链接（选填）', ph: 'https://Chrome / Edge 商店链接' },
  '工具':  { link: false, qr: false, label: '工具链接（选填）', ph: 'https://工具地址' },
  '游戏':  { link: false, qr: false, label: '游戏链接（选填）', ph: 'https://在线试玩 / 下载页链接' },
  '其他':  { link: false, qr: false, label: '作品链接（选填）',   ph: 'https://...' }
};
// 链接必填的形态：只有网站
const LINK_REQUIRED_TYPES = ['网站'];

// 作品形态可多选：types 数组为主，兼容旧的单值 type
function typesOf(w) {
  if (Array.isArray(w.types) && w.types.length) return w.types;
  return [w.type || '网站'];
}
function typeText(w) {
  return typesOf(w).map(t => `${TYPE_ICONS[t] || '✨'} ${t}`).join(' · ');
}
function linkLabelOf(types) {
  for (const t of types) if (LINK_LABEL[t]) return LINK_LABEL[t];
  return '🔗 访问作品';
}
// 多形态合并规则：含小程序 → 需要二维码；含网站 → 链接必填；其他形态链接选填
function ruleOfTypes(types) {
  const qr = types.indexOf('小程序') !== -1;
  const link = types.indexOf('网站') !== -1;
  // 除纯小程序外都展示链接框（后台新增的自定义形态同样支持填链接）
  const other = types.filter(t => t !== '小程序');
  const hasLinkField = other.length > 0;
  const t = other.find(x => TYPE_LINK_FIELD[x]) || other[0];
  const base = (t && TYPE_LINK_FIELD[t]) || { link: false, qr: false, label: '作品链接（选填）', ph: 'https://...' };
  return { link, qr, hasLinkField, label: base.label, ph: base.ph };
}
function isMobileTypes(types) { return types.some(t => MOBILE_TYPES.indexOf(t) !== -1); }

// ---------- 基础工具 ----------
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2400);
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
    showToast(err.message || '操作失败，请稍后再试');
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
    if (d.added) showToast(`已把本机 ${d.added} 个收藏同步到账号`);
  } catch {}
}
function renderDetailFav(id) {
  const el = document.getElementById('detailFav');
  if (!el) return;
  const faved = isFav(id);
  el.innerHTML = faved ? '★ 已收藏' : '☆ 收藏';
  el.classList.toggle('faved', faved);
}

// ---------- 登录 / 注册 ----------
const authModal = document.getElementById('authModal');
let pendingPublish = false;
let editId = null; // 编辑模式下的作品 id
let editWorkFn = null; // setupUploadForm 内部注入
let resetUploadForm = () => {}; // setupUploadForm 内部注入（afterAuth 等外部也会调用）
let restoreUploadDraft = () => false; // 恢复本地草稿（闭包内注入）
let clearUploadDraft = () => {}; // 清除草稿（提交成功后调用）
let applyTypeFieldsFn = () => {}; // setupUploadForm 内部注入：按形态切换链接/二维码字段
let updateRepoFieldFn = () => {}; // setupUploadForm 内部注入：开源时显示/必填源码仓库

function renderAuthBox() {
  const box = $('authBox');
  if (state.user) {
    const n = (state.blocked || []).length;
    box.innerHTML =
      `<a class="user-chip" href="/u/${encodeURIComponent(state.user.username)}" data-nav title="我的主页">👤 ${escapeHtml(state.user.username)}</a>` +
      `<button class="link-btn stats-entry" id="statsBtn" title="我的作品数据">📊 数据</button>` +
      (n ? `<button class="link-btn blocked-entry" id="blockedBtn" title="查看已屏蔽的作品">🚫 ${n}</button>` : '') +
      `<button class="link-btn" id="logoutBtn">退出</button>`;
    $('logoutBtn').onclick = doLogout;
    $('statsBtn').onclick = openStats;
    const bb = $('blockedBtn');
    if (bb) bb.onclick = openBlockedList;
  } else {
    box.innerHTML = '<button class="btn-ghost auth-open" id="loginEntry">登录 / 注册</button>';
    $('loginEntry').onclick = () => openAuth('login');
  }
}

function openAuth(mode = 'login', thenPublish = false) {
  pendingPublish = thenPublish;
  switchAuth(mode);
  showModal(authModal);
  setTimeout(() => authModal.querySelector(mode === 'login' ? '#loginForm input' : '#registerForm input').focus(), 50);
}

function switchAuth(mode) {
  $('authTitle').textContent = mode === 'login' ? '登录' : '注册';
  $('loginForm').style.display = mode === 'login' ? 'block' : 'none';
  $('registerForm').style.display = mode === 'login' ? 'none' : 'block';
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
  submitChoiceModal.onclick = e => { if (e.target === submitChoiceModal) closeSubmitChoice('cancel'); };
}

async function afterAuth(data) {
  state.user = { username: data.username };
  state.favs = Array.isArray(data.favs) ? data.favs : [];
  renderAuthBox();
  hideModal(authModal);
  showToast(`欢迎，${data.username}！`);
  // 先把本机旧收藏并入账号，再补上登录前点的那颗星
  await mergeLocalFavs();
  if (pendingFavId) {
    const id = pendingFavId;
    pendingFavId = null;
    if (!isFav(id)) {
      const added = await toggleFav(id);
      if (added) showToast('已加入收藏 ⭐');
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
    if (restored) showToast('已恢复上次未提交的草稿（图片需重新选择）');
  }
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  state.user = null;
  state.favs = [];
  state.myClaims = [];
  renderAuthBox();
  showToast('已退出登录');
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
    state.user = data.username ? { username: data.username } : null;
    state.favs = Array.isArray(data.favs) ? data.favs : [];
    state.blocked = Array.isArray(data.blocked) ? data.blocked : [];
  } catch { state.user = null; state.favs = []; state.blocked = []; }
  await loadMyClaims();
  if (state.user) await mergeLocalFavs(); // 本机遗留的旧收藏（换设备/重新登录都会补一次）
  renderAuthBox();
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

function setupAuthForms() {
  $('closeAuth').onclick = () => { hideModal(authModal); pendingPublish = false; };
  authModal.onclick = e => { if (e.target === authModal) $('closeAuth').click(); };
  $('toRegister').onclick = e => { e.preventDefault(); switchAuth('register'); };
  $('toLogin').onclick = e => { e.preventDefault(); switchAuth('login'); };

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
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
      if (!res.ok) throw new Error(data.error || '登录失败');
      afterAuth(data);
    } catch (err) { showToast(err.message); }
    finally { btn.disabled = false; btn.textContent = '登录'; }
  });

  $('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('registerBtn');
    btn.disabled = true; btn.textContent = '注册中...';
    try {
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      payload.remember = !!fd.get('remember');
      const res = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '注册失败');
      afterAuth(data);
    } catch (err) { showToast(err.message); }
    finally { btn.disabled = false; btn.textContent = '注册并登录'; }
  });
}

// ---------- 卡片渲染 ----------
// 开源 / 闭源 徽章（未标注返回空串）
function osBadgeHtml(w, cls = '') {
  if (w.openSource === true) return `<span class="os-badge open ${cls}" title="开放源代码">🔓 开源</span>`;
  if (w.openSource === false) return `<span class="os-badge closed ${cls}" title="未开放源代码">🔒 闭源</span>`;
  return '';
}

// 付费徽章：默认免费不显示，只有作者标注「需要付费」才出现
function paidBadgeHtml(w, cls = '') {
  return w.paid ? `<span class="os-badge paid ${cls}" title="需要付费或含付费版本">💰 付费</span>` : '';
}

function cardHtml(w, opts = {}) {
  const types = typesOf(w);
  const cc = w.commentCount || 0;
  return `
    <div class="card" data-id="${w.id}">
      <a class="card-link" href="/w/${w.id}" aria-label="查看《${escapeHtml(w.title)}》完整页面"></a>
      <div class="card-img-wrap">
        <img class="card-img" src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />
        <span class="type-badge" title="${escapeHtml(types.join(' / '))}">${escapeHtml(typeText(w))}</span>
        ${w.pinned ? '<span class="pin-badge">置顶</span>' : ''}
        <button class="fav-star ${isFav(w.id) ? 'active' : ''}" data-fav="${w.id}" title="收藏">★</button>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(w.title)}</div>
        <div class="card-meta">
          <span class="card-author">${w.verified ? '<i class="verified">✔</i>' : ''}@${escapeHtml(w.author)}</span>
          <span class="card-tags"><span class="card-cat">${escapeHtml(w.category)}</span>${osBadgeHtml(w)}${paidBadgeHtml(w)}</span>
        </div>
        <div class="card-meta" style="margin-top:6px">
          <span>♥ ${w.likes} · <span class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="★ ">★ ${w.favs || 0}</span> · 👁 ${w.views}${cc ? ` · <span class="cmt-num" data-comment-count="${w.id}" data-count="${cc}" data-prefix="💬 ">💬 ${cc}</span>` : ''}</span>
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
        ${w.intro ? `<div class="row-intro">${escapeHtml(w.intro)}</div>` : ''}
        <div class="row-meta">${escapeHtml(typeText(w))} · ${w.verified ? '<i class="verified">✔</i>' : ''}@${escapeHtml(w.author)} · ${escapeHtml(w.category)}${w.openSource === true ? ' · 🔓 开源' : w.openSource === false ? ' · 🔒 闭源' : ''}${w.paid ? ' · 💰 付费' : ''}</div>
      </div>
      <div class="row-stats">
        <span class="row-stat">♥ <b>${w.likes}</b></span>
        <span class="row-stat">★ <b class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</b></span>
        <span class="row-stat">👁 <b>${w.views}</b></span>
        ${cc ? `<span class="row-stat">💬 <b class="cmt-num" data-comment-count="${w.id}" data-count="${cc}" data-prefix="">${cc}</b></span>` : ''}
      </div>
      <button class="row-fav ${isFav(w.id) ? 'active' : ''}" data-fav="${w.id}" title="收藏">★</button>
    </div>`;
}

// 竖版图片（手机截图/竖屏宣传图）放进横版卡片时，若仍按 cover 裁切会放大得非常模糊；
// 改为完整展示（contain），并用同图放大做模糊底图填充空白，观感更清晰
// 注意：只作用于列表卡片的 .card-img-wrap 包裹层，精选小卡的 56×56 头像不适用
document.addEventListener('load', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (!img.classList.contains('card-img') || !img.naturalWidth) return;
  const wrap = img.closest('.card-img-wrap');
  if (!wrap || wrap.classList.contains('bg-blur')) return;
  if (img.naturalHeight > img.naturalWidth) {
    img.classList.add('fit-show');
    wrap.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
    wrap.classList.add('bg-blur');
  }
}, true);

function bindCards(container) {
  container.querySelectorAll('.card, .work-row').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.fav) return;
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
      showToast(added ? '已加入收藏 ⭐' : '已取消收藏');
    });
  });
}

// ---------- 数据加载 ----------
async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    CATEGORIES = await res.json();
  } catch {
    CATEGORIES = ['全部', '效率工具', '生活助手', '内容创作', '学习教育', '娱乐游戏', '开发工具', '其他'];
  }
  if (!CATEGORIES.includes(state.category)) state.category = '全部';
  // 统计各形态/分类的作品数，筛选下拉选项后面带数字
  try {
    // 全量拉取统计各分类/形态数量（pageSize=all 表示不分页）
    const list = (await (await fetch('/api/works?pageSize=all')).json()).items || [];
    typeCounts = {}; catCounts = {}; osCounts = { open: 0, closed: 0 };
    list.forEach(w => {
      if (w.category) catCounts[w.category] = (catCounts[w.category] || 0) + 1;
      typesOf(w).forEach(t => { typeCounts[t] = (typeCounts[t] || 0) + 1; });
      if (w.openSource === true) osCounts.open++; else osCounts.closed++;
    });
    totalWorks = list.length;
  } catch { /* 统计失败不影响筛选 */ }
  renderFilters();
  renderCategorySelect();
}

async function loadTools() {
  try { state.tools = await (await fetch('/api/tools')).json(); } catch { state.tools = []; }
}

// ---------- 广告位 ----------
// 页面上有 5 个固定的空位（data-ad-slot），内容全部来自后台「广告位」。
// 同一位置挂多支广告时前台自动轮播；一个都没有就保持隐藏，不留白。
const AD_ROTATE_MS = 7000;
let ADS = [];
const adSeen = new Set();   // 本次浏览已上报过曝光的广告 id
let adObserver = null;

async function loadAds() {
  try {
    const data = await (await fetch('/api/ads')).json();
    ADS = Array.isArray(data.ads) ? data.ads : [];
  } catch { ADS = []; }
  renderAllAdSlots();
}

function adHtml(a) {
  const img = a.image
    ? `<img class="ad-bg" src="${escapeHtml(a.image)}" alt="" loading="lazy" />`
    : '';
  return `<a class="ad-card${a.image ? ' has-img' : ''}" href="${escapeHtml(a.url)}"
      target="_blank" rel="noopener nofollow sponsored" data-ad="${escapeHtml(a.id)}">
      ${img}
      <span class="ad-body">
        <span class="ad-badge">广告</span>
        ${a.title ? `<b class="ad-title">${escapeHtml(a.title)}</b>` : ''}
        ${a.desc ? `<span class="ad-desc">${escapeHtml(a.desc)}</span>` : ''}
        <span class="ad-cta">${escapeHtml(a.cta || '了解更多')} →</span>
      </span>
    </a>`;
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
  sendBeaconSafe('/api/ads/' + encodeURIComponent(id) + '/impression');
}

function observeAds(root) {
  if (!('IntersectionObserver' in window)) return;
  if (!adObserver) {
    adObserver = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) maybeReportAd(en.target); });
    }, { threshold: 0.5 });
  }
  root.querySelectorAll('a.ad-card').forEach(el => adObserver.observe(el));
}

function sendBeaconSafe(url) {
  try {
    if (navigator.sendBeacon) { navigator.sendBeacon(url); return; }
    fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  } catch { /* 埋点失败不影响浏览 */ }
}

function renderAdSlot(el, slot) {
  if (!el) return;
  clearInterval(el._adTimer);           // 重新渲染前先停掉旧的轮播
  el._adTimer = null;
  const list = ADS.filter(a => a.slot === slot);
  if (!list.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  if (list.length === 1) {
    el.innerHTML = adHtml(list[0]);
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

// 点击埋点：用事件委托，广告是新渲染出来的也能记到
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a.ad-card');
  if (!a || !a.dataset.ad) return;
  sendBeaconSafe('/api/ads/' + encodeURIComponent(a.dataset.ad) + '/click');
});

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
      meta.forEach(t => { TYPE_ICONS[t.name] = t.icon || '✨'; });
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
    return `<label class="type-opt"><input type="checkbox" name="types" value="${escapeHtml(t)}"${on ? ' checked' : ''} /><span>${TYPE_ICONS[t] || '✨'} ${escapeHtml(t)}</span></label>`;
  }).join('');
}

// 精选区：数据没变就不动 DOM（静默刷新），避免闪烁与滚动位置跳动
let featuredSig = '';
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
let featuredIds = new Set();
async function loadFeatured() {
  try {
    const list = await (await fetch('/api/featured', { cache: 'no-store' })).json();
    const sig = list.map(w => w.id).join(',') + '|' + list.length;
    featuredIds = new Set(list.map(w => w.id));
    syncDetailFeaturedBadge();
    if (sig === featuredSig) return;
    featuredSig = sig;
    const section = $('featuredSection');
    const row = $('featuredRow');
    if (!list.length) {
      row.innerHTML = '';
      section.style.display = 'none';
      return;
    }
    const keepLeft = row.scrollLeft;   // 原地替换内容时保留轮播位置，不把用户拉回第一张
    section.style.display = 'block';
    row.innerHTML = list.map(w => `
      <div class="featured-card" data-id="${w.id}">
        <img src="${w.thumb}" alt="${escapeHtml(w.title)}" loading="lazy" />
        <div class="featured-body">
          <div class="featured-title" title="${escapeHtml(w.title)}">${escapeHtml(w.title)}</div>
          ${w.intro ? `<div class="featured-intro">${escapeHtml(w.intro)}</div>` : ''}
          <div class="featured-meta">♥ ${w.likes || 0} 赞 · 👁 ${w.views || 0} 浏览</div>
        </div>
        <span class="feat-arrow">↗</span>
      </div>`).join('');
    row.querySelectorAll('.featured-card').forEach(el =>
      el.addEventListener('click', () => openWork(el.dataset.id)));
    setupFeatCarousel();
    row.scrollLeft = keepLeft;
    updateFeatNav();
  } catch { /* ignore */ }
}

// 详情弹窗里也有「✨ 精选」标签：后台改了精选时同步它，不需要关掉弹窗重开
function syncDetailFeaturedBadge() {
  const w = state.currentWork;
  if (!w || $('detailModal').style.display !== 'flex') return;
  const should = featuredIds.has(w.id);
  if (!!w.featured === should) return;
  w.featured = should;
  const cat = $('detailCategory').querySelector('.badge-featured');
  if (should && !cat) {
    $('detailCategory').insertAdjacentHTML('beforeend', '<span class="badge-featured">✨ 精选</span>');
  } else if (!should && cat) cat.remove();
}

// 精选轮播：左右箭头 + 滑动进度条 + 拖拽滚动
function setupFeatCarousel() {
  const row = $('featuredRow');
  const prev = $('featPrev'), next = $('featNext');
  const step = () => {
    const card = row.querySelector('.featured-card');
    return card ? (card.offsetWidth + 14) * 2 : 400;
  };
  prev.onclick = () => row.scrollBy({ left: -step(), behavior: 'smooth' });
  next.onclick = () => row.scrollBy({ left: step(), behavior: 'smooth' });
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

    // 下方进度条可点击/拖动直接滚动（拖住蓝条或点轨道任意位置都行）
    const prog = $('featProgress');
    let scrubbing = false;
    const scrubTo = e => {
      const rect = prog.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      row.scrollLeft = ratio * (row.scrollWidth - row.clientWidth);
    };
    prog.addEventListener('pointerdown', e => {
      scrubbing = true;
      prog.classList.add('scrubbing');
      row.classList.add('dragging'); // 拖进度条时临时禁用卡片吸附，更跟手
      try { prog.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      scrubTo(e);
    });
    prog.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e); });
    const endScrub = () => {
      if (!scrubbing) return;
      scrubbing = false;
      prog.classList.remove('scrubbing');
      row.classList.remove('dragging');
    };
    prog.addEventListener('pointerup', endScrub);
    prog.addEventListener('pointercancel', endScrub);
  }
}
function updateFeatNav() {
  const row = $('featuredRow');
  if (!row || !row.children.length) return;
  const max = row.scrollWidth - row.clientWidth;
  const noOverflow = max <= 4;
  // 卡片有 scroll-snap，最右端会差十几像素对不齐，容差放大到 24 避免箭头一直亮着
  const TOL = 24;
  $('featPrev').disabled = row.scrollLeft <= TOL;
  $('featNext').disabled = row.scrollLeft >= max - TOL;
  // 不溢出时用 visibility 隐藏箭头/进度条：保留占位高度，切换精选时页面不会上下跳
  document.querySelector('.featured-nav').style.visibility = noOverflow ? 'hidden' : 'visible';
  const prog = $('featProgress');
  prog.style.visibility = noOverflow ? 'hidden' : 'visible';
  if (noOverflow) return;
  const bar = $('featBar');
  bar.style.width = Math.max(12, row.clientWidth / row.scrollWidth * 100) + '%';
  bar.style.marginLeft = (row.scrollLeft / row.scrollWidth * 100) + '%';
}

// 后台改了精选/置顶/审核/删除 → 前台静默同步（不整页重载、不打断浏览）
// 同浏览器多标签：BroadcastChannel + localStorage 双通道即时通知；其他设备：切回标签页/聚焦时拉一次
(function setupSilentSync() {
  const refresh = () => {
    // 只刷新精选区（数据没变连 DOM 都不动）＋详情弹窗里的精选标签，
    // 不重载页面、不打断浏览，滚动位置和轮播位置都保留
    loadFeatured();
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

async function loadWorks(reset = true) {
  if (reset) state.page = 1; // 先不清空容器，等数据到达再替换，避免页面高度塌陷把滚动位置钳回顶部
  const params = new URLSearchParams({
    sort: state.sort, type: state.type, category: state.category,
    page: state.page, pageSize: 12
  });
  if (state.q) params.set('q', state.q);
  if (state.openSource === '是') params.set('os', 'open');
  else if (state.openSource === '否') params.set('os', 'closed');

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
    if (reset) gallery.innerHTML = ''; // 数据到手再替换，旧内容保留期间页面高度稳定
    gallery.insertAdjacentHTML('beforeend', html);
    bindCards(gallery);

    const emptyP = $('empty').querySelector('p');
    if (emptyP) emptyP.textContent = state.favoritesOnly
      ? '还没有收藏任何作品，点作品右上角的 ★ 就会出现在这里'
      : '没有找到作品，换个关键词或分类试试？';
    $('empty').style.display = gallery.children.length ? 'none' : 'block';
    $('workCount').textContent = `共 ${data.total} 件`;
    $('listTitle').textContent = state.favoritesOnly
      ? '我的收藏'
      : state.q ? `搜索「${state.q}」` : `${state.category === '全部' ? '全部作品' : state.category}`;
    state.hasMore = !!data.hasMore;
    $('loadMore').style.display = state.hasMore ? 'inline-block' : 'none';
  } catch {
    showToast('加载失败，请检查网络或服务状态');
  }
}

// ---------- 筛选器 ----------
// 筛选区：形态 / 分类两个下拉胶囊（参考「分类 ▾」式紧凑布局）
function closeAllDD() {
  document.querySelectorAll('.dd-filter.open').forEach(x => x.classList.remove('open'));
}
function renderFilters() {
  const row = $('filterRow');
  if (!row) return;
  const conf = [
    {
      kind: 'type', icon: '🧩', label: '形态',
      value: state.type === '全部' ? '全部形态' : `${TYPE_ICONS[state.type] || ''} ${state.type}`,
      active: state.type !== '全部',
      opts: TYPES
    },
    {
      kind: 'category', icon: '🗂️', label: '分类',
      value: state.category, active: state.category !== '全部',
      opts: CATEGORIES
    },
    {
      kind: 'os', icon: '🔓', label: '开源',
      value: state.openSource === '全部' ? '全部' : state.openSource === '是' ? '🔓 是' : '🔒 否',
      active: state.openSource !== '全部',
      opts: ['全部', '是', '否']
    }
  ];
  row.innerHTML = conf.map(c => {
    const cur = c.kind === 'type' ? state.type : c.kind === 'os' ? state.openSource : state.category;
    return `
    <div class="dd-filter" data-kind="${c.kind}">
      <button type="button" class="dd-btn${c.active ? ' has-value' : ''}">
        <span class="dd-ico">${c.icon}</span><span class="dd-label">${c.label}</span>
        <b class="dd-value">${escapeHtml(c.value)}</b><span class="dd-caret">▾</span>
      </button>
      <div class="dd-panel">
        ${c.opts.map(o => {
          let n;
          if (o === '全部') n = totalWorks;
          else if (c.kind === 'type') n = typeCounts[o] || 0;
          else if (c.kind === 'os') n = osCounts[o === '是' ? 'open' : 'closed'] || 0;
          else n = catCounts[o] || 0;
          const icon = c.kind === 'type' && o !== '全部' ? (TYPE_ICONS[o] || '') + ' '
            : c.kind === 'os' && o === '是' ? '🔓 '
            : c.kind === 'os' && o === '否' ? '🔒 ' : '';
          return `
          <button type="button" class="dd-opt${o === cur ? ' active' : ''}" data-v="${escapeHtml(o)}">
            <span class="dd-opt-label">${icon}${escapeHtml(o)}</span>
            <span class="dd-count">${n}</span>
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
        else if (kind === 'os') state.openSource = opt.dataset.v;
        else { state.category = opt.dataset.v; state.favoritesOnly = false; }
        closeAllDD();
        renderFilters();
        loadWorks();
      });
    });
  });
}
// 点面板外任意位置收起下拉
document.addEventListener('click', closeAllDD);

function renderCategorySelect() {
  const select = $('categorySelect');
  select.innerHTML = CATEGORIES.filter(c => c !== '全部')
    .map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
    + `<option value="__new__">＋ 新增分类...</option>`;
}

// ---------- 路由 ----------
const SITE_NAME = '造梦橱窗';
const DEFAULT_TITLE = `${SITE_NAME} - 让好作品被更多人看见`;

function setTitle(t) { document.title = t ? `${t} - ${SITE_NAME}` : DEFAULT_TITLE; }

// 是否处于「完整页面」形态（/w/:id?full=1，用于分享与搜索引擎收录）
function isFullView() {
  return new URLSearchParams(location.search).get('full') === '1';
}

// 服务端为 SEO 预渲染的内容块：客户端接管后清掉，避免与 SPA 视图重复
function removeSeoBlock() {
  const el = document.getElementById('seoContent');
  if (el) el.remove();
}

function navigate(path) {
  history.pushState({}, '', path);
  route();
}

function closeAllViews() {
  ['homeView', 'rankView', 'authorView'].forEach(id => { $(id).style.display = 'none'; });
  hideModal(detailModal);
}

// 导航高亮：榜单页亮「榜单」，其余按当前排序/收藏态亮对应按钮
function updateNavActive() {
  const onRank = location.pathname === '/rank';
  const rankLink = document.querySelector('.nav-btn[href="/rank"]');
  if (rankLink) rankLink.classList.toggle('active', onRank);
  document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
    b.classList.toggle('active', !onRank && b.dataset.sort === state.sort));
  $('favBtn').classList.toggle('active', !onRank && state.favoritesOnly);
}

// ---------- 访问统计：页面浏览上报（PV；UV 由后端按账号/IP 去重） ----------
let lastTrack = { path: '', at: 0 };
let lastWorkTrack = { id: '', at: 0 };
function trackPageView() {
  const p = location.pathname + location.search;
  const now = Date.now();
  if (p === lastTrack.path && now - lastTrack.at < 1500) return; // 同路径 1.5s 内不重复计
  lastTrack = { path: p, at: now };
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }), keepalive: true
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

function route() {
  trackPageView();
  const path = location.pathname;
  // 从详情弹窗退回：列表视图原样保留，不重新拉数据（分页、滚动位置、「展示更多」都不动）
  const keepList = skipNextListReload;
  skipNextListReload = false;
  const keepScrollY = keepList ? window.scrollY : 0; // 视图隐藏再显示会把滚动位置钳回顶部，这里记下来还原
  const restoreScroll = () => { if (keepList) requestAnimationFrame(() => window.scrollTo(0, keepScrollY)); };
  closeAllViews();

  const isWorkPage = path.startsWith('/w/');
  document.body.classList.toggle('on-work', isWorkPage);
  if (!isWorkPage) removeSeoBlock();

  if (isWorkPage) {
    // 完整页面模式（?full=1）：直接展示服务端渲染的整页，不自动弹窗
    const seoEl = document.getElementById('seoContent');
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
    setTitle('作品榜单');
    if (!keepList) loadRank(); // 不强制回「本周」，保留用户上次选的周期/排序
    updateNavActive();
    restoreScroll();
    return;
  }
  $('homeView').style.display = 'block';
  setTitle(state.q ? `搜索「${state.q}」` : '');
  if (!keepList) {
    loadFeatured();
    loadWorks();
  }
  updateNavActive();
  restoreScroll();
}

// ---------- 作者主页 ----------
async function loadAuthor(name) {
  $('authorName').textContent = '@' + name;
  $('authorAvatar').textContent = name.slice(0, 1).toUpperCase();
  setTitle(`@${name} 的作品`);
  try {
    const data = await (await fetch('/api/authors/' + encodeURIComponent(name))).json();
    $('authorBio').textContent = data.bio || '';
    $('authorStats').innerHTML =
      `${data.verified ? '<span class="verified-tag">✔ 认证创作者</span> ' : ''}` +
      `作品 ${data.total} · 累计获赞 ${data.totalLikes} · 被收藏 ${data.totalFavs || 0}`;
    $('authorGallery').innerHTML = data.works.map(w => cardHtml(w)).join('') ||
      '<div class="empty"><p>这位作者还没有作品</p></div>';
    bindCards($('authorGallery'));
  } catch {
    $('authorGallery').innerHTML = '<div class="empty"><p>作者不存在</p></div>';
  }
}

// ---------- 榜单 ----------
const rankState = { period: 'week', by: 'hot' };
async function loadRank(period, by) {
  if (period) rankState.period = period;
  if (by) rankState.by = by;
  document.querySelectorAll('.rank-tab[data-period]').forEach(b =>
    b.classList.toggle('active', b.dataset.period === rankState.period));
  document.querySelectorAll('.rank-tab[data-by]').forEach(b =>
    b.classList.toggle('active', b.dataset.by === rankState.by));
  try {
    const list = await (await fetch(`/api/rank?period=${rankState.period}&by=${rankState.by}&limit=20`)).json();
    const cur = rankState.by;
    $('rankList').innerHTML = list.length ? list.map(w => `
      <div class="rank-item" data-id="${w.id}">
        <div class="rank-no rank-no-${w.rank <= 3 ? w.rank : 'n'}">${w.rank}</div>
        <img src="${w.thumb}" alt="" loading="lazy" />
        <div class="rank-main">
          <div class="rank-title">${escapeHtml(w.title)}</div>
          <div class="rank-meta">${escapeHtml(typeText(w))} · @${escapeHtml(w.author)} · ${escapeHtml(w.category)}</div>
        </div>
        <div class="rank-score">
          <span class="${cur === 'likes' ? 'on' : ''}">♥ ${w.likes || 0}</span>
          <span class="${cur === 'favs' ? 'on' : ''}">★ ${w.favs || 0}</span>
          <span class="${cur === 'hot' ? 'on' : ''}">👁 ${w.views || 0}</span>
        </div>
      </div>`).join('') : '<div class="empty"><p>暂无上榜作品</p></div>';
    $('rankList').querySelectorAll('.rank-item').forEach(el =>
      el.addEventListener('click', () => openWork(el.dataset.id)));
  } catch { showToast('榜单加载失败'); }
}

// ---------- 作品详情 ----------
async function openWork(id, push = true) {
  try {
    const w = await (await fetch('/api/works/' + id)).json();
    if (w.error) { showToast(w.error); return; }
    state.currentWork = w;
    // 作品维度 PV：以弹窗方式打开时单独上报一次；/w/xxx 直链已由 trackPageView 计入，不重复
    if (push || location.pathname !== '/w/' + id) trackWorkView(id);
    if (push) {
      history.pushState({ dm: 'work' }, '', '/w/' + id);
      // 不再用 on-work 隐藏首页内容（会让页面塌陷、滚动条消失并跳动），
      // 背景内容保留、由下方 showModal 锁定滚动
    }
    setTitle(w.title);

    $('detailImg').src = w.image;
    $('detailTitle').textContent = w.title;
    $('detailCategory').innerHTML =
      typesOf(w).map(t => `<span class="badge-type">${TYPE_ICONS[t] || '✨'} ${escapeHtml(t)}</span>`).join('') +
      `<span class="badge-cat">${escapeHtml(w.category)}</span>` +
      osBadgeHtml(w) +
      paidBadgeHtml(w) +
      (w.featured ? '<span class="badge-featured">✨ 精选</span>' : '');
    $('detailAuthor').innerHTML = `${w.verified ? '<i class="verified">✔</i> ' : ''}@${escapeHtml(w.author)}`;
    $('detailStats').innerHTML = `♥ ${w.likes} 点赞 · ★ <span class="fav-num" data-fav-count="${w.id}" data-count="${w.favs || 0}" data-prefix="">${w.favs || 0}</span> 人收藏 · 💬 <span class="cmt-num" data-comment-count="${w.id}" data-count="${w.commentCount || 0}" data-prefix="">${w.commentCount || 0}</span> 评论 · 👁 ${w.views} 浏览 · ${formatDate(w.createdAt)}`;
    $('detailPrompt').textContent = w.intro || '';
    $('detailLikes').textContent = w.likes;

    const linkBtn = $('detailLink');
    if (w.link) {
      linkBtn.href = w.link;
      linkBtn.textContent = linkLabelOf(typesOf(w));
      linkBtn.style.display = 'inline-block';
    } else linkBtn.style.display = 'none';

    // 开源作品的源码仓库入口
    const repoBtn = $('detailRepo');
    if (w.repo) { repoBtn.href = w.repo; repoBtn.style.display = 'inline-block'; }
    else repoBtn.style.display = 'none';

    // 完整页面（独立 URL，可分享、可被搜索引擎收录）
    $('fullPageBtn').href = '/w/' + encodeURIComponent(w.id) + '?full=1';

    const qrBox = $('detailQrBox');
    if (w.qrcode) { $('detailQr').src = w.qrcode; qrBox.style.display = 'block'; }
    else qrBox.style.display = 'none';

    // 宣传图画廊：左右箭头循环切换大图，缩略图点击直达；缩略图比例跟随作品形态
    const gal = $('detailGallery');
    const isMobile = isMobileTypes(typesOf(w));
    detailModal.querySelector('.modal').classList.toggle('is-mobile', isMobile);
    gal.classList.toggle('is-mobile', isMobile);
    const imgs = w.images || [];
    galState.list = [w.image].concat(imgs);
    galState.offset = 1;
    galState.idx = 0;
    const hasArrow = galState.list.length > 1;
    $('galPrev').style.display = hasArrow ? 'flex' : 'none';
    $('galNext').style.display = hasArrow ? 'flex' : 'none';
    if (imgs.length) {
      gal.innerHTML = imgs.map((src, i) =>
        `<img src="${escapeHtml(src)}" data-src="${escapeHtml(src)}" alt="${escapeHtml(w.title)} 宣传图${i + 1}" loading="lazy" />`).join('');
      gal.style.display = 'flex';
      gal.querySelectorAll('img').forEach((im, k) => {
        im.onclick = () => setDetailImage(galState.offset + k);
      });
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

    // 自己的作品：显示编辑 / 删除；别人的作品：登录后可屏蔽
    const canManage = !!w.owned;
    $('editWork').style.display = canManage ? 'inline-block' : 'none';
    $('delWork').style.display = canManage ? 'inline-block' : 'none';
    $('blockWork').style.display = (!canManage && state.user) ? 'inline-block' : 'none';

    // 认领入口：只有管理员开放了认领的作品才显示（自己的作品不显示）
    const entry = $('claimEntry');
    const mine = myClaimOf(w.id);
    if (canManage || w.owned || !w.claimable) {
      entry.style.display = 'none';
    } else if (mine && mine.status === 'pending') {
      entry.style.display = 'inline-block';
      entry.className = 'claim-entry is-pending';
      entry.textContent = '⏳ 认领申请审核中';
      entry.disabled = true;
    } else {
      entry.style.display = 'inline-block';
      entry.className = 'claim-entry';
      entry.disabled = false;
      entry.textContent = state.user ? '🙋 这是我做的，认领作品 →' : '🙋 这是你的作品？登录后认领 →';
    }

    loadComments(w.id);

    showModal(detailModal);
  } catch { showToast('作品加载失败'); }
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
      <span class="comment-avatar${c.anon ? ' anon' : ''}">${escapeHtml((c.username || '?').slice(0, 1).toUpperCase())}</span>
      <div class="comment-body">
        <div class="comment-meta">
          <b>@${escapeHtml(c.username)}</b>${commentBadges(c)}
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
      <span class="comment-avatar sm${r.anon ? ' anon' : ''}">${escapeHtml((r.username || '?').slice(0, 1).toUpperCase())}</span>
      <div class="comment-body">
        <div class="comment-meta">
          <b>@${escapeHtml(r.username)}</b>${commentBadges(r)}
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

async function loadComments(workId) {
  const listEl = $('commentList');
  const countEl = $('commentCount');
  const input = $('commentInput');
  const nick = $('commentNickname');
  input.value = '';
  cancelReply();
  if (state.user) {
    nick.style.display = 'none';
    $('commentHint').textContent = `以 @${state.user.username} 的身份发言`;
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
    form.querySelectorAll('input[name="types"]').forEach(i => { i.checked = want.indexOf(i.value) !== -1; });
    if (!selectedTypes().length) form.querySelector('input[name="types"]').checked = true; // 至少留一个
    applyTypeFields();
  }
  // 宣传图统一为一个「有序列表」，支持拖拽/箭头调整顺序：
  //   { kind:'old', url }  编辑模式下服务器上已有的图
  //   { kind:'new', file, src }  本次新选/粘贴的图
  let galleryItems = [];
  let originalImages = []; // 编辑模式：服务器上原有的宣传图（用于计算删除项）
  let qrCleared = false;   // 编辑模式：二维码被删除
  let pasteTarget = 'image'; // 当前粘贴目标：image / qrcode / images

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
      if (galleryItems.length >= MAX_GALLERY) { showToast(`宣传图最多 ${MAX_GALLERY} 张`); return; }
      addGalleryFile(file);
      showToast(`已粘贴宣传图 ${galleryItems.length}/${MAX_GALLERY}`);
      return;
    }
    const input = target === 'qrcode' ? form.qrcode : form.image;
    if (!setFileInput(input, file)) { showToast('当前浏览器不支持粘贴，请点击上传'); return; }
    showToast(target === 'qrcode' ? '已粘贴二维码 ✅' : '已粘贴封面 ✅');
  }

  // 按作品形态显示/隐藏 链接 / 二维码 字段，并切换预览比例（支持多选）
  function applyTypeFields() {
    const types = selectedTypes().length ? selectedTypes() : ['网站'];
    const rule = ruleOfTypes(types);
    $('linkField').style.display = rule.hasLinkField ? 'block' : 'none';
    $('qrField').style.display = rule.qr ? 'block' : 'none';
    $('linkLabel').textContent = rule.label;
    form.link.placeholder = rule.ph;
    // 只有网站必填链接（同步给原生校验）
    form.link.required = rule.link;
    // 移动端形态：宣传图/封面预览按手机竖屏比例
    const mobile = isMobileTypes(types);
    $('galleryPreviews').classList.toggle('mobile', mobile);
    $('previewBox').classList.toggle('mobile', mobile);
  }
  applyTypeFieldsFn = applyTypeFields;

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
    $('previewImg').removeAttribute('src');
    $('previewBox').style.display = 'none';
    $('coverText').innerHTML = editId
      ? '保留原封面，点击可更换<br /><small>也可直接 Ctrl+V 粘贴截图</small>'
      : '点击上传封面图<br /><small>支持 JPG / PNG / WebP，也可直接 Ctrl+V 粘贴截图</small>';
    setPasteTarget('image');
  };
  $('qrClear').onclick = e => {
    e.preventDefault();
    form.qrcode.value = '';
    $('qrPreviewImg').removeAttribute('src');
    $('qrPreviewBox').style.display = 'none';
    qrCleared = true;   // 编辑模式下：提交时真正删除服务器上的二维码
    showToast('已删除二维码');
  };

  function resetUploadForm() {
    editId = null;
    $('modalTitle').textContent = '提交作品';
    // 审核规则不在表单顶部唠叨，留到点「提交」时的选择弹窗里再说
    $('formHint').textContent = state.user ? `作者：${state.user.username}` : '';
    $('formHint').style.display = state.user ? 'block' : 'none';
    $('authorField').style.display = state.user ? 'none' : 'block';
    form.reset();
    form.image.required = true;
    CUSTOM_MODE = false;
    newCatInput.style.display = 'none';
    $('previewBox').style.display = 'none';
    $('qrPreviewBox').style.display = 'none';
    $('submitBtn').textContent = '提交';
    galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
    galleryItems = [];
    originalImages = [];
    qrCleared = false;
    renderGalleryPreviews();
    $('coverText').innerHTML = '点击上传封面图<br /><small>支持 JPG / PNG / WebP，也可直接 Ctrl+V 粘贴截图</small>';
    setSelectedTypes(['网站']);
    setPasteTarget('image');
  }
  resetUploadForm = resetUploadForm; // 暴露给外部（afterAuth 用）
  restoreUploadDraft = restoreDraft;
  clearUploadDraft = clearDraft;

  // ---- 关闭保护 + 草稿（新建模式）----
  const DRAFT_KEY = 'upload_draft';
  let draftTimer = null;
  function uploadDirty() {
    if (['title', 'link', 'prompt'].some(k => form[k] && form[k].value.trim())) return true;
    if (form.image.files.length || (form.qrcode && form.qrcode.files.length)) return true;
    if (galleryItems.length) return true;
    return false;
  }
  function saveDraft() {
    if (editId) return; // 编辑模式不存草稿
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        types: selectedTypes(), title: form.title.value,
        category: form.category.value, customCat: CUSTOM_MODE ? newCatInput.value.trim() : '',
        openSource: (form.querySelector('input[name="openSource"]:checked') || {}).value || '',
        repo: form.repo.value,
        paid: (form.querySelector('input[name="paid"]:checked') || {}).value || '',
        prompt: form.prompt.value, link: form.link.value, t: Date.now()
      }));
    } catch {}
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
  function restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d) return false;
      if (!['title', 'link', 'prompt'].some(k => (d[k] || '').trim())) return false;
      if (Array.isArray(d.types) && d.types.length) setSelectedTypes(d.types);
      else if (d.type) setSelectedTypes([d.type]);
      form.title.value = d.title || '';
      if ([...form.category.options].some(o => o.value === d.category)) form.category.value = d.category;
      CUSTOM_MODE = !!d.customCat;
      newCatInput.style.display = CUSTOM_MODE ? 'block' : 'none';
      if (CUSTOM_MODE) newCatInput.value = d.customCat;
      form.prompt.value = d.prompt || '';
      form.link.value = d.link || '';
      const osDraft = form.querySelector(`input[name="openSource"][value="${d.openSource || ''}"]`);
      if (osDraft) osDraft.checked = true;
      const paidDraft = form.querySelector(`input[name="paid"][value="${d.paid || ''}"]`);
      if (paidDraft) paidDraft.checked = true;
      form.repo.value = d.repo || '';
      applyTypeFields();
      updateRepoFieldFn();
      return true;
    } catch { return false; }
  }
  form.addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });
  form.addEventListener('change', () => saveDraft());

  // 标注开源时必须填写源码仓库地址
  function updateRepoField() {
    const os = (form.querySelector('input[name="openSource"]:checked') || {}).value || '';
    const show = os === '1';
    $('repoField').style.display = show ? 'block' : 'none';
    form.repo.required = show;
    if (!show) form.repo.value = '';
  }
  form.querySelectorAll('input[name="openSource"]').forEach(r => r.addEventListener('change', updateRepoField));
  updateRepoFieldFn = updateRepoField;

  editWorkFn = startEdit;
  function startEdit(w) {
    editId = w.id;
    hideModal(detailModal);
    $('modalTitle').textContent = '编辑作品';
    $('formHint').textContent = `作者：${w.author} · 修改后立即生效`;
    $('formHint').style.display = 'block';
    setSelectedTypes(typesOf(w));
    form.title.value = w.title;
    form.prompt.value = w.intro || '';
    form.link.value = w.link || '';
    if ([...form.category.options].some(o => o.value === w.category)) form.category.value = w.category;
    const osVal = w.openSource === true ? '1' : w.openSource === false ? '0' : '';
    const osInput = form.querySelector(`input[name="openSource"][value="${osVal}"]`);
    if (osInput) osInput.checked = true;
    const paidInput = form.querySelector(`input[name="paid"][value="${w.paid ? '1' : ''}"]`);
    if (paidInput) paidInput.checked = true;
    form.repo.value = w.repo || '';
    updateRepoFieldFn();
    form.image.required = false; // 编辑时可以不换封面
    newCatInput.style.display = 'none';
    $('submitBtn').textContent = '保存修改';
    galleryItems.forEach(it => { if (it.kind === 'new') URL.revokeObjectURL(it.src); });
    originalImages = (w.images || []).slice();
    galleryItems = originalImages.map(u => ({ kind: 'old', url: u }));
    qrCleared = false;
    renderGalleryPreviews();
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

  function tryCloseUpload() {
    if (!editId && uploadDirty()) {
      saveDraft();
      if (!confirm('内容还没提交，已自动存为草稿，下次打开「提交作品」会恢复（图片需重新选择）。确定关闭吗？')) return;
    }
    hideModal(uploadModal);
    resetUploadForm();
  }
  $('openUpload').onclick = () => {
    // 未登录也允许打开投稿表单（匿名需审核），登录后再提交换免审
    resetUploadForm();
    const restored = restoreDraft();
    showModal(uploadModal);
    if (restored) showToast('已恢复上次未提交的草稿（图片需重新选择）');
  };
  $('closeUpload').onclick = tryCloseUpload;
  uploadModal.onclick = e => { if (e.target === uploadModal) tryCloseUpload(); };

  $('categorySelect').addEventListener('change', e => {
    CUSTOM_MODE = e.target.value === '__new__';
    newCatInput.style.display = CUSTOM_MODE ? 'block' : 'none';
    if (CUSTOM_MODE) newCatInput.focus();
  });

  $('typePicker').addEventListener('change', e => {
    if (e.target.name !== 'types') return;
    if (!selectedTypes().length) { // 不允许一个都不选
      e.target.checked = true;
      showToast('至少选择一种作品形态');
    }
    applyTypeFields();
  });

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
      if (galleryItems.length >= MAX_GALLERY) { showToast(`宣传图最多 ${MAX_GALLERY} 张`); break; }
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

    // 基础必填（表单已加 novalidate，统一用中文提示，避免浏览器默认气泡）
    if (!form.title.value.trim()) {
      showToast('请填写作品标题');
      form.title.focus();
      return;
    }

    // 形态必填校验：只有网站需要链接，小程序需要二维码
    const curTypes = selectedTypes().length ? selectedTypes() : ['网站'];
    if (LINK_REQUIRED_TYPES.some(t => curTypes.indexOf(t) !== -1) && !form.link.value.trim()) {
      showToast('形态含「网站」，请填写网站地址');
      form.link.focus();
      return;
    }
    if (curTypes.indexOf('小程序') !== -1) {
      const hasQr = form.qrcode.files.length > 0 ||
        (!qrCleared && $('qrPreviewBox').style.display !== 'none');
      if (!hasQr) {
        showToast('形态含「小程序」，请上传小程序码 / 二维码');
        $('qrDrop').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }

    // 标注开源：源码仓库地址必填
    if (((form.querySelector('input[name="openSource"]:checked') || {}).value || '') === '1' &&
        !form.repo.value.trim()) {
      showToast('标注开源请填写源码仓库地址');
      form.repo.focus();
      $('repoField').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // 封面：新建时必须上传（编辑时保留原封面即可）
    if (!editId && !form.image.files.length) {
      showToast('请上传作品封面 / 截图');
      $('coverDrop').scrollIntoView({ block: 'center', behavior: 'smooth' });
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
      let category = form.category.value;
      if (CUSTOM_MODE) {
        const name = newCatInput.value.trim();
        if (!name) throw new Error('请输入新分类名称');
        const r = await fetch('/api/categories', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (err.error !== '分类已存在') throw new Error(err.error || '新增分类失败');
        }
        await loadCategories();
        category = name;
      }

      // 客户端压缩 + 生成缩略图，避免上传原图过大
      const fd = new FormData(form);
      fd.set('category', category);
      fd.delete('newCategory');
      fd.delete('images'); // 宣传图单独压缩后追加

      // 编辑模式：未选择新图片时不上传文件字段；二维码仅小程序形态支持
      const qrAllowed = ruleOfTypes(selectedTypes()).qr;
      const newFiles = galleryItems.filter(it => it.kind === 'new').map(it => it.file);
      const keptUrls = galleryItems.filter(it => it.kind === 'old').map(it => it.url);
      // 原有但已被删掉的宣传图
      const removedImages = originalImages.filter(u => !keptUrls.includes(u));
      if (editId) {
        if (!form.image.files.length) fd.delete('image');
        if (!qrAllowed || !form.qrcode.files.length) fd.delete('qrcode');
        // 编辑模式：保留已有宣传图，并告知服务器要删掉哪些
        fd.set('keepExisting', '1');
        if (removedImages.length) fd.set('removedImages', JSON.stringify(removedImages));
        // 二维码被手动删除（且没选新的）
        if (!form.qrcode.files.length && qrCleared) fd.set('removeQrcode', '1');
      } else if (!qrAllowed) {
        fd.delete('qrcode');
      }

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
      showToast(
        wasEdit ? '修改已保存 ✅'
        : data.anonymous ? '已提交，审核通过后上线（注册可免审直发）'
        : data.needReview ? '提交成功，等待审核通过后展示'
        : '提交成功 🎉');
      state.sort = 'latest';
      document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.sort === 'latest'));
      route();
    } catch (err) {
      showToast(err.message);
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
  detailModal.onclick = e => {
    if (e.target === detailModal) $('closeDetail').click();
  };
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
    if (!res.ok) { showToast(data.error || '操作失败'); return; }
    localStorage.setItem('liked:' + w.id, '1');
    $('detailLikes').textContent = data.likes;
    $('detailLike').classList.add('liked');
  };

  // 详情弹窗里的收藏按钮（需登录，与卡片 ★ 和顶部「收藏」列表同源）
  $('detailFav').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    const added = await toggleFav(w.id);
    if (added === null) return;
    renderDetailFav(w.id);
    paintFavButtons(w.id);
    showToast(added ? '已加入收藏 ⭐' : '已取消收藏');
  };

  $('detailAuthor').onclick = () => {
    const w = state.currentWork;
    if (!w) return;
    hideModal(detailModal);
    navigate('/u/' + encodeURIComponent(w.author));  };

  $('copyLinkBtn').onclick = async () => {
    const url = location.origin + '/w/' + state.currentWork.id;
    try {
      await navigator.clipboard.writeText(url);
      showToast('链接已复制，可以分享给朋友了');
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
  reportModal.onclick = e => { if (e.target === reportModal) hideModal(reportModal); };

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
  claimModal.onclick = e => { if (e.target === claimModal) hideModal(claimModal); };

  $('claimForm').addEventListener('submit', async e => {
    e.preventDefault();
    const w = state.currentWork;
    if (!w) return;
    const form = e.target;
    const evidence = form.evidence.value.trim();
    const btn = $('claimBtn');
    if (evidence.length < 10) { showToast('请提供更具体的创作证据（至少 10 个字）'); form.evidence.focus(); return; }
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const res = await fetch('/api/works/' + w.id + '/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidence, contact: form.contact.value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || '提交失败'); return; }
      state.myClaims.push({ workId: w.id, status: 'pending', createdAt: new Date().toISOString() });
      hideModal(claimModal);
      showToast('已提交，管理员审核通过后作品就归你了');
      openWork(w.id, false); // 刷新认领入口为「审核中」
    } catch { showToast('提交失败，请检查网络'); }
    finally { btn.disabled = false; btn.textContent = '提交认领申请'; }
  });

  // 屏蔽这个作品：加入本人的屏蔽列表，列表/榜单/精选里立刻消失
  $('blockWork').onclick = async () => {
    const w = state.currentWork;
    if (!w) return;
    if (!state.user) { openAuth('login'); return; }
    const res = await fetch(`/api/works/${w.id}/block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || '操作失败'); return; }
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
    showToast('已屏蔽，可在顶部「🚫」里恢复');
  };

  // 评论 / 提问切换
  document.querySelectorAll('#commentKind .ck-btn').forEach(btn => {
    btn.onclick = () => {
      if (state.replyTo) cancelReply();
      state.commentKind = btn.dataset.kind;
      syncCommentKindUI();
      $('commentInput').focus();
    };
  });
  $('commentReplyCancel').onclick = () => { cancelReply(); $('commentInput').focus(); };

  // 评论列表内的「回复 / 删除」（事件委托，列表重渲染也不用重新绑定）
  $('commentList').addEventListener('click', async e => {
    const del = e.target.closest('.comment-del');
    if (del) {
      const item = del.closest('[data-id]');
      if (!confirm('确定删除这条吗？它下面的回复会一起删除')) return;
      const res = await fetch('/api/comments/' + item.dataset.id, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || '删除失败'); return; }
      const w = state.currentWork;
      if (w) {
        const draft = $('commentInput').value;
        await loadComments(w.id);
        $('commentInput').value = draft;
        paintCommentCount(w.id, $('commentList').querySelectorAll('[data-id]').length);
      }
      showToast(data.removed > 1 ? `已删除，含 ${data.removed - 1} 条回复` : '已删除');
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
      showToast(payload.kind === 'question' ? '提问已发布，等作者来答' : '已发布');
    } catch (err) {
      showToast(err.message);
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
  $('delWork').onclick = async () => {
    const w = state.currentWork;
    if (!w || !confirm(`确定删除「${w.title}」吗？删除后不可恢复。`)) return;
    const res = await fetch('/api/works/' + w.id, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || '删除失败'); return; }
    hideModal(detailModal);
    showToast('作品已删除');
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
      showToast(data.message || '投诉已提交');
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false; btn.textContent = '提交投诉';
    }
  });
}

// ---------- 已屏蔽作品 ----------
// ---------- 作者数据看板 ----------
// 只看自己的作品（发布 + 认领后归属自己的）：累计数据 + 近 14 天浏览趋势
function statsSparkline(values, w = 88, h = 24) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) =>
    `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`).join(' ');
  return `<svg class="sw-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

async function openStats() {
  if (!state.user) { openAuth('login'); return; }
  const body = $('statsBody');
  body.innerHTML = '<div class="stats-loading">加载中…</div>';
  $('closeStats').onclick = () => hideModal(statsModal);
  statsModal.onclick = e => { if (e.target === statsModal) hideModal(statsModal); };
  showModal(statsModal);

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

  if (!works.length) {
    body.innerHTML = `
      <div class="stats-empty">
        <div class="stats-empty-icon">📊</div>
        <p>你还没有归属自己的作品。</p>
        <p class="stats-empty-sub">提交新作品，或对已收录的作品发起「认领」，通过后这里就会显示它的浏览、点赞与收藏数据。</p>
        <button class="btn-primary" id="statsGoSubmit">＋ 去提交作品</button>
      </div>`;
    $('statsGoSubmit').onclick = () => { hideModal(statsModal); $('openUpload').click(); };
    return;
  }

  const max = Math.max(...trend, 1);
  const bars = trend.map((v, i) => {
    const hPct = v ? Math.max(6, Math.round((v / max) * 100)) : 2;
    return `<div class="stats-bar-wrap" title="${days[i]}：${v} 次浏览">
      <div class="stats-bar ${v ? '' : 'empty'}" style="height:${hPct}%"></div>
      <span class="stats-bar-x">${i % 3 === 0 || i === trend.length - 1 ? days[i].slice(5).replace('-', '/') : ''}</span>
    </div>`;
  }).join('');

  const rows = works.map(w => `
    <div class="stats-work" data-id="${escapeHtml(w.id)}">
      <img src="${escapeHtml(w.thumb)}" alt="" loading="lazy" />
      <div class="sw-main">
        <div class="sw-title">${escapeHtml(w.title)}${w.online ? '' : '<span class="sw-badge">审核中</span>'}</div>
        <div class="sw-meta">浏览 ${w.views} · 访客 ${w.uv} · ♥ ${w.likes} · ★ ${w.favs} · 💬 ${w.comments}</div>
      </div>
      <div class="sw-right">
        ${statsSparkline(w.trend)}
        <span class="sw-7d">7 天 ${w.pv7}</span>
      </div>
    </div>`).join('');

  body.innerHTML = `
    <div class="stats-summary">
      <div class="stat-card"><b>${totals.works}</b><span>作品</span></div>
      <div class="stat-card"><b>${totals.views}</b><span>累计浏览</span></div>
      <div class="stat-card"><b>${totals.pv7}</b><span>近 7 天</span></div>
      <div class="stat-card"><b>${totals.likes}</b><span>点赞</span></div>
      <div class="stat-card"><b>${totals.favs}</b><span>收藏</span></div>
      <div class="stat-card"><b>${totals.comments}</b><span>评论</span></div>
    </div>
    <div class="stats-chart">
      <div class="stats-chart-head">近 14 天浏览趋势</div>
      <div class="stats-bars">${bars}</div>
    </div>
    <div class="stats-works-head">作品明细</div>
    <div class="stats-works">${rows}</div>
    <p class="stats-tip">数据统计包含弹窗与独立页面两种浏览方式；「访客」按登录账号 / IP 去重。</p>`;

  body.querySelectorAll('.stats-work').forEach(row => {
    row.onclick = () => {
      hideModal(statsModal);
      openWork(row.dataset.id);
    };
  });
}

async function openBlockedList() {
  if (!state.user) { openAuth('login'); return; }
  const box = $('blockedList');
  box.innerHTML = '<div class="blocked-empty">加载中…</div>';
  $('closeBlocked').onclick = () => hideModal(blockedModal);
  blockedModal.onclick = e => { if (e.target === blockedModal) hideModal(blockedModal); };
  showModal(blockedModal);
  try {
    const list = await (await fetch('/api/blocked')).json();
    if (!Array.isArray(list)) { box.innerHTML = '<div class="blocked-empty">加载失败，请稍后重试</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="blocked-empty">还没有屏蔽任何作品</div>'; return; }
    box.innerHTML = list.map(w => `
      <div class="blocked-item" data-id="${escapeHtml(w.id)}">
        <img src="${escapeHtml(w.thumb)}" alt="${escapeHtml(w.title)}" loading="lazy" />
        <div class="blocked-main">
          <div class="blocked-title">${escapeHtml(w.title)}</div>
          <div class="blocked-meta">${escapeHtml(typeText(w))} · @${escapeHtml(w.author)}</div>
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
    showToast('已恢复显示');
    if (!location.pathname.startsWith('/w/')) route();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '恢复显示';
    showToast(err.message);
  }
}

// ---------- 顶部交互 ----------
function setupHeader() {
  let timer;
  $('searchInput').addEventListener('input', e => {
    clearTimeout(timer);
    const val = e.target.value.trim();
    timer = setTimeout(() => {
      state.q = val;
      state.favoritesOnly = false;
      if (location.pathname !== '/') navigate('/'); else loadWorks();
    }, 320);
  });

  document.querySelectorAll('#sortToggle .st-btn').forEach(btn => {
    btn.onclick = () => {
      state.sort = btn.dataset.sort;
      state.favoritesOnly = false;
      document.querySelectorAll('#sortToggle .st-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      if (location.pathname !== '/') navigate('/'); else loadWorks();
    };
  });

  $('favBtn').onclick = () => {
    // 收藏跟着账号走，未登录先登录
    if (!state.favoritesOnly && !state.user) {
      openAuth('login');
      showToast('登录后可查看你的收藏');
      return;
    }
    state.favoritesOnly = !state.favoritesOnly;
    $('favBtn').classList.toggle('active', state.favoritesOnly);
    if (location.pathname !== '/') navigate('/'); else loadWorks();
  };

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

  $('loadMore').onclick = () => { state.page += 1; loadWorks(false); };

  $('rankTabs').addEventListener('click', e => {
    if (e.target.dataset.period) loadRank(e.target.dataset.period);
  });
  $('rankByTabs').addEventListener('click', e => {
    if (e.target.dataset.by) loadRank(null, e.target.dataset.by);
  });

  // SPA 链接拦截
  document.addEventListener('click', e => {
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

// ---------- 意见反馈 ----------
function setupFeedback() {
  const modal = $('feedbackModal');
  const form = $('feedbackForm');
  if (!modal || !form) return;

  function openFeedback() {
    $('feedbackHint').innerHTML = state.user
      ? `用着不顺手、想要什么功能、发现 bug，都可以说一句。当前身份：<b>@${escapeHtml(state.user.username)}</b>`
      : '用着不顺手、想要什么功能、发现 bug，都可以说一句。匿名也能提。';
    showModal(modal);
    setTimeout(() => form.content.focus(), 60);
  }
  function closeFeedback() { hideModal(modal); }

  $('feedbackBtn').onclick = openFeedback;
  $('closeFeedback').onclick = closeFeedback;
  modal.onclick = e => { if (e.target === modal) closeFeedback(); };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('feedbackSubmit');
    const content = form.content.value.trim();
    if (content.length < 5) { showToast('多写两句吧，至少 5 个字'); return; }
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
      closeFeedback();
      showToast(data.message || '收到啦，谢谢你的反馈！');
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  // 支持 /?feedback=1 直接打开（SEO 页底部入口用）
  if (new URLSearchParams(location.search).get('feedback') === '1') {
    setTimeout(openFeedback, 300);
  }
}

// ---------- 启动 ----------
async function init() {
  // 支持 /?q=关键词 直接进入搜索结果（与站点搜索结构化数据一致）
  const q = (new URLSearchParams(location.search).get('q') || '').trim();
  if (q) {
    state.q = q;
    $('searchInput').value = q;
  }
  await loadMe();
  await loadTypeMeta();
  await loadCategories();
  await loadTools();
  await loadAds();
  setupHeader();
  setupUploadForm();
  setupDetailActions();
  setupAuthForms();
  setupSubmitChoice();
  setupFeedback();
  // 精选轮播：滚动/窗口变化时同步箭头与进度条状态
  $('featuredRow').addEventListener('scroll', updateFeatNav, { passive: true });
  window.addEventListener('resize', updateFeatNav);
  route();
}

// ---------- PWA：注册 Service Worker ----------
// localhost 与 https 下才可用；admin 页面用的是独立 admin.html，不会执行到这里
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // 注册失败（如隐私模式、存储被禁）不影响正常浏览
    });
  });
}
registerServiceWorker();

init();
