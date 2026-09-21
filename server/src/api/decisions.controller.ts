import { Controller, Get, Query } from '@nestjs/common';
import type { DecisionsPageResponse } from '@remora/sdk';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bookSchema } from './bookParam';
import { toDecisionResponse } from './responses';
import { ZodValidationPipe } from './zodValidation.pipe';

const decisionsQuerySchema = z.object({
  book: bookSchema.optional(),
  verdict: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['COPY', 'SKIP']))
    .optional(),
  reason: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional(),
  wallet: z.string().toLowerCase().optional(),
  coin: z.string().min(1).optional(),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => BigInt(value))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('api/decisions')
export class DecisionsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listDecisions(
    @Query(new ZodValidationPipe(decisionsQuerySchema, 'invalid_query'))
    query: z.output<typeof decisionsQuerySchema>,
  ): Promise<DecisionsPageResponse> {
    const where: Prisma.CopyDecisionWhereInput = {
      book: query.book,
      verdict: query.verdict,
      reason: query.reason,
      walletAddress: query.wallet,
      coin: query.coin,
      id: query.cursor === undefined ? undefined : { lt: query.cursor },
    };
    const rows = await this.prisma.copyDecision.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: { orders: { orderBy: { id: 'asc' } } },
    });
    const decisions = rows.slice(0, query.limit);
    return {
      decisions: decisions.map(toDecisionResponse),
      nextCursor:
        rows.length > query.limit
          ? (decisions.at(-1)?.id.toString() ?? null)
          : null,
    };
  }
}
