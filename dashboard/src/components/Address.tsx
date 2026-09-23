import { useState } from 'react';
import { Link } from 'react-router';
import { shortAddress } from '../format';
import { CopyIcon } from './icons';

export function Address({
  address,
  isLinked = true,
}: {
  address: string;
  isLinked?: boolean;
}) {
  const text = shortAddress(address);
  if (!isLinked) {
    return (
      <span className="font-mono text-ink" title={address}>
        {text}
      </span>
    );
  }
  return (
    <Link
      to={`/leaders/${address}`}
      title={address}
      className="font-mono text-ink underline-offset-2 hover:text-accent hover:underline"
    >
      {text}
    </Link>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [isCopied, setIsCopied] = useState(false);
  return (
    <button
      type="button"
      title={isCopied ? 'Copied' : 'Copy to clipboard'}
      aria-label="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setIsCopied(true);
          setTimeout(() => setIsCopied(false), 1_500);
        });
      }}
      className={`inline-flex size-6 items-center justify-center rounded text-ink-3 transition-colors hover:bg-raised hover:text-ink ${isCopied ? 'text-accent' : ''}`}
    >
      <CopyIcon />
    </button>
  );
}
