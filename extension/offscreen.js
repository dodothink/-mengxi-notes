// 只做一件事：把 HTML 文本解析成结构化数据（service worker 里没有 DOM）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'PARSE') return;
  try {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    if (msg.kind === 'list') {
      sendResponse({ ok: true, threads: self.MY0511.parseThreadLinks(doc) });
    } else if (msg.kind === 'board') {
      sendResponse({ ok: true, rows: self.MY0511.parseBoardRows(doc) });
    } else {
      sendResponse({ ok: true, meta: self.MY0511.parseMeta(doc, msg.tid, msg.page), floors: self.MY0511.parseFloors(doc) });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e.message || e) });
  }
  return true;
});

// 4.0：后台自动写存档。offscreen 是页面环境，能用已授权的文件夹句柄；没授权时不弹窗，只回报。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || !['ARCHIVE_WRITE', 'ARCHIVE_INDEX', 'ARCHIVE_KNOWN', 'ARCHIVE_BINARY', 'ARCHIVE_STATUS'].includes(msg.type)) return;
  (async () => {
    if (msg.type === 'ARCHIVE_STATUS') { const s = await self.FS.handleState(); return { ok: true, has: !!s.has, name: s.name || null, perm: s.perm || null }; }
    const f = await self.ArchiveFolder.folder(false);
    if (!f.ok) return f;
    if (msg.type === 'ARCHIVE_WRITE') return self.ArchiveFolder.writeMerged(f.dir, msg);
    if (msg.type === 'ARCHIVE_BINARY') { const bin = atob(msg.b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return self.ArchiveFolder.writeBinary(f.dir, msg.path, bytes); }
    if (msg.type === 'ARCHIVE_KNOWN') return { ok: true, known: await self.ArchiveFolder.knownFloors(f.dir, msg.tids) };
    return { ok: true, count: await self.ArchiveFolder.buildIndex(f.dir, msg.watch) };
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
