import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';
export function enterpriseScenarios(s: Snapshot): Scenario[] {
  const ip = (name: string) => s.devices.find((d) => d.hostname === name)?.interfaces.find((p) => p.ip)?.ip;
  if (!ip('USER-PC') || !ip('ERP') || !ip('LB')) return [];
  const flows = [
    { name: 'Usuário → ERP', source: 'USER-PC', target: ip('ERP'), protocol: 'http', expect: 'allow' },
    { name: 'Tenant A → LB', source: 'TENANT-A-CLIENT', target: ip('LB'), protocol: 'http', expect: 'allow' },
    {
      name: 'Tenant B isolado',
      source: 'TENANT-B-CLIENT',
      target: ip('TENANT-B-SERVER'),
      protocol: 'http',
      expect: 'allow',
    },
  ].filter((f) => f.target && s.devices.some((d) => d.hostname === f.source));
  const base = {
    warmupMs: Math.max(0, Math.ceil(35000 - s.clock)),
    durationMs: 10000,
    intervalMs: 1000,
    deadlineMs: 1000,
    flows,
    faults: [],
  };
  const scenarios = [scenarioSchema.parse({ ...base, name: 'Enterprise/DC — baseline de aplicações' })];
  scenarios.push(
    scenarioSchema.parse({
      ...base,
      name: 'GUEST → ERP — prova de política',
      flows: [
        {
          name: 'Visitante → ERP',
          source: 'GUEST-PC',
          target: ip('ERP'),
          protocol: 'http',
          expect: 'deny',
          denyEvidence: 'policy',
        },
      ],
    })
  );
  for (const d of s.devices.filter((d) =>
    /^(CORE-|FW-|SPINE-|LEAF-|ACCESS-|APP-|LB$|DC-GW$|EDGE-WAN$|DNS|DHCP)/.test(d.hostname)
  ))
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'Perda de ' + d.hostname,
        flows: flows.map((f) => ({ ...f, requireFinalSuccess: true })),
        faults: [{ atMs: 2000, kind: 'device', target: d.id, up: false }],
      })
    );
  const services = [
    {
      name: 'DNS ERP',
      source: 'USER-PC',
      target: ip('DNS'),
      protocol: 'dns',
      expect: 'allow',
      dns: { name: 'erp.enterprise.test', expectedAnswers: [ip('ERP')] },
    },
    {
      name: 'DHCP USERS',
      source: 'USER-PC',
      target: ip('DHCP'),
      protocol: 'dhcp',
      expect: 'allow',
      dhcp: { interface: 'p0', fresh: true, expectedServer: ip('DHCP') },
    },
    {
      name: 'SNMP firewall',
      source: 'ADMIN',
      target: ip('FW-A'),
      protocol: 'snmp',
      expect: 'allow',
      snmp: { community: 'enterprise-test', oids: ['1.3.6.1.2.1.1.5.0'] },
    },
    {
      name: 'NTP gestão',
      source: 'ADMIN',
      target: ip('NTP'),
      protocol: 'ntp',
      expect: 'allow',
      ntp: { maxOffsetMs: 1 },
    },
    {
      name: 'Syslog gestão',
      source: 'ADMIN',
      target: ip('SYSLOG'),
      protocol: 'syslog',
      expect: 'allow',
      syslog: { text: 'Ensaio enterprise/DC', severity: 6 },
    },
  ];
  for (const flow of services)
    if (flow.target && s.devices.some((d) => d.hostname === flow.source))
      scenarios.push(scenarioSchema.parse({ ...base, name: flow.name, flows: [flow] }));
  const leaf = s.devices.find((d) => d.hostname === 'LEAF-1');
  if (leaf)
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'Estado convergido da fabric e Wi-Fi',
        assertions: [
          ...(leaf.bgp?.neighbors ?? []).map((n) => ({
            name: 'BGP ' + n.ip,
            atMs: 9000,
            target: leaf.id,
            kind: 'bgp',
            peer: n.ip,
            expected: 'Established',
          })),
          ...leaf.interfaces
            .filter((p) => p.vxlan)
            .flatMap((p) => [
              {
                name: 'IMET ' + p.vxlan!.vni,
                atMs: 9000,
                target: leaf.id,
                kind: 'evpn-members',
                vni: p.vxlan!.vni,
                expected: 2,
              },
              { name: 'MTU ' + p.id, atMs: 9000, target: leaf.id, kind: 'mtu', port: p.id, expected: p.mtu },
            ]),
          {
            name: 'EAP-TLS autorizado',
            atMs: 9000,
            target: 'WIFI-EMPLOYEE',
            kind: 'eap',
            expected: 'authorized',
          },
          { name: 'LB alimentado', atMs: 9000, target: 'LB', kind: 'power', expected: true },
          {
            name: 'APP-1 saudável',
            atMs: 9000,
            target: 'LB',
            kind: 'proxy-backend',
            backend: ip('APP-1'),
            expected: 'up',
          },
        ]
          .filter(
            (a) =>
              a.expected !== undefined &&
              (!('backend' in a) || a.backend !== undefined) &&
              s.devices.some((d) => d.id === a.target || d.hostname === a.target)
          )
          .slice(0, 64),
      })
    );
  return scenarios;
}
