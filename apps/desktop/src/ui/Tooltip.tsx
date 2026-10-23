// Shared CSS-anchored tooltip: hover works even when the pointer is already stationary.
// A sibling surface stays out of layout; Escape/click dismiss until the next interaction.
import { useId, useState } from 'react';

export function useTooltip(text: string | undefined) {
  const id = useId().replaceAll(':', '');
  const anchor = `--tooltip-${id}`;
  const [dismissed, setDismissed] = useState(false);
  return {
    id: text ? id : undefined,
    anchor: text ? anchor : undefined,
    reset: () => setDismissed(false),
    dismiss: () => setDismissed(true),
    tooltip: text ? (
      <span
        id={id}
        role="tooltip"
        className="ui-tooltip"
        data-dismissed={dismissed || undefined}
        style={{ positionAnchor: anchor }}
      >
        {text}
      </span>
    ) : null,
  };
}
