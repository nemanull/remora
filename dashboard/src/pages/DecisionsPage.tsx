import type { BookName, DecisionReason, Verdict } from '@remora/sdk';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type DecisionFilters, describeError, queryKeys } from '../api';
import { DecisionTable } from '../components/DecisionTable';
import {
  EmptyNote,
  ErrorNote,
  LoadingNote,
  PageHeader,
  Panel,
  Segmented,
} from '../components/Panel';
import { humanize } from '../format';

const REASONS: DecisionReason[] = [
  'copied',
  'already_at_target',
  'below_min_notional',
  'position_not_copied',
  'stale_signal',
  'price_drift',
  'mid_unavailable',
  'leader_equity_stale',
  'cap_reached',
  'insufficient_margin',
  'coin_owned_by_other_leader',
  'kill_switch_active',
  'leader_not_copied',
  'leader_paused',
  'unsupported_instrument',
  'isolated_only_market',
  'out_of_order',
];

const BOOK_OPTIONS: { value: 'ALL' | BookName; label: string }[] = [
  { value: 'ALL', label: 'Both books' },
  { value: 'MAIN', label: 'Main' },
  { value: 'SHADOW', label: 'Shadow' },
];

const VERDICT_OPTIONS: { value: 'ALL' | Verdict; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'COPY', label: 'Copied' },
  { value: 'SKIP', label: 'Skipped' },
];

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function readFilters(searchParams: URLSearchParams): DecisionFilters {
  const book = searchParams.get('book');
  const verdict = searchParams.get('verdict');
  const reason = searchParams.get('reason');
  const wallet = searchParams.get('wallet')?.toLowerCase() ?? null;
  return {
    book: book === 'MAIN' || book === 'SHADOW' ? book : null,
    verdict: verdict === 'COPY' || verdict === 'SKIP' ? verdict : null,
    reason: REASONS.some((code) => code === reason) ? reason : null,
    wallet: wallet !== null && ADDRESS_PATTERN.test(wallet) ? wallet : null,
  };
}

export function DecisionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);
  const [walletInput, setWalletInput] = useState(filters.wallet ?? '');
  const updateFilter = (key: keyof DecisionFilters, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === 'ALL' || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next);
  };
  const decisions = useInfiniteQuery({
    queryKey: queryKeys.decisions(filters),
    queryFn: ({ pageParam }) => api.listDecisions(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const rows = decisions.data?.pages.flatMap((page) => page.decisions) ?? [];
  const walletIsInvalid =
    walletInput.trim() !== '' &&
    !ADDRESS_PATTERN.test(walletInput.trim().toLowerCase());

  return (
    <>
      <PageHeader
        title="Decision log"
        description="Every leader move in both books, with the policy trace that decided it"
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          label="Book"
          options={BOOK_OPTIONS}
          value={filters.book ?? 'ALL'}
          onChange={(value) => updateFilter('book', value)}
        />
        <Segmented
          label="Verdict"
          options={VERDICT_OPTIONS}
          value={filters.verdict ?? 'ALL'}
          onChange={(value) => updateFilter('verdict', value)}
        />
        <select
          aria-label="Reason"
          className="input font-sans"
          value={filters.reason ?? ''}
          onChange={(event) => updateFilter('reason', event.target.value)}
        >
          <option value="">Any reason</option>
          {REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {humanize(reason)}
            </option>
          ))}
        </select>
        <form
          className="flex min-w-0 flex-1 gap-2 sm:flex-none"
          onSubmit={(event) => {
            event.preventDefault();
            if (!walletIsInvalid) {
              updateFilter('wallet', walletInput.trim().toLowerCase());
            }
          }}
        >
          <input
            aria-label="Leader wallet"
            className={`input min-w-0 flex-1 sm:w-72 ${walletIsInvalid ? 'border-warn' : ''}`}
            placeholder="Filter by leader, 0x…"
            spellCheck={false}
            value={walletInput}
            onChange={(event) => setWalletInput(event.target.value)}
          />
          {filters.wallet !== null && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setWalletInput('');
                updateFilter('wallet', null);
              }}
            >
              Clear
            </button>
          )}
        </form>
      </div>
      <Panel isFlush>
        {decisions.isPending ? (
          <LoadingNote />
        ) : decisions.isError ? (
          <ErrorNote message={describeError(decisions.error)} />
        ) : rows.length === 0 ? (
          <EmptyNote>
            No decision matches these filters. New decisions appear here as they
            happen.
          </EmptyNote>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DecisionTable decisions={rows} />
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-xs text-ink-3">
              <span>{rows.length} decisions shown, newest first, live</span>
              {decisions.hasNextPage && (
                <button
                  type="button"
                  className="button"
                  disabled={decisions.isFetchingNextPage}
                  onClick={() => void decisions.fetchNextPage()}
                >
                  {decisions.isFetchingNextPage ? 'Loading…' : 'Load older'}
                </button>
              )}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
