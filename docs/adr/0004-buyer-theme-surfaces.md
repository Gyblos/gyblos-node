# ADR 0004: Distinguish buyer messages from supporting surfaces

- Status: Accepted
- Date: 2026-11-21
- Owners: Gyblos maintainers

## Context

The compact buyer interface uses neutral surfaces in both light and dark themes.
User messages and small labels need enough contrast to remain distinct on
canvas, raised and selected surfaces.

## Decision

Render a user's message as a blue-tinted material rather than a text offset on
the canvas. Use the stronger secondary gray for small desktop labels on raised
and selected surfaces.

## Consequences

The theme owns these semantic values so routes share the same treatment. A
visual redesign should preserve message distinction and label contrast or record
a replacement decision.

## References

- [Desktop design](../../apps/desktop/DESIGN.md)
- [Buyer theme](../../apps/desktop/src/theme.ts)
