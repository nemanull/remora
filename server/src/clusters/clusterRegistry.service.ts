import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  AssignedMessage,
  BackfillState,
  CollectorStats,
  HeartbeatMessage,
  HelloMessage,
} from '@remora/sdk';
import type { WebSocket } from 'ws';
import { CopyEvents } from '../copy/copyEvents';
import { Prisma } from '../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AssignmentCluster } from './walletAssignment';

const SILENCE_ALERT_MS = 60_000;
const SILENCE_CHECK_INTERVAL_MS = 5_000;
const CLOCK_OFFSET_LIMIT_MS = 50;
const BACKFILL_RETRY_ALERT_MS = 60_000;
const CAPACITY_FAILURES = new Set(['user_limit', 'over_capacity']);

export type ClusterSession = {
  key: number;
  clusterId: number;
  socket: WebSocket;
  collectorSessionId: string;
  maxWallets: number;
  version: string;
  connectedAt: Date;
  assignedWallets: string[] | null;
};

type WalletBackfill = {
  state: BackfillState;
  since: number;
  isAlerted: boolean;
};

type ClusterStatus = {
  id: number;
  session: ClusterSession | null;
  capacity: number;
  offlineSince: Date | null;
  refusedWallets: Set<string>;
  lastStats: CollectorStats | null;
  lastSeenAt: number;
  reportedReconnects: { collectorSessionId: string; count: number } | null;
  isSilent: boolean;
  isClockOffsetHigh: boolean;
  backfills: Map<string, WalletBackfill>;
  eventAgeWallets: Set<string>;
};

@Injectable()
export class ClusterRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClusterRegistryService.name);
  private readonly clusters = new Map<number, ClusterStatus>();
  private readonly bootedAt = new Date();
  private silenceTimer: NodeJS.Timeout | undefined;
  private isStopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly events: CopyEvents,
  ) {}

  async onModuleInit(): Promise<void> {
    this.silenceTimer = setInterval(
      () => this.checkSilence(Date.now()),
      SILENCE_CHECK_INTERVAL_MS,
    );
    try {
      await this.prisma.cluster.updateMany({ data: { isOnline: false } });
      const known = await this.prisma.cluster.findMany({
        select: { id: true, maxWallets: true },
      });
      for (const cluster of known) {
        this.readStatus(cluster.id).capacity = cluster.maxWallets ?? 0;
        this.metrics.collectorOnline.set({ cluster: String(cluster.id) }, 0);
      }
    } catch (error) {
      this.logger.error(
        'Failed to load the known clusters at boot',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  onModuleDestroy(): void {
    this.isStopped = true;
    clearInterval(this.silenceTimer);
  }

  readSession(clusterId: number): ClusterSession | null {
    return this.clusters.get(clusterId)?.session ?? null;
  }

  listSessions(): ClusterSession[] {
    const sessions: ClusterSession[] = [];
    for (const status of this.clusters.values()) {
      if (status.session) {
        sessions.push(status.session);
      }
    }
    return sessions;
  }

  readLastStats(clusterId: number): CollectorStats | null {
    return this.clusters.get(clusterId)?.lastStats ?? null;
  }

  async openSession(
    session: ClusterSession,
    hello: HelloMessage,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.cluster.upsert({
      where: { id: session.clusterId },
      create: {
        id: session.clusterId,
        isOnline: true,
        sessionId: hello.sessionId,
        version: hello.version,
        maxWallets: hello.maxWallets,
        connectedAt: now,
        lastHeartbeatAt: now,
      },
      update: {
        isOnline: true,
        sessionId: hello.sessionId,
        version: hello.version,
        maxWallets: hello.maxWallets,
        connectedAt: now,
        lastHeartbeatAt: now,
        lastStats: Prisma.DbNull,
      },
    });
    const status = this.readStatus(session.clusterId);
    status.session = session;
    status.lastStats = null;
    status.capacity = hello.maxWallets;
    status.offlineSince = null;
    status.refusedWallets = new Set();
    status.lastSeenAt = now.getTime();
    status.isSilent = false;
    this.metrics.collectorOnline.set({ cluster: String(session.clusterId) }, 1);
    this.events.publish({
      type: 'collector',
      clusterId: session.clusterId,
      change: 'connected',
      stats: status.lastStats,
    });
    this.logger.log(
      `Cluster ${session.clusterId} connected with session ${hello.sessionId}, collector ${hello.version}, capacity ${hello.maxWallets}`,
    );
  }

  closeSession(session: ClusterSession): boolean {
    const status = this.clusters.get(session.clusterId);
    if (!status || status.session !== session) {
      return false;
    }
    status.session = null;
    status.offlineSince = new Date();
    const cluster = String(session.clusterId);
    this.metrics.collectorOnline.set({ cluster }, 0);
    this.metrics.collectorWallets.set({ cluster }, 0);
    this.events.publish({
      type: 'collector',
      clusterId: session.clusterId,
      change: 'disconnected',
      stats: status.lastStats,
    });
    if (!this.isStopped) {
      this.prisma.cluster
        .update({ where: { id: session.clusterId }, data: { isOnline: false } })
        .catch((error) =>
          this.logger.error(
            `Failed to mark cluster ${session.clusterId} offline`,
            error instanceof Error ? error.stack : String(error),
          ),
        );
    }
    return true;
  }

  recordHeartbeat(session: ClusterSession, heartbeat: HeartbeatMessage): void {
    const status = this.clusters.get(session.clusterId);
    if (!status || status.session !== session) {
      return;
    }
    const now = Date.now();
    const { stats } = heartbeat;
    status.lastStats = stats;
    status.lastSeenAt = now;
    status.isSilent = false;
    this.recordCollectorMetrics(status, session, heartbeat);
    this.checkClockOffset(status, stats);
    this.checkBackfills(status, stats, now);
    this.events.publish({
      type: 'collector',
      clusterId: session.clusterId,
      change: 'heartbeat',
      stats,
    });
    this.prisma.cluster
      .update({
        where: { id: session.clusterId },
        data: { lastHeartbeatAt: new Date(now), lastStats: stats },
      })
      .catch((error) =>
        this.logger.error(
          `Failed to store the heartbeat of cluster ${session.clusterId}`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }

  recordAssigned(session: ClusterSession, assigned: AssignedMessage): void {
    const status = this.clusters.get(session.clusterId);
    if (!status || status.session !== session) {
      return;
    }
    for (const failure of assigned.failed) {
      status.refusedWallets.add(failure.address);
    }
    const hasCapacityFailure = assigned.failed.some((failure) =>
      CAPACITY_FAILURES.has(failure.reason),
    );
    if (hasCapacityFailure && assigned.subscribed.length < status.capacity) {
      status.capacity = assigned.subscribed.length;
      this.logger.warn(
        `Cluster ${session.clusterId} capacity lowered to ${status.capacity} after Hyperliquid refused wallets`,
      );
    }
    this.events.publish({
      type: 'collector',
      clusterId: session.clusterId,
      change: 'assigned',
      stats: status.lastStats,
    });
  }

  listAssignmentClusters(
    referencedClusterIds: Iterable<number>,
  ): AssignmentCluster[] {
    const clusters = new Map<number, AssignmentCluster>();
    for (const status of this.clusters.values()) {
      clusters.set(status.id, {
        id: status.id,
        isOnline: status.session !== null,
        capacity: status.capacity,
        offlineSince: status.session
          ? null
          : (status.offlineSince ?? this.bootedAt),
        refusedWallets: status.refusedWallets,
      });
    }
    for (const id of referencedClusterIds) {
      if (!clusters.has(id)) {
        clusters.set(id, {
          id,
          isOnline: false,
          capacity: 0,
          offlineSince: this.bootedAt,
          refusedWallets: new Set(),
        });
      }
    }
    return [...clusters.values()];
  }

  readSubscribedWallets(): Set<string> {
    const subscribed = new Set<string>();
    for (const status of this.clusters.values()) {
      if (!status.session || !status.lastStats) {
        continue;
      }
      for (const wallet of status.lastStats.wallets) {
        if (wallet.subscribedAt !== null) {
          subscribed.add(wallet.address);
        }
      }
    }
    return subscribed;
  }

  private readStatus(clusterId: number): ClusterStatus {
    let status = this.clusters.get(clusterId);
    if (!status) {
      status = {
        id: clusterId,
        session: null,
        capacity: 0,
        offlineSince: this.bootedAt,
        refusedWallets: new Set(),
        lastStats: null,
        lastSeenAt: this.bootedAt.getTime(),
        reportedReconnects: null,
        isSilent: false,
        isClockOffsetHigh: false,
        backfills: new Map(),
        eventAgeWallets: new Set(),
      };
      this.clusters.set(clusterId, status);
    }
    return status;
  }

  private recordCollectorMetrics(
    status: ClusterStatus,
    session: ClusterSession,
    heartbeat: HeartbeatMessage,
  ): void {
    const { stats } = heartbeat;
    const cluster = String(status.id);
    this.metrics.collectorWallets.set({ cluster }, stats.wallets.length);
    if (stats.clockOffsetMs !== null) {
      this.metrics.collectorClockOffsetMs.set({ cluster }, stats.clockOffsetMs);
    }
    if (stats.eventLoopDelayP99Ms !== null) {
      this.metrics.collectorEventLoopDelayP99Ms.set(
        { cluster },
        stats.eventLoopDelayP99Ms,
      );
    }
    const reported = status.reportedReconnects;
    const baseline =
      reported?.collectorSessionId === session.collectorSessionId
        ? reported.count
        : 0;
    if (stats.upstreamReconnects > baseline) {
      this.metrics.collectorUpstreamReconnectsTotal.inc(
        { cluster },
        stats.upstreamReconnects - baseline,
      );
    }
    status.reportedReconnects = {
      collectorSessionId: session.collectorSessionId,
      count: stats.upstreamReconnects,
    };
    const walletsWithEvents = new Set<string>();
    for (const wallet of stats.wallets) {
      if (wallet.lastEventAt === null) {
        continue;
      }
      walletsWithEvents.add(wallet.address);
      this.metrics.collectorLastEventAgeSeconds.set(
        { cluster, wallet: wallet.address },
        Math.max(0, heartbeat.sentAt - wallet.lastEventAt) / 1_000,
      );
    }
    for (const wallet of status.eventAgeWallets) {
      if (!walletsWithEvents.has(wallet)) {
        this.metrics.collectorLastEventAgeSeconds.remove({ cluster, wallet });
      }
    }
    status.eventAgeWallets = walletsWithEvents;
  }

  private checkClockOffset(status: ClusterStatus, stats: CollectorStats): void {
    const offset = stats.clockOffsetMs;
    const isHigh = offset !== null && Math.abs(offset) > CLOCK_OFFSET_LIMIT_MS;
    if (isHigh && !status.isClockOffsetHigh) {
      this.raiseAlert(
        'clock_offset',
        `Cluster ${status.id} clock is ${offset} ms off the core, above ${CLOCK_OFFSET_LIMIT_MS} ms`,
        null,
        status.id,
      );
    }
    status.isClockOffsetHigh = isHigh;
  }

  private checkBackfills(
    status: ClusterStatus,
    stats: CollectorStats,
    now: number,
  ): void {
    const backfills = new Map<string, WalletBackfill>();
    for (const wallet of stats.wallets) {
      const previous = status.backfills.get(wallet.address);
      const backfill =
        previous?.state === wallet.backfill
          ? previous
          : { state: wallet.backfill, since: now, isAlerted: false };
      if (backfill.state === 'truncated' && !backfill.isAlerted) {
        backfill.isAlerted = true;
        this.raiseAlert(
          'backfill_truncated',
          `Backfill of ${wallet.address} on cluster ${status.id} reached the 10,000 fill horizon, older fills may be missing`,
          wallet.address,
          status.id,
        );
      }
      if (backfill.state === 'lagging' && !backfill.isAlerted) {
        backfill.isAlerted = true;
        this.raiseAlert(
          'backfill_lagging',
          `Backfill of ${wallet.address} on cluster ${status.id} gave up waiting for the REST history to catch up, recent fills may be missing`,
          wallet.address,
          status.id,
        );
      }
      if (
        backfill.state === 'retrying' &&
        !backfill.isAlerted &&
        now - backfill.since >= BACKFILL_RETRY_ALERT_MS
      ) {
        backfill.isAlerted = true;
        this.raiseAlert(
          'backfill_failed',
          `Backfill of ${wallet.address} on cluster ${status.id} has failed for ${Math.round((now - backfill.since) / 1_000)} s and keeps retrying`,
          wallet.address,
          status.id,
        );
      }
      backfills.set(wallet.address, backfill);
    }
    status.backfills = backfills;
  }

  private checkSilence(now: number): void {
    for (const status of this.clusters.values()) {
      const isSilent = now - status.lastSeenAt >= SILENCE_ALERT_MS;
      if (isSilent && !status.isSilent) {
        this.raiseAlert(
          'collector_silent',
          `Cluster ${status.id} has been silent for ${Math.round((now - status.lastSeenAt) / 1_000)} s`,
          null,
          status.id,
        );
      }
      status.isSilent = isSilent;
    }
  }

  private raiseAlert(
    code: string,
    message: string,
    wallet: string | null,
    clusterId: number,
  ): void {
    this.logger.warn(message);
    this.events.publish({ type: 'alert', code, message, wallet, clusterId });
  }
}
