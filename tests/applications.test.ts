import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  decodeIpp,
  decodeMqtt,
  encodeMqtt,
} from '../packages/simulation-engine/src';
function lan() {
  const e = new SimulationEngine(),
    sw = e.addDevice('switch'),
    client = e.addDevice('pc'),
    device = e.addDevice('server'),
    a = e.addDevice('server'),
    b = e.addDevice('server');
  for (const [i, d] of [client, device, a, b].entries()) {
    Object.assign(d.interfaces[0], { ip: `10.0.0.${10 + i}`, prefix: 24 });
    e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + i });
  }
  return { e, client, device, a, b };
}
describe('Proxy, balanceador, IPP e MQTT', () => {
  it('distribui HTTP pelos backends e recupera indisponibilidade por health checks', () => {
    const { e, client, device, a, b } = lan();
    for (const [i, d] of [a, b].entries())
      e.configureTcpService(d.id, { kind: 'http', port: 80, enabled: true, body: 'backend ' + i });
    e.configureProxy(device.id, {
      kind: 'load-balancer',
      enabled: true,
      port: 8080,
      algorithm: 'round-robin',
      backends: [
        { address: '10.0.0.12', port: 80 },
        { address: '10.0.0.13', port: 80 },
      ],
      allowedNetworks: [],
      healthIntervalMs: 1000,
    });
    for (let i = 0; i < 2; i++) {
      e.httpGet(client.id, '10.0.0.11', 8080, '/');
      e.advanceTo(e.state.clock + 300);
    }
    expect(client.tcpConnections![0].received).toContain('backend 0');
    expect(client.tcpConnections![1].received).toContain('backend 1');
    b.power = false;
    e.advanceTo(5000);
    expect(device.proxy!.health[1].state).toBe('down');
    e.httpGet(client.id, '10.0.0.11', 8080, '/');
    e.advanceTo(5500);
    expect(client.tcpConnections!.at(-1)!.received).toContain('backend 0');
    b.power = true;
    e.advanceTo(10000);
    expect(device.proxy!.health[1].state).toBe('up');
    validateSnapshot(e.snapshot());
  });
  it('proxy abre conexão de saída e rejeita destino fora da lista', () => {
    const { e, client, device, a } = lan();
    e.configureTcpService(a.id, { kind: 'http', port: 80, enabled: true, body: 'via proxy' });
    e.configureProxy(device.id, {
      kind: 'proxy',
      enabled: true,
      port: 3128,
      algorithm: 'round-robin',
      backends: [],
      allowedNetworks: ['10.0.0.12'],
      healthIntervalMs: 5000,
    });
    e.openTcp(
      client.id,
      '10.0.0.11',
      3128,
      'GET http://10.0.0.12/ HTTP/1.1\r\nHost: 10.0.0.12\r\n\r\n',
      true
    );
    e.advanceTo(200);
    expect(client.tcpConnections![0].received).toContain('via proxy');
    expect(device.proxy!.requests[0].state).toBe('complete');
    e.openTcp(
      client.id,
      '10.0.0.11',
      3128,
      'GET http://10.0.0.13/ HTTP/1.1\r\nHost: 10.0.0.13\r\n\r\n',
      true
    );
    e.advanceTo(400);
    expect(client.tcpConnections![1].received).toContain('403');
    validateSnapshot(e.snapshot());
  });
  it('IPP recebe trabalho, imprime páginas, consulta e cancela com estado persistente', () => {
    const { e, client, device } = lan();
    e.configurePrinter(device.id, { enabled: true, port: 631, paper: 10, pagesPerMinute: 60 });
    e.submitPrint(client.id, '10.0.0.11', 'Relatório', 3);
    e.advanceTo(300);
    const body = client.tcpConnections![0].received.split('\r\n\r\n')[1];
    expect(decodeIpp(body)).toMatchObject({ code: 0, attributes: { 'job-id': 1 } });
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(4000);
    resumed.advanceTo(4000);
    expect(resumed.snapshot()).toEqual(e.snapshot());
    expect(device.printer!.jobs[0]).toMatchObject({ state: 'completed', printed: 3 });
    expect(device.printer!.paper).toBe(7);
    e.submitPrint(client.id, '10.0.0.11', 'Cancelar', 10);
    e.advanceTo(4200);
    e.submitPrint(client.id, '10.0.0.11', '', 1, '', 8, 2);
    e.advanceTo(4400);
    expect(device.printer!.jobs[1].state).toBe('cancelled');
    validateSnapshot(e.snapshot());
  });
  it('MQTT conecta, distribui tópicos/wildcards, retained e keepalive sem acumular buffer', () => {
    const { e, client, device, a } = lan();
    e.configureBroker(device.id, { enabled: true, port: 1883 });
    e.connectIot(client.id, '10.0.0.11', 'sensor', 1883, 2);
    e.connectIot(a.id, '10.0.0.11', 'painel', 1883, 2);
    e.advanceTo(100);
    expect(client.iot!.state).toBe('CONNECTED');
    e.subscribeIot(a.id, 'sala/+/temperatura');
    e.advanceTo(200);
    for (let i = 0; i < 100; i++) {
      e.publishIot(client.id, 'sala/1/temperatura', String(i), true);
      e.advanceTo(e.state.clock + 10);
    }
    expect(a.iot!.readings.at(-1)?.payload).toBe('99');
    expect(device.broker!.retained).toEqual([{ topic: 'sala/1/temperatura', payload: '99' }]);
    e.connectIot(a.id, '10.0.0.11', 'painel', 1883, 2);
    e.advanceTo(1400);
    e.subscribeIot(a.id, 'sala/#');
    e.advanceTo(1600);
    expect(a.iot!.readings[0].payload).toBe('99');
    e.advanceTo(10000);
    expect(a.iot!.state).toBe('CONNECTED');
    expect(a.tcpConnections!.at(-1)!.received.length).toBeLessThan(100);
    validateSnapshot(e.snapshot());
    expect(decodeMqtt(encodeMqtt({ type: 'CONNECT', clientId: 'x', keepAlive: 20 }).trim())).toEqual({
      type: 'CONNECT',
      clientId: 'x',
      keepAlive: 20,
    });
    expect(() => decodeMqtt('1000')).toThrow();
  });
});
