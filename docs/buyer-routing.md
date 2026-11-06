# Buyer routing by signed quote

`pnpm buyer` and `pnpm buyer:chat` use the same buyer entry. Discovery,
independent owner–NodeId identity checks, public-record replay protection,
selection and the signed quote are verified before choosing execution.

- Both signed prices are `"0"`: the quote must have `maxAtomic: "0"`. Use the
  existing free execution channel with its seller caps and replay checks.
- Either signed price is positive: the quote must have a positive budget. Use
  the existing paid execution channel and its journal, recount and settlement
  checks. Paid startup restrictions still apply, including the supported model
  and devnet network; mainnet is not enabled by this entry.

The configured `request.maxAtomic` is a spending ceiling, not a paid-mode
switch. A positive ceiling can accept a free offer. The same verified winner and
signed quote reach the chosen executor; neither executor selects again. The
existing selection policy still chooses sellers; routing adds no free-first
preference or reasoning downgrade.

Free execution does not load the payment signer, paid tokenizer or payment RPC,
and does not create a payment journal, authorization, deposit or settlement. The
buyer checks existing payment state read-only: an unresolved signed payment,
unsafe state or another process's payment lock blocks new calls, including free
ones. It never clears or takes over a payment lock to permit free execution.
Seller registration and independently configured identity verification are
separate from inference payment transactions.

The loopback endpoint requires a private bearer token for every request because
this entry can spend. Its owned CLI connection attaches the token without
exposing it. Completed automatic JSON/SSE replies include `gyblos_execution`
(`free` or `paid`); only paid replies carry `gyblos_payment`. The terminal uses
this explicit result rather than guessing from the configured spending ceiling.
A paid completion missing payment information is never reported as free success.

One deadline and seller exclusion set cover the whole request. A proven-unsent
attempt may try another seller, including across price modes. A potentially sent
prompt, delivered text, remote failure or uncertain authorization is never
retried. Closing the host or inspecting an interrupted charge does not
initialize an unused payment runtime. Prompts and responses are never persisted
by routing.

`pnpm buyer:free` retains its explicit free-only behavior. The legacy paid-v1
flow and protocol signing formats are unchanged. Seller onboarding and the
zero-price default are separate seller-side work; this change accepts the
already supported capped free offers and does not reinterpret a paid offer
configuration as a free offer. Reusable payment channels and exact protocol-fee
collection are separate work.
