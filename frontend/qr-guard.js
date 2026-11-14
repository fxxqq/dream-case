/* 二维码图「轻量体检」—— 用户上传/粘贴后，在浏览器本地判断这张图里到底有没有码。
 *
 * 为什么只做「软提示」而不硬拦：
 *   1. 微信小程序码（圆形菊花码）是微信自研编码，ZXing / jsQR 这类解码库全都读不出内容，
 *      只能靠形状判断，天生做不到"证明这就是小程序码"；
 *   2. 用户传的常常是整屏截图（带上传框、带对话框），特征会失真；
 *   3. 误拦的代价（投稿被挡、人直接走掉）远大于漏放（后台本来也有人工审核）。
 * 所以这里只回答一件事：图里有没有码该有的图案。拿不准一律放行。
 *
 * 实测数据（2026-11-07，见 tools/probe-qr-shape.js）：
 *   圆形菊花码 墨量 0.22 / 标准二维码 0.40 / 深色封面 1.00 / 空白图 0.00
 *   照片类内容的墨量、格子覆盖率和码重叠，挡不住，这是已知边界，不做处理。
 *
 * 用法：QrGuard.inspect(file).then(r => r.level === 'warn' && 提示 r.reason)
 * 依赖：无（不引第三方库，canvas 原生）
 */
(function (global) {
  'use strict';

  var MAX_SIDE = 256;   // 分析用缩略图边长：够看清结构，又不会在主线程卡顿
  var MIN_SIDE = 60;    // 比这还小的图，微信多半扫不出来
  var GRID = 16;        // 结构网格数：用来判断"整张图是不是只有一小块内容"

  /* Otsu 阈值。注意：黑白分明的图（纯色图、标准码）会让「任何分割点都一样优」，
     取第一个会退化成 0 导致一个黑像素都判不出来，所以取最优区间的中点。 */
  function otsu(gray) {
    var hist = new Uint32Array(256);
    for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, best = -1, lo = 128, hi = 128, found = false;
    for (var k = 0; k < 256; k++) {
      wB += hist[k];
      sumB += k * hist[k];
      if (!wB || wB === total) continue;
      var wF = total - wB;
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best * 1.0001) { best = between; lo = hi = k; found = true; }
      else if (found && between > best * 0.9999) hi = k;
    }
    return found ? (lo + hi) >> 1 : 128;
  }

  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function loadBitmap(file) {
    if (global.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }

  function warn(reason, extra) {
    return Object.assign({ level: 'warn', reason: reason }, extra || {});
  }
  function ok(extra) {
    return Object.assign({ level: 'ok', reason: '' }, extra || {});
  }

  /**
   * @param {File|Blob} file 用户选的图片
   * @returns {Promise<{level:'ok'|'warn', reason:string, ink?:number, cells?:number, side?:number}>}
   */
  function inspect(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) {
      return Promise.resolve(warn('这个文件不是图片，换一张二维码图片试试'));
    }

    return loadBitmap(file).then(function (bmp) {
      var w0 = bmp.width || bmp.naturalWidth || 0;
      var h0 = bmp.height || bmp.naturalHeight || 0;
      if (!w0 || !h0) return ok();

      var side0 = Math.min(w0, h0);
      if (side0 < MIN_SIDE) {
        return warn('这张图太小了（' + side0 + 'px），微信多半扫不出来，建议传 300px 以上的图',
          { side: side0 });
      }

      // 等比缩到 MAX_SIDE 以内再分析
      var scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
      var W = Math.max(1, Math.round(w0 * scale));
      var H = Math.max(1, Math.round(h0 * scale));

      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      if (!ctx) return ok();
      ctx.drawImage(bmp, 0, 0, W, H);

      var data;
      try { data = ctx.getImageData(0, 0, W, H).data; }
      catch (_) { return ok(); }   // 画布被污染之类，宁可放行

      // 灰度：透明像素按白底算
      var gray = new Uint8Array(W * H);
      for (var i = 0, p = 0; i < data.length; i += 4, p++) {
        var a = data[i + 3] / 255;
        gray[p] = Math.round((0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a));
      }

      var thr = otsu(gray) - 12;
      var cellW = W / GRID, cellH = H / GRID;
      var cellHit = new Uint8Array(GRID * GRID);
      var ink = 0;
      for (var y = 0; y < H; y++) {
        var row = y * W;
        var gy = Math.min(GRID - 1, Math.floor(y / cellH)) * GRID;
        for (var x = 0; x < W; x++) {
          if (gray[row + x] >= thr) continue;
          ink++;
          cellHit[gy + Math.min(GRID - 1, Math.floor(x / cellW))] = 1;
        }
      }
      var inkRatio = ink / (W * H);
      var cells = 0;
      for (var c = 0; c < cellHit.length; c++) cells += cellHit[c];
      var cellRatio = cells / (GRID * GRID);

      var meta = { ink: +inkRatio.toFixed(3), cells: +cellRatio.toFixed(2), side: side0 };

      // 三条「明显不对」的判断，阈值都留得很宽，宁可放过
      if (inkRatio < 0.004) {
        return warn('这张图几乎是纯白的，里面找不到码的图案', meta);
      }
      if (inkRatio > 0.80) {
        return warn('这张图整片深色，看起来不像二维码（是不是传成封面了？）', meta);
      }
      if (cellRatio < 0.15 && inkRatio < 0.10) {
        return warn('图里只有一小块内容，不像二维码（纯色图 / 图标 / 照片都不行）', meta);
      }
      return ok(meta);
    }).catch(function () {
      return warn('这张图读不出来，可能已损坏，换一张试试');
    });
  }

  global.QrGuard = { inspect: inspect };
})(window);
