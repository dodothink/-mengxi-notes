// Offline audit probes. No network, browser, API keys, or production-source writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../v3.7.0/my0511-archive');
const results=[];
const clone=x=>x===undefined?undefined:structuredClone(x);
function env(initial={}) {
 const data=clone(initial), closed=[], alarms=[];
 const noop=()=>{};
 const c={console,TextDecoder,URL,Uint8Array,Date,Math,setTimeout,clearTimeout,importScripts:noop,
 chrome:{storage:{local:{get:async k=>k===null?clone(data):Object.fromEntries((Array.isArray(k)?k:[k]).map(k=>[k,clone(data[k])])),set:async o=>Object.assign(data,clone(o)),remove:async k=>delete data[k]}},
 runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop}},
 alarms:{clear:async()=>{},create:(...a)=>alarms.push(a),onAlarm:{addListener:noop}},
 tabs:{remove:async id=>closed.push(id)},notifications:{create:noop}}};
 vm.createContext(c);return {c,data,closed,alarms};
}
function poster(initial={}) {
 const e=env(initial);
 const src=fs.readFileSync(path.join(root,'poster.js'),'utf8').replace('  recover();',`  globalThis.audit = {postOne, reschedule, classify, recover, handle, setDoPost: f => doPost = f};`);
 vm.runInContext(src,e.c);return e;
}
async function check(name,fn){const evidence=await fn();results.push({name,result:'observed',evidence});}
(async()=>{
 await check('Concurrent postOne calls enter doPost twice',async()=>{
 const e=poster({postQueue:[{id:'one',kind:'thread',fid:'152',subject:'test',message:'body',status:'pending'}]});
 let calls=0;e.c.audit.setDoPost(async()=>{calls++;return {ok:true,url:'mock'};});
 await Promise.all([e.c.audit.postOne('one',true),e.c.audit.postOne('one',true)]);
 assert.equal(calls,2);return {calls};
 });
 await check('CAPTCHA pauses posting but closes challenge tab',async()=>{
 const e=poster({postQueue:[{id:'one',kind:'thread',fid:'152',subject:'test',message:'body',status:'pending'}]});
 e.c.audit.setDoPost(async(it,onTab)=>{onTab(123);return {ok:false,needHuman:true,error:'captcha'};});
 await e.c.audit.postOne('one',true);assert.deepEqual(e.closed,[123]);assert.equal(e.data.postCfg.paused,'captcha');
 return {closed:e.closed,paused:e.data.postCfg.paused,status:e.data.postQueue[0].status};
 });
 await check('Generic exception after submission is eligible for retry',async()=>{
 const e=poster({postQueue:[{id:'one',kind:'thread',fid:'152',subject:'test',message:'body',status:'pending'}]});
 e.c.audit.setDoPost(async()=>{throw Error('simulated disconnect after click');});
 await e.c.audit.postOne('one',true);assert.equal(e.data.postQueue[0].status,'retry');return {status:e.data.postQueue[0].status};
 });
 await check('Cached auto plan survives daily cap already reached',async()=>{
 const now=Date.now();const e=poster({postCfg:{enabled:true,salt:1,dailyMax:1},postLog:[{ok:true,at:now}],postQueue:[{id:'one',kind:'thread',status:'pending',plannedAt:now-1000}]});
 const next=await e.c.audit.reschedule(false);assert.equal(next.id,'one');return {next,dailyMax:1,successesToday:1};
 });
 await check('Restart marks interrupted posting failed without automatic replay',async()=>{
 const e=poster({postQueue:[{id:'one',status:'posting'}]});await e.c.audit.recover();assert.equal(e.data.postQueue[0].status,'failed');return {status:e.data.postQueue[0].status};
 });
 await check('Success keyword wins over CAPTCHA keyword',async()=>{const e=poster();const r=e.c.audit.classify('非常感谢，请完成安全验证');assert.equal(r.ok,true);return r;});
 const b=env({migr340:true});vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),b.c);
 await check('Short ordinary post mentioning verification can be misclassified',async()=>{
 const html='<title>讨论验证</title><div id="consnav"></div><div class="outer-section"><div class="post-content">请问手机验证如何操作</div></div>';
 const result=b.c.isChallengePage(html);assert.equal(result,true);return {syntheticFixture:true,result};
 });
 await check('HTTP 403 challenge body is not inspected',async()=>{
 let read=false;b.c.fetch=async()=>({ok:false,status:403,arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}});
 let err;try{await b.c.fetchHtml('https://example.invalid');}catch(e){err=e;}
 assert.equal(err.status,403);assert.equal(read,false);return {status:err.status,bodyRead:read,challenge:!!err.challenge};
 });
 const md=require(path.join(root,'md.js'));
 await check('Different thread IDs can export to identical filenames',async()=>{
 const floors=[{floor:1,time:'2026-09-25',text:'body'}];const a=md.fileNameFor({tid:'1',title:'同名帖子'},floors);const b=md.fileNameFor({tid:'2',title:'同名帖子'},floors);assert.equal(a,b);return {a,b};
 });
 console.log(JSON.stringify({mode:'offline mocked browser; findings reproduced, not fixes',count:results.length,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
