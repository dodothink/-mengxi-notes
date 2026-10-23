import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
function worker(initial={}){const data=structuredClone(initial),changed=[],listeners=[],alarms=[],updates=[];const event=list=>({addListener:fn=>list.push(fn),removeListener:()=>{}});let requests=0;const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event(listeners),onStartup:event([])},storage:{local:{get:async keys=>{if(keys===null)return structuredClone(data);const k=typeof keys==='string'?[keys]:keys;return Object.fromEntries(k.filter(x=>x in data).map(x=>[x,structuredClone(data[x])]));},set:async x=>{const ch={};for(const [k,v] of Object.entries(x))ch[k]={oldValue:data[k],newValue:structuredClone(v)};Object.assign(data,structuredClone(x));for(const fn of changed)fn(ch,'local');},remove:async k=>delete data[k],setAccessLevel:async()=>{}},onChanged:event(changed)},alarms:{create:()=>{},get:async()=>null,clear:async()=>{},onAlarm:event(alarms)},tabs:{onUpdated:event(updates),get:async()=>({id:1,url:'https://bbs.my0511.com/f152b',status:'complete'}),create:async()=>({id:1}),update:async()=>{},remove:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},notifications:{create:()=>{}},scripting:{executeScript:async()=>[]}};
const c=vm.createContext({chrome,crypto:webcrypto,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>{requests++;throw new Error('Network forbidden in regression test');}});c.self=c;c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(readFileSync(new URL('../extension/'+n,import.meta.url),'utf8'),c,{filename:n}));c.importScripts('sw.js');return {data,chrome,c,listeners,eval:code=>vm.runInContext(code,c),requests:()=>requests};}
const nowBJ=(offMin=0)=>{const d=new Date(Date.now()+8*3600000-offMin*60000);return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2,'0')}`;};
function boot(extra={}){const w=worker({safety380:{profileId:'p'},migr340:true,haltCollect:true,haltPost:true,...extra});const notes=[];w.chrome.notifications={create:async(id,o)=>{notes.push(o);},clear:()=>{},onClicked:{addListener(){}}};return {w,notes};}
test('fingerprint from raw browser text equals fingerprint recomputed from the rendered archive file',async()=>{
 const {w}=boot();await w.eval('Safety.ready');
 const texts=['普通一句话','@@Q|甲|2026-9-1 10:00|原来的话@@\n\n回你一句\n第二行','#开头的行\n正常\n\n[ 本帖最后由 乙 于 2026-9-1 11:00 编辑 ]','','> 未署名引用\n> 第二行\n我的话 [图]'];
 for(const t of texts){
  const floors=[{floor:1,author:'甲',time:'2026-9-1 10:00',text:'一楼'},{floor:2,author:'乙',time:'2026-9-1 10:05',text:t,hiddenAt:Date.now(),images:['_图片/1/2-1.jpg']}];
  floors[1].fp=await w.eval(`ArchiveMerge.fingerprintRaw(${JSON.stringify(t)})`);floors[0].fp=await w.eval(`ArchiveMerge.fingerprintRaw("一楼")`);
  const md=w.eval(`MD.buildThread({tid:'1',title:'x',url:'https://bbs.my0511.com/f152b-t1z'},${JSON.stringify(floors)})`);
  const main=w.eval(`ArchiveMerge.parseFile(${JSON.stringify(md)}).floors.get('n2').main`);
  assert.equal(w.eval(`ArchiveMerge.fpOf(${JSON.stringify(main)})`),floors[1].fp,t);
  assert.equal(await w.eval(`ArchiveMerge.fingerprintMd(${JSON.stringify(main)})`),floors[1].fp,t);
 }
});
test('adding fingerprints and image lines to an older file is not counted as an edit',async()=>{
 const {w}=boot();await w.eval('Safety.ready');
 const old=w.eval(`MD.buildThread({tid:'1',title:'x',url:'u'},[{floor:1,author:'甲',time:'2026-9-1 10:00',text:'一楼'}])`);
 const neu=w.eval(`MD.buildThread({tid:'1',title:'x',url:'u'},[{floor:1,author:'甲',time:'2026-9-1 10:00',text:'一楼',fp:'${'a'.repeat(64)}',images:['_图片/1/1-1.jpg'],capturedAt:1}])`);
 const m=w.eval(`ArchiveMerge.mergeVersions([ArchiveMerge.parseFile(${JSON.stringify(old)}),ArchiveMerge.parseFile(${JSON.stringify(neu)})])`);
 assert.equal(m.edited,0);assert.match(m.text,/<!-- 指纹 sha256:a{64}/);assert.match(m.text,/> 图片存档：\[1\]/);
});
test('alerts: reply to me (recent only), edits by watched IDs, keyword titles once; stored and notified',async()=>{
 const {w,notes}=boot({myName:'我',watchUsers:['对手'],keywords:['拆迁']});await w.eval('Safety.ready');
 w.eval(`fetchHtml=async()=>'';`);
 const t={tid:'7',fid:'152',title:'测试帖'};
 await w.eval(`mergeIntoStore('7',${JSON.stringify(t)},[{floor:1,author:'对手',time:'${nowBJ(5)}',text:'原话'},{floor:2,author:'路人',time:'${nowBJ(3)}',text:'@@Q|我|${nowBJ(10)}|你说的@@\\n\\n回你'},{floor:3,author:'路人',time:'2020-1-1 10:00',text:'@@Q|我|2020-1-1 09:00|旧@@\\n\\n旧回复'}],'u','152')`);
 let a=w.data.alerts;assert.equal(a.length,1);assert.equal(a[0].kind,'reply');assert.equal(a[0].floor,2);
 await w.eval(`mergeIntoStore('7',${JSON.stringify(t)},[{floor:1,author:'对手',time:'${nowBJ(5)}',text:'改过的话'}],'u','152')`);
 a=w.data.alerts;assert.equal(a[0].kind,'edit');assert.match(a[0].message,/原来：原话/);
 assert.ok(w.data['t:7'].floors[0].fp.length===64);assert.equal(w.data['t:7'].floors[0].history[0].fp.length,64);
 await w.eval(`Alerts.onBoardRows([{tid:'8',fid:'152',title:'老城区拆迁补偿'}])`);await w.eval(`Alerts.onBoardRows([{tid:'8',fid:'152',title:'老城区拆迁补偿'}])`);
 assert.equal(w.data.alerts.filter(x=>x.kind==='keyword').length,1);assert.ok(notes.length>=3);
});
test('hidden floors by watched IDs raise an alert',async()=>{
 const {w}=boot({watchUsers:['对手']});await w.eval('Safety.ready');
 w.data['t:9']={thread:{tid:'9',fid:'152',title:'x'},floors:[{floor:1,author:'对手',text:'要删的话',lastSeenAt:1},{floor:2,author:'路人',text:'b',lastSeenAt:1}]};
 await w.eval('markHidden("9",100)');
 assert.equal(w.data.alerts.length,1);assert.equal(w.data.alerts[0].kind,'hidden');assert.equal(w.data.alerts[0].floor,1);
});
test('image archive: only opted-in threads/IDs, only forum-hosted images, written under _图片/',async()=>{
 const {w}=boot({useFolder:true,imageUsers:['发图的人'],haltCollect:false});await w.eval('Safety.ready');
 w.data['t:3']={thread:{tid:'3',fid:'152',title:'x'},floors:[{floor:1,author:'发图的人',text:'[图]',imageUrls:['https://bbs.my0511.com/a/1.jpg','https://evil.example.com/2.jpg']},{floor:2,author:'路人',text:'[图]',imageUrls:['https://bbs.my0511.com/a/3.jpg']}]};
 const writes=[];w.chrome.offscreen={hasDocument:async()=>true};w.chrome.runtime.sendMessage=async m=>{writes.push(m);return {ok:true};};
 w.c.fetch=async url=>({ok:true,headers:{get:()=> 'image/jpeg'},arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer});w.c.setTimeout=(fn)=>setTimeout(fn,0);
 w.c.btoa=btoa;const n=await w.eval('saveImages("3")');
 assert.equal(n,1);assert.equal(writes[0].path,'_图片/3/1-1.jpg');assert.deepEqual([...w.data['t:3'].floors[0].images],['_图片/3/1-1.jpg']);assert.equal(w.data['t:3'].floors[1].images,undefined);
});
