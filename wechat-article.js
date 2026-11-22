/**
 * 星梦期刊 → 公众号文章排版
 *
 * 为什么单独一个文件：后台「一键生成」接口要给预览、复制富文本、下载 HTML 三种出口，
 * 它们必须拿到一模一样的正文；版式调整只改这一处，别在 admin.html 里再拼一份。
 *
 * 输出只用内联样式 + section/p/span/img。公众号编辑器会剥掉 <style> / class，
 * 所以不要写外部 CSS、CSS 变量、flex 布局或脚本；全部走 inline style 才粘得过去。
 */
const md = require('./frontend/md');

const PURPLE = '#6c5ce7';
const DEEP = '#2f2b46';
const MUTED = '#8a8aa3';
const LINE = '#edebf6';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[m]));

const num = v => Number(v) || 0;
const pad = n => String(n).padStart(2, '0');
const dateText = s => String(s || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2.$3');

// 标题字段历史很乱：title = 名字 + 一句话介绍，titleName 才是干净的名字。
// 没有 titleName 时从第一个逗号 / 双空格前截，别把「AI 女装试穿网站，1407 套衣服随便换」整串挂上。
function shortTitle(e, w) {
  const raw = String((w && (w.titleName || w.title)) || (e && e.title) || '').replace(/\s+/g, ' ').trim();
  const cut = raw.search(/\s{2,}|[，,。]/);
  return (cut > 1 ? raw.slice(0, cut) : raw).slice(0, 46) || '这件作品';
}

// 简介只取前两三句，公众号里没人看一大段。md.plain 把 Markdown 记号先剥干净。
function digest(s, max = 118) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const part = text.slice(0, max);
  const full = part.match(/^[\s\S]*[。！？!?；;]/);
  if (full && full[0].length >= 10) return full[0];
  const comma = Math.max(part.lastIndexOf('，'), part.lastIndexOf(','), part.lastIndexOf('、'));
  if (comma >= 10) return part.slice(0, comma);
  return part.replace(/[，,、：:；;\s]+$/, '') + '…';
}

function introOf(e, w) {
  const title = shortTitle(e, w);
  let text = digest(md.plain((w && w.prompt) || ''));
  if (text.startsWith(title)) text = text.slice(title.length).replace(/^[，,。:：\s]+/, '');
  const cat = (e.cats || [])[0] || '';
  return text || `${title} 是这一期上榜的作品${cat ? `，归在「${cat}」` : ''}，点开就能看。`;
}

function authorOf(e, w) {
  if (e.anonymous) return '匿名作者';
  return e.author || (w && (w.authorName || w.author)) || '没留名字';
}

function imageOf(e, origin) {
  const p = String(e.thumb || '');
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return String(origin || 'https://zm94.com').replace(/\/+$/, '') + (p.startsWith('/') ? p : '/' + p);
}

function statLine(e) {
  return [ `综合分 ${num(e.score)}`, `${num(e.uv)} 位访客`, e.type || '', (e.cats || [])[0] || '' ]
    .filter(Boolean).join(' · ');
}

function statCell(value, label) {
  return `<section style="display:inline-block;width:33.33%;text-align:center;vertical-align:middle;font-size:12px;color:${MUTED};">
    <b style="display:block;font-size:20px;line-height:1.3;color:${PURPLE};font-weight:700;">${esc(value)}</b>${esc(label)}
  </section>`;
}

function miniCard(e, title) {
  return `<section style="margin:12px 0 0;padding:10px 12px;background:#f8f7ff;border:1px dashed #b9aff4;border-radius:9px;font-size:12px;line-height:1.75;color:#6559cc;">
    <b style="display:block;margin-bottom:2px;font-size:12px;color:${PURPLE};">点卡片直达作品</b>
    作品：${esc(title)}<br />
    路径：pages/detail/index?id=${esc(e.id)}<br />
    到公众号后台点「小程序」→ 选「造梦橱窗」→ 填上面路径，替换本框。
  </section>`;
}

function featureCard(e, index, worksById, origin) {
  const w = worksById.get(e.id);
  const title = shortTitle(e, w);
  const img = imageOf(e, origin);
  const cover = img
    ? `<img src="${esc(img)}" alt="${esc(title)}" style="display:block;width:100%;border-radius:12px;background:#f3f2f8;" />`
    : `<section style="height:150px;border-radius:12px;background:#f6f4ff;text-align:center;line-height:150px;color:#aaa5c8;font-size:13px;">这一件没有封面图</section>`;
  const first = index === 0;
  return `<section style="margin:0 0 26px;padding:0 0 20px;border-bottom:1px solid #f1f0f6;">
    <section style="margin:0 0 11px;font-size:0;line-height:1;">
      <span style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;border-radius:9px;background:${first ? PURPLE : '#eeecfb'};color:${first ? '#fff' : PURPLE};font-size:14px;font-weight:700;vertical-align:middle;">${pad(e.rank || index + 1)}</span>
      <span style="display:inline-block;margin-left:9px;max-width:250px;font-size:18px;font-weight:700;color:${DEEP};vertical-align:middle;">${esc(title)}</span>
      ${first ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:99px;background:#fff3df;color:#b87b10;font-size:11px;vertical-align:middle;">本期第一</span>` : ''}
    </section>
    <p style="margin:0 0 10px;">${cover}</p>
    <p style="margin:0 0 6px;font-size:12px;color:${PURPLE};">作者：${esc(authorOf(e, w))}</p>
    <p style="margin:0 0 8px;font-size:14px;line-height:1.85;color:#565a6d;">${esc(introOf(e, w))}</p>
    <p style="margin:0 0 2px;font-size:12px;color:#9b9bb0;">${esc(statLine(e))}</p>
    ${miniCard(e, title)}
  </section>`;
}

/**
 * 生成一篇文章。
 * @param {object} o
 * @param {object} o.issue  /api/journal 的定稿期对象（phase=closed）
 * @param {Array}  o.works 作品总表，用来补作品简介 / titleName
 * @param {number} o.featured 正文里展开几件作品（默认前 4 名）
 * @param {string} o.origin  图片相对地址的前缀
 * @returns {{html:string,titles:string[],digest:string,cards:Array}}
 */
function renderWechatArticle({ issue, works = [], featured = 4, origin = 'https://zm94.com' } = {}) {
  const list = Array.isArray(issue && issue.list) ? issue.list : [];
  const worksById = new Map(works.filter(Boolean).map(w => [w.id, w]));
  const no = num(issue && issue.no) || 1;
  const kind = issue && issue.type === 'month' ? '月榜' : '周榜';
  const isMonth = issue && issue.type === 'month';
  const stats = (issue && issue.stats) || {};
  const st = dateText(issue && issue.from);
  const et = dateText(issue && issue.to);
  const featuredN = Math.max(1, Math.min(6, Math.floor(num(featured) || 4)));
  const top = list.slice(0, featuredN);
  const leadWork = worksById.get((top[0] || list[0] || {}).id);
  const leadTitle = shortTitle(top[0] || list[0] || {}, leadWork);

  const titles = [
    `${leadTitle}拿了第一｜星梦期刊第 ${no} 期`,
    `${num(issue && issue.works)} 件新作品，第一是「${leadTitle}」｜星梦期刊 ${no} 期`,
    `${isMonth ? '这一个月' : '这一周'}大家都做了什么小东西｜星梦期刊第 ${no} 期`
  ];
  const digestText = `${st} — ${et}，${num(issue && issue.works)} 件新作品，${num(issue && issue.count)} 件上榜，${num(stats.visitors)} 位访客来看过。第一名是「${leadTitle}」。`;

  const lead = list.length
    ? `第 ${no} 期从 ${st} 到 ${et}，一共收上来 ${num(issue.works)} 件作品，${num(issue.count)} 件进了榜。${num(stats.visitors)} 个人来过，${num(stats.lamps)} 盏灯火。下面这几件，是这一期里被点得最多的。`
    : `第 ${no} 期从 ${st} 到 ${et}，这一期没有作品上榜。期刊照常出刊，位置先空着。`;

  const cards = top.map((e, i) => {
    const w = worksById.get(e.id);
    return { rank: e.rank || i + 1, id: e.id, title: shortTitle(e, w), image: imageOf(e, origin), path: `pages/detail/index?id=${e.id}` };
  });

  const rest = list.slice(featuredN, featuredN + 8);
  const restHtml = rest.length ? `<section style="margin:22px 0;padding:16px;background:#fafaff;border-radius:12px;">
    <p style="margin:0 0 7px;font-size:13px;font-weight:700;color:${PURPLE};">其余上榜的</p>
    <p style="margin:0;font-size:13px;line-height:2.1;color:#666a7c;">${rest.map(e => {
      const w = worksById.get(e.id);
      return `<span style="display:inline-block;margin:0 13px 0 0;white-space:nowrap;">${pad(e.rank)} ${esc(shortTitle(e, w))} · ${num(e.score)} 分</span>`;
    }).join('')}</p>
  </section>` : '';

  const body = `<section style="max-width:677px;margin:0 auto;padding:0 2px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#333;font-size:15px;line-height:1.85;word-break:break-word;">

  <section style="margin:0 0 18px;padding:20px 18px;background:#f6f4ff;border-left:4px solid ${PURPLE};border-radius:0 12px 12px 0;">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;color:#8d82d9;">ZAOMENG PICK · ${esc(kind === 'month' ? 'MONTHLY' : 'WEEKLY')}</p>
    <p style="margin:0;font-size:26px;line-height:1.3;font-weight:700;color:${DEEP};">星梦期刊</p>
    <p style="margin:8px 0 0;font-size:13px;color:#6e6b86;">第 ${no} 期　${esc(st)} — ${esc(et)}　已定稿</p>
  </section>

  <p style="margin:0 0 14px;font-size:15px;line-height:1.9;color:#46495c;">${esc(lead)}</p>

  <section style="margin:0 0 24px;padding:12px 6px;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};font-size:0;">
    ${statCell(num(issue && issue.works), '件新作品')}
    ${statCell(num(issue && issue.count), '件上榜')}
    ${statCell(num(stats.visitors), '位访客')}
  </section>

  ${list.length ? `<p style="margin:0 0 12px;font-size:13px;color:#8d82d9;letter-spacing:1px;">本期看点</p>` : ''}
  ${top.map((e, i) => featureCard(e, i, worksById, origin)).join('')}
  ${restHtml}

  <p style="margin:20px 0 12px;font-size:15px;line-height:1.9;color:#45495c;">完整榜单在造梦橱窗的「星梦榜 → 星梦期刊」里，第 ${no} 期已经封存，后面不会再改。自己做了小东西的，也可以去投稿，不用花钱。</p>

  <section style="margin:24px 0 0;padding:14px 0 0;border-top:1px solid #eee;">
    <p style="margin:0;font-size:12px;line-height:1.8;color:#a0a0ad;">口径说明：星梦期刊只收这一期新上架的作品，按每件作品上架后头 7 天的互动算分：赞 5、收藏 8、评论 3、送灯人数 10、访客 2。出刊满 7 天定稿，名次不再动。</p>
  </section>

</section>`;

  return { html: body, titles, digest: digestText, cards };
}

module.exports = { renderWechatArticle, shortTitle, digest };
