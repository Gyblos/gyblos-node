'use client';

// Owns the page's live refresh: while the tab is visible, the server sections are re-rendered in place
// once a minute (router.refresh: no reload, no scroll jump; figures roll to new values), and a tab
// that comes back after longer than that refreshes at once. Shows when the data was last fetched.
import { Clock3 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { LIVE } from '../lib/constants';
import { refreshAge, utc } from '../lib/format';

export function LiveRefresh({ updatedAt }: { updatedAt: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const attemptedAt = useRef(updatedAt);
  const [now, setNow] = useState(updatedAt);

  useEffect(() => {
    attemptedAt.current = updatedAt;
    const refresh = () => {
      attemptedAt.current = Date.now();
      startTransition(() => router.refresh());
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, LIVE.refreshMs);
    const label = window.setInterval(() => setNow(Date.now()), LIVE.labelMs);
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - attemptedAt.current >= LIVE.refreshMs
      )
        refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(label);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, updatedAt]);

  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-dim"
      aria-live="off"
      aria-busy={pending}
    >
      <Clock3 aria-hidden className="size-3.5 shrink-0" />
      Last update
      <time
        dateTime={new Date(updatedAt).toISOString()}
        title={utc(updatedAt)}
        className="tabular-nums"
      >
        {refreshAge(now - updatedAt)}
      </time>
    </span>
  );
}
