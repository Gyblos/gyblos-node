# Gyblos Node technology stack

What this repository runs on, why each piece was chosen, and when to use Rust
instead of TypeScript. Product decisions and research live in the Gyblos vault;
this file describes the code here.

## At a glance

| Layer         | Technology                                                                          | Version           | Why                                                                                        |
| ------------- | ----------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| Language      | TypeScript (strict), Node.js                                                        | TS 5.9, Node ≥ 22 | One language across payments, CLI, seller and web; the x402 and Solana SDKs are TypeScript |
| Workspace     | pnpm workspaces                                                                     | pnpm 10           | Simple monorepo without a build orchestrator (Turborepo deferred until measured)           |
| Payments      | x402 `upto` and `exact` (`@x402/core`, `@x402/svm`, `@x402/fetch`, `@x402/express`) | 2.28.0            | Pay per request with a signed spending ceiling; charge what was used and refund the rest   |
| Chain         | Solana devnet (`@solana/kit`, `@solana-program/token`, `@solana-program/system`)    | kit 5.1.0         | Fast, cheap settlement; payment channels from the x402 SVM scheme                          |
| P2P transport | Iroh (`@number0/iroh`)                                                              | 1.1.0             | Connect to a public key behind home NAT, QUIC, end-to-end encryption, relay fallback       |
| HTTP          | Express (sellers, facilitator), Node `http` (buyer proxy)                           | 4.21.2            | Standard x402 middleware; loopback-only servers with Host validation                       |
| Inference     | Ollama (local engine), `@huggingface/tokenizers`                                    | tokenizers 0.2.0  | Real open-weight model; buyer recounts tokens with the public tokenizer                    |
| Lab           | Docker Compose (non-root, read-only, no published ports)                            | —                 | Isolated buyer/seller roles and simulated NAT routers                                      |
| Quality       | ESLint, Prettier, Node test runner (`tsx`)                                          | —                 | Typecheck, lint and offline regression tests on every change                               |

## Why Iroh

Iroh identifies every device by an Ed25519 key and dials that key, not an IP.
Peers first meet through a relay, then try a direct UDP path (hole punching);
roughly 9 in 10 networks allow it, otherwise traffic stays on the relay, which
cannot read it. That lets a seller on a home connection sell without opening
ports, which is central to Gyblos. Alternatives were libp2p (heavier, public
relays cut long streams), a Mainline DHT with IP:port (excludes home sellers),
Hyperswarm and outbound tunnels.

The relay is a meeting point and a fallback, not a mandatory hop. Peers use it
to exchange addresses and coordinate hole punching; once a direct path works,
data flows peer to peer. Traffic stays on the relay only when a direct path
fails (strict NAT, CGNAT, some mobile networks). Relays are stateless and
replaceable.

Cost: the Iroh library is free and open source (MIT or Apache-2.0). The public
n0 relays used today are free but meant for development. In production we run
our own `iroh-relay` (free software, we pay only for the server) or use the
paid, optional Iroh Services relays, which bill relay connections and relay
egress but not direct peer-to-peer traffic.

Limits that matter here:

- A direct connection reveals each peer's IP to the other; relay-only mode hides
  it from the buyer, not from the relay.
- The public n0 relays are for development only (rate-limited, no SLA).
- The JavaScript binding is narrower than the Rust crate: `@number0/iroh` 1.1.0
  exposes no DHT, pkarr or gossip API and has no Intel Mac build.

Docs: [what is iroh](https://docs.iroh.computer/what-is-iroh) ·
[NAT traversal](https://docs.iroh.computer/concepts/nat-traversal) ·
[relays](https://docs.iroh.computer/concepts/relays) ·
[address lookup](https://docs.iroh.computer/concepts/address-lookup) ·
[security and privacy](https://docs.iroh.computer/concepts/security-privacy)

## When to use Rust

TypeScript stays the default. Most of our latency is network round-trips and
model inference, not CPU, so rewriting for speed alone rarely pays off. Use
Rust for a component when at least one of these holds:

1. **The feature only exists natively.** Iroh's Mainline DHT address lookup and
   `iroh-gossip` are Rust crates without TypeScript bindings today; seller
   discovery over a DHT is the first candidate.
2. **It runs continuously on user devices.** A node daemon on laptops or phones
   benefits from a small binary, low memory and battery use, and direct
   embedding through Iroh's Swift and Kotlin bindings.
3. **A measured hotspot.** A profiler shows a CPU-bound path (for example
   signature verification or token counting at scale) where Rust gives a clear
   multiple, not a guess.

Rust components stay small and sit behind a stable interface (a CLI, a local
socket or a binding), so the TypeScript code that handles payments does not
change. Payment logic stays in TypeScript next to the x402 SDK unless a
reviewed reason says otherwise.

## Identity (8004 agent registry)

`packages/identity` (`@gyblos/identity`) is an adapter for node identity on the
8004 Solana agent registry, devnet only, built on `@solana/kit` without Anchor or
an indexer. **Nothing in the node or apps calls it yet.**

- `buildSponsoredRegistration` builds one atomic transaction paid by a sponsor:
  an exact rent prefund to the owner (sized by `simulateOwnerSpend`), the
  registration, an owner-signed `gyblos.nodeId` metadata entry carrying the
  node key's signature over (program, asset, owner), and the payout wallet set
  with its Ed25519 proof. The owner can hold 0 SOL.
- `readNodeIdentity` (by asset or by owner) and `resolveOwner` (NodeId → owner)
  read chain accounts directly; ownership comes from the Core asset, and only
  bindings whose node signature verifies count, so a replayed binding on
  another asset is reported as invalid.
- The sponsor policy (`evaluateSponsorRules`, `decideSponsorship`,
  `recordSponsorship`) is pure: per-registration cap, total budget, one
  sponsorship per device key and per owner, then an injected online check.
  Ledger persistence and the real online check are future work.

Cost per sponsored node, measured on a local validator running the devnet
bytecode: about 12.5M lamports (12,544,640: agent PDA rent 6,096,960, Core
asset 3,226,080, nodeId metadata rent 3,201,600, fee 20,000), roughly US$1.35
at ~108 USD/SOL. It is mostly rent; only the metadata rent is refundable. The
transaction uses 1,172 of 1,232 bytes, so `agentUri` must stay short (about
100 bytes).

Risk: the 8004 program `8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C` is
upgradeable by a single wallet, `2KmHw8VbShuz9xfj3ecEjBM5nPKR5BcYHRDSFfK1286t`
(not a multisig), which also holds the registry authority. An upgrade could
silently change layouts or ownership checks. The golden tests pin real devnet
account bytes; treat 8004 as one signal verified by our own binding signature,
and keep the option to deploy our own instance (the deployment addresses live
in `@gyblos/config`).

## Planned

Seller discovery (signed catalog and presence, several discovery sources) is
proposed and not built; see the vault decision on seller discovery. The 8004
identity adapter above exists but is not wired into discovery.
