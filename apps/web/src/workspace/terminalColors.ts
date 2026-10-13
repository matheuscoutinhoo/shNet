const reset = '\x1b[0m';
const colors = {
  prompt: '\x1b[38;2;89;231;205m',
  command: '\x1b[38;2;173;241;220m',
  address: '\x1b[38;2;146;236;224m',
  number: '\x1b[38;2;201;184;241m',
  warning: '\x1b[38;2;242;204;139m',
  error: '\x1b[38;2;255;157;171m',
} as const;

export function coloredTerminalInput(prompt: string, line = ''): string {
  return colors.prompt + prompt + reset + ' ' + colors.command + line + reset;
}

export function coloredTerminalCommand(line: string): string {
  return colors.command + line + reset;
}

/** Presentation only: CLI responses and command history retain their original text. */
export function coloredTerminalOutput(text: string): string {
  // Preserve any explicit formatting provided by a command.
  if (text.includes('\x1b')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*%|\b(error|failed|timeout|unreachable|refused|reset|erro|falha|inválid[oa])\b/i.test(line))
        return colors.error + line + reset;
      if (/\b(não configurad[oa]|sem enlace ativo|pending|pendente)\b/i.test(line))
        return colors.warning + line + reset;
      const base = /^Reply from\b/i.test(line) ? colors.prompt : reset;
      const highlighted = line.replace(
        /\b(?:[\da-f]{2}:){5}[\da-f]{2}\b|\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b|\b[\da-f]{1,4}(?::[\da-f]{0,4}){2,}(?:\/\d{1,3})?|\b\d+(?:\.\d+)?(?:ms|Mbps|Gbps|%)?\b/gi,
        (value) =>
          (value.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}/.test(value) ? colors.address : colors.number) +
          value +
          base
      );
      return base + highlighted + reset;
    })
    .join('\n');
}
