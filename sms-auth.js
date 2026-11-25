/**
 * 短信验证码 —— 阿里云「号码认证服务 → 短信认证」（PNVS）
 *
 * 为什么是这条路而不是普通短信服务：
 * 普通短信（dysmsapi）要求签名完成「运营商实名报备」，2025-09 之后只接企业主体，
 * 个人认证账号签名能过审但报备必失败，最终一条也发不出去。
 * 短信认证是阿里云给个人开发者的通道：签名与模板由系统预置，免报备，开通即用，只能发验证码。
 * 我们正好只需要验证码，所以这条路径的能力上限就是我们的需求上限。
 *
 * 为什么不装 SDK：
 * 本项目一直极简依赖（express / multer / qrcode 就到头了），为两个接口引入 aliyun-sdk-core
 * 不划算。下面按阿里云 RPC 签名规范（HMAC-SHA1）手写，等价于 SDK 的 common 模式；
 * 出问题时对着官方文档逐参数比对即可，不需要读懂一整个 SDK。
 *
 * 配置放 data/sms.json（不进仓库）：
 *   { "enabled": true, "accessKeyId": "...", "accessKeySecret": "...",
 *     "signName": "恒创联众", "templateCode": "100001",
 *     "templateParam": "{\"code\":\"##code##\",\"min\":\"##min##\"}", "validTime": 21600 }
 *
 * enabled=false（或配置缺失）时全部降级为「控制台打印验证码」，
 * 本地能把注册、绑定、校验整条链跑通，不需要真实密钥、不产生费用。
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_HOST = 'dypnsapi.aliyuncs.com';
const API_VERSION = '2017-05-25';   // 号码认证服务的固定版本号，别改

// ---------------- RPC 签名 ----------------
// 阿里云要求的百分号编码比 encodeURIComponent 多三条规则：
// 空格要 %20（不是 +）、星号要 %2A、~ 不编码。漏一条就是 SignatureDoesNotMatch。
function pe(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/gi, '~');
}

function signedPath(action, biz, conf) {
  const params = Object.assign({}, biz, {
    Action: action,
    Format: 'JSON',
    Version: API_VERSION,
    AccessKeyId: conf.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(16).toString('hex'),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  // 参与签名的值一律当字符串处理（整数参数也必须先转字符串，否则排序拼接会不一致）
  const canon = Object.keys(params).sort()
    .map(k => pe(k) + '=' + pe(params[k]))
    .join('&');
  const toSign = 'GET&%2F&' + pe(canon);
  const sig = crypto.createHmac('sha1', String(conf.accessKeySecret) + '&')
    .update(toSign).digest('base64');
  return '/?' + canon + '&Signature=' + pe(sig);
}

function callApi(action, biz, conf) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: signedPath(action, biz, conf),
      method: 'GET',
      timeout: 8000,
      headers: { Accept: 'application/json' },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(buf); } catch { /* 落到下面统一报错 */ }
        if (!data) {
          const e = new Error('短信通道返回异常');
          e.code = 'BAD_RESPONSE';
          e.raw = buf.slice(0, 300);
          return reject(e);
        }
        // 注意：Code=OK 只代表「接口调通」，验证码对不对要看 Model.VerifyResult
        if (data.Code !== 'OK') {
          const e = new Error(data.Message || data.Code || '短信通道调用失败');
          e.code = data.Code;
          return reject(e);
        }
        resolve(data.Model || {});
      });
    });
    req.on('timeout', () => { req.destroy(new Error('短信通道超时')); });
    req.on('error', reject);
    req.end();
  });
}

// ---------------- 手机号加密 ----------------
// users.json 是明文 JSON，手机号不能裸存：一旦文件被读到，等于全员号码泄露。
// AES-256-GCM 存密文，另存一份 HMAC 摘要用于「这个号是否已注册」的查重
// （查重必须能用索引，所以不能靠逐条解密比对）。
function makeCipher(secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  return {
    enc(v) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
      return [iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
    },
    dec(s) {
      try {
        const [ivB, tagB, bodyB] = String(s || '').split('.');
        if (!bodyB) return '';
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
        d.setAuthTag(Buffer.from(tagB, 'base64'));
        return Buffer.concat([d.update(Buffer.from(bodyB, 'base64')), d.final()]).toString('utf8');
      } catch { return ''; }
    },
    hash(v) { return crypto.createHmac('sha256', key).update(String(v)).digest('hex'); },
  };
}

// ---------------- 频控 ----------------
// 三道：人机验证（captcha.js，问「是不是人」）→ 本地分层频控（这里，限速+限损）→ 阿里云侧流控。
// 本地这层刻意做成「分钟 → 小时 → 天」逐层收紧的三级窗口：
//   只有天级的话，一个 IP 今天剩 10 条额度，1 秒内能全打完；加分钟级才有「坡」。
//   只有分钟级的话，脚本慢慢等就行；天级才是成本上限。
// 参数取值的依据：同号 5 条/天已经贴着《安全评估整改说明》向网安报备的口径，不能为了「看起来更严」再往下压——
// 一个正常用户注册失败重发、码过期重发很容易用掉 3 条，压到 3 条等于把正常人挡在门外，反而逼他去借号。
// 所以手机号维度只补小时层（3 条），天级维持 5 条不动；IP 维度补分钟层与小时层，天级维持 10 条不动。
const RULE = {
  phoneIntervalMs: 60 * 1000,  // 同号 60 秒（最短重发间隔）
  phonePerHour: 3,             // 同号每小时 3 条
  phonePerDay: 5,              // 同号每天 5 条（与已报备口径一致，别动）
  ipPer10Min: 6,               // 同 IP 10 分钟 6 条
  ipPerHour: 8,                // 同 IP 每小时 8 条
  ipPerDay: 10,                // 同 IP 每天 10 条（与已报备口径一致，别动）
  globalPerDay: 200,           // 全站每天总条数上限：被人拿代理池刷时的总闸门（可用 sms.json 覆盖）
  failLimit: 5,                // 同号连续校验失败 5 次，锁 10 分钟（防 6 位数字爆破）
  failLockMs: 10 * 60 * 1000,
  // 用量告警档位（占全站日上限的比例）。到档各触发一次，每天每档只报一次，避免刷屏
  alertAt: [0.6, 0.8, 1],
};

// 验证码有效期（2026-11-21 站长拍板）：默认 6 小时。站点只有实名合规这一处用短信，
// 站长想省短信费——码在 6 小时内都能用，就不用为了同一个动作反复发。代价是泄露窗口变大，
// 所以上限就卡在 6 小时，后台也能随时调短。阿里云 ValidTime 单位是秒，没有文档化的上限，
// 这里自己设上限比让配置失控要好。
const DEFAULT_VALID_TIME = 6 * 60 * 60;
const MIN_VALID_TIME = 60;
const MAX_VALID_TIME = 6 * 60 * 60;

function today() { return new Date().toISOString().slice(0, 10); }

function createSmsService(opts) {
  const dataDir = opts.dataDir;
  const log = opts.log || function () {};
  const mask = opts.maskPhone || function (v) { return String(v || ''); };
  // 用量告警回调（server.js 注入：写安全日志 + 给站长发站内信）。
  // 这层不认识 users / notices，硬塞进来会把它变成万能胶，所以只往外抛事件。
  const onAlert = typeof opts.onAlert === 'function' ? opts.onAlert : null;
  const confFile = path.join(dataDir, 'sms.json');
  const keyFile = path.join(dataDir, 'sms-key.txt');

  // 加密密钥：优先环境变量，其次文件，都没有就生成一次并落盘。
  // 密钥丢了等于所有手机号解不开——它只在这台机器上，不随仓库走。
  const secret = (() => {
    if (process.env.SMS_SECRET) return String(process.env.SMS_SECRET);
    try {
      const s = fs.readFileSync(keyFile, 'utf8').trim();
      if (s) return s;
    } catch { /* 首次运行 */ }
    const s = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(keyFile, s, { mode: 0o600 }); } catch { /* 写不了就用本次进程内的，重启后旧号码解不开 */ }
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
  // 允许运行中改 sms.json 后不重启（改完调 reload()；HTTP 层也每 5 分钟自动重读一次）
  if (typeof setInterval === 'function') {
    const t = setInterval(loadConf, 5 * 60 * 1000);
    if (t && t.unref) t.unref();
  }

  const ready = () => !!(conf.enabled && conf.accessKeyId && conf.accessKeySecret && conf.signName && conf.templateCode);
  const mode = () => (ready() ? 'live' : (conf.enabled ? 'misconfigured' : 'off'));

  // 核验奖励额度（「第一次核验通过发多少盏灯火」）。放这里而不是写死在业务代码里：
  // 300 是一个会被反复掂量的数（发多少才够吸引人、又不至于被刷号套利），站长应该能自己改。
  function verifyBonus() {
    const n = Number(conf.verifyBonus);
    if (!Number.isFinite(n) || n <= 0) return 300;
    return Math.min(2000, Math.round(n));
  }
  function setVerifyBonus(v) {
    loadConf();
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 2000) return { ok: false, error: '奖励额度需在 0–2000 之间' };
    conf.verifyBonus = n;
    try {
      fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      return { ok: false, error: '写入 data/sms.json 失败：' + (e.code || e.message) };
    }
    return { ok: true, verifyBonus: verifyBonus() };
  }

  // 验证码有效期：发码、短信模板里的分钟数、后台展示都读这一个口径，别各算各的。
  function validTime() {
    const n = Number(conf.validTime);
    if (!Number.isFinite(n) || n < MIN_VALID_TIME || n > MAX_VALID_TIME) return DEFAULT_VALID_TIME;
    return Math.round(n);
  }
  function validTimeText(sec) {
    const min = Math.max(1, Math.round(Number(sec) / 60));
    return min >= 60 ? `${Math.round(min / 6) / 10} 小时` : `${min} 分钟`;
  }
  function setValidTime(v) {
    loadConf();                                   // 先读一次，别把后台之外手改的字段覆盖掉
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < MIN_VALID_TIME || n > MAX_VALID_TIME) {
      return { ok: false, error: '验证码有效期需在 1–360 分钟之间' };
    }
    conf.validTime = n;
    try {
      fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      return { ok: false, error: '写入 data/sms.json 失败：' + (e.code || e.message) };
    }
    return { ok: true, validTime: validTime() };
  }

  // 运行中改开关（后台「实名核验」页调它）。
  // 刻意只保留 enabled 一个开关：它同时决定「发不发真短信」和「要不要强制核验」。
  // 拆成两个的话，「强制核验开着、通道关着」会让注册页收不到码，等于把注册锁死。
  // 写回文件而不是只改内存：pm2 重启、以及并行实例，都得看到同一个值。
  function setEnabled(v) {
    loadConf();                                   // 先读一次，别把后台之外手改的字段覆盖掉
    conf.enabled = !!v;
    try {
      fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      return { ok: false, error: '写入 data/sms.json 失败：' + (e.code || e.message) };
    }
    return { ok: true, mode: mode(), ready: ready(), configured: !!(conf.accessKeyId && conf.accessKeySecret && conf.signName && conf.templateCode) };
  }

  // 频控计数。手机号一律用 HMAC 摘要当键，不留明文——
  // 这份 Map 会落盘到 data/sms-rate.json，明文键等于把号码又抄进了另一个文件，
  // users.json 那边的 AES 加密就白做了。
  const phoneKey = (phone) => cipher.hash(String(phone || ''));
  const byPhone = new Map();   // phoneHash -> { day, n, lastAt, lastSentAt, sentCount, fails, lockUntil, times[] }
  const byIp = new Map();      // ip        -> { day, n, times[] }
  // 全站当日总量。这不是防单个用户，是防「有人用一堆 IP 分摊着刷」——
  // 单 IP/单号的天级限制挡不住代理池，只有总闸门能把一天的损失锁在固定金额内。
  let global = { day: today(), n: 0 };
  // 当天已报过的告警档位（'0.6' / '0.8' / '1'）；跨天清空，所以每档每天各报一次
  let alerted = new Set();

  // 每个桶只存「最近 24 小时的发送时间戳」，分钟/小时/天三个窗口都从这一个数组现算。
  // 单桶最多 10 个元素（受天级上限约束），内存可忽略；比维护三套独立字段不容易算错。
  const DAY_MS = 24 * 3600e3;
  function pruneTimes(arr, now) {
    const cut = now - DAY_MS;
    while (arr.length && arr[0] < cut) arr.shift();
    return arr;
  }
  function countSince(arr, now, ms) {
    const cut = now - ms;
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > cut) n++; else break; }
    return n;
  }

  function phoneBucket(key) {
    const d = today();
    let b = byPhone.get(key);
    if (!b) { b = { day: d, n: 0, lastAt: 0, lastSentAt: 0, sentCount: 0, fails: 0, lockUntil: 0, times: [] }; byPhone.set(key, b); }
    // 跨天只清天级计数与失败次数；lockUntil 不清——原实现跨零点把锁一起解了，
    // 等于给爆破的人一个「等到 00:00 就能继续试」的免费窗口。
    if (b.day !== d) { b.day = d; b.n = 0; b.fails = 0; }
    pruneTimes(b.times, Date.now());
    return b;
  }
  function ipBucket(ip) {
    const d = today();
    let b = byIp.get(ip);
    if (!b) { b = { day: d, n: 0, times: [] }; byIp.set(ip, b); }
    if (b.day !== d) { b.day = d; b.n = 0; }
    pruneTimes(b.times, Date.now());
    return b;
  }

  // ---------- 频控落盘 ----------
  // 为什么必须落盘：内存计数器跑一次 pm2 restart 就清零，等于每天送刷子一次「额度重置」——
  // 挑发版或重启之后打一波，天级限制形同虚设。这里只落「天级计数 + 最近 24h 时间戳」，
  // 分钟/小时窗口从时间戳现算，重启后照样准确。
  const rateFile = path.join(dataDir, 'sms-rate.json');
  let saveTimer = null;
  function dumpRate() {
    const d = today();
    const now = Date.now();
    const out = { day: d, globalN: global.day === d ? global.n : 0, phones: {}, ips: {} };
    for (const [k, v] of byPhone) {
      // 昨天的桶：锁还没解，或刚发的码还在有效期内（码可以跨天有效），都要留着；其余丢掉
      const lastSentAt = Number(v.lastSentAt) || 0;
      if (v.day !== d && v.lockUntil <= now && lastSentAt + MAX_VALID_TIME <= now) continue;
      out.phones[k] = {
        n: v.day === d ? v.n : 0,
        lastAt: v.lastAt, lastSentAt, sentCount: Number(v.sentCount) || 0,
        fails: v.fails, lockUntil: v.lockUntil,
        times: v.times.slice(-12),
      };
    }
    for (const [k, v] of byIp) {
      if (v.day !== d) continue;
      out.ips[k] = { n: v.n, times: v.times.slice(-12) };
    }
    return out;
  }
  function saveRateNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { fs.writeFileSync(rateFile, JSON.stringify(dumpRate()) + '\n', { mode: 0o600 }); }
    catch { /* 写不进去就只靠内存，不能因为磁盘问题把发码流程打断 */ }
  }
  function saveRateSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveRateNow(); }, 1500);
    if (saveTimer && saveTimer.unref) saveTimer.unref();
  }
  (function loadRate() {
    try {
      const o = JSON.parse(fs.readFileSync(rateFile, 'utf8')) || {};
      const now = Date.now();
      const d = today();
      const sameDay = o.day === d;   // 天级计数跨天归零，但锁和「刚发过码」要接着算
      global = sameDay ? { day: d, n: Number(o.globalN) || 0 } : { day: d, n: 0 };
      Object.entries(o.phones || {}).forEach(([k, v]) => {
        if (!v) return;
        const lastSentAt = Number(v.lastSentAt) || 0;
        const lockUntil = Number(v.lockUntil) || 0;
        if (!sameDay && lockUntil <= now && lastSentAt + MAX_VALID_TIME <= now) return;
        byPhone.set(k, {
          day: d, n: sameDay ? (Number(v.n) || 0) : 0,
          lastAt: sameDay ? (Number(v.lastAt) || 0) : 0, lastSentAt,
          sentCount: Number(v.sentCount) || 0,
          fails: sameDay ? (Number(v.fails) || 0) : 0, lockUntil,
          times: sameDay && Array.isArray(v.times) ? v.times.filter(Number.isFinite) : [],
        });
      });
      Object.entries(o.ips || {}).forEach(([k, v]) => {
        if (!v || !sameDay) return;
        byIp.set(k, { day: d, n: Number(v.n) || 0, times: Array.isArray(v.times) ? v.times.filter(Number.isFinite) : [] });
      });
    } catch { /* 首次运行或文件损坏：从零开始，不影响发码 */ }
  })();
  // 进程退出前同步收尾写一次。只挂 exit，不去抢 SIGINT/SIGTERM——
  // server.js 自己有优雅关闭逻辑，这里多插一脚容易把它搞成双次退出。
  try {
    process.on('exit', () => { try { saveRateNow(); } catch { /* 退出路径不能抛 */ } });
  } catch { /* 环境不允许注册时忽略 */ }

  // ---------- 用量告警 ----------
  // 到全站日上限的 60% / 80% / 100% 各报一次。日上限是「限损」不是「防刷」，
  // 真正被刷的时候 200 条能在十几分钟内打光，所以必须能提前叫醒人，
  // 而不是等第二天发现注册全停了才回头翻日志。
  function checkAlert() {
    const limit = Number(conf.globalPerDay) || RULE.globalPerDay;
    if (!limit || limit <= 0) return;
    const pct = global.n / limit;
    for (const lv of RULE.alertAt) {
      const tag = String(lv);
      if (pct < lv || alerted.has(tag)) continue;
      alerted.add(tag);
      log('sms_alert', { lv: tag, n: global.n, limit, pct: Math.round(pct * 100) });
      try { if (onAlert) onAlert({ level: lv, used: global.n, limit, pct }); }
      catch { /* 通知失败不能影响发码 */ }
    }
  }

  // 每小时清一次过期桶，避免 Map 无限长（一天最多几万个手机号，不清也能撑，但没必要）
  if (typeof setInterval === 'function') {
    const t = setInterval(() => {
      const d = today();
      const now = Date.now();
      for (const [k, v] of byPhone) {
        if (v.day === d) continue;
        if (v.lockUntil > now) continue;      // 还锁着的桶留着，跨天的锁要继续有效
        pruneTimes(v.times, now);
        if (!v.times.length) byPhone.delete(k);
      }
      for (const [k, v] of byIp) {
        if (v.day === d) continue;
        pruneTimes(v.times, now);
        if (!v.times.length) byIp.delete(k);
      }
    }, 3600e3);
    if (t && t.unref) t.unref();
  }

  // 本地伪通道：未配置密钥时把验证码打到控制台，并把码存在内存按号对应，
  // 这样本地能把「发码 → 输码 → 校验」整条链跑通，不需要真实短信。
  const localCodes = new Map();

  function normalizePhone(v) {
    const s = String(v || '').replace(/[^\d]/g, '');
    if (s.length === 13 && s.startsWith('86')) return s.slice(2);
    return s;
  }
  function phoneOk(p) { return /^1[3-9]\d{9}$/.test(p); }

  /**
   * 发码。返回 { ok, mode, error?, wait? }
   * 调用方只关心 ok 与 error，打码次数/锁定时长这类细节不上前端口径里说。
   */
  async function send(phoneRaw, ip) {
    const phone = normalizePhone(phoneRaw);
    if (!phoneOk(phone)) return { ok: false, error: '手机号格式不正确', code: 'BAD_PHONE' };

    const now = Date.now();
    const pb = phoneBucket(phoneKey(phone));
    // 对外的 code 一律收成粗粒度：以前回 TOO_FAST / PHONE_DAY_LIMIT / IP_DAY_LIMIT，
    // 等于实时告诉脚本「你卡在哪一层」——它据此判断该换号还是该换 IP。细分只进日志（reason）。
    const limited = (reason, error, wait) => ({ ok: false, error, code: 'LIMITED', reason, wait });

    if (pb.lockUntil > now) {
      return limited('CHECK_LOCKED', '校验次数过多，请 10 分钟后再试', Math.ceil((pb.lockUntil - now) / 1000));
    }
    if (pb.lastAt && now - pb.lastAt < RULE.phoneIntervalMs) {
      return limited('PHONE_FAST', '发送太频繁，请稍后再试', Math.ceil((RULE.phoneIntervalMs - (now - pb.lastAt)) / 1000));
    }
    // 站长 2026-11-21 拍板：旧码还在有效期内允许重发一次，第二次之后才锁到有效期结束。
    // 只认「真发出去过的码」——调用失败不记，否则一次通道故障就白占一次机会。
    const vt = validTime();
    if (pb.lastSentAt && now - pb.lastSentAt >= vt * 1000) pb.sentCount = 0;
    if (pb.lastSentAt && now - pb.lastSentAt < vt * 1000 && (Number(pb.sentCount) || 0) >= 2) {
      const wait = Math.ceil((vt * 1000 - (now - pb.lastSentAt)) / 1000);
      return limited('PHONE_RESEND_LIMIT', `已经重发过一次，${validTimeText(wait)}内不能再次获取，请用刚收到的验证码`, wait);
    }
    if (countSince(pb.times, now, 3600e3) >= RULE.phonePerHour) {
      return limited('PHONE_HOUR', '该手机号请求过于频繁，请稍后再试');
    }
    if (pb.n >= RULE.phonePerDay) {
      return limited('PHONE_DAY', '该手机号今日发送次数已达上限');
    }

    const ib = ipBucket(ip || 'unknown');
    // 顺序很重要：分钟 → 小时 → 天，逐层收紧。原实现只有「IP 20 次/小时」+「IP 10 条/天」，
    // 天级先耗尽导致小时那层永远撞不到，等于写了一段没人执行得上的代码。
    if (countSince(ib.times, now, 10 * 60e3) >= RULE.ipPer10Min) {
      return limited('IP_MIN', '当前网络请求过于频繁，请稍后再试');
    }
    if (countSince(ib.times, now, 3600e3) >= RULE.ipPerHour) {
      return limited('IP_HOUR', '当前网络请求过于频繁，请稍后再试');
    }
    if (ib.n >= RULE.ipPerDay) {
      return limited('IP_DAY', '当前网络今日发送次数已达上限');
    }

    const gLimit = Number(conf.globalPerDay) || RULE.globalPerDay;
    if (global.day !== today()) { global = { day: today(), n: 0 }; alerted = new Set(); }
    if (global.n >= gLimit) {
      // 触发总闸门通常意味着有人在刷：记一条日志，别静默
      log('sms_send', { ip, ok: false, d: 'GLOBAL_DAY', n: global.n });
      return limited('GLOBAL_DAY', '验证码发送通道繁忙，请稍后再试');
    }

    // 先记次数再调用：调用失败也占配额，否则失败请求就是免费的重试通道
    pb.n += 1; pb.lastAt = now; pb.times.push(now);
    ib.n += 1; ib.times.push(now);
    global.n += 1;
    saveRateSoon();
    checkAlert();

    if (!ready()) {
      // 降级模式：控制台打码。6 位纯数字，有效期跟线上一个口径（默认 6 小时），避免本地测出来的行为和线上不一样。
      if (mode() === 'misconfigured') {
        return { ok: false, error: '短信通道配置不完整，请联系管理员', code: 'NOT_CONFIGURED' };
      }
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      localCodes.set(phone, { code, exp: now + validTime() * 1000, fails: 0 });
      console.log(`[sms:local] ${mask(phone)} 验证码 ${code}（${Math.round(validTime() / 60)} 分钟内有效，未配置通道仅本机可见）`);
      pb.lastSentAt = now; pb.sentCount = (Number(pb.sentCount) || 0) + 1; saveRateSoon();
      return { ok: true, mode: 'local' };
    }

    try {
      // 模板参数：##code## 由阿里云替换成它生成的验证码；##min## 由我们按 validTime 换算成分钟，
      // 这样改了有效期不用同步改模板参数，否则短信里写的分钟数是假的。
      const minutes = Math.max(1, Math.round(validTime() / 60));
      const tparam = String(conf.templateParam || '{"code":"##code##","min":"##min##"}')
        .replace(/##min##/g, String(minutes));
      const model = await callApi('SendSmsVerifyCode', {
        PhoneNumber: phone,
        SignName: conf.signName,
        TemplateCode: conf.templateCode,
        // 占位符写法必须与模板里的变量名一字不差：预置模板 100001 是 ${code} + ${min}
        TemplateParam: tparam,
        CodeType: 1,                                  // 纯数字
        CodeLength: Number(conf.codeLength) || 6,      // 默认 4 位太短，6 位
        ValidTime: validTime(),
        DuplicatePolicy: 1,                            // 新码覆盖旧码，避免旧码还能用
        Interval: 60,                                  // 与本地频控对齐
        ReturnVerifyCode: false,                       // 生产绝不开：开了验证码会明文回到响应里
      }, conf);
      log('sms_send', { phone: mask(phone), ip, ok: true, biz: model && model.BizId ? String(model.BizId).slice(0, 40) : '' });
      pb.lastSentAt = now; pb.sentCount = (Number(pb.sentCount) || 0) + 1; saveRateSoon();
      return { ok: true, mode: 'live' };
    } catch (e) {
      log('sms_send', { phone: mask(phone), ip, ok: false, d: e.code || e.message });
      // 余额/套餐耗尽跟「这次发失败」不是一回事：它意味着从现在起所有人都收不到码，
      // 注册和发布前核验会整体停摆。频控拦不住这种情况（钱花完了频控也没用），
      // 只能立刻叫人。真去查账户余额要另接阿里云账单接口（BSS），成本不低；
      // 这里先做「失败即发现」——报文里已经写明了原因，没必要再花一次请求去问。
      const code = String(e.code || '');
      if (/AMOUNT_NOT_ENOUGH|ACCOUNT_NOT_ENOUGH|OUT_OF_SERVICE|BALANCE/i.test(code)) {
        log('sms_balance', { d: code });
        try { if (onAlert) onAlert({ level: 'balance', used: global.n, limit: gLimit, pct: 1, code }); }
        catch { /* 通知失败不影响返回 */ }
      }
      // 阿里云自己的流控也翻译成人话，别把 MESSAGE_LIMIT_CONTROL 之类的码丢给用户
      const map = {
        BUSINESS_LIMIT_CONTROL: '该手机号今日发送次数已达上限',
        MOBILE_NUMBER_ILLEGAL: '手机号格式不正确',
        FUNCTION_NOT_OPENED: '短信通道未开通，请联系管理员',
      };
      return { ok: false, error: map[e.code] || '验证码发送失败，请稍后再试', code: e.code || 'SEND_FAIL' };
    }
  }

  /**
   * 校验。返回 { ok, error?, code? }
   * 成功即代表「这个号码此刻在这台设备上」——调用方据此把手机号写进用户档案。
   */
  async function check(phoneRaw, codeRaw) {
    const phone = normalizePhone(phoneRaw);
    const code = String(codeRaw || '').replace(/\D/g, '');
    if (!phoneOk(phone)) return { ok: false, error: '手机号格式不正确', code: 'BAD_PHONE' };
    if (!/^\d{4,8}$/.test(code)) return { ok: false, error: '验证码格式不正确', code: 'BAD_CODE' };

    const pb = phoneBucket(phoneKey(phone));
    const now = Date.now();
    if (pb.lockUntil > now) {
      return { ok: false, error: '校验次数过多，请 10 分钟后再试', code: 'LOCKED' };
    }

    const bumpFail = () => {
      pb.fails = (pb.fails || 0) + 1;
      if (pb.fails >= RULE.failLimit) { pb.lockUntil = Date.now() + RULE.failLockMs; pb.fails = 0; }
      // 封锁状态必须落盘：不然重启一次就等于给爆破的人解除一次封锁
      saveRateSoon();
    };

    if (!ready()) {
      const rec = localCodes.get(phone);
      if (!rec || rec.exp < now) return { ok: false, error: '验证码已过期，请重新获取', code: 'EXPIRED' };
      if (rec.code !== code) { bumpFail(); return { ok: false, error: '验证码不正确', code: 'MISMATCH' }; }
      localCodes.delete(phone);
      pb.fails = 0;
      return { ok: true, mode: 'local' };
    }

    try {
      const model = await callApi('CheckSmsVerifyCode', { PhoneNumber: phone, VerifyCode: code }, conf);
      const pass = model && model.VerifyResult === 'PASS';
      if (!pass) { bumpFail(); return { ok: false, error: '验证码不正确或已过期', code: 'MISMATCH' }; }
      pb.fails = 0;
      return { ok: true, mode: 'live' };
    } catch (e) {
      return { ok: false, error: '校验失败，请稍后再试', code: e.code || 'CHECK_FAIL' };
    }
  }

  return {
    mode,
    ready,
    send,
    check,
    setEnabled,
    setVerifyBonus,
    setValidTime,
    verifyBonus,
    encPhone: (v) => cipher.enc(v),
    decPhone: (v) => cipher.dec(v),
    hashPhone: (v) => cipher.hash(normalizePhone(v)),
    normalizePhone,
    phoneOk,
    reload: loadConf,
    status() {
      const gLimit = Number(conf.globalPerDay) || RULE.globalPerDay;
      const used = global.day === today() ? global.n : 0;
      return {
        mode: mode(),
        enabled: !!conf.enabled,                                    // 后台开关的原始值（含配置不全的情况）
        configured: !!(conf.accessKeyId && conf.accessKeySecret && conf.signName && conf.templateCode),
        sign: conf.signName || '',
        template: conf.templateCode || '',
        validTime: validTime(),
        globalPerDay: gLimit,
        // 今日用量走内存/落盘计数（重启不丢），与后台那个「读安全日志算出来的条数」是同一件事的两种口径：
        // 日志口径是事后取证，这个口径是实时闸门，两个数偶尔差 1~2 条（写日志失败/进程崩溃）属正常。
        todayUsed: used,
        todayLeft: Math.max(0, gLimit - used),
        alerted: Array.from(alerted),
        verifyBonus: verifyBonus(),                                 // 首次核验通过发多少盏灯火（可后台改）
      };
    },
  };
}

module.exports = { createSmsService, RULE };
