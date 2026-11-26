import type { KeyboardEvent } from 'react';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Usage' },
  { id: 'history', label: 'Payments' },
  { id: 'limits', label: 'Limits' },
] as const;
export type Tab = (typeof TABS)[number]['id'];
export function TabBar({ tab, onTab }: { tab: Tab; onTab(tab: Tab): void }) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index =
      (TABS.findIndex((item) => item.id === tab) + step + TABS.length) %
      TABS.length;
    const next = TABS[index];
    if (!next) return;
    onTab(next.id);
    document.getElementById('preview-tab-' + next.id)?.focus();
  };
  return (
    <div
      className="preview-tabs"
      role="tablist"
      aria-label="Usage and payments sections"
      onKeyDown={move}
    >
      {TABS.map((item) => (
        <button
          key={item.id}
          id={'preview-tab-' + item.id}
          type="button"
          role="tab"
          className="preview-tab"
          aria-selected={tab === item.id}
          aria-controls="preview-tab-panel"
          tabIndex={tab === item.id ? 0 : -1}
          onClick={() => onTab(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
