import type { ClusterResponse } from '@remora/sdk';
import { useQuery } from '@tanstack/react-query';
import { api, describeError, queryKeys } from '../api';
import { Address } from '../components/Address';
import {
  EmptyNote,
  ErrorNote,
  LoadingNote,
  PageHeader,
  Panel,
} from '../components/Panel';
import { StatTile } from '../components/StatTile';
import {
  BackfillBadge,
  Badge,
  OnlineBadge,
  StatusBadge,
} from '../components/StatusBadge';
import { TimeAgo } from '../components/TimeAgo';
import { formatAge, formatBytes } from '../format';
import { useNow } from '../useNow';

const STALE_EVENT_MS = 120_000;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function formatMs(value: number | null): string {
  return value === null ? '–' : `${Math.round(value)} ms`;
}

function CapacityBar({ used, total }: { used: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-1.5 flex-1 gap-0.5">
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={`flex-1 rounded-full ${index < used ? 'bg-accent' : 'bg-raised'}`}
          />
        ))}
      </div>
      <span className="text-xs text-ink-2 tabular-nums">
        {used} of {total}
      </span>
    </div>
  );
}

function ClusterCard({ cluster }: { cluster: ClusterResponse }) {
  const now = useNow();
  const stats = cluster.isOnline ? cluster.stats : null;
  const capacity = cluster.maxWallets ?? 0;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Cluster {cluster.id}
          <OnlineBadge isOnline={cluster.isOnline} />
          {stats !== null && stats.upstreamState !== 'open' && (
            <Badge tone="warn">Upstream {stats.upstreamState}</Badge>
          )}
        </span>
      }
      description={
        cluster.isOnline ? (
          <>
            Version {cluster.version ?? '–'}, connected{' '}
            <TimeAgo iso={cluster.connectedAt} />
          </>
        ) : (
          <>
            Last heartbeat{' '}
            <TimeAgo iso={cluster.lastHeartbeatAt} fallback="never" />
          </>
        )
      }
      isFlush
    >
      <div className="space-y-4 px-4 py-4">
        {capacity > 0 && (
          <CapacityBar used={cluster.wallets.length} total={capacity} />
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
          <Metric
            label="Heartbeat"
            value={
              cluster.lastHeartbeatAt === null
                ? '–'
                : `${formatAge(now - Date.parse(cluster.lastHeartbeatAt))} ago`
            }
          />
          <Metric
            label="Ping round trip"
            value={formatMs(stats?.pingRoundTripMs ?? null)}
          />
          <Metric
            label="Clock offset"
            value={formatMs(stats?.clockOffsetMs ?? null)}
          />
          <Metric
            label="Loop delay p99"
            value={formatMs(stats?.eventLoopDelayP99Ms ?? null)}
          />
          <Metric
            label="Upstream reconnects"
            value={stats === null ? '–' : String(stats.upstreamReconnects)}
          />
          <Metric
            label="REST weight, last min"
            value={stats === null ? '–' : String(stats.weightUsedLastMinute)}
          />
          <Metric
            label="Memory"
            value={stats === null ? '–' : formatBytes(stats.rssBytes)}
          />
          <Metric
            label="Assign version"
            value={String(cluster.assignVersion)}
          />
        </dl>
      </div>
      {cluster.wallets.length === 0 ? (
        <p className="border-t border-line px-4 py-4 text-xs text-ink-3">
          No wallet is assigned to this collector.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="data-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Status</th>
                <th>Subscription</th>
                <th>Subscribed</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {cluster.wallets.map((wallet) => {
                const isQuiet =
                  wallet.lastEventAt !== null &&
                  now - Date.parse(wallet.lastEventAt) > STALE_EVENT_MS;
                return (
                  <tr key={wallet.address}>
                    <td>
                      <Address address={wallet.address} />
                    </td>
                    <td>
                      <StatusBadge status={wallet.status} />
                    </td>
                    <td>
                      <BackfillBadge
                        state={cluster.isOnline ? wallet.backfill : null}
                      />
                    </td>
                    <td>
                      <TimeAgo iso={wallet.subscribedAt} fallback="not yet" />
                    </td>
                    <td className={isQuiet ? 'text-ink-3' : undefined}>
                      <TimeAgo iso={wallet.lastEventAt} fallback="none yet" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function CollectorsPage() {
  const clusters = useQuery({
    queryKey: queryKeys.clusters,
    queryFn: api.listClusters,
    refetchInterval: 10_000,
  });

  if (clusters.isPending) {
    return (
      <>
        <PageHeader title="Collectors" />
        <LoadingNote />
      </>
    );
  }
  if (clusters.isError) {
    return (
      <>
        <PageHeader title="Collectors" />
        <Panel>
          <ErrorNote message={describeError(clusters.error)} />
        </Panel>
      </>
    );
  }

  const { clusters: list, waitingWallets } = clusters.data;
  const online = list.filter((cluster) => cluster.isOnline);
  const assigned = list.reduce(
    (total, cluster) => total + cluster.wallets.length,
    0,
  );
  const subscribed = online.reduce(
    (total, cluster) =>
      total +
      cluster.wallets.filter((wallet) => wallet.subscribedAt !== null).length,
    0,
  );
  const capacity = online.reduce(
    (total, cluster) => total + (cluster.maxWallets ?? 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Collectors"
        description="One collector per public IP, each watching at most 8 wallets to stay under Hyperliquid’s limit of 10 users per IP"
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Online"
          value={`${online.length} of ${list.length}`}
          detail="collectors with a live session"
        />
        <StatTile
          label="Subscribed"
          value={subscribed}
          detail={`${assigned} assigned wallets`}
        />
        <StatTile
          label="Capacity"
          value={capacity}
          detail="wallet slots on online collectors"
        />
        <StatTile
          label="Waiting"
          value={
            <span
              className={waitingWallets.length > 0 ? 'text-warn' : undefined}
            >
              {waitingWallets.length}
            </span>
          }
          detail="tracked wallets without a collector"
        />
      </div>
      {waitingWallets.length > 0 && (
        <Panel
          className="mt-4"
          title="Waiting for capacity"
          description="Tracked wallets that no live collector has room for right now"
        >
          <ul className="flex flex-wrap gap-2">
            {waitingWallets.map((address) => (
              <li
                key={address}
                className="rounded-md border border-warn/30 bg-warn-soft px-2 py-1 text-xs"
              >
                <Address address={address} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {list.length === 0 ? (
        <Panel className="mt-4">
          <EmptyNote>
            No collector has connected yet. Start one with its cluster id and
            token, and it appears here on its first hello.
          </EmptyNote>
        </Panel>
      ) : (
        <div className="mt-4 grid gap-4 2xl:grid-cols-2">
          {list.map((cluster) => (
            <ClusterCard key={cluster.id} cluster={cluster} />
          ))}
        </div>
      )}
    </>
  );
}
