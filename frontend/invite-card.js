/**
 * 邀请收录页的分享海报：Canvas 现场绘制 1080×1350
 *
 * 与作品分享卡（sharecard.js）保持同一套视觉语言：三套配色、品牌 logo、右下角二维码，
 * 但内容换成「邀请创作者来投稿」，不展示任何单个作品。
 *
 * 依赖：站内 /logo.svg、/api/qr、/api/me；保存图片优先复用 app.js 的 saveImage
 *（iOS 分享面板 / 长按保存兜底都在那里），app.js 未就绪时退回普通下载。
 * 本脚本比 app.js 先执行，所以登录态自己取，不读 app.js 的 state。
 */
(function () {
  'use strict';

  var W = 1080, H = 1350, PAD = 72;
  var FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif';
  var SITE = '造梦橱窗';

  // 与 /sharecard.js 完全一致的配色，保证「同一个站发出的卡片」长得很像
  var TPLS = {
    light: {
      bg: ['#ffffff', '#f5f4ff', '#ecebff'],
      text: '#181728', sub: '#6d6c88',
      border: 'rgba(24,23,40,.08)',
      pillBg: 'rgba(91,91,214,.09)', pillText: '#4a4ac4',
      panel: 'rgba(91,91,214,.07)',
      glow1: 'rgba(124,124,240,.20)', glow2: 'rgba(236,120,180,.14)',
      shadow: 'rgba(38,34,92,.16)',
      qrPad: '#ffffff', logo: '#5b5bd6'
    },
    dark: {
      bg: ['#15141f', '#1d1a33', '#241f3d'],
      text: '#f6f5ff', sub: '#a6a3c6',
      border: 'rgba(255,255,255,.10)',
      pillBg: 'rgba(150,150,255,.16)', pillText: '#d3d1ff',
      panel: 'rgba(255,255,255,.07)',
      glow1: 'rgba(110,90,240,.42)', glow2: 'rgba(200,90,160,.26)',
      shadow: 'rgba(0,0,0,.55)',
      qrPad: '#ffffff', logo: '#ffffff'
    },
    grad: {
      bg: ['#5b5bd6', '#7b5cf0', '#a855f7'],
      text: '#ffffff', sub: 'rgba(255,255,255,.84)',
      border: 'rgba(255,255,255,.24)',
      pillBg: 'rgba(255,255,255,.20)', pillText: '#ffffff',
      panel: 'rgba(255,255,255,.14)',
      glow1: 'rgba(255,255,255,.28)', glow2: 'rgba(120,220,255,.24)',
      shadow: 'rgba(30,20,80,.35)',
      qrPad: '#ffffff', logo: '#ffffff'
    }
  };

  var root = document.getElementById('seoContent');
  var cv = document.getElementById('ivCanvas');
  if (!root || !cv || !cv.getContext) return;
  var box = document.getElementById('ivPosterBox');
  var ctx = cv.getContext('2d');
  var tpl = 'grad';
  var qrImg = null, qrFor = '';
  var logoImgs = {}, logoPromises = {};
  var me = null;                 // /api/me 的登录态
  var count = Number(root.dataset.count || 0) || 0;
  // 海报不展示「N 位创作者」：这个数只统计已投稿作者，对外容易被误读成站点注册账号总数
  var SCOPES = ['网站', '小程序', 'App', '智能体', '软件', '游戏'];
  var POINTS = ['免费收录，不用报名也不用付费', '过审就有独立主页，链接固定可分享', '能被搜索、被逛到、被扫码打开'];

  // ---------- 基础绘制工具 ----------
  function roundRect(x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function star(cx, cy, r) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var rad = i % 2 ? r * 0.44 : r;
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }
  function radial(x, y, r, color) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function wrap(text, maxW) {
    var out = [], line = '';
    Array.from(String(text || '')).forEach(function (ch) {
      if (ch === '\n') { out.push(line); line = ''; return; }
      var test = line + ch;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = ch; }
      else line = test;
    });
    if (line) out.push(line);
    return out;
  }
  function fit(text, maxW) {
    var s = String(text || '');
    while (s && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return ctx.measureText(s).width > maxW ? s + '…' : s;
  }
  function loadImage(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('image load failed')); };
      im.src = src;
    });
  }
  // logo.svg 的 path 写死了 fill，注入目标色才能跟着卡片配色变
  function loadLogo(color) {
    if (!logoPromises[color]) {
      logoPromises[color] = fetch('/logo.svg').then(function (r) { return r.text(); })
        .then(function (raw) {
          var sized = raw.replace('<svg ', '<svg width="1024" height="1024" fill="' + color + '" ')
            .replace(/fill="#5b5bd6"/g, 'fill="' + color + '"');
          return loadImage(URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' })));
        })
        .then(function (im) { logoImgs[color] = im; return im; })
        .catch(function () { logoImgs[color] = null; return null; });
    }
    return logoPromises[color];
  }

  // ---------- 链接 ----------
  // 海报上的码固定印正式站点的首页：本地预览时也是线上地址，
  // 否则把本地地址发给别人，对方打不开。取不到服务端注入的域名才退回当前地址。
  var SHARE_BASE = String((root.dataset.shareBase || location.origin || '')).replace(/\/+$/, '');
  function shareHost() { return SHARE_BASE.replace(/^https?:\/\//i, ''); }
  function refName() { return me ? (me.id || me.username || '') : ''; }
  function inviteUrl() {
    var r = refName();
    return SHARE_BASE + '/' + (r ? '?ref=' + encodeURIComponent(r) : '');
  }
  function inviteName() {
    return me ? (me.nickname || me.displayName || me.username || '') : '';
  }
  function inviteText() {
    return [
      '【造梦橱窗 · 邀请你来收录作品】',
      '你亲手做的网站、小程序、App、智能体、软件、游戏，都可以免费收录进来（不用是大项目，认真做完的小工具也算）；提交过审后就有独立主页，能被搜到、被分享、被扫码打开。',
      '作者本人来投就行 → ' + inviteUrl(),
      '来自「造梦橱窗」：目标很朴素，让创作被看见'
    ].join('\n');
  }

  // ---------- 绘制 ----------
  function draw() {
    var t = TPLS[tpl] || TPLS.light;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 背景
    var bg = ctx.createLinearGradient(0, 0, W, H);
    t.bg.forEach(function (c, i) { bg.addColorStop(i / (t.bg.length - 1), c); });
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    radial(90, 60, 560, t.glow1);
    radial(W + 40, H * 0.46, 520, t.glow2);
    radial(60, H - 120, 460, t.glow1);

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // 品牌头部
    var logo = logoImgs[t.logo];
    if (logo) ctx.drawImage(logo, PAD, 58, 64, 64);
    else { ctx.fillStyle = t.logo; star(PAD + 32, 90, 18); ctx.fill(); }
    ctx.fillStyle = t.text;
    ctx.font = '700 36px ' + FONT;
    ctx.fillText(SITE, PAD + 82, 58);
    // 题眼：先说「收录什么」，下面才讲「为什么」。
    // 大标题已含「被更多人看见」，这行小字换成站点定位，不再重复口号。
    ctx.fillStyle = t.pillText;
    ctx.font = '500 24px ' + FONT;
    ctx.fillText('收录独立开发者、创作者自己开发的产品', PAD + 82, 114);

    // 邀请角标
    ctx.fillStyle = t.pillBg;
    roundRect(PAD, 190, 268, 50, 25); ctx.fill();
    ctx.fillStyle = t.pillText;
    ctx.font = '600 23px ' + FONT;
    ctx.fillText('公开邀请 · 免费收录', PAD + 24, 202);

    // 主标题（两行，字号固定，靠 wrap 兜长文本）
    ctx.fillStyle = t.text;
    ctx.font = '700 84px ' + FONT;
    var titleLines = wrap('每一个用心的作品，\n都值得被更多人看见', W - PAD * 2).slice(0, 2);
    var ty = 280;
    titleLines.forEach(function (l) { ctx.fillText(l, PAD, ty); ty += 106; });

    // 副标题
    ctx.fillStyle = t.sub;
    ctx.font = '400 30px ' + FONT;
    var subLines = wrap('不用是大项目，一个认真做完的小工具，也算。', W - PAD * 2).slice(0, 2);
    var sy = ty + 14;
    subLines.forEach(function (l) { ctx.fillText(l, PAD, sy); sy += 46; });

    // 收录范围标签（放不下就自动换行，不硬挤）
    var px = PAD, py = sy + 34, pillH = 52;
    ctx.font = '500 25px ' + FONT;
    SCOPES.forEach(function (s) {
      var w = ctx.measureText(s).width + 44;
      if (px + w > W - PAD) { px = PAD; py += pillH + 12; }
      ctx.fillStyle = t.pillBg;
      roundRect(px, py, w, pillH, pillH / 2); ctx.fill();
      ctx.fillStyle = t.pillText;
      ctx.fillText(s, px + 22, py + 12);
      px += w + 12;
    });

    // 数据面板：数字来自服务端，海报不自己编
    var panelY = py + pillH + 42, panelH = 140;
    ctx.fillStyle = t.panel;
    roundRect(PAD, panelY, W - PAD * 2, panelH, 24); ctx.fill();
    ctx.fillStyle = t.text;
    ctx.font = '700 60px ' + FONT;
    ctx.fillText(String(count), PAD + 34, panelY + 26);
    var nw = ctx.measureText(String(count)).width;
    ctx.font = '400 28px ' + FONT;
    ctx.fillText('件作品已收录', PAD + 44 + nw, panelY + 58);
    ctx.fillStyle = t.sub;
    ctx.font = '400 23px ' + FONT;
    // 海报是对外物料：不印「N 位创作者」的具体数字，容易被误读成站内注册账号总数，只做定性表述
    ctx.fillText('来自独立开发者与创作者 · 持续增加中', PAD + 34, panelY + 102);

    // 三条价值点
    var ly = panelY + panelH + 46;
    POINTS.forEach(function (p) {
      ctx.fillStyle = t.pillText;
      ctx.beginPath(); ctx.arc(PAD + 9, ly + 15, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = t.text;
      ctx.font = '400 29px ' + FONT;
      ctx.fillText(fit(p, W - PAD * 2 - 44), PAD + 36, ly);
      ly += 58;
    });

    // 一句行动指引，收在价值点与页脚之间
    ctx.fillStyle = t.sub;
    ctx.font = '400 24px ' + FONT;
    ctx.fillText('扫码进来 → 提交作品 → 过审上架，全程免费', PAD, ly + 12);

    // 分割线 + 页脚二维码
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(PAD, 1100); ctx.lineTo(W - PAD, 1100); ctx.stroke();

    var qrSize = 160, qrX = W - PAD - qrSize, qrY = 1122;
    ctx.save();
    ctx.shadowColor = t.shadow;
    ctx.shadowBlur = 24;
    ctx.fillStyle = t.qrPad;
    roundRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 16); ctx.fill();
    ctx.restore();
    if (qrImg) ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
    else { ctx.fillStyle = 'rgba(0,0,0,.06)'; roundRect(qrX, qrY, qrSize, qrSize, 10); ctx.fill(); }

    var leftW = qrX - PAD - 40;
    ctx.fillStyle = t.text;
    ctx.font = '700 30px ' + FONT;
    ctx.fillText('扫码来收录你的作品', PAD, 1140);
    ctx.fillStyle = t.sub;
    ctx.font = '400 22px ' + FONT;
    ctx.fillText(fit(shareHost(), leftW), PAD, 1190);
    ctx.font = '400 23px ' + FONT;
    ctx.fillText(fit(inviteName() ? '@' + inviteName() + ' 邀请你' : '作者本人提交 · 审核通过后上架', leftW), PAD, 1232);

    if (box) box.classList.add('is-ready');
  }

  // ---------- 资源加载 ----------
  function loadQr(url) {
    if (qrFor === url && qrImg) return Promise.resolve();
    qrFor = url;
    qrImg = null;
    return loadImage('/api/qr?text=' + encodeURIComponent(url) + '&size=480')
      .then(function (im) { qrImg = im; })
      .catch(function () { qrImg = null; });   // 二维码失败不影响整张卡片
  }
  function render() {
    if (box) box.classList.remove('is-ready');
    hideOverlay();
    return Promise.all([
      loadLogo((TPLS[tpl] || TPLS.light).logo),
      loadQr(inviteUrl())
    ]).then(function () {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready.catch(function () {});
      }
    }).then(draw);
  }

  // ---------- 交互 ----------
  function toast(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    var d = document.createElement('div');
    d.textContent = msg;
    d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;' +
      'background:rgba(28,28,42,.92);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;' +
      'max-width:86vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.2)';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2600);
  }
  function hideOverlay() {
    if (!box) return;
    var old = box.querySelector('.iv-save-overlay');
    if (old) old.classList.remove('show');
  }
  // iOS 上 navigator.share 不可用时，用真实 <img> 盖住 canvas 供长按保存
  function showOverlay(blob) {
    if (!box) return;
    var img = box.querySelector('.iv-save-overlay');
    if (!img) {
      img = document.createElement('img');
      img.className = 'iv-save-overlay';
      img.alt = '长按保存这张邀请海报';
      box.appendChild(img);
      img.addEventListener('click', function () { img.classList.remove('show'); });
    }
    img.src = URL.createObjectURL(blob);
    img.onload = function () { img.classList.add('show'); toast('长按图片即可保存到相册'); };
    setTimeout(function () { URL.revokeObjectURL(img.src); }, 60000);
  }
  function fallbackSave(blob, name) {
    if (navigator.canShare && navigator.share) {
      try {
        var file = new File([blob], name, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: name }).catch(function () {});
          return;
        }
      } catch (e) { /* 老浏览器不支持 */ }
    }
    if ('ontouchstart' in window) { showOverlay(blob); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('海报已保存，可以发给朋友了');
  }
  function save() {
    var name = '造梦橱窗-邀请收录.png';
    try {
      cv.toBlob(function (blob) {
        if (!blob) { toast('生成失败，请重试'); return; }
        if (typeof saveImage === 'function') {
          saveImage(blob, {
            name: name,
            iosHint: '邀请海报',
            fallback: function (b) { showOverlay(b); },
            toastOk: '海报已保存，可以发给朋友了'
          });
        } else fallbackSave(blob, name);
      }, 'image/png');
    } catch (e) { toast('图片导出受限，请换个浏览器试试'); }
  }
  function copy(text, okMsg) {
    function done() { toast(okMsg); }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      ok ? done() : toast('复制失败，请手动选择文字');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(legacy);
    } else legacy();
  }

  function syncTip() {
    var el = document.getElementById('ivLampTip');
    if (!el) return;
    if (me) {
      el.textContent = '海报已带上 @' + inviteName() + ' 的邀请身份：好友从这里进来注册，灯火会记到你名下。';
    } else {
      el.innerHTML = '未登录也能保存海报，只是不带邀请身份。<button type="button" class="iv-login" id="ivLoginBtn" ' +
        'style="border:0;background:none;padding:0;color:#4747c2;font-weight:600;cursor:pointer;text-decoration:underline">登录</button>后刷新本页，海报会带上你的名字。';
      var btn = document.getElementById('ivLoginBtn');
      if (btn) btn.onclick = function () {
        if (typeof openAuth === 'function') openAuth('login');
        else location.href = '/';
      };
    }
  }

  function bind() {
    document.querySelectorAll('.iv-tpl').forEach(function (btn) {
      btn.addEventListener('click', function () {
        tpl = btn.dataset.tpl || 'grad';
        document.querySelectorAll('.iv-tpl').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        loadLogo((TPLS[tpl] || TPLS.light).logo).then(draw);
      });
    });
    var saveBtn = document.getElementById('ivSave');
    if (saveBtn) saveBtn.addEventListener('click', save);
    var copyText = document.getElementById('ivCopyText');
    if (copyText) copyText.addEventListener('click', function () { copy(inviteText(), '邀请文案已复制，去粘贴吧'); });
    var copyLink = document.getElementById('ivCopyLink');
    if (copyLink) copyLink.addEventListener('click', function () { copy(inviteUrl(), '邀请链接已复制'); });
    var jump = document.getElementById('ivJumpPoster');
    if (jump) jump.addEventListener('click', function () {
      var sec = document.getElementById('ivPosterSection');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // 渐进增强：app.js 就绪时直接开投稿弹窗；否则按普通链接回首页
    document.querySelectorAll('[data-iv-submit]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var btn = document.getElementById('openUpload');
        if (!btn || typeof openAuth !== 'function') return;
        e.preventDefault();
        btn.click();
      });
    });
  }

  bind();
  syncTip();
  render();
  // 登录态回来后重画二维码（带上 ref）与署名
  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var u = d && d.user !== undefined ? d.user : d;
      // /api/me 未登录返回 { user: null }；有 id 才算登录
      if (u && u.id) { me = u; syncTip(); render(); }
    })
    .catch(function () {});
})();
