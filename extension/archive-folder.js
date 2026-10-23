// 4.0：在插件自己选定的存档文件夹里按 tid 合并写入（File System Access API）。
// 不需要本地服务（Agent）。用于插件面板（可弹授权）和 offscreen 页面（后台自动写入）。
// 规则：同一 tid 只留一个 t 格式文件；楼层只增不减；编辑历史不丢；
// 被合并掉的文件移到 _重复备份/，不删除内容；写前复查修改时间；写后自检。
(function (root) {
  'use strict';
  const INDEX = 'My0511存档索引.md';
  const BACKUP = '_重复备份';
  const MAX = 12 * 1024 * 1024;
  const legacy = new Map(); // 旧格式文件名 → { lastModified, tid }

  const M = () => root.ArchiveMerge;

  async function fileOf(dir, name) { return (await dir.getFileHandle(name)).getFile(); }

  async function headTid(dir, name) {
    const f = await fileOf(dir, name);
    const c = legacy.get(name);
    if (c && c.lastModified === f.lastModified) return c.tid;
    const m = /^tid:\s*(\d+)/m.exec(await f.slice(0, 1500).text());
    const tid = m ? m[1] : null;
    legacy.set(name, { lastModified: f.lastModified, tid });
    return tid;
  }

  async function candidates(dir, tid) {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || name.startsWith('.') || name === INDEX) continue;
      const t = M().T_NAME.exec(name);
      if (t) { if (t[1] === tid) out.push(name); continue; }
      if (M().OLD_NAME.test(name)) { try { if (await headTid(dir, name) === tid) out.push(name); } catch (e) { /* 读不了就跳过 */ } }
    }
    return out;
  }

  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
  }

  async function writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); // Chrome 先写临时文件，close 时整体替换，不会出现写了一半的文件
    await w.write(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    await w.close();
  }

  // 把被合并掉的文件移进 _重复备份/：优先 move()；不支持时先复制一份到备份里，确认写好了再移除原文件
  async function backup(dir, name) {
    const bdir = await dir.getDirectoryHandle(BACKUP, { create: true });
    let target = name, i = 1;
    while (await exists(bdir, target)) target = name.replace(/\.md$/, `.dup${i++}.md`);
    const h = await dir.getFileHandle(name);
    if (typeof h.move === 'function') {
      try { await h.move(bdir, target); return target; } catch (e) { /* 退回复制 */ }
    }
    const text = await (await h.getFile()).text();
    await writeText(bdir, target, text);
    if ((await (await bdir.getFileHandle(target)).getFile()).size !== new Blob([text]).size) throw new Error('备份核对失败，原文件保留：' + name);
    await dir.removeEntry(name);
    return target;
  }

  async function writeMerged(dir, { tid, fileName, markdown }) {
    tid = String(tid || '');
    const A = M();
    if (!/^\d+$/.test(tid)) throw new Error('帖子编号无效');
    const tn = A.T_NAME.exec(fileName || '');
    if (!tn || tn[1] !== tid || /[\\/]/.test(fileName)) throw new Error('文件名不符合 t 格式');
    if (typeof markdown !== 'string' || markdown.length > MAX) throw new Error('内容无效或过大');
    const incoming = A.parseFile(markdown);
    if (!incoming || incoming.fields.tid !== tid) throw new Error('写入内容不是这个帖子的存档');
    for (let attempt = 0; attempt < 3; attempt++) {
      const names = await candidates(dir, tid);
      const olds = [], stamps = new Map();
      for (const n of names) {
        const f = await fileOf(dir, n);
        if (f.size > MAX) throw new Error('已有存档超过 12 MB：' + n);
        stamps.set(n, f.lastModified);
        const text = await f.text();
        const p = A.parseFile(text);
        if (p && p.fields.tid === tid) olds.push({ name: n, p, text });
      }
      olds.sort((a, b) => A.timeKey(a.p.cap).localeCompare(A.timeKey(b.p.cap)));
      const merged = olds.length ? A.mergeVersions([...olds.map((o) => o.p), incoming])
        : { text: markdown, floors: A.totalFloors(incoming), edited: 0 };
      // 自检：楼层数、编辑历史数都不能比任何一个输入少
      const check = A.parseFile(merged.text);
      const maxFloors = Math.max(A.totalFloors(incoming), ...olds.map((o) => A.totalFloors(o.p)));
      const maxDetails = Math.max(A.countDetails(markdown), ...olds.map((o) => A.countDetails(o.text)));
      if (!check || A.totalFloors(check) < maxFloors || A.countDetails(merged.text) < maxDetails) {
        throw new Error('合并自检未通过，已放弃写入：' + fileName);
      }
      // 写入前复查：这期间被别的程序（比如另一个插件）改过，就重新合并
      let changed = false;
      for (const n of names) {
        try { if ((await fileOf(dir, n)).lastModified !== stamps.get(n)) changed = true; } catch (e) { changed = true; }
      }
      if (changed) continue;
      await writeText(dir, fileName, merged.text);
      const moved = [];
      for (const n of names) if (n !== fileName) { await backup(dir, n); moved.push(n); }
      return { ok: true, fileName, floors: merged.floors, edited: merged.edited, mergedFrom: names.length, moved };
    }
    throw new Error('存档文件一直在被其他程序修改，稍后再试');
  }

  // 索引：扫描整个文件夹里的 t 格式文件，不只列本插件采过的
  async function buildIndex(dir, watch) {
    const A = M();
    const w = new Set((watch || []).map(String));
    const rows = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !A.T_NAME.test(name)) continue;
      try {
        const s = await (await h.getFile()).slice(0, 1500).text();
        const g = (k) => ((new RegExp('^' + k + ':\\s*(.*)$', 'm')).exec(s) || [])[1] || '';
        let title = g('标题'); try { title = JSON.parse(title); } catch (e) { /* 原样 */ }
        rows.push({ name, title: String(title).replace(/\|/g, '｜'), tid: g('tid'), url: g('网址'), floors: g('已存楼数'), cap: g('采集时间') });
      } catch (e) { /* 跳过读不了的 */ }
    }
    rows.sort((a, b) => (a.name < b.name ? 1 : -1));
    const L = ['# My0511 论坛存档索引', '', `共 ${rows.length} 个帖子，索引更新于 ${A.bjNow()}（北京时间）。`, '',
      '| 首帖日期 | 标题 | 楼数 | 跟进 | 最后采集 | 原帖 |', '|---|---|---|---|---|---|'];
    for (const r of rows) L.push(`| ${r.name.slice(0, 10)} | [${r.title}](<${r.name}>) | ${r.floors} | ${w.has(r.tid) ? '是' : ''} | ${r.cap} | [打开](${r.url}) |`);
    await writeText(dir, INDEX, L.join('\n') + '\n');
    return rows.length;
  }

  // 取已选文件夹；interactive=true 时（面板里点按钮）可以弹授权
  async function folder(interactive) {
    const h = await root.FS.getHandle();
    if (!h) return { ok: false, noFolder: true };
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && interactive) perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return { ok: false, needPermission: true };
    return { ok: true, dir: h };
  }

  // 4.0：文件夹里每个帖子已经存到第几楼（楼号最大值）。浏览器里没记录的帖子（比如旧插件、别的电脑采的），
  // 也能从文件接着采，不用从第 1 页重来。
  async function knownFloors(dir, tids) {
    const want = new Set((tids || []).map(String).filter((t) => /^\d+$/.test(t)));
    const byTid = new Map();
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || name.startsWith('.') || name === INDEX) continue;
      const t = M().T_NAME.exec(name);
      let tid = t ? t[1] : null;
      if (!tid && M().OLD_NAME.test(name)) { try { tid = await headTid(dir, name); } catch (e) { tid = null; } }
      if (tid && want.has(tid)) (byTid.get(tid) || byTid.set(tid, []).get(tid)).push(name);
    }
    const out = {};
    for (const [tid, names] of byTid) {
      let max = 0;
      for (const n of names) {
        try {
          const text = await (await fileOf(dir, n)).text();
          for (const m of text.matchAll(/^### (\d+)楼 · /gm)) max = Math.max(max, Number(m[1]));
        } catch (e) { /* 跳过 */ }
      }
      if (max) out[tid] = max;
    }
    return out;
  }

  // 4.1：写二进制文件（图片），只允许写进 _图片/ 下，路径逐级创建
  async function writeBinary(dir, relPath, bytes) {
    const parts = String(relPath || '').split('/');
    if (parts[0] !== '_图片' || parts.length < 3 || parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error('图片路径无效');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return { ok: true, path: relPath };
  }

  root.ArchiveFolder = { writeMerged, buildIndex, folder, candidates, knownFloors, writeBinary };
})(typeof self !== 'undefined' ? self : this);
