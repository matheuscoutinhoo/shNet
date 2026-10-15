import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  dhcpHaStatus,
  configurationDiff,
  TerminalSession,
  preflight,
} from '../packages/simulation-engine/src';
import { dhcpHaFixture } from './fixtures/dhcp-ha';
import { receiveDhcpServer } from '../packages/simulation-engine/src/protocols/dhcp-server';
import { duplicateDevice } from '../apps/web/src/workspace/duplicateDevice';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';

describe('DHCP ativo/reserva com réplica confirmada e fencing administrativo', () => {
  it('atualiza tracking DHCP imediatamente ao parar o serviço ou desfazer o par', () => {
    const { e, a, b } = dhcpHaFixture();
    for (const [i, d] of [a, b].entries())
      e.configureVrrp(d.id, {
        enabled: true,
        groups: [
          {
            port: 'p0',
            vrid: 42,
            vip: '192.0.2.1',
            priority: i ? 100 : 150,
            track: [{ service: 'dhcp', decrement: 80 }],
          },
        ],
      });
    e.setDhcpEnabled(a.id, false);
    expect(a.vrrp!.groups[0].effectivePriority).toBe(70);
    validateSnapshot(e.snapshot());
    e.setDhcpEnabled(a.id, true);
    expect(a.vrrp!.groups[0].effectivePriority).toBe(150);
    e.disableDhcpHa(a.id);
    expect(b.dhcpServer!.enabled).toBe(false);
    expect(b.vrrp!.groups[0].effectivePriority).toBe(20);
    validateSnapshot(e.snapshot());
  });
  it('mantém o aviso de cópia única se o cabo for removido após a promoção', () => {
    const { e, a, b, sync } = dhcpHaFixture();
    e.advanceTo(50);
    e.promoteDhcpHa(b.id);
    e.removeLink(sync.id);
    expect(a.power).toBe(false);
    expect(dhcpHaStatus(e.state, b)).toBe('fenced-active');
    validateSnapshot(e.snapshot());
  });
  it('recusa importação com timers duplicados, transferência duplicada ou confirmação sem réplica', () => {
    const { e, a } = dhcpHaFixture();
    const tick = e.snapshot();
    const t = structuredClone(tick.queue.find((q) => q.action.kind === 'dhcp-ha-tick')!);
    t.order = ++tick.sequence;
    tick.queue.push(t);
    expect(() => validateSnapshot(tick)).toThrow('exatamente um timer');
    const transfer = e.snapshot(),
      q = structuredClone(transfer.queue.find((q) => q.action.kind === 'dhcp-ha-deliver')!);
    q.order = ++transfer.sequence;
    transfer.queue.push(q);
    expect(() => validateSnapshot(transfer)).toThrow('limites');
    const forged = e.snapshot();
    forged.devices.find((d) => d.id === a.id)!.dhcpHa!.confirmed = 1;
    expect(() => validateSnapshot(forged)).toThrow('revisão inválidos');
  });
  it('preflight reconhece pools pareados e avisa sobre réplica indisponível, preservando detecção de colisão real', () => {
    const { e, a, b, sync } = dhcpHaFixture();
    e.advanceTo(50);
    expect(preflight(e.snapshot()).some((v) => v.code === 'DHCP_SCOPE_OVERLAP')).toBe(false);
    sync.up = false;
    expect(
      preflight(e.snapshot()).some((v) => v.code === 'DHCP_HA_REPLICA' && v.severity === 'warning')
    ).toBe(true);
    e.disableDhcpHa(a.id);
    e.setDhcpEnabled(b.id, true);
    expect(preflight(e.snapshot()).some((v) => v.code === 'DHCP_SCOPE_OVERLAP')).toBe(true);
  });
  it('limita a uma transferência em voo e 128 respostas mesmo sob rajada de 150 clientes', () => {
    const { e, a, b, portA, portB } = dhcpHaFixture(false);
    for (const d of [a, b]) e.configureDhcpPool(d.id, { ...d.dhcpServer!.pools[0], end: '192.0.2.250' });
    e.configureDhcpHaPair(a.id, b.id, { portA, portB });
    for (let i = 0; i < 150; i++)
      receiveDhcpServer(e, a, a.interfaces[0], {
        protocol: 'UDP',
        src: '0.0.0.0',
        dst: '255.255.255.255',
        ttl: 64,
        sourcePort: 68,
        destinationPort: 67,
        bytes: 328,
        payload: {
          protocol: 'DHCP',
          message: {
            type: 'discover',
            clientIp: '0.0.0.0',
            transactionId: 'burst-' + i,
            clientMac: '02:fe:00:00:00:' + i.toString(16).padStart(2, '0'),
          },
        },
      });
    expect(e.state.queue.filter(({ action: a }) => a.kind === 'dhcp-ha-reply')).toHaveLength(128);
    expect(
      e.state.queue.filter(({ action: a }) => a.kind === 'dhcp-ha-deliver' || a.kind === 'dhcp-ha-confirm')
    ).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(e.snapshot())).length).toBeLessThan(512 * 1024);
    expect(e.state.events.some((v) => v.type === 'HA_SYNC_REJECTED')).toBe(true);
    e.advanceTo(500);
    expect(a.dhcpServer!.bindings).toEqual(b.dhcpServer!.bindings);
    validateSnapshot(e.snapshot());
  });
  it('uma cópia recebida sem confirmação de volta não autoriza OFFER ao cliente', () => {
    const { e, a, b, clients, sync } = dhcpHaFixture();
    e.advanceTo(10);
    e.requestDhcp(clients[0].id, 'p0');
    for (
      let i = 0;
      i < 100 &&
      !e.state.queue.some(({ action: v }) => v.kind === 'dhcp-ha-confirm' && v.bindings.length > 0);
      i++
    )
      e.step();
    expect(b.dhcpServer!.bindings).toHaveLength(1);
    sync.loss = 1;
    sync.up = false;
    e.advanceTo(1000);
    expect(e.state.events.filter((v) => v.type === 'DHCP_OFFER')).toHaveLength(0);
    expect(clients[0].interfaces[0].ip).toBeUndefined();
    expect(a.dhcpHa!.role).toBe('active');
    validateSnapshot(e.snapshot());
  });
  it('descarta respostas confirmadas tarde e conserva a reserva por mais tempo que o lease anunciado', () => {
    const { e, a, clients, sync } = dhcpHaFixture();
    sync.latency = 3000;
    e.requestDhcp(clients[0].id, 'p0');
    e.advanceTo(6500);
    expect(a.dhcpServer!.bindings[0].expiresAt).toBeGreaterThan(50000);
    expect(e.state.events.filter((v) => v.type === 'DHCP_OFFER')).toHaveLength(0);
    expect(clients[0].interfaces[0].ip).toBeUndefined();
    validateSnapshot(e.snapshot());
  });
  it('replica ofertas/concessões e confirma antes do ACK, inclusive clientes concorrentes', () => {
    const { e, a, b, clients } = dhcpHaFixture();
    for (const d of clients) e.requestDhcp(d.id, 'p0');
    e.advanceTo(500);
    expect(clients.map((d) => d.interfaces[0].dhcp?.status)).toEqual(['bound', 'bound']);
    expect(new Set(clients.map((d) => d.interfaces[0].ip)).size).toBe(2);
    expect(b.dhcpServer!.bindings).toEqual(a.dhcpServer!.bindings);
    expect(dhcpHaStatus(e.state, a)).toBe('synchronized');
    const acknowledgements = e.state.events.filter((v) => v.type === 'DHCP_ACK');
    expect(acknowledgements.length).toBe(2);
    expect(
      acknowledgements.every((ack) =>
        e.state.events.some((v) => v.type === 'HA_SYNC_RECEIVED' && v.time <= ack.time)
      )
    ).toBe(true);
    expect(e.state.events.filter((v) => v.type === 'DHCP_OFFER' && v.device === b.id)).toHaveLength(0);
    validateSnapshot(e.snapshot());
  });
  it('partição de sincronização impede novas ofertas/ACKs e não promove a reserva', () => {
    const { e, a, b, clients, sync } = dhcpHaFixture();
    sync.up = false;
    e.requestDhcp(clients[0].id, 'p0');
    e.advanceTo(4500);
    expect(clients[0].interfaces[0].ip).toBeUndefined();
    expect(e.state.events.some((v) => v.type === 'DHCP_OFFER')).toBe(false);
    expect(b.dhcpHa!.role).toBe('standby');
    expect(dhcpHaStatus(e.state, a)).toBe('unavailable');
    expect(() => e.promoteDhcpHa(b.id)).toThrow('revisão atual');
    expect(a.power).toBe(true);
    sync.up = true;
    e.advanceTo(7000);
    e.requestDhcp(clients[0].id, 'p0');
    e.advanceTo(7500);
    expect(clients[0].interfaces[0].dhcp?.status).toBe('bound');
    validateSnapshot(e.snapshot());
  });
  it('desliga o antigo ativo antes da promoção, preserva lease em T2 e permite novos clientes', () => {
    const { e, a, b, clients } = dhcpHaFixture();
    e.requestDhcp(clients[0].id, 'p0');
    e.advanceTo(500);
    const address = clients[0].interfaces[0].ip;
    e.promoteDhcpHa(b.id);
    expect(a.power).toBe(false);
    expect(a.dhcpHa!.role).toBe('standby');
    expect(b.dhcpHa).toMatchObject({ role: 'active', solo: true });
    e.requestDhcp(clients[1].id, 'p0');
    e.advanceTo(20000);
    expect(clients[0].interfaces[0].dhcp?.status).toBe('bound');
    expect(clients[0].interfaces[0].dhcp?.lease?.server).toBe('192.0.2.3');
    expect(clients[0].interfaces[0].ip).toBe(address);
    expect(clients[1].interfaces[0].ip).not.toBe(address);
    expect(clients[1].interfaces[0].dhcp?.status).toBe('bound');
    expect(() => e.promoteDhcpHa(a.id)).toThrow();
    e.setDevicePower(a.id, true);
    e.advanceTo(22000);
    expect(a.dhcpServer!.bindings).toEqual(b.dhcpServer!.bindings);
    expect(b.dhcpHa!.solo).toBe(false);
    e.promoteDhcpHa(a.id);
    expect(b.power).toBe(false);
    expect(a.dhcpHa!.role).toBe('active');
    validateSnapshot(e.snapshot());
  });
  it('replica RELEASE e quarentena DECLINE sem ressuscitar endereços após restore', () => {
    const { e, a, b, clients } = dhcpHaFixture();
    const client = clients[0];
    e.requestDhcp(client.id, 'p0');
    e.advanceTo(500);
    const address = client.interfaces[0].ip!;
    e.releaseDhcp(client.id, 'p0');
    e.advanceTo(1000);
    expect(a.dhcpServer!.bindings).toHaveLength(0);
    expect(b.dhcpServer!.bindings).toHaveLength(0);
    e.requestDhcp(client.id, 'p0');
    e.advanceTo(1500);
    receiveDhcpServer(e, a, a.interfaces[0], {
      protocol: 'UDP',
      src: '0.0.0.0',
      dst: '255.255.255.255',
      ttl: 64,
      sourcePort: 68,
      destinationPort: 67,
      bytes: 328,
      payload: {
        protocol: 'DHCP',
        message: {
          type: 'decline',
          transactionId: 'decline-test',
          clientIp: '0.0.0.0',
          clientMac: client.interfaces[0].mac,
          server: '192.0.2.2',
          requestedIp: address,
        },
      },
    });
    e.advanceTo(1800);
    expect(a.dhcpServer!.declined).toHaveLength(1);
    expect(b.dhcpServer!.declined).toEqual(a.dhcpServer!.declined);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(2500);
    restored.advanceTo(2500);
    expect(restored.snapshot()).toEqual(e.snapshot());
    validateSnapshot(e.snapshot());
  });
  it('recusa configuração incompatível sem alterar pools, timers ou IDs', () => {
    const { e, a, b, portA, portB } = dhcpHaFixture(false);
    b.dhcpServer!.pools[0].leaseMs++;
    const before = e.snapshot();
    expect(() => e.configureDhcpHaPair(a.id, b.id, { portA, portB })).toThrow('mesmos nomes');
    expect(e.snapshot()).toEqual(before);
  });
  it('protege pools pareados, limpa remoções e mantém cópias fora do par', () => {
    const { e, a, b, sync } = dhcpHaFixture();
    expect(() => e.configureDhcpPool(a.id, a.dhcpServer!.pools[0])).toThrow('Remova o par');
    expect(() => e.removeDhcpPool(b.id, 'LAN')).toThrow('Remova o par');
    const copy = duplicateDevice(e, a).device;
    expect(copy.dhcpHa).toBeUndefined();
    e.removeLink(sync.id);
    validateSnapshot(e.snapshot());
    e.removeDevice(a.id);
    expect(b.dhcpHa).toBeUndefined();
    expect(b.dhcpServer!.enabled).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it('restaura transferências em voo e rejeita papéis ou referências adulterados', () => {
    const { e, a, b, clients } = dhcpHaFixture();
    e.requestDhcp(clients[0].id, 'p0');
    e.advanceTo(3);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(500);
    restored.advanceTo(500);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const bad = e.snapshot();
    bad.devices.find((d) => d.id === b.id)!.dhcpHa!.role = 'active';
    expect(() => validateSnapshot(bad)).toThrow('papel');
    expect(a.dhcpHa!.role).toBe('active');
  });
  it('clona o par sem leases, preserva o isolamento e não transforma replicação em diff de configuração', () => {
    const { e, a, clients } = dhcpHaFixture();
    const before = e.snapshot();
    e.advanceTo(500);
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
    e.requestDhcp(clients[0].id, 'p0');
    e.advanceTo(1000);
    const cloned = cloneTopology(
      e.snapshot(),
      e.state.devices.map((d) => d.id)
    );
    const copies = cloned.snapshot.devices.filter((d) => !e.state.devices.some((o) => o.id === d.id));
    expect(copies.filter((d) => d.dhcpHa)).toHaveLength(2);
    expect(copies.every((d) => !d.dhcpServer?.bindings.length)).toBe(true);
    expect(copies.filter((d) => d.dhcpHa).every((d) => copies.some((p) => p.id === d.dhcpHa!.peer))).toBe(
      true
    );
    validateSnapshot(cloned.snapshot);
    expect(a.dhcpHa!.role).toBe('active');
  });
  it('configura e promove no shell, sem deduzir morte por heartbeat', () => {
    const { e, a, b, portA, portB } = dhcpHaFixture(false);
    const cli = new TerminalSession(e, a.id);
    cli.execute('enable');
    cli.execute('conf t');
    expect(cli.execute('ip dhcp ha configure DHCP-B ' + JSON.stringify({ portA, portB }))).not.toMatch(
      /Erro|Error|%/
    );
    e.advanceTo(20);
    expect(cli.execute('show ip dhcp ha')).toContain('synchronized');
    const backup = new TerminalSession(e, b.id);
    backup.execute('enable');
    backup.execute('conf t');
    expect(backup.execute('ip dhcp ha promote-and-fence')).not.toMatch(/Erro|Error|%/);
    expect(a.power).toBe(false);
    expect(backup.execute('show ip dhcp ha')).toContain('fenced-active');
    expect(backup.execute('no ip dhcp ha')).not.toMatch(/Erro|Error|%/);
    expect(a.dhcpServer!.enabled).toBe(false);
    validateSnapshot(e.snapshot());
  });
});
