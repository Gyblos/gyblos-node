'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Skeleton } from '../boardui/components/base/skeleton/skeleton';

const Busy = createContext(false);
const Navigate = createContext<((href: string) => void) | null>(null);

export function useQueryNavigation() {
  const navigate = useContext(Navigate);
  if (!navigate) throw new Error('Query controls require a query region.');
  return navigate;
}

function PendingFields({ root }: { root: HTMLDivElement }) {
  const [fields, setFields] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const targets = Array.from(
      root.querySelectorAll<HTMLElement>('tbody td, [data-loading-field]'),
    );
    const hosts = targets.map((target) => {
      const host = document.createElement('span');
      host.className = 'contents';
      target.append(host);
      target.setAttribute('data-loading-active', '');
      target.inert = true;
      return host;
    });
    setFields(hosts);
    return () => {
      for (const host of hosts) host.remove();
      for (const target of targets) {
        target.removeAttribute('data-loading-active');
        target.inert = false;
      }
    };
  }, [root]);
  return fields.map((field, index) =>
    createPortal(
      <Skeleton shape="text" className="query-skeleton" />,
      field,
      index,
    ),
  );
}

export function PagedSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const busy = useContext(Busy);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width)
        element.style.removeProperty('min-height');
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [busy]);
  useLayoutEffect(() => {
    if (busy && root.current)
      root.current.style.minHeight = root.current.offsetHeight + 'px';
  }, [busy]);
  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}

export function QueryRegion({ children }: { children: ReactNode }) {
  const ancestorBusy = useContext(Busy);
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const navigate = (href: string) =>
    start(() => router.push(href, { scroll: false }));
  function capture(event: MouseEvent<HTMLDivElement>) {
    if (
      event.button ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    if (
      !link ||
      !link.closest('[data-query-control]') ||
      link.closest('[data-query-region]') !== root.current
    )
      return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname)
      return;
    event.preventDefault();
    if (url.search !== location.search) navigate(url.pathname + url.search);
  }
  return (
    <Navigate.Provider value={navigate}>
      <Busy.Provider value={pending || ancestorBusy}>
        <div
          className="contents"
          data-query-region=""
          aria-busy={pending}
          ref={root}
          onClickCapture={capture}
        >
          {children}
          {pending && !ancestorBusy && root.current && (
            <PendingFields root={root.current} />
          )}
        </div>
      </Busy.Provider>
    </Navigate.Provider>
  );
}
