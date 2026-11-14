/**
 * 开源好物（/open）：站外 GitHub 项目的外链定向页。
 *
 * 定位：和「/column 精选专栏」区分开——专栏是站内收录的软件作品，这一页是站外开源项目，
 * 只放名字 / 一句中文介绍 / 语言 / 许可证 / GitHub 外链，不搬运 README、不搬截图、不进作品池，
 * 也不参与榜单和灯火。它不是「作品」，所以刻意没有点赞、收藏、评论。
 *
 * 数据分两层：
 *   content/open-source.json  —— 人工维护的内容（名字、中文描述、分类、许可），进仓库、随部署走；
 *   data/open-source-cache.json —— 运行时缓存（star 数、API 回填的许可证），不进仓库，丢了自动重建。
 * 这样每天刷 star 不会把仓库搞脏，部署包里也不会带一份过期的星标。
 *
 * 星标刷新：GitHub 未认证接口 60 次/小时，27 个项目一次刷完还剩一半额度，够用；
 * 刷新失败（国内服务器连不上 / 限流）一律静默保留旧值，页面照样能开——星标只是锦上添花，
 * 不能因为它把整页拖挂。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONTENT_FILE = path.join(__dirname, 'content', 'open-source.json');
const CACHE_FILE = path.join(__dirname, 'data', 'open-source-cache.json');
// 访客提交队列：和缓存一样放 data（不进仓库、部署排除），线上那份由服务自己维护。
// 记录量很小（一条几十字节），封顶 300 条防被灌爆。
const SUBMIT_FILE = path.join(__dirname, 'data', 'open-source-submits.json');
const SUBMIT_MAX = 300;
// 分类：内置 5 类兜底，自定义分类存 content/open-cats.json（进仓库、随部署走）。
// 投稿弹窗里选「＋ 新建分类」产生的分类随审核生效：star>500 自动收录当场建，
// 进人工队列的要等站长点「收录」才创建——防访客把垃圾分类名刷到公开页面上。
const CATS_FILE = path.join(__dirname, 'content', 'open-cats.json');
const CAT_MAX = 24;          // 分类总数上限，防刷
const CAT_NAME_MAX = 20;     // 分类名长度
const CAT_HINT_MAX = 40;    // 一句说明长度
// star 超过这个数自动收录，不用站长过；站长 2026-11-12 定档
const AUTO_STAR = 500;
const REFRESH_GAP = 20 * 3600 * 1000; // 20 小时，留 4 小时余量，一天刷一次不会因为抖动漏天
const PER_REQUEST_TIMEOUT = 7000;
const CONCURRENCY = 4;

// 内置分类。顺序就是页面筛选条的顺序：从「装在自己机器上」到「持续挖新东西」，读者动线由近及远。
// 内置 id 永远不会被删（cat-del 只认 custom:true），文件损坏丢了也会在这里补回。
const BASE_CATS = [
  { id: 'app', name: '装在自己机器上', hint: '下载安装，本地跑' },
  { id: 'self', name: '自己搭起来', hint: '一台服务器、一个 Docker' },
  { id: 'web', name: '打开就能用', hint: '不用装，浏览器里' },
  { id: 'build', name: '建站与前端', hint: '做站的人用得上' },
  { id: 'source', name: '选题来源', hint: '持续挖新东西的地方' }
];
const BASE_IDS = new Set(BASE_CATS.map(c => c.id));

/** 分类清单：open-cats.json 存在就用它（缺了内置 id 会补回），否则退回内置 5 类 */
function loadCats() {
  const d = readJsonFile(CATS_FILE, null);
  if (d && Array.isArray(d.list)) {
    const list = d.list
      .filter(c => c && c.id && c.name)
      .map(c => ({
        id: String(c.id).slice(0, 24),
        name: String(c.name).slice(0, CAT_NAME_MAX),
        hint: String(c.hint || '').slice(0, CAT_HINT_MAX),
        custom: c.custom === true
      }));
    BASE_CATS.forEach(b => { if (!list.some(c => c.id === b.id)) list.push({ ...b }); });
    if (list.length) return list;
  }
  return BASE_CATS.map(c => ({ ...c }));
}
function saveCats(list) {
  return writeJsonFile(CATS_FILE, { list });
}
/**
 * 找同名分类或新建一个。同名复用（幂等），不重复建。
 * 返回 { cat: id, created } 或 { error }，写入失败不静默。
 */
function ensureCat(name, hint) {
  const n = String(name || '').trim().slice(0, CAT_NAME_MAX);
  if (!n) return { error: '分类名称必填' };
  const cats = loadCats();
  const found = cats.find(c => c.name === n);
  if (found) return { cat: found.id, created: false, cats };
  if (cats.length >= CAT_MAX) return { error: `分类已有 ${cats.length} 个，达到上限了` };
  let i = cats.length + 1;
  let id = 'c' + i;
  while (cats.some(c => c.id === id)) { i++; id = 'c' + i; }
  const cat = { id, name: n, hint: String(hint || '').trim().slice(0, CAT_HINT_MAX), custom: true };
  cats.push(cat);
  if (!saveCats(cats)) return { error: '写入分类失败' };
  return { cat: id, created: true, cats };
}

// 语言色点：只收常见语言，没有就退成灰点（不猜）
const LANG_COLOR = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Go: '#00add8', Python: '#3572a5',
  Rust: '#dea584', PHP: '#4f5d95', Dart: '#00b4ab', Vue: '#41b883', Svelte: '#ff3e00',
  Java: '#b07219', Ruby: '#701516', 'C#': '#178600', 'C++': '#f34b7d', C: '#555555',
  Shell: '#89e051', Clojure: '#db5855', HTML: '#e34c26', Swift: '#f05138', Kotlin: '#a97bff'
};
// 许可证分档：宽松（能拿去商用）/ copyleft（改了就得分源）/ 未知
const PERMISSIVE = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|MPL-2\.0|Unlicense|0BSD|CC0-1\.0)$/i;
const COPYLEFT = /^(GPL|AGPL|LGPL)/i;

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.warn('[open] 落盘失败：' + e.message);
    return false;
  }
}

/** 内容层：人工维护的项目清单 */
function loadContent() {
  const d = readJsonFile(CONTENT_FILE, null);
  if (!d || !Array.isArray(d.items)) return { intro: '', updatedAt: '', items: [] };
  return {
    intro: String(d.intro || ''),
    updatedAt: String(d.updatedAt || ''),
    items: d.items.filter(it => it && it.repo && it.name)
  };
}
function saveContent(d) {
  return writeJsonFile(CONTENT_FILE, {
    intro: d.intro || '',
    updatedAt: d.updatedAt || '',
    items: (d.items || []).map(it => ({
      repo: it.repo, name: it.name, cat: it.cat || 'web',
      lang: it.lang || '', license: it.license || '', desc: it.desc || ''
    }))
  });
}

/** 缓存层：star / 真实许可证，key 是 repo 全名 */
function loadCache() {
  const c = readJsonFile(CACHE_FILE, {}) || {};
  return (c && typeof c === 'object') ? c : {};
}

/** 提交队列：前台弹窗提交的待审 / 已处理记录 */
function loadSubmits() {
  const d = readJsonFile(SUBMIT_FILE, []) || [];
  return Array.isArray(d) ? d : [];
}
function saveSubmits(list) {
  return writeJsonFile(SUBMIT_FILE, list.slice(-SUBMIT_MAX));
}
function pendingSubmitCount() {
  return loadSubmits().filter(s => s && s.status === 'pending').length;
}

/** 仓库输入归一：接受完整链接 / owner/repo，返回合法全名，不合法返回空串 */
function normalizeRepo(input) {
  let repo = String(input || '').trim();
  if (!repo) return '';
  repo = repo.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^github\.com\//i, '');
  repo = repo.split(/[?#]/)[0].replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = repo.match(/^([\w.-]+)\/([\w.-]+)/); // 只取前两段，/tree/main 这类尾巴直接丢
  return m ? m[1] + '/' + m[2] : '';
}

/**
 * 把一个仓库收进内容清单（自动收录和后台「收录」共用这一条路）：
 * 去重 → 拉一次 GitHub 回填语言 / 许可证 / star → 落 content + cache。
 * 返回 { ok, item, star } 或 { error }，永不 reject。
 */
async function addToContent(repo, meta = {}) {
  const data = loadContent();
  if (data.items.some(it => it.repo.toLowerCase() === String(repo).toLowerCase())) {
    return { error: '这个仓库已经收录过了' };
  }
  const info = await ghRepo(repo);
  if (info.error === 'http404') return { error: 'GitHub 上找不到这个仓库（私有仓库也收不了）' };
  const item = {
    repo,
    name: String(meta.name || '').trim() || repo.split('/')[1],
    cat: loadCats().some(c => c.id === meta.cat) ? meta.cat : 'web',
    lang: '',
    license: '',
    desc: String(meta.desc || '').trim()
  };
  if (!info.error) {
    item.lang = info.lang || '';
    item.license = info.license === 'NOASSERTION' ? '' : (info.license || '');
    const cache = loadCache();
    cache[repo] = { star: info.star, license: item.license, lang: item.lang, at: Date.now() };
    writeJsonFile(CACHE_FILE, cache);
  }
  data.items.push(item);
  data.updatedAt = new Date().toISOString().slice(0, 10);
  if (!saveContent(data)) return { error: '写入收录清单失败' };
  return { ok: true, item, star: info.star || 0 };
}

/** 内容 + 缓存合并成页面用的结构 */
function list() {
  const data = loadContent();
  const cache = loadCache();
  return {
    intro: data.intro,
    updatedAt: data.updatedAt,
    items: data.items.map(it => {
      const c = cache[it.repo] || {};
      // GitHub 的 licensee 认不出的许可会返回 NOASSERTION（Motrix 这种手写 MIT、Lucide 的 ISC 都是），
      // 这时要退到人工填的值，不能当成「没有许可证」把标签抹掉。
      const apiLic = String(c.license || '');
      const license = (apiLic && apiLic !== 'NOASSERTION') ? apiLic : String(it.license || '');
      return {
        ...it,
        license,
        lang: it.lang || c.lang || '',
        star: Number(c.star) > 0 ? Number(c.star) : 0,
        starAt: c.at || 0
      };
    })
  };
}

/** GitHub 单个仓库：只取星标 / 许可证 / 主语言，7 秒超时，永不 reject */
function ghRepo(repo) {
  return new Promise(resolve => {
    let req;
    try {
      req = https.request({
        host: 'api.github.com',
        path: '/repos/' + repo.split('/').map(encodeURIComponent).join('/'),
        method: 'GET',
        headers: {
          'User-Agent': 'dream-case-open-list',
          'Accept': 'application/vnd.github+json'
        },
        timeout: PER_REQUEST_TIMEOUT
      }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { if (raw.length < 200000) raw += chunk; });
        res.on('end', () => {
          // 403/429 = 打爆额度了，本轮直接停，别继续无效请求
          if (res.statusCode === 403 || res.statusCode === 429) return resolve({ error: 'rate' });
          if (res.statusCode !== 200) return resolve({ error: 'http' + res.statusCode });
          try {
            const j = JSON.parse(raw);
            resolve({
              star: Number(j.stargazers_count) || 0,
              license: (j.license && j.license.spdx_id) || '',
              lang: j.language || ''
            });
          } catch {
            resolve({ error: 'json' });
          }
        });
      });
    } catch (e) {
      return resolve({ error: 'net' });
    }
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', () => resolve({ error: 'net' }));
    req.end();
  });
}

let refreshing = null;

/**
 * 刷新星标。force=true 时忽略时间间隔（后台手动刷新用）。
 * 返回 { ok, updated, failed, skipped }，永不 reject。
 */
function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const data = loadContent();
    const cache = loadCache();
    const now = Date.now();
    const todo = data.items
      .map(it => it.repo)
      .filter(repo => force || !cache[repo] || !cache[repo].at || now - cache[repo].at > REFRESH_GAP);
    if (!todo.length) return { ok: true, updated: 0, failed: 0, skipped: 'fresh' };

    let updated = 0, failed = 0, rateLimited = false;
    const queue = todo.slice(0, 40); // 单轮上限，避免一次把额度吃光
    const worker = async () => {
      while (queue.length && !rateLimited) {
        const repo = queue.shift();
        const out = await ghRepo(repo);
        if (out.error === 'rate') { rateLimited = true; failed++; return; }
        if (out.error) { failed++; continue; }
        cache[repo] = { star: out.star, license: out.license, lang: out.lang, at: Date.now() };
        updated++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    if (updated) writeJsonFile(CACHE_FILE, cache);
    if (failed) console.warn(`[open] 星标刷新：成功 ${updated}，失败 ${failed}${rateLimited ? '（额度用尽）' : ''}`);
    return { ok: true, updated, failed, skipped: rateLimited ? 'rate' : '' };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** 启动后延迟跑一次：把并发让给首屏，别跟页面渲染抢带宽 */
function scheduleRefresh(delay = 45000) {
  setTimeout(() => { refresh().catch(() => {}); }, delay).unref?.();
}

function fmtStar(n) {
  if (!n || n < 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function hueOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const OSS_CSS = `
.oss-wrap { padding-bottom: 8px; }
.oss-hero { padding: 26px 0 2px; max-width: 800px; }
.oss-kicker {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; letter-spacing: .06em; color: #6f5fd0;
  background: #f4f2ff; border: 1px solid #e5e0ff; border-radius: 999px; padding: 4px 12px;
}
.oss-kicker svg { width: 13px; height: 13px; }
.oss-hero h1 { font-size: 30px; letter-spacing: -.4px; margin: 14px 0 10px; line-height: 1.25; }
.oss-sub { font-size: 14.5px; line-height: 1.85; color: #4a5164; }
.oss-stats { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 18px; margin-top: 14px; font-size: 12.5px; color: var(--muted); }
.oss-stats b { color: var(--text); font-weight: 600; font-size: 15px; margin-right: 3px; }
.oss-stats i { font-style: normal; opacity: .45; }
/* 筛选条：不吸顶，跟着内容滚走——这一页是靠"一条条看"的，没有反复切分类的需要 */
.oss-filter { display: flex; flex-wrap: wrap; gap: 8px; padding: 20px 0 16px; }
.oss-chip {
  font: inherit; font-size: 13px; line-height: 1; color: #4b5563; background: #fff;
  border: 1px solid var(--border); border-radius: 999px; padding: 8px 14px; cursor: pointer;
  transition: color .16s, border-color .16s, background .16s;
}
.oss-chip:hover { border-color: #c9c7f0; color: var(--primary); }
.oss-chip.is-on { background: var(--primary); border-color: var(--primary); color: #fff; }
.oss-chip em { font-style: normal; opacity: .55; margin-left: 5px; font-size: 11.5px; }
.oss-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.oss-card {
  position: relative; display: flex; flex-direction: column;
  background: #fff; border: 1px solid var(--border); border-radius: 16px; padding: 16px 16px 12px;
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}
.oss-card[hidden] { display: none; }
.oss-card::before {
  content: ''; position: absolute; left: 16px; right: 16px; top: 0; height: 2px; border-radius: 0 0 2px 2px;
  background: linear-gradient(90deg, #8a7bd8, #c79bf0); opacity: 0; transition: opacity .18s;
}
.oss-card:hover { transform: translateY(-2px); border-color: #d3d1f5; box-shadow: 0 12px 26px -16px rgba(91,91,214,.5); }
.oss-card:hover::before { opacity: 1; }
.oss-top { display: flex; align-items: flex-start; gap: 10px; }
.oss-ava {
  flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px;
  display: grid; place-items: center; font-size: 15px; font-weight: 700; line-height: 1;
  background: linear-gradient(140deg, hsl(var(--h) 70% 97%), hsl(var(--h) 60% 89%));
  color: hsl(var(--h) 45% 38%); border: 1px solid hsl(var(--h) 45% 89%);
}
.oss-title { flex: 1; min-width: 0; padding-top: 1px; }
.oss-title h3 {
  font-size: 15px; font-weight: 600; line-height: 1.35; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.oss-repo {
  display: block; margin-top: 3px; font-size: 11.5px; line-height: 1.4; color: #9aa0b3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.oss-lic {
  flex: 0 0 auto; font-size: 10.5px; font-weight: 600; letter-spacing: .01em;
  border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; line-height: 1; margin-top: 2px;
}
.oss-lic.is-perm { color: #0d7a55; background: #e9f8f1; border-color: #c8ecdd; }
.oss-lic.is-left { color: #93610f; background: #fff7e7; border-color: #f3e2bd; }
.oss-lic.is-other { color: #6b7280; background: #f4f5f8; border-color: #e6e8f0; }
.oss-desc { flex: 1; margin: 11px 0 12px; font-size: 13px; line-height: 1.8; color: #4d5566; }
.oss-foot {
  display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 10px;
  border-top: 1px dashed #eef0f6; font-size: 11.5px; color: var(--muted);
}
.oss-lang { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.oss-lang i {
  width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.14);
}
.oss-star { color: #8b7561; white-space: nowrap; }
.oss-go {
  margin-left: auto; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;
  font-size: 12px; font-weight: 600; color: var(--primary); text-decoration: none;
}
.oss-go:hover { text-decoration: underline; }
.oss-empty { padding: 40px 0 24px; text-align: center; font-size: 13.5px; color: var(--muted); }
/* 提交收录入口 + 弹窗 */
.oss-cta-row { margin-top: 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.oss-cta {
  font: inherit; font-size: 13px; font-weight: 600; line-height: 1; cursor: pointer;
  color: #fff; background: var(--primary); border: 1px solid var(--primary);
  border-radius: 999px; padding: 10px 20px; transition: filter .16s;
}
.oss-cta:hover { filter: brightness(1.1); }
.oss-cta-hint { font-size: 12px; color: var(--muted); }
.oss-linkbtn {
  background: none; border: none; padding: 0; font: inherit; font-size: 12.5px;
  color: var(--primary); cursor: pointer; text-decoration: underline;
}
.oss-modal { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; }
.oss-modal[hidden] { display: none; }
.oss-mask { position: absolute; inset: 0; background: rgba(24, 26, 40, .45); }
.oss-dialog {
  position: relative; width: 100%; max-width: 460px; max-height: 86vh; overflow: auto;
  background: #fff; border-radius: 16px; padding: 22px 20px 18px;
  box-shadow: 0 24px 60px -20px rgba(30, 30, 80, .4);
}
.oss-dialog h3 { font-size: 17px; margin: 0 0 6px; }
.oss-modal-sub { font-size: 12.5px; color: var(--muted); line-height: 1.7; margin: 0 0 14px; }
.oss-field { display: block; margin-bottom: 12px; }
.oss-field > span { display: flex; align-items: baseline; gap: 6px; font-size: 12.5px; font-weight: 600; color: #3d4356; margin-bottom: 6px; }
.oss-field > span i { font-style: normal; font-size: 11px; font-weight: 600; color: #b03030; }
.oss-field > span em { font-style: normal; font-size: 11px; font-weight: 400; color: var(--muted); }
.oss-field input, .oss-field textarea, .oss-field select {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13.5px; color: var(--text);
  background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px;
}
.oss-field textarea { resize: vertical; min-height: 60px; }
.oss-field input:focus, .oss-field textarea:focus, .oss-field select:focus {
  outline: none; border-color: #a9a0e8; box-shadow: 0 0 0 3px rgba(122, 108, 220, .12);
}
.oss-err {
  margin: 0 0 12px; font-size: 12.5px; line-height: 1.6; color: #b03030;
  background: #fdf1f1; border: 1px solid #f2d4d4; border-radius: 8px; padding: 8px 10px;
}
.oss-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.oss-btn {
  font: inherit; font-size: 13px; font-weight: 600; line-height: 1; cursor: pointer;
  border-radius: 999px; padding: 10px 18px; border: 1px solid var(--border); background: #fff; color: #4b5563;
}
.oss-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.oss-btn:disabled { opacity: .6; cursor: default; }
.oss-done { text-align: center; padding: 10px 0 2px; }
.oss-done b { font-size: 15px; }
.oss-done p { font-size: 12.5px; color: var(--muted); line-height: 1.7; margin: 8px 0 14px; }
@media (max-width: 640px) {
  .oss-cta-row { margin-top: 14px; }
  .oss-dialog { padding: 18px 16px 14px; }
}
.oss-rule {
  max-width: 860px; margin: 28px 0 0; padding: 16px 18px;
  background: #fbfbfe; border: 1px solid var(--border); border-radius: 14px;
}
.oss-rule h2 { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.oss-rule ol { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.95; color: #5c6373; }
.oss-rule b { color: var(--text); font-weight: 600; }
.oss-rule a { color: var(--primary); text-decoration: none; }
.oss-rule a:hover { text-decoration: underline; }
@media (max-width: 900px) { .oss-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .oss-hero { padding-top: 18px; }
  .oss-hero h1 { font-size: 23px; margin: 12px 0 8px; }
  .oss-sub { font-size: 13.5px; line-height: 1.8; }
  .oss-stats { gap: 4px 14px; font-size: 12px; margin-top: 12px; }
  .oss-filter { gap: 6px; padding: 16px 0 12px; }
  .oss-chip { font-size: 12.5px; padding: 7px 12px; }
  .oss-grid { grid-template-columns: 1fr; gap: 10px; }
  .oss-card { padding: 14px 14px 11px; border-radius: 14px; }
  .oss-desc { font-size: 12.8px; line-height: 1.75; margin: 9px 0 10px; }
}
`;

/** 单张卡片 */
function cardHtml(it, cats) {
  const cat = (cats || loadCats()).find(c => c.id === it.cat);
  const initial = (it.name || it.repo || '?').trim().charAt(0).toUpperCase();
  const hue = hueOf(it.repo);
  const lic = it.license || '';
  const licClass = !lic ? '' : PERMISSIVE.test(lic) ? 'is-perm' : COPYLEFT.test(lic) ? 'is-left' : 'is-other';
  const langColor = LANG_COLOR[it.lang] || '#c3c8d4';
  const star = fmtStar(it.star);
  return `<article class="oss-card" data-cat="${it.cat || 'web'}">
        <div class="oss-top">
          <span class="oss-ava" style="--h:${hue}" aria-hidden="true">${esc(initial)}</span>
          <div class="oss-title">
            <h3>${esc(it.name)}</h3>
            <span class="oss-repo">${esc(it.repo)}</span>
          </div>
          ${lic ? `<span class="oss-lic ${licClass}" title="许可证：${esc(lic)}">${esc(lic)}</span>` : ''}
        </div>
        <p class="oss-desc">${esc(it.desc)}</p>
        <div class="oss-foot">
          ${it.lang ? `<span class="oss-lang"><i style="background:${langColor}"></i>${esc(it.lang)}</span>` : `<span class="oss-lang"><i style="background:${langColor}"></i>${cat ? esc(cat.name) : ''}</span>`}
          ${star ? `<span class="oss-star" title="GitHub 星标，每天刷新">★ ${star}</span>` : ''}
          <a class="oss-go" href="https://github.com/${esc(it.repo)}" target="_blank" rel="noopener noreferrer nofollow">GitHub ↗</a>
        </div>
      </article>`;
}

let esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 注册路由。依赖由 server.js 注入（seo / shell / sendHtml / requireAdmin），
 * 这样本模块不反向 require server.js，也就不用改动 server.js 的任何内部结构。
 */
function register(app, deps) {
  const { seo, shell, sendHtml, requireAdmin } = deps;
  // server.js 注入的限流 / 取 IP；没传就放行（本地测试不至于被限流卡住）
  const rateLimit = deps.rateLimit || (() => true);
  const clientIp = deps.clientIp || (() => 'unknown');
  esc = seo.esc;

  app.get('/open', (req, res) => {
    const base = seo.baseUrl(req);
    const data = list();
    const cats = loadCats();
    const items = data.items;
    const withStar = items.filter(it => it.star > 0);
    const lastAt = withStar.reduce((m, it) => Math.max(m, it.starAt || 0), 0);
    const lastStr = lastAt
      ? new Date(lastAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
      : '';
    const dayStr = data.updatedAt ? String(data.updatedAt).slice(0, 10).replace(/-/g, '.') : '';
    const countOf = id => items.filter(it => it.cat === id).length;

    const headHtml = seo.head({
      title: `开源好物 - GitHub 上装上就能用的东西 - ${seo.SITE_NAME}`,
      description: seo.truncate(
        `站外收录的 ${items.length} 个开源项目：跨设备传文件、自托管监控、稍后读、手绘白板、PDF 工具箱、评论系统……` +
        `每个都写了「它解决什么问题」，标了语言和许可证，点开就是 GitHub 原仓库。`, 150),
      keywords: '开源项目推荐,GitHub 好物,自托管,效率工具,开源软件,独立开发者工具,LocalSend,Uptime Kuma,Excalidraw',
      canonical: base + '/open',
      type: 'website',
      jsonLd: [
        seo.breadcrumbLd(base, [{ name: '首页', href: '/' }, { name: '开源好物' }]),
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: '开源好物',
          description: '站外收录的 GitHub 开源项目清单',
          url: base + '/open',
          isPartOf: { '@type': 'WebSite', name: seo.SITE_NAME, url: base + '/' },
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: items.length,
            itemListElement: items.map((it, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: it.name,
              url: 'https://github.com/' + it.repo
            }))
          }
        }
      ]
    });

    const block = `<div id="seoContent" class="seo-wrap oss-wrap">
  <style>${OSS_CSS}</style>
  ${seo.breadcrumbHtml(base, [{ name: '首页', href: '/' }, { name: '开源好物' }])}
  <header class="oss-hero">
    <span class="oss-kicker">${seo.svgIco('github')} 站外收录 · 不进作品池</span>
    <h1>开源好物</h1>
    <p class="oss-sub">${esc(data.intro)}</p>
    <div class="oss-stats">
      <span><b>${items.length}</b>个项目</span>
      <span><i>·</i> <b>${cats.length}</b>类</span>
      ${dayStr ? `<span><i>·</i>清单更新于 ${dayStr}</span>` : ''}
      ${lastStr ? `<span><i>·</i>星标 ${lastStr} 刷新</span>` : ''}
    </div>
    <div class="oss-cta-row">
      <button type="button" class="oss-cta oss-open-submit">+ 提交开源作品</button>
      <span class="oss-cta-hint">GitHub star 超过 500 自动收录，其余站长人工过一眼</span>
    </div>
  </header>
  <nav class="oss-filter" id="ossFilter" aria-label="按分类筛选">
    <button type="button" class="oss-chip is-on" data-cat="all">全部<em>${items.length}</em></button>
    ${cats.filter(c => !c.custom || countOf(c.id) > 0).map(c => `<button type="button" class="oss-chip" data-cat="${c.id}" title="${esc(c.hint)}">${esc(c.name)}<em>${countOf(c.id)}</em></button>`).join('')}
  </nav>
  <div class="oss-grid" id="ossGrid">${items.map(it => cardHtml(it, cats)).join('')}</div>
  <p class="oss-empty" id="ossEmpty" hidden>这个分类下还没有收录。</p>
  <section class="oss-rule">
    <h2>这一页怎么收录</h2>
    <ol>
      <li><b>只放外链。</b>名字、一句中文介绍、语言、许可证、跳转 GitHub——不搬 README、不搬截图、不打包代码，项目版权和商标都归原作者。</li>
      <li><b>标了许可证就得当真。</b>绿色是宽松许可（MIT / Apache / BSD 一类，能商用），琥珀色是 copyleft（改完要按同样的协议开源）。要拿去做产品，先点开仓库自己核一遍，别只信这行小字。</li>
      <li><b>收录不等于推荐。</b>写在这里只说明我认为它值得一看，不代表做过安全审计、也不保证一直有人维护。</li>
      <li>项目有误、许可证变了、或者你就是作者希望撤下：<a href="/?feedback=1">告诉我们</a>，会尽快处理。想推荐好项目？<button type="button" class="oss-linkbtn oss-open-submit">点这里提交收录</button>。</li>
    </ol>
  </section>
  <div class="oss-modal" id="ossModal" hidden>
    <div class="oss-mask" data-oss-close></div>
    <div class="oss-dialog" role="dialog" aria-modal="true" aria-labelledby="ossModalTitle">
      <div id="ossForm">
        <h3 id="ossModalTitle">提交开源作品</h3>
        <p class="oss-modal-sub">只收 GitHub 仓库的外链，不搬代码、不进作品池。GitHub star 超过 500 的项目提交后自动收录，其余由站长人工过一眼。</p>
        <label class="oss-field"><span>GitHub 仓库链接 <i>必填</i></span>
          <input id="ossRepoInput" maxlength="300" placeholder="https://github.com/owner/repo" autocomplete="off" />
        </label>
        <label class="oss-field"><span>项目名称 <em>选填，不填取仓库名</em></span>
          <input id="ossNameInput" maxlength="60" placeholder="如：LocalSend" autocomplete="off" />
        </label>
        <label class="oss-field"><span>一句话介绍 <em>选填，会展示在卡片上</em></span>
          <textarea id="ossDescInput" maxlength="200" placeholder="它解决什么问题，装上能干什么"></textarea>
        </label>
        <label class="oss-field"><span>分类 <em>没有合适的？选最后一项自己建</em></span>
          <select id="ossCatInput">
            ${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            <option value="__new">＋ 新建分类…</option>
          </select>
        </label>
        <div id="ossNewCat" hidden>
          <label class="oss-field"><span>新分类名称 <i>必填</i> <em>${CAT_NAME_MAX} 字以内</em></span>
            <input id="ossNewCatName" maxlength="${CAT_NAME_MAX}" placeholder="如：命令行工具" autocomplete="off" />
          </label>
          <label class="oss-field"><span>一句说明 <em>选填，显示在筛选按钮的提示上</em></span>
            <input id="ossNewCatHint" maxlength="${CAT_HINT_MAX}" placeholder="如：不用开图形界面，终端里跑" autocomplete="off" />
          </label>
          <p class="oss-modal-sub" style="margin:-4px 0 12px">新分类会随这条投稿一起处理：star 超过 500 自动收录时当场创建；进人工审核的话，站长点「收录」时才会创建。</p>
        </div>
        <label class="oss-field"><span>联系方式 <em>选填，只有站长能看到</em></span>
          <input id="ossContactInput" maxlength="100" placeholder="邮箱 / 微信 / GitHub 主页都行" autocomplete="off" />
        </label>
        <p class="oss-err" id="ossErr" hidden></p>
        <div class="oss-btns">
          <button type="button" class="oss-btn" data-oss-close>取消</button>
          <button type="button" class="oss-btn primary" id="ossSend">提交</button>
        </div>
      </div>
      <div class="oss-done" id="ossDone" hidden></div>
    </div>
  </div>
  <p class="seo-more"><a class="btn-ghost" href="/">← 返回首页</a>&nbsp;&nbsp;<a class="btn-ghost" href="/column">站内精选专栏 →</a></p>
  <script>
    (function () {
      var bar = document.getElementById('ossFilter');
      var grid = document.getElementById('ossGrid');
      var empty = document.getElementById('ossEmpty');
      if (!bar || !grid) return;
      bar.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-cat]');
        if (!btn) return;
        var cat = btn.getAttribute('data-cat');
        bar.querySelectorAll('.oss-chip').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
        var n = 0;
        grid.querySelectorAll('.oss-card').forEach(function (card) {
          var on = cat === 'all' || card.getAttribute('data-cat') === cat;
          card.hidden = !on;
          if (on) n++;
        });
        if (empty) empty.hidden = n > 0;
      });
    })();
    (function () {
      var modal = document.getElementById('ossModal');
      if (!modal) return;
      var form = document.getElementById('ossForm');
      var done = document.getElementById('ossDone');
      var err = document.getElementById('ossErr');
      var sendBtn = document.getElementById('ossSend');
      var repoInput = document.getElementById('ossRepoInput');
      var catInput = document.getElementById('ossCatInput');
      var newCatBox = document.getElementById('ossNewCat');
      catInput.addEventListener('change', function () {
        newCatBox.hidden = catInput.value !== '__new';
      });
      function openModal() {
        modal.hidden = false;
        form.hidden = false;
        done.hidden = true;
        err.hidden = true;
        document.body.style.overflow = 'hidden';
        setTimeout(function () { repoInput.focus(); }, 40);
      }
      function closeModal() {
        modal.hidden = true;
        document.body.style.overflow = '';
      }
      document.querySelectorAll('.oss-open-submit').forEach(function (b) { b.addEventListener('click', openModal); });
      modal.addEventListener('click', function (e) {
        if (e.target.closest('[data-oss-close]')) closeModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.hidden) closeModal();
      });
      sendBtn.addEventListener('click', async function () {
        var repo = repoInput.value.trim();
        if (!repo) {
          err.textContent = 'GitHub 仓库链接必填，如 https://github.com/owner/repo';
          err.hidden = false;
          repoInput.focus();
          return;
        }
        err.hidden = true;
        var isNewCat = catInput.value === '__new';
        var newCatName = isNewCat ? document.getElementById('ossNewCatName').value.trim() : '';
        if (isNewCat && !newCatName) {
          err.textContent = '选了新建分类就要填分类名称';
          err.hidden = false;
          document.getElementById('ossNewCatName').focus();
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = '提交中…';
        try {
          var r = await fetch('/api/open/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repo: repo,
              name: document.getElementById('ossNameInput').value.trim(),
              desc: document.getElementById('ossDescInput').value.trim(),
              cat: isNewCat ? '' : catInput.value,
              catNew: isNewCat ? { name: newCatName, hint: document.getElementById('ossNewCatHint').value.trim() } : null,
              contact: document.getElementById('ossContactInput').value.trim()
            })
          }).then(function (x) { return x.json(); });
          if (r && r.error) {
            err.textContent = r.error;
            err.hidden = false;
            sendBtn.disabled = false;
            sendBtn.textContent = '提交';
            return;
          }
          form.hidden = true;
          done.hidden = false;
          done.innerHTML = r.approved
            ? '<b>已自动收录 ✓</b><p>「' + esc2(r.name) + '」GitHub star ' + r.star + '，超过 500 直接收进了清单。</p>' +
              '<div class="oss-btns" style="justify-content:center"><button type="button" class="oss-btn primary" onclick="location.reload()">看看清单</button></div>'
            : '<b>已提交，谢谢推荐</b><p>这个仓库 GitHub star ' + (r.star || '暂未知') + '，会由站长人工过一眼；通过了就会出现在清单里。' +
              (r.newCatPending ? '你新建的分类「' + esc2(r.newCatName) + '」会在站长收录时一起创建。</p>' : '</p>') +
              '<div class="oss-btns" style="justify-content:center"><button type="button" class="oss-btn primary" data-oss-close>好的</button></div>';
        } catch (e2) {
          err.textContent = '网络不太顺，再试一次';
          err.hidden = false;
          sendBtn.disabled = false;
          sendBtn.textContent = '提交';
        }
      });
      // 响应里只有仓库名要上屏，做个本地转义，别信服务端字段直接拼 HTML
      function esc2(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
    })();
  </script>
</div>`;
    sendHtml(res, shell(headHtml, block));
  });

  // ---------- 访客提交收录 ----------
  // 前台「开源好物」页弹窗提交。GitHub 链接必填；先问一次 GitHub 拿 star：
  //   star > AUTO_STAR → 直接收进清单（status=approved, auto=true），不用站长过；
  //   否则进待审队列，后台「开源收录」页人工处理。
  app.post('/api/open/submit', async (req, res) => {
    // 一小时 5 次：弹窗是公开的，不能被人当留言板灌
    if (!rateLimit('osub:' + clientIp(req), 5, 3600 * 1000)) {
      return res.status(429).json({ error: '提交太频繁了，一小时后再试' });
    }
    const body = req.body || {};
    const repo = normalizeRepo(body.repo);
    if (!repo) return res.status(400).json({ error: 'GitHub 仓库链接必填，如 https://github.com/owner/repo' });
    const data = loadContent();
    if (data.items.some(it => it.repo.toLowerCase() === repo.toLowerCase())) {
      return res.status(409).json({ error: '这个项目已经在收录清单里了' });
    }
    const submits = loadSubmits();
    if (submits.some(s => s && s.repo && s.repo.toLowerCase() === repo.toLowerCase() && s.status === 'pending')) {
      return res.status(409).json({ error: '这个项目已经在审核队列里了，等站长看一眼' });
    }
    // 投稿里随手新建的分类：先只记在投稿上，不进公共清单——
    // star>500 自动收录当场创建；进人工队列的等站长「收录」时再创建（见 submit-review）
    let catNew = null;
    if (body.catNew && typeof body.catNew === 'object') {
      const n = String(body.catNew.name || '').trim();
      if (!n) return res.status(400).json({ error: '选了新建分类就要填分类名称' });
      catNew = {
        name: n.slice(0, CAT_NAME_MAX),
        hint: String(body.catNew.hint || '').trim().slice(0, CAT_HINT_MAX)
      };
    }
    const rec = {
      id: 'os' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      repo,
      name: String(body.name || '').trim().slice(0, 60),
      desc: String(body.desc || '').trim().slice(0, 200),
      cat: catNew ? '' : (loadCats().some(c => c.id === body.cat) ? body.cat : 'web'),
      catNew,
      contact: String(body.contact || '').trim().slice(0, 100), // 只有后台可见，不出页面前台
      star: 0,
      at: new Date().toISOString(),
      ip: clientIp(req),
      status: 'pending'
    };
    const info = await ghRepo(repo);
    if (info.error === 'http404') {
      return res.status(404).json({ error: 'GitHub 上找不到这个仓库，检查一下链接（私有仓库也收不了）' });
    }
    rec.star = info.star || 0;
    let newCatPending = false;
    if (!info.error && rec.star > AUTO_STAR) {
      let catForItem = rec.cat;
      if (catNew) {
        const made = ensureCat(catNew.name, catNew.hint);
        catForItem = made.cat || 'web'; // 建分类失败（超上限/落盘挂）不拦收录，项目先归「打开就能用」
        rec.cat = catForItem;
      }
      const added = await addToContent(repo, { ...rec, cat: catForItem });
      if (added.ok) {
        rec.status = 'approved';
        rec.auto = true;
        rec.approvedAt = new Date().toISOString();
      }
      // addToContent 失败（限流 / 落盘挂了）不拦提交：降级进人工队列，别让访客白填
    }
    if (rec.status !== 'approved' && catNew) newCatPending = true;
    submits.push(rec);
    saveSubmits(submits);
    res.json({
      ok: true,
      approved: rec.status === 'approved',
      star: rec.star,
      name: rec.name || repo.split('/')[1],
      newCatPending,
      newCatName: catNew ? catNew.name : ''
    });
  });

  // ---------- 后台：提交队列审核 ----------
  app.get('/api/admin/open/submits', requireAdmin, (req, res) => {
    const submits = loadSubmits().filter(Boolean);
    const items = list().items;
    res.json({
      cats: loadCats(),
      itemsCount: items.reduce((m, it) => { m[it.cat || 'web'] = (m[it.cat || 'web'] || 0) + 1; return m; }, {}),
      pending: submits.filter(s => s.status === 'pending').reverse(), // 新的排前面
      handled: submits.filter(s => s.status !== 'pending').slice(-60).reverse()
    });
  });

  app.post('/api/admin/open/submit-review', requireAdmin, async (req, res) => {
    const id = String(req.body && req.body.id || '');
    const action = String(req.body && req.body.action || '');
    const submits = loadSubmits();
    const rec = submits.find(s => s && s.id === id);
    if (!rec) return res.status(404).json({ error: '没有这条提交' });
    if (rec.status !== 'pending') return res.status(409).json({ error: '这条已经处理过了' });
    if (action === 'approve') {
      // 投稿带的新分类在这里才真正创建（catNew.name 同名幂等；建失败归「打开就能用」，不拦收录）
      let catForItem = rec.cat;
      if (rec.catNew && rec.catNew.name) {
        const made = ensureCat(rec.catNew.name, rec.catNew.hint);
        if (made.cat) catForItem = made.cat;
      }
      const added = await addToContent(rec.repo, { ...rec, cat: catForItem });
      if (!added.ok) return res.status(502).json({ error: added.error || '收录失败，稍后再试' });
      rec.cat = added.item.cat;
      rec.status = 'approved';
      rec.approvedAt = new Date().toISOString();
    } else if (action === 'reject') {
      rec.status = 'rejected';
      rec.rejectedAt = new Date().toISOString();
    } else {
      return res.status(400).json({ error: 'action 要是 approve 或 reject' });
    }
    saveSubmits(submits);
    res.json({ ok: true, rec });
  });

  // ---------- JSON 接口 + 后台维护 ----------
  app.get('/api/open', (req, res) => {
    const data = list();
    res.json({
      intro: data.intro,
      updatedAt: data.updatedAt,
      cats: loadCats(),
      items: data.items
    });
  });

  app.post('/api/admin/open/refresh', requireAdmin, async (req, res) => {
    const out = await refresh({ force: true });
    res.json({ ...out, items: list().items });
  });

  // 新增：只给 GitHub 仓库全名（owner/repo），名字和描述自己补；语言/许可证留给定时刷新回填
  app.post('/api/admin/open/add', requireAdmin, async (req, res) => {
    const repo = normalizeRepo(req.body && req.body.repo);
    if (!repo) return res.status(400).json({ error: '仓库全名要写成 owner/repo' });
    const added = await addToContent(repo, req.body || {});
    if (!added.ok) {
      const code = String(added.error || '').includes('已经收录') ? 409 : (String(added.error || '').includes('找不到') ? 404 : 500);
      return res.status(code).json({ error: added.error });
    }
    res.json({ ok: true, item: added.item });
  });

  app.post('/api/admin/open/save', requireAdmin, (req, res) => {
    const repo = String(req.body && req.body.repo || '').trim();
    const data = loadContent();
    const it = data.items.find(x => x.repo === repo);
    if (!it) return res.status(404).json({ error: '没有这个项目' });
    ['name', 'desc', 'lang', 'license'].forEach(k => {
      if (typeof req.body[k] === 'string') it[k] = req.body[k].trim();
    });
    if (loadCats().some(c => c.id === req.body.cat)) it.cat = req.body.cat;
    data.updatedAt = new Date().toISOString().slice(0, 10);
    if (!saveContent(data)) return res.status(500).json({ error: '写入失败' });
    res.json({ ok: true, item: it });
  });

  app.post('/api/admin/open/del', requireAdmin, (req, res) => {
    const repo = String(req.body && req.body.repo || '').trim();
    const data = loadContent();
    const before = data.items.length;
    data.items = data.items.filter(x => x.repo !== repo);
    if (data.items.length === before) return res.status(404).json({ error: '没有这个项目' });
    data.updatedAt = new Date().toISOString().slice(0, 10);
    if (!saveContent(data)) return res.status(500).json({ error: '写入失败' });
    res.json({ ok: true });
  });

  // ---------- 后台：分类管理 ----------
  // 投稿弹窗里也能建（随审核生效），这里给站长一个直接入口；删除只认自定义分类，内置 5 类不可删。
  app.post('/api/admin/open/cat-add', requireAdmin, (req, res) => {
    const body = req.body || {};
    const made = ensureCat(body.name, body.hint);
    if (made.error) return res.status(400).json({ error: made.error });
    res.json({ ok: true, cat: made.cat, created: made.created, cats: made.cats });
  });

  app.post('/api/admin/open/cat-del', requireAdmin, (req, res) => {
    const id = String(req.body && req.body.id || '');
    const cats = loadCats();
    const cat = cats.find(c => c.id === id);
    if (!cat) return res.status(404).json({ error: '没有这个分类' });
    if (BASE_IDS.has(cat.id)) return res.status(400).json({ error: '内置分类不能删' });
    const data = loadContent();
    const moved = data.items.filter(it => it.cat === id).length;
    data.items.forEach(it => { if (it.cat === id) it.cat = 'web'; });
    data.updatedAt = new Date().toISOString().slice(0, 10);
    if (!saveContent(data)) return res.status(500).json({ error: '项目归位失败' });
    if (!saveCats(cats.filter(c => c.id !== id))) return res.status(500).json({ error: '写入分类失败' });
    res.json({ ok: true, moved, cats: loadCats() });
  });

  scheduleRefresh();
}

module.exports = { register, refresh, list, loadCats, pendingSubmitCount };
