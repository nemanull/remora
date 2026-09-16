import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AssignedMessage, AssignMessage } from '@remora/sdk';
import WebSocket from 'ws';
import type { ServerConfig } from '../config';
import { CopyEvents } from '../copy/copyEvents';
import { SyncStateService } from '../ingestion/syncState.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClusterRegistryService,
  type ClusterSession,
} from './clusterRegistry.service';
import {
  assignWallets,
  type AssignmentResult,
  type AssignmentWallet,
} from './walletAssignment';

const ASSIGNMENT_INTERVAL_MS = 30_000;
const GRACE_MARGIN_MS = 500;
const UNSUBSCRIBED_ALERT_MS = 120_000;

type WalletRow = {
  address: string;
  status: AssignmentWallet['status'];
  source: 'LEADERBOARD' | 'MANUAL';
  score: number | null;
  trackedSince: Date | null;
  fillsSyncedUntil: Date | null;
  clusterId: number | null;
  positions: { id: bigint }[];
};

type AssignedWallet = {
  address: string;
  trackedSince: Date;
  fillsSince: number;
};

type AssignmentChanges = {
  movedRows: WalletRow[];
  newlyTrackedRows: WalletRow[];
  clusterIds: number[];
  walletsByCluster: Map<number, AssignedWallet[]>;
};

function isTracked(wallet: WalletRow): boolean {
  return (
    wallet.status === 'SHADOW' ||
    wallet.status === 'LIVE' ||
    wallet.positions.length > 0
  );
}

function hasSameWallets(
  sent: readonly string[] | null,
  wallets: readonly AssignedWallet[],
): boolean {
  if (sent === null || sent.length !== wallets.length) {
    return false;
  }
  const listed = new Set(sent);
  return wallets.every((wallet) => listed.has(wallet.address));
}

@Injectable()
export class AssignmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssignmentService.name);
  private readonly graceMs: number;
  private isRunning = false;
  private queuedReason: string | null = null;
  private isStopped = false;
  private assignmentTimer: NodeJS.Timeout | undefined;
  private readonly graceTimers = new Set<NodeJS.Timeout>();
  private loggedWaiting: string | null = null;
  private readonly unsubscribedSince = new Map<string, number>();
  private readonly alertedUnsubscribed = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ClusterRegistryService,
    private readonly syncState: SyncStateService,
    private readonly events: CopyEvents,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.graceMs = config.getOrThrow('ASSIGNMENT_GRACE_MS', { infer: true });
  }

  onModuleInit(): void {
    this.assignmentTimer = setInterval(
      () => this.requestAssignment('timer'),
      ASSIGNMENT_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    this.isStopped = true;
    clearInterval(this.assignmentTimer);
    for (const timer of this.graceTimers) {
      clearTimeout(timer);
    }
    this.graceTimers.clear();
  }

  requestAssignment(reason: string): void {
    if (this.isStopped) {
      return;
    }
    if (this.isRunning) {
      this.queuedReason = reason;
      return;
    }
    void this.runAssignment(reason);
  }

  requestAssignmentAfterGrace(): void {
    if (this.isStopped) {
      return;
    }
    const timer = setTimeout(() => {
      this.graceTimers.delete(timer);
      this.requestAssignment('grace_expired');
    }, this.graceMs + GRACE_MARGIN_MS);
    this.graceTimers.add(timer);
  }

  handleAssigned(session: ClusterSession, assigned: AssignedMessage): void {
    this.syncState.markAssignApplied(session.key, assigned.version);
    this.registry.recordAssigned(session, assigned);
    const summary = `Cluster ${session.clusterId} applied assign version ${assigned.version}: ${assigned.subscribed.length} subscribed, ${assigned.failed.length} failed`;
    if (assigned.failed.length === 0) {
      this.logger.log(summary);
      return;
    }
    const failures = assigned.failed
      .map((failure) => `${failure.address} ${failure.reason}`)
      .join(', ');
    this.logger.warn(`${summary} (${failures})`);
    this.requestAssignment('wallets_refused');
  }

  private async runAssignment(reason: string): Promise<void> {
    this.isRunning = true;
    try {
      await this.assign(reason);
    } catch (error) {
      this.logger.error(
        `Assignment after ${reason} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isRunning = false;
      const queuedReason = this.queuedReason;
      this.queuedReason = null;
      if (queuedReason !== null) {
        this.requestAssignment(queuedReason);
      }
    }
  }

  private async assign(reason: string): Promise<void> {
    const now = new Date();
    const rows = await this.loadWallets();
    const tracked = rows.filter(isTracked);
    const current = new Map<string, number>();
    for (const row of rows) {
      if (row.clusterId !== null) {
        current.set(row.address, row.clusterId);
      }
    }
    const result = assignWallets({
      wallets: tracked.map((row) => ({
        address: row.address,
        status: row.status,
        isManual: row.source === 'MANUAL',
        hasOpenCopy: row.positions.length > 0,
        score: row.score,
      })),
      clusters: this.registry.listAssignmentClusters(current.values()),
      current,
      now,
      graceMs: this.graceMs,
    });
    const changes = this.findChanges(rows, tracked, result, now);
    if (changes.clusterIds.length > 0 || changes.newlyTrackedRows.length > 0) {
      const versions = await this.persistChanges(changes, result, now);
      for (const clusterId of changes.clusterIds) {
        const session = this.registry.readSession(clusterId);
        const version = versions.get(clusterId);
        if (session && version !== undefined) {
          this.sendAssign(
            session,
            version,
            changes.walletsByCluster.get(clusterId) ?? [],
          );
        }
      }
    }
    this.logWaiting(result.waiting, reason);
    this.checkUnsubscribedWallets(tracked, result, now.getTime());
  }

  private loadWallets(): Promise<WalletRow[]> {
    return this.prisma.wallet.findMany({
      where: {
        OR: [
          { status: { in: ['SHADOW', 'LIVE'] } },
          { clusterId: { not: null } },
          { positions: { some: { isOpen: true } } },
        ],
      },
      select: {
        address: true,
        status: true,
        source: true,
        score: true,
        trackedSince: true,
        fillsSyncedUntil: true,
        clusterId: true,
        positions: { where: { isOpen: true }, select: { id: true }, take: 1 },
      },
    });
  }

  private findChanges(
    rows: readonly WalletRow[],
    tracked: readonly WalletRow[],
    result: AssignmentResult,
    now: Date,
  ): AssignmentChanges {
    const movedRows = rows.filter(
      (row) => (result.assignments.get(row.address) ?? null) !== row.clusterId,
    );
    const newlyTrackedRows = tracked.filter(
      (row) => row.trackedSince === null && result.assignments.has(row.address),
    );
    const walletsByCluster = new Map<number, AssignedWallet[]>();
    for (const row of tracked) {
      const clusterId = result.assignments.get(row.address);
      if (clusterId === undefined) {
        continue;
      }
      const trackedSince = row.trackedSince ?? now;
      const wallets = walletsByCluster.get(clusterId) ?? [];
      wallets.push({
        address: row.address,
        trackedSince,
        fillsSince: Math.max(
          row.fillsSyncedUntil?.getTime() ?? 0,
          trackedSince.getTime(),
        ),
      });
      walletsByCluster.set(clusterId, wallets);
    }
    const clusterIds = new Set<number>();
    for (const row of movedRows) {
      if (row.clusterId !== null) {
        clusterIds.add(row.clusterId);
      }
      const next = result.assignments.get(row.address);
      if (next !== undefined) {
        clusterIds.add(next);
      }
    }
    for (const session of this.registry.listSessions()) {
      const wallets = walletsByCluster.get(session.clusterId) ?? [];
      if (!hasSameWallets(session.assignedWallets, wallets)) {
        clusterIds.add(session.clusterId);
      }
    }
    return {
      movedRows,
      newlyTrackedRows,
      clusterIds: [...clusterIds],
      walletsByCluster,
    };
  }

  private async persistChanges(
    changes: AssignmentChanges,
    result: AssignmentResult,
    now: Date,
  ): Promise<Map<number, number>> {
    const changedRows = new Map<string, WalletRow>();
    for (const row of [...changes.movedRows, ...changes.newlyTrackedRows]) {
      changedRows.set(row.address, row);
    }
    const walletUpdates = [...changedRows.values()].map((row) => {
      const clusterId = result.assignments.get(row.address) ?? null;
      return this.prisma.wallet.update({
        where: { address: row.address },
        data: {
          clusterId,
          trackedSince:
            row.trackedSince === null && clusterId !== null
              ? now
              : row.trackedSince,
        },
        select: { address: true },
      });
    });
    const clusterUpdates = changes.clusterIds.map((id) =>
      this.prisma.cluster.update({
        where: { id },
        data: { assignVersion: { increment: 1 } },
        select: { id: true, assignVersion: true },
      }),
    );
    const results = await this.prisma.$transaction([
      ...walletUpdates,
      ...clusterUpdates,
    ]);
    const versionByCluster = new Map<number, number>();
    for (const entry of results.slice(walletUpdates.length)) {
      if ('assignVersion' in entry) {
        versionByCluster.set(entry.id, entry.assignVersion);
      }
    }
    return versionByCluster;
  }

  private sendAssign(
    session: ClusterSession,
    version: number,
    wallets: readonly AssignedWallet[],
  ): void {
    if (session.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const message: AssignMessage = {
      type: 'assign',
      version,
      wallets: wallets.map(({ address, fillsSince }) => ({
        address,
        fillsSince,
      })),
    };
    session.socket.send(JSON.stringify(message));
    session.assignedWallets = wallets.map((wallet) => wallet.address);
    this.syncState.markAssigned(session.key, version, wallets);
    this.logger.log(
      `Sent assign version ${version} with ${wallets.length} wallets to cluster ${session.clusterId}`,
    );
  }

  private logWaiting(waiting: readonly string[], reason: string): void {
    const description = waiting.join(', ');
    if (description === this.loggedWaiting) {
      return;
    }
    this.loggedWaiting = description;
    if (waiting.length === 0) {
      this.logger.log(`Every tracked wallet has a collector after ${reason}`);
      return;
    }
    this.logger.warn(
      `${waiting.length} tracked wallets wait for collector capacity after ${reason}: ${description}`,
    );
  }

  private checkUnsubscribedWallets(
    tracked: readonly WalletRow[],
    result: AssignmentResult,
    now: number,
  ): void {
    const subscribed = this.registry.readSubscribedWallets();
    const trackedAddresses = new Set(tracked.map((row) => row.address));
    for (const address of [...this.unsubscribedSince.keys()]) {
      if (!trackedAddresses.has(address) || subscribed.has(address)) {
        this.unsubscribedSince.delete(address);
        this.alertedUnsubscribed.delete(address);
      }
    }
    for (const address of trackedAddresses) {
      if (subscribed.has(address)) {
        continue;
      }
      const since = this.unsubscribedSince.get(address) ?? now;
      this.unsubscribedSince.set(address, since);
      if (
        now - since < UNSUBSCRIBED_ALERT_MS ||
        this.alertedUnsubscribed.has(address)
      ) {
        continue;
      }
      this.alertedUnsubscribed.add(address);
      const clusterId = result.assignments.get(address) ?? null;
      const seconds = Math.round((now - since) / 1_000);
      const message =
        clusterId === null
          ? `Tracked wallet ${address} has had no subscription for ${seconds} s and waits for collector capacity`
          : `Tracked wallet ${address} has had no subscription on cluster ${clusterId} for ${seconds} s`;
      this.logger.warn(message);
      this.events.publish({
        type: 'alert',
        code: 'wallet_unsubscribed',
        message,
        wallet: address,
        clusterId,
      });
    }
  }
}
