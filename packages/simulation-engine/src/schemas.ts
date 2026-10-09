import { z } from 'zod';

export const ipv4Schema = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}$/)
  .refine(
    (value) => value.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part),
    'IPv4 inválido'
  );
export const idSchema = z.string().min(1).max(80);
export const uint32Schema = z.number().int().min(0).max(4294967295);
export const portNumberSchema = z.number().int().min(1).max(65535);
export const timeSchema = z.number().finite().nonnegative();
