import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
function boot(extra={}){const w=worker({safety380:{profileId:'p1'},migr340:true,haltCollect:false,haltPost:true,...extra});w.notes=[];w.chrome.notifications={create:async(id,o)=>{w.notes.push([id,o.title]);},clear:()=>{},onClicked:{addListener(){}}};return w;}
const page=(w,html,url='https://bbs.my0511.com/f152b')=>{const buf=new TextEncoder().encode(html).buffer;w.c.fetch=async()=>({ok:true,status:200,url,headers:{get:()=>'text/html; charset=utf-8'},arrayBuffer:async()=>buf});};
const okBoard='<html><head><title>百姓话题</title></head><body>'+'<dl class="list_dl"><a class="a_topic" href="/f152b-t1z">x</a></dl>'.repeat(3)+'</body></html>';
const captcha='<html><head><title>安全验证</title></head><body>34+8=?<input name="captcha"></body></html>';
const MIN=60000;
test('4.4 watchdog: a challenge pause notifies at once, then only every remind interval',async()=>{
 const w=boot({humanChallenge:{id:'c1',kind:'captcha',createdAt:Date.now()-5*MIN,url:'https://bbs.my0511.com/f152b'},watchdog:{notify:true,autoResume:false,remindMin:120,staleHours:6}});await w.eval('Safety.ready');
 await w.eval('watchdogTick()');assert.equal(w.notes.length,1);assert.match(w.notes[0][1],/暂停：论坛弹出了验证/);
 await w.eval('watchdogTick()');assert.equal(w.notes.length,1,'no repeat inside the interval');
 w.data.watchdogState.lastRemind=Date.now()-121*MIN;await w.eval('watchdogTick()');assert.equal(w.notes.length,2);
});
test('4.4 watchdog: after the cool-down one list page is tried; if the forum reads normally the pause is cleared and collection resumes',async()=>{
 const w=boot({haltCollect:false,humanChallenge:{id:'c2',kind:'captcha',createdAt:Date.now()-31*MIN}});await w.eval('Safety.ready');
 page(w,okBoard);
 await w.eval('watchdogTick()');
 assert.equal(w.data.humanChallenge,null);assert.ok(w.notes.some(n=>/自动恢复/.test(n[1])));
});
test('4.4 watchdog: still blocked → stays paused and backs off 1h, 2h … max 4h; login pauses are never probed',async()=>{
 const w=boot({humanChallenge:{id:'c3',kind:'captcha',createdAt:Date.now()-31*MIN}});await w.eval('Safety.ready');
 let fetches=0;const buf=new TextEncoder().encode(captcha).buffer;w.c.fetch=async()=>{fetches++;return {ok:true,status:200,url:'https://bbs.my0511.com/captcha',headers:{get:()=>'text/html; charset=utf-8'},arrayBuffer:async()=>buf};};
 await w.eval('watchdogTick()');assert.equal(fetches,1);assert.equal(w.data.humanChallenge.id,'c3');
 let st=w.data.watchdogState;assert.equal(st.attempts,1);const d1=(st.nextProbe-Date.now())/MIN;assert.ok(d1>55&&d1<=60,String(d1));
 await w.eval('watchdogTick()');assert.equal(fetches,1,'waits for the next slot');
 for(let i=0;i<4;i++){w.data.watchdogState.nextProbe=0;await w.eval('watchdogTick()');}
 const d=(w.data.watchdogState.nextProbe-Date.now())/MIN;assert.ok(d>235&&d<=240,String(d));
 const L=boot({humanChallenge:{id:'c4',kind:'login',createdAt:Date.now()-300*MIN}});await L.eval('Safety.ready');let lf=0;L.c.fetch=async()=>{lf++;throw new Error('x');};
 await L.eval('watchdogTick()');assert.equal(lf,0);assert.match(L.notes[0][1],/登录/);
});
test('4.4 watchdog: long silence with sweeping on raises one reminder per period; a manual stop stays quiet',async()=>{
 const w=boot({sweepEnabled:true,lastCaptureAt:Date.now()-7*3600000,lastSweepOkAt:Date.now()-7*3600000,watchdogSince:1});await w.eval('Safety.ready');
 await w.eval('watchdogTick()');assert.ok(w.notes.some(n=>/好久没有新存档/.test(n[1])));
 const n=w.notes.length;await w.eval('watchdogTick()');assert.equal(w.notes.length,n);
 const q=boot({sweepEnabled:true,haltCollect:true,lastCaptureAt:Date.now()-30*3600000,watchdogSince:1});await q.eval('Safety.ready');await q.eval('watchdogTick()');assert.equal(q.notes.length,0);
});
test('4.4 skipped threads back off 1, 2, 4 … days (max 14) so sweeps stop re-queuing them every round',async()=>{
 const w=boot();await w.eval('Safety.ready');
 const day=86400000,now=Date.now();
 assert.equal(await w.eval(`inFailCooldown(${JSON.stringify({failReason:'没有权限',failedAt:now-2*3600000,failStreak:1})})`),true);
 assert.equal(await w.eval(`inFailCooldown(${JSON.stringify({failReason:'没有权限',failedAt:now-25*3600000,failStreak:1})})`),false);
 assert.equal(await w.eval(`inFailCooldown(${JSON.stringify({failReason:'没有权限',failedAt:now-3*day,failStreak:3})})`),true);
 assert.equal(await w.eval(`failCooldownMs({failStreak:10})`),14*day);
 assert.equal(await w.eval(`inFailCooldown({floors:[{floor:1}]})`),false);
});
test('4.4 archive self-repair: manifest says full but lists far fewer threads than the folder has → rebuild (at most once a day)',async()=>{
 const w=boot({useFolder:true});await w.eval('Safety.ready');
 w.chrome.offscreen={hasDocument:async()=>true,createDocument:async()=>{}};
 const calls=[];w.chrome.runtime.sendMessage=async m=>{calls.push(m.type);if(m.type==='ARCHIVE_DATA_STATUS')return {ok:true,exists:true,coverage:'full',mdCount:9736,withMd:1410};if(m.type==='ARCHIVE_DATA_REBUILD')return {ok:true,done:true,processed:1,total:1,next:'x',seq:1,sourceId:'s'};return {ok:true};};
 await w.eval('maybeAutoRebuild()');for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));
 assert.ok(calls.includes('ARCHIVE_DATA_REBUILD'));
 const n=calls.filter(x=>x==='ARCHIVE_DATA_REBUILD').length;w.data.archiveDataAutoCheck=0;await w.eval('maybeAutoRebuild()');for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 assert.equal(calls.filter(x=>x==='ARCHIVE_DATA_REBUILD').length,n,'once a day');
});

test('4.4.1: only one rebuild runs at a time even if several triggers fire together; a just-finished rebuild is not re-run for every new thread',async()=>{
 const w=boot({useFolder:true});await w.eval('Safety.ready');
 w.chrome.offscreen={hasDocument:async()=>true,createDocument:async()=>{}};
 const starts=[];let release;const gate=new Promise(r=>release=r);
 w.chrome.runtime.sendMessage=async m=>{if(m.type==='ARCHIVE_DATA_REBUILD'){starts.push(m.after);await gate;return {ok:true,done:true,processed:1,total:1,next:'x',seq:1,sourceId:'s'};}return {ok:true};};
 const a=w.eval('rebuildArchiveData()'),b=w.eval('rebuildArchiveData()'),c2=w.eval('maybeAutoRebuild(true)');
 for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
 assert.equal(starts.length,1);release();await a;await b;await c2;
 assert.ok(w.data.archiveDataRebuild.doneAt);
 await w.eval('maybeAutoRebuild(true)');for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 assert.equal(starts.length,1,'recently finished: not re-run on every write');
});
test('4.4.2: asking for a full re-capture upgrades a thread that is already queued for an incremental update',async()=>{
 const w=boot({haltCollect:true,queue:[{tid:'5',fid:'152',title:'t',from:4}]});await w.eval('Safety.ready');
 await w.eval("enqueueThreads([{tid:'5',fid:'152',title:'t',full:true},{tid:'6',fid:'152',title:'u',full:true}])");
 assert.equal(w.data.queue.length,2);assert.equal(w.data.queue[0].from,1);assert.equal(w.data.queue[0].full,true);assert.equal(w.data.queue[1].from,1);
});
test('4.4.3: a no-permission page keeps the forum\'s own reason (e.g. no permission for history threads) in the skip reason',async()=>{
 const w=boot();await w.eval('Safety.ready');
 const html='<html><head><meta charset="utf-8"><title>错误提示</title></head><body>梦溪论坛 » 提示信息 您无权进行当前操作，这可能因以下原因之一造成:<br>您所在的用户组没有浏览历史帖子的权限。<br>会员登录'+'<p>x</p>'.repeat(3000)+'</body></html>';
 const buf=new TextEncoder().encode(html).buffer;w.c.fetch=async u=>({ok:true,status:200,url:u,headers:{get:()=>'text/html; charset=utf-8'},arrayBuffer:async()=>buf});
 await assert.rejects(w.eval("fetchHtml('https://bbs.my0511.com/f152b-t6322204z')"),e=>e.permanent&&/论坛说：您所在的用户组没有浏览历史帖子的权限/.test(e.message)&&e.historyLocked===true);
});
test('4.4.4: reading a thread to its last page records the forum reply count; a full read also marks it verified, so sweeps stop re-reading threads with deleted floors',async()=>{
 const w=boot({haltCollect:false,useFolder:false,queue:[{tid:'77',fid:'152',title:'t',from:1,full:true}]});await w.eval('Safety.ready');
 w.chrome.downloads={download:async()=>1};w.chrome.offscreen={hasDocument:async()=>true,createDocument:async()=>{}};w.chrome.runtime.sendMessage=async()=>({ok:true,known:{}});
 const fl=n=>({floor:n,author:'甲',time:'2026-9-1 10:0'+n,text:'第'+n+'楼',pid:String(1000+n)});
 w.eval(`fetchPageWithRetry=async()=>({meta:{tid:'77',title:'t',replies:3,totalPages:1,board:'百姓话题'},floors:[${JSON.stringify(fl(1))},${JSON.stringify(fl(2))},${JSON.stringify(fl(4))}]})`);
 await w.eval('Collector.runJob()');
 const r=w.data['t:77'];assert.ok(r,'thread stored');assert.equal(r.checkedReplies,3);assert.equal(r.verified.maxFloor,4);assert.equal(r.verified.gap,0);
 assert.equal(await w.eval(`noNewSinceCheck(${JSON.stringify(r)},3)`),true,'no new replies: skip');
 assert.equal(await w.eval(`noNewSinceCheck(${JSON.stringify(r)},4)`),false,'a new reply: read again');
});
