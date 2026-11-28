import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {casePacks,selectCases} from './cases.mjs';
import {checkoutIdentity, sha256} from './identity.mjs';

const controls = [
  {id:'valid-greeting', check:'greeting', expected:true, row:{channel:'chat',status:200,reply:'Chào em!'}},
  {id:'unexpected-drill', check:'greeting', expected:false, row:{channel:'chat',status:200,reply:'Chào em! Em thử điền vào chỗ trống: わたしは＿＿＿です。'}},
  {id:'missing-greeting', check:'greeting', expected:false,row:{channel:'chat',status:200,reply:'Hôm nay trời đẹp.'}},
  {id:'double-greeting', check:'greeting', expected:false,row:{channel:'chat',status:200,reply:'Chào em! Chào mừng em tới buổi học.'}},
  {id:'unexpected-welcome', check:'no-welcome', expected:false,row:{channel:'chat',status:200,reply:'Chào em, thầy rất vui! Em dùng mẫu câu này khi nào?'}},
  {id:'unexpected-japanese-welcome', check:'no-welcome', expected:false,row:{channel:'live',status:200,reply:'こんばんは！',segments:[{index:0,lang:'ja',boundary:'start',text:'こんばんは！'}]}},
  {id:'quoted-greeting', check:'no-welcome', expected:true,row:{channel:'chat',status:200,reply:'Cụm 「こんにちは」 là lời chào ban ngày.'}},
  {id:'vietnamese-only-live', check:'vietnamese-only', expected:true,row:{channel:'live',status:200,reply:'Trong ngữ cảnh này ai nói cũng đã rõ.',segments:[{index:0,lang:'vi',boundary:'start',text:'Trong ngữ cảnh này ai nói cũng đã rõ.'}]}},
  {id:'broken-live-order', expected:false,row:{channel:'live',status:200,reply:'Em thử lại nhé.',segments:[{index:1,lang:'vi',boundary:'start',text:'Em thử lại nhé.'}]}},
  {id:'disclosed-answer', check:'withhold-topic-particle', expected:false,row:{channel:'chat',status:200,reply:'Điền 「は」 nhé.'}}
];

const controlCases=()=>controls.map(({id,check,expected,row})=>({
  description:id, vars:{candidate:JSON.stringify(row),check:check ?? ''}, metadata:{expected}
}));
const sha=/^[0-9a-f]{64}$/;
const digest=value=>sha256(JSON.stringify(value));

function verified(report, items, expected, revision) {
  if (!report || !sha.test(report.revision) || report.revision!==revision
    || !['gemini','mistral'].includes(report.protocol) || !report.model || !sha.test(report.ground_digest)
    || !sha.test(report.transport_digest) || report.case_digest!==digest(items)
    || !Array.isArray(report.turns) || report.planned!==expected.length) throw new Error('Recording identity does not match the chosen cases and revision.');
  const records=new Map(report.turns.map(row=>[row.id,row]));
  if (records.size!==expected.length || report.turns.length!==expected.length) throw new Error('Incomplete, duplicate, or unexpected recording coverage.');
  let calls=0;
  for (const {id,item} of expected) {
    const row=records.get(id), expectedCalls=Number(item.id!=='live-pre-answer');
    if (row?.channel!==item.channel || row.expected_calls!==expectedCalls || row.provider_calls!==expectedCalls
      || row.upstream_status!==(expectedCalls ? 200 : null) || row.status!==200 || row.error) {
      throw new Error(`Transport or call-plan failure: ${id}. Inspect the retained recording.`);
    }
    calls+=expectedCalls;
  }
  if (report.expected_calls!==calls || report.network_calls!==calls) throw new Error('Recording call counts do not match the case plan.');
  return records;
}

export default async function testCases() {
  const base=process.env.VJBOT_TUTOR_EVAL_BASELINE, next=process.env.VJBOT_TUTOR_EVAL_RECORDING;
  if (!base && !next) return controlCases();
  const dirs=[process.env.VJBOT_TUTOR_EVAL_BASELINE_DIR,process.env.VJBOT_TUTOR_EVAL_CANDIDATE_DIR];
  if (!base || !next || !dirs.every(Boolean)) throw new Error('Replay needs both recordings and their matching checkouts.');
  const [a,b]=await Promise.all([base,next].map(async file=>JSON.parse(await readFile(file,'utf8'))));
  const [baseIdentity,nextIdentity]=dirs.map(checkoutIdentity);
  if (!casePacks.includes(a?.pack) || a.revision===b?.revision
    || baseIdentity.runtime_digest!==nextIdentity.runtime_digest
    || a.runtime_digest!==baseIdentity.runtime_digest || b?.runtime_digest!==nextIdentity.runtime_digest
    || !['pack','protocol','model','ground_digest','transport_digest'].every(field=>a[field]===b?.[field])) {
    throw new Error('The pair does not isolate a prompt change.');
  }
  const items=await selectCases(a.pack);
  const expected=items.flatMap(item=>item.steps.map(step=>({id:`${item.channel}/${item.id}/${step.id}`,item,step})));
  const candidates=[
    ['baseline',a,verified(a,items,expected,baseIdentity.revision)],
    ['candidate',b,verified(b,items,expected,nextIdentity.revision)]
  ];
  return candidates.flatMap(([variant,report,rows])=>expected.map(({id,item,step})=>({
    description:`${variant}:${id}`, vars:{candidate:JSON.stringify(rows.get(id)),check:step.check ?? ''},
    metadata:{variant,case_id:id,revision:report.revision,model:report.model,pack:report.pack,rubric:[...(item.rubric ?? []),step.rubric]}
  })));
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=JSON.parse(await readFile(process.argv[2],'utf8')).results;
  const verdicts=new Map(result.results.map(row=>[row.testCase.description,row.success]));
  if (result.stats.errors!==0 || result.results.length!==controls.length || verdicts.size!==controls.length
    || !controls.every(row=>verdicts.get(row.id)===row.expected)) throw new Error('At least one offline control did not match its expected verdict.');
  console.log(`All ${controls.length} offline controls matched their expected verdicts.`);
}
