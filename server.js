/**
 * 造梦橱窗 - 后端服务
 * 支持：作品（网站/小程序/App/智能体/其他）投稿、搜索、分页、精选、榜单、
 *       作者主页、点赞、投诉、审核、管理端、限流与敏感词风控、工具推荐位
 */
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const seo = require('./seo');
const { PLATFORMS, EXTRA } = require('./promo-guide');
const Icons = require('./frontend/icons'); // 站点 SVG 图标统一管理（SSR 直出时用 ICONS.xxx）
const md = require('./frontend/md');       // 作品简介的 Markdown 渲染（与前端共用同一份白名单实现）

const PORT = process.env.PORT || 3000;
const REVIEW_MODE = process.env.REVIEW_MODE === '1'; // 打开后新投稿需审核

// DATA_DIR / UPLOAD_DIR 允许用环境变量指到别处（跑自动化测试时用临时目录，别碰正式数据）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');

// 站点上线日（页脚「已运营 N 天」从这天起算，含当天）
const SITE_LAUNCH = '2026-10-31';

// 后台口令：优先读环境变量 ADMIN_KEY，其次读 data/admin-key.txt（该目录不入库）
const ADMIN_KEY = (() => {
  if (process.env.ADMIN_KEY) return String(process.env.ADMIN_KEY).trim();
  try { return fs.readFileSync(path.join(DATA_DIR, 'admin-key.txt'), 'utf-8').trim(); }
  catch { return ''; }
})();

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- 智谱 AI 初审 ----------
// 用免费的 glm-4-flash 给需要审核的投稿做 AI 初审：通过直接上线，不通过转人工。
// key 优先环境变量 ZHIPU_API_KEY，其次 data/zhipu-key.txt（不入库）；都没配时跳过 AI、全部转人工（流程不变）。
const ZHIPU_API_KEY = (() => {
  if (process.env.ZHIPU_API_KEY) return String(process.env.ZHIPU_API_KEY).trim();
  try { return fs.readFileSync(path.join(DATA_DIR, 'zhipu-key.txt'), 'utf-8').trim(); }
  catch { return ''; }
})();
const ZHIPU_MODEL = String(process.env.ZHIPU_MODEL || 'glm-4-flash').trim();

// ---------- GitHub OAuth 配置 ----------
// 优先环境变量，其次 data/oauth.json（该目录不入库，适合直接在服务器上放密钥）：
//   { "github": { "clientId": "xxx", "clientSecret": "yyy", "callbackUrl": "https://站点/api/auth/github/callback" } }
// 没配置时 GitHub 登录入口自动隐藏，账号密码登录照旧可用。
const GH_CONF = (() => {
  const fromFile = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'oauth.json'), 'utf-8')).github || {}; }
    catch { return {}; }
  })();
  return {
    clientId: String(process.env.GITHUB_CLIENT_ID || fromFile.clientId || '').trim(),
    clientSecret: String(process.env.GITHUB_CLIENT_SECRET || fromFile.clientSecret || '').trim(),
    callbackUrl: String(process.env.GITHUB_CALLBACK_URL || fromFile.callbackUrl || '').trim(),
    // 测试/私有部署时可以改指向，默认走官方地址
    oauthBase: String(process.env.GITHUB_OAUTH_BASE || 'https://github.com').replace(/\/+$/, ''),
    apiBase: String(process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '')
  };
})();
const GH_ENABLED = !!(GH_CONF.clientId && GH_CONF.clientSecret);
const GH_SCOPE = 'read:user';   // 只要公开资料，不碰仓库和邮箱，用户授权时心理负担小

// ---------- Google OAuth 配置 ----------
// 优先环境变量，其次 data/oauth.json 的 google 段（与 github 段同一个文件）：
//   { "google": { "clientId": "xxx", "clientSecret": "yyy", "callbackUrl": "https://站点/api/auth/google/callback" } }
// 没配置时 Google 登录入口自动隐藏，账号密码 / GitHub 登录照旧可用。
const GOOGLE_CONF = (() => {
  const fromFile = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'oauth.json'), 'utf-8')).google || {}; }
    catch { return {}; }
  })();
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || fromFile.clientId || '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || fromFile.clientSecret || '').trim(),
    callbackUrl: String(process.env.GOOGLE_CALLBACK_URL || fromFile.callbackUrl || '').trim(),
    // OpenID Connect 三件套：授权页 / 换 token / 拉用户信息，各自独立域名
    authBase: String(process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com').replace(/\/+$/, ''),
    tokenBase: String(process.env.GOOGLE_TOKEN_BASE || 'https://oauth2.googleapis.com').replace(/\/+$/, ''),
    userinfoBase: String(process.env.GOOGLE_USERINFO_BASE || 'https://openidconnect.googleapis.com').replace(/\/+$/, '')
  };
})();
const GOOGLE_ENABLED = !!(GOOGLE_CONF.clientId && GOOGLE_CONF.clientSecret);
const GOOGLE_SCOPE = 'openid email profile';   // 只要 id + 邮箱 + 昵称头像，标准 OIDC 权限

// ---------- 微信小程序登录配置 ----------
// 优先环境变量，其次 data/oauth.json 的 wechat 段（与 github/google 同一个文件）：
//   { "wechat": { "appId": "wx...", "appSecret": "..." } }
// WECHAT_MOCK=1 是本地测试开关：code 直接当 openid 用（不上微信服务器换），生产绝不设。
const WECHAT_CONF = (() => {
  const fromFile = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'oauth.json'), 'utf-8')).wechat || {}; }
    catch { return {}; }
  })();
  return {
    appId: String(process.env.WECHAT_APPID || fromFile.appId || '').trim(),
    appSecret: String(process.env.WECHAT_APP_SECRET || fromFile.appSecret || '').trim(),
    mock: process.env.WECHAT_MOCK === '1'
  };
})();
const WECHAT_ENABLED = !!((WECHAT_CONF.appId && WECHAT_CONF.appSecret) || WECHAT_CONF.mock);

// ---------- 存储层（JSON + 原子写入 + 内存缓存） ----------
function fileOf(name) { return path.join(DATA_DIR, name); }

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf-8')); }
  catch { return fallback; }
}

function writeJSON(name, data) {
  const target = fileOf(name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

let works = readJSON('works.json', []);
// 存量精选（featured:true 但无 featuredUntil）统一补 3 天到期，避免永久精选（按用户要求：从当前时间算 3 天后消失）
{
  let patched = 0;
  const THREE_DAYS = 3 * 86400000;
  works.forEach(w => {
    if (w && w.featured && !w.featuredUntil) { w.featuredUntil = new Date(Date.now() + THREE_DAYS).toISOString(); patched++; }
  });
  if (patched) saveWorks();
}
// 草稿箱：登录用户没填完的作品暂存在这里（每人最多 3 份）。
// 字段结构与 works 对齐（image / thumb / qrcode / images 同名），所以图片合并逻辑直接复用
// applyImageChanges，草稿转正时也不用转换结构——删草稿记录、图片留给作品用。
let drafts = readJSON('drafts.json', []);
if (!Array.isArray(drafts)) drafts = [];
function saveDrafts() { writeJSON('drafts.json', drafts); }
const DRAFT_MAX_PER_USER = 3;    // 每人最多 3 份草稿
const DRAFT_TTL_DAYS = 30;       // 30 天没动过的草稿连同图片一起清掉
let reports = readJSON('reports.json', []);
let tools = readJSON('tools.json', []);
let creators = readJSON('creators.json', []); // 认证创作者
let taglib = readJSON('taglib.json', null);   // 作者标签库：后台可新增 / 改名，贴给任意用户
if (!Array.isArray(taglib) || !taglib.length) taglib = ['优秀产品体验官'];
function saveTaglib() { writeJSON('taglib.json', taglib); }
let users = readJSON('users.json', []);        // 注册用户
// 造梦编年史：站点历史事件流水（公开页 /chronicle）。
// 只记「事件」不记数量——激励送了多少灯火对外保密，points 字段仅存在本地数据里，接口和页面都不输出。
// 结构：[{ id, at, userId, username, name, tag, points, note, kind }]  kind: 'tag' | 'points'
let chronicle = readJSON('chronicle.json', []);
if (!Array.isArray(chronicle)) chronicle = [];
function saveChronicle() { writeJSON('chronicle.json', chronicle); }
function addChronicleEvent(ev) {
  chronicle.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
    kind: ev.kind || 'points',
    userId: ev.userId || null,
    username: ev.username || '',
    name: ev.name || '',
    tag: ev.tag || '',
    reason: String(ev.reason || '').slice(0, 30),   // 标准化的送灯火原因（如「提供优质建议」），编年史只展示它不展示聊天原话
    points: Number(ev.points) || 0,   // 保密字段：仅存档，任何接口不吐
    note: String(ev.note || '').slice(0, 100)
  });
  if (chronicle.length > 500) chronicle = chronicle.slice(-500);
  saveChronicle();
}
let userIndex = null;                          // 账号 → 用户对象（懒建缓存，改动用户时置空）
let sessions = readJSON('sessions.json', {});  // sid -> { uid, exp }
let comments = readJSON('comments.json', []);  // 作品评论
// 站内消息：目前主要用来说明积分变动（管理员送分/扣分、扣费投放等），结构见 addNotice()
let notices = readJSON('notices.json', []);
if (!Array.isArray(notices)) notices = [];
let feedback = readJSON('feedback.json', []);  // 意见反馈
let claims = readJSON('claims.json', []);      // 作品认领申请（提交证据 → 管理员审核）
let ads = readJSON('ads.json', []);            // 广告（固定几个广告位，后台往里挂）
// 广告曝光明细：{ 'YYYY-MM-DD': { <adId>: { pv: 3, uv: { 'ip:1.2.3.4': 1, 'u:xxx': 1 } } } }
// PV = 展示次数；UV = 去重访客（登录按账号、未登录按 IP，与站点 UV 口径一致）
let adStats = readJSON('ad-stats.json', {});
if (!adStats || typeof adStats !== 'object' || Array.isArray(adStats)) adStats = {};
// 积分兑换广告位的订单：{ id, userId, workId, slot, adId, views, price, used, status, createdAt, endsAt }
let redemptions = readJSON('ad-redemptions.json', []);
if (!Array.isArray(redemptions)) redemptions = [];
const saveRedemptions = () => writeJSON('ad-redemptions.json', redemptions);
// 打赏记录（零和转移账本）：{ id, workId, fromUserId, fromDisplay, toUserId, amount, ipk, createdAt }
// 打赏不产生新灯火：打赏者扣多少、作者得多少，平台总盘不变。记录保留全量（对账 + 防刷审计）。
let tips = readJSON('tips.json', []);
if (!Array.isArray(tips)) tips = [];
const saveTips = () => writeJSON('tips.json', tips);
const DEFAULT_CATEGORIES = ['效率工具', '生活助手', '内容创作', '学习教育', '娱乐游戏', '开发工具', '个人站'];
let categories = readJSON('categories.json', DEFAULT_CATEGORIES);
if (!Array.isArray(categories) || !categories.length) categories = DEFAULT_CATEGORIES.slice();

// 作品形态：可在后台增删 / 调序 / 换图标（[{ name, icon, svg }]）
// icon = 旧版 emoji（纯文本场景仍在用，如 typeText 拼进 escapeHtml）；svg = 图标库 key（UI 上的单色图标）
const DEFAULT_TYPES = [
  { name: 'Web', icon: '🌐', svg: 'web' },
  { name: 'iOS', icon: '🍎', svg: 'ios' },
  { name: 'Android', icon: '🤖', svg: 'android' },
  { name: 'macOS', icon: '💻', svg: 'mac' },
  { name: 'Windows', icon: '🪟', svg: 'win' },
  { name: 'Linux', icon: '🐧', svg: 'linux' },
  { name: '小程序', icon: '📱', svg: 'mini' },
  { name: '浏览器插件', icon: '🧩', svg: 'ext' },
  { name: '机器人', icon: '🦾', svg: 'robot' },
  { name: 'API', icon: '🔌', svg: 'api' }
];
// 后台新增形态时可选的图标库（与 frontend/icons.js 的 ICONS key 对应）
const TYPE_ICON_LIB = [
  { key: 'web', label: '浏览器' }, { key: 'ios', label: 'iOS' }, { key: 'android', label: 'Android' },
  { key: 'mac', label: 'macOS' }, { key: 'win', label: 'Windows' }, { key: 'linux', label: 'Linux' },
  { key: 'mini', label: '小程序' }, { key: 'ext', label: '插件' }, { key: 'robot', label: '机器人' },
  { key: 'api', label: 'API' }, { key: 'other', label: '三点' },
  { key: 'globe', label: '地球' }, { key: 'shapes', label: '图形' }, { key: 'bolt', label: '闪电' },
  { key: 'chat', label: '对话' }, { key: 'link', label: '链接' }, { key: 'star', label: '星标' }
];
const TYPE_ICON_KEYS = TYPE_ICON_LIB.map(i => i.key);
let workTypes = readJSON('types.json', DEFAULT_TYPES.map(t => ({ ...t })));
(function normalizeWorkTypes() {
  if (!Array.isArray(workTypes)) workTypes = [];
  workTypes = workTypes
    .map(t => (typeof t === 'string' ? { name: t, icon: '', svg: '' } : { name: String((t && t.name) || ''), icon: String((t && t.icon) || ''), svg: String((t && t.svg) || '') }))
    .filter(t => t.name);
  if (!workTypes.some(t => t.name === 'Web')) workTypes.unshift({ name: 'Web', icon: '🌐', svg: 'web' });
  workTypes.forEach(t => {
    if (!t.icon) t.icon = '✨';
    // 老数据没有 svg 字段：按同名默认形态补齐，升级后图标不会突然从 SVG 掉回 emoji
    if (!t.svg) {
      const d = DEFAULT_TYPES.find(x => x.name === t.name);
      if (d) t.svg = d.svg;
    }
    if (t.svg && !TYPE_ICON_KEYS.includes(t.svg)) t.svg = '';
  });
})();

function saveWorks() { writeJSON('works.json', works); }
function saveReports() { writeJSON('reports.json', reports); }
function saveTools() { writeJSON('tools.json', tools); }
function saveCategories() { writeJSON('categories.json', categories); }

// ---------- 一次性迁移（每个 key 只跑一次，避免后台删掉的默认项被反复加回来） ----------
// 线上 data/ 不进部署包，所以「新增默认分类/形态」这类改动不会自动生效，
// 用迁移在发版后第一次启动时补进去，且把已执行的 key 记在 data/migrations.json。
const migrations = (() => {
  const raw = readJSON('migrations.json', {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
})();
function runMigration(key, fn) {
  if (migrations[key]) return;
  try {
    fn();
    migrations[key] = new Date().toISOString().slice(0, 10);
    writeJSON('migrations.json', migrations);
  } catch (e) {
    console.error('[migration]', key, e.message);
  }
}

// v46：线上 categories.json 是早期版本建的，缺「个人站」→ 补齐缺失的默认分类（保留原有顺序与自定义项）
runMigration('categories-merge-2026-11', () => {
  const missing = DEFAULT_CATEGORIES.filter(c => !categories.includes(c));
  if (!missing.length) return;
  // 「其他」保持收尾：它是最后一项时，缺的默认分类插到它前面，否则直接追加
  const last = categories[categories.length - 1];
  categories = last === '其他'
    ? categories.slice(0, -1).concat(missing, ['其他'])
    : categories.concat(missing);
  saveCategories();
  console.log('[migration] categories 补齐：', missing.join('、'));
});

// 「其他」兜底项下线：分类/形态都不再保留「其他」，由投稿时的「＋ 新分类 / ＋ 新形态」按需创建具体项
runMigration('remove-other-2026-11', () => {
  const CAT_FALLBACK = DEFAULT_CATEGORIES[0];   // 挂「其他」分类的作品改挂第一个默认分类
  let worksTouched = false;
  if (categories.includes('其他')) { categories = categories.filter(c => c !== '其他'); saveCategories(); }
  if (workTypes.some(t => t.name === '其他')) { workTypes = workTypes.filter(t => t.name !== '其他'); saveTypes(); }
  works.forEach(w => {
    if (Array.isArray(w.categories) && w.categories.includes('其他')) {
      w.categories = Array.from(new Set(w.categories.map(c => (c === '其他' ? CAT_FALLBACK : c))));
      w.category = w.categories[0];
      worksTouched = true;
    }
    if (w.category === '其他') { w.category = CAT_FALLBACK; worksTouched = true; }
    if (Array.isArray(w.types) && w.types.includes('其他')) {
      w.types = Array.from(new Set(w.types.map(t => (t === '其他' ? 'Web' : t))));
      w.type = w.types[0];
      worksTouched = true;
    }
    if (w.type === '其他') { w.type = 'Web'; worksTouched = true; }
  });
  if (worksTouched) {
    saveWorks();
    console.log('[migration] 「其他」下线：相关作品已改挂具体分类/形态');
  }
});

// 友情链接：站长安插的外站入口，展示在页脚（[{ name, url }]，数组顺序即展示顺序）
let friends = readJSON('friends.json', []);
if (!Array.isArray(friends)) friends = [];
friends = friends
  .map(f => ({ name: String((f && f.name) || '').slice(0, 20), url: String((f && f.url) || '').slice(0, 500) }))
  .filter(f => f.name && /^https?:\/\/.+/i.test(f.url));
const saveFriends = () => writeJSON('friends.json', friends);

// 作品的分类列表：新数据用 categories 数组（1-3 个），老数据只有 category 单值
function catsOf(w) {
  if (Array.isArray(w.categories) && w.categories.length) return w.categories.filter(c => categories.includes(c));
  return w.category && categories.includes(w.category) ? [w.category] : [];
}
// 解析请求里的分类（JSON 字符串 / 数组 / 逗号分隔），只保留已知分类，去重后最多 3 个
function parseCats(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else { try { arr = JSON.parse(String(raw || '[]')); } catch { arr = String(raw || '').split(','); } }
  if (!Array.isArray(arr)) arr = [];
  const seen = [];
  arr.map(c => String(c || '').trim()).forEach(c => {
    if (c && categories.includes(c) && !seen.includes(c)) seen.push(c);
  });
  return seen.slice(0, 3);
}
function saveTypes() { writeJSON('types.json', workTypes); }
function typeIconMap() {
  const map = {};
  workTypes.forEach(t => { map[t.name] = t.icon || '✨'; });
  return map;
}
function saveUsers() { userIndex = null; writeJSON('users.json', users); }
function saveSessions() { writeJSON('sessions.json', sessions); }
function saveComments() { writeJSON('comments.json', comments); }
function saveFeedback() { writeJSON('feedback.json', feedback); }
function saveClaims() { writeJSON('claims.json', claims); }
function saveAds() { writeJSON('ads.json', ads); }
function saveNotices() { writeJSON('notices.json', notices); }

// ---------- 屏蔽统计：首页「最新」降权的唯一依据 ----------
// 屏蔽的真相在 user.blocked 里（谁屏蔽了什么），但排序要的是反过来的索引——
// 「这件作品被几个人屏蔽」。每次请求扫全体用户太贵，这里增量维护一份反查表：
//   { [workId]: { by: { [userId]: 屏蔽时间戳 }, resetAt? } }
// 计票规则（与站长约定）：
//   站长 3 分 / 登录用户 1 分 / 匿名不计。未登录点「不再看」会引导登录——匿名屏蔽只能靠 IP +
//   本地存储去重，清一次缓存就是一张新票，给它算票等于开放刷榜入口。
// 生效范围：只有「首页无筛选的最新列表」。≥2 分才降权，位移 = min(floor(分), 8) 位，
// 只统计最近 30 天（含后台重置时间）——否则几个早期访客就能把一件作品永久埋在列表中部。
const BLOCK_RULE = { threshold: 2, cap: 8, windowDays: 30, ownerWeight: 3, userWeight: 1 };
let blockStats = readJSON('block-stats.json', {});
if (!blockStats || typeof blockStats !== 'object' || Array.isArray(blockStats)) blockStats = {};
let blockStatsTimer = null;
function saveBlockStatsSoon() {
  if (blockStatsTimer) return;
  blockStatsTimer = setTimeout(() => { blockStatsTimer = null; writeJSON('block-stats.json', blockStats); }, 800);
}
function saveBlockStats() { writeJSON('block-stats.json', blockStats); }

// 站长账号：后台「用户管理」点「设为站长」，或用 SITE_OWNERS 环境变量（逗号分隔）预置，
// 两处取并集。站长权重 3 分，一个人就能触发降权，所以后台会给他的屏蔽单独打标。
let siteOwners = readJSON('site-owners.json', []);
if (!Array.isArray(siteOwners)) siteOwners = [];
String(process.env.SITE_OWNERS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(n => {
  if (siteOwners.indexOf(n) === -1) siteOwners.push(n);
});
function saveSiteOwners() { writeJSON('site-owners.json', siteOwners); }
const isSiteOwner = u => !!u && siteOwners.indexOf(u.username) !== -1;

function recordBlockStat(user, workId, on) {
  if (!user || !workId) return;
  const rec = blockStats[workId] || (blockStats[workId] = { by: {} });
  if (!rec.by || typeof rec.by !== 'object') rec.by = {};
  if (on) rec.by[user.id] = Date.now();
  else delete rec.by[user.id];
  if (!Object.keys(rec.by).length && !rec.resetAt) delete blockStats[workId];
  saveBlockStatsSoon();
}
// 账号注销：把他的票一并撤掉，否则这个 id 会永远留在统计里（排序算不到人，但计数会虚高）
function forgetUserBlocks(userId) {
  let dirty = false;
  Object.keys(blockStats).forEach(id => {
    const rec = blockStats[id];
    if (!rec || !rec.by || !rec.by[userId]) return;
    delete rec.by[userId];
    dirty = true;
    if (!Object.keys(rec.by).length && !rec.resetAt) delete blockStats[id];
  });
  if (dirty) saveBlockStats();
}
// 一次算完整页的降权位数：内部只建一次 userId → user 的索引，别在循环里 users.find
function blockShiftMap(ids) {
  const out = new Map();
  const uById = new Map(users.map(u => [u.id, u]));
  const since = Date.now() - BLOCK_RULE.windowDays * 86400000;
  ids.forEach(id => {
    const rec = blockStats[id];
    if (!rec || !rec.by) return;
    const from = Math.max(since, Number(rec.resetAt) || 0);
    let score = 0;
    Object.keys(rec.by).forEach(uid => {
      if ((Number(rec.by[uid]) || 0) <= from) return;
      score += isSiteOwner(uById.get(uid)) ? BLOCK_RULE.ownerWeight : BLOCK_RULE.userWeight;
    });
    if (score >= BLOCK_RULE.threshold) out.set(id, Math.min(Math.floor(score), BLOCK_RULE.cap));
  });
  return out;
}
function blockShiftOf(workId) { return blockShiftMap([workId]).get(workId) || 0; }
// 位移：按「取出 → 往后插 N 位」实现，语义就是字面上的「退 N 位」。
// 不用「给每件算目标下标再重排」——那样被降权作品腾出的空位会被后面一件立刻填上，
// 实际只退了 N-1 位，站长在后台看到的数字和自己数的位置会对不上。
// 置顶作品不参与位移（置顶是站方意志，不该被屏蔽票推翻）。
function applyBlockShift(list, shifts) {
  if (!shifts || !shifts.size) return list;
  const pinned = [], normal = [];
  list.forEach(w => (w.pinned ? pinned : normal).push(w));
  if (!normal.length) return list;
  const out = normal.slice();
  normal.forEach(w => {
    const s = shifts.get(w.id) || 0;
    if (!s) return;
    const cur = out.indexOf(w);
    const to = Math.min(cur + s, out.length - 1);
    if (to <= cur) return;
    out.splice(cur, 1);
    out.splice(to, 0, w);
  });
  return pinned.concat(out);
}

// ---------- 站内消息 ----------
// 每个账号最多留 50 条，多了从最旧的丢；积分类消息带「变动后余额」，前端直接展示
//
// kind 分工：
//   points / system / idea / featured / reply / work-reply —— 与本人账号、作品、灯火相关，必达
//   announce —— 站方公告（群发、编年史这类运营推送），用户可在「账号设置」里屏蔽提示：
//               公告照常进铃铛列表（未读照算），只是不再弹提示，落库时标记 muted:true。
const NOTICE_KEEP_PER_USER = 50;
// 站内跳转目标只接受站内相对路径（和 safeNextPath 同口径），避免消息里塞外链钓鱼
function noticeLinkOf(v) {
  const s = String(v || '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return '';
  return s.slice(0, 300);
}
// 用户是否屏蔽了公告提示（默认不屏蔽）
function announceMuted(user) {
  return !!(user && user.noticePrefs && user.noticePrefs.announce === false);
}
// 造一条（不落盘）：key 用于去重，同一个人同一个 key 只发一次
function buildNotice(userId, data) {
  const uid = String(userId);
  const key = String((data && data.key) || '');
  if (key && notices.some(n => n.userId === uid && n.key === key)) return null;
  const kind = (data && data.kind) || 'system';
  const n = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: uid,
    key,
    kind,
    title: String((data && data.title) || '').slice(0, 60),
    text: String((data && data.text) || '').slice(0, 300),
    link: noticeLinkOf(data && data.link),        // 可选：站内页面（如 /chronicle），点了直接跳
    points: Number((data && data.points) || 0),   // 0 表示这条与积分无关
    delta: Number((data && data.delta) || 0),
    workId: (data && data.workId) || null,        // 可选：点了直接跳到对应作品详情
    commentId: (data && data.commentId) || null,  // 可选：来源评论
    thread: Array.isArray(data && data.thread) ? data.thread : [], // 双向会话：作者与管理员的往来消息
    threadId: (data && data.threadId) || null,    // 指向会话容器通知；容器自身 threadId 等于自己 id
    feedbackId: (data && data.feedbackId) || null, // 意见反馈会话：thread 实时取自 feedback.thread
    muted: kind === 'announce' && announceMuted(users.find(u => u.id === uid)),
    read: false,
    createdAt: new Date().toISOString()
  };
  if (!n.threadId) n.threadId = n.id; // 容器通知：threadId 指向自己
  notices.unshift(n);
  return n;
}
function trimNotices(uid) {
  const mine = notices.filter(x => x.userId === uid);
  if (mine.length <= NOTICE_KEEP_PER_USER) return;
  const drop = new Set(mine.slice(NOTICE_KEEP_PER_USER).map(x => x.id));
  notices = notices.filter(x => !drop.has(x.id));
}
function addNotice(userId, data) {
  if (!userId) return null;
  const n = buildNotice(userId, data);
  if (!n) return null;
  trimNotices(n.userId);
  saveNotices();
  return n;
}
// 批量发（一次性广播用）：全部造完再落盘一次，免得 N 个用户写 N 次文件
function addNoticeBatch(pairs) {
  let sent = 0;
  pairs.forEach(([uid, data]) => { if (buildNotice(uid, data)) sent++; });
  if (sent) {
    const uids = new Set(pairs.map(p => String(p[0])));
    uids.forEach(trimNotices);
    saveNotices();
  }
  return sent;
}

// ---------- 造梦编年史公告（系统消息） ----------
// 两路投递：
//   ① 新用户：注册成功即推一条欢迎语（告诉他有这条时间线，从今天起他也在写）
//   ② 老用户：服务启动时一次性广播，key 去重 —— 重启 / 反复发版只发第一次
// 都属于 announce（站方公告），用户屏蔽提示后照常收到、不弹窗。
const CHRON_URL = '/chronicle';
function pushChronicleWelcome(user) {
  if (!user || !user.id) return null;
  return addNotice(user.id, {
    kind: 'announce',
    key: 'chronicle-announce-1',   // 与老用户广播同 key：一个人这辈子只收一条编年史公告
    link: CHRON_URL,
    title: '「造梦编年史」上线了',
    text: '站里从第一位造梦者到今天的每一件作品、每一条被采纳的建议，都记在这条时间线上了。从今天起，你也在写它 —— 点开看看。'
  });
}
function broadcastChronicleOnce() {
  const notice = {
    kind: 'announce',
    key: 'chronicle-announce-1',
    link: CHRON_URL,
    title: '「造梦编年史」上线了',
    text: '从第一位造梦者到今天，站里发生的事都记在这条时间线上了：第一批作品、第一批被采纳的建议、第一批被点亮的人。点开看看，你出现在哪一天。'
  };
  const sent = addNoticeBatch(users.filter(u => u && u.id).map(u => [u.id, notice]));
  if (sent) console.log(`[notices] 造梦编年史公告已推送给 ${sent} 位老用户`);
  return sent;
}

// ---------- 2026-11-06 上线通告：小程序上架 + 桌面 PWA 上线 ----------
// 站长流程：文案先在会话里审，确认后把 CHRON_LAUNCH_ANNOUNCE_ENABLED 改为 true 再发版。
// key 独立于编年史公告（chronicle-announce-1），每人只收一次，重启不重发。
const CHRON_LAUNCH_ANNOUNCE_ENABLED = true;   // 2026-11-06 13:01 站长确认文案后开启（发一次，key 去重）
const LAUNCH_ANNOUNCE = {
  key: 'chronicle-launch-2',
  link: '/install',
  title: '小程序上架了，扫一下就走进你的小程序',
  text: '「造梦橱窗」小程序正式上架——整站装进了微信，扫码即达；随小程序一起上线 3 个站内小程序推荐位，作品推荐从此能投给更精准的用户：他们可以在小程序里一键复制 App Store / 安卓下载链接，也可以直接扫码走进你的小程序——利好小程序、App 开发者'
};
function broadcastLaunchAnnounceOnce() {
  if (!CHRON_LAUNCH_ANNOUNCE_ENABLED) return 0;
  const notice = { kind: 'announce', ...LAUNCH_ANNOUNCE };
  const sent = addNoticeBatch(users.filter(u => u && u.id).map(u => [u.id, notice]));
  if (sent) console.log(`[notices] 上线通告已推送给 ${sent} 位用户`);
  return sent;
}
function seedLaunchGuestOnce() {
  if (!CHRON_LAUNCH_ANNOUNCE_ENABLED) return;
  if (guestNotices.some(n => n && n.key === LAUNCH_ANNOUNCE.key)) return;
  guestNotices.unshift({
    id: 'chronicle-launch-guest-2',
    ...LAUNCH_ANNOUNCE,
    active: true,
    createdAt: new Date().toISOString()
  });
  saveGuestNotices();
  console.log('[notices] 上线通告已补发到游客公告条');
}

// ---------- 游客公告条（未登录可见的全站公告） ----------
// 站内消息挂在账号上，未登录的访客没有铃铛收不到；这里另开一条公开通道：
// 页面顶部的公告条，游客也能看到。前端用 localStorage 记住已关闭的（按 key），
// 新增 / 下架由后台「群发通知」页管理。同 key 只保留一条（再发 = 更新文案重新置顶）。
let guestNotices = readJSON('guest-notices.json', []);
function saveGuestNotices() { writeJSON('guest-notices.json', guestNotices); }
function upsertGuestNotice({ key, title, text, link }) {
  const k = String(key || '').trim() || 'gn-' + Date.now().toString(36);
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    key: k,
    title: String(title || '').slice(0, 60),
    text: String(text || '').slice(0, 300),
    link: noticeLinkOf(link),
    active: true,
    createdAt: new Date().toISOString()
  };
  const i = guestNotices.findIndex(n => n && n.key === k);
  if (i >= 0) { item.createdAt = guestNotices[i].createdAt; guestNotices[i] = item; }
  else guestNotices.unshift(item);
  saveGuestNotices();
  return item;
}
// 编年史公告补发到游客通道：key 去重，重启不重复
function seedChronicleGuestOnce() {
  if (guestNotices.some(n => n && n.key === 'chronicle-announce-1')) return;
  guestNotices.unshift({
    id: 'chronicle-guest-1',
    key: 'chronicle-announce-1',
    title: '「造梦编年史」上线了',
    text: '从第一位造梦者到今天，站里发生的事都记在这条时间线上了：第一批作品、第一批被采纳的建议、第一批被点亮的人。点开看看，你出现在哪一天。',
    link: CHRON_URL,
    active: true,
    createdAt: new Date().toISOString()
  });
  saveGuestNotices();
  console.log('[notices] 编年史公告已补发到游客公告条');
}

// ---------- 广告位定义 ----------
// 广告位（位置）是写死在前端页面里的固定空位，后台只能选择「把这支广告挂到哪个位置」，
// 这样版式可控，不会因为运营乱挂把页面撑坏。key 必须和 index.html 里的 data-ad-slot 一致。
// platform 字段只是给后台展示用的标记（web = 网页端，mini = 小程序端），后端逻辑不区分。
const AD_SLOTS = [
  { key: 'home-top', name: '首页顶部横幅', where: '首页 Hero 下方、本周精选上方', size: '建议 1400 × 280' },
  { key: 'list-first', name: '首页第一格', where: '首页作品列表第一张卡（置顶作品之后）', size: '卡位 · 用作品封面' },
  { key: 'home-bottom', name: '首页列表底部', where: '作品列表末尾、加载更多上方', size: '建议 1400 × 240' },
  { key: 'detail', name: '作品详情页', where: '详情弹窗内、评论区上方', size: '建议 1200 × 240' },
  { key: 'rank', name: '榜单页顶部', where: '榜单标题下方', size: '建议 1400 × 240' },
  { key: 'footer', name: '全站页脚上方', where: '所有页面底部通栏', size: '建议 1400 × 200' },
  // 小程序端：位置渲染在 zaomeng-mini 的 components/ad-card，与网页端互不干扰
  { key: 'mini-home-top', name: '小程序·首页顶部横幅', where: '小程序首页筛选栏下方、作品流上方', size: '建议 1080 × 360', platform: 'mini' },
  { key: 'mini-rank', name: '小程序·榜单页顶部', where: '小程序星梦榜分段栏下方一行（手机屏幕小，渲染成一行文字）', size: '文字行 · 一行标题', platform: 'mini' },
  { key: 'mini-detail', name: '小程序·作品详情页', where: '小程序详情页、评论区上方一行（手机屏幕小，渲染成一行文字）', size: '文字行 · 一行标题', platform: 'mini' },
  // 小程序端「推荐」的三个兑换位：首页第一格是原生作品卡（独占），
  // 榜单 / 发现是小程序里最省地方的一行文字——手机屏幕小，横幅会把内容挤下去。
  { key: 'mini-home-first', name: '小程序·首页第一格', where: '小程序首页作品流第一张卡（独占）', size: '卡位 · 用作品封面', platform: 'mini' },
  { key: 'mini-rank-line', name: '小程序·榜单页一行文字', where: '小程序星梦榜分段栏下方一行', size: '文字行 · 一行标题', platform: 'mini' },
  { key: 'mini-feat-line', name: '小程序·发现页一行文字', where: '小程序发现页顶部一行', size: '文字行 · 一行标题', platform: 'mini' }
];
const AD_SLOT_KEYS = AD_SLOTS.map(s => s.key);
if (!Array.isArray(ads)) ads = [];
// 广告形式：image = 图文（图片铺底），text = 纯文字卡片。老数据没有 kind 的按有没有图推断
ads.forEach(a => { if (a && a.kind !== 'image' && a.kind !== 'text') a.kind = a.image ? 'image' : 'text'; });

// ---------- 积分兑换广告位（展示 + 点击双计费） ----------
// 计费：按位置的单价预扣（展示包 + 点击包各自定价），投放时按次扣额度。
// 卡片内容（标题/简介/封面）只能取自自己名下、已过审的站内作品，不用人工审稿；
// 点击去向二选一：默认开作品详情页；也可以填一个自己的链接（落地页/下载页/上架页），
// 卡上会明示「打开链接 ↗」、新标签打开并带 nofollow sponsored，只认 http/https。
//
// 【外链定价：外链点击单价 = 站内点击单价 × 2】
//   站内点击只是把人带进本站的作品详情页；外链点击是把访客直接带离本站、送到你指定的页面，
//   对投放者的价值明显更高，翻倍定价既拉开差距、又不至于贵到没人愿意试。曝光单价不变
//   （卡片长得一样，曝光价值相同）。外链订单的 clickPoints 在下单时锁的是外链价，退款同口径。
//
// 【外链只能买点击包，不能拿曝光包搭外链】
//   曝光包按「被看到」计费，点击只计数、不扣额度（没有 clickLeft 就没有点击计价），
//   所以「曝光包 + 外链去向」等于让外链跳转免费——买曝光包的人白拿了本该 6 盏/次买的外链流量，
//   和上面的翻倍定价直接打架，平台还白白把人送出站。所以：外链去向必须买点击包，这里硬性拒单。
//   （站内详情页去向不受影响：点击只把人留在站里看作品，不额外收费无所谓。）
//
// 几个位置的性质不一样，配置也分开：
//   detail     —— 详情页横幅：同一个位置可以同时挂多条（前端每次随机挑一条），不独占
//   rank       —— 榜单页顶部横幅：同上，多条随机挑一条。放在榜单列表之外、带「推荐」角标，
//                 不占名次编号——榜单是按数据排的客观名次，付费推广不能混进排名里
//   list-first —— 首页第一格：一张卡，库存只有 1，必须「独占 + 排队」，否则两条宣传卡会一起糊在信息流顶部
// 非独占位的 maxActive 是「同一用户全局在投上限」，不是单个位置的库存，几个位置保持一致。
// 2 → 3 的目的：让一个作者能同时推 3 件作品（手里灯火有去处，也愿意多攒），
// 位置上不设容量上限，谁来都能投，不会因为别人占了就排队。
//
// 【定价口径：单价必须是整数盏/次，showViews 恒为 1】
//   按次扣额度、撤下退剩余次数 × 单价，单价整数 → 退款天然是整数盏，不会出现 12.5 这种数。
//   一盏 = 一次曝光 = 一次有效分享来访（SHARE_VISIT_POINTS=1），作者挣来的曝光和买来的曝光同价，
//   好讲、好算、不会因为零头出现「多退半盏 / 少退半盏」的争议。
//   首页第一格卖 5 倍价：每个进首页的人都会看到它，曝光质量远高于详情页里的一条横幅。
//   榜单页顶部收 2 倍价：PC 宽屏并排 2-4 条同屏同时可见（详情位一次只出一条），又是页面最顶上，
//   同样一次页面浏览它能实打实吃满曝光（同屏 4 条 = 一次浏览给 4 家各记一次），比详情位值钱；
//   但仍低于首页第一格——那里是全站流量入口。
//
// 「首页第一格」的刚发布提醒：首页默认排序是「最新发布」，刚上传的作品本来就排在置顶作品之后第一张，
// 正好是 list-first 这个位置要占的地方——这时买第一格，多出来的主要是一张「推荐」角标，不是位置。
// 所以刚发布的作品买这两位时先劝一句（不硬拦，灯火是作者自己的），前端弹一次确认，
// 用户点「仍然要投」再带 ackFresh 下单。新鲜期口径放这里，前后端不各写一份。
const PROMO_FRESH_HOURS = 12;              // 作品发布后多少小时内买「首页第一格」会先提醒
const REDEEM_SLOTS = [
  {
    key: 'detail', name: '作品详情页', where: '详情弹窗内、评论区上方',
    showViews: 1, showPoints: 1, clickPoints: 3, extClickPoints: 6,
    showPacks: [50, 100, 200], clickPacks: [5, 10, 20],
    exclusive: false, maxActive: 3, maxQueued: 0,
    note: '多条同时投放，每次随机展示一条，各家机会均等 · 兑换后你本机可立即看到自己那条（自己看不扣灯火）'
  },
  {
    key: 'rank', name: '榜单页顶部', where: '榜单标题下方、榜单列表上方',
    showViews: 1, showPoints: 2, clickPoints: 4, extClickPoints: 8,
    showPacks: [50, 100, 200], clickPacks: [5, 10, 20],
    exclusive: false, maxActive: 3, maxQueued: 0,
    note: '多条同时投放，PC 一次并排 2-4 条同屏曝光（手机一条），各家机会均等 · 不占榜单名次 · 兑换后你本机可立即看到自己那条（自己看不扣灯火）'
  },
  {
    key: 'list-first', name: '首页第一格', where: '首页作品列表第一张卡（置顶作品之后）',
    showViews: 1, showPoints: 5, clickPoints: 8, extClickPoints: 16,
    showPacks: [50, 100, 200], clickPacks: [5, 10, 20],
    exclusive: true, maxActive: 1, maxQueued: 1,
    freshHours: PROMO_FRESH_HOURS,   // 刚发布的作品本来就顶在这儿，买之前先劝一句
    note: '库存 1，买到即独占；有人在投时排队等'
  },
  // ---- 小程序端（手机）四个兑换位 ----
  // 手机端是真机访问、打开即目标用户，曝光含金量比网页高，单价整体高一档（首页 8 / 榜单 4 / 详情 3 / 发现 3）。
  // 但小程序上线初期日活只有网页零头，所以套餐档位压小（20/50/100 次）：首页 20 次 = 160 盏，
  // 签到 + 分享几天就能试一次，不至于「单价看着不贵、一买就是四五百盏」把人吓走。
  // 小程序里点开外链只能复制到剪贴板，体验差且容易被判导流，所以这四个位只做「跳站内作品详情页」
  // （internalOnly），extClickPoints 与 clickPoints 同价占位，下单接口对外链直接拒单。
  // 2026-11-06 13:01 随小程序上架一起放开购买（onSale 撤掉，internalOnly 保留）。
  // 要临时收回：给这个位置加回 onSale:false + pendingNote，前端会自动显示「内测中」。
  {
    key: 'mini-home-first', name: '小程序·首页第一格', where: '小程序首页作品流第一张卡（独占）',
    showViews: 1, showPoints: 8, clickPoints: 24, extClickPoints: 24,
    showPacks: [20, 50, 100], clickPacks: [5, 10, 20],
    exclusive: true, maxActive: 1, maxQueued: 1,
    internalOnly: true,
    freshHours: PROMO_FRESH_HOURS,   // 同上：小程序首页作品流也是新的在最前
    note: '手机端独占位，买到即占首格'
  },
  // 详情页那一行：页面上最"深"的位置（点进作品的人才看得到），曝光少但都是真在挑作品的人，
  // 所以和发现页同价（3 盏/次曝光），不跟着榜单页往上抬——它的价值在精准，不在量。
  {
    key: 'mini-detail', name: '小程序·作品详情页', where: '小程序详情页、评论区上方一行',
    showViews: 1, showPoints: 3, clickPoints: 9, extClickPoints: 9,
    showPacks: [20, 50, 100], clickPacks: [5, 10, 20],
    exclusive: false, maxActive: 3, maxQueued: 0,
    internalOnly: true,
    note: '一行文字，多位投放时每次随机展示一条'
  },
  {
    key: 'mini-rank-line', name: '小程序·榜单页一行文字', where: '小程序星梦榜分段栏下方一行',
    showViews: 1, showPoints: 4, clickPoints: 12, extClickPoints: 12,
    showPacks: [20, 50, 100], clickPacks: [5, 10, 20],
    exclusive: false, maxActive: 3, maxQueued: 0,
    internalOnly: true,
    note: '一行文字，多位投放时每次随机展示一条'
  },
  {
    key: 'mini-feat-line', name: '小程序·发现页一行文字', where: '小程序发现页顶部一行',
    showViews: 1, showPoints: 3, clickPoints: 9, extClickPoints: 9,
    showPacks: [20, 50, 100], clickPacks: [5, 10, 20],
    exclusive: false, maxActive: 3, maxQueued: 0,
    internalOnly: true,
    note: '一行文字，多位投放时每次随机展示一条'
  }
];
const REDEEM_SLOT_KEYS = REDEEM_SLOTS.map(s => s.key);
function redeemCfg(slot) {
  return REDEEM_SLOTS.find(s => s.key === slot) || REDEEM_SLOTS[0];
}
// 作品自己登记的官网/下载链接（投稿/编辑时填的）：外链推广只允许跳这些地址，
// 跳出去的每个链接都是投稿时过过目的，不接受下单时随手填第三方地址
function workLinksOf(w) {
  const links = w && w.links && typeof w.links === 'object' ? Object.values(w.links) : [];
  return [w && w.site, ...links, w && w.link].map(x => String(x || '').trim()).filter(Boolean);
}
function workSiteOf(w) { return workLinksOf(w)[0] || ''; }
// 归一化匹配（忽略结尾斜杠和大小写），命中返回登记时的原样地址（广告跳转用它）
function workSiteMatch(w, link) {
  const norm = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  return workLinksOf(w).find(u => norm(u) === norm(link)) || '';
}
// 带形态标签的链接清单（推荐面板「官网/下载链接」去向的候选列表）：
// 官网在最前（不与形态链接重复时），其后按作品勾选的形态顺序各列各的下载/安装链接。
// 和 workLinksOf 是同一批地址（都来自投稿/编辑时登记的 site / links / link），只是多了「哪个形态」的标签，
// 推荐面板据此渲染成可点选的候选——作品填了多个地址时，让作者自己挑点广告后落到哪一个
function workLinkEntriesOf(w) {
  const out = [];
  const seen = new Set();
  const push = (t, url) => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ t: t || '', url: u });
  };
  push('', w && w.site);                                   // 官网（标签空 → 前端显示「官网」）
  const links = w && w.links && typeof w.links === 'object' ? w.links : {};
  const types = Array.isArray(w && w.types) && w.types.length ? w.types : (w && w.type ? [w.type] : []);
  types.forEach(t => push(t, links[t]));                   // 按勾选的形态顺序列各形态自己的链接
  Object.keys(links).forEach(t => push(t, links[t]));      // 兜底：links 里有但形态里没勾的，补在后面
  if (w && w.link) push('', w.link);                       // 更老的单链接字段
  return out;
}
// 老订单（没有锁定单价记录的历史数据）退款时按 redeemCfg('detail') 折算
const REDEEM_MAX_DAYS = 14;                // 兜底有效期：开始投放后 14 天没投完也下线，剩余额度按原价退回（与撤下同口径）
// 每个访客每天最多能消耗多少额度：防止一个人的反复刷新（或竞品恶意点击）把别人的推广吃掉。
// 超出后广告照常展示、点击照常记录，只是不再扣这单的灯火——用户买到的次数只会被「更多不同的人」消耗。
// 访客口径：登录按账号，未登录按本机访客 ID（浏览器里存的 dm_vid），都不用 IP。
// 旧口径按 IP：公司/校园/运营商 CGNAT 出口下几千人共用一个 IP，等于整栋楼一天只扣 1 次，
// 投放者买的 200 次曝光永远烧不完；换成访客 ID 后一人一账，换网络也还是同一个访客。
const REDEEM_DAY_CAP_VIEWS = 1;            // 同一访客同一广告，每天最多扣 1 次曝光额度
const REDEEM_DAY_CAP_CLICKS = 3;           // 同一访客同一广告，每天最多扣 3 次点击额度
// 访客 ID 存在浏览器里，清掉就能换个新身份，所以再按 IP 压一道兜底（值要高于共享出口的正常用量，别误伤）。
const REDEEM_IP_CAP_VIEWS = 20;            // 同一 IP 每天最多扣 20 次曝光额度
const REDEEM_IP_CAP_CLICKS = 20;           // 同一 IP 每天最多扣 20 次点击额度
const REDEEM_DAY_MS = 86400e3;             // 以「首次计数」为起点滚动 24 小时，不按自然日清零（跨零点刷也没用）

// 展示费 = 展示次数 / 每档次数 × 每档灯火。单价是整数盏/次（showViews=1），所以这个除法是恒等的，
// 老订单（showViews=10 时代的 0.2 / 0.5 盏/次）也照旧能算，Math.round 只是兜底不产生小数。
function redeemShowPriceOf(views, slot) {
  const c = redeemCfg(slot);
  return Math.round(views / c.showViews * c.showPoints);
}
// 点击费 = 点击次数 × 单价
function redeemClickPriceOf(clicks, slot) {
  return Math.max(0, clicks | 0) * redeemCfg(slot).clickPoints;
}
// 订单总额 = 展示费 + 点击费
function redeemPriceOf(views, clicks, slot) {
  return redeemShowPriceOf(views, slot) + redeemClickPriceOf(clicks, slot);
}

// ---------- 用户 / 会话 ----------
// 永久免登录：登录一次长期有效（cookie 与服务端会话都按年计），
// 活跃用户由下面的滑动续期不断续命，只有常年不来的号才会真正过期。
const REMEMBER_TTL = 365 * 86400e3;  // 兼容旧字段：勾「记住我」也是 1 年
const SESSION_TTL = 365 * 86400e3;   // 未勾选：同样 1 年（不再有 12 小时短会话）
const COOKIE_MAX_AGE = 365 * 86400;  // cookie Max-Age（秒）
// ---------- 账号名 / 昵称：保留词与冒充防护 ----------
// 站内有灯火、推荐位和榜单，冒充站方的收益是实打实的（骗信任、假冒客服代收钱）。
// 三层拦：① 精确保留词（老规则）② 词根命中（admin1 / 管理员01 / 官方客服）
// ③ 形近归一后再比（adm1n / admln / Ａdmin / admin_01 / ａｄｍｉｎ）
const RESERVED_NAMES = ['admin', 'administrator', '管理员', '匿名', 'root', 'system', '官方', 'official'];
// 英文词根：出现在名字任意位置都算冒充（这些词在账号名里没有正当用法）
const RESERVED_ROOTS_EN = ['admin', 'administrator', 'moderator', 'webmaster', 'sysadmin', 'superuser', 'official', 'support', 'noreply'];
// 英文短词：只认「整词」（两边不是字母），避免 helper、teammate 这类正常名字被误伤
const RESERVED_WORDS_EN = ['root', 'system', 'staff', 'team', 'help', 'security', 'mod', 'mods', 'service'];
// 中文词根：名字里出现这些字样基本只有一个意思——冒充站方
const RESERVED_ROOTS_ZH = ['管理', '管理員', '官方', '客服', '站长', '站長', '小编', '小編', '审核', '審核',
  '版主', '系统', '系統', '公告', '通知', '站务', '站務', '版务', '版務', '小助手'];
// 品牌词：只拦成词的品牌（不拦「造梦者」这种正常名字），防「造梦酒馆官方」这类号
const RESERVED_BRANDS = ['造梦酒馆', '造梦酒館', '酒馆官方', '酒館官方', 'zaomeng', 'dreamsaloon'];
// 导流 / 广告词：账号名和昵称都会出现在公开页，别让它们变成免费广告位
const AD_NAME_WORDS = ['加v', '加微', '加我', '代做', '接单', '刷单', '包过', '招代理', '免费领', '私聊'];

// 形近归一（只用于比对，不改用户实际名字）：
// NFKC 把全角/兼容字转半角 → 小写 → 去掉零宽与分隔符 → 易混字符换成同一形状。
// adm1n / admln / Ａdmin / admin_01 / ａｄｍｉｎ 最终都会落到 admin 上。
function nameFingerprint(name) {
  let s = String(name || '');
  try { s = s.normalize('NFKC'); } catch (e) { /* 老 Node 不支持就跳过 */ }
  return s.toLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')   // 零宽 / 方向控制字符
    .replace(/[_\-·・.“”"'`、]/g, '')                     // 分隔符与引号
    .replace(/[1l|!íìîï]/g, 'i')                          // 1 / l / | → i
    .replace(/0/g, 'o')                                   // 0 → o
    .replace(/rn/g, 'm')                                  // rn → m
    .replace(/vv/g, 'w');                                 // vv → w
}

// 冒充站方 / 品牌 / 导流的判定（账号名和昵称共用）。
// 返回错误文案；没问题返回空串。
function nameImpersonation(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const low = raw.toLowerCase();
  if (RESERVED_NAMES.includes(low)) return '这个名字不可用，换一个吧';
  const fp = nameFingerprint(raw);
  const roots = RESERVED_ROOTS_EN.concat(RESERVED_ROOTS_ZH, RESERVED_BRANDS);
  if (roots.some(w => fp.includes(nameFingerprint(w)))) {
    return '这个名字容易被误认为站方，换一个吧';
  }
  // 短英文词按整词判：先把分隔符统一成空格，再要求两边不是字母
  let spaced = low;
  try { spaced = spaced.normalize('NFKC'); } catch (e) { /* 忽略 */ }
  spaced = spaced.replace(/[_\-·・.\s]+/g, ' ');
  if (RESERVED_WORDS_EN.some(w => new RegExp('(^|[^a-z])' + w + '([^a-z]|$)').test(spaced))) {
    return '这个名字容易被误认为站方，换一个吧';
  }
  // 导流 / 广告：联系方式、推广语、网址
  if (AD_NAME_WORDS.some(w => fp.includes(nameFingerprint(w)))) {
    return '名字里不要留联系方式或推广语';
  }
  if (/(https?:|www[._-]|\.(com|cn|net|org|top|xyz|cc)\b)/i.test(raw)) {
    return '名字里不要带网址';
  }
  if (/(^|[^a-z])(wx|vx|wechat|weixin|qq)([^a-z]|$)/i.test(spaced)) {
    return '名字里不要留联系方式';
  }
  return '';
}

// 账号名的形状规则：全数字（像手机号/QQ）、全符号、单字符重复（aaa/___/1111）
function nameShapeError(name) {
  const s = String(name || '');
  if (/^\d+$/.test(s)) return '账号名不能全是数字，加点字母或中文吧';
  if (/^[^A-Za-z0-9\u4e00-\u9fa5]+$/.test(s)) return '账号名不能全是符号';
  if (/^[\d_]+$/.test(s)) return '账号名不能只有数字和下划线';
  if (/(.)\1{3,}/.test(s)) return '账号名不要用连续重复的字符';
  return '';
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function makeUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username,
    nickname: '',      // 展示用昵称（空 = 用账号名）
    salt,
    pass: hashPassword(password, salt),
    favs: [],          // 收藏的作品 id（按收藏时间倒序）
    createdAt: new Date().toISOString()
  };
}
function checkPassword(user, password) {
  const h = hashPassword(password, user.salt);
  const a = Buffer.from(h), b = Buffer.from(user.pass);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// ================= 展示名（昵称） =================
// 账号名（username）是身份主键：登录、作品归属、/u/ 作者页、作者徽章都认它。
// 昵称只影响「显示成什么」，改了不动任何历史数据：
//   作品存的是账号名 → 展示时动态换成昵称；作者页仍按账号名访问。
function userByName(name) {
  if (!name) return null;
  if (!userIndex) {
    userIndex = new Map();
    for (const u of users) userIndex.set(u.username, u);
  }
  return userIndex.get(name) || null;
}

// 登录 / 绑定时按名字认人：先精确，再大小写不敏感。
// 历史数据里可能有 Zhang / zhang 并存（老规则查重区分大小写），
// 那种情况只认精确匹配，避免登进别人的号；注册与改名已按 lowercase 判重，新数据不会并存。
// alias（登录别名）同样能用来认人：微信/ OAuth 自动建号的号 username 是 wx_xxx 这类
// 系统生成的随机名，用户记不住，设了别名后「别名 + 密码」也能登录。
function findUserLoose(rawName) {
  const n = String(rawName || '').trim();
  if (!n) return null;
  const exact = users.find(u => u.username === n || u.alias === n);
  if (exact) return exact;
  const low = n.toLowerCase();
  const loose = users.filter(u => u.username.toLowerCase() === low || String(u.alias || '').toLowerCase() === low);
  return loose.length === 1 ? loose[0] : null;
}

// 分享归因的 ref 解析：新链接带用户 id（纯 ASCII），旧的汉字账号名链接也继续兼容
function resolveShareUser(ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const byName = userByName(r);
  if (byName) return byName;
  return users.find(u => u.id === r) || null;
}
function displayNameOf(name) {
  if (!name) return '';
  const u = userByName(name);
  return (u && u.nickname) ? u.nickname : name;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const rec = sessions[sid];
  if (!rec || !rec.uid || Date.now() > rec.exp) {
    if (rec) { delete sessions[sid]; saveSessions(); }
    return null;
  }
  return users.find(u => u.id === rec.uid) || null;
}
function isRemember(body) {
  const v = (body || {}).remember;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}
// via = 会话签发方式（pass=密码验证 / wechat=微信身份验证 / oauth=GitHub、Google），
// iat = 签发时间。微信绑定账号「免旧密码重设密码」要靠它确认「刚验过微信身份」（见 /api/me/password）。
function setSession(res, user, remember, via) {
  const sid = crypto.randomBytes(24).toString('hex');
  const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
  sessions[sid] = { uid: user.id, exp: Date.now() + ttl, iat: Date.now(), via: via || '' };
  // 顺手清理过期会话
  for (const k of Object.keys(sessions)) if (sessions[k].exp < Date.now()) delete sessions[k];
  saveSessions();
  // 永久免登录：一律写持久 cookie（1 年），配合滑动续期，活跃用户不会再被登出
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
}
function clearSession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) { delete sessions[sid]; saveSessions(); }
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
// 当前会话的签发方式 / 签发时间（老会话没有这两个字段，按空处理）
function sessionVia(req) {
  const sid = parseCookies(req).sid;
  const rec = sid && sessions[sid];
  return rec ? { via: String(rec.via || ''), iat: Number(rec.iat || 0) } : null;
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { res.status(401).json({ error: '请先登录' }); return null; }
  return user;
}

// ================= GitHub OAuth（登录 + 绑定） =================
// 流程：start 生成一次性 state 并跳 GitHub → 用户授权 → callback 校验 state、
//       换 access_token、拉 /user，然后「按 github id 找账号」：找到就登录，找不到就建号。
// state 存内存（10 分钟、用一次就删），进程重启后旧的授权链接失效，重来一次即可。
const GH_STATES = new Map();
const GH_STATE_TTL = 10 * 60e3;

function ghPruneStates() {
  const now = Date.now();
  GH_STATES.forEach((v, k) => { if (now > v.exp) GH_STATES.delete(k); });
}
// 回调地址：GitHub 应用里登记的地址必须和这里完全一致
function ghCallbackUrl(req) {
  if (GH_CONF.callbackUrl) return GH_CONF.callbackUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/auth/github/callback`;
}
// 站内跳转目标只接受相对路径，防 ?next= 被拿去做开放重定向
function safeNextPath(v) {
  const s = String(v || '');
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  return s;
}
function withQuery(url, kv) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + kv;
}
function ghErrorRedirect(res, code) {
  res.redirect('/' + '?auth_error=' + encodeURIComponent(code));
}
function goErrorRedirect(res, code) {
  res.redirect('/' + '?auth_error=' + encodeURIComponent(code));
}
async function ghFetchJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}
async function ghExchangeToken(code, redirectUri) {
  const r = await ghFetchJson(GH_CONF.oauthBase + '/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'dream-window'
    },
    body: new URLSearchParams({
      client_id: GH_CONF.clientId,
      client_secret: GH_CONF.clientSecret,
      code: String(code),
      redirect_uri: redirectUri
    }).toString()
  });
  const token = r.data && r.data.access_token;
  if (!token) throw new Error((r.data && (r.data.error_description || r.data.error)) || 'GitHub 授权失败');
  return token;
}
async function ghFetchUser(token) {
  const r = await ghFetchJson(GH_CONF.apiBase + '/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'User-Agent': 'dream-window'
    }
  });
  if (!r.ok || !r.data || !r.data.id) throw new Error('读取 GitHub 账号信息失败');
  return r.data;
}
/* GitHub 资料 → 站内用户 */
function ghProfileOf(u) {
  return {
    id: String(u.id),
    login: String(u.login || ''),
    name: String(u.name || ''),
    avatar: String(u.avatar_url || ''),
    url: String(u.html_url || ('https://github.com/' + (u.login || ''))),
    connectedAt: new Date().toISOString()
  };
}
// GitHub 登录名是「字母数字-」，站内账号名要求 2-20 位（中文/字母/数字/下划线）：
// 短横线换成下划线、截断到 20 位；重名就加 _2/_3…，实在挑不出来就用 gh_<id>。
function ghUsernameFor(login, ghId) {
  return oauthUsernameFor(login, 'gh_', ghId);
}
// OAuth 建号的账号名生成（GitHub 登录名 / 邮箱前缀共用）：
// 清洗成站内合法字符，重名加后缀，实在挑不出来就用 <前缀>_<id 尾部>
function oauthUsernameFor(seed, fbPrefix, fbId) {
  const clean = String(seed || '').replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  let base = clean.slice(0, 20) || (fbPrefix + String(fbId || '').slice(-8));
  if (base.length < 2) base = (base + fbPrefix).slice(0, 20);
  // 第三方登录名可能是 admin / system / 12345 这类：不能原样搬进来，
  // 也不能只加个前缀洗白（gh_admin 照样像个站方号），直接退化成 gh_<id 尾部>
  if (nameImpersonation(base) || nameShapeError(base)) {
    base = (fbPrefix + String(fbId || '').slice(-8)).slice(0, 20);
  }
  const taken = n => !!users.find(u => u.username.toLowerCase() === n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = '_' + i;
    const cand = base.slice(0, 20 - suffix.length) + suffix;
    if (!taken(cand)) return cand;
  }
  return (fbPrefix + String(fbId || Date.now())).slice(0, 20);
}
// GitHub 建号：随机密码（用户改密码前不能走密码登录，见 passSet 标记）
function makeGithubUser(gh) {
  const username = ghUsernameFor(gh.login, gh.id);
  const user = makeUser(username, crypto.randomBytes(24).toString('hex'));
  user.passSet = false;          // 还没设过自己的密码
  user.tempAcct = true;          // OAuth 自动建的临时号：还能把数据整体合并进用户自己的老账号
  user.github = ghProfileOf(gh);
  // GitHub 的显示名优先当昵称（比 octocat_2 好看）；不合法就留空，回落到账号名
  const nick = nickParse((gh && gh.name) || '', user);
  if (nick.nick) user.nickname = nick.nick;
  return user;
}

// ================= Google OAuth（登录 + 绑定） =================
// 与 GitHub 流程同构：start 生成一次性 state 跳授权页 → callback 校验 state、
// 换 access_token、拉 userinfo（OpenID Connect）。差异点：
//   - Google 没有全局登录名，用 sub（用户唯一 id）认人；
//   - 账号名从邮箱前缀生成，没给邮箱就 g_<sub 尾部>；
//   - 邮箱只在 email_verified 时才当可信资料展示（账号名仍可用前缀，认人不靠它）。
const GO_STATES = new Map();
const GO_STATE_TTL = 10 * 60e3;
function goPruneStates() {
  const now = Date.now();
  GO_STATES.forEach((v, k) => { if (now > v.exp) GO_STATES.delete(k); });
}
function goCallbackUrl(req) {
  if (GOOGLE_CONF.callbackUrl) return GOOGLE_CONF.callbackUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/auth/google/callback`;
}
async function goFetchJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}
async function goExchangeToken(code, redirectUri) {
  const r = await goFetchJson(GOOGLE_CONF.tokenBase + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CONF.clientId,
      client_secret: GOOGLE_CONF.clientSecret,
      code: String(code),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString()
  });
  const token = r.data && r.data.access_token;
  if (!token) throw new Error((r.data && (r.data.error_description || r.data.error)) || 'Google 授权失败');
  return token;
}
async function goFetchUserinfo(token) {
  const r = await goFetchJson(GOOGLE_CONF.userinfoBase + '/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok || !r.data || !r.data.sub) throw new Error('读取 Google 账号信息失败');
  return r.data;
}
/* Google userinfo → 站内用户 */
function goProfileOf(u) {
  return {
    sub: String(u.sub || ''),
    name: String(u.name || ''),
    email: String(u.email || ''),
    emailVerified: !!u.email_verified,
    picture: String(u.picture || ''),
    connectedAt: new Date().toISOString()
  };
}
// Google 建号：账号名从邮箱前缀来；随机密码 + passSet=false（同 GitHub）
function makeGoogleUser(g) {
  const username = oauthUsernameFor(String(g.email || '').split('@')[0], 'g_', g.sub);
  const user = makeUser(username, crypto.randomBytes(24).toString('hex'));
  user.passSet = false;
  user.tempAcct = true;          // OAuth 自动建的临时号：还能把数据整体合并进用户自己的老账号
  user.google = goProfileOf(g);
  // Google 的昵称优先；不合法就留空，回落到账号名
  const nick = nickParse((g && g.name) || '', user);
  if (nick.nick) user.nickname = nick.nick;
  return user;
}

// 屏蔽（不感兴趣）：存在用户记录里的作品 id 数组，只影响该用户自己看到的列表
function blockedIds(user) {
  return new Set(user && Array.isArray(user.blocked) ? user.blocked : []);
}
// 拉黑作者：存在用户名数组里，TA 的所有作品（含以后新发的）都不再出现在我的列表里
function blockedAuthorSet(user) {
  return new Set(user && Array.isArray(user.blockedUsers) ? user.blockedUsers : []);
}
function filterBlocked(list, user) {
  const set = blockedIds(user);
  const authors = blockedAuthorSet(user);
  if (!set.size && !authors.size) return list;
  return list.filter(w => !set.has(w.id) && !authors.has(w.author));
}

// 历史数据迁移：为旧作品作者创建演示账号（密码 123456，可在 data/users.json 删除）
if (!fs.existsSync(fileOf('users.json'))) {
  ['张三', '李四', '王五'].forEach(n => {
    if (!users.find(u => u.username === n)) {
      const u = makeUser(n, '123456');
      users.push(u);
      works.filter(w => w.author === n).forEach(w => { w.userId = u.id; });
    }
  });
  saveUsers();
  saveWorks();
  console.log('已为历史作者创建演示账号（张三/李四/王五，密码 123456），请及时修改或删除');
}

// 对外展示的形态（后台可管理；旧形态名已下线，但旧数据仍兼容识别，提交时会被映射成新形态）
let WORK_TYPES = workTypes.map(t => t.name);
let ALL_TYPES_LEGACY = Array.from(new Set(WORK_TYPES.concat(['游戏', '网站', 'App', '桌面应用', '浏览器扩展', '工具', '智能体'])));
function syncWorkTypes() {
  WORK_TYPES = workTypes.map(t => t.name);
  ALL_TYPES_LEGACY = Array.from(new Set(WORK_TYPES.concat(['游戏'])));
  seo.setTypeIcons(typeIconMap());
}
syncWorkTypes();
const SENSITIVE_WORDS = ['赌博', '色情', '毒品', '代开发票', '办证', '博彩'];

function hitSensitive(text) {
  const s = String(text || '');
  return SENSITIVE_WORDS.some(w => s.includes(w));
}

// ---------- 限流（内存滑动窗口） ----------
const POST_LIMIT = parseInt(process.env.RATE_POST_LIMIT || '5', 10); // 每 IP 每小时发布次数
const rateBuckets = new Map();
// 桶只增不减会长期吃内存：超过阈值时顺手清掉已过窗口的旧桶（按各自的窗口判断）
const RATE_BUCKETS_MAX = 5000;
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (rateBuckets.size > RATE_BUCKETS_MAX) {
    rateBuckets.forEach((v, k) => {
      if (now - v.start > (v.ms || 3600000)) rateBuckets.delete(k);
    });
  }
  const rec = rateBuckets.get(key);
  if (!rec || now - rec.start > windowMs) {
    rateBuckets.set(key, { start: now, count: 1, ms: windowMs });
    return true;
  }
  rec.count += 1;
  return rec.count <= limit;
}
// 真实客户端 IP：只信「我们自己的代理追加的那一段」。
// nginx 用 $proxy_add_x_forwarded_for 时会把客户端自带的 XFF 原样带过来，再在末尾追加它看到的对端；
// 取第一段等于让请求方随便填 IP——限流、防刷、UV 统计全都能被绕过。取倒数第 TRUSTED_PROXY_HOPS 段才是可信的。
// 以后前面若再加一层 CDN，把这个环境变量调成对应的层数（默认 1 = 只信最后一段，即 nginx 追加的那段）。
const TRUSTED_PROXY_HOPS = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10) || 1);
// 只有「紧邻的上游是我们的代理」时才看 XFF：直连（绕过 nginx 直接打 node 端口）时一律用 socket 对端，
// 否则攻击者只要自己带一个 X-Forwarded-For 就能换成任意 IP。
// 默认认本机与内网（nginx 与 node 同机时对端是 127.0.0.1）；前面换负载均衡/容器网络时用 TRUSTED_PROXY_IPS 覆盖（逗号分隔）。
const PRIVATE_PEER_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/;
const TRUSTED_PEER_LIST = String(process.env.TRUSTED_PROXY_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const stripMapped = ip => String(ip || '').replace(/^::ffff:/, '');
function isTrustedPeer(ip) {
  if (!ip) return false;
  if (TRUSTED_PEER_LIST.length) return TRUSTED_PEER_LIST.includes(ip) || TRUSTED_PEER_LIST.includes(stripMapped(ip));
  return PRIVATE_PEER_RE.test(ip);
}
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (!peer) return 'unknown';
  if (!isTrustedPeer(peer)) return stripMapped(peer);   // 直连：XFF 一律不认
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const pick = xff[xff.length - TRUSTED_PROXY_HOPS];
  if (pick && (IPV4_RE.test(pick) || (pick.includes(':') && IPV6_RE.test(pick)))) return stripMapped(pick);
  // 代理没带 XFF（本机调试直连）：退回 socket 对端
  return stripMapped(peer);
}

// ---------- 访问统计：PV / UV ----------
// 结构：{ days: { '2026-10-31': { pv: 12, uv: { 'u:<userId>': 1, 'ip:<ip>': 1 } } } }
// UV 身份：登录用户按账号去重（同一账号多设备算 1 个），未登录按 IP 去重
const VISIT_RETENTION_DAYS = 90;
let visits = readJSON('visits.json', { days: {} });
if (!visits || typeof visits !== 'object' || !visits.days) visits = { days: {} };

function dateKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 单个访客每日 PV 上限 ----------
// 一个人（或自己）把站点刷 400 次，不该全算成 400 次站点访问：正常人一天也就看十几页。
// 超过上限的部分照旧记进 pvBy（原始数据不丢），只在展示统计时截断。
// 注意：只影响站点 PV/UV 展示；广告曝光/点击的计费走独立接口，一点不受影响。
const VISIT_PV_CAP_PER_ID = 50;

// ---------- 排除名单：极端情况下整段不计入站点统计 ----------
// 站长每天刷自己的站几百次，会把页脚 PV 冲到离谱；把你的 IP 加进 data/visit-exclude.json 即可。
// 文件是字符串数组，三种写法都认：
//   '203.0.113.10' 或 'ip:203.0.113.10' → 按未登录 IP 排除（IP 会变，变了补一条就行）
//   'u:<userId>'                           → 按登录账号排除（换 IP 也照样排除，最稳）
//   'd:<deviceId>'                         → 按小程序设备排除
// 改完文件即时生效（按修改时间自动重载），不用重启。
// PV 按访客身份（pvBy）记录，所以名单是事后生效的：今天加上，今天之前的数字也会被扣除。
let visitExcludeCache = { mtime: 0, set: new Set() };
function visitExcludeSet() {
  try {
    const st = fs.statSync(fileOf('visit-exclude.json'));
    if (st.mtimeMs !== visitExcludeCache.mtime) {
      visitExcludeCache.mtime = st.mtimeMs;
      const raw = readJSON('visit-exclude.json', []);
      const norm = s => {
        s = String(s || '').trim();
        if (!s) return '';
        // 裸 IP 自动补 ip: 前缀；带 ::ffff: 的也归一
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return 'ip:' + s;
        if (s.startsWith('::ffff:')) return 'ip:' + stripMapped(s);
        return s;
      };
      visitExcludeCache.set = new Set((Array.isArray(raw) ? raw : []).map(norm).filter(Boolean));
    }
  } catch (e) { /* 文件不存在 = 空名单 */ }
  return visitExcludeCache.set;
}
// 一个 PV 分桶（day / day.mini）里「不该计入」的次数：
//   命中排除名单 → 全部不计；其他身份 → 超过单日上限的部分不计
function uncountedPvOf(bucket, ex) {
  const by = bucket && bucket.pvBy;
  if (!by) return 0;
  let n = 0;
  Object.keys(by).forEach(k => {
    const c = by[k] || 0;
    n += ex.has(k) ? c : Math.max(0, c - VISIT_PV_CAP_PER_ID);
  });
  return n;
}

let visitSaveTimer = null;
function scheduleVisitSave() {
  if (visitSaveTimer) return;
  visitSaveTimer = setTimeout(() => {
    visitSaveTimer = null;
    try { writeJSON('visits.json', visits); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// ---------- 流量构成：来源域名 / 设备 / 落地页 ----------
// 只做「画像」，不参与 PV/UV 口径：PV/UV 仍然是上面那套（身份去重 + 排除名单 + 单日上限），
// 这里记的是原始动作数，用来回答「人从哪来、用什么设备、第一眼落在哪个页」。
// 自己记而不接百度统计/51la 的原因：口径能和站内业务对齐（作者自己不算、排除名单同样不记），
// 也不用为三个基础维度给首屏塞一个外部脚本。
const TRAFFIC_REF_MAX = 40;                 // 单日来源域名最多记 40 个，多的归「其他来源」
const TRAFFIC_LAND_MAX = 60;                // 单日落地页最多记 60 个，多的归「其他页面」
const TRAFFIC_REF_OTHER = '(其他来源)';
const TRAFFIC_LAND_OTHER = '(其他页面)';
const TRAFFIC_DIRECT = '直接访问';
const TRAFFIC_INNER = '站内跳转';
// 来源渠道看板（?fr=）管的是「我们主动投放的渠道」；这里管的是「自然来路」，
// 两者口径不同、互不替代：外宣链接落地时 referrer 通常是空的，会记成「直接访问」。
const REF_MERGE = [
  [/^(?:[\w-]+\.)*baidu\.com$/i, 'baidu.com'],
  [/^(?:[\w-]+\.)*google\.[a-z.]+$/i, 'google'],
  [/^(?:[\w-]+\.)*(?:bing|msn)\.com$/i, 'bing.com'],
  [/^(?:[\w-]+\.)*sogou\.com$/i, 'sogou.com'],
  [/^(?:[\w-]+\.)*so\.com$/i, '360 搜索'],
  [/^(?:[\w-]+\.)*sm\.cn$/i, '神马搜索'],
  [/^t\.co$/i, 'x.com'],
  [/^(?:[\w-]+\.)*(?:x|twitter)\.com$/i, 'x.com'],
  [/^(?:[\w-]+\.)*weixin\.qq\.com$/i, '微信公众号'],
  [/^(?:[\w-]+\.)*weibo\.(?:com|cn)$/i, '微博'],
  [/^(?:[\w-]+\.)*zhihu\.com$/i, '知乎'],
  [/^(?:[\w-]+\.)*juejin\.cn$/i, '掘金'],
  [/^(?:[\w-]+\.)*v2ex\.com$/i, 'v2ex.com'],
  [/^(?:[\w-]+\.)*news\.ycombinator\.com$/i, 'Hacker News'],
  [/^(?:[\w-]+\.)*github\.com$/i, 'github.com'],
  [/^(?:[\w-]+\.)*douyin\.com$/i, '抖音'],
  [/^(?:[\w-]+\.)*xiaohongshu\.com$/i, '小红书'],
];

// 本机 host 集合：referrer 指向自己域名说明是站内跳转，不该算「来源」
function selfHostSet(req) {
  const h = String((req && req.headers && req.headers.host) || '')
    .split(':')[0].trim().toLowerCase().replace(/^www\./, '');
  const s = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
  if (h) s.add(h);
  return s;
}

function normRefHost(raw, selfHosts) {
  const s = String(raw || '').trim().slice(0, 300);
  if (!s) return TRAFFIC_DIRECT;               // 没有 referrer：直接输网址 / 书签 / 客户端内打开
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch { return TRAFFIC_DIRECT; }
  if (!host) return TRAFFIC_DIRECT;
  host = host.replace(/^www\./, '');
  if (selfHosts.has(host)) return TRAFFIC_INNER;
  for (const [re, name] of REF_MERGE) if (re.test(host)) return name;
  return host.slice(0, 60);
}

// UA 粗分。顺序有讲究：微信内置浏览器同时带 Mobile，要先认出来；
// 爬虫（含移动版 Googlebot）要在 mobile 之前拦掉，否则会被算成手机用户。
function deviceOf(req, mini) {
  if (mini) return 'mini';
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  if (!ua) return 'unknown';
  if (/MicroMessenger|WeChat/i.test(ua)) return 'wechat';
  if (/bot|spider|crawl|slurp|headless|preview|lighthouse|chatgpt-user|perplexity-user|oai-searchbot/i.test(ua)) return 'bot';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobile|Android|iPhone|iPod|HarmonyOS|MIUI/i.test(ua)) return 'mobile';
  return 'desktop';
}

// 落地页只留路径：query 里带 ?ref= 会有无数种组合，留着会让统计散成几百行
function normLanding(raw) {
  let p = String(raw || '/').split('#')[0].split('?')[0].trim();
  if (!p) return '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p.slice(0, 120);
}

// 记流量构成。排除名单里的身份、以及超过单日 PV 上限的身份一律不记 ——
// 站长自己刷自己的站，能把设备/来源分布带得完全失真。PV/UV 不受影响。
function trackTrafficShape(req, bucket, vid, mini, o) {
  if (visitExcludeSet().has(vid)) return;
  if ((bucket.pvBy[vid] || 0) > VISIT_PV_CAP_PER_ID) return;

  bucket.devs = bucket.devs || {};
  const dev = deviceOf(req, mini);
  bucket.devs[dev] = (bucket.devs[dev] || 0) + 1;
  if (mini) return;   // 小程序入口固定，没有 referrer 也没有「落地页」概念
  // 爬虫只留一个数量（能看出站点 PV 里有多少是机器），不进来源和落地页：
  // 「人从哪来、第一眼落在哪」讲的是人，把蜘蛛算进去只会把真实来源稀释掉
  if (dev === 'bot') return;

  bucket.refs = bucket.refs || {};
  const ref = normRefHost(o.ref, selfHostSet(req));
  if (bucket.refs[ref] != null) bucket.refs[ref] += 1;
  else if (Object.keys(bucket.refs).length < TRAFFIC_REF_MAX) bucket.refs[ref] = 1;
  else bucket.refs[TRAFFIC_REF_OTHER] = (bucket.refs[TRAFFIC_REF_OTHER] || 0) + 1;

  // 落地页只在「本次打开的第一屏」记一次，站内跳转不重复记（否则每个内页都成了落地页）
  if (o.entry && o.path) {
    bucket.land = bucket.land || {};
    const p = normLanding(o.path);
    if (bucket.land[p] != null) bucket.land[p] += 1;
    else if (Object.keys(bucket.land).length < TRAFFIC_LAND_MAX) bucket.land[p] = 1;
    else bucket.land[TRAFFIC_LAND_OTHER] = (bucket.land[TRAFFIC_LAND_OTHER] || 0) + 1;
  }
}

// 小程序访问单独一桶（day.mini），不混进站点 PV/UV：
// 手机几乎都在运营商 NAT 后面，按 IP 去重会把一堆人算成一个人；小程序端用本地 deviceId 去重
function trackVisit(req, opts) {
  const o = opts || {};
  const mini = o.platform === 'mini';
  const key = dateKey();
  const day = visits.days[key] || (visits.days[key] = { pv: 0, uv: {} });
  if (!day.uv) day.uv = {};
  if (mini && !day.mini) day.mini = { pv: 0, uv: {} };
  const bucket = mini ? day.mini : day;
  if (!bucket.uv) bucket.uv = {};
  if (!bucket.pvBy) bucket.pvBy = {};

  const user = currentUser(req);
  const vid = user ? 'u:' + user.id
    : (mini && o.deviceId ? 'd:' + o.deviceId : 'ip:' + clientIp(req));

  bucket.pv = (bucket.pv || 0) + 1;
  bucket.uv[vid] = 1;
  // 每次访问都挂到访客身份上：排除名单是按身份事后扣除的，
  // 事后把某个 IP 加进名单，它今天/之前的访问也能一并扣掉
  bucket.pvBy[vid] = (bucket.pvBy[vid] || 0) + 1;

  trackTrafficShape(req, bucket, vid, mini, o);

  // 只保留最近 N 天
  const keys = Object.keys(visits.days).sort();
  while (keys.length > VISIT_RETENTION_DAYS) delete visits.days[keys.shift()];
  scheduleVisitSave();
}

function visitStats() {
  const days = visits.days || {};
  const ex = visitExcludeSet();
  let pv = 0;
  let miniPv = 0;
  const allUv = new Set();
  const miniUv = new Set();
  Object.values(days).forEach(d => {
    pv += (d.pv || 0) - uncountedPvOf(d, ex);
    Object.keys(d.uv || {}).forEach(k => { if (!ex.has(k)) allUv.add(k); });
    if (d.mini) {
      miniPv += (d.mini.pv || 0) - uncountedPvOf(d.mini, ex);
      Object.keys(d.mini.uv || {}).forEach(k => { if (!ex.has(k)) miniUv.add(k); });
    }
  });
  const today = days[dateKey()] || { pv: 0, uv: {} };
  const todayMini = today.mini || { pv: 0, uv: {} };
  // 运营天数：从上线日（含当天）算到今天，页脚「已运营 N 天」用
  const start = Date.parse(SITE_LAUNCH + 'T00:00:00');
  const runDays = Number.isFinite(start)
    ? Math.max(1, Math.floor((Date.now() - start) / 86400e3) + 1) : 0;
  return {
    pv, uv: allUv.size,
    pvToday: (today.pv || 0) - uncountedPvOf(today, ex),
    uvToday: Object.keys(today.uv || {}).filter(k => !ex.has(k)).length,
    // 小程序渠道单独计数（网页端的 pv/uv 不含这部分）
    miniPv, miniUv: miniUv.size,
    miniPvToday: (todayMini.pv || 0) - uncountedPvOf(todayMini, ex),
    miniUvToday: Object.keys(todayMini.uv || {}).filter(k => !ex.has(k)).length,
    runDays,
    launchDate: SITE_LAUNCH
  };
}

// 流量构成聚合（只给后台，不进 /api/site-stats —— 来路域名不该公开）。
// 取最近 7 天而不是全量：来路结构变化快，90 天累计会把早期外宣期的数据一直压在头上。
const TRAFFIC_WINDOW_DAYS = 7;
function trafficStats() {
  const days = visits.days || {};
  const keys = Object.keys(days).sort().slice(-TRAFFIC_WINDOW_DAYS);
  const refs = {}, devs = {}, land = {};
  let miniPv = 0;
  const addAll = (dst, src) => {
    if (!src || typeof src !== 'object') return;
    Object.keys(src).forEach(k => { dst[k] = (dst[k] || 0) + (src[k] || 0); });
  };
  keys.forEach(k => {
    const d = days[k] || {};
    addAll(refs, d.refs);
    addAll(devs, d.devs);
    addAll(land, d.land);
    if (d.mini) miniPv += (d.mini.pv || 0);   // 小程序只进设备分布，没有来路/落地页
  });
  const top = (obj, n) => Object.entries(obj)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
  return {
    window: TRAFFIC_WINDOW_DAYS,
    days: keys.length,
    since: keys[0] || '',
    visits: Object.values(refs).reduce((s, n) => s + n, 0),   // 与 refs 同口径的网页访问数
    refs: top(refs, 8),
    devs: {
      mobile: devs.mobile || 0,
      desktop: devs.desktop || 0,
      wechat: devs.wechat || 0,
      tablet: devs.tablet || 0,
      bot: devs.bot || 0,
      unknown: devs.unknown || 0,
      mini: miniPv
    },
    // 作品详情页的落地量比首页更有意义：直接标上作品名，不然看一屏 /w/xxx 认不出是谁
    landings: top(land, 8).map(e => {
      const m = e.name.match(/^\/w\/([A-Za-z0-9_-]+)/);
      const w = m && works.find(x => x.id === m[1]);
      return { path: e.name, count: e.count, label: w ? w.title : '' };
    })
  };
}

// ---------- 外宣渠道统计（外宣包链接带 ?fr=<平台key>，落地时前端上报一次） ----------
// 结构：{ 'v2ex': { pv: 12, uv: { 'u:<userId>': 1, 'ip:<ip>': 1 }, works: { '<workId>': 3 }, lastAt: '...' } }
const promoVisits = (() => {
  const raw = readJSON('promo-visits.json', {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
})();

let promoVisitSaveTimer = null;
function schedulePromoVisitSave() {
  if (promoVisitSaveTimer) return;
  promoVisitSaveTimer = setTimeout(() => {
    promoVisitSaveTimer = null;
    try { writeJSON('promo-visits.json', promoVisits); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

function trackPromoVisit(req, key, workId) {
  const k = normFrKey(key);   // ?fr=vx 和 ?fr=v2ex 归到同一个渠道
  if (!k) return false;
  recordChannelTouch(req, k);
  const rec = promoVisits[k] || (promoVisits[k] = { pv: 0, uv: {}, works: {}, lastAt: '', regs: 0 });
  if (!rec.uv) rec.uv = {};
  if (!rec.works) rec.works = {};
  if (!rec.regs) rec.regs = 0;
  rec.pv = (rec.pv || 0) + 1;
  const user = currentUser(req);
  rec.uv[user ? 'u:' + user.id : 'ip:' + clientIp(req)] = 1;
  if (workId && works.some(w => w.id === workId)) rec.works[workId] = (rec.works[workId] || 0) + 1;
  rec.lastAt = new Date().toISOString();
  schedulePromoVisitSave();
  return true;
}

// 后台展示：平台名从 promo-guide.js 取，指南没收的渠道用常见中文名兜底，再不行原样显示 key
const FR_NAMES = {
  xhs: '小红书', zhihu: '知乎', bilibili: 'B站', weibo: '微博', douyin: '抖音',
  wechat: '微信', twitter: 'X（推特）', x: 'X（推特）', reddit: 'Reddit',
  wechatmoments: '朋友圈', friend: '熟人转发', share: '站内分享', other: '其他'
};
// 渠道 key：投放链接的 ?fr= 和活动兑换码前缀共用同一套命名。
// 为了短，常用渠道用 2 个字母（VX / GZ …），这里统一归一到标准 key，统计口径才不会散成两套。
const FR_CANON = {
  vx: 'v2ex', v2ex: 'v2ex',
  gz: 'wechat', wx: 'wechat', wechat: 'wechat',
  zh: 'zhihu', zhihu: 'zhihu',
  xh: 'xhs', xhs: 'xhs',
  bl: 'bilibili', bilibili: 'bilibili',
  jk: 'jike', jike: 'jike',
  sp: 'sspai', sspai: 'sspai',
  xm: 'appinn', appinn: 'appinn',
  ph: 'producthunt', producthunt: 'producthunt',
  hn: 'hn', tw: 'twitter', twitter: 'twitter',
  wb: 'weibo', weibo: 'weibo', dy: 'douyin', douyin: 'douyin'
};
// 生成兑换码时用的前缀（反向映射）：标准 key → 2 个大写字母
const FR_SHORT = {
  v2ex: 'VX', wechat: 'GZ', zhihu: 'ZH', xhs: 'XH', bilibili: 'BL', jike: 'JK',
  sspai: 'SP', appinn: 'XM', producthunt: 'PH', hn: 'HN', twitter: 'TW', weibo: 'WB', douyin: 'DY'
};
function normFrKey(s) {
  const k = String(s || '').trim().toLowerCase().slice(0, 24);
  if (!/^[a-z0-9_-]{2,24}$/.test(k)) return '';
  return FR_CANON[k] || k;
}
function frShortOf(key) { return FR_SHORT[key] || String(key || '').slice(0, 2).toUpperCase(); }
// 从兑换码本身认渠道：只有「XX-」开头的批量码才认，DM 是没配渠道的默认前缀
function frOfGiftCode(code) {
  const raw = String(code || '').trim();
  if (!/^[A-Za-z0-9]{2}-/.test(raw)) return '';
  const p = raw.slice(0, 2).toLowerCase();
  if (p === 'dm') return '';
  return FR_CANON[p] || (/^[a-z0-9]{2}$/.test(p) ? p : '');
}
function frNameOf(key) {
  const k = String(key || '');
  const p = PLATFORMS.find(x => x.key === k);
  return p ? String(p.name).split(' · ')[0] : (FR_NAMES[k] || k);
}
// 记「这台机器是从哪个渠道来的」。不带作者归属也认 —— 自己投放的链接通常只有 ?fr=v2ex 而没有 ref。
// 只记 7 天内的首触，注册时落成用户身上的 acqFr。
function recordChannelTouch(req, key) {
  const k = normFrKey(key);
  if (!k) return '';
  const ip = ipRecOf(ipKeyOf(req));
  const now = Date.now();
  if (!ip.attrCh || now - ip.attrCh.at > SHARE_ATTR_DAYS * 86400e3) {
    ip.attrCh = { key: k, at: now };
    saveShareSoon();
  }
  return k;
}

function promoStatsForAdmin() {
  // 用户身上记的首触渠道（acqFr）：链接带来的、兑换码带来的都算，口径一致
  const fromCount = {};
  users.forEach(u => { if (u.acqFr) fromCount[u.acqFr] = (fromCount[u.acqFr] || 0) + 1; });
  return Object.entries(promoVisits).map(([key, r]) => ({
    key,
    name: frNameOf(key),
    pv: r.pv || 0,
    uv: Object.keys(r.uv || {}).length,
    regs: r.regs || 0,
    redeems: r.redeems || 0,          // 从这个渠道的兑换码领取的人数（含未走链接的老用户）
    fromUsers: fromCount[key] || 0,   // 首触渠道被记为它、且从没换过渠道的用户数
    works: Object.keys(r.works || {}).length,
    lastAt: r.lastAt || ''
  })).sort((a, b) => b.pv - a.pv);
}

// ---------- 作品维度访问统计（每个作品的 PV / UV） ----------
// 结构：{ '<workId>': { pv: 12, uv: { 'u:<userId>': 1, 'ip:<ip>': 1 }, days: { '2026-10-31': { pv: 3, uv: {...} } } } }
const workVisits = (() => {
  const raw = readJSON('work-visits.json', {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
})();

let workVisitSaveTimer = null;
function scheduleWorkVisitSave() {
  if (workVisitSaveTimer) return;
  workVisitSaveTimer = setTimeout(() => {
    workVisitSaveTimer = null;
    try { writeJSON('work-visits.json', workVisits); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// 浏览数是跟着访问一起涨的，同样节流落盘（每次打开都同步写 works.json 太重）
let worksSaveTimer = null;
function scheduleWorksSave() {
  if (worksSaveTimer) return;
  worksSaveTimer = setTimeout(() => {
    worksSaveTimer = null;
    try { saveWorks(); } catch (e) { /* 同上 */ }
  }, 3000);
}

// ---------- 反刷闸门 ----------
// 统计不是账本，但被刷高了会误导作者、也会污染榜单排序，所以在埋点入口就把闸立住
const WORK_PV_PER_IP_HOUR = 30;              // 同一 IP 对同一作品，每小时最多计 30 次 PV
const WORK_PV_PER_IP_DAY = 100;              // 同一 IP 对同一作品，每天最多计 100 次 PV
const WORK_UV_ACCOUNTS_PER_IP = 3;           // 同一 IP 对同一作品，每天最多 3 个账号能贡献 UV
const UV_MIN_ACCOUNT_AGE = 24 * 3600 * 1000; // 注册不足 24 小时算「新号」
const WORK_UV_NEWBIES_PER_DAY = 10;          // 新号照常计 UV，但每个作品每天最多收 10 个新号 UV

// 仅当天配额用，重启即丢：{ '<workId>|<日期>': Map<ipHash, Set<userId>> }
const uvIpAccounts = new Map();
function uvAccountAllowed(workId, ipHash, userId) {
  const dk = dateKey();
  if (uvIpAccounts.size > 5000) {
    for (const k of uvIpAccounts.keys()) if (!k.endsWith('|' + dk)) uvIpAccounts.delete(k);
  }
  const key = workId + '|' + dk;
  let m = uvIpAccounts.get(key);
  if (!m) { m = new Map(); uvIpAccounts.set(key, m); }
  let set = m.get(ipHash);
  if (!set) { set = new Set(); m.set(ipHash, set); }
  if (set.has(userId)) return true;                       // 同一账号重复浏览不占配额
  if (set.size >= WORK_UV_ACCOUNTS_PER_IP) return false;   // 这台设备当天已换够 3 个号
  set.add(userId);
  return true;
}

// 新号 UV 当日配额：{ '<workId>|<日期>': 已收新号数 }
const uvNewbieOfDay = new Map();
function uvNewbieAllowed(workId) {
  const dk = dateKey();
  if (uvNewbieOfDay.size > 5000) {
    for (const k of uvNewbieOfDay.keys()) if (!k.endsWith('|' + dk)) uvNewbieOfDay.delete(k);
  }
  const key = workId + '|' + dk;
  const n = uvNewbieOfDay.get(key) || 0;
  if (n >= WORK_UV_NEWBIES_PER_DAY) return false;
  uvNewbieOfDay.set(key, n + 1);
  return true;
}

function trackWorkVisit(req, workId, opts) {
  const o = opts || {};
  const mini = o.platform === 'mini';
  const w = workId && works.find(x => x.id === workId);
  if (!w) return;
  const user = currentUser(req);
  // 作者打开自己的作品不计数：预览几次就能给自己刷出 PV / UV，作者会误判有人在看
  if (user && w.userId && w.userId === user.id) return;
  // 真实浏览器都带 UA；脚本直连（curl / python requests）默认没有，直接丢
  // 小程序 wx.request 的 UA 带 MicroMessenger，正常通过
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(ua)) return;
  const ipHash = ipKeyOf(req);
  // 小程序按 deviceId 限频（NAT 后同一 IP 可能是几百人，按 IP 限会把正常访问也挡掉）
  const rateKey = mini && o.deviceId ? 'd:' + o.deviceId : ipHash;
  // 单 IP（小程序为单设备）单作品的 PV 频次上限：挡住一台机器循环刷新
  if (!rateLimit('wv:' + workId + ':' + rateKey, WORK_PV_PER_IP_HOUR, 3600000)) return;
  if (!rateLimit('wvd:' + workId + ':' + rateKey, WORK_PV_PER_IP_DAY, 86400000)) return;

  // 浏览数（卡片/详情/SEO 都读这个）只从这条门里涨：
  // 经过作者过滤、UA 校验和频次限制的有效访问才 +1，不再跟着接口调用涨，
  // 所以「浏览数」和「访问次数」是同一个口径，不会出现两个对不上的数字。
  w.views = (w.views || 0) + 1;
  scheduleWorksSave();

  const rec = workVisits[workId] || (workVisits[workId] = { pv: 0, uv: {}, days: {} });
  if (!rec.uv) rec.uv = {};
  if (!rec.days) rec.days = {};
  rec.pv = (rec.pv || 0) + 1;

  // UV：登录按账号去重，未登录按 IP 去重。换号刷量主要靠新注册号 + 同一台设备，两头都限量
  let vid = '';
  let countUv = true;
  if (user) {
    vid = 'u:' + user.id;
    // 小程序不做 IP 维度的换号配额：小程序账号绑微信、设备也有限频，NAT 后按 IP 卡会误伤正常用户
    if (!mini) {
      if (!uvAccountAllowed(workId, ipHash, user.id)) countUv = false;       // 同 IP 当天第 4 个号起只计 PV
      if (countUv && Date.now() - new Date(user.createdAt || 0).getTime() < UV_MIN_ACCOUNT_AGE &&
          !uvNewbieAllowed(workId)) countUv = false;                          // 新号限量：作品当日新号 UV 收满 10 个后只计 PV
    }
  } else {
    // 小程序没有 IP 可用（NAT 共享），改用本地 deviceId；网页端保持按 IP 去重
    vid = mini && o.deviceId ? 'd:' + o.deviceId : 'ip:' + clientIp(req);
  }

  const dk = dateKey();
  const day = rec.days[dk] || (rec.days[dk] = { pv: 0, uv: {} });
  if (!day.uv) day.uv = {};
  day.pv = (day.pv || 0) + 1;
  if (countUv) { rec.uv[vid] = 1; day.uv[vid] = 1; }
  // 每个作品只保留最近 N 天明细
  const keys = Object.keys(rec.days).sort();
  while (keys.length > VISIT_RETENTION_DAYS) delete rec.days[keys.shift()];
  scheduleWorkVisitSave();
}

function workVisitStats(workId) {
  const rec = workVisits[workId];
  if (!rec) return { pv: 0, uv: 0, pvToday: 0, uvToday: 0 };
  const today = (rec.days && rec.days[dateKey()]) || { pv: 0, uv: {} };
  return {
    pv: rec.pv || 0,
    uv: Object.keys(rec.uv || {}).length,
    pvToday: today.pv || 0,
    uvToday: Object.keys(today.uv || {}).length
  };
}

// 榜单用：作品在周期内的 PV / UV（days=36500 表示全部）
function workPvUv(workId, days) {
  const rec = workVisits[workId];
  if (!rec) return { pv: 0, uv: 0 };
  if (days >= 36500) return { pv: rec.pv || 0, uv: Object.keys(rec.uv || {}).length };
  const from = dateKey(new Date(Date.now() - days * 86400000));
  let pv = 0; const uvSet = new Set();
  Object.entries(rec.days || {}).forEach(([k, d]) => {
    if (k < from) return;
    pv += d.pv || 0;
    Object.keys(d.uv || {}).forEach(x => uvSet.add(x));
  });
  return { pv, uv: uvSet.size };
}

// ---------- 体验动作埋点（访问 / 下载 / 扫码意图） ----------
// 浏览量只回答「多少人看到了」，回答不了「多少人真的去用了」。
// 所以按动作分开记：visit=点开网站/网页版，download=点商店或安装包，scan=看/存小程序码。
// 小程序真正的扫码发生在微信里、站外，网页侧只能记「扫码意图」，所以单独放 scan，绝不和 visit 混算。
const WORK_ACTION_RETENTION_DAYS = 90;
const WORK_ACTION_PER_IP_HOUR = 60;          // 同一 IP 对同一作品同一动作，每小时最多计 60 次
// visit/download = 真点了按钮；scan = 真扫码（短链落地，服务器亲眼看到）；scan_intent = 小程序码被点开看/存（意图下限）
const WORK_ACTIONS = ['visit', 'download', 'scan', 'scan_intent'];
let workActions = (() => {
  const raw = readJSON('work-actions.json', {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const from = dateKey(new Date(Date.now() - WORK_ACTION_RETENTION_DAYS * 86400000));
  const out = {};
  for (const [id, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    const days = {};
    for (const [k, d] of Object.entries(rec.days || {})) {
      if (k < from && d && typeof d === 'object') continue;
      if (d && typeof d === 'object') {
        // 旧版本把「扫码意图」记在 scan 上；新版 scan 只算真实扫码，一次性改名，避免两个口径糊在一起
        if (d.scan && d.scan_intent === undefined) { d.scan_intent = d.scan; d.scan = 0; }
        days[k] = d;
      }
    }
    const item = {
      visit: Number(rec.visit) || 0, download: Number(rec.download) || 0,
      scan: Number(rec.scan) || 0, scan_intent: Number(rec.scan_intent) || 0,
      byType: rec.byType && typeof rec.byType === 'object' ? rec.byType : {}, days
    };
    // 旧数据顶层 scan 也是「意图」口径：总量同理迁到 scan_intent
    if (item.scan && item.scan_intent === 0) { item.scan_intent = item.scan; item.scan = 0; }
    if (item.visit || item.download || item.scan || item.scan_intent || Object.keys(days).length) out[id] = item;
  }
  return out;
})();

let workActionSaveTimer = null;
function scheduleWorkActionSave() {
  if (workActionSaveTimer) return;
  workActionSaveTimer = setTimeout(() => {
    workActionSaveTimer = null;
    try { writeJSON('work-actions.json', workActions); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

function bumpWorkAction(workId, action, type) {
  const rec = workActions[workId] || (workActions[workId] = { visit: 0, download: 0, scan: 0, scan_intent: 0, byType: {}, days: {} });
  if (!rec.byType) rec.byType = {};
  if (!rec.days) rec.days = {};
  rec[action] = (rec[action] || 0) + 1;
  const dk = dateKey();
  const day = rec.days[dk] || (rec.days[dk] = {});
  day[action] = (day[action] || 0) + 1;
  // 记下入口形态（iOS / Android / 官网…），键带动作前缀（scan:iOS / visit:官网）——
  // 不带前缀的话「官网 3」分不清是点开的还是扫进来的，作者看不出哪个渠道真有人用
  const t = String(type || '').slice(0, 20);
  if (t) {
    const k = action + ':' + t;
    rec.byType[k] = (rec.byType[k] || 0) + 1;
  }
  const keys = Object.keys(rec.days).sort();
  while (keys.length > WORK_ACTION_RETENTION_DAYS) delete rec.days[keys.shift()];
  scheduleWorkActionSave();
}

function trackWorkAction(req, workId, action, type) {
  if (!WORK_ACTIONS.includes(action)) return;
  const w = workId && works.find(x => x.id === workId);
  if (!w) return;
  const user = currentUser(req);
  // 作者自己点按钮不算：自己试几次就能刷出几十个「访问」，会误判有人在用
  if (user && w.userId && w.userId === user.id) return;
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(ua)) return;
  const ipHash = ipKeyOf(req);
  if (!rateLimit('wa:' + workId + ':' + action + ':' + ipHash, WORK_ACTION_PER_IP_HOUR, 3600000)) return;
  bumpWorkAction(workId, action, type);
}

// 作者看板用：动作累计；传 days（如 7）则只算最近 N 天
function workActionStats(workId, days) {
  const rec = workActions[workId] || {};
  if (!days || days >= 36500) {
    return {
      visit: rec.visit || 0, download: rec.download || 0,
      scan: rec.scan || 0, scan_intent: rec.scan_intent || 0,
      // 入口构成（官网 / iOS / Android…各被点了几次），给作者看「哪个形态真有人用」
      byType: Object.assign({}, rec.byType || {})
    };
  }
  const from = dateKey(new Date(Date.now() - days * 86400000));
  const out = { visit: 0, download: 0, scan: 0, scan_intent: 0 };
  Object.entries(rec.days || {}).forEach(([k, d]) => {
    if (k < from || !d) return;
    WORK_ACTIONS.forEach(a => { out[a] += d[a] || 0; });
  });
  return out;
}

// ---------- 站内搜索词：大家到底在找什么 ----------
// 只回答「大家在找什么」，不认人：不存 IP、不存账号，只留 词 / 次数 / 0 结果次数 / 最近时间。
// 数据来源是 /api/works?q= 真正执行搜索的那一刻，顺手记下命中条数——
// 「搜到了但没有结果」比「搜得多」更有价值：它直接告诉我们站里缺哪类作品。
const SEARCH_LOG_RETENTION_DAYS = 180;
const SEARCH_KW_MAX = 600;             // 最多留 600 个不同词，超出按「冷 + 少」淘汰
const SEARCH_KW_PER_IP_HOUR = 200;     // 单 IP 每小时上报上限，防刷热词
const SEARCH_KW_REPEAT_HOUR = 2;       // 同一 IP 同一个词每小时最多记 2 次（反复刷新不重复计数）
const SEARCH_KW_MAXLEN = 30;

function normSearchQ(q) {
  return String(q || '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_KW_MAXLEN);
}

let searchLog = (() => {
  const raw = readJSON('search-log.json', {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const from = dateKey(new Date(Date.now() - SEARCH_LOG_RETENTION_DAYS * 86400000));
  const out = {};
  for (const [k, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    const days = {};
    for (const [d, n] of Object.entries(rec.days || {})) if (d >= from) days[d] = Number(n) || 0;
    const n = Number(rec.n) || 0;
    if (!n) continue;
    out[k] = { w: String(rec.w || k).slice(0, SEARCH_KW_MAXLEN), n, zero: Number(rec.zero) || 0, last: rec.last || '', days };
  }
  return out;
})();

let searchLogTimer = null;
function scheduleSearchLogSave() {
  if (searchLogTimer) return;
  searchLogTimer = setTimeout(() => {
    searchLogTimer = null;
    try { writeJSON('search-log.json', searchLog); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// delta 允许传 -1：用来撤掉「边打边搜」留下的半截词
function bumpSearch(key, word, hits, delta) {
  const rec = searchLog[key] || (searchLog[key] = { w: word, n: 0, zero: 0, last: '', days: {} });
  if (!rec.days) rec.days = {};
  if (word) rec.w = word;
  rec.n = Math.max(0, (rec.n || 0) + delta);
  const dk = dateKey();
  rec.days[dk] = Math.max(0, (rec.days[dk] || 0) + delta);
  if (!rec.days[dk]) delete rec.days[dk];
  if (!hits) rec.zero = Math.max(0, (rec.zero || 0) + delta);   // 命中 0 条单独计数
  if (delta > 0) rec.last = new Date().toISOString();
  if (rec.n <= 0) { delete searchLog[key]; return; }
  const ks = Object.keys(rec.days).sort();
  while (ks.length > SEARCH_LOG_RETENTION_DAYS) delete rec.days[ks.shift()];
}

function trimSearchLog() {
  const keys = Object.keys(searchLog);
  if (keys.length <= SEARCH_KW_MAX) return;
  // 先淘汰「搜得少且很久没出现」的长尾，热门词不动
  keys.sort((a, b) => (searchLog[a].n || 0) - (searchLog[b].n || 0)
    || String(searchLog[a].last || '').localeCompare(String(searchLog[b].last || '')));
  keys.slice(0, keys.length - SEARCH_KW_MAX).forEach(k => { delete searchLog[k]; });
}

// 内存里记「这个 IP 上一次搜的词」，只用于合并输入过程中的前缀，不落盘
const searchPrevByIp = new Map();

function logSearch(req, q, hits) {
  const word = normSearchQ(q);
  if (!word) return;
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(ua)) return;   // 脚本 / 爬虫不算「人」
  const ip = ipKeyOf(req);
  if (!rateLimit('sk:' + ip, SEARCH_KW_PER_IP_HOUR, 3600000)) return;
  const key = word.toLowerCase();
  if (!rateLimit('skw:' + ip + ':' + key, SEARCH_KW_REPEAT_HOUR, 3600000)) return;

  // 边打边搜：先搜「小」再搜「小程序」，前一次只是中间态——扣掉它，否则热词榜全是半截词
  const prev = searchPrevByIp.get(ip);
  if (prev && Date.now() - prev.t < 150000 && prev.key !== key
      && key.startsWith(prev.key) && searchLog[prev.key]) {
    bumpSearch(prev.key, prev.word, prev.hits, -1);
  }
  bumpSearch(key, word, hits, 1);
  trimSearchLog();
  if (searchPrevByIp.size > 5000) searchPrevByIp.clear();
  searchPrevByIp.set(ip, { key, word, hits, t: Date.now() });
  scheduleSearchLogSave();
}

// 后台统计：Top N + 今日 / 近 7 天总量 + 「0 结果」次数（缺内容的信号）
function searchStatsForAdmin(limit = 30) {
  const today = dateKey();
  const weekAgo = dateKey(new Date(Date.now() - 6 * 86400000));
  let todayN = 0, weekN = 0;
  const rows = Object.entries(searchLog).map(([k, r]) => {
    let n7 = 0;
    Object.entries(r.days || {}).forEach(([d, n]) => { if (d >= weekAgo) n7 += n; });
    todayN += (r.days && r.days[today]) || 0;
    weekN += n7;
    return { q: r.w || k, n: r.n, zero: r.zero || 0, last: r.last || '', n7 };
  });
  rows.sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last)));
  return {
    total: rows.reduce((s, r) => s + r.n, 0),
    todayN, weekN, words: rows.length,
    top: rows.slice(0, limit)
  };
}

// ---------- 大家最近在搜（前台热搜榜） ----------
// 两路数据物理隔离：真实搜索写 search-log.json（后台统计只看这一份，永远干净），
// 冷启动种子放 search-seed.json（站里真实搜索只有个位数时撑住榜单，真实词累积够了自然顶上去）。
// 关掉种子（enabled:false）榜单就退回纯真实数据，不需要改代码。
let hotSearchCache = { at: 0, items: null };

function readSearchSeed() {
  try {
    const raw = readJSON('search-seed.json', null);
    if (!raw || raw.enabled === false || !Array.isArray(raw.words)) return [];
    return raw.words.filter(x => x && x.w).slice(0, 120);
  } catch (e) { return []; }
}

function hotSearches(limit = 10) {
  const now = Date.now();
  if (!hotSearchCache.items || now - hotSearchCache.at > 60000) {
    const weekAgo = dateKey(new Date(now - 6 * 86400000));
    // 分类词不进榜：搜「效率工具」「生活助手」这类栏目名只是想逛分类，不是真实需求，
    // 混进榜单会把真正的需求词挤下去（分类入口首页本来就有）
    const catSet = new Set(categories.map(c => String(c).trim().toLowerCase()).filter(Boolean));
    const map = new Map();
    const put = (w, n, n7, zero, last, real, trend) => {
      const key = String(w).toLowerCase();
      const cur = map.get(key);
      if (cur) {
        cur.n += n; cur.n7 += n7; cur.zero += zero;
        if (real) cur.real = true;
        if (trend) cur.trend = trend;
        if (last > cur.last) cur.last = last;
      } else {
        map.set(key, { w: String(w), n, n7, zero, last: last || '', real: !!real, trend: trend || '' });
      }
    };

    readSearchSeed().forEach((s) => {
      // 搜索日志里出现过的词一律以真实数据为准，种子同词只做历史基数累加
      const w = normSearchQ(s.w);
      const n = Math.max(0, parseInt(s.n, 10) || 0);
      if (!w || !n) return;
      put(w, n, Math.min(n, Math.max(0, parseInt(s.n7, 10) || 0)), Math.min(n, Math.max(0, parseInt(s.zero, 10) || 0)), '', false,
        s.trend === 'up' || s.trend === 'new' ? s.trend : '');
    });

    Object.entries(searchLog).forEach(([k, r]) => {
      let n7 = 0;
      Object.entries(r.days || {}).forEach(([d, v]) => { if (d >= weekAgo) n7 += v; });
      put(r.w || k, r.n || 0, n7, r.zero || 0, r.last ? String(r.last) : '', true, '');
    });

    const items = [];
    for (const v of map.values()) {
      const w = String(v.w || '').trim().slice(0, 14);
      // 单字和整句都不进榜：榜单要一眼扫完的词
      if (!w || w.length < 2 || !/[\u4e00-\u9fa5a-zA-Z]/.test(w)) continue;
      if (catSet.has(w.toLowerCase())) continue;   // 分类词（效率工具/生活助手…）不进榜
      let trend = v.trend || '';
      if (v.real && v.last) {
        const age = now - new Date(v.last).getTime();
        if (v.n <= 30 && age < 48 * 3600e3) trend = 'new';
        else if (v.n >= 12 && v.n7 / v.n >= 0.72) trend = 'up';
      }
      items.push({ w, n: v.n, n7: v.n7, zero: v.zero, trend, real: v.real });
    }
    items.sort((a, b) => b.n - a.n || a.w.localeCompare(b.w));
    hotSearchCache = { at: now, items };
  }
  return {
    total: hotSearchCache.items.length,
    items: hotSearchCache.items.slice(0, limit),
    updatedAt: new Date(hotSearchCache.at).toISOString(),
  };
}

// ---------- 扫码短链：把「扫码」变成可数的真实动作 ----------
// 小程序码的载荷是加密的（解不出网址），扫码动作又发生在微信里，网页侧拿不到；
// 所以给「有链接的作品」自动生成一张自家短链码：扫码先落到 /go/<code>，服务端记一次真实扫码，
// 再 302 到真正的目标地址。码上编的是我们的网址，不依赖第三方统计，也不会和浏览量混算。
function shortCodeOf(workId, t) {
  return crypto.createHash('sha1').update(workId + '|' + (t || 'auto')).digest('hex').slice(0, 10);
}
// 扫码目标：官网优先，然后每个填了链接的形态各一个（顺序和详情页按钮一致）
function qrTargetsOf(w) {
  const out = [];
  const site = String(w.site || '').trim();
  if (site) out.push({ t: 'site', url: site });
  const types = typesOf(w);
  const miniOnly = types.length > 0 && types.every(t => t === '小程序');
  let any = false;
  types.forEach(t => {
    const u = String((w.links && w.links[t]) || '').trim();
    if (u) { out.push({ t, url: u }); any = true; }
  });
  // 纯小程序作品的 link 是「了解详情」网页、不是使用入口，给它生成码会误导，跳过
  if (!any && w.link && !miniOnly) out.push({ t: types[0] || '其他', url: String(w.link).trim() });
  return out;
}
// 详情页要展示的码：作者自己上传的码优先（小程序只能用它）；否则用自动短链码，扫码可数。
// targets：每个入口形态各一张码（官网/iOS/Android…），详情页可以切换——
// 只给第一个入口出码的话，其余形态的扫码永远数不到，等于白做
function workQrOf(w) {
  if (w.qrcode) return { src: w.qrcode, real: false, mini: true, targets: [] };
  const targets = qrTargetsOf(w).map(e => {
    const code = shortCodeOf(w.id, e.t);
    return { t: e.t, code, src: '/qr/' + code + '.png' };
  });
  if (!targets.length) return { src: '', real: false, mini: false, targets: [] };
  const first = targets[0];
  return { src: first.src, real: true, mini: false, code: first.code, targets };
}
// 分享卡片默认落在「本站详情页」：仍然走 /go 短链（扫码人数和分享者灯火都靠这一跳），
// 只是 302 的目标换成 /w/<id>，不把扫码的人直接送去作者的外部站点。
// 单独用 'detail' 这个 t，别和详情页自己的入口码（官网/iOS/Android）混用，否则同一个 code 两个落地目标。
function detailCodeOf(w) {
  return shortCodeOf(w.id, 'detail');
}

// code → { workId, t, url }。带 60s 缓存，作者改完链接最多一分钟内生效，不必每次遍历作品
let shortIndex = null, shortIndexAt = 0;
function shortIndexMap(force) {
  const now = Date.now();
  if (!force && shortIndex && now - shortIndexAt < 60000) return shortIndex;
  const m = new Map();
  for (const w of works) {
    if (w.deleted) continue;
    for (const e of qrTargetsOf(w)) m.set(shortCodeOf(w.id, e.t), { workId: w.id, t: e.t, url: e.url });
    // 分享卡片的「详情页」码：没有外链的作品也要能记扫码，所以不挂在 qrTargetsOf 上单独索引
    m.set(detailCodeOf(w), { workId: w.id, t: 'detail', url: '' });
  }
  shortIndex = m;
  shortIndexAt = now;
  return m;
}
function siteOrigin(req) {
  const env = String(process.env.SITE_ORIGIN || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}
function qrMissPage(msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>链接已失效 · 造梦橱窗</title>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;text-align:center;padding:64px 24px;color:#111">
<div style="font-size:44px">🪟</div>
<h2 style="margin:16px 0 8px;font-size:18px">${msg}</h2>
<p style="color:#888;font-size:14px;line-height:1.7">可能是作者换了链接，或作品已下架。<br>回站内看看别的作品吧。</p>
<p style="margin-top:24px"><a href="/" style="color:#6b5cff;font-size:14px">打开造梦橱窗 →</a></p>
</body>`;
}

// 扫码落地与短链码图片这两条路由需要 app 实例，注册在下面「访问统计」那一段（/api/track 旁边）

// ---------- 收藏时间日志（「本周收藏最多」用） ----------
// user.favs 里只有作品 id、没有时间，无法反推「本周新增」，
// 所以收藏动作单独记一条：{ workId, userId, t }，只保留最近 180 天。
const FAV_LOG_RETENTION_DAYS = 180;
let favLog = (() => {
  const raw = readJSON('fav-log.json', []);
  if (!Array.isArray(raw)) return [];
  const from = Date.now() - FAV_LOG_RETENTION_DAYS * 86400000;
  return raw.filter(e => e && typeof e.workId === 'string' && typeof e.t === 'number' && e.t >= from);
})();
let favLogTimer = null;
function scheduleFavLogSave() {
  if (favLogTimer) return;
  favLogTimer = setTimeout(() => {
    favLogTimer = null;
    try { writeJSON('fav-log.json', favLog); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 1500);
}
// on=true 记一次收藏，on=false 撤掉这个人对这件作品的收藏记录
function logFav(workId, userId, on) {
  favLog = favLog.filter(e => !(e.workId === workId && e.userId === userId));
  if (on) favLog.push({ workId, userId, t: Date.now() });
  scheduleFavLogSave();
}

// ---------- 分享归因与积分奖励 ----------
// 分享链接形如 /w/<id>?ref=<账号名>。访客打开后按「IP + 分享者 + 作品 + 当天」去重，
// 计一次有效分享访问；被邀请人注册再计一次邀请注册。
// 所有去重都落在 IP 维度：换浏览器、清缓存、开无痕都不会重复加分（这是防刷的关键）。
const SHARE_VISIT_POINTS = 1;        // 一次有效分享访问
const SHARE_REG_POINTS = 100;        // 网页端一个有效邀请注册（冷启动阶段加大激励）
const SHARE_REG_POINTS_MINI = 10;    // 小程序内建号的邀请注册：微信一键建号几乎零成本，激励降到 1/10（2026-11-06 站长定）

// ---- 访问奖励：不设每日上限 ----
// 「满 50 就停」会打击真正带量的人：一个大 V 一天带 2000 次访问也只能拿 50 盏，
// 而且是静默停的 —— 用户只看到「我分享了怎么没加分」。所以这里改成：每次有效访问 +1，不封顶。
// 那刷分怎么办？靠「同一个人不重复计」，不靠「你最多只能拿多少」：
//   · 登录用户：同一账号 + 同一作品终身只计一次（rec.pairs）
//   · 游客：同 IP + 同分享者 + 同作品 + 当天只计一次（ip.v）
//   · 同一 IP 对同一分享者每天最多 3 次、同一 IP 全站每天最多 30 次（ip.d / ip.t）
// 唯一保留的是熔断线：单日访问计数超过 5000 次就停止计分 —— 那已经不是人能干出来的量，
// 只可能是脚本或统计异常；正常作者（哪怕百万粉）一天也就几百到一两千次。
const SHARE_VISIT_CIRCUIT = 5000;    // 单日访问熔断：超过只记访问、不再计分

const SHARE_DAILY_REGS = 5;          // 每人每天最多计 5 个邀请注册（网页 100 盏/个、小程序 10 盏/个，这是唯一真正「印钞」的口子）
const SHARE_DAILY_REG_POINTS = 500;  // 旧口径（= 5 次 × 100），仅用于历史数据展示，不再参与判定
const SHARE_IP_PER_REF_DAY = 3;      // 同一 IP 对同一分享者：每天最多计 3 次访问
const SHARE_IP_TOTAL_DAY = 30;       // 同一 IP 在全站：每天最多计 30 次访问（原来 10 次会误伤公司/校园 NAT 下的真实粉丝）
const SHARE_IP_MAX_REGS = 2;         // 同一 IP 最多计 2 个邀请注册（防同屋批量注册）
const SHARE_IP_REF_MAX_REGS = 1;     // 同一 IP 对同一分享者最多计 1 个邀请注册
const SHARE_ATTR_DAYS = 7;           // 点击后 7 天内注册才算归因
const SHARE_LOG_MAX = 60;
const SHARE_RETENTION_DAYS = 120;    // IP 明细保留天数（只留去重用的近期记录）

// ---------- 外宣渠道（外宣包 → V2EX / HN 等 8 个平台）的分工 ----------
// 访问：只统计、不计分。外宣包是复制粘贴，作者可以发到自己群里刷，1 分/次会直接变成白拿灯火的口子。
//      取而代之的是「渠道看板」（他能看到哪个平台真的带来了人）+ 一次性里程碑（门槛高，刷不动）。
// 注册：计分，且给渠道加成。注册是要过验证、有同 IP 上限的硬结果，刷不动，正好奖励平台最想要的东西。
const SHARE_PROMO_REG_BONUS = 50;   // 从外宣渠道来的注册，邀请人额外 +50（每个账号只享受一次）
const PROMO_MILESTONE_UV = 100;     // 外宣累计去重来访达到 100 人
const PROMO_MILESTONE_POINTS = 50;  // 一次性里程碑奖励
const SHARE_IP_PROMO_DAY = 10;      // 同一 IP 每天最多计入 10 次外宣来访（独立配额，不挤占站内分享的那 10 次）

// ---------- 扫码灯火（分享卡片上的码走 /go/<code>?ref=<分享者>） ----------
// 扫码是「真的把手机拿出来去用」，意图比点链接强，所以单价比访问（+1）高：
//   · 记「扫码人数」：同 IP + 同作品 + 当天只算 1 个人（换设备/换网络才会再算新的人）
//   · 每个新的扫码人 +3 盏，归分享者（码里带 ref）；自己扫自己的码不计（复用 self 检查）
//   · 同一 IP 每天最多计 10 次扫码分（换作品也刷不动）；扫码还会记 7 天首触，之后注册照常归因
const SHARE_SCAN_POINTS = 3;        // 一个新的扫码人
const SHARE_IP_SCAN_DAY = 10;       // 同一 IP 每天最多计 10 次扫码计分

let shareData = readJSON('share.json', null);
if (!shareData || typeof shareData !== 'object' || Array.isArray(shareData)) shareData = {};
if (!shareData.users || typeof shareData.users !== 'object') shareData.users = {};
if (!shareData.ips || typeof shareData.ips !== 'object') shareData.ips = {};

let shareSaveTimer = null;
function saveShareSoon() {
  if (shareSaveTimer) return;
  shareSaveTimer = setTimeout(() => {
    shareSaveTimer = null;
    try { writeJSON('share.json', shareData); } catch (e) { /* 奖励落盘失败不阻塞主流程 */ }
  }, 2000);
}

// IP 只存哈希：既要按 IP 去重，又不在文件里留明文地址
function ipKeyOf(req) {
  return crypto.createHash('sha256').update('share:' + clientIp(req)).digest('hex').slice(0, 16);
}
// 小程序端没有可信出口 IP（运营商 NAT 后几百人共享一个），访客身份用 deviceId
//（本地生成、随 storage 持久）。返回和 ipKeyOf 同型的桶 key，可互换使用；
// 不是小程序请求（或 deviceId 不合规）返回 null，调用方退回 ipKeyOf。
function miniIpkOf(body) {
  const dId = String((body && body.deviceId) || '').trim();
  if (!body || body.platform !== 'mini' || !/^[A-Za-z0-9_-]{6,64}$/.test(dId)) return null;
  return crypto.createHash('sha256').update('mini:' + dId).digest('hex').slice(0, 16);
}
function shareRecOf(uid) {
  const r = shareData.users[uid] || (shareData.users[uid] = { points: 0, visits: 0, regs: 0, works: {}, byDay: {}, pairs: {}, log: [] });
  if (!r.works) r.works = {};
  if (!r.byDay) r.byDay = {};
  if (!r.pairs) r.pairs = {};
  if (!Array.isArray(r.log)) r.log = [];
  if (!r.promoBy) r.promoBy = {};   // 外宣渠道分布：{ v2ex: 12, hn: 5 }
  if (r.adminPoints == null) r.adminPoints = 0;  // 管理员赠送的灯火累计（分享达人榜要剔除）
  if (r.promoPoints == null) {
    // 一次性补账：老数据没有逐笔分类账，按计数器折算「推广挣来的」灯火
    // （分享访问 +1、邀请注册 +100、外宣渠道注册加成 +50）；此后由加账处增量维护
    r.promoPoints = (r.visits || 0) * SHARE_VISIT_POINTS
      + (r.regs || 0) * SHARE_REG_POINTS
      + (r.promoRegs || 0) * SHARE_PROMO_REG_BONUS;
  }
  return r;
}
// 分享达人榜用的积分：只算用户推广挣来的（分享访问 / 邀请注册 / 外宣里程碑）。
// 系统赠送（管理员调整、开源/上传奖励、签到、兑换码、他人转赠）一律不计——
// 榜单比的是「带来多少真实的人」，不是谁的余额大（余额里大多是人情灯火）。
function boardPointsOf(rec) {
  return Math.max(0, rec.promoPoints || 0);
}
function ipRecOf(ipk) {
  const r = shareData.ips[ipk] || (shareData.ips[ipk] = { v: {}, d: {}, t: {}, regs: 0, refRegs: {}, regIpUsers: [] });
  if (!r.v) r.v = {};
  if (!r.d) r.d = {};
  if (!r.t) r.t = {};
  if (!r.regs) r.regs = 0;
  if (!r.refRegs) r.refRegs = {};
  if (!Array.isArray(r.regIpUsers)) r.regIpUsers = [];
  if (!r.pfDone) r.pfDone = {};   // 这个 IP 已经给哪些作者贡献过「外宣来访人数」，终身一次
  if (!r.pd) r.pd = {};           // 外宣来访的每日次数（独立配额桶，和站内分享的 r.t 分开）
  if (!r.scans) r.scans = {};     // 扫码人数去重：作品|天 -> 1（同一台设备/同一网络对同一作品一天只算 1 个人）
  if (!r.s) r.s = {};             // 扫码计分的每日次数（独立配额，防换作品刷）
  return r;
}
function dayOf(rec) {
  const k = dateKey();
  if (!rec.byDay[k]) rec.byDay[k] = { visits: 0, regs: 0, vp: 0, rp: 0, scans: 0, sp: 0 };
  return rec.byDay[k];
}
function pushShareLog(rec, kind, workId, points) {
  rec.log.unshift({ t: Date.now(), kind, workId: workId || '', points });
  if (rec.log.length > SHARE_LOG_MAX) rec.log.length = SHARE_LOG_MAX;
}
// 清理：IP 明细只保留最近 N 天，避免文件无限膨胀
function pruneShare() {
  const cutoff = dateKey(new Date(Date.now() - SHARE_RETENTION_DAYS * 86400e3));
  Object.keys(shareData.ips).forEach(ipk => {
    const r = shareData.ips[ipk];
    ['v', 'd', 't', 'pd', 's', 'scans'].forEach(f => {
      Object.keys(r[f] || {}).forEach(k => {
        const m = k.match(/(\d{4}-\d{2}-\d{2})$/);
        if (m && m[1] < cutoff) delete r[f][k];
      });
    });
    if (r.attr && r.attr.at && Date.now() - r.attr.at > SHARE_ATTR_DAYS * 86400e3) delete r.attr;
    if (r.attrFr && r.attrFr.at && Date.now() - r.attrFr.at > SHARE_ATTR_DAYS * 86400e3) delete r.attrFr;
    const empty = !Object.keys(r.v).length && !Object.keys(r.d).length && !Object.keys(r.t).length
      && !Object.keys(r.pd || {}).length && !Object.keys(r.pfDone || {}).length
      && !Object.keys(r.s || {}).length && !Object.keys(r.scans || {}).length
      && !r.attr && !r.attrFr && !r.regs;
    if (empty) delete shareData.ips[ipk];
  });
  Object.keys(shareData.users).forEach(uid => {
    const r = shareData.users[uid];
    const keys = Object.keys(r.byDay || {}).sort();
    while (keys.length > SHARE_RETENTION_DAYS) delete r.byDay[keys.shift()];
  });
}

// 记录一次分享访问。返回 { credited, points, reason }
function creditShareVisit(req, refName, workId, ipkOverride) {
  const refUser = resolveShareUser(refName);
  if (!refUser) return { credited: false, reason: 'no_ref' };
  const me = currentUser(req);
  if (me && me.id === refUser.id) return { credited: false, reason: 'self' }; // 自己点自己的链接不算
  const day = dateKey();
  const wk = String(workId || '-');
  // ipkOverride：小程序访客没有可信 IP（运营商 NAT 后几百人共享一个出口），
  // 用 deviceId 哈希替代，去重/限频逻辑完全复用同一套 ip.* 桶
  const ipk = ipkOverride || ipKeyOf(req);
  const ip = ipRecOf(ipk);

  // 记录首次触达（注册归因用）；新的分享者或已过期则覆盖
  if (!ip.attr || ip.attr.uid !== refUser.id || Date.now() - ip.attr.at > SHARE_ATTR_DAYS * 86400e3) {
    ip.attr = { uid: refUser.id, at: Date.now() };
  }

  const rec = shareRecOf(refUser.id);
  // 登录用户：同一作品终身只计一次（换设备也刷不动）
  const pairKey = me ? `u:${me.id}|${wk}` : '';
  if (pairKey && rec.pairs[pairKey]) return { credited: false, reason: 'dup_user' };
  // 游客：同 IP + 同分享者 + 同作品 + 当天只计一次
  const visitKey = `${refUser.id}|${wk}|${day}`;
  if (ip.v[visitKey]) return { credited: false, reason: 'dup_ip' };

  // 同一 IP 对同一分享者、以及全站当天的总量上限
  const perRefKey = `${refUser.id}|${day}`;
  if ((ip.d[perRefKey] || 0) >= SHARE_IP_PER_REF_DAY) return { credited: false, reason: 'limit_ip_ref' };
  if ((ip.t[day] || 0) >= SHARE_IP_TOTAL_DAY) return { credited: false, reason: 'limit_ip_day' };

  // 不设每日上限：每次有效访问 +1；只有越过熔断线才停分（脚本级流量，正常作者碰不到）
  const d = dayOf(rec);
  const idx = (d.visits || 0) + 1;
  let award = SHARE_VISIT_POINTS;
  if (idx > SHARE_VISIT_CIRCUIT) {
    award = 0;
    if (!d.cut) {
      d.cut = idx;
      console.warn(`[share] 单日访问熔断：user=${refUser.id} day=${day} visits=${idx}`);
    }
  }

  ip.v[visitKey] = 1;
  ip.d[perRefKey] = (ip.d[perRefKey] || 0) + 1;
  ip.t[day] = (ip.t[day] || 0) + 1;
  if (pairKey) rec.pairs[pairKey] = 1;

  rec.visits = (rec.visits || 0) + 1;
  rec.works[wk] = (rec.works[wk] || 0) + 1;
  d.visits += 1;
  if (award > 0) {
    rec.points = (rec.points || 0) + award;
    rec.promoPoints = (rec.promoPoints || 0) + award;   // 达人榜只认推广挣的
    d.vp += award;
    pushShareLog(rec, 'visit', wk, award);
  }
  saveShareSoon();
  return { credited: true, points: award, todayVisits: idx, capped: award === 0 };
}

// 扫码落地（/go/<code>[?ref=]）：扫码改记「人数」，不再每次 +1。
// 去重落 IP 维度：同 IP + 同作品 + 当天 = 1 个人；带 ref 时给分享者计灯火（self 检查 + 每日配额）。
function recordScan(req, w, type, refName) {
  // 不像浏览器的请求（脚本批量打码、爬虫扫遍所有短链）不计人数
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(ua)) return;
  const me = currentUser(req);
  // 作者在登录状态下扫自己作品的码：和「作者自己点按钮」同一条规则，不计数
  if (me && w.userId && me.id === w.userId) return;
  const ipk = ipKeyOf(req);
  const ip = ipRecOf(ipk);
  const day = dateKey();
  const key = w.id + '|' + day;
  if (ip.scans[key]) return;        // 这台设备/这个网络今天已经算过这件作品的一个人了
  ip.scans[key] = 1;
  bumpWorkAction(w.id, 'scan', type);
  if (refName) creditScanPoints(req, w, refName, ip, ipk, day);
  saveShareSoon();
}

// 给分享者记扫码灯火。扫码发生在站外、落地即走，注册归因靠 attr 首触（7 天内注册照常算 TA 带来的）。
function creditScanPoints(req, w, refName, ip, ipk, day) {
  const refUser = resolveShareUser(refName);
  if (!refUser) return { credited: false, reason: 'no_ref' };
  const me = currentUser(req);
  if (me && me.id === refUser.id) return { credited: false, reason: 'self' };  // 自己扫自己的码
  if (!ip.attr || ip.attr.uid !== refUser.id || Date.now() - ip.attr.at > SHARE_ATTR_DAYS * 86400e3) {
    ip.attr = { uid: refUser.id, at: Date.now() };
  }
  if ((ip.s[day] || 0) >= SHARE_IP_SCAN_DAY) return { credited: false, reason: 'limit_ip' };
  ip.s[day] = (ip.s[day] || 0) + 1;
  const rec = shareRecOf(refUser.id);
  const d = dayOf(rec);
  rec.points = (rec.points || 0) + SHARE_SCAN_POINTS;
  rec.promoPoints = (rec.promoPoints || 0) + SHARE_SCAN_POINTS;   // 达人榜只认推广挣的
  rec.scans = (rec.scans || 0) + 1;
  rec.works[w.id] = (rec.works[w.id] || 0) + 1;
  d.scans += 1;
  d.sp += SHARE_SCAN_POINTS;
  pushShareLog(rec, 'scan', w.id, SHARE_SCAN_POINTS);
  return { credited: true, points: SHARE_SCAN_POINTS };
}

// 记录一次外宣渠道落地（外宣包文案里的 ?fr=<平台>&ref=<作者>）。
// 只统计、不给访问分：外宣包是复制粘贴，按次给分等于给了一条零成本刷分的路。
// 这里只做两件事：记下「这台机器从哪个渠道来的」（注册加成靠它判断），以及累计去重来访人数。
function creditPromoReach(req, fr, workId, refName) {
  const key = normFrKey(fr);
  if (!key) return { credited: false, reason: 'bad_key' };
  const refUser = resolveShareUser(refName);
  const me = currentUser(req);
  const ip = ipRecOf(ipKeyOf(req));
  const day = dateKey();

  // 记录来路渠道：body 里的 fr 可以伪造，这里记的 attrFr 才是注册加成的判定依据
  if (refUser && (!me || me.id !== refUser.id)) {
    if (!ip.attrFr || ip.attrFr.uid !== refUser.id || Date.now() - ip.attrFr.at > SHARE_ATTR_DAYS * 86400e3) {
      ip.attrFr = { uid: refUser.id, key, at: Date.now() };
      saveShareSoon();
    }
  }
  if (!refUser) return { credited: false, reason: 'no_ref' };
  const known = (shareData.users[refUser.id] || {}).promoVisits || 0;
  if (me && me.id === refUser.id) return { credited: false, reason: 'self', promoVisits: known };  // 自己点自己发的外宣链接
  if (ip.pfDone[refUser.id]) return { credited: false, reason: 'dup', promoVisits: known };        // 同一个 IP 对同一作者只算 1 个人
  if ((ip.pd[day] || 0) >= SHARE_IP_PROMO_DAY) return { credited: false, reason: 'limit_ip', promoVisits: known };

  ip.pd[day] = (ip.pd[day] || 0) + 1;
  ip.pfDone[refUser.id] = 1;

  const rec = shareRecOf(refUser.id);
  rec.promoVisits = (rec.promoVisits || 0) + 1;
  rec.promoBy[key] = (rec.promoBy[key] || 0) + 1;

  // 一次性里程碑：外宣累计带来 100 个不同的人来访 → 奖励 + 站内消息。只发一次，且门槛高到刷不动
  let milestone = 0;
  if (!rec.promoMilestone && rec.promoVisits >= PROMO_MILESTONE_UV) {
    rec.promoMilestone = Date.now();
    milestone = PROMO_MILESTONE_POINTS;
    const points = addPoints(refUser.id, milestone, 'promo');
    addNotice(refUser.id, {
      kind: 'points',
      title: `外宣里程碑 +${milestone} 盏灯火`,
      text: `你的作品通过外宣渠道累计带来了 ${PROMO_MILESTONE_UV} 位访客，送你 ${milestone} 盏灯火，当前余额 ${points} 盏。之后外宣带来的每一份访问照旧记在「推荐」的分享成绩里，继续发。`,
      points, delta: milestone
    });
  }
  saveShareSoon();
  return { credited: true, promoVisits: rec.promoVisits, milestone };
}

// 记录一次邀请注册。refName 来自注册请求 body 或该 IP 的首次触达。
// ipkOverride：小程序建号传 deviceId 桶（和 /api/ref/visit 记触达是同一个桶，
// 否则小程序里「带 ref 落地 → 一键登录」的归因永远对不上）。
function creditShareRegister(req, newUser, refName, ipkOverride) {
  const ipk = ipkOverride || ipKeyOf(req);
  const ip = ipRecOf(ipk);
  if (newUser && !newUser.regIp) newUser.regIp = ipk;

  // 渠道来源：优先用这台机器 7 天内的首触渠道（链接只有 ?fr= 没有 ref 时也算得清）。
  // 先落库再算邀请奖励 —— 下面有多处「防刷」提前 return，来源不能跟着一起丢掉。
  const chKey = ip.attrCh && Date.now() - ip.attrCh.at <= SHARE_ATTR_DAYS * 86400e3 ? ip.attrCh.key : '';
  if (newUser && chKey && !newUser.acqFr) {
    newUser.acqFr = chKey;
    newUser.acqAt = new Date().toISOString();
    saveUsers();
  }

  let refUser = resolveShareUser(refName);
  // 没有显式 ref 就用 7 天内的首次触达兜底
  if (!refUser && ip.attr && Date.now() - ip.attr.at <= SHARE_ATTR_DAYS * 86400e3) {
    refUser = users.find(u => u.id === ip.attr.uid) || null;
  }
  if (!refUser || !newUser) return { credited: false, reason: 'no_ref', channel: chKey };
  if (refUser.id === newUser.id) return { credited: false, reason: 'self' };
  // 同一台机器/同一出口 IP 上的账号互相邀请，不算（防小号互刷）
  if (refUser.regIp && refUser.regIp === ipk) return { credited: false, reason: 'same_ip' };

  if (ip.regs >= SHARE_IP_MAX_REGS) return { credited: false, reason: 'limit_ip' };
  if ((ip.refRegs[refUser.id] || 0) >= SHARE_IP_REF_MAX_REGS) return { credited: false, reason: 'limit_ip_ref' };

  const rec = shareRecOf(refUser.id);
  const d = dayOf(rec);
  // 按「次数」封顶：渠道加成会让单次积分变大，按积分封顶会把第 2 个注册也挡掉
  if (d.regs >= SHARE_DAILY_REGS) return { credited: false, reason: 'limit_daily' };

  // 外宣渠道加成：这台机器 7 天内的首次触达就来自外宣包，且归属同一位作者
  const viaPromo = ip.attrFr && ip.attrFr.uid === refUser.id
    && Date.now() - ip.attrFr.at <= SHARE_ATTR_DAYS * 86400e3 ? ip.attrFr.key : '';
  const bonus = viaPromo ? SHARE_PROMO_REG_BONUS : 0;
  // 小程序建号（ipkOverride = deviceId 桶）走低档激励，网页注册维持 100
  const basePoints = ipkOverride ? SHARE_REG_POINTS_MINI : SHARE_REG_POINTS;
  const gained = basePoints + bonus;

  ip.regs += 1;
  ip.refRegs[refUser.id] = (ip.refRegs[refUser.id] || 0) + 1;
  if (!ip.regIpUsers.includes(newUser.id)) ip.regIpUsers.push(newUser.id);

  rec.regs = (rec.regs || 0) + 1;
  rec.points = (rec.points || 0) + gained;
  rec.promoPoints = (rec.promoPoints || 0) + gained;    // 达人榜只认推广挣的
  d.regs += 1;
  d.rp += gained;
  if (bonus) {
    rec.promoRegs = (rec.promoRegs || 0) + 1;
    d.promoRegs = (d.promoRegs || 0) + 1;
    const pv = promoVisits[viaPromo] || (promoVisits[viaPromo] = { pv: 0, uv: {}, works: {}, lastAt: '', regs: 0 });
    pv.regs = (pv.regs || 0) + 1;
    schedulePromoVisitSave();
  }
  pushShareLog(rec, 'reg', '', gained);
  // 给邀请人发条站内消息：让他知道灯火从哪来的（铃铛 + 60 秒轮询弹提示）
  addNotice(refUser.id, {
    kind: 'points',
    title: `邀请注册奖励 +${gained} 盏灯火`,
    text: `好友 @${newUser.username} 通过你的${bonus ? `外宣链接（${viaPromo}）` : '分享链接'}注册成功，奖励 ${basePoints} 盏灯火`
      + `${bonus ? ` + 外宣渠道加成 ${bonus} 盏` : ''}，当前余额 ${rec.points} 盏。`,
    points: rec.points,
    delta: gained
  });
  newUser.invitedBy = refUser.username;
  // 来源渠道落库：链接带 ?fr= 进来的，注册这一刻就把首触渠道记在用户身上（兑换码那条路见 creditFrRedeem）
  if (!newUser.acqFr && viaPromo) { newUser.acqFr = viaPromo; newUser.acqAt = new Date().toISOString(); }
  saveUsers();
  saveShareSoon();
  return { credited: true, points: gained, bonus, viaPromo, inviter: displayNameOf(refUser.username) };
}

// 分享榜：按积分排序，只展示昵称与公开数字（管理员赠送的灯火不计入榜单分）
function shareBoard(limit = 10) {
  const rows = Object.keys(shareData.users).map(uid => {
    const u = users.find(x => x.id === uid);
    if (!u) return null;
    const r = shareRecOf(uid); // 走 shareRecOf 顺便补齐 promoPoints 等字段
    const earned = boardPointsOf(r);
    if (!r || !(earned > 0)) return null;
    return {
      username: u.username,
      name: displayNameOf(u.username),
      points: earned,
      visits: r.visits || 0,
      regs: r.regs || 0
    };
  }).filter(Boolean).sort((a, b) => b.points - a.points || b.visits - a.visits);
  return rows.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}
function shareStatsOf(userId) {
  const r = shareData.users[userId] || { points: 0, visits: 0, regs: 0, works: {}, byDay: {} };
  const board = shareBoard(1000);
  const idx = board.findIndex(b => b.username === (users.find(u => u.id === userId) || {}).username);
  return {
    points: r.points || 0,
    visits: r.visits || 0,
    scans: r.scans || 0,
    regs: r.regs || 0,
    works: r.works || {},
    byDay: r.byDay || {},
    // 外宣渠道：来访人数（同一 IP 只算 1 个）+ 各平台的分布，做成作者自己的渠道看板
    promoVisits: r.promoVisits || 0,
    promoRegs: r.promoRegs || 0,
    promoBy: r.promoBy || {},
    promoMilestone: r.promoMilestone ? 1 : 0,
    promoMilestoneAt: PROMO_MILESTONE_UV,
    promoMilestonePoints: PROMO_MILESTONE_POINTS,
    promoRegBonus: SHARE_PROMO_REG_BONUS,
    // 今天的进度：访问不设上限只报个数；扫码按人数去重后计分，也让作者看得见
    today: (() => {
      const d = (r.byDay || {})[dateKey()] || { visits: 0, regs: 0, vp: 0, scans: 0, sp: 0 };
      return { visits: d.visits || 0, regs: d.regs || 0, points: (d.vp || 0) + (d.sp || 0), scans: d.scans || 0 };
    })(),
    rank: idx >= 0 ? idx + 1 : 0,
    totalRanked: board.length
  };
}

// 消耗灯火（总花费口径）：平台消耗（买推荐位/展位 redeem，扣退款 refund）+ 打赏送出 tip_out。
// 其余 kind（upload/checkin/tip_in/admin/gift/os 等）都是挣进来或系统调整，不计入消耗。
function consumedLightsOf(uid) {
  const rec = shareData.users[uid];
  if (!rec || !Array.isArray(rec.log)) return { consumed: 0, promoSpent: 0, tippedOut: 0 };
  let redeem = 0, refund = 0, tippedOut = 0;
  for (const e of rec.log) {
    const p = Math.abs(e.points || 0);
    if (e.kind === 'redeem') redeem += p;
    else if (e.kind === 'refund') refund += p;
    else if (e.kind === 'tip_out') tippedOut += p;
  }
  const promoSpent = Math.max(0, redeem - refund);   // 推广到期退回的要从消耗里减掉
  return { consumed: promoSpent + tippedOut, promoSpent, tippedOut };
}

// ---------- 造梦酒馆 ----------
// 一句话说出「我想要一个……」，别人点「我也想要」表达需求热度；
// 有本事的创作者点「我来实现」认领，做完把作品挂上来，卡片自动变「已实现」。
let ideas = readJSON('ideas.json', []);
if (!Array.isArray(ideas)) ideas = [];
const IDEA_TITLE_MAX = 80;
const IDEA_DETAIL_MAX = 200;     // 可选「使用场景 / 期望效果」，让创作者知道到底要做什么
const IDEA_KEEP_MAX = 2000;      // 最多保留条数
function saveIdeas() {
  if (ideas.length > IDEA_KEEP_MAX) ideas.length = IDEA_KEEP_MAX;
  writeJSON('ideas.json', ideas);
}
function ideaById(id) { return ideas.find(i => i.id === id) || null; }

// 想法下的结构化讨论：不是自由评论区，只有三种有信息量的发言
//   scene    补一句使用场景   solution  推荐现成方案 / 类似工具   progress  认领者更新进展
// 单独存一份文件，不混进 comments.json —— 作品评论的计数、榜单评分都按 workId 走，混进去会串数。
let ideaDiscussions = readJSON('idea-discussions.json', []);
if (!Array.isArray(ideaDiscussions)) ideaDiscussions = [];
const IDEA_DISCUSSION_KINDS = ['scene', 'solution', 'progress'];
const IDEA_DISCUSSION_TEXT_MAX = 300;
const IDEA_DISCUSSION_KEEP_MAX = 5000;
function saveIdeaDiscussions() {
  if (ideaDiscussions.length > IDEA_DISCUSSION_KEEP_MAX) ideaDiscussions.length = IDEA_DISCUSSION_KEEP_MAX;
  writeJSON('idea-discussions.json', ideaDiscussions);
}
function discussionCountOf(ideaId) {
  let n = 0;
  for (const d of ideaDiscussions) if (d.ideaId === ideaId && !d.hidden) n++;
  return n;
}
function publicDiscussion(d, idea, user, admin) {
  return {
    id: d.id,
    kind: IDEA_DISCUSSION_KINDS.includes(d.kind) ? d.kind : 'scene',
    text: d.text,
    author: displayNameOf(d.author),
    createdAt: d.createdAt,
    mine: !!(user && d.userId && d.userId === user.id) || !!admin,
    isAuthor: !!(idea.userId && d.userId && d.userId === idea.userId),
    isClaimer: !!(idea.claimer && d.userId && d.userId === idea.claimer.userId)
  };
}
// 相似想法：只做轻量归一化（小写 + 去空白标点），命中后让前端二次确认「去顶一下」，
// 避免「AI 写作 / ai写作」这种重复把想要票数分散到两张卡上。
function normIdeaTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
function findSimilarIdea(title, exceptId) {
  const n = normIdeaTitle(title);
  if (n.length < 4) return null;
  return ideas.find(i => !i.hidden && i.id !== exceptId && (() => {
    const m = normIdeaTitle(i.title);
    if (m.length < 4) return false;
    return m === n || (m.length >= 6 && n.length >= 6 && (m.includes(n) || n.includes(m)));
  })()) || null;
}
// 点「我也想要」的身份：登录按账号，未登录按 IP，都终身只计一次
function ideaWantKey(req, user) {
  if (user) return 'u:' + user.id;
  return 'ip:' + crypto.createHash('sha256').update('idea:' + clientIp(req)).digest('hex').slice(0, 16);
}
function publicIdea(i, req, user) {
  const key = ideaWantKey(req, user);
  const w = i.workId ? works.find(x => x.id === i.workId) : null;
  return {
    id: i.id,
    title: i.title,
    detail: i.detail || '',
    category: i.category || '',
    author: displayNameOf(i.author),
    mine: !!(user && i.userId && i.userId === user.id),
    wants: i.wants || 0,
    discussionCount: discussionCountOf(i.id),
    wanted: Array.isArray(i.wantKeys) && i.wantKeys.includes(key),
    status: i.status || 'open',
    claimer: i.claimer ? { name: i.claimer.name, mine: !!(user && i.claimer.userId === user.id) } : null,
    work: w ? { id: w.id, title: w.title } : null,
    createdAt: i.createdAt,
    // 状态变更时间：提想法的人靠它判断「有没有新进展」（订阅消息个人主体开不了，走站内提醒）
    updatedAt: i.updatedAt || i.createdAt,
    hidden: !!i.hidden
  };
}

// ---------- 应用 ----------
const app = express();
// 注意：trust proxy=true 时 req.ip 取的是 XFF 最左段，客户端自己就能填，别直接拿它做限流/统计。
// 取真实 IP 统一走 clientIp(req)（只信代理追加的最后一段）。
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// 永久免登录：滑动续期。会话剩余时间不足一半时自动续满 1 年并刷新 cookie，
// 这样只要用户隔半年内回来过一次，就永远不会被登出
app.use((req, res, next) => {
  const sid = parseCookies(req).sid;
  const rec = sid && sessions[sid];
  if (rec && rec.uid && Date.now() <= rec.exp && Date.now() > rec.exp - SESSION_TTL / 2) {
    rec.exp = Date.now() + SESSION_TTL;
    saveSessions();
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
  }
  next();
});

// 最后活跃时间：登录态用户每次请求都顺手刷新 lastActiveAt，但节流到 5 分钟才改一次内存值、
// 再合并 3 秒落盘一次，避免高频请求把 users.json 写爆
const ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
let activeSaveTimer = null;
function touchActive(user) {
  if (!user) return;
  const now = Date.now();
  const last = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
  if (now - last < ACTIVE_THROTTLE_MS) return;
  user.lastActiveAt = new Date(now).toISOString();
  if (activeSaveTimer) return;
  activeSaveTimer = setTimeout(() => { activeSaveTimer = null; try { saveUsers(); } catch (e) { /* 落盘失败不影响主流程 */ } }, 3000);
}
app.use((req, res, next) => {
  const u = currentUser(req);
  if (u) touchActive(u);
  next();
});

// 安全 / SEO 相关响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/admin')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// 二维码图片：给分享卡片用。同一文本指纹命中后长缓存，省得重复计算
const qrCache = new Map();
app.get('/api/qr', (req, res) => {
  const text = String(req.query.text || '').slice(0, 600).trim();
  const size = Math.min(1024, Math.max(120, parseInt(req.query.size, 10) || 480));
  if (!text) return res.status(400).json({ error: '缺少 text 参数' });
  if (!rateLimit('qr:' + clientIp(req), 120, 60000)) return res.status(429).json({ error: '请求过于频繁' });
  const key = size + '|' + text;
  const hit = qrCache.get(key);
  const send = buf => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(buf);
  };
  if (hit) return send(hit);
  QRCode.toBuffer(text, { type: 'png', width: size, margin: 1, errorCorrectionLevel: 'M' })
    .then(buf => {
      if (qrCache.size > 500) qrCache.clear();
      qrCache.set(key, buf);
      send(buf);
    })
    .catch(() => res.status(500).json({ error: '二维码生成失败' }));
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'frontend'), {
  index: false,
  setHeaders(res, filePath) {
    // 带 ?v=<mtime> 的 style.css / app.js 用强缓存：URL 变了缓存自然失效；
    // 没带版本号的静态文件仍走协商缓存，改完刷新就能看到新版
    const hasVer = res.req && res.req.query && res.req.query.v;
    res.setHeader('Cache-Control', hasVer
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
  }
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }).fields([
  { name: 'image', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
  { name: 'qrcode', maxCount: 1 },
  { name: 'images', maxCount: 9 } // 宣传图，最多 9 张
]);

function isAdmin(req) {
  if (!ADMIN_KEY) return false; // 未配置后台口令时后台整体禁用，避免空口令放行
  return (req.query.key || req.headers['x-admin-key']) === ADMIN_KEY;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: '无权限，请检查管理口令' });
  next();
}

// 删除 /uploads 下的图片文件（忽略不存在的）
function removeUpload(imgPath) {
  if (!imgPath || typeof imgPath !== 'string') return;
  const p = path.join(UPLOAD_DIR, path.basename(imgPath));
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// 解析前端传来的待删除宣传图列表（JSON 数组或逗号分隔）
function parseRemovedImages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string');
  const s = String(raw);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string');
  } catch (_) { /* 退化为逗号分隔 */ }
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

// 应用图片变更：封面 / 二维码 / 宣传图（支持删除与保留已有）
// 解析前端提交的宣传图顺序：数组元素为已有图 URL，或 __new__<下标>（本次新上传的第几张）
function parseImageOrder(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(String(raw));
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : null;
  } catch (_) { return null; }
}

function applyImageChanges(w, req) {
  const files = req.files || {};

  // 封面：有新图则替换（删旧图），否则保持
  const newCover = files.image && files.image[0];
  if (newCover) {
    removeUpload(w.image);
    w.image = '/uploads/' + newCover.filename;
    w.thumb = files.thumb && files.thumb[0] ? '/uploads/' + files.thumb[0].filename : w.image;
  } else if (files.thumb && files.thumb[0]) {
    w.thumb = '/uploads/' + files.thumb[0].filename;
  }

  // 二维码：有新图替换；传 removeQrcode=1 则删除
  const newQr = files.qrcode && files.qrcode[0];
  if (newQr) {
    removeUpload(w.qrcode);
    w.qrcode = '/uploads/' + newQr.filename;
  } else if (String(req.body.removeQrcode) === '1' && w.qrcode) {
    removeUpload(w.qrcode);
    w.qrcode = '';
  }

  // 宣传图
  const newImgs = (files.images || []).map(f => '/uploads/' + f.filename);
  const removed = parseRemovedImages(req.body.removedImages);
  const keepExisting = String(req.body.keepExisting) === '1';
  const current = Array.isArray(w.images) ? w.images.slice() : [];

  if (keepExisting || (!newImgs.length && removed.length)) {
    // 增量模式：保留已有（去掉被删的）+ 追加新图
    let list = current.filter(img => {
      if (removed.includes(img)) { removeUpload(img); return false; }
      return true;
    }).concat(newImgs);
    list.slice(9).forEach(removeUpload); // 超出上限的新图清理掉
    w.images = list.slice(0, 9);
  } else if (newImgs.length) {
    // 整体替换：删掉全部旧图
    current.forEach(removeUpload);
    newImgs.slice(9).forEach(removeUpload);
    w.images = newImgs.slice(0, 9);
  }

  // 排序：按前端提交的最终顺序重排（已有图与新上传图可任意混排）
  const order = parseImageOrder(req.body.imageOrder);
  if (order && order.length && w.images.length > 1) {
    const pool = w.images.slice();
    const ordered = [];
    order.forEach(tok => {
      const m = /^__new__(\d+)$/.exec(tok);
      const val = m ? newImgs[Number(m[1])] : tok;
      if (val && pool.indexOf(val) !== -1 && ordered.indexOf(val) === -1) ordered.push(val);
    });
    pool.forEach(v => { if (ordered.indexOf(v) === -1) ordered.push(v); }); // 未提到的排在最后
    w.images = ordered;
  }
  w.updatedAt = Date.now();
}

// ---- 作品形态：支持多选（types 数组；type 保留为首个，兼容旧数据/旧链接）----
function normalizeTypes(input) {
  let arr = input;
  if (typeof arr === 'string') {
    const s = arr.trim();
    if (!s) arr = [];
    else if (s[0] === '[') { try { arr = JSON.parse(s); } catch { arr = s.split(','); } }
    else arr = s.split(',');
  }
  if (!Array.isArray(arr)) arr = [];
  const out = [];
  for (const t of arr) {
    const v = String(t || '').trim();
    if (ALL_TYPES_LEGACY.includes(v) && out.indexOf(v) === -1) out.push(v);
  }
  return out.length ? out : ['Web'];
}
function typesOf(w) {
  const arr = Array.isArray(w.types) ? w.types.filter(t => ALL_TYPES_LEGACY.includes(t)) : [];
  if (arr.length) return arr;
  return [ALL_TYPES_LEGACY.includes(w.type) ? w.type : 'Web'];
}
function applyTypes(w, types) {
  const arr = types && types.length ? types : ['Web'];
  w.types = arr;
  w.type = arr[0]; // 兼容旧字段与 /t/:type 路由
}

// 形态必填校验：只有 Web 必须有链接；小程序必须有小程序码；其余形态链接选填
const LINK_REQUIRED_TYPES = ['Web'];
// 预告用量：每人同时挂几件「开发中」，防刷占位
const WIP_MAX_PER_USER = 2;
// 完成度：只认 0-100 的整数，非法值按 null（前端显示「进度待更新」）
function clampProgress(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}
// 预计上线：只留 YYYY-MM-DD；日期非法就清空，避免前端显示 Invalid Date
function normEta(v) {
  const s = String(v || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const t = new Date(s + 'T00:00:00');
  return Number.isNaN(t.getTime()) ? '' : s;
}
// 匿名投稿查询凭证：无账号的人靠这个链接回来看审核进度
function randomToken() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(-12);
}

function validateTypeRequired(types, link, qrcode) {
  const list = types && types.length ? types : ['Web'];
  if (list.includes('Web') && !String(link || '').trim()) {
    return '作品形态含「Web」，请填写网站地址';
  }
  if (list.includes('小程序') && !String(qrcode || '').trim()) {
    return '作品形态含「小程序」，请上传小程序码 / 二维码';
  }
  return '';
}

// 纯小程序作品：只能微信扫码打开，没有可点的外链。
// 这类作品的 link 字段没有意义——存下来就会在详情页变成一个「打开小程序」却跳出网页的假按钮。
function onlyMini(types) {
  const list = types && types.length ? types : [];
  return list.length > 0 && list.every(t => t === '小程序');
}

// 按形态的多个链接：{ "iOS": "https://...", "Android": "..." }
// 只保留所选形态（小程序除外——它用二维码），逐个规范化 URL；无有效条目返回 null
function normLinksMap(raw, types) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const list = (types && types.length ? types : ['Web']).filter(t => t !== '小程序');
  const out = {};
  for (const t of list) {
    let s = String(obj[t] || '').trim();
    if (!s) continue;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    if (s.length <= 500) out[t] = s;
  }
  return Object.keys(out).length ? out : null;
}

// 官网（作品的主页/官方网站，所有形态通用，选填）
function normSite(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.slice(0, 500);
}

// 每个作品的评论数：懒加载缓存，评论增删后置空重算
// plain = 全部评论（展示用）；scoreable = 可计热度分的评论（登录用户发的，匿名评论不算——匿名刷评论换不来排名分）
let commentCounts = null;
function commentStats() {
  if (!commentCounts) {
    const plain = {}, scoreable = {};
    for (const c of comments) {
      plain[c.workId] = (plain[c.workId] || 0) + 1;
      if (!c.anon && c.userId) scoreable[c.workId] = (scoreable[c.workId] || 0) + 1;
    }
    commentCounts = { plain, scoreable };
  }
  return commentCounts;
}
function countComments(id) { return commentStats().plain[id] || 0; }
function invalidateCommentCounts() { commentCounts = null; }

// 开源标识：'1'/true → 开源，'0'/false → 闭源，缺省/空 → 不标注（null）
function parseOpenSource(v) {
  if (v === true || v === '1' || v === 'true') return true;
  if (v === false || v === '0' || v === 'false') return false;
  return null;
}

// 是否收费：只有作者主动勾选才为 true（默认免费且不标注）
function parsePaid(v) {
  return v === true || v === '1' || v === 'true';
}

// 收费形式：标注付费时的可选模式（白名单，防脏数据；空/非法 → 不标注形式）
const PAID_MODELS = ['freemium', 'member', 'onetime', 'subscription', 'trial', 'donation'];
function parsePaidModel(v) {
  const s = String(v || '').trim();
  return PAID_MODELS.includes(s) ? s : '';
}

// 源码仓库地址：补协议、截断；标注开源时必须非空（由调用方校验）
function normRepo(v) {
  let s = String(v || '').trim();
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.slice(0, 500);
}

// 源码仓库只收国内外主流开源代码托管站：站方定位开源作品集，仓库链接要能公开访问、可核对，
// 随便填一个博客/网盘地址等于开源标注没有证据。
// 增删站点时前后端两处同改（frontend/app.js 的 REPO_HOSTS、frontend/admin.html 的同名常量）
const REPO_HOSTS = [
  // 国际
  'github.com', 'gitlab.com', 'bitbucket.org', 'sourceforge.net', 'codeberg.org', 'git.sr.ht', 'huggingface.co',
  // 国内
  'gitee.com', 'gitcode.com', 'atomgit.com', 'codeup.aliyun.com', 'coding.net', 'gitlink.org.cn'
];
// 报错文案里露脸的站点（太长没人看，列常见的几个就够）
const REPO_HOST_TIP = 'GitHub / Gitee / GitLab / Bitbucket / GitCode / AtomGit 等国内外开源代码托管站';

function repoHostOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}
// 允许子域名（gist.github.com、codeup.aliyun.com），但 github.com.evil.com 这种不算
function repoHostAllowed(raw) {
  const h = repoHostOf(raw);
  if (!h) return false;
  return REPO_HOSTS.some(base => h === base || h.endsWith('.' + base));
}
function repoRejectMsg() {
  return `源码仓库地址必须是开源代码托管站的页面：${REPO_HOST_TIP}；其他站点的链接请先把代码放到这些平台`;
}

// 作者荣誉标签：按登录账号查（works.author 就是账号名）。没有标签返回空数组
function userTagsOf(username) {
  const u = users.find(x => x.username === username);
  return u && Array.isArray(u.tags) ? u.tags : [];
}
// 清洗后台传入的标签：去空白、去重、单个 ≤20 字、最多 6 个
function sanitizeTags(arr) {
  const out = [];
  for (const t of (Array.isArray(arr) ? arr : [])) {
    const s = String(t).trim().slice(0, 20);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

// 只返回对外的字段（user 传入时附加 owned 标记）
function publicWork(w, user) {
  const creator = creators.find(c => c.name === w.author);
  const types = typesOf(w);
  // 详情页展示的二维码：作者原码（小程序）优先，否则自动短链码（扫码可数，见 /go/:code）
  const qr = workQrOf(w);
  return {
    id: w.id, title: w.title, author: w.author, authorName: displayNameOf(w.author), category: w.category,
    anonymous: w.anonymous === true,   // 匿名发布：前台不显示真实作者
    categories: catsOf(w),
    type: types[0], types: types,
    intro: w.prompt || '', link: w.link || '',
    // 简介是 Markdown 源码（编辑回填用）。卡片/列表只放得下纯文本，这里给去掉记号的摘要，
    // 免得卡片上出现 ** ## 这类符号；详情页再单独渲染成 HTML（见 /api/works/:id）
    introText: md.plain(w.prompt || '').slice(0, 160),
    site: w.site || '',
    ...(w.links && Object.keys(w.links).length ? { links: w.links } : {}),
    image: w.image, thumb: w.thumb || w.image, qrcode: w.qrcode || '',
    qrSrc: qr.src, qrReal: !!qr.real, qrTargets: qr.targets || [], qrDetailCode: detailCodeOf(w),
    images: Array.isArray(w.images) ? w.images.slice(0, 9) : [],
    likes: w.likes || 0, favs: w.favs || 0, commentCount: countComments(w.id), views: w.views || 0, featured: isFeaturedActive(w), featuredUntil: w.featuredUntil || null, pinned: !!w.pinned,
    tipsTotal: tipAggOf(w.id).total, tipsCount: tipAggOf(w.id).count,
    openSource: w.openSource === true ? true : (w.openSource === false ? false : null),
    repo: w.repo || '',
    stars: typeof w.stars === 'number' ? w.stars : null,   // GitHub star 缓存（每 6 小时同步），详情页展示用
    paid: !!w.paid,
    paidModel: w.paid ? (w.paidModel || '') : '',
    verified: !!creator,
    authorTags: userTagsOf(w.author),
    codesTotal: codesOf(w.id).length,
    codesLeft: codesOf(w.id).filter(c => c.status === 'available').length,
    faved: !!(user && Array.isArray(user.favs) && user.favs.includes(w.id)),
    owned: !!(user && w.userId && user.id === w.userId),
    hidden: !!w.hidden,
    claimed: !!w.userId,
    claimable: isClaimable(w),
    // 进度相关：预告卡 / 平台审核灰卡都靠这几个字段渲染
    stage: stageOf(w),
    progress: typeof w.progress === 'number' ? w.progress : null,
    eta: w.eta || '',
    progressLog: Array.isArray(w.progressLog) ? w.progressLog.slice(-3).reverse() : [],
    watchCount: Array.isArray(w.watchers) ? w.watchers.length : 0,
    watched: !!(user && Array.isArray(w.watchers) && w.watchers.some(x => x.userId === user.id)),
    linkLocked: stageOf(w) === 'reviewing',
    createdAt: w.createdAt,
    updatedAt: w.updatedAt || w.createdAt
  };
}
// 作品推进阶段（作者自己声明的进度，和站内审核是两条线）：
//   live      已上线：有可访问的入口，正常展示
//   reviewing 等平台上架审核：链接已经存在但现在打不开，展示成灰卡、不给人点
//   wip       还在做：连链接都还没有，展示成预告卡，收催更
// 用独立 stage 字段而不是塞进 status —— 老数据没有 stage 全按 live 走，零迁移；
// status 继续只管站内审核（approved / pending / rejected），两条线互不覆盖。
const STAGES = ['live', 'reviewing', 'wip'];
function stageOf(w) { return STAGES.includes(w.stage) ? w.stage : 'live'; }
// 主列表 / 榜单 / 精选 / SEO 只收真正上线的作品，预告与审核中不进信息流
// hidden = 作者自主下架：数据保留、作者本人可见，但不进任何公开列表（区别于管理员 rejected）
function isVisible(w) { return !w.hidden && (w.status || 'approved') === 'approved' && stageOf(w) === 'live'; }
// 已下架：管理员下架（rejected）或作者自主下架（hidden）。后台「已下架」视图按这个口径收
function isOffline(w) { return (w.status || 'approved') === 'rejected' || !!w.hidden; }
// 已过站内审核就算「可访问」，用来放开详情页（含预告、平台审核中的作品）
function isPublished(w) { return (w.status || 'approved') === 'approved'; }
// 即将上线：已过审但还没真正上线；stale 的预告不进公开列表
function isComing(w) { return isPublished(w) && stageOf(w) !== 'live' && !w.stale; }
// 精选有效期：featured 只表示「曾被设为精选」，是否仍在精选期看 featuredUntil；
// 老数据无 featuredUntil 时启动会统一补 3 天，这里兜底按「生效」处理
function isFeaturedActive(w) {
  if (!w || !w.featured) return false;
  if (!w.featuredUntil) return true;
  try { return new Date(w.featuredUntil).getTime() > Date.now(); } catch { return true; }
}

// 正式上线那一刻要做的事：补发预告阶段压着的奖励 + 给所有催更的人发站内消息
function promoteToLive(w) {
  if (!w) return 0;
  if (!w.uploadReward && w.userId) planUploadReward(w, users.find(u => u.id === w.userId));
  if (w.openSource === true) grantOpenSourceBonus(w);
  const watchers = Array.isArray(w.watchers) ? w.watchers : [];
  let notified = 0;
  watchers.forEach(x => {
    if (!x || x.notified) return;
    addNotice(x.userId, {
      kind: 'system',
      title: '你等着的作品上线了',
      text: `「${w.title}」已经上线，可以直接体验了：/w/${w.id}`
    });
    x.notified = true;
    notified++;
  });
  w.watchers = [];
  w.lastNotifyCount = notified;
  return notified;
}

// 统一改阶段：写完成度 / 预计上线 / 进度日志，跨到 live 时触发上线副作用
function setWorkStage(w, next, opts = {}) {
  const prev = stageOf(w);
  if (opts.progress !== undefined) w.progress = clampProgress(opts.progress);
  if (opts.eta !== undefined) w.eta = normEta(opts.eta);
  w.stage = next;
  w.updatedAt = new Date().toISOString();
  delete w.stale;
  delete w.staleWarnedAt;
  const note = String(opts.note || '').trim().slice(0, 200);
  if (note) {
    if (!Array.isArray(w.progressLog)) w.progressLog = [];
    w.progressLog.push({ at: w.updatedAt, text: note, progress: typeof w.progress === 'number' ? w.progress : null });
    if (w.progressLog.length > 30) w.progressLog = w.progressLog.slice(-30);
  }
  if (prev !== 'live' && next === 'live') promoteToLive(w);
  return prev;
}


function statusLabelOf(w) {
  const status = w.status || 'approved';
  const stage = stageOf(w);
  if (status === 'rejected') return { text: '已下架', bg: '#FCEBEB', fg: '#A32D2D', tip: '作品被下架了。按原因改好内容重新提交，审核通过就会恢复展示。' };
  if (status === 'pending') return { text: '站内审核中', bg: '#FAEEDA', fg: '#854F0B', tip: '管理员正在人工审核，一般当天处理完；通过后会自动出现在首页。' };
  if (stage === 'wip') return {
    text: typeof w.progress === 'number' ? `开发中 · ${w.progress}%` : '开发中',
    bg: '#E6F1FB', fg: '#185FA5',
    tip: '还在做，先挂着预告收催更；上线后会给所有催更的人发站内消息。'
  };
  if (stage === 'reviewing') return { text: '等平台上架审核', bg: '#FAEEDA', fg: '#854F0B', tip: '在应用商店 / 小程序平台的审核中，通过后记得回来自助点「我上线了」。' };
  return { text: '已上线', bg: '#E1F5EE', fg: '#0F6E56', tip: '作品已上线，可以正常访问。' };
}
// SSR 用：带上展示名，页面显示昵称，作者页链接仍用账号
function withAuthorName(w) {
  const n = displayNameOf(w.author);
  return n === w.author ? w : { ...w, authorName: n };
}
const withAuthorNames = list => list.map(withAuthorName);
// 作者主页的作品来源：名字只用于展示，归属只认账号 id。
// 有同名账号时只列「真正归属这个账号」的作品——否则谁注册到这个账号名，谁就凭空接管别人的作品页；
// 还没有这个账号时（先有作品后有账号）才退回按署名列出。
function worksOfAuthorName(name) {
  const account = users.find(u => u.username === name);
  if (!account) return works.filter(w => w.author === name);
  return works.filter(w => w.userId === account.id);
}
// 认领开关：管理员显式设过就按设置走；没设过时「无归属作品」（匿名投稿 / 后台代传）默认可认领
function isClaimable(w) {
  if (w.anonymous === true) return true;   // 匿名发布：默认开放认领，让真正的作者能认回去
  if (w.claimOpen === true) return true;
  if (w.claimOpen === false) return false;
  return !w.userId;
}

// ================= 公共接口 =================

// ---- 注册 / 登录 ----
const NAME_RE = /^[\w\u4e00-\u9fa5·]{2,20}$/;

app.post('/api/register', async (req, res) => {
  if (!rateLimit('reg:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  }
  const { username, password, nickname } = req.body || {};
  const name = String(username || '').trim();
  if (!NAME_RE.test(name)) return res.status(400).json({ error: '用户名需 2-20 位，可为中文、字母、数字、下划线' });
  const shapeErr = nameShapeError(name);
  if (shapeErr) return res.status(400).json({ error: shapeErr });
  const impErr = nameImpersonation(name);
  if (impErr) return res.status(400).json({ error: impErr });
  if (hitSensitive(name)) return res.status(400).json({ error: '用户名包含敏感词，换一个吧' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  // 查重不区分大小写：@Zhang 和 @zhang 在页面上分不清，也不能让抢注者用大小写仿冒
  if (users.find(u => u.username.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: '用户名已被占用（不区分大小写）' });
  }
  // 认证创作者的名字不给抢注：认证是按账号名匹配的，抢到手就白得一个 ✔，等于冒充
  if (creators.some(c => c.name === name && !creatorAccountOf(c.name))) {
    return res.status(400).json({ error: '这个名字已被站内认证创作者占用，如是你本人请联系站长核实' });
  }
  // 昵称选填：作品上展示的名字，账号名只用于登录（不设置就先用账号名兜底）
  // 昵称允许重名（用户自己想叫什么叫什么）；但如果是**系统预填的随机名**（前端带 nickAuto），
  // 提交时发现撞了别人的昵称，就静默换一个没被占用的，别让用户为系统摇出来的名字买单。
  let nick = nickParse(nickname, null);
  if (nick.error) return res.status(400).json({ error: nick.error, code: nick.code });
  let nickAdjusted = false;
  if (nick.nick && req.body && req.body.nickAuto && nickTaken(nick.nick, null)) {
    nick = { nick: randomFreeNick() };
    nickAdjusted = true;
  }
  // AI 初审：手填昵称也过一遍智谱（系统随机名是站内词库摇的，不查）
  if (nick.nick && !nickAdjusted) {
    const ai = await aiReviewGate('用户昵称：' + nick.nick);
    if (ai.pass === false) {
      return res.status(400).json({ error: '这个昵称疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，换一个吧' });
    }
  }

  const user = makeUser(name, String(password));
  if (nick.nick) user.nickname = nick.nick;   // 注：不写 nicknameChangedAt，注册后的第一次改名不受 7 天限制
  user.regIp = ipKeyOf(req);
  users.push(user);
  saveUsers();
  // 新用户上线第一件事：把「造梦编年史」当系统消息推给他（可屏蔽提示，不会拒收）
  try { pushChronicleWelcome(user); } catch (e) { /* 消息失败不影响注册 */ }
  // 邀请奖励：带上 ref 或者该 IP 7 天内有分享落地记录才计入（同 IP 有严格上限，见 creditShareRegister）
  const invite = creditShareRegister(req, user, (req.body && req.body.ref) || '');
  setSession(res, user, isRemember(req.body), 'pass');
  res.status(201).json({
    username: user.username,
    nickname: user.nickname || '',
    nickAdjusted,                               // true = 预填名撞了，服务端换了一个（前端提示一句）
    displayName: displayNameOf(user.username),
    noticePrefs: { announce: !announceMuted(user) },   // 新号默认正常，前端据此渲染「系统消息提示」
    invited: !!invite.credited,
    invitePoints: invite.credited ? (invite.points || 0) : 0
  });
});

app.post('/api/login', (req, res) => {
  if (!rateLimit('login:' + clientIp(req), 20, 3600000)) {
    return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  }
  const { username, password } = req.body || {};
  // 大小写不敏感地认人（历史重名数据只认精确匹配，见 findUserLoose）
  const user = findUserLoose(username);
  // 用户名不存在：告诉前端「可一键转注册」（前端会展示确认提示，不会静默创建）
  if (!user) return res.status(404).json({ error: '该用户名还没有注册', notFound: true });
  // OAuth 建的号还没设过密码：别让用户以为自己记错了密码
  const via = (user.github && user.github.id) ? 'GitHub' : ((user.google && user.google.sub) ? 'Google' : '');
  if (user.passSet === false && via) {
    return res.status(400).json({ error: `这个账号是用 ${via} 登录的，请点下方「${via} 登录」；登录后可以再设一个密码`, oauthOnly: true });
  }
  if (!checkPassword(user, String(password || ''))) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  setSession(res, user, isRemember(req.body), 'pass');
  touchActive(user);   // 登录即一次有效活跃，立刻记下
  ensureLegacyNick(user);   // 老用户没昵称的，登录时顺手补一个随机昵称
  res.json({
    username: user.username, nickname: user.nickname || '', displayName: displayNameOf(user.username),
    noticePrefs: { announce: !announceMuted(user) },   // 登录响应就带上，省得前端再拉一次 /api/me
    // 登录态是前端拿这个响应直接建的（不走 /api/me）：passSet / 别名必须一起带上，
    // 否则「账号与密码」弹窗会把还没设过密码的 OAuth 临时号误判成已设密码，
    // 让用户填一个根本不存在的「当前密码」（2026-11-06 线上真实踩到）
    passSet: user.passSet !== false,
    alias: user.alias || '',
    aliasNextAt: aliasNextAt(user),
    wechat: !!user.wechat
  });
});

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// ---- GitHub 登录 / 绑定 ----
// start?mode=login   → 未登录也能走，登录后回到 next（默认首页）
// start?mode=bind    → 必须是已登录账号，把 GitHub 挂到当前账号上
app.get('/api/auth/github/start', (req, res) => {
  if (!GH_ENABLED) return ghErrorRedirect(res, 'github_disabled');
  if (!rateLimit('ghstart:' + clientIp(req), 30, 600e3)) return ghErrorRedirect(res, 'too_frequent');
  const mode = req.query.mode === 'bind' ? 'bind' : 'login';
  const user = currentUser(req);
  if (mode === 'bind') {
    if (!user) return ghErrorRedirect(res, 'bind_need_login');
    if (user.github && user.github.id) return ghErrorRedirect(res, 'github_already_bound');
  }
  ghPruneStates();
  const state = crypto.randomBytes(20).toString('hex');
  GH_STATES.set(state, {
    mode,
    uid: mode === 'bind' ? user.id : '',
    next: safeNextPath(req.query.next),
    ref: String(req.query.ref || '').slice(0, 120),
    exp: Date.now() + GH_STATE_TTL
  });
  const url = new URL(GH_CONF.oauthBase + '/login/oauth/authorize');
  url.searchParams.set('client_id', GH_CONF.clientId);
  url.searchParams.set('redirect_uri', ghCallbackUrl(req));
  url.searchParams.set('scope', GH_SCOPE);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/api/auth/github/callback', async (req, res) => {
  if (!GH_ENABLED) return ghErrorRedirect(res, 'github_disabled');
  const { code, state, error } = req.query;
  const rec = state && GH_STATES.get(String(state));
  if (state) GH_STATES.delete(String(state));   // 一次性，防重放
  if (!rec || Date.now() > rec.exp) return ghErrorRedirect(res, 'state_invalid');
  if (error) return ghErrorRedirect(res, String(error) === 'access_denied' ? 'denied' : 'oauth_error');
  if (!code) return ghErrorRedirect(res, 'oauth_error');
  if (!rateLimit('ghcb:' + clientIp(req), 30, 600e3)) return ghErrorRedirect(res, 'too_frequent');

  let gh, ghUser;
  try {
    const token = await ghExchangeToken(code, ghCallbackUrl(req));
    ghUser = await ghFetchUser(token);
    gh = ghProfileOf(ghUser);
  } catch (err) {
    console.warn('[github oauth] 换取用户信息失败:', err.message);
    return ghErrorRedirect(res, 'oauth_error');
  }

  // ① 绑定到已登录账号
  if (rec.mode === 'bind') {
    const user = users.find(u => u.id === rec.uid);
    if (!user) return ghErrorRedirect(res, 'bind_need_login');   // 跳转期间登出了
    const owner = users.find(u => u.github && u.github.id === gh.id && u.id !== user.id);
    if (owner) return ghErrorRedirect(res, 'github_taken');
    user.github = gh;
    saveUsers();
    return res.redirect(withQuery(rec.next, 'github=bound'));
  }

  // ② 登录：先按 github id 认人
  const existing = users.find(u => u.github && u.github.id === gh.id);
  if (existing) {
    // 头像 / 昵称可能改过，每次登录顺手同步一次；绑定时间保留最早那次
    existing.github = { ...gh, connectedAt: (existing.github && existing.github.connectedAt) || gh.connectedAt };
    saveUsers();
    ensureLegacyNick(existing);   // GitHub 建号时没取到显示名的老用户，登录时补随机昵称
    setSession(res, existing, true, 'oauth');
    return res.redirect(withQuery(rec.next, 'github=login'));
  }

  // ③ 第一次来：GitHub 建号（随机密码 + passSet=false，登录后可以自己设密码）
  const user = makeGithubUser(ghUser);
  user.regIp = ipKeyOf(req);
  users.push(user);
  saveUsers();
  try { pushChronicleWelcome(user); } catch (e) { /* 消息失败不影响登录 */ }
  try { creditShareRegister(req, user, rec.ref); } catch (e) { /* 邀请奖励失败不影响登录 */ }
  setSession(res, user, true, 'oauth');
  res.redirect(withQuery(rec.next, 'github=new'));
});

// 解绑：GitHub 建号且还没设密码的不能解（解了就进不来了）
app.post('/api/me/github/unbind', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!user.github || !user.github.id) return res.status(400).json({ error: '当前账号还没有绑定 GitHub' });
  if (user.passSet === false) {
    return res.status(400).json({ error: '请先设置一个登录密码，再解绑 GitHub，否则解绑后就登不进来了', needPassword: true });
  }
  delete user.github;
  saveUsers();
  res.json({ ok: true });
});

// ================= 微信小程序登录（登录 + 绑定） =================
// 与 GitHub/Google 不同：不是浏览器跳转授权，而是小程序端 wx.login() 拿一次性 code，
// 后端拿 code+appId+appSecret 去 code2session 换 openid（用户在本小程序的终身唯一 ID），
// 然后按 openid 认人。三种 mode：
//   check（默认）：openid 已绑账号 → 直接登录；未绑 → 返回 needAccount（不动数据，让前端选）
//   new          ：未绑则自动建号（随机密码 + passSet=false，可在账号设置里补密码后网页端登录）
//   bind         ：未绑则校验用户名密码，把 openid 挂到该账号（绑完即免密，密码只输这一次）
// 已绑定的 openid 无论传什么 mode 都幂等地直接登录。
async function wechatResolveOpenid(code) {
  const c = String(code || '').trim();
  if (!c) throw new Error('缺少微信授权码');
  if (WECHAT_CONF.mock) return 'mock_' + c.replace(/[^-~\w]/g, '').slice(0, 32);   // 本地测试：code 即 openid
  const url = 'https://api.weixin.qq.com/sns/jscode2session'
    + '?appid=' + encodeURIComponent(WECHAT_CONF.appId)
    + '&secret=' + encodeURIComponent(WECHAT_CONF.appSecret)
    + '&js_code=' + encodeURIComponent(c)
    + '&grant_type=authorization_code';
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const d = await r.json().catch(() => ({}));
  if (d.errcode) throw new Error('微信登录校验失败（' + d.errcode + (d.errmsg ? ' ' + d.errmsg : '') + '）');
  if (!d.openid) throw new Error('微信登录校验失败：未返回 openid');
  return String(d.openid);
}

// ---------- 绑定微信一次性奖励 ----------
// 「老账号绑定微信」要输一遍网站账号密码（下面的 mode=bind），有身份门槛才敢给大额：
// 一次性 300 盏灯火，按兑换价约等于一次首页推荐位（网页首页第一格 50 次 = 250 盏）。
// 微信一键建号（mode=new）和临时号合并（/api/me/wechat/merge）都不算绑定，不发。
// 防刷两条：① 账号维度 rec.wxBindBonusAt；② 微信号维度 shareData.wxBindOpenids[openid 哈希]。
// 领取记录放在 share.json 而不是 user 上，解绑（delete user.wechat）不会把记录一起删掉；
// 同一个微信号拿去绑另一个老账号也领不到第二次。openid 只落哈希，不留明文身份。
const WX_BIND_BONUS_POINTS = 300;
function wxBindOpenidKey(openid) {
  return crypto.createHash('sha256').update('wxbind:' + String(openid)).digest('hex').slice(0, 32);
}
function awardWxBindBonus(user, openid) {
  const rec = shareRecOf(user.id);
  if (!shareData.wxBindOpenids || typeof shareData.wxBindOpenids !== 'object') shareData.wxBindOpenids = {};
  const okey = wxBindOpenidKey(openid);
  if (rec.wxBindBonusAt || shareData.wxBindOpenids[okey]) {
    return { reward: 0, already: true, points: rec.points || 0 };
  }
  const at = new Date().toISOString();
  rec.wxBindBonusAt = at;
  shareData.wxBindOpenids[okey] = { uid: user.id, at };
  const points = addPoints(user.id, WX_BIND_BONUS_POINTS, 'wxbind');
  addNotice(user.id, {
    key: 'wxbind-bonus:' + user.id,          // 同一个账号只发一条，重启/重放不会刷通知
    kind: 'points',
    title: `绑定微信奖励 +${WX_BIND_BONUS_POINTS} 盏灯火`,
    text: `你把微信绑定到了「${displayNameOf(user.username)}」，一次性送 ${WX_BIND_BONUS_POINTS} 盏灯火，当前余额 ${points} 盏。以后这个微信打开小程序免密登录；灯火可在「推荐」买曝光。`,
    points,
    delta: WX_BIND_BONUS_POINTS
  });
  saveShareSoon();                          // addPoints 已排过一次，这里把 openid 哈希也一起落盘
  return { reward: WX_BIND_BONUS_POINTS, points };
}
// /api/me 下发给前端：没绑微信且没领过时显示「+300」引导，领过/已绑就别再吊胃口
function wxBindBonusState(user) {
  const rec = shareData.users[user.id] || {};
  return {
    points: WX_BIND_BONUS_POINTS,
    claimed: !!rec.wxBindBonusAt,
    available: !(user.wechat && user.wechat.openid) && !rec.wxBindBonusAt
  };
}

// 微信建号：账号名 wx_<openid 尾部>（重名自动加后缀），随机密码 + passSet=false（同 GitHub 建号）
function makeWechatUser(openid) {
  const username = oauthUsernameFor('wx' + String(openid).slice(-10), 'wx_', openid);
  const user = makeUser(username, crypto.randomBytes(24).toString('hex'));
  user.passSet = false;
  user.tempAcct = true;          // 微信自动建的临时号：设了密码之后也仍允许合并到老账号
  user.wechat = { openid: String(openid), connectedAt: new Date().toISOString() };
  ensureLegacyNick(user);   // 微信拿不到昵称（无额外授权），用站内随机昵称词库补一个
  return user;
}
app.post('/api/auth/wechat/login', async (req, res) => {
  if (!WECHAT_ENABLED) return res.status(400).json({ error: '微信登录未配置' });
  if (!rateLimit('wxlogin:' + clientIp(req), 30, 3600e3)) {
    return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  }
  const body = req.body || {};
  const mode = ['check', 'new', 'bind'].includes(body.mode) ? body.mode : 'check';

  let openid;
  try { openid = await wechatResolveOpenid(body.code); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  // ① openid 已绑定账号：无论什么 mode 都直接登录（免密、幂等）
  const existing = users.find(u => u.wechat && u.wechat.openid === openid);
  if (existing) {
    // 例外：当前已登录别的账号（比如先微信建了临时号，现在想在「我的」里绑到老账号），
    // 直接登录会把用户悄悄换成另一个号，必须拦下来走合并
    const me = currentUser(req);
    if (mode === 'bind' && me && me.id !== existing.id) {
      return res.status(409).json({
        error: '这个微信已经登录过另一个账号了。请回到「我的」用「绑定已有账号」把那边的收藏和灯火合并过来，不要重复绑定',
        wxBoundOther: true,
      });
    }
    touchActive(existing);
    ensureLegacyNick(existing);
    setSession(res, existing, true, 'wechat');
    return res.json({
      bound: true, username: existing.username,
      nickname: existing.nickname || '', displayName: displayNameOf(existing.username)
    });
  }

  // ② 绑定已有账号：校验一次密码，把 openid 挂上去，之后永久免密
  if (mode === 'bind') {
    const username = String(body.username || '').trim();
    const user = findUserLoose(username);
    if (!user) return res.status(404).json({ error: '该用户名还没有注册', notFound: true });
    if (user.wechat && user.wechat.openid) {
      return res.status(400).json({ error: '该账号已绑定其他微信，请直接用微信一键登录' });
    }
    if (!checkPassword(user, String(body.password || ''))) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    user.wechat = { openid: String(openid), connectedAt: new Date().toISOString() };
    touchActive(user);
    saveUsers();
    // 密码已校验、openid 刚挂上，同一次请求里把奖励发掉，前端能直接拿到 {reward, points}
    const bonus = awardWxBindBonus(user, openid);
    setSession(res, user, true, 'pass');   // 密码刚验过，等同密码登录
    return res.json({
      bound: true, merged: true, username: user.username,
      nickname: user.nickname || '', displayName: displayNameOf(user.username),
      bonus
    });
  }

  // ③ 只是探测：未绑定，让前端决定「新建」还是「绑定已有」
  if (mode === 'check') {
    return res.json({ needAccount: true });
  }

  // ④ mode=new：自动建号（随机昵称 + 随机密码，网页端想用可再补密码）
  const user = makeWechatUser(openid);
  // 小程序来源：regIp 记 deviceId 桶而不是出口 IP（NAT 后几百人共享一个出口，
  // 按 IP 会把同运营商的合法邀请误判成「同机小号互刷」），归因/防刷和
  // /api/ref/visit 用同一个桶，「带 ref 落地 → 一键登录建号」整条链路按设备认人。
  const miniIpk = miniIpkOf(body);
  user.regIp = miniIpk || ipKeyOf(req);
  // 注册端标记：只有小程序「微信一键登录」建号才带（游客不建号、绑定老账号不新增）。
  // 后台据此显示「小程序」标签并单独计数，历史账号没这个字段就不显示。
  if (body.platform === 'mini') user.regFrom = 'mini';
  users.push(user);
  saveUsers();
  try { pushChronicleWelcome(user); } catch (e) { /* 消息失败不影响登录 */ }
  try { creditShareRegister(req, user, String(body.ref || '').slice(0, 120), miniIpk); } catch (e) { /* 邀请奖励失败不影响登录 */ }
  setSession(res, user, true, 'wechat');
  res.json({
    created: true, username: user.username,
    nickname: user.nickname || '', displayName: displayNameOf(user.username)
  });
});
// 解绑：微信建号且还没设密码的不能解（解了就进不来了），同 GitHub
app.post('/api/me/wechat/unbind', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!user.wechat || !user.wechat.openid) return res.status(400).json({ error: '当前账号还没有绑定微信' });
  if (user.passSet === false) {
    return res.status(400).json({ error: '请先设置一个登录密码，再解绑微信，否则解绑后就登不进来了', needPassword: true });
  }
  delete user.wechat;
  saveUsers();
  res.json({ ok: true });
});

// ---- 微信临时号 → 已有账号的合并 ----
// 小程序现在是「先微信无感建号，进去随便逛，想起来了再绑老账号」。
// 中间这段时间攒下的收藏、灯火/签到、想法、评论、作品、领的兑换码都挂在临时号上，
// 直接 bind 会把 openid 挪走、数据留在没人能进的临时号里 —— 用户看到的就是「数据丢了」。
// 所以合并要逐项搬完再删临时号：搬的东西和「注销账号」要清理的东西是同一份清单，漏一项就是一次投诉。
function mergeWechatAccountInto(from, to) {
  const moved = { favs: 0, points: 0, works: 0, comments: 0, ideas: 0, notices: 0, codes: 0 };

  // ① 收藏 / 屏蔽作品 / 拉黑作者：取并集（目标账号原有的排在前面，那是更早的真实收藏）
  if (!Array.isArray(to.favs)) to.favs = [];
  const toFavSet = new Set(to.favs);
  const fromFavs = (Array.isArray(from.favs) ? from.favs : []).filter(Boolean);
  const dupFavs = fromFavs.filter(id => toFavSet.has(id));      // 两边都收藏过：合并后只能算一个人
  fromFavs.forEach(id => { if (!toFavSet.has(id)) { toFavSet.add(id); to.favs.push(id); moved.favs++; } });
  ['blocked', 'blockedUsers'].forEach(k => {
    const src = Array.isArray(from[k]) ? from[k] : [];
    if (!Array.isArray(to[k])) to[k] = [];
    src.forEach(v => { if (v && to[k].indexOf(v) === -1) to[k].push(v); });
  });

  // ② 作品：临时号发的作品改挂到目标账号（作者页、作者徽章、上传奖励都按 userId 认人）
  const fromAuthored = new Set(works.filter(w => w.userId === from.id).map(w => w.id));
  works.forEach(w => {
    if (w.userId !== from.id) return;
    w.userId = to.id;
    if (w.author === from.username) w.author = to.username;   // 署名只在没自己改过时才跟着改
    moved.works++;
  });
  // ③ 重复收藏的作品：公开收藏数要回退一格（作者自己收藏本来就不计数，跳过）
  dupFavs.forEach(id => {
    if (fromAuthored.has(id)) return;
    const w = works.find(x => x.id === id);
    if (w && w.userId !== to.id && typeof w.favs === 'number' && w.favs > 0) w.favs -= 1;
  });

  // ④ 评论：作者换成目标账号（评论内容原样保留）
  comments.forEach(c => {
    if (c.userId !== from.id) return;
    c.userId = to.id;
    if (c.username === from.username) c.username = to.username;
    moved.comments++;
  });

  // ⑤ 造梦酒馆：提的想法、认领、点过的「我也想要」
  ideas.forEach(i => {
    let hit = false;
    if (i.userId === from.id) {
      i.userId = to.id;
      if (i.author === from.username) i.author = to.username;
      hit = true;
    }
    if (Array.isArray(i.wantKeys)) {
      const fromKey = 'u:' + from.id, toKey = 'u:' + to.id;
      const at = i.wantKeys.indexOf(fromKey);
      if (at !== -1) {
        i.wantKeys.splice(at, 1);
        if (i.wantKeys.indexOf(toKey) === -1) i.wantKeys.push(toKey);
        else if (typeof i.wants === 'number' && i.wants > 0) i.wants -= 1;   // 两边都点过：热度只算一次
        hit = true;
      }
    }
    if (i.claimer && i.claimer.userId === from.id) { i.claimer.userId = to.id; hit = true; }
    if (hit) moved.ideas++;
  });

  // ⑥ 打赏 / 认领申请 / 进行中的广告投放
  let tipTouched = false;
  tips.forEach(t => {
    if (t.fromUserId === from.id) { t.fromUserId = to.id; tipTouched = true; }
    if (t.toUserId === from.id) { t.toUserId = to.id; tipTouched = true; }
  });
  if (tipTouched) saveTips();
  let claimTouched = false;
  claims.forEach(c => { if (c.userId === from.id) { c.userId = to.id; claimTouched = true; } });
  if (claimTouched) saveClaims();
  let redTouched = false;
  redemptions.forEach(r => { if (r.userId === from.id) { r.userId = to.id; redTouched = true; } });
  if (redTouched) saveRedemptions();

  // ⑦ 兑换码：临时号领走的码转到目标账号，目标账号也领过同一个作品的码就把临时号那张退回可领
  const codeFromKey = 'u:' + from.id, codeToKey = 'u:' + to.id;
  Object.keys(codeStore).forEach(wid => {
    const rec = codeStore[wid];
    if (!rec || !rec.claimed) return;
    const code = rec.claimed[codeFromKey];
    if (!code) return;
    delete rec.claimed[codeFromKey];
    const item = (rec.codes || []).find(c => c.code === code);
    if (!rec.claimed[codeToKey]) {
      rec.claimed[codeToKey] = code;
      if (item && item.takenBy === codeFromKey) item.takenBy = codeToKey;
      moved.codes++;
    } else if (item && item.takenBy === codeFromKey) {
      item.status = 'available';
      item.takenBy = '';
      item.takenAt = null;
    }
  });
  if (moved.codes) saveCodesSoon();

  // ⑧ 灯火 / 签到 / 分享账本（share.json 按 uid 存，余额和明细都要加过去）
  const fr = shareData.users[from.id];
  if (fr) {
    const tr = shareRecOf(to.id);
    tr.points = (tr.points || 0) + (fr.points || 0);
    moved.points = fr.points || 0;
    ['visits', 'regs', 'promoVisits', 'promoRegs', 'promoPoints', 'adminPoints'].forEach(k => {
      if (fr[k]) tr[k] = (tr[k] || 0) + fr[k];
    });
    Object.keys(fr.works || {}).forEach(wid => { tr.works[wid] = (tr.works[wid] || 0) + (fr.works[wid] || 0); });
    Object.keys(fr.byDay || {}).forEach(day => {
      const a = tr.byDay[day] || {}, b = fr.byDay[day] || {};
      tr.byDay[day] = {
        visits: (a.visits || 0) + (b.visits || 0),
        regs: (a.regs || 0) + (b.regs || 0),
        vp: (a.vp || 0) + (b.vp || 0),
        rp: (a.rp || 0) + (b.rp || 0),
      };
    });
    Object.assign(tr.pairs, fr.pairs || {});
    Object.keys(fr.promoBy || {}).forEach(k => { tr.promoBy[k] = (tr.promoBy[k] || 0) + fr.promoBy[k]; });
    if (fr.promoMilestone) tr.promoMilestone = 1;
    if (Array.isArray(fr.log)) {
      tr.log = tr.log.concat(fr.log).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, SHARE_LOG_MAX);
    }
    // 签到：累计天数相加；连签取「更晚签的那份」，不然连签天数会被凭空拉长
    const fck = fr.checkin, tck = tr.checkin;
    if (fck) {
      if (!tck) tr.checkin = fck;
      else {
        const newer = String(fck.last || '') > String(tck.last || '') ? fck : tck;
        tr.checkin = { last: newer.last, streak: newer.streak || 0, total: (tck.total || 0) + (fck.total || 0) };
      }
    }
    delete shareData.users[from.id];
  }

  // ⑨ 站内消息：搬过去，同一个 key 的只留一条（两边都收到过同一条公告是常态）
  notices.forEach(n => { if (n.userId === from.id) { n.userId = to.id; moved.notices++; } });
  const seenNoticeKey = new Set();
  notices = notices.filter(n => {
    if (n.userId !== to.id || !n.key) return true;
    const k = n.userId + '|' + n.key;
    if (seenNoticeKey.has(k)) return false;
    seenNoticeKey.add(k);
    return true;
  });

  // ⑩ 点赞去重表：不搬的话同一个微信换号后能再点一遍，热度就白涨了（计数不回退，历史账不重算）
  Object.keys(likeDedup).forEach(wid => {
    const seen = likeDedup[wid];
    if (!seen || !seen[codeFromKey]) return;
    delete seen[codeFromKey];
    if (!seen[codeToKey]) seen[codeToKey] = 1;
  });
  try { writeJSON('like-dedup.json', likeDedup); } catch (e) { /* 统计落盘失败不影响合并 */ }

  // ⑪ 收藏行为日志（口碑/热度统计用）
  favLog.forEach(e => { if (e.userId === from.id) e.userId = to.id; });
  const seenFav = new Set();
  favLog = favLog.filter(e => {
    const k = e.workId + '|' + e.userId;
    if (seenFav.has(k)) return false;
    seenFav.add(k);
    return true;
  });
  try { writeJSON('fav-log.json', favLog); } catch (e) { /* 同上 */ }

  saveWorks();
  saveComments();
  saveIdeas();
  saveNotices();
  try { writeJSON('share.json', shareData); } catch (e) { /* 灯火落盘失败：内存值已合并，下次写盘会带上 */ }

  // ⑫ 临时号退场：openid 转给目标账号，会话全清（临时号从此登不进来，也没人需要它）
  for (const k of Object.keys(sessions)) {
    if (sessions[k] && sessions[k].uid === from.id) delete sessions[k];
  }
  saveSessions();
  to.wechat = { openid: String(from.wechat.openid), connectedAt: from.wechat.connectedAt || new Date().toISOString() };
  const at = users.findIndex(u => u.id === from.id);
  if (at !== -1) users.splice(at, 1);
  saveUsers();
  return moved;
}

// 合并入口：当前登录的微信临时号 → 校验老账号密码后整份并进去，完成后直接以目标账号登录
app.post('/api/me/wechat/merge', (req, res) => {
  const from = requireUser(req, res);
  if (!from) return;
  if (!rateLimit('wxmerge:' + from.id, 10, 3600e3)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  if (!from.wechat || !from.wechat.openid) return res.status(400).json({ error: '当前账号还没有绑定微信' });
  // 只让「自动建的临时号」走合并：真账号互并不能撤回，别给误操作留口子。
  // 判定用 tempAcct 标记（建号时写入）；passSet=false 是老数据的兜底判定。
  // 不能再用 passSet 单独判定——现在引导临时号用户设密码，设完 passSet 就变了，
  // 若还按老规则拦，用户一设密码「合并到老账号」入口就消失，等于把人往注销重登的路上逼。
  if (from.passSet !== false && !from.tempAcct) {
    return res.status(400).json({ error: '只有自动创建的临时账号才能合并，正式账号不需要合并' });
  }
  const body = req.body || {};
  const target = findUserLoose(String(body.username || '').trim());
  if (!target) return res.status(404).json({ error: '该用户名还没有注册', notFound: true });
  if (target.id === from.id) return res.status(400).json({ error: '这就是当前账号，不用合并' });
  if (target.wechat && target.wechat.openid) {
    return res.status(400).json({ error: '该账号已经绑定了别的微信，请先用那个微信登录并解绑' });
  }
  if (!checkPassword(target, String(body.password || ''))) return res.status(401).json({ error: '用户名或密码错误' });

  const moved = mergeWechatAccountInto(from, target);
  touchActive(target);
  ensureLegacyNick(target);
  setSession(res, target, true, 'pass');   // 目标账号密码刚验过
  res.json({
    ok: true, merged: true,
    username: target.username,
    nickname: target.nickname || '',
    displayName: displayNameOf(target.username),
    moved,
  });
});

// ================= 微信扫码登录（电脑网页 + 小程序码中转） =================
// 个人主体拿不到微信开放平台的「网站应用扫码登录」，用小程序码中转：
//   ① 网页 POST /api/auth/wxscan/start → 生成一次性 ticket（3 分钟有效）
//      → 服务端拿 access_token 调 getUnlimited 生成小程序码（scene=ticket）→ base64 直接给网页显示
//   ② 网页每 2 秒 GET /api/auth/wxscan/poll/:ticket
//   ③ 用户扫码打开小程序确认页（pages/wxlogin/index，scene 带回 ticket）
//      → 页内 wx.login 拿 code → POST /api/auth/wxscan/confirm
//   ④ 后端 code2session 换 openid → 已绑账号则把 ticket 置 confirmed
//   ⑤ 网页轮询到 ok → setSession 种 cookie → 销毁 ticket（取走即焚，一次性）
// 注意：扫码打开的是线上版小程序，确认页要随下个版本发布后才真正可用（生成码用 check_path:false 先放行）。
const WXSCAN_TTL = 3 * 60e3;                 // ticket 3 分钟有效
const wxscanTickets = new Map();             // ticket -> { createdAt, status: 'pending'|'confirmed', uid }
function wxscanCleanup() {
  const now = Date.now();
  for (const [t, s] of wxscanTickets) if (now - s.createdAt > WXSCAN_TTL) wxscanTickets.delete(t);
}
let wxAccessTokenCache = { token: '', exp: 0 };   // access_token 缓存（7200s，提前 5 分钟刷新）
async function wechatAccessToken() {
  if (WECHAT_CONF.mock) return 'mock_token';
  if (wxAccessTokenCache.token && Date.now() < wxAccessTokenCache.exp) return wxAccessTokenCache.token;
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(WECHAT_CONF.appId)
    + '&secret=' + encodeURIComponent(WECHAT_CONF.appSecret);
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('获取微信 access_token 失败（' + (d.errcode || '?') + ' ' + (d.errmsg || '') + '）');
  wxAccessTokenCache = { token: d.access_token, exp: Date.now() + Math.max(60, (d.expires_in || 7200) - 300) * 1000 };
  return wxAccessTokenCache.token;
}
// ① 网页发起：出码。WECHAT_MOCK 本地测试时不出真码，给一张占位 SVG（UI/轮询流程可测，扫不了）
app.post('/api/auth/wxscan/start', async (req, res) => {
  if (!WECHAT_ENABLED) return res.status(400).json({ error: '微信登录未配置' });
  if (!rateLimit('wxscan:' + clientIp(req), 30, 3600e3)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  wxscanCleanup();
  const ticket = crypto.randomBytes(12).toString('hex');
  wxscanTickets.set(ticket, { createdAt: Date.now(), status: 'pending', uid: null });
  try {
    if (WECHAT_CONF.mock) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280"><rect width="280" height="280" fill="#fff"/><rect x="8" y="8" width="264" height="264" fill="none" stroke="#07c160" stroke-width="4" stroke-dasharray="10 6"/><text x="140" y="132" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#07c160">MOCK 二维码</text><text x="140" y="156" text-anchor="middle" font-family="monospace" font-size="11" fill="#666">${ticket.slice(0, 16)}</text></svg>`;
      return res.json({ ticket, qr: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), expiresIn: WXSCAN_TTL / 1000, mock: true });
    }
    const token = await wechatAccessToken();
    const r = await fetch('https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // check_path:false：线上版还没有确认页时也允许出码（页面存在性不校验），发布后自然生效
      body: JSON.stringify({ scene: ticket, page: 'pages/wxlogin/index', check_path: false }),
      signal: AbortSignal.timeout(15000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!(r.headers.get('content-type') || '').includes('image')) {
      let d = {}; try { d = JSON.parse(buf.toString('utf-8')); } catch { /* 非 JSON 也当失败 */ }
      throw new Error('生成小程序码失败（' + (d.errcode || '?') + ' ' + (d.errmsg || '') + '）');
    }
    res.json({ ticket, qr: 'data:image/png;base64,' + buf.toString('base64'), expiresIn: WXSCAN_TTL / 1000 });
  } catch (err) {
    wxscanTickets.delete(ticket);
    res.status(502).json({ error: err.message || '生成二维码失败，请稍后再试' });
  }
});
// ③ 小程序确认页调用：code + 二维码 scene 里的 ticket
app.post('/api/auth/wxscan/confirm', async (req, res) => {
  if (!WECHAT_ENABLED) return res.status(400).json({ error: '微信登录未配置' });
  if (!rateLimit('wxconfirm:' + clientIp(req), 60, 3600e3)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  wxscanCleanup();
  const body = req.body || {};
  const ticket = String(body.ticket || '').trim();
  const t = wxscanTickets.get(ticket);
  if (!t) return res.status(404).json({ error: '登录请求不存在或已过期，请回到电脑刷新二维码', expired: true });
  if (t.status === 'confirmed') return res.json({ ok: true, already: true });   // 幂等：重复确认不报错
  let openid;
  try { openid = await wechatResolveOpenid(body.code); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const user = users.find(u => u.wechat && u.wechat.openid === openid);
  if (!user) {
    // 把「未绑账号」状态记到 ticket 上：网页轮询拿到 needAccount 后会提示用户在手机上做选择，
    // 手机上绑完/建完会用同一个 ticket 重新 confirm（网页不用刷新二维码）
    if (t.status === 'pending') t.status = 'needAccount';
    return res.status(400).json({
      needAccount: true,
      error: '这个微信还没有绑定账号：可以在本页绑定已有账号，或直接用这个微信创建新账号'
    });
  }
  touchActive(user);
  ensureLegacyNick(user);
  t.status = 'confirmed';
  t.uid = user.id;
  res.json({ ok: true, username: user.username, displayName: displayNameOf(user.username) });
});
// ②⑤ 网页轮询：pending / expired / ok（ok 时种会话并销毁 ticket）
app.get('/api/auth/wxscan/poll/:ticket', (req, res) => {
  wxscanCleanup();
  const ticket = String(req.params.ticket || '').trim();
  const t = wxscanTickets.get(ticket);
  if (!t) return res.json({ status: 'expired' });
  if (t.status === 'needAccount') return res.json({ status: 'needAccount' });   // 网页提示引导，继续轮询等手机上完成
  if (t.status !== 'confirmed') return res.json({ status: t.status });
  const user = users.find(u => u.id === t.uid);
  wxscanTickets.delete(ticket);
  if (!user) return res.json({ status: 'expired' });
  setSession(res, user, true, 'wechat');
  touchActive(user);
  // 同 /api/login：前端拿这个响应直接建登录态，passSet / 别名必须带上（否则弹窗误判「当前密码」）
  res.json({ status: 'ok', username: user.username, nickname: user.nickname || '', displayName: displayNameOf(user.username),
    passSet: user.passSet !== false, alias: user.alias || '', aliasNextAt: aliasNextAt(user), wechat: !!user.wechat });
});

// ---- 小程序分享海报二维码 ----
// 海报上印的小程序码：scene 带「作品 id + 分享者 id」，扫码直达小程序详情页，
// 详情页解析 scene 后上报 /api/ref/visit，走和网页分享链接同一套送灯火体系。
// scene 预算：'w:' + workId(12) + ':' + uid(13) = 28 字符 ≤ 微信 32 上限；超长就退化为不带归因的码。
// 同一 workId+ref 的 scene 是确定的，码永远长一样 → 内存缓存，不重复消耗微信生成配额。
const POSTER_SCENE_MAX = 32;
const posterQrCache = new Map();   // key: workId|uid → dataURL
const POSTER_QR_CACHE_MAX = 300;
app.post('/api/mini/poster', async (req, res) => {
  if (!rateLimit('poster:' + clientIp(req), 30, 3600e3)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const body = req.body || {};
  const workId = String(body.workId || '').trim().slice(0, 40);
  const w = works.find(x => x.id === workId && isVisible(x));
  if (!w) return res.status(404).json({ error: '作品不存在或未上线' });
  const user = currentUser(req);
  const uid = user ? user.id : '';
  let scene = 'w:' + workId + (uid ? ':' + uid : '');
  if (scene.length > POSTER_SCENE_MAX) { scene = 'w:' + workId; }   // 归因放不下：出无归因的码，海报照常能用
  const cacheKey = scene;
  if (posterQrCache.has(cacheKey)) return res.json({ qr: posterQrCache.get(cacheKey), cached: true });
  try {
    if (WECHAT_CONF.mock) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="430" height="430"><rect width="430" height="430" fill="#fff"/><rect x="10" y="10" width="410" height="410" fill="none" stroke="#c8cbe0" stroke-width="6" stroke-dasharray="14 10"/><text x="215" y="205" text-anchor="middle" font-size="26" fill="#8a8fa3" font-family="sans-serif">MOCK 小程序码</text><text x="215" y="245" text-anchor="middle" font-size="18" fill="#b0b4c8" font-family="sans-serif">' + scene + '</text></svg>';
      const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      if (posterQrCache.size >= POSTER_QR_CACHE_MAX) {
        const first = posterQrCache.keys().next().value;
        posterQrCache.delete(first);
      }
      posterQrCache.set(cacheKey, url);
      return res.json({ qr: url, mock: true, scene });
    }
    if (!WECHAT_ENABLED) return res.status(400).json({ error: '海报二维码暂不可用（微信未配置）' });
    const token = await wechatAccessToken();
    const r = await fetch('https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // check_path:false：线上版还没有详情页 scene 归因逻辑时也允许出码，发布后自然生效
      body: JSON.stringify({ scene, page: 'pages/detail/index', check_path: false, width: 430 }),
      signal: AbortSignal.timeout(15000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!(r.headers.get('content-type') || '').includes('image')) {
      let d = {}; try { d = JSON.parse(buf.toString('utf-8')); } catch { /* 非 JSON 也当失败 */ }
      throw new Error('生成小程序码失败（' + (d.errcode || '?') + ' ' + (d.errmsg || '') + '）');
    }
    const qr = 'data:image/png;base64,' + buf.toString('base64');
    if (posterQrCache.size >= POSTER_QR_CACHE_MAX) {
      const first = posterQrCache.keys().next().value;
      posterQrCache.delete(first);
    }
    posterQrCache.set(cacheKey, qr);
    res.json({ qr, scene });
  } catch (err) {
    res.status(502).json({ error: err.message || '生成海报二维码失败，请稍后再试' });
  }
});

// 小程序专栏用：本站小程序自己的码（扫码直接进橱窗首页，不带任何归因）
// 和海报码同一个缓存池，生一次存一天够用
app.get('/api/mini/self-qr', async (req, res) => {
  if (!rateLimit('selfqr:' + clientIp(req), 120, 3600e3)) return res.status(429).json({ error: '请求太频繁' });
  const cacheKey = 'self:home';
  if (posterQrCache.has(cacheKey)) return res.json({ qr: posterQrCache.get(cacheKey), cached: true });
  try {
    if (WECHAT_CONF.mock) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="430" height="430"><rect width="430" height="430" fill="#fff"/><rect x="10" y="10" width="410" height="410" fill="none" stroke="#c8cbe0" stroke-width="6" stroke-dasharray="14 10"/><text x="215" y="205" text-anchor="middle" font-size="26" fill="#8a8fa3" font-family="sans-serif">MOCK 小程序码</text><text x="215" y="245" text-anchor="middle" font-size="18" fill="#b0b4c8" font-family="sans-serif">造梦橱窗</text></svg>';
      const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      posterQrCache.set(cacheKey, url);
      return res.json({ qr: url, mock: true });
    }
    if (!WECHAT_ENABLED) return res.status(400).json({ error: '小程序码暂不可用（微信未配置）' });
    const token = await wechatAccessToken();
    const r = await fetch('https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'col', page: 'pages/index/index', check_path: false, width: 430 }),
      signal: AbortSignal.timeout(15000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!(r.headers.get('content-type') || '').includes('image')) {
      let d = {}; try { d = JSON.parse(buf.toString('utf-8')); } catch { /* 非 JSON 也当失败 */ }
      throw new Error('生成小程序码失败（' + (d.errcode || '?') + ' ' + (d.errmsg || '') + '）');
    }
    const qr = 'data:image/png;base64,' + buf.toString('base64');
    if (posterQrCache.size >= POSTER_QR_CACHE_MAX) posterQrCache.delete(posterQrCache.keys().next().value);
    posterQrCache.set(cacheKey, qr);
    res.json({ qr });
  } catch (err) {
    res.status(502).json({ error: err.message || '生成小程序码失败' });
  }
});

// ---- Google 登录 / 绑定（与 GitHub 同构） ----
// start?mode=login   → 未登录也能走，登录后回到 next（默认首页）
// start?mode=bind    → 必须是已登录账号，把 Google 挂到当前账号上
app.get('/api/auth/google/start', (req, res) => {
  if (!GOOGLE_ENABLED) return goErrorRedirect(res, 'google_disabled');
  if (!rateLimit('gostart:' + clientIp(req), 30, 600e3)) return goErrorRedirect(res, 'too_frequent');
  const mode = req.query.mode === 'bind' ? 'bind' : 'login';
  const user = currentUser(req);
  if (mode === 'bind') {
    if (!user) return goErrorRedirect(res, 'bind_need_login');
    if (user.google && user.google.sub) return goErrorRedirect(res, 'google_already_bound');
  }
  goPruneStates();
  const state = crypto.randomBytes(20).toString('hex');
  GO_STATES.set(state, {
    mode,
    uid: mode === 'bind' ? user.id : '',
    next: safeNextPath(req.query.next),
    ref: String(req.query.ref || '').slice(0, 120),
    exp: Date.now() + GO_STATE_TTL
  });
  const url = new URL(GOOGLE_CONF.authBase + '/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CONF.clientId);
  url.searchParams.set('redirect_uri', goCallbackUrl(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');   // 多账号时让用户选哪个 Gmail
  res.redirect(url.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  if (!GOOGLE_ENABLED) return goErrorRedirect(res, 'google_disabled');
  const { code, state, error } = req.query;
  const rec = state && GO_STATES.get(String(state));
  if (state) GO_STATES.delete(String(state));   // 一次性，防重放
  if (!rec || Date.now() > rec.exp) return goErrorRedirect(res, 'state_invalid');
  if (error) return goErrorRedirect(res, String(error) === 'access_denied' ? 'denied' : 'oauth_error');
  if (!code) return goErrorRedirect(res, 'oauth_error');
  if (!rateLimit('gocb:' + clientIp(req), 30, 600e3)) return goErrorRedirect(res, 'too_frequent');

  let g, gUser;
  try {
    const token = await goExchangeToken(code, goCallbackUrl(req));
    gUser = await goFetchUserinfo(token);
    g = goProfileOf(gUser);
  } catch (err) {
    console.warn('[google oauth] 换取用户信息失败:', err.message);
    return goErrorRedirect(res, 'oauth_error');
  }

  // ① 绑定到已登录账号
  if (rec.mode === 'bind') {
    const user = users.find(u => u.id === rec.uid);
    if (!user) return goErrorRedirect(res, 'bind_need_login');   // 跳转期间登出了
    const owner = users.find(u => u.google && u.google.sub === g.sub && u.id !== user.id);
    if (owner) return goErrorRedirect(res, 'google_taken');
    user.google = g;
    saveUsers();
    return res.redirect(withQuery(rec.next, 'google=bound'));
  }

  // ② 登录：按 sub 认人
  const existing = users.find(u => u.google && u.google.sub === g.sub);
  if (existing) {
    // 头像 / 昵称可能改过，每次登录顺手同步一次；绑定时间保留最早那次
    existing.google = { ...g, connectedAt: (existing.google && existing.google.connectedAt) || g.connectedAt };
    saveUsers();
    ensureLegacyNick(existing);
    setSession(res, existing, true, 'oauth');
    return res.redirect(withQuery(rec.next, 'google=login'));
  }

  // ③ 第一次来：Google 建号（随机密码 + passSet=false，登录后可以自己设密码）
  const user = makeGoogleUser(gUser);
  user.regIp = ipKeyOf(req);
  users.push(user);
  saveUsers();
  try { pushChronicleWelcome(user); } catch (e) { /* 消息失败不影响登录 */ }
  try { creditShareRegister(req, user, rec.ref); } catch (e) { /* 邀请奖励失败不影响登录 */ }
  setSession(res, user, true, 'oauth');
  res.redirect(withQuery(rec.next, 'google=new'));
});

// 解绑：Google 建号且还没设密码的不能解（同 GitHub 规则）
app.post('/api/me/google/unbind', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!user.google || !user.google.sub) return res.status(400).json({ error: '当前账号还没有绑定 Google' });
  if (user.passSet === false) {
    return res.status(400).json({ error: '请先设置一个登录密码，再解绑 Google，否则解绑后就登不进来了', needPassword: true });
  }
  delete user.google;
  saveUsers();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (user) ensureLegacyNick(user);   // 永久免登录的老用户不会走登录接口，这里兜住「用账号」这个时机
  const providers = { github: GH_ENABLED, google: GOOGLE_ENABLED, wechat: WECHAT_ENABLED };   // 没配对应登录方式时前端不显示入口
  res.json(user
    ? {
        id: user.id,
        username: user.username, createdAt: user.createdAt,
        nickname: user.nickname || '',
        displayName: displayNameOf(user.username),
        nicknameNextAt: nickNextAt(user),
        blocked: Array.isArray(user.blocked) ? user.blocked : [],
        blockedUsers: Array.isArray(user.blockedUsers) ? user.blockedUsers : [],
        favs: Array.isArray(user.favs) ? user.favs : [],
        checkin: checkinView(user),
        points: shareStatsOf(user.id).points,
        unreadNotices: notices.filter(n => n.userId === user.id && !n.read).length,
        // 站方公告是否屏蔽提示（true = 正常弹提示；false = 只进列表不弹窗）
        noticePrefs: { announce: !announceMuted(user) },
        worksCount: works.filter(w => w.userId === user.id && !w.deleted).length,
        passSet: user.passSet !== false,            // false = OAuth 建号还没设密码
        alias: user.alias || '',                    // 登录别名（自己起的好记名字，登录用，不对外展示）
        aliasNextAt: aliasNextAt(user),
        // 临时号标记：还能不能走「合并到老账号」（passSet=false 是老数据兜底，见 merge 路由注释）
        tempAcct: user.passSet === false || !!user.tempAcct,
        github: user.github && user.github.id
          ? {
              login: user.github.login || '',
              name: user.github.name || '',
              avatar: user.github.avatar || '',
              url: user.github.url || '',
              connectedAt: user.github.connectedAt || ''
            }
          : null,
        google: user.google && user.google.sub
          ? {
              sub: user.google.sub,
              name: user.google.name || '',
              email: user.google.email || '',
              emailVerified: user.google.emailVerified !== false,
              picture: user.google.picture || '',
              connectedAt: user.google.connectedAt || ''
            }
          : null,
        wechat: user.wechat && user.wechat.openid
          ? { connectedAt: user.wechat.connectedAt || '' }   // openid 不回传前端，用不上还泄露身份
          : null,
        // 没绑微信且没领过 → 前端在「微信未绑定」那一行显示「绑定 +300 盏灯火」
        wxBindBonus: wxBindBonusState(user),
        providers
      }
    : { user: null, providers });
});

// ================= 改昵称 =================
const NICK_COOLDOWN_MS = 7 * 24 * 3600e3;   // 昵称 7 天才能改一次，防改名刷屏
const NICK_RE = /^[\w\u4e00-\u9fa5·\- ]{2,16}$/;

// 下次可改时间（毫秒时间戳，0 表示现在就能改）
function nickNextAt(user) {
  const last = user && Number(user.nicknameChangedAt || 0);
  if (!last) return 0;
  const next = last + NICK_COOLDOWN_MS;
  return next > Date.now() ? next : 0;
}

// 昵称清洗 + 校验：注册、GitHub 建号、改昵称三处共用，规则只写一遍
// 返回 { nick, error, code }：nick 为空表示「用账号名当展示名」
// 昵称**允许重名**（和微信 / 微博 / 小红书一样：昵称是展示用的马甲，身份锚点是唯一的账号名 +
// 唯一的作者页 /u/<账号>）。硬性唯一会带来三个真问题：GitHub / Google 授权带回来的显示名可能是
// 别人已经在用的，建号就得偷偷给你改名；用户自己就想叫「老张」却不让注册；以及抢到「做产品的阿吉」
// 之后第二个人叫「做产品的阿吉 2」看着还是同一个人，治不了根。
// 所以唯一性只约束「系统随机生成的名字」这一条路径（randomFreeNick），用户手填的一律放行。
function nickTaken(nick, self) {
  if (!nick) return false;
  const low = nick.toLowerCase();   // 阿May / 阿may 视为同一个，别靠大小写钻空子
  return users.some(u => (!self || u.id !== self.id) && (u.nickname || '').toLowerCase() === low);
}
function nickParse(input, self) {
  const nick = String(input || '').replace(/[<>\r\n\t]/g, '').trim();
  if (!nick) return { nick: '' };
  if (self && nick === self.username) return { nick: '' };   // 填回账号名 = 恢复默认
  if (!NICK_RE.test(nick)) {
    return { error: '昵称需 2-16 个字，可用中文、字母、数字、下划线、短横线、空格' };
  }
  // 昵称才是公开展示的那个名字，冒充站方的风险比账号名更高：
  // 保留词、词根、形近（管理員/官方客服/adm1n）、导流词都按同一套规则拦
  const impErr = nameImpersonation(nick);
  if (impErr) {
    // 文案里保留「昵称」二字：前端靠它判断「随机名被拦 → 自动换一个」
    const msg = impErr.replace(/^这个名字/, '这个昵称').replace(/^名字里/, '昵称里');
    return { error: msg };
  }
  if (hitSensitive(nick)) return { error: '昵称包含敏感词，换一个吧' };
  // 昵称不能跟别人的账号名一模一样（也不分大小写），否则在页面上分不清是谁（防冒名）
  const clash = users.find(u => u.username.toLowerCase() === nick.toLowerCase() && (!self || u.id !== self.id));
  if (clash) return { error: '这个昵称和别人的账号名重了，换一个吧', code: 'name_taken' };
  return { nick };
}

// ================= 老用户补随机昵称 =================
// 现在注册都会带一个随机昵称，但更早的老用户 nickname 是空的，展示名直接回落到
// 随手拼的账号名（gallerytest1172 这种），上墙不好看。用账号（登录 / 带着 session 访问）时补一个。
// 规则（用户拍板）：
//   · 已经有昵称的 → 不动
//   · 账号名是汉字的 → 不动（汉字账号名本身就是不错的展示名）
//   · 其余（昵称空 + 字母数字账号名）→ 随机补一个昵称（注册同款「做小程序的老张」词库），并发站内通知告知
// 只自动补一次（nickAutoAt 标记）：之后用户把昵称清空恢复默认，也不再自动塞名字。
// 词库与 frontend/app.js 注册预填保持一致（新老用户风格统一）；act 以英文字母收尾时和「的」之间留空格
// 组合数 = 45 个动作 × 65 个称呼 = 2925 种（原来只有 11×14=154，二三十人就会撞名）。
// 前 11 个动作 / 前 14 个称呼是原始词库，别删别改顺序：已经发出去的名字都长这样，保证风格连贯。
const NICK_ACTS = [
  // —— 原始词库（保留）——
  '做小程序', '做网站', '做 AI 应用', '做插件', '做游戏', '写代码', '做工具', '折腾 AI', '独立开发', '做产品', '做设计',
  // —— 扩充：端上 / 模型 / 数据 / 内容 / 增长 ——
  '做 App', '写前端', '写后端', '做自动化', '做机器人', '训练模型', '调模型', '玩提示词', '做副业', '做开源',
  '做笔记', '做效率工具', '做浏览器插件', '做小工具', '做数据看板', '做落地页', '做知识库', '做 Agent', '做工作流', '写脚本',
  '做爬虫', '做 SaaS', '做公众号', '做视频', '做内容', '做自媒体', '做增长', '做界面', '画原型', '做导航站',
  '做书签', '做翻译工具', '做问答机器人', '做语音应用'
];
const NICK_WHOS = [
  // —— 原始词库（保留）——
  '老张', '小李', '小王', '老陈', '阿May', '小周', '阿灿', '小满', '阿吉', '大鹏', '阿星', '小鹿', '老白', '阿飞',
  // —— 扩充：老X / 小X / 阿X / 大X 四组，都控制在 4 字以内，拼出来不超过昵称 16 字上限 ——
  '老刘', '老李', '老王', '老赵', '老孙', '老徐', '老黄', '老吴', '老郑', '老马', '老范', '老许',
  '小陈', '小林', '小杨', '小黄', '小徐', '小郭', '小何', '小高', '小罗', '小郑', '小梁', '小宋', '小唐', '小冯', '小苏', '小丁',
  '阿杰', '阿伟', '阿涛', '阿锋', '阿亮', '阿龙', '阿明', '阿华', '阿坤', '阿诚', '阿哲', '阿宁', '阿原', '阿泽', '阿木', '阿海', '阿德', '阿俊', '阿峰',
  '大熊', '大伟', '大康', '大川'
];
// 系统生成的随机名一律避开已被占用的（昵称允许用户手填重名，但系统自己造的名字不能撞：
// 一堆「做产品的阿吉」挂在墙上，是系统造成的困扰，不是用户造成的）。
// 两个调用方：老用户补名 ensureLegacyNick / 注册时预填名被占用的自动换名。
function randomFreeNick() {
  const taken = new Set(users.map(u => (u.nickname || '').toLowerCase()));
  for (let i = 0; i < 200; i++) {
    const act = NICK_ACTS[(Math.random() * NICK_ACTS.length) | 0];
    const who = NICK_WHOS[(Math.random() * NICK_WHOS.length) | 0];
    let cand = act + (/[\w]$/.test(act) ? ' 的' : '的') + who;      // 做小程序的老张 / 折腾 AI 的阿May
    if (i > 60) cand = who + String(((Math.random() * 90) | 0) + 10); // 组合快撞完时换小号格式兜底
    const { nick, error } = nickParse(cand, null);                   // 复用注册同一套校验（敏感词/保留字/撞账号名）
    if (nick && !error && !taken.has(nick.toLowerCase())) return nick;
  }
  return '小可爱' + String(Date.now()).slice(-5);                     // 兜底，理论上到不了
}
function ensureLegacyNick(user) {
  if (!user || user.nickname) return;                              // 有名字：不改
  if (/[\u4e00-\u9fa5]/.test(user.username || '')) return;         // 账号名是汉字：不改
  if (user.nickAutoAt) return;                                     // 只自动补一次
  const nick = randomFreeNick();
  if (!nick) return;
  user.nickname = nick;
  user.nickAutoAt = new Date().toISOString();
  // 注：不写 nicknameChangedAt —— 自动补名不算用户改名，之后第一次自己改名不受 7 天冷却限制
  saveUsers();
  addNotice(user.id, {
    kind: 'system',
    title: '给你起了个展示名：' + nick,
    text: '你之前一直顶着账号名「' + user.username + '」展示，不太上镜。系统刚随机给了你一个昵称「' + nick +
      '」，作品署名和评论都会用它。账号、登录、作品归属都不变；不喜欢的话，去「账号设置 → 改昵称」马上就能换成自己的（改过一次后 7 天内不能再改）。'
  });
}

app.post('/api/me/nickname', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('nick:' + clientIp(req), 10, 3600e3)) {
    return res.status(429).json({ error: '改得太频繁了，稍后再试' });
  }
  const raw = String((req.body && req.body.nickname) || '').replace(/[<>\r\n\t]/g, '').trim();
  // 传空 = 恢复默认（显示账号名），随时可以恢复，不受冷却限制
  const back = !raw || raw === user.username;
  if (!back) {
    const { error } = nickParse(raw, user);
    if (error) return res.status(400).json({ error });
    // AI 初审：昵称也过一遍智谱（免费），明确违规直接拒绝；AI 不可用时放行（敏感词兜底 + 后台可改）
    const ai = await aiReviewGate('用户昵称：' + raw);
    if (ai.pass === false) {
      return res.status(400).json({ error: '这个昵称疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，换一个吧' });
    }
    const next = nickNextAt(user);
    if (next) {
      const days = Math.ceil((next - Date.now()) / 864e5);
      return res.status(429).json({ error: `昵称 7 天只能改一次，还有 ${days} 天可以再改`, nextAt: next });
    }
  }
  user.nickname = back ? '' : raw;
  user.nicknameChangedAt = back ? (user.nicknameChangedAt || 0) : Date.now();
  saveUsers();
  res.json({ ok: true, nickname: user.nickname, displayName: displayNameOf(user.username), nicknameNextAt: nickNextAt(user) });
});

// ---- 修改密码 ----
app.post('/api/me/password', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('pwd:' + user.id, 5, 3600e3)) {
    return res.status(429).json({ error: '尝试太频繁了，请一小时后再试' });
  }
  const { currentPassword, newPassword } = req.body || {};
  // GitHub 建号的账号没有可用密码（随机生成且用户不知道），这里允许直接设置新密码
  const hasPass = user.passSet !== false;
  // ---- 微信验证重设（找回密码的落地形式）----
  // 绑了微信的号设完密码又忘了：微信登录本身就是身份验证，允许免旧密码重设。
  // 但要求当前会话是「微信登录签发且 10 分钟内」——防止会话被偷后攻击者顺手改密码锁死账号；
  // 过期就让用户退出后重新微信扫码登录（等于重新验一次身份），不提供绕过路径。
  const WX_RESET_FRESH_MS = 10 * 60e3;
  const sess = sessionVia(req);
  const wxFresh = !!(sess && sess.via === 'wechat' && sess.iat > Date.now() - WX_RESET_FRESH_MS);
  if (req.body && req.body.wechatReset) {
    if (!(user.wechat && user.wechat.openid)) {
      return res.status(400).json({ error: '这个账号没有绑定微信，无法用微信验证重设密码' });
    }
    if (!wxFresh) {
      return res.status(401).json({
        error: '微信验证已过期：退出登录后重新用微信扫码登录，再回来重设密码',
        needWxLogin: true,
      });
    }
  } else if (hasPass && !checkPassword(user, String(currentPassword || ''))) {
    return res.status(400).json({ error: '当前密码不正确' });
  }
  const np = String(newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (np.length > 64) return res.status(400).json({ error: '新密码最多 64 位' });
  if (hasPass && checkPassword(user, np)) return res.status(400).json({ error: '新密码不能和当前密码一样' });
  // 换新盐重新哈希
  user.salt = crypto.randomBytes(16).toString('hex');
  user.pass = hashPassword(np, user.salt);
  user.passSet = true;
  user.passChangedAt = new Date().toISOString();
  saveUsers();
  // 改密后把其他设备全部踢下线（当前这个会话保留，免得自己被登出）
  const sid = parseCookies(req).sid;
  let kicked = 0;
  for (const k of Object.keys(sessions)) {
    if (sessions[k].uid === user.id && k !== sid) { delete sessions[k]; kicked++; }
  }
  if (kicked) saveSessions();
  res.json({ ok: true, kicked });
});

// ---- 设置登录别名 ----
// username 是身份主键（历史分享链接 ref、@提及、认领、后台引用都认它），直接改牵连太广，
// 所以微信 / OAuth 自动建号的号通过 alias 拿到一个自己记得住的登录名：
// 登录时「别名 或 账号名 + 密码」都认（findUserLoose），所有数据关联全挂在 user.id 上，改别名不碰历史。
// 不展示、不进任何公开页，纯粹是登录凭证之一 —— 和昵称（展示名）是两回事。
const ALIAS_COOLDOWN_MS = 30 * 24 * 3600e3;   // 首次设置不限次数，之后 30 天才能改一次（防来回换名冒充）
function aliasNextAt(user) {
  const last = user && Number(user.aliasChangedAt || 0);
  if (!last) return 0;
  const next = last + ALIAS_COOLDOWN_MS;
  return next > Date.now() ? next : 0;
}
app.post('/api/me/alias', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('alias:' + user.id, 5, 3600e3)) {
    return res.status(429).json({ error: '尝试太频繁了，请一小时后再试' });
  }
  const name = String((req.body && req.body.alias) || '').trim();
  if (!NAME_RE.test(name)) return res.status(400).json({ error: '登录名需 2-20 位，可为中文、字母、数字、下划线' });
  if (user.alias && name.toLowerCase() === String(user.alias).toLowerCase()) {
    return res.json({ ok: true, alias: user.alias, aliasNextAt: aliasNextAt(user) });
  }
  const shapeErr = nameShapeError(name);
  if (shapeErr) return res.status(400).json({ error: shapeErr });
  const impErr = nameImpersonation(name);
  if (impErr) return res.status(400).json({ error: impErr });
  if (hitSensitive(name)) return res.status(400).json({ error: '登录名包含敏感词，换一个吧' });
  // 冒充防线：不能撞别人的账号名 / 别人的登录别名 / 未认领的认证创作者名（与注册同一套规则）
  if (users.find(u => u.id !== user.id && u.username.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: '这个登录名和别人的账号名重复了，换一个吧' });
  }
  if (users.find(u => u.id !== user.id && String(u.alias || '').toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: '这个登录名已经被占用，换一个吧' });
  }
  if (creators.some(c => c.name === name && !creatorAccountOf(c.name))) {
    return res.status(400).json({ error: '这个名字已被站内认证创作者占用，如是你本人请联系站长核实' });
  }
  // 已经设过别名：30 天冷却；已设密码的还要输当前密码确认身份（防止会话被偷后悄悄换登录名）
  if (user.alias) {
    const next = aliasNextAt(user);
    if (next) {
      const days = Math.ceil((next - Date.now()) / 864e5);
      return res.status(429).json({ error: `登录名 30 天只能改一次，还有 ${days} 天可以再改`, nextAt: next });
    }
    if (user.passSet !== false && !checkPassword(user, String((req.body && req.body.currentPassword) || ''))) {
      return res.status(400).json({ error: '请先输入当前登录密码确认身份', needPassword: true });
    }
  }
  user.alias = name;
  user.aliasChangedAt = Date.now();
  saveUsers();
  res.json({ ok: true, alias: user.alias, aliasNextAt: aliasNextAt(user) });
});

// ---- 注销账号（不可恢复） ----
// 双确认：密码 + 完整账号名。作品可选「保留（解除归属，署名保留）」或「一并删除」；
// 评论/造梦酒馆内容保留但匿名化；认领申请、广告投放、积分与分享记录、被领兑换码一并清理。
const DELETED_AUTHOR = '已注销用户';

app.post('/api/me/delete', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('delacct:' + user.id, 5, 3600e3)) {
    return res.status(429).json({ error: '操作太频繁了，请稍后再试' });
  }
  const body = req.body || {};
  // 双确认输入的是账号名或登录别名（别名用户可能压根不知道自己的 wx_xxx 系统账号名）
  const confirmName = String(body.confirmName || '').trim();
  if (confirmName !== user.username && confirmName.toLowerCase() !== String(user.alias || '').toLowerCase()) {
    return res.status(400).json({ error: '请完整输入你的账号名以确认注销' });
  }
  // GitHub 建号的账号从没设过密码，就没法拿密码做二次校验了，只认账号名
  if (user.passSet !== false && !checkPassword(user, String(body.password || ''))) {
    return res.status(400).json({ error: '密码不正确' });
  }

  const wipeWorks = body.deleteWorks === true || String(body.deleteWorks) === '1';
  const mine = works.filter(w => w.userId === user.id && !w.deleted);
  let worksDeleted = 0;

  // 草稿箱：账号没了就不该留残留（连同图片一起清，不留孤儿文件）
  {
    const myDr = drafts.filter(d => d.userId === user.id);
    if (myDr.length) {
      myDr.forEach(d => draftFiles(d).forEach(removeUpload));
      drafts = drafts.filter(d => d.userId !== user.id);
      saveDrafts();
    }
  }

  if (wipeWorks) {
    const ids = new Set(mine.map(w => w.id));
    works = works.filter(w => !ids.has(w.id));
    worksDeleted = ids.size;
    comments = comments.filter(c => !ids.has(c.workId));
    invalidateCommentCounts();
    mine.forEach(w => {
      [w.image, w.thumb, w.qrcode].concat(w.images || []).forEach(img => {
        if (!img) return;
        const p = path.join(UPLOAD_DIR, path.basename(img));
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) { /* 图片删不掉不影响注销 */ } }
      });
      delete codeStore[w.id];   // 作品的兑换码一起清掉
    });
    saveCodesSoon();
    saveWorks();
    saveComments();
  } else {
    // 保留作品：解除账号归属（别人 / 同名新账号都接管不了），署名原样保留
    mine.forEach(w => {
      delete w.userId;
      delete w.ownerReal;
      delete w.authorReal;
      w.claimOpen = false;
    });
    if (mine.length) saveWorks();
  }

  // 收藏：作品上的聚合计数回退，行为日志清掉
  let favRollback = false;
  (user.favs || []).forEach(id => {
    const w = works.find(x => x.id === id);
    if (w && typeof w.favs === 'number' && w.favs > 0) { w.favs -= 1; favRollback = true; }
  });
  if (favRollback) saveWorks();
  favLog = favLog.filter(e => e.userId !== user.id);

  // 评论 / 造梦酒馆：内容保留，作者名匿名化（不留下昵称线索）
  let cmtAnon = false;
  comments.forEach(c => {
    if (c.userId !== user.id) return;
    delete c.userId;
    c.username = DELETED_AUTHOR;
    cmtAnon = true;
  });
  if (cmtAnon) saveComments();
  let ideaAnon = false;
  ideas.forEach(i => {
    if (i.userId !== user.id) return;
    delete i.userId;
    i.author = DELETED_AUTHOR;
    ideaAnon = true;
  });
  if (ideaAnon) saveIdeas();
  // 想法下的讨论同样是 UGC，注销后内容保留、署名匿名化
  let discAnon = false;
  ideaDiscussions.forEach(d => {
    if (d.userId !== user.id) return;
    delete d.userId;
    d.author = DELETED_AUTHOR;
    discAnon = true;
  });
  if (discAnon) saveIdeaDiscussions();

  // 打赏记录：账本保留（对账），打赏者名匿名化
  let tipAnon = false;
  tips.forEach(t => {
    if (t.fromUserId !== user.id) return;
    delete t.fromUserId;
    t.fromDisplay = DELETED_AUTHOR;
    tipAnon = true;
  });
  if (tipAnon) saveTips();

  // 认领申请：随账号撤回
  const claimBefore = claims.length;
  claims = claims.filter(c => c.userId !== user.id);
  if (claims.length !== claimBefore) saveClaims();

  // 进行中的广告投放：结束（账号没了，没人能管理，继续挂只会白烧曝光）
  let adEnded = false;
  redemptions.forEach(r => {
    if (r.userId !== user.id) return;
    adEnded = true;
    if (r.status === 'active') { r.status = 'cancelled'; r.endedAt = Date.now(); }
  });
  if (adEnded) saveRedemptions();

  // 兑换码：这个账号领走的码退回「未领」，别人还能领
  let codesFreed = 0;
  Object.keys(codeStore).forEach(wid => {
    const rec = codeStore[wid];
    if (!rec || !rec.claimed) return;
    const key = 'u:' + user.id;
    const code = rec.claimed[key];
    if (!code) return;
    delete rec.claimed[key];
    const item = (rec.codes || []).find(c => c.code === code);
    if (item && item.takenBy === key) { item.status = 'available'; item.takenBy = ''; item.takenAt = null; }
    codesFreed++;
  });
  if (codesFreed) saveCodesSoon();

  // 积分与分享记录（含 IP 明细里指向该账号的键）
  delete shareData.users[user.id];
  Object.keys(shareData.ips || {}).forEach(ip => {
    const rec = shareData.ips[ip];
    if (!rec || typeof rec !== 'object') return;
    ['v', 'd'].forEach(k => {
      if (!rec[k]) return;
      Object.keys(rec[k]).forEach(x => { if (String(x).startsWith(user.id + '|')) delete rec[k][x]; });
    });
    if (rec.refRegs && rec.refRegs[user.id]) delete rec.refRegs[user.id];
    if (rec.attr && rec.attr.uid === user.id) delete rec.attr;
  });
  saveShareSoon();

  // 站内消息：随账号一起清除
  const noticeBefore = notices.length;
  notices = notices.filter(n => n.userId !== user.id);
  if (notices.length !== noticeBefore) saveNotices();

  // 认证创作者标记：账号注销后不再显示认证
  const cIdx = creators.findIndex(c => c.name === user.username);
  if (cIdx !== -1) { creators.splice(cIdx, 1); writeJSON('creators.json', creators); }

  // 账号本体 + 所有会话
  const idx = users.findIndex(u => u.id === user.id);
  if (idx !== -1) users.splice(idx, 1);
  saveUsers();
  forgetUserBlocks(user.id);   // 屏蔽票随账号一起撤掉，别留在统计里虚高
  for (const k of Object.keys(sessions)) {
    if (sessions[k] && sessions[k].uid === user.id) delete sessions[k];
  }
  saveSessions();
  clearSession(req, res);
  res.json({ ok: true, worksDeleted, worksKept: wipeWorks ? 0 : mine.length, codesFreed });
});

// 屏蔽 / 取消屏蔽某个作品（仅影响当前登录用户看到的列表）
app.post('/api/works/:id/block', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('block:' + user.id, 60, 60000)) {
    return res.status(429).json({ error: '操作过于频繁，稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId && w.userId === user.id) {
    return res.status(400).json({ error: '不能屏蔽自己发布的作品' });
  }
  if (!Array.isArray(user.blocked)) user.blocked = [];
  const on = !(req.body && req.body.on === false); // 默认屏蔽；传 on:false 为取消
  const i = user.blocked.indexOf(w.id);
  if (on && i === -1) user.blocked.unshift(w.id);
  if (!on && i !== -1) user.blocked.splice(i, 1);
  saveUsers();
  // 首页「最新」的降权计数（只统计人数/权重，不看次数；作者自己的屏蔽被上面的校验挡掉了）
  recordBlockStat(user, w.id, on);
  res.json({ blocked: user.blocked, on });
});

// 我屏蔽的作品（用于「已屏蔽」列表里恢复）
app.get('/api/blocked', (req, res) => {  const user = requireUser(req, res);
  if (!user) return;
  const ids = Array.isArray(user.blocked) ? user.blocked : [];
  const map = new Map(works.map(w => [w.id, w]));
  const list = ids.map(id => map.get(id)).filter(w => w && isVisible(w)).map(w => publicWork(w, user));
  res.json(list);
});

// 拉黑 / 取消拉黑某个作者：TA 的所有作品都不再出现在我的列表里（含以后新发的）
app.post('/api/users/:name/block', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('ublock:' + user.id, 30, 60000)) {
    return res.status(429).json({ error: '操作过于频繁，稍后再试' });
  }
  const name = decodeURIComponent(req.params.name || '');
  const target = users.find(u => u.username === name);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === user.id) return res.status(400).json({ error: '不能拉黑自己' });
  if (!Array.isArray(user.blockedUsers)) user.blockedUsers = [];
  const on = !(req.body && req.body.on === false); // 默认拉黑；传 on:false 为取消
  const i = user.blockedUsers.indexOf(name);
  if (on && i === -1) user.blockedUsers.unshift(name);
  if (!on && i !== -1) user.blockedUsers.splice(i, 1);
  saveUsers();
  res.json({ blockedUsers: user.blockedUsers, on });
});

// 我拉黑的作者列表（含各自当前可见作品数，用于解除拉黑）
app.get('/api/blocked-users', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const names = Array.isArray(user.blockedUsers) ? user.blockedUsers : [];
  const list = names.map(name => {
    const u = users.find(x => x.username === name);
    return {
      username: name,
      nickname: u ? (u.nickname || u.username) : name,
      works: works.filter(w => w.author === name && isVisible(w) && !(w.anonymous === true)).length
    };
  });
  res.json(list);
});

// ---- 认领作品：提交证据 → 管理员审核 ----
const CLAIM_EVIDENCE_MIN = 10;

app.post('/api/works/:id/claim', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('claim:' + user.id, 5, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId === user.id) return res.status(400).json({ error: '这是你自己发布的作品，无需认领' });
  // 认领由管理员逐条开放；无归属作品（匿名投稿 / 后台代传）默认开放
  if (!isClaimable(w)) return res.status(400).json({ error: '该作品暂未开放认领' });
  const evidence = String((req.body && req.body.evidence) || '').trim();
  if (evidence.length < CLAIM_EVIDENCE_MIN) {
    return res.status(400).json({ error: `请提供能证明你是作者的证据（至少 ${CLAIM_EVIDENCE_MIN} 个字）` });
  }
  if (evidence.length > 1000) return res.status(400).json({ error: '证据描述最多 1000 字' });
  if (claims.some(c => c.workId === w.id && c.userId === user.id && c.status === 'pending')) {
    return res.status(400).json({ error: '你已提交过认领申请，正在审核中' });
  }
  // AI 初审：认领本来就要人工审，AI 意见只存档给管理员参考，不直接拒绝（避免误伤真作者）
  const ai = await aiReviewGate('作品认领申请证据：' + evidence);
  const claim = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    userId: user.id,
    username: user.username,
    evidence: evidence.slice(0, 1000),
    contact: String((req.body && req.body.contact) || '').trim().slice(0, 100),
    status: 'pending',
    aiReview: ai,
    createdAt: new Date().toISOString()
  };
  claims.unshift(claim);
  saveClaims();
  res.status(201).json({ ok: true, claim: { id: claim.id, status: claim.status } });
});

// 我的认领记录（前端用来显示「审核中 / 已通过」状态）
// ---- 站内消息（积分变动、系统通知）----
app.get('/api/me/notices', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const mine = notices.filter(n => n.userId === user.id);
  res.json({
    items: mine.slice(0, 30).map(n => {
      // 意见反馈会话：往来消息以 feedback.thread 为准（站内消息只是入口，不另存一份，免得两边打架）
      let thread = Array.isArray(n.thread) ? n.thread : [];
      if (n.feedbackId) {
        const f = feedback.find(x => x.id === n.feedbackId);
        thread = f ? fbThread(f) : [];
      }
      return {
        id: n.id, kind: n.kind, title: n.title, text: n.text,
        points: n.points || 0, delta: n.delta || 0, read: !!n.read,
        workId: n.workId || null, commentId: n.commentId || null, createdAt: n.createdAt,
        link: n.link || '',                            // 站内跳转（如 /chronicle）
        muted: !!n.muted,                              // true = 用户屏蔽了提示：照常收到，不弹窗
        feedbackId: n.feedbackId || null,
        thread, threadId: n.threadId || n.id
      };
    }),
    unread: mine.filter(n => !n.read).length
  });
});

// 标记已读：带 id 标记单条，不带就全部标记
app.post('/api/me/notices/read', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const id = String((req.body && req.body.id) || '');
  let changed = 0;
  notices.forEach(n => {
    if (n.userId !== user.id || n.read) return;
    if (id && n.id !== id) return;
    n.read = true;
    changed++;
  });
  if (changed) saveNotices();
  // 打开消息列表 / 全部已读，等于也看过了反馈里的回复（反馈悬浮球的小红点跟着灭）
  let fbChanged = 0;
  feedback.forEach(f => { if (f.userId === user.id) fbChanged += fbMarkReadByUser(f); });
  if (fbChanged) saveFeedback();
  res.json({ ok: true, changed });
});

// 消息偏好：目前只有一项「屏蔽系统消息」——不是拒收，公告照常进铃铛列表，
// 只是不再弹提示（列表里标 muted，前端不弹 toast）。
app.post('/api/me/notices/prefs', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!user.noticePrefs || typeof user.noticePrefs !== 'object') user.noticePrefs = {};
  if (req.body && typeof req.body.announce === 'boolean') user.noticePrefs.announce = req.body.announce;
  saveUsers();
  res.json({ ok: true, noticePrefs: { announce: !announceMuted(user) } });
});

// 作者回复管理员的精选 / 消息通知（双向会话：消息写回会话容器，后台「消息」页签轮询可见）
// 意见反馈的会话也复用这条通道：写回 feedback.thread，后台「意见反馈」页签里能看到
app.post('/api/me/notices/reply', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const threadId = String((req.body && req.body.threadId) || '');
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!threadId || text.length < 1) return res.status(400).json({ error: '内容不能为空' });
  const container = notices.find(n => n.id === threadId && n.userId === user.id);
  if (!container) return res.status(404).json({ error: '对话不存在' });
  const now = new Date().toISOString();
  if (container.feedbackId) {
    const f = feedback.find(x => x.id === container.feedbackId);
    if (!f) return res.status(404).json({ error: '反馈不存在' });
    fbThread(f).push({ from: 'user', fromName: user.nickname || user.username || '作者', text, at: now, read: false });
    f.status = '待查看';
    f.lastAt = now;
    saveFeedback();
    return res.json({ ok: true });
  }
  container.thread = container.thread || [];
  container.thread.push({ from: 'user', fromId: user.id, fromName: user.username || '作者', text, at: now, read: false });
  saveNotices();
  res.json({ ok: true });
});

app.get('/api/me/claims', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json(claims.filter(c => c.userId === user.id)
    .map(c => ({ id: c.id, workId: c.workId, status: c.status, createdAt: c.createdAt })));
});

// 作者数据看板：我发布 / 已认领的作品，含累计数据与近 14 天浏览趋势
// ---------- 灯光明细（只读） ----------
// 数据来自 share.json 里的逐笔流水（addPoints / pushShareLog 记的 {t, kind, workId, points}）。
// 目的只有一个：让用户看清每一盏灯火从哪来、花到哪去，不用靠站内消息那一下弹窗去记。
// 只读，不动任何余额。也不给「余额快照」——流水只保留最近 SHARE_LOG_MAX 笔，
// 按它倒推历史余额会算出假账（尤其扣款那几笔之后），所以只给每笔的加减。
const POINTS_KIND_TEXT = {
  visit: '分享链接带来访问',
  scan: '有人扫了你的分享码',
  reg: '好友通过你的链接注册',
  promo: '外宣里程碑奖励',
  upload: '上传作品奖励',
  os: '开源作品奖励',
  'os-recall': '开源奖励已收回',
  star: 'GitHub star 奖励',
  checkin: '每日签到',
  adreward: '看激励视频奖励',
  pwa: '添加到桌面奖励',
  wxbind: '绑定微信奖励',
  gift: '站长激励',
  admin: '站长调整',
  tip_in: '收到打赏',
  tip_in_claim: '匿名期间收到的灯火归账',
  tipad_in: '有人看完广告为你的作品点灯',
  tip_out: '打赏给作者',
  redeem: '买推荐位',
  refund: '推广撤回 / 到期退回'
};
app.get('/api/me/points-log', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rec = shareRecOf(user.id);
  const raw = Array.isArray(rec.log) ? rec.log.slice(0, SHARE_LOG_MAX) : [];
  // 只给用到的那几个作品建索引，别为了 60 条流水把整个作品库遍历成 Map
  const need = new Set(raw.map(e => e && e.workId).filter(Boolean));
  const wmap = new Map();
  if (need.size) works.forEach(w => { if (need.has(w.id)) wmap.set(w.id, w); });
  const log = raw.map(e => {
    const points = Number(e.points) || 0;
    const kind = String(e.kind || '');
    const w = e.workId ? wmap.get(e.workId) : null;
    let text = POINTS_KIND_TEXT[kind] || '灯火变动';
    if (kind === 'admin') text = points >= 0 ? '站长赠送' : '站长收回';
    return {
      t: Number(e.t) || 0,
      kind,
      text,
      points,
      work: w ? { id: w.id, title: w.title || '' } : null
    };
  });
  res.json({ points: rec.points || 0, log, max: SHARE_LOG_MAX });
});

app.get('/api/me/stats', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) days.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));

  const mine = works.filter(w => w.userId === user.id && !w.deleted);
  const shareRec = shareData.users[user.id] || { points: 0, visits: 0, regs: 0, works: {} };
  const myShareWorks = shareRec.works || {};
  const items = mine.map(w => {
    const rec = workVisits[w.id] || {};
    const trend = days.map(k => (rec.days && rec.days[k] && rec.days[k].pv) || 0);
    return {
      id: w.id,
      title: w.title,
      thumb: w.thumb || w.image || '',
      category: w.category,
      createdAt: w.createdAt,
      online: isVisible(w),                       // false = 审核中/未上线/已自主下架
      hidden: !!w.hidden,                         // 作者自主下架：仅自己可见
      status: w.status || 'approved',             // 站内审核：approved / pending / rejected
      stage: stageOf(w),                          // 作者进度：live / reviewing / wip
      reason: w.offlineReason || '',              // 被下架的原因（管理员填）
      progress: typeof w.progress === 'number' ? w.progress : null,
      eta: w.eta || '',
      watch: Array.isArray(w.watchers) ? w.watchers.length : 0,
      views: w.views || 0,
      likes: w.likes || 0,
      favs: w.favs || 0,
      comments: countComments(w.id),
      uv: rec.uv ? Object.keys(rec.uv).length : 0,
      shareVisits: myShareWorks[w.id] || 0,       // 这件作品被分享后带来的有效访问
      // 体验维度：真的点了「访问 / 下载」，或真的要「看/存小程序码」
      actions: workActionStats(w.id),
      actions7: workActionStats(w.id, 7),
      pv7: trend.slice(-7).reduce((a, b) => a + b, 0),
      trend
    };
  });

  const totals = items.reduce((a, it) => ({
    works: a.works + 1,
    views: a.views + it.views,
    likes: a.likes + it.likes,
    favs: a.favs + it.favs,
    comments: a.comments + it.comments,
    shareVisits: a.shareVisits + it.shareVisits,
    visit: a.visit + it.actions.visit,
    download: a.download + it.actions.download,
    scan: a.scan + it.actions.scan,
    scanIntent: a.scanIntent + (it.actions.scan_intent || 0),
    pv7: a.pv7 + it.pv7
  }), { works: 0, views: 0, likes: 0, favs: 0, comments: 0, shareVisits: 0, visit: 0, download: 0, scan: 0, scanIntent: 0, pv7: 0 });

  const trend = days.map((_, i) => items.reduce((s, it) => s + it.trend[i], 0));
  const share = shareStatsOf(user.id);
  res.json({
    totals: { ...totals, shareRegs: share.regs, points: share.points },
    days, trend,
    share: {
      points: share.points, visits: share.visits, regs: share.regs, rank: share.rank, totalRanked: share.totalRanked,
      promoVisits: share.promoVisits, promoRegs: share.promoRegs, promoBy: share.promoBy,
      promoMilestone: share.promoMilestone, promoMilestoneAt: share.promoMilestoneAt,
      promoMilestonePoints: share.promoMilestonePoints, promoRegBonus: share.promoRegBonus,
      today: share.today
    },
    checkin: checkinView(user),
    board: shareBoard(10),
    checkinBoard: checkinBoard(8),
    checkinRank: checkinRankOf(user.id),
    works: items.sort((a, b) => b.views - a.views)
  });
});

// 编辑回填：统计面板「作品明细」里点「编辑」用。
// 和 /api/works/:id 的区别：待审 / 被下架的作品只有管理员能通过详情接口打开，
// 但作者本人恰恰要能改（改完重新进审核），所以这里按「本人或管理员」放行，不看对外展示状态。
app.get('/api/me/works/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id && !x.deleted);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId !== user.id && !isAdmin(req)) {
    return res.status(403).json({ error: '只能编辑自己的作品' });
  }
  res.json({ ...publicWork(w, user), introHtml: md.render(w.prompt || '') });
});

// 分类
// 前端每次页面浏览上报一次（PV +1；UV 按账号/IP 去重）
app.post('/api/track', (req, res) => {
  const body = req.body || {};
  const p = String(body.path || '/');
  if (p.startsWith('/admin')) return res.json({ ok: true, skipped: true });
  if (!rateLimit('track:' + clientIp(req), 900, 3600000)) return res.json({ ok: true, skipped: true });
  let wid = String(body.workId || '');
  if (!wid) {
    const m = p.match(/^\/w\/([A-Za-z0-9_-]+)/);
    if (m) wid = m[1];
  }
  // 动作埋点（点访问 / 点下载 / 看小程序码）：只记动作，不再重复计浏览
  const action = String(body.action || '');
  if (action) {
    if (wid) trackWorkAction(req, wid, action, String(body.type || ''));
    return res.json({ ok: true });
  }
  // site:false → 只记作品维度，不重复计站点 PV（弹窗打开作品时用）
  // platform:'mini' → 小程序来源：站点 PV/UV 存独立分桶，作品维度按 deviceId 去重
  const platform = body.platform === 'mini' ? 'mini' : 'web';
  const deviceId = platform === 'mini' && /^[A-Za-z0-9_-]{6,64}$/.test(String(body.deviceId || ''))
    ? String(body.deviceId) : '';
  const opts = { platform, deviceId };
  // 流量构成：ref 是前端传的 document.referrer（来源页），entry 表示这是本次打开的第一屏。
  // 都只是画像维度，缺了不影响 PV/UV 计数。
  opts.path = p;
  opts.ref = String(body.ref || '').slice(0, 300);
  opts.entry = body.entry === true;
  if (body.site !== false) trackVisit(req, opts);
  // 作品详情页额外记一份作品维度 PV / UV
  if (wid) trackWorkVisit(req, wid, opts);
  res.json({ ok: true });
});

// 扫码落地：记一次真实扫码 → 跳转。这条路径拿到的是「真的有人扫并打开了」，不是意图估算
// 短链统一走 /go/<code>；/s/ 曾和匿名投稿进度查询撞过路由（短链先注册把 /s/ 全拦了，
// 进度链接成了死代码），所以短链挪到 /go/，/s/ 让给进度查询——但已印出去的老二维码是 /s/ 码，
// 那边先查一遍短码索引兜底，老码不过期
function scanShortHit(code) {
  if (!code) return null;
  let hit = shortIndexMap().get(code);
  if (!hit) hit = shortIndexMap(true).get(code);   // 刚发布的作品索引还没刷新
  return hit || null;
}
function scanLanding(req, res, code) {
  // 防脚本兜底：正常扫码一个 IP 一小时撑死几十次
  if (!rateLimit('go:' + clientIp(req), 120, 3600000)) return res.status(429).type('html').send(qrMissPage('请求太频繁，稍后再试'));
  const hit = scanShortHit(code);
  if (!hit) return res.status(404).type('html').send(qrMissPage('这个短链不存在或已失效'));
  const w = works.find(x => x.id === hit.workId);
  if (!w || !isVisible(w)) return res.status(404).type('html').send(qrMissPage('作品已下架或还没上线'));
  // 作者可能刚改过链接：以作品当前数据为准，别把老访客送去过期地址
  const live = qrTargetsOf(w).find(e => e.t === hit.t);
  const url = (live && live.url) || hit.url;
  // 分享卡片上的码带 ?ref=<分享者>：扫码记「人数」并给分享者计灯火；详情页/海报上的码不带 ref，只记人数
  const ref = String(req.query.ref || '').trim().slice(0, 30);
  // 'detail' 是分享卡片的默认落地点：扫码的人先看站内详情页，别直接送出站。
  // 仍记一次扫码（人数 + 分享者灯火），ref 继续往详情页带，注册归因那条链才不断。
  const isDetail = hit.t === 'detail';
  recordScan(req, w, isDetail ? '详情页' : (hit.t === 'site' ? '官网' : hit.t), ref);
  if (isDetail) {
    const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
    return res.redirect(302, siteOrigin(req) + '/w/' + encodeURIComponent(w.id) + q);
  }
  res.redirect(302, url);
}
app.get('/go/:code', (req, res) => {
  scanLanding(req, res, String(req.params.code || '').replace(/[^a-z0-9]/gi, '').slice(0, 16));
});

// 短链码图片：按需生成并缓存（码内容就是 /go/<code>，不会变）
const qrBufferCache = new Map();
app.get('/qr/:code', async (req, res) => {
  const code = String(req.params.code || '').replace(/\.png$/i, '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
  if (!scanShortHit(code)) return res.status(404).end();
  try {
    let buf = qrBufferCache.get(code);
    if (!buf) {
      buf = await QRCode.toBuffer(siteOrigin(req) + '/go/' + code, {
        width: 600, margin: 2, errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      if (qrBufferCache.size > 500) qrBufferCache.clear();
      qrBufferCache.set(code, buf);
    }
    res.type('png').set('Cache-Control', 'public, max-age=86400').send(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// ---- 分享归因：访客带着 ?ref= 落地时上报一次 ----
// 前端只在「首次落地 + 本机没记过这条 ref/work」时调，所以请求量很小；这里仍做限流兜底。
app.post('/api/ref/visit', (req, res) => {
  const ref = String((req.body && req.body.ref) || '').trim().slice(0, 30);
  const workId = String((req.body && req.body.workId) || '').trim().slice(0, 40);
  if (!ref) return res.json({ ok: true, credited: false });
  if (!rateLimit('refvisit:' + clientIp(req), 120, 3600e3)) return res.json({ ok: true, credited: false });
  // 小程序来源：访客身份用 deviceId（本地生成、随 storage 持久），不按出口 IP 去重
  const ipkOverride = miniIpkOf(req.body);
  const r = creditShareVisit(req, ref, workId, ipkOverride);
  res.json({ ok: true, credited: !!r.credited, points: r.points || 0 });
});

// ---- 外宣渠道归因：访客带着 ?fr=<平台key>&ref=<作者> 落地时上报一次 ----
// 分工：fr 记渠道（后台/作者看板用），ref 归属到作者。
// 访问本身不发灯火（复制粘贴式传播太容易被自己刷），但会给作者累计「外宣来访人数」，
// 满 100 人发一次性里程碑奖励；这台机器的渠道来路会被记下，之后从这里注册就带渠道加成。
app.post('/api/fr/visit', (req, res) => {
  const fr = String((req.body && req.body.fr) || '').trim().toLowerCase().slice(0, 24);
  const workId = String((req.body && req.body.workId) || '').trim().slice(0, 40);
  const ref = String((req.body && req.body.ref) || '').trim().slice(0, 30);
  if (!fr) return res.json({ ok: true });
  if (!rateLimit('frvisit:' + clientIp(req), 200, 3600e3)) return res.json({ ok: true });
  const tracked = trackPromoVisit(req, fr, workId);
  const reach = creditPromoReach(req, fr, workId, ref);
  res.json({ ok: tracked, credited: !!reach.credited, promoVisits: reach.promoVisits || 0, milestone: reach.milestone || 0 });
});

// 分享达人榜（公开，只给昵称和公开数字）
app.get('/api/shareboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ board: shareBoard(10) });
});

// ---- 大家最近在搜（前台热搜榜）----
// 只给词和热度，不带任何人的信息；limit 最多 20
app.get('/api/search/hot', (req, res) => {
  const limit = Math.min(20, Math.max(3, parseInt(req.query.limit, 10) || 10));
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(hotSearches(limit));
});

// ---- 造梦酒馆 ----
// 列表：默认按「想要的人多」排序，可按最新；支持 limit
// mine=1：只返回自己提的想法（含被隐藏的，自己要知道发生了什么），按最近有动静排序
app.get('/api/ideas', (req, res) => {
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  const sort = ['new', 'week'].includes(req.query.sort) ? req.query.sort : 'hot';
  const onlyOpen = req.query.status === 'open';
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const user = currentUser(req);
  if (mine && !user) return res.status(401).json({ error: '登录后才能看自己的想法' });
  const visible = ideas.filter(i => !i.hidden);
  let list = mine ? ideas.filter(i => i.userId === user.id) : visible;
  // 「等我认领」：只留还没人接、也没挂作品的，创作者不用一张张翻卡片
  if (onlyOpen && !mine) list = list.filter(i => (i.status || 'open') === 'open' && !i.workId);
  const now = Date.now();
  // 近期热榜：按 想要数 / (1 + 提出天数 / 14) 衰减，避免老想法靠终身累计永远霸榜
  const freshScore = i => (i.wants || 0) /
    (1 + Math.max(0, now - new Date(i.createdAt).getTime()) / 86400e3 / 14);
  const sorted = list.slice().sort((a, b) => {
    if (mine) return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    if (sort === 'new') return new Date(b.createdAt) - new Date(a.createdAt);
    if (sort === 'week') {
      const d = freshScore(b) - freshScore(a);
      return d !== 0 ? d : new Date(b.createdAt) - new Date(a.createdAt);
    }
    const d = (b.wants || 0) - (a.wants || 0);
    return d !== 0 ? d : new Date(b.createdAt) - new Date(a.createdAt);
  });
  const weekAgo = now - 7 * 86400e3;
  const doneItems = visible.filter(i => (i.status === 'done' || i.workId) && i.workId && works.some(w => w.id === i.workId));
  const stats = {
    total: visible.length,
    done: doneItems.length,
    claimed: visible.filter(i => i.status === 'claimed').length,
    open: visible.filter(i => (i.status || 'open') === 'open' && !i.workId).length,
    weekNew: visible.filter(i => new Date(i.createdAt).getTime() >= weekAgo).length
  };
  const doneList = doneItems.slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .slice(0, 6)
    .map(i => ({ id: i.id, title: i.title, wants: i.wants || 0,
      work: { id: i.workId, title: (works.find(w => w.id === i.workId) || {}).title || '' } }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    total: list.length,
    items: sorted.slice(0, limit).map(i => publicIdea(i, req, user)),
    stats, doneList
  });
});

// 单条想法：详情抽屉用。列表接口有分页，靠缓存取会漏掉「加载更多」之外的那部分。
app.get('/api/ideas/:id', (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea || idea.hidden) return res.status(404).json({ error: '想法不存在' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicIdea(idea, req, currentUser(req)));
});

// 发布想法：需登录，每人每天最多 5 条
app.post('/api/ideas', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('idea:' + user.id, 5, 86400e3)) {
    return res.status(429).json({ error: '今天发的想法有点多了，明天再来吧' });
  }
  const title = String((req.body && req.body.title) || '').replace(/\s+/g, ' ').trim();
  let detail = String((req.body && req.body.detail) || '').replace(/\s+/g, ' ').trim();
  if (detail.length > IDEA_DETAIL_MAX) detail = detail.slice(0, IDEA_DETAIL_MAX);
  if (title.length < 4) return res.status(400).json({ error: '想法至少 4 个字，说清楚一点' });
  if (title.length > IDEA_TITLE_MAX) return res.status(400).json({ error: `想法最多 ${IDEA_TITLE_MAX} 个字` });
  if (hitSensitive(title + detail)) return res.status(400).json({ error: '内容包含敏感词，改一下再发' });
  const fullText = title + (detail ? '\n' + detail : '');
  // 第一道：微信官方内容安全接口（UGC 提审硬要求）；异常时降级到第二道 AI 审
  const wxCheck = await wechatMsgCheck(fullText, user.wechat && user.wechat.openid);
  if (wxCheck.pass === false) {
    return res.status(400).json({ error: '想法未通过平台内容安全检测，改一下再发' });
  }
  // 第二道：AI 初审：想法直接公开展示，明确违规直接拒；AI 不可用时放行（敏感词兜底）
  const ai = await aiReviewGate('创意想法投稿：' + fullText);
  if (ai.pass === false) {
    return res.status(400).json({ error: '想法疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，改一下再发' });
  }
  // 同一句话不许重复刷屏
  if (ideas.some(i => i.userId === user.id && i.title === title)) {
    return res.status(400).json({ error: '你已经发过一样的想法了' });
  }
  // 相似去重：全站有人提过近似的，先请用户确认「去顶一下」，别让想要票数分散到两张卡上。
  // ackSimilar 由前端二次确认后带上；规则在服务端，绕过 UI 也躲不过。
  if (!(req.body && req.body.ackSimilar)) {
    const similar = findSimilarIdea(title);
    if (similar) {
      return res.status(409).json({
        code: 'similar', error: '已经有人提过类似的想法了', idea: publicIdea(similar, req, user)
      });
    }
  }
  let category = String((req.body && req.body.category) || '').trim();
  if (category && !categories.includes(category)) category = '';

  const idea = {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title,
    detail,
    category,
    userId: user.id,
    author: user.username,
    wants: 0,
    wantKeys: [],
    status: 'open',
    claimer: null,
    workId: '',
    createdAt: new Date().toISOString()
  };
  ideas.unshift(idea);
  saveIdeas();
  res.status(201).json(publicIdea(idea, req, user));
});

// 我也想要：登录按账号 / 未登录按 IP，终身只计一次
app.post('/api/ideas/:id/want', (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  if (!rateLimit('ideawant:' + clientIp(req), 120, 3600e3)) {
    return res.status(429).json({ error: '点太快了，歇一会儿' });
  }
  const user = currentUser(req);
  const key = ideaWantKey(req, user);
  if (!Array.isArray(idea.wantKeys)) idea.wantKeys = [];
  const wanted = idea.wantKeys.includes(key);
  if (wanted) {
    idea.wantKeys = idea.wantKeys.filter(k => k !== key);
  } else {
    idea.wantKeys.push(key);
  }
  idea.wants = idea.wantKeys.length;
  saveIdeas();
  res.json({ ok: true, wants: idea.wants, wanted: !wanted });
});

// 我来实现：认领（已认领的不能再抢，除非是自己的）
app.post('/api/ideas/:id/claim', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  if (idea.userId === user.id) return res.status(400).json({ error: '这是你自己提的想法' });
  if (idea.claimer && idea.claimer.userId !== user.id && idea.status !== 'open') {
    return res.status(400).json({ error: `已经有 @${idea.claimer.name} 在做了` });
  }
  idea.claimer = { userId: user.id, name: displayNameOf(user.username), at: new Date().toISOString() };
  idea.status = 'claimed';
  idea.updatedAt = new Date().toISOString();
  saveIdeas();
  // 站内通知提出者：个人主体小程序没有订阅消息，全站统一走这条铃铛通道
  if (idea.userId && idea.userId !== user.id) {
    addNotice(idea.userId, {
      kind: 'idea',
      title: '你的想法被认领了',
      text: `「${idea.title}」由 @${displayNameOf(user.username)} 认领，正在做，做完会挂到橱窗`,
    });
  }
  res.json(publicIdea(idea, req, user));
});

// 标记已实现：只有认领者 / 提出者 / 管理员能挂作品
app.post('/api/ideas/:id/done', (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  const user = currentUser(req);
  const isClaimer = !!(user && idea.claimer && idea.claimer.userId === user.id);
  const isAuthor = !!(user && idea.userId === user.id);
  if (!isClaimer && !isAuthor && !isAdmin(req)) return res.status(403).json({ error: '只有认领者或提出者可以标记' });

  let wid = String((req.body && req.body.workId) || '').trim();
  const m = wid.match(/\/w\/([A-Za-z0-9_-]+)/);
  if (m) wid = m[1];
  if (!wid) { // 没填作品就退回「征集中」
    idea.status = 'open';
    idea.workId = '';
    idea.updatedAt = new Date().toISOString();
    saveIdeas();
    return res.json(publicIdea(idea, req, user));
  }
  if (!works.some(w => w.id === wid)) return res.status(400).json({ error: '没找到这个作品，检查一下链接' });
  const wasDone = idea.status === 'done';
  idea.workId = wid;
  idea.status = 'done';
  idea.updatedAt = new Date().toISOString();
  saveIdeas();
  // 站内通知提出者（带作品 id，铃铛里点了直接看作品）；重复标记不重复打扰
  if (!wasDone && idea.userId && (!user || idea.userId !== user.id)) {
    addNotice(idea.userId, {
      kind: 'idea',
      title: '你提的想法被做出来了',
      text: `「${idea.title}」已经实现，点开看看`,
      workId: wid,
    });
  }
  res.json(publicIdea(idea, req, user));
});

// 举报：UGC 合规硬要求——每个能发布的内容都要有投诉通道。
// 复用作品举报的 reports 通道（后台一起看），target=idea 区分来源；
// workId/workTitle 沿用作品举报的字段名，后台现有列表不用改也能显示。
app.post('/api/ideas/:id/report', (req, res) => {
  if (!rateLimit('report:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  const { reason } = req.body || {};
  const REASONS = ['违法违规', '涉嫌侵权', '内容不当', '垃圾广告', '其他'];
  if (!REASONS.includes(reason)) return res.status(400).json({ error: '请选择举报原因' });
  reports.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    target: 'idea',
    workId: idea.id,
    workTitle: '【想法】' + idea.title,
    reason,
    description: '',
    contact: '',
    status: '待处理',
    createdAt: new Date().toISOString()
  });
  saveReports();
  res.status(201).json({ ok: true, message: '举报已提交，我们会尽快处理' });
});

// ---- 想法详情：结构化讨论 ----
// 三条硬规矩：① 必须登录（不留匿名入口，跟作品评论的宽松口径不同）；
// ② 只有三种有信息量的发言类型，不做自由评论区；③ 内容安全双闸 + 举报 + 可删，UGC 闭环一个不少。
const IDEA_DISCUSSION_KIND_TEXT = { scene: '补充场景', solution: '推荐方案', progress: '进展更新' };

app.get('/api/ideas/:id/discussions', (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea || idea.hidden) return res.status(404).json({ error: '想法不存在' });
  const user = currentUser(req);
  const admin = isAdmin(req);
  const items = ideaDiscussions
    .filter(d => d.ideaId === idea.id && !d.hidden)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(d => publicDiscussion(d, idea, user, admin));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total: items.length, items });
});

app.post('/api/ideas/:id/discussions', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('ideadisc:' + user.id, 10, 3600e3)) {
    return res.status(429).json({ error: '一小时内说得够多了，歇一会儿' });
  }
  const idea = ideaById(req.params.id);
  if (!idea || idea.hidden) return res.status(404).json({ error: '想法不存在' });
  const body = req.body || {};
  const kind = String(body.kind || '');
  if (!IDEA_DISCUSSION_KINDS.includes(kind)) return res.status(400).json({ error: '请选择发言类型' });
  const admin = isAdmin(req);
  const isAuthor = idea.userId === user.id;
  const isClaimer = !!(idea.claimer && idea.claimer.userId === user.id);
  // 进展更新只有认领者 / 提出者能发，否则会变成「替别人宣布做完了」
  if (kind === 'progress' && !isAuthor && !isClaimer && !admin) {
    return res.status(403).json({ error: '只有认领者或提出者能更新进展' });
  }
  const text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (text.length < 4) return res.status(400).json({ error: '至少写 4 个字，说清楚一点' });
  if (text.length > IDEA_DISCUSSION_TEXT_MAX) {
    return res.status(400).json({ error: `最多 ${IDEA_DISCUSSION_TEXT_MAX} 字` });
  }
  if (hitSensitive(text)) return res.status(400).json({ error: '内容包含敏感词，改一下再发' });
  const wxCheck = await wechatMsgCheck(text, user.wechat && user.wechat.openid);
  if (wxCheck.pass === false) {
    return res.status(400).json({ error: '内容未通过平台内容安全检测，改一下再发' });
  }
  const ai = await aiReviewGate('造梦酒馆讨论：' + text);
  if (ai.pass === false) {
    return res.status(400).json({ error: '内容疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，改一下再发' });
  }
  const d = {
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ideaId: idea.id,
    kind, text,
    userId: user.id,
    author: user.username,
    hidden: false,
    createdAt: new Date().toISOString()
  };
  ideaDiscussions.push(d);
  saveIdeaDiscussions();
  // 通知提出者 + 认领者；自己不说给自己听，两个身份是同一人也只发一条
  const targets = new Set([idea.userId, idea.claimer && idea.claimer.userId].filter(Boolean));
  targets.delete(user.id);
  const brief = text.length > 80 ? text.slice(0, 80) + '…' : text;
  targets.forEach(uid => addNotice(uid, {
    kind: 'idea',
    title: kind === 'progress' ? '你关注的想法有进展了' : '你关注的想法有新讨论',
    text: `「${idea.title}」${IDEA_DISCUSSION_KIND_TEXT[kind]}：${brief}`
  }));
  res.status(201).json(publicDiscussion(d, idea, user, admin));
});

// 删除：本人 / 想法提出者（自己想法下的灌水有权清）/ 管理员
app.delete('/api/ideas/:id/discussions/:did', (req, res) => {
  const user = currentUser(req);
  const admin = isAdmin(req);
  if (!user && !admin) return res.status(401).json({ error: '请先登录' });
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  const idx = ideaDiscussions.findIndex(d => d.id === req.params.did && d.ideaId === idea.id);
  if (idx < 0) return res.status(404).json({ error: '这条讨论不存在' });
  const d = ideaDiscussions[idx];
  if (!admin && !(user && (d.userId === user.id || idea.userId === user.id))) {
    return res.status(403).json({ error: '只能删除自己的发言' });
  }
  ideaDiscussions.splice(idx, 1);
  saveIdeaDiscussions();
  res.json({ ok: true });
});

// 举报：复用作品举报通道，target 区分来源；后台现有列表不用改也能看到
app.post('/api/ideas/:id/discussions/:did/report', (req, res) => {
  if (!rateLimit('report:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
  const idea = ideaById(req.params.id);
  const d = idea && ideaDiscussions.find(x => x.id === req.params.did && x.ideaId === idea.id);
  if (!idea || !d) return res.status(404).json({ error: '这条讨论不存在' });
  const { reason } = req.body || {};
  const REASONS = ['违法违规', '涉嫌侵权', '内容不当', '垃圾广告', '其他'];
  if (!REASONS.includes(reason)) return res.status(400).json({ error: '请选择举报原因' });
  reports.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    target: 'idea-discussion',
    workId: d.id,
    workTitle: '【想法讨论】' + d.text.slice(0, 40),
    reason, description: '', contact: '',
    status: '待处理',
    createdAt: new Date().toISOString()
  });
  saveReports();
  res.status(201).json({ ok: true, message: '举报已提交，我们会尽快处理' });
});

// 后台：讨论列表 + 隐藏（审核兜底，和想法本身的 hidden 一个待遇）
app.get('/api/admin/idea-discussions', requireAdmin, (req, res) => {
  res.json(ideaDiscussions.slice().reverse().map(d => ({
    ...d,
    ideaTitle: (ideaById(d.ideaId) || {}).title || '（想法已删除）'
  })));
});
app.put('/api/admin/idea-discussions/:did', requireAdmin, (req, res) => {
  const d = ideaDiscussions.find(x => x.id === req.params.did);
  if (!d) return res.status(404).json({ error: '这条讨论不存在' });
  if (req.body && req.body.hidden !== undefined) d.hidden = !!req.body.hidden;
  saveIdeaDiscussions();
  res.json({ ok: true, hidden: !!d.hidden });
});

// 删除：提出者本人或管理员（连想法下的讨论一起清掉，不留孤儿数据）
app.delete('/api/ideas/:id', (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  const user = currentUser(req);
  if (!(user && idea.userId === user.id) && !isAdmin(req)) return res.status(403).json({ error: '无权删除' });
  ideas = ideas.filter(i => i.id !== idea.id);
  ideaDiscussions = ideaDiscussions.filter(d => d.ideaId !== idea.id);
  saveIdeas();
  saveIdeaDiscussions();
  res.json({ ok: true });
});

// 后台：全部想法（含被隐藏的）
app.get('/api/admin/ideas', requireAdmin, (req, res) => {
  const user = currentUser(req);
  res.json(ideas.map(i => ({
    ...publicIdea(i, req, user),
    hidden: !!i.hidden,
    authorAccount: i.author,
    account: i.userId || ''
  })));
});

// 后台：隐藏 / 恢复
app.put('/api/admin/ideas/:id', requireAdmin, (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  if (req.body && req.body.hidden !== undefined) idea.hidden = !!req.body.hidden;
  saveIdeas();
  res.json({ ok: true, hidden: !!idea.hidden });
});

// 分类顺序完全跟随后台配置（「其他」兜底项已下线，新增分类直接追加到末尾）
function orderedCategories() {
  return categories.slice();
}

app.get('/api/categories', (req, res) => res.json(['全部', ...orderedCategories()]));
// 前台新增分类：匿名可发（形态/分类本来就是按需建的具体项），
// 但名字全站公开展示且立即生效，所以和「想法」同一套闸门：限流 → 敏感词 → 智谱初审。
// 没有「待审核」状态，AI 不可用时放行（敏感词兜底），明确违规直接拒。
const CATEGORY_MAX_COUNT = 60;   // 防匿名灌水把分类列表撑爆
app.post('/api/categories', async (req, res) => {
  if (!rateLimit('cat-new:' + clientIp(req), 5, 3600e3)) {
    return res.status(429).json({ error: '新增太频繁了，歇一会儿再试' });
  }
  const name = String((req.body && req.body.name) || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '分类名不能为空' });
  if (categories.length >= CATEGORY_MAX_COUNT) return res.status(400).json({ error: '分类太多了，先整理一下再新增' });
  if (categories.includes(name)) return res.status(400).json({ error: '分类已存在' });
  if (hitSensitive(name)) return res.status(400).json({ error: '分类名包含敏感词，换一个吧' });
  const ai = await aiReviewGate('作品分类名：' + name);
  if (ai.pass === false) {
    return res.status(400).json({ error: '分类名疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，换一个吧' });
  }
  categories.push(name);
  saveCategories();
  res.status(201).json(['全部', ...orderedCategories()]);
});

// 形态
app.get('/api/types', (req, res) => res.json(['全部', ...WORK_TYPES]));
// 前台投稿新增自定义形态（「＋ 新形态」起个具体名字）：校验与后台一致，新形态追加到末尾。
// 与分类同一套闸门：限流 → 敏感词 → 智谱初审（匿名可发，AI 不可用时放行走敏感词兜底）。
const TYPE_MAX_COUNT = 40;
app.post('/api/types', async (req, res) => {
  if (!rateLimit('type-new:' + clientIp(req), 5, 3600e3)) {
    return res.status(429).json({ error: '新增太频繁了，歇一会儿再试' });
  }
  const name = String((req.body && req.body.name) || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10);
  if (!name) return res.status(400).json({ error: '形态名不能为空' });
  if (workTypes.length >= TYPE_MAX_COUNT) return res.status(400).json({ error: '形态太多了，先整理一下再新增' });
  if (workTypes.some(t => t.name === name)) return res.status(400).json({ error: '该形态已存在' });
  if (hitSensitive(name)) return res.status(400).json({ error: '形态名包含敏感词，换一个吧' });
  const ai = await aiReviewGate('作品形态名：' + name);
  if (ai.pass === false) {
    return res.status(400).json({ error: '形态名疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，换一个吧' });
  }
  workTypes.push({ name, icon: '✨', svg: '' });
  saveTypes(); syncWorkTypes();
  res.status(201).json({ ok: true, types: WORK_TYPES });
});
// 形态元数据（名称 + emoji + 图标 key），供前端渲染 chips / 徽章
app.get('/api/type-meta', (req, res) => {
  const counts = {};
  works.filter(w => isVisible(w)).forEach(w => typesOf(w).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  res.json(workTypes.map(t => ({ name: t.name, icon: t.icon, svg: t.svg || '', count: counts[t.name] || 0 })));
});
// 可选的图标库（后台「形态管理」用来渲染图标选择条）
app.get('/api/type-icons', (req, res) => res.json(TYPE_ICON_LIB));
// 推荐位（工具/资源）
app.get('/api/tools', (req, res) => res.json(tools.filter(t => t.active !== false)));

// 外宣指南平台清单（前端「外宣指南」页与「外宣包」共用）
app.get('/api/platforms', (req, res) => res.json({ platforms: PLATFORMS, extra: EXTRA }));

// ---------- 广告（公开） ----------
// 前台一次拿全量启用中的广告，自己按 slot 分发；返回体很小（每支广告只有几十字节）。
function adUrlOf(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('/')) return s.slice(0, 500);   // 站内相对路径（比如 /?feedback=1）原样保留
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.slice(0, 500);
}
function publicAd(a) {
  return {
    id: a.id, slot: a.slot,
    kind: a.kind || (a.image ? 'image' : 'text'),
    title: a.title || '', desc: a.desc || '',
    image: a.image || '', url: a.url, cta: a.cta || '', sort: a.sort || 0,
    workId: a.workId || '',        // 推荐位渲染原生卡片时要用它拿到作品
    extUrl: a.extUrl === true,     // 推荐但点击跳外链：前端据此走 <a> 外链而不是开作品详情
    source: a.source || 'admin'   // 前台据此区分「广告」（运营）和「推荐」（积分兑换）
  };
}
// 指向站内作品的广告（workId 或 /w/ 链接），目标作品必须还能公开打开：
// 已过审、未被作者下架。作品退回待审 / 被拒 / 自主下架期间广告先撤下，
// 恢复可见后自动回来——否则卡挂在首页、点开 404，曝光还在白白扣额度。
function adTargetVisible(a) {
  const wid = a.workId || (String(a.url || '').match(/^\/w\/([A-Za-z0-9_-]+)/) || [])[1] || '';
  if (!wid) return true;                       // 外链广告不受影响
  const w = works.find(x => x.id === wid);
  return !!w && isPublished(w) && !w.hidden;
}
// 积分兑换广告是否还活着：展示包看 budget、纯点击包（views=0）看 clickLeft、再看过期时间。
// 旧逻辑只看 budget：纯点击包 budget 恒为 0，会被误判成「额度用完」而从下发列表里消失——
// 点击包买了却一次都不展示，这是既有 bug，在此一并修复（与 expireRedemptions 的口径对齐）。
function redeemAdAlive(a, now) {
  if (a.endsAt && a.endsAt < now) return false;
  const r = redemptions.find(x => x.id === a.redemptionId);
  const showBased = !r || (r.views || 0) > 0;   // 兼容老数据：找不到订单按展示包算
  return showBased ? (a.budget || 0) > 0 : (a.clickLeft || 0) > 0;
}
function activeAds() {
  const now = Date.now();
  return ads
    .filter(a => a && a.active !== false && a.url && AD_SLOT_KEYS.includes(a.slot))
    // 积分兑换的广告还有两道闸：额度（展示/点击按各自口径）没用完、没到兜底有效期
    .filter(a => a.source !== 'redeem' || redeemAdAlive(a, now))
    .filter(adTargetVisible)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));
}
// 曝光/点击都是高频写入，攒一下再落盘，避免每来一个曝光就写一次文件
let adSaveTimer = null;
function scheduleAdSave() {
  if (adSaveTimer) return;
  adSaveTimer = setTimeout(() => {
    adSaveTimer = null;
    try { saveAds(); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// ---------- 广告 PV / UV 统计 ----------
const AD_STATS_RETENTION_DAYS = 90;   // 明细保留 90 天，超出按天淘汰
const AD_UV_MAX_PER_DAY = 20000;      // 单支广告单日 UV 上限，防止异常流量把文件撑爆
let adStatsSaveTimer = null;
function scheduleAdStatsSave() {
  if (adStatsSaveTimer) return;
  adStatsSaveTimer = setTimeout(() => {
    adStatsSaveTimer = null;
    try { writeJSON('ad-stats.json', adStats); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// 未登录访客的本机 ID（前端 localStorage 里的 dm_vid，随埋点一起带上来）。
// 之前按 IP 认人，共享出口（公司/校园/运营商 CGNAT）会把几千人并成一个人，
// 结果一天只扣 1 次曝光，投放者买的次数永远消耗不完；换成访客 ID 后一人一账。
// ID 可以清缓存伪造，所以在计费处另有按 IP 的兜底上限。
function visitorIdFrom(req) {
  const raw = String((req.query && req.query.vid) || (req.body && req.body.vid) || '');
  return /^[A-Za-z0-9_-]{8,40}$/.test(raw) ? raw : '';
}
function adVisitorKey(req) {
  const user = currentUser(req);
  if (user) return 'u:' + user.id;          // 登录：按账号，多设备 / 多网络都算同一个人
  const vid = visitorIdFrom(req);
  if (vid) return 'v:' + vid;               // 未登录：按本机访客 ID，共享出口 IP 不再并成一个人
  return 'ip:' + clientIp(req);             // 老页面 / 禁用存储的兜底，与以前口径一致
}

// 点击 / 关闭 的 PV/UV：与曝光同一本账（ad-stats.json，同一天同一条广告下加字段），
// 结构：{ 'YYYY-MM-DD': { <adId>: { pv, uv, clk: { pv, uv }, close: { pv, uv } } } }
// 老数据没有 clk / close 字段，读的时候按 0 兜底，不需要迁移。
function trackAdCount(adId, req, field) {
  const day = dateKey();
  const bucket = adStats[day] || (adStats[day] = {});
  const st = bucket[adId] || (bucket[adId] = { pv: 0, uv: {} });
  const rec = st[field] || (st[field] = { pv: 0, uv: {} });
  rec.pv = (rec.pv || 0) + 1;
  if (!rec.uv) rec.uv = {};
  const k = adVisitorKey(req);
  if (!rec.uv[k] && Object.keys(rec.uv).length < AD_UV_MAX_PER_DAY) rec.uv[k] = 1;
  scheduleAdStatsSave();
}

function trackAdShow(adId, req) {
  const ad = ads.find(a => a.id === adId);
  // 作者本人看自己的推广：不计入曝光统计、也不扣展示额度（自己预览不该烧自己买的灯火）
  const aw = ad && ad.workId && works.find(x => x.id === ad.workId);
  const user = currentUser(req);
  if (ad && user && aw && aw.userId && aw.userId === user.id) return;
  const day = dateKey();
  const bucket = adStats[day] || (adStats[day] = {});
  const st = bucket[adId] || (bucket[adId] = { pv: 0, uv: {} });
  st.pv = (st.pv || 0) + 1;
  if (!st.uv) st.uv = {};
  const k = adVisitorKey(req);
  if (!st.uv[k] && Object.keys(st.uv).length < AD_UV_MAX_PER_DAY) st.uv[k] = 1;
  const days = Object.keys(adStats).sort();
  while (days.length > AD_STATS_RETENTION_DAYS) delete adStats[days.shift()];
  scheduleAdStatsSave();
  // 积分兑换的广告：每次有效曝光扣 1 次展示额度，扣完就下线（订单转 used_up）
  // 纯点击包广告（views=0）展示不扣额度、只计数，点完点击额度后由点击接口统一下线
  if (ad && ad.source === 'redeem' && (ad.budget || 0) > 0) {
    // 计费按「访客」去重：登录按账号、未登录按本机访客 ID，同一访客 24h 内最多扣 1 次曝光额度。
    // 只按 IP 限 20 次时，换 IP 的代理池能把一单预算烧光；按访客去重后登录用户换 IP 无效，
    // 未登录也要一个浏览器一个 ID 地换才扣得动。超出的曝光照常展示、照记 PV，只是不扣这一单的额度。
    // 访客 ID 可清除，所以再按 IP 压一道兜底（REDEEM_IP_CAP_VIEWS）：
    // 共享出口的正常用户各自有 ID、能各自扣一次，兜底值只用来挡住「清缓存换身份」的脚本。
    if (!rateLimit('ad-bill-pv:' + adVisitorKey(req) + ':' + adId, REDEEM_DAY_CAP_VIEWS, REDEEM_DAY_MS)) return;
    if (!rateLimit('ad-bill-ip-pv:' + clientIp(req) + ':' + adId, REDEEM_IP_CAP_VIEWS, REDEEM_DAY_MS)) return;
    ad.budget = Math.max(0, (ad.budget || 0) - 1);
    if (ad.budget <= 0) {
      ad.active = false;
      finishRedemption(ad.redemptionId, 'used_up');
    }
    scheduleAdSave();
  }
}

// 单支广告的统计：累计 PV / UV、今日 PV / UV，以及点击 UV（点击次数即 a.clicks，
// 与之同一防刷口径，二者上线后同步增长）和关闭次数 / 关闭人数。
// 注意：点击 UV / 关闭是 2026-11-04 才开始记的，之前的点击只有累计总数、关闭完全没记。
function adStatsOf(adId) {
  const today = dateKey();
  let pv = 0;
  const uv = new Set();
  let todayPv = 0, todayUv = 0;
  let closePv = 0;
  const clickUv = new Set(), closeUv = new Set();
  Object.keys(adStats).forEach(d => {
    const st = adStats[d] && adStats[d][adId];
    if (!st) return;
    pv += st.pv || 0;
    Object.keys(st.uv || {}).forEach(k => uv.add(k));
    if (st.clk) Object.keys(st.clk.uv || {}).forEach(k => clickUv.add(k));
    if (st.close) {
      closePv += st.close.pv || 0;
      Object.keys(st.close.uv || {}).forEach(k => closeUv.add(k));
    }
    if (d === today) { todayPv = st.pv || 0; todayUv = Object.keys(st.uv || {}).length; }
  });
  return { pv, uv: uv.size, todayPv, todayUv, clickUv: clickUv.size, closePv, closeUv: closeUv.size };
}

app.get('/api/ads', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ slots: AD_SLOTS, ads: activeAds().map(publicAd) });
});

// 曝光上报：每次展示都记 PV，UV 由访客身份去重。
// 只做一个很宽松的防刷（同一访客同广告 60 秒最多记 3 次），正常浏览完全不受影响。
// 按访客而不是 IP：共享出口下一个 IP 后面有很多人，按 IP 限会让别人的正常浏览漏记。
// 另外兑换广告还有一层「单访客 / 单 IP 每日计费上限」，见 trackAdShow（超出的照记 PV、不扣额度）。
app.post('/api/ads/:id/impression', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  if (!rateLimit('ad-pv:' + adVisitorKey(req) + ':' + a.id, 3, 60000)) {
    return res.json({ ok: true, counted: false });
  }
  trackAdShow(a.id, req);
  res.json({ ok: true, counted: true });
});

// 点击：同一访客对同一支广告 60 秒内只记一次（同样按访客，共享 IP 不会互相盖掉）。
// 积分兑换的广告，点击额度是兑换时一起买好的：用一次扣一次额度，不额外扣积分；
// 额度用完后广告照常展示，点击只计数（不再计费），避免恶意点击把人积分掏空。
// 另有单访客 / 单 IP 每日计费上限（REDEEM_DAY_CAP_CLICKS / REDEEM_IP_CAP_CLICKS）：超出的点击照记、不扣额度。
app.post('/api/ads/:id/click', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  // 作者本人点自己的推广：不计数、不扣点击额度（自己预览/自点不该烧自己买的灯火）
  const aw = a.workId && works.find(x => x.id === a.workId);
  const me = currentUser(req);
  if (me && aw && aw.userId && aw.userId === me.id) return res.json({ ok: true });
  if (rateLimit('ad-clk:' + adVisitorKey(req) + ':' + a.id, 1, 60000)) {
    a.clicks = (a.clicks || 0) + 1;
    trackAdCount(a.id, req, 'clk');   // 点击 UV：与 a.clicks 同一防刷口径，每次计数时顺手记访客
    scheduleAdSave();
    if (a.source === 'redeem' && a.redemptionId) {
      const r = redemptions.find(x => x.id === a.redemptionId && x.status === 'active');
      // 单访客 / 单 IP 日内扣费上限：超出的点击照常计数，但不再扣这一单的额度
      // （防竞品循环点空别人的点击包；访客口径同曝光，IP 只是兜底）
      const canBill = rateLimit('ad-bill-clk:' + adVisitorKey(req) + ':' + a.id, REDEEM_DAY_CAP_CLICKS, REDEEM_DAY_MS)
        && rateLimit('ad-bill-ip-clk:' + clientIp(req) + ':' + a.id, REDEEM_IP_CAP_CLICKS, REDEEM_DAY_MS);
      if (r && (a.clickLeft || 0) > 0 && canBill) {
        a.clickLeft = (a.clickLeft || 0) - 1;
        r.clickUsed = (r.clickUsed || 0) + 1;
        scheduleAdSave();
        saveRedemptions();
        // 纯点击包广告（没买展示）：点击额度用完就下线结算
        if ((a.clickLeft || 0) <= 0 && (r.views || 0) === 0) {
          a.active = false;
          finishRedemption(a.redemptionId, 'used_up');
          scheduleAdSave();
        }
      }
    }
  }
  res.json({ ok: true });
});

// 关闭上报：访客点了广告右上角的「不想看，关掉」。
// 只记数量（PV）和人数（UV），不影响展示、不影响计费；关闭本身仍记在访客本地（90 天不再出现）。
// 同一访客同广告 60 秒最多记 3 次，正常浏览（一次最多关一条）完全不受影响。
app.post('/api/ads/:id/close', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  if (rateLimit('ad-close:' + adVisitorKey(req) + ':' + a.id, 3, 60000)) {
    trackAdCount(a.id, req, 'close');
  }
  res.json({ ok: true });
});


// ---------- 积分兑换广告位（按展示次数结算） ----------
// 积分账本统一走分享积分：兑换扣分、撤下退分都会进「分享明细」，用户能查得到。
function addPoints(uid, delta, kind, workId) {
  const rec = shareRecOf(uid);
  rec.points = Math.max(0, (rec.points || 0) + delta);
  // 管理员赠送/扣回的灯火单独记一本账，分享达人榜只排名用户挣来的分
  if (kind === 'admin') rec.adminPoints = Math.max(0, (rec.adminPoints || 0) + delta);
  // 外宣里程碑（渠道来访满 100 人一次性 +50）也是「推广挣来的」，进达人榜
  if (kind === 'promo') rec.promoPoints = Math.max(0, (rec.promoPoints || 0) + delta);
  pushShareLog(rec, kind, workId, delta);
  saveShareSoon();
  return rec.points;
}

// ---------- 开源作品奖励 ----------
// 标注开源的原创作品，系统一次性送 50 盏灯火并给上传者发站内消息（灯火可用于推荐）。
// 防刷两条：① 一件作品只送一次（反复开关不再发，靠 w.osBonusAt 记住）；
//          ② 同一个源码仓库只认第一次（换标题重复提交同一个 repo 不再给分）。
const OS_BONUS_POINTS = 50;
function repoKeyOf(url) {
  return String(url || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/\/+$/, '').replace(/\.git$/, '');
}
function grantOpenSourceBonus(w) {
  if (!w || w.openSource !== true || !w.userId || w.osBonusAt) return 0;
  const user = users.find(u => u.id === w.userId);
  if (!user) return 0;
  const key = repoKeyOf(w.repo);
  if (key && works.some(x => x !== w && x.osBonusAt && repoKeyOf(x.repo) === key)) {
    w.osBonus = 0;
    w.osBonusSkip = 'repo_used';   // 同一仓库已奖励过，记一笔便于后台排查
    return 0;
  }
  w.osBonusAt = new Date().toISOString();
  w.osBonus = OS_BONUS_POINTS;
  delete w.osBonusSkip;
  const points = addPoints(w.userId, OS_BONUS_POINTS, 'os', w.id);
  addNotice(w.userId, {
    kind: 'points',
    title: `开源作品奖励 +${OS_BONUS_POINTS} 盏灯火`,
    text: `「${w.title}」已标注为开源，系统赠送 ${OS_BONUS_POINTS} 盏灯火，可在「推荐」用于买曝光。源码仓库在 GitHub 的，每涨 1 个 star 系统自动按 1:1 发等额灯火，不用申请（上线前已有的 star 不自动补，可在「我的数据」点「申请 star 奖励」：100 star 以内当场到账，超过 100 转站长核定）；仓库在 Gitee 等其他托管站的读不到 star，申请后由站长人工核对发放。`,
    points,
    delta: OS_BONUS_POINTS
  });
  return OS_BONUS_POINTS;
}

// ---------- GitHub star 涨值自动发灯火 ----------
// 定期拉取开源作品源码仓库的 star 数（GitHub API），每涨 1 star 给作者发 STAR_REWARD_RATE 盏灯火。
// 规则：
//  - 只认 github.com 仓库（其他托管站接口不统一，后续要接再按家加）
//  - 第一次同步只记基线、不发灯火（避免存量 star 一次性补发一大笔）
//  - 只算涨值：star 掉了不扣灯火，star 只会带来不会带走
//  - 同一仓库被多件作品引用时只发一次（按 repoKey 去重，发给最早登记的作者）
//  - 单仓库单日封顶 STAR_REWARD_DAY_CAP（防买 star / 机器人刷 star 刷灯火），封顶部分不累计、次日额度刷新
//  - 拉取失败沿用旧值，下一轮再试；仓库 404（改名/删库）就停更不动
const STAR_REWARD_RATE = Math.max(0, Number(process.env.STAR_REWARD_RATE) || 1);
const STAR_REWARD_DAY_CAP = Math.max(0, Number(process.env.STAR_REWARD_DAY_CAP) || 2000);
const STAR_SYNC_INTERVAL = 6 * 3600e3;
// 可选：配 GITHUB_TOKEN（只读权限即可）把 API 限额从 60 次/时提到 5000 次/时
const GITHUB_STAR_TOKEN = String(process.env.GITHUB_TOKEN || process.env.GITHUB_STAR_TOKEN || '').trim();

const starSync = (() => {
  const raw = readJSON('star-sync.json', {});
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { repos: raw.repos && typeof raw.repos === 'object' ? raw.repos : {}, lastAt: raw.lastAt || null }
    : { repos: {}, lastAt: null };
})();
function saveStarSync() { writeJSON('star-sync.json', starSync); }

// 从仓库地址里解出 GitHub 的 owner/repo（兼容 www、.git 后缀、结尾斜杠）；非 GitHub 返回 null
function githubRepoOf(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    const repo = seg[1].replace(/\.git$/, '');
    if (!seg[0] || !repo) return null;
    return seg[0] + '/' + repo;
  } catch { return null; }
}

let starSyncing = false;
async function syncStarRewards() {
  if (starSyncing || STAR_REWARD_RATE <= 0) return;
  starSyncing = true;
  try {
    // 同一仓库只发一次：按 repoKey 归并，保留最早登记的那件作品（与开源奖励的「repo_used」口径一致）
    const byRepo = new Map();
    for (const w of works.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
      // 被管理员下架（rejected）的作品不再产出 star 灯火；作者自主下架（hidden）只影响展示，照常发
      if (w.openSource !== true || !w.userId || !w.repo || w.status === 'rejected') continue;
      const slug = githubRepoOf(w.repo);
      if (!slug) continue;
      const key = repoKeyOf(w.repo);
      if (!byRepo.has(key)) byRepo.set(key, { work: w, slug });
    }
    if (!byRepo.size) return;
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dream-window' };
    if (GITHUB_STAR_TOKEN) headers.Authorization = 'Bearer ' + GITHUB_STAR_TOKEN;
    const today = new Date().toISOString().slice(0, 10);
    let touched = false;
    for (const { work: w, slug } of byRepo.values()) {
      let count = null;
      try {
        const r = await ghFetchJson(GH_CONF.apiBase + '/repos/' + slug, { headers });
        if (r.ok && r.data && typeof r.data.stargazers_count === 'number') count = r.data.stargazers_count;
        // 404（仓库改名/转私有/删库）也拿不到数：count 保持 null，沿用旧值，灯火自然停发
      } catch { /* 网络问题沿用旧值 */ }
      if (count == null) continue;
      const key = repoKeyOf(w.repo);
      const rec = starSync.repos[key] || (starSync.repos[key] = {});
      const prev = typeof rec.count === 'number' ? rec.count : null;
      rec.count = count;
      rec.at = new Date().toISOString();
      w.stars = count;             // 缓存在作品上，详情页展示「⭐ N」直接读
      w.starsAt = rec.at;
      // 涨值发灯火：第一次（prev 为空）只记基线不发；之后按增量结算
      const delta = prev == null ? 0 : Math.max(0, count - prev);
      if (delta > 0) {
        if (rec.day !== today) { rec.day = today; rec.dayAwarded = 0; }
        const room = STAR_REWARD_DAY_CAP > 0 ? Math.max(0, STAR_REWARD_DAY_CAP - (rec.dayAwarded || 0)) : delta;
        const awarded = Math.min(delta, room);
        if (awarded > 0) {
          const gained = awarded * STAR_REWARD_RATE;
          rec.dayAwarded = (rec.dayAwarded || 0) + gained;
          // 累计「已折成灯火的 star 数」：star 奖励申领要拿当前 star 减它，避免存量补发和增量重复计账
          rec.awardedStars = (rec.awardedStars || 0) + awarded;
          const total = addPoints(w.userId, gained, 'star', w.id);
          addNotice(w.userId, {
            kind: 'points',
            title: `GitHub star 奖励 +${gained} 盏灯火`,
            text: `「${w.title}」的源码仓库 star 从 ${prev} 涨到了 ${count}（+${delta}），按 1 star = ${STAR_REWARD_RATE} 盏灯火自动发放 ${gained} 盏，当前余额 ${total} 盏。star 是别人在 GitHub 上真点的，继续更新项目就能一直涨。`,
            points: total,
            delta: gained,
            workId: w.id
          });
        }
        // 单日封顶：今天没发完的部分不补发，明天再看新的涨值
      }
      touched = true;
    }
    if (touched) {
      starSync.lastAt = new Date().toISOString();
      saveStarSync();
      saveWorks();
    }
  } finally { starSyncing = false; }
}

// ---------- star 奖励申领（存量 star / 其他托管站） ----------
// 站长定的规则（2026-11-07）：一件作品能补的 star 数 ≤ STAR_AUTO_APPLY_MAX 就直接到账，
// 超过 100 一律转人工审批（自动建一条反馈，后台「我的反馈」里能看到，站长核对后手发）。
// 「能补多少」= 当前 star − 已折成灯火的 star 数（rec.awardedStars）：
//   增量由 syncStarRewards 自动发，存量若再按当前全量发就成了双重计账，所以只补没发过的部分。
//   awardedStars 从这条规则上线起累计；更早的自动发放没留累计值，按 0 算（老仓库可能多发几十盏，量小可接受）。
//   非 GitHub 仓库接口不通用、读不到 star，一律转人工。
const STAR_AUTO_APPLY_MAX = 100;
const STAR_MANUAL_REAPPLY_MS = 7 * 86400e3;   // 转人工后 7 天内不重复提交，免得刷反馈

// 转人工时自动建一条反馈：进后台「我的反馈」，站长按星级和仓库真实性核定
function starApplyFeedback(user, w, text) {
  const now = new Date().toISOString();
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    token: fbNewToken(),
    type: '合作/其他',
    content: text,
    contact: '',
    username: user.username,
    userId: user.id,
    page: '/api/star/apply',
    ua: 'system',
    status: '待查看',
    createdAt: now,
    lastAt: now,
    thread: [{ from: 'user', fromName: '系统自动提交', text, at: now, read: false }]
  };
  feedback.push(item);
  if (feedback.length > 2000) feedback = feedback.slice(-2000);
  saveFeedback();
  // 给作者也留一条站内信：结果的 toast 一闪就没了，等站长核定的这几天得有地方能翻回去看
  addNotice(user.id, {
    kind: 'points',
    title: 'star 奖励已提交站长核定',
    text: `你为开源作品提交的 star 奖励申请已转给站长人工核定（作品「${w.title}」）。核对后灯火会直接发到账户，到账有消息提醒；7 天内不用重复提交，超过 7 天还没动静可以再点一次「申请 star 奖励」。`,
    workId: w.id
  });
  return item;
}

// 一次性处理作者名下所有符合条件的开源作品：小额的当场到账，大额的转审批
app.post('/api/star/apply', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('starapply:' + user.id, 6, 3600e3)) {
    return res.status(429).json({ error: '申请得太频繁了，一小时后再试' });
  }
  const mine = works.filter(w => w.userId === user.id && w.openSource === true && w.repo
    && w.status !== 'rejected' && w.status !== 'pending');
  if (!mine.length) return res.status(400).json({ error: '名下还没有审核通过的开源作品，先提交一件再来申请' });

  const auto = [], manual = [], skipped = [];
  const seenRepo = new Set();
  let changed = false;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dream-window' };
  if (GITHUB_STAR_TOKEN) headers.Authorization = 'Bearer ' + GITHUB_STAR_TOKEN;

  for (const w of mine.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
    const key = repoKeyOf(w.repo);
    // 同一仓库只认一件作品：仓库的 star 是仓库的，不是每件引用它的作品各算一遍
    if (key && seenRepo.has(key)) { skipped.push({ id: w.id, title: w.title, reason: '同一仓库已由另一件作品申领' }); continue; }
    if (key) seenRepo.add(key);
    // 已经申领过的不再处理；转人工的过 7 天允许重新提交（站长可能一直没看到）
    if (w.starApply) {
      const aged = Date.now() - (Date.parse(w.starApply.at) || 0) > STAR_MANUAL_REAPPLY_MS;
      if (!(w.starApply.mode === 'manual' && aged)) {
        skipped.push({ id: w.id, title: w.title, reason: w.starApply.mode === 'manual' ? '已提交站长审核，等回复即可' : '这件作品已经申领过' });
        continue;
      }
    }
    const now = new Date().toISOString();
    const slug = githubRepoOf(w.repo);
    if (!slug) {
      const text = `申请 star 奖励（非 GitHub 仓库）：作品「${w.title}」，仓库 ${w.repo}。这类托管站读不到 star，请站长人工核对后核定数量。发放走后台「送灯火」，备注写清仓库名方便对账；同一件作品只发一次。`;
      w.starApply = { at: now, mode: 'manual', stars: null, awarded: 0, note: '非 GitHub，需人工核对' };
      starApplyFeedback(user, w, text);
      manual.push({ id: w.id, title: w.title, stars: null, reason: '非 GitHub 仓库，站长人工核对' });
      changed = true;
      continue;
    }
    let count = null;
    try {
      const r = await ghFetchJson(GH_CONF.apiBase + '/repos/' + slug, { headers });
      if (r.ok && r.data && typeof r.data.stargazers_count === 'number') count = r.data.stargazers_count;
    } catch { /* 网络/限流：下面按读不到处理 */ }
    if (count == null) {
      const text = `申请 star 奖励（读不到 star）：作品「${w.title}」，仓库 ${w.repo}。系统这次没读到 star（限流或仓库改名），请站长人工核对后核定数量。发放走后台「送灯火」，备注写清仓库名；同一件作品只发一次。`;
      w.starApply = { at: now, mode: 'manual', stars: null, awarded: 0, note: '这次没读到 star' };
      starApplyFeedback(user, w, text);
      manual.push({ id: w.id, title: w.title, stars: null, reason: '这次没读到 star，已转站长人工核对' });
      changed = true;
      continue;
    }
    w.stars = count;
    w.starsAt = now;
    const rec = starSync.repos[key] || (starSync.repos[key] = {});
    const awardedStars = typeof rec.awardedStars === 'number' ? rec.awardedStars : 0;
    const room = Math.max(0, count - awardedStars);
    if (room <= 0) {
      w.starApply = { at: now, mode: 'auto', stars: count, awarded: 0, note: '没有可补的 star' };
      skipped.push({ id: w.id, title: w.title, reason: '这些 star 已经换成灯火了' });
      changed = true;
      continue;
    }
    if (room > STAR_AUTO_APPLY_MAX) {
      const text = `申请 star 奖励（超过 ${STAR_AUTO_APPLY_MAX} ，需审批）：作品「${w.title}」，仓库 ${w.repo}，当前 ${count} star，可补 ${room} 个。核定后用后台「送灯火」发放，备注写清仓库名；同一件作品只发一次。`;
      w.starApply = { at: now, mode: 'manual', stars: count, room, awarded: 0, note: `可补 ${room} 超过 ${STAR_AUTO_APPLY_MAX}` };
      starApplyFeedback(user, w, text);
      manual.push({ id: w.id, title: w.title, stars: count, room, reason: `可补 ${room} star，超过 ${STAR_AUTO_APPLY_MAX}，等站长核定` });
      changed = true;
      continue;
    }
    const gained = room * STAR_REWARD_RATE;
    const total = addPoints(user.id, gained, 'star', w.id);
    rec.awardedStars = awardedStars + room;
    w.starApply = { at: now, mode: 'auto', stars: count, awarded: gained };
    addNotice(user.id, {
      kind: 'points',
      title: `star 奖励 +${gained} 盏灯火`,
      text: `「${w.title}」的源码仓库现有 ${count} star，其中 ${room} 个还没换过灯火，按 1 star = ${STAR_REWARD_RATE} 盏发放 ${gained} 盏，当前余额 ${total} 盏。之后新涨的 star 仍会每 6 小时自动到账。`,
      points: total,
      delta: gained,
      workId: w.id
    });
    auto.push({ id: w.id, title: w.title, stars: count, awarded: gained });
    changed = true;
  }

  if (changed) { saveWorks(); saveStarSync(); }
  res.json({ ok: true, auto, manual, skipped, points: shareRecOf(user.id).points || 0 });
});

// ---------- 上传作品奖励 ----------
// 冷启动激励：注册用户上传作品给灯火——首件一次性 +200，之后每件 +20（每自然日最多 3 件计奖励）。
// 防薅三条：① 匿名投稿不计奖励（没有账号，灯火无处发）；② 延迟发放——上线后 48 小时内被投诉下架则作废；
// ③ 每天最多 3 件计奖励，防批量灌水。奖励在到期巡检时发放（5 分钟一轮）。
const UPLOAD_REWARD_FIRST = 200;
const UPLOAD_REWARD_NEXT = 20;
const UPLOAD_REWARD_DAILY_MAX = 3;
const UPLOAD_REWARD_DELAY = 48 * 3600e3;

// 投稿时记一笔「待发放」的奖励计划（在 works.push 之前调用，避免把自己算进历史作品）
// via：奖励来源 upload=自己投稿 / assign=管理员指定账号 / claim=认领通过（后两种作品已在 works 里，判定首件时要排除自己）
function planUploadReward(w, user, via) {
  if (!user || !user.id) return null;            // 匿名投稿不发
  const first = !works.some(x => x !== w && x.userId === user.id);
  const amount = first ? UPLOAD_REWARD_FIRST : UPLOAD_REWARD_NEXT;
  w.uploadReward = {
    first, amount,
    via: via || 'upload',
    plannedAt: new Date().toISOString(),
    readyAt: new Date(Date.now() + UPLOAD_REWARD_DELAY).toISOString()
  };
  return w.uploadReward;
}

// 到期巡检：观察期已过且仍在上线状态 → 到账并通知作者；被下架/待审 → 作废
function payUploadRewards() {
  const now = Date.now();
  const today = dateKey();
  const paidToday = {};
  let changed = false;
  for (const w of works) {
    const rw = w.uploadReward;
    if (!rw || rw.paid || rw.canceled) continue;
    if (w.status !== 'approved') { rw.canceled = true; changed = true; continue; }   // 待审/被下架：作废
    if (!w.userId || !users.some(u => u.id === w.userId)) { rw.canceled = true; changed = true; continue; }
    if (new Date(rw.readyAt).getTime() > now) continue;                // 观察期未满
    if (!(w.userId in paidToday)) {
      paidToday[w.userId] = works.filter(x => x.userId === w.userId
        && x.uploadReward && x.uploadReward.paid && dateKey(new Date(x.uploadReward.paidAt)) === today).length;
    }
    if (paidToday[w.userId] >= UPLOAD_REWARD_DAILY_MAX) continue;      // 今天件数满了，下一轮巡检再发
    const points = addPoints(w.userId, rw.amount, 'upload', w.id);
    // 说明这笔奖励的由来：自己投稿 / 管理员指定 / 认领通过——别让用户收到一笔莫名灯火
    const reason = rw.via === 'assign' ? '管理员已确认这件作品是你做的'
      : rw.via === 'claim' ? '这件作品的归属已确认到你名下'
      : '上线满 48 小时无投诉';
    addNotice(w.userId, {
      kind: 'points',
      title: `上传奖励 +${rw.amount} 盏灯火`,
      text: `作品「${w.title}」${reason}，上传奖励到账${rw.first ? '（首件大奖）' : ''}，当前余额 ${points} 盏。`,
      points,
      delta: rw.amount
    });
    rw.paid = true;
    rw.paidAt = new Date().toISOString();
    paidToday[w.userId] += 1;
    changed = true;
  }
  if (changed) saveWorks();
}

// 存量补齐：把没有奖励记录的历史作品按「最早一件 200、其余 20」一次性补发并通知作者。
// 匿名 / 被下架（rejected）/ 待审（pending）的不补；只在启动时跑，补过的会带 uploadReward 字段不会重复。
function backfillUploadRewards() {
  const seen = new Map();   // uid -> 已补件数
  // 已经拿过奖励（投稿/指定/认领任一路径）的用户，补发一律按「后续件」算，避免重复发首件大奖
  const rewarded = new Set(works.filter(x => x.uploadReward && x.userId).map(x => x.userId));
  let changed = false;
  for (const w of works.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    if (w.uploadReward) continue;
    if (!w.userId || !users.some(u => u.id === w.userId)) continue;
    if (w.status !== 'approved') continue;
    if (!seen.has(w.userId)) seen.set(w.userId, 0);
    const idx = seen.get(w.userId);
    const first = idx === 0 && !rewarded.has(w.userId);
    const amount = first ? UPLOAD_REWARD_FIRST : UPLOAD_REWARD_NEXT;
    const points = addPoints(w.userId, amount, 'upload', w.id);
    addNotice(w.userId, {
      kind: 'points',
      title: `上传奖励补发 +${amount} 盏灯火`,
      text: `平台新上了「上传作品奖励」，你此前上传的「${w.title}」${first ? '按首件大奖' : ''}补发 ${amount} 盏灯火，当前余额 ${points} 盏。`,
      points,
      delta: amount
    });
    w.uploadReward = { first, amount, via: 'backfill', plannedAt: new Date().toISOString(), paid: true, paidAt: new Date().toISOString() };
    seen.set(w.userId, idx + 1);
    changed = true;
  }
  if (changed) { saveWorks(); console.log(`上传奖励存量补齐：${[...seen.values()].reduce((a, b) => a + b, 0)} 件`); }
}

// ---------- 每日签到 ----------
// 连续签到：递增奖励 2,3,5,7,9,15,15（一轮 7 天共 56 盏，第 8 天重新算第 1 天）
// 递增曲线让每天"今天比昨天多"，收尾两天大额 + 断签清零，强烈防断签；积分账本走 share.json，签到记录写进「分享明细」
const CHECKIN_REWARDS = [2, 3, 5, 7, 9, 15, 15];
const CHECKIN_CYCLE = CHECKIN_REWARDS.length;
const CHECKIN_TOP = CHECKIN_REWARDS[CHECKIN_CYCLE - 1];   // 全勤大奖（最后一天）

function cycleDayOf(streak) { return ((Math.max(1, streak) - 1) % CHECKIN_CYCLE) + 1; }

// ---------- 激励视频送灯火（小程序详情/我的页的「看广告 +N 盏」） ----------
// 客户端回调（onClose 里 isEnded）本身可以被 hook 伪造，所以不能靠它当凭证，改按三重兜住：
//   ① 单次只给 3 盏（签到是 2-15，广告不该比签到还猛，刷也刷不出大额）
//   ② 每个账号每天最多 3 次（上限 9 盏/天，低于签到满勤 15 盏，不破坏签到激励的优先级）
//   ③ 两次领取至少隔 25 秒（激励视频本身 15-30 秒，连点脚本拿不到第二笔）
// 记 share.json 的 adReward 字段，账本走 addPoints(kind='adreward')，和其他来路分开可审计。
// 奖励按当天第几次递增：20 → 30 → 50，单日上限 100 盏。
// 为什么递增而不是平均/递减：广告收入按「播放次数」结算，第 3 次最值钱才能把人留到第 3 次，
// 递减会让用户看完第一次就走（后面更少），平均则没有凑完整一轮的动力。
// 为什么上限是 100：邀请一个真实用户注册奖励 100 盏（SHARE_REG_POINTS），
// 看三次广告（约 1 分钟）不该盖过拉一个真人——两者必须同量级，否则没人去邀请。
const AD_REWARD_SCHEDULE = [20, 30, 50];
const AD_REWARD_DAILY = AD_REWARD_SCHEDULE.length;
const AD_REWARD_TOTAL = AD_REWARD_SCHEDULE.reduce((s, v) => s + v, 0);
const AD_REWARD_GAP_MS = 25000;

function adRewardView(user) {
  const rec = shareRecOf(user.id);
  const ar = rec.adReward || {};
  const today = dateKey();
  const used = ar.day === today ? (ar.count || 0) : 0;
  const gapLeft = ar.at ? Math.max(0, AD_REWARD_GAP_MS - (Date.now() - ar.at)) : 0;
  return {
    once: used >= AD_REWARD_DAILY ? 0 : AD_REWARD_SCHEDULE[used],  // 下一次能拿几盏（字段名避开 points，响应里 points 是余额）
    schedule: AD_REWARD_SCHEDULE,     // 三档明细，前端据此展示「第 3 次最多」
    max: AD_REWARD_SCHEDULE[AD_REWARD_DAILY - 1],   // 最大单次（递增的最后一档），前端文案用
    total: AD_REWARD_TOTAL,
    limit: AD_REWARD_DAILY,
    used: used,
    left: Math.max(0, AD_REWARD_DAILY - used),
    gapMs: gapLeft                    // > 0 表示冷却中，按钮可以据此灰一下
  };
}

// 签到的展示状态：今天签没签、连续几天、下一签能拿几分
function checkinView(user) {
  const rec = shareRecOf(user.id);
  const ck = rec.checkin || { last: '', streak: 0, total: 0 };
  const today = dateKey();
  const yest = dateKey(new Date(Date.now() - 86400e3));
  const done = ck.last === today;
  const alive = done || ck.last === yest;          // 连续还挂着（今天已签或昨天签过）
  const streak = alive ? (ck.streak || 0) : 0;     // 断签就把连续天数归零
  const dayInCycle = done ? cycleDayOf(streak) : cycleDayOf(streak + 1);
  const reward = CHECKIN_REWARDS[dayInCycle - 1];
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  return {
    done, streak, dayInCycle, cycle: CHECKIN_CYCLE,
    todayPoints: reward, bonusPoints: CHECKIN_TOP, total: ck.total || 0,
    schedule: CHECKIN_REWARDS,                     // 前端进度条按表展示每天的奖励
    nextAt: tomorrow.getTime(),
    adReward: adRewardView(user)                   // 看激励视频额外送灯的当日额度（小程序端用）
  };
}

// 签到累计榜：只按「累计签到拿到的灯火」排，断签不清零，签得越久越高。
// 和灯火达人榜是两个口径：达人榜比「带来多少真实的人」，这里比「来得有多勤」——
// 新人只要肯每天来点一下就能上榜，不至于整张榜只有零星几个人。
function checkinBoard(limit = 8) {
  const rows = Object.keys(shareData.users).map(uid => {
    const u = users.find(x => x.id === uid);
    if (!u) return null;
    const ck = (shareData.users[uid] || {}).checkin || {};
    const total = ck.total || 0;
    if (!(total > 0)) return null;
    // 连续天数只在「今天已签 / 昨天签过」时才算数，断了就归零，避免榜上挂着过期记录
    const alive = (ck.last === dateKey() || ck.last === dateKey(new Date(Date.now() - 86400e3))) ? (ck.streak || 0) : 0;
    return {
      username: u.username,
      name: displayNameOf(u.username),
      points: total,
      streak: alive,
      last: ck.last || ''
    };
  }).filter(Boolean).sort((a, b) => b.points - a.points || b.streak - a.streak || String(b.last).localeCompare(String(a.last)));
  return rows.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}
// 我在签到榜上的名次（不在榜内也报真实名次，前端好显示「你目前第 N 名」）
function checkinRankOf(userId) {
  const u = users.find(x => x.id === userId);
  const all = checkinBoard(100000);
  const idx = u ? all.findIndex(r => r.username === u.username) : -1;
  const ck = (shareData.users[userId] || {}).checkin || {};
  return { rank: idx >= 0 ? idx + 1 : 0, totalRanked: all.length, points: ck.total || 0 };
}

app.get('/api/me/checkin', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  res.set('Cache-Control', 'no-store');
  res.json({ ...checkinView(user), points: shareStatsOf(user.id).points, checkinBoard: checkinBoard(8), checkinRank: checkinRankOf(user.id) });
});

app.post('/api/me/checkin', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('checkin:' + user.id, 10, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const rec = shareRecOf(user.id);
  const ck = rec.checkin || (rec.checkin = { last: '', streak: 0, total: 0 });
  const today = dateKey();
  const yest = dateKey(new Date(Date.now() - 86400e3));
  if (ck.last === today) return res.status(400).json({ error: '今天已经签过了，明天再来', ...checkinView(user) });

  const streak = ck.last === yest ? (ck.streak || 0) + 1 : 1;   // 断签从 1 重新数
  const dayInCycle = cycleDayOf(streak);
  const reward = CHECKIN_REWARDS[dayInCycle - 1];
  ck.last = today;
  ck.streak = streak;
  ck.total = (ck.total || 0) + reward;
  const points = addPoints(user.id, reward, 'checkin');
  res.json({
    ok: true, reward, streak, dayInCycle, cycle: CHECKIN_CYCLE, points, ...checkinView(user),
    checkinBoard: checkinBoard(8), checkinRank: checkinRankOf(user.id)   // 签完立刻回传最新小榜，前端原地重画
  });
});

// 看完一支激励视频，回来领灯火。客户端只说「我看完了」，服务端只认额度：
// 每日 3 次、两次间隔 25 秒、奖励 20/30/50 递增，超过就不再给（也照实回当前额度，前端好显示）。
app.post('/api/me/ad-reward', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('adreward:' + user.id, 12, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const rec = shareRecOf(user.id);
  const ar = rec.adReward || (rec.adReward = { day: '', count: 0, at: 0 });
  const today = dateKey();
  if (ar.day !== today) { ar.day = today; ar.count = 0; }
  if ((ar.count || 0) >= AD_REWARD_DAILY) {
    return res.status(400).json({ error: `今天的 ${AD_REWARD_DAILY} 次已经领完了，明天再来`, ...adRewardView(user) });
  }
  if (ar.at && Date.now() - ar.at < AD_REWARD_GAP_MS) {
    return res.status(429).json({ error: '这支广告还没看完吧，稍等一下', ...adRewardView(user) });
  }
  const amount = AD_REWARD_SCHEDULE[ar.count] || AD_REWARD_SCHEDULE[AD_REWARD_DAILY - 1];  // 先按「第几次」取金额，再自增
  ar.count = (ar.count || 0) + 1;
  ar.at = Date.now();
  const points = addPoints(user.id, amount, 'adreward');
  saveShareSoon();
  res.json({ ok: true, reward: amount, points, ...adRewardView(user) });
});

// ---------- PWA 安装奖励 ----------
// 已添加到主屏幕（standalone）的 H5 里打开且处于登录态，一次性送 200 盏灯火。
// 防刷边界：standalone 是浏览器端信号，服务端无法二次核验，所以只认「每个账号一次」——
// 就算有人直接 curl 伪造请求，最多薅到这一次 200，损失上限可控（与签到/看广告同一信任模型）。
// 前端每次在 PWA 里打开都会来调，已领过就静默返回 already，不报错不弹提示。
const PWA_BONUS_POINTS = 200;
app.post('/api/me/pwa-bonus', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('pwab:' + user.id, 5, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const rec = shareRecOf(user.id);
  if (rec.pwaBonusAt) return res.json({ ok: true, already: true, points: shareStatsOf(user.id).points });
  rec.pwaBonusAt = new Date().toISOString();
  const points = addPoints(user.id, PWA_BONUS_POINTS, 'pwa');
  addNotice(user.id, {
    kind: 'points',
    title: `桌面图标打开奖励 +${PWA_BONUS_POINTS} 盏灯火`,
    text: `你把本站装到了桌面，并用图标登录打开，送你 ${PWA_BONUS_POINTS} 盏灯火（一次性奖励），当前余额 ${points} 盏。灯火可在「推荐」用于买曝光。`,
    points,
    delta: PWA_BONUS_POINTS
  });
  res.json({ ok: true, reward: PWA_BONUS_POINTS, points });
});

// 订单收尾：只处理还在进行中的，避免重复结账
function finishRedemption(redemptionId, status) {
  const r = redemptions.find(x => x.id === redemptionId);
  if (!r || r.status !== 'active') return null;
  // 到期没投完：和「撤下」同一口径，剩余额度按原价退回，不再一刀切按「已用满」记
  if (status === 'expired') { refundRedemption(r, 'expired'); promoteQueued(r.slot); return r; }
  const ad = ads.find(a => a.id === r.adId);
  if (status === 'used_up') {
    r.used = Math.max(0, (r.views || 0) - ((ad && ad.budget) || 0));
    r.clickUsed = Math.max(0, (r.clicks || 0) - ((ad && ad.clickLeft) || 0));
  }
  r.status = status;
  r.endedAt = Date.now();
  saveRedemptions();
  promoteQueued(r.slot);   // 独占位空出来了，队头立刻接上
  return r;
}

// 主动撤下 / 后台下架：没用完的展示次数和点击额度都按原价折算退分，已用掉的不退
function refundRedemption(r, status) {
  const ad = ads.find(a => a.id === r.adId);
  // 用下单时锁住的单价折算，避免中途调价把老订单的退款算歪
  const now = redeemCfg(r.slot);
  const cfg = {
    showViews: r.showViews || now.showViews,
    showPoints: typeof r.showPoints === 'number' ? r.showPoints : now.showPoints,
    clickPoints: typeof r.clickPoints === 'number' ? r.clickPoints : now.clickPoints
  };
  // 排队中还没开投：一次都没曝光过，全额退，不按档位折算
  const neverStarted = r.status === 'queued' || !r.startsAt;
  const used = neverStarted ? 0 : Math.max(0, (r.views || 0) - ((ad && ad.budget) || 0));
  const left = Math.max(0, (r.views || 0) - used);
  const leftClicks = neverStarted ? (r.clicks || 0) : Math.max(0, ad ? (ad.clickLeft || 0) : (r.clicks || 0));
  // 单价锁在下单时（老订单可能是 0.2 / 0.5 盏/次，新订单一律整数盏/次）。
  // 新订单：剩余次数 × 整数单价 = 整数盏，退多少一分不差；
  // 老订单：0.2 / 0.5 盏/次会算出小数，Math.round 兜底取整，消耗 = 实付 - 退款 也仍是整数，
  // 用户看到的「花了多少 / 退多少」永远对得上账。总额不超过实付。
  let back = Math.round(left / cfg.showViews * cfg.showPoints) + leftClicks * cfg.clickPoints;
  back = Math.min(back, r.price || 0);
  r.used = used;
  r.clickUsed = Math.max(0, (r.clicks || 0) - leftClicks);
  r.status = status;
  r.endedAt = Date.now();
  r.refunded = back;
  saveRedemptions();
  if (back > 0) {
    addPoints(r.userId, back, 'refund', r.workId);
    // 到期是「用户不在场」时发生的退款，必须推一条站内信说清退了什么、退了多少
    if (status === 'expired') {
      const w = works.find(x => x.id === r.workId) || {};
      const points = shareStatsOf(r.userId).points;
      addNotice(r.userId, {
        kind: 'points',
        title: `推广到期，退回 ${back} 盏灯火`,
        text: `「${w.title || '你的作品'}」的推荐到了 ${REDEEM_MAX_DAYS} 天上限，已自动下线。这次推荐共花费 ${r.price || 0} 盏，其中 ${(r.price || 0) - back} 盏对应已曝光 / 已点击的部分，剩下 ${back} 盏已按原价退回，当前余额 ${points} 盏。`,
        points, delta: back
      });
    }
  }
  return back;
}

// ---------- 独占位的排队 ----------
// 只有 exclusive 的位置（首页第一格）会用到：库存 1，同时只允许一单在投，
// 后来的人在队列里等，前一单投完 / 撤下 / 到期后自动接上。
// 排队期间灯火已经扣了但一分不消耗，随时可以撤单全额退回。
function slotActiveRedemption(slot) {
  return redemptions.find(r => r.slot === slot && r.status === 'active') || null;
}
function slotQueue(slot) {
  return redemptions.filter(r => r.slot === slot && r.status === 'queued')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
// 有空位就把队头扶正。纯同步函数，调用点都在写操作之前，不会有两个请求同时抢到同一格。
function promoteQueued(slot) {
  const cfg = redeemCfg(slot);
  if (!cfg.exclusive) return null;
  if (slotActiveRedemption(slot)) return null;
  const next = slotQueue(slot)[0];
  if (!next) return null;
  const now = Date.now();
  next.status = 'active';
  next.startsAt = now;
  next.endsAt = now + REDEEM_MAX_DAYS * 86400e3;
  const ad = ads.find(a => a.id === next.adId);
  if (ad) {
    ad.active = true;
    ad.queued = false;
    ad.endsAt = next.endsAt;
    scheduleAdSave();
  }
  saveRedemptions();
  return next;
}
function promoteAllQueues() {
  let n = 0;
  REDEEM_SLOTS.filter(s => s.exclusive).forEach(s => { if (promoteQueued(s.key)) n++; });
  return n;
}

// 兜底巡检：到期或额度耗尽的兑换广告统一下线。启动时跑一次，之后每分钟一次。
function expireRedemptions() {
  const now = Date.now();
  let changed = false;
  redemptions.forEach(r => {
    if (r.status !== 'active' || !r.endsAt || r.endsAt > now) return;
    const ad = ads.find(a => a.id === r.adId);
    if (ad && ad.active !== false) { ad.active = false; scheduleAdSave(); }
    // 到期没投完：剩余额度按原价退回（和「撤下」同口径），用户不在场时发生的退款要发站内信
    finishRedemption(r.id, 'expired');
    changed = true;
  });
  ads.forEach(a => {
    if (a.source !== 'redeem' || a.active === false) return;
    const r = redemptions.find(x => x.id === a.redemptionId);
    const showBased = !r || (r.views || 0) > 0;   // 兼容老数据：找不到订单按展示包算
    const exhausted = showBased ? (a.budget || 0) <= 0 : (a.clickLeft || 0) <= 0;
    if (exhausted || (a.endsAt && a.endsAt <= now)) {
      a.active = false;
      scheduleAdSave();
      finishRedemption(a.redemptionId, exhausted ? 'used_up' : 'expired');
    }
  });
  if (changed) saveRedemptions();
  promoteAllQueues();   // 独点位的空位能扶正就扶正，别让排队的人白等
}

// 我的投放列表：剩余曝光、已展示、点击都实时算
function myRedemptionList(user) {
  return redemptions.filter(r => r.userId === user.id)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(r => {
      const ad = ads.find(a => a.id === r.adId);
      const st = ad ? adStatsOf(ad.id) : { pv: 0, uv: 0 };
      const slot = AD_SLOTS.find(s => s.key === r.slot) || {};
      const cfg = redeemCfg(r.slot);
      const w = works.find(x => x.id === r.workId) || {};
      const used = r.status === 'active'
        ? Math.max(0, (r.views || 0) - ((ad && ad.budget) || 0))
        : (r.used || 0);
      const clicks = r.clicks || 0;
      const clickLeft = ad ? Math.max(0, ad.clickLeft || 0) : Math.max(0, clicks - (r.clickUsed || 0));
      // 排队中的排第几位：只数同位置的队列，用户据此判断还要等多久
      const queuePos = r.status === 'queued'
        ? slotQueue(r.slot).findIndex(x => x.id === r.id) + 1 : 0;
      return {
        id: r.id, workId: r.workId, workTitle: w.title || '（作品已下线）',
        slot: r.slot, slotName: slot.name || r.slot, exclusive: !!cfg.exclusive,
        extLink: r.extLink === true, link: r.extLink === true ? (r.link || '') : '',
        // 暴露下单时锁住的单价（老数据没有才落到现价）：前端「撤下可退」预估必须和实际退款同一口径
        showViews: r.showViews || cfg.showViews,
        showPoints: typeof r.showPoints === 'number' ? r.showPoints : cfg.showPoints,
        clickPoints: typeof r.clickPoints === 'number' ? r.clickPoints : cfg.clickPoints,
        views: r.views || 0, used, left: Math.max(0, (r.views || 0) - used),
        clicks, clickLeft, clickUsed: Math.max(0, clicks - clickLeft),
        showPrice: r.showPrice || 0, clickPrice: r.clickPrice || 0,
        price: r.price || 0, status: r.status, refunded: r.refunded || 0,
        createdAt: r.createdAt, startsAt: r.startsAt || 0, endsAt: r.endsAt || 0,
        queuePos, pv: st.pv || 0, uv: st.uv || 0
      };
    });
}

function redeemSlotView(user) {
  return REDEEM_SLOTS.map(c => {
    const adSlot = AD_SLOTS.find(s => s.key === c.key) || {};
    const active = slotActiveRedemption(c.key);
    const activeAd = active ? ads.find(a => a.id === active.adId) : null;
    const activeWork = active ? works.find(w => w.id === active.workId) : null;
    // 共享位（详情页/榜单顶部）可以多家同时投：给前端一个在投条数，买之前心里有数
    const activeCount = redemptions.filter(r => r.slot === c.key && r.status === 'active').length;
    return {
      key: c.key, name: adSlot.name || c.key, where: c.where || adSlot.where || '',
      note: c.note || '',
      showViews: c.showViews, showPoints: c.showPoints, clickPoints: c.clickPoints,
      extClickPoints: c.extClickPoints || c.clickPoints * 2,
      showPacks: c.showPacks, clickPacks: c.clickPacks,
      // 位置属于哪个端：mini = 微信小程序里的位（手机真机），web = 网页端的位。
      // 推荐面板据此按作品形态给「优先投哪一端」的建议——只是建议，两端都能投，不做任何拦截。
      platform: adSlot.platform === 'mini' ? 'mini' : 'web',
      exclusive: !!c.exclusive, maxActive: c.maxActive,
      // 小程序位还在审核期：面板里照样列出来（价格、位置、预览都能看），但底部按钮点了只提示，不下单
      onSale: c.onSale !== false,
      internalOnly: !!c.internalOnly,
      // 刚发布提醒的新鲜口径（小时）：>0 的位置，作品还没满这个年龄时前端要先劝一句
      freshHours: c.freshHours || 0,
      pendingNote: c.onSale === false ? (c.pendingNote || '这个位置还没开放购买') : '',
      // 独占位的实时占用情况：谁在投、什么时候空出来、队里有几个人
      occupied: !!active,
      occupiedBy: activeWork ? activeWork.title : '',
      occupiedMine: !!(active && user && active.userId === user.id),
      freeAt: active ? (active.endsAt || 0) : 0,
      queueLen: slotQueue(c.key).length,
      // 该位置当前在投的条数（独占位恒为 0/1，与 occupied 一致；共享位可能 >1）
      activeCount
    };
  });
}

function redeemPayload(user) {
  const slots = redeemSlotView(user);
  const detail = redeemCfg('detail');
  return {
    // 兼容老前端：顶层这三个仍是详情页的单价，新前端按 slots[] 里各自的单价算
    showViews: detail.showViews,
    showPoints: detail.showPoints,
    clickPoints: detail.clickPoints,
    showPacks: detail.showPacks,
    clickPacks: detail.clickPacks,
    maxActive: Math.max(...REDEEM_SLOTS.map(s => s.maxActive)),
    maxDays: REDEEM_MAX_DAYS,
    dayCapViews: REDEEM_DAY_CAP_VIEWS,
    dayCapClicks: REDEEM_DAY_CAP_CLICKS,
    ipCapViews: REDEEM_IP_CAP_VIEWS,
    ipCapClicks: REDEEM_IP_CAP_CLICKS,
    slots,
    points: user ? shareStatsOf(user.id).points : 0,
    // 能投的只有自己名下、已过审的作品
    works: user ? works.filter(w => w.userId === user.id && !w.deleted && isVisible(w))
      .map(w => ({ id: w.id, title: w.title, thumb: w.thumb || w.image || '', category: w.category || '', site: workSiteOf(w),
        // 作品形态：推荐面板按它给「优先投网页端还是小程序端」的建议（Android / 小程序 → 手机用户，
        // Web / 桌面 → 电脑用户）。老数据没有 types 时退回单个 type，都没有就不给建议。
        types: Array.isArray(w.types) && w.types.length ? w.types : (w.type ? [w.type] : []),
        // 发布时刻：前端据此算「刚发布多久」，用来决定要不要提醒「它本来就在首页第一屏」
        createdAt: w.createdAt || '',
        // 带形态标签的外链候选：作品填了多个地址（官网 / iOS / Android…）时，前端列成可点选的候选
        links: workLinkEntriesOf(w) })) : [],
    mine: user ? myRedemptionList(user) : []
  };
}

app.get('/api/redeem/options', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  promoteAllQueues();   // 打开面板时顺手扶正队头：上一位到期了但没人触发也能接上
  res.json(redeemPayload(currentUser(req)));
});

// 兑换：按位置单价一次付清 → 生成一条广告（内容取自作品）→ 立即上线，或进独占位的队列
// 并发说明：这个接口从头到尾是同步的（没有 await），Node 单线程下「查空位 → 占位」不会被另一个
// 请求插进来，所以两个人同时点购买也不可能都拿到 1 号位，第二个必然进队列。
app.post('/api/redeem', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('redeem:' + user.id, 6, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const body = req.body || {};
  const views = parseInt(body.views, 10) > 0 ? parseInt(body.views, 10) : 0;
  const clicks = parseInt(body.clicks, 10) > 0 ? parseInt(body.clicks, 10) : 0;
  const workId = String(body.workId || '');
  const slot = REDEEM_SLOT_KEYS.includes(String(body.slot || '')) ? String(body.slot) : 'detail';
  const cfg = redeemCfg(slot);
  // 小程序位还在审核：面板能看、能预览，但不下单、不扣灯火（避免「花了灯火买到一个还没上线的位置」）
  if (cfg.onSale === false) {
    return res.status(400).json({ error: cfg.pendingNote || '这个位置还没开放购买' });
  }
  // 点击去向：不填 = 默认开作品详情页；填了 = 点卡片跳这个链接（外链，单价 × 2）
  const link = String(body.link || '').trim().slice(0, 300);
  // 小程序位只跳站内详情页：小程序里外链只能复制到剪贴板，付了点击费却带不走流量
  if (cfg.internalOnly && link) {
    return res.status(400).json({ error: '小程序推荐位只跳站内作品详情页，不支持外链去向' });
  }

  // 二选一：要么买展示包，要么买点击包，不能同时买
  if (views > 0 && clicks > 0) return res.status(400).json({ error: '展示包和点击包二选一，不能同时买' });
  if (views > 0) {
    if (!cfg.showPacks.includes(views)) return res.status(400).json({ error: '展示次数档位不对' });
  } else if (clicks > 0) {
    if (!cfg.clickPacks.includes(clicks)) return res.status(400).json({ error: '点击次数档位不对' });
  } else {
    return res.status(400).json({ error: '请先选一个套餐：展示包或点击包' });
  }
  const work = works.find(w => w.id === workId);
  if (!work || work.deleted) return res.status(400).json({ error: '作品不存在' });
  if (work.userId !== user.id) return res.status(400).json({ error: '只能推广自己名下的作品' });
  if (!isVisible(work)) return res.status(400).json({ error: '这件作品还没正式上线，上线后才能投放' });

  // 刚发布就买「首页第一格」：先劝一次，不硬拦。
  // 首页默认按最新排，这件作品本来就占着置顶之后的第一张卡，这时买第一格买到的是角标不是位置。
  // 用 409 + code 让前端弹确认，用户点「仍然要投」会带 ackFresh 再来一次——规则在服务端，
  // 前端只是把它翻译成人话，绕过界面直接调接口也躲不过这句提醒。
  const freshHours = cfg.freshHours || 0;
  if (freshHours && body.ackFresh !== true) {
    const ageHours = (Date.now() - new Date(work.createdAt || 0).getTime()) / 3600e3;
    if (ageHours >= 0 && ageHours < freshHours) {
      return res.status(409).json({
        error: `这件作品刚发布 ${Math.max(1, Math.round(ageHours))} 小时，本来就在首页最新列表的第一屏，先确认一下再投`,
        code: 'fresh', freshHours, ageHours: Math.round(ageHours * 10) / 10
      });
    }
  }

  // 外链去向校验：只能跳作品自己登记的官网/下载链接（投稿时过过目的），格式顺手再查一道
  let extLink = '';
  if (link) {
    if (!/^https?:\/\/[^\s]+$/i.test(link)) {
      return res.status(400).json({ error: '链接要以 http:// 或 https:// 开头，且中间不能有空格' });
    }
    extLink = workSiteMatch(work, link);
    if (!extLink) {
      return res.status(400).json({ error: '外链点击只能跳这件作品自己填的官网 / 下载链接（可在编辑作品里补一个），不能填别的地址' });
    }
    // 外链必须按点击买：曝光包没有点击额度，点击不计价，等于白送外链跳转（见 REDEEM_SLOTS 上面的计价说明）
    if (views > 0) {
      return res.status(400).json({ error: '跳官网 / 下载链接只能买点击包：曝光包不按点击计费，不能用来带外链流量。想跳外链请选一个点击包' });
    }
  }

  expireRedemptions();   // 先把到期 / 投完的收尾，空位才能算准
  promoteQueued(slot);   // 独占位：先看有没有排队的人该接上

  const mine = redemptions.filter(r => r.userId === user.id);
  const myActive = mine.filter(r => r.status === 'active');
  const myQueuedHere = mine.filter(r => r.status === 'queued' && r.slot === slot);
  const myActiveHere = myActive.filter(r => r.slot === slot);
  if (cfg.exclusive && (myActiveHere.length >= cfg.maxActive || myQueuedHere.length >= cfg.maxQueued)) {
    return res.status(400).json({ error: '这个位置你已经在投或排队了，等这一单投完再来' });
  }
  // 非独占位沿用老规则：全局最多 maxActive 条在投（2026-11-06 起 2 → 3）
  if (!cfg.exclusive && myActive.length >= cfg.maxActive) {
    return res.status(400).json({ error: `同时最多 ${cfg.maxActive} 条投放，先等其中一条投完或手动撤下` });
  }
  if (mine.some(r => (r.status === 'active' || r.status === 'queued') && r.workId === workId && r.slot === slot)) {
    return res.status(400).json({ error: '这件作品已经在这个位置投放或排队了' });
  }

  // 外链订单：点击单价用外链价（下单时锁定，之后调价不影响这单的退款口径）
  const clickUnit = extLink ? (cfg.extClickPoints || cfg.clickPoints * 2) : cfg.clickPoints;
  const showPrice = redeemShowPriceOf(views, slot);
  const clickPrice = clicks * clickUnit;
  const price = showPrice + clickPrice;
  const points = shareStatsOf(user.id).points;
  if (points < price) return res.status(400).json({ error: `灯火不够：需要 ${price} 盏，你还剩 ${points} 盏` });

  const now = Date.now();
  const redemptionId = 'rd' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const adId = 'ad' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const img = work.thumb || work.image || '';
  // 独占位且已经有人在投 → 这一单先进队列，广告建好但 active:false，不上任何位置
  const occupied = cfg.exclusive && !!slotActiveRedemption(slot);
  const ad = {
    id: adId,
    slot,
    kind: img ? 'image' : 'text',
    title: work.title,
    desc: truncateText(work.prompt || work.desc || '', 60),
    image: img,
    url: extLink || ('/w/' + encodeURIComponent(work.id)),
    extUrl: !!extLink,        // 推荐 + 外链：点击跳作品登记的官网/下载地址
    link: extLink,            // 原样存登记的链接（撤下/退款/后台排查用）
    workId: work.id,
    cta: extLink ? '打开链接 ↗' : '看看这个作品',
    active: !occupied,
    queued: occupied,
    source: 'redeem',       // 后台据此区分「运营投放」与「积分兑换」
    ownerId: user.id,
    redemptionId,
    budget: views,          // 剩余展示次数，被看到一次扣 1
    clickLeft: clicks,      // 剩余点击额度，被点一次扣 1
    endsAt: occupied ? 0 : now + REDEEM_MAX_DAYS * 86400e3,
    sort: adsOfSlot(slot).length,
    clicks: 0,
    createdAt: new Date(now).toISOString()
  };
  ads.push(ad);
  saveAds();
  redemptions.push({
    id: redemptionId, adId, userId: user.id, workId: work.id, slot,
    views, clicks, showPrice, clickPrice, price,
    showViews: cfg.showViews, showPoints: cfg.showPoints, clickPoints: clickUnit,  // 锁住下单时的单价（外链单锁的是外链价），以后调价不影响老订单退款
    extLink: !!extLink, link: extLink,
    used: 0, clickUsed: 0, status: occupied ? 'queued' : 'active',
    createdAt: now,
    startsAt: occupied ? 0 : now,
    endsAt: occupied ? 0 : ad.endsAt
  });
  saveRedemptions();
  addPoints(user.id, -price, 'redeem', work.id);

  const queuedPos = occupied ? slotQueue(slot).findIndex(r => r.id === redemptionId) + 1 : 0;
  res.json({ ok: true, ad: publicAd(ad), queued: occupied, queuePos: queuedPos, ...redeemPayload(user) });
});

// 撤下：按剩余展示退分（点击已消耗的不退）；排队中的单子一次没曝光过，全额退回
app.post('/api/me/ads/:id/cancel', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const r = redemptions.find(x => x.id === req.params.id && x.userId === user.id);
  if (!r) return res.status(404).json({ error: '找不到这条投放' });
  if (r.status !== 'active' && r.status !== 'queued') return res.status(400).json({ error: '这条投放已经结束了' });
  const ad = ads.find(a => a.id === r.adId);
  if (ad) { ad.active = false; ad.queued = false; scheduleAdSave(); saveAds(); }
  const back = refundRedemption(r, 'cancelled');
  promoteQueued(r.slot);   // 如果撤的是在投的那一单，队头立刻接上
  res.json({ ok: true, refunded: back, ...redeemPayload(user) });
});


// 站内搜索命中哪些字段、各值多少分。
// 之前只匹配「标题 / 作者账号 / 简介 / 分类」，直接导致三类搜不到：
//   · 形态名（搜「小程序」「Web」「iOS」全 0，站里明明有）
//   · 作者昵称（作品存的是账号名，用户改了昵称就搜不到自己）
//   · 链接域名（想找某个网站上的作品，只能整串网址）
// 权重只影响相关度排序：越「像名字」的字段越靠前。
function searchHostOf(u) {
  try { return new URL(String(u || '')).hostname.replace(/^www\./, ''); } catch { return ''; }
}
const SEARCH_FIELDS = [
  [w => w.title, 8],
  [w => [w.author, displayNameOf(w.author), w.authorReal].join(' '), 6],
  [w => catsOf(w).join(' '), 5],
  [w => typesOf(w).join(' '), 5],
  // 用户真会打的标签词：开源 / 付费 / 预告
  [w => [w.openSource === true ? '开源' : '', w.paid ? '付费 收费' : '', stageOf(w) === 'wip' ? '预告 开发中' : ''].join(' '), 3],
  [w => w.prompt, 2],
  [w => [searchHostOf(w.site), searchHostOf(w.link), w.repo].join(' '), 1]
];
// 返回 0 = 不命中；>0 = 相关度。空格分词按 AND：每个词都得在某个字段里出现
function searchScore(w, q) {
  const kw = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!kw) return 0;
  const tokens = kw.split(' ').filter(Boolean);
  const fields = SEARCH_FIELDS.map(([pick, weight]) => [String(pick(w) || '').toLowerCase(), weight]);
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const [v, weight] of fields) {
      if (v && v.includes(t)) { if (weight > best) best = weight; }
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

// 作品列表：搜索 + 筛选 + 分页 + 排序
app.get('/api/works', (req, res) => {
  const { q, category, type, sort } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  // pageSize=all（兼容旧的 limit=500）→ 返回全部，用于全量统计
  const rawSize = String(req.query.pageSize || req.query.limit || '15');
  const pageSize = rawSize === 'all' ? Number.MAX_SAFE_INTEGER : Math.min(48, Math.max(1, parseInt(rawSize) || 15));

  const user = currentUser(req);
  let list = publicWorks(req);
  if (category && category !== '全部') list = list.filter(w => catsOf(w).includes(category));
  if (type && type !== '全部') list = list.filter(w => typesOf(w).includes(type));
  // 是否开源筛选：open → 标注开源；closed → 非开源（含未标注的老作品）
  if (req.query.os === 'open') list = list.filter(w => w.openSource === true);
  else if (req.query.os === 'closed') list = list.filter(w => w.openSource !== true);
  // 发布时间筛选：3d / 7d / 30d（不传或其它值＝全部时间）
  const RANGE_DAYS = { '3d': 3, '7d': 7, '30d': 30 };
  const rangeDays = RANGE_DAYS[String(req.query.range || '')];
  if (rangeDays) {
    const since = Date.now() - rangeDays * 86400000;
    list = list.filter(w => new Date(w.createdAt).getTime() >= since);
  }
  // 只看我收藏的（需登录，未登录返回空列表）
  if (req.query.fav === '1') {
    const favIds = new Set(user && Array.isArray(user.favs) ? user.favs : []);
    list = list.filter(w => favIds.has(w.id));
  }
  // 搜索：命中留、不命中丢，同时缓存相关度（排序用）
  let ranked = null;
  if (q) {
    ranked = [];
    list.forEach(w => {
      const s = searchScore(w, q);
      if (s) ranked.push({ w, s });
    });
  }

  if (ranked) {
    // 相关度优先 → 置顶 → 新的在前。别让「刚发布」压过「最匹配的那件」
    ranked.sort((a, b) => b.s - a.s
      || (b.w.pinned ? 1 : 0) - (a.w.pinned ? 1 : 0)
      || new Date(b.w.createdAt) - new Date(a.w.createdAt));
    list = ranked.map(r => r.w);
  } else if (sort === 'hot') {
    list.sort((a, b) => score(b) - score(a));
  } else {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    // 置顶优先（最新列表里；搜索结果已经按相关度排好，不再重排）
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }

  // 首页「最新」的屏蔽降权：只在「无任何筛选的全量最新列表」生效。
  // 搜索（按相关度）、分类/形态/时间/开源筛选、我的收藏、作者主页（走 /api/authors）一律不受影响——
  // 尤其不能波及作者主页，那是把作品在作者自己家门口往后排，解释不通。
  const blockEligible = !ranked && sort !== 'hot' && !req.query.os && !rangeDays
    && req.query.fav !== '1' && (!category || category === '全部') && (!type || type === '全部');
  if (blockEligible) list = applyBlockShift(list, blockShiftMap(list.map(w => w.id)));

  const total = list.length;
  // 记一次搜索（只在第一页记：翻页、重试、预取都不算新的搜索意图）
  if (q && page === 1) logSearch(req, q, total);
  const items = list.slice((page - 1) * pageSize, page * pageSize).map(w => publicWork(w, user));
  res.json({ items, total, page, pageSize, hasMore: page * pageSize < total });
});

// 本周精选：管理员勾选的精选作品固定压轴，其余按数据自动补充
//   来源 = 管理员精选 ＋「近 7 天访客（UV）最多的 10 个」＋「点赞最多的 5 个」＋「收藏最多的 5 个」，去重合并
//   展示公平性：非站方作品的展示顺序每天用固定日种子洗一次牌（同一天内所有人看到的顺序一致，
//   榜单可信感还在，但高热作品不再永远霸住前排）。
//   新作品不额外插入：首页「最新」列表已经把新作品顶在最前，精选只负责按数据选，避免重复曝光
const FEATURED_TOP = 20;
const FEATURED_DAYS = 7;
const FEATURED_UV = 10;
const FEATURED_EACH = 5;

// 固定种子伪随机（mulberry32）：同一种子产生的序列稳定，用于每日洗牌
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
app.get('/api/featured', (req, res) => {
  const user = currentUser(req);
  const visible = publicWorks(req);
  const rows = visible.map(w => {
    const m = workPvUv(w.id, FEATURED_DAYS);
    return { w, uv7: m.uv, pv7: m.pv, pvAll: (workVisits[w.id] && workVisits[w.id].pv) || 0 };
  });
  const heat = r => r.uv7 + (r.w.favs || 0) * 5 + (r.w.likes || 0) * 2;
  const byUv = rows.slice()
    .sort((a, b) => b.uv7 - a.uv7 || b.pvAll - a.pvAll || score(b.w) - score(a.w))
    .slice(0, FEATURED_UV);
  const byLikes = rows.slice()
    .sort((a, b) => (b.w.likes || 0) - (a.w.likes || 0) || (b.w.favs || 0) - (a.w.favs || 0))
    .slice(0, FEATURED_EACH);
  const byFavs = rows.slice()
    .sort((a, b) => (b.w.favs || 0) - (a.w.favs || 0) || (b.w.likes || 0) - (a.w.likes || 0))
    .slice(0, FEATURED_EACH);
  // 去重合并：管理员精选排最前（同样按热度内部排序），然后依次 UV 榜、点赞榜、收藏榜
  const merged = new Map();
  rows.filter(r => isFeaturedActive(r.w)).sort((a, b) => heat(b) - heat(a)).forEach(r => merged.set(r.w.id, r));
  [byUv, byLikes, byFavs].forEach(list => list.forEach(r => { if (!merged.has(r.w.id)) merged.set(r.w.id, r); }));
  if (merged.size < FEATURED_TOP) {
    rows.filter(r => !merged.has(r.w.id))
      .sort((a, b) => heat(b) - heat(a))
      .slice(0, FEATURED_TOP - merged.size)
      .forEach(r => merged.set(r.w.id, r));
  }
  // 每日固定种子洗牌：管理员精选永远在（内部按热度压轴），非站方部分每天换顺序
  const daySeed = Math.floor(Date.now() / 86400000);
  const rand = mulberry32(daySeed);
  const shuffle = arr => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  // 入选理由：优先展示数据依据（点赞 / 收藏 / 访客），站方手选的作品也一视同仁，
  // 只有实在没有任何数据依据时才走 pick 兜底——避免「编辑精选 = 站方内定」的观感
  const reasonOf = new Map();
  byLikes.forEach(r => { if (!reasonOf.has(r.w.id) && (r.w.likes || 0) > 0) reasonOf.set(r.w.id, 'like'); });
  byFavs.forEach(r => { if (!reasonOf.has(r.w.id) && (r.w.favs || 0) > 0) reasonOf.set(r.w.id, 'fav'); });
  byUv.forEach(r => { if (!reasonOf.has(r.w.id) && r.uv7 > 0) reasonOf.set(r.w.id, 'uv'); });
  rows.filter(r => isFeaturedActive(r.w)).forEach(r => {
    if (reasonOf.has(r.w.id)) return;
    if ((r.w.likes || 0) > 0) reasonOf.set(r.w.id, 'like');
    else if ((r.w.favs || 0) > 0) reasonOf.set(r.w.id, 'fav');
    else if (r.uv7 > 0) reasonOf.set(r.w.id, 'uv');
    else reasonOf.set(r.w.id, 'pick');
  });
  const pool = [...merged.values()];
  const adminPicks = pool.filter(r => isFeaturedActive(r.w)).sort((a, b) => heat(b) - heat(a));
  const normal = shuffle(pool.filter(r => !r.w.featured));
  const keep = Math.max(0, Math.min(normal.length, FEATURED_TOP - adminPicks.length));
  // 非站方作品（洗牌后）打头，站方精选压轴（内部也按热度），
  // 避免按来源分段导致交界处数字忽高忽低
  const list = [...normal.slice(0, keep), ...adminPicks]
    .slice(0, FEATURED_TOP)
    .map(r => ({
      ...publicWork(r.w, user), uv7: r.uv7, pv7: r.pv7, adminPick: isFeaturedActive(r.w),
      featReason: reasonOf.get(r.w.id) || 'new'
    }));
  res.json({ days: FEATURED_DAYS, list });
});

// 榜单：period = week / month / all；by = hot（综合）/ likes（点赞）/ favs（收藏）/ tips（打赏人数）/ pv / uv
const RANK_BY = {
  hot: (a, b) => score(b) - score(a),
  likes: (a, b) => (b.likes || 0) - (a.likes || 0) || (b.favs || 0) - (a.favs || 0),
  favs: (a, b) => (b.favs || 0) - (a.favs || 0) || (b.likes || 0) - (a.likes || 0),
  // 打赏人数：不同打赏者多的在前；人数打平比灯火总额，再比综合分
  tips: (a, b) => tipTippersOf(b.id) - tipTippersOf(a.id)
    || tipAggOf(b.id).total - tipAggOf(a.id).total
    || score(b) - score(a),
  // PV / UV 默认按全部口径（/api/rank 里会按 period 覆盖）
  pv: (a, b) => workPvUv(b.id, 36500).pv - workPvUv(a.id, 36500).pv || score(b) - score(a),
  uv: (a, b) => workPvUv(b.id, 36500).uv - workPvUv(a.id, 36500).uv || score(b) - score(a)
};
app.get('/api/rank', (req, res) => {
  const period = ['week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'week';
  const by = Object.prototype.hasOwnProperty.call(RANK_BY, req.query.by) ? req.query.by : 'hot';
  const limit = Math.min(100, parseInt(req.query.limit) || 10);
  // 形态筛选（可选）：与首页 /api/works 同一口径，按 typesOf 命中才算
  const type = (req.query.type || '').trim();
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 36500;
  const since = Date.now() - days * 86400000;
  const today = dateKey();
  const user = currentUser(req);
  const usePvUv = by === 'pv' || by === 'uv';
  const metric = w => workPvUv(w.id, days)[by];
  const list = publicWorks(req).filter(w => new Date(w.createdAt).getTime() >= since)
    .filter(w => !type || type === '全部' || typesOf(w).includes(type))
    .sort((a, b) => (usePvUv ? metric(b) - metric(a) : RANK_BY[by](a, b)) || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit)
    .map((w, i) => {
      const m = workPvUv(w.id, days);
      return {
        ...publicWork(w, user), rank: i + 1, pv: m.pv, uv: m.uv, hotScore: score(w),
        tipsTippers: tipTippersOf(w.id),
        isNew: dateKey(new Date(w.createdAt)) === today
      };
    });
  res.json(list);
});

// 榜单形态下拉的条数：按所选周期统计，与 /api/rank 完全同一套过滤口径（上架时间 + 公开）。
// 否则下拉里的数字是全站总量，「周榜 + Web」显示 14 件、列表里其实只有 8 件，口径对不上。
app.get('/api/rank/counts', (req, res) => {
  const period = ['week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'week';
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 36500;
  const since = Date.now() - days * 86400000;
  const counts = {};
  let total = 0;
  publicWorks(req).filter(w => new Date(w.createdAt).getTime() >= since).forEach(w => {
    total++;
    typesOf(w).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  });
  res.json({ period, total, counts });
});

// 今日动态：给榜单页一行「今天站里发生了什么」的聚合数字。
// 只报总量、不做排名——站点体量还小时，日榜和「较昨日涨跌」都会被一两次偶然互动主导；
// 聚合数字即使今天只有 1 件新作品也不显空，还能给老访客一个回来的理由。
app.get('/api/today', (req, res) => {
  const today = dateKey();
  const onToday = t => t != null && dateKey(new Date(t)) === today;
  const publicIds = new Set(publicWorks(req).map(w => w.id));
  const day = (visits && visits.days && visits.days[today]) || {};
  res.json({
    date: today,
    works: publicWorks(req).filter(w => onToday(w.createdAt)).length,
    tips: tips.filter(t => onToday(t.createdAt)).reduce((n, t) => n + (Number(t.amount) || 0), 0),
    comments: comments.filter(c => onToday(c.createdAt) && publicIds.has(c.workId)).length,
    visitors: day.uv ? Object.keys(day.uv).filter(k => !visitExcludeSet().has(k)).length : 0
  });
});

// 访问分：浏览量的进入综合分时做封顶——最多只算「独立访客×4 + 20」。
// 这样同一个 IP 把详情页刷到 500 次，也只能顶到这个上限，拿不到额外排名分；
// 而真实增长的访客会同步抬高上限，正常作品不受影响。
function viewScore(w) {
  const views = w.views || 0;
  if (views <= 0) return 0;
  const uv = workPvUv(w.id, 36500).uv || 0;
  return Math.min(views, uv * 4 + 20);
}
// 评论分：只数登录用户发的评论；作者自己在自己作品下的评论不计（自评刷分）
function commentScore(w) {
  const total = (commentStats().scoreable[w.id]) || 0;
  if (!total || !w.userId) return total;
  let self = 0;
  for (const c of comments) {
    if (c.workId === w.id && !c.anon && c.userId === w.userId) self++;
  }
  return Math.max(0, total - self);
}
// 综合分 = 获赞×5 + 收藏×8 + 评论×1 + 灯火人数×10 + 访问分（规则同时在榜单页图例里对用户写明）
// 灯火计分按「送过灯火的人数」：同一人送多笔只算 1 份，和获赞/收藏一样是「一人一票」，
// 避免单笔大额打赏直接碾压真实口碑；匿名/未认领作品收到的灯火同样计分（送礼必须登录，都有人头）
function score(w) { return (w.likes || 0) * 5 + (w.favs || 0) * 8 + commentScore(w) + tipTippersOf(w.id) * 10 + viewScore(w); }

// 作者主页
app.get('/api/authors/:name', (req, res) => {
  const name = req.params.name;
  const user = currentUser(req);
  const list = filterBlocked(worksOfAuthorName(name).filter(w => isVisible(w)), user)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(w => publicWork(w, user));
  const creator = creators.find(c => c.name === name);
  res.json({
    name,
    displayName: displayNameOf(name),
    verified: !!creator,
    tags: userTagsOf(name),
    bio: creator ? creator.bio || '' : '',
    total: list.length,
    totalLikes: list.reduce((s, w) => s + w.likes, 0),
    totalFavs: list.reduce((s, w) => s + (w.favs || 0), 0),
    works: list
  });
});

// 作品详情（浏览量 +1；作者/管理员可用 ?nopv=1 跳过计数，比如自己生成分享卡片时）
// ---------- 作品兑换码 ----------
// 结构：{ '<workId>': { codes: [{ code, status:'available'|'taken', takenAt, takenBy }], claimed: { 'u:<uid>'/'ip:<ip>': '<code>' } } }
// 作者发布一批兑换码，访客领取：每个 IP（登录则每个账号）对同一作品只能领一个
let codeStore = readJSON('codes.json', {});
let codeSaveTimer = null;
function saveCodesSoon() {
  if (codeSaveTimer) return;
  codeSaveTimer = setTimeout(() => {
    codeSaveTimer = null;
    writeJSON('codes.json', codeStore);
  }, 500);
}
function codesOf(workId) { return (codeStore[workId] && codeStore[workId].codes) || []; }
function claimKeyOf(req, user) { return user && user.id ? 'u:' + user.id : 'ip:' + clientIp(req); }
function canManageCodes(w, user, req) { return !!user && ((w.userId && w.userId === user.id) || isAdmin(req)); }

// 作者查看自己作品的兑换码列表
app.get('/api/works/:id/codes', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (!canManageCodes(w, user, req)) return res.status(403).json({ error: '只能管理自己作品的兑换码' });
  res.json({ codes: codesOf(w.id) });
});

// 作者批量添加兑换码（支持换行/逗号/分号分隔，去重，单作品上限 200）
app.post('/api/works/:id/codes', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (!canManageCodes(w, user, req)) return res.status(403).json({ error: '只能管理自己作品的兑换码' });
  const raw = String((req.body || {}).codes || '');
  const tokens = raw.split(/[\s,，;；]+/).map(s => s.trim()).filter(Boolean);
  if (!tokens.length) return res.status(400).json({ error: '请输入兑换码，多个用换行或逗号隔开' });
  const rec = codeStore[w.id] || (codeStore[w.id] = { codes: [], claimed: {} });
  const exist = new Set(rec.codes.map(c => c.code));
  let added = 0, dup = 0;
  for (const t of tokens) {
    if (rec.codes.length >= 200) return res.status(400).json({ error: '每个作品最多 200 个兑换码' });
    if (t.length > 60) return res.status(400).json({ error: '单个兑换码最长 60 字符' });
    if (exist.has(t)) { dup += 1; continue; }
    exist.add(t);
    rec.codes.push({ code: t, status: 'available', takenAt: null, takenBy: '' });
    added += 1;
  }
  if (added) saveCodesSoon();
  res.json({ ok: true, added, dup, total: rec.codes.length });
});

// 作者删除未被领取的兑换码
app.post('/api/works/:id/codes/delete', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (!canManageCodes(w, user, req)) return res.status(403).json({ error: '只能管理自己作品的兑换码' });
  const code = String((req.body || {}).code || '').trim();
  const rec = codeStore[w.id];
  if (!rec) return res.status(404).json({ error: '没有兑换码' });
  const target = rec.codes.find(c => c.code === code);
  if (!target) return res.status(404).json({ error: '兑换码不存在' });
  if (target.status === 'taken') return res.status(400).json({ error: '已被领取的码不能删除' });
  rec.codes = rec.codes.filter(c => c.code !== code);
  saveCodesSoon();
  res.json({ ok: true, total: rec.codes.length });
});

// 访客领取兑换码：登录按账号、匿名按 IP，同一作品只能领一个；重复请求原样返回已领的码
app.post('/api/works/:id/redeem', (req, res) => {
  if (!rateLimit('redeem:' + clientIp(req), 12, 3600000)) {
    return res.status(429).json({ error: '操作太频繁，请稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w || !isVisible(w)) return res.status(404).json({ error: '作品不存在或未通过审核' });
  const user = currentUser(req);
  const rec = codeStore[w.id];
  const key = claimKeyOf(req, user);
  if (rec && rec.claimed && rec.claimed[key]) {
    return res.json({ ok: true, code: rec.claimed[key], again: true });
  }
  if (!rec || !rec.codes) return res.status(400).json({ error: '这个作品还没有兑换码' });
  const avail = rec.codes.filter(c => c.status === 'available');
  if (!avail.length) return res.status(400).json({ error: '兑换码已被领完，等作者补充吧' });
  // 随机发一个，防排序猜测
  const pick = avail[Math.floor(Math.random() * avail.length)];
  pick.status = 'taken';
  pick.takenAt = new Date().toISOString();
  pick.takenBy = key;
  rec.claimed[key] = pick.code;
  saveCodesSoon();
  res.json({ ok: true, code: pick.code, left: avail.length - 1 });
});

// 站点公开统计：页脚展示今日/累计 PV·UV（只出聚合数字，无明细）
app.get('/api/site-stats', (req, res) => {
  res.json(visitStats());
});

app.get('/api/works/:id', (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  // 预告 / 平台上架审核中的作品也允许打开详情（只是 CTA 和链接行为不同），
  // 站内待审（pending）与被下架（rejected）仍然只有管理员能看
  if (!w || (!isPublished(w) && !isAdmin(req))) return res.status(404).json({ error: '作品不存在或未通过审核' });
  const user = currentUser(req);
  // 作者自主下架的作品：只有作者本人和管理员能打开详情，其他人一律 404
  const isOwner = !!(user && w.userId && user.id === w.userId);
  if (w.hidden && !isAdmin(req) && !isOwner) return res.status(404).json({ error: '作品不存在或未通过审核' });
  // 闭源/未标注的作品同样对外可访问（2026-11-04 起可见性不再按开源卡，开源只是徽章+筛选）
  // 这里只取数据、不再计浏览：浏览改由 POST /api/track 那条带过滤的门统一 +1，
  // 否则接口多调一次（预取、重试、脚本）就等于多一个人打开。
  // 详情才渲染简介 HTML（列表页不带，省流量）；渲染器只输出白名单标签，用户 HTML 全部转义
  res.json({ ...publicWork(w, user), introHtml: md.render(w.prompt || '') });
});

// ---------- AI 初审闸门（智谱 glm-4-flash，免费模型） ----------
// 需要审核的投稿先过 AI：pass=true 直接上线；pass=false 保持 pending 转人工，AI 意见存档给管理员参考；
// AI 调用失败/超时也转人工，宁可慢一点也不能放跑违规内容。
const AI_REVIEW_TIMEOUT = 15000;
// ---------- 微信内容安全（msgSecCheck，个人主体也可调用） ----------
// UGC 提审硬要求：用户发布的内容必须先过机器审核。这里接的是微信官方接口，
// 与 aiReviewGate（智谱）双保险：微信接口判定违规直接拒；接口异常时降级继续走 AI。
// access_token 复用上面的 wechatAccessToken()（带缓存与 WECHAT_MOCK 分支），不要在这里重复定义。
async function wechatMsgCheck(text, openid) {
  let token = '';
  try { token = await wechatAccessToken(); } catch (e) { /* 拿不到 token 就跳过官方检测 */ }
  if (!token || token === 'mock_token') return { pass: null, note: '未配置微信凭据或拿不到 access_token，跳过官方检测' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // v2 判定更准，但强制要求「2 小时内访问过小程序的用户 openid」——PC 端账号/GitHub 登录用户没有，
    // 带空 openid 调 v2 会直接 40003 等于没查。所以：有 openid 走 v2，没有走 v1（只查文本，识别稍弱，
    // 但 87014 硬违规照样拦，AI 审继续兜底）
    const v2 = !!openid;
    const body = v2
      ? { version: 2, scene: 1, openid, content: String(text).slice(0, 2500) }
      : { content: String(text).slice(0, 2500) };
    const r = await fetch('https://api.weixin.qq.com/wxa/msg_sec_check?access_token=' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(body)
    });
    const d = await r.json();
    // 87014 = 内容含违法违规信息（官方强信号，v1/v2 通用）
    if (d.errcode === 87014) return { pass: false, note: '微信内容安全判定违规', at: new Date().toISOString() };
    if (d.errcode !== 0) return { pass: null, note: 'msgSecCheck errcode ' + d.errcode + '，继续 AI 审核', at: new Date().toISOString() };
    const suggest = d.result && d.result.suggest;
    // v1 通过时不带 suggest 字段，errcode 0 即视为通过；risky 直接拒；review（拿不准）转人工/AI 兜底
    if (!v2) return { pass: true, note: 'v1 检测通过', at: new Date().toISOString() };
    return {
      pass: suggest === 'risky' ? false : (suggest === 'pass' ? true : null),
      note: suggest === 'review' ? '微信建议人工复核，继续 AI 审核' : '',
      at: new Date().toISOString()
    };
  } catch {
    return { pass: null, note: 'msgSecCheck 调用失败，继续 AI 审核', at: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

async function aiReviewGate(text) {
  const at = new Date().toISOString();
  if (!ZHIPU_API_KEY) return { pass: null, note: '未配置智谱 key，转人工审核', at };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_REVIEW_TIMEOUT);
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ZHIPU_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: ZHIPU_MODEL,
        temperature: 0.1,
        max_tokens: 200,
        messages: [
          { role: 'system', content: '你是网站 UGC 内容审核员。判断投稿内容是否包含：违法违规、色情低俗、赌博诈骗、政治敏感、恐暴血腥、人身攻击、垃圾广告或诱导引流。宽松把关：拿不准的算通过（后面还有人工终审）。只输出一个 JSON 对象，格式：{"pass": true 或 false, "reason": "不通过时简述原因，通过时给空字符串"}，不要输出任何其他内容。' },
          { role: 'user', content: String(text).slice(0, 3500) }
        ]
      })
    });
    // 智谱对明显违规内容会直接触发内容安全过滤（HTTP 400 + 错误码 1301）：
    // 这是强信号，直接判「审核不通过」；其余接口错误才转人工
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch { /* 忽略解析失败 */ }
      if (body.contentFilter || (body.error && body.error.code === '1301'))
        return { pass: false, reason: '命中智谱内容安全过滤（疑似违规）', at };
      return { pass: null, note: 'AI 审核接口异常 ' + r.status + '，转人工审核', at };
    }
    const data = await r.json();
    const content = (((data.choices || [])[0] || {}).message || {}).content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return { pass: null, note: 'AI 审核返回格式异常，转人工审核', at };
    const parsed = JSON.parse(m[0]);
    return { pass: parsed.pass === true, reason: String(parsed.reason || '').slice(0, 200), at };
  } catch (e) {
    return { pass: null, note: 'AI 审核调用失败（' + (e && e.name === 'AbortError' ? '超时' : '网络异常') + '），转人工审核', at };
  } finally {
    clearTimeout(timer);
  }
}

// ================= 粘贴介绍，自动填表（智谱结构化抽取 + 规则兜底） =================
// 用户贴一段产品介绍 → 产出「表单候选值」。只回填，不建作品、不自动提交，本人检查后再点提交。
// 前端永远不碰智谱 key，统一走 /api/work/parse；没配 key / 超时 / 限流 / 格式异常时降级到规则抽取，按钮不会失灵。
const PARSE_TEXT_MIN = 8;
const PARSE_TEXT_MAX = 3000;
const PARSE_TIMEOUT = 15000;
const PARSE_CACHE_TTL = 10 * 60 * 1000;   // 同一段文本 10 分钟内复用，省免费档额度
const PARSE_CACHE_MAX = 300;
const parseCache = new Map();

// 形态同义词：只对内置形态给词表，后台自定义形态按自身名字命中。
// 命中后仍要过 WORK_TYPES 白名单，保证后台删掉的形态不会被重新塞回表单。
const PARSE_TYPE_WORDS = {
  Web: ['网站', '网页', 'web', '官网', 'h5', 'saas', '在线工具'],
  iOS: ['ios', 'iphone', 'ipad', 'app store', '苹果端'],
  Android: ['android', '安卓', 'apk', '谷歌商店'],
  macOS: ['macos', 'mac 版', 'mac 应用', 'mac 客户端'],
  Windows: ['windows', 'win 版', 'win 客户端', 'exe', 'pc 客户端'],
  Linux: ['linux', 'appimage', 'deb 包'],
  '小程序': ['小程序', '微信小程序', '支付宝小程序', '小程序码'],
  '浏览器插件': ['浏览器插件', 'chrome 扩展', 'edge 扩展', '油猴', '扩展程序'],
  '机器人': ['机器人', 'bot', 'qq 机器人', '群机器人'],
  API: ['api', '开放接口', '接口服务']
};
// 分类提示词：规则兜底时打分取第一名；自定义分类按名字直接匹配。
const PARSE_CAT_WORDS = {
  '效率工具': ['效率', '待办', '笔记', '日程', '自动化', '剪贴板', '文件管理', '时间管理', '整理'],
  '生活助手': ['生活', '天气', '菜谱', '健康', '运动', '出行', '快递', '购物', '记账'],
  '内容创作': ['写作', '文案', '图片', '视频', '剪辑', '生成', '创作', '排版', '设计', '配图'],
  '学习教育': ['学习', '教育', '背单词', '课程', '题库', '学生', '考试', '知识', '记忆'],
  '娱乐游戏': ['游戏', '娱乐', '小说', '音乐', '影音', '解谜', '搞笑'],
  '开发工具': ['开发者', '代码', 'api', 'sdk', '调试', '部署', '开源', 'github', '命令行', '插件'],
  '个人站': ['个人站', '博客', '主页', '个人网站', '作品集']
};
function parseNorm(s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
function parseClean(s, max) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')                                   // 简介会走 Markdown 渲染，先剥掉 HTML 标签
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // 控制字符
    .replace(/[<>]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, max);
}
function missingFields(o) {
  const miss = [];
  if (!o.name) miss.push('作品名称');
  if (!o.summary) miss.push('作品介绍');
  if (!o.categories.length) miss.push('应用分类');
  if (!o.types.length) miss.push('作品形态');
  return miss;
}
// 规则兜底：只认强特征，拿不准的一律留空。简介只能「截取」不能「提炼」，返回后提示用户自己改写。
function ruleParseWork(text) {
  const low = text.toLowerCase();
  const hit = w => low.includes(String(w).toLowerCase());
  const types = WORK_TYPES.filter(t => (PARSE_TYPE_WORDS[t] || []).some(hit) || hit(t));
  let best = '', bestScore = 0;
  orderedCategories().forEach(c => {
    const score = (PARSE_CAT_WORDS[c] || []).reduce((n, w) => n + (hit(w) ? 1 : 0), 0) + (hit(c) ? 2 : 0);
    if (score > bestScore) { bestScore = score; best = c; }
  });
  // 名称只认显式标记，宁可留空也不编一个像真的名字
  const m = text.match(/^[\s>*#-]*[《【"“'「]([^》】"”'」]{2,40})[》】"”'」]/)
    || text.match(/(?:作品|产品|项目|工具|应用|网站|小程序|app)\s*(?:名(?:字|称)?|叫)\s*[:：]?\s*([^\s，,。；;：:！!？?]{2,40})/i)
    || text.match(/^([^\s，,。；;：:！!？?]{2,30}?)\s*(?:是|是一款|是一个|做了个|做了一个|打造了)/);
  return {
    name: m ? parseClean(m[1], 100) : '',
    summary: parseClean(text, 300),
    categories: best ? [best] : [],
    types
  };
}
async function aiParseWork(text) {
  if (!ZHIPU_API_KEY) return { ok: false, reason: '未配置智谱 key' };
  const sys = [
    '你是作品投稿表单的信息抽取器。从用户给的一段产品介绍里抽取字段，只输出一个 JSON 对象，不要输出解释或 Markdown 代码块。',
    '字段：{"name": string, "summary": string, "categories": string[], "types": string[]}',
    '规则：',
    '1. name 必须是原文里明确出现过的作品名。原文没写名字就返回空字符串 ""，绝对不要编造或推测名字。',
    '2. summary 只依据原文提炼成 1-3 句通顺简介，不超过 200 字；不得添加原文没有的功能、平台、数据或宣传语。纯文本，不要用 Markdown 标题和列表。',
    '3. categories 只能从下面的分类清单里选，最多 3 个，最贴切的放第一个；都不贴切就返回空数组。',
    '4. types 只能从下面的形态清单里选，确实同时上多个平台时才多选；判断不了就返回空数组。',
    '5. 清单外的值一律不许出现，也不要输出同义词或自造名称。',
    '可选分类：' + orderedCategories().join('、'),
    '可选形态：' + WORK_TYPES.join('、')
  ].join('\n');
  const base = {
    model: ZHIPU_MODEL, temperature: 0.1, max_tokens: 500,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: '待解析的产品介绍：\n' + text }]
  };
  // 第一次带 json_object（格式更稳）；接口不认这个字段导致 400 时去掉它重试一次，兼容旧版本
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PARSE_TIMEOUT);
    try {
      const body = attempt === 0 ? { ...base, response_format: { type: 'json_object' } } : base;
      const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ZHIPU_API_KEY },
        signal: ctrl.signal,
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        let err = {};
        try { err = await r.json(); } catch { /* 非 JSON 错误体，忽略 */ }
        if (err.contentFilter || (err.error && err.error.code === '1301')) return { ok: false, blocked: true };
        if (attempt === 0 && r.status === 400) continue;
        return { ok: false, reason: 'AI 接口异常 ' + r.status };
      }
      const data = await r.json();
      const content = (((data.choices || [])[0] || {}).message || {}).content || '';
      const m = String(content).match(/\{[\s\S]*\}/);
      if (!m) return { ok: false, reason: 'AI 返回格式异常' };
      return { ok: true, raw: JSON.parse(m[0]) };
    } catch {
      if (attempt === 1) return { ok: false, reason: 'AI 调用失败' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'AI 暂不可用' };
}
// AI 输出只是候选：枚举白名单、长度、名称幻觉都在这里兜住，不让模型的值直接进表单。
function sanitizeParsed(raw, text) {
  const catList = orderedCategories();
  let name = parseClean(raw && raw.name, 100);
  if (name && !parseNorm(text).includes(parseNorm(name))) name = '';  // 原文没出现过的名字 = 编的，丢弃
  const arr = v => Array.isArray(v) ? v.map(x => String(x || '').trim()) : [];
  const categories = [], types = [];
  arr(raw && raw.categories).forEach(c => { if (catList.includes(c) && !categories.includes(c)) categories.push(c); });
  arr(raw && raw.types).forEach(t => { if (WORK_TYPES.includes(t) && !types.includes(t)) types.push(t); });
  // 模型给的全是清单外的值被过滤光时，用规则结果补位
  const rules = ruleParseWork(text);
  if (!categories.length) categories.push(...rules.categories);
  if (!types.length) types.push(...rules.types);
  const out = {
    name, summary: parseClean(raw && raw.summary, 500),
    categories: categories.slice(0, 3), types: types.slice(0, 6)
  };
  out.missing = missingFields(out);
  return out;
}
// 文本 → 表单候选值：AI 优先，失败降级规则。/api/work/parse 与 /api/work/parse-url 共用这一条链路。
async function extractFromText(text) {
  const ai = await aiParseWork(text);
  if (ai.blocked) return { blocked: true };
  if (ai.ok) return { out: { ...sanitizeParsed(ai.raw, text), source: 'ai', degraded: false, reason: '' } };
  const r = ruleParseWork(text);
  return { out: { ...r, missing: missingFields(r), source: 'rules', degraded: true, reason: ai.reason || 'AI 暂不可用' } };
}
app.post('/api/work/parse', async (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\r\n?/g, '\n').trim();
  if (text.length < PARSE_TEXT_MIN) return res.status(400).json({ error: `至少写 ${PARSE_TEXT_MIN} 个字再识别` });
  if (text.length > PARSE_TEXT_MAX) return res.status(400).json({ error: `介绍最多 ${PARSE_TEXT_MAX} 字` });
  const ip = clientIp(req);
  if (!rateLimit('wparse:' + ip, 5, 60000)) return res.status(429).json({ error: '识别太频繁了，等一分钟再试' });
  if (!rateLimit('wparse-h:' + ip, 40, 3600e3)) return res.status(429).json({ error: '一小时内识别次数用完了，请手动填写' });
  // 免费档整站共享配额，再加一道全局闸门，避免多人同时点把额度打满
  if (!rateLimit('wparse-all', 4, 60000)) return res.status(429).json({ error: '识别有点忙，稍等一分钟再试' });
  if (hitSensitive(text)) return res.status(400).json({ error: '内容里有不适宜的词，改一下再试' });

  const key = crypto.createHash('sha256').update(text + '|' + orderedCategories().join() + '|' + WORK_TYPES.join()).digest('hex');
  const cached = parseCache.get(key);
  if (cached && Date.now() - cached.at < PARSE_CACHE_TTL) return res.json({ ...cached.data, cached: true });

  const parsed = await extractFromText(text);
  if (parsed.blocked) return res.status(400).json({ error: '这段内容不适宜自动识别，请手动填写' });
  const out = parsed.out;
  parseCache.set(key, { at: Date.now(), data: out });
  if (parseCache.size > PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
  res.json(out);
});

// ================= 从网址解析（1 分钟极速填写） =================
// 用户给一个作品网址 → 服务端读页面元信息 → 复用上面的抽取链路 → 回填整张表单（含网站地址、可选封面）。
// 抓取任意 URL 是典型 SSRF 入口，这里按零信任处理：
//   1. 只允许 http/https + 80/443，禁账号密码；
//   2. DNS 解析出的 A 记录必须全是公网 IPv4，任意一个落在内网 / 保留段就整单拒绝（含 169.254.169.254 云元数据）；
//   3. 请求用自定义 lookup 固定到已校验的 IP，防 DNS rebinding（校验完二次解析换内网），TLS SNI / 证书仍按原域名校验；
//   4. 重定向逐跳重新校验，最多 4 跳；
//   5. 8s 超时、体积截断、只收 HTML / 校验过 magic bytes 的图片，不落盘、不缓存网页全文。
const urlHttp = require('http');
const urlHttps = require('https');
const urlDns = require('dns').promises;
const urlZlib = require('zlib');
const URLFETCH_TIMEOUT = 8000;
const URLFETCH_MAX_BYTES = 512 * 1024;
const URLCOVER_MAX_BYTES = 600 * 1024;
const URL_CACHE_TTL = 10 * 60 * 1000;
const urlCache = new Map();

function isPublicIpv4(ip) {
  const m = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some(n => n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;        // 0/8、10/8、回环、组播及保留
  if (a === 169 && b === 254) return false;                                // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;                      // CGNAT
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  return true;
}
function normalizeFetchUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('请填写作品网址');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s))
    throw new Error('只支持 http / https 网址');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let u;
  try { u = new URL(s); } catch { throw new Error('网址格式不对，检查是不是多打了字符'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 网址');
  if (u.username || u.password) throw new Error('网址里不能带账号密码');
  if (!u.hostname || u.hostname.length > 253) throw new Error('网址格式不对');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')))
    throw new Error('只支持常规 80 / 443 端口的公开网址');
  u.hash = '';
  if (!u.pathname) u.pathname = '/';
  return u;
}
async function resolvePublicIp(host) {
  let addrs;
  try { addrs = await urlDns.lookup(host, { all: true }); }
  catch { throw new Error('域名解析失败，确认这个网址能正常打开'); }
  const v4 = (addrs || []).filter(a => a && a.family === 4);
  if (!v4.length) throw new Error('这个站点只有 IPv6 地址，暂时读不了，请改用「粘贴介绍」');
  if (v4.some(a => !isPublicIpv4(a.address))) throw new Error('这个地址不是公开网站，不能读取');
  return v4[0];
}
function rawFetch(u, ip, opts) {
  const maxBytes = opts.maxBytes || URLFETCH_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? urlHttps : urlHttp;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      // Node 22 的 autoSelectFamily 会用 all:true 调 lookup，这时回调必须给数组，
      // 否则内部取 [0].address 得到 undefined，报 "Invalid IP address: undefined"。
      lookup: (host, o, cb) => o && o.all
        ? cb(null, [{ address: ip.address, family: ip.family }])
        : cb(null, ip.address, ip.family),  // 固定 IP，SNI / 证书仍按 hostname
      headers: {
        'User-Agent': 'ZaomengShowcaseBot/1.0 (+https://idea.v5pc.com)',
        'Accept': opts.binary ? 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8'
          : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: URLFETCH_TIMEOUT
    }, res => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc) {
        res.resume();
        try { return resolve({ redirect: new URL(loc, u.href).href }); }
        catch { return reject(new Error('跳转地址不合法')); }
      }
      if (status !== 200) { res.resume(); return reject(new Error('网站返回 ' + status + '，可能需要登录或不允许访问')); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      try {
        if (enc === 'gzip') stream = res.pipe(urlZlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(urlZlib.createInflate());
        else if (enc === 'br') stream = res.pipe(urlZlib.createBrotliDecompress());
      } catch { stream = res; }
      const chunks = [];
      let size = 0, settled = false;
      const finish = err => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve({ body: Buffer.concat(chunks), headers: res.headers, url: u.href });
      };
      stream.on('data', c => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          chunks.push(c.subarray(0, Math.max(0, c.length - (size - maxBytes))));
          res.destroy();
          finish();
        } else chunks.push(c);
      });
      stream.on('end', () => finish());
      stream.on('error', e => finish(e));
    });
    req.on('timeout', () => req.destroy(new Error('网站响应超时，换个网址或手动填')));
    req.on('error', e => reject(e instanceof Error ? e : new Error('读取网站失败')));
    req.end();
  });
}
async function safeFetch(startUrl, opts = {}) {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = normalizeFetchUrl(url);
    const ip = await resolvePublicIp(u.hostname);
    const r = await rawFetch(u, ip, opts);
    if (!r.redirect) return r;
    url = r.redirect;                     // 下一跳重新做完整的 URL + DNS + IP 校验
  }
  throw new Error('跳转次数太多，换一个直达网址试试');
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);?/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").trim();
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}
function pageMeta(html) {
  const map = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const k = (tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)
      || tag.match(/\b(?:name|property)\s*=\s*([^\s>]+)/i) || [])[1];
    const v = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)
      || tag.match(/\bcontent\s*=\s*([^\s>]+)/i) || [])[1];
    if (k && v) map[String(k).toLowerCase()] = decodeEntities(v);
  }
  return map;
}
function decodeBody(buf, headers) {
  let enc = (String(headers['content-type'] || '').match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || '';
  if (!enc) enc = (buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1] || '';
  enc = String(enc).toLowerCase();
  try {
    if (enc === 'gb2312' || enc === 'gbk') return new TextDecoder('gbk').decode(buf);
    if (enc === 'gb18030' || enc === 'big5') return new TextDecoder(enc).decode(buf);
  } catch { /* 退回 UTF-8 */ }
  return new TextDecoder('utf-8').decode(buf);
}
function pageInfo(html, finalUrl) {
  const meta = pageMeta(html.slice(0, 200000));
  const title = stripTags((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const h1 = stripTags((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const desc = meta.description || meta['og:description'] || meta['twitter:description'] || '';
  const siteName = meta['og:site_name'] || meta['application-name'] || '';
  const ogTitle = meta['og:title'] || '';
  let ogImage = meta['og:image'] || meta['twitter:image'] || '';
  if (ogImage) { try { ogImage = new URL(ogImage, finalUrl).href; } catch { ogImage = ''; } }
  const body = stripTags(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' '));
  return { title, h1, desc, siteName, ogTitle, ogImage, body };
}
// 站点自己的名字比模型猜的可靠，但同样要过「原文出现过」的校验才用
function nameFromTitle(title, siteName, ogTitle) {
  return decodeEntities(String(siteName || ogTitle || title || ''))
    .split(/\s+[|｜]\s*|\s+[-–—·]\s+|\s*[|｜]\s*|\s+_\s+/)[0]
    .replace(/(官方网站|官网|首页|欢迎访问|Home)$/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, 100);
}
// og:image 只在内存里转成 dataURL 交给当前用户，不落盘、不入库、不产生垃圾文件
async function fetchCover(imageUrl) {
  if (!imageUrl) return null;
  try {
    const r = await safeFetch(imageUrl, { maxBytes: URLCOVER_MAX_BYTES, binary: true });
    const b = r.body;
    let mime = '';
    if (b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) mime = 'image/png';
    else if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) mime = 'image/jpeg';
    else if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
    else if (b.length > 3 && b.subarray(0, 3).toString() === 'GIF') mime = 'image/gif';
    if (!mime) return null;   // magic bytes 校验，HTML / SVG 伪装一律不收
    return { dataUrl: 'data:' + mime + ';base64,' + b.toString('base64'), mime };
  } catch { return null; }
}
app.post('/api/work/parse-url', async (req, res) => {
  let url;
  try { url = normalizeFetchUrl((req.body && req.body.url) || '').href; }
  catch (e) { return res.status(400).json({ error: e.message || '网址不对' }); }
  const ip = clientIp(req);
  if (!rateLimit('wurl:' + ip, 3, 60000)) return res.status(429).json({ error: '读取太频繁了，等一分钟再试' });
  if (!rateLimit('wurl-h:' + ip, 20, 3600e3)) return res.status(429).json({ error: '一小时内读取次数用完了，请手动填写' });
  if (!rateLimit('wurl-all', 3, 60000)) return res.status(429).json({ error: '解析有点忙，稍等一分钟再试' });

  const key = crypto.createHash('sha256').update(url).digest('hex');
  const cached = urlCache.get(key);
  if (cached && Date.now() - cached.at < URL_CACHE_TTL) return res.json({ ...cached.data, cached: true });

  let page;
  try { page = await safeFetch(url); }
  catch (e) { return res.status(400).json({ error: e.message || '读取网站失败' }); }
  const ct = String(page.headers['content-type'] || '').toLowerCase();
  if (ct && !/text\/html|application\/xhtml\+xml/.test(ct))
    return res.status(400).json({ error: '这个地址返回的不是网页，换作品首页试试' });
  const info = pageInfo(decodeBody(page.body, page.headers), page.url);
  if (hitSensitive(info.title + ' ' + info.desc))
    return res.status(400).json({ error: '这个网站的内容不适宜自动识别，请手动填写' });
  const text = [
    '网站地址：' + page.url,
    info.title && '网页标题：' + info.title,
    info.siteName && '站点名称：' + info.siteName,
    info.ogTitle && '页面主标题：' + info.ogTitle,
    info.h1 && '页面大标题：' + info.h1,
    info.desc && '页面描述：' + info.desc,
    info.body && '页面正文摘录：' + info.body.slice(0, 900)
  ].filter(Boolean).join('\n').slice(0, PARSE_TEXT_MAX);
  if (text.replace(/\s/g, '').length < 12)
    return res.status(400).json({ error: '这个网页没读到可用文字，请改用「粘贴介绍」' });

  const parsed = await extractFromText(text);
  if (parsed.blocked) return res.status(400).json({ error: '这个网站的内容不适宜自动识别，请手动填写' });
  const out = parsed.out;
  if (!out.name) {
    const hint = nameFromTitle(info.title, info.siteName, info.ogTitle);
    if (hint.length >= 2 && parseNorm(text).includes(parseNorm(hint))) out.name = hint;
  }
  if (!out.summary) out.summary = parseClean(info.desc || info.ogTitle || info.title, 500);
  // 站点文案常列举「收录网站 / 小程序 / 机器人」「涵盖效率 / 教育 / 娱乐」，模型很容易把这些
  // 当成这个作品自己的属性照抄。与其靠 prompt 约束免费小模型，不如在服务端确定性收敛：
  // 用户给的是网页地址 → 形态就是 Web；分类只留最贴切的一个，其余让用户补勾。
  out.types = ['Web'];
  out.categories = out.categories.slice(0, 1);
  out.missing = missingFields(out);
  const thin = !info.desc && info.body.length < 80;
  const data = {
    ...out,
    site: { url: page.url, title: info.title, description: info.desc, siteName: info.siteName, ogImage: info.ogImage },
    cover: await fetchCover(info.ogImage),
    notice: thin
      ? '这个网页像是前端渲染的，只读到标题，简介和分类可能不准，请重点核对'
      : '形态按网页填了 Web、分类只留最贴切的一个，其他平台或分类请手动补选'
  };
  urlCache.set(key, { at: Date.now(), data });
  if (urlCache.size > 60) urlCache.delete(urlCache.keys().next().value);
  res.json(data);
});

// ================= 草稿箱 =================
// 只给登录用户：草稿要跨设备续填才有意义，匿名没有身份可以挂。
// 匿名投稿仍走浏览器本地草稿（前端 localStorage），不在这里。
function draftOf(user, id) {
  const key = String(id || '');
  if (!user || !key) return null;
  return drafts.find(d => d.id === key && d.userId === user.id) || null;
}
function myDrafts(user) { return drafts.filter(d => d.userId === user.id); }
function newDraftId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function draftSummary(d) {
  return {
    id: d.id,
    title: d.title || '',
    cover: d.thumb || d.image || '',
    imageCount: (d.images || []).length,
    types: d.types || [],
    cat: (d.categories && d.categories[0]) || '',
    updatedAt: d.updatedAt
  };
}
function draftFiles(d) {
  return [d.image, d.thumb, d.qrcode].concat(Array.isArray(d.images) ? d.images : []).filter(Boolean);
}
// 过期清理：30 天没动过的草稿连同图片一起删（只留最近 200 份的堆，防长期堆积）
function pruneDrafts() {
  const cut = Date.now() - DRAFT_TTL_DAYS * 86400000;
  let removed = 0;
  drafts = drafts.filter(d => {
    const t = new Date(d.updatedAt || d.createdAt || 0).getTime();
    if (t && t < cut) { draftFiles(d).forEach(removeUpload); removed++; return false; }
    return true;
  });
  if (removed) { saveDrafts(); console.log('[drafts] 清理过期草稿', removed, '份'); }
}

// 我的草稿列表（列表只要摘要，正文点开单条再取，省流量）
app.get('/api/drafts', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ items: [], max: DRAFT_MAX_PER_USER, login: false });
  const items = myDrafts(user)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .map(draftSummary);
  res.json({ items, max: DRAFT_MAX_PER_USER });
});

// 单份草稿的完整内容（续填用）
app.get('/api/drafts/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const d = draftOf(user, req.params.id);
  if (!d) return res.status(404).json({ error: '草稿不存在或已删除' });
  res.json({ draft: d });
});

// 保存草稿：带 draftId 就是更新，不带就新建（新建受 3 份上限约束）。
// 草稿不做内容校验（可以只填一半、可以没封面），只在长度上截断防脏数据。
app.post('/api/drafts', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const b = req.body || {};
    let d = draftOf(user, b.draftId);
    if (!d) {
      if (myDrafts(user).length >= DRAFT_MAX_PER_USER) {
        return res.status(409).json({
          error: `草稿最多存 ${DRAFT_MAX_PER_USER} 份，先删掉一份再存新的`,
          code: 'draft-full', max: DRAFT_MAX_PER_USER
        });
      }
      d = {
        id: newDraftId(), userId: user.id,
        image: '', thumb: '', qrcode: '', images: [],
        createdAt: new Date().toISOString()
      };
      drafts.push(d);
    }
    if (b.title !== undefined) d.title = String(b.title).slice(0, 100);
    if (b.prompt !== undefined) d.prompt = String(b.prompt).slice(0, 3000);
    if (b.site !== undefined) d.site = normSite(b.site);
    if (b.repo !== undefined) d.repo = normRepo(b.repo);
    if (b.openSource !== undefined) d.openSource = parseOpenSource(b.openSource);
    if (b.paid !== undefined) d.paid = parsePaid(b.paid);
    if (b.paidModel !== undefined) d.paidModel = parsePaidModel(b.paidModel);
    if (b.types !== undefined) d.types = normalizeTypes(b.types);
    if (b.categories !== undefined) d.categories = parseCats(b.categories);
    if (b.links !== undefined) {
      const m = normLinksMap(b.links, d.types || normalizeTypes(b.types));
      if (m) d.links = m; else delete d.links;
      d.link = (m && (m.Web || Object.values(m)[0])) || '';
    }
    if (b.link !== undefined && b.links === undefined) {
      let lv = String(b.link).trim();
      if (lv && !/^https?:\/\//i.test(lv)) lv = 'https://' + lv;
      d.link = lv.slice(0, 500);
    }
    if (b.stage !== undefined) d.stage = STAGES.includes(b.stage) ? b.stage : 'live';
    if (b.progress !== undefined) d.progress = clampProgress(b.progress);
    if (b.eta !== undefined) d.eta = normEta(b.eta);

    // 图片走和编辑作品同一套合并规则：保留已有 + 删掉指定的 + 追加新图，再按 imageOrder 排序
    applyImageChanges(d, req);
    d.updatedAt = new Date().toISOString();
    saveDrafts();
    res.json({
      draft: draftSummary(d),
      // 回传图片最终状态：前端拿它把本地待上传的 File 换成服务端 URL，避免下次保存重复上传
      image: d.image || '', thumb: d.thumb || '', qrcode: d.qrcode || '',
      images: Array.isArray(d.images) ? d.images : []
    });
  });
});

// 删除草稿（含图片文件）
app.delete('/api/drafts/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const i = drafts.findIndex(d => d.id === req.params.id && d.userId === user.id);
  if (i === -1) return res.status(404).json({ error: '草稿不存在或已删除' });
  draftFiles(drafts[i]).forEach(removeUpload);
  drafts.splice(i, 1);
  saveDrafts();
  res.json({ ok: true });
});

// 发布作品：登录用户免审直接上线；未登录（匿名）投稿先进入待审核
app.post('/api/works', (req, res) => {
  const user = currentUser(req);
  const budget = user ? POST_LIMIT : Math.min(3, POST_LIMIT); // 匿名额度更紧，防刷
  if (!rateLimit('post:' + clientIp(req), budget, 3600000)) {
    return res.status(429).json({
      error: user ? '发布过于频繁，请稍后再试' : '匿名投稿次数已达上限，注册后可继续发布且免审核'
    });
  }
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const { title, prompt, category, link, type } = req.body;
    // 作者自报的进度阶段：不传按 live（老客户端行为不变）
    const stage = STAGES.includes(req.body.stage) ? req.body.stage : 'live';
    const types = normalizeTypes(req.body.types || type);
    const image = req.files && req.files.image && req.files.image[0];
    const thumb = req.files && req.files.thumb && req.files.thumb[0];
    const qrcode = req.files && req.files.qrcode && req.files.qrcode[0];
    // 草稿转正：图片可能早就存在草稿里了（填了一半先存了图），
    // 所以「这次没传新封面」不等于没有封面——草稿带了封面就继续用。
    const draft = draftOf(user, req.body.draftId);
    const draftQr = draft && draft.qrcode ? draft.qrcode : '';
    if (!image && !(draft && draft.image)) return res.status(400).json({ error: '请上传作品封面 / 截图' });
    if (!title) return res.status(400).json({ error: '标题为必填项' });

    // 匿名投稿允许自填署名，不填就是「匿名」
    const nickname = String(req.body.author || '').replace(/[<>\r\n]/g, '').trim().slice(0, 20);
    const authorName = user ? user.username : (nickname || '匿名');

    if (hitSensitive(title + authorName + (prompt || ''))) {
      return res.status(400).json({ error: '内容包含违规词，请修改后重试' });
    }

    let linkVal = String(link || '').trim();
    if (linkVal && !/^https?:\/\//i.test(linkVal)) linkVal = 'https://' + linkVal;

    // 按形态的多个链接（多平台应用：iOS/Android/macOS… 各填各的）
    const linksMap = normLinksMap(req.body.links, types);
    if (!linkVal && linksMap) linkVal = linksMap.Web || Object.values(linksMap)[0];

    // 形态必填校验：
    //   正在做（wip）还没链接/二维码，改成要一句进度说明 + 每人 2 张的配额；
    //   等平台审核（reviewing）链接是有的（只是现在打不开），照常校验，展示时锁住不给点。
    if (stage === 'wip') {
      if (String(prompt || '').trim().length < 8)
        return res.status(400).json({ error: '预告需要一句进度说明（至少 8 个字）：打算做成什么样、做到哪一步了' });
      if (user) {
        const myWip = works.filter(x => x.userId === user.id && stageOf(x) === 'wip' && x.status !== 'rejected').length;
        if (myWip >= WIP_MAX_PER_USER)
          return res.status(400).json({ error: `预告卡最多同时挂 ${WIP_MAX_PER_USER} 张，先把已有的更新进度或点「我上线了」` });
      }
    } else {
      const typeErr = validateTypeRequired(types, linkVal, qrcode ? qrcode.filename : draftQr);
      if (typeErr) return res.status(400).json({ error: typeErr });
    }

    const repoVal = normRepo(req.body.repo);
    if (parseOpenSource(req.body.openSource) === true && !repoVal)
      return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });
    if (repoVal && !repoHostAllowed(repoVal))
      return res.status(400).json({ error: repoRejectMsg() });

    const needReview = REVIEW_MODE || !user; // 注册用户免审，匿名需审核
    // 微信官方内容安全：登录用户免的是人工/AI 审，但这道机审不能免——
    // 作品标题/简介会公开展示并同步到小程序，违规内容必须在发布前拦下
    const wxCheck = await wechatMsgCheck([title, authorName, prompt].filter(Boolean).join('\n'), user && user.wechat && user.wechat.openid);
    if (wxCheck.pass === false) {
      return res.status(400).json({ error: '内容未通过平台内容安全检测，请修改后重试' });
    }
    // AI 初审：需要审核的投稿先问智谱（免费 glm-4-flash）——通过直接上线，不通过/不可用转人工
    let aiReview = null;
    if (needReview) {
      aiReview = await aiReviewGate([title, authorName, prompt, linkVal].filter(Boolean).join('\n'));
    }
    const status = !needReview || (aiReview && aiReview.pass === true) ? 'approved' : 'pending';
    // 草稿转正：以草稿里已有的图为底，叠上这次新传的（keepExisting / removedImages / imageOrder
    // 与编辑作品同一套协议，前端复用）。校验全过之后才动图片，草稿里的图不会因为一次失败的上传被删掉。
    const imgBase = draft
      ? { image: draft.image || '', thumb: draft.thumb || '', qrcode: draft.qrcode || '', images: (draft.images || []).slice() }
      : { image: '', thumb: '', qrcode: '', images: [] };
    applyImageChanges(imgBase, req);
    const work = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: String(title).slice(0, 100),
      author: authorName,
      userId: user ? user.id : null,
      anon: !user,
      prompt: String(prompt || '').slice(0, 3000),
      category: (cats => cats[0] || DEFAULT_CATEGORIES[0])(parseCats(req.body.categories)),
      categories: (cats => cats.length ? cats : [DEFAULT_CATEGORIES[0]])(parseCats(req.body.categories)),
      type: types[0],
      types: types,
      link: (linkVal && !onlyMini(types)) ? linkVal.slice(0, 500) : '',
      site: normSite(req.body.site),
      image: imgBase.image,
      thumb: imgBase.thumb || imgBase.image,
      qrcode: imgBase.qrcode,
      images: imgBase.images.slice(0, 9),
      status: status,
      stage: stage,
      progress: stage === 'wip' ? clampProgress(req.body.progress) : null,
      eta: stage === 'wip' ? normEta(req.body.eta) : '',
      progressLog: stage === 'wip' ? [{
        at: new Date().toISOString(),
        text: String(prompt || '').slice(0, 200),
        progress: clampProgress(req.body.progress)
      }] : [],
      watchers: [],
      featured: false,
      pinned: false,
      openSource: parseOpenSource(req.body.openSource),
      repo: repoVal,
      paid: parsePaid(req.body.paid) || !!parsePaidModel(req.body.paidModel),
      paidModel: (parsePaid(req.body.paid) || !!parsePaidModel(req.body.paidModel)) ? parsePaidModel(req.body.paidModel) : '',
      reports: 0,
      likes: 0,
      views: 0,
      // 投稿时勾选《作品规范》与「本人创作/已获授权」的时间，留作「平台已尽提示义务」的凭据
      agreeAt: req.body.agreeRules === '1' ? new Date().toISOString() : '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (linksMap) work.links = linksMap;
    if (aiReview) work.aiReview = aiReview;        // AI 初审意见存档（管理端可见，人工终审参考）
    if (!user) work.lookupToken = randomToken();   // 匿名投稿：凭这个 token 回来看审核进度
    // 预告卡不发上传奖励 / 开源奖励：避免「先挂个预告把首件 200 盏灯火骗走」，上线时再补
    const uploadReward = stage === 'wip' ? null : planUploadReward(work, user);
    works.push(work);
    const osBonusNow = stage === 'wip' ? 0 : grantOpenSourceBonus(work);
    saveWorks();
    // 草稿转正完成：只删草稿记录，图片文件已经归作品了，一个都不能删
    if (draft) {
      drafts = drafts.filter(x => x.id !== draft.id);
      saveDrafts();
    }
    res.status(201).json({
      ...publicWork(work, user),
      status: work.status,
      stage: work.stage,
      needReview: status === 'pending',
      aiReview,
      anonymous: !user,
      statusUrl: work.lookupToken ? '/s/' + work.lookupToken : '',
      osBonus: osBonusNow,   // 只报本次实发，避免前端误弹「已到账」
      uploadReward: uploadReward ? uploadReward.amount : 0   // 计划发放的金额（延迟到账）
    });
  });
});

// ---------- 即将上线：预告卡（wip）与平台上架审核中（reviewing） ----------
// 这一栏和主信息流分开展示：主列表、榜单、精选、搜索都只收 isVisible（已上线）的作品，
// 所以预告不会拉低信息流质量，也不会被当成可体验的作品去投放推广。
app.get('/api/upcoming', (req, res) => {
  const user = currentUser(req);
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 8));
  const items = filterBlocked(works.filter(w => isComing(w)), user)
    .sort((a, b) => ((b.watchers || []).length - (a.watchers || []).length)
      || (new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)))
    .slice(0, limit)
    .map(w => publicWork(w, user));
  res.json({ items });
});

// 催更 / 预约：登录后点「上线提醒我」，作品上线时收到站内消息
app.post('/api/works/:id/watch', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('watch:' + user.id, 120, 60000)) return res.status(429).json({ error: '操作过于频繁' });
  const w = works.find(x => x.id === req.params.id);
  if (!w || !isPublished(w)) return res.status(404).json({ error: '作品不存在' });
  const on = !!(req.body && req.body.on);
  if (!Array.isArray(w.watchers)) w.watchers = [];
  const i = w.watchers.findIndex(x => x.userId === user.id);
  if (on && i === -1) w.watchers.push({ userId: user.id, at: new Date().toISOString() });
  else if (!on && i !== -1) w.watchers.splice(i, 1);
  saveWorks();
  res.json({ ok: true, watched: on, watchCount: w.watchers.length });
});

// 更新进度 / 切换阶段（只有作者本人）：
//   wip 里更新完成度、写一条进度日志；reviewing/wip 一键「我上线了」；已上线也能退回预告
app.post('/api/works/:id/stage', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId !== user.id) return res.status(403).json({ error: '只能改自己的作品' });

  const next = STAGES.includes(req.body && req.body.stage) ? req.body.stage : stageOf(w);
  // 上线前必须有能点的入口：不然「上线」了访客点开是空的，比预告还糟
  if (next === 'live') {
    const err = validateTypeRequired(typesOf(w), w.link, w.qrcode);
    if (err) return res.status(400).json({ error: '还不能上线：' + err });
  }
  if (next === 'wip' && stageOf(w) !== 'wip') {
    const myWip = works.filter(x => x.userId === user.id && stageOf(x) === 'wip' && x.status !== 'rejected').length;
    if (myWip >= WIP_MAX_PER_USER)
      return res.status(400).json({ error: `预告卡最多同时挂 ${WIP_MAX_PER_USER} 张` });
  }

  // 进度说明会公开展示（预告卡 / 进度日志）：AI 初审，明确违规直接拒
  const note = String((req.body && req.body.note) || '').trim();
  if (note) {
    const ai = await aiReviewGate('作品进度说明：' + note);
    if (ai.pass === false) {
      return res.status(400).json({ error: '进度说明疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，请修改后再更新' });
    }
  }

  const prev = setWorkStage(w, next, {
    progress: req.body ? req.body.progress : undefined,
    eta: req.body ? req.body.eta : undefined,
    note: note
  });

  saveWorks();
  res.json({ ok: true, prev, ...publicWork(w, user) });
});

// 编辑自己的作品
app.put('/api/works/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const w = works.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: '作品不存在' });
    if (w.userId !== user.id) return res.status(403).json({ error: '只能编辑自己的作品' });

    const { title, prompt, category, link, type } = req.body;
    // 形态必填校验：先按「改动后的预期状态」校验，通过后才动字段与文件
    const nextTypes = (req.body.types !== undefined || type) ? normalizeTypes(req.body.types || type) : typesOf(w);
    // 按形态的多个链接：请求里带了就更新，没带就沿用已有
    let linksMap;
    if (req.body.links !== undefined) {
      linksMap = normLinksMap(req.body.links, nextTypes);
      if (linksMap) w.links = linksMap; else delete w.links;
    } else {
      linksMap = w.links || null;
    }
    const nextLink = (link !== undefined ? String(link).trim() : '')
      || (linksMap && (linksMap.Web || Object.values(linksMap)[0]))
      || (req.body.links !== undefined ? '' : (w.link || '')); // 带 links 时不再兜底旧 w.link
    const nextQr = (req.files && req.files.qrcode && req.files.qrcode[0]) ? 'new'
      : (String(req.body.removeQrcode) === '1' ? '' : (w.qrcode || ''));
    const typeErr = validateTypeRequired(nextTypes, nextLink, nextQr);
    if (typeErr) return res.status(400).json({ error: typeErr });

    if (title) w.title = String(title).slice(0, 100);
    if (prompt !== undefined) w.prompt = String(prompt).slice(0, 3000);
    if (req.body.categories !== undefined) {
      const cats = parseCats(req.body.categories);
      if (cats.length) { w.categories = cats; w.category = cats[0]; }
    } else if (category && categories.includes(category)) {
      // 老客户端只传单值：更新主分类，其余分类保留
      w.category = category;
      if (Array.isArray(w.categories) && w.categories.length) w.categories = [category, ...w.categories.slice(1)];
    }
    if (req.body.types !== undefined || type) applyTypes(w, normalizeTypes(req.body.types || type));
    // links 字段接管后同步遗留单链接：全清空时一并清掉，否则回填/展示会"复活"
    if (req.body.links !== undefined) w.link = (linksMap && (linksMap.Web || Object.values(linksMap)[0])) || '';
    if (req.body.openSource !== undefined) w.openSource = parseOpenSource(req.body.openSource);
    const repoBefore = w.repo;
    if (req.body.repo !== undefined) w.repo = normRepo(req.body.repo);
    if (w.openSource === true && !w.repo) return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });
    // 只拦「这次改了仓库地址」的情况：历史上存下的非白名单链接仍可原样保存，不让人卡死
    if (w.repo && w.repo !== repoBefore && !repoHostAllowed(w.repo))
      return res.status(400).json({ error: repoRejectMsg() });
    if (req.body.paidModel !== undefined) w.paidModel = parsePaidModel(req.body.paidModel);
    if (req.body.paid !== undefined) w.paid = parsePaid(req.body.paid);
    else if (w.paidModel && !w.paid) w.paid = true; // 只传了收费形式且原为免费 → 视为标注付费
    if (!w.paid) w.paidModel = '';                  // 改回免费则清掉形式
    if (link !== undefined) {
      let lv = String(link).trim();
      if (lv && !/^https?:\/\//i.test(lv)) lv = 'https://' + lv;
      w.link = lv.slice(0, 500);
    }
    if (req.body.site !== undefined) w.site = normSite(req.body.site); // 官网：传了就更新（可清空）

    applyImageChanges(w, req);

    // 编辑页也带「作品当前状态」：改了就跟进（含「我上线了」的补奖励 + 通知催更）
    if (req.body.stage !== undefined) {
      const nextStage = STAGES.includes(req.body.stage) ? req.body.stage : stageOf(w);
      if (nextStage === 'live' && stageOf(w) !== 'live') {
        const sErr = validateTypeRequired(typesOf(w), w.link, w.qrcode);
        if (sErr) return res.status(400).json({ error: '还不能上线：' + sErr });
      }
      // 编辑页带的进度说明同样公开：AI 初审，明确违规直接拒
      const stageNote = String(req.body.stageNote || '').trim();
      if (stageNote) {
        const aiNote = await aiReviewGate('作品进度说明：' + stageNote);
        if (aiNote.pass === false) {
          return res.status(400).json({ error: '进度说明疑似违规' + (aiNote.reason ? '：' + aiNote.reason : '') + '，请修改后再保存' });
        }
      }
      setWorkStage(w, nextStage, {
        progress: req.body.progress, eta: req.body.eta, note: stageNote
      });
    }

    // 被下架的作品编辑后自动回到待审核，改好重新提交即可恢复；
    // 重新提交同样过一遍 AI 初审：通过直接恢复上线，不通过/不可用留给人工终审
    if (w.status === 'rejected') {
      const ai = await aiReviewGate([w.title, w.author, w.prompt, w.link].filter(Boolean).join('\n'));
      w.aiReview = ai;
      w.status = ai.pass === true ? 'approved' : 'pending';
      delete w.offlineReason;
    }

    const osWas = w.openSource;
    const osBonusNow = grantOpenSourceBonus(w);   // 编辑时改成开源也补送（一件作品只送一次）
    // 方案 A：作者自己把开源改回闭源，同样保留奖励、只通知
    if (osWas === true && w.openSource === false && w.userId) {
      addNotice(w.userId, {
        kind: 'system', title: '作品已改为闭源',
        text: `「${w.title}」已改为闭源。已发放的开源奖励灯火会保留，不会收回。`
      });
    }
    saveWorks();
    res.json({ ...publicWork(w, user), osBonus: osBonusNow, osDowngraded: osWas === true && w.openSource === false });
  });
});

// 删除自己的作品
app.delete('/api/works/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const idx = works.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '作品不存在' });
  if (works[idx].userId !== user.id) return res.status(403).json({ error: '只能删除自己的作品' });

  const [removed] = works.splice(idx, 1);
  saveWorks();
  comments = comments.filter(c => c.workId !== removed.id); // 清理该作品的评论
  saveComments();
  invalidateCommentCounts();
  [removed.image, removed.thumb, removed.qrcode].concat(removed.images || []).forEach(img => {
    if (!img) return;
    const p = path.join(UPLOAD_DIR, path.basename(img));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  res.json({ ok: true });
});

// 作者自主下架 / 重新上架：只改 hidden 标记，数据（浏览/点赞/灯火/推广）全部保留。
// 下架 = 不进首页/列表/榜单/精选/搜索/sitemap，别人打开详情一律 404；作者本人随时可重新上架。
app.post('/api/works/:id/visibility', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId !== user.id) return res.status(403).json({ error: '只能下架或上架自己的作品' });
  if (w.status === 'rejected') return res.status(400).json({ error: '作品已被管理员下架，请联系站长处理' });
  const next = !!req.body.hidden;
  if (w.hidden === next) return res.json({ ok: true, hidden: next }); // 重复请求直接返回现状
  w.hidden = next;
  w.updatedAt = new Date().toISOString();
  saveWorks();
  res.json({ ok: true, hidden: w.hidden, ...publicWork(w, user) });
});

// 点赞去重：登录按账号、匿名按 IP，同一身份对同一作品只计 1 次。
// 之前只靠前端 localStorage 防重复，脚本直接打接口能把点赞无限刷高；
// 点赞进入综合分（×5）后，这道闸必须立在后端。
let likeDedup = readJSON('like-dedup.json', {});
let likeDedupSaveTimer = null;
function scheduleLikeDedupSave() {
  if (likeDedupSaveTimer) return;
  likeDedupSaveTimer = setTimeout(() => {
    likeDedupSaveTimer = null;
    try { writeJSON('like-dedup.json', likeDedup); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// 点赞
app.post('/api/works/:id/like', (req, res) => {
  if (!rateLimit('like:' + clientIp(req), 60, 60000)) {
    return res.status(429).json({ error: '操作过于频繁' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  // 作者给自己作品点赞不计：和访问统计同一个口径，防自刷
  const user = currentUser(req);
  if (user && w.userId && w.userId === user.id) return res.json({ likes: w.likes });
  const vid = user ? 'u:' + user.id : 'ip:' + ipKeyOf(req);
  const seen = likeDedup[w.id] || (likeDedup[w.id] = {});
  if (!seen[vid]) {
    seen[vid] = 1;
    w.likes = (w.likes || 0) + 1;
    saveWorks();
    scheduleLikeDedupSave();
    res.json({ likes: w.likes });
  } else {
    // 重复点赞：不涨数，前端提示已赞过
    res.json({ likes: w.likes, deduped: true });
  }
});

// 收藏：需登录。每个账号的收藏列表存在 user.favs，作品上的 favs 是聚合计数
app.post('/api/works/:id/fav', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('fav:' + user.id, 120, 60000)) {
    return res.status(429).json({ error: '操作过于频繁' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  // 作者收藏自己的作品不计入公开收藏数：和访问/点赞同一个防自刷口径（否则自藏白加 8 分热度）
  const isAuthor = !!(w.userId && w.userId === user.id);
  if (!Array.isArray(user.favs)) user.favs = [];
  const on = !!(req.body && req.body.on);
  const i = user.favs.indexOf(w.id);
  const prevOn = i !== -1;
  if (on && i === -1) {
    user.favs.unshift(w.id);
    if (!isAuthor) w.favs = (w.favs || 0) + 1;
  } else if (!on && i !== -1) {
    user.favs.splice(i, 1);
    if (!isAuthor) w.favs = Math.max(0, (w.favs || 0) - 1);
  }
  if (on !== prevOn) logFav(w.id, user.id, on);
  saveUsers();
  saveWorks();
  res.json({ favs: w.favs || 0, faved: user.favs.includes(w.id) });
});

// 登录后把本机旧的匿名收藏并入账号（只补不删，重复的忽略）
app.post('/api/favs/merge', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('favmerge:' + user.id, 20, 60000)) {
    return res.status(429).json({ error: '操作过于频繁' });
  }
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 300) : [];
  if (!Array.isArray(user.favs)) user.favs = [];
  let added = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id || user.favs.includes(id)) continue;
    const w = works.find(x => x.id === id);
    if (!w || !isVisible(w)) continue;
    user.favs.unshift(id);
    w.favs = (w.favs || 0) + 1;
    logFav(id, user.id, true);
    added++;
  }
  if (added) { saveUsers(); saveWorks(); }
  res.json({ favs: user.favs, added });
});

// ================= 打赏（灯火转移，零和） =================
// 设计原则：打赏只做「灯火从 A 账户转到 B 账户」，平台不凭空产生灯火，
// 所以互刷在总量上没有收益 —— 这是防洗分的第一道闸。
// 其余闸门（全部落 IP 维度，IP 只存哈希）：
//   ① 必须登录；② 不能打赏自己的作品；
//   ③ 固定档位（1/2/5/10），没有自定义金额，杜绝奇怪的数值试探；
//   ④ 单人每天转出总额上限（防手滑 + 防小号集中转移）；
//   ⑤ 同一设备（IP）每天转出总额上限（一台机器上的一窝小号，一天能转走的灯火有限）；
//   ⑥ 同一设备对同一作者：每天上限 + 终身上限（防长期小号养号灌分）；
//   ⑦ 请求级限流（每人每小时最多 10 次）。
const TIP_AMOUNTS = [1, 2, 5, 10];       // 固定档位
const TIP_DAILY_OUT = 20;                // 每人每天最多转出 20 盏
const TIP_IP_DAILY_TOTAL = 30;           // 同一 IP 每天最多转出 30 盏
const TIP_IP_PER_AUTHOR_DAY = 10;        // 同一 IP 对同一作者每天最多 10 盏（防滴灌）
const TIP_IP_PER_WORK_TOTAL = 30;        // 同一 IP 对同一作品终身最多 30 盏（2026-11-06 从「按作者」改成「按作品」：
                                         // 热度分本来就按作品算，按作者卡终身会误伤真粉——给作品 A 送满 30 后
                                         // 连作者的新作 B 都送不了；流量闸（每天 10 盏/作者）保留防滴灌）
const TIPS_RECENT_SHOW = 15;             // 详情页展示最近打赏人数

// 匿名期间收到的灯火，在作品绑定作者时一次性结算给作者
// （认领通过 / 后台指定归属都会走这里；已结算的记录打标记，反复解绑再认领不会重复发）
function settleAnonymousTips(w, uid) {
  if (!w || !uid) return 0;
  let total = 0;
  for (const t of tips) {
    if (t.workId !== w.id) continue;
    if (!t.onWorkOnly) continue;              // 当初已直接转给作者的记录不动
    if (t.settledToUserId) continue;          // 已结算过
    if (t.fromUserId && t.fromUserId === uid) continue; // 自己送过自己的，不重复入账
    t.settledToUserId = uid;
    t.settledAt = Date.now();
    total += t.amount || 0;
  }
  if (!total) return 0;
  saveTips();
  const balance = addPoints(uid, total, 'tip_in_claim', w.id);
  addNotice(uid, {
    kind: 'points',
    title: `「${w.title}」的 ${total} 盏灯火已归到你名下`,
    text: `这件作品在作者匿名期间收到 ${total} 盏灯火，现在归属已确认，一次性转到你的灯火余额（当前 ${balance} 盏）。之后新收到的灯火会直接进你的账户。`,
    points: balance,
    delta: total,
    workId: w.id
  });
  return total;
}

// 作品打赏聚合：{ total, count }（tips 量级很小，直接扫数组即可）
function tipAggOf(workId) {
  let total = 0, count = 0;
  for (const t of tips) {
    if (t.workId !== workId) continue;
    total += t.amount || 0;
    count++;
  }
  return { total, count };
}
// 打赏人数：累计有多少个不同用户送过灯火（打赏必须登录，fromUserId 都在；
// 同一人多笔只算 1 人）。账号注销后 fromUserId 保留，仍算 1 个人。
function tipTippersOf(workId) {
  const seen = new Set();
  for (const t of tips) {
    if (t.workId !== workId) continue;
    if (t.fromUserId) seen.add(t.fromUserId);
  }
  return seen.size;
}
// 同一天判断（打赏限额按自然日）
function tipSameDay(ts) { return dateKey(new Date(ts)) === dateKey(); }

// 打赏汇总（详情弹窗展开打赏面板时用）：总额 + 最近打赏名单。
// 登录状态下顺带带上「看广告送灯」的当日额度（小程序端好显示按钮还剩几次）
app.get('/api/works/:id/tips', (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const recent = tips.filter(t => t.workId === w.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TIPS_RECENT_SHOW)
    .map(t => ({ name: t.fromDisplay || '已注销用户', amount: t.amount, at: t.createdAt }));
  const agg = tipAggOf(w.id);
  const viewer = currentUser(req);
  const out = { total: agg.total, count: agg.count, recent };
  if (viewer) out.adTip = tipAdView(shareRecOf(viewer.id));
  res.json(out);
});

// 打赏：登录用户对别人的作品转灯火
app.post('/api/works/:id/tip', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('tip:' + user.id, 10, 3600e3)) {
    return res.status(429).json({ error: '打赏太频繁了，一小时后再试' });
  }
  if (!rateLimit('tipip:' + clientIp(req), 30, 3600e3)) {
    return res.status(429).json({ error: '当前网络打赏太频繁，稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId && w.userId === user.id) {
    return res.status(400).json({ error: '不能打赏自己的作品' });
  }
  // 作者绑定了账号 → 灯火转给作者；匿名/游客投稿（没有 userId）→ 照样能送，
  // 但灯火只记在这件作品上（计入灯火总数与热度），不转给任何人，等于「为作品点灯」。
  const toUser = w.userId ? users.find(u => u.id === w.userId) : null;
  if (w.userId && !toUser) return res.status(400).json({ error: '作者账号不存在，暂时收不了打赏' });

  const amount = Math.floor(Number(req.body && req.body.amount));
  if (!TIP_AMOUNTS.includes(amount)) {
    return res.status(400).json({ error: '打赏金额只能是 ' + TIP_AMOUNTS.join(' / ') + ' 盏' });
  }

  // 余额（灯火账本统一在 share.json）
  const rec = shareRecOf(user.id);
  const balance = rec.points || 0;
  if (balance < amount) {
    return res.status(400).json({ error: `灯火不够：还差 ${amount - balance} 盏（签到、分享、上传作品都能攒）` });
  }

  // 防洗分闸门：全部按 IP 哈希维度统计
  // 有作者时按「作者」限量（每天），匿名作品按「作品」限量（否则同一件匿名作品可被无限刷）；
  // 终身闸按「作品」算（2026-11-06 起），同一件作品不被一台设备无限输血，但不影响给同位作者的新作表心意。
  // 广告代送（via='ad'）完全不走这套闸：它有自己的额度（3 次/天、每作品每人 1 次/天、25s 间隔），
  // 且每次都对应一次真实广告曝光（平台有收入）——算进来会把自费额度一次吃满（旧版按作者终身闸的隐性 bug）
  const ipk = ipKeyOf(req);
  const day = dateKey();
  let myOutToday = 0, ipOutToday = 0, ipToAuthorToday = 0, ipToWorkTotal = 0;
  for (const t of tips) {
    if (t.via === 'ad') continue;
    if (t.fromUserId === user.id && tipSameDay(t.createdAt)) myOutToday += t.amount;
    if (t.ipk === ipk && tipSameDay(t.createdAt)) ipOutToday += t.amount;
    const sameTarget = toUser ? (t.toUserId === toUser.id) : (!t.toUserId && t.workId === w.id);
    if (t.ipk === ipk && sameTarget && tipSameDay(t.createdAt)) ipToAuthorToday += t.amount;
    if (t.ipk === ipk && t.workId === w.id) ipToWorkTotal += t.amount;
  }
  const targetLabel = toUser ? '这位作者' : '这件作品';
  if (myOutToday + amount > TIP_DAILY_OUT) {
    return res.status(400).json({ error: `今天已经打赏出去 ${myOutToday} 盏，每人每天最多转出 ${TIP_DAILY_OUT} 盏，明天再来` });
  }
  if (ipOutToday + amount > TIP_IP_DAILY_TOTAL) {
    return res.status(400).json({ error: `当前设备今天转出的灯火到上限了（${TIP_IP_DAILY_TOTAL} 盏/天），明天再来` });
  }
  if (ipToAuthorToday + amount > TIP_IP_PER_AUTHOR_DAY) {
    return res.status(400).json({ error: `当前设备今天给${targetLabel}打赏的灯火到上限了（${TIP_IP_PER_AUTHOR_DAY} 盏/天）` });
  }
  if (ipToWorkTotal + amount > TIP_IP_PER_WORK_TOTAL) {
    return res.status(400).json({ error: `当前设备给这件作品的打赏总量到上限了（${TIP_IP_PER_WORK_TOTAL} 盏），心意收到了；作者的新作品可以重新送` });
  }

  // 零和转移：打赏者扣分；有作者就转给作者，匿名作品则「燃尽」——只记在作品上
  const balanceAfter = addPoints(user.id, -amount, 'tip_out', w.id);
  let toBalance = null;
  if (toUser) toBalance = addPoints(toUser.id, amount, 'tip_in', w.id);
  const tip = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    fromUserId: user.id,
    fromDisplay: displayNameOf(user.username),
    toUserId: toUser ? toUser.id : null,
    onWorkOnly: !toUser,          // 匿名/未认领作品：灯火记在作品上，不进任何个人账户
    amount,
    ipk,
    createdAt: Date.now()
  };
  tips.push(tip);
  saveTips();

  // 作者收站内消息（带变动后余额）；匿名作品没有接收人，不发通知
  if (toUser) {
    addNotice(toUser.id, {
      kind: 'points',
      title: `收到打赏 +${amount} 盏灯火`,
      text: `${tip.fromDisplay} 打赏了你的作品「${w.title}」 ${amount} 盏灯火，当前余额 ${toBalance} 盏。灯火可以拿去「推荐」买曝光。`,
      points: toBalance,
      delta: amount
    });
  }

  const agg = tipAggOf(w.id);
  res.json({
    ok: true,
    amount,
    points: balanceAfter,
    anonymousWork: !toUser,
    tipsTotal: agg.total,
    tipsCount: agg.count
  });
});

// ---------- 看广告替作品点灯（平台代送，观众不扣自己的灯火） ----------
// 小程序详情页看完一支激励视频，平台替观众给这件作品送 30 盏灯火：
// 不扣观众余额（灯火不是从观众账户转出去的），有作者就照常入作者账，匿名作品只记在作品上。
// 额度三道闸（都按观众维度，存在 share.json 的 tipAd 字段）：
//   ① 每天 3 次  ② 同一作品每人每天 1 次（防同一个人把广告全砸一个作品刷热度）  ③ 两次间隔 25 秒（防连点）
// 注意：广告代送不占自费打赏的 IP 闸门（每天 10 盏/作者、按作品终身 30 盏），/tip 统计时跳过 via='ad'；
// 也就是说「每天看广告送 30 盏」是独立于自费打赏的固定通道，不会被终身闸锁死，自费额度也不会被它吃掉。
// 账本：tips 里 via='ad' 单独标记，和自掏腰包的打赏分得开，可审计。
const TIP_AD_AMOUNT = 30;
const TIP_AD_DAILY = 3;

function tipAdView(rec) {
  const ta = rec.tipAd || {};
  const used = ta.day === dateKey() ? (ta.count || 0) : 0;
  return {
    amount: TIP_AD_AMOUNT,
    limit: TIP_AD_DAILY,
    used,
    left: Math.max(0, TIP_AD_DAILY - used),
    gapMs: AD_REWARD_GAP_MS
  };
}

app.post('/api/works/:id/tip-ad', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('tipad:' + user.id, 10, 60000)) {
    return res.status(429).json({ error: '操作太频繁，稍等一下' });
  }
  if (!rateLimit('tipadip:' + clientIp(req), 20, 3600e3)) {
    return res.status(429).json({ error: '当前网络操作太频繁，稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId && w.userId === user.id) {
    return res.status(400).json({ error: '不能给自己的作品点灯' });
  }
  const toUser = w.userId ? users.find(u => u.id === w.userId) : null;
  if (w.userId && !toUser) return res.status(400).json({ error: '作者账号不存在，暂时收不了灯火' });

  const rec = shareRecOf(user.id);
  const ta = rec.tipAd || (rec.tipAd = { day: '', count: 0, at: 0, works: [] });
  const today = dateKey();
  if (ta.day !== today) { ta.day = today; ta.count = 0; ta.works = []; }
  if ((ta.count || 0) >= TIP_AD_DAILY) {
    return res.status(400).json({ error: `今天 ${TIP_AD_DAILY} 次看广告送灯已经用完了，明天再来`, adTip: tipAdView(rec) });
  }
  if (Array.isArray(ta.works) && ta.works.includes(w.id)) {
    return res.status(400).json({ error: '这件作品今天已经点过灯了，明天再来，或换个作品送', adTip: tipAdView(rec) });
  }
  if (ta.at && Date.now() - ta.at < AD_REWARD_GAP_MS) {
    return res.status(429).json({ error: '广告刚看完，稍等一下再送', adTip: tipAdView(rec) });
  }

  ta.count = (ta.count || 0) + 1;
  ta.at = Date.now();
  ta.works = (Array.isArray(ta.works) ? ta.works : []).concat(w.id);

  // 平台代送：观众不扣分；有作者就入作者账（kind=tipad_in 可审计），匿名作品「燃尽」记在作品上
  let toBalance = null;
  if (toUser) toBalance = addPoints(toUser.id, TIP_AD_AMOUNT, 'tipad_in', w.id);
  const tip = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    fromUserId: user.id,
    fromDisplay: displayNameOf(user.username),
    toUserId: toUser ? toUser.id : null,
    onWorkOnly: !toUser,
    amount: TIP_AD_AMOUNT,
    via: 'ad',          // 看广告平台代送的灯，和自掏腰包的打赏分开记
    ipk: ipKeyOf(req),
    createdAt: Date.now()
  };
  tips.push(tip);
  saveTips();

  if (toUser) {
    addNotice(toUser.id, {
      kind: 'points',
      title: `收到看广告送的 +${TIP_AD_AMOUNT} 盏灯火`,
      text: `${tip.fromDisplay} 看完广告为你的作品「${w.title}」点了 ${TIP_AD_AMOUNT} 盏灯（平台代送，不扣对方的灯火），当前余额 ${toBalance} 盏。灯火可以拿去「推荐」买曝光。`,
      points: toBalance,
      delta: TIP_AD_AMOUNT
    });
  }

  const agg = tipAggOf(w.id);
  res.json({
    ok: true,
    amount: TIP_AD_AMOUNT,
    anonymousWork: !toUser,
    adTip: tipAdView(rec),
    tipsTotal: agg.total,
    tipsCount: agg.count
  });
});

// 投诉
app.post('/api/works/:id/report', (req, res) => {
  if (!rateLimit('report:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const { reason, description, contact } = req.body || {};
  const REASONS = ['违法违规', '涉嫌侵权/盗用他人作品', '我是原作者，希望移除', '内容不当', '虚假信息', '已不能使用', '其他'];
  if (!REASONS.includes(reason)) return res.status(400).json({ error: '请选择投诉原因' });
  reports.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    workId: w.id,
    workTitle: w.title,
    reason,
    description: String(description || '').slice(0, 500),
    contact: String(contact || '').slice(0, 100),
    status: '待处理',
    // 原作者主张移除：按「通知—删除」优先处理，后台排队置顶
    priority: reason === '我是原作者，希望移除' ? 'high' : 'normal',
    createdAt: new Date().toISOString()
  });
  saveReports();
  w.reports = (w.reports || 0) + 1;
  saveWorks();
  res.status(201).json({
    ok: true,
    message: reason === '我是原作者，希望移除'
      ? '已收到，我们会优先核实并在 1-2 个工作日内处理'
      : '投诉已提交，我们会在 1-3 个工作日内处理'
  });
});

// ================= 评论 =================
// 结构：{ id, workId, userId, username, text, createdAt, parentId, kind, anon }
//   parentId  回复的顶级评论 id（只允许一层，回复的回复归到同一父级）
//   kind      'question' 提问 / 'comment' 普通评论
//   anon      匿名发言（未登录，只能由管理员删除）

// 作者身份只认账号 id（userId）；w.author 只是展示用的名字，谁都能注册同名。
// 旧评论可能没存 userId，这时才用名字反查账号 id 兜底；无主作品一律不认「同名即作者」。
function commentIsAuthor(c, w) {
  if (!w || !w.userId || !c) return false;
  if (c.userId) return c.userId === w.userId;
  const u = users.find(x => x.username === c.username);
  return !!(u && u.id === w.userId);
}

// 把评论整理成前端需要的形状
function shapeComment(c, w, user, admin, byId, answeredIds) {
  // 匿名评论的 username 就是访客自己填的昵称，不能再拿它去对账号（可能撞名）
  const showName = c.anon ? c.username : displayNameOf(c.username);
  return {
    id: c.id,
    username: c.username,
    displayName: showName,
    text: c.text,
    createdAt: c.createdAt,
    parentId: c.parentId || null,
    kind: c.kind === 'question' ? 'question' : 'comment',
    anon: !!c.anon,
    // 评论者就是作品作者（作者答疑会打「作者」标签）—— 按账号 id 认，不按名字
    isAuthor: commentIsAuthor(c, w),
    answered: c.kind === 'question' && answeredIds.has(c.id),
    owned: !!user && (user.username === c.username || admin),
    // 回复的对象：优先取具体被回复的那条，其次取楼层作者
    replyToName: (() => {
      const t = byId.get(c.replyToId || c.parentId);
      return t ? (t.anon ? t.username : displayNameOf(t.username)) : '';
    })()
  };
}

// 评论列表（公开，含回复；未回答的提问排在前面）
app.get('/api/works/:id/comments', (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const user = currentUser(req); // 可为空，用于标记自己的评论
  const admin = isAdmin(req);
  const all = comments.filter(c => c.workId === w.id);
  const byId = new Map(all.map(c => [c.id, c]));
  // 作者回复过的提问 id（回复者是作品作者）
  const answered = new Set();
  for (const c of all) {
    if (!c.parentId) continue;
    if (commentIsAuthor(c, w)) answered.add(c.parentId);
  }
  const top = all.filter(c => !c.parentId);
  const replies = all.filter(c => c.parentId);
  top.sort((a, b) => {
    const pa = a.kind === 'question' && !answered.has(a.id) ? 0 : 1;
    const pb = b.kind === 'question' && !answered.has(b.id) ? 0 : 1;
    return pa - pb || b.createdAt - a.createdAt;
  });
  replies.sort((a, b) => a.createdAt - b.createdAt);
  res.json([...top, ...replies].map(c => shapeComment(c, w, user, admin, byId, answered)));
});

// 发表评论 / 提问（登录用户或匿名均可）
app.post('/api/works/:id/comments', async (req, res) => {
  const user = currentUser(req);
  const ip = clientIp(req);
  const anon = !user;
  // 匿名额度更紧：10 分钟 5 条；登录用户 10 分钟 20 条
  if (!rateLimit('comment:' + ip, anon ? 5 : 20, 600000)) {
    return res.status(429).json({
      error: anon ? '匿名发言太频繁了，登录后可继续评论' : '评论太频繁，请稍后再试'
    });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });

  const body = req.body || {};
  const text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  if (text.length > 500) return res.status(400).json({ error: '最多 500 字' });
  if (anon && text.length < 2) return res.status(400).json({ error: '至少写 2 个字吧' });

  let username = user
    ? user.username
    : String(body.nickname || '').replace(/[<>\r\n]/g, '').trim().slice(0, 20);
  if (!username) username = '匿名';
  if (hitSensitive(text + username)) {
    return res.status(400).json({ error: '内容包含违规词，请修改后重试' });
  }

  // 第一道：微信官方内容安全接口（UGC 提审硬要求，评论/回复跟发想法同一个待遇）
  const wxCheck = await wechatMsgCheck(text, user && user.wechat && user.wechat.openid);
  if (wxCheck.pass === false) {
    return res.status(400).json({ error: '评论未通过平台内容安全检测，请修改后重试' });
  }

  // AI 初审：明确违规直接拒；AI 不可用时放行（敏感词 + 限流兜底，管理员还能删）
  const ai = await aiReviewGate('作品评论：' + text);
  if (ai.pass === false) {
    return res.status(400).json({ error: '评论疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，请修改后重试' });
  }

  // 回复：必须挂在本作品的顶级评论下，只允许一层
  let parentId = null;
  let replyToId = null;
  if (body.parentId) {
    const p = comments.find(c => c.id === String(body.parentId) && c.workId === w.id);
    if (!p) return res.status(400).json({ error: '要回复的评论不存在' });
    parentId = p.parentId || p.id;
    // 具体回复的是哪一条（可能是一楼本身，也可能是楼里的某条回复）
    const t = comments.find(c => c.id === String(body.replyToId || '') && c.workId === w.id);
    replyToId = t ? t.id : parentId;
  }
  const kind = !parentId && body.kind === 'question' ? 'question' : 'comment';

  const c = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    userId: user ? user.id : null,
    username,
    text,
    createdAt: Date.now(),
    parentId,
    replyToId,
    kind,
    anon
  };
  comments.push(c);
  saveComments();
  invalidateCommentCounts();

  // ---- 评论 / 提问通知 ----
  // 有账号的作者/被回复者才能收到；自己给自己留言不通知。文本截断，避免撑爆消息气泡。
  const brief = text.length > 80 ? text.slice(0, 80) + '…' : text;
  const say = c.anon ? username : displayNameOf(username);
  if (!parentId) {
    // 顶级评论 / 提问 → 通知作品作者
    const isSelf = !!w.userId && ((user && user.id === w.userId) || (c.userId && c.userId === w.userId));
    if (w.userId && !isSelf) {
      addNotice(w.userId, {
        kind: kind === 'question' ? 'work-question' : 'work-comment',
        title: kind === 'question' ? `收到新提问 · ${w.title}` : `收到新评论 · ${w.title}`,
        text: `${say}${kind === 'question' ? ' 向你提问：' : ' 评论了你的作品：'}${brief}`,
        workId: w.id,
        commentId: c.id
      });
    }
  } else {
    // 楼内回复 → 通知被回复的那条评论的主人（父楼层作者）
    const target = comments.find(x => x.id === replyToId) || comments.find(x => x.id === parentId);
    if (target && target.userId && target.userId !== (user && user.id) && target.username !== username) {
      addNotice(target.userId, {
        kind: 'work-reply',
        title: `收到新回复 · ${w.title}`,
        text: `${say} 回复了你：${brief}`,
        workId: w.id,
        commentId: c.id
      });
    }
  }

  const byId = new Map(comments.filter(x => x.workId === w.id).map(x => [x.id, x]));
  res.status(201).json(shapeComment(c, w, user, isAdmin(req), byId, new Set()));
});

// 删除评论（本人、管理员账号，或后台口令）
app.delete('/api/comments/:id', (req, res) => {
  const user = currentUser(req);
  const admin = isAdmin(req);
  if (!user && !admin) return res.status(401).json({ error: '请先登录' });
  const idx = comments.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '评论不存在' });
  const c = comments[idx];
  if ((!user || c.username !== user.username) && !admin) {
    return res.status(403).json({ error: '只能删除自己的评论' });
  }
  // 删父评论时，挂在它下面的回复一并删除，避免留下孤儿回复
  const doomed = new Set([c.id]);
  comments.filter(x => x.parentId === c.id).forEach(x => doomed.add(x.id));
  for (let i = comments.length - 1; i >= 0; i--) {
    if (doomed.has(comments[i].id)) comments.splice(i, 1);
  }
  saveComments();
  invalidateCommentCounts();
  res.json({ ok: true, removed: doomed.size });
});

// 后台：最近评论（新→旧，限 200 条）
app.get('/api/admin/comments', requireAdmin, (req, res) => {
  const list = comments
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200)
    .map(c => {
      const w = works.find(x => x.id === c.workId);
      return { ...c, workTitle: w ? w.title : '（作品已删除）' };
    });
  res.json(list);
});

// 后台：把历史上的评论补发成站内通知
//   · 只补「有账号的用户」发的评论（匿名的一律跳过）
//   · 自己评论自己的作品 / 自己回复自己 跳过
//   · 按 commentId 去重，可反复调用；通知时间用评论当时的时间，不会全部堆在今天
//   · 默认只试算（dryRun），传 { apply: true } 才真正写入
app.post('/api/admin/notify-old-comments', requireAdmin, (req, res) => {
  const apply = !!(req.body && req.body.apply);
  const known = new Set(notices.filter(n => n.commentId).map(n => n.commentId));
  const pend = [];
  const skip = { anon: 0, self: 0, noWork: 0, noUser: 0, done: 0 };
  const sorted = comments.slice().sort((a, b) => a.createdAt - b.createdAt);
  for (const c of sorted) {
    if (c.anon) { skip.anon++; continue; }
    if (known.has(c.id)) { skip.done++; continue; }
    const w = works.find(x => x.id === c.workId);
    if (!w || w.deleted) { skip.noWork++; continue; }
    const d = new Date(c.createdAt);
    const day = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    const brief = c.text.length > 80 ? c.text.slice(0, 80) + '…' : c.text;
    const say = displayNameOf(c.username) || c.username;
    let targetId = null, kind = '', title = '', verb = '';
    if (!c.parentId) {
      if (!w.userId) { skip.noUser++; continue; }
      if (commentIsAuthor(c, w)) { skip.self++; continue; }
      targetId = w.userId;
      kind = c.kind === 'question' ? 'work-question' : 'work-comment';
      title = kind === 'question' ? `收到新提问 · ${w.title}` : `收到新评论 · ${w.title}`;
      verb = kind === 'question' ? ' 向你提问：' : ' 评论了你的作品：';
    } else {
      const p = comments.find(x => x.id === (c.replyToId || c.parentId));
      if (!p || !p.userId) { skip.noUser++; continue; }
      if (p.username === c.username) { skip.self++; continue; }
      targetId = p.userId;
      kind = 'work-reply';
      title = `收到新回复 · ${w.title}`;
      verb = ' 回复了你：';
    }
    pend.push({
      id: 'bf' + c.id,
      userId: String(targetId),
      kind,
      title: title.slice(0, 60),
      text: `${say} 在 ${day}${verb}${brief}`.slice(0, 300),
      points: 0,
      delta: 0,
      workId: w.id,
      commentId: c.id,
      read: false,
      backfill: true,
      createdAt: d.toISOString()
    });
  }
  if (!apply) {
    return res.json({ ok: true, dryRun: true, wouldCreate: pend.length, skip, preview: pend.slice(-8) });
  }
  // 合进现有消息并按时间倒序；每人限 50 条（与新消息同一规则，超出的丢最旧）
  notices = notices.concat(pend).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const kept = [];
  const perUser = new Map();
  for (const n of notices) {
    const used = perUser.get(n.userId) || 0;
    if (used >= NOTICE_KEEP_PER_USER) continue;
    perUser.set(n.userId, used + 1);
    kept.push(n);
  }
  notices = kept;
  saveNotices();
  res.json({ ok: true, dryRun: false, created: pend.length, skip });
});

// ================= 意见反馈（用户 ↔ 站长，双向对话） =================
// 一条反馈 = 一个会话，往来消息都存在 feedback.thread 里。
//   · 登录用户：站长回复时同推一条站内消息（铃铛），点「回复」就能继续聊
//   · 游客：提交时发一个 token 留在本机，靠它回来在「我的反馈」里看回复、继续聊
// 匿名也能提，登录用户自动带上用户名；后台可回复 / 标记处理 / 删除
const FB_TYPES = ['功能建议', '遇到问题', '内容建议', '合作/其他'];
function fbNewToken() { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4); }
// 老数据没有 thread 字段：就地补上，并把最初的正文当成第一条用户消息
function fbThread(f) {
  if (!Array.isArray(f.thread)) {
    f.thread = f.content ? [{ from: 'user', fromName: f.username || '', text: f.content, at: f.createdAt, read: true }] : [];
  }
  return f.thread;
}
function fbLastAt(f) { return f.lastAt || f.createdAt; }
function fbSort(a, b) { return new Date(fbLastAt(b)) - new Date(fbLastAt(a)); }
// 用户侧看到的反馈：不带 token / ua 这些内部字段
function fbPublic(f) {
  return {
    id: f.id, type: f.type, content: f.content, status: f.status,
    createdAt: f.createdAt, lastAt: fbLastAt(f),
    thread: fbThread(f),
    unread: fbThread(f).filter(m => m.from === 'admin' && !m.read).length
  };
}
// 用户看过即标记：站长的消息置已读（反馈悬浮球上的小红点靠它）
function fbMarkReadByUser(f) {
  let changed = 0;
  fbThread(f).forEach(m => { if (m.from === 'admin' && !m.read) { m.read = true; changed++; } });
  return changed;
}

app.post('/api/feedback', (req, res) => {
  if (!rateLimit('feedback:' + clientIp(req), 5, 3600000)) {
    return res.status(429).json({ error: '反馈提交太频繁了，休息一会儿再试' });
  }
  const { type, content, contact } = req.body || {};
  const text = String(content || '').trim();
  if (text.length < 5) return res.status(400).json({ error: '多写两句吧，至少 5 个字' });
  if (text.length > 1000) return res.status(400).json({ error: '内容太长了，1000 字以内' });
  const me = currentUser(req);
  const now = new Date().toISOString();
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    token: fbNewToken(),                          // 游客凭证：只留在提交那台机器上，用来回来看回复
    type: FB_TYPES.includes(type) ? type : '功能建议',
    content: text,
    contact: String(contact || '').trim().slice(0, 100),
    username: me ? me.username : '',
    userId: me ? me.id : '',
    page: String(req.headers.referer || '').slice(0, 200),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    status: '待查看',
    createdAt: now,
    lastAt: now,
    thread: [{ from: 'user', fromName: me ? (me.nickname || me.username) : '', text, at: now, read: false }]
  };
  feedback.push(item);
  saveFeedback();
  if (feedback.length > 2000) { feedback = feedback.slice(-2000); saveFeedback(); } // 防止无限增长
  res.status(201).json({
    ok: true, id: item.id, token: item.token,
    message: me ? '收到啦，站长回复会推到右上角消息里' : '收到啦，之后在「我的反馈」里可以看回复'
  });
});

// 我的反馈（登录用户，换设备也能查到）
app.get('/api/me/feedback', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const peek = req.query.peek === '1';           // peek=1：只数未读，不标已读（悬浮球红点用）
  const mine = feedback.filter(f => f.userId && f.userId === user.id).sort(fbSort);
  let changed = 0;
  // 先把「有几条没看」算出来再标记，打开列表时还能看出哪条是新回复
  const items = mine.map(f => {
    const pub = fbPublic(f);
    if (!peek) changed += fbMarkReadByUser(f);
    return pub;
  });
  if (changed) saveFeedback();
  res.json({ items });
});

// 我的反馈（游客 / 换设备：凭本机留的 id + token 取回）
app.post('/api/feedback/mine', (req, res) => {
  const list = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 30) : [];
  const peek = !!(req.body && req.body.peek);
  const picked = [];
  list.forEach(it => {
    const id = String((it && it.id) || '');
    const tk = String((it && it.token) || '');
    const f = feedback.find(x => x.id === id && x.token && x.token === tk);
    if (!f || picked.includes(f)) return;           // token 对不上就当没这条（删掉的反馈也会自然消失）
    picked.push(f);
  });
  picked.sort(fbSort);
  let changed = 0;
  const items = picked.map(f => {
    const pub = fbPublic(f);
    if (!peek) changed += fbMarkReadByUser(f);
    return pub;
  });
  if (changed) saveFeedback();
  res.json({ items });
});

// 用户继续回复（登录用户凭会话，游客凭 token）
app.post('/api/feedback/:id/reply', (req, res) => {
  const f = feedback.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '反馈不存在' });
  const user = currentUser(req);
  const token = String((req.body && req.body.token) || '');
  if (!(user && f.userId && f.userId === user.id) && !(f.token && token && f.token === token)) {
    return res.status(403).json({ error: '没有权限回复这条反馈' });
  }
  if (!rateLimit('fbreply:' + clientIp(req), 40, 3600000)) {
    return res.status(429).json({ error: '回复太频繁了，歇一会儿再试' });
  }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: '写点什么再发吧' });
  const now = new Date().toISOString();
  fbThread(f).push({ from: 'user', fromName: user ? (user.nickname || user.username) : '', text, at: now, read: false });
  f.status = '待查看';                            // 又有新消息了，后台重新亮起来
  f.lastAt = now;
  saveFeedback();
  res.json({ ok: true, thread: fbThread(f) });
});

// ================= 管理端 =================

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  // 注册用户：累计 / 今日新增 / 近 7 天新增（按本地日期算）
  const today = dateKey();
  const weekAgo = dateKey(new Date(Date.now() - 6 * 86400e3));
  let usersToday = 0, users7 = 0;
  users.forEach(u => {
    const d = u.createdAt ? dateKey(new Date(u.createdAt)) : '';
    if (d === today) usersToday += 1;
    if (d && d >= weekAgo) users7 += 1;
  });
  res.json({
    total: works.length,
    approved: works.filter(w => (w.status || 'approved') === 'approved').length,
    pending: works.filter(w => w.status === 'pending').length,
    // 已下架 = 管理员下架（rejected）+ 作者自主下架（hidden）
    offline: works.filter(isOffline).length,
    reports: reports.filter(r => r.status === '待处理').length,
    feedback: feedback.filter(f => f.status === '待查看').length,
    claims: claims.filter(c => c.status === 'pending').length,
    views: works.reduce((s, w) => s + (w.views || 0), 0),
    likes: works.reduce((s, w) => s + (w.likes || 0), 0),
    users: users.length,
    usersToday,
    users7,
    usersMini: users.filter(u => u.regFrom === 'mini').length,
    promo: promoStatsForAdmin(),
    search: searchStatsForAdmin(),
    traffic: trafficStats(),
    ...visitStats()
  });
});

// GitHub star 同步：手动触发一轮（运维/排障用），顺便返回当前各仓库的基线与缓存值
app.post('/api/admin/starsync', requireAdmin, async (req, res) => {
  if (STAR_REWARD_RATE <= 0) return res.status(400).json({ error: 'STAR_REWARD_RATE 为 0，star 奖励已关闭' });
  try {
    await syncStarRewards();
  } catch (e) {
    return res.status(500).json({ error: '同步失败：' + e.message });
  }
  const repos = Object.entries(starSync.repos).map(([key, r]) => ({ repo: key, count: r.count, at: r.at, day: r.day || '', dayAwarded: r.dayAwarded || 0 }));
  res.json({ ok: true, lastAt: starSync.lastAt, rate: STAR_REWARD_RATE, dayCap: STAR_REWARD_DAY_CAP, repos });
});

app.get('/api/admin/works', requireAdmin, (req, res) => {
  const status = req.query.status;
  let list = works.slice();
  if (status === 'offline') {
    // 「已下架」不是单一 status：管理员下架走 rejected，作者自主下架走 hidden，两条都收进来
    list = list.filter(isOffline);
  } else if (status && status !== '全部') list = list.filter(w => (w.status || 'approved') === status);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const shifts = blockShiftMap(list.filter(w => !w.pinned).map(w => w.id));
  res.json(list.map(w => ({
    ...publicWork(w), status: w.status || 'approved', reports: w.reports || 0, anon: !!w.anon,
    aiReview: w.aiReview || null,   // AI 初审意见（pass/reason/note），待审列表展示给管理员参考
    featuredUntil: w.featuredUntil || null,
    offlineReason: w.offlineReason || '',
    offlineAt: w.offlineAt || '',
    updatedAt: w.updatedAt || w.createdAt,
    authorReal: w.authorReal || '',
    ownerReal: w.ownerReal ? ((users.find(u => u.id === w.ownerReal) || {}).username || '') : '',
    ...workVisitStats(w.id),
    // 屏蔽统计：home 最新列表的降权依据，后台逐件可见（含站长自己的那一票）
    ...blockAdminStats(w)
  })));
});

// 后台看到的一件作品的屏蔽情况：总人数、其中站长几人、当前降权位数、最近一次重置时间
function blockAdminStats(w) {
  const rec = blockStats[w.id] || {};
  const by = (rec && rec.by) || {};
  const since = Date.now() - BLOCK_RULE.windowDays * 86400000;
  const from = Math.max(since, Number(rec.resetAt) || 0);
  let count = 0, ownerCount = 0;
  Object.keys(by).forEach(uid => {
    if ((Number(by[uid]) || 0) <= from) return;
    count++;
    const u = users.find(x => x.id === uid);
    if (isSiteOwner(u)) ownerCount++;
  });
  return {
    blockCount: count,
    blockOwnerCount: ownerCount,
    blockShift: w.pinned ? 0 : (blockShiftOf(w.id) || 0),
    blockResetAt: rec.resetAt || 0,
    blockExpireAt: from ? from + BLOCK_RULE.windowDays * 86400000 : 0
  };
}

// 清除某件作品的降权：只清「计票」，不动用户自己的屏蔽列表——
// 他们仍然看不到这件作品（那是个人偏好），只是这票不再影响排序。
// 记下 resetAt，之后新的屏蔽才会重新计入，站长判断错了能立刻撤回。
app.post('/api/admin/works/:id/block-reset', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const rec = blockStats[w.id] || (blockStats[w.id] = { by: {} });
  rec.by = {};
  rec.resetAt = Date.now();
  saveBlockStats();
  res.json({ ok: true, ...blockAdminStats(w) });
});

// 站长账号（权重 3）：后台「用户管理」里点按钮设置，也可以直接用 SITE_OWNERS 环境变量预置
app.get('/api/admin/owners', requireAdmin, (req, res) => {
  // 账号注销后名字还留在名单里就会变成一个点不到的幽灵项，读的时候顺手剔掉
  const alive = siteOwners.filter(n => users.some(u => u.username === n));
  if (alive.length !== siteOwners.length) { siteOwners = alive; saveSiteOwners(); }
  res.json(siteOwners);
});
app.post('/api/admin/owners', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.username) || '').trim();
  if (!name) return res.status(400).json({ error: '请指定账号名' });
  const on = !(req.body && req.body.on === false);
  // 加人要求账号存在；取消不限（账号可能已经被注销了，仍要能把他从名单里去掉）
  if (on && !users.some(u => u.username === name)) return res.status(404).json({ error: '账号不存在' });
  const i = siteOwners.indexOf(name);
  if (on && i === -1) siteOwners.push(name);
  if (!on && i !== -1) siteOwners.splice(i, 1);
  saveSiteOwners();
  res.json({ owners: siteOwners, on });
});

app.post('/api/admin/works/:id/approve', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.status = 'approved';
  w.updatedAt = new Date().toISOString();
  // 通过即恢复展示，上一次的下架记录一并清掉，免得列表里挂着过期的下架原因
  delete w.offlineReason;
  delete w.offlineAt;
  saveWorks();
  res.json({ ok: true });
});

app.post('/api/admin/works/:id/reject', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const note = String((req.body && req.body.reason) || '').trim().slice(0, 200);
  w.status = 'rejected';
  w.hidden = false;                 // 管理员下架优先：作者侧 hidden 合并成一条“已下架”
  w.offlineReason = note || w.offlineReason || '管理员手动下架';
  w.offlineAt = new Date().toISOString();
  w.updatedAt = w.offlineAt;
  saveWorks();
  res.json({ ok: true });
});

// 恢复上架：管理员下架（rejected）与作者自主下架（hidden）都能一键复原，数据（浏览/点赞/灯火/推广）不动
app.post('/api/admin/works/:id/relist', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (!isOffline(w)) return res.json({ ok: true, changed: false, status: w.status || 'approved', hidden: !!w.hidden });
  const wasRejected = (w.status || 'approved') === 'rejected';
  w.status = 'approved';
  w.hidden = false;
  w.updatedAt = new Date().toISOString();
  delete w.offlineReason;
  delete w.offlineAt;
  saveWorks();
  if (w.userId) {
    addNotice(w.userId, {
      kind: 'system',
      title: `「${w.title}」已恢复上架`,
      text: wasRejected
        ? '管理员复核后已恢复展示，作品重新出现在首页与榜单中。'
        : '作品已由管理员恢复上架，重新出现在首页与榜单中；如仍不想展示，可在「我的作品」里再次下架。'
    });
  }
  res.json({ ok: true, changed: true, status: 'approved', hidden: false });
});

// 精选 / 置顶 切换（精选支持有效期：1/3/7/15/30 天，默认 3 天；开启时通知作者，可回复）
app.post('/api/admin/works/:id/feature', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const off = req.body && (req.body.off === true || req.body.off === 'true' || req.body.off === 1);
  const days = Number((req.body && req.body.days) || 0);
  if (off || (w.featured && !days)) {
    // 取消精选
    w.featured = false; w.featuredUntil = null;
    saveWorks();
    res.json({ ok: true, featured: false, featuredUntil: null });
    return;
  }
  // 设为精选（默认 3 天）
  const d = days >= 1 ? days : 3;
  w.featured = true;
  w.featuredUntil = new Date(Date.now() + d * 86400000).toISOString();
  saveWorks();
  // 通知作者（带空会话，作者可直接回复）
  if (w.userId) {
    addNotice(w.userId, {
      kind: 'featured',
      title: `「${w.title}」被选为精选`,
      text: `恭喜！你的作品已上精选位，将展示 ${d} 天。点开作品可查看效果，有疑问可直接回复这条消息。`,
      workId: w.id,
      thread: []
    });
  }
  res.json({ ok: true, featured: true, featuredUntil: w.featuredUntil });
});

// 反馈有新回复：给有账号的提交人推一条站内消息（同一条反馈只维护一个会话消息，不刷屏）
function pushFeedbackNotice(f, text) {
  if (!f || !f.userId) return null;
  const now = new Date().toISOString();
  let n = notices.find(x => x.feedbackId === f.id && x.userId === f.userId);
  if (!n) {
    n = buildNotice(f.userId, {
      kind: 'feedback',
      title: '你的意见反馈有回复了',
      text,
      threadId: null,          // 容器：threadId 指向自己，thread 实时取自 feedback.thread
      feedbackId: f.id
    });
  } else {
    n.title = '你的意见反馈有回复了';
    n.text = String(text || '').slice(0, 300);
    n.read = false;
    n.createdAt = now;                                // 顶成最新一条
    notices = [n, ...notices.filter(x => x.id !== n.id)];
  }
  if (n) { trimNotices(f.userId); saveNotices(); }
  return n;
}

// 后台收件箱：作者就精选 / 消息发起的回复会话（管理员无独立账号，靠此接口轮询）
app.get('/api/admin/replies', requireAdmin, (req, res) => {
  const threads = notices
    .filter(n => !n.feedbackId && Array.isArray(n.thread) && n.thread.some(m => m.from === 'user'))
    .map(n => {
      const w = n.workId ? works.find(x => x.id === n.workId) : null;
      const unread = n.thread.filter(m => m.from === 'user' && !m.read).length;
      return {
        id: n.id,
        workId: n.workId || null,
        workTitle: w ? w.title : '',
        authorId: n.userId,
        authorName: (users.find(u => u.id === n.userId) || {}).username || n.userId,
        messages: n.thread,
        unread,
        lastAt: n.thread.length ? n.thread[n.thread.length - 1].at : n.createdAt
      };
    })
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  res.json({ threads });
});

// 管理员回信（写回会话容器，并给作者推一条「管理员回复了你」，作者可继续回复）
app.post('/api/admin/replies', requireAdmin, (req, res) => {
  const threadId = String((req.body && req.body.threadId) || '');
  const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
  if (!threadId || text.length < 1) return res.status(400).json({ error: '内容不能为空' });
  const container = notices.find(n => n.id === threadId);
  if (!container) return res.status(404).json({ error: '对话不存在' });
  container.thread = container.thread || [];
  container.thread.push({ from: 'admin', fromId: 'admin', fromName: '管理员', text, at: new Date().toISOString(), read: true });
  saveNotices();
  if (container.userId) {
    addNotice(container.userId, {
      kind: 'reply',
      title: '管理员回复了你',
      text: text,
      workId: container.workId || null,
      threadId: container.id
    });
  }
  res.json({ ok: true });
});

// 管理员查看会话后标记用户消息已读（更新未读角标）
app.post('/api/admin/replies/:id/read', requireAdmin, (req, res) => {
  const container = notices.find(n => n.id === req.params.id);
  if (container && Array.isArray(container.thread)) {
    let changed = 0;
    container.thread.forEach(m => { if (m.from === 'user' && !m.read) { m.read = true; changed++; } });
    if (changed) saveNotices();
  }
  res.json({ ok: true });
});

app.post('/api/admin/works/:id/pin', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.pinned = !w.pinned;
  saveWorks();
  res.json({ ok: true, pinned: w.pinned });
});

// 开放 / 关闭认领（只有开放的作品，前台详情页才出现认领入口）
app.post('/api/admin/works/:id/claim-open', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const raw = req.body && req.body.open;
  const open = raw === undefined ? !isClaimable(w) : !!raw;
  w.claimOpen = open;
  if (!open) {
    // 关闭时把待审申请一并关掉，避免挂在后台没人能处理
    const now = new Date().toISOString();
    claims.forEach(c => {
      if (c.workId === w.id && c.status === 'pending') {
        c.status = 'rejected'; c.handledAt = now; c.note = '管理员关闭了该作品的认领';
      }
    });
    saveClaims();
  }
  saveWorks();
  res.json({ ok: true, claimable: open });
});

// 匿名发布：作品脱离原账号，看起来就是一件「没有归属的匿名投稿」——
// · 前台不再显示是谁发的（作者名换成「匿名」）
// · userId 摘掉，作者的「我的作品 / 数据看板 / 积分推广」里都不再出现它
// · 自动开放认领，真正的作者提交证据就能认回去（认领通过后归到申请人名下）
// 真实提交人只记在后台字段里（authorReal / ownerReal），方便你自己事后核对或取消匿名。
app.post('/api/admin/works/:id/anonymous', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const raw = req.body && req.body.anonymous;
  const anon = raw === undefined ? !w.anonymous : !!raw;
  if (anon) {
    if (!w.anonymous) {
      w.authorReal = w.author || '';
      w.ownerReal = w.userId || '';
      delete w.userId;
      w.author = '匿名';
      w.anonymous = true;
    }
    w.claimOpen = true;
  } else if (w.anonymous) {
    if (w.authorReal) w.author = w.authorReal;
    if (w.ownerReal && users.some(u => u.id === w.ownerReal)) w.userId = w.ownerReal;
    delete w.authorReal;
    delete w.ownerReal;
    delete w.anonymous;
    if (w.claimOpen === true) w.claimOpen = false;
  }
  saveWorks();
  res.json({ ok: true, anonymous: w.anonymous === true, claimable: isClaimable(w), author: w.author });
});

// 管理员把作品指定给站内某个账号：作品归到该账号名下
// （影响：前台署名、TA 的「我的作品 / 数据看板」、推广与积分归属）
app.post('/api/admin/works/:id/assign', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const name = String((req.body && req.body.username) || '').trim().replace(/^@/, '');
  if (!name) return res.status(400).json({ error: '请填写要指定给的账号名' });
  const u = users.find(x => x.username === name)
    || users.find(x => (x.username || '').toLowerCase() === name.toLowerCase());
  if (!u) return res.status(404).json({ error: `站内没有账号「${name}」，请到「用户」标签页确认` });
  const prevUserId = w.userId;
  w.author = u.username;
  w.userId = u.id;
  // 明确指定归属后，匿名发布 / 待认领状态一并清掉
  delete w.anonymous; delete w.authorReal; delete w.ownerReal;
  if (w.claimOpen === true) w.claimOpen = false;
  // 归属定下来后补发开源奖励：后台先建作品（userId=null）再指定作者时，
  // 这是它唯一能拿到 50 盏的机会——不补就只能靠人工再保存一次编辑，很容易漏。
  const osBonus = grantOpenSourceBonus(w);
  // 上传奖励按「视同投稿」处理：指定账号 = 确认这件作品是 TA 的，跟自己投稿同一条规则
  // （首件 200 / 后续 20，48 小时观察期后到账，到账时发站内通知）。已发过的不重复；
  // 预告卡（wip）不发，等真正上线时由 promoteToLive 补。
  const uploadReward = (w.uploadReward || stageOf(w) !== 'live') ? null : planUploadReward(w, u, 'assign');
  const settledTips = settleAnonymousTips(w, u.id);   // 匿名期间收到的灯火归到新作者名下
  saveWorks();
  // 给被指定的用户发一条站内消息（指回同一个账号就不重复打扰）
  if (u.id !== prevUserId) {
    addNotice(u.id, {
      kind: 'system',
      title: `「${w.title}」已归到你的名下`,
      text: `管理员确认这件作品是你做的，已指定给你：前台署名、数据看板、推广与灯火归属都算你的。`
        + (uploadReward ? `上传奖励 ${uploadReward.amount} 盏灯火将在 48 小时后到账。` : '')
        + `如果不是你做的，可在作品页发起投诉。`
    });
  }
  res.json({
    ok: true, author: w.author, claimed: true, claimable: isClaimable(w), osBonus, settledTips,
    uploadReward: uploadReward ? { amount: uploadReward.amount, first: uploadReward.first, readyAt: uploadReward.readyAt } : null
  });
});

// 管理员一键收回某作品的开源奖励（扣回作者 50 盏灯火 + 站内通知）
// 用于虚假仓库 / 作弊等场景。osBonusAt 保留不清除 —— 收回后即便重新标注开源也不会再自动赠送（防刷）。
app.post('/api/admin/works/:id/recall-os-bonus', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (!w.osBonusAt) return res.status(400).json({ error: '该作品从未发放过开源奖励' });
  if (w.osBonusRecalled) return res.status(400).json({ error: '该作品的开源奖励已收回，无需重复操作' });
  if (!w.userId) return res.status(400).json({ error: '作品未归属账号，无法扣回灯火' });
  const user = users.find(u => u.id === w.userId);
  if (!user) return res.status(400).json({ error: '作者账号不存在' });
  const points = addPoints(w.userId, -OS_BONUS_POINTS, 'os-recall', w.id);
  w.osBonusRecalled = true;
  saveWorks();
  addNotice(w.userId, {
    kind: 'points',
    title: `开源奖励已收回 -${OS_BONUS_POINTS} 盏灯火`,
    text: `「${w.title}」的开源奖励 ${OS_BONUS_POINTS} 盏灯火已被站长收回（当前余额 ${points} 盏）。如有疑问请联系站长。`,
    points, delta: -OS_BONUS_POINTS
  });
  res.json({ ok: true, recalled: OS_BONUS_POINTS, points, osBonusRecalled: true });
});

// 管理员直接新增作品（可指定作者、状态、精选/置顶）
app.post('/api/admin/works', requireAdmin, (req, res) => {
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const { title, prompt, category, link, type, author, status } = req.body;
    const types = normalizeTypes(req.body.types || type);
    const image = req.files && req.files.image && req.files.image[0];
    const thumb = req.files && req.files.thumb && req.files.thumb[0];
    const qrcode = req.files && req.files.qrcode && req.files.qrcode[0];
    if (!image) return res.status(400).json({ error: '请上传作品封面 / 截图' });
    if (!title) return res.status(400).json({ error: '标题为必填项' });

    let linkVal = String(link || '').trim();
    if (linkVal && !/^https?:\/\//i.test(linkVal)) linkVal = 'https://' + linkVal;

    // 按形态的多个链接（多平台应用：iOS/Android/macOS… 各填各的）
    const linksMap = normLinksMap(req.body.links, types);
    if (!linkVal && linksMap) linkVal = linksMap.Web || Object.values(linksMap)[0];

    const typeErr = validateTypeRequired(types, linkVal, qrcode ? qrcode.filename : '');
    if (typeErr) return res.status(400).json({ error: typeErr });

    const repoVal = normRepo(req.body.repo);
    if (parseOpenSource(req.body.openSource) === true && !repoVal)
      return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });
    if (repoVal && !repoHostAllowed(repoVal))
      return res.status(400).json({ error: repoRejectMsg() });

    const anon = ['1', 'true', true].includes(req.body.anonymous);
    // 署名能对上站内账号就直接绑定归属：这样"指定作者"是绑账号，不是只写一个名字
    const authorName = anon ? '匿名' : String(author || '管理员').slice(0, 50);
    const authorAccount = anon ? null : users.find(u => u.username === authorName);
    const work = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: String(title).slice(0, 100),
      author: authorName,
      userId: authorAccount ? authorAccount.id : null,
      anonymous: anon,
      prompt: String(prompt || '').slice(0, 3000),
      category: (cats => cats[0] || DEFAULT_CATEGORIES[0])(parseCats(req.body.categories)),
      categories: (cats => cats.length ? cats : [DEFAULT_CATEGORIES[0]])(parseCats(req.body.categories)),
      type: types[0],
      types: types,
      link: (linkVal && !onlyMini(types)) ? linkVal.slice(0, 500) : '',
      site: normSite(req.body.site),
      image: '/uploads/' + image.filename,
      thumb: thumb ? '/uploads/' + thumb.filename : '/uploads/' + image.filename,
      qrcode: qrcode ? '/uploads/' + qrcode.filename : '',
      images: ((req.files && req.files.images) || []).slice(0, 9).map(f => '/uploads/' + f.filename),
      status: ['approved', 'pending', 'rejected'].includes(status) ? status : 'approved',
      featured: false,
      pinned: false,
      openSource: parseOpenSource(req.body.openSource),
      repo: repoVal,
      paid: parsePaid(req.body.paid) || !!parsePaidModel(req.body.paidModel),
      paidModel: (parsePaid(req.body.paid) || !!parsePaidModel(req.body.paidModel)) ? parsePaidModel(req.body.paidModel) : '',
      reports: 0,
      likes: 0,
      views: 0,
      createdAt: new Date().toISOString()
    };
    if (linksMap) work.links = linksMap;
    works.push(work);
    // 后台代建但明确指定了账号：视同投稿，按首件 200 / 后续 20 记一笔（48 小时后到账）
    const uploadReward = authorAccount ? planUploadReward(work, authorAccount, 'assign') : null;
    saveWorks();
    res.status(201).json({
      ...publicWork(work), status: work.status,
      authorBound: authorAccount ? authorAccount.username : '',
      authorPending: !authorAccount && !anon,
      uploadReward: uploadReward ? { amount: uploadReward.amount, first: uploadReward.first, readyAt: uploadReward.readyAt } : null
    });
  });
});

// 管理员编辑任意作品（可改作者、状态）
app.put('/api/admin/works/:id', requireAdmin, (req, res) => {
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const w = works.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: '作品不存在' });

    const { title, prompt, category, link, type, author, status } = req.body;
    // 形态必填校验：按「改动后的预期状态」校验，通过后才动字段与文件
    const nextTypes = (req.body.types !== undefined || type) ? normalizeTypes(req.body.types || type) : typesOf(w);
    // 按形态的多个链接：请求里带了就更新，没带就沿用已有
    let linksMap;
    if (req.body.links !== undefined) {
      linksMap = normLinksMap(req.body.links, nextTypes);
      if (linksMap) w.links = linksMap; else delete w.links;
    } else {
      linksMap = w.links || null;
    }
    const nextLink = (link !== undefined ? String(link).trim() : '')
      || (linksMap && (linksMap.Web || Object.values(linksMap)[0]))
      || (req.body.links !== undefined ? '' : (w.link || '')); // 带 links 时不再兜底旧 w.link
    const nextQr = (req.files && req.files.qrcode && req.files.qrcode[0]) ? 'new'
      : (String(req.body.removeQrcode) === '1' ? '' : (w.qrcode || ''));
    const typeErr = validateTypeRequired(nextTypes, nextLink, nextQr);
    if (typeErr) return res.status(400).json({ error: typeErr });

    if (title) w.title = String(title).slice(0, 100);
    if (prompt !== undefined) w.prompt = String(prompt).slice(0, 3000);
    if (req.body.categories !== undefined) {
      const cats = parseCats(req.body.categories);
      if (cats.length) { w.categories = cats; w.category = cats[0]; }
    } else if (category && categories.includes(category)) {
      w.category = category;
      if (Array.isArray(w.categories) && w.categories.length) w.categories = [category, ...w.categories.slice(1)];
    }
    if (req.body.types !== undefined || type) applyTypes(w, normalizeTypes(req.body.types || type));
    if (author) {
      const nextAuthor = String(author).slice(0, 50);
      // 编辑框里把「匿名」改成真实作者名 → 视为取消匿名（账号归属一并还原）
      if (w.anonymous && nextAuthor !== w.author) {
        if (w.ownerReal && users.some(u => u.id === w.ownerReal)) w.userId = w.ownerReal;
        delete w.ownerReal;
        delete w.authorReal;
        delete w.anonymous;
        w.author = nextAuthor;
      } else if (!w.anonymous && nextAuthor !== w.author) {
        // 非匿名作品改署名：先按新名字重新落归属（见下面统一对齐），改不回账号就是「无主」
        w.author = nextAuthor;
        w.userId = null;
      }
      // 署名 ⇄ 账号对齐：名字能对上站内账号就绑定归属，否则保持无主。
      // 归属只认 userId —— 光改一个名字不会把作品"送"给以后注册同名的人。
      if (!w.anonymous) {
        const acc = users.find(u => u.username === w.author);
        if (acc) w.userId = acc.id;
      }
    }
    // 后台编辑器里的「匿名发布」开关：保存时同步匿名态（与专门的 /anonymous 接口逻辑一致）
    if (req.body.anonymous !== undefined) {
      const anon = ['1', 'true', true].includes(req.body.anonymous);
      if (anon && !w.anonymous) {
        w.authorReal = (w.author && w.author !== '匿名') ? String(w.author).slice(0, 50) : '';
        w.ownerReal = w.userId || '';
        w.author = '匿名';
        w.anonymous = true;
        w.userId = null;
      } else if (!anon && w.anonymous) {
        w.author = w.authorReal ? w.authorReal : '管理员';
        if (w.ownerReal && users.some(u => u.id === w.ownerReal)) w.userId = w.ownerReal;
        delete w.anonymous; delete w.authorReal; delete w.ownerReal;
      }
    }
    // 后台编辑把作品绑到某个账号名下（改署名对上账号 / 匿名翻实名）也算「视同投稿」：
    // 当场记一笔上传奖励计划，别等到下次重启才被存量补齐悄悄发放
    let uploadPlanned = null;
    if (w.userId && !w.uploadReward && !w.anonymous && stageOf(w) === 'live') {
      uploadPlanned = planUploadReward(w, users.find(u => u.id === w.userId), 'assign');
    }
    if (status && ['approved', 'pending', 'rejected'].includes(status)) w.status = status;
    const osWas = w.openSource;
    if (req.body.openSource !== undefined) w.openSource = parseOpenSource(req.body.openSource);
    const repoBefore = w.repo;
    if (req.body.repo !== undefined) w.repo = normRepo(req.body.repo);
    if (w.openSource === true && !w.repo) return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });
    // 只拦「这次改了仓库地址」的情况：历史上存下的非白名单链接仍可原样保存，不让人卡死
    if (w.repo && w.repo !== repoBefore && !repoHostAllowed(w.repo))
      return res.status(400).json({ error: repoRejectMsg() });
    // 方案 A：开源→闭源不自动收回奖励（已得即属作者，防刷靠 osBonusAt 不重复送），只给作者一条站内通知
    const osDowngraded = osWas === true && w.openSource === false;
    if (osDowngraded && w.userId) {
      addNotice(w.userId, {
        kind: 'system', title: '作品已改为闭源',
        text: `「${w.title}」已改为闭源。已发放的开源奖励灯火会保留，不会收回。`
      });
    }
    if (req.body.paidModel !== undefined) w.paidModel = parsePaidModel(req.body.paidModel);
    if (req.body.paid !== undefined) w.paid = parsePaid(req.body.paid);
    else if (w.paidModel && !w.paid) w.paid = true; // 只传了收费形式且原为免费 → 视为标注付费
    if (!w.paid) w.paidModel = '';                  // 改回免费则清掉形式
    // links 字段接管后同步遗留单链接：全清空时一并清掉，否则回填/展示会"复活"
    if (req.body.links !== undefined) w.link = (linksMap && (linksMap.Web || Object.values(linksMap)[0])) || '';
    if (link !== undefined) {
      let lv = String(link).trim();
      if (lv && !/^https?:\/\//i.test(lv)) lv = 'https://' + lv;
      w.link = lv.slice(0, 500);
    }
    if (req.body.site !== undefined) w.site = normSite(req.body.site); // 官网：传了就更新（可清空）

    applyImageChanges(w, req);

    const osBonusNow = grantOpenSourceBonus(w);   // 后台改成开源（且作品已归属某账号）同样补送一次
    saveWorks();
    res.json({
      ...publicWork(w), status: w.status || 'approved', osBonus: osBonusNow, osDowngraded,
      // 让后台知道这次保存把归属落到了哪：绑上了哪个账号 / 还是无主（名字还没有账号）
      authorBound: w.userId ? ((users.find(u => u.id === w.userId) || {}).username || '') : '',
      authorPending: !w.userId && w.anonymous !== true,
      uploadReward: uploadPlanned ? { amount: uploadPlanned.amount, first: uploadPlanned.first, readyAt: uploadPlanned.readyAt } : null
    });
  });
});

// 删除作品（同时删图）
app.delete('/api/admin/works/:id', requireAdmin, (req, res) => {
  const idx = works.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '作品不存在' });
  const [removed] = works.splice(idx, 1);
  saveWorks();
  comments = comments.filter(c => c.workId !== removed.id); // 清理该作品的评论
  saveComments();
  invalidateCommentCounts();
  [removed.image, removed.thumb, removed.qrcode].concat(removed.images || []).forEach(img => {
    if (!img) return;
    const p = path.join(UPLOAD_DIR, path.basename(img));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  res.json({ ok: true });
});

// 投诉列表 / 处理
app.get('/api/admin/reports', requireAdmin, (req, res) => res.json(reports.slice().reverse()));
app.post('/api/admin/reports/:id/resolve', requireAdmin, (req, res) => {
  const r = reports.find(x => x.id === req.params.id) || reports[Number(req.params.id)];
  if (!r) return res.status(404).json({ error: '投诉不存在' });
  r.status = '已处理';
  saveReports();
  res.json({ ok: true });
});

// 投诉处理：下架作品并站内通知作者原因
app.post('/api/admin/reports/:id/takedown', requireAdmin, (req, res) => {
  const r = reports.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '投诉不存在' });
  const w = works.find(x => x.id === r.workId);
  if (!w) return res.status(404).json({ error: '作品不存在或已删除' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
  const reason = note || `${r.reason}${r.description ? '：' + r.description : ''}`;
  w.status = 'rejected';
  w.hidden = false;
  w.offlineReason = reason;
  w.offlineAt = new Date().toISOString();
  saveWorks();
  r.status = '已处理';
  r.action = 'takedown';
  r.note = reason;
  r.handledAt = new Date().toISOString();
  saveReports();
  if (w.userId) {
    addNotice(w.userId, {
      kind: 'system',
      title: `「${w.title}」已被下架`,
      text: `原因：${reason}。修改内容后重新提交，审核通过即可恢复展示；如有异议可通过页面底部「意见建议」联系我们。`
    });
  }
  res.json({ ok: true });
});

// 意见反馈管理（每条都带完整往来记录，后台直接在里面回复）
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const list = feedback.slice().sort(fbSort).map(f => ({
    id: f.id,
    type: f.type,
    content: f.content,
    contact: f.contact || '',
    username: f.username || '',
    userId: f.userId || '',
    status: f.status,
    createdAt: f.createdAt,
    lastAt: fbLastAt(f),
    page: f.page || '',
    thread: fbThread(f),
    // 对方是否有账号：有账号才会推站内消息（游客只能等他回到「我的反馈」）
    canNotify: !!f.userId,
    // 有没有回信通道：改版前的老反馈既没账号也没本机凭证，回了对方也看不到
    canReply: !!(f.userId || f.token)
  }));
  // 后台看一眼就算读过（红点靠 status 待查看，不靠逐条未读）
  res.json(list);
});
app.post('/api/admin/feedback/:id/reply', requireAdmin, (req, res) => {
  const f = feedback.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '反馈不存在' });
  if (!f.userId && !f.token) return res.status(400).json({ error: '这条是改版前的老反馈，没有回信通道（可用联系方式直接联系）' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: '回复内容不能为空' });
  const now = new Date().toISOString();
  fbThread(f).forEach(m => { if (m.from === 'user') m.read = true; });  // 回复即视为看过
  fbThread(f).push({ from: 'admin', fromName: '管理员', text, at: now, read: false });
  f.status = '已处理';
  f.lastAt = now;
  saveFeedback();
  if (f.userId) pushFeedbackNotice(f, text);
  res.json({ ok: true, thread: fbThread(f) });
});
app.post('/api/admin/feedback/:id/status', requireAdmin, (req, res) => {
  const f = feedback.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '反馈不存在' });
  f.status = req.body && req.body.status === '待查看' ? '待查看' : '已处理';
  saveFeedback();
  res.json({ ok: true });
});
app.delete('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  const before = feedback.length;
  const gone = feedback.filter(x => x.id === req.params.id);
  feedback = feedback.filter(x => x.id !== req.params.id);
  if (feedback.length === before) return res.status(404).json({ error: '反馈不存在' });
  // 会话消息跟着删掉，免得铃铛里点进去是空壳
  if (gone.length) {
    const ids = new Set(gone.map(f => f.id));
    const keep = notices.filter(n => !ids.has(n.feedbackId));
    if (keep.length !== notices.length) { notices = keep; saveNotices(); }
  }
  saveFeedback();
  res.json({ ok: true });
});

// 分类管理
app.get('/api/admin/categories', requireAdmin, (req, res) => {
  const counts = {};
  works.forEach(w => catsOf(w).forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  res.json(orderedCategories().map(name => ({ name, count: counts[name] || 0 })));
});
app.post('/api/admin/categories/reorder', requireAdmin, (req, res) => {
  const names = Array.isArray(req.body && req.body.names) ? req.body.names.map(String) : null;
  if (!names) return res.status(400).json({ error: '缺少排序列表' });
  const known = new Set(categories);
  const next = names.filter(n => known.has(n));
  categories.forEach(c => { if (!next.includes(c)) next.push(c); }); // 漏掉的保持原相对顺序补到末尾
  categories = next;
  saveCategories();
  res.json(orderedCategories().map(name => ({ name })));
});
// 改名：作品里存的是分类名（category 单值 / categories 数组），不是 id，
// 所以改名必须把已发布作品的分类一起迁过去，否则那些作品会掉出这个分类。
app.post('/api/admin/categories/:name/rename', requireAdmin, (req, res) => {
  const oldName = decodeURIComponent(req.params.name);
  const name = String((req.body || {}).name || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '分类名不能为空' });
  if (name === oldName) return res.json({ ok: true, categories: orderedCategories(), moved: 0 });
  const idx = categories.indexOf(oldName);
  if (idx === -1) return res.status(404).json({ error: '分类不存在' });
  if (categories.includes(name)) return res.status(400).json({ error: '已经有同名分类了' });
  categories[idx] = name;   // 原位替换，顺序不变
  let moved = 0;
  works.forEach(w => {
    let hit = false;
    if (w.category === oldName) { w.category = name; hit = true; }
    if (Array.isArray(w.categories) && w.categories.includes(oldName)) {
      w.categories = w.categories.map(c => (c === oldName ? name : c));
      hit = true;
    }
    if (hit) moved++;
  });
  if (moved) saveWorks();
  saveCategories();
  res.json({ ok: true, categories: orderedCategories(), moved });
});
app.delete('/api/admin/categories/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const before = categories.length;
  categories = categories.filter(c => c !== name);
  if (categories.length === before) return res.status(404).json({ error: '分类不存在' });
  saveCategories();
  res.json({ ok: true, categories: orderedCategories() });
});

// 友情链接
app.get('/api/friends', (req, res) => res.json(friends));
app.get('/api/admin/friends', requireAdmin, (req, res) => res.json(friends));
app.post('/api/admin/friends', requireAdmin, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const url = String((req.body || {}).url || '').trim();
  if (!name || name.length > 20) return res.status(400).json({ error: '名称需 1-20 字' });
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: '链接需以 http(s):// 开头' });
  if (url.length > 500) return res.status(400).json({ error: '链接过长' });
  if (friends.length >= 50) return res.status(400).json({ error: '友情链接最多 50 条' });
  if (friends.some(f => f.url === url)) return res.status(400).json({ error: '该链接已存在' });
  friends.push({ name, url });
  saveFriends();
  res.status(201).json({ ok: true });
});
app.post('/api/admin/friends/reorder', requireAdmin, (req, res) => {
  const urls = Array.isArray(req.body && req.body.urls) ? req.body.urls.map(String) : null;
  if (!urls) return res.status(400).json({ error: '缺少排序列表' });
  const known = new Map(friends.map(f => [f.url, f]));
  const next = urls.map(u => known.get(u)).filter(Boolean);
  if (next.length !== friends.length) return res.status(400).json({ error: '顺序数据不完整，请刷新后重试' });
  friends = next;
  saveFriends();
  res.json({ ok: true });
});
app.post('/api/admin/friends/delete', requireAdmin, (req, res) => {
  const url = String((req.body || {}).url || '');
  const i = friends.findIndex(f => f.url === url);
  if (i === -1) return res.status(404).json({ error: '链接不存在' });
  friends.splice(i, 1);
  saveFriends();
  res.json({ ok: true });
});

// 形态管理
app.get('/api/admin/types', requireAdmin, (req, res) => {
  const counts = {};
  works.forEach(w => typesOf(w).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  res.json(workTypes.map(t => ({ name: t.name, icon: t.icon, svg: t.svg || '', count: counts[t.name] || 0 })));
});
app.post('/api/admin/types', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().replace(/[<>]/g, '').slice(0, 10);
  const icon = String((req.body && req.body.icon) || '').trim().slice(0, 4);
  const svg = String((req.body && req.body.svg) || '').trim();
  if (!name) return res.status(400).json({ error: '形态名不能为空' });
  if (svg && !TYPE_ICON_KEYS.includes(svg)) return res.status(400).json({ error: '图标不存在，请从图标库里选' });
  // 只和当前形态列表比：ALL_TYPES_LEGACY 里带着「游戏」等历史名称，拿它判断会让「游戏」永远加不进来
  if (workTypes.some(t => t.name === name)) return res.status(400).json({ error: '该形态已存在' });
  workTypes.push({ name, icon: icon || '✨', svg: svg || '' });
  saveTypes(); syncWorkTypes();
  res.status(201).json(workTypes);
});
app.post('/api/admin/types/reorder', requireAdmin, (req, res) => {
  const names = Array.isArray(req.body && req.body.names) ? req.body.names.map(String) : null;
  if (!names) return res.status(400).json({ error: '缺少排序列表' });
  const map = new Map(workTypes.map(t => [t.name, t]));
  const next = names.map(n => map.get(n)).filter(Boolean);
  workTypes.forEach(t => { if (names.indexOf(t.name) === -1) next.push(t); });
  workTypes = next;
  saveTypes(); syncWorkTypes();
  res.json(workTypes);
});
app.delete('/api/admin/types/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (name === 'Web') return res.status(400).json({ error: '「Web」是默认形态，不能删除' });
  const used = works.filter(w => typesOf(w).includes(name)).length;
  if (used) return res.status(400).json({ error: `还有 ${used} 件作品在用「${name}」，先改成其他形态再删` });
  const before = workTypes.length;
  workTypes = workTypes.filter(t => t.name !== name);
  if (workTypes.length === before) return res.status(404).json({ error: '形态不存在' });
  saveTypes(); syncWorkTypes();
  res.json(workTypes);
});

// 推荐位管理
app.get('/api/admin/tools', requireAdmin, (req, res) => res.json(tools));
app.post('/api/admin/tools', requireAdmin, (req, res) => {
  const { name, desc, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: '名称和链接必填' });
  tools.push({ id: Date.now().toString(36), name: String(name).slice(0, 40), desc: String(desc || '').slice(0, 120), url: String(url).slice(0, 300), active: true });
  saveTools();
  res.status(201).json(tools);
});
app.delete('/api/admin/tools/:id', requireAdmin, (req, res) => {
  tools = tools.filter(t => t.id !== req.params.id);
  saveTools();
  res.json({ ok: true });
});

// ---------- 广告位管理 ----------
// 同一广告位可以挂多支广告，sort 决定先后（前台按 sort 顺序轮流播放）
function adsOfSlot(slot) {
  return ads.filter(a => a.slot === slot)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}
function renumberAds(slot) {
  adsOfSlot(slot).forEach((a, i) => { a.sort = i; });
}
function adPayload(body, fallbackKind) {
  const rawKind = String(body.kind || '').toLowerCase();
  return {
    slot: String(body.slot || ''),
    // 图文 / 纯文字；没传就沿用原来的（新建默认图文）
    kind: rawKind === 'text' ? 'text' : (rawKind === 'image' ? 'image' : (fallbackKind || 'image')),
    title: String(body.title || '').trim().slice(0, 60),
    desc: String(body.desc || '').trim().slice(0, 120),
    url: adUrlOf(body.url),
    cta: String(body.cta || '').trim().slice(0, 20),
    active: String(body.active) !== '0'
  };
}
function adListJson() {
  return {
    slots: AD_SLOTS,
    ads: ads.slice().sort((a, b) => AD_SLOT_KEYS.indexOf(a.slot) - AD_SLOT_KEYS.indexOf(b.slot)
      || (a.sort || 0) - (b.sort || 0))
      .map(a => {
        const st = adStatsOf(a.id);
        const clicks = a.clicks || 0;
        const base = { ...a, stats: { ...st, clicks, ctr: st.pv ? clicks / st.pv * 100 : 0 } };
        // 积分兑换来的广告：带上投放人 / 剩余曝光，后台一眼能看出是谁在占位
        if (a.source === 'redeem') {
          const u = users.find(x => x.id === a.ownerId);
          base.ownerName = u ? displayNameOf(u.username) : '（账号已注销）';
          base.budgetLeft = Math.max(0, a.budget || 0);
          // 计费口径：兑换单里真正扣掉额度的部分。PV / 点击里含防刷超额后的免费流量，两者不能混着算
          const r = redemptions.find(x => x.id === a.redemptionId);
          if (r) {
            const billedViews = r.status === 'active'
              ? Math.max(0, (r.views || 0) - (a.budget || 0)) : (r.used || 0);
            base.billed = {
              views: billedViews, viewsTotal: r.views || 0,
              clicks: Math.max(0, (r.clicks || 0) - (a.clickLeft || 0)), clicksTotal: r.clicks || 0
            };
          }
        }
        return base;
      })
  };
}

app.get('/api/admin/ads', requireAdmin, (req, res) => res.json(adListJson()));

app.post('/api/admin/ads', requireAdmin, (req, res) => {
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const p = adPayload(req.body || {}, 'image');
    if (!AD_SLOT_KEYS.includes(p.slot)) return res.status(400).json({ error: '请选择投放的广告位' });
    if (!p.url) return res.status(400).json({ error: '跳转链接必填' });
    const img = req.files && req.files.image && req.files.image[0];
    if (p.kind === 'text' && !p.title) return res.status(400).json({ error: '纯文字广告必须填标题' });
    if (!p.title && !img) return res.status(400).json({ error: '标题和图片至少填一个' });
    if (p.kind === 'text' && img) removeUpload('/uploads/' + img.filename);   // 纯文字不存图
    const ad = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ...p,
      // 纯文字广告不存图
      image: (p.kind !== 'text' && img) ? '/uploads/' + img.filename : '',
      sort: adsOfSlot(p.slot).length,
      clicks: 0,
      createdAt: new Date().toISOString()
    };
    ads.push(ad);
    saveAds();
    res.status(201).json(adListJson());
  });
});

app.put('/api/admin/ads/:id', requireAdmin, (req, res) => {
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const a = ads.find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: '广告不存在' });
    const p = adPayload(req.body || {}, a.kind || (a.image ? 'image' : 'text'));
    if (!AD_SLOT_KEYS.includes(p.slot)) return res.status(400).json({ error: '请选择投放的广告位' });
    if (!p.url) return res.status(400).json({ error: '跳转链接必填' });
    const img = req.files && req.files.image && req.files.image[0];
    const removeImg = String(req.body && req.body.removeImage) === '1';
    const oldImage = a.image || '';
    const wantText = p.kind === 'text';
    // 纯文字形式不留图片：切成文字时旧图直接清掉；误传的新图也不要
    if (wantText && img) removeUpload('/uploads/' + img.filename);
    const nextImage = wantText ? '' : (img ? '/uploads/' + img.filename : (removeImg ? '' : oldImage));
    if (wantText && !p.title) return res.status(400).json({ error: '纯文字广告必须填标题' });
    if (!p.title && !nextImage) return res.status(400).json({ error: '标题和图片至少填一个' });

    const slotChanged = a.slot !== p.slot;
    Object.assign(a, p);                 // 注意：p 里没有 image，图片单独处理
    if (slotChanged) a.sort = adsOfSlot(p.slot).filter(x => x.id !== a.id).length;
    if (nextImage !== oldImage) {
      a.image = nextImage;
      removeUpload(oldImage);            // 换图/删图后再清理旧文件
    }
    if (slotChanged) renumberAds(a.slot);
    saveAds();
    res.json(adListJson());
  });
});

app.post('/api/admin/ads/:id/toggle', requireAdmin, (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  a.active = a.active === false;
  saveAds();
  res.json(adListJson());
});

// 同一位内上移 / 下移
app.post('/api/admin/ads/:id/move', requireAdmin, (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  const dir = (req.body && req.body.dir) === 'down' ? 1 : -1;
  const list = adsOfSlot(a.slot);
  const i = list.findIndex(x => x.id === a.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return res.json(adListJson());
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((x, k) => { x.sort = k; });
  saveAds();
  res.json(adListJson());
});

app.delete('/api/admin/ads/:id', requireAdmin, (req, res) => {
  const idx = ads.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '广告不存在' });
  const [removed] = ads.splice(idx, 1);
  removeUpload(removed.image);
  renumberAds(removed.slot);
  // 清掉已删广告的 PV/UV 明细，不让统计文件无限膨胀
  Object.keys(adStats).forEach(d => { if (adStats[d]) delete adStats[d][removed.id]; });
  scheduleAdStatsSave();
  // 积分兑换的广告被后台下架：剩下的曝光次数折算成积分退回用户
  if (removed.source === 'redeem' && removed.redemptionId) {
    const r = redemptions.find(x => x.id === removed.redemptionId);
    if (r && r.status === 'active') refundRedemption(r, 'removed');
  }
  saveAds();
  res.json(adListJson());
});


// 认证创作者
// 认证是按账号名（username）匹配的：作品的 author 存的就是 username。
// 后台输入昵称时先归一化成账号名，避免「认证了但 ✔ 不显示」。
function creatorAccountOf(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const byName = users.find(u => u.username === s);
  if (byName) return byName;
  // 昵称可以重名：只有唯一命中才认，否则宁可让后台提示「找不到账号」
  const byNick = users.filter(u => (u.nickname || '').toLowerCase() === s.toLowerCase());
  return byNick.length === 1 ? byNick[0] : null;
}
app.get('/api/admin/creators', requireAdmin, (req, res) => {
  // hasAccount=false：这条认证找不到对应账号，✔ 挂了但作者收不到通知
  res.json(creators.map(c => ({ ...c, hasAccount: !!creatorAccountOf(c.name) })));
});
app.post('/api/admin/creators', requireAdmin, (req, res) => {
  const { name, bio } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: '创作者名称必填' });
  const account = creatorAccountOf(name);
  const target = String(account ? account.username : name).trim().slice(0, 50);
  const existing = creators.find(c => c.name === target);
  const isNew = !existing;
  if (isNew) creators.push({ name: target, bio: String(bio || '').slice(0, 200) });
  else if (bio !== undefined) existing.bio = String(bio || '').slice(0, 200);
  writeJSON('creators.json', creators);
  // 认证成功给作者发一条站内消息：铃铛未读 + 1，60 秒轮询内会主动弹出提示
  let notified = false;
  if (isNew && account) {
    const bioText = String(bio || '').trim().slice(0, 100);
    addNotice(account.id, {
      kind: 'system',
      title: '你已成为认证创作者 ✔',
      text: '你的作品卡片、详情页和作者主页现在会显示 ✔ 认证标识。' +
        (bioText ? `认证简介：${bioText}` : '')
    });
    notified = true;
  }
  res.status(201).json({
    ok: true, creators, notified,
    username: account ? account.username : '',
    unknown: !account
  });
});
app.delete('/api/admin/creators/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const removed = creators.find(c => c.name === name);
  creators = creators.filter(c => c.name !== name);
  writeJSON('creators.json', creators);
  // 取消认证也告知本人，避免 ✔ 突然消失让作者莫名其妙
  let notified = false;
  const account = removed ? creatorAccountOf(name) : null;
  if (account) {
    addNotice(account.id, {
      kind: 'system',
      title: '认证创作者标识已取消',
      text: '你的作品和作者主页不再显示 ✔ 认证标识。如有疑问可以直接联系站长。'
    });
    notified = true;
  }
  res.json({ ok: true, notified });
});

// ---- 用户管理：账号 / 昵称 / 灯火 / 作品数 / 是否认证作者 ----
// 按最近活跃排序 + 分页（每页 20 条）；q 走服务端搜索
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const src = normFrKey(req.query.src);   // 按来源渠道筛：链接来的和兑换码来的都在这里
  const pageSize = 20;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  // 同 IP 疑似同一用户：按注册 IP（regIp）聚类，管理后台标记用（只读展示，不写数据）
  const regIpNames = {};
  users.forEach(u => { if (u.regIp) (regIpNames[u.regIp] = regIpNames[u.regIp] || []).push(u.username); });
  let list = users.map(u => {
    const c = creators.find(x => x.name === u.username);
    return {
      id: u.id,
      username: u.username,
      name: displayNameOf(u.username),
      points: shareStatsOf(u.id).points,
      createdAt: u.createdAt,
      lastActiveAt: u.lastActiveAt || null,
      consumed: (() => { const c = consumedLightsOf(u.id); return { total: c.consumed, promo: c.promoSpent, tip: c.tippedOut }; })(),
      works: works.filter(w => w.userId === u.id).length,
      verified: !!c,
      isOwner: isSiteOwner(u),   // 站长：屏蔽作品时按 3 分计（首页最新降权用）
      blockedCount: Array.isArray(u.blocked) ? u.blocked.length : 0,
      tags: Array.isArray(u.tags) ? u.tags : [],
      acqFr: u.acqFr || '',
      acqFrName: u.acqFr ? frNameOf(u.acqFr) : '',
      regFrom: u.regFrom || '',
      acqAt: u.acqAt || '',
      sameIp: (u.regIp && regIpNames[u.regIp] || []).filter(n => n !== u.username),
      bio: c ? String(c.bio || '') : ''
    };
  });
  if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  if (src) list = list.filter(u => u.acqFr === src);
  // 最近活跃的排前面（没活跃记录的按注册时间垫底）
  list.sort((a, b) => {
    const ta = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
    const tb = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  const total = list.length;
  const users2 = list.slice((page - 1) * pageSize, page * pageSize);
  res.json({ users: users2, total, page, pageSize });
});

// ---- 作者标签：后台给任意用户贴/摘标签；标签库支持新增、改名（改名同步所有人身上的标签） ----
app.post('/api/admin/users/tags', requireAdmin, (req, res) => {
  const u = users.find(x => x.id === String((req.body && req.body.id) || ''));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const next = sanitizeTags(req.body && req.body.tags);
  const old = Array.isArray(u.tags) ? u.tags : [];
  const added = next.filter(t => !old.includes(t));
  const removed = old.filter(t => !next.includes(t));
  u.tags = next;
  saveUsers();
  // 贴标签 → 写进造梦编年史（公开荣誉，不涉数量）。
  // 编年史记「第一次」不记流水：每个标签只记**第一个**获得的人，
  // 之后别人再得到同名标签，只发本人站内消息，不再上公开页（荣誉徽章本身照常发放）。
  const chronSeenTags = new Set(chronicle.map(e => String(e.tag || '')).filter(Boolean));
  added.forEach(t => {
    if (chronSeenTags.has(t)) return;
    chronSeenTags.add(t);
    addChronicleEvent({
      kind: 'tag', userId: u.id, username: u.username,
      name: displayNameOf(u.username), tag: t
    });
  });
  // 变动都通知本人（和认证开关一个口径），不带积分数字
  if (added.length) addNotice(u.id, { kind: 'system', title: `获得新标签：${added.join('、')}`, text: '管理员给你的账号加上了荣誉标签，会展示在你的作品卡片和作者主页上。' });
  if (removed.length) addNotice(u.id, { kind: 'system', title: `标签已移除：${removed.join('、')}`, text: '管理员移除了你账号上的部分标签。' });
  res.json({ ok: true, tags: u.tags });
});

app.get('/api/admin/taglib', requireAdmin, (req, res) => res.json(taglib));

app.post('/api/admin/taglib', requireAdmin, (req, res) => { // 新增标签
  const s = String((req.body && req.body.name) || '').trim().slice(0, 20);
  if (!s) return res.status(400).json({ error: '标签名不能为空' });
  if (!taglib.includes(s)) { taglib.push(s); saveTaglib(); }
  res.json(taglib);
});

app.post('/api/admin/taglib/rename', requireAdmin, (req, res) => { // 改名：标签库 + 所有人身上的标签一起改
  const from = String((req.body && req.body.from) || '').trim();
  const to = String((req.body && req.body.to) || '').trim().slice(0, 20);
  if (!from || !to) return res.status(400).json({ error: '参数不完整' });
  if (!taglib.includes(from)) return res.status(404).json({ error: '标签不存在' });
  if (to !== from && taglib.includes(to)) return res.status(400).json({ error: '标签库里已有同名标签' });
  taglib = taglib.map(t => (t === from ? to : t));
  saveTaglib();
  let changed = 0;
  for (const u of users) {
    if (Array.isArray(u.tags) && u.tags.includes(from)) {
      u.tags = u.tags.map(t => (t === from ? to : t));
      changed++;
    }
  }
  if (changed) saveUsers();
  res.json({ ok: true, taglib, changed });
});

app.post('/api/admin/taglib/delete', requireAdmin, (req, res) => { // 删除标签：从库和所有用户身上摘掉
  const name = String((req.body && req.body.name) || '').trim();
  if (!taglib.includes(name)) return res.status(404).json({ error: '标签不存在' });
  taglib = taglib.filter(t => t !== name);
  saveTaglib();
  let changed = 0;
  for (const u of users) {
    if (Array.isArray(u.tags) && u.tags.includes(name)) {
      u.tags = u.tags.filter(t => t !== name);
      changed++;
    }
  }
  if (changed) saveUsers();
  res.json({ ok: true, taglib, changed });
});

// ---- 管理员送灯火 / 扣灯火（delta 可负，账本统一走 addPoints）----
app.post('/api/admin/points', requireAdmin, (req, res) => {
  const { userId, delta, note } = req.body || {};
  const u = users.find(x => x.id === String(userId || ''));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const d = parseInt(delta, 10);
  if (!Number.isFinite(d) || d === 0) return res.status(400).json({ error: '分值必须是 非0 整数' });
  if (Math.abs(d) > 100000) return res.status(400).json({ error: '单次最多 ±100000 盏灯火' });
  const points = addPoints(u.id, d, 'admin');
  const noteText = String(note || '').trim().slice(0, 100);
  // 标准化原因（站长之后会在后台先选原因再送）：像「提供优质建议」「元老认证」这类短语，
  // 编年史只展示 reason；note 仍是自由备注（可写聊天内容），不上公开页
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 30);
  // 送灯火（激励）→ 写进造梦编年史；送了多少保密，页面只显示「神秘灯火」。
  // 编年史记「第一次」不记流水，两条都满足才上公开页，否则只发站内消息：
  //   ① 这次鼓励同时贴了「编年史上还没出现过的标签」（= 这个标签的第一位获得者），
  //      会和标签事件同天并成一行「@X 被授予「新标签」荣誉勋章，获得站长神秘灯火」；
  //      纯送灯火、以及贴的是老标签的鼓励，都不再上公开页。
  //   ② 每位用户最多记录一次获赠灯火（chronTags 由后台「一键激励」传本次新增的标签）。
  const chronTags = Array.isArray((req.body || {}).chronTags)
    ? req.body.chronTags.map(t => String(t || '').trim().slice(0, 20)).filter(Boolean)
    : [];
  const chronSeenTags = new Set(chronicle.map(e => String(e.tag || '')).filter(Boolean));
  const firstTag = chronTags.find(t => !chronSeenTags.has(t)) || '';
  if (d > 0 && firstTag && !chronicle.some(e => e.kind === 'points' && e.userId === u.id)) {
    addChronicleEvent({
      kind: 'points', userId: u.id, username: u.username,
      name: displayNameOf(u.username), tag: firstTag, points: d, note: noteText, reason
    });
  }
  // 给用户发一条站内消息：登录后顶部铃铛能看到，也能解释积分从哪来的
  addNotice(u.id, {
    kind: 'points',
    title: d > 0 ? `灯火到账 +${d} 盏` : `灯火调整 ${d} 盏`,
    text: (d > 0 ? `管理员为你点亮了 ${d} 盏灯火` : `管理员调整了你的灯火：${d} 盏`) +
      (noteText ? `：${noteText}` : '') + `，当前余额 ${points} 盏。`,
    points, delta: d
  });
  res.json({
    ok: true,
    username: u.username,
    name: displayNameOf(u.username),
    delta: d,
    points,
    note: noteText
  });
});

// ---- 群发通知：给「有作品的用户」（或全部用户）发一条站内消息 ----
// 场景：站内新增了展位/功能，想让创作者们知道（例：最近多了 xx 展位，可以用灯火把作品挂上去）。
// 走铃铛站内消息，默认只发给有作品的人，不打扰围观的路人。
app.get('/api/admin/broadcast/count', requireAdmin, (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'with-works';
  const targets = scope === 'all'
    ? users
    : users.filter(u => works.some(w => w.userId === u.id));
  res.json({ count: targets.length, scope });
});
app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { title, text, scope, guest, key } = req.body || {};
  const t = String(title || '').trim().slice(0, 60);
  const body = String(text || '').trim().slice(0, 300);
  if (!t && !body) return res.status(400).json({ error: '标题和正文至少填一个' });
  // 去重：管理员没填 key 时，用「标题+正文」的稳定哈希当 key ——
  // 同样的文案重复点发送，站内消息会被 buildNotice 的 key 去重挡掉（不进铃铛），
  // 游客公告条按同 key upsert（重发=更新置顶，不会多挂一条）；改了文案才算新公告。
  const dedupKey = String(key || '').trim()
    || 'bc-' + crypto.createHash('sha1').update(t + '\n' + body).digest('hex').slice(0, 12);
  const targets = scope === 'all'
    ? users.slice()
    : users.filter(u => works.some(w => w.userId === u.id));
  // 群发属于「站方公告」（announce）：屏蔽了提示的用户照收，只是不弹窗
  let sent = 0;
  targets.forEach(u => { if (addNotice(u.id, {
    kind: 'announce',
    key: dedupKey,
    title: t || '站内通知',
    text: body
  })) sent++; });
  // 勾了「游客也可见」：同一条文案再挂到游客公告条（未登录访客的顶部横幅）
  let guestItem = null;
  if (guest) guestItem = upsertGuestNotice({ key: dedupKey, title: t || '站内通知', text: body });
  res.json({
    ok: true, sent,
    deduped: targets.length - sent,   // 本次因 key 撞车被跳过的人数
    scope: scope === 'all' ? 'all' : 'with-works',
    guest: !!guestItem
  });
});

// ---- 游客公告条：未登录访客也能看到的全站公告（后台管理） ----
app.get('/api/admin/guest-notice', requireAdmin, (req, res) => {
  res.json({ items: guestNotices });
});
app.post('/api/admin/guest-notice', requireAdmin, (req, res) => {
  const { title, text, link, key } = req.body || {};
  const t = String(title || '').trim();
  const body = String(text || '').trim();
  if (!t && !body) return res.status(400).json({ error: '标题和正文至少填一个' });
  const item = upsertGuestNotice({ key, title: t, text: body, link });
  res.json({ ok: true, item });
});
app.delete('/api/admin/guest-notice/:id', requireAdmin, (req, res) => {
  const before = guestNotices.length;
  guestNotices = guestNotices.filter(n => n.id !== req.params.id);
  if (guestNotices.length === before) return res.status(404).json({ error: '公告不存在或已下架' });
  saveGuestNotices();
  res.json({ ok: true });
});

// ---- 游客公告条：公开读取（不需要登录，首页顶部横幅的数据源） ----
app.get('/api/guest-notices', (req, res) => {
  const items = guestNotices
    .filter(n => n && n.active !== false)
    .slice(0, 3)                      // 最多同时挂 3 条，前端取第一条没被关掉的展示
    .map(n => ({ key: n.key, title: n.title, text: n.text, link: n.link }));
  res.set('Cache-Control', 'no-store');
  res.json({ items });
});

// ---------- 活动兑换码：码 → 送灯火 ----------
// 场景：做活动时后台生成一批码（或一个公开口令），用户在前台输入即可领灯火。
// 结构 gift-codes.json：
//   { activities: [{ id, name, points, mode:'batch'|'public', perUser, expiresAt:'YYYY-MM-DD'|'', active, note, createdAt }],
//     codes: [{ code, activityId, maxUses, usedBy:[{ uid, at }], createdAt }] }
let giftStore = readJSON('gift-codes.json', null);
if (!giftStore || typeof giftStore !== 'object') giftStore = {};
if (!Array.isArray(giftStore.activities)) giftStore.activities = [];
if (!Array.isArray(giftStore.codes)) giftStore.codes = [];
let giftSaveTimer = null;
function saveGiftSoon() {
  if (giftSaveTimer) return;
  giftSaveTimer = setTimeout(() => {
    giftSaveTimer = null;
    writeJSON('gift-codes.json', giftStore);
  }, 500);
}
// 去掉空格/连字符并转大写：用户粘「DM-ABCD-EFGH」或「dmabcdefgh」都能兑
function normGiftCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// 生成 XX-XXXX-XXXX，去掉易混淆的 I O 0 1；前缀是渠道（VX=V2EX / GZ=公众号），没配渠道用 DM
const GIFT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newGiftCode(prefix) {
  const pre = /^[A-Z0-9]{2}$/.test(String(prefix || '')) ? prefix : 'DM';
  const pick = () => GIFT_ALPHABET[crypto.randomInt(GIFT_ALPHABET.length)];
  let s;
  do {
    const body = Array.from({ length: 8 }, pick).join('');
    s = pre + '-' + body.slice(0, 4) + '-' + body.slice(4);
  } while (giftStore.codes.some(c => normGiftCode(c.code) === normGiftCode(s)));
  return s;
}
function giftActOf(id) { return giftStore.activities.find(a => a.id === id) || null; }
function giftExpired(act) {
  if (!act || !act.expiresAt) return false;
  const end = Date.parse(act.expiresAt + 'T23:59:59');
  return Number.isFinite(end) && Date.now() > end;
}
function giftStatOf(actId) {
  const list = giftStore.codes.filter(c => c.activityId === actId);
  const used = list.reduce((n, c) => n + (c.usedBy || []).length, 0);
  const quota = list.reduce((n, c) => n + (c.maxUses || 1), 0);
  return { codes: list.length, used, quota, left: Math.max(0, quota - used) };
}

// 兑换码带渠道 key（活动上配的 fr）：给用户记来源，并计入该渠道的渠道统计。
// 只记首触（acqFr 已有就不覆盖），另记最近一次（acqFrLast）；不写 user.tags ——
// tags 是公开荣誉标签，会展示在作品卡片和作者主页上，来源渠道是内部数据不该外露。
function creditFrRedeem(user, frRaw) {
  const key = normFrKey(frRaw);
  if (!key || !user) return '';
  const now = new Date().toISOString();
  if (!user.acqFr) { user.acqFr = key; user.acqAt = now; }
  user.acqFrLast = key;
  user.acqAtLast = now;
  saveUsers();
  const rec = promoVisits[key] || (promoVisits[key] = { pv: 0, uv: {}, works: {}, lastAt: '', regs: 0 });
  if (!rec.uv) rec.uv = {};
  rec.uv['u:' + user.id] = 1;   // 按 uid 去重，和链接来的人合并在同一个 UV 口径里
  rec.redeems = (rec.redeems || 0) + 1;
  rec.lastAt = now;
  schedulePromoVisitSave();
  return key;
}

// 用户兑换：登录必需（灯火要落到账号上）；同一个码每人只能兑一次，活动可再限制每人总次数
app.post('/api/gift/redeem', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '请先登录再兑换，灯火要记到你的账号上' });
  if (!rateLimit('gift:' + user.id, 10, 600000)) {
    return res.status(429).json({ error: '试得太频繁了，歇 10 分钟再来' });
  }
  const raw = String((req.body || {}).code || '').trim();
  if (!raw) return res.status(400).json({ error: '请输入兑换码' });
  const norm = normGiftCode(raw);
  if (norm.length < 4) return res.status(400).json({ error: '兑换码太短了，检查一下有没有粘全' });
  const code = giftStore.codes.find(c => normGiftCode(c.code) === norm);
  if (!code) return res.status(404).json({ error: '兑换码不存在，检查一下字符有没有输错' });
  const act = giftActOf(code.activityId);
  if (!act) return res.status(400).json({ error: '这个兑换码所属的活动已结束' });
  if (!act.active) return res.status(400).json({ error: '活动已停止兑换' });
  if (giftExpired(act)) return res.status(400).json({ error: `活动已于 ${act.expiresAt} 结束，码不能再用了` });
  const usedBy = code.usedBy || (code.usedBy = []);
  if (usedBy.some(u => u.uid === user.id)) return res.status(400).json({ error: '这个兑换码你已经兑换过了' });
  const perUser = Math.max(1, act.perUser || 1);
  const mine = giftStore.codes.filter(c => c.activityId === act.id)
    .reduce((n, c) => n + (c.usedBy || []).filter(u => u.uid === user.id).length, 0);
  if (mine >= perUser) return res.status(400).json({ error: `「${act.name}」每人最多兑 ${perUser} 次` });
  if (usedBy.length >= (code.maxUses || 1)) return res.status(400).json({ error: '这个兑换码已经被兑完了' });
  usedBy.push({ uid: user.id, at: new Date().toISOString() });
  saveGiftSoon();
  const points = addPoints(user.id, act.points, 'gift');
  // 渠道＝活动上配的 fr；没配就从码前缀认（VX-… / GZ-…）。两条路都落到用户 acqFr 上
  const channel = creditFrRedeem(user, act.fr || frOfGiftCode(code.code));
  addNotice(user.id, {
    kind: 'points',
    title: `兑换码到账 +${act.points} 盏灯火`,
    text: `你兑换了「${act.name}」的活动兑换码，${act.points} 盏灯火已到账，当前余额 ${points} 盏。`,
    points, delta: act.points
  });
  res.json({ ok: true, points, reward: act.points, activity: act.name, channel, left: Math.max(0, (code.maxUses || 1) - usedBy.length) });
});

// ---- 后台：活动列表（带兑换统计）----
app.get('/api/admin/gift', requireAdmin, (req, res) => {
  res.json(giftStore.activities.slice().reverse().map(a => ({
    ...a, frName: a.fr ? frNameOf(a.fr) : '', stat: giftStatOf(a.id), expired: giftExpired(a)
  })));
});

// ---- 后台：创建活动 + 生成码 ----
// mode=batch：生成 count 个一次性码；mode=public：1 个公开口令，最多 count 人各兑一次
app.post('/api/admin/gift', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '给活动起个名字' });
  const points = parseInt(b.points, 10);
  if (!Number.isFinite(points) || points <= 0 || points > 100000) {
    return res.status(400).json({ error: '面额需是 1–100000 的整数' });
  }
  const mode = b.mode === 'public' ? 'public' : 'batch';
  const count = parseInt(b.count, 10);
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    return res.status(400).json({ error: mode === 'public' ? '可兑人数需是 1–500' : '生成数量需是 1–500' });
  }
  const perUser = Math.max(1, Math.min(10, parseInt(b.perUser, 10) || 1));
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expiresAt || '')) ? b.expiresAt : '';
  if (expiresAt && Date.parse(expiresAt + 'T23:59:59') < Date.now()) {
    return res.status(400).json({ error: '有效期不能早于今天' });
  }
  // 渠道 key：和投放链接 ?fr= 同一套命名，兑换成功后据此给用户记来源
  const frRaw = String(b.fr || '').trim();
  const fr = frRaw ? normFrKey(frRaw) : '';
  if (frRaw && !fr) {
    return res.status(400).json({ error: '渠道 key 只能用小写字母、数字、下划线、连字符，2–24 位（如 v2ex、wechat、xhs）' });
  }
  const act = {
    id: 'ga' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    name, points, mode, perUser, expiresAt, fr,
    active: true,
    note: String(b.note || '').trim().slice(0, 100),
    createdAt: new Date().toISOString()
  };
  const made = [];
  if (mode === 'public') {
    const custom = normGiftCode(b.code);
    if (custom && custom.length < 4) return res.status(400).json({ error: '自定义口令至少 4 个字符' });
    if (custom && giftStore.codes.some(c => normGiftCode(c.code) === custom)) {
      return res.status(400).json({ error: '这个口令已经被别的活动占用了，换一个' });
    }
    const code = custom ? String(b.code).trim().toUpperCase() : newGiftCode(fr ? frShortOf(fr) : 'DM');
    giftStore.codes.push({ code, activityId: act.id, maxUses: count, usedBy: [], createdAt: act.createdAt });
    made.push(code);
  } else {
    // 批量码带上渠道前缀：VX-… 一眼能看出是 V2EX 发的，兑换时也能靠前缀认渠道
    const prefix = fr ? frShortOf(fr) : 'DM';
    for (let i = 0; i < count; i++) {
      const code = newGiftCode(prefix);
      giftStore.codes.push({ code, activityId: act.id, maxUses: 1, usedBy: [], createdAt: act.createdAt });
      made.push(code);
    }
  }
  giftStore.activities.push(act);
  saveGiftSoon();
  res.json({ ok: true, activity: act, codes: made, stat: giftStatOf(act.id) });
});

// ---- 后台：停用 / 恢复 ----
app.post('/api/admin/gift/:id/toggle', requireAdmin, (req, res) => {
  const act = giftActOf(req.params.id);
  if (!act) return res.status(404).json({ error: '活动不存在' });
  act.active = !act.active;
  saveGiftSoon();
  res.json({ ok: true, active: act.active });
});

// ---- 后台：改活动的渠道 key（建活动时填错了不用重建，已经发出去的码照旧可用）----
app.post('/api/admin/gift/:id/fr', requireAdmin, (req, res) => {
  const act = giftActOf(req.params.id);
  if (!act) return res.status(404).json({ error: '活动不存在' });
  const raw = String((req.body && req.body.fr) || '').trim();
  const fr = raw ? normFrKey(raw) : '';
  if (raw && !fr) {
    return res.status(400).json({ error: '渠道 key 只能用小写字母、数字、下划线、连字符，2–24 位' });
  }
  act.fr = fr;
  saveGiftSoon();
  res.json({ ok: true, fr, frName: fr ? frNameOf(fr) : '' });
});

// ---- 后台：删除活动（连同它的码一起删，已兑换记录保留在用户账本里）----
app.delete('/api/admin/gift/:id', requireAdmin, (req, res) => {
  const i = giftStore.activities.findIndex(a => a.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '活动不存在' });
  const [act] = giftStore.activities.splice(i, 1);
  giftStore.codes = giftStore.codes.filter(c => c.activityId !== act.id);
  saveGiftSoon();
  res.json({ ok: true });
});

// ---- 后台：某个活动的码明细（谁兑的、什么时候）----
app.get('/api/admin/gift/:id/codes', requireAdmin, (req, res) => {
  const act = giftActOf(req.params.id);
  if (!act) return res.status(404).json({ error: '活动不存在' });
  const um = new Map(users.map(u => [u.id, displayNameOf(u.username)]));
  res.json(giftStore.codes.filter(c => c.activityId === act.id).map(c => ({
    code: c.code,
    maxUses: c.maxUses || 1,
    used: (c.usedBy || []).length,
    usedBy: (c.usedBy || []).map(u => ({ name: um.get(u.uid) || '(已注销账号)', at: u.at }))
  })));
});

// ---- 认领申请审核 ----
app.get('/api/admin/claims', requireAdmin, (req, res) => {
  const map = new Map(works.map(w => [w.id, w]));
  const list = claims.map(c => {
    const w = map.get(c.workId);
    return {
      ...c,
      workTitle: w ? w.title : '(作品已删除)',
      workThumb: w ? (w.thumb || w.image) : '',
      workAuthor: w ? w.author : '',
      workGone: !w
    };
  }).sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1)
    || (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

app.post('/api/admin/claims/:id/approve', requireAdmin, (req, res) => {
  const c = claims.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '申请不存在' });
  if (c.status !== 'pending') return res.status(400).json({ error: '该申请已处理过' });
  const w = works.find(x => x.id === c.workId);
  if (!w) return res.status(404).json({ error: '作品已被删除' });
  const now = new Date().toISOString();
  // 作品归到申请人名下：作者名同步改为用户名，之后就能在「我的作品」里编辑/管理
  w.userId = c.userId;
  w.author = c.username;
  delete w.anonymous;        // 认领成功后翻牌成实名作者
  delete w.authorReal;
  w.claimedAt = now;
  w.claimOpen = false;   // 认领成功后自动关闭入口
  c.status = 'approved';
  c.handledAt = now;
  // 同一作品的其它待审申请自动关闭，避免重复认领
  claims.forEach(o => {
    if (o.workId === w.id && o.id !== c.id && o.status === 'pending') {
      o.status = 'rejected'; o.handledAt = now; o.note = '作品已被其他申请人认领';
    }
  });
  saveWorks(); saveClaims();
  // 匿名期间收到的灯火，认领成功后归到认领者名下（一次性结算，带防重标记）
  const settledTips = settleAnonymousTips(w, c.userId);
  // 认领通过 = 确认作品是 TA 的，跟自己投稿走同一条奖励规则（首件 200 / 后续 20，48 小时后到账）
  const uploadReward = (w.uploadReward || stageOf(w) !== 'live') ? null : planUploadReward(w, { id: c.userId }, 'claim');
  // 匿名期间标了开源的，之前没有账号发不出去，认领时一并补上
  const osBonus = grantOpenSourceBonus(w);
  saveWorks();
  // 认领通过：站内通知申请人（前台铃铛可见）
  addNotice(c.userId, {
    kind: 'system',
    title: `「${w.title}」认领成功`,
    text: `管理员已确认这件作品是你做的，归到你的名下：署名、数据看板、编辑与推广权限都已生效。`
      + (uploadReward ? `上传奖励 ${uploadReward.amount} 盏灯火将在 48 小时后到账。` : '')
      + (osBonus ? `已按开源作品补发 ${osBonus} 盏灯火。` : '')
      + (settledTips ? `这件作品在匿名期间收到的 ${settledTips} 盏灯火，也已转到你的余额里。` : '')
  });
  res.json({
    ok: true, work: publicWork(w), claim: c, settledTips, osBonus,
    uploadReward: uploadReward ? { amount: uploadReward.amount, first: uploadReward.first, readyAt: uploadReward.readyAt } : null
  });
});

app.post('/api/admin/claims/:id/reject', requireAdmin, (req, res) => {
  const c = claims.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '申请不存在' });
  if (c.status !== 'pending') return res.status(400).json({ error: '该申请已处理过' });
  c.status = 'rejected';
  c.handledAt = new Date().toISOString();
  c.note = String((req.body && req.body.note) || '').slice(0, 200);
  saveClaims();
  // 认领被拒：也通知一下，别让申请人一直等（作品可能已被删除，标题反查拿不到就用兜底文案）
  const rw = works.find(x => x.id === c.workId);
  addNotice(c.userId, {
    kind: 'system',
    title: `「${rw ? rw.title : '作品'}」认领未通过`,
    text: `很遗憾，你的认领申请没有通过审核${c.note ? `，原因：${c.note}` : ''}。如有异议可通过页面底部「意见建议」联系我们。`
  });
  res.json({ ok: true, claim: c });
});

// ================= 页面渲染（SEO 友好的服务端渲染外壳） =================
const INDEX_TPL = path.join(__dirname, 'frontend', 'index.html');
let tplCache = { mtime: 0, html: '' };

// 静态资源版本号：HTML 里的 style.css / app.js 引用带上 ?v=<文件mtime>，
// 文件一更新 URL 即变化，浏览器旧缓存（包括历史遗留的强缓存）自动失效
const assetVerCache = {};
function assetVer(name) {
  try {
    assetVerCache[name] = fs.statSync(path.join(__dirname, 'frontend', name)).mtimeMs;
  } catch { assetVerCache[name] = assetVerCache[name] || Date.now(); }
  return String(assetVerCache[name]);
}
function withAssetVer(html) {
  return html
    .replace('href="/style.css"', `href="/style.css?v=${assetVer('style.css')}"`)
    .replace('src="/app.js"', `src="/app.js?v=${assetVer('app.js')}"`);
}

function template() {
  try {
    const st = fs.statSync(INDEX_TPL);
    if (st.mtimeMs !== tplCache.mtime) {
      tplCache = { mtime: st.mtimeMs, html: fs.readFileSync(INDEX_TPL, 'utf-8') };
    }
  } catch { /* 使用缓存 */ }
  return withAssetVer(tplCache.html);
}

function shell(seoHead, bodyBlock, homeBlock = '') {
  const html = template();
  // SEO_HOME 在 #homeView 内部：SPA 切到别的视图时随 homeView 一起隐藏，不会闪现在首屏顶部
  if (!html) return `<!DOCTYPE html><html lang="zh-CN"><head>${seoHead}</head><body>${bodyBlock || homeBlock || ''}</body></html>`;
  return html
    .replace('<!--SEO_HEAD-->', seoHead)
    .replace('<!--SEO_BODY-->', bodyBlock || '')
    .replace('<!--SEO_HOME-->', homeBlock || '');
}

// 不再按 User-Agent 输出两套 HTML：真人与爬虫拿到同一份页面。
// 原来「只给爬虫注入 SEO 区块」会让真人首屏拿不到任何作品链接，也让
// ChatGPT-User / Perplexity-User 这类 UA（不含 bot 字样）读到空壳。
// 现在 SSR 区块注入 #homeView 内的 <!--SEO_HOME-->：真人能看到、爬虫能读到，
// SPA 切视图时随 homeView 一起隐藏，因此不会重现早年「先画一大块再塌掉」的抖动。

function sendHtml(res, html, status = 200) {
  res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'public, max-age=0, must-revalidate')
    .send(html);
}

// 公开可见作品：过审且已上线的全部展示（开源与否只是徽章和筛选维度，不决定可见性）。
// 注意：不要再用 openSource 卡可见性——v43 之后投稿默认闭源，这条规则曾把 59 个过审作品
// 压到只剩 8 个对外可见（首页/精选/榜单/SEO 全线缩水），2026-11-04 紧急修复。
// 管理员（带后台口令）额外能看过审前的预告等非 live 作品。
function visibleWorks() { return works.filter(w => isVisible(w)); }
// 带请求上下文的版本：所有人给全部可见作品（同时套用拉黑过滤）
function publicWorks(req) {
  const user = currentUser(req);
  const list = works.filter(w => isVisible(w));
  return filterBlocked(list, user);
}
function byNewest(list) {
  return list.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function authorEntries() {
  const map = new Map();
  visibleWorks().forEach(w => {
    if (w.anonymous === true) return;   // 匿名作品不进作者页 / sitemap
    const cur = map.get(w.author);
    if (!cur || new Date(w.createdAt) > new Date(cur.lastmod)) {
      map.set(w.author, { name: w.author, lastmod: w.createdAt });
    }
  });
  return [...map.values()];
}

function notFoundBlock(base) {
  return `<div id="seoContent" class="seo-wrap">
  <div class="page-head"><h1>页面不存在</h1><p>你访问的作品可能已下架、未通过审核，或者链接有误。</p></div>
  <p class="seo-more"><a class="btn-primary" href="/">返回首页浏览全部作品</a></p>
  <div class="seo-links"><div class="seo-links-group"><span class="seo-links-title">你可能想看</span>
    ${byNewest(visibleWorks()).slice(0, 6).map(w => `<a href="/w/${seo.esc(w.id)}">${seo.esc(w.title)}</a>`).join('')}
  </div></div>
</div>`;
}

// 首页
app.get('/', (req, res) => {
  const base = seo.baseUrl(req);
  const q = String(req.query.q || '').trim();
  const pool = byNewest(visibleWorks());
  // 和 /api/works 用同一套命中规则：SEO 页 /?q= 搜出来的结果必须和站内搜索一致
  const list = q
    ? pool.map(w => ({ w, s: searchScore(w, q) })).filter(x => x.s)
      .sort((a, b) => b.s - a.s || new Date(b.w.createdAt) - new Date(a.w.createdAt))
      .map(x => x.w)
    : pool;

  const description = truncateText(
    `造梦橱窗收录社区提交的网站、小程序、桌面客户端、机器人等作品，涵盖${orderedCategories().slice(0, 5).join('、')}等分类，` +
    `支持搜索、分类浏览、作品榜单与免费投稿。`, 150);

  const headHtml = seo.head({
    title: q
      ? `搜索「${q}」的结果 - ${seo.SITE_NAME}`
      : `${seo.SITE_NAME} - ${seo.SITE_TAGLINE}`,
    description,
    keywords: [
      '作品集', '作品展示', '工具导航', '网站推荐', '小程序', 'iOS', 'Android', 'macOS', 'Windows',
      '作品投稿', ...orderedCategories().slice(0, 4)
    ].join(','),
    canonical: base + '/',
    image: list[0] ? seo.absolute(base, list[0].image) : '',
    type: 'website',
    noindex: !!q,
    jsonLd: seo.websiteLd(base)
  });

  const block = seo.homeBlock(base, {
    works: withAuthorNames(list.slice(0, 24)),
    categories: orderedCategories(),
    types: WORK_TYPES
  });
  sendHtml(res, shell(headHtml, '', block)); // 同构：真人与爬虫共用一份 SSR，区块落在 #homeView 内，切视图时自动隐藏
});

app.get('/index.html', (req, res) => res.redirect(301, '/'));

// 作品详情页（可被搜索引擎收录的独立页面）
// 匿名投稿查询凭证：没有账号的人凭提交后拿到的链接回来看审核进度（页面自包含，不加载前端 App）
// 注意：早年印出去的二维码编的是 /s/<短码>，先按短码兜一层（老码不过期），查不到再走进度查询
app.get('/s/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  const shortCode = token.replace(/[^a-z0-9]/gi, '').slice(0, 16);
  if (shortCode && token === shortCode && scanShortHit(shortCode)) return scanLanding(req, res, shortCode);
  const w = works.find(x => x.lookupToken && x.lookupToken === token);
  const label = w ? statusLabelOf(w) : null;
  if (!w) {
    return sendHtml(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>查询链接已失效</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f5f2;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#222">
<div style="max-width:420px;padding:32px;text-align:center">
  <div style="font-size:34px;margin-bottom:12px">${seo.svgIco('search')}</div>
  <h1 style="font-size:17px;font-weight:500;margin:0 0 8px">这个查询链接已失效</h1>
  <p style="font-size:13px;line-height:1.7;color:#666;margin:0 0 20px">投稿记录可能已被删除，或者链接不完整。可以重新提交一次。</p>
  <a href="/" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-size:13px">回到首页</a>
</div></body></html>`, 404);
  }
  const rows = [
    ['当前状态', label.text],
    ['提交时间', String(w.createdAt || '').slice(0, 16).replace('T', ' ')],
    ['最近更新', String(w.updatedAt || w.createdAt || '').slice(0, 16).replace('T', ' ')],
    w.eta ? ['预计上线', w.eta] : null,
    typeof w.progress === 'number' ? ['完成度', w.progress + '%'] : null
  ].filter(Boolean);
  const linkOk = stageOf(w) === 'live' && (w.status || 'approved') === 'approved';
  sendHtml(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>投稿进度 · ${seo.esc(w.title)}</title></head>
<body style="margin:0;background:#f6f5f2;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#222">
<div style="max-width:560px;margin:0 auto;padding:28px 18px 48px">
  <p style="font-size:12px;color:#888;margin:0 0 14px">造梦橱窗 · 投稿进度查询</p>
  <div style="background:#fff;border-radius:14px;padding:18px;display:flex;gap:14px;align-items:flex-start">
    ${w.image ? `<img src="${seo.esc(w.thumb || w.image)}" alt="" style="width:84px;height:84px;object-fit:cover;border-radius:10px;flex:none" />` : ''}
    <div style="min-width:0">
      <h1 style="font-size:16px;font-weight:500;margin:0 0 8px;line-height:1.4">${seo.esc(w.title)}</h1>
      <span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;background:${label.bg};color:${label.fg}">${label.text}</span>
      ${w.offlineReason ? `<p style="font-size:13px;color:#a32d2d;line-height:1.6;margin:10px 0 0">下架原因：${seo.esc(w.offlineReason)}</p>` : ''}
    </div>
  </div>
  <div style="background:#fff;border-radius:14px;margin-top:12px;padding:6px 18px">
    ${rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid #efeee9;font-size:13px">
      <span style="color:#888">${k}</span><b style="font-weight:500;text-align:right">${seo.esc(String(v))}</b></div>`).join('')}
  </div>
  <p style="font-size:12px;color:#888;line-height:1.8;margin:14px 0 0">
    收藏这个链接就能随时回来看进度，不用注册账号。<br />
    ${label.tip}
  </p>
  <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
    ${linkOk ? `<a href="/w/${seo.esc(w.id)}" style="padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-size:13px">作品已上线，去看看</a>` : ''}
    <a href="/" style="padding:10px 16px;border-radius:8px;border:1px solid #ddd;color:#222;text-decoration:none;font-size:13px">回到首页</a>
  </div>
</div></body></html>`);
});

app.get('/w/:id', (req, res) => {
  const base = seo.baseUrl(req);
  const raw = works.find(x => x.id === req.params.id);

  // 管理员带口令（?key=）可以打开已下架 / 待审作品的详情，方便后台核对内容后再决定是否恢复上架；
  // 其他人一律按不存在处理
  if (!raw || (!isPublished(raw) && !isAdmin(req))) {
    const headHtml = seo.head({
      title: `页面不存在 - ${seo.SITE_NAME}`,
      description: '该作品可能已下架或未通过审核。',
      canonical: base + '/',
      noindex: true
    });
    return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
  }

  // 作者自主下架的作品：作者本人（含管理员）能打开，其他人一律按不存在处理（404 + noindex）
  {
    const viewer = currentUser(req);
    const isOwner = !!(viewer && raw.userId && viewer.id === raw.userId);
    if (raw.hidden && !isAdmin(req) && !isOwner) {
      const headHtml = seo.head({
        title: `页面不存在 - ${seo.SITE_NAME}`,
        description: '该作品可能已下架或未通过审核。',
        canonical: base + '/',
        noindex: true
      });
      return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
    }
  }

  // 预告 / 平台上架审核中的作品也能打开完整页，但不给外链、不进搜索引擎收录
  const isLiveStage = stageOf(raw) === 'live';
  const w = publicWork(isLiveStage ? raw : { ...raw, link: '', links: {}, qrcode: '' });
  w.introHtml = md.render(raw.prompt || '');   // SEO 详情页把简介按 Markdown 渲染（白名单标签）
  const pageUrl = base + '/w/' + w.id;
  const intro = md.plain(String(w.intro || '')).trim();   // meta description 要纯文本，去掉 Markdown 记号
  const description = truncateText(
    intro || `${w.title}，由 ${w.author} 提交的${w.category}类${typesOf(w).join('/')}作品，来造梦橱窗查看截图与使用方式。`, 150);
  const trail = [
    { name: '首页', href: '/' },
    { name: w.category, href: '/c/' + encodeURIComponent(w.category) },
    { name: w.title }
  ];
  // 同类作品：增强内链，帮助爬虫发现更多页面
  const wCats = catsOf(w);
  const related = byNewest(visibleWorks().filter(x => x.id !== w.id && catsOf(x).some(c => wCats.includes(c))))
    .slice(0, 6).map(publicWork);

  const headHtml = seo.head({
    title: `${w.title} - ${w.category}${typesOf(w).join('/')}作品 - ${seo.SITE_NAME}`,
    description,
    keywords: [w.title, w.author, w.category].concat(typesOf(w), ['作品', '工具']).join(','),
    canonical: pageUrl,
    image: seo.absolute(base, w.image),
    imageAlt: `${w.title} 作品截图`,
    type: 'article',
    publishedTime: w.createdAt,
    modifiedTime: w.updatedAt || w.createdAt,
    noindex: !isLiveStage,
    jsonLd: [
      seo.workLd(base, withAuthorName(w), pageUrl),
      seo.breadcrumbLd(base, trail)
    ]
  });

  // ?full=1 → 完整页面形态（用于分享与搜索引擎收录，前端不再自动弹窗）
  const fullPage = req.query.full === '1' || req.query.full === 'true';

  sendHtml(res, shell(headHtml, seo.workArticle(base, { ...withAuthorName(w), qrSrc: workQrOf(w).src, qrReal: workQrOf(w).real }, trail, withAuthorNames(related), { full: fullPage })));
});

// 作者主页
app.get('/u/:name', (req, res) => {
  const base = seo.baseUrl(req);
  const name = String(req.params.name || '').slice(0, 50);
  const ids = new Set(worksOfAuthorName(name).map(w => w.id));
  const list = byNewest(visibleWorks().filter(w => ids.has(w.id) && w.anonymous !== true));
  const creator = creators.find(c => c.name === name);
  const totalLikes = list.reduce((s, w) => s + (w.likes || 0), 0);
  const pageUrl = base + '/u/' + encodeURIComponent(name);
  const shown = displayNameOf(name);   // 页面显示昵称，URL / 作者匹配仍用账号名

  if (!list.length && !creator) {
    const headHtml = seo.head({
      title: `作者不存在 - ${seo.SITE_NAME}`,
      description: '该创作者还没有提交作品。',
      canonical: base + '/',
      noindex: true
    });
    return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
  }

  const bio = creator ? creator.bio || '' : '';
  const headHtml = seo.head({
    title: `${shown} 的作品（${list.length} 件） - ${seo.SITE_NAME}`,
    description: truncateText(
      `${shown}${creator ? '（认证创作者）' : ''}在造梦橱窗提交了 ${list.length} 件作品，` +
      `累计获赞 ${totalLikes} 次。${bio}`, 150),
    keywords: [shown, `${shown}的作品`, '创作者', '作品集'].join(','),
    canonical: pageUrl,
    image: list[0] ? seo.absolute(base, list[0].image) : '',
    type: 'profile',
    noindex: list.length < 2 ? 'follow' : false, // 只有 1 件作品的作者页是薄内容，不单独收录
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      url: pageUrl,
      name: `${shown} 的作品`,
      isPartOf: { '@type': 'WebSite', name: seo.SITE_NAME, url: base + '/' },
      mainEntity: {
        '@type': 'Person',
        name: shown,
        description: bio || `${shown} 在 ${seo.SITE_NAME} 的创作者主页`,
        url: pageUrl,
        interactionStatistic: {
          '@type': 'InteractionCounter',
          interactionType: { '@type': 'LikeAction' },
          userInteractionCount: totalLikes
        }
      }
    }, seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: shown }])]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: shown }])}
  <div class="author-card">
    <div class="author-avatar">${seo.esc(shown.slice(0, 1).toUpperCase())}</div>
    <div class="author-info">
      <h1>@${seo.esc(shown)}</h1>
      ${bio ? `<p class="author-bio">${seo.esc(bio)}</p>` : ''}
      <p class="author-stats">
        ${creator ? '<span class="verified-tag">✔ 认证创作者</span> ' : ''}
        ${userTagsOf(name).map(t => `<span class="author-tag">${seo.esc(t)}</span> `).join('')}
        作品 ${list.length} · 累计获赞 ${totalLikes}
      </p>
    </div>
  </div>
  <div class="gallery">${withAuthorNames(list).map(seo.cardHtml).join('') || '<div class="empty"><p>该作者还没有公开作品</p></div>'}</div>
</div>`;
  sendHtml(res, shell(headHtml, '', block)); // 同构：真人与爬虫共用一份 SSR，区块落在 #homeView 内，切视图时自动隐藏
});

// 发现页（移动端 Tab）：精选 + 平台专栏，SPA 自己渲染，服务端只出壳（不参与收录）
app.get('/discover', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `发现 - ${seo.SITE_NAME}`,
    description: '按平台浏览作品：Android、iOS、小程序、Web 专栏与本周精选。',
    canonical: base + '/discover'
  });
  sendHtml(res, shell(headHtml, ''));
});

// 我的（移动端 Tab）：个人中心聚合页，登录态相关，不收录
app.get('/me', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `我的 - ${seo.SITE_NAME}`,
    description: '我的收藏、我的作品、每日签到与账号设置。',
    canonical: base + '/me',
    noindex: true
  });
  sendHtml(res, shell(headHtml, ''));
});

// 榜单页
app.get('/rank', (req, res) => {
  const base = seo.baseUrl(req);
  const by = Object.prototype.hasOwnProperty.call(RANK_BY, req.query.by) ? req.query.by : 'hot';
  const BY_TEXT = { hot: '综合热度', likes: '点赞', favs: '收藏', tips: '打赏人数', pv: '访问次数', uv: '访问人数' };
  const list = visibleWorks().slice()
    .sort((a, b) => RANK_BY[by](a, b))
    .slice(0, 20);
  const tabCls = k => (k === by ? 'rank-tab active' : 'rank-tab');
  const tabHref = k => (k === 'hot' ? '/rank' : '/rank?by=' + k);

  const headHtml = seo.head({
    title: `作品榜单 - 热门网站、小程序与 App - ${seo.SITE_NAME}`,
    description: truncateText(
      `作品集热门榜单：支持按综合热度、点赞、收藏、打赏人数、PV、UV 排序，实时更新最受欢迎的网站、小程序、桌面客户端、机器人等作品。`, 150),
    keywords: '作品榜单,热门工具,排行榜,小程序排行,网站排行,点赞榜,收藏榜,打赏榜,灯火榜,PV榜,UV榜',
    canonical: base + '/rank',
    image: list[0] ? seo.absolute(base, list[0].image) : '',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '作品榜单' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `作品榜单（${BY_TEXT[by]}）`,
        url: base + '/rank',
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: list.length,
        itemListElement: list.map((w, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: base + '/w/' + w.id,
          name: w.title
        }))
      }
    ]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '作品榜单' }])}
  <div class="page-head">
    <h1><span class="ico">${Icons.ICONS.rank}</span> 作品榜单</h1>
    <p>当前按${BY_TEXT[by]}排序，展示最受欢迎的作品</p>
  </div>
  <div class="rank-tabs">
    <a class="${tabCls('hot')}" href="${tabHref('hot')}">综合</a>
    <a class="${tabCls('likes')}" href="${tabHref('likes')}">按点赞</a>
    <a class="${tabCls('favs')}" href="${tabHref('favs')}">按收藏</a>
    <a class="${tabCls('tips')}" href="${tabHref('tips')}">按打赏人数</a>
    <a class="${tabCls('pv')}" href="${tabHref('pv')}">按访问次数</a>
    <a class="${tabCls('uv')}" href="${tabHref('uv')}">按访问人数</a>
  </div>
  <ol class="seo-rank">
    ${list.map((w, i) => {
      const cc = countComments(w.id); // 有讨论才露出来：评论为 0 的作品保持原来的干净行
      const tt = tipTippersOf(w.id);  // 收过打赏才露灯火数，同理
      return `<li>
      <span class="rank-no">${i + 1}</span>
      <a href="/w/${seo.esc(w.id)}"><img src="${seo.esc(w.thumb || w.image)}" alt="${seo.esc(w.title)}" loading="lazy" /></a>
      <div class="rank-main">
        <a class="rank-title" href="/w/${seo.esc(w.id)}">${seo.esc(w.title)}</a>
        <div class="rank-meta">${typesOf(w).map(t => `${seo.svgIco(seo.TYPE_SVG[t] || 'other')} ${seo.esc(t)}`).join(' · ')} · @${seo.esc(w.author)} · ${seo.esc(w.category || '')}</div>
      </div>
      <div class="rank-score">${seo.svgIco('heart')} ${w.likes || 0} · ${seo.svgIco('star')} ${w.favs || 0}<br><span>${seo.svgIco('eye')} ${w.views || 0}</span>${cc ? `<br><span>${seo.svgIco('chat')} ${cc}</span>` : ''}${tt ? `<br><span>${seo.svgIco('lamp')} ${tt} 人打赏</span>` : ''}</div>
    </li>`;
    }).join('') || '<li class="empty"><p>暂无上榜作品</p></li>'}
  </ol>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, '', block)); // 同构：真人与爬虫共用一份 SSR，区块落在 #homeView 内，切视图时自动隐藏
});

// 造梦酒馆：说出想要的作品，社区创作者来认领实现（服务端渲染，利于收录）
// 旧路由 /wish → 301 永久跳转 /bar，保留已收录 URL 与外链
app.get('/wish', (req, res) => res.redirect(301, '/bar'));
app.get('/bar', (req, res) => {
  const base = seo.baseUrl(req);
  const list = ideas.filter(i => !i.hidden).slice().sort((a, b) => {
    const d = (b.wants || 0) - (a.wants || 0);
    return d !== 0 ? d : new Date(b.createdAt) - new Date(a.createdAt);
  });
  const top = list.slice(0, 30);
  const doneCount = list.filter(i => i.status === 'done' || i.workId).length;
  const claimedCount = list.filter(i => i.status === 'claimed').length;
  // 热搜词只给爬虫做内链：带 zero（搜了没结果）的词过去是空页，不放进 SEO 区块
  const hotSeo = hotSearches(10).items.filter(i => !i.zero).slice(0, 8);
  const desc = truncateText(
    `造梦酒馆：坐下说一句你想要但还没人做的工具，社区里的创作者来接单实现。目前共有 ${list.length} 个想法，` +
    `其中 ${doneCount} 个已被实现、${claimedCount} 个正在做。最受期待的有 ${top.slice(0, 3).map(i => i.title).join('、')} 等。`, 150);

  const headHtml = seo.head({
    title: `造梦酒馆 - 说出你想要的作品，让社区帮你实现 - ${seo.SITE_NAME}`,
    description: desc,
    keywords: '造梦酒馆,许愿墙,想要的功能,求工具,需求征集,作品定制,社区共创',
    canonical: base + '/bar',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '造梦酒馆' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '造梦酒馆 · 大家想要的作品',
        url: base + '/bar',
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: top.length,
        itemListElement: top.map((i, idx) => ({
          '@type': 'ListItem',
          position: idx + 1,
          name: i.title
        }))
      }
    ]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '造梦酒馆' }])}
  <div class="page-head">
    <h1><span class="ico">${Icons.ICONS.wish}</span> 造梦酒馆</h1>
    <p>坐下说一句你想要的作品——社区里的高手会来接；被认领、被实现的想法会挂上作品链接</p>
  </div>
  <p class="seo-wish-stat">共 ${list.length} 个想法 · 已被实现 ${doneCount} 个 · 正在做 ${claimedCount} 个 · 按「想要的人最多」排序</p>
  ${hotSeo.length ? `<p class="seo-wish-stat">大家最近在搜：${hotSeo.map(h => `<a href="/?q=${encodeURIComponent(h.w)}">${seo.esc(h.w)}</a>`).join(' · ')}</p>` : ''}
  <ol class="seo-rank seo-wish">
    ${top.map((i, idx) => `<li>
      <span class="rank-no">${idx + 1}</span>
      <div class="rank-main">
        <div class="rank-title">${seo.esc(i.title)}</div>
        <div class="rank-meta">
          ${seo.svgIco('fire')} ${i.wants || 0} 人想要 · @${seo.esc(i.author || '匿名')}
          ${i.category ? ' · ' + seo.esc(i.category) : ''}
          ${i.workId ? ` · ${seo.svgIco('check-circle')} 已实现` : (i.status === 'claimed' ? ` · ${seo.svgIco('claim')} 已被认领` : '')}
        </div>
      </div>
      ${i.workId ? `<a class="rank-score" href="/w/${seo.esc(i.workId)}">看作品 →</a>` : ''}
    </li>`).join('') || '<li class="empty"><p>还没有人提想法，来做第一个吧</p></li>'}
  </ol>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, '', block)); // 同构：真人与爬虫共用一份 SSR，区块落在 #homeView 内，切视图时自动隐藏
});

// 小程序专栏：专收「小程序」形态的作品（服务端渲染，利于收录；前端另有 SPA 视图）
// 这一页的存在理由：小程序在浏览器里点不开，专栏把「扫码直达」讲清楚，并推作者补小程序码
app.get('/mini', (req, res) => {
  const base = seo.baseUrl(req);
  const list = publicWorks(req)
    .filter(w => typesOf(w).includes('小程序'))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.qrcode ? 1 : 0) - (a.qrcode ? 1 : 0) || score(b) - score(a));
  const withQr = list.filter(w => w.qrcode).length;
  const desc = truncateText(
    `小程序专栏：收录 ${list.length} 个创作者自己做的小程序` +
    (list.length ? `，包括 ${list.slice(0, 3).map(w => w.title).join('、')} 等` : '') +
    `，其中 ${withQr} 个支持扫码直接体验。小程序在浏览器里打不开，这里给每个作品都配了小程序码，微信扫一下就能用，不下载不注册。`, 150);

  const headHtml = seo.head({
    title: `小程序专栏 - 扫码就能用的独立小程序 - ${seo.SITE_NAME}`,
    description: desc,
    keywords: '小程序专栏,微信小程序,小程序推荐,小程序码,扫码体验,独立开发者,小程序收录',
    canonical: base + '/mini',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '小程序专栏' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: '小程序专栏',
        description: desc,
        url: base + '/mini',
        isPartOf: { '@type': 'WebSite', name: seo.SITE_NAME, url: base + '/' },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: list.length,
          itemListElement: list.map((w, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: seo.absolute(base, '/w/' + w.id),
            name: w.title
          }))
        }
      }
    ]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '小程序专栏' }])}
  <div class="page-head">
    <h1><span class="ico">${Icons.ICONS.mini}</span> 小程序专栏</h1>
    <p>小程序在浏览器里点不开——这里给每个作品都配了小程序码，微信扫一下直接用，不下载、不注册</p>
  </div>
  <p class="seo-wish-stat">共 ${list.length} 个小程序 · ${withQr} 个能扫码直开 · 持续收录中</p>
  <div class="gallery">${list.map(w => seo.cardHtml(w)).join('') || '<div class="empty"><p>专栏里还没有小程序，第一个把作品放上来吧</p></div>'}</div>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, '', block));
});

// 外宣指南：适合独立开发者发新品的地方（服务端渲染，利于收录；前端另有 SPA 视图）
// 推荐（独立页面）：登录后用灯火给作品买曝光位。noindex：纯功能页，搜索引擎不用收录
app.get('/promote', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `作品推荐 - 用灯火给作品买曝光 - ${seo.SITE_NAME}`,
    description: '在造梦橱窗用灯火给自己的作品买曝光：首页第一格、榜单页顶部、小程序推荐位等，按「被看到 / 被点开」计费，没投完的随时按原价退回。',
    canonical: base + '/promote',
    noindex: true,
    type: 'website'
  });
  sendHtml(res, shell(headHtml, ''));
});

app.get('/guide', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `外宣指南 - 8 个适合独立开发者发新品的地方 - ${seo.SITE_NAME}`,
    description: truncateText(
      '做一次，到 8 个地方露脸：Product Hunt、Hacker News、V2EX 分享创造、少数派、小众软件、酷安、即刻、HelloGitHub——每个平台的适合投什么、投稿入口、避坑要点，外加可一键复制的投稿文案模板。', 150),
    keywords: '外宣指南,产品推广,独立开发者,发新品,Product Hunt,V2EX,少数派,小众软件,酷安,即刻,HelloGitHub,推广渠道',
    canonical: base + '/guide',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '外宣指南' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '适合独立开发者发新品的平台',
        url: base + '/guide',
        numberOfItems: PLATFORMS.length,
        itemListElement: PLATFORMS.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: p.name,
          url: p.url
        }))
      }
    ]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '外宣指南' }])}
  <div class="page-head">
    <h1>${seo.svgIco('megaphone')} 外宣指南</h1>
    <p>做一次，到 9 个地方露脸——附投稿入口和避坑要点</p>
  </div>
  <ol class="seo-rank seo-guide">
    ${PLATFORMS.map((p, i) => `<li>
      <span class="rank-no">${i + 1}</span>
      <div class="rank-main">
        <div class="rank-title">${p.icon ? `<img class="rank-ico" src="${seo.esc(p.icon)}" alt="" loading="lazy">` : seo.svgIco('globe')} ${seo.esc(p.name)}</div>
        <div class="rank-meta">${seo.esc(p.region)} · 适合：${seo.esc(p.fits)}</div>
        <p class="seo-guide-tip">${seo.esc(p.tip)}</p>
      </div>
      <a class="rank-score" href="${seo.esc(p.url)}" target="_blank" rel="noopener nofollow">去投稿 →</a>
    </li>`).join('')}
  </ol>
  <p class="seo-guide-note">${seo.esc(EXTRA)}</p>
  <p class="seo-guide-note">在任意作品详情页点「${seo.svgIco('megaphone')}外宣包」，就能拿到按上面每个平台定制好的投稿文案，复制即可。</p>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, '', block));
});

// ---------- 造梦编年史：站点历史事件页（公开，服务端渲染） ----------
// 里程碑（自动从数据算）：第 N 位用户入驻、第 N 件作品上架、第一件用户作品、第一笔打赏…
// 激励事迹（后台贴标签 / 送灯火时自动记录）：谁、因为什么、获得什么荣誉——
// 送了多少灯火保密：chronicle.json 里的 points 只存档，渲染和接口一律不输出，对外统一叫「神秘灯火」。
// 站长定的口径（2026-11-06）：人数里程碑只记 100 / 500 / 1000 三档，免成流水账
const CHRON_USER_STEPS = [100, 500, 1000];
// 各档位文案（润色过，缺档用兜底句）
const CHRON_USER_WORDS = {
  100: '来了——第 100 位造梦者，橱窗第一次凑满百人',
  500: '来了——第 500 位造梦者，小馆子越坐越满',
  1000: '来了——第 1000 位造梦者，千人同橱，各自做梦'
};
const CHRON_WORK_STEPS = [1, 10, 20, 50, 100, 200, 500, 1000, 2000];

// 编年史统计口径：站长的账号、后台测试账号、早期灌的示例账号都不算「创作者」，
// 否则「第一位注册用户」会落到测试号头上（线上真实第一位是 richardxxx0x）。
// 站长账号名写死在下面，改名的话同步改这里。
const CHRON_EXCLUDE_USERS = new Set(['思绪到处飞', '张三', '李四', '王五']);
const CHRON_TEST_NAME_RE = /^(admin\d*|.*test.*|shot\d+|hide_test.*|blocktest.*|rmtest.*|drafttest.*)$/i;
function chronExcluded(name) {
  if (!name) return true;
  return CHRON_EXCLUDE_USERS.has(name) || CHRON_TEST_NAME_RE.test(String(name));
}
// 站长确认：橱窗第一件「上架」作品是 richardxxx0x 的 RadioHub（比它早的提交后来才上线/属站方）
const CHRON_FIRST_WORK_ID = 'mvvwyv66cze5';
// 补记的历史事件（编年史上线前的故事，数据里没有时间戳可推，只能人工登记）
// 产品大事的日期来自 git 提交记录（ai-works-site 仓库），改动可在此直接改
const CHRON_MANUAL_EVENTS = [
  {
    at: '2026-11-05T10:00:00+08:00', ico: 'gift',
    text: '@猫猫鱼 的第一条建议被采纳——站长送上神秘灯火，并授予「造梦体验官」荣誉徽章'
  },
  {
    at: '2026-11-01T22:46:00+08:00', ico: 'lamp',
    text: '灯火亮起来了——签到、分享、上传作品、开源贡献都能攒下灯火，也能送给自己喜欢的创作者'
  },
  {
    at: '2026-11-01T23:13:00+08:00', ico: 'rank',
    text: '星梦榜开榜——作品按热度、获赞、收藏、访客数排座次，好东西从此有了被看见的路'
  },
  {
    at: '2026-11-02T19:14:00+08:00', ico: 'wish',
    text: '「造梦酒馆」开张——许愿墙挂上新招牌，从此有了自己的名字'
  },
  {
    // 小程序上架日（站长可在此改日期/文案）
    at: '2026-11-06T10:00:00+08:00', ico: 'mini',
    text: '「造梦橱窗」小程序正式上架——整站装进了微信，扫码即达；随小程序一起上线 3 个站内小程序推荐位，作品推荐从此能投给更精准的用户：他们可以在小程序里一键复制 App Store / 安卓下载链接，也可以直接扫码走进你的小程序——利好小程序、App 开发者。这意味着，您的作品不必再只等首页那一次曝光：投上推荐位，它就会出现在会下载、会使用、会留下来的人面前'
  },
  {
    // 桌面 PWA 上线日（站长可在此改日期/文案）
    at: '2026-11-06T12:00:00+08:00', ico: 'web',
    text: '造梦橱窗桌面 PWA 上线——像装本地应用一样把橱窗装进电脑：独立窗口、常驻任务栏，双击图标即达'
  }
];

function chronDate(at) {
  const d = new Date(at);
  if (isNaN(d)) return '';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function buildChronicleItems() {
  const items = [];
  // —— 用户里程碑（先剔掉站方与测试账号，再重新编号） ——
  const us = users
    .filter(u => u.createdAt && !chronExcluded(u.username))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  us.forEach((u, i) => {
    const n = i + 1;
    if (!CHRON_USER_STEPS.includes(n)) return;
    items.push({
      at: u.createdAt, ico: 'user',
      text: n === 1
        ? `@${seo.esc(displayNameOf(u.username) || u.username)} 是第一位走进橱窗的造梦者——那天站里还没有别人`
        : `@${seo.esc(displayNameOf(u.username) || u.username)} ${CHRON_USER_WORDS[n] || `来了，造梦者凑到 ${n} 位`}`
    });
  });
  // —— 作品（同样剔掉站方与测试账号的作品） ——
  const ws = visibleWorks()
    .filter(w => w.createdAt && !chronExcluded(w.author))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const firstWork = ws.find(w => w.id === CHRON_FIRST_WORK_ID) || ws.find(w => /^radiohub$/i.test(w.title || '')) || ws[0];
  if (firstWork) {
    const who = firstWork.author ? `（@${seo.esc(displayNameOf(firstWork.author) || firstWork.author)}）` : '';
    items.push({
      at: firstWork.createdAt, ico: 'sparkle',
      text: `《${seo.esc(firstWork.title)}》上架——橱窗迎来的第一件作品${who}`
    });
  }
  ws.filter(w => !firstWork || w.id !== firstWork.id).forEach((w, i) => {
    const n = i + 2; // 第一件已被上面单独记录
    if (!CHRON_WORK_STEPS.includes(n)) return;
    items.push({
      at: w.createdAt, ico: 'viewcard',
      text: `《${seo.esc(w.title)}》上架，橱窗里的作品攒到 ${n} 件`
    });
  });
  // —— 第一位、第二位置身开源的认证作者（GitHub 原创优质作者） ——
  // 规则：认证作者 + 提交过 GitHub 开源作品，按第一件开源作品的时间排序，只上两位。
  const ghSeen = new Set();
  const ghAuthors = [];
  ws.filter(w => w.author && !chronExcluded(w.author) && /github\.com/i.test(w.repo || ''))
    .forEach(w => {
      if (ghSeen.has(w.author)) return;
      if (!creators.some(c => c.name === w.author)) return;
      ghSeen.add(w.author);
      ghAuthors.push(w);
    });
  ghAuthors.slice(0, 2).forEach((w, i) => {
    items.push({
      at: w.createdAt, ico: 'github',
      text: `@${seo.esc(displayNameOf(w.author) || w.author)} 成为第 ${i + 1} 位「GitHub 原创优质作者」——开源作品《${seo.esc(w.title)}》`
    });
  });
  // —— 第一笔打赏 ——
  const firstTip = tips.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (firstTip) {
    const tw = works.find(x => x.id === firstTip.workId);
    const giver = chronExcluded(firstTip.fromDisplay) ? '站长' : seo.esc(firstTip.fromDisplay || '一位用户');
    items.push({
      at: new Date(firstTip.createdAt).toISOString(), ico: 'heart',
      text: `${giver}送出了第一盏社区灯火${tw ? `——《${seo.esc(tw.title)}》第一次收到别人的心意` : ''}`
    });
  }
  // —— 补记的历史事件 ——
  CHRON_MANUAL_EVENTS.forEach(ev => items.push({ at: ev.at, ico: ev.ico || 'sparkle', text: ev.text }));
  // —— 激励事迹（徽章 / 神秘灯火）：2026-11-06 起站长决定不再上公开编年史 ——
  // chronicle.json 照常记档、后台照常发放，只是公开页不再渲染这段流水；
  // 想恢复的话，从 git 历史把「激励事迹」渲染块找回来即可。

  // —— 站点生日与纪念日 ——
  // 开站日 = 最早一位真实造梦者 / 第一件作品里更早的那个（站方与测试账号已剔除）
  const birthCands = [us[0] && us[0].createdAt, ws[0] && ws[0].createdAt].filter(Boolean).sort();
  const siteBirth = birthCands[0];
  if (siteBirth) {
    const birthMs = new Date(siteBirth).getTime();
    if (!isNaN(birthMs)) {
      items.push({
        at: siteBirth, ico: 'sparkle',
        text: '造梦橱窗开站——从这一天起，开始收录大家亲手做的作品'
      });
      const ageDays = Math.floor((Date.now() - birthMs) / 86400000);
      for (let d = 100; d <= ageDays; d += 100) {
        items.push({
          at: new Date(birthMs + d * 86400000).toISOString(), ico: 'calendar',
          text: `造梦橱窗满 ${d} 天`
        });
      }
      const ageYears = Math.floor(ageDays / 365);
      for (let y = 1; y <= ageYears; y++) {
        items.push({
          at: new Date(birthMs + y * 365 * 86400000).toISOString(), ico: 'calendar',
          text: `造梦橱窗 ${y} 周岁——已有 ${us.length} 位造梦者、${ws.length} 件作品`
        });
      }
    }
  }

  // —— 送灯火（打赏）笔数里程碑：只记破百以内的关键节点，之后再送不记，免成流水账 ——
  const CHRON_TIP_STEPS = [10, 50, 100];
  const tipsSorted = tips.filter(t => t && t.createdAt).sort((a, b) => a.createdAt - b.createdAt);
  CHRON_TIP_STEPS.forEach(n => {
    const t = tipsSorted[n - 1];
    if (!t) return;
    const tw = works.find(x => x.id === t.workId);
    items.push({
      at: new Date(t.createdAt).toISOString(), ico: 'heart',
      text: `《${seo.esc((tw && tw.title) || '一件作品')}》收到第 ${n} 盏来自社区的灯火`
    });
  });

  // —— 第一件「被 100 个人看过」的作品（UV 口径：去重后的真人访客） ——
  // 点详情页开过不算里程碑日期依据，这里按 workVisits 的 UV 累计到 100 那天记
  function chronCrossDayOf(rec, dayAcc, goal) {
    // dayAcc(day, dayRec, acc) 把当天数据累进 acc，返回是否达到目标
    const dayKeys = Object.keys((rec && rec.days) || {}).sort();
    let day = '', acc = dayAcc.init();
    for (const k of dayKeys) {
      dayAcc.step(acc, rec.days[k]);
      if (dayAcc.hit(acc, goal)) { day = k; break; }
    }
    if (!day) day = dayKeys[0] || '';   // 90 天窗口截断找不到具体哪天：退回最早有记录的那天
    return day;
  }
  const seen100 = Object.entries(workVisits)
    .map(([id, rec]) => {
      if (Object.keys((rec && rec.uv) || {}).length < 100) return null;
      const w = works.find(x => x.id === id);
      if (!w || !w.createdAt || chronExcluded(w.author)) return null;
      const day = chronCrossDayOf(rec, {
        init: () => new Set(),
        step: (acc, d) => Object.keys((d && d.uv) || {}).forEach(k => acc.add(k)),
        hit: (acc, g) => acc.size >= g
      }, 100);
      if (!day) return null;
      return { at: day, w };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  if (seen100) {
    const who = seen100.w.author ? `（@${seo.esc(displayNameOf(seen100.w.author) || seen100.w.author)}）` : '';
    items.push({
      at: seen100.at + 'T12:00:00+08:00', ico: 'eye',
      text: `《${seo.esc(seen100.w.title)}》被 100 个人看过——第一件破百人围观的作品${who}`
    });
  }

  // —— 第一件「链接被点开 100 次」的作品（visit 口径：真点了访问/试用链接，点详情页不算） ——
  const clicked100 = Object.entries(workActions)
    .map(([id, rec]) => {
      if ((rec && rec.visit || 0) < 100) return null;
      const w = works.find(x => x.id === id);
      if (!w || !w.createdAt || chronExcluded(w.author)) return null;
      const day = chronCrossDayOf(rec, {
        init: () => 0,
        step: (acc, d) => acc + (Number(d && d.visit) || 0),
        hit: (acc, g) => acc >= g
      }, 100);
      if (!day) return null;
      return { at: day, w };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  if (clicked100) {
    const who = clicked100.w.author ? `（@${seo.esc(displayNameOf(clicked100.w.author) || clicked100.w.author)}）` : '';
    items.push({
      at: clicked100.at + 'T12:00:00+08:00', ico: 'link',
      text: `《${seo.esc(clicked100.w.title)}》的链接被点开 100 次——第一件「真的有人去用」的作品${who}`
    });
  }

  // —— 首位累计签到满一个月（30 天）的造梦者 ——
  const ckFull = Object.entries((shareData && shareData.users) || {})
    .map(([uid, rec]) => ({ uid, ck: (rec && rec.checkin) || {} }))
    .filter(x => x.ck.total >= 30 && x.ck.last)
    .sort((a, b) => String(a.ck.last).localeCompare(String(b.ck.last)))[0];
  if (ckFull) {
    const cu = users.find(u => u.id === ckFull.uid);
    if (cu && !chronExcluded(cu.username)) {
      items.push({
        at: ckFull.ck.last + 'T12:00:00+08:00', ico: 'checkin',
        text: `@${seo.esc(displayNameOf(cu.username) || cu.username)} 累计签到满 30 天——第一位把「每天都来」坚持成一个月的造梦者`
      });
    }
  }

  // —— 首位上架 10 件作品的造梦者 ——
  const byAuthorCnt = new Map();
  ws.forEach(w => {
    if (!w.author) return;
    if (!byAuthorCnt.has(w.author)) byAuthorCnt.set(w.author, []);
    byAuthorCnt.get(w.author).push(w);
  });
  const tenAuthor = [...byAuthorCnt.entries()]
    .filter(([, list]) => list.length >= 10)
    .map(([a, list]) => ({ a, tenth: list[9] }))   // ws 已按时间排序，第 10 件即 list[9]
    .sort((x, y) => String(x.tenth.createdAt).localeCompare(String(y.tenth.createdAt)))[0];
  if (tenAuthor) {
    items.push({
      at: tenAuthor.tenth.createdAt, ico: 'viewcard',
      text: `@${seo.esc(displayNameOf(tenAuthor.a) || tenAuthor.a)} 上架了第 10 件作品《${seo.esc(tenAuthor.tenth.title)}》——第一位集齐十件的造梦者`
    });
  }

  // —— 第一次作者下场回复用户留言 ——
  const wByIdMap = new Map(works.map(w => [w.id, w]));
  const firstReply = comments
    .filter(c => c && c.parentId && c.createdAt)
    .map(c => ({ c, w: wByIdMap.get(c.workId) }))
    .filter(x => x.w && !chronExcluded(x.w.author) && commentIsAuthor(x.c, x.w))
    .sort((a, b) => a.c.createdAt - b.c.createdAt)[0];
  if (firstReply) {
    items.push({
      at: new Date(firstReply.c.createdAt).toISOString(), ico: 'chat',
      text: `@${seo.esc(displayNameOf(firstReply.w.author) || firstReply.w.author)} 在《${seo.esc(firstReply.w.title)}》评论区回复了用户的留言——第一次有作者下场答疑`
    });
  }

  // 按真实时间排序：不能拿字符串比——'2026-11-05T10:00+08:00' 会被排到 '2026-11-05T07:47Z' 后面，时间线直接乱掉
  return items.sort((a, b) => new Date(a.at) - new Date(b.at));
}
app.get('/chronicle', (req, res) => {
  const base = seo.baseUrl(req);
  const items = buildChronicleItems();
  const headHtml = seo.head({
    title: `造梦编年史 - 造梦橱窗的大事记 - ${seo.SITE_NAME}`,
    description: '造梦橱窗编年史：记下站点的每一个「第一次」和每一级台阶——第一件上架作品、第一位开源作者、第 100 位造梦者、小程序上架、桌面 PWA 上线，这些属于站点自己的日子都在这条时间线上。',
    keywords: '造梦编年史,大事记,站点历史,荣誉徽章,灯火,造梦橱窗,GitHub原创作者',
    canonical: base + '/chronicle',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '造梦编年史' }]),
      {
        '@context': 'https://schema.org', '@type': 'ItemList',
        name: '造梦橱窗编年史', url: base + '/chronicle',
        numberOfItems: items.length
      }
    ]
  });
  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '造梦编年史' }])}
  <div class="page-head">
    <h1>${seo.svgIco('sparkle')} 造梦编年史</h1>
    <p>记录造梦橱窗的每一个「第一次」和每一级台阶：第一件作品、第一位开源作者、第 100 位造梦者、小程序上架……属于全站的日子，都在这条时间线上。</p>
  </div>
  <ol class="chron-list">
    ${items.map(it => `<li class="chron-item">
      <span class="chron-dot">${seo.svgIco(it.ico)}</span>
      <div class="chron-main">
        <div class="chron-date">${seo.esc(chronDate(it.at))}</div>
        <div class="chron-text">${it.text}</div>
      </div>
    </li>`).join('') || '<li class="empty"><p>编年史还在写第一行……</p></li>'}
  </ol>
  <p class="chron-note">${seo.svgIco('chat')} 你也有想法？<a href="/?feedback=1">随时提给我们</a>——下一个被记进编年史的日子，也许就是你的作品带来的。</p>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, block)); // 全量渲染：低流量页，真人也能直接看，利于收录
});

// 安装到桌面（PWA）+ 小程序码：全站通告的落地页（2026-11-06 新增）
// 站长要求：通知别每次都往编年史引流，单独给一个「装到桌面」的页，底部带小程序码
app.get('/install', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `安装到桌面 - 把造梦橱窗装进手机和电脑 - ${seo.SITE_NAME}`,
    description: '把造梦橱窗装到手机桌面：iPhone 用 Safari「添加到主屏幕」，安卓用 Chrome/Edge「添加到主屏幕」，以后点图标直接进来。用桌面图标登录打开还送 200 盏灯火；页面顶部有小程序码，扫码直达「造梦橱窗」小程序。',
    keywords: '造梦橱窗,安装到桌面,添加到主屏幕,PWA,桌面应用,小程序码,造梦橱窗小程序',
    canonical: base + '/install',
    type: 'website',
    jsonLd: [seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '安装到桌面' }])]
  });
  const block = `<div id="seoContent" class="seo-wrap install-wrap">
  <style>
    .install-wrap { max-width: 880px; }
    .install-wrap .page-head p { line-height: 1.8; }
    .ins-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 18px 0 14px; }
    .ins-card { background: #fff; border: 1px solid #e8e8f0; border-radius: 14px; padding: 16px 18px 18px; }
    .ins-ico { width: 36px; height: 36px; border-radius: 10px; background: #f3f0ff; color: #6b4ce6; display: flex; align-items: center; justify-content: center; }
    .ins-ico svg { width: 20px; height: 20px; }
    .ins-card h3 { margin: 10px 0 6px; font-size: 16px; }
    .ins-card p { margin: 0; font-size: 13.5px; line-height: 1.75; color: #5b5f72; }
    .ins-step { display: block; margin-top: 6px; }
    .ins-step b { color: #2b2e3f; }
    .ins-hint { margin-top: 8px !important; font-size: 12.5px !important; color: #8a8fa3 !important; line-height: 1.6; }
    .ins-hint b { color: #5b5f72; }
    .ins-native-row { margin: 4px 0 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .ins-native-hint { font-size: 13px; color: #8a8fa3; }
    .ins-tip { font-size: 13px; color: #6b5a2a; background: #fff8e6; border: 1px solid #f0e3b8; border-radius: 12px; padding: 10px 14px; margin: 0 0 16px; line-height: 1.7; }
    .ins-done { display: none; font-size: 13px; color: #2f7d4f; background: #eef8f1; border: 1px solid #cdead6; border-radius: 12px; padding: 10px 14px; margin: 0 0 16px; }
    .ins-mini { display: flex; gap: 18px; align-items: center; background: #fff; border: 1px solid #e8e8f0; border-radius: 14px; padding: 16px 18px; margin-top: 6px; }
    .ins-mini-qr { flex: none; width: 150px; height: 150px; border-radius: 10px; background: #f5f5fa; }
    .ins-mini h3 { margin: 0 0 6px; font-size: 16px; }
    .ins-mini p { margin: 0; font-size: 13.5px; line-height: 1.75; color: #5b5f72; }
    .ins-mini-good { margin: 8px 0 0 !important; font-size: 13px !important; line-height: 1.7 !important; color: #1f6340 !important; background: #eef8f1; border: 1px solid #cdead6; border-radius: 8px; padding: 8px 10px; }
    @media (max-width: 560px) { .ins-mini { flex-direction: column; align-items: flex-start; } }
  </style>
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '安装到桌面' }])}
  <div class="page-head">
    <h1>${seo.svgIco('mobile')} 把造梦橱窗装到桌面</h1>
    <p>装好之后是独立窗口、点图标直达，不用再从浏览器收藏里翻。<br />
    用装好的图标打开并登录，还能领 <b>200 盏灯火</b>奖励（一次性）。</p>
  </div>
  <div class="ins-mini">
    <img id="insMiniQr" class="ins-mini-qr" alt="造梦橱窗小程序码" />
    <div>
      <h3>${seo.svgIco('mini')} 微信扫一扫，直接进小程序</h3>
      <p>「造梦橱窗」小程序已上架——整站装进了微信，扫码即达；随小程序一起上线 3 个站内小程序推荐位，作品推荐能投给更精准的用户：他们可以在小程序里一键复制 App Store / 安卓下载链接，也可以直接扫码走进你的小程序，当场玩一遍。</p>
      <p class="ins-mini-good"><b>利好小程序、App 开发者</b>：作品在微信里被刷到，用户扫一下就直接进你的产品，不用再让他们去应用商店里搜名字——推荐位买的就是这一步的距离。</p>
    </div>
  </div>
  <div class="ins-grid">
    <div class="ins-card">
      <div class="ins-ico">${seo.svgIco('ios')}</div>
      <h3>iPhone / iPad</h3>
      <p><span class="ins-step">1. 用 <b>Safari</b> 打开本站</span>
      <span class="ins-step">2. 点底部中间的「分享」按钮</span>
      <span class="ins-step">3. 选「<b>添加到主屏幕</b>」→ 确认</span></p>
    </div>
    <div class="ins-card">
      <div class="ins-ico">${seo.svgIco('android')}</div>
      <h3>安卓手机</h3>
      <p><span class="ins-step">1. 用 <b>Chrome / Edge</b> 打开本站</span>
      <span class="ins-step">2. 点右上角「⋮」菜单</span>
      <span class="ins-step">3. 选「<b>添加到主屏幕</b>」或「安装应用」</span>
      <span class="ins-step ins-hint">添加后没看到图标？去浏览器设置里开启「<b>桌面快捷方式</b>」权限</span></p>
    </div>
  </div>
  <div class="ins-native-row">
    <button type="button" class="btn-primary" id="insNative" style="display:none">${seo.svgIco('bolt')} 一键安装（本设备支持）</button>
    <span class="ins-native-hint">按钮没亮？按上面的手动步骤来就行。</span>
  </div>
  <p class="ins-done">✓ 已经装好了——桌面上的图标直接点开就行，不用再装一次。</p>
  <p class="ins-tip">在微信里看到这条消息？先点右上角「···」→「在浏览器中打开」，再按上面的步骤装。装好后的桌面图标独立打开，不在微信里。</p>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a>&nbsp;&nbsp;<a class="btn-ghost" href="/chronicle">看看站点的大事记 →</a></p>
  <script>
  (function () {
    var btn = document.getElementById('insNative');
    if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
      document.querySelectorAll('.ins-done').forEach(function (el) { el.style.display = 'block'; });
      if (btn) btn.style.display = 'none';
    }
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      window.__insPrompt = e;
      if (btn) btn.style.display = '';
    });
    if (btn) btn.addEventListener('click', function () {
      var p = window.__insPrompt;
      if (!p) return;
      p.prompt();
      if (p.userChoice && p.userChoice.then) p.userChoice.then(function () { btn.style.display = 'none'; window.__insPrompt = null; });
    });
    var img = document.getElementById('insMiniQr');
    if (img) fetch('/api/mini/self-qr').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.qr) img.src = d.qr;
    }).catch(function () {});
  })();
  </script>
</div>`;
  sendHtml(res, shell(headHtml, block));
});

// 投稿指南：从提交作品到被看见的完整流程（服务端渲染，利于收录；前端另有 SPA 视图）
app.get('/howto', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `投稿指南 - 从提交作品到被更多人看见 - ${seo.SITE_NAME}`,
    description: truncateText(
      '造梦橱窗投稿指南：注册免审直接上线、封面图与宣传图怎么准备、形态与分类怎么填、开源标注送 50 盏灯火，以及上线后用分享卡片、外宣包、推荐和榜单让作品被更多人看见的完整流程。', 150),
    keywords: '投稿指南,提交作品,上传作品,灯火,作品推荐,开源奖励,造梦橱窗',
    canonical: base + '/howto',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '投稿指南' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'HowTo',
        name: '如何在造梦橱窗提交作品',
        description: '从注册、准备材料、填表、开源标注到上线推广的完整投稿流程。',
        step: [
          '先注册，再投稿（注册用户免审核，提交后立即上线）',
          '准备好材料：作品名称、封面图、作品地址、一句话简介',
          '填写表单：作品形态可多选、应用分类最多 3 个、宣传图最多 9 张',
          '两个加分标注：开源送 50 盏灯火；如实标注是否收费',
          '提交之后：注册即上线；匿名投稿进入人工审核',
          '上线后推广：分享卡片、外宣包、推荐、签到攒灯火、冲榜单'
        ].map((text, i) => ({ '@type': 'HowToStep', position: i + 1, name: text }))
      }
    ]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '投稿指南' }])}
  <div class="page-head">
    <h1>${seo.svgIco('mail')} 投稿指南</h1>
    <p>从提交作品到被更多人看见，全流程一次讲清</p>
  </div>
  <ol class="seo-rank seo-guide">
    <li><span class="rank-no">1</span><div class="rank-main"><div class="rank-title">先注册，再投稿（推荐）</div><p class="seo-guide-tip">注册用户投稿免审核、提交后立即上线；匿名投稿需人工审核且限流更紧（10 分钟最多 5 条）。注册后账号名即作者名，作品挂到个人主页，还能使用灯火与推广功能。</p></div></li>
    <li><span class="rank-no">2</span><div class="rank-main"><div class="rank-title">准备好材料</div><p class="seo-guide-tip">作品名称、封面图（JPG / PNG / WebP，支持 Ctrl+V 粘贴截图）、作品地址（Web 形态必填）、一句话简介——简介决定别人点不点进来。</p></div></li>
    <li><span class="rank-no">3</span><div class="rank-main"><div class="rank-title">填表：形态、分类、宣传图</div><p class="seo-guide-tip">作品形态可多选；应用分类最多 3 个、第一个是主分类；官网选填；宣传图最多 9 张，展示在详情页。</p></div></li>
    <li><span class="rank-no">4</span><div class="rank-main"><div class="rank-title">两个加分标注</div><p class="seo-guide-tip">标注开源并填源码地址，系统送 50 盏灯火（一件作品一次）；仓库在 GitHub 的每涨 1 个 star 自动 +1 盏灯火（每 6 小时同步，掉星不扣）；开始同步前已有的 star 不自动补，登录后在「我的数据 → 分享成绩」点「申请 star 奖励」，100 star 以内当场到账、超过 100 由站长核定；Gitee 等其他托管站读不到 star，申请后由站长人工核对；收费情况如实标注，避免用户预期错位。</p></div></li>
    <li><span class="rank-no">5</span><div class="rank-main"><div class="rank-title">提交之后</div><p class="seo-guide-tip">注册用户提交即上线；匿名投稿进入待审核。被下架的作品会收到站内消息说明原因，修改后重新提交、审核通过即恢复。</p></div></li>
    <li><span class="rank-no">6</span><div class="rank-main"><div class="rank-title">上线后，这样让更多人看见</div><p class="seo-guide-tip">分享卡片一键生成带二维码的分享图；外宣包按 8 个平台生成现成投稿文案；推荐用灯火买曝光（展示包每 10 次 2 灯火、点击每次 3 灯火，撤下按剩余退回）；上传作品首件 +200、之后每件 +20、每日签到 2→15 盏越签越多、好友访问 +1、好友注册 +100、开源 +50、开源作品的 GitHub star 每涨 1 个 +1；每周榜单与「本周精选」会收录数据好的作品。</p></div></li>
  </ol>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页提交作品</a></p>
</div>`;
  sendHtml(res, shell(headHtml, '', block));
});
// 作品规范：投稿前要看的硬规则（服务端渲染，真人 + 爬虫都能看；表单和详情页都链到这里）
app.get('/rules', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `作品规范 - 能传什么、二维码怎么放、违规怎么处理 - ${seo.SITE_NAME}`,
    description: truncateText(
      '造梦橱窗作品上传规范：可以上传本人创作或已获授权的作品；只放微信小程序码、官网和仓库链接，禁放个人微信、公众号、收款码与外链下载码；截图不得截取付费内容；违规按四级处理，原作者可申请移除。', 150),
    keywords: '作品规范,投稿规范,上传规则,二维码规范,侵权处理,造梦橱窗',
    canonical: base + '/rules',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '作品规范' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: '作品规范',
        description: '造梦橱窗的作品上传规范、二维码与链接要求、侵权处理与申诉流程。',
        url: base + '/rules'
      }
    ]
  });

  const block = `<div id="seoContent" class="seo-wrap">
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '作品规范' }])}
  <div class="page-head">
    <h1>${seo.svgIco('rules')} 作品规范</h1>
    <p>这里展示的是作者自己做的东西。上传前对照自查，看不懂的地方<a href="/?feedback=1">直接问我们</a>，别猜</p>
  </div>
  <div class="rules-doc">

    <section class="rules-sec">
      <h2>一、可以上传什么</h2>
      <ul class="rules-list">
        <li>你本人创作的作品：网站、小程序、App、插件、工具、设计、文档等。</li>
        <li>作品的使用入口：链接、截图、二维码都可以一起提交。</li>
        <li><b>代发他人作品</b>：必须已获得作者授权，并在简介里写明原作者；未授权的代发不予上架。</li>
        <li><b>想推荐别人的作品</b>：把投稿页发给作者本人；站内已有的条目，原作者可以用「认领」归到自己名下。橱窗不设代收录通道。</li>
      </ul>
    </section>

    <section class="rules-sec">
      <h2>二、截图和图片</h2>
      <ul class="rules-list">
        <li>只截<b>公开可看</b>的内容。截取付费、会员专享、需要登录才看得到的界面，视为侵权。</li>
        <li>截图是为了说明作品用途，<b>不替代作品本身</b>：一件作品 1-2 张讲清就够，宣传图最多 9 张，别把整站页面全搬过来。</li>
        <li>图片里不要出现个人微信、群二维码、收款码、外部网址。</li>
        <li>截图中的第三方素材（插画、字体、人物肖像）也需你有使用权；出问题由投稿者负责。</li>
      </ul>
    </section>

    <section class="rules-sec">
      <h2>三、二维码和链接（最容易踩的一条）</h2>
      <p class="rules-sub">可以放</p>
      <ul class="rules-list is-ok">
        <li>微信小程序码（小程序二维码、太阳码）。</li>
        <li>你自己的官网、GitHub / Gitee 等开源仓库、应用商店页面链接。</li>
      </ul>
      <p class="rules-sub">不能放（发现即下架）</p>
      <ul class="rules-list is-no">
        <li>个人微信、微信群二维码，以及「扫码加我」类引导。</li>
        <li>公众号二维码、引导关注公众号。</li>
        <li>站外 App 下载码、带网址的二维码、邀请码、返利码。</li>
        <li>收款码、支付码、付费进群 / 付费领取类二维码。</li>
        <li>扫码领福利、抽奖、返利等带诱导的入口。</li>
      </ul>
      <p class="rules-note">橱窗只做展示：不提供跳转到第三方小程序的按钮，也不代作者导流。二维码是作品的一部分，能不能用、怎么用由作者负责。</p>
    </section>

    <section class="rules-sec">
      <h2>四、内容底线</h2>
      <ul class="rules-list">
        <li>不得上传违法违规、色情低俗、赌博诈骗、暴力血腥内容。</li>
        <li>不得侵犯他人著作权、商标权、肖像权；盗用他人作品直接删除。</li>
        <li>不得发布虚假信息，或夸大效果误导他人；不得冒用「官方」「认证」「合作」名义。</li>
        <li>不得把橱窗当纯广告位（同一账号批量刷同质化内容会被限流）。</li>
      </ul>
    </section>

    <section class="rules-sec">
      <h2>五、违规怎么处理</h2>
      <ol class="rules-list is-step">
        <li><b>入口不合规、文案有诱导</b>：作品先下架并通知修改，改好可重新提交，不影响账号。</li>
        <li><b>涉嫌侵权或盗用</b>：作品下架删除，保留提交记录，多次发生限制投稿。</li>
        <li><b>违法违规、诈骗、收款码、外链导流</b>：直接下架并封禁账号，已发的灯火等权益一并作废。</li>
        <li><b>涉嫌犯罪</b>：保存证据并配合有关部门调查。</li>
      </ol>
      <p class="rules-note">处理结果通过站内消息告知。封禁账号的作品不再公开展示，数据保留用于必要时的核查。</p>
    </section>

    <section class="rules-sec">
      <h2>六、举报、认领与移除</h2>
      <ul class="rules-list">
        <li>任何作品页底部都能<b>投诉</b>，选原因即可提交，不必登录。</li>
        <li><b>你是原作者</b>：投诉时选「我是原作者，希望移除」，附上能证明身份的材料（作品后台截图、发布记录等），我们优先处理，一般 1-2 个工作日。</li>
        <li>收到有效通知即先下架，不等核实完毕——下架不等于认定侵权，核实后该恢复的会恢复。</li>
        <li>作者对处理结果有异议，可通过站内消息附材料申诉，复核后恢复或维持。</li>
      </ul>
    </section>

    <section class="rules-sec">
      <h2>七、责任说明</h2>
      <ul class="rules-list">
        <li>勾选同意并提交，即表示你对该内容负责，并已取得必要授权。</li>
        <li>平台不对作品可用性、安全性做担保；出现的纠纷由作者与使用者自行解决。</li>
        <li>平台仅在展示所必需的范围内使用你提交的内容，不另作他用。</li>
      </ul>
    </section>

    <p class="rules-foot">规范会随平台规则调整，重要变更在站内通知。最近更新：2026-11-05。</p>
    <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a> <a class="btn-ghost" href="/howto">投稿指南 →</a></p>
  </div>
</div>`;
  sendHtml(res, shell(headHtml, block)); // 全量渲染：规范页是长期入口，真人也要能直接打开
});

function listPageRoute(kind) {
  return (req, res) => {
    const base = seo.baseUrl(req);
    const name = String(req.params.name || '');
    const valid = kind === 'c' ? categories.includes(name) : ALL_TYPES_LEGACY.includes(name);
    const pool = byNewest(visibleWorks().filter(w =>
      kind === 'c' ? catsOf(w).includes(name) : typesOf(w).includes(name)));

    if (!valid) {
      const headHtml = seo.head({
        title: `分类不存在 - ${seo.SITE_NAME}`,
        description: '该分类不存在。',
        canonical: base + '/',
        noindex: true
      });
      return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 24;
    const items = pool.slice((page - 1) * pageSize, page * pageSize);
    const hasMore = page * pageSize < pool.length;
    const pathBase = '/' + kind + '/' + encodeURIComponent(name);
    const canonical = base + pathBase + (page > 1 ? `?page=${page}` : '');

    const h1 = kind === 'c' ? `${name}类作品` : `${name}形态的作品`;
    const label = kind === 'c' ? `「${name}」分类` : `「${name}」形态`;
    // 少于 3 件的聚合页不参与收录，但保留 follow，让里面的作品链接还能被顺藤摸到
    const thin = pool.length < 3 || !items.length; // 空分页也算薄内容，不收录
    const facts = {
      count: pool.length,
      openSource: pool.filter(w => w.openSource === true).length,
      paid: pool.filter(w => !!w.paid).length,
      webCount: pool.filter(w => typesOf(w).includes('Web')).length,
      miniCount: pool.filter(w => typesOf(w).includes('小程序')).length,
      latestTitle: pool[0] ? pool[0].title : '',
      latestDate: String(pool[0] ? pool[0].createdAt : '').slice(0, 10)
    };
    const pageSuffix = page > 1 ? ` · 第 ${page} 页` : '';
    const title = `${h1}（共 ${pool.length} 件${pageSuffix}） - ${seo.SITE_NAME}`;
    // 描述里放站内真实统计，不再让 27 个聚合页共用一句换词模板
    const desc = truncateText(
      `共收录 ${pool.length} 件${label}的作品，其中 ${facts.openSource} 件开源、${facts.webCount} 件可直接在浏览器打开；` +
      `包含 ${pool.slice(0, 3).map(w => w.title).join('、')} 等。`, 150);

    const headHtml = seo.head({
      title,
      description: desc,
      noindex: thin ? 'follow' : false,
      keywords: [name, `${name}作品`, `${name}工具`].join(','),
      canonical,
      image: items[0] ? seo.absolute(base, items[0].image) : '',
      jsonLd: [
        seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: h1 }]),
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: h1,
          description: desc,
          url: canonical,
          isPartOf: { '@type': 'WebSite', name: seo.SITE_NAME, url: base + '/' },
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: items.length,
            itemListElement: items.map((w, i) => ({
              '@type': 'ListItem',
              position: (page - 1) * pageSize + i + 1,
              url: base + '/w/' + w.id,
              name: w.title
            }))
          }
        }
      ]
    });

    const prevHref = page > 1 ? pathBase + (page - 1 > 1 ? `?page=${page - 1}` : '') : '';
    const nextHref = hasMore ? `${pathBase}?page=${page + 1}` : '';

    sendHtml(res, seo.listPage(base, {
      title,
      description: desc,
      h1,
      activeName: name,
      kind,
      subtitle: `共 ${pool.length} 件${kind === 'c' ? '同分类' : '同形态'}作品，点击卡片查看详情与体验地址`,
      noindex: thin ? 'follow' : false,
      facts: thin ? null : facts,
      items: withAuthorNames(items),
      trail: [{ name: '首页', href: '/' }, { name: h1 }],
      page,
      hasMore,
      prevHref,
      nextHref,
      canonical,
      categories: kind === 'c' ? orderedCategories() : WORK_TYPES,
      types: WORK_TYPES
    }));
  };
}

app.get('/c/:name', listPageRoute('c'));
app.get('/t/:name', listPageRoute('t'));

// sitemap / robots / rss
// 邀请收录页：把投稿入口做成一张可转发的落地页，页面内直接生成分享海报。
// 页面 HTML / CSS 放在 invite-page.js（自包含），这里只喂真实统计与后台配置的形态清单，
// 保证「已收录 N 件」「N 位创作者」和形态标签不会和站内其它页面对不上。
const invitePage = require('./invite-page.js');
app.get('/invite', (req, res) => {
  const list = visibleWorks();
  const authorSet = new Set();
  list.forEach(w => { if (w.anonymous !== true && w.author) authorSet.add(w.author); });
  const page = invitePage.render({
    seo,
    base: seo.baseUrl(req),
    count: list.length,
    authors: authorSet.size,
    types: WORK_TYPES
  });
  sendHtml(res, shell(seo.head(page.head), page.block));
});

app.get('/sitemap.xml', (req, res) => {
  const base = seo.baseUrl(req);
  const all = byNewest(visibleWorks());
  const MIN_LIST_ITEMS = 3;  // 少于 3 件的分类/形态页已 noindex，别再往 sitemap 里塞
  const countOf = predicate => all.reduce((n, w) => n + (predicate(w) ? 1 : 0), 0);
  const lastmodOf = predicate => { const hit = all.find(predicate); return hit ? hit.createdAt : ''; };
  const catPred = c => w => catsOf(w).includes(c);
  const typePred = t => w => typesOf(w).includes(t);
  const categories = orderedCategories().filter(c => countOf(catPred(c)) >= MIN_LIST_ITEMS);
  const types = WORK_TYPES.filter(t => countOf(typePred(t)) >= MIN_LIST_ITEMS);
  const categoryLastmod = {}, typeLastmod = {};
  categories.forEach(c => { categoryLastmod[c] = lastmodOf(catPred(c)); });
  types.forEach(t => { typeLastmod[t] = lastmodOf(typePred(t)); });
  const authors = authorEntries().filter(a => countOf(w => w.author === a.name && w.anonymous !== true) >= 2);
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(
    seo.sitemapXml(base, {
      works: all,
      categories,
      types,
      authors,
      siteUpdated: all[0] ? all[0].createdAt : '',
      categoryLastmod,
      typeLastmod
    })
  );
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=86400')
    .send(seo.robotsTxt(seo.baseUrl(req)));
});

app.get('/feed.xml', (req, res) => {
  res.type('application/rss+xml').set('Cache-Control', 'public, max-age=1800')
    .send(seo.rssXml(seo.baseUrl(req), withAuthorNames(byNewest(visibleWorks()).slice(0, 30))));
});

// llms.txt：给 AI 抓取器一份明确的站点说明与公开入口清单（可选约定，不影响搜索引擎收录）
app.get('/llms.txt', (req, res) => {
  const base = seo.baseUrl(req);
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const newest = byNewest(visibleWorks()).slice(0, 12);
  const lines = [
    `# ${seo.SITE_NAME}`,
    '',
    `> ${seo.SITE_TAGLINE}。${seo.SITE_DESC}`,
    '',
    '收录范围：网站、小程序、App、智能体、桌面应用、浏览器扩展等由社区提交的作品；每件作品有独立详情页，含简介、截图、形态分类与体验入口。',
    '',
    '## 主要入口',
    `- 首页：${base}/`,
    `- 作品榜单：${base}/rank`,
    `- 小程序专栏：${base}/mini`,
    `- 投稿指南：${base}/howto`,
    `- 作品规范：${base}/rules`,
    `- 站点地图：${base}/sitemap.xml`,
    `- RSS：${base}/feed.xml`,
    '',
    '## 最近收录',
    ...newest.map(w => `- [${clean(w.title)}](${base}/w/${w.id}) - ${clean(w.category)} / ${clean(typesOf(w).join('、'))}`),
    '',
    '说明：这里只列公开可访问的链接；投稿、登录、灯火与推荐位等站内交互不在其列。'
  ];
  res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(lines.join('\n'));
});

app.get('/admin', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'frontend', 'admin.html'), 'utf-8'); }
  catch { return res.status(500).send('admin.html 缺失'); }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(withAssetVer(html));
});

// 兜底 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `页面不存在 - ${seo.SITE_NAME}`,
    description: '你访问的页面不存在。',
    canonical: base + '/',
    noindex: true
  });
  sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
});

function truncateText(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length <= n ? str : str.slice(0, n - 1).replace(/[，,。.、\s]+$/, '') + '…';
}

// 分享去重明细定期瘦身（只留最近 120 天），并顺手把内存里的积分落盘
pruneShare();
setInterval(() => {
  try { pruneShare(); writeJSON('share.json', shareData); } catch (e) { /* 忽略 */ }
}, 2 * 3600e3).unref();

// 积分兑换广告巡检：曝光额度投完 / 到 14 天兜底线 → 自动下线
try { expireRedemptions(); } catch (e) { /* 忽略 */ }
setInterval(() => { try { expireRedemptions(); } catch (e) { /* 忽略 */ } }, 60e3).unref();

// 上传作品奖励：启动时先补齐存量（一次性），之后 5 分钟一轮到期巡检发放
try { backfillUploadRewards(); } catch (e) { console.warn('上传奖励存量补齐失败', e); }
try { payUploadRewards(); } catch (e) { /* 忽略 */ }
setInterval(() => { try { payUploadRewards(); } catch (e) { /* 忽略 */ } }, 5 * 60e3).unref();

// ---------- 「即将上线」巡检 ----------
// 1) 平台上架审核中的作品：每 6 小时探一次链接，能打开就提醒作者「可以点我上线了」。
//    只提醒一次（probeNotifiedAt），避免作者被同一件事反复打扰。
const PROBE_INTERVAL = 6 * 3600e3;
let probing = false;
async function probeReviewing() {
  if (probing) return;   // 上一轮还没跑完（网络慢），跳过这一轮
  probing = true;
  try {
    const list = works.filter(w => stageOf(w) === 'reviewing' && w.link && !w.probeNotifiedAt && isPublished(w));
    for (const w of list) {
      let ok = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(w.link, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DreamWindowProbe/1.0)' } });
        clearTimeout(timer);
        ok = r.status > 0 && r.status < 400;
      } catch { ok = false; }
      w.probeCheckedAt = new Date().toISOString();
      if (ok) {
        w.probeNotifiedAt = new Date().toISOString();
        if (w.userId) {
          addNotice(w.userId, {
            kind: 'system',
            title: '你的作品好像已经上线了',
            text: `「${w.title}」的地址现在能打开了。确认没问题就去作品页点「我上线了」，它会从「即将上线」进入正式列表，而且会给催更的人发通知。`,
            workId: w.id
          });
        }
      }
    }
    saveWorks();
  } finally { probing = false; }
}

// 2) 开发中的预告：30 天没动静提醒作者，37 天仍没更新就藏起来（不删，作者更新即恢复）。
//    这是防「挂个预告占位再也不管」的唯一手段。
const WIP_WARN_DAYS = 30;
const WIP_HIDE_DAYS = 37;
function sweepWip() {
  let changed = false;
  const now = Date.now();
  for (const w of works) {
    if (stageOf(w) !== 'wip' || w.status === 'rejected') continue;
    const last = new Date(w.updatedAt || w.createdAt || 0).getTime();
    const days = (now - last) / 86400000;
    if (days >= WIP_HIDE_DAYS && !w.stale) {
      w.stale = true;                     // 从「即将上线」列表隐藏，详情页仍可访问
      changed = true;
      if (w.userId) addNotice(w.userId, {
        kind: 'system',
        title: '预告已被暂时收起',
        text: `「${w.title}」超过 ${WIP_HIDE_DAYS} 天没有更新进度，已经暂时从「即将上线」里收起。更新一次进度或点「我上线了」就会恢复。`,
        workId: w.id
      });
    } else if (days >= WIP_WARN_DAYS && !w.staleWarnedAt && !w.stale) {
      w.staleWarnedAt = new Date().toISOString();
      changed = true;
      if (w.userId) addNotice(w.userId, {
        kind: 'system',
        title: '预告卡很久没更新了',
        text: `「${w.title}」已经 ${Math.round(days)} 天没更新进度。如果还在做，去更新一下完成度；已经做好了就点「我上线了」。再 ${WIP_HIDE_DAYS - Math.round(days)} 天没动静会被暂时收起。`,
        workId: w.id
      });
    }
  }
  if (changed) saveWorks();
}

setTimeout(() => { try { probeReviewing(); } catch (e) { /* 忽略 */ } }, 90e3).unref();
setInterval(() => { try { probeReviewing(); } catch (e) { /* 忽略 */ } }, PROBE_INTERVAL).unref();
try { sweepWip(); } catch (e) { /* 忽略 */ }
setInterval(() => { try { sweepWip(); } catch (e) { /* 忽略 */ } }, 6 * 3600e3).unref();

// GitHub star 涨值自动发灯火：启动后先跑一轮（默认延迟 3 分钟，避开启动高峰；测试可用 STAR_SYNC_START_DELAY_MS 缩短），之后每 6 小时一轮
const STAR_SYNC_START_DELAY = Math.max(10e3, Number(process.env.STAR_SYNC_START_DELAY_MS) || 3 * 60e3);
setTimeout(() => { try { syncStarRewards(); } catch (e) { /* 忽略 */ } }, STAR_SYNC_START_DELAY).unref();
setInterval(() => { try { syncStarRewards(); } catch (e) { /* 忽略 */ } }, STAR_SYNC_INTERVAL).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`造梦橱窗已启动: http://localhost:${PORT}  (审核模式: ${REVIEW_MODE ? '开' : '关'})`);
  // 草稿过期清理：30 天没动过的草稿连同图片一起删（启动跑一次，量小不必上定时器）
  try { pruneDrafts(); } catch (e) { console.warn('[drafts] 过期清理失败:', e.message); }
  // 编年史公告：老用户一次性补推（key 去重，重启不重复打扰）
  try { broadcastChronicleOnce(); } catch (e) { console.warn('[notices] 编年史公告推送失败:', e.message); }
  try { broadcastLaunchAnnounceOnce(); } catch (e) { console.warn('[notices] 上线通告推送失败:', e.message); }
  // 编年史公告：补发到游客公告条（未登录访客也看得到，key 去重）
  try { seedChronicleGuestOnce(); } catch (e) { console.warn('[notices] 编年史游客公告补发失败:', e.message); }
  try { seedLaunchGuestOnce(); } catch (e) { console.warn('[notices] 上线通告游客补发失败:', e.message); }
});
