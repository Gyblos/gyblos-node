# ADR 0003: Require a real online check before sponsorship

- Status: Accepted
- Date: 2026-11-21
- Owners: Gyblos maintainers

## Context

Identity sponsorship pays registration costs for a node. A locally configured
NodeId is not proof that the requester controls its private key or can serve as
the registered node. A caller-supplied boolean would provide no such proof.

## Decision

Sponsorship permits one registration per canonical device key and owner, subject
to positive per-registration and total budget caps. A zero or negative cap or
budget is invalid configuration. Ledger keys stay canonical so the same device
or owner cannot bypass a limit through alternate spellings. Cheap, synchronous
validation and budget checks run before the network check.

Each sponsorship requires a fresh challenge delivered to the node over Iroh, a
catalog check, and a signature from the node key over the domain-separated
message `domain ‖ challenge ‖ nodeId ‖ owner`. The verifier receives a copy of
the challenge so it cannot change the value being checked. A wrong or missing
signature denies sponsorship; a verifier failure also denies sponsorship. The
caller that owns the verifier is responsible for logging its failure. The
signature proves access to the node key; Sybil resistance depends on the
additional checks performed by the real online verifier.

After approval, the caller persists the sponsorship ledger atomically with the
decision. A non-canonical request cannot be recorded. Sponsorship remains
unwired until the real Iroh and catalog check exists.

## Consequences

Keep sponsorship policy separate from RPC, storage and registration execution.
Until the real Iroh and catalog check exists, do not connect sponsorship to a
product entry point. A future verifier must preserve the challenge binding and
state the limits of the identity proof.

## References

- [Identity](../identity.md)
- [Identity sponsorship policy](../../packages/identity/src/policy.ts)
