import { z } from 'zod';
import { ipv4Schema } from './schemas';
import { modbusRequestSchema } from './protocols/modbus-model';
import { dnsNameSchema } from './protocols/dns-model';
import { oidSchema, snmpVarbindSchema } from './protocols/snmp-model';
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
export const scenarioSchema = z
  .object({
    name: z.string().min(1).max(100),
    durationMs: z.number().int().min(100).max(120000),
    intervalMs: z.number().int().min(100).max(30000),
    deadlineMs: z.number().int().min(1).max(30000),
    flows: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            source: z.string().min(1).max(80),
            target: ipv4Schema,
            protocol: z.enum(['icmp', 'http', 'modbus', 'dns', 'dhcp', 'mqtt', 'snmp', 'ntp', 'syslog']),
            port: z.number().int().min(1).max(65535).optional(),
            modbus: modbusRequestSchema.optional(),
            expectedRegisters: z.array(z.number().int().min(0).max(65535)).max(125).optional(),
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
    for (const f of s.flows) {
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
      if (f.protocol !== 'modbus' && (f.modbus || f.expectedRegisters))
        ctx.addIssue({ code: 'custom', message: 'Parâmetros Modbus em outro protocolo.' });
      if (
        f.expectedRegisters &&
        (f.modbus?.function !== 3 || f.expectedRegisters.length !== f.modbus.quantity)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Registradores esperados exigem leitura com a mesma quantidade.',
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
