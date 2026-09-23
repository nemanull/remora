import type { LiveEvent } from '@remora/sdk';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { markDecisionFresh } from './freshDecisions';

export type LiveStatus = 'connecting' | 'open' | 'reconnecting';

export type LiveAlert = {
  id: number;
  code: string;
  message: string;
  receivedAt: string;
};

const EVENTS_URL = '/api/events';
const INVALIDATION_DELAY_MS = 250;
const RECONNECT_DELAY_MS = 5_000;
const ALERT_LIFETIME_MS = 12_000;
const MAX_ALERTS = 4;

function listStaleKeys(event: LiveEvent): QueryKey[] {
  switch (event.type) {
    case 'decision':
      return [['decisions'], ['leader', event.wallet]];
    case 'order':
      return [['decisions'], ['positions'], ['leader']];
    case 'copy':
      return [
        ['positions'],
        ['overview'],
        ['leaders'],
        ['leader', event.wallet],
      ];
    case 'collector':
      return [['clusters']];
    case 'leader':
      return [
        ['leaders'],
        ['leader', event.wallet],
        ['overview'],
        ['clusters'],
      ];
    case 'killSwitch':
      return [['overview']];
    case 'alert':
      return event.clusterId === null ? [] : [['clusters']];
  }
}

export function useLiveEvents(): {
  status: LiveStatus;
  alerts: LiveAlert[];
  dismissAlert: (id: number) => void;
} {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);

  const dismissAlert = useCallback((id: number) => {
    setAlerts((current) => current.filter((alert) => alert.id !== id));
  }, []);

  useEffect(() => {
    const staleKeys = new Map<string, QueryKey>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let source: EventSource | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let hasDropped = false;
    let nextAlertId = 1;

    const later = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    };

    const flush = () => {
      flushTimer = undefined;
      for (const queryKey of staleKeys.values()) {
        void queryClient.invalidateQueries({ queryKey });
      }
      staleKeys.clear();
    };

    const receive = (event: LiveEvent) => {
      for (const key of listStaleKeys(event)) {
        staleKeys.set(JSON.stringify(key), key);
      }
      flushTimer ??= later(flush, INVALIDATION_DELAY_MS);
      if (event.type === 'decision') {
        markDecisionFresh(event.decisionId);
      }
      if (event.type === 'alert') {
        const id = nextAlertId++;
        setAlerts((current) =>
          [
            {
              id,
              code: event.code,
              message: event.message,
              receivedAt: new Date().toISOString(),
            },
            ...current,
          ].slice(0, MAX_ALERTS),
        );
        later(() => dismissAlert(id), ALERT_LIFETIME_MS);
      }
    };

    const connect = () => {
      source = new EventSource(EVENTS_URL);
      source.onopen = () => {
        setStatus('open');
        if (hasDropped) {
          void queryClient.invalidateQueries();
        }
      };
      source.onerror = () => {
        hasDropped = true;
        setStatus('reconnecting');
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          later(connect, RECONNECT_DELAY_MS);
        }
      };
      source.onmessage = (message: MessageEvent<string>) => {
        receive(JSON.parse(message.data) as LiveEvent);
      };
    };

    connect();
    return () => {
      source?.close();
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [queryClient, dismissAlert]);

  return { status, alerts, dismissAlert };
}
