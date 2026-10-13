import { z } from 'zod';
import { ipv4Schema } from './schemas';
import type { SimulationEngine } from './core/engine';
import { resolveRoute } from './protocols/ipv4';
const ref = z.string().min(1).max(80);
const base = { name: z.string().min(1).max(80), atMs: z.number().int().nonnegative(), target: ref };
export const scenarioAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('power'), expected: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('port'), port: ref, expected: z.boolean() }).strict(),
  z
    .object({ ...base, kind: z.literal('mtu'), port: ref, expected: z.number().int().min(64).max(9216) })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('eap'),
      expected: z.enum(['idle', 'authenticating', 'authorized', 'rejected']),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('bgp'),
      peer: ipv4Schema,
      expected: z.enum(['Idle', 'Connect', 'Active', 'OpenSent', 'OpenConfirm', 'Established']),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('evpn-members'),
      vni: z.number().int().min(1).max(16777215),
      expected: z.number().int().min(0).max(512),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('route'),
      destination: ipv4Schema,
      vrf: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,32}$/)
        .optional(),
      expected: ref,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('vrrp'),
      vip: ipv4Schema,
      expected: z.enum(['INIT', 'ACTIVE', 'BACKUP']),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('proxy-backend'),
      backend: ipv4Schema,
      expected: z.enum(['unknown', 'up', 'down']),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('modbus'),
      bank: z.enum(['registers', 'inputRegisters', 'coils', 'discreteInputs']),
      address: z.number().int().min(0).max(1023),
      expected: z.union([z.boolean(), z.number().int().min(0).max(65535)]),
    })
    .strict(),
]);
export type ScenarioAssertion = z.infer<typeof scenarioAssertionSchema>;
export function observeAssertion(engine: SimulationEngine, assertion: ScenarioAssertion) {
  const d = engine.state.devices.find((d) => d.id === assertion.target || d.hostname === assertion.target);
  if (!d) throw new Error('Alvo de assertion inexistente: ' + assertion.target);
  const port = 'port' in assertion ? d.interfaces.find((p) => p.id === assertion.port) : undefined;
  switch (assertion.kind) {
    case 'power':
      return String(d.power);
    case 'port':
      return port ? String(port.adminUp) : 'not-configured';
    case 'mtu':
      return port ? String(port.mtu) : 'not-configured';
    case 'eap':
      return d.eapSupplicant?.phase ?? 'not-configured';
    case 'bgp':
      return d.bgp?.peers.find((p) => p.ip === assertion.peer)?.state ?? 'not-configured';
    case 'evpn-members': {
      const v = d.interfaces.find((p) => p.vxlan?.vni === assertion.vni)?.vxlan;
      return v ? String(v.members?.length ?? 0) : 'not-configured';
    }
    case 'route':
      return resolveRoute(d, assertion.destination, assertion.vrf, engine.state)?.port.id ?? 'none';
    case 'vrrp':
      return d.vrrp?.groups.find((g) => g.vip === assertion.vip)?.state ?? 'not-configured';
    case 'proxy-backend':
      return d.proxy?.health.find((h) => h.address === assertion.backend)?.state ?? 'not-configured';
    case 'modbus':
      return String(d.modbus?.[assertion.bank]?.[assertion.address] ?? 'not-configured');
  }
}
