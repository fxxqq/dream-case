/**
 * 邮箱验证通道：发码 / 校验 / 频控 / 邮箱加密
 *
 * 用途（2026-11-28 加）：
 *   1. 账号设置里「绑定邮箱」——发验证码到邮箱，验过后把邮箱绑到账号，之后能靠它找回密码。
 *   2. 登录弹窗「忘记密码」——输入注册邮箱，发验证码，验过后直接重置密码。
 *
 * 发信走阿里云邮件推送（Direct Mail）SingleSendMail：
 *   POST https://dm.aliyuncs.com/  Form 表单，签名 RPC 1.0（HMAC-SHA1），
 *   Version=2015-11-23，SignatureVersion=1.0。
 *   发信地址 AccountName 默认 noreply@mail.zm94.com，需在阿里云 DM 控制台添加并验证通过
 *   （DKIM/SPF 已由 mail.zm94.com 的 DNS 记录完成）。
 *
 * 配置：data/email.json（chmod 600），字段：
 *   {
 *     "enabled": true,
 *     "accessKeyId": "LTAI...",
 *     "accessKeySecret": "...",
 *     "accountName": "noreply@mail.zm94.com",
 *     "fromAlias": "造梦橱窗",
 *     "regionId": "cn-hangzhou",
 *     "validTime": 600
 *   }
 * 说明：AK 也可用环境变量 ALIYUN_DM_AK_ID / ALIYUN_DM_AK_SECRET 覆盖（优先级高于文件），
 * 这样服务器上密钥不落盘。两者都没配时走降级模式——控制台打码，仅本地开发用。
 *
 * 安全设计（对照 sms-auth.js）：
 *   · 验证码 6 位数字，存 SHA-256 摘要，明文只在邮件里出现；不落盘。
 *   · 一码一次：校验成功即销毁；错 5 次锁 10 分钟。
 *   · 频控：同邮箱 60s 间隔、每小时 5 条、每天 10 条；同 IP 每小时 20 条；全局每天 200 条。
 *   · 邮箱用 AES-256-GCM 加密存 users.json（只存密文 + 查重用的 HMAC 摘要），
 *     加密密钥 data/email-key.txt，丢了就解不开——别把它提交到仓库。
 *   · 找回密码接口对不存在的邮箱也回 ok（不泄露「这个邮箱注册过没有」），
 *     只是不发信——防账号枚举。
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_HOST = 'dm.aliyuncs.com';
const API_VERSION = '2015-11-23';

// RFC3986 编码（阿里云签名专用：空格→%20，*→%2A，~ 不编码）
function pe(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
    .replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

function callApi(action, biz, conf) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
      + 'T' + pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + ':' + pad(now.getUTCSeconds()) + 'Z';
    const params = Object.assign({
      Format: 'JSON',
      Version: API_VERSION,
      AccessKeyId: conf.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: ts,
      RegionId: conf.regionId || 'cn-hangzhou',
      Action: action,
    }, biz || {});
    const canonical = Object.keys(params).sort()
      .map(k => pe(k) + '=' + pe(params[k])).join('&');
    const stringToSign = 'POST&' + pe('/') + '&' + pe(canonical);
    const sig = crypto.createHmac('sha1', conf.accessKeySecret + '&')
      .update(stringToSign, 'utf8').digest('base64');
    const body = canonical + '&Signature=' + pe(sig);

    const req = https.request({
      host: API_HOST,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
      timeout: 15000,
    }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(out); }
        catch {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(Object.assign(new Error('邮件服务 HTTP ' + res.statusCode), { code: 'HTTP_' + res.statusCode }));
          }
          return reject(Object.assign(new Error('邮件服务返回非法响应'), { code: 'BAD_RESPONSE' }));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // 阿里云错误码在 body 里（如 InvalidMailAddress.NotFound），透传出来便于定位
          const code = json.Code || ('HTTP_' + res.statusCode);
          return reject(Object.assign(new Error(json.Message || ('邮件服务 HTTP ' + res.statusCode)), { code }));
        }
        if (json.Code && json.Code !== 'Success') {
          return reject(Object.assign(new Error(json.Message || json.Code), { code: json.Code }));
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('邮件服务超时'), { code: 'TIMEOUT' })));
    req.on('error', e => reject(Object.assign(e, { code: e.code || 'NETWORK' })));
    req.write(body);
    req.end();
  });
}

// 邮箱规范化：去空格、统一小写（Gmail 的 + 别名不折叠——那属于用户自己的选择）
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}
function emailOk(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 120;
}
function maskEmail(email) {
  const s = String(email || '');
  const i = s.indexOf('@');
  if (i <= 0) return s.slice(0, 2) + '***';
  const name = s.slice(0, i), host = s.slice(i);
  const head = name.length <= 2 ? name.slice(0, 1) : name.slice(0, 2);
  return head + '***' + host;
}

function makeCipher(secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  return {
    enc(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + out.toString('hex');
    },
    dec(text) {
      const parts = String(text || '').split(':');
      if (parts.length !== 3) return '';
      try {
        const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
        c.setAuthTag(Buffer.from(parts[1], 'hex'));
        return Buffer.concat([c.update(Buffer.from(parts[2], 'hex')), c.final()]).toString('utf8');
      } catch { return ''; }
    },
  };
}

// 频控规则：等级比短信松一档——邮箱不是实名，验证码成本也低得多
const RULE = {
  emailIntervalMs: 60 * 1000,
  emailPerHour: 5,
  emailPerDay: 10,
  ipPerHour: 20,
  globalPerDay: 200,
  failLimit: 5,
  failLockMs: 10 * 60 * 1000,
  validTime: 10 * 60,       // 验证码 10 分钟有效
};
const DEFAULT_VALID_TIME = RULE.validTime;
const MIN_VALID_TIME = 60;
const MAX_VALID_TIME = 30 * 60;

function today() { return new Date().toISOString().slice(0, 10); }
function countSince(arr, now, ms) {
  return (arr || []).filter(t => now - t < ms).length;
}

function createEmailService(opts) {
  const dataDir = opts.dataDir;
  const log = opts.log || function () {};
  // 模块自治：server.js 里本模块的初始化早于 DATA_DIR 的 mkdir（约 269 行），
  // 首次部署时目录还没建好，自己兜底建一次，否则密钥/状态文件会静默写不进去。
  try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); }
  catch { /* 建不出来就走降级，不能让整个进程起不来 */ }
  const confFile = path.join(dataDir, 'email.json');
  const keyFile = path.join(dataDir, 'email-key.txt');
  const codesFile = path.join(dataDir, 'email-codes.json');

  // 加密密钥：环境变量 → 文件 → 首次生成落盘（与短信通道同口径）
  const secret = (() => {
    if (process.env.EMAIL_SECRET) return String(process.env.EMAIL_SECRET);
    try {
      const s = fs.readFileSync(keyFile, 'utf8').trim();
      if (s) return s;
    } catch { /* 首次运行 */ }
    const s = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(keyFile, s, { mode: 0o600 }); } catch { /* 写不了就用进程内的 */ }
    return s;
  })();
  const cipher = makeCipher(secret);

  let conf = {};
  function loadConf() {
    try { conf = JSON.parse(fs.readFileSync(confFile, 'utf8')) || {}; }
    catch { conf = {}; }
    return conf;
  }
  loadConf();
  if (typeof setInterval === 'function') {
    const t = setInterval(loadConf, 5 * 60 * 1000);
    if (t && t.unref) t.unref();
  }

  // 环境变量优先，便于服务器上密钥不落盘
  function creds() {
    return {
      accessKeyId: process.env.ALIYUN_DM_AK_ID || conf.accessKeyId || '',
      accessKeySecret: process.env.ALIYUN_DM_AK_SECRET || conf.accessKeySecret || '',
    };
  }
  function ready() {
    const c = creds();
    return !!(conf.enabled && c.accessKeyId && c.accessKeySecret && conf.accountName);
  }
  function mode() { return ready() ? 'live' : (conf.enabled ? 'misconfigured' : 'off'); }
  function validTime() {
    const n = Number(conf.validTime);
    if (!Number.isFinite(n) || n < MIN_VALID_TIME || n > MAX_VALID_TIME) return DEFAULT_VALID_TIME;
    return Math.round(n);
  }
  function validTimeText(sec) {
    return Math.max(1, Math.round(Number(sec) / 60)) + ' 分钟';
  }
  function accountName() { return String(conf.accountName || 'noreply@mail.zm94.com'); }
  function fromAlias() { return String(conf.fromAlias || '造梦橱窗'); }

  // 验证码与频控状态存内存 + 定期落盘（重启后验证码清空，用户重新发一次即可）
  let store = { mail: {}, ip: {}, global: { day: today(), n: 0 } };
  try {
    const saved = JSON.parse(fs.readFileSync(codesFile, 'utf8'));
    if (saved && typeof saved === 'object') store = Object.assign(store, saved);
  } catch { /* 首次运行 */ }
  if (store.global.day !== today()) store.global = { day: today(), n: 0 };
  // 同步写：状态文件很小（几 KB），发码/验码本身是低频操作，
  // 同步落盘能保证「刚发出的码立刻可用」以及进程重启后不丢——防抖+unref 在短命进程里会直接丢写。
  function saveSoon() {
    try { fs.writeFileSync(codesFile, JSON.stringify(store), { mode: 0o600 }); }
    catch { /* 落盘失败不影响主流程，最多重启后验证码失效 */ }
  }

  function bucket(map, key) {
    if (!map[key]) map[key] = { n: 0, times: [], lastAt: 0, code: '', exp: 0, fails: 0, lockUntil: 0 };
    return map[key];
  }
  function codeHash(email, code, salt) {
    return crypto.createHash('sha256').update(email + '|' + code + '|' + salt).digest('hex');
  }

  /**
   * 发码。返回 { ok, error?, code?, wait?, mode? }
   * scene: 'bind' | 'recover' —— 写进邮件标题，让用户知道这码是干嘛的
   */
  async function send(emailRaw, ip, scene) {
    const email = normalizeEmail(emailRaw);
    if (!emailOk(email)) return { ok: false, error: '邮箱格式不正确', code: 'BAD_EMAIL' };
    const now = Date.now();
    const b = bucket(store.mail, email);
    const limited = (reason, error, wait) => ({ ok: false, error, code: 'LIMITED', reason, wait });

    if (b.lockUntil > now) {
      return limited('CHECK_LOCKED', '校验次数过多，请 10 分钟后再试', Math.ceil((b.lockUntil - now) / 1000));
    }
    if (b.lastAt && now - b.lastAt < RULE.emailIntervalMs) {
      return limited('EMAIL_FAST', '发送太频繁，请稍后再试', Math.ceil((RULE.emailIntervalMs - (now - b.lastAt)) / 1000));
    }
    if (countSince(b.times, now, 3600e3) >= RULE.emailPerHour) {
      return limited('EMAIL_HOUR', '该邮箱请求过于频繁，请稍后再试');
    }
    if (b.n >= RULE.emailPerDay) return limited('EMAIL_DAY', '该邮箱今日发送次数已达上限');

    const ib = bucket(store.ip, ip || 'unknown');
    if (countSince(ib.times, now, 3600e3) >= RULE.ipPerHour) {
      return limited('IP_HOUR', '当前网络请求过于频繁，请稍后再试');
    }
    if (store.global.day !== today()) { store.global = { day: today(), n: 0 }; }
    if (store.global.n >= RULE.globalPerDay) {
      log('email_send', { ok: false, d: 'GLOBAL_DAY' });
      return limited('GLOBAL_DAY', '验证码发送通道繁忙，请稍后再试');
    }

    // 先记次数再发送：调用失败也占配额，否则失败请求就是免费重试通道
    b.n += 1; b.lastAt = now; b.times.push(now);
    ib.n += 1; ib.times.push(now);
    store.global.n += 1;
    saveSoon();

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!ready()) {
      if (mode() === 'misconfigured') {
        return { ok: false, error: '邮箱通道配置不完整，请联系管理员', code: 'NOT_CONFIGURED' };
      }
      // 降级：控制台打码，仅本地开发用
      b.code = codeHash(email, code, 'local');
      b.exp = now + validTime() * 1000;
      b.fails = 0;
      saveSoon();
      console.log(`[email:local] ${maskEmail(email)} 验证码 ${code}（${validTimeText(validTime())}内有效，未配置通道仅本机可见）`);
      return { ok: true, mode: 'local', ttl: validTime() };
    }

    const isRecover = scene === 'recover';
    const siteName = fromAlias();
    const subject = isRecover
      ? `【${siteName}】重置登录密码验证码`
      : `【${siteName}】绑定邮箱验证码`;
    const purpose = isRecover ? '重置登录密码' : '绑定邮箱';
    const safeCode = '<b style="font-size:24px;letter-spacing:6px;color:#1a1a1a">' + code + '</b>';
    // 事务邮件特征：明确品牌、明确用途、一次性验证码、无营销话术、无外部图片。
    // Gmail 对新发信域的内容敏感度较高，纯文本 + 简单 HTML 双份正文有利于进收件箱。
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;line-height:1.7;color:#222;max-width:600px">
      <p style="margin:0 0 16px">你好，</p>
      <p style="margin:0 0 16px">收到一封来自 <b>${siteName}</b>（zm94.com）的${purpose}请求。</p>
      <p style="margin:0 0 16px">本次验证码是：${safeCode}</p>
      <p style="margin:0 0 16px">有效期 ${validTimeText(validTime())}。请勿转发或告知他人。</p>
      <p style="margin:0 0 16px;color:#888;font-size:12px">如果不是你本人操作，请忽略这封邮件，你的账号不会有任何变化。</p>
      <p style="margin:16px 0 0;color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:12px">
        此邮件由 ${siteName} 系统自动发送，请勿直接回复。<br>
        <a href="https://zm94.com" style="color:#888">https://zm94.com</a>
      </p>
    </div>`;
    const text = `${siteName}（zm94.com）${purpose}验证码：${code}\n有效期 ${validTimeText(validTime())}，请勿转发或告知他人。\n\n如果不是你本人操作，请忽略这封邮件，你的账号不会有任何变化。\n此邮件由系统自动发送，请勿直接回复。\nhttps://zm94.com`;
    try {
      // 阿里云 DM 对新建发信地址偶发返回 InvalidMailAddress.NotFound（同参数重试可成功），
      // 这类瞬时错误做退避重试，避免用户撞上偶发失败。
      const mailParams = {
        AccountName: accountName(),
        AddressType: 1,
        ToAddress: email,
        Subject: subject,
        HtmlBody: html,
        TextBody: text,
        FromAlias: siteName,
        ReplyToAddress: 'false',
        // 验证码属于事务邮件：显式关闭退订链接生成与点击跟踪，减少 Gmail 的垃圾邮件特征。
        UnSubscribeLinkType: 'disabled',
        UnSubscribeFilterLevel: 'disabled',
        ClickTrace: '0',
      };
      const retryCodes = /^(InvalidMailAddress\.NotFound|THROTTLING|SEND_COUNT_LIMIT|ServiceUnavailable|HTTP_5\d\d)$/i;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await callApi('SingleSendMail', mailParams, Object.assign({}, conf, creds()));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (!retryCodes.test(e.code || '') || attempt === 2) break;
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
      // 真发出去了才记验证码，避免通道故障时用户拿着一个不存在的码反复试
      b.code = codeHash(email, code, secret);
      b.exp = now + validTime() * 1000;
      b.fails = 0;
      saveSoon();
      log('email_send', { email: maskEmail(email), ip, ok: true, scene });
      return { ok: true, mode: 'live', ttl: validTime() };
    } catch (e) {
      log('email_send', { email: maskEmail(email), ip, ok: false, scene, d: e.code || e.message });
      const map = {
        INVALID_ACCOUNT: '发信地址未配置或未验证，请联系管理员',
        ACCOUNT_NOT_EXIST: '发信地址未配置或未验证，请联系管理员',
        SEND_COUNT_LIMIT: '邮件发送次数已达上限，请稍后再试',
        MAILBOX_NOT_EXIST: '邮箱地址不存在',
      };
      return { ok: false, error: map[e.code] || '验证码发送失败，请稍后再试', code: e.code || 'SEND_FAIL' };
    }
  }

  /**
   * 校验验证码。成功即销毁该码。
   * 返回 { ok, error?, code? }
   */
  function check(emailRaw, codeRaw) {
    const email = normalizeEmail(emailRaw);
    const code = String(codeRaw || '').replace(/\D/g, '');
    if (!emailOk(email) || code.length !== 6) return { ok: false, error: '验证码不正确', code: 'BAD_CODE' };
    const b = bucket(store.mail, email);
    const now = Date.now();
    if (b.lockUntil > now) return { ok: false, error: '校验次数过多，请稍后再试', code: 'LOCKED' };
    // 没有发送记录 / 已过期都直接失败。绝不能用「用户输入的 code」去生成期望值——
    // 那会让 b.code 为空时任何 6 位数都通过校验，等于把找回密码接口敞开。
    if (!b.code || !b.exp) return { ok: false, error: '请先获取验证码', code: 'NO_CODE' };
    if (b.exp < now) return { ok: false, error: '验证码已过期，请重新获取', code: 'EXPIRED' };
    // 降级模式的码用固定 salt，线上用进程密钥；两种都算一遍再比，
    // 不必把「这张码属于哪种模式」额外写进状态文件。
    const ok = codeHash(email, code, 'local') === b.code || codeHash(email, code, secret) === b.code;
    if (!ok) {
      b.fails += 1;
      if (b.fails >= RULE.failLimit) {
        b.lockUntil = now + RULE.failLockMs;
        b.fails = 0;
        b.code = ''; b.exp = 0;
        log('email_check', { email: maskEmail(email), ok: false, d: 'LOCKED' });
      }
      saveSoon();
      return { ok: false, error: '验证码不正确', code: 'WRONG_CODE' };
    }
    b.code = ''; b.exp = 0; b.fails = 0;
    saveSoon();
    log('email_check', { email: maskEmail(email), ok: true });
    return { ok: true };
  }

  // 邮箱查重用的单向摘要（HMAC，不可逆；密钥丢了也能重新算，只要配同一个 EMAIL_SECRET）
  function hashEmail(email) {
    return crypto.createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex');
  }
  function encEmail(email) { return cipher.enc(normalizeEmail(email)); }
  function decEmail(cipherText) { return cipher.dec(cipherText); }
  function status() {
    return {
      enabled: ready(),
      mode: mode(),
      accountName: accountName(),
      validTime: validTime(),
      account: conf.accountName || '',
    };
  }

  return { send, check, status, normalizeEmail, emailOk, maskEmail, hashEmail, encEmail, decEmail, RULE };
}

module.exports = { createEmailService, RULE };
