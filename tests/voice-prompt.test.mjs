import test from 'node:test';
import assert from 'node:assert/strict';
import {VOICE_COMMANDS, voiceInstructions, voiceStreamingInstructions, reversedPrompt} from '../src/prompt.js';

// A learner greeting "こんにちは、ラム先生" was answered "こんにちは、ラム！", and "元気です" with "Em khỏe thật à?".
test('voice and chat prompts treat the teacher name as a vocative and take answers at face value', () => {
  for (const prompt of [voiceInstructions('N5'), reversedPrompt('N5')]) {
    assert.match(prompt, /ラム先生.*address you, not the learner/);
    assert.match(prompt, /Do not assume the learner's name/);
    assert.match(prompt, /without challenging their account or re-asking an answered question/);
  }
});

// The chat chips (start, hint, explain, situation, check, summary) must each have a spoken counterpart.
test('every fixed chat command has a voice command and the voice prompt documents it', () => {
  for (const key of ['start', 'hint', 'explain', 'situation', 'check', 'summary']) assert.ok(VOICE_COMMANDS[key], key);
  const prompt = voiceInstructions('N4');
  for (const [key, text] of Object.entries(VOICE_COMMANDS)) assert.ok(prompt.includes(`- ${key}: ${text}`), key);
});

test('voice prompt keeps the reversed-classroom turn rules, level rules and input boundary', () => {
  const prompt = voiceInstructions('N5');
  for (const part of ['one concrete situation or question at a time and wait', 'microphone is closed while you speak',
    'LEVEL N5', 'INPUT BOUNDARY', 'do not grade pronunciation']) assert.ok(prompt.includes(part), part);
  assert.match(voiceInstructions('N1'), /LEVEL N1/);
  assert.match(voiceInstructions('bad'), /Hiragana/);
});

test('teacher prompts explain the requested form without language leakage or unrelated drills', () => {
  const protectedStream = voiceStreamingInstructions('N5', {japaneseOnly:true, preAnswerTask:true});
  for (const prompt of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(prompt, /standard Quốc ngữ.*Do not mix Chinese characters.*or add English grammar labels/);
    assert.match(prompt, /Preserve the Japanese being studied and exact quoted material/);
    assert.match(prompt, /食べる\(たべる\).*Do not append romaji unless the learner explicitly asks/);
    assert.match(prompt, /Give one brief example only if it adds understanding/);
  }
  assert.match(protectedStream, /Use only <ja> tags/);
  assert.match(protectedStream, /PRE-ANSWER CANONICAL TASK:.*Never solve the task/);
  assert.doesNotMatch(protectedStream, /Explain in everyday Vietnamese by default|Examples of focused teaching/);
});

test('Live and Chat use brief Vietnamese feedback, with a Japanese pattern and a cue for the same sentence', () => {
  for (const prompt of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(prompt, /Answer directly in one or two short sentences/);
    assert.match(prompt, /Expand only when asked; stay on the same point/);
    assert.match(prompt, /Briefly confirm a valid answer with a specific reason/);
    assert.match(prompt, /For a genuine error outside a protected exercise, explain one useful change/);
    assert.match(prompt, /give the relevant Japanese grammar pattern, and help repair the same sentence/);
    assert.match(prompt, /full corrected sentence only when asked or after they remain stuck/);
    assert.match(prompt, /Keep the original meaning, word choice, valid particles, and level of politeness/);
    assert.match(prompt, /Stop after the cue or correction/);
  }
  const live = voiceStreamingInstructions('N5');
  assert.match(live, /An explicit request for a detailed explanation allows up to six short sentences/);
  assert.match(live, /Explain in everyday Vietnamese by default/);
  assert.doesNotMatch(live, /reason for a conversation correction stay in simple Japanese|always end the turn by saying the Japanese question/);
});

test('Chat and Voice prompts treat a bare greeting as conversation, not an exercise', () => {
  for (const system of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(system, /The selected lesson supplies context, not permission to quiz/);
    assert.match(system, /exactly one short salutation in the chosen language only when the entire request is a recognizable greeting/);
    assert.match(system, /Do not open or replace a probe\. Outside a bare greeting or an explicit opening, omit greetings and stock praise/);
  }
  assert.match(reversedPrompt('N5'), /If a learning request needs a specific target/);
  assert.match(voiceInstructions('N5'), /Other commands start directly with the requested help/);
  assert.match(VOICE_COMMANDS.start, /chào ngắn một lần nếu cần/);
});

test('Chat, native Voice and streaming Voice allow an explanation with no Japanese filler', () => {
  for (const system of [reversedPrompt('N5'), voiceInstructions('N5'), voiceStreamingInstructions('N5')]) {
    assert.match(system, /Explain in everyday Vietnamese by default/);
    assert.match(system, /Use Japanese only for the material being taught or actual Japanese practice/);
    assert.match(system, /Do not say a question or acknowledgment in both languages/);
    assert.match(system, /Stop after the cue or correction/);
  }
  const stream = voiceStreamingInstructions('N5');
  assert.match(stream, /A Vietnamese-only explanation needs only <vi> tags/);
  assert.match(stream, /With a clear Japanese-only preference, use simple Japanese/);
});

test('streaming follows the single validated command and asks back for an uncertain transcript', () => {
  const system = voiceStreamingInstructions('N5');
  assert.doesNotMatch(system, /COMMANDS YOU WILL RECEIVE/);
  assert.match(system, /other commands go straight to the requested help/);
  assert.match(system, /If unclear, ask them to repeat the unclear part/);
  assert.match(system, /A short assent to an existing scenario begins it immediately\. Reply as the partner in Japanese/);
  assert.match(system, /An exact solution to other exercises requires a real attempt or explicit solution request/);
  assert.match(system, /In 〜てます versus 〜ています, the difference is い, not a particle/);
  assert.match(system, /an unrevealed answer, a hint is a clue or blank frame, never the answer even after an attempt/);
});

test('the explicit teach-back action is distinct from a typed explanation request', () => {
  assert.match(reversedPrompt('N5','explain'), /PRACTICE ACTION: The learner will explain the pattern\. Ask one question about when or why/);
  assert.doesNotMatch(reversedPrompt('N5'), /^PRACTICE ACTION:/m);
  assert.match(VOICE_COMMANDS.explain,/để học viên tự giải thích\. Không chào lại, giảng hộ hoặc bắt đặt câu/);
});
