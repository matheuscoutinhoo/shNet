import { z } from 'zod';
import { ipv4Schema } from './schemas';
import { modbusRequestSchema } from './protocols/modbus-model';
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
            protocol: z.enum(['icmp', 'http', 'modbus']),
            port: z.number().int().min(1).max(65535).optional(),
            modbus: modbusRequestSchema.optional(),
            expectedRegisters: z.array(z.number().int().min(0).max(65535)).max(125).optional(),
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
            kind: z.enum(['device', 'link']),
            up: z.boolean(),
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
    if (new Set(s.flows.map((f) => f.name)).size !== s.flows.length)
      ctx.addIssue({ code: 'custom', message: 'Nomes de fluxos devem ser únicos.' });
  });
export type Scenario = z.infer<typeof scenarioSchema>;
