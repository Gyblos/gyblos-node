// The board's shared surface recipes, so every card and control has the same corners, line and size.
// Cards are neutral panels with a line (DESIGN.md: 14-16 px corners, neutral panels and lines): the
// panel alone is too close to the page (1.09:1 dark) to read as a surface without its line. Controls
// share one height: 44 px touch targets on phones, 36 px from the small breakpoint up.
export const SURFACE = {
  card: 'rounded-2xl border border-line bg-panel',
  // An inset tile or track inside a card: the page tone with the same line.
  inset: 'border border-line bg-bg',
  control:
    'h-11 rounded-lg border border-line bg-panel sm:h-9 transition-colors hover:border-dim',
  focus: 'outline-none focus-visible:ring-2 focus-visible:ring-signal',
} as const;
