import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpLimits } from '../limits/ipLimits';
import { Simulation } from '../simulation';
import { formatLots } from '../wireFormat';
import { SimSocketService } from '../ws/simSocket.service';
import { FaultInjection } from './faultInjection';
import { TruthController } from './truth.controller';

const STARTED_AT = 1_780_000_000_000;
const DAY_MS = 86_400_000;

describe('TruthController', () => {
  let app: INestApplication<App>;
  let simulation: Simulation;
  let faults: FaultInjection;
  let droppedFor: (string | null)[];

  beforeEach(async () => {
    simulation = new Simulation({
      seed: 9,
      walletCount: 30,
      speed: 1,
      startedAt: STARTED_AT,
      clock: () => STARTED_AT,
    });
    faults = new FaultInjection();
    droppedFor = [];
    const moduleRef = await Test.createTestingModule({
      controllers: [TruthController],
      providers: [
        { provide: Simulation, useValue: simulation },
        {
          provide: IpLimits,
          useValue: new IpLimits({
            maxConnections: 10,
            newConnectionsPerMinute: 30,
            maxUsers: 10,
            maxSubscriptions: 1_000,
            messagesPerMinute: 2_000,
            weightPerMinute: 1_200,
          }),
        },
        { provide: FaultInjection, useValue: faults },
        {
          provide: SimSocketService,
          useValue: {
            readSubscribedUsers: () =>
              new Map([['10.0.0.5', [simulation.wallets[0].address]]]),
            dropConnections: (ip: string | null) => {
              droppedFor.push(ip);
              return 2;
            },
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists every wallet with its profile and planted edge', async () => {
    const response = await request(app.getHttpServer())
      .get('/sim/wallets')
      .expect(200);
    const wallets = response.body as {
      address: string;
      hasEdge: boolean;
      profile: string;
    }[];
    expect(wallets).toHaveLength(30);
    expect(wallets[0]).toMatchObject({
      address: simulation.wallets[0].address,
      hasEdge: simulation.wallets[0].hasEdge,
      profile: simulation.wallets[0].profile.name,
    });
  });

  it('returns every fill of a wallet in a range, never past now', async () => {
    const wallet = simulation.wallets[0];
    const since = STARTED_AT - 3 * DAY_MS;
    const response = await request(app.getHttpServer())
      .get('/sim/fills')
      .query({
        wallet: wallet.address.toUpperCase().replace('0X', '0x'),
        since,
        until: STARTED_AT + DAY_MS,
      })
      .expect(200);
    expect(response.body).toEqual({
      wallet: wallet.address,
      since,
      until: STARTED_AT,
      fills: simulation.traders.readFillsBetween(wallet, since, STARTED_AT),
    });
  });

  it('returns the true positions of every wallet', async () => {
    const response = await request(app.getHttpServer())
      .get('/sim/positions')
      .expect(200);
    const expected = simulation.wallets.flatMap((wallet) =>
      simulation.traders.readPositions(wallet, STARTED_AT).map((position) => ({
        wallet: wallet.address,
        coin: position.coin,
        szi: formatLots(position.lots, position.szDecimals),
      })),
    );
    expect(
      (
        response.body as {
          positions: { wallet: string; coin: string; szi: string }[];
        }
      ).positions.map(({ wallet, coin, szi }) => ({ wallet, coin, szi })),
    ).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('reports connections and subscribed users per source address', async () => {
    const limits = app.get(IpLimits);
    limits.admitConnection('10.0.0.5', STARTED_AT);
    limits.admitSubscription(
      '10.0.0.5',
      simulation.wallets[0].address,
      STARTED_AT,
    );
    const response = await request(app.getHttpServer())
      .get('/sim/connections')
      .expect(200);
    expect(response.body).toEqual({
      at: STARTED_AT,
      addresses: [
        {
          ip: '10.0.0.5',
          connections: 1,
          connectionsOpened: 1,
          newConnectionsLastMinute: 1,
          users: 1,
          subscriptions: 1,
          messagesLastMinute: 0,
          weightLastMinute: 0,
          userFillsSubscribers: [simulation.wallets[0].address],
        },
      ],
    });
  });

  it('applies faults and rejects malformed ones', async () => {
    await request(app.getHttpServer())
      .post('/sim/faults')
      .send({ type: 'drop_sockets', ip: '10.0.0.5' })
      .expect(200, { applied: 'drop_sockets', droppedSockets: 2 });
    expect(droppedFor).toEqual(['10.0.0.5']);
    await request(app.getHttpServer())
      .post('/sim/faults')
      .send({ type: 'rest_status', durationMs: 30_000 })
      .expect(200);
    expect(faults.readRestFault('10.0.0.5', STARTED_AT + 1)).toEqual({
      status: 429,
      delayMs: 0,
    });
    await request(app.getHttpServer())
      .post('/sim/faults')
      .send({ type: 'stall_pushes' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/sim/fills')
      .query({ wallet: 'nope' })
      .expect(400);
  });
});
