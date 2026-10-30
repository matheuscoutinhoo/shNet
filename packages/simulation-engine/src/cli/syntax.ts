// Literal keywords and parameter positions for the supported IOS subset.
// The registry still owns validation, privileges, capability checks and mutations.
export type Syntax = { words: string[]; modes: string[] };
export const parameter = (word: string) => word.startsWith('<');
export const restParameter = (word: string) => parameter(word) && word.endsWith('...>');

export function expandCommand(input: string, syntax: Syntax[]): string {
  const tokens = input.trim().split(/\s+/);
  const expanded: string[] = [];
  let candidates = syntax;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const at = (s: Syntax) =>
      s.words[index] ?? (restParameter(s.words.at(-1) ?? '') ? s.words.at(-1) : undefined);
    const literals = [...new Set(candidates.map(at).filter((w): w is string => !!w && !parameter(w)))];
    const exact = literals.find((word) => word.toLowerCase() === token.toLowerCase());
    const matches = exact
      ? [exact]
      : literals.filter((word) => word.toLowerCase().startsWith(token.toLowerCase()));
    if (matches.length > 1) throw new Error('Ambiguous command: ' + token + ' (' + matches.join(', ') + ')');
    if (matches.length) {
      expanded.push(matches[0]);
      candidates = candidates.filter((s) => at(s) === matches[0]);
    } else {
      candidates = candidates.filter((s) => parameter(at(s) ?? ''));
      expanded.push(token);
    }
    if (!candidates.length) throw new Error('Invalid input detected at: ' + token);
  }
  if (
    !candidates.some(
      (s) =>
        s.words.length === tokens.length ||
        (restParameter(s.words.at(-1) ?? '') && tokens.length >= s.words.length)
    )
  )
    throw new Error('Incomplete command.');
  return expanded.join(' ');
}

export function nextKeywords(input: string, syntax: Syntax[]): string[] {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let candidates = syntax;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index].toLowerCase();
    const literal = [
      ...new Set(
        candidates.flatMap((s) => {
          const word = s.words[index];
          return word && !parameter(word) && word.toLowerCase().startsWith(token) ? [word] : [];
        })
      ),
    ];
    const exact = literal.find((word) => word.toLowerCase() === token);
    const selected = exact ? [exact] : literal;
    if (selected.length > 1) throw new Error('Ambiguous command: ' + tokens[index]);
    candidates = candidates.filter((s) => {
      const word = s.words[index] ?? (restParameter(s.words.at(-1) ?? '') ? s.words.at(-1) : undefined);
      return word && (selected.length ? word === selected[0] : parameter(word));
    });
  }
  return [
    ...new Set(
      candidates.map(
        (s) => s.words[tokens.length] ?? (restParameter(s.words.at(-1) ?? '') ? s.words.at(-1)! : '<cr>')
      )
    ),
  ].sort();
}
