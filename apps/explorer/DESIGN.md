# Explorer design contract

This file is the operative design source for `apps/explorer`. It defines how the
public metrics Explorer uses Gyblos tokens, BoardUI primitives, compact data
typography, motion and chart semantics. `design/boardui/README.md` remains the
catalog of evaluated upstream BoardUI components; this file governs the shipped
Explorer and the published components in `components/board`.

The contract is intentionally compact. The Explorer is an evidence-first
network dashboard, not a marketing page: exact values and coverage states come
before decoration, and motion exists to clarify state changes rather than to
entertain.

## Foundations

### Color ownership

Gyblos base tokens live in `app/globals.css`: `brand-blue`, `signal`, `chart`,
neutral surfaces (`bg`, `panel`, `raised`, `line`), text (`ink`, `muted`,
`dim`) and result tones (`money`, `good`, `bad`). BoardUI semantic tokens in
`boardui/styles/tokens.css` map upstream component roles onto those values.
Published registry items must keep both mappings complete, including the font
families needed to reproduce the design.

Use semantic tokens only. Component source must not introduce raw palette
classes, hex or OKLCH literals, or `dark:` color overrides. Dark mode is owned
by the token layer.

`signal` is a restricted interaction accent. It may be used for focus rings or
outlines, selected states, small status indicators, the top navigation loader,
the fill of a primary action button and other short-lived interaction
affordances. It is not body text, heading text or a general-purpose link
color. Chart marks use `chart`, even when the chart token intentionally
resolves to the same blue.

The token layer may map a component border role onto a text tone such as
`dim`; component source still references only the semantic border token.

`money`, `good` and `bad` are semantic result tones, not decorative accents.
Money amounts use `money`; positive and negative operational states use `good`
and `bad` only when the direction of the outcome is clear.

### Typography

Use the composite utilities from `boardui/styles/typography.css`; do not rebuild
them by stacking size, weight, line-height and tracking utilities. The Explorer
keeps a compact hierarchy:

| Role                               | Utility                                             |
| ---------------------------------- | --------------------------------------------------- |
| Page title                         | `text-title-2-medium`                               |
| Section heading                    | `text-title-3-medium`                               |
| Card or chart title                | `text-body-medium`                                  |
| Emphasized card heading            | `text-headline-medium`                              |
| Body and control text              | `text-body-regular` or `text-body-medium`           |
| Dense body and table text          | `text-body-2-regular` or `text-body-2-medium`       |
| Labels, metadata and table headers | `text-caption-1-medium`                             |
| Small annotations                  | `text-caption-2-regular` or `text-caption-2-medium` |

Numeric evidence uses the monospace font and tabular figures where the existing
component provides them. Exact values outrank visual approximation: a chart may
simplify an axis, but its headline, readout, detail or table must carry the
exact value.

### Surfaces

The Explorer uses compact `rounded-xl` surfaces rather than upstream marketing
cards. Shared surface roles are centralized in `components/board/styles.ts`:

- `card`: a borderless KPI or chart card on `panel`.
- `panel`: a bordered evidence surface for heroes, detail panels, tables and
  unavailable states.
- `inset`: a recessed track or tile inside a card or panel.
- `control`: a compact bordered input-like control.

Do not invent one-off combinations for these roles in new product code. If an
existing component needs a different emphasis, adjust the named surface role or
document the exception here.

## Interaction states

Hover color transitions use `transition-colors` and about 150 ms. Pressed
states are a color step, never scale. Disabled controls use the semantic
disabled text/background tokens, keep `cursor-not-allowed`, and must handle both
`disabled` and `aria-disabled` when the primitive supports both.

Keyboard focus must always be visible. Dense controls use a 2 px `signal` ring
without a large offset; icon-only or inline help buttons may use a 2 px `signal`
outline with a small offset so the shape remains visible outside the control.
Focus treatment must not rely on a subtle text-color change alone.

Plain anchors are owned by the base-layer `a:focus-visible` outline rule in
`app/globals.css` and need no focus classes. The rule lives in `@layer base`
so an anchor control that needs the dense ring can suppress it with
`outline-none` and paint the ring alone; unlayered, the rule would override
every utility and double the indicator. Never combine `outline-none` with
`focus-visible:outline-*` utilities in one class string: in Tailwind v4 the
outline style variable stays `none` and the focus outline never paints.

Controls that look compact on precise pointers still need touch-sized hit areas
on coarse pointers. Preserve the existing `sm:pointer-fine:` pattern unless a
component has a better accessible target.

React Aria keyboard, focus and screen-reader behavior is part of the design.
Do not replace it with native-only shortcuts or hand-built popups.

## Motion and loading

Motion follows the BoardUI language: fast, subtle and consistent. Interface
state changes are normally 100-200 ms; data entrances may take up to about
360-400 ms. Entrances combine opacity, a small scale or blur where appropriate;
exits are faster than entrances. Press feedback is a color step, never scale.
Every keyframe animation and transition introduced for the Explorer must be
disabled or reduced under `prefers-reduced-motion: reduce`.

Loading uses the existing `Skeleton` and `QueryRegion` system. Do not create a
parallel spinner or skeleton system. Skeletons should appear without a harsh
flash on fast navigations, preserve layout size where the current system does,
and hand back to content with a short fade. The top loader remains thin and
spinnerless.

Range, metric and other query controls should acknowledge input immediately
while navigation is pending. This optimistic selection is only control feedback:
the URL and server-rendered data remain authoritative, and browser history,
deep links and back/forward navigation must continue to restore state.

## Charts and data meaning

Charts are evidence visualizations. They must answer a product question and
preserve the public data contract.

- Free and paid sides are never silently summed or stacked. When two charts are
  meant to be compared, use small multiples with a shared scale unless the UI
  explicitly says the scales are independent.
- `null` means no observation, pending coverage, truncated source coverage or
  unavailable data according to the point's detail. Zero means an observed zero
  on a final covered day. They must be visually distinct.
- A zero value must not be drawn as a positive-height bar. Use a baseline tick
  or equivalent zero mark; missing observations use the established dashed mark.
- Count axes use integer ticks. Monetary axes are visible, compact and labeled
  in USDC; atomic units are converted for visual scale while exact labels retain
  full precision.
- A change in visual scale must not change the exact headline, hover/focus
  readout, detail text or table value.
- Public success rate follows the metrics collector formula: completed divided
  by completed plus failed plus cancelled. Copy must not describe a different
  formula.
- Demand totals use the collector's pre-truncation `demandTotal`. Model rankings
  built from the published per-day top-model entries must say that they are
  limited by that publication boundary.
- Time axes must be honest. Daily series use UTC days. Irregular offer periods
  may be shown as a categorical sequence with exact start and end in the point
  detail, but must not pretend to be evenly spaced continuous time.

## Responsive and review requirements

Mobile keeps the desktop's compact density: grids stay multi-column instead of
collapsing to loose full-width stacks, and card internals adapt to narrow
containers rather than overflowing or wasting the row. The activity metric
selector keeps two columns on small phones and three above 420px, never a
single loose column; the baseline chip is unwrappable and just under a hundred
pixels wide, so three columns only appear where the card interior still
contains it along with growing values. Inside plain stat cards the label row is
the container-query context, never the card frame: a size container establishes
an independent formatting context, which would destroy the subgrid row sharing
the cards exist for. Below a 7rem label-row width the icon tile drops and the
label steps down to caption size, so adaptation keys off the space the row
actually has rather than the viewport.

The Explorer must fit without global horizontal scrolling at mobile widths;
wide tables scroll inside their own containers and preserve their pinned
identity columns. Touch targets, keyboard inspection of charts, Escape behavior
and browser history are part of visual acceptance.

Visual review covers light and dark themes, desktop and mobile widths (at least
390, 768 and 1440 CSS pixels, plus 320 when navigation or tables change),
loading/pending states, empty and unavailable states, reduced motion and
keyboard-only use. Physical iOS and Android behavior is not claimed unless it
was actually tested on those devices.

## Registry and reuse

Reusable Explorer components live in `components/board` and are published
through `registry.json`. Use those components or the installed BoardUI
primitives instead of hand-building lookalikes. Registry changes must preserve
the dependency closure, version pins, theme tokens and font mappings needed by
an outside consumer. Font mappings carry in-variable fallbacks, so a consumer
without the explorer's next/font variables still resolves a sane stack.

When a visual rule changes, update this file in the same change. Do not keep a
second conflicting design source in component comments.
