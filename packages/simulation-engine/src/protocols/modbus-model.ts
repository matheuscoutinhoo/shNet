import { z } from 'zod';
export const modbusConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535).default(502),
    unit: z.number().int().min(1).max(247).default(1),
    registers: z.array(z.number().int().min(0).max(65535)).min(1).max(1024),
    inputRegisters: z.array(z.number().int().min(0).max(65535)).max(1024).optional(),
    coils: z.array(z.boolean()).max(1024).optional(),
    discreteInputs: z.array(z.boolean()).max(1024).optional(),
  })
  .strict();
export const modbusRequestSchema = z
  .object({
    transaction: z.number().int().min(0).max(65535),
    unit: z.number().int().min(1).max(247),
    function: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(15),
      z.literal(16),
    ]),
    address: z.number().int().min(0).max(65535),
    quantity: z.number().int().min(1).max(2000).default(1),
    values: z.array(z.number().int().min(0).max(65535)).max(1968).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      ([5, 6].includes(r.function) && (r.values.length !== 1 || r.quantity !== 1)) ||
      (r.function === 16 && (r.values.length !== r.quantity || r.quantity > 123)) ||
      (r.function === 15 && (r.values.length !== r.quantity || r.quantity > 1968)) ||
      ([1, 2, 3, 4].includes(r.function) && r.values.length) ||
      ([3, 4].includes(r.function) && r.quantity > 125) ||
      ([5, 15].includes(r.function) && r.values.some((v) => v !== 0 && v !== 1)) ||
      r.address + r.quantity > 65536
    )
      ctx.addIssue({ code: 'custom', message: 'Quantidade/valores incompatíveis com a função Modbus.' });
  });
export type ModbusRequest = z.infer<typeof modbusRequestSchema>;
