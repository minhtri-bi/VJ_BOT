import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script=readFileSync('static/voice/voice-player.js','utf8');
const vi={type:'segment',index:0,lang:'vi',boundary:'start',speed:1,audioBase64:'SUQzBA==',mimeType:'audio/mpeg'};
const ja={...vi,index:1,lang:'ja',boundary:'sentence',speed:0.9};
const done={type:'done',count:2};
function response(...rows) {
  const data=rows.map(row=>JSON.stringify(row)+'\n').join('');
  const parts=data.match(/.{1,13}|\n/gu);
  return new Response(new ReadableStream({start(controller){for (const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close();}}),
    {headers:{'Content-Type':'application/x-ndjson'}});
}
function browser(fetch) {
  const configuration={version:2,mode:'single',admin_override:false};
  const history=[], slots=new Map();
  const context=vm.createContext({TextDecoder,AbortController,Response,
    apiFetch:async (_path,options)=>{history.push(['request',JSON.parse(options.body)]);return fetch(options);},
    speechStatus:message=>history.push(['status',message]), mascotMgr:{setState(){}},
    window:{addEventListener(){},VJVoiceRouting:{stored:()=>configuration,identity:()=> 'account-routing-revision',prepared:async value=>value},
      VJVoiceStitcher:{create:()=>({append:async part=>{history.push(['audio',part.lang]);},finish:async()=>{},stop(){}})},
      VJVoiceCache:{key:async (identity,text,ref)=>JSON.stringify([identity,text,ref]),get:async key=>slots.get(key),
        put:async (key,parts,persist)=>{history.push(['cache',persist]);slots.set(key,parts);},clearMemory:()=>slots.clear()}},
    taskReference:async task=>({id:task.id,revision:task.revision})});
  context.stopSpeech=()=>context.window.VJVoice.stop();
  vm.runInContext(script,context);
  return {voice:context.window.VJVoice,history};
}

test('fragmented NDJSON plays in order, even on replay, without a second API call or a private disk entry',async()=>{
  const {voice,history}=browser(()=>response(vi,ja,done));
  const options={lesson:{id:'lesson',level:'N5'},focus:{kind:'question',index:0},task:{id:'test',revision:'current'},privateAudio:true};
  await voice.speak('Xin chào. こんにちは。',options);
  await voice.speak('Xin chào. こんにちは。',options);
  assert.equal(history.filter(([event])=>event==='request').length,1);
  assert.deepEqual(history.filter(([event])=>event==='audio').map(([,lang])=>lang),['vi','ja','vi','ja']);
  assert.deepEqual(history.find(([event])=>event==='request')[1].task,options.task);
  assert.deepEqual(history.filter(([event])=>event==='cache'),[['cache',false]]);
});

test('partial streams play only available segments, signal failure and do not poison replay',async()=>{
  let count=0;
  const {voice,history}=browser(()=>++count===1?response(vi):response(vi,ja,done));
  await voice.speak('Xin chào. こんにちは。');
  assert.equal(history.some(([event,message])=>event==='status' && message.includes('chưa tải xong')),true);
  assert.equal(history.some(([event])=>event==='cache'),false);
  await voice.speak('Xin chào. こんにちは。');
  assert.equal(count,2);
  assert.deepEqual(history.filter(([event])=>event==='audio').map(([,lang])=>lang),['vi','vi','ja']);
});
