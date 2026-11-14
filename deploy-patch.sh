#!/usr/bin/env bash
# 定向补丁发版工具（2026-11-14 建）
#
# 为什么要有它：
#   本地和线上长期分叉（几百行未发布改动），所以不能整包 deploy.sh，一发就全上去了；
#   手工补丁又容易忘发（2026-11-14 CTR 口径那一次：本地改完了，线上还是旧版）。
#
# 它干三件事：
#   check     只读对比本地与线上，列出每个文件差了几个 hunk、各改了什么 —— 防「改完忘发」
#   ship      只把选中的 hunk 打到「线上副本」上，再上传 —— 本地未确认的改动不会被连带
#   rollback  列出 / 还原时间戳备份 —— 出事有退路
#
# 三道防呆（对应手工补丁的三个真实风险）：
#   1. patch --fuzz=0 —— 只接受上下文完全对得上的 hunk，宁可失败也不静默贴错位置
#   2. 先写临时副本、全量校验通过才动线上；任一 hunk 失败整单 abort，不留半成品
#   3. 上传前留带时间戳的备份，冒烟不过自动回滚 + 重启
#
# 行尾注意：本地文件是 CRLF，线上是 LF。所以一律先 tr -d '\r' 归一化再 diff，
# 并且始终以「线上副本」为基底打补丁 —— 上传回去仍是 LF，不会把整站改成 CRLF。
#
# 用法：
#   ./deploy-patch.sh check                          # 看默认文件集差在哪
#   ./deploy-patch.sh check frontend/app.js          # 只看一个
#   ./deploy-patch.sh ship frontend/app.js           # 交互选 hunk
#   ./deploy-patch.sh ship frontend/app.js --all --yes
#   ./deploy-patch.sh ship server.js --hunks 3,7-9 --dry-run
#   ./deploy-patch.sh ship frontend/app.js --all --yes --smoke /app.js=曝光按人次算
#   ./deploy-patch.sh backups                        # 线上有哪些备份
#   ./deploy-patch.sh rollback frontend/app.js       # 还原该文件最新一份备份
#   ./deploy-patch.sh rollback frontend/app.js 20261114-163000
set -uo pipefail

SERVER_IP="${SERVER_IP:-47.95.66.103}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/ai-works-site}"
SITE_URL="${SITE_URL:-https://idea.v5pc.com}"
PM2_APP="${PM2_APP:-ai-works}"
KEEP_BAK="${KEEP_BAK:-10}"

DEFAULT_FILES=(server.js frontend/app.js frontend/style.css frontend/index.html frontend/admin.html)

cd "$(dirname "$0")" || exit 1
SSH="ssh -o BatchMode=yes -o LogLevel=ERROR $SERVER_USER@$SERVER_IP"
SCP="scp -q -o BatchMode=yes -o LogLevel=ERROR"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()    { c_err "✗ $*"; exit 1; }

# 归一化行尾，比对与打补丁都在 LF 世界进行
norm() { tr -d '\r' < "$1"; }

# 文件原本的行尾风格：线上 admin.html 是 CRLF，server.js / app.js 是 LF —— 按文件各自保留
eol_of() { if grep -qU $'\r' "$1" 2>/dev/null; then echo crlf; else echo lf; fi; }
to_crlf() { sed 's/$/\r/' "$1"; }

# 拉线上副本
pull() { # $1=相对路径  $2=落地文件
  if ! $SCP "$SERVER_USER@$SERVER_IP:$REMOTE_DIR/$1" "$2" 2>/dev/null; then
    return 1
  fi
}

# 把 diff 拆成 hunk 摘要：序号 <TAB> +行数 <TAB> -行数 <TAB> 首处改动
hunk_summary() { # $1=diff文件
  awk '
    /^@@/ {
      if (n) printf "%d\t%d\t%d\t%s\n", n, add, del, first
      n++; add=0; del=0; first=""; next
    }
    /^\+/ && !/^\+\+\+/ { add++; if (first=="") { s=substr($0,2); gsub(/\t/," ",s); first=substr(s,1,58) } }
    /^-/  && !/^---/   { del++; if (first=="") { s=substr($0,2); gsub(/\t/," ",s); first=substr(s,1,58) } }
    END { if (n) printf "%d\t%d\t%d\t%s\n", n, add, del, first }
  ' "$1"
}

# 只保留选中的 hunk（整块取舍，hunk 头自带的计数无需重算）
filter_hunks() { # $1=diff文件 $2=选中集合（空格分隔） $3=输出
  awk -v sel=" $2 " '
    BEGIN { n=0; keep=0 }
    /^@@/ { n++; keep = (index(sel, " " n " ") > 0) ? 1 : 0 }
    { if (n == 0) print; else if (keep) print }
  ' "$1" > "$3"
}

expand_sel() { # "1,3-5" -> "1 3 4 5"
  local out=() tok a b i
  IFS=',' read -ra toks <<< "$1"
  for tok in "${toks[@]}"; do
    tok="${tok// /}"
    [[ -z "$tok" ]] && continue
    if [[ "$tok" == *-* ]]; then
      a="${tok%%-*}"; b="${tok##*-}"
      [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]] || continue
      for ((i=a;i<=b;i++)); do out+=("$i"); done
    elif [[ "$tok" =~ ^[0-9]+$ ]]; then
      out+=("$tok")
    fi
  done
  echo "${out[*]}"
}

# 临时目录放仓库内（相对路径）：Git Bash 下 rm -rf /tmp/... 会被路径守卫拦住
mk_tmp() { local d=".deploy-patch.tmp.$$"; rm -rf "$d"; mkdir -p "$d"; echo "$d"; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# ---------------------------------------------------------------- check
cmd_check() {
  local files=("$@"); ((${#files[@]})) || files=("${DEFAULT_FILES[@]}")
  local tmp; tmp="$(mk_tmp)"; trap "rm -rf '$tmp'" RETURN
  local synced=0 dirty=0 missing=0 f onraw on loc df
  printf '%-24s %8s %8s %6s %s\n' "文件" "线上" "本地" "hunk" "变化"
  for f in "${files[@]}"; do
    onraw="$tmp/onraw"; on="$tmp/on"; loc="$tmp/loc"; df="$tmp/df"
    if ! pull "$f" "$onraw"; then
      printf '%-24s %8s %8s %6s %s\n' "$f" "—" "—" "—" "线上没有这个文件"
      missing=$((missing+1)); continue
    fi
    [[ -f "$f" ]] || { printf '%-24s %8s %8s %6s %s\n' "$f" "$(wc -l <"$onraw")" "—" "—" "本地没有"; continue; }
    norm "$onraw" > "$on"; norm "$f" > "$loc"
    diff -u "$on" "$loc" > "$df"
    local nh add del
    nh=$(grep -c '^@@' "$df" 2>/dev/null || true); nh=${nh:-0}
    if [[ "$nh" -eq 0 ]]; then
      printf '%-24s %8s %8s %6s %s\n' "$f" "$(wc -l <"$on")" "$(wc -l <"$loc")" "0" "已同步"
      synced=$((synced+1)); continue
    fi
    add=$(grep -c '^+' "$df" || true); del=$(grep -c '^-' "$df" || true)
    add=$((add-2)); del=$((del-2))   # 去掉 --- / +++ 两行头
    printf '%-24s %8s %8s %6s \033[33m+%s -%s\033[0m\n' "$f" "$(wc -l <"$on")" "$(wc -l <"$loc")" "$nh" "$add" "$del"
    hunk_summary "$df" | while IFS=$'\t' read -r n a d first; do
      printf '   #%-2s +%-4s -%-4s %s\n' "$n" "$a" "$d" "$first"
    done
    dirty=$((dirty+1))
  done
  echo
  if ((dirty)); then
    c_warn "有 $dirty 个文件本地和线上不一致$([[ $missing -gt 0 ]] && echo "，$missing 个线上缺文件")"
    c_dim  "发指定 hunk：./deploy-patch.sh ship <文件> --hunks 2,4-5"
  else
    c_ok "全部已同步$([[ $missing -gt 0 ]] && echo "（$missing 个线上缺文件）")"
  fi
}

# ---------------------------------------------------------------- ship
cmd_ship() {
  local files=() hunks="" all=0 yes=0 dry=0 expect_paths=() expect_texts=()
  while (($#)); do
    case "$1" in
      --hunks) hunks="${2:-}"; shift 2;;
      --all)   all=1; shift;;
      --yes|-y) yes=1; shift;;
      --dry-run) dry=1; shift;;
      --smoke) expect_paths+=("${2%%=*}"); expect_texts+=("${2#*=}"); shift 2;;
      -*) die "不认识的参数：$1";;
      *) files+=("$1"); shift;;
    esac
  done
  ((${#files[@]})) || die "要指定文件，例如：ship frontend/app.js --hunks 1,3"

  local tmp; tmp="$(mk_tmp)"; trap "rm -rf '$tmp'" RETURN
  local onraw on loc df sel patched eol
  local -a do_files=() do_stamp=()
  local need_restart=0

  for f in "${files[@]}"; do
    [[ -f "$f" ]] || die "本地没有 $f"
    onraw="$tmp/onraw"; on="$tmp/on"; loc="$tmp/loc"; df="$tmp/df"; sel="$tmp/sel.diff"; patched="$tmp/patched/$f"
    mkdir -p "$(dirname "$patched")"
    pull "$f" "$onraw" || die "线上没有 $f（新文件请手工传，本工具只管改）"
    eol="$(eol_of "$onraw")"
    norm "$onraw" > "$on"; norm "$f" > "$loc"
    diff -u "$on" "$loc" > "$df"
    local nh; nh=$(grep -c '^@@' "$df" || true); nh=${nh:-0}
    if [[ "$nh" -eq 0 ]]; then c_ok "$f 已同步，跳过"; continue; fi

    echo "── $f  共 $nh 个 hunk"
    hunk_summary "$df" | while IFS=$'\t' read -r n a d first; do
      printf '   #%-2s +%-4s -%-4s %s\n' "$n" "$a" "$d" "$first"
    done

    local choose
    if ((all)); then
      choose="$(seq 1 "$nh" | tr '\n' ' ')"
    elif [[ -n "$hunks" ]]; then
      choose="$(expand_sel "$hunks")"
      [[ -n "$choose" ]] || die "--hunks 解析不出序号：$hunks"
    else
      [[ -t 0 ]] || die "非交互环境请用 --all 或 --hunks（例：--hunks 1,3-5）"
      printf '发哪些? 逗号/区间，回车=全部，n=跳过此文件: '
      read -r line
      case "$line" in
        n|N) c_warn "跳过 $f"; continue;;
        "") choose="$(seq 1 "$nh" | tr '\n' ' ')";;
        *) choose="$(expand_sel "$line")";;
      esac
    fi
    # 序号合法性
    local x
    for x in $choose; do
      (( x >= 1 && x <= nh )) || die "hunk 序号 $x 超出范围（1..$nh）"
    done

    filter_hunks "$df" "$choose" "$sel"
    cp "$on" "$patched"
    if ! patch --fuzz=0 --no-backup-if-mismatch -s -i "$sel" "$patched"; then
      die "$f 打补丁失败（上下文对不上，说明线上这段被人改过）——已中止，线上未动"
    fi
    if ls "$patched".rej >/dev/null 2>&1; then
      die "$f 留下 .rej，补丁没打全 —— 已中止，线上未动"
    fi
    if [[ "$f" == *.js ]]; then
      node --check "$patched" || die "$f 语法校验不通过 —— 已中止，线上未动"
    fi
    local changed; changed=$(diff -u "$on" "$patched" | grep -c '^[+-]' || true)
    changed=$((changed-2))
    c_ok "✓ $f 已生成待发版本（$changed 行改动，hunk: $choose）"
    do_files+=("$f")
    if [[ "$eol" == crlf ]]; then
      # 线上这份原本就是 CRLF（如 admin.html），上传前转回去，别把一个文件的行尾风格改了
      local fin="$tmp/final/$f"; mkdir -p "$(dirname "$fin")"
      to_crlf "$patched" > "$fin"
      c_dim "  行尾沿用线上 CRLF"
      do_stamp+=("$fin")
    else
      do_stamp+=("$patched")
    fi
    [[ "$f" == *server.js ]] && need_restart=1
  done

  ((${#do_files[@]})) || { c_warn "没有要发的改动"; return 0; }

  echo
  c_dim "待上传：${do_files[*]}"
  ((dry)) && { c_warn "--dry-run：到这里停住，线上未动"; return 0; }

  if ((!yes)); then
    [[ -t 0 ]] || die "非交互环境请加 --yes"
    printf '确认上传并%s? [y/N] ' "$([[ $need_restart == 1 ]] && echo '重启 pm2' || echo '刷新静态文件')"
    read -r ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { c_warn "已取消"; return 0; }
  fi

  # 备份 → 上传 → 校验
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local i f baklist=()
  for i in "${!do_files[@]}"; do
    f="${do_files[$i]}"
    baklist+=("$f.bak-$stamp")
    $SSH "cd $REMOTE_DIR && cp -p '$f' '$f.bak-$stamp'" || die "备份 $f 失败 —— 未上传任何文件"
  done
  c_ok "✓ 备份完成（$stamp）"

  for i in "${!do_files[@]}"; do
    f="${do_files[$i]}"
    $SCP "${do_stamp[$i]}" "$SERVER_USER@$SERVER_IP:$REMOTE_DIR/$f" || { c_err "✗ 上传 $f 失败，回滚"; do_rollback "$stamp" "${do_files[@]}"; return 1; }
  done
  c_ok "✓ 已上传"

  # 只把 .js 文件交给 node --check：node 对 .html/.css 直接抛
  # ERR_UNKNOWN_FILE_EXTENSION，混进去会让整条命令失败、误触发回滚（2026-11-14 踩）。
  local js_list=()
  for f in "${do_files[@]}"; do [[ "$f" == *.js ]] && js_list+=("$f"); done
  if ((${#js_list[@]})); then
    if $SSH "cd $REMOTE_DIR && $(printf 'node --check %q && ' "${js_list[@]}" | sed 's/ && $//')" 2>/dev/null; then
      c_ok "✓ 线上语法校验通过（${js_list[*]}）"
    else
      c_err "✗ 线上语法校验失败，回滚"; do_rollback "$stamp" "${do_files[@]}"; return 1
    fi
  fi

  if ((need_restart)); then
    $SSH "pm2 restart $PM2_APP --update-env >/dev/null 2>&1" || { c_err "✗ 重启失败，回滚"; do_rollback "$stamp" "${do_files[@]}"; return 1; }
    c_ok "✓ pm2 已重启"
    sleep 2
  fi

  # 冒烟：站点 200 + 进程 online + 可选的文本断言
  local code; code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$SITE_URL/" || echo 000)
  if [[ "$code" != "200" ]]; then
    c_err "✗ 站点返回 $code，回滚"
    do_rollback "$stamp" "${do_files[@]}"; return 1
  fi
  c_ok "✓ 站点 200"
  if ((need_restart)) && ! $SSH "pm2 status $PM2_APP --no-color 2>/dev/null | grep -q online"; then
    c_err "✗ pm2 进程不在 online，回滚"; do_rollback "$stamp" "${do_files[@]}"; return 1
  fi
  for i in "${!expect_paths[@]}"; do
    local p="${expect_paths[$i]}" t="${expect_texts[$i]}"
    if curl --noproxy '*' -s "$SITE_URL$p" | grep -qF -- "$t"; then
      c_ok "✓ $p 含「$t」"
    else
      c_err "✗ $p 里没找到「$t」，回滚"
      do_rollback "$stamp" "${do_files[@]}"; return 1
    fi
  done

  # 备份保留 KEEP_BAK 份
  for f in "${do_files[@]}"; do
    $SSH "cd $REMOTE_DIR && ls -1t '$f'.bak-* 2>/dev/null | tail -n +\$(( $KEEP_BAK + 1 )) | xargs -r rm -f"
  done
  echo
  c_ok "发版完成（备份后缀 $stamp）"
  [[ " ${do_files[*]} " == *" frontend/"* ]] && c_dim "静态文件无哈希，让用户强刷（Ctrl+F5）才看得到新文案"
  return 0
}

# ---------------------------------------------------------------- rollback
do_rollback() { # $1=stamp $2..=文件
  local stamp="$1"; shift
  local f
  for f in "$@"; do
    if $SSH "cd $REMOTE_DIR && [ -f '$f.bak-$stamp' ] && cp -p '$f.bak-$stamp' '$f' && echo OK" | grep -q OK; then
      c_warn "已还原 $f ← .bak-$stamp"
    else
      c_err "还原 $f 失败，请手工处理：$REMOTE_DIR/$f.bak-$stamp"
    fi
  done
  $SSH "pm2 restart $PM2_APP --update-env >/dev/null 2>&1" || c_err "重启失败，请手工 pm2 restart $PM2_APP"
  c_warn "已回滚到发版前状态"
}

cmd_backups() {
  local files=("$@"); ((${#files[@]})) || files=("${DEFAULT_FILES[@]}")
  local f
  for f in "${files[@]}"; do
    echo "── $f"
    $SSH "cd $REMOTE_DIR && ls -1t '$f'.bak-* 2>/dev/null | head -${KEEP_BAK}" | sed 's/^/   /' || true
  done
}

cmd_rollback() {
  local f="${1:-}" stamp="${2:-}"
  [[ -n "$f" ]] || die "用法：rollback <文件> [备份后缀]"
  if [[ -z "$stamp" ]]; then
    stamp=$($SSH "cd $REMOTE_DIR && ls -1t '$f'.bak-* 2>/dev/null | head -1" | sed "s|^$f\.bak-||")
    [[ -n "$stamp" ]] || die "$f 没有备份"
    c_dim "用最新一份备份：$stamp"
  fi
  do_rollback "$stamp" "$f"
}

# ---------------------------------------------------------------- main
sub="${1:-}"; shift || true
case "$sub" in
  check)    cmd_check "$@";;
  ship)     cmd_ship "$@";;
  backups)  cmd_backups "$@";;
  rollback) cmd_rollback "$@";;
  *)        usage;;
esac
