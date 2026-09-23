import { formatTime, humanize } from '../format';
import type { LiveAlert } from '../useLiveEvents';

export function AlertToasts({
  alerts,
  onDismiss,
}: {
  alerts: LiveAlert[];
  onDismiss: (id: number) => void;
}) {
  if (alerts.length === 0) {
    return null;
  }
  return (
    <div
      aria-live="polite"
      className="fixed right-4 bottom-4 left-4 z-50 flex flex-col gap-2 sm:left-auto sm:w-96"
    >
      {alerts.map((alert) => (
        <div
          key={alert.id}
          role="status"
          className="rounded-lg border border-warn/40 bg-panel px-4 py-3 text-xs shadow-xl shadow-black/30"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-warn">{humanize(alert.code)}</p>
            <button
              type="button"
              onClick={() => onDismiss(alert.id)}
              className="text-ink-3 hover:text-ink"
              aria-label="Dismiss alert"
            >
              Dismiss
            </button>
          </div>
          <p className="mt-1 leading-relaxed text-ink-2">{alert.message}</p>
          <p className="mt-1 text-ink-3">{formatTime(alert.receivedAt)} UTC</p>
        </div>
      ))}
    </div>
  );
}
