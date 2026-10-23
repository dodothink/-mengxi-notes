// Local controls and human-intervention workflow. Never treats a remote resume as CAPTCHA success.
const Control = (() => {
  async function status() {
    await Safety.ready;
    const keys = ['safety380','haltCollect','haltPost','humanChallenge','job','queue','postQueue','automationLog'];
    const s = await chrome.storage.local.get(keys);
    return { ok:true, build:'4.2.5', profileId:s.safety380.profileId, haltCollect:!!s.haltCollect,haltPost:!!s.haltPost,
      challenge:s.humanChallenge || null, job:s.job || null, queued:s.queue?.length || 0,
      posts:(s.postQueue || []).map(x=>({id:x.id,status:x.status,kind:x.kind,tid:x.tid,subject:x.subject,error:x.error,tabId:x.tabId})),
      log:(s.automationLog || []).slice(-40) };
  }
  async function pause(scope, paused) {
    if (!['all','collect','post'].includes(scope)) throw new Error('暂停范围无效');
    await Safety.ready;
    if (!paused && await Safety.blocked()) throw new Error('人工验证尚未核实，无法恢复');
    const changes = {};
    if (scope !== 'post') changes.haltCollect = paused;
    if (scope !== 'collect') changes.haltPost = paused;
    await chrome.storage.local.set(changes);
    await Safety.event(paused?'paused':'resumed',{scope});
    if (!paused) { Collector.runJob().catch(()=>{}); await Poster.reschedule(true); }
    return status();
  }
  async function openChallenge() {
    const c = await Safety.read('humanChallenge', null);
    if (!c) throw new Error('没有待处理验证');
    if (c.tabId != null) {
      try { const tab = await chrome.tabs.get(c.tabId); Safety.forumUrl(tab.url); await chrome.tabs.update(c.tabId,{active:true}); return {ok:true}; } catch(e) {}
    }
    const tab = await chrome.tabs.create({url:Safety.forumUrl(c.url),active:true});
    await Safety.update('humanChallenge', current => current?.id === c.id ? {...current,tabId:tab.id} : current, null);
    return {ok:true};
  }
  async function verifyChallenge(id) {
    const c = await Safety.read('humanChallenge', null);
    if (!c || c.id !== id || c.tabId == null) throw new Error('验证现场已改变，请重新打开');
    const tab = await chrome.tabs.get(c.tabId); Safety.forumUrl(tab.url);
    const [r] = await chrome.scripting.executeScript({target:{tabId:c.tabId},func:()=>({
      url:location.href,title:document.title,
      challenge:location.pathname==='/captcha' || !!document.querySelector('input[name*=seccode],input[name*=secqaa],iframe[src*=captcha]') || /安全验证|人机验证|访问验证|Just a moment/i.test(document.title),
      normal:!!document.querySelector('div.outer-section,dl.list_dl,#postform,#consnav'),
      login:/需要登录后才能浏览|请先登录/.test(document.body.innerText.slice(0,1000))
    })});
    if (!r?.result || r.result.challenge || r.result.login || !r.result.normal) throw new Error('尚未确认回到正常论坛页面，保持暂停');
    Safety.forumUrl(r.result.url);
    await Safety.update('humanChallenge', current => { if(current?.id!==id) throw new Error('挑战已更新'); return null; }, null);
    await Safety.update('job', j=> j?.state==='waiting_human'?{...j,state:'running',error:''}:j,null);
    await Safety.update('postQueue', q=>q.map(x=>x.status==='waiting_human'?{...x,status:'held',note:'验证已完成，请再次确认发送',plannedAt:null}:x),[]);
    await Safety.event('human_verified',{challengeId:id});
    // User pause flags remain untouched. Read tasks can continue; held replies require explicit confirmation.
    Collector.runJob().catch(()=>{});
    return status();
  }
  async function handle(msg) {
    if(msg.type==='CONTROL_STATUS') return status();
    if(msg.type==='CONTROL_PAUSE') return pause(msg.scope || 'all',true);
    if(msg.type==='CONTROL_RESUME') return pause(msg.scope || 'all',false);
    if(msg.type==='CONTROL_OPEN_CHALLENGE') return openChallenge();
    if(msg.type==='CONTROL_VERIFY_CHALLENGE') return verifyChallenge(msg.id);
    if(msg.type==='CONTROL_BACKUP') {
      const all=await chrome.storage.local.get(null); delete all.draftToFill;
      return {ok:true,data:all};
    }
    throw new Error('未知控制指令');
  }
  chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
    if(!Safety.ownPage(sender) || !msg?.type?.startsWith('CONTROL_')) return;
    handle(msg).then(respond,e=>respond({ok:false,error:e.message}));return true;
  });
  // 4.0 接口：打开论坛回复页并把文字填进回复框。只填入，永不点发表。
  async function fillReply(msg) {
    if(!/^\d+$/.test(String(msg.tid)) || !/^\d+$/.test(String(msg.fid)) || typeof msg.message!=='string' || !msg.message.trim() || msg.message.length>5000) throw new Error('草稿内容无效');
    const tab=await chrome.tabs.create({url:'about:blank',active:true});
    await Safety.write('draftToFill',{tabId:tab.id,message:msg.message,tid:String(msg.tid),fid:String(msg.fid),createdAt:Date.now()});
    await chrome.tabs.update(tab.id,{url:`https://bbs.my0511.com/post.php?action=reply&fid=${msg.fid}&tid=${msg.tid}`});
    return {ok:true,tabId:tab.id};
  }
  async function fillPendingDraft(tabId) {
    return Safety.serial('draft-fill',async()=>{
      const d=await Safety.read('draftToFill',null);if(!d || d.tabId!==tabId)return;
      const clear=()=>Safety.update('draftToFill',current=>current?.tabId===d.tabId&&current?.createdAt===d.createdAt&&current?.message===d.message?null:current,null);
      if(Date.now()-d.createdAt>120000){await clear();throw new Error('回复页加载超时，草稿仍在工作台，请再次填入');}
      const tab=await chrome.tabs.get(tabId);
      // The initial blank document can finish before navigation to post.php.
      if(!tab.url||tab.url==='about:blank'||tab.status==='loading')return;
      const u=new URL(Safety.forumUrl(tab.url));
      if(u.pathname!=='/post.php'||u.searchParams.get('action')!=='reply'||u.searchParams.get('tid')!==d.tid||u.searchParams.get('fid')!==d.fid)return;
      const [filled]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:(message,tid,fid)=>{
        const u=new URL(location.href);
        if(u.origin!=='https://bbs.my0511.com'||u.pathname!=='/post.php'||u.searchParams.get('action')!=='reply'||u.searchParams.get('tid')!==tid||u.searchParams.get('fid')!==fid)return {ok:false,error:'页面已变化，未写入草稿'};
        const f=document.getElementById('postform');const ta=f?.querySelector('textarea[name=message]');
        if(!ta)return {ok:false,error:'没有找到回复输入框，请确认已登录且页面已加载'};
        // Discuz uses a hidden textarea while the rich text editor is active.
        if(!ta.getClientRects().length&&typeof window.switchEditor==='function')window.switchEditor(0);
        if(!ta.getClientRects().length)return {ok:false,error:'回复编辑器尚未就绪，请再次填入'};
        if(ta.value.trim()&&ta.value!==message)return {ok:false,error:'论坛回复框已有内容，未覆盖你的文字'};
        ta.value=message;ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new Event('change',{bubbles:true}));ta.focus();
        return {ok:ta.value===message};
        // Only fill. Never submit or click the publish button.
      },args:[d.message,d.tid,d.fid]});
      if(!filled?.result?.ok)throw new Error(filled?.result?.error||'填入未确认，草稿仍保留，请再次尝试');
      await clear();
      await Safety.event('draft_filled',{tid:d.tid});
    });
  }
  chrome.tabs.onUpdated.addListener((tabId,info)=>{
    if(info.status==='complete')fillPendingDraft(tabId).catch(e=>Safety.event('draft_fill_failed',{error:e.message}));
  });
  return {status,pause,handle,fillReply,fillPendingDraft,openChallenge,verifyChallenge};
})();
