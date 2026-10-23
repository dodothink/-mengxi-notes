import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8').split('(async function init()')[0];
function popup({url='https://bbs.my0511.com/f152b',changed=false,fail=false}={}) {
 const elements = new Map(), messages=[];
 function element(){return {dataset:{},children:[],value:'',attrs:{},textContent:'',set innerHTML(v){this.children=[];},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},append(child){child.parentElement=this;this.children.push(child);},querySelectorAll(){return this.children.flatMap(row=>row.children);}};}
 const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element};
 const chrome={scripting:{executeScript:async({func,args})=>{if(fail)throw Error('tab closed');return [{result:vm.runInNewContext('('+func.toString()+')(...args)',{args,location:{href:changed?'https://bbs.my0511.com/f67b':url},document:{documentElement:{outerHTML:'visible HTML'}}})}];}},runtime:{sendMessage:async m=>{messages.push(m);if(m.type==='SCAN')return {ok:true,threads:[{fid:'152',tid:'123',title:'测试帖子',replies:10}]};return {list:[{tid:'123',maxFloor:5,count:5}]};}}};
 const c=vm.createContext({chrome,document,URL,console});vm.runInContext(source,c);vm.runInContext(`listTab={id:1};listUrl=${JSON.stringify(url)};isSearch=${url.includes('search.php')};`,c);
 return {run:()=>vm.runInContext('scanList()',c),elements,messages};
}
test('board and search popup read current tab HTML, render rows and select updated threads',async()=>{
 for(const url of ['https://bbs.my0511.com/f152b','https://bbs.my0511.com/search.php?searchid=1']){
  const p=popup({url});await p.run();assert.equal(p.messages[0].html,'visible HTML');assert.equal(p.messages[0].url,url);
  assert.equal(p.elements.get('links').children.length,1);assert.equal(p.elements.get('queue').disabled,false);
  assert.match(p.elements.get('searchSummary').textContent,/待更新 1/);assert.equal(p.messages.some(m=>m.type==='ENQUEUE'||m.type.includes('RESUME')),false);
 }
});
test('navigation or injection failure gives an error and clears old selectable rows',async()=>{
 for(const options of [{changed:true},{fail:true}]){
  const p=popup(options);await p.run();assert.equal(p.messages.length,0);assert.equal(p.elements.get('queue').disabled,true);assert.match(p.elements.get('status').textContent,/页面已变化或无法读取/);
 }
});
test('board list preserves reply counts, short titles and deduplicates pinned rows',()=>{
 const c=vm.createContext({});vm.runInContext(readFileSync(new URL('../extension/parser.js',import.meta.url),'utf8'),c);
 const row={querySelector(selector){return selector==='a.a_topic[href]'?{textContent:'中泠班',getAttribute:()=>'/f152b-t123z'}:selector.includes('fontblue')?{textContent:'69'}:selector.includes('tcount')?{textContent:'3170'}:{textContent:'09-27 23:56'};}};
 const rows=c.MY0511.parseThreadLinks({querySelectorAll:selector=>selector==='dl.list_dl'?[row,row]:[]});
 assert.equal(rows.length,1);assert.equal(rows[0].title,'中泠班');assert.equal(rows[0].replies,69);assert.equal(rows[0].views,3170);
});
