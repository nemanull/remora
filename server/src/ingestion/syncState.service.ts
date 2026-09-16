import { Injectable, Logger } from '@nestjs/common';
import { CopyDecisionService } from '../copy/copyDecision.service';
import { SignalBuilder } from '../copy/signalBuilder';
import { PrismaService } from '../prisma/prisma.service';

export type AssignedWallet = {
  address: string;
  trackedSince: Date;
};

export type WalletSync = {
  isSynced: boolean;
  addedInVersion: number;
  trackedSince: Date;
  latestFillTime: number | null;
};

type SessionSync = {
  appliedVersion: number;
  wallets: Map<string, WalletSync>;
};

@Injectable()
export class SyncStateService {
  private readonly logger = new Logger(SyncStateService.name);
  private readonly sessions = new Map<number, SessionSync>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly signalBuilder: SignalBuilder,
    private readonly copyDecision: CopyDecisionService,
  ) {}

  markAssigned(
    sessionKey: number,
    version: number,
    wallets: readonly AssignedWallet[],
  ): void {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = { appliedVersion: -1, wallets: new Map() };
      this.sessions.set(sessionKey, session);
    }
    const listed = new Set(wallets.map((wallet) => wallet.address));
    for (const address of session.wallets.keys()) {
      if (!listed.has(address)) {
        session.wallets.delete(address);
      }
    }
    for (const wallet of wallets) {
      const existing = session.wallets.get(wallet.address);
      if (existing) {
        existing.trackedSince = wallet.trackedSince;
        continue;
      }
      session.wallets.set(wallet.address, {
        isSynced: false,
        addedInVersion: version,
        trackedSince: wallet.trackedSince,
        latestFillTime: null,
      });
    }
  }

  markAssignApplied(sessionKey: number, version: number): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.appliedVersion = Math.max(session.appliedVersion, version);
    }
  }

  markSyncStarted(sessionKey: number, wallets: readonly string[]): void {
    const session = this.sessions.get(sessionKey);
    for (const address of wallets) {
      const wallet = session?.wallets.get(address);
      if (wallet) {
        wallet.isSynced = false;
      }
    }
  }

  readWallet(sessionKey: number, address: string): WalletSync | null {
    return this.sessions.get(sessionKey)?.wallets.get(address) ?? null;
  }

  recordFillTime(sessionKey: number, address: string, time: number): void {
    const wallet = this.readWallet(sessionKey, address);
    if (
      wallet &&
      (wallet.latestFillTime === null || time > wallet.latestFillTime)
    ) {
      wallet.latestFillTime = time;
    }
  }

  async completeSync(
    sessionKey: number,
    clusterId: number,
    address: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionKey);
    const wallet = session?.wallets.get(address);
    if (!session || !wallet) {
      this.logger.debug(
        `Ignored synced for ${address} on cluster ${clusterId}, which this session does not hold`,
      );
      return;
    }
    if (wallet.isSynced) {
      return;
    }
    if (wallet.addedInVersion > session.appliedVersion) {
      this.logger.warn(
        `Ignored synced for ${address} on cluster ${clusterId} that came before assigned of version ${wallet.addedInVersion}`,
      );
      return;
    }
    if (wallet.latestFillTime !== null) {
      await this.raiseWatermark(address, new Date(wallet.latestFillTime));
    }
    const signals = await this.signalBuilder.buildCatchUp(
      address,
      wallet.trackedSince,
    );
    wallet.isSynced = true;
    const watermark =
      wallet.latestFillTime === null
        ? 'unchanged'
        : new Date(wallet.latestFillTime).toISOString();
    this.logger.log(
      `Wallet ${address} synced on cluster ${clusterId}, watermark ${watermark}, catch-up of ${signals.length} signals`,
    );
    if (signals.length > 0) {
      this.copyDecision.routeSignals(signals);
    }
  }

  async raiseWatermark(address: string, time: Date): Promise<void> {
    await this.prisma.wallet.updateMany({
      where: {
        address,
        OR: [{ fillsSyncedUntil: null }, { fillsSyncedUntil: { lt: time } }],
      },
      data: { fillsSyncedUntil: time },
    });
  }

  endSession(sessionKey: number): void {
    this.sessions.delete(sessionKey);
  }
}
