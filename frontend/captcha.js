/**
 * 人机验证（滑块拼图）—— 浏览器端
 *
 * 用法：
 *   const ticket = await ZmCaptcha.open();   // 用户取消返回 null；拿到票再调 /api/sms/send
 *
 * 与服务端的约定见根目录 captcha.js。两边有两处必须一字不差地一致：
 *   1. GEO 几何常量（画布尺寸、块大小、缺口取值范围、容差）
 *   2. deriveGap()：后端用 seed 算答案，前端用同一个 seed 算出同样的位置才画得对
 * 改任何一处都要同步改另一边，否则全站拖不过验证（而且因为容差小，只会表现为「怎么都对不上」）。
 *
 * 为什么背景是程序化画的而不是一张图：
 * 项目零依赖、没有图床素材，程序化生成反而更好——每张题都不一样，截图无法复用。
 * 缺点也说清楚：拼图位置最终存在于前端 JS 的变量里，懂逆向的人能取到。
 * 这一层的目标是「挡住直接 curl 的脚本」，不是对抗逆向；再往上要服务端出图或接第三方验证码。
 */
(function () {
  'use strict';

  // 与 captcha.js 的 GEO 保持一致
  const GEO = { w: 320, h: 160, piece: 46, gapMin: 56, gapMax: 266, tol: 7 };
  const HANDLE = 44;              // 手柄直径（px，CSS 与逻辑坐标同值，随轨道一起缩放）
  const MAX_TRACK = 320;          // 轨迹点上限，服务端也卡 400，留点余量

  // 与后端 deriveGap 完全一致（murmur3 尾部混淆）
  function deriveGap(seed) {
    let h = (Number(seed) ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return GEO.gapMin + (h % (GEO.gapMax - GEO.gapMin + 1));
  }

  // xorshift32：同一个 seed 画出同一张图，方便「刷新题目」时不会看起来还是旧图
  function rngOf(seed) {
    let s = (Number(seed) || 1) >>> 0;
    if (!s) s = 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /* ---------------- 样式（只注入一次） ---------------- */
  const CSS = `
  .zmcap-mask{position:fixed;inset:0;background:rgba(16,18,28,.55);display:flex;align-items:center;justify-content:center;
    z-index:99998;padding:16px;-webkit-tap-highlight-color:transparent}
  .zmcap-box{width:352px;max-width:100%;background:var(--card,#fff);color:var(--text,#1f2330);border-radius:16px;
    padding:16px 16px 14px;box-shadow:0 24px 60px rgba(0,0,0,.28);font-size:14px;box-sizing:border-box}
  .zmcap-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
  .zmcap-head b{font-size:15px}
  .zmcap-x{border:0;background:transparent;color:var(--muted,#7a8095);font-size:22px;line-height:1;
    cursor:pointer;padding:2px 4px;border-radius:8px}
  .zmcap-x:hover{background:rgba(0,0,0,.06)}
  .zmcap-tip{margin:2px 0 10px;color:var(--muted,#7a8095);font-size:12.5px;line-height:1.5}
  .zmcap-stage{position:relative;width:100%;aspect-ratio:320/160;border-radius:12px;overflow:hidden;background:#eef0f7}
  .zmcap-stage canvas{display:block;width:100%;height:100%;touch-action:none}
  .zmcap-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--muted,#7a8095);font-size:13px;background:rgba(238,240,247,.9)}
  .zmcap-loading[hidden]{display:none}
  .zmcap-track{position:relative;height:44px;margin-top:12px;border-radius:22px;background:var(--bg,#f7f7fb);
    border:1px solid var(--border,#e6e8f0);overflow:hidden;touch-action:none;user-select:none}
  .zmcap-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(91,91,214,.14)}
  .zmcap-handle{position:absolute;left:0;top:0;width:44px;height:44px;border-radius:22px;background:var(--primary,#5b5bd6);
    color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px;cursor:grab;
    box-shadow:0 2px 8px rgba(91,91,214,.35);transition:background .15s}
  .zmcap-track.ok .zmcap-handle{background:#1a7f37;box-shadow:0 2px 8px rgba(26,127,55,.35)}
  .zmcap-track.bad .zmcap-handle{background:#c0392b;box-shadow:0 2px 8px rgba(192,57,43,.35)}
  .zmcap-track-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-size:12.5px;color:var(--muted,#7a8095);pointer-events:none}
  .zmcap-msg{margin-top:8px;font-size:12.5px;line-height:1.5;min-height:18px;color:var(--muted,#7a8095)}
  .zmcap-msg.err{color:#c0392b}
  .zmcap-msg.ok{color:#1a7f37}
  `;

  function injectCss() {
    if (document.getElementById('zmcap-style')) return;
    const st = document.createElement('style');
    st.id = 'zmcap-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------------- 状态 ---------------- */
  let maskEl = null;
  let cv = null, ctx = null;
  let trackEl = null, fillEl = null, handleEl = null, msgEl = null, loadEl = null;
  let bgCanvas = null, pieceCanvas = null;
  let cur = null;        // { id, seed, gapX, gapY, dragX, maxX }
  let settle = null;     // Promise 的 resolve
  let dragging = false;
  let downX = 0, startDrag = 0, t0 = 0;
  let track = [];
  let busy = false;      // 正在校验中，别让用户重复提交

  function setMsg(text, cls) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'zmcap-msg' + (cls ? ' ' + cls : '');
  }

  /* ---------------- 画图 ---------------- */
  function drawBg(seed, gapX, gapY) {
    const { w, h, piece } = GEO;
    const rnd = rngOf(seed);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');

    // 底色：从 seed 派生色相，保证每题的色调都不一样
    const hue = Math.floor(rnd() * 360);
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hue}, 62%, 68%)`);
    grad.addColorStop(1, `hsl(${(hue + 48) % 360}, 58%, 52%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // 几块半透明几何：既是视觉噪声，也让「按颜色找缺口」更难一点
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.globalAlpha = 0.12 + rnd() * 0.22;
      g.fillStyle = `hsl(${(hue + 20 + rnd() * 120) % 360}, 70%, ${45 + rnd() * 40}%)`;
      if (rnd() < 0.5) {
        g.arc(rnd() * w, rnd() * h, 10 + rnd() * 46, 0, Math.PI * 2);
      } else {
        const x = rnd() * w, y = rnd() * h, s = 20 + rnd() * 60;
        g.rect(x, y, s, s * (0.5 + rnd()));
      }
      g.fill();
    }
    // 斜线纹理
    g.globalAlpha = 0.1;
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const x = rnd() * w;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 40, h); g.stroke();
    }
    // 噪点：防止「纯色区域」让人一眼算出距离
    g.globalAlpha = 0.07;
    g.fillStyle = '#000';
    for (let i = 0; i < 900; i++) g.fillRect(rnd() * w, rnd() * h, 1, 1);
    g.globalAlpha = 1;

    return c;
  }

  function roundRect(g, x, y, s, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + s - r, y);
    g.quadraticCurveTo(x + s, y, x + s, y + r);
    g.lineTo(x + s, y + s - r);
    g.quadraticCurveTo(x + s, y + s, x + s - r, y + s);
    g.lineTo(x + r, y + s);
    g.quadraticCurveTo(x, y + s, x, y + s - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  /** 重新出题：拉 challenge、算 gapX、把底图与拼图块烘到离屏 canvas */
  async function loadQuestion() {
    busy = true;
    if (loadEl) loadEl.hidden = false;
    setMsg('');
    if (trackEl) trackEl.classList.remove('ok', 'bad');
    try {
      const r = await fetch('/api/captcha/challenge', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '验证码加载失败');
      const seed = Number(d.seed) || 1;
      const gapX = deriveGap(seed);
      const rnd = rngOf(seed ^ 0x5bf03635);
      const gapY = 26 + Math.floor(rnd() * (GEO.h - GEO.piece - 52));
      cur = { id: d.id, seed, gapX, gapY, dragX: 0, maxX: GEO.w - GEO.piece };

      bgCanvas = drawBg(seed, gapX, gapY);
      // 拼图块：先从底图抠出缺口那块像素，再单独存一张小 canvas
      pieceCanvas = document.createElement('canvas');
      pieceCanvas.width = GEO.piece;
      pieceCanvas.height = GEO.piece;
      pieceCanvas.getContext('2d').drawImage(bgCanvas, gapX, gapY, GEO.piece, GEO.piece, 0, 0, GEO.piece, GEO.piece);

      // 底图上把缺口挖掉：压暗 + 虚线描边，用户一眼能看出目标
      const g = bgCanvas.getContext('2d');
      g.save();
      roundRect(g, gapX, gapY, GEO.piece, 8);
      g.fillStyle = 'rgba(10,12,20,.55)';
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.stroke();
      g.restore();

      paint();
      resetHandle();
      if (loadEl) loadEl.hidden = true;
      busy = false;
    } catch (e) {
      if (loadEl) loadEl.hidden = true;
      busy = false;
      setMsg(e.message || '加载失败，请重试', 'err');
    }
  }

  /** 每帧重绘：底图 + 跟手的拼图块 */
  function paint() {
    if (!ctx || !bgCanvas || !cur) return;
    ctx.clearRect(0, 0, GEO.w, GEO.h);
    ctx.drawImage(bgCanvas, 0, 0);
    const x = Math.min(cur.dragX, GEO.w - GEO.piece);
    // 块的投影，让它看起来是「浮」在图上
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 6;
    roundRect(ctx, x, cur.gapY, GEO.piece, 8);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, x, cur.gapY, GEO.piece, 8);
    ctx.clip();
    ctx.drawImage(pieceCanvas, x, cur.gapY);
    ctx.restore();
    // 描边内缩 1px：块初始位置贴着画布左边缘（dragX=0），线宽 2 的描边有一半会落在画布外被裁掉，
    // 看起来像「缺了一角」。内缩之后无论块在哪个位置，描边都是完整的。
    roundRect(ctx, x + 1, cur.gapY + 1, GEO.piece - 2, 7);
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function resetHandle() {
    if (handleEl) handleEl.style.left = '0px';
    if (fillEl) fillEl.style.width = '0px';
  }

  /* ---------------- 拖动 ---------------- */
  function trackScale() {
    const r = trackEl.getBoundingClientRect();
    // 轨道在窄屏会被 CSS 缩窄，逻辑坐标要按比例还原，否则小屏上「差一点点」永远对不上
    return r.width > 0 ? GEO.w / r.width : 1;
  }

  function onDown(e) {
    if (busy || !cur || !trackEl) return;
    if (trackEl.classList.contains('ok')) return;
    dragging = true;
    trackEl.classList.remove('bad');
    downX = e.clientX;
    startDrag = cur.dragX;
    t0 = performance.now();
    track = [[cur.dragX, GEO.piece / 2, 0]];
    try { trackEl.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    if (handleEl) handleEl.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging || !cur) return;
    const dx = (e.clientX - downX) * trackScale();
    const x = Math.max(0, Math.min(cur.maxX, startDrag + dx));
    cur.dragX = x;
    const trackRect = trackEl.getBoundingClientRect();
    const k = trackRect.width > 0 ? trackRect.width / GEO.w : 1;
    // 手柄跟着块走：块的左边缘 = 手柄左边缘，视觉上两者是同一个东西
    if (handleEl) handleEl.style.left = Math.min(x * k, Math.max(0, trackRect.width - HANDLE)) + 'px';
    if (fillEl) fillEl.style.width = Math.min(x * k + HANDLE / 2, trackRect.width) + 'px';
    paint();
    if (track.length < MAX_TRACK) {
      // y 必须换算成**画布内坐标**再上报：直接传 e.clientY 是视口坐标（页面里能到 500+），
      // 而服务端按 320×160 的画布尺度校验，会一律判成「轨迹异常」——这个坑踩过一次。
      const r = cv.getBoundingClientRect();
      const ky = r.height > 0 ? GEO.h / r.height : 1;
      track.push([x, Math.round((e.clientY - r.top) * ky), Math.round(performance.now() - t0)]);
    }
    e.preventDefault();
  }

  async function onUp(e) {
    if (!dragging || !cur) return;
    dragging = false;
    if (handleEl) handleEl.style.cursor = 'grab';
    // 松手这一下也要入轨迹：服务端的时长判断靠最后一个点
    track.push([cur.dragX, GEO.piece / 2, Math.round(performance.now() - t0)]);
    await submit();
    if (e) e.preventDefault();
  }

  async function submit() {
    if (!cur || busy) return;
    busy = true;
    setMsg('验证中…');
    try {
      const r = await fetch('/api/captcha/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cur.id, x: cur.dragX, track }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ticket) {
        if (trackEl) trackEl.classList.add('ok');
        setMsg('验证通过', 'ok');
        busy = false;
        // 让「通过」的绿色停留一瞬再关，直接消失会让人怀疑是不是点错了
        setTimeout(() => { close(d.ticket); }, 260);
        return;
      }
      if (trackEl) trackEl.classList.add('bad');
      setMsg(d.error || '验证未通过，请重试', 'err');
      busy = false;
      setTimeout(() => { if (cur) loadQuestion(); }, 900);
    } catch {
      if (trackEl) trackEl.classList.add('bad');
      setMsg('网络异常，请重试', 'err');
      busy = false;
    }
  }

  /* ---------------- 弹窗 ---------------- */
  function buildDom() {
    injectCss();
    const wrap = document.createElement('div');
    wrap.className = 'zmcap-mask';
    wrap.innerHTML = `
      <div class="zmcap-box" role="dialog" aria-modal="true" aria-label="安全验证">
        <div class="zmcap-head">
          <b>安全验证</b>
          <button type="button" class="zmcap-x" aria-label="关闭">×</button>
        </div>
        <p class="zmcap-tip">拖动下方滑块，把拼图对准缺口。验证通过后才会发送短信。</p>
        <div class="zmcap-stage">
          <canvas width="${GEO.w}" height="${GEO.h}"></canvas>
          <div class="zmcap-loading">正在生成题目…</div>
        </div>
        <div class="zmcap-track">
          <div class="zmcap-fill"></div>
          <div class="zmcap-handle">›</div>
          <span class="zmcap-track-text">向右拖动滑块</span>
        </div>
        <div class="zmcap-msg"></div>
      </div>`;
    document.body.appendChild(wrap);

    cv = wrap.querySelector('canvas');
    ctx = cv.getContext('2d');
    trackEl = wrap.querySelector('.zmcap-track');
    fillEl = wrap.querySelector('.zmcap-fill');
    handleEl = wrap.querySelector('.zmcap-handle');
    msgEl = wrap.querySelector('.zmcap-msg');
    loadEl = wrap.querySelector('.zmcap-loading');

    trackEl.addEventListener('pointerdown', onDown);
    trackEl.addEventListener('pointermove', onMove);
    trackEl.addEventListener('pointerup', onUp);
    trackEl.addEventListener('pointercancel', onUp);
    wrap.querySelector('.zmcap-x').addEventListener('click', () => close(null));
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(null); });

    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap._onKey = onKey;

    maskEl = wrap;
  }

  function close(ticket) {
    if (maskEl) {
      if (maskEl._onKey) document.removeEventListener('keydown', maskEl._onKey);
      maskEl.remove();
    }
    maskEl = null; cv = null; ctx = null; bgCanvas = null; pieceCanvas = null;
    cur = null; dragging = false; busy = false; track = [];
    const fn = settle; settle = null;
    if (fn) fn(ticket || null);
  }

  /** 打开验证，返回 ticket（字符串）或 null（用户取消） */
  function open() {
    if (maskEl) close(null);   // 已经开着：先把上一次的 Promise 结掉，别让它永远悬着
    return new Promise((resolve) => {
      settle = resolve;
      buildDom();
      loadQuestion();
    });
  }

  window.ZmCaptcha = { open, deriveGap, GEO };
})();
