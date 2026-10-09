import { describe, it, expect } from 'vitest';
import { SimulationEngine, makeTemplate, validateSnapshot } from '../packages/simulation-engine/src';
function lab() {
  const e = new SimulationEngine(makeTemplate('routed')),
    pc = e.state.devices[0],
    r = e.state.devices.find((d) => d.type === 'router')!;
  e.configureRemote(r.id, {
    enabled: true,
    netconf: true,
    restconf: true,
    key: 'remote-key',
    users: [
      { username: 'admin', password: 'rede-admin', privilege: 15 },
      { username: 'reader', password: 'rede-read', privilege: 1 },
    ],
    clients: [],
  });
  const cfg = {
    target: r.interfaces[0].ip!,
    protocol: 'netconf',
    username: 'admin',
    password: 'rede-admin',
    key: 'remote-key',
  };
  const rpc = (
    operation: string,
    extra: Record<string, unknown> = {},
    credentials: Record<string, unknown> = {}
  ) => {
    const id = e.requestRemote(pc.id, { ...cfg, operation, ...extra, ...credentials });
    e.advanceTo(e.state.clock + 500);
    return pc.remoteQueries!.find((q) => q.id === id)!;
  };
  return { e, pc, r, cfg, rpc };
}
describe('NETCONF/RESTCONF e automação sobre TCP simulado', () => {
  it('automação local preserva referências durante validação e patch altera conectividade HTTP', () => {
    const { e, r, pc, rpc, cfg } = lab();
    e.configureTcpService(e.state.devices.find((d) => d.type === 'server')!.id, {
      port: 80,
      kind: 'http',
      enabled: true,
      body: 'rede gerenciada',
    });
    const local = e.runAutomation(r.id, {
      name: 'loopback',
      username: cfg.username,
      password: cfg.password,
      key: cfg.key,
      steps: [
        {
          target: cfg.target,
          protocol: 'netconf',
          operation: 'edit-config',
          datastore: 'candidate',
          patch: { hostname: 'R-LOCAL' },
        },
        { target: cfg.target, protocol: 'netconf', operation: 'commit' },
      ],
    });
    e.advanceTo(1000);
    expect(r.automationJobs?.find((j) => j.id === local)?.status).toBe('success');
    const success = e.httpGet(pc.id, '192.168.20.10');
    e.advanceTo(2000);
    expect(pc.tcpConnections?.find((c) => c.id === success)?.received).toContain('rede gerenciada');
    expect(
      rpc('patch', { patch: { interfaces: [{ id: 'p1', adminUp: false }] } }, { protocol: 'restconf' }).status
    ).toBe('success');
    const failed = e.httpGet(pc.id, '192.168.20.10');
    e.advanceTo(e.state.clock + 12000);
    expect(pc.tcpConnections?.find((c) => c.id === failed)?.received).toBe('');
    expect(
      rpc('patch', { patch: { interfaces: [{ id: 'p1', adminUp: true }] } }, { protocol: 'restconf' }).status
    ).toBe('success');
    const recovered = e.httpGet(pc.id, '192.168.20.10');
    e.advanceTo(e.state.clock + 1000);
    expect(pc.tcpConnections?.find((c) => c.id === recovered)?.received).toContain('rede gerenciada');
    validateSnapshot(e.snapshot());
  });
  it('hello/get separam config de estado e candidate só afeta running após validate/commit', () => {
    const { e, r, rpc } = lab();
    expect(rpc('hello').response?.data).toContain('candidate');
    expect(JSON.parse(rpc('get').response!.data!).interfaces[0].rx).toBeGreaterThan(0);
    expect(JSON.parse(rpc('get-config').response!.data!).interfaces[0].rx).toBeUndefined();
    const edit = rpc('edit-config', {
      datastore: 'candidate',
      patch: { hostname: 'R-AUTOMATED', interfaces: [{ id: 'p1', description: 'rede de aplicação' }] },
    });
    expect(edit.status).toBe('success');
    expect(r.hostname).toBe('R-EDGE-01');
    expect(rpc('get-config', { datastore: 'candidate' }).response?.data).toContain('R-AUTOMATED');
    expect(rpc('validate').status).toBe('success');
    expect(rpc('commit').status).toBe('success');
    expect(r.hostname).toBe('R-AUTOMATED');
    expect(r.interfaces[1].description).toBe('rede de aplicação');
    expect(r.remoteManagement?.commits).toBe(1);
    expect(
      e.state.events.some(
        (ev) =>
          ev.frame?.packet?.protocol === 'TCP' &&
          ev.frame.packet.destinationPort === 830 &&
          !!ev.frame.packet.data
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('RESTCONF patch muda interface, bloqueia por revisão/permissão e rejeita edição inválida atomicamente', () => {
    const { e, r, rpc } = lab();
    const before = r.interfaces[1].ip;
    expect(() =>
      rpc(
        'patch',
        { patch: { hostname: 'NAO-APLICAR', interfaces: [{ id: 'p1', ip: '999.1.2.3' }] } },
        { protocol: 'restconf' }
      )
    ).toThrow('IPv4');
    expect(r.hostname).toBe('R-EDGE-01');
    expect(r.interfaces[1].ip).toBe(before);
    expect(
      rpc(
        'patch',
        { ifMatch: 0, patch: { interfaces: [{ id: 'p1', adminUp: false }] } },
        { protocol: 'restconf' }
      ).status
    ).toBe('success');
    expect(r.interfaces[1].adminUp).toBe(false);
    expect(
      rpc('patch', { ifMatch: 0, patch: { hostname: 'STALE' } }, { protocol: 'restconf' }).response?.code
    ).toBe(409);
    expect(
      rpc(
        'patch',
        { patch: { hostname: 'DENIED' } },
        { protocol: 'restconf', username: 'reader', password: 'rede-read' }
      ).response?.code
    ).toBe(403);
    expect(rpc('get', {}, { username: 'reader', password: 'rede-read' }).status).toBe('success');
    const illegal = rpc(
      'patch',
      {
        patch: {
          hostname: 'NAO-APLICAR',
          routesAdd: [{ network: '192.0.2.5', prefix: 24, nextHop: '192.168.10.2', metric: 1 }],
        },
      },
      { protocol: 'restconf' }
    );
    expect(illegal.response?.code).toBe(400);
    expect(r.hostname).toBe('R-EDGE-01');
    validateSnapshot(e.snapshot());
  });
  it('lock e colisão de candidate impedem alterações concorrentes; credencial/ACL causam timeout', () => {
    const { e, r, pc, rpc } = lab();
    expect(rpc('lock').status).toBe('success');
    const other = e.addDevice('pc');
    Object.assign(other.interfaces[0], { ip: '192.168.10.22', prefix: 24 });
    const sw = e.state.devices.find((d) => d.type === 'switch')!;
    e.connect({ device: other.id, port: 'p0' }, { device: sw.id, port: 'p2' });
    const id = e.requestRemote(other.id, {
      target: r.interfaces[0].ip,
      protocol: 'netconf',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      operation: 'edit-config',
      datastore: 'candidate',
      patch: { hostname: 'OTHER' },
    });
    e.advanceTo(e.state.clock + 500);
    expect(other.remoteQueries?.find((q) => q.id === id)?.response?.code).toBe(409);
    expect(rpc('edit-config', { datastore: 'candidate', patch: { hostname: 'CANDIDATE' } }).status).toBe(
      'success'
    );
    r.interfaces[2].description = 'alteração manual';
    expect(rpc('commit').response?.code).toBe(409);
    expect(rpc('discard-changes').status).toBe('success');
    expect(rpc('unlock').status).toBe('success');
    const bad = e.requestRemote(pc.id, {
      target: r.interfaces[0].ip,
      protocol: 'netconf',
      username: 'admin',
      password: 'errada',
      key: 'remote-key',
      operation: 'get',
    });
    e.advanceTo(e.state.clock + 11000);
    expect(pc.remoteQueries?.find((q) => q.id === bad)?.status).toBe('timeout');
    e.configureAcl(r.id, { name: 'NO-REMOTE', rules: [] });
    e.bindAcl(r.id, 'p0', 'in', 'NO-REMOTE');
    const blocked = e.requestRemote(pc.id, {
      target: r.interfaces[0].ip,
      protocol: 'netconf',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      operation: 'get',
    });
    e.advanceTo(e.state.clock + 11000);
    expect(pc.remoteQueries?.find((q) => q.id === blocked)?.status).toBe('timeout');
    validateSnapshot(e.snapshot());
  });
  it('job executa RPCs em sequência, aplica rota/hostname e restaura tráfego pendente', () => {
    const { e, pc, r, cfg } = lab();
    const job = e.runAutomation(pc.id, {
      name: 'configurar borda',
      username: cfg.username,
      password: cfg.password,
      key: cfg.key,
      steps: [
        {
          target: cfg.target,
          protocol: 'netconf',
          operation: 'edit-config',
          datastore: 'candidate',
          patch: {
            hostname: 'R-BATCH',
            routesAdd: [{ network: '203.0.113.0', prefix: 24, nextHop: '192.168.20.20', metric: 1 }],
          },
        },
        { target: cfg.target, protocol: 'netconf', operation: 'validate' },
        { target: cfg.target, protocol: 'netconf', operation: 'commit' },
        { target: cfg.target, protocol: 'restconf', operation: 'get' },
      ],
    });
    e.advanceTo(3);
    const restored = new SimulationEngine(JSON.parse(JSON.stringify(e.snapshot())));
    e.advanceTo(3000);
    restored.advanceTo(3000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(pc.automationJobs?.find((j) => j.id === job)?.status).toBe('success');
    expect(r.hostname).toBe('R-BATCH');
    expect(r.routes).toHaveLength(1);
    validateSnapshot(e.snapshot());
  });
  it('save/load com candidate conserva isolamento e rejeita referência/timer adulterados', () => {
    const { e, r, pc, rpc } = lab();
    expect(rpc('edit-config', { datastore: 'candidate', patch: { hostname: 'LATER' } }).status).toBe(
      'success'
    );
    const restored = new SimulationEngine(JSON.parse(JSON.stringify(e.snapshot())));
    expect(restored.device(r.id).hostname).toBe('R-EDGE-01');
    expect(restored.device(r.id).remoteManagement?.candidate?.config.hostname).toBe('LATER');
    const bad = e.snapshot();
    bad.devices.find((d) => d.id === r.id)!.remoteManagement!.candidate!.config.interfaces[0].id = 'ghost';
    expect(() => validateSnapshot(bad)).toThrow('Candidate');
    e.requestRemote(pc.id, {
      target: r.interfaces[0].ip,
      protocol: 'netconf',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      operation: 'get',
    });
    const timers = e.snapshot();
    timers.queue = timers.queue.filter((q) => q.action.kind !== 'remote-timeout');
    expect(() => validateSnapshot(timers)).toThrow('NETCONF');
  });

  it('negocia NETCONF 1.1, mantém startup e valida confiança TLS antes do RPC', () => {
    const { e, pc, r, cfg, rpc } = lab();
    const hello = rpc('hello');
    expect(hello.status).toBe('success');
    expect(hello.transport?.negotiated).toBe('1.1');
    expect(rpc('copy-config', { source: 'running', datastore: 'startup' }).status).toBe('success');
    expect(rpc('edit-config', { datastore: 'candidate', patch: { hostname: 'R-CANDIDATE' } }).status).toBe(
      'success'
    );
    expect(r.hostname).not.toBe('R-CANDIDATE');
    expect(rpc('commit').status).toBe('success');
    expect(JSON.parse(rpc('get-config', { datastore: 'startup' }).response!.data!).hostname).not.toBe(
      'R-CANDIDATE'
    );
    const bad = e.requestRemote(pc.id, {
      ...cfg,
      operation: 'get',
      tls: { serverName: 'wrong.campus', trust: [] },
    });
    e.advanceTo(e.state.clock + 11000);
    expect(pc.remoteQueries!.find((q) => q.id === bad)?.status).toBe('timeout');
    const wire = e.state.events
      .filter(
        (v) => v.frame?.packet?.protocol === 'TCP' && [830, 443].includes(v.frame.packet.destinationPort)
      )
      .map((v) => (v.frame?.packet?.protocol === 'TCP' ? v.frame.packet.data : ''))
      .join('');
    expect(wire).not.toContain('rede-admin');
    expect(wire).not.toContain('R-CANDIDATE');
    validateSnapshot(e.snapshot());
  });
  it('retoma handshake TLS e usa RESTCONF com recurso e revisão', () => {
    const { e, pc, cfg, rpc, r } = lab();
    e.requestRemote(pc.id, { ...cfg, operation: 'get-config' });
    e.advanceTo(10);
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(1000);
    resumed.advanceTo(1000);
    expect(resumed.snapshot()).toEqual(e.snapshot());
    const hostname = rpc(
      'get-config',
      { resource: '/restconf/data/shlab:network/hostname' },
      { protocol: 'restconf' }
    );
    expect(JSON.parse(hostname.response!.data!).hostname).toBe(r.hostname);
    const revision = hostname.response!.revision;
    expect(
      rpc(
        'patch',
        {
          resource: '/restconf/data/shlab:network/hostname',
          ifMatch: revision,
          patch: { hostname: 'R-RESTCONF' },
        },
        { protocol: 'restconf' }
      ).status
    ).toBe('success');
    expect(r.hostname).toBe('R-RESTCONF');
    expect(
      rpc('patch', { ifMatch: revision, patch: { hostname: 'STALE' } }, { protocol: 'restconf' }).status
    ).toBe('error');
    expect(r.hostname).toBe('R-RESTCONF');
    validateSnapshot(e.snapshot());
  });
});
