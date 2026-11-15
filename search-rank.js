// ============================================================
// 站内搜索：拼音匹配 + 错字容错 + 相关度打分
// ============================================================
// 为什么单独一个文件：这套逻辑要同时给「前台搜索框」「后台作品列表」「自测脚本」三处用。
// 之前各写各的 includes（server.js 里前台一套、后台一套），改一处漏一处，
// 这个文件就是那个「只写一份」的地方。依赖单向：这里不 require server.js，
// 字段表由调用方 createSearcher({ fields }) 传进来。
//
// 四层：
//   1) 规范化  小写、全角转半角、标点当分隔符 —— 输入法打出来的全角字母/数字也能搜到
//   2) 匹配    原文子串 / 全拼 / 声母，三种都算命中，各自带「匹配质量」
//   3) 容错    同音字（记帐→记账）、差一个字/一个字母（jizhangg、记账本本）—— 只在第一遍严格匹配
//              全军覆没时才启用，见 rank() 里「零结果才容错」
//   4) 打分    字段权重 × 匹配质量 × 长度惩罚 × （拼音/容错折扣）
//
// 拼音数据在 pinyin-dict.js（GB2312 6763 字，构建期生成，运行时不带依赖）。

const { PY } = require('./pinyin-dict');

// ---------- 可调的系数 ----------
// 拼音命中一律打折：用户真打了「记账」这两个字，就该比打 jz 的人排得靠前。
const PY_FULL = 0.55;    // 全拼（jizhang）
const PY_ABBR = 0.38;    // 声母（jz / jzb）
const ABBR_MIN = 2;      // 声母最少几个字母才启用：单个 a / s 会命中一大片
// 匹配质量：同一个字段里，「标题就叫记账」和「标题中间出现记账」不该同分
const Q_EXACT = 3.0;     // 整个字段与查询词完全相等
const Q_PREFIX = 2.0;    // 从字段开头命中
const Q_WORD = 1.6;      // 从词首命中（英文/数字的单词边界）
const Q_MID = 1.0;       // 中间某处命中
// 容错折扣：同音字几乎算打对了（用户想的就是那个词），差一个字则明显要压一档。
const FUZZY_HOMO = 0.72;
const FUZZY_EDIT = 0.40;
// 编辑距离的门槛：2 个字的词差 1 个字等于改了半个词，「记账→记载」这种必须拦住。
const EDIT_MIN_CJK = 3;   // 汉字至少 3 个才容忍 1 个错字
const EDIT_MIN_LAT = 4;   // 拼音至少 4 个字母才容忍 1 个错字母
// 只在权重 ≥ 4 的字段上做容错（标题/关键词/作者/分类/形态），正文和域名上的错字不值得算。
const FUZZY_MIN_WEIGHT = 4;

// ---------- 1. 规范化 ----------
// 全角！～ → 半角、顿号逗号分号当空格、连续空白合并。
// 「完全相等」也是在规范化之后比的，两边口径一致。
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000\u00A0]/g, ' ')
    .replace(/[\u3001\u3002\uFF0C\uFF1B\uFF1A\u2018\u2019\u201C\u201D\u300A\u300B\u3010\u3011]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const isLetterTok = t => /^[a-z0-9]+$/.test(t);
const hasCJK = t => /[\u3400-\u9fff]/.test(t);
// 首字母掩码预判：a-z 开头才查掩码，数字开头一律放行（掩码只按读音首字母建的）
const leadOk = (f, tok) => {
  const c = tok.charCodeAt(0);
  if (c < 97 || c > 122) return true;
  return (f.mask & (1 << (c - 97))) !== 0;
};

// ---------- 2. 拼音音节 ----------
// 每个字段切成「单位」数组，一个单位 = 一个汉字（可能多个读音）或一段连续英文/数字。
// 空格标点记 null：声母匹配时透明跳过（"记账 本" 和 "记账本" 一样能打 jzb）。
// 用数组而不是拼接字符串，是因为 "jzb" 拼成串再 includes 会跨音节假命中
// （"jzang" 会被 "ji|zhang|ben" 蒙对），逐单位对齐才不会。
// off 可选：顺手记下每个单位在原串里的字符下标 —— 同音命中后要按这个
// 把原文那一段切出来当「你是不是想搜」的修正词（off 比 units 多一位收尾，见 endOff）。
function unitsOf(raw, off) {
  const out = [];
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9FFF) {
      if (off) off.push(i);
      out.push(PY.get(ch) || null);         // 生僻字查不到 → 只走原文匹配
      i++;
    } else if (/[a-z0-9]/.test(ch)) {
      let j = i;
      while (j + 1 < raw.length && /[a-z0-9]/.test(raw[j + 1])) j++;
      if (off) off.push(i);
      out.push([raw.slice(i, j + 1)]);      // 英文整段算一个单位（ai → "ai"，不是 a+i）
      i = j + 1;
    } else {
      if (off) off.push(i);
      out.push(null);
      i++;
    }
  }
  return out;
}

// 单位下标 → 原串字符下标（越界就是串尾）。off 里每个单位一项，长度和 units 一致。
const offOf = (f, ui) => (ui < f.off.length ? f.off[ui] : f.raw.length);

// 全拼：从第 i 个单位起，把查询词按音节边界吃掉。
// 返回 { pos, end }；end = 停下来的单位下标（越过最后一个非空单位 = 整段命中）。
// 多音字在这里天然解决：每个单位自带候选读音，逐一试，不需要为「重」生成几套全拼串。
//
// 记忆表不用 Set：这是全站最热的一段（500 件 × 7 字段 × 每次搜索），
// 每字段新建一个 Set 光分配就够呛。改成共享 Int32Array + 代际戳，
// 命中过的格子写入当前代次，代次不同就是「这一轮没走过」。
let MEMO = new Int32Array(4096);
let MEMO_GEN = 0;
function matchFull(units, q) {
  const need = units.length * (q.length + 1);
  if (need > MEMO.length) MEMO = new Int32Array(need * 2);
  const gen = ++MEMO_GEN;
  function go(ui, qi) {
    if (qi >= q.length) return ui;
    if (ui >= units.length) return -1;
    const u = units[ui];
    if (!u) return go(ui + 1, qi);          // 标点透明
    const key = ui * (q.length + 1) + qi;
    if (MEMO[key] === gen) return -1;
    MEMO[key] = gen;
    for (const r of u) {
      if (r.length <= q.length - qi && q.startsWith(r, qi)) {
        const end = go(ui + 1, qi + r.length);
        if (end >= 0) return end;
      }
    }
    return -1;
  }
  for (let i = 0; i < units.length; i++) {
    if (!units[i]) continue;
    const end = go(i, 0);
    if (end >= 0) return { pos: i, end };
  }
  return null;
}

// 声母：一个字母吃一个单位（zhuang 的声母也是 z，跟汉字个数对齐）。
// 必须**连续**命中：允许跳字的话，「番茄钟」(f-q-z) 会被 jz 蒙中（j 来自关键词「计时」），
// 一搜 jz 全是无关作品。要求连续之后，jzb 只可能来自「记-账-本」这种真正的三连字。
function matchAbbr(units, q) {
  for (let i = 0; i < units.length; i++) {
    if (!units[i]) continue;
    let k = 0, j = i;
    while (j < units.length && k < q.length) {
      const u = units[j];
      if (!u) { j++; continue; }            // 空格标点透明，不占字母
      // 只认**主读音**的声母：多音字全放进来会到处误伤 ——「番茄钟」的茄读 jia，
      // 全读音匹配下它就能被 jz 搜到。全拼路径仍然用全部读音（chongfu 能搜到「重复」）。
      if (u[0][0] !== q[k]) break;
      k++; j++;
    }
    if (k === q.length) return { pos: i, end: j };
  }
  return null;
}

// 长度惩罚：同样「标题里含这个词」，标题越短说明越对题。
// 2 字标题 ≈ 0.76，8 字 ≈ 0.57，18 字 ≈ 0.37 —— 足够把
// 《记账》 和 《一个能帮你自动记账的微信小程序》拉开，又不至于让长标题彻底消失。
function lenPen(len) {
  return 1 / (1 + Math.log2(1 + Math.max(0, len) / 8));
}
const sylLenOf = units => units.reduce((n, u) => n + (u ? 1 : 0), 0);
const firstIdxOf = units => units.findIndex(Boolean);
const lastIdxOf = units => { for (let i = units.length - 1; i >= 0; i--) if (units[i]) return i; return -1; };

// 「词首」判定：只对英文/数字有效（AI 命中 Artificial 的内部就该按最低档算）。
// 汉字没有空格可分，任何一个位置都可能是词首，「记账」出现在「极简记账本」第 3 个字
// 和第 1 个字，对搜索来说都是「这个标题里有这个词」，所以汉字一律按词首算。
function boundaryAt(raw, idx) {
  if (idx <= 0) return true;
  return !/[a-z0-9]/.test(raw[idx - 1]);
}

// ---------- 3. 容错 ----------
// ① 同音：把汉字查询换成「它自己的读音」，再走全拼匹配。
//    记帐 → jizhang，跟字段「记账」的音节串一模一样 → 命中。
//    这条同时覆盖两个方向：查询写了白字（记帐）、或者作品标题里写了白字（记帐），
//    因为两边最终都比的是读音。多音字取主读音，够用了（全拼路径本来就用全部读音）。
function syllsOf(tok) {
  let out = '';
  for (const ch of tok) {
    const code = ch.codePointAt(0);
    if (code < 0x3400 || code > 0x9FFF) return null;
    const r = PY.get(ch);
    if (!r || !r[0]) return null;
    out += r[0];
  }
  return out || null;
}

// ② 差一个字符：增 / 删 / 改 / 相邻对调，四选一。
//    故意不用完整 Levenshtein —— 只需要「有一处对不上」，用 indexOf 定位前缀再验后缀，
//    比 DP 快一个量级（DP 是 O(字段长 × 词长)，这里是 O(词长) 次原生扫描）。
//    返回 { idx, len }：命中位置 + 原文那一段的长度（可能是 m-1 / m / m+1）。
function nearIn(hay, tok) {
  const m = tok.length;
  if (m < 2 || !hay) return null;
  let best = null;
  const hit = (idx, len) => { if (idx >= 0 && (!best || idx < best.idx)) best = { idx, len }; };

  // 查询多打了一个字：字段里是「删掉某个字」的版本（记账户 → 记账）
  for (let i = 0; i < m; i++) {
    const p = tok.slice(0, i) + tok.slice(i + 1);
    if (p.length < 2) continue;
    const j = hay.indexOf(p);
    if (j >= 0) hit(j, p.length);
  }

  // 同长度错一个字 / 字段多一个字：先定位前缀，再跳过 1 个字符验后缀
  for (let i = 0; i < m; i++) {
    const pre = tok.slice(0, i);
    const sub = tok.slice(i + 1);           // 同长度：hay[j+i] 是错的那个字
    const ins = tok.slice(i);               // 长一个：hay[j+i] 是白多出来的字
    if (i === 0) {                          // 没有前缀可定位，起点逐个试（字段短，代价可忽略）
      for (let j = 0, lim = hay.length - m; j <= lim; j++) {
        if (sub && hay.startsWith(sub, j + 1)) { hit(j, m); break; }
      }
      for (let j = 0, lim = hay.length - m - 1; j <= lim; j++) {
        if (ins && hay.startsWith(ins, j + 1)) { hit(j, m + 1); break; }
      }
      continue;
    }
    for (let j = hay.indexOf(pre); j >= 0; j = hay.indexOf(pre, j + 1)) {
      if (sub && hay.startsWith(sub, j + i + 1)) hit(j, m);
      if (ins && hay.startsWith(ins, j + i + 1)) hit(j, m + 1);
    }
  }

  // 相邻两个字打反了（jizahng / 记帐账）
  for (let i = 0; i + 1 < m; i++) {
    const sw = tok.slice(0, i) + tok[i + 1] + tok[i] + tok.slice(i + 2);
    hit(hay.indexOf(sw), m);
  }
  return best;
}

// ---------- 4. 单字段打分 ----------
// fuzzy 只在「这份结果集里这个词一条都没命中」时才传 true（见 rank）。
function fieldScore(f, tok, fuzzy) {
  let best = 0;
  const idx = f.raw.indexOf(tok);
  if (idx >= 0) {
    const q = f.raw === tok ? Q_EXACT
      : idx === 0 ? Q_PREFIX
        : boundaryAt(f.raw, idx) ? Q_WORD : Q_MID;
    best = f.weight * q * lenPen(f.raw.length);
  }
  // 汉字查询不走拼音路径（白算）；英数查询才走。
  // 先用首字母掩码快速排除：字段里根本没有以这个字母开头的读音，拼音/声母都不可能命中。
  if (isLetterTok(tok) && tok.length >= ABBR_MIN && tok !== f.raw && leadOk(f, tok)) {
    const syl = f.syl;
    const n = f.sylLen;
    if (n) {
      const first = firstIdxOf(syl);
      const last = lastIdxOf(syl);
      const m = matchFull(syl, tok);
      if (m) {
        // 拼音这边两条约定：
        // ① 「中间命中」按词首（Q_WORD）算，不按 Q_MID —— 拼音里每个位置都是音节边界，
        //    「极简记账本」里的 jizhang 就是完整一个词，按 Q_MID 罚会跟汉字查询的排序打架。
        // ② 长度惩罚用字段的字符数（跟原文匹配同一个基准），不用音节数。
        //    这两条合起来保证：拼音排序 = 汉字排序 × 一个固定折扣，同一个词不会因为
        //    用户打的是 jizhang 还是「记账」而排出两种结果。
        const whole = m.pos === first && m.end > last;
        const s = f.weight * (whole ? Q_EXACT : m.pos === first ? Q_PREFIX : Q_WORD) * lenPen(f.raw.length) * PY_FULL;
        if (s > best) best = s;
      }
      // 声母：查询字母数不能超过可用单位数（拼音音节数 ≥ 汉字数，超了必对不上）
      if (tok.length <= n) {
        const a = matchAbbr(syl, tok);
        if (a) {
          const whole = a.pos === first && a.end > last && tok.length === n;
          const s = f.weight * (whole ? Q_EXACT : a.pos === first ? Q_PREFIX : Q_WORD) * lenPen(f.raw.length) * PY_ABBR;
          if (s > best) best = s;
        }
      }
    }
  }
  if (fuzzy && best === 0 && f.fz) best = fuzzyScore(f, tok);
  return best;
}

// 容错打分：同音优先于编辑距离（同音是「打错字」，编辑距离可能是「记错词」）。
function fuzzyScore(f, tok) {
  let best = 0;
  const first = firstIdxOf(f.syl);
  const last = lastIdxOf(f.syl);
  if (hasCJK(tok)) {
    // 同音只要 2 个字就够：「记帐」正是最常见的那类手写白字，卡在 3 字会把这个案子漏掉。
    // 音对字不对基本只有两种可能：打错字，或者它就是个同音的别的东西 —— 零结果场景下
    // 前者概率高得多，所以放开。
    if (tok.length >= 2) {
      const sylQ = syllsOf(tok);
      if (sylQ && f.sylLen) {
        const m = matchFull(f.syl, sylQ);
        if (m) {
          const whole = m.pos === first && m.end > last;
          const q = whole ? Q_EXACT : m.pos === first ? Q_PREFIX : Q_WORD;
          best = f.weight * q * lenPen(f.raw.length) * FUZZY_HOMO;
        }
      }
    }
    // 编辑距离要 3 个字：2 个字的词改一个字等于改了半个词，「记账→记载」这类必误伤。
    if (tok.length >= EDIT_MIN_CJK) {
      const n = nearIn(f.raw, tok);
      if (n) {
        const s = f.weight * (n.idx === 0 ? Q_PREFIX : Q_WORD) * lenPen(f.raw.length) * FUZZY_EDIT;
        if (s > best) best = s;
      }
    }
  } else if (isLetterTok(tok) && tok.length >= EDIT_MIN_LAT && leadOk(f, tok)) {
    // 拼音打错一个字母（jizhangg / jizhan / jizahng）：在「主读音连写」上找近似片段。
    // 只在主读音上连写，不展开多音字 —— 容错本来就是兜底，别为它把索引撑大。
    const py = looseOf(f);
    const n = py ? nearIn(py, tok) : null;
    if (n) best = f.weight * (n.idx === 0 ? Q_PREFIX : Q_WORD) * lenPen(f.raw.length) * FUZZY_EDIT;
  }
  return best;
}

// 主读音连写（"ji zhang ben" → "jizhangben"），容错用，懒生成
function looseOf(f) {
  if (f.pyLoose === undefined) f.pyLoose = f.syl.map(u => (u ? u[0] : '')).join('');
  return f.pyLoose;
}

// ---------- 5. 建索引 + 缓存 ----------
// 索引不能每次请求重建：前端是 320ms 防抖的即时搜索，一个词打完会打好几次请求，
// 每次把几百件作品的标题重新切一遍音节没有意义。
// 缓存挂 WeakMap（作品对象回收就跟着回收），版本号取 updatedAt + title：
// 后台改标题是最常见的编辑，title 一比就知道变没变。
function versionOf(w) {
  return (w.updatedAt || w.createdAt || '') + '\u0001' + (w.title || '');
}

function createSearcher({ fields }) {
  const cache = new WeakMap();

  function indexOf(w) {
    const ver = versionOf(w);
    const hit = cache.get(w);
    if (hit && hit.ver === ver) return hit.fields;
    const out = fields.map(([pick, weight]) => {
      const raw = norm(pick(w));
      const off = [];
      const syl = raw ? unitsOf(raw, off) : [];
      // 首字母位掩码：拼音/声母匹配都要求「查询首字母 = 某个音节的声母」，
      // 一个字段里一个 z 都没有，就别为 zzzz 这类查询白跑匹配了（长标题上很值）。
      let mask = 0;
      for (const u of syl) if (u) for (const r of u) mask |= 1 << (r.charCodeAt(0) - 97);
      return { raw, syl, off, mask, sylLen: sylLenOf(syl), weight, fz: weight >= FUZZY_MIN_WEIGHT };
    });
    cache.set(w, { ver, fields: out });
    return out;
  }

  // 单件作品 × 一组词 → { s, raw, parts }
  //   parts = 每个词各自的得分（0 = 这个词没命中）；s = 全中时才是和，否则 0（AND 语义）
  //   fuzzySet = 允许走容错的词下标集合（null = 全部严格）
  // 注意：即便有词没命中也要把后面的词算完 —— rank 靠 parts 统计「哪个词全站一条都没
  // 命中」，只看整体命中与否会把这个信息吃掉。
  function scoreWork(w, tokens, fuzzySet) {
    const fs = indexOf(w);
    const parts = [];
    let total = 0, rawHit = false, all = true;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const fz = !!fuzzySet && fuzzySet.has(i);
      let best = 0;
      for (const f of fs) {
        if (!f.raw) continue;
        if (f.raw.indexOf(t) >= 0) rawHit = true;
        const s = fieldScore(f, t, fz);
        if (s > best) best = s;
      }
      if (!best) all = false;
      parts.push(best);
      total += best;
    }
    return { s: all ? total : 0, raw: rawHit && all, parts };
  }

  // 返回 { s, raw }：s = 0 不命中；raw = 是否靠原文（非拼音）命中过
  function analyze(w, q, tokens) {
    const kw = norm(q);
    if (!kw) return { s: 0, raw: false };
    const ts = tokens || kw.split(' ').filter(Boolean).slice(0, 5);
    const r = scoreWork(w, ts, null);
    return { s: r.s, raw: r.raw };
  }

  function score(w, q) {
    try { return analyze(w, q).s; } catch { return 0; }   // 单件数据脏不该让整个搜索失败
  }

  // 一批作品跑一遍。
  // 零结果才容错：第一遍严格匹配，只有某个词在整批里一条都没命中时，才带着容错重跑一遍。
  // 这样做的好处 —— ① 代价只在「用户看到 0 结果」时付；② 平时绝不误伤（搜「记账」不会
  // 因为容错而多出「记载」）；③ 一旦命中，说明用户确实是打错字了，结果集是干净的。
  function rank(list, q, opts) {
    const kw = norm(q);
    if (!kw) return { rows: [], suggest: null };
    const tokens = kw.split(' ').filter(Boolean).slice(0, 5);
    const pureLetter = isLetterTok(kw);

    let rows = [];
    const hits = new Array(tokens.length).fill(0);
    for (const w of list) {
      const r = scoreWork(w, tokens, null);
      for (let i = 0; i < tokens.length; i++) if (r.parts[i] > 0) hits[i]++;
      if (r.s > 0) rows.push({ w, s: r.s, raw: r.raw, py: pureLetter && !r.raw });
    }

    // 哪些词一个都没命中？只让这些词走容错，其余的保持严格 ——
    // 混合查询（「记帐 小程序」）里「小程序」正常命中，「记帐」才需要纠正。
    // 注意这条不变量：只要有结果，就说明每个词都在同一件作品里命中过 → miss 必空 → 不会走容错。
    // 也就是说「搜得到的东西，排序一个字节都不变」，容错只发生在「本来 0 结果」的场景。
    const miss = new Set();
    if (!(opts && opts.strict)) {
      for (let i = 0; i < tokens.length; i++) if (!hits[i]) miss.add(i);
    }

    if (miss.size) {
      rows = [];
      for (const w of list) {
        const r = scoreWork(w, tokens, miss);
        if (r.s > 0) rows.push({ w, s: r.s, raw: r.raw, py: pureLetter && !r.raw });
      }
    }

    return { rows, suggest: suggestOf(rows, kw, { pureLetter, tokens, miss }) };
  }

  // 「你是不是想搜」：只在「用户明显打错/打偏」时给，别变成噪音。
  //   A. 纯字母查询、全靠拼音命中（jz → 记账）：用作品里那段真实写法
  //   B. 中文查询、靠同音/错字才命中（记帐 → 记账）：把打错的词换成作品里的写法
  // 取分最高的那件而不是列表第一件 —— rank 是按传入顺序进来的，没排过序。
  function suggestOf(rows, kw, ctx) {
    if (!rows.length) return null;
    let top = null;
    for (const r of rows) if (!top || r.s > top.s) top = r;
    const fs = indexOf(top.w);

    if (ctx.pureLetter && rows.every(r => !r.raw)) {
      const text = fixToken(fs, kw) || String(top.w.title || '').trim();
      if (text && norm(text) !== kw) return { q: kw, text, id: top.w.id };
      return null;
    }
    if (ctx.miss && ctx.miss.size) {
      let changed = false;
      const out = ctx.tokens.map((t, i) => {
        if (!ctx.miss.has(i)) return t;
        const fix = fixToken(fs, t);
        if (fix && fix !== t) { changed = true; return fix; }
        return t;
      });
      const text = out.join(' ');
      if (changed && text && norm(text) !== kw) return { q: kw, text, id: top.w.id };
    }
    return null;
  }

  // 把「用户打的词」换成「这件作品里的真实写法」：同音/拼音命中直接取原文那一段，
  // 差一个字的取近似片段。只在 suggestOf 里对 1 件作品调用，不在热路径上。
  function fixToken(fs, tok) {
    const cjk = hasCJK(tok);
    const sylQ = cjk ? syllsOf(tok) : tok;      // 汉字先转成自己的音节串再比
    for (const f of fs) {                        // fields 顺序 = 权重顺序，标题优先
      if (!f.raw || !f.sylLen) continue;
      if (sylQ) {
        let m = matchFull(f.syl, sylQ);
        if (!m && !cjk && tok.length <= f.sylLen) m = matchAbbr(f.syl, tok);
        if (m) {
          const t = f.raw.slice(offOf(f, m.pos), offOf(f, m.end)).trim();
          if (t && t !== tok) return t;
        }
      }
      if (cjk) {
        const n = nearIn(f.raw, tok);
        if (n) {
          const t = f.raw.slice(n.idx, n.idx + n.len).trim();
          if (t && t !== tok) return t;
        }
      }
    }
    return null;
  }

  return { score, rank, analyze, indexOf, norm };
}

module.exports = {
  createSearcher, norm, unitsOf, matchFull, matchAbbr, fieldScore, lenPen, nearIn, syllsOf,
  PY_FULL, PY_ABBR, Q_EXACT, Q_PREFIX, Q_WORD, Q_MID, FUZZY_HOMO, FUZZY_EDIT
};
