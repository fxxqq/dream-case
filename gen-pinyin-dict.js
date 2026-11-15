// ============================================================
// 生成 pinyin-dict.js（站内搜索用的汉字→拼音表）
// ============================================================
// 为什么要有这个脚本：项目运行时不带任何拼音依赖，只靠一张「字→读音」静态表
// （server 启动时解析成 Map，见 pinyin-dict.js 尾部）。表不能手写 6763 个字，
// 所以放到「构建期」生成一次，生成完 pinyin-pro 就可以卸掉。
//
// 跑法：
//   npm install --no-save pinyin-pro
//   node gen-pinyin-dict.js
//   npm uninstall pinyin-pro        （--no-save 本来就没进 package.json，删 node_modules 里的即可）
//
// 什么时候要重跑：不用重跑。字典只跟「汉字」有关，跟站内作品无关，
// 新作品用了字典外的生僻字也只是少一条拼音路径（原文匹配照旧生效）。
//
// 覆盖范围：GB2312 全部 6763 个汉字（一级 3755 + 二级 3008）。
// 怎么拿到这批字：GB2312 是双字节（高字节 0xB0-0xF7，低字节 0xA1-0xFE），
// 用 TextDecoder('gb2312') 逐对解码出来即可，不用手抄字表，也不依赖任何外部文件。
// 二级字覆盖到「魑魅魍魉」这一档，对作品标题/关键词足够。

const fs = require('node:fs');
const path = require('node:path');
const { pinyin } = require('pinyin-pro');

const OUT = path.join(__dirname, 'pinyin-dict.js');

// GB2312 → 汉字集合
function gb2312Chars() {
  const dec = new TextDecoder('gb2312');
  const out = [];
  for (let hi = 0xB0; hi <= 0xF7; hi++) {
    for (let lo = 0xA1; lo <= 0xFE; lo++) {
      const s = dec.decode(Uint8Array.from([hi, lo]));
      if (s && s.length === 1 && s !== '\uFFFD') out.push(s);
    }
  }
  return out;
}

const chars = gb2312Chars();
const rows = [];

for (const ch of chars) {
  // toneType:'none' → 不要声调（用户不会打 jì zhàng）
  // multiple:true → 多音字全给（重 = zhong|chong），搜索时任一路命中就算
  let arr = [];
  try { arr = pinyin(ch, { toneType: 'none', multiple: true, type: 'array' }) || []; } catch { arr = []; }
  // ü → v：用户键盘上打的是 lv / nv，不会有人打 lü。必须放在去非字母之前，
  // 否则 ü 会被当成非法字符删掉，绿就只剩个 l，拼音路径直接失效。
  const reads = [...new Set(arr.map(s => String(s).toLowerCase().replace(/ü/g, 'v').replace(/[^a-z]/g, '')).filter(Boolean))];
  if (!reads.length) continue;
  rows.push(ch + ':' + reads.join('|'));
}

// 每行别太长，diff 和编辑器都好受一点
function wrap(s) {
  const out = [];
  let line = '';
  for (const tok of s.split(' ')) {
    if (line.length + tok.length + 1 > 100) { out.push(line); line = tok; }
    else line = line ? line + ' ' + tok : tok;
  }
  if (line) out.push(line);
  return out.join('\n');
}

const body =
  '// ⚠️ 自动生成，别手改 —— 重新生成：node gen-pinyin-dict.js（见该脚本注释）\n' +
  '// 格式：汉字:读音1|读音2 …（空格分隔；多音字用 | 隔开）来源 GB2312 6763 字。\n' +
  `// 共 ${rows.length} 字。\n` +
  'const RAW = `' + wrap(rows.join(' ')) + '`;\n' +
  body_loader();

function body_loader() {
  return `
// 解析成 Map：字 → ['zhong','chong']。只在进程启动时做一次，几十毫秒。
const PY = new Map();
for (const item of RAW.split(/\\s+/)) {
  const i = item.indexOf(':');
  if (i <= 0) continue;
  PY.set(item.slice(0, i), item.slice(i + 1).split('|'));
}

module.exports = { PY };
`;
}

fs.writeFileSync(OUT, body, 'utf8');
console.log(`[pinyin-dict] ${rows.length} 字 → ${path.basename(OUT)}（${(body.length / 1024).toFixed(1)} KB）`);
