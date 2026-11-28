// Deliberate opt-in only. The test Worker has an in-memory database and no listener.
import {randomBytes, randomUUID} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {open, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {casePacks,selectCases} from './cases.mjs';
import {validSegments} from './assert-turn.mjs';
import {checkoutIdentity, sha256 as digest} from './identity.mjs';

const modes = {
  gemini: {base:'https://generativelanguage.googleapis.com', models:['gemini-3-flash-preview','gemini-3.5-flash-lite'],
    paths:model => [`/v1beta/models/${model}:generateContent`, `/v1beta/models/${model}:streamGenerateContent?alt=sse`]},
  mistral: {base:'https://api.mistral.ai/v1', models:['mistral-small-latest'], paths:() => ['/v1/chat/completions']}
};
const route = (root, name) => pathToFileURL(resolve(root,name)).href;
const corpusPath = 'static/course/learning-corpus.json';
const transportFiles = ['src/worker.js','src/tutor-chat.js','src/tutor-context.js','src/tutor-session.js',
  'src/voice/live-turn.js','src/learning-rag.js','src/llm.js','src/providers.js'];

function database(db) {
  return {prepare(sql) {
    let params=[];
    return {bind(...values) {params=values; return this;}, async first() {return db.prepare(sql).get(...params) ?? null;},
      async all() {return {results:db.prepare(sql).all(...params)};}, async run() {db.prepare(sql).run(...params); return {success:true};}};
  },async batch(statements) {
    db.exec('BEGIN');
    try {
      const result=[];
      for (const statement of statements) result.push(await statement.run());
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }};
}

function parseLive(raw) {
  const segments=[];
  let completed;
  if (!raw.endsWith('\n\n') || Buffer.byteLength(raw)>256*1024) return {error:'invalid_stream'};
  for (const frame of raw.slice(0,-2).split('\n\n')) {
    const match=/^event: (segment|done|error)\ndata: (.+)$/.exec(frame);
    if (!match || completed) return {error:'invalid_stream'};
    const row=JSON.parse(match[2]);
    if (match[1]==='error') return {error:/^live_[a-z_]+$/.test(row?.code) ? row.code : 'stream_error'};
    if (match[1]==='done') completed=row;
    else if (row && typeof row==='object') {
      const {index,lang,boundary,text}=row;
      segments.push({index,lang,boundary,text});
    } else return {error:'invalid_stream'};
  }
  if (!completed || completed.count!==segments.length || !validSegments(segments,completed.full_text)
    || typeof completed.japanese_only!=='boolean') return {error:'incomplete_stream'};
  return {reply:completed.full_text,segments,japanese_only:completed.japanese_only};
}

async function capture([root,expectedHash,pack,protocol,model,path,approval,limitText,resumeFlag,resumePath]) {
  const mode=Object.hasOwn(modes,protocol) && modes[protocol];
  if (approval!=='--approved-live' || !/^[1-9]\d{0,2}$/.test(limitText ?? '') || !path || !/^[\da-f]{64}$/.test(expectedHash ?? '')
    || !casePacks.includes(pack) || !mode?.models.includes(model) || process.stdin.isTTY
    || (resumeFlag!==undefined && (resumeFlag!=='--resume-from' || !resumePath))) {
    throw new Error(`Usage: capture.mjs <checkout> <prompt-sha256> <${casePacks.join('|')}> <gemini|mistral> <model> <new-output.json> --approved-live <max-new-requests>; pipe one API key on stdin after explicit approval.`);
  }
  const limit=Number(limitText);
  const identity=checkoutIdentity(root);
  const {revision}=identity;
  if (revision!==expectedHash) throw new Error('Prompt changed after approval.');
  const selected=await selectCases(pack);
  const [{default:worker},{hashToken},{buildTeacherCatalog}]=await Promise.all([
    import(route(root,'src/worker.js')),import(route(root,'src/auth.js')),import(route(root,'scripts/build_teacher_catalog.mjs'))
  ]);
  const catalogs=await buildTeacherCatalog();
  const corpus=readFileSync(resolve(root,corpusPath));
  const transportDigest=digest(JSON.stringify(transportFiles.map(file=>digest(readFileSync(resolve(root,file))))));
  const qFor=item=>item.focus?.kind==='question' ? catalogs[item.level]?.lessons[item.lesson.id]?.questions[item.focus.index] : null;
  for (const item of selected) {
    const question=qFor(item);
    if (item.focus?.kind==='question' && (!question?.revision || question.unavailable_reason)) throw new Error('A canonical task is unavailable.');
  }
  const turns=selected.flatMap(item=>item.steps.map(step=>({id:`${item.channel}/${item.id}/${step.id}`,channel:item.channel,
    expected_calls:Number(item.channel==='chat' || qFor(item)?.mode!=='choice'),status:null,error:'not_run',reply:null})));
  const planned=turns.length, expectedCalls=turns.reduce((total,row)=>total+row.expected_calls,0);
  if (!planned || (!resumePath && expectedCalls>limit)) throw new Error('Case plan exceeds the approved request limit.');
  let key='';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    key+=chunk;
    if (key.length>260) throw new Error('Invalid input length.');
  }
  key=key.trim();
  if (!/^[\w.-]{12,256}$/.test(key)) throw new Error('An API key is required on stdin.');
  const originalFetch=globalThis.fetch, providerOrigin=new URL(mode.base).origin;
  const paths=mode.paths(model);
  let networkCalls=0, upstreamStatus=null, previousStart=-Infinity, permit=null;
  let skipCases=0, skipRows=0;
  const report={...identity,model,protocol,pack,planned,expected_calls:expectedCalls,network_calls:0,turns,
    case_digest:digest(JSON.stringify(selected)),ground_digest:digest(JSON.stringify([digest(corpus),catalogs])),transport_digest:transportDigest};
  if (resumePath) {
    const prior=JSON.parse(await readFile(resumePath,'utf8'));
    if (!['revision','runtime_digest','model','protocol','pack','planned','expected_calls','case_digest','ground_digest','transport_digest']
      .every(field=>prior?.[field]===report[field]) || prior.turns?.length!==planned
      || !turns.every((row,index)=>prior.turns[index]?.id===row.id)) throw new Error('Resume inputs do not match this recording.');
    const blocked=prior.turns.find(row=>row.error && row.error!=='not_run');
    if (blocked?.error!=='unexpected_provider_wiring' || blocked.provider_calls!==0 || blocked.upstream_status!==null) {
      throw new Error('Resume is only for an internal capture failure before contacting the provider.');
    }
    for (const item of selected) {
      const rows=prior.turns.slice(skipRows,skipRows+item.steps.length);
      if (!rows.every((row,index)=>!row.error && row.status===200 && row.channel===item.channel
        && row.expected_calls===turns[skipRows+index].expected_calls && row.provider_calls===row.expected_calls
        && row.upstream_status===(row.expected_calls ? 200 : null) && typeof row.reply==='string'
        && !row.reply.replace(/\s+/gu,'').includes(key) && (item.channel!=='live' || validSegments(row.segments,row.reply)))) break;
      for (const [index,row] of rows.entries()) {
        const {status,reply,provider_calls,upstream_status}=row;
        Object.assign(turns[skipRows+index],{status,reply,provider_calls,upstream_status,error:null});
        if (typeof row.opened_new_probe==='boolean') turns[skipRows+index].opened_new_probe=row.opened_new_probe;
        if (item.channel==='live') {
          turns[skipRows+index].segments=row.segments.map(({index,lang,boundary,text})=>({index,lang,boundary,text}));
          turns[skipRows+index].japanese_only=item.japaneseOnly===true;
        }
      }
      skipRows+=rows.length;skipCases++;
    }
    networkCalls=report.network_calls=report.carried_calls=turns.slice(0,skipRows).reduce((sum,row)=>sum+row.provider_calls,0);
    if (prior.turns[skipRows]!==blocked || prior.network_calls!==networkCalls
      || prior.turns.slice(skipRows).some(row=>(row.provider_calls ?? 0)!==0)) throw new Error('Resume requires an exact case boundary and no discarded provider calls.');
  }
  if (expectedCalls-networkCalls>limit) throw new Error('Remaining requests exceed the approved request limit.');
  const output=await open(path,'wx');
  const save=async()=>{
    const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
    for (let offset=0; offset<bytes.length;) {
      const {bytesWritten}=await output.write(bytes,offset,bytes.length-offset,offset);
      if (!bytesWritten) throw new Error('Could not store evidence.');
      offset+=bytesWritten;
    }
    await output.truncate(bytes.length);
  };
  try {
    await save();
    globalThis.fetch=async (input,init)=>{
      const url=new URL(input);
      const deny=()=>{ if (permit) permit.denied=true; throw new Error('The evaluation attempted an unapproved provider operation.'); };
      if (!permit?.remaining || url.origin!==providerOrigin || init?.method!=='POST' || networkCalls>=expectedCalls
        || networkCalls-(report.carried_calls ?? 0)>=limit
        || url.pathname+url.search!==(protocol==='gemini' ? paths[Number(permit.live)] : paths[0])) return deny();
      if (protocol==='mistral') {
        const body=JSON.parse(init.body);
        if (body.model!==model || (body.stream===true)!==permit.live) return deny();
      }
      const slot=permit;
      slot.remaining=0;
      await delay(Math.max(0,4100-(performance.now()-previousStart)),undefined,{signal:init.signal});
      if (permit!==slot || init.signal?.aborted) throw new Error('The approved turn has ended.');
      previousStart=performance.now(); networkCalls++;
      const response=await originalFetch(url,{...init,redirect:'error'});
      upstreamStatus=response.status;
      return response;
    };
    const db=new DatabaseSync(':memory:');
    try {
      for (const file of readdirSync(resolve(root,'migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) db.exec(readFileSync(resolve(root,'migrations',file),'utf8'));
      const token=randomBytes(32).toString('hex'), account='google:tutor-prompt-eval';
      const secretIn=text=>typeof text==='string' && [key,token].some(secret=>text.replace(/\s+/gu,'').includes(secret));
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await hashToken(token),account,'Tutor Eval',Date.now()+3600000);
      db.prepare('INSERT INTO profiles(user_id,level,track,updated_at) VALUES(?,?,?,?)').run(account,'N5','openjlpt','now');
      const env={DB:database(db),ASSETS:{fetch:async request=>{
        const pathname=new URL(request.url).pathname;
        if (pathname==='/course/learning-corpus.json') return new Response(corpus,{headers:{'Content-Type':'application/json'}});
        const level=pathname.match(/^\/course\/teacher-(N[1-5])\.json$/)?.[1];
        return level ? Response.json(catalogs[level]) : new Response(null,{status:404});
      }}};
      const api_connection={protocol:protocol==='mistral' ? 'openai' : protocol,base_url:mode.base,model,api_key:key};
      let index=skipRows, halted=false;
      for (const item of selected.slice(skipCases)) {
        if (halted) break;
        let history=[];
        const japaneseOnly=item.japaneseOnly===true;
        const lesson=item.lesson ?? null, focus=item.focus ?? null;
        const q=qFor(item);
        const shared={lesson,focus,api_connection,...(q ? {task:{id:q.task_id,revision:q.revision}} : {})};
        for (const step of item.steps) {
          const row=turns[index++], chat=item.channel==='chat', id=`tutor-prompt-eval/${item.id}`;
          const prior=()=>db.prepare('SELECT state_json FROM tutor_sessions WHERE user_id=? AND context_key=?').get(account,`quick:/${id}`)?.state_json;
          const before=chat && step.check==='greeting' ? prior() : null;
          const body=chat ? {...shared,channel:'quick',intent:step.action ?? 'message',message:step.message,
            screen:{route:`/${id}`,level:item.level},request_id:randomUUID()}
            : {...shared,level:item.level,command:step.action ?? null,transcript:step.action ? null : step.message,
              history:step.history ?? history,japanese_only:japaneseOnly};
          upstreamStatus=null; const requestsBefore=networkCalls;
          permit={live:!chat,remaining:row.expected_calls,denied:false};
          const abort=new AbortController();
          let response;
          try {
            response=await worker.fetch(new Request(`https://fixture.invalid/api/${chat?'chat':'live/turn'}`,{
              method:'POST',signal:AbortSignal.any([AbortSignal.timeout(35000),abort.signal]),
              headers:{Cookie:`vj_session=${token}`,'Content-Type':'application/json','X-VJBot-Account':account},body:JSON.stringify(body)
            }),env);
            row.status=response.status;
            if (!response.ok) row.error='http_error';
            else if (chat) {
              const data=await response.json();
              if (typeof data.reply!=='string' || !data.reply.trim() || data.reply!==data.response) row.error='invalid_chat_reply';
              else if (secretIn(data.reply)) row.error='secret_in_output';
              else {
                row.reply=data.reply;row.error=null;
                if (step.check==='greeting') {
                  const probe=value=>value ? JSON.parse(value).probe ?? null : null;
                  row.opened_new_probe=probe(prior())!==probe(before);
                }
              }
            } else if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) row.error='invalid_stream';
            else {
              const spoken=parseLive(await response.text());
              row.error=spoken.error ?? (spoken.japanese_only!==japaneseOnly ? 'unexpected_language_mode' : null);
              if (!row.error && secretIn(spoken.reply)) row.error='secret_in_output';
              if (!row.error) {
                Object.assign(row,spoken);
                if (body.transcript) history.push({role:'user',text:body.transcript.slice(0,600)});
                history.push({role:'assistant',text:spoken.reply.slice(0,600)});
                history=history.slice(-12);
              }
            }
          } catch { row.error='invalid_response'; }
          abort.abort();
          if (!response?.bodyUsed) await response?.body?.cancel().catch(()=>{});
          // Live returns SSE headers before it opens the upstream request.
          if (permit.denied || (!row.error && (networkCalls-requestsBefore!==row.expected_calls
            || (row.expected_calls ? upstreamStatus!==200 : upstreamStatus!==null)))) {
            row.error='unexpected_provider_wiring';
          }
          permit=null;
          row.upstream_status=upstreamStatus;
          row.provider_calls=networkCalls-requestsBefore;
          report.network_calls=networkCalls;
          console.log(`${row.id} ${row.status ?? '-'} upstream=${upstreamStatus ?? '-'} ${row.error ?? 'RECORDED'}`);
          await save();
          if (row.error) {halted=true;break;}
        }
      }
    } finally { db.close(); }
  } finally { globalThis.fetch=originalFetch;await output.close(); }
  if (turns.some(row=>row.error)) process.exitCode=1;
}

try { await capture(process.argv.slice(2)); }
catch (error) { console.error(error.message);process.exitCode=1; }
