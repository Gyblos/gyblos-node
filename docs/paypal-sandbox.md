# PayPal Sandbox inference prototype

This local prototype connects one PayPal Sandbox merchant to the pinned Gyblos
Ollama engine. The buyer approves a USD 1.00 sandbox authorization and may
request up to ten independent, bounded inferences for USD 0.10 each. When the
buyer closes the session, the seller captures the accumulated amount once, or
voids the authorization if no response was acknowledged. These are demonstration
prices, not a token-based price. An authorization is a hold, not a completed
payment. This is a sandbox demonstration, not the existing x402 protocol or a
live multi-seller marketplace. It does not collect a platform fee.

## Setup

Use Node 22+, the pinned pnpm version, and a local Ollama server with Gyblos's
pinned `qwen3:0.6b` model. The engine verifies the model digest before serving.
Create a PayPal developer sandbox REST application and obtain its **sandbox**
client ID and secret. Use the sandbox personal account as the buyer and the
sandbox business account associated with the application as the seller. Never
put credentials or sandbox account passwords in Git, screenshots, or chat.

Choose an empty dedicated absolute directory for sandbox state. In a private
terminal, set `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, and
`PAYPAL_SANDBOX_STATE_DIRECTORY`, then run `pnpm paypal:sandbox` and open the
printed private session link. Do not share it: it grants access to the local
demo. Create a session, approve it with the sandbox buyer, return to start the
session, and send messages. Close the session to settle it. Each message is
independent: previous messages are not passed to the engine as conversation
context. No live endpoint is used. Optional `PAYPAL_SANDBOX_PORT` and
`PAYPAL_SANDBOX_OLLAMA_ORIGIN` settings select a different local port and
literal loopback Ollama origin.

For example, in a private macOS zsh terminal, from this repository:

```sh
read -r 'PAYPAL_SANDBOX_CLIENT_ID?Sandbox client ID: '
read -rs 'PAYPAL_SANDBOX_CLIENT_SECRET?Sandbox secret: '
print
export PAYPAL_SANDBOX_CLIENT_ID PAYPAL_SANDBOX_CLIENT_SECRET
export PAYPAL_SANDBOX_STATE_DIRECTORY="$HOME/Library/Application Support/Gyblos/paypal-sandbox"
pnpm paypal:sandbox
```

The secret is not echoed. Reuse the same state directory on later runs: it is
needed to preserve unresolved payment attempts. Use sandbox credentials only.

The session accepts new messages for 30 minutes after authorization, but the
buyer must explicitly close it; leaving the page does not capture or void it.
Closing a partially used session captures the acknowledged usage. PayPal
controls the timing of release of any remaining hold, and an authorization can
expire or be revoked before capture.

The journal stores payment IDs, accumulated cents, phase, and a temporary prompt
digest, not prompts or responses. It takes an exclusive process lock. Each
response must be acknowledged before another inference or settlement. An
interrupted inference, lost acknowledgment, uncertain payment, or storage
failure can block the session; do not remove the journal or lock to bypass this
state. There is no automatic reconciliation or recovery UI. A previous
unfinished single-request journal also blocks a new session. An order that has
not been authorized may be abandoned from the page. A crash can still lose a
response or its acknowledgment; when the page has received a response, it can
retry acknowledgment without charging twice. A buyer who receives a response but
withholds acknowledgment can block settlement, including earlier usage.
Acknowledgment does not prove delivery exactly once. The prompt digest can be
checked against guesses by anyone able to read the private journal. This
prototype is not safe for live money or distribution.
