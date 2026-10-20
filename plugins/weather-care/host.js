import path from 'node:path';
import {SendQueue} from '../../src/sender.js';

// The host's administrative send route owns the live QQ connection and ChatStore.
// Wrap it in the real SendQueue class; do not open another QQ connection or write archives.
// After a forecast tool runs, prefer the host's shared ctx.sender for subsequent reminders.
export function createHost({fetch,getHostConfig,dataDir,targetsOf,coordinator}) {
  let base='',baseAt=0;
  const signals=new Map();
  const headers=()=>{
    const token=getHostConfig().server?.token;
    return token?{'x-console-token':token}:{};
  };
  async function request(route,{signal,method='GET',body,timeout=8000}={}){
    signal?.throwIfAborted();
    const response=await fetch((await discover(signal))+route,{method,headers:{...headers(),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),
      signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(timeout)])});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||`QQ Agent HTTP ${response.status}`);
    return result;
  }
  async function discover(signal){
    if(base&&Date.now()-baseAt<60000)return base;
    const port=Number(getHostConfig().server?.port)||3210;
    for(let p=port;p<port+10;p++){
      signal?.throwIfAborted();
      try{
        const candidate='http://127.0.0.1:'+p;
        const r=await fetch(candidate+'/api/status',{headers:headers(),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(3500)])});
        if(!r.ok)continue;
        const s=await r.json();
        if(typeof s.dataDir==='string'&&path.resolve(s.dataDir).toLowerCase()===path.resolve(dataDir).toLowerCase()){base=candidate;baseAt=Date.now();return base;}
      }catch(error){if(signal?.aborted)throw error;}
    }
    throw new Error('找不到本实例的 QQ Agent 控制台，暂停天气提醒');
  }
  const status=signal=>request('/api/status',{signal});
  const messages=(chatKey,signal)=>request('/api/chats/'+chatKey.replace(':','_')+'/messages?limit=50',{signal}).then(r=>r.messages||[]);
  const queue=new SendQueue({
    onebot:{async sendText(kind,id,text){
      const chatKey=`${kind}:${id}`,signal=signals.get(chatKey);
      signal?.throwIfAborted();
      if(!targetsOf(getHostConfig()).includes(chatKey))throw new Error('接收对象已移出白名单');
      const s=await status(signal);
      if(s.paused||!s.onebot?.connected)throw new Error('QQ 离线或宿主已暂停');
      const r=await request('/api/chats/'+chatKey.replace(':','_')+'/test-send',{signal,method:'POST',body:{text},timeout:95000});
      if(r.ok!==true||r.messageId==null)throw new Error('QQ 未返回消息编号，发送未确认');
      return {message_id:r.messageId};
    }},
    store:{appendSelf(){}}, // The host route already appends to its live shared ChatStore exactly once.
    log:()=>{}
  });
  async function send(chatKey,text,signal){
    signal?.throwIfAborted();
    if(!targetsOf(getHostConfig()).includes(chatKey))throw new Error('接收对象不在 QQ Agent 白名单内');
    const s=await status(signal);
    if(s.paused||!s.onebot?.connected)throw new Error('QQ 离线或宿主已暂停');
    // Serialize both scheduled and chat care, including across hot reloads.
    const previous=coordinator.sendChain||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();
      if(!targetsOf(getHostConfig()).includes(chatKey))throw new Error('接收对象已移出白名单');
      signals.set(chatKey,signal);
      try{
        const result=await (coordinator.sender||queue).sendTextBatch(chatKey,[text]);
        const sent=result.sent?.find(m=>m.messageId!=null);
        if(!sent)throw new Error('发送结果没有消息编号，未确认');
        return {messageId:sent.messageId};
      }finally{signals.delete(chatKey);}
    });
    coordinator.sendChain=task.catch(()=>{});
    return task;
  }
  return {status,messages,send,canSend:async signal=>{const s=await status(signal);return !s.paused&&s.onebot?.connected===true;}};
}
