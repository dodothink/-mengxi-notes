// 4.1 提醒：有人回复我、关注的楼被改/被删、关键词出现。存在 alerts 列表里（最多 300 条），同时弹系统通知。
// 只提醒最近 3 天内发的楼，避免第一次整帖采集时把多年前的旧楼全报一遍。
const Alerts = (() => {
  'use strict';
  const MAX = 300, RECENT_MS = 3 * 86400000, PER_BATCH = 12;
  // 4.2 可恢复消费：每条提醒有递增的 seq。至少保留最近 300 条；有消费方登记过确认位置时，
  // 未确认的提醒额外保留，最多 2000 条、30 天。
  const HARD_MAX = 2000, KEEP_UNACKED_MS = 30 * 86400000;
  const BASE_URL = 'https://bbs.my0511.com';
  const LABEL = { reply: '有人回复你', edit: '关注的楼被修改', hidden: '关注的楼不见了', keyword: '关键词出现' };

  async function settings() {
    const s = await chrome.storage.local.get(['watchUsers', 'keywords', 'myName', 'imageUsers', 'postCfg']);
    return {
      myName: String(s.myName || s.postCfg?.myName || '').trim(),
      watchUsers: new Set((s.watchUsers || []).map(String)),
      keywords: (s.keywords || []).map(String).filter(Boolean),
      imageUsers: new Set((s.imageUsers || []).map(String)),
    };
  }
  // 论坛时间（北京时间）→ 毫秒
  function forumMs(t) {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(t || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600000 : 0;
  }
  const recent = (f) => Date.now() - forumMs(f.time) < RECENT_MS;
  function floorUrl(thread, floor) {
    const page = Math.max(1, Math.ceil((floor || 1) / 50));
    return `${BASE_URL}/f${thread.fid}b-t${thread.tid}z-${page}`;
  }
  const snip = (s, n = 80) => String(s || '').replace(/@@Q\|([^|]*)\|[^|]*\|[^@]*@@/g, '（引用 $1）').replace(/\s+/g, ' ').trim().slice(0, n);

  async function add(items) {
    if (!items.length) return;
    const now = Date.now();
    let full = [];
    await Safety.update('alertSeq', (seq) => { full = items.map((x, i) => ({ id: Safety.id(), seq: seq + i + 1, at: now, read: false, ...x })); return seq + items.length; }, 0);
    const acks = await Safety.read('alertAcks', {});
    const minAck = Object.values(acks).length ? Math.min(...Object.values(acks).map((v) => v.cursor || 0)) : null;
    await Safety.update('alerts', (a) => {
      const all = [...full.slice().reverse(), ...(a || [])];
      return all.filter((x, i) => i < MAX || (minAck != null && (x.seq || 0) > minAck && now - x.at < KEEP_UNACKED_MS && i < HARD_MAX));
    }, []);
    for (const x of full.slice(0, 5)) {
      try {
        await chrome.notifications.create('alert:' + x.id, {
          type: 'basic', iconUrl: 'icons/icon128.png', priority: 1,
          title: `${LABEL[x.kind] || '提醒'} · ${String(x.title || '').slice(0, 30)}`,
          message: x.message.slice(0, 180),
        });
      } catch (e) { /* 通知失败不影响记录 */ }
    }
    if (full.length > 5) {
      try { await chrome.notifications.create('alert:more:' + now, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'My0511 提醒', message: `另有 ${full.length - 5} 条提醒，在工作台查看。` }); } catch (e) { /* 忽略 */ }
    }
  }

  // 采集合并时调用：新楼（回复我、关键词）和改过的楼（关注的帖子或关注的 ID）
  async function onMerge(rec, fresh, edited) {
    const s = await settings();
    const t = rec.thread || {};
    const out = [];
    for (const f of fresh) {
      if (!recent(f)) continue;
      if (s.myName && f.author !== s.myName) {
        const quoted = new RegExp('@@Q\\|' + s.myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\|').test(f.text || '');
        if (quoted || (f.text || '').includes('@' + s.myName)) {
          out.push({ kind: 'reply', tid: String(t.tid), floor: f.floor, author: f.author, title: t.title, url: floorUrl(t, f.floor),
            message: `${f.author} 在 ${f.floor} 楼${quoted ? '引用了你' : '提到了你'}：${snip(f.text)}` });
          continue;
        }
      }
      const hit = s.keywords.find((k) => (f.text || '').includes(k));
      if (hit) out.push({ kind: 'keyword', keyword: hit, tid: String(t.tid), floor: f.floor, author: f.author, title: t.title, url: floorUrl(t, f.floor),
        message: `「${hit}」· ${f.author} 在 ${f.floor} 楼：${snip(f.text)}` });
    }
    for (const { f, old } of edited) {
      if (!(rec.watch || s.watchUsers.has(f.author))) continue;
      out.push({ kind: 'edit', tid: String(t.tid), floor: f.floor, author: f.author, title: t.title, url: floorUrl(t, f.floor),
        message: `${f.author} 改了 ${f.floor} 楼。原来：${snip(old, 60)} → 现在：${snip(f.text, 60)}` });
    }
    await add(out.slice(0, PER_BATCH));
  }
  async function onHidden(rec, floors) {
    const s = await settings();
    const t = rec.thread || {};
    const out = floors.filter((f) => rec.watch || s.watchUsers.has(f.author)).map((f) => ({
      kind: 'hidden', tid: String(t.tid), floor: f.floor, author: f.author, title: t.title, url: floorUrl(t, f.floor),
      message: `${f.author} 的 ${f.floor} 楼重新采集时已不可见（原文已保留）：${snip(f.text)}`,
    }));
    await add(out.slice(0, PER_BATCH));
  }
  // 巡查时新帖标题里出现关键词（每个帖子只提醒一次）
  async function onBoardRows(rows) {
    const s = await settings();
    if (!s.keywords.length) return;
    const seen = new Set(await Safety.read('kwSeen', []));
    const out = [];
    for (const r of rows) {
      if (seen.has(String(r.tid))) continue;
      const hit = s.keywords.find((k) => String(r.title || '').includes(k));
      if (!hit) continue;
      seen.add(String(r.tid));
      out.push({ kind: 'keyword', keyword: hit, tid: String(r.tid), floor: 1, title: r.title, url: `${BASE_URL}/f${r.fid}b-t${r.tid}z`, message: `「${hit}」出现在新帖标题：${r.title}` });
    }
    await Safety.write('kwSeen', [...seen].slice(-2000));
    await add(out.slice(0, PER_BATCH));
  }

  chrome.notifications?.onClicked?.addListener(async (nid) => {
    if (!nid.startsWith('alert:')) return;
    const id = nid.slice(6);
    const list = await Safety.read('alerts', []);
    const x = list.find((a) => a.id === id);
    if (x && x.url) { await chrome.tabs.create({ url: x.url }); await markRead([id]); }
    else chrome.tabs.create({ url: chrome.runtime.getURL('control.html') });
    chrome.notifications.clear(nid);
  });

  async function list() { return Safety.read('alerts', []); }
  async function markRead(ids) { const set = ids ? new Set(ids) : null; await Safety.update('alerts', (a) => (a || []).map((x) => (!set || set.has(x.id) ? { ...x, read: true } : x)), []); }
  async function clear() { await Safety.write('alerts', []); }
  // 4.2：按 seq 顺序读取 cursor 之后的提醒（从旧到新）。truncated=true 表示 cursor 之后有提醒已被清理，中间有缺口。
  async function since({ cursor = 0, limit = 100 } = {}) {
    cursor = Math.max(0, Number(cursor) || 0); limit = Math.max(1, Math.min(500, Number(limit) || 100));
    const all = (await Safety.read('alerts', [])).filter((x) => x.seq).sort((a, b) => a.seq - b.seq);
    const after = all.filter((x) => x.seq > cursor);
    const items = after.slice(0, limit);
    const oldest = all.length ? all[0].seq : null;
    const latest = await Safety.read('alertSeq', 0);
    return { items, nextCursor: items.length ? items[items.length - 1].seq : Math.max(cursor, cursor < latest && !after.length ? latest : cursor), truncated: oldest != null ? oldest > cursor + 1 : latest > cursor, latest };
  }
  // 4.2：消费方确认处理到哪个 seq（和用户的「已读」无关）
  async function ack({ consumer, cursor }) {
    if (!/^[\w.-]{1,40}$/.test(String(consumer || ''))) throw new Error('消费方名称无效');
    const c = Math.max(0, Number(cursor) || 0);
    await Safety.update('alertAcks', (v) => ({ ...(v || {}), [consumer]: { cursor: Math.max(c, v?.[consumer]?.cursor || 0), at: Date.now() } }), {});
    return { ok: true };
  }
  return { settings, onMerge, onHidden, onBoardRows, add, list, markRead, clear, forumMs, since, ack };
})();
