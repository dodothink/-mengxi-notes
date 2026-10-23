import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
function boot(extra={}){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:true,...extra});w.chrome.notifications={create:async()=>{},clear:()=>{},onClicked:{addListener(){}}};return w;}
test('alarms are only created when missing, so service-worker restarts no longer postpone the 15-minute sweep',async()=>{
 const w=boot();await w.eval('Safety.ready');
 let created=[];w.chrome.alarms.create=(n,o)=>created.push([n,o.periodInMinutes]);
 w.chrome.alarms.get=async n=>({name:n,periodInMinutes:15});
 await w.eval("ensureAlarm('sweep',15)");assert.deepEqual(created,[]);
 w.chrome.alarms.get=async()=>null;
 await w.eval("ensureAlarm('sweep',15)");assert.deepEqual(created,[['sweep',15]]);
});
test('sweep becomes due from lastSweep time; a due sweep blocked by stop is recorded with a reason',async()=>{
 const w=boot({sweepEnabled:true});await w.eval('Safety.ready');
 assert.equal(await w.eval('sweepDue()'),true);
 await w.eval('onTick()');
 assert.ok(w.data.sweepSkip&&/停止/.test(w.data.sweepSkip.reason));
 w.data.lastSweep={at:Date.now()};assert.equal(await w.eval('sweepDue()'),false);
 delete w.data.sweepNextAt;w.data.lastSweep={at:Date.now()-21*60000};assert.equal(await w.eval('sweepDue()'),true);
 w.data.sweepEnabled=false;assert.equal(await w.eval('sweepDue()'),false);
});
