'use client';

// Measures uncapped table overflow; server-rendered cells remain owned by the caller.
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function TableScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const wrapper = ref.current;
    const table = wrapper?.firstElementChild;
    if (!wrapper || !table) return;
    const measure = () => {
      wrapper.removeAttribute('data-overflow');
      const overflow = wrapper.scrollWidth > wrapper.clientWidth;
      wrapper.toggleAttribute('data-overflow', overflow);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    observer.observe(table);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div
      ref={ref}
      className="explorer-table-scroll mt-4 overflow-x-auto rounded-2xl border border-line bg-panel"
    >
      {children}
    </div>
  );
}
