const kana = /^[\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+$/u;
const ruby = /([\p{Script=Han}々]+[\p{Script=Hiragana}ー]*)\s*[（(]([\p{Script=Hiragana}\p{Script=Katakana}ー・]+)[）)]/gu;

export function normalizeVoiceText(text, {reading, kanjiMode = 'kanji_native'} = {}) {
  const annotation = typeof reading === 'string' ? reading.normalize('NFC').trim() : '';
  const source = kanjiMode === 'kana_first' && kana.test(annotation) ? annotation : text.normalize('NFC');
  const group = kanjiMode === 'kana_first' ? '$2' : '$1';
  return source
    .replace(/\{([^{}|]+)\|([\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+)\}/gu, group)
    .replace(ruby, group)
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}。！？])\s*[（(][a-zāīūēō0-9\s'.,!?-]+[）)]/giu, '$1')
    .replace(/<(?!\/?(?:ja|vi)>)[^>]*>/gi, ' ')
    .replace(/\[([^\]\r\n]+)\]\([^\s)]+\)/g, '$1')
    .replace(/[#*`_〜～]/g, '')
    .trim();
}

// These readings apply to cited particles, not to occurrences inside Japanese words.
export function particleReading(text) {
  return text.replace(/^(\s*[「『"'（(]?)([はへ])([」』"'）)]?[。、.!?！？,\s]*)$/u,
    (_, prefix, particle, suffix) => prefix + (particle === 'は' ? 'わ' : 'え') + suffix);
}
