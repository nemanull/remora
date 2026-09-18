export const STAGE_TWO_GATES = [
  'short_history',
  'spot_driven',
  'sub_account_master',
  'deep_drawdown',
  'not_significant',
] as const;

export const STAGE_THREE_GATES = [
  'recent_liquidation',
  'short_holds',
  'hyperactive',
  'inactive',
  'off_main_dex',
] as const;

export type GateFailure =
  | (typeof STAGE_TWO_GATES)[number]
  | (typeof STAGE_THREE_GATES)[number];

export const DANGER_GATES: readonly GateFailure[] = [
  'recent_liquidation',
  'sub_account_master',
  'off_main_dex',
];

export function isDangerGate(gate: string): boolean {
  return (DANGER_GATES as readonly string[]).includes(gate);
}
