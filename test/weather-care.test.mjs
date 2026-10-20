import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configOf,dueSlots,targetsOf,analyze,normalizeForecast,weatherName,WeatherEngine} from '../plugins/weather-care/engine.js';
import {ChatCare,occasionOf,blocked,ruleDecision,chatSummary} from '../plugins/weather-care/chat.js';
import {trustedUrl,createWeatherService} from '../plugins/weather-care/network.js';

const hostRoot=process.env.QQ_AGENT_APP_ROOT;
const hostTest={skip:hostRoot?false:'Set QQ_AGENT_APP_ROOT to a compatible QQ Agent app root'};
const now=Date.parse('2026-10-20T14:00:10Z'); // 22:00 in Asia/Shanghai
const cfg=()=>configOf({city:'重庆',aiCare:false});
const day=(date,patch={})=>({date,code:0,max:24,min:18,rain:0,precipitation:0,gust:10,uv:3,...patch});
const forecast=(patch={})=>({place:{name:'重庆',latitude:29.56,longitude:106.55},source:'Open-Meteo',timeZone:'Asia/Shanghai',fetchedAt:now,
  days:[day('2026-10-19'),day('2026-10-20'),day('2026-10-21',patch),day('2026-10-22',patch)]});
const slot={date:'2026-10-20',kind:'evening'};
const hostCfg={allow:{private:['123'],groups:['456']},deny:{groups:['456']}};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'weather-care-test-'));
const dirs=[];test.after(()=>{for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});
function folder(){const d=tmp();dirs.push(d);return d;}
function scheduled(options={}){
  const sent=[],c=cfg();let engine;
  engine=new WeatherEngine({dir:folder(),getConfig:()=>c,hostConfig:()=>hostCfg,now:()=>now,forecast:async()=>forecast({code:61,rain:80}),care:async()=>'',
    send:async(k,text)=>{sent.push({k,text});engine.controller.abort();return {messageId:1};},...options});
  engine.running=true;engine.controller=new AbortController();return {engine,sent,c};
}
function chatting(options={}){
  const sent=[],c=cfg(),messages=[{id:1,ts:now-30000,text:'我要睡觉了',self:false,senderId:'123'}];
  const host={status:async()=>({paused:false,onebot:{connected:true},orchestrator:{running:[]}}),messages:async()=>messages};
  const chat=new ChatCare({dir:folder(),getConfig:()=>c,hostConfig:()=>hostCfg,host,now:()=>now,
    forecast:async()=>forecast({code:61,rain:80}),writeCare:async()=>({send:true,text:'明天出门记得带伞，晚安。'}),send:async(k,text)=>{sent.push({k,text});return {messageId:2};},...options});
  chat.running=true;chat.startedAt=now-60000;chat.controller=new AbortController();return {chat,sent,c,messages,host};
}
test('manifest settings align; optional installed host schema validation',async()=>{
  const raw=JSON.parse(fs.readFileSync(new URL('../plugins/weather-care/plugin.json',import.meta.url),'utf8'));
  if(hostRoot){
    const {normalizeManifest}=await import(pathToFileURL(path.join(hostRoot,'src/skills/manifest.js')));
    const {problems}=normalizeManifest(raw);assert.deepEqual(problems,[]);
  }
  assert.equal(raw.id,'weather-care');assert.equal(raw.apiVersion,1);assert.equal(raw.entry,'index.js');
  assert.deepEqual(Object.keys(raw.settings).sort(),Object.keys(raw.configSchema).sort());
  assert.equal(raw.version,'1.1.0');assert.deepEqual(raw.capabilities,[]);
  assert.equal(configOf(raw.settings).chatEnabled,true);
});
test('times, coordinates, booleans, thresholds validated',()=>{
  for(const bad of [{eveningTime:'25:00'},{morningTime:'22:00'},{latitude:'x',longitude:'1'},{latitude:'1'},{timeZone:'Nope'},{temperatureChange:0},{chatMaxPerDay:0},{chatGraceSeconds:121},{aiCare:'false'}])assert.throws(()=>configOf(bad));
});
test('explicit whitelist, deny priority and no empty-list broadcast',()=>{
  assert.deepEqual(targetsOf(hostCfg),['private:123']);assert.deepEqual(targetsOf({allowAllWhenEmpty:true}),[]);
  assert.deepEqual(targetsOf({allow:{group:['12']},deny:{group:['12'],groups:[]}}),[]);
});
test('evening, midnight and cross-midnight catchup retain original date',()=>{
  assert.equal(dueSlots(now,cfg())[0].kind,'evening');
  const c=configOf({eveningTime:'23:50',morningTime:'07:00'});
  assert.deepEqual(dueSlots(Date.parse('2026-10-20T16:05:00Z'),c),[{kind:'evening',date:'2026-10-20',time:'23:50'}]);
  assert.equal(dueSlots(Date.parse('2026-10-20T16:40:00Z'),c).length,0);
  assert.equal(dueSlots(Date.parse('2026-10-20T16:00:00Z'),configOf({morningTime:'00:00'}))[0].date,'2026-10-21');
});
test('stable weather quiet; daily briefing optional',()=>{
  assert.equal(analyze(forecast(),slot,cfg()).shouldSend,false);assert.equal(analyze(forecast(),slot,{...cfg(),dailyBriefing:true}).shouldSend,true);
});
test('rise/drop use adjacent days, not day/night range',()=>{
  assert(analyze(forecast({max:30}),slot,cfg()).reasons.some(s=>s.includes('上升 6')));
  assert(analyze(forecast({min:10}),slot,cfg()).reasons.some(s=>s.includes('下降 8')));
  const f=forecast();f.days.forEach(d=>{d.max=29;d.min=10;});assert.equal(analyze(f,slot,cfg()).shouldSend,false);
});
for(const [name,patch]of Object.entries({rain:{code:61},probability:{rain:65},snow:{code:73},freezingRain:{code:66},fog:{code:45},thunder:{code:95},hail:{code:99},heat:{max:36},cold:{min:-1},gust:{gust:60},uv:{uv:7}})){
  test('detects '+name,()=>assert.equal(analyze(forecast(patch),slot,cfg()).shouldSend,true));
}
test('thunder code does not invent hail',()=>{assert.equal(weatherName(95),'雷暴');assert.equal(weatherName(99),'雷暴伴冰雹');});
test('rejects missing critical fields and stale dates',()=>{
  const data={daily:{time:['2026-10-20','2026-10-21'],weather_code:[0,0],temperature_2m_max:[20,20],temperature_2m_min:[10,10],precipitation_probability_max:[0,0],precipitation_sum:[0,0],wind_gusts_10m_max:[0,0],uv_index_max:[2,2]}};
  assert.equal(normalizeForecast(data,now,cfg(),{}).days.length,2);
  for(const field of ['weather_code','temperature_2m_min','precipitation_probability_max','precipitation_sum','wind_gusts_10m_max','uv_index_max']){
    const copy=structuredClone(data);delete copy.daily[field];assert.throws(()=>normalizeForecast(copy,now,cfg(),{}));
  }
  const stale=structuredClone(data);stale.daily.time=['2026-10-18','2026-10-19'];assert.throws(()=>normalizeForecast(stale,now,cfg(),{}));
});
test('scheduled delivery persists dedupe across engine instances',async()=>{
  const h=scheduled();await h.engine.tick();assert.equal(h.sent.length,1);
  const h2=scheduled({dir:h.engine.dir});await h2.engine.tick();assert.equal(h2.sent.length,0);
});
test('stable schedule avoids sending and records quiet',async()=>{
  const h=scheduled({forecast:async()=>forecast()});await h.engine.tick();assert.equal(h.sent.length,0);assert.equal(Object.values(h.engine.state().deliveries)[0].status,'quiet');
});
test('preview does not send or consume real-send dedupe',async()=>{
  const h=scheduled();h.c.previewOnly=true;await h.engine.tick();assert.equal(h.sent.length,0);assert(fs.existsSync(path.join(h.engine.dir,'preview.json')));
  h.c.previewOnly=false;await h.engine.tick();assert.equal(h.sent.length,1);
});
test('uncertain delivery is never retried',async()=>{
  let attempts=0;const h=scheduled({send:async()=>{attempts++;throw new Error('timeout');}});await h.engine.tick();await h.engine.tick();assert.equal(attempts,1);assert.equal(Object.values(h.engine.state().deliveries)[0].status,'uncertain');
});
test('corrupt schedule state fails closed',async()=>{
  const h=scheduled();fs.writeFileSync(path.join(h.engine.dir,'state.json'),'broken');await assert.rejects(h.engine.tick());assert.equal(h.sent.length,0);
  fs.writeFileSync(path.join(h.engine.dir,'state.json'),JSON.stringify({version:1,deliveries:[]}));await assert.rejects(h.engine.tick());
});
test('disable and offline prevent work',async()=>{
  const h=scheduled({canSend:async()=>false});await h.engine.tick();assert.equal(h.sent.length,0);h.engine.stop();await h.engine.tick();assert.equal(h.sent.length,0);
});
test('AI failure still sends factual scheduled care',async()=>{
  const h=scheduled({care:async()=>{throw Error('AI offline');}});h.c.aiCare=true;await h.engine.tick();assert.equal(h.sent.length,1);assert.match(h.sent[0].text,/Open-Meteo/);
});
test('configuration change while fetching cancels scheduled send',async()=>{
  const h=scheduled();h.engine.forecast=async()=>{h.c.city='北京';return forecast({code:61});};await h.engine.tick();assert.equal(h.sent.length,0);
});
test('all requested chat themes are candidates',()=>{
  for(const text of ['睡觉了','晚安','刚起床','早安','我出门啦','穿衣怎么选','下雨了','天气怎么样'])assert(occasionOf(text));assert.equal(occasionOf('你好'),'');
});
test('chat weather uses tomorrow at bedtime and today when waking',()=>{
  assert.match(chatSummary(forecast(),'sleep',cfg(),now).facts,/明天（2026-10-21）/);assert.match(chatSummary(forecast(),'wake',cfg(),now).facts,/今天（2026-10-20）/);
});
test('chat care sends once and keeps factual attribution',async()=>{
  const h=chatting();await h.chat.tick();await h.chat.tick();assert.equal(h.sent.length,1);assert.match(h.sent[0].text,/明天/);assert.match(h.sent[0].text,/Open-Meteo/);
});
test('does not replay pre-enable messages or self messages',async()=>{
  const h=chatting();h.chat.startedAt=now;await h.chat.tick();assert.equal(h.sent.length,0);h.chat.startedAt=now-60000;h.messages[0].self=true;await h.chat.tick();assert.equal(h.sent.length,0);
});
test('normal reply and claimed session suppress background care',async()=>{
  const h=chatting();h.chat.claim('private:123',h.messages,'normal');await h.chat.tick();assert.equal(h.sent.length,0);
  const h2=chatting();h2.messages.push({id:2,self:true,ts:now-1000,text:'好的'});await h2.chat.tick();assert.equal(h2.sent.length,0);
});
test('reply arriving during generation cancels background send',async()=>{
  const h=chatting();h.chat.writeCare=async()=>{h.messages.push({id:2,self:true,ts:now,text:'晚安'});return {send:true,text:'带伞'};};await h.chat.tick();assert.equal(h.sent.length,0);
});
test('cooldown and per-day cap prevent repeated nagging',async()=>{
  const h=chatting();await h.chat.tick();h.messages.push({id:2,self:false,ts:now-21000,text:'我出门了',senderId:'123'});await h.chat.tick();assert.equal(h.sent.length,1);
  const state=h.chat.state();state.chats['private:123'].lastAt=0;state.chats['private:123'].count=6;state.chats['private:123'].lastId=0;h.chat.save(state);await h.chat.tick();assert.equal(h.sent.length,1);
});
test('AI can decline gossip; fallback is conservative',async()=>{
  const h=chatting({writeCare:async()=>({send:false,text:''})});await h.chat.tick();assert.equal(h.sent.length,0);
  const summary=chatSummary(forecast(),'sleep',cfg(),now);assert.equal(ruleDecision({text:'他说晚安是台词'},'sleep',summary).send,false);assert.equal(ruleDecision({text:'我要睡了'},'sleep',summary).send,true);
});
test('chat preview, corrupted state and disabling',async()=>{
  const h=chatting();h.c.previewOnly=true;await h.chat.tick();assert.equal(h.sent.length,0);assert(fs.existsSync(path.join(h.chat.dir,'chat-preview.json')));
  const h2=chatting();fs.writeFileSync(path.join(h2.chat.dir,'chat-state.json'),'bad');await assert.rejects(h2.chat.tick());assert.equal(h2.sent.length,0);
  const h3=chatting();h3.chat.stop();await h3.chat.tick();assert.equal(h3.sent.length,0);
});
test('respect blocklist and quiet command',()=>{
  assert(blocked({globalBlocklist:['123']},'private:123',{senderId:'123'}));assert(!blocked({globalBlocklist:['123'],communityExemptions:['123']},'private:123',{senderId:'123'}));
  assert(blocked({commandMute:{active:{456:0}}},'group:456',{senderId:'123'}));
});
test('fixed weather domains and browser lock',async()=>{
  assert.throws(()=>trustedUrl('http://api.open-meteo.com'));assert.throws(()=>trustedUrl('https://evil.com'));assert.throws(()=>trustedUrl('https://api.open-meteo.com@evil.com'));
  const service=createWeatherService({safeFetch:async()=>{throw Error('must not fetch');},checkLock:()=>({allowed:false})});await assert.rejects(service.forecast('重庆',cfg()),/浏览锁定/);
});
test('normal session starting after background claim is marked to avoid duplicate care',()=>{
  const h=chatting();h.chat.coordinator.claims.set('private:123|1',{at:now,owner:'background'});h.chat.claim('private:123',h.messages,'late');assert.equal(h.chat.coordinator.sessions.get('late').background,true);
});
test('installed host adapter uses queued local routing without a real QQ send',hostTest,async()=>{
  process.env.QQ_AGENT_DATA_DIR=folder();
  const {createHost}=await import(pathToFileURL(path.join(hostRoot,'plugins/weather-care/host.js')));
  let posts=0;
  const adapter=createHost({getHostConfig:()=>hostCfg,dataDir:process.env.QQ_AGENT_DATA_DIR,targetsOf,coordinator:{},fetch:async(url,options={})=>{
    if(String(url).endsWith('/api/status'))return Response.json({dataDir:process.env.QQ_AGENT_DATA_DIR,onebot:{connected:true},paused:false});
    assert.match(String(url),/private_123\/test-send$/);assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).text,'测试提醒');posts++;return Response.json({ok:true,messageId:789});
  }});
  const r=await adapter.send('private:123','测试提醒',new AbortController().signal);assert.equal(r.messageId,789);assert.equal(posts,1);
  await assert.rejects(adapter.send('private:999','测试提醒',new AbortController().signal),/白名单/);assert.equal(posts,1);
  const aborted=AbortSignal.abort();await assert.rejects(adapter.send('private:123','测试提醒',aborted));assert.equal(posts,1);
});
test('installed entry hooks stay local; activate/deactivate clean both loops',hostTest,async()=>{
  const m=await import(pathToFileURL(path.join(hostRoot,'plugins/weather-care/index.js')));
  const tools=[];m.setup({config:()=>({...cfg(),city:''}),registerTool:t=>tools.push(t),fetch:async()=>{throw Error('hooks must not fetch');},log:()=>{},warn:()=>{}});
  assert.equal(tools.length,2);
  m.hooks['before-context']({chatKey:'private:123',triggerEntries:[{id:99,text:'我出门了'}],sessionId:'s'});
  const messages=[];m.hooks['before-llm-messages']({messages,sessionId:'s'});assert.match(messages[0].content,/weather-care__forecast/);
  m.activate();assert.equal(m.internals.engine().running,true);assert.equal(m.internals.chat().running,true);
  m.deactivate();assert.equal(m.internals.engine().running,false);assert.equal(m.internals.chat().running,false);m.dispose();
});
