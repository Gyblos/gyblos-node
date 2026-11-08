# Guided buyer setup

From a checkout with dependencies installed, run:

```sh
pnpm buyer:init
pnpm buyer:chat
```

Before starting chat, provide the beta relay token privately through
`GYBLOS_RELAY_TOKEN` in that process's environment. Setup does not request,
print or save the token. Never put it in `selection.json`, a shared shell
command or a terminal recording. A missing or invalid token produces a static
startup diagnostic naming the relay settings to check.

`buyer:init` needs an interactive terminal. `pnpm buyer:init --help` works
without one. It prepares local configuration only: it makes no discovery or RPC
request, starts no engine, downloads nothing and sends no payment transaction.

## Questions

Have the seller's public NodeId and owner wallet address from an independent,
trusted source. A discovery listing is not identity proof. The assistant asks
for those values, the exact model/variant/quantization and the output-token
limit. Defaults match the bounded Qwen3-0.6B offer, with reasoning off and no
reasoning downgrade. Custom model names are preserved exactly; availability is
checked by the existing buyer when it requests a quote. A blank answer keeps the
displayed default; enter `-` to clear variant or quantization to null. Each
answer is checked immediately using the same shared validation as the complete
plan. An invalid answer names the field and gives a static hint; only that
question repeats, with earlier valid answers retained. Cancelling during a
correction performs no initialization.

Amounts are entered as **USDC**, with exact micro-USDC precision. Input and
output price ceilings are **USDC per million tokens**. The saved file contains
canonical atomic amounts; no floating-point conversion is used.

The default total ceiling and both price ceilings are zero. This admits free
quotes only. A positive total ceiling still allows free quotes: the buyer
chooses the execution path from the verified signed quote, not from a mode
selected by this command. Positive-price execution additionally requires the
existing devnet funding and pinned-tokenizer preparation; setup performs
neither. The total ceiling bounds the payment, including the protocol fee.

Discovery and the 8004 identity RPC have separate prompts. The generated
configuration always enables independent 8004 verification and never sets a
manual-trust override. The index provides availability only. The relay must be
one already allowed by the transport configuration. Credentials in a URL's
username/password or query, fragments and remote plain HTTP are refused;
loopback HTTP is permitted for local services. Keep provider credentials out of
shared configuration and terminal captures.

`GYBLOS_RELAYS` configures the allowed relay origins; its default is the
supplied relay. Choosing a different relay in the form does not add it to that
allowlist. Configure the approved origins before running setup and use the same
relay configuration for chat. Relay approval and independent 8004 verification
remain enforced.

The generated setup requires discovery and the configured 8004 RPC to be
available at runtime. The RPC shown by default is editable. An index-fetch
failure stops selection; a matching retained live signed record may still
establish listing eligibility when absent from the latest response. There is no
automatic fallback that skips discovery or identity checks.

This first assistant configures one independently known seller on devnet. The
existing runtime can still read its richer selection format. The paid role's RPC
remains governed by its existing role setup and `GYBLOS_RPC_URL`; the 8004 RPC
answer does not replace an existing role's RPC.

## Confirmation and local files

Before the first question, setup checks the selection destination without
opening it or creating directories, locks or identity files. Existing settings
stop the assistant immediately, with their path and reconfiguration guidance.
This early check is advisory: the locked check and exclusive publication below
still reject a destination created while the questions were being answered.

The assistant displays the model and spending ceilings, then asks for `y` or
`yes`. Cancelling before confirmation requests no initialization. Once
confirmed, it creates or reuses the buyer identity through existing role setup
and saves `$GYBLOS_HOME/buyer/selection.json` (the existing home default still
applies). Existing identities, journals and other state are retained.

The buyer directory is private (0700), and settings are private (0600).
Initialization holds a process lock and publishes a fully synced staged file
exclusively. It refuses any existing destination, including a symlink, even if
another writer creates it during setup. There is no overwrite/force option. The
command does not reset payment uncertainty or discovery replay history.

If interrupted after confirmation, newly created identity files may remain. A
retry reuses them; an already published selection file is refused rather than
replaced. Inspect the outcome before retrying. Cancellation is checked before
role preparation and publication; an atomic write already in progress may
complete. Setup does not provide a backup or recovery phrase.

Static errors:

- `BUYER_INIT_INVALID`: invalid form values, unsupported bounds or unsafe URL.
  Shared validation also identifies the invalid field without copying its value
  into the error. The terminal gives a field-specific hint and repeats the
  question.
- `BUYER_INIT_EXISTS`: selection settings already exist and are preserved. Edit
  the existing `selection.json` to reconfigure; the assistant does not replace
  it.
- `BUYER_INIT_UNAVAILABLE`: unsafe local paths, concurrent initialization,
  unavailable state, cancellation during setup or incompatible existing role. An
  existing role with another mint requires a separate `GYBLOS_HOME`.

A separate home creates a separate buyer identity; it does not migrate balances,
payment history or replay state. Keep the old home for any outstanding recovery,
reconciliation or withdrawal. Never delete keys or clear journals to make setup
succeed. Changes to an existing selection file must retain private file modes
and the runtime's full validation and trust requirements.

The shared `@gyblos/node/buyer-init` entry exports the form defaults, pure plan
builder, field validator, read-only preflight and private initializer. Hosts
supply role preparation and local-home context; the CLI supplies terminal
input/output. Other hosts can reuse these functions without importing the CLI.
Runtime selection validation, quote verification and execution remain in their
existing paths.
