import type { AclRule } from '../model';
import { ipNumber, ipString, mask, parsePrefix, subnet } from '../protocols/ipv4';
import type { CommandRegistry } from './registry';

const services: Record<string, number> = {
  www: 80,
  http: 80,
  https: 443,
  domain: 53,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  ftp: 21,
  ntp: 123,
  snmp: 161,
  bootps: 67,
  bootpc: 68,
};
function address(tokens: string[]) {
  const value = tokens.shift();
  if (value?.toLowerCase() === 'any') return { range: { network: '0.0.0.0', prefix: 0 } };
  if (value?.toLowerCase() === 'host') {
    const ip = tokens.shift();
    if (!ip) throw new Error('Incomplete host address.');
    ipNumber(ip);
    return { range: { network: ip, prefix: 32 } };
  }
  if (!value) throw new Error('Incomplete address.');
  ipNumber(value);
  if (!tokens[0] || !/^[\d.]+$/.test(tokens[0])) return { range: { network: value, prefix: 32 } };
  const wildcard = tokens.shift()!;
  const bits = ~ipNumber(wildcard) >>> 0;
  try {
    const prefix = parsePrefix(ipString(bits));
    return { range: { network: subnet(value, prefix).network, prefix } };
  } catch {
    return { range: { network: ipString(ipNumber(value) & bits), prefix: 32 }, wildcard };
  }
}
function port(tokens: string[]) {
  if (tokens[0]?.toLowerCase() !== 'eq') return undefined;
  tokens.shift();
  const token = tokens.shift();
  const number = token && (services[token.toLowerCase()] ?? Number(token));
  if (!number || !Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error('Invalid TCP/UDP port.');
  return number;
}
export function aclAddress(range: AclRule['source'], wildcard?: string) {
  return wildcard
    ? `${range.network} ${wildcard}`
    : range.prefix === 0
      ? 'any'
      : range.prefix === 32
        ? `host ${range.network}`
        : `${range.network} ${ipString(~mask(range.prefix))}`;
}
export function registerNativeAclCommands(r: CommandRegistry) {
  r.register({pattern:/^access-list (\d+) (permit|deny) (.+)$/i,modes:['config'],run:(m,e,d)=>{
    const n=Number(m[1]),kind=(n>=1&&n<=99)||(n>=1300&&n<=1999)?'standard':(n>=100&&n<=199)||(n>=2000&&n<=2699)?'extended':undefined;
    if(!kind)throw new Error('Invalid numbered IPv4 ACL range.');
    const context={mode:'config' as const};r.execute(`ip access-list ${kind} ${n}`,e,d,context);r.execute(`${m[2]} ${m[3]}`,e,d,context);
  }});
  r.register({
    pattern: /^(no )?ip access-list (standard|extended) ([\w-]{1,32})$/i,
    syntax: [
      'ip access-list standard <name>',
      'ip access-list extended <name>',
      'no ip access-list standard <name>',
      'no ip access-list extended <name>',
    ],
    modes: ['config'],
    run: (m, e, d, c) => {
      if (m[1]) {
        e.removeAcl(d.id, m[3], true);
        return;
      }
      const kind = m[2].toLowerCase() as 'standard' | 'extended',
        previous = d.accessLists?.find((a) => a.name === m[3]);
      if (previous?.kind && previous.kind !== kind) throw new Error('ACL type cannot be changed in place.');
      e.configureAcl(d.id, { ...previous, name: m[3], kind, rules: previous?.rules ?? [] });
      c.mode = 'acl';
      c.acl = m[3];
      c.aclType = kind;
    },
  });
  r.register({
    pattern: /^(?:(\d+) )?(permit|deny) (.+)$/i,
    syntax: [
      'permit <rule...>',
      'deny <rule...>',
      '<sequence> permit <rule...>',
      '<sequence> deny <rule...>',
    ],
    modes: ['acl'],
    run: (m, e, d, c) => {
      const acl = d.accessLists?.find((a) => a.name === c.acl);
      if (!acl) throw new Error('Select an ACL.');
      const tokens = m[3].trim().split(/\s+/),
        standard = c.aclType === 'standard';
      const protocol = standard ? 'ip' : tokens.shift()!.toLowerCase();
      if (!['ip', 'icmp', 'udp', 'tcp', 'ospf', 'vrrp'].includes(protocol))
        throw new Error('Unsupported ACL protocol.');
      const source = address(tokens),
        sourcePort = standard ? undefined : port(tokens);
      const destination = standard ? { range: { network: '0.0.0.0', prefix: 0 } } : address(tokens);
      const destinationPort = port(tokens);
      const established=tokens[0]?.toLowerCase()==='established';if(established)tokens.shift();
      if(established&&protocol!=='tcp')throw new Error('established requires TCP.');
      if (tokens.length) throw new Error('Unsupported ACL qualifier: ' + tokens.join(' '));
      const sequence = m[1] ? Number(m[1]) : Math.max(0, ...acl.rules.map((r) => r.sequence)) + 10;
      const rule = {
        sequence,
        action: m[2].toLowerCase(),
        protocol,
        source: source.range,
        destination: destination.range,
        sourceWildcard: source.wildcard,
        destinationWildcard: 'wildcard' in destination ? destination.wildcard : undefined,
        sourcePort,
        destinationPort,
        ...(established?{established:true}:{}),
      };
      e.configureAcl(d.id, { ...acl, rules: [...acl.rules.filter((r) => r.sequence !== sequence), rule] });
    },
  });
  r.register({
    pattern: /^no (\d+)$/i,
    syntax: 'no <sequence>',
    modes: ['acl'],
    run: (m, e, d, c) => {
      const acl = d.accessLists?.find((a) => a.name === c.acl);
      if (!acl) throw new Error('Select an ACL.');
      e.configureAcl(d.id, { ...acl, rules: acl.rules.filter((r) => r.sequence !== Number(m[1])) });
    },
  });
}
