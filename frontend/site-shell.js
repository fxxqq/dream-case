/*
 * 独立页公共站头脚本（2026-11-25）
 * 只做两件事：当前页高亮 + 登录态。图标水合仍由 /icons.js 负责（本页在 head 同步引入）。
 * 登录态走 /api/me/brief——那是专门给站头用的无副作用接口，
 * 不能换回 /api/me：那个会触发到访奖励/旧昵称兜底，纯偏好页上不该有这种动静。
 */
(function () {
  'use strict';
  var box = document.getElementById('authBox');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function hydrate(root) {
    if (window.Icons) window.Icons.hydrate(root || document);
  }

  // 站头「更多」下拉：独立页不引 app.js，这里自己管开合；菜单项都是普通链接。
  (function () {
    var wrap = document.getElementById('navMore'), btn = document.getElementById('navMoreBtn'), menu = document.getElementById('navMoreMenu');
    if (!wrap || !btn || !menu) return;
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('is-open');
      if (refocus) btn.focus();
    }
    btn.onclick = function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      wrap.classList.toggle('is-open', open);
    };
    menu.addEventListener('click', function (e) { if (e.target.closest('.nav-menu-item')) close(); });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(true); });
  })();

  // 未登录先画上入口，接口慢了也不留一块空白。
  function renderAuth(ok, name) {
    if (!box) return;
    box.innerHTML = ok
      ? '<a class="sh-user" href="/me" title="我的主页"><span class="ico" data-ico="user"></span><b>' + esc(name || '我') + '</b></a>'
      : '<a class="sh-login" href="/?login=1">登录 / 注册</a>';
    hydrate(box);
  }
  renderAuth(false, '');
  fetch('/api/me/brief', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { renderAuth(!!(d && d.loggedIn), d && d.name); })
    .catch(function () { /* 保持游客态，站头空着也不影响本页功能 */ });

  // 当前页高亮：按链接路径认，不按写死的页面名——以后公共模板加/改一项，这里不用动。
  var path = location.pathname.replace(/\/+$/, '') || '/';
  // 只认顶层导航项：下拉里的 /mini、/app 是「更多」的菜单项，不该在那些页亮成当前项
  Array.prototype.forEach.call(document.querySelectorAll('.sh-nav .nav-tabs > .nav-btn[href]'), function (a) {
    var href = '';
    try { href = new URL(a.href, location.href).pathname.replace(/\/+$/, '') || '/'; } catch (e) { return; }
    if (href === path && path !== '/') {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
  });
})();
