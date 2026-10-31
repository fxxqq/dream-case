# 造梦橱窗

> 每一个认真做出的想法，都值得被看见。

一个面向 AI 作品（网站、小程序、App、智能体、桌面应用、浏览器扩展等）的展示与发现平台。作者提交作品，访客浏览、点赞、收藏、评论，站内提供精选推荐、排行榜、作者主页与后台审核。

线上示例：<https://idea.v5pc.com>

## 功能

**浏览与发现**
- 首页作品流：分类 / 形态 / 是否开源 三级筛选，关键词搜索，最新 / 最热排序，卡片与列表两种视图
- 精选轮播、置顶作品、开源与付费标识
- 榜单：周榜 / 月榜 / 总榜，按综合热度、点赞、收藏排序

**作品页与 SEO**
- 作品详情弹窗（站内快速浏览）
- 独立作品页 `/w/:id`、作者主页 `/u/:name`、榜单页 `/rank`，均由服务端直出 HTML，带 JSON-LD 结构化数据
- 自动生成 `sitemap.xml` 与 `robots.txt`

**互动**
- 点赞、收藏（需登录，收藏保存在账号上，跨设备同步）、评论、投诉
- 收藏数、评论数在页面各处实时同步

**账号**
- 用户名 + 密码注册登录，支持「记住我」
- 我的作品（编辑 / 删除）、认领作品、屏蔽不想看到的作品与作者

**投稿**
- 支持网站 / 小程序 / App / 智能体 / 桌面应用 / 浏览器扩展 / 其他七种形态
- 最多 9 张宣传图，可拖拽排序；小程序可上传二维码
- 是否开源（是 / 否）与是否付费标注，标注开源时必须填写源码仓库地址
- 表单草稿自动保存，刷新不丢内容
- 敏感词过滤 + 频率限制，匿名投稿进入审核队列

**后台 `/admin`**
- 作品审核、编辑、置顶、精选、删除
- 用户、评论、投诉、认领申请管理
- 浏览量 / 访客数统计，按作品与日期查看

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js 18+（推荐 20） |
| Web | Express 4 |
| 前端 | 原生 JavaScript + CSS，无框架、无构建步骤 |
| 存储 | JSON 文件（原子写入 + 内存缓存），图片存本地 `uploads/` |
| 上传 | multer |
| 部署 | PM2 + Nginx 反向代理 |

## 快速开始

```bash
npm install
PORT=3000 node server.js
```

打开 <http://127.0.0.1:3000>，管理后台在 <http://127.0.0.1:3000/admin>。

首次启动会自动创建 `data/` 与 `uploads/` 目录，并在没有用户数据时建立演示账号。

## 配置

后台口令**不写在代码里**，按以下优先级读取：

1. 环境变量 `ADMIN_KEY`
2. 文件 `data/admin-key.txt`（推荐本地使用，`data/` 已被 `.gitignore` 排除）

未配置时后台整体禁用，避免空口令放行。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `ADMIN_KEY` | 空 | 后台管理口令，为空则后台不可用 |
| `SITE_URL` | 自动识别 | 站点完整域名，用于 sitemap 与分享链接，如 `https://idea.example.com` |
| `REVIEW_MODE` | 关闭 | 设为 `1` 时所有投稿都需审核 |

## 目录结构

```
.
├── server.js            # 后端服务：REST API、鉴权、限流、审核、SEO 页面输出
├── seo.js               # 服务端渲染片段：作品页 / 作者页 / 榜单页 / sitemap
├── package.json
├── deploy.example.sh    # 部署脚本模板（复制为 deploy.sh 后填配置）
├── nginx-example.conf   # Nginx 反向代理示例
├── DEPLOY.md            # 部署与运维说明
├── frontend/
│   ├── index.html       # 站点主页面
│   ├── app.js           # 前端逻辑：路由、列表渲染、弹窗、投稿、登录态
│   ├── style.css
│   ├── admin.html       # 管理后台
│   └── favicon.svg
├── data/                # 运行时数据（不入库）：作品、用户、评论、会话、统计
└── uploads/             # 用户上传的图片（不入库）
```

## 部署

```bash
cp deploy.example.sh deploy.sh   # 填入服务器 IP、后台口令、域名
bash deploy.sh                   # 打包 → 上传 → 远程安装依赖并重启 PM2
bash deploy.sh restart           # 只重启服务
```

服务器上 `data/` 与 `uploads/` 不会被覆盖，升级代码不影响已有数据。详细步骤见 [DEPLOY.md](DEPLOY.md)，Nginx 配置参考 [nginx-example.conf](nginx-example.conf)。

## 数据备份

所有业务数据都在 `data/*.json` 与 `uploads/` 两个目录里，定期打包备份即可：

```bash
tar czf backup-$(date +%F).tar.gz data uploads
```

## License

[MIT](LICENSE)
