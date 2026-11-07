// 外宣指南：适合独立开发者发新品的地方（服务端 SSR 与前端「外宣包」共用这份数据）
// 改这里 = 页面和文案模板的入口列表一起改；前端文案模板按 key 对应（frontend/app.js → PROMO_TPL）
// types = 适合投递的作品形态（对应站点作品类型，缺省 = 不限形态）；
// openSourceOnly = 只对填了源码仓库的开源项目有意义
const PLATFORMS = [
  {
    key: 'producthunt',
    icon: '/promo-icons/ph.png',
    name: 'Product Hunt',
    emoji: '🐱',
    url: 'https://www.producthunt.com/posts/new',
    region: '全球 · 英文',
    tags: ['英文', '要账号', '有榜单'],
    types: ['Web', 'iOS', 'Android', 'macOS', 'Windows', 'Linux', '浏览器插件'],
    fits: '有英文界面的网站 / App / 浏览器插件，想拿第一批海外种子用户',
    tip: '榜单按美国太平洋时间 0 点刷新，也就是北京时间早上 8 点——卡着这个点发布最容易上首页。备好 1270×760 首图、60 字符以内的 Tagline、3~5 张截图或 GIF。发布当天守着评论区，每条留言都回，互动分直接影响排名。'
  },
  {
    key: 'hn',
    icon: '/promo-icons/hn.png',
    name: 'Hacker News',
    emoji: '🟠',
    url: 'https://news.ycombinator.com/submit',
    region: '全球 · 英文',
    tags: ['英文', '技术向', '流量猛'],
    types: ['Web', 'macOS', 'Windows', 'Linux', '浏览器插件', '机器人', 'API'],
    fits: '开发者工具、开源项目、有技术含量的东西（纯商业产品容易被喷）',
    tip: '标题固定格式「Show HN: 产品名 – 一句话」，别加营销词。正文说清楚做了什么、怎么实现的、为什么要做。评论区比帖子本身更重要，被质疑时认真回答技术细节，反而能涨分。英语不好就写短句，别用机翻长文。'
  },
  {
    key: 'v2ex',
    icon: '/promo-icons/v2ex.png',
    name: 'V2EX · 分享创造',
    emoji: '🔵',
    url: 'https://www.v2ex.com/go/create',
    region: '中文 · 开发者',
    tags: ['中文', '要账号', '易被踩'],
    fits: '中文独立开发者、开源项目、工具类产品，想听到真实批评',
    tip: '发在「分享创造」节点。开头先讲你遇到的痛点和你怎么解决的，链接放后面；只贴链接不说话的帖子基本没人理。V2EX 对自我推广很敏感，同一个项目别反复发，隔几周有新进展再发一次。'
  },
  {
    key: 'juejin',
    icon: '/promo-icons/juejin.png',
    name: '掘金 · Vibe Work',
    emoji: '💎',
    url: 'https://juejin.cn/vibe-work',
    region: '中文 · 开发者社区',
    tags: ['中文', '要账号', '技术社区'],
    fits: '任何形态都能投（Web / App / 桌面 / 插件 / 小程序均可），写篇文章带上链接即可',
    tip: '在「Vibe Work」频道发篇文章，标题写清做了什么（如「用 XX 做了个 YY 工具」）。掘金吃技术干货：正文讲清实现思路、技术栈和踩坑，比纯功能罗列更容易被推荐。文章末尾放作品链接 + 截图，评论区有人问就认真答。'
  },
  {
    key: 'sspai',
    icon: '/promo-icons/sspai.png',
    name: '少数派',
    emoji: '✍️',
    url: 'https://sspai.com/',
    region: '中文 · 效率工具',
    tags: ['中文', '要审核', '长文'],
    types: ['iOS', 'Android', 'macOS', 'Windows', '浏览器插件'],
    fits: '效率工具、生活类 App、桌面软件，有完整真实的使用场景',
    tip: '走站内「写文章 → 投稿」，要写成有体验有细节的长文，而不是功能清单。多用真实截图、讲清你日常怎么用它。编辑会审稿，纯广告稿会被拒；过了稿会持续有人从搜索引擎进来。'
  },
  {
    key: 'appinn',
    icon: '/promo-icons/appinn.png',
    name: '小众软件',
    emoji: '🧩',
    url: 'https://www.appinn.com/',
    region: '中文 · 工具',
    tags: ['中文', '免费优先', '邮件自荐'],
    types: ['Web', 'Windows', 'macOS', 'Linux', '浏览器插件', 'Android', 'iOS'],
    fits: '免费小工具、桌面软件、开源项目',
    tip: '通过站内「投稿」或邮件自荐，一封信讲清三件事：解决什么问题、支持哪些平台、是否免费。配 2~3 张干净截图。标题里带上「Windows / Mac / 开源」这类关键词更容易被选中。'
  },
  {
    key: 'coolapk',
    icon: '/promo-icons/coolapk.png',
    name: '酷安',
    emoji: '🤖',
    url: 'https://www.coolapk.com/',
    region: '中文 · Android',
    tags: ['Android', '要上架', '年轻用户'],
    types: ['Android'],
    fits: 'Android App，尤其是面向年轻用户、有设计感的应用',
    tip: '需要开发者账号并上传 APK 过审。应用介绍写清楚权限用途和隐私政策（酷安用户很在意）。配图用真机截图，写清版本更新日志；首发可以申请「酷安首发」标识。'
  },
  {
    key: 'jike',
    icon: '/promo-icons/jike.png',
    name: '即刻',
    emoji: '🟡',
    url: 'https://web.okjike.com/',
    region: '中文 · 独立开发者圈子',
    tags: ['中文', '社区氛围好'],
    fits: '独立开发者本人出面，讲做产品的过程、踩过的坑',
    tip: '发在「一起做产品」「独立开发者」这类圈子。先讲进度和踩坑，再顺带说产品，纯硬推没人看。短图文 + 话题标签，配 1~3 张图；评论区经常能直接遇到第一批用户和同行。'
  },
  {
    key: 'hellogithub',
    icon: '/promo-icons/hellogithub.png',
    name: 'HelloGitHub',
    emoji: '📚',
    url: 'https://github.com/521xueweihan/HelloGitHub/issues',
    region: '中文 · 开源月刊',
    tags: ['开源', '要 star', '长尾'],
    openSourceOnly: true,
    fits: '开源项目，想把仓库推给更多开发者、顺便涨 star',
    tip: '在仓库提 issue 自荐，说明项目亮点、适用人群、有没有中文文档。README 必须有一句话简介 + 截图 + 快速上手命令，这是被收录的硬门槛。项目长期不更新容易被跳过。'
  }
];

// 面向 C 端产品的补充渠道（页面底部一句话带过，不做卡片）
const EXTRA = '做的是面向普通用户的产品？小红书、B 站、知乎「有哪些好用的 XX」类问题，往往比开发者社区带来更多真实用户——但得用人话讲、会做图，别写成说明书。';

module.exports = { PLATFORMS, EXTRA };
