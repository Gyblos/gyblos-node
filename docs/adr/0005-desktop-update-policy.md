# ADR 0005: Keep desktop updates user-directed

- Status: Accepted
- Date: 2026-11-21
- Owners: Gyblos maintainers

## Context

The desktop app can notify buyers about published releases. Automatically
downloading or installing code would give the update notice authority over local
software changes.

## Decision

Desktop update notices open the official release page in the user's browser. The
desktop host owns that single release destination and never downloads or
installs code.

## Consequences

Update checks may report available versions, but the user remains responsible
for choosing and installing a release. Changing to automatic updates requires a
new trust and verification decision.

## References

- [Desktop design](../../apps/desktop/DESIGN.md)
- [Desktop update constants](../../apps/desktop/src/constants.ts)
