import type { NetworkInterface, Device } from '../model';
/** Native IOS static mappings use the outside role rather than an interface binding. */
export const staticNatOutside = (configured: string, port: NetworkInterface) =>
  configured === port.id || (configured === '*' && port.natRole === 'outside');
export function natPools(d: Device) {
  return [
    ...(d.nat?.pools ?? []).map((p) => ({ ...p, sourceAcl: undefined as string | undefined })),
    ...(d.nat?.interfaceRules ?? []).flatMap((rule) => {
      const p = d.interfaces.find((p) => p.id === rule.outside && p.natRole === 'outside');
      return p?.ip
        ? [
            {
              name: rule.name,
              source: { network: '0.0.0.0', prefix: 0 },
              outside: p.id,
              start: p.ip,
              end: p.ip,
              overload: true,
              sourceAcl: rule.acl,
            },
          ]
        : [];
    }),
  ];
}
