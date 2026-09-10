import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decide } from './copyEngine';
import {
  copyRatio,
  floorOrderSize,
  limitPrice,
  reduceTarget,
  roundLimitPrice,
  sizeEntry,
  sizeExit,
  stopPrice,
} from './copySizing';
import type {
  BookView,
  CopySettings,
  CopyView,
  Decision,
  DecisionContext,
  Signal,
} from './types';

const NOW = new Date('2026-04-20T12:00:00.000Z');
const LEADER = '0x1111111111111111111111111111111111111111';
const HYPE_MID = new Decimal(40);

const SETTINGS: CopySettings = {
  liveAllocationUsd: new Decimal(5_000),
  shadowAllocationUsd: new Decimal(5_000),
  signalMaxAgeMs: 15_000,
  driftLimitMajorBps: 50,
  driftLimitOtherBps: 100,
  exitSlippageBps: 300,
  leaderEquityMaxAgeMs: 900_000,
  positionCapMultiple: 3,
  grossExposureMultiple: 3,
  maxOpenCopies: 12,
  marginBuffer: 1.2,
  dailyLossLimit: 0.05,
  maxExchangeLeverage: 5,
};

function text(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

class PaperLedger {
  copy: CopyView | null = null;
  leaderEquityUsd = new Decimal(500_000);
  private nextTid = 1n;

  move(before: number | string, after: number | string): Decision | null {
    const positionBefore = new Decimal(before);
    const positionAfter = new Decimal(after);
    const tid = this.nextTid++;
    const opensEpisode =
      positionBefore.isZero() ||
      positionAfter.isZero() ||
      positionBefore.isNegative() !== positionAfter.isNegative();
    const signal: Signal = {
      key: `${LEADER}-HYPE-${tid}`,
      wallet: LEADER,
      coin: 'HYPE',
      source: 'stream',
      fillIds: [tid],
      firstTid: tid,
      episodeOpenTid: opensEpisode && !positionAfter.isZero() ? tid : null,
      positionBefore,
      positionAfter,
      touchedZero: opensEpisode && !positionBefore.isZero(),
      vwap: HYPE_MID,
      lastFillTime: new Date(NOW.getTime() - 1_000),
      receivedAt: new Date(NOW.getTime() - 700),
    };
    const decision = decide(signal, this.context());
    if (decision !== null) {
      this.apply(decision);
    }
    return decision;
  }

  private context(): DecisionContext {
    const book: BookView = {
      book: 'SHADOW',
      equityUsd: new Decimal(5_000),
      dayStartEquity: null,
      freeMarginUsd: new Decimal(5_000),
      killSwitchActive: false,
      killSwitchReason: null,
      openCopies: this.copy === null ? [] : [this.copy],
    };
    return {
      book,
      market: {
        coin: 'HYPE',
        szDecimals: 2,
        maxLeverage: 10,
        onlyIsolated: false,
        marginMode: null,
        isDelisted: false,
        mid: HYPE_MID,
        midAt: new Date(NOW.getTime() - 1_000),
      },
      leader: {
        wallet: LEADER,
        status: 'SHADOW',
        isPaused: false,
        equityUsd: this.leaderEquityUsd,
        equityAt: new Date(NOW.getTime() - 60_000),
      },
      settings: SETTINGS,
      now: NOW,
    };
  }

  private apply(decision: Decision): void {
    for (const intent of decision.intents) {
      const signedSize = intent.isBuy ? intent.size : intent.size.neg();
      if (intent.copyId === null && decision.opensCopy !== null) {
        this.copy = this.createCopy(decision, signedSize);
      } else if (this.copy !== null) {
        const size = this.copy.size.plus(signedSize);
        this.copy = size.isZero() ? null : this.resize(this.copy, size);
      }
    }
    if (
      decision.closesCopyId !== null &&
      this.copy?.id === decision.closesCopyId
    ) {
      this.copy = null;
    }
    if (decision.opensCopy !== null && !decision.opensCopy.waitsForFill) {
      this.copy = this.createCopy(decision, new Decimal(0));
    }
    if (decision.leaderSizeSync !== null && this.copy !== null) {
      this.copy = {
        ...this.copy,
        leaderSizeAtSync: decision.leaderSizeSync.leaderSizeAtSync,
      };
    }
  }

  private createCopy(decision: Decision, size: Decimal): CopyView {
    const opened = decision.opensCopy;
    if (opened === null) {
      throw new Error('decision opens no copy');
    }
    return {
      id: 1n,
      wallet: opened.wallet,
      coin: opened.coin,
      size,
      ratio: opened.ratio,
      leaderSizeAtSync: opened.leaderSizeAtSync,
      allocationUsd: opened.allocationUsd,
      notionalUsd: size.abs().mul(HYPE_MID),
      openedAt: NOW,
      lastOrderAt: null,
    };
  }

  private resize(copy: CopyView, size: Decimal): CopyView {
    return { ...copy, size, notionalUsd: size.abs().mul(HYPE_MID) };
  }
}

describe('floorOrderSize', () => {
  it.each([
    ['0.123456789', 5, '0.12345'],
    ['-1.239', 2, '1.23'],
    ['3', 0, '3'],
    ['0.009', 2, '0'],
  ])('floors %s to %i decimals as %s', (size, szDecimals, expected) => {
    expect(text(floorOrderSize(new Decimal(size), szDecimals))).toBe(expected);
  });

  it('keeps a lot that binary floating point would lose', () => {
    const exact = floorOrderSize(new Decimal('0.29'), 2);

    expect(text(exact)).toBe('0.29');
    expect(Math.floor(0.29 * 100) / 100).toBe(0.28);
  });
});

describe('roundLimitPrice', () => {
  it.each([
    ['67012.57', 5, true, '67012'],
    ['67012.57', 5, false, '67013'],
    ['104523.7', 5, true, '104523'],
    ['104523.7', 5, false, '104524'],
    ['100000.4', 5, true, '100000'],
    ['100000.4', 5, false, '100001'],
    ['99999.7', 5, true, '99999'],
    ['99999.7', 5, false, '100000'],
    ['23.45678', 2, true, '23.456'],
    ['23.45678', 2, false, '23.457'],
    ['0.0123456', 0, true, '0.012345'],
    ['0.0123456', 0, false, '0.012346'],
    ['1.2345678', 4, true, '1.23'],
    ['1.2345678', 4, false, '1.24'],
    ['0.00012345', 2, true, '0.0001'],
    ['0.00012345', 2, false, '0.0002'],
    ['3456', 2, true, '3456'],
    ['3456', 2, false, '3456'],
  ])(
    'rounds %s with szDecimals %i for a buy=%s to %s',
    (price, szDecimals, isBuy, expected) => {
      expect(text(roundLimitPrice(new Decimal(price), szDecimals, isBuy))).toBe(
        expected,
      );
    },
  );
});

describe('limitPrice', () => {
  it('bands an entry above the leader for a buy and rounds it down', () => {
    expect(text(limitPrice(new Decimal('66350.5'), true, 50, 5))).toBe('66682');
  });

  it('bands an entry below the leader for a sell and rounds it up', () => {
    expect(text(limitPrice(new Decimal('66350.5'), false, 50, 5))).toBe(
      '66019',
    );
  });

  it('bands an exit 3% through the mid on both sides', () => {
    expect(text(limitPrice(new Decimal('2000'), false, 300, 4))).toBe('1940');
    expect(text(limitPrice(new Decimal('2000'), true, 300, 4))).toBe('2060');
  });
});

describe('copyRatio', () => {
  it('divides the allocation by the leader equity to 18 decimals', () => {
    expect(text(copyRatio(new Decimal(5_000), new Decimal('1234567.89')))).toBe(
      '0.004050000036855',
    );
  });

  it('can exceed one for a leader smaller than the allocation', () => {
    expect(text(copyRatio(new Decimal(5_000), new Decimal(2_000)))).toBe('2.5');
  });
});

describe('reduceTarget', () => {
  it('scales the copy by the leader size over the synced size', () => {
    expect(
      text(reduceTarget(new Decimal('-0.6'), new Decimal(-2), new Decimal(-3))),
    ).toBe('-0.4');
  });
});

describe('sizeEntry', () => {
  const caps = [
    { name: 'position' as const, remainingUsd: new Decimal(15_000) },
    { name: 'leader' as const, remainingUsd: new Decimal(15_000) },
  ];

  it('targets the ratio times the leader size and orders the difference', () => {
    const sizing = sizeEntry({
      ratio: new Decimal('0.005'),
      leaderSize: new Decimal(3),
      copySize: new Decimal('0.01'),
      mid: new Decimal(65_000),
      szDecimals: 5,
      caps,
    });

    expect(sizing.result).toBe('order');
    expect(text(sizing.target)).toBe('0.015');
    expect(text(sizing.orderSize)).toBe('0.005');
    expect(text(sizing.orderNotionalUsd)).toBe('325');
    expect(sizing.bindingCap).toBeNull();
  });

  it('clips the target to the tightest cap and keeps its sign', () => {
    const sizing = sizeEntry({
      ratio: new Decimal('0.005'),
      leaderSize: new Decimal(-100),
      copySize: new Decimal(0),
      mid: new Decimal(65_000),
      szDecimals: 5,
      caps: [
        { name: 'position', remainingUsd: new Decimal(15_000) },
        { name: 'leader', remainingUsd: new Decimal(13_000) },
      ],
    });

    expect(sizing.bindingCap?.name).toBe('leader');
    expect(text(sizing.rawTarget)).toBe('-0.5');
    expect(text(sizing.target)).toBe('-0.2');
    expect(text(sizing.orderSize)).toBe('0.2');
  });

  it('places no order when a used-up cap leaves no room', () => {
    const sizing = sizeEntry({
      ratio: new Decimal('0.005'),
      leaderSize: new Decimal(3),
      copySize: new Decimal('0.01'),
      mid: new Decimal(65_000),
      szDecimals: 5,
      caps: [{ name: 'gross', remainingUsd: new Decimal(-200) }],
    });

    expect(sizing.result).toBe('at_target');
    expect(sizing.bindingCap?.name).toBe('gross');
    expect(text(sizing.target)).toBe('0');
  });

  it('defers an order worth less than 10 USD', () => {
    const sizing = sizeEntry({
      ratio: new Decimal('0.01'),
      leaderSize: new Decimal(20),
      copySize: new Decimal(0),
      mid: HYPE_MID,
      szDecimals: 2,
      caps,
    });

    expect(sizing.result).toBe('below_min_notional');
    expect(text(sizing.orderNotionalUsd)).toBe('8');
  });
});

describe('sizeExit', () => {
  it('closes with the exact copy size even under the minimum', () => {
    const sizing = sizeExit({
      kind: 'close',
      copySize: new Decimal('-0.000123456'),
      leaderSize: new Decimal(0),
      leaderSizeAtSync: new Decimal(-1),
      mid: new Decimal(65_000),
      szDecimals: 5,
    });

    expect(sizing.result).toBe('order');
    expect(sizing.isExactClose).toBe(true);
    expect(text(sizing.orderSize)).toBe('0.000123456');
  });

  it('floors a reduce toward the target', () => {
    const sizing = sizeExit({
      kind: 'reduce',
      copySize: new Decimal('0.0333'),
      leaderSize: new Decimal(2),
      leaderSizeAtSync: new Decimal(3),
      mid: new Decimal(65_000),
      szDecimals: 5,
    });

    expect(text(sizing.target)).toBe('0.0222');
    expect(text(sizing.orderSize)).toBe('0.0111');
    expect(sizing.result).toBe('order');
  });

  it('defers a reduce worth less than 10 USD', () => {
    const sizing = sizeExit({
      kind: 'reduce',
      copySize: new Decimal(1),
      leaderSize: new Decimal(95),
      leaderSizeAtSync: new Decimal(100),
      mid: HYPE_MID,
      szDecimals: 2,
    });

    expect(sizing.result).toBe('below_min_notional');
    expect(text(sizing.orderSize)).toBe('0.05');
  });

  it('needs no order for a copy without size', () => {
    const sizing = sizeExit({
      kind: 'reduce',
      copySize: new Decimal(0),
      leaderSize: new Decimal(1),
      leaderSizeAtSync: new Decimal(2),
      mid: HYPE_MID,
      szDecimals: 2,
    });

    expect(sizing.result).toBe('no_size');
  });
});

describe('stopPrice', () => {
  const base = {
    allocationUsd: new Decimal(5_000),
    lossShare: 0.2,
    maxDistance: 0.25,
  };

  it.each([
    ['0.1', '60000', 5, '50000'],
    ['1', '60000', 5, '59000'],
    ['0.01', '60000', 5, '45000'],
    ['-0.1', '60000', 5, '70000'],
    ['0.3', '2345.678', 4, '1759.3'],
    ['-0.3', '2345.678', 4, '2932'],
  ])(
    'puts the stop of %s at entry %s at %s',
    (size, entryPx, szDecimals, expected) => {
      const stop = stopPrice({
        ...base,
        size: new Decimal(size),
        entryPx: new Decimal(entryPx),
        szDecimals,
      });

      expect(text(stop)).toBe(expected);
    },
  );

  it('has no stop for a copy without size', () => {
    expect(
      stopPrice({
        ...base,
        size: new Decimal(0),
        entryPx: new Decimal(100),
        szDecimals: 2,
      }),
    ).toBeNull();
  });
});

describe('sizing invariants', () => {
  it('never grows the copy on a leader reduce, even above a deferred sync point', () => {
    const cases: [number, number, number][] = [
      [100, 100, 60],
      [100, 160, 120],
      [100, 160, 90],
      [150, 160, 155],
      [50, 100, 75],
      [-100, -160, -120],
      [-100, -100, -40],
    ];
    for (const [synced, before, after] of cases) {
      const ledger = new PaperLedger();
      ledger.move(0, synced);
      const decision = ledger.move(before, after);
      const intents = decision?.intents ?? [];

      expect(decision).not.toBeNull();
      expect(intents.every((intent) => intent.reduceOnly)).toBe(true);
      expect(intents.every((intent) => intent.isBuy === synced < 0)).toBe(true);
    }
  });

  it('closes the whole copy when the leader closes, whatever its size', () => {
    const ledger = new PaperLedger();
    ledger.move(0, -137);
    const deferred = ledger.move(-137, -130);
    const held = ledger.copy?.size;

    const decision = ledger.move(-130, 0);

    expect(deferred?.reason).toBe('below_min_notional');
    expect(text(held)).toBe('-1.37');
    expect(decision?.intents).toHaveLength(1);
    expect(decision?.intents[0]).toMatchObject({
      purpose: 'EXIT',
      isBuy: true,
      reduceOnly: true,
      isExactClose: true,
    });
    expect(text(decision?.intents[0].size)).toBe('1.37');
    expect(ledger.copy).toBeNull();
  });

  it('carries a deferred reduce until it clears the minimum', () => {
    const ledger = new PaperLedger();
    ledger.move(0, 100);
    const trims = [95, 90, 85, 80, 75].map((after) =>
      ledger.move(after + 5, after),
    );

    expect(trims.map((decision) => decision?.reason)).toEqual([
      'below_min_notional',
      'below_min_notional',
      'below_min_notional',
      'below_min_notional',
      'copied',
    ]);
    expect(text(trims[4]?.intents[0].size)).toBe('0.25');
    expect(text(ledger.copy?.size)).toBe('0.75');
    expect(text(ledger.copy?.leaderSizeAtSync)).toBe('75');
  });

  it('opens at size 0 under the minimum and catches up on a later increase', () => {
    const ledger = new PaperLedger();
    const open = ledger.move(0, 20);
    const sizeAfterOpen = ledger.copy?.size;
    const firstIncrease = ledger.move(20, 22);
    const syncedAfterFirst = ledger.copy?.leaderSizeAtSync;
    const secondIncrease = ledger.move(22, 26);

    expect(open?.verdict).toBe('SKIP');
    expect(open?.reason).toBe('below_min_notional');
    expect(text(open?.opensCopy?.ratio)).toBe('0.01');
    expect(text(sizeAfterOpen)).toBe('0');
    expect(firstIncrease?.reason).toBe('below_min_notional');
    expect(text(syncedAfterFirst)).toBe('20');
    expect(secondIncrease?.verdict).toBe('COPY');
    expect(text(secondIncrease?.intents[0].size)).toBe('0.26');
    expect(text(ledger.copy?.size)).toBe('0.26');
    expect(text(ledger.copy?.leaderSizeAtSync)).toBe('26');
  });

  it('absorbs moves the copy never saw', () => {
    const missedReduce = new PaperLedger();
    missedReduce.move(0, 200);
    const reduce = missedReduce.move(100, 150);

    const missedIncrease = new PaperLedger();
    missedIncrease.move(0, 100);
    const increase = missedIncrease.move(300, 350);

    expect(reduce?.action).toBe('REDUCE');
    expect(text(missedReduce.copy?.size)).toBe('1.5');
    expect(increase?.action).toBe('INCREASE');
    expect(text(increase?.intents[0].size)).toBe('2.5');
    expect(text(missedIncrease.copy?.size)).toBe('3.5');
  });

  it('keeps the frozen ratio when the leader deposits mid-trade', () => {
    const ledger = new PaperLedger();
    ledger.move(0, 100);
    ledger.leaderEquityUsd = new Decimal(1_000_000);

    ledger.move(100, 150);

    expect(text(ledger.copy?.ratio)).toBe('0.01');
    expect(text(ledger.copy?.size)).toBe('1.5');
  });

  it('reduces a clipped copy by the leader fraction', () => {
    const ledger = new PaperLedger();
    ledger.move(0, 50_000);
    const clipped = ledger.copy?.size;

    const decision = ledger.move(50_000, 25_000);

    expect(text(clipped)).toBe('375');
    expect(text(decision?.intents[0].size)).toBe('187.5');
    expect(text(ledger.copy?.size)).toBe('187.5');
  });
});
