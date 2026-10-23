// My0511 定时发帖（3.0.0 新增）
// 队列、随机调度、打开发帖页填表提交、确认结果。和原来的 background.js 一起由 sw.js 加载，
// 自己注册消息和定时器，不改动采集部分的任何逻辑。
// 论坛是 GBK 编码，后台直接提交会乱码，所以一律打开真实发帖页、填表、点论坛自己的「发表」按钮。
// 注意：本文件刻意不写双引号和反斜杠，正则一律用 new RegExp('...') 字符串形式。
(function () {
  'use strict';

  const BASE = 'https://bbs.my0511.com';
  const NL = String.fromCharCode(10);
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR, BJ = 8 * HOUR;
  const RE_THREAD = new RegExp('/f([0-9]+)b-t([0-9]+)z');
  const RE_VIEW = new RegExp('viewthread[.]php[?](?:.*&)?tid=([0-9]+)');
  const RE_DIGITS = new RegExp('^[0-9]+$');
  const MAX_TRIES = 3;

  const DEFAULT_CFG = {
    enabled: false,          // 总开关，默认关闭
    paused: '',              // 非空＝因故自动暂停（未登录、验证码），内容是原因
    beijing: true,           // 活跃时段、每日计数、指定时间都按北京时间算
    startHM: '09:00',
    endHM: '22:30',
    dailyMax: 3,             // 每个自然日最多几条，0＝不限
    minGapMin: 40,           // 两条之间最短间隔（分钟）
    meanGapMin: 180,         // 平均间隔（分钟），按泊松过程随机
    quietDays: 1,            // 每周随机安静几天（0～3）
    replyPerThreadDaily: 0,  // 同一个帖子每天最多回复几次，0＝不限
    noDoublePost: true,      // 3.7.0 防连帖：回复前看一眼帖子，最后一楼已经是自己就暂缓不发
    myName: '',              // 自己的论坛昵称（防连帖用；发帖成功后自动记下，也可以手动填）
    salt: 0,
  };

  let posting = false;

  const sget = async (k, d) => { const o = await chrome.storage.local.get(k); return o[k] === undefined ? d : o[k]; };
  const sset = (k, v) => chrome.storage.local.set({ [k]: v });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const snip = (t) => String(t || '').split(NL).join(' ').replace(new RegExp('[ ]+', 'g'), ' ').trim().slice(0, 90);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  async function getCfg() {
    const c = Object.assign({}, DEFAULT_CFG, await sget('postCfg', {}));
    if (!c.salt) { c.salt = Math.floor(Math.random() * 1e9) + 1; await sset('postCfg', c); }
    c.beijing = true; // 3.3.0 起一律按北京时间（论坛时间），不再提供本机时间选项
    return c;
  }
  const getQueue = () => sget('postQueue', []);
  const saveQueue = (q) => sset('postQueue', q);
  const mutateQueue = fn => Safety.update('postQueue', fn, []);
  const getLog = () => sget('postLog', []);
  async function addLog(e) {
    await Safety.update('postLog', log => [Object.assign({ at: Date.now() }, e), ...log].slice(0, 300), []);
  }
  async function patch(id, obj) {
    await mutateQueue(q => { const it = q.find(x => x.id === id); if (it) Object.assign(it, obj); return q; });
  }

  // ---------- 时间工具（可选按北京时间） ----------
  function parts(ms, cfg) {
    if (cfg.beijing) {
      const d = new Date(ms + BJ);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
    }
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  }
  function fromParts(y, m, d, h, mi, cfg) {
    return cfg.beijing ? Date.UTC(y, m, d, h, mi) - BJ : new Date(y, m, d, h, mi).getTime();
  }
  const hm = (s) => { const a = String(s || '0:0').split(':').map((x) => parseInt(x, 10) || 0); return a[0] * 60 + (a[1] || 0); };
  function dayStart(ms, cfg) { const p = parts(ms, cfg); return fromParts(p.y, p.m, p.d, 0, 0, cfg); }
  function dayKey(ms, cfg) { const p = parts(ms, cfg); return p.y + '-' + (p.m + 1) + '-' + p.d; }
  function parseTime(v, cfg) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 0 ? v : null;
    const str = String(v).trim();
    if (RE_DIGITS.test(str) && str.length >= 12) return Number(str);
    const n = str.split(new RegExp('[^0-9]+')).filter(Boolean).map(Number);
    if (n.length < 3) return null;
    const t = fromParts(n[0], n[1] - 1, n[2], n[3] || 0, n[4] || 0, cfg);
    return Number.isFinite(t) ? t : null;
  }

  // 每周随机挑几天安静：同一周内结果固定，换一周重新抽
  function hash(a, b) {
    let x = (Math.imul(a >>> 0, 2654435761) + Math.imul(b >>> 0, 40503)) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0;
    x ^= x >>> 13; x = Math.imul(x, 3266489917) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
  }
  function isQuiet(ms, cfg) {
    const n = Math.max(0, Math.min(3, cfg.quietDays | 0));
    if (!n) return false;
    const p = parts(ms, cfg);
    const dn = Math.floor(Date.UTC(p.y, p.m, p.d) / DAY);
    const wk = Math.floor((dn + 3) / 7), off = (dn + 3) % 7;
    const days = [0, 1, 2, 3, 4, 5, 6];
    let h = hash(cfg.salt, wk);
    for (let i = 6; i > 0; i--) { const j = h % (i + 1); const t = days[i]; days[i] = days[j]; days[j] = t; h = hash(h, i); }
    return days.slice(0, n).includes(off);
  }

  function countDay(log, t, cfg) {
    const k = dayKey(t, cfg);
    return log.filter((e) => e.ok && dayKey(e.at, cfg) === k).length;
  }
  function replyBlocked(it, log, t, cfg) {
    const lim = cfg.replyPerThreadDaily | 0;
    if (!it || it.kind !== 'reply' || lim <= 0) return false;
    const k = dayKey(t, cfg);
    return log.filter((e) => e.ok && e.kind === 'reply' && e.tid === it.tid && dayKey(e.at, cfg) === k).length >= lim;
  }

  // 把一个候选时间挪进允许的范围：活跃时段内、不是安静日、当天没超上限
  function fitWindow(t, cfg, log, it) {
    const s = hm(cfg.startHM), e = hm(cfg.endHM);
    for (let i = 0; i < 40; i++) {
      const ds = dayStart(t, cfg);
      const open = ds + s * MIN;
      const close = e > s ? ds + e * MIN : ds + DAY - MIN;
      const blocked = isQuiet(t, cfg)
        || (cfg.dailyMax > 0 && countDay(log, t, cfg) >= cfg.dailyMax)
        || replyBlocked(it, log, t, cfg);
      if (!blocked) {
        if (t < open) t = Math.min(close, open + rnd(0, 50) * MIN);
        if (t <= close) return t;
      }
      t = dayStart(ds + DAY + 2 * HOUR, cfg);
    }
    return null;
  }

  // ---------- 调度（3.5.0 起并行）：每一条各自排好自己的时间，互不等待 ----------
  // 以前任何时候只排「下一条」，自动安排的要一条一条接力，前面的没发、后面的就一直等，
  // 等过了「不晚于」就作废。现在每条都有自己的计划时间 plannedAt，到点就发；
  // 同一时刻到点的几条，之间只留 30~50 秒（论坛有发帖间隔限制，同时提交会被判「发帖太快」）。
  const BURST_MIN = 30 * 1000, BURST_MAX = 50 * 1000;

  function planAuto(it, now, cfg, log) {
    const mean = Math.max(5, cfg.meanGapMin) * MIN;
    const minGap = Math.max(1, cfg.minGapMin) * MIN;
    let b;
    if (it.notBefore || it.notAfter) {
      // 有时间范围的：在范围里随机挑一个时间
      const lo = Math.max(now + rnd(1, 5) * MIN, it.notBefore || 0);
      const hi = it.notAfter ? Math.max(lo, it.notAfter - 2 * MIN) : lo + mean;
      b = lo + Math.random() * Math.max(0, hi - lo);
      // 自己给了时间范围的，以范围为准：不再受活跃时段、安静日、每天上限限制，
      // 否则范围落在夜里或安静日时，会一直排不上，最后过期作废
      if (!it.notAfter || b <= it.notAfter) return b;
      return null;
    } else {
      // 没给范围的：从现在起按随机间隔各排各的，不再排在别的条目后面
      let gap = -Math.log(1 - Math.random()) * mean;
      gap = Math.max(minGap, Math.min(gap, mean * 4));
      b = now + gap;
    }
    let t = fitWindow(b, cfg, log, it);
    if (t && it.notAfter && t > it.notAfter) {
      t = fitWindow(Math.max(now + MIN, it.notBefore || 0), cfg, log, it);
      if (t && t > it.notAfter) t = null;
    }
    return t;
  }

  async function scheduleUnlocked(force, reroll) {
    const cfg = await getCfg();
    await chrome.alarms.clear('post');
    if (!cfg.enabled || cfg.paused || await Safety.blocked()) { await sset('postNext', null); return null; }
    const now = Date.now();
    const log = await getLog();
    let best = null;
    await mutateQueue(async q => {
    for (const it of q) {
      if (it.autoDraftRef) continue; // Timeout drafts have one dedicated attempt, never a scheduled retry.
      if (it.status !== 'pending' && it.status !== 'retry') continue;
      let t = it.plannedAt || null;
      const inGrace = t && t <= now && now - t < 20 * MIN;          // 到点了、正在排队等发，不算过期
      if (it.notAfter && now > it.notAfter && !inGrace) {
        it.status = 'expired'; it.plannedAt = null;
        it.error = '过了设定的最晚时间还没发出，没有发';
        continue;
      }
      const stale = !t || now - t > 20 * MIN || (reroll && !it.at && !it.retryAt);
      if (stale) {
        if (it.retryAt) t = fitWindow(Math.max(it.retryAt, now + MIN), cfg, log, it);
        else if (it.at && it.at > now - 20 * MIN) t = Math.max(it.at, now + 30 * 1000);   // 指定时间：不受规则限制
        else t = planAuto(it, now, cfg, log);                                              // 电脑睡眠错过太久的，也重新安排，不补发
        it.plannedAt = t ? Math.round(t) : null;
      }
      if (t != null && (!best || t < best.at)) best = { id: it.id, at: Math.round(t), auto: !it.at };
    }
    return q;
    });
    if (!best) { await sset('postNext', null); return null; }
    await sset('postNext', best);
    const lastTry = await sget('postLastTry', 0);
    const when = Math.max(best.at, lastTry ? lastTry + rnd(BURST_MIN, BURST_MAX) : 0, now + 1000);
    chrome.alarms.create('post', { when });
    return best;
  }

  const reschedule = (force, reroll) => Safety.serial('post-schedule', () => scheduleUnlocked(force, reroll));

  async function runDue() {
    await posterReady;
    const cfg = await getCfg();
    if (!cfg.enabled || cfg.paused || posting) return;
    // 「停止发帖」期间不发；每分钟看一次，恢复后按原来的规则顺延（错过太久的会重新安排时间，不补发）
    if (await sget('haltPost', false)) { chrome.alarms.create('post', { when: Date.now() + MIN }); return; }
    const lastTry = await sget('postLastTry', 0);
    if (lastTry && Date.now() - lastTry < BURST_MIN - 2000) { await reschedule(false); return; }
    await reschedule(false);
    const q = await getQueue();
    const now = Date.now();
    const due = q.filter((x) => (x.status === 'pending' || x.status === 'retry') && x.plannedAt && x.plannedAt <= now + 5000)
      .sort((a, b) => a.plannedAt - b.plannedAt);
    if (!due.length) return;
    await postOne(due[0].id, false);   // 发完 postOne 会重新排定时器，同时到点的下一条 30~50 秒后接着发
  }

  // ---------- 内容校验 ----------
  function parseTarget(s) {
    const str = String(s || '').trim();
    if (str.includes('://')) Safety.forumUrl(str);
    let m = str.match(RE_THREAD);
    if (m) return { fid: m[1], tid: m[2] };
    m = str.match(RE_VIEW);
    if (m) return { fid: '', tid: m[1] };
    if (RE_DIGITS.test(str)) return { fid: '', tid: str };
    return null;
  }
  const digits = (x) => { const s = String(x == null ? '' : x).trim(); return RE_DIGITS.test(s) ? s : ''; };
  function normalizeItem(raw, cfg) {
    const it = {
      kind: raw.kind === 'reply' ? 'reply' : 'thread',
      fid: digits(raw.fid) || '152',
      typeid: digits(raw.typeid),
      subject: String(raw.subject || '').trim(),
      message: String(raw.message || '').trim(),
      tid: '',
      at: parseTime(raw.at, cfg),
      notBefore: parseTime(raw.notBefore, cfg),
      notAfter: parseTime(raw.notAfter, cfg),
    };
    if (!it.message) throw new Error('正文不能为空');
    if (it.message.length > 5000 || it.subject.length > 80) throw new Error('正文最多5000字，标题最多80字');
    if (it.kind === 'thread') {
      if (!it.subject) throw new Error('发新帖需要标题');
    } else {
      const t = parseTarget(raw.target || raw.url || raw.tid);
      if (!t) throw new Error('回复需要填目标帖子的网址，例如 https://bbs.my0511.com/f152b-t9083846z');
      it.tid = t.tid; if (t.fid) it.fid = t.fid;
      it.subject = ''; it.typeid = '';
    }
    if (it.at) { it.notBefore = null; it.notAfter = null; }
    if (it.notBefore && it.notAfter && it.notAfter <= it.notBefore) throw new Error('「不晚于」要晚于「不早于」');
    return it;
  }
  function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  const sig = (it) => it.kind + ':' + (it.kind === 'reply' ? it.tid : it.fid) + ':' + strHash(it.subject + '|' + it.message);

  // ---------- 在论坛页面里执行的函数（会被序列化注入，不能引用外面的变量） ----------
  async function pageFill(kind, subject, message, typeid) {
    const bodyText = () => (document.body ? document.body.innerText : '').slice(0, 600);
    const f = document.getElementById('postform')
      || Array.from(document.forms).find((x) => (x.getAttribute('action') || '').indexOf('post.php') >= 0 && x.querySelector('textarea'));
    if (!f) return { ok: false, reason: 'noform', text: bodyText() };
    if (f.querySelector('[name*=seccode],[name*=secqaa],[id*=seccode]')) return { ok: false, reason: 'captcha', text: '' };
    window.alert = function (m) { window.__my0511Alert = String(m); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const em = document.getElementById('e_mode');
    try { if (em && em.value === '1' && typeof window.switchEditor === 'function') window.switchEditor(0); } catch (e) {}
    await wait(400);
    if (kind === 'thread') {
      const s = f.querySelector('[name=subject]');
      if (s) { s.focus(); s.value = subject; s.dispatchEvent(new Event('input', { bubbles: true })); }
      if (typeid && f.typeid) f.typeid.value = typeid;
      await wait(500 + Math.random() * 1200);
    }
    const ta = f.querySelector('textarea[name=message]') || document.getElementById('e_textarea');
    if (!ta) return { ok: false, reason: 'noform', text: bodyText() };
    ta.focus();
    ta.value = '';
    const size = Math.max(40, Math.ceil(message.length / 30));
    for (let i = 0; i < message.length; i += size) {
      ta.value += message.slice(i, i + size);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150 + Math.random() * 450);
    }
    // 可视化编辑器如果没切换成功，把内容也写进编辑器，提交时论坛自己会转换
    if (em && em.value === '1') {
      const fr = document.getElementById('e_iframe');
      const doc = fr && (fr.contentDocument || (fr.contentWindow && fr.contentWindow.document));
      if (doc && doc.body) doc.body.innerText = message;
    }
    return { ok: true, mode: em ? em.value : '' };
  }

  function pageSubmit(expected) {
    if(expected){const u=new URL(location.href);if(u.origin!=='https://bbs.my0511.com'||u.pathname!=='/post.php'||u.searchParams.get('action')!=='reply'||u.searchParams.get('tid')!==expected.tid||u.searchParams.get('fid')!==expected.fid)return false;}
    const f = document.getElementById('postform')
      || Array.from(document.forms).find((x) => (x.getAttribute('action') || '').indexOf('post.php') >= 0 && x.querySelector('textarea'));
    if (!f) return false;
    if(expected&&f.querySelector('textarea[name=message]')?.value!==expected.message)return false;
    const btn = f.querySelector('[name=topicsubmit],[name=replysubmit],#postsubmit')
      || Array.from(f.querySelectorAll('input[type=submit],button[type=submit]')).find((b) => b.name !== 'previewpost');
    if (btn) { btn.click(); return true; }
    if (typeof f.onsubmit !== 'function' || f.onsubmit() !== false) f.submit();
    return true;
  }

  function pageProbe(expectedMessage, expectedAuthor, beforePid) {
    const f = document.getElementById('postform')
      || Array.from(document.forms).find((x) => (x.getAttribute('action') || '').indexOf('post.php') >= 0 && x.querySelector('textarea'));
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)
      .filter((h) => h.indexOf('bbs.my0511.com') >= 0 && (h.indexOf('b-t') >= 0 || h.indexOf('viewthread') >= 0)).slice(0, 8);
    return {
      url: location.href,
      ready: document.readyState === 'complete',
      hasForm: !!f,
      alert: window.__my0511Alert || '',
      text: (document.body ? document.body.innerText : '').slice(0, 600),
      links,
      challenge: location.pathname === '/captcha' || !!document.querySelector('input[name*=seccode],input[name*=secqaa],iframe[src*=captcha]') || /安全验证|人机验证|访问验证/.test(document.title),
      receipt: Array.from(document.querySelectorAll('div.outer-section')).map(sec => {
        const author = sec.querySelector('.conleft a[href*=viewpro]')?.textContent.trim();
        const text = sec.querySelector('.post-content')?.textContent.replace(/\s+/g, '').trim();
        const share = Array.from(sec.querySelectorAll('a[href]')).find(a => /#pid[0-9]+/.test(a.href));
        const pid = share?.href.match(/#pid([0-9]+)/)?.[1];
        return expectedAuthor && author === expectedAuthor && pid && Number(pid) > Number(beforePid || 0) && text?.includes(String(expectedMessage || '').replace(/\s+/g, '')) ? { pid, url: share.href } : null;
      }).filter(Boolean).pop() || null,
    };
  }

  // ---------- 判断论坛提示页 ----------
  function classify(text) {
    const t = String(text || '');
    const has = (...ws) => ws.some((w) => t.indexOf(w) >= 0);
    if (has('验证码', '安全验证', '人机验证', '访问验证')) return { ok: false, needHuman: true, error: '论坛要求输入验证码' };
    if (has('请先登录', '需要登录', '尚未登录', '还未登录', '未登录')) return { ok: false, needLogin: true, error: '论坛未登录或登录已过期' };
    if (has('间隔', '太快', '稍后再', '频繁', '灌水')) return { ok: false, temp: true, error: '论坛限制了发帖频率：' + snip(t) };
    if (has('您无权', '没有权限', '禁止发言', '禁言', '已关闭', '不存在', '已被删除', '已锁定')) return { ok: false, error: '没有权限或帖子不能回复：' + snip(t) };
    if (has('字数', '长度', '标题', '内容不能')) return { ok: false, error: '内容不符合论坛要求：' + snip(t) };
    if (has('非常感谢', '已经发布', '发表成功', '回复成功', '发布成功')) return { ok: true };
    return null;
  }

  async function run(tabId, func, args) {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return res && res[0] && res[0].result;
  }

  function waitComplete(tabId, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return; done = true;
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('发帖页打开超时')), ms);
      const fn = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
      chrome.tabs.onUpdated.addListener(fn);
      chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(); }).catch(() => {});
    });
  }

  async function doPost(it, onTab, onStage) {
    const url = it.kind === 'reply'
      ? BASE + '/post.php?action=reply&fid=' + it.fid + '&tid=' + it.tid
      : BASE + '/post.php?action=newthread&fid=' + it.fid;
    await Safety.assertRunnable('post');
    const tab = await chrome.tabs.create({ url, active: false });
    await onTab(tab.id);
    await waitComplete(tab.id, 45000);
    await sleep(rnd(3000, 7000));
    const st = await run(tab.id, pageFill, [it.kind, it.subject || '', it.message, it.typeid || '']);
    if (!st || !st.ok) {
      if (st && st.reason === 'captcha') return { ok: false, needHuman: true, error: '发帖页出现了验证码' };
      const c = classify(st && st.text);
      if (c && !c.ok) return c;
      return { ok: false, error: '打不开发帖表单：' + snip(st && st.text) };
    }
    await sleep(rnd(2000, 5000));
    await Safety.assertRunnable('post');
    const current = (await getQueue()).find(x => x.id === it.id);
    if (!current || current.status !== 'posting') throw Object.assign(new Error('任务已改变，未提交'), { paused: true });
    await onStage('submit_intent');
    await Safety.assertRunnable('post');
    if(it.autoDraftRef)await checkGuard(it);
    const submitted = await run(tab.id, pageSubmit, it.autoDraftRef?[{tid:it.tid,fid:it.fid,message:it.message}]:[]);
    if (!submitted) return { ok: false, unknown: true, error: '没有确认提交按钮的执行结果，请人工核实' };
    const t0 = Date.now();
    let unknown = 0;
    while (Date.now() - t0 < 60000) {
      await sleep(1500);
      let r = null;
      try { r = await run(tab.id, pageProbe, [it.message, it.expectedAuthor || '', it.beforePid || '']); } catch (e) { continue; }   // 页面正在跳转
      if (!r || !r.ready) continue;
      if (r.challenge) return { ok: false, needHuman: true, error: '提交阶段遇到验证，请先处理再核实发帖结果' };
      if (r.receipt && (it.kind !== 'reply' || (r.url.match(RE_THREAD)?.[2] || new URL(r.url).searchParams.get('tid')) === it.tid)) return { ok: true, ...r.receipt };
      if (r.alert) { const c = classify(r.alert); return c?.needHuman || c?.needLogin ? c : { ok: false, unknown: true, error: '提交后提示需人工核实：' + snip(r.alert) }; }
      const c = classify(r.text);
      if (c?.needHuman || c?.needLogin) return c;
      if (r.hasForm && !c) continue;
      if (c || RE_THREAD.test(r.url) || RE_VIEW.test(r.url)) return { ok: false, unknown: true, url: r.url, error: '页面已返回，但尚无可靠发布回执，请人工核实' };
      if (++unknown >= 3) return { ok: false, unknown: true, error: '提交后出现了看不懂的页面：' + snip(r.text) };
    }
    return { ok: false, unknown: true, error: '提交后 60 秒没等到结果，可能已经发出，请到论坛确认后再决定要不要重发' };
  }

  function notify(message) {
    try {
      chrome.notifications.create('post-' + Date.now(), {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'My0511 定时发帖', message,
      });
    } catch (e) {}
  }

  // 读帖子最后一页，返回最后一楼 {floor, author}。用的是采集那边的 fetchHtml / parse（同一个后台）
  async function lastFloorOf(it) {
    const url1 = BASE + '/f' + (it.fid || '152') + 'b-t' + it.tid + 'z-1';
    const r1 = await parse('thread', await fetchHtml(url1, 'post'), it.tid, 1);
    const pages = (r1.meta && r1.meta.totalPages) || 1;
    let floors = r1.floors || [];
    if (pages > 1) {
      await sleep(rnd(1500, 3000));
      const rN = await parse('thread', await fetchHtml(BASE + '/f' + (it.fid || '152') + 'b-t' + it.tid + 'z-' + pages, 'post'), it.tid, pages);
      floors = rN.floors || [];
    }
    let last = null;
    for (const f of floors) if (!last || (f.floor || 0) >= (last.floor || 0)) last = f;
    return last;
  }
  // 回复发出去以后，最后一楼就是自己：顺手记下自己的昵称，省得手动填
  async function learnMyName(it) {
    const cfg = await getCfg();
    if (cfg.myName) return;
    await sleep(rnd(5000, 9000));
    const last = await lastFloorOf(it);
    if (last && last.author) { const c = await getCfg(); if (!c.myName) { c.myName = last.author.trim(); await sset('postCfg', c); } }
  }

  async function postOne(id, manual) {
    if (posting) return { ok: false, error: '正在发另一条，请稍等' };
    posting = true;
    try { return await executePost(id, manual); } finally { posting = false; await reschedule(true); }
  }
  async function executePost(id, manual) {
    let it, tabId = null, stage = 'before_submit', result;
    try {
      await posterReady;
      await Safety.assertRunnable('post');
      const cfg = await getCfg();
      if (cfg.paused) throw Object.assign(new Error(cfg.paused), { paused: true });
      await mutateQueue(q => {
        const item = q.find(x => x.id === id);
        const allowed = manual ? ['pending','retry','failed','expired','held'] : ['pending','retry'];
        if (!item || !allowed.includes(item.status)) throw new Error('任务状态不允许发送');
        it = { ...item };
        item.status = 'posting'; item.startedAt = Date.now(); item.attemptId = Safety.id(); item.stage = stage;
        return q;
      });
      const log = await getLog();
      if(it.autoDraftRef){
        await checkGuard(it);
        const now=Date.now(),lastAt=await sget('postLastAt',0),lastTry=await sget('postLastTry',0);
        if(now-lastAt<cfg.minGapMin*MIN||now-lastTry<BURST_MIN||(cfg.dailyMax>0&&countDay(log,now,cfg)>=cfg.dailyMax)||replyBlocked(it,log,now,cfg))throw new Error('触及发帖间隔或每日上限，本次未发送；不会补发');
      }
      if (log.some(e => e.ok && e.sig === sig(it))) {
        await patch(id, { status: 'done', note: '相同内容已经发过，已跳过' });
        return { ok: false, error: '相同内容已经发过' };
      }
      if (!it.autoDraftRef && !manual && !it.at && !it.notBefore && !it.notAfter) {
        const lastAt = await sget('postLastAt', 0);
        const next = fitWindow(Math.max(Date.now(), lastAt + cfg.minGapMin * MIN), cfg, log, it);
        if (!next || next > Date.now() + 1000) {
          await patch(id, { status: 'pending', plannedAt: next, note: '等待发送额度或最短间隔' });
          return { ok: false, deferred: true };
        }
      }
      // Read-only preflight establishes a baseline; it must obey the post gate, not the collect switch.
      it.expectedAuthor = cfg.myName || '';
      if (it.kind === 'reply') {
        try {
          const last = await lastFloorOf(it); it.beforePid = last?.pid || '';
          if (!manual && cfg.noDoublePost && cfg.myName && last?.author?.trim() === cfg.myName.trim()) {
            await patch(id, { status: 'held', plannedAt: null, note: '最后一楼已是自己，暂缓' });
            return { ok: false, held: true };
          }
        } catch (e) { if (e.challenge || e.paused) throw e; throw Object.assign(new Error('发前检查失败：' + e.message), { beforeSubmit: true }); }
      }
      result = await doPost(it, async t => { tabId = t; await patch(id, { tabId: t }); }, async next => {
        stage = next; await patch(id, { stage: next });
      });
    } catch (e) {
      result = { ok: false, needHuman: !!e.challenge, paused: !!e.paused,
        unknown: stage !== 'before_submit', error: String(e.message || e) };
    } finally {
      // Keep all uncertain/human-intervention tabs available for inspection.
      if (tabId != null && result?.ok) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
    }
    try {
      if (!it) return result;
      const now = Date.now();
      const base = { id, kind: it.kind, tid: it.tid, fid: it.fid, manual: !!manual };
      if (result.ok) {
        await patch(id, { status: 'done', postedAt: now, url: result.url || '', error: '', retryAt: null, stage: 'confirmed' });
        await sset('postLastAt', now);
        await addLog({ ...base, ok: true, sig: sig(it), url: result.url || '' });
      } else if (result.needHuman || result.needLogin) {
        await Safety.challenge({ source: 'post', kind: result.needLogin ? 'login' : 'captcha', taskId: id, tabId, stage,
          url: it.kind === 'reply' ? BASE + '/post.php?action=reply&fid=' + it.fid + '&tid=' + it.tid : BASE + '/post.php?action=newthread&fid=' + it.fid,
          reason: result.error });
        await patch(id, { status: stage === 'before_submit' ? 'waiting_human' : 'needs_review', error: result.error, plannedAt: null });
        notify(result.error + '。验证页面已保留，请打开控制台。');
      } else if (result.unknown) {
        await patch(id, { status: 'needs_review', error: result.error, plannedAt: null, retryAt: null });
      } else {
        await patch(id, { status: result.paused && !it.autoDraftRef ? 'pending' : 'failed', error: result.error, plannedAt: null, retryAt: null });
      }
      if (!result.ok) await addLog({ ...base, ok: false, error: result.error });
      return result;
    } finally {
      await sset('postLastTry', Date.now());
      await reschedule(true);
    }
  }

  // ---------- 消息接口（给弹出面板和发帖管理页用） ----------
  async function handle(msg) {
    await posterReady;
    if (msg.type === 'POST_STATE') return { ok: true, cfg: await getCfg(), queue: await getQueue(), next: await sget('postNext', null), log: (await getLog()).slice(0, Math.min(300, msg.logN || 100)), posting };
    if (msg.type === 'POST_SET_CFG') {
      await Safety.update('postCfg', raw => {
        const cfg = { ...DEFAULT_CFG, ...raw }, inc = msg.cfg || {};
        for (const k of ['enabled','noDoublePost']) if (k in inc) cfg[k] = !!inc[k];
        for (const k of ['dailyMax','minGapMin','meanGapMin','quietDays','replyPerThreadDaily']) if (k in inc) {
          const n = Number(inc[k]); if (!Number.isFinite(n) || n < 0 || n > 20160) throw new Error('规则数值无效'); cfg[k] = Math.floor(n);
        }
        for (const k of ['startHM','endHM']) if (k in inc) { if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(inc[k])) throw new Error('时间无效'); cfg[k] = inc[k]; }
        if ('myName' in inc) cfg.myName = String(inc.myName).trim().slice(0,40);
        cfg.meanGapMin = Math.max(cfg.minGapMin, cfg.meanGapMin); cfg.beijing = true;
        return cfg;
      }, {});
    } else if (msg.type === 'POST_RESUME') {
      if (await Safety.blocked()) throw new Error('请先在控制台核实人工验证已完成');
      await Safety.update('postCfg', cfg => ({ ...cfg, paused: '' }), {});
    } else if (msg.type === 'POST_NOW') {
      await Safety.assertRunnable('post');
      let id = msg.id || (await sget('postNext', null))?.id;
      if (!id) id = (await getQueue()).find(x => ['pending','retry'].includes(x.status))?.id;
      if (!id) throw new Error('没有可发送的任务');
      if((await getQueue()).find(x=>x.id===id)?.autoDraftRef)throw new Error('超时任务不能重发，请重新发起草稿审核');
      if (posting) throw new Error('已有任务正在发送');
      postOne(id, true).catch(e => Safety.event('post_error', { error: e.message }));
      return { ok: true, started: true };
    } else if (msg.type === 'POST_REROLL') return { ok: true, next: await reschedule(true, true) };
    else {
      const cfg = await getCfg(); let added = 0, removed = 0; const errors = [];
      await mutateQueue(q => {
        const locked = x => ['posting','needs_review','waiting_human'].includes(x.status);
        const item = q.find(x => x.id === msg.id);
        const target=msg.type==='POST_SAVE_ITEM'?q.find(x=>x.id===msg.item?.id):item;
        if(target?.autoDraftRef&&['POST_SAVE_ITEM','POST_RESET'].includes(msg.type))throw new Error('请回到工作台重新发起草稿审核');
        switch (msg.type) {
          case 'POST_SAVE_ITEM': {
            const raw = msg.item || {}, normalized = normalizeItem(raw, cfg), old = q.find(x => x.id === raw.id);
            if (raw.id && (!old || locked(old) || old.status === 'done')) throw new Error('该任务不可编辑');
            const fresh = { ...normalized, status: raw.draft ? 'draft' : 'pending', revision: (old?.revision || 0) + 1, tries: 0, plannedAt: null, error: '', note: '' };
            if (old) Object.assign(old, fresh); else q.push({ ...fresh, id: newId(), createdAt: Date.now() }); break;
          }
          case 'POST_IMPORT': {
            const list = Array.isArray(msg.data) ? msg.data : msg.data?.queue;
            if (!Array.isArray(list) || list.length > 500) throw new Error('一次最多导入500条');
            list.forEach((raw,i) => { if (raw?.status === 'done') return; try { q.push({ ...normalizeItem(raw,cfg), id: newId(), status:'pending', revision:1, tries:0, createdAt:Date.now() }); added++; } catch(e) { errors.push('第'+(i+1)+'条：'+e.message); } }); break;
          }
          case 'POST_DELETE': if (item && locked(item)) throw new Error('人工待核实或执行中的任务不能删除'); q = q.filter(x => x.id !== msg.id); break;
          case 'POST_DELETE_MANY': case 'POST_DELETE_ALL': { const ids = new Set(msg.ids || []); const before = q.length; q = q.filter(x => locked(x) || (msg.type !== 'POST_DELETE_ALL' && !ids.has(x.id))); removed = before-q.length; break; }
          case 'POST_MOVE': { const i=q.findIndex(x=>x.id===msg.id), j=i+(msg.dir<0?-1:1); if(i>=0&&j>=0&&j<q.length) [q[i],q[j]]=[q[j],q[i]]; break; }
          case 'POST_RESET': if (!item || locked(item) || item.status==='done') throw new Error('请先核实结果，不能直接重排'); Object.assign(item,{status:'pending',tries:0,retryAt:null,plannedAt:null,error:'',note:''}); break;
          case 'POST_CLEAR_DONE': q=q.filter(x=>!['done','expired'].includes(x.status)); break;
          case 'POST_REVIEW':
            if (!item || item.status !== 'needs_review' || !['posted','not_posted'].includes(msg.result)) throw new Error('核实结果无效');
            Object.assign(item, { status: msg.result === 'posted' ? 'done' : 'failed', stage:'reviewed', plannedAt:null, error: '', note: '用户已核实：' + msg.result }); break;
          default: throw new Error('未知发帖指令');
        }
        return q;
      });
      return { ok: true, added, removed, errors, next: await reschedule(true) };
    }
    return { ok: true, next: await reschedule(true) };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!Safety.ownPage(sender) || !msg || typeof msg.type !== 'string' || msg.type.indexOf('POST_') !== 0) return;
    (async () => {
      try { sendResponse(await handle(msg)); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  });

  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'post') runDue().catch(e => Safety.event('post_error', { error: e.message })); });

  // 后台被重启时：发到一半的标记为「不确定」，交给人确认，避免重复发；然后恢复定时器
  async function recover() {
    await Safety.ready;
    await mutateQueue(q => { for (const it of q) if (it.status === 'posting') {
      it.status = 'needs_review'; it.plannedAt = null;
      it.error = '上次执行被中断，请到论坛核实；不会自动重发';
    } return q; });
    await reschedule(false);
  }
  const posterReady = recover();
  // 4.0 接口：一次性发表（供扩展模块使用，例如带 Agent 版的超时自动发表）。
  // 调用方必须提供 guard：发送前后多次调用，任何一次抛错就不发。浏览器重启后 guard 丢失，任务一律不发、不补发。
  const guards = new Map();
  // 4.2：guard 只收到稳定的公开形状 {ref, tid, fid, message}（冻结对象），不暴露内部队列字段
  async function checkGuard(it){const g=guards.get(it.id);if(!g)throw new Error('一次性发表任务缺少确认函数，不发送');await g(Object.freeze({ref:String(it.autoDraftRef||''),tid:String(it.tid),fid:String(it.fid),message:String(it.message)}));}
  async function postOnce(task, guard){
    await posterReady;
    if(typeof guard!=='function')throw new Error('必须提供发送前确认函数');
    if(posting)throw new Error('已有任务正在发送，本次一次性发表已取消');
    const ref=String(task.ref||'');
    const it={id:'once-'+ref,kind:'reply',tid:String(task.tid),fid:String(task.fid),message:task.message,autoDraftRef:ref,status:'pending',createdAt:Date.now(),revision:1,tries:0};
    if(!/^[-\w]{8,80}$/.test(ref)||!/^\d+$/.test(it.tid)||!/^\d+$/.test(it.fid)||typeof it.message!=='string'||!it.message.trim()||it.message.length>3000)throw new Error('一次性发表内容无效');
    guards.set(it.id,guard);
    try{
      await checkGuard(it);
      await mutateQueue(q=>{if(q.some(x=>x.id===it.id))throw new Error('该任务已尝试发表，不会重复执行');q.push(it);return q;});
      return await postOne(it.id,false);
    }finally{guards.delete(it.id);}
  }
  self.Poster = { handle, postOne, postOnce, reschedule, ready: posterReady };
})();
