import type { CopyPositionResponse } from '@remora/sdk';
import {
  formatAge,
  formatDateTime,
  formatDecimal,
  formatPrice,
  formatUsd,
  humanize,
  toneOf,
} from '../format';
import { Address } from './Address';
import { TimeAgo } from './TimeAgo';

function Side({ size }: { size: string }) {
  const amount = Number(size);
  if (amount === 0) {
    return <span className="text-ink-3">Flat</span>;
  }
  return amount > 0 ? (
    <span className="text-up">Long</span>
  ) : (
    <span className="text-down">Short</span>
  );
}

function netPnl(position: CopyPositionResponse): number {
  return (
    Number(position.realizedPnl) -
    Number(position.feesUsd) +
    Number(position.fundingUsd)
  );
}

export function OpenCopiesTable({
  positions,
  showsWallet = true,
}: {
  positions: CopyPositionResponse[];
  showsWallet?: boolean;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {showsWallet && <th>Leader</th>}
          <th>Coin</th>
          <th>Side</th>
          <th className="numeric">Size</th>
          <th className="numeric">Entry</th>
          <th className="numeric">Mark</th>
          <th className="numeric">Unrealized</th>
          <th className="numeric">Stop</th>
          <th className="numeric">k</th>
          <th>Opened</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => (
          <tr key={position.id}>
            {showsWallet && (
              <td>
                <Address address={position.walletAddress} />
              </td>
            )}
            <td className="font-medium text-ink">
              {position.coin}
              {position.book === 'SHADOW' && (
                <span className="ml-1.5 font-normal text-ink-3">shadow</span>
              )}
            </td>
            <td>
              <Side size={position.size} />
            </td>
            <td className="numeric text-ink">
              {formatDecimal(Math.abs(Number(position.size)))}
            </td>
            <td className="numeric text-ink-2">
              {position.entryPx === null ? '–' : formatPrice(position.entryPx)}
            </td>
            <td className="numeric text-ink-2">
              {position.markPx === null ? '–' : formatPrice(position.markPx)}
            </td>
            <td
              className={`numeric font-medium ${toneOf(position.unrealizedPnl)}`}
            >
              {position.unrealizedPnl === null
                ? '–'
                : formatUsd(position.unrealizedPnl, { signed: true })}
            </td>
            <td className="numeric text-ink-3">
              {position.stopPx === null ? '–' : formatPrice(position.stopPx)}
            </td>
            <td className="numeric text-ink-3">
              {Number(position.ratio).toPrecision(3)}
            </td>
            <td>
              <TimeAgo iso={position.openedAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ClosedCopiesTable({
  positions,
  showsWallet = true,
}: {
  positions: CopyPositionResponse[];
  showsWallet?: boolean;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {showsWallet && <th>Leader</th>}
          <th>Coin</th>
          <th>Closed (UTC)</th>
          <th className="numeric">Held</th>
          <th className="numeric">Realized</th>
          <th className="numeric">Fees</th>
          <th className="numeric">Funding</th>
          <th className="numeric">Net</th>
          <th>Close reason</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => (
          <tr key={position.id}>
            {showsWallet && (
              <td>
                <Address address={position.walletAddress} />
              </td>
            )}
            <td className="font-medium text-ink">
              {position.coin}
              {position.book === 'SHADOW' && (
                <span className="ml-1.5 font-normal text-ink-3">shadow</span>
              )}
            </td>
            <td className="text-ink-2">
              {position.closedAt === null
                ? '–'
                : formatDateTime(position.closedAt)}
            </td>
            <td className="numeric text-ink-3">
              {position.closedAt === null
                ? '–'
                : formatAge(
                    Date.parse(position.closedAt) -
                      Date.parse(position.openedAt),
                  )}
            </td>
            <td className={`numeric ${toneOf(position.realizedPnl)}`}>
              {formatUsd(position.realizedPnl, { signed: true })}
            </td>
            <td className="numeric text-ink-3">
              {formatUsd(position.feesUsd)}
            </td>
            <td className={`numeric ${toneOf(position.fundingUsd)}`}>
              {formatUsd(position.fundingUsd, { signed: true })}
            </td>
            <td className={`numeric font-medium ${toneOf(netPnl(position))}`}>
              {formatUsd(netPnl(position), { signed: true })}
            </td>
            <td className="text-ink-3">
              {position.closeReason === null
                ? '–'
                : humanize(position.closeReason)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
