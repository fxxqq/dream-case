#!/usr/bin/env bash
# 桌面「提交GitHub」的入口。2026-11-20 首版。
#
# 目标：双击 → 看到改了什么 → 回车 → 回车（说明留空）→ 已推到 GitHub。（2 下）
# 与 publish.sh 分两条腿：这里只管 git 提交推送，不碰服务器。
#
# 默认只提交「已跟踪文件」的改动；新文件（??）要按 a 或输序号才纳入，避免把
# 根目录那些 _xxx.jpg 之类的临时素材带进公开仓库。
#
# 提交前会扫一遍待提交内容：.deploy.env 里的真实 IP / 服务器路径、私钥头、
# GitHub / 模型厂商 token。命中就红字拦下，要手打 yes 才继续。
# 敏感值全部运行时从 .deploy.env 读，脚本本身不含任何真实地址或口令。
#
# 用法：./commit.sh [plan]   plan = 只扫描打印，不提交（自检用）
cd "$(dirname "$0")" || exit 1
printf '\033[2J\033[H\033]0;造梦橱窗 · 提交 GitHub\007'

GIT="git -c core.quotepath=off"
REMOTE=origin
TMPD="${TMPDIR:-/tmp}"
MODE="${1:-run}"
INTERACTIVE=0; [ -t 0 ] && INTERACTIVE=1
# 自检用：没有 tty 时也能走交互分支（配合临时仓库做端到端验证时用）
[ "${DM_FORCE_TTY:-}" = 1 ] && INTERACTIVE=1

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
c_b()    { printf '\033[1m%s\033[0m\n' "$*"; }

trap 'printf "\n"; exit 130' INT

# 窗口收尾：回车关窗。返回 0 表示重扫
close_prompt() {
  ((INTERACTIVE)) || return 1
  printf '\n  \033[2m回车关闭窗口 · s 重新扫描\033[0m: '
  local a=""; read -r a || return 1
  case "$a" in s|S) return 0;; *) return 1;; esac
}

BRANCH=$($GIT rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$BRANCH" ] || { c_err "  当前目录不是 git 仓库：$(pwd)"; ((INTERACTIVE)) && read -r -p "  回车关闭…" _; exit 1; }

# 从远端地址推网页链接：git@github.com:fxxqq/dream-case.git -> https://github.com/fxxqq/dream-case
REMOTE_URL=$($GIT config --get "remote.$REMOTE.url" 2>/dev/null)
WEB_URL=$(printf '%s' "$REMOTE_URL" | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')

REPO_NAME=$(basename "$(pwd)")

# ---------------------------------------------------------------- 敏感值来源
# 只取值，不打印。键名与 .deploy.env.example 一致。
SECRET_VALS=()
load_secrets() {
  SECRET_VALS=()
  [ -f .deploy.env ] || return 0
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue;; esac
    v="${v%$'\r'}"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    # 太短的（如 root）满屏误报，跳过；只盯 IP / 路径 / 长串
    [ ${#v} -ge 7 ] && SECRET_VALS+=("$v")
  done < .deploy.env
  return 0
}

# 扫码器：扫「即将提交」的内容（staged diff）。结果写临时文件返回路径，
# 因为管道里的 while 跑在子 shell，数组传不出来。
scan_secrets_to_file() {
  local out="$TMPD/.dm-secrets.$$"
  : > "$out"
  local diff; diff=$($GIT diff --cached -U0 2>/dev/null)
  [ -n "$diff" ] || { printf '' > "$out"; printf '%s' "$out"; return 0; }

  local val
  for val in "${SECRET_VALS[@]}"; do
    printf '%s\n' "$diff" | grep -nF -- "$val" 2>/dev/null | head -3 | while IFS= read -r hit; do
      printf '%s\n' "部署配置值出现：$(printf '%s' "$hit" | cut -c1-96)" >> "$out"
    done
  done

  local p
  for p in 'BEGIN [A-Z ]*PRIVATE KEY' 'ghp_[A-Za-z0-9]{16,}' 'github_pat_[A-Za-z0-9_]{20,}' \
           'sk-[A-Za-z0-9]{20,}' 'AKIA[0-9A-Z]{16}' 'xox[baprs]-[A-Za-z0-9-]{10,}'; do
    printf '%s\n' "$diff" | grep -nE "^\+.*$p" 2>/dev/null | head -3 | while IFS= read -r hit; do
      printf '%s\n' "疑似密钥：$(printf '%s' "$hit" | cut -c1-96)" >> "$out"
    done
  done

  printf '%s\n' "$diff" | grep -nEi '^\+.*(password|passwd|pwd|secret)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9!@#$%^&*_-]{8,}' 2>/dev/null | head -3 | while IFS= read -r hit; do
    printf '%s\n' "疑似明文口令：$(printf '%s' "$hit" | cut -c1-96)" >> "$out"
  done

  printf '%s' "$out"
}

# ---------------------------------------------------------------- 主流程
run_once() {
  printf '\n\033[1m  造梦橱窗 · 提交 GitHub\033[0m   \033[2m%s ｜ 分支 %s\033[0m\n' "$REPO_NAME" "$BRANCH"
  load_secrets

  # 没终端就跑 = 可能有人在脚本里误调，直接停手（plan 模式除外）
  if ((!INTERACTIVE)) && [ "$MODE" != plan ]; then
    c_err "  需要在交互终端里运行（双击桌面快捷方式）。只扫描请用：./commit.sh plan"
    return 1
  fi

  # 远端同步状态（连不上就跳过，push 时自然会报）
  local ahead=0 behind=0 fetched=0
  if GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=6" $GIT fetch -q "$REMOTE" "$BRANCH" 2>/dev/null; then
    fetched=1
    ahead=$($GIT rev-list --count "$REMOTE/$BRANCH..HEAD" 2>/dev/null || echo 0)
    behind=$($GIT rev-list --count "HEAD..$REMOTE/$BRANCH" 2>/dev/null || echo 0)
  fi
  ((behind > 0)) && c_warn "  注意：远端比你多 $behind 个提交，先跑一次 git pull --rebase 再提交更稳"

  # 扫描工作区
  local status; status=$($GIT status --porcelain=v1 2>/dev/null)
  local -a TRACKED=() TST=() NEW=()
  local line xy f
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    xy=${line:0:2}; f=${line:3}
    case "$xy" in
      '??') NEW+=("$f");;
      *)    TRACKED+=("$f"); TST+=("$xy");;
    esac
  done <<< "$status"

  # 行数统计（仅已跟踪）
  local -A ADDn=() DELn=()
  local a d fn
  while IFS=$'\t' read -r a d fn; do
    [ -n "$fn" ] || continue
    ADDn["$fn"]=$a; DELn["$fn"]=$d
  done < <($GIT diff --numstat 2>/dev/null)

  if [ ${#TRACKED[@]} -eq 0 ] && [ ${#NEW[@]} -eq 0 ]; then
    if ((ahead > 0)); then
      c_warn "  工作区干净，但有 $ahead 个本地提交还没推到 GitHub"
      if [ "$MODE" = plan ]; then c_dim "  （plan 模式，不推送）"; return 1; fi
      printf '  \033[2m回车推送 · 其他键取消\033[0m: '
      local k=""; read -r k || k="x"
      [ -z "$k" ] || { c_dim "  已取消"; return 1; }
      if $GIT push -q "$REMOTE" "$BRANCH" 2>"$TMPD/.dm-push.$$"; then
        c_ok "  已推送 $ahead 个提交 → $WEB_URL"; rm -f "$TMPD/.dm-push.$$"
      else
        c_err "  推送失败："; sed -n '1,4p' "$TMPD/.dm-push.$$"; rm -f "$TMPD/.dm-push.$$"
      fi
    else
      c_ok "  没有需要提交的改动，远端也是最新的"
      printf '  \033[2m%s\033[0m\n' "（改了文件再点一次即可）"
    fi
    return 1
  fi

  # 列出改动
  printf '\n  \033[1m改动清单\033[0m\n'
  local i=1 j=0
  for f in "${TRACKED[@]}"; do
    local st="改"; case "${TST[$j]}" in
      *D*) st="删";; *R*) st="改名";; *A*) st="新";; esac
    printf '   \033[36m%2d\033[0m  %s  \033[2m%s\033[0m  \033[32m+%s\033[0m \033[31m-%s\033[0m\n' \
      "$i" "$f" "$st" "${ADDn[$f]:--}" "${DELn[$f]:--}"
    i=$((i+1)); j=$((j+1))
  done

  if [ ${#NEW[@]} -gt 0 ]; then
    printf '  \033[2m-- 未跟踪（默认不提交）--\033[0m\n'
    local n=1
    for f in "${NEW[@]}"; do
      local sz=""; [ -f "$f" ] && sz=$(du -h "$f" 2>/dev/null | cut -f1)
      printf '   \033[33m%2s\033[0m  %s  \033[2m%s\033[0m\n' "$n" "$f" "$sz"
      n=$((n+1))
    done
  fi

  if [ "$MODE" = plan ]; then c_dim "  （plan 模式，到此为止）"; return 1; fi

  # 选择范围
  local -a PICK=("${TRACKED[@]}")
  if [ ${#NEW[@]} -gt 0 ]; then
    printf '\n  \033[2m新文件：a = 全部一起提交 · 直接回车 = 只提已跟踪的 · 输序号（如 1,3）\033[0m\n'
    printf '  选择: '
    local sel=""; read -r sel || sel=""
    case "$sel" in
      a|A) PICK+=("${NEW[@]}");;
      '')  ;;
      *)   local tok
           for tok in ${sel//,/ }; do
             if [[ "$tok" =~ ^[0-9]+$ ]] && ((tok >= 1 && tok <= ${#NEW[@]})); then
               PICK+=("${NEW[$((tok-1))]}")
             fi
           done;;
    esac
  fi

  # 暂存 + 扫描
  if [ ${#PICK[@]} -eq 0 ]; then
    c_warn "  没选中文件，什么都没做（新文件要按 a 或输序号）"
    return 1
  fi
  local -a MYADD=()
  $GIT add -A -- "${PICK[@]}" >/dev/null 2>&1 || { c_err "  git add 失败"; return 1; }
  MYADD=("${PICK[@]}")
  local staged_n; staged_n=$($GIT diff --cached --name-only 2>/dev/null | wc -l)
  if [ "$staged_n" -eq 0 ]; then c_err "  暂存区还是空的，中止"; return 1; fi

  local sfile; sfile=$(scan_secrets_to_file)
  if [ -s "$sfile" ]; then
    printf '\n  \033[41;97m 提交前拦一下 \033[0m \033[31m下面这些内容疑似不该进公开仓库：\033[0m\n'
    sed -e 's/^/    /' "$sfile" | cut -c1-140
    printf '\n  \033[33m确认这些内容能公开，输入 yes 继续；直接回车 = 撤下来\033[0m: '
    local ok=""; read -r ok || ok=""
    rm -f "$sfile"
    if [ "$ok" != "yes" ]; then
      $GIT restore --staged -- "${MYADD[@]}" >/dev/null 2>&1
      c_dim "  已撤销暂存，什么都没提交"
      return 1
    fi
  else
    rm -f "$sfile"
  fi

  # commit message
  local ts msg
  ts=$(date '+%m-%d %H:%M')
  msg="更新 $(printf '%s\n' "${PICK[@]}" | wc -l | tr -d ' ') 个文件 · $ts"
  printf '\n  \033[2m提交说明（直接回车用「%s」）\033[0m\n' "$msg"
  printf '  说明: '
  local input=""; read -r input || input=""
  [ -n "$input" ] && msg="$input"

  # 提交
  if ! $GIT commit -q -m "$msg" 2>"$TMPD/.dm-commit.$$"; then
    c_err "  git commit 失败："; sed -n '1,6p' "$TMPD/.dm-commit.$$"; rm -f "$TMPD/.dm-commit.$$"
    return 1
  fi
  rm -f "$TMPD/.dm-commit.$$"
  local hash; hash=$($GIT rev-parse --short HEAD)
  c_ok "  已提交 $hash  $msg"

  # 推送
  c_dim "  推送中…"
  if $GIT push -q "$REMOTE" "$BRANCH" 2>"$TMPD/.dm-push.$$"; then
    c_ok "  已推送到 GitHub → $WEB_URL"
    printf '  \033[2m%s/commit/%s\033[0m\n' "$WEB_URL" "$hash"
    rm -f "$TMPD/.dm-push.$$"
  else
    c_err "  推送失败（提交已留在本地）："
    sed -n '1,6p' "$TMPD/.dm-push.$$" | sed 's/^/    /'
    rm -f "$TMPD/.dm-push.$$"
    c_dim "  常见原因：远端有新提交 → git pull --rebase 后再点一次；或 SSH key 失效"
  fi
  return 1
}

while :; do
  run_once
  rc=$?
  close_prompt || break
done
exit 0
