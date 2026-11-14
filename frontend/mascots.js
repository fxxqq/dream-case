/* 造梦橱窗 · 右下角小助手形象库（2026-11-08）
 *
 * 为什么要单独一个文件：形象要能让用户自己换，切换时只换 <svg> 内容，
 * 悬浮 / 打招呼气泡 / 弹出的功能窗口 / 30 秒靠边站这些行为与形象无关，
 * 全部留在 index.html 的内联脚本 + style.css 里。
 *
 * 约定：
 *   - viewBox 统一 0 0 120 132（机器人是老图 0 0 120 126，也照旧兼容）
 *   - 每项 { name 短名（切换器里显示）, bubble 招呼气泡, msg 窗口里那句话, svg, beta?, act? }
 *   - act: { label 面板里那件「拿手事」, labelOff 可选（熄灯这种开/关两态的另一个名字）,
 *     ico 图标名（见 icons.js）, hint 无障碍说明 }。动作逻辑在 index.html 的 runAct 里，
 *     这里只描述「它是谁、它会什么」，保持本文件纯数据（/mascots 页也读同一份）。
 *     动作都不排他：每件拿手事都对应站内本来就有的入口，形象只是更顺手的那个门。
 *   - beta: true＝内测形象：/mascots 里标「内测中」，只有站长（后台口令登录过）能选，
 *     普通用户看见但点不动；不写就是已开放，用户可以随机换到（2026-11-09）
 *     2026-11-10：12 个形象全部标 beta，整库内测中——普通用户固定看默认的「灯火」，
 *     想真正开放某个形象，把那一项的 beta 删掉即可。
 *   - 通用动效类名：.m-float 悬浮 / .m-shadow 影子 / .m-eye 眨眼
 *   - 皮肤私有类名前缀：lam- 灯火、jar- 星星罐、moo- 月亮、bf- 梦蝶、door- 小门、quill- 羽毛笔、
 *     bt- 纸船、cl- 云枕、lt- 梦信、mb- 八音盒、ct- 梦猫
 *   - 加新形象只要在这里加一项，切换器会自动多出一格（顺序＝这个对象的键顺序）
 */
window.MASCOTS = {

  /* A 灯火小精灵：纸灯笼 + 火苗里的一双眼。站内积分就叫灯火，形象与货币同一个词。 */
  lamp: {
    name: '灯火',
    beta: true,
    act: { label: '点亮今日', ico: 'lamp', hint: '一键签到，领今天这盏灯火' },
    bubble: '灯亮着，要帮忙吗？',
    msg: '灯亮着，我就在。要装到桌面，还是先进小程序逛逛？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="lamB" x1="0" y1="0" x2=".3" y2="1">
      <stop offset="0" stop-color="#ffdcaa"/><stop offset=".55" stop-color="#ffb866"/><stop offset="1" stop-color="#ef8f43"/>
    </linearGradient>
    <radialGradient id="lamG" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#fffdf0" stop-opacity=".95"/>
      <stop offset=".55" stop-color="#ffe6a8" stop-opacity=".5"/>
      <stop offset="1" stop-color="#ffd489" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="126" rx="20" ry="4.2"/>
  <g class="m-float"><g class="lam-sway">
    <path d="M60 7v7" stroke="#c9a874" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="60" cy="6" r="2.4" fill="#c9a874"/>
    <rect x="46" y="14" width="28" height="8" rx="3.6" fill="#8a6238"/>
    <rect x="26" y="20" width="68" height="80" rx="30" fill="url(#lamB)"/>
    <path d="M42 25c-6 22-6 48 0 70M78 25c6 22 6 48 0 70" stroke="#e08e4a" stroke-width="1.2" fill="none" opacity=".38"/>
    <ellipse cx="60" cy="58" rx="25" ry="31" fill="url(#lamG)"/>
    <g class="lam-flame">
      <path d="M60 33c9 8 13 16 13 24 0 9-6 15-13 15s-13-6-13-15c0-8 4-16 13-24z" fill="#fff6cc"/>
      <path d="M60 47c5 5 7.2 9 7.2 13.2 0 4.8-3.2 7.8-7.2 7.8s-7.2-3-7.2-7.8C52.8 56 55 52 60 47z" fill="#fffdf4"/>
      <g class="lam-eyes">
        <ellipse class="m-eye" cx="55" cy="56" rx="2" ry="2.5" fill="#8b5a26"/>
        <ellipse class="m-eye" cx="65" cy="56" rx="2" ry="2.5" fill="#8b5a26"/>
        <path d="M57.4 62.4c1.7 1.5 3.5 1.5 5.2 0" stroke="#8b5a26" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".7"/>
      </g>
    </g>
    <rect x="44" y="97" width="32" height="8" rx="3.6" fill="#8a6238"/>
    <path d="M60 105v8" stroke="#c9a874" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M60 115l-3.4 7M60 115v8M60 115l3.4 7" stroke="#e0a94f" stroke-width="1.5" stroke-linecap="round"/>
  </g></g>
</svg>`
  },

  /* B 星星罐：一颗星＝一件作品，讲的是「投稿＝往罐子里放一颗星」。
     摇一颗星摇的是别人放进来的星（不含自己的，也不摇最新那批——那两个池子分别归「小门」和首页）。 */
  jar: {
    name: '星星罐',
    beta: true,
    act: { label: '摇一颗星', ico: 'star', hint: '从全站摇一件作品，跳过自己那几件' },
    bubble: '罐子里又多了颗星',
    msg: '罐子里装着大家投的梦。摇一颗，去看看别人的？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="jarG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".97"/>
      <stop offset=".55" stop-color="#e6ebfb" stop-opacity=".8"/>
      <stop offset="1" stop-color="#cbd3ee" stop-opacity=".95"/>
    </linearGradient>
    <radialGradient id="jarIn" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#ffe9a8" stop-opacity=".85"/>
      <stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="126" rx="19" ry="4"/>
  <g class="m-float">
    <g class="jar-cork">
      <rect x="47" y="12" width="26" height="15" rx="4.2" fill="#d8b184"/>
      <rect x="47" y="12" width="26" height="5.4" rx="2.7" fill="#e9cca6"/>
    </g>
    <rect x="42" y="24" width="36" height="9" rx="4.2" fill="#c3cbe6"/>
    <path d="M33 35h54a7 7 0 0 1 7 7v60a12 12 0 0 1-12 12H38a12 12 0 0 1-12-12V42a7 7 0 0 1 7-7z" fill="url(#jarG)" stroke="#c3cbe6" stroke-width="1.3"/>
    <rect x="38" y="47" width="5.5" height="46" rx="2.7" fill="#fff" opacity=".8"/>
    <ellipse cx="60" cy="78" rx="26" ry="22" fill="url(#jarIn)"/>
    <g class="jar-star" style="animation-delay:0s"><g transform="translate(51 71) scale(1.15)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#ffd977"/></g></g>
    <g class="jar-star" style="animation-delay:.55s"><g transform="translate(69 63) scale(.88)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#cfe0ff"/></g></g>
    <g class="jar-star" style="animation-delay:1.1s"><g transform="translate(58 88) scale(1)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#ffd977"/></g></g>
    <g class="jar-star" style="animation-delay:1.7s"><g transform="translate(72 86) scale(.72)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#ffe9b0"/></g></g>
    <g class="jar-star" style="animation-delay:2.2s"><g transform="translate(45 88) scale(.62)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#cfe0ff"/></g></g>
  </g>
</svg>`
  },

  /* C 月亮小梦：戴靛蓝睡帽的圆月，最直白地说「梦」。 */
  moon: {
    name: '月亮',
    beta: true,
    act: { label: '熄灯', labelOff: '点灯', ico: 'bulb', hint: '把页面调暗一档，再点复原' },
    bubble: '夜深了，慢慢来',
    msg: '夜深了，慢慢来。要不要先把站装到桌面，明天一点就开？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="mooG" x1=".2" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#ffeeb8"/><stop offset="1" stop-color="#ffc766"/>
    </linearGradient>
    <linearGradient id="mooCap" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#7575e8"/><stop offset="1" stop-color="#4747b6"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="126" rx="20" ry="4.2"/>
  <g class="m-float">
    <g class="moo-face">
      <circle cx="60" cy="74" r="40" fill="url(#mooG)"/>
      <circle cx="43" cy="93" r="5" fill="#ffd98a" opacity=".85"/>
      <circle cx="77" cy="99" r="3.4" fill="#ffd98a" opacity=".7"/>
      <circle cx="36" cy="70" r="2.6" fill="#ffd98a" opacity=".6"/>
      <path d="M97 72a37 37 0 0 1-22 36" stroke="#eeb050" stroke-width="3.4" opacity=".28" fill="none" stroke-linecap="round"/>
      <ellipse cx="36" cy="84" rx="5.4" ry="3" fill="#ffab7a" opacity=".5"/>
      <ellipse cx="82" cy="84" rx="5.4" ry="3" fill="#ffab7a" opacity=".5"/>
      <path d="M42 74c3.2-3.2 7.4-3.2 10.6 0" stroke="#b07a3a" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M67 74c3.2-3.2 7.4-3.2 10.6 0" stroke="#b07a3a" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M55 88c3 3.4 7 3.4 10 0" stroke="#b07a3a" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".85"/>
    </g>
    <path d="M21 64C23 40 39 24 60 24s37 16 39 40c-13-10-26-14-39-14s-26 4-39 14z" fill="url(#mooCap)"/>
    <path d="M24 63C18 57 14 50 13 41c2-1 5 0 7 3 3 6 8 12 13 16z" fill="url(#mooCap)"/>
    <circle cx="12" cy="38" r="7.2" fill="#f5f7ff"/>
    <circle cx="10" cy="36" r="2.8" fill="#e5e9fb"/>
    <path d="M21 64c13-10 26-14 39-14s26 4 39 14" stroke="#9a9af3" stroke-width="1.6" fill="none" opacity=".55"/>
  </g>
</svg>`
  },

  /* D 梦蝶：庄周梦蝶，翅膀一合一开就是「收起来 / 放出去」。 */
  bfly: {
    name: '梦蝶',
    beta: true,
    act: { label: '让它飞', ico: 'sharecard', hint: '生成分享图；在别的页面就复制链接' },
    bubble: '梦要飞出去',
    msg: '梦要飞出去，才有人看见。想先做哪一件？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="bfL" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#bcc4ff"/><stop offset=".55" stop-color="#cdb2ff"/><stop offset="1" stop-color="#f4bbe8"/>
    </linearGradient>
    <linearGradient id="bfD" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#aab4f8"/><stop offset="1" stop-color="#d8a9ef"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="126" rx="15" ry="3.6"/>
  <g class="m-float">
    <g class="bf-wing">
      <path d="M58 56C46 24 20 12 14 30c-6 19 10 34 44 37z" fill="url(#bfL)" opacity=".96"/>
      <path d="M57 72C40 70 22 78 26 94c4 15 25 4 31-15z" fill="url(#bfD)" opacity=".93"/>
      <circle cx="29" cy="41" r="2.3" fill="#fff" opacity=".9"/>
      <circle cx="41" cy="86" r="1.8" fill="#fff" opacity=".85"/>
      <circle cx="38" cy="56" r="1.4" fill="#fff" opacity=".7"/>
    </g>
    <g class="bf-wing"><g transform="translate(120,0) scale(-1,1)">
      <path d="M58 56C46 24 20 12 14 30c-6 19 10 34 44 37z" fill="url(#bfL)" opacity=".96"/>
      <path d="M57 72C40 70 22 78 26 94c4 15 25 4 31-15z" fill="url(#bfD)" opacity=".93"/>
      <circle cx="29" cy="41" r="2.3" fill="#fff" opacity=".9"/>
      <circle cx="41" cy="86" r="1.8" fill="#fff" opacity=".85"/>
      <circle cx="38" cy="56" r="1.4" fill="#fff" opacity=".7"/>
    </g></g>
    <path d="M57 46C50 37 46 33 40 31M63 46c7-9 11-13 17-15" stroke="#5b5384" stroke-width="1.7" fill="none" stroke-linecap="round"/>
    <circle cx="40" cy="31" r="2.4" fill="#cdb2ff"/>
    <circle cx="80" cy="31" r="2.4" fill="#cdb2ff"/>
    <ellipse cx="60" cy="72" rx="3.4" ry="21" fill="#5b5384"/>
    <circle cx="60" cy="49" r="4.6" fill="#5b5384"/>
    <circle cx="58.4" cy="48" r=".85" fill="#fff"/>
    <circle cx="61.6" cy="48" r=".85" fill="#fff"/>
  </g>
</svg>`
  },

  /* E 梦之门：拱形小门，点一下门扇真的开、暖光从门缝漏。 */
  door: {
    name: '小门',
    beta: true,
    act: { label: '推门进去', ico: 'shapes', hint: '随机推开一件作品，不看榜单' },
    bubble: '门开着，进来坐',
    msg: '门开着。进来看看能做点什么。',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="drLit" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff8e2"/><stop offset=".55" stop-color="#ffe1a3"/><stop offset="1" stop-color="#ffc877"/>
    </linearGradient>
    <linearGradient id="drLeaf" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7373e6"/><stop offset="1" stop-color="#4848b6"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="126" rx="22" ry="4.2"/>
  <g class="m-float">
    <path d="M26 120V60a34 34 0 0 1 68 0v60z" fill="#eef1fa" stroke="#d6dcee" stroke-width="2"/>
    <path class="door-glow" d="M35 120V61a25 25 0 0 1 50 0v59z" fill="url(#drLit)"/>
    <g class="door-star" style="animation-delay:.2s"><g transform="translate(48 76) scale(.6)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#fff"/></g></g>
    <g class="door-star" style="animation-delay:1.2s"><g transform="translate(74 100) scale(.45)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#fff"/></g></g>
    <g class="door-leaf">
      <path d="M35 116V61a25 25 0 0 1 50 0v55z" fill="url(#drLeaf)"/>
      <path d="M48 62h24" stroke="#9a9af2" stroke-width="1.6" opacity=".55"/>
      <path d="M48 74h24M48 86h24" stroke="#9a9af2" stroke-width="1.2" opacity=".33"/>
      <circle cx="76" cy="92" r="3" fill="#ffd98a"/>
    </g>
    <ellipse cx="60" cy="117" rx="27" ry="6.5" fill="#ffcf85" opacity=".55"/>
    <rect x="20" y="118" width="80" height="6.5" rx="3.2" fill="#dfe4f4"/>
  </g>
</svg>`
  },

  /* F 羽毛笔：笔尖划过落一颗星，把「创造」直接画出来。 */
  quill: {
    name: '羽毛笔',
    beta: true,
    act: { label: '接着写', ico: 'edit', hint: '打开投稿，接着上次的草稿写' },
    bubble: '刚写完一句',
    msg: '刚写了一句。要接着写，还是先做点别的？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="qPl" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#eeeaff"/><stop offset="1" stop-color="#d2cbef"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="58" cy="126" rx="18" ry="4"/>
  <g class="m-float">
    <g class="quill-body">
      <path d="M99 12C78 16 57 36 43 64c-6 12-10 22-13 32 10-6 22-12 34-22 16-13 30-38 35-62z" fill="url(#qPl)" stroke="#b3a7dc" stroke-width="1.6"/>
      <path d="M30 96C50 70 74 34 99 12" stroke="#a89bda" stroke-width="1.8" fill="none"/>
      <path d="M47 72l20 5M54 61l22 6M62 50l21 7M70 40l19 7M78 31l17 6" stroke="#bcafe6" stroke-width="1.5" opacity=".95"/>
      <path d="M49 76l-7 19M57 64l-3 21M66 52l0 18M75 41l3 15" stroke="#c6bce9" stroke-width="1.4" opacity=".8"/>
      <path d="M30 96l-3.6 9.4 9.6-4.6z" fill="#413a68"/>
      <circle cx="25" cy="112" r="8" fill="#ffd98a" opacity=".16"/>
      <path class="quill-spark" d="M25 103.5c1.1-5.6 1.1-5.6 6.7-6.7-5.6-1.1-5.6-1.1-6.7-6.7-1.1 5.6-1.1 5.6-6.7 6.7 5.6 1.1 5.6 1.1 6.7 6.7z" fill="#ffcb6b"/>
    </g>
  </g>
</svg>`
  },

  /* H 纸船：一只折好的梦，放进水里就该漂出去看人。桅杆顶一颗星＝刚点上的灯火。 */
  boat: {
    name: '纸船',
    beta: true,
    act: { label: '放一只', ico: 'arrowout', hint: '漂一件几乎没人看过的作品' },
    bubble: '折好了，放它走',
    msg: '折好了，一艘一只梦。要装到桌面，还是先进小程序逛逛？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="btP" x1=".2" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e8ecf9"/>
    </linearGradient>
    <linearGradient id="btS" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4f1ff"/><stop offset="1" stop-color="#d8d1f5"/>
    </linearGradient>
    <linearGradient id="btW" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bfd3f7"/><stop offset="1" stop-color="#9dbbee"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="124" rx="24" ry="4.2"/>
  <g class="m-float"><g class="bt-rock">
    <path d="M14 118c9-7 18-7 27 0s18 7 27 0 18-7 24-2" stroke="url(#btW)" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
    <path d="M26 92h68l-10 22c-2 4-6 6-10 6H46c-4 0-8-2-10-6z" fill="url(#btP)" stroke="#d5d9ec" stroke-width="1.6"/>
    <path d="M60 92v26" stroke="#dfe3f2" stroke-width="1.3"/>
    <path d="M59 24v64H31z" fill="url(#btS)" stroke="#c9c1ec" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M62 32l26 56H62z" fill="#fbfaff" stroke="#c9c1ec" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M60 18v70" stroke="#b6aede" stroke-width="2" stroke-linecap="round"/>
    <g class="bt-star"><g transform="translate(60 14) scale(.92)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#ffd977"/></g></g>
    <path d="M36 96h48" stroke="#fff" stroke-width="2" opacity=".85" stroke-linecap="round"/>
  </g></g>
</svg>`
  },

  /* I 云枕：一朵自己会呼吸的云，软到可以当枕头——「梦慢一点」的那层意思。 */
  cloud: {
    name: '云枕',
    beta: true,
    act: { label: '枕五分钟', labelOff: '醒来', ico: 'clock', hint: '暂停所有动效五分钟' },
    bubble: '先枕一会儿',
    msg: '枕头软，梦慢一点。想先做哪一件？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="clG" x1=".2" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f1efff"/><stop offset="1" stop-color="#dcd7f7"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="120" rx="26" ry="4.2"/>
  <g class="m-float"><g class="cl-drift"><g class="cl-breathe">
    <path d="M26 100a17 17 0 0 1-1-34 25 25 0 0 1 44-15 19 19 0 0 1 27 17 16 16 0 0 1 2 32z" fill="url(#clG)"/>
    <path d="M24 92c6 5 14 5 20 0" stroke="#fff" stroke-width="2.4" fill="none" opacity=".9" stroke-linecap="round"/>
    <ellipse cx="40" cy="88" rx="6" ry="3" fill="#ffb3c7" opacity=".4"/>
    <ellipse cx="84" cy="88" rx="6" ry="3" fill="#ffb3c7" opacity=".4"/>
    <path d="M43 78c3.6 4 8.4 4 12 0" stroke="#6f6b96" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <path d="M69 78c3.6 4 8.4 4 12 0" stroke="#6f6b96" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <path d="M57 90c2 2.2 3.8 2.2 5.8 0" stroke="#6f6b96" stroke-width="2.2" fill="none" stroke-linecap="round" opacity=".9"/>
    <g transform="translate(30 36) scale(.62)"><path class="cl-spark" d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#c3bcf0"/></g>
    <g transform="translate(94 44) scale(.48)"><path class="cl-spark" d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#c3bcf0"/></g>
  </g></g></g>
</svg>`
  },

  /* J 梦信：信纸自己往外探头，火漆是一颗星——「投出去才算数」的那层意思。 */
  letter: {
    name: '梦信',
    beta: true,
    act: { label: '写封信', ico: 'mail', hint: '直接给站长留一句话' },
    bubble: '有封信，给你的',
    msg: '信写好了，差一个收件人。想先做哪一件？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="ltB" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eae7f8"/>
    </linearGradient>
    <linearGradient id="ltF" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cfc9f0"/><stop offset="1" stop-color="#ada4e5"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="112" rx="30" ry="4.6"/>
  <g class="m-float">
    <g class="lt-paper">
      <rect x="32" y="28" width="56" height="54" rx="5" fill="#fff" stroke="#e2dff4" stroke-width="1.4"/>
      <path d="M42 42h36M42 52h36M42 62h24" stroke="#dcd8ef" stroke-width="2.2" stroke-linecap="round"/>
    </g>
    <path d="M25 108l28-24M95 108L67 84" stroke="#e0dcf2" stroke-width="1.6" fill="none"/>
    <path d="M24 50h72v52a8 8 0 0 1-8 8H32a8 8 0 0 1-8-8z" fill="url(#ltB)" stroke="#d6d2ee" stroke-width="1.6"/>
    <path d="M24 50l36 28 36-28" fill="none" stroke="#d6d2ee" stroke-width="1.6" stroke-linejoin="round"/>
    <g class="lt-seal">
      <circle cx="60" cy="86" r="9.5" fill="url(#ltF)"/>
      <circle cx="60" cy="86" r="9.5" fill="none" stroke="#9c92dd" stroke-width="1.2" opacity=".7"/>
      <g transform="translate(60 86) scale(.6)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#ffd977"/></g>
    </g>
    <g class="lt-spark" transform="translate(100 30) scale(.56)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#c3bcf0"/></g>
  </g>
</svg>`
  },

  /* K 八音盒：摇一摇发条就有一小段曲子飘出来，梦是被哄睡的那段旋律。 */
  box: {
    name: '八音盒',
    beta: true,
    act: { label: '放一段', ico: 'bell', hint: '现场合成一小段旋律，不加载音频文件' },
    bubble: '给你放一小段',
    msg: '一曲放完，梦就续上了。想先做哪一件？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="mbL" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bcbcf6"/><stop offset="1" stop-color="#8383e0"/>
    </linearGradient>
    <linearGradient id="mbB" x1=".2" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#8f8fe8"/><stop offset="1" stop-color="#6262ca"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="122" rx="26" ry="4.4"/>
  <g class="m-float"><g class="mb-rock">
    <g class="mb-note" style="animation-delay:0s"><g transform="translate(44 52)"><ellipse cx="0" cy="0" rx="7.4" ry="5.4" fill="#ffd977"/><rect x="5.2" y="-26" width="2.6" height="26" rx="1.3" fill="#ffd977"/><path d="M6.5-24c6 3.4 9 7.6 9 13" stroke="#ffd977" stroke-width="2.6" fill="none" stroke-linecap="round"/></g></g>
    <g class="mb-note" style="animation-delay:1.1s"><g transform="translate(74 40) scale(.74)"><ellipse cx="0" cy="0" rx="7.4" ry="5.4" fill="#ffc766"/><rect x="5.2" y="-26" width="2.6" height="26" rx="1.3" fill="#ffc766"/><path d="M6.5-24c6 3.4 9 7.6 9 13" stroke="#ffc766" stroke-width="2.6" fill="none" stroke-linecap="round"/></g></g>
    <rect x="26" y="62" width="68" height="14" rx="5" fill="url(#mbL)"/>
    <path d="M30 72h60" stroke="#6c6cd0" stroke-width="1.4" opacity=".45"/>
    <path d="M30 76h60v32a8 8 0 0 1-8 8H38a8 8 0 0 1-8-8z" fill="url(#mbB)"/>
    <rect x="42" y="86" width="36" height="20" rx="6" fill="#a9a9f1" opacity=".45"/>
    <g class="mb-key"><circle cx="97" cy="92" r="6.6" fill="#ffd977"/><path d="M90 92h7" stroke="#d9ab35" stroke-width="2" stroke-linecap="round"/><circle cx="97" cy="92" r="2.2" fill="#fff" opacity=".7"/></g>
    <g transform="translate(60 96) scale(.72)"><path d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#ffe6a0"/></g>
  </g></g>
</svg>`
  },

  /* L 梦猫：趴在梦上打盹的猫，尾巴一扫一扫——「别急，还没醒」的那层意思。 */
  cat: {
    name: '梦猫',
    beta: true,
    act: { label: '撸一下', ico: 'heart', hint: '掉一颗星，撸多了它会说梦话' },
    bubble: '喵…再睡五分钟',
    msg: '喵，刚梦见你的作品了。想先做哪一件？',
    svg: `<svg class="bot-svg" viewBox="0 0 120 132" aria-hidden="true">
  <defs>
    <linearGradient id="ctB" x1=".2" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".65" stop-color="#efecfa"/><stop offset="1" stop-color="#ded9f0"/>
    </linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="118" rx="30" ry="4.6"/>
  <g class="m-float">
    <path class="ct-tail" d="M92 100c16 1 21-11 11-18" stroke="#d3cde8" stroke-width="7" fill="none" stroke-linecap="round"/>
    <g class="ct-body">
      <ellipse cx="62" cy="96" rx="32" ry="20" fill="url(#ctB)" stroke="#d8d3ea" stroke-width="1.4"/>
      <ellipse cx="44" cy="110" rx="8.4" ry="4.6" fill="#fff" stroke="#e2def0" stroke-width="1.2"/>
      <ellipse cx="62" cy="112" rx="8.4" ry="4.6" fill="#fff" stroke="#e2def0" stroke-width="1.2"/>
    </g>
    <g class="ct-head">
      <path d="M27 66l1-18 16 9z" fill="#e6e2f4" stroke="#d8d3ea" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M60 58l14-11 2 18z" fill="#e6e2f4" stroke="#d8d3ea" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="46" cy="82" r="21" fill="url(#ctB)" stroke="#d8d3ea" stroke-width="1.4"/>
      <path d="M32 60l1-7 6 4" fill="none" stroke="#f0c7d4" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M63 55l6-5 1 7" fill="none" stroke="#f0c7d4" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M36 82c3 3.2 7 3.2 10 0" stroke="#6f6b96" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M50 82c3 3.2 7 3.2 10 0" stroke="#6f6b96" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M44 90h6l-3 3.4z" fill="#e9a2b9"/>
      <path d="M47 93.4c-1.6 2-3.4 2.4-5 1.6M47 93.4c1.6 2 3.4 2.4 5 1.6" stroke="#c98ca6" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".8"/>
      <path d="M14 84h10M14 91h10M68 84h10M68 91h10" stroke="#cfc9e2" stroke-width="1.5" stroke-linecap="round"/>
      <ellipse cx="36" cy="90" rx="4.6" ry="2.4" fill="#ffb3c7" opacity=".45"/>
      <ellipse cx="56" cy="90" rx="4.6" ry="2.4" fill="#ffb3c7" opacity=".45"/>
    </g>
    <g transform="translate(82 48) scale(.55)"><path class="ct-spark" d="M0-6.4C1.15-1.15 1.15-1.15 6.4 0 1.15 1.15 1.15 1.15 0 6.4-1.15 1.15-1.15 1.15-6.4 0-1.15-1.15-1.15-1.15 0-6.4Z" fill="#c3bcf0"/></g>
  </g>
</svg>`
  },

  /* G 原版机器人（Trae 风格）：留作兜底选项，用户想换回去随时换。 */
  robot: {
    name: '机器人',
    beta: true,
    act: { label: '找件工具', ico: 'search', hint: '直接搜站内作品' },
    bubble: '嗨～需要帮忙吗？',
    msg: '嗨，我是造梦小助手，这几件事都能帮你：',
    svg: `<svg class="bot-svg" viewBox="0 0 120 126" aria-hidden="true">
  <defs>
    <linearGradient id="botShell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dcdfe7"/>
    </linearGradient>
    <linearGradient id="botScreen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c2e36"/><stop offset="1" stop-color="#141519"/>
    </linearGradient>
  </defs>
  <ellipse class="bot-shadow" cx="60" cy="119" rx="24" ry="5" fill="rgba(40,40,90,.14)"/>
  <g class="bot-float">
    <rect x="43" y="78" width="34" height="28" rx="12" fill="url(#botShell)" stroke="#c7cad4" stroke-width="1"/>
    <rect x="70" y="85" width="12" height="8" rx="4" fill="#e9eaf0" stroke="#c7cad4" stroke-width="1" transform="rotate(-18 76 89)"/>
    <g transform="rotate(8 85 92)">
      <rect x="76" y="85" width="18" height="14" rx="3.5" fill="#26272d"/>
      <circle cx="82" cy="90" r="1.6" fill="#8f939e"/>
      <circle cx="87" cy="93" r="1.6" fill="#5c606b"/>
    </g>
    <g class="bot-head">
      <g transform="rotate(-4 60 44)">
        <rect x="16" y="7" width="88" height="74" rx="20" fill="url(#botShell)" stroke="#c7cad4" stroke-width="1"/>
        <rect x="25" y="16" width="70" height="56" rx="12" fill="url(#botScreen)"/>
        <g class="bot-eyes">
          <rect class="bot-eye" x="43" y="38" width="13" height="13" rx="2.5" fill="#fff" transform="rotate(45 49.5 44.5)"/>
          <rect class="bot-eye" x="64" y="38" width="13" height="13" rx="2.5" fill="#fff" transform="rotate(45 70.5 44.5)"/>
        </g>
      </g>
    </g>
    <g class="bot-arm">
      <rect x="31" y="80" width="11" height="24" rx="5.5" fill="url(#botShell)" stroke="#c7cad4" stroke-width="1"/>
      <circle cx="36.5" cy="102.5" r="5.5" fill="#f7f8fb" stroke="#c7cad4" stroke-width="1"/>
    </g>
  </g>
</svg>`
  }
};
