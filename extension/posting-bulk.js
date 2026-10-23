// 批量添加（3.1.0 新增）：正文里用一行分隔符隔开，一次加入多条。
// 挂在 posting.js 之后加载，复用它的全局函数和状态，不改原来的单条添加逻辑。
(function () {
  const EXAMPLE_REPLY = ['第一条回复', '===', '第二条回复，可以写多行', '也没问题', '===', '第三条回复'].join(NL);
  const EXAMPLE_THREAD = ['第一个帖子的标题', '第一个帖子的正文……', '===', '第二个帖子的标题', '第二个帖子的正文……'].join(NL);

  const msgField = $('message').closest('.field');
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = '<span class=lab>批量添加</span><label><button type=button data-toggle id=bulk>批量拆分</button> 按分隔符拆成多条</label>'
    + '<span>分隔符 <input id=sep class=num></span>';
  msgField.after(row);

  const hint = document.createElement('div');
  hint.className = 'field hide';
  hint.innerHTML = '<span class=lab></span><span class=dim id=bulkHint></span>';
  row.after(hint);

  const gapRow = document.createElement('div');
  gapRow.className = 'field hide';
  gapRow.innerHTML = '<span class=lab>批量间隔</span>第一条按设定的时间发，之后每条间隔 '
    + '<input type=number id=gapMin min=1 class=num> 分钟，随机浮动 ± <input type=number id=jitter min=0 max=90 class=num> %';
  $('onlyRel').after(gapRow);

  const sepVal = () => ($('sep').value || '===').trim() || '===';

  function segments() {
    const sep = sepVal();
    const out = [];
    let cur = [];
    $('message').value.split(NL).forEach((line) => {
      if (line.trim() === sep) { out.push(cur.join(NL)); cur = []; }
      else cur.push(line);
    });
    out.push(cur.join(NL));
    return out.map((s) => s.trim()).filter(Boolean);
  }

  function sync() {
    ToggleButton.attach($('bulk'));
    const on = $('bulk').checked && !editingId;
    const k = kindVal(), w = whenVal();
    row.classList.toggle('hide', !!editingId);
    hint.classList.toggle('hide', !on);
    const fixed = w === 'at' || (w === 'rel' && relMode() !== 'within');
    gapRow.classList.toggle('hide', !(on && fixed));
    $('subject').closest('.field').classList.toggle('hide', k !== 'thread' || on);
    $('message').placeholder = on ? (k === 'thread' ? EXAMPLE_THREAD : EXAMPLE_REPLY) : '';
    if (on) {
      const n = segments().length;
      $('bulkHint').textContent = '现在能拆成 ' + n + ' 条。条与条之间放一行只写「' + sepVal() + '」的分隔行。'
        + (k === 'thread' ? '发新帖时每段第一行当标题，其余是正文。' : '每段是一条回复，都回复到上面填的那个帖子。');
    }
  }

  async function savePrefs() {
    await chrome.storage.local.set({ bulkPrefs: {
      on: $('bulk').checked, sep: sepVal(), gapMin: $('gapMin').value, jitter: $('jitter').value,
    } });
  }

  const origSave = $('save').onclick;
  $('save').onclick = async () => {
    if (!$('bulk').checked || editingId) return origSave();
    if (!state) return;
    const bj = state.cfg.beijing, k = kindVal();
    const segs = segments();
    if (!segs.length) return formMsg('正文是空的。');
    const base = { kind: k, fid: $('fid').value, typeid: $('typeid').value, target: $('target').value };
    let at = null, notBefore = null, notAfter = null;
    if (whenVal() === 'rel') {
      const r = relSpec();
      at = r.at || null; notBefore = r.notBefore || null; notAfter = r.notAfter || null;
    } else if (whenVal() === 'at') {
      at = fromInput($('at').value, bj);
      if (!at) return formMsg('请选择第一条的指定时间。');
      if (at < Date.now()) return formMsg('指定的时间已经过去了。');
    } else {
      notBefore = fromInput($('notBefore').value, bj);
      notAfter = fromInput($('notAfter').value, bj);
    }
    const gap = Math.max(1, parseInt($('gapMin').value, 10) || 10) * 60000;
    const jit = Math.max(0, Math.min(90, parseInt($('jitter').value, 10) || 0)) / 100;
    let t = at;
    const items = segs.map((seg, i) => {
      const it = Object.assign({}, base);
      if (k === 'thread') {
        const lines = seg.split(NL);
        it.subject = lines[0].trim();
        it.message = lines.slice(1).join(NL).trim();
      } else {
        it.message = seg;
      }
      if (at) {
        if (i > 0) t += gap * (1 + (Math.random() * 2 - 1) * jit);
        it.at = Math.round(t);
      } else {
        it.notBefore = notBefore;
        it.notAfter = notAfter;
      }
      return it;
    });
    const r = await send({ type: 'POST_IMPORT', data: items });
    if (!r || !r.ok) return formMsg((r && r.error) || '添加失败');
    const m = ['已加入 ' + r.added + ' 条。'];
    if (r.errors.length) m.push('没加入的：' + NL + r.errors.join(NL));
    if (at && r.added) m.push('第一条 ' + fmt(at, bj) + '，最后一条大约 ' + fmt(t, bj) + '。');
    if (!at && !notAfter && state.cfg.dailyMax && r.added > state.cfg.dailyMax) {
      m.push('提醒：自动安排受「每天最多 ' + state.cfg.dailyMax + ' 条」限制，这批要好几天才能发完，可以在下面规则里调大，或者改用指定时间加间隔。');
    }
    if (!state.cfg.enabled) m.push('（定时发帖还没开启，记得打开右上角的开关）');
    formMsg(m.join(NL));
    if (!r.errors.length) resetForm();
    await savePrefs();
    await load();
    sync();
  };

  const origEdit = edit;
  edit = function (it) { origEdit(it); sync(); };

  $('bulk').addEventListener('change', () => { sync(); savePrefs(); });
  $('sep').addEventListener('input', sync);
  $('message').addEventListener('input', () => { if ($('bulk').checked) sync(); });
  document.querySelectorAll('input[name=kind],input[name=when]').forEach((r) => r.addEventListener('change', sync));
  $('cancel').addEventListener('click', () => setTimeout(sync, 0));
  document.addEventListener('relchange', sync);

  chrome.storage.local.get('bulkPrefs').then((o) => {
    const p = o.bulkPrefs || {};
    $('bulk').checked = !!p.on;
    $('sep').value = p.sep || '===';
    $('gapMin').value = p.gapMin || 10;
    $('jitter').value = p.jitter != null && p.jitter !== '' ? p.jitter : 30;
    sync();
  });
})();
