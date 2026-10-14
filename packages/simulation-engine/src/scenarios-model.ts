import { z } from 'zod';
import { ipv4Schema } from './schemas';
import { transportAddressSchema } from './protocols/tcp-model';
import { linkLocal6 } from './protocols/ipv6-address';
import { modbusRequestSchema } from './protocols/modbus-model';
import { dnsNameSchema } from './protocols/dns-model';
import { oidSchema, snmpVarbindSchema } from './protocols/snmp-model';
import { scenarioAssertionSchema } from './scenario-assertions';
import { configurationPatchSchema } from './configuration-patch-model';
export const scenarioServiceSchema = z.enum([
  'dns',
  'dhcp',
  'http',
  'modbus',
  'mqtt',
  'snmp',
  'ntp',
  'syslog',
]);
const ref = z.string().min(1).max(80);
export const scenarioActionSchema = z
  .object({
    atMs: z.number().int().nonnegative(),
    kind: z.enum(['checkpoint', 'restore', 'configure', 'rollback']),
    checkpoint: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    changes: configurationPatchSchema.optional(),
  })
  .strict();
export const scenarioSchema = z
  .object({
    name: z.string().min(1).max(100),
    durationMs: z.number().int().min(100).max(120000),
    intervalMs: z.number().int().min(100).max(30000),
    deadlineMs: z.number().int().min(1).max(30000),
    warmupMs: z.number().int().min(0).max(60000).optional(),
    actions: z.array(scenarioActionSchema).max(16).optional(),
    assertions: z.array(scenarioAssertionSchema).max(64).optional(),
    flows: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            source: z.string().min(1).max(80),
            target: transportAddressSchema,
            vrf: z
              .string()
              .regex(/^[a-zA-Z0-9_-]{1,32}$/)
              .optional(),
            scope: ref.optional(),
            protocol: z.enum(['icmp', 'http', 'modbus', 'dns', 'dhcp', 'mqtt', 'snmp', 'ntp', 'syslog']),
            port: z.number().int().min(1).max(65535).optional(),
            modbus: modbusRequestSchema.optional(),
            expectedRegisters: z.array(z.number().int().min(0).max(65535)).max(125).optional(),
            expectedBits: z.array(z.boolean()).max(2000).optional(),
            dns: z
              .object({
                name: dnsNameSchema,
                type: z.enum(['A', 'AAAA', 'CNAME']).default('A'),
                clearCache: z.boolean().default(true),
                expectedAnswers: z.array(z.string().min(1).max(254)).min(1).max(64).optional(),
              })
              .strict()
              .optional(),
            dhcp: z
              .object({
                interface: ref,
                fresh: z.boolean().default(true),
                expectedAddress: ipv4Schema.optional(),
                expectedServer: ipv4Schema.optional(),
              })
              .strict()
              .optional(),
            mqtt: z
              .object({
                operation: z.enum(['connect', 'publish']),
                topic: z.string().min(1).max(128).optional(),
                payload: z.string().max(1024).optional(),
                retain: z.boolean().default(false),
                receiver: ref.optional(),
                filter: z.string().min(1).max(128).optional(),
                credentials: z
                  .object({ username: z.string().min(1).max(64), password: z.string().max(128) })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            snmp: z
              .object({
                community: z
                  .string()
                  .min(1)
                  .max(32)
                  .regex(/^[a-zA-Z0-9_-]+$/),
                oids: z.array(oidSchema).min(1).max(16),
                operation: z.enum(['get', 'get-next']).default('get'),
                expectedVarbinds: z.array(snmpVarbindSchema).min(1).max(16).optional(),
              })
              .strict()
              .optional(),
            ntp: z
              .object({ maxOffsetMs: z.number().nonnegative().max(3600000).default(1) })
              .strict()
              .optional(),
            syslog: z
              .object({
                text: z.string().min(1).max(300),
                severity: z.number().int().min(0).max(7).default(6),
              })
              .strict()
              .optional(),
            expect: z.enum(['allow', 'deny']),
            denyEvidence: z.enum(['no-response', 'policy']).optional(),
            maxLossPercent: z.number().min(0).max(100).default(0),
            maxLatencyMs: z.number().positive().max(30000).optional(),
            requireFinalSuccess: z.boolean().default(false),
          })
          .strict()
      )
      .min(1)
      .max(16),
    faults: z
      .array(
        z
          .object({
            atMs: z.number().int().min(0),
            target: z.string().min(1).max(80),
            kind: z.enum(['device', 'link', 'port', 'service', 'power']),
            up: z.boolean(),
            port: ref.optional(),
            service: scenarioServiceSchema.optional(),
            servicePort: z.number().int().min(1).max(65535).optional(),
          })
          .strict()
      )
      .max(32),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (Math.ceil(s.durationMs / s.intervalMs) * s.flows.length > 180)
      ctx.addIssue({ code: 'custom', message: 'Limite de 180 amostras por cenário; aumente o intervalo.' });
    if (s.faults.some((f) => f.atMs > s.durationMs))
      ctx.addIssue({ code: 'custom', message: 'Falha fora da duração do cenário.' });
    if (
      s.assertions?.some((a) => a.atMs > s.durationMs) ||
      new Set(s.assertions?.map((a) => a.name)).size !== (s.assertions?.length ?? 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Assertion fora da duração ou nome repetido.' });
    const checkpoints = new Set<string>(),
      configurations = new Set<string>();
    for (const action of [...(s.actions ?? [])].sort((a, b) => a.atMs - b.atMs)) {
      if (action.atMs > s.durationMs)
        ctx.addIssue({ code: 'custom', message: 'Ação fora da duração do cenário.' });
      if ((action.kind === 'configure') !== Boolean(action.changes))
        ctx.addIssue({
          code: 'custom',
          message: 'Configure exige changes; outras ações não aceitam changes.',
        });
      if (action.kind === 'configure') {
        if (configurations.has(action.checkpoint) || configurations.size >= 4)
          ctx.addIssue({ code: 'custom', message: 'Proposta repetida ou limite de quatro excedido.' });
        configurations.add(action.checkpoint);
      } else if (action.kind === 'rollback') {
        if (!configurations.has(action.checkpoint))
          ctx.addIssue({ code: 'custom', message: 'Rollback exige configure anterior.' });
        configurations.delete(action.checkpoint);
      } else if (action.kind === 'checkpoint') {
        if (checkpoints.has(action.checkpoint) || checkpoints.size >= 4)
          ctx.addIssue({ code: 'custom', message: 'Checkpoint repetido ou limite de quatro excedido.' });
        checkpoints.add(action.checkpoint);
      } else if (!checkpoints.has(action.checkpoint))
        ctx.addIssue({ code: 'custom', message: 'Restore exige checkpoint anterior.' });
    }
    for (const f of s.flows) {
      if ((f.target.includes(':') || f.vrf || f.scope) && !['icmp', 'http', 'modbus'].includes(f.protocol))
        ctx.addIssue({
          code: 'custom',
          message:
            'IPv6/VRF/escopo disponíveis para ICMP, HTTP e Modbus; este adaptador de serviço usa IPv4 na tabela padrão.',
        });
      if (f.scope && !f.target.includes(':'))
        ctx.addIssue({ code: 'custom', message: 'Escopo de interface pertence ao IPv6.' });
      if (f.target.includes(':') && linkLocal6(f.target) && !f.scope)
        ctx.addIssue({ code: 'custom', message: 'Destino IPv6 link-local exige scope.' });
      for (const protocol of ['dns', 'dhcp', 'mqtt', 'snmp', 'ntp', 'syslog'] as const) {
        if ((f.protocol === protocol) !== Boolean(f[protocol]))
          ctx.addIssue({
            code: 'custom',
            message: `Fluxo ${protocol} exige apenas seus próprios parâmetros.`,
          });
      }
      if (['dhcp', 'mqtt', 'ntp'].includes(f.protocol) && s.intervalMs < s.deadlineMs)
        ctx.addIssue({
          code: 'custom',
          message:
            'DHCP/MQTT/NTP exigem intervalo maior ou igual ao deadline para evitar sobreposição de estado.',
        });
      if (
        f.mqtt?.operation === 'publish' &&
        (!f.mqtt.topic || f.mqtt.payload === undefined || /[+#\0]/.test(f.mqtt.topic))
      )
        ctx.addIssue({ code: 'custom', message: 'Publicação MQTT exige topic sem wildcards e payload.' });
      if (
        f.mqtt &&
        ((f.mqtt.receiver && !f.mqtt.filter) ||
          (!f.mqtt.receiver && f.mqtt.filter) ||
          (f.mqtt.receiver && f.mqtt.operation !== 'publish'))
      )
        ctx.addIssue({ code: 'custom', message: 'Recepção MQTT exige receiver e filter em uma publicação.' });
      if (f.protocol === 'modbus' && !f.modbus)
        ctx.addIssue({ code: 'custom', message: 'Fluxo Modbus exige uma requisição modbus.' });
      if (f.protocol !== 'modbus' && (f.modbus || f.expectedRegisters || f.expectedBits))
        ctx.addIssue({ code: 'custom', message: 'Parâmetros Modbus em outro protocolo.' });
      if (
        f.expectedRegisters &&
        (![3, 4].includes(f.modbus?.function ?? 0) || f.expectedRegisters.length !== f.modbus?.quantity)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Registradores esperados exigem leitura com a mesma quantidade.',
        });
      if (
        f.expectedBits &&
        (![1, 2].includes(f.modbus?.function ?? 0) || f.expectedBits.length !== f.modbus?.quantity)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Bits esperados exigem leitura 01/02 com a mesma quantidade.',
        });
    }
    for (const f of s.faults) {
      if (
        (f.kind === 'port') !== Boolean(f.port) ||
        (f.kind === 'service') !== Boolean(f.service) ||
        (f.servicePort !== undefined && (f.kind !== 'service' || f.service !== 'http'))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Falha de porta exige port; falha de serviço exige service. servicePort pertence ao HTTP.',
        });
    }
    const stateful = s.flows.filter((f) => ['dhcp', 'mqtt', 'ntp'].includes(f.protocol));
    const owners = stateful.flatMap((f) => [f.source, ...(f.mqtt?.receiver ? [f.mqtt.receiver] : [])]);
    if (new Set(owners).size !== owners.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Fluxos DHCP/MQTT/NTP devem ter origens e receptores exclusivos no cenário.',
      });
    if (new Set(s.flows.map((f) => f.name)).size !== s.flows.length)
      ctx.addIssue({ code: 'custom', message: 'Nomes de fluxos devem ser únicos.' });
  });
export type Scenario = z.infer<typeof scenarioSchema>;
