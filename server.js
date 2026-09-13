const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.DROPBOT_API_TOKEN || '';
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const ALERT_TO_NUMBER = process.env.ALERT_TO_NUMBER || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,'data');
const DATA_FILE = path.join(DATA_DIR,'dropbot.json');
const MIN_INTERVAL = Math.max(60, Number(process.env.MIN_CHECK_INTERVAL_SECONDS || 60));
const MAX_BODY = 1024 * 1024;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});

const initial = {monitors:[],events:[],lastSchedulerRun:null};
let db = load();

function load(){
  try { return {...initial,...JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}; }
  catch { return JSON.parse(JSON.stringify(initial)); }
}
function save(){
  const tmp = DATA_FILE+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db,null,2));
  fs.renameSync(tmp,DATA_FILE);
}
function json(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-headers':'content-type, authorization','access-control-allow-methods':'GET,POST,OPTIONS'});
  res.end(body);
}
function authorized(req){
  if(!API_TOKEN) return true;
  return req.headers.authorization === 'Bearer '+API_TOKEN;
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let buf=''; req.on('data',c=>{buf+=c;if(buf.length>MAX_BODY){reject(new Error('Request too large'));req.destroy();}});
    req.on('end',()=>{try{resolve(buf?JSON.parse(buf):{})}catch{reject(new Error('Invalid JSON'))}});
    req.on('error',reject);
  });
}
function cleanMonitor(m){
  const interval=Math.max(MIN_INTERVAL, Number(m.interval||300));
  return {
    id:String(m.id||crypto.randomUUID()),
    name:String(m.name||'Unnamed monitor').slice(0,200),
    url:String(m.url||'').trim().slice(0,2000),
    sku:String(m.sku||'').slice(0,100),
    store:String(m.store||'').slice(0,100),
    size:String(m.size||'').slice(0,30),
    interval,
    active:m.active!==false,
    created:m.created||new Date().toISOString(),
    lastChecked:m.lastChecked||null,
    lastStatus:m.lastStatus||'waiting',
    lastPrice:m.lastPrice||null,
    lastMessage:m.lastMessage||''
  };
}
function addEvent(type,title,message,meta={}){
  db.events.unshift({id:crypto.randomUUID(),type,title,message,meta,createdAt:new Date().toISOString()});
  db.events=db.events.slice(0,250);
  save();
}
async function webhook(event){
  if(!WEBHOOK_URL) return;
  try{
    await fetch(WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});
  }catch(e){ console.error('Webhook delivery failed:',e.message); }
}
async function sendSMS(event){
if(!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !ALERT_TO_NUMBER) return {ok:false,stage:'config',error:'Missing SMS configuration'};

  const body = new URLSearchParams({
    To: ALERT_TO_NUMBER,
    From: TWILIO_FROM_NUMBER,
    Body: `${event.title}: ${event.message}`
  }).toString();

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  try{
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,{
      method:'POST',
      headers:{
        'Authorization':`Basic ${auth}`,
        'Content-Type':'application/x-www-form-urlencoded'
      },
      body
    });
    if(!response.ok) console.error('Twilio SMS error', response.status, await response.text());
  }catch(e){
    console.error('SMS delivery failed',e);
  }
}

function extractPrice(text){
  const patterns = [
    /"currentPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /"salePrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /"fullPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /"price"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i
  ];

  for(const pattern of patterns){
    const m = text.match(pattern);
    if(m){
      const value = Number(m[1]);
      if(value >= 20 && value <= 1000){
        return '$' + value.toFixed(2);
      }
    }
  }

  return null;
}
function inferAvailability(text){
  const t=text.toLowerCase();
  const negative=['sold out','out of stock','currently unavailable','notify me when available'];
  const positive=['add to bag','add to cart','in stock','available now','buy now'];
  if(negative.some(x=>t.includes(x))) return {status:'out-of-stock',message:'Page contains an out-of-stock indicator.'};
  if(positive.some(x=>t.includes(x))) return {status:'available',message:'Page contains an availability indicator.'};
  return {status:'unknown',message:'Page fetched, but availability could not be determined reliably.'};
}
async function checkNikeSNKRS(m){
  const checkedAt = new Date().toISOString();

  if(!m.url){
    return {
      ...m,
      status:'needs-url',
      message:'Nike / SNKRS monitor requires a direct Nike product URL.',
      checkedAt,
      price:null
    };
  }

  let u;
  try{
    u = new URL(m.url);
  }catch{
    return {
      ...m,
      status:'invalid-url',
      message:'Nike / SNKRS product URL is invalid.',
      checkedAt,
      price:null
    };
  }

  const host = u.hostname.toLowerCase();

  if(!(host === 'nike.com' || host.endsWith('.nike.com'))){
    return {
      ...m,
      status:'invalid-url',
      message:'Nike / SNKRS monitor requires a nike.com product URL.',
      checkedAt,
      price:null
    };
  }

  console.log('[DropBot] Nike/SNKRS check:', m.name || m.url);

  try{
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 12000);

    const r = await fetch(u.toString(), {
      redirect:'follow',
      signal:ctrl.signal,
      headers:{
        'user-agent':'DropBot/4.0 (+product availability monitor; respectful polling)',
        'accept':'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
        'accept-language':'en-US,en;q=0.8'
      }
    });

    clearTimeout(timeout);

    const text = (await r.text()).slice(0,1000000);

    if(!r.ok){
      return {
        ...m,
        status:'http-' + r.status,
        message:'Nike returned HTTP ' + r.status + '.',
        checkedAt,
        price:null
      };
    }

    const lower = text.toLowerCase();
    const price = extractPrice(text);

    if(m.sku && !lower.includes(String(m.sku).toLowerCase())){
      return {
        ...m,
        status:'product-mismatch',
        message:'Nike page loaded, but the saved SKU/style code was not found.',
        checkedAt,
        price
      };
    }

    const target = String(m.size || '').trim();

    if(target){
      const sizeAvailable =
        lower.includes(`"size":"${target.toLowerCase()}"`) &&
        (
          lower.includes('"available":true') ||
          lower.includes('"instock":true') ||
          lower.includes('"sellable":true')
        );

      const sizeUnavailable =
        lower.includes(`"size":"${target.toLowerCase()}"`) &&
        (
          lower.includes('"available":false') ||
          lower.includes('"instock":false') ||
          lower.includes('"sellable":false')
        );

      if(sizeAvailable){
        return {
          ...m,
          status:'available',
          message:`Nike shows size ${target} as available.`,
          checkedAt,
          price
        };
      }

      if(sizeUnavailable){
        return {
          ...m,
          status:'out-of-stock',
          message:`Nike shows size ${target} as unavailable.`,
          checkedAt,
          price
        };
      }
    }

    const negative = [
      'sold out',
      'currently unavailable',
      'notify me',
      'coming soon'
    ];

    if(negative.some(x => lower.includes(x))){
      return {
        ...m,
        status:'out-of-stock',
        message:'Nike page indicates the product is not currently available.',
        checkedAt,
        price
      };
    }

    const positive = [
      'add to bag',
      'select size',
      'available now'
    ];

    if(!target && positive.some(x => lower.includes(x))){
      return {
        ...m,
        status:'available',
        message:'Nike page shows a purchase/availability indicator.',
        checkedAt,
        price
      };
    }

    return {
      ...m,
      status:'unknown',
      message:target
        ? `Nike page loaded, but availability for size ${target} could not be confirmed reliably.`
        : 'Nike page loaded, but availability could not be confirmed reliably.',
      checkedAt,
      price
    };

  }catch(e){
    return {
      ...m,
      status:e.name === 'AbortError' ? 'timeout' : 'unreachable',
      message:e.name === 'AbortError'
        ? 'Nike request timed out.'
        : 'Could not fetch Nike product page: ' + e.message,
      checkedAt,
      price:null
    };
  }
}
async function checkOne(m){
  if(m.store === 'Nike / SNKRS'){
  const nikeResult = await checkNikeSNKRS(m);
  if(nikeResult) return nikeResult;
}
    console.log('[DropBot] checking monitor:', m.name, m.store, m.url);
  const checkedAt=new Date().toISOString();
  if(!m.url) return {...m,status:'needs-url',message:'Add a direct product URL to perform a server check.',checkedAt,price:null};
  let u; try{u=new URL(m.url)}catch{return {...m,status:'invalid-url',message:'Product URL is invalid.',checkedAt,price:null}};
  if(!['http:','https:'].includes(u.protocol)) return {...m,status:'invalid-url',message:'Only HTTP/HTTPS product URLs are supported.',checkedAt,price:null};
  try{
    const ctrl=new AbortController(); const timeout=setTimeout(()=>ctrl.abort(),12000);
    const r=await fetch(u.toString(),{
      redirect:'follow',signal:ctrl.signal,
      headers:{'user-agent':'DropBot/4.0 (+product availability monitor; respectful polling)','accept':'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5'}
    });
    clearTimeout(timeout);
    const contentType=r.headers.get('content-type')||'';
    const text=(await r.text()).slice(0,750000);
    if(!r.ok) return {...m,status:'http-'+r.status,message:'Retailer returned HTTP '+r.status+'.',checkedAt,price:null};
    let verdict={status:'unknown',message:'Endpoint checked.'};
    let price=null;
    if(contentType.includes('json')){
      try{
        const obj=JSON.parse(text);
        const blob=JSON.stringify(obj).toLowerCase();
        verdict=inferAvailability(blob);
        price=obj.price||obj.currentPrice||obj.salePrice||extractPrice(blob);
      }catch{ verdict={status:'unknown',message:'JSON endpoint returned unreadable content.'}; }
    }else{
      verdict=inferAvailability(text); price=extractPrice(text);
    }
    return {...m,...verdict,checkedAt,price};
  }catch(e){
    return {...m,status:e.name==='AbortError'?'timeout':'unreachable',message:e.name==='AbortError'?'Request timed out.':'Could not fetch product page: '+e.message,checkedAt,price:null};
  }
}
async function runChecks(monitors){
  const results=[];
  for(const raw of monitors.slice(0,100)){
    const m=cleanMonitor(raw);
    const before=m.lastStatus;
    const result=await checkOne(m);
    results.push({id:m.id,status:result.status,message:result.message,checkedAt:result.checkedAt,price:result.price});
    const idx=db.monitors.findIndex(x=>x.id===m.id);
    if(idx>=0) db.monitors[idx]={...db.monitors[idx],lastChecked:result.checkedAt,lastStatus:result.status,lastPrice:result.price,lastMessage:result.message};
    if(result.status==='available' && before!=='available'){
      const event={type:'availability',title:m.name+' may be available',message:`${m.store||'Retailer'} · Size ${m.size||'n/a'}${result.price?' · '+result.price:''}`,meta:{monitorId:m.id,url:m.url},createdAt:new Date().toISOString()};
      addEvent(event.type,event.title,event.message,event.meta); await webhook(event); await sendSMS(event);
    }
  }
  db.lastSchedulerRun=new Date().toISOString(); save(); return results;
}
async function scheduler(){
  const now=Date.now();
  const due=db.monitors.filter(m=>m.active && (!m.lastChecked || now-new Date(m.lastChecked).getTime() >= Math.max(MIN_INTERVAL,m.interval||300)*1000));
  if(due.length) await runChecks(due);
}
setInterval(()=>scheduler().catch(e=>console.error('scheduler',e)),30000).unref();

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health') return json(res,200,{ok:true,service:'dropbot',version:4,time:new Date().toISOString(),monitorCount:db.monitors.length});
  if(u.pathname.startsWith('/api/') && !authorized(req)) return json(res,401,{error:'Unauthorized'});
  try{
    if(req.method==='GET' && u.pathname==='/api/state') return json(res,200,{monitors:db.monitors,events:db.events.slice(0,25),lastSchedulerRun:db.lastSchedulerRun});
    if(req.method==='GET' && u.pathname==='/api/events') return json(res,200,{events:db.events.slice(0,50)});
    if(req.method==='GET' && u.pathname==='/api/monitors') return json(res,200,{monitors:db.monitors});
    if(req.method==='POST' && u.pathname==='/api/monitors/sync'){
      const body=await readBody(req); const monitors=Array.isArray(body.monitors)?body.monitors.map(cleanMonitor):[];
      db.monitors=monitors.slice(0,250); save(); addEvent('system','Monitor sync complete',`${db.monitors.length} monitor(s) saved to backend.`);
      return json(res,200,{ok:true,count:db.monitors.length});
    }
    if(req.method==='POST' && u.pathname==='/api/check'){
      const body=await readBody(req);
      const monitors=Array.isArray(body.monitors)?body.monitors:db.monitors.filter(m=>m.active);
      const results=await runChecks(monitors);
      return json(res,200,{ok:true,results,checkedAt:new Date().toISOString()});
    }
    if(req.method==='POST' && u.pathname==='/api/events/test'){
      const event={type:'test',title:'DropBot test alert',message:'Backend alert delivery test',meta:{},createdAt:new Date().toISOString()};
      addEvent(event.type,event.title,event.message,event.meta); await webhook(event); await sendSMS(event);
      return json(res,200,{ok:true,event});
    }

    // Serve the PWA from the same process in production.
    let file=u.pathname==='/'?'index.html':u.pathname.slice(1);
    file=path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const fp=path.join(__dirname,file);
    if(fp.startsWith(__dirname) && fs.existsSync(fp) && fs.statSync(fp).isFile()){
      const ext=path.extname(fp);
      const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
      res.writeHead(200,{'content-type':types[ext]||'application/octet-stream'}); return fs.createReadStream(fp).pipe(res);
    }
    return json(res,404,{error:'Not found'});
  }catch(e){ return json(res,400,{error:e.message||'Request failed'}); }
});

server.listen(PORT,HOST,()=>console.log(`DropBot v4 listening on http://${HOST}:${PORT}`));
