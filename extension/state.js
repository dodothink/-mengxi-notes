// Persistent safety state and serialized mutations. No third-party credentials here.
const Safety = (() => {
  const locks = new Map();
  function serial(name, fn) {
    const previous = locks.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(name, next);
    next.finally(() => { if (locks.get(name) === next) locks.delete(name); }).catch(() => {});
    return next;
  }
  const read = async (key, fallback) => (await chrome.storage.local.get(key))[key] ?? fallback;
  const write = (key, value) => chrome.storage.local.set({ [key]: value });
  const update = (key, fn, fallback) => serial('storage:' + key, async () => {
    const value = await fn(await read(key, fallback));
    await write(key, value); return value;
  });
  const id = () => crypto.randomUUID();
  const ready = (async () => {
    if (chrome.storage.local.setAccessLevel) await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (!(await read('safety380', null))) {
      await chrome.storage.local.set({ safety380: { version: 1, profileId: id(), migratedAt: Date.now() }, haltCollect: true, haltPost: true });
    }
  })();
  async function event(type, detail = {}) {
    const safe = { at: Date.now(), type, ...detail };
    await update('automationLog', list => [...list, safe].slice(-500), []);
  }
  async function challenge(info) {
    await ready;
    const result = await update('humanChallenge', current => current?.status === 'waiting_human'
      ? { ...current, ...(info.tabId != null ? { tabId: info.tabId, url: info.url || current.url } : {}) }
      : { id: id(), status: 'waiting_human', createdAt: Date.now(), ...info }, null);
    await event('waiting_human', { challengeId: result.id, taskId: result.taskId || null });
    return result;
  }
  async function blocked() { await ready; return !!(await read('humanChallenge', null)); }
  async function assertRunnable(kind) {
    await ready;
    if (await read(kind === 'post' ? 'haltPost' : 'haltCollect', false)) throw Object.assign(new Error('用户已暂停'), { paused: true });
    if (await blocked()) throw Object.assign(new Error('等待人工处理验证或登录'), { paused: true });
  }
  function forumUrl(value) {
    const u = new URL(value);
    if (u.origin !== 'https://bbs.my0511.com' || u.username || u.password) throw new Error('仅允许梦溪论坛 HTTPS 地址');
    return u.href;
  }
  function ownPage(sender) { return sender?.id === chrome.runtime.id && (!sender.url || sender.url.startsWith(chrome.runtime.getURL(''))); }
  return { serial, read, write, update, id, ready, event, challenge, blocked, assertRunnable, forumUrl, ownPage };
})();
