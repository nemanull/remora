import type { LeaderResponse, WalletStatus } from '@remora/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, describeError, queryKeys } from '../api';
import { Address } from '../components/Address';
import {
  EmptyNote,
  ErrorNote,
  LoadingNote,
  PageHeader,
  Panel,
  Segmented,
  TableScroll,
} from '../components/Panel';
import { ScoreBar } from '../components/ScoreBreakdown';
import { PausedBadge, StatusBadge } from '../components/StatusBadge';
import { TimeAgo } from '../components/TimeAgo';
import { formatPercent, formatScore, toneOf } from '../format';

type StatusFilter = 'ALL' | WalletStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'LIVE', label: 'Live' },
  { value: 'SHADOW', label: 'Shadow' },
  { value: 'CANDIDATE', label: 'Candidates' },
  { value: 'RETIRED', label: 'Retired' },
];

function readStatusFilter(value: string | null): StatusFilter {
  return STATUS_FILTERS.some((filter) => filter.value === value)
    ? (value as StatusFilter)
    : 'ALL';
}

function AddLeaderForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [address, setAddress] = useState('');
  const add = useMutation({
    mutationFn: () => api.addLeader(address.trim()),
    onSuccess: async (leader) => {
      setAddress('');
      await queryClient.invalidateQueries({ queryKey: ['leaders'] });
      await navigate(`/leaders/${leader.address}`);
    },
  });
  return (
    <form
      className="flex w-full flex-col gap-1.5 sm:w-auto"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div className="flex gap-2">
        <input
          className="input min-w-0 flex-1 sm:w-80"
          placeholder="Add a wallet by address, 0x…"
          value={address}
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Wallet address"
        />
        <button
          type="submit"
          className="button button-primary"
          disabled={add.isPending || address.trim() === ''}
        >
          Add to shadow
        </button>
      </div>
      {add.isError && (
        <p className="text-xs text-warn">{describeError(add.error)}</p>
      )}
    </form>
  );
}

function CopyResults({ leader }: { leader: LeaderResponse }) {
  const results = leader.copyResults;
  if (results === null || results.closedCopies === 0) {
    return <span className="text-ink-3">–</span>;
  }
  return (
    <span
      className={toneOf(results.returnOnAllocation * 100)}
      title={`${results.closedCopies} closed ${results.book.toLowerCase()} copies, drawdown ${formatPercent(results.maxDrawdown)}`}
    >
      {formatPercent(results.returnOnAllocation, { signed: true })}
    </span>
  );
}

function LatestScore({ leader }: { leader: LeaderResponse }) {
  const score = leader.latestScore;
  if (score === null) {
    return <span className="text-ink-3">–</span>;
  }
  if (!score.passed) {
    return (
      <span className="text-warn" title={score.gateFailures.join(', ')}>
        Failed {score.gateFailures.length}{' '}
        {score.gateFailures.length === 1 ? 'gate' : 'gates'}
      </span>
    );
  }
  return (
    <ScoreBar
      components={score.components}
      score={score.composite ?? score.preliminary}
    />
  );
}

function LeadersTable({ leaders }: { leaders: LeaderResponse[] }) {
  const navigate = useNavigate();
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="numeric w-10">#</th>
          <th>Wallet</th>
          <th>Status</th>
          <th className="numeric">Score</th>
          <th>Latest composite</th>
          <th className="numeric">Collector</th>
          <th>Last fill</th>
          <th className="numeric">Copy return</th>
          <th className="numeric">Copies</th>
        </tr>
      </thead>
      <tbody>
        {leaders.map((leader, index) => (
          <tr
            key={leader.address}
            onClick={() => void navigate(`/leaders/${leader.address}`)}
            className="cursor-pointer hover:bg-raised/60"
          >
            <td className="numeric text-ink-3">{index + 1}</td>
            <td>
              <Address address={leader.address} />
              {leader.source === 'MANUAL' && (
                <span className="ml-2 text-[11px] text-ink-3">manual</span>
              )}
            </td>
            <td>
              <span className="flex items-center gap-1.5">
                <StatusBadge status={leader.status} />
                {leader.isPaused && (
                  <PausedBadge reason={leader.statusReason} />
                )}
              </span>
            </td>
            <td className="numeric font-medium text-ink">
              {formatScore(leader.score)}
            </td>
            <td>
              <LatestScore leader={leader} />
            </td>
            <td className="numeric text-ink-2">
              {leader.clusterId === null ? (
                <span className="text-ink-3">–</span>
              ) : (
                `#${leader.clusterId}`
              )}
            </td>
            <td>
              <TimeAgo iso={leader.lastFillAt} fallback="none stored" />
            </td>
            <td className="numeric">
              <CopyResults leader={leader} />
            </td>
            <td className="numeric text-ink-2">
              {leader.copyResults?.closedCopies ?? 0}
              <span className="text-ink-3"> closed</span>
              {leader.openCopies > 0 && (
                <span className="text-ink">, {leader.openCopies} open</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LeadersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = readStatusFilter(searchParams.get('status'));
  const status = filter === 'ALL' ? null : filter;
  const leaders = useQuery({
    queryKey: queryKeys.leaders(status),
    queryFn: () => api.listLeaders(status),
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHeader
        title="Leaders"
        description="Live and shadow leaders first, then candidates by smoothed score"
        actions={<AddLeaderForm />}
      />
      <Panel
        title={
          <Segmented
            label="Status"
            options={STATUS_FILTERS}
            value={filter}
            onChange={(value) =>
              setSearchParams(value === 'ALL' ? {} : { status: value })
            }
          />
        }
        actions={
          leaders.data !== undefined && (
            <span className="text-xs text-ink-3">
              {leaders.data.length} wallets
            </span>
          )
        }
        isFlush
      >
        {leaders.isPending ? (
          <LoadingNote />
        ) : leaders.isError ? (
          <ErrorNote message={describeError(leaders.error)} />
        ) : leaders.data.length === 0 ? (
          <EmptyNote>
            No wallet in this list. The daily discovery run fills the registry,
            and a wallet added by hand enters shadow at once.
          </EmptyNote>
        ) : (
          <TableScroll>
            <LeadersTable leaders={leaders.data} />
          </TableScroll>
        )}
      </Panel>
    </>
  );
}
