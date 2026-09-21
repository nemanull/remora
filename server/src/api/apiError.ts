import { HttpException } from '@nestjs/common';
import type { ApiErrorResponse } from '@remora/sdk';

export function apiError(
  statusCode: number,
  reason: string,
  message: string,
  details: string[] = [],
): HttpException {
  const body: ApiErrorResponse = { statusCode, reason, message, details };
  return new HttpException(body, statusCode);
}
