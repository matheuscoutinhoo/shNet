import type { Device } from '../model';
import type { Context } from './registry';

type Kind = 'motd' | 'login' | 'exec';
const MAX_LINES = 40;

function setBanner(d: Device, kind: Kind, text: string) {
  d.iosSystem ??= {};
  d.iosSystem.banners = { ...d.iosSystem.banners, [kind]: text.slice(0, 2048) };
}
/**
 * "banner KIND <d>text<d>". IOS takes the first character as the delimiter; "^C", which is how
 * show running-config prints the Ctrl-C delimiter, counts as one. Without a closing delimiter on the
 * same line, the following lines are banner text until the delimiter appears.
 */
export function startBanner(d: Device, c: Context, kind: Kind, rest: string) {
  const delimiter = rest.startsWith('^C') ? '^C' : rest[0];
  if (!delimiter || /\s/.test(delimiter))
    throw new Error('Banner text must start with a delimiter character.');
  const body = rest.slice(delimiter.length),
    end = body.indexOf(delimiter);
  if (end >= 0) {
    setBanner(d, kind, body.slice(0, end));
    return '';
  }
  // IOS keeps the exact text between the delimiters, line breaks included.
  c.banner = { kind, delimiter, text: [body.slice(0, 512)] };
  return `Enter TEXT message.  End with the character '${delimiter === '^C' ? '^C' : delimiter}'.`;
}
/** One line typed while a multi-line banner is open: text, or the line that closes it. */
export function continueBanner(d: Device, c: Context, line: string) {
  const banner = c.banner!,
    end = line.indexOf(banner.delimiter);
  if (end < 0) {
    if (banner.text.length >= MAX_LINES) {
      delete c.banner;
      throw new Error('Banner exceeds ' + MAX_LINES + ' lines.');
    }
    banner.text.push(line.slice(0, 512));
    return '';
  }
  banner.text.push(line.slice(0, Math.min(end, 512)));
  setBanner(d, banner.kind, banner.text.join('\n'));
  delete c.banner;
  return '';
}
/** Running-config form: the text between ^C delimiters, as IOS prints it. */
export function bannerRunningConfig(d: Device) {
  const banners = d.iosSystem?.banners;
  return (['exec', 'login', 'motd'] as const).flatMap((kind) =>
    banners?.[kind] !== undefined ? ('banner ' + kind + ' ^C' + banners[kind] + '^C').split('\n') : []
  );
}
