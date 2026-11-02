# Simulated paid startup acceptance

Run `pnpm acceptance:paid` with Node 24.22.1+ and the pinned pnpm version. This
is a verification command, not an operational buyer or a payment demonstration.
It accepts no arguments, real home, RPC, index, wallet, engine or network
overrides. A failed or unsupported native run is not successful acceptance.

The command allocates disposable private role homes and an
environment-allowlisted child. It starts the actual seller and paid buyer, an
in-process discovery index, a local synthetic 8004 registry and native encrypted
Iroh over loopback with relays disabled. The seller receives a deterministic
recounted engine through an explicit factory port; its default engine registry
and pinned artifacts remain unchanged. The real upto client, server, offline
signing/verifier, seller ledger and buyer journal run over a synthetic chain. No
payment RPC or facilitator client is constructed, and no transaction is
broadcast. This does not validate mainnet, USDC transfer, rent/SOL costs,
production RPC finality, real tokenization or model performance.

Coverage includes complete and streamed answers, refusal before prompt
transmission, discard of an unsent authorization, independent settlement-share
checks, clean role restarts, persistent uncertainty, explicit receipt
confirmation and recovery of a pending seller claim exactly once. Engine failure
and cancellation do not repeat the prompt; the next request remains blocked when
its prior payment is uncertain. A delivered answer can carry an `unverified`
payment verdict; delivery is not proof that accounting has been verified.
Confirmation uses the buyer's recorded expected charge and the independent
simulated chain, never a journal reset or another inference call.

The final JSON contains only fixed phase names, simulation flags and aggregate
counters. No prompts, answers, identities, paths, authorizations or signatures
are printed. Product outcome records stay private and content-free inside
temporary homes. Local free usage receipts and their free-only collector are
separate from paid settlement receipts; this command does not submit to that
collector.

The harness lives in verification support (`tests/support/paid-acceptance-*`),
where the independent payment SDK is permitted; product and lab modules never
import it. The shared lab native binding advertises only the ALPNs requested by
product startup. There is no boundary exception or alternate paid production
path.

## Buyer experience and demo boundary

The existing `pnpm buyer` entry starts a local OpenAI-compatible endpoint and
chooses the configured free or paid flow. It is a service launcher, not yet an
interactive terminal chat. The paid startup currently restricts the model,
reasoning and network to its supported subset and devnet. The acceptance command
prints evidence rather than chat content; it must not be presented as real paid
inference. A buyer-facing chat command should reuse this endpoint and show both
the answer and economic verdict, including uncertainty, without retrying a sent
prompt. That user interface is separate work; seller and desktop wiring are not
changed here.

Buyer bearer authentication is maintained separately. On versions that provision
an API token the harness reads only its freshly created private token and sends
it to the owned loopback endpoint. Passing this scenario is not an independent
authentication audit. Real-engine, two-machine, live-registry and paid
operational demos require their own authorized runs.
