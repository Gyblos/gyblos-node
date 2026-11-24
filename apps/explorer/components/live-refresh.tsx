'use client';

// Owns the page's live refresh: while the tab is visible, the server sections are re-rendered in place
// once a minute (router.refresh: no reload, no scroll jump; figures roll to new values), and a tab
// that comes back after longer than that refreshes at once. Shows when the data was last fetched.
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { LIVE, UNITS } from '../lib/constants';

const SECONDS_PER_MINUTE = 60;

function ago(ms: number) {
  const seconds = Math.max(0, Math.round(ms / UNITS.msPerSecond));
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} s ago`;
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)} min ago`;
}

export function LiveRefresh({ quiet = false }: { quiet?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fetchedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => {
      fetchedAt.current = Date.now();
      startTransition(() => router.refresh());
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, LIVE.refreshMs);
    const label = window.setInterval(() => setNow(Date.now()), LIVE.labelMs);
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - fetchedAt.current >= LIVE.refreshMs
      )
        refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(label);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  if (quiet) return null;
  return (
    <span
      className="hidden items-center gap-2 font-mono text-xs text-dim sm:inline-flex"
      aria-live="off"
    >
      <span className="relative flex size-2">
        <span
          aria-hidden
          className={`absolute inline-flex size-full rounded-full bg-signal opacity-60 ${pending ? 'animate-ping' : ''}`}
        />
        <span
          aria-hidden
          className="relative inline-flex size-2 rounded-full bg-signal"
        />
      </span>
      {pending ? 'Updating…' : `Live, updated ${ago(now - fetchedAt.current)}`}
    </span>
  );
}
