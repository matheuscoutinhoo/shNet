import { SimulationEngine } from '../../packages/simulation-engine/src';
import { dhcpHaTemplate } from '../../packages/simulation-engine/src/dhcp-ha-template';
import { sendDhcp } from '../../packages/simulation-engine/src/protocols/dhcp-wire';

export function dhcpCaptureFixtures() {
  const local = new SimulationEngine(dhcpHaTemplate(false));
  const servers = local.state.devices.filter((d) => d.dhcpServer),
    clients = local.state.devices.filter((d) => d.type === 'pc');
  for (const d of servers)
    local.configureDhcpPool(d.id, {
      ...d.dhcpServer!.pools[0],
      dns: Array.from({ length: 8 }, (_, i) => '198.51.100.' + (i + 1)),
    });
  local.configureDhcpHaPair(servers[0].id, servers[1].id, { portA: 'nic0', portB: 'nic0' });
  Object.assign(clients[1].interfaces[0], { ip: '192.0.2.100', prefix: 24 });
  local.setDhcpConflictDetection(clients[0].id, 'p0', true);
  local.requestDhcp(clients[0].id, 'p0');
  local.advanceTo(8000);
  sendDhcp(
    local,
    clients[0],
    clients[0].interfaces[0],
    {
      type: 'request',
      transactionId: local.id('dhcp'),
      clientMac: clients[0].interfaces[0].mac,
      clientIp: '0.0.0.0',
      requestedIp: '192.0.2.240',
      server: '192.0.2.2',
    },
    '255.255.255.255',
    'Teste negativo: endereço solicitado fora do pool.'
  );
  local.advanceTo(8500);
  local.releaseDhcp(clients[0].id, 'p0');
  local.advanceTo(9000);
  local.requestDhcp(clients[0].id, 'p0');
  local.advanceTo(12500);

  const failover = new SimulationEngine(dhcpHaTemplate()),
    a = failover.state.devices.find((d) => d.hostname === 'DHCP-A')!,
    b = failover.state.devices.find((d) => d.hostname === 'DHCP-B')!,
    pc = failover.state.devices.find((d) => d.type === 'pc')!;
  failover.requestDhcp(pc.id, 'p0');
  failover.advanceTo(500);
  failover.renewDhcp(pc.id, 'p0');
  failover.advanceTo(1000);
  failover.promoteDhcpHa(b.id);
  failover.advanceTo(20000);

  const relay = new SimulationEngine(dhcpHaTemplate(false)),
    pair = relay.state.devices.filter((d) => d.dhcpServer),
    client = relay.state.devices.find((d) => d.type === 'pc')!,
    sw = relay.state.devices.find((d) => d.type === 'switch')!,
    router = relay.addDevice('router');
  router.hostname = 'DHCP-RELAY';
  Object.assign(router.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
  Object.assign(router.interfaces[1], { ip: '192.0.2.1', prefix: 24 });
  relay.removeLink(relay.state.links.find((l) => [l.a, l.b].some((p) => p.device === client.id))!.id);
  relay.connect({ device: client.id, port: 'p0' }, { device: router.id, port: 'p0' });
  relay.connect({ device: router.id, port: 'p1' }, { device: sw.id, port: 'p4' });
  for (const d of pair) {
    d.gateway = '192.0.2.1';
    relay.configureDhcpPool(d.id, {
      ...d.dhcpServer!.pools[0],
      network: '10.0.0.0',
      start: '10.0.0.100',
      end: '10.0.0.110',
      gateway: '10.0.0.1',
      relayAddress: '10.0.0.1',
    });
  }
  relay.configureDhcpRelay(router.id, 'p0', ['192.0.2.2', '192.0.2.3']);
  relay.configureDhcpHaPair(pair[0].id, pair[1].id, { portA: 'nic0', portB: 'nic0' });
  relay.requestDhcp(client.id, 'p0');
  relay.advanceTo(500);
  relay.renewDhcp(client.id, 'p0');
  relay.advanceTo(1000);
  relay.promoteDhcpHa(pair[1].id);
  relay.advanceTo(20000);
  return { local, failover, relay, primary: a.id };
}
