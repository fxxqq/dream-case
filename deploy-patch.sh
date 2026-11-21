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
#   ./deploy-patch.sh plan                           # 机器可读的差异清单（publish.sh 的一键发版用）
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

# 冒烟探针：走 ssh 在服务器本机 curl 127.0.0.1，不走公网域名。
# 原因（2026-11-20 踩）：旧域名 idea.v5pc.com 加了 301 到主域，curl 默认不跟随 → 拿到 301 被误判成失败回滚；
# 而本机 curl 对 zm94.com 的证书握手本就会失败。绕开域名最稳 —— 探针只关心「同一套应用还活着」。
# 远端应用端口：脚本里默认 3000（SERVER_PORT 可覆盖），与 pm2 的 ai-works 监听口一致。
SERVER_PORT="${SERVER_PORT:-3000}"
SITE_URL="${SITE_URL:-}"   # 保留给需要自定义探针的场合；留空即走本机 ssh 探针
PM2_APP="${PM2_APP:-ai-works}"
KEEP_BAK="${KEEP_BAK:-10}"

DEFAULT_FILES=(server.js sms-auth.js captcha.js frontend/app.js frontend/style.css frontend/index.html frontend/admin.html frontend/icons.js frontend/captcha.js)

cd "$(dirname "$0")" || exit 1

# 线上连接信息不写进代码：从项目根的 .deploy.env 读取（该文件已 gitignore），
# 也可以用环境变量传入。本仓库是公开的，真实 IP / SSH 用户 / 部署路径不该出现在提交里。
[ -f .deploy.env ] && . ./.deploy.env

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()    { c_err "✗ $*"; exit 1; }

# 本机算 md5：远端跑在 Linux 上（有 md5sum），本机 macOS 只有 md5。
# 2026-11-21 踩的坑：本机没 md5sum 时 hash 算出空串，两边空==空被误判成「全部 SYNCED」，
# 看着一片绿其实比对完全失效。所以这里做兼容，下面再校验 hash 必须是 32 位十六进制，双保险。
md5_hex() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum | cut -d' ' -f1
  else
    md5 -q
  fi
}
is_md5_hex() { [[ "$1" =~ ^[0-9a-fA-F]{32}$ ]]; }

if [ -z "${SERVER_IP:-}" ] || [ -z "${SERVER_USER:-}" ] || [ -z "${REMOTE_DIR:-}" ]; then
  c_err "✗ 缺少线上连接信息（SERVER_IP / SERVER_USER / REMOTE_DIR 有一项没给）"
  echo "  把 .deploy.env.example 复制成 .deploy.env 填好即可；"
  echo "  或临时用环境变量传入：SERVER_IP=... SERVER_USER=... REMOTE_DIR=... ./deploy-patch.sh check"
  exit 1
fi

# -n：ssh 别读本地 stdin。不加上这个，ssh 会把调用方的终端输入（甚至管道内容）
# 当成要转发给远端的数据吞掉 —— 表现为「用管道喂 publish.sh 时按键全失效」。
SSH="ssh -n -o BatchMode=yes -o LogLevel=ERROR $SERVER_USER@$SERVER_IP"
SCP="scp -q -o BatchMode=yes -o LogLevel=ERROR"

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

# 冒烟探针：$1=路径（相对，如 "/" 或 "/bar"），输出响应体；状态码走全局 PROBE_CODE。
# SITE_URL 留空 → ssh 到服务器本机 curl 127.0.0.1（绕开 301 和本机证书握手问题，2026-11-20 定）。
# 显式给了 SITE_URL → 保持老的公网 curl 行为，给需要自定义探针的场合。
probe() {
  local pth="${1:-/}"
  if [ -n "$SITE_URL" ]; then
    PROBE_BODY="$(curl --noproxy '*' -s -w '\n%{http_code}' "$SITE_URL$pth" || true)"
  else
    PROBE_BODY="$($SSH "curl -s -w '\\n%{http_code}' http://127.0.0.1:$SERVER_PORT$pth" 2>/dev/null || true)"
  fi
  PROBE_CODE="${PROBE_BODY##*$'\n'}"
  PROBE_BODY="${PROBE_BODY%$'\n'*}"
}
PROBE_CODE=000; PROBE_BODY=""

# 把 diff 拆成 hunk 摘要：序号 <TAB> +行数 <TAB> -行数 <TAB> 首处改动
# 首处改动会洗成人话：去掉 +/− 号、行首空白、注释符号（// /* * <!-- -->），
# 只动了括号分号这类没信息量的行会被跳过，取下一行 —— 清单里看的是「改了什么」。
hunk_summary() { # $1=diff文件
  # LC_ALL=C 强制按字节处理：BSD awk 在 UTF-8 locale 下对中文 substr 再做正则会报
  # towc multibyte conversion failure，坏字节混进摘要还会污染调用方变量名 —— 2026-11-20 发版冒烟就崩在这。
  LC_ALL=C awk '
    function pick() { return (cfirst != "") ? cfirst : first }
    # 一个 hunk 里优先挑「注释行」当摘要：改动的目的通常写在中文注释里，
    # 纯代码行（const x = ...）没有信息量。只扫前 12 行改动，免得大 hunk 拖慢。
    function scan(line,   s) {
      if (seen >= 12) return
      seen++
      s = clean(line)
      if (s == "") return
      if (line ~ /^[+-][ \t]*(\/\/+|\/\*+|\*+|<!--)/ && cfirst == "") cfirst = s
      if (first == "") first = s
    }
    # 按显示宽度截断（中文算 2 列），免得多行摘要一长一短把清单撑乱
    function wtrunc(s, maxw,   i, c, w, out, cw) {
      out = ""; w = 0
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        cw = (c ~ /^[ -~]$/) ? 1 : 2
        if (w + cw > maxw) break
        out = out c; w += cw
      }
      return out
    }
    function clean(line,   s) {
      s = substr(line, 2)
      sub(/^[ \t]+/, "", s)
      sub(/^\/\/+[ \t]*/, "", s)
      sub(/^\/\*+[ \t]*/, "", s)
      sub(/^\*+[ \t]*/, "", s)
      sub(/[ \t]*\*\/$/, "", s)
      sub(/^<!--[ \t]*/, "", s)
      sub(/[ \t]*-->$/, "", s)
      gsub(/\t/, " ", s)
      if (s ~ /^[{}()\[\];,.]*$/) return ""
      return wtrunc(s, 68)
    }
    /^@@/ {
      if (n) printf "%d\t%d\t%d\t%s\n", n, add, del, pick()
      n++; add=0; del=0; first=""; cfirst=""; seen=0; next
    }
    /^\+/ && !/^\+\+\+/ { add++; scan($0) }
    /^-/  && !/^---/   { del++; scan($0) }
    END { if (n) printf "%d\t%d\t%d\t%s\n", n, add, del, pick() }
  ' "$1"
}

# 一次 awk 出总结：hunk数 <TAB> +行 <TAB> -行 <TAB> 首处改动
# （plan 每个文件要调一次，别用 grep×3 + cut + head 堆 fork —— msys 下一个 fork 上百毫秒）
diffstat_one() { # $1=diff文件
  LC_ALL=C awk '
    /^@@/ { nh++; next }
    /^\+\+\+/ || /^---/ { next }
    /^\+/ { add++; if (nh<=1 && first=="") { s=substr($0,2); gsub(/\t/," ",s); first=substr(s,1,58) } }
    /^-/  { del++; if (nh<=1 && first=="") { s=substr($0,2); gsub(/\t/," ",s); first=substr(s,1,58) } }
    END { printf "%d\t%d\t%d\t%s\n", nh+0, add+0, del+0, first }
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

# ---------------------------------------------------------------- plan
# 机器可读的差异清单，专给 publish.sh 的「一键发版」解析（人看还是用 check）。
# 输出两种行，都是 6 列 TAB 分隔：
#   DIRTY <TAB> 文件 <TAB> hunk数 <TAB> +行 <TAB> -行 <TAB> 首处改动
#   HUNK  <TAB> 文件 <TAB> 序号   <TAB> +行 <TAB> -行 <TAB> 这一处的摘要
# 每个 DIRTY 文件后面跟着它自己的 HUNK 行（publish.sh 就是靠这些行把
# 「改了什么」一条条列出来的，不再只给一句文件级摘要）。
# STATUS：DIRTY 有待发 / HUNK 具体的改动 / SYNCED 已同步 / NOPULL 线上取不到 / NOLOCAL 本地没有
#
# 为什么先算 md5：check/ship 是逐个 scp 拉全量再 diff，5 个文件要 5 次往返；
# 这里 1 次 ssh 拿到线上 md5，只有真不一样的文件才拉，无差异时几乎秒回。
cmd_plan() {
  local files=("$@"); ((${#files[@]})) || files=("${DEFAULT_FILES[@]}")
  local tmp; tmp="$(mk_tmp)"; trap "rm -rf '$tmp'" EXIT

  # 远端一次性回传每个文件的 md5（统一按去掉 \r 的内容算，和本地归一化口径一致）
  local remote=""
  remote=$($SSH "cd $REMOTE_DIR 2>/dev/null || exit 1
for f in ${files[*]}; do
  if [ -f \"\$f\" ]; then
    printf 'OK %s %s\n' \"\$(tr -d '\\r' < \"\$f\" | md5sum | cut -d' ' -f1)\" \"\$f\"
  else
    printf 'MISSING - %s\n' \"\$f\"
  fi
done" 2>/dev/null)

  if [ -z "$remote" ]; then
    printf 'NOPULL\t-\t0\t0\t0\t连不上线上（网络 / SSH key / 路径）\n'
    return 1
  fi

  local st sum f rsum rhex lsum onraw on loc df nh add del first ri
  # bash3 没有关联数组（declare -A 是 bash4）：用两条平行数组存「文件 → 状态:md5」，
  # 查找线性扫（文件最多 10 个）。本机 /bin/bash 3.2 也能跑 plan，publish.sh 不再误报无改动。
  local -a RM_F=() RM_V=()
  while read -r st sum f; do
    if [ -n "$f" ]; then
      RM_F+=("$f")
      RM_V+=("$st:$sum")
    fi
  done <<< "$remote"

  # 第一遍只判状态，把「内容确实不同」的文件收进候选
  local -a cand=()
  for f in "${files[@]}"; do
    if [ ! -f "$f" ]; then
      printf 'NOLOCAL\t%s\t0\t0\t0\t本地没有\n' "$f"; continue
    fi
    rsum=""
    for ri in "${!RM_F[@]}"; do
      if [ "${RM_F[$ri]}" = "$f" ]; then rsum="${RM_V[$ri]}"; break; fi
    done
    if [ -z "$rsum" ]; then
      printf 'NOPULL\t%s\t0\t0\t0\t线上查不到\n' "$f"; continue
    fi
    if [ "${rsum%%:*}" = "MISSING" ]; then
      printf 'NOPULL\t%s\t0\t0\t0\t线上没有这个文件\n' "$f"; continue
    fi
    rhex="${rsum#*:}"
    # hash 无效就别比了：空==空正是那次假绿的原因，宁可报 NOPULL 让人看见，也不能装作一致。
    if ! is_md5_hex "$rhex"; then
      printf 'NOPULL\t%s\t0\t0\t0\t线上 md5 无效（远端取 hash 失败）\n' "$f"; continue
    fi
    lsum=$(tr -d '\r' < "$f" | md5_hex)
    if ! is_md5_hex "$lsum"; then
      printf 'NOPULL\t%s\t0\t0\t0\t本机 md5 无效（md5sum / md5 都不可用）\n' "$f"; continue
    fi
    if [ "$lsum" = "$rhex" ]; then
      printf 'SYNCED\t%s\t0\t0\t0\t\n' "$f"; continue
    fi
    cand+=("$f")
  done
  ((${#cand[@]})) || return 0

  # 候选文件用一次 tar.gz 流拉回来：比逐个 scp 少 N-1 次往返。
  # 必须压缩：明文 tar 是 3.4MB / 10 秒，gz 后 1MB / 2.6 秒（家宽上行是瓶颈）。
  local raw="$tmp/raw"; mkdir -p "$raw"
  for f in "${cand[@]}"; do
    case "$f" in */*) mkdir -p "$raw/${f%/*}";; esac
  done
  $SSH "cd $REMOTE_DIR && tar czf - ${cand[*]}" 2>/dev/null | tar xzf - -C "$raw" 2>/dev/null || true

  for f in "${cand[@]}"; do
    onraw="$raw/$f"; on="$raw/.on"; loc="$raw/.loc"; df="$raw/.diff"
    if [ ! -f "$onraw" ]; then
      # tar 没带回来（远端无 tar / 中途断），退回逐个 scp
      pull "$f" "$onraw" 2>/dev/null || { printf 'NOPULL\t%s\t0\t0\t0\t拉取失败\n' "$f"; continue; }
    fi
    # 直接用 --strip-trailing-cr 比，不再 tr 出两份临时文件（msys 下每个 fork 上百毫秒）。
    # 差异只在行尾，hunk 划分跟 ship 的归一化比对完全一致。
    diff -u --strip-trailing-cr "$onraw" "$f" > "$df"
    IFS=$'\t' read -r nh add del first < <(diffstat_one "$df")
    nh=${nh:-0}
    if [ "$nh" -eq 0 ]; then
      printf 'SYNCED\t%s\t0\t0\t0\t\n' "$f"; continue
    fi
    printf 'DIRTY\t%s\t%s\t%s\t%s\t%s\n' "$f" "$nh" "$add" "$del" "$first"
    # 再逐 hunk 补明细：一个 hunk 一行，摘要是这处改动里第一个 +/− 行的内容。
    # 复用上面的 --strip-trailing-cr 差异文件，不额外 fork。
    while IFS=$'\t' read -r hn hadd hdel hfirst; do
      [ -n "$hn" ] || continue
      printf 'HUNK\t%s\t%s\t%s\t%s\t%s\n' "$f" "$hn" "$hadd" "$hdel" "$hfirst"
    done < <(hunk_summary "$df")
  done
}

# ---------------------------------------------------------------- check
cmd_check() {
  local files=("$@"); ((${#files[@]})) || files=("${DEFAULT_FILES[@]}")
  local tmp; tmp="$(mk_tmp)"; trap "rm -rf '$tmp'" EXIT
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
    local nh add del first0
    IFS=$'\t' read -r nh add del first0 < <(diffstat_one "$df")
    nh=${nh:-0}
    if [[ "$nh" -eq 0 ]]; then
      printf '%-24s %8s %8s %6s %s\n' "$f" "$(wc -l <"$on")" "$(wc -l <"$loc")" "0" "已同步"
      synced=$((synced+1)); continue
    fi
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

  local tmp; tmp="$(mk_tmp)"; trap "rm -rf '$tmp'" EXIT
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
      (( x >= 1 && x <= nh )) || die "hunk 序号 $x 超出范围（1..${nh}）"
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
    c_ok "✓ $f 已生成待发版本（$changed 行改动，hunk: ${choose}）"
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
    # frontend/icons.js 是被 server.js require 的（SSR 直接读 ICONS），只上传不重启的话
    # 线上 h1/服务端渲染还是旧图标，静态请求拿到的却是新的 —— 两边不一致，所以一并重启
    [[ "$f" == *server.js || "$f" == *frontend/icons.js ]] && need_restart=1
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
  c_ok "✓ 备份完成（${stamp}）"

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
  probe "/"
  local code="$PROBE_CODE"
  if [[ "$code" != "200" ]]; then
    c_err "✗ 站点返回 $code，回滚"
    do_rollback "$stamp" "${do_files[@]}"; return 1
  fi
  c_ok "✓ 站点 200"
  if ((need_restart)) && ! $SSH "pm2 status $PM2_APP --no-color 2>/dev/null | grep -q online"; then
    c_err "✗ pm2 进程不在 online，回滚"; do_rollback "$stamp" "${do_files[@]}"; return 1
  fi
  for i in "${!expect_paths[@]}"; do
    local p="${expect_paths[$i]}" t="${expect_texts[$i]}" body
    # 先取响应体再按纯 bash 比较：躲开 grep -q 的 SIGPIPE（curl 写剩余字节吃 141 被 pipefail 判失败，
    # 2026-11-16 踩）和 msys 下 grep 中文匹配问题。probe 已把状态码和 body 分开。
    probe "$p"; body="$PROBE_BODY"
    if [[ -n "$body" && "$body" == *"$t"* ]]; then
      c_ok "✓ $p 含「$t」"
    else
      c_err "✗ $p 里没找到「$t」（响应 ${#body} 字节），回滚"
      do_rollback "$stamp" "${do_files[@]}"; return 1
    fi
  done

  # 备份保留 KEEP_BAK 份
  for f in "${do_files[@]}"; do
    $SSH "cd $REMOTE_DIR && ls -1t '$f'.bak-* 2>/dev/null | tail -n +\$(( $KEEP_BAK + 1 )) | xargs -r rm -f"
  done
  echo
  c_ok "发版完成（备份后缀 ${stamp}）"
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
  plan)     cmd_plan "$@";;
  check)    cmd_check "$@";;
  ship)     cmd_ship "$@";;
  backups)  cmd_backups "$@";;
  rollback) cmd_rollback "$@";;
  *)        usage;;
esac
