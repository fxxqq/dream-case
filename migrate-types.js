// 形态重分类迁移：桌面应用→macOS/Windows，网站→Web 等（可重复执行，幂等）
// 用法: node migrate-types.js   （在 ai-works-site 目录下运行，处理 data/*.json）
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'data');

const NEW_TYPES = [
  { name: 'Web', icon: '🌐' },
  { name: 'iOS', icon: '🍎' },
  { name: 'Android', icon: '🤖' },
  { name: 'macOS', icon: '💻' },
  { name: 'Windows', icon: '🪟' },
  { name: 'Linux', icon: '🐧' },
  { name: '小程序', icon: '📱' },
  { name: '浏览器插件', icon: '🧩' },
  { name: '机器人', icon: '🦾' },
  { name: 'API', icon: '🔌' },
  { name: '其他', icon: '✨' }
];

// 旧形态 → 新形态（多值映射）；未列出的保留
const MAP = {
  '网站': ['Web'],
  '工具': ['Web'],
  'App': ['iOS', 'Android'],
  '桌面应用': ['macOS', 'Windows'],
  '浏览器扩展': ['浏览器插件'],
  '智能体': ['机器人'],
  '游戏': ['其他']
};
// 个别作品可以精确指定（标题精确匹配）
const SPECIAL = {
  'AbcTab-让 ⌘Tab 快得能跟上你的手': ['macOS']  // ⌘ 快捷键是 Mac 特有
};

const works = JSON.parse(fs.readFileSync(path.join(DIR, 'works.json'), 'utf8'));
const arr = Array.isArray(works) ? works : works.works;
let changed = 0;
for (const w of arr) {
  const old = Array.isArray(w.types) && w.types.length ? w.types : [w.type].filter(Boolean);
  if (!old.length) continue;
  let next = [];
  for (const t of old) {
    const mapped = (w.title && SPECIAL[w.title]) ? SPECIAL[w.title] : (MAP[t] || [t]);
    for (const m of mapped) if (!next.includes(m)) next.push(m);
  }
  const before = JSON.stringify([w.types, w.type]);
  w.types = next;
  w.type = next[0] || 'Web';
  if (before !== JSON.stringify([w.types, w.type])) changed++;
}
fs.writeFileSync(path.join(DIR, 'works.json'), JSON.stringify(works, null, 1));

let oldTypes = JSON.parse(fs.readFileSync(path.join(DIR, 'types.json'), 'utf8'));
const typesArr = Array.isArray(oldTypes) ? oldTypes : oldTypes.types;
// types.json 保持原结构写回
if (Array.isArray(oldTypes)) fs.writeFileSync(path.join(DIR, 'types.json'), JSON.stringify(NEW_TYPES, null, 1));
else { oldTypes.types = NEW_TYPES; fs.writeFileSync(path.join(DIR, 'types.json'), JSON.stringify(oldTypes, null, 1)); }

console.log('作品总数:', arr.length, '| 改动:', changed);
const cnt = {};
arr.forEach(w => (Array.isArray(w.types) ? w.types : [w.type]).forEach(t => { cnt[t] = (cnt[t] || 0) + 1; }));
console.log('新形态分布:', JSON.stringify(cnt));
