import { SimulationEngine, makeTemplate, validateSnapshot } from '../../packages/simulation-engine/src';

export function syslogCaptureFixture() {
  const e = new SimulationEngine(makeTemplate('tcp')),
    client = e.state.devices.find((d) => d.type === 'pc')!,
    router = e.state.devices.find((d) => d.type === 'router')!,
    collector = e.state.devices.find((d) => d.type === 'server')!,
    server = collector.interfaces[0].ip!;
  e.setSyslogEnabled(collector.id, true);
  e.configureSyslog(client.id, { enabled: true, server, automatic: false, severity: 6, facility: 23 });
  e.sendSyslog(client.id, 'Rede em operação 🌐 — temperatura 23 °C', 5);
  e.advanceTo(200);
  e.sendSyslog(client.id, 'Debug filtrado', 7);
  e.configureAcl(router.id, { name: 'BLOCK_LOG', rules: [] });
  e.bindAcl(router.id, 'p0', 'in', 'BLOCK_LOG');
  e.sendSyslog(client.id, 'Negado pela ACL', 3);
  e.advanceTo(400);
  e.bindAcl(router.id, 'p0', 'in', undefined);
  const link = e.state.links.find((l) => [l.a, l.b].some((p) => p.device === client.id))!;
  link.loss = 1;
  e.sendSyslog(client.id, 'Perdido no enlace', 3);
  e.advanceTo(600);
  link.loss = 0;
  e.setSyslogEnabled(collector.id, false);
  e.sendSyslog(client.id, 'Coletor indisponível', 3);
  e.advanceTo(800);
  e.setSyslogEnabled(collector.id, true);
  e.configureSyslog(client.id, { enabled: true, server, automatic: true, severity: 4, facility: 16 });
  e.emit('LINK_DOWN', client.id, 'Falha didática para correlação do evento.');
  e.advanceTo(1000);
  const checkpoint = e.snapshot(),
    restored = new SimulationEngine(checkpoint);
  e.sendSyslog(client.id, 'Retomada do laboratório', 4);
  restored.sendSyslog(client.id, 'Retomada do laboratório', 4);
  e.advanceTo(1200);
  restored.advanceTo(1200);
  validateSnapshot(e.snapshot());
  return { engine: e, restored, client, router, collector, checkpoint };
}
