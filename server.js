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

const PORT = process.env.PORT || 3000;
const REVIEW_MODE = process.env.REVIEW_MODE === '1'; // 打开后新投稿需审核

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 后台口令：优先读环境变量 ADMIN_KEY，其次读 data/admin-key.txt（该目录不入库）
const ADMIN_KEY = (() => {
  if (process.env.ADMIN_KEY) return String(process.env.ADMIN_KEY).trim();
  try { return fs.readFileSync(path.join(DATA_DIR, 'admin-key.txt'), 'utf-8').trim(); }
  catch { return ''; }
})();

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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
let reports = readJSON('reports.json', []);
let tools = readJSON('tools.json', []);
let creators = readJSON('creators.json', []); // 认证创作者
let users = readJSON('users.json', []);        // 注册用户
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
const DEFAULT_CATEGORIES = ['效率工具', '生活助手', '内容创作', '学习教育', '娱乐游戏', '开发工具', '其他'];
let categories = readJSON('categories.json', DEFAULT_CATEGORIES);
if (!Array.isArray(categories) || !categories.length) categories = DEFAULT_CATEGORIES.slice();

// 作品形态：可在后台增删 / 调序 / 换图标（[{ name, icon }]）
const DEFAULT_TYPES = [
  { name: 'Web', icon: '🌐' },
  { name: 'iOS', icon: '🍎' },
  { name: 'Android', icon: '🤖' },
  { name: 'macOS', icon: '💻' },
  { name: 'Windows', icon: '🪟' },
  { name: 'Linux', icon: '🐧' },
  { name: '小程序', icon: '📱' },
  { name: '浏览器插件', icon: '🧩' },
  { name: '机器人', icon: '🦾' },
  { name: 'API', icon: '🔌' },
  { name: '其他', icon: '✨' }
];
let workTypes = readJSON('types.json', DEFAULT_TYPES.map(t => ({ ...t })));
(function normalizeWorkTypes() {
  if (!Array.isArray(workTypes)) workTypes = [];
  workTypes = workTypes
    .map(t => (typeof t === 'string' ? { name: t, icon: '' } : { name: String((t && t.name) || ''), icon: String((t && t.icon) || '') }))
    .filter(t => t.name);
  if (!workTypes.some(t => t.name === 'Web')) workTypes.unshift({ name: 'Web', icon: '🌐' });
  workTypes.forEach(t => { if (!t.icon) t.icon = '✨'; });
})();

function saveWorks() { writeJSON('works.json', works); }
function saveReports() { writeJSON('reports.json', reports); }
function saveTools() { writeJSON('tools.json', tools); }
function saveCategories() { writeJSON('categories.json', categories); }

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

// ---------- 站内消息 ----------
// 每个账号最多留 50 条，多了从最旧的丢；积分类消息带「变动后余额」，前端直接展示
const NOTICE_KEEP_PER_USER = 50;
function addNotice(userId, data) {
  if (!userId) return null;
  const n = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: String(userId),
    kind: (data && data.kind) || 'system',
    title: String((data && data.title) || '').slice(0, 60),
    text: String((data && data.text) || '').slice(0, 300),
    points: Number((data && data.points) || 0),   // 0 表示这条与积分无关
    delta: Number((data && data.delta) || 0),
    read: false,
    createdAt: new Date().toISOString()
  };
  notices.unshift(n);
  const mine = notices.filter(x => x.userId === n.userId);
  if (mine.length > NOTICE_KEEP_PER_USER) {
    const drop = new Set(mine.slice(NOTICE_KEEP_PER_USER).map(x => x.id));
    notices = notices.filter(x => !drop.has(x.id));
  }
  saveNotices();
  return n;
}

// ---------- 广告位定义 ----------
// 广告位（位置）是写死在前端页面里的固定空位，后台只能选择「把这支广告挂到哪个位置」，
// 这样版式可控，不会因为运营乱挂把页面撑坏。key 必须和 index.html 里的 data-ad-slot 一致。
const AD_SLOTS = [
  { key: 'home-top', name: '首页顶部横幅', where: '首页 Hero 下方、本周精选上方', size: '建议 1400 × 280' },
  { key: 'home-bottom', name: '首页列表底部', where: '作品列表末尾、加载更多上方', size: '建议 1400 × 240' },
  { key: 'detail', name: '作品详情页', where: '详情弹窗内、评论区上方', size: '建议 1200 × 240' },
  { key: 'rank', name: '榜单页顶部', where: '榜单标题下方', size: '建议 1400 × 240' },
  { key: 'footer', name: '全站页脚上方', where: '所有页面底部通栏', size: '建议 1400 × 200' }
];
const AD_SLOT_KEYS = AD_SLOTS.map(s => s.key);
if (!Array.isArray(ads)) ads = [];
// 广告形式：image = 图文（图片铺底），text = 纯文字卡片。老数据没有 kind 的按有没有图推断
ads.forEach(a => { if (a && a.kind !== 'image' && a.kind !== 'text') a.kind = a.image ? 'image' : 'text'; });

// ---------- 积分兑换广告位（展示 + 点击双计费） ----------
// 计费：展示每 10 次扣 2 分（兑换时按所选展示包预扣）；点击每次再扣 2 分（投放中实时从积分扣）。
// 点击扣分有总额上限（= 这单的展示费），烧到上限后点击不再计费，防止恶意点击把积分掏空。
// 位置目前只开放「作品详情页」；内容只能取自自己名下、已过审的站内作品，
// 标题/简介/封面直接从作品取，不能自定义文案或挂外链，也不用人工审稿。
const REDEEM_SHOW_VIEWS = 10;              // 展示：每 10 次
const REDEEM_SHOW_POINTS = 2;              // 2 分（单次展示约 0.2 分）
const REDEEM_CLICK_POINTS = 2;             // 点击：每次 2 分（单次是展示的 10 倍，点击更值钱）
const REDEEM_SHOW_PACKS = [50, 100, 200];  // 展示次数包
const REDEEM_CLICK_PACKS = [0, 5, 10, 20]; // 点击次数包（0 = 只买展示，不加购点击）
const REDEEM_SLOT_KEY = 'detail';          // 目前只开放详情页
const REDEEM_MAX_DAYS = 14;                // 兜底有效期：14 天没投完也下线（不退款）
const REDEEM_MAX_ACTIVE = 2;               // 每人同时最多 2 条在投

function redeemSlots() {
  return AD_SLOTS.filter(s => s.key === REDEEM_SLOT_KEY).map(s => ({
    key: s.key, name: s.name, where: s.where,
    showViews: REDEEM_SHOW_VIEWS, showPoints: REDEEM_SHOW_POINTS, clickPoints: REDEEM_CLICK_POINTS
  }));
}
// 展示费 = 展示次数 / 10 × 2（档位都是 10 的倍数，结果必为整数）
function redeemShowPriceOf(views) {
  return Math.round(views / REDEEM_SHOW_VIEWS * REDEEM_SHOW_POINTS);
}
// 点击费 = 点击次数 × 2
function redeemClickPriceOf(clicks) {
  return Math.max(0, clicks | 0) * REDEEM_CLICK_POINTS;
}
// 订单总额 = 展示费 + 点击费
function redeemPriceOf(views, clicks) {
  return redeemShowPriceOf(views) + redeemClickPriceOf(clicks);
}

// ---------- 用户 / 会话 ----------
const REMEMBER_TTL = 30 * 86400e3;   // 勾选「记住我」：30 天
const SESSION_TTL = 12 * 3600e3;     // 未勾选：12 小时（cookie 为会话级，关浏览器即失效）
const RESERVED_NAMES = ['admin', 'administrator', '管理员', 'root', 'system', '官方', 'official'];

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
function setSession(res, user, remember) {
  const sid = crypto.randomBytes(24).toString('hex');
  const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
  sessions[sid] = { uid: user.id, exp: Date.now() + ttl };
  // 顺手清理过期会话
  for (const k of Object.keys(sessions)) if (sessions[k].exp < Date.now()) delete sessions[k];
  saveSessions();
  // 勾了「记住我」才写 Max-Age（持久 cookie）；否则是会话 cookie，关浏览器即失效
  const maxAge = remember ? `; Max-Age=${30 * 86400}` : '';
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax${maxAge}`);
}
function clearSession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) { delete sessions[sid]; saveSessions(); }
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { res.status(401).json({ error: '请先登录' }); return null; }
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
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const rec = rateBuckets.get(key);
  if (!rec || now - rec.start > windowMs) {
    rateBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= limit;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
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

let visitSaveTimer = null;
function scheduleVisitSave() {
  if (visitSaveTimer) return;
  visitSaveTimer = setTimeout(() => {
    visitSaveTimer = null;
    try { writeJSON('visits.json', visits); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

function trackVisit(req) {
  const key = dateKey();
  const day = visits.days[key] || (visits.days[key] = { pv: 0, uv: {} });
  if (!day.uv) day.uv = {};
  day.pv = (day.pv || 0) + 1;
  const user = currentUser(req);
  const vid = user ? 'u:' + user.id : 'ip:' + clientIp(req);
  day.uv[vid] = 1;
  // 只保留最近 N 天
  const keys = Object.keys(visits.days).sort();
  while (keys.length > VISIT_RETENTION_DAYS) delete visits.days[keys.shift()];
  scheduleVisitSave();
}

function visitStats() {
  const days = visits.days || {};
  let pv = 0;
  const allUv = new Set();
  Object.values(days).forEach(d => {
    pv += d.pv || 0;
    Object.keys(d.uv || {}).forEach(k => allUv.add(k));
  });
  const today = days[dateKey()] || { pv: 0, uv: {} };
  return {
    pv, uv: allUv.size,
    pvToday: today.pv || 0,
    uvToday: Object.keys(today.uv || {}).length
  };
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

function trackWorkVisit(req, workId) {
  if (!workId || !works.some(w => w.id === workId)) return;
  const rec = workVisits[workId] || (workVisits[workId] = { pv: 0, uv: {}, days: {} });
  if (!rec.uv) rec.uv = {};
  if (!rec.days) rec.days = {};
  rec.pv = (rec.pv || 0) + 1;
  const user = currentUser(req);
  const vid = user ? 'u:' + user.id : 'ip:' + clientIp(req);
  rec.uv[vid] = 1;
  const dk = dateKey();
  const day = rec.days[dk] || (rec.days[dk] = { pv: 0, uv: {} });
  if (!day.uv) day.uv = {};
  day.pv = (day.pv || 0) + 1;
  day.uv[vid] = 1;
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
const SHARE_REG_POINTS = 20;         // 一个有效邀请注册
const SHARE_DAILY_VISIT_POINTS = 50; // 每人每天「访问」奖励上限
const SHARE_DAILY_REG_POINTS = 100;  // 每人每天「邀请注册」奖励上限
const SHARE_IP_PER_REF_DAY = 3;      // 同一 IP 对同一分享者：每天最多计 3 次访问
const SHARE_IP_TOTAL_DAY = 10;       // 同一 IP 在全站：每天最多计 10 次访问
const SHARE_IP_MAX_REGS = 2;         // 同一 IP 最多计 2 个邀请注册（防同屋批量注册）
const SHARE_IP_REF_MAX_REGS = 1;     // 同一 IP 对同一分享者最多计 1 个邀请注册
const SHARE_ATTR_DAYS = 7;           // 点击后 7 天内注册才算归因
const SHARE_LOG_MAX = 60;
const SHARE_RETENTION_DAYS = 120;    // IP 明细保留天数（只留去重用的近期记录）

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
function shareRecOf(uid) {
  const r = shareData.users[uid] || (shareData.users[uid] = { points: 0, visits: 0, regs: 0, works: {}, byDay: {}, pairs: {}, log: [] });
  if (!r.works) r.works = {};
  if (!r.byDay) r.byDay = {};
  if (!r.pairs) r.pairs = {};
  if (!Array.isArray(r.log)) r.log = [];
  return r;
}
function ipRecOf(ipk) {
  const r = shareData.ips[ipk] || (shareData.ips[ipk] = { v: {}, d: {}, t: {}, regs: 0, refRegs: {}, regIpUsers: [] });
  if (!r.v) r.v = {};
  if (!r.d) r.d = {};
  if (!r.t) r.t = {};
  if (!r.regs) r.regs = 0;
  if (!r.refRegs) r.refRegs = {};
  if (!Array.isArray(r.regIpUsers)) r.regIpUsers = [];
  return r;
}
function dayOf(rec) {
  const k = dateKey();
  if (!rec.byDay[k]) rec.byDay[k] = { visits: 0, regs: 0, vp: 0, rp: 0 };
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
    ['v', 'd', 't'].forEach(f => {
      Object.keys(r[f] || {}).forEach(k => {
        const m = k.match(/(\d{4}-\d{2}-\d{2})$/);
        if (m && m[1] < cutoff) delete r[f][k];
      });
    });
    if (r.attr && r.attr.at && Date.now() - r.attr.at > SHARE_ATTR_DAYS * 86400e3) delete r.attr;
    const empty = !Object.keys(r.v).length && !Object.keys(r.d).length && !Object.keys(r.t).length
      && !r.attr && !r.regs;
    if (empty) delete shareData.ips[ipk];
  });
  Object.keys(shareData.users).forEach(uid => {
    const r = shareData.users[uid];
    const keys = Object.keys(r.byDay || {}).sort();
    while (keys.length > SHARE_RETENTION_DAYS) delete r.byDay[keys.shift()];
  });
}

// 记录一次分享访问。返回 { credited, points, reason }
function creditShareVisit(req, refName, workId) {
  const refUser = resolveShareUser(refName);
  if (!refUser) return { credited: false, reason: 'no_ref' };
  const me = currentUser(req);
  if (me && me.id === refUser.id) return { credited: false, reason: 'self' }; // 自己点自己的链接不算
  const day = dateKey();
  const wk = String(workId || '-');
  const ipk = ipKeyOf(req);
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

  // 分享者当天访问奖励封顶
  const d = dayOf(rec);
  if (d.vp >= SHARE_DAILY_VISIT_POINTS) return { credited: false, reason: 'limit_daily' };

  ip.v[visitKey] = 1;
  ip.d[perRefKey] = (ip.d[perRefKey] || 0) + 1;
  ip.t[day] = (ip.t[day] || 0) + 1;
  if (pairKey) rec.pairs[pairKey] = 1;

  rec.visits = (rec.visits || 0) + 1;
  rec.works[wk] = (rec.works[wk] || 0) + 1;
  rec.points = (rec.points || 0) + SHARE_VISIT_POINTS;
  d.visits += 1;
  d.vp += SHARE_VISIT_POINTS;
  pushShareLog(rec, 'visit', wk, SHARE_VISIT_POINTS);
  saveShareSoon();
  return { credited: true, points: SHARE_VISIT_POINTS };
}

// 记录一次邀请注册。refName 来自注册请求 body 或该 IP 的首次触达
function creditShareRegister(req, newUser, refName) {
  const ipk = ipKeyOf(req);
  const ip = ipRecOf(ipk);
  if (newUser && !newUser.regIp) newUser.regIp = ipk;

  let refUser = resolveShareUser(refName);
  // 没有显式 ref 就用 7 天内的首次触达兜底
  if (!refUser && ip.attr && Date.now() - ip.attr.at <= SHARE_ATTR_DAYS * 86400e3) {
    refUser = users.find(u => u.id === ip.attr.uid) || null;
  }
  if (!refUser || !newUser) return { credited: false, reason: 'no_ref' };
  if (refUser.id === newUser.id) return { credited: false, reason: 'self' };
  // 同一台机器/同一出口 IP 上的账号互相邀请，不算（防小号互刷）
  if (refUser.regIp && refUser.regIp === ipk) return { credited: false, reason: 'same_ip' };

  if (ip.regs >= SHARE_IP_MAX_REGS) return { credited: false, reason: 'limit_ip' };
  if ((ip.refRegs[refUser.id] || 0) >= SHARE_IP_REF_MAX_REGS) return { credited: false, reason: 'limit_ip_ref' };

  const rec = shareRecOf(refUser.id);
  const d = dayOf(rec);
  if (d.rp >= SHARE_DAILY_REG_POINTS) return { credited: false, reason: 'limit_daily' };

  ip.regs += 1;
  ip.refRegs[refUser.id] = (ip.refRegs[refUser.id] || 0) + 1;
  if (!ip.regIpUsers.includes(newUser.id)) ip.regIpUsers.push(newUser.id);

  rec.regs = (rec.regs || 0) + 1;
  rec.points = (rec.points || 0) + SHARE_REG_POINTS;
  d.regs += 1;
  d.rp += SHARE_REG_POINTS;
  pushShareLog(rec, 'reg', '', SHARE_REG_POINTS);
  newUser.invitedBy = refUser.username;
  saveUsers();
  saveShareSoon();
  return { credited: true, points: SHARE_REG_POINTS, inviter: displayNameOf(refUser.username) };
}

// 分享榜：按积分排序，只展示昵称与公开数字
function shareBoard(limit = 10) {
  const rows = Object.keys(shareData.users).map(uid => {
    const u = users.find(x => x.id === uid);
    if (!u) return null;
    const r = shareData.users[uid];
    if (!r || !(r.points > 0)) return null;
    return {
      username: u.username,
      name: displayNameOf(u.username),
      points: r.points || 0,
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
    regs: r.regs || 0,
    works: r.works || {},
    byDay: r.byDay || {},
    rank: idx >= 0 ? idx + 1 : 0,
    totalRanked: board.length
  };
}

// ---------- 许愿墙 ----------
// 一句话说出「我想要一个……」，别人点「我也想要」表达需求热度；
// 有本事的创作者点「我来实现」认领，做完把作品挂上来，卡片自动变「已实现」。
let ideas = readJSON('ideas.json', []);
if (!Array.isArray(ideas)) ideas = [];
const IDEA_TITLE_MAX = 80;
const IDEA_KEEP_MAX = 2000;      // 最多保留条数
function saveIdeas() {
  if (ideas.length > IDEA_KEEP_MAX) ideas.length = IDEA_KEEP_MAX;
  writeJSON('ideas.json', ideas);
}
function ideaById(id) { return ideas.find(i => i.id === id) || null; }
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
    category: i.category || '',
    author: displayNameOf(i.author),
    mine: !!(user && i.userId && i.userId === user.id),
    wants: i.wants || 0,
    wanted: Array.isArray(i.wantKeys) && i.wantKeys.includes(key),
    status: i.status || 'open',
    claimer: i.claimer ? { name: i.claimer.name, mine: !!(user && i.claimer.userId === user.id) } : null,
    work: w ? { id: w.id, title: w.title } : null,
    createdAt: i.createdAt
  };
}

// ---------- 应用 ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

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
    // js/css 改用协商缓存：文件一有更新浏览器立即拿到新版，避免长期缓存旧代码
    res.setHeader('Cache-Control', 'no-cache');
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
let commentCounts = null;
function countComments(id) {
  if (!commentCounts) {
    commentCounts = {};
    for (const c of comments) commentCounts[c.workId] = (commentCounts[c.workId] || 0) + 1;
  }
  return commentCounts[id] || 0;
}
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

// 源码仓库地址：补协议、截断；标注开源时必须非空（由调用方校验）
function normRepo(v) {
  let s = String(v || '').trim();
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.slice(0, 500);
}

// 只返回对外的字段（user 传入时附加 owned 标记）
function publicWork(w, user) {
  const creator = creators.find(c => c.name === w.author);
  const types = typesOf(w);
  return {
    id: w.id, title: w.title, author: w.author, authorName: displayNameOf(w.author), category: w.category,
    anonymous: w.anonymous === true,   // 匿名发布：前台不显示真实作者
    categories: catsOf(w),
    type: types[0], types: types,
    intro: w.prompt || '', link: w.link || '',
    site: w.site || '',
    ...(w.links && Object.keys(w.links).length ? { links: w.links } : {}),
    image: w.image, thumb: w.thumb || w.image, qrcode: w.qrcode || '',
    images: Array.isArray(w.images) ? w.images.slice(0, 9) : [],
    likes: w.likes || 0, favs: w.favs || 0, commentCount: countComments(w.id), views: w.views || 0, featured: !!w.featured, pinned: !!w.pinned,
    openSource: w.openSource === true ? true : (w.openSource === false ? false : null),
    repo: w.repo || '',
    paid: !!w.paid,
    verified: !!creator,
    codesTotal: codesOf(w.id).length,
    codesLeft: codesOf(w.id).filter(c => c.status === 'available').length,
    faved: !!(user && Array.isArray(user.favs) && user.favs.includes(w.id)),
    owned: !!(user && w.userId && user.id === w.userId),
    claimed: !!w.userId,
    claimable: isClaimable(w),
    createdAt: w.createdAt
  };
}
function isVisible(w) { return (w.status || 'approved') === 'approved'; }
// SSR 用：带上展示名，页面显示昵称，作者页链接仍用账号
function withAuthorName(w) {
  const n = displayNameOf(w.author);
  return n === w.author ? w : { ...w, authorName: n };
}
const withAuthorNames = list => list.map(withAuthorName);
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

app.post('/api/register', (req, res) => {
  if (!rateLimit('reg:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  }
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (!NAME_RE.test(name)) return res.status(400).json({ error: '用户名需 2-20 位，可为中文、字母、数字、下划线' });
  if (RESERVED_NAMES.includes(name.toLowerCase())) return res.status(400).json({ error: '该用户名不可用' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (users.find(u => u.username === name)) return res.status(400).json({ error: '用户名已被占用' });

  const user = makeUser(name, String(password));
  user.regIp = ipKeyOf(req);
  users.push(user);
  saveUsers();
  // 邀请奖励：带上 ref 或者该 IP 7 天内有分享落地记录才计入（同 IP 有严格上限，见 creditShareRegister）
  const invite = creditShareRegister(req, user, (req.body && req.body.ref) || '');
  setSession(res, user, isRemember(req.body));
  res.status(201).json({
    username: user.username,
    invited: !!invite.credited,
    invitePoints: invite.credited ? SHARE_REG_POINTS : 0
  });
});

app.post('/api/login', (req, res) => {
  if (!rateLimit('login:' + clientIp(req), 20, 3600000)) {
    return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  }
  const { username, password } = req.body || {};
  const user = users.find(u => u.username === String(username || '').trim());
  // 用户名不存在：告诉前端「可一键转注册」（前端会展示确认提示，不会静默创建）
  if (!user) return res.status(404).json({ error: '该用户名还没有注册', notFound: true });
  if (!checkPassword(user, String(password || ''))) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  setSession(res, user, isRemember(req.body));
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
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
        worksCount: works.filter(w => w.userId === user.id && !w.deleted).length
      }
    : { user: null });
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

app.post('/api/me/nickname', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('nick:' + clientIp(req), 10, 3600e3)) {
    return res.status(429).json({ error: '改得太频繁了，稍后再试' });
  }
  const raw = String((req.body && req.body.nickname) || '').replace(/[<>\r\n\t]/g, '').trim();
  // 传空 = 恢复默认（显示账号名），随时可以恢复，不受冷却限制
  const back = !raw || raw === user.username;
  if (!back) {
    if (!NICK_RE.test(raw)) {
      return res.status(400).json({ error: '昵称需 2-16 个字，可用中文、字母、数字、下划线、短横线、空格' });
    }
    if (RESERVED_NAMES.includes(raw.toLowerCase())) {
      return res.status(400).json({ error: '这个昵称不可用，换一个吧' });
    }
    if (hitSensitive(raw)) return res.status(400).json({ error: '昵称包含敏感词，换一个吧' });
    // 昵称不能跟别人的账号名一模一样，否则在页面上分不清是谁（防冒名）
    const clash = users.find(u => u.id !== user.id && u.username === raw);
    if (clash) return res.status(400).json({ error: '这个昵称和别人的账号名重了，换一个吧' });
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
  if (!checkPassword(user, String(currentPassword || ''))) {
    return res.status(400).json({ error: '当前密码不正确' });
  }
  const np = String(newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (np.length > 64) return res.status(400).json({ error: '新密码最多 64 位' });
  if (checkPassword(user, np)) return res.status(400).json({ error: '新密码不能和当前密码一样' });
  // 换新盐重新哈希
  user.salt = crypto.randomBytes(16).toString('hex');
  user.pass = hashPassword(np, user.salt);
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

// ---- 注销账号（不可恢复） ----
// 双确认：密码 + 完整账号名。作品可选「保留（解除归属，署名保留）」或「一并删除」；
// 评论/许愿墙内容保留但匿名化；认领申请、广告投放、积分与分享记录、被领兑换码一并清理。
const DELETED_AUTHOR = '已注销用户';

app.post('/api/me/delete', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('delacct:' + user.id, 5, 3600e3)) {
    return res.status(429).json({ error: '操作太频繁了，请稍后再试' });
  }
  const body = req.body || {};
  if (String(body.confirmName || '').trim() !== user.username) {
    return res.status(400).json({ error: '请完整输入你的账号名以确认注销' });
  }
  if (!checkPassword(user, String(body.password || ''))) {
    return res.status(400).json({ error: '密码不正确' });
  }

  const wipeWorks = body.deleteWorks === true || String(body.deleteWorks) === '1';
  const mine = works.filter(w => w.userId === user.id && !w.deleted);
  let worksDeleted = 0;

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

  // 评论 / 许愿墙：内容保留，作者名匿名化（不留下昵称线索）
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

app.post('/api/works/:id/claim', (req, res) => {
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
  const claim = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    userId: user.id,
    username: user.username,
    evidence: evidence.slice(0, 1000),
    contact: String((req.body && req.body.contact) || '').trim().slice(0, 100),
    status: 'pending',
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
    items: mine.slice(0, 30).map(n => ({
      id: n.id, kind: n.kind, title: n.title, text: n.text,
      points: n.points || 0, delta: n.delta || 0, read: !!n.read, createdAt: n.createdAt
    })),
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
  res.json({ ok: true, changed });
});

app.get('/api/me/claims', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json(claims.filter(c => c.userId === user.id)
    .map(c => ({ id: c.id, workId: c.workId, status: c.status, createdAt: c.createdAt })));
});

// 作者数据看板：我发布 / 已认领的作品，含累计数据与近 14 天浏览趋势
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
      online: isVisible(w),                       // false = 审核中/未上线
      views: w.views || 0,
      likes: w.likes || 0,
      favs: w.favs || 0,
      comments: countComments(w.id),
      uv: rec.uv ? Object.keys(rec.uv).length : 0,
      shareVisits: myShareWorks[w.id] || 0,       // 这件作品被分享后带来的有效访问
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
    pv7: a.pv7 + it.pv7
  }), { works: 0, views: 0, likes: 0, favs: 0, comments: 0, shareVisits: 0, pv7: 0 });

  const trend = days.map((_, i) => items.reduce((s, it) => s + it.trend[i], 0));
  const share = shareStatsOf(user.id);
  res.json({
    totals: { ...totals, shareRegs: share.regs, points: share.points },
    days, trend,
    share: { points: share.points, visits: share.visits, regs: share.regs, rank: share.rank, totalRanked: share.totalRanked },
    checkin: checkinView(user),
    board: shareBoard(10),
    works: items.sort((a, b) => b.views - a.views)
  });
});

// 分类
// 前端每次页面浏览上报一次（PV +1；UV 按账号/IP 去重）
app.post('/api/track', (req, res) => {
  const p = String((req.body && req.body.path) || '/');
  if (p.startsWith('/admin')) return res.json({ ok: true, skipped: true });
  if (!rateLimit('track:' + clientIp(req), 600, 3600000)) return res.json({ ok: true, skipped: true });
  // site:false → 只记作品维度，不重复计站点 PV（弹窗打开作品时用）
  if (!(req.body && req.body.site === false)) trackVisit(req);
  // 作品详情页额外记一份作品维度 PV / UV
  let wid = String((req.body && req.body.workId) || '');
  if (!wid) {
    const m = p.match(/^\/w\/([A-Za-z0-9_-]+)/);
    if (m) wid = m[1];
  }
  if (wid) trackWorkVisit(req, wid);
  res.json({ ok: true });
});

// ---- 分享归因：访客带着 ?ref= 落地时上报一次 ----
// 前端只在「首次落地 + 本机没记过这条 ref/work」时调，所以请求量很小；这里仍做限流兜底。
app.post('/api/ref/visit', (req, res) => {
  const ref = String((req.body && req.body.ref) || '').trim().slice(0, 30);
  const workId = String((req.body && req.body.workId) || '').trim().slice(0, 40);
  if (!ref) return res.json({ ok: true, credited: false });
  if (!rateLimit('refvisit:' + clientIp(req), 120, 3600e3)) return res.json({ ok: true, credited: false });
  const r = creditShareVisit(req, ref, workId);
  res.json({ ok: true, credited: !!r.credited, points: r.points || 0 });
});

// 分享达人榜（公开，只给昵称和公开数字）
app.get('/api/shareboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ board: shareBoard(10) });
});

// ---- 许愿墙 ----
// 列表：默认按「想要的人多」排序，可按最新；支持 limit
app.get('/api/ideas', (req, res) => {
  const sort = req.query.sort === 'new' ? 'new' : 'hot';
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const user = currentUser(req);
  const list = ideas.filter(i => !i.hidden);
  const sorted = list.slice().sort((a, b) => {
    if (sort === 'new') return new Date(b.createdAt) - new Date(a.createdAt);
    const d = (b.wants || 0) - (a.wants || 0);
    return d !== 0 ? d : new Date(b.createdAt) - new Date(a.createdAt);
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total: list.length, items: sorted.slice(0, limit).map(i => publicIdea(i, req, user)) });
});

// 发布想法：需登录，每人每天最多 5 条
app.post('/api/ideas', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('idea:' + user.id, 5, 86400e3)) {
    return res.status(429).json({ error: '今天发的想法有点多了，明天再来吧' });
  }
  const title = String((req.body && req.body.title) || '').replace(/\s+/g, ' ').trim();
  if (title.length < 4) return res.status(400).json({ error: '想法至少 4 个字，说清楚一点' });
  if (title.length > IDEA_TITLE_MAX) return res.status(400).json({ error: `想法最多 ${IDEA_TITLE_MAX} 个字` });
  if (hitSensitive(title)) return res.status(400).json({ error: '内容包含敏感词，改一下再发' });
  // 同一句话不许重复刷屏
  if (ideas.some(i => i.userId === user.id && i.title === title)) {
    return res.status(400).json({ error: '你已经发过一样的想法了' });
  }
  let category = String((req.body && req.body.category) || '').trim();
  if (category && !categories.includes(category)) category = '';

  const idea = {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title,
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
  saveIdeas();
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
    saveIdeas();
    return res.json(publicIdea(idea, req, user));
  }
  if (!works.some(w => w.id === wid)) return res.status(400).json({ error: '没找到这个作品，检查一下链接' });
  idea.workId = wid;
  idea.status = 'done';
  saveIdeas();
  res.json(publicIdea(idea, req, user));
});

// 删除：提出者本人或管理员
app.delete('/api/ideas/:id', (req, res) => {
  const idea = ideaById(req.params.id);
  if (!idea) return res.status(404).json({ error: '想法不存在' });
  const user = currentUser(req);
  if (!(user && idea.userId === user.id) && !isAdmin(req)) return res.status(403).json({ error: '无权删除' });
  ideas = ideas.filter(i => i.id !== idea.id);
  saveIdeas();
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

// 分类：对外顺序固定把「其他」放最后
const LAST_CATEGORY = '其他';
function orderedCategories() {
  const rest = categories.filter(c => c !== LAST_CATEGORY);
  return categories.includes(LAST_CATEGORY) ? [...rest, LAST_CATEGORY] : rest;
}

app.get('/api/categories', (req, res) => res.json(['全部', ...orderedCategories()]));
app.post('/api/categories', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '分类名不能为空' });
  if (categories.includes(name)) return res.status(400).json({ error: '分类已存在' });
  // 新分类插在「其他」前面，保证「其他」始终最后一个
  const idx = categories.indexOf(LAST_CATEGORY);
  if (idx === -1) categories.push(name); else categories.splice(idx, 0, name);
  saveCategories();
  res.status(201).json(['全部', ...orderedCategories()]);
});

// 形态
app.get('/api/types', (req, res) => res.json(['全部', ...WORK_TYPES]));
// 形态元数据（名称 + 图标），供前端渲染 chips / 徽章
app.get('/api/type-meta', (req, res) => {
  const counts = {};
  works.filter(isVisible).forEach(w => typesOf(w).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  res.json(workTypes.map(t => ({ name: t.name, icon: t.icon, count: counts[t.name] || 0 })));
});
// 推荐位（工具/资源）
app.get('/api/tools', (req, res) => res.json(tools.filter(t => t.active !== false)));

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
    source: a.source || 'admin'   // 前台据此区分「广告」（运营）和「站内推广」（积分兑换）
  };
}
function activeAds() {
  const now = Date.now();
  return ads
    .filter(a => a && a.active !== false && a.url && AD_SLOT_KEYS.includes(a.slot))
    // 积分兑换的广告还有两道闸：曝光额度没用完、没到兜底有效期
    .filter(a => a.source !== 'redeem' || ((a.budget || 0) > 0 && !(a.endsAt && a.endsAt < now)))
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

// 访客身份：登录用户按账号（多设备算 1 人），未登录按 IP —— 与站点 UV 一致
function adVisitorKey(req) {
  const user = currentUser(req);
  return user ? 'u:' + user.id : 'ip:' + clientIp(req);
}

function trackAdShow(adId, req) {
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
  const ad = ads.find(a => a.id === adId);
  if (ad && ad.source === 'redeem' && (ad.budget || 0) > 0) {
    ad.budget = Math.max(0, (ad.budget || 0) - 1);
    if (ad.budget <= 0) {
      ad.active = false;
      finishRedemption(ad.redemptionId, 'used_up');
    }
    scheduleAdSave();
  }
}

// 单支广告的统计：累计 PV / UV、今日 PV / UV、近 7 天每天 PV
function adStatsOf(adId) {
  const today = dateKey();
  let pv = 0;
  const uv = new Set();
  let todayPv = 0, todayUv = 0;
  Object.keys(adStats).forEach(d => {
    const st = adStats[d] && adStats[d][adId];
    if (!st) return;
    pv += st.pv || 0;
    Object.keys(st.uv || {}).forEach(k => uv.add(k));
    if (d === today) { todayPv = st.pv || 0; todayUv = Object.keys(st.uv || {}).length; }
  });
  return { pv, uv: uv.size, todayPv, todayUv };
}

app.get('/api/ads', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ slots: AD_SLOTS, ads: activeAds().map(publicAd) });
});

// 曝光上报：每次展示都记 PV，UV 由访客身份去重。
// 只做一个很宽松的防刷（同 IP 同广告 60 秒最多记 3 次），正常浏览完全不受影响。
app.post('/api/ads/:id/impression', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  if (!rateLimit('ad-pv:' + clientIp(req) + ':' + a.id, 3, 60000)) {
    return res.json({ ok: true, counted: false });
  }
  trackAdShow(a.id, req);
  res.json({ ok: true, counted: true });
});

// 点击：同一 IP 对同一支广告 60 秒内只记一次。
// 积分兑换的广告，点击额度是兑换时一起买好的：用一次扣一次额度，不额外扣积分；
// 额度用完后广告照常展示，点击只计数（不再计费），避免恶意点击把人积分掏空。
app.post('/api/ads/:id/click', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  if (rateLimit('ad-clk:' + clientIp(req) + ':' + a.id, 1, 60000)) {
    a.clicks = (a.clicks || 0) + 1;
    scheduleAdSave();
    if (a.source === 'redeem' && a.redemptionId) {
      const r = redemptions.find(x => x.id === a.redemptionId && x.status === 'active');
      if (r && (a.clickLeft || 0) > 0) {
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


// ---------- 积分兑换广告位（按展示次数结算） ----------
// 积分账本统一走分享积分：兑换扣分、撤下退分都会进「分享明细」，用户能查得到。
function addPoints(uid, delta, kind, workId) {
  const rec = shareRecOf(uid);
  rec.points = Math.max(0, (rec.points || 0) + delta);
  pushShareLog(rec, kind, workId, delta);
  saveShareSoon();
  return rec.points;
}

// ---------- 每日签到 ----------
// 连续签到：基础每天 2 分，连续第 7 天额外 +6（一轮 7 天，第 8 天重新算第 1 天）
// 断签（昨天没签）从头开始；积分账本同样走 share.json，签到记录写进「分享明细」
const CHECKIN_BASE = 2;
const CHECKIN_BONUS = 6;
const CHECKIN_CYCLE = 7;

function cycleDayOf(streak) { return ((Math.max(1, streak) - 1) % CHECKIN_CYCLE) + 1; }

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
  const reward = CHECKIN_BASE + (dayInCycle === CHECKIN_CYCLE ? CHECKIN_BONUS : 0);
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  return {
    done, streak, dayInCycle, cycle: CHECKIN_CYCLE,
    todayPoints: reward, bonusPoints: CHECKIN_BONUS, total: ck.total || 0,
    nextAt: tomorrow.getTime()
  };
}

app.get('/api/me/checkin', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  res.set('Cache-Control', 'no-store');
  res.json({ ...checkinView(user), points: shareStatsOf(user.id).points });
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
  const reward = CHECKIN_BASE + (dayInCycle === CHECKIN_CYCLE ? CHECKIN_BONUS : 0);
  ck.last = today;
  ck.streak = streak;
  ck.total = (ck.total || 0) + reward;
  const points = addPoints(user.id, reward, 'checkin');
  res.json({ ok: true, reward, streak, dayInCycle, cycle: CHECKIN_CYCLE, points, ...checkinView(user) });
});

// 订单收尾：只处理还在进行中的，避免重复结账
function finishRedemption(redemptionId, status) {
  const r = redemptions.find(x => x.id === redemptionId);
  if (!r || r.status !== 'active') return null;
  const ad = ads.find(a => a.id === r.adId);
  if (status === 'used_up' || status === 'expired') {
    r.used = Math.max(0, (r.views || 0) - ((ad && ad.budget) || 0));
    r.clickUsed = Math.max(0, (r.clicks || 0) - ((ad && ad.clickLeft) || 0));
    if (status === 'expired') r.used = r.views;   // 到期没投完也按已用满记（不退款）
  }
  r.status = status;
  r.endedAt = Date.now();
  saveRedemptions();
  return r;
}

// 主动撤下 / 后台下架：没用完的展示次数和点击额度都按原价折算退分，已用掉的不退
function refundRedemption(r, status) {
  const ad = ads.find(a => a.id === r.adId);
  const used = Math.max(0, (r.views || 0) - ((ad && ad.budget) || 0));
  const left = Math.max(0, (r.views || 0) - used);
  const leftClicks = Math.max(0, ad ? (ad.clickLeft || 0) : (r.clicks || 0));
  let back = Math.floor(left / REDEEM_SHOW_VIEWS * REDEEM_SHOW_POINTS) + leftClicks * REDEEM_CLICK_POINTS;
  back = Math.min(back, r.price || 0);
  r.used = used;
  r.clickUsed = Math.max(0, (r.clicks || 0) - leftClicks);
  r.status = status;
  r.endedAt = Date.now();
  r.refunded = back;
  saveRedemptions();
  if (back > 0) addPoints(r.userId, back, 'refund', r.workId);
  return back;
}

// 兜底巡检：到期或额度耗尽的兑换广告统一下线。启动时跑一次，之后每分钟一次。
function expireRedemptions() {
  const now = Date.now();
  let changed = false;
  redemptions.forEach(r => {
    if (r.status !== 'active' || !r.endsAt || r.endsAt > now) return;
    const ad = ads.find(a => a.id === r.adId);
    if (ad && ad.active !== false) { ad.active = false; scheduleAdSave(); }
    r.used = r.views || 0;
    r.status = 'expired';
    r.endedAt = now;
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
}

// 我的投放列表：剩余曝光、已展示、点击都实时算
function myRedemptionList(user) {
  return redemptions.filter(r => r.userId === user.id)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(r => {
      const ad = ads.find(a => a.id === r.adId);
      const st = ad ? adStatsOf(ad.id) : { pv: 0, uv: 0 };
      const slot = AD_SLOTS.find(s => s.key === r.slot) || {};
      const w = works.find(x => x.id === r.workId) || {};
      const used = r.status === 'active' ? Math.max(0, (r.views || 0) - ((ad && ad.budget) || 0)) : (r.used || 0);
      const clicks = r.clicks || 0;
      const clickLeft = ad ? Math.max(0, ad.clickLeft || 0) : Math.max(0, clicks - (r.clickUsed || 0));
      return {
        id: r.id, workId: r.workId, workTitle: w.title || '（作品已下线）',
        slot: r.slot, slotName: slot.name || r.slot,
        views: r.views || 0, used, left: Math.max(0, (r.views || 0) - used),
        clicks, clickLeft, clickUsed: Math.max(0, clicks - clickLeft),
        showPrice: r.showPrice || 0, clickPrice: r.clickPrice || 0,
        price: r.price || 0, status: r.status, refunded: r.refunded || 0,
        createdAt: r.createdAt, endsAt: r.endsAt,
        pv: st.pv || 0, uv: st.uv || 0
      };
    });
}

function redeemPayload(user) {
  return {
    showViews: REDEEM_SHOW_VIEWS,
    showPoints: REDEEM_SHOW_POINTS,
    clickPoints: REDEEM_CLICK_POINTS,
    showPacks: REDEEM_SHOW_PACKS,
    clickPacks: REDEEM_CLICK_PACKS,
    maxActive: REDEEM_MAX_ACTIVE,
    maxDays: REDEEM_MAX_DAYS,
    slots: redeemSlots(),
    points: user ? shareStatsOf(user.id).points : 0,
    // 能投的只有自己名下、已过审的作品
    works: user ? works.filter(w => w.userId === user.id && !w.deleted && isVisible(w))
      .map(w => ({ id: w.id, title: w.title, thumb: w.thumb || w.image || '', category: w.category || '' })) : [],
    mine: user ? myRedemptionList(user) : []
  };
}

app.get('/api/redeem/options', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(redeemPayload(currentUser(req)));
});

// 兑换：展示费 + 点击费一次付清 → 生成一条广告（内容取自作品）→ 立刻上线
app.post('/api/redeem', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('redeem:' + user.id, 6, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const body = req.body || {};
  const views = parseInt(body.views, 10) > 0 ? parseInt(body.views, 10) : 0;
  const clicks = parseInt(body.clicks, 10) > 0 ? parseInt(body.clicks, 10) : 0;
  const workId = String(body.workId || '');

  // 二选一：要么买展示包，要么买点击包，不能同时买
  if (views > 0 && clicks > 0) return res.status(400).json({ error: '展示包和点击包二选一，不能同时买' });
  if (views > 0) {
    if (!REDEEM_SHOW_PACKS.includes(views)) return res.status(400).json({ error: '展示次数档位不对' });
  } else if (clicks > 0) {
    if (!REDEEM_CLICK_PACKS.includes(clicks)) return res.status(400).json({ error: '点击次数档位不对' });
  } else {
    return res.status(400).json({ error: '请先选一个套餐：展示包或点击包' });
  }
  const work = works.find(w => w.id === workId);
  if (!work || work.deleted) return res.status(400).json({ error: '作品不存在' });
  if (work.userId !== user.id) return res.status(400).json({ error: '只能推广自己名下的作品' });
  if (!isVisible(work)) return res.status(400).json({ error: '这件作品还在审核中，上线后才能投放' });

  const slot = REDEEM_SLOT_KEY;
  expireRedemptions();
  const active = redemptions.filter(r => r.userId === user.id && r.status === 'active');
  if (active.length >= REDEEM_MAX_ACTIVE) {
    return res.status(400).json({ error: `同时最多 ${REDEEM_MAX_ACTIVE} 条投放，先等其中一条投完或手动撤下` });
  }
  if (active.some(r => r.workId === workId)) {
    return res.status(400).json({ error: '这件作品已经在投放中，等它投完再来' });
  }

  const showPrice = redeemShowPriceOf(views);
  const clickPrice = redeemClickPriceOf(clicks);
  const price = showPrice + clickPrice;
  const points = shareStatsOf(user.id).points;
  if (points < price) return res.status(400).json({ error: `积分不够：需要 ${price} 分，你还有 ${points} 分` });

  const now = Date.now();
  const redemptionId = 'rd' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const adId = 'ad' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const img = work.thumb || work.image || '';
  const ad = {
    id: adId,
    slot,
    kind: img ? 'image' : 'text',
    title: work.title,
    desc: truncateText(work.prompt || work.desc || '', 60),
    image: img,
    url: '/w/' + encodeURIComponent(work.id),
    cta: '看看这个作品',
    active: true,
    source: 'redeem',       // 后台据此区分「运营投放」与「积分兑换」
    ownerId: user.id,
    redemptionId,
    budget: views,          // 剩余展示次数，被看到一次扣 1
    clickLeft: clicks,      // 剩余点击额度，被点一次扣 1
    endsAt: now + REDEEM_MAX_DAYS * 86400e3,
    sort: adsOfSlot(slot).length,
    clicks: 0,
    createdAt: new Date(now).toISOString()
  };
  ads.push(ad);
  saveAds();
  redemptions.push({
    id: redemptionId, adId, userId: user.id, workId: work.id, slot,
    views, clicks, showPrice, clickPrice, price,
    used: 0, clickUsed: 0, status: 'active',
    createdAt: now, endsAt: ad.endsAt
  });
  saveRedemptions();
  addPoints(user.id, -price, 'redeem', work.id);
  res.json({ ok: true, ad: publicAd(ad), ...redeemPayload(user) });
});

// 撤下：按剩余展示退分（点击已消耗的不退）
app.post('/api/me/ads/:id/cancel', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const r = redemptions.find(x => x.id === req.params.id && x.userId === user.id);
  if (!r) return res.status(404).json({ error: '找不到这条投放' });
  if (r.status !== 'active') return res.status(400).json({ error: '这条投放已经结束了' });
  const ad = ads.find(a => a.id === r.adId);
  if (ad) { ad.active = false; scheduleAdSave(); saveAds(); }
  const back = refundRedemption(r, 'cancelled');
  res.json({ ok: true, refunded: back, ...redeemPayload(user) });
});


// 作品列表：搜索 + 筛选 + 分页 + 排序
app.get('/api/works', (req, res) => {
  const { q, category, type, sort } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  // pageSize=all（兼容旧的 limit=500）→ 返回全部，用于全量统计
  const rawSize = String(req.query.pageSize || req.query.limit || '15');
  const pageSize = rawSize === 'all' ? Number.MAX_SAFE_INTEGER : Math.min(48, Math.max(1, parseInt(rawSize) || 15));

  const user = currentUser(req);
  let list = filterBlocked(works.filter(isVisible), user);
  if (category && category !== '全部') list = list.filter(w => catsOf(w).includes(category));
  if (type && type !== '全部') list = list.filter(w => typesOf(w).includes(type));
  // 是否开源筛选：open → 标注开源；closed → 非开源（含未标注的老作品）
  if (req.query.os === 'open') list = list.filter(w => w.openSource === true);
  else if (req.query.os === 'closed') list = list.filter(w => w.openSource !== true);
  // 只看我收藏的（需登录，未登录返回空列表）
  if (req.query.fav === '1') {
    const favIds = new Set(user && Array.isArray(user.favs) ? user.favs : []);
    list = list.filter(w => favIds.has(w.id));
  }
  if (q) {
    const kw = String(q).toLowerCase().trim();
    list = list.filter(w =>
      [w.title, w.author, w.prompt, catsOf(w).join(' ')].some(f => String(f || '').toLowerCase().includes(kw))
    );
  }

  if (sort === 'hot') list.sort((a, b) => score(b) - score(a));
  else list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // 置顶优先（最新列表里）
  if (sort !== 'hot') list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  const total = list.length;
  const items = list.slice((page - 1) * pageSize, page * pageSize).map(w => publicWork(w, user));
  res.json({ items, total, page, pageSize, hasMore: page * pageSize < total });
});

// 本周精选：管理员勾选的精选作品固定放最后，其余按数据自动补充
//   来源 = 管理员精选 ＋「近 7 天访客（UV）最多的 10 个」＋「点赞最多的 5 个」＋「收藏最多的 5 个」，去重合并
//   顺序：非站方作品按 UV＋收藏×5＋点赞×2 综合排序在前，管理员精选压轴（内部也按热度排）；上限 15 个
const FEATURED_TOP = 15;
const FEATURED_DAYS = 7;
const FEATURED_UV = 10;
const FEATURED_EACH = 5;
app.get('/api/featured', (req, res) => {
  const user = currentUser(req);
  const visible = filterBlocked(works.filter(isVisible), user);
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
  rows.filter(r => r.w.featured).sort((a, b) => heat(b) - heat(a)).forEach(r => merged.set(r.w.id, r));
  [byUv, byLikes, byFavs].forEach(list => list.forEach(r => { if (!merged.has(r.w.id)) merged.set(r.w.id, r); }));
  if (merged.size < FEATURED_TOP) {
    rows.filter(r => !merged.has(r.w.id))
      .sort((a, b) => heat(b) - heat(a))
      .slice(0, FEATURED_TOP - merged.size)
      .forEach(r => merged.set(r.w.id, r));
  }
  // 非站方作品按 UV＋收藏×5＋点赞×2 热度排序在前，站方精选压轴放最后（内部也按热度），
  // 避免按来源分段导致交界处数字忽高忽低
  const list = [...merged.values()]
    .sort((a, b) => ((a.w.featured ? 1 : 0) - (b.w.featured ? 1 : 0)) || heat(b) - heat(a))
    .slice(0, FEATURED_TOP)
    .map(r => ({ ...publicWork(r.w, user), uv7: r.uv7, pv7: r.pv7, adminPick: !!r.w.featured }));
  res.json({ days: FEATURED_DAYS, list });
});

// 榜单：period = week / month / all；by = hot（综合）/ likes（点赞）/ favs（收藏）/ pv / uv
const RANK_BY = {
  hot: (a, b) => score(b) - score(a),
  likes: (a, b) => (b.likes || 0) - (a.likes || 0) || (b.favs || 0) - (a.favs || 0),
  favs: (a, b) => (b.favs || 0) - (a.favs || 0) || (b.likes || 0) - (a.likes || 0),
  // PV / UV 默认按全部口径（/api/rank 里会按 period 覆盖）
  pv: (a, b) => workPvUv(b.id, 36500).pv - workPvUv(a.id, 36500).pv || score(b) - score(a),
  uv: (a, b) => workPvUv(b.id, 36500).uv - workPvUv(a.id, 36500).uv || score(b) - score(a)
};
app.get('/api/rank', (req, res) => {
  const period = ['week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'week';
  const by = Object.prototype.hasOwnProperty.call(RANK_BY, req.query.by) ? req.query.by : 'hot';
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 36500;
  const since = Date.now() - days * 86400000;
  const user = currentUser(req);
  const usePvUv = by === 'pv' || by === 'uv';
  const metric = w => workPvUv(w.id, days)[by];
  const list = filterBlocked(works.filter(w => isVisible(w) && new Date(w.createdAt).getTime() >= since), user)
    .sort((a, b) => (usePvUv ? metric(b) - metric(a) : RANK_BY[by](a, b)) || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit)
    .map((w, i) => {
      const m = workPvUv(w.id, days);
      return { ...publicWork(w, user), rank: i + 1, pv: m.pv, uv: m.uv };
    });
  res.json(list);
});

function score(w) { return (w.likes || 0) * 3 + (w.favs || 0) * 4 + (w.views || 0); }

// 作者主页
app.get('/api/authors/:name', (req, res) => {
  const name = req.params.name;
  const user = currentUser(req);
  const list = filterBlocked(works.filter(w => isVisible(w) && w.author === name), user)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(w => publicWork(w, user));
  const creator = creators.find(c => c.name === name);
  res.json({
    name,
    displayName: displayNameOf(name),
    verified: !!creator,
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
  if (!w || (!isVisible(w) && !isAdmin(req))) return res.status(404).json({ error: '作品不存在或未通过审核' });
  const user = currentUser(req);
  const skipPv = req.query.nopv === '1' && (isAdmin(req) || (user && w.userId === user.id));
  if (!skipPv) {
    w.views = (w.views || 0) + 1;
    saveWorks();
  }
  res.json(publicWork(w, user));
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
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    const { title, prompt, category, link, type } = req.body;
    const types = normalizeTypes(req.body.types || type);
    const image = req.files && req.files.image && req.files.image[0];
    const thumb = req.files && req.files.thumb && req.files.thumb[0];
    const qrcode = req.files && req.files.qrcode && req.files.qrcode[0];
    if (!image) return res.status(400).json({ error: '请上传作品封面 / 截图' });
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

    const typeErr = validateTypeRequired(types, linkVal, qrcode ? qrcode.filename : '');
    if (typeErr) return res.status(400).json({ error: typeErr });

    const repoVal = normRepo(req.body.repo);
    if (parseOpenSource(req.body.openSource) === true && !repoVal)
      return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });

    const needReview = REVIEW_MODE || !user; // 注册用户免审，匿名需审核
    const work = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: String(title).slice(0, 100),
      author: authorName,
      userId: user ? user.id : null,
      anon: !user,
      prompt: String(prompt || '').slice(0, 1000),
      category: (cats => cats[0] || '其他')(parseCats(req.body.categories)),
      categories: (cats => cats.length ? cats : ['其他'])(parseCats(req.body.categories)),
      type: types[0],
      types: types,
      link: linkVal ? linkVal.slice(0, 500) : '',
      site: normSite(req.body.site),
      image: '/uploads/' + image.filename,
      thumb: thumb ? '/uploads/' + thumb.filename : '/uploads/' + image.filename,
      qrcode: qrcode ? '/uploads/' + qrcode.filename : '',
      images: ((req.files && req.files.images) || []).slice(0, 9).map(f => '/uploads/' + f.filename),
      status: needReview ? 'pending' : 'approved',
      featured: false,
      pinned: false,
      openSource: parseOpenSource(req.body.openSource),
      repo: repoVal,
      paid: parsePaid(req.body.paid),
      reports: 0,
      likes: 0,
      views: 0,
      createdAt: new Date().toISOString()
    };
    if (linksMap) work.links = linksMap;
    works.push(work);
    saveWorks();
    res.status(201).json({
      ...publicWork(work, user),
      status: work.status,
      needReview,
      anonymous: !user
    });
  });
});

// 编辑自己的作品
app.put('/api/works/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  upload(req, res, err => {
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
    if (prompt !== undefined) w.prompt = String(prompt).slice(0, 1000);
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
    if (req.body.repo !== undefined) w.repo = normRepo(req.body.repo);
    if (w.openSource === true && !w.repo) return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });
    if (req.body.paid !== undefined) w.paid = parsePaid(req.body.paid);
    if (link !== undefined) {
      let lv = String(link).trim();
      if (lv && !/^https?:\/\//i.test(lv)) lv = 'https://' + lv;
      w.link = lv.slice(0, 500);
    }
    if (req.body.site !== undefined) w.site = normSite(req.body.site); // 官网：传了就更新（可清空）

    applyImageChanges(w, req);

    saveWorks();
    res.json(publicWork(w, user));
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

// 点赞
app.post('/api/works/:id/like', (req, res) => {
  if (!rateLimit('like:' + clientIp(req), 60, 60000)) {
    return res.status(429).json({ error: '操作过于频繁' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.likes = (w.likes || 0) + 1;
  saveWorks();
  res.json({ likes: w.likes });
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
  if (!Array.isArray(user.favs)) user.favs = [];
  const on = !!(req.body && req.body.on);
  const i = user.favs.indexOf(w.id);
  if (on && i === -1) {
    user.favs.unshift(w.id);
    w.favs = (w.favs || 0) + 1;
  } else if (!on && i !== -1) {
    user.favs.splice(i, 1);
    w.favs = Math.max(0, (w.favs || 0) - 1);
  }
  if (on !== (i !== -1)) logFav(w.id, user.id, on);
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

// 投诉
app.post('/api/works/:id/report', (req, res) => {
  if (!rateLimit('report:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const { reason, description, contact } = req.body || {};
  const REASONS = ['违法违规', '涉嫌侵权/盗用他人作品', '内容不当', '虚假信息', '已不能使用', '其他'];
  if (!REASONS.includes(reason)) return res.status(400).json({ error: '请选择投诉原因' });
  reports.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    workId: w.id,
    workTitle: w.title,
    reason,
    description: String(description || '').slice(0, 500),
    contact: String(contact || '').slice(0, 100),
    status: '待处理',
    createdAt: new Date().toISOString()
  });
  saveReports();
  w.reports = (w.reports || 0) + 1;
  saveWorks();
  res.status(201).json({ ok: true, message: '投诉已提交，我们会在 1-3 个工作日内处理' });
});

// ================= 评论 =================
// 结构：{ id, workId, userId, username, text, createdAt, parentId, kind, anon }
//   parentId  回复的顶级评论 id（只允许一层，回复的回复归到同一父级）
//   kind      'question' 提问 / 'comment' 普通评论
//   anon      匿名发言（未登录，只能由管理员删除）

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
    // 评论者就是作品作者（作者答疑会打「作者」标签）
    isAuthor: !!(c.username && w.author && c.username === w.author),
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
  // 作者回复过的提问 id（回复者是作品作者名）
  const answered = new Set();
  for (const c of all) {
    if (!c.parentId) continue;
    if (c.username && w.author && c.username === w.author) answered.add(c.parentId);
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
app.post('/api/works/:id/comments', (req, res) => {
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

// ================= 意见反馈 =================
// 匿名也能提，登录用户自动带上用户名；后台可标记处理 / 删除
app.post('/api/feedback', (req, res) => {
  if (!rateLimit('feedback:' + clientIp(req), 5, 3600000)) {
    return res.status(429).json({ error: '反馈提交太频繁了，休息一会儿再试' });
  }
  const { type, content, contact } = req.body || {};
  const TYPES = ['功能建议', '遇到问题', '内容建议', '合作/其他'];
  const text = String(content || '').trim();
  if (text.length < 5) return res.status(400).json({ error: '多写两句吧，至少 5 个字' });
  if (text.length > 1000) return res.status(400).json({ error: '内容太长了，1000 字以内' });
  const me = currentUser(req);
  feedback.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    type: TYPES.includes(type) ? type : '功能建议',
    content: text,
    contact: String(contact || '').trim().slice(0, 100),
    username: me ? me.username : '',
    page: String(req.headers.referer || '').slice(0, 200),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    status: '待查看',
    createdAt: new Date().toISOString()
  });
  saveFeedback();
  if (feedback.length > 2000) { feedback = feedback.slice(-2000); saveFeedback(); } // 防止无限增长
  res.status(201).json({ ok: true, message: '收到啦，谢谢你的反馈！' });
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
    reports: reports.filter(r => r.status === '待处理').length,
    feedback: feedback.filter(f => f.status === '待查看').length,
    claims: claims.filter(c => c.status === 'pending').length,
    views: works.reduce((s, w) => s + (w.views || 0), 0),
    likes: works.reduce((s, w) => s + (w.likes || 0), 0),
    users: users.length,
    usersToday,
    users7,
    ...visitStats()
  });
});

app.get('/api/admin/works', requireAdmin, (req, res) => {
  const status = req.query.status;
  let list = works.slice();
  if (status && status !== '全部') list = list.filter(w => (w.status || 'approved') === status);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list.map(w => ({
    ...publicWork(w), status: w.status || 'approved', reports: w.reports || 0, anon: !!w.anon,
    authorReal: w.authorReal || '',
    ownerReal: w.ownerReal ? ((users.find(u => u.id === w.ownerReal) || {}).username || '') : '',
    ...workVisitStats(w.id)
  })));
});

app.post('/api/admin/works/:id/approve', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.status = 'approved';
  saveWorks();
  res.json({ ok: true });
});

app.post('/api/admin/works/:id/reject', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.status = 'rejected';
  saveWorks();
  res.json({ ok: true });
});

// 精选 / 置顶 切换
app.post('/api/admin/works/:id/feature', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.featured = !w.featured;
  saveWorks();
  res.json({ ok: true, featured: w.featured });
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
  w.author = u.username;
  w.userId = u.id;
  // 明确指定归属后，匿名发布 / 待认领状态一并清掉
  delete w.anonymous; delete w.authorReal; delete w.ownerReal;
  if (w.claimOpen === true) w.claimOpen = false;
  saveWorks();
  res.json({ ok: true, author: w.author, claimed: true, claimable: isClaimable(w) });
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

    const work = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: String(title).slice(0, 100),
      author: String(author || '管理员').slice(0, 50),
      userId: null,
      prompt: String(prompt || '').slice(0, 1000),
      category: (cats => cats[0] || '其他')(parseCats(req.body.categories)),
      categories: (cats => cats.length ? cats : ['其他'])(parseCats(req.body.categories)),
      type: types[0],
      types: types,
      link: linkVal ? linkVal.slice(0, 500) : '',
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
      paid: parsePaid(req.body.paid),
      reports: 0,
      likes: 0,
      views: 0,
      createdAt: new Date().toISOString()
    };
    if (linksMap) work.links = linksMap;
    works.push(work);
    saveWorks();
    res.status(201).json({ ...publicWork(work), status: work.status });
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
    if (prompt !== undefined) w.prompt = String(prompt).slice(0, 1000);
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
      }
    }
    if (status && ['approved', 'pending', 'rejected'].includes(status)) w.status = status;
    if (req.body.openSource !== undefined) w.openSource = parseOpenSource(req.body.openSource);
    if (req.body.repo !== undefined) w.repo = normRepo(req.body.repo);
    if (w.openSource === true && !w.repo) return res.status(400).json({ error: '标注开源时请填写源码仓库地址' });
    if (req.body.paid !== undefined) w.paid = parsePaid(req.body.paid);
    // links 字段接管后同步遗留单链接：全清空时一并清掉，否则回填/展示会"复活"
    if (req.body.links !== undefined) w.link = (linksMap && (linksMap.Web || Object.values(linksMap)[0])) || '';
    if (link !== undefined) {
      let lv = String(link).trim();
      if (lv && !/^https?:\/\//i.test(lv)) lv = 'https://' + lv;
      w.link = lv.slice(0, 500);
    }
    if (req.body.site !== undefined) w.site = normSite(req.body.site); // 官网：传了就更新（可清空）

    applyImageChanges(w, req);

    saveWorks();
    res.json({ ...publicWork(w), status: w.status || 'approved' });
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

// 意见反馈管理
app.get('/api/admin/feedback', requireAdmin, (req, res) => res.json(feedback.slice().reverse()));
app.post('/api/admin/feedback/:id/status', requireAdmin, (req, res) => {
  const f = feedback.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '反馈不存在' });
  f.status = req.body && req.body.status === '待查看' ? '待查看' : '已处理';
  saveFeedback();
  res.json({ ok: true });
});
app.delete('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  const before = feedback.length;
  feedback = feedback.filter(x => x.id !== req.params.id);
  if (feedback.length === before) return res.status(404).json({ error: '反馈不存在' });
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
  const next = names.filter(n => known.has(n) && n !== LAST_CATEGORY);
  categories.forEach(c => { if (!next.includes(c) && c !== LAST_CATEGORY) next.push(c); });
  if (categories.includes(LAST_CATEGORY)) next.push(LAST_CATEGORY); // 「其他」永远最后
  categories = next;
  saveCategories();
  res.json(orderedCategories().map(name => ({ name })));
});
app.delete('/api/admin/categories/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (name === LAST_CATEGORY) return res.status(400).json({ error: '「其他」是兜底分类，不能删除' });
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
  res.json(workTypes.map(t => ({ name: t.name, icon: t.icon, count: counts[t.name] || 0 })));
});
app.post('/api/admin/types', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().replace(/[<>]/g, '').slice(0, 10);
  const icon = String((req.body && req.body.icon) || '').trim().slice(0, 4);
  if (!name) return res.status(400).json({ error: '形态名不能为空' });
  if (ALL_TYPES_LEGACY.includes(name)) return res.status(400).json({ error: '该形态已存在' });
  workTypes.push({ name, icon: icon || '✨' });
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
app.get('/api/admin/creators', requireAdmin, (req, res) => res.json(creators));
app.post('/api/admin/creators', requireAdmin, (req, res) => {
  const { name, bio } = req.body || {};
  if (!name) return res.status(400).json({ error: '创作者名称必填' });
  if (!creators.find(c => c.name === name)) creators.push({ name: String(name).slice(0, 50), bio: String(bio || '').slice(0, 200) });
  writeJSON('creators.json', creators);
  res.status(201).json(creators);
});
app.delete('/api/admin/creators/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  creators = creators.filter(c => c.name !== name);
  writeJSON('creators.json', creators);
  res.json({ ok: true });
});

// ---- 用户列表（送积分用）：账号 / 昵称 / 当前积分 / 注册时间 ----
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = users.map(u => ({
    id: u.id,
    username: u.username,
    name: displayNameOf(u.username),
    points: shareStatsOf(u.id).points,
    createdAt: u.createdAt,
    works: works.filter(w => w.userId === u.id).length
  }));
  // 新注册的排前面，方便找到刚来的人
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  res.json(list.slice(0, 50));
});

// ---- 管理员送积分 / 扣积分（delta 可负，账本统一走 addPoints）----
app.post('/api/admin/points', requireAdmin, (req, res) => {
  const { userId, delta, note } = req.body || {};
  const u = users.find(x => x.id === String(userId || ''));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const d = parseInt(delta, 10);
  if (!Number.isFinite(d) || d === 0) return res.status(400).json({ error: '分值必须是 非0 整数' });
  if (Math.abs(d) > 100000) return res.status(400).json({ error: '单次最多 ±100000 分' });
  const points = addPoints(u.id, d, 'admin');
  const noteText = String(note || '').trim().slice(0, 100);
  // 给用户发一条站内消息：登录后顶部铃铛能看到，也能解释积分从哪来的
  addNotice(u.id, {
    kind: 'points',
    title: d > 0 ? `积分到账 +${d}` : `积分调整 ${d}`,
    text: (d > 0 ? `管理员给你送上了 ${d} 积分` : `管理员调整了你的积分 ${d}`) +
      (noteText ? `：${noteText}` : '') + `，当前余额 ${points} 分。`,
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
  res.json({ ok: true, work: publicWork(w), claim: c });
});

app.post('/api/admin/claims/:id/reject', requireAdmin, (req, res) => {
  const c = claims.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '申请不存在' });
  if (c.status !== 'pending') return res.status(400).json({ error: '该申请已处理过' });
  c.status = 'rejected';
  c.handledAt = new Date().toISOString();
  c.note = String((req.body && req.body.note) || '').slice(0, 200);
  saveClaims();
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

function shell(seoHead, bodyBlock) {
  const html = template();
  if (!html) return `<!DOCTYPE html><html lang="zh-CN"><head>${seoHead}</head><body>${bodyBlock || ''}</body></html>`;
  return html.replace('<!--SEO_HEAD-->', seoHead).replace('<!--SEO_BODY-->', bodyBlock || '');
}

// 爬虫识别：SEO 内容区块（按分类浏览/最新收录等）只注入给爬虫，真人浏览器不输出——
// 否则区块先画出来、JS 接管后又移除，首页加载时会闪现一大块再塌掉（用户看到的「最新收录是什么鬼+抖动」）
// <head> 里的 meta / JSON-LD 对所有人照常输出（分享卡片、搜索摘要都靠它，不受影响）
const BOT_UA_RE = /bot|crawl|spider|slurp|baidu|bing|yandex|duckduck|sogou|yisou|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|micromessenger|qqbrowse/i;
function isBotUa(req) {
  return BOT_UA_RE.test(String(req.headers['user-agent'] || ''));
}

function sendHtml(res, html, status = 200) {
  res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'public, max-age=0, must-revalidate')
    .send(html);
}

function visibleWorks() { return works.filter(isVisible); }
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
  const list = q
    ? pool.filter(w => [w.title, w.author, w.prompt, w.category].some(f => String(f || '').toLowerCase().includes(q.toLowerCase())))
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

  const block = isBotUa(req) ? seo.homeBlock(base, {
    works: withAuthorNames(list.slice(0, 24)),
    categories: orderedCategories(),
    types: WORK_TYPES
  }) : ''; // 真人浏览器不输出 SEO 区块：首页由 SPA 自己渲染，避免闪现+塌陷抖动
  sendHtml(res, shell(headHtml, isBotUa(req) ? block : '')); // 真人不输出 SEO 区块（SPA 自己渲染，避免闪现+塌陷）
});

app.get('/index.html', (req, res) => res.redirect(301, '/'));

// 作品详情页（可被搜索引擎收录的独立页面）
app.get('/w/:id', (req, res) => {
  const base = seo.baseUrl(req);
  const raw = works.find(x => x.id === req.params.id);

  if (!raw || !isVisible(raw)) {
    const headHtml = seo.head({
      title: `页面不存在 - ${seo.SITE_NAME}`,
      description: '该作品可能已下架或未通过审核。',
      canonical: base + '/',
      noindex: true
    });
    return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
  }

  const w = publicWork(raw);
  const pageUrl = base + '/w/' + w.id;
  const intro = String(w.intro || '').trim();
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
    modifiedTime: w.createdAt,
    jsonLd: [
      seo.workLd(base, withAuthorName(w), pageUrl),
      seo.breadcrumbLd(base, trail)
    ]
  });

  // ?full=1 → 完整页面形态（用于分享与搜索引擎收录，前端不再自动弹窗）
  const fullPage = req.query.full === '1' || req.query.full === 'true';

  sendHtml(res, shell(headHtml, seo.workArticle(base, withAuthorName(w), trail, withAuthorNames(related), { full: fullPage })));
});

// 作者主页
app.get('/u/:name', (req, res) => {
  const base = seo.baseUrl(req);
  const name = String(req.params.name || '').slice(0, 50);
  const list = byNewest(visibleWorks().filter(w => w.author === name && w.anonymous !== true));
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
        作品 ${list.length} · 累计获赞 ${totalLikes}
      </p>
    </div>
  </div>
  <div class="gallery">${withAuthorNames(list).map(seo.cardHtml).join('') || '<div class="empty"><p>该作者还没有公开作品</p></div>'}</div>
</div>`;
  sendHtml(res, shell(headHtml, isBotUa(req) ? block : '')); // 真人不输出 SEO 区块（SPA 自己渲染，避免闪现+塌陷）
});

// 榜单页
app.get('/rank', (req, res) => {
  const base = seo.baseUrl(req);
  const by = Object.prototype.hasOwnProperty.call(RANK_BY, req.query.by) ? req.query.by : 'hot';
  const BY_TEXT = { hot: '综合热度', likes: '点赞', favs: '收藏', pv: 'PV 浏览量', uv: 'UV 访客数' };
  const list = visibleWorks().slice()
    .sort((a, b) => RANK_BY[by](a, b))
    .slice(0, 20);
  const tabCls = k => (k === by ? 'rank-tab active' : 'rank-tab');
  const tabHref = k => (k === 'hot' ? '/rank' : '/rank?by=' + k);

  const headHtml = seo.head({
    title: `作品榜单 - 热门网站、小程序与 App - ${seo.SITE_NAME}`,
    description: truncateText(
      `作品集热门榜单：支持按综合热度、点赞、收藏、PV、UV 排序，实时更新最受欢迎的网站、小程序、桌面客户端、机器人等作品。`, 150),
    keywords: '作品榜单,热门工具,排行榜,小程序排行,网站排行,点赞榜,收藏榜,PV榜,UV榜',
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
    <h1>作品榜单</h1>
    <p>当前按${BY_TEXT[by]}排序，展示最受欢迎的作品</p>
  </div>
  <div class="rank-tabs">
    <a class="${tabCls('hot')}" href="${tabHref('hot')}">综合</a>
    <a class="${tabCls('likes')}" href="${tabHref('likes')}">按点赞</a>
    <a class="${tabCls('favs')}" href="${tabHref('favs')}">按收藏</a>
    <a class="${tabCls('pv')}" href="${tabHref('pv')}">按 PV</a>
    <a class="${tabCls('uv')}" href="${tabHref('uv')}">按 UV</a>
  </div>
  <ol class="seo-rank">
    ${list.map((w, i) => `<li>
      <span class="rank-no">${i + 1}</span>
      <a href="/w/${seo.esc(w.id)}"><img src="${seo.esc(w.thumb || w.image)}" alt="${seo.esc(w.title)}" loading="lazy" /></a>
      <div class="rank-main">
        <a class="rank-title" href="/w/${seo.esc(w.id)}">${seo.esc(w.title)}</a>
        <div class="rank-meta">${typesOf(w).map(t => `${seo.TYPE_ICONS[t] || '✨'} ${seo.esc(t)}`).join(' · ')} · @${seo.esc(w.author)} · ${seo.esc(w.category || '')}</div>
      </div>
      <div class="rank-score">♥ ${w.likes || 0} · ★ ${w.favs || 0}<br><span>👁 ${w.views || 0}</span></div>
    </li>`).join('') || '<li class="empty"><p>暂无上榜作品</p></li>'}
  </ol>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, isBotUa(req) ? block : '')); // 真人不输出 SEO 区块（SPA 自己渲染，避免闪现+塌陷）
});

// 许愿墙：说出想要的作品，社区创作者来认领实现（服务端渲染，利于收录）
app.get('/wish', (req, res) => {
  const base = seo.baseUrl(req);
  const list = ideas.filter(i => !i.hidden).slice().sort((a, b) => {
    const d = (b.wants || 0) - (a.wants || 0);
    return d !== 0 ? d : new Date(b.createdAt) - new Date(a.createdAt);
  });
  const top = list.slice(0, 30);
  const doneCount = list.filter(i => i.status === 'done' || i.workId).length;
  const desc = truncateText(
    `许愿墙：说出你想要但还没人做的工具，社区里的创作者来接单实现。目前共有 ${list.length} 个想法，` +
    `其中 ${doneCount} 个已被实现。最受期待的有 ${top.slice(0, 3).map(i => i.title).join('、')} 等。`, 150);

  const headHtml = seo.head({
    title: `许愿墙 - 说出你想要的作品，让社区帮你实现 - ${seo.SITE_NAME}`,
    description: desc,
    keywords: '许愿墙,想要的功能,求工具,需求征集,作品定制,社区共创',
    canonical: base + '/wish',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '许愿墙' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '许愿墙 · 大家想要的作品',
        url: base + '/wish',
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
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '许愿墙' }])}
  <div class="page-head">
    <h1>💡 许愿墙</h1>
    <p>想要什么作品，写在这儿——社区里的高手会来接；被认领、被实现的想法会挂上作品链接</p>
  </div>
  <p class="seo-wish-stat">共 ${list.length} 个想法 · 已被实现 ${doneCount} 个 · 按「想要的人最多」排序</p>
  <ol class="seo-rank seo-wish">
    ${top.map((i, idx) => `<li>
      <span class="rank-no">${idx + 1}</span>
      <div class="rank-main">
        <div class="rank-title">${seo.esc(i.title)}</div>
        <div class="rank-meta">
          🔥 ${i.wants || 0} 人想要 · @${seo.esc(i.author || '匿名')}
          ${i.category ? ' · ' + seo.esc(i.category) : ''}
          ${i.workId ? ' · ✅ 已实现' : (i.status === 'claimed' ? ' · 🤝 已被认领' : '')}
        </div>
      </div>
      ${i.workId ? `<a class="rank-score" href="/w/${seo.esc(i.workId)}">看作品 →</a>` : ''}
    </li>`).join('') || '<li class="empty"><p>还没有人提想法，来做第一个吧</p></li>'}
  </ol>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, isBotUa(req) ? block : '')); // 真人不输出 SEO 区块（SPA 自己渲染，避免闪现+塌陷）
});


// 分类页 /c/:name 与形态页 /t/:name（服务端渲染，利于收录）
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
    const desc = truncateText(
      `共收录 ${pool.length} 件${kind === 'c' ? `「${name}」分类` : `「${name}」形态`}的作品，` +
      `包含 ${pool.slice(0, 3).map(w => w.title).join('、')} 等，均可在线体验。`, 150);

    const headHtml = seo.head({
      title: `${h1}（共 ${pool.length} 件） - ${seo.SITE_NAME}`,
      description: desc,
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
      title: `${h1}（共 ${pool.length} 件） - ${seo.SITE_NAME}`,
      description: desc,
      h1,
      activeName: name,
      kind,
      subtitle: `共 ${pool.length} 件${kind === 'c' ? '同分类' : '同形态'}作品，点击卡片查看详情与体验地址`,
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
app.get('/sitemap.xml', (req, res) => {
  const base = seo.baseUrl(req);
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(
    seo.sitemapXml(base, {
      works: byNewest(visibleWorks()),
      categories: orderedCategories(),
      types: WORK_TYPES,
      authors: authorEntries()
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`造梦橱窗已启动: http://localhost:${PORT}  (审核模式: ${REVIEW_MODE ? '开' : '关'})`);
});
