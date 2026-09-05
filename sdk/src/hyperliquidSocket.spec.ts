import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  HyperliquidSubscription,
  HyperliquidWsFrame,
} from './hyperliquid.js';
import {
  HyperliquidSocket,
  type HyperliquidSocketOptions,
  type SubscriptionResult,
} from './hyperliquidSocket.js';

type ReceivedMessage = {
  method: string;
  subscription?: HyperliquidSubscription;
};

const FAKE_TIMERS: (
  | 'setTimeout'
  | 'clearTimeout'
  | 'setInterval'
  | 'clearInterval'
  | 'Date'
)[] = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'];
const WALLET_A = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const WALLET_B = '0x4e23288cee4960f9f962195c22948e4bc7ae20c3';
const WALLET_C = '0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5';
const USER_LIMIT_ERROR = 'Cannot track more than 10 unique users';

function userFills(user: string): HyperliquidSubscription {
  return { type: 'userFills', user };
}

function clearinghouseState(user: string): HyperliquidSubscription {
  return { type: 'clearinghouseState', user };
}

function send(connection: WebSocket, frame: unknown): void {
  connection.send(JSON.stringify(frame));
}

function acknowledge(connection: WebSocket, message: ReceivedMessage): void {
  if (message.method === 'ping') {
    send(connection, { channel: 'pong' });
    return;
  }
  send(connection, { channel: 'subscriptionResponse', data: message });
}

describe('HyperliquidSocket', () => {
  let server: WebSocketServer;
  let url: string;
  let received: ReceivedMessage[];
  let respond: (connection: WebSocket, message: ReceivedMessage) => void;
  let sockets: HyperliquidSocket[];

  function createSocket(
    options: Partial<HyperliquidSocketOptions> = {},
  ): HyperliquidSocket {
    const socket = new HyperliquidSocket({
      url,
      onFrame: () => undefined,
      ...options,
    });
    sockets.push(socket);
    return socket;
  }

  function nextConnection(): Promise<WebSocket> {
    return new Promise((resolve) => server.once('connection', resolve));
  }

  function dropEveryConnection(): void {
    for (const client of server.clients) {
      client.terminate();
    }
  }

  beforeEach(async () => {
    received = [];
    sockets = [];
    respond = acknowledge;
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on('connection', (connection) => {
      connection.on('message', (data) => {
        const message = JSON.parse(
          (data as Buffer).toString('utf8'),
        ) as ReceivedMessage;
        received.push(message);
        respond(connection, message);
      });
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(sockets.map((socket) => socket.stop()));
    dropEveryConnection();
    await new Promise((resolve) => server.close(resolve));
  });

  it('resolves each subscription with the acknowledgement that answers it', async () => {
    const socket = createSocket();
    socket.start();

    const results = await Promise.all([
      socket.subscribe(userFills(WALLET_A)),
      socket.subscribe(clearinghouseState(WALLET_A)),
    ]);

    expect(results).toEqual([
      { subscription: userFills(WALLET_A), error: null },
      { subscription: clearinghouseState(WALLET_A), error: null },
    ]);
    expect(received).toEqual([
      { method: 'subscribe', subscription: userFills(WALLET_A) },
      { method: 'subscribe', subscription: clearinghouseState(WALLET_A) },
    ]);
  });

  it('attributes an error frame to the oldest request still waiting', async () => {
    const waiting: [WebSocket, ReceivedMessage][] = [];
    respond = (connection, message) => {
      waiting.push([connection, message]);
      if (waiting.length < 3) {
        return;
      }
      acknowledge(...waiting[0]);
      send(connection, { channel: 'error', data: USER_LIMIT_ERROR });
      acknowledge(...waiting[2]);
    };
    const socket = createSocket();
    socket.start();

    const results = await Promise.all(
      [WALLET_A, WALLET_B, WALLET_C].map((wallet) =>
        socket.subscribe(userFills(wallet)),
      ),
    );

    expect(results.map((result) => result.error)).toEqual([
      null,
      USER_LIMIT_ERROR,
      null,
    ]);
  });

  it('sends a refused subscription again when it is asked for again', async () => {
    respond = (connection) =>
      send(connection, { channel: 'error', data: USER_LIMIT_ERROR });
    const socket = createSocket();
    socket.start();
    await socket.subscribe(userFills(WALLET_A));
    respond = acknowledge;

    const retry = await socket.subscribe(userFills(WALLET_A));

    expect(retry.error).toBeNull();
    expect(received).toHaveLength(2);
  });

  it('hands data frames to onFrame and keeps pongs and acknowledgements to itself', async () => {
    const frames: HyperliquidWsFrame[] = [];
    const fillsFrame = {
      channel: 'userFills',
      data: { user: WALLET_A, fills: [] },
    };
    respond = (connection, message) => {
      acknowledge(connection, message);
      send(connection, { channel: 'pong' });
      send(connection, fillsFrame);
    };
    const socket = createSocket({ onFrame: (frame) => frames.push(frame) });
    socket.start();

    await socket.subscribe(userFills(WALLET_A));

    await vi.waitFor(() => expect(frames).toEqual([fillsFrame]));
  });

  it('hands an error frame to onFrame when no request is waiting', async () => {
    const frames: HyperliquidWsFrame[] = [];
    const socket = createSocket({ onFrame: (frame) => frames.push(frame) });
    const connection = nextConnection();
    socket.start();

    send(await connection, { channel: 'error', data: 'Unexpected error' });

    await vi.waitFor(() =>
      expect(frames).toEqual([{ channel: 'error', data: 'Unexpected error' }]),
    );
  });

  it('sends subscriptions asked for before the socket opened', async () => {
    const socket = createSocket();
    const result = socket.subscribe(userFills(WALLET_A));

    socket.start();

    await expect(result).resolves.toEqual({
      subscription: userFills(WALLET_A),
      error: null,
    });
  });

  it('sends one request when the same subscription is asked for twice', async () => {
    const socket = createSocket();
    socket.start();

    await Promise.all([
      socket.subscribe({ type: 'userFills', user: WALLET_A }),
      socket.subscribe({ user: WALLET_A, type: 'userFills' }),
    ]);
    await socket.subscribe(userFills(WALLET_A));

    expect(received).toHaveLength(1);
  });

  it('unsubscribes and resolves once Hyperliquid acknowledges it', async () => {
    const socket = createSocket();
    socket.start();
    await socket.subscribe(userFills(WALLET_A));

    await socket.unsubscribe(userFills(WALLET_A));

    expect(received.at(-1)).toEqual({
      method: 'unsubscribe',
      subscription: userFills(WALLET_A),
    });
  });

  it('resolves a waiting subscription with socket_stopped when stopped', async () => {
    respond = () => undefined;
    const socket = createSocket();
    socket.start();
    const result = socket.subscribe(userFills(WALLET_A));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await socket.stop();

    await expect(result).resolves.toEqual({
      subscription: userFills(WALLET_A),
      error: 'socket_stopped',
    });
  });

  it('pings every 30 s and measures the round trip from the pong', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const socket = createSocket();
    socket.start();
    await vi.waitFor(() => expect(socket.readStats().state).toBe('open'));
    expect(received).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);

    await vi.waitFor(() => expect(received).toEqual([{ method: 'ping' }]));
    await vi.waitFor(() =>
      expect(socket.readStats().pingRoundTripMs).not.toBeNull(),
    );
  });

  it('terminates the socket when no pong arrives within 10 s', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    respond = () => undefined;
    const disconnects: string[] = [];
    const socket = createSocket({
      onDisconnect: (reason) => disconnects.push(reason),
    });
    socket.start();
    await vi.waitFor(() => expect(socket.readStats().state).toBe('open'));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(received).toEqual([{ method: 'ping' }]));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(socket.readStats().state).toBe('open');
    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() =>
      expect(disconnects).toEqual([
        expect.stringContaining('no pong within 10000 ms'),
      ]),
    );
  });

  it('calls onReopen before it resubscribes everything after a reconnect', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const log: string[] = [];
    const resubscribed: SubscriptionResult[] = [];
    respond = (connection, message) => {
      log.push(`${message.method} ${message.subscription?.type}`);
      acknowledge(connection, message);
    };
    const socket = createSocket({
      onReopen: () => log.push('reopen'),
      onResubscribeResult: (result) => resubscribed.push(result),
    });
    socket.start();
    await socket.subscribe(userFills(WALLET_A));
    await socket.subscribe(clearinghouseState(WALLET_A));
    expect(log).toEqual([
      'subscribe userFills',
      'subscribe clearinghouseState',
    ]);

    dropEveryConnection();
    await vi.waitFor(() => expect(socket.readStats().state).toBe('closed'));
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => expect(resubscribed).toHaveLength(2));
    expect(log.slice(2)).toEqual([
      'reopen',
      'subscribe userFills',
      'subscribe clearinghouseState',
    ]);
    expect(resubscribed).toEqual([
      { subscription: userFills(WALLET_A), error: null },
      { subscription: clearinghouseState(WALLET_A), error: null },
    ]);
    expect(socket.readStats().reconnects).toBe(1);
  });

  it('reports a resubscription that Hyperliquid refuses after a reconnect', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const resubscribed: SubscriptionResult[] = [];
    const socket = createSocket({
      onResubscribeResult: (result) => resubscribed.push(result),
    });
    socket.start();
    await socket.subscribe(userFills(WALLET_A));
    respond = (connection) =>
      send(connection, { channel: 'error', data: USER_LIMIT_ERROR });

    dropEveryConnection();
    await vi.waitFor(() => expect(socket.readStats().state).toBe('closed'));
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() =>
      expect(resubscribed).toEqual([
        { subscription: userFills(WALLET_A), error: USER_LIMIT_ERROR },
      ]),
    );
  });

  it('backs off further after each short-lived socket and resets after 60 s of stability', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delays: number[] = [];
    const socket = createSocket({
      onDisconnect: (_, delay) => delays.push(delay),
    });

    let connection = nextConnection();
    socket.start();
    (await connection).terminate();
    await vi.waitFor(() => expect(delays).toEqual([2_000]));

    connection = nextConnection();
    await vi.advanceTimersByTimeAsync(2_000);
    (await connection).terminate();
    await vi.waitFor(() => expect(delays).toEqual([2_000, 4_000]));

    connection = nextConnection();
    await vi.advanceTimersByTimeAsync(4_000);
    const stableConnection = await connection;
    await vi.waitFor(() => expect(socket.readStats().state).toBe('open'));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(socket.readStats().pingRoundTripMs).not.toBeNull(),
    );
    await vi.advanceTimersByTimeAsync(31_000);
    stableConnection.terminate();

    await vi.waitFor(() => expect(delays).toEqual([2_000, 4_000, 2_000]));
  });
});
