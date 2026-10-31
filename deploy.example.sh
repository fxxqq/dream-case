#!/usr/bin/env bash
# ============================================================
# 造梦橱窗 · 一键部署脚本（模板）
# 用法:
#   cp deploy.example.sh deploy.sh   # 然后填好下面的配置项
#   bash deploy.sh                   # 完整部署（打包 + 上传 + 远程安装/重启）
#   bash deploy.sh restart           # 跳过上传，只在服务器上重启服务
# deploy.sh 已被 .gitignore 排除，真实口令不会进仓库。
# ============================================================

# ---------------- 配置区（改成你自己的） ----------------
SERVER_IP="1.2.3.4"               # 服务器公网 IP
SERVER_USER="root"                # SSH 用户
REMOTE_DIR="/opt/ai-works-site"   # 服务器上的项目目录
ADMIN_KEY="请改成你的后台口令"      # 管理后台口令（上线前务必改掉！）
SITE_PORT="3000"                  # 服务端口（与 Nginx 反代对应）
# 可选：域名，用于 SEO 的 SITE_URL（如 https://ai.example.com），留空则自动识别
SITE_URL="https://ai.example.com"
# -------------------------------------------------------

set -e

# 兼容从 PowerShell/CMD 直接调用便携版 bash 的情况：
# 此时 PATH 里没有 date/tar/scp 等命令，自动把 bash 自带的 usr/bin 加进 PATH
if ! command -v date >/dev/null 2>&1; then
  _BIN="${BASH%/*}"; _BIN="${_BIN%\\*}"          # 去掉末尾的 bash.exe，得到其所在目录
  case "$_BIN" in
    [A-Za-z]:*)                                   # Windows 风格 D:\x\y → MSYS 的 /d/x/y
      _DRV="${_BIN:0:1}"; _BIN="/${_DRV,,}/${_BIN:3}"; _BIN="${_BIN//\\//}" ;;
  esac
  export PATH="$_BIN:$PATH"
fi

PKG_NAME="ai-works-$(date +%Y%m%d-%H%M%S).tar.gz"

echo "==> 目标服务器: $SERVER_USER@$SERVER_IP  目录: $REMOTE_DIR"

# ---------- 1. 本地打包（排除依赖、日志、正式数据） ----------
cd "$(dirname "$0")"
echo "==> [1/3] 本地打包 $PKG_NAME ..."
tar czf "$PKG_NAME" \
  --exclude='node_modules' \
  --exclude='uploads' \
  --exclude='data' \
  --exclude='*.log' \
  --exclude='.git' \
  server.js seo.js package.json frontend/

# ---------- 2. 上传 ----------
echo "==> [2/3] 上传到服务器 ..."
scp "$PKG_NAME" "$SERVER_USER@$SERVER_IP:/tmp/"

# ---------- 3. 远程安装 / 更新 / 重启 ----------
echo "==> [3/3] 远程执行部署 ..."
# 通过环境变量把配置传到远端
ssh "$SERVER_USER@$SERVER_IP" \
  "REMOTE_DIR='$REMOTE_DIR' PKG='/tmp/$PKG_NAME' ADMIN_KEY='$ADMIN_KEY' SITE_PORT='$SITE_PORT' SITE_URL='$SITE_URL' bash -s" <<'REMOTE_SCRIPT'
set -e
mkdir -p "$REMOTE_DIR"
tar xzf "$PKG" -C "$REMOTE_DIR"
rm -f "$PKG"
cd "$REMOTE_DIR"

# 安装 Node.js 20（如果没有）
if ! command -v node >/dev/null 2>&1; then
  echo "-- 未检测到 Node.js，开始安装 ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs
  fi
fi
echo "-- Node 版本: $(node -v)"

# 安装依赖
npm install --omit=dev --no-audit --no-fund

# 安装 PM2（如果没有）
command -v pm2 >/dev/null 2>&1 || npm install -g pm2

# PM2 启动 / 重启（数据目录 data/ uploads/ 在服务器上保留，不会被覆盖）
mkdir -p data uploads
pm2 delete ai-works 2>/dev/null || true
PORT="$SITE_PORT" ADMIN_KEY="$ADMIN_KEY" SITE_URL="$SITE_URL" \
  pm2 start server.js --name ai-works --time
pm2 save

# 开机自启（首次执行会输出提示，按提示跑一次 `pm2 startup` 输出的命令即可）
pm2 startup 2>/dev/null || true

echo "-- 部署完成: http://$SERVER_IP:$SITE_PORT （管理后台 /admin）"
REMOTE_SCRIPT

# ---------- 4. 清理本地包 ----------
rm -f "$PKG_NAME"

echo ""
echo "✅ 部署完成！"
echo "   网站:     http://$SERVER_IP:$SITE_PORT"
echo "   管理后台:  http://$SERVER_IP:$SITE_PORT/admin"
echo ""
echo "别忘了："
echo "  1. 云服务器安全组放行 TCP $SITE_PORT"
echo "  2. 配置 Nginx 反向代理（参考 nginx-example.conf，改完 nginx -s reload）"
echo "  3. 有域名的话在服务器上设置 SITE_URL 环境变量（SEO 用）"
