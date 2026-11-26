import {particleReading} from './normalizer.js';

export const MAX_SEGMENTS = 16;
const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]/u;
const letter = /\p{L}/u;
const sentenceEnd = /[。！？.!?…][」』”’"')）]*$/u;
const trailingPrefix = /([\s]*[「『“‘（(]+[\s]*)$/u;
const leadingNumber = /(?:^|\s)([0-9０-９]+(?:[.,][0-9０-９]+)?\s*)$/u;
const latinWord = /[\p{Script=Latin}][\p{Script=Latin}\p{M}0-9-]*|./gsu;
const acronym = /^[A-ZＡ-Ｚ][A-ZＡ-Ｚ0-9０-９-]*$/u;
const numeral = /^[\d０-９][\d０-９.,，、\s]*[。！？!?]?$/u;
const clauseEnd = /[\r\n。！？.!?…]/u;

export function segmentVoiceText(text, mode = 'bilingual', {hint} = {}) {
  const segments = [];
  let nextBoundary = 'start';
  const add = (lang, raw, labelled = false) => {
    const value = raw.trim();
    if ((!letter.test(value) && !(labelled && numeral.test(value))) || (mode === 'ja' && lang !== 'ja')) return;
    const previous = segments.at(-1);
    if (previous?.lang === lang && nextBoundary !== 'arrow') {
      previous.text += ' ' + value;
    } else {
      segments.push({lang, text:value, boundary:nextBoundary === 'arrow' || !previous ? nextBoundary
        : sentenceEnd.test(previous.text) ? 'sentence' : 'inline'});
    }
    nextBoundary = 'inline';
  };
  function plain(value, explicit) {
    if (explicit) return add(explicit, value, true);
    const trimmed = hint ? value.trim() : '';
    if (hint && numeral.test(trimmed)) return add(hint, trimmed, true);
    let lang, pending = '';
    const attachAcronyms = mode === 'ja' || hint === 'ja';
    const tokens = attachAcronyms ? value.match(latinWord) ?? [] : value;
    const following = attachAcronyms ? new Map() : null;
    if (following) {
      let next = null;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        if (acronym.test(token)) {
          if (next) following.set(i, next);
        } else if (japanese.test(token)) next = 'ja';
        else if (letter.test(token)) next = 'vi';
        else if (clauseEnd.test(token)) next = null;
      }
    }
    let index = 0, preceding = null;
    for (const token of tokens) {
      const isJapanese = japanese.test(token);
      const next = following?.get(index);
      // Prefer the following text's language for a neutral abbreviation in hinted speech.
      // A comma or colon alone is not a language switch.
      const attached = following && acronym.test(token) && (hint === 'ja'
        ? (next ?? preceding ?? hint) === 'ja'
        : next === 'ja' || preceding === 'ja');
      const kind = isJapanese || attached ? 'ja' : letter.test(token) ? 'vi' : null;
      if (following) {
        index++;
        if (isJapanese) preceding = 'ja';
        else if (kind === 'vi') preceding = 'vi';
        else if (clauseEnd.test(token)) preceding = null;
      }
      if (kind && lang && kind !== lang) {
        const prefix = pending.match(trailingPrefix)?.[1] ?? (kind === 'ja' ? pending.match(leadingNumber)?.[1] : '') ?? '';
        add(lang, prefix ? pending.slice(0, -prefix.length) : pending);
        pending = prefix;
      }
      if (kind) lang = kind;
      pending += token;
    }
    if (lang) add(lang, pending);
  }
  for (const part of text.split(/(<(?:ja|vi)>[\s\S]*?<\/(?:ja|vi)>|→)/gi)) {
    if (part === '→') {nextBoundary = segments.length ? 'arrow' : 'start'; continue;}
    const marked = /^<(ja|vi)>([\s\S]*?)<\/\1>$/i.exec(part);
    const value = marked?.[2] ?? part.replace(/<\/?(?:ja|vi)>/gi, ' ');
    const clauses = value.split('→');
    for (const [index, clause] of clauses.entries()) {
      if (index && segments.length) nextBoundary = 'arrow';
      plain(clause, marked?.[1].toLowerCase());
    }
    if (segments.length > MAX_SEGMENTS) return null;
  }
  return segments.map(segment => segment.lang === 'ja' ? {...segment,text:particleReading(segment.text)} : segment);
}
