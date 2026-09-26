import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { IpLimits, normalizeSourceAddress } from '../limits/ipLimits';
import { Simulation } from '../simulation';
import { readClearinghouseState } from '../traders/clearinghouseState';
import { SNAPSHOT_FILL_LIMIT } from '../traders/syntheticTraders';
import { FaultInjection } from '../truth/faultInjection';

const PUSH_INTERVAL_MS = 200;
const STATE_PUSH_INTERVAL_MS = 5_000;
const MIDS_PUSH_INTERVAL_MS = 1_000;
const IDLE_TIMEOUT_MS = 60_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());

const subscriptionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('userFills'),
    user: address,
    aggregateByTime: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('clearinghouseState'),
    user: address,
    dex: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('allMids'), dex: z.string().optional() }),
]);

const clientMessageSchema = z.union([
  z.strictObject({ method: z.literal('ping') }),
  z.strictObject({
    method: z.enum(['subscribe', 'unsubscribe']),
    subscription: subscriptionSchema,
  }),
]);

type ParsedSubscription = z.output<typeof subscriptionSchema>;

type SimSubscription = {
  key: string;
  echo: Record<string, unknown>;
  type: ParsedSubscription['type'];
  user: string | null;
  dex: string;
  deliveredUntil: number;
  nextStatePushAt: number;
};

type SimConnection = {
  id: number;
  ip: string;
  socket: WebSocket;
  subscriptions: Map<string, SimSubscription>;
  lastMessageAt: number;
  queuedFrames: string[];
};

function describeSubscription(subscription: ParsedSubscription): {
  echo: Record<string, unknown>;
  user: string | null;
  dex: string;
} {
  if (subscription.type === 'userFills') {
    return {
      echo: {
        type: 'userFills',
        user: subscription.user,
        aggregateByTime: subscription.aggregateByTime ?? false,
      },
      user: subscription.user,
      dex: '',
    };
  }
  if (subscription.type === 'clearinghouseState') {
    return {
      echo: {
        type: 'clearinghouseState',
        dex: subscription.dex ?? '',
        user: subscription.user,
      },
      user: subscription.user,
      dex: subscription.dex ?? '',
    };
  }
  return {
    echo:
      subscription.dex === undefined
        ? { type: 'allMids' }
        : { type: 'allMids', dex: subscription.dex },
    user: null,
    dex: subscription.dex ?? '',
  };
}

@Injectable()
export class SimSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimSocketService.name);
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<SimConnection>();
  private nextConnectionId = 1;
  private lastMidsPushAt = 0;
  private pushTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly simulation: Simulation,
    private readonly limits: IpLimits,
    private readonly faults: FaultInjection,
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    httpServer.on(
      'upgrade',
      (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        this.handleUpgrade(request, socket, head),
    );
    this.pushTimer = setInterval(() => this.pushUpdates(), PUSH_INTERVAL_MS);
    this.idleTimer = setInterval(
      () => this.closeIdleConnections(),
      IDLE_CHECK_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.pushTimer);
    clearInterval(this.idleTimer);
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    this.server.close();
  }

  readSubscribedUsers(): Map<string, string[]> {
    const usersByIp = new Map<string, Set<string>>();
    for (const connection of this.connections) {
      const users = usersByIp.get(connection.ip) ?? new Set<string>();
      for (const entry of connection.subscriptions.values()) {
        if (entry.type === 'userFills' && entry.user !== null) {
          users.add(entry.user);
        }
      }
      usersByIp.set(connection.ip, users);
    }
    return new Map(
      [...usersByIp].map(([ip, users]) => [ip, [...users].sort()]),
    );
  }

  dropConnections(ip: string | null): number {
    let dropped = 0;
    for (const connection of this.connections) {
      if (ip === null || connection.ip === ip) {
        connection.socket.terminate();
        dropped += 1;
      }
    }
    this.logger.warn(
      `Dropped ${dropped} sockets${ip === null ? '' : ` of ${ip}`} on request`,
    );
    return dropped;
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const path = new URL(request.url ?? '/', 'http://simulator').pathname;
    if (path !== '/ws') {
      socket.end(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const ip = normalizeSourceAddress(request.socket.remoteAddress);
    if (!this.limits.admitConnection(ip, this.simulation.now())) {
      this.logger.warn(
        `Refused a socket from ${ip} past the connection limits`,
      );
      socket.end(
        'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    let isAccepted = false;
    socket.once('close', () => {
      if (!isAccepted) {
        this.limits.releaseConnection(ip);
      }
    });
    this.server.handleUpgrade(request, socket, head, (webSocket) => {
      isAccepted = true;
      this.acceptConnection(webSocket, ip);
    });
  }

  private acceptConnection(socket: WebSocket, ip: string): void {
    const connection: SimConnection = {
      id: this.nextConnectionId,
      ip,
      socket,
      subscriptions: new Map(),
      lastMessageAt: this.simulation.now(),
      queuedFrames: [],
    };
    this.nextConnectionId += 1;
    this.connections.add(connection);
    socket.on('message', (data: Buffer) =>
      this.handleMessage(connection, data.toString('utf8')),
    );
    socket.on('error', () => undefined);
    socket.on('close', () => this.releaseConnection(connection));
    this.logger.debug(`Socket ${connection.id} opened from ${ip}`);
  }

  private releaseConnection(connection: SimConnection): void {
    if (!this.connections.delete(connection)) {
      return;
    }
    this.limits.releaseConnection(connection.ip);
    for (const subscription of connection.subscriptions.values()) {
      this.limits.releaseSubscription(connection.ip, subscription.user);
    }
    connection.subscriptions.clear();
    this.logger.debug(`Socket ${connection.id} from ${connection.ip} closed`);
  }

  private handleMessage(connection: SimConnection, raw: string): void {
    const now = this.simulation.now();
    connection.lastMessageAt = now;
    if (!this.limits.admitMessage(connection.ip, now)) {
      this.sendError(connection, 'Too many messages sent. Slow down.');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.sendError(
        connection,
        `Error parsing JSON into valid websocket request: ${raw}`,
      );
      return;
    }
    const parsed = clientMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.sendError(
        connection,
        `Error parsing JSON into valid websocket request: ${raw}`,
      );
      return;
    }
    const message = parsed.data;
    if (message.method === 'ping') {
      this.send(connection, { channel: 'pong' });
    } else if (message.method === 'subscribe') {
      this.subscribe(connection, message.subscription, now);
    } else {
      this.unsubscribe(connection, message.subscription);
    }
  }

  private subscribe(
    connection: SimConnection,
    subscription: ParsedSubscription,
    now: number,
  ): void {
    const { echo, user, dex } = describeSubscription(subscription);
    const key = JSON.stringify(echo);
    if (connection.subscriptions.has(key)) {
      this.sendError(connection, `Already subscribed: ${key}`);
      return;
    }
    const refusal = this.limits.admitSubscription(connection.ip, user, now);
    if (refusal === 'users') {
      this.logger.warn(
        `Refused user ${user} from ${connection.ip} past the user limit`,
      );
      this.sendError(
        connection,
        `Cannot track more than ${this.limits.settings.maxUsers} total users.`,
      );
      return;
    }
    if (refusal === 'subscriptions') {
      this.logger.warn(
        `Refused a subscription from ${connection.ip} past the subscription limit`,
      );
      this.sendError(
        connection,
        `Cannot track more than ${this.limits.settings.maxSubscriptions} total subscriptions.`,
      );
      return;
    }
    const entry: SimSubscription = {
      key,
      echo,
      type: subscription.type,
      user,
      dex,
      deliveredUntil: now,
      nextStatePushAt: now + STATE_PUSH_INTERVAL_MS,
    };
    connection.subscriptions.set(key, entry);
    this.send(connection, {
      channel: 'subscriptionResponse',
      data: { method: 'subscribe', subscription: echo },
    });
    if (entry.type === 'userFills' && entry.user !== null) {
      const wallet = this.simulation.findWallet(entry.user);
      const fills = wallet
        ? this.simulation.traders.readRecentFills(
            wallet,
            0,
            now,
            SNAPSHOT_FILL_LIMIT,
          )
        : [];
      this.send(connection, {
        channel: 'userFills',
        data: { isSnapshot: true, user: entry.user, fills },
      });
    } else if (entry.type === 'clearinghouseState') {
      this.sendState(connection, entry, now);
    } else if (entry.type === 'allMids') {
      this.send(connection, {
        channel: 'allMids',
        data: { mids: this.simulation.market.readMids(now) },
      });
    }
  }

  private unsubscribe(
    connection: SimConnection,
    subscription: ParsedSubscription,
  ): void {
    const { echo } = describeSubscription(subscription);
    const key = JSON.stringify(echo);
    const entry = connection.subscriptions.get(key);
    if (!entry) {
      this.sendError(connection, `Already unsubscribed: ${key}`);
      return;
    }
    connection.subscriptions.delete(key);
    this.limits.releaseSubscription(connection.ip, entry.user);
    this.send(connection, {
      channel: 'subscriptionResponse',
      data: { method: 'unsubscribe', subscription: echo },
    });
  }

  private pushUpdates(): void {
    const now = this.simulation.now();
    for (const connection of this.connections) {
      this.flushQueuedFrames(connection, now);
    }
    this.pushFills(now);
    for (const connection of this.connections) {
      for (const entry of connection.subscriptions.values()) {
        if (
          entry.type === 'clearinghouseState' &&
          now >= entry.nextStatePushAt
        ) {
          this.sendState(connection, entry, now);
          entry.nextStatePushAt = Math.max(
            entry.nextStatePushAt + STATE_PUSH_INTERVAL_MS,
            now + 1,
          );
        }
      }
    }
    if (now - this.lastMidsPushAt >= MIDS_PUSH_INTERVAL_MS) {
      this.lastMidsPushAt = now;
      this.pushMids(now);
    }
  }

  private pushFills(now: number): void {
    const subscribersByUser = new Map<
      string,
      { connection: SimConnection; entry: SimSubscription }[]
    >();
    for (const connection of this.connections) {
      for (const entry of connection.subscriptions.values()) {
        if (entry.type === 'userFills' && entry.user !== null) {
          const subscribers = subscribersByUser.get(entry.user) ?? [];
          subscribers.push({ connection, entry });
          subscribersByUser.set(entry.user, subscribers);
        }
      }
    }
    for (const [user, subscribers] of subscribersByUser) {
      const wallet = this.simulation.findWallet(user);
      const since = Math.min(
        ...subscribers.map(({ entry }) => entry.deliveredUntil),
      );
      const orders = wallet
        ? this.simulation.traders.readOrdersBetween(wallet, since, now)
        : [];
      for (const { connection, entry } of subscribers) {
        let hasDelivered = false;
        for (const order of orders) {
          if (order.time > entry.deliveredUntil) {
            this.send(connection, {
              channel: 'userFills',
              data: { user, fills: order.fills },
            });
            hasDelivered = true;
          }
        }
        entry.deliveredUntil = now;
        if (hasDelivered) {
          for (const stateEntry of connection.subscriptions.values()) {
            if (
              stateEntry.type === 'clearinghouseState' &&
              stateEntry.user === user
            ) {
              this.sendState(connection, stateEntry, now);
            }
          }
        }
      }
    }
  }

  private pushMids(now: number): void {
    let mids: Record<string, string> | null = null;
    for (const connection of this.connections) {
      for (const entry of connection.subscriptions.values()) {
        if (entry.type === 'allMids') {
          mids ??= this.simulation.market.readMids(now);
          this.send(connection, { channel: 'allMids', data: { mids } });
        }
      }
    }
  }

  private sendState(
    connection: SimConnection,
    entry: SimSubscription,
    now: number,
  ): void {
    if (entry.user === null) {
      return;
    }
    this.send(connection, {
      channel: 'clearinghouseState',
      data: {
        dex: entry.dex,
        user: entry.user,
        clearinghouseState: readClearinghouseState(
          this.simulation,
          entry.user,
          entry.dex,
          now,
        ),
      },
    });
  }

  private closeIdleConnections(): void {
    const now = this.simulation.now();
    for (const connection of this.connections) {
      if (now - connection.lastMessageAt > IDLE_TIMEOUT_MS) {
        this.logger.log(
          `Closing socket ${connection.id} from ${connection.ip} after ${IDLE_TIMEOUT_MS} ms without a message`,
        );
        connection.socket.terminate();
      }
    }
  }

  private sendError(connection: SimConnection, message: string): void {
    this.send(connection, { channel: 'error', data: message });
  }

  private send(connection: SimConnection, frame: unknown): void {
    const text = JSON.stringify(frame);
    if (
      connection.queuedFrames.length > 0 ||
      this.faults.isStalled(connection.ip, this.simulation.now())
    ) {
      connection.queuedFrames.push(text);
      return;
    }
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(text);
    }
  }

  private flushQueuedFrames(connection: SimConnection, now: number): void {
    if (
      connection.queuedFrames.length === 0 ||
      this.faults.isStalled(connection.ip, now)
    ) {
      return;
    }
    const frames = connection.queuedFrames;
    connection.queuedFrames = [];
    for (const text of frames) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(text);
      }
    }
  }
}
