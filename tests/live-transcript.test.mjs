import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function transcript(){
  const node=()=>({children:[],dataset:{},attributes:{},textContent:'',events:{},scrollTop:0,scrollHeight:400,clientHeight:400,
    append(...nodes){for(const n of nodes){this.children.push(n);n.parentNode=this;}},
    insertBefore(n,next){const at=this.children.indexOf(next);if(at<0)this.children.push(n);else this.children.splice(at,0,n);n.parentNode=this;},
    replaceChildren(){this.children=[];},remove(){this.parentNode.children=this.parentNode.children.filter(n=>n!==this);},
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.events[k]=v;}});
  const host=node();
  const context=vm.createContext({document:{createElement:node},
    signedInUser:{user_id:'email:admin',is_admin:true}});
  context.window=context;vm.runInContext(readFileSync('static/live-transcript.js','utf8'),context);
  const api=context.createLiveTranscript(host);api.reset();
  return {api,host,context,
    add(role,text,start,end=start+500,id){api.add({type:role==='user'?'session.input_transcript.delta':'session.output_transcript.delta',delta:text,start_ms:start,end_ms:end,event_id:id});},
    upsert(role,key,text,start,end=start+500){api.upsert({role,key,text,start_ms:start,end_ms:end});}};
}
const text=row=>row.children[1].textContent;
const stamp=row=>row.children[0].children[1].textContent;

test('groups by speaker and session timestamps, preserving exact fragments, repeats and overlap',()=>{
  const b=transcript();
  b.add('assistant','はい',3000,3500,'a');b.add('user','学生',1000,2000,'u');b.add('user','です。',2000,2300,'u2');
  b.add('assistant','、はい。',3500,4000,'b');b.add('assistant','、はい。',3500,4000,'b');
  b.add('user','東京です',5000,6100,'u3');
  assert.deepEqual(b.host.children.map(text),['学生です。','はい、はい。','東京です']);
  assert.deepEqual(b.host.children.map(stamp),['00:01 – 00:02','00:03 – 00:04','00:05 – 00:06']);
});

test('rejects malformed events and keeps untrusted text as plain text',()=>{
  const b=transcript();
  for(const patch of [{start_ms:-1},{end_ms:0},{start_ms:NaN},{end_ms:660001},{delta:7},{delta:''},{type:'other'}])b.api.add({type:'session.input_transcript.delta',delta:'test',start_ms:1,end_ms:2,...patch});
  assert.equal(b.host.children.length,0);
  b.add('user','<img src=x onerror=alert(1)>',0);
  assert.equal(text(b.host.children[0]),'<img src=x onerror=alert(1)>');assert.equal(b.host.children[0].children[1].children.length,0);
});

test('splits sentences and long continuous speech so completed phrases close early',()=>{
  const b=transcript();
  b.add('assistant','こんにちは。',1000,2000);b.add('assistant','「私は学生です。」',2100,4000);b.add('assistant','もう一度',4100,5000);
  b.add('assistant','お願いします',13000,14000);
  assert.deepEqual(b.host.children.map(text),['こんにちは。','「私は学生です。」','もう一度','お願いします']);
  const whitespace=transcript();whitespace.add('user',' ',0);whitespace.add('user','はい',500);
  assert.equal(whitespace.host.children.length,1);
  assert.equal(text(whitespace.host.children[0]),' はい');
});

test('stop and account changes freeze the transcript without mutating captions',()=>{
  const b=transcript();
  b.add('assistant','こんにちは',0);b.api.finish();
  b.add('assistant','discarded',1000);assert.equal(b.host.children.length,1);
  b.api.reset();b.add('user','はい',0);b.api.stop();
  b.add('user','discarded',1000);assert.equal(b.host.children.length,1);assert.equal(text(b.host.children[0]),'はい');
  b.context.signedInUser={user_id:'email:other',is_admin:true};b.api.accountChanged();
  assert.equal(b.host.children.length,0);
  b.add('user','stale',2000);assert.equal(b.host.children.length,0);
});

test('long conversations retain bounded rows with unique identifiers',()=>{
  const b=transcript();for(let i=0;i<305;i++)b.add('user','あ'.repeat(700),i*2000,i*2000+500,'id'+i);
  assert.equal(b.host.children.length,300);b.api.stop();
});

test('upsert replaces revised partials under one segment key',()=>{
  const b=transcript();
  b.upsert('user','seg1','混んで',0,300);
  b.upsert('user','seg1','こんにちは、ラム先生',0,600);
  assert.equal(b.host.children.length,1);assert.equal(text(b.host.children[0]),'こんにちは、ラム先生');
  b.upsert('assistant','seg2','はい',1000);b.upsert('user','seg3','はい。',2000);
  assert.equal(b.host.children.length,3);
  assert.deepEqual(b.host.children.map(text),['こんにちは、ラム先生','はい','はい。']);
});

test('upsert validates like add and never opens a row for empty text',()=>{
  const b=transcript();
  for(const event of [{role:'system',key:'k',text:'x',start_ms:0,end_ms:1},{role:'user',key:'',text:'x',start_ms:0,end_ms:1},
    {role:'user',key:7,text:'x',start_ms:0,end_ms:1},{role:'user',key:'k'.repeat(129),text:'x',start_ms:0,end_ms:1},
    {role:'user',key:'k',text:'x'.repeat(4001),start_ms:0,end_ms:1},{role:'user',key:'k',text:'x',start_ms:-1,end_ms:1},
    {role:'user',key:'k',text:'x',start_ms:0,end_ms:NaN},{role:'user',key:'k',text:'x',start_ms:5,end_ms:4},
    {role:'user',key:'k',text:'x',start_ms:0,end_ms:660001}])b.api.upsert(event);
  assert.equal(b.host.children.length,0);
  b.upsert('user','blank','   ',0);assert.equal(b.host.children.length,0);
  b.upsert('user','seg','もしもし',0);b.upsert('user','seg','',0,900);
  assert.equal(b.host.children.length,1);assert.equal(text(b.host.children[0]),'');
});

test('upsert freezes on stop and account change like add',()=>{
  const b=transcript();
  b.upsert('user','seg','はい',0);b.api.finish();
  b.upsert('user','seg','はいです',0,900);b.upsert('user','new','もう',1000);
  assert.equal(b.host.children.length,1);assert.equal(text(b.host.children[0]),'はい');
  b.api.reset();b.upsert('user','seg','はい',0);b.api.stop();
  b.upsert('user','seg','changed',0,900);assert.equal(b.host.children.length,1);assert.equal(text(b.host.children[0]),'はい');
  b.context.signedInUser={user_id:'email:other',is_admin:true};b.api.accountChanged();
  b.upsert('user','seg','stale',0);assert.equal(b.host.children.length,0);
});

test('the row cap evicts upserted keys so a resent key starts a new row',()=>{
  const b=transcript();for(let i=0;i<305;i++)b.upsert('user','seg'+i,'text'+i,i*2000,i*2000+500);
  assert.equal(b.host.children.length,300);
  b.upsert('user','seg0','resent',300500,300900);
  assert.equal(b.host.children.length,300);
  assert.ok(b.host.children.map(text).includes('resent'));
  assert.ok(!b.host.children.map(text).includes('text5'));
});
