import { describe, expect, it } from 'vitest';
import { openTcp } from '../packages/simulation-engine/src/protocols/tcp';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  vrrpConfigGroups,
  vrrpTrackSchema,
  inspectorTabIds,
  makeTemplate,
  serviceHaScenarios,
  ScenarioRunner,
} from '@shlab/engine';
function topology(acceptMode = true) {
  const e = new SimulationEngine(),
    client = e.addDevice('pc'),
    sw = e.addDevice('switch'),
    a = e.addDevice('server'),
    b = e.addDevice('server');
  Object.assign(client.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
  for (const [i, d] of [client, a, b].entries())
    e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + i });
  for (const [i, d] of [a, b].entries()) {
    Object.assign(d.interfaces[0], { ip: '192.0.2.' + (2 + i), prefix: 24 });
    e.setDnsEnabled(d.id, true);
    e.configureDnsRecord(d.id, { name: 'ha.example.test', type: 'A', value: '198.51.100.10', ttl: 60 });
    e.configureTcpService(d.id, { kind: 'http', port: 80, enabled: true, body: 'service:' + i });
    e.configureTcpService(d.id, { kind: 'echo', port: 7, enabled: true });
    e.configureVrrp(d.id, {
      enabled: true,
      groups: [
        {
          port: 'p0',
          vrid: 42,
          vip: '192.0.2.1',
          priority: i ? 100 : 150,
          acceptMode,
          track: [{ service: 'dns', decrement: 80 }],
        },
      ],
    });
  }
  e.advanceTo(4500, 100000);
  const dns = (mode: 'udp' | 'tcp') => {
    e.clearDnsCache(client.id);
    const id = e.lookupDns(client.id, 'ha.example.test', 'A', '192.0.2.1', undefined, mode);
    e.advanceTo(e.state.clock + 500, 100000);
    return client.dnsQueries!.find((q) => q.id === id)!;
  };
  const http = () => {
    const id = e.httpGet(client.id, '192.0.2.1');
    e.advanceTo(e.state.clock + 500, 100000);
    return client.tcpConnections!.find((c) => c.id === id)!;
  };
  return { e, client, a, b, dns, http };
}
describe('HA de endereço virtual de serviços', () => {
  it('executa os seis presets nativos, incluindo serviço parado e perda de rack', () => {
    const snapshot = makeTemplate('service-ha');
    validateSnapshot(snapshot);
    expect(snapshot.devices).toHaveLength(9);
    const presets = serviceHaScenarios(snapshot);
    expect(presets).toHaveLength(6);
    for (const scenario of presets) {
      const runner = new ScenarioRunner(snapshot, scenario);
      for (let n = 0; n < 3000 && !runner.step(100); n++);
      const report = runner.report();
      expect(
        report.passed,
        JSON.stringify({
          name: report.name,
          flows: report.flows,
          failed: report.samples
            .filter((s) => s.status !== 'success')
            .map((s) => ({
              flow: s.flow,
              atMs: s.atMs,
              reason: s.reason,
            })),
        })
      ).toBe(true);
      validateSnapshot(runner.engine.snapshot());
    }
  });
  it('DNS UDP/TCP e novas conexões HTTP mudam para o backup após perda da instância', () => {
    const { e, a, b, dns, http } = topology();
    expect(a.vrrp!.groups[0].state).toBe('ACTIVE');
    expect(http().received).toContain('service:0');
    for (const mode of ['udp', 'tcp'] as const) expect(dns(mode).status).toBe('success');
    e.setDevicePower(a.id, false);
    e.advanceTo(e.state.clock + 4000, 100000);
    expect(b.vrrp!.groups[0].state).toBe('ACTIVE');
    expect(http().received).toContain('service:1');
    for (const mode of ['udp', 'tcp'] as const) expect(dns(mode).status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('a parada só do DNS reduz a prioridade imediatamente e permite failover/failback', () => {
    const { e, a, b, dns } = topology();
    e.setDnsEnabled(a.id, false);
    expect(a.power).toBe(true);
    expect(a.vrrp!.groups[0].effectivePriority).toBe(70);
    validateSnapshot(e.snapshot());
    e.advanceTo(e.state.clock + 4000, 100000);
    expect(b.vrrp!.groups[0].state).toBe('ACTIVE');
    expect(dns('udp').status).toBe('success');
    e.setDnsEnabled(a.id, true);
    e.advanceTo(e.state.clock + 4000, 100000);
    expect(a.vrrp!.groups[0].state).toBe('ACTIVE');
    expect(dns('tcp').status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('o padrão sem accept mode continua recusando tráfego local no VIP', () => {
    const { e, a, client, http } = topology(false);
    expect(a.vrrp!.groups[0].state).toBe('ACTIVE');
    const id = e.ping(client.id, '192.0.2.1');
    e.advanceTo(e.state.clock + 500, 100000);
    expect(e.state.probes.find((p) => p.id === id)?.status).not.toBe('success');
    expect(http().received).toBe('');
    expect(e.state.events.some((v) => v.type === 'PACKET_DROPPED' && v.reason.includes('VRRP'))).toBe(true);
  });
  it('a troca de instância não inventa uma réplica da sessão TCP existente', () => {
    const { e, client, a } = topology();
    const id = e.openTcp(client.id, '192.0.2.1', 7, 'before|', false);
    e.advanceTo(e.state.clock + 500, 100000);
    const connection = client.tcpConnections!.find((c) => c.id === id)!;
    expect(connection.received).toBe('before|');
    e.setDevicePower(a.id, false);
    e.advanceTo(e.state.clock + 4000, 100000);
    e.writeTcp(client.id, id, 'after|');
    e.advanceTo(e.state.clock + 500, 100000);
    expect(connection.received).toBe('before|');
    expect(connection.state).toBe('RESET');
  });
  it('a falta de DNS nas duas instâncias não recebe resultado positivo', () => {
    const { e, a, b, dns } = topology();
    e.setDnsEnabled(a.id, false);
    e.setDnsEnabled(b.id, false);
    e.advanceTo(e.state.clock + 5000, 100000);
    expect(dns('udp').status).not.toBe('success');
    expect(() =>
      e.configureVrrp(a.id, {
        enabled: true,
        groups: vrrpConfigGroups(a).map((g) => ({
          ...g,
          track: [
            { service: 'http', decrement: 80 },
            { service: 'http', servicePort: 80, decrement: 80 },
          ],
        })),
      })
    ).toThrow('duplicado');
    validateSnapshot(e.snapshot());
  });
  it('o ativo acessa seu próprio VIP pela stack local', () => {
    const { e, a } = topology();
    const id = e.httpGet(a.id, '192.0.2.1');
    e.advanceTo(e.state.clock + 100, 100000);
    expect(a.tcpConnections!.find((c) => c.id === id)!.received).toContain('service:0');
    validateSnapshot(e.snapshot());
  });
  it('somente o ativo pode originar TCP com o VIP como endereço de origem', () => {
    const { e, a, b } = topology();
    const id = openTcp(
      e,
      a,
      b.interfaces[0].ip!,
      7,
      'vip-source',
      false,
      undefined,
      undefined,
      undefined,
      '192.0.2.1'
    );
    e.advanceTo(e.state.clock + 500, 100000);
    expect(a.tcpConnections!.find((c) => c.id === id)!.received).toBe('vip-source');
    expect(() =>
      openTcp(e, b, a.interfaces[0].ip!, 7, '', false, undefined, undefined, undefined, '192.0.2.1')
    ).toThrow('Origem TCP');
    validateSnapshot(e.snapshot());
  });
  it('restaura deterministicamente a eleição com serviço parado', () => {
    const { e, a } = topology();
    e.setDnsEnabled(a.id, false);
    const restored = new SimulationEngine(e.snapshot());
    const until = e.state.clock + 5000;
    e.advanceTo(until, 100000);
    restored.advanceTo(until, 100000);
    expect(restored.snapshot()).toEqual(e.snapshot());
  });
  it('o shell de servidor conserva accept mode e tracking HTTP por porta ao editar o grupo', () => {
    const { e, a } = topology();
    const cli = new TerminalSession(e, a.id);
    for (const command of [
      'enable',
      'conf t',
      'interface ' + a.interfaces[0].name,
      'vrrp 42 accept-mode',
      'vrrp 42 track service http:8080 decrement 60',
    ])
      expect(cli.execute(command), command).not.toMatch(/Erro|Error|%/);
    expect(inspectorTabIds(a)).toContain('vrrp');
    expect(vrrpConfigGroups(a)[0]).toMatchObject({ acceptMode: true });
    expect(vrrpConfigGroups(a)[0].track).toContainEqual({
      service: 'http',
      servicePort: 8080,
      decrement: 60,
    });
    const running = cli.execute('show running-config');
    expect(running).toContain('track service http:8080 decrement 60');
    expect(running).toContain('vrrp 42 accept-mode');
    expect(running).not.toContain('route undefined');
    expect(cli.execute('no vrrp 42 track service http:8080')).not.toMatch(/Erro|Error|%/);
    expect(vrrpConfigGroups(a)[0].track).toEqual([{ service: 'dns', decrement: 80 }]);
  });
  it('recusa tracking ambíguo, porta sem HTTP e tipo desconhecido', () => {
    expect(() => vrrpTrackSchema.parse({ service: 'dns', port: 'p0', decrement: 80 })).toThrow();
    expect(() => vrrpTrackSchema.parse({ service: 'dns', servicePort: 53, decrement: 80 })).toThrow();
    expect(() => vrrpTrackSchema.parse({ service: 'fake', decrement: 80 })).toThrow();
  });
  it('configurações compostas de broker/proxy/banco atualizam o tracking antes de salvar', () => {
    const { e, a } = topology();
    for (const service of ['mqtt', 'proxy', 'database'] as const) {
      const configure = (enabled: boolean) => {
        if (service === 'mqtt') e.configureBroker(a.id, { enabled, port: 1883 });
        if (service === 'proxy')
          e.configureProxy(a.id, {
            enabled,
            port: 8080,
            kind: 'load-balancer',
            algorithm: 'round-robin',
            backends: [{ address: '192.0.2.3', port: 80 }],
            allowedNetworks: [],
            healthIntervalMs: 1000,
          });
        if (service === 'database')
          e.configureDatabase(a.id, { enabled, port: 5432, key: 'test-service-key' });
      };
      configure(true);
      e.configureVrrp(a.id, {
        enabled: true,
        groups: vrrpConfigGroups(a).map((g) => ({ ...g, track: [{ service, decrement: 80 }] })),
      });
      expect(a.vrrp!.groups[0].effectivePriority).toBe(150);
      configure(false);
      expect(a.vrrp!.groups[0].effectivePriority).toBe(70);
      validateSnapshot(e.snapshot());
      configure(true);
      expect(a.vrrp!.groups[0].effectivePriority).toBe(150);
      validateSnapshot(e.snapshot());
    }
  });
});
