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
| `GITHUB_CLIENT_ID` | 空 | GitHub OAuth App 的 Client ID，填了才开启「GitHub 登录」 |
| `GITHUB_CLIENT_SECRET` | 空 | GitHub OAuth App 的 Client Secret |
| `GITHUB_CALLBACK_URL` | 自动推断 | 回调地址，须与 GitHub 应用里填的完全一致。反代没透传 `X-Forwarded-Proto/Host` 时才需要手动设 |
| `GOOGLE_CLIENT_ID` | 空 | Google OAuth 客户端的 Client ID，填了才开启「Google 登录」 |
| `GOOGLE_CLIENT_SECRET` | 空 | Google OAuth 客户端的 Client Secret |
| `GOOGLE_CALLBACK_URL` | 自动推断 | 回调地址，同上，须与应用里登记的完全一致 |
| `DATA_DIR` / `UPLOAD_DIR` | `./data`、`./uploads` | 数据/上传目录，仅自动化测试时改指向临时目录 |

## GitHub 登录 / 绑定（可选）

站点支持两种用法：**没账号时直接用 GitHub 注册登录**；**已有账号可以把 GitHub 绑上来**（之后一键登录，作品和灯火不变）。

1. 打开 https://github.com/settings/developers → **New OAuth App**，填写：
   - Application name：随便写，例如 `造梦橱窗`
   - Homepage URL：`https://idea.v5pc.com`
   - Authorization callback URL：`https://idea.v5pc.com/api/auth/github/callback`（**必须完全一致**，本地调试再建一个应用填 `http://localhost:3000/api/auth/github/callback`）
2. 拿到 Client ID，点 **Generate a new client secret** 拿到 Secret。
3. 配置给服务（二选一，推荐第一种）：
   - 环境变量：`GITHUB_CLIENT_ID=xxx GITHUB_CLIENT_SECRET=yyy pm2 restart ai-works --update-env`
   - 或写文件 `data/oauth.json`（该目录不入库，密钥不会进 Git）：
     ```json
     { "github": { "clientId": "xxx", "clientSecret": "yyy" } }
     ```
4. 重启服务后，登录弹窗顶部会出现「使用 GitHub 登录」，个人菜单里出现「GitHub 绑定」。

实现说明：
- 只申请 `read:user` 权限，仅读取公开资料（用户名、头像），不碰仓库和邮箱。
- 按 GitHub 用户 id 认人：同一个 GitHub 账号只会对应一个站内账号，不会重复建号。
- GitHub 新建的账号会随机生成一个用户不知道的密码（`passSet=false`）：可以在「改密码」里直接设置密码（不要求输入原密码），设完就能用账号名 + 密码登录；**没设密码前不允许解绑**，否则解绑后就进不来了。
- 站内账号名由 GitHub 登录名生成（`-` 转 `_`，截到 20 位），重名自动加 `_2`、`_3`。

## Google 登录 / 绑定（可选）

用法与 GitHub 完全一致：**没账号时直接用 Gmail 注册登录**；**已有账号可以把 Google 绑上来**。

1. 打开 https://console.cloud.google.com/ → 用 Gmail 登录 → 左上角创建项目（名字随意）。
2. 「APIs & Services」→「OAuth consent screen」：User Type 选 **External**，填应用名、支持邮箱，一路下一步，然后 **Publish App** 发布到生产（保持 Testing 模式会导致授权 7 天过期，且要手动加测试用户）。
3. 「APIs & Services」→「Credentials」→「Create Credentials」→「OAuth client ID」→ 类型选 **Web application**：
   - Authorized redirect URIs 填 `https://idea.v5pc.com/api/auth/google/callback`（本地调试再加 `http://localhost:3000/api/auth/google/callback`）
4. 配置给服务（二选一）：
   - 环境变量：`GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy pm2 restart ai-works --update-env`
   - 或写文件 `data/oauth.json`（与 GitHub 同一个文件）：
     ```json
     { "github": { "clientId": "xxx", "clientSecret": "yyy" },
       "google": { "clientId": "xxx", "clientSecret": "yyy" } }
     ```
5. 重启服务后，登录弹窗会出现「使用 Google 登录」，个人菜单里出现「Google 绑定」。

实现说明：
- 只申请 `openid email profile` 三个基础权限（昵称、头像、邮箱），不需要人工审核；首次授权可能显示「未验证应用」提示页，点继续即可。
- 按 Google 用户唯一 id（`sub`）认人：同一个 Google 账号只会对应一个站内账号，不会重复建号。
- 建号规则与 GitHub 相同：随机密码 + `passSet=false`，设密码后才能解绑；站内账号名由邮箱前缀生成（`testuser@gmail.com` → `testuser`）。

## 功能清单（v3）
- 作品形态：网站 / 小程序 / App / 智能体 / 其他，可按形态+分类+关键词组合筛选；
  访问方式按形态区分——网站/App/智能体/其他填链接（App 为下载链接），小程序填二维码图片
- 宣传图：投稿可附最多 9 张宣传图（选填，客户端自动压缩），详情页画廊展示、点击切换大图
- 搜索：标题 / 作者 / 介绍关键词
- 每件作品独立链接 `/w/:id`，可复制分享；作者主页 `/u/:名字`；榜单页 `/rank`（周榜/月榜/总榜）
- 首页"本周精选"编辑推荐位 + 置顶，后台一键设置
- 广告位：页面里的固定空位（首页顶部 / 首页列表底部 / 榜单页顶部 / 详情页 / 全站页脚 / 首页第一格），后台挂图文或纯文字广告
- 推荐（灯火兑换）：作者用灯火买自己作品的曝光位，可投「作品详情页」「榜单页顶部」「首页第一格」；
  展示包 / 点击包二选一，按次计费、每日防刷限额、到期或撤下按剩余额度退款；
  详情页与榜单页顶部多人投放时**每次随机展示一条**（不做顺序轮播，各家机会均等），首页第一格独占 + 排队；
  榜单页顶部位于榜单列表之外、不占名次编号，带「推荐」角标
- 收藏（浏览器本地保存）、浏览量与点赞统计
- 账号：账号密码注册登录 + **GitHub 登录**（已有账号可在个人菜单里绑定，见上一节配置）
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
Windows 也可以直接双击 `dev.cmd`（等同 `npm start`，会先检查 3000 端口是否被占用）。

> **目录分工（容易踩的坑）**
> - `ai-works-site/`：主目录。**`deploy.sh` / `发布` 打包上传的就是它**，本地预览也应该跑它（`dev.cmd` 或 `npm start`）。
> - `works-site/`：WorkBuddy 线上预览副本，只用来给 WorkBuddy 的在线预览生成链接。
>   它和主目录会逐渐分叉（落后于主目录），**改了它不会随发布上线**。
> 判断标准很简单：**你想让线上生效的改动，必须落在 `ai-works-site/` 里。**

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
