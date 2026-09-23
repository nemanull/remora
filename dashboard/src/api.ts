import type {
  ApiErrorResponse,
  BookEquityPointResponse,
  BookName,
  ClustersResponse,
  CopyPositionsResponse,
  DecisionsPageResponse,
  DiscoveryRunResponse,
  KillSwitchResponse,
  LeaderDetailResponse,
  LeaderResponse,
  OverviewResponse,
  Verdict,
  WalletStatus,
} from '@remora/sdk';

export type LeaderAction = 'pause' | 'resume' | 'promote' | 'retire';

export type DecisionFilters = {
  book: BookName | null;
  verdict: Verdict | null;
  reason: string | null;
  wallet: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly details: string[],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
  });
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(
      response.status,
      body?.reason ?? 'request_failed',
      body?.message ?? `${response.status} ${response.statusText}`,
      body?.details ?? [],
    );
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function withQuery(path: string, query: Record<string, string | null>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== '') {
      parameters.set(key, value);
    }
  }
  const text = parameters.toString();
  return text === '' ? path : `${path}?${text}`;
}

export const api = {
  readOverview: () => request<OverviewResponse>('/api/overview'),
  listLeaders: (status: WalletStatus | null) =>
    request<LeaderResponse[]>(withQuery('/api/leaders', { status })),
  readLeader: (address: string) =>
    request<LeaderDetailResponse>(`/api/leaders/${address}`),
  addLeader: (address: string) =>
    post<LeaderResponse>('/api/leaders', { address }),
  runLeaderAction: (address: string, action: LeaderAction) =>
    post<LeaderResponse>(`/api/leaders/${address}/${action}`),
  listDecisions: (
    filters: DecisionFilters,
    cursor: string | null,
    limit = 50,
  ) =>
    request<DecisionsPageResponse>(
      withQuery('/api/decisions', {
        ...filters,
        cursor,
        limit: String(limit),
      }),
    ),
  listPositions: (book: BookName) =>
    request<CopyPositionsResponse>(
      `/api/books/${book.toLowerCase()}/positions`,
    ),
  listEquity: (book: BookName, days: number) =>
    request<BookEquityPointResponse[]>(
      withQuery(`/api/books/${book.toLowerCase()}/equity`, {
        days: String(days),
      }),
    ),
  listClusters: () => request<ClustersResponse>('/api/clusters'),
  setKillSwitch: (active: boolean, reason: string | null) =>
    post<KillSwitchResponse>('/api/books/main/kill-switch', {
      active,
      reason,
    }),
  startDiscoveryRun: () => post<DiscoveryRunResponse>('/api/discovery/run'),
};

export const queryKeys = {
  overview: ['overview'] as const,
  leaders: (status: WalletStatus | null) => ['leaders', status] as const,
  leader: (address: string) => ['leader', address] as const,
  decisions: (filters: DecisionFilters, limit = 50) =>
    ['decisions', filters, limit] as const,
  positions: (book: BookName) => ['positions', book] as const,
  equity: (book: BookName, days: number) => ['equity', book, days] as const,
  clusters: ['clusters'] as const,
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details.length > 0
      ? `${error.reason}: ${error.details.join(', ')}`
      : error.reason;
  }
  return error instanceof Error ? error.message : String(error);
}
