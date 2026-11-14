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
