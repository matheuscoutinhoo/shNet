import { z } from 'zod';
export const iosSecretSchema = z.string().regex(/^\$[89]\$[./0-9A-Za-z]{14}\$[./0-9A-Za-z]{43}$/);
