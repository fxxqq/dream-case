// ============================================================
// 作品关键词（搜索标签）
// ============================================================
// 一件作品 0-6 个词，每个 ≤12 字。两处用途：
//   1) 站内搜索：搜这个词能搜到作品（server.js 的 SEARCH_FIELDS 里权重 6，仅次于标题）
//   2) 作品详情页的「关键词」胶囊：点一下直接进搜索结果
//
// 自动生成**只走本地规则**（不调 AI、不花钱、毫秒级）：标题分词 + 领域词表命中。
// 这么选的理由：LLM 会顺手编出原文里没有的功能词（「支持多端同步」这种），
// 而关键词是要给搜索用的，编出来的词等于把「搜不到」变成「搜得到假的」。
// 规则版召回没那么全，但每个词都真在标题 / 简介 / 分类里出现过，作者改起来也有据可依。
//
// 纯函数，不依赖 server.js 里的任何东西 —— 迁移脚本、测试脚本都直接 require 这个文件。

const KW_MAX = 6;
const KW_LEN = 12;

// 领域词表：产品类型 / 使用场景 / 常见功能。命中即入候选。
// 只收「用户真会拿它当搜索词」的词，避开「作品 / 工具 / 平台 / 支持 / 功能」这类
// 几乎每件作品都有的泛词 —— 收到关键词里等于把搜索稀释成噪音。
const KW_LEXICON = `
待办 清单 记事 笔记 备忘 日历 日程 提醒 番茄钟 计时 打卡 习惯 时间管理 剪贴板 截图 速记
文件管理 网盘 压缩 解压 搜索 自动化 快捷指令 浏览器插件 扩展程序 书签 密码 输入法
表格 文档 简历 邮件 日程 会议 协同 白板 看板 项目管理 思维导图 流程图 字体 图标
翻译 词典 英语 背单词 单词 题库 刷题 错题 课程 学习 记忆 阅读 书单 考研 数学 育儿
写作 文案 排版 长文 博客 公众号 排版工具 海报 设计 配图 图片 图片处理 抠图
视频 剪辑 字幕 音频 播客 音乐 壁纸 表情包 头像 配色 取色 logo 摄影 修图 白噪音
ai 人工智能 大模型 chatgpt 提示词 生图 生视频 语音 语音识别 ocr 文字识别 转录
记账 账单 账本 理财 股票 基金 记账本 天气 菜谱 做饭 饮食 健身 运动 跑步 骑行 睡眠
喝水 减脂 体重 体检 医疗 用药 旅行 地图 导航 酒店 机票 快递 购物 比价 优惠券
二手 租房 装修 宠物 穿搭 收纳 家居 母婴 养老 汽车 停车 加油
游戏 小游戏 独立游戏 小说 漫画 桌游 剧本杀 影视 追剧 动漫 抽奖 投票 问卷 报名
社区 论坛 聊天 匿名 交友 情侣 家庭 团队 群聊 通讯录 日历共享
开源 github api sdk 调试 部署 命令行 正则 json 爬虫 数据库 服务器 监控 日志
性能 测试 代码 git 容器 建站 cms 低代码 无代码 组件库
收款 发票 报销 合同 法律 招聘 面试 offer 工资 社保
小程序 公众号 h5 落地页 官网 个人站 作品集 导航站 工具箱 浏览器主页
英文 翻译器 背单词 效率 极简 离线 无广告 免费 开源项目
`.trim().split(/\s+/).filter((w, i, a) => w && a.indexOf(w) === i);

// 标题切分：中英文标点 + 常见分隔符（「拾光清单 - 帮人整理待办」这种「名字 - 说明」结构很常见）
const KW_SPLIT = /[\s\-_|·、，,。/.()（）【】\[\]：:；;！!？?"'“”‘’—~～+&]+/;
// 含这些虚词的片段不像「词」，多半是半句话，丢掉
const KW_STOP = /[的了是我你他吗呢吧啊]/;

// 英文 / 技术词按词边界匹配，避免 ai 命中 detail、api 命中 rapido 这类乌龙；
// 中文按子串匹配（中文没有空格分词，子串命中就是正确语义）
const asciiRe = new Map();
function hasWord(hay, word) {
  const w = String(word || '');
  if (!w) return false;
  if (!/^[\x20-\x7e]+$/.test(w)) return hay.includes(w.toLowerCase());
  let re = asciiRe.get(w);
  if (!re) {
    re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
    asciiRe.set(w, re);
  }
  return re.test(hay);
}
function countOccur(hay, word, cap) {
  const w = String(word || '').toLowerCase();
  if (!w) return 0;
  let n = 0, i = 0;
  while (n < cap) {
    const at = hay.indexOf(w, i);
    if (at === -1) break;
    n++;
    i = at + w.length;
  }
  return n;
}

// 作者提交的关键词：数组 / JSON 字符串 / 逗号顿号空格分隔都能收，统一清洗成干净数组
function sanitizeKeywords(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    // 表单传的是 JSON 字符串（"[]" 表示作者清空了，必须解析成空数组，
    // 不能因为「解析出来是空」就退回按分隔符切 —— 那样 "[]" 会变成一个叫 [] 的关键词）
    let parsed = false;
    if (s.charAt(0) === '[') {
      try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) { arr = j; parsed = true; }
      } catch { /* 不是合法 JSON，按分隔符切 */ }
    }
    if (!parsed) arr = s.split(/[,，、\s]+/);
  }
  const out = [];
  for (const x of arr) {
    const k = String(x == null ? '' : x)
      .replace(/<[^>]*>/g, '')            // 先剥标签再删残留的尖括号，避免 <b>记账</b> 变成 b记账/b
      .replace(/[<>"'`\\\r\n\t]/g, '')   // 会被拼进 HTML / meta，去掉能破坏结构的东西
      .replace(/^[#\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, KW_LEN);
    if (k.length < 2) continue;          // 单个字当搜索词没意义，也和自动生成的口径对齐
    const low = k.toLowerCase();
    if (out.some(o => o.toLowerCase() === low)) continue;
    if (out.length >= KW_MAX) break;
    out.push(k);
  }
  return out;
}

// 英文词条保留原文大小写：词表里存的是 ai，页面上要显示 AI 才像人写的
function displayOf(hayRaw, word) {
  if (!/^[\x20-\x7e]+$/.test(word)) return word;
  const i = hayRaw.toLowerCase().indexOf(word.toLowerCase());
  if (i === -1) return word;
  const got = hayRaw.slice(i, i + word.length);
  return /^[\x20-\x7e]+$/.test(got) ? got : word;
}

// 自动生成：标题分段 + 标题里的英文词 + 领域词表命中，最多 6 个
function autoKeywords(input) {
  const src = input || {};
  const title = String(src.title || '').trim();
  const prompt = String(src.prompt || '');
  const cats = (Array.isArray(src.categories) ? src.categories : []).filter(Boolean);
  const types = (Array.isArray(src.types) ? src.types : []).filter(Boolean);

  const rawHay = [title, prompt, cats.join(' '), types.join(' ')].join(' ');
  const hay = rawHay.toLowerCase();
  const titleLow = title.toLowerCase();
  const out = [];
  // 互相包含的只留短的：「记账」比「记账本」好搜（搜索是字段 includes 关键词）
  const push = kw => {
    const k = String(kw || '').replace(/\s+/g, ' ').trim().slice(0, KW_LEN);
    if (!k || k.length < 2) return;
    const low = k.toLowerCase();
    const same = out.findIndex(o => o.toLowerCase() === low);
    if (same !== -1) return;
    const wrap = out.findIndex(o => o.toLowerCase().includes(low) || low.includes(o.toLowerCase()));
    if (wrap !== -1) { if (low.length < out[wrap].length) out[wrap] = k; return; }
    if (out.length >= KW_MAX) return;
    out.push(k);
  };

  // 1) 多段标题里的分段（名字 - 说明 / 名字｜说明），跳过「等于整个标题」的和像半句话的
  const segs = title.split(KW_SPLIT).map(s => s.trim()).filter(Boolean);
  if (segs.length > 1) {
    segs.forEach(s => {
      if (s === title || s.length < 2 || s.length > 8) return;
      if (KW_STOP.test(s)) return;
      push(s);
    });
  }
  // 2) 标题里的英文 / 技术词：ChatGPT、Markdown、iOS 这类搜的人很多
  //    （等于整个标题的词跳过 —— 标题本来就以最高权重参与搜索，别白占一个坑）
  (title.match(/[A-Za-z][A-Za-z0-9.+#]{1,15}/g) || []).forEach(s => {
    if (s.toLowerCase() !== titleLow) push(s);
  });

  // 3) 领域词表：标题里出现过的排前面，同一个词出现次数多的也往前
  const hits = [];
  KW_LEXICON.forEach((w, i) => {
    if (!hasWord(hay, w)) return;
    const inTitle = hasWord(titleLow, w);
    const n = Math.min(3, countOccur(hay, w, 3));
    hits.push({ w, s: (inTitle ? 3 : 0) + n, i });
  });
  hits.sort((a, b) => b.s - a.s || a.i - b.i).forEach(h => push(displayOf(rawHay, h.w)));

  return out.slice(0, KW_MAX);
}

module.exports = { KW_MAX, KW_LEN, KW_LEXICON, autoKeywords, sanitizeKeywords, hasWord };
