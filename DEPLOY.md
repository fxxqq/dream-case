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
- 推荐（灯火兑换）：作者用灯火换自己作品的曝光位，可投「作品详情页」「榜单页顶部」「首页第一格」；
  展示包 / 点击包二选一，按次计费、每日防刷限额、到期或撤下按剩余额度退款；
  频次封顶（本机口径）：曝光 7 天内看过 3 次不再显示；纯点击包被点开 1 次后不再推给该访客（180 天滚动过期）；
  详情页与榜单页顶部多人投放时**每次随机展示一条**（不做顺序轮播，各家机会均等）；首页第一格同时最多 3 条在投，一次只显 1 张（每次进页面随机挑一条，浏览期间不切换）；
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
4. 配好百度「普通收录」主动推送的 token（见下一节，代码已经接好，只差 token）

### 百度主动推送（代码已实现，只差 token）

作品「第一次对公众可见」时会自动把它的详情页 `POST` 给百度普通收录接口，触发点：
投稿即过审、管理员审核通过、恢复上架、预告卡点「我上线了」、作者自己重新上架、后台代建作品。
同一条 URL 24 小时内只推一次（配额有限，重复推不加分）；没配 token 则整体静默跳过，不影响任何功能。

1. 站长平台 → 用户中心 → 站点管理，先把 `https://你的域名` 添加并验证（DNS / CNAME / 文件任选）
2. 同一后台 → 普通收录 → **API 提交**，拿到 token
3. 把 token 交给服务，两种方式任选：
   - 环境变量：`deploy.sh` 顶部 `BAIDU_PUSH_TOKEN="..."`（发版时随 PM2 注入）
   - 或文件：`echo '你的token' > data/baidu-push-token.txt`（`data/` 不参与发布，发版不会覆盖，推荐）
4. 补推历史链接（可选，先 `--dry` 看条数，配额有限别全量硬推）：
   ```bash
   node tools/baidu-push.js --dry           # 只打印，不发送
   node tools/baidu-push.js --no-pages      # 只推作品详情页
   ```
5. 看状态：`GET /api/admin/baidu-push`（带 `x-admin-key`），返回是否配置、累计推送数、最近一次结果与百度给的剩余配额

> 推送只是「告诉百度这里有个新链接」，收不收录、多久收录由百度决定；真实收录量只能在站长平台后台看。
> 相关回归：`node tools/test-baidu-push.js`（本机 mock 端点，19 项断言，不会真打百度）。


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

### 本地切换接口环境（开发用，线上自动关闭）

本地页面左下角会多一颗环境徽标，点开就能切，不用重启、不用改前端代码：

| 模式 | 效果 |
| --- | --- |
| 本地 | 默认，全部走本机 |
| 生产 · 接口 | `/api/*` 和 `/uploads/*` 转发到线上，页面仍由本地代码渲染 |
| 生产 · 全站 | 连 HTML 也看线上的，只保留本地 `js/css/图片/字体`（改 `app.js`、`style.css` 时看线上真实页面最顺手） |

- 默认**只读**：`POST/PUT/PATCH/DELETE` 在本地就 403，不会把测试数据写进线上库；只有登录、扫码登录、后台口令换 cookie 这几个「建立会话」的接口放行。确需写入，先在面板里勾「允许写入生产」，此时徽标会变红点呼吸。
- 会话 cookie 会被改写成 localhost 可用（去掉 `Domain`/`Secure`），所以切过去后要**在线上账号下重新登录一次**；本地的 `sid` 线上不认。
- 生产 · 接口模式下，本地数据里没有的作品详情页会自动转给线上，不会报假 404。
- 状态存在 `data/dev-env.json`（不入库、不随部署上传），重启保持上次选择；想回到默认删掉这个文件即可。
- 目标地址默认 `https://idea.v5pc.com`，可用环境变量 `DEV_PROD_ORIGIN` 覆盖。
- **安全边界**：`dev-env.js` 检测到 pm2（`process.env.pm_id`）就整个功能关闭，`/__dev/env` 只接受 127.0.0.1 / ::1 的请求，`DEV_ENV=0` 可强制关闭。因此这份代码即使被部署到线上也是空壳。

## 阿里云部署（一键脚本，推荐）
打开 `deploy.sh`，把顶部配置区改成你的实际信息（服务器 IP、SSH 用户、管理口令等），然后在项目目录执行：

```bash
bash deploy.sh           # 完整部署: 自检 → 打包(不含 data/uploads) → scp 上传 → 远程自检 → 启动
FORCE=1 bash deploy.sh   # 无视 .deploy-lock 强行部署
```

脚本分 5 步，任一步不过就中止、**不碰线上**（旧进程继续对外服务）：

| 步骤 | 内容 | 拦得住什么 |
|---|---|---|
| 0 | 发布锁 | 目录里有 `.deploy-lock` 就退出（见下） |
| 1 | 依赖自检 | `server.js` require 了不存在的模块 → 启动即崩的 502 |
| 2 | 打包 | — |
| 3 | 包内 `.js` 语法自检 | 逐个 `node --check` 包里所有 js（含 `frontend/`），写坏/写一半就停在本地 |
| 4 | 上传 + 远程复检 | 远端解包后再查一遍（防 scp 损坏），仍在 `pm2 delete` 之前 |
| 5 | 重启 | `pm2 delete` → `pm2 start`，中间约 1–5 秒 502，正常现象 |

脚本会自动：安装 Node.js 20（如果没有）→ `npm install` → 安装 PM2 → 启动并设置开机自启。
**服务器上的 `data/`（作品数据）和 `uploads/`（图片）不会被覆盖**，放心重复部署更新代码。

> **没有 `restart` 分支**：任何参数都会被忽略，照样走完整流程。
> 也没有自动回滚——包发完就删，新代码若在**运行时**抛错（语法检查管不到），只能再改一版重新发。

### 发布锁 `.deploy-lock`
改代码期间在项目根目录放一个 `.deploy-lock`（第一行写正在改哪些文件），`deploy.sh` 见到就中止，
避免把「写了一半的文件」打包上线。改完删掉即可，**忘了删会一直拦着发布**（用 `FORCE=1` 可绕过）。
该文件已进 `.gitignore`，也不在打包清单里。

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
