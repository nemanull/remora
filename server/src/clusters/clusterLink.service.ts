import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import {
  CLUSTER_CLOSE_CODES,
  parseCollectorFrame,
  PROTOCOL_VERSION,
  type ClusterCloseReason,
  type CollectorMessage,
  type HeartbeatAckMessage,
  type HelloMessage,
} from '@remora/sdk';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerConfig } from '../config';
import { FillIngestionService } from '../ingestion/fillIngestion.service';
import { LeaderStateService } from '../ingestion/leaderState.service';
import { isDataError } from '../ingestion/storageErrors';
import { SyncStateService } from '../ingestion/syncState.service';
import { MarketDataService } from '../market/marketData.service';
import { AssignmentService } from './assignment.service';
import {
  ClusterRegistryService,
  type ClusterSession,
} from './clusterRegistry.service';

const CLUSTER_PATH = '/cluster';
const SILENCE_LIMIT_MS = 30_000;
const SILENCE_CHECK_INTERVAL_MS = 5_000;
const SHUTDOWN_CLOSE_TIMEOUT_MS = 2_000;
const GOING_AWAY_CODE = 1001;

type ClusterConnection = {
  key: number;
  clusterId: number;
  socket: WebSocket;
  queue: Promise<void>;
  hasHello: boolean;
  session: ClusterSession | null;
  isClosed: boolean;
  lastFrameAt: number;
};

function decodeFrame(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function describeMessage(message: CollectorMessage): string {
  return message.type === 'event'
    ? `${message.channel} ${message.source} frame of ${message.wallet}`
    : `${message.type} frame`;
}

@Injectable()
export class ClusterLinkService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ClusterLinkService.name);
  private readonly tokenHashes: { clusterId: number; hash: Buffer }[];
  private readonly connections = new Set<ClusterConnection>();
  private server: WebSocketServer;
  private httpServer: Server | null = null;
  private silenceTimer: NodeJS.Timeout | undefined;
  private nextConnectionKey = 1;
  private isStopped = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: ClusterRegistryService,
    private readonly assignment: AssignmentService,
    private readonly fillIngestion: FillIngestionService,
    private readonly syncState: SyncStateService,
    private readonly leaderState: LeaderStateService,
    private readonly marketData: MarketDataService,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.tokenHashes = config
      .getOrThrow('CLUSTER_TOKEN_HASHES', { infer: true })
      .map(({ clusterId, tokenHash }) => ({
        clusterId,
        hash: Buffer.from(tokenHash, 'hex'),
      }));
  }

  onModuleInit(): void {
    this.server = new WebSocketServer({ noServer: true });
    this.silenceTimer = setInterval(
      () => this.terminateSilentConnections(Date.now()),
      SILENCE_CHECK_INTERVAL_MS,
    );
  }

  onApplicationBootstrap(): void {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer.on('upgrade', this.handleUpgrade);
  }

  async onModuleDestroy(): Promise<void> {
    this.isStopped = true;
    clearInterval(this.silenceTimer);
    this.httpServer?.off('upgrade', this.handleUpgrade);
    const closed = [...this.connections].map(
      (connection) =>
        new Promise<void>((resolve) => {
          if (connection.socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          connection.socket.once('close', () => resolve());
          this.closeConnection(connection, GOING_AWAY_CODE, 'server_shutdown');
        }),
    );
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_CLOSE_TIMEOUT_MS).unref(),
    );
    await Promise.race([Promise.all(closed), timeout]);
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    this.server.close();
  }

  closeSession(clusterId: number, reason: ClusterCloseReason): boolean {
    for (const connection of this.connections) {
      if (connection.clusterId === clusterId && !connection.isClosed) {
        this.closeConnection(connection, CLUSTER_CLOSE_CODES[reason], reason);
        return true;
      }
    }
    return false;
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== CLUSTER_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const clusterId = this.authenticate(request.headers.authorization);
    if (clusterId === null) {
      this.logger.warn(
        `Refused a cluster link from ${request.socket.remoteAddress} with a missing or unknown token`,
      );
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (this.isStopped || !this.marketData.hasMarkets()) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    this.server.handleUpgrade(request, socket, head, (webSocket) =>
      this.acceptConnection(webSocket, clusterId),
    );
  };

  private authenticate(header: string | undefined): number | null {
    const match = /^Bearer (\S+)$/.exec(header ?? '');
    if (!match) {
      return null;
    }
    const digest = createHash('sha256').update(match[1]).digest();
    let clusterId: number | null = null;
    for (const entry of this.tokenHashes) {
      if (timingSafeEqual(digest, entry.hash)) {
        clusterId = entry.clusterId;
      }
    }
    return clusterId;
  }

  private acceptConnection(socket: WebSocket, clusterId: number): void {
    const connection: ClusterConnection = {
      key: this.nextConnectionKey,
      clusterId,
      socket,
      queue: Promise.resolve(),
      hasHello: false,
      session: null,
      isClosed: false,
      lastFrameAt: Date.now(),
    };
    this.nextConnectionKey += 1;
    this.connections.add(connection);
    socket.on('message', (data) =>
      this.receiveFrame(connection, decodeFrame(data)),
    );
    socket.on('error', (error) =>
      this.logger.warn(`Cluster ${clusterId} link error: ${error.message}`),
    );
    socket.on('close', (code, reason) =>
      this.handleClose(connection, code, reason.toString()),
    );
  }

  private receiveFrame(connection: ClusterConnection, raw: string): void {
    if (connection.isClosed) {
      return;
    }
    connection.lastFrameAt = Date.now();
    const parsed = parseCollectorFrame(raw);
    if (!parsed.ok) {
      this.logger.warn(
        `Dropped a frame from cluster ${connection.clusterId}: ${parsed.reason}`,
      );
      return;
    }
    const message = parsed.message;
    if (message.type === 'hello') {
      if (connection.hasHello) {
        this.closeForProtocolError(connection, 'sent a second hello');
        return;
      }
      connection.hasHello = true;
    } else if (!connection.hasHello) {
      this.closeForProtocolError(
        connection,
        `sent ${message.type} before hello`,
      );
      return;
    }
    if (message.type === 'heartbeat') {
      this.sendHeartbeatAck(connection, message.sentAt);
    }
    connection.queue = connection.queue.then(() =>
      this.processFrame(connection, message),
    );
  }

  private async processFrame(
    connection: ClusterConnection,
    message: CollectorMessage,
  ): Promise<void> {
    if (connection.isClosed) {
      return;
    }
    try {
      await this.handleMessage(connection, message);
    } catch (error) {
      const stack = error instanceof Error ? error.stack : String(error);
      if (isDataError(error)) {
        this.logger.error(
          `Dropped the ${describeMessage(message)} from cluster ${connection.clusterId} after a data error`,
          stack,
        );
        return;
      }
      this.logger.error(
        `Closing the session of cluster ${connection.clusterId} after a storage failure on the ${describeMessage(message)}`,
        stack,
      );
      this.closeConnection(
        connection,
        CLUSTER_CLOSE_CODES.storage_unavailable,
        'storage_unavailable',
      );
    }
  }

  private async handleMessage(
    connection: ClusterConnection,
    message: CollectorMessage,
  ): Promise<void> {
    if (message.type === 'hello') {
      await this.openSession(connection, message);
      return;
    }
    const session = connection.session;
    if (!session) {
      return;
    }
    switch (message.type) {
      case 'heartbeat':
        this.registry.recordHeartbeat(session, message);
        return;
      case 'assigned':
        this.assignment.handleAssigned(session, message);
        return;
      case 'syncStarted':
        this.syncState.markSyncStarted(session.key, message.wallets);
        this.logger.log(
          `Cluster ${session.clusterId} restarted the sync of ${message.wallets.length} wallets after an upstream reconnect`,
        );
        return;
      case 'synced':
        await this.syncState.completeSync(
          session.key,
          session.clusterId,
          message.wallet,
        );
        return;
      case 'event':
        if (message.channel === 'userFills') {
          await this.fillIngestion.ingestFills(
            session.key,
            session.clusterId,
            message,
          );
        } else if (message.channel === 'clearinghouseState') {
          await this.leaderState.applyClearinghouseState(
            message.wallet,
            message.payload,
          );
        } else {
          await this.leaderState.applyPortfolio(
            message.wallet,
            message.payload,
          );
        }
        return;
    }
  }

  private async openSession(
    connection: ClusterConnection,
    hello: HelloMessage,
  ): Promise<void> {
    if (hello.clusterId !== connection.clusterId) {
      this.closeForProtocolError(
        connection,
        `said hello as cluster ${hello.clusterId}`,
      );
      return;
    }
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.closeForProtocolError(
        connection,
        `speaks protocol ${hello.protocolVersion} instead of ${PROTOCOL_VERSION}`,
      );
      return;
    }
    const previous = this.findOpenConnection(connection.clusterId, connection);
    if (previous) {
      this.logger.warn(
        `Cluster ${connection.clusterId} opened a new session, closing the older one`,
      );
      this.closeConnection(previous, CLUSTER_CLOSE_CODES.replaced, 'replaced');
    }
    const session: ClusterSession = {
      key: connection.key,
      clusterId: connection.clusterId,
      socket: connection.socket,
      collectorSessionId: hello.sessionId,
      maxWallets: hello.maxWallets,
      version: hello.version,
      connectedAt: new Date(),
      assignedWallets: null,
    };
    await this.registry.openSession(session, hello);
    if (connection.isClosed) {
      this.registry.closeSession(session);
      return;
    }
    connection.session = session;
    this.assignment.requestAssignment('cluster_connected');
  }

  private findOpenConnection(
    clusterId: number,
    except: ClusterConnection,
  ): ClusterConnection | null {
    for (const connection of this.connections) {
      if (
        connection !== except &&
        connection.clusterId === clusterId &&
        connection.hasHello &&
        !connection.isClosed
      ) {
        return connection;
      }
    }
    return null;
  }

  private sendHeartbeatAck(
    connection: ClusterConnection,
    sentAt: number,
  ): void {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const ack: HeartbeatAckMessage = {
      type: 'heartbeatAck',
      sentAt,
      serverTime: Date.now(),
    };
    connection.socket.send(JSON.stringify(ack));
  }

  private closeForProtocolError(
    connection: ClusterConnection,
    detail: string,
  ): void {
    this.logger.warn(
      `Closing the link of cluster ${connection.clusterId}, which ${detail}`,
    );
    this.closeConnection(
      connection,
      CLUSTER_CLOSE_CODES.protocol_error,
      'protocol_error',
    );
  }

  private closeConnection(
    connection: ClusterConnection,
    code: number,
    reason: string,
  ): void {
    connection.isClosed = true;
    if (
      connection.socket.readyState === WebSocket.OPEN ||
      connection.socket.readyState === WebSocket.CONNECTING
    ) {
      connection.socket.close(code, reason);
    }
  }

  private handleClose(
    connection: ClusterConnection,
    code: number,
    reason: string,
  ): void {
    connection.isClosed = true;
    this.connections.delete(connection);
    this.syncState.endSession(connection.key);
    const session = connection.session;
    if (!session) {
      return;
    }
    this.logger.log(
      `Session of cluster ${session.clusterId} closed with code ${code}${reason ? ` ${reason}` : ''}`,
    );
    const wasCurrent = this.registry.closeSession(session);
    if (wasCurrent && !this.isStopped) {
      this.assignment.requestAssignment('cluster_disconnected');
      this.assignment.requestAssignmentAfterGrace();
    }
  }

  private terminateSilentConnections(now: number): void {
    for (const connection of this.connections) {
      if (now - connection.lastFrameAt < SILENCE_LIMIT_MS) {
        continue;
      }
      this.logger.warn(
        `Terminating the link of cluster ${connection.clusterId} after ${Math.round((now - connection.lastFrameAt) / 1_000)} s of silence`,
      );
      connection.isClosed = true;
      connection.socket.terminate();
    }
  }
}
