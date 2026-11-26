import test from 'node:test';
import assert from 'node:assert/strict';
import {VOICE_COMMANDS, voiceInstructions, reversedPrompt} from '../src/prompt.js';

// A learner greeting "こんにちは、ラム先生" was answered "こんにちは、ラム！", and "元気です" with "Em khỏe thật à?".
test('voice and chat prompts treat the teacher name as a vocative and take answers at face value', () => {
  for (const prompt of [voiceInstructions('N5'), reversedPrompt('N5')]) {
    for (const part of ['ラム先生', 'never call the learner by them', 'TAKE ANSWERS AT FACE VALUE', 'Never doubt, challenge or re-ask'])
      assert.ok(prompt.includes(part), part);
  }
  assert.match(voiceInstructions('N5'), /Conversation itself is Japanese practice/);
});

// The chat chips (start, hint, explain, situation, check, summary) must each have a spoken counterpart.
test('every fixed chat command has a voice command and the voice prompt documents it', () => {
  for (const key of ['start', 'hint', 'explain', 'situation', 'check', 'summary']) assert.ok(VOICE_COMMANDS[key], key);
  const prompt = voiceInstructions('N4');
  for (const [key, text] of Object.entries(VOICE_COMMANDS)) assert.ok(prompt.includes(`- ${key}: ${text}`), key);
});

test('voice prompt keeps the reversed-classroom turn rules, level rules and input boundary', () => {
  const prompt = voiceInstructions('N5');
  for (const part of ['reversed classroom', 'ONE short question', 'at most two errors', 'microphone is closed while you speak',
    'LEVEL N5', 'INPUT BOUNDARY', 'do not grade pronunciation']) assert.ok(prompt.includes(part), part);
  assert.match(voiceInstructions('N1'), /LEVEL N1/);
  assert.match(voiceInstructions('bad'), /Hiragana/);
});
