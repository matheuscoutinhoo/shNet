/**
 * Language-neutral helpers shared by the runtime translator and scripts/i18n-strings.ts.
 * Portuguese is the source language: each UI string is identified by a short key derived
 * from its normalized text, so translations never repeat the Portuguese source.
 */

/** Collapses whitespace exactly as the extractor does with JSX text. */
export function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 8-character base-36 key (41 bits of cyrb53) of the normalized text. */
export function textKey(text: string) {
  const value = normalizeText(text);
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(8, '0').slice(-8);
}

/** Placeholder indexes ({0}, {1}...) used by a pattern or its translation. */
export function placeholders(text: string) {
  return [...text.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** Parses "key<TAB>translation" lines; blank lines and lines starting with # are ignored. */
export function parseTranslations(tsv: string, into = new Map<string, string>()) {
  for (const line of tsv.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    into.set(line.slice(0, tab).trim(), line.slice(tab + 1).trimEnd());
  }
  return into;
}

/** Word list file (one lowercase word per line, # comments). */
export function parseWords(text: string) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );
}

const ACCENT = /[À-ÖØ-öø-ÿ]/;
// Portuguese-only endings (without accents): -mente, -ado(s)/-ada(s), -idos/-idas, -cao/-coes.
const SUFFIX = /(?:cao|coes|mente|ados?|adas?|idos|idas)$/;
const ENGLISH_SUFFIX_WORDS = new Set(['tornado', 'avocado', 'desperado']);

/** Whether a UI string is Portuguese text that needs a translation. */
export function looksPortuguese(text: string, words: Set<string>) {
  // URLs and API paths, placeholders included ("/projects/{0}/snapshots").
  if (/^(?:https?:|\/|\.\/|@|--)\S*$/.test(normalizeText(text))) return false;
  const t = normalizeText(text.replace(/\{\d+\}/g, ' '));
  if (t.length < 2 || !/\p{L}{2}/u.test(t)) return false;
  // Identifiers, CSS classes and kebab/snake keys stay as they are.
  if (/^[a-z0-9]+(?:[-_.:/][a-z0-9]+)+$/i.test(t)) return false;
  if (ACCENT.test(t)) return true;
  // In mixed-case text, capitalized tokens are acronyms (NAS, DE, UM...); labels written
  // entirely in capitals ("TEMPO VIRTUAL") are checked by their longer words.
  const capitals = !/\p{Ll}/u.test(t);
  return (t.match(/\p{L}+/gu) ?? [])
    .filter((word) => (capitals ? word.length >= 4 : word.length < 2 || word !== word.toUpperCase()))
    .map((word) => word.toLowerCase())
    .some(
      (word) => words.has(word) || (word.length > 5 && SUFFIX.test(word) && !ENGLISH_SUFFIX_WORDS.has(word))
    );
}

interface Pattern {
  regex: RegExp;
  translation: string;
  specificity: number;
}
// Timestamps, numbers with short units and EVENT_CODES that surround translatable text.
const TECHNICAL = /^(?:\d[\d.:/,+-]*[A-Za-z]{0,3}|[A-Z][A-Z0-9_]+:?|#\d+)$/;

/**
 * Translates whole strings. Exact strings are looked up by key; strings built from
 * concatenations or templates match "patterns" whose {n} parts are captured and, when
 * they are text themselves, translated recursively.
 */
export class Translator {
  private byWord = new Map<string, Pattern[]>();

  constructor(
    private readonly translations: Map<string, string>,
    patterns: [key: string, source: string][],
    private readonly portuguese = new Set<string>()
  ) {
    for (const [key, source] of patterns) {
      const translation = translations.get(key);
      const literal = source.replace(/\{\d+\}/g, ' ');
      const letters = (literal.match(/\p{L}/gu) ?? []).length;
      // Very short literals ("{0} de {1}") would match unrelated sentences.
      if (translation === undefined || letters < 4 || !/\p{L}{3}/u.test(literal)) continue;
      const groups: number[] = [];
      const body = source
        .split(/(\{\d+\})/)
        .map((part) => {
          const m = /^\{(\d+)\}$/.exec(part);
          if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          groups.push(Number(m[1]));
          return '(.+?)';
        })
        .join('');
      const pattern = {
        regex: new RegExp('^' + body + '$', 'u'),
        translation: translation.replace(
          /\{(\d+)\}/g,
          (_, n: string) => '{' + groups.indexOf(Number(n)) + '}'
        ),
        specificity: letters,
      };
      const word = (literal.toLowerCase().match(/\p{L}{2,}/u) ?? [''])[0];
      this.byWord.set(word, [...(this.byWord.get(word) ?? []), pattern]);
    }
    for (const list of this.byWord.values()) list.sort((a, b) => b.specificity - a.specificity);
  }

  get size() {
    return this.translations.size;
  }

  /** The translation of a whole string, or undefined when none applies. */
  translate(text: string, depth = 0): string | undefined {
    const value = normalizeText(text);
    if (!value || !/\p{L}/u.test(value)) return;
    const exact = this.lookup(value);
    if (exact !== undefined) return exact;
    if (depth > 2) return;
    return this.pattern(value, depth) ?? (depth < 2 ? this.segments(value, depth) : undefined);
  }

  private lookup(value: string) {
    const exact = this.translations.get(textKey(value));
    if (exact !== undefined) return exact;
    // Lowercased fragments ("Definir {label.toLowerCase()}") reuse the capitalized source.
    const first = value.charAt(0);
    if (first === first.toUpperCase()) return;
    const capitalized = this.translations.get(textKey(first.toUpperCase() + value.slice(1)));
    if (capitalized === undefined) return;
    // Keep acronyms ("OSPF areas") as they are; lowercase an ordinary first word.
    return /^\p{Lu}\p{Ll}/u.test(capitalized)
      ? capitalized.charAt(0).toLowerCase() + capitalized.slice(1)
      : capitalized;
  }

  private pattern(value: string, depth: number) {
    const candidates = [...new Set(value.toLowerCase().match(/\p{L}{2,}/gu) ?? [])]
      .flatMap((word) => this.byWord.get(word) ?? [])
      .sort((a, b) => b.specificity - a.specificity);
    for (const pattern of candidates) {
      const match = pattern.regex.exec(value);
      if (!match) continue;
      const parts = match.slice(1).map((part) => this.part(part, depth));
      if (parts.some((part) => part === undefined)) continue;
      return pattern.translation.replace(/\{(\d+)\}/g, (_, n: string) => parts[Number(n)] ?? '');
    }
  }

  /**
   * Text composed at runtime around known strings: log lines ("<time> <EVENT> reason"),
   * counters ("Usuários 3"), labels joined with " · " or ": " and several sentences.
   */
  private segments(value: string, depth: number) {
    const words = value.split(' ');
    for (let i = 1; i < words.length && TECHNICAL.test(words[i - 1]); i++) {
      const rest = this.translate(words.slice(i).join(' '), depth + 1);
      if (rest !== undefined) return words.slice(0, i).join(' ') + ' ' + rest;
    }
    for (let j = words.length - 1; j > 0 && TECHNICAL.test(words[j]); j--) {
      const head = this.translate(words.slice(0, j).join(' '), depth + 1);
      if (head !== undefined) return head + ' ' + words.slice(j).join(' ');
    }
    for (const separator of [' · ', ': ', ' — ']) {
      const parts = value.split(separator);
      if (parts.length < 2) continue;
      const translated = parts.map((part) => this.translate(part, depth + 1) ?? this.part(part, 2));
      if (translated.every((part) => part !== undefined) && translated.some((part, i) => part !== parts[i]))
        return translated.join(separator);
    }
    // A known sentence followed by a known (possibly multi-sentence) explanation.
    const sentences = value.split(/(?<=[.!?])\s+(?=\p{Lu})/u);
    for (let i = 1; i < sentences.length; i++) {
      const head = this.translate(sentences.slice(0, i).join(' '), depth + 1);
      const tail = head === undefined ? undefined : this.translate(sentences.slice(i).join(' '), depth + 1);
      if (tail !== undefined) return head + ' ' + tail;
    }
  }

  /** A captured value is kept unless it is Portuguese text without a translation. */
  private part(value: string, depth: number) {
    if (!/\p{L}/u.test(value)) return value;
    const translated = this.translate(value, depth + 1);
    if (translated !== undefined) return translated;
    return looksPortuguese(value, this.portuguese) ? undefined : value;
  }

  /** Translates a string while keeping its leading and trailing whitespace. */
  translateKeepingSpace(text: string) {
    const translated = this.translate(text);
    if (translated === undefined) return text;
    return /^\s*/.exec(text)![0] + translated + /\s*$/.exec(text)![0];
  }
}
