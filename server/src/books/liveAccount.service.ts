import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HyperliquidInfoClient } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { ServerConfig } from '../config';

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const decimalString = z.string().regex(DECIMAL_PATTERN);

const clearinghouseStateSchema = z.object({
  marginSummary: z.object({ accountValue: decimalString }),
  withdrawable: decimalString,
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: decimalString,
        entryPx: decimalString.nullish(),
      }),
    }),
  ),
  time: z.number().int().nonnegative(),
});

export type AccountPosition = {
  coin: string;
  size: Decimal;
  entryPx: Decimal | null;
};

export type LiveAccount = {
  equityUsd: Decimal;
  withdrawableUsd: Decimal;
  positions: AccountPosition[];
  time: Date;
};

export function readLiveAccount(response: unknown): LiveAccount {
  const state = clearinghouseStateSchema.parse(response);
  return {
    equityUsd: new Decimal(state.marginSummary.accountValue),
    withdrawableUsd: new Decimal(state.withdrawable),
    positions: state.assetPositions.map(({ position }) => ({
      coin: position.coin,
      size: new Decimal(position.szi),
      entryPx:
        position.entryPx === null || position.entryPx === undefined
          ? null
          : new Decimal(position.entryPx),
    })),
    time: new Date(state.time),
  };
}

@Injectable()
export class LiveAccountService {
  private readonly logger = new Logger(LiveAccountService.name);
  private readonly accountAddress: string | null;
  private account: LiveAccount | null = null;
  private refreshing: Promise<LiveAccount> | null = null;

  constructor(
    private readonly infoClient: HyperliquidInfoClient,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.accountAddress =
      config.getOrThrow('EXECUTION_MODE', { infer: true }) === 'live'
        ? config.getOrThrow('HYPERLIQUID_ACCOUNT_ADDRESS', { infer: true })
        : null;
  }

  isLive(): boolean {
    return this.accountAddress !== null;
  }

  readAccountAddress(): string {
    if (this.accountAddress === null) {
      throw new Error('The live account is only known in live mode');
    }
    return this.accountAddress;
  }

  async readAccount(): Promise<LiveAccount> {
    return this.account ?? (await this.refreshAccount());
  }

  refreshAccount(): Promise<LiveAccount> {
    this.refreshing ??= this.fetchAccount().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fetchAccount(): Promise<LiveAccount> {
    const address = this.readAccountAddress();
    const account = readLiveAccount(
      await this.infoClient.clearinghouseState(address),
    );
    this.account = account;
    this.logger.debug(
      `Live account ${address} holds ${account.equityUsd.toFixed(2)} USD with ${account.positions.length} positions`,
    );
    return account;
  }
}
