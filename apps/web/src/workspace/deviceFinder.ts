import type { Device } from '@shlab/engine';

export function findDevices(devices: Device[], query: string): Device[] {
  const text = query.trim().toLocaleLowerCase('pt-BR');
  if (!text) return [];
  const fields = (d: Device) =>
    [
      d.hostname,
      d.id,
      ...d.interfaces.flatMap((p) => [p.ip, p.mac, ...(p.ipv6?.addresses.map((a) => a.ip) ?? [])]),
    ]
      .filter((v): v is string => !!v)
      .map((v) => v.toLocaleLowerCase('pt-BR'));
  return devices
    .filter((d) => fields(d).some((value) => value.includes(text)))
    .sort((a, b) => Number(fields(b).includes(text)) - Number(fields(a).includes(text)));
}
