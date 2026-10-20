import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {city:'',countryCode:'CN',latitude:'',longitude:'',eveningTime:'22:00',morningTime:'00:00',timeZone:'Asia/Shanghai',temperatureChange:5,hotTemperature:35,coldTemperature:0,windGust:50,rainProbability:60,catchUpMinutes:30,aiCare:true,extraStyle:'',dailyBriefing:false,previewOnly:false,chatEnabled:true,chatCooldownMinutes:30,chatGraceSeconds:20,chatMaxPerDay:6};
export function configOf(raw={}) {
  const c={...DEFAULTS,...raw};
  for(const key of ['city','countryCode','latitude','longitude','eveningTime','morningTime','timeZone','extraStyle']) c[key]=String(c[key]??'').trim();
  if(c.city.length>100)throw new Error('城市名称过长');
  for(const [key,min,max] of [['temperatureChange',1,30],['hotTemperature',20,50],['coldTemperature',-40,20],['windGust',20,150],['rainProbability',1,100],['catchUpMinutes',1,180],['chatCooldownMinutes',1,1440],['chatGraceSeconds',5,120],['chatMaxPerDay',1,50]]) {
    const n=Number(c[key]); if(!Number.isFinite(n)||n<min||n>max) throw new Error(`${key} 必须在 ${min}–${max} 之间`); c[key]=n;
  }
  for(const k of ['eveningTime','morningTime']) if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(c[k])) throw new Error(`${k} 请填写 HH:MM，如 22:00`);
  if(c.eveningTime===c.morningTime) throw new Error('两个提醒时间不能相同');
  new Intl.DateTimeFormat('en',{timeZone:c.timeZone}).format();
  if((c.latitude==='')!==(c.longitude==='')) throw new Error('经纬度需要同时填写，或同时留空');
  if(c.latitude!==''&&(!Number.isFinite(Number(c.latitude))||!Number.isFinite(Number(c.longitude))||Math.abs(Number(c.latitude))>90||Math.abs(Number(c.longitude))>180)) throw new Error('经纬度不合法');
  if(!/^[A-Za-z]{2}$/.test(c.countryCode)) throw new Error('国家代码应为两位字母，如 CN');
  for(const key of ['aiCare','dailyBriefing','previewOnly','chatEnabled']) if(typeof c[key]!=='boolean') throw new Error(`${key} 必须是开关值`);
  return c;
}
export function clockParts(now,timeZone) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(v=>[v.type,v.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};
}
export function addDay(date,n) {return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function dueSlots(now,c) {
  const p=clockParts(now,c.timeZone), slots=[];
  for(const [kind,time] of [['evening',c.eveningTime],['morning',c.morningTime]]) {
    const [h,m]=time.split(':').map(Number),target=h*60+m;
    // Also finds a late-evening slot just after midnight, with its ORIGINAL date.
    for(const offset of [0,-1]) {
      const elapsed=p.minute-target-offset*1440;
      if(elapsed>=0&&elapsed<=c.catchUpMinutes) slots.push({kind,date:addDay(p.date,offset),time});
    }
  }
  return slots;
}
export function targetsOf(host={}) {
  const out=[];
  for(const [kind,field] of [['private','private'],['group','groups']]) {
    const deny=new Set((host.deny?.[kind]??host.deny?.[field]??[]).map(String));
    for(const id of host.allow?.[kind]??host.allow?.[field]??[]) if(/^[1-9]\d*$/.test(String(id))&&!deny.has(String(id))) out.push(`${kind}:${id}`);
  }
  return [...new Set(out)]; // An empty whitelist never means broadcast to everyone.
}
export function weatherName(code) {
  if(code===0) return '晴'; if([1,2,3].includes(code)) return '晴间多云/阴';
  if([45,48].includes(code)) return '雾'; if([56,57,66,67].includes(code)) return '冻雨/冻毛毛雨';
  if([51,53,55].includes(code)) return '毛毛雨'; if([61,63,65,80,81,82].includes(code)) return '降雨';
  if([71,73,75,77,85,86].includes(code)) return '降雪'; if(code===95) return '雷暴'; if([96,99].includes(code)) return '雷暴伴冰雹';
  return `天气代码 ${code}`;
}
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function normalizeForecast(data,now,c,place) {
  if(data?.error) throw new Error(String(data.reason||'天气服务返回错误'));
  const d=data?.daily;
  if(!Array.isArray(d?.time)) throw new Error('天气服务没有返回逐日预报');
  if(new Set(d.time).size!==d.time.length)throw new Error('天气服务返回重复日期');
  const days=d.time.map((date,i)=>({date,code:d.weather_code?.[i],max:d.temperature_2m_max?.[i],min:d.temperature_2m_min?.[i],rain:d.precipitation_probability_max?.[i],precipitation:d.precipitation_sum?.[i],gust:d.wind_gusts_10m_max?.[i],uv:d.uv_index_max?.[i]}));
  for(const day of days) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day.date)||!finite(day.max)||!finite(day.min)||!finite(day.code)||day.min>day.max) throw new Error('天气数据日期、温度或天气代码缺失/异常，暂不生成提醒');
    for(const field of ['rain','precipitation','gust','uv']) if(!finite(day[field])||day[field]<0||(field==='rain'&&day[field]>100)) throw new Error('天气数据降水、阵风或紫外线字段缺失/异常，暂不生成提醒');
  }
  const today=clockParts(now,c.timeZone).date;
  if(!days.some(d=>d.date===today)||!days.some(d=>d.date===addDay(today,1))) throw new Error('天气数据缺少今天或明天，拒绝使用过期预报');
  return {place,days,fetchedAt:now,source:'Open-Meteo',timeZone:c.timeZone};
}
export function analyze(forecast,slot,c) {
  // Evening: today + tomorrow. Morning: the new day + its tomorrow; compare today to yesterday too.
  const selected=[slot.date,addDay(slot.date,1)].map(date=>forecast.days.find(d=>d.date===date));
  if(selected.some(d=>!d)) throw new Error('本轮预报日期不全');
  const reasons=[],tips=new Set();
  for(const day of selected) {
    const label=day.date;
    if([45,48].includes(day.code)){reasons.push(`${label} 有雾`);tips.add('雾天出行注意能见度，预留路上时间');}
    if([56,57,66,67].includes(day.code)){reasons.push(`${label} 可能冻雨`);tips.add('注意路面结冰和防滑');}
    if([51,53,55,61,63,65,80,81,82].includes(day.code)||finite(day.rain)&&day.rain>=c.rainProbability){reasons.push(`${label} 可能降雨${finite(day.rain)?`（最高概率 ${day.rain}%）`:''}`);tips.add('出门带伞，雨天路滑慢行');}
    if([71,73,75,77,85,86].includes(day.code)){reasons.push(`${label} 可能降雪`);tips.add('准备保暖外套，注意路面湿滑');}
    if([95,96,99].includes(day.code)){reasons.push(`${label} 可能${day.code===95?'雷暴':'雷暴伴冰雹'}`);tips.add('雷暴时减少户外活动，远离树下和空旷处');}
    if(day.max>=c.hotTemperature){reasons.push(`${label} 最高 ${day.max}℃，偏热`);tips.add('注意补水和防晒，避开午后长时间暴晒');}
    if(day.min<=c.coldTemperature){reasons.push(`${label} 最低 ${day.min}℃，偏冷`);tips.add('出门做好保暖');}
    if(finite(day.gust)&&day.gust>=c.windGust){reasons.push(`${label} 阵风可达 ${day.gust} km/h`);tips.add('大风时收好阳台物品，留意高空坠物');}
    if(finite(day.uv)&&day.uv>=6){reasons.push(`${label} 紫外线指数 ${day.uv}`);tips.add('白天出门做好防晒');}
    const prev=forecast.days.find(d=>d.date===addDay(day.date,-1));
    if(prev) for(const [field,name] of [['max','最高温'],['min','最低温']]) {
      const delta=Math.round((day[field]-prev[field])*10)/10;
      if(Math.abs(delta)>=c.temperatureChange){reasons.push(`${label} ${name}比前一天${delta>0?'上升':'下降'} ${Math.abs(delta)}℃`);tips.add(delta>0?'气温回升，衣物方便增减，别穿得太闷':'气温下降，提前备好外套，早晚注意保暖');}
    }
  }
  return {days:selected,reasons:[...new Set(reasons)],tips:[...tips],shouldSend:reasons.length>0||c.dailyBriefing};
}
export function factualText(forecast,slot,report,c) {
  const greeting=slot.kind==='evening'?'睡前天气提醒':'新一天的天气提醒';
  const rows=report.days.map(d=>`${d.date}：${weatherName(d.code)}，${d.min}～${d.max}℃${finite(d.rain)?`，最高降雨概率 ${d.rain}%`:''}`);
  const p=clockParts(forecast.fetchedAt,c.timeZone);
  return `🌦️ ${forecast.place.name} · ${greeting}\n${rows.join('\n')}\n${report.reasons.length?'留意：'+report.reasons.join('；'):'今明两天气温变化不大，暂未触发特殊天气提醒。'}${report.tips.length?'\n小建议：'+report.tips.join('；')+'。':''}\n预报来源：Open-Meteo（查询于 ${p.date} ${String(Math.floor(p.minute/60)).padStart(2,'0')}:${String(p.minute%60).padStart(2,'0')}，${c.timeZone}；非气象部门官方预警）。`;
}
export function atomicJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true}); const temp=file+`.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8'); fs.renameSync(temp,file);
}
export class WeatherEngine {
  constructor({dir,getConfig,hostConfig,forecast,care,send,canSend=async()=>true,log=()=>{},now=()=>Date.now(),coordinator={busy:false}}) {Object.assign(this,{dir,getConfig,hostConfig,forecast,care,send,canSend,log,now,coordinator});this.running=false;this.timer=null;this.controller=null;this.info='等待检查';this.lastError='';this.nextRetry=0;}
  state() {
    const file=path.join(this.dir,'state.json');
    if(!fs.existsSync(file)) return {version:1,deliveries:{}};
    const state=JSON.parse(fs.readFileSync(file,'utf8')); // Corruption must fail closed, never reset dedupe.
    if(state.version!==1||!state.deliveries||Array.isArray(state.deliveries)||typeof state.deliveries!=='object') throw new Error('提醒记录格式异常，已暂停发送');
    for(const record of Object.values(state.deliveries))if(!record||!/^\d{4}-\d{2}-\d{2}$/.test(record.date)||!['pending','sent','uncertain','quiet','preview'].includes(record.status))throw new Error('提醒记录条目异常，已暂停发送');
    return state;
  }
  save(state) {atomicJson(path.join(this.dir,'state.json'),state);}
  start() {if(this.running)return;this.running=true;this.controller=new AbortController();this.timer=setTimeout(()=>this.loop(),1000);this.timer.unref?.();}
  stop() {this.running=false;clearTimeout(this.timer);this.controller?.abort();}
  async loop() {try{await this.tick();}catch(e){this.lastError=e.message;this.info='检查失败';this.nextRetry=this.now()+5*60000;this.log(e.message);}finally{if(this.running){this.timer=setTimeout(()=>this.loop(),30000);this.timer.unref?.();}}}
  status() {let cfg,error;try{cfg=configOf(this.getConfig());}catch(e){error=e.message;}return {running:this.running,city:cfg?.city||'未配置',times:cfg?[cfg.eveningTime,cfg.morningTime]:[],timeZone:cfg?.timeZone,recipients:targetsOf(this.hostConfig()).length,info:!cfg?.city?'等待在插件设置中填写城市':this.info,lastError:error||this.lastError,previewOnly:cfg?.previewOnly};}
  async tick() {
    if(!this.running||this.coordinator.busy||this.now()<this.nextRetry)return;
    const c=configOf(this.getConfig());if(c.enabled===false)return;
    if(!c.city){this.info='等待在插件设置中填写城市';return;}
    const targets=targetsOf(this.hostConfig());if(!targets.length){this.info='白名单为空，无接收对象';return;}
    const now=this.now(),slots=dueSlots(now,c);if(!slots.length){this.info='等待下个提醒时间';return;}
    this.coordinator.busy=true;const fingerprint=JSON.stringify(c),signal=this.controller.signal;
    const current=()=>this.running&&!signal.aborted&&JSON.stringify(configOf(this.getConfig()))===fingerprint;
    try {
      const state=this.state();
      // Keep a month of delivery records. 'pending' is deliberately terminal after a crash/timeout.
      const cutoff=addDay(clockParts(now,c.timeZone).date,-30);
      for(const [key,r] of Object.entries(state.deliveries)) if(r.date<cutoff)delete state.deliveries[key];
      const jobs=slots.flatMap(slot=>targets.map(chatKey=>({slot,chatKey,key:`${slot.date}|${slot.kind}|${chatKey}|${c.previewOnly?'preview':'send'}`}))).filter(j=>!state.deliveries[j.key]);
      if(!jobs.length){this.info='本时段已处理';return;}
      if(!await this.canSend(signal)){this.info='QQ 离线或宿主暂停，稍后补查';return;}
      const data=await this.forecast(c.city,c,signal);
      for(const {slot,chatKey,key} of jobs) {
        if(!current())return;
        if(!await this.canSend(signal))return;
        if(!targetsOf(this.hostConfig()).includes(chatKey))continue;
        const report=analyze(data,slot,c);
        if(!report.shouldSend){state.deliveries[key]={date:slot.date,status:'quiet',at:this.now()};this.save(state);this.info='天气平稳，本轮不打扰';continue;}
        const factual=factualText(data,slot,report,c);let care='';
        if(c.aiCare)try{care=String(await this.care({chatKey,forecast:data,slot,report,c,signal})).trim().slice(0,280);}catch(e){if(signal.aborted)return;this.lastError='AI 关怀文案不可用，已使用规则提醒';this.log(this.lastError);}
        const text=factual+(care?'\n\n'+care:'');
        if(!current()||!targetsOf(this.hostConfig()).includes(chatKey))return;
        // Discard results if generation ran beyond the configured delivery window.
        if(!dueSlots(this.now(),c).some(s=>s.date===slot.date&&s.kind===slot.kind))return;
        if(c.previewOnly){atomicJson(path.join(this.dir,'preview.json'),{at:this.now(),chatKey,text});state.deliveries[key]={date:slot.date,status:'preview',at:this.now()};this.save(state);this.info='已生成预览，未发送';continue;}
        state.deliveries[key]={date:slot.date,status:'pending',at:this.now()};this.save(state);
        try {
          const result=await this.send(chatKey,text,signal);
          state.deliveries[key]={date:slot.date,status:'sent',at:this.now(),messageId:result.messageId};
          this.info='天气提醒已发送';this.lastError='';
        }catch(e){state.deliveries[key]={date:slot.date,status:'uncertain',at:this.now(),error:e.message};this.lastError=e.message;this.info='发送未确认，停止自动重发以免重复';this.log(this.info+'：'+e.message);}
        this.save(state);
        if(signal.aborted)return;
        await new Promise(resolve=>{const t=setTimeout(done,1200);function done(){clearTimeout(t);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
      }
    }finally{this.coordinator.busy=false;}
  }
}
