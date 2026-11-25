// The board's shared surface recipes, so every card and control has the same corners, tones and size.
// Cards follow BoardUI (founder-chosen option B, 2026-11-19): a neutral panel with no line, separated
// from the page by the grid's gaps, with its icon tile one tone lighter (raised) so the tile reads
// without a border. Tables keep their line, which structures rows. Controls share one height: 44 px
// touch targets on phones, 36 px from the small breakpoint up.
export const SURFACE = {
  card: 'rounded-xl bg-panel',
  // A tile or track inside a card: one tone lighter than the card.
  inset: 'bg-raised',
  control:
    'h-11 rounded-lg border border-line bg-panel sm:h-9 transition-colors hover:border-dim',
  focus: 'outline-none focus-visible:ring-2 focus-visible:ring-signal',
} as const;
