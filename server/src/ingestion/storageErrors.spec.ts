import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { isDataError } from './storageErrors';

function requestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`failed with ${code}`, {
    code,
    clientVersion: '7.8.0',
  });
}

describe('isDataError', () => {
  it.each(['P2002', 'P2003', 'P2020', 'P2011'])(
    'drops a frame that failed a constraint or a value check with %s',
    (code) => {
      expect(isDataError(requestError(code))).toBe(true);
    },
  );

  it.each(['P1001', 'P1017', 'P2024', 'P2028', 'P2034'])(
    'treats %s as a storage failure that closes the session',
    (code) => {
      expect(isDataError(requestError(code))).toBe(false);
    },
  );

  it('drops a frame that Prisma refused to validate', () => {
    const error = new Prisma.PrismaClientValidationError('invalid decimal', {
      clientVersion: '7.8.0',
    });

    expect(isDataError(error)).toBe(true);
  });

  it('treats any other error as a storage failure', () => {
    expect(isDataError(new Error('Connection terminated unexpectedly'))).toBe(
      false,
    );
  });
});
