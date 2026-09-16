export type AssignmentWallet = {
  address: string;
  status: 'CANDIDATE' | 'SHADOW' | 'LIVE' | 'RETIRED';
  isManual: boolean;
  hasOpenCopy: boolean;
  score: number | null;
};

export type AssignmentCluster = {
  id: number;
  isOnline: boolean;
  capacity: number;
  offlineSince: Date | null;
  refusedWallets: ReadonlySet<string>;
};

export type AssignmentInput = {
  wallets: readonly AssignmentWallet[];
  clusters: readonly AssignmentCluster[];
  current: ReadonlyMap<string, number>;
  now: Date;
  graceMs: number;
};

export type AssignmentResult = {
  assignments: Map<string, number>;
  waiting: string[];
};

type RankedWallet = AssignmentWallet & { rank: number };

function readTier(wallet: AssignmentWallet): number {
  if (wallet.hasOpenCopy) {
    return 0;
  }
  if (wallet.status === 'LIVE') {
    return 1;
  }
  return wallet.isManual ? 2 : 3;
}

export function rankWallets(
  wallets: readonly AssignmentWallet[],
): AssignmentWallet[] {
  return [...wallets].sort((first, second) => {
    const tierDifference = readTier(first) - readTier(second);
    if (tierDifference !== 0) {
      return tierDifference;
    }
    const firstScore = first.score ?? Number.NEGATIVE_INFINITY;
    const secondScore = second.score ?? Number.NEGATIVE_INFINITY;
    if (firstScore !== secondScore) {
      return secondScore > firstScore ? 1 : -1;
    }
    return first.address < second.address ? -1 : 1;
  });
}

function canPreempt(wallet: AssignmentWallet): boolean {
  return wallet.hasOpenCopy || wallet.status === 'LIVE';
}

function isPreemptible(wallet: AssignmentWallet): boolean {
  return wallet.status === 'SHADOW' && !wallet.hasOpenCopy;
}

export function assignWallets(input: AssignmentInput): AssignmentResult {
  const { current, now, graceMs } = input;
  const ranked: RankedWallet[] = rankWallets(input.wallets).map(
    (wallet, rank) => ({ ...wallet, rank }),
  );
  const clusters = [...input.clusters].sort(
    (first, second) => first.id - second.id,
  );
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const members = new Map<number, RankedWallet[]>(
    clusters.map((cluster) => [cluster.id, []]),
  );
  const assignments = new Map<string, number>();

  const isHolding = (cluster: AssignmentCluster) =>
    cluster.isOnline ||
    (cluster.offlineSince !== null &&
      now.getTime() - cluster.offlineSince.getTime() < graceMs);
  const readMembers = (cluster: AssignmentCluster) =>
    members.get(cluster.id) ?? [];
  const readFreeSlots = (cluster: AssignmentCluster) =>
    cluster.capacity - readMembers(cluster).length;
  const canTake = (cluster: AssignmentCluster, wallet: RankedWallet) =>
    !cluster.refusedWallets.has(wallet.address);
  const place = (wallet: RankedWallet, cluster: AssignmentCluster) => {
    readMembers(cluster).push(wallet);
    assignments.set(wallet.address, cluster.id);
  };

  const pending: RankedWallet[] = [];
  for (const wallet of ranked) {
    const clusterId = current.get(wallet.address);
    const cluster =
      clusterId === undefined ? undefined : clusterById.get(clusterId);
    if (
      cluster &&
      isHolding(cluster) &&
      canTake(cluster, wallet) &&
      readFreeSlots(cluster) > 0
    ) {
      place(wallet, cluster);
    } else {
      pending.push(wallet);
    }
  }

  const onlineClusters = clusters.filter((cluster) => cluster.isOnline);
  const findFreeCluster = (wallet: RankedWallet) => {
    let best: AssignmentCluster | null = null;
    for (const cluster of onlineClusters) {
      if (
        canTake(cluster, wallet) &&
        readFreeSlots(cluster) > 0 &&
        (best === null || readFreeSlots(cluster) > readFreeSlots(best))
      ) {
        best = cluster;
      }
    }
    return best;
  };
  const findPreemptionVictim = (wallet: RankedWallet) => {
    let victim: { wallet: RankedWallet; cluster: AssignmentCluster } | null =
      null;
    for (const cluster of onlineClusters) {
      if (!canTake(cluster, wallet)) {
        continue;
      }
      for (const member of readMembers(cluster)) {
        if (
          isPreemptible(member) &&
          (victim === null || member.rank > victim.wallet.rank)
        ) {
          victim = { wallet: member, cluster };
        }
      }
    }
    return victim;
  };
  const queueByRank = (wallet: RankedWallet, from: number) => {
    let index = from;
    while (index < pending.length && pending[index].rank < wallet.rank) {
      index += 1;
    }
    pending.splice(index, 0, wallet);
  };

  const waiting: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const wallet = pending[index];
    const freeCluster = findFreeCluster(wallet);
    if (freeCluster) {
      place(wallet, freeCluster);
      continue;
    }
    const victim = canPreempt(wallet) ? findPreemptionVictim(wallet) : null;
    if (!victim) {
      waiting.push(wallet.address);
      continue;
    }
    const victimCluster = readMembers(victim.cluster);
    victimCluster.splice(victimCluster.indexOf(victim.wallet), 1);
    assignments.delete(victim.wallet.address);
    place(wallet, victim.cluster);
    queueByRank(victim.wallet, index + 1);
  }

  return { assignments, waiting };
}
