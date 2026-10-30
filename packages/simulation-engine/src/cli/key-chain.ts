import type { Device } from '../model';
import type { KeyChainKey } from '../protocols/key-chain-model';
import { keyChainTime, keyValid, validateKeyChains } from '../protocols/key-chain';
import { ALL_MODES, type CommandRegistry } from './registry';
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const offset = (d: Device) => {
  const t = d.iosSystem?.timezone;
  return t ? (t.hours * 60 + (t.hours < 0 ? -1 : 1) * t.minutes) * 60000 : 0;
};
function date(value: string, d: Device) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2}) (?:([A-Za-z]{3}) (\d{1,2})|(\d{1,2}) ([A-Za-z]{3})) (\d{4})$/.exec(
    value
  );
  if (!m) throw new Error('Use HH:MM:SS Mon DAY YEAR.');
  const hour = Number(m[1]),
    minute = Number(m[2]),
    second = Number(m[3]),
    month = months.findIndex((s) => s.toLowerCase() === (m[4] ?? m[7]).toLowerCase()),
    day = Number(m[5] ?? m[6]),
    year = Number(m[8]),
    at = Date.UTC(year, month, day, hour, minute, second);
  if (
    month < 0 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    year < 1970 ||
    year > 2200 ||
    day < 1 ||
    new Date(at).getUTCDate() !== day
  )
    throw new Error('Invalid key lifetime date.');
  const utc = at - offset(d);
  if (utc < 0) throw new Error('Key lifetime precedes the virtual epoch.');
  return utc;
}
function format(at: number, d: Device) {
  const t = new Date(at + offset(d)),
    pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} ${months[t.getUTCMonth()]} ${t.getUTCDate()} ${t.getUTCFullYear()}`;
}
function key(d: Device, name: string | undefined, id: number | undefined) {
  const k = d.keyChains?.find((c) => c.name === name)?.keys.find((k) => k.id === id);
  if (!k) throw new Error('Select a key-chain key.');
  return k;
}
export function registerKeyChainCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?key chain ([\w-]{1,32})$/i,
    modes: ['config'],
    run: (m, _e, d, c) => {
      d.keyChains ??= [];
      if (m[1]) {
        if (d.bfdTemplates?.some((t) => t.authentication?.keyChain === m[2]))
          throw new Error('Key-chain is used by a BFD template.');
        d.keyChains = d.keyChains.filter((k) => k.name !== m[2]);
        return;
      }
      if (!d.keyChains.some((k) => k.name === m[2])) d.keyChains.push({ name: m[2], keys: [] });
      c.mode = 'key-chain';
      c.name = m[2];
    },
  });
  r.register({
    pattern: /^(no )?key (\d+)$/i,
    modes: ['key-chain'],
    run: (m, _e, d, c) => {
      const chain = d.keyChains!.find((k) => k.name === c.name)!,
        id = Number(m[2]);
      if (m[1]) {
        chain.keys = chain.keys.filter((k) => k.id !== id);
        return;
      }
      if (!chain.keys.some((k) => k.id === id)) chain.keys.push({ id });
      c.mode = 'key-chain-key';
      c.sequence = id;
    },
  });
  r.register({
    pattern: /^key-string(?: 0)? (.+)$/i,
    modes: ['key-chain-key'],
    run: (m, _e, d, c) => {
      key(d, c.name, c.sequence).keyString = m[1];
    },
  });
  r.register({
    pattern: /^no key-string$/i,
    modes: ['key-chain-key'],
    run: (_m, _e, d, c) => {
      delete key(d, c.name, c.sequence).keyString;
    },
  });
  r.register({
    pattern: /^(no )?(send|accept)-lifetime(?: (.+))?$/i,
    modes: ['key-chain-key'],
    run: (m, _e, d, c) => {
      const k = key(d, c.name, c.sequence),
        field = m[2].toLowerCase() === 'send' ? 'sendLifetime' : 'acceptLifetime';
      if (m[1]) {
        delete k[field];
        return;
      }
      const match = /^(.+? \d{4}) (infinite|duration (\d+)|.+)$/i.exec(m[3] ?? '');
      if (!match) throw new Error('Use START infinite, START duration SECONDS, or START END.');
      const startAt = date(match[1], d);
      let endAt: number | undefined;
      if (match[3]) {
        const seconds = Number(match[3]);
        if (seconds < 1 || seconds > 2147483646) throw new Error('Invalid key lifetime duration.');
        endAt = startAt + seconds * 1000;
      } else if (match[2].toLowerCase() !== 'infinite') endAt = date(match[2], d);
      k[field] = { startAt, ...(endAt !== undefined ? { endAt } : {}) };
      validateKeyChains(d);
    },
  });
  r.register({
    pattern: /^show key chain(?: ([\w-]{1,32}))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) =>
      (d.keyChains ?? [])
        .filter((c) => !m[1] || c.name === m[1])
        .map(
          (c) =>
            `Key-chain ${c.name}\n` +
            c.keys
              .map(
                (k) =>
                  `  key ${k.id}: ${k.keyString ? 'configured' : 'unset'}, send ${keyValid(k, 'send', keyChainTime(d, e.state.clock)) ? 'valid' : 'inactive'}, accept ${keyValid(k, 'accept', keyChainTime(d, e.state.clock)) ? 'valid' : 'inactive'}`
              )
              .join('\n')
        )
        .join('\n') || 'No key-chains configured.',
  });
}
function lifetimes(d: Device, k: KeyChainKey) {
  return (['send', 'accept'] as const).flatMap((kind) => {
    const l = kind === 'send' ? k.sendLifetime : k.acceptLifetime;
    return l
      ? [
          `  ${kind}-lifetime ${format(l.startAt, d)} ${l.endAt === undefined ? 'infinite' : format(l.endAt, d)}`,
        ]
      : [];
  });
}
export function keyChainRunningConfig(d: Device) {
  return (d.keyChains ?? []).flatMap((c) => [
    'key chain ' + c.name,
    ...[...c.keys]
      .sort((a, b) => a.id - b.id)
      .flatMap((k) => [
        ' key ' + k.id,
        ...(k.keyString ? ['  key-string 0 ' + k.keyString] : []),
        ...lifetimes(d, k),
        ' exit',
      ]),
    'exit',
  ]);
}
