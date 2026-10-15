import { SimulationEngine } from './core/engine';

export function dhcpHaTemplate(paired = true, leaseMs = 16000) {
  const e = new SimulationEngine(),
    a = e.addDevice('server', { x: 540, y: 100 }),
    b = e.addDevice('server', { x: 540, y: 390 }),
    sw = e.addDevice('switch', { x: 290, y: 240 }),
    clients = [e.addDevice('pc', { x: 60, y: 100 }), e.addDevice('pc', { x: 60, y: 390 })];
  a.hostname = 'DHCP-A';
  b.hostname = 'DHCP-B';
  sw.hostname = 'DHCP-ACCESS';
  for (const [i, d] of [a, b].entries()) {
    Object.assign(d.interfaces[0], { ip: '192.0.2.' + (2 + i), prefix: 24 });
    e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + i });
    e.configureDhcpPool(d.id, {
      name: 'LAN',
      port: 'p0',
      network: '192.0.2.0',
      prefix: 24,
      start: '192.0.2.100',
      end: '192.0.2.110',
      dns: [],
      leaseMs,
      excluded: [],
    });
  }
  const portA = e.installNic(a.id).id,
    portB = e.installNic(b.id).id;
  e.connect({ device: a.id, port: portA }, { device: b.id, port: portB }, 'copper', { latency: 2 });
  for (const [i, d] of clients.entries()) {
    d.hostname = 'DHCP-CLIENT-' + (i + 1);
    e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + (2 + i) });
  }
  if (paired) e.configureDhcpHaPair(a.id, b.id, { portA, portB });
  e.state.notes =
    'DHCP ativo/reserva com réplica confirmada por cabo dedicado. Solicite DHCP nos clientes e avance a simulação. A promoção administrativa no painel DHCP desliga o antigo ativo; não há eleição automática. T1 aponta para o servidor antigo e T2 permite renovar com o novo, mantendo o endereço. Ao retornar, o servidor antigo continua reserva e recebe o banco atual. O switch de acesso é único neste modelo: este ensaio isola a HA do serviço. O canal de réplica é simulado, sem codec de fabricante para PCAP.';
  return e.snapshot();
}
