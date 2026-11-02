# PayPal Sandbox inference prototype

This local prototype connects one PayPal Sandbox merchant to the pinned Gyblos
Ollama engines. The buyer approves a USD 1.00 sandbox authorization and may
request up to ten bounded inferences for USD 0.10 each. When the buyer closes
the session, the seller captures the accumulated amount once, or voids the
authorization if no usage was recorded. These are demonstration prices, not a
token-based price. An authorization is a hold, not a completed payment. This is
a sandbox demonstration, not the existing x402 protocol or a live multi-seller
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
**Settings → Payment method**, select **PayPal Sandbox** and return to **Chat**.
Selecting a method does not create an order. Create a session, open PayPal,
approve with the sandbox buyer, and return to the app to start the session. Use
Chat or connect an agent as described below; close the session explicitly when
finished to settle it. In the built-in Chat, each message is independent; the
agent supplies its own conversation context. The selection lasts until the
desktop app closes; its payment journal persists separately. No live PayPal
endpoint is used. The optional `PAYPAL_SANDBOX_OLLAMA_ORIGIN` setting chooses a
different literal loopback Ollama origin.

For a chat-only walkthrough, approve the USD 1.00 limit, send two messages, and
close the session. The expected capture is USD 0.20; the unspent authorization
is released according to PayPal's timing. Create a new session before the
OpenCode walkthrough.

Keep Gyblos open while its PayPal checkout is open. If leaving the app, close
the checkout tab first; a local return address can be reused by another process
after Gyblos exits. The USDC preview offers **Review PayPal session** after a
restart. Do not use a checkout tab opened before restarting: its local return
address belonged to the previous process. If the order was already approved,
select **I approved · start session**; the app checks PayPal directly. Otherwise
abandon the un-authorized order and create a new one. Existing sessions can be
reviewed and settled while Ollama is unavailable; creating a session requires at
least one of the configured models to be ready.

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
embedding the key.

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
export PI_CODING_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gyblos-pi.XXXXXXXX")"
```

On Windows PowerShell, create a unique directory under your user profile:

```powershell
$env:PI_CODING_AGENT_DIR = Join-Path $env:LOCALAPPDATA ('gyblos-pi-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $env:PI_CODING_AGENT_DIR -ErrorAction Stop | Out-Null
```

Keep its contents private and check the directory's permissions on a shared
computer.

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
Chat. If the app restarts, settle the old session if its state permits, then
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
content through these fields. The agent configuration declares an 8,192-token
context and a 512-token output maximum. The engine has a 90-second generation
timeout, and a session allows at most 30 attempts, even when the spending limit
has not been reached.

The separate browser demonstration is still available with
`pnpm paypal:sandbox`. It prints a private local session link; do not share that
link. Its optional `PAYPAL_SANDBOX_PORT` setting chooses a local port. Do not
run two processes using the same state directory at the same time.

The session accepts new messages for 30 minutes after authorization, but the
buyer must explicitly close it; leaving the page does not capture or void it.
Closing a partially used session captures the recorded usage. PayPal controls
the timing of release of any remaining hold, and an authorization can expire or
be revoked before capture.

The journal stores payment IDs, the approved currency and prices, accumulated
cents, phase, and digests of requests and optional idempotency keys, not prompts
or responses. It takes an exclusive process lock. If the configured terms
change, an unfinished session does not resume under different prices or limits.
An unacknowledged chat response blocks further chat and agent inference as well
as settlement. A completed agent inference does not require acknowledgment. An
interrupted inference, lost acknowledgment, uncertain payment, or storage
failure can block the session; do not remove the journal or lock to bypass this
state. There is no automatic payment reconciliation UI. A previous unfinished
single-request journal also blocks a new session. An order that has not been
authorized may be abandoned from the page. A crash can still lose a response or
its acknowledgment; when the page has received a response, it can retry
acknowledgment without charging twice. A buyer who receives a response but
withholds acknowledgment can block settlement, including earlier usage.
Acknowledgment does not prove delivery exactly once. The prompt digest can be
checked against guesses by anyone able to read the private journal. This
prototype is not safe for live money or distribution.
