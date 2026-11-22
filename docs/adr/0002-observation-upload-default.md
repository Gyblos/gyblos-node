# ADR 0002: Enable content-free observations by default

- Status: Accepted
- Date: 2026-11-16
- Owners: Gyblos maintainers

## Context

The metrics collector uses buyer observations to describe request outcomes and
routes. These records exclude prompts, responses, credentials and endpoint
addresses. Release builds contribute observations without requiring each
operator to opt in manually.

## Decision

Telemetry observations are enabled by default. Operators can disable them with
`GYBLOS_OBSERVATIONS=off`. Receipt uploads have no corresponding opt-out in the
current release behavior. Release builds enable uploads with the default URL
through `GYBLOS_VERSION`; unversioned builds upload only when an operator sets a
collector URL. Refused receipts are skipped with a per-process cap of 200, so a
full 50-receipt envelope remains within the store page limit of 256.

## Consequences

The uploader and its documentation must keep observations and signed receipts
distinct, preserve the content-free observation schema, and describe the opt-out
exactly. Changing the default requires a new decision.

## References

- [Local telemetry](../local-telemetry.md)
- [Metrics collector](../metrics-collector.md)
- [Uploader configuration](../../packages/config/src/collector.ts)
