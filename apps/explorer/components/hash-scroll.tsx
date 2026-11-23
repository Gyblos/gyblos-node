'use client';

import { useEffect } from 'react';

import { HASH_SCROLL } from '../lib/constants';

const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

export function HashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
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
  }, []);
  return null;
}
