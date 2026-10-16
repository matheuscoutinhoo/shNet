import { syslogMessageSchema, type SyslogMessage } from '../protocols/syslog-model';
import { concat, text } from './binary';

const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
const utf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function parts(input: SyslogMessage) {
  const m = syslogMessageSchema.parse(input);
  // The model has virtual elapsed time, not a UTC calendar, process ID or
  // message-type identifier. NILVALUE avoids inventing those wire fields.
  return {
    header: text(`<${m.facility * 8 + m.severity}>1 - ${m.hostname} ${m.appName} - - - `),
    message: text(m.text),
    original: m.text,
  };
}
export function syslogMessageSize(input: SyslogMessage) {
  const p = parts(input);
  return p.header.length + bom.length + p.message.length;
}
export function encodeSyslog(input: SyslogMessage) {
  const p = parts(input);
  if (utf8().decode(p.message) !== p.original)
    throw new Error('Syslog: Unicode inválido; captura omitida sem substituir caracteres.');
  return concat(p.header, bom, p.message);
}
/** Native RFC 5424 profile: no UTC timestamp or structured data. Not RFC 3164. */
export function decodeSyslog(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 65507) throw new Error('Syslog: tamanho UDP inválido.');
  const fields: string[] = [];
  let at = 0;
  for (let i = 0; i < 7; i++) {
    let end = bytes.indexOf(32, at);
    if (end < 0 && i === 6) end = bytes.length;
    if (end < 0 || end === at) throw new Error('Syslog: cabeçalho truncado.');
    const token = bytes.subarray(at, end);
    if (token.some((b) => b < 33 || b > 126)) throw new Error('Syslog: cabeçalho ASCII inválido.');
    fields.push(String.fromCharCode(...token));
    at = Math.min(end + 1, bytes.length);
  }
  const priority = /^<(0|[1-9][0-9]{0,2})>1$/.exec(fields[0]);
  if (!priority || Number(priority[1]) > 191) throw new Error('Syslog: PRI ou versão inválida.');
  if (fields[1] !== '-' || fields[6] !== '-')
    throw new Error('Syslog: timestamp UTC/structured-data fora do perfil implementado.');
  if (fields[2].length > 255 || fields[3].length > 48 || fields[4].length > 128 || fields[5].length > 32)
    throw new Error('Syslog: campo do cabeçalho excede o limite.');
  const message = bytes.slice(at),
    unicode = message.length >= 3 && bom.every((b, i) => message[i] === b),
    pri = Number(priority[1]);
  return {
    version: 1,
    priority: pri,
    facility: pri >>> 3,
    severity: pri & 7,
    hostname: fields[2],
    appName: fields[3],
    processId: fields[4],
    messageId: fields[5],
    timestamp: null,
    structuredData: null,
    unicode,
    text: unicode ? utf8().decode(message.subarray(3)) : undefined,
    message,
  };
}
