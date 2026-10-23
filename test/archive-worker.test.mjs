import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
const rec={thread:{tid:'123',title:'测试帖',url:'https://bbs.my0511.com/f152b-t123z'},floors:[{floor:1,author:'甲',time:'2026-9-1 10:00',text:'一楼'}],updatedAt:2,exportedAt:1};
function setup(reply){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:true,useFolder:true,'t:123':rec});let downloads=0;const sent=[];
 w.chrome.downloads={download:async()=>{downloads++;}};w.chrome.offscreen={hasDocument:async()=>true,createDocument:async()=>{}};w.chrome.alarms.get=async()=>null;
 w.chrome.action.setTitle=async()=>{};w.chrome.action.setBadgeBackgroundColor=async()=>{};
 w.chrome.runtime.sendMessage=async m=>{sent.push(m);return reply(m);};w.eval('FS.getHandle=async()=>({name:"存档"})');return {w,sent,downloads:()=>downloads};}
test('4.0 folder mode: lost permission never falls back to a full overwrite via downloads, and is flushed later',async()=>{
 const s=setup(()=>({ok:false,needPermission:true}));await s.w.eval('Safety.ready');
 const r=await s.w.eval('autoExport('+JSON.stringify(rec)+')');
 assert.equal(r,null);assert.equal(s.downloads(),0);assert.equal(s.w.data.folderAuthNeeded,true);assert.equal(s.w.data['t:123'].exportedAt,1);
 assert.equal(s.sent[0].type,'ARCHIVE_WRITE');assert.match(s.sent[0].fileName,/^2026-09-01 t123 测试帖\.md$/);
});
test('4.0 folder mode: successful merged write marks exported and schedules an index rebuild instead of downloading',async()=>{
 const s=setup(m=>({ok:true,fileName:m.fileName}));await s.w.eval('Safety.ready');let alarm=null;s.w.chrome.alarms.create=(n,o)=>{alarm=n;};
 const n=await s.w.eval('flushExports()');
 assert.equal(n,1);assert.equal(s.downloads(),0);assert.ok(s.w.data['t:123'].exportedAt>1);assert.equal(alarm,'archive-index');
});
test('4.0 full recapture from page 1 marks floors not seen again as hidden',async()=>{
 const s=setup(()=>({ok:true}));await s.w.eval('Safety.ready');
 s.w.data['t:123']={...rec,floors:[{floor:1,text:'a',lastSeenAt:100},{floor:2,text:'b',lastSeenAt:50}]};
 await s.w.eval('markHidden("123",80)');
 assert.equal(s.w.data['t:123'].floors[0].hiddenAt,undefined);assert.ok(s.w.data['t:123'].floors[1].hiddenAt>0);
});
