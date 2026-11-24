// 4.3.0：机读存档（存档数据协议 v1）。
// 在存档文件夹里维护 _data/：逐帖 JSON、版本化清单 manifest.json、可补读的变更日志 journal/。
// 规则：Markdown 照旧是给人看的主存档；_data/ 里的内容全部从「刚写好的 Markdown」解析生成，二者一致。
// 发布顺序：Markdown → 逐帖 JSON → 日志 → 清单。清单是唯一的「就绪」信号：没进清单的版本，阅读器一律不当成就绪。
// 只有本插件写 _data/；本地阅读器（包括下游 Agent）只读。
(function (root) {
  'use strict';
  const FORMAT = 'my0511-archive-data', VERSION = 1;
  const DATA = '_data', THREADS = 'threads', JOURNAL = 'journal';
  const JOURNAL_MAX_BYTES = 2 * 1024 * 1024, JOURNAL_KEEP_FILES = 30;
  const A = () => root.ArchiveMerge;
  const enc = new TextEncoder();
  const sha256 = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s))).map((x) => x.toString(16).padStart(2, '0')).join('');
  const isoNow = () => new Date().toISOString();

  // 同一浏览器里面板、工作台、offscreen 都可能写，用 Web Locks 串行化；没有就退回进程内串行
  let chain = Promise.resolve();
  function locked(fn) {
    if (root.navigator && navigator.locks && navigator.locks.request) return navigator.locks.request('my0511-archive-data', fn);
    const next = chain.then(fn, fn); chain = next.catch(() => {}); return next;
  }

  async function sub(dir, name) { return dir.getDirectoryHandle(name, { create: true }); }
  async function readJson(dir, name) {
    try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch (e) { return null; }
  }
  // 4.4.1：关键文件（来源标识、清单）严格读取。以前任何读取错误都当成「文件不存在」，一次瞬时读错就会新建空清单、
  // 甚至换掉来源标识（11-02、11-14 清单丢条目、代数倒退的根因）。现在只有确实不存在才算 missing；
  // 读不出来就重试，仍失败就报错、不写；内容确实坏了才返回 corrupt。
  const isNotFound = (e) => /NotFound/i.test(String(e && (e.name + ' ' + e.message)));
  async function readJsonStrict(dir, name) {
    let last, badText = null;
    for (let i = 0; i < 6; i++) {
      let text;
      try { text = await (await (await dir.getFileHandle(name)).getFile()).text(); }
      catch (e) { if (isNotFound(e)) return { state: 'missing' }; last = e; await new Promise((r) => setTimeout(r, 200 * 2 ** i)); continue; }
      try { return { state: 'ok', value: JSON.parse(text) }; }
      catch (e) { last = e; badText = text; await new Promise((r) => setTimeout(r, 200 * 2 ** i)); }
    }
    if (badText != null) return { state: 'corrupt', text: badText, error: String(last && last.message || last) };
    const e = new Error('读不出 ' + name + '（' + String(last && (last.name + ': ' + last.message) || last) + '），本次不写机读数据，下次再试');
    e.readFailed = true; throw e;
  }
  // 从日志目录本身恢复日志状态（清单坏了时用）：文件列表、每个文件的首尾序号、最后的代数
  async function journalState(data) {
    let jdir; try { jdir = await data.getDirectoryHandle(JOURNAL); } catch (e) { return { files: [], lastSeq: 0, lastGen: 0 }; }
    const names = []; for await (const [n, h] of jdir.entries()) if (h.kind === 'file' && /^\d{6}\.jsonl$/.test(n)) names.push(n);
    names.sort();
    const files = []; let lastSeq = 0, lastGen = 0;
    for (const n of names) {
      const lines = (await (await (await jdir.getFileHandle(n)).getFile()).text()).trim().split('\n').filter(Boolean);
      let first = null, lastL = null;
      for (const l of lines) { try { const e = JSON.parse(l); if (first == null) first = e.seq; lastL = e; if (e.seq > lastSeq) lastSeq = e.seq; if (e.gen > lastGen) lastGen = e.gen; } catch (x) { /* 半行跳过 */ } }
      files.push({ name: n, firstSeq: first || 1, lastSeq: lastL ? lastL.seq : first || 1 });
    }
    return { files, lastSeq, lastGen };
  }
  // 4.3.1：macOS 上偶尔报「文件系统状态不允许修改」（InvalidStateError / NoModificationAllowedError），
  // 多半是同一文件上一笔写入的临时文件（.crswap）还没释放。等一会儿重试，不要整批失败。
  const transientFs = (e) => /InvalidState|NoModificationAllowed|state of the underlying|could not be modified|InUse/i.test(String((e && (e.name + ' ' + e.message)) || e));
  async function retryFs(fn) {
    let last;
    for (let i = 0; i < 6; i++) {
      try { return await fn(); } catch (e) { last = e; if (!transientFs(e)) throw e; await new Promise((r) => setTimeout(r, 300 * 2 ** i)); }
    }
    throw last;
  }
  async function writeText(dir, name, text, type = 'application/json') {
    return retryFs(async () => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); // 写临时文件，close 时整体替换：读者看不到写了一半的文件
      try { await w.write(new Blob([text], { type: type + ';charset=utf-8' })); await w.close(); }
      catch (e) { try { await w.abort(); } catch (x) { /* 已关闭 */ } throw e; }
    });
  }
  async function appendText(dir, name, text) {
    return retryFs(async () => {
      const fh = await dir.getFileHandle(name, { create: true });
      const size = (await fh.getFile()).size;
      const w = await fh.createWritable({ keepExistingData: true });
      try { await w.seek(size); await w.write(text); await w.close(); }
      catch (e) { try { await w.abort(); } catch (x) { /* 已关闭 */ } throw e; }
      return size + enc.encode(text).length;
    });
  }

  // 4.4.0：同一个存档文件夹只能由一个浏览器里的插件写机读数据（不同浏览器之间文件锁不共享，
  // 11 月 2 日就出现过两边同时写、清单互相覆盖丢条目）。写之前登记「写入方」，别人 3 分钟内写过就不写，报错提示。
  const LEASE_MS = 3 * 60000;
  // 4.4.5：清掉一小时以前留下的 Chrome 临时文件（*.crswap，写入失败时残留的空文件），半小时最多一次
  let lastSweepSwap = 0;
  async function cleanSwap(d) {
    if (Date.now() - lastSweepSwap < 30 * 60000) return; lastSweepSwap = Date.now();
    for (const dd of [d, await sub(d, JOURNAL)]) {
      const old = [];
      for await (const [n, h] of dd.entries()) if (h.kind === 'file' && /\.crswap$/.test(n)) { try { const f = await h.getFile(); if (Date.now() - f.lastModified > 3600000) old.push(n); } catch (e) { /* 跳过 */ } }
      for (const n of old) { try { await dd.removeEntry(n); } catch (e) { /* 删不掉就算了 */ } }
    }
  }
  async function claimWriter(data, instanceId) {
    if (!instanceId) return;
    const w = await readJson(data, 'writer.json');
    const now = Date.now();
    if (w && w.instanceId && w.instanceId !== instanceId && now - (w.at || 0) < LEASE_MS) {
      const e = new Error('另一个浏览器里的插件也在写这个存档文件夹，为避免互相覆盖，本次没有更新机读数据。请只在一个浏览器里开采集。');
      e.otherWriter = true; throw e;
    }
    // 4.4.5：1 分钟内续过租约就不再每次重写 writer.json
    if (!(w && w.instanceId === instanceId && now - (w.at || 0) < 60000)) await writeText(data, 'writer.json', JSON.stringify({ instanceId, at: now, note: '正在写机读数据的插件实例；3 分钟内有效' }));
    cleanSwap(data).catch(() => {});
  }

  async function source(data) {
    const r = await readJsonStrict(data, 'source.json');
    if (r.state === 'corrupt') throw new Error('source.json 内容损坏，为保留来源标识，不自动重建；请把 _data/source.json 的问题告诉维护者');
    let s = r.state === 'ok' ? r.value : null;
    if (s && (s.format !== FORMAT || !s.sourceId)) throw new Error('source.json 格式不对，不自动覆盖');
    if (!s) {
      s = { format: FORMAT, formatVersion: VERSION, sourceId: crypto.randomUUID(), createdAt: isoNow(),
        note: '本文件夹机读存档的来源标识。换浏览器、换电脑继续用同一个文件夹时不变。' };
      await writeText(data, 'source.json', JSON.stringify(s, null, 1));
    }
    return s;
  }
  async function loadManifest(data, src) {
    const r = await readJsonStrict(data, 'manifest.json');
    const m = r.state === 'ok' ? r.value : null;
    if (m && m.format === FORMAT && m.sourceId === src.sourceId && m.threads && typeof m.seq === 'number') return m;
    if (r.state === 'ok' && m && m.sourceId && m.sourceId !== src.sourceId) throw new Error('清单的来源标识和 source.json 不一致，不自动覆盖');
    // 确实没有清单，或清单内容损坏：从日志恢复序号和代数，坏清单先改名保留，再开新清单（之后自动重建补齐）
    const js = await journalState(data);
    if (r.state !== 'missing') {
      try { await writeText(data, 'manifest.corrupt-' + Date.now() + '.json', r.state === 'corrupt' ? r.text : JSON.stringify(m), 'text/plain'); } catch (e) { /* 留不下也继续 */ }
    }
    return { format: FORMAT, formatVersion: VERSION, sourceId: src.sourceId,
      generation: js.lastGen ? js.lastGen + 1 : 1, seq: js.lastSeq, coverage: 'partial',
      updatedAt: null, journal: { files: js.files, firstSeq: js.files[0] ? js.files[0].firstSeq : js.lastSeq + 1 }, threads: {},
      created: r.state === 'missing' && !js.lastSeq, recovered: r.state !== 'missing' || !!js.lastSeq };
  }

  // 防回退：浏览器记着这个来源发布过的最大序号（floorSeq）。清单的序号比它小，说明存档文件夹被旧备份覆盖过：
  // 换一代（generation+1）并从最大序号接着编号，序号永不倒退。
  function guardRollback(m, floorSeq) {
    if (floorSeq && m.seq < floorSeq) {
      m.generation = (m.generation || 1) + 1; m.seq = floorSeq; m.coverage = 'partial';
      return [{ seq: ++m.seq, gen: m.generation, at: isoNow(), type: 'rollback', note: '清单序号低于已发布的最大序号，判定为旧备份恢复，换代；请全量对账' }];
    }
    return [];
  }

  async function journalAppend(data, m, entries) {
    if (!entries.length) return;
    const jdir = await sub(data, JOURNAL);
    let files = (m.journal && m.journal.files) || [];
    let cur = files[files.length - 1];
    if (!cur) { cur = { name: String(1).padStart(6, '0') + '.jsonl', firstSeq: entries[0].seq }; files.push(cur); }
    const size = await appendText(jdir, cur.name, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    cur.lastSeq = entries[entries.length - 1].seq;
    if (size > JOURNAL_MAX_BYTES) {
      const n = Number(cur.name.slice(0, 6)) + 1;
      files.push({ name: String(n).padStart(6, '0') + '.jsonl', firstSeq: cur.lastSeq + 1 });
    }
    while (files.length > JOURNAL_KEEP_FILES) {
      const old = files.shift();
      try { await jdir.removeEntry(old.name); } catch (e) { /* 删不掉就留着，清单里已经不再引用 */ }
    }
    m.journal = { files, firstSeq: files[0] ? files[0].firstSeq : m.seq + 1 };
  }

  // ---------- Markdown → 逐帖 JSON ----------
  const FP = /^<!-- 指纹 sha256:([0-9a-f]{64})(?:\s*·\s*首次采集\s*(.*?))?\s*-->\s*$/m;
  const unquote = (t) => String(t || '').split('\n').map((l) => l.replace(/^> ?/, '')).join('\n');
  function floorFromParsed(f) {
    const header = f.header.replace(/^### /, '').replace(/\s*<a id="[^"]*"><\/a>\s*$/, '');
    const parts = header.split(' · ');
    const time = /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}/.test(parts[2] || '') ? parts[2] : null;
    let main = f.main;
    const fp = FP.exec(main);
    const hidden = /^> ⚠ 此楼在 (.*?) 采集时已不可见/m.exec(main);
    const quoteLine = (/^> ↩ (.*)$/m.exec(main) || [])[1] || null;
    const images = [...main.matchAll(/^> 图片存档：(.*)$/gm)].flatMap((m) => [...m[1].matchAll(/\(<([^>]+)>\)/g)].map((x) => x[1]));
    main = main.replace(FP, '').replace(/^> ⚠ 此楼在 .*$/gm, '').replace(/^> 图片存档：.*$/gm, '').replace(/^> ↩ .*$/gm, '').replace(/^\\#/gm, '#').replace(/^\s+|\s+$/g, '');
    return {
      floor: f.n, floorId: null, // 论坛楼层 ID（pid）目前不存进 Markdown，统一给 null（未知）
      author: parts[1] || null, time, timePrecision: time ? 'minute' : 'unknown',
      region: parts[3] || null, device: parts[4] || null,
      text: main === '（无文字）' ? '' : main, quote: quoteLine,
      hidden: !!hidden, hiddenSince: hidden ? hidden[1] : null,
      fingerprint: fp ? fp[1] : null, firstCapturedAt: fp && fp[2] ? fp[2] : null,
      images,
      edited: f.hist.length > 0, history: f.hist.map((h) => ({ when: h.when, text: unquote(h.text).replace(FP, '').replace(/^\s+|\s+$/g, '') })),
      latestNote: f.latestNote || null,
    };
  }
  function threadFromParsed(p, { fileName, capture, sourceId, revision, mdSha256 }) {
    const g = (k) => (p.fields[k] == null || p.fields[k] === '' ? null : p.fields[k]);
    let title = g('标题'); try { title = JSON.parse(title); } catch (e) { /* 原样 */ }
    const url = g('网址'); const fid = (/\/f(\d+)b-/.exec(url || '') || [])[1] || null;
    const floors = [...p.floors.values()].map(floorFromParsed).sort((a, b) => (a.floor ?? 1e12) - (b.floor ?? 1e12));
    const folded = [...p.appendix.matchAll(/^- \*\*(\d+)楼\*\* (.*?) · (.*?)：(.*?)(?: <a id="f\d+"><\/a>)?$/gm)].map((m) => ({ floor: Number(m[1]), author: m[2], time: m[3], text: m[4], folded: true }));
    const first = floors.find((f) => f.floor === 1);
    const created = g('首帖');
    return {
      format: FORMAT, formatVersion: VERSION, sourceId, tid: String(p.fields.tid), fid,
      title, url, board: g('版块'), category: g('分类'),
      author: first ? first.author : null, authorKnown: !!first,
      createdAt: created, createdAtPrecision: created && /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}$/.test(created) ? 'minute' : 'unknown',
      timezone: 'Asia/Shanghai',
      lastFloorAt: g('最后一楼'), views: g('查看') != null ? Number(g('查看')) : null, replies: g('回复') != null ? Number(g('回复')) : null,
      floorCount: floors.length + folded.length, editedFloors: floors.filter((f) => f.edited).map((f) => f.floor),
      hiddenFloors: floors.filter((f) => f.hidden).map((f) => f.floor),
      revision, mdFile: fileName, mdSha256,
      capturedAt: g('采集时间'), // 北京时间，分钟
      capture: capture || { known: false },
      floors, foldedFloors: folded,
    };
  }

  // 4.4.2：楼层核对信息。整帖从第 1 页采到最后一页成功时记 lastFull（当时论坛回复数、存到的最大楼号、差额、中间缺号数），
  // 之后的增量采集沿用上一次的 lastFull。存档体检据此判断「比论坛少的楼」是论坛删楼/不可见（已核对），还是真的没采全。
  function floorStats(rec) {
    const nums = [...rec.floors.map((f) => f.floor), ...rec.foldedFloors.map((f) => f.floor)].filter((n) => Number.isFinite(n));
    const maxFloor = nums.length ? Math.max(...nums) : 0; const have = new Set(nums);
    let holes = 0; for (let i = 1; i <= maxFloor; i++) if (!have.has(i)) holes++;
    const replies = Number.isFinite(rec.replies) ? rec.replies : null;
    return { maxFloor, holes, replies, gap: replies != null && replies + 1 > maxFloor ? replies + 1 - maxFloor : 0 };
  }

  // 4.4.6：逐帖 JSON 的实际内容是否和清单记录的校验值一致（写了 JSON、清单没写成时会不一致）
  async function jsonOk(tdir, tid, want) {
    if (!want) return false;
    try { return (await sha256(await (await (await tdir.getFileHandle(tid + '.json')).getFile()).text())) === want; } catch (e) { return false; }
  }

  // 正文 Markdown 已经写好之后调用：生成逐帖 JSON、记日志、更新清单（最后一步＝就绪）
  async function publish(dir, { tid, fileName, mdText, capture, floorSeqs, instanceId }) {
    return locked(async () => {
      const data = await sub(dir, DATA); const tdir = await sub(data, THREADS);
      await claimWriter(data, instanceId); const src = await source(data); const m = await loadManifest(data, src);
      const events = guardRollback(m, (floorSeqs || {})[src.sourceId]);
      const p = A().parseFile(mdText);
      if (!p || String(p.fields.tid) !== String(tid)) throw new Error('机读存档：Markdown 解析失败');
      const prev = m.threads[tid] || {};
      const mdSha256 = await sha256(mdText);
      const known = capture && capture.known !== false;
      // 4.4.5：正文没变、这次也不是一次有采集信息的读取（补写、手动导出）时什么都不写——
      // 以前补写几百个没变的帖子，每个都要重写一遍几 MB 的清单，插件会卡住好几分钟
      if (prev.mdSha256 === mdSha256 && prev.jsonSha256 && !known && !events.length && await jsonOk(tdir, String(tid), prev.jsonSha256)) {
        return { seq: m.seq, revision: prev.revision, generation: m.generation, sourceId: src.sourceId, coverage: m.coverage, rebuilding: !!m.rebuilding, unchanged: true };
      }
      const revision = prev.mdSha256 === mdSha256 && prev.revision ? prev.revision : (prev.revision || 0) + 1; // 正文没变不升版本
      const rec = threadFromParsed(p, { fileName, capture, sourceId: src.sourceId, revision, mdSha256 });
      rec.writtenAt = isoNow();
      const jsonText = JSON.stringify(rec);
      const jsonSha256 = await sha256(jsonText);
      await writeText(tdir, tid + '.json', jsonText);
      const seq = ++m.seq;
      const complete = capture && capture.known !== false ? !!capture.complete : null;
      await journalAppend(data, m, [...events,
        { seq, gen: m.generation, at: rec.writtenAt, type: 'thread', tid: String(tid), revision, mdFile: fileName, mdSha256, jsonSha256, complete }]);
      const fs = floorStats(rec);
      const lastFull = complete === true ? { at: rec.writtenAt, replies: fs.replies, maxFloor: fs.maxFloor, gap: fs.gap, holes: fs.holes } : (prev.lastFull || null);
      m.threads[tid] = { revision, seq, mdFile: fileName, mdSha256, jsonFile: `${THREADS}/${tid}.json`, jsonSha256,
        capturedAt: rec.capturedAt, writtenAt: rec.writtenAt, floorCount: rec.floorCount, maxFloor: fs.maxFloor, replies: fs.replies,
        complete, lastFull, lastFailure: prev.lastFailure || null }; // 4.4.5：采集详情只放逐帖 JSON，清单保持精简
      m.updatedAt = rec.writtenAt; delete m.created;
      await writeText(data, 'manifest.json', JSON.stringify(m));
      return { seq, revision, generation: m.generation, sourceId: src.sourceId, coverage: m.coverage, rebuilding: !!m.rebuilding };
    });
  }

  // 采集失败/跳过：不改帖子版本，只在清单里记下最近一次失败，并写日志
  async function recordFailure(dir, { tid, fid, reason, capture, floorSeqs, instanceId }) {
    return locked(async () => {
      const data = await sub(dir, DATA); await claimWriter(data, instanceId); const src = await source(data); const m = await loadManifest(data, src);
      const events = guardRollback(m, (floorSeqs || {})[src.sourceId]);
      const at = isoNow(); const seq = ++m.seq;
      const failure = { at, reason: String(reason || '').slice(0, 300) };
      await journalAppend(data, m, [...events, { seq, gen: m.generation, at, type: 'failed', tid: String(tid), fid: fid ? String(fid) : null, reason: failure.reason }]);
      m.threads[tid] = { ...(m.threads[tid] || { revision: 0, mdFile: null, jsonFile: null }), lastFailure: failure, seq };
      m.updatedAt = at; delete m.created;
      await writeText(data, 'manifest.json', JSON.stringify(m));
      return { seq, generation: m.generation, sourceId: src.sourceId };
    });
  }

  // 从文件夹现有的 Markdown 重建全部机读数据（首次启用、或怀疑不一致时）。分批做，每批返回下一批的起点。
  // 内容没变（Markdown 校验值相同）的帖子保留原版本号，阅读器不会把它们当成新内容。
  async function rebuildBatch(dir, { after = '', limit = 150, floorSeqs, instanceId } = {}) {
    return locked(async () => {
      const data = await sub(dir, DATA); const tdir = await sub(data, THREADS);
      await claimWriter(data, instanceId); const src = await source(data); const m = await loadManifest(data, src);
      const entries = guardRollback(m, (floorSeqs || {})[src.sourceId]);
      // 4.3.1：上次重建中途失败时，从断点接着做，不再换代、不从头来
      if (!after && m.rebuilding && m.rebuilding.next) after = m.rebuilding.next;
      else if (!after) { m.generation = (m.generation || 1) + (m.created ? 0 : 1); m.rebuilding = { startedAt: isoNow(), seen: {} };
        entries.push({ seq: ++m.seq, gen: m.generation, at: isoNow(), type: 'rebuild_start', note: '从 Markdown 重建机读数据；阅读器按校验值对账，内容没变的帖子版本号不变' }); }
      const names = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file' && A().T_NAME.test(name)) names.push(name);
      names.sort();
      const batch = names.filter((n) => n > after).slice(0, limit);
      for (const name of batch) {
        let text; try { text = await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { continue; }
        const p = A().parseFile(text); if (!p) { if (m.rebuilding) (m.rebuilding.bad = m.rebuilding.bad || {})[name] = 1; continue; }
        const tid = String(p.fields.tid); const prev = m.threads[tid] || {};
        if ((A().T_NAME.exec(name) || [])[1] !== tid) { if (m.rebuilding) (m.rebuilding.bad = m.rebuilding.bad || {})[name] = 1; continue; } // 文件名和内容的帖子号对不上：不收录，单独列出
        if (m.rebuilding) m.rebuilding.seen[tid] = 1;
        const mdSha256 = await sha256(text);
        if (prev.mdSha256 === mdSha256 && prev.mdFile === name && await jsonOk(tdir, tid, prev.jsonSha256)) continue; // 没变（4.4.6：JSON 也得对得上）
        const revision = (prev.revision || 0) + (prev.mdSha256 === mdSha256 ? 0 : 1) || 1;
        const rec = threadFromParsed(p, { fileName: name, capture: { known: false, source: 'rebuild' }, sourceId: src.sourceId, revision, mdSha256 });
        rec.writtenAt = isoNow();
        const jsonText = JSON.stringify(rec); const jsonSha256 = await sha256(jsonText);
        await writeText(tdir, tid + '.json', jsonText);
        const seq = ++m.seq;
        entries.push({ seq, gen: m.generation, at: rec.writtenAt, type: 'thread', tid, revision, mdFile: name, mdSha256, jsonSha256, complete: null, source: 'rebuild' });
        const fs = floorStats(rec);
        m.threads[tid] = { revision, seq, mdFile: name, mdSha256, jsonFile: `${THREADS}/${tid}.json`, jsonSha256, capturedAt: rec.capturedAt,
          writtenAt: rec.writtenAt, floorCount: rec.floorCount, maxFloor: fs.maxFloor, replies: fs.replies, complete: null,
          lastFull: prev.lastFull || null, lastFailure: prev.lastFailure || null };
      }
      const done = batch.length < limit;
      if (!done && m.rebuilding) m.rebuilding.next = batch[batch.length - 1];
      if (done) {
        // 4.4.1：缺失与否只看这次完整扫描到的文件名，不依赖重建过程中记的 seen（清单中途出问题时 seen 不完整，会误标）
        const present = new Map();
        for (const n of names) { const t = A().T_NAME.exec(n); if (t) present.set(t[1], n); }
        const bad = (m.rebuilding && m.rebuilding.bad) || {};
        for (const [tid, t] of Object.entries(m.threads)) {
          if (!t.mdFile) continue;
          if (present.has(tid)) { delete t.mdMissing; if (t.mdFile !== present.get(tid) && !bad[present.get(tid)]) t.mdFile = present.get(tid); }
          else t.mdMissing = true;
        }
        // 文件夹里有、清单里还没收录的帖子（不算解析不了的文件）：不宣布「全部」，下次自动接着补
        const notIndexed = [...present].filter(([tid, n]) => !bad[n] && !(m.threads[tid] && m.threads[tid].jsonSha256)).length;
        m.unparsable = Object.keys(bad).slice(0, 200);
        delete m.rebuilding; m.coverage = notIndexed ? 'partial' : 'full'; m.rebuiltAt = isoNow(); m.notIndexed = notIndexed;
        entries.push({ seq: ++m.seq, gen: m.generation, at: m.rebuiltAt, type: 'rebuild_done', threads: Object.keys(m.threads).length });
      }
      await journalAppend(data, m, entries);
      m.updatedAt = isoNow(); delete m.created;
      await writeText(data, 'manifest.json', JSON.stringify(m));
      return { done, next: batch.length ? batch[batch.length - 1] : after, processed: batch.length, total: names.length, seq: m.seq, generation: m.generation, sourceId: src.sourceId };
    });
  }

  async function status(dir) {
    let data; try { data = await dir.getDirectoryHandle(DATA); } catch (e) { return { ok: true, exists: false }; }
    const m = await readJson(data, 'manifest.json'); const s = await readJson(data, 'source.json');
    if (!m) return { ok: true, exists: false, sourceId: s && s.sourceId };
    let mdCount = 0; for await (const [name, h] of dir.entries()) if (h.kind === 'file' && A().T_NAME.test(name)) mdCount++;
    return { ok: true, exists: true, sourceId: m.sourceId, generation: m.generation, seq: m.seq, coverage: m.coverage,
      threads: Object.keys(m.threads || {}).length, withMd: Object.values(m.threads || {}).filter((t) => t.mdFile && !t.mdMissing).length, mdCount, updatedAt: m.updatedAt, rebuiltAt: m.rebuiltAt || null, rebuilding: !!m.rebuilding };
  }

  root.ArchiveData = { FORMAT, VERSION, publish, recordFailure, rebuildBatch, status, threadFromParsed, sha256 };
})(typeof self !== 'undefined' ? self : globalThis);
