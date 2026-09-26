import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { HyperliquidFill } from '@remora/sdk';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpLimits } from '../limits/ipLimits';
import { Simulation } from '../simulation';
import { FaultInjection } from '../truth/faultInjection';
import { InfoController } from './info.controller';

const STARTED_AT = 1_780_000_000_000;
const DAY_MS = 86_400_000;

describe('InfoController', () => {
  let app: INestApplication<App>;
  let simulation: Simulation;
  let faults: FaultInjection;
  let weightPerMinute: number;
  let restLagMs: number;

  async function createApp(): Promise<void> {
    simulation = new Simulation({
      seed: 11,
      walletCount: 40,
      speed: 1,
      restLagMs,
      startedAt: STARTED_AT,
      clock: () => STARTED_AT,
    });
    faults = new FaultInjection();
    const moduleRef = await Test.createTestingModule({
      controllers: [InfoController],
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
            weightPerMinute,
          }),
        },
        { provide: FaultInjection, useValue: faults },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  function postInfo(body: unknown) {
    return request(app.getHttpServer())
      .post('/info')
      .send(body as object);
  }

  function findBusyWallet() {
    const wallet = simulation.wallets.find(
      (candidate) =>
        simulation.traders.readFillsBetween(
          candidate,
          STARTED_AT - 30 * DAY_MS,
          STARTED_AT,
        ).length > 10_500,
    );
    if (!wallet) {
      throw new Error('the population has no wallet past the fill horizon');
    }
    return wallet;
  }

  beforeEach(() => {
    weightPerMinute = 1_200;
    restLagMs = 0;
  });

  afterEach(async () => {
    await app.close();
  });

  it('pages fills oldest first from an inclusive start time, repeating the boundary millisecond', async () => {
    await createApp();
    const wallet = simulation.wallets[0];
    const all = simulation.traders.readFillsBetween(wallet, 0, STARTED_AT);
    const middle = all[Math.floor(all.length / 2)];
    const response = await postInfo({
      type: 'userFillsByTime',
      user: wallet.address,
      startTime: middle.time,
    }).expect(200);
    const page = response.body as HyperliquidFill[];
    const expected = all
      .filter((fill) => fill.time >= middle.time)
      .slice(0, 2_000);
    expect(page).toEqual(expected);
    expect(page[0].time).toBe(middle.time);
  });

  it('serves 2,000 fills per page and only the 10,000 most recent fills', async () => {
    await createApp();
    const wallet = findBusyWallet();
    const all = simulation.traders.readFillsBetween(wallet, 0, STARTED_AT);
    const horizon = all.slice(-10_000);
    const collected = new Map<number, HyperliquidFill>();
    let startTime = 0;
    let pages = 0;
    for (;;) {
      const response = await postInfo({
        type: 'userFillsByTime',
        user: wallet.address,
        startTime,
      }).expect(200);
      const page = response.body as HyperliquidFill[];
      pages += 1;
      const fresh = page.filter((fill) => !collected.has(fill.tid));
      for (const fill of fresh) {
        collected.set(fill.tid, fill);
      }
      if (pages === 1) {
        expect(page).toHaveLength(2_000);
        expect(page[0]).toEqual(horizon[0]);
      }
      if (page.length < 2_000 || fresh.length === 0) {
        break;
      }
      startTime = page[page.length - 1].time;
    }
    expect([...collected.values()]).toEqual(horizon);
    expect(pages).toBeLessThanOrEqual(8);
  });

  it('serves fills only up to the configured REST lag behind now', async () => {
    restLagMs = 6 * 3_600_000;
    await createApp();
    const wallet = findBusyWallet();
    const visibleUntil = STARTED_AT - restLagMs;
    const response = await postInfo({
      type: 'userFillsByTime',
      user: wallet.address,
      startTime: visibleUntil - 3_600_000,
    }).expect(200);
    const page = response.body as HyperliquidFill[];
    expect(page.length).toBeGreaterThan(0);
    expect(page.at(-1)?.time).toBeLessThanOrEqual(visibleUntil);
    expect(page).toEqual(
      simulation.traders.readFillsBetween(
        wallet,
        visibleUntil - 3_600_000,
        visibleUntil,
      ),
    );
  });

  it('stops a page at an end time', async () => {
    await createApp();
    const wallet = simulation.wallets[1];
    const response = await postInfo({
      type: 'userFillsByTime',
      user: wallet.address,
      startTime: STARTED_AT - 5 * DAY_MS,
      endTime: STARTED_AT - 4 * DAY_MS,
    }).expect(200);
    const page = response.body as HyperliquidFill[];
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((fill) => fill.time <= STARTED_AT - 4 * DAY_MS)).toBe(
      true,
    );
  });

  it('answers 429 once the weight of this address passes the minute budget', async () => {
    weightPerMinute = 100;
    await createApp();
    const user = simulation.wallets[0].address;
    for (let index = 0; index < 5; index += 1) {
      await postInfo({ type: 'portfolio', user }).expect(200);
    }
    await postInfo({ type: 'portfolio', user }).expect(429);
    await postInfo({ type: 'l2Book', coin: 'BTC' }).expect(429);
  });

  it('charges the fill surcharge after the response', async () => {
    weightPerMinute = 150;
    await createApp();
    const wallet = findBusyWallet();
    await postInfo({
      type: 'userFillsByTime',
      user: wallet.address,
      startTime: 0,
    }).expect(200);
    await postInfo({ type: 'portfolio', user: wallet.address }).expect(200);
    await postInfo({ type: 'portfolio', user: wallet.address }).expect(429);
  });

  it('answers unknown request types with 422 and other content types with 415', async () => {
    await createApp();
    await postInfo({ type: 'leaderboard' })
      .expect(422)
      .expect('Failed to deserialize the JSON body into the target type');
    await request(app.getHttpServer())
      .post('/info')
      .set('content-type', 'text/plain')
      .send('{"type":"allMids"}')
      .expect(415);
  });

  it('answers an unknown coin book with 500 and null', async () => {
    await createApp();
    const response = await postInfo({ type: 'l2Book', coin: 'NOPE' }).expect(
      500,
    );
    expect(response.text).toBe('null');
  });

  it('serves 20 book levels per side around the mid', async () => {
    await createApp();
    const response = await postInfo({ type: 'l2Book', coin: 'ETH' }).expect(
      200,
    );
    const book = response.body as {
      levels: [{ px: string }[], { px: string }[]];
    };
    const [bids, asks] = book.levels;
    expect(bids).toHaveLength(20);
    expect(asks).toHaveLength(20);
    const mid = simulation.market.readMidAt('ETH', STARTED_AT);
    expect(Number(bids[0].px)).toBeLessThanOrEqual(mid);
    expect(Number(asks[0].px)).toBeGreaterThanOrEqual(mid);
    expect(Number(bids[19].px)).toBeLessThan(Number(bids[0].px));
    expect(Number(asks[19].px)).toBeGreaterThan(Number(asks[0].px));
  });

  it('answers user roles, abstraction and order status like the exchange', async () => {
    await createApp();
    const vault = simulation.wallets.find(
      (wallet) => wallet.vaultName !== null,
    );
    const trader = simulation.wallets.find(
      (wallet) => wallet.vaultName === null,
    );
    await postInfo({ type: 'userRole', user: vault?.address }).expect(200, {
      role: 'vault',
    });
    await postInfo({ type: 'userRole', user: trader?.address }).expect(200, {
      role: 'user',
    });
    await postInfo({ type: 'userRole', user: `0x${'1'.repeat(40)}` }).expect(
      200,
      {
        role: 'missing',
      },
    );
    const abstraction = await postInfo({
      type: 'userAbstraction',
      user: trader?.address,
    });
    expect(abstraction.text).toBe('"default"');
    await postInfo({
      type: 'orderStatus',
      user: trader?.address,
      oid: 12,
    }).expect(200, {
      status: 'unknownOid',
    });
  });

  it('answers with an injected status or delay while a fault lasts', async () => {
    await createApp();
    faults.answerRestWith(429, 60_000, null, STARTED_AT);
    await postInfo({ type: 'allMids' }).expect(429);
    faults.clear();
    faults.delayRest(150, 60_000, null, STARTED_AT);
    const startedAt = Date.now();
    await postInfo({ type: 'allMids' }).expect(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
  });
});
