/**
 * 分享卡片：用 Canvas 现场绘制 1080×1350 的图片
 * 内容 = 作品截图 + 标题 + 标签 + 简介 + 数据 + 二维码 + 站点品牌
 * 依赖：全局 typesOf / TYPE_ICONS（来自 app.js），二维码由 /api/qr 生成
 */
(function () {
  const W = 1080, H = 1350, PAD = 72;
  const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif';

  // 三套配色：浅色（默认）/ 深色 / 品牌渐变
  const TPLS = {
    light: {
      cardName: '浅色',
      bg: ['#ffffff', '#f5f4ff', '#ecebff'],
      text: '#181728', sub: '#6d6c88',
      border: 'rgba(24,23,40,.08)',
      pillBg: 'rgba(91,91,214,.09)', pillText: '#4a4ac4',
      glow1: 'rgba(124,124,240,.20)', glow2: 'rgba(236,120,180,.14)',
      shadow: 'rgba(38,34,92,.16)',
      logoGrad: ['#6d6df0', '#a855f7'],
      qrPad: '#ffffff', qrBorder: 'rgba(24,23,40,.10)'
    },
    dark: {
      cardName: '深色',
      bg: ['#15141f', '#1d1a33', '#241f3d'],
      text: '#f6f5ff', sub: '#a6a3c6',
      border: 'rgba(255,255,255,.10)',
      pillBg: 'rgba(150,150,255,.16)', pillText: '#c9c7ff',
      glow1: 'rgba(110,90,240,.42)', glow2: 'rgba(200,90,160,.26)',
      shadow: 'rgba(0,0,0,.55)',
      logoGrad: ['#7b7bf8', '#c05cf0'],
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
      logoGrad: ['#ffffff', '#efe9ff'],
      qrPad: '#ffffff', qrBorder: 'rgba(255,255,255,.5)'
    }
  };

  let current = null;      // 当前卡片对应的作品
  let tpl = 'light';
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

  function drawCover(ctx, img, x, y, w, h, r) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    const s = Math.max(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
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
    const mobile = typeof isMobileTypes === 'function' && isMobileTypes(typesOf(work));

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

    // 品牌头部
    const logoSize = 64;
    const lg = ctx.createLinearGradient(PAD, 58, PAD + logoSize, 58 + logoSize);
    lg.addColorStop(0, t.logoGrad[0]);
    lg.addColorStop(1, t.logoGrad[1]);
    ctx.fillStyle = lg;
    roundRect(ctx, PAD, 58, logoSize, logoSize, 19);
    ctx.fill();
    ctx.fillStyle = tpl === 'grad' ? '#5b5bd6' : '#ffffff';
    star(ctx, PAD + logoSize / 2, 58 + logoSize / 2, 18);
    ctx.fill();

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = t.text;
    ctx.font = `700 36px ${FONT}`;
    ctx.fillText('造梦橱窗', PAD + logoSize + 18, 58);
    ctx.fillStyle = t.sub;
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText('让好作品被更多人看见', PAD + logoSize + 18, 100);

    // 作品截图
    const imgX = PAD, imgY = 156, imgW = W - PAD * 2, imgH = 556;
    ctx.save();
    ctx.shadowColor = t.shadow;
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = t.qrPad;
    roundRect(ctx, imgX, imgY, imgW, imgH, 26);
    ctx.fill();
    ctx.restore();

    const shot = imgOk.get(work.image);
    if (shot) {
      if (mobile) {
        // 竖屏截图：铺满浅色底再等比缩放，避免被裁掉关键内容
        ctx.save();
        roundRect(ctx, imgX, imgY, imgW, imgH, 26);
        ctx.clip();
        ctx.fillStyle = tpl === 'dark' ? '#0f0e19' : '#f7f7fd';
        ctx.fillRect(imgX, imgY, imgW, imgH);
        drawContain(ctx, shot, imgX + 12, imgY + 12, imgW - 24, imgH - 24);
        ctx.restore();
      } else {
        drawCover(ctx, shot, imgX, imgY, imgW, imgH, 26);
      }
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

    // 标题
    const maxTextW = W - PAD * 2;
    ctx.fillStyle = t.text;
    ctx.font = `700 52px ${FONT}`;
    const titleLines = clipLines(ctx, wrap(ctx, work.title, maxTextW), 2, maxTextW);
    let ty = 762;
    titleLines.forEach(l => { ctx.fillText(l, PAD, ty); ty += 66; });
    const titleBottom = ty - 66 + 52;

    // 作者
    ctx.fillStyle = t.sub;
    ctx.font = `400 28px ${FONT}`;
    const authorText = `${work.verified ? '✔ ' : ''}@${work.authorName || work.author || '匿名'}${work.category ? ' · ' + work.category : ''}`;
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
    const urlText = cardUrl(work);
    ctx.fillText(clipLines(ctx, wrap(ctx, urlText, leftW), 1, leftW)[0] || '', PAD, 1208);
    ctx.font = `400 22px ${FONT}`;
    const statsText = `♥ ${fmtNum(work.likes)} · ★ ${fmtNum(work.favs)} · 💬 ${fmtNum(work.commentCount)} · 👁 ${fmtNum(work.views)}`;
    ctx.fillText(clipLines(ctx, wrap(ctx, statsText, leftW), 1, leftW)[0] || '', PAD, 1246);
  }

  function cardUrl(work) {
    return location.origin + '/w/' + encodeURIComponent(work.id);
  }

  // ---------- 渲染（含图片/二维码加载） ----------
  async function render(work) {
    const cv = $('shareCanvas');
    if (!cv) return;
    cv.classList.add('loading');

    // 作品图先加载（同图复用缓存），失败则画占位块
    await cachedImage(work.image);

    // 二维码走服务端生成；失败就不画，卡片其余部分照常
    const url = cardUrl(work);
    if (qrSrc !== url) {
      qrSrc = url;
      qrEl = null;
      try {
        qrEl = await loadImage('/api/qr?text=' + encodeURIComponent(url) + '&size=480');
      } catch { qrEl = null; }
    }

    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch { /* 忽略 */ }
    }
    draw(work);
    cv.classList.remove('loading');
  }

  // ---------- 弹窗交互 ----------
  function bindOnce() {
    const modal = $('shareModal');
    if (!modal || modal.__bound) return;
    modal.__bound = true;

    $('closeShare').onclick = () => window.hideModal ? hideModal(modal) : (modal.style.display = 'none');
    modal.querySelectorAll('.tpl-btn').forEach(btn => {
      btn.onclick = () => {
        tpl = btn.dataset.tpl;
        modal.querySelectorAll('.tpl-btn').forEach(b => b.classList.toggle('active', b === btn));
        if (current) draw(current);
      };
    });
    $('shareDownload').onclick = () => {
      if (!current) return;
      const cv = $('shareCanvas');
      try {
        cv.toBlob(blob => {
          if (!blob) { showToast('生成失败，请重试'); return; }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `造梦橱窗-${safeName(current.title)}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          showToast('图片已保存，发朋友圈/小红书都行');
        }, 'image/png');
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
      bindOnce();
      const modal = $('shareModal');
      if (window.showModal) showModal(modal); else modal.style.display = 'flex';
      render(work);
    }
  };
})();
