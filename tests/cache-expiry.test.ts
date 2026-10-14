import { expect, it } from 'vitest';
import { SimulationEngine, makeTemplate } from '@shlab/engine';
import { expireDeviceCaches, noteCacheExpiry } from '../packages/simulation-engine/src/core/cache-expiry';
import { traceConnection } from '../packages/simulation-engine/src/core/trace-index';
it('expira no prazo, reconhece substituição de arrays e edições antes de nova fronteira pública', () => {
  const e = new SimulationEngine(makeTemplate('lan')),
    d = e.state.devices.find((d) => d.type === 'pc')!;
  d.arpTable = [{ ip: '192.168.10.20', mac: '02:00:00:00:00:02', port: 'p0', expires: 100 }];
  const initial = d.arpTable;
  e.state.clock = 50;
  expireDeviceCaches(e.state);
  expect(d.arpTable).toBe(initial);
  e.state.clock = 100;
  expireDeviceCaches(e.state);
  expect(d.arpTable).toEqual([]);
  d.arpTable = [{ ip: '192.168.10.20', mac: '02:00:00:00:00:02', port: 'p0', expires: 500 }];
  noteCacheExpiry(e.state, 500);
  expireDeviceCaches(e.state);
  d.arpTable[0].expires = 50;
  e.schedule(1, { kind: 'probe-timeout', probeId: 'missing-probe' });
  e.step();
  expect(d.arpTable).toEqual([]);
});
it('um novo prazo aprendido antecipa a expiração sem varrer toda a rede a cada evento', () => {
  const e = new SimulationEngine(makeTemplate('lan')),
    d = e.state.devices.find((d) => d.type === 'pc')!;
  expireDeviceCaches(e.state);
  d.arpTable.push({ ip: '192.168.10.20', mac: '02:00:00:00:00:02', port: 'p0', expires: 10 });
  noteCacheExpiry(e.state, 10);
  e.state.clock = 10;
  expireDeviceCaches(e.state);
  expect(d.arpTable).toEqual([]);
});
it('índice de captura conserva mudanças de serviço e descarta conexões removidas', () => {
  const e = new SimulationEngine(makeTemplate('lan')),
    client = e.state.devices.find((d) => d.type === 'pc')!;
  const id = e.openTcp(client.id, '192.168.10.20', 7, 'hello', false);
  const connection = client.tcpConnections!.find((c) => c.id === id)!;
  expect(traceConnection(e.state, id)).toBe(connection);
  connection.service = 'http';
  expect(traceConnection(e.state, id)?.service).toBe('http');
  client.tcpConnections = [];
  expect(traceConnection(e.state, id)).toBeUndefined();
});
