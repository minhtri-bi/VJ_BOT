import test from 'node:test';
import assert from 'node:assert/strict';
import {VOICE_COMMANDS, voiceInstructions, voiceStreamingInstructions, reversedPrompt} from '../src/prompt.js';

// A learner greeting "こんにちは、ラム先生" was answered "こんにちは、ラム！", and "元気です" with "Em khỏe thật à?".
test('voice and chat prompts treat the teacher name as a vocative and take answers at face value', () => {
  for (const prompt of [voiceInstructions('N5'), reversedPrompt('N5')]) {
    for (const part of ['ラム先生', 'never call the learner by them', 'TAKE ANSWERS AT FACE VALUE', 'Never doubt, challenge or re-ask'])
      assert.ok(prompt.includes(part), part);
  }
  assert.match(voiceInstructions('N5'), /when the learner is actually practising conversation in Japanese/);
});

// The chat chips (start, hint, explain, situation, check, summary) must each have a spoken counterpart.
test('every fixed chat command has a voice command and the voice prompt documents it', () => {
  for (const key of ['start', 'hint', 'explain', 'situation', 'check', 'summary']) assert.ok(VOICE_COMMANDS[key], key);
  const prompt = voiceInstructions('N4');
  for (const [key, text] of Object.entries(VOICE_COMMANDS)) assert.ok(prompt.includes(`- ${key}: ${text}`), key);
});

test('voice prompt keeps the reversed-classroom turn rules, level rules and input boundary', () => {
  const prompt = voiceInstructions('N5');
  for (const part of ['reversed classroom', 'ONE short question', 'Never assume an answer or invent errors', 'microphone is closed while you speak',
    'LEVEL N5', 'INPUT BOUNDARY', 'do not grade pronunciation']) assert.ok(prompt.includes(part), part);
  assert.match(voiceInstructions('N1'), /LEVEL N1/);
  assert.match(voiceInstructions('bad'), /Hiragana/);
});

test('teacher prompts explain the requested form without language leakage or unrelated drills', () => {
  const protectedStream = voiceStreamingInstructions('N5', {japaneseOnly:true, preAnswerTask:true});
  for (const prompt of [reversedPrompt('N5'), voiceInstructions('N5'), protectedStream]) {
    assert.match(prompt, /standard Quốc ngữ.*Do not mix Chinese characters.*or add English grammar labels/);
    assert.match(prompt, /Preserve the Japanese being studied and exact quoted material/);
    assert.match(prompt, /食べる\(たべる\).*Do not append romaji unless the learner explicitly asks/);
    assert.match(prompt, /one short example using that same target\. Do not add an unrelated translation exercise/);
  }
  assert.match(protectedStream, /Use only <ja> tags/);
  assert.match(protectedStream, /PRE-ANSWER CANONICAL TASK:.*Never solve the task/);
});

test('Live and Chat use brief Vietnamese feedback, with a Japanese pattern and a cue for the same sentence', () => {
  for (const prompt of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(prompt, /one or two short sentences of everyday Vietnamese unless Japanese-only practice applies/);
    assert.match(prompt, /Expand only when the learner asks for more detail/);
    assert.match(prompt, /show the relevant grammar pattern in Japanese, then offer one cue to repair the same sentence/);
    assert.match(prompt, /if the learner asks for the full correction or still needs help after trying the cue/);
    assert.match(prompt, /Preserve the learner's intended meaning/);
    assert.match(prompt, /Do not switch topics or add a new conversation question to a correction turn/);
  }
  const live = voiceStreamingInstructions('N5');
  assert.match(live, /An explicit request for a detailed explanation allows up to six short sentences/);
  assert.match(live, /BILINGUAL TURN: Use Vietnamese for explanations and correction reasons/);
  assert.doesNotMatch(live, /reason for a conversation correction stay in simple Japanese|always end the turn by saying the Japanese question/);
});

test('Chat and Voice prompts treat a bare greeting as conversation, not an exercise', () => {
  for (const system of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(system, /A selected lesson supplies a topic, not permission to start a drill/);
    assert.match(system, /A standalone greeting such as "hi", "chào thầy" or こんにちは gets one brief, natural greeting back\. Do not turn it into an exercise/);
    assert.match(system, /Do not greet again, reintroduce yourself or add generic praise before continuing/);
  }
  assert.match(reversedPrompt('N5'), /If a learning request needs a specific target/);
  assert.match(voiceInstructions('N5'), /Other commands start directly with the requested help/);
  assert.match(VOICE_COMMANDS.start, /chào ngắn một lần nếu cần/);
});

test('Chat, native Voice and streaming Voice allow an explanation with no Japanese filler', () => {
  for (const system of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(system, /A teaching reply may be entirely Vietnamese/);
    assert.match(system, /Do not insert Japanese just to make a reply bilingual, add a second acknowledgment, or translate what is already clear/);
    assert.match(system, /Do not ask the same question in both languages/);
    assert.match(system, /End the turn after the repair cue or requested correction/);
  }
  const stream = voiceStreamingInstructions('N5');
  assert.match(stream, /A Vietnamese-only explanation needs only <vi> tags/);
  assert.match(stream, /unless the learner explicitly chooses Japanese only/);
});
