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
import type { LeaderDetailResponse, LeaderResponse } from '@remora/sdk';
import { normalizeAddress } from '@remora/sdk';
import { z } from 'zod';
import {
  type LeaderActionResult,
  LeadersService,
} from '../leaders/leaders.service';
import { apiError } from './apiError';
import { LeaderQueriesService } from './leaderQueries.service';
import { ZodValidationPipe } from './zodValidation.pipe';

const leadersQuerySchema = z.object({
  status: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['CANDIDATE', 'SHADOW', 'LIVE', 'RETIRED']))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const addLeaderSchema = z.object({
  address: z.string().trim().min(1),
});

const REJECTION_STATUS: Record<string, HttpStatus> = {
  invalid_address: HttpStatus.BAD_REQUEST,
  wallet_not_found: HttpStatus.NOT_FOUND,
};

@Controller('api/leaders')
export class LeadersController {
  constructor(
    private readonly leaders: LeadersService,
    private readonly queries: LeaderQueriesService,
  ) {}

  @Get()
  listLeaders(
    @Query(new ZodValidationPipe(leadersQuerySchema, 'invalid_query'))
    query: z.output<typeof leadersQuerySchema>,
  ): Promise<LeaderResponse[]> {
    return this.queries.listLeaders(query.status ?? null, query.limit);
  }

  @Get(':address')
  async readLeader(
    @Param('address') input: string,
  ): Promise<LeaderDetailResponse> {
    const address = normalizeAddress(input);
    if (address === null) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        'invalid_address',
        `${input} is not a 0x address`,
      );
    }
    const detail = await this.queries.readLeaderDetail(address);
    if (detail === null) {
      throw apiError(
        HttpStatus.NOT_FOUND,
        'wallet_not_found',
        `No wallet ${address} is registered`,
      );
    }
    return detail;
  }

  @Post()
  async addLeader(
    @Body(new ZodValidationPipe(addLeaderSchema, 'invalid_body'))
    body: z.output<typeof addLeaderSchema>,
  ): Promise<LeaderResponse> {
    return this.respond(await this.leaders.addLeader(body.address));
  }

  @Post(':address/pause')
  @HttpCode(HttpStatus.OK)
  async pauseLeader(
    @Param('address') address: string,
  ): Promise<LeaderResponse> {
    return this.respond(await this.leaders.pauseLeader(address));
  }

  @Post(':address/resume')
  @HttpCode(HttpStatus.OK)
  async resumeLeader(
    @Param('address') address: string,
  ): Promise<LeaderResponse> {
    return this.respond(await this.leaders.resumeLeader(address));
  }

  @Post(':address/promote')
  @HttpCode(HttpStatus.OK)
  async promoteLeader(
    @Param('address') address: string,
  ): Promise<LeaderResponse> {
    return this.respond(await this.leaders.promoteLeader(address));
  }

  @Post(':address/retire')
  @HttpCode(HttpStatus.OK)
  async retireLeader(
    @Param('address') address: string,
  ): Promise<LeaderResponse> {
    return this.respond(await this.leaders.retireLeader(address));
  }

  private async respond(result: LeaderActionResult): Promise<LeaderResponse> {
    if (result.outcome === 'rejected') {
      throw apiError(
        REJECTION_STATUS[result.reason] ?? HttpStatus.CONFLICT,
        result.reason,
        `The leader action was rejected: ${result.reason}`,
        result.details,
      );
    }
    const leader = await this.queries.readLeader(result.leader.address);
    if (leader === null) {
      throw apiError(
        HttpStatus.NOT_FOUND,
        'wallet_not_found',
        `No wallet ${result.leader.address} is registered`,
      );
    }
    return leader;
  }
}
