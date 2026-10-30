import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  looksPortuguese,
  normalizeText,
  parseTranslations,
  parseWords,
  placeholders,
  textKey,
  Translator,
} from '../apps/web/src/i18n/text';
import {
  collectUiStrings,
  loadTranslations,
  patternCatalog,
  PATTERNS_FILE,
  PT_WORDS,
  translationFiles,
} from '../scripts/i18n-strings';

const words = parseWords('limite\nanotações\nequipamentos\nde');
const translator = (entries: Record<string, string>, patterns: string[] = []) =>
  new Translator(
    new Map(Object.entries(entries).map(([pt, en]) => [textKey(pt), en])),
    patterns.map((pt) => [textKey(pt), pt] as [string, string]),
    words
  );

describe('i18n translator', () => {
  it('keys normalized text with a short stable hash', () => {
    expect(textKey('Abrir  terminal\n')).toBe(textKey('Abrir terminal'));
    expect(textKey('Abrir terminal')).toMatch(/^[0-9a-z]{8}$/);
    expect(textKey('Abrir terminal')).not.toBe(textKey('Abrir Terminal'));
    expect(normalizeText('  a \n b  ')).toBe('a b');
    expect(placeholders('{1} de {0}')).toEqual([0, 1]);
  });

  it('translates exact strings and keeps the surrounding whitespace', () => {
    const t = translator({ 'Abrir terminal': 'Open terminal', de: 'of' });
    expect(t.translate('Abrir terminal')).toBe('Open terminal');
    expect(t.translateKeepingSpace(' de ')).toBe(' of ');
    expect(t.translate('Desconhecido')).toBeUndefined();
    expect(t.translate('10.0.0.1')).toBeUndefined();
  });

  it('matches patterns, translating text parts and keeping technical ones', () => {
    const t = translator(
      {
        'Resposta em {0} ms': 'Reply in {0} ms',
        '{0} de {1} equipamentos configurados.': '{0} of {1} devices configured.',
        'Falha AAA: {0}': 'AAA failure: {0}',
        'Senha inválida.': 'Invalid password.',
        'Rota {0} via {1}': 'Route {0} via {1}',
      },
      ['Resposta em {0} ms', '{0} de {1} equipamentos configurados.', 'Falha AAA: {0}', 'Rota {0} via {1}']
    );
    expect(t.translate('Resposta em 24.08 ms')).toBe('Reply in 24.08 ms');
    expect(t.translate('15 de 15 equipamentos configurados.')).toBe('15 of 15 devices configured.');
    expect(t.translate('Falha AAA: Senha inválida.')).toBe('AAA failure: Invalid password.');
    expect(t.translate('Rota 10.0.0.0/8 via Gi0/1')).toBe('Route 10.0.0.0/8 via Gi0/1');
    // A captured part that is untranslated Portuguese rejects the match instead of mixing languages.
    expect(t.translate('Falha AAA: Limite de anotações')).toBeUndefined();
  });

  it('ignores patterns whose literal text is too short to be specific', () => {
    const t = translator({ '{0} de {1}': '{0} of {1}' }, ['{0} de {1}']);
    expect(t.translate('Limite de 100')).toBeUndefined();
  });

  it('detects Portuguese text but not identifiers, paths or acronyms', () => {
    expect(looksPortuguese('Configuração em massa', PT_WORDS)).toBe(true);
    expect(looksPortuguese('Salvar', PT_WORDS)).toBe(true);
    expect(looksPortuguese('show ip route', PT_WORDS)).toBe(false);
    expect(looksPortuguese('dhcp-binding', PT_WORDS)).toBe(false);
    expect(looksPortuguese('/projects/{0}/snapshots', PT_WORDS)).toBe(false);
    expect(looksPortuguese('RADIUS NAS {0}', PT_WORDS)).toBe(false);
  });

  it('parses translation tables, ignoring comments and a byte-order mark', () => {
    const map = parseTranslations('\uFEFF# comment\nabc12345\tOpen\n\nzzz99999\tClose\r\n');
    expect([...map]).toEqual([
      ['abc12345', 'Open'],
      ['zzz99999', 'Close'],
    ]);
  });
});

describe('English translation coverage', () => {
  const strings = collectUiStrings();
  const translations = loadTranslations();

  it('every user-visible Portuguese string has an English translation', () => {
    const missing = strings.filter((s) => !translations.has(s.key));
    expect(
      missing.slice(0, 20).map((s) => s.file + ':' + s.line + ' ' + s.text),
      missing.length + ' untranslated strings; run npx tsx scripts/i18n-strings.ts --missing'
    ).toEqual([]);
  });

  it('translations keep placeholders, have one line each and no stale or duplicate keys', () => {
    const byKey = new Map(strings.map((s) => [s.key, s.text]));
    const seen = new Map<string, string>();
    const problems: string[] = [];
    for (const file of translationFiles())
      for (const line of file.text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('#')) continue;
        const [key, english, extra] = line.split('\t');
        if (extra !== undefined || !english?.trim()) problems.push(file.name + ': malformed line ' + key);
        if (seen.has(key))
          problems.push(file.name + ': duplicate key ' + key + ' (also in ' + seen.get(key) + ')');
        seen.set(key, file.name);
        const source = byKey.get(key);
        if (source === undefined) problems.push(file.name + ': stale key ' + key + ' (run --prune)');
        else if (placeholders(source).join() !== placeholders(english ?? '').join())
          problems.push(file.name + ': placeholders differ for ' + key + ': ' + source + ' → ' + english);
      }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  it('the generated pattern catalog matches the source', () => {
    expect(
      JSON.parse(readFileSync(PATTERNS_FILE, 'utf8')),
      'run npx tsx scripts/i18n-strings.ts --write'
    ).toEqual(patternCatalog(strings));
  });

  it('translates representative interface text', () => {
    const t = new Translator(translations, patternCatalog(strings), PT_WORDS);
    for (const [pt, en] of [
      ['Abrir terminal', /^Open terminal$/i],
      ['Configuração em massa', /^Bulk configuration$/i],
      ['Agrupar por site', /group by site/i],
    ] as const)
      expect(t.translate(pt), pt).toMatch(en);
  });
});
