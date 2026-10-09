import { dnsMessageSchema } from '../protocols/dns-model';
import type { DnsMessage } from '../model';
import { concat, ip4, ip6, text, u16, u32 } from './binary';
const types = { A: 1, CNAME: 5, AAAA: 28 };
const name = (value: string) =>
  concat(
    ...value.split('.').map((label) => concat(new Uint8Array([label.length]), text(label))),
    new Uint8Array([0])
  );
export function encodeDns(input: DnsMessage) {
  const m = dnsMessageSchema.parse(input);
  if (m.type === 'response' && m.dnssec)
    throw new Error('DNSSEC do modelo não usa canonicalização RFC para exportação.');
  const response = m.type === 'response',
    answers = response ? m.answers : [],
    rcode = response ? { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3, REFUSED: 5, BADVERS: 0 }[m.code] : 0;
  const flags =
    (response ? 0x8000 : 0) |
    (m.recursionDesired ? 0x100 : 0) |
    (response && m.authoritative ? 0x400 : 0) |
    (response && m.recursionAvailable ? 0x80 : 0) |
    (response && m.truncated ? 0x200 : 0) |
    rcode;
  const question = concat(name(m.question.name), u16(types[m.question.type]), u16(1)),
    records = answers.map((record) => {
      const data =
        record.type === 'A'
          ? ip4(record.value)
          : record.type === 'AAAA'
            ? ip6(record.value)
            : name(record.value);
      return concat(
        name(record.name),
        u16(types[record.type]),
        u16(1),
        u32(record.ttl),
        u16(data.length),
        data
      );
    });
  const edns = m.edns
    ? concat(
        new Uint8Array([0]),
        u16(41),
        u16(m.edns.udpSize),
        u32(
          ((response && m.code === 'BADVERS' ? 1 : 0) << 24) |
            (m.edns.version << 16) |
            (m.edns.dnssecOk ? 32768 : 0)
        ),
        u16(0)
      )
    : new Uint8Array();
  return concat(
    u16(m.transactionId),
    u16(flags),
    u16(1),
    u16(answers.length),
    u16(0),
    u16(m.edns ? 1 : 0),
    question,
    ...records,
    edns
  );
}
