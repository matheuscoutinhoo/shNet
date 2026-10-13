import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  stateSyncPending,
} from '../packages/simulation-engine/src';
import { ENGINE_CONTRACT_VERSION } from '../packages/simulation-engine/src/version';
import { openTcp } from '../packages/simulation-engine/src/protocols/tcp';
import {
  encodeModbusRequest,
  decodeModbus,
  modbusFrameLength,
} from '../packages/simulation-engine/src/protocols/modbus';

const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/ha-remediation-2026-10-13';
await mkdir(out, { recursive: true });
const topology = makeTemplate('enterprise-datacenter');
await writeFile(out + '/enterprise-datacenter.shlab.json', JSON.stringify(topology));
const e = new SimulationEngine(topology);
const device = (name: string) => e.state.devices.find((d) => d.hostname === name)!;
const a = device('FW-A'),
  b = device('FW-B'),
  client = device('USER-PC');
e.advanceTo(35000, 200000);
for (const d of [device('ERP'), device('EXTERNAL-WEB')])
  e.configureTcpService(d.id, { kind: 'echo', enabled: true, port: 7777 });
for (const d of [a, b]) {
  const policy = d.firewall!.zonePolicy!;
  e.configureFirewall(d.id, {
    ...d.firewall!,
    zonePolicy: {
      ...policy,
      rules: [
        { sequence: 1, from: 'USERS', to: 'CORP', protocol: 'TCP', destinationPort: 7777, action: 'inspect' },
        { sequence: 2, from: 'USERS', to: 'WAN', protocol: 'TCP', destinationPort: 7777, action: 'inspect' },
        ...policy.rules,
      ],
    },
  });
  d.interfaces.find((p) => p.logical?.vlan === 10)!.natRole = 'inside';
  d.interfaces.find((p) => p.id === 'p1')!.natRole = 'outside';
  e.configureNat(d.id, {
    enabled: true,
    statics: [],
    pools: [
      {
        name: 'HA-WAN',
        source: { network: '10.60.10.0', prefix: 24 },
        outside: 'p1',
        start: '172.31.0.100',
        end: '172.31.0.100',
        overload: true,
      },
    ],
  });
}
const connections = ['10.60.40.10', '198.51.100.10'].map((target) => ({
  target,
  id: e.openTcp(client.id, target, 7777, 'before|', false),
}));
e.advanceTo(37000, 200000);
for (const c of connections)
  assert.equal(client.tcpConnections!.find((p) => p.id === c.id)!.received, 'before|');
assert.equal(stateSyncPending(e.state, a), 0);
const translated = structuredClone(a.nat!.bindings[0]);
validateSnapshot(e.snapshot());
e.setDevicePower(a.id, false);
e.advanceTo(42000, 200000);
for (const c of connections) e.writeTcp(client.id, c.id, 'after|');
e.advanceTo(44000, 200000);
for (const c of connections)
  assert.equal(client.tcpConnections!.find((p) => p.id === c.id)!.received, 'before|after|');
assert.equal(b.nat!.bindings[0].globalToken, translated.globalToken);
const checkpoint = e.snapshot(),
  restored = new SimulationEngine(checkpoint);
e.advanceTo(45000, 200000);
restored.advanceTo(45000, 200000);
assert.deepEqual(restored.snapshot(), e.snapshot());
e.setDevicePower(a.id, true);
e.advanceTo(50000, 200000);
for (const c of connections) e.writeTcp(client.id, c.id, 'failback|');
e.advanceTo(52000, 200000);
for (const c of connections)
  assert.equal(client.tcpConnections!.find((p) => p.id === c.id)!.received, 'before|after|failback|');
validateSnapshot(e.snapshot());
const result = {
  engineContract: ENGINE_CONTRACT_VERSION,
  devices: topology.devices.length,
  links: topology.links.length,
  connections: connections.map((c) => ({
    ...c,
    received: client.tcpConnections!.find((p) => p.id === c.id)!.received,
  })),
  nat: {
    id: translated.id,
    global: translated.global,
    globalToken: translated.globalToken,
    preserved: a.nat!.bindings[0].globalToken === translated.globalToken,
  },
  primary: a.stateSync,
  backup: b.stateSync,
  checkpointDeterministic: true,
  passed: true,
};
await writeFile(out + '/enterprise-ha-results.json', JSON.stringify(result, null, 2));
// Keep one binary Modbus connection across the two routed factory zones.
const f = new SimulationEngine(makeTemplate('factory'));
const fa = f.state.devices.find((d) => d.hostname === 'FW-A')!,
  fb = f.state.devices.find((d) => d.hostname === 'FW-B')!,
  scada = f.state.devices.find((d) => d.hostname === 'SCADA')!,
  plc = f.state.devices.find((d) => d.hostname === 'PLC-A')!;
const request = (transaction: number, fn = 3) =>
  encodeModbusRequest({
    transaction,
    unit: 1,
    function: fn,
    address: 0,
    quantity: 1,
    values: fn === 6 ? [777] : [],
  });
const plcConnection = openTcp(f, scada, plc.interfaces[0].ip!, 502, request(1), false, (c) => {
  c.service = 'modbus';
  c.encoding = 'binary';
  c.stream = { readBytes: 0, writtenBytes: 0 };
});
f.advanceTo(f.state.clock + 2000, 200000);
const connection = () => scada.tcpConnections!.find((c) => c.id === plcConnection)!;
assert.equal(decodeModbus(connection().received).transaction, 1);
assert.equal(
  fb.firewall!.sessions.some(
    (s) => s.protocol === 'TCP' && s.serverPort === 502 && s.state === 'ESTABLISHED'
  ),
  true
);
f.setDevicePower(fa.id, false);
f.advanceTo(f.state.clock + 5000, 200000);
f.writeTcp(scada.id, plcConnection, request(2, 6));
f.advanceTo(f.state.clock + 2000, 200000);
assert.equal(plc.modbus!.registers[0], 777);
f.setDevicePower(fa.id, true);
f.advanceTo(f.state.clock + 5000, 200000);
f.writeTcp(scada.id, plcConnection, request(3));
f.advanceTo(f.state.clock + 2000, 200000);
const replies = [];
let data = connection().received;
while (data.length) {
  const length = modbusFrameLength(data, 'binary');
  assert.ok(length);
  const response = decodeModbus(data.slice(0, length));
  replies.push({
    transaction: response.transaction,
    function: response.function,
    exception: response.exception,
  });
  data = data.slice(length);
}
assert.deepEqual(
  replies.map((r) => r.transaction),
  [1, 2, 3]
);
assert.equal(connection().state, 'ESTABLISHED');
validateSnapshot(f.snapshot());
await writeFile(
  out + '/factory-ha-results.json',
  JSON.stringify(
    {
      engineContract: ENGINE_CONTRACT_VERSION,
      devices: f.state.devices.length,
      links: f.state.links.length,
      connectionId: plcConnection,
      connectionState: connection().state,
      replies,
      register0: plc.modbus!.registers[0],
      sameConnectionAcrossFailoverAndFailback: true,
      passed: true,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    devices: result.devices,
    links: result.links,
    existingTcp: result.connections,
    natPreserved: result.nat.preserved,
    checkpointDeterministic: true,
  })
);
