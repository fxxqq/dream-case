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
  Array.prototype.forEach.call(document.querySelectorAll('.sh-nav .nav-btn[href]'), function (a) {
    var href = '';
    try { href = new URL(a.href, location.href).pathname.replace(/\/+$/, '') || '/'; } catch (e) { return; }
    if (href === path && path !== '/') {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
  });
})();
