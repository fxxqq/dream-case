/**
 * 极简 Markdown 渲染器（造梦橱窗专用）
 * ------------------------------------------------------------------
 * 为什么不用 marked / markdown-it：
 *   简介是用户输入，直接渲染 HTML 有 XSS 风险，还得额外引 sanitize 依赖；
 *   简介需要的语法其实只有「加粗 / 斜体 / 行内代码 / 链接 / 列表 / 引用 / 标题 / 分割线」，
 *   这里用「先整体转义，再套极少数白名单标签」的方式实现，天然不会注入任何用户 HTML。
 *
 * 用法：
 *   浏览器：<script src="/md.js"></script> → MiniMd.render(src) / MiniMd.plain(src)
 *   Node：  const md = require('./frontend/md.js')
 *
 * 约定：
 *   - 不支持原始 HTML（一律当文本显示）、不支持图片（避免外链图与 XSS 面）
 *   - 链接只放行 http(s) / 站内相对路径 / mailto，统一加 rel="nofollow noopener noreferrer"
 *   - 标题最多四级：源码 # → h3（详情里 h1 是作品标题，简介内不抢层级）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiniMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_LEN = 20000; // 兜底：异常长文本不渲染，避免正则回溯拖慢响应

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC_MAP[c]); }
  function unesc(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

  // 链接白名单：http(s) / 站内路径（单个 / 开头）/ mailto
  function safeHref(raw) {
    const u = unesc(String(raw || '')).trim();
    if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
    if (/^\/[^\/\s]/.test(u)) return u;
    if (/^mailto:[^\s]+$/i.test(u)) return u;
    return '';
  }

  // 行内语法：`code` → [文本](链接) → **粗** → *斜* → ~~删除~~
  // 输入是「已转义」的文本，输出是白名单标签 + 已转义文本，不会带出用户 HTML
  function inline(escaped) {
    let t = escaped;
    const codes = [];
    t = t.replace(/`([^`\n]+)`/g, (m, code) => {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    // URL 允许出现一对嵌套括号（如维基链接 .../A_(b)），避免把右括号漏在正文里
    t = t.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, text, url) => {
      const href = safeHref(url);
      if (!href) return text; // 不安全链接只留文字
      return `<a href="${esc(href)}" target="_blank" rel="nofollow noopener noreferrer">${text}</a>`;
    });
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // 还原行内代码（内容本身没有被二次转义，直接拼回）
    t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)] || '');
    return t;
  }

  const RE_HEAD = /^(#{1,4})\s+(.*)$/;
  const RE_UL = /^[-*+]\s+(.*)$/;
  const RE_OL = /^(\d{1,3})[.、]\s+(.*)$/;
  const RE_HR = /^(\*{3,}|-{3,}|_{3,})$/;
  const RE_QUOTE = /^>\s?(.*)$/;
  const RE_FENCE = /^(?:```|~~~)\s*([\w+#.-]*)\s*$/;

  function render(src) {
    let text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);
    if (!text.trim()) return '';

    const lines = text.split('\n');
    const out = [];
    let i = 0;

    const flushParagraph = buf => {
      if (!buf.length) return;
      // 段内换行保留为 <br>，和用户书写习惯一致
      out.push('<p>' + buf.map(l => inline(esc(l))).join('<br>') + '</p>');
      buf.length = 0;
    };
    const para = [];

    while (i < lines.length) {
      const line = lines[i];

      // 空行：结束当前段落
      if (!line.trim()) { flushParagraph(para); i++; continue; }

      // 围栏代码块
      const fence = line.match(RE_FENCE);
      if (fence) {
        flushParagraph(para);
        const lang = fence[1] || '';
        const body = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // 跳过收尾围栏（没有收尾也能正常结束）
        out.push('<pre><code' + (lang ? ` class="lang-${esc(lang)}"` : '') + '>' + esc(body.join('\n')) + '</code></pre>');
        continue;
      }

      // 标题
      const head = line.match(RE_HEAD);
      if (head) {
        flushParagraph(para);
        const level = Math.min(head[1].length + 2, 6); // # → h3 … #### → h6
        out.push(`<h${level}>` + inline(esc(head[2].trim())) + `</h${level}>`);
        i++;
        continue;
      }

      // 分割线
      if (RE_HR.test(line.trim())) {
        flushParagraph(para);
        out.push('<hr>');
        i++;
        continue;
      }

      // 引用（连续 > 行合并成一个 blockquote）
      if (RE_QUOTE.test(line)) {
        flushParagraph(para);
        const q = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) { q.push(lines[i].match(RE_QUOTE)[1]); i++; }
        out.push('<blockquote>' + q.map(l => (l.trim() ? '<p>' + inline(esc(l)) + '</p>' : '')).join('') + '</blockquote>');
        continue;
      }

      // 无序列表
      if (RE_UL.test(line)) {
        flushParagraph(para);
        const items = [];
        while (i < lines.length && RE_UL.test(lines[i])) { items.push(lines[i].match(RE_UL)[1]); i++; }
        out.push('<ul>' + items.map(t => '<li>' + inline(esc(t)) + '</li>').join('') + '</ul>');
        continue;
      }

      // 有序列表
      if (RE_OL.test(line)) {
        flushParagraph(para);
        const items = [];
        while (i < lines.length && RE_OL.test(lines[i])) { items.push(lines[i].match(RE_OL)[2]); i++; }
        out.push('<ol>' + items.map(t => '<li>' + inline(esc(t)) + '</li>').join('') + '</ol>');
        continue;
      }

      // 普通段落行
      para.push(line.trim());
      i++;
    }
    flushParagraph(para);
    return out.join('');
  }

  /**
   * 取纯文本：卡片、列表、meta description、RSS 这类「不能放标签」的地方用
   * 把 Markdown 记号去掉后压成一行，避免卡片上出现 ** 和 ## 之类的符号
   */
  function plain(src) {
    let t = String(src == null ? '' : src);
    if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN);
    return t
      .replace(/```[\s\S]*?```/g, m => m.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')) // 代码块只留内容
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d{1,3}[.、]\s+/gm, '')
      .replace(/^(\*{3,}|-{3,}|_{3,})$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { render, plain, esc };
});
