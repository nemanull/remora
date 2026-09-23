import type { ReactNode } from 'react';

export function Panel({
  title,
  description,
  actions,
  children,
  isFlush = false,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  isFlush?: boolean;
  className?: string;
}) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section
      className={`min-w-0 rounded-lg border border-line bg-panel ${className}`}
    >
      {hasHeader && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
            )}
            {description !== undefined && (
              <p className="mt-0.5 text-xs text-ink-3">{description}</p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={isFlush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function TableScroll({ children }: { children: ReactNode }) {
  return <div className="max-h-[560px] overflow-auto">{children}</div>;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-10 text-center text-xs leading-relaxed text-ink-3">
      {children}
    </p>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          {title}
        </h1>
        {description !== undefined && (
          <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-md border border-line-strong bg-canvas p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`h-6 rounded px-2.5 text-xs font-medium transition-colors ${
            option.value === value
              ? 'bg-raised text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]'
              : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function LoadingNote() {
  return <EmptyNote>Loading…</EmptyNote>;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p className="px-4 py-10 text-center text-xs text-warn">
      Could not load this view: {message}
    </p>
  );
}
