import { SimulationEngine } from '../../packages/simulation-engine/src';
import { dhcpHaTemplate } from '../../packages/simulation-engine/src/dhcp-ha-template';

export function dhcpHaFixture(paired = true, leaseMs = 16000) {
  const e = new SimulationEngine(dhcpHaTemplate(paired, leaseMs)),
    a = e.state.devices.find((d) => d.hostname === 'DHCP-A')!,
    b = e.state.devices.find((d) => d.hostname === 'DHCP-B')!,
    sw = e.state.devices.find((d) => d.hostname === 'DHCP-ACCESS')!,
    clients = e.state.devices.filter((d) => d.type === 'pc'),
    sync = e.state.links.find((l) => l.a.device === a.id && l.b.device === b.id)!,
    portA = sync.a.port,
    portB = sync.b.port;
  return { e, a, b, sw, clients, sync, portA, portB };
}
