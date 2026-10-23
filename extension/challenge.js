// Exact adapter for the observed /captcha form. No arithmetic solving occurs here.
const Challenge=(()=>{
 function inspect(){
  const u=new URL(location.href);const f=document.querySelector('form[action="/captcha/verify"]');
  if(u.origin!=='https://bbs.my0511.com'||u.pathname!=='/captcha'||!f||f.method.toLowerCase()!=='post'||!f.querySelector('input#answer[name=answer]'))return null;
  const problem=u.searchParams.get('problem');if(!problem||problem.length>120)return null;
  // Hidden values stay in the original page; only a fingerprint goes to the service.
  return {url:u.href,problem,fields:[...f.querySelectorAll('input[type=hidden]')].map(e=>[e.name,e.value])};
 }
 async function snapshot(tabId){const [r]=await chrome.scripting.executeScript({target:{tabId},func:inspect});if(!r?.result)return null;const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(r.result)));return {url:r.result.url,problem:r.result.problem,revision:Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,16)};}
 async function refresh(){let c=await Safety.read('humanChallenge',null);if(!c||c.kind==='login')return;
  if(c.tabId==null){const tab=await chrome.tabs.create({url:Safety.forumUrl(c.url),active:false});c=await Safety.update('humanChallenge',v=>v?.id===c.id?{...v,tabId:tab.id}:v,null);}
  try{const tab=await chrome.tabs.get(c.tabId);Safety.forumUrl(tab.url);const s=await snapshot(c.tabId);if(s)await Safety.update('humanChallenge',v=>v?.id===c.id?{...v,...s}:v,null);}catch{}
 }
 async function answer({id,revision,answer}){return Safety.serial('challenge-answer',async()=>{
  const c=await Safety.read('humanChallenge',null);if(!c||c.id!==id||c.revision!==revision||!/^[-+]?\d{1,8}$/.test(answer))throw new Error('题目或答案格式已失效');
  const s=await snapshot(c.tabId);if(!s||s.revision!==revision) {await refresh();throw new Error('页面题目已经变化，请使用新通知');}
  // Mark consumed before the side effect. Never replay a submission after a worker restart.
  if(c.answerAttempt===revision)throw new Error('此题已提交过，请在电脑核实验证结果');
  await Safety.update('humanChallenge',v=>{if(v?.id!==id||v.revision!==revision)throw new Error('挑战已改变');return {...v,answerAttempt:revision};},null);
  const [r]=await chrome.scripting.executeScript({target:{tabId:c.tabId},func:async({answer,expectedUrl,revision})=>{
   if(location.href!==expectedUrl)return false;const f=document.querySelector('form[action="/captcha/verify"]');if(!f||f.method.toLowerCase()!=='post')return false;const input=f.querySelector('input#answer[name=answer]');if(!input)return false;const captured=JSON.stringify({url:location.href,problem:new URL(location.href).searchParams.get('problem'),fields:[...f.querySelectorAll('input[type=hidden]')].map(e=>[e.name,e.value])});const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(captured));const currentRevision=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,16);if(currentRevision!==revision||location.href!==expectedUrl)return false;input.value=answer;input.dispatchEvent(new Event('input',{bubbles:true}));f.requestSubmit();return true;
  },args:[{answer,expectedUrl:s.url,revision}]});
  if(!r?.result)throw new Error('未能提交，保持暂停');await Safety.event('human_answer_submitted',{challengeId:id});return {ok:true};
 });}
 chrome.tabs.onUpdated.addListener((tabId,info)=>{if(info.status!=='complete')return;Safety.serial('challenge-loaded',async()=>{const c=await Safety.read('humanChallenge',null);if(!c||c.tabId!==tabId)return;await refresh();if(c.answerAttempt)await Control.handle({type:'CONTROL_VERIFY_CHALLENGE',id:c.id});}).catch(()=>{});});
 return {refresh,answer,snapshot};
})();
