import type {
  BookEquityPointResponse,
  CopyPositionsResponse,
  KillSwitchResponse,
} from '@remora/sdk';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { BookStateService } from '../books/bookState.service';
import { KillSwitchService } from '../books/killSwitch.service';
import type { BookName } from '../copy/types';
import { PrismaService } from '../prisma/prisma.service';
import { bookSchema } from './bookParam';
import { thinPoints } from './thinPoints';
import { toBookEquityPointResponse, toCopyPositionResponse } from './responses';
import { ZodValidationPipe } from './zodValidation.pipe';

const DAY_MS = 86_400_000;
const CLOSED_COPIES_LIMIT = 100;
const MAX_EQUITY_POINTS = 720;

const equityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

const killSwitchSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(1).max(200).nullish(),
});

@Controller('api/books')
export class BooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookState: BookStateService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  @Get(':book/positions')
  async listPositions(
    @Param('book', new ZodValidationPipe(bookSchema, 'invalid_path'))
    book: BookName,
  ): Promise<CopyPositionsResponse> {
    const [open, closed] = await Promise.all([
      this.prisma.copyPosition.findMany({
        where: { book, isOpen: true },
        orderBy: { openedAt: 'desc' },
      }),
      this.prisma.copyPosition.findMany({
        where: { book, isOpen: false },
        orderBy: { closedAt: 'desc' },
        take: CLOSED_COPIES_LIMIT,
      }),
    ]);
    return {
      open: open.map((copy) =>
        toCopyPositionResponse(copy, this.bookState.readMark(copy.coin)),
      ),
      closed: closed.map((copy) => toCopyPositionResponse(copy, null)),
    };
  }

  @Get(':book/equity')
  async listEquity(
    @Param('book', new ZodValidationPipe(bookSchema, 'invalid_path'))
    book: BookName,
    @Query(new ZodValidationPipe(equityQuerySchema, 'invalid_query'))
    query: z.output<typeof equityQuerySchema>,
  ): Promise<BookEquityPointResponse[]> {
    const snapshots = await this.prisma.bookSnapshot.findMany({
      where: {
        book,
        takenAt: { gte: new Date(Date.now() - query.days * DAY_MS) },
      },
      orderBy: { takenAt: 'asc' },
    });
    return thinPoints(snapshots, MAX_EQUITY_POINTS).map(
      toBookEquityPointResponse,
    );
  }

  @Post('main/kill-switch')
  @HttpCode(HttpStatus.OK)
  async setKillSwitch(
    @Body(new ZodValidationPipe(killSwitchSchema, 'invalid_body'))
    body: z.output<typeof killSwitchSchema>,
  ): Promise<KillSwitchResponse> {
    await this.killSwitch.setKillSwitch(
      body.active,
      body.active ? (body.reason ?? 'manual') : null,
    );
    return this.killSwitch.readKillSwitch();
  }
}
