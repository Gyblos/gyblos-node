# PayPal Sandbox inference prototype

This local prototype connects one PayPal Sandbox merchant to the pinned Gyblos
Ollama engine. The buyer approves a fixed USD 1.00 sandbox authorization for one
bounded inference. The seller generates the answer, then captures the payment.
This is a sandbox demonstration, not the existing x402 protocol or a live
multi-seller marketplace. It does not collect a platform fee.

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
demo. Enter a prompt, create an order, approve it with the sandbox buyer, return
to the page, and run inference. No live endpoint is used. Optional
`PAYPAL_SANDBOX_PORT` and `PAYPAL_SANDBOX_OLLAMA_ORIGIN` settings select a
different local port and literal loopback Ollama origin.

The journal stores payment IDs, phase, token limit and a prompt digest, not the
prompt or response. It takes an exclusive process lock. A payment or storage
failure that might have happened remotely blocks another attempt. Do not remove
the journal or lock to bypass this state; reconciliation and recovery UI are not
yet implemented. An order that has not been authorized may be abandoned from the
page. A disconnect before capture triggers a void; a disconnect observed during
capture triggers a refund after confirmed capture. Both remain blocked when
their result is uncertain. A crash or a later disconnect can lose the response
even if a capture succeeded. The prompt digest can be checked against guesses by
anyone able to read the private journal. This prototype is not safe for live
money or distribution.
