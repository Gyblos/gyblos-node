# BoardUI catalog for the Explorer

The shipped Explorer's operative design contract is
[apps/explorer/DESIGN.md](../../apps/explorer/DESIGN.md). This workspace holds
the official component sources for design review. From the repository root, run
`pnpm install --frozen-lockfile`, then
`pnpm --filter @gyblos/boardui-catalog sync` and
`pnpm --filter @gyblos/boardui-catalog typecheck`. The CLI version and npm
dependencies are locked. The CLI fetches the current public registry, so
component contents can change between installations. The generated source,
preview assets and example chat endpoint live here locally. The Explorer only
serves routes under `apps/explorer/app`.

Run `pnpm --filter @gyblos/boardui-catalog preview` to browse the eight proposed
components at port 4194. The gallery has its own Next.js route root and uses
demonstration data. The catalog pins React Aria 1.17.0, the upstream context
menu’s declared baseline. The product uses its existing 1.22.1 adapters.

The installed [BoardUI skill](../../.agents/skills/boardui/SKILL.md) describes
each component and its license tier. The public registry resolved 90 items
including foundations, utilities and application blocks. Pro components and
templates require a separate activation. To adopt a selected component in the
Explorer, run the official CLI in `apps/explorer` with its exact registry name
and `--yes`. Its local BoardUI configuration preserves the Explorer's component
paths. Check shared source before replacing an existing file: Gyblos adapts
typography, tokens and selected component APIs.

## Network and Stats

| Route            | Visitor's question                                            | Suggested structure                                                                                                                                 | Destination                                                                                                                    |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Network          | What happened on the network, and which models can I use now? | Visible page title, one period selector, three selectable totals, one daily chart, current offers, latest operations                                | A chart opens its metric in Stats. Offers link to the model variant, seller and address. Operations open indexed transactions. |
| Stats / Usage    | What explains inference activity?                             | Requests and token breakdowns, buyers, success rate, median time to first token and unserved demand. Show daily evidence below the selected metric. | Keep the selected metric, period, source and tab in the URL. Model and seller cells use the same linked identities as offers.  |
| Stats / Payments | How did funds move?                                           | Separate authorized receipt value from on-chain deposits, settlement, payout, fees and refunds. Show daily on-chain detail.                         | A payout drilldown opens payouts in the selected period. A settlement drilldown opens settlements.                             |

### Data discrepancies to resolve first

- The overview closes at yesterday UTC. Direct entry to Stats can include today
  for 7d, 30d and All. The overview's current detail link sets `closed=1`. Share
  the UTC dates, baseline and source coverage across direct visits, links and
  back navigation.
- `overviewActivity` uses a missing point for dates without published receipts.
  `dailyRequests` fills missing dates with zero. Give both routes the same
  distinction between observed zero, missing observation and unavailable source.
  Preserve a daily slot for every UTC date.
- With All selected, the overview compares the last two closed seven-day
  windows. Stats drops the change chips. Reuse the window description, sample
  coverage and eligibility rules. Keep each chip next to its period total.
  Focusing a day should show the daily value and coverage independently.
- Overview tokens combine input and output. The Stats card covers output only.
  Provide an input/output breakdown that reconciles with the overview total. The
  same applies to total requests and the free/paid split. Disclose receipt
  coverage on both routes.
- The financial overview charts payouts while the Stats chart defaults to
  settlements. Let the source metric choose the initial chart. Use separate
  identifiers and precision for authorized, settled and paid amounts.
- Stats Usage fetches the model and network snapshots together, although its
  network totals come from the network resource. Load network totals
  independently so a model endpoint failure only affects model breakdowns.

### Component decisions

| Element                     | Use                                                                                                                                          | Behavior to preserve                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route and section headers   | Shared PageFrame and SectionTitle, visible route title, one refresh timestamp per source                                                     | Snapshot time belongs to current offers. Range belongs to period activity.                                                                                                                  |
| Date and section navigation | BoardUI segmented-control for 24h, 7d, 30d and All. BoardUI tabs for Usage and Payments. Select for a chart-specific override.               | All opens by default. A local override affects that chart alone. Browser history restores selection.                                                                                        |
| Metrics                     | One card anatomy from stat-cards, chip and tooltip, with selectable, single-value and free/paid variants                                     | Existing fonts, exact NumberFlow values, semantic positive and negative changes, explicit baseline. A worsening failure count has a negative tone even if its numeric delta is positive.    |
| Daily charts                | Share date handling, labels, focus, touch and NumberFlow. Use orders-chart-card and revenue-chart-card as free source references for layout. | Keep real UTC data and absent-day markers. Arrow keys and touch can inspect every day. Guard reduced motion.                                                                                |
| Tables                      | Shared table shell, current grouped headers and URL sorting, existing BoardUI pagination                                                     | Keep cursor-based operation paging, always-visible pagination, sticky identity column and internal links. Use data-table only for a listing whose sorting and paging agree with its source. |
| Theme                       | Map surface, text, focus and chart tokens once; use the existing typography                                                                  | Validate light and dark modes, positive/negative contrast, selected and disabled states. Some upstream accent families currently share the same Gyblos colors.                              |

### Responsive acceptance

Chromium and WebKit 26.5 layout was measured on both routes at 320, 360, 390,
640, 768, 820, 1024, 1280 and 1440 CSS pixels. All 36 combinations fit the
viewport. In both engines a touch run at 320 × 640 selected 7d (seven daily
points), opened the independent chart range, paged operations and navigated to
Stats. These are emulated devices on macOS. Physical iOS and Android devices
remain unverified. At 320 px the offers and operations tables need 640 px within
a 286 px region. The daily Stats tables need 1100 px within the same region.
They can scroll to the final column and the date stays pinned. At 1024 px those
daily tables still need 142 px of internal scrolling.

Offer metric groups on small screens (requests, tokens, latency, or amounts)
plus an explicit full-table view. Increase hit areas for period and paging
controls (measured height 24 px), the fee tooltip (20 by 20 px) and the search
button (15 by 15 px). Keep compact visible controls inside larger touch targets.
Verify one-day, all-time, empty, unavailable and long-number states before
releasing either route.

Suggested delivery order: reconcile metric definitions and links, adopt the
shared KPI and chart controls, then simplify the mobile tables. At each step
compare matching totals across routes and exercise pagination, keyboard
navigation, touch and browser history.
