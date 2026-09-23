import type { ReactNode } from 'react';

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel px-4 py-3.5">
      <p className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">
        {label}
      </p>
      <p className="mt-1.5 truncate text-xl font-semibold tracking-tight text-ink">
        {value}
      </p>
      {detail !== undefined && (
        <div className="mt-1 text-xs leading-snug text-ink-3">{detail}</div>
      )}
    </div>
  );
}
