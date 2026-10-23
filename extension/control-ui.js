// 工作台（纯插件版）：运行控制、人工验证、需要核实的发帖、最近事件、备份浏览器数据
const $=id=>document.getElementById(id);let latest;
async function send(m){const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw new Error(r?.error||'后台没有响应');return r;}
async function refresh(){latest=await send({type:'CONTROL_STATUS'});$('status').textContent=`采集：${latest.haltCollect?'暂停':'允许运行'} · 发帖：${latest.haltPost?'暂停':'允许运行'} · 待采 ${latest.queued} 条`;
$('human').hidden=!latest.challenge;$('reason').textContent=latest.challenge?.reason||'';
$('events').textContent=latest.log.map(x=>new Date(x.at).toLocaleTimeString()+' '+x.type+(x.error?' · '+x.error:'')).join('\n')||'暂无事件';
$('reviews').replaceChildren();for(const p of latest.posts.filter(x=>x.status==='needs_review')){const a=document.createElement('article');a.textContent=(p.subject||'回复帖子 '+p.tid)+'：'+p.error;
for(const [text,result] of [['已在论坛确认发出','posted'],['已确认没有发出','not_posted']]){const b=document.createElement('button');b.textContent=text;b.onclick=()=>act(async()=>{if(!confirm(text+'？此判断将更新任务状态。'))return;await send({type:'POST_REVIEW',id:p.id,result});await refresh();});a.append(b);}$('reviews').append(a);}}
async function act(fn){$('notice').textContent='';try{await fn();}catch(e){$('notice').textContent=e.message;}}
$('refresh').onclick=()=>act(refresh);$('pause').onclick=()=>act(async()=>{await send({type:'CONTROL_PAUSE',scope:'all'});await refresh();});
for(const [id,scope]of[['resumeCollect','collect'],['resumePost','post']])$(id).onclick=()=>act(async()=>{await send({type:'CONTROL_RESUME',scope});await refresh();});
$('openChallenge').onclick=()=>act(()=>send({type:'CONTROL_OPEN_CHALLENGE'}));$('verifyChallenge').onclick=()=>act(async()=>{await send({type:'CONTROL_VERIFY_CHALLENGE',id:latest.challenge.id});await refresh();});
$('backup').onclick=()=>act(async()=>{const r=await send({type:'CONTROL_BACKUP'}),a=document.createElement('a'),u=URL.createObjectURL(new Blob([JSON.stringify(r.data,null,2)],{type:'application/json'}));a.href=u;a.download='my0511-browser-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);});
act(refresh);
