// Invisible, bidirectional and look-alike characters, made visible. Offsets are UTF-16 code-unit offsets into the
// original string (what String.prototype.slice uses), never into an escaped or HTML form.

const BIDI = /[؜‎‏‪-‮⁦-⁩]+/g;
const TAGS = /[\u{E0000}-\u{E007F}]+/gu;
// Zero-width and other format/filler characters. U+200D (ZWJ) is handled separately: emoji sequences use it legitimately.
const INVISIBLE = /[­͏ᅟᅠ឴឵᠋-᠏​‌⁠-⁤⁪-⁯ㅤ﻿ﾠ]+/g;
const ZWJ = /‍/g;

// Latin word letters mixed with Cyrillic or Greek letters inside one word.
const WORD = /[\p{L}\p{N}]+/gu;
const NON_LATIN_LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const LATIN = /\p{Script=Latin}/u;

const hex = (cp) => `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ﻿ﾠ\u{E0000}-\u{E007F}]/gu;

/** The string with every invisible or control character replaced by [U+XXXX]. */
export function visible(s) {
  return String(s).replace(CONTROLS, (c) => hex(c.codePointAt(0)));
}

// Skeleton for look-alike comparison of tool names: case, separators, accents and a few common confusables folded.
const CONFUSABLE = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ɡ: 'g', ο: 'o', α: 'a', ε: 'e', ν: 'v', ι: 'i', κ: 'k', ρ: 'p', τ: 't', υ: 'u', χ: 'x' };
export function skeleton(name) {
  return String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\u0000-\u007F]/g, (c) => CONFUSABLE[c] || c).replace(/[-_.\s]/g, '');
}

/** Unicode findings for one string: [{ ruleId, start, end, detail }]. */
export function unicodeHits(text) {
  const hits = [];
  for (const m of text.matchAll(BIDI)) hits.push({ ruleId: 'MT-UC-001', start: m.index, end: m.index + m[0].length, detail: `bidirectional control characters ${visible(m[0])} can reorder how the text is displayed` });
  for (const m of text.matchAll(TAGS)) {
    const decoded = [...m[0]].map((c) => { const cp = c.codePointAt(0) - 0xE0000; return cp >= 0x20 && cp < 0x7F ? String.fromCharCode(cp) : ''; }).join('');
    hits.push({ ruleId: 'MT-UC-003', start: m.index, end: m.index + m[0].length, detail: `${[...m[0]].length} invisible tag character(s) ${visible(m[0]).slice(0, 80)}${decoded ? ` spell: "${decoded.slice(0, 120)}"` : ''}` });
  }
  for (const m of text.matchAll(INVISIBLE)) hits.push({ ruleId: 'MT-UC-002', start: m.index, end: m.index + m[0].length, detail: `invisible characters ${visible(m[0]).slice(0, 80)}` });
  for (const m of text.matchAll(ZWJ)) {
    const before = text[m.index - 1] || '';
    const after = text[m.index + 1] || '';
    if (/[\u0000-\u007F]/.test(before) && /[\u0000-\u007F]/.test(after)) hits.push({ ruleId: 'MT-UC-002', start: m.index, end: m.index + 1, detail: `zero-width joiner ${hex(0x200D)} between ASCII characters` });
  }
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (LATIN.test(w) && NON_LATIN_LOOKALIKE.test(w)) {
      const odd = [...w].filter((c) => NON_LATIN_LOOKALIKE.test(c)).map((c) => hex(c.codePointAt(0))).slice(0, 5).join(' ');
      hits.push({ ruleId: 'MT-UC-004', start: m.index, end: m.index + w.length, detail: `word "${visible(w)}" mixes Latin with look-alike letters ${odd}` });
    }
  }
  return hits;
}
