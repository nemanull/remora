import type {
  LeaderDetailResponse,
  LeaderPositionResponse,
  LeaderResponse,
} from '@remora/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiError,
  api,
  describeError,
  type LeaderAction,
  queryKeys,
} from '../api';
import { CopyButton } from '../components/Address';
import { CopyGap } from '../components/CopyGap';
import { DecisionTable } from '../components/DecisionTable';
import { ExternalIcon } from '../components/icons';
import {
  EmptyNote,
  ErrorNote,
  LoadingNote,
  PageHeader,
  Panel,
  TableScroll,
} from '../components/Panel';
import {
  ClosedCopiesTable,
  OpenCopiesTable,
} from '../components/PositionsTable';
import { ScoreBreakdown } from '../components/ScoreBreakdown';
import { ScoreHistoryChart } from '../components/ScoreHistoryChart';
import { StatTile } from '../components/StatTile';
import { Badge, PausedBadge, StatusBadge } from '../components/StatusBadge';
import { TimeAgo } from '../components/TimeAgo';
import {
  formatDay,
  formatDecimal,
  formatPercent,
  formatPrice,
  formatScore,
  formatTime,
  formatUsd,
  formatUtc,
  humanize,
  toneOf,
} from '../format';

const EXPLORER_URL = 'https://app.hyperliquid.xyz/explorer/address';

function LeaderActions({ leader }: { leader: LeaderResponse }) {
  const queryClient = useQueryClient();
  const [isConfirmingRetire, setIsConfirmingRetire] = useState(false);
  const action = useMutation({
    mutationFn: (name: LeaderAction) =>
      api.runLeaderAction(leader.address, name),
    onSettled: () => {
      setIsConfirmingRetire(false);
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.leader(leader.address),
        }),
        queryClient.invalidateQueries({ queryKey: ['leaders'] }),
      ]);
    },
  });
  const isTracked = leader.status === 'SHADOW' || leader.status === 'LIVE';
  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex flex-wrap gap-2">
        {isTracked && !leader.isPaused && (
          <button
            type="button"
            className="button"
            disabled={action.isPending}
            onClick={() => action.mutate('pause')}
          >
            Pause entries
          </button>
        )}
        {isTracked && leader.isPaused && (
          <button
            type="button"
            className="button"
            disabled={action.isPending}
            onClick={() => action.mutate('resume')}
          >
            Resume
          </button>
        )}
        {leader.status === 'SHADOW' && (
          <button
            type="button"
            className="button button-primary"
            disabled={action.isPending}
            onClick={() => action.mutate('promote')}
          >
            Promote to live
          </button>
        )}
        {leader.status !== 'RETIRED' &&
          (isConfirmingRetire ? (
            <button
              type="button"
              className="button button-warn"
              disabled={action.isPending}
              onClick={() => action.mutate('retire')}
            >
              Confirm retirement
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={action.isPending}
              onClick={() => setIsConfirmingRetire(true)}
            >
              Retire
            </button>
          ))}
      </div>
      {action.isError && (
        <p className="max-w-md text-xs text-warn sm:text-right">
          {action.error instanceof ApiError
            ? `${humanize(action.error.reason)}${action.error.details.length > 0 ? `: ${action.error.details.map(humanize).join(', ')}` : ''}`
            : describeError(action.error)}
        </p>
      )}
    </div>
  );
}

function LeaderPositions({
  positions,
}: {
  positions: LeaderPositionResponse[];
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Coin</th>
          <th>Side</th>
          <th className="numeric">Size</th>
          <th className="numeric">Entry</th>
          <th className="numeric">Value</th>
          <th className="numeric">Unrealized</th>
          <th className="numeric">Leverage</th>
          <th className="numeric">Liquidation</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const size = Number(position.size);
          return (
            <tr key={position.coin}>
              <td className="font-medium text-ink">{position.coin}</td>
              <td className={size > 0 ? 'text-up' : 'text-down'}>
                {size > 0 ? 'Long' : 'Short'}
              </td>
              <td className="numeric text-ink">
                {formatDecimal(Math.abs(size))}
              </td>
              <td className="numeric text-ink-2">
                {formatPrice(position.entryPrice)}
              </td>
              <td className="numeric text-ink-2">
                {formatUsd(position.positionValue)}
              </td>
              <td className={`numeric ${toneOf(position.unrealizedPnl)}`}>
                {formatUsd(position.unrealizedPnl, { signed: true })}
              </td>
              <td className="numeric text-ink-3">
                {position.leverage}x {position.leverageType}
              </td>
              <td className="numeric text-ink-3">
                {position.liquidationPrice === null
                  ? '–'
                  : formatPrice(position.liquidationPrice)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RecentFills({ detail }: { detail: LeaderDetailResponse }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time (UTC)</th>
          <th>Coin</th>
          <th>Direction</th>
          <th className="numeric">Size</th>
          <th className="numeric">Price</th>
          <th className="numeric">Closed PnL</th>
          <th className="numeric">Fee</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {detail.recentFills.map((fill) => (
          <tr key={fill.id}>
            <td className="text-ink-2" title={formatUtc(fill.time)}>
              {formatDay(fill.time).slice(0, 6)} {formatTime(fill.time)}
            </td>
            <td className="font-medium text-ink">{fill.coin}</td>
            <td className={fill.isBuy ? 'text-up' : 'text-down'}>
              {fill.direction}
              {fill.isLiquidation && (
                <span className="ml-1.5 text-warn">liquidation</span>
              )}
            </td>
            <td className="numeric text-ink">{formatDecimal(fill.size)}</td>
            <td className="numeric text-ink-2">{formatPrice(fill.price)}</td>
            <td className={`numeric ${toneOf(fill.closedPnl)}`}>
              {Number(fill.closedPnl) === 0
                ? '–'
                : formatUsd(fill.closedPnl, { signed: true })}
            </td>
            <td className="numeric text-ink-3">{formatUsd(fill.fee)}</td>
            <td className="text-ink-3">{fill.source.toLowerCase()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LeaderHeader({ leader }: { leader: LeaderResponse }) {
  return (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base break-all sm:text-lg">
            {leader.address}
          </span>
          <CopyButton text={leader.address} />
          <a
            href={`${EXPLORER_URL}/${leader.address}`}
            target="_blank"
            rel="noreferrer"
            title="Open in the Hyperliquid explorer"
            className="inline-flex size-6 items-center justify-center rounded text-ink-3 hover:bg-raised hover:text-ink"
          >
            <ExternalIcon />
          </a>
        </span>
      }
      description={
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={leader.status} />
          {leader.isPaused && <PausedBadge reason={leader.statusReason} />}
          <Badge tone="muted">
            {leader.source === 'MANUAL' ? 'Added by hand' : 'From leaderboard'}
          </Badge>
          {leader.statusReason !== null && (
            <span className="text-xs text-ink-3">
              {humanize(leader.statusReason)}
            </span>
          )}
        </span>
      }
      actions={<LeaderActions leader={leader} />}
    />
  );
}

export function LeaderPage() {
  const { address = '' } = useParams();
  const detail = useQuery({
    queryKey: queryKeys.leader(address.toLowerCase()),
    queryFn: () => api.readLeader(address),
    refetchInterval: 15_000,
  });

  if (detail.isPending) {
    return <LoadingNote />;
  }
  if (detail.isError) {
    return (
      <>
        <PageHeader
          title="Leader"
          description={
            <Link to="/leaders" className="text-accent hover:underline">
              Back to leaders
            </Link>
          }
        />
        <Panel>
          <ErrorNote message={describeError(detail.error)} />
        </Panel>
      </>
    );
  }

  const { leader, state, scores, copies, recentDecisions, copyGaps } =
    detail.data;
  const latest = leader.latestScore;
  const openCopies = copies.filter((copy) => copy.isOpen);
  const closedCopies = copies.filter((copy) => !copy.isOpen);
  const results =
    leader.copyResults !== null && leader.copyResults.closedCopies > 0
      ? leader.copyResults
      : null;

  return (
    <>
      <LeaderHeader leader={leader} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Smoothed score"
          value={formatScore(leader.score)}
          detail={
            leader.scoredAt === null ? (
              'not ranked yet'
            ) : (
              <TimeAgo iso={leader.scoredAt} />
            )
          }
        />
        <StatTile
          label="Latest composite"
          value={formatScore(
            latest?.passed ? (latest.composite ?? latest.preliminary) : null,
          )}
          detail={
            latest === null
              ? 'no score stored'
              : latest.passed
                ? latest.runId
                : `failed ${latest.gateFailures.map(humanize).join(', ').toLowerCase()}`
          }
        />
        <StatTile
          label="Leader equity"
          value={
            state?.equityUsd === null || state === null
              ? '–'
              : formatUsd(state.equityUsd)
          }
          detail={
            state?.equityAt === null || state === null ? (
              'from portfolio'
            ) : (
              <TimeAgo iso={state.equityAt} />
            )
          }
        />
        <StatTile
          label="Copy return"
          value={
            results === null ? (
              '–'
            ) : (
              <span className={toneOf(results.returnOnAllocation * 100)}>
                {formatPercent(results.returnOnAllocation, { signed: true })}
              </span>
            )
          }
          detail={
            results === null
              ? 'no closed copy yet'
              : `${results.closedCopies} closed ${results.book.toLowerCase()} ${results.closedCopies === 1 ? 'copy' : 'copies'}, drawdown ${formatPercent(results.maxDrawdown, { digits: 1 })}`
          }
        />
        <StatTile
          label={leader.status === 'LIVE' ? 'Live since' : 'Tracked since'}
          value={
            (leader.liveSince ?? leader.trackedSince) === null
              ? '–'
              : formatDay(leader.liveSince ?? leader.trackedSince ?? '')
          }
          detail={
            leader.clusterId === null
              ? 'no collector assigned'
              : `on collector #${leader.clusterId}`
          }
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Panel
          className="xl:col-span-3"
          title="Score breakdown"
          description="What each component of the latest run contributed"
        >
          {latest === null ? (
            <EmptyNote>
              This wallet has no score yet. A wallet added by hand is scored in
              the next daily run.
            </EmptyNote>
          ) : (
            <ScoreBreakdown score={latest} />
          )}
        </Panel>
        <Panel
          className="xl:col-span-2"
          title="Score history"
          description="Composite per scoring run"
        >
          {scores.length < 2 ? (
            <EmptyNote>
              The history appears after the wallet has been scored in two runs.
            </EmptyNote>
          ) : (
            <ScoreHistoryChart scores={scores} />
          )}
        </Panel>
      </div>

      <Panel
        className="mt-4"
        title="Leader positions"
        description={
          state?.positionsAt == null ? undefined : (
            <>
              From clearinghouseState, <TimeAgo iso={state.positionsAt} />
            </>
          )
        }
        isFlush
      >
        {state === null || state.positions.length === 0 ? (
          <EmptyNote>The leader holds no main-dex perp position.</EmptyNote>
        ) : (
          <TableScroll>
            <LeaderPositions positions={state.positions} />
          </TableScroll>
        )}
      </Panel>

      <Panel
        className="mt-4"
        title="Copies"
        description="Open copies first, then closed ones"
        isFlush
      >
        {copies.length === 0 ? (
          <EmptyNote>No copy of this leader yet.</EmptyNote>
        ) : (
          <div className="divide-y divide-line">
            {openCopies.length > 0 && (
              <TableScroll>
                <OpenCopiesTable positions={openCopies} showsWallet={false} />
              </TableScroll>
            )}
            {closedCopies.length > 0 && (
              <TableScroll>
                <ClosedCopiesTable
                  positions={closedCopies}
                  showsWallet={false}
                />
              </TableScroll>
            )}
          </div>
        )}
      </Panel>

      <Panel
        className="mt-4"
        title="Copy gap"
        description="Our PnL after fees and funding against k times the leader’s PnL over the same episode"
      >
        {copyGaps.length === 0 ? (
          <EmptyNote>
            The gap is measured once a copy of this leader has closed.
          </EmptyNote>
        ) : (
          <CopyGap gaps={copyGaps} />
        )}
      </Panel>

      <Panel
        className="mt-4"
        title="Decisions"
        description="The latest 50, click a row for its policy trace"
        isFlush
      >
        {recentDecisions.length === 0 ? (
          <EmptyNote>No decision for this leader yet.</EmptyNote>
        ) : (
          <TableScroll>
            <DecisionTable decisions={recentDecisions} showsWallet={false} />
          </TableScroll>
        )}
      </Panel>

      <Panel
        className="mt-4"
        title="Recent fills"
        description="Main-dex perp fills as stored by ingestion"
        isFlush
      >
        {detail.data.recentFills.length === 0 ? (
          <EmptyNote>No fill stored for this wallet.</EmptyNote>
        ) : (
          <TableScroll>
            <RecentFills detail={detail.data} />
          </TableScroll>
        )}
      </Panel>
    </>
  );
}
