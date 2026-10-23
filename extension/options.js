const cur = document.getElementById('cur');
const msg = document.getElementById('msg');

async function show() {
  const st = await FS.handleState();
  cur.textContent = st.has ? st.name + (st.perm === 'granted' ? '' : '（需重新授权）') : '下载文件夹';
}

document.getElementById('pick').onclick = async () => {
  msg.textContent = '';
  try {
    const h = await showDirectoryPicker({ mode: 'readwrite', id: 'my0511' });
    const perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      msg.textContent = '没有取得写入权限，暂时还是存到下载文件夹。';
      return;
    }
    await FS.setHandle(h);
    await chrome.runtime.sendMessage({ type: 'SET', key: 'useFolder', value: true });
    msg.textContent = '好了，以后导出的帖子都会写进这个文件夹。';
  } catch (e) {
    if (e && e.name !== 'AbortError') msg.textContent = '没能选中文件夹：' + (e.message || e);
  }
  show();
};

document.getElementById('clear').onclick = async () => {
  await FS.clearHandle();
  await chrome.runtime.sendMessage({ type: 'SET', key: 'useFolder', value: false });
  msg.textContent = '以后导出到「下载 / My0511存档」。';
  show();
};

const sweepEnabled = document.getElementById('sweepEnabled');
const sweepPages = document.getElementById('sweepPages');
const sweepMsg = document.getElementById('sweepMsg');

async function showSweep() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_SWEEP' });
  if (!s || !s.ok) return;
  sweepEnabled.checked = !!s.sweepEnabled;
  sweepPages.value = s.sweepPages || 2;
  const rg = s.sweepRange || { min: 10, max: 20 };
  document.getElementById('sweepMin').value = rg.min;
  document.getElementById('sweepMax').value = rg.max;
}

sweepEnabled.onchange = async (e) => {
  await chrome.runtime.sendMessage({ type: 'SET', key: 'sweepEnabled', value: e.target.checked });
  sweepMsg.textContent = e.target.checked ? '已开启，按设置的间隔自动巡查，也可以在插件面板里「立即巡查」。' : '已关闭自动巡查。';
};

document.getElementById('savePages').onclick = async () => {
  const n = Math.max(1, Math.min(10, parseInt(sweepPages.value, 10) || 2));
  sweepPages.value = n;
  await chrome.runtime.sendMessage({ type: 'SET', key: 'sweepPages', value: n });
  sweepMsg.textContent = '已保存，下次巡查生效。';
};

document.getElementById('saveRange').onclick = async () => {
  const min = parseInt(document.getElementById('sweepMin').value, 10), max = parseInt(document.getElementById('sweepMax').value, 10);
  const r = await chrome.runtime.sendMessage({ type: 'SET', key: 'sweepRange', value: { min, max } });
  if (!r || !r.ok) { sweepMsg.textContent = '保存失败：' + ((r && r.error) || ''); return; }
  await showSweep();
  const s = await chrome.runtime.sendMessage({ type: 'GET_SWEEP' });
  const t = s && s.sweepNextAt ? new Date(s.sweepNextAt) : null;
  sweepMsg.textContent = `已保存：每隔 ${s.sweepRange.min}～${s.sweepRange.max} 分钟随机巡查一次。` + (t ? `下次约 ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}。` : '');
};

show();
showSweep();

document.getElementById('openWorkbench').onclick = () => chrome.tabs.create({url:chrome.runtime.getURL('control.html')});

// 4.2.3：导出 / 导入队列和设置
const bkMsg = document.getElementById('bkMsg');
document.getElementById('bkExport').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'BACKUP_EXPORT' });
  if (!r || !r.ok) { bkMsg.textContent = '导出失败：' + ((r && r.error) || '未知错误'); return; }
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const name = `My0511备份_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  bkMsg.textContent = `已导出：待采 ${r.data.queue.length} 个，定时发帖 ${r.data.postQueue.length} 条，自动跟进 ${r.data.watch.length} 个，跳过记录 ${r.data.skipped.length} 个。文件在「下载」里：${name}`;
};
document.getElementById('bkImport').onclick = () => document.getElementById('bkFile').click();
document.getElementById('bkFile').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (err) { bkMsg.textContent = '这个文件读不了，不是有效的 JSON。'; return; }
  const r = await chrome.runtime.sendMessage({ type: 'BACKUP_IMPORT', data });
  if (!r || !r.ok) { bkMsg.textContent = '导入失败：' + ((r && r.error) || '未知错误'); return; }
  bkMsg.textContent = `已导入：队列新增 ${r.added} 个（现在共 ${r.queued} 个），自动跟进 ${r.watched} 个，跳过记录 ${r.skipped} 个，定时发帖 ${r.posts} 条（暂缓），设置 ${r.settings} 项。\n采集目前暂停，在插件面板点「▶ 恢复采集」开始。`;
  show(); showSweep();
};
