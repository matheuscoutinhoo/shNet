import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  TerminalSession,
  dot1xConfig,
  supplicantConfig,
  aaaServerConfig,
} from '../packages/simulation-engine/src';
function lab() {
  const e = new SimulationEngine(makeTemplate('aaa')),
    pc = e.state.devices.find((d) => d.type === 'pc')!,
    sw = e.state.devices.find((d) => d.type === 'switch')!,
    server = e.state.devices.find((d) => d.type === 'server')!;
  return { e, pc, sw, server, p: sw.interfaces[0], s: pc.interfaces[0] };
}
describe('AAA e controlled port usam a rede simulada', () => {
  it('bloqueia dados antes de EAPOL/RADIUS e autoriza MAC/VLAN/HTTP após Access-Accept', () => {
    const { e, pc, sw, p, s } = lab();
    e.ping(pc.id, '10.20.0.20');
    e.advanceTo(100);
    expect(e.state.events.some((ev) => ev.type === 'DOT1X_DENY')).toBe(true);
    expect(sw.macTable.some((m) => m.mac === s.mac)).toBe(false);
    e.advanceTo(2000);
    expect(p.dot1x?.phase).toBe('authorized');
    expect(s.supplicant?.phase).toBe('authorized');
    expect(p.accessVlan).toBe(20);
    const id = e.httpGet(pc.id, '10.20.0.20');
    e.advanceTo(3000);
    expect(pc.tcpConnections?.find((c) => c.id === id)?.received).toContain('HTTP após autorização');
    expect(e.state.events.some((ev) => ev.frame?.eapol?.type === 'response')).toBe(true);
    expect(
      e.state.events.some(
        (ev) =>
          ev.frame?.packet?.protocol === 'UDP' &&
          ev.frame.packet.payload.protocol === 'RADIUS' &&
          ev.frame.packet.destinationPort === 1812
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('senha errada, shared secret errado e VLAN inexistente nunca liberam a porta', () => {
    const { e, pc, sw, p, s, server } = lab();
    e.configureSupplicant(pc.id, s.id, { ...supplicantConfig(s), password: 'errada' });
    e.advanceTo(2000);
    expect(s.supplicant?.phase).toBe('rejected');
    expect(p.dot1x?.phase).toBe('unauthorized');
    expect(p.accessVlan).toBe(1);
    e.configureSupplicant(pc.id, s.id, { ...supplicantConfig(s), password: 'rede123' });
    e.configureDot1x(sw.id, p.id, { ...dot1xConfig(p), key: 'outra-chave' });
    e.advanceTo(16000);
    expect(p.dot1x?.phase).not.toBe('authorized');
    expect(sw.aaaQueries?.some((q) => q.status === 'timeout')).toBe(true);
    e.configureDot1x(sw.id, p.id, { ...dot1xConfig(p), key: 'rede-demo' });
    const config = aaaServerConfig(server);
    config.users[0].vlan = 30;
    e.configureAaaServer(server.id, config);
    e.configureSupplicant(pc.id, s.id, supplicantConfig(s));
    e.advanceTo(18000);
    expect(p.dot1x?.phase).toBe('unauthorized');
    expect(p.accessVlan).toBe(1);
    validateSnapshot(e.snapshot());
  });
  it('falha física retira autorização e reautenticação aplica nova política do servidor', () => {
    const { e, pc, sw, p, s, server } = lab();
    e.advanceTo(2000);
    const cable = e.state.links.find((l) => l.a.device === pc.id || l.b.device === pc.id)!;
    cable.up = false;
    e.advanceTo(2100);
    expect(p.dot1x?.phase).toBe('unauthorized');
    expect(p.accessVlan).toBe(1);
    cable.up = true;
    e.advanceTo(4000);
    expect(p.dot1x?.phase).toBe('authorized');
    const config = aaaServerConfig(server);
    config.users[0].enabled = false;
    e.configureAaaServer(server.id, config);
    e.advanceTo(66000);
    expect(p.dot1x?.phase).not.toBe('authorized');
    expect(s.supplicant?.phase).not.toBe('authorized');
    validateSnapshot(e.snapshot());
    e.configureDot1x(sw.id, p.id, { ...dot1xConfig(p), enabled: false });
    expect(p.accessVlan).toBe(1);
    validateSnapshot(e.snapshot());
  });
  it('TACACS+ transporta login/privilégio em TCP e enforcement de CLI depende da resposta', () => {
    const { e, sw } = lab();
    e.configureAaaClient(sw.id, { ...sw.aaaClient, method: 'tacacs', enforceCli: true });
    const cli = new TerminalSession(e, sw.id);
    cli.execute('enable');
    expect(cli.execute('configure terminal')).toContain('privilégio 15');
    expect(cli.execute('aaa login aluno rede123')).toContain('pending');
    e.advanceTo(2000);
    expect(e.device(sw.id).networkAuth?.privilege).toBe(1);
    expect(cli.execute('configure terminal')).toContain('privilégio 15');
    expect(cli.execute('aaa login admin rede-admin')).toContain('pending');
    e.advanceTo(4000);
    expect(e.device(sw.id).networkAuth?.privilege).toBe(15);
    expect(cli.execute('configure terminal')).toBe('OK');
    expect(cli.execute('hostname SW-ADMIN')).toBe('OK');
    expect(cli.history.join()).not.toContain('rede-admin');
    expect(
      e.state.events.some(
        (ev) =>
          ev.frame?.packet?.protocol === 'TCP' &&
          ev.frame.packet.destinationPort === 49 &&
          !!ev.frame.packet.data
      )
    ).toBe(true);
    expect(cli.execute('show running-config')).not.toContain('rede-demo');
    expect(cli.execute('show aaa')).not.toContain('rede123');
    validateSnapshot(e.snapshot());
    cli.execute('aaa logout');
    expect(cli.execute('hostname PROIBIDO')).toContain('privilégio 15');
  });
  it('RADIUS login é correlacionado, rejeita credenciais e sofre ACL real', () => {
    const { e, sw } = lab();
    e.configureAaaClient(sw.id, { ...sw.aaaClient, method: 'radius' });
    const id = e.loginNetwork(sw.id, 'admin', 'rede-admin');
    e.advanceTo(1000);
    expect(sw.aaaQueries?.find((q) => q.id === id)?.status).toBe('accepted');
    e.loginNetwork(sw.id, 'admin', 'errada');
    e.advanceTo(2000);
    expect(e.device(sw.id).networkAuth).toBeUndefined();
    e.configureAcl(sw.id, { name: 'RADIUS-BLOCK', rules: [] });
    e.bindAcl(sw.id, 'p1', 'out', 'RADIUS-BLOCK');
    const failed = e.loginNetwork(sw.id, 'admin', 'rede-admin');
    e.advanceTo(12000);
    expect(sw.aaaQueries?.find((q) => q.id === failed)?.status).toBe('timeout');
    validateSnapshot(e.snapshot());
  });
  it('save/load no meio de EAPOL/RADIUS/TACACS preserva resultado e rejeita estado forjado', () => {
    const { e, sw } = lab();
    e.loginNetwork(sw.id, 'admin', 'rede-admin');
    e.advanceTo(1003);
    const s = JSON.parse(JSON.stringify(e.snapshot())),
      a = new SimulationEngine(s),
      b = new SimulationEngine(s);
    a.advanceTo(3000);
    b.advanceTo(3000);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.device(sw.id).interfaces[0].dot1x?.phase).toBe('authorized');
    expect(a.device(sw.id).networkAuth?.privilege).toBe(15);
    const bad = a.snapshot();
    bad.devices.find((d) => d.id === sw.id)!.interfaces[0].dot1x!.mac = '00:00:00:00:00:99';
    expect(() => validateSnapshot(bad)).toThrow('802.1X');
    const timer = a.snapshot();
    timer.queue = timer.queue.filter((q) => q.action.kind !== 'dot1x-tick');
    expect(() => validateSnapshot(timer)).toThrow('Timer 802.1X');
  });

  it('autoriza comandos por política e registra start, comando e stop em mensagens TACACS+', () => {
    const { e, sw, server } = lab(),
      config = aaaServerConfig(server);
    config.users.find((u) => u.username === 'admin')!.commands = ['configure terminal', 'hostname'];
    e.configureAaaServer(server.id, config);
    e.configureAaaClient(sw.id, { ...sw.aaaClient, method: 'tacacs', enforceCli: true });
    e.loginNetwork(sw.id, 'admin', 'rede-admin');
    e.advanceTo(2000);
    const cli = new TerminalSession(e, sw.id);
    cli.execute('enable');
    expect(cli.execute('configure terminal')).toBe('OK');
    expect(cli.execute('hostname AUTORIZADO')).toBe('OK');
    expect(cli.execute('ip route 10.99.0.0 255.255.255.0 192.0.2.2')).toContain('comando não autorizado');
    cli.execute('aaa logout');
    e.advanceTo(3000);
    const audit = e.device(server.id).aaaServer!.accounting;
    expect(audit.some((a) => a.stage === 'start' && a.username === 'admin')).toBe(true);
    expect(audit.some((a) => a.stage === 'command' && a.command === 'hostname AUTORIZADO')).toBe(true);
    expect(audit.some((a) => a.stage === 'stop' && a.username === 'admin')).toBe(true);
    expect(audit.some((a) => a.command?.includes('rede-admin'))).toBe(false);
    validateSnapshot(e.snapshot());
  });
});
