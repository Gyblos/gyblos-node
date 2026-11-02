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

1. Install the Node.js and pnpm versions pinned in `package.json`; see the
   [toolchain setup guide](../CONTRIBUTING.md#set-up-nodejs-and-pnpm). Install
   [Ollama](https://ollama.com/download) and start its local server.
2. From the repository root, install dependencies and download the model:

   ```sh
   pnpm install --frozen-lockfile
   ollama pull qwen3:0.6b
   ollama list
   ```

   The model download is about 523 MB. `ollama list` should show `qwen3:0.6b`
   with an ID beginning `7df6b6e09427`. The engine checks the full pinned digest
   before serving; a different model or digest will be rejected.

3. Create a
   [PayPal developer account and sandbox REST app](https://developer.paypal.com/api/get-started/)
   and obtain its **sandbox** client ID and secret. Use the associated sandbox
   business account as the seller and a separate sandbox personal account as the
   buyer. PayPal's
   [sandbox accounts guide](https://developer.paypal.com/sandbox-testing/accounts)
   explains how to find or create both accounts. Use test accounts only; sandbox
   transactions use simulated money.

Never put credentials or sandbox account passwords in Git, screenshots, or chat.

Choose an empty dedicated absolute directory for sandbox state. In a private
terminal, set `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, and
`PAYPAL_SANDBOX_STATE_DIRECTORY`, then start the desktop app with
`pnpm desktop:start`. First close any earlier desktop instance so the new one
inherits these settings; settle or preserve any open session before closing. In
**Settings → Payment method**, select **PayPal Sandbox** and return to **Chat**.
Selecting a method does not create an order. Create a session, open PayPal,
approve with the sandbox buyer, and return to the app to start the session and
send messages. Close the session explicitly to settle it. Each message is
independent: previous messages are not passed to the engine as conversation
context. The selection lasts until the desktop app closes; its payment journal
persists separately. No live PayPal endpoint is used. The optional
`PAYPAL_SANDBOX_OLLAMA_ORIGIN` setting chooses a different literal loopback
Ollama origin.

The USDC preview offers **Review PayPal session** after a restart. Do not use a
checkout tab opened before restarting: its local return address belonged to the
previous process. If the order was already approved, select **I approved · start
session**; the app checks PayPal directly. Otherwise abandon the un-authorized
order and create a new one. Existing sessions can be reviewed and settled while
Ollama is unavailable; creating a session or requesting inference requires the
pinned local model.

The USDC chat and Connect views are previews. A PayPal authorization is not a
wallet top-up or a conversion to USDC. This demonstration uses one local seller
and does not send paid requests to the network marketplace.

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
needed to preserve unresolved payment attempts. Use sandbox credentials only.
For a quick walkthrough, create a session and approve the USD 1.00 limit in
PayPal. Return to the demo, select **I approved · start session**, and send two
messages, waiting for each response to be acknowledged. Select **Close session
and settle**. The expected final capture is USD 0.20; the unspent authorization
is released according to PayPal's timing.

The separate browser demonstration is still available with
`pnpm paypal:sandbox`. It prints a private local session link; do not share that
link. Its optional `PAYPAL_SANDBOX_PORT` setting chooses a local port. Do not
run two processes using the same state directory at the same time.

The session accepts new messages for 30 minutes after authorization, but the
buyer must explicitly close it; leaving the page does not capture or void it.
Closing a partially used session captures the acknowledged usage. PayPal
controls the timing of release of any remaining hold, and an authorization can
expire or be revoked before capture.

The journal stores payment IDs, the approved currency and prices, accumulated
cents, phase, and a temporary prompt digest, not prompts or responses. It takes
an exclusive process lock. If the configured terms change, an unfinished session
does not resume under different prices or limits. Each response must be
acknowledged before another inference or settlement. An interrupted inference,
lost acknowledgment, uncertain payment, or storage failure can block the
session; do not remove the journal or lock to bypass this state. There is no
automatic payment reconciliation UI. A previous unfinished single-request
journal also blocks a new session. An order that has not been authorized may be
abandoned from the page. A crash can still lose a response or its
acknowledgment; when the page has received a response, it can retry
acknowledgment without charging twice. A buyer who receives a response but
withholds acknowledgment can block settlement, including earlier usage.
Acknowledgment does not prove delivery exactly once. The prompt digest can be
checked against guesses by anyone able to read the private journal. This
prototype is not safe for live money or distribution.
