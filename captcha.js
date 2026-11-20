/**
 * 人机验证（滑块拼图）—— 服务端一半
 *
 * 为什么要它：
 * /api/sms/send 对未登录开放（注册页要用），不挂人机校验时任何人一行 curl 就能把
 * 短信余额当免费靶场。同号 / 同 IP / 全站的频控只能「限损」，挡不住别人换号换 IP 继续打。
 * 真正的第一道闸必须问一句「对面是不是人」，频控才有意义。
 *
 * 强度边界（写清楚，别自欺）：
 * 拼图位置（gapX）由服务端随机 seed 派生，接口只下发 seed，不下发坐标——
 * 这一层挡的是「直接调接口的脚本」，它必须先顺次拿 challenge、复现前端的 PRNG、再造一条像人的轨迹。
 * 挡不住的是「读懂前端 JS 的人」：前端要用同一个 seed 算出 gapX 才能把块画在图上，
 * 所以算法是对外的。这跟业界多数前端拼图实现是同一个水平。
 * 要再往上加，只有两条路：服务端栅格化出图（要引 canvas/sharp，破本项目零依赖的底线），
 * 或接第三方验证码（阿里云验证码 / Turnstile，多一个外部依赖与费用）。现阶段不值得。
 *
 * 除终点匹配外还校验轨迹：点数、总时长、x 单调性、平均速度。
 * 只校验终点的话「知道 gapX 就一把梭」，轨迹要求让自动化至少得模拟一次人手拖动。
 *
 * 协议：
 *   issue(ip)                        -> { id, seed, w, h, piece, tol, ttl }
 *   verify(ip, id, x, track)         -> { ok:true, ticket, ttl } | { ok:false, error, code }
 *   consume(ip, ticket)              -> true / false（/api/sms/send 调用，一次性）
 */
const crypto = require('crypto');

const CHALLENGE_TTL = 3 * 60 * 1000;   // 拿到题 3 分钟内要拖完；够慢手慢脚，也够短到没法囤题
const TICKET_TTL = 90 * 1000;          // 过了滑块到点「获取验证码」之间 90 秒
const MAX_CHALLENGES = 4000;            // 内存地板：被刷时别无限涨
const MAX_TICKETS = 4000;
const FAIL_LOCK = { limit: 8, windowMs: 10 * 60 * 1000 };  // 同 IP 10 分钟错 8 次就停一会儿

// 画布几何：前后端必须完全一致（frontend/captcha.js 里同名常量）
const GEO = { w: 320, h: 160, piece: 46, gapMin: 56, gapMax: 266, tol: 7 };

/**
 * seed -> gapX。前端有一份一模一样的实现，改这里必须同步改那边，否则全站拖不过。
 * 用 murmur3 的尾部混淆，比 seed % N 分布好，也让「相邻 seed 得到相邻答案」这种规律消失。
 */
function deriveGap(seed) {
  let h = (Number(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return GEO.gapMin + (h % (GEO.gapMax - GEO.gapMin + 1));
}

/**
 * 轨迹校验。track = [[x, y, t], ...]，t 是相对拖动起点的毫秒数。
 * 阈值刻意宽松：真人用鼠标抖着拖、用触屏一顿一顿拖都能过；
 * 卡的只是「一个点飞过去」「瞬时到底」「均匀匀速直线」这几种机器特征。
 */
function trackOk(track) {
  if (!Array.isArray(track) || track.length < 6 || track.length > 400) return false;
  const pts = [];
  for (const p of track) {
    if (!Array.isArray(p) || p.length < 3) return false;
    const x = Number(p[0]); const y = Number(p[1]); const t = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return false;
    if (x < -10 || x > GEO.w + 60) return false;
    // y 不参与定位判定，这里只是兜「明显的脏数据」。边界给得很宽是有意的：
    // 前端历史上传过视口坐标（y 能到 500+），按画布尺度卡会把人全判成机器。
    // 真要防的不是这个维度，别在这里加严。
    if (y < -400 || y > 1600) return false;
    pts.push({ x, y, t });
  }
  for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t) return false;   // 时间倒流

  const dur = pts[pts.length - 1].t - pts[0].t;
  // 150ms 是「手最快」和「机器瞬移」之间的分界：真人从 0 拖到 200px 一般 300ms 以上，
  // 快手也能到 180ms 左右；脚本一次性 set 到终点则是 0~20ms。别调太高，会误伤手快的用户。
  if (dur < 150 || dur > 12000) return false;        // 150ms 以内到底 = 瞬移；12 秒以上 = 挂机或脚本在 sleep
  const dist = pts[pts.length - 1].x - pts[0].x;
  if (dist < 40) return false;                        // 压根没拖
  if (dist / Math.max(1, dur) > 4) return false;      // >4px/ms 是机器速度，人手到不了

  // 回撤总量，而不是「负向采样点个数」：人拖到目标附近会微调，一次回拉 10px 就能产生五六个负 delta 点，
  // 按点数算会把人挡在门外。按距离累计，允许小幅回调，但来回拉锯（总回撤 > 16px）不是人手。
  let backSum = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].x - pts[i - 1].x;
    if (d < 0) backSum += -d;
  }
  if (backSum > 16) return false;
  return true;
}

function createCaptchaService(opts) {
  const log = (opts && opts.log) || function () {};
  const challenges = new Map();   // id -> { seed, ip, exp, used }
  const tickets = new Map();      // ticket -> { ip, exp }
  const fails = new Map();        // ip -> { n, exp }

  function sweep() {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.exp < now || challenges.size > MAX_CHALLENGES) challenges.delete(k);
    for (const [k, v] of tickets) if (v.exp < now || tickets.size > MAX_TICKETS) tickets.delete(k);
    for (const [k, v] of fails) if (v.exp < now) fails.delete(k);
  }
  if (typeof setInterval === 'function') {
    const t = setInterval(sweep, 60e3);
    if (t && t.unref) t.unref();
  }

  function issue(ip) {
    sweep();
    const id = crypto.randomBytes(18).toString('base64url');
    const seed = crypto.randomInt(0, 0x7fffffff);
    challenges.set(id, { seed, ip: String(ip || ''), exp: Date.now() + CHALLENGE_TTL, used: false });
    return {
      id, seed,
      w: GEO.w, h: GEO.h, piece: GEO.piece, tol: GEO.tol,
      minX: GEO.gapMin, maxX: GEO.gapMax,
      ttl: CHALLENGE_TTL,
    };
  }

  function verify(ip, id, x, track) {
    const now = Date.now();
    const key = String(ip || '');
    const fb = fails.get(key);
    if (fb && fb.exp > now && fb.n >= FAIL_LOCK.limit) {
      return { ok: false, error: '验证失败次数过多，请 10 分钟后再试', code: 'CAPTCHA_LOCKED' };
    }

    const ch = challenges.get(String(id || ''));
    if (!ch) return { ok: false, error: '验证已过期，请重新验证', code: 'CAPTCHA_EXPIRED' };
    if (ch.used) return { ok: false, error: '验证已使用，请重新验证', code: 'CAPTCHA_USED' };
    if (ch.exp < now) { challenges.delete(String(id)); return { ok: false, error: '验证已过期，请重新验证', code: 'CAPTCHA_EXPIRED' }; }
    // 题与 IP 绑定：别人拿到题串也没法在另一台机器上用（也顺手挡住「囤一批题慢慢算」）
    if (ch.ip && key && ch.ip !== key) return { ok: false, error: '验证已失效，请重新验证', code: 'CAPTCHA_IP' };

    const nx = Number(x);
    const gap = deriveGap(ch.seed);
    const near = Number.isFinite(nx) && Math.abs(nx - gap) <= GEO.tol;
    if (!near || !trackOk(track)) {
      ch.used = true;                        // 错一次就作废这张题，不给「同一题反复试」的机会
      challenges.delete(String(id));
      const rec = (!fb || fb.exp < now) ? { n: 0, exp: now + FAIL_LOCK.windowMs } : fb;
      rec.n += 1; fails.set(key, rec);
      log('captcha_fail', { ip: key, near, track: trackOk(track), n: rec.n });
      return { ok: false, error: near ? '拖动轨迹异常，请重新验证' : '拼图没对上，请重新验证', code: 'CAPTCHA_FAIL' };
    }

    challenges.delete(String(id));
    fails.delete(key);
    const ticket = crypto.randomBytes(20).toString('base64url');
    tickets.set(ticket, { ip: key, exp: now + TICKET_TTL });
    sweep();
    return { ok: true, ticket, ttl: TICKET_TTL };
  }

  /** 消费一次票。返回 true 才允许继续（发短信）。 */
  function consume(ip, ticket) {
    const t = tickets.get(String(ticket || ''));
    if (!t) return false;
    tickets.delete(String(ticket));          // 先删：无论成败都只算一次，避免「一张票发多条」
    if (t.exp < Date.now()) return false;
    if (t.ip && String(ip || '') && t.ip !== String(ip)) return false;
    return true;
  }

  /** 仅供后台/自检：当前手上还有多少张未用的题与票 */
  function stats() {
    sweep();
    return { challenges: challenges.size, tickets: tickets.size, lockedIps: fails.size };
  }

  return { issue, verify, consume, stats, deriveGap, GEO };
}

module.exports = { createCaptchaService, deriveGap, trackOk, GEO };
