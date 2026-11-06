import type { SimulationEngine } from '../core/engine';
import type { Device, FirewallZonePolicy, ZbfConfig } from '../model';
import { firewallZonePolicySchema } from './firewall-model';
import { configureFirewall } from './firewall';

type Transport = 'TCP' | 'UDP' | 'ICMP';
// IOS port-to-application mapping (PAM) behind "match protocol NAME" in inspect class-maps.
export const ZBF_PROTOCOLS: Record<string, [Transport, number?][]> = {
  tcp: [['TCP']],
  udp: [['UDP']],
  icmp: [['ICMP']],
  bgp: [['TCP', 179]],
  bootpc: [['UDP', 68]],
  bootps: [['UDP', 67]],
  dns: [
    ['UDP', 53],
    ['TCP', 53],
  ],
  echo: [
    ['TCP', 7],
    ['UDP', 7],
  ],
  ftp: [['TCP', 21]],
  ftps: [['TCP', 990]],
  h323: [['TCP', 1720]],
  http: [['TCP', 80]],
  https: [['TCP', 443]],
  imap: [['TCP', 143]],
  imaps: [['TCP', 993]],
  'ipsec-msft': [['UDP', 4500]],
  isakmp: [['UDP', 500]],
  kerberos: [
    ['TCP', 88],
    ['UDP', 88],
  ],
  ldap: [['TCP', 389]],
  ldaps: [['TCP', 636]],
  'microsoft-ds': [['TCP', 445]],
  mysql: [['TCP', 3306]],
  'netbios-dgm': [['UDP', 138]],
  'netbios-ns': [['UDP', 137]],
  'netbios-ssn': [['TCP', 139]],
  nntp: [['TCP', 119]],
  ntp: [['UDP', 123]],
  pop3: [['TCP', 110]],
  pop3s: [['TCP', 995]],
  rtsp: [['TCP', 554]],
  sip: [
    ['UDP', 5060],
    ['TCP', 5060],
  ],
  smtp: [['TCP', 25]],
  snmp: [['UDP', 161]],
  snmptrap: [['UDP', 162]],
  ssh: [['TCP', 22]],
  syslog: [['UDP', 514]],
  tacacs: [['TCP', 49]],
  telnet: [['TCP', 23]],
  tftp: [['UDP', 69]],
};
/** The PAM name IOS shows for a session's server port. */
export function zbfApplication(protocol: string, port?: number) {
  return (
    Object.entries(ZBF_PROTOCOLS).find(
      ([name, entries]) =>
        !['tcp', 'udp', 'icmp'].includes(name) && entries.some(([p, n]) => p === protocol && n === port)
    )?.[0] ?? protocol.toLowerCase()
  );
}
interface Alternative {
  protocol: 'ip' | Transport;
  port?: number;
  acls: string[];
}
function intersect(a: Alternative, b: Alternative): Alternative | undefined {
  const protocol =
    a.protocol === 'ip'
      ? b.protocol
      : b.protocol === 'ip' || b.protocol === a.protocol
        ? a.protocol
        : undefined;
  if (!protocol || (a.port !== undefined && b.port !== undefined && a.port !== b.port)) return;
  return { protocol, port: a.port ?? b.port, acls: [...new Set([...a.acls, ...b.acls])] };
}
/** The traffic an inspect class-map matches, as alternatives of protocol, port and ACLs. */
function alternatives(z: ZbfConfig, name: string, depth = 0): Alternative[] {
  const map = z.classMaps.find((entry) => entry.name === name);
  if (!map || depth > 8) return [];
  const sets = map.matches.map((m): Alternative[] =>
    'protocol' in m
      ? (ZBF_PROTOCOLS[m.protocol] ?? []).map(([protocol, port]) => ({ protocol, port, acls: [] }))
      : 'acl' in m
        ? [{ protocol: 'ip', acls: [m.acl] }]
        : alternatives(z, m.classMap, depth + 1)
  );
  if (!map.matchAll) return sets.flat();
  if (!sets.length) return [];
  return sets.reduce<Alternative[]>(
    (all, set) => all.flatMap((a) => set.flatMap((b) => intersect(a, b) ?? [])),
    [{ protocol: 'ip', acls: [] }]
  );
}
export const ZBF_ACTIONS = { inspect: 'inspect', pass: 'permit', drop: 'deny' } as const;
/** Policy-map classes in IOS order: class-default (implicitly "drop") is always the last one. */
export function zbfClasses(policy: ZbfConfig['policyMaps'][number]) {
  return [
    ...policy.classes.filter((entry) => entry.className !== 'class-default'),
    policy.classes.find((entry) => entry.className === 'class-default') ?? { className: 'class-default' },
  ];
}
/**
 * Compiles zones, inspect class-maps, policy-maps and zone-pairs into the firewall zone policy.
 * Zone membership comes from "zone-member security" on the interfaces. An implicit class-default
 * drop needs no rule between zones (traffic without a rule is dropped), but the self zone, where
 * traffic is allowed without a policy, gets an explicit one.
 */
export function compileZbf(d: Device, z: ZbfConfig): FirewallZonePolicy {
  const self = z.zonePairs.some((pair) => pair.source === 'self' || pair.destination === 'self');
  const zones = [
    ...z.zones.map((zone) => ({
      name: zone.name,
      ports: d.interfaces.filter((port) => port.zoneMember === zone.name).map((port) => port.id),
    })),
    ...(self ? [{ name: 'self', ports: [] }] : []),
  ];
  const rules: FirewallZonePolicy['rules'] = [];
  for (const pair of z.zonePairs) {
    const policy = z.policyMaps.find((entry) => entry.name === pair.policy);
    if (!policy) continue;
    const selfPair = pair.source === 'self' || pair.destination === 'self';
    for (const entry of zbfClasses(policy)) {
      const action = entry.action ?? 'drop';
      const matched =
        entry.className === 'class-default'
          ? selfPair || action !== 'drop' || entry.log
            ? [{ protocol: 'ip' as const, acls: [] }]
            : []
          : alternatives(z, entry.className);
      for (const alternative of matched) {
        if (alternative.acls.length > 4)
          throw new Error(`% Class-map ${entry.className} matches more than 4 access lists at once.`);
        rules.push({
          sequence: rules.length + 1,
          from: pair.source,
          to: pair.destination,
          protocol: alternative.protocol,
          ...(alternative.port !== undefined ? { destinationPort: alternative.port } : {}),
          ...(alternative.acls.length ? { acls: alternative.acls } : {}),
          action: ZBF_ACTIONS[action],
          zonePair: pair.name,
          className: entry.className,
          ...(entry.log ? { log: true } : {}),
        });
      }
    }
  }
  if (rules.length > 512) throw new Error('% The zone-based policy exceeds 512 compiled rules.');
  return firewallZonePolicySchema.parse({ zones, rules });
}
/**
 * Applies the IOS zone-based firewall: the firewall filters once an interface joins a zone, and
 * disappears with the last ZBF definition. Unchanged policies keep their sessions.
 */
export function applyZbf(e: SimulationEngine, d: Device) {
  const z = d.zbf;
  if (!z) return;
  if (!z.zones.length && !z.classMaps.length && !z.policyMaps.length && !z.zonePairs.length) {
    delete d.zbf;
    if (d.firewall?.zonePolicy) {
      configureFirewall(e, d, { enabled: false, trustedPorts: [], protocols: ['TCP', 'UDP', 'ICMP'] });
      delete d.firewall;
    }
    return;
  }
  const zonePolicy = compileZbf(d, z),
    enabled = d.interfaces.some((port) => !!port.zoneMember),
    current = d.firewall;
  if (
    current?.enabled === enabled &&
    JSON.stringify(current.zonePolicy) === JSON.stringify(zonePolicy) &&
    !current.trustedPorts.length
  )
    return;
  configureFirewall(e, d, {
    enabled,
    zonePolicy,
    trustedPorts: [],
    protocols: ['TCP', 'UDP', 'ICMP'],
    ...(current?.application ? { application: current.application } : {}),
  });
}
