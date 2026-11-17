# PayPal Sandbox prototype

This local prototype connects one PayPal Sandbox merchant to the pinned Gyblos
Ollama engines. In the desktop app, the buyer approves a USD 1.00, 5.00 or 10.00
Sandbox authorization and pays USD 0.10 per inference. When the buyer ends the
session, the seller captures the accumulated amount once, or voids the
authorization if nothing was used.

An authorization is a hold, not a completed payment. The prices are fixed
demonstration prices, not token-based. The prototype uses one local seller, is
separate from the x402 payment paths and the network marketplace, and collects
no platform fee.

> **Warning:** Use PayPal Sandbox credentials and test accounts only; Sandbox
> transactions use simulated money. The prototype is not exactly-once and is not
> safe for live money or distribution. No live PayPal endpoint is used.

## Prerequisites

- The Node.js and pnpm versions pinned in `package.json`; see the
  [toolchain setup guide](../CONTRIBUTING.md#set-up-nodejs-and-pnpm).
- [Ollama](https://ollama.com/download) with its local server running; the agent
  adapter needs Ollama 0.20.0 or later. The prototype uses
  `http://127.0.0.1:11434/` unless you set `PAYPAL_SANDBOX_OLLAMA_ORIGIN` to
  another literal loopback origin.
- A
  [PayPal developer account and Sandbox REST app](https://developer.paypal.com/api/get-started/),
  with its **Sandbox** client ID and secret. Use the app's Sandbox business
  account as the seller and a separate Sandbox personal account as the buyer;
  PayPal's
  [Sandbox accounts guide](https://developer.paypal.com/sandbox-testing/accounts)
  shows how to find or create both.

Never put credentials or Sandbox account passwords in Git, screenshots or chat.

## Set up

1. From the repository root, install dependencies and the models for the flows
   you want to try:

   ```sh
   pnpm install --frozen-lockfile
   ollama pull qwen3:0.6b
   ollama pull gpt-oss:20b
   ollama list
   ```

   Chat uses `qwen3:0.6b` (about 523 MB) and checks its pinned digest:
   `ollama list` should show an ID that starts with `7df6b6e09427`. Connected
   agents use the tool-capable
   [`gpt-oss:20b`](https://ollama.com/library/gpt-oss:20b), an approximately 14
   GB download that Ollama says can run with 16 GB of memory. Either model works
   without the other, but the one a flow needs must be ready before you create a
   session for it.

2. Choose an empty, dedicated absolute directory for Sandbox state. Reuse it on
   every later run: it preserves unresolved payment attempts.

3. Close any running desktop app, so the new one inherits your settings. Settle
   or keep any open session first.

4. In a private macOS or Linux terminal (zsh or bash), set the credentials and
   state directory, then start the desktop app:

   ```sh
   printf 'Sandbox client ID: '
   read -r PAYPAL_SANDBOX_CLIENT_ID
   printf 'Sandbox client secret: '
   read -rs PAYPAL_SANDBOX_CLIENT_SECRET
   printf '\n'
   export PAYPAL_SANDBOX_CLIENT_ID PAYPAL_SANDBOX_CLIENT_SECRET
   if [ -z "${PAYPAL_SANDBOX_STATE_DIRECTORY:-}" ]; then
     printf 'Absolute sandbox state directory (reuse it on later runs): '
     read -r PAYPAL_SANDBOX_STATE_DIRECTORY
   fi
   export PAYPAL_SANDBOX_STATE_DIRECTORY
   pnpm desktop:start
   ```

   The secret is not echoed.

## Start a session

Each completed **agent** inference records USD 0.10 before it returns, even if
delivery fails. One instruction can need several inferences, for example when
the agent calls a tool, and an inference already dispatched can finish and count
after the agent disconnects. Check the limit you approve with that in mind.

1. In **Payments**, select **PayPal Sandbox** and choose a session limit.
   Selecting a method creates no order.
2. Choose **Continue with PayPal** and approve with the Sandbox buyer in the
   system browser.
3. Return to Gyblos. A matching checkout return makes the app verify the order
   with PayPal and start the session. If the return doesn't arrive, choose
   **Check approval and start session**. If you cancelled the checkout, abandon
   that unapproved order before you create a new session.
4. Use **Chat**, or [connect an agent](#connect-an-agent).

The session accepts new messages for 30 minutes after authorization. Leaving the
page neither captures nor voids it.

In the built-in Chat, each PayPal message is independent: earlier messages are
not sent to the model. An agent supplies its own conversation context. One
conversation and draft are kept when you switch between the USDC preview and
PayPal Sandbox; the method applies only to later sends. The selection lasts
until the desktop app closes, and its payment journal persists separately.

## End the session

1. In **Payments**, choose **End session**. A native confirmation shows the
   recorded amount.
2. Confirm to capture that amount, or to void an unused authorization.
   Cancelling leaves the session open.

PayPal decides when any remaining hold is released, and an authorization can
expire or be revoked before capture. If the session status is unavailable, check
it before you continue.

For a chat-only walkthrough, approve the USD 1.00 limit, send two messages and
end the session. The expected capture is USD 0.20. Create a new session before
you connect an agent.

## Connect an agent

After a session starts, open **Connections**, set **API key spend limit · USD**
and choose **Create API connection**. Gyblos shows a loopback API URL, a
temporary API key and `gpt-oss:20b`. Pick OpenCode, Pi, Codex or Claude Code for
its configuration. All four share the authorization. Disconnecting revokes the
shared connection, refuses new requests and waits for any inference already
dispatched to finish; a new connection gets a different key. Never publish the
connection URL, key or local settings.

These PayPal keys are ephemeral and local to this desktop's Sandbox session.
They are not the persistent USDC [buyer API keys](buyer-api-keys.md).

### API key spending limit

Each generated key gets its own total budget, in USD 0.10 steps, up to the
remaining approved session budget. All tools and API formats that use the key
share its cap. Chat doesn't count against the key, but chat and agents both
consume the same approved PayPal session. **Connections** shows the key limit,
its recorded usage and remaining budget apart from the session amounts.

- The host checks the cap right before each inference, inside the serialized
  session operation. Invalid, duplicate and cancelled-before-dispatch requests
  add no usage.
- At the cap, requests return `PAYPAL_KEY_LIMIT_REACHED` with retry disabled;
  model discovery still works. Session exhaustion, expiry or uncertain
  accounting can block requests sooner.
- The cap is fixed for the key's lifetime and never resets. To use a different
  budget, disconnect, wait for in-flight requests to finish and create a new
  key; the old key is revoked. Reconnecting, polling or copying can't raise an
  exhausted key.

### Standard API access

**Connections** shows masked API key and Base URL fields, each with a copy
action; copying doesn't reveal the key. The tool configuration includes the
selected model. **Other tools** opens a Chat Completions example that reads
`GYBLOS_API_KEY` from the environment. Viewing or copying an example never runs
it; running it can spend the session's shared limit. The listener is local to
this computer, and Gyblos must stay open.

### OpenCode

This recipe uses OpenCode's V1 provider format; other versions may need the
standard API details instead. Merge the copied configuration into the project's
`opencode.json` rather than overwriting it. It makes Gyblos the project's
default model and turns off automatic titles. Keep this file and its loopback
URL out of Git. The configuration reads `{env:GYBLOS_API_KEY}`, so set the key
privately before you start OpenCode. In zsh or bash:

```sh
printf 'Gyblos API key: '
read -rs GYBLOS_API_KEY
printf '\n'
export GYBLOS_API_KEY
opencode
```

In PowerShell, enter the key without saving it in the shell history:

```powershell
$gyblosKey = Read-Host 'Gyblos API key' -AsSecureString
$gyblosBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($gyblosKey)
try {
  $env:GYBLOS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($gyblosBuffer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($gyblosBuffer)
  Remove-Variable gyblosKey, gyblosBuffer
}
```

The variable stays in that terminal, and its child processes can read it, until
the terminal closes.

Tool schemas support minimum string length, minimum array length and anchored
literal prefixes such as `^ses` (ASCII letters, digits, underscores or hyphens
after `^`). Other patterns are rejected before inference. The host checks these
constraints on the model's tool calls; an invalid result after dispatch blocks
the session for review.

### Pi

Create a new, private Pi agent directory and select it with
`PI_CODING_AGENT_DIR`. In bash or zsh:

```sh
if PI_CODING_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gyblos-pi.XXXXXXXX")"; then
  export PI_CODING_AGENT_DIR
  printf 'Pi directory: %s\n' "$PI_CODING_AGENT_DIR"
else
  unset PI_CODING_AGENT_DIR
  printf 'Could not create the Pi directory. Stop here.\n' >&2
fi
```

In Windows PowerShell, create it under your user profile:

```powershell
$gyblosPiDir = Join-Path $env:LOCALAPPDATA ('gyblos-pi-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $gyblosPiDir -ErrorAction Stop | Out-Null
  $env:PI_CODING_AGENT_DIR = $gyblosPiDir
} catch {
  Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
  Write-Error 'Could not create the Pi directory. Stop here.'
}
Remove-Variable gyblosPiDir
```

If creation fails, stop before saving files or starting Pi. Then:

1. Save the copied Pi model configuration as `models.json` and the copied Pi
   settings as `settings.json` in that directory. The isolated directory
   inherits no existing Pi configuration, credentials or extensions.
2. Set `GYBLOS_API_KEY` as shown for OpenCode.
3. Start Pi and select `gyblos/gpt-oss:20b`.

The supplied settings turn off automatic retry, compaction and cache warming,
which would otherwise send extra charged requests. Project-specific Pi settings
can override them; check before you start a paid session. Pi's estimated token
price can't express USD 0.10 per inference, so read the actual amount from the
session usage in Gyblos. Keep the directory private on a shared computer.

### Codex CLI

Merge the copied Codex provider configuration into your user-level
`~/.codex/config.toml` or a dedicated profile, without overwriting other
settings; Codex ignores provider definitions in project-level configuration. Set
`GYBLOS_API_KEY` before you start Codex.

The configuration uses the Responses API, turns off provider retries and limits
the agent to text tools: web search, image viewing and multi-agent tools are
off. Codex developer messages reach Ollama as system messages. The adapter
reports token usage as unavailable, because the engine doesn't supply the cache
and reasoning breakdown, so Codex can't measure its context: keep tasks short.
The local model can produce invalid tool arguments or ask for permissions;
Codex's own approval rules still apply.

### Claude Code

Open a new, dedicated terminal, set `GYBLOS_API_KEY`, then run the copied
environment settings (bash/zsh or PowerShell) in that terminal. They last until
the terminal closes and don't affect your other terminals. A bounded starting
point is:

```sh
claude --bare --tools default --append-system-prompt 'Use only required tool parameters unless explicitly needed.'
```

This is an experimental Anthropic-format gateway to the local `gpt-oss:20b`
model, not a Claude model. Anthropic doesn't support routing Claude Code to
non-Claude models through a gateway. The adapter accepts a bounded
text-and-tools subset; images, thinking blocks and unsupported tool schemas are
rejected before inference.

## Limits and API compatibility

| Session limit | Attempts allowed (failed attempts count) |
| ------------- | ---------------------------------------- |
| USD 1.00      | 30                                       |
| USD 5.00      | 70                                       |
| USD 10.00     | 120                                      |

- The agent configuration declares a 16,384-token context and a 512-token output
  maximum, shared by instructions, tools, conversation and output. The engine
  times out a generation after 90 seconds. A larger context uses more memory and
  time.
- The endpoint accepts bounded subsets of Chat Completions, Responses and
  Anthropic Messages. Most unsupported fields are rejected before inference. It
  accepts but ignores Anthropic cache hints and metadata, Responses cache keys,
  client metadata, `reasoning.summary: auto` and requests for encrypted
  reasoning; it returns no cached tokens or reasoning content.
- Streaming responses are buffered until the complete result and its usage are
  recorded.
- An optional `Idempotency-Key` per operation rejects a repeat of a completed
  inference within the same session, also after a restart. Without a key, an
  identical normalized request in the same session is rejected, which can block
  an intentional repeat and can't catch every changed retry. This is not
  exactly-once, and tool execution follows the client's own permissions outside
  this deduplication.
- After you copy a new configuration from **Connections**, apply it yourself;
  existing client settings don't update.

## Browser demonstration

A separate browser demonstration uses a USD 1.00 authorization:

```sh
pnpm paypal:sandbox
```

It prints a private local session link; don't share it. It listens on port 8765
unless `PAYPAL_SANDBOX_PORT` sets another port. Don't run two processes on the
same state directory at once.

## What the journal stores

The private journal keeps payment IDs, the approved currency and prices,
accumulated cents, the phase, and digests of requests and idempotency keys. It
never stores prompts or responses, although anyone who can read it can test the
prompt digest against guesses. It takes an exclusive process lock. If the
configured terms change, an unfinished session doesn't resume under the new
prices or limits.

These states block the session until resolved:

- an unacknowledged chat response, which blocks chat, agent inference and
  settlement (a completed agent inference needs no acknowledgement);
- an interrupted inference, a lost acknowledgement, an uncertain payment or a
  storage failure;
- an unfinished earlier single-request journal.

A buyer who receives a chat response but withholds the acknowledgement can block
settlement, including earlier usage. When the page has received a response, it
can retry the acknowledgement without charging twice. Don't remove the journal
or lock to get past any of these states.

## Troubleshooting

### After a restart

Keep Gyblos open while its checkout is open; if you leave the app, close the
checkout tab first, because another process can reuse the local return address
after Gyblos exits.

1. Open **Payments** and select **PayPal Sandbox** to see the preserved session.
   Use **Check session status** if needed; it creates or retries no order.
2. Don't use a checkout tab opened before the restart. If the order was already
   approved, choose **Check approval and start session**. Otherwise abandon the
   unauthorized order and create a new one.
3. A restored session can be reviewed and settled while Ollama is down, but it
   can't connect agents. Settle it and create a new session to connect one.

If you update the agent model, settle the session and restart Gyblos before you
create another; the running process pins the model digest.

### A start that stops for review

The checkout return is only a local signal. Before authorizing, Gyblos checks
the order, request reference, intent, amount and currency with PayPal. A missing
or contradictory answer stops the flow, and the journal blocks new orders until
you reconcile it. Another authorized merchant client could still change the
order between that check and the authorization, so don't modify the order from
another client while a session starts.

### An interrupted void or inference

- For an interrupted void, the desktop app can check the exact order and
  authorization with PayPal without retrying a payment. A confirmed void doesn't
  prove there was no earlier partial capture, and the check doesn't change the
  journal or unblock the session.
- For an interrupted inference with earlier recorded usage, the desktop app
  offers a manual review. An operator authorized for both parties can waive the
  uncertain attempt and confirm capture of the recorded usage in a native
  dialog. The app checks the order and authorization with PayPal, archives the
  decision privately (session snapshot, request digests, decision and capture
  result; no prompts or responses), then attempts one final capture. A failed or
  ambiguous step stays blocked and isn't retried. It can't reconcile a capture
  that was dispatched and lost its response, and an external merchant client can
  still race its checks.
- An operator can also record, in a private review archive, an acceptance that
  earlier capture history is unknown. A recovered void record links to that
  archive, and the journal seals the session if the archive is missing or
  inconsistent. Its digest detects inconsistencies but is no PayPal signature,
  and it isn't evidence that no earlier capture happened.

Don't downgrade while a session is in review: older versions don't recognize the
review phase or the archive marker and fail closed.

### Searching Sandbox transactions

The desktop app's void check doesn't query Transaction Search. To look up the
Sandbox history yourself, enable **Transaction search** on the same Sandbox REST
app in PayPal Developer. A reporting request needs an OAuth token with the
`https://uri.paypal.com/services/reporting/search/read` scope; if PayPal returns
an older token without it, request a token scoped to Transaction Search, keep it
private and use it only for reporting. Such a token may not authorize Orders or
Payments requests.

Search results can be delayed and reference fields can be missing. An empty
result, or a voided authorization alone, doesn't prove that no partial capture
happened. Keep an uncertain session blocked until it is reconciled.

## Adapter contract

Code that calls `@gyblos/payments-paypal` directly must pass the same order ID
and request ID to `isApproved` and `authorize`. A successful approval check
reserves a private, single-use token for that pair; an authorization without a
matching check fails before any payment request.

## Related

- [Desktop app](desktop.md)
- [Bounded buyer API keys](buyer-api-keys.md)
- [Known limitations](limitations.md#prototypes)
