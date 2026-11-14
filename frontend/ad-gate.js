/*! ad-gate.js — 「扫码看一支广告才放行」的门槛组件（跨站可用）
 *
 * 用法（在两个 html 尾部引一次就够）：
 *   <div data-ad-gate="post">…被锁住的内容 / 按钮…</div>
 *   <script src="https://idea.v5pc.com/ad-gate.js" async></script>
 *
 * 行为：拦掉这个区域里的点击 → 弹二维码 → 用户扫码进小程序看完广告 →
 *       这里自动轮询到「看完」就解锁，并把用户刚才那一下点击原样补回去。
 *
 * 细节：
 *   · data-ad-gate 的值就是场景名（小写字母数字 - _，≤24 位），同一个站里每个门槛一个名字；
 *   · 解锁状态只记这张票：30 分钟过期、一票一人，票过期了自然重出，不需要「每天重置」；
 *   · 页面不需要改任何逻辑；想自己判断可以调 window.AdGate.isDone('post') / AdGate.check('post')；
 *   · 这个门槛挡的是「不想看广告的人」，挡不住会改前端代码的人——真正的校验要在你自己的服务端做
 *     （拿这张票去查一次，done 了才给结果）。
 */
(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  if (!SCRIPT) return;
  var API = '';
  try { API = new URL(SCRIPT.src, location.href).origin; } catch (e) { API = ''; }
  if (!API) return;

  var POLL_MS = 2500;
  var STORE_PREFIX = 'adgate:v1:';
  var IN_WECHAT = /MicroMessenger/i.test(navigator.userAgent);

  var states = {};   // gateName -> { unlocked, ticket:{id,expireAt}, el, timer, busy }

  function normScene(v) {
    // 场景名必须和出码那边一个字符集，脏输入就地清掉，别等人报错
    var raw = String(v == null ? '' : v).trim().toLowerCase();
    var s = raw.replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 24);
    return s || 'default';
  }

  function sceneOf(el) {
    return normScene(el.getAttribute('data-ad-gate'));
  }

  function storageKey(scene) { return STORE_PREFIX + API + ':' + scene; }

  function loadTicket(scene) {
    try {
      var raw = localStorage.getItem(storageKey(scene));
      if (!raw) return null;
      var t = JSON.parse(raw);
      if (!t || !t.id || !t.expireAt || Date.now() > Number(t.expireAt) - 5000) return null;
      return t;
    } catch (e) { return null; }
  }

  function saveTicket(scene, t) {
    try { localStorage.setItem(storageKey(scene), JSON.stringify(t)); } catch (e) { /* 隐私模式：不记也能用 */ }
  }

  function dropTicket(scene) {
    try { localStorage.removeItem(storageKey(scene)); } catch (e) { /* 同上 */ }
  }

  function req(path, opts) {
    return fetch(API + path, Object.assign({ mode: 'cors', credentials: 'omit' }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          return { ok: r.ok, status: r.status, data: d || {} };
        });
      });
  }

  function createTicket(scene) {
    return req('/api/ad/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: scene, site: location.hostname })
    }).then(function (res) {
      if (!res.ok) throw new Error(res.data.error || '出票失败，稍后再试');
      var t = { id: res.data.id, expireAt: res.data.expireAt, qr: res.data.qr };
      saveTicket(scene, t);
      return t;
    });
  }

  function checkTicket(scene, id) {
    return req('/api/ad/ticket?id=' + encodeURIComponent(id)).then(function (res) {
      if (res.status === 404) { dropTicket(scene); return { done: false, expired: true }; }
      if (!res.ok) throw new Error(res.data.error || '查询失败，稍后再试');
      return res.data;
    });
  }

  /* ---------------- 界面 ---------------- */

  var css = ''
    + '.adg-mask{position:fixed;inset:0;z-index:2147482000;background:rgba(16,18,32,.62);'
    + 'display:flex;align-items:center;justify-content:center;padding:20px;'
    + '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}'
    + '.adg-card{width:100%;max-width:320px;background:#fff;border-radius:18px;padding:22px 20px 16px;'
    + 'box-sizing:border-box;text-align:center;color:#1c1e2e;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;'
    + 'box-shadow:0 18px 60px rgba(0,0,0,.28);animation:adg-in .18s ease-out}'
    + '@keyframes adg-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}'
    + '.adg-h{font-size:17px;font-weight:600;margin:0 0 4px}'
    + '.adg-sub{font-size:13px;color:#71758c;margin:0 0 14px}'
    + '.adg-qr{width:200px;height:200px;margin:0 auto 12px;border-radius:12px;background:#f4f5fa;display:block;'
    + 'object-fit:contain}'
    + '.adg-msg{font-size:12.5px;color:#8a8fa3;min-height:18px;margin:0 0 12px}'
    + '.adg-msg.is-warn{color:#c2410c}'
    + '.adg-btn{display:block;width:100%;border:0;border-radius:12px;padding:13px 0;font-size:15px;font-weight:600;'
    + 'background:#6c5ce7;color:#fff;cursor:pointer;font-family:inherit}'
    + '.adg-btn:disabled{background:#c7c9d9;color:#fff;cursor:default}'
    + '.adg-btn2{display:block;width:100%;border:0;background:none;color:#8a8fa3;font-size:13px;padding:12px 0 4px;'
    + 'cursor:pointer;font-family:inherit}'
    + '.adg-done{width:44px;height:44px;border-radius:50%;background:#10b981;color:#fff;font-size:24px;'
    + 'line-height:44px;margin:0 auto 10px}'
    + '@media (prefers-color-scheme:dark){.adg-card{background:#1b1d2a;color:#eef0f8}'
    + '.adg-qr{background:#252838}.adg-sub{color:#9aa0b8}.adg-msg{color:#8f95ad}'
    + '.adg-btn2{color:#8f95ad}.adg-btn:disabled{background:#3a3d52}}';

  function injectCss() {
    if (document.getElementById('adg-style')) return;
    var s = document.createElement('style');
    s.id = 'adg-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  var ui = null;

  function buildUi() {
    injectCss();
    var mask = document.createElement('div');
    mask.className = 'adg-mask';
    mask.style.display = 'none';
    mask.innerHTML = '<div class="adg-card" role="dialog" aria-modal="true">'
      + '<p class="adg-h">先看一支广告</p>'
      + '<p class="adg-sub" data-adg-sub>扫码后在微信里看完这支广告，这一页会自动解锁</p>'
      + '<div class="adg-done" data-adg-done style="display:none">✓</div>'
      + '<img class="adg-qr" alt="小程序码" data-adg-qr>'
      + '<p class="adg-msg" data-adg-msg></p>'
      + '<button class="adg-btn" type="button" data-adg-ok>我已经看完了</button>'
      + '<button class="adg-btn2" type="button" data-adg-close>先不看了</button>'
      + '</div>';
    document.body.appendChild(mask);
    ui = {
      mask: mask,
      card: mask.querySelector('.adg-card'),
      qr: mask.querySelector('[data-adg-qr]'),
      msg: mask.querySelector('[data-adg-msg]'),
      ok: mask.querySelector('[data-adg-ok]'),
      close: mask.querySelector('[data-adg-close]'),
      sub: mask.querySelector('[data-adg-sub]'),
      done: mask.querySelector('[data-adg-done]'),
      scene: ''
    };
    ui.ok.addEventListener('click', function () { manualCheck(ui.scene); });
    ui.close.addEventListener('click', closeUi);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeUi(); });
  }

  function msg(text, warn) {
    if (!ui) return;
    ui.msg.textContent = text || '';
    ui.msg.className = 'adg-msg' + (warn ? ' is-warn' : '');
  }

  function closeUi() {
    if (!ui) return;
    ui.mask.style.display = 'none';
    stopPoll(ui.scene);
  }

  /* ---------------- 轮询 / 解锁 ---------------- */

  function stopPoll(scene) {
    var st = states[scene];
    if (st && st.timer) { clearTimeout(st.timer); st.timer = null; }
  }

  function pollOnce(scene) {
    var st = states[scene];
    if (!st || !st.ticket) return Promise.resolve(false);
    return checkTicket(scene, st.ticket.id).then(function (d) {
      if (d.done) { unlock(scene); return true; }
      return false;
    }).catch(function () { return false; });
  }

  function startPoll(scene) {
    var st = states[scene];
    if (!st) return;
    stopPoll(scene);
    var tick = function () {
      if (!states[scene] || states[scene].unlocked) return;
      pollOnce(scene).then(function (done) {
        if (done) return;
        var s2 = states[scene];
        if (s2 && ui && ui.mask.style.display !== 'none' && ui.scene === scene) {
          s2.timer = setTimeout(tick, POLL_MS);
        }
      });
    };
    st.timer = setTimeout(tick, POLL_MS);
  }

  function unlock(scene) {
    var st = states[scene];
    if (!st) return;
    var first = !st.unlocked;
    st.unlocked = true;
    stopPoll(scene);
    if (ui && ui.scene === scene) {
      ui.qr.style.display = 'none';
      ui.done.style.display = 'block';
      ui.sub.textContent = '广告看完了，这一页已解锁';
      ui.ok.style.display = 'none';
      msg('');
      setTimeout(function () { if (ui.mask.style.display !== 'none') closeUi(); }, 700);
    }
    var els = document.querySelectorAll('[data-ad-gate]');
    for (var i = 0; i < els.length; i++) {
      if (sceneOf(els[i]) === scene) els[i].setAttribute('data-ad-gate-done', '1');
    }
    if (first) {
      try {
        document.dispatchEvent(new CustomEvent('adgate:unlock', { detail: { scene: scene } }));
      } catch (e) { /* 老浏览器没有 CustomEvent 构造器就算了 */ }
      // 把用户刚才点的那一下补回去：解锁后同一个处理函数会直接放行
      var pending = st.pending;
      st.pending = null;
      if (pending && pending.click) setTimeout(function () { try { pending.click(); } catch (e) {} }, 60);
    }
  }

  function manualCheck(scene) {
    var st = states[scene];
    if (!st || !ui) return;
    ui.ok.disabled = true;
    msg('正在确认…');
    pollOnce(scene).then(function (done) {
      ui.ok.disabled = false;
      if (!done) msg('还没看完哦，把广告看到最后再回来', true);
    });
  }

  /* ---------------- 打开二维码 ---------------- */

  function openGate(scene, el) {
    if (!ui) buildUi();
    initState(scene);
    var st = states[scene];
    st.el = el;
    ui.scene = scene;
    if (st.unlocked) return;

    ui.mask.style.display = 'flex';
    ui.card.style.display = 'block';
    ui.done.style.display = 'none';
    ui.qr.style.display = 'block';
    ui.ok.style.display = 'block';
    ui.ok.disabled = false;
    ui.sub.textContent = IN_WECHAT
      ? '长按二维码 → 识别图中的小程序，看完广告就自动解锁'
      : '用微信扫一扫，看完这支广告这一页会自动解锁';
    msg('');

    var after = function (t) {
      ui.qr.src = API + t.qr;
      st.ticket = t;
      startPoll(scene);
    };

    if (st.ticket) {
      // 复用本地那张票：先确认还有效、没被别人用掉
      return checkTicket(scene, st.ticket.id).then(function (d) {
        if (d.done) return unlock(scene);
        if (d.expired) { st.ticket = null; return createTicket(scene).then(after).catch(fail); }
        after(st.ticket);
      }).catch(function () { return createTicket(scene).then(after).catch(fail); });
    }
    createTicket(scene).then(after).catch(fail);

    function fail(err) {
      msg((err && err.message) || '出码失败，稍后再试', true);
      ui.qr.style.display = 'none';
      ui.ok.style.display = 'none';
    }
  }

  /* ---------------- 拦截 ---------------- */

  function initState(scene) {
    if (states[scene]) return states[scene];
    var st = { unlocked: false, ticket: loadTicket(scene), el: null, timer: null, pending: null };
    states[scene] = st;
    return st;
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ad-gate]') : null;
    if (!el) return;
    var scene = sceneOf(el);
    var st = states[scene];
    if (st && st.unlocked) return;          // 已解锁：放行，不拦不改
    if (e.preventDefault) e.preventDefault();
    e.stopPropagation();
    if (!st) st = initState(scene);
    st.pending = e.target;
    openGate(scene, el);
  }, true);

  /* ---------------- 首屏静默解锁 ---------------- */
  // 昨天看过的人今天再来，票早过期了；30 分钟内的票还在本地，确认一下就静默认掉，不弹二维码
  function silentCheck() {
    var els = document.querySelectorAll('[data-ad-gate]');
    var seen = {};
    for (var i = 0; i < els.length; i++) {
      var scene = sceneOf(els[i]);
      if (seen[scene]) continue;
      seen[scene] = 1;
      var st = initState(scene);
      if (!st.ticket) continue;
      (function (s) {
        checkTicket(s, states[s].ticket.id).then(function (d) {
          if (d.done) unlock(s);
          else if (d.expired) states[s].ticket = null;
        }).catch(function () { /* 网络问题：当没解锁，点的时候再出票 */ });
      })(scene);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', silentCheck);
  } else {
    silentCheck();
  }

  window.AdGate = {
    // 只读：这个门槛解锁了没（本地判断，不发请求）
    isDone: function (scene) {
      var st = states[normScene(scene)];
      return !!(st && st.unlocked);
    },
    // 主动查一次（给自己的服务端用：拿到 true 才把它要的东西给出去）
    check: function (scene) {
      var s = normScene(scene);
      var st = initState(s);
      if (st.unlocked) return Promise.resolve(true);
      if (!st.ticket) return Promise.resolve(false);
      return checkTicket(s, st.ticket.id).then(function (d) {
        if (d.done) { unlock(s); return true; }
        return false;
      }).catch(function () { return false; });
    },
    // 调试用：清掉本地这张票（相当于「这个人没看过」）
    reset: function (scene) {
      var s = normScene(scene);
      dropTicket(s);
      if (states[s]) { states[s].unlocked = false; states[s].ticket = null; }
      var els = document.querySelectorAll('[data-ad-gate]');
      for (var i = 0; i < els.length; i++) if (sceneOf(els[i]) === s) els[i].removeAttribute('data-ad-gate-done');
    },
    open: function (scene) {
      var s = normScene(scene);
      openGate(s, document.querySelector('[data-ad-gate="' + s + '"]'));
    }
  };
})();
