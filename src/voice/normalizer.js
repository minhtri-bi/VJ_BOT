const kana = /^[\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+$/u;
const kanaLetter = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const ruby = /([\p{Script=Han}々]+[\p{Script=Hiragana}ー]*)\s*[（(]([\p{Script=Hiragana}\p{Script=Katakana}ー・]+)[）)]/gu;
const romaji = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々][。！？.!?…」』”’"']*(?:[^\S\r\n]*<\/ja>[。！？.!?…」』”’"']*)?)\s*[（(][^\S\r\n]*(?=[a-zāīūēō])([a-zāīūēō'’.,!?\-\p{Zs}\t]+)[）)]/giu;
const closingQuote = {'「':'」','『':'』','"':'"',"'":"'",'“':'”','‘':'’','（':'）','(':')'};
const citedParticle = /([「『"'“‘（(])(\s*)([はへ])(\s*)([」』"'”’）)])/gu;
const particleSound = particle => particle === 'は' ? 'わ' : 'え';

export function authoredVoiceReading(reading) {
  const value = typeof reading === 'string' ? reading.normalize('NFC').trim() : '';
  return kana.test(value) && kanaLetter.test(value) ? value : '';
}

export function normalizeVoiceText(text, {kanjiMode = 'kanji_native'} = {}) {
  const group = kanjiMode === 'kana_first' ? '$2' : '$1';
  return text.normalize('NFC')
    .replace(/<(?!\/?(?:ja|vi)>)[^>]*>/gi, ' ')
    .replace(/\[([^\]\r\n]+)\]\([^\s)]+\)/g, '$1')
    .replace(/[#*`_〜～]/g, '')
    .replace(/\{([^{}|]+)\|([\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+)\}/gu, group)
    .replace(ruby, group)
    .replace(romaji, (annotation, spoken, reading) => /^[A-Z]{2,}$/.test(reading.trim()) ? annotation : spoken)
    .trim();
}

// Keep orthographic particle spellings in longer transcripts; change citations only for synthesis.
export function particleReading(text, {citations = false} = {}) {
  if (citations) text = text.replace(citedParticle, (quote, open, before, particle, after, close) =>
    closingQuote[open] === close ? open + before + particleSound(particle) + after + close : quote);
  return text.replace(/^(\s*[「『"'（(]?)([はへ])([」』"'）)]?[。、.!?！？,\s]*)$/u,
    (_, prefix, particle, suffix) => prefix + particleSound(particle) + suffix);
}
