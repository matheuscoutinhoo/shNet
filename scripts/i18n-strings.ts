/**
 * Collects user-visible Portuguese strings from the web app and the simulation engine and
 * keeps the English translations in apps/web/src/i18n/en/*.tsv complete.
 *
 *   npx tsx scripts/i18n-strings.ts                      report coverage
 *   npx tsx scripts/i18n-strings.ts --write              regenerate patterns.generated.json
 *   npx tsx scripts/i18n-strings.ts --missing            list untranslated strings (key, text, source)
 *   npx tsx scripts/i18n-strings.ts --batches <dir> <n>  split untranslated strings into n work files
 *   npx tsx scripts/i18n-strings.ts --prune              drop translations whose source text is gone
 *
 * Strings are found with the TypeScript compiler API: JSX text, string literals, template
 * literals and "+" concatenations (as patterns with {0}, {1}... for the non-literal parts).
 */
import ts from 'typescript';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksPortuguese as looksPortugueseWith,
  normalizeText,
  parseTranslations,
  parseWords,
  textKey,
} from '../apps/web/src/i18n/text';

export interface UiString {
  key: string;
  text: string;
  file: string;
  line: number;
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const I18N = join(root, 'apps/web/src/i18n');
export const I18N_ROOTS = ['apps/web/src', 'packages/simulation-engine/src'];
export const PATTERNS_FILE = join(I18N, 'patterns.generated.json');
export const EN_DIR = join(I18N, 'en');
// Tests, the i18n catalogs themselves and fixtures are never shown in the UI.
const SKIP_FILES = /(?:\.test\.|\.d\.ts$|[\\/]i18n[\\/]|[\\/]fixtures?[\\/])/;
export const PT_WORDS = parseWords(readFileSync(join(I18N, 'pt-words.txt'), 'utf8'));
export const looksPortuguese = (text: string) => looksPortugueseWith(text, PT_WORDS);

const IGNORED_ATTRIBUTES = new Set([
  'className',
  'key',
  'id',
  'name',
  'type',
  'role',
  'href',
  'src',
  'value',
  'defaultValue',
  'accept',
  'autoComplete',
  'inputMode',
  'pattern',
  'htmlFor',
  'form',
  'method',
  'target',
  'rel',
  'lang',
  'dir',
]);
const IGNORED_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'split',
  'join',
  'test',
  'match',
  'replace',
  'getItem',
  'setItem',
  'removeItem',
  'querySelector',
  'querySelectorAll',
  'closest',
  'getPropertyValue',
  'addEventListener',
  'removeEventListener',
  'getData',
  'setData',
]);
const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InKeyword,
]);
function ignoredContext(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (
      ts.isImportDeclaration(p) ||
      ts.isExportDeclaration(p) ||
      ts.isLiteralTypeNode(p) ||
      ts.isExternalModuleReference(p)
    )
      return true;
    if (ts.isJsxAttribute(p)) {
      const name = p.name.getText();
      return IGNORED_ATTRIBUTES.has(name) || name.startsWith('data-');
    }
    if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
    if (ts.isPropertyAssignment(p) && p.name === node) return true;
    // Comparisons and switch cases compare identifiers or protocol values, not text.
    if (ts.isBinaryExpression(p) && COMPARISONS.has(p.operatorToken.kind)) return true;
    if (ts.isCaseClause(p) && p.expression === node) return true;
    if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      IGNORED_METHODS.has(p.expression.name.text)
    )
      return true;
    if (ts.isStatement(p) || ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) return false;
  }
  return false;
}
const isText = (e: ts.Node): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
const isConcat = (e: ts.Node): e is ts.BinaryExpression =>
  ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken;
/** A '+' chain containing string literals becomes one pattern with {n} for the other operands. */
function concatenation(node: ts.BinaryExpression): string | undefined {
  const parts: ts.Expression[] = [];
  const walk = (e: ts.Expression) => {
    const inner = ts.isParenthesizedExpression(e) ? e.expression : e;
    if (isConcat(inner)) {
      walk(inner.left);
      walk(inner.right);
    } else parts.push(inner);
  };
  walk(node);
  if (!parts.some(isText)) return;
  let n = 0;
  return parts.map((p) => (isText(p) ? p.text : '{' + n++ + '}')).join('');
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** JSX text keeps HTML entities in the source; the DOM shows the decoded characters. */
function decodeEntities(text: string) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (entity, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity;
    const hex = name[1].toLowerCase() === 'x';
    return String.fromCodePoint(parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}
function template(node: ts.TemplateExpression) {
  let text = node.head.text;
  node.templateSpans.forEach((span, i) => (text += '{' + i + '}' + span.literal.text));
  return text;
}
export function collectFile(path: string, accept = looksPortuguese): UiString[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: UiString[] = [];
  const add = (text: string, node: ts.Node) => {
    const value = normalizeText(text);
    if (accept(value))
      found.push({
        key: textKey(value),
        text: value,
        file: relative(root, path).replace(/\\/g, '/'),
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
  };
  // Operands of a collected concatenation: nested calls and conditionals are still visited.
  const visitOperands = (node: ts.Node): void => {
    if (isText(node)) return;
    if (isConcat(node)) {
      node.forEachChild(visitOperands);
      return;
    }
    visit(node);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) add(decodeEntities(node.text), node);
      return;
    }
    if (isConcat(node)) {
      const parent = ts.isParenthesizedExpression(node.parent) ? node.parent.parent : node.parent;
      const text = concatenation(node);
      if (text !== undefined && !isConcat(parent) && !ignoredContext(node)) {
        add(text, node);
        node.forEachChild(visitOperands);
        return;
      }
    }
    if (ts.isTemplateExpression(node)) {
      if (!ignoredContext(node)) add(template(node), node);
    } else if (isText(node) && !ignoredContext(node)) add(node.text, node);
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    // A "@i18n-skip" marker in the leading comment opts a file out (e.g. official English wording).
    return /\.(?:ts|tsx)$/.test(name) &&
      !SKIP_FILES.test(path) &&
      !readFileSync(path, 'utf8').slice(0, 1500).includes('@i18n-skip')
      ? [path]
      : [];
  });
}
/** Unique strings in source order (first occurrence wins). */
export function collectUiStrings(roots = I18N_ROOTS) {
  const unique = new Map<string, UiString>();
  for (const entry of roots.flatMap((r) => files(resolve(root, r))).flatMap((path) => collectFile(path))) {
    const seen = unique.get(entry.key);
    if (!seen) unique.set(entry.key, entry);
    else if (seen.text !== entry.text)
      throw new Error('i18n key collision: "' + entry.text + '" and "' + seen.text + '"');
  }
  return [...unique.values()];
}
/** Strings with {n} placeholders; the runtime needs their Portuguese form to match them. */
export function patternCatalog(strings = collectUiStrings()) {
  return strings
    .filter((s) => /\{\d+\}/.test(s.text))
    .map((s) => [s.key, s.text] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}
export function translationFiles() {
  return readdirSync(EN_DIR)
    .filter((name) => name.endsWith('.tsv'))
    .sort()
    .map((name) => ({ name, path: join(EN_DIR, name), text: readFileSync(join(EN_DIR, name), 'utf8') }));
}
export function loadTranslations() {
  const all = new Map<string, string>();
  for (const file of translationFiles()) parseTranslations(file.text, all);
  return all;
}

function main(args: string[]) {
  const strings = collectUiStrings();
  const translations = loadTranslations();
  const missing = strings.filter((s) => !translations.has(s.key));
  const tsv = (list: UiString[]) =>
    list.map((s) => s.key + '\t' + s.text + '\t' + s.file + ':' + s.line).join('\n') + '\n';
  if (args[0] === '--write') {
    writeFileSync(PATTERNS_FILE, JSON.stringify(patternCatalog(strings), null, 1) + '\n');
    console.log('Wrote ' + relative(root, PATTERNS_FILE));
  } else if (args[0] === '--missing') process.stdout.write(tsv(missing));
  else if (args[0] === '--batches') {
    const dir = resolve(args[1]),
      count = Math.max(1, Number(args[2] ?? 1));
    mkdirSync(dir, { recursive: true });
    const size = Math.ceil(missing.reduce((n, s) => n + s.text.length, 0) / count);
    let batch = 1,
      current: UiString[] = [],
      chars = 0;
    const flush = () => {
      writeFileSync(join(dir, 'batch-' + String(batch).padStart(2, '0') + '.tsv'), tsv(current));
      current = [];
      chars = 0;
    };
    for (const s of missing) {
      current.push(s);
      chars += s.text.length;
      if (chars >= size && batch < count) {
        flush();
        batch++;
      }
    }
    if (current.length) flush();
    console.log('Wrote ' + batch + ' batches with ' + missing.length + ' strings to ' + dir);
  } else if (args[0] === '--prune') {
    const live = new Set(strings.map((s) => s.key));
    for (const file of translationFiles()) {
      const kept = file.text
        .split(/\r?\n/)
        .filter((line) => !line.trim() || line.startsWith('#') || live.has(line.split('\t')[0]));
      writeFileSync(file.path, kept.join('\n'));
    }
  }
  console.error(
    strings.length -
      missing.length +
      ' of ' +
      strings.length +
      ' strings translated (' +
      patternCatalog(strings).length +
      ' patterns).'
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
