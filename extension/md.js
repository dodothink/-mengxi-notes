// 把存好的楼层拼成 Markdown，并生成存档索引
(function (root) {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }
  function stamp(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function bjStamp(ms) {
    if (!ms) return '时间不详';
    const d = new Date(ms + 8 * 3600000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function isoDate(forumTime) {
    const m = (forumTime || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '';
  }
  function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '｜').replace(/\n/g, ' '); }

  function mergeFloors(floors) {
    const byKey = new Map();
    for (const f of floors) byKey.set(f.floor != null ? 'n' + f.floor : 'p' + f.pid, f);
    return [...byKey.values()].sort((a, b) => (a.floor || 0) - (b.floor || 0));
  }

  function fileNameFor(thread, floors) {
    const fs = floors || [];
    const first = fs.find((f) => f.floor === 1) || fs[0];
    const date = isoDate((first && first.time) || thread.firstTime) || stamp(Date.now()).slice(0, 10);
    const title = (thread.title || 't' + thread.tid)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${date} t${String(thread.tid).replace(/[^0-9]/g, '')} ${title}.md`;
  }

  const escapeLine = (l) => (/^#/.test(l) ? '\\' + l : l);

  const FILLER = /^(顶|顶顶|沙发|板凳|地板|前排|路过|围观|支持|同意|赞|学习了|哈哈+|呵呵+|嗯+|收藏|马克|mark|飘过|来了|不错|正解|说得好|有道理)[。!！~\s.]*$/i;

  function buildThread(thread, rawFloors, opts) {
    opts = opts || {};
    const floors = mergeFloors(rawFloors);
    const byAuthorTime = new Map();
    for (const f of floors) if (f.author && f.time) byAuthorTime.set(f.author + '\u0000' + f.time, f.floor);

    const people = new Map();
    for (const f of floors) {
      const k = f.uid || f.author;
      if (!people.has(k)) people.set(k, {
        author: f.author, uid: f.uid, region: f.region || '', reg: f.reg || '',
        digest: f.digest != null ? f.digest : '', verified: f.verified, floors: [],
      });
      people.get(k).floors.push(f.floor);
    }

    function renderBody(f) {
      const t = (f.text || '').replace(/@@Q\|([^|]*)\|([^|]*)\|([^@]*)@@/g, (m, au, tm, ex) => {
        const n = byAuthorTime.get(au + '\u0000' + tm);
        const head = n ? `↩ 回复 [${n}楼 @${au}](#f${n})` : `↩ 引用 @${au}（${tm}）`;
        return '> ' + head + (ex ? '：' + ex + '…' : '');
      });
      return t.split('\n').map(escapeLine).join('\n');
    }

    const first = floors[0];
    const last = floors[floors.length - 1];
    const main = [], filler = [];
    for (const f of floors) {
      (opts.foldFiller && f.floor !== 1 && FILLER.test((f.text || '').trim()) ? filler : main).push(f);
    }

    const L = [];
    L.push('---');
    L.push('标题: ' + JSON.stringify(thread.title || ''));
    L.push('网址: ' + (thread.url || ''));
    L.push('tid: ' + thread.tid);
    if (thread.board) L.push('版块: ' + thread.board);
    if (thread.category) L.push('分类: ' + thread.category);
    if (thread.views != null) L.push('查看: ' + thread.views);
    if (thread.replies != null) L.push('回复: ' + thread.replies);
    if (first) L.push('首帖: ' + first.time);
    if (last) L.push('最后一楼: ' + last.time);
    L.push('已存楼数: ' + floors.length);
    const edited = floors.filter((f) => f.history && f.history.length);
    if (edited.length) L.push('改过的楼层: ' + edited.map((f) => f.floor).join(', '));
    L.push('采集时间: ' + bjStamp(Date.now())); // 4.0：统一用北京时间，和编辑历史里的时间一致
    L.push('---');
    L.push('');
    L.push('# ' + (thread.title || ''));
    L.push('');
    const span = first && last ? `${isoDate(first.time)} 至 ${isoDate(last.time)}` : '';
    L.push(`${floors.length} 楼 · ${people.size} 人${span ? ' · ' + span : ''}`);
    L.push('');
    L.push('## 参与者');
    L.push('');
    L.push('| 作者 | 地区 | 注册 | 发言数 | 发言楼层 |');
    L.push('|---|---|---|---|---|');
    [...people.values()].sort((a, b) => b.floors.length - a.floors.length).forEach((p) => {
      const shown = p.floors.slice(0, 14).map((n) => `[${n}](#f${n})`).join(' ');
      L.push(`| ${cell(p.author)} | ${cell(p.region)} | ${cell(p.reg)} | ${p.floors.length} | ${shown}${p.floors.length > 14 ? ' …' : ''} |`);
    });
    L.push('');
    L.push('## 正文');
    L.push('');
    for (const f of main) {
      const dev = f.device || (f.mobile ? '手机客户端' : '');
      const head = [f.author, f.time, f.region, dev].filter(Boolean).join(' · ');
      L.push(`### ${f.floor != null ? f.floor : '?'}楼 · ${head} <a id="f${f.floor}"></a>`);
      L.push('');
      L.push(renderBody(f) || '（无文字）');
      L.push('');
      if (f.hiddenAt) {
        // 4.0：整帖重采时这楼没再出现（被删、被屏蔽或被隐藏），保留原文并标记
        L.push(`> ⚠ 此楼在 ${bjStamp(f.hiddenAt)} 采集时已不可见（可能被删除、屏蔽或隐藏）`);
        L.push('');
      }
      if (f.images && f.images.length) {
        // 4.1：已存到本地的图片（相对存档文件夹的路径）
        L.push('> 图片存档：' + f.images.map((p, i) => `[${i + 1}](<${p}>)`).join(' '));
        L.push('');
      }
      if (f.fp) {
        // 4.1 取证指纹：正文规范化后的 SHA-256，和首次采到这个版本的时间（北京时间）
        L.push(`<!-- 指纹 sha256:${f.fp} · 首次采集 ${bjStamp(f.capturedAt)} -->`);
        L.push('');
      }
      if (f.history && f.history.length) {
        // 3.5.0：保留所有采集到的旧版本，最早的在前；时间是本插件采集到它的时间（北京时间）
        const n = f.history.length;
        L.push(`> **本楼内容变过 ${n} 次**：上面是最新版本（采集于 ${bjStamp(f.capturedAt)}${f.editedAt ? '，论坛标注编辑于 ' + f.editedAt : ''}）。以下是采集到的旧版本，按时间从早到晚：`);
        L.push('');
        f.history.forEach((h, i) => {
          const when = [h.capturedAt ? '首次采集 ' + bjStamp(h.capturedAt) : '', h.lastSeenAt && h.lastSeenAt !== h.capturedAt ? '最后见到 ' + bjStamp(h.lastSeenAt) : '', h.editedAt ? '论坛标注编辑于 ' + h.editedAt : ''].filter(Boolean).join('，');
          L.push(`<details><summary>${f.floor}楼 · 第 ${i + 1} 版${when ? '（' + when + '）' : ''}</summary>`);
          L.push('');
          L.push((renderBody({ text: h.text }) || '（无文字）').split('\n').map((l) => '> ' + l).join('\n'));
          L.push('');
          if (h.fp) { L.push(`<!-- 指纹 sha256:${h.fp} · 首次采集 ${bjStamp(h.capturedAt)} -->`); L.push(''); }
          L.push('</details>');
          L.push('');
        });
      }
    }
    if (filler.length) {
      L.push('## 附录：短回复');
      L.push('');
      for (const f of filler) {
        L.push(`- **${f.floor}楼** ${f.author} · ${f.time}：${(f.text || '').replace(/\n/g, ' ')} <a id="f${f.floor}"></a>`);
      }
      L.push('');
    }
    return L.join('\n');
  }

  function buildIndex(threads) {
    const list = threads.filter((t) => t.fileName).sort((a, b) => (a.fileName < b.fileName ? 1 : -1));
    const L = [];
    L.push('# My0511 论坛存档索引');
    L.push('');
    L.push(`共 ${list.length} 个帖子，索引更新于 ${stamp(Date.now())}。`);
    L.push('');
    L.push('| 首帖日期 | 标题 | 楼数 | 跟进 | 最后采集 | 原帖 |');
    L.push('|---|---|---|---|---|---|');
    for (const t of list) {
      L.push(`| ${t.fileName.slice(0, 10)} | [${cell(t.title)}](<${t.fileName}>) | ${t.floorCount || ''} | ${t.watch ? '是' : ''} | ${t.exportedAt ? stamp(t.exportedAt) : ''} | [打开](${t.url}) |`);
    }
    L.push('');
    return L.join('\n');
  }

  const api = { mergeFloors, fileNameFor, buildThread, buildIndex, stamp, isoDate };
  root.MD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
