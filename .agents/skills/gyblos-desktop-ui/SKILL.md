---
name: gyblos-desktop-ui
description: Reuse the shared desktop UI components in the gyblos-node web mockup. Use before creating or editing any screen, dialog, form, table, code sample or style in lab/tools/desktop-preview, and whenever you are about to write raw markup (select, pre, button, input, table, status span) or a new CSS class.
---

# Gyblos desktop UI

The binding rules are in `AGENTS.md` (Desktop visual changes) and
`apps/desktop/DESIGN.md`. The component catalog is the Components table in
`lab/tools/desktop-preview/DESIGN.md`. This skill only helps apply them.

The catalog covers the mockup. Shipped desktop code in `apps/desktop/src/ui`
follows `apps/desktop/DESIGN.md`; mockup-only components reach it only through
a port the founder approved.

## Before writing UI

1. Read the Components table in `lab/tools/desktop-preview/DESIGN.md`.
2. For each element you need, use the listed component. Open
   `?screen=design-system` in the preview to see them.
3. Search for an existing use before adding markup:
   `rg "<CodeBlock|<Dropdown|<DetailSummary|<Tag" lab/tools/desktop-preview`.
4. If a component almost fits, extend it with a prop instead of copying its
   markup into the view.

## While writing

- No native `<select>`, bare `<pre>`, raw `<button>` or `<input>` styling, or
  local status markup where a component exists.
- No raw colors, sizes or radii: use theme variables, `--pk-*` tones and the
  shared geometry tokens.
- Dialogs use `Modal` with `size`; text stays short, details go in a "?" tooltip.
- Shared changes go in the shared component, so every screen gets them.

## When you create a reusable component

1. Put it in `views/PreviewKit.tsx.preview`. It moves to `apps/desktop/src/ui`
   only in an approved port.
2. Add its row to the Components table in `lab/tools/desktop-preview/DESIGN.md`
   in the same change, and show it on the design-system screen.
3. Replace the copies it supersedes in the same change.

## Before handing off

Review every changed screen in the preview, wide and narrow, dark and light,
and check that no view repeats markup a component already owns.
