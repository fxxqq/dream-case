// ---------- 支付宝 AI 网页应用收款（/alipay/*）：独立模块，依赖注入，不改既有微信 xpay ----------
// 接入产品：AI 网页应用收款（alipay.trade.page.pay），接口固定、沙箱与生产同一套校验控制流。
// 边界：
//   1. 只在用户确认的目标项目内新增路由和 alipay-orders.json，不碰 xpayOrders / XPAY_GOODS 的既有状态；
//   2. 配置优先读生产环境变量，其次读本轮脚本生成并已校验的 .alipay-sandbox.json（绝对路径，绝不依赖 cwd）；
//   3. 私钥按语言选字段：Node.js 用 PKCS#1 的 appPrivatePkcsKey，不做任何 PEM 头尾/编码加工；
//   4. 支付结果只认验签通过的异步通知或主动查询，同步回跳仅作结束提醒；
//   5. 生产 appId / 应用私钥 / 支付宝公钥必须由部署方配置，禁止写入源码或日志。
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { AlipaySdk } = require('alipay-sdk');

module.exports = { register };

const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const PROD_GATEWAY = 'https://openapi.alipay.com/gateway.do';

// 付款页 / 回跳页共用一套轻量版式：浅底、白卡、站点紫色主按钮，别再是裸文字贴页头。
const ALIPAY_PAGE_CSS = `
<style>
.alipay-page,.alipay-return{max-width:760px;margin:0 auto;padding:28px 20px 40px}
.alipay-card{background:#fff;border:1px solid var(--tk90,#e8e8f0);border-radius:16px;padding:26px 28px;box-shadow:0 8px 30px rgba(60,50,110,.06)}
.alipay-page h1,.alipay-return h1{margin:0 0 8px;font-size:24px;line-height:1.35;color:var(--text,#26263a)}
.alipay-tip{margin:0 0 22px;font-size:13px;line-height:1.7;color:var(--muted,#6b6b80)}
.alipay-tip.alipay-legal{margin:-14px 0 22px}
.alipay-goods-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.alipay-goods{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%;padding:16px 18px;cursor:pointer;border-radius:14px;border:1.5px solid var(--tk86,#ddd9f0);background:linear-gradient(180deg,#fff,#fbfaff);color:var(--text,#26263a);text-align:left;transition:transform .15s,border-color .15s,box-shadow .15s}
.alipay-goods:hover,.alipay-goods.is-preset{transform:translateY(-2px);border-color:var(--primary,#6b5bd2);box-shadow:0 8px 22px rgba(107,91,210,.12)}
.alipay-goods b{font-size:14px;font-weight:600}
.alipay-goods span{font-size:20px;font-weight:700;color:var(--primary,#6b5bd2)}
.alipay-msg{min-height:22px;margin-top:16px;font-size:13px;line-height:1.6;color:var(--danger,#e5484d)}
.alipay-state{display:flex;align-items:center;gap:14px;margin:22px 0 4px}
.alipay-spinner{width:26px;height:26px;flex:none;border-radius:50%;border:3px solid var(--tk90,#e8e8f0);border-top-color:var(--primary,#6b5bd2);animation:alipay-spin .8s linear infinite}
@keyframes alipay-spin{to{transform:rotate(360deg)}}
.alipay-return-msg{margin:0;font-size:14px;line-height:1.7;color:var(--text,#26263a)}
.alipay-return-actions{margin-top:24px;display:flex;gap:10px;flex-wrap:wrap}
.alipay-link{display:inline-flex;align-items:center;justify-content:center;padding:9px 18px;border-radius:999px;font-size:13px;text-decoration:none;color:var(--primary,#6b5bd2);border:1px solid var(--tk86,#ddd9f0);background:#fff}
.alipay-link:hover{background:var(--tk98,#f7f5ff)}
.alipay-done .alipay-spinner{position:relative;border-color:#12a05e;border-top-color:transparent;animation:none}
.alipay-done .alipay-spinner::after{content:'✓';position:absolute;inset:0;display:grid;place-items:center;color:#12a05e;font-weight:700}
#alipayFormBox{position:fixed;inset:0;background:#fff;z-index:9999;display:none}
@media(max-width:560px){.alipay-page,.alipay-return{padding:18px 14px 30px}.alipay-card{padding:20px 18px}.alipay-page h1,.alipay-return h1{font-size:20px}}
</style>
`;

function register(deps) {
  const {
    app, seo, shell, sendHtml,
    readJSON, writeJSON, currentUser, requireUser, requireOwner, isAdmin,
    rateLimit, clientIp, addPoints, addNotice, users, XPAY_GOODS,
  } = deps;

  // ---- 配置加载：env > 受保护生产文件 > 本轮沙箱文件（绝对路径，不依赖 cwd） ----
  function readProtectedJson(name) {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf-8')); }
    catch (_) { return null; }
  }

  function loadAlipayConfig() {
    // 1) 生产环境变量（适合容器/CI 注入），三项齐全才走生产
    const prodAppId = String(process.env.ALIPAY_APP_ID || '').trim();
    const prodPrivate = String(process.env.ALIPAY_PRIVATE_KEY || '').trim();
    const prodPublic = String(process.env.ALIPAY_PUBLIC_KEY || '').trim();
    if (prodAppId && prodPrivate && prodPublic) {
      return {
        mode: 'prod',
        appId: prodAppId,
        privateKey: prodPrivate,
        alipayPublicKey: prodPublic,
        sellerId: String(process.env.ALIPAY_SELLER_ID || '').trim(),
        gateway: String(process.env.ALIPAY_GATEWAY || PROD_GATEWAY).trim(),
      };
    }

    // 2) 受保护的生产配置文件 .alipay-prod.json（600、gitignored，私钥由部署方自行填入）。
    //    私钥为空视为未完成，回退沙箱，绝不带着空私钥误启生产。
    const prodFile = readProtectedJson('.alipay-prod.json');
    if (prodFile && prodFile.appId && prodFile.appPrivatePkcsKey && prodFile.alipayPublicKey) {
      return {
        mode: 'prod',
        appId: String(prodFile.appId).trim(),
        privateKey: String(prodFile.appPrivatePkcsKey).trim(),
        alipayPublicKey: String(prodFile.alipayPublicKey).trim(),
        sellerId: String(prodFile.sellerId || '').trim(),
        gateway: String(prodFile.gateway || PROD_GATEWAY).trim(),
      };
    }

    // 3) 本轮已校验的沙箱配置
    const sandbox = readProtectedJson('.alipay-sandbox.json');
    const appEntry = sandbox && Array.isArray(sandbox.appIds) ? sandbox.appIds[0] : null;
    if (!appEntry || !appEntry.appId || !appEntry.appPrivatePkcsKey || !appEntry.alipayPublicKey) {
      return { mode: 'off' };
    }
    return {
      mode: 'sandbox',
      appId: appEntry.appId,
      // Node.js 非 Java：PKCS#1 私钥字段，原样使用，不加 PEM 头尾、不做格式转换
      privateKey: appEntry.appPrivatePkcsKey,
      alipayPublicKey: appEntry.alipayPublicKey,
      sellerId: String(appEntry.pid || '').trim(),
      gateway: SANDBOX_GATEWAY,
    };
  }

  // alipay-sdk 默认把私钥当 PKCS#1 包装；PKCS#8 私钥必须显式 keyType:'PKCS8'，
  // 否则签名无效（支付宝报 invalid-signature）。按私钥内容自动识别，两种格式都支持。
  function detectPrivateKeyType(privateKey) {
    const s = String(privateKey || '').trim();
    if (/BEGIN\s+RSA\s+PRIVATE\s+KEY/.test(s)) return 'PKCS1';
    if (/BEGIN\s+(?:ENCRYPTED\s+)?PRIVATE\s+KEY/.test(s)) return 'PKCS8';
    const b64 = s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    let der;
    try { der = Buffer.from(b64, 'base64'); } catch (_) { return ''; }
    // PKCS#8 含 rsaEncryption 算法标识：30 0D 06 09 2A 86 48 86 F7 0D 01 01 01
    const pkcs8Marker = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
    if (der.includes(pkcs8Marker)) return 'PKCS8';
    // PKCS#1：SEQUENCE{ version 02 01 00, modulus 02 ... }
    if (der[0] === 0x30 && der[4] === 0x02 && der[5] === 0x01 && der[6] === 0x00 && der[7] === 0x02) return 'PKCS1';
    return ''; // 识别不了就交给 SDK 默认行为
  }

  let conf = loadAlipayConfig();
  const keyType = detectPrivateKeyType(conf.privateKey);
  let sdk = conf.mode === 'off' ? null : new AlipaySdk({
    appId: conf.appId,
    privateKey: conf.privateKey,
    ...(keyType ? { keyType } : {}),
    alipayPublicKey: conf.alipayPublicKey,
    gateway: conf.gateway,
    signType: 'RSA2',
  });

  function enabled() { return conf.mode !== 'off' && !!sdk; }

  // ---- 订单持久化：与 xpay 同样同步落盘，钱的事不做合并写 ----
  let alipayOrders = readJSON('alipay-orders.json', []);
  if (!Array.isArray(alipayOrders)) alipayOrders = [];
  function saveOrders() {
    try { writeJSON('alipay-orders.json', alipayOrders); }
    catch (e) { console.error('[saveAlipayOrders]', e && e.message); }
  }
  function findOrder(outTradeNo) {
    return alipayOrders.find(o => o.outTradeNo === String(outTradeNo || '')) || null;
  }

  // 售卖的仍是站内灯火包（与微信 xpay 同一套商品与价格，唯一价源 XPAY_GOODS）
  function payGoods() {
    return (XPAY_GOODS || []).filter(g => g && g.kind === 'lamp').map(g => ({
      id: g.id, name: g.name, desc: g.desc,
      priceFen: g.priceFen, lamps: g.lamps,
      amountText: (Number(g.priceFen) / 100).toFixed(2),
    }));
  }
  function goodOf(id) { return (XPAY_GOODS || []).find(g => g.id === String(id || '')) || null; }

  function amountOf(g) { return (Number(g.priceFen) / 100).toFixed(2); }

  // ---- 发货：幂等。只有 paid 才能发，delivered 直接返回 ----
  function deliverOrder(order) {
    if (order.status === 'delivered') return { ok: true, already: true };
    if (order.status !== 'paid') return { ok: false, error: '订单未支付' };
    const user = users.find(u => u.id === order.uid);
    if (!user) { order.lastError = '账号不存在'; saveOrders(); return { ok: false, error: order.lastError }; }
    const lamps = Math.max(1, Math.floor(Number(order.lamps) || 0));
    const points = addPoints(order.uid, lamps, 'alipay_lamp');
    order.status = 'delivered';
    order.deliveredAt = Date.now();
    order.points = points;
    delete order.lastError;
    saveOrders();
    addNotice(order.uid, {
      kind: 'points',
      title: '灯火包已到账',
      text: `你通过支付宝网页支付购买的「${order.subject}」已到账，${lamps} 盏灯火进了你的余额。支付宝订单号 ${order.outTradeNo}。`,
    });
    return { ok: true, status: 'delivered', points };
  }

  // ---- 交易查询结果统一映射：不把"调用成功"当"支付成功" ----
  function mapTradeStatus(result) {
    if (!result || result.code !== '10000') return 'UNKNOWN';
    // alipay-sdk 4.x 把响应键转成驼峰（tradeStatus），异步通知才是下划线（trade_status）。两边都要认。
    const st = result.tradeStatus || result.trade_status;
    return ({
      TRADE_SUCCESS: 'PAID',
      TRADE_FINISHED: 'PAID',
      WAIT_BUYER_PAY: 'PENDING',
      TRADE_CLOSED: 'CLOSED',
    })[st] || 'UNKNOWN';
  }

  // 主动查单：核对订单号 / 金额 / 支付宝 app_id 后，才标记 paid 并发货
  async function verifyAndSettle(order) {
    if (!enabled() || order.status === 'delivered') return mapTradeStatus(null);
    let result;
    try {
      result = await sdk.exec('alipay.trade.query', {
        bizContent: { out_trade_no: order.outTradeNo },
      });
    } catch (e) {
      order.lastError = 'query_failed';
      saveOrders();
      return 'UNKNOWN';
    }
    const state = mapTradeStatus(result);
    if (state === 'PAID') {
      const amountOk = result && amountEquals(order.amountText, result.totalAmount || result.total_amount);
      const resultAppId = result && (result.appId || result.app_id);
      const appOk = !resultAppId || resultAppId === conf.appId;
      if (amountOk && appOk && order.status !== 'paid' && order.status !== 'delivered') {
        order.status = 'paid';
        order.paidAt = Date.now();
        order.tradeNo = result.tradeNo || result.trade_no || '';
        delete order.lastError;
        saveOrders();
      }
      if (amountOk && appOk) deliverOrder(order);
    } else if (state === 'CLOSED' && order.status === 'pending') {
      order.status = 'closed';
      saveOrders();
    }
    return state;
  }

  // 金额用"元"两位小数字符串比较，不用浮点
  function amountEquals(a, b) {
    const norm = (v) => {
      const m = String(v == null ? '' : v).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
      return m ? `${BigInt(m[1])}.${(m[2] || '').padEnd(2, '0')}` : null;
    };
    const x = norm(a), y = norm(b);
    return x !== null && x === y;
  }

  // ============ 路由 ============

  // 商品与开关：前端据此渲染现金区（未开通时整块隐藏，线上无感）
  app.get('/api/alipay/goods', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const user = currentUser(req);
    res.json({ enabled: enabled(), mode: conf.mode, goods: enabled() && user ? payGoods() : [] });
  });

  // 下单：登录用户，服务端按 productId 定价，返回支付表单 HTML
  app.post('/api/alipay/create', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!enabled()) return res.status(400).json({ error: '支付宝网页支付还没开通' });
    if (!rateLimit('alipay:create:' + user.id, 6, 60000)) {
      return res.status(429).json({ error: '操作太频繁，稍等一下' });
    }
    const g = goodOf((req.body || {}).productId);
    if (!g || g.kind !== 'lamp') return res.status(400).json({ error: '没有这个套餐' });

    const outTradeNo = 'a' + Date.now().toString(36) + require('crypto').randomBytes(5).toString('hex');
    const order = {
      outTradeNo, uid: user.id, productId: g.id, kind: 'lamp',
      lamps: g.lamps, priceFen: g.priceFen, amountText: amountOf(g),
      subject: g.name, status: 'pending', createdAt: Date.now(),
      appId: conf.appId, sellerId: conf.sellerId,
    };
    alipayOrders.push(order);
    saveOrders();

    const requestOptions = {
      returnUrl: seo.baseUrl(req) + '/alipay/return',
      bizContent: {
        out_trade_no: outTradeNo,
        total_amount: amountOf(g),
        subject: g.name,
        product_code: 'FAST_INSTANT_TRADE_PAY',
      },
    };
    const notifyUrl = String(process.env.ALIPAY_NOTIFY_URL || '').trim();
    if (notifyUrl) requestOptions.notifyUrl = notifyUrl; // 没有公网通知地址就省略，靠主动查单兜底

    let paymentHtml;
    try {
      // 页面跳转类 API 必须用 pageExec + 'POST'，exec() 拿不到支付表单
      paymentHtml = sdk.pageExec('alipay.trade.page.pay', 'POST', requestOptions);
    } catch (e) {
      order.status = 'failed';
      order.lastError = 'pageExec_failed';
      saveOrders();
      return res.status(500).json({ error: '下单失败，请稍后重试' });
    }
    res.json({ ok: true, outTradeNo, paymentHtml, mode: conf.mode });
  });

  // 异步通知：支付宝 POST 表单，必须验签 + 校验订单/金额/归属 + 幂等，成功后回纯文本 success
  app.post('/api/alipay/notify', express.urlencoded({ extended: false }), async (req, res) => {
    if (!enabled()) return res.type('text/plain').send('fail');
    const params = Object.assign({}, req.body || {});
    try {
      // 用通知中的 app_id 选择本地配置，再用当前 SDK 验签
      if (params.app_id && params.app_id !== conf.appId) {
        return res.type('text/plain').send('fail');
      }
      if (typeof sdk.checkNotifySignV2 !== 'function') {
        return res.type('text/plain').send('fail');
      }
      if (!sdk.checkNotifySignV2(params)) {
        return res.type('text/plain').send('fail');
      }
      // 退款 / 关单 / 分账等事件不算付款成功
      if (params.out_biz_no || params.gmt_refund || params.refund_fee) {
        return res.type('text/plain').send('success');
      }
      const paid = params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED';
      if (!paid) return res.type('text/plain').send('success');

      const order = findOrder(params.out_trade_no);
      if (!order) return res.type('text/plain').send('fail');
      // app_id / 金额 / 卖家校验，预期值来自运行时配置，不从通知本身取
      const sellerOk = conf.sellerId
        ? (params.seller_id === conf.sellerId)
        : true;
      if (!amountEquals(order.amountText, params.total_amount) || !sellerOk) {
        return res.type('text/plain').send('fail');
      }
      // 幂等：notify_id + out_trade_no 已处理过就直接回 success
      if (order.status === 'delivered' || order.notifyId === params.notify_id) {
        return res.type('text/plain').send('success');
      }
      order.status = 'paid';
      order.paidAt = Date.now();
      order.tradeNo = params.trade_no || '';
      order.notifyId = params.notify_id || '';
      saveOrders();
      deliverOrder(order);
      return res.type('text/plain').send('success');
    } catch (_) {
      return res.type('text/plain').send('fail');
    }
  });

  // 前端确认：登录用户主动查单兜底（未收到异步通知时用），并据此发货
  app.post('/api/alipay/confirm', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!enabled()) return res.status(400).json({ error: '支付宝网页支付还没开通' });
    const order = findOrder((req.body || {}).outTradeNo);
    if (!order || order.uid !== user.id) return res.status(404).json({ error: '订单不存在' });
    const state = await verifyAndSettle(order);
    res.json({ ok: true, status: order.status, tradeState: state });
  });

  // 订单查询（页面与客服排查用，仅本人或站长）
  app.get('/api/alipay/order/:outTradeNo', (req, res) => {
    const user = currentUser(req);
    const order = findOrder(req.params.outTradeNo);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    const isOwner = (user && user.id === order.uid) || (typeof isAdmin === 'function' && isAdmin(req));
    if (!isOwner) return res.status(403).json({ error: '无权查看' });
    res.json({
      ok: true, outTradeNo: order.outTradeNo, status: order.status,
      subject: order.subject, amountText: order.amountText, lamps: order.lamps,
      paidAt: order.paidAt || null, deliveredAt: order.deliveredAt || null,
    });
  });

  // 退款（站长）：新退款用新 out_request_no，资金变化未明时用同一单号查退款确认
  app.post('/api/alipay/refund', requireOwner, async (req, res) => {
    if (!enabled()) return res.status(400).json({ error: '支付宝网页支付还没开通' });
    const body = req.body || {};
    const order = findOrder(body.outTradeNo);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'paid' && order.status !== 'delivered') {
      return res.status(400).json({ error: '订单未支付，不能退款' });
    }
    const refundAmount = String(body.refundAmount || order.amountText).trim();
    const outRequestNo = String(body.outRequestNo || ('r' + Date.now().toString(36) + require('crypto').randomBytes(4).toString('hex'))).trim();
    if (!amountEquals(refundAmount, order.amountText) && body.partial !== true) {
      return res.status(400).json({ error: '退款金额与订单金额不一致' });
    }
    try {
      const result = await sdk.exec('alipay.trade.refund', {
        bizContent: {
          out_trade_no: order.outTradeNo,
          refund_amount: refundAmount,
          refund_reason: String(body.reason || '正常退款').slice(0, 60),
          out_request_no: outRequestNo,
        },
      });
      const fundChange = result && (result.fundChange || result.fund_change);
      order.refunds = Array.isArray(order.refunds) ? order.refunds : [];
      order.refunds.push({ outRequestNo, refundAmount, fundChange, at: Date.now() });
      // 全额退款且资金已动（fundChange=Y）：状态置 refunded，已发货的灯火包同步扣回（与微信侧退款口径一致）
      const refundedNow = !!(result && result.code === '10000' && fundChange === 'Y' && amountEquals(refundAmount, order.amountText));
      let deducted = 0;
      if (refundedNow) {
        if (order.status === 'delivered' && order.kind === 'lamp') {
          deducted = Math.max(0, Math.floor(Number(order.lamps) || 0));
          if (deducted) addPoints(order.uid, -deducted, 'admin');
        }
        order.status = 'refunded';
        order.refundedAt = Date.now();
        addNotice(order.uid, {
          kind: 'points',
          title: '订单已退款',
          text: `你的支付宝订单 ${order.outTradeNo}（¥${order.amountText}）已由站长退款，钱会原路退回你的支付宝。${deducted ? `同时扣回了这笔订单发放的 ${deducted} 盏灯火。` : ''}`,
        });
      }
      saveOrders();
      const needQuery = !result || result.code !== '10000' || fundChange !== 'Y';
      res.json({ ok: true, fundChange, needQuery, outRequestNo, deductedLamps: deducted });
    } catch (e) {
      res.status(500).json({ error: '退款请求失败', needQuery: true, outRequestNo });
    }
  });

  // 退款查询（站长）：refund_status=REFUND_SUCCESS 才算退款成功
  app.get('/api/alipay/refund-query', requireOwner, async (req, res) => {
    if (!enabled()) return res.status(400).json({ error: '支付宝网页支付还没开通' });
    const outRequestNo = String(req.query.outRequestNo || '').trim();
    const order = findOrder(req.query.outTradeNo);
    if (!outRequestNo || !order) return res.status(400).json({ error: '缺少退款单号' });
    try {
      const result = await sdk.exec('alipay.trade.fastpay.refund.query', {
        bizContent: { out_trade_no: order.outTradeNo, out_request_no: outRequestNo },
      });
      const refundStatus = result && (result.refundStatus || result.refund_status);
      res.json({ ok: true, refundStatus, success: !!refundStatus && refundStatus === 'REFUND_SUCCESS' });
    } catch (e) {
      res.status(500).json({ error: '退款查询失败' });
    }
  });

  // 关闭交易（站长）：仅未付款订单
  app.post('/api/alipay/close', requireOwner, async (req, res) => {
    if (!enabled()) return res.status(400).json({ error: '支付宝网页支付还没开通' });
    const order = findOrder((req.body || {}).outTradeNo);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'pending') return res.status(400).json({ error: '只有待支付订单能关闭' });
    try {
      const result = await sdk.exec('alipay.trade.close', {
        bizContent: { out_trade_no: order.outTradeNo },
      });
      if (result && result.code === '10000') { order.status = 'closed'; saveOrders(); }
      res.json({ ok: !!(result && result.code === '10000') });
    } catch (e) {
      res.status(500).json({ error: '关单失败' });
    }
  });

  // ---------- 后台订单总表（2026-11-25）：admin.html「支付订单」tab 的支付宝区块 ----------
  // 与微信 /api/admin/xpay-orders 同口径：列表 + 汇总磁贴，只站长能看。
  app.get('/api/admin/alipay-orders', requireOwner, (req, res) => {
    const list = alipayOrders.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(o => {
      const u = users.find(x => x.id === o.uid);
      const refunds = Array.isArray(o.refunds) ? o.refunds : [];
      return {
        outTradeNo: o.outTradeNo, productId: o.productId, subject: o.subject,
        kind: o.kind || 'lamp', lamps: o.lamps || 0, priceFen: o.priceFen, amountText: o.amountText,
        uid: o.uid, username: u ? (u.nickname || u.username) : ('（' + o.uid + '）'),
        status: o.status, tradeNo: o.tradeNo || '',
        refunded: refunds.some(r => r && r.fundChange === 'Y'),
        lastError: o.lastError || '',
        createdAt: o.createdAt || 0, paidAt: o.paidAt || 0, deliveredAt: o.deliveredAt || 0,
      };
    });
    const sum = { all: list.length, pending: 0, paid: 0, delivered: 0, closed: 0, failed: 0, refunded: 0, incomeFen: 0, refundFen: 0 };
    for (const o of list) {
      sum[o.status] = (sum[o.status] || 0) + 1;
      if (o.status === 'paid' || o.status === 'delivered') sum.incomeFen += o.priceFen;
      if (o.status === 'refunded') sum.refundFen += o.priceFen;
    }
    res.json({ orders: list.slice(0, 200), sum, enabled: enabled(), mode: conf.mode });
  });

  // 核实补发（站长）：等价于用户点 confirm，但不需要用户在场。
  // 主动向支付宝查单，查到真实付款才标记 paid 并发货；deliverOrder 幂等，不会重复送灯。
  app.post('/api/admin/alipay-orders/verify', requireOwner, async (req, res) => {
    const order = findOrder((req.body || {}).outTradeNo);
    if (!order) return res.status(404).json({ error: '找不到这笔订单' });
    if (order.status === 'delivered') return res.json({ ok: true, status: 'delivered', note: '这单早已发货' });
    if (order.status !== 'pending' && order.status !== 'paid') {
      return res.status(400).json({ error: '只有待支付 / 已支付未发货的单能核实，当前状态 ' + order.status });
    }
    if (!enabled()) return res.status(400).json({ error: '支付宝支付未启用，无法向支付宝核实' });
    const state = await verifyAndSettle(order);
    if (order.status === 'delivered') return res.json({ ok: true, status: 'delivered', tradeState: state });
    return res.status(400).json({
      error: '支付宝侧不是已支付状态（' + state + '），不能发货',
      tradeState: state, status: order.status,
    });
  });

  // 付款页：选套餐 -> 下单 -> 渲染并自动提交支付宝表单（禁止 URL 直接跳转）
  app.get('/alipay/pay', (req, res) => {
    const base = seo.baseUrl(req);
    if (!enabled()) {
      const head = seo.head({ title: `支付宝支付未开通 - ${seo.SITE_NAME}`, canonical: base + '/alipay/pay', noindex: true, type: 'website' });
      return sendHtml(res, shell(head, '<div class="seo-wrap"><h1>支付宝网页支付还没开通</h1><p>请稍后再来。</p></div>'));
    }
    const headHtml = seo.head({
      title: `灯火包 · 支付宝支付 - ${seo.SITE_NAME}`,
      description: '用支付宝网页支付购买造梦橱窗灯火包，付款后灯火自动到账。',
      canonical: base + '/alipay/pay', noindex: true, type: 'website',
    });
    const goodsHtml = payGoods().map(g => `
      <button type="button" class="btn-primary alipay-goods" data-product="${seo.esc(g.id)}" data-name="${seo.esc(g.name)}" data-amount="${g.amountText}">
        <b>${seo.esc(g.name)}</b><span>¥${g.amountText}</span>
      </button>`).join('');
    const block = `${ALIPAY_PAGE_CSS}<div id="seoContent" class="seo-wrap alipay-page">
      <div class="alipay-card">
        <h1>灯火包 · 支付宝支付</h1>
        <p class="alipay-tip">选择套餐后用支付宝付款，付款后灯火自动到账。</p>
        <p class="alipay-tip alipay-legal">灯火为站内虚拟道具，不可提现、不可转让；除平台原因外不退款。</p>
        <div class="alipay-goods-row">${goodsHtml}</div>
        <div id="alipayMsg" class="alipay-msg" role="status"></div>
      </div>
    </div>
    <div id="alipayFormBox"></div>
    <script>
    (function(){
      var msg=document.getElementById('alipayMsg');
      var btns=Array.prototype.slice.call(document.querySelectorAll('.alipay-goods'));
      var preset=new URLSearchParams(location.search).get('product')||'';
      function pay(btn){
        msg.textContent='正在创建订单…';
        fetch('/api/alipay/create',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({productId:btn.getAttribute('data-product')})})
        .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
        .then(function(x){
          if(!x.ok||!x.d.paymentHtml){msg.textContent=x.d.error||'下单失败';return;}
          var box=document.getElementById('alipayFormBox');
          box.innerHTML=x.d.paymentHtml;box.style.display='block';
          var form=box.querySelector('form');
          if(form){form.submit();}else{msg.textContent='支付表单异常';}
        }).catch(function(){msg.textContent='网络错误，请重试';});
      }
      btns.forEach(function(btn){
        btn.addEventListener('click',function(){pay(btn);});
      });
      if(preset){
        var hit=btns.filter(function(b){return b.getAttribute('data-product')===preset;})[0];
        if(hit){
          hit.classList.add('is-preset');
          // 从灯火包「支付宝付款」带档位进来，直接开对应档位收银台，不再让用户多点一次。
          // 先把参数从地址栏抹掉：取消支付返回时停在选档位页，不会反复自动跳。
          history.replaceState(null,'','/alipay/pay');
          msg.textContent='正在为你打开「'+hit.getAttribute('data-name')+'」的支付宝收银台…';
          pay(hit);
        }
      }
    })();
    </script>`;
    sendHtml(res, shell(headHtml, block));
  });

  // 同步回跳结果页：只显示"正在确认"，前端轮询查单；绝不信任同步参数判定支付成功
  app.get('/alipay/return', (req, res) => {
    const base = seo.baseUrl(req);
    const headHtml = seo.head({
      title: `支付结果确认 - ${seo.SITE_NAME}`,
      canonical: base + '/alipay/return', noindex: true, type: 'website',
    });
    const block = `${ALIPAY_PAGE_CSS}<div id="seoContent" class="seo-wrap alipay-return">
      <div class="alipay-card">
        <h1>正在确认支付结果</h1>
        <div class="alipay-state" id="alipayState">
          <span class="alipay-spinner"></span>
          <p id="alipayReturnMsg" class="alipay-return-msg" role="status">支付已提交，正在向支付宝核实，请稍候…</p>
        </div>
        <div class="alipay-return-actions">
          <a class="alipay-link" href="/promote">去推荐页看灯火</a>
          <a class="alipay-link" href="/">返回首页</a>
        </div>
      </div>
    </div>
    <script>
    (function(){
      var outTradeNo=new URLSearchParams(location.search).get('out_trade_no')||'';
      var msg=document.getElementById('alipayReturnMsg');
      var state=document.getElementById('alipayState');
      if(!outTradeNo){msg.textContent='没有订单号，请到推荐页或站内消息查看灯火是否到账。';return;}
      var tries=0;
      function poll(){
        fetch('/api/alipay/confirm',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({outTradeNo:outTradeNo})})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.status==='delivered'){
            state.classList.add('alipay-done');
            msg.textContent='支付成功，灯火已到账！2 秒后带你回到推荐页…';
            setTimeout(function(){location.replace('/promote');},2000);
            return;
          }
          if(d.status==='paid'){msg.textContent='已支付，正在把灯火送进你的余额…';}
          if(++tries<12){setTimeout(poll,1500);}
          else{msg.textContent='支付结果还在确认中，到账后会有站内消息。订单号：'+outTradeNo;}
        }).catch(function(){ if(++tries<12){setTimeout(poll,1500);} else{msg.textContent='暂时无法确认，请稍后到推荐页查看。订单号：'+outTradeNo;} });
      }
      poll();
    })();
    </script>`;
    sendHtml(res, shell(headHtml, block));
  });

  // 启动补单：异步通知没配公网地址，光靠回跳页轮询，用户一关页面就漏单。
  // 进程起来后把 7 天内仍 pending 的单子主动查一遍，查到真付款就补发货；deliverOrder 幂等，不会重复送灯。
  if (enabled() && alipayOrders.length) {
    const pending = alipayOrders.filter(o => o.status === 'pending' && Date.now() - (o.createdAt || 0) < 7 * 86400000);
    if (pending.length) {
      setTimeout(async () => {
        for (const order of pending) {
          try { await verifyAndSettle(order); } catch (_) { /* 单次失败下次重启再试 */ }
        }
      }, 3000);
    }
  }
}
