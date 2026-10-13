import { z } from 'zod';
export const modbusConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535).default(502),
    unit: z.number().int().min(1).max(247).default(1),
    registers: z.array(z.number().int().min(0).max(65535)).min(1).max(1024),
  })
  .strict();
export const modbusRequestSchema = z
  .object({
    transaction: z.number().int().min(0).max(65535),
    unit: z.number().int().min(1).max(247),
    function: z.union([z.literal(3), z.literal(6), z.literal(16)]),
    address: z.number().int().min(0).max(65535),
    quantity: z.number().int().min(1).max(125).default(1),
    values: z.array(z.number().int().min(0).max(65535)).max(123).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      (r.function === 6 && (r.values.length !== 1 || r.quantity !== 1)) ||
      (r.function === 16 && (r.values.length !== r.quantity || r.quantity > 123)) ||
      (r.function === 3 && r.values.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Quantidade/valores incompatíveis com a função Modbus.' });
  });
export type ModbusRequest = z.infer<typeof modbusRequestSchema>;
