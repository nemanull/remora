import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { once } from 'node:events';
import type { ClientRequest, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { IpLimits } from '../limits/ipLimits';
import { Simulation } from '../simulation';
import { FaultInjection } from '../truth/faultInjection';
import { SimSocketService } from './simSocket.service';

const STARTED_AT = 1_780_000_000_000;
const DAY_MS = 86_400_000;

type Frame = { channel: string; data?: unknown };

class FrameClient {
  readonly frames: Frame[] = [];
  readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString('utf8')) as Frame);
    });
  }

  async open(): Promise<this> {
    await once(this.socket, 'open');
    return this;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitForFrames(count: number, timeoutMs = 3_000): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `expected ${count} frames, got ${JSON.stringify(this.frames)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.frames;
  }
}

describe('SimSocketService', () => {
  let app: INestApplication;
  let url: string;
  let now: number;
  let simulation: Simulation;
  let limits: IpLimits;
  let faults: FaultInjection;
  let clients: FrameClient[];

  async function connect(): Promise<FrameClient> {
    const client = await new FrameClient(url).open();
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    now = STARTED_AT;
    clients = [];
    simulation = new Simulation({
      seed: 3,
      walletCount: 40,
      speed: 1,
      startedAt: STARTED_AT,
      clock: () => now,
    });
    limits = new IpLimits({
      maxConnections: 2,
      newConnectionsPerMinute: 30,
      maxUsers: 3,
      maxSubscriptions: 100,
      messagesPerMinute: 2_000,
      weightPerMinute: 1_200,
    });
    faults = new FaultInjection();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: Simulation, useValue: simulation },
        { provide: IpLimits, useValue: limits },
        { provide: FaultInjection, useValue: faults },
        SimSocketService,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterEach(async () => {
    for (const client of clients) {
      client.socket.terminate();
    }
    await app.close();
  });

  it('acknowledges with defaults filled in and follows a userFills subscription with its snapshot', async () => {
    const wallet = simulation.wallets[0];
    const client = await connect();
    client.send({
      method: 'subscribe',
      subscription: { type: 'userFills', user: wallet.address },
    });
    client.send({
      method: 'subscribe',
      subscription: { type: 'clearinghouseState', user: wallet.address },
    });
    const [userFillsAck, snapshot, stateAck, state] =
      await client.waitForFrames(4);
    expect(userFillsAck).toEqual({
      channel: 'subscriptionResponse',
      data: {
        method: 'subscribe',
        subscription: {
          type: 'userFills',
          user: wallet.address,
          aggregateByTime: false,
        },
      },
    });
    expect(snapshot).toEqual({
      channel: 'userFills',
      data: {
        isSnapshot: true,
        user: wallet.address,
        fills: simulation.traders.readRecentFills(wallet, 0, now, 30),
      },
    });
    expect(stateAck.data).toEqual({
      method: 'subscribe',
      subscription: {
        type: 'clearinghouseState',
        dex: '',
        user: wallet.address,
      },
    });
    expect(state.channel).toBe('clearinghouseState');
  });

  it('pushes each later order as one userFills frame without isSnapshot', async () => {
    const wallet = simulation.wallets.find(
      (candidate) => candidate.profile.name === 'scalper',
    );
    if (!wallet) {
      throw new Error('the population has no scalper');
    }
    const orders = simulation.traders
      .readOrdersBetween(wallet, now, now + DAY_MS)
      .slice(0, 3);
    const client = await connect();
    client.send({
      method: 'subscribe',
      subscription: { type: 'userFills', user: wallet.address },
    });
    await client.waitForFrames(2);
    now = orders[2].time;
    const frames = await client.waitForFrames(5);
    expect(frames.slice(2)).toEqual(
      orders.map((order) => ({
        channel: 'userFills',
        data: { user: wallet.address, fills: order.fills },
      })),
    );
  });

  it('answers pings, refuses duplicates and unknown requests with error frames', async () => {
    const wallet = simulation.wallets[1];
    const client = await connect();
    const subscribe = {
      method: 'subscribe',
      subscription: { type: 'userFills', user: wallet.address },
    };
    client.send(subscribe);
    client.send(subscribe);
    client.send({
      method: 'subscribe',
      subscription: { type: 'webData2', user: wallet.address },
    });
    client.send({ method: 'ping' });
    const frames = await client.waitForFrames(5);
    expect(frames.slice(2)).toEqual([
      {
        channel: 'error',
        data: `Already subscribed: {"type":"userFills","user":"${wallet.address}","aggregateByTime":false}`,
      },
      {
        channel: 'error',
        data: `Error parsing JSON into valid websocket request: {"method":"subscribe","subscription":{"type":"webData2","user":"${wallet.address}"}}`,
      },
      { channel: 'pong' },
    ]);
  });

  it('refuses one user past the user limit and records the refusal', async () => {
    const client = await connect();
    for (const wallet of simulation.wallets.slice(0, 4)) {
      client.send({
        method: 'subscribe',
        subscription: { type: 'clearinghouseState', user: wallet.address },
      });
    }
    await client.waitForFrames(7);
    expect(client.frames.at(-1)).toEqual({
      channel: 'error',
      data: 'Cannot track more than 3 total users.',
    });
    expect(limits.readRefusals().map((refusal) => refusal.limit)).toEqual([
      'users',
    ]);
    client.send({
      method: 'unsubscribe',
      subscription: {
        type: 'clearinghouseState',
        user: simulation.wallets[0].address,
      },
    });
    client.send({
      method: 'subscribe',
      subscription: {
        type: 'clearinghouseState',
        user: simulation.wallets[3].address,
      },
    });
    const frames = await client.waitForFrames(10);
    expect(frames[7].data).toMatchObject({ method: 'unsubscribe' });
    expect(frames[8].data).toMatchObject({ method: 'subscribe' });
  });

  it('answers the upgrade with 429 past the connection limit', async () => {
    await connect();
    await connect();
    const refused = new WebSocket(url);
    refused.on('error', () => undefined);
    const [request, response] = (await once(
      refused,
      'unexpected-response',
    )) as [ClientRequest, IncomingMessage];
    request.destroy();
    expect(response.statusCode).toBe(429);
    expect(limits.readRefusalCounts().connections).toBe(1);
  });

  it('pushes clearinghouseState every five seconds of simulated time', async () => {
    const client = await connect();
    client.send({
      method: 'subscribe',
      subscription: {
        type: 'clearinghouseState',
        user: simulation.wallets[2].address,
      },
    });
    await client.waitForFrames(2);
    now += 5_000;
    const frames = await client.waitForFrames(3);
    expect(frames[2].channel).toBe('clearinghouseState');
  });

  it('holds every frame back while pushes stall and delivers them afterwards', async () => {
    const client = await connect();
    faults.stallPushes(30_000, null, now);
    client.send({ method: 'ping' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.frames).toEqual([]);
    now += 30_001;
    expect(await client.waitForFrames(1)).toEqual([{ channel: 'pong' }]);
  });

  it('drops sockets on request', async () => {
    const client = await connect();
    const closed = once(client.socket, 'close');
    expect(app.get(SimSocketService).dropConnections(null)).toBe(1);
    await closed;
  });

  it('closes a socket that sent nothing for 60 seconds', async () => {
    const client = await connect();
    const closed = once(client.socket, 'close');
    now += 61_000;
    await closed;
  }, 10_000);
});
