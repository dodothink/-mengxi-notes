// 后台：用你已登录的身份逐页取回帖子，交给 offscreen 解析，结果存本地
// 支持队列（批量采集）和定时跟进
importScripts('md.js', 'fs.js', 'archive-merge.js');

const BASE = 'https://bbs.my0511.com';
const MIN_GAP = 3000, MAX_GAP = 6000, PER_PAGE = 50;
const WATCH_MINUTES = 60;
// 论坛的 WAF 在短时间内连续请求过多页时会返回 503（每次都在跑了 20~30 页左右触发），
// 之前遇到 503/网络错误就直接把整个任务判死、需要手动重新点采集才会继续——
// 而立刻重新点等于立刻又请求一次，马上又撞回限流，于是长期卡在同一楼层。
// 现在改成：单页失败先退避重试几次；仍然不行就把任务放进「冷却」，
// 后台每分钟的定时器会在冷却结束后自动续采，不用人守着。
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 8000; // 8s, 16s, 32s, 64s, 128s
const ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 冷却 5 分钟后自动恢复
// 巡查板块列表：读 1~2 页「百姓话题」列表（每页约 50 个主题），跟本地存档比回复数，
// 就能知道哪些帖子是新出现的、哪些帖子有新回复——不用像人工那样逐帖打开检查，
// 省下大量请求，也不容易撞到上面说的限流。
const DEFAULT_SWEEP_FID = '152'; // 百姓话题板块
const DEFAULT_SWEEP_PAGES = 2;
const SWEEP_MINUTES = 15;
const FAIL_RETRY_MS = 24 * 60 * 60 * 1000; // 帖子被判「没权限」后，一天内巡查不会再自动重新排它
let running = false;   // 正在逐页采集/跟进
let sweeping = false;  // 正在巡查板块列表

const key = (tid) => 't:' + tid;
async function get(k, d) { const o = await chrome.storage.local.get(k); return o[k] === undefined ? d : o[k]; }
const set = (k, v) => chrome.storage.local.set({ [k]: v });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「全部停止」总开关：存在本地，浏览器重启后也保持停止状态
// 3.4.0：采集和发帖各有一个独立的停止开关，互不影响。
// haltCollect＝停止采集（含巡查、跟进、队列），haltPost＝停止定时发帖（poster.js 里读）。
const isHalted = async () => { await Safety.ready; return (await get('haltCollect', false)) || (await Safety.blocked()); };

// 一次性迁移：旧版只有一个「全部停止」(halted)，现在只把它当成「停止采集」，发帖不受影响；
// 同时按要求把采集的自动功能（板块巡查、自动跟进）默认关掉，需要时再手动打开。
(async () => {
  await Safety.ready;
  const o = await chrome.storage.local.get(['halted', 'migr340']);
  if (o.halted !== undefined) {
    await chrome.storage.local.set({ haltCollect: true, haltPost: true });
    await chrome.storage.local.remove('halted');
  }
  if (!o.migr340) {
    await chrome.storage.local.set({ sweepEnabled: false, watchEnabled: false, migr340: true });
  }
})();

async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: '解析论坛页面的 HTML',
    });
  }
}

// 按页面实际编码解码：先看响应头 charset，再看 HTML 里的 <meta charset>，都没有才默认 GBK。
// 帖子页是 GBK，但防火墙的验证页等是 UTF-8，写死 GBK 会把后者解成乱码。
function decodeHtml(buf, contentType) {
  let cs = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096)));
    cs = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
  }
  cs = (cs || 'gbk').toLowerCase();
  if (cs === 'gb2312') cs = 'gbk';
  try { return new TextDecoder(cs).decode(buf); }
  catch (e) { return new TextDecoder('gbk').decode(buf); }
}

// 试读一页版块列表：能正常看到帖子列表，就说明验证/登录已经处理好，解除「等待人工」
async function clearChallengeIfForumOk() {
  const c = await get('humanChallenge', null);
  if (!c) return true;
  let html = '', res;
  try {
    res = await fetch(BASE + '/f152b', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    html = decodeHtml(await res.arrayBuffer(), res.headers.get('content-type'));
  } catch (e) { throw new Error('连不上论坛（' + (e.message || e) + '），检查网络或 VPN 后再点恢复。'); }
  const path = new URL(res.url || BASE).pathname;
  if (path === '/captcha' || isChallengePage(html)) throw new Error('论坛还在要求做算术题。请在 Edge 里打开梦溪论坛，把验证做完，再点「▶ 恢复采集」。');
  if (/需要登录后才能浏览|请先登录/.test(html)) throw new Error('论坛要求登录。请在 Edge 里登录梦溪论坛，再点「▶ 恢复采集」。');
  if (!/list_dl|outer-section|consnav/.test(html)) throw new Error('论坛页面不正常，暂时不恢复。稍后再试。');
  await Safety.update('humanChallenge', cur => (cur && cur.id === c.id ? null : cur), null);
  await Safety.event('challenge_cleared', { challengeId: c.id, by: 'resume_check' });
  return true;
}

function isChallengePage(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  if (/安全验证|人机验证|访问验证|Just a moment/i.test(title)) return true;
  const normal = /class=["'][^"']*\bouter-section\b|id=["']consnav["']|class=["'][^"']*\blist_dl\b/.test(html);
  return !normal && /<(?:input|iframe)[^>]*(?:seccode|secqaa|captcha|challenge)/i.test(html);
}

// 论坛「提示信息」页：面包屑是「梦溪论坛 » 提示信息」，正文一句话。注意页脚「官方QQ群」链接带 #pid，不能拿 pid 判断是不是正常帖子页。返回那句话；不是提示页返回空串。
function forumNotice(html) {
  if (!/(»|&raquo;)\s*提示信息/.test(html) || /outer-section|postmessage_\d+/.test(html)) return '';
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/提示信息\s+(?:梦溪论坛\s+提示信息\s+)?([^\[]{2,80}?)\s*\[/);
  return m ? m[1].trim() : '提示信息';
}

function isTransientError(e) {
  if (!e) return false;
  if (e.status === 429 || (e.status >= 500 && e.status < 600)) return true;
  return e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError' || /Failed to fetch|NetworkError|network|timed? ?out|超时|断网/i.test(String(e.message || ''));
}

async function fetchHtml(url, purpose = 'collect') {
  url = Safety.forumUrl(url);
  await Safety.assertRunnable(purpose);
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(25000) });
  const html = decodeHtml(await res.arrayBuffer(), res.headers.get('content-type'));
  if (new URL(res.url || url).pathname === '/captcha' || isChallengePage(html) || /需要登录后才能浏览/.test(html)) {
    const login = /需要登录后才能浏览/.test(html);
    await Safety.challenge({ source: 'fetch', kind: login ? 'login' : 'captcha', url: res.url || url, stage: 'before_submit', reason: login ? '请在浏览器登录论坛' : '论坛要求人工验证' });
    throw Object.assign(new Error(login ? '等待人工登录' : '等待人工验证'), { challenge: true, needLogin: login });
  }
  if (!res.ok) throw Object.assign(new Error('页面返回 ' + res.status), { status: res.status });
  if (/您无权进行当前操作/.test(html)) throw Object.assign(new Error('没有权限查看这一页，已跳过'), { permanent: true, noPermission: true });
  // 4.2.2：论坛的「提示信息」页（如老帖 t730753 返回「未定义操作，请返回」），换任何地址都一样，
  // 是帖子本身坏了/被删了，不是临时故障——直接记下论坛原话跳过，不再反复重试。
  const notice = forumNotice(html);
  if (notice) throw Object.assign(new Error('论坛提示「' + notice + '」，这个帖子打不开，已跳过'), { permanent: true, forumNotice: true });
  return html;
}

async function parse(kind, html, tid, page) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PARSE', kind, html, tid, page });
  if (!r || !r.ok) throw new Error((r && r.error) || '解析失败');
  if (kind === 'thread' && (!r.floors?.length || r.floors.some(f => f.floor == null && !f.pid))) throw new Error('页面缺少有效楼层，未写入存档');
  return r;
}

async function fetchPage(fid, tid, page) {
  return parse('thread', await fetchHtml(`${BASE}/f${fid}b-t${tid}z-${page}`), tid, page);
}

// 带退避重试地抓一页：503/网络抖动等临时性错误重试，需要登录这种没必要重试的直接抛出
async function fetchPageWithRetry(fid, tid, page, onRetry) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && (await isHalted())) { const h = new Error('已全部停止'); h.halted = true; throw h; }
    try {
      return await fetchPage(fid, tid, page);
    } catch (e) {
      lastErr = e;
      if (e && e.permanent) throw e; // 需要登录/没权限这类，重试也没用
      if (e && e.challenge) throw e; // 被安全验证拦了，马上重试只会继续被拦，直接进冷却
      if (attempt < MAX_RETRIES) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        if (onRetry) await onRetry(e, attempt + 1, wait);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

async function mergeIntoStore(tid, meta, floors, url, fid) {
  const fresh = [], edited = []; // 4.1：给提醒用
  const merged = await Safety.update(key(tid), async existing => {
  const rec = existing || { floors: [], thread: {} };
  rec.thread = Object.assign({}, rec.thread, meta, { tid, fid, url });
  delete rec.failReason; // 这次成功读到了，之前记的「没权限/需要登录」跳过原因就作废了
  delete rec.failedAt;
  const by = new Map(rec.floors.map((f) => [f.floor != null ? 'n' + f.floor : 'p' + f.pid, f]));
  // 3.5.0：楼层内容变了不再直接覆盖——旧内容连同采集时间存进 history，一个版本都不丢。
  // 论坛自带的「本帖最后由 xx 于 时间 编辑」也单独记下来（editedAt）。
  const now = Date.now();
  const EDIT_RE = /本帖最后由\s*(.+?)\s*于\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*编辑/;
  const norm = (t) => String(t || '').replace(EDIT_RE, '').replace(/\s+/g, '');
  for (const f of floors) {
    const k = f.floor != null ? 'n' + f.floor : 'p' + f.pid;
    const em = EDIT_RE.exec(f.text || '');
    if (em) f.editedAt = em[2];
    const old = by.get(k);
    if (!old) {
      f.capturedAt = now; f.lastSeenAt = now;
      fresh.push(f);
    } else {
      f.history = Array.isArray(old.history) ? old.history.slice() : [];
      if (norm(old.text) !== norm(f.text)) {
        f.history.push({ text: old.text || '', capturedAt: old.capturedAt || rec.updatedAt || null,
          lastSeenAt: old.lastSeenAt || old.capturedAt || rec.updatedAt || null, editedAt: old.editedAt || null,
          ...(old.fp ? { fp: old.fp } : {}) });
        f.capturedAt = now;
        f.changedAt = now;
        edited.push({ f, old: old.text || '' });
      } else {
        f.capturedAt = old.capturedAt || rec.updatedAt || now;
        if (old.changedAt) f.changedAt = old.changedAt;
      }
      f.lastSeenAt = now;
      delete f.hiddenAt; // 4.0：又出现了，取消「不可见」标记
      if (!f.history.length) delete f.history;
      if (old.images && !f.images) f.images = old.images; // 已存的图片路径保留
      if (old.fp && norm(old.text) === norm(f.text)) f.fp = old.fp;
    }
    // 4.1 取证指纹：正文规范化后的 SHA-256
    if (!f.fp) { try { f.fp = await ArchiveMerge.fingerprintRaw(f.text || ''); } catch (e) { /* 算不了就不写 */ } }
    by.set(k, f);
  }
  rec.floors = [...by.values()].sort((a, b) => (a.floor || 0) - (b.floor || 0));
  rec.updatedAt = Date.now();
  return rec;
  }, null);
  try { await Alerts.onMerge(merged, fresh, edited); } catch (e) { /* 提醒失败不影响采集 */ }
  return merged;
}

// 工具栏图标上的角标：光看面板才知道「有没有在跑」不太直观，
// 这里在角标颜色/文字上也带一份——绿色实心点＝正在采集或巡查，蓝色数字＝有几楼新内容在等，
// 都没有就是空闲，角标清空。鼠标悬停在图标上的提示文字同步给出中文说法。
// 4.2.2：角标里的「新楼数」要扫全部帖子记录（2000+ 个、几十 MB）。以前每采一页就全扫一遍，
// 这是插件变慢的主要原因之一。现在最多每分钟扫一次，其余时候用上次的结果。
let badgeCache = { n: 0, at: 0 };
async function newFloorsTotal() {
  if (Date.now() - badgeCache.at < 60000) return badgeCache.n;
  const all = await chrome.storage.local.get(null);
  let n = 0;
  for (const k of Object.keys(all)) if (k.startsWith('t:') && all[k].newFloors) n += all[k].newFloors;
  badgeCache = { n, at: Date.now() };
  return n;
}
async function setBadge() {
  const n = await newFloorsTotal();
  const hc = await isHalted(), hp = await get('haltPost', false);
  if (hc && hp) {
    await chrome.action.setBadgeText({ text: '停' });
    await chrome.action.setBadgeBackgroundColor({ color: '#777777' });
    await chrome.action.setTitle({ title: 'My0511 帖子存档（采集、发帖都已停止）' });
    return;
  }
  if (await get('folderAuthNeeded', false)) {
    await chrome.action.setBadgeText({ text: '授' });
    await chrome.action.setBadgeBackgroundColor({ color: '#cc6600' });
    await chrome.action.setTitle({ title: 'My0511 帖子存档（存档文件夹需要重新授权：点开面板，点「存档位置」）' });
    return;
  }
  const stopNote = hc ? '，采集已停止' : hp ? '，发帖已停止' : '';
  const active = running || sweeping;
  // Chrome 不能调角标字号，只能少放字：角标最多两个字，免得把图标上的「梦溪」挡住。
  // 1~99 照常显示；100 以上显示成「3百」「1千」这样；准确数字在鼠标悬停提示里。
  const short = (x) => (x < 100 ? String(x) : x < 1000 ? Math.floor(x / 100) + '百' : x < 10000 ? Math.floor(x / 1000) + '千' : '万+');
  const text = n ? short(n) : (active ? '●' : '');
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: active ? '#2e8b57' : '#336699' });
  await chrome.action.setTitle({
    title: 'My0511 帖子存档' + (active ? '（运行中' : n ? `（有 ${n} 楼新内容` : '（空闲') + stopNote + '）',
  });
}

// 纯插件版：清掉旧版留下的本地服务同步定时器
chrome.alarms.clear('agent-sync').catch?.(() => {});

// 4.0：已存到第几楼 = 浏览器记录和存档文件夹里文件的较大值。
// 只有选了存档文件夹且已授权时才看文件：那时写入会和已有文件合并，从中间页接着采不会丢前面的楼层。
// 没选文件夹（整份写到「下载」）时只看浏览器记录，避免写出只有后半截的文件。
async function fileKnownFloors(tids) {
  if (!tids.length || !(await get('useFolder', false))) return {};
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ARCHIVE_KNOWN', tids: tids.map(String) });
    return r && r.ok ? r.known || {} : {};
  } catch (e) { return {}; }
}
const storeKnown = (rec) => (rec?.floors || []).reduce((m, f) => Math.max(m, f.floor || 0), 0);

// 把一批帖子加进采集队列（面板批量采集和 4.0 接口共用）。已存的从存到的那页接着采。
async function enqueueThreads(threads) {
  if (!Array.isArray(threads) || threads.length > 500) throw new Error('队列输入无效');
  const fileKnown = await fileKnownFloors(threads.map((t) => String(t.tid)).filter((t) => /^\d+$/.test(t)));
  const q = await Safety.update('queue', async q => { const have = new Set(q.map(x => String(x.tid))); for (const t of threads) {
    if (!/^\d+$/.test(String(t.tid)) || !/^\d+$/.test(String(t.fid))) throw new Error('帖子编号无效');
    if (have.has(String(t.tid))) continue; have.add(String(t.tid));
    const rec = await get(key(t.tid), null);
    const known = Math.max(storeKnown(rec), fileKnown[String(t.tid)] || 0);
    q.push({tid:String(t.tid),fid:String(t.fid),title:String(t.title || '').slice(0,200),from:t.full?1:Math.max(1,Math.ceil(known/PER_PAGE))});
  } return q; }, []);
  runJob();
  return q;
}

// 4.1 图片存档（默认关）：只对在面板里开了「存图」的帖子、或设置里「存图的 ID」发的楼，
// 把论坛自己服务器上的图片存进存档文件夹的 _图片/<tid>/，文件里记相对路径。需要选了存档文件夹。
const IMG_MAX = 10 * 1024 * 1024;
async function saveImages(tid) {
  if (!(await get('useFolder', false))) return 0;
  const rec = await get(key(tid), null);
  if (!rec) return 0;
  const s = await Alerts.settings();
  const todo = rec.floors.filter((f) => f.imageUrls && f.imageUrls.length && !(f.images && f.images.length >= f.imageUrls.length)
    && (rec.saveImages || s.imageUsers.has(f.author)));
  if (!todo.length) return 0;
  await ensureOffscreen();
  const saved = new Map();
  let n = 0;
  for (const f of todo) {
    const paths = [];
    for (let i = 0; i < f.imageUrls.length; i++) {
      if (await isHalted()) break;
      const url = f.imageUrls[i];
      try {
        const u = new URL(url);
        if (!/(^|\.)my0511\.com$/.test(u.hostname)) continue; // 只存论坛自己服务器上的图
        const r = await fetch(url, { credentials: 'include' });
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !/^image\//.test(type)) continue;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!buf.length || buf.length > IMG_MAX) continue;
        const ext = (/image\/(jpe?g|png|gif|webp|bmp)/.exec(type) || [, 'jpg'])[1].replace('jpeg', 'jpg');
        const path = `_图片/${tid}/${f.floor}-${i + 1}.${ext}`;
        let bin = ''; for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(j, j + 0x8000));
        const w = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ARCHIVE_BINARY', path, b64: btoa(bin) });
        if (w && w.ok) { paths.push(path); n++; }
      } catch (e) { /* 单张失败跳过 */ }
      await sleep(800 + Math.random() * 700);
    }
    if (paths.length) saved.set(f.floor, paths);
  }
  if (saved.size) await Safety.update(key(tid), (r) => { if (!r) return r; for (const f of r.floors) if (saved.has(f.floor)) f.images = saved.get(f.floor); return r; }, null);
  return n;
}

// 4.2：存档写入状态（给接口和界面用；不暴露绝对路径和文件句柄）
async function archiveStatus() {
  const useFolder = await get('useFolder', false);
  const all = await chrome.storage.local.get(null);
  const pending = Object.keys(all).filter((k) => k.startsWith('t:') && all[k]?.floors?.length && (all[k].exportedAt || 0) < (all[k].updatedAt || 0)).length;
  let directoryName = null, permission = null;
  if (useFolder) {
    try { await ensureOffscreen(); const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ARCHIVE_STATUS' }); if (r?.ok) { directoryName = r.name; permission = r.has ? r.perm : null; } } catch (e) { /* 读不到就留空 */ }
  }
  const err = all.lastExportError || null;
  return { mode: useFolder ? 'folder' : 'downloads', directoryName, permission, pendingWrites: pending, folderAuthNeeded: !!all.folderAuthNeeded,
    lastWriteError: err ? { tid: err.tid, error: err.error, at: err.at } : null };
}

// 4.0：整帖从第 1 页重采完成后，这次没再出现的楼层标记为「不可见」（原文保留，不删）
async function markHidden(tid, startedAt) {
  if (!startedAt) return;
  const gone = [];
  const rec2 = await Safety.update(key(tid), rec => {
    if (!rec || !Array.isArray(rec.floors)) return rec;
    const now = Date.now();
    for (const f of rec.floors) if (!f.hiddenAt && (f.lastSeenAt || 0) < startedAt) { f.hiddenAt = now; gone.push(f); }
    return rec;
  }, null);
  if (rec2 && gone.length) { try { await Alerts.onHidden(rec2, gone); } catch (e) { /* 忽略 */ } }
}

// 4.0：选了存档文件夹时，由 offscreen 页面在文件夹里按 tid 合并写入（不需要本地服务）：
// 同一个帖子只留一个文件，楼层取并集，编辑历史不丢，另一个插件写的内容也会合并进来。
// 文件夹授权失效时不写、不退回「下载」（「下载」会整份覆盖，冲掉合并结果），
// 记下待写，等在面板里重新授权后补写。
async function folderWrite(rec) {
  const md = MD.buildThread(rec.thread, rec.floors, { foldFiller: await get('foldFiller', false) });
  const fileName = MD.fileNameFor(rec.thread, rec.floors);
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ARCHIVE_WRITE', tid: String(rec.thread.tid), fileName, markdown: md });
  if (!r || !r.ok) {
    const e = new Error((r && r.error) || (r && r.needPermission ? '存档文件夹需要重新授权' : '写入失败'));
    e.needPermission = !!(r && r.needPermission); e.noFolder = !!(r && r.noFolder);
    throw e;
  }
  return r.fileName;
}

async function autoExport(rec) {
  let fileName;
  let useFolder = await get('useFolder', false);
  if (useFolder && !(await FS.getHandle().catch(() => null))) { useFolder = false; await set('useFolder', false); }
  if (useFolder) {
    try {
      fileName = await folderWrite(rec);
      await set('folderAuthNeeded', false);
      await chrome.storage.local.remove('lastExportError');
    } catch (e) {
      if (e.needPermission) {
        await set('folderAuthNeeded', true);
        await chrome.action.setBadgeText({ text: '授' }).catch(() => {});
        await chrome.action.setTitle({ title: 'My0511 帖子存档（存档文件夹需要重新授权：点开面板，点「存档位置」）' }).catch(() => {});
      } else {
        await set('lastExportError', { tid: String(rec.thread.tid), error: String(e.message || e), at: Date.now() });
      }
      return null; // 没写成：exportedAt 不更新，之后补写
    }
  } else {
    // 没选文件夹：插件读不到已有文件，只能按旧办法整份写到「下载 / My0511存档」，不做合并
    const md = MD.buildThread(rec.thread, rec.floors, { foldFiller: await get('foldFiller', false) });
    fileName = MD.fileNameFor(rec.thread, rec.floors);
    await chrome.downloads.download({
      url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md),
      filename: 'My0511存档/' + fileName, conflictAction: 'overwrite', saveAs: false,
    });
  }
  await Safety.update(key(rec.thread.tid), current => ({ ...current, thread:{...current.thread,fileName}, exportedAt:Date.now(),newFloors:0 }), rec);
  await writeIndex();
  return fileName;
}

// 授权恢复后，把「采到了但还没写进文件」的帖子补写一遍
async function flushExports() {
  if (!(await get('useFolder', false))) return 0;
  const all = await chrome.storage.local.get(null);
  let n = 0;
  for (const k of Object.keys(all)) {
    const r = all[k];
    if (!k.startsWith('t:') || !r || !r.floors || !r.floors.length) continue;
    if ((r.exportedAt || 0) >= (r.updatedAt || 0)) continue;
    if (await autoExport(r)) n++; else if (await get('folderAuthNeeded', false)) break;
  }
  await setBadge();
  return n;
}

async function writeIndex() {
  if (await get('useFolder', false)) {
    // 选了文件夹：30 秒后扫描整个文件夹重建索引，期间多次导出只重建一次
    // 4.2.2：重建索引要扫描整个存档文件夹（2000+ 个文件）。以前每个帖子采完 30 秒就扫一遍，
    // 连续采集时几乎不停在扫。现在 5 分钟内只扫一次，采集进行中再往后推。
    const a = await chrome.alarms.get('archive-index');
    if (!a) chrome.alarms.create('archive-index', { delayInMinutes: 5 });
    return;
  }
  const all = await chrome.storage.local.get(null);
  const list = Object.keys(all).filter((k) => k.startsWith('t:')).map((k) => ({
    title: all[k].thread.title, url: all[k].thread.url, fileName: all[k].thread.fileName,
    floorCount: all[k].floors.length, exportedAt: all[k].exportedAt || all[k].updatedAt, watch: all[k].watch,
  }));
  await chrome.downloads.download({
    url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(MD.buildIndex(list)),
    filename: 'My0511存档/My0511存档索引.md', conflictAction: 'overwrite', saveAs: false,
  });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'archive-index') return;
  if (running || sweeping) { chrome.alarms.create('archive-index', { delayInMinutes: 5 }); return; }
  try {
    const all = await chrome.storage.local.get(null);
    const watch = Object.keys(all).filter((k) => k.startsWith('t:') && all[k].watch).map((k) => String(all[k].thread.tid));
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ARCHIVE_INDEX', watch });
  } catch (e) { /* 下次导出再试 */ }
});

// ===== 4.2.3：导出 / 导入队列和设置（换电脑、清浏览器都不怕）=====
// 只导出「状态」：待采队列、当前未完成的帖子、定时发帖队列和规则、各项设置、自动跟进名单、跳过记录。
// 帖子正文不在里面——正文已经在存档文件夹的 Markdown 里，新电脑选同一个文件夹就能接着用。
const BACKUP_SETTING_KEYS = ['sweepEnabled','sweepPages','sweepRange','sweepFid','watchEnabled','useFolder','foldFiller','myName','watchUsers','keywords','imageUsers','postCfg'];
async function exportBackup() {
  const all = await chrome.storage.local.get(null);
  const settings = {};
  for (const k of BACKUP_SETTING_KEYS) if (k in all) settings[k] = all[k];
  const queue = Array.isArray(all.queue) ? [...all.queue] : [];
  const job = all.job;
  if (job && job.tid && ['running','error','waiting_human','stopped'].includes(job.state) && !queue.some(x => String(x.tid) === String(job.tid)))
    queue.unshift({ tid: String(job.tid), fid: String(job.fid), title: job.title || '', from: Math.max(1, job.page || 1) });
  const watch = [], skipped = [];
  for (const k of Object.keys(all)) {
    if (!k.startsWith('t:')) continue;
    const r = all[k], t = r.thread || {};
    if (r.watch) watch.push({ tid: String(t.tid || k.slice(2)), fid: String(t.fid || ''), title: t.title || '' });
    if (r.failReason) skipped.push({ tid: String(t.tid || k.slice(2)), fid: String(t.fid || ''), reason: r.failReason, at: r.failedAt || 0 });
  }
  const posts = (Array.isArray(all.postQueue) ? all.postQueue : []).filter(x => x && x.status !== 'done');
  return { format: 'my0511-backup', version: 1, exportedAt: Date.now(), build: chrome.runtime.getManifest?.().version || '',
    settings, queue, postQueue: posts, watch, skipped };
}
function asBackup(data) {
  if (!data || typeof data !== 'object') throw new Error('不是有效的备份文件');
  if (data.format === 'my0511-backup') return data;
  // 兼容工作台「备份浏览器数据」导出的整份数据
  if ('queue' in data || 'postQueue' in data || 'safety380' in data) {
    const settings = {}; for (const k of BACKUP_SETTING_KEYS) if (k in data) settings[k] = data[k];
    const watch = [], skipped = [];
    for (const k of Object.keys(data)) if (k.startsWith('t:')) {
      const r = data[k] || {}, t = r.thread || {};
      if (r.watch) watch.push({ tid: String(t.tid || k.slice(2)), fid: String(t.fid || ''), title: t.title || '' });
      if (r.failReason) skipped.push({ tid: String(t.tid || k.slice(2)), fid: String(t.fid || ''), reason: r.failReason, at: r.failedAt || 0 });
    }
    return { format: 'my0511-backup', version: 1, settings, queue: data.queue || [], postQueue: (data.postQueue || []).filter(x => x && x.status !== 'done'), watch, skipped };
  }
  throw new Error('不是 My0511 的备份文件');
}
const okTid = (v) => /^\d{1,10}$/.test(String(v));
async function importBackup(raw) {
  const b = asBackup(raw);
  const settings = b.settings && typeof b.settings === 'object' ? b.settings : {};
  const setObj = {};
  for (const k of BACKUP_SETTING_KEYS) if (k in settings) setObj[k] = settings[k];
  if (Object.keys(setObj).length) await chrome.storage.local.set(setObj);
  // 待采队列：合并去重，已在队列里的不重复加
  const incoming = (Array.isArray(b.queue) ? b.queue : []).filter(x => x && okTid(x.tid) && okTid(x.fid || 0));
  let added = 0;
  await Safety.update('queue', q => {
    const have = new Set(q.map(x => String(x.tid)));
    for (const x of incoming) { const tid = String(x.tid); if (have.has(tid)) continue; have.add(tid);
      q.push({ tid, fid: String(x.fid), title: String(x.title || '').slice(0, 200), from: Math.max(1, Number(x.from) || 1) }); added++; }
    return q;
  }, []);
  // 自动跟进名单、跳过记录：只补标记，不碰已有正文
  let watched = 0, skipped = 0;
  for (const w of (Array.isArray(b.watch) ? b.watch : [])) {
    if (!okTid(w.tid)) continue;
    await Safety.update(key(w.tid), r => { r = r || { floors: [], thread: { tid: String(w.tid), fid: String(w.fid || ''), title: w.title || '' } }; r.watch = true; return r; }, null);
    watched++;
  }
  for (const x of (Array.isArray(b.skipped) ? b.skipped : [])) {
    if (!okTid(x.tid)) continue;
    await Safety.update(key(x.tid), r => { r = r || { floors: [], thread: { tid: String(x.tid), fid: String(x.fid || '') } }; if (!r.failReason) { r.failReason = String(x.reason || '').slice(0, 300); r.failedAt = x.at || Date.now(); } return r; }, null);
    skipped++;
  }
  // 定时发帖：一律以「暂缓」导入，不会在新电脑上一导入就立刻发出去，需要你逐条确认后点「重新排队」
  let posts = 0;
  const pin = (Array.isArray(b.postQueue) ? b.postQueue : []).filter(x => x && x.id && typeof x.message === 'string');
  if (pin.length) {
    const cur = await get('postQueue', []);
    const ids = new Set(cur.map(x => x.id));
    for (const p of pin) { if (ids.has(p.id)) continue; cur.push({ ...p, status: 'held', plannedAt: null, note: '从备份导入，请确认后点「重新排队」' }); posts++; }
    await set('postQueue', cur);
  }
  await set('haltCollect', true);
  await setBadge();
  return { added, queued: (await get('queue', [])).length, watched, skipped, posts, settings: Object.keys(setObj).length };
}

async function nextFromQueue() {
  return Safety.serial('collect-transition', async () => {
    if (await isHalted()) return false;
    let found = false;
    await Safety.update('queue', async q => {
      if (!q.length || (await get('job', null))?.state === 'running') return q;
      const item = q[0], rec = await get(key(item.tid), null);
      const startPage = Math.max(1, item.from || 1);
      await Safety.update('job', j => j?.state === 'running' ? j : {
        id: Safety.id(), state: 'running', tid:item.tid, fid:item.fid, url:`${BASE}/f${item.fid}b-t${item.tid}z`, title:item.title || '',
        page:startPage,startPage,lastPage:startPage,toEnd:true,auto:true,floorCount:rec?.floors.length || 0,startedAt:Date.now()
      }, null);
      found = true; return q.slice(1);
    }, []);
    return found;
  });
}

async function runJob() {
  if (running || sweeping) return;
  running = true;
  try { if (await isHalted()) { running = false; return; } await setBadge(); } catch (e) { running = false; throw e; }
  let consecutiveNeedLogin = 0; // 连续遇到「需要登录」才当真——单个帖子偶尔一次更可能是别的权限问题
  try {
    while (true) {
      if (await isHalted()) break; // 点了「全部停止」
      let cur = await get('job', null);

      // 之前失败进入冷却的任务：冷却时间到了就自动复活重试，不用手动点
      if (cur && cur.state === 'error') {
        const waited = Date.now() - (cur.errorAt || 0);
        if (waited < ERROR_COOLDOWN_MS) break; // 还没到点，等下一次定时器再看
        cur.state = 'running';
        cur.error = '冷却结束，自动重试第 ' + cur.page + ' 页';
        await Safety.update('job', old => old?.id === cur.id && old.state === 'error' ? cur : old, null);
      }

      if (!cur || cur.state !== 'running') {
        if (!(await nextFromQueue())) break;
        cur = await get('job', null);
      }
      if (cur.page > cur.lastPage) {
        const rec = await get(key(cur.tid), null);
        // 采完了就自动导出一次 Markdown——以前只有排队/自动跟进触发的任务才会这样，
        // 手动点「采集整帖」「只取新增楼层」采完了却不会自动写文件，得自己记得再点一次
        // 「导出 Markdown」。像老法海那个 2700+ 楼的大帖子，没人天天守着点，
        // 文件就一直停在最早那次手动导出的地方，看着像是卡住了。现在不管谁触发的，
        // 采完都写一次文件。
        if (rec && cur.toEnd && (cur.startPage || 1) === 1) await markHidden(cur.tid, cur.startedAt);
        if (rec) { try { await saveImages(cur.tid); } catch (e) { await Safety.event('images_failed', { tid: cur.tid, error: e.message }); } }
        const rec2 = await get(key(cur.tid), null);
        if (rec2) await autoExport(rec2);
        cur.state = 'done'; cur.finishedAt = Date.now();
        await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? cur : j, null);
        await setBadge();
        if (await sweepDue()) break; // 巡查到点：先让巡查跑，剩下的队列巡查完接着采
        if (await nextFromQueue()) { await sleep(MIN_GAP); continue; }
        break;
      }
      let r;
      try {
        r = await fetchPageWithRetry(cur.fid, cur.tid, cur.page, async (e, attempt, wait) => {
          const c2 = await get('job', null);
          if (c2 && c2.id === cur.id && c2.state === 'running') {
            c2.error = `第 ${cur.page} 页失败（${String(e.message || e)}），${Math.round(wait / 1000)} 秒后第 ${attempt} 次重试`;
            await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? {...j,error:c2.error} : j, null);
          }
        });
      } catch (e) {
        if (e && (e.challenge || e.paused)) {
          await Safety.update('job', j => j && j.id === cur.id && j.state === 'running' ? { ...j, state: e.challenge ? 'waiting_human' : 'running', error: e.message } : j, null);
          break;
        }
        if (e && e.halted) break; // 重试等待期间点了「全部停止」
        if (e && e.permanent) {
          // 「没权限/需要登录」这类重试没用的错误。之前不管是哪种都会把整个任务判死、
          // 挂在这里一直冷却重试，连带把队列后面排着的其他帖子也一起卡住。
          // 「需要登录后才能浏览」比较明确，但只碰到一次也可能是偶发的；连续两次不同
          // 帖子都这样，才真的当成「没登录」处理，停下来让人去登录。
          // 「您无权进行当前操作」这个通用权限拒绝模板，更可能是主题被删/被限制之类的
          // 帖子本身问题，跟登录无关——记下来跳过，继续处理队列里后面的帖子。
          if (e.needLogin) {
            consecutiveNeedLogin += 1;
            if (consecutiveNeedLogin < 2) {
              // 就算是全新、一次都没采成功过的帖子（还没有存档记录），也要留一条「跳过」记录，
              // 不然巡查那边找不到 failReason，下一轮又会把它当新帖子重新排进队列
              const rec = (await get(key(cur.tid), null)) || { floors: [], thread: { tid: cur.tid, fid: cur.fid } };
              rec.failReason = e.message; rec.failedAt = Date.now();
              await set(key(cur.tid), rec);
              cur.state = 'done'; cur.error = ''; cur.finishedAt = Date.now(); cur.skipped = e.message;
              await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? cur : j, null);
              await setBadge();
              if (await sweepDue()) break; // 巡查到点：先让巡查跑，剩下的队列巡查完接着采
        if (await nextFromQueue()) { await sleep(MIN_GAP); continue; }
              break;
            }
            // 连续两次都提示要登录，这次真信了——停下来，冷却结束后会自动再试一次
            cur.state = 'error';
            cur.error = String(e.message || e);
            cur.errorAt = Date.now();
            await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? cur : j, null);
            break;
          }
          const rec = (await get(key(cur.tid), null)) || { floors: [], thread: { tid: cur.tid, fid: cur.fid } };
          rec.failReason = e.message; rec.failedAt = Date.now();
          await set(key(cur.tid), rec);
          cur.state = 'done'; cur.error = ''; cur.finishedAt = Date.now(); cur.skipped = e.message;
          await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? cur : j, null);
          await setBadge();
          if (await sweepDue()) break; // 巡查到点：先让巡查跑，剩下的队列巡查完接着采
        if (await nextFromQueue()) { await sleep(MIN_GAP); continue; }
          break;
        }
        // 4.2.2：同一个帖子连续失败 3 次（每次间隔 5 分钟冷却）就记下原因跳过，
        // 不再无限重试——以前一个打不开的老帖子会把后面整个队列永远卡住。
        // 断网、超时、论坛 5xx/429 是临时故障，不算这个帖子的错，不计入「连续失败 3 次就跳过」
        const transient = isTransientError(e);
        if (!transient) cur.failCount = (cur.failCount || 0) + 1;
        if (!transient && cur.failCount >= 3) {
          const rec = (await get(key(cur.tid), null)) || { floors: [], thread: { tid: cur.tid, fid: cur.fid } };
          rec.failReason = String(e.message || e) + '（连续 3 次失败，已跳过）'; rec.failedAt = Date.now();
          await set(key(cur.tid), rec);
          cur.state = 'done'; cur.error = ''; cur.finishedAt = Date.now(); cur.skipped = rec.failReason;
          await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? cur : j, null);
          await setBadge();
          if (await sweepDue()) break;
          if (await nextFromQueue()) { await sleep(MIN_GAP); continue; }
          break;
        }
        cur.state = 'error';
        cur.error = String(e.message || e) + (transient ? '（网络或论坛临时问题，5 分钟后重试，不会因此跳过）' : `（第 ${cur.failCount} 次失败，5 分钟后重试，3 次不成就跳过）`);
        cur.errorAt = Date.now();
        await Safety.update('job', j => j?.id === cur.id && j.state === 'running' ? cur : j, null);
        break;
      }
      consecutiveNeedLogin = 0;
      const rec = await mergeIntoStore(cur.tid, r.meta, r.floors, cur.url, cur.fid);
      let accepted = false;
      const fresh = await Safety.update('job', fresh => {
        if (!fresh || fresh.state !== 'running' || fresh.id !== cur.id) return fresh;
        accepted = true;
        if (r.meta?.totalPages > fresh.lastPage && fresh.toEnd) fresh.lastPage = r.meta.totalPages;
        fresh.title = rec.thread?.title || fresh.title; fresh.floorCount = rec.floors.length; fresh.failCount = 0;
        fresh.error = ''; fresh.page += 1; return fresh;
      }, null);
      if (!accepted) break;
      if (fresh.page <= fresh.lastPage) await sleep(MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP));
    }
  } finally { running = false; await setBadge(); }
}

// 定时跟进：看最后一页有没有新楼，有就补齐并导出
async function checkWatched() {
  if (running || sweeping) return;
  sweeping = true;
  try {
  if ((await isHalted()) || !(await get('watchEnabled', false))) return;
  const all = await chrome.storage.local.get(null);
  const watched = Object.keys(all).filter((k) => k.startsWith('t:') && all[k].watch);
  for (const k of watched) {
    if (await isHalted()) break;
    const rec = all[k];
    const t = rec.thread;
    try {
      const html = await fetchHtml(`${BASE}/f${t.fid}b-t${t.tid}z-1`);
      const r = await parse('thread', html, t.tid, 1);
      const replies = r.meta && r.meta.replies;
      const known = Math.max(0, ...rec.floors.map((f) => f.floor || 0));
      if (replies != null && replies + 1 > known) {
        await Safety.update('queue', q => { if (!q.some(x => x.tid === t.tid)) q.push({ tid:t.tid, fid:t.fid, title:t.title, from:Math.max(1,Math.ceil(known/PER_PAGE)) }); return q; }, []);
        rec.newFloors = replies + 1 - known;
        await chrome.storage.local.set({ [k]: rec });
      }
    } catch (e) { if (e.challenge || e.paused) break; await Safety.event('watch_failed', { tid: t.tid, error: e.message }); }
    await sleep(3000);
  }
  await setBadge();
  } finally { sweeping = false; }
  runJob();
}

// 巡查整个板块：读几页列表跟存档比对，自己找出「新主题」和「有新回复的老帖」，
// 分别加进队列（新主题从第 1 页整采，老帖从上次存到的地方接着采），交给 runJob 顺序处理。
// 板块列表页本身也可能被限流，读页之间照样留间隔；读列表失败就停下，等下一轮巡查再试，
// 不去猜、不硬扛。
async function sweepBoard(manual) {
  if (await isHalted()) {
    if (!manual && (await sweepDue())) await set('sweepSkip', { at: Date.now(), reason: (await get('haltCollect', false)) ? '采集处于停止状态（面板顶部点「▶ 恢复采集」）' : '论坛要求人工验证或登录，处理后自动恢复' });
    return manual ? { ok: false, error: '采集已停止，先在面板顶部点「▶ 恢复采集」。' } : undefined;
  }
  if (running || sweeping) return manual ? { ok: false, error: '采集正在进行，请稍后再试一次巡查。' } : undefined;
  const enabled = manual || (await get('sweepEnabled', false));
  if (!enabled) return;
  sweeping = true;
  await setBadge();
  try {
    const fid = await get('sweepFid', DEFAULT_SWEEP_FID);
    const pages = Math.max(1, Math.min(10, await get('sweepPages', DEFAULT_SWEEP_PAGES)));

    const rows = new Map();
    let fetchError = '';
    for (let p = 1; p <= pages; p++) {
      if (await isHalted()) { fetchError = '已全部停止'; break; }
      const url = p === 1 ? `${BASE}/f${fid}b` : `${BASE}/f${fid}b-${p}`;
      try {
        const html = await fetchHtml(url);
        const r = await parse('board', html);
        for (const row of r.rows || []) if (!rows.has(row.tid)) rows.set(row.tid, row);
      } catch (e) {
        fetchError = String(e.message || e);
        break;
      }
      if (p < pages) await sleep(MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP));
    }

    try { await Alerts.onBoardRows([...rows.values()]); } catch (e) { /* 忽略 */ }
    const originalQueue = await get('queue', []);
    const q = [];
    const job = await get('job', null);
    const busy = new Set(originalQueue.map((x) => x.tid));
    if (job && job.tid != null && (job.state === 'running' || job.state === 'error')) busy.add(String(job.tid));

    let newThreads = 0, updatedThreads = 0, newReplies = 0;
    const fileKnown = await fileKnownFloors([...rows.values()].filter((r) => !busy.has(r.tid)).map((r) => r.tid));
    for (const row of rows.values()) {
      if (busy.has(row.tid)) continue;
      const rec = await get(key(row.tid), null);
      const fk = fileKnown[row.tid] || 0;
      if ((!rec || !rec.floors.length) && fk) {
        // 浏览器里没记录、但文件夹里已有存档：从文件存到的那页接着采
        if (row.replies + 1 > fk) {
          q.push({ tid: row.tid, fid: row.fid, title: row.title, from: Math.max(1, Math.ceil(fk / PER_PAGE)) });
          busy.add(row.tid);
          updatedThreads++;
          newReplies += row.replies + 1 - fk;
        }
        continue;
      }
      if (!rec || !rec.floors.length) {
        // 之前采过、但因为没权限/主题被删之类永久性原因被跳过的帖子，一天内巡查不再重排，
        // 不然会一轮一轮反复卡在同一个采不到的帖子上
        if (rec && rec.failReason && Date.now() - (rec.failedAt || 0) < FAIL_RETRY_MS) continue;
        q.push({ tid: row.tid, fid: row.fid, title: row.title, from: 1 });
        busy.add(row.tid);
        newThreads++;
      } else {
        const known = Math.max(storeKnown(rec), fk);
        if (row.replies + 1 > known) {
          q.push({ tid: row.tid, fid: row.fid, title: row.title, from: Math.max(1, Math.ceil(known / PER_PAGE)) });
          busy.add(row.tid);
          updatedThreads++;
          newReplies += row.replies + 1 - known;
          rec.newFloors = row.replies + 1 - known;
          await set(key(row.tid), rec);
        }
      }
    }
    await Safety.update('queue', current => { for (const x of q) if (!current.some(y => y.tid === x.tid)) current.push(x); return current; }, []);
    const summary = {
      at: Date.now(), scanned: rows.size, pages, newThreads, updatedThreads, newReplies, error: fetchError,
    };
    await set('lastSweep', summary);
    await pickNextSweep(summary.at); // 下次巡查时间：在设置的范围里随机
    // Queue starts after releasing the sweep lock.
    return { ok: true, ...summary };
  } finally {
    sweeping = false;
    await setBadge();
    runJob().catch(e => Safety.event('collect_error', {error:e.message}));
  }
}

// 修复：以前 service worker 每次醒来都重新 create 同名闹钟，Chrome 会把它重置成「从现在起再等 15 分钟」。
// 而 tick 每分钟都会唤醒一次 service worker，所以 15 分钟的巡查、60 分钟的跟进几乎永远轮不到。
// 现在闹钟已存在就不动，只在缺失或周期不对时才建。
async function ensureAlarm(name, period) {
  const a = await chrome.alarms.get(name);
  if (!a || a.periodInMinutes !== period) chrome.alarms.create(name, { periodInMinutes: period });
}
ensureAlarm('tick', 1); ensureAlarm('watch', WATCH_MINUTES); ensureAlarm('sweep', SWEEP_MINUTES);

// 巡查到点了没有（只看开关和上次巡查时间，不依赖闹钟准不准）
// 4.2.5：巡查间隔可设置成一个范围，每次在范围里随机取，不再是固定 15 分钟。默认 10～20 分钟。
const DEFAULT_SWEEP_RANGE = { min: 10, max: 20 };
function cleanRange(v) {
  let min = Math.round(Number(v && v.min)), max = Math.round(Number(v && v.max));
  if (!Number.isFinite(min)) min = DEFAULT_SWEEP_RANGE.min;
  if (!Number.isFinite(max)) max = DEFAULT_SWEEP_RANGE.max;
  min = Math.max(5, Math.min(240, min)); max = Math.max(5, Math.min(240, max));
  if (max < min) [min, max] = [max, min];
  return { min, max };
}
async function pickNextSweep(from = Date.now()) {
  const r = cleanRange(await get('sweepRange', DEFAULT_SWEEP_RANGE));
  const at = from + Math.round((r.min + Math.random() * (r.max - r.min)) * 60000);
  await set('sweepNextAt', at);
  return at;
}
async function sweepDue() {
  if (!(await get('sweepEnabled', false))) return false;
  const ls = await get('lastSweep', null);
  if (!ls) return true;
  let next = await get('sweepNextAt', null);
  if (!next) next = await pickNextSweep(ls.at || Date.now());
  return Date.now() >= next;
}

// 每分钟一次：巡查到点且空闲就先巡查（巡查结束会接着跑队列），否则继续跑队列
async function onTick() {
  if (!running && !sweeping && (await sweepDue())) return sweepBoard(false);
  return runJob();
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'watch') checkWatched();
  else if (a.name === 'sweep') sweepDue().then(d => d && !running && !sweeping && sweepBoard(false));
  else if (a.name === 'tick') onTick().catch(e => Safety.event('collect_error', { error: e.message }));
});
chrome.runtime.onStartup.addListener(() => { runJob(); sweepBoard(false); }); // sweepBoard 自己会检查开关，默认不跑

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || !Safety.ownPage(sender)) return;
  const allowed = ['START','STOP','SKIP_JOB','BACKUP_EXPORT','BACKUP_IMPORT','ENQUEUE','HALT_ALL','HALT_COLLECT','HALT_POST','RESUME_ALL','RESUME_COLLECT','RESUME_POST','STATUS','LIST','GET','MARK_EXPORTED','WATCH','CHECK_NOW','SCAN','SET','SWEEP_NOW','GET_SWEEP','FLUSH_EXPORTS','ALERTS_LIST','ALERTS_READ','ALERTS_CLEAR','GET_SETTINGS','IMAGES','FIND_UID'];
  if (!allowed.includes(msg.type)) return;
  Safety.serial('collect-command', async () => {
    await Safety.ready;
    if (msg.type === 'START') {
      if (running) throw new Error('当前采集尚未停止');
      Safety.forumUrl(msg.url);
      if (!/^\d+$/.test(String(msg.tid)) || !/^\d+$/.test(String(msg.fid))) throw new Error('帖子编号无效');
      const rec = await get(key(msg.tid), null);
      let startPage = 1;
      if (msg.mode === 'update') {
        const known = Math.max(storeKnown(rec), (await fileKnownFloors([msg.tid]))[String(msg.tid)] || 0);
        if (known) startPage = Math.max(1, Math.ceil(known / PER_PAGE));
      }
      await set('job', {
        id: Safety.id(), state: 'running', tid: msg.tid, fid: msg.fid, url: msg.url,
        title: (rec && rec.thread && rec.thread.title) || '', page: startPage, startPage,
        lastPage: msg.lastPage || startPage, toEnd: true, floorCount: rec ? rec.floors.length : 0,
        startedAt: Date.now(),
      });
      runJob();
      sendResponse({ ok: true });
    } else if (msg.type === 'HALT_POST' || msg.type === 'RESUME_POST') {
      if (msg.type === 'RESUME_POST' && await Safety.blocked()) throw new Error('请先完成人工验证');
      await set('haltPost', msg.type === 'HALT_POST');
      await setBadge();
      sendResponse({ ok: true });
    } else if (msg.type === 'HALT_ALL' || msg.type === 'HALT_COLLECT') {
      if (msg.type === 'HALT_ALL') await set('haltPost', true);
      // 总开关：采集、跟进、巡查、定时发帖全部停下，直到点「恢复运行」。
      // 正在采的帖子放回队列最前面（记住采到第几页），恢复后接着采，不丢进度。
      await set('haltCollect', true);
      await setBadge();
      sendResponse({ ok: true });
    } else if (msg.type === 'RESUME_ALL' || msg.type === 'RESUME_COLLECT') {
      // 4.2.4：以前这里只说「请先完成人工验证」，但面板上没有任何地方能确认验证已完成，
      // 用户在论坛做完算术题也恢复不了。现在点「恢复」时先试读一页论坛，正常了就自动解除。
      if (await Safety.blocked()) await clearChallengeIfForumOk();
      if (msg.type === 'RESUME_ALL') await set('haltPost', false);
      await set('haltCollect', false);
      await setBadge();
      runJob();
      sendResponse({ ok: true });
    } else if (msg.type === 'BACKUP_EXPORT') {
      sendResponse({ ok: true, data: await exportBackup() });
    } else if (msg.type === 'BACKUP_IMPORT') {
      sendResponse({ ok: true, ...(await importBackup(msg.data)) });
    } else if (msg.type === 'SKIP_JOB') {
      // 4.2.2：手动跳过出错卡住的当前帖子，记下原因，接着采队列下一个
      const job = await get('job', null);
      if (!job || !['error','running','waiting_human'].includes(job.state)) { sendResponse({ ok: false, error: '当前没有正在采或卡住的帖子。' }); return; }
      const rec = (await get(key(job.tid), null)) || { floors: [], thread: { tid: job.tid, fid: job.fid, title: job.title } };
      rec.failReason = (job.state === 'error' && job.error ? job.error : '') + '（手动跳过）'; rec.failedAt = Date.now();
      await set(key(job.tid), rec);
      await Safety.update('job', j => j?.id === job.id ? { ...j, state: 'done', error: '', skipped: rec.failReason, finishedAt: Date.now() } : j, null);
      await setBadge();
      runJob().catch(e => Safety.event('collect_error', { error: e.message }));
      sendResponse({ ok: true, title: job.title || job.tid });
    } else if (msg.type === 'STOP') {
      const job = await get('job', null);
      if (job) await Safety.update('job', current => current ? {...current,state:'stopped'} : current, null);
      // 4.2.2：以前这里会顺手把整个待采集队列清空（曾一次丢掉 1558 个帖子）。
      // 现在「停止」只停当前帖子并暂停采集，队列原样保留；点「▶ 恢复采集」接着采剩下的。
      await set('haltCollect', true);
      await setBadge();
      sendResponse({ ok: true, queued: (await get('queue', [])).length });
    } else if (msg.type === 'STATUS') {
      // 4.2.2：队列很长时（1500+）每 1.5 秒把整个队列传给面板会很卡，只传数量和前 20 条
      const fullQueue = await get('queue', []);
      sendResponse({ ok: true, job: await get('job', null), queue: fullQueue.slice(0, 20), queueCount: fullQueue.length,
        rec: msg.tid ? await get(key(msg.tid), null) : null, active: running || sweeping, sweeping,
        halted: await isHalted(), haltCollect: await isHalted(), haltPost: await get('haltPost', false),
        challenge: await get('humanChallenge', null) });
    } else if (msg.type === 'LIST') {
      const all = await chrome.storage.local.get(null);
      sendResponse({ ok: true, list: Object.keys(all).filter((k) => k.startsWith('t:')).map((k) => ({
        tid: all[k].thread.tid, thread: all[k].thread, count: all[k].floors.length,
        maxFloor: all[k].floors.reduce((m, f) => Math.max(m, f.floor || 0), 0),
        updatedAt: all[k].updatedAt, exportedAt: all[k].exportedAt, watch: !!all[k].watch, newFloors: all[k].newFloors || 0,
      })) });
    } else if (msg.type === 'GET') {
      sendResponse({ ok: true, rec: await get(key(msg.tid), null) });
    } else if (msg.type === 'FLUSH_EXPORTS') {
      await set('folderAuthNeeded', false);
      sendResponse({ ok: true, written: await flushExports() });
    } else if (msg.type === 'MARK_EXPORTED') {
      const rec = await get(key(msg.tid), null);
      if (rec) { rec.thread.fileName = msg.fileName; rec.exportedAt = Date.now(); rec.newFloors = 0; await set(key(msg.tid), rec); }
      await setBadge();
      sendResponse({ ok: true });
    } else if (msg.type === 'WATCH') {
      const rec = await get(key(msg.tid), null);
      if (rec) { rec.watch = !!msg.on; if (!msg.on) rec.newFloors = 0; await set(key(msg.tid), rec); }
      await setBadge();
      sendResponse({ ok: true });
    } else if (msg.type === 'CHECK_NOW') {
      checkWatched();
      sendResponse({ ok: true });
    } else if (msg.type === 'SCAN') {
      try {
        const url = new URL(msg.url);
        if (url.origin !== 'https://bbs.my0511.com') throw new Error('列表地址无效');
        if (typeof msg.html !== 'string' || !msg.html.trim()) throw new Error('请从当前板块或搜索结果页面读取列表');
        const html = msg.html;
        if (isChallengePage(html)) throw new Error('请先在论坛页面完成人工验证，再重新打开插件');
        const r = await parse('list', html, null, 1);
        sendResponse({ ok: true, threads: r.threads });
      } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
    } else if (msg.type === 'ENQUEUE') {
      const q = await enqueueThreads(msg.threads);
      sendResponse({ ok: true, size: q.length });
    } else if (msg.type === 'SET') {
      if (!['watchEnabled','sweepEnabled','sweepPages','sweepRange','useFolder','foldFiller','myName','watchUsers','keywords','imageUsers'].includes(msg.key)) throw new Error('不允许写入此设置');
      if (msg.key === 'sweepPages') msg.value = Math.max(1, Math.min(10, Number(msg.value) || 2));
      else if (msg.key === 'sweepRange') msg.value = cleanRange(msg.value);
      else if (msg.key === 'myName') { msg.value = String(msg.value || '').trim(); if (msg.value.length > 40) throw new Error('ID 太长'); }
      else if (['watchUsers','keywords','imageUsers'].includes(msg.key)) {
        if (!Array.isArray(msg.value)) throw new Error('设置值无效');
        msg.value = [...new Set(msg.value.map((x) => String(x).trim()).filter(Boolean))];
        if (msg.value.length > 200 || msg.value.some((x) => x.length > 40)) throw new Error('条目太多或太长（最多 200 条，每条 40 字以内）');
      }
      else if (typeof msg.value !== 'boolean') throw new Error('设置值无效');
      await set(msg.key, msg.value);
      if (msg.key === 'sweepRange') { const ls = await get('lastSweep', null); await pickNextSweep(ls ? Math.max(ls.at || 0, Date.now() - msg.value.min * 60000) : Date.now()); }
      sendResponse({ ok: true });
    } else if (msg.type === 'ALERTS_LIST') {
      sendResponse({ ok: true, alerts: await Alerts.list() });
    } else if (msg.type === 'ALERTS_READ') {
      await Alerts.markRead(Array.isArray(msg.ids) ? msg.ids : null);
      sendResponse({ ok: true });
    } else if (msg.type === 'ALERTS_CLEAR') {
      await Alerts.clear();
      sendResponse({ ok: true });
    } else if (msg.type === 'GET_SETTINGS') {
      const s = await chrome.storage.local.get(['myName','watchUsers','keywords','imageUsers','postCfg']);
      sendResponse({ ok: true, myName: s.myName || s.postCfg?.myName || '', watchUsers: s.watchUsers || [], keywords: s.keywords || [], imageUsers: s.imageUsers || [] });
    } else if (msg.type === 'FIND_UID') {
      // 从浏览器里存过的楼层找这个 ID 的论坛编号（uid）
      const name = String(msg.name || '').trim();
      const all = await chrome.storage.local.get(null);
      let uid = '';
      for (const k of Object.keys(all)) { if (!k.startsWith('t:')) continue; const f = (all[k].floors || []).find((x) => x.author === name && x.uid); if (f) { uid = f.uid; break; } }
      sendResponse({ ok: true, uid });
    } else if (msg.type === 'IMAGES') {
      await Safety.update(key(msg.tid), (r) => (r ? { ...r, saveImages: !!msg.on } : r), null);
      sendResponse({ ok: true });
    } else if (msg.type === 'SWEEP_NOW') {
      const r = await sweepBoard(true);
      sendResponse(r || { ok: true });
    } else if (msg.type === 'GET_SWEEP') {
      sendResponse({
        ok: true,
        lastSweep: await get('lastSweep', null),
        sweepSkip: await get('sweepSkip', null),
        sweepEnabled: await get('sweepEnabled', false),
        watchEnabled: await get('watchEnabled', false),
        sweepPages: await get('sweepPages', DEFAULT_SWEEP_PAGES),
        sweepFid: await get('sweepFid', DEFAULT_SWEEP_FID),
        sweepRange: cleanRange(await get('sweepRange', DEFAULT_SWEEP_RANGE)), sweepNextAt: await get('sweepNextAt', null),
      });
    }
  }).catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

const Collector = { runJob, isChallengePage, fetchHtml };
