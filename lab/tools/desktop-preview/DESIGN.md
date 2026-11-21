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

Reuse before you write markup. Each UI need below has one component; a view that
needs it imports it instead of copying its markup or styles. If nothing fits, add
or extend a shared component (in `PreviewKit` for proposals) and add its row here
in the same change. Agents load this through the
[`gyblos-desktop-ui` skill](../../../.agents/skills/gyblos-desktop-ui/SKILL.md).

| Need                              | Use                                                   | Not                                 |
| --------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| Button, icon-only button          | `Button`, `IconButton` (`./UI`)                       | raw `<button>` with its own styles  |
| Pick one value from a list        | `Dropdown` + `MenuItem role="menuitemradio"`          | native `<select>`                   |
| Pick among 2-5 visible options    | `FilterChips` (counts) or `ChoiceCard` (`./UI`)       | ad-hoc pill rows                    |
| Text field, label, help, error    | `FormField` + `FormInput` (`./Form`)                  | bare `<input>` and `<label>`        |
| Copy a value (key, URL)           | `CopyField` (`./Form`)                                | input plus a separate copy button   |
| Code, commands, config files      | `CodeBlock` with `language` and `title`               | `<pre>` or `.ui-code-block`         |
| USDC amount input                 | `AmountEditor` / `CompactAmount` (`./Payments`)       | number inputs with custom steppers  |
| Status or label                   | `Tag` (`tone`, `dot`), `statusTone(text)`             | colored spans, local status classes |
| Detail dialog header and totals   | `DetailSummary`                                       | local status/total/key-value markup |
| Key/value facts                   | `Facts` / `Pair` (`./Management`)                     | hand-built `<dl>` grids             |
| Metrics                           | `StatGrid` + `StatCard` with `help`                   | custom metric cards                 |
| Explain a number or control       | `StatCard` `help` / `useTooltip` "?" button           | long inline help paragraphs         |
| Price change, savings             | `Delta`, `Savings`                                    | hand-formatted percentages          |
| Split totals                      | `SegmentedBar`                                        | stacked divs with inline widths     |
| Tables                            | `ScrollTable` + `TableRow` / `DataCell`, `Pagination` | raw `<table>` styling               |
| Empty, blocked or loading section | `StatePanel`, `EmptyState`, `PreviewAnswerSkeleton`   | one-off placeholder text            |
| Dialog                            | `Modal` with `size` `sm` / `md` / `lg`                | custom overlays or fixed widths     |
| Grouped block, settings card      | `Panel`, `Section`, settings rows                     | new card classes                    |
| Page and side panel layout        | `WorkspaceLayout`, `PageBody`                         | a second page gutter                |

- `Tag`: status or label with a tinted background; `dot` for live states.
- `Delta`: signed percentage; set `lowerIsBetter` for prices and latency.
- `Savings`: "N% cheaper" against a reference list price; hidden when not cheaper.
- `SegmentedBar`: one bar split by source with a text legend (the legend carries
  the values for assistive technology).
- `FilterChips`: single-choice filter with counts; one Tab stop, arrow keys move.
- `CodeBlock`: language label (Shell, JSON, TOML, TypeScript, Text), optional file
  title, highlighted tokens and a Copy button that shows "Copied" only after a
  confirmed copy. Chat fences map through `fenceLanguage`, tools through
  `agentCodeLanguage`.
- Settings rows (`preview-settings-rows`): copy and help on the left, one compact
  control on the right; Save/Cancel appear only after a change.

Open `?screen=design-system` (Settings → Preview components) to review them all.

## Type

Instrument Sans for the interface and JetBrains Mono (bundled as `GeistMono`) for
technical values. The preview loads no remote fonts (its CSP blocks network access).
Interface / supporting text 14 / 12 px; tables 13 px with 12 px headers.
`?font=inter` (Settings → Interface font) switches to Inter 4.1, bundled in `fonts/` under the OFL, for comparison only.

## Interaction

- Every disclosure animates height and opacity (`preview-reveal`) and is instant
  with reduced motion.
- Radio groups (pills, chips) are one Tab stop with arrow-key selection.
- Dialogs return focus to the element that opened them.
- Single-row actions in tables are 28 px icon buttons with an accessible name that
  includes the row.
