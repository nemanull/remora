import type { Decimal } from 'decimal.js';
import {
  floorOrderSize,
  MIN_ORDER_NOTIONAL_USD,
  reduceTarget,
} from '../copy/copySizing';
import type { CopyView } from '../copy/types';

export const LEADER_STATE_MAX_AGE_MS = 30_000;
export const LEADER_STATE_MIN_LEAD_MS = 5_000;

export type CopyReconciliation =
  | {
      outcome: 'close';
      reason: 'leader_flat' | 'leader_flipped';
      detail: string;
    }
  | {
      outcome: 'drift';
      reason: 'copy_drift';
      expectedSize: Decimal;
      driftSize: Decimal;
      driftUsd: Decimal;
      detail: string;
    }
  | {
      outcome: 'hold';
      reason:
        | 'in_sync'
        | 'drift_below_minimum'
        | 'leader_state_missing'
        | 'leader_state_stale'
        | 'leader_state_predates_copy';
      detail: string;
    };

function signOf(value: Decimal): number {
  if (value.isZero()) {
    return 0;
  }
  return value.isNegative() ? -1 : 1;
}

export function reconcileCopy(input: {
  copy: CopyView;
  leaderPosition: Decimal | null;
  leaderPositionsAt: Date | null;
  mid: Decimal;
  szDecimals: number;
  now: Date;
}): CopyReconciliation {
  const { copy, leaderPosition, leaderPositionsAt } = input;
  if (leaderPosition === null || leaderPositionsAt === null) {
    return {
      outcome: 'hold',
      reason: 'leader_state_missing',
      detail: `no position state is stored for the leader of copy ${copy.id}`,
    };
  }
  const stateAgeMs = input.now.getTime() - leaderPositionsAt.getTime();
  if (stateAgeMs >= LEADER_STATE_MAX_AGE_MS) {
    return {
      outcome: 'hold',
      reason: 'leader_state_stale',
      detail: `leader state is ${stateAgeMs} ms old, limit ${LEADER_STATE_MAX_AGE_MS} ms`,
    };
  }
  const lastChange = copy.lastOrderAt ?? copy.openedAt;
  const leadMs = leaderPositionsAt.getTime() - lastChange.getTime();
  if (leadMs <= LEADER_STATE_MIN_LEAD_MS) {
    return {
      outcome: 'hold',
      reason: 'leader_state_predates_copy',
      detail: `leader state is ${leadMs} ms after the copy's last change, and it needs more than ${LEADER_STATE_MIN_LEAD_MS} ms`,
    };
  }
  const synced = copy.leaderSizeAtSync;
  if (leaderPosition.isZero()) {
    return {
      outcome: 'close',
      reason: 'leader_flat',
      detail: `leader is flat on ${copy.coin} while copy ${copy.id} holds ${copy.size.toFixed()}`,
    };
  }
  if (signOf(leaderPosition) !== signOf(synced)) {
    return {
      outcome: 'close',
      reason: 'leader_flipped',
      detail: `leader holds ${leaderPosition.toFixed()} on ${copy.coin} against the synced ${synced.toFixed()}`,
    };
  }
  if (leaderPosition.equals(synced)) {
    return {
      outcome: 'hold',
      reason: 'in_sync',
      detail: `leader holds the synced ${synced.toFixed()} on ${copy.coin}`,
    };
  }
  const expectedSize = leaderPosition.abs().gt(synced.abs())
    ? copy.ratio.mul(leaderPosition)
    : reduceTarget(copy.size, leaderPosition, synced);
  const driftSize = expectedSize.minus(copy.size);
  const driftUsd = floorOrderSize(driftSize, input.szDecimals).mul(input.mid);
  const comparison = `copy ${copy.id} holds ${copy.size.toFixed()} where the leader's ${leaderPosition.toFixed()} against the synced ${synced.toFixed()} implies ${expectedSize.toFixed()}`;
  if (driftUsd.lt(MIN_ORDER_NOTIONAL_USD)) {
    return {
      outcome: 'hold',
      reason: 'drift_below_minimum',
      detail: `${comparison}, a drift of ${driftUsd.toFixed(2)} USD under the minimum order`,
    };
  }
  return {
    outcome: 'drift',
    reason: 'copy_drift',
    expectedSize,
    driftSize,
    driftUsd,
    detail: `${comparison}, a drift of ${driftUsd.toFixed(2)} USD`,
  };
}
