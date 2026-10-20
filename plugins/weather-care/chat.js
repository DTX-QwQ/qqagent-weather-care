import fs from 'node:fs';
import path from 'node:path';
const {configOf,targetsOf,clockParts,atomicJson,analyze,factualText,addDay,weatherName}=await import(new URL('./engine.js'+new URL(import.meta.url).search,import.meta.url));

// Candidate detection only. The AI decides whether a mention actually warrants care.
export function occasionOf(text) {
  text=String(text||'').replace(/\[CQ:[^\]]*\]/g,'').trim();
  if(!text||text.length>1200)return '';
  if(/睡觉|睡了|睡啦|睡咯|睡吧|睡前|晚安|就寝|休息了/.test(text))return 'sleep';
  if(/起床|刚醒|醒了|早安|早上好|早呀|早哇/.test(text))return 'wake';
  if(/天气|气温|温度|降温|升温|下雨|下雪|暴雨|雷暴|雷雨|台风|刮风|带伞|雨伞|穿衣|穿什么|穿啥|穿多少|外套|出门|出发|上班去了|上学去了/.test(text))return 'chat';
  return '';
}
export function blocked(host,chatKey,entry) {
  const [,id]=chatKey.split(':');
  const exemptions=new Set((host.communityExemptions||[]).map(String));
  const bans=[...(host.globalBlocklist||[]).filter(id=>!exemptions.has(String(id))),...(host.blocklist?.[id]||[])].map(String);
  if(bans.includes(String(entry.senderId)))return true;
  const until=host.commandMute?.active?.[id];
  return chatKey.startsWith('group:')&&until!==undefined&&(Number(until)===0||Number(until)>Date.now());
}
export function ruleDecision(entry,occasion,summary){
  const text=String(entry.text||'');
  // Without semantic judgement, prefer silence for quotations, third parties and opt-outs.
  if(/[“”「」『』"]|他说|她说|别人|室友|朋友|故事|台词|不要.*提醒|别.*提醒|关闭.*提醒|停止.*提醒|取消.*提醒|不睡|没睡|睡不着/.test(text))return {send:false,text:''};
  if(!/^(?:我|准备|要去|要睡|该睡|晚安|早安|早上好|刚起|刚醒|起床了|醒了|出门了|天气|今天|明天|外面|下雨|下雪)/.test(text.trim()))return {send:false,text:''};
  return {send:true,text:summary.report.tips.slice(0,2).join('；')||(occasion==='sleep'?'好好休息，晚安。':occasion==='wake'?'早安，祝你今天顺顺利利。':'出门按体感增减衣物。')};
}
export function chatSummary(data,occasion,c,now) {
  const date=clockParts(now,c.timeZone).date;
  const report=analyze(data,{date,kind:occasion==='sleep'?'evening':'morning'},c);
  const focus=data.days.find(d=>d.date===(occasion==='sleep'?addDay(date,1):date));
  const label=occasion==='sleep'?'明天':'今天';
  return {report,slot:{date,kind:occasion==='sleep'?'evening':'morning'},
    facts:`🌦️ ${data.place.name} · ${label}（${focus.date}）${weatherName(focus.code)}，${focus.min}～${focus.max}℃，${Number.isFinite(focus.rain)?`最高降水概率 ${focus.rain}%。`:'降水概率暂缺。'}`,
    full:factualText(data,{date,kind:occasion==='sleep'?'evening':'morning'},report,c)};
}

export class ChatCare {
  constructor({dir,getConfig,hostConfig,host,forecast,writeCare,send,log=()=>{},now=()=>Date.now(),coordinator={}}) {
    Object.assign(this,{dir,getConfig,hostConfig,host,forecast,writeCare,send,log,now,coordinator});
    this.running=false;this.info='等待聊天';this.lastError='';this.timer=null;
    coordinator.claims||=new Map();coordinator.sessions||=new Map();
  }
  state() {
    const file=path.join(this.dir,'chat-state.json');
    if(!fs.existsSync(file))return {version:1,chats:{}};
    const s=JSON.parse(fs.readFileSync(file,'utf8'));
    if(s.version!==1||!s.chats||Array.isArray(s.chats)||typeof s.chats!=='object')throw new Error('聊天提醒记录损坏，已暂停聊天提醒');
    for(const rec of Object.values(s.chats))if(!rec||typeof rec!=='object'||!/^\d{4}-\d{2}-\d{2}$/.test(rec.day)||!Number.isFinite(rec.count)||rec.count<0||!Number.isFinite(rec.lastAt))throw new Error('聊天提醒记录条目损坏，已暂停聊天提醒');
    return s;
  }
  save(s){atomicJson(path.join(this.dir,'chat-state.json'),s);}
  start(){if(this.running)return;this.running=true;this.startedAt=this.now();this.controller=new AbortController();this.timer=setTimeout(()=>this.loop(),5000);this.timer.unref?.();}
  stop(){this.running=false;clearTimeout(this.timer);this.controller?.abort();}
  async loop(){try{await this.tick();}catch(e){this.lastError=e.message;this.log('聊天关怀：'+e.message);}finally{if(this.running){this.timer=setTimeout(()=>this.loop(),10000);this.timer.unref?.();}}}
  claim(chatKey,entries,sessionId){
    let background=false;
    for(const e of entries||[])if(!e.self&&occasionOf(e.text)){
      const key=`${chatKey}|${e.id}`;
      if(this.coordinator.claims.get(key)?.owner==='background')background=true;
      else this.coordinator.claims.set(key,{at:this.now(),owner:'normal'});
    }
    this.coordinator.sessions.set(sessionId,{chatKey,at:this.now(),background,occasion:(entries||[]).map(e=>occasionOf(e.text)).find(Boolean)});
    for(const [key,claim]of this.coordinator.claims)if(this.now()-claim.at>3600000)this.coordinator.claims.delete(key);
    for(const [key,s]of this.coordinator.sessions)if(this.now()-s.at>3600000)this.coordinator.sessions.delete(key);
  }
  async tick(){
    if(!this.running||this.coordinator.chatBusy)return;
    const c=configOf(this.getConfig());if(c.enabled===false||!c.chatEnabled||!c.city)return;
    const fingerprint=JSON.stringify(c),signal=this.controller.signal;
    const current=()=>this.running&&!signal.aborted&&JSON.stringify(configOf(this.getConfig()))===fingerprint;
    this.coordinator.chatBusy=true;
    try{
      const state=this.state(),status=await this.host.status(signal);
      if(status.paused||!status.onebot?.connected){this.info='宿主暂停或 QQ 离线';return;}
      const today=clockParts(this.now(),c.timeZone).date;
      for(const key of Object.keys(state.chats))if(!targetsOf(this.hostConfig()).includes(key))delete state.chats[key];
      for(const chatKey of targetsOf(this.hostConfig())){
        if(!current())return;
        const messages=await this.host.messages(chatKey,signal);
        const candidates=messages.filter(m=>!m.self&&m.ts>=this.startedAt&&this.now()-m.ts<180000&&this.now()-m.ts>=c.chatGraceSeconds*1000&&occasionOf(m.text)&&!blocked(this.hostConfig(),chatKey,m));
        const e=candidates.at(-1);if(!e)continue;
        const rec=state.chats[chatKey]||={day:today,count:0,lastAt:0,lastId:null};
        if(rec.day!==today){rec.day=today;rec.count=0;}
        if(rec.lastId===e.id)continue;
        // Leave live host sessions to their normal tool-based reply path.
        if((status.orchestrator?.running||[]).includes(chatKey))continue;
        const claimKey=`${chatKey}|${e.id}`;
        if(this.coordinator.claims.has(claimKey)||messages.some(m=>m.self&&m.ts>=e.ts)){
          rec.lastId=e.id;rec.status='normal-reply';this.save(state);continue;
        }
        if(this.now()-rec.lastAt<c.chatCooldownMinutes*60000||rec.count>=c.chatMaxPerDay){rec.lastId=e.id;rec.status='cooldown';this.save(state);continue;}
        // Claim before the first asynchronous operation so a normal session can defer too.
        this.coordinator.claims.set(claimKey,{at:this.now(),owner:'background'});
        const data=await this.forecast(c.city,c,signal),occasion=occasionOf(e.text),summary=chatSummary(data,occasion,c,this.now());
        let decision;
        try{decision=await this.writeCare({chatKey,entry:e,occasion,summary,c,signal});}
        catch(error){if(signal.aborted)return;this.lastError='AI 不可用，已使用保守规则判断';decision=ruleDecision(e,occasion,summary);}
        if(!current())return;
        // A reply may have completed while weather/AI were in flight.
        const fresh=await this.host.messages(chatKey,signal),freshStatus=await this.host.status(signal);
        if(!targetsOf(this.hostConfig()).includes(chatKey)||blocked(this.hostConfig(),chatKey,e))continue;
        if(freshStatus.paused||!freshStatus.onebot?.connected||(freshStatus.orchestrator?.running||[]).includes(chatKey)||fresh.some(m=>m.self&&m.ts>=e.ts)){
          rec.lastId=e.id;rec.status='normal-reply';this.save(state);continue;
        }
        if(this.now()-e.ts>=180000)continue;
        rec.lastId=e.id;
        if(!decision.send){rec.status='not-needed';this.save(state);continue;}
        const text=String(decision.text||'').trim().slice(0,260);
        if(!text){rec.status='not-needed';this.save(state);continue;}
        if(c.previewOnly){atomicJson(path.join(this.dir,'chat-preview.json'),{at:this.now(),chatKey,text});rec.status='preview';rec.lastAt=this.now();this.save(state);this.info='聊天关怀已预览';continue;}
        rec.status='pending';rec.lastAt=this.now();rec.count++;this.save(state);
        try{const r=await this.send(chatKey,text,signal);rec.status='sent';rec.messageId=r.messageId;this.info='聊天关怀已发送';this.lastError='';}
        catch(error){rec.status='uncertain';this.lastError=error.message;this.log('聊天关怀发送未确认：'+error.message);}
        this.save(state);
      }
    }finally{this.coordinator.chatBusy=false;}
  }
}
