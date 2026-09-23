import { useSyncExternalStore } from 'react';

const FRESH_FOR_MS = 6_000;

let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(next: Set<string>): void {
  snapshot = next;
  for (const notify of listeners) {
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readSnapshot(): ReadonlySet<string> {
  return snapshot;
}

export function markDecisionFresh(id: string): void {
  publish(new Set(snapshot).add(id));
  setTimeout(() => {
    const next = new Set(snapshot);
    next.delete(id);
    publish(next);
  }, FRESH_FOR_MS);
}

export function useFreshDecisionIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readSnapshot);
}
