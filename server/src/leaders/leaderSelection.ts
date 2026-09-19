import { isDangerGate } from '@remora/sdk';
import type { CopyResults } from './shadowStats';

const DAY_MS = 86_400_000;

export const EMA_ALPHA = 0.3;
export const TOP_BAND_MULTIPLE = 2.5;
export const MINIMUM_SHADOW_DAYS = 14;
export const MINIMUM_CLOSED_COPIES = 10;
export const SHADOW_DRAWDOWN_LIMIT = -0.1;
export const MAXIMUM_REJECTION_SHARE = 0.5;
export const SILENT_DAYS_LIMIT = 14;
export const COOLDOWN_DAYS = 30;
export const LIVE_EQUITY_FLOOR = 0.8;
export const NEGATIVE_WEEKS_LIMIT = 3;
export const MANUAL_PAUSE_REASON = 'manual_pause';

export type LeaderStatus = 'CANDIDATE' | 'SHADOW' | 'LIVE' | 'RETIRED';
export type LeaderSource = 'LEADERBOARD' | 'MANUAL';

export type LeaderRecord = {
  address: string;
  status: LeaderStatus;
  source: LeaderSource;
  score: number | null;
  scoredAt: Date | null;
  topStreak: number;
  missStreak: number;
  isPaused: boolean;
  statusReason: string | null;
  trackedSince: Date | null;
  liveSince: Date | null;
  retiredAt: Date | null;
};

export type ShadowEvidence = CopyResults & {
  rejectionShare: number | null;
};

export type LiveEvidence = CopyResults & {
  negativeWeeks: number;
};

export type LeaderEvidence = {
  hasOpenCopies: boolean;
  lastFillAt: Date | null;
  shadow: ShadowEvidence | null;
  live: LiveEvidence | null;
};

export type RunScore = {
  walletAddress: string;
  passed: boolean;
  composite: number | null;
  gateFailures: string[];
};

export type SelectionSettings = {
  trackedTarget: number;
  streakRuns: number;
  maxLiveLeaders: number;
  promotionMode: 'auto' | 'manual';
};

export type SelectionInput = {
  now: Date;
  settings: SelectionSettings;
  leaders: LeaderRecord[];
  evidence: ReadonlyMap<string, LeaderEvidence>;
  scores: RunScore[];
};

export type LeaderTransition = {
  address: string;
  from: LeaderStatus;
  to: LeaderStatus;
  isPaused: boolean;
  reason: string;
};

export type LeaderChange = {
  before: LeaderRecord;
  after: LeaderRecord;
  transition: LeaderTransition | null;
};

export function retiredFields(now: Date): Partial<LeaderRecord> {
  return { isPaused: false, retiredAt: now, topStreak: 0, missStreak: 0 };
}

export function admittedFields(reason: string): Partial<LeaderRecord> {
  return {
    isPaused: false,
    statusReason: reason,
    trackedSince: null,
    liveSince: null,
    missStreak: 0,
  };
}

const NO_EVIDENCE: LeaderEvidence = {
  hasOpenCopies: false,
  lastFillAt: null,
  shadow: null,
  live: null,
};

export function isTracked(leader: LeaderRecord): boolean {
  return leader.status === 'SHADOW' || leader.status === 'LIVE';
}

export function isRetiring(leader: LeaderRecord): boolean {
  return (
    isTracked(leader) &&
    leader.isPaused &&
    leader.statusReason !== null &&
    leader.statusReason !== MANUAL_PAUSE_REASON
  );
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

export function smoothScore(previous: number | null, input: number): number {
  return previous === null
    ? input
    : EMA_ALPHA * input + (1 - EMA_ALPHA) * previous;
}

export function readScoreInput(score: RunScore | undefined): number | null {
  if (score === undefined) {
    return null;
  }
  if (score.composite !== null) {
    return score.composite;
  }
  return score.passed ? null : 0;
}

export function listPromotionGaps(
  leader: LeaderRecord,
  evidence: LeaderEvidence,
  now: Date,
): string[] {
  const gaps: string[] = [];
  const shadow = evidence.shadow;
  if (
    leader.trackedSince === null ||
    daysBetween(leader.trackedSince, now) < MINIMUM_SHADOW_DAYS
  ) {
    gaps.push('shadow_too_short');
  }
  if (shadow === null || shadow.closedCopies < MINIMUM_CLOSED_COPIES) {
    gaps.push('too_few_closed_copies');
  }
  if (shadow === null || shadow.netPnlUsd <= 0) {
    gaps.push('shadow_return_not_positive');
  }
  if (shadow === null || shadow.maxDrawdown <= SHADOW_DRAWDOWN_LIMIT) {
    gaps.push('shadow_drawdown_too_deep');
  }
  if (
    shadow === null ||
    shadow.rejectionShare === null ||
    shadow.rejectionShare >= MAXIMUM_REJECTION_SHARE
  ) {
    gaps.push('too_many_rejected_entries');
  }
  return gaps;
}

export function findRetirementTrigger(
  leader: LeaderRecord,
  score: RunScore | undefined,
  evidence: LeaderEvidence,
  settings: SelectionSettings,
  now: Date,
): string | null {
  const isManual = leader.source === 'MANUAL';
  if (leader.status === 'SHADOW') {
    const dangerGate = score?.gateFailures.find(isDangerGate);
    if (dangerGate !== undefined) {
      return dangerGate;
    }
    if (!isManual && leader.missStreak >= settings.streakRuns) {
      return 'outside_top_band';
    }
    if (!isManual && leader.trackedSince !== null) {
      const silentSince =
        evidence.lastFillAt !== null &&
        evidence.lastFillAt > leader.trackedSince
          ? evidence.lastFillAt
          : leader.trackedSince;
      if (daysBetween(silentSince, now) >= SILENT_DAYS_LIMIT) {
        return 'no_recent_fill';
      }
    }
    return null;
  }
  if (leader.status === 'LIVE') {
    if (score !== undefined && !score.passed) {
      return score.gateFailures[0] ?? 'failed_gate';
    }
    if (
      evidence.live !== null &&
      evidence.live.returnOnAllocation < LIVE_EQUITY_FLOOR - 1
    ) {
      return 'copy_equity_floor';
    }
    if (
      evidence.live !== null &&
      evidence.live.negativeWeeks >= NEGATIVE_WEEKS_LIMIT
    ) {
      return 'negative_weeks';
    }
  }
  return null;
}

function compareByScore(left: LeaderRecord, right: LeaderRecord): number {
  return (
    (right.score ?? -Infinity) - (left.score ?? -Infinity) ||
    left.address.localeCompare(right.address)
  );
}

export function planSelection(input: SelectionInput): LeaderChange[] {
  const { now, settings } = input;
  const scores = new Map(
    input.scores.map((score) => [score.walletAddress, score]),
  );
  const states = new Map(
    input.leaders.map((leader) => [leader.address, { ...leader }]),
  );
  const transitions = new Map<string, LeaderTransition>();
  const evidenceOf = (address: string) =>
    input.evidence.get(address) ?? NO_EVIDENCE;
  const move = (
    state: LeaderRecord,
    to: LeaderStatus,
    changes: Partial<LeaderRecord>,
  ) => {
    const from = transitions.get(state.address)?.from ?? state.status;
    Object.assign(state, changes, { status: to });
    transitions.set(state.address, {
      address: state.address,
      from,
      to,
      isPaused: state.isPaused,
      reason: state.statusReason ?? to.toLowerCase(),
    });
  };

  for (const state of states.values()) {
    if (
      state.status === 'RETIRED' &&
      state.retiredAt !== null &&
      daysBetween(state.retiredAt, now) >= COOLDOWN_DAYS
    ) {
      move(state, 'CANDIDATE', {
        isPaused: false,
        statusReason: 'cooldown_finished',
        topStreak: 0,
        missStreak: 0,
      });
    }
  }

  for (const state of states.values()) {
    const scoreInput = readScoreInput(scores.get(state.address));
    if (scoreInput !== null) {
      state.score = smoothScore(state.score, scoreInput);
      state.scoredAt = now;
    }
  }

  const ranked = [...states.values()]
    .filter(
      (state) =>
        state.status !== 'RETIRED' &&
        !isRetiring(state) &&
        (scores.get(state.address)?.composite ?? null) !== null,
    )
    .sort(compareByScore);
  const rankOf = new Map(
    ranked.map((state, index) => [state.address, index + 1]),
  );
  const topBand = Math.floor(TOP_BAND_MULTIPLE * settings.trackedTarget);
  for (const state of states.values()) {
    if (state.status === 'RETIRED') {
      continue;
    }
    const rank = rankOf.get(state.address);
    state.topStreak =
      rank !== undefined && rank <= settings.trackedTarget
        ? state.topStreak + 1
        : 0;
    state.missStreak =
      isTracked(state) && state.source !== 'MANUAL'
        ? rank === undefined || rank > topBand
          ? state.missStreak + 1
          : 0
        : 0;
  }

  for (const state of states.values()) {
    if (!isTracked(state) || isRetiring(state)) {
      continue;
    }
    const reason = findRetirementTrigger(
      state,
      scores.get(state.address),
      evidenceOf(state.address),
      settings,
      now,
    );
    if (reason !== null) {
      move(state, state.status, { isPaused: true, statusReason: reason });
    }
  }

  for (const state of states.values()) {
    if (isRetiring(state) && !evidenceOf(state.address).hasOpenCopies) {
      move(state, 'RETIRED', retiredFields(now));
    }
  }

  const shadows = [...states.values()]
    .filter((state) => state.status === 'SHADOW' && !state.isPaused)
    .sort(compareByScore);
  let liveCount = [...states.values()].filter(
    (state) => state.status === 'LIVE',
  ).length;
  for (const state of shadows) {
    const isReady =
      listPromotionGaps(state, evidenceOf(state.address), now).length === 0;
    if (
      isReady &&
      settings.promotionMode === 'auto' &&
      liveCount < settings.maxLiveLeaders
    ) {
      move(state, 'LIVE', { liveSince: now, statusReason: 'promoted' });
      liveCount += 1;
    } else if (
      isReady &&
      settings.promotionMode === 'manual' &&
      state.statusReason !== 'promotion_ready'
    ) {
      move(state, 'SHADOW', { statusReason: 'promotion_ready' });
    } else if (!isReady && state.statusReason === 'promotion_ready') {
      state.statusReason = null;
    }
  }

  const trackedCount = [...states.values()].filter(isTracked).length;
  const admissions = [...states.values()]
    .filter(
      (state) =>
        state.status === 'CANDIDATE' && state.topStreak >= settings.streakRuns,
    )
    .sort(compareByScore)
    .slice(0, Math.max(settings.trackedTarget - trackedCount, 0));
  for (const state of admissions) {
    move(state, 'SHADOW', admittedFields('entered_top_n'));
  }

  const changes: LeaderChange[] = [];
  for (const before of input.leaders) {
    const after = states.get(before.address) ?? before;
    if (listChangedFields(before, after).length > 0) {
      changes.push({
        before,
        after,
        transition: transitions.get(before.address) ?? null,
      });
    }
  }
  return changes;
}

export const LEADER_FIELDS = [
  'status',
  'source',
  'score',
  'scoredAt',
  'topStreak',
  'missStreak',
  'isPaused',
  'statusReason',
  'trackedSince',
  'liveSince',
  'retiredAt',
] as const;

export type LeaderField = (typeof LEADER_FIELDS)[number];

function isSameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

export function listChangedFields(
  before: LeaderRecord,
  after: LeaderRecord,
): LeaderField[] {
  return LEADER_FIELDS.filter(
    (field) => !isSameValue(before[field], after[field]),
  );
}
