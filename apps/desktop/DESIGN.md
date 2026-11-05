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

Use the desktop shell, `PagePanel`, `SectionTitle`, `List`, `ListRow`, `Button`,
`Badge` and `ChoiceCard` for buyer screens. Use `ui-section` and
`ui-subheading` for visible groups, `ui-choice-grid` for selections and
`ui-help-text` for supporting copy. Use the `--space-*` variables for new
spacing. Align related controls and keep primary actions easy to identify.

Use visible sections, pages or dialogs instead of accordions or disclosure
triangles. A selected application is not necessarily connected; a connected
local gateway does not by itself verify an individual application. Keep keys
masked and preserve the existing clipboard and session boundaries.

Use `ModelImage` and the bundled source-attributed artwork for known model
families. An artwork is a visual label, not evidence of a model's provenance or
of provider availability. Unknown families use the neutral Gyblos icon.
Use `ChatUserMessage`, `AssistantHeading`, `AssistantProgress` and
`ChatComposer` in both chat experiences so people can distinguish messages,
recognize generation and use the same keyboard controls.

## Payment and accessibility states

Keep the active payment method visible. USDC preview balances and activity are
simulated. PayPal Sandbox has an authorization limit and recorded usage; neither
is a confirmed capture. Do not start, repeat or settle an uncertain payment
from a visual component. Preserve the underlying session and recovery guards.
If a status refresh fails, present the session as unavailable rather than
showing the last known amount as current, and provide a way to check it again.

Controls must have accessible names and visible keyboard focus. Use text as well
as color for selection, loading, error and unavailable states. Test narrow
windows, light and dark themes and reduced motion when changing shared styles.
