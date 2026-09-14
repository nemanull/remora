import type { HyperliquidUserFillsFrame } from '@remora/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { SignalBuilder, type StoredFill } from './signalBuilder';

const SNAPSHOT = JSON.parse(
  readFileSync(
    join(__dirname, '../../../payloads/userFills/snapshot.json'),
    'utf8',
  ),
) as HyperliquidUserFillsFrame;
const WALLET = SNAPSHOT.data.user;
const RECEIVED_AT = new Date('2026-02-08T01:23:45.000Z');

function storeSnapshotFills(): StoredFill[] {
  return SNAPSHOT.data.fills.map((fill, index) => ({
    id: BigInt(index + 1),
    coin: fill.coin,
    tid: BigInt(fill.tid),
    px: new Decimal(fill.px),
    sz: new Decimal(fill.sz),
    side: fill.side,
    time: new Date(fill.time),
    startPosition: new Decimal(fill.startPosition),
    receivedAt: RECEIVED_AT,
  }));
}

let nextId = 100n;

function storedFill(
  coin: string,
  side: 'A' | 'B',
  size: string,
  startPosition: string,
  time: string,
  price = '10',
): StoredFill {
  nextId += 1n;
  return {
    id: nextId,
    coin,
    tid: nextId * 1_000n,
    px: new Decimal(price),
    sz: new Decimal(size),
    side,
    time: new Date(time),
    startPosition: new Decimal(startPosition),
    receivedAt: new Date(time),
  };
}

function createBuilder(catchUpFills: StoredFill[] = []) {
  const findMany = vi.fn().mockResolvedValue(catchUpFills);
  const prisma = { leaderFill: { findMany } } as unknown as PrismaService;
  return { builder: new SignalBuilder(prisma), findMany };
}

describe('SignalBuilder', () => {
  it('builds the scale-in of the snapshot into one PUMP signal that opens and closes', () => {
    const { builder } = createBuilder();
    const scaleIn = storeSnapshotFills().slice(4, 7);

    const [signal] = builder.buildFrameSignals(
      WALLET,
      scaleIn,
      'stream',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(signal.key).toBe(`${WALLET}-PUMP-765275329565570`);
    expect(signal.source).toBe('stream');
    expect(signal.fillIds).toEqual([5n, 6n, 7n]);
    expect(signal.firstTid).toBe(765275329565570n);
    expect(signal.positionBefore.toString()).toBe('0');
    expect(signal.positionAfter.toString()).toBe('0');
    expect(signal.touchedZero).toBe(true);
    expect(signal.episodeOpenTid).toBeNull();
    expect(signal.vwap.toString()).toBe('0.003011');
    expect(signal.lastFillTime).toEqual(new Date(1_769_675_610_455));
    expect(signal.receivedAt).toEqual(RECEIVED_AT);
  });

  it('keeps the open of the scale-in as the episode start when the close is not in the frame', () => {
    const { builder } = createBuilder();
    const [open, add] = storeSnapshotFills().slice(4, 6);

    const [signal] = builder.buildFrameSignals(
      WALLET,
      [open, add],
      'stream',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(signal.positionAfter.toString()).toBe('-10627');
    expect(signal.episodeOpenTid).toBe(765275329565570n);
    expect(signal.touchedZero).toBe(false);
  });

  it('builds one signal per coin from a frame in the order Hyperliquid sent it', () => {
    const { builder } = createBuilder();
    const fills = storeSnapshotFills().slice(14, 21);

    const signals = builder.buildFrameSignals(
      WALLET,
      fills,
      'snapshot',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(signals.map((signal) => signal.coin)).toEqual([
      'PUMP',
      'SOL',
      'XRP',
      'HYPE',
    ]);
    const pump = signals[0];
    expect(pump.fillIds).toEqual([15n, 20n]);
    expect(pump.positionAfter.toString()).toBe('0');
  });

  it('leaves out fills from before tracked_since', () => {
    const { builder } = createBuilder();
    const fills = storeSnapshotFills();
    const trackedSince = new Date(1_770_527_474_194);

    const signals = builder.buildFrameSignals(
      WALLET,
      fills,
      'backfill',
      trackedSince,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].coin).toBe('XRP');
    expect(signals[0].fillIds).toEqual([22n, 23n, 24n, 25n]);
    expect(signals[0].firstTid).toBe(1_111_063_246_686_638n);
  });

  it('builds a catch-up across two coins from unsignalled fills since tracked_since', async () => {
    const trackedSince = new Date('2026-03-01T00:00:00.000Z');
    const btcOpen = storedFill(
      'BTC',
      'B',
      '0.5',
      '0',
      '2026-03-02T10:00:00.000Z',
      '80000',
    );
    const ethOpen = storedFill(
      'ETH',
      'A',
      '4',
      '0',
      '2026-03-02T10:00:01.000Z',
      '2000',
    );
    const btcAdd = storedFill(
      'BTC',
      'B',
      '0.5',
      '0.5',
      '2026-03-02T10:05:00.000Z',
      '82000',
    );
    const ethClose = storedFill(
      'ETH',
      'B',
      '4',
      '-4',
      '2026-03-02T10:06:00.000Z',
      '1990',
    );
    const { builder, findMany } = createBuilder([
      btcOpen,
      ethOpen,
      btcAdd,
      ethClose,
    ]);

    const signals = await builder.buildCatchUp(WALLET, trackedSince);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          walletAddress: WALLET,
          signalledAt: null,
          time: { gte: trackedSince },
        },
        orderBy: [{ time: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(signals).toHaveLength(2);
    const [btc, eth] = signals;
    expect(btc.source).toBe('catch_up');
    expect(btc.key).toBe(`${WALLET}-BTC-${btcOpen.tid}`);
    expect(btc.fillIds).toEqual([btcOpen.id, btcAdd.id]);
    expect(btc.positionBefore.toString()).toBe('0');
    expect(btc.positionAfter.toString()).toBe('1');
    expect(btc.episodeOpenTid).toBe(btcOpen.tid);
    expect(btc.vwap.toString()).toBe('81000');
    expect(btc.lastFillTime).toEqual(btcAdd.time);
    expect(eth.positionAfter.toString()).toBe('0');
    expect(eth.touchedZero).toBe(true);
    expect(eth.receivedAt).toEqual(ethClose.receivedAt);
  });

  it('returns no catch-up when nothing is unsignalled', async () => {
    const { builder } = createBuilder([]);

    await expect(
      builder.buildCatchUp(WALLET, new Date('2026-03-01T00:00:00.000Z')),
    ).resolves.toEqual([]);
  });
});
