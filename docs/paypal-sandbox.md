# PayPal Sandbox inference prototype

This local prototype connects one PayPal Sandbox merchant to the pinned Gyblos
Ollama engines. In Desktop, the buyer selects a USD 1.00, 5.00 or 10.00 sandbox
authorization and may request bounded inferences for USD 0.10 each. The separate
browser demonstration uses USD 1.00. When the buyer closes the session, the
seller captures the accumulated amount once, or voids the authorization if no
usage was recorded. These are demonstration prices, not a token-based price. An
authorization is a hold, not a completed payment. This is a sandbox
demonstration, not the existing x402 protocol or a live multi-seller
marketplace. It does not collect a platform fee.

## Setup

1. Install the Node.js and pnpm versions pinned in `package.json`; see the
   [toolchain setup guide](../CONTRIBUTING.md#set-up-nodejs-and-pnpm). Install
   [Ollama](https://ollama.com/download) and start its local server.
2. From the repository root, install dependencies and the models needed for the
   flows you want to try. The
   [agent model](https://ollama.com/library/gpt-oss:20b) is an approximately 14
   GB download; Ollama notes it can run on systems with 16 GB of memory, subject
   to the available hardware and workload:

   ```sh
   pnpm install --frozen-lockfile
   ollama pull qwen3:0.6b
   ollama pull gpt-oss:20b
   ollama list
   ```

   Chat uses `qwen3:0.6b` (about 523 MB) and checks its full pinned digest;
   `ollama list` should show an ID beginning `7df6b6e09427`. Connected agents
   use the tool-capable `gpt-oss:20b`, which is substantially larger. The agent
   adapter requires Ollama 0.20.0 or later. Either model can be used without the
   other, but the relevant one must be available before creating a session
   intended for that flow.

3. Create a
   [PayPal developer account and sandbox REST app](https://developer.paypal.com/api/get-started/)
   and obtain its **sandbox** client ID and secret. Use the associated sandbox
   business account as the seller and a separate sandbox personal account as the
   buyer. PayPal's
   [sandbox accounts guide](https://developer.paypal.com/sandbox-testing/accounts)
   explains how to find or create both accounts. Use test accounts only; sandbox
   transactions use simulated money.

Never put credentials or sandbox account passwords in Git, screenshots, or chat.
Before approving the sandbox authorization, note that each completed agent
inference records USD 0.10 even if delivery fails. One instruction may require
several inferences, and an already dispatched inference can finish and count
after the agent disconnects.

### Investigating an interrupted payment

The desktop's void check does not query Transaction Search or establish whether
an earlier capture occurred. If a separate operator investigation needs the
Sandbox transaction history, enable **Transaction search** on the same Sandbox
REST app in PayPal Developer. This grants the app access to that test account's
transaction history. An OAuth access token for the reporting request needs the
`https://uri.paypal.com/services/reporting/search/read` scope. If PayPal returns
an older token without that scope after the feature is enabled, requesting a
separate token explicitly scoped to Transaction Search may work; keep that token
private and use it only for reporting. A narrowly scoped reporting token may not
authorize Orders or Payments requests, which can require a separate token.

PayPal may delay transaction search results, and transaction reference fields
may be absent. An empty result, or a voided authorization alone, does not prove
that no partial capture happened. Keep an uncertain session blocked until it is
reconciled. This manual investigation does not make the desktop automatically
recover an interrupted void or authorize another Sandbox session.

For a separately approved, one-time Sandbox exception, a private review archive
can record an operator's acceptance that earlier capture history and external
operations are unknown. A recovered void record links to that archive, and the
journal seals the current session if its evidence is missing or inconsistent.
Older readers do not understand the marker and reject the record. Once another
session replaces the current journal, the archive remains on disk but is not
rechecked on later starts. A digest detects inconsistencies; it is not a PayPal
signature and does not protect against coordinated alteration of both files or
simultaneous loss during a restore. This exception is not an automatic recovery
flow or evidence that no earlier capture occurred.

Choose an empty dedicated absolute directory for sandbox state. In a private
terminal, set `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, and
`PAYPAL_SANDBOX_STATE_DIRECTORY`, then start the desktop app with
`pnpm desktop:start`. First close any earlier desktop instance so the new one
inherits these settings; settle or preserve any open session before closing.

For example, in a private macOS or Linux terminal using zsh or bash, from this
repository:

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

The secret is not echoed. Reuse the same state directory on later runs: it is
needed to preserve unresolved payment attempts. Use sandbox credentials only. In
**Payments**, select **PayPal Sandbox** and choose a session limit. Selecting a
method does not create an order. Choose **Continue with PayPal**, approve with
the sandbox buyer in the system browser, and return to Gyblos. A matching
checkout return prompts the app to verify the order with PayPal and start the
session automatically. If the return does not arrive, use **Check approval and
start session**. If the checkout is cancelled, abandon that unapproved order
before creating a new session. Use Chat or connect an agent as described below;
return to Payments and end the session when finished to settle it. In the
built-in Chat, one conversation and draft are retained when switching between
USDC preview and PayPal Sandbox. The method applies only to subsequent sends;
earlier usage is unchanged. Each PayPal message is still independent; previous
messages are not sent to the model. The agent supplies its own conversation
context. The selection lasts until the desktop app closes; its payment journal
persists separately. No live PayPal endpoint is used. The optional
`PAYPAL_SANDBOX_OLLAMA_ORIGIN` setting chooses a different literal loopback
Ollama origin.

For a chat-only walkthrough, approve the USD 1.00 limit, send two messages, and
end the session in Payments. The expected capture is USD 0.20; the unspent
authorization is released according to PayPal's timing. Create a new session
before the OpenCode walkthrough.

Keep Gyblos open while its PayPal checkout is open. If leaving the app, close
the checkout tab first; a local return address can be reused by another process
after Gyblos exits. After restarting, open **Payments** and select **PayPal
Sandbox** to inspect the preserved session. Use **Check session status** if
needed; reviewing the session does not create or retry an order. Do not use a
checkout tab opened before restarting: its local return address belonged to the
previous process. If the order was already approved, select **Check approval and
start session**; the app checks PayPal directly. Otherwise abandon the
un-authorized order and create a new one. Existing sessions can be reviewed and
settled while Ollama is unavailable; creating a session requires at least one of
the configured models to be ready. Restored sessions cannot connect agents, even
if an already approved order is started after a restart. Settle the session and
create a new one first.

The return page is only a local signal, not proof of payment approval. Before
authorization, Gyblos checks the matching order, request reference, intent,
amount and currency with PayPal. A missing or contradictory response stops the
flow for review, and the local journal blocks new orders until the situation is
reconciled. Another authorized merchant client could still change the order
between that check and the authorization request; the local journal does not
lock PayPal against external changes. Do not modify the order from another
merchant client while the session is starting.

Direct adapter consumers must pass the same order ID and request ID to
`isApproved` and `authorize`. A successful approval check reserves a private,
single-use token for that pair; an authorization without that matching check
fails before the payment request. This changes the earlier adapter contract.

The USDC chat and its Connect entries are previews. The PayPal Connect entry
provides the local agent integrations described below. A PayPal authorization is
not a wallet top-up or a conversion to USDC. This demonstration uses one local
seller and does not send paid requests to the network marketplace.

## Connect an agent

After starting a PayPal session, open **Connect** and choose **Create shared
local connection**. Gyblos displays a loopback API URL, a temporary API key and
`gpt-oss:20b`. Select OpenCode, Pi, Codex or Claude Code for the relevant
configuration. All four share the authorization and disconnecting revokes the
shared connection. Never publish the connection URL, key or local settings.

### OpenCode

Copy the OpenCode configuration into the project's `opencode.json`, merging it
with any existing configuration rather than overwriting it. The generated
settings select Gyblos as the project's default model and disable automatic
titles. Keep this local configuration and its loopback URL out of Git. Set the
key privately in the environment before starting OpenCode. For example, in a
private zsh or bash terminal:

```sh
printf 'Gyblos API key: '
read -rs GYBLOS_API_KEY
printf '\n'
export GYBLOS_API_KEY
opencode
```

The copied OpenCode configuration uses `{env:GYBLOS_API_KEY}` rather than
embedding the key. Enabled tool schemas support minimum string length, minimum
array length and anchored literal prefixes such as `^ses`, with ASCII letters,
digits, underscores or hyphens after `^`. Other patterns are rejected before
inference. These constraints are checked locally on the model's tool calls; an
invalid result after dispatch leaves the session blocked for review.

For PowerShell, enter the key without placing it in the shell history:

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

The environment variable remains in that terminal and is available to its child
processes until the terminal closes.

### Pi

Create a new, private Pi agent directory and select it with
`PI_CODING_AGENT_DIR`. Save the copied Pi model configuration as `models.json`
and the separately copied Pi settings as `settings.json` in that directory. This
isolated directory does not inherit existing Pi configuration, credentials or
extensions. The supplied settings disable automatic retry, compaction and cache
warming, which can otherwise generate additional charged requests. Set
`GYBLOS_API_KEY` as above and select `gyblos/gpt-oss:20b` in Pi. For example, in
bash or zsh, create a unique, private directory before starting Pi:

```sh
if PI_CODING_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gyblos-pi.XXXXXXXX")"; then
  export PI_CODING_AGENT_DIR
  printf 'Pi directory: %s\n' "$PI_CODING_AGENT_DIR"
else
  unset PI_CODING_AGENT_DIR
  printf 'Could not create the Pi directory. Stop here.\n' >&2
fi
```

On Windows PowerShell, create a unique directory under your user profile:

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

If creation fails, stop before saving files or starting Pi. Keep the directory's
contents private and check its permissions on a shared computer.

Pi's estimated token price cannot express this prototype's fixed USD 0.10 per
completed inference. Use the session usage shown in Gyblos for the actual
sandbox amount. Project-specific Pi settings may override agent-directory
settings; check them before starting a paid session.

### Codex CLI

Merge the copied Codex configuration into the trusted project's
`.codex/config.toml` and set `GYBLOS_API_KEY` before starting Codex. It uses the
Responses API, disables provider retries and restricts the local prototype to
text tools; web search, image viewing and multi-agent tools are disabled by the
generated configuration. Do not overwrite existing settings. Codex's developer
messages are sent to Ollama as system messages because the local engine does not
expose a separate developer role. The local model may produce invalid tool
arguments or request permissions; Codex's own approval rules still apply. The
Responses adapter reports token usage as unavailable because the engine does not
supply the required cache and reasoning breakdown. Codex cannot rely on this
usage field to measure context, so keep tasks short; long conversations may hit
the local context limit.

### Claude Code

Open a new, dedicated terminal, set `GYBLOS_API_KEY`, then run the copied
environment settings in that same terminal. Those settings persist in it until
it closes; using a dedicated terminal preserves the settings in your other
terminals. The connection provides separate bash/zsh and PowerShell copies; use
the one for your shell. A bounded starting point is:

```sh
claude --bare --tools default --append-system-prompt 'Use only required tool parameters unless explicitly needed.'
```

This is an experimental Anthropic-format gateway to the local `gpt-oss:20b`
model, not a Claude model. Anthropic states that routing Claude Code to
non-Claude models through a gateway is not supported by Anthropic. The adapter
supports a bounded text-and-tools subset; images, thinking blocks and
unsupported tool schemas are rejected before inference. Other Claude Code
settings and tools may require additional compatibility work.

### Session and safety

Keep Gyblos open; the key is local and scoped to this authorization, and a new
connection gets a different key. Disconnecting refuses new requests and waits
for any inference already dispatched to finish. Settle the PayPal session in
Payments. If the app restarts, settle the old session if its state permits, then
create a new one to connect an agent; it cannot silently attach a new model to
the old session. If the prior state needs review, do not retry payment or remove
its journal or lock to make a new session possible. If you update the agent
model, settle the current session and restart Gyblos before creating another;
the running process pins the model digest.

Each valid completed **agent inference** records USD 0.10 before returning the
result, even when delivery fails. One instruction can require multiple
inferences, for example when the agent calls a tool. Chat keeps its separate
response-acknowledgment policy. Both flows share the same approved maximum;
closing the session captures their recorded usage. Streaming responses are
buffered until the complete result and its usage have been recorded.

The endpoint accepts an optional `Idempotency-Key` per operation. Within the
same session, reusing a key for a completed inference is rejected without a
second inference. The private record preserves completed operations across a
restart, although Desktop does not reconnect an agent to a restored session. The
protection does not extend to new authorizations. For clients without a key, an
identical normalized request within the same session is conservatively rejected.
This can reject an intentional repeat and cannot detect every changed retry.
These clients do not necessarily provide a stable per-inference key; this is not
an exactly-once guarantee. Tool execution follows the client's own permissions
and is outside Gyblos's payment deduplication. The prototype supports bounded
subsets of Chat Completions, Responses and Anthropic Messages. Most unsupported
fields or capabilities are rejected before inference. To support the clients,
the adapter accepts but ignores Anthropic cache hints and metadata, as well as
Responses cache keys, client metadata, `reasoning.summary: auto` and the request
to include encrypted reasoning. It provides no cached tokens or reasoning
content through these fields. The agent configuration declares a 16,384-token
context and a 512-token output maximum. Instructions, tools, conversation and
output share that context. Larger contexts can use more memory and take longer;
the model and hardware determine whether a request completes. Configurations
copied before this change do not update automatically; copy and apply the
updated configuration when it is safe to do so. The engine has a 90-second
generation timeout. A session allows up to 30, 70 or 120 attempts for the USD
1.00, 5.00 or 10.00 limit respectively; failed attempts also count.

The separate browser demonstration is still available with
`pnpm paypal:sandbox`. It prints a private local session link; do not share that
link. Its optional `PAYPAL_SANDBOX_PORT` setting chooses a local port. Do not
run two processes using the same state directory at the same time.

The session accepts new messages for 30 minutes after authorization, but the
buyer must explicitly close it; leaving the page does not capture or void it. In
the desktop app, **Payments → End session** opens a native confirmation showing
the recorded amount. Confirming attempts to capture that amount, or void an
unused authorization. Cancelling leaves the session open. PayPal controls the
timing of release of any remaining hold, and an authorization can expire or be
revoked before capture. If the session status is unavailable, check it before
continuing.

The journal stores payment IDs, the approved currency and prices, accumulated
cents, phase, and digests of requests and optional idempotency keys, not prompts
or responses. It takes an exclusive process lock. If the configured terms
change, an unfinished session does not resume under different prices or limits.
An unacknowledged chat response blocks further chat and agent inference as well
as settlement. A completed agent inference does not require acknowledgment. An
interrupted inference, lost acknowledgment, uncertain payment, or storage
failure can block the session; do not remove the journal or lock to bypass this
state. For an interrupted authorization void, Desktop can check the exact order
and authorization with PayPal without retrying a payment. A confirmed void does
not prove that there were no earlier partial captures; the check does not verify
payment history, change the journal, or unblock the session. Desktop offers a
manual review for an interrupted inference when earlier usage is recorded. An
operator authorized for both parties may waive the uncertain attempt and confirm
capture of the recorded usage in a native dialog. The app checks the exact order
and authorization with PayPal, archives the local decision, then attempts one
final capture. Its private audit files retain the session snapshot, request
digests, decision and capture result; they contain no prompt or response. A
failed or ambiguous step stays blocked and is not retried automatically. This
flow cannot reconcile a capture that was already dispatched and lost its
response. The confirmation and local lease apply to Desktop and this adapter
instance only: an external merchant client can still race the provider checks.
The operator must ensure no other operation is in progress. The file writes do
not guarantee recovery from every power loss or incomplete restore, including
simultaneous loss of the journal update and audit files; it also does not scan
historical audit files for later loss or tampering. Do not treat this prototype
as exactly-once settlement. Older readers do not recognize a reviewed record's
marker and fail closed. The status check otherwise reads local state. A previous
unfinished single-request journal also blocks a new session. A CREATED order
that does not need review may be abandoned from the page. Older versions do not
recognize the REVIEW journal phase and cannot resume it. A crash can still lose
a response or its acknowledgment; when the page has received a response, it can
retry acknowledgment without charging twice. A buyer who receives a response but
withholds acknowledgment can block settlement, including earlier usage.
Acknowledgment does not prove delivery exactly once. The prompt digest can be
checked against guesses by anyone able to read the private journal. This
prototype is not safe for live money or distribution.
