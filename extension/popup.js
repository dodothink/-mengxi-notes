const $ = (id) => document.getElementById(id);
const THREAD_RE = /\/f(\d+)b-t(\d+)z(?:-(\d+))?/;
const LIST_RE = /\/f(\d+)b(?:-|$|\?|#)/;
const SEARCH_RE = /\/search\.php(?:\?|$|#)/;
let ctx = null, listUrl = null, listTab = null, isSearch = false, timer = null;

const send = (m) => chrome.runtime.sendMessage(m);
const setStatus = (t) => ($('status').textContent = t);
function toggleState(el, on) { el.setAttribute('aria-pressed', String(on)); el.textContent = el.dataset.label + (on ? ' · 已开启' : ' · 已关闭'); }
const selected = el => el.getAttribute('aria-pressed') === 'true';
const pct = (p) => ($('bar').style.width = Math.max(0, Math.min(100, p)) + '%');

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { return tab && new URL(tab.url).origin === 'https://bbs.my0511.com' ? tab : null; } catch { return null; }
}

function describe(rec) {
  if (!rec || !rec.floors.length) return '还没有存过这个帖子。';
  const t = rec.thread || {};
  const max = Math.max(...rec.floors.map((f) => f.floor || 0));
  let s = `已存 ${rec.floors.length} 楼（到 ${max} 楼）`;
  if (t.replies != null) s += `，原帖共 ${t.replies + 1} 楼`;
  return s + '。';
}

async function refresh() {
  const r = await send({ type: 'STATUS', tid: ctx && ctx.tid });
  const job = r && r.job, rec = r && r.rec, qn = r ? (r.queueCount ?? (r.queue || []).length) : 0;
  const busy = job && job.state === 'running';
  const active = !!(r && r.active);
  const hc = !!(r && r.haltCollect), hp = !!(r && r.haltPost);
  const halted = hc;
  $('haltCollect').textContent = hc ? '▶ 恢复采集' : '⏹ 停止采集';
  $('haltCollect').classList.toggle('resume', hc);
  $('haltPost').textContent = hp ? '▶ 恢复发帖' : '⏹ 停止发帖';
  $('haltPost').classList.toggle('resume', hp);
  const notes = [];
  const ch = r && r.challenge;
  if (ch) notes.push(ch.kind === 'login' ? '论坛要求登录：在浏览器里登录梦溪论坛后，点「▶ 恢复采集」。' : '论坛弹出了验证（算术题）：在浏览器里打开梦溪论坛做完验证后，点「▶ 恢复采集」，插件会先确认论坛正常再继续。');
  else if (hc) notes.push('采集已暂停，队列会保留。');
  if (hp) notes.push('发帖已暂停。');
  if (qn && !busy) notes.push(`队列里有 ${qn} 个帖子待采。`);
  $('haltNote').textContent = notes.join(' ');
  $('haltNote').classList.toggle('hide', !notes.length);

  $('pill').classList.toggle('on', active);
  $('pilltext').textContent = (hc && hp) ? '采集、发帖都已停止' : halted ? '采集已停止' : active ? (r && r.sweeping ? '正在巡查板块…' : '运行中') : '空闲';

  if (ctx) {
    $('full').disabled = busy; $('update').disabled = busy || !(rec && rec.floors.length);
    $('stop').disabled = !busy && !qn; $('export').disabled = !(rec && rec.floors.length) || busy;
    toggleState($('watchbox'), !!(rec && rec.watch));
    $('watchbox').disabled = !(rec && rec.floors.length);
    toggleState($('imagebox'), !!(rec && rec.saveImages));
    $('imagebox').disabled = !(rec && rec.floors.length);
  }

  if (busy) {
    const total = Math.max(1, job.lastPage - job.startPage + 1);
    pct((Math.max(0, job.page - job.startPage) / total) * 100);
    setStatus(`${job.title ? job.title.slice(0, 22) + '\n' : ''}正在取第 ${job.page} / ${job.lastPage} 页，已存 ${job.floorCount || 0} 楼。`
      + (qn ? `\n队列里还有 ${qn} 个帖子。` : '') + '\n可以关掉面板，采集在后台继续。');
  } else if (job && job.state === 'error') {
    pct(0); setStatus('卡住的帖子：' + (job.title || 't' + job.tid) + '\n' + job.error + (ctx ? '\n' + describe(rec) : ''));
  } else if (job && job.state === 'done' && job.skipped && ctx && job.tid === ctx.tid) {
    pct(0); setStatus('这个帖子跳过了：' + job.skipped + '\n（不是临时性问题，重试也没用，已经继续采队列里的下一个了）' + (rec && rec.floors.length ? '\n' + describe(rec) : ''));
  } else if (job && job.state === 'done' && ctx && job.tid === ctx.tid) {
    pct(100); setStatus('采集完成。' + describe(rec));
  } else if (ctx) {
    setStatus(describe(rec) + ((rec && rec.newFloors) ? `\n有 ${rec.newFloors} 楼新内容。` : ''));
    if (!rec || !rec.floors.length) fileNote(ctx.tid);
  }

  $('skipJob').classList.toggle('hide', !(job && ['error','running','waiting_human'].includes(job.state)));
  $('skipJob').textContent = job && job.title ? `跳过《${job.title.slice(0, 14)}》，接着采下一个` : '跳过当前帖子，接着采下一个';
  $('skipJob').onclick = async () => {
    const r2 = await send({ type: 'SKIP_JOB' });
    setStatus(r2 && r2.ok ? `已跳过《${r2.title}》，接着采队列下一个。` + (hc ? '\n采集还在暂停，点「▶ 恢复采集」开始。' : '') : ((r2 && r2.error) || '跳过失败'));
    setTimeout(refresh, 800);
  };
  if (active && !timer) timer = setInterval(refresh, 1500);
  if (!active && timer) { clearInterval(timer); timer = null; }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describeSweep(s) {
  if (!s) return '';
  const ls = s.lastSweep;
  if (!ls) return '还没巡查过，点下面「立即巡查」先跑一次。';
  let out = `上次巡查 ${fmtTime(ls.at)}，看了 ${ls.scanned} 个主题（${ls.pages} 页）。`;
  if (ls.newThreads || ls.updatedThreads) {
    out += `\n新主题 ${ls.newThreads} 个，${ls.updatedThreads} 个帖子有新回复（共 ${ls.newReplies} 楼），已加入采集队列。`;
  } else {
    out += '\n都是老内容，没有发现新增。';
  }
  if (ls.error) out += `\n（板块页读取遇到问题：${ls.error}，下次自动重试）`;
  if (s.sweepEnabled && s.sweepNextAt) out += `\n下次巡查约 ${fmtTime(s.sweepNextAt)}（每 ${s.sweepRange.min}～${s.sweepRange.max} 分钟随机一次）。`;
  const sk = s.sweepSkip;
  if (s.sweepEnabled && sk && sk.at > (ls.at || 0)) out += `\n（${fmtTime(sk.at)} 到点没有巡查：${sk.reason}）`;
  return out;
}

async function refreshSweep() {
  const s = await send({ type: 'GET_SWEEP' });
  if (!s || !s.ok) return;
  $('sweepStatus').textContent = describeSweep(s);
  toggleState($('sweepEnabled'), !!s.sweepEnabled);
  toggleState($('watchEnabled'), !!s.watchEnabled);
}

// 4.0：浏览器里没记录、但存档文件夹里已有这个帖子时提示一下（旧插件或其他电脑采的）
async function fileNote(tid) {
  try {
    const f = await ArchiveFolder.folder(false);
    if (!f.ok) return;
    const k = (await ArchiveFolder.knownFloors(f.dir, [tid]))[String(tid)];
    if (k && ctx && String(ctx.tid) === String(tid)) setStatus(`存档文件夹里已有这个帖子，存到 ${k} 楼。\n点「只取新增楼层」会从那里接着采，采完和已有文件合并。`);
  } catch (e) { /* 读不了就不提示 */ }
}

async function showFolder() {
  const st = await FS.handleState();
  $('folder').textContent = st.has ? '存档位置：' + st.name + (st.perm === 'granted' ? '' : '（需重新授权，点这里）') : '存档位置：下载文件夹';
  await send({ type: 'SET', key: 'useFolder', value: !!st.has });
  // 4.0：授权有效时，顺手把之前没写成的帖子补写（后台执行，不用等）
  if (st.has && st.perm === 'granted') send({ type: 'FLUSH_EXPORTS' }).catch(() => {});
  if (st.has && st.perm !== 'granted') {
    $('folder').style.cursor = 'pointer';
    $('folder').onclick = async () => {
      const f = await ArchiveFolder.folder(true);
      if (f.ok) { setStatus('已重新授权，正在补写没写成的帖子……'); await send({ type: 'FLUSH_EXPORTS' }).catch(() => {}); }
      showFolder();
    };
  }
}

async function doExport() {
  const r = await send({ type: 'GET', tid: ctx.tid });
  if (!r || !r.rec) return;
  const rec = r.rec;
  const md = MD.buildThread(rec.thread, rec.floors);
  const fileName = MD.fileNameFor(rec.thread, rec.floors);
  setStatus('正在写入……');
  // 4.0：选了存档文件夹时，在文件夹里按帖子编号合并写入（不会覆盖掉已有楼层和编辑历史）
  const f = await ArchiveFolder.folder(true).catch((e) => ({ ok: false, error: e }));
  if (f.ok) {
    try {
      const out = await ArchiveFolder.writeMerged(f.dir, { tid: String(rec.thread.tid), fileName, markdown: md });
      await send({ type: 'MARK_EXPORTED', tid: ctx.tid, fileName });
      const watch = (await send({ type: 'LIST' })).list.filter((x) => x.watch).map((x) => String(x.tid));
      await ArchiveFolder.buildIndex(f.dir, watch);
      setStatus(`已合并写入「${f.dir.name}」：\n${fileName}\n共 ${out.floors} 楼` + (out.edited ? `，${out.edited} 楼有编辑记录` : '') + (out.moved.length ? `\n另有 ${out.moved.length} 份重复文件已移到 _重复备份/` : ''));
      send({ type: 'FLUSH_EXPORTS' }).catch(() => {});
    } catch (e) {
      setStatus('没能写入：' + (e.message || e));
    }
    refresh();
    return;
  }
  if (f.needPermission) { setStatus('存档文件夹没有授权，这次没有写入（不会退回「下载」整份覆盖）。\n点下方「存档位置」重新授权。'); return; }
  try {
    const out = await FS.writeFile(fileName, md);
    await send({ type: 'MARK_EXPORTED', tid: ctx.tid, fileName });
    const list = (await send({ type: 'LIST' })).list.map((x) => ({
      title: x.thread.title, url: x.thread.url, fileName: x.tid === rec.thread.tid ? fileName : x.thread.fileName,
      floorCount: x.count, exportedAt: x.exportedAt || x.updatedAt, watch: x.watch,
    }));
    await FS.writeFile('My0511存档索引.md', MD.buildIndex(list));
    setStatus(`已保存到${out.where === 'folder' ? '「' + out.name + '」' : '「下载 / My0511存档」'}：\n${fileName}`);
  } catch (e) {
    setStatus('没能写入：' + (e.message || e) + '\n可以在「设置」里重新选文件夹。');
  }
  refresh();
}

// 手动查看列表只读当前页面，不受后台采集暂停影响，也不额外请求论坛。
async function pageHtml() {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: listTab.id }, func: expected => location.href.split('#')[0] === expected ? document.documentElement.outerHTML : null, args:[listUrl] });
    return res && res.result;
  } catch (e) { return null; }
}

async function scanList() {
  $('links').innerHTML = '';
  $('searchSummary').textContent = '';
  $('queue').disabled = true;
  $('queue').textContent = '请选择帖子';
  try { await renderList(); }
  catch (e) { setStatus('没能读取列表：' + (e.message || e) + '\n请刷新论坛页面后重新打开插件。'); }
}

async function renderList() {
  setStatus('正在读这一页的帖子……');
  const html = await pageHtml();
  if (!html) throw new Error('当前页面已变化或无法读取');
  const r = await send({ type: 'SCAN', url: listUrl, html });
  if (!r || !r.ok) { setStatus('没能读取列表：' + ((r && r.error) || '未知错误')); return; }
  const box = $('links');
  box.innerHTML = '';
  const saved = new Map((await send({ type: 'LIST' })).list.map((x) => [String(x.tid), x.maxFloor || x.count]));
  // 4.0：浏览器里没记录的，再看存档文件夹里的文件
  try {
    const f = await ArchiveFolder.folder(false);
    if (f.ok) {
      const missing = r.threads.map((t) => String(t.tid)).filter((t) => !saved.has(t));
      const known = await ArchiveFolder.knownFloors(f.dir, missing);
      for (const [t, n] of Object.entries(known)) saved.set(t, n);
    }
  } catch (e) { /* 读不了就只看浏览器记录 */ }
  let fresh = 0, grown = 0;
  r.threads.forEach((t) => {
    const l = document.createElement('div');
    const cb = document.createElement('button');
    cb.type = 'button'; cb.className = 'thread-choice'; cb.value = JSON.stringify(t);
    cb.onclick = () => { cb.setAttribute('aria-pressed', String(!selected(cb))); updateSelection(); };
    const s = document.createElement('span');
    const have = saved.get(String(t.tid));
    let tag = '';
    if (have == null) { tag = '【未存】'; fresh++; cb.dataset.want = '1'; }
    else if (t.replies != null && t.replies + 1 > have) { tag = `【已存到 ${have} 楼，新增约 ${t.replies + 1 - have} 楼】`; grown++; cb.dataset.want = '1'; }
    else tag = '【已存】';
    cb.setAttribute('aria-pressed', String(cb.dataset.want === '1'));
    l.dataset.search = (t.title + ' ' + (t.author || '')).toLowerCase();
    const extra = [t.author, t.date, t.replies != null ? '回复 ' + t.replies : ''].filter(Boolean).join(' · ');
    s.textContent = tag + t.title + (extra ? '  （' + extra + '）' : '');
    cb.append(s); l.append(cb); box.append(l);
  });
  $('searchSummary').textContent = `本页 ${r.threads.length} · 未存 ${fresh} · 待更新 ${grown} · 已存 ${r.threads.length-fresh-grown}`;
  updateSelection();
  const hint = r.threads.length ? `未存 ${fresh} 个，有新回复 ${grown} 个。` : '';
  setStatus(`这一页有 ${r.threads.length} 个帖子。${hint}\n选择后点「加入采集队列」，会一个一个按顺序采，每页之间自动停几秒。`);
}

function visibleSelections() {
  return [...$('links').querySelectorAll('.thread-choice')].filter(c => !c.parentElement.hidden);
}
function updateSelection() {
  const query = $('filterThreads').value.trim().toLowerCase();
  for (const row of $('links').children) row.hidden = !row.dataset.search.includes(query);
  const n = visibleSelections().filter(c => selected(c)).length;
  $('queue').textContent = n ? `加入采集队列（${n}）` : '请选择帖子';
  $('queue').disabled = !n;
}

(async function init() {
  const tab = await currentTab();
  const url = tab ? tab.url.split('#')[0] : '';
  const m = url.match(THREAD_RE);
  if (m) {
    ctx = { fid: m[1], tid: m[2], page: +(m[3] || 1), url };
    $('one').classList.remove('hide');
    const r = await send({ type: 'STATUS', tid: ctx.tid });
    const t = (r && r.rec && r.rec.thread) || {};
    $('thread').innerHTML = '';
    const a = document.createElement('div'); a.className = 'title';
    a.textContent = t.title || (tab.title || '').split(' - ')[0] || '帖子 ' + ctx.tid;
    const b = document.createElement('div'); b.className = 'sub';
    b.textContent = [t.board, t.views != null ? '查看 ' + t.views : '', t.replies != null ? '回复 ' + t.replies : ''].filter(Boolean).join(' · ') || 'tid ' + ctx.tid;
    $('thread').append(a, b);
  } else if (url && (LIST_RE.test(url) || SEARCH_RE.test(url))) {
    listUrl = url; listTab = tab; isSearch = SEARCH_RE.test(url);
    $('batch').classList.remove('hide');
    $('thread').innerHTML = isSearch
      ? '<div class="title">搜索结果</div><div class="sub">逐条采集</div>'
      : '<div class="title">版块列表</div><div class="sub">批量采集</div>';
    scanList();
  }

  if (ctx) {
    $('full').onclick = async () => { await send({ type: 'START', mode: 'full', tid: ctx.tid, fid: ctx.fid, url: ctx.url, lastPage: ctx.page }); refresh(); };
    $('update').onclick = async () => { await send({ type: 'START', mode: 'update', tid: ctx.tid, fid: ctx.fid, url: ctx.url, lastPage: ctx.page }); refresh(); };
    $('stop').onclick = async () => { const r = await send({ type: 'STOP' }); await refresh(); setStatus('已停止这个帖子，采集已暂停。' + (r && r.queued ? `队列里的 ${r.queued} 个帖子都还在，点「▶ 恢复采集」接着采。` : '')); };
    $('export').onclick = doExport;
    $('imagebox').onclick = async () => {
      const on = !selected($('imagebox'));
      await send({ type: 'IMAGES', tid: ctx.tid, on });
      toggleState($('imagebox'), on);
      setStatus(on ? '已开启：下次采完这个帖子时，把图片存进存档文件夹的 _图片/ 里（需要选了存档文件夹）。' : '已关闭这个帖子的图片保存，已存的图片不删除。');
    };
    $('watchbox').onclick = async () => {
      const on = !selected($('watchbox'));
      const r = await send({ type: 'WATCH', tid: ctx.tid, on });
      if (!r?.ok) { setStatus(r?.error || '设置失败'); return; }
      toggleState($('watchbox'), on);
      setStatus(on ? '已关注此帖；开启自动更新后每小时检查新楼层。' : '已取消关注此帖。');
    };
  }
  if (listUrl) {
    $('filterThreads').oninput = updateSelection;
    $('links').onchange = updateSelection;
    $('pickNew').onclick = () => {
      const cbs = visibleSelections();
      cbs.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.want === '1')));
      updateSelection();
      const n = cbs.filter((c) => selected(c)).length;
      setStatus(n ? `已选择 ${n} 个未存或有新回复的帖子。` : '这一页的帖子都已存齐。');
    };
    $('all').onclick = () => {
      const cbs = visibleSelections();
      const on = !cbs.every((c) => selected(c));
      cbs.forEach((c) => c.setAttribute('aria-pressed', String(on)));
      updateSelection();
    };
    $('queue').onclick = async () => {
      const picked = visibleSelections().filter(c => selected(c)).map((c) => JSON.parse(c.value));
      if (!picked.length) { setStatus('先选择要采集的帖子。'); return; }
      const r = await send({ type: 'ENQUEUE', threads: picked });
      if (!r?.ok) { setStatus(r?.error || '加入队列失败，请重试。'); return; }
      const state = await send({type:'STATUS'});
      setStatus(`已加入队列，共 ${r.size} 个帖子。` + (state?.haltCollect ? '\n采集目前暂停，点击「恢复采集」后开始。' : '\n会按顺序采集，可以关闭面板。'));
      refresh();
    };
  }
  $('sweepNow').onclick = async () => {
    $('sweepStatus').textContent = '正在巡查「百姓话题」……';
    const r = await send({ type: 'SWEEP_NOW' });
    if (r && r.ok === false) { $('sweepStatus').textContent = r.error || '巡查失败。'; return; }
    await refreshSweep();
    refresh();
  };
  for (const id of ['watchEnabled','sweepEnabled']) {
    $(id).onclick = async () => {
      const r = await send({ type:'SET', key:id, value:!selected($(id)) });
      if (!r?.ok) { setStatus(r?.error || '设置失败'); return; }
      await refreshSweep();
    };
  }
  refreshSweep();
  $('haltCollect').onclick = async () => {
    const r = await send({ type: 'STATUS' });
    const on = !!(r && r.haltCollect);
    const result = await send({ type: on ? 'RESUME_COLLECT' : 'HALT_COLLECT' });
    if (!result?.ok) { setStatus(result?.error || '操作失败'); return; }
    setStatus(on ? '已恢复采集。（巡查、跟进要不要自动跑，在「自动采集与巡查」中设置）' : '采集已停止。正在取的那一页会先取完，之后不再请求论坛。定时发帖不受影响。');
    refresh();
  };
  $('haltPost').onclick = async () => {
    const r = await send({ type: 'STATUS' });
    const on = !!(r && r.haltPost);
    const result = await send({ type: on ? 'RESUME_POST' : 'HALT_POST' });
    if (!result?.ok) { setStatus(result?.error || '操作失败'); return; }
    setStatus(on ? '已恢复定时发帖。' : '定时发帖已停止。正在发的那一条会先发完。采集不受影响。');
    refresh();
  };
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
  showFolder();
  refresh();
})();
