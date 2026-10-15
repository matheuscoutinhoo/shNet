import { SimulationEngine } from './core/engine';
import { addProfile } from './devices/profiles';
import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';

export function serviceHaTemplate(): Snapshot {
  const e = new SimulationEngine(),
    client = e.addDevice('pc', { x: 100, y: 260 }),
    a = e.addDevice('server', { x: 750, y: 120 }),
    b = e.addDevice('server', { x: 750, y: 420 }),
    switches = ['A', 'B'].map((side, i) => {
      const sw = e.addDevice('switch', { x: 420, y: 120 + i * 300 });
      sw.hostname = 'SVC-ACCESS-' + side;
      return sw;
    });
  client.hostname = 'SVC-CLIENT';
  a.hostname = 'SVC-A';
  b.hostname = 'SVC-B';
  e.connect({ device: switches[0].id, port: 'p3' }, { device: switches[1].id, port: 'p3' });
  for (const [i, host] of [client, a, b].entries()) {
    const spare = e.installNic(host.id);
    for (const [n, port] of ['p0', spare.id].entries())
      e.connect({ device: host.id, port }, { device: switches[n].id, port: 'p' + i });
    Object.assign(host.interfaces[0], { ip: i === 0 ? '192.0.2.10' : '192.0.2.' + (i + 1), prefix: 24 });
    const bond = e.configureBond(
      host.id,
      1,
      ['p0', spare.id],
      'p0',
      i ? { target: '192.0.2.10' } : undefined
    );
    if (!i) continue;
    e.setDnsEnabled(host.id, true);
    e.configureDnsRecord(host.id, { name: 'app.service.test', type: 'A', value: '192.0.2.1', ttl: 60 });
    e.configureTcpService(host.id, {
      enabled: true,
      kind: 'http',
      port: 80,
      body: 'Serviço HTTP redundante',
    });
    e.configureClock(host.id, { offsetMs: 0, server: true, stratum: 1 });
    e.setSyslogEnabled(host.id, true);
    e.configureVrrp(host.id, {
      enabled: true,
      groups: [
        {
          port: bond.id,
          vrid: 42,
          vip: '192.0.2.1',
          priority: i === 1 ? 150 : 100,
          acceptMode: true,
          track: [
            { service: 'dns', decrement: 80 },
            { service: 'http', decrement: 80 },
          ],
        },
      ],
    });
  }
  for (const [i, side] of ['A', 'B'].entries()) {
    const ups = addProfile(e, 'ups', { x: 100 + i * 700, y: 560 });
    ups.hostname = 'SVC-UPS-' + side;
    e.setDevicePower(ups.id, true);
    if (ups.infrastructure?.kind !== 'ups') throw new Error('Perfil UPS inválido.');
    e.configureInfrastructure(ups.id, {
      ...ups.infrastructure,
      loads: [client, a, b, switches[i]].map((d) => ({ device: d.id, watts: 50, requested: true })),
    });
    const rack = addProfile(e, 'rack', { x: 60 + i * 800, y: 90 });
    rack.hostname = 'SVC-RACK-' + side;
    e.configureInfrastructure(rack.id, {
      kind: 'rack',
      units: 42,
      ambientC: 22,
      ventilation: 1,
      slots: [
        { device: switches[i].id, unit: 1, units: 1 },
        { device: ups.id, unit: 40, units: 2 },
      ],
    });
  }
  e.state.notes =
    'VIP 192.0.2.1, VRRP accept mode e tracking DNS/HTTP. Serviços com conteúdo configurado igual nas duas instâncias. NICs e energia A/B nos três endpoints. O cliente observa carrier; os servidores sondam o cliente por ARP. Os presets medem novas requisições, não continuidade das mesmas sessões. VRRP não replica dados/leases/sessões; um serviço indisponível nas duas instâncias ou uma partição de anúncios pode interromper o atendimento. NTP e syslog estão configurados, mas logs recebidos ficam em cada instância.';
  return e.snapshot();
}
export function serviceHaScenarios(s: Snapshot): Scenario[] {
  const client = s.devices.find((d) => d.hostname === 'SVC-CLIENT');
  const a = s.devices.find(
    (d) => d.hostname === 'SVC-A' && d.vrrp?.groups.some((g) => g.vip === '192.0.2.1')
  );
  if (!client || !a) return [];
  const flows = [
    {
      name: 'HTTP no VIP',
      source: client.id,
      target: '192.0.2.1',
      protocol: 'http',
      expect: 'allow',
      maxLossPercent: 40,
      requireFinalSuccess: true,
      maxLatencyMs: 800,
    },
    {
      name: 'DNS no VIP',
      source: client.id,
      target: '192.0.2.1',
      protocol: 'dns',
      expect: 'allow',
      dns: { name: 'app.service.test', expectedAnswers: ['192.0.2.1'] },
      maxLossPercent: 40,
      requireFinalSuccess: true,
      maxLatencyMs: 800,
    },
  ];
  const allFlows = [
    ...flows,
    {
      name: 'NTP no VIP',
      source: client.id,
      target: '192.0.2.1',
      protocol: 'ntp',
      expect: 'allow',
      ntp: { maxOffsetMs: 10 },
      maxLossPercent: 40,
      requireFinalSuccess: true,
      maxLatencyMs: 800,
    },
    {
      name: 'Syslog no VIP',
      source: client.id,
      target: '192.0.2.1',
      protocol: 'syslog',
      expect: 'allow',
      syslog: { text: 'Evento de disponibilidade', severity: 6 },
      maxLossPercent: 40,
      requireFinalSuccess: true,
      maxLatencyMs: 800,
    },
  ];
  const base = { warmupMs: 5000, durationMs: 12000, intervalMs: 1000, deadlineMs: 800, flows: allFlows };
  return [
    scenarioSchema.parse({
      ...base,
      name: 'Serviços HA — baseline',
      flows: allFlows.map((f) => ({ ...f, maxLossPercent: 0 })),
      faults: [],
    }),
    scenarioSchema.parse({
      ...base,
      name: 'Serviços HA — perda da instância A',
      faults: [{ atMs: 2000, kind: 'device', target: a.id, up: false }],
    }),
    ...(['dns', 'http'] as const).map((service) =>
      scenarioSchema.parse({
        ...base,
        name: 'Serviços HA — parada de ' + service,
        faults: [{ atMs: 2000, kind: 'service', target: a.id, service, up: false }],
      })
    ),
    ...['A', 'B'].flatMap((side) => {
      const ups = s.devices.find((d) => d.hostname === 'SVC-UPS-' + side);
      const sw = s.devices.find((d) => d.hostname === 'SVC-ACCESS-' + side);
      return !ups || !sw
        ? []
        : [
            scenarioSchema.parse({
              ...base,
              name: 'Serviços HA — perda do acesso/rack ' + side,
              flows: allFlows.map((f) => ({ ...f, maxLossPercent: 0 })),
              faults: [
                { atMs: 2000, kind: 'device', target: ups.id, up: false },
                { atMs: 2000, kind: 'device', target: sw.id, up: false },
              ],
            }),
          ];
    }),
  ];
}
