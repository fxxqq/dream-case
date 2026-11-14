'use strict';
/**
 * dev-env.js —— 本地开发专用的「环境切换」
 *
 * 目的：本地改代码时，随时把接口切到线上，用真实数据看效果。
 * 做法：在本地 server 里做反向代理，前端代码一个字都不用改（所有请求本来就是相对路径）。
 *
 * 三种模式（状态存 data/dev-env.json，重启仍生效）：
 *   local  本地       什么都不做，全走本机（默认）
 *   api    生产 · 接口 /api/* 与 /uploads/* 转发到线上；页面仍由本地代码渲染
 *   site   生产 · 全站 除本地前端静态资源（js/css/图片/字体）外全部转发，HTML 也看线上的
 *
 * 写操作默认拦截：POST / PUT / PATCH / DELETE 直接 403，必须显式打开 write 才放行，
 * 免得本地随手一点就把测试数据写进线上库。所有响应都带 x-dm-dev-env 头，方便排查。
 *
 * 只在本地生效：pm2 起的进程（process.env.pm_id 存在）一律关闭，
 * 线上永远拿不到这个功能，也不能被远程打开（开关接口只收 loopback 请求）。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_TARGET = process.env.DEV_PROD_ORIGIN || 'https://idea.v5pc.com';
const FORCE = String(process.env.DEV_ENV || '').trim();   // DEV_ENV=1 强制开，=0 强制关
const ENABLED = FORCE === '1' ? true
  : FORCE === '0' ? false
  : (!process.env.pm_id && process.env.NODE_ENV !== 'production');

const MODES = ['local', 'api', 'site'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// 只读模式下的写接口白名单：只放「建立会话」的几个端点。
// 不放行就登不进线上账号，「我的 / 后台」这类页面没法测；这些接口不碰作品与灯火账目，
// 副作用仅相当于本人正常访问了一次线上。注册、投稿、兑换、后台编辑一律不在名单里。
const READ_ONLY_ALLOW = new Set([
  '/api/login',
  '/api/admin/session',        // 后台口令换 cookie，才能只读地看线上后台
  '/api/auth/wechat/login',
  '/api/auth/wxscan/start',
  '/api/auth/wxscan/confirm'
]);
// 逐跳头：不能原样转发（Host 要换、编码要自己决定、连接语义由各自的 node 管）
const HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding'
]);
// site 模式下仍由本地提供的静态资源（其余一律转发，HTML 也在转发之列）
const LOCAL_ASSET_RE = /\.(?:css|js|mjs|svg|png|jpe?g|webp|gif|ico|bmp|woff2?|ttf|otf|eot)$/i;
const LOCAL_ASSET_EXTRA = new Set(['/sw.js', '/manifest.webmanifest', '/robots.txt']);

const PROXY_TIMEOUT_MS = 60000;

/** 本地开发才启用的标志位（server.js 用它决定要不要注入徽标） */
function isLoopback(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  const ip = raw.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function normalizeTarget(v) {
  let s = String(v || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).origin; } catch { return DEFAULT_TARGET; }
}

module.exports = function createDevEnv({ dataDir }) {
  const STATE_FILE = path.join(dataDir, 'dev-env.json');
  const state = { mode: 'local', write: false, target: DEFAULT_TARGET };

  function load() {
    if (!ENABLED) return;
    try {
      const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (MODES.includes(j.mode)) state.mode = j.mode;
      state.write = !!j.write;
      if (j.target) state.target = normalizeTarget(j.target);
    } catch { /* 没配过就用默认（本地） */ }
    if (state.mode !== 'local') {
      console.log(`[dev-env] 已启用，当前环境：${state.mode}${state.write ? '（可写）' : '（只读）'} → ${state.target}`);
    }
  }

  function save() {
    if (!ENABLED) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        mode: state.mode, write: state.write, target: state.target,
        at: new Date().toISOString()
      }, null, 2));
    } catch (e) {
      console.warn('[dev-env] 状态写不进去（不影响本次生效）:', e.message);
    }
  }

  // ---------- 该不该转发 ----------
  function shouldProxy(req) {
    if (!ENABLED || state.mode === 'local') return false;
    const p = req.path || req.url || '/';
    if (p.startsWith('/__dev/')) return false;          // 开关接口自己永远不转发
    // /t/<宽>/<文件名> 是 /uploads 的缩略变体（app.js 的 imgUrl 统一把图拼成这个形），
    // 不转发的话 api 模式下本地一张图都看不到（本地没有 uploads 文件，全 404）
    if (state.mode === 'api') return p.startsWith('/api/') || p.startsWith('/uploads/') || p.startsWith('/t/');
    return LOCAL_ASSET_EXTRA.has(p) === false && LOCAL_ASSET_RE.test(p) === false;
  }

  // 线上回的 Set-Cookie：去掉 Domain（交给 localhost）、去掉 Secure（本地是 http）、
  // SameSite=None 必须配 Secure，降级成 Lax 才不会被浏览器丢弃
  function fixCookie(c) {
    return String(c)
      .replace(/;\s*SameSite=None/ig, '; SameSite=Lax')
      .replace(/;\s*Secure/ig, '')
      .replace(/;\s*Domain=[^;]*/ig, '');
  }

  function fixLocation(loc, t, localOrigin) {
    const s = String(loc);
    return s.startsWith(t.origin) ? localOrigin + s.slice(t.origin.length) : s;
  }

  function doProxy(req, res) {
    const t = new URL(state.target);
    const lib = t.protocol === 'https:' ? https : http;
    const localOrigin = (req.protocol || 'http') + '://' + (req.headers.host || 'localhost');

    const headers = {};
    for (const k of Object.keys(req.headers)) {
      if (HOP_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = req.headers[k];
    }
    headers.host = t.host;
    // 让线上看到的是「自己站内」的来源，带同源校验的接口才不会拒
    if (headers.origin) headers.origin = t.origin;
    if (headers.referer) headers.referer = t.origin + '/';

    const preq = lib.request({
      protocol: t.protocol,
      hostname: t.hostname,
      port: t.port || (t.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.originalUrl || req.url,
      headers,
      servername: t.hostname
    }, (pres) => {
      const h = {};
      for (const k of Object.keys(pres.headers)) {
        if (k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') continue;
        h[k] = pres.headers[k];
      }
      if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map(fixCookie);
      if (h.location) h.location = fixLocation(h.location, t, localOrigin);
      h['x-dm-dev-env'] = state.mode + (state.write ? '+write' : '');

      const isHtml = /text\/html/i.test(String(h['content-type'] || ''));
      const noBody = pres.statusCode === 304 || req.method === 'HEAD';
      if (isHtml && !noBody) {
        // HTML 要注入环境徽标：先整段收下来，再改完发出去
        const chunks = [];
        pres.on('data', (c) => chunks.push(c));
        pres.on('end', () => {
          const body = injectInto(Buffer.concat(chunks).toString('utf8'));
          delete h['content-length'];     // 注入后长度变了，交给 node 分块
          delete h['content-encoding'];
          res.writeHead(pres.statusCode || 200, h);
          res.end(body);
        });
        pres.on('error', () => { try { res.end(); } catch { /* 已断开 */ } });
        return;
      }
      res.writeHead(pres.statusCode || 200, h);
      pres.pipe(res);
    });

    preq.setTimeout(PROXY_TIMEOUT_MS, () => preq.destroy(new Error('线上响应超时（60s）')));
    preq.on('error', (e) => {
      console.warn('[dev-env] 转发失败:', req.method, req.originalUrl, '-', e.message);
      if (res.headersSent) { try { res.end(); } catch { /* 已断开 */ } return; }
      res.status(502).json({ error: '生产环境转发失败：' + e.message, env: state.mode });
    });
    // 请求体原样转发：本中间件挂在 express.json() 之前，body 还没被消费
    req.pipe(preq);
  }

  // ---------- 对外接口 ----------
  function middleware() {
    return function (req, res, next) {
      if (!ENABLED || !shouldProxy(req)) {
        if (ENABLED && state.mode !== 'local') res.setHeader('x-dm-dev-env', state.mode);
        return next();
      }
      if (!state.write && !READ_METHODS.has(req.method) && !READ_ONLY_ALLOW.has(req.path)) {
        return res.status(403).json({
          error: '当前是「生产接口」环境，写操作已在本地拦住了（登录/扫码不受影响）。确需写入请先打开徽标里的「允许写入生产」。',
          env: state.mode
        });
      }
      doProxy(req, res);
    };
  }

  /** 页面兜底：api 模式下本地数据里没有这件作品时，把页面请求转给线上（别让用户看到假的 404） */
  function fallbackPage(req, res) {
    if (!ENABLED || state.mode !== 'api') return false;
    if (req.method !== 'GET') return false;
    if (!/text\/html/i.test(String(req.headers.accept || ''))) return false;
    doProxy(req, res);
    return true;
  }

  function snapshot() {
    return {
      enabled: ENABLED,
      mode: state.mode,
      write: !!state.write,
      target: state.target
    };
  }

  // ---------- 徽标注入 ----------
  function injectInto(html) {
    if (!ENABLED || typeof html !== 'string' || !html) return html;
    if (html.includes('id="dm-dev-env"')) return html;      // 已经注过就别注第二遍
    const tag = '<script id="dm-dev-env">(' + devEnvClient.toString() + ')(' + JSON.stringify(snapshot()) + ');</script>';
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
    return html + tag;
  }

  function routes(app) {
    app.get('/__dev/env', (req, res) => {
      if (!ENABLED) return res.status(404).json({ error: '接口不存在' });
      res.set('Cache-Control', 'no-store');
      res.json(Object.assign(snapshot(), { canSwitch: isLoopback(req) }));
    });

    app.post('/__dev/env', (req, res) => {
      if (!ENABLED) return res.status(404).json({ error: '接口不存在' });
      if (!isLoopback(req)) return res.status(403).json({ error: '只能在跑服务的那台机器上切换环境' });
      const body = req.body || {};
      if (body.mode !== undefined) {
        if (!MODES.includes(body.mode)) return res.status(400).json({ error: 'mode 只能是 local / api / site' });
        state.mode = body.mode;
        if (state.mode === 'local') state.write = false;     // 回本地就自动摘掉写权限，别留后门
      }
      if (body.write !== undefined) state.write = !!body.write && state.mode !== 'local';
      if (body.target !== undefined) state.target = normalizeTarget(body.target);
      save();
      console.log(`[dev-env] 环境切换：${state.mode}${state.write ? '（可写）' : ''} → ${state.target}`);
      res.set('Cache-Control', 'no-store');
      res.json(snapshot());
    });
  }

  load();

  return {
    enabled: ENABLED,
    on: () => ENABLED && state.mode !== 'local',
    mode: () => state.mode,
    target: () => state.target,
    snapshot,
    middleware,
    fallbackPage,
    injectInto,
    routes,
    /** 模板缓存用：模式一变就得重新注入（否则旧 HTML 里的徽标还是上一档） */
    stamp: () => (ENABLED ? state.mode + '|' + (state.write ? 1 : 0) + '|' + state.target : '')
  };
};

/**
 * 浏览器端的徽标 + 切换面板（整段函数会被 toString() 注进页面，别引用外部变量）
 * 左下角常驻一颗药丸：本地紫、生产橙、允许写生产时红点呼吸。
 */
function devEnvClient(S) {
  try {
    if (!S || !S.enabled || window.__dmDevEnv) return;
    window.__dmDevEnv = S;

    var MODES = [
      { k: 'local', label: '本地', color: '#5b5bd6', desc: '接口和页面都走本机' },
      { k: 'api', label: '生产 · 接口', color: '#d97706', desc: '/api 与图片走线上，页面仍用本地代码' },
      { k: 'site', label: '生产 · 全站', color: '#c2410c', desc: '连 HTML 也看线上的，只保留本地静态资源' }
    ];
    // 只有 localhost 才能改：别的地方打开（如局域网 IP）只能看不能切
    var canSwitch = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(location.hostname);

    var css = ''
      + '#dm-dev-env-root{position:fixed;left:12px;bottom:12px;z-index:2147483000;'
      + 'font:12px/1.5 "PingFang SC","Microsoft YaHei",-apple-system,sans-serif;color:#1f2330}'
      + '.dmev-pill{display:flex;align-items:center;gap:6px;padding:6px 11px 6px 9px;border:0;border-radius:999px;'
      + 'background:#1f2330;color:#fff;cursor:pointer;font:inherit;letter-spacing:.02em;'
      + 'box-shadow:0 6px 20px rgba(20,24,40,.22);transition:background .15s}'
      + '.dmev-pill:hover{background:#2c3244}'
      + '.dmev-dot{width:8px;height:8px;border-radius:50%;background:#5b5bd6;flex:none}'
      + '#dm-dev-env-root.is-write .dmev-dot{animation:dmev-pulse 1.2s ease-out infinite}'
      + '@keyframes dmev-pulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,.6)}70%{box-shadow:0 0 0 6px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}'
      + '.dmev-panel{position:absolute;left:0;bottom:42px;width:252px;background:#fff;border:1px solid #e6e8f0;'
      + 'border-radius:14px;box-shadow:0 16px 40px rgba(20,24,40,.18);padding:10px;display:none}'
      + '.dmev-panel.on{display:block}'
      + '.dmev-hd{display:flex;justify-content:space-between;align-items:baseline;padding:2px 4px 8px;font-weight:600}'
      + '.dmev-only{font-weight:400;color:#9aa0b2;font-size:11px}'
      + '.dmev-mode{display:block;width:100%;text-align:left;padding:7px 9px;margin-bottom:4px;cursor:pointer;'
      + 'border:1px solid transparent;border-radius:9px;background:#f7f7fb;font:inherit;color:inherit}'
      + '.dmev-mode:hover{background:#f1f1f9}'
      + '.dmev-mode.on{border-color:#d9d9f7;background:#f2f2fd}'
      + '.dmev-mode[disabled]{opacity:.55;cursor:not-allowed}'
      + '.dmev-mode b{display:flex;align-items:center;gap:6px;font-weight:600}'
      + '.dmev-mode i{width:7px;height:7px;border-radius:50%;flex:none}'
      + '.dmev-mode span{display:block;color:#7a8095;font-size:11px;margin-top:2px;line-height:1.45}'
      + '.dmev-write{display:flex;gap:7px;align-items:flex-start;padding:8px 6px 6px;margin-top:4px;'
      + 'border-top:1px solid #f0f1f6;cursor:pointer}'
      + '.dmev-write.off{opacity:.45;cursor:not-allowed}'
      + '.dmev-write input{margin:2px 0 0}'
      + '.dmev-write em{display:block;color:#9aa0b2;font-style:normal;font-size:11px}'
      + '.dmev-foot{padding:2px 6px 4px;color:#9aa0b2;font-size:11px;line-height:1.55;word-break:break-all}'
      + '.dmev-foot b{color:#7a8095;font-weight:400}'
      + '@media (max-width:720px){#dm-dev-env-root{left:8px;'
      + 'bottom:calc(62px + env(safe-area-inset-bottom,0px))}.dmev-panel{width:232px}}'
      + 'html.dm-night .dmev-panel{background:#232838;border-color:#343b50;color:#e9ebf2}'
      + 'html.dm-night .dmev-mode{background:#2a3044;color:#e9ebf2}'
      + 'html.dm-night .dmev-mode:hover{background:#323a50}'
      + 'html.dm-night .dmev-mode.on{background:#33395a;border-color:#454c74}'
      + 'html.dm-night .dmev-hd,html.dm-night .dmev-foot b{color:#e9ebf2}'
      + 'html.dm-night .dmev-write{border-color:#343b50}';

    var style = document.createElement('style');
    style.id = 'dm-dev-env-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    var root = document.createElement('div');
    root.id = 'dm-dev-env-root';
    root.innerHTML = '<div class="dmev-panel">'
      + '<div class="dmev-hd">环境<span class="dmev-only">仅本地开发</span></div>'
      + '<div class="dmev-modes"></div>'
      + '<label class="dmev-write"><input type="checkbox" class="dmev-chk"><span>允许写入生产<em>POST / PUT / DELETE，慎开</em></span></label>'
      + '<div class="dmev-foot"></div>'
      + '</div>'
      + '<button type="button" class="dmev-pill" aria-haspopup="true" aria-expanded="false">'
      + '<i class="dmev-dot"></i><span class="dmev-txt"></span></button>';
    document.body.appendChild(root);

    var panel = root.querySelector('.dmev-panel');
    var pill = root.querySelector('.dmev-pill');
    var modesBox = root.querySelector('.dmev-modes');
    var chk = root.querySelector('.dmev-chk');
    var writeRow = root.querySelector('.dmev-write');
    var foot = root.querySelector('.dmev-foot');

    MODES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dmev-mode';
      b.setAttribute('data-mode', m.k);
      b.disabled = !canSwitch;
      b.innerHTML = '<b><i style="background:' + m.color + '"></i>' + m.label + '</b><span>' + m.desc + '</span>';
      b.addEventListener('click', function () {
        if (!canSwitch || m.k === S.mode) return;
        post({ mode: m.k });
      });
      modesBox.appendChild(b);
    });

    function post(body) {
      foot.textContent = '切换中…';
      fetch('/__dev/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (r) {
        if (!r.ok) { foot.textContent = r.j && r.j.error ? r.j.error : '切换失败'; return; }
        // 切完必须是整页刷新：SSR 数据、静态缓存、会话都要重新拿一遍
        location.reload();
      }).catch(function (e) {
        foot.textContent = '切换失败：' + (e && e.message ? e.message : e);
      });
    }

    chk.addEventListener('change', function () {
      if (!canSwitch) { chk.checked = !chk.checked; return; }
      fetch('/__dev/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ write: chk.checked })
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (r) {
        if (!r.ok) { chk.checked = !chk.checked; foot.textContent = (r.j && r.j.error) || '切换失败'; return; }
        S.write = !!r.j.write;
        render();
      }).catch(function () { chk.checked = !chk.checked; });
    });

    function render() {
      var cur = MODES.filter(function (m) { return m.k === S.mode; })[0] || MODES[0];
      var writable = S.write && S.mode !== 'local';
      root.className = writable ? 'is-write' : '';
      pill.querySelector('.dmev-dot').style.background = writable ? '#dc2626' : cur.color;
      pill.querySelector('.dmev-txt').textContent = cur.label + (writable ? ' · 可写' : '');
      Array.prototype.forEach.call(modesBox.children, function (b) {
        var on = b.getAttribute('data-mode') === S.mode;
        b.className = 'dmev-mode' + (on ? ' on' : '');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      chk.checked = writable;
      writeRow.className = 'dmev-write' + (S.mode === 'local' ? ' off' : '');
      chk.disabled = S.mode === 'local' || !canSwitch;
      foot.innerHTML = '';
      var line = document.createElement('b');
      line.textContent = '目标 ';
      foot.appendChild(line);
      foot.appendChild(document.createTextNode(S.target));
      if (!canSwitch) {
        foot.appendChild(document.createElement('br'));
        foot.appendChild(document.createTextNode('这页不是用 localhost 打开的，只能看不能切。'));
      } else if (writable) {
        foot.appendChild(document.createElement('br'));
        foot.appendChild(document.createTextNode('写操作会直接落到线上数据库！'));
      }
    }

    function toggle(open) {
      var want = open === undefined ? !panel.classList.contains('on') : open;
      panel.classList.toggle('on', want);
      pill.setAttribute('aria-expanded', want ? 'true' : 'false');
    }
    pill.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { toggle(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });

    render();
  } catch (e) {
    console.warn('[dev-env] 徽标初始化失败', e);
  }
}
