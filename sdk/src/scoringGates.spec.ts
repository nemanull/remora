import { describe, expect, it } from 'vitest';
import {
  DANGER_GATES,
  isDangerGate,
  STAGE_THREE_GATES,
  STAGE_TWO_GATES,
} from './scoringGates.js';

describe('scoring gates', () => {
  it('names every gate once across both stages', () => {
    const gates = [...STAGE_TWO_GATES, ...STAGE_THREE_GATES];

    expect(new Set(gates).size).toBe(gates.length);
  });

  it('treats only liquidations, sub-account masters and off-dex trading as danger', () => {
    expect(DANGER_GATES).toEqual([
      'recent_liquidation',
      'sub_account_master',
      'off_main_dex',
    ]);
    expect(isDangerGate('off_main_dex')).toBe(true);
    expect(isDangerGate('short_holds')).toBe(false);
  });
});
