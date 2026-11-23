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

| Layer               | Dark       | Use                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page (`--bg`)       | `charcoal` | Route background: an inset sheet with a 1 px border and `--radius-panel` start corners                                                                                                                                                                                                                                        |
| Frame (`--pk-side`) | `panel`    | Conversation panel and title bar; rail, status bar and sidebar backdrop use `--pk-rail` (55% frame toward page); the panel has a `--line` left and bottom edge with a rounded bottom-left corner; when the sidebar folds, the panel slides under the rail while the page sheet follows, then the whole frame uses `--pk-rail` |
| Panel (`--panel`)   | `panel`    | Grouped settings, usage panels, tables                                                                                                                                                                                                                                                                                        |
| Raised (`--raised`) | `raised`   | Selected pills, chips, controls on panels                                                                                                                                                                                                                                                                                     |
| Line (`--line`)     | `line`     | 1 px borders and row dividers                                                                                                                                                                                                                                                                                                 |

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

This table governs the mockup. `CodeBlock`, `DetailSummary`, `Tag`,
`statusTone`, `FilterChips`, `Delta`, `Savings`, `SegmentedBar`, `StatGrid`,
`Panel`, `TableRow`, `AmountEditor`, `CompactAmount`, `PreviewAnswerSkeleton`,
`Notice`, `Switch`, `PreviewFundsDialog`, `PreviewStatusBar`,
`PreviewUpdateButton`, `PreviewSkeletonRows`, `PreviewEmptyLine`,
`PreviewSectionIcon`, `Kbd`, `PreviewToaster` / `showPreviewToast`
exist only in the preview views until a port is approved; shipped desktop code
follows [`apps/desktop/DESIGN.md`](../../../apps/desktop/DESIGN.md).

| Need                              | Use                                                                                                                                                                                                | Not                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Button, icon-only button          | `Button`, `IconButton` (`./UI`)                                                                                                                                                                    | raw `<button>` with its own styles                     |
| Pick one value from a list        | `Dropdown` + `MenuItem role="menuitemradio"`                                                                                                                                                       | native `<select>`                                      |
| Pick among 2-5 visible options    | `FilterChips` (counts) or `ChoiceCard` (`./UI`)                                                                                                                                                    | ad-hoc pill rows                                       |
| Turn a global setting on or off   | `Switch` in a settings row                                                                                                                                                                         | checkbox or custom toggle                              |
| Text field, label, help, error    | `FormField` + `FormInput` (`./Form`)                                                                                                                                                               | bare `<input>` and `<label>`                           |
| Add funds dialog                  | `PreviewFundsDialog` with a `FUNDS_HOST`, opened by `openPreviewFunds(host)`; faucet on Testnet only                                                                                               | per-view Add funds modals                              |
| Copy a value (key, URL)           | `CopyField` (`./Form`)                                                                                                                                                                             | input plus a separate copy button                      |
| Code, commands, config files      | `CodeBlock` with `language` and `title`                                                                                                                                                            | `<pre>` or `.ui-code-block`                            |
| USDC amount input                 | `AmountEditor` / `CompactAmount` (`./PreviewKit`)                                                                                                                                                  | number inputs with custom steppers                     |
| Status or label                   | `Tag` (`tone`, `dot`), `statusTone(text)`                                                                                                                                                          | colored spans, local status classes                    |
| Replacement, fallback or warning  | `Notice` (`tone`)                                                                                                                                                                                  | inline warning paragraphs                              |
| Detail dialog header and totals   | `DetailSummary`                                                                                                                                                                                    | local status/total/key-value markup                    |
| Key/value facts                   | `Facts` / `Pair` (`./Management`)                                                                                                                                                                  | hand-built `<dl>` grids                                |
| Metrics                           | `StatGrid` + `StatCard` with `help`                                                                                                                                                                | custom metric cards                                    |
| Explain a number or control       | `StatCard` `help` / `useTooltip` "?" button                                                                                                                                                        | long inline help paragraphs                            |
| Price change, savings             | `Delta`, `Savings`                                                                                                                                                                                 | hand-formatted percentages                             |
| Split totals                      | `SegmentedBar`                                                                                                                                                                                     | stacked divs with inline widths                        |
| Tables                            | `ScrollTable` + `TableRow` / `DataCell`, `Pagination`                                                                                                                                              | raw `<table>` styling                                  |
| Empty, blocked or loading section | `StatePanel`, `EmptyState`, `PreviewAnswerSkeleton`                                                                                                                                                | one-off placeholder text                               |
| Dialog                            | `Modal` with `size` `sm` / `md` / `lg` and `origin` `center` / `top` / `bottom` / `left` / `right`, inside `MotionPresence`                                                                        | custom overlays, fixed widths or per-dialog animations |
| Grouped block, settings card      | `Panel`, `Section`, settings rows                                                                                                                                                                  | new card classes                                       |
| Page and side panel layout        | `WorkspaceLayout`, `PageBody`                                                                                                                                                                      | a second page gutter                                   |
| App status, version, new version  | `PreviewStatusBar` (status trigger, version, `PreviewUpdateButton` when the host reports a newer one; read it with `usePreviewNewerVersion`)                                                       | status rows in the sidebar, a toolbar update banner    |
| Status checklist                  | `preview-status-list` rows in `SystemStatus` (tone icon, label, value, at most one action)                                                                                                         | separate cards or badges per check                     |
| Navigation and chat history       | `preview-rail` icon rail in `BuyerSidebar` plus `PreviewConversationPanel` (New chat, `PreviewAgentLogos` entry, Pinned and dated groups, search and filter icons, running spinner and unread dot) | text navigation rows, a permanent search field         |
| Conversation actions and details  | `PreviewConversationMenu` (title bar `Dropdown`: pin, rename, copy, delete) and `PreviewChatDetails` (context panel with `Facts`)                                                                  | per-row action buttons, a second details page          |

- `Tag`: status or label with a tinted background; `dot` for live states.
- `Delta`: signed percentage; set `lowerIsBetter` for prices and latency.
- `Savings`: "N% below median" against the median of the paid offers for the
  same model and quantization from sellers online now (`comparableMedian`);
  hidden with fewer than 3 such offers or when not cheaper.
- `SegmentedBar`: one bar split by source with a text legend (the legend carries
  the values for assistive technology).
- `FilterChips`: single-choice filter with counts; one Tab stop, arrow keys move.
- `Tag` `pill`: Free and Paid labels in the model picker; price and seller counts
  use plain `Tag`s on the line below.
- `Tag` and `Badge` share one size across the mockup: 20 px high, 11 px text,
  `--pk-radius-tag` (6 px); picker and flyout tags drop to 18 px.
- Menus (`Dropdown` panels and the seller flyout): 150 ms fade with a 0.95 scale
  and 2 px blur, grown from the trigger side; rows use the control radius
  (10 px) inside the 16 px panel. A trigger's caret turns while its menu is open.
  The caret turn (and the `ui-select-trigger` chevron) animates only without
  reduced motion. Tooltips open with the same popover recipe. In the model
  picker search (combobox), the first match is marked while typing and Enter
  picks it.
- Number fields (`CompactAmount`, `AmountEditor`): 36 px field, value on the left,
  unit, then minus and plus together at the end (24 px steppers).
  Every amount input uses one of them, including the account spending limit.
- `Notice`: one toned line that must stay visible, such as a pinned seller being
  replaced or an answer coming from the free-model fallback.
  The composer context tab keeps its own warning layout, because it is attached
  to the composer and carries its actions inline.
- `Switch`: `role="switch"` button for account-wide settings (the buyer
  `config.toml`); the row beside it carries the label and help.
- `CodeBlock`: language label (Shell, JSON, TOML, TypeScript, Text), line numbers, optional file
  title, highlighted tokens and a Copy button that shows "Copied" only after a
  confirmed copy. Chat fences map through `fenceLanguage`, tools through
  `agentCodeLanguage`.
- Settings rows (`preview-settings-rows`): copy and help on the left, one compact
  control on the right; Save/Cancel appear only after a change.

Compact density adds these shared pieces; each renders the comfortable markup, or nothing, with `?density=comfortable`:

| Need                                 | Use                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Loading list                         | `PreviewSkeletonRows` with `count`                                                             |
| Empty list or search                 | `PreviewEmptyLine` with an `icon` and one line of text                                         |
| Settings header icon                 | `Section` `icon` with `PreviewSectionIcon`                                                     |
| Menu or header glyph                 | `previewIcon(size)`: 16 px with a 1.5 px stroke (`bold`) in compact density                    |
| Keyboard shortcut in a menu or label | `Kbd` with `previewShortcut(PREVIEW_SHORTCUT.*)` (`⌘N` new chat, `⌘K` Models; Ctrl+ off macOS) |
| Confirm a save or delete             | `showPreviewToast(text)`; `PreviewToaster` is mounted once by `PreviewStatusBar`               |

Open `?screen=design-system` (Settings → Preview components) to review them all; the compact pieces above appear on their screens.

## Density

Compact density is the default. It sets `data-density="compact"` and Inter (the
`?font=inter` path) unless `font` is given. `?density=comfortable` restores the
previous density for comparison.

- Sidebar, menus, tables and lists: rows of 28–32 px (`--pk-row-height`, 30 px),
  controls of 28 px (`--control-size`) and 13 / 12 px text, including select
  triggers, list and card titles, Settings labels and tooltips.
- Pills (`Tag`, `Badge`) are 18 px with 11 px text; the badge line in the model
  picker keeps its 16 px tags. Text buttons in the content area are 24 px with
  12 px text; switches, the theme switch and dialog buttons keep their own size.
  Title-bar buttons are 28 px
  (`--shell-control-size`). Icon tiles are 28 px with 16 px glyphs, metric icons
  24 px.
- Digits keep the fixed-width `Gyblos Digits` face under Inter as well.
- Headings: 15 px section titles, 16 px page intros and the tool guide; 18 px
  metric values. Chat messages stay at 14 px for reading.
- Cards (metric, settings, payment methods, tables, lists, tool guide,
  limit, tool and application cards) share `--radius-panel`; metric cards pad 12 / 14 px with
  12 px labels. Help and detail text is 12 px. Tool guide steps use 20 px
  markers with 12 px glyphs and a 28 px tool logo. Tool cards stack the
  logo above the name and stretch to fill the row (112 px minimum track), so at
  desktop widths every tool stays in one row while the sheet resizes; narrower
  sheets wrap onto a second row.
- Settings rows, forms and empty states keep 20 px of inner spacing
  (`--pk-comfort-padding`).
- Radii by level: 6 px buttons and inputs (`--radius-control`), 8 px menus
  (`--pk-radius-menu`), 10 px cards (`--radius-panel`) and 16 px for the content
  sheet (`--pk-radius-sheet`).
- Icons in "…" menus, Settings headers and empty states use the 16 px, 1.5 px
  stroke set.
- Hover and focus transitions take 150 ms (none with reduced motion). Copy shows
  ✓ for 1 s. Saving or deleting shows a toast. Loading lists show skeleton rows.
  New chat (`⌘N`) and Models (`⌘K`), the desktop app's existing shortcuts, show them in tooltips
  and the conversation "…" menu.

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
