import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
function boot(extra={}){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:false,haltPost:true,...extra});w.chrome.notifications={create:async()=>{},clear:()=>{},onClicked:{addListener(){}}};return w;}
const call=(w,msg)=>new Promise(res=>{let done=false;for(const fn of w.listeners){const r=fn(msg,{id:w.chrome.runtime.id,url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'},x=>{if(!done){done=true;res(x);}});}});
test('STOP stops the current thread and pauses collection but keeps the whole queue',async()=>{
 const queue=Array.from({length:1558},(_,i)=>({tid:String(1000+i),fid:'152',title:'t'+i,from:1}));
 const w=boot({queue,job:{id:'j',state:'running',tid:'1',fid:'152',page:1,lastPage:1}});await w.eval('Safety.ready');
 const r=await call(w,{type:'STOP'});
 assert.equal(r.ok,true);assert.equal(r.queued,1558);
 assert.equal(w.data.queue.length,1558);assert.equal(w.data.job.state,'stopped');assert.equal(w.data.haltCollect,true);
});
test('SKIP_JOB skips a stuck errored thread, records why, and keeps the queue',async()=>{
 const queue=[{tid:'2',fid:'152',title:'b',from:1}];
 const w=boot({haltCollect:true,queue,job:{id:'j',state:'error',tid:'730753',fid:'23',title:'[原创]孤独的旅人',error:'页面缺少有效楼层，未写入存档',page:1,lastPage:1}});await w.eval('Safety.ready');
 const r=await call(w,{type:'SKIP_JOB'});
 assert.equal(r.ok,true);assert.equal(w.data.job.state,'done');assert.match(w.data['t:730753'].failReason,/手动跳过/);
 assert.equal(w.data.queue.length,1);
 const r2=await call(w,{type:'SKIP_JOB'});assert.equal(r2.ok,false);
});
test('a forum notice page such as 未定义操作 is a permanent skip, not an endless retry',async()=>{
 const w=boot();await w.eval('Safety.ready');
 const html='<div class="nav">梦溪论坛 &raquo; 提示信息</div><table><tr><td>梦溪论坛 提示信息</td></tr><tr><td><br>未定义操作，请返回。<br><a>[ 点击这里返回上一页 ]</a></td></tr></table><a href="/f318b-t4388995z-1#pid72782693">官方QQ群</a>';
 assert.equal(await w.eval(`forumNotice(${JSON.stringify(html)})`),'未定义操作，请返回。');
 assert.equal(await w.eval(`forumNotice(${JSON.stringify('<div class="outer-section">» 提示信息</div>')})`),'');
});
