# Desktop mockup design system

Rules for the isolated web mockup in `lab/tools/desktop-preview`. They apply only to
this preview until the founder approves porting a proposal to `apps/desktop`
(see `apps/desktop/DESIGN.md` for the shipped renderer rules and approval gates).

## Sources

| File                           | Owns                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `brand.json`                   | Brand palette applied to `src/theme.ts` in the preview build     |
| `preview.css`                  | Preview layout and the preview kit tokens (`--pk-*`)             |
| `views/PreviewKit.tsx.preview` | Shared preview components, imported as `./PreviewKit`            |
| `views/*.tsx.preview`          | Route proposals; they compose shared renderer and kit components |

Views never use raw color values; colors come from theme variables or `--pk-*` tones
(`tests/lab/desktop-preview-kit.test.ts`).

## Surfaces

| Layer                 | Dark                   | Use                                       |
| --------------------- | ---------------------- | ----------------------------------------- |
| Page (`--bg`)         | `charcoal`             | Route background                          |
| Sidebar (`--pk-side`) | between page and panel | Navigation column, reaching the title bar |
| Panel (`--panel`)     | `panel`                | Grouped settings, usage panels, tables    |
| Raised (`--raised`)   | `raised`               | Selected pills, chips, controls on panels |
| Line (`--line`)       | `line`                 | 1 px borders and row dividers             |

## Tones

`success` (connected green), `warning` (warm amber), `danger` (error red), `info`
(brand blue) and `neutral` (muted). Use them through `data-tone` only.

| Meaning                               | Tone    |
| ------------------------------------- | ------- |
| Active, captured, confirmed, verified | success |
| Open session, pending authorization   | info    |
| Demo, needs review, unconfirmed       | warning |
| Failed, declined                      | danger  |
| Revoked, voided, free                 | neutral |

## Components

- `Tag`: status or label with a tinted background; `dot` for live states. Use
  `statusTone(text)` for payment statuses.
- `Delta`: signed percentage; set `lowerIsBetter` for prices and latency.
- `Savings`: "N% cheaper" against a reference list price; hidden when not cheaper.
- `SegmentedBar`: one bar split by source with a text legend (the legend carries
  the values for assistive technology).
- `FilterChips`: single-choice filter with counts; one Tab stop, arrow keys move.
- `Panel`: grouped block with a title.
- Settings rows (`preview-settings-rows`): copy and help on the left, one compact
  control on the right; Save/Cancel appear only after a change.
- `CompactAmount` / `AmountEditor` (`Payments.tsx.preview`): numeric USDC input with
  steppers, keyboard nudging and inline validation.

Open `?screen=design-system` (Settings → Preview components) to review them all.

## Type

Instrument Sans for the interface and JetBrains Mono (bundled as `GeistMono`) for
technical values. The preview loads no remote fonts (its CSP blocks network access).
Interface / supporting text 14 / 12 px; tables 13 px with 12 px headers.

## Interaction

- Every disclosure animates height and opacity (`preview-reveal`) and is instant
  with reduced motion.
- Radio groups (pills, chips) are one Tab stop with arrow-key selection.
- Dialogs return focus to the element that opened them.
- Single-row actions in tables are 28 px icon buttons with an accessible name that
  includes the row.
