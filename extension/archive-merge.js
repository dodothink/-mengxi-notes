// 4.0：存档合并（纯文本逻辑，不碰文件系统）。插件面板和 offscreen 页面共用。
// 同一个帖子（tid）的几份 Markdown 合并成一份：楼层取并集，同一楼内容不同时最新版作正文、
// 旧版本进 <details> 历史；已有历史原样保留并去重；重算楼数、改过的楼层、参与者表。
(function (root) {
'use strict';
const T_NAME=/^\d{4}-\d{2}-\d{2} t(\d+) .+\.md$/;
const OLD_NAME=/^\d{4}-\d{2}-\d{2} (?!t\d+ ).+\.md$/;
const NOTE='\n> **本楼内容变过';
const HIDDEN=/^> ⚠ 此楼在 .*采集时已不可见.*$/m;
const EDIT=/\[?\s*本帖最后由\s*.+?\s*于\s*\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*编辑\s*\]?/g;
const TIME=/^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}/;

const pad=n=>String(n).padStart(2,'0');
function bjNow(){const d=new Date(Date.now()+8*3600000);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;}
function isoDate(t){const m=/(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t||'');return m?`${m[1]}-${pad(m[2])}-${pad(m[3])}`:'';}
function timeKey(s){const m=/(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})/.exec(s||'');return m?`${m[1]}${pad(m[2])}${pad(m[3])}${pad(m[4])}${m[5]}`:'';}
// 4.1：指纹注释、图片存档行不算正文内容
const FP_LINE=/^<!-- 指纹 sha256:[0-9a-f]{64}.*-->\s*$/gm;
const IMG_LINE=/^> 图片存档：.*$/gm;
const norm=s=>String(s||'').replace(EDIT,'').replace(FP_LINE,'').replace(IMG_LINE,'').replace(/^> ⚠ 此楼在 .*$/gm,'').replace(/^[> ]+/gm,'').replace(/\s+/g,'');
// 4.1 取证指纹：同一层楼的正文，不管从浏览器原始记录算还是从存档文件算，得到同一个规范文本。
// 去掉：引用头（↩ 回复/引用那一行）、「本帖最后由…编辑」、不可见标记、指纹注释、图片存档行、所有空白。
const QUOTE_RAW=/@@Q\|[^|]*\|[^|]*\|[^@]*@@/g;
function canonRaw(raw){return String(raw||'').replace(QUOTE_RAW,'').replace(EDIT,'').replace(/\s+/g,'');}
function canonMd(main){
 let t=String(main||'');
 if(/^\s*（无文字）\s*$/.test(t.replace(FP_LINE,'').replace(IMG_LINE,'').replace(/^> ⚠ 此楼在 .*$/gm,'')))t='';
 return t.replace(FP_LINE,'').replace(IMG_LINE,'').replace(/^> ⚠ 此楼在 .*$/gm,'').replace(/^> ↩ .*$/gm,'').replace(/^\\#/gm,'#').replace(EDIT,'').replace(/\s+/g,'');
}
async function sha256(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');}
const fingerprintRaw=raw=>sha256(canonRaw(raw));
const fingerprintMd=main=>sha256(canonMd(main));
function fpOf(main){const m=/^<!-- 指纹 sha256:([0-9a-f]{64})/m.exec(main||'');return m?m[1]:null;}

// ---------- 解析 ----------
function parseFile(text){
 const m=/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);if(!m)return null;
 const fm=[];const fields={};
 for(const line of m[1].split(/\r?\n/)){const i=line.indexOf(':');const k=i>0?line.slice(0,i).trim():'';fm.push([k,line]);if(k)fields[k]=line.slice(i+1).trim();}
 if(!/^\d+$/.test(fields.tid||''))return null;
 const rest=text.slice(m[0].length);const bi=rest.indexOf('\n## 正文\n');if(bi<0)return null;
 const head=rest.slice(0,bi);let body=rest.slice(bi+'\n## 正文\n'.length);
 let appendix='';const ai=body.indexOf('\n## 附录：短回复\n');if(ai>=0){appendix=body.slice(ai+1);body=body.slice(0,ai);}
 const floors=new Map();
 for(const part of body.split(/^(?=### (?:\d+|\?)楼 · )/m)){
  const hm=/^### (\d+|\?)楼 · (.*)$/m.exec(part);if(!hm||hm.index!==0)continue;
  const nl=part.indexOf('\n');const header=part.slice(0,nl<0?part.length:nl);const content=nl<0?'':part.slice(nl+1);
  const n=hm[1]==='?'?null:Number(hm[1]);const key=n==null?'?'+header:'n'+n;
  const k=content.indexOf(NOTE);
  let main=content,hist=[],latestNote='';
  if(k>=0){main=content.slice(0,k);const h=content.slice(k);
   latestNote=(/上面是最新版本（(.*?)）。/.exec(h)||[])[1]||'';
   const re=/<details><summary>(.*?)<\/summary>\r?\n\r?\n?([\s\S]*?)\r?\n\r?\n?<\/details>/g;let d;
   while((d=re.exec(h))){const when=(/（(.*)）\s*$/.exec(d[1])||[])[1]||'';hist.push({when,text:d[2].replace(/\s+$/,'')});}}
  floors.set(key,{n,key,header,main:main.replace(/\s+$/,''),hist,latestNote});
 }
 const reg=new Map();
 for(const r of head.matchAll(/^\| (.+?) \| (.*?) \| (.*?) \| \d+ \|/gm))if(r[1]!=='作者')reg.set(r[1],[r[2],r[3]]);
 return {fields,fm,head,floors,appendix,reg,cap:fields['采集时间']||''};
}
const quote=t=>t.split('\n').map(l=>'> '+l).join('\n');

// ---------- 合并 ----------
// versions：按时间从旧到新排列，最后一个是这次要写入的（最新）。
function mergeVersions(versions){
 const newest=versions[versions.length-1];
 const appendixFloors=new Set([...newest.appendix.matchAll(/^- \*\*(\d+)楼\*\*/gm)].map(x=>'n'+x[1]));
 const keys=new Set();for(const v of versions)for(const k of v.floors.keys())keys.add(k);
 const order=[...keys].filter(k=>!appendixFloors.has(k)).sort((a,b)=>{
  const fa=versions.map(v=>v.floors.get(a)).find(Boolean),fb=versions.map(v=>v.floors.get(b)).find(Boolean);
  return (fa.n??1e12)-(fb.n??1e12);});
 const out=[],edited=[];
 for(const k of order){
  const vs=versions.filter(v=>v.floors.has(k)).map(v=>({cap:v.cap,f:v.floors.get(k)}));
  const latest=vs[vs.length-1];
  const seen=new Set([norm(latest.f.main)]);
  const pool=[];
  for(const {cap,f} of vs){for(const h of f.hist)pool.push({when:h.when,text:h.text});}
  for(const {cap,f} of vs.slice(0,-1)){const fp=(f.main.match(FP_LINE)||[])[0];pool.push({when:'采集于 '+cap,text:quote(f.main.replace(HIDDEN,'').replace(FP_LINE,'').replace(IMG_LINE,'').replace(/^\s+|\s+$/g,''))+(fp?'\n\n'+fp.trim():'')});}
  pool.sort((a,b)=>timeKey(a.when).localeCompare(timeKey(b.when)));
  const olds=[];for(const p of pool){const s=norm(p.text);if(!s&&!p.text.trim())continue;if(seen.has(s))continue;seen.add(s);olds.push(p);}
  let blk=latest.f.header+'\n'+latest.f.main+'\n';
  if(olds.length){
   edited.push(latest.f.n);
   blk+=`\n> **本楼内容变过 ${olds.length} 次**：上面是最新版本（${latest.f.latestNote||'采集于 '+latest.cap}）。以下是采集到的旧版本，按时间从早到晚：\n\n`;
   olds.forEach((o,i)=>{blk+=`<details><summary>${latest.f.n??'?'}楼 · 第 ${i+1} 版${o.when?'（'+o.when+'）':''}</summary>\n\n${o.text}\n\n</details>\n\n`;});
  }
  out.push({n:latest.f.n,header:latest.f.header,blk:blk.replace(/\s+$/,'')+'\n'});
 }
 // 参与者
 const reg=new Map();for(const v of versions)for(const [a,r] of v.reg)reg.set(a,r);
 const people=new Map();let first=null,last=null;
 for(const f of out){const parts=f.header.replace(/ <a id="f[^"]*"><\/a>\s*$/,'').split(' · ').slice(1);
  const ti=parts.findIndex(p=>TIME.test(p));const author=ti>0?parts.slice(0,ti).join(' · '):(parts[0]||'');const time=ti>=0?parts[ti]:'';
  const region=ti>=0&&parts[ti+1]&&!/^(iPhone|vivo|OPPO|华为|小米|梦溪|手机)/.test(parts[ti+1])?parts[ti+1]:'';
  if(!people.has(author))people.set(author,{floors:[],region});people.get(author).floors.push(f.n);
  if(time){if(!first)first=time;last=time;}}
 const rows=[...people.entries()].sort((a,b)=>b[1].floors.length-a[1].floors.length).map(([a,p])=>{
  const r=reg.get(a)||[p.region,''];const shown=p.floors.slice(0,14).map(n=>`[${n}](#f${n})`).join(' ');
  return `| ${a} | ${r[0]} | ${r[1]} | ${p.floors.length} | ${shown}${p.floors.length>14?' …':''} |`;});
 let head=newest.head;
 head=head.replace(/(## 参与者\n\n\| 作者 \| 地区 \| 注册 \| 发言数 \| 发言楼层 \|\n\|---\|---\|---\|---\|---\|\n)[\s\S]*?(?=\n## |\n*$)/,(m,h)=>h+rows.join('\n')+'\n');
 const total=out.length+appendixFloors.size;
 head=head.replace(/^\d+ 楼 · \d+ 人(?: · .*)?$/m,`${total} 楼 · ${people.size} 人${first&&last?` · ${isoDate(first)} 至 ${isoDate(last)}`:''}`);
 const fm=[];let placed=false;
 for(const [k,line] of newest.fm){
  if(k==='改过的楼层')continue;
  if(k==='已存楼数'){fm.push('已存楼数: '+total);if(edited.length)fm.push('改过的楼层: '+edited.join(', '));placed=true;continue;}
  if(k==='首帖'&&first){fm.push('首帖: '+first);continue;}
  if(k==='最后一楼'&&last){fm.push('最后一楼: '+last);continue;}
  fm.push(line);
 }
 if(!placed){fm.push('已存楼数: '+total);if(edited.length)fm.push('改过的楼层: '+edited.join(', '));}
 const text='---\n'+fm.join('\n')+'\n---\n'+head.replace(/\s+$/,'')+'\n\n## 正文\n\n'+out.map(f=>f.blk).join('\n')+(newest.appendix?'\n'+newest.appendix.replace(/\s+$/,'')+'\n':'');
 return {text,floors:total,edited:edited.length};
}
const countDetails=t=>(t.match(/<details><summary>/g)||[]).length;
const totalFloors=p=>p.floors.size+[...p.appendix.matchAll(/^- \*\*(\d+)楼\*\*/gm)].length;

const api={T_NAME,OLD_NAME,parseFile,mergeVersions,norm,timeKey,bjNow,countDetails,totalFloors,canonRaw,canonMd,fingerprintRaw,fingerprintMd,fpOf};
root.ArchiveMerge=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof self!=='undefined'?self:this);
