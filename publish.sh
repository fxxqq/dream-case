#!/usr/bin/env bash
# 桌面快捷方式用的发版菜单（2026-11-14）
# 双击桌面「发布造梦橱窗」→ 弹这个菜单 → 选 1 看差异、选 2 发补丁、选 3 回滚。
# 真正的活都交给 deploy-patch.sh，这里只管把路径和提示摆顺，不藏任何额外逻辑。
cd "$(dirname "$0")" || exit 1
SELF="./deploy-patch.sh"
INTERACTIVE=0; [ -t 0 ] && INTERACTIVE=1

FILES=(server.js frontend/app.js frontend/style.css frontend/index.html frontend/admin.html)
LABELS=("server.js（后端 / 接口 / 口径）" "frontend/app.js（前端交互）" "frontend/style.css（样式）" "frontend/index.html（页面骨架）" "frontend/admin.html（后台）")

pause() { printf '\n'; read -r -p "回车返回菜单…" _ || true; }
bye()   { printf '\n'; if ((INTERACTIVE)); then printf '按回车关闭窗口…'; read -r _ || true; fi; exit 0; }
trap 'printf "\n"; exit 130' INT

banner() {
  printf '\n\033[1m  造梦橱窗 · 补丁发版\033[0m\n'
  printf '  \033[2m本地 %s ｜ 线上 idea.v5pc.com\033[0m\n\n' "$(pwd)"
}

menu() {
  banner
  printf '  \033[36m1\033[0m  看看有什么没发（只读，不动线上）\n'
  printf '  \033[36m2\033[0m  发补丁（选文件 → 选 hunk → 校验 → 上传）\n'
  printf '  \033[36m3\033[0m  回滚（还原最近一次备份）\n'
  printf '  \033[36m4\033[0m  看线上有哪些备份\n'
  printf '  \033[36m5\033[0m  打开命令行（自己敲 deploy-patch.sh）\n'
  printf '  \033[36m0\033[0m  退出\n\n'
  printf '  选择: '
}

do_check() { printf '\n'; $SELF check; pause; }

do_ship() {
  printf '\n  发哪个文件？\n\n'
  local i
  for i in "${!FILES[@]}"; do
    printf '   \033[36m%d\033[0m  %s\n' "$((i+1))" "${LABELS[$i]}"
  done
  printf '   \033[36m0\033[0m  返回\n\n  序号（多个用逗号，如 1,2）: '
  local pick; read -r pick || return
  case "$pick" in 0|"") return;; esac
  local n args=()
  IFS=',' read -ra nums <<< "$pick"
  for n in "${nums[@]}"; do
    n="${n// /}"
    [[ "$n" =~ ^[1-5]$ ]] || { printf '\n\033[33m  跳过无效序号：%s\033[0m\n' "$n"; continue; }
    args+=("${FILES[$((n-1))]}")
  done
  ((${#args[@]})) || { pause; return; }
  printf '\n\033[2m  下面会列出每个文件的 hunk，输入编号（回车=全发，n=跳过该文件）\033[0m\n'
  $SELF ship "${args[@]}"
  pause
}

do_rollback() {
  printf '\n  回滚哪个文件？\n\n'
  local i
  for i in "${!FILES[@]}"; do printf '   \033[36m%d\033[0m  %s\n' "$((i+1))" "${FILES[$i]}"; done
  printf '   \033[36m0\033[0m  返回\n\n  序号: '
  local pick; read -r pick || return
  [[ "$pick" =~ ^[1-5]$ ]] || return
  printf '\n\033[33m  即将把线上 %s 还原成最近一份备份\033[0m\n' "${FILES[$((pick-1))]}"
  read -r -p "  确认? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || { pause; return; }
  $SELF rollback "${FILES[$((pick-1))]}"
  pause
}

do_backups() { printf '\n'; $SELF backups; pause; }

while true; do
  menu
  read -r choice || bye
  case "$choice" in
    1) do_check;;
    2) do_ship;;
    3) do_rollback;;
    4) do_backups;;
    5) printf '\n\033[2m  直接进命令行：./deploy-patch.sh check ／ ship <文件> --hunks 1,3 ／ rollback <文件>\033[0m\n'; sleep 1; exec bash -l;;
    0|q|Q) bye;;
    *) ;;
  esac
done
