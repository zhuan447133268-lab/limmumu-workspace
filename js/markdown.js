/*!
 * markdown.js —— 客户端 Markdown 渲染器，替代原仓库服务端的 marked
 *
 * 为什么自己写：
 *   1. 静态站没有 Node 服务端，marked 跑不了；
 *   2. 走 CDN 引入在国内不可靠（jsdelivr 常被墙），必须零外部依赖。
 *
 * 安全策略（比原版更严）：
 *   原版靠 CSP default-src 'none' 阻止 MD 内嵌脚本执行。
 *   客户端渲染没有这层隔离，因此这里**全量转义 HTML**，
 *   Markdown 中的任何原始 HTML 标签都只会显示为文本，不会被解析执行。
 *   同时过滤 javascript: / data: 协议的链接。
 *
 * 支持：ATX 标题、粗体、斜体、删除线、行内码、围栏代码块、链接、图片、
 *      有序/无序嵌套列表、任务列表、引用、分割线、GFM 表格。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 只放行 http/https/mailto/相对路径与锚点，挡掉 javascript: 等协议 */
  function safeUrl(u) {
    var s = String(u || '').trim();
    if (/^(javascript|vbscript|file):/i.test(s)) return '#';
    if (/^data:/i.test(s) && !/^data:image\//i.test(s)) return '#';
    return s;
  }

  /* ---------- 行内解析 ---------- */
  function inline(src) {
    var out = '';
    var i = 0;
    var text = String(src);

    // 先把行内代码抽出来占位，避免其中的 * _ [ ] 被当作标记
    var codes = [];
    text = text.replace(/(`+)([\s\S]*?)\1/g, function (m, tick, body) {
      codes.push(body.replace(/^ | $/g, ''));
      return '\u0000CODE' + (codes.length - 1) + '\u0000';
    });

    text = esc(text);

    // 图片 ![alt](src)
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      function (m, alt, src, title) {
        return '<img src="' + esc(safeUrl(src)) + '" alt="' + alt + '"' +
               (title ? ' title="' + title + '"' : '') + '>';
      });

    // 链接 [text](url)
    text = text.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      function (m, label, href, title) {
        var u = safeUrl(href);
        var ext = /^https?:/i.test(u);
        return '<a href="' + esc(u) + '"' + (title ? ' title="' + title + '"' : '') +
               (ext ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + label + '</a>';
      });

    // 自动链接 <https://...>（转义后是 &lt;...&gt;）
    text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, function (m, u) {
      return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });

    // 粗斜体 → 粗体 → 斜体（顺序不能反）
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^\w_])__([^_]+)__(?![\w_])/g, '$1<strong>$2</strong>');
    text = text.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
    // 删除线
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 还原行内代码
    text = text.replace(/\u0000CODE(\d+)\u0000/g, function (m, n) {
      return '<code>' + esc(codes[+n]) + '</code>';
    });

    return text;
  }

  /* ---------- 列表：按缩进构建嵌套 ---------- */
  function renderList(items, startIdx, baseIndent, ordered, out) {
    // items: [{indent, ordered, marker, text, checked}]
    out.push(ordered ? '<ol>' : '<ul>');
    var i = startIdx;
    while (i < items.length) {
      var it = items[i];
      if (it.indent < baseIndent) break;
      if (it.indent > baseIndent) { i++; continue; }   // 由递归处理
      if (it.ordered !== ordered) break;

      var li = '<li>';
      if (it.checked !== null) {
        li += '<input type="checkbox" disabled' + (it.checked ? ' checked' : '') + '> ';
      }
      li += inline(it.text);
      out.push(li);

      // 找子列表
      var j = i + 1;
      if (j < items.length && items[j].indent > baseIndent) {
        var childIndent = items[j].indent;
        var childOrdered = items[j].ordered;
        var consumed = renderList(items, j, childIndent, childOrdered, out);
        j = consumed;
      }
      out.push('</li>');
      i = j;
    }
    out.push(ordered ? '</ol>' : '</ul>');
    return i;
  }

  /* ---------- 主解析 ---------- */
  function render(md) {
    var lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 空行
      if (!line.trim()) { i++; continue; }

      // 围栏代码块
      var fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
      if (fence) {
        var marker = fence[1][0], lang = fence[2];
        var buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) {
          buf.push(lines[i]); i++;
        }
        i++;  // 跳过闭合行
        out.push('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' +
                 esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // ATX 标题
      var h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var lv = h[1].length;
        out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
        i++; continue;
      }

      // 分割线
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr>'); i++; continue;
      }

      // 表格：当前行含 |，下一行是分隔行
      if (/\|/.test(line) && i + 1 < lines.length &&
          /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var splitRow = function (r) {
          return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
        };
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          if (/^:-+:$/.test(c)) return ' style="text-align:center"';
          if (/^-+:$/.test(c))  return ' style="text-align:right"';
          return '';
        });
        var head = splitRow(line);
        out.push('<table><thead><tr>');
        head.forEach(function (c, k) { out.push('<th' + (aligns[k] || '') + '>' + inline(c) + '</th>'); });
        out.push('</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          var cells = splitRow(lines[i]);
          out.push('<tr>');
          cells.forEach(function (c, k) { out.push('<td' + (aligns[k] || '') + '>' + inline(c) + '</td>'); });
          out.push('</tr>');
          i++;
        }
        out.push('</tbody></table>');
        continue;
      }

      // 引用块
      if (/^\s*>/.test(line)) {
        var qbuf = [];
        while (i < lines.length && (/^\s*>/.test(lines[i]) || (lines[i].trim() && qbuf.length))) {
          qbuf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + render(qbuf.join('\n')) + '</blockquote>');
        continue;
      }

      // 列表（含嵌套与任务项）
      var listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
      if (listRe.test(line)) {
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(listRe);
          if (m) {
            var txt = m[3];
            var checked = null;
            var task = txt.match(/^\[([ xX])\]\s+(.*)$/);
            if (task) { checked = task[1].toLowerCase() === 'x'; txt = task[2]; }
            items.push({
              indent: m[1].replace(/\t/g, '    ').length,
              ordered: /\d/.test(m[2]),
              text: txt,
              checked: checked
            });
            i++;
          } else if (lines[i].trim() && items.length && /^\s{2,}/.test(lines[i])) {
            items[items.length - 1].text += ' ' + lines[i].trim();  // 续行
            i++;
          } else break;
        }
        renderList(items, 0, items[0].indent, items[0].ordered, out);
        continue;
      }

      // 段落：吃到空行或下一个块级标记
      var pbuf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(#{1,6}\s|>|```|~~~|([-*_])(\s*\2){2,}\s*$)/.test(lines[i]) &&
             !listRe.test(lines[i])) {
        pbuf.push(lines[i]); i++;
      }
      if (pbuf.length) out.push('<p>' + inline(pbuf.join('\n')) + '</p>');
      else i++;
    }

    return out.join('\n');
  }

  global.HBMarkdown = { render: render, escapeHtml: esc };
})(typeof window !== 'undefined' ? window : globalThis);
