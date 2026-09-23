import type {
  BackfillState,
  OrderStatus,
  PolicyOutcome,
  Verdict,
  WalletStatus,
} from '@remora/sdk';
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'shadow' | 'warn' | 'muted';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'border-line-strong bg-raised text-ink-2',
  accent: 'border-accent/25 bg-accent-soft text-accent',
  shadow: 'border-shadow/25 bg-shadow-soft text-shadow',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  muted: 'border-line bg-transparent text-ink-3',
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  shadow: 'bg-shadow',
  warn: 'bg-warn',
  muted: 'bg-ink-3/60',
};

export function Badge({
  tone,
  children,
  hasDot = false,
  title,
}: {
  tone: BadgeTone;
  children: ReactNode;
  hasDot?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 items-center gap-1.5 rounded border px-1.5 text-[11px] font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {hasDot && (
        <span className={`size-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
      )}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<WalletStatus, BadgeTone> = {
  LIVE: 'accent',
  SHADOW: 'shadow',
  CANDIDATE: 'neutral',
  RETIRED: 'muted',
};

const STATUS_LABELS: Record<WalletStatus, string> = {
  LIVE: 'Live',
  SHADOW: 'Shadow',
  CANDIDATE: 'Candidate',
  RETIRED: 'Retired',
};

export function StatusBadge({ status }: { status: WalletStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} hasDot>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function PausedBadge({ reason }: { reason: string | null }) {
  return (
    <Badge tone="warn" title={reason ?? undefined}>
      Paused
    </Badge>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return verdict === 'COPY' ? (
    <Badge tone="accent">Copy</Badge>
  ) : (
    <Badge tone="neutral">Skip</Badge>
  );
}

const OUTCOME_TONES: Record<PolicyOutcome, BadgeTone> = {
  allow: 'neutral',
  clip: 'warn',
  reject: 'warn',
  skip: 'muted',
};

export function OutcomeBadge({ outcome }: { outcome: PolicyOutcome }) {
  return <Badge tone={OUTCOME_TONES[outcome]}>{outcome}</Badge>;
}

const ORDER_TONES: Record<OrderStatus, BadgeTone> = {
  FILLED: 'accent',
  PARTIALLY_FILLED: 'accent',
  UNFILLED: 'neutral',
  REJECTED: 'warn',
  SUBMITTED: 'muted',
  UNKNOWN: 'warn',
};

const ORDER_LABELS: Record<OrderStatus, string> = {
  FILLED: 'Filled',
  PARTIALLY_FILLED: 'Partial',
  UNFILLED: 'Unfilled',
  REJECTED: 'Rejected',
  SUBMITTED: 'Submitted',
  UNKNOWN: 'Unknown',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={ORDER_TONES[status]}>{ORDER_LABELS[status]}</Badge>;
}

const BACKFILL_TONES: Record<BackfillState, BadgeTone> = {
  synced: 'neutral',
  pending: 'muted',
  running: 'accent',
  retrying: 'warn',
  lagging: 'warn',
  truncated: 'warn',
};

export function BackfillBadge({ state }: { state: BackfillState | null }) {
  if (state === null) {
    return <Badge tone="muted">Not subscribed</Badge>;
  }
  return (
    <Badge tone={BACKFILL_TONES[state]} hasDot={state === 'synced'}>
      {state === 'synced' ? 'Synced' : `Backfill ${state}`}
    </Badge>
  );
}

export function OnlineBadge({ isOnline }: { isOnline: boolean }) {
  return isOnline ? (
    <Badge tone="accent" hasDot>
      Online
    </Badge>
  ) : (
    <Badge tone="warn" hasDot>
      Offline
    </Badge>
  );
}
