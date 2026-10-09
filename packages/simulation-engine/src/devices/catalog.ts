import type { Device, NetworkInterface } from '../model';
export const catalog = [
  {
    type: 'pc',
    name: 'Computador',
    model: 'NL Desktop',
    description: 'Host IPv4 com ARP, ICMP e gateway.',
    layer: 'L3',
    ports: 1,
  },
  {
    type: 'switch',
    name: 'Switch L2',
    model: 'NL Switch 8G',
    description: 'Aprende MACs e encaminha frames por VLAN.',
    layer: 'L2',
    ports: 10,
  },
  {
    type: 'router',
    name: 'Roteador',
    model: 'NL Router 4G',
    description: 'Conecta sub-redes usando longest prefix match.',
    layer: 'L3',
    ports: 6,
  },
  {
    type: 'server',
    name: 'Servidor',
    model: 'NL Server',
    description: 'Endpoint IPv4 para testar a conectividade.',
    layer: 'L3',
    ports: 2,
  },
] as const;
export function createDevice(
  type: Device['type'],
  id: string,
  ordinal: number,
  position = { x: 100, y: 100 }
): Device {
  const spec = catalog.find((c) => c.type === type)!;
  const interfaces: NetworkInterface[] = Array.from({ length: spec.ports }, (_, n) => ({
    id: 'p' + n,
    name: type === 'pc' || type === 'server' ? 'Eth' + n : 'Gi0/' + (n + 1),
    mac: [2, (ordinal >>> 16) & 255, (ordinal >>> 8) & 255, ordinal & 255, 0, n]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join(':'),
    media: (type === 'switch' && n >= 8) || (type === 'router' && n >= 4) ? 'sfp' : 'rj45',
    ...((type === 'switch' && n >= 8) || (type === 'router' && n >= 4)
      ? { transceiver: 'single-mode' as const }
      : {}),
    adminUp: true,
    speed: 1000,
    duplex: 'full',
    mtu: 1500,
    mode: type === 'switch' ? 'access' : 'routed',
    accessVlan: 1,
    nativeVlan: 1,
    allowedVlans: [1],
    description: '',
    rx: 0,
    tx: 0,
    errors: 0,
  }));
  return {
    id,
    type,
    hostname:
      { pc: 'PC', switch: 'SW', router: 'R', server: 'SRV' }[type] + '-' + String(ordinal).padStart(2, '0'),
    position,
    power: true,
    interfaces,
    vlans: [{ id: 1, name: 'default' }],
    routes: [],
    macTable: [],
    arpTable: [],
    pending: [],
    logs: [],
    dropped: 0,
  };
}
