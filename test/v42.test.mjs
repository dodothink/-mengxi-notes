import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
function boot(extra={}){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:true,...extra});w.chrome.notifications={create:async()=>{},clear:()=>{},onClicked:{addListener(){}}};return w;}
const mk=(n)=>Array.from({length:n},(_,i)=>({kind:'keyword',tid:'1',floor:i+1,title:'t',message:'m'+(i+1)}));
test('alertsSince replays by seq from a cursor, with nextCursor and truncated; ackAlerts is separate from read',async()=>{
 const w=boot();await w.eval('Safety.ready');
 await w.eval(`Alerts.add(${JSON.stringify(mk(5))})`);
 let r=await w.eval('My0511API.alertsSince({cursor:0,limit:3})');
 assert.deepEqual(r.items.map(x=>x.seq),[1,2,3]);assert.equal(r.nextCursor,3);assert.equal(r.truncated,false);
 r=await w.eval('My0511API.alertsSince({cursor:3})');assert.deepEqual(r.items.map(x=>x.seq),[4,5]);
 r=await w.eval('My0511API.alertsSince({cursor:5})');assert.equal(r.items.length,0);assert.equal(r.nextCursor,5);
 await w.eval('My0511API.ackAlerts({consumer:"agent",cursor:3})');
 assert.equal(w.data.alertAcks.agent.cursor,3);assert.ok(w.data.alerts.every(x=>x.read===false));
 await assert.rejects(w.eval('My0511API.ackAlerts({consumer:"../x",cursor:1})'));
});
test('unacknowledged alerts are kept beyond 300 for a registered consumer; without consumers only 300 are kept and truncation is reported',async()=>{
 const w=boot();await w.eval('Safety.ready');
 await w.eval('My0511API.ackAlerts({consumer:"agent",cursor:0})');
 for(let i=0;i<4;i++)await w.eval(`Alerts.add(${JSON.stringify(mk(100))})`);
 assert.equal(w.data.alerts.length,400);
 const w2=boot();await w2.eval('Safety.ready');
 for(let i=0;i<4;i++)await w2.eval(`Alerts.add(${JSON.stringify(mk(100))})`);
 assert.equal(w2.data.alerts.length,300);
 const r=await w2.eval('My0511API.alertsSince({cursor:0,limit:10})');assert.equal(r.truncated,true);assert.equal(r.items[0].seq,101);
});
test('postOnce guard receives only the frozen public shape {ref,tid,fid,message}',async()=>{
 const w=boot({haltPost:false,postCfg:{enabled:false}});await w.eval('Poster.ready');
 w.eval('self.got=null');
 await assert.rejects(w.eval('My0511API.postOnce({ref:"abcdefgh12",tid:"1",fid:"152",message:"hi"},async g=>{self.got=g;throw new Error("stop")})'),/stop/);
 const g=w.eval('got');assert.deepEqual(Object.keys(g).sort(),['fid','message','ref','tid']);assert.equal(g.ref,'abcdefgh12');assert.equal(w.eval('Object.isFrozen(got)'),true);
});
test('archiveStatus reports mode, permission, pending writes and last error; archiveWritten carries revision and capturedAt',async()=>{
 const w=boot({useFolder:true,'t:1':{thread:{tid:'1'},floors:[{floor:1}],updatedAt:20,exportedAt:10},'t:2':{thread:{tid:'2'},floors:[{floor:1}],updatedAt:5,exportedAt:10},lastExportError:{tid:'1',error:'x',at:3}});
 await w.eval('Safety.ready');w.chrome.offscreen={hasDocument:async()=>true};w.chrome.runtime.sendMessage=async m=>m.type==='ARCHIVE_STATUS'?{ok:true,has:true,name:'My0511存档',perm:'prompt'}:{ok:true};
 const s=await w.eval('My0511API.archiveStatus()');
 assert.equal(s.mode,'folder');assert.equal(s.directoryName,'My0511存档');assert.equal(s.permission,'prompt');assert.equal(s.pendingWrites,1);assert.equal(s.lastWriteError.tid,'1');
 w.eval('self.ev=[];My0511API.on("archiveWritten",e=>ev.push(e))');
 await w.chrome.storage.local.set({'t:1':{thread:{tid:'1',fileName:'f.md'},floors:[{floor:1}],updatedAt:20,exportedAt:30}});
 await new Promise(r=>setTimeout(r,5));
 const e=w.eval('ev')[0];assert.equal(e.revision,30);assert.equal(e.capturedAt,20);
});
