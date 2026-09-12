import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { applyFill, type PositionLedger } from './positionFills';

function ledger(size: string, entryPx: string | null, realized = '0') {
  return {
    size: new Decimal(size),
    entryPx: entryPx === null ? null : new Decimal(entryPx),
    realizedPnl: new Decimal(realized),
  };
}

function fill(isBuy: boolean, size: string, price: string) {
  return { isBuy, size: new Decimal(size), price: new Decimal(price) };
}

function text(result: PositionLedger) {
  return {
    size: result.size.toFixed(),
    entryPx: result.entryPx?.toFixed() ?? null,
    realizedPnl: result.realizedPnl.toFixed(),
  };
}

describe('applyFill', () => {
  it('opens a copy at the fill price', () => {
    expect(text(applyFill(ledger('0', null), fill(true, '2', '30')))).toEqual({
      size: '2',
      entryPx: '30',
      realizedPnl: '0',
    });
  });

  it('averages the entry price on an increase', () => {
    expect(text(applyFill(ledger('2', '30'), fill(true, '2', '32')))).toEqual({
      size: '4',
      entryPx: '31',
      realizedPnl: '0',
    });
  });

  it('realizes PnL on a reduce and keeps the entry price', () => {
    expect(
      text(applyFill(ledger('4', '31', '5'), fill(false, '1', '35'))),
    ).toEqual({ size: '3', entryPx: '31', realizedPnl: '9' });
  });

  it('realizes PnL on a short that is bought back lower', () => {
    expect(
      text(applyFill(ledger('-0.5', '60000'), fill(true, '0.5', '59000'))),
    ).toEqual({ size: '0', entryPx: '60000', realizedPnl: '500' });
  });

  it('opens the other side with the rest of a fill that passes zero', () => {
    expect(text(applyFill(ledger('1', '100'), fill(false, '3', '90')))).toEqual(
      { size: '-2', entryPx: '90', realizedPnl: '-10' },
    );
  });

  it('ignores an empty fill', () => {
    expect(text(applyFill(ledger('1', '100'), fill(false, '0', '90')))).toEqual(
      { size: '1', entryPx: '100', realizedPnl: '0' },
    );
  });
});
