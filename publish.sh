#!/usr/bin/env bash
# 桌面「发布造梦橱窗」的入口。2026-11-14 二次改版：菜单 → 一键发版。
#
# 旧流程：双击 → 菜单选 2 → 选哪个文件 → 回车 → 选哪些 hunk → y 确认  （5 下）
# 新流程：双击 → 直接看到差异清单 → 回车（全发）→ 回车（确认）    （2 下）
# 精细活儿都还在：s1 = 逐个挑 hunk，d = 展开/收起每处改动明细，m = 旧的完整菜单（回滚 / 备份 / 命令行）。
# 真正打补丁、备份、校验、冒烟、回滚全在 deploy-patch.sh，这里只负责问得少一点。
cd "$(dirname "$0")" || exit 1
printf '\033[2J\033[H\033]0;造梦橱窗 · 发版\007'

SELF="./deploy-patch.sh"
SITE="idea.v5pc.com"
INTERACTIVE=0; [ -t 0 ] && INTERACTIVE=1

FILES=(server.js frontend/app.js frontend/style.css frontend/index.html frontend/admin.html)
LABELS=("server.js（后端 / 接口 / 口径）" "frontend/app.js（前端交互）" "frontend/style.css（样式）" "frontend/index.html（页面骨架）" "frontend/admin.html（后台）")

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

pause() { printf '\n'; read -r -p "  回车返回菜单…" _ || true; }
trap 'printf "\n"; exit 130' INT

# 回车关窗；输入 m 回差异清单（重扫一遍）。返回 0 = 重扫，1 = 结束
close_prompt() {
  ((INTERACTIVE)) || return 1
  printf '\n  \033[2m回车关闭窗口 · m 重新对比\033[0m: '
  local a=""; read -r a || return 1
  case "$a" in m|M) return 0;; *) return 1;; esac
}

banner() {
  printf '\n\033[1m  造梦橱窗 · 发版\033[0m   \033[2m线上 %s ｜ 只发你选中的内容\033[0m\n' "$SITE"
}

# ---------------------------------------------------------------- 差异扫描
# 走 deploy-patch.sh plan：一次 ssh 拿线上 md5，只有真不一样的文件才拉回来。
# 无差异时 2 秒内出结果，不用每次等着把 5 个文件全拉一遍。
P_FILE=(); P_NH=(); P_ADD=(); P_DEL=(); P_FIRST=()
# 逐处改动明细（plan 的 HUNK 行）：文件 / 序号 / +行 / -行 / 摘要
H_FILE=(); H_N=(); H_ADD=(); H_DEL=(); H_TXT=()
MISSING=0; MISS_MSG=""

scan() {
  P_FILE=(); P_NH=(); P_ADD=(); P_DEL=(); P_FIRST=()
  H_FILE=(); H_N=(); H_ADD=(); H_DEL=(); H_TXT=()
  MISSING=0; MISS_MSG=""
  local out line st f nh add del first
  out=$($SELF plan 2>&1 </dev/null)
  if [ -z "$out" ]; then return 1; fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS=$'\t' read -r st f nh add del first <<< "$line"
    case "$st" in
      DIRTY)  P_FILE+=("$f"); P_NH+=("$nh"); P_ADD+=("$add"); P_DEL+=("$del"); P_FIRST+=("$first");;
      HUNK)   H_FILE+=("$f"); H_N+=("$nh"); H_ADD+=("$add"); H_DEL+=("$del"); H_TXT+=("$first");;
      NOPULL) MISSING=$((MISSING+1)); MISS_MSG="${MISS_MSG}    ${f}  ${first}"$'\n';;
    esac
  done <<< "$out"
  return 0
}

PER_FILE_HUNKS=6   # 详版里单个文件最多展开几处改动，其余折叠成「另 N 处」
PLAN_TOTAL=0

# 按显示宽度截断（中文算 2 列）
wcut() { # $1=最大宽度 $2=文本
  awk -v s="$2" -v maxw="$1" 'BEGIN {
    out = ""; w = 0
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1); cw = (c ~ /^[ -~]$/) ? 1 : 2
      if (w + cw > maxw) break
      out = out c; w += cw
    }
    printf "%s", out
  }'
}

# 含中文（非纯 ASCII）就当它是功能描述 —— 这个仓库的改动说明都写在中文注释里
has_wide() { LC_ALL=C grep -q '[^ -~]' <<< "$1"; }

# 每个文件挑一句「功能摘要」：优先带中文的那条 hunk 摘要，都没有就取第一条
file_summary() { # $1=文件名
  local i best=""
  for i in ${HIDX["$1"]:-}; do
    [[ -z "$best" ]] && best="${H_TXT[$i]}"
    if has_wide "${H_TXT[$i]}"; then printf '%s' "${H_TXT[$i]}"; return; fi
  done
  printf '%s' "$best"
}

# $1 = 0 简版（默认：一文件一行功能摘要） / 1 详版（每处改动一行）
render_plan() {
  local mode="${1:-0}" i f
  PLAN_TOTAL=0
  for i in "${!P_FILE[@]}"; do PLAN_TOTAL=$((PLAN_TOTAL + P_NH[i])); done

  printf '\n  \033[1m待发改动\033[0m \033[2m%s 个文件 · %s 处（本地有、线上还没有）\033[0m\n\n' \
    "${#P_FILE[@]}" "$PLAN_TOTAL"

  local -A FNO=() NHOF=() AOF=() DOF=() HIDX=()
  for i in "${!P_FILE[@]}"; do
    f="${P_FILE[$i]}"
    FNO["$f"]=$((i+1)); NHOF["$f"]="${P_NH[$i]}"
    AOF["$f"]="${P_ADD[$i]}"; DOF["$f"]="${P_DEL[$i]}"
  done
  for i in "${!H_FILE[@]}"; do
    f="${H_FILE[$i]}"
    HIDX["$f"]+="$i "
  done

  if ((mode)); then
    # 详版：清单以「改了什么」为主，一条改动一行，文件名只在每组开头出现一次当分组标签
    local -A RCNT=()
    for i in "${!H_FILE[@]}"; do
      f="${H_FILE[$i]}"
      RCNT["$f"]=$(( ${RCNT["$f"]:-0} + 1 ))
      if [ "${RCNT[$f]}" -eq 1 ]; then
        printf '   \033[36m%s\033[0m  \033[2m%-18s %2s 处  +%s -%s\033[0m\n' \
          "${FNO[$f]:--}" "${f#frontend/}" "${NHOF[$f]:-0}" "${AOF[$f]:-0}" "${DOF[$f]:-0}"
      fi
      if [ "${RCNT[$f]}" -le "$PER_FILE_HUNKS" ]; then
        printf '        \033[2m%-8s\033[0m %s\n' "+${H_ADD[$i]} -${H_DEL[$i]}" "${H_TXT[$i]}"
      fi
      if [ "${RCNT[$f]}" -eq "${NHOF[$f]:-0}" ] && [ "${RCNT[$f]}" -gt "$PER_FILE_HUNKS" ]; then
        printf '      \033[2m… 另 %d 处（m → 1 看完整差异，或 s%s 逐个挑）\033[0m\n' \
          "$(( ${RCNT[$f]} - PER_FILE_HUNKS ))" "${FNO[$f]}"
      fi
    done
  else
    # 简版：一个文件一行，只看改了啥功能
    for i in "${!P_FILE[@]}"; do
      f="${P_FILE[$i]}"
      printf '   \033[36m%s\033[0m  %-18s \033[2m%3s 处  +%s -%s\033[0m  %s\n' \
        "$((i+1))" "${f#frontend/}" "${P_NH[$i]}" "${P_ADD[$i]}" "${P_DEL[$i]}" \
        "$(wcut 42 "$(file_summary "$f")")"
    done
  fi

  # 兜底：万一 plan 只回了文件级摘要、没有逐 hunk 明细
  if [ "${#H_FILE[@]}" -eq 0 ]; then
    for i in "${!P_FILE[@]}"; do
      printf '   \033[36m%s\033[0m  %-18s \033[33m+%-4s -%-4s\033[0m %s\n' \
        "$((i+1))" "${P_FILE[$i]#frontend/}" "${P_ADD[$i]}" "${P_DEL[$i]}" "${P_FIRST[$i]:0:40}"
    done
  fi
  printf '\n'
}

# ---------------------------------------------------------------- 旧的完整菜单
menu_loop() {
  local choice
  while true; do
    banner
    printf '  \033[36m1\033[0m  看完整差异（每处改动一行摘要，只读）\n'
    printf '  \033[36m2\033[0m  逐个文件挑 hunk 发（精细）\n'
    printf '  \033[36m3\033[0m  回滚（还原最近一次备份）\n'
    printf '  \033[36m4\033[0m  看线上有哪些备份\n'
    printf '  \033[36m5\033[0m  打开命令行（自己敲 deploy-patch.sh）\n'
    printf '  \033[36m0\033[0m  返回差异清单\n\n  选择: '
    read -r choice || exit 0
    case "$choice" in
      1) printf '\n'; $SELF check; pause;;
      2) pick_file_ship;;
      3) do_rollback_menu;;
      4) printf '\n'; $SELF backups; pause;;
      5) printf '\n\033[2m  ./deploy-patch.sh check ／ ship <文件> --hunks 1,3 ／ rollback <文件>\033[0m\n'; sleep 1; exec bash -l;;
      0|q|Q) return 0;;
      *) ;;
    esac
  done
}

pick_file_ship() {
  local i n args=()
  printf '\n  发哪个文件？\n\n'
  for i in "${!FILES[@]}"; do printf '   \033[36m%d\033[0m  %s\n' "$((i+1))" "${LABELS[$i]}"; done
  printf '   \033[36m0\033[0m  返回\n\n  序号（多个用逗号，如 1,2）: '
  local pick; read -r pick || return
  case "$pick" in 0|"") return;; esac
  IFS=',' read -ra nums <<< "$pick"
  for n in "${nums[@]}"; do
    n="${n// /}"
    [[ "$n" =~ ^[1-5]$ ]] || { c_warn "  跳过无效序号：$n"; continue; }
    args+=("${FILES[$((n-1))]}")
  done
  ((${#args[@]})) || { pause; return; }
  printf '\n\033[2m  下面按文件列 hunk，输入编号（回车=全发，n=跳过该文件）\033[0m\n'
  $SELF ship "${args[@]}"
  pause
}

do_rollback_menu() {
  local i pick
  printf '\n  回滚哪个文件？\n\n'
  for i in "${!FILES[@]}"; do printf '   \033[36m%d\033[0m  %s\n' "$((i+1))" "${FILES[$i]}"; done
  printf '   \033[36m0\033[0m  返回\n\n  序号: '
  read -r pick || return
  [[ "$pick" =~ ^[1-5]$ ]] || return
  printf '\n\033[33m  即将把线上 %s 还原成最近一份备份\033[0m\n' "${FILES[$((pick-1))]}"
  read -r -p "  确认? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || { pause; return; }
  $SELF rollback "${FILES[$((pick-1))]}"
  pause
}

# ---------------------------------------------------------------- 主流程
# 返回 0 = 重新对比（用户按了 m），1 = 结束
flow() {
  local a sel=() i VIEW=0
  banner
  printf '  \033[2m对比本地与线上…（约 5 秒）\033[0m'
  if ! scan; then
    printf '\r\033[K'; c_err "  ✗ 拿不到差异（deploy-patch.sh plan 无输出）"
    menu_loop; return 1
  fi
  printf '\r\033[K'

  if ((${#P_FILE[@]} == 0)); then
    if ((MISSING > 0)); then
      c_warn "  ⚠ ${MISSING} 个文件没对比上："
      printf '%s' "$MISS_MSG"
    fi
    c_ok "  ✓ 本地与线上一致，没有待发改动"
    close_prompt || return 1
    return 0
  fi

  # d 可以来回切：简版（只看功能）↔ 详版（每处改动一行）
  while :; do
    render_plan "$VIEW"
    ((MISSING > 0)) && { c_warn "  ⚠ 另有 ${MISSING} 个文件没对比上（未计入下面清单）："; printf '%s' "$MISS_MSG"; }

    printf '  \033[1m回车\033[0m = 全发（%d 个文件 / %d 处）\n' "${#P_FILE[@]}" "$PLAN_TOTAL"
    if ((VIEW)); then
      printf '  \033[2m1,2 = 只发这几个文件（用上面的序号）   s1 = 只挑第 1 个文件的改动   d = 收起，只看每文件一句功能   m = 完整菜单   0 = 退出\033[0m\n'
    else
      printf '  \033[2m1,2 = 只发这几个文件（用上面的序号）   s1 = 只挑第 1 个文件的改动   d = 展开每处改动   m = 完整菜单   0 = 退出\033[0m\n'
    fi
    printf '\n  选择: '
    read -r a || return 1
    case "$a" in d|D) VIEW=$((1 - VIEW)); continue;; esac
    break
  done
  a="${a// /}"

  case "$a" in
    "")            sel=("${P_FILE[@]}");;
    0|q|Q|n|N)     return 1;;
    m|M)           menu_loop; return 0;;
    s[0-9]*|S[0-9]*)
      local n="${a:1}"
      if ! [[ "$n" =~ ^[0-9]+$ ]] || (( n < 1 || n > ${#P_FILE[@]} )); then
        c_err "  ✗ 没有第 $n 个文件"; close_prompt || return 1; return 0
      fi
      printf '\n  \033[2m%s\033[0m\n' "${P_FILE[$((n-1))]}"
      $SELF ship "${P_FILE[$((n-1))]}"
      close_prompt || return 1
      return 0;;
    *)
      local -a nums=()
      IFS=',' read -ra nums <<< "$a"
      for i in "${nums[@]}"; do
        if [[ "$i" =~ ^[0-9]+$ ]] && (( i >= 1 && i <= ${#P_FILE[@]} )); then
          sel+=("${P_FILE[$((i-1))]}")
        else
          c_warn "  忽略无效序号：$i"
        fi
      done
      ((${#sel[@]})) || { close_prompt || return 1; return 0; };;
  esac

  printf '\n  要发：\033[1m%s\033[0m\n' "${sel[*]}"
  (( ${#P_FILE[@]} >= 3 )) && c_dim "  （改动文件多，只想发一部分就 0 退出重来，或 s1 逐个挑）"
  printf '  确认上传线上？[Y/n] '
  local ok; read -r ok || return 1
  case "$ok" in n|N) c_warn "  已取消，线上没动"; return 1;; esac

  printf '\n'
  if $SELF ship "${sel[@]}" --all --yes; then
    close_prompt || return 1
  else
    c_err "  ✗ 发版没走通，看上面输出（中途失败会自动回滚）"
    close_prompt || return 1
  fi
  return 0
}

# 只看不改：./publish.sh list —— 打印差异清单就退出（不发版、不碰线上）；list full = 详版
if [ "${1:-}" = "list" ]; then
  local_view=0; [ "${2:-}" = "full" ] && local_view=1
  banner
  if ! scan; then c_err "  ✗ 拿不到差异（deploy-patch.sh plan 无输出）"; exit 1; fi
  if ((${#P_FILE[@]} == 0)); then
    ((MISSING > 0)) && { c_warn "  ⚠ ${MISSING} 个文件没对比上："; printf '%s' "$MISS_MSG"; }
    c_ok "  ✓ 本地与线上一致，没有待发改动"; exit 0
  fi
  render_plan "$local_view"
  ((MISSING > 0)) && { c_warn "  ⚠ 另有 ${MISSING} 个文件没对比上（未计入上面清单）："; printf '%s' "$MISS_MSG"; }
  exit 0
fi

while true; do
  flow || break
done
