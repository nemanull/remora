import { formatAge, formatUtc } from '../format';
import { useNow } from '../useNow';

export function TimeAgo({
  iso,
  fallback = '–',
}: {
  iso: string | null;
  fallback?: string;
}) {
  const now = useNow();
  if (iso === null) {
    return <span className="text-ink-3">{fallback}</span>;
  }
  return (
    <time dateTime={iso} title={formatUtc(iso)} className="text-ink-2">
      {formatAge(now - Date.parse(iso))} ago
    </time>
  );
}
