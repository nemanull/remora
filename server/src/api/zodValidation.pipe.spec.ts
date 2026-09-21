import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zodValidation.pipe';

const pipe = new ZodValidationPipe(
  z.object({ active: z.boolean(), reason: z.string().nullish() }),
  'invalid_body',
);

function readError(value: unknown): { status: number; body: unknown } {
  try {
    pipe.transform(value);
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() };
    }
    throw error;
  }
  throw new Error('the pipe accepted the value');
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value', () => {
    expect(pipe.transform({ active: true, extra: 1 })).toEqual({
      active: true,
    });
  });

  it('answers 400 with the reason code and one detail per issue', () => {
    expect(readError({ active: 'yes', reason: 3 })).toEqual({
      status: 400,
      body: {
        statusCode: 400,
        reason: 'invalid_body',
        message: expect.any(String) as string,
        details: [
          'active: Invalid input: expected boolean, received string',
          'reason: Invalid input: expected string, received number',
        ],
      },
    });
  });
});
