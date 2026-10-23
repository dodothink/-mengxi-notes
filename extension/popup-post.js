// 弹出面板里的「定时发帖」标签页（3.0.0 新增）。原来的采集界面整体放进「采集」标签，功能不变。
(function () {
  const NL = String.fromCharCode(10);
  const BJ = 8 * 3600000;
  const g = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  const body = document.body;
  const head = body.querySelector('.head');
  const collect = document.createElement('div');
  collect.id = 'tabCollect';
  Array.from(body.children).forEach((n) => { if (n !== head && n.tagName !== 'SCRIPT') collect.append(n); });

  const bar = document.createElement('div');
  bar.className = 'tabs';
  const b1 = document.createElement('button'); b1.textContent = '采集';
  const b2 = document.createElement('button'); b2.textContent = '定时发帖';
  const b3 = document.createElement('button'); b3.textContent = '存档';
  b3.onclick = () => chrome.runtime.openOptionsPage();
  const b4 = document.createElement('button'); b4.textContent = '工作台';
  b4.onclick = () => chrome.tabs.create({url:chrome.runtime.getURL('control.html')});
  bar.append(b1, b3, b4, b2);

  const post = document.createElement('div');
  post.id = 'tabPost';
  post.className = 'hide';
  post.innerHTML = [
    '<button class=toggle id=pEnabled aria-pressed=false data-label=定时发帖>定时发帖 · 已关闭</button>',
    '<div class=status id=pStatus>读取中……</div>',
    '<div class=row><button id=pOpen class=go>打开发帖管理</button><button id=pResume class=hide>恢复运行</button></div>',
    '<h2 class=sec>最近一次</h2>',
    '<div class=status id=pLast>—</div>',
  ].join('');

  head.after(bar);
  bar.after(collect);
  collect.after(post);

  function fmt(ms, bj) {
    const d = new Date(bj ? ms + BJ : ms);
    const m = bj ? d.getUTCMonth() : d.getMonth(), day = bj ? d.getUTCDate() : d.getDate();
    const h = bj ? d.getUTCHours() : d.getHours(), mi = bj ? d.getUTCMinutes() : d.getMinutes();
    return (m + 1) + '月' + day + '日 ' + pad(h) + ':' + pad(mi);
  }
  function rel(ms) {
    const m = Math.round((ms - Date.now()) / 60000);
    if (m < 1) return '一分钟内';
    if (m < 60) return m + ' 分钟后';
    const h = Math.floor(m / 60);
    return h < 48 ? h + ' 小时 ' + (m % 60) + ' 分后' : Math.round(h / 24) + ' 天后';
  }

  async function refresh() {
    const s = await chrome.runtime.sendMessage({ type: 'POST_STATE', logN: 1 });
    if (!s || !s.ok) { g('pStatus').textContent = '读不到发帖状态。'; return; }
    const c = s.cfg, bj = c.beijing, tz = bj ? '北京时间' : '本机时间';
    toggleState(g('pEnabled'), !!c.enabled);
    const pend = s.queue.filter((x) => x.status === 'pending' || x.status === 'retry').length;
    const failed = s.queue.filter((x) => x.status === 'failed').length;
    const lines = [];
    if (s.posting) lines.push('正在发帖……');
    if (!c.enabled) lines.push('定时发帖已关闭。');
    else if (c.paused) lines.push('已暂停：' + c.paused);
    else if (s.next) {
      const it = s.queue.find((x) => x.id === s.next.id);
      lines.push('下一条：' + fmt(s.next.at, bj) + '（' + tz + '，' + rel(s.next.at) + '）');
      if (it) lines.push(it.kind === 'reply' ? '回复帖子 ' + it.tid : '新帖《' + it.subject + '》');
    } else if (pend) lines.push('暂时排不出时间，打开发帖管理看看规则。');
    lines.push('待发 ' + pend + ' 条' + (failed ? '，失败 ' + failed + ' 条' : '') + '。');
    g('pStatus').textContent = lines.join(NL);
    g('pResume').classList.toggle('hide', !c.paused);
    const e = s.log && s.log[0];
    g('pLast').textContent = e
      ? fmt(e.at, bj) + '　' + (e.ok ? '成功' : '失败') + '　' + (e.kind === 'reply' ? '回复 ' + e.tid : '《' + (e.subject || '') + '》') + (e.ok ? '' : NL + (e.error || ''))
      : '还没有发过。';
  }

  function show(t) {
    const p = t === 'post';
    b1.classList.toggle('on', !p);
    b2.classList.toggle('on', p);
    collect.classList.toggle('hide', p);
    post.classList.toggle('hide', !p);
    chrome.storage.local.set({ popupTab: t });
    if (p) refresh();
  }
  b1.onclick = () => show('collect');
  b2.onclick = () => show('post');
  chrome.storage.local.get('popupTab').then((o) => show(o.popupTab === 'post' ? 'post' : 'collect'));

  g('pEnabled').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'POST_SET_CFG', cfg: { enabled: !selected(g('pEnabled')) } });
    if (!r?.ok) { g('pStatus').textContent = r?.error || '设置失败'; return; }
    refresh();
  };
  g('pResume').onclick = async () => { await chrome.runtime.sendMessage({ type: 'POST_RESUME' }); refresh(); };
  g('pOpen').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('posting.html') });
  setInterval(() => { if (!post.classList.contains('hide')) refresh(); }, 3000);
})();
