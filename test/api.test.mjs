import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
test('API v1 is exposed, frozen, and emits archive/challenge/post events from storage changes',async()=>{
 const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:true});await w.eval('Safety.ready');
 assert.equal(w.eval('My0511API.version'),'1.2');assert.equal(w.eval('Object.isFrozen(My0511API)'),true);
 for(const m of ['status','pause','resume','getThread','listThreads','enqueue','writeArchive','knownFloors','challenge','refreshChallenge','answerChallenge','verifyChallenge','fillReply','postOnce'])assert.equal(w.eval(`typeof My0511API.${m}`),'function',m);
 w.eval('self.seen=[];for(const e of ["archiveWritten","challenge","postResumed","postHalted"])My0511API.on(e,d=>seen.push(e))');
 await w.chrome.storage.local.set({'t:5':{thread:{tid:'5',fileName:'x.md'},floors:[{floor:1}],exportedAt:9}});
 await w.chrome.storage.local.set({humanChallenge:{id:'c'}});await w.chrome.storage.local.set({haltPost:false});await w.chrome.storage.local.set({haltPost:true});
 await new Promise(r=>setTimeout(r,10));
 assert.deepEqual([...w.eval('seen')],['archiveWritten','challenge','postResumed','postHalted']);
});
test('API store is namespaced to addon: keys and rejects bad names',async()=>{
 const w=worker();await w.eval('Safety.ready');await w.eval('My0511API.store.set("pairing",{a:1})');
 assert.deepEqual(w.data['addon:pairing'],{a:1});await assert.rejects(w.eval('My0511API.store.set("../x",1)'));
});
test('postOnce requires a guard, and a failing guard means nothing is queued or submitted',async()=>{
 const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:false,postCfg:{enabled:false}});await w.eval('Poster.ready');
 await assert.rejects(w.eval('My0511API.postOnce({ref:"abcdefgh12",tid:"1",fid:"152",message:"hi"})'),/确认函数/);
 await assert.rejects(w.eval('My0511API.postOnce({ref:"abcdefgh12",tid:"1",fid:"152",message:"hi"},async()=>{throw new Error("用户已拒绝")})'),/用户已拒绝/);
 assert.equal((w.data.postQueue||[]).filter(x=>x.id==='once-abcdefgh12').length,0);
});
test('addons entry is loaded by the service worker without breaking the core',async()=>{
 const w=worker();await w.eval('Safety.ready');assert.equal(w.eval('typeof My0511API'),'object');assert.equal(w.eval('typeof Poster'),'object');
});
