import type {
  HyperliquidAssetPosition,
  HyperliquidClearinghouseState,
  HyperliquidMarginSummary,
} from '@remora/sdk';
import type { Simulation } from '../simulation';
import {
  formatLots,
  formatPrice,
  formatUsd,
  toWireDecimal,
} from '../wireFormat';

function summarize(
  accountValue: number,
  totalNotional: number,
  signedNotional: number,
  totalMargin: number,
): HyperliquidMarginSummary {
  return {
    accountValue: formatUsd(accountValue),
    totalNtlPos: formatUsd(totalNotional),
    totalRawUsd: formatUsd(accountValue - signedNotional),
    totalMarginUsed: formatUsd(totalMargin),
  };
}

export function readClearinghouseState(
  simulation: Simulation,
  address: string,
  dex: string,
  now: number,
): HyperliquidClearinghouseState {
  const wallet = dex === '' ? simulation.findWallet(address) : undefined;
  const accountValue = wallet
    ? simulation.history.readEquityAt(wallet, now)
    : 0;
  const positions = wallet ? simulation.traders.readPositions(wallet, now) : [];
  let totalNotional = 0;
  let signedNotional = 0;
  let totalMargin = 0;
  let maintenanceMargin = 0;
  const assetPositions = positions.map((position): HyperliquidAssetPosition => {
    const coin = simulation.market.findCoin(position.coin);
    const maxLeverage = coin?.maxLeverage ?? position.leverage;
    const mid = simulation.market.readMidAt(position.coin, now);
    const size = position.lots / 10 ** position.szDecimals;
    const value = Math.abs(size) * mid;
    const unrealizedPnl = (mid - position.entryPx) * size;
    const marginUsed = value / position.leverage;
    totalNotional += value;
    signedNotional += size * mid;
    totalMargin += marginUsed;
    maintenanceMargin += value / (2 * maxLeverage);
    return {
      type: 'oneWay',
      position: {
        coin: position.coin,
        szi: formatLots(position.lots, position.szDecimals),
        leverage: position.isIsolated
          ? {
              type: 'isolated',
              value: position.leverage,
              rawUsd: formatUsd(marginUsed - size * position.entryPx),
            }
          : { type: 'cross', value: position.leverage },
        entryPx: formatPrice(position.entryPx, position.szDecimals),
        positionValue: formatUsd(value),
        unrealizedPnl: formatUsd(unrealizedPnl),
        returnOnEquity: toWireDecimal(unrealizedPnl / marginUsed, 10),
        liquidationPx:
          position.liquidationPx === null
            ? null
            : formatPrice(position.liquidationPx, position.szDecimals),
        marginUsed: formatUsd(marginUsed),
        maxLeverage,
        cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
      },
    };
  });
  const summary = summarize(
    accountValue,
    totalNotional,
    signedNotional,
    totalMargin,
  );
  return {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: formatUsd(maintenanceMargin),
    withdrawable: formatUsd(Math.max(0, accountValue - totalMargin)),
    assetPositions,
    time: now,
  };
}
