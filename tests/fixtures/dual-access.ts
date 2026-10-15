import { SimulationEngine, configureModbus } from '../../packages/simulation-engine/src';
export function dualAccessFixture() {
  const e = new SimulationEngine(),
    host = e.addDevice('pc'),
    spare = e.installNic(host.id),
    a = e.addDevice('switch'),
    b = e.addDevice('switch'),
    core = e.addDevice('switch'),
    server = e.addDevice('server');
  host.hostname = 'HMI-TESTE';
  a.hostname = 'SW-PRIMARY';
  b.hostname = 'SW-BACKUP';
  core.hostname = 'CORE-TESTE';
  server.hostname = 'PLC-TESTE';
  const connect = (device: string, port: string, remote: string, other: string) =>
    e.connect({ device, port }, { device: remote, port: other });
  connect(host.id, 'p0', a.id, 'p0');
  connect(host.id, spare.id, b.id, 'p0');
  connect(a.id, 'p1', core.id, 'p0');
  connect(b.id, 'p1', core.id, 'p1');
  connect(server.id, 'p0', core.id, 'p2');
  Object.assign(host.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
  Object.assign(server.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
  configureModbus(e, server, { enabled: true, registers: [1234, 65535] });
  return { snapshot: e.snapshot(), host: host.id, spare: spare.id };
}
