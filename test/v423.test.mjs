import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
function boot(extra={}){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:false,haltPost:true,...extra});w.chrome.notifications={create:async()=>{},clear:()=>{},onClicked:{addListener(){}}};w.chrome.runtime.getManifest=()=>({version:'4.2.3'});return w;}
const call=(w,msg)=>new Promise((res,rej)=>{const sender={id:w.chrome.runtime.id,url:'chrome-extension://'+'a'.repeat(32)+'/options.html'};if(!w.listeners.some(fn=>fn(msg,sender,res)===true))rej(Error('not handled'));});
const Q=(n,start=1000)=>Array.from({length:n},(_,i)=>({tid:String(start+i),fid:'152',title:'t'+i,from:1}));
const ready=w=>w.eval('Safety.ready');

// ---------- 导出 / 导入 ----------
test('backup round trip: queue (with the unfinished job first), settings, watch list, skip records; posts come back held; import is idempotent',async()=>{
 const a=boot({queue:Q(3),job:{id:'j',state:'error',tid:'777',fid:'23',title:'卡住的',page:2,lastPage:5},sweepEnabled:true,sweepPages:6,keywords:['梦溪'],
  postQueue:[{id:'p1',message:'你好',status:'pending',at:Date.now()+1000},{id:'p2',message:'旧的',status:'done'}],
  't:5':{thread:{tid:'5',fid:'152',title:'跟进'},floors:[{floor:1}],watch:true},'t:6':{thread:{tid:'6',fid:'23'},floors:[],failReason:'未定义操作'}});
 await ready(a);
 const ex=await call(a,{type:'BACKUP_EXPORT'});assert.equal(ex.ok,true);const d=ex.data;
 assert.equal(d.format,'my0511-backup');assert.equal(d.queue[0].tid,'777');assert.equal(d.queue[0].from,2);assert.equal(d.queue.length,4);
 assert.equal(d.postQueue.length,1);assert.equal(d.watch.map(x=>x.tid).join(),'5');assert.equal(d.skipped.map(x=>x.tid).join(),'6');
 assert.equal(JSON.stringify(d).includes('floors'),false);
 const b=boot({haltCollect:false});await ready(b);
 const r=await call(b,{type:'BACKUP_IMPORT',data:JSON.parse(JSON.stringify(d))});
 assert.equal(r.ok,true);assert.equal(r.added,4);assert.equal(b.data.queue.length,4);assert.equal(b.data.haltCollect,true);
 assert.equal(b.data.sweepPages,6);assert.equal(b.data.keywords.join(),'梦溪');
 assert.equal(b.data['t:5'].watch,true);assert.equal(b.data['t:6'].failReason,'未定义操作');
 assert.equal(b.data.postQueue[0].status,'held');assert.equal(b.data.postQueue[0].plannedAt,null);
 const r2=await call(b,{type:'BACKUP_IMPORT',data:d});assert.equal(r2.added,0);assert.equal(b.data.queue.length,4);assert.equal(b.data.postQueue.length,1);
});
test('import keeps existing thread text and accepts the workbench full-storage dump',async()=>{
 const b=boot({'t:5':{thread:{tid:'5',fid:'152'},floors:[{floor:1,text:'原文'}]}});await ready(b);
 const dump={safety380:{profileId:'x'},queue:Q(2),'t:5':{thread:{tid:'5',fid:'152'},floors:[],watch:true},sweepEnabled:true};
 const r=await call(b,{type:'BACKUP_IMPORT',data:dump});assert.equal(r.ok,true);assert.equal(r.added,2);
 assert.equal(b.data['t:5'].floors[0].text,'原文');assert.equal(b.data['t:5'].watch,true);assert.equal(b.data.sweepEnabled,true);
});
test('import rejects garbage and bad tids without touching the queue',async()=>{
 const b=boot({queue:Q(1)});await ready(b);
 const r=await call(b,{type:'BACKUP_IMPORT',data:{hello:1}});assert.equal(r.ok,false);
 const r2=await call(b,{type:'BACKUP_IMPORT',data:{format:'my0511-backup',queue:[{tid:'../x',fid:'1'},{tid:'12',fid:'152'}]}});
 assert.equal(r2.added,1);assert.equal(b.data.queue.length,2);
});

// ---------- 出错时 ----------
async function runOnce(w){await w.eval('Collector.runJob()');}
function failWith(w,expr){w.eval(`fetchPageWithRetry=async()=>{throw ${expr};}`);}
test('network down: the thread errors and retries but is never skipped, queue untouched',async()=>{
 const w=boot({queue:Q(5),job:{id:'j',state:'running',tid:'9',fid:'152',page:1,lastPage:1,startPage:1,toEnd:true}});await ready(w);
 failWith(w,"Object.assign(new TypeError('Failed to fetch'))");
 for(let i=0;i<6;i++){await runOnce(w);assert.equal(w.data.job.state,'error');assert.match(w.data.job.error,/临时/);w.data.job.errorAt=0;}
 assert.equal(w.data.job.tid,'9');assert.ok(!w.data.job.failCount);assert.equal(w.data.queue.length,5);assert.equal(w.data['t:9'],undefined);
});
test('forum 502 / timeout also count as temporary',async()=>{
 const w=boot();await ready(w);
 assert.equal(await w.eval("isTransientError(Object.assign(new Error('页面返回 502'),{status:502}))"),true);
 assert.equal(await w.eval("isTransientError(Object.assign(new Error('x'),{name:'TimeoutError'}))"),true);
 assert.equal(await w.eval("isTransientError(new Error('页面缺少有效楼层，未写入存档'))"),false);
});
test('a broken thread is skipped after 3 failures and the queue moves on',async()=>{
 const w=boot({queue:Q(2),job:{id:'j',state:'running',tid:'9',fid:'23',page:1,lastPage:1,startPage:1,toEnd:true}});await ready(w);
 failWith(w,"new Error('页面缺少有效楼层，未写入存档')");
 await runOnce(w);assert.equal(w.data.job.failCount,1);w.data.job.errorAt=0;
 await runOnce(w);assert.equal(w.data.job.failCount,2);w.data.job.errorAt=0;
 await runOnce(w);
 assert.match(w.data['t:9'].failReason,/连续 3 次/);assert.equal(w.data.job.tid,'1000');assert.equal(w.data.queue.length,1);
});
test('blocked by the forum challenge: waits for a human, skips nothing, keeps the queue',async()=>{
 const w=boot({queue:Q(3),job:{id:'j',state:'running',tid:'9',fid:'152',page:1,lastPage:1,startPage:1,toEnd:true}});await ready(w);
 failWith(w,"Object.assign(new Error('等待人工验证'),{challenge:true})");
 await runOnce(w);
 assert.equal(w.data.job.state,'waiting_human');assert.equal(w.data.queue.length,3);assert.equal(w.data['t:9'],undefined);
});
test('a forum notice page (未定义操作) is detected through the real fetch path as a permanent skip',async()=>{
 const w=boot();await ready(w);
 const html='<html><head><meta charset="utf-8"><title>[原创]我把青春献给你</title></head><body><div>梦溪论坛 » 提示信息</div><div>梦溪论坛 提示信息</div><p>未定义操作，请返回。</p><a>[ 点击这里返回上一页 ]</a><a href="/f318b-t4388995z-1#pid72782693">官方QQ群</a>'+'<p>填充</p>'.repeat(3000)+'</body></html>';
 const buf=new TextEncoder().encode(html).buffer;
 w.c.fetch=async u=>({ok:true,status:200,url:u,headers:{get:()=> 'text/html; charset=utf-8'},arrayBuffer:async()=>buf});
 await assert.rejects(w.eval("fetchHtml('https://bbs.my0511.com/f23b-t511934z')"),e=>e.permanent===true&&/未定义操作/.test(e.message));
});
test('very long queue: status sends only a count and 20 items; enqueueing a 500-item batch that overlaps deduplicates',async()=>{
 const w=boot({queue:Q(5000),haltCollect:true});await ready(w);
 const s=await call(w,{type:'STATUS'});assert.equal(s.queueCount,5000);assert.equal(s.queue.length,20);
 const t0=Date.now();const r=await call(w,{type:'ENQUEUE',threads:Q(500,5900).map(x=>({tid:x.tid,fid:x.fid,title:x.title}))});
 assert.equal(r.ok,true);assert.equal(w.data.queue.length,5400);assert.ok(Date.now()-t0<5000);
});
