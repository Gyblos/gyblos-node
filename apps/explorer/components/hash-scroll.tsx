'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { HASH_SCROLL } from '../lib/constants';
import { pageScrollTarget } from '../lib/hash-target';
import { useInPlaceDestination } from './query-region';

const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

function useHash() {
  const [hash, setHash] = useState('');
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return hash;
}

export function HashScroll() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const hash = useHash();
  const destination = useInPlaceDestination();
  useEffect(() => {
    const id = pageScrollTarget(
      new URL(window.location.href),
      destination?.current ?? null,
    );
    if (destination) destination.current = null;
    if (!id) return;
    const reach = () => document.getElementById(id)?.scrollIntoView();
    const observer = new MutationObserver(reach);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const input of USER_INPUT) window.removeEventListener(input, stop);
    };
    const timer = window.setTimeout(stop, HASH_SCROLL.maxWaitMs);
    for (const input of USER_INPUT)
      window.addEventListener(input, stop, { passive: true });
    observer.observe(document.body, { childList: true, subtree: true });
    reach();
    return stop;
  }, [pathname, search, hash, destination]);
  return null;
}
