import { z } from 'zod';
import { quorumStateSchema } from './quorum';

export const quorumLabSchema = z
  .object({
    token: z.string().min(1).max(64),
    node: quorumStateSchema,
    ports: z.record(z.string(), z.string().min(1).max(64)),
  })
  .strict();
