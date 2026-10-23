// My0511 帖子页解析：把一页 HTML（DOM）变成结构化的楼层数据
(function (root) {
  'use strict';

  const THREAD_RE = /\/f(\d+)b-t(\d+)z(?:-(\d+))?/;

  function clean(s) {
    return (s || '').replace(/[\s\u00a0]+/g, ' ').trim();
  }
  function txt(el) {
    return el ? clean(el.textContent) : '';
  }

  function threadFromUrl(url) {
    const path = new URL(url, 'https://bbs.my0511.com').pathname;
    const m = path.match(THREAD_RE);
    return m ? { fid: m[1], tid: m[2], page: +(m[3] || 1) } : null;
  }

  // 帖子级信息：标题、分类、版块、查看、回复、总页数
  function parseMeta(doc, tid, currentPage) {
    const meta = {};
    const nav = doc.querySelector('#consnav');
    if (nav) {
      const span = nav.querySelector('.dawn-fl span');
      if (span) {
        let t = clean(span.textContent);
        const cat = span.querySelector('a');
        if (cat) {
          const c = txt(cat);
          meta.category = c.replace(/^\[|\]$/g, '');
          t = clean(t.replace(c, ''));
        }
        meta.title = t;
      }
      const m = clean(nav.textContent).match(/查看:\s*(\d+)\s*回复:\s*(\d+)/);
      if (m) {
        meta.views = +m[1];
        meta.replies = +m[2];
      }
    }
    const parts = (doc.title || '').split(' - ');
    if (parts.length >= 2) meta.board = clean(parts[1]);
    if (!meta.title && parts.length) meta.title = clean(parts[0]);

    let maxPage = currentPage || 1;
    doc.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/-t(\d+)z-(\d+)(?:$|[#?])/);
      if (m && m[1] === String(tid)) maxPage = Math.max(maxPage, +m[2]);
    });
    meta.totalPages = maxPage;
    return meta;
  }

  // 论坛里的真图片带 data-src 和 lookpic 点击放大；表情是 align=absmiddle 的小 gif
  function isPicture(img) {
    const src = (img.getAttribute('src') || img.getAttribute('data-src') || '').toLowerCase();
    return (
      img.hasAttribute('data-src') ||
      /lookpic/.test(img.getAttribute('onclick') || '') ||
      /\.(jpe?g|png|webp|bmp)(\?|$)/.test(src)
    );
  }

  // 正文 DOM → 纯文本；引用转成 > 引用块；图片留 [图]；取出「发自xx」设备
  function contentToText(pc) {
    let device = '';
    const images = []; // 4.1：记下图片地址（只记，下载与否由设置决定）

    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue.replace(/[\s\u00a0]+/g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const cls = node.getAttribute('class') || '';

      if (tag === 'script' || tag === 'style') return '';
      if (tag === 'br') return '\n';
      if (tag === 'img') {
        if (!isPicture(node)) return '';
        const src = node.getAttribute('data-src') || node.getAttribute('file') || node.getAttribute('src') || '';
        try { const u = new URL(src, 'https://bbs.my0511.com/'); if (/^https?:$/.test(u.protocol)) images.push(u.href); } catch (e) { /* 地址无效就不记 */ }
        return '[图]';
      }

      if (/\bmobilestr\b/.test(cls)) {
        const m = txt(node).replace(/^-+|-+$/g, '').match(/发自\s*(.+)/);
        if (m) device = clean(m[1].replace(/-+$/, ''));
        return '';
      }
      if (tag === 'div' && /\bsmalltxt\b/.test(cls) && /^QUOTE:?$/i.test(txt(node))) return '';

      let inner = '';
      node.childNodes.forEach((c) => (inner += walk(c)));

      // 引用块：抽出被引用者和时间，正文里留一个标记，交给 md 换成跳转链接
      if (tag === 'div' && /\baltbg2\b/.test(cls)) {
        const whole = clean(node.textContent);
        const m = whole.match(/^原帖由\s*(.+?)\s*于\s*([\d-]+\s+[\d:]+)\s*发表\s*([\s\S]*)$/);
        if (m) {
          const f = (x) => String(x).replace(/[|@\n]/g, ' ').trim();
          return '\n@@Q|' + f(m[1]) + '|' + f(m[2]) + '|' + f(m[3]).slice(0, 60) + '@@\n\n';
        }
        const lines = inner.split('\n').map(clean).filter(Boolean);
        return '\n' + lines.map((l) => '> ' + l).join('\n') + '\n\n';
      }
      if (tag === 'div' || tag === 'p' || tag === 'li' || tag === 'tr') return '\n' + inner + '\n';
      return inner;
    }

    let out = '';
    pc.childNodes.forEach((c) => (out += walk(c)));
    const lines = out.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, device, images };
  }

  function parseFloors(doc) {
    const floors = [];
    doc.querySelectorAll('div.outer-section').forEach((sec) => {
      const f = {};
      const left = sec.querySelector('.conleft');
      const a = left && left.querySelector('a[href*="viewpro.php?uid="]');
      f.author = txt(a);
      const um = a && (a.getAttribute('href') || '').match(/uid=(\d+)/);
      f.uid = um ? um[1] : '';
      f.verified = !!(left && left.querySelector('.ico_2018smrz'));
      f.mobile = !!(left && left.querySelector('.ico_2018mobile'));
      if (left) {
        left.querySelectorAll('ul.leftlist li').forEach((li) => {
          const t = txt(li);
          let m;
          if ((m = t.match(/^来自\s*(.+)$/))) f.region = m[1];
          else if ((m = t.match(/^精华\s*(\d+)/))) f.digest = +m[1];
          else if ((m = t.match(/^注册\s*(\S+)/))) f.reg = m[1];
        });
      }
      const cl = sec.querySelector('.connext-left');
      if (cl) {
        f.time = txt(cl.querySelector('span.dawn-fl'));
        const fl = cl.querySelector('a.bold');
        const fm = txt(fl).match(/(\d+)\s*楼/);
        f.floor = fm ? +fm[1] : null;
        const pm = ((fl && fl.getAttribute('onclick')) || '').match(/pid(\d+)/);
        f.pid = pm ? pm[1] : '';
      }
      const pc = sec.querySelector('.post-content');
      if (pc) {
        const r = contentToText(pc);
        f.text = r.text;
        f.device = r.device;
        if (r.images.length) f.imageUrls = r.images.slice(0, 50);
      } else {
        f.text = '';
        f.device = '';
      }
      floors.push(f);
    });
    return floors;
  }

  // 列表页 / 搜索结果页上的帖子链接，供批量采集用
  function parseThreadLinks(doc) {
    const boardRows = parseBoardRows(doc);
    if (boardRows.length) return [...new Map(boardRows.map(row => [row.tid, row])).values()];
    const rows = parseSearchRows(doc);
    if (rows.length) return rows;
    const out = new Map();
    doc.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/f(\d+)b-t(\d+)z/);
      if (!m) return;
      const title = clean(a.textContent);
      if (title.length < 4 || /^\d+$/.test(title)) return;
      const prev = out.get(m[2]);
      if (!prev || title.length > prev.title.length) out.set(m[2], { fid: m[1], tid: m[2], title });
    });
    return [...out.values()];
  }

  // 搜索结果页（search.php）：表格每行 = 标题 / 论坛 / 作者+日期 / 回复 / 查看
  function parseSearchRows(doc) {
    const out = [], seen = new Set();
    doc.querySelectorAll('tr').forEach((tr) => {
      const tds = tr.querySelectorAll(':scope > td');
      if (tds.length < 5 || tr.querySelector('tr')) return; // 跳过套着整张表的外层排版行
      const a = [...tds[0].querySelectorAll('a[href]')].find(a => /\/f(\d+)b-t(\d+)z/.test(a.getAttribute('href') || ''));
      const m = a && (a.getAttribute('href') || '').match(/\/f(\d+)b-t(\d+)z/);
      if (!m || seen.has(m[2])) return;
      seen.add(m[2]);
      const num = (td) => { const n = parseInt(clean(td.textContent).replace(/[,，\s]/g, ''), 10); return Number.isFinite(n) ? n : null; };
      const who = tds[2].querySelector('a');
      const date = tds[2].querySelector('.smalltxt');
      out.push({
        fid: m[1], tid: m[2], title: clean(a.textContent),
        board: clean(tds[1].textContent), author: who ? clean(who.textContent) : '',
        date: date ? clean(date.textContent) : '', replies: num(tds[3]), views: num(tds[4]),
      });
    });
    return out;
  }

  // 版块列表页每一行的概要：主题/回复数/查看数/最后回复时间——用来跟存档比对，
  // 判断这个帖子是不是「新出现」或者「有新回复」，不用逐帖打开就能 detect 增量
  function parseBoardRows(doc) {
    const out = [];
    doc.querySelectorAll('dl.list_dl').forEach((dl) => {
      const a = dl.querySelector('a.a_topic[href]');
      if (!a) return; // 表头行、分隔行之类，没有主题链接
      const m = (a.getAttribute('href') || '').match(THREAD_RE);
      if (!m) return;
      const repliesEl = dl.querySelector('.cli_dd .fontblue');
      const viewsEl = dl.querySelector('.cli_dd .tcount');
      const timeEl = dl.querySelector('.ttime');
      const replies = repliesEl ? parseInt(clean(repliesEl.textContent), 10) : 0;
      const views = viewsEl ? parseInt(clean(viewsEl.textContent), 10) : 0;
      out.push({
        fid: m[1],
        tid: m[2],
        title: clean(a.textContent),
        replies: Number.isFinite(replies) ? replies : 0,
        views: Number.isFinite(views) ? views : 0,
        lastTime: timeEl ? clean(timeEl.textContent) : '',
      });
    });
    return out;
  }

  const api = { threadFromUrl, parseMeta, parseFloors, parseThreadLinks, parseBoardRows, contentToText };
  root.MY0511 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
