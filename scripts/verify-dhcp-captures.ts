import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  exportPcap,
  encodeEthernet,
  validateSnapshot,
  ENGINE_CONTRACT_VERSION,
} from '../packages/simulation-engine/src';
import { dhcpCaptureFixtures } from '../tests/fixtures/dhcp-captures';
import { engineSourceHash } from './engine-build';

const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/dhcp-captures-2026-10-15';
await mkdir(out, { recursive: true });
const { local, failover, relay } = dhcpCaptureFixtures();
const scenarios = [];
for (const [name, e] of Object.entries({ local, failover, relay })) {
  const snapshot = validateSnapshot(e.snapshot()),
    capture = exportPcap(snapshot);
  assert.equal(capture.excluded.length, 0);
  assert.equal(capture.dropped, 0);
  const clients = snapshot.devices.filter((d) => d.interfaces.some((p) => p.dhcp));
  assert(clients.length && clients.every((d) => d.interfaces.find((p) => p.dhcp)!.dhcp!.status === 'bound'));
  if (name !== 'local')
    assert(clients.every((d) => d.interfaces.find((p) => p.dhcp)!.dhcp!.lease!.server === '192.0.2.3'));
  const frames = snapshot.capture!.frames.map((event) => {
    const frame = event.frame!,
      p = frame.packet;
    return {
      event: event.id,
      time: event.time,
      bytes: encodeEthernet(frame).length,
      sourceMac: frame.src,
      destinationMac: frame.dst,
      ...(p?.protocol === 'UDP' && p.payload.protocol === 'DHCP'
        ? {
            source: p.src,
            destination: p.dst,
            sourcePort: p.sourcePort,
            destinationPort: p.destinationPort,
            ipBytes: p.bytes,
            dhcp: p.payload.message,
          }
        : {}),
    };
  });
  assert.equal(frames.length, capture.packets);
  scenarios.push({
    name,
    packets: capture.packets,
    excluded: capture.excluded,
    dropped: capture.dropped,
    clients: clients.map((d) => ({ name: d.hostname, lease: d.interfaces.find((p) => p.dhcp)!.dhcp!.lease })),
    frames,
  });
  await writeFile(out + '/' + name + '.pcap', capture.bytes);
  await writeFile(out + '/' + name + '.shlab.json', JSON.stringify(snapshot));
}
await writeFile(
  out + '/captures.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      engineContract: ENGINE_CONTRACT_VERSION,
      engineSourceHash: engineSourceHash(),
      passed: true,
      scope:
        'Retained Ethernet/IPv4/ARP/DHCPv4 network frames: conflict, DORA, NAK/RELEASE, T1/T2, relay and administrative failover. HA database channel is a separate simulated transport, outside this PCAP scope.',
      scenarios,
    },
    null,
    2
  ) + '\n'
);
console.log(
  JSON.stringify({
    passed: true,
    scenarios: scenarios.length,
    packets: scenarios.reduce((n, s) => n + s.packets, 0),
    output: out,
  })
);
