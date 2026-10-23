// 存档文件夹：句柄存在 IndexedDB 里，跨会话保留；写不进去时退回「下载」文件夹
(function (root) {
  'use strict';
  const DB = 'my0511';
  const STORE = 'handles';

  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idb(mode, fn) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  const getHandle = () => idb('readonly', (s) => s.get('dir'));
  const setHandle = (h) => idb('readwrite', (s) => s.put(h, 'dir'));
  const clearHandle = () => idb('readwrite', (s) => s.delete('dir'));

  async function handleState() {
    const h = await getHandle();
    if (!h) return { has: false };
    const perm = await h.queryPermission({ mode: 'readwrite' });
    return { has: true, name: h.name, perm };
  }

  // 返回 { where: 'folder'|'downloads', name }
  async function writeFile(fileName, text) {
    const h = await getHandle();
    if (h) {
      let perm = await h.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const fh = await h.getFileHandle(fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        await w.close();
        return { where: 'folder', name: h.name };
      }
    }
    const url = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
    await chrome.downloads.download({
      url,
      filename: 'My0511存档/' + fileName,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    return { where: 'downloads', name: 'My0511存档' };
  }

  root.FS = { getHandle, setHandle, clearHandle, handleState, writeFile };
})(self);
