# Buyer desktop UI

This guide describes the implementation of the buyer desktop's shared visual
primitives. The Gyblos brand reference remains the design document in the
maintainer vault. A mockup is a proposal, not evidence that a payment or a
network capability is available.

## Shared sources

- `src/theme.ts` owns the light and dark color values used by the Electron
  window and renderer. Use the semantic variables it supplies instead of
  adding color literals to a screen.
- `src/ui/geometry.css` owns the radius tokens and assigns the common panel,
  control, option and badge shapes. Do not add a second radius scale.
- `src/ui/ui.css` owns the shared component classes and spacing tokens. Start
  with these classes and the primitives in `src/ui/UI.tsx` before adding a
  route-specific selector.
- `src/ui/Form.tsx` owns shared labeled inputs and form action alignment. The
  matching `ui-form`, `ui-field`, `ui-input` and `ui-form-actions` classes
  also support native selects and other form controls.
- `src/ui/DesignSystem.tsx` is a safe, local component preview in Settings. It
  does not change payment settings or create sessions.

## Composition

Use the desktop shell, `PageBody`, `PagePanel`, `SectionTitle`, `List`, `ListRow`, `Button`,
`Badge` and `ChoiceCard` for buyer screens. Use `ui-section` and
`ui-subheading` for visible groups, `ui-choice-grid` for selections and
`ui-help-text` for supporting copy. Use the `--space-*` variables for new
spacing. Align related controls and keep primary actions easy to identify.

`PageBody` owns scrolling and the responsive page inset (12–32 px). `PagePanel`
and the chat root share the 1440 px maximum width and centered alignment.
Sections use a 24 px gap. `DataTable` and `DataCell` keep tables readable as
labeled session cards below 700 px of body width, including the payment column. Do not add an independent page width or padding to a
route's first section, or align its footnotes outside this shared column.
Payment columns respond to the body's available width, including sidebar size.

Use visible sections, pages or dialogs instead of accordions or disclosure
triangles. A selected application is not necessarily connected; a connected
local gateway does not by itself verify an individual application. Keep keys
masked and preserve the existing clipboard and session boundaries.

Keep the buyer navigation stable: Applications describes optional web services,
Agents configures supported clients, and Payments holds wallet and payment
settings. Without a usable approved session, agent setup offers Go to Payments
in the primary action position. The link selects the PayPal view and navigates;
it never creates an order, approves payment or connects an agent. Existing
connections retain their review and disconnect actions. Mark services that are not implemented as previews rather than
connected. Use `ChatPaymentSelector` for the next message's payment method in
one Chat screen. Switching between USDC preview and PayPal Sandbox preserves
the conversation, history and draft. Each response retains its original method;
switching never changes earlier usage or creates another authorization.

Contextual links (for example Chat to Payments or Applications) show a labeled
back arrow beside the page title. Back returns through that journey without
changing drafts or payment state. Sidebar destinations start a new journey. The header holds the route title,
sidebar/back controls and contextual operation notices, not model/payment
selectors. Remind someone about PayPal only when an unfinished session is known;
an unchecked initial status is not evidence of an open session. Once an
unfinished session is known, retain that reminder across failed checks until a
fresh result confirms it is closed or ready; keep stale amounts hidden.
Use the same searchable `Dropdown` for Models, Tools and the Chat payment
method, with logos and explicit availability. Payment choices are exclusive
menu radio items; unavailable method changes stay disabled during operations.
Unimplemented tools remain disabled previews; the menu does not
connect them or accept credentials. Do not add disclosure triangles.

Use `ModelImage` and the bundled source-attributed artwork for known model
families. An artwork is a visual label, not evidence of a model's provenance or
of provider availability. Unknown families use the neutral Gyblos icon.
Use `ChatUserMessage`, `AssistantProgress` and
`ChatComposer` in the unified chat so people can distinguish messages,
recognize generation and use the same keyboard controls.

## Payment and accessibility states

Identify the active payment method with its composer icon and checked
menu item. USDC preview balances and activity are
simulated. PayPal Sandbox has an authorization limit and recorded usage; neither
is a confirmed capture. Do not start, repeat or settle an uncertain payment
from a visual component. Preserve the underlying session and recovery guards.
If a status refresh fails, present the session as unavailable rather than
showing the last known amount as current, and provide a way to check it again.
Do not allow switching away from PayPal during an operation or while a response
awaits acknowledgment; keep the method fixed during a preview response too.
Amounts shown for an uncertain session remain recorded
usage, not a confirmed capture.

Controls must have accessible names and visible keyboard focus. Use text as well
as color for selection, loading, error and unavailable states. Test narrow
windows, light and dark themes and reduced motion when changing shared styles.

## Payments and Chat

Payments owns session limits, approval, closure and recovery actions. Chat places
its compact payment selector beside Models and Tools in the
composer. Payments owns usage summaries and management; Chat has no payment
footer. Responses use the workspace background without an enclosing card or a
model/payment heading. Only user messages have a conversation bubble. Keep the
Gyblos generation signal visible while waiting; response details retain the model
and original payment method on demand. User messages show their send time and
copy/edit actions below the bubble. Editing prefills the composer; it never
resends or changes a recorded request automatically. Models, Tools and payment
use the shared `Dropdown`, `Button` and icon-button size. History, + and all
selectors inherit the same ghost hover/open styling from `ui.css`; never add a
composer-specific hover, border, padding or radius. The model keeps its logo, name and availability visible;
Tools and payment use square icon-only triggers without tooltips. Menus retain
names, pricing and availability. Keep the chat
free of a permanent preview banner. The browser preview uses the desktop's
renderer build and stylesheet rather than a separate implementation.
Both routes share one renderer controller
so navigation retains
drafts and never creates a second session. Changing routes does not approve,
capture or retry a payment. A USDC-only view still does not start PayPal.

Reasoning choices come from the shared protocol model catalog. Preview models
carry an explicit catalog ID; unknown, unverified and non-thinking models have
no selector. Qwen/Gemma offer Off/On; gpt-oss offers Low/Medium/High using the
catalog default. A model change cannot inherit an unsupported level. Each
preview response saves its setting in local display history. This does not
enable thinking in the current PayPal/Ollama route or prove that a network
seller supports it; live selection requires the offered capabilities and engine
support first.

On wide windows, payment management and wallet details use two columns. They
stack on narrow windows. Show the authorized ceiling separately from recorded
usage. A captured amount appears only for a fresh completed session; available
authorization appears only for an active, unexpired session with attempts left.
Hide current amounts while checking, processing or when status is unavailable.
