import { Prisma } from '../generated/prisma/client';

const DATA_ERROR_CODES = new Set([
  'P2000',
  'P2002',
  'P2003',
  'P2004',
  'P2005',
  'P2006',
  'P2007',
  'P2011',
  'P2012',
  'P2019',
  'P2020',
  'P2023',
  'P2033',
]);

export function isDataError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientValidationError) {
    return true;
  }
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    DATA_ERROR_CODES.has(error.code)
  );
}
