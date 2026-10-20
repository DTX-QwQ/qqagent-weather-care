import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const {normalizeForecast,clockParts,addDay}=await import(new URL('./engine.js'+new URL(import.meta.url).search,import.meta.url));

const HOSTS=new Set(['api.open-meteo.com','geocoding-api.open-meteo.com']);
const execFileAsync=promisify(execFile);
export function trustedUrl(raw) {
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!HOSTS.has(u.hostname))throw new Error('天气连接只允许固定的 Open-Meteo HTTPS 服务');
  return u;
}
let proxyValue='',proxyAt=0;
function systemProxy() {
  if(Date.now()-proxyAt<60000)return proxyValue;
  proxyAt=Date.now();proxyValue=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy||'';
  if(proxyValue||process.platform!=='win32')return proxyValue;
  try {
    const s=execFileSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],{encoding:'utf8',windowsHide:true,timeout:2000});
    if(!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(s))return '';
    let v=/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(s)?.[1]?.trim()||'';
    if(v.includes('='))v=/(?:^|;)\s*https=([^;]+)/i.exec(v)?.[1]||/(?:^|;)\s*http=([^;]+)/i.exec(v)?.[1]||'';
    proxyValue=v?(/^https?:\/\//i.test(v)?v:'http://'+v):'';
  }catch{}
  return proxyValue;
}
export function createWeatherService({safeFetch,checkLock,now=()=>Date.now()}) {
  const geoCache=new Map(),forecastCache=new Map();
  async function windowsJson(url,signal){
    // Windows Schannel can use the system TLS stack when Node TLS is reset by a proxy.
    // best-effort revocation still checks revocation when reachable; certificate/hostname validation stay on.
    const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','curl.exe');
    const proxy=systemProxy();
    const {stdout}=await execFileAsync(exe,['--silent','--show-error','--fail','--max-time','28','--proto','=https','--max-redirs','0','--ssl-revoke-best-effort','--url',trustedUrl(url).href],
      {encoding:'utf8',windowsHide:true,timeout:31000,maxBuffer:512000,signal,env:{...process.env,...(proxy?{HTTPS_PROXY:proxy,https_proxy:proxy}:{}),NO_PROXY:'',no_proxy:''}});
    signal?.throwIfAborted();return JSON.parse(stdout);
  }
  async function proxyJson(url,signal) {
    const proxy=systemProxy();if(!proxy)throw new Error('直连不可用，未配置系统 HTTP 代理');
    const {fetch,ProxyAgent}=await import('undici');const agent=new ProxyAgent(proxy);let res;
    try {
      res=await fetch(trustedUrl(url),{dispatcher:agent,redirect:'error',signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(18000)])});
      if(!res.ok)throw new Error('天气服务 HTTP '+res.status);
      const chunks=[];let bytes=0;
      for await(const chunk of res.body){bytes+=chunk.length;if(bytes>512000)throw new Error('天气响应过大');chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }finally{try{await res?.body?.cancel();}catch{}await agent.close();}
  }
  async function json(raw,signal) {
    const url=trustedUrl(raw);signal?.throwIfAborted();
    const lock=checkLock(url.href);if(!lock.allowed)throw new Error('浏览锁定未允许天气服务域名：'+url.hostname);
    try {
      const r=await safeFetch(url.href,{browseLocked:true});signal?.throwIfAborted();
      if(r.statusCode!==200||r.truncated)throw new Error('天气服务响应无效：'+r.statusCode);
      return JSON.parse(r.body);
    }catch(e){
      signal?.throwIfAborted();if(!checkLock(url.href).allowed)throw e;
      let nativeDetail='';
      if(process.platform==='win32'){
        try{return await windowsJson(url.href,signal);}catch(nativeError){signal?.throwIfAborted();nativeDetail=String(nativeError.stderr||nativeError.code||'').trim().slice(0,180);}
      }
      try{return await proxyJson(url.href,signal);}catch(proxyError){
        throw new Error(`${url.hostname} 天气连接失败：${proxyError.message}${proxyError.cause?.code?' ('+proxyError.cause.code+')':''}${nativeDetail?'；系统网络：'+nativeDetail:''}`);
      }
    }
  }
  async function place(city,c,signal) {
    if(!city.trim())throw new Error('尚未设置城市，请在插件设置填写，或在聊天里明确说出城市');
    if(c.latitude!==''&&c.longitude!==''&&city===c.city)return {name:city,latitude:Number(c.latitude),longitude:Number(c.longitude)};
    const key=c.countryCode+'|'+city;let cached=geoCache.get(key);
    if(cached&&now()-cached.at<86400000)return cached.value;
    const language=/[a-z]/i.test(city)?'en':'zh';
    const searchName=language==='zh'?city.replace(/[市县区]$/,''):city;
    const u=new URL('https://geocoding-api.open-meteo.com/v1/search');u.search=new URLSearchParams({name:searchName,count:'10',language,format:'json',countryCode:c.countryCode.toUpperCase()}).toString();
    const data=await json(u,signal);let candidates=(data.results||[]).filter(p=>p.country_code===c.countryCode.toUpperCase());
    // Prefer exact Chinese administrative names. Never silently pick a same-name city in another region.
    const clean=s=>String(s).replace(/[市县区]$/,'').toLowerCase();
    const exact=candidates.filter(p=>clean(p.name)===clean(city));if(exact.length)candidates=exact;
    if(!candidates.length)throw new Error(`没有找到“${city}”。可改用城市拼音，或在插件设置中填写经纬度`);
    if(candidates.length>1)throw new Error(`“${city}”有多个地点：${candidates.slice(0,5).map(p=>[p.country,p.admin1,p.admin2,p.name].filter(Boolean).join('/')).join('；')}。请在插件设置填写经纬度以明确地点`);
    const p=candidates[0],value={name:[p.admin1,p.name].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · '),latitude:p.latitude,longitude:p.longitude};
    if(!Number.isFinite(value.latitude)||!Number.isFinite(value.longitude))throw new Error('城市坐标数据无效');
    geoCache.set(key,{at:now(),value});return value;
  }
  async function forecast(city,c,signal) {
    // Browser lock changes invalidate cache access as well as fresh requests.
    if(!checkLock('https://api.open-meteo.com/v1/forecast').allowed)throw new Error('浏览锁定未允许 api.open-meteo.com');
    const p=await place(city,c,signal),day=clockParts(now(),c.timeZone).date,key=[p.latitude,p.longitude,c.timeZone,day].join('|');
    const cached=forecastCache.get(key);if(cached&&now()-cached.fetchedAt<15*60000)return cached;
    const u=new URL('https://api.open-meteo.com/v1/forecast');
    u.search=new URLSearchParams({latitude:String(p.latitude),longitude:String(p.longitude),timezone:c.timeZone,past_days:'1',forecast_days:'3',temperature_unit:'celsius',wind_speed_unit:'kmh',precipitation_unit:'mm',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,uv_index_max'}).toString();
    const result=normalizeForecast(await json(u,signal),now(),c,p);
    if(!result.days.some(d=>d.date===addDay(day,-1)))throw new Error('天气服务缺少前一天数据，无法可靠判断升降温');
    forecastCache.set(key,result);if(forecastCache.size>30)forecastCache.delete(forecastCache.keys().next().value);
    return result;
  }
  return {forecast};
}
