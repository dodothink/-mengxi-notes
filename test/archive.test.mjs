// 4.0：插件内合并写入（archive-merge.js + archive-folder.js），用内存里的假文件夹测试
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
function load(){const c=vm.createContext({Blob,console,Date,Promise,Map,Set,JSON,RegExp,Math,String,Number,Error});c.self=c;
 for(const f of ['archive-merge.js','archive-folder.js'])vm.runInContext(readFileSync(new URL('../extension/'+f,import.meta.url),'utf8'),c,{filename:f});return c;}
let clock=1000;
function dirHandle(name='存档'){const files=new Map(),dirs=new Map();
 const fh=(n)=>({kind:'file',name:n,async getFile(){const e=files.get(n);if(!e)throw Error('NotFound');const b=new Blob([e.text]);return Object.assign(b,{lastModified:e.mtime,name:n});},
  async createWritable(){let buf='';return {write:async x=>{buf+=typeof x==='string'?x:(ArrayBuffer.isView(x)?'[bin'+x.length+']':await x.text());},close:async()=>{files.set(n,{text:buf,mtime:++clock});}};}});
 const d={kind:'directory',name,files,dirs,
  async *entries(){for(const n of [...files.keys()])yield [n,fh(n)];for(const [n,x] of dirs)yield [n,x];},
  async getFileHandle(n,o={}){if(!files.has(n)){if(!o.create)throw Error('NotFound');files.set(n,{text:'',mtime:++clock});}return fh(n);},
  async getDirectoryHandle(n,o={}){if(!dirs.has(n)){if(!o.create)throw Error('NotFound');dirs.set(n,dirHandle(n));}return dirs.get(n);},
  async removeEntry(n){if(!files.delete(n))throw Error('NotFound');},
  put(n,t){files.set(n,{text:t,mtime:++clock});}};return d;}
const doc=(cap,floors)=>`---\n标题: "测试帖"\n网址: https://bbs.my0511.com/f152b-t123z\ntid: 123\n查看: 1\n已存楼数: ${floors.length}\n采集时间: ${cap}\n---\n\n# 测试帖\n\n${floors.length} 楼 · 1 人 · 2026-09-01 至 2026-09-01\n\n## 参与者\n\n| 作者 | 地区 | 注册 | 发言数 | 发言楼层 |\n|---|---|---|---|---|\n| 甲 | 江苏省 | 2020-1-1 | ${floors.length} | x |\n\n## 正文\n\n`+floors.map(([n,t])=>`### ${n}楼 · 甲 · 2026-9-1 10:0${n} · 江苏省 <a id="f${n}"></a>\n\n${t}\n`).join('\n');
const NEW='2026-09-01 t123 测试帖.md';
test('merges old-format and t-format files by tid inside the chosen folder; history kept; duplicates moved to backup',async()=>{
 const c=load(),d=dirHandle();
 d.put('2026-09-01 测试帖旧标题.md',doc('2026-09-01 11:00',[[1,'一楼'],[2,'二楼原文'],[3,'三楼']]));
 d.put('2026-09-01 无关.md',doc('2026-09-01 11:00',[[1,'x']]).replace(/123/g,'999'));
 const r=await c.ArchiveFolder.writeMerged(d,{tid:'123',fileName:NEW,markdown:doc('2026-09-02 12:00',[[1,'一楼'],[2,'二楼改过'],[4,'四楼']])});
 assert.equal(r.floors,4);assert.deepEqual([...r.moved],['2026-09-01 测试帖旧标题.md']);
 const t=d.files.get(NEW).text;
 assert.match(t,/二楼改过[\s\S]*本楼内容变过 1 次[\s\S]*> 二楼原文/);assert.match(t,/### 3楼/);assert.match(t,/改过的楼层: 2/);assert.match(t,/已存楼数: 4/);
 assert.ok(d.dirs.get('_重复备份').files.has('2026-09-01 测试帖旧标题.md'));assert.ok(d.files.has('2026-09-01 无关.md'));assert.ok(!d.files.has('2026-09-01 测试帖旧标题.md'));
 await c.ArchiveFolder.writeMerged(d,{tid:'123',fileName:NEW,markdown:doc('2026-09-02 13:00',[[1,'一楼'],[2,'二楼改过'],[4,'四楼']])});
 assert.equal((d.files.get(NEW).text.match(/<details>/g)||[]).length,1);
 // 另一个插件整份重写（没有历史、少楼层），再合并：楼层和历史都不丢
 await c.ArchiveFolder.writeMerged(d,{tid:'123',fileName:NEW,markdown:doc('2026-09-03 09:00',[[1,'一楼'],[2,'二楼第三版']])});
 const t3=d.files.get(NEW).text;assert.match(t3,/本楼内容变过 2 次/);assert.match(t3,/### 4楼/);assert.match(t3,/### 3楼/);
 assert.equal(await c.ArchiveFolder.buildIndex(d,['123']),1);assert.match(d.files.get('My0511存档索引.md').text,/t123 测试帖\.md>\) \| 4 \| 是/);
});
test('title change renames by tid; bad names and wrong thread are rejected',async()=>{
 const c=load(),d=dirHandle();d.put(NEW,doc('2026-09-01 11:00',[[1,'a']]));
 const r=await c.ArchiveFolder.writeMerged(d,{tid:'123',fileName:'2026-09-01 t123 新标题.md',markdown:doc('2026-09-02 11:00',[[1,'a'],[2,'b']])});
 assert.equal(r.fileName,'2026-09-01 t123 新标题.md');assert.ok(!d.files.has(NEW));assert.ok(d.dirs.get('_重复备份').files.has(NEW));
 await assert.rejects(c.ArchiveFolder.writeMerged(d,{tid:'123',fileName:'../x.md',markdown:doc('2026-09-01 11:00',[[1,'a']])}));
 await assert.rejects(c.ArchiveFolder.writeMerged(d,{tid:'124',fileName:'2026-09-01 t124 x.md',markdown:doc('2026-09-01 11:00',[[1,'a']])}));
});
test('hidden floors render a marker and md uses Beijing capture time',()=>{
 const c=vm.createContext({console,Date});c.self=c;vm.runInContext(readFileSync(new URL('../extension/md.js',import.meta.url),'utf8'),c);
 const t=c.MD.buildThread({tid:'1',title:'x',url:'u'},[{floor:1,author:'a',time:'2026-9-1 10:00',text:'hi',hiddenAt:Date.UTC(2026,8,1,2,0)}]);
 assert.match(t,/> ⚠ 此楼在 2026-09-01 10:00 采集时已不可见/);assert.match(t,/采集时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});
test('knownFloors reads max floor per tid from t-format and legacy files; writeBinary only writes under _图片/',async()=>{
 const c=load(),d=dirHandle();
 d.put('2026-09-01 t123 测试帖.md',doc('2026-09-01 11:00',[[1,'a'],[2,'b']]));
 d.put('2026-09-01 旧名.md',doc('2026-09-01 11:00',[[1,'a'],[2,'b'],[3,'c']]).replace(/123/g,'456'));
 const k=await c.ArchiveFolder.knownFloors(d,['123','456','789']);
 assert.deepEqual({...k},{'123':2,'456':3});
 await c.ArchiveFolder.writeBinary(d,'_图片/123/1-1.jpg',new Uint8Array([1,2]));
 assert.ok(d.dirs.get('_图片').dirs.get('123').files.has('1-1.jpg'));
 await assert.rejects(c.ArchiveFolder.writeBinary(d,'../x.jpg',new Uint8Array([1])));
 await assert.rejects(c.ArchiveFolder.writeBinary(d,'_图片/../x.jpg',new Uint8Array([1])));
});
