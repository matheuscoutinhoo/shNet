import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  ENGINE_CONTRACT_VERSION,
  dhcpHaStatus,
} from '../packages/simulation-engine/src';
import { engineSourceHash } from './engine-build';

const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/dhcp-ha-2026-10-15';
await mkdir(out, { recursive: true });
const snapshot = makeTemplate('dhcp-ha');
await writeFile(out + '/dhcp-ha.shlab.json', JSON.stringify(snapshot));
const e = new SimulationEngine(snapshot),
  a = e.state.devices.find((d) => d.hostname === 'DHCP-A')!,
  b = e.state.devices.find((d) => d.hostname === 'DHCP-B')!,
  clients = e.state.devices.filter((d) => d.type === 'pc'),
  sync = e.state.links.find((l) => l.a.device === a.id && l.b.device === b.id)!;
const results: object[] = [];
function record(name: string) {
  validateSnapshot(e.snapshot());
  results.push({
    name,
    clock: e.state.clock,
    active: [a, b].find((d) => d.dhcpHa?.role === 'active')?.hostname,
    members: [a, b].map((d) => ({
      name: d.hostname,
      power: d.power,
      status: dhcpHaStatus(e.state, d),
      replication: d.dhcpHa,
      bindings: d.dhcpServer!.bindings,
      declined: d.dhcpServer!.declined ?? [],
    })),
    clients: clients.map((d) => ({
      name: d.hostname,
      address: d.interfaces[0].ip,
      lease: d.interfaces[0].dhcp?.lease,
    })),
  });
}
e.requestDhcp(clients[0].id, 'p0');
e.advanceTo(500);
assert.equal(clients[0].interfaces[0].dhcp?.status, 'bound');
assert.deepEqual(a.dhcpServer!.bindings, b.dhcpServer!.bindings);
const address = clients[0].interfaces[0].ip;
record('Concessão confirmada nas duas instâncias');
sync.up = false;
e.requestDhcp(clients[1].id, 'p0');
e.advanceTo(6000);
assert.equal(clients[1].interfaces[0].ip, undefined);
assert.equal(b.dhcpHa!.role, 'standby');
assert.throws(() => e.promoteDhcpHa(b.id), /revisão atual/);
record('Partição suspende respostas e impede promoção de réplica obsoleta');
sync.up = true;
e.advanceTo(7500);
e.promoteDhcpHa(b.id);
assert.equal(a.power, false);
e.requestDhcp(clients[1].id, 'p0');
e.advanceTo(22000);
assert.equal(clients[0].interfaces[0].ip, address);
assert.equal(clients[0].interfaces[0].dhcp?.status, 'bound');
assert.equal(clients[0].interfaces[0].dhcp?.lease?.server, '192.0.2.3');
assert.equal(clients[1].interfaces[0].dhcp?.status, 'bound');
assert.notEqual(clients[1].interfaces[0].ip, address);
record('Promoção com fencing, renovação T2 e novo cliente sem colisão');
e.setDevicePower(a.id, true);
e.advanceTo(24000);
assert.deepEqual(a.dhcpServer!.bindings, b.dhcpServer!.bindings);
assert.equal(b.dhcpHa!.solo, false);
record('Retorno como reserva e resincronização');
const restored = new SimulationEngine(e.snapshot());
e.advanceTo(25000);
restored.advanceTo(25000);
assert.deepEqual(e.snapshot(), restored.snapshot());
record('Retomada determinística após salvar e carregar');
e.promoteDhcpHa(a.id);
assert.equal(b.power, false);
record('Failback administrativo com cópia atual e antigo ativo desligado');
await writeFile(
  out + '/replication.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      engineContract: ENGINE_CONTRACT_VERSION,
      engineSourceHash: engineSourceHash(),
      passed: true,
      scope:
        'DHCPv4 simulated synchronous replication; administrative power fencing; no automatic quorum election or vendor wire codec.',
      limits: {
        pendingRepliesPerPair: 128,
        inFlightDatabaseTransfersPerPair: 1,
        replyDeadlineMs: 5000,
        leaseReservationGuardMs: 30000,
      },
      results,
      timeline: e.state.events
        .filter(
          (v) => v.type.startsWith('DHCP_') || v.type.startsWith('HA_SYNC_') || v.type === 'CONFIG_CHANGED'
        )
        .map(({ type, time, device, reason }) => ({ type, time, device, reason })),
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({ passed: true, checks: results.length, output: out }));
