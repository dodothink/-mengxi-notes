// 4.1 工作台工具：提醒、提醒与存图设置、存档全文搜索、按 ID 补采、存档体检、核对取证指纹。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const A = self.ArchiveMerge;
  const LABEL = { reply: '回复你', edit: '改楼', hidden: '删楼/不可见', keyword: '关键词' };
  const TIME = /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}/;
  async function send(m) { const r = await chrome.runtime.sendMessage(m); if (!r?.ok) throw new Error(r?.error || '后台没有响应'); return r; }
  function note(el, t) { $(el).textContent = t; }
  async function guard(el, fn) { try { await fn(); } catch (e) { note(el, e.message || String(e)); } }
  const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
  function el(tag, text, attrs) { const e = document.createElement(tag); if (text != null) e.textContent = text; Object.assign(e, attrs || {}); return e; }
  const fmt = (ms) => new Date(ms).toLocaleString();

  // ---------- 提醒 ----------
  async function showAlerts() {
    const r = await send({ type: 'ALERTS_LIST' });
    const box = $('alerts'); box.replaceChildren();
    if (!r.alerts.length) { box.append(el('p', '暂无提醒', { className: 'muted' })); return; }
    for (const a of r.alerts.slice(0, 100)) {
      const art = el('article');
      art.append(el('strong', `${a.read ? '' : '【新】'}${LABEL[a.kind] || a.kind} · ${fmt(a.at)}`));
      art.append(el('p', `${a.title || ''}\n${a.message}`));
      if (a.url) { const l = el('a', '打开原帖', { href: a.url, target: '_blank' }); l.onclick = () => send({ type: 'ALERTS_READ', ids: [a.id] }).then(showAlerts); art.append(l); }
      box.append(art);
    }
  }
  $('alertsRead').onclick = () => guard('toolsNote', async () => { await send({ type: 'ALERTS_READ' }); await showAlerts(); });
  $('alertsClear').onclick = () => guard('toolsNote', async () => { if (!confirm('清空全部提醒？')) return; await send({ type: 'ALERTS_CLEAR' }); await showAlerts(); });

  // ---------- 设置 ----------
  async function loadSettings() {
    const s = await send({ type: 'GET_SETTINGS' });
    $('myName').value = s.myName; $('watchUsers').value = s.watchUsers.join('\n'); $('keywords').value = s.keywords.join('\n'); $('imageUsers').value = s.imageUsers.join('\n');
  }
  $('saveTools').onclick = () => guard('toolsNote', async () => {
    await send({ type: 'SET', key: 'myName', value: $('myName').value });
    for (const k of ['watchUsers', 'keywords', 'imageUsers']) await send({ type: 'SET', key: k, value: lines(k) });
    note('toolsNote', '已保存。');
    await loadSettings();
  });

  // ---------- 读存档文件夹（带缓存） ----------
  const cache = new Map();
  async function folder() {
    const f = await ArchiveFolder.folder(true);
    if (f.noFolder) throw new Error('还没有选存档文件夹：到插件「设置」里选。');
    if (!f.ok) throw new Error('存档文件夹没有授权。');
    return f.dir;
  }
  async function loadAll(dir, progress) {
    const out = []; let i = 0;
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !(A.T_NAME.test(name) || A.OLD_NAME.test(name))) continue;
      const file = await h.getFile();
      let c = cache.get(name);
      if (!c || c.lm !== file.lastModified) { const text = await file.text(); c = { lm: file.lastModified, p: A.parseFile(text), size: file.size }; cache.set(name, c); }
      out.push({ name, p: c.p });
      if (++i % 200 === 0 && progress) progress(i);
    }
    return out;
  }
  function headerInfo(header) {
    const parts = header.replace(/ <a id="f[^"]*"><\/a>\s*$/, '').split(' · ');
    const n = (/^### (\d+)楼/.exec(parts[0]) || [])[1];
    const rest = parts.slice(1), ti = rest.findIndex((p) => TIME.test(p));
    return { floor: n ? +n : null, author: ti > 0 ? rest.slice(0, ti).join(' · ') : (rest[0] || ''), time: ti >= 0 ? rest[ti] : '' };
  }
  const dayKey = (t) => { const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t || ''); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
  function floorUrl(p, floor) { const m = /\/f(\d+)b-t(\d+)z/.exec(p.fields['网址'] || ''); return m ? `https://bbs.my0511.com/f${m[1]}b-t${m[2]}z-${Math.max(1, Math.ceil((floor || 1) / 50))}` : ''; }
  function title(p) { let t = p.fields['标题'] || ''; try { t = JSON.parse(t); } catch (e) { /* 原样 */ } return t; }

  // ---------- 全文搜索 ----------
  $('search').onclick = () => guard('searchNote', async () => {
    const author = $('qAuthor').value.trim(), text = $('qText').value.trim(), from = $('qFrom').value, to = $('qTo').value;
    if (!author && !text) throw new Error('作者和关键词至少填一个。');
    const dir = await folder();
    note('searchNote', '正在读取存档……');
    const all = await loadAll(dir, (i) => note('searchNote', `正在读取存档……已读 ${i} 份`));
    const hits = [];
    const lower = text.toLowerCase();
    for (const { name, p } of all) {
      if (!p) continue;
      for (const f of p.floors.values()) {
        const h = headerInfo(f.header);
        if (author && h.author !== author) continue;
        const d = dayKey(h.time);
        if (from && d && d < from) continue;
        if (to && d && d > to) continue;
        const body = f.main.replace(/^<!-- 指纹.*-->$/gm, '').replace(/^> 图片存档：.*$/gm, '').trim();
        let idx = 0;
        if (text) { idx = body.toLowerCase().indexOf(lower); if (idx < 0) continue; }
        hits.push({ name, t: title(p), ...h, url: floorUrl(p, h.floor), snippet: body.slice(Math.max(0, idx - 40), idx + 120).replace(/\s+/g, ' ') });
      }
    }
    hits.sort((a, b) => (A.timeKey(b.time) || '').localeCompare(A.timeKey(a.time) || ''));
    const box = $('results'); box.replaceChildren();
    for (const x of hits.slice(0, 300)) {
      const art = el('article');
      art.append(el('strong', `${x.t} · ${x.floor}楼 · ${x.author} · ${x.time}`));
      art.append(el('p', x.snippet));
      if (x.url) art.append(el('a', '打开原帖', { href: x.url, target: '_blank' }));
      box.append(art);
    }
    note('searchNote', `共 ${all.length} 份存档，找到 ${hits.length} 处${hits.length > 300 ? '，只显示最新 300 处' : ''}。`);
  });

  // ---------- 按 ID 补采 ----------
  $('openUid').onclick = () => guard('uidNote', async () => {
    const v = $('uidName').value.trim();
    if (!v) throw new Error('填一个 ID 或论坛编号。');
    let uid = /^\d+$/.test(v) ? v : (await send({ type: 'FIND_UID', name: v })).uid;
    if (!uid) throw new Error('已存的楼层里找不到这个 ID 的论坛编号。可以在论坛点开他的资料页，地址里 uid= 后面的数字就是编号，填进来即可。');
    const url = `https://bbs.my0511.com/search.php?srchuid=${uid}&srchfid=all&srchfrom=0&searchsubmit=yes`;
    await chrome.tabs.create({ url });
    note('uidNote', `已打开编号 ${uid} 的发帖搜索页。页面出来后点插件图标，勾选要采的帖子，点「采集选中的帖子」。已存过的会从存到的地方接着采。\n如果这个地址打不开，改用他的资料页：https://bbs.my0511.com/viewpro.php?uid=${uid}`);
  });

  // ---------- 存档体检 ----------
  let lastCheck = null;
  $('check').onclick = () => guard('checkOut', async () => {
    const dir = await folder();
    note('checkOut', '正在检查……');
    const all = await loadAll(dir, (i) => note('checkOut', `正在检查……已读 ${i} 份`));
    const byTid = new Map(), broken = [], gaps = [];
    for (const { name, p } of all) {
      if (!p) { broken.push(name); continue; }
      const tid = p.fields.tid;
      (byTid.get(tid) || byTid.set(tid, []).get(tid)).push({ name, p });
    }
    const dups = [...byTid.entries()].filter(([, v]) => v.length > 1);
    for (const [tid, v] of byTid) {
      const p = v.map((x) => x.p).sort((a, b) => A.timeKey(a.cap).localeCompare(A.timeKey(b.cap))).pop();
      const nums = [...p.floors.values()].map((f) => f.n).filter((n) => n != null);
      const max = Math.max(0, ...nums), have = new Set(nums);
      let missing = 0; for (let i = 1; i <= max; i++) if (!have.has(i)) missing++;
      const replies = Number(p.fields['回复']);
      const behind = Number.isFinite(replies) && replies + 1 > max ? replies + 1 - max : 0;
      if (missing || behind) {
        const m = /\/f(\d+)b-t(\d+)z/.exec(p.fields['网址'] || '');
        if (m) gaps.push({ tid, fid: m[1], title: title(p), missing, behind });
      }
    }
    lastCheck = { dups, gaps };
    const out = [`共 ${all.length} 份文件，${byTid.size} 个帖子。`,
      `重复文件：${dups.length} 个帖子有多份文件${dups.length ? '（' + dups.slice(0, 10).map(([t]) => t).join('、') + (dups.length > 10 ? ' …' : '') + '）' : ''}`,
      `无法解析的文件：${broken.length} 份${broken.length ? '\n  ' + broken.slice(0, 20).join('\n  ') : ''}`,
      `缺楼：${gaps.filter((g) => g.missing).length} 个帖子中间有缺楼；${gaps.filter((g) => g.behind).length} 个帖子比论坛显示的楼数少（可能是论坛删楼，也可能是没采全）。`];
    note('checkOut', out.join('\n'));
    $('fixDup').hidden = !dups.length; $('fixGap').hidden = !gaps.length;
  });
  $('fixDup').onclick = () => guard('checkOut', async () => {
    if (!lastCheck) return;
    const dir = await folder();
    let n = 0;
    for (const [tid, v] of lastCheck.dups) {
      const newest = v.slice().sort((a, b) => A.timeKey(a.p.cap).localeCompare(A.timeKey(b.p.cap))).pop();
      const text = await (await (await dir.getFileHandle(newest.name)).getFile()).text();
      const fileName = A.T_NAME.test(newest.name) ? newest.name
        : MD.fileNameFor({ tid, title: title(newest.p) }, [{ floor: 1, time: newest.p.fields['首帖'] || '' }]);
      await ArchiveFolder.writeMerged(dir, { tid, fileName, markdown: text });
      n++;
    }
    note('checkOut', `已合并 ${n} 个帖子的重复文件，多余的移到了 _重复备份/。`);
    $('fixDup').hidden = true; cache.clear();
  });
  $('fixGap').onclick = () => guard('checkOut', async () => {
    if (!lastCheck) return;
    if (!confirm(`把 ${lastCheck.gaps.length} 个帖子加进采集队列，从第 1 页整帖重采？帖子多时要花不少时间。`)) return;
    const threads = lastCheck.gaps.slice(0, 500).map((g) => ({ tid: g.tid, fid: g.fid, title: g.title, full: true }));
    const r = await send({ type: 'ENQUEUE', threads });
    note('checkOut', `已加入队列，队列里现在有 ${r.size} 个帖子。采集要在面板里处于「恢复采集」状态才会开始。`);
    $('fixGap').hidden = true;
  });

  // ---------- 核对取证指纹 ----------
  $('fpCheck').onclick = () => guard('fpOut', async () => {
    const tid = $('fpTid').value.trim();
    if (!/^\d+$/.test(tid)) throw new Error('请填帖子编号（数字）。');
    const dir = await folder();
    const names = await ArchiveFolder.candidates(dir, tid);
    if (!names.length) throw new Error('存档文件夹里没有这个帖子。');
    const outLines = [];
    for (const name of names) {
      const p = A.parseFile(await (await (await dir.getFileHandle(name)).getFile()).text());
      if (!p) { outLines.push(`${name}：无法解析`); continue; }
      let ok = 0, bad = [], none = 0;
      for (const f of p.floors.values()) {
        const fp = A.fpOf(f.main);
        if (!fp) { none++; continue; }
        if ((await A.fingerprintMd(f.main)) === fp) ok++; else bad.push(f.n);
      }
      outLines.push(`${name}\n  一致 ${ok} 层；不一致 ${bad.length} 层${bad.length ? '（' + bad.join('、') + ' 楼）' : ''}；没有指纹 ${none} 层（4.1 之前采的楼，重新采集后补上）。`);
    }
    note('fpOut', outLines.join('\n'));
  });

  showAlerts().catch(() => {});
  loadSettings().catch(() => {});
  chrome.storage.onChanged.addListener((c) => { if (c.alerts) showAlerts().catch(() => {}); });
})();
