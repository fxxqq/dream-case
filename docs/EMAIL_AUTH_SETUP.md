# 邮箱绑定 / 邮箱找回密码 — 配置指南

2026-11-28 新增。给造梦橱窗补上「用户先绑定邮箱 → 忘记密码时用邮箱自助找回」这条通道，
发信走阿里云邮件推送（Direct Mail），发信域名 `mail.zm94.com`。

## 一、改动清单

| 文件 | 作用 |
|---|---|
| `email-auth.js` | **新增**。发信封装、验证码生成/校验、频控、邮箱加解密。独立于短信模块。 |
| `server.js` | 引入邮箱模块；新增 4 个接口；`/api/me` 增加 `hasEmail` / `emailMasked`。 |
| `frontend/index.html` | 新增「绑定邮箱」「邮箱找回密码」两个弹窗模板；登录表单加「忘记密码？」入口。 |
| `frontend/app.js` | 新增前端逻辑；账号设置页加「绑定邮箱」行；初始化时挂载。 |
| `docs/EMAIL_AUTH_SETUP.md` | 本文件。 |

## 二、阿里云侧准备 — ✅ 全部完成（2026-11-28）

以下均由 API 实测确认通过，无需再到控制台手动操作：

- **发信域名**：`mail.zm94.com` 的 DKIM / SPF / DMARC / MX 已配好并生效（今天早些时候完成）。
  通过 `CheckDomain`（DomainId `587864`）触发验证，返回 `DomainStatus: 0`（已验证）。
- **发信地址**：`noreply@mail.zm94.com` 已创建（MailAddressId `542525`），
  类型 `trigger`（触发邮件，最适合验证码），验证状态 `2`、域名状态 `0`、账号状态 `0`，全部正常。
  复核接口：`QueryMailAddressByParam`。
- **AccessKey**：沿用现有 AK，已用 `QueryMailAddressByParam` 实测签名与 `dm` 权限通过。

> ⚠️ 这组 AK 曾在对话中以明文出现，且当前是主账号 AK。功能已可用，
> 但强烈建议后续去 RAM 建一个只授权 `dm:SingleSendMail` 的子账号 AK 替换掉，
> 届时只需改 `data/email.json` 里两个字段，无需动代码。

## 三、服务器配置

`data/email.json` **已创建完成**（含现有 AK），权限已设为 `600`，
`data/` 已被 `.gitignore` 排除，不会进仓库。实测 `createEmailService()` 返回
`{"enabled":true,"mode":"live",...}`，即真发信模式已激活。

部署时把整个项目目录同步到服务器即可。若服务器上已有旧版 `email.json`，用本项目的覆盖。

重启服务让配置生效：

```bash
pm2 restart dream-case
```

**更安全的做法**：密钥只放环境变量，不落盘：

```bash
export ALIYUN_DM_AK_ID='LTAI...'
export ALIYUN_DM_AK_SECRET='your-secret'
```

环境变量优先级高于 `email.json`，此时 json 里只需 `{"enabled": true, "accountName": "noreply@mail.zm94.com"}`。

### 配置字段说明

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 总开关。false 时前端所有入口自动隐藏。 |
| `accessKeyId` / `accessKeySecret` | 空 | 也可用 `ALIYUN_DM_AK_ID` / `ALIYUN_DM_AK_SECRET` 环境变量覆盖。 |
| `accountName` | `noreply@mail.zm94.com` | 阿里云控制台里验证过的发信地址。 |
| `fromAlias` | 造梦橱窗 | 邮件里显示的发信人昵称（<15 字）。 |
| `regionId` | cn-hangzhou | 邮件推送服务区域。 |
| `validTime` | 600 | 验证码有效期（秒），60–1800 可调。 |

另外 `EMAIL_SECRET` 环境变量可指定邮箱加密密钥（对应 `data/email-key.txt`）。
**这个密钥丢了，所有已绑定邮箱都解不开、无法展示脱敏地址，找回密码仍可用（靠 HMAC 摘要定位）**，
所以务必备份，且不要换。

## 四、用户体验流程

**绑定邮箱**（登录后）：账号设置 → 绑定邮箱 → 填邮箱 → 获取验证码 → 填码 → 确认。
一个邮箱只能绑一个账号；换绑后旧邮箱立即失效。

**找回密码**（无需登录）：登录弹窗 → 忘记密码？ → 填入绑定过的邮箱 → 获取验证码 →
填码 + 新密码 → 重置。成功后**所有设备被踢下线**，需要重新登录。

**防账号枚举**：对未绑定的邮箱，接口照样回「已发送」，只是不发信；攻击者无法用这个接口
探测「某个邮箱注册过没有」。

## 五、安全设计

- 验证码 6 位数字，只存 SHA-256 摘要，明文仅在邮件里出现一次。
- 一码一次：验过即销毁；错 5 次锁 10 分钟。
- 频控：同邮箱 60 秒间隔 / 5 条每小时 / 10 条每天；同 IP 20 条每小时；全局 200 条每天。
- 邮箱在 `users.json` 里只存 AES-256-GCM 密文 + HMAC 摘要；`/api/me` 只下发 `a***@example.com` 形式的脱敏地址。
- 所有发码 / 验码 / 绑定 / 找回失败都写 `logs/security/YYYY-MM-DD.log`，保留 180 天。

## 六、自检清单

```bash
node --check server.js && node --check email-auth.js && node --check frontend/app.js
```

**2026-11-28 真发信实测**：用配置好的 `email.json` 调 `createEmailService().send()`，
连续 3 次返回 `{ok:true, mode:"live"}`，阿里云返回 `EnvId`（发送成功）；
验证码哈希正确落库、错误码被拒。期间发现阿里云 DM 对新建发信地址**偶发**返回
`InvalidMailAddress.NotFound`（同样参数重试即可成功），已在 `email-auth.js` 的
`send()` 中加入针对该类瞬时错误的退避重试（最多 3 次），避免用户撞上偶发失败。
另修正了底层 `callApi`：HTTP 4xx 时解析 body 里的真实错误码（原来笼统报 `HTTP_404`）。

### Gmail 进垃圾箱的处理（2026-11-28）

实测 QQ 邮箱正常进收件箱、Gmail 进垃圾箱。DNS 认证记录（SPF/DKIM/DMARC/MX）
全部核对无误，主因是**新发信域名的信誉冷启动**。已做的处理：

1. 为 `mail.zm94.com` 补了 A 记录 → `47.95.66.103`（RecordId `2126589197648748544`）。
   Gmail 对"只有邮件记录、没有网站"的域名更敏感。权威 DNS 已生效。
2. 邮件模板改为标准事务邮件：明确品牌标识 `【造梦橱窗】`、站点链接 `zm94.com`、
   纯文本 + 简单 HTML 双正文、无营销话术/外部图片。
3. 显式传 `UnSubscribeLinkType: disabled`、`UnSubscribeFilterLevel: disabled`、
   `ClickTrace: 0`——验证码是事务邮件，不该有退订链接或点击跟踪。

> 注：阿里云 DM 的退订链接功能对 trigger（触发邮件）地址本来就不生成，
> API 也不支持自定义邮件头（如 `List-Unsubscribe`），所以不要在这条路上浪费时间。

**最有效的一招**：在 Gmail 垃圾箱里打开邮件 → 点「报告非垃圾邮件」（Report not spam），
连续 2-3 封后 Gmail 会把该发件人加入白名单。另建议到
[Google Postmaster Tools](https://postmaster.google.com/) 添加 `mail.zm94.com` 监控域名信誉。

开发验证时（不配 `email.json`）：发码会打到控制台 `[email:local] ... 验证码 123456`，
复制验证码即可走完绑定/找回全流程。注意同邮箱 60 秒内只能发一次码，
连着测第二遍会返回「发送太频繁」——这是频控在正常工作，等一分钟或换个邮箱即可。

部署后：

1. 打开站点，登录弹窗里应出现「忘记密码？」链接（通道开启才会显示）。
2. 账号设置里应出现「绑定邮箱」行。
3. 绑定一个测试邮箱，检查是否收到验证码、能否绑定成功。
4. 退出登录，走「忘记密码？」完整走一遍，确认能重置并登录。
5. 查 `logs/security/` 当天日志，确认有 `email_send` / `bind_email` / `email_recover` 记录。

## 七、未配置时的行为

`data/email.json` 不存在或 `enabled=false` 时：
- 前端「忘记密码？」「绑定邮箱」入口**完全不显示**；
- 后端 `/api/email/status` 返回 `enabled:false`；
- 直接调发码接口返回 `NOT_CONFIGURED`，不会静默放行。

本地开发想测试完整流程但不想配阿里云：不写 `email.json`，发码会以 `[email:local]` 形式
把验证码打到服务器控制台，从控制台复制验证码即可走完流程。
