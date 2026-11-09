import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { resolveRoute } from './ipv4';
import { sourceInterfaceAddress } from './source-interface';

/** A TACACS+ or RADIUS server an IOS AAA method list can ask. */
export interface AaaTarget {
  kind: 'tacacs' | 'radius';
  name: string;
  address: string;
  key: string;
  port: number;
  timeoutMs: number;
  // Transmissions of one request: RADIUS retransmits ("retransmit", 3 by default); TACACS+ does not.
  attempts: number;
  // Missing when the device has no address to send from (no route and no usable source interface).
  sourceIp?: string;
}
/** IOS uses UDP 1645 when a RADIUS server has no "auth-port". */
export const RADIUS_DEFAULT_AUTH_PORT = 1645;

/** The server kind of an AAA method ("group tacacs+", "group radius" or "group NAME"). */
export function aaaGroupKind(d: Device, method: string): 'tacacs' | 'radius' | undefined {
  const name = /^group (\S+)$/.exec(method)?.[1];
  if (!name) return undefined;
  if (name === 'tacacs+') return 'tacacs';
  if (name === 'radius') return 'radius';
  return d.iosSystem?.aaaGroups?.find((g) => g.name === name)?.kind;
}
/**
 * The servers of an AAA method, in the configured order: every server of that kind for "group
 * tacacs+"/"group radius", or the members of a named "aaa group server". The source address is the
 * group's or the global "ip tacacs|radius source-interface", else the interface towards the server.
 * Servers without an address or a key are skipped, as IOS cannot send to them.
 */
export function aaaGroupServers(e: SimulationEngine, d: Device, method: string): AaaTarget[] {
  const s = d.iosSystem,
    name = /^group (\S+)$/.exec(method)?.[1],
    kind = aaaGroupKind(d, method);
  if (!name || !kind) return [];
  const group = ['tacacs+', 'radius'].includes(name) ? undefined : s?.aaaGroups?.find((g) => g.name === name);
  const servers = group
    ? group.servers.flatMap(
        (ref) => s?.aaaServers?.filter((x) => x.kind === kind && (x.name === ref || x.address === ref)) ?? []
      )
    : (s?.aaaServers ?? []).filter((x) => x.kind === kind);
  const sourceName = group?.sourceInterface ?? s?.aaaSourceInterface?.[kind];
  return servers.flatMap((server) => {
    if (!server.address || !server.key) return [];
    const fixed = sourceName ? sourceInterfaceAddress(e.state, d, sourceName) : undefined,
      sourceIp = fixed ?? resolveRoute(d, server.address, undefined, e.state)?.port.ip;
    return [
      {
        kind,
        name: server.name,
        address: server.address,
        key: server.key,
        port: kind === 'tacacs' ? (server.port ?? 49) : (server.authPort ?? RADIUS_DEFAULT_AUTH_PORT),
        timeoutMs: (server.timeout ?? 5) * 1000,
        attempts: kind === 'radius' ? 1 + (server.retransmit ?? 3) : 1,
        ...(sourceIp ? { sourceIp } : {}),
      },
    ];
  });
}
