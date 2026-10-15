import { mkdir, writeFile } from 'node:fs/promises';
import {
  SimulationEngine,
  makeTemplate,
  vxlanConfig,
  validateSnapshot,
  exportPcap,
} from '../packages/simulation-engine/src';

const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/evpn-arp-2026-10-15';
await mkdir(out, { recursive: true });
const engine = new SimulationEngine(makeTemplate('evpn'));
const a = engine.state.devices.find((d) => d.hostname === 'VTEP-A')!;
for (const d of engine.state.devices.filter((d) => d.interfaces.some((p) => p.vxlan))) {
  const p = d.interfaces.find((p) => p.vxlan)!;
  engine.configureVxlan(d.id, { ...vxlanConfig(p), peerPolicy: 'evpn', proxyArp: d.id === a.id });
}
const client = engine.state.devices.find((d) => d.hostname === 'VM-A')!;
engine.advanceTo(4000);
engine.ping(client.id, '10.50.0.20');
engine.advanceTo(6000);
client.arpTable = [];
const ready = engine.snapshot();
await writeFile(out + '/evpn-arp-ready.shlab.json', JSON.stringify(ready) + '\n');
const cases = [];
for (const kind of ['known-binding', 'unknown-address', 'application-stopped'] as const) {
  const e = new SimulationEngine(ready);
  const pc = e.device(client.id),
    remote = e.state.devices.find((d) => d.hostname === 'VM-B')!;
  if (kind === 'application-stopped') {
    const service = remote.tcpServices!.find((s) => s.kind === 'http')!;
    e.configureTcpService(remote.id, { ...service, enabled: false });
  }
  const start = e.state.clock,
    target = kind === 'unknown-address' ? '10.50.0.99' : '10.50.0.20';
  const ping = e.ping(pc.id, target),
    http = kind === 'unknown-address' ? undefined : e.httpGet(pc.id, target);
  e.advanceTo(40000);
  const events = e.state.events.filter((v) => v.time >= start && v.device === a.id);
  const replies = events.filter((v) => v.type === 'EVPN_ARP_REPLIED').length;
  const flooded = events.filter(
    (v) => v.type === 'VXLAN_ENCAP' && v.frame?.arp?.kind === 'request' && v.frame.arp.targetIp === target
  ).length;
  const probe = e.state.probes.find((p) => p.id === ping)!,
    connection = pc.tcpConnections?.find((c) => c.id === http);
  const passed =
    kind === 'known-binding'
      ? replies > 0 &&
        flooded === 0 &&
        probe.status === 'success' &&
        !!connection?.received.includes('overlay VXLAN')
      : kind === 'unknown-address'
        ? replies === 0 && flooded > 0 && probe.status === 'timeout'
        : replies > 0 && flooded === 0 && probe.status === 'success' && connection?.state === 'RESET';
  if (!passed)
    throw new Error(
      'Ensaio ARP EVPN falhou: ' +
        JSON.stringify({ kind, replies, flooded, probe: probe.status, tcp: connection?.state })
    );
  validateSnapshot(e.snapshot());
  const capture = exportPcap(e.snapshot());
  if (capture.excluded.length || capture.dropped)
    throw new Error('Captura incompleta no ensaio selecionado.');
  await writeFile(out + '/' + kind + '.pcap', capture.bytes);
  cases.push({
    kind,
    passed,
    proxyReplies: replies,
    overlayArpRequests: flooded,
    probe: probe.status,
    tcp: connection?.state,
    packets: capture.packets,
    excluded: capture.excluded.length,
  });
}
await writeFile(out + '/scenarios.json', JSON.stringify({ cases }, null, 2) + '\n');
console.log(JSON.stringify({ cases }));
