'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { HASH_SCROLL, PAGES, PAGING } from '../lib/constants';
import { hashTarget } from '../lib/hash-target';
import { readQuery, statsTabHref } from '../lib/paging';

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
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const hash = useHash();
  useEffect(() => {
    const id = hashTarget(window.location.hash);
    if (!id) return;
    if (pathname === PAGES.stats) {
      const query = readQuery(new URLSearchParams(search), pathname);
      const target =
        id === PAGING.anchors.chainDaily
          ? 'payments'
          : id === PAGING.anchors.daily || id === PAGING.anchors.demand
            ? 'usage'
            : null;
      if (target && target !== query.tab) {
        router.replace(statsTabHref(query, target) + '#' + id, {
          scroll: false,
        });
        return;
      }
    }
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
  }, [pathname, search, hash, router]);
  return null;
}
