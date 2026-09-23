const compactFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function signOf(value: number): string {
  return value > 0 ? '+' : value < 0 ? '−' : '';
}

export function formatUsd(
  value: string | number,
  options: { signed?: boolean; isPrecise?: boolean } = {},
): string {
  const amount = toNumber(value);
  const digits = options.isPrecise && Math.abs(amount) < 1 ? 4 : 2;
  const rounded = roundTo(amount, digits);
  const text = Math.abs(rounded).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (options.signed) {
    return `${signOf(rounded)}$${text}`;
  }
  return rounded < 0 ? `−$${text}` : `$${text}`;
}

export function formatWholeUsd(value: number): string {
  const text = Math.round(Math.abs(value)).toLocaleString('en-US');
  return value < 0 ? `−$${text}` : `$${text}`;
}

export function formatCompactUsd(value: string | number): string {
  const amount = toNumber(value);
  return `${amount < 0 ? '−' : ''}$${compactFormat.format(Math.abs(amount))}`;
}

export function formatDecimal(value: string | number, maxDigits = 6): string {
  const amount = toNumber(value);
  const text = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: maxDigits,
  }).format(Math.abs(amount));
  return amount < 0 ? `−${text}` : text;
}

export function formatPrice(value: string | number): string {
  const amount = toNumber(value);
  const digits = amount >= 1_000 ? 1 : amount >= 1 ? 4 : 6;
  return formatDecimal(amount, digits);
}

export function formatPercent(
  fraction: number,
  options: { signed?: boolean; digits?: number } = {},
): string {
  const digits = options.digits ?? 2;
  const rounded = roundTo(fraction * 100, digits);
  const text = `${Math.abs(rounded).toFixed(digits)}%`;
  if (options.signed) {
    return `${signOf(rounded)}${text}`;
  }
  return rounded < 0 ? `−${text}` : text;
}

export function formatScore(value: number | null): string {
  return value === null ? '–' : value.toFixed(3);
}

export function formatOrdinal(value: number): string {
  const rounded = Math.round(value);
  const lastTwo = rounded % 100;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return `${rounded}th`;
  }
  const suffix = ['th', 'st', 'nd', 'rd'][rounded % 10] ?? 'th';
  return `${rounded}${suffix}`;
}

export function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${Math.round(milliseconds)} ms`;
  }
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

export function formatUtc(iso: string): string {
  return `${iso.replace('T', ' ').slice(0, 19)} UTC`;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function toneOf(value: string | number | null, digits = 2): string {
  if (value === null) {
    return 'text-ink-2';
  }
  const amount = roundTo(toNumber(value), digits);
  return amount > 0 ? 'text-up' : amount < 0 ? 'text-down' : 'text-ink-2';
}

export function humanize(code: string): string {
  const text = code.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
