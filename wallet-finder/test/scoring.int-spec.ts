import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueModule } from '../src/queue/queue.module';
import { SCORING_QUEUE } from '../src/queue/scoring.worker';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';

describe('scoring worker', () => {
  let redis: StartedRedisContainer;
  let moduleRef: TestingModule;
  let queue: Queue;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:8.6.3').start();
    const connection = { url: redis.getConnectionUrl() };
    moduleRef = await Test.createTestingModule({
      imports: [BullModule.forRoot({ connection }), QueueModule],
    }).compile();
    await moduleRef.init();
    queue = moduleRef.get<Queue>(getQueueToken(SCORING_QUEUE));
    queueEvents = new QueueEvents(SCORING_QUEUE, { connection });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await queueEvents?.close();
    await moduleRef?.close();
    await redis?.stop();
  });

  it('scores a wallet from its dump', async () => {
    const job = await queue.add('score', { wallet: WALLET });

    const score = (await job.waitUntilFinished(queueEvents)) as Record<
      string,
      unknown
    >;

    expect(score).toMatchObject({
      wallet: WALLET,
      fills: 25,
      closes: 12,
      wins: 7,
      netPnl: '-0.400954',
    });
  });

  it('fails a wallet without a dump', async () => {
    const wallet = '0x0000000000000000000000000000000000000001';
    const job = await queue.add('score', { wallet });

    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow(
      `No dump for wallet ${wallet}`,
    );
  });
});
