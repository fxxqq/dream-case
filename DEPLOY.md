# AI 作品集 · 部署指南（阿里云服务器）

## 项目结构
```
ai-works-site/
├── server.js         # Node.js + Express 后端入口（同时托管前端），监听 $PORT 或 3000
├── package.json      # npm install && npm start
├── data/             # JSON 数据：works 作品 / categories 分类 / reports 投诉 /
│                     #           tools 推荐位 / creators 认证创作者
├── uploads/          # 上传的图片（封面、缩略图、二维码）
└── frontend/
    ├── index.html / style.css / app.js   # 网站前台
    └── admin.html                        # 管理后台（/admin）
```

## 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 服务端口 |
| `ADMIN_KEY` | 你的口令 | 管理口令（**务必修改**，用于 /admin 后台和管理接口） |
| `REVIEW_MODE` | 关 | 设为 `1` 开启"先审后发"：新投稿进入待审核，需在后台通过后才展示 |
| `RATE_POST_LIMIT` | 5 | 每个 IP 每小时最多发布条数（防灌水） |
| `SITE_URL` | 自动识别 | 站点对外地址（如 `https://你的域名.com`）。sitemap/robots/ canonical / OG 图都会用到，**建议上线后显式设置**，避免依赖反代头 |

## 功能清单（v3）
- 作品形态：网站 / 小程序 / App / 智能体 / 其他，可按形态+分类+关键词组合筛选；
  访问方式按形态区分——网站/App/智能体/其他填链接（App 为下载链接），小程序填二维码图片
- 宣传图：投稿可附最多 9 张宣传图（选填，客户端自动压缩），详情页画廊展示、点击切换大图
- 搜索：标题 / 作者 / 介绍关键词
- 每件作品独立链接 `/w/:id`，可复制分享；作者主页 `/u/:名字`；榜单页 `/rank`（周榜/月榜/总榜）
- 首页"本周精选"编辑推荐位 + 置顶，后台一键设置
- 收藏（浏览器本地保存）、浏览量与点赞统计
- 上传图片客户端自动压缩并生成缩略图（省流量、列表加载快）
- 投诉闭环：前台提交 → 后台处理 → 可下架作品
- 风控：发布/点赞/投诉限流 + 敏感词拦截
- 管理后台 `/admin`：数据统计、**新建作品 / 编辑任意作品（可指定作者、状态、封面、宣传图）**、
  待审作品、全部作品（通过/拒绝/精选/置顶/删除）、
  投诉处理、分类管理、推荐位（详情页底部工具推荐，可放返佣链接）、认证创作者（✔ 标识）

## SEO（已内置）
所有页面均由服务端注入 `<head>`，即使搜索引擎不执行 JS 也能抓到完整内容：

| 能力 | 说明 |
|---|---|
| 独立收录页 | `/w/:id`、`/u/:名字`、`/rank`、`/c/:分类`、`/t/:形态` 都有独立的 title / description / canonical |
| 结构化数据 | 首页 WebSite+SearchAction+Organization；作品页 SoftwareApplication+BreadcrumbList；作者页 ProfilePage；列表页 CollectionPage+ItemList |
| 社交分享 | 每页都有 Open Graph / Twitter Card（分享到微信、微博、Telegram 等会带标题和封面大图） |
| sitemap | `https://你的域名/sitemap.xml`（自动包含作品、作者、分类、形态，作品带图片信息） |
| robots | `https://你的域名/robots.txt`（已屏蔽 /admin 和 /api，声明 sitemap） |
| RSS | `https://你的域名/feed.xml`（最新 30 件作品，可提交到 RSS 阅读器） |
| 内链结构 | 首页静态区块、面包屑、同类作品推荐、分类/形态页互链，保证爬虫能发现所有页面 |
| 收录防护 | `/admin` 有 noindex + X-Robots-Tag；搜索结果页 `?q=` noindex；`/index.html` 301 到 `/` |
| 性能信号 | 静态资源长缓存、图片懒加载、alt 描述、单一 h1 |

**上线后要做的一次性动作：**
1. 设置环境变量 `SITE_URL=https://你的域名.com` 并重启（保证 canonical / sitemap 用绝对域名）
2. 到百度搜索资源平台（ziyuan.baidu.com）提交 `https://你的域名/sitemap.xml`
3. 到 Google Search Console 提交同一 sitemap，并用"网址检查"验证 `/w/:id` 页面
4. 建议在百度站长平台用 API 主动推送 sitemap 中的新作品链接，收录更快


## 本地运行
```bash
npm install
npm start
# 打开 http://localhost:3000   后台: http://localhost:3000/admin
```

## 阿里云部署（一键脚本，推荐）
打开 `deploy.sh`，把顶部配置区改成你的实际信息（服务器 IP、SSH 用户、管理口令等），然后在项目目录执行：

```bash
bash deploy.sh           # 完整部署: 打包(不含 data/uploads) → scp 上传 → 远程装 Node/PM2 → 启动
bash deploy.sh restart   # 预留: 只在服务器重启（当前版本仍会重新执行远程脚本）
```

脚本会自动：安装 Node.js 20（如果没有）→ `npm install` → 安装 PM2 → 启动并设置开机自启。
**服务器上的 `data/`（作品数据）和 `uploads/`（图片）不会被覆盖**，放心重复部署更新代码。

### Nginx 配置
参考 `nginx-example.conf`，两种共存方案任选：
- **子路径**：`http://IP/ai/` 走本站，`/` 继续走原 Java 服务
- **独立域名**（推荐，SEO 友好）：`ai.example.com` 解析到服务器，整站反代 3000，可用 certbot 免费签 HTTPS

## 阿里云部署（手动步骤）
```bash
# 1. 上传代码
scp -r ai-works-site root@你的服务器IP:/opt/

# 2. 安装 Node.js（如果没有）
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs

# 3. PM2 守护启动
npm install -g pm2
cd /opt/ai-works-site && npm install
PORT=3000 ADMIN_KEY=改成你的口令 pm2 start server.js --name ai-works
pm2 save && pm2 startup

# 4. 安全组放行 TCP 3000，Nginx 反向代理（记得允许上传体积）
#    client_max_body_size 25m;
#    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
```

## 运维建议
- 数据都在 `data/` 和 `uploads/`，定期备份这两个目录即可
- 作品量大（数千条以上）或需要多进程时，再把 JSON 存储换成 SQLite/MySQL
- 图片多了以后可接入阿里云 OSS 存储
