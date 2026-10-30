import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import { interfaceOperational } from '../protocols/layer3';
import { resolveDefaultRoutes, resolveRoute, subnet } from '../protocols/ipv4';
import { ripRoutes } from '../protocols/rip';

export const interfaceName = (name: string) =>
  name
    .replace(/\s/g, '')
    .replace(/^gigabitethernet/i, 'Gi')
    .replace(/^tengigabitethernet/i, 'Te')
    .replace(/^fortygigabitethernet/i, 'Fo')
    .replace(/^hundredgigabitethernet/i, 'Hu')
    .replace(/^port-channel/i, 'Port-channel');

export function interfaceStatus(e: SimulationEngine, d: Device, p: NetworkInterface) {
  return !p.adminUp
    ? 'administratively down'
    : p.errDisabled
      ? 'err-disabled'
      : interfaceOperational(e.state, d, p)
        ? 'up'
        : 'down';
}
const shortName = (name: string) => name.replace(/^Vlan/, 'Vl').replace(/^Port-channel/, 'Po').replace(/^Loopback/, 'Lo');
function portType(p: NetworkInterface) {
  if (p.aggregate) return '';
  if (p.media === 'rj45') return p.speed >= 10000 ? '100/1000/2.5G/5G/10GBaseTX' : '10/100/1000BaseTX';
  const mode = p.transceiver === 'multi-mode' ? 'S' : p.transceiver === 'dac' ? 'CU' : 'L';
  if (p.media === 'qsfp') return p.transceiver === 'dac' ? '40GBase-CR4' : '40GBase-' + mode + 'R4';
  if (p.media === 'sfp') return p.speed >= 10000 ? '10GBase-' + mode + 'R' : '1000Base' + mode + 'X SFP';
  return p.media;
}
/** IOS "show interfaces status": physical switch/router ports and port-channels. */
export function showInterfacesStatus(e: SimulationEngine, d: Device, selected?: string) {
  const ports = d.interfaces.filter(
    (p) =>
      (!p.logical && !p.loopback && !p.tunnel && !p.vxlan && !['wifi', 'console', 'mesh'].includes(p.media)) &&
      (!selected || p.name.toLowerCase() === interfaceName(selected).toLowerCase())
  );
  if (!ports.length) throw new Error('% Invalid input detected: interface not found.');
  const rows = ports.map((p) => {
    const up = interfaceOperational(e.state, d, p);
    const status = p.errDisabled ? 'err-disabled' : !p.adminUp ? 'disabled' : up ? 'connected' : 'notconnect';
    const vlan = p.mode === 'routed' ? 'routed' : p.mode === 'trunk' ? 'trunk' : String(p.accessVlan);
    const auto = p.speedAuto !== false && p.media === 'rj45';
    const duplex = up && auto ? 'a-' + p.duplex : auto ? 'auto' : p.duplex;
    const speed = up && auto ? 'a-' + p.speed : auto ? 'auto' : String(p.speed);
    return (
      shortName(p.name).padEnd(10) +
      ' ' +
      (p.description ?? '').slice(0, 18).padEnd(18) +
      ' ' +
      status.padEnd(12) +
      ' ' +
      vlan.padEnd(10) +
      ' ' +
      duplex.padStart(6) +
      ' ' +
      speed.padStart(6) +
      ' ' +
      portType(p)
    ).trimEnd();
  });
  return ['Port       Name               Status       Vlan       Duplex  Speed Type', ...rows].join('\n');
}
/** IOS "show interfaces description". */
export function showInterfacesDescription(e: SimulationEngine, d: Device) {
  return [
    'Interface                      Status         Protocol Description',
    ...d.interfaces
      .filter((p) => !['wifi', 'console', 'mesh'].includes(p.media))
      .map((p) => {
        const up = interfaceOperational(e.state, d, p);
        const status = !p.adminUp ? 'admin down' : up ? 'up' : 'down';
        return (
          shortName(p.name).padEnd(31) +
          status.padEnd(15) +
          (up ? 'up' : 'down').padEnd(9) +
          (p.description ?? '')
        ).trimEnd();
      }),
  ].join('\n');
}
export function showInterfaces(e: SimulationEngine, d: Device, brief = false, selected?: string) {
  const ports = selected
    ? d.interfaces.filter((p) => p.name.toLowerCase() === interfaceName(selected).toLowerCase())
    : d.interfaces;
  if (!ports.length) throw new Error('Interface inexistente');
  if (brief)
    return (
      'Interface              IP-Address      OK? Method Status                 Protocol\n' +
      ports
        .map(
          (p) =>
            `${p.name.padEnd(23)}${(p.ip ?? 'unassigned').padEnd(16)}YES ${p.ipv4Mode === 'dhcp' ? 'DHCP  ' : 'manual'} ${interfaceStatus(e, d, p).padEnd(23)}${interfaceOperational(e.state, d, p) ? 'up' : 'down'}`
        )
        .join('\n')
    );
  return ports
    .map(
      (p) =>
        `${p.name} is ${interfaceStatus(e, d, p)}, line protocol is ${interfaceOperational(e.state, d, p) ? 'up' : 'down'}\n` +
        `  Hardware is ${p.media}, address is ${p.mac}\n` +
        (p.description ? `  Description: ${p.description}\n` : '') +
        (p.ip ? `  Internet address is ${p.ip}/${p.prefix}\n` : '') +
        `  MTU ${p.mtu} bytes, BW ${p.speed * 1000} Kbit/sec, ${p.duplex}-duplex\n` +
        `  ${p.rx} packets input, ${p.tx} packets output, ${p.errors} errors`
    )
    .join('\n\n');
}

export function showRoutes(e: SimulationEngine, d: Device, vrf?: string) {
  const rows: { network: string; prefix: number; distance: number; metric: number; text: string }[] = [];
  const usable = (p: NetworkInterface) =>
    p.vrf === vrf && p.ip && p.prefix !== undefined && interfaceOperational(e.state, d, p);
  for (const p of d.interfaces.filter(usable)) {
    const network = subnet(p.ip!, p.prefix!).network;
    rows.push({
      network,
      prefix: p.prefix!,
      distance: 0,
      metric: 0,
      text: `C ${network}/${p.prefix} directly connected, ${p.name}`,
    });
    rows.push({
      network: p.ip!,
      prefix: 32,
      distance: 0,
      metric: 0,
      text: `L ${p.ip}/32 directly connected, ${p.name}`,
    });
  }
  for (const r of d.routes.filter((r) => r.vrf === vrf && r.distance !== 255)) {
    if(r.track&&!d.monitoring?.tracks.find(t=>t.id===r.track)?.state)continue;
    const next = r.port
      ? d.interfaces.find(
          (p) =>
            p.id === r.port &&
            usable(p) &&
            (r.nextHop === '0.0.0.0' ||
              subnet(p.ip!, p.prefix!).network === subnet(r.nextHop, p.prefix!).network)
        )
      : resolveRoute(
          d,
          r.nextHop,
          vrf,
          e.state,
          new Set([JSON.stringify([vrf, r.network, r.prefix, r.nextHop, r.port])])
        );
    if (next)
      rows.push({
        ...r,
        distance: r.distance ?? 1,
        text: `S ${r.network}/${r.prefix} [${r.distance ?? 1}/${r.metric}] ${r.nextHop === '0.0.0.0' ? 'directly connected' : 'via ' + r.nextHop}${r.port ? ', ' + d.interfaces.find((p) => p.id === r.port)!.name : ''}`,
      });
  }
  for (const r of vrf
    ? []
    : [...(d.ospf?.enabled ? d.ospf.routes : []), ...(d.bgp?.enabled ? d.bgp.routes : []), ...ripRoutes(d)]) {
    const p = d.interfaces.find((p) => p.id === r.port && usable(p));
    if (!p || !resolveRoute(d, r.nextHop, vrf, e.state)) continue;
    const code = !('protocol' in r)
      ? 'B'
      : r.protocol === 'RIP'
        ? 'R'
        : 'O' +
          (r.pathType === 'inter'
            ? ' IA'
            : r.pathType === 'E1'
              ? ' E1'
              : r.pathType === 'E2'
                ? ' E2'
                : r.pathType === 'N1'
                  ? ' N1'
                  : r.pathType === 'N2'
                    ? ' N2'
                    : '');
    rows.push({
      ...r,
      text: `${code} ${r.network}/${r.prefix} [${r.distance}/${r.metric}] via ${r.nextHop}, ${p.name}`,
    });
  }
  for (const r of resolveDefaultRoutes(d, vrf).filter((r) => interfaceOperational(e.state, d, r.port)))
    rows.push({
      network: '0.0.0.0',
      prefix: 0,
      distance: 1,
      metric: r.metric,
      text: `${r.port.ipv4Mode === 'dhcp' ? 'D' : 'S'} 0.0.0.0/0 via ${r.nextHop}, ${r.port.name}`,
    });
  const installed = rows.filter(
    (r) =>
      !rows.some(
        (other) =>
          other.network === r.network &&
          other.prefix === r.prefix &&
          (other.distance < r.distance || (other.distance === r.distance && other.metric < r.metric))
      )
  );
  return [...new Set(installed.map((r) => r.text))].join('\n') || 'Nenhuma rota';
}
