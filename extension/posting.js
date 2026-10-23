// 发帖管理页（3.0.0 新增）
const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
const NL = String.fromCharCode(10);
const BJ = 8 * 3600000;
const WEEK = '日一二三四五六';
const STATUS = { draft: '草稿', waiting_human: '等待人工验证', needs_review: '待核实结果', held: '暂缓', pending: '待发', retry: '等待重试', posting: '发送中', done: '已发出', failed: '失败', expired: '已过期' };
const CFG_KEYS = ['noDoublePost', 'myName', 'startHM', 'endHM', 'dailyMax', 'minGapMin', 'meanGapMin', 'quietDays', 'replyPerThreadDaily'];
let state = null, editingId = null, cfgDirty = false;
const selected = new Set(); // 队列里勾选的条目，自动刷新时保留

const pad = (n) => String(n).padStart(2, '0');
function parts(ms, bj) {
  const d = new Date(bj ? ms + BJ : ms);
  return bj
    ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), w: d.getUTCDay() }
    : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), w: d.getDay() };
}
function fmt(ms, bj) { const p = parts(ms, bj); return (p.m + 1) + '月' + p.d + '日 周' + WEEK[p.w] + ' ' + pad(p.h) + ':' + pad(p.mi); }
function toInput(ms, bj) { if (!ms) return ''; const p = parts(ms, bj); return p.y + '-' + pad(p.m + 1) + '-' + pad(p.d) + 'T' + pad(p.h) + ':' + pad(p.mi); }
function fromInput(v, bj) {
  if (!v) return null;
  const [a, b] = v.split('T');
  const [y, m, d] = a.split('-').map(Number);
  const [h, mi] = (b || '0:0').split(':').map(Number);
  return bj ? Date.UTC(y, m - 1, d, h, mi) - BJ : new Date(y, m - 1, d, h, mi).getTime();
}
function rel(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (m < 1) return '一分钟内';
  if (m < 60) return m + ' 分钟后';
  const h = Math.floor(m / 60);
  return h < 48 ? h + ' 小时 ' + (m % 60) + ' 分后' : Math.round(h / 24) + ' 天后';
}
const tzLabel = () => '北京时间';
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const threadUrl = (it) => 'https://bbs.my0511.com/f' + it.fid + 'b-t' + it.tid + 'z';

async function act(m) {
  const r = await send(m);
  if (r && r.ok === false) alert(r.error || '操作失败');
  await load();
  return r;
}

async function load() {
  const s = await send({ type: 'POST_STATE' });
  if (!s || !s.ok) { $('status').textContent = '读不到状态：' + ((s && s.error) || '插件后台没有响应'); return; }
  state = s;
  renderStatus();
  renderQueue();
  renderLog();
  if (!cfgDirty) renderCfg();
  document.querySelectorAll('.tzname').forEach((x) => (x.textContent = '时间按' + tzLabel()));
}

function renderStatus() {
  const { cfg, queue, next, posting } = state;
  $('enabled').checked = !!cfg.enabled;
  const pend = queue.filter((x) => x.status === 'pending' || x.status === 'retry').length;
  const lines = [];
  if (posting) lines.push('正在发帖……');
  if (!cfg.enabled) lines.push('定时发帖已关闭。队列里的内容不会自动发出，需要的话可以用「立即发」手动发。');
  else if (cfg.paused) lines.push('已暂停：' + cfg.paused + NL + '处理好之后点「恢复运行」。');
  else if (next) {
    const it = queue.find((x) => x.id === next.id);
    lines.push('下一条：' + fmt(next.at, cfg.beijing) + '（' + tzLabel() + '，' + rel(next.at) + '）');
    if (it) lines.push(it.kind === 'reply' ? '回复帖子 ' + it.tid + '：' + it.message.slice(0, 30) : '新帖《' + it.subject + '》');
  } else if (pend) lines.push('暂时排不出时间：可能都被规则挡住了，比如同帖回复上限，或者「不晚于」的时间已经来不及。');
  else lines.push('队列里没有待发的内容。');
  lines.push('待发 ' + pend + ' 条。');
  $('status').textContent = lines.join(NL);
  $('resume').classList.toggle('hide', !cfg.paused);
  $('postNow').disabled = !!posting || !pend;
  $('reroll').disabled = !cfg.enabled || !!cfg.paused || !pend;
}

function renderQueue() {
  const box = $('queue');
  box.innerHTML = '';
  const q = state.queue, bj = state.cfg.beijing;
  $('qcount').textContent = q.length ? '（共 ' + q.length + ' 条）' : '';
  for (const id of [...selected]) if (!q.some((x) => x.id === id && x.status !== 'posting')) selected.delete(id);
  syncSel();
  if (!q.length) { box.append(el('div', 'empty', '还没有内容，在上面添加。')); return; }
  q.forEach((it, i) => {
    const row = el('div', 'item st-' + it.status);
    const head = el('div', 'ihead');
    const cb = document.createElement('button');
    cb.type = 'button'; cb.dataset.toggle = ''; cb.textContent = '选择'; ToggleButton.attach(cb);
    cb.checked = selected.has(it.id);
    cb.disabled = ['posting','needs_review','waiting_human'].includes(it.status);
    cb.title = it.status === 'posting' ? '正在发送，不能删' : '选择后可批量删除';
    cb.onchange = () => { if (cb.checked) selected.add(it.id); else selected.delete(it.id); syncSel(); };
    head.append(cb,
      el('span', 'badge', '【' + (STATUS[it.status] || it.status) + '】'),
      el('span', 'kind', it.kind === 'reply' ? '回复' : '新帖'),
      el('span', 'ititle', it.kind === 'reply' ? '帖子 ' + it.tid : it.subject));
    row.append(head);
    row.append(el('div', 'isnip', it.message.slice(0, 120) + (it.message.length > 120 ? '……' : '')));
    const meta = [];
    if (it.at) meta.push('指定 ' + fmt(it.at, bj));
    else {
      meta.push('自动安排');
      if (it.notBefore) meta.push('不早于 ' + fmt(it.notBefore, bj));
      if (it.notAfter) meta.push('不晚于 ' + fmt(it.notAfter, bj));
    }
    if (state.next && state.next.id === it.id) meta.push('最先发：' + fmt(state.next.at, bj));
    else if ((it.status === 'pending' || it.status === 'retry') && it.plannedAt) meta.push('计划 ' + fmt(it.plannedAt, bj));
    if (it.status === 'retry' && it.retryAt) meta.push('约 ' + fmt(it.retryAt, bj) + ' 后重试');
    if (it.status === 'done' && it.postedAt) meta.push('发于 ' + fmt(it.postedAt, bj));
    if (it.error) meta.push('原因：' + it.error);
    if (it.note) meta.push(it.note);
    row.append(el('div', 'imeta', meta.join('　·　')));
    const ops = el('div', 'ops');
    const btn = (t, fn, dis) => { const b = el('button', 'mini', t); b.disabled = !!dis; b.onclick = fn; ops.append(b); };
    const locked = ['done','posting','needs_review','waiting_human'].includes(it.status);
    btn('上移', () => act({ type: 'POST_MOVE', id: it.id, dir: -1 }), i === 0);
    btn('下移', () => act({ type: 'POST_MOVE', id: it.id, dir: 1 }), i === q.length - 1);
    btn('编辑', () => edit(it), locked);
    if (it.status === 'failed' || it.status === 'expired' || it.status === 'held') btn('重新排队', () => act({ type: 'POST_RESET', id: it.id }));
    btn('立即发', () => { if (confirm('现在就发这一条？')) act({ type: 'POST_NOW', id: it.id }); }, locked || state.posting);
    btn('删除', () => { if (confirm('删除这一条？')) act({ type: 'POST_DELETE', id: it.id }); }, ['posting','needs_review','waiting_human'].includes(it.status));
    if (it.url) { const a = el('a', '', '打开帖子'); a.href = it.url; a.target = '_blank'; ops.append(a); }
    else if (it.kind === 'reply') { const a = el('a', '', '看目标帖'); a.href = threadUrl(it); a.target = '_blank'; ops.append(a); }
    row.append(ops);
    box.append(row);
  });
}

function renderLog() {
  const box = $('log');
  box.innerHTML = '';
  const log = state.log || [];
  if (!log.length) { box.append(el('div', 'empty', '还没有发帖记录。')); return; }
  log.forEach((e) => {
    const row = el('div', 'logrow');
    const what = (e.kind === 'reply' ? '回复 ' + e.tid : '新帖《' + (e.subject || '') + '》') + (e.manual ? '（手动）' : '');
    row.append(
      el('span', 'ltime', fmt(e.at, state.cfg.beijing)),
      el('span', 'lres', e.ok ? '成功' : '失败'),
      el('span', 'ltext', what + (e.ok ? '' : '　' + (e.error || ''))));
    if (e.url) { const a = el('a', '', '链接'); a.href = e.url; a.target = '_blank'; row.append(a); }
    box.append(row);
  });
}

function renderCfg() {
  const c = state.cfg;
  $('startHM').value = c.startHM;
  $('endHM').value = c.endHM;
  ['dailyMax', 'minGapMin', 'meanGapMin', 'quietDays', 'replyPerThreadDaily'].forEach((k) => ($(k).value = c[k]));
  $('noDoublePost').checked = c.noDoublePost !== false;
  $('myName').value = c.myName || '';
}

// ---------- 表单 ----------
const kindVal = () => document.querySelector('input[name=kind]:checked').value;
const whenVal = () => document.querySelector('input[name=when]:checked').value;
// 3.6.0：相对时间——现在就发 / N 分钟后 / 未来 N 小时内随机。保存时换算成绝对时间（或一个时间范围）
const relMode = () => (document.querySelector('input[name=rel]:checked') || {}).value || 'now';
function relSpec() {
  const now = Date.now(), m = relMode();
  if (m === 'after') return { at: now + Math.max(1, parseInt($('relMin').value, 10) || 10) * 60000 };
  if (m === 'within') return { notBefore: now, notAfter: now + Math.max(1, Math.min(72, parseInt($('relHours').value, 10) || 3)) * 3600000 };
  return { at: now + 30000 };
}
function syncForm() {
  const k = kindVal(), w = whenVal();
  document.querySelectorAll('.only-thread').forEach((x) => x.classList.toggle('hide', k !== 'thread'));
  document.querySelectorAll('.only-reply').forEach((x) => x.classList.toggle('hide', k !== 'reply'));
  $('onlyAt').classList.toggle('hide', w !== 'at');
  $('onlyAuto').classList.toggle('hide', w !== 'auto');
  $('onlyRel').classList.toggle('hide', w !== 'rel');
  const qa = $('quickAt'); if (qa) qa.classList.toggle('hide', w !== 'at');
}
function formMsg(t) { $('formMsg').textContent = t; }
function resetForm() {
  editingId = null;
  $('formTitle').textContent = '添加一条';
  $('save').textContent = '加入队列';
  $('cancel').classList.add('hide');
  ['subject', 'target', 'message', 'at', 'notBefore', 'notAfter'].forEach((k) => ($(k).value = ''));
  $('typeid').value = '';
}
function edit(it) {
  const bj = state.cfg.beijing;
  editingId = it.id;
  document.querySelector('input[name=kind][value=' + it.kind + ']').checked = true;
  $('fid').value = it.fid || '152';
  $('typeid').value = it.typeid || '';
  $('subject').value = it.subject || '';
  $('target').value = it.kind === 'reply' ? threadUrl(it) : '';
  $('message').value = it.message || '';
  document.querySelector('input[name=when][value=' + (it.at ? 'at' : 'auto') + ']').checked = true;
  $('at').value = toInput(it.at, bj);
  $('notBefore').value = toInput(it.notBefore, bj);
  $('notAfter').value = toInput(it.notAfter, bj);
  $('formTitle').textContent = '编辑这一条';
  $('save').textContent = '保存修改';
  $('cancel').classList.remove('hide');
  formMsg('');
  syncForm();
  $('formTitle').scrollIntoView({ behavior: 'smooth' });
}

$('save').onclick = async () => {
  if (!state) return;
  const bj = state.cfg.beijing;
  const item = { id: editingId || undefined, kind: kindVal(), fid: $('fid').value, typeid: $('typeid').value,
    subject: $('subject').value, target: $('target').value, message: $('message').value };
  if (whenVal() === 'rel') {
    Object.assign(item, relSpec());
  } else if (whenVal() === 'at') {
    item.at = fromInput($('at').value, bj);
    if (!item.at) return formMsg('请选择指定时间。');
    if (item.at < Date.now()) return formMsg('指定的时间已经过去了。');
  } else {
    item.notBefore = fromInput($('notBefore').value, bj);
    item.notAfter = fromInput($('notAfter').value, bj);
  }
  const r = await send({ type: 'POST_SAVE_ITEM', item });
  if (!r || !r.ok) return formMsg((r && r.error) || '保存失败');
  formMsg((editingId ? '已更新。' : '已加入队列。') + (state.cfg.enabled ? '' : '（定时发帖还没开启，记得打开右上角的开关）'));
  resetForm();
  await load();
};
$('cancel').onclick = () => { resetForm(); formMsg(''); };
document.querySelectorAll('input[name=kind],input[name=when]').forEach((r) => r.addEventListener('change', syncForm));

// ---------- 顶部 ----------
$('enabled').onchange = (e) => act({ type: 'POST_SET_CFG', cfg: { enabled: e.target.checked } });
$('reroll').onclick = () => act({ type: 'POST_REROLL' });
$('resume').onclick = () => act({ type: 'POST_RESUME' });
$('postNow').onclick = () => { if (confirm('现在就发排在最前面的那一条？')) act({ type: 'POST_NOW' }); };
$('clearDone').onclick = () => act({ type: 'POST_CLEAR_DONE' });

// ---------- 批量删除（3.3.0） ----------
function selectable() { return state ? state.queue.filter((x) => x.status !== 'posting') : []; }
function syncSel() {
  const all = selectable();
  $('selN').textContent = selected.size;
  $('delSel').disabled = !selected.size;
  $('delAll').disabled = !all.length;
  $('selAll').checked = all.length > 0 && all.every((x) => selected.has(x.id));
}
$('selAll').onchange = (e) => {
  selected.clear();
  if (e.target.checked) selectable().forEach((x) => selected.add(x.id));
  renderQueue();
};
$('delSel').onclick = async () => {
  if (!selected.size) return;
  if (!confirm('删除选中的 ' + selected.size + ' 条？删了不能恢复。')) return;
  const ids = [...selected];
  selected.clear();
  await act({ type: 'POST_DELETE_MANY', ids });
};
$('delAll').onclick = async () => {
  const n = selectable().length;
  if (!n) return;
  if (!confirm('把队列里的 ' + n + ' 条全部删除？（包括已发出的记录条目；正在发送的那一条除外）删了不能恢复。')) return;
  selected.clear();
  const r = await act({ type: 'POST_DELETE_ALL' });
  if (r && r.ok) formMsg('已删除 ' + r.removed + ' 条。');
};

// ---------- 北京时间时钟、快捷选时间（3.3.0） ----------
function bjNowText() { return fmt(Date.now(), true); }
function tickClock() { $('bjNow').textContent = bjNowText(); }
tickClock();
setInterval(tickClock, 15000);
function syncQuick() { $('quickAt').classList.toggle('hide', whenVal() !== 'at'); }
document.querySelectorAll('input[name=when]').forEach((r) => r.addEventListener('change', syncQuick));
document.querySelectorAll('#quickAt button').forEach((b) => {
  b.onclick = () => {
    let ms;
    if (b.dataset.add) {
      ms = Date.now() + Number(b.dataset.add) * 60000;
    } else {
      const p = parts(Date.now(), true);
      const [h, mi] = b.dataset.hm.split(':').map(Number);
      ms = Date.UTC(p.y, p.m, p.d + Number(b.dataset.day), h, mi) - BJ;
      if (ms < Date.now()) ms += 86400000; // 今晚已经过了就顺延到明天
    }
    $('at').value = toInput(ms, true);
    formMsg('已填：' + fmt(ms, true) + '（北京时间）');
  };
});

// ---------- 规则 ----------
CFG_KEYS.forEach((k) => { $(k).addEventListener('input', () => (cfgDirty = true)); $(k).addEventListener('change', () => (cfgDirty = true)); });
$('saveCfg').onclick = async () => {
  const cfg = { startHM: $('startHM').value, endHM: $('endHM').value };
  ['dailyMax', 'minGapMin', 'meanGapMin', 'quietDays', 'replyPerThreadDaily'].forEach((k) => (cfg[k] = $(k).value));
  cfg.noDoublePost = $('noDoublePost').checked;
  cfg.myName = $('myName').value;
  const r = await send({ type: 'POST_SET_CFG', cfg });
  cfgDirty = false;
  $('cfgMsg').textContent = r && r.ok ? '已保存，下一条的时间已按新规则重新安排。' : ((r && r.error) || '保存失败');
  await load();
};

// ---------- 导入导出 ----------
$('export').onclick = () => {
  if (!state) return;
  const items = state.queue.filter((x) => x.status !== 'done').map((x) => ({
    kind: x.kind, fid: x.fid, typeid: x.typeid || '', subject: x.subject || '',
    target: x.kind === 'reply' ? threadUrl(x) : '', message: x.message,
    at: x.at || null, notBefore: x.notBefore || null, notAfter: x.notAfter || null,
  }));
  const blob = new Blob([JSON.stringify({ app: 'my0511-post', version: 1, queue: items }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = 'my0511发帖队列-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('ioMsg').textContent = '已导出 ' + items.length + ' 条。';
};
$('importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (err) { $('ioMsg').textContent = '文件不是有效的 JSON：' + err.message; e.target.value = ''; return; }
  const r = await send({ type: 'POST_IMPORT', data });
  e.target.value = '';
  $('ioMsg').textContent = r && r.ok
    ? '导入了 ' + r.added + ' 条。' + (r.errors.length ? NL + '没导入的：' + NL + r.errors.join(NL) : '')
    : ((r && r.error) || '导入失败');
  await load();
};
$('sample').textContent = '示例：' + NL + JSON.stringify([
  { kind: 'thread', fid: 152, typeid: 341, subject: '标题写这里', message: '正文写这里，可以多行。' },
  { kind: 'reply', target: 'https://bbs.my0511.com/f152b-t9083846z', message: '回复内容' },
  { kind: 'thread', fid: 152, subject: '指定时间发的帖子', message: '正文', at: '2026-10-01 20:30' },
], null, 2) + NL + NL + 'kind：thread＝发新帖，reply＝回复。at 不填就自动安排；也可以填 notBefore / notAfter 限定范围。所有时间都按北京时间理解。';

syncForm();
load();
setInterval(load, 5000);

// 点「N 分钟后」「未来 N 小时」里的数字框，自动选中对应那一项
['relMin', 'relHours'].forEach((id) => $(id).addEventListener('focus', () => {
  $(id).closest('label').querySelector('input[type=radio]').checked = true;
  document.dispatchEvent(new Event('relchange'));
}));
document.querySelectorAll('input[name=rel]').forEach((r) => r.addEventListener('change', () => document.dispatchEvent(new Event('relchange'))));
