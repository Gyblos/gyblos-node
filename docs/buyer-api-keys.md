# Buyer API keys

A buyer API key lets a client such as a coding agent use your local buyer with a
lifetime spending limit. Two credentials are involved:

- The **operator token** is the local buyer's private credential. The desktop
  app keeps it in its main process. Only the operator can create or revoke keys,
  and it must never be given to a tool.
- A **delegated key** (`gyb_...`) is what you give a client. The buyer enforces
  its spending limit itself, independently of the app.

You create and manage keys in the [desktop app](desktop.md). Keep the app and
its local buyer running while a client uses a key.

## Create a key

1. In **Payments**, check that the local buyer is running. The app starts its
   own buyer; use **Retry local buyer** or **Connect a running buyer** if it is
   not.
2. Open **Connections**.
3. Choose **Create your first API key** or **New API key**, then enter a
   **Name** and a **Limit for this key** in the displayed asset. A limit of `0`
   allows free models only.
4. Choose **Create API key**.
5. Copy the **API key** and the **Base URL** shown for the key.

The app can copy a new key only during the session that created it. A key's
limit has no automatic reset and cannot be raised later; create a new key for
more spending. A buyer holds at most 32 keys. A key whose limit is `0` shows
**Free only**. The key field reveals the secret only while the user asks for it
(**Show API key**); hiding it, selecting another key or revoking it clears the
visible value. The secret never enters status replies, saved agent configuration
or chat history, and after a restart the app cannot display it again.

The app's own buyer listens on the fixed loopback port `4033`
(`packages/config/src/hosts.ts`), so its Base URL survives restarts. If the port
is taken, startup fails and **Payments → Retry local buyer** tries again; the
app never picks another port. A separately running buyer that the user connects
explicitly keeps its own Base URL. Configurations written by versions that used
a changing port must be copied or written again once.

Clients send the key as a bearer token to the Base URL:

```sh
curl "$BASE_URL/models" -H "Authorization: Bearer $GYBLOS_API_KEY"
```

Replace `BASE_URL` with the Base URL shown in **Connections**, and set
`GYBLOS_API_KEY` to the copied key.

The supported interfaces are OpenAI Chat Completions, OpenAI Responses and
Anthropic Messages, including text history and streaming. Tool requests need a
compatible seller and execution policy. The buyer rejects unsupported options
before it sends the prompt. Listing models needs the key but does not consume
its limit.

## Connect a coding agent

1. In **Connections**, open **Details** for an active key.
2. Choose **Connect a tool**.
3. Pick the **Tool**: OpenCode, pi, Codex CLI or Claude Code.
4. Review the generated configuration, then choose **Write configuration**, or
   copy it.
5. Choose **Copy API key** and set `GYBLOS_API_KEY` in the shell that starts the
   agent.

The app reads `GET /v1/models` from the same local buyer and configures every
model it serves, with its output limit. That list is the buyer's configured
routes, not every model on the network. An empty, invalid or unavailable list
stops setup; no model is invented.

What the generated configuration does:

- It references `GYBLOS_API_KEY` and never contains the key itself.
- Preview and copy use the same generators as `pnpm buyer:agent`. Codex uses the
  Responses interface with HTTP and stream retries off.
- **Write configuration** uses the CLI's atomic writer. It preserves other
  settings, keeps the first `.before-gyblos` backup, creates new files as
  private, and keeps an existing symlink as a link.
- Codex gets its provider in `config.toml` plus one managed profile file per
  model beside it; the preview names those files.
- Claude Code is configured through shell environment variables, so its
  configuration is copy-only.
- Each model keeps the context size the authenticated buyer reports. Without
  one, the configuration falls back to 8,192 context tokens and at most 4,096
  output tokens, or the buyer's lower output limit
  (`packages/node/src/agent-setup-constants.ts`). Codex profiles carry this
  limit so compaction starts earlier. The fallback is not a verified seller
  capacity: the buyer lowers `max_tokens` to fit the chosen seller, and a
  conversation that does not fit gets a full-context error
  (`context_length_exceeded`, or `prompt is too long` in the Anthropic format)
  so the tool compacts it ([running-a-node.md](running-a-node.md)).

No extra inference server starts. Switching models uses the same buyer, key and
limits.

## Automatic seller selection from a checkout

The desktop app sets Auto in **Usage & payments → Limits → Manage chat budget**.
From a checkout, `pnpm buyer:auto` sets the same buyer policy. Use the same
`GYBLOS_HOME` as the buyer that serves your coding tool, give the maximum input
and output prices in USDC per million tokens, then restart the buyer:

```sh
pnpm buyer:auto 0.052 0.208
```

The buyer needs open discovery with no pinned or configured seller, a channel
policy and a positive per-response limit. `pnpm buyer:auto off` returns Auto to
free offers only; restart the buyer afterwards.

## Errors a client sees

| Code                      | HTTP | Meaning                                                                 |
| ------------------------- | ---- | ----------------------------------------------------------------------- |
| `BUYER_KEY_LIMIT_REACHED` | 400  | The key's remaining limit cannot cover this request; nothing was sent   |
| `BUYER_KEY_REVOKED`       | 403  | The key was revoked; nothing was sent                                   |
| `BUYER_KEY_NEEDS_REVIEW`  | 503  | An earlier paid request on this key has an uncertain outcome; see below |

A refusal for local validation, such as input that does not fit the model's
context, leaves the key usable; it is not an uncertain payment.

## Authority and accounting

Only the operator may create or revoke keys, through `/v1/gyblos/api-keys`. Each
change must send the currently displayed buyer policy in `If-Match`. Delegated
keys and browser-origin requests cannot reach key management.

The limit is in atomic units, bound to the buyer wallet, network and asset.
Revocation stops new work and keeps all recorded consumption and unresolved
reservations. A new key is a separate permission; it does not erase another
key's obligations.

Before preparing a payment, the buyer:

1. Validates the selected model, network, input and tokenizer. The input must
   fit the model context and the request's byte allowance, including JSON
   escapes and space for authorization. Reusable sessions also recheck quote
   freshness, buyer binding, deposit policy and worst-case input budget.
2. Limits the signed quote's ceiling to the smaller of its configured request
   cap and the key's remaining allowance.
3. Durably reserves the verified quote maximum before dispatch, so concurrent
   requests cannot reserve the same allowance.
4. On a known completion, records the verified amount and releases only the
   unused reservation, before it delivers the response.

What counts against a key:

| Execution                | Consumes                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable session request | Each verified request approval, once. The session's cumulative approval and deposit are not key usage; the app shows approved usage apart from settled payments |
| Free                     | Zero                                                                                                                                                            |
| Failover proven unsent   | Zero; its reservation is released                                                                                                                               |
| Uncertain paid outcome   | The reservation stays held                                                                                                                                      |

Buyer policy, price ceilings, wallet and payment-session safeguards still apply.
A key does not allocate wallet funds or replace session collateral. Other
configured free models do not prevent a compatible paid request. Desktop Chat
has its own budget and does not consume a delegated key.

## Persistence and interruption

The buyer saves only a digest of each delegated key, with content-free counters
and unresolved request bindings, in an owner-only permission ledger. The ledger
has a single-process lock and durable writes. It stores no prompts, responses or
signed payments. After a restart, keys keep their limits and usage, and a
configured client keeps working with the same key.

An interrupted paid reservation, a failed write or an inconsistent state fails
closed. Unknown reservations also block operator inference and the creation of
new keys. Revocation stays available and does not clear an obligation. The buyer
checks the matching channel for finalized settlement at startup and on the next
request. Checks start immediately and again at two and six seconds, with a
ten-second deadline. A single abandoned reservation can be released or charged
its attributable amount when the settlement matches the private usage records.
Older reservations without an execution digest require proof of zero charge.
Missing or conflicting proof keeps spending paused for both Desktop and coding
tools. The buyer operator can request another check from Payments. A status
check cannot fund a replacement or resubmit the original prompt.

> **Warning:** Never delete the permission ledger or its lock to resume
> spending, and never restore an older copy. Doing so erases recorded
> obligations, and the buyer cannot tell that spending authority was rolled
> back.
