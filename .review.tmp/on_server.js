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
const miniShowcase = require('./mini-showcase'); // 小程序体验页（/mini/:id）：推广位/广告位的落地页
const siteMeta = require('./site-meta');
// 本地开发用的环境切换（线上自动关闭）：可把 /api 与 /uploads 转发到生产，见 dev-env.js
const createDevEnv = require('./dev-env');
// 作品关键词：自动生成 + 清洗（纯函数，迁移 / 测试脚本共用同一份）
const { autoKeywords, sanitizeKeywords, KW_MAX } = require('./keywords');

const PORT = process.env.PORT || 3000;
const REVIEW_MODE = process.env.REVIEW_MODE === '1'; // 打开后新投稿需审核

// DATA_DIR / UPLOAD_DIR 允许用环境变量指到别处（跑自动化测试时用临时目录，别碰正式数据）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');

// ---------- 进程级兜底：出问题要留痕，别静默重启 ----------
// 之前没有这两处兜底：任何一个 async 路由漏了 catch，Node 20 会直接结束进程，
// PM2 拉起来但没人知道崩过。现在统一落 logs/error.log，出问题能复盘。
const LOG_DIR = path.join(__dirname, 'logs');
function errText(e) { return e && (e.stack || e.message) ? (e.stack || e.message) : String(e); }
function logLine(file, text) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, file), `[${new Date().toISOString()}] ${text}\n`);
  } catch { /* 日志写不进去也不能影响主流程 */ }
}
// 未处理的 Promise rejection：多数是某个接口漏了 catch，记下来，进程继续服务
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  logLine('error.log', 'unhandledRejection: ' + errText(reason));
});
// 未捕获的同步异常：先留痕再退出，交给 PM2 拉起（进程状态已不可信，硬撑风险更大）
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  logLine('error.log', 'uncaughtException: ' + errText(err));
  setTimeout(() => process.exit(1), 200);
});

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

// 默认写紧凑 JSON：data/*.json 只给程序读，不给人手改，
// 去掉 2 空格美化后 works.json 从 148K 降到 ~90K，序列化与写盘时间同比例下降约 40%。
// 需要人肉排查数据时用 PRETTY_JSON=1 起服务即可恢复美化输出。
const PRETTY_JSON = process.env.PRETTY_JSON === '1';

function writeJSON(name, data) {
  const target = fileOf(name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, PRETTY_JSON ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, target);
}

// ---------- 高频写盘合并 ----------
// saveWorks() 在 40+ 处被调用，一次点赞就算一次；每次都同步序列化 + 写 148K，
// 并发时所有人一起等这一次盘。改成 300ms 内合并成一次写。
// 需要「立刻可见」的地方显式调 saveWorksNow()（例如发奖时钱与标记必须同批落盘）。
// 注意：下面第 1946 行附近的 worksSaveTimer 属于「浏览数 3 秒节流」的既有机制，
// 是另一层，二者不共用变量，避免互相 clearTimeout。
let worksFlushTimer = null;
function saveWorks() {
  if (worksFlushTimer) return;
  worksFlushTimer = setTimeout(() => {
    worksFlushTimer = null;
    try { writeJSON('works.json', works); } catch (e) { console.error('[saveWorks]', e.message); }
  }, 300);
}
function saveWorksNow() {
  if (worksFlushTimer) { clearTimeout(worksFlushTimer); worksFlushTimer = null; }
  try { writeJSON('works.json', works); } catch (e) { console.error('[saveWorksNow]', e.message); }
}
// 进程退出（pm2 restart / Ctrl+C / SIGTERM）时把缓冲补上，
// 否则最后几秒的点赞、浏览计数会随重启丢掉。
// 三层都要刷：300ms 合并（本层）、浏览数 3s 节流、work-visits 3s 节流。
// 后两个变量在下面才定义，所以注册动作放在文件末尾 app.listen 之后（见 installFlushHooks）。
function flushPendingWrites() {
  if (worksFlushTimer) {
    clearTimeout(worksFlushTimer);
    worksFlushTimer = null;
    try { writeJSON('works.json', works); } catch { /* 退出路径上不再抛 */ }
  }
  try {
    if (worksSaveTimer) {
      clearTimeout(worksSaveTimer);
      worksSaveTimer = null;
      writeJSON('works.json', works);
    }
  } catch { /* 变量尚未初始化时静默跳过 */ }
  try {
    if (workVisitSaveTimer) {
      clearTimeout(workVisitSaveTimer);
      workVisitSaveTimer = null;
      writeJSON('work-visits.json', workVisits);
    }
  } catch { /* 同上 */ }
}
function installFlushHooks() {
  process.on('exit', flushPendingWrites);
  process.on('SIGINT', () => { flushPendingWrites(); process.exit(0); });
  process.on('SIGTERM', () => { flushPendingWrites(); process.exit(0); });
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

// ---------- 众人小法官（疑似推广众判） ----------
// 玩法：详情页给一个「像推广，该整改 / 不像推广」的二选一投票，登录用户一人一票（可改票）。
// 认定票（sus）比反对票（ok）**多出 JURY_REMOVE_GAP（默认 5 票）**时，作品自动下架待整改；
// 作者改完内容保存即回到审核队列（复用「被下架作品编辑后回待审」那条链路），
// 不存在永久封杀。管理员在后台「众人小法官」页可以复核、恢复并清票。
// 为什么按净票差而不是比例、也不是固定票数（2026-11-13 站长定档）：
// 看的是「假票比真票多几人」——6:5 这种胶着局面不判，10:6 也不判，只有净差够 5 才算众人有共识；
// 反对票随时能把作品拉回来（净差跌破 5 就不会下架），比「满 6 票 + 多于反对票」更能反映分歧程度。
// 反刷四道闸：只认登录账号 / 注册满 24h / 同 IP 同作品限认定票 / 不能投自己的作品。
const JURY_REMOVE_GAP = Math.max(1, parseInt(process.env.JURY_REMOVE_GAP || '5', 10) || 5);
const JURY_MIN_AGE_MS = Math.max(0, parseInt(process.env.JURY_MIN_AGE_HOURS || '24', 10) || 0) * 3600000;
// 卡片什么时候挂「众判中」角标（2026-11-13 站长定档）：认定票（sus）多于反对票（ok）就挂，
// 也就是「多数人说像推广」——此时卡片上出现标识，路过的人点进去就能投票。
// 注意别用 sus>0：那是一个人说像就挂牌，容易被单个人盯着一件作品挂满全站。
// 想让标晚点出，把 JURY_CARD_MIN 调成 3（三票起才算争议）。
const JURY_CARD_MIN = Math.max(1, parseInt(process.env.JURY_CARD_MIN || '1', 10) || 1);
// 同一网络（IP 哈希）对同一件作品最多计入几张认定票。0 = 不限（只在自动化测试里用）
const JURY_IP_MAX = Math.max(0, parseInt(process.env.JURY_IP_MAX || '2', 10) || 0);
const JURY_VOTE_TEXT = { sus: '认为疑似推广，该整改', ok: '认为不像推广' };
let juryData = readJSON('jury.json', {});
if (!juryData || typeof juryData !== 'object' || Array.isArray(juryData)) juryData = {};
if (!juryData.votes || typeof juryData.votes !== 'object') juryData.votes = {};   // workId -> { userId: {v, at, name} }
if (!juryData.cases || typeof juryData.cases !== 'object') juryData.cases = {};   // workId -> 案件状态
let juryFlushTimer = null;
function saveJury() {
  if (juryFlushTimer) return;
  juryFlushTimer = setTimeout(() => {
    juryFlushTimer = null;
    try { writeJSON('jury.json', juryData); } catch (e) { console.error('[saveJury]', e.message); }
  }, 300);
}
function saveJuryNow() {
  if (juryFlushTimer) { clearTimeout(juryFlushTimer); juryFlushTimer = null; }
  try { writeJSON('jury.json', juryData); } catch (e) { console.error('[saveJuryNow]', e.message); }
}
function juryVotesOf(id) {
  const box = juryData.votes[id];
  return box && typeof box === 'object' ? box : {};
}
function juryTally(id) {
  const box = juryVotesOf(id);
  let sus = 0, ok = 0;
  Object.keys(box).forEach(uid => {
    const v = box[uid] && box[uid].v;
    if (v === 'sus') sus++;
    else if (v === 'ok') ok++;
  });
  return { sus, ok };
}
function juryCaseOf(id) { return juryData.cases[id] || null; }
// 投票资格：登录 / 不是自己的作品 / 案件还没判下架 / 账号够老（站长豁免，方便自己验功能）
function juryCanVote(w, user) {
  if (!user) return 'login';
  if (w.userId && w.userId === user.id) return 'own';
  const c = juryCaseOf(w.id);
  if (c && c.status === 'removed') return 'closed';
  if (!isSiteOwner(user)) {
    const born = Date.parse(user.createdAt || '');
    if (!born || Date.now() - born < JURY_MIN_AGE_MS) return 'fresh';
  }
  return '';
}
// 下发给前端的众判状态（列表卡片只要 sus / flagged，详情页再要 mine / canVote）
function juryPublic(w, user) {
  const t = juryTally(w.id);
  const c = juryCaseOf(w.id);
  const mine = user ? (juryVotesOf(w.id)[user.id] || null) : null;
  const why = juryCanVote(w, user);
  return {
    sus: t.sus,
    ok: t.ok,
    // gap = 下架门槛（净差几票），lead = 当前净差（负值按 0 算，用来画进度条 / 说「还差几票」）。
    // 前端所有文案与进度条都用这两个数，别自己再算一遍 sus-ok。
    gap: JURY_REMOVE_GAP,
    lead: Math.max(0, t.sus - t.ok),
    // card：列表卡片要不要挂「众判中 N」角标 + 详情页「疑似推广」小标的唯一口径。
    // 认定票占多数时才算「争议作品」，前端别自己再比一遍 sus/ok（改参数会两边漂移）。
    card: t.sus >= JURY_CARD_MIN && t.sus > t.ok,
    flagged: !!(c && c.flaggedAt && c.status !== 'cleared'),
    removed: !!(c && c.status === 'removed'),
    mine: mine && mine.v ? mine.v : '',
    canVote: why === '',
    why,
    minAgeH: Math.round(JURY_MIN_AGE_MS / 3600000)
  };
}
// 结案：清空这轮投票，案件留档（history 里能看到是谁、什么时候结的）。
// 只清票不动作品状态 —— 「要不要恢复上架」由调用方（后台复核 / 恢复上架）自己决定。
function clearJuryCase(w, c, by, note) {
  const at = new Date().toISOString();
  delete juryData.votes[w.id];
  c.status = 'cleared';
  c.clearedAt = at;
  c.clearedBy = by || 'admin';
  c.history = (c.history || []).concat([{ at, action: 'cleared', by: c.clearedBy, note: note || '' }]);
  delete w.juryRemoved;
}
// 众判通过 → 下架待整改。走的是管理员下架同一条状态通道（status=rejected），
// 所以「已下架」列表、广告自动撤、作者编辑后回待审这些既有行为全都自动生效，不必另写一套。
function removeByJury(w, c, t, opts = {}) {
  const at = new Date().toISOString();
  const byAdmin = opts.byAdmin === true;   // 站长在后台直接下架：不摆票数，用复核口径
  w.status = 'rejected';
  w.hidden = false;
  w.juryRemoved = true;                 // 后台据此区分「众判下架」与「管理员手动下架」
  w.offlineReason = byAdmin
    ? (String(opts.reason || '').trim().slice(0, 200) || '复核后觉得这件更像站外推广，先收起来了；按作品规范调整好可以重新提交。')
    : `众判结果：${t.sus} 人觉得这件更像站外推广、${t.ok} 人认为不像推广（净差 ${t.sus - t.ok} 票），先收起来等整改；按作品规范调整好可以重新提交。`;
  w.offlineAt = at;
  w.updatedAt = at;
  c.status = 'removed';
  c.removedAt = at;
  c.sus = t.sus;
  c.ok = t.ok;
  c.history = (c.history || []).concat([{ at, action: 'removed', by: byAdmin ? 'admin' : 'jury', sus: t.sus, ok: t.ok }]);
  // 有主作品通知作者；匿名 / 未认领的没有收件人，原因留在后台与作者可见的详情页上
  if (w.userId) {
    addNotice(w.userId, {
      kind: 'system',
      title: `「${w.title}」先收起来了，等调整`,
      text: byAdmin
        ? '复核后觉得这件更像站外推广，先收起来了（浏览、点赞这些数据都留着）。按作品规范调整好，在「我的作品」里重新保存提交，我们再看一遍；觉得判得不对，作品页底部「意见建议」随时说。'
        : `${t.sus} 位用户投了「更像推广」、${t.ok} 位认为不像推广（净差 ${t.sus - t.ok} 票，达到下架门槛），先收起来等调整。按作品规范调整好，在「我的作品」里重新保存提交，我们再看一遍；觉得判得不对，作品页底部「意见建议」随时说。`,
      workId: w.id
    });
  }
}
// 认领暗号（2026-11-12 起每个作品单独一个，存作品对象 w.claimCode，后台作品列表逐件设置）：
// ≤10 位字符串，作者在前台认领弹窗里填对这件作品的暗号，就当场按「认领通过」的口径归到名下，
// 不进审核队列。认领成功后暗号即删除（用完即废）；没设暗号的作品只能走「交证据 + 人工审核」。
// 全站统一口令已下线（原 claim-cfg.json 不再读写，口令比对的口径不变）。
const CLAIM_CODE_MAX = 10;
let ads = readJSON('ads.json', []);            // 广告（固定几个广告位，后台往里挂）
// 广告位展示频控（后台「广告位」页可改，存 data/ad-gate.json）：
// { 'home-bottom': 1, footer: 5 } —— 每个位每人每天最多展示几次，0 = 不限制。
// 只对「内容看完之后」的招商位生效；作者用灯火买的曝光位（首页顶部/第一格/详情/榜单）不受影响。
let adGateCfg = readJSON('ad-gate.json', {});
if (!adGateCfg || typeof adGateCfg !== 'object' || Array.isArray(adGateCfg)) adGateCfg = {};
const AD_GATE_DEFAULTS = { 'home-bottom': 1, footer: 5 };
const AD_GATE_MAX = 200;                       // 手滑填个 99999 也不会把访客刷死
function adGateDaily() {
  const out = {};
  Object.keys(AD_GATE_DEFAULTS).forEach(k => {
    const v = Number(adGateCfg[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? Math.min(AD_GATE_MAX, Math.floor(v)) : AD_GATE_DEFAULTS[k];
  });
  return out;
}
const saveAdGate = () => writeJSON('ad-gate.json', adGateCfg);
// 投放权重（后台「投放单」页切换，存 data/promo-priority.json，2026-11-13 站长定档）：
// 同一个推荐位同时有多条在投时，谁优先被挑中：
//   user  = 优先用户（默认）：作者用灯火买的单先上，站长代投只在这个位「没有买家单」时补位
//   owner = 优先站长：反过来，站长代投先把位占住（给合作方做曝光时才用）
//   tie   = 平级：不分买家 / 代投，照旧全池随机（旧口径）
// 只决定「挑哪条」，不动扣费与统计：买家单没被挑中就不扣曝光/点击额度，账单口径不变。
const PROMO_PRIORITY_MODES = ['user', 'owner', 'tie'];
const PROMO_PRIORITY_LABEL = { user: '优先用户', owner: '优先站长', tie: '平级' };
let promoPriorityCfg = readJSON('promo-priority.json', {});
if (!promoPriorityCfg || typeof promoPriorityCfg !== 'object' || Array.isArray(promoPriorityCfg)) promoPriorityCfg = {};
function promoPriorityMode() {
  const m = String(promoPriorityCfg.mode || '');
  return PROMO_PRIORITY_MODES.includes(m) ? m : 'user';   // 没配 / 配坏了都按「优先用户」兜底
}
const savePromoPriority = () => writeJSON('promo-priority.json', promoPriorityCfg);
// 单条代投的展示优先级（2026-11-13 站长补）：站长代投弹窗里逐单选，默认「让位买家」。
//   user  = 让位买家：这个位有作者买的单时，代投不抢位（＝全局「优先用户」的单条版）
//   tie   = 齐平随机：和买家单一起随机，不看来源
//   owner = 优先这条：这条压过买家单先展示（等于只给这一条开「优先站长」）
// 存 ad.prio / r.prio；没存的老代投单跟随上面的全局投放权重，不回溯改写。
const COMP_PRIO_MODES = ['user', 'tie', 'owner'];
const COMP_PRIO_LABEL = { user: '让位买家', tie: '齐平随机', owner: '优先这条' };
// 广告曝光明细：{ 'YYYY-MM-DD': { <adId>: { pv: 3, uv: { 'ip:1.2.3.4': 1, 'u:xxx': 1 } } } }
// PV = 展示次数；UV = 去重访客（登录按账号、未登录按 IP，与站点 UV 口径一致）
let adStats = readJSON('ad-stats.json', {});
if (!adStats || typeof adStats !== 'object' || Array.isArray(adStats)) adStats = {};
// 积分兑换广告位的订单：{ id, userId, workId, slot, adId, views, price, used, status, createdAt, endsAt }
let redemptions = readJSON('ad-redemptions.json', []);
if (!Array.isArray(redemptions)) redemptions = [];
// 同上：合并前的发现页文字位订单全部归入合并槽（mini-rank-line），订单/余额/排期原样保留
redemptions.forEach(r => { if (r && r.slot === 'mini-feat-line') r.slot = 'mini-rank-line'; });
const saveRedemptions = () => writeJSON('ad-redemptions.json', redemptions);
// 打赏记录（零和转移账本）：{ id, workId, fromUserId, fromDisplay, toUserId, amount, ipk, createdAt }
// 打赏不产生新灯火：打赏者扣多少、作者得多少，平台总盘不变。记录保留全量（对账 + 防刷审计）。
let tips = readJSON('tips.json', []);
if (!Array.isArray(tips)) tips = [];
const saveTips = () => writeJSON('tips.json', tips);
// 灯火解锁记录：{ 作品id: { 用户id: 解锁时间戳 } }。一次解锁永久有效，作者自己不需要解锁。
let lampUnlockStore = readJSON('lamp-unlocks.json', {});
if (!lampUnlockStore || typeof lampUnlockStore !== 'object') lampUnlockStore = {};
const saveLampUnlocks = () => writeJSON('lamp-unlocks.json', lampUnlockStore);
function lampUnlockOf(workId, uid) {
  const m = lampUnlockStore[workId];
  return !!(uid && m && m[uid]);
}
function lampUnlockCountOf(workId) {
  const m = lampUnlockStore[workId];
  return m ? Object.keys(m).length : 0;
}
// 作品合并跳转记录：{ 被合并件id: 保留件id }。合并后老链接 / 老二维码扫过来 302 到保留件
let workRedirects = readJSON('work-redirects.json', {});
if (!workRedirects || typeof workRedirects !== 'object' || Array.isArray(workRedirects)) workRedirects = {};
const saveWorkRedirects = () => writeJSON('work-redirects.json', workRedirects);
const DEFAULT_CATEGORIES = ['效率工具', '生活助手', '内容创作', '学习教育', '娱乐游戏', '开发工具', '个人站'];
let categories = readJSON('categories.json', DEFAULT_CATEGORIES);
if (!Array.isArray(categories) || !categories.length) categories = DEFAULT_CATEGORIES.slice();

// ---------- 场景（按「什么情况下用」逛）----------
// 配置在 content/scenes.json（进部署包；data/ 运行时数据不进包），改场景名/归组不用碰代码。
// 一件作品可以同时属于多个场景，判定顺序：
//   1) 作品自带的 scenes 字段（后台没填就不写；填了以它为准，可人工纠偏）
//   2) 分类命中 scenes[].categories —— 后台改分类，场景自动跟着变，不用维护第二份名单
//   3) 上面一个都没命中时，拿标题 / 一句话 / 关键词兜一层（防止新分类的作品漏掉）
// 0 件的场景不进筛选条（点进去是空列表，纯属噪音，与形态/分类下拉同口径）。
const SCENES_FILE = path.join(__dirname, 'content', 'scenes.json');
let scenesCache = { mtime: -1, list: [] };
function loadScenes() {
  let mtime;
  try { mtime = fs.statSync(SCENES_FILE).mtimeMs; } catch { return scenesCache.list; }
  if (mtime === scenesCache.mtime) return scenesCache.list;   // 文件没动过，直接用上次解析结果
  try {
    const raw = JSON.parse(fs.readFileSync(SCENES_FILE, 'utf-8'));
    if (raw && raw.enabled === false) { scenesCache = { mtime, list: [] }; return []; }
    const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.scenes) ? raw.scenes : []);
    const list = rows.filter(s => s && s.key && s.name).map(s => ({
      key: String(s.key).slice(0, 24),
      name: String(s.name).slice(0, 8),
      desc: String(s.desc || '').slice(0, 60),
      // 只认后台真实存在的分类：分类删了/改名了，这里自动失效，不会留一个筛不出东西的幽灵场景
      categories: Array.isArray(s.categories) ? s.categories.filter(c => categories.includes(c)) : [],
      keywords: Array.isArray(s.keywords)
        ? s.keywords.map(k => String(k || '').trim().toLowerCase()).filter(Boolean).slice(0, 40) : []
    })).filter(s => s.categories.length || s.keywords.length);
    scenesCache = { mtime, list };
  } catch { /* 配置坏了就当没场景：首页少一栏，其它筛选照常 */ }
  return scenesCache.list;
}
// 一件作品属于哪些场景（scenes 需由调用方传入 loadScenes() 的结果，避免每件作品都去 stat 一次文件）
function sceneKeysOf(w, scenes) {
  if (!scenes || !scenes.length) return [];
  if (Array.isArray(w.scenes) && w.scenes.length) {
    const own = w.scenes.filter(k => scenes.some(s => s.key === k));
    if (own.length) return own;
  }
  const cats = catsOf(w);
  const out = [];
  scenes.forEach(s => { if (s.categories.some(c => cats.includes(c))) out.push(s.key); });
  if (out.length) return out;
  const hay = [w.title, w.tag, w.positioning, (Array.isArray(w.keywords) ? w.keywords.join(' ') : '')]
    .filter(Boolean).join(' ').toLowerCase();
  if (!hay) return out;
  scenes.forEach(s => { if (s.keywords.some(k => hay.includes(k))) out.push(s.key); });
  return out;
}

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

// saveWorks 已上移到存储层（带 300ms 合并），这里不再重复定义
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

// 标题分隔符：老数据是「名字，一句话介绍」（后台/投稿表单两个框拼的），
// 现改成中间只留一个空格 —— 卡片标题少一个字符更短，也不会被逗号读成半句话。
// 只动形状刚好是「名字(≤10)，介绍(≤20)」的标题，自己手写长句里的逗号不碰。
runMigration('title-sep-space-2026-11', () => {
  const RE = /^([^，,·\s]{1,10})[，,·]\s*([^，,·\s][^，,·]{0,19})$/;
  let n = 0;
  works.forEach(w => {
    const t = String(w.title || '');
    const m = t.match(RE);
    if (!m) return;
    w.title = m[1] + ' ' + m[2].trim();
    n++;
  });
  if (n) {
    saveWorks();
    console.log('[migration] 标题分隔符改空格：', n, '件');
  }
});

// 友情链接：站长安插的外站入口，展示在页脚（[{ name, desc, url }]，数组顺序即展示顺序）
// 2026-11-14 起 name 只放站名，一句话简介单独放 desc —— 之前老数据把「站名-简介」塞在
// name 一个字段里，页脚渲染出来是一整行同灰度文字，站名和简介分不开（也挤没了名字）。
const FRIEND_DESC_MAX = 40;
let friends = readJSON('friends.json', []);
if (!Array.isArray(friends)) friends = [];
// 老数据一次性拆名：只在「破折号两侧都有内容、右半截像句话（≥4 字且含中文或空格）」时拆，
// 「XX-Studio」这种站名自带的连字符不动它；拆完写回 friends.json，跑过一次就不会再拆。
function splitFriendName(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.{2,20}?)\s*[-–—|｜]\s*(\S.*)$/);
  if (m) {
    const left = m[1].trim(), right = m[2].trim();
    if (right.length >= 4 && /[\u4e00-\u9fa5]|\s/.test(right)) return { name: left, desc: right.slice(0, FRIEND_DESC_MAX) };
  }
  return { name: s, desc: '' };
}
let splitCount = 0;
friends = friends
  .map(f => {
    const name = String((f && f.name) || '').trim();
    const desc = String((f && f.desc) || '').trim();
    const url = String((f && f.url) || '').slice(0, 500);
    if (desc) return { name: name.slice(0, 20), desc: desc.slice(0, FRIEND_DESC_MAX), url };
    const sp = splitFriendName(name);
    if (sp.desc) splitCount++;
    return { name: sp.name.slice(0, 20), desc: sp.desc, url };
  })
  .filter(f => f.name && /^https?:\/\/.+/i.test(f.url));
const saveFriends = () => writeJSON('friends.json', friends);
if (splitCount) {
  saveFriends();
  console.log('[migration] 友链名称拆出简介：', splitCount, '条');
}

// 友链申请：访客在前台弹窗提交，站长在后台「友情链接」tab 审批。
// 通过 = 从申请堆里删掉 + 塞进 friends；忽略 = 直接删（对方可以重新提交，没有黑名单语义）。
const FRIEND_REQ_MAX = 100;   // 待审批堆积上限，防脚本灌库
const FRIEND_MAX = 50;        // 页脚最多展示多少条（多了页脚也塞不下）
let friendReqs = readJSON('friend-requests.json', []);
if (!Array.isArray(friendReqs)) friendReqs = [];
const saveFriendReqs = () => writeJSON('friend-requests.json', friendReqs);

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
// 认领暗号：比对一律不区分大小写（作者是从聊天消息里手抄过来的，大小写不该成为门槛）。
// 长度按「字符」算（Array.from），中文 / emoji 各算 1 位，和后台输入框的 maxlength=10 对齐。
function normClaimCode(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function claimCodeOn(w) { return !!normClaimCode(w && w.claimCode); }
function claimCodeLen(s) { return Array.from(String(s || '')).length; }
// 后台新建 / 编辑作品表单里填的暗号，与「认领暗号」按钮走同一个校验口径：
// 空串 = 没设 / 清除；带空格直接拒（作者手抄时容易多一位少一位）。
// 返回 { code } 或 { err }，调用方先校验再动作品字段（别改到一半才报错）。
function claimCodeInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { code: '' };
  if (/\s/.test(s)) return { err: '暗号里不能带空格，作者手抄时容易多一位少一位' };
  if (claimCodeLen(s) > CLAIM_CODE_MAX) return { err: `暗号最多 ${CLAIM_CODE_MAX} 位` };
  return { code: s };
}
// 暗号认领的额外奖励（2026-11-12 站长加）：后台建 / 编辑作品时可以给这件作品单独承诺
// 「作者填对暗号，除默认上传奖励外再送 X 盏」，并把原因写在站内消息里。
// 三条口径：① 与默认上传奖励（首件 200 / 后续 50）是加法，不覆盖；
//          ② 只在「暗号认领」这条路发，交证据人工审核 / 授权一键认领都不吃；
//          ③ 和暗号同生共死：暗号一清（手动清除或已被认领），这笔奖励跟着失效，
//             免得挂在作品上却永远没有发放入口。存 w.claimBonus = { points, reason }。
const CLAIM_BONUS_MAX = 1000;                  // 上限防手滑：多按一个 0 也不至于送出去一万盏
const CLAIM_BONUS_REASON_MAX = 60;
function claimBonusInput(pointsRaw, reasonRaw) {
  const raw = String(pointsRaw == null ? '' : pointsRaw).trim();
  if (!raw) return { bonus: null };            // 空 = 没设 / 清除
  if (!/^\d+$/.test(raw)) return { err: '认领额外奖励请填整数盏灯火（留空或 0 = 不发）' };
  const n = parseInt(raw, 10);
  if (n > CLAIM_BONUS_MAX) return { err: `认领额外奖励最多 ${CLAIM_BONUS_MAX} 盏` };
  if (n === 0) return { bonus: null };         // 0 = 不发，等价于没设
  return {
    bonus: {
      points: n,
      reason: String(reasonRaw == null ? '' : reasonRaw).trim().slice(0, CLAIM_BONUS_REASON_MAX)
    }
  };
}
// 作品上当前生效的那笔额外奖励；结构坏了 / 点数不是正数一律当没设（发钱前先过一遍）
function claimBonusOf(w) {
  const b = w && w.claimBonus;
  const n = b ? Number(b.points) : 0;
  if (!Number.isFinite(n) || n <= 0) return null;
  return {
    points: Math.min(CLAIM_BONUS_MAX, Math.round(n)),
    reason: String(b.reason || '').slice(0, CLAIM_BONUS_REASON_MAX)
  };
}
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
//   promo —— 营销推送（活动 / 上新 / 优惠），后台群发时选「营销」才落这个 kind，同样可屏蔽提示
//   ad —— 推荐位 / 广告位订单的进展（上线、排队、投完），只发给投放人自己
//         前台铃铛里这一栏叫「投放」（2026-11-13 从「广告」改名，避免和「营销」混）；
//         kind 标识符沿用 ad，不动。
//   bar-reply —— 造梦酒馆里有人回应了你发的闲聊（只发帖子作者，自己回自己不通知）。
//         不单开一栏：酒馆回应和作品评论、站长私信一样都是「有人跟你说话」，
//         归进「消息」栏，前端给这种条目挂一枚「酒馆」小标签 + 直接深链回那一楼。
const NOTICE_KEEP_PER_USER = 50;
// 消息分区：铃铛弹窗按「营销 / 系统 / 投放 / 灯火 / 消息」分栏（站内文案叫「投放」）。
// 分区只从 kind 推导、不回填老数据（kind 是唯一真相，分区是展示层）：
// 新增 kind 却忘了归类的，自动落到「消息」，不会凭空消失。
const NOTICE_CAT_OF = {
  promo: 'promo',                                              // 营销
  ad: 'ad',                                                    // 投放（推荐位 / 广告位订单进展）
  points: 'points',                                            // 灯火增删
  announce: 'system', system: 'system', tag: 'system',         // 系统通知
  'bar-reply': 'msg'                                           // 酒馆回应（和评论 / 私信同栏，靠小标签区分）
};
function noticeCatOf(kind) { return NOTICE_CAT_OF[kind] || 'msg'; }
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
    // 「系统消息提示」开关对公告与营销推送都生效：照收、不弹提示。广告 / 灯火 / 消息是必达的，
    // 不受这个开关影响（漏了退款通知比多看一条广告的伤害大得多）。
    muted: (kind === 'announce' || kind === 'promo') && announceMuted(users.find(u => u.id === uid)),
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

// ---------- 点赞通知：按作者聚合，别一条一个 ----------
// 点赞是最轻的动作，一条赞一个通知会把消息中心刷成噪音、作者干脆不看了。
// 规则：同一作者 6 小时内最多收一条；期间攒下的赞合起来说「收到 N 个赞」。
// 状态只放内存：重启最多丢掉几条待合并的赞（下次点赞会重新起算），不值得为它落盘。
const LIKE_NOTICE_GAP = 6 * 3600000;
const likeNoticeState = new Map();   // userId -> { n, works:[标题], lastAt }
function queueLikeNotice(w) {
  if (!w || !w.userId) return;                        // 匿名/未认领的作品没有收件人
  const st = likeNoticeState.get(w.userId) || { n: 0, works: [], lastAt: 0 };
  st.n += 1;
  if (w.title && !st.works.includes(w.title) && st.works.length < 3) st.works.push(w.title);
  likeNoticeState.set(w.userId, st);
  flushLikeNotice(w.userId, false);
}
function flushLikeNotice(uid, force) {
  const st = likeNoticeState.get(uid);
  if (!st || !st.n) return;
  if (!force && Date.now() - st.lastAt < LIKE_NOTICE_GAP) return;
  const n = st.n;
  const list = st.works.slice();
  const which = list.length === 1 ? `《${list[0]}》` : '';
  const what = list.length > 1 ? `${list.slice(0, 2).join('、')} 等 ${list.length} 件作品` : which;
  st.n = 0;
  st.works = [];
  st.lastAt = Date.now();
  addNotice(uid, {
    kind: 'work-like',
    title: n === 1 ? '作品收到 1 个赞' : `作品收到 ${n} 个赞`,
    text: `${what || '你的作品'} 收到 ${n} 个赞。`,
    // 只涉及一件作品时点了直接跳到它，多件就停在消息里
    workId: list.length === 1 ? (works.find(x => x.title === list[0] && x.userId === uid) || {}).id : undefined
  });
}
// 每 10 分钟扫一遍：攒够 6 小时的分批发出去（发完就清空，不会重复）
setInterval(() => { likeNoticeState.forEach((_, uid) => flushLikeNotice(uid, false)); }, 600000).unref?.();

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
  text: '「造梦橱窗」小程序正式上架，扫码即达；随小程序一起上线 3 个站内小程序推荐位，作品推荐从此能投给更精准的用户：他们可以在小程序里一键复制 App Store / 安卓下载链接，也可以直接扫码走进你的小程序——利好小程序、App 开发者'
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
  { key: 'rank', name: '榜单页 + 造梦酒馆顶部', where: '星梦榜页右栏（PC）+ 酒馆页头下方（一次购买两处轮展）', size: '推荐位 · 用作品封面' },
  { key: 'footer', name: '全站页脚上方', where: '所有页面底部通栏', size: '建议 1400 × 200' },
  // 小程序端：位置渲染在 zaomeng-mini 的 components/ad-card，与网页端互不干扰
  { key: 'mini-home-top', name: '小程序·首页顶部横幅', where: '小程序首页筛选栏下方、作品流上方', size: '建议 1080 × 360', platform: 'mini' },
  { key: 'mini-rank', name: '小程序·榜单页顶部', where: '小程序星梦榜分段栏下方一行（手机屏幕小，渲染成一行文字）', size: '文字行 · 一行标题', platform: 'mini' },
  { key: 'mini-detail', name: '小程序·作品详情页', where: '小程序详情页、评论区上方一行（手机屏幕小，渲染成一行文字）', size: '文字行 · 一行标题', platform: 'mini' },
  // 小程序端「推荐」的三个兑换位：首页第一格是原生作品卡（独占），
  // 榜单 / 发现是小程序里最省地方的一行文字——手机屏幕小，横幅会把内容挤下去。
  // 榜单页、发现页这两个文字位合并成一个槽（同网页端 rank 槽先例）：一次购买两处轮展，统一定价 3。
  { key: 'mini-home-first', name: '小程序·首页第一格', where: '小程序首页作品流第一张卡（独占）', size: '卡位 · 用作品封面', platform: 'mini' },
  { key: 'mini-bar', name: '小程序·造梦酒馆', where: '小程序酒馆页头下方、热搜板上方（每次展示一条）', size: '卡位 · 用作品封面', platform: 'mini' },
  { key: 'mini-rank-line', name: '小程序·一行文字（榜单页 + 发现页）', where: '星梦榜分段栏下方 + 发现页顶部（一次购买两处轮展）', size: '文字行 · 一行标题', platform: 'mini' }
];
const AD_SLOT_KEYS = AD_SLOTS.map(s => s.key);
if (!Array.isArray(ads)) ads = [];
// 广告形式：image = 图文（图片铺底），text = 纯文字卡片。老数据没有 kind 的按有没有图推断
ads.forEach(a => { if (a && a.kind !== 'image' && a.kind !== 'text') a.kind = a.image ? 'image' : 'text'; });
// 2026-11-09 榜单/发现一行文字合并成一个槽（mini-rank-line）：老数据里的 mini-feat-line 全部归入，
// 老投放自动变成「两处轮展」，不用迁移、不退不改单。
ads.forEach(a => { if (a && a.slot === 'mini-feat-line') a.slot = 'mini-rank-line'; });

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
//   所以「曝光包 + 外链去向」等于让外链跳转免费——买曝光包的人白拿了本该按外链价
//   （站内点击 ×2）买的外链流量，
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
// 【定价口径（2026-11-11 全站调价）：单价必须是整数盏/次，showViews 恒为 1】
//   按次扣额度、撤下退剩余次数 × 单价，单价整数 → 退款天然是整数盏，不会出现 12.5 这种数。
//   一盏 = 一次曝光 = 一次有效分享来访（SHARE_VISIT_POINTS=1），作者挣来的曝光和买来的曝光同价，
//   好讲、好算、不会因为零头出现「多退半盏 / 少退半盏」的争议。
//   曝光单价按端定基准、按位置分层：网页端基准 1 盏/次、小程序端基准 2 盏/次（真机全屏、打开即目标用户，
//   含金量高一档）；同一端内首页第一格是黄金位（每个进首页的人第一眼看到的就是它）收基准 3 倍，
//   榜单/发现类两处轮展位收 1.5 倍（网页 rank 因 PC 同屏最多 5 条（2026-11-12 右栏竖排）再高半档到 2 倍），详情页是页面最深处、
//   曝光少但都是真在挑作品的人，收基准价——它的价值在精准，不在量。
//   点击价 = 曝光价 × 30（2026-11-12 站长定档）：一个点击值 30 次曝光，所以
//   网页 30 / 60 / 90，小程序 60 / 60 / 90 / 120；网页外链再 ×2（60 / 120 / 180）。
//   为什么必须跟着曝光分层走（原来一刀切 30 是错的）：曝光 1/2/3 分层、点击却统收 30，
//   等于「曝光越贵的位置点击越便宜」——首页第一格卖 30 盏/点击、详情页也卖 30，
//   所有人都会去挤首页（单价一样、位置更好），详情和榜单的点击包卖不动，队列被打爆。
//   按 ×30 定完，各位置的打平点击率统一是 1/30 = 3.3%，和线上实测（详情 2.0 / 首页格 2.7 /
//   榜单+酒馆 4.1 / 小程序首页 2.8）同一量级：曝光包/点击包谁更省，取决于该位的实际 CTR，
//   不再取决于位置贵不贵——作者自己就能算，不用背规则。
//   CTR 会漂：以后调价先看后台「兑换总览」的位置点击率，别拍脑袋。
//
// 「首页第一格」的刚发布提醒：首页默认排序是「最新发布」，刚上传的作品本来就排在置顶作品之后第一张，
// 正好是 list-first 这个位置要占的地方——这时买第一格，多出来的主要是一张「推荐」角标，不是位置。
// 所以刚发布的作品买这两位时先劝一句（不硬拦，灯火是作者自己的），前端弹一次确认，
// 用户点「仍然要投」再带 ackFresh 下单。新鲜期口径放这里，前后端不各写一份。
const PROMO_FRESH_HOURS = 12;              // 作品发布后多少小时内买「首页第一格」会先提醒
const REDEEM_SLOTS = [
  {
    key: 'detail', name: '作品详情页', where: '详情弹窗内、评论区上方',
    showViews: 1, showPoints: 1, clickPoints: 30, extClickPoints: 60,
    showPacks: [50, 100, 200], clickPacks: [10, 20, 50], showMax: 1000, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 0,
    note: '多条同时投放，每次随机展示一条，各家机会均等 · 兑换后 10 分钟内你这边会优先展示自己那条，方便确认效果（自己看不扣灯火）'
  },
  // 榜单页 + 造梦酒馆页头下方共用同一个槽位（两页定位一致——「推荐站内作品」，
  // 多条随机挑；榜单页 PC 宽屏推荐位在右栏竖排最多 5 条、窄屏在页头下方通栏并排 2-4 条，手机一条；
  // 酒馆右栏竖排 2 条；不独占、不占排序）。
  // 合并理由：两处规则、单价完全一样，分开卖只会让投放者多做一个无意义的选择题；
  // 合并后一次购买两处都展示，曝光面更大、池子更满。
  {
    key: 'rank', name: '榜单页 + 造梦酒馆顶部', where: '星梦榜页右栏 + 酒馆页头下方（两处轮展）',
    showViews: 1, showPoints: 2, clickPoints: 60, extClickPoints: 120,
    showPacks: [50, 100, 200], clickPacks: [10, 20, 50], showMax: 1000, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 0,
    note: '一次购买、星梦榜页和造梦酒馆两处都展示：PC 上星梦榜右栏一次竖排最多 5 条同屏曝光（酒馆右栏 2 条，手机一条），各家机会均等 · 不占榜单名次/想法排序 · 兑换后 10 分钟内你这边会优先展示自己那条，方便确认效果（自己看不扣灯火）'
  },
  // 首页第一格：同时最多 3 条在投，但一次只显示一条（2026-11-11 站长拍板：不做自动轮播切换）。
  // 每次进页面随机挑一条（各家机会均等，与详情/榜单位同口径）；访客关掉当前条后从剩下的里再随机补一条。
  // 一单最多能挂多久直接决定后面排队的人等多久：
  // 兜底 14 天太长，一个作者没投完就能把 3 个轮换位占满两周，队列形同虚设。所以这个位单独放权给作者自己选，
  // 1-7 天（daysPick + maxDays），从「真正开始投放」那一刻起算——排队期间等待不算天数。
  // 注意：天数只改「这单能挂多久」，不改「按次扣费」——到期没投完的照样按原价退回余额，
  // 所以选短了不亏灯火，只是把位置更早让出来。
  // 一次只显 1 条意味着每位投放者约分到 1/人数 的进页面流量（原独占时 100% 命中），单价口径维持不变，
  // 仅曝光被均分——若日后觉得不划算可再议价。
  {
    key: 'list-first', name: '首页第一格', where: '首页作品列表第一张卡（置顶作品之后）',
    showViews: 1, showPoints: 3, clickPoints: 90, extClickPoints: 180,
    showPacks: [50, 100, 200], clickPacks: [10, 20, 50], showMax: 1000, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 3,
    daysPick: true, maxDays: 7,       // 作者自选投放期限，最长 7 天
    onePerView: true,                 // 一次只显 1 条、浏览期间不切换（每次进页面随机挑一条）
    freshHours: PROMO_FRESH_HOURS,   // 刚发布的作品本来就顶在这儿，买之前先劝一句
    note: '同时最多 3 条在投，每次进页面随机展示一条、浏览期间不切换；投放期限可选 1-7 天，到期没投完按原价退回'
  },
  // ---- 小程序端（手机）四个兑换位 ----
  // 手机端是真机访问、打开即目标用户，曝光含金量比网页高，再按位置分层：
  // 首页第一格 4（黄金位）、榜单+发现一行字 3（两处轮展）、详情页与酒馆 1（页面最深处，精准但量小，
  // 2026-11-12 站长拍板从 2 降到 1：这两位本来就是「顺手多看一眼」的位置，便宜才有人试）。
  // 点击价同样按曝光价 ×30（2026-11-12）：30 / 30 / 90 / 120。不跟曝光分层走的旧价（统收 30）
  // 会让贵的位点击反而便宜，大家都挤过来，等于自己把首页的位贱卖。
  // 套餐档位压小（20/50/100 次）：详情位 20 次曝光 = 40 盏，签到 + 分享几天就能试一次，不至于一买就是几百盏把人吓走。
  // 小程序里点开外链只能复制到剪贴板，体验差且容易被判导流，所以这四个位只做「跳站内作品详情页」
  // （internalOnly），extClickPoints 与 clickPoints 同价占位，下单接口对外链直接拒单。
  // 2026-11-06 13:01 随小程序上架一起放开购买（onSale 撤掉，internalOnly 保留）。
  // 要临时收回：给这个位置加回 onSale:false + pendingNote，前端会自动显示「内测中」。
  {
    key: 'mini-home-first', name: '小程序·首页第一格', where: '小程序首页作品流第一张卡',
    showViews: 1, showPoints: 4, clickPoints: 120, extClickPoints: 120,
    showPacks: [20, 50, 100], clickPacks: [10, 20, 50], showMax: 500, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 3,
    daysPick: true, maxDays: 7,       // 和网页首页第一格同口径：作者自选 1-7 天
    onePerView: true,                 // 同上：一次只显 1 条，不自动切换
    internalOnly: true,
    freshHours: PROMO_FRESH_HOURS,   // 同上：小程序首页作品流也是新的在最前
    note: '同时最多 3 条在投，每次进页面随机展示一条、浏览期间不切换；投放期限可选 1-7 天，到期没投完按原价退回'
  },
  // 详情页那一行：页面上最"深"的位置（点进作品的人才看得到），曝光少但都是真在挑作品的人，
  // 所以曝光单价不往上调——它的价值在精准，不在量。
  {
    key: 'mini-detail', name: '小程序·作品详情页', where: '小程序详情页、评论区上方一行',
    showViews: 1, showPoints: 1, clickPoints: 30, extClickPoints: 30,
    showPacks: [20, 50, 100], clickPacks: [10, 20, 50], showMax: 500, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 0,
    internalOnly: true,
    note: '一行文字，多位投放时每次随机展示一条'
  },
  // 榜单页、发现页的一行文字合并成一个槽（同网页端 rank 槽先例）：两处形态完全一样——
  // 都是一行文字、多位投放随机展示一条，分开卖只会让投放者多做一个无意义的选择题；
  // 合并后一次购买两处都展示，曝光面更大、池子更满。
  // 统一定价 3：一次买两处轮展，曝光面加倍，价也对齐网页端 rank 的 2 盏逻辑再高一档。
  {
    key: 'mini-rank-line', name: '小程序·一行文字（榜单页 + 发现页）', where: '星梦榜分段栏下方 + 发现页顶部（两处轮展）',
    showViews: 1, showPoints: 3, clickPoints: 90, extClickPoints: 90,
    showPacks: [20, 50, 100], clickPacks: [10, 20, 50], showMax: 500, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 0,
    internalOnly: true,
    note: '一次购买、星梦榜和发现页两处都展示一行文字：多位投放时每次随机一条，各家机会均等 · 兑换后 10 分钟内你这边会优先展示自己那条，方便确认效果（自己看不扣灯火）'
  },
  // 小程序·造梦酒馆：页头下方一张作品推荐卡，手机屏幕一次只展示一条（不并排），
  // 多位投放时随机挑一条，各家机会均等。定位和发现页一致。
  // 2026-11-09 的「临时价 1/3」已被 2026-11-11 全站调价取代：统一到小程序档 2/60。
  {
    key: 'mini-bar', name: '小程序·造梦酒馆', where: '小程序酒馆页头下方、热搜板上方（每次展示一条）',
    showViews: 1, showPoints: 1, clickPoints: 30, extClickPoints: 30,
    showPacks: [20, 50, 100], clickPacks: [10, 20, 50], showMax: 500, clickMax: 100,
    exclusive: false, maxActive: 3, maxQueued: 0,
    internalOnly: true,
    note: '一条作品推荐卡，多位投放时每次随机展示一条'
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
const REDEEM_MAX_DAYS = 7;                // 兜底有效期：开始投放后 7 天没投完也下线，剩余额度按原价退回（与撤下同口径）
const ADMIN_COMP_MAX_DAYS = 30;           // 站长代投的期限上限（天）：运营位想挂多久自己定，1-30 天之间
// 投放期限（天）：只有标了 daysPick 的位置（两个「首页第一格」独占位）让作者自己选，最长 maxDays 天（7）；
// 其余位置一律 7 天兜底（2026-11-11 起 14 → 7：推广是买曝光不是买长期展位，7 天足够判断效果，到点把位置让出来）。
// 起算点是真正开始投放那一刻：排队中的单子从轮到它算，等待期不占天数（否则排三天再投七天，等于买了十天位）。
function redeemDaysOf(slot, raw) {
  const c = redeemCfg(slot);
  const max = c.maxDays || REDEEM_MAX_DAYS;
  if (!c.daysPick) return max;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return max;   // 没传 / 传坏 = 给满额，别让缺参数变成「投一天」
  return Math.min(max, Math.max(1, n));
}
// 单子实际用几天：下单时锁进 r.days；老数据没有这个字段就落到该位置的上限
function redemptionDaysOf(r) {
  const n = r && r.days;
  return Number.isFinite(n) && n > 0 ? n : redeemDaysOf(r && r.slot);
}
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
// 只读一眼：这个桶是不是已经用满（不 +1）。认领口令用它做「猜错才计数」——
// 输对的作者不该消耗 IP 预算（同一栋楼 / 同一个基站下可能有几个作者同时在认领）。
function rateUsedUp(key, limit, windowMs) {
  const rec = rateBuckets.get(key);
  if (!rec) return false;
  if (Date.now() - rec.start > windowMs) return false;
  return rec.count >= limit;
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

// 来源名 → 跳转地址（后台来源榜点名字直达）。合并过的渠道名不是域名，得单独给个官网；
// 没进这张表的名字当普通域名处理（https:// + 名字）。给不出地址的返回空串，前端就不做链接。
const REF_SITE_URL = {
  'baidu.com': 'https://www.baidu.com',
  'google': 'https://www.google.com',
  'bing.com': 'https://www.bing.com',
  'sogou.com': 'https://www.sogou.com',
  '360 搜索': 'https://www.so.com',
  '神马搜索': 'https://m.sm.cn',
  'x.com': 'https://x.com',
  '微信公众号': 'https://mp.weixin.qq.com',
  '微博': 'https://weibo.com',
  '知乎': 'https://www.zhihu.com',
  '掘金': 'https://juejin.cn',
  'v2ex.com': 'https://www.v2ex.com',
  'Hacker News': 'https://news.ycombinator.com',
  'github.com': 'https://github.com',
  '抖音': 'https://www.douyin.com',
  '小红书': 'https://www.xiaohongshu.com'
};
function refUrlOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  if (REF_SITE_URL[s]) return REF_SITE_URL[s];
  // 形如域名的才当链接：「(其他来源)」这类聚合名不给跳
  if (/^[a-z0-9][a-z0-9.-]*(\.[a-z]{2,})$/i.test(s)) return 'https://' + s;
  return '';
}

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

// 客户端形态（后台「最后活跃端」用）。UA 只能分出四种，另外两种必须靠客户端自报：
//   mini  ← 小程序 utils/api.js 每个请求带的 x-client:mini（wx.request 的 UA 也带 MicroMessenger，不自己报就跟微信内 H5 一样）
//   pwa   ← 网页端 app.js 在 standalone 时落的 dm_cli=pwa cookie（display-mode 只有浏览器里才知道；
//           用 cookie 是因为它跟着每个请求自动走，fetch / sendBeacon / 图片都覆盖得到）
// 顺序有讲究：小程序头 → 爬虫 → PWA 标记 → UA（微信内 / 手机 / 平板 / 电脑）。
const CLIENT_TEXT = {
  mini: '小程序', wechat: '微信内', pwa: '桌面图标(PWA)',
  mobile: '手机浏览器', tablet: '平板', desktop: '电脑浏览器', bot: '爬虫', unknown: '未知'
};
function clientKindOf(req) {
  const h = (req && req.headers) || {};
  if (String(h['x-client'] || '').trim().toLowerCase() === 'mini') return 'mini';
  const dev = deviceOf(req, false);
  if (dev === 'bot') return 'bot';
  if (parseCookies(req).dm_cli === 'pwa') return 'pwa';
  return dev;   // wechat / desktop / mobile / tablet / unknown
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
  // 每个来路域名同时记一份去重访客（友链「来量 N · M 人」的人数口径）。
  // refs 超上限溢出到「其他来源」时 ref 也落到同一个溢出键，两份账的 key 恒一致。
  // 2026-11-14 起才有这份数据，之前的天聚合出来人数是 0，前端按「—」展示。
  bucket.refUv = bucket.refUv || {};
  const refUv = bucket.refUv[ref] || (bucket.refUv[ref] = {});
  refUv[vid] = 1;

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

// 友链来量：把 refs 里的域名跟 friends.json 的链接域名对一遍，单独聚合出来。
// 归一必须复用 normRefHost 那套规则 —— 友链写的是 https://www.zhihu.com/xxx，
// refs 里存的可能是合并后的「知乎」，直接比字符串永远对不上。
// 口径提醒：次数（refs）和人数（refUv）都只统计带 referrer 的那部分，
// 微信/App 内打开、复制粘贴、对方页面加了 noreferrer 都会落进「直接访问」，所以是下限。
const FRIEND_REF_WINDOW_DAYS = 30;
function friendRefKey(url) {
  const k = normRefHost(url, new Set());
  return (k === TRAFFIC_DIRECT || k === TRAFFIC_INNER) ? '' : k;
}
// 返回 { by7, by30, uv7, uv30 }，key 是归一后的域名。
// by* 是次数（PV）；uv* 是去重人数（UV），整个窗口跨天去重 ——
// 同一访客 30 天内从同一域名来了 10 次，来量 +10、人数只 +1。
// refUv 是 2026-11-14 起才记的，老数据没人数字段，聚合出来为 0（前端按「—」展示）。
function friendRefStats() {
  const days = visits.days || {};
  const keys = Object.keys(days).sort().slice(-FRIEND_REF_WINDOW_DAYS);
  const by30 = {}, by7 = {};
  const uvSet30 = {}, uvSet7 = {};   // 先攒访客 id 集合，最后取 size —— 跨天才去重得了
  keys.forEach((k, i) => {
    const d = days[k] || {};
    const refs = d.refs || {};
    const into7 = i >= keys.length - 7;   // 只剩「有数据的日」不足 7 天时按实际天数算
    const uvs = d.refUv || {};
    Object.keys(refs).forEach(h => {
      by30[h] = (by30[h] || 0) + (refs[h] || 0);
      if (into7) by7[h] = (by7[h] || 0) + (refs[h] || 0);
    });
    Object.keys(uvs).forEach(h => {
      const ids = Object.keys(uvs[h] || {});
      if (!ids.length) return;
      const s30 = uvSet30[h] || (uvSet30[h] = new Set());
      ids.forEach(v => s30.add(v));
      if (into7) {
        const s7 = uvSet7[h] || (uvSet7[h] = new Set());
        ids.forEach(v => s7.add(v));
      }
    });
  });
  // REF_MERGE 归一规则上线前的老数据可能存了 zhihu.com 这类裸键，
  // 归一键「知乎」之外把裸键的量也并给友链，历史累计不丢。
  // 裸键两种形态都认：完整 hostname（blog.zhihu.com）和注册域（zhihu.com）。
  // 同一裸域名多条友链共享时只并一次，别重复累加。人数的集合同理并给归一键。
  const merged = new Set();
  friends.forEach(f => {
    const k = friendRefKey(f.url);
    if (!k) return;
    let host = '';
    try { host = new URL(f.url).hostname.toLowerCase(); } catch {}
    if (!host) return;
    const variants = [host.replace(/^www\./, ''), host.split('.').slice(-2).join('.')];
    variants.forEach(raw => {
      if (!raw || raw === k || merged.has(raw)) return;
      merged.add(raw);
      if (by30[raw]) by30[k] = (by30[k] || 0) + by30[raw];
      if (by7[raw]) by7[k] = (by7[k] || 0) + by7[raw];
      if (uvSet30[raw]) {
        const s = uvSet30[k] || (uvSet30[k] = new Set());
        uvSet30[raw].forEach(v => s.add(v));
      }
      if (uvSet7[raw]) {
        const s = uvSet7[k] || (uvSet7[k] = new Set());
        uvSet7[raw].forEach(v => s.add(v));
      }
    });
  });
  const uv30 = {}, uv7 = {};
  Object.keys(uvSet30).forEach(h => { uv30[h] = uvSet30[h].size; });
  Object.keys(uvSet7).forEach(h => { uv7[h] = uvSet7[h].size; });
  return { by7, by30, uv7, uv30 };
}

// 流量构成聚合（只给后台，不进 /api/site-stats —— 来路域名不该公开）。
// 四档口径一起算：昨天看今天汇报、近 7 天看当下投放、近 30 天看月度、累计看规模。
// 注意「累计」只是 visits.days 里还留着的那些天（VISIT_RETENTION_DAYS 天，超期裁掉），
// 所以文案一律写「累计（最多保留 90 天）」，不能说成历史总量。
const TRAFFIC_WINDOW_DAYS = 7;
const TRAFFIC_TOP_N = 8;
function trafficStats() {
  const days = visits.days || {};
  const allKeys = Object.keys(days).sort();
  const addAll = (dst, src) => {
    if (!src || typeof src !== 'object') return;
    Object.keys(src).forEach(k => { dst[k] = (dst[k] || 0) + (src[k] || 0); });
  };
  // n > 0 取「最近 n 个自然日内」有数据的天（按日期卡，不是「最后 n 条记录」——
  // 中间断几天的话，后者会把 40 天前的数据当成「近 7 天」）；n = 0 取全部（受保留期限制）
  const cutoff = n => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const aggBy = keys => {
    const refs = {}, devs = {}, land = {};
    let miniPv = 0;
    keys.forEach(k => {
      const d = days[k] || {};
      addAll(refs, d.refs);
      addAll(devs, d.devs);
      addAll(land, d.land);
      if (d.mini) miniPv += (d.mini.pv || 0);   // 小程序只进设备分布，没有来路/落地页
    });
    return { window: 0, keys, refs, devs, land, miniPv };
  };
  const agg = n => aggBy(n > 0 ? allKeys.filter(k => k >= cutoff(n)) : allKeys);
  // 昨天 = 单独一个自然日（cutoff(2) 就是昨天的日期），给后台加一档「昨天」
  const yKey = cutoff(2);
  const aYes = aggBy(allKeys.filter(k => k === yKey));
  const a7 = agg(7), a30 = agg(30), aAll = agg(0);
  const DEV_KEYS = ['mobile', 'desktop', 'wechat', 'tablet', 'bot', 'unknown'];
  const devsOf = a => {
    const o = {};
    DEV_KEYS.forEach(k => { o[k] = a.devs[k] || 0; });
    o.mini = a.miniPv;
    return o;
  };
  const vOf = a => Object.values(a.refs).reduce((s, n) => s + n, 0);   // 与 refs 同口径的网页访问数
  const topNames = obj => Object.entries(obj)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, TRAFFIC_TOP_N)
    .map(e => e[0]);
  // 榜单名单 = 昨天前 8 ∪ 近 7 天前 8 ∪ 累计前 8，按累计降序：昨天刚起量的、新起量的渠道和曾经的大户都不漏
  const merge = (o7, oAll, oYes) => [...new Set([...(oYes ? topNames(oYes) : []), ...topNames(o7), ...topNames(oAll)])]
    .sort((x, y) => (oAll[y] || 0) - (oAll[x] || 0));
  // 友链域名集合：来源榜给这些域名打标，一眼分出「真友链带来的」和「别处自然来的」
  const friendHosts = new Set(friends.map(f => friendRefKey(f.url)).filter(Boolean));
  // 「直接访问 / 站内跳转」不是来源，从榜位里拿出去单独报数：
  // 否则前 8 名固定被这两格占掉，外部来路一多就看不到友链了
  const extRefs = o => {
    const r = {};
    Object.keys(o).forEach(k => {
      if (k !== TRAFFIC_DIRECT && k !== TRAFFIC_INNER) r[k] = o[k];
    });
    return r;
  };
  const rYes = extRefs(aYes.refs), r7 = extRefs(a7.refs), r30 = extRefs(a30.refs), rAll = extRefs(aAll.refs);
  const refs = merge(r7, rAll, rYes).map(name => ({
    name,
    url: refUrlOf(name),                                             // 后台来源榜点名字跳过去用
    count: r7[name] || 0,                                            // 兼容旧前端/回归脚本 = 近 7 天
    c1: rYes[name] || 0,
    c7: r7[name] || 0,
    c30: r30[name] || 0,
    cAll: rAll[name] || 0,
    friend: friendHosts.has(name)
  }));
  // 作品详情页的落地量比首页更有意义：直接标上作品名，不然看一屏 /w/xxx 认不出是谁
  const labelOf = p => {
    const m = p.match(/^\/w\/([A-Za-z0-9_-]+)/);
    const w = m && works.find(x => x.id === m[1]);
    return w ? w.title : '';
  };
  const landings = merge(a7.land, aAll.land, aYes.land).map(p => ({
    path: p,
    label: labelOf(p),
    count: a7.land[p] || 0,
    c1: aYes.land[p] || 0,
    c7: a7.land[p] || 0,
    c30: a30.land[p] || 0,
    cAll: aAll.land[p] || 0
  }));
  const winOf = a => ({
    window: a.window,
    days: a.keys.length,
    since: a.keys[0] || '',
    visits: vOf(a),
    direct: a.refs[TRAFFIC_DIRECT] || 0,
    inner: a.refs[TRAFFIC_INNER] || 0,
    devs: devsOf(a)
  });
  return {
    // 顶层字段保持「近 7 天」口径不变（老前端、tools/test-traffic-dims.js 都读这里）
    window: TRAFFIC_WINDOW_DAYS,
    days: a7.keys.length,
    since: a7.keys[0] || '',
    visits: vOf(a7),
    refs,
    direct: a7.refs[TRAFFIC_DIRECT] || 0,
    inner: a7.refs[TRAFFIC_INNER] || 0,
    devs: devsOf(a7),
    landings,
    // 四档口径对照表：d1（昨天）/ d7 / d30 / all（累计）
    windows: { d1: winOf(aYes), d7: winOf(a7), d30: winOf(a30), all: winOf(aAll) },
    retentionDays: VISIT_RETENTION_DAYS
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
const WORK_UV_DEVICES_PER_IP = 50;           // 同一 IP 对同一作品，每天最多计 50 个「设备访客」UV
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

// 设备访客的 IP 配额：{ '<workId>|<日期>': Map<ipHash, Set<vid>> }
// 为什么单独设限：vid 是浏览器里的一个随机串，换一个就是一个新「访客」。PV 频次闸（100 次/天）
// 已经把单 IP 的刷量压在 100 次以内，但 100 次能刷出 100 个 UV = 200 分，仍比一次真实点赞（5 分）划算。
// 50 个的上限能覆盖绝大多数共享出口（公司 / 校园 / 家庭一个出口一天内看同一作品的人数），
// 同时把单个出口靠换 vid 刷分的收益压在 100 分以内。超限的只计 PV，不再计 UV。
const uvIpDevices = new Map();
function uvDeviceAllowed(workId, ipHash, vidVal) {
  const dk = dateKey();
  if (uvIpDevices.size > 5000) {
    for (const k of uvIpDevices.keys()) if (!k.endsWith('|' + dk)) uvIpDevices.delete(k);
  }
  const key = workId + '|' + dk;
  let m = uvIpDevices.get(key);
  if (!m) { m = new Map(); uvIpDevices.set(key, m); }
  let set = m.get(ipHash);
  if (!set) { set = new Set(); m.set(ipHash, set); }
  if (set.has(vidVal)) return true;                        // 同一台设备重复浏览不占配额
  if (set.size >= WORK_UV_DEVICES_PER_IP) return false;    // 这个出口当天已经计够 50 台设备
  set.add(vidVal);
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

  // UV：一人一票。三套键语义统一成「一个人」——
  //   登录 → 账号 u:<id>（换端不变，最准）
  //   小程序未登录 → 设备 d:<deviceId>
  //   网页 / H5 / App webview 未登录 → 本机标识 v:<vid>（前端 dm_vid，广告计费也用它）
  // 以前网页端按出口 IP 认人：运营商 CGNAT 后面一个小区共用一个出口，几百人并成 1 个访客，
  // 网页端和 App 里的 UV 被严重低估、和「一起统计」的小程序对不上。换成本机标识后三端同尺。
  // 取不到本机标识（老浏览器 / 隐私模式写不进存储）才退回 IP 兜底，不至于漏计。
  let uvKey = '';
  let countUv = true;
  if (user) {
    uvKey = 'u:' + user.id;
    // 小程序不做 IP 维度的换号配额：小程序账号绑微信、设备也有限频，NAT 后按 IP 卡会误伤正常用户
    if (!mini) {
      if (!uvAccountAllowed(workId, ipHash, user.id)) countUv = false;       // 同 IP 当天第 4 个号起只计 PV
      if (countUv && Date.now() - new Date(user.createdAt || 0).getTime() < UV_MIN_ACCOUNT_AGE &&
          !uvNewbieAllowed(workId)) countUv = false;                          // 新号限量：作品当日新号 UV 收满 10 个后只计 PV
    }
  } else if (mini && o.deviceId) {
    uvKey = 'd:' + o.deviceId;
  } else if (o.vid) {
    uvKey = 'v:' + o.vid;
    if (!uvDeviceAllowed(workId, ipHash, o.vid)) countUv = false;            // 同一出口当天设备数超限，只计 PV
  } else {
    uvKey = 'ip:' + clientIp(req);
  }

  const dk = dateKey();
  const day = rec.days[dk] || (rec.days[dk] = { pv: 0, uv: {} });
  if (!day.uv) day.uv = {};
  day.pv = (day.pv || 0) + 1;
  if (countUv) { rec.uv[uvKey] = 1; day.uv[uvKey] = 1; }
  // 每个作品只保留最近 N 天明细
  const keys = Object.keys(rec.days).sort();
  while (keys.length > VISIT_RETENTION_DAYS) delete rec.days[keys.shift()];
  // 行为流水：谁在什么时候点开了哪件作品、从哪一块点进来的。
  // 人键就是上面算出来的 uvKey；IP 兜底的 'ip:xxx' 会被 behaviorLog 的格式校验挡掉（认不出人就不记）。
  behaviorLog(uvKey, 'view', { w: workId, f: behaviorSource(o.path) });
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

// ---------- 行为流水（谁 · 什么时候 · 做了什么） ----------
// 和上面几张表的区别：search-log 只回答「哪个词热」，work-visits 只回答「哪件作品火」，
// 两张表都对不上「人」。这份按人记流水，回答的是「这个人爱看什么 / 搜了什么没点开 / 从哪进来的」。
// 一行一条 JSON，追加写（不复写全量，避免和 writeJSON 抢文件），按月切：
//   data/behavior/2026-11.jsonl
// 人键沿用 PV/UV 那一套，不新造一套口径：
//   u:<userId>  登录账号
//   v:<dm_vid>  网页 / H5 / App webview 未登录的本机标识
//   d:<deviceId> 小程序未登录设备
// 不存明文 IP、不存 UA 原文、不存 Referer 原文（来源只存归一化后的桶名）。
// 用户侧的清空入口走 POST /api/behavior/clear。
const BEHAVIOR_RETENTION_DAYS = Math.max(7, Number(process.env.BEHAVIOR_RETENTION_DAYS) || 180);
const BEHAVIOR_MONTH_MAX_BYTES = 40 * 1024 * 1024;   // 单月文件上限，超了当月停写（异常刷量兜底）
const BEHAVIOR_FIELD_MAX = 40;                        // 单字段长度上限
const BEHAVIOR_PERSON_RE = /^[uvd]:[A-Za-z0-9_-]{3,64}$/;

// 行为类型只有三种，加新的先想清楚看板怎么用：
//   search = 执行了一次站内搜索（带 q 与结果条数 n，n=0 就是「搜了没东西」）
//   view   = 点开了一件作品的详情（带 w 与来源 f）
//   click  = 在「随便逛逛」模块里点了卡片（带 w，与曝光分母同口径）
const BEHAVIOR_ACTIONS = { search: 1, view: 1, click: 1 };
const BEHAVIOR_SRC_LABEL = {
  home: '首页最新', search: '搜索结果', rank: '榜单页', bar: '造梦酒馆',
  author: '作者主页', discover: '随便逛逛', detail: '详情直链', chronicle: '大事记',
  invite: '邀请页', mini: '小程序页', other: '其他 / 未知'
};

function behaviorMonthKey(t) {
  return dateKey(new Date(Number(t) || Date.now())).slice(0, 7);
}
function behaviorDirPath() {
  const d = path.join(DATA_DIR, 'behavior');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 建不出来就静默降级 */ }
  return d;
}
function behaviorFileOf(monthKey) { return path.join(behaviorDirPath(), monthKey + '.jsonl'); }

// 当月文件当前大小（缓存住，省掉每条一次 statSync）
const behaviorSizeCache = new Map();
// 看板缓存：后台来回切 tab 不必每次重扫文件；写新流水时整体失效
let behaviorStatsCache = new Map();

// 写一条。认不出人（IP 兜底的人键、空键）就不写——宁缺不错。
// 任何异常都吞掉：统计不能反过来影响浏览。
function behaviorLog(personKey, action, extra) {
  const p = String(personKey || '');
  if (!BEHAVIOR_PERSON_RE.test(p)) return false;
  const a = String(action || '');
  if (!BEHAVIOR_ACTIONS[a]) return false;
  const x = extra || {};
  const rec = { t: Date.now(), p, a };
  if (x.w) rec.w = String(x.w).slice(0, BEHAVIOR_FIELD_MAX);
  if (x.q) rec.q = normSearchQ(x.q);
  if (typeof x.n === 'number' && x.n >= 0) rec.n = x.n;
  if (x.f) rec.f = String(x.f).slice(0, 16);
  try {
    const mk = behaviorMonthKey(rec.t);
    const size = behaviorSizeCache.has(mk) ? behaviorSizeCache.get(mk) : (() => {
      try { return fs.statSync(behaviorFileOf(mk)).size; } catch { return 0; }
    })();
    if (size > BEHAVIOR_MONTH_MAX_BYTES) return false;
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(behaviorFileOf(mk), line);
    behaviorSizeCache.set(mk, size + Buffer.byteLength(line));
    behaviorStatsCache.clear();
    return true;
  } catch { return false; }
}

// 来源归一化：前端把打开详情时的 location.pathname + search 原样带上来，
// 这里只留桶名——看板要的是「从哪一块点进来的」，不是每个具体 URL。
function behaviorSource(raw) {
  const s = String(raw || '');
  if (!s) return '';
  if (/[?&]q=/.test(s)) return 'search';
  if (s === '/' || s.startsWith('/?') || s === '') return 'home';
  if (s.startsWith('/rank')) return 'rank';
  if (s.startsWith('/bar')) return 'bar';
  if (s.startsWith('/u/')) return 'author';
  if (s.startsWith('/w/')) return 'detail';
  if (s.startsWith('/chronicle')) return 'chronicle';
  if (s.startsWith('/invite')) return 'invite';
  if (s.startsWith('/mini')) return 'mini';
  return 'other';
}

// 从 fromMs 到 toMs 覆盖到的月份（含头含尾），月份键 'YYYY-MM' 可直接字符串比较
function behaviorMonthsBetween(fromMs, toMs) {
  const out = [];
  let [y, m] = behaviorMonthKey(fromMs).split('-').map(Number);
  const end = behaviorMonthKey(toMs);
  for (let i = 0; i < 36; i++) {
    const k = y + '-' + String(m).padStart(2, '0');
    out.push(k);
    if (k >= end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function behaviorRead(days) {
  const to = Date.now();
  const from = to - Math.max(1, days) * 86400000;
  const out = [];
  for (const mk of behaviorMonthsBetween(from, to)) {
    let raw = '';
    try { raw = fs.readFileSync(behaviorFileOf(mk), 'utf-8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e = null;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || !e.p || !e.a || !(Number(e.t) >= from)) continue;
      out.push(e);
    }
  }
  return out;
}

// 过期月份整个文件删掉（按月切就是为了能整块扔）
function pruneBehavior() {
  const keepFrom = behaviorMonthKey(Date.now() - BEHAVIOR_RETENTION_DAYS * 86400000);
  let files = [];
  try { files = fs.readdirSync(behaviorDirPath()); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const m = /^(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || m[1] >= keepFrom) continue;
    try { fs.unlinkSync(path.join(behaviorDirPath(), f)); behaviorSizeCache.delete(m[1]); n++; } catch { /* 删不掉下次再删 */ }
  }
  return n;
}

function behaviorPersonName(p) {
  const key = String(p || '');
  if (key.startsWith('u:')) {
    const u = users.find(x => x.id === key.slice(2));
    return (u && (u.nickname || u.username)) ? '@' + (u.nickname || u.username) : '账号 ' + key.slice(2, 8);
  }
  if (key.startsWith('d:')) return '小程序 ' + key.slice(2, 6);
  return '访客 ' + key.slice(2, 6);
}

// 看板缓存：后台来回切 tab 不必每次重扫文件；写新流水时整体失效
function behaviorStats(days) {
  days = Math.max(1, Math.min(BEHAVIOR_RETENTION_DAYS, parseInt(days, 10) || 7));
  if (behaviorStatsCache.has(days)) return behaviorStatsCache.get(days);
  pruneBehavior();
  const evts = behaviorRead(days);

  const peopleMap = new Map(), worksMap = new Map(), srcMap = new Map(), dayMap = new Map();
  const searchMap = new Map(), byPerson = new Map();
  let searches = 0, zeroSearches = 0, views = 0, clicks = 0;

  for (const e of evts) {
    const dk = dateKey(new Date(Number(e.t)));
    const day = dayMap.get(dk) || { d: dk, events: 0, searches: 0, views: 0, people: new Set() };
    day.events += 1;
    day.people.add(e.p);
    dayMap.set(dk, day);

    const per = peopleMap.get(e.p) || { p: e.p, events: 0, searches: 0, views: 0, clicks: 0, lastAt: 0, words: new Map() };
    per.events += 1;
    per.lastAt = Math.max(per.lastAt, Number(e.t) || 0);
    peopleMap.set(e.p, per);

    const seq = byPerson.get(e.p);
    if (seq) seq.push(e); else byPerson.set(e.p, [e]);

    if (e.a === 'search') {
      searches += 1; day.searches += 1; per.searches += 1;
      if (Number(e.n) === 0) zeroSearches += 1;
      const k = String(e.q || '').toLowerCase();
      if (k) {
        const s = searchMap.get(k) || { q: e.q, n: 0, zero: 0, clicked: new Set() };
        s.n += 1;
        if (Number(e.n) === 0) s.zero += 1;
        searchMap.set(k, s);
        per.words.set(e.q, (per.words.get(e.q) || 0) + 1);
      }
    } else if (e.a === 'view') {
      views += 1; day.views += 1; per.views += 1;
      if (e.w) {
        const w = worksMap.get(e.w) || { id: e.w, views: 0, people: new Set() };
        w.views += 1;
        w.people.add(e.p);
        worksMap.set(e.w, w);
      }
      if (e.f) srcMap.set(e.f, (srcMap.get(e.f) || 0) + 1);
    } else if (e.a === 'click') {
      clicks += 1; per.clicks += 1;
    }
  }

  // 搜索 → 点击：同一个人、30 分钟内、下一次搜索之前、且来源是搜索结果页的 view 才算。
  // 三个限定都必要：不卡 f 会把「搜完又去首页点了一篇」算成搜索结果；
  // 不排除 n=0 的词，会让「搜了个没结果的词」凭空拿到 100% 转化。
  // 站内没有会话埋点，这仍只是近似归因，看板标题里写明口径，别当精确漏斗用。
  for (const seq of byPerson.values()) {
    const arr = seq.slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (e.a !== 'search' || !e.q || !(Number(e.n) > 0)) continue;
      const s = searchMap.get(String(e.q).toLowerCase());
      if (!s) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const x = arr[j];
        if (x.a === 'search') break;
        if ((Number(x.t) || 0) - (Number(e.t) || 0) > 30 * 60000) break;
        if (x.a === 'view' && x.w && x.f === 'search') s.clicked.add(x.w);
      }
    }
  }

  const searchRows = [...searchMap.values()]
    .map(r => ({ q: r.q, n: r.n, zero: r.zero, clicked: r.clicked.size, ctr: r.n ? Math.round(r.clicked.size / r.n * 100) : 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 40);

  const workRows = [...worksMap.values()]
    .sort((a, b) => b.views - a.views)
    .slice(0, 20)
    .map(r => {
      const w = works.find(x => x && x.id === r.id);
      return { id: r.id, title: (w && w.title) || r.id, views: r.views, people: r.people.size, online: !!(w && isVisible(w)) };
    });

  const peopleRows = [...peopleMap.values()]
    .sort((a, b) => b.events - a.events || b.lastAt - a.lastAt)
    .slice(0, 30)
    .map(r => ({
      p: r.p, name: behaviorPersonName(r.p), events: r.events, searches: r.searches,
      views: r.views, clicks: r.clicks, lastAt: r.lastAt,
      words: [...r.words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0])
    }));

  const daily = [...dayMap.values()]
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .map(r => ({ d: r.d, events: r.events, searches: r.searches, views: r.views, people: r.people.size }));

  const out = {
    days,
    from: dateKey(new Date(Date.now() - days * 86400000)),
    to: dateKey(),
    retentionDays: BEHAVIOR_RETENTION_DAYS,
    counts: { events: evts.length, people: peopleMap.size, searches, zeroSearches, views, clicks },
    daily,
    searches: searchRows,
    works: workRows,
    people: peopleRows,
    sources: [...srcMap.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => ({ f: k, label: BEHAVIOR_SRC_LABEL[k] || k, n }))
  };
  behaviorStatsCache.set(days, out);
  return out;
}

// 清空某个人的全部流水（用户自己的「清空浏览记录」）。
// 流水是按行追加的，只能整文件重写一遍——量小（几千行），当场做完最省心。
function behaviorClear(personKey) {
  const p = String(personKey || '');
  if (!BEHAVIOR_PERSON_RE.test(p)) return { removed: 0 };
  let files = [];
  try { files = fs.readdirSync(behaviorDirPath()).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch { return { removed: 0 }; }
  let removed = 0;
  for (const f of files) {
    const full = path.join(behaviorDirPath(), f);
    let raw = '';
    try { raw = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const keep = [];
    let hit = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e = null;
      try { e = JSON.parse(line); } catch { keep.push(line); continue; }
      if (e && e.p === p) { hit += 1; continue; }
      keep.push(line);
    }
    if (!hit) continue;
    removed += hit;
    try { fs.writeFileSync(full, keep.length ? keep.join('\n') + '\n' : ''); } catch { /* 写不进去就下次再清 */ }
  }
  if (removed) { behaviorSizeCache.clear(); behaviorStatsCache.clear(); }
  return { removed };
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

// ---------- 首页「随便逛逛」曝光统计（阶段 1：只上报 + 后台看板，首页展示逻辑未开） ----------
// 方案定稿：docs/discover-spec-v1.md。核心口径两条：
//   n = 这件作品被多少个「不同的人」在模块里看到（累计只增不减，没有次数上限、不做窗口衰减）；
//   推过 = 每个访客自己的已看名单（users[key].ids），阶段 2 取卡时用它做「推过不再推」硬去重。
// 两个上限都是保险丝不是业务规则（spec §14）：
//   SOFT_RETIRE_N=30 业务降级线——n≥30 的作品在阶段 2 排在池尾垫底（2026-11-11 起，原先
//   是踢出池子、只在混填出现；小站会把「没逛过」掏空，见 discoverPick 注释。env DISCOVER_SOFT_RETIRE_N 可调）；
//   S_CAP=60 存储封顶——离开优先池的作品再记第 61 个人对取卡没用，纯省空间。
const DISCOVER_ENABLED = String(process.env.DISCOVER_ENABLED || 'off').trim().toLowerCase() === 'on';
const DISCOVER_SOFT_RETIRE_N = Math.max(1, Number(process.env.DISCOVER_SOFT_RETIRE_N) || 30);
const DISCOVER_K_MAX = 0.6;            // 后台 k 的上限：k=0.6 → w∈[0.7,1.3]，再大就破坏雨露均沾
const EXPO_S_CAP = 60;
const EXPO_C_CAP = 60;
const EXPO_USER_IDS_CAP = 200;         // 每个访客已看名单的上限（LRU：超了丢最早的）
const EXPO_USER_TTL_DAYS = 180;        // 已看名单保留期：不活跃即清理
const EXPO_IP_DEVICES_PER_WORK_DAY = 3;// 单 IP 单作品每天最多计 3 个设备人数：防一台机器伪造多个 vid
const EXPO_REPORT_RPH = 240;           // 单 IP 每小时上报请求数（一屏合并一次，正常浏览用不到零头）
const DISCOVER_CTR_ALPHA = 15;         // CTR 贝叶斯平滑强度：曝光很少的新作品不会因一两笔点击霸榜
const DISCOVER_RPH = 300;              // 取卡接口限频：取卡本身只写「已看名单」，不碰 n

let expoData = (() => {
  const raw = readJSON('expo.json', null);
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!d.works || typeof d.works !== 'object') d.works = {};
  if (!d.users || typeof d.users !== 'object') d.users = {};
  if (!d.ips || typeof d.ips !== 'object') d.ips = {};
  if (!d.manual || typeof d.manual !== 'object') d.manual = {};
  // 不推荐名单（2026-11-13）：推广/导流件从「随便逛逛」彻底移出，与手动加权分开存
  if (!d.noRec || typeof d.noRec !== 'object' || Array.isArray(d.noRec)) d.noRec = {};
  if (!d.days || typeof d.days !== 'object') d.days = {};
  if (!d.cfg || typeof d.cfg !== 'object') d.cfg = {};
  d.cfg.on = d.cfg.on === true;
  const k = Number(d.cfg.k);
  d.cfg.k = Number.isFinite(k) ? Math.min(DISCOVER_K_MAX, Math.max(0, k)) : 0.3;
  const dks = Object.keys(d.days).sort();
  while (dks.length > 30) delete d.days[dks.shift()];
  return d;
})();

let expoSaveTimer = null;
function scheduleExpoSave() {
  if (expoSaveTimer) return;
  expoSaveTimer = setTimeout(() => {
    expoSaveTimer = null;
    try { writeJSON('expo.json', expoData); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}
function saveExpoNow() {
  if (expoSaveTimer) { clearTimeout(expoSaveTimer); expoSaveTimer = null; }
  try { writeJSON('expo.json', expoData); } catch (e) { /* 同上 */ }
}

// 认人：登录 u: / 小程序 d: / 网页·H5·App v:（dm_vid，与作品 PV/UV、广告计费同一个口径）
function expoPersonKey(req, body) {
  const user = currentUser(req);
  if (user && user.id) return 'u:' + user.id;
  const b = body || {};
  const mini = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.deviceId || '')) ? String(b.deviceId) : '';
  if (mini) return 'd:' + mini;
  const vid = /^[A-Za-z0-9_-]{8,40}$/.test(String(b.vid || '')) ? String(b.vid) : '';
  if (vid) return 'v:' + vid;
  return '';
}

function expoWorkRec(id) {
  const r = expoData.works[id] || (expoData.works[id] = { s: [], c: [], at: 0 });
  if (!Array.isArray(r.s)) r.s = [];
  if (!Array.isArray(r.c)) r.c = [];
  return r;
}
function expoUserRec(key) {
  const r = expoData.users[key] || (expoData.users[key] = { ids: [], at: 0 });
  if (!Array.isArray(r.ids)) r.ids = [];
  return r;
}
// 单 IP 单作品每天的人数额度桶：数组里只存「真正计了数」的人，跨天自动重建
function expoIpDayRec(ipk) {
  const dk = dateKey();
  let r = expoData.ips[ipk];
  if (!r || r.day !== dk) r = expoData.ips[ipk] = { day: dk, works: {} };
  if (!r.works || typeof r.works !== 'object') r.works = {};
  return r;
}
function expoManualLv(id) {
  const m = expoData.manual[id];
  if (!m) return 0;
  if (m.until && m.until < Date.now()) return 0;
  return Math.max(-2, Math.min(2, Number(m.lv) || 0));
}
// 「不推荐」（2026-11-13）：从随便逛逛彻底移出——不参与取卡、不参与重温混填、也不参与
// 「继续随机」。与手动加权是两件事：加权只改同一梯队内部的顺序，不推荐是「不出现在推荐位」，
// 所以两者互斥存储（设了不推荐会清掉加权档位，反之亦然）。
// until=0 表示长期有效：推广件通常没有到期日，等站长手动解除。
function expoNoRec(id) {
  const m = expoData.noRec[id];
  if (!m) return null;
  if (m.until && m.until < Date.now()) return null;
  return m;
}

// 打开后台看板 / 启动时顺手清一遍：过期名单、过期加权、旧日计数、跨天的 IP 桶
function pruneExpo() {
  const cutoff = Date.now() - EXPO_USER_TTL_DAYS * 86400000;
  for (const k in expoData.users) {
    const r = expoData.users[k];
    if (!r || (r.at || 0) < cutoff) delete expoData.users[k];
  }
  for (const id in expoData.manual) {
    const m = expoData.manual[id];
    if (m && m.until && m.until < Date.now()) delete expoData.manual[id];
  }
  for (const id in expoData.noRec) {
    const m = expoData.noRec[id];
    if (m && m.until && m.until < Date.now()) delete expoData.noRec[id];
  }
  const dks = Object.keys(expoData.days).sort();
  while (dks.length > 30) delete expoData.days[dks.shift()];
  const today = dateKey();
  for (const k in expoData.ips) {
    const r = expoData.ips[k];
    if (!r || r.day !== today) delete expoData.ips[k];
  }
}

// 记一次曝光：前端把一屏卡片合并成一个批量请求。
// 幂等——同一个人对同一件作品无论上报多少次，n 都只加 1（所以阶段 2 的「继续随机」
// 模式照常上报也不会把 n 刷高）。同一件作品的名单照常记，哪怕今天这个 IP 的设备
// 额度用完 / s 已封顶：名单是阶段 2「推过不再推」的依据，少记会让用户重复看到同一张卡。
function recordExpo(req, body) {
  body = body || {};
  const key = expoPersonKey(req, body);
  if (!key) return { ok: true, skipped: 'no-person' };   // 必须认得出人：宁可少算不可错算（spec §8）
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(ua)) return { ok: true, skipped: 'ua' };
  if (deviceOf(req, false) === 'bot') return { ok: true, skipped: 'bot' };
  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .slice(0, 60).map(x => String(x || '').slice(0, 40)).filter(Boolean);
  if (!ids.length) return { ok: true, skipped: 'no-ids' };
  const ipk = ipKeyOf(req);
  if (!rateLimit('expo:' + ipk, EXPO_REPORT_RPH, 3600000)) return { ok: true, skipped: 'rate' };
  const user = currentUser(req);
  const ipDay = expoIpDayRec(ipk);
  const now = Date.now();
  let counted = 0;
  for (const wid of ids) {
    const w = works.find(x => x && x.id === wid);
    if (!w || !isVisible(w)) continue;
    if (user && w.userId && w.userId === user.id) continue;   // 作者自己不计（与 trackWorkAction 同一立场）
    const rec = expoWorkRec(wid);
    if (!rec.s.includes(key)) {
      const devs = ipDay.works[wid] || (ipDay.works[wid] = []);
      let countable = devs.includes(key);
      if (!countable && devs.length < EXPO_IP_DEVICES_PER_WORK_DAY) { devs.push(key); countable = true; }
      if (countable && rec.s.length < EXPO_S_CAP) {
        rec.s.push(key);
        counted++;
        const dk = dateKey();
        expoData.days[dk] = (expoData.days[dk] || 0) + 1;
      }
      rec.at = now;
    }
    const ur = expoUserRec(key);
    const ii = ur.ids.indexOf(wid);
    if (ii >= 0) ur.ids.splice(ii, 1);
    ur.ids.push(wid);
    while (ur.ids.length > EXPO_USER_IDS_CAP) ur.ids.shift();
    ur.at = now;
  }
  scheduleExpoSave();
  return { ok: true, counted };
}

// 详情点击：单独字段，不改 n、不消耗曝光名额（方案 A 敲定）。
// 硬约束 c ⊆ s：没在模块里曝光过就点进来的不算模块 CTR，保证分子分母同口径（spec §8）。
function recordExpoClick(req, body) {
  body = body || {};
  const wid = String(body.workId || '').slice(0, 40);
  if (!wid) return { ok: true, skipped: 'no-work' };
  const key = expoPersonKey(req, body);
  if (!key) return { ok: true, skipped: 'no-person' };
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(ua)) return { ok: true, skipped: 'ua' };
  if (deviceOf(req, false) === 'bot') return { ok: true, skipped: 'bot' };
  const w = works.find(x => x && x.id === wid);
  if (!w || !isVisible(w)) return { ok: true, skipped: 'invisible' };
  const user = currentUser(req);
  if (user && w.userId && w.userId === user.id) return { ok: true, skipped: 'owner' };
  const rec = expoWorkRec(wid);
  if (!rec.s.includes(key)) return { ok: true, skipped: 'not-exposed' };
  if (rec.c.length >= EXPO_C_CAP) return { ok: true, skipped: 'cap' };
  if (!rec.c.includes(key)) rec.c.push(key);
  rec.at = Date.now();
  // 行为流水：逛模块里的点击（曝光在别处记，这里只记「真点开了」）。
  // 上面对 c 去重和封顶，流水照样记——同一人隔天又点一次，是「习惯」不是重复计数。
  behaviorLog(key, 'click', { w: wid, f: 'discover' });
  scheduleExpoSave();
  return { ok: true };
}

// ---------- 阶段 2：取卡（spec §3.3 / §4 / §5，docs/discover-spec-v1.md） ----------
// 字符串 → 32 位种子（xmur3 精简版）：把 vid+nonce 变成 mulberry32 能吃的种子
function strSeed32(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// 全站平均 CTR（CTR 贝叶斯平滑的先验 G）：取卡时现算，80 件的量级零负担
function discoverGlobalCtr() {
  let s = 0, c = 0;
  for (const w of works) {
    if (!isVisible(w)) continue;
    const rec = expoData.works[w.id];
    if (!rec) continue;
    s += rec.s.length; c += rec.c.length;
  }
  return s ? c / s : 0;
}

// 桶内加权抽样：四个信号各算桶内百分位再加权成 q，w = 1 + k*(q−0.5)。
// 硬约束「权重只改顺序，不改入池」：能不能被抽到由 n 和已看名单决定，参数全错最多偏 ±15%。
// Efraimidis–Spirakis：key = rand^(1/w)，key 大者胜，无放回一次出 take 张。
function discoverWeightedSample(bucket, take, k, gCtr) {
  const now = Date.now();
  const rows = bucket.map(w => {
    const rec = expoData.works[w.id];
    const s = rec ? rec.s.length : 0, c = rec ? rec.c.length : 0;
    // 互动用「率」不用「量」：除以曝光人数才是转化率，新老作品才可比（spec §5）
    const inter = ((w.likes || 0) + (w.favs || 0) * 1.5 + countComments(w.id) * 2 + tipAggOf(w.id).count)
      / Math.max(s, 5);
    return {
      w,
      ctr: (c + DISCOVER_CTR_ALPHA * gCtr) / (s + DISCOVER_CTR_ALPHA),
      inter,
      man: expoManualLv(w.id),
      fresh: (now - new Date(w.createdAt || 0).getTime()) < 86400000 ? 1 : 0
    };
  });
  // 百分位与量纲无关：2000 star 和 3 个赞直接加权会把权重拉爆，先转桶内名次
  const toPct = key => {
    const n = rows.length;
    if (n <= 1) { rows.forEach(r => { r[key] = 0.5; }); return; }
    rows.slice().sort((a, b) => a[key] - b[key]).forEach((r, i) => { r[key] = i / (n - 1); });
  };
  ['ctr', 'inter', 'man', 'fresh'].forEach(toPct);
  return rows
    .map(r => ({
      w: r.w,
      weight: Math.max(0.05, 1 + k * ((0.45 * r.ctr + 0.30 * r.inter + 0.15 * r.man + 0.10 * r.fresh) - 0.5))
    }))
    .map(x => ({ w: x.w, key: Math.pow(Math.random() + 1e-12, 1 / x.weight) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, take)
    .map(x => x.w);
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 取卡主逻辑（mode=pool）：按 n 升序分桶，最小桶优先，允许有序补齐、禁止跳层（spec §4）。
// 空了不硬凑：全站看完 → state='empty'，交给前端空状态（2026-11-11 起已降级件只是排后，不再离池）。
// 取卡是纯读：不写已看名单。「看过」的唯一写入点是 recordExpo（可视区 ≥50% 持续 500ms 的
// 真实曝光上报）——发卡时抢先写名单会导致刷新几轮就把池子刷空（2026-11-09 线上踩过）。
//
// 「新」角标分界线（2026-11-12）：这个人上次来逛之后上架的才算新。
// 为什么不用固定的「7 天内」：小站一次批量上架几十件，固定窗口会让半屏卡片都挂「新」
// （实测 31 张卡 16 张命中），等于没标。相对「上次来」才是「这里有新作」的本意。
// 口径：walkBase = 本次到访的基准时刻，整个到访期间保持不变；只有「离开超过半小时再回来」
// 才算新的一次到访（ur.at 由曝光上报持续刷新，一直逛就一直不算离开）。
// 两个兜底：① 第一次来 / 隔了 7 天以上 → 只看最近 24 小时（否则新用户一进来满屏「新」）；
// ② 同一到访内反复刷新、点进详情再回来，基准不动 → 「新」不会逛一圈就消失。
function wanderFreshSince(key, now) {
  let ur = expoData.users[key];
  if (!ur) ur = expoData.users[key] = { ids: [], at: 0 };   // at:0 → 走「第一次来」兜底
  const lastSeen = Number(ur.at) || 0;
  const newVisit = !Number(ur.walkBase) || (now - lastSeen) > 30 * 60e3;
  if (newVisit) {
    ur.walkBase = (lastSeen && now - lastSeen <= 7 * 86400e3) ? lastSeen : now - 86400e3;
  }
  ur.at = now;
  scheduleExpoSave();
  return ur.walkBase;
}
// exclude：前端「已经在屏上」的作品 id 集合，只在「加载更多」时传。
// 为什么需要它：已看名单（users[key].ids）只有**真的看到**（可视 ≥50% 持续 500ms）才写，
// 而「加载更多」追加的卡本来就在视口下方——没看过的池子一动不动，下一批照样把同一批
// 没看过的随机抽回来，前端只能去重丢掉。结果就是按钮一直亮、点一次只多两三张、
// 点到最后一张新的都没有（2026-11-13 线上手机端现象，PC 上因为老账号记着「最新」排序看不到）。
// 传了 exclude 之后：每批都能拿到整屏真没屏过的卡；池子发完返回 state='drained'，前端收按钮。
function discoverPick(req, key, size, exclude) {
  pruneExpo();
  // 自己的作品不推荐给自己（2026-11-09 用户拍板）：作者天天看自己的东西，占推荐位纯浪费。
  // 只影响发卡顺序，不影响任何统计口径——曝光/点击上报、后台看板照常记录。
  const me = currentUser(req);
  const mine = me ? new Set(works.filter(w => w.userId === me.id).map(w => w.id)) : null;
  const seenRec = expoData.users[key];
  const seen = new Set(seenRec && Array.isArray(seenRec.ids) ? seenRec.ids : []);
  // 不推荐件（推广/导流）在源头剔掉：取卡池、重温混填、total 共用这一份，不搞三处过滤
  const all = publicWorks(req).filter(w => !expoNoRec(w.id));
  // 降级线改口径（2026-11-11）：n≥SOFT_RETIRE_N 的作品不再「踢出池子」，改成「排后垫底」——
  // 下面分桶按 n 升序，降级件拼在池尾天然排最后，雨露均沾的意图没丢。
  // 旧口径在小站会掏空池子：线上实测 105 件里 104 件曝光人数过 30，「没逛过」对所有人
  // 恒为 0~2 件，清空已看也救不回来（s 是全站 CTR 统计，reset 故意不动它）。
  // 只要这个人没看过，降级件拼进来也不打「重温」角标——对他就是新卡。
  const skip = exclude instanceof Set ? exclude : new Set();
  const pool = [], retired = [];
  for (const w of all) {
    if (mine && mine.has(w.id)) continue;
    if (seen.has(w.id)) continue;
    const rec = expoData.works[w.id];
    (rec && rec.s.length >= DISCOVER_SOFT_RETIRE_N ? retired : pool).push(w);
  }
  pool.push(...retired);
  // 「没看过的总数」要在排除屏上卡之前算：它是这个人还没逛过的真实池子，
  // 屏上的卡只是「还没上报看过」，不该从 left 里扣掉（否则计数会先跌后涨）
  const unseenTotal = pool.length;
  if (!unseenTotal) return { state: 'empty', list: [], revisit: [], total: all.length, left: 0 };
  // 屏上已有的直接不参与发牌；全被排掉 → drained（前端收按钮），不是「全站看完了」的 empty
  const poolOpen = skip.size ? pool.filter(w => !skip.has(w.id)) : pool;
  if (!poolOpen.length) return { state: 'drained', list: [], revisit: [], total: all.length, left: unseenTotal };

  const k = Number(expoData.cfg.k) || 0;
  const gCtr = discoverGlobalCtr();
  // n 升序分桶：Map<n, work[]>
  const buckets = new Map();
  for (const w of poolOpen) {
    const rec = expoData.works[w.id];
    const n = rec ? rec.s.length : 0;
    if (!buckets.has(n)) buckets.set(n, []);
    buckets.get(n).push(w);
  }
  const out = [], revisit = [];
  for (const n of [...buckets.keys()].sort((a, b) => a - b)) {
    if (out.length >= size) break;
    const bucket = buckets.get(n);
    const take = Math.min(size - out.length, bucket.length);
    // k=0 → 完全均等（洗牌取前 take 个）；k>0 且同桶多件 → 加权抽样。
    // 一个 if 只在「要不要算权重」处出现，两条路径共用同一个取卡循环，不搞两套分支
    out.push(...(k > 0 && bucket.length > 1
      ? discoverWeightedSample(bucket, take, k, gCtr)
      : shuffleInPlace(bucket.slice()).slice(0, take)));
  }

  // 有序补齐：填不满一屏才从全站随机混填，打「重温」角标（2026-11-11 起池子已含没看过的
  // 降级件，这里剩下的只有「这个人真看过」的）。
  // 补齐同样跳过自己的作品——重温角标也不该重温自己的东西。
  if (out.length < size) {
    const picked = new Set(out.map(w => w.id));
    const rest = shuffleInPlace(all.filter(w => !picked.has(w.id) && !skip.has(w.id) && !(mine && mine.has(w.id)) && !expoNoRec(w.id)));
    for (const w of rest) {
      if (out.length >= size) break;
      out.push(w); revisit.push(w.id);
    }
  }
  const state = revisit.length ? 'partial' : 'full';

  return {
    state, list: out, revisit,
    total: all.length,
    // 「没看过的总数」= pool 本身（已排除已看/自己的；没看过的降级件也算在内——
    // 2026-11-11 起它们只是排后，不是离池）。2026-11-10 修：
    // 旧口径减掉本批张数，首屏一出来就扣 19 件，手机 3-4 屏会「只看了七八个却显示
    // 十几个」。现在只报没看过的总数，前端每真实看完一件（可视 ≥50% 持续 500ms 上报）
    // 在本地实时递减，下次取数由这里按已看名单重新校准。
    // 注意：exclude（屏上已有）不从 left 里扣——那些只是还没上报看过，左耳进右耳出会让计数忽上忽下
    left: Math.max(0, unseenTotal)
  };
}

// 继续随机（mode=random，spec §3.4）：种子 = vid+nonce 洗牌全站，按页发牌。
// 同一 seed 顺序稳定、翻页不重复、不撞车；换 nonce 换顺序；服务端无状态。
function discoverRandom(req, key, seedStr, page, size) {
  // 不推荐件同样不进「继续随机」：这条也是随便逛逛的翻法，推广件不该换个入口又冒出来
  const all = publicWorks(req).filter(w => !expoNoRec(w.id));
  // 随机翻翻同样跳过自己的作品（与 discoverPick 同一立场）；洗牌前的数组变短只会
  // 让页切片少掉那几件，同一 nonce 的顺序仍然稳定。
  const me = currentUser(req);
  const deck = me ? all.filter(w => w.userId !== me.id) : all;
  const rand = mulberry32(strSeed32(key + '|' + seedStr));
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { state: 'random', list: arr.slice(page * size, page * size + size), revisit: [], total: deck.length, page };
}

// GET /api/discover 路由注册在 app 初始化之后（见 /api/featured 旁的 discoverRoute）

// 后台看板数据：分布 / 全站 CTR / Top20 / 从未曝光清单。
// 「从未曝光」清单最有用——它直接告诉你雨露均沾有没有生效（spec §7）。
function expoOverview() {
  pruneExpo();
  const visibleAll = works.filter(w => isVisible(w));
  // 后台三张表（Top / 从未曝光 / 不推荐）要能按作者搜：站长常是「那谁的作品别再推了」，
  // 手里只有昵称没有 ID。署名号与昵称都给一份；匿名件只给「匿名」，别在后台泄露匿名作者。
  const dscAuthor = w => (w.anonymous === true
    ? { author: '', authorName: '匿名' }
    : { author: w.author || '', authorName: displayNameOf(w.author) || '' });
  // 不推荐件不参与曝光分布与 Top/从未曝光两张表（它们本来就不该被推），单独列一张清单
  const blocked = visibleAll.filter(w => expoNoRec(w.id)).map(w => {
    const m = expoNoRec(w.id) || {};
    return {
      id: w.id, title: w.title || '（无标题）', at: m.at || 0, until: m.until || 0,
      ...dscAuthor(w)
    };
  }).sort((a, b) => b.at - a.at);
  const visible = visibleAll.filter(w => !expoNoRec(w.id));
  const buckets = { '0': 0, '1-5': 0, '6-10': 0, '11-29': 0, '30+': 0 };
  let sSum = 0, cSum = 0;
  const rows = [], never = [];
  for (const w of visible) {
    const rec = expoData.works[w.id];
    const n = rec ? rec.s.length : 0;
    const c = rec ? rec.c.length : 0;
    sSum += n; cSum += c;
    const row = {
      id: w.id, title: w.title || '（无标题）', n, clicks: c,
      ctr: n ? +((c / n) * 100).toFixed(1) : 0,
      at: rec ? (rec.at || 0) : 0,
      manual: expoManualLv(w.id),
      ...dscAuthor(w)
    };
    if (n === 0) { buckets['0']++; never.push(row); }
    else {
      if (n <= 5) buckets['1-5']++;
      else if (n <= 10) buckets['6-10']++;
      else if (n <= 29) buckets['11-29']++;
      else buckets['30+']++;
      rows.push(row);
    }
  }
  rows.sort((a, b) => b.n - a.n || b.clicks - a.clicks || String(a.id).localeCompare(String(b.id)));
  return {
    cfg: {
      envEnabled: DISCOVER_ENABLED, on: expoData.cfg.on === true, k: Number(expoData.cfg.k) || 0,
      kMax: DISCOVER_K_MAX, softRetireN: DISCOVER_SOFT_RETIRE_N, sCap: EXPO_S_CAP, userTtlDays: EXPO_USER_TTL_DAYS
    },
    totals: {
      works: visibleAll.length, exposed: rows.length, never: never.length,
      blocked: blocked.length,
      persons: sSum, clicks: cSum, ctr: sSum ? +((cSum / sSum) * 100).toFixed(2) : 0
    },
    buckets,
    top: rows,            // 不再截断 Top 20，后台前端分页查看全部
    never: never,         // 不再截断前 100，后台前端分页查看全部
    blocked: blocked,     // 不推荐清单（推广/导流件），按设置时间倒序
    days: Object.keys(expoData.days).sort().map(k => ({ day: k, n: expoData.days[k] })),
    manual: Object.entries(expoData.manual).map(([id, m]) => ({ id, lv: m.lv, until: m.until || 0 }))
  };
}

// ---------- 站内搜索词：大家到底在找什么 ----------
// 只回答「大家在找什么」：存 词 / 次数 / 0 结果次数 / 最近时间，另存一份「搜过这个词的人数花名册」——
// 花名册只放认人键（u:账号 / v:dm_vid / ip:哈希）和最后搜索日期，用来把前台榜单按人数去重；不存原始 IP、不存搜索内容。
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
    // 按人去重的花名册（人数口径用）：personKey -> 最后一次搜索的日期，过期条目一并清掉；
    // 空的不挂字段，让下游能靠「有没有 us」区分老数据退回按次数
    const us = {};
    for (const [p, d] of Object.entries(rec.us || {})) if (d >= from) us[p] = d;
    const n = Number(rec.n) || 0;
    if (!n) continue;
    out[k] = { w: String(rec.w || k).slice(0, SEARCH_KW_MAXLEN), n, zero: Number(rec.zero) || 0, last: rec.last || '', days };
    if (Object.keys(us).length) out[k].us = us;
  }
  return out;
})();

let searchLogTimer = null;
function scheduleSearchLogSave() {
  if (searchLogTimer) return;
  searchLogTimer = setTimeout(() => {
    searchLogTimer = null;
    try {
      // 花名册只服务「近 7 天 / 近 30 天人数」两个窗口，35 天没露面的人不再留，控文件体积
      const cutoff = dateKey(new Date(Date.now() - 35 * 86400000));
      Object.values(searchLog).forEach(r => {
        if (!r.us) return;
        for (const p of Object.keys(r.us)) if (r.us[p] < cutoff) delete r.us[p];
        if (!Object.keys(r.us).length) delete r.us;
      });
      writeJSON('search-log.json', searchLog);
    } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// delta 允许传 -1：用来撤掉「边打边搜」留下的半截词
// pk = 认人的键（u:账号 / v:dm_vid），只用于人数花名册 rec.us：同一人反复搜同一个词，次数照加，人数只记 1
function bumpSearch(key, word, hits, delta, pk) {
  const rec = searchLog[key] || (searchLog[key] = { w: word, n: 0, zero: 0, last: '', days: {} });
  if (!rec.days) rec.days = {};
  if (word) rec.w = word;
  rec.n = Math.max(0, (rec.n || 0) + delta);
  const dk = dateKey();
  rec.days[dk] = Math.max(0, (rec.days[dk] || 0) + delta);
  if (!rec.days[dk]) delete rec.days[dk];
  if (!hits) rec.zero = Math.max(0, (rec.zero || 0) + delta);   // 命中 0 条单独计数
  if (delta > 0) {
    rec.last = new Date().toISOString();
    if (pk) { if (!rec.us) rec.us = {}; rec.us[pk] = dk; }
  }
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
  // 认人口径与 PV/UV / 广告计费一致：登录按账号，未登录按前端带上的 dm_vid；认不出就退回 IP（同网络算同一人）
  const pk = expoPersonKey(req, { vid: req.query && req.query.vid }) || ('ip:' + ip);
  bumpSearch(key, word, hits, 1, pk);
  trimSearchLog();
  if (searchPrevByIp.size > 5000) searchPrevByIp.clear();
  searchPrevByIp.set(ip, { key, word, hits, t: Date.now() });
  // 行为流水：谁搜的。未登录网页靠前端列表请求带上的 vid 认人，
  // 登录用户直接按账号——和 UV / 广告计费同一套人键。认不出人就不记。
  behaviorLog(expoPersonKey(req, { vid: req.query && req.query.vid }), 'search', { q: word, n: hits });
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
  // 给后台标一下哪些词已被拉黑（统计数字不受影响，只影响搜索词 tab 上的按钮状态）
  const blockedSet = searchBlockSet();
  rows.forEach(r => { r.blocked = blockedSet.has(String(r.q || '').toLowerCase()); });
  // 后台展示把「已屏蔽」整块摘出来：正常排行只留还会上热榜的词，
  // 否则拉黑几个大词之后，前 30 名会被这些前台根本看不见的词白占位置。
  // blockedTop 单独回给后台，顺带让屏蔽名单能显示每个词的真实次数（值不值得放出来）。
  const liveRows = rows.filter(r => !r.blocked);
  const blockedRows = rows.filter(r => r.blocked);
  return {
    total: rows.reduce((s, r) => s + r.n, 0),
    todayN, weekN, words: rows.length,
    top: liveRows.slice(0, limit),
    blockedTop: blockedRows.slice(0, limit)
  };
}

// ---------- 大家最近在搜（前台热搜榜） ----------
// 两路数据物理隔离：真实搜索写 search-log.json（后台统计只看这一份，永远干净），
// 冷启动种子放 search-seed.json（站里真实搜索只有个位数时撑住榜单，真实词累积够了自然顶上去）。
// 关掉种子（enabled:false）榜单就退回纯真实数据，不需要改代码。
let hotSearchCache = { at: 0, items: null };

// 冷启动种子配置（11-13 站长二改：榜单固定 9 种子 + 3 新词，真火词不再插队）
// 前台 12 条 = pick 条种子（随机人数 peopleMin..peopleMax）
// + newPick 条「近 newMin7 天被搜 ≥newMin7 次」的真实词（贴「新」，人数照实）。
// 这里只读配置，不生成数字——数字在 hotSearches 里每次组榜时现抽，换一换就是换一批词。
// 配置缺字段 / 写错类型一律走默认值，文件坏了当没开种子（返回 null），不要让首页跟着挂。
function readSearchSeed() {
  try {
    const raw = readJSON('search-seed.json', null);
    if (!raw || raw.enabled === false || !Array.isArray(raw.words)) return null;
    const words = raw.words
      .map(x => String((x && x.w) || '').trim())
      .filter(Boolean)
      .slice(0, 120);
    if (!words.length) return null;
    const int = (v, d, lo, hi) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    // 种子人数区间：只是展示用的热度，默认压到 1..3（真实词人数超过 3 就照实展示，不掺假）
    const peopleMin = int(raw.peopleMin, 1, 1, 999);
    const peopleMax = int(raw.peopleMax, 3, 1, 999);
    return {
      words,
      pick: int(raw.pick, 9, 0, 12),
      peopleMin: Math.min(peopleMin, peopleMax),
      peopleMax: Math.max(peopleMin, peopleMax),
      newPick: int(raw.newPick, 3, 0, 12),
      newMin7: int(raw.newMin7, 2, 1, 999),
    };
  } catch (e) { return null; }
}

// Fisher-Yates：种子词 / 新词每次组榜都重新洗一次，「随机出 9 个」靠它
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 搜索词屏蔽名单：后台手动拉黑的词不进「大家最近在搜」热搜榜。
// 只影响前台展示——后台「搜索词」tab 的统计口径不变，照样能看到全部真实词（含被屏蔽的），
// 方便先看数据再决定放不放出来。data/search-block.json 是字符串数组，按 mtime 热加载，
// 后台改完即时生效不用重启；文件不存在或解析失败一律视为空名单（安全兜底）。
let searchBlockCache = { mtime: -1, set: null };
function searchBlockSet() {
  try {
    const f = path.join(DATA_DIR, 'search-block.json');
    const st = fs.statSync(f);
    if (!searchBlockCache.set || searchBlockCache.mtime !== st.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const arr = Array.isArray(raw) ? raw : [];
      // 屏蔽按「小写后的词」比：和热搜榜合词用的小写 key 同一套口径，大小写变体一起拦
      searchBlockCache = { mtime: st.mtimeMs, set: new Set(arr.map(x => normSearchQ(x).toLowerCase()).filter(Boolean)) };
    }
    return searchBlockCache.set;
  } catch { return new Set(); }
}

function hotSearches(limit = 12) {
  const now = Date.now();
  if (!hotSearchCache.items || now - hotSearchCache.at > 60000) {
    const weekAgo = dateKey(new Date(now - 6 * 86400000));
    const monthAgo = dateKey(new Date(now - 29 * 86400000));
    // 分类词不进榜：搜「效率工具」「生活助手」这类栏目名只是想逛分类，不是真实需求，
    // 混进榜单会把真正的需求词挤下去（分类入口首页本来就有）
    const catSet = new Set(categories.map(c => String(c).trim().toLowerCase()).filter(Boolean));
    const map = new Map();
    // c7 = 近 7 天搜索次数（不去重），只给「挑新冒头的词」用，不上前台展示
    const put = (w, n, n7, n30, zero, last, real, c7) => {
      const key = String(w).toLowerCase();
      const cur = map.get(key);
      if (cur) {
        cur.n += n; cur.n7 += n7; cur.n30 += n30; cur.zero += zero; cur.c7 += (c7 || 0);
        if (real) cur.real = true;
        if (last > cur.last) cur.last = last;
      } else {
        map.set(key, { w: String(w), n, n7, n30, zero, c7: c7 || 0, last: last || '', real: !!real });
      }
    };

    // 前台榜单按「人数」口径：同一人（账号 / dm_vid / 兜底 IP）反复搜同一个词只算 1 个，
    // 防止对着自己的作品刷搜索把词顶上榜。
    // 11-09 之前的老记录还没有按人花名册（rec.us），认不出是谁——这种只能确认「至少 1 个人搜过」，
    // 一律按 1 人计。宁可显示 1 人，也不能拿搜索次数冒充人数（Magpie 搜了 8 次 ≠ 8 个人）。
    // 另记一份「近 7 天搜索次数」c7（不去重）：挑「新冒头」的词要看次数——老记录认不出人，
    // 按人数挑永远是 1，等于挑不出来。
    const blocked = searchBlockSet();   // 后台拉黑的词：真实词 / 种子词都不放出来
    Object.entries(searchLog).forEach(([k, r]) => {
      const us = r.us && Object.keys(r.us).length ? r.us : null;   // 空花名册当老数据处理
      let u7 = 0, u30 = 0, uTotal = 0;
      if (us) {
        for (const d of Object.values(us)) {
          if (d >= weekAgo) u7++;
          if (d >= monthAgo) u30++;
        }
        uTotal = Object.keys(us).length;
      } else {
        let in7 = false, in30 = false;
        for (const d of Object.keys(r.days || {})) {
          if (d >= weekAgo) in7 = true;
          if (d >= monthAgo) in30 = true;
        }
        u7 = in7 ? 1 : 0;
        u30 = in30 ? 1 : 0;
        uTotal = (u7 || u30) ? 1 : 0;
      }
      if (!uTotal) return;   // 30 天内没出现过的老词不进榜（等着被 trimSearchLog 清掉）
      let c7 = 0;
      Object.entries(r.days || {}).forEach(([d, n]) => { if (d >= weekAgo) c7 += n; });
      put(r.w || k, uTotal, u7, u30, r.zero || 0, r.last ? String(r.last) : '', true, c7);
    });

    // 站内搜索量还小，按次数判「涨势 / 新冒头」的 48h NEW、↑ 标已去掉；
    // 角标只剩两种：种子/真火词贴「热」，近期真被搜过的补位词贴「新」，0 结果贴「缺」
    const reals = [];
    for (const v of map.values()) {
      const w = String(v.w || '').trim().slice(0, 14);
      // 单字和整句都不进榜：榜单要一眼扫完的词
      if (!w || w.length < 2 || !/[\u4e00-\u9fa5a-zA-Z]/.test(w)) continue;
      if (catSet.has(w.toLowerCase())) continue;   // 分类词（效率工具/生活助手…）不进榜
      if (blocked.has(w.toLowerCase())) continue;  // 屏蔽名单：不进前台热搜榜（SEO 尾部同源同拦）
      reals.push({ w, n: v.n, n7: v.n7, n30: v.n30, zero: v.zero, c7: v.c7 || 0, real: true });
    }
    // 边打边搜的残留兜底：同一个人打字会留下「做程序的小」这类半截词。实时扣减只在 150 秒内
    // 同一 IP 生效（进程重启就丢），历史残留还会留在 search-log 里；人数都是 1 人并列时，
    // 这些半截词会一起挤上榜。组榜时再折一次：短词是另一个更长词的前缀、且人数没比长词多
    // （说明它没带来独立的人），就不让它占位——「记账 / 记账本」这种人数有差的不受影响。
    const dropPrefix = new Set();
    for (const x of reals) {
      const xw = x.w.toLowerCase();
      for (const y of reals) {
        if (y === x) continue;
        const yw = y.w.toLowerCase();
        if (yw.length > xw.length && yw.startsWith(xw) && x.n30 <= y.n30) { dropPrefix.add(xw); break; }
      }
    }
    const items = reals.filter(x => !dropPrefix.has(x.w.toLowerCase()));

    // 组榜（11-13 站长二改）：固定 12 条 = 9 条种子（人数 1..3 随机）+ 3 条「近 7 天被搜 ≥2 次」的真实词。
    // 种子那段的数字是展示热度、不是搜索人数，所以只存在内存里，不写 search-log、不进后台统计。
    // 真火词（人数 >3 的真实词）不再给前排特权：一来小站冒出来的「真火词」几乎全是搜免费资源
    // 的 0 结果词（免费小火箭 / 免费小说…），7 条缺词把种子挤光，整榜看着像坏的；
    // 二来榜单词被点一次就是一条真实搜索，种子词自己会滚成真火词，给它特权等于循环自我放大。
    // 真实需求没有丢：后台「搜索词」tab 照样能看到全部真实词和人数。
    const TOTAL = 12;
    const cfg = readSearchSeed();
    let board;
    if (cfg) {
      board = [];
      const used = new Set();
      const take = x => { board.push(x); used.add(String(x.w).toLowerCase()); };

      // ① 种子补位：从 search-seed.json 的 words 里随机抽 pick 条，每条配一个 peopleMin..peopleMax
      //    的随机人数；词要是已经在榜上、是分类词、被后台拉黑，一律跳过
      const seedPool = shuffleArray(cfg.words.filter(w => {
        const lk = w.toLowerCase();
        return w.length >= 2 && !used.has(lk) && !catSet.has(lk) && !blocked.has(lk);
      }));
      const seedQuota = Math.max(0, Math.min(cfg.pick, TOTAL - cfg.newPick));
      seedPool.slice(0, seedQuota).map(w => {
        const n = cfg.peopleMin + Math.floor(Math.random() * (cfg.peopleMax - cfg.peopleMin + 1));
        return { w, n, n7: n, n30: n, zero: 0, seed: true };
      }).sort((a, b) => b.n - a.n || a.w.localeCompare(b.w)).forEach(take);

      // ② 新冒头：近 7 天搜索次数 ≥ newMin7 的真实词，随机抽 newPick 条贴「新」；
      //    人数照实（老记录认不出人就是 1 人——新词人少反而合理）
      const newPool = shuffleArray(reals.filter(x => x.c7 >= cfg.newMin7 && x.n30 <= cfg.peopleMax && !used.has(x.w.toLowerCase())));
      newPool.slice(0, cfg.newPick).forEach(x => take(Object.assign({}, x, { win7: true })));

      // ③ 兜底：名额没填满（种子词不够 / 符合条件的新词不够）就用剩下的真实词按人数补，
      //    首页不会只剩半排；补位时优先要「小词」（人数没超种子区间的），
      //    不然缺词大人数又会从兜底滚回榜上
      if (board.length < TOTAL) {
        reals.filter(x => !used.has(x.w.toLowerCase()))
          .sort((a, b) => ((b.n30 <= cfg.peopleMax) - (a.n30 <= cfg.peopleMax))
            || b.n30 - a.n30 || a.w.localeCompare(b.w))
          .forEach(x => { if (board.length < TOTAL) take(Object.assign({}, x)); });
      }
      board = board.slice(0, TOTAL);
    } else {
      // 种子没开（enabled:false）或配置坏了：退回纯真实榜，8 条按近 30 天人数 + 4 条按近 7 天人数
      const by30 = items.filter(x => x.n30 > 0)
        .sort((a, b) => b.n30 - a.n30 || a.w.localeCompare(b.w))
        .slice(0, 8);
      const picked = new Set(by30.map(x => x.w.toLowerCase()));
      const by7 = items.filter(x => x.n7 > 0 && !picked.has(x.w.toLowerCase()))
        .sort((a, b) => b.n7 - a.n7 || a.w.localeCompare(b.w))
        .slice(0, 4)
        .map(x => Object.assign({}, x, { win7: true }));
      board = by30.concat(by7);
    }
    hotSearchCache = { at: now, items: board };
  }
  return {
    total: hotSearchCache.items.length,
    items: hotSearchCache.items.slice(0, Math.max(limit, 12)),
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
// 关键奖励当场落盘：addPoints 走的是 2 秒 debounce，若这一刻进程重启，
// 作品上「已发」的标记已写进 works.json，钱却没写进 share.json，用户就永远收不到。
// 首件即时款属于「说好当场到账」的钱，必须和标记一起同步落盘。
function saveShareNow() {
  if (shareSaveTimer) { clearTimeout(shareSaveTimer); shareSaveTimer = null; }
  try { writeJSON('share.json', shareData); } catch (e) { /* 同上，不阻塞主流程 */ }
  // 发奖的同时作品上会写「已发」标记。works 现在是 300ms 合并写，
  // 若这一刻重启，会出现「钱已到账、标记还没落盘」→ 下次启动重复发奖。
  // 两笔必须同批落盘，所以这里把 works 的缓冲一并刷掉。
  saveWorksNow();
}

// IP 只存哈希：既要按 IP 去重，又不在文件里留明文地址
function ipKeyOf(req) {
  return crypto.createHash('sha256').update('share:' + clientIp(req)).digest('hex').slice(0, 16);
}
// 原始 IP：只在用户档案里留一份给后台排查用（小号 / 刷量）。
// 统计、UV 去重、同 IP 判定照旧走上面的哈希，对外接口一个字都不返回。
function ipRawOf(req) {
  const ip = String(clientIp(req) || '');
  return ip && ip !== 'unknown' ? ip : '';
}

// ---------- IP 归属地（只在后台用户列表展示，离线库，不发任何外网请求） ----------
// ip2region 自带 xdb（npm 包内 11MB），返回「中国|0|江苏省|苏州市|电信」。
// 只认 IPv4：IPv6、内网、缺库一律返回 null，前端就只显示 IP 不显示城市。
let ipSearcher = null;
try {
  const IPS = require('ip2region-ts');
  ipSearcher = IPS.newWithVectorIndex(IPS.defaultDbFile, IPS.loadVectorIndexFromFile(IPS.defaultDbFile));
} catch (e) {
  console.warn('[ip2region] 归属地查询未启用（不影响其它功能）：' + e.message);
}
const IP_PLACE_CACHE = new Map();
const IPV4_ONLY_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
async function ipPlaceOf(ip) {
  if (!ip || !ipSearcher || !IPV4_ONLY_RE.test(ip)) return null;
  if (IP_PLACE_CACHE.has(ip)) return IP_PLACE_CACHE.get(ip);
  let out = null;
  try {
    const r = await ipSearcher.search(ip);
    // 0 = 该级没有数据；内网库返回「0|0|0|内网IP|内网IP」
    const [country, , prov, city, isp] = String((r && r.region) || '').split('|').map(s => s.trim());
    if (city === '内网IP') out = { place: '内网', isp: '' };
    else {
      const c = city && city !== '0' ? city : '';
      const p = prov && prov !== '0' ? prov : '';
      const parts = [];
      if (country && country !== '0' && country !== '中国') parts.push(country);
      if (p && c) parts.push(c.startsWith(p) ? c : p + c);   // 江苏省+苏州市 → 江苏省苏州市；北京+北京市 → 北京市
      else if (p || c) parts.push(p || c);
      if (!parts.length) out = null;
      else out = { place: parts.join(' '), isp: isp && isp !== '0' ? isp : '' };
    }
  } catch (e) {
    out = null;   // 库外的 IP（含部分保留段）查不到就算了，别让后台报错
  }
  if (IP_PLACE_CACHE.size > 5000) IP_PLACE_CACHE.clear();   // 只防内存膨胀，清了重查很快
  IP_PLACE_CACHE.set(ip, out);
  return out;
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
      uid: uid,   // 作者页链接统一走 /u/<id>
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
// 不对外暴露 "X-Powered-By: Express"（少一个指纹，攻击面小一点）
app.disable('x-powered-by');
// 注意：trust proxy=true 时 req.ip 取的是 XFF 最左段，客户端自己就能填，别直接拿它做限流/统计。
// 取真实 IP 统一走 clientIp(req)（只信代理追加的最后一段）。
app.set('trust proxy', true);

// 环境切换（本地开发专用，线上是空壳）：必须挂在 express.json() 之前，
// 这样请求体还没被解析，可以直接 pipe 给生产；切到生产时这里就短路返回，后面的路由全不执行
const devEnv = createDevEnv({ dataDir: DATA_DIR });
app.use(devEnv.middleware());

app.use(express.json({ limit: '1mb' }));
devEnv.routes(app);   // GET/POST /__dev/env：读状态、切模式（只收本机请求）

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
function scheduleActiveSave() {
  if (activeSaveTimer) return;
  activeSaveTimer = setTimeout(() => { activeSaveTimer = null; try { saveUsers(); } catch (e) { /* 落盘失败不影响主流程 */ } }, 3000);
}
function touchActive(req, user) {
  if (!user) return;
  const now = Date.now();
  let dirty = false;
  // 最后活跃端：只在「换了端」时写，不受 5 分钟节流限制——
  // 同一个人 PC 上刚动过、5 分钟内又开小程序，否则这一笔会被节流吃掉，后台仍显示 PC。
  // 爬虫 / 没有 UA 的请求不写：预渲染、health check、脚本带着会话 cookie 来一趟，
  // 会把真人最后用的端盖成「爬虫」，这个字段就没意义了
  const kind = clientKindOf(req);
  const prev = user.lastClient && user.lastClient.kind;
  if (kind !== 'bot' && kind !== 'unknown' && prev !== kind) {
    user.lastClient = { kind, at: new Date(now).toISOString() };
    dirty = true;
  }
  const last = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
  // 最近活跃 IP：换 IP 时立刻记（不受 5 分钟节流限制，否则「换了出口」这一笔会被吃掉），
  // 没换就跟着活跃刻度刷新一下时间，后台能看出最后一次露头是什么时候。
  const ipNow = ipRawOf(req);
  if (ipNow && user.lastIp !== ipNow) {
    user.lastIp = ipNow;
    user.lastIpAt = new Date(now).toISOString();
    dirty = true;
  }
  if (now - last >= ACTIVE_THROTTLE_MS) {
    user.lastActiveAt = new Date(now).toISOString();
    if (ipNow) user.lastIpAt = new Date(now).toISOString();
    // 今日访问计数：每次真实活跃刻度（≥5 分钟一次）记 1 次，按北京时间切天，
    // 只存当天一天的量，跨天自动清零重计（口径是下限：5 分钟内的连续请求不算多次）
    const day = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (user.actDay !== day) { user.actDay = day; user.actToday = 0; }
    user.actToday = (user.actToday || 0) + 1;
    dirty = true;
  }
  if (dirty) scheduleActiveSave();
}
app.use((req, res, next) => {
  const u = currentUser(req);
  if (u) touchActive(req, u);
  next();
});

// 安全 / SEO 相关响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/admin')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(siteMeta.middleware({ dataDir: DATA_DIR }));

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

// ---------- CSS 压缩：style.css 是渲染阻塞资源，注释和缩进占了 1/3 体积 ----------
// 源文件照常带注释维护，对外只发压缩版。保守压缩：只去注释/行首缩进/空行，
// 不动规则内的空格和引号内容，零行为风险。按 mtime 缓存，改完文件自动重新压缩。
const cssMinCache = new Map();   // 绝对路径 -> { mtime, body }
function minifyCssText(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 注释（style.css 的注释占了 1/4 体积）
    .split('\n').map(l => l.replace(/^[ \t]+/, '')).join('\n')
    .replace(/\n{2,}/g, '\n')               // 空行
    .trim();
}
app.get(/\/[^/]*\.css$/, (req, res, next) => {
  if (req.path.startsWith('/t/')) return next();
  const file = path.join(path.join(__dirname, 'frontend'), path.basename(req.path));
  if (!fs.existsSync(file)) return next();   // frontend 下没有就交给 static / 404
  try {
    const st = fs.statSync(file);
    let hit = cssMinCache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs) {
      hit = { mtime: st.mtimeMs, body: minifyCssText(fs.readFileSync(file, 'utf-8')) };
      cssMinCache.set(file, hit);
    }
    res.type('text/css; charset=utf-8');
    res.setHeader('Cache-Control', req.query.v
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
    return res.send(hit.body);
  } catch { return next(); }
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// ---------- 缩略图：/t/<宽>/<原文件名> ----------
// 背景：卡片上的 thumb 过去直接等于原图，一张 660K 的封面塞进 180px 的格子，
// 首页 12 张卡片在手机上能吃掉好几 MB。这里按需生成 webp 并落盘缓存，
// 存量图不用迁移、上传逻辑也不用改 —— 第一次请求生成，之后直接发文件。
const THUMB_DIR = path.join(UPLOAD_DIR, '.thumb');
const THUMB_SIZES = [400, 800, 1200, 1600]; // 1600：详情大图全屏查看用（2026-11-13），比详情档更清晰
const thumbPending = new Map();     // 同一张图的并发请求只生成一次
let sharpLib = null;
try { sharpLib = require('sharp'); }
catch (e) { console.warn('[thumb] sharp 未安装，缩略图请求将回退原图:', e.message); }

app.get('/t/:size/:file', async (req, res) => {
  const size = parseInt(req.params.size, 10);
  const file = path.basename(String(req.params.file || ''));
  const sendOriginal = () => res.setHeader('Cache-Control', 'public, max-age=3600')
    .redirect(302, '/uploads/' + encodeURIComponent(file));

  if (!THUMB_SIZES.includes(size) || !file || file.startsWith('.')) return res.status(404).end();
  if (!sharpLib) return sendOriginal();

  const src = path.join(UPLOAD_DIR, file);
  const out = path.join(THUMB_DIR, String(size), file.replace(/\.[^.]+$/, '') + '.webp');
  const sendOut = () => res.type('image/webp')
    .setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    .sendFile(out);
  // 已生成过：直接发，零解码
  if (fs.existsSync(out)) return sendOut();

  try {
    if (!fs.existsSync(src)) return res.status(404).end();
    const key = out;
    if (!thumbPending.has(key)) {
      thumbPending.set(key, (async () => {
        await fs.promises.mkdir(path.dirname(out), { recursive: true });
        await sharpLib(src).rotate().resize({ width: size, withoutEnlargement: true })
          .webp({ quality: 78, effort: 4 }).toFile(out);
        return out;
      })().finally(() => thumbPending.delete(key)));
    }
    await thumbPending.get(key);
    return sendOut();
  } catch (e) {
    // sharp 不支持的文件（坏图 / 特殊格式）别把列表页拖死，退回原图
    console.warn('[thumb] 生成失败，回退原图:', file, e.message);
    return sendOriginal();
  }
});

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

// ---------- 上传兜底压缩 ----------
// 25MB 上限只是防爆内存，不代表真该存 5MB 的相机原图——这些文件会直接变成列表 / 详情页的图。
// 落盘后再压一遍，规则：
//   · 宽度超过 1600 的等比缩到 1600（手机直出 4000px 对网页毫无意义）
//   · 按 EXIF 摆正方向（竖拍照片不会躺倒）
//   · 输出格式与原文件一致（png 保持 png，避免透明底变黑；gif 直接跳过，别把动图压成静图）
//   · qrcode 字段一律不碰：压缩会让二维码扫不出来
//   · 任何一步失败都保留原图，压缩是优化，不能让上传失败
const UPLOAD_MAX_W = 1600;
const UPLOAD_SKIP_BELOW = 200 * 1024;   // 200K 以下压了，画质亏得比体积赚得多

async function compressOneUpload(file) {
  if (!file || !file.path) return;
  const p = file.path;
  try {
    const st = await fs.promises.stat(p);
    if (st.size < UPLOAD_SKIP_BELOW) return;
    // 走 buffer 而不是文件路径：multer 刚写完的文件在 Windows 上让 libvips 直接 open
    // 会报 "UNKNOWN: unknown error, open"（句柄还没完全释放），读成 Buffer 可以绕开。
    // 仍失败就重试几次，最终失败也只是保留原图。
    let input = null;
    for (let i = 0; i < 3 && !input; i++) {
      try { input = await fs.promises.readFile(p); }
      catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 80)); }
    }
    const meta = await sharpLib(input, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return;
    if (meta.format === 'gif') return;                        // 动图不动
    if (!['jpeg', 'jpg', 'png', 'webp', 'avif', 'tiff'].includes(meta.format)) return;
    const tooWide = meta.width > UPLOAD_MAX_W;
    if (!tooWide && st.size < 1024 * 1024) return;            // 尺寸合适、不到 1MB，没必要

    let pipe = sharpLib(input, { failOn: 'none' })
      .rotate()
      .resize({ width: UPLOAD_MAX_W, withoutEnlargement: true });
    // 保持格式：扩展名和内容必须对得上，否则 express.static 会按扩展名给错 content-type
    if (meta.format === 'png') pipe = pipe.png({ compressionLevel: 9 });
    else if (meta.format === 'webp') pipe = pipe.webp({ quality: 82 });
    else if (meta.format === 'avif') pipe = pipe.avif({ quality: 60 });
    else pipe = pipe.jpeg({ quality: 82, mozjpeg: true });

    const buf = await pipe.toBuffer();
    if (buf.length >= st.size * 0.95) return;                 // 压不下去就别白换一次内容
    await fs.promises.writeFile(p, buf);
  } catch (e) {
    console.warn('[upload] 压缩失败，保留原图:', path.basename(p), e.message);
  }
}

// 在 upload(...) 回调的 err 判断之后调用；qrcode 故意不处理
// 串行处理而不是 Promise.all：宣传图最多 9 张，并发解码大图内存峰值可能上百 MB。
async function compressUploads(req) {
  if (!sharpLib || !req.files) return;
  for (const field of ['image', 'thumb', 'images']) {
    for (const f of (req.files[field] || [])) await compressOneUpload(f);
  }
}

// ---------- 后台鉴权 ----------
// 口令只用来「换一张 HttpOnly 票据」，此后每个请求带 cookie，口令不再出现在 URL 里。
// 之前每个后台请求都拼 ?key=xxx，等于把管理口令明文写进 nginx access.log、浏览器历史和 Referer。
const ADMIN_COOKIE = 'dm_admin';
const ADMIN_TTL = 30 * 24 * 3600 * 1000;   // 勾「记住」时的票据有效期
function adminToken() {
  // 由口令派生的票据：改口令即让所有旧票据失效，票据本身不存盘
  return crypto.createHmac('sha256', ADMIN_KEY || 'unset').update('dm-admin-v1').digest('hex');
}
function safeEqualStr(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function isAdmin(req) {
  if (!ADMIN_KEY) return false; // 未配置后台口令时后台整体禁用，避免空口令放行
  // 1) header 口令：curl / 本地回归脚本用（不进 URL，不会留日志）
  if (safeEqualStr(req.headers['x-admin-key'], ADMIN_KEY)) return true;
  // 2) ?key= 兼容老脚本（后台页面已改走 cookie，不再有这条路径；别在页面上再用，会进 access.log）
  if (safeEqualStr(req.query.key, ADMIN_KEY)) return true;
  // 3) 正常路径：登录换来的 HttpOnly 票据（站长口令票据 或 管理员名单内账号的票据）
  return !!adminTicketName(req);
}
// 多管理员（2026-11-12）：名单存 data/admins.json，管理员用「站内账号 + 站内账号密码」登录，
// 密码复用 checkPassword，不另设一套；站长旧口令 ADMIN_KEY 继续有效，是兜底入口。
// 名单按 mtime 热加载（同 beta.json 的做法），后台增删管理员即改即生效。
let adminsCache = null;
function loadAdmins() {
  try {
    const f = path.join(DATA_DIR, 'admins.json');
    const st = fs.statSync(f);
    if (!adminsCache || adminsCache.mtime !== st.mtimeMs) {
      adminsCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(f, 'utf-8')) };
    }
  } catch { adminsCache = { mtime: 0, data: null }; }
  if (!adminsCache.data || typeof adminsCache.data !== 'object') adminsCache.data = {};
  if (!Array.isArray(adminsCache.data.admins)) adminsCache.data.admins = [];
  if (!Array.isArray(adminsCache.data.applications)) adminsCache.data.applications = [];
  return adminsCache.data;
}
function saveAdmins() {
  const data = loadAdmins();
  adminsCache = null;   // 让 mtime 缓存失效，下次读盘拿真实 mtime
  try { fs.writeFileSync(path.join(DATA_DIR, 'admins.json'), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[admins] 写入失败:', e.message); }
}
function isAdminName(username) {
  const n = String(username || '').trim().toLowerCase();
  if (!n) return false;
  return loadAdmins().admins.some(a => String(a.username || '').trim().toLowerCase() === n);
}
// 名单管理员的票据：由口令 + 用户名派生（改口令即全体失效；票据本身不落盘）
function adminNameToken(username) {
  return crypto.createHmac('sha256', ADMIN_KEY || 'unset').update('dm-admin-v2:' + String(username).toLowerCase()).digest('hex');
}
// 当前票据对应的管理员名：站长口令 → '站长'；名单管理员 → 用户名；无效 → null
function adminTicketName(req) {
  const c = parseCookies(req)[ADMIN_COOKIE];
  if (!c) return null;
  if (safeEqualStr(c, adminToken())) return '站长';
  const list = loadAdmins().admins;
  for (const a of list) {
    if (a && safeEqualStr(c, adminNameToken(a.username))) return a.username;
  }
  return null;
}
function adminWho(req) {
  // 操作留痕用：header / query 口令也认成「站长」
  if (safeEqualStr(req.headers['x-admin-key'], ADMIN_KEY) || safeEqualStr(req.query.key, ADMIN_KEY)) return '站长(口令)';
  return adminTicketName(req) || '';
}
// 后台操作审计：写操作（非 GET）记一笔「谁在什么时候动了哪个接口」，出事能倒查
function auditAdmin(req) {
  if (req.method === 'GET') return;
  try {
    const f = path.join(DATA_DIR, 'admin-audit.json');
    let list = [];
    try { list = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { /* 首次为空 */ }
    if (!Array.isArray(list)) list = [];
    list.push({
      t: new Date().toISOString(),
      name: adminWho(req),
      method: req.method,
      url: String(req.originalUrl || req.url || '').slice(0, 120),
      ip: clientIp(req)
    });
    if (list.length > 2000) list = list.slice(-2000);
    fs.writeFileSync(f, JSON.stringify(list));
  } catch { /* 审计失败不影响主流程 */ }
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: '无权限，请检查管理口令' });
  auditAdmin(req);
  next();
}

// 登录换票：POST { key, remember } → Set-Cookie（HttpOnly，脚本读不到）
app.post('/api/admin/session', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: '后台未启用（未配置管理口令）' });
  const ip = clientIp(req);
  if (!rateLimit('adminlogin:' + ip, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }
  const key = String((req.body && req.body.key) || req.headers['x-admin-key'] || '').trim();
  if (!safeEqualStr(key, ADMIN_KEY)) return res.status(403).json({ error: '口令错误' });
  const attrs = [`${ADMIN_COOKIE}=${adminToken()}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isRemember(req.body)) attrs.push(`Max-Age=${Math.floor(ADMIN_TTL / 1000)}`);
  // 线上走 nginx https；本地 http 调试不加 Secure，否则 cookie 写不进去
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.secure || proto === 'https') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true });
});

// 退出：清掉票据
app.delete('/api/admin/session', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// 当前登录的管理员是谁（后台顶部展示用；未登录返回 ok:false）
app.get('/api/admin/session', (req, res) => {
  const name = adminWho(req);
  res.json({ ok: !!name, name: name || '' });
});

// 管理员登录：站内账号 + 站内账号密码（不是管理员名单内的账号会拿到 notAdmin，前端弹「申请」）
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: '后台未启用（未配置管理口令）' });
  const ip = clientIp(req);
  if (!rateLimit('adminlogin2:' + ip, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }
  const { username, password } = req.body || {};
  const user = findUserLoose(username);
  if (!user) return res.status(404).json({ error: '该用户名还没有注册', notFound: true });
  // OAuth 建的号没设过密码：别让人对着一个不存在的密码反复试
  if (user.passSet === false && (user.github || user.google)) {
    return res.status(400).json({ error: '这个账号是用 GitHub / Google 建的，还没设密码；请先登录站点设置密码' });
  }
  if (!checkPassword(user, String(password || ''))) return res.status(401).json({ error: '账号或密码错误' });
  if (!isAdminName(user.username)) {
    return res.json({ ok: false, notAdmin: true, username: user.username, nickname: user.nickname || '' });
  }
  const attrs = [`${ADMIN_COOKIE}=${adminNameToken(user.username)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isRemember(req.body)) attrs.push(`Max-Age=${Math.floor(ADMIN_TTL / 1000)}`);
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.secure || proto === 'https') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true, name: user.username, nickname: user.nickname || '' });
});

// 申请成为管理员：登录即身份（不收账号密码，防冒名靠站内会话），进申请队列，站长在后台「管理员」页审批
app.post('/api/admin/apply', (req, res) => {
  if (!rateLimit('adminapply:' + clientIp(req), 5, 3600 * 1000)) {
    return res.status(429).json({ error: '申请太频繁，请 1 小时后再试' });
  }
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '请先登录站内账号，再来提交申请', needLogin: true });
  if (isAdminName(user.username)) return res.status(400).json({ error: '你已经是管理员了，直接登录即可' });
  const store = loadAdmins();
  const low = user.username.toLowerCase();
  if (store.applications.some(a => String(a.username || '').toLowerCase() === low)) {
    return res.json({ ok: true, dup: true });   // 已申请过、还在排队：不重复记录
  }
  store.applications.push({
    username: user.username,
    uid: user.id,
    nickname: user.nickname || '',
    note: String((req.body || {}).note || '').slice(0, 200),
    at: new Date().toISOString()
  });
  if (store.applications.length > 100) store.applications = store.applications.slice(-100);
  saveAdmins();
  res.json({ ok: true });
});

// 管理员名单管理：看名单 + 申请队列 + 最近操作留痕；增删/审批
app.get('/api/admin/admins', requireAdmin, (req, res) => {
  const store = loadAdmins();
  let audit = [];
  try { audit = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'admin-audit.json'), 'utf-8')); } catch { /* 空 */ }
  if (!Array.isArray(audit)) audit = [];
  res.json({ admins: store.admins, applications: store.applications, audit: audit.slice(-60).reverse() });
});

app.post('/api/admin/admins', requireAdmin, (req, res) => {
  const body = req.body || {};
  const action = String(body.action || '');
  const store = loadAdmins();
  if (action === 'add') {
    const user = findUserLoose(body.username);
    if (!user) return res.status(404).json({ error: '站内没有这个用户名' });
    if (isAdminName(user.username)) return res.status(400).json({ error: 'TA 已经是管理员了' });
    store.admins.push({ username: user.username, role: 'admin', addedAt: new Date().toISOString() });
    // 手动加进名单的，顺带清掉同名的待审申请
    store.applications = store.applications.filter(a => String(a.username || '').toLowerCase() !== user.username.toLowerCase());
  } else if (action === 'remove') {
    const low = String(body.username || '').trim().toLowerCase();
    if (!low) return res.status(400).json({ error: '缺少用户名' });
    store.admins = store.admins.filter(a => String(a.username || '').toLowerCase() !== low);
  } else if (action === 'approve') {
    const i = store.applications.findIndex(a => a.username === body.username);
    if (i < 0) return res.status(404).json({ error: '申请不存在或已处理' });
    const ap = store.applications.splice(i, 1)[0];
    if (!isAdminName(ap.username)) {
      store.admins.push({ username: ap.username, role: 'admin', addedAt: new Date().toISOString() });
    }
    addNotice(ap.uid, {
      key: 'admin-approved:' + ap.username,
      kind: 'system',
      title: '管理员申请已通过',
      text: '你的管理员申请已通过，现在可以用站内账号直接登录后台了。'
    });
  } else if (action === 'reject') {
    const i = store.applications.findIndex(a => a.username === body.username);
    if (i < 0) return res.status(404).json({ error: '申请不存在或已处理' });
    const ap = store.applications.splice(i, 1)[0];
    addNotice(ap.uid, {
      key: 'admin-rejected:' + ap.username,
      kind: 'system',
      title: '管理员申请未通过',
      text: '很抱歉，这次的管理员申请没有通过。有疑问欢迎通过提问通道联系站长。'
    });
  } else {
    return res.status(400).json({ error: '未知操作' });
  }
  saveAdmins();
  res.json({ ok: true, admins: store.admins, applications: store.applications });
});

// ---------- 后台「随便逛逛」：看板 + 开关 + 手动加权（口径见 docs/discover-spec-v1.md） ----------
app.get('/api/admin/discover', requireAdmin, (req, res) => {
  res.json(expoOverview());
});

app.post('/api/admin/discover', requireAdmin, (req, res) => {
  const body = req.body || {};
  // 开关与加权强度：k=0 即纯随机（同梯队均等），只此一个变量，没有第二套代码路径
  if (body.action === 'cfg') {
    if (body.on !== undefined) expoData.cfg.on = body.on === true;
    if (body.k !== undefined) {
      const k = Number(body.k);
      if (!Number.isFinite(k) || k < 0 || k > DISCOVER_K_MAX) {
        return res.status(400).json({ error: 'k 必须在 0 ~ ' + DISCOVER_K_MAX + ' 之间（0 = 纯随机）' });
      }
      expoData.cfg.k = k;
    }
    saveExpoNow();
    return res.json({ ok: true, cfg: { on: expoData.cfg.on === true, k: expoData.cfg.k } });
  }
  // 手动加权：只在同一梯队内部生效（阶段 2 取卡实现），lv=0 即撤销；默认 14 天自动失效
  // 2026-11-13 增「不推荐」：lv=-9 = 从随便逛逛彻底移出（推广/导流件用），days=0 表示长期不失效
  if (body.action === 'manual') {
    const q = String(body.q || '').trim().slice(0, 80);
    if (!q) return res.status(400).json({ error: '填作品 ID 或标题' });
    const ql = q.toLowerCase();
    const w = works.find(x => x && String(x.id) === q)
      || works.find(x => x && isVisible(x) && String(x.title || '').toLowerCase().includes(ql));
    if (!w) return res.status(404).json({ error: '找不到这件作品（只搜得到 ID 或标题含关键词的）' });
    const lv = Math.max(-9, Math.min(2, Math.round(Number(body.lv) || 0)));
    // 0 = 长期：只对「不推荐」有意义；加权档位最小 1 天，传 0 按默认 14 天算
    const days = Math.min(90, Math.max(0, Math.round(Number(body.days) || 0)));
    if (lv === -9) {
      delete expoData.manual[w.id];
      expoData.noRec[w.id] = { at: Date.now(), until: days > 0 ? Date.now() + days * 86400000 : 0 };
    } else {
      delete expoData.noRec[w.id];
      if (!lv) delete expoData.manual[w.id];
      else expoData.manual[w.id] = { lv, until: Date.now() + (days || 14) * 86400000 };
    }
    saveExpoNow();
    return res.json({
      ok: true, id: w.id, title: w.title,
      manual: expoData.manual[w.id] || null,
      noRec: expoData.noRec[w.id] || null
    });
  }
  return res.status(400).json({ error: '未知 action' });
});

// 轻量健康检查：给 uptime 监控 / 发布后自检用（不含任何敏感信息）
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    uptime: Math.round(process.uptime()),
    works: works.length,
    users: users.length,
    time: new Date().toISOString()
  });
});

siteMeta.routes(app, { dataDir: DATA_DIR, requireAdmin, rateLimit, clientIp });

// 删除 /uploads 下的图片文件（忽略不存在的），顺手清掉对应的缩略图缓存
function removeUpload(imgPath) {
  if (!imgPath || typeof imgPath !== 'string') return;
  const base = path.basename(imgPath);
  const p = path.join(UPLOAD_DIR, base);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  // 缩略图是按 文件名 命名的（/uploads/x.jpg → .thumb/<宽>/x.webp），原图删了就别留着占地方
  const stem = base.replace(/\.[^.]+$/, '');
  for (const size of THUMB_SIZES) {
    const t = path.join(THUMB_DIR, String(size), stem + '.webp');
    try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch { /* 删不掉不影响主流程 */ }
  }
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
// lamp = 灯火解锁（花 N 盏灯火才看得到入口）
// donation（送灯火 / 接受打赏）2026-11-07 下线：打赏是全站通用能力，任何作品详情页都有
// 「送灯火」按钮，不需要作者在投稿时声明。旧数据里存了 donation 的作品按「免费（不标注）」
// 输出（见 publicWork），字段本身不做迁移，作者下次编辑保存就自然清掉。
const PAID_MODELS = ['freemium', 'member', 'onetime', 'subscription', 'buyout', 'trial', 'lamp'];
// 灯火解锁不是「付费墙」：作品本身不标价，paid 标记保持 false，走自己的字段
const NON_PAID_MODELS = ['lamp'];
function parsePaidModel(v) {
  const s = String(v || '').trim();
  return PAID_MODELS.includes(s) ? s : '';
}

// ---------- 灯火解锁（送灯火才能体验）----------
// 作者设一个价（几盏灯火），访客花自己的灯火解锁后才看得到入口：
// Web 链接、下载链接（商店/安装包）、小程序码一律藏起来，解锁后才下发。
// 说明：链接一旦解锁就能被复制转发，站方只能挡住「白看」，挡不住二次传播——这点在表单提示里写明。
const LAMP_PRICE_DEFAULT = 1;
const LAMP_PRICE_MAX = 50;   // 2026-11-07 站长拍板：解锁价默认 1 盏、最高 50 盏（前端表单同口径）
function normLampPrice(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return LAMP_PRICE_DEFAULT;
  return Math.min(LAMP_PRICE_MAX, Math.max(1, n));
}
// 收费/解锁标注统一落在作品上：4 个入口（用户投稿/编辑、后台代建/编辑）共用一套口径
function applyPaidFields(w, body) {
  const model = parsePaidModel(body.paidModel);
  if (model === 'lamp') {
    w.paidModel = 'lamp';
    w.paid = false;                          // 不是付费作品，是灯火解锁
    w.lampPrice = normLampPrice(body.lampPrice);
  } else {
    w.paidModel = model;
    w.paid = !!model || parsePaid(body.paid);
    if (!w.paid) w.paidModel = '';           // 改回免费则清掉形式
    delete w.lampPrice;
  }
  return w;
}
// 建作品时展开成对象字面量能用的字段（含 lamp 这个非付费标注）
function paidFieldsOf(body) {
  const t = {};
  applyPaidFields(t, body);
  const out = { paid: !!t.paid };
  if (t.paidModel) out.paidModel = t.paidModel;
  if (t.lampPrice) out.lampPrice = t.lampPrice;
  return out;
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
function sanitizeTags(arr, cap) {
  const max = Number(cap) > 0 ? Number(cap) : 6;
  const out = [];
  for (const t of (Array.isArray(arr) ? arr : [])) {
    const s = String(t).trim().slice(0, 20);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// 当前访客是否赞过这件作品：点赞改成可取消后，前端要靠它渲染「已赞」态，
// 不能只信 localStorage（换设备/换浏览器就不知道你赞过没）。
function likedOf(wid, user) {
  if (!user || !wid) return false;
  try {
    const seen = likeDedup[wid];
    return !!(seen && seen['u:' + user.id] === 1);
  } catch { return false; }   // likeDedup 还没初始化（启动极早期调用）就当没赞过
}

// 卡片/列表用的简介摘要：按句截断，不在半句话上砍断。
// 以前 introText 直接 slice(0, 160)，卡片上经常出现「……才能定位到原文的具体段」
// 这种半句话收尾。现在攒完整句子（不超上限为止），首句就超长才退回硬截加 …。
// 只在长度超限时才走切分；不满一句的兜底口径与 seo.js 的 truncate 保持一致。
function introDigest(s, max = 160) {
  const plain = String(s || '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const parts = plain.split(/(?<=[。！？!?；;…])/).filter(Boolean);
  let out = '';
  for (const p of parts) {
    if ((out + p).length > max) break;
    out += p;
  }
  if (out) return out;
  return plain.slice(0, max - 1).replace(/[，,。.、\s]+$/, '') + '…';
}

// 卡片一句话：一行放得下的首句（约 18-22 个汉字），给 .card-desc / .row-intro 用。
// 为什么不直接用 introText：卡片描述是单行 nowrap，160 字的摘要到那儿必然被 CSS 二次切断，
// 于是又出现「…才能定位到原文的具体段」这种半句，英文 / 域名还会被切成「直达 Obsidi…」。
// 这里按句读收尾，没有句读退到逗号，最后才硬截（且不切断英文单词），末尾悬挂标点去掉。
function cardDigest(s, max = 22) {
  const plain = String(s || '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  if (plain.length <= max) return plain;
  const chars = Array.from(plain);   // 按字符数算，emoji 不会被劈成两半
  const head = chars.slice(0, max).join('');
  const pickEnd = seps => seps.reduce((best, sep) => Math.max(best, head.lastIndexOf(sep)), -1);
  // ① 前半段里有句读：取到最后一个句读（含），语义天然收口
  const sentenceEnd = pickEnd(['。', '！', '？', '!', '?', '；', ';']);
  if (sentenceEnd >= 8) return chars.slice(0, sentenceEnd + 1).join('');
  // ② 没有句读就退到逗号 / 顿号；太短（<10 字）说明整句都是短语堆叠，宁可硬截。
  //    「·」也算分隔点：作者爱用「文本提取 · 内容翻译 · 信息整理」这种点分列表，
  //    切在最后一个点后面比切在「沉浸式…」上干净得多。
  const clauseEnd = pickEnd(['，', ',', '、', '—', '·']);
  if (clauseEnd >= 10) return chars.slice(0, clauseEnd).join('').trim();
  // ③ 硬截：截断点两侧都是字母数字就往前退到词首（域名 / 英文名不切半个），
  //    末尾的连接词和标点清掉 —— 「免费开源的 Android SSH 与 …」比「…SSH …」还怪。
  //    标点 / 空白与连接词要交替清：去掉「与」后往往又露出一个空格，一轮清不干净。
  const isWordChar = i => /[A-Za-z0-9]/.test(chars[i] || '');
  let cut = max;
  while (cut > 10 && isWordChar(cut - 1) && isWordChar(cut)) cut--;
  let body = chars.slice(0, cut).join('');
  for (let guard = 0; guard < 4; guard++) {
    const next = body
      .replace(/[，,。.、：:；;…\s]+$/, '')
      .replace(/[与和及或的之把被对为向从将]+$/, '');
    if (next === body) break;
    body = next;
  }
  // 括号没闭合就整段砍掉：留着「拼豆（Perler…」比直接断在「拼豆」更像出错
  const opens = (body.match(/[（(]/g) || []).length;
  const closes = (body.match(/[）)]/g) || []).length;
  if (opens > closes) {
    const idx = Math.max(body.lastIndexOf('（'), body.lastIndexOf('('));
    if (idx >= 8) body = body.slice(0, idx).replace(/[，,。.、：:；;…\s]+$/, '');
  }
  return body + '…';
}

// 只返回对外的字段（user 传入时附加 owned 标记）
function publicWork(w, user) {
  const types = typesOf(w);
  // 详情页展示的二维码：作者原码（小程序）优先，否则自动短链码（扫码可数，见 /go/:code）
  const qr = workQrOf(w);
  // 灯火解锁：作者定价 > 0 且访客没解锁 → 所有入口（Web 链接 / 下载链接 / 小程序码）一律不下发。
  // 作者本人天然可见；解锁记录按账号存，所以同一账号换设备不用再付一次。
  const lampPrice = w.paidModel === 'lamp' ? normLampPrice(w.lampPrice) : 0;
  const lampOwner = !!(user && w.userId && user.id === w.userId);
  const lampUnlocked = lampPrice > 0 && (lampOwner || lampUnlockOf(w.id, user && user.id));
  const lampLocked = lampPrice > 0 && !lampUnlocked;
  return {
    id: w.id, title: w.title, author: w.author, authorName: displayNameOf(w.author), category: w.category,
    // 作者页链接用的 id：/u/ 统一跳 id（纯 ASCII，链接里不再出现汉字），无主作品回落账号名
    authorId: w.userId || '',
    // 标题拆分（名字 / 一句话介绍）：表单存下的原样字段，卡片按它分两行，不再靠空格猜
    titleName: w.titleName || '', titleTag: w.titleTag || '',
    // 「一眼看懂」内容结构五件套：详情页速览卡 / 页面摘要 / JSON-LD 都用这一组（见 seo.quickLookHtml）
    positioning: w.positioning || '',
    problem: w.problem || '',
    audience: w.audience || '',
    diff: w.diff || '',
    steps: Array.isArray(w.steps) ? w.steps.filter(Boolean).slice(0, 5) : [],
    anonymous: w.anonymous === true,   // 匿名发布：前台不显示真实作者
    categories: catsOf(w),
    type: types[0], types: types,
    // 关键词：作者可编的搜索标签。详情页渲染成胶囊（点了进搜索），列表卡片不用
    keywords: keyWordsOf(w),
    intro: w.prompt || '', link: lampLocked ? '' : (w.link || ''),
    // 简介是 Markdown 源码（编辑回填用）。卡片/列表只放得下纯文本，这里给去掉记号的摘要，
    // 免得卡片上出现 ** ## 这类符号；详情页再单独渲染成 HTML（见 /api/works/:id）
    introText: introDigest(md.plain(w.prompt || ''), 160),
    // 卡片/列表行专用的一句话（首句、约 22 字）：单行布局放不下 160 字摘要，
    // 交给 CSS 截会切在句子中间。详情/摘要仍用 introText 全文。
    cardDesc: cardDigest(md.plain(w.prompt || ''), 22),
    site: lampLocked ? '' : (w.site || ''),
    ...(!lampLocked && w.links && Object.keys(w.links).length ? { links: w.links } : {}),
    image: w.image, thumb: w.thumb || w.image, qrcode: lampLocked ? '' : (w.qrcode || ''),
    qrSrc: lampLocked ? '' : qr.src, qrReal: lampLocked ? false : !!qr.real,
    qrTargets: lampLocked ? [] : (qr.targets || []), qrDetailCode: lampLocked ? '' : detailCodeOf(w),
    images: Array.isArray(w.images) ? w.images.slice(0, 9) : [],
    likes: w.likes || 0, liked: likedOf(w.id, user), favs: w.favs || 0, commentCount: countComments(w.id), views: w.views || 0, featured: isFeaturedActive(w), featuredUntil: w.featuredUntil || null, pinned: !!w.pinned,
    tipsTotal: tipAggOf(w.id).total, tipsCount: tipAggOf(w.id).count,
    openSource: w.openSource === true ? true : (w.openSource === false ? false : null),
    repo: w.repo || '',
    stars: typeof w.stars === 'number' ? w.stars : null,   // GitHub star 缓存（作者点「同步」时更新，非实时），详情页展示用
    starsAt: w.starsAt || null,
    paid: !!w.paid,
    // 旧数据兼容：donation（送灯火）已下线，一律按「免费」输出；其余非付费标注（lamp）照旧下发
    paidModel: w.paidModel === 'donation' ? '' : (w.paid || NON_PAID_MODELS.includes(w.paidModel) ? (w.paidModel || '') : ''),
    // 灯火解锁：定价 + 当前访客的锁定状态（前台据此渲染锁定卡片 / 解锁按钮）
    lampPrice: lampPrice,
    lampLocked: lampLocked,
    lampUnlocked: lampUnlocked,
    lampUnlocks: lampUnlockCountOf(w.id),
    authorTags: userTagsOf(w.author),
    codesTotal: codesOf(w.id).length,
    codesLeft: codesOf(w.id).filter(c => c.status === 'available').length,
    faved: !!(user && Array.isArray(user.favs) && user.favs.includes(w.id)),
    owned: !!(user && w.userId && user.id === w.userId),
    // 众人小法官：票数 / 我投过什么 / 能不能投（列表卡片看 jury.card 决定要不要挂角标）
    jury: juryPublic(w, user),
    // 站长账号：可以在前台直接编辑任意作品（详情页据此出「站长编辑」入口）。
    // 这里只是给前端一个显示依据，真正的写权限在 PUT /api/works/:id 里按 isSiteOwner 再验一次。
    adminEdit: !!(user && isSiteOwner(user) && w.userId !== user.id),
    hidden: !!w.hidden,
    claimed: !!w.userId,
    claimable: isClaimable(w),
    // 授权一键认领：站长预先授权给某账号的作品，只有被授权人本人能看到标记（不对外暴露授权给了谁）
    // 与认领接口同口径：账号注册时间晚于授权时间的视为抢注，不出入口（防假冒认领）
    claimAuthMine: !!(user && w.claimAuthorized && user.username.toLowerCase() === String(w.claimAuthorized).toLowerCase())
      && !(w.claimAuthAt && user.createdAt && new Date(user.createdAt) > new Date(w.claimAuthAt)),
    // 本作品是否设了认领暗号：只告诉前端「有没有这个入口」，暗号本身永不下发
    claimCodeOn: claimCodeOn(w),
    // 暗号认领的额外奖励：只在「还没归属 + 认领开放 + 真有额度」时下发，
    // 让作者在认领前就看到「填对暗号能多拿多少、为什么给」，暗号本身仍然永不下发。
    claimBonus: (claimCodeOn(w) && !w.userId && isClaimable(w)) ? claimBonusOf(w) : null,
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

// 相关作品：同分类优先（共享分类越多越靠前），数量不够再补同作者的最新件。
// SSR 详情页（/w/:id）和前端详情弹窗（/api/works/:id）共用这一份 —— 两处推荐必须是同一批，
// 否则搜索引擎看到的和用户看到的不一致，改算法时也只需要改这里。
// 只用 visibleWorks()（已过滤下架 / 未过审），不会把藏起来的作品漏给访客。
function relatedWorksOf(w, user, limit = 6) {
  const cats = catsOf(w);
  const author = w.anonymous === true ? '' : (w.author || '');
  const sameCat = [], sameAuthor = [];
  visibleWorks().forEach(x => {
    if (x.id === w.id) return;
    const shared = cats.length ? catsOf(x).filter(c => cats.includes(c)).length : 0;
    if (shared > 0) sameCat.push({ x, shared });
    else if (author && x.author === author && x.anonymous !== true) sameAuthor.push(x);
  });
  sameCat.sort((a, b) => b.shared - a.shared || (new Date(b.x.createdAt) - new Date(a.x.createdAt)));
  return sameCat.map(o => o.x)
    .concat(byNewest(sameAuthor))
    .slice(0, limit)
    .map(x => publicWork(x, user));
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

// 作品关键词（作者可增删的搜索标签）。字段的两种「空」含义不同，别搞混：
//   w.keywords 不存在（老数据、还没编辑过的）→ 按标题 / 简介 / 分类现算一份，搜索当场就能命中
//   w.keywords = []（作者自己删光了）        → 就当他不要关键词，别再自作聪明填回来
// 见 keywords.js 头注释：自动生成走本地规则，不调 AI。
function keyWordsOf(w) {
  if (Array.isArray(w.keywords)) return w.keywords;
  return autoKeywords({ title: w.title, prompt: w.prompt, categories: catsOf(w), types: typesOf(w) });
}
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
  payUploadRewardInstant(w);     // 预告 / 审核中压着的即时款，真正上线这一刻补发
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
// 注意顺序：显式关闭 > 一切默认。匿名作品默认开放，但站长点过「关闭认领」就该真的关掉
// （以前这对匿名作品无效，认领口令上线后等于给已关闭的作品留了个后门，11-12 修正）。
function isClaimable(w) {
  if (w.claimOpen === false) return false;
  if (w.claimOpen === true) return true;
  if (w.anonymous === true) return true;   // 匿名发布：默认开放认领，让真正的作者能认回去
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
  // 账号名与个性地址互斥（见 slugParse）：注册晚一步就把别人的 /u/lin 抢成自己的作者页入口，不行
  if (users.some(u => slugOf(u) === name.toLowerCase())) {
    return res.status(400).json({ error: '这个用户名刚被别人用作个性地址，换一个吧' });
  }
  // 与别人的账号 id 也不互斥（同 slugParse 那条）：/u/ 解析 id 优先，撞了作者页会被 id 主人带走
  if (users.some(u => String(u.id || '').toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: '这个用户名和站内的账号 ID 撞了，换一个吧' });
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
  user.regIpRaw = ipRawOf(req);
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
  touchActive(req, user);   // 登录即一次有效活跃，立刻记下
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
  user.regIpRaw = ipRawOf(req);
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
// 微信一键建号（mode=new）不算绑定，不发；临时号合并（/api/me/wechat/merge）算绑定，会补发一次（见该路由）。
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
    text: `你把微信绑定到了「${displayNameOf(user.username)}」，一次性送 ${WX_BIND_BONUS_POINTS} 盏灯火，当前余额 ${points} 盏。以后这个微信打开小程序免密登录；灯火可在「推荐」换推荐位。`,
    points,
    delta: WX_BIND_BONUS_POINTS
  });
  saveShareNow();                           // 300 盏是当场到账的钱：和 openid 哈希一起同步落盘，别等 2 秒 debounce
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
    touchActive(req, existing);
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
    touchActive(req, user);
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
  // 小程序建号不记 regIpRaw：这里的出口 IP 是运营商 NAT，几百个陌生人共用一个，
  // 记进注册 IP 会让后台「同IP」标签全是误报。最近 IP（lastIp）照常记，只作排查参考。
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
// 中间这段时间攒下的收藏、想法、评论、作品、领的兑换码都挂在临时号上，
// 直接 bind 会把 openid 挪走、数据留在没人能进的临时号里 —— 用户看到的就是「数据丢了」。
// 所以合并要逐项搬完再删临时号：搬的东西和「注销账号」要清理的东西是同一份清单，漏一项就是一次投诉。
// **灯火只搬差额**（2026-11-08 拍板）：不相加，取两边较高的那份；签到记录/来源统计不搬，见 ⑧ 的说明。
function mergeWechatAccountInto(from, to) {
  const moved = { favs: 0, points: 0, pointsFrom: 0, pointsDropped: 0, works: 0, comments: 0, ideas: 0, notices: 0, codes: 0 };

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

  // ⑧ 分享战绩（share.json 按 uid 存）+ 灯火取最高。
  // 灯火口径（2026-11-08 拍板）：**不相加，取两边较高的那份**。
  // 相加会把"多个微信号各自签到 / 看激励视频 → 并到一个号"变成 N 倍购买力；
  // 取最高则不增发：临时号记录删掉后余额随之作废，目标账号最多只拿到临时号原本那点数，
  // 全站灯火总量不增加，单账号余额天花板 = 一个号自己刷能刷到的最高值（多开不产生套利）。
  // 签到记录 checkin 不搬（会把连签和累计榜拉虚），灯火来源统计 promoPoints/adminPoints 也不搬（只服务达人榜）。
  // pointsFrom / pointsDropped：回给前端做提示，别让用户以为灯火"悄悄没了"。
  const fr = shareData.users[from.id];
  if (fr) {
    const tr = shareRecOf(to.id);
    const fromPts = Math.max(0, Number(fr.points) || 0);
    const toPts = Math.max(0, Number(tr.points) || 0);
    const gained = Math.max(0, fromPts - toPts);
    if (gained > 0) {
      tr.points = fromPts;
      pushShareLog(tr, 'wxmerge', '', gained);   // 余额变了必须补一条流水，否则明细合计和余额对不上
    }
    moved.points = gained;                       // 实际并进老账号的盏数（差额，不是临时号全额）
    moved.pointsFrom = fromPts;                  // 临时号原余额（前端解释"没叠加"用）
    moved.pointsDropped = fromPts - gained;      // 取最高后被作废的那部分
    ['visits', 'regs', 'promoVisits', 'promoRegs'].forEach(k => {
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
    delete shareData.users[from.id];   // 临时号余额随之作废（已按"取最高"补过差额），全站灯火总量不增加
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
  likeLog.forEach(e => { if (e.vid === 'u:' + from.id) e.vid = 'u:' + to.id; });
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

  const openid = String(from.wechat.openid);
  const moved = mergeWechatAccountInto(from, target);
  // 合并等于"这个微信正式绑到了老账号上"（校验过老账号密码），原来走 mode=bind 能拿的 300 盏
  // 这里补发一次，否则扫码自动建号那条路会白丢一笔。幂等靠账号维度 wxBindBonusAt + 微信号哈希，
  // 一个微信号一辈子只能领一次，不会变成刷量口子，也不会重复发。
  const bonus = awardWxBindBonus(target, openid);
  touchActive(req, target);
  ensureLegacyNick(target);
  setSession(res, target, true, 'pass');   // 目标账号密码刚验过
  res.json({
    ok: true, merged: true,
    username: target.username,
    nickname: target.nickname || '',
    displayName: displayNameOf(target.username),
    moved,
    bonus,
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
  let user = users.find(u => u.wechat && u.wechat.openid === openid);
  let created = false;
  if (!user) {
    // 这个微信还没绑账号 —— 直接建号，把这次扫码登录做完。
    // 以前是回 needAccount 让用户在手机确认页二选一（绑定已有 / 创建新的），
    // 但扫码的人九成是"没有账号的新用户"，多这一问就把人卡在确认页（旧版小程序还会
    // 落到「出了点问题」）。少一步比多问一句重要：新号当场建好，电脑直接登录。
    // 真有老账号的：登录后到小程序「我的 → 绑定已有账号」，走 acct-choice-sheet 把
    // 收藏/灯火/作品整份合并过来（makeWechatUser 建的号 tempAcct=true，允许合并）。
    user = makeWechatUser(openid);
    user.regIp = ipKeyOf(req);
    user.regIpRaw = ipRawOf(req);   // 网页扫码建的号：出口就是本人网络，可以记
    users.push(user);
    saveUsers();
    created = true;
    try { pushChronicleWelcome(user); } catch (e) { /* 消息失败不影响登录 */ }
  }
  touchActive(req, user);
  ensureLegacyNick(user);
  t.status = 'confirmed';
  t.uid = user.id;
  t.created = created;
  res.json({ ok: true, created, username: user.username, displayName: displayNameOf(user.username) });
});
// ②⑤ 网页轮询：pending / expired / ok（ok 时种会话并销毁 ticket）
app.get('/api/auth/wxscan/poll/:ticket', (req, res) => {
  wxscanCleanup();
  const ticket = String(req.params.ticket || '').trim();
  const t = wxscanTickets.get(ticket);
  if (!t) return res.json({ status: 'expired' });
  if (t.status !== 'confirmed') return res.json({ status: t.status });
  const user = users.find(u => u.id === t.uid);
  wxscanTickets.delete(ticket);
  if (!user) return res.json({ status: 'expired' });
  setSession(res, user, true, 'wechat');
  touchActive(req, user);
  // 同 /api/login：前端拿这个响应直接建登录态，passSet / 别名必须带上（否则弹窗误判「当前密码」）
  // created：这次扫码顺手建的新号（网页端要提示一句，否则用户会纳闷"我啥时候建的号"）
  res.json({ status: 'ok', created: !!t.created, username: user.username, nickname: user.nickname || '', displayName: displayNameOf(user.username),
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

// 海报封面跟二维码一起下发：小程序里 wx.getImageInfo / <image> 属于 downloadFile 请求，
// 后台没配合法域名时封面拉不到，海报会整块退化成「渐变+首字」占位。这里在服务端把封面
// 压成 jpeg base64，走 /api/mini/poster 这条已经配好的 wx.request 通道，彻底绕开域名白名单。
// 缓存键带 mtime：作者换封面（新文件名或覆盖旧文件）后下次生成就能拿到新图。
const posterCoverCache = new Map();   // key: 封面路径|mtime → { cover, coverW, coverH }
const POSTER_COVER_CACHE_MAX = 120;
async function posterCoverOf(w) {
  const rel = String(w.image || w.thumb || '').trim();
  if (!/^\/uploads\/[^/\\]+$/.test(rel)) return {};   // 只认站内上传文件，外链与目录穿越一律不下发
  const src = path.join(UPLOAD_DIR, path.basename(rel));
  if (!fs.existsSync(src) || !sharpLib) return {};    // sharp 没装就别塞原图，小程序端会退回老路
  let mtime = 0;
  try { mtime = fs.statSync(src).mtimeMs; } catch { return {}; }
  const key = rel + '|' + mtime;
  if (posterCoverCache.has(key)) return posterCoverCache.get(key);
  try {
    // 海报导出 1125×1800、封面区 1125×630：1125 宽足够清晰；jpeg 在小程序 canvas 里最稳
    const { data, info } = await sharpLib(src).rotate()
      .resize({ width: 1125, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const val = {
      cover: 'data:image/jpeg;base64,' + data.toString('base64'),
      coverW: info.width, coverH: info.height
    };
    if (posterCoverCache.size >= POSTER_COVER_CACHE_MAX) {
      posterCoverCache.delete(posterCoverCache.keys().next().value);
    }
    posterCoverCache.set(key, val);
    return val;
  } catch { return {}; }
}

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
  const posterExtra = await posterCoverOf(w);   // 封面随码一起下发；拿不到就返回 {}，小程序端自己兜底
  if (posterQrCache.has(cacheKey)) return res.json({ qr: posterQrCache.get(cacheKey), cached: true, ...posterExtra });
  try {
    if (WECHAT_CONF.mock) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="430" height="430"><rect width="430" height="430" fill="#fff"/><rect x="10" y="10" width="410" height="410" fill="none" stroke="#c8cbe0" stroke-width="6" stroke-dasharray="14 10"/><text x="215" y="205" text-anchor="middle" font-size="26" fill="#8a8fa3" font-family="sans-serif">MOCK 小程序码</text><text x="215" y="245" text-anchor="middle" font-size="18" fill="#b0b4c8" font-family="sans-serif">' + scene + '</text></svg>';
      const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      if (posterQrCache.size >= POSTER_QR_CACHE_MAX) {
        const first = posterQrCache.keys().next().value;
        posterQrCache.delete(first);
      }
      posterQrCache.set(cacheKey, url);
      return res.json({ qr: url, mock: true, scene, ...posterExtra });
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
    res.json({ qr, scene, ...posterExtra });
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

// ---- 「查看投放效果」：每个小程序推广位出一张直达对应页面的码 ----
// 小程序里的页面在网页上看不到，投放的人想亲眼确认位子长什么样、广告落在哪——
// 按位出码：扫开直达对应页面（首页 / 酒馆 / 详情 / 星梦榜 / 发现）。
// mini-feat-line 已并入 mini-rank-line 槽，但这个 key 保留：合并槽「看效果」要出两张码
// （一张直达星梦榜、一张直达发现页），前端拿这两个 key 分别取码。
// 位数固定 → 每位只真正调微信一次。这里单开一个池子，存「原始二进制 + 类型」而不是 dataURI：
// 前端走 ?raw=1 直接把它当图片加载，就能吃到浏览器 HTTP 缓存，第二次打开是瞬开
//（dataURI 塞在 JSON 里是存不进浏览器缓存的，每次都得等接口跑一趟）。
// 不带 raw 的老形态照旧返回 dataURI，兼容别的调用方。
const MINI_PEEK_PAGES = {
  'mini-home-first': 'pages/index/index',
  'mini-bar': 'pages/bar/index',
  'mini-detail': 'pages/detail/index',
  'mini-rank-line': 'pages/rank/index',
  'mini-feat-line': 'pages/featured/index',
  // 推广补灯：兑换页灯火不够时引导创作者去小程序看广告补灯，码直达「我的」页（scene=pad 页内亮卡）
  'promo-ad': 'pages/mine/index',
  // 网页签到卡的「看广告 +30」：码直达「我的」页（scene=ad 页内高亮签到卡里那张看视频卡）
  'ck-ad': 'pages/mine/index'
};
const peekQrCache = new Map();   // key: peek:<slot>[:<scene>] → { type, buf, etag }
const PEEK_QR_CACHE_MAX = 40;

// 详情页的码必须落在某一件真实作品上：详情页只认 ?id= / scene=w:<作品id>，
// 不带编号的码扫开就是一张「缺少作品编号」的死页。挑一件最热、且不需要灯火解锁的——
// 扫进去能看到完整内容，才看得出评论区上方那条广告落在哪。
// 指定了就用指定那件（《怀旧游戏收纳盒》：内容完整、评论区有人聊，看效果更直观）；
// 它下架或被隐藏了就退回自动挑最热的一件，码不会因此生成失败。
const MINI_PEEK_DETAIL_WORK = 'mw6a551zc4p9';
function peekDetailScene(req) {
  const list = publicWorks(req).filter(w => !(w.paidModel === 'lamp' && normLampPrice(w.lampPrice) > 0));
  if (!list.length) return '';
  const pick = list.find(w => w.id === MINI_PEEK_DETAIL_WORK);
  if (pick) return 'w:' + pick.id;
  list.sort((a, b) => score(b) - score(a));
  return 'w:' + list[0].id;
}

function putPeekQr(key, type, buf) {
  const rec = { type, buf, etag: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) };
  if (peekQrCache.size >= PEEK_QR_CACHE_MAX) peekQrCache.delete(peekQrCache.keys().next().value);
  peekQrCache.set(key, rec);
  return rec;
}

function sendPeekQr(req, res, rec, cached) {
  if (String(req.query.raw || '') === '1') {
    // 码的内容是定的（位固定、详情页挑中的作品也钉在 key 里），给一周浏览器缓存：
    // 再点「看效果」直接读本地，不用等微信生码
    res.set('Cache-Control', 'public, max-age=604800');
    res.set('ETag', '"' + rec.etag + '"');
    res.type(rec.type);
    return res.send(rec.buf);
  }
  return res.json({ qr: 'data:' + rec.type + ';base64,' + rec.buf.toString('base64'), cached: !!cached });
}

app.get('/api/mini/peek-qr', async (req, res) => {
  const slot = String(req.query.slot || '').trim();
  const page = MINI_PEEK_PAGES[slot];
  if (!page) return res.status(400).json({ error: '未知的位置' });
  if (!rateLimit('peekqr:' + clientIp(req), 60, 3600e3)) return res.status(429).json({ error: '请求太频繁' });
  // 详情页那一位：第一次挑中的作品就钉住（scene 进缓存 key），别每次换一件
  let scene = 'peek';
  if (slot === 'promo-ad') scene = 'pad';   // 推广补灯：固定落「我的」页，页内按 scene 亮推广补灯卡
  if (slot === 'ck-ad') scene = 'ad';       // 网页签到卡看广告：落「我的」页，页内按 scene 高亮看视频卡
  if (slot === 'mini-detail') {
    const prefix = 'peek:mini-detail:';
    const pinned = [...peekQrCache.keys()].find(k => k.startsWith(prefix));
    scene = pinned ? pinned.slice(prefix.length) : peekDetailScene(req);
    if (!scene) return res.status(400).json({ error: '站里还没有能打开的作品，先去逛逛再来' });
  }
  const cacheKey = 'peek:' + slot + (slot === 'mini-detail' ? ':' + scene : '');
  const hit = peekQrCache.get(cacheKey);
  if (hit) return sendPeekQr(req, res, hit, true);
  try {
    if (WECHAT_CONF.mock) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="430" height="430"><rect width="430" height="430" fill="#fff"/><rect x="10" y="10" width="410" height="410" fill="none" stroke="#c8cbe0" stroke-width="6" stroke-dasharray="14 10"/><text x="215" y="205" text-anchor="middle" font-size="26" fill="#8a8fa3" font-family="sans-serif">MOCK 小程序码</text><text x="215" y="245" text-anchor="middle" font-size="18" fill="#b0b4c8" font-family="sans-serif">' + page + '</text></svg>';
      return sendPeekQr(req, res, putPeekQr(cacheKey, 'image/svg+xml', Buffer.from(svg)), false);
    }
    if (!WECHAT_ENABLED) return res.status(400).json({ error: '小程序码暂不可用（微信未配置）' });
    const token = await wechatAccessToken();
    const r = await fetch('https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // check_path:false：位子所在页面都已上线，留着这条和海报码同口径，不怕审核期误伤
      body: JSON.stringify({ scene, page, check_path: false, width: 430 }),
      signal: AbortSignal.timeout(15000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const wxType = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!wxType.startsWith('image/')) {
      let d = {}; try { d = JSON.parse(buf.toString('utf-8')); } catch { /* 非 JSON 也当失败 */ }
      throw new Error('生成小程序码失败（' + (d.errcode || '?') + ' ' + (d.errmsg || '') + '）');
    }
    // 微信回的是 jpeg 还是 png 不一定，按它给的类型回，别写死
    return sendPeekQr(req, res, putPeekQr(cacheKey, wxType, buf), false);
  } catch (err) {
    res.status(502).json({ error: err.message || '生成小程序码失败，请稍后再试' });
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
  user.regIpRaw = ipRawOf(req);
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
  // 每天第一次打开站点就把「到访」那 2 盏发掉：网页首屏和小程序首页都会拉这个接口，漏不掉。
  // 不另开接口是刻意的——多一个接口就多一处「前端忘了调」，而到访奖励最怕的就是漏发。
  const arrived = grantArrive(user);
  const providers = { github: GH_ENABLED, google: GOOGLE_ENABLED, wechat: WECHAT_ENABLED };   // 没配对应登录方式时前端不显示入口
  res.json(user
    ? {
        id: user.id,
        username: user.username, createdAt: user.createdAt,
        nickname: user.nickname || '',
        // 头像：avatar 空串 = 用首字母色块（前端据此决定渲不渲染 <img>）
        ...avatarViewOf(user),
        displayName: displayNameOf(user.username),
        nicknameNextAt: nickNextAt(user),
        blocked: Array.isArray(user.blocked) ? user.blocked : [],
        blockedUsers: Array.isArray(user.blockedUsers) ? user.blockedUsers : [],
        favs: Array.isArray(user.favs) ? user.favs : [],
        checkin: checkinView(user),
        arrive: { ...arriveView(user), given: arrived },   // given=true 只在「这一趟刚发」时为真，前端据此弹一次提示
        points: shareStatsOf(user.id).points,
        unreadNotices: notices.filter(n => n.userId === user.id && !n.read).length,
        // 站方公告是否屏蔽提示（true = 正常弹提示；false = 只进列表不弹窗）
        noticePrefs: { announce: !announceMuted(user) },
        worksCount: works.filter(w => w.userId === user.id && !w.deleted).length,
        // 个性地址：slug 为空表示还在用 /u/<账号id>；slugEligible 决定设置入口是否可点（前端不自己数作品）
        slug: slugOf(user),
        slugPath: authorPathOf(user),
        slugNextAt: slugNextAt(user),
        slugEligible: slugEligible(user),
        passSet: user.passSet !== false,            // false = OAuth 建号还没设密码
        isSiteOwner: isSiteOwner(user),             // 站长：编辑作品时不显示「内容由我负责」承诺框（前端显示依据）
        // 管理后台入口显示依据：站长或名单管理员才亮「管理后台」；真正的鉴权仍在后台接口，这里只管显隐
        isAdmin: isSiteOwner(user) || isAdminName(user.username),
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

// ================= 头像 =================
// 三个来源：本地上传 / GitHub / 微信（小程序 chooseAvatar），**落盘一律存站内**。
// 为什么不直接引用第三方 URL：GitHub 换头像后旧链接会 404（哈希路径），微信那边根本没有
// 可引用的地址（chooseAvatar 只给临时文件）；头像又是全站最高频的元素，挂一个空就是一片空白。
// 存本地还能顺手裁成 256 见方的 webp —— 40px 的评论头像不用再拉 460×460 的原图。
const AVATAR_FILE_RE = /^\/uploads\/av-[A-Za-z0-9_-]+\.webp$/;
const AVATAR_SRC_LABEL = { upload: '自己传的', github: 'GitHub 头像', wx: '微信头像' };
// 生效中的头像：只认自己写出来的那套文件名，脏数据/手改字段一律当没有（回落到首字母）
function avatarUrlOf(user) {
  const p = user && user.avatar;
  return (typeof p === 'string' && AVATAR_FILE_RE.test(p)) ? p : '';
}
function avatarSrcOf(user) {
  if (!avatarUrlOf(user)) return '';
  const s = user.avatarSrc;
  return AVATAR_SRC_LABEL[s] ? s : 'upload';
}
// 换头像时把上一张删掉，别让 /uploads 里堆一辈子用不上的图（失败不影响这次保存）
function dropAvatarFile(rel) {
  if (!rel || !AVATAR_FILE_RE.test(rel)) return;
  try { removeUpload(rel); } catch (e) { /* 删不掉就算了，不值得让用户重传 */ }
}
// 任何来源的图都走这里：解方向 → 居中裁 256 见方 → webp。
// 用 buffer 而不是文件路径：multer 刚写完的文件在 Windows 上让 libvips 直接 open 会偶发失败。
async function writeAvatarFile(buf, userId) {
  if (!sharpLib) throw new Error('服务器缺少图片处理组件');
  const name = 'av-' + String(userId || 'u').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)
    + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.webp';
  const out = path.join(UPLOAD_DIR, name);
  await sharpLib(buf, { failOn: 'none' }).rotate()
    .resize(256, 256, { fit: 'cover', position: 'attention' })   // attention：优先保住人脸所在的那块
    .webp({ quality: 82, effort: 4 }).toFile(out);
  return '/uploads/' + name;
}
// 落库 + 清旧图：三个来源共用，字段口径只写一遍
function applyAvatar(user, rel, src) {
  const old = avatarUrlOf(user);
  user.avatar = rel;
  user.avatarSrc = src;
  user.avatarAt = new Date().toISOString();
  saveUsers();
  if (old && old !== rel) dropAvatarFile(old);
}
function resetAvatar(user) {
  const old = avatarUrlOf(user);
  delete user.avatar;
  delete user.avatarSrc;
  delete user.avatarAt;
  saveUsers();
  if (old) dropAvatarFile(old);
}
// 上传通道：单文件、8MB 上限（头像用不着更大的，超了也白占内存）
const uploadAvatarFile = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
}).single('avatar');
// 前端据此显示「当前是哪种头像」，空串 = 首字母
function avatarViewOf(user) {
  return {
    avatar: avatarUrlOf(user),
    avatarSrc: avatarSrcOf(user),
    avatarSrcLabel: AVATAR_SRC_LABEL[avatarSrcOf(user)] || '',
    hasGithubAvatar: !!(user && user.github && user.github.avatar)
  };
}

// 上传一张图当头像（网页拖/选文件、小程序 chooseAvatar 都走这里，source=wx 只是记个来源）
app.post('/api/me/avatar', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('avatar:' + user.id, 12, 600000)) {
    return res.status(429).json({ error: '换头像太频繁了，10 分钟后再试' });
  }
  uploadAvatarFile(req, res, async (err) => {
    const tmp = req.file && req.file.path;
    const dropTmp = () => { if (tmp) fs.promises.unlink(tmp).catch(() => {}); };
    if (err) {
      dropTmp();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 8MB' : '上传失败，换一张再试';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '没有收到图片' });
    // 只认图片 MIME：有人把 .html 改名成 .jpg 传上来，multer 不拦这个
    if (!/^image\//.test(String(req.file.mimetype || ''))) {
      dropTmp();
      return res.status(400).json({ error: '只能上传图片' });
    }
    try {
      const buf = await fs.promises.readFile(tmp);
      const rel = await writeAvatarFile(buf, user.id);
      const src = req.body && req.body.source === 'wx' ? 'wx' : 'upload';
      applyAvatar(user, rel, src);
      res.json({ ok: true, ...avatarViewOf(user) });
    } catch (e) {
      console.warn('[avatar] 处理失败:', e.message);
      res.status(400).json({ error: '这张图处理不了，换一张（jpg/png/webp）试试' });
    } finally {
      dropTmp();
    }
  });
});

// 用 GitHub 头像：服务端把图拉回来存本地，之后前端一律读 /uploads/av-*.webp
app.post('/api/me/avatar/github', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const url = (user.github && user.github.avatar) || '';
  if (!url) return res.status(400).json({ error: '先绑定 GitHub，才能用 GitHub 头像' });
  // 只允许 GitHub 的头像域名：这个 URL 虽然是 GitHub API 给的，仍然按外部输入对待（防 SSRF）
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { /* 下面统一报错 */ }
  if (host !== 'avatars.githubusercontent.com') {
    return res.status(400).json({ error: 'GitHub 头像地址不可用，重新绑定一次 GitHub 试试' });
  }
  if (!rateLimit('avatar:' + user.id, 12, 600000)) {
    return res.status(429).json({ error: '换头像太频繁了，10 分钟后再试' });
  }
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'dream-window', Accept: 'image/*' },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('图片过大');
    const rel = await writeAvatarFile(buf, user.id);
    applyAvatar(user, rel, 'github');
    res.json({ ok: true, ...avatarViewOf(user) });
  } catch (e) {
    console.warn('[avatar] 拉取 GitHub 头像失败:', e.message);
    res.status(502).json({ error: '拉取 GitHub 头像失败，稍后再试' });
  }
});

// 恢复首字母头像
app.post('/api/me/avatar/reset', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  resetAvatar(user);
  res.json({ ok: true, ...avatarViewOf(user) });
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

// ---- 个性地址（作者页 /u/<自定义>）----
// 查重单独一个接口：输入框边打边判「这个地址能不能用」，比等点保存才报错舒服。
// 只读不写、不限流（前端 400ms 防抖）；真正的落地判定在 POST 里再做一遍，前端校验只算提示。
app.get('/api/me/slug/check', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  if (!slugEligible(user)) {
    return res.json({ ok: false, error: '发布至少 1 件已上线的作品后就能设个性地址', code: 'no_work' });
  }
  const parsed = slugParse(req.query.slug, user);
  if (parsed.error) return res.json({ ok: false, error: parsed.error, code: parsed.code || '' });
  res.json({ ok: true, slug: parsed.slug, path: '/u/' + parsed.slug, same: parsed.slug === slugOf(user) });
});

app.post('/api/me/slug', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('slug:' + user.id, 10, 3600e3)) {
    return res.status(429).json({ error: '改得太频繁了，稍后再试' });
  }
  const raw = String((req.body && req.body.slug) || '').trim().toLowerCase();
  // 传空 = 取消个性地址，回到 /u/<账号id>；已发出去的旧地址留着 301，不算「断链」
  if (!raw) {
    if (!slugOf(user)) return res.json({ ok: true, slug: '', path: '/u/' + user.id });
    const next = slugNextAt(user);
    if (next) {
      const days = Math.ceil((next - Date.now()) / 864e5);
      return res.status(429).json({ error: `个性地址 30 天只能改一次，还有 ${days} 天可以再改`, nextAt: next });
    }
    retireSlug(user, '');
    user.slug = '';
    user.slugChangedAt = Date.now();
    saveUsers();
    return res.json({ ok: true, slug: '', path: '/u/' + user.id, slugNextAt: slugNextAt(user) });
  }
  if (!slugEligible(user)) {
    return res.status(403).json({ error: '发布至少 1 件已上线的作品后就能设个性地址' });
  }
  const parsed = slugParse(raw, user);
  if (parsed.error) return res.status(400).json({ error: parsed.error, code: parsed.code || '' });
  if (parsed.slug === slugOf(user)) {
    return res.json({ ok: true, slug: parsed.slug, path: '/u/' + parsed.slug, unchanged: true, slugNextAt: slugNextAt(user) });
  }
  const next = slugNextAt(user);
  if (next) {
    const days = Math.ceil((next - Date.now()) / 864e5);
    return res.status(429).json({ error: `个性地址 30 天只能改一次，还有 ${days} 天可以再改`, nextAt: next });
  }
  retireSlug(user, parsed.slug);
  user.slug = parsed.slug;
  user.slugChangedAt = Date.now();
  saveUsers();
  res.json({ ok: true, slug: user.slug, path: '/u/' + user.slug, slugNextAt: slugNextAt(user) });
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
  // 冒充防线：不能撞别人的账号名 / 别人的登录别名（与注册同一套规则）
  if (users.find(u => u.id !== user.id && u.username.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: '这个登录名和别人的账号名重复了，换一个吧' });
  }
  if (users.find(u => u.id !== user.id && String(u.alias || '').toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: '这个登录名已经被占用，换一个吧' });
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

// 认领收尾（共用）：归属转移 + 其它待审申请自动关闭 + 匿名灯火结算
// + 上传奖励（人工路径，当场全额）+ 开源奖励。「管理员审核认领通过」与
// 「授权一键认领」都走这里，保证两条路口径完全一致。
function finalizeClaimTransfer(w, userId, username, via) {
  const now = new Date().toISOString();
  // 作品归到认领人名下：作者名同步改为用户名，之后就能在「我的作品」里编辑/管理
  w.userId = userId;
  w.author = username;
  delete w.anonymous;        // 认领成功后翻牌成实名作者
  delete w.authorReal;
  delete w.claimAuthorized; delete w.claimAuthAt;   // 授权认领用完即清
  w.claimedAt = now;
  w.claimOpen = false;   // 认领成功后自动关闭入口
  // 同一作品的其它待审申请自动关闭，避免重复认领
  claims.forEach(o => {
    if (o.workId === w.id && o.status === 'pending') {
      o.status = 'rejected'; o.handledAt = now; o.note = '作品已被其他申请人认领';
    }
  });
  // 认领人此前以访客/路人身份给这件作品留的「三选一」轻反馈一并撤掉——
  // 作品一到 TA 名下，那条「用过，挺有用」就成了挂着「作者」徽标的自夸（2026-11-10 knovum 实测踩到）。
  // 只删 vote 评论（fixed 文案、可安全重建），手写的正常评论不动。
  let ownVoteN = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.workId === w.id && c.vote && (c.userId === userId || c.vid === 'u:' + userId)) {
      comments.splice(i, 1); ownVoteN++;
    }
  }
  if (ownVoteN) { saveComments(); invalidateCommentCounts(); }
  saveWorks(); saveClaims();
  // 匿名期间收到的灯火，认领成功后归到认领者名下（一次性结算，带防重标记）
  const settledTips = settleAnonymousTips(w, userId);
  // 认领通过 = 管理员确认归属，比自助投稿可信：奖励当场全额到账、不挂观察期
  // （首件 200 / 后续件 50 一次发完）。作品还没上线的先记好计划，等它正式上线时由巡检补发。
  const uploadReward = w.uploadReward ? null : planUploadReward(w, { id: userId }, via);
  payUploadRewardInstant(w);
  // 匿名期间标了开源的，之前没有账号发不出去，认领时一并补上
  const osBonus = grantOpenSourceBonus(w);
  saveWorks();
  return { settledTips, uploadReward, osBonus };
}

// 暗号认领的公共落账：摘暗号（用完即废）→ 落 channel='code' 已通过记录 → 转账归属 → 发通知。
// 两条入口共用：作品详情页（/api/works/:id/claim 带暗号）和数据看板空状态（/api/claim/by-code 只凭暗号）。
function finishCodeClaim(w, code, user, ip) {
  // 额外奖励先取出来：这是站长对这件作品单独承诺的一笔（后台建 / 编辑作品时填的），
  // 只在暗号认领这条路发，金额和原因都要落进认领记录 + 站内消息，事后好对账。
  const bonus = claimBonusOf(w);
  // 用完即废：先摘掉暗号再转账，认领成功后这个暗号就再也用不了（后台重新设即可再开）
  delete w.claimCode;
  delete w.claimBonus;   // 和暗号同一条命：暗号没了，这笔奖励也不该再挂在作品上
  saveWorks();
  const now = new Date().toISOString();
  // 先落一条「已通过」的记录再转账：后台认领页能看到是谁、什么时候、从哪个 IP 用暗号认领的。
  // 暗号本身不写进记录（后台截图会把它带出去），只留 6 位指纹，便于和后台记录里的暗号对照。
  claims.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    userId: user.id,
    username: user.username,
    channel: 'code',
    status: 'approved',
    evidence: `暗号认领：${user.username} 于 ${now.slice(0, 16).replace('T', ' ')} 填对了这件作品单独设置的认领暗号。`,
    codeHash: crypto.createHash('sha256').update('claimcode|' + normClaimCode(code)).digest('hex').slice(0, 6),
    ip,
    ipKey: crypto.createHash('sha256').update('claimcode|' + ip).digest('hex').slice(0, 12),
    // 额外奖励留档：事后查「这笔灯火为什么发」不用再去翻作品字段（认领时已被清掉）
    bonusPoints: bonus ? bonus.points : 0,
    bonusReason: bonus ? bonus.reason : '',
    createdAt: now,
    handledAt: now,
    note: '暗号认领 · 即时通过' + (bonus ? ` · 额外奖励 ${bonus.points} 盏` : '')
  });
  saveClaims();
  const r = finalizeClaimTransfer(w, user.id, user.username, 'claim');
  // 暗号额外奖励：在默认上传奖励（首件 200 / 后续 50）之外另发一笔，是加法不是覆盖。
  // 放在 finalizeClaimTransfer 之后发（站内消息是 unshift，后写的在上面），
  // 于是「认领成功 + 上传奖励」的总述压在顶上，这笔的明细解释紧跟在它下面；
  // 单独记一种流水（claimbonus），用户能在灯光明细里把这两笔分开看清。
  if (bonus) {
    const left = addPoints(user.id, bonus.points, 'claimbonus', w.id);
    addNotice(user.id, {
      kind: 'points',
      title: `暗号认领额外奖励 +${bonus.points} 盏灯火已到账`,
      text: `「${w.title}」${bonus.reason ? `：${bonus.reason}` : '：站长给这件作品单独设了暗号认领奖励'}。`
        + `这笔 ${bonus.points} 盏是在上传奖励之外额外送的，当前余额 ${left} 盏。`,
      points: left,
      delta: bonus.points
    });
  }
  addNotice(user.id, {
    kind: 'system',
    title: `「${w.title}」认领成功`,
    text: `口令正确，这件作品已归到你名下：署名、数据看板、编辑与推广权限都已生效。`
      + (r.uploadReward ? (r.uploadReward.instantPaid
          ? `上传奖励 ${r.uploadReward.amount} 盏灯火已全额到账（不用等观察期），现在就能去「推荐自己的作品」换个推荐位。`
          : `上传奖励 ${r.uploadReward.amount} 盏灯火会在作品正式上线后全额到账（不用再等观察期）。`) : '')
      + (bonus ? `另有暗号认领额外奖励 ${bonus.points} 盏${bonus.reason ? `（${bonus.reason}）` : ''}已单独到账。` : '')
      + (r.osBonus ? `已按开源作品补发 ${r.osBonus} 盏灯火。` : '')
      + (r.settledTips ? `这件作品此前收到的 ${r.settledTips} 盏灯火，也已转到你的余额里。` : '')
  });
  return { settledTips: r.settledTips, osBonus: r.osBonus, bonusPoints: bonus ? bonus.points : 0 };
}

app.post('/api/works/:id/claim', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  if (w.userId === user.id) return res.status(400).json({ error: '这是你自己发布的作品，无需认领' });
  // 授权一键认领：站长直接向作者约稿收录的作品，可预先授权给作者的账号——
  // TA 点一下就按「认领通过」的同一套口径归到名下，不用交证据、不用再审核。
  // 冒名防护：授权可能给还没注册的名字先授，这里要求认领账号的注册时间早于授权时间——
  // 比站长授权更早抢注同名号的直接拒（防假冒认领）；授权之后才注册的也拒，让真作者走暗号/人工审核。
  const isAuthed = !!(w.claimAuthorized && String(w.claimAuthorized).toLowerCase() === user.username.toLowerCase())
    && !(w.claimAuthAt && user.createdAt && new Date(user.createdAt) > new Date(w.claimAuthAt));
  if (!isAuthed && w.claimAuthorized && String(w.claimAuthorized).toLowerCase() === user.username.toLowerCase()
    && w.claimAuthAt && user.createdAt && new Date(user.createdAt) > new Date(w.claimAuthAt)) {
    return res.status(403).json({ error: '授权仅对授权时已注册的账号生效（你的账号注册晚于授权时间，已按抢注拦截）。如你是作者本人，请向站长要认领暗号，或提交创作证据走人工审核' });
  }
  // 认领由管理员逐条开放；无归属作品（匿名投稿 / 后台代传）默认开放；被授权人不受开关限制
  if (!isAuthed && !isClaimable(w)) return res.status(400).json({ error: '该作品暂未开放认领' });
  if (isAuthed) {
    const r = finalizeClaimTransfer(w, user.id, user.username, 'claim');
    addNotice(user.id, {
      kind: 'system',
      title: `「${w.title}」认领成功`,
      text: `站长已把这件作品授权给你，一键认领成功，归到你的名下：署名、数据看板、编辑与推广权限都已生效。`
        + (r.uploadReward ? (r.uploadReward.instantPaid
            ? `上传奖励 ${r.uploadReward.amount} 盏灯火已全额到账（不用等观察期），现在就能去「推荐自己的作品」换个推荐位。`
            : `上传奖励 ${r.uploadReward.amount} 盏灯火会在作品正式上线后全额到账（不用再等观察期）。`) : '')
        + (r.osBonus ? `已按开源作品补发 ${r.osBonus} 盏灯火。` : '')
        + (r.settledTips ? `这件作品此前收到的 ${r.settledTips} 盏灯火，也已转到你的余额里。` : '')
    });
    return res.json({ ok: true, claimed: true, settledTips: r.settledTips, osBonus: r.osBonus });
  }
  // 认领暗号：站长在后台给这件作品单独设的 ≤10 位字符串（比如 abc123），告诉作者就行。
  // 作者填对本件暗号 → 当场按「认领通过」的同一套口径归属 + 发奖，不进审核队列；
  // 认领成功后暗号自动删除（用完即废，和授权认领 claimAuthorized 用完即清同一口径）。
  // 安全边界：仍然只对「开放认领、还没有归属」的作品生效（上面已拦），暗号永不下发到前端，
  // 错误尝试按 IP 限速，每次成功都留一条 channel='code' 的已通过记录供后台追溯。
  const code = String((req.body && req.body.code) || '').trim();
  if (code && !isAuthed) {
    if (!claimCodeOn(w)) return res.status(400).json({ error: '这件作品没有设置认领暗号，请提交创作证据走人工审核' });
    if (!rateLimit('claimcode:' + user.id, 30, 3600000)) {
      return res.status(429).json({ error: '暗号认领太频繁了，请 1 小时后再试' });
    }
    const ip = clientIp(req);
    // 同一出口 IP（公司 / 校园网 / 手机基站）下多个作者同时认领是正常的，所以只有「猜错」才计数；
    // 但一旦错到 10 次，这个 IP 就整体锁一小时——锁住之后连对的口令也不放行，
    // 否则「错=429、对=200」等于把 400/200 的答案又还给了撞库的人。
    const ipKey = 'claimcodeip:' + ip;
    if (rateUsedUp(ipKey, 10, 3600000)) {
      return res.status(429).json({ error: '口令尝试次数过多，请 1 小时后再试' });
    }
    if (normClaimCode(code) !== normClaimCode(w.claimCode)) {
      rateLimit(ipKey, 10, 3600000);
      return res.status(400).json({ error: '认领暗号不正确，请向站长核对后再试' });
    }
    // 用完即废、落已通过记录、转账归属、发通知：公共落账见 finishCodeClaim
    const r = finishCodeClaim(w, code, user, ip);
    return res.json({ ok: true, claimed: true, settledTips: r.settledTips, osBonus: r.osBonus, bonusPoints: r.bonusPoints });
  }
  // 交证据走人工审核这条路，才吃 5 次/小时 的限制（口令认领在上面有自己的一套）
  if (!rateLimit('claim:' + user.id, 5, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
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

// 只凭暗号认领：数据看板空状态点「认领」进来的作者手里只有一件作品的暗号，
// 不该要求 TA 先去站内翻到那件作品再走详情页。这里全站扫一遍匹配暗号的 作品，
// 命中且「开放认领、无归属」就按同一套口径当场归属（finishCodeClaim）。
// 防撞库与详情页入口同一套限速：按用户 30 次/时 + 猜错按 IP 锁 10 次/时；
// 暗号不存在和暗号错误都只回同一句「不正确」，不泄露「有没有这个暗号」。
// 暗号能对上但作品不可认领时可以如实说——能对上说明请求方本来就持有暗号，不算泄露。
app.post('/api/claim/by-code', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: '请填写站长发你的认领暗号' });
  if (!rateLimit('claimcode:' + user.id, 30, 3600000)) {
    return res.status(429).json({ error: '暗号认领太频繁了，请 1 小时后再试' });
  }
  const ip = clientIp(req);
  const ipKey = 'claimcodeip:' + ip;
  if (rateUsedUp(ipKey, 10, 3600000)) {
    return res.status(429).json({ error: '口令尝试次数过多，请 1 小时后再试' });
  }
  const norm = normClaimCode(code);
  // 两轮查找：先找「无归属且开放认领」的那件（站长可能把同一个暗号先后设在两件作品上，
  // 若先命中已归属的旧件，会把新作者挡在门外）；都没有时才拿任意命中件给出具体解释。
  const usable = w => !w.userId && w.userId !== user.id && isClaimable(w);
  const hit = works.find(w => claimCodeOn(w) && normClaimCode(w.claimCode) === norm && usable(w))
    || works.find(w => claimCodeOn(w) && normClaimCode(w.claimCode) === norm);
  if (!hit) {
    rateLimit(ipKey, 10, 3600000);   // 猜错才计数：输对的作者不消耗 IP 预算（与详情页入口同一口径）
    return res.status(400).json({ error: '认领暗号不正确，请向站长核对后再试' });
  }
  if (hit.userId === user.id) return res.status(400).json({ error: '这件作品已经在你名下了' });
  if (hit.userId) return res.status(400).json({ error: '这个暗号对应的作品已经有归属了' });
  if (!isClaimable(hit)) return res.status(400).json({ error: '这个暗号对应的作品暂未开放认领，请联系站长' });
  const r = finishCodeClaim(hit, code, user, ip);
  return res.json({ ok: true, claimed: true, title: hit.title, settledTips: r.settledTips, osBonus: r.osBonus, bonusPoints: r.bonusPoints });
});

// 我的认领记录（前端用来显示「审核中 / 已通过」状态）
// ---- 站内消息（积分变动、系统通知）----
app.get('/api/me/notices', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const mine = notices.filter(n => n.userId === user.id);
  // 分区口径由服务端给：前端只按 cat 过滤，不再自己维护一份 kind→分类 的表，
  // 两边各写一份迟早会漂。cats 里同时给「条数」和「未读数」，标签上的角标直接用。
  const cats = {};
  ['all', 'promo', 'system', 'ad', 'points', 'msg'].forEach(c => { cats[c] = { n: 0, u: 0 }; });
  mine.forEach(n => {
    const c = noticeCatOf(n.kind);
    cats.all.n++; cats[c].n++;
    if (!n.read) { cats.all.u++; cats[c].u++; }
  });
  res.json({
    items: mine.slice(0, 60).map(n => {
      // 意见反馈会话：往来消息以 feedback.thread 为准（站内消息只是入口，不另存一份，免得两边打架）
      let thread = Array.isArray(n.thread) ? n.thread : [];
      if (n.feedbackId) {
        const f = feedback.find(x => x.id === n.feedbackId);
        thread = f ? fbThread(f) : [];
      }
      return {
        id: n.id, kind: n.kind, cat: noticeCatOf(n.kind), title: n.title, text: n.text,
        points: n.points || 0, delta: n.delta || 0, read: !!n.read,
        workId: n.workId || null, commentId: n.commentId || null, createdAt: n.createdAt,
        link: n.link || '',                            // 站内跳转（如 /chronicle）
        muted: !!n.muted,                              // true = 用户屏蔽了提示：照常收到，不弹窗
        feedbackId: n.feedbackId || null,
        thread, threadId: n.threadId || n.id
      };
    }),
    cats,
    unread: cats.all.u
  });
});

// 标记已读：带 id 标记单条，带 cat 只标记该分区，都不带就全部标记
app.post('/api/me/notices/read', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const id = String((req.body && req.body.id) || '');
  const cat = String((req.body && req.body.cat) || '');
  const byCat = cat && cat !== 'all';
  let changed = 0;
  notices.forEach(n => {
    if (n.userId !== user.id || n.read) return;
    if (id && n.id !== id) return;
    if (byCat && noticeCatOf(n.kind) !== cat) return;
    n.read = true;
    changed++;
  });
  if (changed) saveNotices();
  // 打开消息列表 / 全部已读，等于也看过了反馈里的回复（反馈悬浮球的小红点跟着灭）。
  // 只标某一个分区时不碰反馈——反馈回复落在「消息」分区，标「灯火」不该顺手把它清掉。
  if (!byCat) {
    let fbChanged = 0;
    feedback.forEach(f => { if (f.userId === user.id) fbChanged += fbMarkReadByUser(f); });
    if (fbChanged) saveFeedback();
  }
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

// 私信站长：用户从消息面板「给站长留言」发起新会话。
// 会话容器（kind:'dm'）挂在自己名下，thread 存在 notices 里，续聊走 /api/me/notices/reply；
// 后台「作者回复」收件箱按 thread 里有 from:'user' 自动收进来，站长回信走现有
// /api/admin/replies，不需要任何新增管理界面。
app.post('/api/me/dm', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (text.length < 1) return res.status(400).json({ error: '内容不能为空' });
  if (!rateLimit('dm:' + user.id, 1, 60000)) return res.status(429).json({ error: '发送太快了，稍等再发' });
  // 防刷：新会话每 24 小时最多开 3 个；往已有会话续聊不受此限
  const dayAgo = Date.now() - 86400000;
  const recent = notices.filter(n => n.userId === user.id && n.kind === 'dm' && new Date(n.createdAt).getTime() > dayAgo).length;
  if (recent >= 3) return res.status(429).json({ error: '今天开的新对话够多了，明天再来吧' });
  const n = addNotice(user.id, {
    kind: 'dm',
    title: '给站长的留言',
    text: text.length > 80 ? text.slice(0, 80) + '…' : text,
    thread: [{ from: 'user', fromId: user.id, fromName: user.username || '作者', text, at: new Date().toISOString(), read: false }]
  });
  if (n) { n.read = true; saveNotices(); }   // 自己写的留言别给自己挂未读角标
  res.status(201).json({ ok: true, threadId: n ? n.id : null });
});

// 凭据预检：认领弹窗要显示「你正要认领的是哪件作品」，但作品信息不能白给没有凭据的人。
// 只回标题和投稿时间；按 IP 限流，避免被当成「token 猜没猜中」的探针。
app.get('/api/claim/preview', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少认领凭据' });
  if (!rateLimit('claimpre:' + clientIp(req), 30, 3600000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const w = works.find(x => x.lookupToken && x.lookupToken === token);
  if (!w) return res.status(404).json({ error: '凭据无效' });
  res.json({ ok: true, title: w.title, createdAt: w.createdAt, claimed: !!w.userId });
});

// 匿名投稿「凭据认领」：投稿时服务端发过查询令牌（lookupToken，即 /s/<token> 那个链接）。
// 这个令牌只证明「你手里有这个链接」，不证明「链接是发给你的」——链接会被转发、被截图、
// 被贴到群里问「帮我看看进度」，谁先点谁就能把它拿走，人和灯火一起走。
// 所以这里不直接转移归属，而是落一条免填证据的认领申请（channel='token'），
// 管理员在后台看一眼、点一下「通过并归属」，才真正生效，口径仍走 finalizeClaimTransfer。
// 凭据本身是强证据，后台会单独标注；同时记 IP 指纹，同 IP 短时间连提几条会被标记。
app.post('/api/claim/by-token', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('claimtok:' + user.id, 10, 3600000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: '缺少认领凭据' });
  const w = works.find(x => x.lookupToken && x.lookupToken === token);
  if (!w) return res.status(404).json({ error: '凭据无效：请用投稿成功后那个「投稿进度」链接里的完整地址' });
  if (w.userId === user.id) return res.json({ ok: true, already: true, workId: w.id, title: w.title });
  if (w.userId) return res.status(400).json({ error: '这件作品已经有归属了' });
  // 一件作品同时只挂一条待审申请，避免多人抢同一条时后台出现一堆重复记录
  const dup = claims.find(c => c.workId === w.id && c.status === 'pending');
  if (dup) {
    if (dup.userId === user.id) return res.json({ ok: true, pending: true, duplicate: true, claimId: dup.id, title: w.title });
    return res.status(409).json({ error: '这件作品已经有人凭凭据提交了认领，正在等管理员确认。如果作品是你投的，可以在页面底部「意见建议」里说明情况。' });
  }
  const ip = clientIp(req);
  const ipKey = crypto.createHash('sha256').update('claimtok|' + ip).digest('hex').slice(0, 12);
  const sameIp24h = claims.filter(c => c.channel === 'token' && c.ipKey === ipKey
    && Date.now() - new Date(c.createdAt).getTime() < 864e5).length;
  const claim = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: w.id,
    userId: user.id,
    username: user.username,
    channel: 'token',
    evidence: `凭投稿凭据认领：令牌与这件作品投稿时生成的「进度链接」完全一致（作品投稿于 ${String(w.createdAt || '').slice(0, 16).replace('T', ' ')}）。`
      + `凭据能证明持有人拿到过投稿成功页，但链接可能被转发，请再确认申请人就是投稿人。`,
    tokenHash: crypto.createHash('sha256').update('claim|' + token).digest('hex').slice(0, 12),
    ipKey,
    ip,
    flagged: sameIp24h >= 2,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  claims.unshift(claim);
  saveClaims();
  addNotice(user.id, {
    kind: 'system',
    title: `「${w.title}」认领已提交，等待确认`,
    text: `系统已经核对过投稿凭据，管理员确认后这件作品就会归到你名下（署名、数据看板、编辑与推广权限一起生效，上传奖励全额到账）。`
      + `一般当天就会处理；如果长时间没动静，可以在页面底部「意见建议」催一下。`
  });
  res.status(201).json({ ok: true, pending: true, claimId: claim.id, title: w.title });
});

// ---------- 注册后按 IP 自助认领（2026-11-12） ----------
// 场景：游客没账号直接投稿（作品挂「匿名」、没有归属），之后在同一个出口注册了账号——
// 系统把「这个 IP 投的、还没有归属的作品」列出来问一句「这些是你投的吗」，
// 作者点确认就当场归属，不进审核队列，后台只留一条 channel='ip' 的已通过记录备查。
//
// 判据：投稿时记在作品上的 IP 指纹（work.submitIp）与本账号的注册 IP（user.regIp）/
// 当前请求 IP 的指纹一致。两者都是 ipKeyOf() 的哈希，不存明文 IP。
// 止损（出口 IP 会被公司/校园网/基站共用，不能当成铁证）：
//   · 单账号最多自助认领 5 件，同一出口 24h 内最多 8 件；
//   · 站长点过「关闭认领」的作品、已被别人挂了待审申请的作品，一律不参与；
//   · 每次确认都落一条记录（谁、什么时候、哪件、什么 IP），站长发现误认领可在后台改归属。
const IP_CLAIM_MAX_PER_USER = 5;
const IP_CLAIM_MAX_PER_IP_DAY = 8;
const IP_CLAIM_LIST_MAX = 5;   // 一次弹窗最多列几件：再多用户也没法一眼判断是不是自己的

function ipClaimIpKey(ip) {
  return crypto.createHash('sha256').update('ipclaim|' + ip).digest('hex').slice(0, 12);
}

// 当前账号 + 当前请求 IP 能对上的「无归属匿名作品」
function ipClaimCandidates(user, ipk) {
  const mine = new Set([user && user.regIp, ipk].filter(Boolean));
  if (!mine.size) return [];
  return works.filter(w => {
    if (w.userId) return false;                                  // 已经有归属了
    if (!w.submitIp || !mine.has(w.submitIp)) return false;      // 不是这个 IP 投的
    if (w.status === 'rejected') return false;                   // 被拒的作品别拿来送
    if (!isClaimable(w)) return false;                           // 站长关过认领的作品不给
    // 别人已经提交了认领申请：先不动，免得「点一下」把别人的待审申请顶掉、变成抢作品
    if (claims.some(c => c.workId === w.id && c.status === 'pending')) return false;
    return true;
  }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

// 弹窗候选：注册/登录后前端拉一次。已经答过（认了或说了「不是我的」）就不再打扰。
app.get('/api/claim/ip-candidates', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.ipClaimAnsweredAt) return res.json({ ok: true, answered: true, items: [] });
  if (!rateLimit('ipcand:' + user.id, 40, 3600000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const items = ipClaimCandidates(user, ipKeyOf(req)).slice(0, IP_CLAIM_LIST_MAX).map(w => ({
    id: w.id,
    title: w.title,
    thumb: w.thumb || w.image || '',
    createdAt: w.createdAt,
    stage: stageOf(w),
    status: w.status
  }));
  res.json({ ok: true, items });
});

// 确认认领：ids 只认服务端算出来的候选，客户端传什么都不信（会重新核一遍 IP）
app.post('/api/claim/ip-claim', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('ipclaim:' + user.id, 8, 3600000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const ip = clientIp(req);
  const ipKey = ipClaimIpKey(ip);
  const usedByMe = claims.filter(c => c.channel === 'ip' && c.userId === user.id).length;
  const usedByIp = claims.filter(c => c.channel === 'ip' && c.ipKey === ipKey
    && Date.now() - new Date(c.createdAt).getTime() < 864e5).length;
  if (usedByMe >= IP_CLAIM_MAX_PER_USER) {
    return res.status(400).json({ error: `一个账号最多自助认领 ${IP_CLAIM_MAX_PER_USER} 件，剩下的请在「意见建议」里联系站长核对` });
  }
  if (usedByIp >= IP_CLAIM_MAX_PER_IP_DAY) {
    return res.status(429).json({ error: '这个网络今天已经自助认领过几次了，剩下的请联系站长核对' });
  }
  const ids = Array.isArray(req.body && req.body.ids) ? new Set(req.body.ids.map(String)) : null;
  const budget = Math.min(IP_CLAIM_LIST_MAX, IP_CLAIM_MAX_PER_USER - usedByMe, IP_CLAIM_MAX_PER_IP_DAY - usedByIp);
  const targets = ipClaimCandidates(user, ipKeyOf(req))
    .filter(w => !ids || ids.has(w.id))
    .slice(0, Math.max(0, budget));
  if (!targets.length) return res.status(400).json({ error: '没有匹配到可认领的作品，刷新一下再试' });

  const now = new Date().toISOString();
  const done = [];
  targets.forEach(w => {
    // 先落记录再转账：后台认领页能看到是谁、什么时候、按哪个 IP 认的（不写作品标题以外的隐私）
    claims.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      workId: w.id,
      userId: user.id,
      username: user.username,
      channel: 'ip',
      status: 'approved',
      evidence: `按投稿 IP 自助认领：这件作品是匿名投的，投稿 IP 指纹与本账号的注册 IP 一致，`
        + `${user.username} 在登录/注册后点了确认「是我的」，系统当场归属（未走人工审核）。`
        + `出口 IP 可能被多人共用，如有疑问可在后台改归属。`,
      ip,
      ipKey,
      createdAt: now,
      handledAt: now,
      note: 'IP 自助认领 · 即时通过'
    });
    const r = finalizeClaimTransfer(w, user.id, user.username, 'claim');
    done.push({
      id: w.id,
      title: w.title,
      settledTips: r.settledTips || 0,
      osBonus: r.osBonus || 0,
      uploadReward: r.uploadReward ? r.uploadReward.amount : 0,
      uploadInstant: r.uploadReward ? r.uploadReward.instant : 0
    });
  });
  user.ipClaimAnsweredAt = now;
  saveUsers();
  saveWorksNow();   // 归属 + 发奖必须和记录同批落盘（saveWorks 是 300ms 合并，这里不等）
  const titles = done.map(d => `「${d.title}」`).join('、');
  const rewardTotal = done.reduce((s, d) => s + (d.uploadInstant || 0) + (d.osBonus || 0) + (d.settledTips || 0), 0);
  addNotice(user.id, {
    kind: 'system',
    title: `认领成功：${titles}已归到你名下`,
    text: `系统按投稿 IP 认出了你注册前投的作品，${titles}已经归到你名下：署名、数据看板、编辑与推广权限都已生效。`
      + (rewardTotal > 0 ? `这次一共到账 ${rewardTotal} 盏灯火（含上传奖励 / 开源奖励 / 匿名期间收到的打赏）。` : '')
      + `如果不是你投的，可以在页面底部「意见建议」里说明，站长会帮你撤回。`
  });
  res.json({ ok: true, claimed: done });
});

// 「都不是我的」：记一笔，以后不再弹
app.post('/api/claim/ip-dismiss', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  user.ipClaimAnsweredAt = new Date().toISOString();
  saveUsers();
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
  arrive: '每天来逛逛',
  visit: '分享链接带来访问',
  scan: '有人扫了你的分享码',
  reg: '好友通过你的链接注册',
  promo: '外宣里程碑奖励',
  upload: '上传作品奖励',
  claimbonus: '暗号认领额外奖励',
  os: '开源作品奖励',
  'os-recall': '开源奖励已收回',
  star: 'GitHub star 奖励',
  checkin: '每日签到',
  jar: '星星罐攒星',
  adreward: '看激励视频奖励',
  pwa: '添加到桌面奖励',
  wxbind: '绑定微信奖励',
  wxmerge: '合并账号：灯火取多的那份',
  gift: '站长激励',
  admin: '站长调整',
  tip_in: '收到打赏',
  tip_in_claim: '匿名期间收到的灯火归账',
  tipad_in: '有人看完广告为你的作品点灯',
  tip_out: '打赏给作者',
  lamp_out: '解锁作品',
  lamp_in: '作品被解锁',
  redeem: '换推荐位',
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
  // 近 7 天成绩单（看板顶部的账单卡）要用的两个字段：近 7 天独立访客（跨天去重）与全站排名。
  // 排名对所有未删除作品统一算一遍（几十件、开销可忽略），不能只在作者自己的作品里排；
  // active7 = 近 7 天有曝光的作品数，用来给「超过 X% 的作品」当分母口径。
  const days7 = days.slice(-7);
  const board7 = works.filter(w => !w.deleted)
    .map(w => {
      const rec = workVisits[w.id] || {};
      let p = 0;
      days7.forEach(k => { const x = (rec.days || {})[k]; if (x) p += x.pv || 0; });
      return { id: w.id, pv7: p };
    })
    .sort((a, b) => b.pv7 - a.pv7);
  const active7 = board7.filter(x => x.pv7 > 0).length;
  const rank7Map = new Map();
  board7.forEach((r, i) => rank7Map.set(r.id, { rank: i + 1, total: board7.length, active: active7 }));
  const items = mine.map(w => {
    const rec = workVisits[w.id] || {};
    const trend = days.map(k => (rec.days && rec.days[k] && rec.days[k].pv) || 0);
    // 近 7 天 UV：把 7 天里每天的 uv 集合并起来再数（跨天去重，和账单原型同口径）
    const uv7set = new Set();
    days7.forEach(k => { const x = (rec.days || {})[k]; if (x) Object.keys(x.uv || {}).forEach(u => uv7set.add(u)); });
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
      uv7: uv7set.size,
      rank7: rank7Map.get(w.id) || null,   // { rank, total, active }：近 7 天全站排名（账单卡用）
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
  // 首页「随便逛逛」：曝光（批量 ids）与详情点击。按「人」去重，口径见 docs/discover-spec-v1.md。
  // 模块展示没开（阶段 1）也照常记录：先攒数据，阶段 2 开权重时才有 CTR 可算。
  if (action === 'expo') return res.json(recordExpo(req, body));
  if (action === 'expoClick') return res.json(recordExpoClick(req, body));
  if (action) {
    if (wid) trackWorkAction(req, wid, action, String(body.type || ''));
    return res.json({ ok: true });
  }
  // site:false → 只记作品维度，不重复计站点 PV（弹窗打开作品时用）
  // platform:'mini' → 小程序来源：站点 PV/UV 存独立分桶，作品维度按 deviceId 去重
  const platform = body.platform === 'mini' ? 'mini' : 'web';
  const deviceId = platform === 'mini' && /^[A-Za-z0-9_-]{6,64}$/.test(String(body.deviceId || ''))
    ? String(body.deviceId) : '';
  // 网页 / H5 / App webview 的本机标识（前端 dm_vid，和广告计费同一个值）。
  // 只用来认「人」，不参与限频（限频仍按 IP）；格式校验跟前端生成规则一致。
  const webVid = platform === 'web' && /^[A-Za-z0-9_-]{8,40}$/.test(String(body.vid || ''))
    ? String(body.vid) : '';
  const opts = { platform, deviceId, vid: webVid };
  // 流量构成：ref 是前端传的 document.referrer（来源页），entry 表示这是本次打开的第一屏。
  // 都只是画像维度，缺了不影响 PV/UV 计数。
  opts.path = p;
  opts.ref = String(body.ref || '').slice(0, 300);
  opts.entry = body.entry === true;
  // 站点 PV/UV 只认真人浏览器：和作品浏览（trackWorkVisit）同一道 UA 闸——
  // curl / python 脚本没有正常浏览器 UA，deviceOf 识别出的爬虫（含 headless）也拦下，
  // 两关都过才进站点统计，页脚「今日 / 累计」的数字就是真实访问口径。
  // 叠加已有的防刷：单接口 900 次/小时限频、单访客单日 PV 计 50 次封顶、排除名单事后扣除。
  const uaOk = /Mozilla|Chrome|Safari|Firefox|Edg|MicroMessenger/i.test(String(req.headers['user-agent'] || ''));
  if (body.site !== false && uaOk && deviceOf(req, false) !== 'bot') trackVisit(req, opts);
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
  // 灯火解锁的作品：短链不能当免费入口——扫码一律回站内详情页，页面上有解锁按钮
  if (w.paidModel === 'lamp') {
    recordScan(req, w, hit.t === 'detail' ? '详情页' : (hit.t === 'site' ? '官网' : hit.t), ref);
    const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
    return res.redirect(302, siteOrigin(req) + '/w/' + encodeURIComponent(w.id) + q);
  }
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

// ---------- 外链出口网关 /out/<workId>?k=<key> ----------
// 作品详情页（弹窗 + 服务端 SEO 页）的外链都从这里 302 跳出去：
//  · 防 SEO 权重外泄：落地页外链不再是直链，nofollow 跟着跳转链传下去
//  · 域名黑名单：已知钓鱼/恶意站点直接拦下（data/outlink-block.json，可选文件手工维护）
//  · 点击留痕：data/outlink-clicks.log 按行追加，作者/站长能对出「这个链接真的被点过几次」
//  · 不收任意 URL：k 是链接的键名（repo/site/link/形态名），真实地址永远从作品数据里现查，
//    作者改了链接也立刻生效，同时天然杜绝开放重定向（?u= 任意网址那种钓鱼温床）
const OUT_BLOCK_FILE = 'data/outlink-block.json';
let outBlockCache = { at: 0, hosts: new Set() };
function outBlockedHosts() {
  if (Date.now() - outBlockCache.at > 60000) {
    // 两种写法都认：{"hosts":["a.com","b.com"]}（推荐，以后好扩展字段）或纯 ["a.com","b.com"]
    const raw = readJSON(OUT_BLOCK_FILE.replace(/^data\//, ''), {});
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.hosts) ? raw.hosts : []);
    const list = arr
      .map(s => String(s || '').trim().toLowerCase().replace(/^www\./, ''))
      .filter(Boolean);
    outBlockCache = { at: Date.now(), hosts: new Set(list) };
  }
  return outBlockCache.hosts;
}
// 内网/保留地址一律不放行：防止网关被拿来生成「看似本站、实则跳内网」的链接
function outHostBad(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '[::1]' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some(x => x > 255)) return true;
    if (o[0] === 127 || o[0] === 10 || o[0] === 0 || o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
  }
  return outBlockedHosts().has(h.replace(/^www\./, ''));
}
function outMissingPage(msg) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${msg}</title>
<style>body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f7fb;color:#374151}main{text-align:center;padding:32px}b{font-size:18px}p{color:#9aa3b2;font-size:14px}a{color:#6366f1}</style></head>
<body><main><b>${msg}</b><p><a href="/">返回造梦橱窗</a></p></main></body></html>`;
}
function outClickLog(rec) {
  try { require('fs').appendFile(OUT_BLOCK_FILE.replace('outlink-block.json', 'outlink-clicks.log'), JSON.stringify(rec) + '\n', () => {}); } catch { /* 日志失败不影响跳转 */ }
}
app.get('/out/:workId', (req, res) => {
  if (!rateLimit('out:' + clientIp(req), 240, 3600e3)) return res.status(429).type('html').send(outMissingPage('请求太频繁，稍后再试'));
  const id = String(req.params.workId || '').slice(0, 40);
  const k = String(req.query.k || '').trim().slice(0, 30);
  const w = works.find(x => x.id === id);
  if (!w || !isVisible(w)) return res.status(404).type('html').send(outMissingPage('作品不存在或还没上线'));
  let url = '';
  if (k === 'repo') url = w.repo || '';
  else if (k === 'site') url = w.site || '';
  else if (k === 'link') url = w.link || '';
  else if (k && w.links) url = w.links[k] || '';
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(404).type('html').send(outMissingPage('这个链接不存在或已失效'));
  let host = '';
  try { host = new URL(url).hostname; } catch { return res.status(404).type('html').send(outMissingPage('这个链接不存在或已失效')); }
  if (outHostBad(host)) return res.status(403).type('html').send(outMissingPage('这个链接已被拦截，如果你认为它没问题请联系站长'));
  outClickLog({ ts: new Date().toISOString(), workId: id, k, host });
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
});

// ---------- 后台「外链点击」看板 ----------
// 数据源就是上面 /out 网关按行追写的 outlink-clicks.log（{ts,workId,k,host}），不再另开一份计数。
// 只做增量解析：文件只会往后加，记住已读字节数，下次只读新尾巴；被清空或轮转（size 变小）就从头来。
// 两条口径（页面文案同步写死，免得以后自己看不懂）：
//  1) 这是「真的跳出去了」的次数，点一次记一次，不按人去重；
//  2) 网关 2026-11-12 才上线，之前外链是直链、服务端看不到，所以更早的日子没有数。
//     以前拿 work-actions 的按钮点击做过「历史近似」，口径不同（含「点了没跳出去」），2026-11-12 起不再在后台展示。
const OUT_LOG_MAX_ROWS = 200000;
const outLog = { file: '', size: 0, rows: [], partial: '', capped: false, head: '' };
function outLogPath() {
  // 网关写的是相对 cwd 的 data/；DATA_DIR 允许被环境变量挪到别处，两个位置都认，取最近写入的那个
  let best = '', at = -1;
  for (const p of [fileOf('outlink-clicks.log'), path.resolve('data/outlink-clicks.log')]) {
    try { const st = fs.statSync(p); if (st.mtimeMs > at) { at = st.mtimeMs; best = p; } } catch { /* 没有就换下一个 */ }
  }
  return best;
}
function loadOutClicks() {
  const file = outLogPath();
  if (!file) return outLog.rows;
  if (file !== outLog.file) { outLog.file = file; outLog.size = 0; outLog.rows = []; outLog.partial = ''; outLog.capped = false; outLog.head = ''; }
  let st;
  try { st = fs.statSync(file); } catch { return outLog.rows; }
  // 首行指纹：日志被 logrotate / 手工重写时 size 可能不减反增，只比大小会把旧数据和新数据串在一起。
  // 正常追加时首行永远不变，这道校验零成本；变了就整份重来。
  let head = '';
  try {
    const fd0 = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(200); const n = fs.readSync(fd0, b, 0, 200, 0); head = b.slice(0, n).toString('utf8'); } finally { fs.closeSync(fd0); }
  } catch { /* 读不到就按大小判断 */ }
  if (head && outLog.head && head !== outLog.head) { outLog.size = 0; outLog.rows = []; outLog.partial = ''; outLog.capped = false; }
  outLog.head = head;
  if (st.size < outLog.size) { outLog.size = 0; outLog.rows = []; outLog.partial = ''; outLog.capped = false; }
  if (outLog.capped || st.size === outLog.size) return outLog.rows;
  try {
    const len = st.size - outLog.size;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, outLog.size); } finally { fs.closeSync(fd); }
    outLog.size = st.size;
    const parts = (outLog.partial + buf.toString('utf8')).split('\n');
    outLog.partial = parts.pop() || '';        // 最后可能是没写完的半行，留到下次
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!r || !r.ts || !r.workId) continue;
        outLog.rows.push({ ts: String(r.ts), workId: String(r.workId), k: String(r.k || ''), host: String(r.host || '') });
      } catch { /* 脏行/半行跳过，不影响其余统计 */ }
    }
    if (outLog.rows.length > OUT_LOG_MAX_ROWS) {
      outLog.rows = outLog.rows.slice(-OUT_LOG_MAX_ROWS);
      outLog.capped = true;                    // 保险丝：到这个量级该换真正的时序库了
    }
  } catch { /* 读不出来就按已有数据出页面，跳转本身不受影响 */ }
  return outLog.rows;
}
// k 的取值来自作品 links 的键名（作者自己起的名，如 Web / 小程序）或固定键 repo/site/link
const OUT_KIND_LABEL = { repo: '源码仓库', site: '官网', link: '作品链接' };
const outKindLabel = k => OUT_KIND_LABEL[k] || (k || '未标注');

// 只读聚合，不改任何数据；后台每次切到「外链点击」拉一次
app.get('/api/admin/outlinks', requireAdmin, (req, res) => {
  const rows = loadOutClicks();
  const today = dateKey();
  const now = Date.now();
  const DAY = 86400000;
  const sum = { today: 0, d7: 0, d30: 0, total: rows.length };
  const byDayMap = new Map(), byKindMap = new Map(), byHostMap = new Map(), byWorkMap = new Map(), byLinkMap = new Map();
  // 完整链接还原：日志里只有 {workId,k,host}（/out 网关设计如此，真实地址永远现查），
  // 这里用和网关完全相同的取值规则把 workId+k 还原成完整 URL 再分组，
  // 「github.com 16 次」才能落到「github.com/某某/某仓库」。
  // 注意：作者是改过链接的，还原按当前作品数据算——改之前的点击会归到新地址，页面文案里说清这一点。
  const workIndex = new Map(works.filter(w => !w.deleted).map(w => [w.id, w]));
  rows.forEach(r => {
    const d = dateKey(new Date(r.ts));
    const age = now - (Date.parse(r.ts) || 0);
    if (d === today) sum.today++;
    if (age <= 7 * DAY) sum.d7++;
    if (age <= 30 * DAY) sum.d30++;
    byDayMap.set(d, (byDayMap.get(d) || 0) + 1);
    byKindMap.set(r.k, (byKindMap.get(r.k) || 0) + 1);
    byHostMap.set(r.host || '', (byHostMap.get(r.host || '') || 0) + 1);
    const w = byWorkMap.get(r.workId) || { id: r.workId, total: 0, kinds: {}, hosts: {}, firstAt: '', lastAt: '' };
    w.total++;
    w.kinds[r.k] = (w.kinds[r.k] || 0) + 1;
    w.hosts[r.host || ''] = (w.hosts[r.host || ''] || 0) + 1;
    if (!w.firstAt || r.ts < w.firstAt) w.firstAt = r.ts;
    if (!w.lastAt || r.ts > w.lastAt) w.lastAt = r.ts;
    byWorkMap.set(r.workId, w);
    // 按完整 URL 分组（还原失败——作品已删/链接已改没——就退回「域名+类型」占位，不丢次数）
    let lurl = '', lhost = r.host || '';
    const lw = workIndex.get(r.workId);
    if (lw) {
      let u = '';
      if (r.k === 'repo') u = lw.repo; else if (r.k === 'site') u = lw.site; else if (r.k === 'link') u = lw.link;
      else if (r.k && lw.links) u = lw.links[r.k];
      u = String(u || '').trim();
      if (/^https?:\/\//i.test(u)) {
        try { lurl = u; lhost = new URL(u).hostname; } catch { lurl = ''; }
      }
    }
    const lkey = lurl || '\u0000' + (r.host || '') + '\u0000' + r.workId + '\u0000' + r.k;
    const le = byLinkMap.get(lkey) || { url: lurl, host: lhost, workId: r.workId, k: r.k, n: 0 };
    le.n++;
    byLinkMap.set(lkey, le);
  });
  const byWork = [...byWorkMap.values()].map(w => {
    const rec = workIndex.get(w.id);
    return {
      id: w.id,
      title: rec ? String(rec.title || '') : '',
      status: rec ? String(rec.status || '') : 'gone',
      total: w.total,
      kinds: Object.entries(w.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, label: outKindLabel(k), n })),
      hosts: Object.entries(w.hosts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([host, n]) => ({ host, n })),
      lastAt: w.lastAt,
      // 详情页累计浏览（work-visits.pv），给「每 100 次浏览跳出几次」当分母；0 时前端不显示比值
      pv: (workVisits[w.id] && Number(workVisits[w.id].pv)) || 0
    };
  }).sort((a, b) => b.total - a.total);
  const byDay = [...byDayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, n]) => ({ d, n }));

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    sum,
    byDay,
    byWork,
    byKind: [...byKindMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, label: outKindLabel(k), n })),
    byHost: [...byHostMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([host, n]) => ({ host, n })),
    // 完整链接榜：地址按当前作品数据还原（作者改链接后按新地址归组），还原不了的只剩域名
    byLink: [...byLinkMap.values()].sort((a, b) => b.n - a.n).slice(0, 12).map(e => {
      const rec = workIndex.get(e.workId);
      return { url: e.url, host: e.host, workId: e.workId, title: rec ? String(rec.title || '') : '', k: e.k, label: outKindLabel(e.k), n: e.n };
    }),
    recent: rows.slice(-60).reverse().map(r => {
      const rec = workIndex.get(r.workId);
      return { ts: r.ts, workId: r.workId, title: rec ? String(rec.title || '') : '', k: r.k, label: outKindLabel(r.k), host: r.host };
    }),
    firstAt: rows.length ? rows[0].ts : '',
    lastAt: rows.length ? rows[rows.length - 1].ts : '',
    capped: outLog.capped
  });
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
// 只给词和热度，不带任何人的信息；榜单固定 12 条（9 条种子随机 + 3 条近期真被搜过的，见 hotSearches）。
// 11-13 二改：真火词不再插队占前排——种子词被点一次就是一条真实搜索，会给它特权等于循环自我放大。
// roll=1：换一换按钮用，丢掉这一批重新抽（种子词和人数都会变），所以不能走浏览器缓存
app.get('/api/search/hot', (req, res) => {
  const roll = req.query.roll === '1';
  if (roll) hotSearchCache = { at: 0, items: null };
  res.setHeader('Cache-Control', roll ? 'no-store' : 'public, max-age=60');
  res.json(hotSearches(12));
});

// 想法池的聚合口径（总数 / 已实现 / 正在做 / 征集中 / 本周新增 + 「愿望成真」Top6）。
// /api/ideas 与 /api/bar/feed 共用这一份：两个口子各算一套，数字对不上很容易被当成 bug。
function ideaBoardMeta(visible) {
  const now = Date.now();
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
  return { stats, doneList };
}

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
  const { stats, doneList } = ideaBoardMeta(visible);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    total: list.length,
    items: sorted.slice(0, limit).map(i => publicIdea(i, req, user)),
    stats, doneList
  });
});

// 酒馆时间线：想法 + 闲聊合并成一条流，按时间倒序、游标翻页。
// 为什么不在前端各拉两份再归并：两路各自翻页时，新到的一页里会有「比已渲染的某条更早、
// 但又比另一路更晚」的条目，只能插进已渲染段落中间 → 前端每次翻页都得整表重绘，
// 列表越长越卡；想法那边还卡着 limit≤60，翻到 60 条就再也翻不动（点了没反应）。
// 这里给一条统一的流，前端只管把新一页 append 到列表尾部，位置天然正确。
// 游标带上 id：时间戳完全相同的两条也不会被跳过或重复。
function feedCursorOf(at, id) { return `${at}|${id}`; }
function feedCursorParse(s) {
  const raw = String(s || '').trim();
  const k = raw.lastIndexOf('|');
  return k < 0 ? { at: raw, id: '' } : { at: raw.slice(0, k), id: raw.slice(k + 1) };
}

app.get('/api/bar/feed', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = currentUser(req);
  const limit = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 20));
  // 话题模式只出闲聊：想法跟话题无关，混进来只会让「这个话题下」名不副实
  const tag = String(req.query.tag || '').trim().slice(0, BAR_TAG_LEN_MAX).toLowerCase();
  const cur = req.query.before ? feedCursorParse(req.query.before) : null;
  const curAt = cur ? new Date(cur.at).getTime() : 0;
  const curId = cur ? cur.id : '';

  const visIdeas = ideas.filter(i => !i.hidden);
  const visPosts = barPosts.filter(p => !p.hidden &&
    (!tag || barTagsOf(p.text).some(t => t.toLowerCase() === tag)));

  const rows = [];
  if (!tag) visIdeas.forEach(i => rows.push({ kind: 'idea', at: i.createdAt, id: i.id, raw: i }));
  visPosts.forEach(p => rows.push({ kind: 'chat', at: p.createdAt, id: p.id, raw: p }));
  // 时间倒序；同一时刻按 id 倒序兜底，保证「游标翻页不重不漏」
  rows.sort((a, b) => (new Date(b.at) - new Date(a.at)) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const rest = curAt
    ? rows.filter(r => { const t = new Date(r.at).getTime(); return t < curAt || (t === curAt && r.id < curId); })
    : rows;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];

  // 剩余还有多少「想法」，随每页一起给：想法少的时候它们会被几十句闲聊压到很后面，
  // 前端靠这个在「加载更早的」按钮上明说「还有 1 条想法」，而不是让人盲点翻页（11-14）
  const left = { ideas: 0, chats: 0 };
  rest.slice(limit).forEach(r => { if (r.kind === 'idea') left.ideas++; else left.chats++; });

  const out = {
    items: page.map(r => r.kind === 'idea'
      ? { kind: 'idea', at: r.at, id: r.id, idea: publicIdea(r.raw, req, user) }
      : { kind: 'chat', at: r.at, id: r.id, post: publicBarPost(r.raw, req, user) }),
    next: (last && page.length === limit) ? feedCursorOf(last.at, last.id) : '',
    total: { ideas: tag ? 0 : visIdeas.length, chats: visPosts.length },
    left
  };
  // 统计与「愿望成真」只在第一页带：翻页时前端已经拿到了，重复算一遍是白烧 CPU
  if (!cur) Object.assign(out, ideaBoardMeta(visIdeas));
  res.json(out);
});

// ---------- 造梦酒馆 · 近7日热门 / 专栏书架 ----------
// 为什么单开一个接口：酒馆原来只服务「有想法要提的人」，普通访客（不投稿也不许愿）
// 进来只有一片需求池，没有可读、可追更的东西。这里把「最近有什么好看的」一次取齐，
// 首屏不用排两次队；两块共用一份数据，口径也只有一个。（周刊一行 2026-11-12 已整体下线）

app.get('/api/bar/board', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const user = currentUser(req);
  const visIdeas = ideas.filter(i => !i.hidden);
  const pool = publicWorks(req);              // 已排除隐藏 / 被屏蔽
  const visIds = new Set(pool.map(w => w.id));

  // 2026-11-13 站长定稿：热门只放两类——想法（还在征集的）和散座帖子。
  // 作品不再进热门：它有自己的综合榜，热门区再放一遍是同质内容；
  // 闲聊可以关联一件已上架作品，卡片上带出产品入口（发帖时选，读的时候现解析，
  // 作品下架/隐藏了自然消失，存量不用清）。
  // 想法热度：想要数按 14 天衰减——与 /api/ideas?sort=week 同一套公式，两处别各算一份
  const ideaHeat = i => (i.wants || 0) /
    (1 + Math.max(0, now - new Date(i.createdAt).getTime()) / 86400e3 / 14);
  const topIdeas = visIdeas.filter(i => (i.status || 'open') !== 'done' && !i.workId)
    .sort((a, b) => ideaHeat(b) - ideaHeat(a)).slice(0, 3);

  // 散座热度：barPostHeat 本身带 48 小时衰减，老帖子自然沉底；再卡一道 7 天窗口
  // 贴合「近7日」的标题——真没人说话就少放几条，宁短勿凑。
  const ws = now - 7 * 86400e3, we = now;
  const inWeek = t => { const v = new Date(t || 0).getTime(); return v >= ws && v < we; };
  const hotChats = barPosts.filter(p => !p.hidden && inWeek(p.createdAt))
    .sort((a, b) => (barPostHeat(b) - barPostHeat(a)) || (new Date(b.createdAt) - new Date(a.createdAt)))
    .slice(0, 3);
  const workOfPost = p => {
    const w = works.find(x => x.id === p.workId);
    return (w && visIds.has(w.id)) ? { id: w.id, title: w.title || '' } : null;
  };

  const hot = [];
  const pushIdea = i => i && hot.push({
    kind: 'idea', id: i.id, title: i.title,
    meta: `${i.wants || 0} 人想要 · 还在征集`, thumb: ''
  });
  const pushChat = p => p && hot.push({
    kind: 'chat', id: p.id,
    title: String(p.text || '').replace(/^\s+|\s+$/g, ''),
    meta: `${barPostLikes(p).length} 人碰杯 · ${barPostReplies(p).filter(r => !r.hidden).length} 条回应`,
    thumb: '',
    work: workOfPost(p)
  });
  // 分开摆（2026-11-13 站长定的，替代原来的「想法/闲聊交错」）：想要的归想要的、闲聊的归闲聊。
  // 本处 push 顺序只是数据顺序，展示顺序（闲聊在上、想法在下）由前端 renderBarHot 按 kind 分组决定；
  // 组内仍是热度优先，顺序固定不随机，便于二次找。
  topIdeas.forEach(pushIdea);
  hotChats.forEach(pushChat);

  // 周刊口径（周区间计数 / ISO 周号 / 按语）已随周刊一行整体下线（2026-11-12）

  // 书架：站方编辑挑的专栏（/column 前 4 个主题）+ 两个专题页。
  // 只放 6 个，是「书架最上面一排」不是导航大全；看全部还有 /column 兜着。
  const cols = (columnsData().topics || []);
  const shelf = cols.slice(0, 4).map(t => ({
    title: t.title, sub: t.subtitle || '', href: '/column/' + encodeURIComponent(t.slug),
    n: (t.items || []).length
  })).concat([
    { title: '小程序专栏', sub: '浏览器打不开的，扫码直接用', href: '/mini', n: 0 },
    { title: '开源好物', sub: 'GitHub 上能直接读源码的', href: '/open', n: 0 }
  ]);

  res.json({
    hot,
    shelf
  });
});

// ---------- 造梦酒馆 · 散座（随便聊） ----------
// 为什么不并进 ideas.json：想法池是创作者的信号源，「N 人想要」必须是真的需求；
// 闲聊一旦混进同一个列表，信号立刻被水贴稀释。散座放开聊、吧台只说需求，两条账各算各的。
// 认人口径跟「想要」共用 ideaWantKey（登录按账号、未登录按网络），碰杯-取消-再碰杯不会刷数。
const BAR_POST_TEXT_MAX = 200;
const BAR_POST_REPLY_MAX = 140;
const BAR_POST_KEEP_MAX = 3000;

// ---------- 散座话题（正文里的 #话题） ----------
// 话题不落库：`#话题` 本身就是分类，读的时候现解析。这样老帖子里的标签自动就认，
// 不用迁移数据；改错一个字也不会留下一条错账。
// 写法跟微博/小红书对齐（站长 2026-11-13 定的）：单个 # + 话题名，空格收尾就算一个话题；
// 常见标点也算收尾（「#AI绘画，真好玩」别把整句吞成话题），话题名直接写到句末同样算。
// 防刷屏口径不变：标签 1~20 字、内部不能有空格和 #，一条正文最多认 3 个，第 4 个起当普通文字。
const BAR_TAG_MAX = 3;
const BAR_TAG_LEN_MAX = 20;
// 能「收尾」一个话题的字符：空白、#、常见中英标点（不吞收尾符，正文照常渲染）
const BAR_TAG_STOP = '\\s#，。！？、；：·「」『』（）【】《》,.;:!?"\'()\\[\\]{}<>';
const BAR_TAG_RE_SRC = '#([^' + BAR_TAG_STOP + ']{1,20})(?=[' + BAR_TAG_STOP + ']|$)';
function barTagsOf(text) {
  const out = [];
  const s = String(text || '');
  if (s.indexOf('#') < 0) return out;
  const re = new RegExp(BAR_TAG_RE_SRC, 'g');
  let m;
  while ((m = re.exec(s)) && out.length < BAR_TAG_MAX) {
    const t = m[1].trim();
    // 去重不分大小写：`#AI#` 和 `#ai#` 是同一个话题，不然话题会被拆成两份
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
// 「开个话题」的姿势：整条正文除了标签一个字都没有（截图里那种只发一个 #xxx）
function barIsTopicStart(text) {
  const s = String(text || '');
  if (!barTagsOf(s).length) return false;
  const rest = s.replace(new RegExp(BAR_TAG_RE_SRC, 'g'), '');
  return !/[\p{L}\p{N}]/u.test(rest);
}
let barPosts = readJSON('bar-posts.json', []);
if (!Array.isArray(barPosts)) barPosts = [];
function saveBarPosts() {
  if (barPosts.length > BAR_POST_KEEP_MAX) barPosts.length = BAR_POST_KEEP_MAX;
  writeJSON('bar-posts.json', barPosts);
}
function barPostById(id) { return barPosts.find(p => p.id === id) || null; }
// 老数据/手改数据里 likes、replies 可能是缺字段的，统一在取用时兜底，别到处写 Array.isArray
function barPostLikes(p) { return Array.isArray(p.likes) ? p.likes : (p.likes = []); }
function barPostReplies(p) { return Array.isArray(p.replies) ? p.replies : (p.replies = []); }
// 热度：碰杯算 2、回应算 3（回应成本更高，说明这话题真有人接），按 48 小时衰减
function barPostHeat(p) {
  const like = barPostLikes(p).length;
  const reply = barPostReplies(p).filter(r => !r.hidden).length;
  const ageH = Math.max(0, Date.now() - new Date(p.createdAt).getTime()) / 3600e3;
  return (like * 2 + reply * 3) / (1 + ageH / 48);
}
function publicBarPost(p, req, user) {
  const key = ideaWantKey(req, user);
  const likes = barPostLikes(p);
  const replies = barPostReplies(p).filter(r => !r.hidden);
  return {
    id: p.id,
    author: displayNameOf(p.author || '匿名'),
    text: p.text || '',
    // 话题由正文现解析（见 barTagsOf），前端拿到就能画标签，不用自己再猜一遍规则
    tags: barTagsOf(p.text),
    topicStart: barIsTopicStart(p.text),
    mine: !!(user && p.userId && p.userId === user.id),
    likes: likes.length,
    liked: likes.includes(key),
    replyCount: replies.length,
    createdAt: p.createdAt,
    // 关联的作品（发帖时选的）：读的时候现解析，下架/隐藏/被屏蔽了就自然消失，存量不用清
    work: (() => {
      if (!p.workId) return null;
      const w = works.find(x => x.id === p.workId);
      return (w && publicWorks(req).some(x => x.id === w.id))
        ? { id: w.id, title: w.title || '' } : null;
    })(),
    // 楼层只回最近 20 条：闲聊不是论坛，翻到第 100 楼的需求不存在
    replies: replies.slice(-20).map(r => ({
      id: r.id, author: displayNameOf(r.author || '匿名'), text: r.text || '', at: r.at,
      mine: !!(user && r.userId && r.userId === user.id)
    }))
  };
}

/* ===== 小程序「散座」只读（2026-11-14）=====
   微信审核口径：小程序端不提供任何发布 / 点赞 / 回复入口，只展示站长人工挑过的闲聊。
   白名单放 content/bar-mini.json（进部署包），按 mtime 热加载，改文件不用重启。
   刻意不做「自动下发最新 N 条」：线上随时有人发帖，没经过人眼的内容不该出现在审核员面前。
   下发字段也刻意裁掉作者、点赞数、楼层——小程序这边只认「一段话 + 话题 + 时间」，
   连身份痕迹都不给，才不像 UGC 社区。网页端不受影响，照旧是完整的散座。 */
const BAR_MINI_FILE = path.join(__dirname, 'content', 'bar-mini.json');
let barMiniCache = null;
function barMiniIds() {
  try {
    const st = fs.statSync(BAR_MINI_FILE);
    if (!barMiniCache || barMiniCache.mtime !== st.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(BAR_MINI_FILE, 'utf-8'));
      const ids = (raw && Array.isArray(raw.ids)) ? raw.ids.map(String) : [];
      barMiniCache = { mtime: st.mtimeMs, ids };
    }
  } catch { barMiniCache = { mtime: 0, ids: [] }; }
  return barMiniCache.ids;
}

app.get('/api/bar/mini', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const want = new Set(barMiniIds());
  const items = barPosts
    .filter(p => !p.hidden && want.has(p.id))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 60)
    .map(p => ({
      id: p.id,
      text: p.text || '',
      tags: barTagsOf(p.text),
      at: p.createdAt
    }));
  res.json({ total: items.length, items });
});

// 举报：只读页面同样必须有投诉通道，微信对内容展示类也查这条。
// 不用登录（按 IP 限流），复用作品举报的 reports 通道，后台同一个列表处理。
app.post('/api/bar/posts/:id/report', (req, res) => {
  if (!rateLimit('report:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  }
  const p = barPosts.find(x => x.id === req.params.id && !x.hidden);
  if (!p) return res.status(404).json({ error: '这条闲聊不在了' });
  const { reason } = req.body || {};
  const REASONS = ['违法违规', '涉嫌侵权', '内容不当', '垃圾广告', '其他'];
  if (!REASONS.includes(reason)) return res.status(400).json({ error: '请选择举报原因' });
  reports.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    target: 'bar',
    workId: p.id,
    workTitle: '【散座】' + String(p.text || '').slice(0, 30),
    reason,
    description: '',
    contact: '',
    status: '待处理',
    createdAt: new Date().toISOString()
  });
  saveReports();
  res.status(201).json({ ok: true, message: '举报已提交，我们会尽快处理' });
});

// 话题一览：散座上方那排标签用它。数的是「这个话题下有多少句闲聊」，
// 按条数排、条数一样新的在前；最多 12 个，再多就不像酒馆像索引了。
app.get('/api/bar/tags', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const map = new Map();
  for (const p of barPosts) {
    if (p.hidden) continue;
    for (const t of barTagsOf(p.text)) {
      const k = t.toLowerCase();
      const cur = map.get(k);
      if (cur) {
        cur.n++;
        // 显示名跟最新那条走，免得早年的错别字一直挂在那儿
        if (new Date(p.createdAt) > new Date(cur.lastAt)) { cur.tag = t; cur.lastAt = p.createdAt; }
      } else {
        map.set(k, { tag: t, n: 1, lastAt: p.createdAt });
      }
    }
  }
  const items = [...map.values()]
    .sort((a, b) => (b.n - a.n) || (new Date(b.lastAt) - new Date(a.lastAt)))
    .slice(0, 12);
  res.json({ total: map.size, items });
});

app.get('/api/bar/posts', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = currentUser(req);
  // 按 id 点名取单条（/bar?p=xxx 深链用）：首屏列表装不下更老的帖子，深链不能只对前 15 条有效
  const onlyId = String(req.query.id || '').trim();
  if (onlyId) {
    const p = barPosts.find(x => x.id === onlyId && !x.hidden);
    return res.json({ total: p ? 1 : 0, items: p ? [publicBarPost(p, req, user)] : [], next: '' });
  }
  const sort = req.query.sort === 'hot' ? 'hot' : 'new';
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 8));
  const before = req.query.before ? new Date(req.query.before).getTime() : 0;
  // 话题筛选：只认「正文里的标签完全等于这个词」（不分大小写）。
  // 不做模糊匹配——点进一个话题就应该只看到这个话题的内容。
  const tag = String(req.query.tag || '').trim().slice(0, BAR_TAG_LEN_MAX).toLowerCase();
  const visible = barPosts.filter(p => !p.hidden &&
    (!tag || barTagsOf(p.text).some(t => t.toLowerCase() === tag)));
  let list = sort === 'new' && before
    ? visible.filter(p => new Date(p.createdAt).getTime() < before)
    : visible;
  list = list.slice().sort((a, b) => sort === 'hot'
    ? (barPostHeat(b) - barPostHeat(a)) || (new Date(b.createdAt) - new Date(a.createdAt))
    : new Date(b.createdAt) - new Date(a.createdAt));
  const items = list.slice(0, limit).map(p => publicBarPost(p, req, user));
  res.json({
    total: visible.length,
    items,
    next: items.length === limit ? items[items.length - 1].createdAt : ''
  });
});

app.post('/api/bar/posts', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('barpost:' + user.id, 12, 86400e3)) {
    return res.status(429).json({ error: '今天说得有点多了，明天再来聊' });
  }
  const text = String((req.body || {}).text || '').replace(/\s+/g, ' ').trim();
  if (text.length < 2) return res.status(400).json({ error: '至少写两个字' });
  if (text.length > BAR_POST_TEXT_MAX) {
    return res.status(400).json({ error: `最多 ${BAR_POST_TEXT_MAX} 字，说重点` });
  }
  if (hitSensitive(text)) return res.status(400).json({ error: '内容包含敏感词，改一下再发' });
  const wxCheck = await wechatMsgCheck(text, user.wechat && user.wechat.openid);
  if (wxCheck.pass === false) return res.status(400).json({ error: '内容未通过平台内容安全检测，改一下再发' });
  const ai = await aiReviewGate('造梦酒馆闲聊：' + text);
  if (ai.pass === false) {
    return res.status(400).json({ error: '内容疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，改一下再发' });
  }
  // 关联作品（选填）：支持作品页链接（含 /w/xxx 的完整 URL）或作品名全匹配。
  // 只认已上架的公开作品；解析不出来就明说，不悄悄丢掉——作者以为挂上了其实没挂，比拒绝更糟。
  const workRef = String((req.body || {}).workRef || '').trim().slice(0, 120);
  let workId = '';
  if (workRef) {
    const m = workRef.match(/\/w\/([A-Za-z0-9_-]+)/);
    const w = m
      ? works.find(x => x.id === m[1])
      : works.find(x => (x.title || '').trim().toLowerCase() === workRef.toLowerCase());
    if (!w || !publicWorks(req).some(x => x.id === w.id)) {
      return res.status(400).json({ error: '没找到这件作品（要已上架的）——可以粘贴作品页链接或填完整作品名，也可以留空' });
    }
    workId = w.id;
  }
  const now = new Date().toISOString();
  const p = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: user.id,
    author: user.username,
    text,
    workId,
    likes: [],
    replies: [],
    hidden: false,
    createdAt: now,
    updatedAt: now
  };
  barPosts.unshift(p);
  saveBarPosts();
  res.status(201).json(publicBarPost(p, req, user));
});

// 碰杯：要登录。匿名也能碰的话，一个脚本就能把一条闲聊刷成「热门」
app.post('/api/bar/posts/:id/like', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const p = barPostById(req.params.id);
  if (!p || p.hidden) return res.status(404).json({ error: '这条已经不在了' });
  const likes = barPostLikes(p);
  const key = ideaWantKey(req, user);
  const i = likes.indexOf(key);
  if (i >= 0) likes.splice(i, 1); else likes.push(key);
  saveBarPosts();
  res.json({ likes: likes.length, liked: i < 0 });
});

app.post('/api/bar/posts/:id/reply', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const p = barPostById(req.params.id);
  if (!p || p.hidden) return res.status(404).json({ error: '这条已经不在了' });
  if (!rateLimit('barreply:' + user.id, 40, 86400e3)) {
    return res.status(429).json({ error: '今天回得有点多了，歇一会儿' });
  }
  const text = String((req.body || {}).text || '').replace(/\s+/g, ' ').trim();
  if (text.length < 1) return res.status(400).json({ error: '说一句再发' });
  if (text.length > BAR_POST_REPLY_MAX) return res.status(400).json({ error: `最多 ${BAR_POST_REPLY_MAX} 字` });
  if (hitSensitive(text)) return res.status(400).json({ error: '内容包含敏感词，改一下再发' });
  const wxCheck = await wechatMsgCheck(text, user.wechat && user.wechat.openid);
  if (wxCheck.pass === false) return res.status(400).json({ error: '内容未通过平台内容安全检测，改一下再发' });
  const ai = await aiReviewGate('造梦酒馆闲聊回应：' + text);
  if (ai.pass === false) {
    return res.status(400).json({ error: '内容疑似违规' + (ai.reason ? '：' + ai.reason : '') + '，改一下再发' });
  }
  const replies = barPostReplies(p);
  if (replies.length >= 100) return res.status(400).json({ error: '这条回复太多了，换个地方聊吧' });
  replies.push({
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: user.id,
    author: user.username,
    text,
    hidden: false,
    at: new Date().toISOString()
  });
  p.updatedAt = new Date().toISOString();
  saveBarPosts();
  // 有人接话了要给帖子作者一声（2026-11-13）：以前酒馆只有卡片上那个 💬 数字在悄悄涨，
  // 帖子沉下去以后本人永远不知道自己被回了什么。自己回自己的楼不通知。
  // 同一帖一小时最多一条（key 按小时分桶）——热帖一晚上能攒十几句，逐条弹会把铃铛淹了。
  if (p.userId && p.userId !== user.id) {
    const brief = text.length > 60 ? text.slice(0, 60) + '…' : text;
    addNotice(p.userId, {
      kind: 'bar-reply',
      key: `bar-reply:${p.id}:${Math.floor(Date.now() / 3600e3)}`,
      title: '有人回应了你的闲聊',
      text: `${displayNameOf(user.username)}：${brief}`,
      link: '/bar?p=' + encodeURIComponent(p.id)
    });
  }
  res.status(201).json(publicBarPost(p, req, user));
});

// 删除：只有本人和管理员。站长在后台没有这块的界面，先给接口留口子，别让人删不掉自己的话
app.delete('/api/bar/posts/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const p = barPostById(req.params.id);
  if (!p) return res.status(404).json({ error: '这条已经不在了' });
  if (p.userId !== user.id && !isAdmin(req)) return res.status(403).json({ error: '只能删自己说的' });
  barPosts = barPosts.filter(x => x.id !== p.id);
  saveBarPosts();
  res.json({ ok: true });
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
  // 纯点击包的兑换位（订单只买点击、没买曝光）标 clickBased：
  // 前端据此做「点过 1 次、本机不再推」的频控——点开过作品的人不用再看这条，
  // 额度自动留给没看过的新访客。展示包 / 运营广告恒为 false（看一眼就走不该终结投放）。
  // 口径与 redeemAdAlive 一致：找不到订单按展示包算。
  let clickBased = false;
  if (a.source === 'redeem') {
    const r = redemptions.find(x => x.id === a.redemptionId);
    clickBased = !!r && !r.comp && !((r.views || 0) > 0);   // 站长代投（comp）按天投，不算纯点击包
  }
  return {
    id: a.id, slot: a.slot,
    kind: a.kind || (a.image ? 'image' : 'text'),
    title: a.title || '', desc: a.desc || '',
    image: a.image || '', url: a.url, cta: a.cta || '', sort: a.sort || 0,
    workId: a.workId || '',        // 推荐位渲染原生卡片时要用它拿到作品
    extUrl: a.extUrl === true,     // 推荐但点击跳外链：前端据此走 <a> 外链而不是开作品详情
    source: a.source || 'admin',  // 前台据此区分「广告」（运营）和「推荐」（积分兑换）
    clickBased                     // 纯点击包兑换位 = true，其余 false
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
  // 站长代投（comp）按天投放、不走展示/点击额度：只看到期时间，额度恒为 0 不代表投完
  if (a.comp) return true;
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
// 这条广告是不是站长代投（comp）：代投建单时 a.comp 恒为 true；老数据兜底去订单里查一次。
function adIsComp(a) {
  if (!a) return false;
  if (a.comp === true) return true;
  if (a.source !== 'redeem') return false;
  const r = redemptions.find(x => x.id === a.redemptionId);
  return !!r && r.comp === true;
}
// 按优先级挑池子：逐位判断，一个位里才分先后；只剩一类时原样返回，
// 位不能空着（优先 ≠ 独占）。单条代投的 prio 优先于全局投放权重，没设过的老单跟全局走。
// 一个位里的三类角色：买家单（含运营广告）/ 让位代投 / 齐平代投 / 抢位代投。
//   - 有「优先这条」的代投：它们先上（齐平的代投跟着一起随机），买家单与让位代投这次不参与
//   - 否则有买家单：买家单 + 齐平代投随机，让位代投补位不上
//   - 否则（这个位没有买家单）：所有代投照常补位
function adPrioOf(a) {
  if (!adIsComp(a)) return 'paid';
  const p = String(a.prio || '');
  return COMP_PRIO_MODES.includes(p) ? p : promoPriorityMode();   // 老单：跟随全局
}
function applyPromoPriority(list) {
  if (!list.length) return list;
  const bySlot = new Map();
  list.forEach(a => {
    const g = bySlot.get(a.slot) || { paid: [], user: [], tie: [], owner: [] };
    g[adPrioOf(a)].push(a);
    bySlot.set(a.slot, g);
  });
  const keep = new Set();
  bySlot.forEach(g => {
    let win;
    if (g.owner.length) win = g.owner.concat(g.tie);
    else if (g.paid.length) win = g.paid.concat(g.tie);
    else win = g.user.concat(g.tie);
    win.forEach(a => keep.add(a));
  });
  return list.filter(a => keep.has(a));
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
  // gate：各广告位「每人每天最多展示几次」，后台可改，前端按它做频控（0 = 不限制）
  // priority：投放权重（user 优先用户 / owner 优先站长 / tie 平级），池子已按它挑过一遍，
  // 前端照单渲染即可；带回原值只为排查「为什么这条没出来」。
  res.json({
    slots: AD_SLOTS, gate: adGateDaily(), priority: promoPriorityMode(),
    ads: applyPromoPriority(activeAds()).map(publicAd)
  });
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
    text: `「${w.title}」已标注为开源，系统赠送 ${OS_BONUS_POINTS} 盏灯火，可在「推荐」用于换推荐位。源码仓库在 GitHub 的，star 可以按 1:1 换灯火：star 涨了以后在个人菜单 /「我的」页点一下「更新 star 奖励」，系统按还没结算的部分发放（一般当场到账；未验证归属的超过 ${STAR_AUTO_APPLY_MAX} 个、已验证归属的超过 ${STAR_VERIFIED_AUTO_MAX} 个转站长核定）；仓库在 Gitee 等其他托管站的读不到 star，同步后由站长人工核对发放。`,
    points,
    delta: OS_BONUS_POINTS
  });
  return OS_BONUS_POINTS;
}

// ---------- GitHub star 奖励：作者手动同步 ----------
// 站长拍板（2026-11-07）：取消 6 小时定时自动同步，改由作者自己点「同步 GitHub star 奖励」。
// 理由：star 是「作者发版 / 被转发才涨」的事件，后台定时空转既占 GitHub API 限额（未配
//      token 时 60 次/时），又让用户不知道灯火何时到账；手动点一下立刻看到结果更直接。
// 管理员排障用的 /api/admin/starsync 与作者接口共用下面的结算函数，全站只有一套账。
//
// 账本口径（star-sync.json）：rec.awardedStars = 已结算的历史最高 star 数
//   room = 当前 star − awardedStars，天生「只算涨值」：掉星不扣、回升不重发、超历史最高才发。
//   旧实现按「上次同步值 rec.count」算 delta，star 撤回再点能刷出第二遍灯火，这里一并修掉。
//   单日封顶没发完的部分也记为已结算（封顶不累计、次日不补发），与原规则一致。
// 其他规则：
//  - 只认 github.com 仓库；其他托管站接口不统一，一律转站长人工核对
//  - 同一仓库被多件作品引用时只结算最早登记的那件（按 repoKey 去重）
//  - 单仓库单日封顶 STAR_REWARD_DAY_CAP（防买 star / 机器人刷 star）
//  - 拉取失败不改动账本，下次同步再试；仓库 404（改名 / 删库 / 乱填）转人工
//  - 绑定 GitHub 且仓库 owner 与绑定账号一致 = 快速通道，但仍有单次人工线（STAR_VERIFIED_AUTO_MAX）
const STAR_REWARD_RATE = Math.max(0, Number(process.env.STAR_REWARD_RATE) || 1);
const STAR_REWARD_DAY_CAP = Math.max(0, Number(process.env.STAR_REWARD_DAY_CAP) || 2000);
const STAR_AUTO_APPLY_MAX = 100;             // 未验证归属时，可自动发放的 star 上限，超过转站长核定
// 归属已验证的快速通道上限（单次可结算量）。站长拍板（2026-11-08）：验证归属只证明「仓库是你的」，
// 不证明「star 是真的」——买 star 恰恰是买在自己仓库上的，所以大额不能全自动放过去，留一道人工抽查线。
// 正常作者一次涨几百 star 已算爆款；单次超过这个数（含第一次同步就直接上千）转站长看一眼再发。
const STAR_VERIFIED_AUTO_MAX = process.env.STAR_VERIFIED_AUTO_MAX !== undefined
  ? Math.max(0, Number(process.env.STAR_VERIFIED_AUTO_MAX)) : 500;
// 勋章：单仓库 star ≥ 2000 且仓库归属已验证，自动颁发这个标签（不进标签库，避免被改名/删除误伤）
const GH_BADGE_STARS = 2000;
const GH_BADGE_TAG = 'GitHub 优质原创作者';
// 下面两个冷却可用环境变量调（回归测试设 0 才能连续同步多轮）
// 2026-11-08 站长拍板：同一件作品两次同步间隔从 10 分钟改成 24 小时（一天一次，够作者当天涨的 star 一次结算完，
// 也把 GitHub API 额度留给真正需要的人）
const STAR_SYNC_COOLDOWN = process.env.STAR_SYNC_COOLDOWN_MS !== undefined
  ? Math.max(0, Number(process.env.STAR_SYNC_COOLDOWN_MS)) : 24 * 3600e3;
const STAR_MANUAL_REAPPLY_MS = process.env.STAR_MANUAL_REAPPLY_MS !== undefined
  ? Math.max(0, Number(process.env.STAR_MANUAL_REAPPLY_MS)) : 7 * 86400e3; // 转人工后 7 天内不重复建反馈，免得刷反馈
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
function ghStarHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'dream-window' };
  if (GITHUB_STAR_TOKEN) h.Authorization = 'Bearer ' + GITHUB_STAR_TOKEN;
  return h;
}
// 读一次公开仓库信息：owner / star 数 / 是否存在。
// 4 秒超时、失败一律返回 unknown，绝不因为 GitHub 抖动卡住投稿或同步。
async function fetchGithubRepo(url) {
  const slug = githubRepoOf(url);
  if (!slug) return null;                    // 非 GitHub：交给人工核对
  const at = new Date().toISOString();
  try {
    const r = await fetch(GH_CONF.apiBase + '/repos/' + slug, {
      headers: ghStarHeaders(), signal: AbortSignal.timeout(4000)
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && typeof d.stargazers_count === 'number') {
      return {
        owner: String((d.owner && d.owner.login) || String(d.full_name || '').split('/')[0] || ''),
        stars: d.stargazers_count, exists: true, at
      };
    }
    return { owner: '', stars: null, exists: r.status === 404 ? false : null, at };
  } catch {
    return { owner: '', stars: null, exists: null, at };
  }
}
// 「这个仓库是不是绑定账号自己名下的」：只比公开 owner 字符串。
// 不升 OAuth scope（仍是 read:user）、不存 access_token，绑定纯属可选的快速通道。
function verifiedRepoOwner(user, owner) {
  const login = user && user.github && String(user.github.login || '');
  return !!(login && owner && login.toLowerCase() === String(owner).toLowerCase());
}

// GitHub 优质原创作者勋章：单仓库 star ≥ GH_BADGE_STARS，且仓库归属已验证（绑定的 GitHub 登录名 = 仓库 owner）。
// 站长拍板（2026-11-08）：**改成「达标 + 站长确认」双条件**，不再自动颁发——
// 归属验证只证明仓库是你的，买 star 恰恰买在自己仓库上，一次刷到 2000 就能自领官方认证，勋章会失去含金量。
// 所以这里只做「提报」：自动建一条反馈到后台，站长核对 star 增长是否正常后，在后台「用户 → 标签」
// 里贴 GH_BADGE_TAG 即为颁发（/api/admin/users/tags 会记档）。幂等靠 ghBadgeApplyAt，只提报一次。
function applyGithubBadge(user, work) {
  if (!user || !work) return false;
  if (!verifiedRepoOwner(user, work.repoOwner)) return false;
  const stars = Math.max(Number(work.stars) || 0, Number(work.repoStarsAt) || 0);
  if (stars < GH_BADGE_STARS) return false;
  const rec = shareRecOf(user.id);
  if (rec.ghBadgeAt) return false;              // 已颁发过（含站长手工摘掉），不再提报
  if (rec.ghBadgeApplyAt) return false;         // 已提报，等站长处理
  const now = new Date().toISOString();
  rec.ghBadgeApplyAt = now;
  saveShareNow();
  const text = `勋章待确认（门槛 ${GH_BADGE_STARS} star）：用户 @${user.username}，作品「${work.title}」，`
    + `仓库 ${work.repo}，当前 ${stars} star，归属已验证（绑定 GitHub：${(user.github && user.github.login) || '—'}）。`
    + `请核对 star 增长是否正常（有没有买 star / 刷量痕迹），确认后在后台「用户」里找 @${user.username}，`
    + `点「标签」贴「${GH_BADGE_TAG}」即为颁发并自动给 TA 发站内信；不打算给就摘掉这条反馈，TA 不会重复收到提报。`;
  feedback.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    token: fbNewToken(),
    type: '合作/其他',
    content: text,
    contact: '',
    username: user.username,
    userId: user.id,
    page: '/api/star/badge',
    ua: 'system',
    status: '待查看',
    createdAt: now,
    lastAt: now,
    thread: [{ from: 'user', fromName: '系统自动提交', text, at: now, read: false }]
  });
  if (feedback.length > 2000) feedback = feedback.slice(-2000);
  saveFeedback();
  addNotice(user.id, {
    kind: 'system',
    title: `勋章待站长确认：${GH_BADGE_TAG}`,
    text: `你的开源作品《${work.title}》在 GitHub 已有 ${stars} star，达到 ${GH_BADGE_STARS} star 的勋章门槛，已提交站长确认。`
      + '站长核对后会给你加上勋章，到账有消息提醒；这条只提报一次，不用重复操作。',
    workId: work.id
  });
  return true;
}
function starRepoRec(key) {
  return starSync.repos[key] || (starSync.repos[key] = {});
}
// 首次提交 / 换链接时记一次仓库快照：验存在、记归属与 star 基线、给存疑链接打「需核定」标记。
// 换链接必须清掉旧的核定状态，避免「审核时挂 A 仓库、领奖时换 B 仓库」。
async function stampRepoOnWork(w, user, opts = {}) {
  const info = await fetchGithubRepo(w.repo);
  if (!info) {                              // 非 GitHub：清掉旧的 GitHub 归属信息，保留人工通道
    delete w.repoOwner; delete w.repoCheckedAt; delete w.repoStarsAt; delete w.repoExists;
    w.starNeedsReview = true;
  } else {
    w.repoOwner = info.owner || w.repoOwner || '';
    w.repoCheckedAt = info.at;
    w.repoExists = info.exists;
    if (typeof info.stars === 'number') w.repoStarsAt = info.stars;
    const verified = verifiedRepoOwner(user, w.repoOwner);
    w.starNeedsReview = info.exists === false
      || (typeof info.stars === 'number' && info.stars > STAR_AUTO_APPLY_MAX && !verified);
  }
  if (opts.changed) {
    delete w.starApply;                     // 换链接要重新核定
    delete w.starSyncAt;
    delete w.starsAt;
    w.stars = null;                         // 旧仓库的 star 缓存不能挂到新仓库上
  }
  // 提交 / 改链接时已经读过一次仓库，顺手判一次勋章，不用等作者手动点「更新 star 奖励」
  if (info) applyGithubBadge(user, w);
}

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
    page: '/api/star/sync',
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
    text: `你同步的开源作品 star 奖励已转给站长人工核定（作品「${w.title}」）。核对后灯火会直接发到账户，到账有消息提醒；7 天内不用重复同步，超过 7 天还没动静可以再点一次「更新 star 奖励」。`,
    workId: w.id
  });
  return item;
}

// 统一的 star 结算：user 传 null = 管理员排障，全量跑一遍（不受冷却与限流限制）
async function syncStarsForUser(user, opts = {}) {
  const admin = !!opts.admin;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const pool = works.filter(w => w.openSource === true && w.userId && w.repo
    && w.status !== 'rejected' && w.status !== 'pending'
    && (!user || w.userId === user.id));
  const auto = [], manual = [], skipped = [];
  const seenRepo = new Set();
  let changed = false;

  for (const w of pool.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
    const key = repoKeyOf(w.repo);
    // 同一仓库只结算一件：仓库的 star 是仓库的，不是每件引用它的作品各算一遍
    if (key && seenRepo.has(key)) {
      skipped.push({ id: w.id, title: w.title, reason: '同一仓库已由另一件作品结算' }); continue;
    }
    if (key) seenRepo.add(key);

    // 冷却 / 转人工冷却（管理员排障不受限）。冷却时长改动后文案自动跟着走，别写死「10 分钟」
    if (!admin && w.starSyncAt && Date.now() - (Date.parse(w.starSyncAt) || 0) < STAR_SYNC_COOLDOWN) {
      const left = STAR_SYNC_COOLDOWN - (Date.now() - (Date.parse(w.starSyncAt) || 0));
      const leftText = left >= 3600e3
        ? `${Math.max(1, Math.ceil(left / 3600e3))} 小时`
        : `${Math.max(1, Math.ceil(left / 60e3))} 分钟`;
      skipped.push({ id: w.id, title: w.title, reason: `刚同步过，${leftText}后再试` }); continue;
    }
    if (!admin && w.starApply && w.starApply.mode === 'manual'
        && Date.now() - (Date.parse(w.starApply.at) || 0) < STAR_MANUAL_REAPPLY_MS) {
      skipped.push({ id: w.id, title: w.title, reason: '已提交站长核定，等回复即可' }); continue;
    }
    const account = users.find(u => u.id === w.userId);
    if (!account) continue;

    const toManual = (reason, stars, room) => {
      const starText = typeof stars === 'number' ? `${stars} star` : '这次没读到 star';
      const roomText = typeof room === 'number' ? `，可结算 ${room} 个` : '';
      const text = `同步 star 奖励（${reason}）：作品「${w.title}」，仓库 ${w.repo}，当前 ${starText}${roomText}。请站长核对仓库归属与数量后发放，走后台「送灯火」，备注写清仓库名方便对账；同一件作品只发一次。`;
      w.starApply = { at: now, mode: 'manual', stars: stars == null ? null : stars, room: room == null ? null : room, awarded: 0, note: reason };
      w.starSyncAt = now;
      starApplyFeedback(account, w, text);
      manual.push({ id: w.id, title: w.title, stars: stars == null ? null : stars, room: room == null ? null : room, reason });
      changed = true;
    };

    const info = await fetchGithubRepo(w.repo);
    if (!info) { toManual('非 GitHub 仓库，站长人工核对', null, null); continue; }
    if (typeof info.stars !== 'number') {
      toManual(info.exists === false ? '仓库打不开（404），需核对链接' : '这次没读到 star（限流或仓库改名）', null, null);
      continue;
    }

    const rec = starRepoRec(key);
    const settled = typeof rec.awardedStars === 'number' ? rec.awardedStars : 0;
    const room = Math.max(0, info.stars - settled);
    w.stars = info.stars;
    w.starsAt = now;
    w.repoOwner = info.owner || w.repoOwner || '';
    w.repoExists = true;
    w.repoCheckedAt = info.at;
    rec.count = info.stars;
    rec.at = now;
    w.starSyncAt = now;
    changed = true;

    // 归属已验证且 star 过线 → 提报站长确认勋章（内部幂等：已颁发 / 已提报 / 未绑 GitHub / 不达标都直接返回）
    applyGithubBadge(account, w);

    const verified = verifiedRepoOwner(account, w.repoOwner);
    // 两条线：未验证归属 >100 转人工（原规则）；归属已验证放宽到 STAR_VERIFIED_AUTO_MAX，
    // 超过这条线照样转人工抽查一次——归属验证挡的是「拿别人的仓库领奖」，挡不住「自己买 star」。
    const autoMax = verified ? STAR_VERIFIED_AUTO_MAX : STAR_AUTO_APPLY_MAX;
    const needsReview = verified ? false : !!w.starNeedsReview;
    if (room > 0 && (room > autoMax || needsReview)) {
      toManual(room > autoMax
        ? `可结算 ${room} star，超过${verified ? '已验证作者的' : '未验证归属的'} ${autoMax} 上限`
        : '仓库归属待核对', info.stars, room);
      continue;
    }
    delete w.starNeedsReview;               // 实时数据已判过，清掉提交时打的存疑标记
    if (room <= 0) {
      w.starApply = { at: now, mode: 'auto', stars: info.stars, awarded: 0, note: '没有可结算的 star' };
      skipped.push({ id: w.id, title: w.title, reason: '这些 star 已经换成灯火了' });
      continue;
    }

    if (rec.day !== today) { rec.day = today; rec.dayAwarded = 0; }
    const capStars = STAR_REWARD_DAY_CAP > 0
      ? Math.max(0, Math.floor((STAR_REWARD_DAY_CAP - (rec.dayAwarded || 0)) / STAR_REWARD_RATE))
      : room;
    const awarded = Math.min(room, capStars);
    const gained = awarded * STAR_REWARD_RATE;
    // 关键：把整个 room 记为已结算（含单日封顶没发完的部分），掉星回升 / 次日都不补发
    rec.awardedStars = settled + room;
    rec.dayAwarded = (rec.dayAwarded || 0) + gained;
    if (gained > 0) {
      const total = addPoints(w.userId, gained, 'star', w.id);
      addNotice(w.userId, {
        kind: 'points',
        title: `star 奖励 +${gained} 盏灯火`,
        text: `「${w.title}」的源码仓库现有 ${info.stars} star，其中 ${room} 个还没换过灯火，按 1 star = ${STAR_REWARD_RATE} 盏发放 ${gained} 盏，当前余额 ${total} 盏。之后 star 再涨，回个人菜单 /「我的」页点「更新 star 奖励」即可领取。`,
        points: total,
        delta: gained,
        workId: w.id
      });
    }
    w.starApply = { at: now, mode: 'auto', stars: info.stars, awarded: gained };
    if (gained > 0) auto.push({ id: w.id, title: w.title, stars: info.stars, awarded: gained });
    else skipped.push({ id: w.id, title: w.title, reason: '今天这个仓库的奖励额度用完了，明天再同步' });
  }

  if (changed) {
    starSync.lastAt = new Date().toISOString();
    saveWorks();
    saveStarSync();
  }
  return { ok: true, auto, manual, skipped, points: user ? (shareRecOf(user.id).points || 0) : null };
}

// 作者手动同步自己名下所有开源作品
app.post('/api/star/sync', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('starsync:' + user.id, 6, 3600e3)) {
    return res.status(429).json({ error: '同步得太频繁了，一小时后再试' });
  }
  res.json(await syncStarsForUser(user));
});
// 兼容旧前端 / 旧链接：指向同一套结算，不再有第二份账本
app.post('/api/star/apply', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('starsync:' + user.id, 6, 3600e3)) {
    return res.status(429).json({ error: '同步得太频繁了，一小时后再试' });
  }
  res.json(await syncStarsForUser(user));
});

// 「已同步多少」：作者名下每件开源作品的当前 star / 已结算 / 待结算 / 上次同步时间
app.get('/api/star/status', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const mine = works.filter(w => w.userId === user.id && w.openSource === true && w.repo && w.status !== 'rejected');
  const list = mine.map(w => {
    const rec = starSync.repos[repoKeyOf(w.repo)] || {};
    const stars = typeof w.stars === 'number' ? w.stars : null;
    const settled = typeof rec.awardedStars === 'number' ? rec.awardedStars : 0;
    return {
      id: w.id, title: w.title, repo: w.repo,
      isGithub: !!githubRepoOf(w.repo),
      owner: w.repoOwner || '',
      boundLogin: (user.github && user.github.login) || '',
      verified: verifiedRepoOwner(user, w.repoOwner),
      stars, settled, pending: stars == null ? null : Math.max(0, stars - settled),
      lastSyncAt: w.starSyncAt || w.starsAt || null,
      needsReview: !!w.starNeedsReview,
      repoExists: w.repoExists === undefined ? null : w.repoExists,
      status: w.status || 'approved'
    };
  });
  res.json({ ok: true, works: list, rate: STAR_REWARD_RATE, autoMax: STAR_AUTO_APPLY_MAX, verifiedAutoMax: STAR_VERIFIED_AUTO_MAX, cooldownMs: STAR_SYNC_COOLDOWN, dayCap: STAR_REWARD_DAY_CAP });
});

// ---------- 上传作品奖励 ----------
// 冷启动激励：注册用户上传作品给灯火——首件共 +200，之后每件 +50（每自然日最多 3 件计奖励）。
// 2026-11-07 站长拍板：首件拆两笔，让新用户提交完就有灯火试用「推荐」——
//   · 即时款 +100：提交且作品已过审正式上线时当场到账，够买一次最小档推荐位；
//   · 余款   +100：24 小时观察期无投诉后到账（观察期内下架则余款作废，即时款不回收）。
//   后续每件 +50（原 +20；签到一轮满勤也才 56 盏，20 一盏太没存在感）仍走原来的 48 小时观察期。
// 防薅：① 匿名投稿不计奖励；② 未上线（待审 / 预告 / 平台上架审核中）不发即时款，等上线再补；
//       ③ 观察期内被投诉下架 → 余款作废；④ 每天最多 3 件计奖励，防批量灌水。
// 2026-11-07 站长拍板：认领通过 / 管理员指定归属（assign、claim）当场全额到账，不挂观察期。
//   观察期防的是「账号批量灌水 + 上线即被投诉下架」，攻击面在自助投稿；这两条路径都是管理员
//   逐条人工点头（认领还要审证据），信任级别本来就高于自助投稿，再挂一天反而自相矛盾——
//   「确认这是你的作品」和「钱等一天再给」不该同时出现。开源奖励 50 盏早就是秒发的，口径一致。
// 存量补齐单独锁旧数值：改价格不该给历史作品凭空加钱。
const UPLOAD_REWARD_FIRST = 200;
const UPLOAD_REWARD_FIRST_INSTANT = 100;           // 首件即时到账
const UPLOAD_REWARD_FIRST_REST_DELAY = 24 * 3600e3; // 首件余款观察期
const UPLOAD_REWARD_NEXT = 50;                    // 改版后新上传的后续作品
const UPLOAD_REWARD_BACKFILL_NEXT = 20;           // 历史作品存量补齐沿用旧口径
const UPLOAD_REWARD_DAILY_MAX = 3;
const UPLOAD_REWARD_DELAY = 48 * 3600e3;           // 后续作品观察期

// 投稿时记一笔「待发放」的奖励计划（在 works.push 之前调用，避免把自己算进历史作品）
// via：奖励来源 upload=自己投稿 / assign=管理员指定账号 / claim=认领通过（后两种作品已在 works 里，判定首件时要排除自己）
// assign / claim 是人工审核过的归属确认：instant 直接等于全额、观察期置 0，当场发完（readyAt=此刻）。
function planUploadReward(w, user, via) {
  if (!user || !user.id) return null;            // 匿名投稿不发
  const first = !works.some(x => x !== w && x.userId === user.id);
  const amount = first ? UPLOAD_REWARD_FIRST : UPLOAD_REWARD_NEXT;
  const manual = via === 'claim' || via === 'assign';   // 人工确认归属，不走观察期
  const instant = manual ? amount : (first ? UPLOAD_REWARD_FIRST_INSTANT : 0);
  const delay = manual ? 0 : (first ? UPLOAD_REWARD_FIRST_REST_DELAY : UPLOAD_REWARD_DELAY);
  w.uploadReward = {
    first, amount, instant, instantPaid: false,
    via: via || 'upload',
    plannedAt: new Date().toISOString(),
    readyAt: new Date(Date.now() + delay).toISOString(),
    readyHours: delay / 3600e3
  };
  return w.uploadReward;
}

// 首件即时款：只在「已过审 + 正式上线」时发，发了立刻把标记落盘（防重启重复发）。
// 待审 / 预告 / 平台上架审核中的作品不在这里发——它们本来就投不了推荐位，
// 等真正上线时由 promoteToLive 或本巡检补上。即时款一经发放不回收（和开源奖励同口径），
// 观察期内被下架只作废余款。
function payUploadRewardInstant(w) {
  const rw = w && w.uploadReward;
  if (!rw || !rw.instant || rw.instantPaid || rw.canceled) return 0;
  if (!isVisible(w)) return 0;
  if (!w.userId || !users.some(u => u.id === w.userId)) return 0;
  rw.instantPaid = true;
  rw.instantPaidAt = new Date().toISOString();
  const points = addPoints(w.userId, rw.instant, 'upload', w.id);
  saveShareNow();   // 和 instantPaid 标记一起落盘，避免「标记已写、钱还没写」的重启窗口
  // 人工审核路径（claim / assign）instant 就等于全额：一次发完，没有「余款」可等，文案别再说「剩下的」
  const full = rw.instant >= (rw.amount || 0);
  if (full) {
    const why = rw.via === 'claim' ? '这件作品的归属已确认到你名下' : '管理员已确认这件作品是你做的';
    addNotice(w.userId, {
      kind: 'points',
      title: `作品奖励 +${rw.instant} 盏灯火已到账`,
      text: `「${w.title}」${why}，${rw.amount} 盏灯火当场全额到账（管理员已审核，不用等观察期）。现在就能到「推荐自己的作品」用灯火换个推荐位。当前余额 ${points} 盏。`,
      points,
      delta: rw.instant
    });
  } else {
    addNotice(w.userId, {
      kind: 'points',
      title: `首件上传奖励 +${rw.instant} 盏灯火已到账`,
      text: `「${w.title}」上架成功，首件奖励先给你 ${rw.instant} 盏灯火，现在就能到「推荐自己的作品」用灯火换个推荐位试一次；剩下的 ${rw.amount - rw.instant} 盏将在 ${rw.readyHours} 小时无投诉后到账。当前余额 ${points} 盏。`,
      points,
      delta: rw.instant
    });
  }
  saveWorks();
  return rw.instant;
}

// 到期巡检：观察期已过且仍在上线状态 → 余款到账并通知作者；被下架/待审 → 余款作废
function payUploadRewards() {
  const now = Date.now();
  const today = dateKey();
  const paidToday = {};
  let changed = false;
  for (const w of works) {
    const rw = w.uploadReward;
    if (!rw || rw.canceled) continue;
    // 兜底补发即时款：待审通过 / 恢复上架 / 预告转上线没走到 promoteToLive 的都在这里接住；
    // 放在 rw.paid 判断之前，避免「余款先发了、即时款反而漏发」。
    if (payUploadRewardInstant(w)) changed = true;
    if (rw.paid) continue;
    if (w.status === 'rejected') { rw.canceled = true; changed = true; continue; }   // 被下架：余款作废
    if (w.status === 'pending') continue;                                            // 站内审核中：先留着，通过后照常发
    if (!w.userId || !users.some(u => u.id === w.userId)) { rw.canceled = true; changed = true; continue; }
    if (new Date(rw.readyAt).getTime() > now) continue;                // 观察期未满
    const rest = Math.max(0, (rw.amount || 0) - (rw.instant || 0));
    if (!rest) {
      // 全额都压在 instant 里（认领 / 指派）：必须确认真的发进去了才收尾，
      // 否则作品暂时不可见时会被误标成「已发」，之后再也补不上
      if (rw.instantPaid || !rw.instant) { rw.paid = true; rw.paidAt = new Date().toISOString(); changed = true; }
      continue;
    }
    if (!(w.userId in paidToday)) {
      paidToday[w.userId] = works.filter(x => x.userId === w.userId
        && x.uploadReward && x.uploadReward.paid && dateKey(new Date(x.uploadReward.paidAt)) === today).length;
    }
    if (paidToday[w.userId] >= UPLOAD_REWARD_DAILY_MAX) continue;      // 今天件数满了，下一轮巡检再发
    const points = addPoints(w.userId, rest, 'upload', w.id);
    // 说明这笔奖励的由来：自己投稿 / 管理员指定 / 认领通过——别让用户收到一笔莫名灯火
    // 改版前就记下的旧计划没有 instant / readyHours，仍按「48 小时全额」口径发，文案别写成余款
    const isSplit = !!(rw.first && rw.instant);
    const reason = rw.via === 'assign' ? '管理员已确认这件作品是你做的'
      : rw.via === 'claim' ? '这件作品的归属已确认到你名下'
      : `上线满 ${isSplit ? (rw.readyHours || 24) : UPLOAD_REWARD_DELAY / 3600e3} 小时无投诉`;
    addNotice(w.userId, {
      kind: 'points',
      title: isSplit ? `首件奖励余款 +${rest} 盏灯火` : `上传奖励 +${rest} 盏灯火`,
      text: `作品「${w.title}」${reason}，${isSplit ? '首件奖励剩下的' : '上传奖励'} ${rest} 盏灯火到账，当前余额 ${points} 盏。`,
      points,
      delta: rest
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
    const amount = first ? UPLOAD_REWARD_FIRST : UPLOAD_REWARD_BACKFILL_NEXT;
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

// ---------- 每日到访（已下线，2026-11-10） ----------
// 站长口径（2026-11-08）：人来了就该有回馈，不该因为懒得点签到就一分拿不到。
// 口径更新（2026-11-10）：「打开就发 2 盏」是一笔看不见的手在发钱，用户感知不到存在感，
// 收进形象体系里做成看得见的陪伴：星星罐（在线攒星，见 /api/mascot/beat）+ 在线自动签到。
// ARRIVE_POINTS 归零 = 全站停发（grantArrive 直接不发，前端签到卡与「我的」页文案自动隐藏）；
// 记账结构 rec.arrive 保留不删：历史流水里的 kind='arrive' 明细还要靠 POINTS_KIND_TEXT 展示。
// ---------- 到访奖励常量（停用中，留作随时复开） ----------
// 和签到分工，两者不重叠：
//   到访 = 2 盏，打开站点自动到账，一天一次，零动作；
//   签到 = 2→15 盏递增（满勤 56 盏/周），仍然要主动点。
// 为什么不做成「访问即签到」：签到的递增曲线、断签清零、累计签到榜、
// 「七日不醒 / 三更造梦 / 梦回旧地」这一整套勋章，全都依赖「用户主动做了一个选择」。
// 自动补签会让断签永不发生、连签榜全变成三位数，签到反而失去了存在意义。
// 所以这里只补一笔小额的「到访」，层级固定为 签到 >> 到访。
// 只对登录用户发（没有账号无处记账，访客先登录）；幂等靠 rec.arrive.last 记当天日期。
// kind 用 'arrive'，别用 'visit'——后者已经被「分享链接带来访问」占用了。
// 想临时关掉：把 ARRIVE_POINTS 改成 0，grantArrive 会直接不发，前端也不显示。
const ARRIVE_POINTS = 0;   // 2026-11-10 下线：奖励收进形象体系（星星罐 + 自动签到，均内测）

function arriveView(user) {
  const rec = shareRecOf(user.id);
  const ar = rec.arrive || {};
  const today = dateKey();
  return {
    points: ARRIVE_POINTS,
    done: ar.last === today,     // 今天这一笔到账了没有（前端文案用）
    total: ar.total || 0,        // 累计到访拿到多少盏
    days: ar.days || 0           // 累计到访天数（一天最多算一次）
  };
}

// 真正发放：一天只发一次，返回 true 表示「这一趟真的到账了」，前端据此只弹一次提示。
function grantArrive(user) {
  if (!user || !(ARRIVE_POINTS > 0)) return false;
  const rec = shareRecOf(user.id);
  const ar = rec.arrive || (rec.arrive = { last: '', total: 0, days: 0 });
  const today = dateKey();
  if (ar.last === today) return false;
  ar.last = today;
  ar.total = (ar.total || 0) + ARRIVE_POINTS;
  ar.days = (ar.days || 0) + 1;
  addPoints(user.id, ARRIVE_POINTS, 'arrive');
  // 当场落盘：一天只有这一次机会，撞上重启丢掉的话，用户会觉得"我明明来了却没给我"。
  // （addPoints 走的是 2 秒 debounce，这里单独补一次同步写。）
  saveShareNow();
  return true;
}

// ---------- 每日签到 ----------
// 连续签到：5,5,10,10,20,20,30（一轮 7 天共 100 盏，第 8 天重新算第 1 天）
// 两个口径，别混：
//   ① 签到 = 免费那一条账，纯手动点一下，不看广告、不花钱，周期固定 7 天（一周一次全勤）。
//   ② 看广告 = 小程序激励视频，另一条账（AD_REWARD_*），每天最多 3 次，与签到周期互不影响。
// 2026-11-11 走了两版：先是 3 天一轮 30/30/40（把 7 天全勤骨架吃掉了，已废），
// 后改 7 天 30 打底（周 260 通胀太猛）；站长最终定 5,5,10,10,20,20,30——
// 曲线翻倍往上爬 + 第 7 天全勤 30 收尾，一周 100 盏，和邀请一个真人同量级。
// 账本走 share.json，签到记录写进「分享明细」。
const CHECKIN_REWARDS = [5, 5, 10, 10, 20, 20, 30];
const CHECKIN_CYCLE = CHECKIN_REWARDS.length;
const CHECKIN_TOP = CHECKIN_REWARDS[CHECKIN_CYCLE - 1];   // 一轮的大奖（最后一天）

function cycleDayOf(streak) { return ((Math.max(1, streak) - 1) % CHECKIN_CYCLE) + 1; }

// ---------- 激励视频送灯火（小程序「我的」页 + 网页签到卡的「看广告领灯火」） ----------
// 网页（尤其 PC）放不了微信激励视频，也不该在网页上造一个「我点过 = 我看完了」的假凭证，
// 所以两端共用同一笔额度、同一个发放入口：网页只负责出码把人送进小程序，真正的发放还在
// /api/me/ad-reward。2026-11-11 当天两次定档：先定「每次固定 30、每天 3 次」（好写成一句
// 「看一次 30，最多 3 次」），站长随后改回递增档 30/30/40——递增让人有恒心把 3 支看完，
// 单日 100 盏刚好和邀请一个真人同量级。改价只动 AD_REWARD_SCHEDULE 这一处。
// 客户端回调（onClose 里 isEnded）本身可以被 hook 伪造，所以不能靠它当凭证，改按三重兜住：
//   ① 单次封顶 40（最后一档）、单日上限 100 盏（30+30+40），和邀请一个真人打平不打过——
//      看三次广告（约 1 分钟）不该盖过拉一个真人，否则没人去邀请
//   ② 每个账号每天最多 3 次（两端共用这一个计数，不存在网页 3 次 + 小程序 3 次）
//   ③ 两次领取至少隔 15 秒（只拦连点脚本：任何一支激励视频都播 15-30 秒，真人根本撞不上）
// 记 share.json 的 adReward 字段，账本走 addPoints(kind='adreward')，和其他来路分开可审计。
const AD_REWARD_SCHEDULE = [30, 30, 40];                    // 递增档：30/30/40，单日 100（改价只动这一处）
const AD_REWARD_TOP = AD_REWARD_SCHEDULE[AD_REWARD_SCHEDULE.length - 1];   // 单次封顶 = 最后一档
const AD_REWARD_DAILY = AD_REWARD_SCHEDULE.length;
const AD_REWARD_TOTAL = AD_REWARD_SCHEDULE.reduce((s, v) => s + v, 0);
// 冷却故意设得比最短的激励视频（15 秒）还短：广告时长本身就是真人间隔，
// 真闸是「每天 3 次」，这里只为挡「onClose 回调被伪造后秒连」的脚本。
const AD_REWARD_GAP_MS = 15000;

function adRewardView(user) {
  const rec = shareRecOf(user.id);
  const ar = rec.adReward || {};
  const today = dateKey();
  const used = ar.day === today ? (ar.count || 0) : 0;
  const gapLeft = ar.at ? Math.max(0, AD_REWARD_GAP_MS - (Date.now() - ar.at)) : 0;
  return {
    once: used >= AD_REWARD_DAILY ? 0 : AD_REWARD_SCHEDULE[used],  // 下一次能拿几盏（字段名避开 points，响应里 points 是余额）
    each: AD_REWARD_SCHEDULE[used] || 0,   // 下一档金额（=once，网页签到卡文案直接用它跟着递增走）
    schedule: AD_REWARD_SCHEDULE,     // 三档明细 30/30/40
    max: AD_REWARD_TOP,               // 单次上限（= 最后一档 40）
    total: AD_REWARD_TOTAL,
    limit: AD_REWARD_DAILY,
    used: used,
    left: Math.max(0, AD_REWARD_DAILY - used),
    gapMs: gapLeft                    // > 0 表示冷却中，按钮可以据此灰一下
  };
}

// ---------- 推广补灯（看广告为「推荐自己的作品」补一档灯火） ----------
// 场景：兑换页下单发现灯火不够 → 服务端在拒单时给今天解锁推广专属补灯（+50 盏/次），
// 创作者扫码进小程序「我的」页，看完激励视频就能领走，回来刷新网页继续下单。
// 与「看广告领灯火」（/api/me/ad-reward，每天 30/30/40）是两笔独立的账：
//   ① 只有今天真的在兑换页差过钱才解锁（直接 curl 领不到，防白薅）
//   ② 每天最多 3 次（2026-11-13 由 1 次放宽：一单常差上百盏，只能补 50 的话人还卡在原地）
//   ③ 两次领取间隔 15 秒（复用同一冷却口径，挡 onClose 伪造秒连）
// 账本 kind='promo_ad'，可审计；上限明确（每天最多 150 盏），损失天花板仍可控。
const PROMO_AD_AMOUNT = 50;
const PROMO_AD_DAILY = 3;

// 当天已经领了几次。老记录只有布尔 pa.claimed（放宽前每天 1 次），按「已领 1 次」折算，
// 不回填、不改历史：这些人当天还剩 2 次，第二天自然走新的计数口径。
function promoAdUsed(pa) {
  if (!pa) return 0;
  return Math.min(PROMO_AD_DAILY, Number(pa.count) || (pa.claimed ? 1 : 0));
}

function promoAdView(user) {
  const rec = shareRecOf(user.id);
  const pa = rec.promoAd || {};
  const today = dateKey();
  const isToday = pa.day === today;
  const used = isToday ? promoAdUsed(pa) : 0;
  const left = Math.max(0, PROMO_AD_DAILY - used);
  const claimed = left === 0 && used > 0;      // 三次都领完才算「今天已领完」
  const unlocked = isToday && !!pa.unlocked;
  return {
    amount: PROMO_AD_AMOUNT,
    limit: PROMO_AD_DAILY,
    used,
    left,
    total: PROMO_AD_AMOUNT * PROMO_AD_DAILY,   // 一天最多能补多少（前端讲「最多 150 盏」用）
    unlocked: unlocked && !claimed,            // 今天解锁过且还有次数 → 卡片亮「看广告补灯」
    claimed,
    waitMs: (isToday && pa.at) ? Math.max(0, AD_REWARD_GAP_MS - (Date.now() - pa.at)) : 0
  };
}

// 累计签到天数：新记录直接读 ck.days；更早的记录没有这个字段（ck.total 是灯火不是天数），
// 用积分流水里的 checkin 条数兜底，再退到历史最长连签——总比榜上给人显示「0 天」强。
function checkinDaysOf(uid, ck) {
  const c = ck || {};
  const own = Number(c.days || 0);
  if (own > 0) return own;
  const rec = shareData.users[uid] || {};
  const logs = (Array.isArray(rec.log) ? rec.log : []).filter(e => e && e.kind === 'checkin' && e.t);
  return logs.length || Number(c.maxStreak || 0) || 0;
}

// 签到的展示状态：今天签没签、连续几天、累计几天、下一签能拿几分
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
    days: checkinDaysOf(user.id, ck),              // 累计签到天数（断签不清零，榜上就显示这个）
    todayPoints: reward, bonusPoints: CHECKIN_TOP, total: ck.total || 0,
    schedule: CHECKIN_REWARDS,                     // 前端进度条按表展示每天的奖励
    nextAt: tomorrow.getTime(),
    adReward: adRewardView(user),                  // 看激励视频额外送灯的当日额度（小程序端用）
    promoAd: promoAdView(user),                    // 推广补灯：今天在兑换页差过钱就解锁一档（小程序端用）
    arrive: arriveView(user)                       // 今日到访那 2 盏（签到卡片上顺带说明）
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
      uid: uid,   // 作者页链接统一走 /u/<id>
      name: displayNameOf(u.username),
      points: total,
      days: checkinDaysOf(uid, ck),   // 累计签到天数：榜上给人看的是这个，不是连续天数
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
  return { rank: idx >= 0 ? idx + 1 : 0, totalRanked: all.length, points: ck.total || 0, days: checkinDaysOf(userId, ck) };
}

app.get('/api/me/checkin', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  res.set('Cache-Control', 'no-store');
  res.json({ ...checkinView(user), points: shareStatsOf(user.id).points, checkinBoard: checkinBoard(8), checkinRank: checkinRankOf(user.id) });
});

// 签到核心动作：网页上的「点亮今日」按钮和「在线满 5 分钟自动签到」（内测）共用。
// 抽出来是为了让自动签到走完全同一套连签/递增/勋章记账，不要出现两套口径；
// auto=true 只在记录里留一个 ck.autoAt 的痕（后台排查用），不影响任何奖励与榜单口径。
// 已经签过返回 null（调用方各自决定怎么跟用户说），成功返回 { reward, streak, dayInCycle, points }。
function performCheckin(user, auto) {
  const rec = shareRecOf(user.id);
  const ck = rec.checkin || (rec.checkin = { last: '', streak: 0, total: 0 });
  const today = dateKey();
  const yest = dateKey(new Date(Date.now() - 86400e3));
  if (ck.last === today) return null;

  // 断签 = 上次签到既不是今天（上面已排除）也不是昨天。连续天数从 1 重新数，
  // 换个说法：断签不是「从第 5 盏开始」，是「回到第 1 天、又是 5 盏」——最容易被读错的一条。
  // reset 单独回给前端，让 UI 在签到成功的那一刻把这句话直接说出来，不靠用户去翻规则。
  const broke = !!ck.last && ck.last !== yest;
  const streak = broke ? 1 : (ck.streak || 0) + 1;
  const dayInCycle = cycleDayOf(streak);
  const reward = CHECKIN_REWARDS[dayInCycle - 1];
  // 勋章埋点：这三项老数据里没有，从这次签到开始记。
  // 为什么不放到勋章模块里事后从流水推算：share 流水只留 60 条，断签记录会被截断，
  // 而「凌晨签到」「断签 7 天又回来」都是事件，事件发生的那一秒才是唯一可靠的记录时机。
  ck.maxStreak = Math.max(Number(ck.maxStreak || 0), streak);
  ck.days = Number(ck.days || 0) + 1;                        // 累计签到天数（ck.total 是灯火，不是天数）
  if (new Date().getHours() < 5) ck.nightAt = Date.now();    // 「0 点至 5 点」：5 点整不算
  const gapDays = ck.last ? Math.round((Date.parse(today) - Date.parse(ck.last)) / 86400e3) : 0;
  if (gapDays >= 8) {                                        // 昨天签 gap=1；隔了 7 天没签 gap=8
    ck.backGap = gapDays;
    ck.backStreak = 1;
  } else if (Number(ck.backGap || 0)) {
    ck.backStreak = Number(ck.backStreak || 0) + 1;
  }
  ck.last = today;
  ck.streak = streak;
  ck.total = (ck.total || 0) + reward;
  if (auto) ck.autoAt = Date.now();
  const points = addPoints(user.id, reward, 'checkin');
  return { reward, streak, dayInCycle, points, reset: broke };
}

app.post('/api/me/checkin', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('checkin:' + user.id, 10, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const done = performCheckin(user, false);
  if (!done) return res.status(400).json({ error: '今天已经签过了，明天再来', ...checkinView(user) });
  res.json({
    ok: true, ...done, cycle: CHECKIN_CYCLE, ...checkinView(user),
    checkinBoard: checkinBoard(8), checkinRank: checkinRankOf(user.id)   // 签完立刻回传最新小榜，前端原地重画
  });
});

// 看完一支激励视频，回来领灯火。客户端只说「我看完了」，服务端只认额度：
// 每日 3 次、两次间隔 15 秒、奖励 30/30/40 递增，超过就不再给（也照实回当前额度，前端好显示）。
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
    // 别说「还没看完」：用户确实是看完才点的，只是点得太快，怪他不如提醒他等两秒
    return res.status(429).json({ error: '刚领过一次，歇两秒再点', ...adRewardView(user) });
  }
  const amount = AD_REWARD_SCHEDULE[ar.count] || AD_REWARD_SCHEDULE[AD_REWARD_DAILY - 1];  // 先按「第几次」取金额，再自增
  ar.count = (ar.count || 0) + 1;
  ar.at = Date.now();
  const points = addPoints(user.id, amount, 'adreward');
  saveShareSoon();
  res.json({ ok: true, reward: amount, points, ...adRewardView(user) });
});

// 推广补灯：看完激励视频回来领 +50 盏（今天在兑换页差过钱才解锁，见 promoAdView）。
// 与 /api/me/ad-reward 分开记：各认各的额度，互不占用次数。
app.post('/api/me/promo-ad-reward', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('promoad:' + user.id, 8, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const rec = shareRecOf(user.id);
  const pa = rec.promoAd || (rec.promoAd = {});
  const today = dateKey();
  if (pa.day !== today) { pa.day = today; pa.unlocked = false; pa.count = 0; pa.claimed = false; pa.at = 0; }
  if (!pa.unlocked) {
    return res.status(400).json({ error: '今天还没有待补的灯：先在推荐页下一次单，差钱后这里才能领', promoAd: promoAdView(user) });
  }
  const used = promoAdUsed(pa);
  if (used >= PROMO_AD_DAILY) {
    return res.status(400).json({ error: `今天的 ${PROMO_AD_DAILY} 次推广补灯已经领完了，明天再来`, promoAd: promoAdView(user) });
  }
  if (pa.at && Date.now() - pa.at < AD_REWARD_GAP_MS) {
    return res.status(429).json({ error: '刚领过一次，歇两秒再点', promoAd: promoAdView(user) });
  }
  pa.count = used + 1;
  pa.claimed = pa.count >= PROMO_AD_DAILY;   // 兼容旧字段：三次领满才置真
  pa.at = Date.now();
  const points = addPoints(user.id, PROMO_AD_AMOUNT, 'promo_ad');
  saveShareSoon();
  addNotice(user.id, {
    kind: 'points',
    title: `推广补灯 +${PROMO_AD_AMOUNT} 盏已到账`,
    text: `你在推荐页下单时灯火不够，看完广告补发了 ${PROMO_AD_AMOUNT} 盏（今天第 ${pa.count}/${PROMO_AD_DAILY} 次），当前余额 ${points} 盏。回到下单页刷新即可继续下单。`,
    points,
    delta: PROMO_AD_AMOUNT
  });
  res.json({ ok: true, reward: PROMO_AD_AMOUNT, points, promoAd: promoAdView(user) });
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
    text: `你把本站装到了桌面，并用图标登录打开，送你 ${PWA_BONUS_POINTS} 盏灯火（一次性奖励），当前余额 ${points} 盏。灯火可在「推荐」用于换推荐位。`,
    points,
    delta: PWA_BONUS_POINTS
  });
  res.json({ ok: true, reward: PWA_BONUS_POINTS, points });
});

// 广告分区消息：推荐位 / 广告位订单的进展只发给投放人自己（kind:'ad'）。
// key 用「阶段 + 订单号」，同一单同一阶段只收一条——巡检每分钟都在跑、重启会重放，
// 没有 key 的话「已上线」能被写成几十条。
function noticeAdPhase(r, phase, extra) {
  if (!r || !r.userId) return null;
  const slot = REDEEM_SLOTS.find(s => s.key === r.slot) || AD_SLOTS.find(s => s.key === r.slot) || {};
  const name = slot.name || '推荐位';
  const w = works.find(x => x.id === r.workId) || {};
  const work = w.title ? `「${w.title}」` : '你的作品';
  const days = redemptionDaysOf(r);
  const packs = [
    r.views ? `${r.views} 次曝光` : '',
    r.clicks ? `${r.clicks} 次点击` : ''
  ].filter(Boolean).join(' + ');
  const map = {
    start: {
      title: `${name}已上线`,
      text: `${work}已经在「${name}」展示了，最多挂 ${days} 天，本轮 ${packs || '按次计费'}，共 ${r.price || 0} 盏灯火。`
        + '投放期间在「推荐」里能看到实时曝光 / 点击，随时可以撤下，没用完的按原价退回。'
    },
    queue: {
      title: `${name}已排队`,
      text: `${work}排在「${name}」第 ${(extra && extra.pos) || 1} 位：这个位置一次只挂一条，前面那单结束后自动接上。`
        + '排队期间不消耗曝光、也不占投放天数，随时可以撤单全额退回。'
    },
    resume: {
      title: `${name}开始投放了`,
      text: `${work}排队结束，已经在「${name}」上线，最多挂 ${days} 天。`
    },
    done: {
      title: `${name}的曝光投完了`,
      text: `${work}这轮 ${packs || '曝光'}已经用完，推荐已自动下线。想继续曝光可以在「推荐」里再开一单，`
        + '也能换个位置试试。'
    }
  };
  const m = map[phase];
  if (!m) return null;
  return addNotice(r.userId, {
    kind: 'ad',
    key: `ad-${phase}-${r.id}`,
    title: m.title,
    text: m.text,
    workId: r.workId
  });
}

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
  // 投完（额度耗尽）主动说一声：用户不在场，等他回来看余额只会觉得灯火莫名少了一截
  if (status === 'used_up') noticeAdPhase(r, 'done');
  return r;
}

// 主动撤下 / 后台下架：没用完的展示次数和点击额度都按原价折算退分，已用掉的不退
function refundRedemption(r, status) {
  // 站长代投（comp）没扣过灯火：撤下 / 到期都没有可退的部分，也不发退款站内信
  if (r.comp) {
    r.status = status;
    r.endedAt = Date.now();
    r.refunded = 0;
    saveRedemptions();
    return 0;
  }
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
        text: `「${w.title || '你的作品'}」的推荐到了 ${redemptionDaysOf(r)} 天上限，已自动下线。这次推荐共花费 ${r.price || 0} 盏，其中 ${(r.price || 0) - back} 盏对应已曝光 / 已点击的部分，剩下 ${back} 盏已按原价退回，当前余额 ${points} 盏。`,
        points, delta: back
      });
    }
  }
  return back;
}

// ---------- 排队扶正 ----------
function slotActiveRedemption(slot) {
  return redemptions.find(r => r.slot === slot && r.status === 'active') || null;
}
function slotQueue(slot) {
  return redemptions.filter(r => r.slot === slot && r.status === 'queued')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
// 独占位（exclusive）：库存 1，同时只允许一单在投，后来的人在队列里等，
// 前一单投完 / 撤下 / 到期后自动接上队头。
// 非独占位：位置上不设库存（2026-11-11 首页格从独占放开为 3 条同投后 exclusive:false），
// 新单下单即上线、不会进队列。但老规则时代排过队的遗留单还在队列里——
// 放开容量后 exclusive 已是 false，若不在这里兜一把，这些单子永远等不到扶正路径（11-12 修复）。
// 排队期间灯火已经扣了但一分不消耗，随时可以撤单全额退回。
function activateRedemption(r) {
  const now = Date.now();
  r.status = 'active';
  r.startsAt = now;
  // 期限从这一刻算（排队等待不占天数），天数用下单时选的那个，别用当前位置的现值
  r.endsAt = now + redemptionDaysOf(r) * 86400e3;
  const ad = ads.find(a => a.id === r.adId);
  if (ad) {
    ad.active = true;
    ad.queued = false;
    ad.endsAt = r.endsAt;
    scheduleAdSave();
  }
  noticeAdPhase(r, 'resume');   // 排队的人不知道队头什么时候走，扶正这一刻必须说一声
}
function promoteQueued(slot) {
  const cfg = redeemCfg(slot);
  if (cfg.exclusive) {
    if (slotActiveRedemption(slot)) return null;
    const next = slotQueue(slot)[0];
    if (!next) return null;
    activateRedemption(next);
    saveRedemptions();
    return next;
  }
  // 非独占位：位置不设库存，队列里只会有老规则时代的遗留单，全部当场扶正
  const legacy = slotQueue(slot);
  if (!legacy.length) return null;
  legacy.forEach(activateRedemption);
  saveRedemptions();
  return legacy[0];
}
function promoteAllQueues() {
  let n = 0;
  REDEEM_SLOTS.forEach(s => { if (promoteQueued(s.key)) n++; });
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
    // 站长代投（comp）没有额度概念（budget/clickLeft 恒 0），到期由上面订单那条线按 endsAt 收尾，
    // 这里若照额度口径判断会把刚挂上的代投单立刻当成「投完」下线
    if (a.comp) return;
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
        // 这单的投放期限（天）：前端「我的投放」据此把「投 N 天 · 最迟 X 下线」写清楚
        days: redemptionDaysOf(r),
        daysPicked: r.daysPicked === true,   // 只有作者自选过天数的单子才显示，老单不显示
        comp: r.comp === true,               // 站长代投单：作者端标「站长代投」，没有灯火往来
        queuePos, pv: st.pv || 0, uv: st.uv || 0
      };
    });
}

// 各推荐位近 90 天的实测点击率，给前端「怎么选」建议条当参照。
// 2026-11-14 起对外展示统一走「人次 PV」口径（跟后台同本账），所以这里的 ctr 也用 pv 当分母，
// 同时把 bill/pv 的换算比例（scale）一起下发——「怎么选」的打平点原本是按计费曝光推出来的
// （1 灯火买 1 次扣费曝光、30 灯火买 1 次点击 → 3.3%），换成人次尺子必须乘同一个 scale，
// 否则两个数不同尺子，作出的「曝光包 / 点击包」建议就是错的。乘完之后比值不变，四个分支的判断不变。
// 点击明细 2026-11-04 起才有，更早只剩累计数。
// 广告位归槽用 redemptions 的 adId→slot 映射（投放单锁在哪个位就记在哪个位的账上）。
function redeemSlotRealCtr() {
  const adSlot = {};
  redemptions.forEach(r => { if (r && r.adId) adSlot[r.adId] = r.slot; });
  const acc = {};
  const all = { bill: 0, pv: 0, clk: 0 };   // 全站合计：某个位没数据时拿它当换算比例的兜底
  Object.keys(adStats).forEach(d => {
    const day = adStats[d] || {};
    Object.keys(day).forEach(adId => {
      const slot = adSlot[adId];
      if (!slot) return;
      const st = day[adId] || {};
      const a = acc[slot] || (acc[slot] = { bill: 0, pv: 0, clk: 0 });
      const bill = Object.keys(st.uv || {}).length, pv = st.pv || 0, clk = st.clk ? (st.clk.pv || 0) : 0;
      a.bill += bill; a.pv += pv; a.clk += clk;
      all.bill += bill; all.pv += pv; all.clk += clk;
    });
  });
  const allScale = all.pv ? all.bill / all.pv : 0;   // bill/pv：人次尺子换到计费尺子要乘的数
  const out = { __allScale: allScale };
  Object.keys(acc).forEach(k => {
    const a = acc[k];
    out[k] = {
      ctr: a.pv ? Math.round(a.clk / a.pv * 1000) / 10 : 0,       // 人次口径（对外展示用这个）
      ctrBill: a.bill ? Math.round(a.clk / a.bill * 1000) / 10 : 0, // 计费口径，仅供内部对账
      bill: a.bill, pv: a.pv,
      scale: a.pv ? a.bill / a.pv : allScale
    };
  });
  return out;
}

function redeemSlotView(user) {
  const realCtrMap = redeemSlotRealCtr();
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
      // 近 90 天实测点击率 + 样本量：前端「怎么选」拿它跟打平点对照；样本太小（bill<200，计费口径）
      // 前端不引用，宁可少给一个参考数，也不用小样本误导人。
      // ctr 是人次口径（跟榜、跟后台一个尺子）；ctrScale = 该位 bill/pv，前端换算打平点用。
      realCtr: (realCtrMap[c.key] || {}).ctr || 0,
      realBill: (realCtrMap[c.key] || {}).bill || 0,
      realPv: (realCtrMap[c.key] || {}).pv || 0,
      ctrScale: (realCtrMap[c.key] || {}).scale || realCtrMap.__allScale || 0,
      // 自定义数量的上限：前端预设档只是快捷键，1..showMax / 1..clickMax 之间任意整数都能下单
      showMax: c.showMax || Math.max(0, ...c.showPacks),
      clickMax: c.clickMax || Math.max(0, ...c.clickPacks),
      // 位置属于哪个端：mini = 微信小程序里的位（手机真机），web = 网页端的位。
      // 推荐面板据此按作品形态给「优先投哪一端」的建议——只是建议，两端都能投，不做任何拦截。
      platform: adSlot.platform === 'mini' ? 'mini' : 'web',
      exclusive: !!c.exclusive, maxActive: c.maxActive,
      // 小程序位还在审核期：面板里照样列出来（价格、位置、预览都能看），但底部按钮点了只提示，不下单
      onSale: c.onSale !== false,
      internalOnly: !!c.internalOnly,
      // 刚发布提醒的新鲜口径（小时）：>0 的位置，作品还没满这个年龄时前端要先劝一句
      freshHours: c.freshHours || 0,
      // 投放期限：daysPick 的位置（两个首页第一格）让作者自选 1..maxDays 天，前端据此出选择器；
      // 其它位置不给选，一律 7 天兜底，前端读到 daysPick:false 就不渲染这一行。
      daysPick: !!c.daysPick,
      maxDays: c.maxDays || REDEEM_MAX_DAYS,
      // 展示方式：onePerView = 一次只显示一条、浏览期间不切换，每次进页面随机挑一条（两个「首页第一格」）；
      // 没标的就是「多条随机轮展」。前端据此把提示语分开写。
      onePerView: !!c.onePerView,
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

// 投放效果榜：近 30 天里用灯火投放（source==='redeem'）的作品，按曝光 / 点击 / 点击率各排前 5，
// 挂在 /promote 页给所有人看——谁投了、效果如何摆在明面上，激励更多作者也去推广。
// 口径（2026-11-14 定：对外展示走「人次 PV」，扣费与门槛走「计费曝光」）：
// - 只统计指向站内作品且当前仍公开可见的单（作品下线时榜位点了会 404，没有激励意义）；
//   老订单只要近 7 天还在产生曝光/点击就计入（ad-stats 本身按天记，过期订单自然归零）。
// - 外链单（extLink）不算：榜单比的是「推自己的作品」。
// - 对外露出的「曝光 / 点击率」用 st.pv（人次）当分子分母：跟后台「投放单」页同一个数，
//   站长两边对账不会再看到 2,814 vs 5,308 这种两个值。代价是它含同人当天重复 + 防刷超额后的
//   免费展示，比实际扣掉的额度大 1.5~2.8 倍，所以文案里不能再说「花出去的每一盏都算在这里」。
// - bill（计费曝光 Σ|uv_d|）照样算：它才是「作者花掉多少额度」的口径，样本门槛与「怎么选」的
//   打平点换算都用它；ctrBill 是同一比值的计费版，别跟对外展示的 ctr 混用。
// - 点击用 st.clk.pv（点击计费按访客 60 秒去重，与扣费次数基本同一口径）。
// - 点击率榜样本门槛仍按 bill ≥ promoBoardMinBill（真扣过 30 次额度才够格），
//   否则「1 曝光 1 点击 = 100%」会直接霸榜，榜就废了。
// - 人数（people）= uv key 跨天并集，只做展示：告诉作者这一单实际触达多少个不同的人。
const PROMO_BOARD_MIN_BILL = 30;   // 点击率榜的样本门槛（计费曝光次数）

function promoBoardOf(daysRaw) {
  // 默认 30 天（2026-11-13 从 7 天放宽）：7 天样本太小，点击率榜 30 次门槛经常凑不满，
  // 榜面长期只有两三行；明细保留 90 天，30 天窗口绰绰有余。上限仍 30，防大跨度聚合变慢。
  const days = Number(daysRaw) > 0 ? Math.min(30, Math.max(1, parseInt(daysRaw, 10))) : 30;
  const fromDay = dateKey(new Date(Date.now() - days * 86400e3));
  const byWork = {};
  redemptions.forEach(r => {
    if (!r || r.extLink) return;
    const wid = r.workId || '';
    if (!wid || byWork[wid] && byWork[wid].done) return;
    const w = works.find(x => x.id === wid);
    if (!w || !isPublished(w) || w.hidden) { if (byWork[wid]) byWork[wid].done = true; return; }
    const rec = byWork[wid] || (byWork[wid] = { done: false, bill: 0, pv: 0, clicks: 0, uv: new Set(), active: false });
    const ad = ads.find(a => a.id === r.adId);
    Object.keys(adStats).forEach(d => {
      if (d < fromDay) return;
      const st = adStats[d] && adStats[d][r.adId];
      if (!st) return;
      const uvKeys = Object.keys(st.uv || {});
      rec.bill += uvKeys.length;                        // 当天实际扣掉的曝光次数（后台排查消耗用）
      rec.pv += st.pv || 0;                             // 人次：同一访客当天看几次计几次，含超额后的免费展示
      uvKeys.forEach(k => rec.uv.add(k));
      rec.clicks += (st.clk && st.clk.pv) || 0;
    });
    if (r.status === 'active' && ad && redeemAdAlive(ad, Date.now())) rec.active = true;
  });
  const rows = Object.keys(byWork).map(wid => {
    const w = works.find(x => x.id === wid) || {};
    const u = users.find(x => x.id === w.userId) || {};
    const rec = byWork[wid];
    return {
      workId: wid, title: w.title || '', thumb: w.thumb || w.image || '',
      author: u.nickname || u.username || '',
      bill: rec.bill, pv: rec.pv, people: rec.uv.size, clicks: rec.clicks,
      // 对外展示的点击率用 pv 当分母（2026-11-14 改回人次口径，跟后台「投放单」页 3.3% 对上）；
      // ctrBill 是计费口径的同一个比值，留给「怎么选」和内部对账，别混用
      ctr: rec.pv ? Math.round(rec.clicks / rec.pv * 1000) / 10 : 0,
      ctrBill: rec.bill ? Math.round(rec.clicks / rec.bill * 1000) / 10 : 0,
      active: rec.active
    };
  });
  const top5 = (key, filter) => rows.filter(filter)
    .sort((a, b) => b[key] - a[key] || b.bill - a.bill)
    .slice(0, 5);
  // 点击率中位数：给「点击率前 5」榜配一个全体参照。榜面只显示最高的 5 件，作者容易
  // 误以为大家都是 10%+；中位数说的是「全部曝光满 minBill 次的作品里，排中间那位是多少」。
  // 分母人口 = 所有 bill ≥ minBill 的作品（含 0 点击的）——CTR 的分母够大就有意义，
  // 0 点击也是真实结果，剔掉会把中位数抬虚高。
  const ctrRows = rows.filter(x => x.bill >= PROMO_BOARD_MIN_BILL).map(x => x.ctr).sort((a, b) => a - b);
  const ctrMedian = ctrRows.length
    ? Math.round((ctrRows.length % 2
        ? ctrRows[(ctrRows.length - 1) / 2]
        : (ctrRows[ctrRows.length / 2 - 1] + ctrRows[ctrRows.length / 2]) / 2) * 10) / 10
    : null;
  // 对外总账（2026-11-14 第二版）：/promote 页头部的一条「数据最有说服力」的总效果——近 N 天推荐位
  // 实际带来了多少曝光 / 点击 / 点击率。曝光改回「人次（st.pv）」当展示口径：跟后台「投放单」页
  // 完全同一本账，站长对账时两边数字一样，不再出现前台 2,814 / 后台 5,308 这种「同一件事两个数」。
  // 与榜单口径的两处不同，都是有意为之：
  // - 含外链单：外链也是真金白银投出来的推荐位流量，总账要比榜单（只比「推自己作品」）更全；
  // - 含站长代投单（comp）：代投同样占推荐位、带来真实曝光，是对推荐位效果的一部分。
  // bill（计费曝光 Σ|uv_d|）仍然算出来并下发：它是「作者实际花掉多少额度」的口径，
  // 榜单的样本门槛、打平点换算都靠它，只是不再当对外展示的分子。
  const tot = { bill: 0, pv: 0, clicks: 0, uv: new Set() };
  redemptions.forEach(r => {
    if (!r || !r.adId) return;
    Object.keys(adStats).forEach(d => {
      if (d < fromDay) return;
      const st = adStats[d] && adStats[d][r.adId];
      if (!st) return;
      const uvKeys = Object.keys(st.uv || {});
      tot.bill += uvKeys.length;
      tot.pv += st.pv || 0;
      uvKeys.forEach(k => tot.uv.add(k));
      tot.clicks += (st.clk && st.clk.pv) || 0;
    });
  });
  return {
    days,
    minBill: PROMO_BOARD_MIN_BILL,
    shows: top5('pv', x => x.pv > 0),
    clicks: top5('clicks', x => x.clicks > 0),
    ctrs: top5('ctr', x => x.bill >= PROMO_BOARD_MIN_BILL && x.clicks > 0),
    ctrMedian,
    ctrMedianN: ctrRows.length,
    totals: {
      pv: tot.pv,                    // 对外展示的「次曝光」＝人次
      bill: tot.bill,                // 内部口径：真正扣掉额度的次数（≈ pv × 0.53）
      clicks: tot.clicks,
      ctr: tot.pv ? Math.round(tot.clicks / tot.pv * 1000) / 10 : 0,
      ctrBill: tot.bill ? Math.round(tot.clicks / tot.bill * 1000) / 10 : 0,
      people: tot.uv.size,           // 跨天并集：这段时间推荐位实际触达多少个不同的人
      orders: redemptions.length,    // 全历史累计（不是窗口内），给「多少人已经在投」当参照
      authors: new Set(redemptions.map(r => r.userId).filter(Boolean)).size
    },
    updatedAt: Date.now()
  };
}

// 公开接口：/promote 页未登录也拉（激励正是要给没投过的人看），只出聚合数字，不带敏感字段
app.get('/api/promo/board', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(promoBoardOf(req.query.days));
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

  // 二选一：要么买展示包，要么买点击包，不能同时买。
  // 次数不锁死档位：1 到上限（showMax / clickMax）之间任意整数都能下单，前端预设档只是快捷键，
  // 上限防的是手滑多打个 0——投放期最长 7 天，超出流量投不完会自动退，但没必要让人一次押那么多。
  const showMax = cfg.showMax || Math.max(0, ...cfg.showPacks);
  const clickMax = cfg.clickMax || Math.max(0, ...cfg.clickPacks);
  if (views > 0 && clicks > 0) return res.status(400).json({ error: '展示包和点击包二选一，不能同时买' });
  if (views > 0) {
    if (views > showMax) return res.status(400).json({ error: `展示次数一次最多 ${showMax} 次：投完可以再加，到期没用完的部分会自动退回` });
  } else if (clicks > 0) {
    if (clicks > clickMax) return res.status(400).json({ error: `点击次数一次最多 ${clickMax} 次：投完可以再加` });
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
  if (points < price) {
    // 差钱的这一刻解锁今天的推广补灯档：前端弹「去小程序看广告补 50 盏」引导，
    // 小程序里只认这个解锁标记（没真差过钱的人 curl 也领不到）
    const rec = shareRecOf(user.id);
    const pa = rec.promoAd || (rec.promoAd = {});
    const today = dateKey();
    if (pa.day !== today) { pa.day = today; pa.unlocked = false; pa.count = 0; pa.claimed = false; pa.at = 0; }
    pa.unlocked = true;
    saveShareSoon();
    // promoAdLeft 一起带出去：当天 3 次已经用完时前端别再出小程序码让人白扫一趟
    return res.status(400).json({
      error: `灯火不够：需要 ${price} 盏，你还剩 ${points} 盏`,
      need: price, balance: points,
      promoAdUnlocked: true, promoAdLeft: promoAdView(user).left
    });
  }

  const now = Date.now();
  // 投放期限（天）：只有两个「首页第一格」让作者选（1-7 天），其它位固定 7 天兜底。
  // 天数不影响价格——还是按次买，天数只决定这单最多挂多久，到期没投完照旧按原价退余额。
  const days = redeemDaysOf(slot, body.days);
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
    endsAt: occupied ? 0 : now + days * 86400e3,
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
    endsAt: occupied ? 0 : ad.endsAt,
    days,   // 下单时锁住的投放期限（天）：排队中被扶正也按这个天数算，不跟着后来的调价/规则走
    daysPicked: !!cfg.daysPick
  });
  saveRedemptions();
  addPoints(user.id, -price, 'redeem', work.id);

  const queuedPos = occupied ? slotQueue(slot).findIndex(r => r.id === redemptionId) + 1 : 0;
  // 广告分区：下单成功当场给一条凭据（上线 / 排队），省得作者回「推荐」里反复确认有没有生效
  noticeAdPhase(redemptions.find(x => x.id === redemptionId), occupied ? 'queue' : 'start', { pos: queuedPos });
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
  // 关键词＝作者自己标的搜索词（也是「搜关键词能搜到作品」的那条路），仅次于标题
  [w => keyWordsOf(w).join(' '), 6],
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
// 场景选项 + 计数：只回有作品的场景（前端据此渲染下拉/胶囊，空场景不出现）
app.get('/api/scene-meta', (req, res) => {
  const scenes = loadScenes();
  const list = publicWorks(req);
  const keys = list.map(w => sceneKeysOf(w, scenes));
  res.json(scenes.map(s => ({
    key: s.key, name: s.name, desc: s.desc,
    count: keys.reduce((n, ks) => n + (ks.includes(s.key) ? 1 : 0), 0)
  })).filter(s => s.count > 0));
});

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
  // 场景筛选：scene=work / study / life / create / relax / family。
  // 不认识的值当作「不筛」而不是「筛出空」——老链接、写错参数的收藏夹不该给一张白页。
  const sceneKey = String(req.query.scene || '');
  if (sceneKey && sceneKey !== '全部') {
    const scenes = loadScenes();
    if (scenes.some(s => s.key === sceneKey)) {
      list = list.filter(w => sceneKeysOf(w, scenes).includes(sceneKey));
    }
  }
  // 只看我收藏的（需登录，未登录返回空列表）
  if (req.query.fav === '1') {
    const favIds = new Set(user && Array.isArray(user.favs) ? user.favs : []);
    list = list.filter(w => favIds.has(w.id));
  }
  // 只看我点赞的（需登录，未登录返回空列表）。
  // 点赞身份在 like-dedup（'u:用户id' → 1=已赞 / 0=赞过又取消），like-log 只留当前赞、带时间戳；
  // likeTimeOrder 记录每件的点赞时间，列表排完序后再按它倒序重排（见下方）
  let likeTimeOrder = null;
  if (req.query.liked === '1') {
    likeTimeOrder = {};
    if (user) {
      const uid = 'u:' + user.id;
      for (const [wid, seen] of Object.entries(likeDedup)) {
        if (seen && seen[uid] === 1) likeTimeOrder[wid] = 0;
      }
      for (const e of likeLog) {
        if (e && e.vid === uid && likeTimeOrder[e.workId] !== undefined) {
          likeTimeOrder[e.workId] = Math.max(likeTimeOrder[e.workId], e.t || 0);
        }
      }
      list = list.filter(w => likeTimeOrder[w.id] !== undefined);
    } else {
      list = [];
    }
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

  // 我的点赞：最后按点赞时间倒序（覆盖上面的默认排序；置顶作品不该插队「我最近赞的」）。
  // 老赞（2026-11-07 前 like-log 上线前点的）没有时间戳，稳定排在有时间的后面
  if (likeTimeOrder) list.sort((a, b) => (likeTimeOrder[b.id] || 0) - (likeTimeOrder[a.id] || 0));

  // 首页「最新」的屏蔽降权：只在「无任何筛选的全量最新列表」生效。
  // 搜索（按相关度）、分类/形态/时间/开源筛选、我的收藏、作者主页（走 /api/authors）一律不受影响——
  // 尤其不能波及作者主页，那是把作品在作者自己家门口往后排，解释不通。
  const blockEligible = !ranked && sort !== 'hot' && !req.query.os && !rangeDays
    && req.query.fav !== '1' && req.query.liked !== '1' && (!category || category === '全部') && (!type || type === '全部')
    && (!req.query.scene || req.query.scene === '全部');
  if (blockEligible) list = applyBlockShift(list, blockShiftMap(list.map(w => w.id)));

  const total = list.length;
  // 记一次搜索（只在第一页记：翻页、重试、预取都不算新的搜索意图）
  if (q && page === 1) logSearch(req, q, total);
  const items = list.slice((page - 1) * pageSize, page * pageSize).map(w => publicWork(w, user));
  res.json({ items, total, page, pageSize, hasMore: page * pageSize < total });
});

// 本周精选：按「近 7 天综合分」取前 20 件（2026-11-10 改口径）
//   分数 = 窗口获赞×5 ＋ 收藏×8 ＋ 评论×3 ＋ 灯火人数×10 ＋ 窗口访客×2，
//   与「本周热榜」共用同一套权重（weekHotScore），两处不会再出现「精选和热榜不是一套算法」。
//   顺序（2026-11-10 晚站长拍板）：每天洗一次牌、当天固定——
//     同一天所有访客看到同一副排法（种子=当天日期），跨天自动换新排法；
//     洗牌是确定性的（mulberry32），不是每次刷新都抖，卡片左上角的序号只是展示位、不再对应分数名次。
//   管理员精选（后台勾选）照旧不计分数、固定压轴（不参与洗牌）。
//   新作品不额外插入：首页「最新」列表已经把新作品顶在最前，精选只负责按数据选，避免重复曝光
//   卡片上的数据是累计口径（pvAll/uvAll），近 7 天的窗口数据只用于选谁进来，不对外展示
const FEATURED_TOP = 20;
const FEATURED_DAYS = 7;   // 与 WEEKHOT_DAYS 同口径，改一处要一起看

// 固定种子伪随机（mulberry32）：同一种子产生的序列稳定，「继续随机」的发牌顺序靠它复现
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 「随便逛逛」取卡（spec §3.3/§3.4）：mode=pool 分层随机；mode=random 洗牌发牌。
// 逻辑实现在上方 expo 区块（discoverPick / discoverRandom），这里只做闸门和参数收口
app.get('/api/discover', (req, res) => {
  // 双闸：env 总开关 + 后台模块开关。关掉 404，前端整段不渲染、不留空壳
  if (!DISCOVER_ENABLED || expoData.cfg.on !== true) return res.status(404).json({ ok: false, code: 'off' });
  if (!rateLimit('discover:' + ipKeyOf(req), DISCOVER_RPH, 3600000)) return res.status(429).json({ ok: false, code: 'rate' });
  // 认人：登录 u: / 网页 v:<dm_vid> / 小程序 d:<deviceId>（2026-11-12 二期接入）。
  // 优先级与 expoPersonKey 完全一致（登录 > deviceId > vid）：曝光上报走 POST /api/track
  // 认出来是 d:，取卡也必须认成 d:，两边的「已看名单」才是同一份。
  const user = currentUser(req);
  const devId = /^[A-Za-z0-9_-]{6,64}$/.test(String(req.query.deviceId || '')) ? String(req.query.deviceId) : '';
  const vid = /^[A-Za-z0-9_-]{8,40}$/.test(String(req.query.vid || '')) ? String(req.query.vid) : '';
  const key = user && user.id ? 'u:' + user.id : (devId ? 'd:' + devId : (vid ? 'v:' + vid : ''));
  if (!key) return res.status(400).json({ ok: false, code: 'no-person' });
  const size = Math.max(1, Math.min(30, Number(req.query.size) || 12));
  // 「新」角标的分界线（毫秒时间戳），前端拿它跟卡片的 createdAt 比；
  // 同一次浏览的多批请求会返回同一个值（水位线半小时才推进一次），翻到后面新标也不会飘
  const freshSince = wanderFreshSince(key, Date.now());
  if (req.query.mode === 'random') {
    const seed = /^[A-Za-z0-9_-]{1,64}$/.test(String(req.query.seed || '')) ? String(req.query.seed) : '';
    const page = Math.max(0, Math.min(50, Number(req.query.page) || 0));
    const r = discoverRandom(req, key, seed, page, size);
    r.list = r.list.map(w => ({ ...publicWork(w, user), revisit: false }));
    return res.json({ ok: true, freshSince, ...r });
  }
  // 屏上已存在的作品（「加载更多」时前端带上）：发牌前先排掉，避免重复发同一批。
  // 只收合法 id、最多 300 个——URL 长度可控，乱传也不至于拖慢接口。
  const exclude = new Set(String(req.query.exclude || '')
    .split(',')
    .filter(id => /^[A-Za-z0-9_-]{4,32}$/.test(id))
    .slice(0, 300));
  const r = discoverPick(req, key, size, exclude);
  const revisitSet = new Set(r.revisit);
  r.list = r.list.map(w => ({ ...publicWork(w, user), revisit: revisitSet.has(w.id) }));
  res.json({ ok: true, state: r.state, total: r.total, left: r.left, freshSince, list: r.list });
});

// 清空已看名单（用户主动要求「重新推荐一遍」）：只清 users[key].ids（取卡去重的唯一依据），
// 不碰 works 侧的 s/c 曝光点击名单——那是作品 CTR 统计，跟「我看过谁」是两回事，
// 清了会把作品的被看人数冲掉，榜单口径也不能动（/api/track 与本接口零交集）。
app.post('/api/discover/reset', (req, res) => {
  if (!DISCOVER_ENABLED || expoData.cfg.on !== true) return res.status(404).json({ ok: false, code: 'off' });
  if (!rateLimit('discover-reset:' + ipKeyOf(req), 6, 3600000)) return res.status(429).json({ ok: false, code: 'rate' });
  const key = expoPersonKey(req, req.body);
  if (!key) return res.status(400).json({ ok: false, code: 'no-person' });
  const ur = expoData.users[key];
  const cleared = ur && Array.isArray(ur.ids) ? ur.ids.length : 0;
  if (ur) { ur.ids = []; ur.at = Date.now(); }
  saveExpoNow();
  res.json({ ok: true, cleared });
});

// 小助手「纸船」：漂一件几乎没人看过的作品（2026-11-09）
//   曝光口径与站内其它地方一致：workVisits[id].pv（累计），不用 w.views。
//   取曝光最少的那 30% 里随机——只取最冷门那一件的话，会被反复推成新的「熟脸」。
//   排除自己的作品；不要求登录（游客也能顺手给冷门作品带一次浏览）。
app.get('/api/mascot/quiet', (req, res) => {
  if (!rateLimit('mascot-quiet:' + ipKeyOf(req), 60, 3600000)) return res.status(429).json({ ok: false, code: 'rate' });
  const user = currentUser(req);
  const pool = publicWorks(req).filter(w => !(user && w.userId && w.userId === user.id));
  if (!pool.length) return res.json({ ok: false, code: 'empty' });
  const rows = pool
    .map(w => ({ w, pv: (workVisits[w.id] && workVisits[w.id].pv) || 0 }))
    .sort((a, b) => a.pv - b.pv || String(a.w.id).localeCompare(String(b.w.id)));
  const quietPool = rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.3)));
  const pick = quietPool[Math.floor(Math.random() * quietPool.length)];
  res.json({ ok: true, id: pick.w.id, title: pick.w.title, pv: pick.pv });
});

// 小助手「摇一颗星」：从全站摇一件作品（2026-11-09 改口径）
//   原先只在 /api/me/stats 里摇自己的作品，等于把自己的旧作复读一遍（用户反馈：自己的没必要摇）。
//   现在排除自己的作品，并跳过最新 MASCOT_STAR_SKIP 件：那批就在首页 / 列表第一屏，
//   也正好是「小门」（/api/works?pageSize=48 随机）的池子，两个入口别撞车；
//   纸船取的是最冷门 30%，三者池子互不重叠。长尾不够（站里作品还少）时退回全池。
//   不要求登录：游客也能顺手替一件老作品带一次浏览。
const MASCOT_STAR_SKIP = 48;
app.get('/api/mascot/star', (req, res) => {
  if (!rateLimit('mascot-star:' + ipKeyOf(req), 60, 3600000)) return res.status(429).json({ ok: false, code: 'rate' });
  const user = currentUser(req);
  const pool = byNewest(publicWorks(req).filter(w => !(user && w.userId && w.userId === user.id)));
  if (!pool.length) return res.json({ ok: false, code: 'empty' });
  const tail = pool.slice(MASCOT_STAR_SKIP);
  const from = tail.length ? tail : pool;
  const w = from[Math.floor(Math.random() * from.length)];
  res.json({ ok: true, id: w.id, title: w.title, pv: (workVisits[w.id] && workVisits[w.id].pv) || 0, longTail: tail.length > 0 });
});

// ---------- 形象在线心跳：星星罐攒星 + 在线自动签到（2026-11-10，内测） ----------
// 口径（站长 2026-11-10 拍板）：
//   星星罐    = 每在线 5 分钟长 1 颗星，一天最多长 8 颗（跟签到满勤 56 盏/周一个量级），
//               1 星 = 1 盏灯火，kind='jar'；罐子攒上限 6 颗——满了「快收我」，不收就不再进星（溢出的浪费掉）。
//               收取必须点一下（前端把拿手事变「收星星」）：纯在线 + 自动到账等于挂机白拿，
//               点一下人至少还在页面前，而且「满了快收我」的动画必须有一个收取动作才形成闭环。
//   自动签到  = 今天累计在线满 5 分钟（站长口径：5 分钟算真爱粉），自动把今天这签补上，
//               走 performCheckin 与手动签到完全同口径（连签/递增/勋章都算），只留 ck.autoAt 的痕。
//               适合忘性大经常忘签到的人；勤快的人亲手点没有任何损失，层级不受影响。
// 内测方式：data/beta.json { "jar": [用户id...], "autoCheckin": [用户id...] }，写 "*" 表示全员；
//           按 mtime 热加载，改完即生效不用重启。发版前记得把 "*" 换成具体白名单。
// 心跳协议：前端每 60 秒 POST /api/mascot/beat 一拍（轻请求），服务端按距上一拍的间隔累加在线秒数
//           （单拍最多记 2 分钟；间隔超过 10 分钟按新会话处理，防止「下午才回来」把上午的空档白记）。
const JAR_STAR_SEC = 300;       // 每 5 分钟长 1 颗星
const JAR_DAILY = 8;            // 每天最多长 8 颗
const JAR_STORE_CAP = 6;        // 罐子攒上限（满了不再进星，催人收）
const AUTO_CHECKIN_SEC = 300;   // 在线满 5 分钟自动签到

// 白名单：读 data/beta.json，按 mtime 缓存；文件不存在或解析失败一律视为空名单（安全兜底）
let betaCache = null;
function betaListOf(kind) {
  try {
    const f = path.join(DATA_DIR, 'beta.json');
    const st = fs.statSync(f);
    if (!betaCache || betaCache.mtime !== st.mtimeMs) {
      betaCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(f, 'utf-8')) };
    }
    const list = betaCache.data && betaCache.data[kind];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
const isBetaUser = (kind, user) => {
  const list = betaListOf(kind);
  return list.includes('*') || !!(user && list.includes(user.id));
};

// 罐子给前端看的视图
function jarViewOf(rec) {
  const jar = rec.jar || {};
  const sec = (rec.mascot && rec.mascot.sec) || 0;
  const pending = jar.pending || 0;
  return {
    pending,
    got: jar.got || 0,                              // 今天已经收进账的星
    capStore: JAR_STORE_CAP,
    capDaily: JAR_DAILY,
    full: pending >= JAR_STORE_CAP,                 // 罐满了（前端亮「快收我」）
    dayDone: (jar.got || 0) >= JAR_DAILY,           // 今天 8 颗长满了
    nextStarIn: Math.max(0, JAR_STAR_SEC - (sec % JAR_STAR_SEC))   // 距下一颗星还有几秒（前端可做进度）
  };
}

app.post('/api/mascot/beat', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ ok: true, jar: null, auto: null });   // 游客空跑，前端不弹任何东西
  if (!rateLimit('mascot-beat:' + user.id, 8, 60000)) return res.status(429).json({ ok: false, code: 'rate' });
  const rec = shareRecOf(user.id);
  const today = dateKey();
  // 在线秒数挂在 rec.mascot 上，星星罐和自动签到共用同一份；跟 jar 内测资格无关，先记上（成本是一个小对象）
  const ms = rec.mascot || (rec.mascot = { day: '', sec: 0, at: 0 });
  if (ms.day !== today) { ms.day = today; ms.sec = 0; }
  const now = Date.now();
  const gap = ms.at ? now - ms.at : 0;
  ms.at = now;
  // 两拍之间最多记 2 分钟（60 秒一拍留出网络抖动的余量）；离页超过 10 分钟按新会话从零起算
  if (gap > 0 && gap < 10 * 60000) ms.sec += Math.min(120000, gap) / 1000;
  ms.sec = Math.round(ms.sec);

  // 两个内测都不在：空跑返回，前端收到 jar=null 会把角标收掉
  if (!isBetaUser('jar', user) && !isBetaUser('autoCheckin', user)) {
    saveShareSoon();
    return res.json({ ok: true, jar: null, auto: null });
  }

  // 自动签到：在线满 5 分钟且今天还没签 → 按手动签到的同一套口径补上
  let auto = null;
  if (isBetaUser('autoCheckin', user) && ms.sec >= AUTO_CHECKIN_SEC) {
    const done = performCheckin(user, true);
    if (done) auto = { given: true, reward: done.reward, streak: done.streak, points: done.points };
  }

  // 星星罐：按在线秒数把该长的星长出来（长了就进罐，收不收由用户点）
  let jar = null;
  if (isBetaUser('jar', user)) {
    const jr = rec.jar || (rec.jar = { day: '', pending: 0, got: 0 });
    if (jr.day !== today) { jr.day = today; jr.pending = 0; jr.got = 0; }
    const want = Math.min(Math.floor(ms.sec / JAR_STAR_SEC), JAR_DAILY);   // 今天一共该长出来的星数
    const have = jr.got + jr.pending;                                      // 已经长出来的（收掉的 + 罐里的）
    const add = Math.max(0, want - have);
    if (add > 0) jr.pending = Math.min(jr.pending + add, JAR_STORE_CAP);   // 罐满就不再进（溢出的浪费）
    jar = jarViewOf(rec);
  }

  saveShareSoon();
  res.json({ ok: true, jar, auto });
});

// 收星星：把罐里攒的星换成灯火。1 星 = 1 盏，kind='jar'（与签到/到访一样是系统赠送，
// 不进「推荐」的分享成绩统计口径）。当场落盘，重启不丢。
app.post('/api/mascot/jar/collect', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!isBetaUser('jar', user)) return res.status(400).json({ error: '星星罐还在内测，先看看别人摇' });
  if (!rateLimit('jar-collect:' + user.id, 6, 60000)) return res.status(429).json({ error: '点太快啦，罐子会晕' });
  const rec = shareRecOf(user.id);
  const today = dateKey();
  const jr = rec.jar || (rec.jar = { day: '', pending: 0, got: 0 });
  if (jr.day !== today) { jr.day = today; jr.pending = 0; jr.got = 0; }
  const n = Math.min(jr.pending || 0, Math.max(0, JAR_DAILY - jr.got));   // 双保险：超日上限的存量不收
  if (n <= 0) return res.status(400).json({ error: '罐子里暂时没有能收的星', jar: jarViewOf(rec) });
  jr.pending -= n;
  jr.got += n;
  const points = addPoints(user.id, n, 'jar');
  saveShareNow();
  res.json({ ok: true, reward: n, points, jar: jarViewOf(rec) });
});

app.get('/api/featured', (req, res) => {
  const user = currentUser(req);
  const agg = weekAgg();   // 近 7 天增量（30s 缓存），与「本周热榜」共用同一份，口径不会跑偏
  const rows = publicWorks(req).map(w => {
    const p = weekHotParts(w, agg);
    return {
      w, uv7: p.uv, pv7: p.pv, parts: p,
      score: p.score,   // 窗口获赞×5 + 收藏×8 + 评论×3 + 灯火人数×10 + 窗口访客×2
      pvAll: (workVisits[w.id] && workVisits[w.id].pv) || 0
    };
  });
  // 顺序即排名：分数高的在前；同分时看窗口访客，再同就看累计浏览（补位时也能有稳定次序）
  const ranked = rows.sort((a, b) =>
    b.score - a.score || b.uv7 - a.uv7 || b.pvAll - a.pvAll || String(a.w.id).localeCompare(String(b.w.id)));
  // 入选理由 = 该作品各项里贡献最大的那一项（乘完权重再比），
  // 一眼能说出「它凭什么在这」，而不是只丢一堆数字；
  // 完全没有数据的作品不给编理由（走 new），管理员手选的走 edit
  const REASON_PARTS = [
    ['tippers', 10, 'tip'],   // 灯火人数
    ['favs', 8, 'fav'],
    ['likes', 5, 'like'],
    ['cmts', 3, 'cmt'],
    ['uv', 2, 'uv']
  ];
  const adminSet = new Set(rows.filter(r => isFeaturedActive(r.w)).map(r => r.w.id));
  const reasonOf = r => {
    let best = '', bestVal = 0;
    for (const [field, weight, key] of REASON_PARTS) {
      const v = (r.parts[field] || 0) * weight;
      if (v > bestVal) { bestVal = v; best = key; }
    }
    if (best) return best;
    return adminSet.has(r.w.id) ? 'edit' : 'new';
  };
  const adminPicks = ranked.filter(r => adminSet.has(r.w.id));
  const normal = ranked.filter(r => !adminSet.has(r.w.id));
  const keep = Math.max(0, Math.min(normal.length, FEATURED_TOP - adminPicks.length));
  // 每天一洗：种子=当天日期，同一天内顺序固定、跨天换一副排法（Fisher-Yates，确定性可复现）
  const deck = normal.slice(0, keep);
  if (deck.length > 1) {
    const rng = mulberry32(strSeed32('feat-shuffle|' + dateKey()));
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  // 洗好的自动入选打头，管理员精选不计分数、固定压轴
  const list = [...deck, ...adminPicks]
    .slice(0, FEATURED_TOP)
    .map(r => {
      const vr = workVisits[r.w.id] || {};
      return {
        ...publicWork(r.w, user), uv7: r.uv7, pv7: r.pv7,
        // 累计口径给卡片展示用：数字比 7 天窗口厚，避免「12 次打开」看着单薄
        pvAll: r.pvAll, uvAll: Object.keys(vr.uv || {}).length,
        adminPick: adminSet.has(r.w.id),
        // featScore 前端不显示，留着是给「这件为什么没上」的排查当依据（口径写在规则气泡里，不算秘密）
        featScore: r.score, featReason: reasonOf(r)
      };
    });
  res.json({ days: FEATURED_DAYS, list });
});

// ---------- 本周增量统计（「本周热榜」专用） ----------
// 周榜/月榜看的是「谁上架得晚」，本周热榜看的是「这周谁表现好」：
// 老作品只要本周有人点赞/收藏/评论/送灯火/访问，就能和新作品同台排名。
// 点赞 2026-11-07 起才有时间戳（like-log.json），之前的赞算历史累计、不进本周增量。
const WEEKHOT_DAYS = 7;
let weekAggCache = { at: 0, data: null };
function weekAgg() {
  if (weekAggCache.data && Date.now() - weekAggCache.at < 30000) return weekAggCache.data;
  const since = Date.now() - WEEKHOT_DAYS * 86400000;
  const likes = {}, favs = {}, cmts = {}, tippers = {}, tipAmt = {};
  for (const e of likeLog) {
    if (!e || (e.t || 0) < since) continue;
    likes[e.workId] = (likes[e.workId] || 0) + 1;
  }
  for (const e of favLog) {
    if (!e || (e.t || 0) < since) continue;
    favs[e.workId] = (favs[e.workId] || 0) + 1;
  }
  for (const c of comments) {
    if (!c || (c.createdAt || 0) < since || c.anon || !c.userId) continue;
    cmts[c.workId] = (cmts[c.workId] || 0) + 1;
  }
  for (const t of tips) {
    if (!t || !t.workId || (t.createdAt || 0) < since) continue;   // 无 workId = 作者页直送灯火，不进作品维度聚合
    const set = tippers[t.workId] || (tippers[t.workId] = new Set());
    set.add(t.fromUserId || 'anon');
    tipAmt[t.workId] = (tipAmt[t.workId] || 0) + (Number(t.amount) || 0);
  }
  const data = { likes, favs, cmts, tippers, tipAmt, since };
  weekAggCache = { at: Date.now(), data };
  return data;
}
// ---------- 访问参与排名：按「访客人数」计分，1 个访客 2 分（2026-11-08 定稿） ----------
// 为什么不用访问次数（PV）：PV 是「打开了几次」，同一个人刷新 100 次就是 100，随便刷。
// 为什么各端能一起比了：2026-11-08 起网页/H5/App webview 的 UV 也按「本机标识」认人
// （和广告计费共用的 dm_vid，见 trackWorkVisit），小程序按 deviceId、登录按账号，
// 三套键的语义统一成「一台设备一个人 / 一个账号一个人」，不再有「按出口 IP 认人」那一套
// （运营商 CGNAT 后面一个小区共用一个出口，会把几百人并成一个，网页端 UV 被严重低估）。
//
// 系数为什么是 2：点开看一眼是成本最低的动作，所以单个访客的分必须低于
// 评论(3) / 点赞(5) / 收藏(8) 这些要动手的表态；但访客基数大，量上仍撑得住榜单区分度
// （本地数据约占综合分的 36%~45%，和改之前相当，区别是从「可刷的 PV」换成「刷不动的 UV」）。
// 想临时关掉访问计分：env VIEW_SCORE_PER_UV=0（文案公式不变，只是那一项算 0）。
const VIEW_SCORE_PER_UV = (() => {
  const raw = process.env.VIEW_SCORE_PER_UV;
  if (raw === undefined || raw === '') return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
// 访问折算分的统一入口：三处（总榜 / 本周热榜 / 高光榜）都走这里，
// 别再各写一遍系数，否则会出现「总榜按 2 分、热榜按 4 分」的半截状态。
// 只认 UV 不认 PV：同一人反复打开不该多拿分。
function viewPartOf(uv) {
  if (!VIEW_SCORE_PER_UV || !(uv > 0)) return 0;
  return Math.round(uv * VIEW_SCORE_PER_UV);
}

// 本周增量分：与总榜综合分同一套权重，但每一项只数近 7 天的新增。
// 访问部分走 viewPartOf（按窗口内的访客人数，不按次数）。
// 本周增量分的各项明细。本周热榜（求总分）和本周精选（挑主打项做入选理由）共用这一处，
// 避免两个榜单各算一遍、口径慢慢跑偏。
function weekHotParts(w, agg) {
  let cmts = agg.cmts[w.id] || 0;
  if (cmts && w.userId) {   // 作者自评不计，与 commentScore 同口径
    for (const c of comments) {
      if (c.workId === w.id && !c.anon && c.userId === w.userId && (c.createdAt || 0) >= agg.since) cmts--;
    }
  }
  if (cmts < 0) cmts = 0;
  const m = workPvUv(w.id, WEEKHOT_DAYS);
  const parts = {
    likes: agg.likes[w.id] || 0,
    favs: agg.favs[w.id] || 0,
    cmts,
    tippers: agg.tippers[w.id] ? agg.tippers[w.id].size : 0,
    uv: m.uv,
    pv: m.pv
  };
  parts.score = parts.likes * 5 + parts.favs * 8 + parts.cmts * 3
    + parts.tippers * 10 + viewPartOf(parts.uv);
  return parts;
}
function weekHotScore(w, agg) {
  return weekHotParts(w, agg).score;
}
// 本周是否有动静：本周有互动，或本周有人来过才算上榜候选。
// 关键看 UV 不看 PV——同一个人刷 100 次也只是 1 个访客，不会凭空多出榜位。
function weekHotActive(w, agg) {
  const engage = (agg.likes[w.id] || 0) + (agg.favs[w.id] || 0) + (agg.cmts[w.id] || 0)
    + (agg.tippers[w.id] ? agg.tippers[w.id].size : 0);
  if (engage > 0) return true;
  if (!VIEW_SCORE_PER_UV) return false;
  return workPvUv(w.id, WEEKHOT_DAYS).uv > 0;
}

// ---------- 高光榜：每件作品上架以来最亮的 7 天 ----------
// 定位是荣誉榜不是竞技榜：max(窗口) 随候选窗口数单调上升，老作品候选窗口多、天然占优——
// 这是设计意图不是缺陷：它补的正是本周热榜的洞（老作品没有本周互动就永远上不了热榜），
// 高光榜让每件作品的最好一周永久留档；新作品窗口不足 7 天按实际天数算，发布当天就能上榜。
// 防刷：热榜刷一次会被冲掉，这里刷一次就永久挂榜，所以设上榜门槛（窗口内访客数）。
// 误刷/误榜可走后台把作品下架，下架即出榜。
const PEAK_WINDOW_DAYS = 7;     // 窗口长度：与「新作周榜」同一个时间口径，作者容易理解；观察后想调就改这里
// 门槛支持 env 覆盖：本地演示数据访客很少，预览时用 PEAK_MIN_UV=1 就能看到榜
const PEAK_MIN_UV = Number(process.env.PEAK_MIN_UV) || 10;        // 上榜门槛：窗口内独立访客下限，把「发布当天朋友点几下」挡在榜外
// 互动门槛：2026-11-08 起默认 0（不再要求互动）。
// 原因：访客已按 ×2 计分，零互动作品进榜也有非零分数，不会出现一堆 0 分挂榜；
// 而站里互动本来就稀薄（投产 79 件里 50 件零赞零藏），要求互动只会把榜筛空。
// 想恢复「必须有过真实互动」：env PEAK_MIN_ENGAGE=1（或更大）。
const PEAK_MIN_ENGAGE = (() => {
  const raw = process.env.PEAK_MIN_ENGAGE;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();
const PEAK_NEW_ENTRY_DAYS = 7;  // 首次进榜 7 天内标「新晋」
const PEAK_TOP_N = 20;          // 记「首次进榜」的榜单深度（data/peak-board.json）
// 点赞 2026-11-07 起、灯火更晚才有时间戳：之前窗口这两项按 0 计，宁低不假；
// 收藏/评论全历史可回溯，老作品早期的高光照样能上榜（访问按「窗口访客×2」计分，见 VIEW_SCORE_PER_UV）。
let peakCache = { at: 0, data: null };
function peakAgg() {
  if (peakCache.data && Date.now() - peakCache.at < 60000) return peakCache.data;
  const likes = {}, favs = {}, cmts = {}, tipBy = {}, tipAmtBy = {};
  const dayOf = t => (t ? dateKey(new Date(t)) : null);
  for (const e of likeLog) {
    const d = e ? dayOf(e.t) : null; if (!d || !e.workId) continue;
    (likes[d] || (likes[d] = {}));
    likes[d][e.workId] = (likes[d][e.workId] || 0) + 1;
  }
  for (const e of favLog) {
    const d = e ? dayOf(e.t) : null; if (!d || !e.workId) continue;
    (favs[d] || (favs[d] = {}));
    favs[d][e.workId] = (favs[d][e.workId] || 0) + 1;
  }
  for (const c of comments) {
    if (!c || c.anon || !c.userId) continue;   // 与 commentScore 同口径：只数登录用户的评论
    const d = dayOf(c.createdAt); if (!d || !c.workId) continue;
    (cmts[d] || (cmts[d] = {}));
    cmts[d][c.workId] = (cmts[d][c.workId] || 0) + 1;
  }
  for (const t of tips) {
    if (!t || !t.createdAt || !t.workId) continue;
    const d = dayOf(t.createdAt);
    (tipBy[d] || (tipBy[d] = {}));
    (tipBy[d][t.workId] || (tipBy[d][t.workId] = new Set())).add(t.fromUserId || 'anon');
    (tipAmtBy[d] || (tipAmtBy[d] = {}));
    tipAmtBy[d][t.workId] = (tipAmtBy[d][t.workId] || 0) + (Number(t.amount) || 0);
  }
  // 作者自评按天就地扣除（与 commentScore「作者自评不计」同口径）
  const workById = new Map(works.map(w => [w.id, w]));
  const selfCmts = {};
  for (const c of comments) {
    if (!c || c.anon || !c.userId || !c.workId) continue;
    const w = workById.get(c.workId);
    if (!w || !w.userId || c.userId !== w.userId) continue;
    const d = dayOf(c.createdAt); if (!d) continue;
    const k = c.workId + '|' + d;
    selfCmts[k] = (selfCmts[k] || 0) + 1;
  }
  // 每件作品一条按天的增量序列（从上架日到今天）
  const series = new Map();
  const today = dateKey();
  for (const w of works) {
    const startT = new Date(w.createdAt).getTime();
    if (!isFinite(startT)) continue;
    const vrec = workVisits[w.id];
    const arr = [];
    for (let t = new Date(dateKey(new Date(startT)) + 'T12:00:00').getTime(),
      end = new Date(today + 'T12:00:00').getTime(); t <= end; t += 86400000) {
      const d = dateKey(new Date(t));
      const vd = vrec && vrec.days && vrec.days[d];
      arr.push({
        d,
        likes: (likes[d] && likes[d][w.id]) || 0,
        favs: (favs[d] && favs[d][w.id]) || 0,
        cmts: Math.max(0, ((cmts[d] && cmts[d][w.id]) || 0) - (selfCmts[w.id + '|' + d] || 0)),
        tips: (tipBy[d] && tipBy[d][w.id]) || null,
        tipAmt: (tipAmtBy[d] && tipAmtBy[d][w.id]) || 0,
        pv: vd ? (vd.pv || 0) : 0,
        uv: vd ? (vd.uv || null) : null
      });
    }
    if (arr.length) series.set(w.id, arr);
  }
  const data = { series };
  peakCache = { at: Date.now(), data };
  return data;
}
// 单作品最佳窗口：遍历所有长度 1..PEAK_WINDOW_DAYS 的连续窗口，按 by 择优。
// 返回 null = 没有任何窗口达到上榜门槛（不进高光榜）
function peakWindowOf(w, by) {
  const arr = peakAgg().series.get(w.id);
  if (!arr || !arr.length) return null;
  const cmp = (c, b) => {
    if (by === 'likes') return c.likes !== b.likes ? c.likes - b.likes : c.favs - b.favs;
    if (by === 'favs') return c.favs !== b.favs ? c.favs - b.favs : c.likes - b.likes;
    if (by === 'tips') return c.tippers !== b.tippers ? c.tippers - b.tippers
      : (c.tipAmt !== b.tipAmt ? c.tipAmt - b.tipAmt : c.score - b.score);
    if (by === 'pv') return c.pv !== b.pv ? c.pv - b.pv : c.score - b.score;
    if (by === 'uv') return c.uvN !== b.uvN ? c.uvN - b.uvN : c.score - b.score;
    return c.score - b.score;
  };
  let best = null;
  for (let i = 0; i < arr.length; i++) {
    let likes = 0, favs = 0, cmts = 0, tipAmt = 0, pv = 0;
    const tipSet = new Set(), uvSet = new Set();
    for (let j = i; j < arr.length && j < i + PEAK_WINDOW_DAYS; j++) {
      const x = arr[j];
      likes += x.likes; favs += x.favs; cmts += x.cmts; tipAmt += x.tipAmt; pv += x.pv;
      if (x.tips) x.tips.forEach(t => tipSet.add(t));
      if (x.uv) for (const k in x.uv) uvSet.add(k);
      const uvN = uvSet.size;
      if (uvN < PEAK_MIN_UV || (likes + favs + cmts + tipSet.size) < PEAK_MIN_ENGAGE) continue;
      const viewPart = viewPartOf(uvN);
      const cand = {
        score: likes * 5 + favs * 8 + cmts * 3 + tipSet.size * 10 + viewPart,
        likes, favs, cmts, tippers: tipSet.size, tipAmt, pv, uvN,
        from: arr[i].d, to: x.d, days: j - i + 1
      };
      // 分数打平时取更长的窗口：「高光区间」该给用户看最完整的那段，
      // 而不是刚好凑够分的那一截（访问分按人数算，多来几天的人本来也算分）
      const c = best ? cmp(cand, best) : 1;
      if (!best || c > 0 || (c === 0 && cand.days > best.days)) best = cand;
    }
  }
  return best;
}
// 「首次进榜」登记：每天第一次有人查高光榜时刷新一次（写 data/peak-board.json）。
// firstSeen = 首次进入前 PEAK_TOP_N 的日期；掉出榜再回来会重新记新晋，可接受（高光榜几乎只进不出）
let peakBoard = readJSON('peak-board.json', null);
function peakBoardRefresh(topIds) {
  const today = dateKey();
  if (!peakBoard || typeof peakBoard !== 'object' || Array.isArray(peakBoard)) peakBoard = { day: '', entries: {} };
  if (peakBoard.day === today) return;
  const old = peakBoard.entries || {};
  const entries = {};
  topIds.forEach(id => { entries[id] = old[id] || today; });
  peakBoard = { day: today, entries };
  writeJSON('peak-board.json', peakBoard);
}
function peakIsNewEntry(id) {
  const seen = peakBoard && peakBoard.entries && peakBoard.entries[id];
  if (!seen) return false;
  return Date.now() - new Date(seen + 'T12:00:00').getTime() < PEAK_NEW_ENTRY_DAYS * 86400000;
}
// 高光榜排序比较（x、y 都是 peakWindowOf 的结果）：返回正数表示 x 排前面
function peakCmpBy(x, y, by) {
  if (by === 'likes') return x.likes !== y.likes ? x.likes - y.likes : x.favs - y.favs;
  if (by === 'favs') return x.favs !== y.favs ? x.favs - y.favs : x.likes - y.likes;
  if (by === 'tips') return x.tippers !== y.tippers ? x.tippers - y.tippers
    : (x.tipAmt !== y.tipAmt ? x.tipAmt - y.tipAmt : x.score - y.score);
  if (by === 'pv') return x.pv !== y.pv ? x.pv - y.pv : x.score - y.score;
  if (by === 'uv') return x.uvN !== y.uvN ? x.uvN - y.uvN : x.score - y.score;
  return x.score - y.score;
}

// 榜单：period = week（近 7 天上架）/ month（近 30 天上架）/ all（全部·累计）/ weekhot（全站·本周增量）/ peak（高光榜·历史最佳 7 天）
// by = hot（综合）/ likes（点赞）/ favs（收藏）/ tips（打赏人数）/ pv / uv
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
// ================= 造梦勋章 =================
// 定位：勋章是「记录」不是「奖励」——点亮只写一个时间戳，既不发灯火也不进积分账本。
// 所以刷成就零收益：刷子费劲编一个「被拒稿再重做」的剧本，最后只换到一张图。
// 数据落 data/badges.json：
//   users:   { <userId>: { <badgeKey>: <点亮时间戳> } }   一律「拿过就留身上」，不做扣除
//   board:   { week|month|all|peak|weekhot: { workId, userId, at } }  各榜当前冠军（/api/rank 请求时登记）
//   applies: { <userId>: { <badgeKey>: { at, text } } }   L3 开放申请的几枚
const BADGE_FILE = 'badges.json';
let badgeData = readJSON(BADGE_FILE, null);
if (!badgeData || typeof badgeData !== 'object' || Array.isArray(badgeData)) badgeData = {};
for (const k of ['users', 'board', 'applies']) {
  if (!badgeData[k] || typeof badgeData[k] !== 'object' || Array.isArray(badgeData[k])) badgeData[k] = {};
}
let badgeSaveTimer = null;
function saveBadgesSoon() {
  if (badgeSaveTimer) return;
  badgeSaveTimer = setTimeout(() => {
    badgeSaveTimer = null;
    try { writeJSON(BADGE_FILE, badgeData); } catch (e) { console.error('badges 落盘失败：' + e.message); }
  }, 2000);
}

// 待处理的 L3 申请条数（后台 tab 角标用）
function countBadgeApplies() {
  let n = 0;
  for (const uid in badgeData.applies) {
    const box = badgeData.applies[uid];
    if (box && typeof box === 'object') n += Object.keys(box).length;
  }
  return n;
}

// 三层：L1 人人可得（管留存）、L2 有难度（代表能力）、L3 站长授予（造梦者名录）
const BADGE_TIER_DEFS = [
  { key: 'L1', name: '梦的开始', desc: '自动结算 · 人人可得 · 管留存' },
  { key: 'L2', name: '橱窗陈列', desc: '有难度 · 会稀缺 · 代表能力' },
  { key: 'L3', name: '造梦者名录', desc: '站长授予 · 开放的勋章可申请' }
];

// 文案在前端也有一份（预览页），以这里为准：接口直接下发 name/cond/note，前端不再维护第二份
const BADGE_DEFS = [
  { key: 'first_checkin', t: 'L1', icon: 'flame', name: '初入梦境', cond: '首次签到',
    note: '第一次推门进来，就算入梦了。以后来不来都随你，但这枚只有一次机会。' },
  { key: 'streak7', t: 'L1', icon: 'stars', name: '七日不醒', cond: '连续签到 7 天',
    note: '连着七天没醒过来。中间断了重新数，已经拿到的不会掉。' },
  { key: 'days20', t: 'L1', icon: 'door', name: '梦乡常客', cond: '累计签到 20 天',
    note: '不要求连续，来够二十天就行。断签不归零，慢慢攒。' },
  { key: 'comeback', t: 'L1', icon: 'back', name: '梦回旧地', cond: '断签 7 天后再连续签到 7 天',
    note: '走了一阵又回来的人，比一直没走的人更难得。这枚只奖回来，不罚离开。' },
  { key: 'night', t: 'L1', icon: 'moon', name: '三更造梦', cond: '凌晨 0 点至 5 点之间签到',
    note: '别人睡着的时候你还在做东西。一次就够，这枚是给夜里的那点力气。' },
  { key: 'wechat', t: 'L1', icon: 'phone', name: '掌上梦游', cond: '绑定微信（含小程序一键登录）',
    note: '把微信牵到账号上：网页里绑一次，或者用小程序一键登录，都算。之后口袋里也装着一座酒馆。' },

  { key: 'first_work', t: 'L2', icon: 'window', name: '橱窗开张', cond: '首次投稿并通过审核',
    note: '把自己的梦摆进橱窗。作品过审那天自动点亮。' },
  { key: 'works3', t: 'L2', icon: 'shelf', name: '三件成窗', cond: '累计 3 件作品过审',
    note: '一件是兴致，三件才撑得起一扇橱窗。不要求同类，也不要求连续。' },
  { key: 'views1000', t: 'L2', icon: 'chart', name: '千人驻足', cond: '单件作品访问量破 1000',
    note: '橱窗前有人停下脚步，才叫陈列。按作品累计访问算，不看点赞和收藏。' },
  { key: 'week_top', t: 'L2', icon: 'podium', name: '一梦当先', cond: '新作周榜第一名',
    note: '七天里最亮的那件新作。周榜每周重排，第一只有一个，拿过就留在身上。' },
  { key: 'month_top', t: 'L2', icon: 'crown', name: '独占一窗', cond: '月榜第一名',
    note: '一整个月，最好的位置就那一扇窗。每月重排，拿过就留在身上。' },
  { key: 'all_top', t: 'L2', icon: 'steps', name: '众梦之首', cond: '总榜第一名',
    note: '全站所有作品里排在最前的那一件。不是一周也不是一月，得一直有人记着它。' },
  { key: 'nanke', t: 'L2', icon: 'cloud', name: '南柯一梦', cond: '坐过高光榜第一，如今已被超越',
    note: '高光榜记的是每件作品最亮的七天。你那七天被人超过了，位置还在榜上留着——做过一场，醒来只剩这个。' },
  { key: 'github', t: 'L2', icon: 'link', name: '心有灵犀', cond: '绑定 GitHub 账号',
    note: '同一个名字，两边都认你。绑上那天自动点亮，不用标开源，也不用等审核。' },
  { key: 'opensource', t: 'L2', icon: 'code', name: '后院开放', cond: '绑定 GitHub 并标注作品开源',
    note: '橱窗在后头，后院也在后头。把代码放出来，别人才学得走。星级不算条件。' },
  { key: 'invite', t: 'L2', icon: 'pass', name: '带你入梦', cond: '邀请 1 位作者注册并投稿',
    note: '把人带进门，还得让他真的摆出一件梦。只算注册不算完成。' },
  { key: 'browse100', t: 'L2', icon: 'eye', name: '梦游橱窗', cond: '累计浏览 100 件作品',
    note: '光看不做也算数。比完就走、挨个点开都算，看客也有看客的勋章。' },
  { key: 'comment20', t: 'L2', icon: 'chat', name: '同梦之人', cond: '在他人作品下留言 20 条',
    note: '一句「我用了，好用」比点赞有用。自己作品下的留言不算。' },

  { key: 'veteran', t: 'L3', icon: 'key', name: '造梦元老', cond: '开站首批入驻作者',
    note: '橱窗里还只有几件作品的时候就在的人。名单封闭，不再新增。', by: '站长' },
  { key: 'first_window', t: 'L3', icon: 'flag', name: '开窗之人', cond: '站内最早 10 件作品的作者',
    note: '最早把东西摆上来的十个人。这扇橱窗是他们开的，一共十枚，不再新增。', by: '站长' },
  { key: 'idea_maker', t: 'L3', icon: 'hand', name: '圆梦之人', cond: '提的建议改动了产品本身',
    note: '不是提需求，是发现了问题并说清了怎么改。你的话让别人的梦更好做。', by: '站长', canApply: true },
  { key: 'guardian', t: 'L3', icon: 'shield', name: '守梦之人', cond: '长期维持站点秩序、带新人',
    note: '审核、答疑、劝架、补漏——这些没人看见的活，都是他们在撑。一年最多授几位。', by: '站长', canApply: true },
  // 铸梦之人：给参与本站开发的人（写代码 / 修 Bug / 补底层），和「圆梦之人」分开——
  // 那枚奖的是「说清了怎么改」，这枚奖的是「自己动手改了」。条件写「改动已并入站点」而不是
  // 「参与开发」，是为了有个能核的凭据：口头聊过不算，得真有一处改动落在站上。
  { key: 'forge_maker', t: 'L3', icon: 'hammer', name: '铸梦之人', cond: '参与本站开发，改动已并入站点',
    note: '写代码、修 Bug、补底层——这些活在页面上看不见，但橱窗能立住，是因为后面有人在打铁。', by: '站长', canApply: true }
];

// 把「某个人现在够不够格」需要的数据一次算完：20 枚勋章里十几枚都要扫作品/评论/访问，
// 分开写就是十几次全量遍历。数据量不大（几十件作品），但没必要每条都重扫一遍。
function badgeFacts(user) {
  const uid = user.id;
  const rec = shareRecOf(uid);
  const ck = rec.checkin || {};
  // 签到流水：老数据没有逐日记录，只能靠积分流水里的 checkin 条目兜底（上限 60 条，够到 20 天门槛）
  const logs = (Array.isArray(rec.log) ? rec.log : []).filter(e => e && e.kind === 'checkin' && e.t);
  const ckDays = Math.max(Number(ck.days || 0), logs.length, ck.last ? 1 : 0);
  const bestStreak = Math.max(Number(ck.maxStreak || 0), Number(ck.streak || 0));
  const nightAt = Number(ck.nightAt || 0) || logs.reduce((hit, e) => {
    if (hit) return hit;
    const h = new Date(e.t).getHours();
    return h >= 0 && h < 5 ? e.t : 0;
  }, 0);
  // 断签 7 天、回来又连签 7 天：新字段优先；历史数据用流水里的签到日期序列倒推
  let comeback = !!(Number(ck.backGap || 0) >= 7 && Number(ck.backStreak || 0) >= 7);
  if (!comeback && logs.length > 1) {
    const days = [...new Set(logs.map(e => dateKey(new Date(e.t))))].sort();
    for (let i = 1; i < days.length && !comeback; i++) {
      const gap = Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400e3);
      if (gap < 8) continue;
      let run = 1;
      for (let j = i + 1; j < days.length; j++) {
        if (Math.round((Date.parse(days[j]) - Date.parse(days[j - 1])) / 86400e3) !== 1) break;
        run++;
      }
      if (run >= 7) comeback = true;
    }
  }
  const mine = works.filter(w => w.userId === uid && !w.deleted);
  const approved = mine.filter(w => isPublished(w));
  const maxPv = mine.reduce((m, w) => Math.max(m, (workPvUv(w.id, 36500) || {}).pv || 0), 0);
  // 浏览过的作品数：work-visits 的 uv 键里有 u:<uid> 就说明这个人点开过（uv 不按天过期）
  let browsed = 0;
  const uvKey = 'u:' + uid;
  for (const id in workVisits) {
    const v = workVisits[id];
    if (v && v.uv && v.uv[uvKey]) browsed++;
  }
  // 在别人作品下的留言：排除匿名（匿名没有 userId 也算不出）和自己的作品
  const ownerOf = new Map(works.map(w => [w.id, w.userId]));
  const myCmts = comments.filter(c => c && !c.anon && c.userId === uid
    && ownerOf.get(c.workId) && ownerOf.get(c.workId) !== uid).length;
  // 邀请：只有一端记录 invitedBy（被邀请人身上），被邀请人还得真投过稿
  const invitedOk = users.some(u => u.invitedBy === user.username
    && works.some(w => w.userId === u.id && !w.deleted));
  return {
    ckDays, bestStreak, nightAt, comeback,
    wechat: !!(user.wechat && user.wechat.openid),
    github: !!(user.github && user.github.id),
    opensource: !!(user.github && user.github.id) && mine.some(w => w.openSource === true),
    approved: approved.length,
    maxPv,
    invite: invitedOk,
    browsed,
    comments: myCmts,
    badges: badgeData.users[uid] || {}
  };
}

// 每枚勋章的进度：ok = 够格；now/goal 都有值时前端画进度条
function badgeProgress(key, f) {
  switch (key) {
    case 'first_checkin': return { ok: f.ckDays >= 1, now: f.ckDays, goal: 1 };
    case 'streak7':       return { ok: f.bestStreak >= 7, now: f.bestStreak, goal: 7 };
    case 'days20':        return { ok: f.ckDays >= 20, now: f.ckDays, goal: 20 };
    case 'comeback':      return { ok: f.comeback };
    case 'night':         return { ok: !!f.nightAt };
    case 'wechat':        return { ok: f.wechat };
    case 'first_work':    return { ok: f.approved >= 1, now: f.approved, goal: 1 };
    case 'works3':        return { ok: f.approved >= 3, now: f.approved, goal: 3 };
    case 'views1000':     return { ok: f.maxPv >= 1000, now: f.maxPv, goal: 1000 };
    case 'week_top':      return { ok: !!f.badges.week_top };
    case 'month_top':     return { ok: !!f.badges.month_top };
    case 'all_top':       return { ok: !!f.badges.all_top };
    case 'nanke':         return { ok: !!f.badges.nanke };
    case 'github':        return { ok: f.github };
    case 'opensource':    return { ok: f.opensource };
    case 'invite':        return { ok: f.invite };
    case 'browse100':     return { ok: f.browsed >= 100, now: f.browsed, goal: 100 };
    case 'comment20':     return { ok: f.comments >= 20, now: f.comments, goal: 20 };
    default:              return { ok: false };   // L3 只能手授
  }
}

// 点亮一枚：一次性，拿过不再重发。silent = 只在用户主动打开勋章页补录，不推通知
// （第一次进页面可能一口气补上五六枚，全推通知会刷屏）
function awardBadge(uid, key, silent) {
  if (!uid) return false;
  const def = BADGE_DEFS.find(d => d.key === key);
  if (!def) return false;
  const rec = badgeData.users[uid] || (badgeData.users[uid] = {});
  if (rec[key]) return false;
  rec[key] = Date.now();
  saveBadgesSoon();
  if (!silent) {
    try {
      addNotice(uid, {
        kind: 'system',
        key: 'badge:' + key,
        title: '点亮勋章 · ' + def.name,
        text: '「' + def.name + '」：' + def.cond,
        link: '/medals'
      });
    } catch (e) { /* 通知失败不影响点亮 */ }
  }
  return true;
}

// 榜单冠军登记：/api/rank 每次算出结果时顺手比一下（只比 workId，没变就 return，开销接近 0）
// 只有「综合榜 + 没加形态筛选」才算数——切到点赞榜的第一名不是这枚勋章要的那个人。
// 站内有种子作品（seed*）没有 userId，够不到任何人；这类作品排在前面时不能把整枚勋章堵死，
// 所以取「榜单上第一个有主的作品」算冠军——文案说的还是那个榜的第一，只是不认无主作品。
function recordChampion(period, sorted) {
  const w = (sorted || []).find(x => x && x.userId);
  if (!w) return;
  const prev = badgeData.board[period];
  if (prev && prev.workId === w.id) return;
  badgeData.board[period] = { workId: w.id, userId: w.userId, at: Date.now() };
  if (period === 'week') awardBadge(w.userId, 'week_top');
  else if (period === 'month') awardBadge(w.userId, 'month_top');
  else if (period === 'all') awardBadge(w.userId, 'all_top');
  else if (period === 'peak') {
    // 高光榜是「每件作品最亮的七天」，只涨不跌：冠军被换掉只有一种可能——有人做出了更亮的七天。
    // 这枚不发给新冠军，发给旧冠军：你坐过那个位置，如今被超过了，这才是南柯。
    if (prev && prev.userId && prev.userId !== w.userId) awardBadge(prev.userId, 'nanke');
  }
  saveBadgesSoon();
}

// 开窗之人：站内最早 10 件作品的作者，启动时自动结算。
// 幂等（awardBadge 拿过不重发），每次启动都跑一遍也没副作用；种子作品（seed*）无主，天然被过滤。
// 只排除已删除的：哪怕作品后来转回草稿/待审，它「最早摆上来」的事实不变。
function awardFirstWindowBadges() {
  const early = works.filter(w => w && w.userId && !w.deleted)
    .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
    .slice(0, 10);
  let n = 0;
  for (const w of early) if (awardBadge(w.userId, 'first_window')) n++;
  if (n) console.log('[badges] 开窗之人 自动授予 ' + n + ' 人');
}
awardFirstWindowBadges();

// 组装给前端的完整列表：state(on/doing/off) + 点亮时间 + 进度 + 申请状态
function computeBadges(user) {
  const f = user ? badgeFacts(user) : null;
  return BADGE_DEFS.map(def => {
    const out = { ...def };
    if (!user) return { ...out, state: 'off' };
    const at = (badgeData.users[user.id] || {})[def.key];
    const p = badgeProgress(def.key, f);
    // 已经够格但还没记过（比如上线前就签过 20 天）：这次访问补录一条，不推通知
    if (!at && p.ok) { awardBadge(user.id, def.key, true); }
    const stamp = at || (p.ok ? Date.now() : 0);
    if (stamp) {
      out.state = 'on';
      out.at = dateKey(new Date(stamp));
    } else if (p.goal) {
      out.state = 'doing';
      out.now = p.now;
      out.goal = p.goal;
    } else {
      out.state = 'off';
    }
    const ap = (badgeData.applies[user.id] || {})[def.key];
    if (ap) out.applied = { at: dateKey(new Date(ap.at)), text: ap.text || '' };
    return out;
  });
}

app.get('/api/me/badges', (req, res) => {
  const user = currentUser(req);
  res.set('Cache-Control', 'no-store');
  const badges = computeBadges(user);
  res.json({
    loggedIn: !!user,
    name: user ? displayNameOf(user.username) : '',
    tiers: BADGE_TIER_DEFS,
    tally: { on: badges.filter(b => b.state === 'on').length, total: badges.length },
    badges
  });
});

// L3 里开放申请的两枚：提交一段说明，等站长在后台看
app.post('/api/me/badges/apply', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('badgeapply:' + user.id, 5, 60000)) return res.status(429).json({ error: '操作太频繁，稍等一下' });
  const key = String((req.body || {}).key || '');
  const text = String((req.body || {}).text || '').replace(/[<>]/g, '').trim().slice(0, 200);
  const def = BADGE_DEFS.find(d => d.key === key);
  if (!def || !def.canApply) return res.status(400).json({ error: '这枚不能申请' });
  if (!text) return res.status(400).json({ error: '写两句吧，站长得知道为什么该给你' });
  const box = badgeData.applies[user.id] || (badgeData.applies[user.id] = {});
  if (box[key]) return res.status(400).json({ error: '已经提交过了，等站长看一眼' });
  box[key] = { at: Date.now(), text };
  saveBadgesSoon();
  res.json({ ok: true, badges: computeBadges(user) });
});

app.delete('/api/me/badges/apply/:key', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const box = badgeData.applies[user.id];
  if (box && box[req.params.key]) {
    delete box[req.params.key];
    saveBadgesSoon();
  }
  res.json({ ok: true, badges: computeBadges(user) });
});

// 站长授予 / 撤销（L3 专用，L1/L2 一律自动结算，不给后台留手改的口子）
app.post('/api/admin/badges', requireAdmin, (req, res) => {
  const body = req.body || {};
  const action = body.action === 'revoke' ? 'revoke' : 'grant';
  const def = BADGE_DEFS.find(d => d.key === String(body.key || ''));
  if (!def) return res.status(400).json({ error: '没有这枚勋章' });
  if (def.t !== 'L3') return res.status(400).json({ error: 'L1/L2 自动结算，不能手授' });
  const u = users.find(x => x.username === String(body.username || '') || x.id === String(body.userId || ''));
  if (!u) return res.status(404).json({ error: '找不到这个用户' });
  // 只清掉申请、不发勋章：后台看完了觉得不合适，把这条从队列里划掉
  if (body.action === 'ignore') {
    const box = badgeData.applies[u.id];
    if (box && box[def.key]) { delete box[def.key]; saveBadgesSoon(); }
    return res.json({ ok: true, action: 'ignore', key: def.key, username: u.username });
  }
  if (action === 'revoke') {
    const rec = badgeData.users[u.id];
    if (rec && rec[def.key]) { delete rec[def.key]; saveBadgesSoon(); }
    if (badgeData.applies[u.id]) { delete badgeData.applies[u.id][def.key]; saveBadgesSoon(); }
    return res.json({ ok: true, action, key: def.key, username: u.username });
  }
  awardBadge(u.id, def.key);
  if (badgeData.applies[u.id]) { delete badgeData.applies[u.id][def.key]; saveBadgesSoon(); }
  res.json({ ok: true, action, key: def.key, username: u.username, name: def.name });
});

// 后台看申请队列（谁申请了哪枚、写了什么）
app.get('/api/admin/badges/applies', requireAdmin, (req, res) => {
  const rows = [];
  for (const uid in badgeData.applies) {
    const u = users.find(x => x.id === uid);
    if (!u) continue;
    for (const key in badgeData.applies[uid]) {
      const def = BADGE_DEFS.find(d => d.key === key);
      const ap = badgeData.applies[uid][key];
      rows.push({
        userId: uid, username: u.username, name: displayNameOf(u.username),
        key, badge: def ? def.name : key, at: ap.at, text: ap.text || ''
      });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  res.json(rows);
});

// 后台一览：每枚勋章现在有多少人拿到、最近几个人是谁、四个榜的当前冠军。
// 后台不需要「谁够格但还没点亮」——那是前台打开勋章页时自动补录的事，这里只看结果。
app.get('/api/admin/badges/overview', requireAdmin, (req, res) => {
  const counts = {}, holders = {};
  BADGE_DEFS.forEach(d => { counts[d.key] = 0; holders[d.key] = []; });
  for (const uid in badgeData.users) {
    const rec = badgeData.users[uid];
    if (!rec || typeof rec !== 'object') continue;
    const u = users.find(x => x.id === uid);
    for (const key in rec) {
      if (!Object.prototype.hasOwnProperty.call(counts, key)) continue;
      counts[key]++;
      if (u) holders[key].push({ username: u.username, name: displayNameOf(u.username), at: rec[key] });
    }
  }
  Object.keys(holders).forEach(k => holders[k].sort((a, b) => (b.at || 0) - (a.at || 0)));
  const board = {};
  for (const p in badgeData.board) {
    const b = badgeData.board[p] || {};
    const w = works.find(x => x.id === b.workId);
    const u = users.find(x => x.id === b.userId);
    board[p] = {
      period: p, workId: b.workId || '', userId: b.userId || '', at: b.at || 0,
      title: w ? w.title : '', username: u ? u.username : ''
    };
  }
  res.json({ tiers: BADGE_TIER_DEFS, defs: BADGE_DEFS, counts, holders, board, pending: countBadgeApplies() });
});

app.get('/api/rank', (req, res) => {
  const period = ['week', 'month', 'all', 'weekhot', 'peak'].includes(req.query.period) ? req.query.period : 'week';
  const by = Object.prototype.hasOwnProperty.call(RANK_BY, req.query.by) ? req.query.by : 'hot';
  const limit = Math.min(100, parseInt(req.query.limit) || 10);
  // 形态筛选（可选）：与首页 /api/works 同一口径，按 typesOf 命中才算
  const type = (req.query.type || '').trim();
  // 分类筛选（可选）：作品分类是多选（categories 1-3 个），命中任意一个就算；
  // 「全部」当没传处理，与首页 /api/works 的 category 参数同名同口径
  const catRaw = (req.query.category || '').trim();
  const cat = catRaw && catRaw !== '全部' ? catRaw : '';
  const isWeekHot = period === 'weekhot';
  const isPeak = period === 'peak';
  const days = period === 'week' || isWeekHot ? 7 : period === 'month' ? 30 : 36500;
  const since = Date.now() - days * 86400000;
  const today = dateKey();
  const user = currentUser(req);
  const usePvUv = by === 'pv' || by === 'uv';
  const metric = w => workPvUv(w.id, days)[by];
  const agg = isWeekHot ? weekAgg() : null;
  // peak 时 likes/favs/tips 一律取最佳窗口内的增量，行内「N 人点赞」等文案口径才一致
  const peakMemo = new Map();
  const bestOf = w => {
    if (!peakMemo.has(w.id)) peakMemo.set(w.id, peakWindowOf(w, by));
    return peakMemo.get(w.id);
  };
  // weekhot 时 likes/favs/tips 一律取本周增量，行内「N 人点赞」等文案口径才一致
  const wkLikes = w => agg.likes[w.id] || 0;
  const wkFavs = w => agg.favs[w.id] || 0;
  const wkTippers = w => agg.tippers[w.id] ? agg.tippers[w.id].size : 0;
  const wkTipAmt = w => agg.tipAmt[w.id] || 0;
  const scoreMemo = new Map();
  const hotOf = w => {
    if (!scoreMemo.has(w.id)) scoreMemo.set(w.id, weekHotScore(w, agg));
    return scoreMemo.get(w.id);
  };
  let pool = publicWorks(req);
  if (isWeekHot) {
    // 本周热榜：不看上架时间，只看本周有没有互动（老作品也能上榜）
    pool = pool.filter(w => weekHotActive(w, agg));
  } else if (isPeak) {
    // 高光榜：不看上架时间，只看有没有一个窗口达到上榜门槛（老作品的最好一周永久有效）
    pool = pool.filter(w => bestOf(w));
  } else {
    pool = pool.filter(w => new Date(w.createdAt).getTime() >= since);
  }
  const sorted = pool.filter(w => !type || type === '全部' || typesOf(w).includes(type))
    .filter(w => !cat || catsOf(w).includes(cat))
    .sort((a, b) => {
      if (usePvUv) return metric(b) - metric(a) || new Date(b.createdAt) - new Date(a.createdAt);
      if (isPeak) return peakCmpBy(bestOf(b), bestOf(a), by) || new Date(b.createdAt) - new Date(a.createdAt);
      if (isWeekHot) {
        if (by === 'likes') return wkLikes(b) - wkLikes(a) || wkFavs(b) - wkFavs(a) || hotOf(b) - hotOf(a);
        if (by === 'favs') return wkFavs(b) - wkFavs(a) || wkLikes(b) - wkLikes(a) || hotOf(b) - hotOf(a);
        if (by === 'tips') return wkTippers(b) - wkTippers(a) || wkTipAmt(b) - wkTipAmt(a) || hotOf(b) - hotOf(a);
        return hotOf(b) - hotOf(a) || new Date(b.createdAt) - new Date(a.createdAt);
      }
      return RANK_BY[by](a, b) || new Date(b.createdAt) - new Date(a.createdAt);
    });
  // 高光榜：把今天的前 PEAK_TOP_N 登记进「首次进榜」名册（每天只写一次盘），新面孔据此标「新晋」
  // 加了形态/分类筛选时不算：筛出来的前 20 只是子集，拿它登记会把没进过全榜的作品误标「新晋」
  const filtered = !!type || !!cat;
  if (isPeak && !filtered) peakBoardRefresh(sorted.slice(0, PEAK_TOP_N).map(w => w.id));
  // 勋章登记：只有「综合榜 + 没加形态/分类筛选」时，第一名才是那一榜的第一名（切到点赞榜不算）
  if (!filtered && by === 'hot') recordChampion(period, sorted);
  const list = sorted.slice(0, limit)
    .map((w, i) => {
      const best = isPeak ? bestOf(w) : null;
      const m = workPvUv(w.id, days);
      if (isPeak) {
        return {
          ...publicWork(w, user), rank: i + 1,
          pv: best.pv, uv: best.uvN,
          hotScore: best.score, likes: best.likes, favs: best.favs, tipsTippers: best.tippers,
          peakFrom: best.from, peakTo: best.to, peakDays: best.days,
          isNewEntry: peakIsNewEntry(w.id),
          isNew: dateKey(new Date(w.createdAt)) === today
        };
      }
      return {
        ...publicWork(w, user), rank: i + 1, pv: m.pv, uv: m.uv,
        hotScore: isWeekHot ? hotOf(w) : score(w),
        tipsTippers: isWeekHot ? wkTippers(w) : tipTippersOf(w.id),
        ...(isWeekHot ? { likes: wkLikes(w), favs: wkFavs(w) } : {}),
        isNew: dateKey(new Date(w.createdAt)) === today
      };
    });
  res.json(list);
});

// 榜单形态下拉的条数：按所选周期统计，与 /api/rank 完全同一套过滤口径（上架时间 + 公开）。
// 否则下拉里的数字是全站总量，「周榜 + Web」显示 14 件、列表里其实只有 8 件，口径对不上。
app.get('/api/rank/counts', (req, res) => {
  const period = ['week', 'month', 'all', 'weekhot', 'peak'].includes(req.query.period) ? req.query.period : 'week';
  const isWeekHot = period === 'weekhot';
  const days = period === 'week' || isWeekHot ? 7 : period === 'month' ? 30 : 36500;
  const since = Date.now() - days * 86400000;
  const counts = {};
  const cats = {};   // 分类口径：一件作品可属多个分类，各计一次（与首页分类下拉同一算法）
  let total = 0;
  const pool = publicWorks(req);
  const hit = isWeekHot
    ? w => weekHotActive(w, weekAgg())          // 本周热榜：本周有互动的作品
    : period === 'peak'
      ? w => !!peakWindowOf(w, 'hot')           // 高光榜：有一个窗口达到上榜门槛
      : w => new Date(w.createdAt).getTime() >= since;   // 周榜/月榜：周期内上架
  pool.filter(hit).forEach(w => {
    total++;
    typesOf(w).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    catsOf(w).forEach(c => { cats[c] = (cats[c] || 0) + 1; });
  });
  res.json({ period, total, counts, cats });
});

// 今日动态：给榜单页一行「今天站里发生了什么」的聚合数字。
// 只报总量、不做排名——站点体量还小时，日榜和「较昨日涨跌」都会被一两次偶然互动主导；
// 聚合数字即使今天只有 1 件新作品也不显空，还能给老访客一个回来的理由。
app.get('/api/today', (req, res) => {
  const today = dateKey();
  const onToday = t => t != null && dateKey(new Date(t)) === today;
  // 近 7 天口径：网页/小程序榜单页的动态条用，原 today 字段保留。
  // 2026-11-09 从「now - 7×24h 比时间戳」改成自然日：今天 + 前 6 天共 7 天，
  // 四个数字共用同一个日期边界。原来访客数按天桶汇总时会把第 8 个自然日整段算进来
  // （now-7d 落在某天的白天，那天的桶仍 > 边界），比另外三项多一天。
  const weekFrom = dateKey(new Date(Date.now() - 6 * 86400000));
  const onWeek = t => t != null && dateKey(new Date(t)) >= weekFrom;
  const publicIds = new Set(publicWorks(req).map(w => w.id));
  const day = (visits && visits.days && visits.days[today]) || {};
  // 近 7 天访客 = 各天 uv 键的并集（访问统计按天落盘，跨天去重在这里做）
  const weekUv = new Set();
  Object.entries((visits && visits.days) || {}).forEach(([k, d]) => {
    if (k < weekFrom) return;
    Object.keys((d && d.uv) || {}).forEach(x => weekUv.add(x));
  });
  const excl = visitExcludeSet();
  res.json({
    date: today,
    works: publicWorks(req).filter(w => onToday(w.createdAt)).length,
    tips: tips.filter(t => onToday(t.createdAt)).reduce((n, t) => n + (Number(t.amount) || 0), 0),
    comments: comments.filter(c => onToday(c.createdAt) && publicIds.has(c.workId)).length,
    visitors: day.uv ? Object.keys(day.uv).filter(k => !excl.has(k)).length : 0,
    week: {
      works: publicWorks(req).filter(w => onWeek(w.createdAt)).length,
      tips: tips.filter(t => onWeek(t.createdAt)).reduce((n, t) => n + (Number(t.amount) || 0), 0),
      comments: comments.filter(c => onWeek(c.createdAt) && publicIds.has(c.workId)).length,
      visitors: [...weekUv].filter(k => !excl.has(k)).length
    }
  });
});

// 访问分：按「访客人数 × 2」计。不看访问次数——同一台设备刷新 500 次也只是 1 个访客；
// 访客的口径三端统一（登录按账号 / 小程序按设备 / 网页·H5·App 按本机标识），
// 所以网页端和 App 里的访问现在跟小程序一样，都能被公平地算进来。
function viewScore(w) {
  if (!VIEW_SCORE_PER_UV) return 0;
  return viewPartOf(workPvUv(w.id, 36500).uv || 0);
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
// 综合分 = 获赞×5 + 收藏×8 + 评论×3 + 灯火人数×10 + 访客人数×2（规则同时在榜单页图例里对用户写明）。
// 四项互动都是「登录账号一人一票」：账号维度换端不变，这是榜单能被用户信的前提；
// 访问那一项也是「一人一票」（设备/账号维度），同一个人多刷几次不会多拿分。
// 评论权重 3 分（2026-11-08 由 1 上调）：想让「引发讨论」在排名里真有分量，1 分连一次点赞都比不上，
// 而评论的成本远高于点赞。只数登录用户的评论、作者自评不计（见 commentScore），刷不上去。
// 灯火计分按「送过灯火的人数」：同一人送多笔只算 1 份，和获赞/收藏一样是「一人一票」，
// 避免单笔大额打赏直接碾压真实口碑；匿名/未认领作品收到的灯火同样计分（送礼必须登录，都有人头）
function score(w) { return (w.likes || 0) * 5 + (w.favs || 0) * 8 + commentScore(w) * 3 + tipTippersOf(w.id) * 10 + viewScore(w); }

// 作者主页（创作者档案页）
// 2026-11-12 扩展：除了作品列表，把「这位创作者值不值得关注」的信号一次算全——
// 勋章（挂 userId，L1/L2 自动结算、L3 站长授予）、入驻时间（首件作品）、
// 访客/灯火/评论合计、常写分类、GitHub 头像。都是站内已有的真实数据，不造新概念。
app.get('/api/authors/:name', (req, res) => {
  // 参数兼容两套：新链接传账号 id，老链接传账号名——userByRef 先 id 后名字
  const refUser = userByRef(req.params.name);
  const name = refUser ? refUser.username : req.params.name;
  const user = currentUser(req);
  const all = filterBlocked(worksOfAuthorName(name).filter(w => isVisible(w)), user);
  const list = all.slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(w => publicWork(w, user));
  // 勋章挂在账号 userId 上：取该作者任一有主作品的 userId（同一作者作品必然同一账号）
  const acct = refUser || users.find(x => x.username === name);
  const uid = (acct && acct.id) || (all.find(w => w.userId) || {}).userId || '';
  const badgeRec = uid ? (badgeData.users[uid] || {}) : {};
  const badges = BADGE_DEFS.filter(d => badgeRec[d.key])
    .map(d => ({ key: d.key, name: d.name, icon: d.icon, t: d.t }));
  // 常写分类：按作品出现次数取前 4
  const catCount = {};
  all.forEach(w => catsOf(w).forEach(c => { catCount[c] = (catCount[c] || 0) + 1; }));
  const cats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([c, n]) => ({ name: c, n }));
  // 入驻时间 = 最早一件可见作品的上架时间（没有创建时间的旧数据跳过）
  const times = all.map(w => w.createdAt && Date.parse(w.createdAt)).filter(Boolean);
  const since = times.length ? Math.min(...times) : null;
  // 访客合计是「各作品访客相加」，同一访客看过多件会重复计入——文案上写「人次口径」的访客
  res.json({
    name,
    uid,   // 前端「是不是我自己的主页」按 id 判断（链接已经不认账号名了）
    slug: slugOf(acct),   // 作者现用个性地址（空 = 还在用 /u/<账号id>）；前端据它在 SPA 站内跳转后把地址栏矫正成 canonical
    displayName: displayNameOf(name),
    tags: userTagsOf(name),
    avatar: avatarUrlOf(acct),
    since,
    total: list.length,
    totalLikes: list.reduce((s, w) => s + w.likes, 0),
    totalFavs: list.reduce((s, w) => s + (w.favs || 0), 0),
    totalUv: all.reduce((s, w) => s + (workPvUv(w.id, 36500).uv || 0), 0),
    totalTips: all.reduce((s, w) => s + tipTippersOf(w.id), 0),
    totalComments: all.reduce((s, w) => s + (commentStats().scoreable[w.id] || 0), 0),
    openCount: all.filter(w => w.openSource === true).length,
    badges,
    cats,
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
  const user = currentUser(req);
  // 后台口令（admin cookie）与前台站长账号等价：都能看未过审 / 已下架的作品，
  // 站长账号没有后台 cookie 时也要能进来编辑（站长在前台用的就是自己的登录账号）
  const adminView = isAdmin(req) || isSiteOwner(user);
  // 预告 / 平台上架审核中的作品也允许打开详情（只是 CTA 和链接行为不同），
  // 站内待审（pending）与被下架（rejected）只有管理员 / 站长能看
  if (!w || (!isPublished(w) && !adminView)) return res.status(404).json({ error: '作品不存在或未通过审核' });
  // 作者自主下架的作品：只有作者本人和管理员 / 站长能打开详情，其他人一律 404
  const isOwner = !!(user && w.userId && user.id === w.userId);
  if (w.hidden && !adminView && !isOwner) return res.status(404).json({ error: '作品不存在或未通过审核' });
  // 闭源/未标注的作品同样对外可访问（2026-11-04 起可见性不再按开源卡，开源只是徽章+筛选）
  // 这里只取数据、不再计浏览：浏览改由 POST /api/track 那条带过滤的门统一 +1，
  // 否则接口多调一次（预取、重试、脚本）就等于多一个人打开。
  // 详情才渲染简介 HTML（列表页不带，省流量）；渲染器只输出白名单标签，用户 HTML 全部转义
  // myVote：当前身份在这件作品上投过的三选一反馈，前端用来高亮已选项
  const vid = user ? 'u:' + user.id : 'ip:' + ipKeyOf(req);
  const mineVote = comments.find(c => c.workId === w.id && c.vote && c.vid === vid);
  const out = { ...publicWork(w, user), introHtml: md.render(w.prompt || ''), myVote: mineVote ? mineVote.vote : null };
  // 相关作品：详情弹窗底部的站内导流（同分类优先，不够补同作者）。
  // 只是展示用的小卡，4 件足够，别把弹窗撑成第二个列表页。
  out.related = relatedWorksOf(w, user, 4);
  // 站长编辑回填：灯火解锁的作品在普通详情里 link / 二维码是空的，直接拿去回填会把它们存丢。
  // 只有「站长 + ?edit=1」这一条路径下发未锁定值，普通浏览（含站长本人看详情）仍按解锁状态走。
  if (out.adminEdit && req.query.edit === '1') {
    out.link = w.link || '';
    out.site = w.site || '';
    out.qrcode = w.qrcode || '';
    if (w.links && Object.keys(w.links).length) out.links = w.links; else delete out.links;
    out.lampLocked = false;
  }
  res.json(out);
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

// ---------- 图片内容安全（img_sec_check v1，同步） ----------
// UGC 图片与文字同一道官方闸：87014 判违规直接拒。接口约定：
//   · multipart/form-data，字段名 media，单图 ≤1MB（超了用 sharp 出一张压缩稿送检，不动原文件；
//     GIF 转 JPEG 只送首帧检测——首帧违规同样拒，漏检面可接受）
//   · v2（media_check_async）是异步 + 强制 openid + 消息推送回调，PC 匿名上传没有 openid，
//     站内也没有统一的异步回调面，先不接（与 msgSecCheck 无 openid 走 v1 同一取舍）
// 未配置凭据 / sharp 不可用 / 接口异常 → pass=null 降级（AI 审、人工审兜底），绝不因接口抖动卡死投稿
const IMG_CHECK_MAX_BYTES = 1024 * 1024;
async function wechatImgCheckBuffer(buf, mime) {
  let token = '';
  try { token = await wechatAccessToken(); } catch (e) { /* 拿不到 token 就跳过官方检测 */ }
  if (!token || token === 'mock_token') return { pass: null, note: '未配置微信凭据，跳过图片检测' };
  try {
    if (buf.length > IMG_CHECK_MAX_BYTES && sharpLib) {
      buf = await sharpLib(buf).rotate()
        .resize({ width: 854, withoutEnlargement: true })
        .jpeg({ quality: 60 }).toBuffer();
      mime = 'image/jpeg';
    }
    if (buf.length > IMG_CHECK_MAX_BYTES) return { pass: null, note: '图片超 1M 且无法压缩，跳过检测' };
    const form = new FormData();
    form.append('media', new Blob([buf], { type: mime }), mime === 'image/png' ? 'image.png' : 'image.jpg');
    const r = await fetch('https://api.weixin.qq.com/wxa/img_sec_check?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      body: form
    });
    const d = await r.json().catch(() => null);
    if (d && d.errcode === 87014) return { pass: false, note: '微信图片安全判定违规', at: new Date().toISOString() };
    if (!d || d.errcode !== 0) return { pass: null, note: 'imgSecCheck errcode ' + (d && d.errcode) + '，继续 AI 审核', at: new Date().toISOString() };
    return { pass: true, note: '图片检测通过', at: new Date().toISOString() };
  } catch {
    return { pass: null, note: 'imgSecCheck 调用失败，继续 AI 审核', at: new Date().toISOString() };
  }
}

// 校验一次投稿/编辑里新上传的图片（image/thumb/qrcode/images 任一判违规即整单拒绝）。
// 只查本次请求新传的文件：草稿、老作品里已存的图在上传那次已经查过，发布时不重复烧配额。
async function wechatImgCheckUploads(req) {
  const files = req.files || {};
  const list = [
    ...(files.image || []), ...(files.thumb || []), ...(files.qrcode || []), ...(files.images || [])
  ];
  for (const f of list) {
    let buf;
    try { buf = await fs.promises.readFile(f.path); } catch { continue; }
    if (!buf || !buf.length) continue;
    const ext = (path.extname(f.originalname || f.filename || '') || '').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    const r = await wechatImgCheckBuffer(buf, mime);
    if (r.pass === false) return r;
  }
  return { pass: true, note: '' };
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
// ruleSrc：降级时给规则用的文本（网址模式传去掉「网页标题：」等标签的纯文本，标签会被当成内容抄进简介）
async function extractFromText(text, ruleSrc) {
  const ai = await aiParseWork(text);
  if (ai.blocked) return { blocked: true };
  let out;
  if (ai.ok) out = { ...sanitizeParsed(ai.raw, text), source: 'ai', degraded: false, reason: '' };
  else {
    const r = ruleParseWork(ruleSrc || text);
    out = { ...r, missing: missingFields(r), source: 'rules', degraded: true, reason: ai.reason || 'AI 暂不可用' };
  }
  // 关键词跟着一起给（AI 不参与）：拿识别出来的名字 / 简介 / 分类走本地词表，
  // 回填到表单后作者还能改。AI 版的 summary 比原文更精炼，命中的词也更准。
  out.keywords = autoKeywords({ title: out.name, prompt: out.summary, categories: out.categories, types: out.types });
  return { out };
}
// 关键词建议：投稿表单「自动生成 / 标题填完先配几个」用。
// 纯本地规则（见 keywords.js），不碰 AI、不花钱，所以限流松一点，作者反复点也不会卡。
app.post('/api/work/keywords', (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 100);
  const prompt = String(b.prompt || '').slice(0, 3000);
  const cats = parseCats(b.categories);
  const types = b.types ? normalizeTypes(b.types) : [];
  if (!title && !prompt && !cats.length) return res.json({ keywords: [] });
  if (!rateLimit('kwgen:' + clientIp(req), 60, 60000)) return res.status(429).json({ error: '点太快了，缓一下再试' });
  res.json({ keywords: autoKeywords({ title, prompt, categories: cats, types }) });
});

app.post('/api/work/parse', async (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\r\n?/g, '\n').trim();
  if (text.length < PARSE_TEXT_MIN) return res.status(400).json({ error: `至少写 ${PARSE_TEXT_MIN} 个字再识别` });
  if (text.length > PARSE_TEXT_MAX) return res.status(400).json({ error: `介绍最多 ${PARSE_TEXT_MAX} 字` });
  const ip = clientIp(req);
  // 后台代传是一天几十条的批量活，匿名档的「每人 40 次/小时 + 全站 4 次/分」会把人卡死；
  // 后台已登录（cookie 票据）就放行，模型额度本来就是站长自己付的。
  if (!isAdmin(req)) {
    if (!rateLimit('wparse:' + ip, 5, 60000)) return res.status(429).json({ error: '识别太频繁了，等一分钟再试' });
    if (!rateLimit('wparse-h:' + ip, 40, 3600e3)) return res.status(429).json({ error: '一小时内识别次数用完了，请手动填写' });
    // 免费档整站共享配额，再加一道全局闸门，避免多人同时点把额度打满
    if (!rateLimit('wparse-all', 4, 60000)) return res.status(429).json({ error: '识别有点忙，稍等一分钟再试' });
  }
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

// ================= AI 帮写简介（只生成草稿，不写库、不提交） =================
// 「作品介绍」是最容易被跳过的一栏，而它直接决定别人点不点进来、搜索引擎拿什么当摘要。
// 输入只有作者已经填过的信息（标题 / 分类 / 形态 / 网址），让模型写 60–100 字，
// 明确禁止编造功能；生成结果回填到输入框，作者自己改，服务端不留痕。
const INTRO_AI_TIMEOUT = 15000;
app.post('/api/ai/intro', async (req, res) => {
  const user = currentUser(req);
  const ip = clientIp(req);
  const b = req.body || {};
  const title = String(b.title || '').replace(/[<>\r\n]/g, '').trim().slice(0, 100);
  if (title.length < 2) return res.status(400).json({ error: '先填作品标题，AI 才知道写什么' });
  const cats = (Array.isArray(b.categories) ? b.categories : []).slice(0, 3).map(x => String(x).replace(/[<>\r\n]/g, '').slice(0, 20)).filter(Boolean);
  const types = (Array.isArray(b.types) ? b.types : []).slice(0, 6).map(x => String(x).replace(/[<>\r\n]/g, '').slice(0, 20)).filter(Boolean);
  const link = String(b.link || '').replace(/[<>\s]/g, '').slice(0, 300);
  if (!ZHIPU_API_KEY) return res.status(503).json({ error: 'AI 帮写暂未开启，手动写一句也可以' });
  // 匿名 5 次/小时（够试用），登录 20 次/小时；再压一道全站闸门，免费额度是整站共享的
  if (!rateLimit('aiintro:' + (user ? 'u:' + user.id : ip), user ? 20 : 5, 3600e3)) {
    return res.status(429).json({ error: user ? '这一小时生成次数用完了，先手动写一段吧' : '匿名每小时 5 次，登录后额度更高' });
  }
  if (!rateLimit('aiintro-all', 6, 60000)) return res.status(429).json({ error: '生成有点忙，等一分钟再试' });

  const fact = [
    `作品名：${title}`,
    cats.length ? `分类：${cats.join('、')}` : '',
    types.length ? `形态：${types.join('、')}` : '',
    link ? `作品网址：${link}` : ''
  ].filter(Boolean).join('\n');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INTRO_AI_TIMEOUT);
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ZHIPU_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: ZHIPU_MODEL,
        temperature: 0.7,
        max_tokens: 300,
        messages: [
          { role: 'system', content: '你是独立开发者作品站的编辑替作者写作品介绍。只用给到的事实写，禁止编造任何具体功能、数据、奖项、用户量、价格或技术细节；不确定的地方用概括表述。输出一段中文纯文本，60–100 字，两到三句：第一句说它是什么、给谁用；第二句说清最主要的一件事；不要标题、不要 markdown、不要「这款作品」这种套话开头，直接进入内容，也别写「欢迎体验」。' },
          { role: 'user', content: fact }
        ]
      })
    });
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch { /* 忽略 */ }
      if (body.contentFilter || (body.error && body.error.code === '1301')) {
        return res.status(400).json({ error: '这个标题触发了内容过滤，换个写法或手动填写' });
      }
      return res.status(502).json({ error: 'AI 暂时不可用，先手动写一句吧' });
    }
    const data = await r.json();
    let text = String((((data.choices || [])[0] || {}).message || {}).content || '').trim();
    text = text.replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/^```[a-z]*\n?|```$/g, '').trim().slice(0, 300);
    if (!text) return res.status(502).json({ error: 'AI 没写出内容，再点一次试试' });
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: e && e.name === 'AbortError' ? 'AI 生成超时，再试一次' : 'AI 暂时不可用，先手动写一句吧' });
  } finally {
    clearTimeout(timer);
  }
});

// 「一眼看懂」四项 AI 补全（解决什么问题 / 适合谁 / 上手几步 / 和同类比）。
// 定位句一般不缺，所以只生成这四项。铁律：只从作者自己写的介绍里提炼，
// 原文撑不住的项返回空（steps 返回 []），宁缺勿编 —— 详情页那块是给搜索/AI 摘的，
// 编一句功能出去就是替作者说假话。
const QUICKLOOK_AI_TIMEOUT = 22000;
const QL_AI_LIMIT = { problem: 120, audience: 80, step: 40, steps: 5, diff: 120 };

// AI 偶尔会包 ```json 或加解释，这里宽松地掏出第一个 JSON 对象
function parseLooseJson(text) {
  const t = String(text || '').replace(/```json/gi, '```').trim();
  const fence = t.match(/```([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

app.post('/api/ai/quicklook', async (req, res) => {
  const user = currentUser(req);
  const ip = clientIp(req);
  const b = req.body || {};
  const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
  const title = clean(b.title, 100);
  const prompt = clean(b.prompt, 1500);
  const positioning = clean(b.positioning, 60);
  const category = clean(b.category, 20);
  const types = (Array.isArray(b.types) ? b.types : []).slice(0, 6).map(x => clean(x, 20)).filter(Boolean);
  if (title.length < 2) return res.status(400).json({ error: '先填作品名字，AI 才知道写什么' });
  // 介绍太短＝没有依据，让 AI 硬写只会编：直接拦下来，把话说清楚
  if (prompt.length < 30) return res.status(400).json({ error: '作品介绍太短，AI 没有依据可提炼。先写两三句它是什么、怎么用，再点一次' });
  if (!ZHIPU_API_KEY) return res.status(503).json({ error: 'AI 补全暂未开启，手动填这四项也可以' });
  // 匿名 3 次/小时（够用），登录 10 次/小时；再压一道全站闸门，免费额度整站共享
  if (!rateLimit('aiql:' + (user ? 'u:' + user.id : ip), user ? 10 : 3, 3600e3)) {
    return res.status(429).json({ error: user ? '这一小时生成次数用完了，先手动填吧' : '匿名每小时 3 次，登录后额度更高' });
  }
  if (!rateLimit('aiql-all', 5, 60000)) return res.status(429).json({ error: '生成有点忙，等一分钟再试' });

  const fact = [
    `作品名：${title}`,
    category ? `分类：${category}` : '',
    types.length ? `形态：${types.join('、')}` : '',
    positioning ? `作者的一句话定位：${positioning}` : '',
    '作者自己写的作品介绍：',
    prompt
  ].filter(Boolean).join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUICKLOOK_AI_TIMEOUT);
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ZHIPU_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: ZHIPU_MODEL,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content: [
              '你在帮独立开发者把作品介绍整理成结构化摘要，供作品页的「一眼看懂」卡使用。',
              '最重要的一条：每一项输出都必须附上出处 —— 从作者原文里【原样复制】连续的一段话（不改写、不拼接、不加省略号）。',
              '找不到出处的项，text 和 quote 都返回空字符串，绝对不要自己编。编一句就是替作者说假话，比留空糟糕得多。',
              '严禁出现原文没有的功能、数据、价格、用户量、奖项、技术实现、兼容平台。',
              '只输出一个 JSON 对象（不要注释、不要 markdown、不要解释），结构：',
              '{"problem":{"text":"...","quote":"..."},"audience":{"text":"...","quote":"..."},"steps":[{"text":"...","quote":"..."}],"diff":{"text":"...","quote":"..."}}',
              'problem：它替用户解决什么麻烦，一句，不超过 120 字，不要罗列功能清单。',
              'audience：什么人最需要它，具体到身份或场景，不超过 80 字；原文提到「给谁用 / 你也可以用到 / 面向 XX」就据此写。',
              'steps：上手步骤 2 到 5 条，每条不超过 40 字，格式为 {"text":"...","quote":"..."}。text 必须是原文里原样出现的动作短语（可加最少的连接词），quote 复制它来自的那一段；原文里没有动作动词（打开 / 录制 / 扫码 / 导入 / 上传 / 粘贴 / 点击 / 下载）或看不出先后顺序，就返回空数组 []。',
              'diff：和同类或替代做法（别的 App、Excel、微信群、手动做）的区别，不超过 120 字，格式 {"text":"...","quote":"..."}。**text 里必须原样出现 quote 那段话**（不要改写成同义词），只把原文声明过的取舍跟常规做法做个对比；原文含「不耗 token / 开源 / 免费 / 不用登录 / 本地运行 / 离线 / 只收官网」这类措辞才写，否则返回空字符串。'
            ].join('\n')
          },
          { role: 'user', content: fact }
        ]
      })
    });
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch { /* 忽略 */ }
      if (body.contentFilter || (body.error && body.error.code === '1301')) {
        return res.status(400).json({ error: '内容触发了过滤，换个说法或手动填' });
      }
      return res.status(502).json({ error: 'AI 暂时不可用，先手动填吧' });
    }
    const data = await r.json();
    const raw = String((((data.choices || [])[0] || {}).message || {}).content || '');
    const parsed = parseLooseJson(raw);
    if (!parsed) return res.status(502).json({ error: 'AI 返回的格式不对，再点一次试试' });

    // 出处校验（这道是硬闸）：模型给的 quote 必须真的能在作者原文里找到，找不到整项丢掉。
    // 另外两道更细的闸，防它「引一句真话、补一句假话」：
    //   - diff 必须复用作者原话（或与引文高度重合），否则就是在替作者声明他没说过的取舍；
    //   - steps 每条要与引文重合 55% 以上，防它编出原文没有的操作。
    const bare = s => String(s || '').replace(/[\s，。、；：！？,.;:!?"'“”‘’（）()【】\[\]《》<>·\-—_/~]/g, '').toLowerCase();
    const srcBare = bare(prompt);
    const grams = s => { const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
    const overlapOf = (text, quote) => {
      const t = grams(bare(text)), q = grams(bare(quote));
      if (!t.size || !q.size) return 0;
      let hit = 0;
      q.forEach(g => { if (t.has(g)) hit++; });
      return hit / q.size;     // 引文里的字组有多少出现在这句话里
    };
    const pick = (item, opt = {}) => {
      if (!item || typeof item === 'string') return '';
      const text = clean(item.text, 400);
      const quoteBare = bare(item.quote);
      if (!text || quoteBare.length < 4) return '';
      if (!srcBare.includes(quoteBare)) return '';                  // 引文不在原文里 → 判为编造
      if (/^(无|没有|暂无|不适用|-|—|\.\.\.)$/.test(text)) return '';
      const ov = overlapOf(text, item.quote);
      if (opt.quoteInText && !bare(text).includes(quoteBare) && ov < 0.7) return '';
      if (opt.minOverlap && ov < opt.minOverlap) return '';
      return text;
    };
    // 步骤允许两种写法：{text,quote} 对象，或直接一句短语。
    // 判据统一成「这句短语有多少字组来自原文」：编出来的步骤（上传、创建、保存并分享）会掉这里。
    const stepPick = item => {
      if (typeof item === 'string') {
        const text = clean(item, QL_AI_LIMIT.step);
        if (text.length < 3) return '';
        return overlapOf(prompt, text) >= 0.6 ? text : '';
      }
      if (!item) return '';
      const text = clean(item.text, QL_AI_LIMIT.step);
      const quote = bare(item.quote);
      if (text.length < 3 || quote.length < 4) return '';
      if (!srcBare.includes(quote)) return '';              // 引文不在原文 → 编的
      return overlapOf(item.quote, text) >= 0.6 ? text : '';  // 短语的字组要大多来自这段引文
    };
    const out = {
      problem: clean(pick(parsed.problem), QL_AI_LIMIT.problem),
      audience: clean(pick(parsed.audience), QL_AI_LIMIT.audience),
      diff: clean(pick(parsed.diff, { quoteInText: true }), QL_AI_LIMIT.diff),
      steps: (Array.isArray(parsed.steps) ? parsed.steps : [])
        .map(stepPick)
        .filter(Boolean).slice(0, QL_AI_LIMIT.steps)
    };
    // 一步都站不住时不留单条：一条「步骤」撑不起「上手几步」，还会误导
    if (out.steps.length < 2) out.steps = [];
    if (!out.problem && !out.audience && !out.diff && !out.steps.length) {
      return res.status(200).json({ ...out, empty: true, error: '原文信息太少，AI 提炼不出有依据的内容，建议手动补两句介绍' });
    }
    if (process.env.QL_AI_DEBUG) out._raw = raw.slice(0, 1500);   // 调试用：看模型原始输出与被丢掉的项
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e && e.name === 'AbortError' ? 'AI 生成超时，再试一次' : 'AI 暂时不可用，先手动填吧' });
  } finally {
    clearTimeout(timer);
  }
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
  // 同 /api/work/parse：后台代传批量读取页面时不走匿名限流
  if (!isAdmin(req)) {
    if (!rateLimit('wurl:' + ip, 3, 60000)) return res.status(429).json({ error: '读取太频繁了，等一分钟再试' });
    if (!rateLimit('wurl-h:' + ip, 20, 3600e3)) return res.status(429).json({ error: '一小时内读取次数用完了，请手动填写' });
    if (!rateLimit('wurl-all', 3, 60000)) return res.status(429).json({ error: '解析有点忙，稍等一分钟再试' });
  }

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
  // 规则兜底吃的无标签纯文本：带「网页标题：」的原文只能喂 AI，不能直接进表单
  const plainText = [info.title, info.siteName, info.ogTitle, info.h1, info.desc, info.body.slice(0, 600)]
    .filter(Boolean).join('\n');
  if (text.replace(/\s/g, '').length < 12)
    return res.status(400).json({ error: '这个网页没读到可用文字，请改用「粘贴介绍」' });

  const parsed = await extractFromText(text, plainText);
  if (parsed.blocked) return res.status(400).json({ error: '这个网站的内容不适宜自动识别，请手动填写' });
  const out = parsed.out;
  // 降级到规则时绝不能把抓取原文当简介，简介改从站点描述取；顺带剔掉 AI 可能照抄的标签行
  if (out.source === 'rules') out.summary = '';
  out.summary = String(out.summary || '').split('\n')
    .filter(l => !/^(网站地址|站点名称|网页标题|页面主标题|页面大标题|页面描述|页面正文摘录)\s*[:：]/.test(l.trim()))
    .join('\n').trim();
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
  // 简介和分类刚被收敛过，关键词按最终值重算一遍（否则会带上被剔掉的那些噪音）
  out.keywords = autoKeywords({ title: out.name, prompt: out.summary, categories: out.categories, types: out.types });
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
// 作品 id 直接拼在分享链接 /w/<id> 里，会被口头转告、截图抄写、手打输入，
// 生成时就避开形状雷同的字符，和认领暗号、礼品码同一套思路。
// 滤掉的 9 个：0 1 5 2 6 9（数字侧）+ o i l（字母侧）——
//   0/o、1/l、1/i、5/s、2/z、6/b、9/g 这几组在字体里或手写时容易看串，
//   统一保留字母侧（s z b g 更常见、也更容易念），数字只留 3 4 7 8。
// 只对新建作品生效：老 id 不动（老链接照常打开），另在 /w/ 入口做易混字符兜底匹配。
const WORK_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz3478';
function newWorkId() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 12; i++) s += WORK_ID_ALPHABET[crypto.randomInt(WORK_ID_ALPHABET.length)];
    if (!works.some(w => w.id === s)) return s;
  }
}
// /w/ 易混字符兜底用的归一化：小写折叠，再把「看串了的那一侧」映射到生成字母表里保留的一侧
// （0→o 只有老 id 里才可能出现，仍照原样折叠；1/i→l、5→s、2→z、6→b、9→g）
function normWorkId(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!/^[0-9a-z]+$/.test(t)) return '';
  return t.replace(/0/g, 'o').replace(/[1i]/g, 'l')
    .replace(/5/g, 's').replace(/2/g, 'z').replace(/6/g, 'b').replace(/9/g, 'g');
}
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
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
    // 草稿图片也是 UGC：存进来之前先过官方图片闸，别让违规图在草稿箱里潜伏到发布
    const draftImgCheck = await wechatImgCheckUploads(req);
    if (draftImgCheck.pass === false) {
      return res.status(400).json({ error: '图片未通过平台内容安全检测，请更换图片后再存草稿' });
    }
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
    applyTitleParts(d, b);   // 草稿也存「名字 / 一句话介绍」，续填时两框各归各位
    applyContentFields(d, b);   // 「一眼看懂」五件套也存进草稿，不然续填时白填一遍
    if (b.prompt !== undefined) d.prompt = String(b.prompt).slice(0, 3000);
    if (b.site !== undefined) d.site = normSite(b.site);
    if (b.repo !== undefined) d.repo = normRepo(b.repo);
    if (b.openSource !== undefined) d.openSource = parseOpenSource(b.openSource);
    if (b.paid !== undefined) d.paid = parsePaid(b.paid);
    if (b.paidModel !== undefined) d.paidModel = parsePaidModel(b.paidModel);
    if (b.types !== undefined) d.types = normalizeTypes(b.types);
    if (b.categories !== undefined) d.categories = parseCats(b.categories);
    if (b.keywords !== undefined) d.keywords = sanitizeKeywords(b.keywords);
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
    // 「第一张图当封面」：草稿也保持同口径——没传封面但传了作品图片，取第一张当封面
    if (!d.image && Array.isArray(d.images) && d.images.length) {
      d.image = d.images.shift();
      d.thumb = d.image;
    }
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
// ---------- 标题两框（作品名字 + 一句话介绍）----------
// 表单里是两个框，库里只存一个 title（「名字 介绍」，分隔符是一个空格），卡片要分两行显示。
// 光存拼接后的 title，就只能在渲染时"猜"从哪儿断——英文开头的介绍（「日影 mac活动追踪器…」）
// 猜不出来就会整条压在第一行，站长在后台手切完保存、再打开还是原样，看起来像"没生效"
// （2026-11-10 晚用户报的就是这个）。所以把两框原样存下来：渲染直接按字段分行，
// 老数据没有 titleName / titleTag 时仍然走 splitCardTitle 的兜底拆法。
// 注意：w.title 依旧以表单拼出来的 title 为准，这里只记拆分，不改标题本体。
// 名字上限（2026-11-13 站长改）：最长 20，汉字/全角算 2、其他算 1 —— 与前端两个表单的 JS 口径
// 一致（HTML maxlength 只数字符数不了宽度，前端已去掉 maxlength、输入时由 JS 截断）。
// 超限的老数据不回改（照常展示），再次保存标题时才截到上限内。
const WNAME_MAX = 20;
const WIDE_RE = /[\u2E80-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFFEF]/;
function wideLen(s) { let n = 0; for (const ch of String(s)) n += WIDE_RE.test(ch) ? 2 : 1; return n; }
function wideSlice(s, max) {
  let n = 0, out = '';
  for (const ch of String(s)) {
    const w = WIDE_RE.test(ch) ? 2 : 1;
    if (n + w > max) break;
    n += w; out += ch;
  }
  return out;
}
function applyTitleParts(w, body) {
  if (!body || (body.wname === undefined && body.wtag === undefined)) return;
  const name = body.wname !== undefined ? wideSlice(String(body.wname).replace(/\s+/g, ' ').trim(), WNAME_MAX) : '';
  const tag = body.wtag !== undefined ? String(body.wtag).replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  if (name) w.titleName = name; else delete w.titleName;
  if (tag) w.titleTag = tag; else delete w.titleTag;
}

// ---------- 「一眼看懂」内容结构字段（2026-11-11） ----------
// 五个问题：定位 / 解决什么 / 适合谁 / 上手三步 / 和同类比。
// 为什么不用一个自由文本框：分开存才能分别喂给详情页的 <dt><dd>、JSON-LD 的
// featureList / audience，也才能给 88 件老作品按字段算「缺哪一项」。
// 为什么全是选填：投稿漏斗本来就窄，五个必填框会直接把人吓走；
// 缺了照常发布，只是少一次被搜到 / 被 AI 引用的机会（详情页那块整块不渲染）。
const CONTENT_LIMITS = { positioning: 60, problem: 120, audience: 80, diff: 120, step: 40, steps: 5 };

function cleanInline(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max);
}

// 上手三步：表单里是一个 textarea（一行一步），接口也接受数组，统一揉成数组
function parseSteps(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split('\n');
  const out = [];
  for (const item of raw) {
    // 只剥列表记号（- * · • 1. 1、 1)），别碰正文开头的数字（「3 步搞定」不能变成「步搞定」）
    const s = cleanInline(item, CONTENT_LIMITS.step)
      .replace(/^(?:[-*·•]\s*|\d{1,2}\s*[.、)）]\s*)/, '')
      .trim();
    if (s) out.push(s);
    if (out.length >= CONTENT_LIMITS.steps) break;
  }
  return out;
}

function applyContentFields(w, body) {
  if (!body) return;
  for (const k of ['positioning', 'problem', 'audience', 'diff']) {
    if (body[k] === undefined) continue;   // 没传就不动：后台表单 / 老客户端不带这些键，不能把已有内容抹掉
    const v = cleanInline(body[k], CONTENT_LIMITS[k]);
    if (v) w[k] = v; else delete w[k];     // 传了空串＝作者主动清空，删字段而不是留空串污染摘要
  }
  if (body.steps !== undefined) {
    const steps = parseSteps(body.steps);
    if (steps.length) w.steps = steps; else delete w.steps;
  }
}

// 有没有可展示的内容结构（详情页/摘要据此决定要不要出「一眼看懂」那块）
function hasQuickLook(w) {
  if (!w) return false;
  const n = ['positioning', 'problem', 'audience', 'diff'].filter(k => String(w[k] || '').trim()).length
    + (Array.isArray(w.steps) ? w.steps.filter(Boolean).length : 0);
  // 只有一句零散的话就撑一整张卡会显得空：要么有定位句，要么至少凑两行
  return !!String(w.positioning || '').trim() || n >= 2;
}

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
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
    const { title, prompt, category, link, type } = req.body;
    // 搜索关键词：表单有传（作者加过 / 改过 / 删光了）就按作者的意思存，
    // 没传（老客户端、直接调接口）就后面自动生成一份。null 与 [] 要分清楚，见 keyWordsOf
    const kwInput = req.body.keywords !== undefined ? sanitizeKeywords(req.body.keywords) : null;
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
    // 「第一张图当封面」：没单独传封面但传了作品图片时不算缺封面，后面取第一张当封面
    const galleryFiles = (req.files && req.files.images) || [];
    if (!image && !(draft && draft.image) && !galleryFiles.length)
      return res.status(400).json({ error: '请上传作品图片：第一张将自动作为封面' });
    if (!title) return res.status(400).json({ error: '标题为必填项' });

    // 匿名投稿允许自填署名，不填就是「匿名」
    const nickname = String(req.body.author || '').replace(/[<>\r\n]/g, '').trim().slice(0, 20);
    const authorName = user ? user.username : (nickname || '匿名');

    if (hitSensitive(title + authorName + (prompt || '') + (kwInput || []).join(''))) {
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
    // 图片同一道官方闸：本次新传的封面/宣传图/二维码逐张过 imgSecCheck
    //（草稿存量图在存草稿那次已查过，这里不重复烧配额）
    const imgCheck = await wechatImgCheckUploads(req);
    if (imgCheck.pass === false) {
      return res.status(400).json({ error: '图片未通过平台内容安全检测，请更换图片后重试' });
    }
    // AI 初审：需要审核的投稿先问智谱（免费 glm-4-flash）——通过直接上线，不通过/不可用转人工
    let aiReview = null;
    if (needReview) {
      aiReview = await aiReviewGate([title, authorName, prompt, linkVal].filter(Boolean).join('\n'));
    }
    let status = !needReview || (aiReview && aiReview.pass === true) ? 'approved' : 'pending';
    // 2026-11-13 补的第二个口子：注册用户免审是为了让正常投稿直接上线，不是给「被下架后换个壳重投」
    // 开后门。同一账号下已有「同链接」（没填链接时按「同标题」）的件处于已下架，这次一律转人工复核。
    if (status === 'approved' && user) {
      const normLink = v => String(v || '').trim().replace(/\/+$/, '').toLowerCase();
      const myLink = normLink(linkVal);
      const myTitle = String(title || '').trim();
      // 判「曾被下架」看两态：还在下架中（rejected），或已重新提交、正等复核（pending + offlineAt）。
      // 后者不能漏：作者先把原件改一下（原件转待审），再另投一件同链接的，等于又绕过去了。
      const prior = works.find(x => x && x.userId === user.id
        && ((x.status || 'approved') === 'rejected' || (x.status === 'pending' && x.offlineAt))
        && (myLink ? normLink(x.link) === myLink : String(x.title || '').trim() === myTitle));
      if (prior) {
        status = 'pending';
        aiReview = { pass: null, note: '同账号的作品「' + prior.title + '」曾被下架，这次转人工复核', at: new Date().toISOString() };
      }
    }
    // 草稿转正：以草稿里已有的图为底，叠上这次新传的（keepExisting / removedImages / imageOrder
    // 与编辑作品同一套协议，前端复用）。校验全过之后才动图片，草稿里的图不会因为一次失败的上传被删掉。
    const imgBase = draft
      ? { image: draft.image || '', thumb: draft.thumb || '', qrcode: draft.qrcode || '', images: (draft.images || []).slice() }
      : { image: '', thumb: '', qrcode: '', images: [] };
    applyImageChanges(imgBase, req);
    // 「第一张图当封面」兜底：没单独传封面时，取作品图片第一张当封面，
    // 并从宣传图里去掉（否则详情页 [封面, ...宣传图] 会把同一张图展示两遍）
    if (!imgBase.image && imgBase.images.length) {
      imgBase.image = imgBase.images.shift();
      imgBase.thumb = imgBase.image;
    }
    const work = {
      id: newWorkId(),
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
      ...paidFieldsOf(req.body),
      reports: 0,
      likes: 0,
      views: 0,
      // 投稿时勾选《作品规范》与「本人创作/已获授权」的时间，留作「平台已尽提示义务」的凭据
      agreeAt: req.body.agreeRules === '1' ? new Date().toISOString() : '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (linksMap) work.links = linksMap;
    applyTitleParts(work, req.body);   // 名字 / 一句话介绍分开存（卡片直接分两行，不靠猜）
    applyContentFields(work, req.body);   // 「一眼看懂」五件套：选填，缺了不拦发布
    // 关键词落库：作者填的就存他的，没填就按标题 / 简介 / 分类自动配几个（存下来，
    // 下次打开编辑页能看到「系统给我配了什么」，可以直接改）
    work.keywords = kwInput || autoKeywords(work);
    if (aiReview) work.aiReview = aiReview;        // AI 初审意见存档（管理端可见，人工终审参考）
    // 灯火解锁要把灯火转给作者：未登录的游客投稿没有账号可收款，直接拦住
    if (work.paidModel === 'lamp' && !work.userId) {
      return res.status(400).json({ error: '灯火解锁的作品要转到作者账号上，请先登录再设置' });
    }
    if (!user) {
      work.lookupToken = randomToken();   // 匿名投稿：凭这个 token 回来看审核进度
      // 匿名投稿记一份投稿 IP 指纹（与账号 regIp 同一套哈希，不存明文）：
      // 同一个人在同一个出口注册账号后，系统凭它把「这台机器投的、还没归属的作品」
      // 列出来问一句「是你的吗」，点确认就当场认领（见 /api/claim/ip-candidates）。
      work.submitIp = ipKeyOf(req);
    }
    // 预告卡不发上传奖励 / 开源奖励：避免「先挂个预告把首件 200 盏灯火骗走」，上线时再补
    const uploadReward = stage === 'wip' ? null : planUploadReward(work, user);
    // 首次提交填了源码仓库：读一次 GitHub 公开信息，记归属与 star 基线；
    // 仓库打不开 / 高 star 且归属存疑 → 打「需核定」标记，领奖时强制转人工，别人拿高 star 链接骗不到灯火
    if (work.repo) await stampRepoOnWork(work, user);
    works.push(work);
    const uploadInstant = payUploadRewardInstant(work);   // 首件即时款：作品已过审且正式上线才发
    const osBonusNow = stage === 'wip' ? 0 : grantOpenSourceBonus(work);
    saveWorks();
    baiduPushWork(work, 'new-work');
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
      // 「发布成功」弹窗那句「感谢你的第 N 件创作」：登录用户的全部作品数（works 此时
      // 已 push 进本次新投稿，所以算出来就是含本件的自然序号）；匿名投稿没有账号，恒为 0
      myWorks: user ? works.filter(w => w.userId === user.id).length : 0,
      anonymous: !user,
      statusUrl: work.lookupToken ? '/s/' + work.lookupToken : '',
      osBonus: osBonusNow,   // 只报本次实发，避免前端误弹「已到账」
      uploadReward: uploadReward ? uploadReward.amount : 0,   // 本件奖励总额
      uploadRewardInstant: uploadInstant,                     // 本次实际即时到账
      uploadRewardRest: uploadReward ? Math.max(0, uploadReward.amount - uploadReward.instant) : 0,
      uploadRewardReadyHours: uploadReward ? uploadReward.readyHours : 0
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
  if (next === 'live' && prev !== 'live') baiduPushWork(w, 'stage-live');   // 预告卡上线：这一刻才第一次可访问
  res.json({ ok: true, prev, ...publicWork(w, user) });
});

// 编辑自己的作品
app.put('/api/works/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
    const w = works.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: '作品不存在' });
    // 站长账号可以在前台直接改任意作品（含别人认领的、还没认领的）；普通用户只能改自己的。
    // 站长的改动要按「作者身份」处理后续副作用（仓库归属 / 开源奖励 / 同意凭据），不能算到站长头上。
    const siteOwnerEdit = isSiteOwner(user) && w.userId !== user.id;
    if (w.userId !== user.id && !siteOwnerEdit) return res.status(403).json({ error: '只能编辑自己的作品' });
    const author = siteOwnerEdit ? (users.find(u => u.id === w.userId) || null) : user;

    // 新上传的图片过官方内容安全闸（编辑换图与投稿同一口径；没传图就直接放行，不烧配额）
    const imgCheck = await wechatImgCheckUploads(req);
    if (imgCheck.pass === false) {
      return res.status(400).json({ error: '图片未通过平台内容安全检测，请更换图片后重试' });
    }

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
    applyTitleParts(w, req.body);   // 作者编辑：名字 / 一句话介绍分开存（清空介绍框则删掉旧介绍）
    applyContentFields(w, req.body);   // 「一眼看懂」五件套：清空某一项＝删掉该项，不再展示
    // 关键词：带了就整组覆盖（空数组＝作者清空了，不再自动补），没带保持原样
    if (req.body.keywords !== undefined) w.keywords = sanitizeKeywords(req.body.keywords);
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
    // 收费 / 送灯火 / 灯火解锁：统一口径（paidModel 决定 paid 与 lampPrice，见 applyPaidFields）
    if (req.body.paid !== undefined || req.body.paidModel !== undefined) applyPaidFields(w, req.body);
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

    // 被下架的作品编辑后回到「待审核」，改好重新提交等人工复核。
    // 2026-11-13 修：原来这里写的是「AI 初审通过就直接恢复上线」——实测（本地配了智谱 key）
    // 作者改个标题一保存，AI 判 pass 就当场 approved，等于没人审核、下架白下。
    // 口径：下架是人的决定，撤销也只能人来做；AI 只用来拦明显违规（结果存 aiReview 供人工参考），
    // 不再具备「放行上线」的权力。站长亲手改的（siteOwnerEdit）照旧直接放出去。
    if (w.status === 'rejected') {
      if (siteOwnerEdit) {
        w.status = 'approved';
        delete w.offlineReason;
      } else {
        const ai = await aiReviewGate([w.title, w.author, w.prompt, w.link].filter(Boolean).join('\n'));
        w.aiReview = ai;
        w.status = 'pending';
        delete w.offlineReason;
        // 让作者知道「这次不是立刻可见」：后台待审列表里也会出现这一条
        if (w.userId) {
          addNotice(w.userId, {
            kind: 'system',
            title: `「${w.title}」已重新提交，等复核`,
            text: '改动已保存。这件之前被收起来过，这次会由人再看一遍，通过就恢复展示；不用重复提交，处理完会再通知你。',
            workId: w.id
          });
        }
      }
    }

    // 第一次填仓库 / 改仓库地址：读一次公开信息，换链接要重置基线并清掉旧的核定状态
    const repoChanged = !!repoBefore && w.repo !== repoBefore;
    if (w.repo && (!repoBefore || repoChanged)) await stampRepoOnWork(w, author, { changed: repoChanged });

    const osWas = w.openSource;
    // 站长代改别人的作品：不发开源奖励（那是作者自己的合规行为，站长改标不该变成发灯火），
    // 但作品上该有的字段照常更新
    const osBonusNow = siteOwnerEdit ? 0 : grantOpenSourceBonus(w);   // 编辑时改成开源也补送（一件作品只送一次）
    // 方案 A：作者自己把开源改回闭源，同样保留奖励、只通知
    if (!siteOwnerEdit && osWas === true && w.openSource === false && w.userId) {
      addNotice(w.userId, {
        kind: 'system', title: '作品已改为闭源',
        text: `「${w.title}」已改为闭源。已发放的开源奖励灯火会保留，不会收回。`
      });
    }
    // 编辑留痕：作者每次保存都重申遵守规范（前端编辑模式默认勾选），记最后一次同意时间。
    // 只存 agreeAtEdited，不覆盖首投的 agreeAt——两份凭据一起构成完整的提示链。
    // 站长代改不能替作者签这份承诺，跳过。
    if (!siteOwnerEdit && req.body.agreeRules === '1') w.agreeAtEdited = new Date().toISOString();
    if (siteOwnerEdit) {
      // 站长代改留痕：后台 / 作者看数据时能分清「作者自己改的」和「站长改的」
      w.adminEditAt = new Date().toISOString();
      w.adminEditBy = user.username;
    }
    saveWorks();
    baiduPushWork(w, 'edit');   // 内容改了值得让百度重抓一次（24 小时内不重复推）
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
  if (!w.hidden) baiduPushWork(w, 'relist-self');
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

// 点赞流水：带时间戳的点赞记录，给「本周热榜」统计本周新增赞用。
// like-dedup 只有身份去重、没有时间，回溯不了「这周赞了多少」；
// 2026-11-07 起记录，之前的点赞是历史累计，不进本周增量。
let likeLog = readJSON('like-log.json', []);
let likeLogSaveTimer = null;
function scheduleLikeLogSave() {
  if (likeLogSaveTimer) return;
  likeLogSaveTimer = setTimeout(() => {
    likeLogSaveTimer = null;
    try { writeJSON('like-log.json', likeLog); } catch (e) { /* 统计失败不影响主流程 */ }
  }, 3000);
}

// 点赞
// 点赞 / 取消点赞（2026-11-08 起可取消）：
//   body { on: true }  → 点赞（默认）；{ on: false } → 取消。
//   likeDedup 的值从「1 = 赞过」升级成「1 = 已赞 / 0 = 赞过又取消」，旧数据里的 1 原样兼容。
//   计数永远等于「当前赞过的人数」：赞 +1、取消 -1，来回切净额守恒，刷不出分；
//   每次状态变化都只保留一条 like-log（同一身份重新点赞时先摘旧记录再补新的），
//   否则本周热榜 / 高光窗口会把同一个人的反复切换重复计数。
app.post('/api/works/:id/like', (req, res) => {
  if (!rateLimit('like:' + clientIp(req), 60, 60000)) {
    return res.status(429).json({ error: '操作过于频繁' });
  }
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  // 作者给自己作品点赞不计：和访问统计同一个口径，防自刷
  const user = currentUser(req);
  if (user && w.userId && w.userId === user.id) {
    return res.json({ likes: w.likes || 0, liked: false, self: true });
  }
  const vid = user ? 'u:' + user.id : 'ip:' + ipKeyOf(req);
  const on = !(req.body && req.body.on === false);   // 默认 true，兼容只发空 body 的老客户端
  const seen = likeDedup[w.id] || (likeDedup[w.id] = {});
  const wasOn = seen[vid] === 1;
  if (on === wasOn) {   // 状态没变化：不重复计数，只回报当前值
    return res.json({ likes: w.likes || 0, liked: wasOn, deduped: true });
  }
  if (on) {
    seen[vid] = 1;
    w.likes = (w.likes || 0) + 1;
  } else {
    seen[vid] = 0;                 // 记住「赞过又取消」：再点回来仍是这个身份，不会重复计人头
    w.likes = Math.max(0, (w.likes || 0) - 1);
    // 取消点赞不回撤已经发出去的作者通知（聚合通知发完就清空了，撤销反而更乱）
  }
  // 一人一条：先把这件作品上同一身份的历史记录全部摘掉，再按当前状态补
  for (let i = likeLog.length - 1; i >= 0; i--) {
    if (likeLog[i] && likeLog[i].workId === w.id && likeLog[i].vid === vid) likeLog.splice(i, 1);
  }
  if (on) likeLog.push({ workId: w.id, vid, t: Date.now() });
  if (on) queueLikeNotice(w);   // 作者收通知（按人 6 小时聚合，见 queueLikeNotice）；取消不回撤已发的
  saveWorks();
  scheduleLikeDedupSave();
  scheduleLikeLogSave();
  res.json({ likes: w.likes, liked: on });
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
//   ⑥ 同一设备对同一作者：每天笔数上限（5 笔，2026-11-14 起按作者算，不是整个网络 1 笔）+ 每天盏数上限（50 盏）；
//      同一作品另有终身上限（防长期小号养号灌分）；
//   ⑦ 请求级限流（每人每小时最多 10 次）。
const TIP_AMOUNTS = [1, 2, 5, 10];       // 固定档位
const TIP_DAILY_OUT = 60;                // 每人每天最多转出 60 盏（2026-11-14 站长要求从 30 放宽到 60，
                                         // 否则「同一设备对同一作者 50 盏」还没送到就先被个人总额截住）
const TIP_DAILY_OUT_OWNER = 100;         // 站长单独放宽：每天最多转出 100 盏（2026-11-13 站长要求）
const TIP_IP_DAILY_TOTAL = 60;           // 同一 IP 每天最多转出 60 盏（2026-11-14 从 30 放宽：要与
                                         // 个人转出上限 60 对齐，否则一台设备上的一个人连自己的额度都用不完；
                                         // 一窝小号在这个 IP 上一天合计也只有 60 盏）
const TIP_IP_PER_TARGET_COUNT = 5;       // 同一 IP 每天对「同一位作者」最多送 5 笔（2026-11-14 站长定：
                                         // 从「整个网络 1 笔」先改成「每位创作者 1 笔」，再放到 5 笔 ——
                                         // 5 笔 × 最高档 10 盏 = 50 盏，正好等于同一设备对同一作者的盏数上限。
                                         // 同一作者的多件作品 + 作者主页直送合计一本账；匿名作品没有作者，
                                         // 按「作品」算。看广告代送不算，站长豁免）
const TIP_IP_PER_AUTHOR_DAY = 50;        // 同一 IP 对同一作者每天最多 50 盏（2026-11-14 站长要求，20 → 50）
const TIP_IP_PER_WORK_TOTAL = 30;        // 同一 IP 对同一作品终身最多 30 盏（2026-11-06 从「按作者」改成「按作品」：
const TIP_PER_AUTHOR_DAY = 50;           // 每人（按账号）每天给同一位作者最多 50 盏（2026-11-14 与设备维度对齐，
                                         // 20 → 50；不抬这道闸的话账号层会先卡在 20 盏，设备层的 50 用不上）
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
    // 打赏人名暂时不对公开：统一显示「一位访客」（2026-11-07 站长要求，恢复时改回 t.fromDisplay || '已注销用户'）
    .map(t => ({ name: '一位访客', amount: t.amount, at: t.createdAt }));
  const agg = tipAggOf(w.id);
  const viewer = currentUser(req);
  const out = { total: agg.total, count: agg.count, recent };
  if (viewer) out.adTip = tipAdView(shareRecOf(viewer.id), w.id);
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
  let myOutToday = 0, ipOutToday = 0, ipToAuthorToday = 0, ipToWorkTotal = 0, acctToAuthorToday = 0, ipToTargetCountToday = 0;
  for (const t of tips) {
    if (t.via === 'ad') continue;
    if (t.fromUserId === user.id && tipSameDay(t.createdAt)) myOutToday += t.amount;
    if (t.ipk === ipk && tipSameDay(t.createdAt)) ipOutToday += t.amount;
    const sameTarget = toUser ? (t.toUserId === toUser.id) : (!t.toUserId && t.workId === w.id);
    if (t.ipk === ipk && sameTarget && tipSameDay(t.createdAt)) { ipToAuthorToday += t.amount; ipToTargetCountToday++; }
    if (t.ipk === ipk && t.workId === w.id) ipToWorkTotal += t.amount;
    // 按账号（不只按设备）对同一位作者限日：2026-11-14 起 50 盏/天，作者页直送灯火也走同一本账
    if (t.fromUserId === user.id && toUser && t.toUserId === toUser.id && tipSameDay(t.createdAt)) acctToAuthorToday += t.amount;
  }
  const targetLabel = toUser ? '这位作者' : '这件作品';
  const altHint = toUser ? '换个作者可以接着送' : '换件作品可以接着送';
  // 站长（2026-11-13）：每天最多送 100 盏；设备/单作者等防小号闸对站长不生效（他自己一台机器就送得满 100）
  if (isSiteOwner(user)) {
    if (myOutToday + amount > TIP_DAILY_OUT_OWNER) {
      return res.status(400).json({ error: `今天已经送出去 ${myOutToday} 盏，站长每天最多送 ${TIP_DAILY_OUT_OWNER} 盏，明天再来` });
    }
  } else if (myOutToday + amount > TIP_DAILY_OUT) {
    return res.status(400).json({ error: `今天已经打赏出去 ${myOutToday} 盏，每人每天最多转出 ${TIP_DAILY_OUT} 盏，明天再来` });
  } else if (ipOutToday + amount > TIP_IP_DAILY_TOTAL) {
    return res.status(400).json({ error: `当前设备今天转出的灯火到上限了（${TIP_IP_DAILY_TOTAL} 盏/天），明天再来` });
  } else if (ipToTargetCountToday >= TIP_IP_PER_TARGET_COUNT) {
    return res.status(400).json({ error: `同一网络每天只能给${targetLabel}送 ${TIP_IP_PER_TARGET_COUNT} 笔灯火（今天已经送过了），明天再来；${altHint}` });
  } else if (acctToAuthorToday + amount > TIP_PER_AUTHOR_DAY) {
    return res.status(400).json({ error: `今天已经给${targetLabel}送了 ${acctToAuthorToday} 盏，每人每天给同一位作者最多 ${TIP_PER_AUTHOR_DAY} 盏，明天再来` });
  } else if (ipToAuthorToday + amount > TIP_IP_PER_AUTHOR_DAY) {
    return res.status(400).json({ error: `当前设备今天给${targetLabel}打赏的灯火到上限了（${TIP_IP_PER_AUTHOR_DAY} 盏/天）` });
  } else if (ipToWorkTotal + amount > TIP_IP_PER_WORK_TOTAL) {
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
      text: `${tip.fromDisplay} 打赏了你的作品「${w.title}」 ${amount} 盏灯火，当前余额 ${toBalance} 盏。灯火可以拿去「推荐」换推荐位。`,
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

// 作者页直送灯火（2026-11-13）：不经过具体作品，灯火全额转到作者账上。
// 入口在 /u/ 作者主页（绑定了账号的作者才显示）；限额与作品打赏同一套闸，
// 另加「每人每天给同一位作者最多 TIP_PER_AUTHOR_DAY 盏」的账号级闸（作品打赏也算进同一天的同一位作者）。
app.post('/api/authors/:ref/tip', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!rateLimit('tip:' + user.id, 10, 3600e3)) {
    return res.status(429).json({ error: '送灯火太频繁了，一小时后再试' });
  }
  if (!rateLimit('tipip:' + clientIp(req), 30, 3600e3)) {
    return res.status(429).json({ error: '当前网络送灯火太频繁，稍后再试' });
  }
  // 参数兼容两套：新链接传账号 id，老链接传账号名（与 /api/authors/:name 同口径）
  const toUser = userByRef(req.params.ref);
  if (!toUser) return res.status(404).json({ error: '作者不存在' });
  if (toUser.id === user.id) return res.status(400).json({ error: '不能给自己送灯火' });

  const amount = Math.floor(Number(req.body && req.body.amount));
  if (!TIP_AMOUNTS.includes(amount)) {
    return res.status(400).json({ error: '送灯火只能是 ' + TIP_AMOUNTS.join(' / ') + ' 盏' });
  }
  const rec = shareRecOf(user.id);
  const balance = rec.points || 0;
  if (balance < amount) {
    return res.status(400).json({ error: `灯火不够：还差 ${amount - balance} 盏（签到、分享、上传作品都能攒）` });
  }

  const ipk = ipKeyOf(req);
  let myOutToday = 0, ipOutToday = 0, acctToAuthorToday = 0, ipToAuthorToday = 0, ipToTargetCountToday = 0;
  for (const t of tips) {
    if (t.via === 'ad') continue;
    if (t.fromUserId === user.id && tipSameDay(t.createdAt)) myOutToday += t.amount;
    if (t.ipk === ipk && tipSameDay(t.createdAt)) ipOutToday += t.amount;
    if (t.fromUserId === user.id && t.toUserId === toUser.id && tipSameDay(t.createdAt)) acctToAuthorToday += t.amount;
    if (t.ipk === ipk && t.toUserId === toUser.id && tipSameDay(t.createdAt)) { ipToAuthorToday += t.amount; ipToTargetCountToday++; }
  }
  // 站长（2026-11-13）：每天最多送 100 盏，设备/单作者闸不生效（与作品打赏同一口径）
  if (isSiteOwner(user)) {
    if (myOutToday + amount > TIP_DAILY_OUT_OWNER) {
      return res.status(400).json({ error: `今天已经送出去 ${myOutToday} 盏，站长每天最多送 ${TIP_DAILY_OUT_OWNER} 盏，明天再来` });
    }
  } else if (myOutToday + amount > TIP_DAILY_OUT) {
    return res.status(400).json({ error: `今天已经打赏出去 ${myOutToday} 盏，每人每天最多转出 ${TIP_DAILY_OUT} 盏，明天再来` });
  } else if (ipOutToday + amount > TIP_IP_DAILY_TOTAL) {
    return res.status(400).json({ error: `当前设备今天转出的灯火到上限了（${TIP_IP_DAILY_TOTAL} 盏/天），明天再来` });
  } else if (ipToTargetCountToday >= TIP_IP_PER_TARGET_COUNT) {
    return res.status(400).json({ error: `同一网络每天只能给这位作者送 ${TIP_IP_PER_TARGET_COUNT} 笔灯火（今天已经送过了），明天再来；换个作者可以接着送` });
  } else if (acctToAuthorToday + amount > TIP_PER_AUTHOR_DAY) {
    return res.status(400).json({ error: `今天已经给这位作者送了 ${acctToAuthorToday} 盏，每人每天给同一位作者最多 ${TIP_PER_AUTHOR_DAY} 盏，明天再来` });
  } else if (ipToAuthorToday + amount > TIP_IP_PER_AUTHOR_DAY) {
    return res.status(400).json({ error: `当前设备今天给这位作者送灯火到上限了（${TIP_IP_PER_AUTHOR_DAY} 盏/天）` });
  }

  // 零和转移；workId 记 null（不挂作品，聚合统计会跳过它）
  const balanceAfter = addPoints(user.id, -amount, 'tip_out', null);
  const toBalance = addPoints(toUser.id, amount, 'tip_in', null);
  const tip = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workId: null,
    fromUserId: user.id,
    fromDisplay: displayNameOf(user.username),
    toUserId: toUser.id,
    onWorkOnly: false,
    authorGift: true,          // 作者页直送标记：区别于挂在具体作品上的打赏，便于审计
    amount,
    ipk,
    createdAt: Date.now()
  };
  tips.push(tip);
  saveTips();

  addNotice(toUser.id, {
    kind: 'points',
    title: `收到灯火 +${amount} 盏`,
    text: `${tip.fromDisplay} 在你的主页送了 ${amount} 盏灯火，当前余额 ${toBalance} 盏。灯火可以拿去「推荐」换推荐位。`,
    points: toBalance,
    delta: amount
  });

  res.json({ ok: true, amount, points: balanceAfter });
});

// ---------- 用灯火解锁作品（送灯火才能体验） ----------
// 作者给作品定一个价（几盏灯火），访客花自己的灯火解锁后，Web 链接 / 下载链接 / 小程序码才下发。
// 口径和打赏一致：零和转移，访客扣 N 盏、作者得 N 盏，平台不抽成，也不产生新灯火。
// 一次解锁永久有效；作者本人不用解锁；未认领（没有账号）的作品不能开解锁——否则灯火没处进账。
app.post('/api/works/:id/unlock', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const w = works.find(x => x.id === req.params.id);
  if (!w || w.deleted) return res.status(404).json({ error: '作品不存在' });
  const price = w.paidModel === 'lamp' ? normLampPrice(w.lampPrice) : 0;
  if (!price) return res.status(400).json({ error: '这件作品不需要用灯火解锁' });
  if (w.userId && w.userId === user.id) {
    return res.json({ ok: true, already: true, owner: true, price, points: shareRecOf(user.id).points, work: publicWork(w, user) });
  }
  if (lampUnlockOf(w.id, user.id)) {
    return res.json({ ok: true, already: true, price, points: shareRecOf(user.id).points, work: publicWork(w, user) });
  }
  const owner = w.userId ? users.find(u => u.id === w.userId) : null;
  if (!owner) return res.status(400).json({ error: '作者还没认领这件作品，暂时没法解锁' });

  const rec = shareRecOf(user.id);
  const balance = rec.points || 0;
  if (balance < price) {
    return res.status(400).json({ error: `灯火不够：还差 ${price - balance} 盏（签到、分享、上传作品都能攒）`, need: price, balance });
  }
  const balanceAfter = addPoints(user.id, -price, 'lamp_out', w.id);
  const ownerBalance = addPoints(owner.id, price, 'lamp_in', w.id);
  lampUnlockStore[w.id] = lampUnlockStore[w.id] || {};
  lampUnlockStore[w.id][user.id] = Date.now();
  saveLampUnlocks();
  addNotice(owner.id, {
    kind: 'points',
    title: `作品被解锁 +${price} 盏灯火`,
    text: `${displayNameOf(user.username)} 用 ${price} 盏灯火解锁了你的作品「${w.title}」，当前余额 ${ownerBalance} 盏。`,
    points: ownerBalance,
    delta: price
  });
  res.json({ ok: true, already: false, price, points: balanceAfter, work: publicWork(w, user) });
});

// ---------- 看广告替作品点灯（平台代送，观众不扣自己的灯火） ----------
// 小程序详情页看完一支激励视频，平台替观众给这件作品送 50 盏灯火：
// 不扣观众余额（灯火不是从观众账户转出去的），有作者就照常入作者账，匿名作品只记在作品上。
// 额度三道闸（都按观众维度，存在 share.json 的 tipAd 字段）：
//   ① 每天 3 次  ② 同一作品每人每天 1 次（防同一个人把广告全砸一个作品刷热度）  ③ 两次间隔 15 秒（防连点）
// 注意：广告代送不占自费打赏的 IP 闸门（每天 10 盏/作者、按作品终身 30 盏），/tip 统计时跳过 via='ad'；
// 也就是说「每天看广告送 50 盏」是独立于自费打赏的固定通道，不会被终身闸锁死，自费额度也不会被它吃掉。
// 账本：tips 里 via='ad' 单独标记，和自掏腰包的打赏分得开，可审计。
// 2026-11-12 站长定档：单次 30 → 50（每天仍 3 次，单日上限随之 90 → 150）。改价只动这一处，
// 小程序端一律读 /tips 返回的 adTip.amount，配置文件里的 50 只是断网兜底展示值。
const TIP_AD_AMOUNT = 50;
const TIP_AD_DAILY = 3;

// workId 可选：传了就多带两个「拉广告之前就该知道」的字段，
// 否则小程序会把同一作品今天的第二支广告完整看完、服务端才拒 —— 广告白看了。
//   done   = 这件作品今天已经点过灯（同一作品每人每天 1 次的闸）
//   waitMs = 距离下一支可送还差多少毫秒（两次间隔 15 秒的闸，0 = 不用等）
function tipAdView(rec, workId) {
  const ta = rec.tipAd || {};
  const today = dateKey();
  const isToday = ta.day === today;
  const used = isToday ? (ta.count || 0) : 0;
  const out = {
    amount: TIP_AD_AMOUNT,
    limit: TIP_AD_DAILY,
    used,
    left: Math.max(0, TIP_AD_DAILY - used),
    gapMs: AD_REWARD_GAP_MS
  };
  if (workId) {
    const works = isToday && Array.isArray(ta.works) ? ta.works : [];
    out.done = works.includes(workId);
    out.waitMs = isToday && ta.at ? Math.max(0, AD_REWARD_GAP_MS - (Date.now() - ta.at)) : 0;
  }
  return out;
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
    return res.status(400).json({ error: `今天 ${TIP_AD_DAILY} 次看广告送灯已经用完了，明天再来`, adTip: tipAdView(rec, w.id) });
  }
  if (Array.isArray(ta.works) && ta.works.includes(w.id)) {
    return res.status(400).json({ error: '这件作品今天已经点过灯了，明天再来，或换个作品送', adTip: tipAdView(rec, w.id) });
  }
  if (ta.at && Date.now() - ta.at < AD_REWARD_GAP_MS) {
    return res.status(429).json({ error: '广告刚看完，稍等一下再送', adTip: tipAdView(rec, w.id) });
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
      text: `${tip.fromDisplay} 看完广告为你的作品「${w.title}」点了 ${TIP_AD_AMOUNT} 盏灯（平台代送，不扣对方的灯火），当前余额 ${toBalance} 盏。灯火可以拿去「推荐」换推荐位。`,
      points: toBalance,
      delta: TIP_AD_AMOUNT
    });
  }

  const agg = tipAggOf(w.id);
  res.json({
    ok: true,
    amount: TIP_AD_AMOUNT,
    anonymousWork: !toUser,
    adTip: tipAdView(rec, w.id),
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
    // 原作者主张移除：按「通知—删除」优先处理，后台排队置顶。
    // 小程序端没有单独的「我是原作者」选项（ActionSheet 上限 6 项，已并入涉嫌侵权），
    // 所以涉嫌侵权 + 说明里自称原作者的，同样按 high 处理。
    priority: reason === '我是原作者，希望移除' || (reason === '涉嫌侵权/盗用他人作品' && /原作者|盗用|盗图|抄袭/.test(String(description || ''))) ? 'high' : 'normal',
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
    // 头像只给实名楼层：匿名楼层的 username 是访客随手填的字，撞上某个账号名就会串头像
    avatar: c.anon ? '' : avatarUrlOf(userByName(c.username)),
    text: c.text,
    createdAt: c.createdAt,
    parentId: c.parentId || null,
    kind: c.kind === 'question' ? 'question' : 'comment',
    qtype: c.qtype || null,
    vote: c.vote || null,     // 三选一轻反馈（useful / confused / broken），普通评论为 null
    priv: !!c.priv,
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
  // 私密发言（仅作者可见）：只对 作品作者、发言者本人、管理员 可见；
  // 楼内回复跟楼层一起隐藏（回复落库时就继承了楼层的 priv）。别人连数量都摸不到。
  let vis = all;
  if (!admin) {
    const uid = user ? String(user.id) : null;
    const isOwner = !!(uid && w.userId && String(w.userId) === uid);
    if (!isOwner) {
      const privRoots = new Set(all.filter(c => !c.parentId && c.priv).map(c => c.id));
      const rootById = new Map(all.filter(c => !c.parentId).map(c => [c.id, c]));
      const floorOwnerOf = c => {
        if (!c.parentId || !privRoots.has(c.parentId)) return null;
        const root = rootById.get(c.parentId);
        return (root && root.userId) ? String(root.userId) : null;
      };
      vis = all.filter(c => {
        // 自己发的总能看到
        if (uid && c.userId && String(c.userId) === uid) return true;
        // 私密楼层：只有楼层主人（和作者/管理员）能看
        if (c.priv) return !!(uid && c.parentId && floorOwnerOf(c) === uid);
        // 普通回复挂在私密楼层下：同样只有楼层主人能看
        if (c.parentId && privRoots.has(c.parentId)) return !!(uid && floorOwnerOf(c) === uid);
        return true;
      });
    }
  }
  const byId = new Map(vis.map(c => [c.id, c]));
  // 作者回复过的提问 id（回复者是作品作者）
  const answered = new Set();
  for (const c of vis) {
    if (!c.parentId) continue;
    if (commentIsAuthor(c, w)) answered.add(c.parentId);
  }
  const top = vis.filter(c => !c.parentId);
  const replies = vis.filter(c => c.parentId);
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
  // 顶级发言类型：comment 评论 / question 提问 / bug Bug反馈 / sug 建议
  // bug 和 sug 本质也是提问（走提问的排序、通知、回复闭环），只是多了个类型标签
  const QTYPES = { question: null, bug: 'bug', sug: 'sug' };
  let kind = 'comment';
  let qtype = null;
  if (!parentId && QTYPES[body.kind] !== undefined) {
    kind = 'question';
    qtype = QTYPES[body.kind];
  }

  // 私密发言（仅作者可见）：只有登录用户能勾；匿名没有身份，勾了下次自己也看不见、作者回复也送不到
  // 楼层私密时楼里回复跟着私密；且看不见该楼层的人不允许回复（API 直发也不行）
  const privRoot = parentId ? comments.find(c => c.id === parentId && c.priv) : null;
  if (privRoot) {
    const isOwner = !!(user && w.userId && user.id === w.userId);
    const isFloorOwner = !!(user && privRoot.userId && user.id === privRoot.userId);
    if (!isOwner && !isFloorOwner && !isAdmin(req)) {
      return res.status(403).json({ error: '这条仅作者可见' });
    }
  }
  const priv = privRoot ? true : !!(user && !parentId && body.priv);

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
    qtype,
    priv,
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
    // 顶级评论 / 提问 / Bug反馈 / 建议 → 通知作品作者
    const isSelf = !!w.userId && ((user && user.id === w.userId) || (c.userId && c.userId === w.userId));
    if (w.userId && !isSelf) {
      let nKind = 'work-comment', nTitle = `收到新评论 · ${w.title}`, nVerb = ' 评论了你的作品：';
      if (kind === 'question') {
        const tpl = {
          question: { k: 'work-question', t: `收到新提问 · ${w.title}`, v: ' 向你提问：' },
          bug: { k: 'work-question', t: `收到 Bug 反馈 · ${w.title}`, v: ' 反馈了 Bug：' },
          sug: { k: 'work-question', t: `收到新建议 · ${w.title}`, v: ' 提了建议：' }
        }[qtype || 'question'];
        nKind = tpl.k; nTitle = tpl.t; nVerb = tpl.v;
        if (priv) nTitle += '（仅作者可见）';
      }
      addNotice(w.userId, {
        kind: nKind,
        title: nTitle,
        text: `${say}${nVerb}${brief}${priv ? '（仅作者可见）' : ''}`,
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

// 详情页「三选一」轻反馈：点一下就是一条评论，作者能收到通知，访客不用组织语言。
// 站内评论长期个位数，卡在「写评论成本太高」这一环；把它降到一次点击（2026-11-09）。
// 同一身份对同一作品只留一条，改选就改那条，不重复计数。
const VOTE_TEXTS = {
  useful: '用过，挺有用',
  confused: '还没太看懂，能简单说下怎么用吗',
  broken: '打不开，链接好像有问题'
};
app.post('/api/works/:id/vote', (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const v = String((req.body && req.body.vote) || '');
  if (!VOTE_TEXTS[v]) return res.status(400).json({ error: '不认识的选项' });
  const user = currentUser(req);
  if (user && w.userId && w.userId === user.id) return res.status(400).json({ error: '这是你自己的作品' });
  if (!rateLimit('vote:' + clientIp(req), 30, 600000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const vid = user ? 'u:' + user.id : 'ip:' + ipKeyOf(req);
  const text = VOTE_TEXTS[v];
  let c = comments.find(x => x.workId === w.id && x.vote && x.vid === vid);
  const changed = !!c;
  if (c) {
    c.vote = v; c.text = text; c.createdAt = Date.now();
    if (user) { c.userId = user.id; c.username = user.username; c.anon = false; }
  } else {
    c = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      workId: w.id,
      userId: user ? user.id : null,
      username: user ? user.username : '匿名',
      text,
      createdAt: Date.now(),
      parentId: null,
      replyToId: null,
      kind: 'comment',
      qtype: null,
      priv: false,
      anon: !user,
      vote: v,
      vid
    };
    comments.push(c);
  }
  saveComments();
  invalidateCommentCounts();
  // 作者通知：改选不再打扰，只在第一次投的时候发一条
  if (!changed && w.userId) {
    addNotice(w.userId, {
      kind: 'work-comment',
      title: `有人给「${w.title}」投了反馈`,
      text: `${user ? displayNameOf(user.username) : '一位访客'}：${text}`,
      workId: w.id,
      commentId: c.id
    });
  }
  const byId = new Map(comments.filter(x => x.workId === w.id).map(x => [x.id, x]));
  res.json({ ok: true, vote: v, created: !changed, comment: shapeComment(c, w, user, isAdmin(req), byId, new Set()) });
});

// 众人小法官：给「疑似推广」投票（详情页）。一人一票、可改票；认定票够数自动下架待整改。
// 和上面三选一轻反馈不是一回事：那条是给作者的使用反馈（落成评论），这条是对作品的合规众判。
app.post('/api/works/:id/jury', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '登录后才能参与众判' });
  const w = works.find(x => x.id === req.params.id);
  if (!w || !isVisible(w)) return res.status(404).json({ error: '作品不存在或已下架' });
  const why = juryCanVote(w, user);
  if (why === 'own') return res.status(400).json({ error: '不能给自己的作品投票' });
  if (why === 'closed') return res.status(400).json({ error: '这件作品已经判下架，等作者整改完再议' });
  if (why === 'fresh') return res.status(403).json({ error: `账号注册满 ${Math.round(JURY_MIN_AGE_MS / 3600000)} 小时后才能参与众判（防小号刷票）` });
  const v = String((req.body && req.body.vote) || '');
  if (!JURY_VOTE_TEXT[v]) return res.status(400).json({ error: '不认识的选项' });
  if (!rateLimit('jury:' + clientIp(req), 30, 3600000)) return res.status(429).json({ error: '投票太频繁，歇一会儿再投' });

  const box = juryData.votes[w.id] || (juryData.votes[w.id] = {});
  const prev = box[user.id];
  // 同一网络（IP 哈希）对同一件作品最多计入 2 张认定票：一个宿舍 / 一个办公室开 6 个小号
  // 就能把小作品投死，这是这套玩法最大的攻击面。改票不重复计数，只数别的账号。
  if (v === 'sus' && JURY_IP_MAX > 0 && !isSiteOwner(user)) {
    const ipk = ipKeyOf(req);
    const sameIp = Object.keys(box).filter(k => k !== user.id && box[k] && box[k].v === 'sus' && box[k].ip === ipk).length;
    if (sameIp >= JURY_IP_MAX) {
      return res.status(429).json({ error: `同一个网络下已有 ${JURY_IP_MAX} 人投过认定票，这一票先不计数（防小号刷票）；换个人来投才算数` });
    }
  }
  const c0 = juryCaseOf(w.id);
  if (prev && prev.v === v) {
    // 重复点同一项：幂等，不重复计票（手机连点、刷新后再点都会走这里）
    return res.json({ ok: true, changed: false, removed: !!(c0 && c0.status === 'removed'), jury: juryPublic(w, user) });
  }
  box[user.id] = { v, at: new Date().toISOString(), name: user.username, ip: ipKeyOf(req) };
  const c = juryData.cases[w.id] || (juryData.cases[w.id] = {});
  // 结案过的案子又有人投票 = 开新一轮（结案时票已清空，不会跟上一轮混在一起）
  if (!c.flaggedAt || c.status === 'cleared') {
    c.flaggedAt = new Date().toISOString();
    c.status = 'open';
    delete c.clearedAt;
    delete c.clearedBy;
    delete c.removedAt;                  // 上一轮的下架时间别留到这一轮，否则后台显示「下架早于贴标」
    c.history = (c.history || []).concat([{ at: c.flaggedAt, action: 'reopened' }]);
  }
  if (v === 'sus' && !c.firstSusAt) c.firstSusAt = box[user.id].at;
  const t = juryTally(w.id);
  let removed = false;
  // 判下架：净差（认定 − 反对）达到门槛。6:1、8:4 下架；6:5、10:6 这种胶着局面不下架，
  // 反对票随时能把净差拉回门槛以下 —— 留给人继续投，也留给站长人工复核
  if (t.sus - t.ok >= JURY_REMOVE_GAP && c.status !== 'removed') {
    removeByJury(w, c, t);
    removed = true;
  }
  saveJuryNow();
  if (removed) saveWorksNow();          // 状态变更必须立刻落盘，不能等 300ms 合并
  res.json({ ok: true, changed: true, removed, jury: juryPublic(w, user), tally: t });
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

// 用户侧：清空自己的行为流水（「我的浏览记录」那个按钮打这里）。
// 登录用户清 u:<id>；未登录网页靠前端带 vid（这串是本人浏览器里的随机标识，别人猜不到）。
// 只能清自己这一条，不能指定别人的键——所以不接受任意 personKey 入参。
app.post('/api/behavior/clear', (req, res) => {
  const body = req.body || {};
  if (!rateLimit('bhclear:' + clientIp(req), 10, 3600000)) {
    return res.status(429).json({ error: '操作太频繁了，过一会儿再试' });
  }
  const user = currentUser(req);
  let key = '';
  if (user && user.id) {
    key = 'u:' + user.id;
  } else {
    const vid = /^[A-Za-z0-9_-]{8,40}$/.test(String(body.vid || '')) ? String(body.vid) : '';
    if (vid) key = 'v:' + vid;
  }
  if (!key) return res.status(400).json({ error: '认不出这台设备，无法清除' });
  const out = behaviorClear(key);
  res.json({ ok: true, removed: out.removed });
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
    friendReqs: friendReqs.length,
    // 开源好物提交队列：前台弹窗提交、star 没过自动线等着人工看的
    openSubmits: openSource.pendingSubmitCount(),
    // 微信客服未读（小程序消息推送过来的会话，后台「微信客服」页处理）
    kf: Object.keys(kfThreads).reduce((s, k) => s + (kfThreads[k].unread || 0), 0),
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

// ---- 搜索词屏蔽名单（后台手动拉黑，不进前台热搜榜） ----
// GET：把名单整份读给后台；POST：block / unblock 一个词。
// 改完立刻作废热搜缓存——不用等 60 秒 TTL，前台下一次拉就是新榜单。
function readSearchBlockFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'search-block.json'), 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

app.get('/api/admin/search-block', requireAdmin, (req, res) => {
  res.json({ words: readSearchBlockFile() });
});

app.post('/api/admin/search-block', requireAdmin, (req, res) => {
  const body = req.body || {};
  const action = body.action === 'unblock' ? 'unblock' : 'block';
  const word = normSearchQ(body.q);
  if (action === 'block' && !word) return res.status(400).json({ error: '词不能为空' });
  if (word.length > SEARCH_KW_MAXLEN) return res.status(400).json({ error: '词太长了' });
  const key = word.toLowerCase();
  // 同词不同写法只留一份（小写合并），unblock 也按小写匹配才能把当初拉黑的词真正删掉
  const words = readSearchBlockFile().filter(x => normSearchQ(x).toLowerCase() !== key);
  if (action === 'block') words.push(word);
  try {
    writeJSON('search-block.json', words);
  } catch (e) {
    return res.status(500).json({ error: '保存失败，请重试' });
  }
  hotSearchCache = { at: 0, items: null };   // 作废热搜缓存，前台立刻生效
  res.json({ ok: true, action, words });
});

// 行为流水看板：单独一个接口，不塞进 /api/admin/stats——
// stats 是后台每次刷新/定时都会拉的，流水要扫月度文件，没必要绑在一起跑。
app.get('/api/admin/behavior', requireAdmin, (req, res) => {
  try {
    res.json(behaviorStats(req.query.days));
  } catch (e) {
    res.status(500).json({ error: '统计失败：' + e.message });
  }
});

// 手动清掉某个人的流水（后台「人」那一栏的操作；用户自助清空走 /api/behavior/clear）
app.post('/api/admin/behavior/clear', requireAdmin, (req, res) => {
  const key = String((req.body && req.body.p) || '');
  if (!BEHAVIOR_PERSON_RE.test(key)) return res.status(400).json({ error: '人键格式不对' });
  res.json({ ok: true, ...behaviorClear(key) });
});

// ---------- 注册统计看板 ----------
// 单独接口，不塞进 /api/admin/stats：那边后台每次刷新都拉，这边口径多
// （按天 / 星期 / 来源 / 绑定 / 标签），独立成页，切时间窗时各查各的。
// 口径（后台页面上也写了一份，改这里记得同步文案）：
//  · 「注册」一律按 createdAt 的本地日期归天；KPI 指标固定全量口径，不随窗口切换
//  · 走势图按所选窗口补齐空天（从窗口首日到今天一天不落），累计 = 窗口前存量 + 逐日新增
//  · 「邀请注册」与端来源口径有重叠（小程序注册也可能带 invitedBy），页面上有说明
function regStatsForAdmin(daysRaw) {
  const days = [7, 30, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 0;   // 0 = 全部
  const fromMs = days > 0 ? Date.now() - days * 86400e3 : 0;
  const today = dateKey();
  const weekAgo = dateKey(new Date(Date.now() - 6 * 86400e3));
  const monthAgo = dateKey(new Date(Date.now() - 29 * 86400e3));

  let usersToday = 0, users7 = 0, users30 = 0;
  const byDay = new Map();          // 注册日 -> { n, mini, invited, gh, wx }
  const weekday = [0, 0, 0, 0, 0, 0, 0];   // 周一..周日，窗口内
  let miniAll = 0, invitedAll = 0, tempAll = 0, bindWx = 0, bindGh = 0;
  const tagCount = new Map();
  const withAt = [];

  users.forEach(u => {
    const at = u.createdAt ? new Date(u.createdAt) : null;
    const d = at ? dateKey(at) : '';
    if (d === today) usersToday += 1;
    if (d && d >= weekAgo) users7 += 1;
    if (d && d >= monthAgo) users30 += 1;
    if (at && (!fromMs || at.getTime() >= fromMs)) {
      const o = byDay.get(d) || { n: 0, mini: 0, invited: 0, gh: 0, wx: 0 };
      o.n += 1;
      if (u.regFrom === 'mini') o.mini += 1;
      if (u.invitedBy) o.invited += 1;
      if (u.github) o.gh += 1;
      if (u.wechat) o.wx += 1;
      byDay.set(d, o);
      weekday[(at.getDay() + 6) % 7] += 1;
    }
    if (u.regFrom === 'mini') miniAll += 1;
    if (u.invitedBy) invitedAll += 1;
    if (u.tempAcct) tempAll += 1;
    if (u.wechat) bindWx += 1;
    if (u.github) bindGh += 1;
    (Array.isArray(u.tags) ? u.tags : []).forEach(t => tagCount.set(t, (tagCount.get(t) || 0) + 1));
    if (at) withAt.push(u);
  });

  // 窗口起点：days=0 从第一个注册日起；空天也补齐，曲线才连续
  const startDay = days > 0 ? dateKey(new Date(fromMs)) : ([...byDay.keys()].sort()[0] || today);
  let cum = users.filter(u => {
    const dd = u.createdAt ? dateKey(new Date(u.createdAt)) : '';
    return dd && dd < startDay;
  }).length;
  const daily = [];
  for (let t = new Date(startDay + 'T00:00:00'); dateKey(t) <= today; t = new Date(t.getTime() + 86400e3)) {
    const k = dateKey(t);
    const o = byDay.get(k) || { n: 0, mini: 0, invited: 0, gh: 0, wx: 0 };
    cum += o.n;
    daily.push({ d: k, n: o.n, mini: o.mini, invited: o.invited, gh: o.gh, wx: o.wx, cum });
  }

  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, n]) => ({ name, n }));

  const recent = withAt
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(u => ({
      at: u.createdAt,
      name: u.nickname || u.username || '未命名',
      from: u.regFrom === 'mini' ? '小程序' : '网页',
      invited: u.invitedBy || '',
      temp: !!u.tempAcct,
      tags: (Array.isArray(u.tags) ? u.tags : []).join('、'),
      actDay: u.actDay || '',
      gh: (u.github && u.github.login) || '',
      wx: !!u.wechat,
    }));

  return {
    days,
    from: daily.length ? daily[0].d : today,
    to: today,
    total: users.length,
    usersToday, users7, users30,
    activeToday: users.filter(u => u.actDay === today).length,
    miniAll, invitedAll, tempAll, bindWx, bindGh,
    weekday, tags, recent, daily,
  };
}

app.get('/api/admin/reg-stats', requireAdmin, (req, res) => {
  try {
    res.json(regStatsForAdmin(req.query.days));
  } catch (e) {
    res.status(500).json({ error: '统计失败：' + e.message });
  }
});

// ---------- 推荐效果看板（作者用灯火买的自荐位） ----------
// 和「广告位」的分工：那边是全部广告（含站长人工挂的招商位）；这里只看 ad-redemptions.json
// 里的兑换单，回答一个问题——大家花灯火买的推荐，到底被看到多少、被点多少、值不值。
//
// 口径（后台页面上也写了一份，改这里记得同步文案）：
//  · 一张单子的活跃期和所选窗口有交集就纳入：在投的老单也算，否则看不到正在烧的效果
//  · 曝光 / 点击按 ad-stats 的每日明细在窗口内累加；UV 是窗口内去重人数，不是每天相加
//  · 「已消耗」按下单时锁住的单价折算（和退款同一口径），不按现价重算
//  · 点击明细 2026-11-04 起才有；更早的点击只留了累计总数，窗口内会算成 0，别当成没效果
const REDEEM_STATUS_TEXT = { active: '在投', queued: '排队中', used_up: '已投完', expired: '已到期', cancelled: '已撤下' };
const REDEEM_OVERVIEW_DAYS = [7, 30, 90, 0];   // 0 = 全部（ad-stats 只留 90 天，全部也看不回更早的明细）

// 单支广告在某个时间窗内的曝光 / 点击：UV 是窗口内去重，不是把每天的人数相加
function adStatsWindow(adId, fromDay) {
  let pv = 0, clk = 0;
  const uv = new Set(), clkUv = new Set();
  Object.keys(adStats).forEach(d => {
    if (fromDay && d < fromDay) return;
    const st = adStats[d] && adStats[d][adId];
    if (!st) return;
    pv += st.pv || 0;
    Object.keys(st.uv || {}).forEach(k => uv.add(k));
    if (st.clk) {
      clk += st.clk.pv || 0;
      Object.keys(st.clk.uv || {}).forEach(k => clkUv.add(k));
    }
  });
  return { pv, uv: uv.size, clk, clkUv: clkUv.size };
}

function redeemOverview(daysRaw) {
  const days = REDEEM_OVERVIEW_DAYS.includes(Number(daysRaw)) ? Number(daysRaw) : 30;
  const fromMs = days > 0 ? Date.now() - days * 86400e3 : 0;
  const fromDay = fromMs ? dateKey(new Date(fromMs)) : '';
  const today = dateKey();

  const rows = redemptions.filter(r => {
    if (!r) return false;
    if (!fromMs) return true;
    if ((Number(r.createdAt) || 0) >= fromMs) return true;
    if (r.status === 'active' || r.status === 'queued') return true;      // 老单还在投，效果要算进来
    return (Number(r.endedAt) || 0) >= fromMs;
  }).map(r => {
    const ad = ads.find(a => a.id === r.adId);
    const st = ad ? adStatsWindow(ad.id, fromDay) : { pv: 0, uv: 0, clk: 0, clkUv: 0 };
    const w = works.find(x => x.id === r.workId) || {};
    const u = users.find(x => x.id === r.userId) || {};
    const cfg = redeemCfg(r.slot);
    const adSlot = AD_SLOTS.find(s => s.key === r.slot) || {};
    // 单价一律取订单锁住的那份：中途调价不能把老单的账算歪
    const showViews = r.showViews || cfg.showViews || 1;
    const showPts = typeof r.showPoints === 'number' ? r.showPoints : cfg.showPoints;
    const clickPts = typeof r.clickPoints === 'number' ? r.clickPoints : cfg.clickPoints;
    const viewsBought = r.views || 0;
    const clicksBought = r.clicks || 0;
    const used = r.status === 'active' && ad
      ? Math.max(0, viewsBought - (ad.budget || 0))
      : Math.max(0, r.used || 0);
    const clickUsed = r.status === 'active' && ad
      ? Math.max(0, clicksBought - (ad.clickLeft || 0))
      : Math.max(0, r.clickUsed || 0);
    // 已消耗 = 用掉的展示额度 × 锁价 + 用掉的点击额度 × 锁价；不会超过实付
    const spent = Math.min(r.price || 0, Math.round(used / showViews * showPts + clickUsed * clickPts));
    return {
      id: r.id, adId: r.adId || '',
      userId: r.userId || '', userName: u ? (u.nickname || u.username || '未命名') : '（账号已注销）',
      workId: r.workId || '', workTitle: w.title || '（作品已下线）',
      thumb: w.thumb || w.image || '',
      slot: r.slot, slotName: cfg.name || r.slot,
      platform: adSlot.platform === 'mini' ? 'mini' : 'web',
      status: r.status, statusText: REDEEM_STATUS_TEXT[r.status] || r.status || '—',
      createdAt: Number(r.createdAt) || 0, startsAt: Number(r.startsAt) || 0, endsAt: Number(r.endsAt) || 0,
      days: redemptionDaysOf(r), extLink: r.extLink === true, link: r.link || '',
      comp: r.comp === true,   // 站长代投单：后台列表挂「站长代投」标，不显示额度进度与消耗
      // 代投单的展示优先级：老单没有这个字段，空串＝跟随右上角的全局投放权重
      prio: r.comp === true && COMP_PRIO_MODES.includes(String(r.prio || '')) ? String(r.prio) : '',
      prioLabel: r.comp === true ? (COMP_PRIO_LABEL[String(r.prio || '')] || '跟随全局') : '',
      viewsBought, clicksBought, used, left: Math.max(0, viewsBought - used),
      clickUsed, clickLeft: Math.max(0, clicksBought - clickUsed),
      pv: st.pv, uv: st.uv, clicks: st.clk, clickUv: st.clkUv,
      ctr: st.pv ? Math.round(st.clk / st.pv * 1000) / 10 : 0,
      clicksAll: ad ? (ad.clicks || 0) : 0,       // 累计点击（含 11-04 前没有明细的部分）
      pvAll: ad ? adStatsOf(ad.id).pv : 0,
      price: r.price || 0, spent, refunded: r.refunded || 0,
      // 还挂在页面上、没被消耗掉也没退的那部分：在投单才有意义
      pending: Math.max(0, (r.price || 0) - spent - (r.refunded || 0))
    };
  });

  const sum = k => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const totals = {
    orders: rows.length,
    active: rows.filter(r => r.status === 'active').length,
    queued: rows.filter(r => r.status === 'queued').length,
    ended: rows.filter(r => r.status !== 'active' && r.status !== 'queued').length,
    authors: new Set(rows.map(r => r.userId).filter(Boolean)).size,
    works: new Set(rows.map(r => r.workId).filter(Boolean)).size,
    extOrders: rows.filter(r => r.extLink).length,
    viewsBought: sum('viewsBought'), used: sum('used'), left: sum('left'),
    clicksBought: sum('clicksBought'), clickUsed: sum('clickUsed'),
    pv: sum('pv'), uv: sum('uv'), clicks: sum('clicks'), clickUv: sum('clickUv'),
    price: sum('price'), spent: sum('spent'), refunded: sum('refunded'), pending: sum('pending')
  };
  totals.ctr = totals.pv ? Math.round(totals.clicks / totals.pv * 1000) / 10 : 0;
  // 实际每次曝光的成本（盏）：跨位置比较谁更划算就看这个
  totals.costPerView = totals.used ? Math.round(totals.spent / totals.used * 100) / 100 : 0;
  totals.costPerClick = totals.clicks ? Math.round(totals.spent / totals.clicks * 100) / 100 : 0;

  // 按位置：只列有人投过的位，空位不占地方
  const slots = REDEEM_SLOTS.map(cfg => {
    const list = rows.filter(r => r.slot === cfg.key);
    if (!list.length) return null;
    const s2 = k => list.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const pv = s2('pv'), clicks = s2('clicks'), used = s2('used'), spent = s2('spent');
    return {
      key: cfg.key, name: cfg.name || cfg.key,
      platform: (AD_SLOTS.find(s => s.key === cfg.key) || {}).platform === 'mini' ? 'mini' : 'web',
      showPoints: cfg.showPoints, clickPoints: cfg.clickPoints,
      orders: list.length,
      active: list.filter(r => r.status === 'active').length,
      authors: new Set(list.map(r => r.userId).filter(Boolean)).size,
      viewsBought: s2('viewsBought'), used,
      clicksBought: s2('clicksBought'), clickUsed: s2('clickUsed'),
      pv, uv: s2('uv'), clicks, ctr: pv ? Math.round(clicks / pv * 1000) / 10 : 0,
      price: s2('price'), spent, refunded: s2('refunded'),
      costPerView: used ? Math.round(spent / used * 100) / 100 : 0
    };
  }).filter(Boolean).sort((a, b) => b.spent - a.spent);

  // 按投放人：谁在为推荐花钱、效果如何
  const byAuthor = {};
  rows.forEach(r => {
    const k = r.userId || '?';
    const a = byAuthor[k] || (byAuthor[k] = {
      userId: k, name: r.userName, orders: 0, works: new Set(),
      pv: 0, uv: 0, clicks: 0, spent: 0, refunded: 0, used: 0
    });
    a.orders += 1; a.works.add(r.workId);
    a.pv += r.pv; a.uv += r.uv; a.clicks += r.clicks;
    a.spent += r.spent; a.refunded += r.refunded; a.used += r.used;
  });
  const authors = Object.values(byAuthor).map(a => ({
    ...a, works: a.works.size,
    ctr: a.pv ? Math.round(a.clicks / a.pv * 1000) / 10 : 0
  })).sort((x, y) => y.spent - x.spent || y.orders - x.orders);

  // 每日趋势（只数这些单子的广告）：图表最多看 30 天，太长就挤成一团看不清
  const adIds = new Set(rows.map(r => r.adId).filter(Boolean));
  const dayMap = {};
  Object.keys(adStats).forEach(d => {
    if (fromDay && d < fromDay) return;
    const bucket = adStats[d] || {};
    let pv = 0, clk = 0;
    adIds.forEach(id => {
      const st = bucket[id];
      if (!st) return;
      pv += st.pv || 0;
      clk += (st.clk && st.clk.pv) || 0;
    });
    if (pv || clk) dayMap[d] = { d, pv, clk };
  });
  const daily = [];
  const firstDay = fromDay || (Object.keys(dayMap).sort()[0] || today);
  const cur = new Date(firstDay + 'T00:00:00');
  const end = new Date(today + 'T00:00:00');
  while (cur <= end && daily.length < 400) {
    const d = dateKey(cur);
    daily.push(dayMap[d] || { d, pv: 0, clk: 0 });
    cur.setDate(cur.getDate() + 1);
  }

  return {
    days, from: daily.length ? daily[0].d : today, to: today,
    generatedAt: new Date().toISOString(),
    // 投放权重：优先用户 / 平级 / 优先站长（后台「投放单」页顶部可切，默认优先用户）
    priority: promoPriorityMode(),
    priorityLabel: PROMO_PRIORITY_LABEL[promoPriorityMode()],
    slotsCfg: REDEEM_SLOTS.map(c => ({ key: c.key, name: c.name || c.key })),
    totals, slots, authors, daily,
    orders: rows.sort((a, b) => b.createdAt - a.createdAt)
  };
}

app.get('/api/admin/redeem-overview', requireAdmin, (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(redeemOverview(req.query.days));
  } catch (e) {
    res.status(500).json({ error: '统计失败：' + e.message });
  }
});

// 投放权重切换：同一个推荐位有多条在投时谁先上，见 promoPriorityMode 的口径。
// 切换即时生效（/api/ads 每次现算，不缓存），不动已有订单、不退款、不改扣费规则。
app.post('/api/admin/promo-priority', requireAdmin, (req, res) => {
  const mode = String((req.body && req.body.mode) || '');
  if (!PROMO_PRIORITY_MODES.includes(mode)) {
    return res.status(400).json({ error: '只支持 user（优先用户）/ tie（平级）/ owner（优先站长）' });
  }
  promoPriorityCfg.mode = mode;
  promoPriorityCfg.updatedAt = Date.now();
  promoPriorityCfg.updatedBy = (currentUser(req) || {}).username || 'admin';
  savePromoPriority();
  res.json({ ok: true, priority: mode, priorityLabel: PROMO_PRIORITY_LABEL[mode] });
});

// GitHub star 同步：管理员排障用，按同一套结算规则跑全站（没有定时任务，手动触发才有）
app.post('/api/admin/starsync', requireAdmin, async (req, res) => {
  if (STAR_REWARD_RATE <= 0) return res.status(400).json({ error: 'STAR_REWARD_RATE 为 0，star 奖励已关闭' });
  try {
    const out = await syncStarsForUser(null, { admin: true });
    const repos = Object.entries(starSync.repos).map(([key, r]) => ({
      repo: key, count: r.count, at: r.at, day: r.day || '', dayAwarded: r.dayAwarded || 0, awardedStars: r.awardedStars || 0
    }));
    res.json({ ...out, lastAt: starSync.lastAt, rate: STAR_REWARD_RATE, dayCap: STAR_REWARD_DAY_CAP, repos });
  } catch (e) {
    return res.status(500).json({ error: '同步失败：' + e.message });
  }
});

app.get('/api/admin/works', requireAdmin, (req, res) => {
  const status = req.query.status;
  let list = works.slice();
  if (status === 'offline') {
    // 「已下架」不是单一 status：管理员下架走 rejected，作者自主下架走 hidden，两条都收进来
    list = list.filter(isOffline);
  } else if (status && status !== '全部') list = list.filter(w => (w.status || 'approved') === status);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // 降权位次用「整个 status 列表」算，别被下面的搜索影响（否则搜一下名次就变了）
  const shifts = blockShiftMap(list.filter(w => !w.pinned).map(w => w.id));
  // 关键词筛选（后台作品列表的搜索框）：标题 / 一句话介绍 / 作者账号与昵称 / 分类 / 形态 / 正文 / 链接 / 作品 ID。
  // 空格分隔多个词按「都要命中」算（AND），方便「记账 张三」这种组合；最多取 5 个词，避免长串拖慢。
  const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const totalAll = list.length;   // 只按 status 筛完的总数，前端用来显示「匹配 3 件 · 全部 88 件」
  if (q) {
    const terms = q.toLowerCase().split(' ').filter(Boolean).slice(0, 5);
    list = list.filter(w => {
      const hay = [
        w.title, w.titleTag, w.id, w.author, displayNameOf(w.author), w.category,
        Array.isArray(w.types) ? w.types.join(' ') : w.type,
        w.prompt, w.introText, w.link, w.repo
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }
  // 分页：带 pageSize 才分页（每页上限 500，默认由前端传 200）；不带 pageSize 保持全量数组返回（旧脚本兼容）
  const rawSize = parseInt(req.query.pageSize, 10);
  const pageSize = rawSize > 0 ? Math.min(500, rawSize) : 0;   // 没传 / 乱填 → 0 = 不分页，别把「不传」钳成 1
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const mapOne = w => ({
    ...publicWork(w), status: w.status || 'approved', reports: w.reports || 0, anon: !!w.anon,
    pubTimeCustom: !!w.pubTimeCustom,   // 发布时间是后台手动设置的（列表里挂「手动时间」小标）
    aiReview: w.aiReview || null,   // AI 初审意见（pass/reason/note），待审列表展示给管理员参考
    featuredUntil: w.featuredUntil || null,
    offlineReason: w.offlineReason || '',
    offlineAt: w.offlineAt || '',
    juryRemoved: !!w.juryRemoved,   // 众判下架：列表标签写「众判下架」而不是「管理员下架」
    updatedAt: w.updatedAt || w.createdAt,
    authorReal: w.authorReal || '',
    ownerReal: w.ownerReal ? ((users.find(u => u.id === w.ownerReal) || {}).username || '') : '',
    claimAuthorized: w.claimAuthorized || '',   // 授权认领：授权给的账号名（列表挂「已授权·@xxx」小标）
    claimCode: w.claimCode || '',               // 认领暗号：本作品单独的 ≤10 位暗号（列表挂「暗号·xxx」小标，明文仅后台可见）
    claimBonus: claimBonusOf(w),                // 暗号认领额外奖励：{ points, reason } 或 null（列表挂「认领+X盏」小标）
    ...workVisitStats(w.id),
    // 屏蔽统计：home 最新列表的降权依据，后台逐件可见（含站长自己的那一票）
    ...blockAdminStats(w)
  });
  if (pageSize) {
    // 分页返回 { items, total, page, pageSize, pages }：total/pages 给前端画「第 x / y 页」
    // totalAll = 没加关键词时的件数（搜索时前端拿来显示「匹配 N 件 · 全部 M 件」）
    const total = list.length;
    const items = list.slice((page - 1) * pageSize, page * pageSize).map(mapOne);
    return res.json({ items, total, totalAll, q, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
  }
  res.json(list.map(mapOne));
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
  // 众判下架 → 作者整改 → 重新提交 → 这里复核通过：这一轮众判同时结案清票。
  // 不结的话「众人小法官」页会一直挂着「已下架待整改」，详情页也还按争议作品展示旧票数。
  const jcApprove = juryCaseOf(w.id);
  if (jcApprove && jcApprove.status === 'removed') {
    clearJuryCase(w, jcApprove, 'admin', '复核通过，恢复上架');
    saveJuryNow();
  }
  payUploadRewardInstant(w);   // 审核通过这一刻就是「正式上线」，把压着的首件即时款发掉，不用等 5 分钟巡检
  saveWorks();
  baiduPushWork(w, 'approve');
  res.json({ ok: true });
});

// 后台下架 / 拒绝待审：原因必填（后台弹窗强制），下架同时把原话站内通知给作者 —
  // 只落一条「已下架」状态，作者不点进「我的作品」根本不知道发生了什么。
app.post('/api/admin/works/:id/reject', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const wasPending = (w.status || 'approved') === 'pending';
  const note = String((req.body && req.body.reason) || '').trim().slice(0, 200);
  w.status = 'rejected';
  w.hidden = false;                 // 管理员下架优先：作者侧 hidden 合并成一条“已下架”
  w.offlineReason = note || w.offlineReason || '管理员手动下架';
  w.offlineAt = new Date().toISOString();
  w.updatedAt = w.offlineAt;
  saveWorks();
  // 有归属账号才收得到站内消息；匿名 / 无主作品没有收件人，原因只留在后台列表与作者可见的详情页上。
  // 申诉走「意见建议」（后台意见反馈页统一处理），和投诉下架那条路径同口径，不另开一套会话。
  let notified = false;
  if (w.userId) {
    // 措辞一律「说事不说人」：标题不说「未通过 / 已下架」，正文先摘掉对人的评判再讲怎么改回来。
    // 后台弹窗里的预设原因同口径（admin.html openTakedownModal），那边改了这里也要跟着看一遍。
    addNotice(w.userId, {
      kind: 'system',
      title: `「${w.title}」${wasPending ? '这次没收录' : '先收起来了'}`,
      text: `原因：${w.offlineReason}。这是站内统一的收录标准，不是针对你个人——按原因改好后重新提交，我们再看一遍；想聊两句，作品页底部「意见建议」随时找我们。`,
      workId: w.id
    });
    notified = true;
  }
  res.json({ ok: true, notified, reason: w.offlineReason });
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
  // 众判下架的案子：恢复上架时把票一起清掉。旧票挂着的话，作者整改完页面仍然写着
  // 「N 人认为疑似推广」，等于没洗清；案件本身留档，后台还能看到这轮是谁结的。
  const jc = juryCaseOf(w.id);
  if (jc && jc.status === 'removed') {
    clearJuryCase(w, jc, 'admin', '管理员恢复上架');
    saveJuryNow();          // 立刻落盘：否则重启后旧案件 / 旧票又回来了
  }
  payUploadRewardInstant(w);   // 恢复上架也补一次压着的即时款（幂等，发过就不会再发）
  saveWorks();
  baiduPushWork(w, 'relist');
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

// ---------- 后台：众人小法官复核 ----------
// 一屏看完所有被贴过标的作品：认定 / 反对票数、投票人、当前状态（众判中 / 已下架 / 已结案）。
// 三个动作：贴标（由站长发起众判）、结案并恢复、直接下架。
app.get('/api/admin/jury', requireAdmin, (req, res) => {
  const rows = Object.keys(juryData.cases).map(id => {
    const w = works.find(x => x.id === id);
    if (!w) return null;                       // 作品已被删除，案件留档但列表里不显示
    const c = juryData.cases[id] || {};
    const t = juryTally(id);
    const box = juryVotesOf(id);
    const votes = Object.keys(box).map(uid => {
      const u = users.find(x => x.id === uid);
      return { name: (u && u.username) || (box[uid] && box[uid].name) || uid, v: box[uid] && box[uid].v, at: box[uid] && box[uid].at };
    }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return {
      id,
      title: w.title,
      author: w.author || '',
      status: w.status || 'approved',
      hidden: !!w.hidden,
      juryRemoved: !!w.juryRemoved,
      offlineReason: w.offlineReason || '',
      flaggedAt: c.flaggedAt || '',
      caseStatus: c.status || 'open',
      // 只有真处于下架态才给下架时间：结案后残留的旧时间会让后台显示「下架早于贴标」
      removedAt: c.status === 'removed' ? (c.removedAt || '') : '',
      clearedAt: c.clearedAt || '',
      sus: t.sus,
      ok: t.ok,
      gap: JURY_REMOVE_GAP,
      lead: Math.max(0, t.sus - t.ok),
      votes,
      history: (c.history || []).slice(-8).reverse()
    };
  }).filter(Boolean);
  // 排序：已下架的排最前（等整改 / 等复核），其次众判中，最后已结案；同组内新的在上
  const rank = r => (r.caseStatus === 'removed' ? 0 : r.caseStatus === 'open' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || String(b.flaggedAt).localeCompare(String(a.flaggedAt)));
  res.json({ cases: rows, gap: JURY_REMOVE_GAP, minAgeH: Math.round(JURY_MIN_AGE_MS / 3600000) });
});

// 站长手动贴标：把一件作品挂上「疑似推广」交给众人投票（不改变作品状态）。
// 已经结案的作品再贴一次＝开新一轮，旧票早在结案时清掉了，不会跟上一轮混。
app.post('/api/admin/jury/:id/flag', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const c = juryData.cases[w.id] || (juryData.cases[w.id] = {});
  if (c.status !== 'open' || !c.flaggedAt) {
    c.flaggedAt = new Date().toISOString();
    c.status = 'open';
    delete c.clearedAt;
    delete c.clearedBy;
    delete c.removedAt;
    c.history = (c.history || []).concat([{ at: c.flaggedAt, action: 'flagged', by: 'admin' }]);
  }
  saveJuryNow();
  res.json({ ok: true, sus: juryTally(w.id).sus, ok2: juryTally(w.id).ok, gap: JURY_REMOVE_GAP });
});

// 结案（复核判错了 / 已整改完）：清票；如果作品正因众判下架，同时恢复上架并通知作者
app.post('/api/admin/jury/:id/clear', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const c = juryCaseOf(w.id);
  if (!c) return res.json({ ok: true, changed: false, restored: false });
  const wasRemoved = c.status === 'removed';
  const wasJuryRemoved = !!w.juryRemoved;   // clearJuryCase 会删掉这个标记，先记下来
  const note = String((req.body && req.body.note) || '').trim().slice(0, 120);
  clearJuryCase(w, c, 'admin', note || '管理员复核结案');
  let restored = false;
  if (wasRemoved && wasJuryRemoved && (w.status || 'approved') === 'rejected') {
    w.status = 'approved';
    w.hidden = false;
    w.updatedAt = new Date().toISOString();
    delete w.offlineReason;
    delete w.offlineAt;
    payUploadRewardInstant(w);
    baiduPushWork(w, 'relist');
    restored = true;
    if (w.userId) {
      addNotice(w.userId, {
        kind: 'system',
        title: `「${w.title}」的众判已撤销，作品恢复展示`,
        text: note ? `管理员复核意见：${note}` : '管理员复核后认为不构成推广，作品已恢复展示，票数一并清零。',
        workId: w.id
      });
    }
  }
  saveJuryNow();
  saveWorksNow();
  res.json({ ok: true, changed: true, restored });
});

// 直接以众判名义下架（站长看准了，不想等投票）：状态、通知、记录与投满票完全一致
app.post('/api/admin/jury/:id/remove', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const c = juryData.cases[w.id] || (juryData.cases[w.id] = {});
  if (c.status === 'removed') return res.json({ ok: true, changed: false, already: true });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
  if (!c.flaggedAt) c.flaggedAt = new Date().toISOString();
  removeByJury(w, c, juryTally(w.id), { byAdmin: true, reason });
  saveJuryNow();
  saveWorksNow();
  res.json({ ok: true, changed: true, reason: w.offlineReason });
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
      title: container.kind === 'dm' ? '站长回复了你的留言' : '管理员回复了你',
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

// 授权认领：站长直接向作者约稿收录的作品，预先授权给作者的账号。
// TA 登录后打开作品详情即可一键认领（无需交证据、无需审核），
// 归属转移与「认领通过」同一套收尾（finalizeClaimTransfer）。username 留空 = 取消授权。
// 账号还没注册也允许先授权，但认领接口按注册时间拦截（注册晚于授权时间 = 抢注假冒，不放行）：
// 真作者请改用「认领暗号」或人工审核通道。
app.post('/api/admin/works/:id/claim-auth', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const name = String((req.body && req.body.username) || '').trim().replace(/^@/, '');
  if (!name) {
    delete w.claimAuthorized; delete w.claimAuthAt;
    saveWorks();
    return res.json({ ok: true, claimAuthorized: '' });
  }
  // 大小写对齐到站内真实账号名
  const u = users.find(x => x.username === name)
    || users.find(x => (x.username || '').toLowerCase() === name.toLowerCase());
  const uname = u ? u.username : name;
  if (!NAME_RE.test(uname)) return res.status(400).json({ error: '账号名需 2-20 位，可为中文、字母、数字、下划线，请确认拼写' });
  w.claimAuthorized = uname;
  w.claimAuthAt = new Date().toISOString();
  saveWorks();
  // 作者已经注册的，顺手通知一声：作品给你留好了
  if (u) addNotice(u.id, {
    kind: 'system',
    title: `「${w.title}」已授权给你认领`,
    text: `站长已把这件作品授权给你：登录后打开作品详情，点「一键认领」即可归到你名下，无需提交创作证据、无需等待审核。`
  });
  res.json({ ok: true, claimAuthorized: w.claimAuthorized });
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
  // 上传奖励：指定账号 = 管理员确认这件作品是 TA 的，比自助投稿可信，当场全额到账、不挂观察期
  // （首件 200 / 后续件 50 一次发完）。已发过的不重复；还没上线的先记计划，上线后由巡检补发。
  const uploadReward = w.uploadReward ? null : planUploadReward(w, u, 'assign');
  payUploadRewardInstant(w);
  const settledTips = settleAnonymousTips(w, u.id);   // 匿名期间收到的灯火归到新作者名下
  saveWorks();
  // 给被指定的用户发一条站内消息（指回同一个账号就不重复打扰）
  if (u.id !== prevUserId) {
    addNotice(u.id, {
      kind: 'system',
      title: `「${w.title}」已归到你的名下`,
      text: `管理员确认这件作品是你做的，已指定给你：前台署名、数据看板、推广与灯火归属都算你的。`
        + (uploadReward ? (uploadReward.instantPaid
            ? `上传奖励 ${uploadReward.amount} 盏灯火已全额到账（管理员已审核，不用等观察期），现在就能去「推荐自己的作品」换个推荐位。`
            : `上传奖励 ${uploadReward.amount} 盏灯火会在作品正式上线后全额到账（管理员已审核，不用再等观察期）。`) : '')
        + (settledTips ? `这件作品此前收到的 ${settledTips} 盏灯火也已一并转给你。` : '')
        + `如果不是你做的，可在作品页发起投诉。`
    });
  }
  res.json({
    ok: true, author: w.author, claimed: true, claimable: isClaimable(w), osBonus, settledTips,
    uploadReward: uploadReward ? { amount: uploadReward.amount, instant: uploadReward.instant || 0, instantPaid: !!uploadReward.instantPaid, rest: Math.max(0, uploadReward.amount - (uploadReward.instant || 0)), first: uploadReward.first, readyAt: uploadReward.readyAt, readyHours: typeof uploadReward.readyHours === 'number' ? uploadReward.readyHours : UPLOAD_REWARD_DELAY / 3600e3 } : null
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
// 后台自定义发布时间：填过去的时间，作品在「最近 / 最新」流里按这个时间排，
// 不会顶到最前面（「刚发布 12 小时」买首页提醒、fresh 加成、「近 7 天」也会随之按老时间算）。
// 只收后台编辑器（/api/admin/works），前台投稿接口不受影响。
function normCustomPubTime(v) {
  const s = String(v || '').trim();
  if (!s) return { iso: null };                       // 留空 = 用现在（新建）/ 保持不变（编辑）
  const t = new Date(s).getTime();
  if (isNaN(t)) return { err: '发布时间格式不对，请重新选择' };
  if (t < new Date('2020-01-01T00:00:00').getTime()) return { err: '发布时间太早了，不能早于 2020-01-01' };
  if (t > Date.now() + 5 * 60e3) return { err: '发布时间不能晚于现在' };
  return { iso: new Date(t).toISOString() };
}

app.post('/api/admin/works', requireAdmin, (req, res) => {
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
    const { title, prompt, category, link, type, author, status } = req.body;
    const types = normalizeTypes(req.body.types || type);
    const image = req.files && req.files.image && req.files.image[0];
    const thumb = req.files && req.files.thumb && req.files.thumb[0];
    const qrcode = req.files && req.files.qrcode && req.files.qrcode[0];
    if (!image) return res.status(400).json({ error: '请上传作品封面 / 截图' });
    if (!title) return res.status(400).json({ error: '标题为必填项' });
    // 自定义发布时间（选填）：不传 / 留空 = 现在发布
    const pubAt = normCustomPubTime(req.body.customCreatedAt);
    if (pubAt.err) return res.status(400).json({ error: pubAt.err });

    let linkVal = String(link || '').trim();
    if (linkVal && !/^https?:\/\//i.test(linkVal)) linkVal = 'https://' + linkVal;

    // 按形态的多个链接（多平台应用：iOS/Android/macOS… 各填各的）
    const linksMap = normLinksMap(req.body.links, types);
    if (!linkVal && linksMap) linkVal = linksMap.Web || Object.values(linksMap)[0];

    const typeErr = validateTypeRequired(types, linkVal, qrcode ? qrcode.filename : '');
    if (typeErr) return res.status(400).json({ error: typeErr });

    // 认领暗号（选填）：后台新建就直接设上，省得建完再回列表点一次「认领暗号」
    const claim = claimCodeInput(req.body.claimCode);
    if (claim.err) return res.status(400).json({ error: claim.err });
    // 暗号认领的额外奖励（选填）：没设暗号就没有发放入口，直接拦下来，
    // 别让站长以为「填了额度只是没生效」——建完发现没发比当场报错更难受。
    const claimBonus = claimBonusInput(req.body.claimBonusPoints, req.body.claimBonusReason);
    if (claimBonus.err) return res.status(400).json({ error: claimBonus.err });
    if (claimBonus.bonus && !claim.code) {
      return res.status(400).json({ error: '设了暗号认领额外奖励就要先填认领暗号，否则这笔灯火没有入口发放' });
    }

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
      id: newWorkId(),
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
      ...paidFieldsOf(req.body),
      reports: 0,
      likes: 0,
      views: 0,
      createdAt: pubAt.iso || new Date().toISOString(),
      updatedAt: pubAt.iso || new Date().toISOString()
    };
    if (pubAt.iso) { work.createdAtReal = new Date().toISOString(); work.pubTimeCustom = true; } // 真实创建时间留档
    if (claim.code) work.claimCode = claim.code;   // 暗号明文只存后台，前台只下发「有没有」
    if (claim.code && claimBonus.bonus) work.claimBonus = claimBonus.bonus;   // 额外奖励只跟着暗号走
    if (linksMap) work.links = linksMap;
    applyTitleParts(work, req.body);   // 名字 / 一句话介绍分开存（卡片直接分两行，不靠猜）
    applyContentFields(work, req.body);   // 「一眼看懂」五件套：选填，缺了不拦发布
    works.push(work);
    // 后台代建但明确指定了账号：视同投稿且当场全额到账（人工指定归属 = 已审核，首件 200 / 后续每件 50）
    const uploadReward = authorAccount ? planUploadReward(work, authorAccount, 'assign') : null;
    payUploadRewardInstant(work);
    saveWorks();
    baiduPushWork(work, 'admin-create');
    res.status(201).json({
      ...publicWork(work), status: work.status,
      pubTimeCustom: !!work.pubTimeCustom, createdAtReal: work.createdAtReal || '',   // 手填发布时间留档
      authorBound: authorAccount ? authorAccount.username : '',
      authorPending: !authorAccount && !anon,
      uploadReward: uploadReward ? { amount: uploadReward.amount, instant: uploadReward.instant || 0, instantPaid: !!uploadReward.instantPaid, rest: Math.max(0, uploadReward.amount - (uploadReward.instant || 0)), first: uploadReward.first, readyAt: uploadReward.readyAt, readyHours: typeof uploadReward.readyHours === 'number' ? uploadReward.readyHours : UPLOAD_REWARD_DELAY / 3600e3 } : null
    });
  });
});

// 管理员编辑任意作品（可改作者、状态）
app.put('/api/admin/works/:id', requireAdmin, (req, res) => {
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
    const w = works.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: '作品不存在' });

    const { title, prompt, category, link, type, author, status } = req.body;
    // 自定义发布时间（选填）：传了且合法才改 createdAt；不传 / 留空 = 保持不变。
    // 先校验后动字段，别改到一半才报错。
    let pubAtIso = null;
    {
      const pubAt = normCustomPubTime(req.body.customCreatedAt);
      if (pubAt.err) return res.status(400).json({ error: pubAt.err });
      pubAtIso = pubAt.iso;
    }
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

    // 认领暗号：编辑器表单会带上这个键（回填原值 / 改过 / 清空）。
    // 不传这个键的调用（列表里的快捷操作）一律不动暗号，避免把别人设的暗号抹掉。
    // 先校验再动字段：非法值不能改到一半才报错。
    let claimNext = null;
    if (req.body.claimCode !== undefined) {
      const claim = claimCodeInput(req.body.claimCode);
      if (claim.err) return res.status(400).json({ error: claim.err });
      claimNext = claim.code;   // '' = 清除
    }
    // 暗号认领额外奖励：和暗号同一套「不传这个键就不碰」的口径（列表快捷操作只改暗号时用得上）。
    // 最终留不留得住，看作品上到底还有没有暗号——见下面统一落库。
    let bonusNext = null, bonusTouch = false;
    if (req.body.claimBonusPoints !== undefined || req.body.claimBonusReason !== undefined) {
      const b = claimBonusInput(req.body.claimBonusPoints, req.body.claimBonusReason);
      if (b.err) return res.status(400).json({ error: b.err });
      bonusTouch = true;
      bonusNext = b.bonus;
    }

    if (title) w.title = String(title).slice(0, 100);
    applyTitleParts(w, req.body);   // 后台编辑：名字 / 一句话介绍分开存（清空介绍框则删掉旧介绍）
    applyContentFields(w, req.body);   // 后台也支持改「一眼看懂」；表单不带这些键时原样保留
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
    if (pubAtIso && pubAtIso !== w.createdAt) {
      if (!w.createdAtReal) w.createdAtReal = w.createdAt;   // 首次手改发布时间时留档真实创建时间
      w.createdAt = pubAtIso;
      w.pubTimeCustom = true;
    }
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
    // 收费 / 送灯火 / 灯火解锁：统一口径（paidModel 决定 paid 与 lampPrice，见 applyPaidFields）
    if (req.body.paid !== undefined || req.body.paidModel !== undefined) applyPaidFields(w, req.body);
    // links 字段接管后同步遗留单链接：全清空时一并清掉，否则回填/展示会"复活"
    if (req.body.links !== undefined) w.link = (linksMap && (linksMap.Web || Object.values(linksMap)[0])) || '';
    if (link !== undefined) {
      let lv = String(link).trim();
      if (lv && !/^https?:\/\//i.test(lv)) lv = 'https://' + lv;
      w.link = lv.slice(0, 500);
    }
    if (req.body.site !== undefined) w.site = normSite(req.body.site); // 官网：传了就更新（可清空）

    applyImageChanges(w, req);

    // 认领暗号：表单带了这个键才动（'' = 站长清空了输入框 → 摘掉暗号，回到人工审核）
    if (claimNext !== null) {
      if (claimNext) w.claimCode = claimNext;
      else { delete w.claimCode; delete w.claimBonus; }   // 暗号没了，额外奖励跟着失效
    }
    if (bonusTouch) {
      // 只有作品上真有暗号，这笔奖励才留得住；否则删掉，免得挂在作品上却永远发不出去
      if (bonusNext && claimCodeOn(w)) w.claimBonus = bonusNext;
      else delete w.claimBonus;
    }

    const osBonusNow = grantOpenSourceBonus(w);   // 后台改成开源（且作品已归属某账号）同样补送一次
    payUploadRewardInstant(w);                   // 状态/归属这次都改完了，再补首件即时款
    saveWorks();
    baiduPushWork(w, 'admin-edit');
    res.json({
      ...publicWork(w), status: w.status || 'approved', osBonus: osBonusNow, osDowngraded,
      pubTimeCustom: !!w.pubTimeCustom, createdAtReal: w.createdAtReal || '',   // 手填发布时间留档
      // 让后台知道这次保存把归属落到了哪：绑上了哪个账号 / 还是无主（名字还没有账号）
      authorBound: w.userId ? ((users.find(u => u.id === w.userId) || {}).username || '') : '',
      authorPending: !w.userId && w.anonymous !== true,
      uploadReward: uploadPlanned ? { amount: uploadPlanned.amount, instant: uploadPlanned.instant || 0, instantPaid: !!uploadPlanned.instantPaid, rest: Math.max(0, uploadPlanned.amount - (uploadPlanned.instant || 0)), first: uploadPlanned.first, readyAt: uploadPlanned.readyAt, readyHours: typeof uploadPlanned.readyHours === 'number' ? uploadPlanned.readyHours : UPLOAD_REWARD_DELAY / 3600e3 } : null
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

// 后台合并重复作品：body { target: 保留件id }
// 把「被合并件」（:id）的浏览 / 点赞 / 收藏 / 评论 / 打赏 / 访问统计（PV·UV·按天）/ 灯火解锁
// 全部并入「保留件」，然后删除被合并件；老链接 / 老二维码经 workRedirects 302 到保留件。
// 用于同一作者重复投稿同一作品的场景（如「解压小站」投了两条）。
app.post('/api/admin/works/:id/merge', requireAdmin, (req, res) => {
  const src = works.find(x => x.id === req.params.id);
  const dst = works.find(x => x.id === (req.body || {}).target);
  if (!src) return res.status(404).json({ error: '被合并的作品不存在' });
  if (!dst) return res.status(404).json({ error: '保留件不存在（target 无效）' });
  if (src.id === dst.id) return res.status(400).json({ error: '不能把作品合并到自己' });

  // 浏览数：直接累加（卡片 / 详情 / SEO 都读这个）
  dst.views = (dst.views || 0) + (src.views || 0);

  // 点赞：dedup 按人并集（两边都赞过的算 1 个人），计数简单累加——
  // 计数里可能含 like-dedup 上线前的老赞，重算会丢，宁多勿丢
  const seenSrc = likeDedup[src.id] || {};
  const seenDst = likeDedup[dst.id] || (likeDedup[dst.id] = {});
  Object.keys(seenSrc).forEach(vid => {
    if (seenDst[vid] === undefined) seenDst[vid] = seenSrc[vid];
    else if (seenSrc[vid] === 1) seenDst[vid] = 1;
  });
  dst.likes = (dst.likes || 0) + (src.likes || 0);
  // like-log（本周热榜 / 高光用）：挪到保留件名下，同一身份只留一条
  for (let i = likeLog.length - 1; i >= 0; i--) {
    const L = likeLog[i];
    if (!L || L.workId !== src.id) continue;
    likeLog.splice(i, 1);
    if (!likeLog.some(x => x && x.workId === dst.id && x.vid === L.vid)) {
      likeLog.push({ workId: dst.id, vid: L.vid, t: L.t || Date.now() });
    }
  }
  scheduleLikeDedupSave();
  scheduleLikeLogSave();

  // 收藏：用户收藏列表里的被合并件 id 换成保留件 id（同一人两边都收过只留一条），计数按人头重算
  users.forEach(u => {
    if (!Array.isArray(u.favs) || !u.favs.includes(src.id)) return;
    u.favs = u.favs.filter(f => f !== src.id);
    if (!u.favs.includes(dst.id)) u.favs.push(dst.id);
  });
  dst.favs = users.filter(u => Array.isArray(u.favs) && u.favs.includes(dst.id)).length;
  saveUsers();

  // 打赏记录：换到保留件名下（零和账本金额不动，只改挂在哪件作品上）
  let tipMoves = 0;
  tips.forEach(t => { if (t.workId === src.id) { t.workId = dst.id; tipMoves++; } });
  if (tipMoves) saveTips();

  // 灯火解锁：被合并件上已付费的人挪到保留件继续可看（保留件不再额外收费）
  const lu = lampUnlockStore[src.id];
  if (lu) {
    const dl = lampUnlockStore[dst.id] || (lampUnlockStore[dst.id] = {});
    Object.keys(lu).forEach(uid => { if (!dl[uid]) dl[uid] = lu[uid]; });
    delete lampUnlockStore[src.id];
    saveLampUnlocks();
  }

  // 评论：整楼挪到保留件名下
  let commentMoves = 0;
  comments.forEach(c => { if (c.workId === src.id) { c.workId = dst.id; commentMoves++; } });
  if (commentMoves) saveComments();
  invalidateCommentCounts();

  // 访问统计：pv 累加、uv 并集、按天合并，然后删掉被合并件的记录
  const sv = workVisits[src.id];
  if (sv) {
    const dv = workVisits[dst.id] || (workVisits[dst.id] = { pv: 0, uv: {}, days: {} });
    if (!dv.uv) dv.uv = {};
    if (!dv.days) dv.days = {};
    dv.pv = (dv.pv || 0) + (sv.pv || 0);
    Object.keys(sv.uv || {}).forEach(k => { dv.uv[k] = 1; });
    Object.keys(sv.days || {}).forEach(dk => {
      const sd = sv.days[dk] || { pv: 0, uv: {} };
      const dd = dv.days[dk] || (dv.days[dk] = { pv: 0, uv: {} });
      if (!dd.uv) dd.uv = {};
      dd.pv = (dd.pv || 0) + (sd.pv || 0);
      Object.keys(sd.uv || {}).forEach(k => { dd.uv[k] = 1; });
    });
    // 与 trackWorkVisit 同口径：每件作品只留最近 N 天明细
    const keys = Object.keys(dv.days).sort();
    while (keys.length > VISIT_RETENTION_DAYS) delete dv.days[keys.shift()];
    delete workVisits[src.id];
    scheduleWorkVisitSave();
  }

  // 删除被合并件本体（图片清理与单独删除同一套）
  const idx = works.indexOf(src);
  if (idx !== -1) works.splice(idx, 1);
  [src.image, src.thumb, src.qrcode].concat(src.images || []).forEach(img => {
    if (!img) return;
    const p = path.join(UPLOAD_DIR, path.basename(img));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  // 老链接跳转：被合并件 id → 保留件 id
  workRedirects[src.id] = dst.id;
  saveWorkRedirects();

  saveWorks();

  // 通知作者（两件是同一人就一条说明；不同人则各自说明去向）
  if (src.userId) {
    addNotice(src.userId, {
      kind: 'system',
      title: `「${src.title}」已并入「${dst.title}」`,
      text: `站点整理重复作品时，这件作品的数据（浏览 / 点赞 / 收藏 / 评论 / 打赏等）已并入「${dst.title}」，本条作品已移除。之前分享出去的老链接会自动跳到「${dst.title}」，不受影响。`
    });
  }
  if (dst.userId && dst.userId !== src.userId) {
    addNotice(dst.userId, {
      kind: 'system',
      title: `「${src.title}」的数据并入了你的「${dst.title}」`,
      text: `站点整理重复作品时，把「${src.title}」的浏览 / 点赞 / 收藏 / 评论 / 打赏等数据并到了这件作品上，计数会有一次上涨，属正常合并。`
    });
  }

  res.json({
    ok: true,
    merged: { comments: commentMoves, tips: tipMoves, lampUnlocks: lu ? Object.keys(lu).length : 0 },
    target: { id: dst.id, title: dst.title, views: dst.views || 0, likes: dst.likes || 0, favs: dst.favs || 0 }
  });
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

// ================= 微信客服（小程序原生客服消息 → 落到本站后台） =================
// 两条链路并行，互不干扰：
//   ① 页面上的 <button open-type="contact">：用户进的是微信原生客服会话，消息在微信侧，
//      手机上用「小程序客服」回，本站不参与；
//   ② 小程序后台「开发管理 - 消息推送」把 URL 指到这里：用户每发一条消息，微信都会 POST
//      过来一份，本站落盘进 data/kf.json，后台「微信客服」页可以直接回复（走客服消息接口）。
// 配置项在 data/wechat-kf.json（不入库，首次载入自动生成随机值）：
//   { "token": "16 位随机串", "aesKey": "43 位随机串" }
// 把下面三样抄进小程序后台即可：URL = 本站 /api/wx/kf，Token、EncodingAESKey = 上面的值；
// 数据格式选 JSON、加解密方式选安全模式（明文模式也能收，只是签名只校验 signature）。
const KF_PATH = '/api/wx/kf';
const KF_CONF = (() => {
  const saved = readJSON('wechat-kf.json', null);
  if (saved && saved.token && saved.aesKey) {
    return { token: String(saved.token), aesKey: String(saved.aesKey) };
  }
  const conf = {
    token: crypto.randomBytes(8).toString('hex'),
    // EncodingAESKey 微信要求 43 位：32 字节 base64 去掉末尾的 '='
    aesKey: crypto.randomBytes(32).toString('base64').replace(/=+$/, '')
  };
  writeJSON('wechat-kf.json', conf);
  return conf;
})();
// 会话按 openid 存：一条会话 = 一个用户，msgs 里 from 区分谁说的
let kfThreads = readJSON('kf.json', null);
if (!kfThreads || typeof kfThreads !== 'object' || Array.isArray(kfThreads)) kfThreads = {};
function saveKf() { writeJSON('kf.json', kfThreads); }
function kfSha1(parts) {
  return crypto.createHash('sha1').update(parts.map(p => String(p == null ? '' : p)).sort().join('')).digest('hex');
}
// 会话最多留 300 个（按最后一条消息时间淘汰），单个会话最多留 200 条
function kfTrim() {
  const keys = Object.keys(kfThreads);
  if (keys.length <= 300) return;
  keys.sort((a, b) => new Date(kfThreads[b].lastAt || 0) - new Date(kfThreads[a].lastAt || 0));
  keys.slice(300).forEach(k => { delete kfThreads[k]; });
}
// 安全模式解密：AES-256-CBC，key = Base64(EncodingAESKey + '=')，iv = key 前 16 字节，
// 明文 = random(16B) + msg_len(4B，网络字节序) + msg + appid，PKCS#7 填充。
function kfDecrypt(encryptB64) {
  const key = Buffer.from(KF_CONF.aesKey + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 长度不对，应为 43 位');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.slice(0, 16));
  decipher.setAutoPadding(false);          // 自己剥填充，微信用的 PKCS#7 和 node 默认实现一致但不能自动去
  let buf = Buffer.concat([decipher.update(Buffer.from(String(encryptB64), 'base64')), decipher.final()]);
  const pad = buf[buf.length - 1];
  if (pad > 0 && pad <= 32) buf = buf.slice(0, buf.length - pad);
  const msgLen = buf.readUInt32BE(16);
  const msg = buf.slice(20, 20 + msgLen).toString('utf8');
  const appId = buf.slice(20 + msgLen).toString('utf8');
  if (WECHAT_CONF.appId && appId && appId !== WECHAT_CONF.appId) throw new Error('appid 不匹配，可能不是本小程序的推送');
  return msg;
}
// 微信推的是扁平 XML（<xml><Key><![CDATA[v]]></Key>…</xml>），一层就够，不上解析库。
// 非 CDATA 分支只吃 [^<]*：否则外层 <xml> 会把整段吞成一个键，字段级就全没了。
function kfParseXml(xml) {
  const out = {};
  const re = /<([A-Za-z_]\w*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    if (m[1] === 'xml') continue;
    out[m[1]] = (m[2] != null ? m[2] : (m[3] || '')).trim();
  }
  return out;
}
// 验签 + 取消息体：失败抛错（调用方回 403），成功返回扁平对象
function kfReadPush(req) {
  const q = req.query || {};
  const body = (req.body && typeof req.body === 'object') ? req.body : kfParseXml(req.body);
  // 安全模式：body 只有一个 Encrypt，签名在 msg_signature 里（四参排序，不能拿 signature 验）
  if (body && body.Encrypt) {
    if (kfSha1([KF_CONF.token, q.timestamp, q.nonce, body.Encrypt]) !== String(q.msg_signature || '')) {
      throw new Error('msg_signature 校验失败');
    }
    let plain;
    try { plain = kfDecrypt(body.Encrypt); } catch (e) { throw new Error('解密失败：' + e.message); }
    try { return JSON.parse(plain); } catch { return kfParseXml(plain); }
  }
  // 明文 / 兼容模式：三参排序验 signature
  if (kfSha1([KF_CONF.token, q.timestamp, q.nonce]) !== String(q.signature || '')) {
    throw new Error('signature 校验失败');
  }
  return body || {};
}
// 原始流水另存一份按月 jsonl：后台只留最近 200 条，翻旧账靠这个
function kfLogRaw(m) {
  try {
    const dir = path.join(DATA_DIR, 'kf');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, new Date().toISOString().slice(0, 7) + '.jsonl'), JSON.stringify(m) + '\n');
  } catch { /* 流水写不进去不能影响收消息 */ }
}
function kfRecord(m) {
  const openid = String((m && m.FromUserName) || '').trim();
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(openid)) return;
  if (/^gh_/.test(openid)) return;   // gh_ 开头是系统/公众号侧的事件（审核结果等），不是用户，别建会话
  const type = String(m.MsgType || '');
  let text = '[' + (type || '未知') + ']';
  let url = '';
  if (type === 'text') text = String(m.Content || '').slice(0, 1000);
  else if (type === 'image') { text = '[图片]'; url = String(m.PicUrl || ''); }
  else if (type === 'miniprogrampage') text = '[小程序卡片] ' + String(m.Title || '');
  else if (type === 'event') {
    text = m.Event === 'user_enter_tempsession' ? '（进入了客服会话）' : '（' + String(m.Event || '事件') + '）';
  }
  const now = new Date().toISOString();
  const t = kfThreads[openid] || (kfThreads[openid] = { openid, msgs: [], unread: 0, lastAt: now });
  if (m.MsgId && t.lastMsgId === String(m.MsgId)) return;   // 微信超时重试：同一条只记一次
  t.lastMsgId = String(m.MsgId || '');
  t.msgs.push({ from: 'user', text, at: now, type, url });
  if (t.msgs.length > 200) t.msgs = t.msgs.slice(-200);
  t.unread = (t.unread || 0) + 1;
  t.lastAt = now;
  kfTrim();
  saveKf();
  kfLogRaw({ at: now, openid, type, text });
}
// 后台填进小程序后台的那个地址：反代后 req.protocol 靠 trust proxy 取 X-Forwarded-Proto，
// 也可以用 KF_PUBLIC_URL 写死（多域名/后端内网时更稳）
function kfPublicUrl(req) {
  if (process.env.KF_PUBLIC_URL) return String(process.env.KF_PUBLIC_URL).trim();
  return (req.protocol || 'https') + '://' + (req.get('host') || '') + KF_PATH;
}

// ① 小程序后台点「提交」时，微信先 GET 过来验地址：验签通过就原样回 echostr
app.get(KF_PATH, (req, res) => {
  const q = req.query || {};
  if (kfSha1([KF_CONF.token, q.timestamp, q.nonce]) !== String(q.signature || '')) {
    return res.status(403).type('text/plain').send('bad signature');
  }
  res.type('text/plain').send(String(q.echostr || ''));
});
// ② 用户发消息：微信 POST 过来。必须秒回，晚了用户侧会看到「该小程序提供的服务出现故障」，
//    所以先验签 → 立刻回 success → 再落盘（落盘失败只记日志，不能反悔已经回的包）。
app.post(KF_PATH, express.text({ type: (req) => !req.is('application/json'), limit: '1mb' }), (req, res) => {
  let msg;
  try { msg = kfReadPush(req); } catch (e) {
    logLine('error.log', 'kf push 被拒：' + errText(e));
    return res.status(403).type('text/plain').send('invalid');
  }
  res.type('text/plain').send('success');
  try { kfRecord(msg); } catch (e) { logLine('error.log', 'kf 落盘失败：' + errText(e)); }
});

// 后台：会话列表 + 消息推送配置（URL / Token / AESKey 直接抄到小程序后台）
app.get('/api/admin/kf', requireAdmin, (req, res) => {
  const list = Object.keys(kfThreads).map(k => kfThreads[k])
    .sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
  let changed = 0;
  list.forEach(t => { if (t.unread) { t.unread = 0; changed++; } });   // 后台看一眼就算读过
  if (changed) saveKf();
  res.json({
    threads: list.map(t => ({ openid: t.openid, lastAt: t.lastAt, msgs: t.msgs || [] })),
    conf: {
      url: kfPublicUrl(req),
      token: KF_CONF.token,
      aesKey: KF_CONF.aesKey,
      appId: WECHAT_CONF.appId,
      mock: !!WECHAT_CONF.mock
    }
  });
});
// 后台回复：走官方客服消息接口。只在用户最后一次发消息后 48 小时内有效，过期微信直接拒（45015）
app.post('/api/admin/kf/:openid/reply', requireAdmin, async (req, res) => {
  const openid = String(req.params.openid || '');
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: '回复内容不能为空' });
  const t = kfThreads[openid];
  if (!t) return res.status(404).json({ error: '没有这个会话（可能已被清理）' });
  try {
    if (!WECHAT_CONF.mock) {
      const token = await wechatAccessToken();
      const r = await fetch('https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: openid, msgtype: 'text', text: { content: text } }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.errcode) {
        const hint = d.errcode === 45015 ? '用户最后一次发消息已超过 48 小时，微信不允许再回复（等他再来找你）'
          : d.errcode === 45047 ? '客服消息下发条数已达上限，稍后再试'
          : (d.errmsg || '发送失败');
        return res.status(400).json({ error: hint, errcode: d.errcode });
      }
    }
  } catch (e) {
    return res.status(502).json({ error: '发送失败：' + e.message });
  }
  const now = new Date().toISOString();
  t.msgs.push({ from: 'admin', text, at: now, type: 'text' });
  if (t.msgs.length > 200) t.msgs = t.msgs.slice(-200);
  t.unread = 0;
  t.lastAt = now;
  saveKf();
  kfLogRaw({ at: now, openid, type: 'text', text, from: 'admin' });
  res.json({ ok: true, thread: { openid: t.openid, lastAt: t.lastAt, msgs: t.msgs } });
});
app.delete('/api/admin/kf/:openid', requireAdmin, (req, res) => {
  if (!kfThreads[req.params.openid]) return res.status(404).json({ error: '没有这个会话' });
  delete kfThreads[req.params.openid];
  saveKf();
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
// 后台列表顺手带上友链来量：一眼看出哪条友链真有人点、哪条挂了没人来。
// 只在后台接口加字段，公开的 /api/friends 保持原样 —— 来量数据不外露。
app.get('/api/admin/friends', requireAdmin, (req, res) => {
  const { by7, by30, uv7, uv30 } = friendRefStats();
  res.json(friends.map(f => {
    const k = friendRefKey(f.url);
    return Object.assign({}, f, {
      ref7: k ? (by7[k] || 0) : 0,
      ref30: k ? (by30[k] || 0) : 0,
      uv30: k ? (uv30[k] || 0) : 0,
      uv7: k ? (uv7[k] || 0) : 0
    });
  }));
});
app.post('/api/admin/friends', requireAdmin, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const desc = String((req.body || {}).desc || '').trim();
  const url = String((req.body || {}).url || '').trim();
  if (!name || name.length > 20) return res.status(400).json({ error: '名称需 1-20 字' });
  if (desc.length > FRIEND_DESC_MAX) return res.status(400).json({ error: `简介最多 ${FRIEND_DESC_MAX} 字` });
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: '链接需以 http(s):// 开头' });
  if (url.length > 500) return res.status(400).json({ error: '链接过长' });
  if (friends.length >= FRIEND_MAX) return res.status(400).json({ error: `友情链接最多 ${FRIEND_MAX} 条` });
  if (friends.some(f => f.url === url)) return res.status(400).json({ error: '该链接已存在' });
  friends.push({ name, desc, url });
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
// 编辑友链：旧链接当主键，原地替换（保持排序位置不变）
app.post('/api/admin/friends/update', requireAdmin, (req, res) => {
  const body = req.body || {};
  const oldUrl = String(body.oldUrl || '').trim();
  const name = String(body.name || '').trim();
  const desc = String(body.desc || '').trim();
  const url = String(body.url || '').trim();
  const i = friends.findIndex(f => f.url === oldUrl);
  if (i === -1) return res.status(404).json({ error: '链接不存在，请刷新后重试' });
  if (!name || name.length > 20) return res.status(400).json({ error: '名称需 1-20 字' });
  if (desc.length > FRIEND_DESC_MAX) return res.status(400).json({ error: `简介最多 ${FRIEND_DESC_MAX} 字` });
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: '链接需以 http(s):// 开头' });
  if (url.length > 500) return res.status(400).json({ error: '链接过长' });
  if (url !== oldUrl && friends.some((f, k) => k !== i && f.url === url)) return res.status(400).json({ error: '该链接已存在' });
  const cur = friends[i];
  if (cur.name === name && cur.url === url && String(cur.desc || '') === desc) return res.json({ ok: true });   // 没改动，直接放过
  friends[i] = Object.assign({}, cur, { name, desc, url });   // 保留未来可能加的额外字段
  saveFriends();
  res.json({ ok: true });
});

// ---------- 友链申请：访客前台提交，站长在「友情链接」tab 审批 ----------
// 查重用归一后的 url（协议尾斜杠大小写都抹平），入库保留用户原始写法
function normFriendUrl(u) {
  return String(u || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}
// 名称自动解析要抓对方网页，先拦内网/环回地址（防 SSRF：不能拿自己的服务器去探内网）
function isPrivateHost(h) {
  const s = String(h || '').toLowerCase();
  if (!s) return true;
  if (s === 'localhost' || s.endsWith('.localhost') || s.endsWith('.local') || s.endsWith('.internal')) return true;
  if (/^(?:10|127)\.\d|^0\.\d|^169\.254\.\d|^192\.168\.\d|^172\.(?:1[6-9]|2\d|3[01])\.\d/.test(s)) return true;
  if (s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
  return false;
}
// title 常是「站名 - 描述」：分隔符两侧带空格的才砍尾巴（「XX-Studio」这种站名内的连字符不动）
function titleToName(raw) {
  let t = String(raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{2,}?)\s+[-–—|·»]\s+\S/);
  if (m) t = m[1].trim();
  return t.slice(0, 20);
}
// 抓对方首页：只抓公网 http(s)、只收 HTML、最多前 100KB。任何一步失败返回空串，
// 调用方自己兜底 —— 抓不到不能把申请卡死。
async function fetchHomeHtml(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return ''; }
  if (isPrivateHost(host)) return '';
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DreamCaseFriendBot/1.0; +https://idea.v5pc.com)', 'Accept': 'text/html' },
      redirect: 'follow'
    });
    if (!/text\/html/i.test(String(r.headers.get('content-type') || ''))) return '';
    return (await r.text()).slice(0, 100000);
  } catch { return ''; }
}
// 抓对方首页 <title> 当网站名（申请者只填网址，名称自己解析）
async function resolveSiteName(url) {
  const html = await fetchHomeHtml(url);
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return m ? titleToName(m[1]) : '';
}
// 互链检测用的本站域名：正式域名 + 环境里配的（自定义域名 / 测试）。
// 只认指向本站的 <a href>，不看文字 —— 「造梦橱窗」四个字写一堆但没链接是不算的。
const BACKLINK_HOSTS = (() => {
  const s = new Set(['idea.v5pc.com']);
  ['https://idea.v5pc.com', process.env.SITE_ORIGIN, process.env.SITE_URL].forEach(o => {
    try { s.add(new URL(String(o)).hostname.toLowerCase().replace(/^www\./, '')); } catch {}
  });
  return [...s];
})();
const BACKLINK_RE = new RegExp(
  '^\\s*(?:https?:)?//(?:[^/?#]*\\.)?(?:' + BACKLINK_HOSTS.map(h => h.replace(/\./g, '\\.')).join('|') + ')(?::\\d+)?(?:[/?#]|$)',
  'i'
);
function checkBacklink(html) {
  if (!html) return false;
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    if (href && BACKLINK_RE.test(href)) return true;
  }
  return false;
}
app.post('/api/friends/apply', async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || '').trim().slice(0, 500);
  const intro = String(body.intro || '').trim().slice(0, 60);
  const contact = String(body.contact || '').trim().slice(0, 100);
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: '网址需以 http(s):// 开头' });
  if (friends.some(f => normFriendUrl(f.url) === normFriendUrl(url))) {
    return res.status(400).json({ error: '这个网站已经在友链里了', code: 'listed' });
  }
  const me = currentUser(req);
  // 还在队列里的同一个站：申请人自己再提一次 = 改申请，原地更新那条（不重复占位，也不动排队位置）。
  // 认人三选一：登录账号对得上 / 同 IP / 联系方式填的一样 —— 都能说明是同一个人在改自己的申请。
  const pend = friendReqs.find(r => normFriendUrl(r.url) === normFriendUrl(url));
  if (pend) {
    const mine = (me && pend.userId && pend.userId === me.id)
      || (pend.ip && pend.ip === clientIp(req))
      || (contact && pend.contact && contact.toLowerCase() === String(pend.contact).toLowerCase());
    if (!mine) {
      return res.status(409).json({ error: '这个网站已经在申请队列里了，等站长处理就好', code: 'pending' });
    }
    if (!rateLimit('friendedit:' + clientIp(req), 8, 3600000)) {
      return res.status(429).json({ error: '改得太频繁了，休息一会儿再试', code: 'pending' });
    }
    pend.intro = intro;
    // 登录用户改申请时没有联系方式输入框：别把原来留的联系方式洗掉
    if (contact) pend.contact = contact;
    pend.updatedAt = new Date().toISOString();
    pend.edits = (Number(pend.edits) || 0) + 1;
    // 顺手复检互链：申请完再回自己站上补挂链接是最常见的动作，不用等站长手动点「复检」
    const ehtml = await fetchHomeHtml(url);
    if (ehtml) {
      const etm = ehtml.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
      if (etm) { const en = titleToName(etm[1]); if (en) pend.name = en; }
      pend.linkBack = checkBacklink(ehtml);
      pend.checkedAt = new Date().toISOString();
    }
    saveFriendReqs();
    return res.json({
      ok: true, edited: true, name: pend.name, linkBack: pend.linkBack,
      message: pend.linkBack
        ? '申请已更新，还是原来那条在排队；这次检测到你站上挂了造梦橱窗'
        : '申请已更新，还是原来那条在排队，站长看到的就是你最新填的内容'
    });
  }
  if (!rateLimit('friendapply:' + clientIp(req), 3, 3600000)) {
    return res.status(429).json({ error: '提交太频繁了，休息一会儿再试' });
  }
  if (friendReqs.length >= FRIEND_REQ_MAX) {
    return res.status(400).json({ error: '申请队列已满，请过段时间再来' });
  }
  // 名称不问申请者：抓对方 <title> 自己解析；抓不到（站点挂了 / 非 HTML / 内网）退回域名兜底
  // 未登录提交必须留联系方式：审批结果发不了站内私信，否则这个申请永远没人回
  if (!me && !contact) {
    return res.status(400).json({ error: '未登录提交请留一个联系方式（邮箱 / 微信），审批结果发你那里' });
  }
  let name = String(body.name || '').trim();
  // 一次抓取同时拿站名和互链结果，别抓两遍
  const html = await fetchHomeHtml(url);
  if (!name && html) {
    const tm = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
    if (tm) name = titleToName(tm[1]);
  }
  if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch {} }
  name = name.slice(0, 20);
  // 互链检测：把「对方有没有挂我们链接」这件费事的核查交给机器，收录决定仍归站长
  const linkBack = checkBacklink(html);
  friendReqs.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name, url, intro, contact,
    username: me ? me.username : '',
    userId: me ? me.id : '',
    ip: clientIp(req),
    linkBack,
    checkedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  });
  saveFriendReqs();
  res.status(201).json({
    ok: true, name, linkBack,
    message: linkBack
      ? '已提交，检测到你站上挂了造梦橱窗，等站长点一下确认'
      : '已提交。没检测到你站上的造梦橱窗链接（页脚加一个，站长会优先通过）'
  });
});
app.get('/api/admin/friend-requests', requireAdmin, (req, res) => {
  res.json(friendReqs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
});
// 通过：塞进 friends（追加到队尾，顺序后台可再调）+ 从申请堆删除
app.post('/api/admin/friend-requests/approve', requireAdmin, (req, res) => {
  const id = String((req.body || {}).id || '');
  const i = friendReqs.findIndex(r => r.id === id);
  if (i === -1) return res.status(404).json({ error: '申请不存在，请刷新后重试' });
  const r = friendReqs[i];
  if (friends.some(f => normFriendUrl(f.url) === normFriendUrl(r.url))) {
    friendReqs.splice(i, 1);   // 审批期间别处已经加过同站：清掉申请别留着占位
    saveFriendReqs();
    return res.status(400).json({ error: '这个网站已经在友链里了，申请已清掉' });
  }
  friends.push({ name: r.name, desc: String(r.intro || '').trim().slice(0, FRIEND_DESC_MAX), url: r.url });   // 申请里填的一句话介绍直接当页脚简介
  saveFriends();
  friendReqs.splice(i, 1);
  saveFriendReqs();
  res.json({ ok: true, total: friends.length });
});
// 复检互链：对方申请时说还没挂，后来挂上了 —— 后台点一下重抓，不重新提交
app.post('/api/admin/friend-requests/recheck', requireAdmin, async (req, res) => {
  const id = String((req.body || {}).id || '');
  const r = friendReqs.find(x => x.id === id);
  if (!r) return res.status(404).json({ error: '申请不存在，请刷新后重试' });
  const html = await fetchHomeHtml(r.url);
  r.linkBack = checkBacklink(html);
  r.checkedAt = new Date().toISOString();
  r.recheckedAt = r.checkedAt;
  saveFriendReqs();
  res.json({ ok: true, linkBack: r.linkBack, fetched: !!html });
});
// 一键通过所有「互链已验证」的：省掉逐条点，但收录决定权仍在站长手里
app.post('/api/admin/friend-requests/approve-verified', requireAdmin, (req, res) => {
  const room = FRIEND_MAX - friends.length;
  if (room <= 0) return res.status(400).json({ error: `友情链接最多 ${FRIEND_MAX} 条，先清理列表里的旧友链` });
  const targets = friendReqs.filter(r => r.linkBack === true);
  if (!targets.length) return res.json({ ok: true, approved: 0, total: friends.length });
  let n = 0;
  for (const r of targets) {
    if (n >= room) break;
    if (friends.some(f => normFriendUrl(f.url) === normFriendUrl(r.url))) continue;
    friends.push({ name: r.name, desc: String(r.intro || '').trim().slice(0, FRIEND_DESC_MAX), url: r.url });   // 申请里填的一句话介绍直接当页脚简介
    n++;
  }
  const ids = new Set(targets.map(r => r.id));
  for (let i = friendReqs.length - 1; i >= 0; i--) if (ids.has(friendReqs[i].id)) friendReqs.splice(i, 1);
  saveFriends();
  saveFriendReqs();
  res.json({ ok: true, approved: n, rest: friendReqs.length, total: friends.length, capped: n < targets.length });
});
// 忽略：直接删除（对方可以重新提交）
app.post('/api/admin/friend-requests/reject', requireAdmin, (req, res) => {
  const id = String((req.body || {}).id || '');
  const i = friendReqs.findIndex(r => r.id === id);
  if (i === -1) return res.status(404).json({ error: '申请不存在，请刷新后重试' });
  friendReqs.splice(i, 1);
  saveFriendReqs();
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
    gate: adGateDaily(),
    gateDefaults: AD_GATE_DEFAULTS,
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
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
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

// 复制 / 粘贴广告：后台「复制」把一支广告压成 DMAD1:<base64(JSON)> 代码串，
// 「粘贴」在这里还原成一支新广告（换个位置一键复用素材，不用重传图、重填文案）。
// 只还原展示字段：兑换广告的计费属性（source / ownerId / budget / redemptionId）一概不带，
// 复制品是普通广告，不会串到买家的预算上。
app.post('/api/admin/ads/import', requireAdmin, (req, res) => {
  const body = req.body || {};
  const slot = String(body.slot || '');
  if (!AD_SLOT_KEYS.includes(slot)) return res.status(400).json({ error: '请选择要粘贴到的广告位' });
  const raw = String(body.code || '').trim().replace(/^DMAD1:/, '');
  if (!raw) return res.status(400).json({ error: '请先粘贴广告代码' });
  let data;
  try { data = JSON.parse(Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8')); }
  catch { return res.status(400).json({ error: '广告代码不完整或已损坏，请回到原广告重新复制' }); }
  if (!data || typeof data !== 'object') return res.status(400).json({ error: '广告代码不完整或已损坏，请回到原广告重新复制' });

  const p = adPayload({ ...data, slot }, 'image');
  if (!p.url) return res.status(400).json({ error: '这条广告没有跳转链接，代码不完整' });
  if (p.kind === 'text' && !p.title) return res.status(400).json({ error: '纯文字广告必须填标题' });

  // 图片是同站 /uploads 里的文件：给新广告复制一份实体文件。
  // 否则两支广告共用同一个文件，删掉任何一支都会把另一支的图一起删掉。
  let image = '';
  const src = String(data.image || '');
  if (p.kind !== 'text' && /^\/uploads\/[^/\\]+$/.test(src)) {
    const from = path.join(UPLOAD_DIR, path.basename(src));
    if (fs.existsSync(from)) {
      const name = 'copy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
        + (path.extname(from) || '.png');
      try { fs.copyFileSync(from, path.join(UPLOAD_DIR, name)); image = '/uploads/' + name; }
      catch { image = src; }
    } else image = '';   // 原图已经不在，就当没配图，别让新广告挂个 404
  }
  if (!p.title && !image) return res.status(400).json({ error: '标题和图片至少填一个' });

  const ad = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...p,
    image,
    sort: adsOfSlot(slot).length,
    clicks: 0,
    createdAt: new Date().toISOString()
  };
  ads.push(ad);
  saveAds();
  res.status(201).json({ ...adListJson(), pastedId: ad.id });
});

app.put('/api/admin/ads/:id', requireAdmin, (req, res) => {
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: '上传失败：' + err.message });
    // 服务端兜底压缩（大图缩到 1600 宽、摆正 EXIF、qrcode 不碰）。失败不影响上传。
    await compressUploads(req);
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

// 广告位展示频控（每人每天最多看到几次）：后台「广告位」页顶部那个输入框就是改这里。
// 只影响招商位（页脚、首页底部），作者花灯火买的曝光位不受限。
app.post('/api/admin/ad-gate', requireAdmin, (req, res) => {
  const body = req.body || {};
  const slot = String(body.slot || '');
  if (!(slot in AD_GATE_DEFAULTS)) return res.status(400).json({ error: '没有这个广告位' });
  const v = Number(body.value);
  if (!Number.isFinite(v) || v < 0 || v > AD_GATE_MAX) {
    return res.status(400).json({ error: `填 0-${AD_GATE_MAX} 之间的整数（0 = 不限制）` });
  }
  adGateCfg[slot] = Math.floor(v);
  saveAdGate();
  res.json(adListJson());
});

app.post('/api/admin/ads/:id/toggle', requireAdmin, (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  // 排队中的兑换单还没轮到它：手动「启用」等于插队，队列会乱。等前面那单投完会自动扶正。
  if (a.source === 'redeem' && a.queued) {
    return res.status(400).json({ error: '这单还在排队，等前一位投完会自动开始；要取消请点「撤下并退款」' });
  }
  a.active = a.active === false;
  saveAds();
  res.json(adListJson());
});

// 同一位内上移 / 下移。
// 只在「同类」广告之间换位（自营 ↔ 自营、兑换 ↔ 兑换）：后台已经把两类拆到两个页面，
// 如果还按全量列表相邻交换，站长点「上移」时位置可能被看不见的兑换单吃掉，看起来像没反应。
app.post('/api/admin/ads/:id/move', requireAdmin, (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '广告不存在' });
  const dir = (req.body && req.body.dir) === 'down' ? 1 : -1;
  const list = adsOfSlot(a.slot);
  const i = list.findIndex(x => x.id === a.id);
  if (i < 0) return res.json(adListJson());
  const sameKind = x => (x.source === 'redeem') === (a.source === 'redeem');
  let j = -1;
  for (let k = i + dir; k >= 0 && k < list.length; k += dir) {
    if (sameKind(list[k])) { j = k; break; }
  }
  if (j < 0) return res.json(adListJson());
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((x, k) => { x.sort = k; });
  saveAds();
  res.json(adListJson());
});

// 后台撤下推广单（「用户推广」页的撤下按钮、删除兑换广告都走这里）：
// 退款口径和作者自己点「撤下」完全一致（剩余曝光 / 点击按下单时锁的单价退回），
// 区别是多发一条站内信——用户不在操作现场，得知道是谁撤的、退了多少。
function adminCancelPromo(r) {
  const ad = ads.find(a => a.id === r.adId);
  if (ad) { ad.active = false; ad.queued = false; }
  const back = refundRedemption(r, 'cancelled');   // 必须在这支广告还在 ads 里时调用，否则剩余额度读不到
  const w = works.find(x => x.id === r.workId) || {};
  if (r.comp) {
    // 代投单没有灯火往来，站内信只说下线这件事
    const slotObj = REDEEM_SLOTS.find(s => s.key === r.slot) || {};
    addNotice(r.userId, {
      kind: 'ad',
      title: '站长代投的推荐已撤下',
      text: `「${w.title || '你的作品'}」在「${slotObj.name || r.slot}」的站长代投推荐已由管理员撤下，前台不再展示。这次推荐没有消耗你的灯火。`
    });
  } else {
    const points = shareStatsOf(r.userId).points;
    addNotice(r.userId, {
      kind: 'points',
      title: back > 0 ? `推荐已由站长撤下，退回 ${back} 盏灯火` : '推荐已由站长撤下',
      text: `「${w.title || '你的作品'}」的推荐被管理员撤下，前台已不再展示。这单共花费 ${r.price || 0} 盏，已用掉的部分不退，`
        + (back > 0 ? `剩余 ${back} 盏已按原价退回，当前余额 ${points} 盏。` : '没有可退的剩余额度。'),
      points, delta: back || 0
    });
  }
  if (ad) saveAds();
  promoteQueued(r.slot);   // 撤的正好是独占位在投单，队头立刻接上
  return back;
}

app.delete('/api/admin/ads/:id', requireAdmin, (req, res) => {
  const idx = ads.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '广告不存在' });
  const removed = ads[idx];
  // 先结算退款再删除：refundRedemption 要读这支广告的 budget / clickLeft，
  // 删完再退会把剩下的额度全算成已用（以前就是这个顺序，导致后台删兑换广告一分都不退）。
  let refunded = 0;
  if (removed.source === 'redeem' && removed.redemptionId) {
    const r = redemptions.find(x => x.id === removed.redemptionId);
    if (r && (r.status === 'active' || r.status === 'queued')) refunded = adminCancelPromo(r);
  }
  ads.splice(idx, 1);
  removeUpload(removed.image);
  renumberAds(removed.slot);
  // 清掉已删广告的 PV/UV 明细，不让统计文件无限膨胀
  Object.keys(adStats).forEach(d => { if (adStats[d]) delete adStats[d][removed.id]; });
  scheduleAdStatsSave();
  saveAds();
  res.json({ ...adListJson(), refunded });
});

// 站长代投：把任意一件已上线的作品挂到某个推荐位，挂 1-30 天，到期自动下线。
// 与作者自荐单（POST /api/redeem）的区别：
//   - 不扣灯火、不退款、不进消耗统计（订单 price=0 + comp:true，退款/巡检/下发各处都认这个标记）
//   - 不占作者「同时最多 N 条在投」的额度（那是给付费投放的公平性约束）
//   - 其余排队 / 独占 / 展示 / 统计口径与付费单完全一致：首页第一格被占用时照样进队列，
//     排队等待不占天数；前台渲染的就是同款「推荐」作品卡。
//   - prio 是这一条的展示优先级（让位买家 / 齐平随机 / 优先这条），默认让位买家，
//     只影响同一个位上「谁先被挑中」，不动扣费与期限，见 applyPromoPriority。
app.post('/api/admin/redemptions/comp', requireAdmin, (req, res) => {
  const body = req.body || {};
  const workId = String(body.workId || '');
  const slot = REDEEM_SLOT_KEYS.includes(String(body.slot || '')) ? String(body.slot) : '';
  if (!slot) return res.status(400).json({ error: '请选择推荐位' });
  const prio = COMP_PRIO_MODES.includes(String(body.prio || '')) ? String(body.prio) : 'user';
  const cfg = redeemCfg(slot);
  if (cfg.onSale === false) return res.status(400).json({ error: cfg.pendingNote || '这个位置还没开放' });
  const daysRaw = Math.round(Number(body.days));
  if (!Number.isFinite(daysRaw) || daysRaw < 1 || daysRaw > ADMIN_COMP_MAX_DAYS) {
    return res.status(400).json({ error: `天数填 1-${ADMIN_COMP_MAX_DAYS} 之间的整数` });
  }
  const days = daysRaw;
  const work = works.find(w => w.id === workId);
  if (!work || work.deleted) return res.status(400).json({ error: '作品不存在' });
  if (!isVisible(work)) return res.status(400).json({ error: '这件作品还没正式上线，上线后才能投放' });

  expireRedemptions();   // 先把到期 / 投完的收尾，空位才能算准
  promoteQueued(slot);

  // 同作品同位置不重复挂（作者自己的付费单和之前的代投单都算）
  if (redemptions.some(r => (r.status === 'active' || r.status === 'queued') && r.workId === workId && r.slot === slot)) {
    return res.status(400).json({ error: '这件作品已经在这个位置投放或排队了' });
  }

  const occupied = cfg.exclusive && !!slotActiveRedemption(slot);
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
    extUrl: false,            // 代投只走站内详情页，不带外链
    link: '',
    workId: work.id,
    cta: '看看这个作品',
    active: !occupied,
    queued: occupied,
    source: 'redeem',         // 前台当「推荐」卡渲染，与作者买的同款
    comp: true,               // 站长代投标记：不计费、不退款、不按额度判活
    prio,                     // 这条代投的展示优先级（user 让位 / tie 齐平 / owner 抢位）
    ownerId: work.userId,
    redemptionId,
    budget: 0,                // 没有额度概念：存活只看 endsAt（redeemAdAlive / expireRedemptions 已认 comp）
    clickLeft: 0,
    endsAt: occupied ? 0 : now + days * 86400e3,
    sort: adsOfSlot(slot).length,
    clicks: 0,
    createdAt: new Date(now).toISOString()
  };
  ads.push(ad);
  saveAds();
  redemptions.push({
    id: redemptionId, adId, userId: work.userId, workId: work.id, slot,
    views: 0, clicks: 0, showPrice: 0, clickPrice: 0, price: 0,
    comp: true,
    prio,                     // 与 ad.prio 同一口径：后台列表按它标「让位 / 齐平 / 优先这条」
    used: 0, clickUsed: 0, status: occupied ? 'queued' : 'active',
    createdAt: now,
    startsAt: occupied ? 0 : now,
    endsAt: occupied ? 0 : ad.endsAt,
    days,
    daysPicked: false
  });
  saveRedemptions();
  // 告诉作者：站长把你的作品放上推荐位了（免费）。用固定 key，重启重放也不会重复发
  addNotice(work.userId, {
    kind: 'ad',
    key: `ad-compstart-${redemptionId}`,
    title: `你的作品被站长推荐到「${cfg.name}」`,
    text: `「${work.title}」由站长代投到「${cfg.name}」，最多展示 ${days} 天，这次推荐不消耗你的灯火。`
      + (occupied
        ? '这个位置目前有人在投，你的作品在队列里，轮到后开始计时；在「推荐」里可以随时查看或撤下。'
        : '在「推荐」里能看到实时曝光 / 点击，不想投了也可以随时撤下。'),
    workId: work.id
  });
  const queuedPos = occupied ? slotQueue(slot).findIndex(r => r.id === redemptionId) + 1 : 0;
  res.json({ ok: true, id: redemptionId, queued: occupied, queuePos: queuedPos, prio, ...adListJson() });
});

// 「用户推广」页的撤下按钮：按订单 id 撤（排队中的单也建好了广告，但 adId 不好当入口用，
// 订单 id 才是这一单的稳定标识）。后台撤下和用户自己撤下走同一套退款 + 队列交接。
app.post('/api/admin/redemptions/:id/cancel', requireAdmin, (req, res) => {
  const r = redemptions.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '投放单不存在' });
  if (r.status !== 'active' && r.status !== 'queued') return res.status(400).json({ error: '这单已经结束了，不用再撤' });
  const refunded = adminCancelPromo(r);
  res.json({ ok: true, refunded, ...adListJson() });
});


// ---- 用户管理：账号 / 昵称 / 灯火 / 作品数 ----
// 按最近活跃排序 + 分页（每页 20 条）；q 走服务端搜索
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const src = normFrKey(req.query.src);   // 按来源渠道筛：链接来的和兑换码来的都在这里
  const sort = String(req.query.sort || 'active');   // active=最近活跃（默认）· regNew=注册最新 · regOld=注册最早
  const hasWorks = req.query.hasWorks === '1';   // 只看投过作品的人（后台用户管理默认勾上，免得一堆注册没投稿的号占屏）
  const pageSize = 20;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  // 同 IP 疑似同一用户：按注册 IP 聚类。老账号只有哈希（regIp），2026-11-09 起建号
  // 同时有原始 IP（regIpRaw），两种都成组取并集；管理后台只读展示，不写数据。
  const ipGroups = {};
  users.forEach(u => {
    if (u.regIp) (ipGroups['h:' + u.regIp] = ipGroups['h:' + u.regIp] || []).push(u.username);
    if (u.regIpRaw) (ipGroups['r:' + u.regIpRaw] = ipGroups['r:' + u.regIpRaw] || []).push(u.username);
  });
  const ipPeersOf = u => {
    const s = new Set();
    if (u.regIp) (ipGroups['h:' + u.regIp] || []).forEach(n => { if (n !== u.username) s.add(n); });
    if (u.regIpRaw) (ipGroups['r:' + u.regIpRaw] || []).forEach(n => { if (n !== u.username) s.add(n); });
    return [...s];
  };
  const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间的今天
  let list = users.map(u => {
    return {
      id: u.id,
      username: u.username,
      name: displayNameOf(u.username),
      points: shareStatsOf(u.id).points,
      createdAt: u.createdAt,
      lastActiveAt: u.lastActiveAt || null,
      // 最后活跃端：老用户没这个字段（功能上线前没记），前端显示「—」
      lastClient: u.lastClient && u.lastClient.kind
        ? { kind: u.lastClient.kind, text: CLIENT_TEXT[u.lastClient.kind] || u.lastClient.kind, at: u.lastClient.at || null }
        : null,
      todayVisits: u.actDay === todayKey ? (u.actToday || 0) : 0,
      consumed: (() => { const c = consumedLightsOf(u.id); return { total: c.consumed, promo: c.promoSpent, tip: c.tippedOut }; })(),
      works: works.filter(w => w.userId === u.id).length,
      isOwner: isSiteOwner(u),   // 站长：屏蔽作品时按 3 分计（首页最新降权用）
      blockedCount: Array.isArray(u.blocked) ? u.blocked.length : 0,
      tags: Array.isArray(u.tags) ? u.tags : [],
      // 勋章：后台据此在标签编辑里显示「待确认 / 已颁发」的一键开关（勋章标签不进标签库，防被改名/删除）
      ghBadge: (() => {
        const r = shareRecOf(u.id);
        return { tag: GH_BADGE_TAG, stars: GH_BADGE_STARS, granted: !!r.ghBadgeAt, pending: !!r.ghBadgeApplyAt };
      })(),
      acqFr: u.acqFr || '',
      acqFrName: u.acqFr ? frNameOf(u.acqFr) : '',
      regFrom: u.regFrom || '',
      acqAt: u.acqAt || '',
      // IP：注册那次请求的原始出口 + 最近一次活跃请求的出口（仅后台可见）
      regIpRaw: u.regIpRaw || '',
      lastIp: u.lastIp || '',
      lastIpAt: u.lastIpAt || null,
      sameIp: ipPeersOf(u)
    };
  });
  if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  if (src) list = list.filter(u => u.acqFr === src);
  const totalAll = list.length;   // 搜索/来源筛选后的人数（不含「只看有作品」），页眉用「共 X 位（全部 Y 位）」
  if (hasWorks) list = list.filter(u => u.works > 0);
  // 排序：默认最近活跃的排前面（没活跃记录的按注册时间垫底）；也可按注册时间正/倒序
  if (sort === 'regNew') {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sort === 'regOld') {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else {
    list.sort((a, b) => {
      const ta = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
      const tb = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }
  const total = list.length;
  const users2 = list.slice((page - 1) * pageSize, page * pageSize);
  // 归属地按需查（离线库，带缓存）：只在当前这一页的 20 个人里查，不写进用户档案，
  // 库更新后老数据也自动跟着变；查不到（IPv6 / 内网 / 库外）就留空，前端只显示 IP。
  const wantIps = new Set();
  users2.forEach(u => { if (u.regIpRaw) wantIps.add(u.regIpRaw); if (u.lastIp) wantIps.add(u.lastIp); });
  const placeMap = {};
  await Promise.all([...wantIps].map(async ip => { placeMap[ip] = await ipPlaceOf(ip); }));
  users2.forEach(u => {
    const reg = u.regIpRaw ? placeMap[u.regIpRaw] : null;
    const last = u.lastIp ? placeMap[u.lastIp] : null;
    u.regIpPlace = reg ? reg.place : '';
    u.regIpIsp = reg ? reg.isp : '';
    u.lastIpPlace = last ? last.place : '';
    u.lastIpIsp = last ? last.isp : '';
  });
  // 作品名字：当前这页 20 人的已发布作品（标题 + 是否隐藏），列表行里直接展示，点开就是作品页
  users2.forEach(u => {
    u.workNames = works.filter(w => w.userId === u.id)
      .map(w => ({ id: w.id, title: w.title, hidden: !!w.hidden || w.status === 'rejected' }));
  });
  res.json({ users: users2, total, totalAll, page, pageSize, hasWorks });
});

// ---- 单个用户的灯火余额（后台「送灯火 / 扣灯火」弹窗用）----
// 后台作品列表里点作者名也能给 TA 送灯火，但那一行手里只有作品数据，没有余额；
// 弹窗打开时现查一次这里。只回余额，不跑用户列表那套 IP / 作品 / 消耗统计。
app.get('/api/admin/users/balance', requireAdmin, (req, res) => {
  const u = users.find(x => x.id === String(req.query.id || ''));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({
    id: u.id,
    username: u.username,
    name: displayNameOf(u.username),
    points: (shareData.users[u.id] || {}).points || 0   // 只读，不给没送过灯火的号凭空建记录
  });
});

// ---- 重置密码（后台手动兜底，不依赖邮件）----
// 场景：纯用户名/密码注册的用户忘了密码，账号又没绑可用邮箱 → 走提问通道找站长。
// 这里直接给账号写一个新的一次性临时密码，站长转告本人，用户登录后到「账号设置」自己改掉。
// · OAuth 建的号（passSet=false）也能重置：重置等于顺手给它开了密码登录，原来的 GitHub / Google 登录不受影响。
// · 明文密码只回给当前这次后台请求，不写站内消息（铃铛里的消息会长期留着，被旁人看到就白设了）。
app.post('/api/admin/users/reset-password', requireAdmin, (req, res) => {
  const u = users.find(x => x.id === String((req.body && req.body.id) || ''));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // 去掉 0/o/1/l/i 这类易混字符，方便站长口头或截图转告
  const CH = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let pw = '';
  for (let i = 0; i < 8; i++) pw += CH[bytes[i] % CH.length];
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt;
  u.pass = hashPassword(pw, salt);
  const hadPassword = u.passSet !== false;
  u.passSet = true;                       // 重置后一定能用密码登录（OAuth 号等于顺手开了密码登录）
  u.passResetAt = new Date().toISOString();
  saveUsers();
  addNotice(u.id, {
    kind: 'system',
    title: '登录密码已被重置',
    text: '站长为你重设了登录密码。请向站长索取新的临时密码，登录后记得去「账号设置」里改成自己的密码。'
  });
  res.json({ ok: true, password: pw, username: u.username, name: displayNameOf(u.username), hadPassword });
});

// ---- 作者标签：后台给任意用户贴/摘标签；标签库支持新增、改名（改名同步所有人身上的标签） ----
app.post('/api/admin/users/tags', requireAdmin, (req, res) => {
  const u = users.find(x => x.id === String((req.body && req.body.id) || ''));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const raw = Array.isArray(req.body && req.body.tags) ? req.body.tags.slice() : [];
  // 勋章标签先提到最前再清洗：它不受「最多 6 个」限制（勋章 + 6 个手工标签），
  // 否则正好贴满 6 个的用户永远加不上勋章——被清洗截断在后面直接丢掉。
  const wantBadge = raw.includes(GH_BADGE_TAG);
  const next = wantBadge
    ? sanitizeTags([GH_BADGE_TAG, ...raw.filter(t => t !== GH_BADGE_TAG)], 7)
    : sanitizeTags(raw);
  const old = Array.isArray(u.tags) ? u.tags : [];
  const added = next.filter(t => !old.includes(t));
  const removed = old.filter(t => !next.includes(t));
  // 勋章标签：站长在这里「贴」= 确认颁发，「摘」= 不予/撤销。两种都算已处理并记档（ghBadgeAt），
  // 之后 applyGithubBadge 不再重复提报，免得来回拉锯。有勋章时永远排第一位——后台手工标签上限 6 个，排后面会被挤掉。
  const hasBadge = next.includes(GH_BADGE_TAG);
  const badgeAdded = added.includes(GH_BADGE_TAG);
  const badgeRemoved = removed.includes(GH_BADGE_TAG);
  if (hasBadge || badgeRemoved) {
    const rec = shareRecOf(u.id);
    rec.ghBadgeAt = new Date().toISOString();
    delete rec.ghBadgeApplyAt;
    saveShareNow();
  }
  u.tags = hasBadge ? [GH_BADGE_TAG, ...next.filter(t => t !== GH_BADGE_TAG)] : next;
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
  // 变动都通知本人（和认证开关一个口径），不带积分数字；勋章单独一条，措辞不能和普通标签混
  const plainAdded = added.filter(t => t !== GH_BADGE_TAG);
  const plainRemoved = removed.filter(t => t !== GH_BADGE_TAG);
  if (badgeAdded) {
    addNotice(u.id, {
      kind: 'system',
      title: `获得勋章：${GH_BADGE_TAG}`,
      text: `站长已经确认你的 GitHub 仓库 ${GH_BADGE_STARS} star 门槛，勋章会展示在你的作品卡片、详情页和作者主页。`
    });
  } else if (badgeRemoved) {
    addNotice(u.id, { kind: 'system', title: `勋章已移除：${GH_BADGE_TAG}`, text: '站长移除了你账号上的勋章。' });
  }
  if (plainAdded.length) addNotice(u.id, { kind: 'system', title: `获得新标签：${plainAdded.join('、')}`, text: '管理员给你的账号加上了荣誉标签，会展示在你的作品卡片和作者主页上。' });
  if (plainRemoved.length) addNotice(u.id, { kind: 'system', title: `标签已移除：${plainRemoved.join('、')}`, text: '管理员移除了你账号上的部分标签。' });
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
  const { title, text, scope, guest, key, cat } = req.body || {};
  const t = String(title || '').trim().slice(0, 60);
  const body = String(text || '').trim().slice(0, 300);
  if (!t && !body) return res.status(400).json({ error: '标题和正文至少填一个' });
  // 分区只影响铃铛里的分栏，不影响投递：
  //   system → announce（站方公告，可被「系统消息提示」开关静音）
  //   promo  → 营销推广（活动 / 上新 / 优惠，同样可静音，别当骚扰推）
  //   ad     → 广告位规则 / 库存 / 调价（前台落在「投放」栏；必达，投放人漏看会亏灯火）
  const kind = cat === 'promo' ? 'promo' : cat === 'ad' ? 'ad' : 'announce';
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
    kind,
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

// ---- 认领暗号（每个作品单独一个 ≤10 位字符串，后台作品列表逐件设置）----
// 设了之后：作者在前台认领弹窗里填对本件暗号 → 当场归属 + 发奖，不进审核队列，
// 认领成功后暗号自动删除（用完即废）。保存为空 = 清除（这件作品回到「交证据 + 人工审核」）。
// 暗号跟随作品存储，一个暗号泄露不影响其他作品；列表响应里带明文，方便站长核对后转发给作者。
app.post('/api/admin/works/:id/claim-code', requireAdmin, (req, res) => {
  const w = works.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: '作品不存在' });
  const raw = String((req.body && req.body.code) || '').trim();
  if (!raw) {
    delete w.claimCode;
    delete w.claimBonus;   // 暗号清掉，暗号认领的额外奖励一起作废（和编辑表单同一口径）
    saveWorks();
    return res.json({ ok: true, code: '', max: CLAIM_CODE_MAX, off: true });
  }
  if (/\s/.test(raw)) return res.status(400).json({ error: '暗号里不能带空格，作者手抄时容易多一位少一位' });
  if (claimCodeLen(raw) > CLAIM_CODE_MAX) {
    return res.status(400).json({ error: `暗号最多 ${CLAIM_CODE_MAX} 位` });
  }
  w.claimCode = raw;
  saveWorks();
  res.json({ ok: true, code: w.claimCode, max: CLAIM_CODE_MAX });
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
  c.status = 'approved';
  c.handledAt = now;
  // 归属转移 + 灯火/奖励收尾统一走 finalizeClaimTransfer（与「授权一键认领」同口径）
  const { settledTips, uploadReward, osBonus } = finalizeClaimTransfer(w, c.userId, c.username, 'claim');
  // 认领通过：站内通知申请人（前台铃铛可见）
  addNotice(c.userId, {
    kind: 'system',
    title: `「${w.title}」认领成功`,
    text: `管理员已确认这件作品是你做的，归到你的名下：署名、数据看板、编辑与推广权限都已生效。`
      + (uploadReward ? (uploadReward.instantPaid
          ? `上传奖励 ${uploadReward.amount} 盏灯火已全额到账（管理员已审核，不用等观察期），现在就能去「推荐自己的作品」换个推荐位。`
          : `上传奖励 ${uploadReward.amount} 盏灯火会在作品正式上线后全额到账（管理员已审核，不用再等观察期）。`) : '')
      + (osBonus ? `已按开源作品补发 ${osBonus} 盏灯火。` : '')
      + (settledTips ? `这件作品在匿名期间收到的 ${settledTips} 盏灯火，也已转到你的余额里。` : '')
  });
  res.json({
    ok: true, work: publicWork(w), claim: c, settledTips, osBonus,
    uploadReward: uploadReward ? { amount: uploadReward.amount, instant: uploadReward.instant || 0, instantPaid: !!uploadReward.instantPaid, rest: Math.max(0, uploadReward.amount - (uploadReward.instant || 0)), first: uploadReward.first, readyAt: uploadReward.readyAt, readyHours: typeof uploadReward.readyHours === 'number' ? uploadReward.readyHours : UPLOAD_REWARD_DELAY / 3600e3 } : null
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
let tplCache = { stamp: '', html: '', checkedAt: 0 };

// 静态资源版本号：HTML 里引用的本地 css/js 统一带 ?v=<文件mtime>，
// 文件一更新 URL 即变化 → 命中 1 年强缓存（immutable），省掉每次访问的 4~5 次 304 往返
const assetVerCache = {};
function assetVer(name) {
  try {
    const st = fs.statSync(path.join(__dirname, 'frontend', name));
    assetVerCache[name] = Math.floor(st.mtimeMs);
  } catch { assetVerCache[name] = assetVerCache[name] || Date.now(); }
  return String(assetVerCache[name]);
}
function withAssetVer(html) {
  return html.replace(/(src|href)="\/([A-Za-z0-9_\-./]+\.(?:css|js))"/g, (m, attr, name) => {
    try { fs.accessSync(path.join(__dirname, 'frontend', name)); } catch { return m; }  // 外链/不存在的文件不动
    return `${attr}="/${name}?v=${assetVer(name)}"`;
  });
}

// 模板 + 静态资源的时间戳签名：任一份 css/js 改动都会让它变化
// （只用来判断「要不要重新注入版本号」，本身不做缓存决策）
function tplStamp() {
  let max = 0;
  try { max = fs.statSync(INDEX_TPL).mtimeMs; } catch { return ''; }
  const dir = path.join(__dirname, 'frontend');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.css') && !f.endsWith('.js')) continue;
      try {
        const m = fs.statSync(path.join(dir, f)).mtimeMs;
        if (m > max) max = m;
      } catch { /* 单个文件读不到就跳过 */ }
    }
  } catch { /* 目录读不到就用模板时间戳 */ }
  return String(Math.floor(max));
}

const CRITICAL_CSS = path.join(__dirname, 'frontend', 'critical.css');
let criticalCache = { mtime: 0, css: '' };

// 可选优化：若 frontend/critical.css 存在（tools/build-critical.js 生成），就内联进 HTML 的
// <!--CRITICAL_CSS--> 占位处。目前该文件未启用——实测关键 CSS + 异步 style.css 虽然把
// FCP 提前了 2.6s，但 SSR 索引块被 JS 渲染替换时会多一次大位移（CLS 0.07→0.36），得不偿失。
// 保留这套机制是为了以后若重构掉那次位移，启用时只需跑一遍生成脚本。
function criticalCssTag() {
  try {
    const st = fs.statSync(CRITICAL_CSS);
    if (st.mtimeMs !== criticalCache.mtime) {
      criticalCache = { mtime: st.mtimeMs, css: fs.readFileSync(CRITICAL_CSS, 'utf-8') };
    }
  } catch { return ''; }   // 没有生成过就跳过，退化成原来的阻塞加载
  if (!criticalCache.css) return '';
  return `<style id="critical-css">\n${criticalCache.css}\n</style>`;
}

function template() {
  // 版本号注入（一次全文正则 + 每个资源一次 accessSync）以前每个请求都跑一遍 ——
  // 132K 字符串 × 每个访客，纯属白烧 CPU。现在缓存注入后的 HTML，
  // 并最多每 1 秒才检查一次文件时间戳：热路径零系统调用，改完文件刷新依然立刻生效。
  const now = Date.now();
  if (tplCache.html && now - (tplCache.checkedAt || 0) < 1000) return tplCache.html;
  // 环境切换的状态也算进签名：切到生产后必须重新注入，否则徽标还显示上一档
  const stamp = tplStamp() + '|' + devEnv.stamp();
  if (!tplCache.html || stamp !== tplCache.stamp) {
    try {
      tplCache = {
        stamp,
        html: devEnv.injectInto(withAssetVer(fs.readFileSync(INDEX_TPL, 'utf-8'))
          .replace('<!--CRITICAL_CSS-->', criticalCssTag())),
        checkedAt: now
      };
    } catch { /* 读取失败时继续用旧缓存 */ }
  } else {
    tplCache.checkedAt = now;
  }
  return tplCache.html;
}

function shell(seoHead, bodyBlock, homeBlock = '') {
  const html = template();
  // SEO_HOME 在 #homeView 内部：SPA 切到别的视图时随 homeView 一起隐藏，不会闪现在首屏顶部
  if (!html) return `<!DOCTYPE html><html lang="zh-CN"><head>${seoHead}</head><body>${bodyBlock || homeBlock || ''}</body></html>`;
  let out = html
    .replace('<!--SEO_HEAD-->', seoHead)
    .replace('<!--SEO_BODY-->', bodyBlock || '')
    .replace('<!--SEO_HOME-->', homeBlock || '');
  // 内页正文（bodyBlock 或 homeBlock）自带 <h1> 时，把壳里 hero 的 slogan 从 <h1> 降为 <p class="hero-title">，
  // 保证一页只有一个 H1（首页的 SEO 区块没有自己的 h1，slogan 继续独占首页的 H1，不在此列）。
  // 样式在 style.css 用 .hero .hero-title 与 .hero h1 同规则兜住，视觉零差异。
  if (/<h1[\s>]/.test((bodyBlock || '') + (homeBlock || ''))) {
    out = out.replace(
      '<h1>每一个用心的作品，<br class="hero-br" />都值得<span class="grad">被更多人看见</span></h1>',
      '<p class="hero-title">每一个用心的作品，<br class="hero-br" />都值得<span class="grad">被更多人看见</span></p>');
  }
  return out;
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

// 开源好物（/open）：站外 GitHub 项目的外链页。整页服务端渲染，内容在 content/open-source.json，
// star / 许可证由模块自己每天刷一次缓存。放在 sendHtml 之后注册，依赖 shell / requireAdmin 都已就位。
const openSource = require('./open-source');
openSource.register(app, { seo, shell, sendHtml, requireAdmin, rateLimit, clientIp });

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
  // 账号名 → id / 个性地址 一次建好索引：sitemap 里的作者页链接优先用 /u/<个性地址>（别在循环里 users.find）
  const uidByName = new Map(users.map(u => [u.username, u.id]));
  const slugByName = new Map(users.filter(u => slugOf(u)).map(u => [u.username, slugOf(u)]));
  visibleWorks().forEach(w => {
    if (w.anonymous === true) return;   // 匿名作品不进作者页 / sitemap
    const cur = map.get(w.author);
    if (!cur || new Date(w.createdAt) > new Date(cur.lastmod)) {
      map.set(w.author, { name: w.author, uid: uidByName.get(w.author) || '', slug: slugByName.get(w.author) || '', lastmod: w.createdAt });
    }
  });
  return [...map.values()];
}

// ---------- 个性地址 /u/<自定义>（2026-11-13 站长拍板） ----------
// 问题：作者页链接是 /u/umvus5ha0mzex，印在名片、海报、README 上记不住也念不出来。
// 口径：
//   · 只有「至少 1 件已上线、非匿名的作品」的账号能设（作者页本身得有东西，才值得给个地址）；
//   · 4–20 位，小写字母 / 数字 / 短横线，起止必须是字母或数字，不能纯数字（跟账号 id、作品号混淆）；
//   · 与全站账号名互斥（否则 /u/xxx 到底是谁，只能靠解析顺序猜，说不清）；
//   · 30 天冷却；改名后旧地址继续 301 到新地址 90 天，之后自然失效——已发出去的链接不能立刻断；
//   · 作品后来全下架也不收回地址（只是不能再新设），「有作品才能设」管入口不管出口。
const SLUG_MIN_LEN = 4;
const SLUG_MAX_LEN = 20;
const SLUG_RE = new RegExp('^[a-z0-9][a-z0-9-]{' + (SLUG_MIN_LEN - 2) + ',' + (SLUG_MAX_LEN - 2) + '}[a-z0-9]$');
const SLUG_COOLDOWN_MS = 30 * 864e5;
const SLUG_RETIRE_MS = 90 * 864e5;
// 顶层路由名 / 站方自称：地址直接出现在 URL 里，冒充成本比昵称更高，一并挡掉。
// 路由本身在 /u/ 命名空间内不会真冲突，这里是防「/u/admin 看着像后台」这类误导。
const SLUG_RESERVED = new Set([
  'admin', 'administrator', 'api', 'u', 'w', 'me', 'user', 'users', 'author', 'authors', 'root', 'www',
  'sys', 'system', 'login', 'logout', 'register', 'signup', 'signin', 'auth', 'account', 'setting',
  'settings', 'profile', 'static', 'assets', 'uploads', 'data', 'files', 'img', 'images', 'css', 'js',
  'favicon', 'robots', 'sitemap', 'feed', 'rss', 'help', 'support', 'service', 'kefu', 'about', 'contact',
  'rules', 'privacy', 'terms', 'howto', 'guide', 'open', 'ads', 'ad', 'bar', 'rank', 'discover', 'favs',
  'likes', 'promote', 'invite', 'column', 'feedback', 'notice', 'notices', 'chronicle', 'medals', 'mascots',
  'mini', 'enterprise', 'official', 'team', 'staff', 'mod', 'moderator', 'null', 'undefined', 'true',
  'false', 'nan', 'test', 'demo', 'example', 'zaomeng', 'dreamcase', 'dream-case'
]);

function slugOf(u) { return (u && u.slug) || ''; }
// 作者页可选地址：设了个性地址走个性地址，没设就还是 /u/<账号id>
function authorPathOf(u) { return u ? '/u/' + (u.slug || u.id) : ''; }
function slugNextAt(user) {
  const last = user && Number(user.slugChangedAt || 0);
  if (!last) return 0;                      // 从没设过 / 从没改过：第一次免费
  const next = last + SLUG_COOLDOWN_MS;
  return next > Date.now() ? next : 0;
}
// 「有作品」的口径与作者页渲染口径一致：已上线 + 非匿名（匿名作品不进作者页，给了地址也是空页）
function slugEligible(user) {
  if (!user) return false;
  return works.some(w => w.userId === user.id && !w.deleted && isVisible(w) && w.anonymous !== true);
}
// 退役地址保护期内不给别人抢：否则「你改名前那条已经发出去的链接」会被别人接管
function slugRetiredHit(slug, self) {
  return users.find(u => (!self || u.id !== self.id) && Array.isArray(u.slugHistory) &&
    u.slugHistory.some(h => h.slug === slug && Number(h.until || 0) > Date.now())) || null;
}
function slugParse(input, self) {
  // 一律折成小写：/u/Lin 和 /u/lin 各算一个人是灾难，输入里的大写直接降下来（前端也同步转小写）
  const slug = String(input || '').trim().toLowerCase();
  if (!slug) return { error: '请输入个性地址' };
  if (slug.length < SLUG_MIN_LEN) return { error: `至少 ${SLUG_MIN_LEN} 位` };
  if (slug.length > SLUG_MAX_LEN) return { error: `最多 ${SLUG_MAX_LEN} 位` };
  if (/^\d+$/.test(slug)) return { error: '不能全是数字，混一个字母吧' };
  if (!SLUG_RE.test(slug)) return { error: '只能用 a-z、0-9 和短横线，且不能以短横线开头或结尾' };
  if (SLUG_RESERVED.has(slug)) return { error: '这个地址站方留着自己用，换一个吧' };
  if (hitSensitive(slug)) return { error: '这个地址含敏感词，换一个吧' };
  const imp = nameImpersonation(slug);
  if (imp) {
    return { error: imp.replace(/^这个名字/, '这个地址').replace(/^名字里/, '地址里') };
  }
  if (users.some(u => slugOf(u) === slug && (!self || u.id !== self.id))) {
    return { error: '这个地址已经有人用了，换一个吧', code: 'slug_taken' };
  }
  // 与别人的账号 id 也不能撞：/u/ 解析顺序是 id → 个性地址 → 账号名，id 排在前面。
  // 账号 id 形如 'u' + base36(时间) + 随机 4 位（13 位），恰好落在合法地址区间内——
  // 撞上了这串地址永远指向 id 主人，设地址的人白设，还会被 301 带去别人的页
  if (users.some(u => String(u.id || '').toLowerCase() === slug && (!self || u.id !== self.id))) {
    return { error: '这个地址和别人的账号 ID 撞了，换一个吧', code: 'slug_taken' };
  }
  // 与账号名互斥（不分大小写）：账号本身也是 /u/ 的可用地址，两边撞了就成了两个入口指向的同一串字符
  if (users.some(u => String(u.username || '').toLowerCase() === slug && (!self || u.id !== self.id))) {
    return { error: '这个地址和别人的登录账号重了，换一个吧', code: 'slug_taken' };
  }
  if (slugRetiredHit(slug, self)) {
    return { error: '这个地址刚被别人用过（改名后保留 90 天），换一个吧', code: 'slug_taken' };
  }
  return { slug };
}
// 旧地址进历史：只留 90 天跳转，数组限长（反复改也不会把 users.json 撑爆）
function retireSlug(user, keep) {
  const old = slugOf(user);
  if (!old || old === keep) return;
  const hist = Array.isArray(user.slugHistory) ? user.slugHistory : (user.slugHistory = []);
  const until = Date.now() + SLUG_RETIRE_MS;
  const hit = hist.find(h => h.slug === old);
  if (hit) hit.until = until;
  else hist.push({ slug: old, until, at: new Date().toISOString() });
  if (hist.length > 10) hist.splice(0, hist.length - 10);
}

// /u/ 地址解析：ref 依次认 账号 id → 个性地址 → 账号名（老链接）——无主作品 / 未注册的老作者页靠最后一步兜住。
// 顺序讲究：id 是 15 位随机串、个性地址与账号名互斥，三者不会真撞车，这里只是把最常用的排前面。
function userByRef(ref) {
  const s = String(ref || '');
  const low = s.toLowerCase();   // 地址一律小写；手打 /u/LIN 也认，靠上面那条 301 收回正轨
  return users.find(u => u.id === s) ||
    users.find(u => slugOf(u) && slugOf(u) === low) ||
    users.find(u => u.username === s);
}

// ---------- 百度搜索资源平台 · 主动推送（普通收录） ----------
// 口径（2026-11-07 落地）：只在作品「第一次对公众可见」的时刻把它的详情页推给百度——
//   投稿即过审、管理员审核通过、恢复上架、预告卡点「我上线了」、作者自己重新上架、后台代建作品。
//   · 同一条 URL 24 小时内只推一次：普通收录按天给配额，重复推不加分，还可能挤掉别的额度；
//   · token 没配（env BAIDU_PUSH_TOKEN 或 data/baidu-push-token.txt）就整体静默跳过；
//   · 推送是「发出去就不管」的后台动作：不 await、不抛错、不挡任何响应，失败只写一行日志；
//   · 推送只代表「告诉百度这里有个新链接」，收不收录、多久收录由百度决定，别对外承诺时效。
const BAIDU_PUSH_ENDPOINT = String(process.env.BAIDU_PUSH_ENDPOINT || 'https://data.zz.baidu.com/urls').trim();
const BAIDU_PUSH_TOKEN = (() => {
  const env = String(process.env.BAIDU_PUSH_TOKEN || '').trim();
  if (env) return env;
  // 部署脚本会排除 data/，把 token 放进 data/ 里就不用每次发版重新配
  try { return fs.readFileSync(fileOf('baidu-push-token.txt'), 'utf-8').trim(); } catch { return ''; }
})();
const BAIDU_PUSH_SITE = String(
  process.env.BAIDU_PUSH_SITE || process.env.SITE_ORIGIN || process.env.SITE_URL || 'https://idea.v5pc.com'
).trim().replace(/\/+$/, '');
const BAIDU_PUSH_COOLDOWN = 24 * 3600 * 1000;
const BAIDU_PUSH_MAX_PER_CALL = 100;       // 单次最多 100 条：宁可多跑几次，也别一口气吃掉一天配额
let baiduPushLog = readJSON('baidu-push.json', {});

function baiduPushState() {
  if (!baiduPushLog || typeof baiduPushLog !== 'object') baiduPushLog = {};
  if (!baiduPushLog.urls || typeof baiduPushLog.urls !== 'object') baiduPushLog.urls = {};
  if (!baiduPushLog.stats || typeof baiduPushLog.stats !== 'object') baiduPushLog.stats = {};
  return baiduPushLog;
}
function saveBaiduPushState() {
  const st = baiduPushState();
  const now = Date.now();
  // 只留最近 30 天的记录，文件不会越长越大
  Object.keys(st.urls).forEach(u => {
    const t = new Date(st.urls[u]).getTime();
    if (!t || now - t > 30 * 86400000) delete st.urls[u];
  });
  try { writeJSON('baidu-push.json', st); } catch (e) { console.warn('[baidu-push] 落盘失败：' + e.message); }
}
function baiduPushWorkUrl(w) { return `${BAIDU_PUSH_SITE}/w/${encodeURIComponent(w.id)}`; }

// 推一批 URL。返回 { ok, pushed, remain?, error? }，永不 reject。
function baiduPushUrls(urls, { reason = '', force = false } = {}) {
  if (!BAIDU_PUSH_TOKEN) return Promise.resolve({ ok: false, skipped: 'no-token' });
  const st = baiduPushState();
  const now = Date.now();
  const list = [...new Set((urls || []).map(u => String(u || '').trim()).filter(Boolean))]
    .filter(u => /^https?:\/\//i.test(u))
    .filter(u => force || !st.urls[u] || now - new Date(st.urls[u]).getTime() > BAIDU_PUSH_COOLDOWN)
    .slice(0, BAIDU_PUSH_MAX_PER_CALL);
  if (!list.length) return Promise.resolve({ ok: true, pushed: 0, skipped: 'cooldown' });

  const payload = list.join('\n');
  const target = `${BAIDU_PUSH_ENDPOINT}?site=${encodeURIComponent(BAIDU_PUSH_SITE)}&token=${encodeURIComponent(BAIDU_PUSH_TOKEN)}`;
  return new Promise(resolve => {
    let settled = false;
    const finish = out => { if (!settled) { settled = true; resolve(out); } };
    let req;
    try {
      // 线上是 https，回归测试要能指向本机 http mock，所以按协议挑库
      const lib = /^http:/i.test(target) ? require('http') : require('https');
      req = lib.request(target, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 8000
      }, res => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', c => { raw += c; if (raw.length > 8000) req.destroy(); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* 百度偶尔回非 JSON */ }
          const good = res.statusCode === 200 && json && json.error === undefined;
          const at = new Date().toISOString();
          if (good) {
            list.forEach(u => { st.urls[u] = at; });
            st.stats.count = (st.stats.count || 0) + list.length;
            st.stats.last = { at, reason, success: list.length, remain: json.remain, quota: json.remain === 0 };
            saveBaiduPushState();
            finish({ ok: true, pushed: list.length, remain: json.remain, urls: list });
          } else {
            const err = (json && (json.message || ('error ' + json.error))) || ('HTTP ' + res.statusCode);
            st.stats.last = { at, reason, error: String(err).slice(0, 200) };
            st.stats.failed = (st.stats.failed || 0) + 1;
            saveBaiduPushState();
            console.warn('[baidu-push] 推送被拒：' + err);
            finish({ ok: false, error: String(err), status: res.statusCode });
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('超时')));
      req.on('error', e => {
        const at = new Date().toISOString();
        st.stats.last = { at, reason, error: e.message };
        st.stats.failed = (st.stats.failed || 0) + 1;
        saveBaiduPushState();
        console.warn('[baidu-push] 推送失败：' + e.message);
        finish({ ok: false, error: e.message });
      });
      req.write(payload);
      req.end();
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

// 作品变成「公众可见」时调用；不可见 / 没配 token 直接返回，调用方不用判断。
function baiduPushWork(w, reason) {
  if (!BAIDU_PUSH_TOKEN || !w || !isVisible(w)) return;
  const url = baiduPushWorkUrl(w);
  baiduPushUrls([url], { reason }).then(r => {
    if (r && r.ok && r.pushed) console.log(`[baidu-push] ${reason} ${url} 剩 ${r.remain === undefined ? '?' : r.remain}`);
  }).catch(() => { /* 主动推送失败不影响业务 */ });
}

// 全站要推的 URL：固定栏目页 + 全部可见作品详情页
function baiduPushAllUrls({ includePages = true } = {}) {
  const urls = [];
  if (includePages) {
    ['/', '/rank', '/bar', '/mini', '/guide', '/howto', '/discover', '/invite', '/chronicle', '/install']
      .forEach(p => urls.push(BAIDU_PUSH_SITE + p));
  }
  byNewest(visibleWorks()).forEach(w => urls.push(baiduPushWorkUrl(w)));
  return urls;
}

// 后台：看推送状态 / 手动推（默认推全站，force 忽略 24 小时冷却）
app.get('/api/admin/baidu-push', requireAdmin, (req, res) => {
  const st = baiduPushState();
  res.json({
    configured: !!BAIDU_PUSH_TOKEN,
    site: BAIDU_PUSH_SITE,
    endpoint: BAIDU_PUSH_ENDPOINT,
    cooldownHours: BAIDU_PUSH_COOLDOWN / 3600000,
    tokenSource: process.env.BAIDU_PUSH_TOKEN ? 'env' : (BAIDU_PUSH_TOKEN ? 'data/baidu-push-token.txt' : ''),
    pushedTotal: st.stats.count || 0,
    failed: st.stats.failed || 0,
    last: st.stats.last || null,
    tracked: Object.keys(st.urls).length,
    pendingHint: visibleWorks().length
  });
});
app.post('/api/admin/baidu-push', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const force = !!body.force;
  const urls = Array.isArray(body.urls) && body.urls.length ? body.urls : baiduPushAllUrls({ includePages: body.all !== false });
  const out = await baiduPushUrls(urls, { reason: 'admin-manual', force });
  res.json({ ...out, candidate: urls.length });
});

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

  let headHtml = seo.head({
    title: q
      ? `搜索「${q}」的结果 - ${seo.SITE_NAME}`
      // 首页 title 补上关键词位（原来 17 字太短）：收录榜/免费投稿/平台形态都进标题，slogan 留给 H1
      : `${seo.SITE_NAME} - 独立开发者作品收录榜 · 免费投稿网站/小程序/软件`,
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

  // 首屏 preload：本周精选条是首屏第一块图片内容，但它的图要等 /api/featured 回来、
  // 前端把卡片画出来才开始拉。这里把精选前 4 张的 400 宽缩略图直接塞进 <head>，
  // HTML 一到就开拉，跟 API 请求并行，首屏图片能提前半个 RTT 露出来。
  // 只在非搜索页做：/?q= 是搜索落地页，没有精选条。
  if (!q) {
    const preImgs = pool.filter(isFeaturedActive).slice(0, 4)
      .map(w => {
        const u = String(w.thumb || w.image || '');
        return u.indexOf('/uploads/') === 0
          ? `<link rel="preload" as="image" href="${seo.esc(seo.absolute(base, '/t/400/' + u.slice('/uploads/'.length)))}" />`
          : '';
      })
      .filter(Boolean).join('');
    if (preImgs) headHtml += preImgs;   // seoHead 整体落在模板 <head> 内的 <!--SEO_HEAD--> 占位符上，追加即可
  }

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
    // 兜底页保持自包含（不加载前端 App）：图标尺寸、暗色适配都在这几十行内联样式里自己解决
    return sendHtml(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>查询链接已失效 · 造梦橱窗</title>
<style>
  .ico svg{width:34px;height:34px;display:block}
  @keyframes dm404In{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @media (prefers-color-scheme: dark){
    body{background:#17161a !important;color:#e8e6e1 !important}
    .dm-card{background:#211f26 !important;box-shadow:0 8px 30px rgba(0,0,0,.4) !important}
    .dm-sub{color:#9a97a3 !important}
    .dm-tip{background:rgba(255,255,255,.06) !important;color:#b6b3bd !important}
    .dm-ico{background:rgba(255,255,255,.08) !important;color:#e8e6e1 !important}
    .dm-ghost{background:transparent !important;color:#e8e6e1 !important;border-color:#4a4752 !important}
  }
</style></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f5f2;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#222">
<div class="dm-card" style="max-width:420px;margin:20px;padding:36px 30px 28px;text-align:center;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06);animation:dm404In .35s ease-out">
  <div class="dm-ico" style="width:72px;height:72px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#f6f5f2;color:#111">${seo.svgIco('search')}</div>
  <h1 style="font-size:17px;font-weight:600;margin:0 0 8px">这个查询链接已失效</h1>
  <p class="dm-sub" style="font-size:13px;line-height:1.8;color:#666;margin:0 0 18px">通常是这两种情况：<br>链接复制得不完整（少一个字符就查不到）；<br>或者这条投稿记录已被删除。</p>
  <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:16px">
    <a href="/" style="flex:1;min-width:130px;box-sizing:border-box;padding:11px 16px;border-radius:10px;background:#111;color:#fff;text-decoration:none;font-size:13px">回到首页逛逛</a>
    <a href="/?feedback=1" class="dm-ghost" style="flex:1;min-width:130px;box-sizing:border-box;padding:11px 16px;border-radius:10px;background:#fff;color:#111;border:1px solid #ddd;text-decoration:none;font-size:13px">找站长问问</a>
  </div>
  <p class="dm-tip" style="font-size:12px;line-height:1.7;color:#888;background:#f6f5f2;border-radius:10px;padding:10px 14px;margin:0;text-align:left">小提示：想再查进度，从投稿成功那一步的消息里把链接完整复制过来再打开，手动输入很容易漏字符；想重新投稿的话，回首页点「投稿」就行。</p>
</div></body></html>`, 404);
  }
  // 时间字段有的是 ISO 字符串、有的是毫秒数（老数据），统一格式化，别把 1793797272112 直接印给作者看
  const fmtWhen = v => {
    if (v === null || v === undefined || v === '') return '';
    const d = new Date(typeof v === 'number' ? v : String(v));
    return isNaN(d) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
  };
  const rows = [
    ['当前状态', label.text],
    ['提交时间', fmtWhen(w.createdAt)],
    ['最近更新', fmtWhen(w.updatedAt || w.createdAt)],
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
    收藏这个链接就能随时回来看进度，不用注册账号。
    <button type="button" id="copyStatusLink" style="margin-left:2px;padding:2px 9px;border-radius:999px;border:1px solid #dcdae3;background:#fff;color:#555;font-size:12px;font-family:inherit;cursor:pointer">复制链接</button><br />
    ${label.tip}
  </p>
  ${!w.userId ? `<div id="claimBox" data-token="${seo.esc(token)}" style="display:none;background:#fff;border:1px solid #e3dcf7;border-radius:14px;margin-top:14px;padding:16px 18px">
    <b style="display:block;font-size:14px;font-weight:500;margin-bottom:6px">这件作品还没有归属</b>
    <p style="font-size:13px;color:#666;line-height:1.7;margin:0 0 12px">这是你投稿时拿到的链接，带着只有投稿人能看到的凭据。登录后提交，管理员确认一下就会归到你名下：署名、数据看板、编辑与推广权限都归你，上传奖励全额到账（首件 200 盏，之后每件 50 盏），不用等观察期。</p>
    <a href="/?claimToken=${seo.esc(token)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#5b46d9;color:#fff;text-decoration:none;font-size:13px">存到我名下 →</a>
    <p style="font-size:12px;color:#999;line-height:1.6;margin:10px 0 0">这个入口只对投过稿的那台设备显示。换了手机/浏览器就看不到，需要认领可以在页面底部「意见建议」里说明。</p>
  </div>` : ''}
  <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
    ${linkOk ? `<a href="/w/${seo.esc(w.id)}" style="padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-size:13px">作品已上线，去看看</a>` : ''}
    <a href="/" style="padding:10px 16px;border-radius:8px;border:1px solid #ddd;color:#222;text-decoration:none;font-size:13px">回到首页</a>
  </div>
</div>
<script>
(function () {
  // 认领入口只对本机投过稿的人显示：投稿成功时前端把这个 token 记进了 localStorage，
  // 转发出去的链接在别人手机上是看不到「存到我名下」的，避免随手点走别人的作品。
  try {
    var box = document.getElementById('claimBox');
    if (box) {
      var tok = box.getAttribute('data-token');
      var list = JSON.parse(localStorage.getItem('dm_my_claim_tokens') || '[]');
      if (Array.isArray(list) && list.some(function (x) { return x && x.token === tok; })) {
        box.style.display = '';
      }
    }
  } catch (e) {}
  // 复制链接：随手能存一份，别让匿名作者关掉页面就找不回来
  var btn = document.getElementById('copyStatusLink');
  if (!btn) return;
  function done() {
    btn.textContent = '已复制';
    setTimeout(function () { btn.textContent = '复制链接'; }, 1800);
  }
  function fallback() {
    var t = document.createElement('textarea');
    t.value = location.href;
    t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(t);
  }
  btn.addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(done, fallback);
    } else fallback();
  });
})();
</script>
</body></html>`);
});

app.get('/w/:id', (req, res) => {
  const base = seo.baseUrl(req);
  let raw = works.find(x => x.id === req.params.id);

  // 合并后留下的老链接 / 老二维码：302 到保留件（顺链最多追 5 层，防止环）
  if (!raw) {
    let rid = req.params.id, hops = 0;
    while (workRedirects[rid] && hops++ < 5) rid = workRedirects[rid];
    if (rid !== req.params.id) return res.redirect(302, '/w/' + encodeURIComponent(rid));
  }

  // 易混字符兜底：老作品 id 是 base36，可能带 0/o/1/l/i，口述或截图抄写容易看串。
  // 精确命中失败时把双方归一化（大小写折叠、0→o、1/i→l）再比一次；
  // 恰好命中一件才认，多条命中说明有歧义，不猜，维持 404。
  if (!raw) {
    const want = normWorkId(req.params.id);
    const hits = want ? works.filter(x => normWorkId(x.id) === want) : [];
    if (hits.length === 1) raw = hits[0];
  }

  // 管理员（后台登录后的 cookie，或脚本带 x-admin-key）可以打开已下架 / 待审作品的详情，
  // 方便后台核对内容后再决定是否恢复上架；其他人一律按不存在处理
  if (!raw || (!isPublished(raw) && !isAdmin(req))) {
    // 生产接口模式：本地数据里根本没这件作品（线上刚发的），页面别报假 404，直接转给线上
    if (!raw && devEnv.fallbackPage(req, res)) return;
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
  // meta description：有简介用简介，没有就用 seo.describeWork 按真实数据拼（见 seo.js）
  const description = seo.describeWork(w, 150);
  const trail = [
    { name: '首页', href: '/' },
    { name: w.category, href: '/c/' + encodeURIComponent(w.category) },
    { name: w.title }
  ];
  // 相关作品：增强内链，帮助爬虫发现更多页面。
  // 与前端详情弹窗共用 relatedWorksOf（同分类优先、不足补同作者），保证两边推荐一致。
  const related = relatedWorksOf(w, null, 6);

  const headHtml = seo.head({
    title: `${w.title} - ${w.category}${typesOf(w).join('/')}作品 - ${seo.SITE_NAME}`,
    description,
    keywords: [w.title, w.author, w.category].concat(typesOf(w), w.keywords || [], ['作品', '工具']).filter(Boolean).join(','),
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

  // 灯火解锁：服务端页同样不给入口——锁着的作品抹掉链接与小程序码，只留「N 盏解锁」的说明。
  // （爬虫和未登录访客都走这条 HTML，不能只在客户端藏）
  const lampPrice = w.paidModel === 'lamp' ? normLampPrice(w.lampPrice) : 0;
  const ssrWork = { ...withAuthorName(w), lampPrice };
  if (lampPrice) {
    ssrWork.link = '';
    ssrWork.qrcode = '';
    ssrWork.qrSrc = '';
    ssrWork.qrReal = false;
  } else {
    ssrWork.qrSrc = workQrOf(w).src;
    ssrWork.qrReal = workQrOf(w).real;
  }

  sendHtml(res, shell(headHtml, seo.workArticle(base, ssrWork, trail, withAuthorNames(related), { full: fullPage })));
});

// 小程序体验页（/mini/:id）：给推广位 / 广告位当落地页用
// 为什么另开一页而不是把推广指向 /w/:id：小程序在浏览器里点不开，唯一的真实入口是小程序码；
// 详情页是「首页 + 弹窗」的 SPA 结构，站外点进来先看到导航和列表，码还藏在弹窗里要滚才见。
// 这一页把码放首屏、只讲「是什么 / 长什么样 / 怎么扫」，页面自包含（不加载 app.js / style.css），
// 落地快、不会因为某个接口慢就白屏。渲染细节见 mini-showcase.js。
// 收录口径：noindex + canonical 指回 /w/:id —— 同一件作品的另一个视图，不跟详情页抢索引。
app.get('/mini/:id', (req, res) => {
  const base = seo.baseUrl(req);
  const raw = works.find(x => x.id === req.params.id);
  const deny = () => {
    const headHtml = seo.head({
      title: `页面不存在 - ${seo.SITE_NAME}`,
      description: '该作品可能已下架或未通过审核。',
      canonical: base + '/',
      noindex: true
    });
    return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
  };
  if (!raw || !isPublished(raw)) return deny();
  // 可见性跟 /w/:id 同一套：作者本人和管理员能预览未上线的，其他人按不存在处理
  const viewer = currentUser(req);
  const isOwner = !!(viewer && raw.userId && viewer.id === raw.userId);
  if (!isVisible(raw) && !isAdmin(req) && !isOwner) return deny();
  // 手机端作品（小程序 / iOS / 安卓）都有「扫码进小程序看这件作品」的意义：
  // App 作品进小程序详情页后能复制下载链接到手机浏览器安装。纯网页 / 桌面形态没有手机入口，
  // 这一页对它没意义，直接回详情页（避免出现「扫码」文案配桌面作品）
  const wTypes = typesOf(raw);
  const isMobileWork = wTypes.includes('小程序') || wTypes.includes('iOS') || wTypes.includes('Android');
  if (!isMobileWork) return res.redirect(302, '/w/' + encodeURIComponent(raw.id));

  const w = publicWork(raw, viewer);
  const pageUrl = base + '/w/' + w.id;
  const inWeChat = /MicroMessenger/i.test(String(req.headers['user-agent'] || ''));
  const isMiniWork = wTypes.includes('小程序');
  const headHtml = seo.head({
    title: isMiniWork ? `${w.title} - 扫码体验小程序 - ${seo.SITE_NAME}` : `${w.title} - 手机端体验页 - ${seo.SITE_NAME}`,
    description: seo.describeWork(w, 150),
    keywords: [w.title, w.authorName || w.author, w.category, isMiniWork ? '小程序' : 'App', '扫码体验'].filter(Boolean).join(','),
    canonical: pageUrl,
    image: seo.absolute(base, w.image),
    imageAlt: `${w.title} ${isMiniWork ? '小程序' : '应用'}截图`,
    type: 'article',
    noindex: true
  });
  sendHtml(res, miniShowcase.render({
    seoHead: headHtml,
    w,
    inWeChat,
    detailHref: '/w/' + w.id
  }));
});

// 作者主页。地址优先用作者自设的个性地址 /u/<slug>，没设还是 /u/<账号id>（纯 ASCII，对外分享不出现汉字）；
// 老的 /u/<账号名> 链接（收藏、已发出去的分享）301 到现地址，SEO 权重不丢；
// 改名前用过的旧地址在 90 天保护期内也 301 到现地址——已经印出去的名片不能立刻变成 404；
// 没有账号的无主作品作者页（/u/名字）照旧按名字渲染，只是没有跳转。
app.get('/u/:name', (req, res) => {
  const base = seo.baseUrl(req);
  const ref = String(req.params.name || '').slice(0, 50);
  const refUser = userByRef(ref);
  if (!refUser) {
    // 退役地址：90 天内仍然认，跳到现在的地址（否则改名就等于把所有分享链接作废）
    const retired = users.find(u => Array.isArray(u.slugHistory) &&
      u.slugHistory.some(h => h.slug === ref && Number(h.until || 0) > Date.now()));
    if (retired) return res.redirect(301, authorPathOf(retired));
  }
  if (refUser) {
    // 一个作者只留一个正式地址：id / 老账号名 / 大小写变体统统 301 到 canonical
    const canon = authorPathOf(refUser);
    if (ref !== canon.slice(3)) return res.redirect(301, canon);
  }
  const name = refUser ? refUser.username : ref;
  const ids = new Set(worksOfAuthorName(name).map(w => w.id));
  const list = byNewest(visibleWorks().filter(w => ids.has(w.id) && w.anonymous !== true));
  const totalLikes = list.reduce((s, w) => s + (w.likes || 0), 0);
  // 档案数字与 /api/authors 同口径：访客（各作品 uv 合计）、灯火人数、常写分类、入驻时间
  const totalUv = list.reduce((s, w) => s + (workPvUv(w.id, 36500).uv || 0), 0);
  const totalTippers = list.reduce((s, w) => s + tipTippersOf(w.id), 0);
  const catCount = {};
  list.forEach(w => catsOf(w).forEach(c => { catCount[c] = (catCount[c] || 0) + 1; }));
  const catList = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c]) => ({ name: c }));
  const times = list.map(w => w.createdAt && Date.parse(w.createdAt)).filter(Boolean);
  const since = times.length ? Math.min(...times) : null;
  const pageUrl = refUser ? base + authorPathOf(refUser) : base + '/u/' + encodeURIComponent(name);
  const shown = displayNameOf(name);   // 页面显示昵称，URL / 作者匹配仍用账号名

  if (!list.length) {
    const headHtml = seo.head({
      title: `作者不存在 - ${seo.SITE_NAME}`,
      description: '该创作者还没有提交作品。',
      canonical: base + '/',
      noindex: true
    });
    return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
  }

  const headHtml = seo.head({
    title: `${shown} 的作品（${list.length} 件） - ${seo.SITE_NAME}`,
    description: truncateText(
      `${shown}在造梦橱窗提交了 ${list.length} 件作品，` +
      `累计获赞 ${totalLikes} 次、${totalUv} 位访客看过。`, 150),
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
        description: `${shown} 在 ${seo.SITE_NAME} 的创作者主页`,
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
  <div class="author-hero">
    <div class="author-hero-band" aria-hidden="true"></div>
    <div class="author-hero-main">
      <div class="author-avatar">${seo.esc(shown.slice(0, 1).toUpperCase())}</div>
      <div class="author-info">
        <h1>@${seo.esc(shown)}</h1>
        <div class="author-badges">
          ${userTagsOf(name).map(t => `<span class="author-tag">${seo.esc(t)}</span>`).join('')}
        </div>
        <p class="author-meta">
          ${since ? `<span class="am-item">${new Date(since).getFullYear()} 年 ${new Date(since).getMonth() + 1} 月入驻</span>` : ''}
          ${catList.length ? `<span class="am-item">常做 ${seo.esc(catList.map(c => c.name).join(' / '))}</span>` : ''}
        </p>
      </div>
    </div>
    <div class="author-stat-grid">
      <div class="as-cell"><b class="as-val">${list.length}</b><span class="as-label">作品</span></div>
      <div class="as-cell"><b class="as-val">${totalLikes}</b><span class="as-label">获赞</span></div>
      <div class="as-cell"><b class="as-val">${totalUv}</b><span class="as-label">访客</span></div>
      <div class="as-cell"><b class="as-val">${totalTippers}</b><span class="as-label">点亮人数</span></div>
    </div>
  </div>
  <div class="gallery">${withAuthorNames(list).map(w => seo.cardHtml(w)).join('') || '<div class="empty"><p>该作者还没有公开作品</p></div>'}</div>
  <div class="author-join">
    <div class="aj-copy">
      <b>也想拥有一页这样的创作者主页？</b>
      <p>在造梦橱窗免费投稿：作品免审核直接上线，自动拥有创作者主页，勋章、灯火、星梦榜为你的作品做见证。</p>
    </div>
    <div class="aj-actions"><a class="aj-link" href="/howto">查看投稿指南 →</a></div>
  </div>
</div>`;
  sendHtml(res, shell(headHtml, '', block)); // 同构：真人与爬虫共用一份 SSR，区块落在 #homeView 内，切视图时自动隐藏
});

// 发现页（移动端 Tab）：精选 + 平台专栏，SPA 自己渲染，服务端只出壳（不参与收录）
app.get('/discover', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `发现 - 按平台浏览作品：小程序、Android、iOS、Web - ${seo.SITE_NAME}`,
    description: '按平台浏览造梦橱窗收录的独立开发作品：微信小程序、Android、iOS、Web 网页应用、桌面客户端与机器人各一个专栏，配合本周精选持续更新，点开即用，也欢迎免费投稿你的作品。',
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

// 我的收藏（独立页面 /favs）：登录态内容，SPA 自己渲染列表，不收录
app.get('/favs', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `我的收藏 - ${seo.SITE_NAME}`,
    description: '查看你收藏的作品：收藏跟着账号走，换设备也不会丢。',
    canonical: base + '/favs',
    noindex: true
  });
  sendHtml(res, shell(headHtml, ''));
});

// 我的点赞（独立页面 /likes）：登录态内容，SPA 自己渲染列表，不收录
app.get('/likes', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `我的点赞 - ${seo.SITE_NAME}`,
    description: '查看你点赞过的作品：点赞存在账号里，换设备也在。',
    canonical: base + '/likes',
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
    title: `作品榜单 - 最受欢迎的免费网站、小程序与 App 排行 - ${seo.SITE_NAME}`,
    description: truncateText(
      `作品集热门榜单：按综合热度、点赞、收藏、打赏人数、访问量等维度排序，实时更新最受欢迎的网站、小程序、桌面客户端与机器人作品；灯火由真实访客的浏览和互动点亮，不卖排名、不收上榜费。`, 150),
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
  // 热搜词只给爬虫做内链：带 zero（搜了没结果）的词过去是空页；种子词的「人数」是展示热度、
  // 站内也不一定有内容，同样不进 SEO 区块——这块只放真被搜过、且搜得到东西的词
  const hotSeo = hotSearches(10).items.filter(i => !i.zero && !i.seed).slice(0, 8);
  const desc = truncateText(
    `造梦酒馆：坐下随便聊两句——今天发现的好东西、踩到的坑、想问的问题都行；也可以说一句你想要但还没人做的工具，` +
    `社区里的创作者来接单实现。目前共有 ${list.length} 个想法，` +
    `其中 ${doneCount} 个已被实现、${claimedCount} 个正在做。最受期待的有 ${top.slice(0, 3).map(i => i.title).join('、')} 等。`, 150);

  const headHtml = seo.head({
    title: `造梦酒馆 - 随便聊两句，也说说你想要的作品 - ${seo.SITE_NAME}`,
    description: desc,
    keywords: '造梦酒馆,闲聊,独立开发者社区,许愿墙,想要的功能,求工具,需求征集,作品定制,社区共创',
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
    <p>坐下随便聊两句，或者说说你想要的作品——社区里的高手会来接；被认领、被实现的想法会挂上作品链接</p>
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
    title: `小程序专栏 - 扫码就能用的独立微信小程序，随点随用 - ${seo.SITE_NAME}`,
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
// 推荐（独立页面）：登录后用灯火给作品换推荐位。noindex：纯功能页，搜索引擎不用收录
app.get('/promote', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `作品推荐位 - 用灯火兑换的自荐位，榜单页与酒馆一次展示 - ${seo.SITE_NAME}`,
    description: '在造梦橱窗用灯火给自己的作品换个推荐位：首页第一格、榜单页顶部、小程序推荐位等，按「被看到 / 被点开」计费，没投完的随时按原价退回。',
    canonical: base + '/promote',
    noindex: true,
    type: 'website'
  });
  sendHtml(res, shell(headHtml, ''));
});

// 账号设置（独立页面）：纯功能页，搜索引擎不用收录
app.get('/settings', (req, res) => {
  const base = seo.baseUrl(req);
  const headHtml = seo.head({
    title: `账号设置 - ${seo.SITE_NAME}`,
    description: '昵称、登录名与密码、系统消息提示、第三方账号绑定与屏蔽管理，集中在一个页面。',
    canonical: base + '/settings',
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

// ---------- 投放合作（Media Kit）：给外部广告主看的招商页，服务端渲染 ----------
// 所有统计数字实时算自 visits / works / workVisits，页面里不手写一个数——
// 数据随站点增长自动更新，招商材料永远不会过期。
// 口径与页脚一致：网页 + 小程序分开计 PV、UV 跨端去重并套用站长排除名单。
// ---------- 投放合作（/ads）：面向站外广告主的现金刊例 ----------
// 2026-11-11 渐进拆分第一步：本段原样搬进 ads-page.js（依赖注入，行为零变化），
// 这里只留一行注册。价格源 ADV_SLOTS / ADV_TRIAL 也随之搬走（全站唯一引用点就在那一页）。
require('./ads-page').register({
  app, seo, shell, sendHtml, truncateText,
  visits, workVisits, redemptions,
  visitExcludeSet, visitStats, visibleWorks, authorEntries, uncountedPvOf,
});

// ---------- 品牌橱窗页（/brand/:slug）：企业合作内容的落地页 ----------
// 2026-11-12「中改」：站内露出仍走广告位、仍标「广告」，但企业不用交横幅素材，
// 改做一页产品故事页，广告位的跳转地址填 /brand/<slug> 即可。数据在 data/brands.json。
require('./brand-page').register({
  app, seo, shell, sendHtml,
  requireAdmin, upload, compressUploads,
  readJSON, writeJSON,
});

// ---------- 企业产品入驻（/enterprise）：不谈钱的入驻邀请页 ----------
// 和 /ads 两条独立的路：那页卖广告位（收费、标「广告」、有刊例），
// 这页请企业入驻（不收费、标「企业合作」、只看产品）。纯内容页，无接口、无数据文件。
require('./enterprise-page').register({
  app, seo, shell, sendHtml, visibleWorks, authorEntries,
});

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
const CHRON_WORK_STEPS = [1, 10, 50, 100, 200, 500, 1000, 2000]; // 20 件档 2026-11-12 站长去掉：与 10 件离得太近
// 单日注册里程碑（2026-11-12 站长定档）：日注册人数第一次冲过 50 / 100 / 500 / 1000 / 2000 的那一天，
// 记成纪念日。口径与人数里程碑一致（站方 / 测试号剔除），按东八区划天；数据没到的档自动不出现。
const CHRON_DAILY_REG_STEPS = [50, 100, 500, 1000, 2000];
const CHRON_DAILY_REG_WORDS = {
  50: '单日注册第一次冲上 50 人——一天之内涌进 50 位新造梦者',
  100: '单日注册破百——一天之内来了 100 位新造梦者',
  500: '单日注册破五百——橱窗一天迎来 500 位新面孔',
  1000: '单日注册破千——一天 1000 位新造梦者，千人同日入梦',
  2000: '单日注册破两千——一天 2000 位新造梦者同日做梦'
};
// 单日访问里程碑（2026-11-13 站长改档：200 起改成 100 起，并加 300 档）：
// 单日访问人数（UV 口径：网页端 + 小程序端合并去重、剔除站长排除名单）第一次冲过
// 100 / 300 / 500 / 1000 / 10000 的那一天，记成纪念日。
// 坑：visits.days 只滚动保留最近 90 天（VISIT_RETENTION_DAYS），不固化的话老档位
// 的「那一天」滚出窗口后条目会从编年史里凭空消失——首次达成日落盘 data/chron-uv-marks.json，
// 已固化的档不再依赖窗口数据（窗口里找不到那天的明细，就不再补「当天实到 N 人」）。
const CHRON_DAILY_UV_STEPS = [100, 300, 500, 1000, 10000];
const CHRON_DAILY_UV_WORDS = {
  100: '单日访问首次突破 100 人——橱窗开始被更多人看见',
  300: '单日访问突破 300 人——一天之内，三百多位逛客走进橱窗',
  500: '单日访问突破 500 人——一天之内，几百位逛客走进橱窗',
  1000: '单日访问突破 1000 人——一天之内，上千人来看大家的作品',
  10000: '单日访问突破 10000 人——一天之内，上万人同逛一扇橱窗'
};
// 灯火台阶（2026-11-07 站长要求）：第一件累计被点亮 100 / 1000 / 10000 / 50000 盏灯火的作品。
// 与 buildChronicleItems 里的 CHRON_TIP_STEPS（全站第 N 盏落在哪件作品）不是一回事：
// 这里按**同一件作品**的打赏累计算，跨过台阶那一刻记一笔。数据没到就自动不出现，不留空占位。
// 台阶不是作品灯火的上限：这四档是点名必记的，之后再按 10 倍自动往上延伸（10 万 / 100 万 / …），
// 万一真出了一件特别优秀、被点了几百万盏的作品，编年史也不会在 5 万这里断掉。
const CHRON_LAMP_BASE_STEPS = [100, 1000, 10000, 50000];
const CHRON_LAMP_WORK_WORDS = {
  100: '第一件凑满百盏灯的作品',
  1000: '第一件攒到千盏灯的作品',
  10000: '第一件点亮万盏灯的作品',
  50000: '第一件被点亮五万盏灯的作品'
};
// 数据长到哪一档就生成到哪一档；20 档只是脏数据保护（防金额被写坏时生成无限条目），不是作品上限
function chronLampSteps(maxTotal) {
  const steps = CHRON_LAMP_BASE_STEPS.slice();
  let n = 100000;
  while (n <= maxTotal && steps.length < 20) { steps.push(n); n *= 10; }
  return steps;
}

// 编年史统计口径：站长的账号、后台测试账号、早期灌的示例账号都不算「创作者」，
// 否则「第一位注册用户」会落到测试号头上（线上真实第一位是 richardxxx0x）。
// 站长账号名写死在下面，改名的话同步改这里。
const CHRON_EXCLUDE_USERS = new Set(['思绪到处飞', '张三', '李四', '王五', '匿名']);   // 匿名账号不参与编年史（11-12 站长口径）
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
    // ICP 备案通过日（站长可在此改日期/文案；实际通过时间以阿里云备案控制台为准，日期按 git 里备案号首次出现前推的合理估计）
    at: '2026-10-28T10:00:00+08:00', ico: 'check-circle',
    text: '造梦橱窗通过 ICP 备案（沪ICP备2026057999号）——领到了自己的「身份证」，并在 <a href="https://www.aliyun.com/minisite/goods?userCode=tw6ffyfu" target="_blank" rel="nofollow sponsored noopener noreferrer">阿里云 <span aria-hidden="true">↗</span></a> 安家'
  },
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
    // 小程序上架日（站长可在此改日期/文案）。「扫码即达」是可点文字：点了开小程序码弹窗
    // （#miniModal 在 shell 里，编年史页也有；绑定在 app.js setupInstall 的 .chron-mini-open）
    at: '2026-11-06T10:00:00+08:00', ico: 'mini',
    text: '「造梦橱窗」小程序正式上架，<button type="button" class="chron-mini-open" title="点开看本站小程序码，微信扫码直达">扫码即达</button>；随小程序一起上线 3 个站内小程序推荐位，作品推荐从此能投给更精准的用户：他们可以在小程序里一键复制 App Store / 安卓下载链接，也可以直接扫码走进你的小程序——利好小程序、App 开发者。这意味着，您的作品不必再只等首页那一次曝光：投上推荐位，它就会出现在会下载、会使用、会留下来的人面前'
  },
  {
    // 桌面 PWA 上线日（站长可在此改日期/文案）
    at: '2026-11-06T12:00:00+08:00', ico: 'web',
    text: '造梦橱窗桌面 PWA 上线——像装本地应用一样把橱窗装进电脑：独立窗口、常驻任务栏，双击图标即达'
  },
  {
    // 众人小法官上线日（站长可在此改日期/文案）。
    // 只记「功能开审」这一笔，不记具体谁被判过——被众判下架对作者不是荣誉，
    // 放上公开时间线等于二次通报，别再往这里加「第一件被众判下架的作品」。
    at: '2026-11-13T21:00:00+08:00', ico: 'rules',
    text: '「众人小法官」开审——作品像不像站外推广，不再由站长一个人判断：登录的造梦者都能投一票，卡片上出现「众判中」就是喊你进去评理；「像推广」的票比「不像推广」多出 5 票，作品自动下架待整改，作者按规范改好可以重新提交。判错了随时说话，规则见<a href="/rules">作品规范</a>第十节'
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
  // —— 单日注册里程碑：哪一天「当日新注册」第一次冲过 50 / 100 / 500 / 1000 / 2000 人，就把那天记成纪念日 ——
  // us 已剔掉站方与测试账号、按注册时间排好序；createdAt 是 UTC 时间，按东八区（+08:00）划天。
  const regByDay = new Map();
  us.forEach(u => {
    const ms = new Date(u.createdAt).getTime();
    if (!Number.isFinite(ms)) return;
    const day = new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
    regByDay.set(day, (regByDay.get(day) || 0) + 1);
  });
  CHRON_DAILY_REG_STEPS.forEach(n => {
    const hit = [...regByDay.entries()]
      .filter(([, c]) => c >= n)
      .sort((a, b) => a[0].localeCompare(b[0]))[0];   // 最早冲过这一档的那天
    if (!hit) return;   // 还没到这一档：编年史不写空条目
    const [day, count] = hit;
    items.push({
      at: day + 'T12:00:00+08:00', ico: 'user',
      text: (CHRON_DAILY_REG_WORDS[n] || `单日注册突破 ${n} 人`) + (count > n ? `——当天实到 ${count} 位` : '')
    });
  });

  // —— 单日访问里程碑：哪一天「当日 UV（网页 + 小程序合并去重、剔排除名单）」第一次冲过
  // 200 / 500 / 1000 / 10000，就把那天记成纪念日。uv 的 key 空间两端本来就统一
  // （u:登录 / d:小程序设备 / ip:网页访客），放进同一个 Set 天然跨端去重。
  // 首次达成日固化进 data/chron-uv-marks.json：visits.days 只有 90 天窗口，
  // 不固化的话过几个月「单日 200」那条就会因为原始数据滚出窗口而从编年史里消失。
  let uvMarks = readJSON('chron-uv-marks.json', {});
  if (!uvMarks || typeof uvMarks !== 'object' || Array.isArray(uvMarks)) uvMarks = {};   // 文件写坏兜底：当空表重新积累
  const uvMarksDirty = { v: false };
  const uvByDay = new Map();   // day -> 当日去重访客数
  const uvEx = visitExcludeSet();
  Object.entries(visits.days || {}).forEach(([day, d]) => {
    if (!d || !day) return;
    const set = new Set();
    Object.keys(d.uv || {}).forEach(k => { if (!uvEx.has(k)) set.add(k); });
    Object.keys((d.mini && d.mini.uv) || {}).forEach(k => { if (!uvEx.has(k)) set.add(k); });
    uvByDay.set(day, set.size);
  });
  CHRON_DAILY_UV_STEPS.forEach(n => {
    let hitDay = uvMarks['uv' + n];
    if (!hitDay) {
      const hit = [...uvByDay.entries()]
        .filter(([, c]) => c >= n)
        .sort((a, b) => a[0].localeCompare(b[0]))[0];   // 最早冲过这一档的那天
      if (!hit) return;   // 还没到这一档：编年史不写空条目
      hitDay = hit[0];
      uvMarks['uv' + n] = hitDay;   // 固化：90 天窗口滚过去之后条目也不丢
      uvMarksDirty.v = true;
    }
    // 固化后那天可能已滚出窗口：有明细就带出当天真实人数。
    // 明细里查不到（早期还没开始记 visits.days，或被站长手工挪过日期）时，
    // 允许在 data/chron-uv-marks.json 里用 "uv100Count": 229 这样的键手工补一个人数
    // —— 站长 2026-11-13 把「首次突破 100」挪到 10-02，2026-11-14 更正为 11-02
    // （11-02 在 visits 窗口内有明细，当天人数直接取明细，手工补数键用不上）。
    const detailCount = uvByDay.get(hitDay);
    const manualCount = Number(uvMarks['uv' + n + 'Count']);
    const count = Number.isFinite(detailCount) ? detailCount
      : (Number.isFinite(manualCount) ? manualCount : undefined);
    items.push({
      // 23:59 排到当天最后一条（编年史按时间排序）：突破人数是「全天攒出来的成绩」，
      // 排在当天具体事件（开站 / 上架等）之后更顺；日期显示不受影响（同一天）
      at: hitDay + 'T23:59:00+08:00', ico: 'eye',
      text: (CHRON_DAILY_UV_WORDS[n] || `单日访问突破 ${n} 人`) + (Number.isFinite(count) ? `，当天实到 ${count} 人` : '')
    });
  });
  if (uvMarksDirty.v) { try { writeJSON('chron-uv-marks.json', uvMarks); } catch (e) { /* 写失败下轮再试，不影响页面 */ } }

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
  // —— 第一笔打赏 ——
  const firstTip = tips.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (firstTip) {
    const tw = works.find(x => x.id === firstTip.workId);
    // 打赏人名暂时不对公开（2026-11-07 站长要求）：站长署名保留，普通用户一律「有人」
    const giver = chronExcluded(firstTip.fromDisplay) ? '站长' : '有人';
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

  // —— 第一件「累计被点亮 N 盏灯火」的作品（单件作品口径，台阶不封顶） ——
  // 按打赏时间逐笔累加每件作品的盏数，谁最早跨过这一档就记谁、日期取跨过那一刻。
  // 站方与测试号作品不参与抢「第一件」（与其他作品里程碑同口径）；匿名作品保留，
  // 因为打赏是真实转移，匿名作品拿到百盏灯同样该被记下来。
  const lampWById = new Map(works.map(w => [w.id, w]));
  // createdAt 历史上有毫秒数字也有 ISO 字符串，两种都认，不能让老记录被静默漏算
  const lampMs = t => { const ms = new Date(t.createdAt).getTime(); return Number.isFinite(ms) && ms > 0 ? ms : 0; };
  const lampTips = tips
    .filter(t => t && t.workId && lampMs(t) && Number(t.amount) > 0)
    .slice()
    .sort((a, b) => lampMs(a) - lampMs(b) || String(a.id || '').localeCompare(String(b.id || '')));
  // 先看站内单件作品最高累计到多少，再据此生成台阶：5 万之后自动按 10 倍延伸，不封顶
  const lampTotals = new Map();
  for (const t of lampTips) {
    const w = lampWById.get(t.workId);
    if (!w || !w.createdAt || (w.author && chronExcluded(w.author))) continue;
    lampTotals.set(t.workId, (lampTotals.get(t.workId) || 0) + Number(t.amount));
  }
  let lampMax = 0;
  for (const v of lampTotals.values()) if (v > lampMax) lampMax = v;
  const lampSteps = chronLampSteps(lampMax);
  const lampAcc = new Map();   // workId -> 累计盏数
  const lampHits = new Map();  // 台阶 -> 最早跨过的 { at, w }
  for (const t of lampTips) {
    const w = lampWById.get(t.workId);
    if (!w || !w.createdAt || (w.author && chronExcluded(w.author))) continue;
    const prev = lampAcc.get(t.workId) || 0;
    const next = prev + Number(t.amount);
    lampAcc.set(t.workId, next);
    lampSteps.forEach(n => {
      if (!lampHits.has(n) && prev < n && next >= n) {
        lampHits.set(n, { at: new Date(lampMs(t)).toISOString(), w });
      }
    });
  }
  lampSteps.forEach(n => {
    const hit = lampHits.get(n);
    if (!hit) return;   // 还没到这一档：编年史不写空条目
    const who = hit.w.author ? `（@${seo.esc(displayNameOf(hit.w.author) || hit.w.author)}）` : '';
    const word = CHRON_LAMP_WORK_WORDS[n] || `第一件点亮 ${n / 10000} 万盏灯的作品`;
    items.push({
      at: hit.at, ico: 'lamp',
      text: `《${seo.esc(hit.w.title)}》累计被点亮 ${n.toLocaleString('zh-CN')} 盏灯火——${word}${who}`
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
  // 坑（2026-11-09 修）：ck.total 是累计签到拿到的**灯火**不是天数——一轮 7 天就能拿 56 盏，
  // 拿它当天数，签满 6 天（41 盏）就会被宣布「坚持一个月」，编年史出现不可能的记录。
  // 天数口径与勋章模块（badgeFacts.ckDays）一致：ck.days 优先，老数据没这个字段时
  // 用积分流水里的 checkin 条目数兜底（上限 60 条，够到 30 天门槛）。
  const ckFull = Object.entries((shareData && shareData.users) || {})
    .map(([uid, rec]) => {
      const ck = (rec && rec.checkin) || {};
      const logs = (Array.isArray(rec && rec.log) ? rec.log : []).filter(e => e && e.kind === 'checkin' && e.t);
      return { uid, ck, days: Math.max(Number(ck.days || 0), logs.length, ck.last ? 1 : 0) };
    })
    .filter(x => x.days >= 30 && x.ck.last)
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
    if (!w.author || w.anonymous === true || chronExcluded(w.author)) return;   // 匿名发布/匿名账号不算（11-12 站长口径）
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
// ---------- 精选专栏（/column、/column/:slug） ----------
// 站方编辑内容，和首页彻底解耦：独立路由 + 独立 SSR 整页，首页结构一个字节都不动。
// 内容放 content/columns.json 而不是 data/：data/ 在部署包里被排除（运行时数据不进仓库），
// 编辑内容必须跟代码一起发布。读文件按 mtime 缓存，改完刷新即生效，不用重启进程。
const COLUMNS_FILE = path.join(__dirname, 'content', 'columns.json');
let columnsCache = { mtime: 0, data: null };
function columnsData() {
  try {
    const st = fs.statSync(COLUMNS_FILE);
    if (!columnsCache.data || st.mtimeMs !== columnsCache.mtime) {
      const raw = JSON.parse(fs.readFileSync(COLUMNS_FILE, 'utf-8'));
      const topics = (Array.isArray(raw.topics) ? raw.topics : [])
        .filter(t => t && t.slug && t.title && Array.isArray(t.items));
      columnsCache = {
        mtime: st.mtimeMs,
        data: { updatedAt: raw.updatedAt || '', intro: raw.intro || '', topics }
      };
    }
  } catch (e) {
    // 文件缺失或 JSON 写坏：给空专栏，页面自己出空态，不能连累整站启动
  }
  return columnsCache.data || { updatedAt: '', intro: '', topics: [] };
}
// 分级只做三档，颜色语义固定：首选=绿、值得一试=蓝、特定场景=琥珀
const COLUMN_TIER = { '首选': 'first', '值得一试': 'try', '特定场景': 'scene' };
const COLUMN_CSS = `
.col-wrap { max-width: 980px; }
.col-hero { padding: 8px 0 2px; }
.col-kicker { display: inline-block; font-size: 12.5px; letter-spacing: .06em; color: var(--primary); background: #efeffb; border: 1px solid #dedcfb; border-radius: 999px; padding: 3px 10px; }
.col-hero h1 { font-size: 30px; line-height: 1.32; margin: 12px 0 6px; }
.col-hero .col-sub { font-size: 15px; font-weight: 500; color: var(--text); margin: 0 0 10px; line-height: 1.7; }
.col-hero .col-sum { font-size: 14px; color: var(--muted); line-height: 1.85; max-width: 720px; }
.col-hero-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; font-size: 12.5px; color: var(--muted); }
.col-hero-meta b { color: var(--text); font-weight: 600; }
.col-hero-tip { margin-top: 10px; font-size: 13px; color: var(--muted); }
.col-hero-tip a { color: var(--primary); text-decoration: none; }
.col-hero-tip a:hover { text-decoration: underline; }
.col-tno { font-size: 12px; font-weight: 700; letter-spacing: .1em; color: var(--primary); }
.col-toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 4px; }
.col-toc a { font-size: 12.5px; color: var(--muted); text-decoration: none; border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; background: var(--card); }
.col-toc a:hover { color: var(--primary); border-color: #c9c6f5; }
.col-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 14px; }
.col-item { display: grid; grid-template-columns: 44px 1fr; gap: 14px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 18px 18px 16px; scroll-margin-top: 84px; }
.col-rank { width: 34px; height: 34px; border-radius: 10px; background: #efeffb; color: var(--primary); font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.col-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
.col-head h2 { font-size: 18px; line-height: 1.4; }
.col-tier { font-size: 11.5px; font-weight: 600; border-radius: 6px; padding: 2px 7px; white-space: nowrap; }
.col-tier.first { background: #eaf7ef; color: #1f7a45; border: 1px solid #cdeddb; }
.col-tier.try { background: #eef1ff; color: #4149c8; border: 1px solid #d8ddff; }
.col-tier.scene { background: #fff6e8; color: #8a5a12; border: 1px solid #f2e0bd; }
.col-vendor { font-size: 12.5px; color: var(--muted); }
.col-verdict { margin: 8px 0 10px; font-size: 14.5px; line-height: 1.8; color: var(--text); }
.col-plats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.col-plats span { font-size: 11.5px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; }
.col-pg { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.col-good, .col-bad { border-radius: 10px; padding: 10px 12px; font-size: 13px; line-height: 1.75; }
.col-good { background: #f4fbf6; border: 1px solid #e0f0e6; }
.col-bad { background: #fdf6f4; border: 1px solid #f2e2dc; }
.col-good b, .col-bad b { display: block; font-size: 12px; letter-spacing: .04em; margin-bottom: 4px; }
.col-good b { color: #1f7a45; }
.col-bad b { color: #a8482e; }
.col-good ul, .col-bad ul { margin: 0; padding-left: 16px; color: #4b5063; }
.col-good li, .col-bad li { margin: 2px 0; }
.col-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); font-size: 12.5px; color: var(--muted); }
.col-foot b { color: var(--text); font-weight: 600; }
.col-ext { margin-left: auto; font-size: 12.5px; font-weight: 600; color: var(--primary); text-decoration: none; border: 1px solid #d8ddff; background: #f4f5ff; border-radius: 8px; padding: 5px 10px; white-space: nowrap; }
.col-ext:hover { background: #ecedff; }
.col-siblings { margin-top: 22px; padding: 16px 18px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; }
.col-siblings h3 { font-size: 14px; margin-bottom: 10px; }
.col-siblings .col-toc { margin: 0; }
.col-note { margin-top: 16px; font-size: 12.5px; line-height: 1.8; color: var(--muted); }
.col-note a { color: var(--primary); }
.col-empty { padding: 60px 0; text-align: center; color: var(--muted); }
/* 总览页的类目分区：一进来就要看见软件名，不能只给类目卡 */
.col-sec { margin: 28px 0 4px; }
.col-sec-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px 14px; flex-wrap: wrap; padding-bottom: 10px; margin-bottom: 14px; border-bottom: 1px solid var(--border); }
.col-sec-head h2 { font-size: 20px; line-height: 1.4; display: inline; }
.col-sec-head h2 a { color: inherit; text-decoration: none; }
.col-sec-head h2 a:hover { color: var(--primary); }
.col-sec-sub { font-size: 13px; color: var(--muted); margin-top: 5px; }
.col-sec-more { font-size: 12.5px; font-weight: 600; color: var(--primary); text-decoration: none; white-space: nowrap; }
.col-briefs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.col-brief { display: block; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 13px 14px; text-decoration: none; color: inherit; transition: border-color .16s, box-shadow .16s; }
.col-brief:hover { border-color: #c9c6f5; box-shadow: 0 6px 18px rgba(91, 91, 214, .08); }
.col-brief-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 5px; }
.col-brief h3 { font-size: 15.5px; line-height: 1.4; }
.col-brief p { font-size: 12.8px; color: var(--muted); line-height: 1.72; margin: 0; }
.col-brief-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 9px; font-size: 11.5px; color: #9aa0b3; }
@media (max-width: 640px) {
  .col-hero h1 { font-size: 24px; }
  .col-item { grid-template-columns: 1fr; gap: 10px; padding: 16px; }
  .col-rank { width: 28px; height: 28px; font-size: 13px; }
  .col-pg { grid-template-columns: 1fr; }
  .col-briefs { grid-template-columns: 1fr; }
  .col-ext { margin-left: 0; }
}
`;
const colDate = iso => {
  const s = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '.') : '';
};
const colPlats = it => (Array.isArray(it.platforms) ? it.platforms : [])
  .map(p => `<span>${seo.esc(p)}</span>`).join('');

// 专栏总览：类目卡片
app.get('/column', (req, res) => {
  const base = seo.baseUrl(req);
  const data = columnsData();
  const topics = data.topics;
  const total = topics.reduce((n, t) => n + t.items.length, 0);
  const headHtml = seo.head({
    title: `精选专栏 - 编辑实际用过的软件清单，按类目更新 - ${seo.SITE_NAME}`,
    description: truncateText(
      `精选专栏：编辑按类目挑的软件清单，覆盖效率办公、笔记知识库、设计创作、开发工具、AI 工具与团队协作，每个类目只留用得住的几个，排在前面的更推荐。`, 150),
    keywords: '软件推荐,软件精选,效率软件,办公软件,设计工具,开发工具,AI工具,团队协作,知识库,选型',
    canonical: base + '/column',
    type: 'website',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '精选专栏' }]),
      {
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: '精选专栏', url: base + '/column',
        description: '站方编辑按类目挑选的软件清单',
        hasPart: topics.map(t => ({
          '@type': 'WebPage', name: t.title, url: `${base}/column/${t.slug}`
        }))
      }
    ]
  });
  const block = `<div id="seoContent" class="seo-wrap col-wrap">
  <style>${COLUMN_CSS}</style>
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '精选专栏' }])}
  <div class="col-hero">
    <span class="col-kicker">编辑精选</span>
    <h1>${seo.svgIco('sparkle')} 精选专栏</h1>
    <p class="col-sub">按类目挑软件，一个类目只留用得住的几个。</p>
    <p class="col-sum">${seo.esc(data.intro)}</p>
    <div class="col-hero-meta">
      <span><b>${topics.length}</b> 个类目</span>
      <span><b>${total}</b> 款软件</span>
      ${data.updatedAt ? `<span>整体更新于 ${seo.esc(colDate(data.updatedAt))}</span>` : ''}
    </div>
    <p class="col-hero-tip">你也有好用的想推荐？<a href="/?feedback=1">提交给我们</a>，合适的会收进对应类目。</p>
  </div>
  ${topics.length ? `<nav class="col-toc" aria-label="类目导航">
    ${topics.map(t => `<a href="#${seo.esc(t.slug)}">${seo.esc(t.no || '')} ${seo.esc(t.title)}</a>`).join('')}
  </nav>
  ${topics.map(t => `<section class="col-sec" id="${seo.esc(t.slug)}">
    <div class="col-sec-head">
      <div>
        <span class="col-tno">${seo.esc(t.no || '')}</span>
        <h2><a href="/column/${seo.esc(t.slug)}">${seo.esc(t.title)}</a></h2>
        <p class="col-sec-sub">${seo.esc(t.subtitle || '')}</p>
      </div>
      <a class="col-sec-more" href="/column/${seo.esc(t.slug)}">${t.items.length} 款 · 完整评价 →</a>
    </div>
    <div class="col-briefs">
      ${t.items.map((it, i) => {
        const tier = COLUMN_TIER[it.tier] || 'try';
        return `<a class="col-brief" href="/column/${seo.esc(t.slug)}#s-${i + 1}">
        <div class="col-brief-top">
          <h3>${seo.esc(it.name)}</h3>
          <span class="col-tier ${tier}">${seo.esc(it.tier || '值得一试')}</span>
        </div>
        <p>${seo.esc(it.verdict || '')}</p>
        <div class="col-brief-meta">
          ${it.vendor ? `<span>${seo.esc(it.vendor)}</span>` : ''}
          ${it.platforms && it.platforms.length ? `<span>${seo.esc(it.platforms.slice(0, 3).join(' / '))}</span>` : ''}
        </div>
      </a>`;
      }).join('')}
    </div>
  </section>`).join('')}` : '<p class="col-empty">专栏内容还在整理中。</p>'}
  <p class="col-note">名单顺序就是推荐顺序，排在前面的更推荐。站内带「广告」角标的是单独的投放位，跟这份名单无关。<br />
  发现信息过期或写错了？<a href="/?feedback=1">告诉我们</a>，核实后会更新对应类目的日期。</p>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a></p>
</div>`;
  sendHtml(res, shell(headHtml, block));
});

// 专栏详情：一个类目一页
app.get('/column/:slug', (req, res) => {
  const base = seo.baseUrl(req);
  const data = columnsData();
  const topic = data.topics.find(t => t.slug === req.params.slug);
  if (!topic) {
    const headHtml = seo.head({
      title: `专栏不存在 - ${seo.SITE_NAME}`,
      description: '这个专栏还没有发布。',
      canonical: base + '/column',
      noindex: true
    });
    return sendHtml(res, shell(headHtml, notFoundBlock(base)), 404);
  }
  const items = topic.items.filter(it => it && it.name);
  const pageUrl = base + '/column/' + encodeURIComponent(topic.slug);
  const others = data.topics.filter(t => t.slug !== topic.slug);
  const headHtml = seo.head({
    title: `${topic.title}精选软件清单 - 编辑实际用过的评价与建议 - ${seo.SITE_NAME}`,
    description: truncateText(
      `${topic.summary || topic.subtitle || ''}本类目精选 ${items.length} 款：${items.map(i => i.name).join('、')}。`, 150),
    keywords: [topic.title, `${topic.title}软件`, '软件推荐', '软件选型', ...(topic.tags || [])].join(','),
    canonical: pageUrl,
    type: 'article',
    publishedTime: topic.updatedAt || data.updatedAt || '',
    modifiedTime: topic.updatedAt || data.updatedAt || '',
    jsonLd: [
      seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '精选专栏', href: '/column' }, { name: topic.title }]),
      {
        '@context': 'https://schema.org', '@type': 'ItemList',
        name: `${topic.title}精选软件`,
        url: pageUrl,
        numberOfItems: items.length,
        itemListOrder: 'https://schema.org/ItemListOrderAscending',
        // 只挂能核实的事实（名称/厂商/平台），不编造用户评分——虚假 aggregateRating 会被搜索引擎判罚
        itemListElement: items.map((it, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'SoftwareApplication',
            name: it.name,
            applicationCategory: 'BusinessApplication',
            operatingSystem: (it.platforms || []).join(', '),
            publisher: { '@type': 'Organization', name: it.vendor || it.name }
          }
        }))
      }
    ]
  });
  const block = `<div id="seoContent" class="seo-wrap col-wrap">
  <style>${COLUMN_CSS}</style>
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '精选专栏', href: '/column' }, { name: topic.title }])}
  <div class="col-hero">
    <span class="col-kicker">精选 · ${seo.esc(topic.no || '')}</span>
    <h1>${seo.esc(topic.title)}</h1>
    <p class="col-sub">${seo.esc(topic.subtitle || '')}</p>
    <p class="col-sum">${seo.esc(topic.summary || '')}</p>
    <div class="col-hero-meta">
      <span><b>${items.length}</b> 款</span>
      ${topic.updatedAt ? `<span>更新于 ${seo.esc(colDate(topic.updatedAt))}</span>` : ''}
      <span>顺序即推荐顺序</span>
    </div>
  </div>
  <nav class="col-toc" aria-label="本页目录">
    ${items.map((it, i) => `<a href="#s-${i + 1}">${i + 1}. ${seo.esc(it.name)}</a>`).join('')}
  </nav>
  <ol class="col-list">
    ${items.map((it, i) => {
      const tier = COLUMN_TIER[it.tier] || 'try';
      const good = (it.good || []).map(x => `<li>${seo.esc(x)}</li>`).join('');
      const bad = (it.bad || []).map(x => `<li>${seo.esc(x)}</li>`).join('');
      return `<li class="col-item" id="s-${i + 1}">
      <div class="col-rank">${i + 1}</div>
      <div>
        <div class="col-head">
          <h2>${seo.esc(it.name)}</h2>
          <span class="col-tier ${tier}">${seo.esc(it.tier || '值得一试')}</span>
          ${it.vendor ? `<span class="col-vendor">${seo.esc(it.vendor)}</span>` : ''}
        </div>
        <p class="col-verdict">${seo.esc(it.verdict || '')}</p>
        ${it.platforms && it.platforms.length ? `<div class="col-plats">${colPlats(it)}</div>` : ''}
        ${good || bad ? `<div class="col-pg">
          ${good ? `<div class="col-good"><b>好在</b><ul>${good}</ul></div>` : ''}
          ${bad ? `<div class="col-bad"><b>注意</b><ul>${bad}</ul></div>` : ''}
        </div>` : ''}
        <div class="col-foot">
          ${it.for ? `<span><b>适合</b> ${seo.esc(it.for)}</span>` : ''}
          ${it.pricing ? `<span><b>价格</b> ${seo.esc(it.pricing)}</span>` : ''}
          ${it.url ? `<a class="col-ext" href="${seo.esc(it.url)}" target="_blank" rel="noopener nofollow">官网 ↗</a>` : ''}
        </div>
      </div>
    </li>`;
    }).join('') || '<li class="col-empty">这个类目还在整理中。</li>'}
  </ol>
  ${others.length ? `<div class="col-siblings">
    <h3>其他专栏</h3>
    <nav class="col-toc">${others.map(t => `<a href="/column/${seo.esc(t.slug)}">${seo.esc(t.title)}</a>`).join('')}</nav>
  </div>` : ''}
  <p class="col-note">信息更新于 ${seo.esc(colDate(topic.updatedAt) || colDate(data.updatedAt) || '—')}，价格与功能以各官网为准。<br />
  这里只写编辑自己的使用判断；写错了或版本已变，<a href="/?feedback=1">告诉我们</a>。</p>
  <p class="seo-more"><a class="btn-ghost" href="/column">← 全部专栏</a></p>
</div>`;
  sendHtml(res, shell(headHtml, block));
});

app.get('/chronicle', (req, res) => {
  const base = seo.baseUrl(req);
  const items = buildChronicleItems();
  const headHtml = seo.head({
    title: `造梦编年史 - 造梦橱窗上线以来的大事记与更新回顾 - ${seo.SITE_NAME}`,
    description: '造梦橱窗编年史：记下站点的每一个「第一次」和每一级台阶——第一件上架作品、第一位开源作者、第 100 位造梦者、小程序上架、桌面 PWA 上线、众人小法官开审，这些属于站点自己的日子都在这条时间线上。',
    keywords: '造梦编年史,大事记,站点历史,荣誉徽章,灯火,众人小法官,造梦橱窗,GitHub原创作者',
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
    title: `安装到桌面 - 把造梦橱窗像 App 一样装进手机和电脑（PWA 教程） - ${seo.SITE_NAME}`,
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
      <p>「造梦橱窗」小程序已上架，扫码即达；随小程序一起上线 3 个站内小程序推荐位，作品推荐能投给更精准的用户：他们可以在小程序里一键复制 App Store / 安卓下载链接，也可以直接扫码走进你的小程序，当场玩一遍。</p>
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
    title: `投稿指南 - 手把手教你免费提交网站、小程序等作品并获得曝光 - ${seo.SITE_NAME}`,
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
    <li><span class="rank-no">2</span><div class="rank-main"><div class="rank-title">准备好材料</div><p class="seo-guide-tip">作品名称、封面图（JPG / PNG / WebP，支持 Ctrl+V 粘贴截图）、作品地址（Web 形态必填）、一句话简介——简介决定别人点不点进来，但别靠「免费」这类词撑场，写清它能替人做什么更有效。</p></div></li>
    <li><span class="rank-no">3</span><div class="rank-main"><div class="rank-title">填表：形态、分类、宣传图</div><p class="seo-guide-tip">作品形态可多选；应用分类最多 3 个、第一个是主分类；官网选填；宣传图最多 9 张，展示在详情页。介绍下面有块「让它被搜到、被 AI 引用」（选填）：用五个短句说清它是什么 / 解决什么 / 适合谁 / 上手几步 / 和同类比，详情页会多一张「一眼看懂」速览卡，搜索摘要和 AI 回答优先摘这一段。</p></div></li>
    <li><span class="rank-no">4</span><div class="rank-main"><div class="rank-title">两个加分标注</div><p class="seo-guide-tip">标注开源并填源码地址，系统送 50 盏灯火（一件作品一次）；仓库在 GitHub 的，star 涨了以后在个人菜单 /「我的」页点「更新 star 奖励」，按 1:1 换灯火（掉星不扣、回升不重发）；未绑定 GitHub 的 100 star 以内当场到账、超过 100 由站长核定，绑定 GitHub 且仓库在自己名下的单次放宽到 500 star、再多也要站长看一眼；Gitee 等其他托管站读不到 star，由站长人工核对；收费情况如实标注，避免用户预期错位。</p></div></li>
    <li><span class="rank-no">5</span><div class="rank-main"><div class="rank-title">提交之后</div><p class="seo-guide-tip">注册用户提交即上线；匿名投稿进入待审核。被下架的作品会收到站内消息说明原因，修改后重新提交、审核通过即恢复。</p></div></li>
    <li><span class="rank-no">6</span><div class="rank-main"><div class="rank-title">上线后，这样让更多人看见</div><p class="seo-guide-tip">分享卡片一键生成带二维码的分享图；外宣包按 8 个平台生成现成投稿文案；推荐用灯火换个推荐位（曝光包按位置 1-4 灯火/次、点击包按 30-120 灯火/次，以投放面板实时价为准，撤下按剩余退回）；上传作品首件 +200（上线即到 100 盏、余款 24 小时到账）、之后每件 +50（48 小时到账）、每日签到 5→5→10→10→20→20→30 七天一轮（第 7 天全勤共 100 盏，断签从头算）、微信小程序看激励视频每次 +30 盏（每天 3 次，与签到互不影响）、好友访问 +1、好友注册 +100、开源 +50、开源作品的 GitHub star 同步后按 1:1 换灯火；每周榜单与「本周精选」会收录数据好的作品。</p></div></li>
  </ol>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页提交作品</a></p>
</div>`;
  sendHtml(res, shell(headHtml, '', block));
});
// 作品规范：投稿前要看的硬规则（服务端渲染，真人 + 爬虫都能看；表单和详情页都链到这里）
// 勋章页：独立静态页（不参与 SPA、不做 SSR、不进 sitemap）。
// 内容全是登录用户的私人数据，爬虫收录了也没意义，页面自己带 noindex。
app.get('/medals', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  // 本地开发时也要带环境徽标：走读取+注入（线上 devEnv.enabled=false，仍旧 sendFile）
  if (devEnv.enabled) {
    try {
      return res.type('html').send(devEnv.injectInto(fs.readFileSync(path.join(__dirname, 'frontend', 'medals.html'), 'utf-8')));
    } catch { /* 读不到就退回 sendFile */ }
  }
  res.sendFile(path.join(__dirname, 'frontend', 'medals.html'));
});

// 换形象页：同样是独立静态页（不参与 SPA、不进 sitemap，页面自带 noindex）。
// 形象数据在 mascots.js，动效在 mascots.css，选的存 localStorage['dm_mascot']。
// 站长标识逐个请求注入（页面很小、本来就 no-cache）：beta 形象只给后台登录过的人选。
app.get('/mascots', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  let html = '';
  try {
    html = fs.readFileSync(path.join(__dirname, 'frontend', 'mascots.html'), 'utf-8');
  } catch {
    return res.status(500).send('页面暂时打不开，回 <a href="/">首页</a> 试试');
  }
  res.type('html').send(devEnv.injectInto(html.split('__ADMIN__').join(isAdmin(req) ? '1' : '0')));
});

// 首页小助手用：只在本地存的是内测形象时才问一次「我是不是站长」，别的时候不请求
// /mascots 页也问一次（它不引 app.js）：同一趟里把站头要的登录态一起带回去，省一次 /api/me。
app.get('/api/mascots/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const u = currentUser(req);
  res.json({
    admin: isAdmin(req),
    loggedIn: !!u,
    name: u ? (u.nickname || displayNameOf(u.username)) : ''
  });
});

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
        <li><b>标题和一句话介绍，先写清「它是什么」。</b>别把「免费」「永久免费」「限时 0 元」「神器」这类词堆在最前面当钩子——最值钱的位置留给作品本身：真免费，介绍里说一句就够，读者想知道的是它能替他干什么。一个简单的自查：这句话换到别人的作品上还成立，那它就是空话。酒香不怕巷子深，东西打磨好了，比什么形容词都管用。这类写法不扣分、不下架：审核时请你改一版再上线，已经上线的提醒后改过来就行。</li>
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

    <section class="rules-sec">
      <h2>八、灯火换的推荐位，怎么算钱</h2>
      <p class="rules-note">用灯火换一个推荐位，换的是「被真人看见」的次数，不是「页面被打开」的次数。把算法摊开写清楚，你才知道灯火花在哪儿。</p>
      <ul class="rules-list">
        <li><b>看见才算，没看见不收。</b>作品卡要真的滚进屏幕、露出一半以上，才记一次。这一步由浏览器自带的 IntersectionObserver（可见性检测）判定：挂在页面底部没滑到、轮播里还没轮到它，都不计数、也不扣灯火。</li>
        <li><b>同一个人不重复收。</b>同一次浏览里同一张卡只记一次；同一个人一天最多扣 1 次曝光、3 次点击，之后再看见、再点开，作品照常展示，但不再扣灯火。刷新、反复看，也刷不出额外消耗。</li>
        <li><b>自己看自己不收。</b>你打开自己的作品页不消耗灯火；正在看的这件作品，也不会在详情页里给自己推自己。</li>
        <li><b>只在推荐卡上算。</b>只有带「推荐」角标的那张卡被看到、被点开才扣灯火。作品在「最新」「最热」「随便逛逛」里被正常浏览、点开、点赞收藏，都不扣灯火；投放也不会改变这几处的排序——不会让作品插队，也不会给它加分，那几处只按作品自己收到的赞、收藏、评论和真实访问排。</li>
        <li><b>按位置各算各的。</b>一件作品可以同时投几个位置，每个位置单独计：同一个人先在首页第一格看到、点进详情又看到，就是两笔，各扣各自那一单——两块位置确实都露了面。反过来，同一笔投放哪怕在几个展示面（榜单页和酒馆、随便逛逛）都露了面，同一个人一天仍只扣 1 次。</li>
        <li><b>同时最多 3 条在投。</b>网页和小程序共用这个名额；同一件作品在同一个位置只能挂一条，位置本身不设库存，多人同投时每次随机展示一条、各家机会均等。有单子投完、到期或撤下，名额立刻空出来。</li>
        <li><b>花了多少，自己能查。</b>「我的投放」里每一单都写着已消耗多少盏、撤下还能退多少盏；投出去点「看效果」，能亲眼看到自己的作品卡挂在哪个位置，不用猜。</li>
        <li><b>没用完能退。</b>额度用完自动下线；没投完随时可以撤下，剩下的按原价退回灯火，一分不差。</li>
      </ul>
      <p class="rules-note">一句话：<b>只有真人真的看见了，才花你一盏灯火。</b>看不见的不算、重复看的不算、自己看的不算。</p>
    </section>

    <section class="rules-sec">
      <h2>九、灯火要不要花钱</h2>
      <p class="rules-note">一句话：<b>灯火只送不卖，永远不需要花钱买。</b>站里没有充值入口，也不打算开。</p>
      <ul class="rules-list">
        <li><b>所有获取方式都免费。</b>每天签到、看激励视频广告、邀请好友注册、投稿过审、点亮开源项目，全都不收一分钱。</li>
        <li><b>没有「买灯火」这回事。</b>站内不存在充值按钮或购买页面；你看到的灯火数，只能从上面那几条免费路径来。</li>
        <li><b>将来要调整，也只调送多少。</b>如果哪天运营成本变了，我们只会调整赠送规则（比如签到给多给少、每轮几天），不会把灯火改成要花钱买。</li>
        <li><b>和付费广告是两条账。</b>站里唯一和钱有关的是顶部广告位——那是企业投放，明码标价、带「广告」角标。它和灯火互不相通：不能花钱买灯火，也不能拿灯火抵广告费。</li>
      </ul>
    </section>

    <section class="rules-sec">
      <h2>十、众人小法官（疑似推广众判）</h2>
      <p class="rules-note">站里有一类问题管理员看不完、用户天天见：作品本身能用，但写法像推广、像刷量、像导流。这一票交给众人。</p>
      <ul class="rules-list">
        <li><b>怎么投。</b>作品详情页有「众人小法官」入口，登录后可选「像推广，该整改」或「不像推广」。两个选择都只是一票，不是举报按钮，投完不会立刻有任何处理。</li>
        <li><b>卡片上的「众判中」标识。</b>当「像推广」的票数<b>多于</b>「不像推广」时，这件作品的卡片上会挂出「众判中 N」标识——点它直接进入详情页的投票区。标识只是征求意见的信号，不等于作品有问题；反对票反超后标识自动消失。标识出现的门槛比下架低：领先 1 票就挂，但要领先 5 票才下架。</li>
        <li><b>什么时候下架。</b>当「像推广」的票比「不像推广」<b>多出 5 票</b>时，作品自动下架待整改：不进首页、榜单、搜索和随便逛逛，别人打开链接会看到「已下架」。</li>
        <li><b>为什么算「净差」不算总票数。</b>看的是假票比真票多几个人，而不是谁先凑够某个数字：6 比 5、10 比 6 这种胶着局面都不下架，只要反对票追上来、差距不足 5 票，作品就继续展示；5 比 0、8 比 2 这种一边倒才下架。</li>
        <li><b>下架之后。</b>作者会收到站内消息和具体原因；在「我的作品」里按规范改好、重新保存提交，审核通过即恢复展示。<b>浏览、点赞、收藏、灯火和已买的推荐位都不清空</b>，这不是封号。</li>
        <li><b>投票资格。</b>必须登录；账号注册满 24 小时后才有投票资格；不能给自己的作品投票；一人一票，可以改票。</li>
        <li><b>防小号。</b>同一个网络下对同一件作品最多计入 2 张认定票——想拉开 5 票的净差，至少要来自 3 个不同网络。批量注册的新号、同一 WiFi 下的一串小号，都刷不动。</li>
        <li><b>判错了怎么办。</b>作者可在作品页底部「意见建议」里申诉；管理员复核后可以结案恢复，这一轮的票数会一并清零，不影响作品之后的展示。</li>
      </ul>
      <p class="rules-note">所有投票记录（账号、时间、选择）后台可查。用众判打击同行、组织小圈子围投的，按上一条「违规怎么处理」处理。</p>
    </section>

    <p class="rules-foot">规范会随平台规则调整，重要变更在站内通知。最近更新：2026-11-13。</p>
    <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a> <a class="btn-ghost" href="/howto">投稿指南 →</a></p>
  </div>
</div>`;
  sendHtml(res, shell(headHtml, block)); // 全量渲染：规范页是长期入口，真人也要能直接打开
});

// ---------- 分类/形态聚合页的编辑导语（SEO，2026-11-11） ----------
// 一页一段人话，讲清这个分类适合谁、东西长什么样、怎么挑着用——替代原来只有
// 一行 subtitle 的薄页面。全部是通用描述，不含会过时的数字；数字仍由 facts 区展示。
// 新增分类没写导语时走 composeListIntro() 兜底，用真实统计拼一段，不与 description 撞模板。
const CATEGORY_INTROS = {
  '效率工具': '这一类都围绕「把活干快」：待办清单、笔记知识库、截图贴图、格式转换、批量重命名、剪贴板管理……挑的时候建议先想清楚自己要解决的那个具体动作，再看卡片上的「开源」和「Web 即用」标注——能在浏览器里直接打开的优先试，满意了再考虑装客户端。本页默认按上架时间排序，点开卡片能看到截图、介绍和真实访客的反馈，顺手可以收藏进自己的清单慢慢比。',
  '生活助手': '记账、打卡、菜谱、天气、日程提醒……这一类作品都为了把日常生活里的小麻烦一个个消掉。它们大多轻量、免费、打开即用，不用注册也能先玩起来。挑的时候留意卡片标注的可用平台：手机上用得多就优先看带小程序版的，电脑前用得多就挑 Web 或桌面客户端。点开卡片有截图和作者说明，适合先收藏两三件轮着用一周，留下最顺手的那个。',
  '内容创作': '写作、做图、剪视频、配字幕、排版发布——这一类工具服务的都是「要把东西做出来发出去」的人。里面既有独立的编辑器，也有配合公众号、小红书、B 站使用的小工具。建议按你常用的创作环节来找：灵感收集、正文撰写、封面制作、发布排版，每个环节挑一件就够用。开源作品可以直接看源码，想自己改主题、接自己图床的会省不少事。',
  '学习教育': '背单词、刷题、做卡片、看教程进度……这一类作品更适合「要长期坚持」的学习场景，所以挑选的关键不是功能多，而是用起来 friction 够不够小：打开快、记得住进度、手机上也能用。卡片里标注了小程序版的可以扫码直接进，通勤路上就能用起来。先想清楚你要坚持的是什么（单词、刷题、复习计划），再从列表里挑一件用满一周，比囤一堆工具有用得多。',
  '娱乐游戏': '能直接在浏览器或微信里打开的小游戏和小玩意：休闲闯关、双人对战、解谜、抽签互动……这一类的共同点是零安装、点开就玩，适合摸鱼十分钟或者和朋友来一局。双人对战类的记得看说明里的联机方式，有的扫码就能和好友开一局。觉得好玩的话，给作者点个赞或者留条反馈，独立开发者很吃这套。',
  '开发工具': 'JSON 格式化、正则调试、接口 Mock、色值转换、正则速查……这一类是写给写代码的人的，特点是「小而准」：每件只解决一个高频动作，多数带 Web 版，收藏到浏览器书签栏随开随用。开源作品占比较高，想改造成团队内部工具的可以直接拿源码。挑的时候留意卡片上的「开源附源码」和「浏览器即用」两个标注，基本能覆盖你的两种使用姿势。',
  '自媒体工具': '写公众号、发小红书、剪短视频、做封面图……这一类工具专门服务内容运营的各个环节：标题起名、封面制作、数据看板、评论区管理。挑的时候按你最花时间的那个环节找，不要一次装一整套。带 Web 版的可以先免费用起来，觉得离不开再支持作者。点开卡片能看到实际效果截图，比看功能列表直观得多。',
  '音乐媒体': '在线电台、白噪音、播客客户端、乐谱工具……这一类适合想「边做别的边听点什么」的人。白噪音和电台类的多数支持浏览器直接打开，配合学习或工作场景刚好；播客类的留意有没有订阅功能，能不能记住播放进度。卡片上有试听入口的先点进去听两分钟，再决定收不收藏。',
  '手工 DIY': '折纸图解、编织图谱、手工教程、材料清单管理……这一类作品面向喜欢动手做实物的人。多数是图文教程或者辅助设计的小工具（比如纸模型展开图、串珠配色器）。挑的时候留意教程是否分步骤、有没有材料清单，做的时候照着一步步来成功率更高。如果你自己也在写教程，欢迎投稿分享出来。',
  '亲子时光': '给家长和孩子一起用的东西：识字卡、涂色模板、亲子游戏、成长记录……这一类的共同点是大人孩子能一起上手，不需要孩子自己操作复杂界面。挑的时候注意适龄标注和是否需要打印，部分作品支持直接导出图片去打印店。睡前十分钟、周末下午茶，都是这些小玩意的好场景。',
  '刷题网站': '面向算法面试、考证刷题的在线题库：按标签分类、记录错题、模拟考试。挑选时重点看三件事：题库是否持续更新、有没有你目标方向的专项标签、是否支持记住做题进度。多数支持浏览器直接打开，注册成本很低，建议先用浏览器版试刷一周再决定要不要深入。配合本站「学习教育」分类的时间管理工具效果更好。',
  '悠闲放松': '白噪音、呼吸练习、电子宠物、减压小游戏……这一类没有 KPI，纯粹为了让你歇口气。全部免安装，点开即用，适合工作间隙两分钟或者睡前放松。挑的时候不用纠结功能对比，看着顺眼就点进去试，不喜欢就换下一件。这一类里藏着不少独立开发者的小情趣，值得慢慢翻。',
  '玄学占卜': '塔罗、运势、抽签、解梦……这一类是娱乐向的电子小占卜，图个乐子和仪式感，请理性看待结果，重要决策还是靠你自己。多数支持浏览器直接打开，抽完还能分享给朋友一起玩。界面和文案的用心程度差别挺大，点开卡片看截图，挑个你喜欢的画风。',
  '广播播客': '中文播客客户端、电台聚合、音频剪辑……这一类适合播客听众和想自己做节目的人。听众侧重点看订阅管理和播放进度同步；创作者侧可以找录音、降噪、剪辑的小工具。多数带 Web 版，先试再收藏。通勤和做家务是最典型的使用场景，手机端配合小程序版更顺手。',
  '众言社区': '留言墙、许愿板、匿名树洞……这一类作品的共同点是「大家都能写一句」，适合活动暖场、团队破冰或者个人主页的访客留言板。多数开源，想给自己项目加个留言板的可以直接部署源码。作为访客，点进去写两句支持作者也是很好的玩法。',
  '个人站': '别人做出来的个人主页、作品集、博客和数字花园。逛这一类的乐趣是看看别人怎么介绍自己、怎么组织自己的内容，顺便偷师排版和栏目设计。不少作者把自己的建站过程写在站里，想搭自己主页的话，先逛几个再动手，能少走很多弯路。部分作品开源，模板可以直接抄作业。',
  '日常办公': '会议纪要、周报生成、PDF 处理、Excel 小工具……这一类瞄准的是每天都要重复的办公动作。挑选思路和效率工具类似，但更看重「稳定不折腾」：优先选浏览器直开、不需要上传敏感文件的，涉及公司数据的谨慎使用在线版。点开卡片看演示截图，确认流程和你的一致再收藏。',
  '导航': '程序员导航、设计师导航、学习资源导航……这一类是「站中站」，把某个领域的常用网站按板块整理好。挑选时看两点：收录是否还在更新（死链多的直接跳过）、板块划分是否符合你的使用习惯。建议只收藏一两枚最合你口味的，别囤一排导航站。',
  '户外运动': '骑行路线、徒步记录、装备清单、天气窗口查询……这一类服务跑步、骑行、徒步、露营爱好者。多数需要配合手机使用，标注了小程序版的扫码就能进，户外场景下不用专门装 App。出发前记得确认作品的定位权限要求，只把定位交给信得过的作者。'
};
const TYPE_INTROS = {
  'Web': '这一页收的都是打开浏览器就能用的作品：不用下载、不用注册（大部分），网址点开就是全部功能。桌面和手机都能访问，适合先白嫖再决定要不要收藏。缺点是依赖网络，离线场景还是得找客户端版。',
  'iOS': '这一页收的是有苹果端的作品，多数同时提供网页版作为轻量替代。App Store 上架的会标注跳转方式，TestFlight 内测的记得看作者说明。iPhone 用户可以配合「小程序」筛选，很多作品两种入口都有。',
  'Android': '这一页收的是支持安卓端的作品：有的是 APK 直装，有的上架了应用商店，也有的用小程序替代了原生 App。安装前留意卡片说明里的来源渠道，尽量从作者指定的渠道下载。手机用户也可以先逛「小程序」页，即点即用不用安装。',
  'macOS': '这一页收的是 Mac 上好用的作品：菜单栏工具、原生应用、brew 可装的命令行小玩意。Mac 软件普遍收费比例高一些，卡片上有「开源」标注的可以先自己编译白嫖。配合「浏览器插件」和「cli 命令行工具」两个页面能凑齐一套工作流。',
  'Windows': '这一页收的是 Windows 桌面端的作品：效率小工具、桌面客户端、绿色免安装版。下载时留意位数和运行库要求，标注「开源」的可以自己构建。没有合适桌面版的，不妨先看看同作品的 Web 版能不能顶上。',
  'Linux': '这一页收的是 Linux 用户能用上的作品：自托管服务、命令行工具、开源桌面应用。多数开源且提供部署文档，适合有服务器或者爱折腾终端的用户。配合「API」和「cli 命令行工具」页面食用更佳。',
  '小程序': '这一页收的都是微信小程序，扫码或者点卡片里的码就能直接用，不用下载安装。适合把高频小工具放进微信里随用随开：查个东西、记一笔、跟朋友开一局。注意小程序的体验入口在本站卡片右侧的「小程序码」，长按识别即可。',
  '浏览器插件': '这一页收的是 Chrome / Edge 扩展：划词翻译、截图贴边、标签页管理、购物比价……装完就长在浏览器里，是提升 browsing 体验最直接的品类。安装时从卡片说明给的官方渠道进，留意权限申请是否克制。配合「Web」页一起逛，基本能武装好你的浏览器。',
  '机器人': '这一页收的是聊天机器人和自动化 bot：微信机器人、QQ bot、Telegram bot。这类作品需要按作者说明接入，使用门槛略高，但自动化收益也大。挑之前确认你用的聊天平台对得上，再看维护频率——bot 类作品弃坑率高，选最近还在更新的。',
  'API': '这一页收的是提供开放接口的作品和服务：天气查询、翻译、短链生成。适合开发者直接接进自己的项目里，卡片上标注了文档地址和是否需要密钥。调用前看清楚限流政策，开源的可以自己部署一份避开配额。',
  'cli 命令行工具': '这一页收的是终端党的最爱：一行命令解决一个问题的 cli 工具。多数开源、支持 brew / npm / cargo 安装，卡片上有安装命令示例。适合把高频操作（格式转换、文件处理、git 辅助）固化成肌肉记忆，配合 shell alias 效率翻倍。'
};
function composeListIntro(kind, name, pool) {
  const isCat = kind === 'c';
  if (!pool.length) {
    return isCat
      ? `「${name}」分类现在还没有已上架的作品。欢迎你来投稿补上第一件：提交后审核通过即可展示在这里，本页也会随新作品持续更新。`
      : `还没有支持「${name}」形态的作品上架。如果你的作品支持这个形态，欢迎投稿，审核通过后就会出现在这一页。`;
  }
  const openSource = pool.filter(w => w.openSource === true).length;
  const webCount = pool.filter(w => typesOf(w).includes('Web')).length;
  const bits = [isCat ? `「${name}」分类现有 ${pool.length} 件通过人工审核的作品` : `现有 ${pool.length} 件支持「${name}」形态、通过人工审核的作品`];
  if (openSource) bits.push(`其中 ${openSource} 件开源附源码，想改造或自己部署的可以直接拿源码`);
  if (webCount) bits.push(`${webCount} 件在浏览器里就能直接打开`);
  return bits.join('，') + '。点开卡片能看到截图、介绍和访客反馈，收藏前先试再决定；觉得哪件好用，回卡片区给作者点个赞，比什么都鼓励人。';
}

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
    // title/desc 用搜索者视角的长尾措辞（搜的是「免费效率工具」不是「效率工具类作品」），
    // h1/label 维持站内口径不动，页面结构与 FAQ 文案不受影响。数字仍全部取自真实统计。
    // 「效率工具」「开发工具」这类名字自带「工具」二字，拼词前先去掉，避免「工具工具」。
    const noun = name.endsWith('工具') ? name.slice(0, -2) : name;
    // title 补上「附开源标注与直达链接」这类差异化卖点，把 27~31 字的短标题拉进 30-60 的理想区间
    const title = kind === 'c'
      ? `免费${noun}工具推荐 · ${pool.length} 件在线作品合集${pageSuffix}（附开源标注与直达链接） - ${seo.SITE_NAME}`
      : `${name} 平台作品推荐 · ${pool.length} 件精选合集${pageSuffix}（附体验直达） - ${seo.SITE_NAME}`;
    // 描述里放站内真实统计，不再让 27 个聚合页共用一句换词模板；末尾补审核与直达口径，拉进 70-160 字区间
    const descAudit = '本页作品全部经过人工审核，点开卡片即可直达体验。';
    const topTitles = pool.slice(0, 3).map(w => w.title).join('、');
    const desc = kind === 'c'
      ? truncateText(
        `收录 ${pool.length} 件免费好用的${name}类作品，` +
        `其中 ${facts.openSource} 件开源附源码、${facts.webCount} 件打开浏览器即用；` +
        `包含 ${topTitles} 等，持续更新。${descAudit}`, 160)
      : truncateText(
        `精选 ${pool.length} 件支持${name}形态的独立开发作品，${facts.openSource} 件开源、` +
        `${facts.miniCount} 件同时提供微信小程序版；包含 ${topTitles} 等，持续更新。${descAudit}`, 160);

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
      // 编辑导语：优先用人工写的分段，没写到的分类/形态用真实统计兜底
      intro: (kind === 'c' ? CATEGORY_INTROS[name] : TYPE_INTROS[name]) || composeListIntro(kind, name, pool),
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
// shareBase：海报/复制链接固定印的正式站点根地址。故意不取 req 的 host——
// 本地预览时海报若印 localhost，转发出去对方打不开；站点上线换域名时改 SITE_URL 即可。
const INVITE_SHARE_BASE = (process.env.SITE_URL || 'https://idea.v5pc.com').replace(/\/+$/, '');
const invitePage = require('./invite-page.js');
app.get('/invite', (req, res) => {
  const list = visibleWorks();
  const authorSet = new Set();
  list.forEach(w => { if (w.anonymous !== true && w.author) authorSet.add(w.author); });
  const page = invitePage.render({
    seo,
    base: seo.baseUrl(req),
    shareBase: INVITE_SHARE_BASE,
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
  // 精选专栏：总览 + 每个类目一页（站方编辑内容，独立于作品库）
  const col = columnsData();
  const extraUrls = [
    { loc: '/column', lastmod: col.updatedAt, priority: '0.8', changefreq: 'weekly' },
    // 开源好物：站外收录页，随内容文件更新
    { loc: '/open', lastmod: openSource.list().updatedAt, priority: '0.7', changefreq: 'weekly' },
    // 企业产品入驻：公开的入驻说明页（不是价目表，可以进索引，让公司自己搜得到）
    { loc: '/enterprise', lastmod: '', priority: '0.6', changefreq: 'monthly' },
    ...col.topics.map(t => ({
      loc: '/column/' + t.slug, lastmod: t.updatedAt || col.updatedAt, priority: '0.7', changefreq: 'monthly'
    }))
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(
    seo.sitemapXml(base, {
      works: all,
      categories,
      types,
      authors,
      siteUpdated: all[0] ? all[0].createdAt : '',
      categoryLastmod,
      typeLastmod,
      extraUrls
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
    `- 精选专栏（站方编辑挑的软件）：${base}/column`,
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
  res.send(devEnv.injectInto(withAssetVer(html)));
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

// 全局错误兜底：任何路由抛错都留痕 + 返回友好提示，绝不把堆栈吐给用户
app.use((err, req, res, next) => {
  // 4xx（body 过大、JSON 格式错）是客户端问题，别当故障报警；5xx 才是要盯的
  const status = Number(err && (err.status || err.statusCode)) || 500;
  // 5xx 记全栈（要排查），4xx 只记一行（多半是爬虫/脚本发的畸形请求，别把日志刷满）
  logLine('error.log', `${status} ${req.method} ${req.originalUrl} -> ${status >= 500 ? errText(err) : ((err && err.message) || String(err))}`);
  if (status >= 500) console.error('[route error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  const msg = status >= 500 ? '服务器开小差了，请稍后再试' : '请求有误，请检查后重试';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
  res.status(status).type('text/plain; charset=utf-8').send(msg);
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

// 积分兑换广告巡检：曝光额度投完 / 到 7 天兜底线 → 自动下线
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

app.listen(PORT, '0.0.0.0', () => {
  // 所有带缓冲的写盘变量到这里都已初始化，注册退出钩子才安全（见文件顶部 flushPendingWrites）
  installFlushHooks();
  console.log(`造梦橱窗已启动: http://localhost:${PORT}  (审核模式: ${REVIEW_MODE ? '开' : '关'})`);
  // 老数据补关键词：keywords 字段还不存在的作品，按标题 / 简介 / 分类自动配一份写回 works.json。
  // 上线即生效，不用手工跑迁移脚本；作者手动删空（keywords: []）的作品不会被反复填回来。
  try {
    let n = 0;
    works.forEach(w => {
      if (!Array.isArray(w.keywords)) { w.keywords = autoKeywords({ title: w.title, prompt: w.prompt, categories: catsOf(w), types: typesOf(w) }); n++; }
    });
    if (n) { saveWorks(); console.log(`[keywords] 为 ${n} 件老作品补了搜索关键词`); }
  } catch (e) { console.warn('[keywords] 老数据补关键词失败:', e.message); }
  // 草稿过期清理：30 天没动过的草稿连同图片一起删（启动跑一次，量小不必上定时器）
  try { pruneDrafts(); } catch (e) { console.warn('[drafts] 过期清理失败:', e.message); }
  // 编年史公告：老用户一次性补推（key 去重，重启不重复打扰）
  try { broadcastChronicleOnce(); } catch (e) { console.warn('[notices] 编年史公告推送失败:', e.message); }
  try { broadcastLaunchAnnounceOnce(); } catch (e) { console.warn('[notices] 上线通告推送失败:', e.message); }
  // 编年史公告：补发到游客公告条（未登录访客也看得到，key 去重）
  try { seedChronicleGuestOnce(); } catch (e) { console.warn('[notices] 编年史游客公告补发失败:', e.message); }
  try { seedLaunchGuestOnce(); } catch (e) { console.warn('[notices] 上线通告游客补发失败:', e.message); }
});
