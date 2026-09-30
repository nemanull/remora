import { setTimeout as sleep } from 'node:timers/promises';

export async function waitFor<T>(
  description: string,
  read: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await read();
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause =
        lastError instanceof Error ? `, last error: ${lastError.message}` : '';
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting until ${description}${cause}`,
      );
    }
    await sleep(intervalMs);
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${url} answered ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}
