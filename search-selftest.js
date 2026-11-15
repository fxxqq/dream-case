// ============================================================
// 搜索打分自测（不依赖 server.js / 不碰线上数据）
// ============================================================
// 跑法：node search-selftest.js            —— 看「改造前 vs 改造后」的前排对比
//       node search-selftest.js --check    —— 只跑断言，绿了才算能发版
//       node search-selftest.js 记账        —— 顺带打印某个词的逐件明细
//
// 断言分两组：
//   A. 容错用例（同音白字 / 拼音打错 / 缺字多字）：该命中的必须命中，且第一名对
//   B. 不变量：只要有结果，就绝不能和「只跑严格匹配」的结果有任何差别 ——
//      容错只在 0 结果时兜底，永远不许把已经有结果的那批排序搅乱
//
// 这两组是给以后调系数的人留的护栏：改 FUZZY_* 或者匹配质量，先跑这个。

const { createSearcher, norm } = require('./search-rank');

const W = (id, title, extra = {}) => ({ id, title, createdAt: '2026-01-01T00:00:00Z', ...extra });

const WORKS = [
  W('w1', '记账', { keywords: ['记账', '账本'], category: '生活助手', types: ['小程序'] }),
  W('w2', '一个能帮你自动记账的微信小程序', { keywords: ['记账'], category: '生活助手', types: ['小程序'] }),
  W('w3', '极简记账本', { keywords: ['账本', '记账'], category: '生活助手', types: ['H5'] }),
  W('w4', '随手记', { keywords: ['记账', '账本'], category: '生活助手', types: ['App'] }),
  W('w5', '语音转文字', { keywords: ['语音识别', '转录'], category: '效率工具', types: ['小程序'] }),
  W('w6', 'AI 写作助手', { keywords: ['写作', '文案'], category: '创作工具', types: ['Web'] }),
  W('w7', '番茄钟', { keywords: ['计时', '番茄钟'], category: '效率工具', types: ['小程序'] }),
  W('w8', '数字花园', { keywords: ['笔记'], category: '知识管理', types: ['Web'] }),
  W('w9', '苏州旅游地图', { keywords: ['旅行', '地图'], category: '生活助手', types: ['H5'] }),
  W('w10', '重来一次', { keywords: ['习惯'], category: '效率工具', types: ['App'] }),
  W('w11', '待办清单', { keywords: ['todo', '清单'], category: '效率工具', types: ['小程序'] })
];

const FIELDS = [
  [w => w.title, 8],
  [w => (w.keywords || []).join(' '), 6],
  [w => w.category, 5],
  [w => (w.types || []).join(' '), 5]
];

// 改造前：纯 includes + 字段权重最大值（就是 server.js 原来的 searchScore）
function oldScore(w, q) {
  const kw = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = kw.split(' ').filter(Boolean);
  const fs = FIELDS.map(([p, wt]) => [String(p(w) || '').toLowerCase(), wt]);
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const [v, wt] of fs) if (v && v.includes(t) && wt > best) best = wt;
    if (!best) return 0;
    total += best;
  }
  return total;
}

const searcher = createSearcher({ fields: FIELDS });

const sorted = q => {
  const { rows, suggest } = searcher.rank(WORKS, q);
  rows.sort((a, b) => b.s - a.s);
  return { rows, suggest };
};

// ---------- A. 容错用例 ----------
// [查询, 期望第一名标题, 期望提示（null = 不该提示）]
const FUZZY_CASES = [
  ['记帐', '记账', '记账'],            // 同音白字：帐 / 账
  ['记帐本', '极简记账本', '记账本'],   // 白字 + 多一个字
  ['jizhang', '记账', '记账'],         // 全拼
  ['jizhan', '记账', '记账'],          // 拼音少一个字母
  ['jizhangg', '记账', '记账'],        // 拼音多一个字母
  ['jizahng', '记账', '记账'],         // 拼音相邻字母打反
  ['语音特文字', '语音转文字', '语音转文字'],   // 错一个字
  ['番茄种', '番茄钟', '番茄钟'],               // 错一个字（同音）
  ['带办清单', '待办清单', '待办清单'],         // 同音白字
  ['待半清单', '待办清单', '待办清单'],         // 同音白字
  // 不该乱认的：差两个字的词、毫无关系的词，一个都不许出来
  ['乱七八', null, null],
  ['zzzz', null, null],
  ['x', null, null]
];

// ---------- B. 不变量：有结果时不许和严格匹配有任何差别 ----------
const STRICT_QUERIES = [
  '记账', '记账 小程序', '小程序', 'jz', 'jzb', 'jizhang', ' ai ', '语音', 'yuyin',
  '番茄钟', '效率工具', 'Web', 'app', '清单', '记账 账本', '生活助手 小程序'
];

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log('  ✗ ' + msg); } };

console.log('=== A. 容错用例 ===');
for (const [q, wantTop, wantSg] of FUZZY_CASES) {
  const { rows, suggest } = sorted(q);
  const top = rows[0] ? rows[0].w.title : null;
  const sg = suggest ? suggest.text : null;
  const pass = top === wantTop && sg === wantSg;
  console.log(`  ${pass ? '✓' : '✗'} ${q.padEnd(10)} → ${(top || '（无结果）').padEnd(22)} 提示 ${sg || '—'}`);
  ok(top === wantTop, `「${q}」期望第一名 ${wantTop || '无结果'}，实际 ${top || '无结果'}`);
  ok(sg === wantSg, `「${q}」期望提示 ${wantSg || '无'}，实际 ${sg || '无'}`);
}

console.log('\n=== B. 有结果时与严格匹配完全一致 ===');
for (const q of STRICT_QUERIES) {
  const a = searcher.rank(WORKS, q).rows;
  const b = searcher.rank(WORKS, q, { strict: true }).rows;
  const ka = a.map(r => `${r.w.id}:${r.s.toFixed(4)}`).sort().join('|');
  const kb = b.map(r => `${r.w.id}:${r.s.toFixed(4)}`).sort().join('|');
  ok(ka === kb, `「${q}」容错开关改变了结果集`);
  console.log(`  ${ka === kb ? '✓' : '✗'} ${q.padEnd(14)} ${a.length} 件`);
}

// ---------- 顺带：改造前后对比表（人看的） ----------
if (!process.argv.includes('--check')) {
  const QUERIES = ['记账', 'jz', 'jizhang', 'jzb', ' ji zhang ', 'yuyin', 'yyzz', 'ai', '小程序', '记账 小程序'];
  for (const q of QUERIES) {
    const oldRows = WORKS.map(w => ({ w, s: oldScore(w, q) })).filter(r => r.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 4);
    const { rows, suggest } = sorted(q);
    const fmt = r => `${r.w.title}(${r.s.toFixed(1)}${r.py ? '·拼' : ''})`;
    console.log(`\n查询「${q}」`);
    console.log('  改造前:', oldRows.length ? oldRows.map(r => `${r.w.title}(${r.s})`).join(' > ') : '（无结果）');
    console.log('  改造后:', rows.length ? rows.slice(0, 4).map(fmt).join(' > ') : '（无结果）');
    if (suggest) console.log(`  提示  : 你是不是想搜「${suggest.text}」`);
  }
}

// ---------- 单条诊断：把某个词的分数来源拆开看 ----------
const detail = process.argv.find(a => a !== '--check' && !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);
if (detail) {
  console.log('\n=== 明细 ===');
  for (const w of WORKS) console.log(norm(w.title), searcher.analyze(w, detail));
}

if (fail) {
  console.log(`\n✗ ${fail} 条断言没过`);
  process.exit(1);
}
console.log('\n✓ 全部断言通过');
