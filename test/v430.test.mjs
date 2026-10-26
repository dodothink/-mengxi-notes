// 4.3.0：机读存档（_data/：逐帖 JSON、版本化清单、变更日志）
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {webcrypto,createHash} from 'node:crypto';
function load(){const c=vm.createContext({Blob,console,Date,Promise,Map,Set,JSON,RegExp,Math,String,Number,Error,TextEncoder,TextDecoder,crypto:webcrypto,Uint8Array,Array,Object,setTimeout});c.self=c;
 for(const f of ['archive-merge.js','archive-folder.js','archive-data.js'])vm.runInContext(readFileSync(new URL('../extension/'+f,import.meta.url),'utf8'),c,{filename:f});return c;}
let clock=1000;
function dirHandle(name='存档'){const files=new Map(),dirs=new Map();
 const fh=(n)=>({kind:'file',name:n,async getFile(){const e=files.get(n);if(!e)throw Error('NotFound');const b=new Blob([e.text]);return Object.assign(b,{lastModified:e.mtime,name:n});},
  async createWritable(o={}){let buf=o.keepExistingData&&files.has(n)?files.get(n).text:'';let pos=buf.length;
   return {seek:async p=>{pos=p;},write:async x=>{const s=typeof x==='string'?x:await x.text();buf=buf.slice(0,pos)+s;pos=buf.length;},abort:async()=>{},close:async()=>{if(d.failWrites)throw Error('NotAllowedError');if(d.busy>0){d.busy--;const e=new Error('An attempt was made to write to a file or directory which could not be modified due to the state of the underlying filesystem.');e.name='InvalidStateError';throw e;}files.set(n,{text:buf,mtime:++clock});}};}});
 const d={kind:'directory',name,files,dirs,failWrites:false,busy:0,
  async *entries(){for(const n of [...files.keys()])yield [n,fh(n)];for(const [n,x] of dirs)yield [n,x];},
  async getFileHandle(n,o={}){if(!files.has(n)){if(!o.create)throw Error('NotFound');files.set(n,{text:'',mtime:++clock});}return fh(n);},
  async getDirectoryHandle(n,o={}){if(!dirs.has(n)){if(!o.create)throw Error('NotFound');dirs.set(n,dirHandle(n));}return dirs.get(n);},
  async removeEntry(n){if(!files.delete(n))throw Error('NotFound');},
  put(n,t){files.set(n,{text:t,mtime:++clock});},get(n){return files.get(n)?.text;}};return d;}
const doc=(tid,cap,floors,{title='测试帖',author='甲'}={})=>`---\n标题: ${JSON.stringify(title)}\n网址: https://bbs.my0511.com/f152b-t${tid}z\ntid: ${tid}\n版块: 百姓话题\n查看: 10\n回复: ${floors.length-1}\n首帖: 2026-9-1 10:01\n已存楼数: ${floors.length}\n采集时间: ${cap}\n---\n\n# ${title}\n\n${floors.length} 楼 · 2 人 · 2026-09-01 至 2026-09-01\n\n## 参与者\n\n| 作者 | 地区 | 注册 | 发言数 | 发言楼层 |\n|---|---|---|---|---|\n| ${author} | 江苏省 | 2020-1-1 | 1 | x |\n\n## 正文\n\n`+floors.map(([n,t,a])=>`### ${n}楼 · ${a||(n===1?author:'乙')} · 2026-9-1 10:0${n} · 江苏省 · iPhone <a id="f${n}"></a>\n\n${t}\n`).join('\n');
const name=(tid,title='测试帖')=>`2026-09-01 t${tid} ${title}.md`;
const sha=t=>createHash('sha256').update(t,'utf8').digest('hex');
const data=d=>d.dirs.get('_data');
const manifest=d=>JSON.parse(data(d).get('manifest.json'));
const journal=d=>{const j=data(d).dirs.get('journal');return [...j.files.keys()].sort().flatMap(n=>j.get(n).trim().split('\n').map(l=>JSON.parse(l)));};
const write=(c,d,tid,cap,floors,extra={})=>c.ArchiveFolder.writeMerged(d,{tid:String(tid),fileName:name(tid,extra.title),markdown:doc(tid,cap,floors,extra),capture:extra.capture,floorSeqs:extra.floorSeqs});

test('writing a thread publishes per-thread JSON, a journal entry and the manifest; checksums match the files on disk',async()=>{
 const c=load(),d=dirHandle();
 const cap={known:true,ok:true,complete:true,scope:'full',pagesRead:[1,1],totalPages:1};
 const r=await write(c,d,123,'2026-09-01 11:00',[[1,'楼主正文'],[2,'回复\n\\# 不是标题']],{capture:cap});
 assert.equal(r.ok,true);assert.equal(r.dataError,null);assert.equal(r.data.revision,1);
 const src=JSON.parse(data(d).get('source.json'));assert.match(src.sourceId,/^[0-9a-f-]{36}$/);
 const m=manifest(d);const t=m.threads['123'];
 assert.equal(m.sourceId,src.sourceId);assert.equal(m.seq,1);assert.equal(t.revision,1);assert.equal(t.mdFile,name(123));
 assert.equal(t.mdSha256,sha(d.get(name(123))));
 const jt=data(d).dirs.get('threads').get('123.json');assert.equal(t.jsonSha256,sha(jt));
 const j=JSON.parse(jt);assert.equal(j.tid,'123');assert.equal(j.fid,'152');assert.equal(j.author,'甲');assert.equal(j.createdAt,'2026-9-1 10:01');assert.equal(j.createdAtPrecision,'minute');
 assert.equal(j.floors.length,2);assert.equal(j.floors[1].author,'乙');assert.equal(j.floors[1].text,'回复\n# 不是标题');assert.equal(j.floors[1].device,'iPhone');assert.equal(j.floors[0].floorId,null);
 assert.equal(j.capture.complete,true);assert.equal(t.complete,true);
 const jl=journal(d);assert.equal(jl.length,1);assert.equal(jl[0].type,'thread');assert.equal(jl[0].seq,1);assert.equal(jl[0].jsonSha256,t.jsonSha256);
});
test('a second capture bumps revision and seq; an incremental capture is marked as not complete',async()=>{
 const c=load(),d=dirHandle();
 await write(c,d,123,'2026-09-01 11:00',[[1,'a']]);
 const r=await write(c,d,123,'2026-09-01 12:00',[[1,'a'],[2,'b']],{capture:{known:true,ok:true,complete:false,scope:'incremental',pagesRead:[2,2]}});
 assert.equal(r.data.revision,2);const m=manifest(d);assert.equal(m.seq,2);assert.equal(m.threads['123'].complete,false);
 assert.equal(JSON.parse(data(d).dirs.get('threads').get('123.json')).floorCount,2);
 const w0=await write(c,d,9,'2026-09-01 12:00',[[1,'x']]);assert.equal(manifest(d).threads['9'].complete,null,'unknown capture stays unknown');
});
test('if Markdown is written but JSON cannot be, the manifest is not advanced (no false "ready")',async()=>{
 const c=load(),d=dirHandle();
 await write(c,d,123,'2026-09-01 11:00',[[1,'a']]);const before=data(d).get('manifest.json');
 const orig=c.ArchiveData.publish;c.ArchiveData.publish=async()=>{throw new Error('磁盘满了');};
 const r=await write(c,d,123,'2026-09-01 12:00',[[1,'a'],[2,'b']]);c.ArchiveData.publish=orig;
 assert.equal(r.ok,true);assert.match(r.dataError,/磁盘满/);assert.equal(data(d).get('manifest.json'),before);
});
test('permission lost mid-write: nothing new becomes ready',async()=>{
 const c=load(),d=dirHandle();
 await write(c,d,123,'2026-09-01 11:00',[[1,'a']]);const before=data(d).get('manifest.json');
 d.failWrites=true;data(d).failWrites=true;data(d).dirs.get('threads').failWrites=true;
 await assert.rejects(write(c,d,123,'2026-09-01 12:00',[[1,'a'],[2,'b']]));
 assert.equal(data(d).get('manifest.json'),before);
});
test('failures are recorded in the manifest and journal without changing the thread revision',async()=>{
 const c=load(),d=dirHandle();
 await write(c,d,123,'2026-09-01 11:00',[[1,'a']]);
 const r=await c.ArchiveData.recordFailure(d,{tid:'123',fid:'152',reason:'论坛提示「未定义操作」',capture:{known:true,ok:false,pagesRead:[]}});
 const m=manifest(d);assert.equal(m.threads['123'].revision,1);assert.match(m.threads['123'].lastFailure.reason,/未定义操作/);assert.equal(r.seq,2);
 await c.ArchiveData.recordFailure(d,{tid:'777',reason:'坏帖'});assert.equal(manifest(d).threads['777'].revision,0);assert.equal(manifest(d).threads['777'].mdFile,null);
 assert.deepEqual(journal(d).map(e=>e.type).join(),'thread,failed,failed');
});
test('restoring an old backup of the folder is detected: generation bumps and seq never goes backwards',async()=>{
 const c=load(),d=dirHandle();
 await write(c,d,1,'2026-09-01 11:00',[[1,'a']]);
 const oldManifest=data(d).get('manifest.json');
 const r2=await write(c,d,2,'2026-09-01 11:00',[[1,'b']]);const r3=await write(c,d,3,'2026-09-01 11:00',[[1,'c']]);
 const floorSeqs={[r3.data.sourceId]:r3.data.seq};
 data(d).put('manifest.json',oldManifest); // 旧备份覆盖
 const r4=await write(c,d,4,'2026-09-01 11:00',[[1,'d']],{floorSeqs});
 const m=manifest(d);assert.equal(m.generation,2);assert.ok(r4.data.seq>r3.data.seq);assert.equal(m.coverage,'partial');
 assert.ok(journal(d).some(e=>e.type==='rollback'));
});
test('rebuild from existing Markdown: all files indexed in batches; unchanged content keeps its revision; renamed/missing files are flagged',async()=>{
 const c=load(),d=dirHandle();
 for(let i=1;i<=5;i++)d.put(name(100+i),doc(100+i,'2026-09-01 11:00',[[1,'正文'+i]]));
 d.put('2026-09-01 无关的旧格式.md','随便');d.put('My0511存档索引.md','# 索引');
 let after='',rounds=0,r;do{r=await c.ArchiveData.rebuildBatch(d,{after,limit:2});after=r.next;rounds++;}while(!r.done);
 assert.equal(rounds,3);let m=manifest(d);assert.equal(Object.keys(m.threads).length,5);assert.equal(m.coverage,'full');
 const rev=m.threads['101'].revision,gen=m.generation;
 // 再重建：内容没变，版本号不变，不产生新的 thread 日志
 const before=journal(d).filter(e=>e.type==='thread').length;
 after='';do{r=await c.ArchiveData.rebuildBatch(d,{after,limit:10});after=r.next;}while(!r.done);
 m=manifest(d);assert.equal(m.threads['101'].revision,rev);assert.equal(m.generation,gen+1);assert.equal(journal(d).filter(e=>e.type==='thread').length,before);
 // 文件被改名（不再是 t 格式）：清单标记 mdMissing，不删记录
 d.files.set('改了名字.md',d.files.get(name(102)));d.files.delete(name(102));
 after='';do{r=await c.ArchiveData.rebuildBatch(d,{after,limit:10});after=r.next;}while(!r.done);
 m=manifest(d);assert.equal(m.threads['102'].mdMissing,true);assert.ok(data(d).dirs.get('threads').get('102.json'));
});
test('the manifest lists journal files with firstSeq/lastSeq so readers can detect gaps',async()=>{
 const c=load(),d=dirHandle();
 for(let i=0;i<3;i++)await write(c,d,200+i,'2026-09-01 11:00',[[1,'x'+i]]);
 const m=manifest(d);assert.equal(m.journal.firstSeq,1);assert.equal(m.journal.files[0].firstSeq,1);assert.equal(m.journal.files[0].lastSeq,3);
});
test('a reader that follows the protocol sees each ready version exactly once across restarts and duplicate notifications',async()=>{
 const c=load(),d=dirHandle();
 const seen=[];let state={sourceId:null,generation:0,cursor:0,done:{}};
 async function readerPass(){
  const m=manifest(d);
  const full=m.sourceId!==state.sourceId||m.generation!==state.generation||m.seq<state.cursor||m.journal.firstSeq>state.cursor+1;
  const todo=full?Object.entries(m.threads):journal(d).filter(e=>e.seq>state.cursor&&e.seq<=m.seq&&e.type==='thread').map(e=>[e.tid,m.threads[e.tid]]);
  for(const [tid,t] of todo){if(!t||!t.jsonFile)continue;const txt=data(d).dirs.get('threads').get(tid+'.json');if(sha(txt)!==t.jsonSha256)continue;
   if(state.done[tid]===t.jsonSha256)continue;state.done[tid]=t.jsonSha256;seen.push(tid+'@'+t.revision);}
  state={...state,sourceId:m.sourceId,generation:m.generation,cursor:m.seq};
 }
 await write(c,d,1,'2026-09-01 11:00',[[1,'a']]);await readerPass();await readerPass();
 await write(c,d,1,'2026-09-01 12:00',[[1,'a'],[2,'b']]);await write(c,d,2,'2026-09-01 12:00',[[1,'z']]);
 const saved=JSON.parse(JSON.stringify(state));state={sourceId:null,generation:0,cursor:0,done:saved.done}; // 阅读器重启但保留去重记录
 await readerPass();
 let after='',r;do{r=await c.ArchiveData.rebuildBatch(d,{after,limit:10});after=r.next;}while(!r.done); // 换代重建
 await readerPass();
 assert.deepEqual(seen.join(),'1@1,1@2,2@1');
});

test('4.3.1: a temporarily busy file system (InvalidStateError) is retried instead of failing the write',async()=>{
 const c=load(),d=dirHandle();
 await write(c,d,123,'2026-09-01 11:00',[[1,'a']]);
 data(d).busy=2; // 清单连续两次「文件系统状态不允许修改」
 const r=await write(c,d,123,'2026-09-01 12:00',[[1,'a'],[2,'b']]);
 assert.equal(r.dataError,null);assert.equal(manifest(d).threads['123'].revision,2);
});
test('4.3.1: an interrupted rebuild resumes from where it stopped without starting a new generation',async()=>{
 const c=load(),d=dirHandle();
 for(let i=1;i<=6;i++)d.put(name(300+i),doc(300+i,'2026-09-01 11:00',[[1,'正文'+i]]));
 let r=await c.ArchiveData.rebuildBatch(d,{after:'',limit:2});const gen=r.generation;assert.equal(r.done,false);
 // 模拟中途失败后，后台重新从头发起（after 为空）
 r=await c.ArchiveData.rebuildBatch(d,{after:'',limit:2});assert.equal(r.generation,gen);assert.equal(r.next,name(304));
 let after=r.next;while(!r.done){r=await c.ArchiveData.rebuildBatch(d,{after,limit:2});after=r.next;}
 const m=manifest(d);assert.equal(m.coverage,'full');assert.equal(Object.keys(m.threads).length,6);assert.equal(m.generation,gen);assert.equal(m.rebuilding,undefined);
});
