# Payment sessions

A payment session lets a buyer deposit once and pay one seller for many answers.
The buyer approves each answer's usage with a cumulative signature, and the
seller settles the channel once, when the session closes. Sessions use the x402
`batch-settlement` scheme on the official payment-channels program, on devnet.

Sessions are an allowlisted pilot. Per-request payment stays the default for
every priced offer ([payments.md](payments.md)). This page also owns how the
buyer chooses between free and paid execution and what it does when a seller is
busy ([Buyer routing](#buyer-routing)).

| Question              | Per-request paid                   | Payment session                         |
| --------------------- | ---------------------------------- | --------------------------------------- |
| Deposits              | One per request                    | One per seller channel, reused          |
| On-chain transactions | Open and settle on every request   | Open once, settle once; none per answer |
| Conversation history  | One user turn in `pnpm buyer:chat` | Full text conversation                  |
| Tools                 | Refused                            | Supported                               |
| Who can use it        | Any buyer                          | Buyers the seller allowlists            |
| Windows               | Supported                          | Refused                                 |

## Prerequisites

- The seller and the buyer run the same Gyblos release. Older and newer peers
  are not mixed (see [Upgrading and downgrading](#upgrading-and-downgrading)).
- Both run on macOS or Linux. On Windows the seller refuses an allowlist and the
  buyer refuses a session policy, because the payment directory lacks equivalent
  ACL validation.
- The seller serves a priced offer with a recountable model and a funded fee
  payer ([Get paid](https://docs.gyblos.com/en/sellers/get-paid)).
- The buyer holds devnet USDC for the deposit, and the seller knows the buyer's
  NodeId.

## Seller setup

1. Optionally set the session capacity in the seller's `config.toml`. The
   default is 16 and the range is 1–16:

   ```toml
   [limits]
   max_sessions = 16
   ```

2. Allowlist the buyers. Set `GYBLOS_SESSION_BUYER_NODE_IDS` in the seller's
   environment to a comma-separated list of lowercase buyer NodeIds, with no
   spaces and at most 16 entries. The singular `GYBLOS_SESSION_BUYER_NODE_ID` is
   a one-buyer alias. Setting both, or a duplicate NodeId, refuses startup.

3. Start the seller normally. With an allowlist, it advertises the session
   channels next to its per-request paid channel.

Without an allowlist, the seller serves only free and per-request paid requests.
It still restores any unfinished session for status, approval and closure.
Removing a buyer from the allowlist never grants a new inference or discards a
debt.

<a id="seller-capacity-and-separate-buyer-sessions"></a>

### Capacity

`max_sessions` counts unfinished financial sessions: active, disconnected,
opening, uncertain or closing. It does not change connection quotas or the
single generation slot. A finished answer or a disconnected buyer does not free
a slot. Only a proved closure with its refund, or a proved never-created
opening, frees one. Lowering the limit keeps existing obligations and their
recovery, and refuses new sessions.

Each buyer has its own private child journal under the seller's payment
directory. An admission index reserves the slot before any deposit is submitted.
A missing, corrupt or unindexed journal fails closed.

The index also keeps proof for closed sessions, up to 64 distinct buyers. At
that limit it refuses a new buyer instead of evicting proof. There is no
automatic retention management. Never delete journals or locks to free capacity
or bypass recovery.

## Buyer setup

### Explicit startup policy

Add a `session` object to the buyer's `buyer/selection.json`, next to its
existing request, selection and identity fields:

```json
{
  "session": {
    "depositAtomic": "1000000",
    "lifetimeMs": 3600000,
    "withdrawDelaySeconds": 900
  }
}
```

| Field                  | Meaning                                                  | Allowed values                       |
| ---------------------- | -------------------------------------------------------- | ------------------------------------ |
| `depositAtomic`        | Deposit for each seller channel, in atomic units         | Positive, at most `1000000` (1 USDC) |
| `totalDepositAtomic`   | Optional authority shared by several sellers             | Positive atomic decimal string       |
| `lifetimeMs`           | How long the seller serves the session                   | 5 minutes to 24 hours                |
| `withdrawDelaySeconds` | Grace for the seller to claim after a buyer-forced close | 900 to 3600; 900 when omitted        |

`request.maxAtomic` still limits each question, and a question can't exceed the
session's remaining unreserved funds. The protocol fee and treasury always come
from `PROTOCOL_FEE`; the seller can't change them.

Start the chat:

```sh
pnpm buyer:chat
```

The header shows the session limits, similar to the following:

```text
Session deposit limit: 1000000 atomic units
Maximum per question: 10000 atomic units
Type /settle to close the channel, or /exit to leave settlement to the seller.
```

After each answer the chat prints the **approved** usage, for example
`Approved this question: 42; cumulative: 42 of 1000000 atomic units; settlement pending.`
An approval is a signed voucher, not a finalized on-chain charge.

- `/settle` asks the seller to close and prints the charge and refund only from
  finalized chain evidence. If the channel is already closed, it reads that
  evidence without the seller. Missing proof stays pending.
- `/exit` closes the local connection. The seller's worker keeps the channel and
  settles it later.
- `/new` clears the conversation only. It sends nothing, closes no channel and
  changes no spending authority.

A free signed quote still runs on the free path and builds no payment backend,
even when a session policy is present.

### Renewal and spending authority

With one seller, the buyer can open a replacement channel when the old one is
closed, expired or can't reserve the next quote. It first verifies the new
quote, closes the old channel if needed and proves its final charge and refund.
Missing or uncertain proof blocks renewal. Renewal never replays a failed
inference or changes the seller or payment roles.

`depositAtomic` is the total spending authority across renewals: earlier actual
charges plus the next deposit can't exceed it, so a replacement deposit shrinks
by those charges. There is no automatic top-up. A question whose ceiling exceeds
the remaining authority is refused before any channel opens. The journal keeps
at most 16 closed generations within its 512 KiB bound; at that limit renewal is
refused.

### Multiple sellers and shared authority

Add `totalDepositAtomic` to the `session` policy to let the buyer keep channels
with several sellers. `depositAtomic` stays the deposit for each new seller
channel; `totalDepositAtomic` is the authority all of them share. For example, a
deposit of `"100000"` and a total of `"200000"` can fund two sellers. Without
`totalDepositAtomic` the buyer keeps one channel; it never infers a larger
authority from the candidate list.

- The normal selector picks the seller. Going A → B → A reuses A's original
  channel and cumulative total, also after a buyer restart.
- All channels share the buyer wallet, buyer NodeId, network and asset. A seller
  whose owner, payment keys, network, asset or terms change can't replace its
  old channel.
- There are at most 16 channels, including retained closed ones. At most two
  requests run at once, on different sellers; each channel runs one request at a
  time.
- Committed authority is each allocated deposit minus its verified refund. An
  idle, expired, opening or uncertain channel still holds its full deposit.
  Refunds are credited once and survive restarts.
- Lowering the total below what is committed blocks new use; recovery and
  closure under the original terms still work.
- `/settle` tries every seller and reports an aggregate only when every proof
  exists. One offline seller can't fake a total or stop the others from closing.

An uncertain request on any channel blocks new free and paid requests across all
sellers until recovery resolves it. A single-seller journal from before
`totalDepositAtomic` was set is adopted in place and counted first; it is never
moved or overwritten. A renewed single-seller journal can't join a multi-seller
catalog; that import fails closed to protect spending authority.

## Conversations and streaming

### Terminal conversation history

`pnpm buyer:chat` keeps confirmed user and assistant turns in memory and sends
the whole conversation with each question. It keeps an answer only after the
stream ends with a valid terminal and EOF; partial text is provisional. A cut or
uncertain result ends the chat, and the prompt is never resent. Nothing is
written to disk, and a restart starts with an empty history.

Every earlier turn is input again, so you pay its input tokens again. The
session avoids a new deposit, not that cost. The conversation must fit:

- the terminal's 64,000-byte limit for the whole history plus the new question;
- the session's 64 KiB content bound, 1024 messages and 128 output tokens;
- the model's context and the signed quote's budget.

Input that doesn't fit is rejected before sending, never trimmed. The chat then
suggests `/new`. Without a session, `pnpm buyer:chat` accepts one user turn per
paid question.

Control queries and receipt exchanges have their own admission and don't hold a
generation slot. Neither the answer nor the next question waits for receipt
storage, and a receipt failure never retries the prompt.

### Streaming

The seller streams ordered text fragments and ends with one terminal that
carries the complete text. Streaming API callers receive fragments as the engine
produces them. Complete-response callers read and verify the same stream without
publishing fragments. The terminal's text must equal all fragments, and EOF is
required before the buyer approves usage. Frames, total bytes and the number of
events are bounded, and every wait uses the request's original deadline.

Cancelling before a verified terminal creates no new approval. It stops
publication, aborts generation and keeps any pending financial intent. Once
verified usage is durably approved, cancelling can't revoke it; recovery only
resends that original approval.

### Block checkpoints

When both peers support block checkpoints and the model's tokenizer has
certified safe boundaries, the session approves usage block by block during a
response:

1. The seller sends a certified prefix of about 64 output tokens. A first block
   also covers the input usage and must fit the signed request ceiling and the
   remaining deposit.
2. The buyer verifies the prefix and durably signs its cumulative total before
   the seller sends the next block. These signatures submit no transaction.
3. Settlement stays one final operation over the highest accepted voucher; the
   unused deposit returns to the buyer.

This bounds the unpaid exposure to one outstanding block, not to a fixed amount.
A tokenizer without certified boundaries uses one approval for the whole result.
A cumulative voucher is not a usage receipt; see [receipts.md](receipts.md) for
receipts.

### Tools

With a payment session, the buyer endpoint supports tools on a priced offer, as
it does on a free one. The shared inference package validates capabilities,
keeps system, history and tool turns, and measures the result; the buyer
verifies the whole result before signing. Tool definitions and results count
toward the input bound, and tool-call output counts toward tokens even when the
text is empty. The API client runs the tools, never the node, the chat or the
desktop app.

Per-request paid refuses tool requests before opening a payment: it can't safely
bill arguments held until the terminal without a buyer acknowledgement.

## Buyer routing

### Free or paid by signed quote

`pnpm buyer` (the buyer endpoint) and `pnpm buyer:chat` (which starts its own
buyer) share one buyer runtime. Before it chooses how to execute, the buyer
verifies discovery, the owner–NodeId binding, public-record replay protection,
selection and the signed quote. Then the quote decides:

| Signed prices   | Required quote budget | Execution                                                    |
| --------------- | --------------------- | ------------------------------------------------------------ |
| Both `"0"`      | `maxAtomic: "0"`      | Free channel, with the seller's free caps and replay checks  |
| Either positive | Positive `maxAtomic`  | Paid: a payment session if configured, otherwise per-request |

The configured `request.maxAtomic` is a spending ceiling, not a paid-mode
switch: a positive ceiling also accepts a free offer. The chosen executor
receives the same verified winner and signed quote and never selects again.
Routing adds no free-first preference and no reasoning downgrade.

A paid request also needs a recountable model on the seller
(`SELLER_PAID_METERING_UNRECOUNTED` otherwise) and a devnet payment RPC
(`BUYER_PAYMENT_NETWORK_MISMATCH` otherwise).

Selection errors:

- `SELLER_PRICE_ABOVE_BUDGET`: a seller offers the model at an acceptable
  reasoning level, but every listing costs more than `request.maxAtomic` or
  `priceCeilings`. Raise those limits in `selection.json`. A `maxAtomic` of
  `"0"` admits only free listings, and `pnpm buyer:free` always uses a zero
  budget.
- `PINNED_SELLER_REJECTED`: the pinned seller failed a check, including price.
- `NO_SELLER_CANDIDATES`: no eligible seller offers the model, whatever the
  budget.

Free execution loads no payment signer, paid tokenizer or payment RPC and
creates no journal, deposit or settlement. It still reads payment state: an
unresolved payment, unsafe state or another process's payment lock blocks free
calls too. The buyer never clears or takes over a lock to run a free call.

The buyer endpoint requires its private bearer token on every request, because
it can spend. Tools use separate [bounded API keys](buyer-api-keys.md). A
completed JSON or SSE reply carries `gyblos_execution` (`free` or `paid`), and
only a paid reply carries `gyblos_payment`. A paid completion without payment
information is never reported as a free success.

One deadline and one seller-exclusion set cover the whole request. An attempt
proven unsent may move to another seller, even across free and paid. A possibly
sent prompt, delivered text, remote failure or uncertain authorization is never
retried. Routing never stores prompts or answers.

### When the selected seller is busy

The optional `routing` object in `selection.json` sets what happens when the
chosen or pinned seller is busy. It doesn't change the initial ranking, and the
buyer reads it at startup:

```json
{
  "routing": {
    "onBusy": "reroute",
    "allowPinnedFallback": false,
    "allowHigherPriceFallback": false,
    "queueWaitMs": 30000
  }
}
```

| Field                      | Default   | Meaning                                                             |
| -------------------------- | --------- | ------------------------------------------------------------------- |
| `onBusy`                   | `reroute` | `reroute` to another seller, `reject` with busy, or `wait` in queue |
| `allowPinnedFallback`      | `false`   | Let `reroute` replace a pinned seller                               |
| `allowHigherPriceFallback` | `false`   | Let a replacement cost more than the original quote                 |
| `queueWaitMs`              | `30000`   | Longest `wait`, from 1 to the 180,000 ms request deadline           |

Rerouting rules:

- A replacement's input and output prices must each be no higher than the
  original verified quote, unless `allowHigherPriceFallback` is true. Even then,
  it can't exceed the configured price ceilings or the per-request and total
  budgets. With the default rule, a free request can't become a paid one.
- A busy local seller's active quote is the price reference while it stays
  valid. An expired or missing reference returns busy instead of rerouting.
- Every alternative passes fresh identity, replay, model, reasoning, network,
  asset and quote checks.
- Rerouting ends before the first possible prompt write. A failed or partial
  write, a remote refusal or a lost response never sends the prompt elsewhere. A
  busy reply after the prompt was written is final.

A healthy request on seller A doesn't block seller B. If A becomes uncertain,
new requests stop; B finishes if its prompt was already sent and is cancelled
otherwise. Settlement and reconciliation refuse while requests are active.

### Waiting for the selected seller

`onBusy: "wait"` never reroutes:

- It admits at most one waiter per seller, within the buyer's two-request total.
  Two running calls leave no queue slot; one running call on A can have one
  waiter. Waiting adds no HTTP, Iroh, engine or financial capacity.
- A waiter holds no connection and no new reservation. The queue, including its
  input, lives only in memory and is never restored or replayed after a restart.
- The wait ends on disconnect, cancellation, uncertainty, shutdown or
  `queueWaitMs`, whichever comes first; the caller's own deadline can end it
  sooner. Waiters are served first-in, first-out.
- After admission the buyer gets a fresh quote from the same seller and repeats
  identity, freshness, model, reasoning and budget checks. The original quote's
  prices still bound it unless higher prices are allowed. No deposit or request
  authorization starts while the request is queued.
- If the seller stays busy, control-only polls share the original wait deadline.
  A failure other than busy ends the call; it never changes sellers or retries a
  prompt.

## Lifecycle

1. **Prepare.** The buyer sends its full terms to the seller, which confirms it
   supports the session and agrees to every field (deposit, expiry, withdrawal
   grace, treasury, fee). A mismatch fails before any opening signature. The
   reply performs no financial operation.
2. **Open.** The buyer persists the opening hints and salt, then signs one
   capped deposit with a zero voucher; nothing is charged in advance. The buyer
   signs the session terms into the opening memo: both wallets and NodeIds,
   network, asset, payout, fee payer, authorizer, fee split, deposit and expiry.
3. **Reserve.** For each request the seller verifies the funded channel and
   reserves the request's ceiling. Request identifiers are single-use, and each
   channel runs one request at a time.
4. **Execute and bill.** The seller measures delivered usage through the common
   execution lifecycle and saves a bill with the charge and the new cumulative
   total.
5. **Approve.** The buyer verifies the usage and prices, persists the approved
   bill, then signs the cumulative voucher. The seller verifies and persists the
   voucher before it acknowledges. Only that acknowledgement allows the next
   request; a lost acknowledgement resends the same approval, never the prompt.
6. **Close.** Admissions freeze at the highest accepted voucher. The seller's
   fee payer submits the cooperative refund, or seals a buyer-forced closing
   channel within its grace, and the unused deposit returns to the buyer. Both
   sides confirm the resulting transaction and amounts independently before they
   mark the journal closed.

Closing can take several transactions; answers themselves need none.

## What closes a channel

Time passing never runs a transaction by itself. Normal closure uses the highest
voucher the seller already accepted; it asks for no new buyer signature. The
seller's authorizer signs the close and its fee payer pays for it.

| Trigger                                                        | Actor and result                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer requests close (`/settle`)                               | The seller authorizes and submits finalization. Active executions finish first.                                                                                       |
| Terms expire                                                   | The online seller worker finalizes the latest accepted total. If both parties are offline, nothing is submitted until one returns.                                    |
| Deposit is fully approved                                      | The seller worker finalizes; the refund is zero. There is no automatic top-up.                                                                                        |
| Ten minutes idle with at least 10,000 atomic units accrued     | The seller worker finalizes. The threshold is a soft default, not an extra charge.                                                                                    |
| Interrupted or unsigned work becomes idle                      | The seller finalizes the previous accepted total, even below the threshold. A runtime lease stops a live generation from counting as abandoned.                       |
| Retained request limit reached with no active or unsigned work | The seller finalizes before the record outgrows its bound.                                                                                                            |
| Buyer forces a close on chain                                  | The buyer signs and pays that transaction. An online seller can still claim during the grace, 900 seconds by default.                                                 |
| Recovery after a crash                                         | The seller resumes its saved finalization. The buyer can resend original messages, or seal and distribute after the grace if the seller is gone, paying its own fees. |
| An opening expired and was proved never created                | No settlement and no refund: the unfunded reservation is released.                                                                                                    |

The defaults (10-minute idle, 10,000-unit threshold, 15-second worker tick) live
in `BATCH_SESSION_DEFAULTS` in `packages/config/src/batch-session.ts`. The
threshold is not a measured break-even point or a minimum charge. Explicit
closure, an exhausted deposit, the request-record bound, expiry, a buyer-forced
close and an abandoned unsigned response all bypass it. The seller pays normal
finalization fees and fronts rent from its fee payer.

For a deposit D and a verified gross charge C, the buyer receives D − C. The
payout address and the Gyblos treasury share C with the fee split frozen at
opening ([Protocol fee](payments.md#protocol-fee)).

Shutting down the buyer or seller, an HTTP disconnect or switching from seller A
to B doesn't close a channel by itself. A seller that stays offline through the
whole forced-close grace can lose signed earnings it never claimed.

## Failure and persistence boundaries

- Journals are private (0700 directories, 0600 files), size-bounded, atomically
  replaced and process-locked in the role's payment directory. They hold the SDK
  pending operations and the highest voucher, never prompts, answers or keys.
- The seller rejects unknown SDK fields, oversized openings (8 KiB) and an
  invalid initial buyer proof before it persists a remote opening.
- A failed write poisons that journal handle; an ambiguous state is never
  cleared to proceed.
- If the buyer vanishes before approving the final response, the seller can
  collect only the previous signed total: the exposure is one request, or one
  block with block checkpoints.
- A remote status is metadata. A remote close reply becomes proof only after the
  buyer's own chain observation.
- Every buyer startup mode (free, per-request, single session and multi-seller)
  first takes the same buyer-home ownership guard. Only one application may own
  a buyer home; running an older binary on the same financial state is
  unsupported.
- These protections need the seller worker online within the withdrawal grace.
  They don't cover long simultaneous outages or a restored old backup.

Recovery steps, including `pnpm buyer:withdraw:paid` for session channels, are
in [recovery.md](recovery.md#reusable-batch-recovery).

## Upgrading and downgrading

Keep both peers on the same release, and never delete a journal or lock to
downgrade.

- A renewed buyer journal uses private journal version 3. Versions 1 and 2 stay
  readable and keep their format until renewal; older binaries can't read a
  renewed journal.
- Block checkpoints use a private record version 2. Resolve any pending version
  1 record before upgrading, and don't downgrade while a version 2 session is
  active. The record stores hashes, usage and financial metadata only.

## Wire and code

- Wire: the session channel is ALPN `gyblos/session/4`, and block checkpoints
  use `gyblos/session/5`. One bidirectional stream carries one request and
  reply; the operations are `prepare`, `open`, `execute`, `approve`, `snapshot`
  and `close`. The [wire specification](../packages/protocol/SPEC.md) owns the
  formats.
- Admission: endpoint connection and rate limits and request quotas apply before
  the session's own one-call budget. The seller's worker belongs to the
  financial service, not the connection, so closing the buyer's connection
  doesn't stop settlement.
- Trust: hosts supply identity, catalog, request and budget verification and
  finalized-chain observers as trusted ports, never as callbacks from discovery.
  They verify the RPC genesis before providing chain signers. Mainnet terms are
  refused.
- Code:
  [Reusable payment session composition](architecture.md#reusable-payment-session-composition)
  lists the owning modules.

Not provided: concurrent requests inside one channel, automatic rotation or
top-up, rollback defense for a restored journal, and validation on a live
network or the deployed program.

## Related

- [Payments](payments.md)
- [Recovery and reconciliation](recovery.md)
- [Known limitations](limitations.md)
- [Bounded buyer API keys](buyer-api-keys.md)
