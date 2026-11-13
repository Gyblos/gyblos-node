// Keeps large histories in a keyboard-accessible scroll region with sticky headers.
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { DataTable } from './DataTable';

export function ScrollTable({
  children,
  headings,
  caption,
  resetKey,
  regionLabel = 'Session history table',
}: {
  regionLabel?: string;
  children: ReactNode;
  headings: readonly string[];
  caption: string;
  resetKey: string;
}) {
  const region = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () =>
      setOverflow(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const table = element.querySelector('table');
    if (table) observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (region.current) region.current.scrollTop = 0;
  }, [resetKey]);
  return (
    <div className="ui-section ui-section--tight">
      <div
        ref={region}
        className="ui-table-region"
        role="region"
        aria-label={regionLabel}
        tabIndex={0}
      >
        <DataTable caption={caption} headings={headings}>
          {children}
        </DataTable>
      </div>
      {overflow && (
        <p className="ui-table-scroll-hint">
          <ArrowLeft size={14} aria-hidden="true" />
          Scroll to see all columns
          <ArrowRight size={14} aria-hidden="true" />
        </p>
      )}
    </div>
  );
}
