import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { NavLink } from 'react-router';
import { api, queryKeys } from '../api';
import type { LiveStatus } from '../useLiveEvents';
import {
  CollectorsIcon,
  DecisionsIcon,
  LeadersIcon,
  MoonIcon,
  OverviewIcon,
  SunIcon,
} from './icons';
import { Badge } from './StatusBadge';

type Theme = 'dark' | 'light';

const THEME_KEY = 'remora-theme';

const NAVIGATION = [
  { to: '/', label: 'Overview', icon: OverviewIcon, isEnd: true },
  { to: '/leaders', label: 'Leaders', icon: LeadersIcon, isEnd: false },
  { to: '/decisions', label: 'Decisions', icon: DecisionsIcon, isEnd: false },
  {
    to: '/collectors',
    label: 'Collectors',
    icon: CollectorsIcon,
    isEnd: false,
  },
];

const LIVE_LABELS: Record<LiveStatus, string> = {
  open: 'Live',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
};

function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function saveTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    return;
  }
}

function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-ink-2"
      title="Server-sent event stream"
    >
      <span className="relative flex size-2">
        {status === 'open' && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/60 motion-reduce:hidden" />
        )}
        <span
          className={`relative inline-flex size-2 rounded-full ${
            status === 'open'
              ? 'bg-accent'
              : status === 'reconnecting'
                ? 'bg-warn'
                : 'bg-ink-3'
          }`}
        />
      </span>
      {LIVE_LABELS[status]}
    </span>
  );
}

function ModeBadge() {
  const overview = useQuery({
    queryKey: queryKeys.overview,
    queryFn: api.readOverview,
  });
  const mode = overview.data?.mode;
  if (mode === undefined) {
    return null;
  }
  return mode === 'live' ? (
    <Badge tone="warn" hasDot>
      Live trading
    </Badge>
  ) : (
    <Badge tone="neutral">Paper</Badge>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" width={22} height={22} aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--raised)" />
        <path
          d="M9 20.5 14 14l4 3.5 5-7"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="23" cy="10.5" r="2.2" fill="var(--accent)" />
      </svg>
      <span className="text-sm font-semibold tracking-tight text-ink">
        remora
      </span>
    </span>
  );
}

export function AppShell({
  liveStatus,
  children,
}: {
  liveStatus: LiveStatus;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    saveTheme(next);
    setTheme(next);
  };
  const themeButton = (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
      title={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
      className="inline-flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-raised hover:text-ink"
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[216px_minmax(0,1fr)]">
      <aside className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur lg:h-screen lg:border-r lg:border-b-0 lg:bg-panel">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 px-4 py-3 lg:px-5 lg:py-5">
            <Brand />
            <div className="flex items-center gap-2 lg:hidden">
              <LiveIndicator status={liveStatus} />
              {themeButton}
            </div>
          </div>
          <nav className="-mb-px flex gap-1 overflow-x-auto px-3 lg:mb-0 lg:flex-col lg:gap-0.5 lg:px-3">
            {NAVIGATION.map(({ to, label, icon: NavIcon, isEnd }) => (
              <NavLink
                key={to}
                to={to}
                end={isEnd}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2.5 border-b-2 px-2.5 py-2 text-[13px] font-medium transition-colors lg:rounded-md lg:border-b-0 ${
                    isActive
                      ? 'border-accent text-ink lg:bg-raised'
                      : 'border-transparent text-ink-3 hover:text-ink-2 lg:hover:bg-raised/60'
                  }`
                }
              >
                <span className="hidden sm:inline">
                  <NavIcon />
                </span>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto hidden space-y-3 border-t border-line px-5 py-4 lg:block">
            <div className="flex items-center justify-between">
              <LiveIndicator status={liveStatus} />
              {themeButton}
            </div>
            <ModeBadge />
          </div>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        {children}
      </main>
    </div>
  );
}
