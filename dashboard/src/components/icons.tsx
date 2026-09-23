import type { SVGProps } from 'react';

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      width={16}
      height={16}
      {...props}
    />
  );
}

export function OverviewIcon() {
  return (
    <Icon>
      <rect x="3" y="3" width="6" height="8" rx="1.5" />
      <rect x="11" y="3" width="6" height="5" rx="1.5" />
      <rect x="3" y="13" width="6" height="4" rx="1.5" />
      <rect x="11" y="10" width="6" height="7" rx="1.5" />
    </Icon>
  );
}

export function LeadersIcon() {
  return (
    <Icon>
      <circle cx="7.5" cy="7" r="2.75" />
      <path d="M2.75 16c.6-2.6 2.5-4 4.75-4s4.15 1.4 4.75 4" />
      <path d="M13 4.5a2.6 2.6 0 0 1 0 5M14.5 12.2c1.4.5 2.4 1.8 2.75 3.8" />
    </Icon>
  );
}

export function DecisionsIcon() {
  return (
    <Icon>
      <path d="M7 5h10M7 10h10M7 15h10" />
      <circle cx="3.5" cy="5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="10" r=".9" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="15" r=".9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function CollectorsIcon() {
  return (
    <Icon>
      <rect x="3" y="3.5" width="14" height="5" rx="1.5" />
      <rect x="3" y="11.5" width="14" height="5" rx="1.5" />
      <path d="M6 6h.01M6 14h.01" strokeWidth={2.2} />
    </Icon>
  );
}

export function SunIcon() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="3.25" />
      <path d="M10 2.5v1.75M10 15.75v1.75M2.5 10h1.75M15.75 10h1.75M4.7 4.7l1.25 1.25M14.05 14.05l1.25 1.25M4.7 15.3l1.25-1.25M14.05 5.95l1.25-1.25" />
    </Icon>
  );
}

export function MoonIcon() {
  return (
    <Icon>
      <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2Z" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon width={14} height={14}>
      <rect x="7" y="7" width="9" height="9" rx="1.75" />
      <path d="M13 7V5.25A1.25 1.25 0 0 0 11.75 4h-6.5A1.25 1.25 0 0 0 4 5.25v6.5A1.25 1.25 0 0 0 5.25 13H7" />
    </Icon>
  );
}

export function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <Icon
      width={14}
      height={14}
      className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
    >
      <path d="m8 5 5 5-5 5" />
    </Icon>
  );
}

export function ExternalIcon() {
  return (
    <Icon width={13} height={13}>
      <path d="M11 4h5v5M16 4l-7 7M14 12v3.25A.75.75 0 0 1 13.25 16h-8.5a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 4.75 6H8" />
    </Icon>
  );
}
