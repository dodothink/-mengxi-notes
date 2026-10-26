import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
function boot(extra={}){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:true,...extra});w.chrome.notifications={create:async()=>{},clear:()=>{},onClicked:{addListener(){}}};return w;}
const call=(w,msg)=>new Promise((res,rej)=>{const sender={id:w.chrome.runtime.id,url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'};if(!w.listeners.some(fn=>fn(msg,sender,res)===true))rej(Error('not handled'));});
const page=(w,html,url='https://bbs.my0511.com/f152b')=>{const buf=new TextEncoder().encode(html).buffer;w.c.fetch=async()=>({ok:true,status:200,url,headers:{get:()=>'text/html; charset=utf-8'},arrayBuffer:async()=>buf});};
const ch={id:'c1',status:'waiting_human',kind:'captcha',url:'https://bbs.my0511.com/f152b',createdAt:1};
test('resume after a challenge: if the forum reads normally again, the challenge is cleared and collection resumes',async()=>{
 const w=boot({humanChallenge:ch});await w.eval('Safety.ready');
 page(w,'<html><head><title>百姓话题</title></head><body>'+'<dl class="list_dl"><a class="a_topic" href="/f152b-t1z">x</a></dl>'.repeat(5)+'</body></html>');
 const s=await call(w,{type:'STATUS'});assert.equal(s.challenge.id,'c1');
 const r=await call(w,{type:'RESUME_COLLECT'});assert.equal(r.ok,true);
 assert.equal(w.data.humanChallenge,null);assert.equal(w.data.haltCollect,false);
});
test('resume while the forum still shows the arithmetic check keeps everything paused and says why',async()=>{
 const w=boot({humanChallenge:ch});await w.eval('Safety.ready');
 page(w,'<html><head><title>安全验证</title></head><body>34+8=?<input name="captcha"></body></html>','https://bbs.my0511.com/captcha');
 const r=await call(w,{type:'RESUME_COLLECT'});assert.equal(r.ok,false);assert.match(r.error,/算术题/);
 assert.equal(w.data.humanChallenge.id,'c1');assert.equal(w.data.haltCollect,true);
});
test('resume while offline keeps the challenge and reports the network problem',async()=>{
 const w=boot({humanChallenge:ch});await w.eval('Safety.ready');
 w.c.fetch=async()=>{throw new TypeError('Failed to fetch');};
 const r=await call(w,{type:'RESUME_COLLECT'});assert.equal(r.ok,false);assert.match(r.error,/连不上论坛/);assert.equal(w.data.humanChallenge.id,'c1');
});
test('sweep interval is a configurable random range: each next time falls inside it and the range is sanitised',async()=>{
 const w=boot({sweepEnabled:true,haltCollect:true});await w.eval('Safety.ready');
 const r=await call(w,{type:'SET',key:'sweepRange',value:{min:30,max:12}});assert.equal(r.ok,true);
 assert.equal(w.data.sweepRange.min,12);assert.equal(w.data.sweepRange.max,30);
 const seen=new Set();
 for(let i=0;i<20;i++){const now=Date.now();const at=await w.eval(`pickNextSweep(${now})`);const m=(at-now)/60000;assert.ok(m>=12&&m<=30,String(m));seen.add(Math.round(m*10));}
 assert.ok(seen.size>5,'times should vary');
 await call(w,{type:'SET',key:'sweepRange',value:{min:1,max:999}});assert.equal(w.data.sweepRange.min,5);assert.equal(w.data.sweepRange.max,240);
 w.data.lastSweep={at:Date.now()};w.data.sweepNextAt=Date.now()+60000;assert.equal(await w.eval('sweepDue()'),false);
 w.data.sweepNextAt=Date.now()-1;assert.equal(await w.eval('sweepDue()'),true);
 const g=await call(w,{type:'GET_SWEEP'});assert.equal(g.sweepRange.max,240);assert.ok(g.sweepNextAt);
});
test('4.3 capture summary: full vs incremental, pages read, failure keeps reason',async()=>{
 const w=boot();await w.eval('Safety.ready');
 const full=await w.eval("captureOf({auto:true,startPage:1,lastPage:3,page:4,toEnd:true,startedAt:1},true)");
 assert.equal(full.complete,true);assert.equal(full.scope,'full');assert.equal(full.pagesRead.join(),'1,3');
 const inc=await w.eval("captureOf({startPage:3,lastPage:5,page:6,toEnd:true},true)");assert.equal(inc.complete,false);assert.equal(inc.scope,'incremental');assert.equal(inc.pagesRead.join(),'3,5');
 const bad=await w.eval("captureOf({startPage:1,lastPage:4,page:3,toEnd:true},false,'断网')");assert.equal(bad.ok,false);assert.equal(bad.complete,false);assert.equal(bad.pagesRead.join(),'1,2');assert.equal(bad.reason,'断网');
 const none=await w.eval("captureOf({startPage:1,lastPage:1,page:1},false,'x')");assert.equal(none.pagesRead.length,0);
});
test('4.3.1: machine-readable archive maintains itself — an incomplete index is rebuilt automatically when idle, at most every 10 minutes',async()=>{
 const w=boot({useFolder:true});await w.eval('Safety.ready');
 w.chrome.offscreen={hasDocument:async()=>true,createDocument:async()=>{}};
 const calls=[];w.chrome.runtime.sendMessage=async m=>{calls.push(m.type);if(m.type==='ARCHIVE_DATA_STATUS')return {ok:true,exists:true,coverage:'partial'};if(m.type==='ARCHIVE_DATA_REBUILD')return {ok:true,done:true,processed:3,total:3,next:'x',seq:9,sourceId:'s'};return {ok:true};};
 await w.eval('maybeAutoRebuild()');for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));
 assert.ok(calls.includes('ARCHIVE_DATA_REBUILD'));assert.equal(w.data.archiveDataRebuild.running,false);assert.ok(w.data.archiveDataRebuild.doneAt);
 const n=calls.length;await w.eval('maybeAutoRebuild()');assert.equal(calls.length,n,'throttled');
 w.data.archiveDataAutoCheck=0;w.chrome.runtime.sendMessage=async m=>{calls.push(m.type);return m.type==='ARCHIVE_DATA_STATUS'?{ok:true,exists:true,coverage:'full'}:{ok:true};};
 await w.eval('maybeAutoRebuild()');for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 assert.equal(calls.filter(x=>x==='ARCHIVE_DATA_REBUILD').length,1,'full coverage needs no rebuild');
});
test('4.3.2: maintenance is linked to collection — a thread write that reports partial coverage starts the rebuild at once, even while collecting',async()=>{
 const w=boot({useFolder:true});await w.eval('Safety.ready');
 w.chrome.offscreen={hasDocument:async()=>true,createDocument:async()=>{}};
 const calls=[];w.chrome.runtime.sendMessage=async m=>{calls.push(m.type);if(m.type==='ARCHIVE_DATA_REBUILD')return {ok:true,done:true,processed:1,total:1,next:'x',seq:5,sourceId:'s'};return {ok:true};};
 w.eval('running=true');w.data.archiveDataAutoCheck=Date.now(); // 正在采集、刚检查过
 await w.eval("noteDataResult({ok:true,data:{sourceId:'s',seq:4,coverage:'partial',rebuilding:false}})");
 for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));
 assert.ok(calls.includes('ARCHIVE_DATA_REBUILD'));
 const n=calls.length;await w.eval("noteDataResult({ok:true,data:{sourceId:'s',seq:6,coverage:'full',rebuilding:false}})");
 for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));assert.equal(calls.length,n,'full coverage: nothing to do');
 w.eval('running=false');
});
