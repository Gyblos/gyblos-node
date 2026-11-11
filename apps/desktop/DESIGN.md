# Buyer desktop design system

The buyer uses one compact visual system across Chat, Connections, Models,
Applications, Activity, Payments and Settings. A visual state never proves a
payment, model or remote service is available. Render capabilities from the
existing controllers and validated host bridges.

## Shared sources

- `src/theme.ts`: light/dark semantic colors. The primary accent is `#0a28f0`.
- `src/mockup-base.css`: bundled Instrument Sans, monospace and element defaults.
- `src/ui/geometry.css`: panel 16 px, control 10 px, option 8 px and badge radii.
- `src/ui/ui.css`: shared primitives and spacing tokens.
- `src/ui/buyer-design.css`: compact buyer composition, shell motion, shared
  management controls, financial tables and sidebar choreography. Loaded after
  the component foundations so every route receives the same scale.
- `src/ui/window-chrome.css` and `src/window-chrome.ts`: one native window row,
  platform control reservations and shared navigation geometry.
- `src/ui/response-metrics.css`: compact readings, token proportions and cost.
- `UI`, `Form`, `Management`, `Dropdown`, `ScrollTable`, `Pagination` and
  `WorkspaceLayout`: reusable component anatomy. Route components compose them;
  they do not introduce a separate control or page scale.

## Scale and composition

| Role                                | Value                                  |
| ----------------------------------- | -------------------------------------- |
| Interface / supporting text         | 14 / 12 px                             |
| Section / metric text               | 18 / 22 px                             |
| Control / icon                      | 32 / 16 px                             |
| Header                              | 44 px                                  |
| Navigation / collapsed rail         | 224 / 56 px                            |
| Context panel                       | 260 px, capped at 40% of its workspace |
| Management / reading column maximum | 1120 / 760 px                          |
| Page inset                          | 24 px; 16 px below 900 px              |
| Section / group / related gap       | 24 / 16 / 8 px                         |

`PageBody` owns scrolling and the outer inset. `PagePanel` and the connection
workspace align to that inset. Internal sections add no second page gutter.
The header owns the route title; do not repeat the same heading or a route icon
in the body. Back and Forward retain chronological screen visits, including
sidebar navigation. Alt+Left/Right follows the same history. These actions do
not replay messages or reopen payment checkouts. A new destination clears the
forward history; repeated selection of the current screen is inert.

The titlebar replaces the separate native title and app header. Keep native
macOS traffic lights or Windows/Linux caption controls; reserve their space and
make interactive controls non-draggable. Center one route or conversation title.
Connections uses an Info action for its context panel, distinct from the left
sidebar toggle. Startup windows retain their existing native chrome. The title
reserves the measured leading and trailing action widths, including notices.

Both side panels are layout columns. Opening either displaces the main content;
closing reverses the same 300 ms easing. The collapsed sidebar retains its icons.
Labels and conversation history fade during motion; hidden interactive content
is inert immediately. Honor reduced motion. Animate only sidebar icons, using
meaningful parts (link halves, strokes, wallet lid, gear and graph), never a
scale-up of the whole glyph. No accordions.

## Controls

Use shared primary, secondary and ghost buttons. Otherwise-transparent body
actions have a subtle outline and surface. Sidebar, header, footer and composer
controls, message actions and dialog close buttons are exceptions: they blend
into their surface and use the
shared hover/focus treatment. Never add a one-off button size, padding or radius.
All controls keep accessible names and keyboard focus; color is never the only
state indicator.

Copy fields place a button labeled Copy beside the input, with a specific
accessible name. Keep API keys masked. Host-owned API clipboard operations copy
the current connection without requiring disclosure. Model names stay visible
in the composer. Tools and payment use icon-only triggers. Thinking uses a quiet
text selector and only the levels supported by the selected model; preview
reasoning settings do not enable unsupported live engine capabilities.

## Navigation and screens

The sidebar groups New chat, Connections, Models and Applications above local
conversation history. Activity, Payments, Settings and System status stay below
it. System status opens a dialog with actual node and wallet readiness; there is
no persistent status footer.

Chat has one transcript and draft across payment methods. Only user messages
have bubbles, with time, copy and edit actions below them. Assistant responses
use the page background without a model/payment heading. Preserve the Gyblos
progress signal. The composer owns model, thinking, tools and payment choices;
Chat has no payment footer or duplicate History/New chat toolbar. Editing only
prefills the draft. Navigation and method selection never send a request.

Response metrics uses the model's existing artwork, prominent performance
readings, measured token proportions and a separate cost summary. Unknown
values stay “—”; zero is a known measurement. Buffered replies report observed
round-trip time, never fabricated first-token latency or engine throughput.
Reported token usage is bounded by the buyer policy. PayPal's per-response
amount is recorded usage, not a capture. x402 cost comes from the already
validated settlement and keeps the actual asset unit. Optional telemetry never
changes payment decisions. Old local conversations remain readable without it.

Connections gives API key and Base URL priority. Model is not a connection form
field. Before generation, an explicit lifetime API key spend limit is required;
show key limit, usage and remaining using the shared form and stats primitives.
The key cap is separate from shared-session amounts and has no automatic reset.
An exhausted key stays visible and cannot silently receive a larger cap.
Four named setup guides use the same key and URL; Other tools is a
secondary action. Guide selection does not establish a connection. Use the
existing readiness guards: missing authorization leads to Payments, unknown
status stays visible, and invalid/stale connections never gain copy or request
permission through a visual state. Disconnect all tools requires confirmation
and keeps the payment session separate. The context panel contains local access
and fresh shared-session information.

Models uses a searchable list with laboratory artwork, a filter menu and a
network-check dialog. Artwork does not establish availability. Applications
shows unavailable web services as such, without pretend connection actions.
Settings holds Appearance, the visual-system preview and version information.

Payments prioritizes the USDC wallet with its public address and funding
availability, followed by a compact PayPal summary and a session-management
dialog. Spending filters are independent from Chat's selected payment method.
Preserve all existing checkout, capture and uncertain-payment guards. Visiting
a route or opening a dialog never starts, approves or settles a payment.

Activity separates Chat consumption, agent inference and confirmed payments.
Shared tables preserve tabular structure at narrow widths, scroll internally,
keep their header/identity column visible, and put pagination outside the scroll
region. Reset the page when filtering. Loading/error states hide stale totals.
Detail dialogs preserve linked conversations and full provider references.

## Financial accuracy and references

- Incoming funds use green and a plus sign; paid outgoing amounts use neutral
  ink and a minus sign. Pending/review uses amber. Red denotes failures.
- Recorded consumption and authorization limits are not captured payments.
  Unknown or uncertain amounts remain unknown. Keep USD and USDC separate.
- The protected desktop wallet has public metadata but no live balance source.
  x402 uses the selected buyer role wallet, explicitly identified in Payments.
  Its verified per-inference receipts are separate from protected-wallet data.
  Simulated historical replies are never counted as payments.
- Display validated, locally saved PayPal authorization/capture IDs through the
  separate read-only reference bridge. Usage activity stays identifier-free.
  Never substitute an order ID for a payment ID. Legacy history may lack IDs.
- Tables abbreviate references and label PayPal columns Payment ID. Row-level
  Copy buttons are omitted; details show the full reference and Copy action.
- A real x402 payment record includes its actual transaction hash and
  network. Its abbreviated hash must open an allowlisted explorer through a
  host-owned action. Never accept arbitrary renderer URLs or fabricate a hash.
- x402 authorizes a local Chat budget, reserves before sending and settles each
  response through the existing buyer. Finish closes spending permission, not
  a deferred aggregate payment. Unknown outcomes show review, not a remaining
  balance. Free quotes show no transaction. Unknown test assets use atomic
  units; only the known devnet USDC mint uses the USDC label.
- Local activity dates describe when this device observed the record, not a
  provider transaction timestamp. Saving failure/corruption is visible and does
  not overwrite an unreadable record or retry a payment.

Verify wide and narrow windows, both themes, keyboard navigation, reduced
motion, all connection/payment states and full tables when changing the shared
system. Web review and desktop load the same renderer and styles; example data
belongs only in an isolated visual fixture, never in the shipped controllers.
