'use strict';
// Congress Compass v0.3 — documented official-source importer, runtime request caching.
// Designed for Vercel Node Functions. No third-party libraries, tracking, or exposed API keys.
const crypto = require('node:crypto');
const UA = 'CongressCompass/0.3 (+https://www.congress.gov; civic records reader)';
const MAX_BYTES = 2_500_000;
const YEAR = new Date().getUTCFullYear();
const CONGRESS = 119 + Math.floor((YEAR - 2025) / 2);
const SESSION = YEAR % 2 ? 1 : 2;
const SOURCES = {
  house: 'Office of the Clerk, U.S. House',
  senate: 'Secretary of the U.S. Senate',
  bills: 'Congress.gov',
  govinfo: 'U.S. Government Publishing Office'
};
function plain(v){
  return String(v??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&nbsp;|&#160;/gi,' ').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n))
    .replace(/\s+/g,' ').trim();
}
function tag(s,k){let match=String(s).match(new RegExp('<(?:[\\w-]+:)?'+k+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?'+k+'\\s*>','i'));return match?plain(match[1]):''}
function iso(v){
  const text=plain(v);
  if(/^\d{4}-\d\d-\d\d/.test(text)){const d=text.slice(0,10);return Number.isNaN(Date.parse(d))?'':d}
  const m=text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if(m){const n=Date.parse(`${m[2]} ${m[1]}, ${m[3]} UTC`);return Number.isNaN(n)?'':new Date(n).toISOString().slice(0,10)}
  const d=Date.parse(text);return Number.isNaN(d)?'':new Date(d).toISOString().slice(0,10);
}
function goodUrl(url,origin){try{let u=new URL(url);return u.protocol==='https:'&&u.hostname===origin}catch{return false}}
async function request(url,secret){
  if(!url.startsWith('https://'))throw Error('HTTPS required');
  const headers={'accept':'application/xml,text/xml,application/rss+xml,text/html,application/json', 'user-agent':UA};
  if(secret)headers['x-api-key']=secret;
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(7500),redirect:'follow'});
  if(!r.ok)throw Error('HTTP '+r.status);
  if(Number(r.headers.get('content-length')||0)>MAX_BYTES)throw Error('response too large');
  const s=await r.text();if(s.length>MAX_BYTES)throw Error('response too large');
  return s;
}
function record(fields,key,verified){
  if(!fields.id||!fields.title||!fields.summary||!fields.date||!fields.url)throw Error('invalid record');
  return {level:'Federal',category:key==='house'||key==='senate'?'Recorded vote':'Legislation',
    ...fields,sourceKey:key,source:SOURCES[key],verifiedAt:verified};
}
function countsVote(xml,k){
  const y=Number(tag(xml,k==='house'?'yea-total':'yeas'));
  const n=Number(tag(xml,k==='house'?'nay-total':'nays'));
  const a=Number(tag(xml,k==='house'?'not-voting-total':'absent'));
  return Number.isInteger(y)&&Number.isInteger(n)&&Number.isInteger(a)&&y>=0&&n>=0&&a>=0?{yes:y,no:n,nv:a}:{};
}
function houseVote(xml,verified){
  const number=Number(tag(xml,'rollcall-num'));
  const question=tag(xml,'vote-question'),result=tag(xml,'vote-result'),date=iso(tag(xml,'action-date'));
  if(!number||number>3000||!question||!result||!date)throw Error('incomplete House vote');
  const bill=tag(xml,'legis-num');return record({id:`fed:house:${YEAR}:${number}`,type:'vote',area:'House',date,
    label:`Vote · House ${number}`,title:`House vote ${number}: ${question}${bill?' ('+bill+')':''}`,
    status:`Recorded question: ${result}`,summary:`The House voted on: ${question}. Recorded result: ${result}. This result applies only to the stated question and does not by itself prove a bill became law.`,
    why:'A procedural vote, amendment vote and final-passage vote have different legal effects.',
    next:'Review the official legislative history for later action; no next step is presumed.',
    people:'Members of the U.S. House; individual voting positions appear in the official record.',
    url:`https://clerk.house.gov/evs/${YEAR}/roll${number}`,...countsVote(xml,'house')},'house',verified);
}
function senateVote(xml,verified){
  const number=Number(tag(xml,'vote_number'));
  const question=tag(xml,'vote_question_text')||tag(xml,'question');
  const result=tag(xml,'vote_result'),date=iso(tag(xml,'vote_date'));
  if(!number||number>3000||!question||!result||!date)throw Error('incomplete Senate vote');
  const bill=tag(xml,'document_name');return record({id:`fed:senate:${CONGRESS}:${SESSION}:${number}`,type:'vote',area:'Senate',date,
    label:`Vote · Senate ${number}`,title:`Senate vote ${number}: ${question}${bill?' ('+bill+')':''}`,
    status:`Recorded question: ${result}`,summary:`The Senate voted on: ${question}. Recorded result: ${result}. Cloture and procedural decisions are not final enactment.`,
    why:'This record describes the exact procedural or legislative question—not necessarily passage of the underlying measure.',
    next:'Follow the official Senate calendar and bill record for any documented next step.',
    people:'U.S. senators; individual positions and not-voting designations are in the official record.',
    url:`https://www.senate.gov/legislative/LIS/roll_call_votes/vote${CONGRESS}${SESSION}/vote_${CONGRESS}_${SESSION}_${String(number).padStart(5,'0')}.htm`,...countsVote(xml,'senate')},'senate',verified);
}
function numsFromHouseIndex(s){
  const all=[...s.matchAll(/(?:rollnumber\s*=\s*|roll)(\d{1,4})(?:\.(?:xml|asp|htm))?/gi)]
    .map(m=>Number(m[1])).filter(v=>v>0&&v<2500);
  return [...new Set(all)].sort((a,b)=>b-a).slice(0,5);
}
function numsFromSenateIndex(s){
  const all=[...s.matchAll(/<vote_number>(\d{1,4})<\/vote_number>/gi)].map(m=>Number(m[1]));
  return [...new Set(all)].sort((a,b)=>b-a).slice(0,5);
}
async function house(verified){
  // The Clerk's old annual vote index sometimes returns 404. Try the current official
  // MemberVotes listing first; if its markup changes, fall back to the legacy index.
  let nums=[];
  try{
    const html=await request('https://clerk.house.gov/Votes/MemberVotes');
    nums=[...new Set([...plain(html).matchAll(/Roll\s*Call\s*Number\s*:?\s*(\d{1,4})/gi)].map(m=>+m[1]))]
      .filter(n=>n>0&&n<2500).sort((a,b)=>b-a).slice(0,5);
  }catch{}
  if(!nums.length){
    try{nums=numsFromHouseIndex(await request(`https://clerk.house.gov/evs/${YEAR}/index.asp`))}catch{}
  }
  if(!nums.length)throw Error('House official vote listings unavailable');
  const attempts=await Promise.allSettled(nums.map(n=>request(`https://clerk.house.gov/evs/${YEAR}/roll${n}.xml`).then(x=>houseVote(x,verified))));
  const records=attempts.filter(x=>x.status==='fulfilled').map(x=>x.value);
  if(!records.length)throw Error('House per-vote XML unavailable');return records;
}
async function senate(verified){
  const prefix=`https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${CONGRESS}_${SESSION}`;
  let nums=[];
  try{nums=numsFromSenateIndex(await request(prefix+'.xml'))}catch{}
  if(!nums.length){
    // An HTML menu is a separate, official representation of the session vote list.
    try{
      const html=await request(prefix+'.htm');
      const rx=new RegExp(`vote_${CONGRESS}_${SESSION}_(\\d{5})\\.htm`,'gi');
      nums=[...new Set([...html.matchAll(rx)].map(m=>Number(m[1])))].sort((a,b)=>b-a).slice(0,5);
    }catch{}
  }
  if(!nums.length)throw Error('Senate XML and HTML vote indexes unavailable');
  const attempts=await Promise.allSettled(nums.map(n=>request(`https://www.senate.gov/legislative/LIS/roll_call_votes/vote${CONGRESS}${SESSION}/vote_${CONGRESS}_${SESSION}_${String(n).padStart(5,'0')}.xml`).then(x=>senateVote(x,verified))));
  const records=attempts.filter(x=>x.status==='fulfilled').map(x=>x.value);
  if(!records.length)throw Error('Senate individual vote XML unavailable');return records;
}
function govinfoBill(xml,verified){
  const items=[...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0,18);
  const results=[];
  for(const m of items){
    const title=tag(m[1],'title'),url=tag(m[1],'link'),date=iso(tag(m[1],'pubDate'));
    if(!title||!date||!goodUrl(url,'www.govinfo.gov'))continue;
    const ident=crypto.createHash('sha256').update(url).digest('hex').slice(0,18);
    results.push(record({id:`fed:govinfo:${ident}`,area:/\b(H\.\s*R\.|H\.?R\.?|H\.\s*Res)/i.test(title)?'House':/\b(S\.|S\.\s*Res)/i.test(title)?'Senate':'Congress',
      type:'bill',date,label:'GPO · bill document',title,
      status:'Bill document published · legal status not inferred',
      summary:'The Government Publishing Office published this congressional bill document. Publishing a bill document does not prove that the bill passed either chamber or became law.',
      why:'The published text is a primary source. The bill’s latest actions must be checked separately to know what changed.',
      next:'Check Congress.gov for the complete action timeline and actual legislative status.',
      people:'U.S. Congress; sponsors and committee assignments require the linked legislative record.',url},'govinfo',verified));
  }
  if(!results.length)throw Error('GovInfo feed returned no validated bill documents');return results;
}
async function govinfo(verified){return govinfoBill(await request('https://www.govinfo.gov/rss/bills.xml'),verified)}
function billLink(type,number){const map={hr:'house-bill',s:'senate-bill',hjres:'house-joint-resolution',sjres:'senate-joint-resolution',hres:'house-resolution',sres:'senate-resolution',hconres:'house-concurrent-resolution',sconres:'senate-concurrent-resolution'};
  const part=map[type];if(!part)throw Error('bad bill type');return `https://www.congress.gov/bill/${CONGRESS}th-congress/${part}/${number}`;}
async function bills(verified,key){
  if(!key)throw Error('API_KEY_NOT_SET');
  const response=JSON.parse(await request(`https://api.congress.gov/v3/bill/${CONGRESS}?limit=25&format=json`,key));
  const items=response.bills;if(!Array.isArray(items)||!items.length)throw Error('empty Congress.gov result');
  const rows=[];
  for(const b of items){
    const type=String(b.type||'').toLowerCase().replace(/[^a-z]/g,'');const n=Number(b.number);
    const action=plain(b.latestAction?.text),date=iso(b.latestAction?.actionDate),title=plain(b.title);
    if(!n||!action||!date||!title||Number(b.congress)!==CONGRESS)continue;
    let url;try{url=billLink(type,n)}catch{continue}
    rows.push(record({id:`fed:bill:${CONGRESS}:${type}:${n}`,area:type.startsWith('h')?'House':'Senate',type:'bill',date,
      label:`Bill · ${String(b.type||'').toUpperCase()} ${n}`,title,
      status:'Latest official action recorded · enacted status not inferred',
      summary:`Latest recorded action: ${action}. This is a procedural record; consult the full history for legal effect.`,
      why:'Proposals are not laws. A reported action does not establish passage by both chambers or presidential approval.',
      next:'Check Congress.gov for the full action record and scheduled consideration.',
      people:'U.S. Congress; individual sponsors and committees are listed in the official bill record.',url},'bills',verified));
  }
  if(!rows.length)throw Error('no valid Congress.gov bill actions');return rows;
}
async function buildFeed(key){
  const verified=new Date().toISOString();
  const funcs={house:()=>house(verified),senate:()=>senate(verified),govinfo:()=>govinfo(verified),bills:()=>bills(verified,key)};
  const results=await Promise.allSettled(Object.entries(funcs).map(async ([k,loader])=>[k,await loader()]));
  const sources={},records=[];
  let i=0;for(const [k] of Object.entries(funcs)){
    const outcome=results[i++];if(outcome.status==='fulfilled'){
      const rows=outcome.value[1];records.push(...rows);
      sources[k]={name:SOURCES[k],state:'ok',lastSuccess:verified,recordCount:rows.length};
    }else{
      const reason=String(outcome.reason?.message||outcome.reason);
      const keyMissing=k==='bills'&&reason.includes('API_KEY_NOT_SET');
      sources[k]={name:SOURCES[k],state:keyMissing?'needs_api_key':'unavailable',recordCount:0,reason:keyMissing?'Free Congress.gov API key not configured':reason.slice(0,100)};
    }
  }
  const byId=new Map();for(const r of records){if(!byId.has(r.id))byId.set(r.id,r)}
  return {schemaVersion:1,generatedAt:verified,period:`${CONGRESS}th Congress · Session ${SESSION}`,mode:'server-verified-on-request',sources,records:[...byId.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,60)};
}
module.exports=async function handler(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'})}
  try{
    const feed=await buildFeed(process.env.CONGRESS_API_KEY||'');
    res.setHeader('Cache-Control','public, s-maxage=10800, stale-while-revalidate=21600');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');
    return res.status(200).json(feed);
  }catch(e){return res.status(503).json({schemaVersion:1,sources:{},records:[],error:'Official data could not be loaded'})}
};
module.exports._test={plain,tag,iso,numsFromHouseIndex,numsFromSenateIndex,houseVote,senateVote,govinfoBill,buildFeed};
