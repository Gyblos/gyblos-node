export const SURFACE = {
  card: 'rounded-xl bg-panel',
  panel: 'rounded-xl border border-line bg-panel',
  // A tile or track inside a card: one tone lighter than the card.
  inset: 'bg-raised',
  control:
    'h-11 rounded-lg border border-line bg-panel sm:pointer-fine:h-9 transition-colors hover:border-dim',
  focus: 'outline-none focus-visible:ring-2 focus-visible:ring-signal',
} as const;
