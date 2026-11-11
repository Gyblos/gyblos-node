# Bounded buyer API keys

The automatic USDC buyer supports delegated API keys created from the desktop
app's **Connections** screen. Start or connect the local buyer in **Payments**,
then give each key a name and a lifetime spending limit. The key and Base URL
can be copied into a compatible client. Keep Gyblos and its buyer running while
the client uses them.

The supported inference interfaces are OpenAI Chat Completions and Anthropic
Messages, including text history and streaming. Model discovery is authenticated
and does not consume the key budget. This buyer does not implement tool calls or
the Responses API. These capabilities differ from the separate PayPal prototype;
a connection does not imply that every coding agent is supported.

## Authority and accounting

The buyer's private operator credential is separate from delegated keys. It
remains in the desktop host and must not be given to tools. Only that operator
may create or revoke keys through `/v1/gyblos/api-keys`. Mutations require the
currently displayed buyer policy in `If-Match`; delegated credentials cannot
access management. Browser-origin requests cannot manage keys.

The buyer enforces each key's cap independently of the renderer. The cap is in
atomic units, bound to the buyer wallet, network and asset. It has no automatic
reset and cannot be edited upward. Revocation stops new work and preserves all
recorded consumption and unresolved reservations. Zero permits free models only.
A new key is a separate permission explicitly granted by the owner; it does not
erase another key's liabilities.

Before payment preparation, the buyer limits the signed quote's ceiling to the
smaller of its configured request cap and the key's remaining allowance. It
durably reserves the verified quote maximum before dispatch. Concurrent requests
cannot reserve the same allowance. A known completion releases only the unused
reservation and records its verified amount before delivering the response.

- Per-request settled executions consume the verified charge, including a
  charged terminal failure or a failed delivery. A transaction is required to
  classify a charge as settled.
- Reusable sessions consume each verified request approval, once. The session's
  cumulative approval and collateral deposit are not added as key usage.
  Approved usage is shown separately from settled payments.
- A verified free execution consumes zero. Proven-unsent failover can release
  its reservation; an uncertain paid outcome cannot.

Existing buyer policy, price ceilings, wallet and payment-session safeguards
still apply. A key does not allocate wallet funds or replace session collateral
authority. Desktop Chat has its own budget; it does not consume a delegated tool
key's permission.

## Persistence and interruption

Only a digest of a delegated secret is saved, alongside content-free counters
and unresolved request bindings, in an owner-only buyer permission ledger. The
ledger has a single-process lock and durable writes. It is not a prompt,
response or signed-payment store. App restarts retain the original key limits
and usage; an already configured client keeps working with the same secret. The
app can copy a new secret only during the app session that created it.

An interrupted paid reservation, failed write or inconsistent state fails
closed. Unknown reservations also block operator inference and creation of new
keys. Revocation remains available and does not clear an obligation. This
version does not automatically reconcile a delegated reservation from financial
history: inspect the underlying payment state before implementing recovery.
Never delete its ledger or lock to resume spending. A local file rollback is not
a supported way to restore spending authority.
