import { z } from 'zod';

export const bookSchema = z
  .string()
  .toUpperCase()
  .pipe(z.enum(['MAIN', 'SHADOW']));
