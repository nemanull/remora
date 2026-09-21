import { HttpStatus, PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { apiError } from './apiError';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly reason: 'invalid_body' | 'invalid_query' | 'invalid_path',
  ) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        this.reason,
        z.prettifyError(result.error),
        result.error.issues.map(
          (issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`,
        ),
      );
    }
    return result.data;
  }
}
