# Technology stack

What this repository runs on, why each piece was chosen, and when to use Rust
instead of TypeScript. Product decisions and research live in the Gyblos vault;
this file describes the code here.

## At a glance

| Layer | Technology | Version | Why |
|---|---|---|---|
| Language | TypeScript (strict), Node.js | TS 5.9, Node ≥ 22 | One language across payments, CLI, seller and web; the x402 and Solana SDKs are TypeScript |
| Workspace | pnpm workspaces | pnpm 10 | Simple monorepo without a build orchestrator (Turborepo deferred until measured) |
| Payments | x402 `upto` and `exact` (`@x402/core`, `@x402/svm`, `@x402/fetch`, `@x402/express`) | 2.28.0 | Pay per request with a signed spending ceiling; charge what was used and refund the rest |
| Chain | Solana devnet (`@solana/kit`, `@solana-program/token`, `@solana-program/system`) | kit 5.1.0 | Fast, cheap settlement; payment channels from the x402 SVM scheme |
| P2P transport | Iroh (`@number0/iroh`) | 1.1.0 | Connect to a public key behind home NAT, QUIC, end-to-end encryption, relay fallback |
| HTTP | Express (sellers, facilitator), Node `http` (buyer proxy) | 4.21.2 | Standard x402 middleware; loopback-only servers with Host validation |
| Inference | Ollama (local engine), `@huggingface/tokenizers` | tokenizers 0.2.0 | Real open-weight model; buyer recounts tokens with the public tokenizer |
| Lab | Docker Compose (non-root, read-only, no published ports) | — | Isolated buyer/seller roles and simulated NAT routers |
| Quality | ESLint, Prettier, Node test runner (`tsx`) | — | Typecheck, lint and offline regression tests on every change |

## Why Iroh

Iroh identifies every device by an Ed25519 key and dials that key, not an IP.
Peers first meet through a relay, then try a direct UDP path (hole punching);
roughly 9 in 10 networks allow it, otherwise traffic stays on the relay, which
cannot read it. That lets a seller on a home connection sell without opening
ports, which is central to Gyblos. Alternatives were libp2p (heavier, public
relays cut long streams), a Mainline DHT with IP:port (excludes home sellers),
Hyperswarm and outbound tunnels.

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

## Planned

Seller discovery (8004 identity, signed catalog and presence, several discovery
sources) is proposed and not built; see the vault decision on seller discovery.
