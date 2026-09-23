import type { DecisionResponse, OrderResponse } from '@remora/sdk';
import { Fragment, useState } from 'react';
import {
  formatDecimal,
  formatDuration,
  formatPrice,
  formatTime,
  formatUsd,
  formatUtc,
  humanize,
} from '../format';
import { useFreshDecisionIds } from '../freshDecisions';
import { Address } from './Address';
import { ChevronIcon } from './icons';
import { OrderStatusBadge, OutcomeBadge, VerdictBadge } from './StatusBadge';

function describeOrder(order: OrderResponse): string {
  const filled = Number(order.filledSize);
  if (filled === 0) {
    return `${order.isBuy ? 'Buy' : 'Sell'} ${formatDecimal(order.size)}`;
  }
  return `${order.isBuy ? 'Bought' : 'Sold'} ${formatDecimal(order.filledSize)} @ ${order.avgPx === null ? '–' : formatPrice(order.avgPx)}`;
}

function PositionMove({ decision }: { decision: DecisionResponse }) {
  return (
    <span className="text-ink-2">
      {formatDecimal(decision.positionBefore)}
      <span className="mx-1 text-ink-3">to</span>
      <span className="text-ink">{formatDecimal(decision.positionAfter)}</span>
    </span>
  );
}

function DecisionDetail({ decision }: { decision: DecisionResponse }) {
  const decisionMs =
    Date.parse(decision.decidedAt) - Date.parse(decision.leaderTime);
  const receiveMs =
    Date.parse(decision.receivedAt) - Date.parse(decision.leaderTime);
  return (
    <div className="grid gap-4 bg-canvas/60 px-4 py-4 whitespace-normal lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
          Policy trace
        </p>
        <ol className="divide-y divide-line/70 rounded-md border border-line bg-panel">
          {decision.trace.map((line, index) => (
            <li
              key={line.policy}
              className="grid grid-cols-[1.25rem_7.5rem_4rem_minmax(0,1fr)] items-start gap-2 px-3 py-1.5 text-xs"
            >
              <span className="text-ink-3 tabular-nums">{index + 1}</span>
              <span className="font-mono text-ink-2">{line.policy}</span>
              <span>
                <OutcomeBadge outcome={line.outcome} />
              </span>
              <span
                className={
                  line.outcome === 'skip' ? 'text-ink-3' : 'text-ink-2'
                }
              >
                {line.reason !== null && (
                  <span className="mr-1.5 font-mono text-warn">
                    {line.reason}
                  </span>
                )}
                {line.detail}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="min-w-0 space-y-4">
        <div>
          <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
            Signal
          </p>
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">Key</dt>
            <dd
              className="truncate font-mono text-ink-2"
              title={decision.signalKey}
            >
              {decision.signalKey}
            </dd>
            <dt className="text-ink-3">Source</dt>
            <dd className="text-ink-2">{humanize(decision.signalSource)}</dd>
            <dt className="text-ink-3">Leader VWAP</dt>
            <dd className="text-ink-2 tabular-nums">
              {formatPrice(decision.leaderVwap)}
            </dd>
            <dt className="text-ink-3">Leader fill</dt>
            <dd className="text-ink-2">{formatUtc(decision.leaderTime)}</dd>
            <dt className="text-ink-3">Received after</dt>
            <dd className="text-ink-2 tabular-nums">
              {formatDuration(receiveMs)}
            </dd>
            <dt className="text-ink-3">Decided after</dt>
            <dd className="text-ink-2 tabular-nums">
              {formatDuration(decisionMs)}
            </dd>
            <dt className="text-ink-3">Target size</dt>
            <dd className="text-ink-2 tabular-nums">
              {decision.targetSize === null
                ? '–'
                : formatDecimal(decision.targetSize)}
            </dd>
          </dl>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
            Orders
          </p>
          {decision.orders.length === 0 ? (
            <p className="text-xs text-ink-3">No order was placed.</p>
          ) : (
            <ul className="space-y-2">
              {decision.orders.map((order) => (
                <li
                  key={order.id}
                  className="rounded-md border border-line bg-panel px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">
                      {humanize(order.purpose.toLowerCase())}{' '}
                      <span className={order.isBuy ? 'text-up' : 'text-down'}>
                        {order.isBuy ? 'buy' : 'sell'}
                      </span>{' '}
                      {formatDecimal(order.size)} limit{' '}
                      {formatPrice(order.limitPx)}
                    </span>
                    <OrderStatusBadge status={order.status} />
                  </div>
                  <p className="mt-1 text-ink-3 tabular-nums">
                    {describeOrder(order)}
                    {order.slippageBps !== null &&
                      `, slippage ${order.slippageBps.toFixed(1)} bps`}
                    {Number(order.feeUsd) > 0 &&
                      `, fee ${formatUsd(order.feeUsd)}`}
                  </p>
                  {order.error !== null && (
                    <p className="mt-1 text-warn">{order.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function DecisionTable({
  decisions,
  showsWallet = true,
}: {
  decisions: DecisionResponse[];
  showsWallet?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const freshIds = useFreshDecisionIds();
  const columnCount = showsWallet ? 9 : 8;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="w-6" aria-label="Expand" />
          <th>Time (UTC)</th>
          <th>Coin</th>
          <th>Verdict</th>
          <th>Reason</th>
          {showsWallet && <th>Leader</th>}
          <th>Leader position</th>
          <th>Order</th>
          <th>Book</th>
        </tr>
      </thead>
      <tbody>
        {decisions.map((decision) => {
          const isOpen = expandedId === decision.id;
          const firstOrder = decision.orders.at(0);
          return (
            <Fragment key={decision.id}>
              <tr
                onClick={() => setExpandedId(isOpen ? null : decision.id)}
                className={`cursor-pointer hover:bg-raised/60 ${isOpen ? 'bg-raised/60' : ''} ${freshIds.has(decision.id) ? 'row-fresh' : ''}`}
              >
                <td className="text-ink-3">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'Hide trace' : 'Show trace'}
                    className="flex items-center"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedId(isOpen ? null : decision.id);
                    }}
                  >
                    <ChevronIcon isOpen={isOpen} />
                  </button>
                </td>
                <td
                  className="text-ink-2"
                  title={formatUtc(decision.decidedAt)}
                >
                  {formatTime(decision.decidedAt)}
                </td>
                <td className="font-medium text-ink">
                  {decision.coin}
                  <span className="ml-1.5 font-normal text-ink-3">
                    {decision.action.toLowerCase()}
                  </span>
                </td>
                <td>
                  <VerdictBadge verdict={decision.verdict} />
                </td>
                <td className="font-mono text-[11px] text-ink-2">
                  {decision.reason}
                </td>
                {showsWallet && (
                  <td onClick={(event) => event.stopPropagation()}>
                    <Address address={decision.walletAddress} />
                  </td>
                )}
                <td>
                  <PositionMove decision={decision} />
                </td>
                <td>
                  {firstOrder === undefined ? (
                    <span className="text-ink-3">–</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <OrderStatusBadge status={firstOrder.status} />
                      <span className="text-ink-2">
                        {describeOrder(firstOrder)}
                      </span>
                      {decision.orders.length > 1 && (
                        <span className="text-ink-3">
                          +{decision.orders.length - 1}
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="text-ink-3">{decision.book.toLowerCase()}</td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={columnCount} className="p-0!">
                    <DecisionDetail decision={decision} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
