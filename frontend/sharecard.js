/**
 * 分享卡片：用 Canvas 现场绘制 1080×1350 的图片
 * 内容 = 作品截图 + 标题 + 标签 + 简介 + 数据 + 二维码 + 站点品牌
 * 依赖：全局 typesOf / TYPE_ICONS（来自 app.js），二维码由 /api/qr 生成
 */
(function () {
  const W = 1080, H = 1350, PAD = 72;
  const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif';

  // 三套配色：浅色（默认，放第一个）/ 品牌渐变 / 深色
  const TPLS = {
    light: {
      cardName: '浅色',
      // 底色不能贴纯白：作品截图多是白底页面，底色带一点薰衣草紫调，截图才沉得下去
      bg: ['#fdfcff', '#f8f6ff', '#f0ecff'],
      text: '#181728', sub: '#6d6c88',
      border: 'rgba(24,23,40,.15)',
      pillBg: 'rgba(91,91,214,.09)', pillText: '#4a4ac4',
      glow1: 'rgba(124,124,240,.20)', glow2: 'rgba(91,91,214,.12)',
      shadow: 'rgba(38,34,92,.24)',
      qrPad: '#ffffff', qrBorder: 'rgba(24,23,40,.14)'
    },
    dark: {
      cardName: '深色',
      bg: ['#15141f', '#1d1a33', '#241f3d'],
      text: '#f6f5ff', sub: '#a6a3c6',
      border: 'rgba(255,255,255,.10)',
      pillBg: 'rgba(150,150,255,.16)', pillText: '#c9c7ff',
      glow1: 'rgba(110,90,240,.42)', glow2: 'rgba(200,90,160,.26)',
      shadow: 'rgba(0,0,0,.55)',
      qrPad: '#ffffff', qrBorder: 'rgba(255,255,255,.16)'
    },
    grad: {
      cardName: '渐变',
      bg: ['#5b5bd6', '#7b5cf0', '#a855f7'],
      text: '#ffffff', sub: 'rgba(255,255,255,.82)',
      border: 'rgba(255,255,255,.22)',
      pillBg: 'rgba(255,255,255,.20)', pillText: '#ffffff',
      glow1: 'rgba(255,255,255,.28)', glow2: 'rgba(120,220,255,.24)',
      shadow: 'rgba(30,20,80,.35)',
      qrPad: '#ffffff', qrBorder: 'rgba(255,255,255,.5)'
    }
  };

  let current = null;      // 当前卡片对应的作品
  let tpl = 'light';
  // 二维码指向：'detail' 本站详情页（默认，所有人都能用）/ 'link' 作者填的作品地址（只给作者本人选）
  // 两种都走 /go 短链，扫码人数和分享者灯火一条都不少
  let qrMode = 'detail';
  let renderSeq = 0;       // 切模式可能连点，只认最后一次渲染
  const imgCache = new Map();  // src -> Promise<Image|null>（去重同图请求）
  const imgOk = new Map();     // src -> 已加载完成的 Image（绘制时用）
  let qrEl = null;             // 已加载的二维码图
  let qrSrc = '';              // 二维码对应的作品地址

  const $ = id => document.getElementById(id);

  // ---------- 基础绘制工具 ----------
  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function star(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r * 0.44 : r;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  function radial(ctx, x, y, r, color) {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  function clipLines(ctx, lines, maxLines, maxW) {
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = last + '…';
    return kept;
  }

  function wrap(ctx, text, maxW) {
    const out = [];
    let line = '';
    for (const ch of Array.from(String(text || ''))) {
      if (ch === '\n') { out.push(line); line = ''; continue; }
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = ch; }
      else line = test;
    }
    if (line) out.push(line);
    return out;
  }

  function drawContain(ctx, img, x, y, w, h) {
    const s = Math.min(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片加载失败'));
      im.src = src;
    });
  }

  function cachedImage(src) {
    if (!src) return Promise.resolve(null);
    if (imgOk.has(src)) return Promise.resolve(imgOk.get(src));
    if (imgCache.has(src)) return imgCache.get(src);
    const p = loadImage(src)
      .then(im => { imgOk.set(src, im); return im; })
      .catch(() => { imgCache.delete(src); return null; });
    imgCache.set(src, p);
    return p;
  }

  // 品牌 logo：直接用站点的 logo.svg（Canvas 画 SVG 需要根节点带宽高，注入后再加载）
  // path 自带的 fill="#5b5bd6" 会覆盖根节点继承，所以两处都注入目标色（浅色卡品牌紫 / 深色·渐变卡白色）
  const logoCache = new Map();   // color -> Promise<Image|null>
  const logoImgs = new Map();    // color -> Image|null（加载完成后，draw 同步取用）
  function loadLogo(color) {
    if (!logoCache.has(color)) {
      logoCache.set(color, fetch('/logo.svg')
        .then(r => r.text())
        .then(raw => {
          const sized = raw.replace('<svg ', `<svg width="1024" height="1024" fill="${color}" `)
            .replace(/fill="#5b5bd6"/g, `fill="${color}"`);
          return loadImage(URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' })));
        })
        .then(im => { logoImgs.set(color, im); return im; })
        .catch(() => { logoImgs.set(color, null); return null; }));
    }
    return logoCache.get(color);
  }

  function safeName(s) {
    return String(s || '作品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n);
  }

  // ---------- 绘制主函数 ----------
  function draw(work) {
    const t = TPLS[tpl] || TPLS.light;
    const cv = $('shareCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 背景
    const bg = ctx.createLinearGradient(0, 0, W, H);
    t.bg.forEach((c, i) => bg.addColorStop(i / (t.bg.length - 1), c));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, 90, 60, 560, t.glow1);
    radial(ctx, W + 40, H * 0.46, 520, t.glow2);
    radial(ctx, 60, H - 120, 460, t.glow1);

    // 品牌头部：logo 不加底色块，按配色直接画（浅色卡品牌紫，深色/渐变卡白色）
    const logoSize = 64;
    const logoColor = tpl === 'light' ? '#5b5bd6' : '#ffffff';
    const logoImg = logoImgs.get(logoColor);
    if (logoImg) {
      ctx.drawImage(logoImg, PAD, 58, logoSize, logoSize);
    } else {
      ctx.fillStyle = logoColor;
      star(ctx, PAD + logoSize / 2, 58 + logoSize / 2, 18);
      ctx.fill();
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = t.text;
    ctx.font = `700 36px ${FONT}`;
    ctx.fillText('造梦橱窗', PAD + logoSize + 18, 58);
    ctx.fillStyle = t.sub;
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText('让每一个用心的作品，被更多人看见', PAD + logoSize + 18, 116);

    // 作品截图：不裁剪，按原图比例展示，最高 556；下方文字随图片实际高度上移
    const imgX = PAD, imgY = 156, imgW = W - PAD * 2, maxImgH = 556;
    const shot = imgOk.get(work.image);
    let imgH = maxImgH;
    if (shot) imgH = Math.min(maxImgH, Math.round(imgW * shot.height / shot.width));

    ctx.save();
    ctx.shadowColor = t.shadow;
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = t.qrPad;
    roundRect(ctx, imgX, imgY, imgW, imgH, 26);
    ctx.fill();
    ctx.restore();

    if (shot) {
      ctx.save();
      roundRect(ctx, imgX, imgY, imgW, imgH, 26);
      ctx.clip();
      if (imgH >= maxImgH) {
        // 图比上限更高（竖图/方图）：等比缩放完整放入，两侧留底色，不裁掉内容
        ctx.fillStyle = tpl === 'dark' ? '#0f0e19' : '#f7f7fd';
        ctx.fillRect(imgX, imgY, imgW, imgH);
        drawContain(ctx, shot, imgX + 12, imgY + 12, imgW - 24, imgH - 24);
      } else {
        // 横图：完整铺满宽度，高度按原图比例
        ctx.drawImage(shot, imgX, imgY, imgW, imgH);
      }
      ctx.restore();
    } else {
      ctx.save();
      roundRect(ctx, imgX, imgY, imgW, imgH, 26);
      ctx.clip();
      const ph = ctx.createLinearGradient(imgX, imgY, imgX + imgW, imgY + imgH);
      ph.addColorStop(0, 'rgba(124,124,240,.35)');
      ph.addColorStop(1, 'rgba(168,85,247,.35)');
      ctx.fillStyle = ph;
      ctx.fillRect(imgX, imgY, imgW, imgH);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = `700 300px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(safeName(work.title).slice(0, 1), imgX + imgW / 2, imgY + imgH / 2 - 150);
      ctx.restore();
    }
    // 截图细边框
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 2;
    roundRect(ctx, imgX, imgY, imgW, imgH, 26);
    ctx.stroke();

    ctx.textAlign = 'left';

    // 标题（紧跟截图下方，随图片高度自适应）
    const maxTextW = W - PAD * 2;
    ctx.fillStyle = t.text;
    ctx.font = `700 52px ${FONT}`;
    const titleLines = clipLines(ctx, wrap(ctx, work.title, maxTextW), 2, maxTextW);
    let ty = imgY + imgH + 50;
    titleLines.forEach(l => { ctx.fillText(l, PAD, ty); ty += 66; });
    const titleBottom = ty - 66 + 52;

    // 作者
    ctx.fillStyle = t.sub;
    ctx.font = `400 28px ${FONT}`;
    const authorText = `@${work.authorName || work.author || '匿名'}${work.category ? ' · ' + work.category : ''}`;
    ctx.fillText(clipLines(ctx, wrap(ctx, authorText, maxTextW), 1, maxTextW)[0] || '', PAD, titleBottom + 18);

    // 标签胶囊（紧跟作者行，随标题行数自适应）
    const types = (typeof typesOf === 'function' ? typesOf(work) : [work.type || 'Web']).slice(0, 4);
    const labels = types.map(x => `${(typeof TYPE_ICONS === 'object' && TYPE_ICONS[x]) || '✨'} ${x}`);
    if (work.openSource === true) labels.push('🔓 开源');
    if (work.paid === true) labels.push('💰 付费');
    let px = PAD;
    const pillY = titleBottom + 18 + 28 + 22, pillH = 44;
    ctx.font = `500 24px ${FONT}`;
    labels.forEach(label => {
      const w = ctx.measureText(label).width + 36;
      if (px + w > W - PAD) return;
      ctx.fillStyle = t.pillBg;
      roundRect(ctx, px, pillY, w, pillH, pillH / 2);
      ctx.fill();
      ctx.fillStyle = t.pillText;
      ctx.fillText(label, px + 18, pillY + 10);
      px += w + 12;
    });

    // 简介
    const intro = String(work.intro || work.prompt || '').replace(/\s+/g, ' ').trim();
    if (intro) {
      ctx.fillStyle = t.sub;
      ctx.font = `400 28px ${FONT}`;
      const lines = clipLines(ctx, wrap(ctx, intro, maxTextW), 2, maxTextW);
      let iy = pillY + pillH + 26;
      lines.forEach(l => { ctx.fillText(l, PAD, iy); iy += 44; });
    }

    // 分割线
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, 1136);
    ctx.lineTo(W - PAD, 1136);
    ctx.stroke();

    // 页脚：左文案 + 右二维码
    const qrSize = 138, qrX = W - PAD - qrSize, qrY = 1152;
    ctx.save();
    ctx.shadowColor = t.shadow;
    ctx.shadowBlur = 24;
    ctx.fillStyle = t.qrPad;
    roundRect(ctx, qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 16);
    ctx.fill();
    ctx.restore();
    if (qrEl) {
      ctx.drawImage(qrEl, qrX, qrY, qrSize, qrSize);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.06)';
      roundRect(ctx, qrX, qrY, qrSize, qrSize, 10);
      ctx.fill();
    }

    const leftW = qrX - PAD - 40;
    ctx.fillStyle = t.text;
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText('扫码打开作品 · 长按识别', PAD, 1160);
    ctx.fillStyle = t.sub;
    ctx.font = `400 21px ${FONT}`;
    const urlText = cardUrlText(work);
    ctx.fillText(clipLines(ctx, wrap(ctx, urlText, leftW), 1, leftW)[0] || '', PAD, 1208);
    ctx.font = `400 22px ${FONT}`;
    const statsText = `♥ ${fmtNum(work.likes)} · ★ ${fmtNum(work.favs)} · 💬 ${fmtNum(work.commentCount)} · 👁 ${fmtNum(work.views)}`;
    ctx.fillText(clipLines(ctx, wrap(ctx, statsText, leftW), 1, leftW)[0] || '', PAD, 1246);
  }

  // 作品填的第一个外部入口（官网 / 各形态链接）。没有外链的作品（含只上传了小程序码的）
  // 只有详情页一个选项，不给切。
  function linkTarget(work) {
    return (work && work.qrReal && Array.isArray(work.qrTargets)) ? (work.qrTargets[0] || null) : null;
  }

  // 作品页链接：「复制文案」永远用这个（站内链接，带分享者 ref，注册归因靠它）
  function cardUrl(work) {
    const base = location.origin + '/w/' + encodeURIComponent(work.id);
    return typeof withRef === 'function' ? withRef(base) : base;
  }

  // 作品填的第一个外部入口地址（官网 / 各形态链接）。
  // 顺序必须和服务端 qrTargetsOf 一致：site 优先 → 按形态顺序找 links → 最后 link；
  // 纯小程序作品的 link 是「了解详情」页不是使用入口，同样跳过。
  // qrTargets 下发的是短链码（没有原地址），所以印在卡上的网址要前端自己解析
  function firstEntryUrl(work) {
    if (!work) return '';
    const site = String(work.site || '').trim();
    if (site) return site;
    const types = (typeof typesOf === 'function' ? typesOf(work) : []);
    const links = work.links || {};
    for (const t of types) {
      const u = String(links[t] || '').trim();
      if (u) return u;
    }
    const miniOnly = types.length > 0 && types.every(t => t === '小程序');
    const link = String(work.link || '').trim();
    if (link && !miniOnly) return link;
    return '';
  }

  // 印在卡片上的地址文案：不印 ref，海报上干净一点；跟着二维码指向换
  function cardUrlText(work) {
    const own = qrMode === 'link' ? firstEntryUrl(work) : '';
    const u = own || (location.origin + '/w/' + encodeURIComponent(work.id));
    return u.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }

  function cardQrUrl(work) {
    // 二维码一律走站内短链 /go/<code>?ref=<分享者>：扫码先经过我们服务器，
    // 才能记「扫码人数」（同设备同作品一天 1 个人）并给分享者计灯火（+3）。
    // 指向详情页时用的是单独一张 detail 码，302 到 /w/<id>，不把扫码的人送出站。
    const ref = typeof myRefName === 'function' ? myRefName() : '';
    const tail = ref ? '?ref=' + encodeURIComponent(ref) : '';
    const link = qrMode === 'link' ? linkTarget(work) : null;
    const code = (link && link.code) || (work && work.qrDetailCode) || '';
    if (!code) return cardUrl(work);   // 老服务端没下发 detail 码：退回详情页地址（只是没法计扫码）
    return location.origin + '/go/' + encodeURIComponent(code) + tail;
  }

  // ---------- 二维码指向（只有作者分享自己的作品、且作品填了外链时才出现） ----------
  function canPickMode(work) {
    return !!(work && work.owned && linkTarget(work));
  }
  function syncQrMode(work) {
    const row = $('shareQrMode');
    const hint = $('shareQrHint');
    const show = canPickMode(work);
    if (row) {
      row.style.display = show ? '' : 'none';
      row.querySelectorAll('[data-qrmode]').forEach(b => b.classList.toggle('active', b.dataset.qrmode === qrMode));
    }
    if (hint) {
      hint.style.display = show ? '' : 'none';
      hint.textContent = qrMode === 'link'
        ? '扫码直达你填的作品链接，不经过站内详情页。'
        : '扫码先到站内详情页：图和介绍都在，人也留在站里，更容易被别的作品带走。';
    }
  }

  // ---------- 渲染（含图片/二维码加载） ----------
  async function render(work) {
    const cv = $('shareCanvas');
    if (!cv) return;
    const seq = ++renderSeq;
    cv.classList.add('loading');

    // 作品图先加载（同图复用缓存），失败则画占位块
    await cachedImage(work.image);
    if (seq !== renderSeq) return;

    // 品牌 logo 预加载（浅色卡品牌紫，深色/渐变卡白色）
    await loadLogo(tpl === 'light' ? '#5b5bd6' : '#ffffff');
    if (seq !== renderSeq) return;

    // 二维码走服务端生成；失败就不画，卡片其余部分照常
    const url = cardQrUrl(work);
    if (qrSrc !== url) {
      qrSrc = url;
      qrEl = null;
      try {
        qrEl = await loadImage('/api/qr?text=' + encodeURIComponent(url) + '&size=480');
      } catch { qrEl = null; }
      if (seq !== renderSeq) return;   // 加载期间又切了模式：这次结果丢掉
    }

    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch { /* 忽略 */ }
    }
    if (seq !== renderSeq) return;
    draw(work);
    cv.classList.remove('loading');
  }

  // 长按保存兜底：用 <img> 盖住 canvas，点一下（或切配色/重开弹窗）即恢复
  function showLongPressSave(blob) {
    const cv = $('shareCanvas');
    if (!cv) return;
    const preview = cv.parentElement;
    let img = preview.querySelector('.save-overlay');
    if (!img) {
      img = document.createElement('img');
      img.className = 'save-overlay';
      img.alt = '长按保存这张分享卡片';
      preview.appendChild(img);
      img.addEventListener('click', () => img.classList.remove('show'));
    }
    img.src = URL.createObjectURL(blob);
    img.onload = () => {
      img.classList.add('show');
      showToast('长按图片即可保存到相册');
    };
    setTimeout(() => URL.revokeObjectURL(img.src), 60000);
  }
  // 任何会重绘 canvas 的操作都先把覆盖图收起来
  function hideLongPressSave() {
    const preview = $('shareCanvas');
    if (!preview) return;
    const img = preview.parentElement && preview.parentElement.querySelector('.save-overlay');
    if (img) img.classList.remove('show');
  }

  // ---------- 灯火提示 ----------
  // 卡片上的二维码/链接只在登录后才带 ref（见 app.js 的 withRef），未登录分享出去一分不赚。
  // 所以未登录只讲规则、不写「分享就送」，避免对游客撒谎。
  function myPoints() {
    try {
      const u = (typeof state !== 'undefined' && state && state.user) ? state.user : null;
      return u ? (typeof u.points === 'number' ? u.points : 0) : null;   // null = 未登录
    } catch { return null; }
  }
  function syncLampTip() {
    const el = $('shareLampTip');
    if (!el) return;
    const pts = myPoints();
    if (pts === null) {
      el.className = 'share-lamp-tip is-guest show';
      el.innerHTML = '<button type="button" class="lamp-login">登录</button>后这张卡片才会带上你的身份：好友扫码打开 <b>+3</b> 盏灯火，注册 <b>+100</b>';
    } else {
      el.className = 'share-lamp-tip show';
      el.innerHTML = `好友扫码打开 <b>+3</b> 盏灯火（同一人每天计 1 次），注册 <b>+100</b> · 你当前 <b>${pts}</b> 盏`;
    }
  }

  // ---------- 弹窗交互 ----------
  function bindOnce() {
    const modal = $('shareModal');
    if (!modal || modal.__bound) return;
    modal.__bound = true;

    $('closeShare').onclick = () => window.hideModal ? hideModal(modal) : (modal.style.display = 'none');
    // 未登录时提示里的「登录」是可点的：先把分享弹窗收掉再开登录框，避免两层遮罩叠着
    const lampEl = $('shareLampTip');
    if (lampEl) {
      lampEl.onclick = (e) => {
        if (!e.target.closest('.lamp-login')) return;
        if (window.hideModal) hideModal(modal); else modal.style.display = 'none';
        if (typeof openAuth === 'function') openAuth('login');
      };
    }
    modal.querySelectorAll('.tpl-btn[data-tpl]').forEach(btn => {
      btn.onclick = async () => {
        tpl = btn.dataset.tpl;
        modal.querySelectorAll('.tpl-btn[data-tpl]').forEach(b => b.classList.toggle('active', b === btn));
        hideLongPressSave();
        if (current) {
          // 切配色先确保对应颜色的 logo 已加载（浅色紫 / 深色·渐变白），否则会画成五角星兜底
          await loadLogo(tpl === 'light' ? '#5b5bd6' : '#ffffff');
          draw(current);
        }
      };
    });
    // 二维码指向：切了要重画（二维码和底部地址文案都会变）
    modal.querySelectorAll('[data-qrmode]').forEach(btn => {
      btn.onclick = () => {
        const next = btn.dataset.qrmode;
        if (next === qrMode) return;
        qrMode = next;
        syncQrMode(current);
        hideLongPressSave();
        if (current) render(current);
      };
    });
    $('shareDownload').onclick = () => {
      if (!current) return;
      const cv = $('shareCanvas');
      const done = (blob, name) => {
        if (!blob) { showToast('生成失败，请重试'); return; }
        // 保存逻辑统一走 app.js 的 saveImage：iOS 走系统分享面板 / 长按存相册，
        // 桌面和安卓仍是普通下载。以前三处各写一套，iOS 上最容易漏的就是兜底。
        if (typeof saveImage === 'function') {
          saveImage(blob, {
            name,
            iosHint: '分享卡片',
            fallback: b => showLongPressSave(b, name),
            toastOk: myPoints() === null
              ? '图片已保存 · 登录后再分享才计灯火'
              : '图片已保存 · 有人扫码打开就有灯火'
          });
          return;
        }
        // saveImage 没加载出来（理论上不会）：退回老路子
        if (navigator.canShare && navigator.share) {
          try {
            const file = new File([blob], name, { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
              navigator.share({ files: [file], title: name }).catch(() => { /* 用户取消 */ });
              return;
            }
          } catch { /* 老浏览器不支持 */ }
        }
        if ('ontouchstart' in window) { showLongPressSave(blob, name); return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showToast(myPoints() === null
          ? '图片已保存 · 登录后再分享才计灯火'
          : '图片已保存 · 有人扫码打开就有灯火');
      };
      try {
        cv.toBlob(b => done(b, `造梦橱窗-${safeName(current.title)}.png`), 'image/png');
      } catch {
        showToast('图片跨域受限，暂时无法导出');
      }
    };
    $('shareCopyText').onclick = async () => {
      if (!current) return;
      const types = (typeof typesOf === 'function' ? typesOf(current) : []).join('/');
      const intro = String(current.intro || '').replace(/\s+/g, ' ').trim();
      const text = [
        `【${current.title}】${intro ? '—— ' + intro.slice(0, 60) : ''}`,
        `作者 @${current.authorName || current.author || '匿名'}${types ? ' · ' + types : ''}${current.category ? ' · ' + current.category : ''}`,
        `👉 ${cardUrl(current)}`,
        '来自「造梦橱窗」：每一个认真做出的想法，都值得被看见'
      ].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        showToast('文案已复制，去粘贴吧');
      } catch {
        showToast('复制失败，请手动选择文字');
      }
    };
  }

  window.ShareCard = {
    open(work) {
      if (!work) return;
      current = work;
      // 默认：别人分享 → 站内详情页；作者分享自己的 → 他填的作品地址（作者最想导流到自己产品）
      qrMode = (work.owned && linkTarget(work)) ? 'link' : 'detail';
      bindOnce();
      syncQrMode(work);
      hideLongPressSave();
      syncLampTip();
      const modal = $('shareModal');
      if (window.showModal) showModal(modal); else modal.style.display = 'flex';
      render(work);
    }
  };
})();
