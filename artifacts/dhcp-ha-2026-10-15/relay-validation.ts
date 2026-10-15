import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { SimulationEngine, validateSnapshot, ENGINE_CONTRACT_VERSION } from '../../packages/simulation-engine/src';
import { dhcpHaTemplate } from '../../packages/simulation-engine/src/dhcp-ha-template';
import { engineSourceHash } from '../../scripts/engine-build';
const e = new SimulationEngine(dhcpHaTemplate(false));
const a = e.state.devices.find((d) => d.hostname === 'DHCP-A')!,
  b = e.state.devices.find((d) => d.hostname === 'DHCP-B')!,
  client = e.state.devices.find((d) => d.hostname === 'DHCP-CLIENT-1')!,
  sw = e.state.devices.find((d) => d.type === 'switch')!,
  router = e.addDevice('router');
router.hostname = 'RELAY';
Object.assign(router.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
Object.assign(router.interfaces[1], { ip: '192.0.2.1', prefix: 24 });
e.removeLink(e.state.links.find((l) => l.a.device === client.id || l.b.device === client.id)!.id);
e.connect({ device: client.id, port: 'p0' }, { device: router.id, port: 'p0' });
e.connect({ device: router.id, port: 'p1' }, { device: sw.id, port: 'p4' });
for (const d of [a, b]) {
  d.gateway = '192.0.2.1';
  e.configureDhcpPool(d.id, { ...d.dhcpServer!.pools[0], network: '10.0.0.0',
    start: '10.0.0.100', end: '10.0.0.110', gateway: '10.0.0.1', relayAddress: '10.0.0.1' });
}
e.configureDhcpRelay(router.id, 'p0', ['192.0.2.2', '192.0.2.3']);
e.configureDhcpHaPair(a.id, b.id, { portA: 'nic0', portB: 'nic0' });
e.requestDhcp(client.id, 'p0'); e.advanceTo(500);
assert.equal(client.interfaces[0].dhcp?.status, 'bound');
assert.deepEqual(a.dhcpServer!.bindings, b.dhcpServer!.bindings);
const original = structuredClone(client.interfaces[0].dhcp!.lease!);
e.setDevicePower(a.id, false); e.promoteDhcpHa(b.id); e.advanceTo(20000);
assert.equal(client.interfaces[0].dhcp?.status, 'bound');
assert.equal(client.interfaces[0].ip, original.address);
assert.equal(client.interfaces[0].dhcp?.lease?.server, '192.0.2.3');
validateSnapshot(e.snapshot());
const result = { passed: true, engineContract: ENGINE_CONTRACT_VERSION, engineSourceHash: engineSourceHash(),
  scope: 'Local DHCPv4 replication through routed relay with both physical server targets; T2 after primary power failure and administrative promotion.',
  originalLease: original, finalLease: client.interfaces[0].dhcp!.lease,
  replica: b.dhcpServer!.bindings,
};
await writeFile('artifacts/dhcp-ha-2026-10-15/relay-validation.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, source: result.engineSourceHash, address: client.interfaces[0].ip }));
