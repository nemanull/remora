import type {
  BookName,
  BookSummaryResponse,
  OverviewResponse,
} from '@remora/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, type DecisionFilters, describeError, queryKeys } from '../api';
import { DecisionTable } from '../components/DecisionTable';
import { EquityChart } from '../components/EquityChart';
import {
  EmptyNote,
  ErrorNote,
  LoadingNote,
  PageHeader,
  Panel,
  Segmented,
  TableScroll,
} from '../components/Panel';
import { OpenCopiesTable } from '../components/PositionsTable';
import { StatTile } from '../components/StatTile';
import { Badge } from '../components/StatusBadge';
import { TimeAgo } from '../components/TimeAgo';
import { formatPercent, formatUsd, formatUtc, toneOf } from '../format';

const RECENT_DECISIONS: DecisionFilters = {
  book: null,
  verdict: null,
  reason: null,
  wallet: null,
};
const RECENT_DECISION_COUNT = 8;

const RANGES = [
  { value: '1', label: '1D' },
  { value: '7', label: '7D' },
  { value: '30', label: '30D' },
];

const BOOKS: { value: BookName; label: string }[] = [
  { value: 'MAIN', label: 'Main' },
  { value: 'SHADOW', label: 'Shadow' },
];

function findBook(
  overview: OverviewResponse | undefined,
  book: BookName,
): BookSummaryResponse | undefined {
  return overview?.books.find((summary) => summary.book === book);
}

function DayPnl({ book }: { book: BookSummaryResponse }) {
  if (book.dayPnl === null || book.dayStartEquity === null) {
    return null;
  }
  const share = Number(book.dayPnl) / Number(book.dayStartEquity);
  return (
    <span className={toneOf(book.dayPnl)}>
      {formatUsd(book.dayPnl, { signed: true })} (
      {formatPercent(share, { signed: true })}) today
    </span>
  );
}

function KillSwitchPanel({ overview }: { overview: OverviewResponse }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      api.setKillSwitch(active, active ? reason.trim() || null : null),
    onSuccess: () => {
      setReason('');
      return queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
  });
  const { active, reason: activeReason } = overview.killSwitch;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Kill switch
          {active ? (
            <Badge tone="warn" hasDot>
              Active
            </Badge>
          ) : (
            <Badge tone="neutral">Off</Badge>
          )}
        </span>
      }
      description="Blocks new entries on the main book, exits keep running"
    >
      {active ? (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-2">
            {activeReason === null ? 'Set by hand.' : activeReason}
          </p>
          <button
            type="button"
            className="button"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(false)}
          >
            Clear the kill switch
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            toggle.mutate(true);
          }}
        >
          <input
            className="input min-w-0 flex-1 font-sans"
            placeholder="Reason, for the log"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="submit"
            className="button button-warn"
            disabled={toggle.isPending}
          >
            Set
          </button>
        </form>
      )}
      {toggle.isError && (
        <p className="mt-2 text-xs text-warn">{describeError(toggle.error)}</p>
      )}
      <p className="mt-3 text-[11px] text-ink-3">
        It also trips by itself when main equity falls 5% below the day’s start,
        and clears at 00:00 UTC.
      </p>
    </Panel>
  );
}

function formatCount(count: number | null): string {
  return count === null ? '–' : count.toLocaleString('en-US');
}

function DiscoveryPanel({ overview }: { overview: OverviewResponse }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: api.startDiscoveryRun,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.overview }),
  });
  const run = overview.lastScoringRun;
  return (
    <Panel
      title="Discovery"
      description="Daily leaderboard scoring at 02:00 UTC"
      actions={
        <button
          type="button"
          className="button"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          Run now
        </button>
      }
    >
      {run === null ? (
        <p className="text-xs text-ink-3">No scoring run has reported yet.</p>
      ) : (
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-ink-3">Last run</dt>
          <dd className="truncate font-mono text-ink-2">{run.id}</dd>
          <dt className="text-ink-3">Started</dt>
          <dd>
            <TimeAgo iso={run.startedAt} />
          </dd>
          <dt className="text-ink-3">State</dt>
          <dd className="text-ink-2">
            {run.finishedAt === null ? (
              <span className="text-accent">
                Scoring, {run.storedScores} of {run.expectedScores ?? '?'}{' '}
                stored
              </span>
            ) : (
              <span title={formatUtc(run.finishedAt)}>
                Finished with {run.storedScores} scores
              </span>
            )}
          </dd>
          <dt className="text-ink-3">Leaderboard</dt>
          <dd className="text-ink-2 tabular-nums">
            {formatCount(run.leaderboardRows)} rows,{' '}
            {formatCount(run.stageOneCount)} kept
          </dd>
          <dt className="text-ink-3">Scored</dt>
          <dd className="text-ink-2 tabular-nums">
            {formatCount(run.stageTwoCount)} wallets,{' '}
            {formatCount(run.stageThreeCount)} ranked
          </dd>
        </dl>
      )}
      {start.isSuccess && (
        <p className="mt-3 text-xs text-accent">
          Queued {start.data.runId} with {start.data.trackedAddresses} tracked
          wallets.
        </p>
      )}
      {start.isError && (
        <p className="mt-3 text-xs text-warn">{describeError(start.error)}</p>
      )}
    </Panel>
  );
}

function CollectorsSummary() {
  const clusters = useQuery({
    queryKey: queryKeys.clusters,
    queryFn: api.listClusters,
  });
  const data = clusters.data;
  const online = data?.clusters.filter((cluster) => cluster.isOnline) ?? [];
  const subscribed = online.reduce(
    (total, cluster) =>
      total +
      cluster.wallets.filter((wallet) => wallet.subscribedAt !== null).length,
    0,
  );
  return (
    <Panel
      title="Collectors"
      actions={
        <Link to="/collectors" className="text-xs text-accent hover:underline">
          Details
        </Link>
      }
    >
      {data === undefined ? (
        <p className="text-xs text-ink-3">Loading…</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <p className="text-ink-3">Online</p>
            <p className="mt-0.5 text-base font-semibold text-ink">
              {online.length}
              <span className="text-ink-3"> / {data.clusters.length}</span>
            </p>
          </div>
          <div>
            <p className="text-ink-3">Subscribed</p>
            <p className="mt-0.5 text-base font-semibold text-ink">
              {subscribed}
            </p>
          </div>
          <div>
            <p className="text-ink-3">Waiting</p>
            <p
              className={`mt-0.5 text-base font-semibold ${data.waitingWallets.length > 0 ? 'text-warn' : 'text-ink'}`}
            >
              {data.waitingWallets.length}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function OverviewPage() {
  const [book, setBook] = useState<BookName>('MAIN');
  const [days, setDays] = useState('7');
  const overview = useQuery({
    queryKey: queryKeys.overview,
    queryFn: api.readOverview,
    refetchInterval: 15_000,
  });
  const equity = useQuery({
    queryKey: queryKeys.equity(book, Number(days)),
    queryFn: () => api.listEquity(book, Number(days)),
    refetchInterval: 60_000,
  });
  const positions = useQuery({
    queryKey: queryKeys.positions('MAIN'),
    queryFn: () => api.listPositions('MAIN'),
    refetchInterval: 15_000,
  });
  const decisions = useQuery({
    queryKey: queryKeys.decisions(RECENT_DECISIONS, RECENT_DECISION_COUNT),
    queryFn: () =>
      api.listDecisions(RECENT_DECISIONS, null, RECENT_DECISION_COUNT),
  });

  if (overview.isError) {
    return (
      <>
        <PageHeader title="Overview" />
        <Panel>
          <ErrorNote message={describeError(overview.error)} />
        </Panel>
      </>
    );
  }

  const data = overview.data;
  const main = findBook(data, 'MAIN');
  const shadow = findBook(data, 'SHADOW');
  const counts = data?.leaderCounts;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          data === undefined
            ? 'Loading the books…'
            : `${data.mode === 'live' ? 'Live' : 'Paper'} execution, ${data.promotionMode} promotion from shadow to live`
        }
      />
      {data?.killSwitch.active && (
        <div className="mb-5 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-xs text-warn">
          The kill switch is active, so the main book opens no new copies.
          {data.killSwitch.reason !== null && (
            <span className="text-ink-2"> {data.killSwitch.reason}</span>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Main book equity"
          value={main === undefined ? '–' : formatUsd(main.valueUsd)}
          detail={main === undefined ? undefined : <DayPnl book={main} />}
        />
        <StatTile
          label="Shadow book PnL"
          value={
            shadow === undefined ? (
              '–'
            ) : (
              <span className={toneOf(shadow.valueUsd)}>
                {formatUsd(shadow.valueUsd, { signed: true })}
              </span>
            )
          }
          detail={
            shadow === undefined ? undefined : (
              <span className={toneOf(shadow.realizedPnlToday)}>
                {formatUsd(shadow.realizedPnlToday, { signed: true })} realized
                today
              </span>
            )
          }
        />
        <StatTile
          label="Gross exposure"
          value={main === undefined ? '–' : formatUsd(main.grossExposureUsd)}
          detail={
            main === undefined ? undefined : (
              <>
                {main.openPositions} open{' '}
                {main.openPositions === 1 ? 'copy' : 'copies'},{' '}
                <span className={toneOf(main.unrealizedPnl)}>
                  {formatUsd(main.unrealizedPnl, { signed: true })}
                </span>{' '}
                unrealized
              </>
            )
          }
        />
        <StatTile
          label="Leaders"
          value={
            counts === undefined
              ? '–'
              : `${counts.LIVE + counts.SHADOW} tracked`
          }
          detail={
            counts === undefined
              ? undefined
              : `${counts.LIVE} live, ${counts.SHADOW} shadow, ${counts.CANDIDATE} candidates`
          }
        />
      </div>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title={book === 'MAIN' ? 'Main book equity' : 'Shadow book PnL'}
          description={
            book === 'MAIN'
              ? 'Snapshots every 5 minutes, marked at the mids'
              : 'Net PnL of every shadow copy after fees and funding, snapshots every 5 minutes, marked at the mids'
          }
          actions={
            <>
              <Segmented
                label="Book"
                options={BOOKS}
                value={book}
                onChange={setBook}
              />
              <Segmented
                label="Range"
                options={RANGES}
                value={days}
                onChange={setDays}
              />
            </>
          }
        >
          {equity.isPending ? (
            <LoadingNote />
          ) : equity.isError ? (
            <ErrorNote message={describeError(equity.error)} />
          ) : equity.data.length < 2 ? (
            <EmptyNote>
              Not enough snapshots in this range yet. The book is snapshotted
              every 5 minutes.
            </EmptyNote>
          ) : (
            <div className={equity.isFetching ? 'opacity-70' : undefined}>
              <EquityChart points={equity.data} />
            </div>
          )}
        </Panel>
        <div className="grid content-start gap-4">
          {data !== undefined && <KillSwitchPanel overview={data} />}
          {data !== undefined && <DiscoveryPanel overview={data} />}
          <CollectorsSummary />
        </div>
      </div>

      <Panel
        className="mt-4"
        title="Open copies"
        description="Main book, marked at the latest mid"
        isFlush
      >
        {positions.isPending ? (
          <LoadingNote />
        ) : positions.isError ? (
          <ErrorNote message={describeError(positions.error)} />
        ) : positions.data.open.length === 0 ? (
          <EmptyNote>
            The main book holds no copy right now. Copies open when a live
            leader opens a position.
          </EmptyNote>
        ) : (
          <TableScroll>
            <OpenCopiesTable positions={positions.data.open} />
          </TableScroll>
        )}
      </Panel>

      <Panel
        className="mt-4"
        title="Latest decisions"
        description="Both books, newest first"
        actions={
          <Link to="/decisions" className="text-xs text-accent hover:underline">
            Full log
          </Link>
        }
        isFlush
      >
        {decisions.isPending ? (
          <LoadingNote />
        ) : decisions.isError ? (
          <ErrorNote message={describeError(decisions.error)} />
        ) : decisions.data.decisions.length === 0 ? (
          <EmptyNote>
            No decision yet. Every move of a tracked leader lands here with its
            reason.
          </EmptyNote>
        ) : (
          <TableScroll>
            <DecisionTable decisions={decisions.data.decisions} />
          </TableScroll>
        )}
      </Panel>
    </>
  );
}
