import { useSyncExternalStore } from 'react';
import { DomTranslator } from './dom';
import { parseTranslations, parseWords, Translator } from './text';

/**
 * Interface language. Portuguese is the source language of the code; English is applied
 * at runtime by translating rendered text (see dom.ts) and, where text does not reach the
 * DOM (terminal output, document titles), through tr().
 */
export type Locale = 'pt' | 'en';
const STORAGE = 'shlab.locale';
let locale: Locale = readStoredLocale();
let translator: Translator | null = null;
let dom: DomTranslator | null = null;
const listeners = new Set<() => void>();
const cache = new Map<string, string>();

function readStoredLocale(): Locale {
  try {
    return localStorage.getItem(STORAGE) === 'en' ? 'en' : 'pt';
  } catch {
    return 'pt';
  }
}

async function loadEnglish() {
  if (translator) return translator;
  const tables = import.meta.glob<string>('./en/*.tsv', { query: '?raw', import: 'default' });
  const [files, patterns, words] = await Promise.all([
    Promise.all(Object.values(tables).map((load) => load())),
    import('./patterns.generated.json').then((m) => m.default as [string, string][]),
    import('./pt-words.txt?raw').then((m) => m.default),
  ]);
  const translations = new Map<string, string>();
  for (const file of files) parseTranslations(file, translations);
  translator = new Translator(translations, patterns, parseWords(words));
  return translator;
}

/** English text for a Portuguese string; the string itself in Portuguese or when unknown. */
export function tr(text: string) {
  if (locale !== 'en' || !translator) return text;
  let translated = cache.get(text);
  if (translated === undefined) {
    translated = translator.translateKeepingSpace(text);
    if (cache.size > 5000) cache.clear();
    cache.set(text, translated);
  }
  return translated;
}

/** Translates multi-line output (terminal, logs) line by line. */
export function trLines(text: string) {
  return locale === 'en' ? text.split('\n').map(tr).join('\n') : text;
}

export function getLocale() {
  return locale;
}

/** BCP 47 tag for dates and numbers in the current language. */
export function formatLocale() {
  return locale === 'en' ? 'en-US' : 'pt-BR';
}

function domTranslator() {
  dom ??= new DomTranslator(tr);
  return dom;
}

/** Keeps a document (e.g. a popped-out window) translated while English is active. */
export function observeDocument(root: Node) {
  if (locale === 'en') domTranslator().observe(root);
  const listener = () => (locale === 'en' ? domTranslator().observe(root) : dom?.unobserve(root));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    dom?.unobserve(root);
  };
}

export async function setLocale(next: Locale) {
  if (next === locale) return;
  if (next === 'en') await loadEnglish();
  locale = next;
  cache.clear();
  try {
    localStorage.setItem(STORAGE, next);
  } catch {
    // Private browsing: the choice lasts for this page only.
  }
  document.documentElement.lang = next === 'en' ? 'en' : 'pt-BR';
  if (next === 'en') domTranslator().observe(document.body);
  else dom?.unobserve(document.body);
  for (const listener of [...listeners]) listener();
}

/** Call before the first render so English users never see Portuguese text flash. */
export async function initI18n() {
  document.documentElement.lang = locale === 'en' ? 'en' : 'pt-BR';
  if (locale !== 'en') return;
  try {
    await loadEnglish();
    domTranslator().observe(document.body);
  } catch {
    locale = 'pt';
    document.documentElement.lang = 'pt-BR';
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Re-renders a component when the language changes (for text produced outside the DOM). */
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}
