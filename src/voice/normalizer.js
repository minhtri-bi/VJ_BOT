const kana = /^[\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+$/u;
const kanaLetter = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const ruby = /([\p{Script=Han}々]+[\p{Script=Hiragana}ー]*)\s*[（(]([\p{Script=Hiragana}\p{Script=Katakana}ー・]+)[）)]/gu;
const romaji = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々][。！？.!?…」』”’"']*(?:[^\S\r\n]*<\/ja>[。！？.!?…」』”’"']*)?)\s*[（(][^\S\r\n]*(?=[a-zāīūēō])([a-zāīūēō'’.,!?\-\p{Zs}\t]+)[）)]/giu;
const japaneseBlank = /([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}々ー])?([\p{Zs}\t]*)＿+([\p{Zs}\t]*)(?=([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}々ー])?)/gu;
const closingQuote = {'「':'」','『':'』','"':'"',"'":"'",'“':'”','‘':'’','（':'）','(':')'};
const citedParticle = /([「『"'“‘（(])(\s*)([はへ])(\s*)([」』"'”’）)])/gu;
const particleSound = particle => particle === 'は' ? 'わ' : 'え';

export function authoredVoiceReading(reading) {
  const value = typeof reading === 'string' ? reading.normalize('NFC').trim() : '';
  return kana.test(value) && kanaLetter.test(value) ? value : '';
}

export function normalizeVoiceText(text, {kanjiMode = 'kanji_native', speakBlanks = false} = {}) {
  const group = kanjiMode === 'kana_first' ? '$2' : '$1';
  const normalized = text.normalize('NFC')
    .replace(/<(?!\/?(?:ja|vi)>)[^>]*>/gi, ' ')
    .replace(/\[([^\]\r\n]+)\]\([^\s)]+\)/g, '$1')
    .replace(/([\d０-９][%％]?[\p{Zs}\t]*[〜～](?=[\p{Zs}\t]*[\d０-９]))|[#*`_〜～]/gu, '$1')
    .replace(/\{([^{}|]+)\|([\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+)\}/gu, group)
    .replace(ruby, group)
    .replace(romaji, (annotation, spoken, reading) => /^[A-Z]{2,}$/.test(reading.trim()) ? annotation : spoken);
  // Speak fullwidth fill-in marks only, not ASCII Markdown or the caption text.
  if (!speakBlanks || !normalized.includes('＿')) return normalized.trim();
  return normalized.replace(japaneseBlank, (mark, before, leftSpace, rightSpace, after) => {
    if (!before && !after) return mark;
    return `${before ? before + '、' : leftSpace}くうらん${after ? '、' : rightSpace}`;
  }).trim();
}

// Keep orthographic particle spellings in longer transcripts; change citations only for synthesis.
export function particleReading(text, {citations = false} = {}) {
  if (citations) text = text.replace(citedParticle, (quote, open, before, particle, after, close) =>
    closingQuote[open] === close ? open + before + particleSound(particle) + after + close : quote);
  return text.replace(/^(\s*[「『"'（(]?)([はへ])([」』"'）)]?[。、.!?！？,\s]*)$/u,
    (_, prefix, particle, suffix) => prefix + particleSound(particle) + suffix);
}
