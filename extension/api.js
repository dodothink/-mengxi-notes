// My0511 插件接口 v1（4.0.0 起）。给「扩展模块」（addons/）用，例如带 Agent 版的本地服务桥接。
// 规则：
//  - 扩展模块只通过 self.My0511API 调用插件功能，不改插件核心文件。
//  - 扩展模块自己的数据存在 addon: 开头的键里（用 My0511API.store）。
//  - 存档文件夹只由插件写入；扩展模块和本地服务都不写。
//  - 发帖只有两条路：fillReply（只填入，不发表）和 postOnce（必须带确认函数，一次，不补发）。
// 详细说明见 docs/接口说明.md。接口有不兼容改动时 version 的主版本号加 1。
const My0511API = (() => {
  'use strict';
  const version = '1.2';
  const listeners = new Map();
  function on(event, fn) {
    if (typeof fn !== 'function') throw new Error('监听函数无效');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, data) {
    for (const fn of listeners.get(event) || []) { try { Promise.resolve(fn(data)).catch(() => {}); } catch (e) { /* 扩展模块出错不影响插件 */ } }
  }
  // 用存储变化产生事件，不在核心流程里插钩子
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) {
      if (k.startsWith('t:')) {
        const tid = k.slice(2), o = c.oldValue || {}, n = c.newValue || {};
        emit('threadUpdated', { tid, floors: (n.floors || []).length });
        // 4.2：revision＝这次写入时间（同一帖子单调递增）；capturedAt＝写入的内容对应的最后采集时间。收到 capturedAt ≥ 提醒时间，说明提醒对应的版本已写进存档
        if (n.exportedAt && n.exportedAt !== o.exportedAt) emit('archiveWritten', { tid, fileName: n.thread?.fileName || null, floors: (n.floors || []).length, revision: n.exportedAt, capturedAt: n.updatedAt || null });
      } else if (k === 'job') {
        const n = c.newValue, o = c.oldValue;
        if (n && n.state === 'done' && (!o || o.state !== 'done' || o.id !== n.id)) emit('jobDone', { tid: String(n.tid), skipped: n.skipped || null });
      } else if (k === 'humanChallenge') {
        emit('challenge', c.newValue || null);
      } else if (k === 'haltPost') {
        emit(c.newValue ? 'postHalted' : 'postResumed', {});
      } else if (k === 'haltCollect') {
        emit(c.newValue ? 'collectHalted' : 'collectResumed', {});
      } else if (k === 'alerts') {
        const old = new Set((c.oldValue || []).map((x) => x.id));
        for (const a of (c.newValue || []).filter((x) => !old.has(x.id)).reverse()) emit('alert', a);
      } else if (k === 'postQueue') {
        emit('postQueueChanged', { size: (c.newValue || []).length });
      }
    }
  });
  const ns = (k) => { if (!/^[\w.-]{1,80}$/.test(k)) throw new Error('键名无效'); return 'addon:' + k; };
  const store = {
    get: async (k, d = null) => Safety.read(ns(k), d),
    set: async (k, v) => Safety.write(ns(k), v),
    update: async (k, fn, d = null) => Safety.update(ns(k), fn, d),
  };
  return Object.freeze({
    version, on, store,
    // 运行状态与控制
    status: () => Control.status(),
    pause: (scope = 'all') => Control.pause(scope, true),
    resume: (scope = 'all') => Control.pause(scope, false),
    // 采集与浏览器记录
    getThread: async (tid) => Safety.read('t:' + String(tid), null),
    listThreads: async () => {
      const all = await chrome.storage.local.get(null);
      return Object.keys(all).filter((k) => k.startsWith('t:')).map((k) => ({
        tid: all[k].thread?.tid, fid: all[k].thread?.fid, title: all[k].thread?.title, url: all[k].thread?.url,
        fileName: all[k].thread?.fileName || null, floors: (all[k].floors || []).length,
        updatedAt: all[k].updatedAt || null, exportedAt: all[k].exportedAt || null, watch: !!all[k].watch,
      }));
    },
    enqueue: (threads) => enqueueThreads(threads).then((q) => ({ ok: true, size: q.length })),
    // 存档（插件负责写；这里只是触发和查询）
    writeArchive: async (tid) => { const rec = await Safety.read('t:' + String(tid), null); if (!rec) throw new Error('浏览器里没有这个帖子'); return { ok: !!(await autoExport(rec)) }; },
    knownFloors: (tids) => fileKnownFloors((tids || []).map(String)),
    archiveStatus: () => archiveStatus(),
    // 人工验证：答案必须来自真人（例如手机上的你），插件只负责填进原页面
    challenge: () => Safety.read('humanChallenge', null),
    refreshChallenge: async () => { await Challenge.refresh(); return Safety.read('humanChallenge', null); },
    answerChallenge: (p) => Challenge.answer(p),
    verifyChallenge: (id) => Control.verifyChallenge(id),
    // 提醒（4.1）
    alerts: () => Alerts.list(),
    // 4.2 可恢复消费：alertsSince 按 seq 从旧到新读取；ackAlerts 记录消费方处理到哪里（不等于已读）
    alertsSince: (opts) => Alerts.since(opts || {}),
    ackAlerts: (opts) => Alerts.ack(opts || {}),
    markAlertsRead: (ids) => Alerts.markRead(ids || null),
    settings: async () => { const s = await Alerts.settings(); return { myName: s.myName, watchUsers: [...s.watchUsers], keywords: s.keywords, imageUsers: [...s.imageUsers] }; },
    // 发帖
    fillReply: (d) => Control.fillReply(d),
    postOnce: (task, guard) => Poster.postOnce(task, guard),
  });
})();
self.My0511API = My0511API;
