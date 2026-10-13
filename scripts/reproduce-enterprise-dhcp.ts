import { readFileSync, writeFileSync } from 'node:fs';
import { SimulationEngine, type Snapshot } from '../packages/simulation-engine/src';
const out = 'artifacts/enterprise-datacenter-audit';
const initial: Snapshot = JSON.parse(readFileSync(out + '/enterprise-datacenter.shlab.json', 'utf8'));
const results = [];
for (const rogueEnabled of [false, true]) {
  const e = new SimulationEngine(initial);
  e.advanceTo(35000, 200000);
  const named = (name: string) => e.state.devices.find((d) => d.hostname === name)!;
  const sw = named('ACCESS-USERS'),
    client = named('DHCP-PC');
  if (rogueEnabled) {
    const rogue = e.addDevice('server');
    rogue.hostname = 'ROGUE-DHCP';
    Object.assign(rogue.interfaces[0], { ip: '10.60.10.200', prefix: 24, speed: 1000 });
    e.connect({ device: rogue.id, port: 'p0' }, { device: sw.id, port: 'p3' });
    e.setSpanningTreePort(sw.id, 'p3', { edge: true });
    e.configureDhcpPool(rogue.id, {
      name: 'ROGUE',
      port: 'p0',
      network: '10.60.10.0',
      prefix: 24,
      start: '10.60.10.201',
      end: '10.60.10.210',
      gateway: '10.60.10.200',
      leaseMs: 60000,
      excluded: [],
      dns: [],
    });
    e.setDhcpEnabled(rogue.id, true);
    e.advanceTo(70000, 200000);
  }
  e.configureDhcpSnooping(sw.id, { enabled: true, vlans: [10], trustedPorts: ['p20', 'p21'] });
  const events: unknown[] = [],
    emit = e.emit.bind(e);
  e.emit = ((...args: Parameters<SimulationEngine['emit']>) => {
    const ev = emit(...args),
      packet = ev.frame?.packet;
    if (
      (packet?.protocol === 'UDP' && packet.payload.protocol === 'DHCP') ||
      (/DHCP/.test(ev.reason) && !ev.type.startsWith('FRAME_'))
    ) {
      events.push({
        time: ev.time,
        type: ev.type,
        device: e.state.devices.find((d) => d.id === ev.device)?.hostname,
        port: ev.port,
        reason: ev.reason,
        packet,
      });
    }
    return ev;
  }) as SimulationEngine['emit'];
  e.requestDhcp(client.id, 'p0');
  e.advanceTo(e.state.clock + 15000, 200000);
  results.push({ rogueEnabled, lease: client.interfaces[0].dhcp, snooping: sw.dhcpSnooping, events });
  console.log(
    JSON.stringify({
      rogueEnabled,
      status: client.interfaces[0].dhcp?.status,
      lease: client.interfaces[0].dhcp?.lease,
      dropped: sw.dhcpSnooping?.dropped,
    })
  );
}
writeFileSync(out + '/dhcp-snooping-reproduction.json', JSON.stringify(results, null, 2));
