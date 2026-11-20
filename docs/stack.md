# Gyblos Node technology stack

What this repository runs on, why each piece was chosen, and when to use Rust
instead of TypeScript. Exact versions are pinned in each `package.json`; the
versions below are the ones to expect when you read the code. Decisions behind
these choices are summarized in [public-decisions.md](public-decisions.md).

## At a glance

| Layer          | Technology                                                                                              | Version                            | Why                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Language       | TypeScript (strict), Node.js                                                                            | TS 5.9, Node ≥ 24.22.1             | One language across payments, buyer, seller and lab; the x402 and Solana SDKs are TypeScript |
| Workspace      | pnpm workspaces                                                                                         | pnpm 10                            | A simple monorepo with no build orchestrator                                                 |
| Payments       | x402 reusable channels                                                                                  | batch-settlement                   | Deposit once per seller and approve cumulative usage.                                        |
| Chain          | Solana devnet (`@solana/kit`, `@solana-program/token`), LiteSVM for offline program tests               | kit 5.1.0, litesvm 1.6.2           | Fast, cheap settlement; payment channels from the x402 SVM scheme                            |
| P2P transport  | Iroh (`@number0/iroh`)                                                                                  | 1.1.0                              | Connect to a public key behind home NAT, QUIC, end-to-end encryption, relay fallback         |
| HTTP           | Express (loopback x402 HTTP seller, lab facilitator), Node `http` (buyer endpoint)                      | express 4.22.3                     | Loopback-only servers with Host validation                                                   |
| Inference      | Ollama, OpenAI-compatible servers and the Anthropic API as `Engine` adapters; `@huggingface/tokenizers` | tokenizers 0.2.0                   | The seller picks its engine; the buyer recounts tokens with a public tokenizer               |
| Workers        | Hono on Cloudflare Workers with D1 and Drizzle (`apps/discovery-index`, `apps/metrics-collector`)       | hono 4.13.13, drizzle-orm 0.45.2   | Small public services with SQL storage and no servers to run                                 |
| Desktop app    | Electron, React, Vite                                                                                   | electron 45.0.0, react 19.2.0      | One cross-platform app that bundles the local buyer                                          |
| Web            | Next.js with Fumadocs (`apps/docs`), Next.js (`apps/explorer`), Tailwind CSS                            | next 16.4.5, fumadocs-core 16.17.9 | A static bilingual docs site and a server-rendered explorer                                  |
| Telemetry      | OpenTelemetry metrics SDK (`packages/telemetry-otel`)                                                   | sdk-metrics 2.12.0                 | An optional exporter for content-free aggregate metrics                                      |
| Quality        | ESLint, Prettier, Node test runner with `tsx`, dependency-cruiser                                       | eslint 9.39.1, prettier 3.9.10     | Typecheck, lint, boundaries and offline tests on every change                                |
| Security scans | Semgrep CE, Gitleaks ([static-analysis.md](static-analysis.md))                                         | semgrep 1.183.0                    | Repository-specific rules and secret scanning on every pull request                          |

## Why Iroh

Iroh identifies every device by an Ed25519 key and dials that key, not an IP.
Peers first meet through a relay, then try a direct UDP path (hole punching).
When a direct path is not possible, traffic stays on the relay, which cannot
read it. That lets a seller on a home connection sell without opening ports,
which is central to Gyblos. The alternatives considered were libp2p (heavier,
and public relays cut long streams), a Mainline DHT with IP and port (excludes
home sellers), Hyperswarm and outbound tunnels.

The relay is a meeting point and a fallback, not a mandatory hop. Peers use it
to exchange addresses and coordinate hole punching; once a direct path works,
data flows peer to peer. Traffic stays on the relay only when a direct path
fails (strict NAT, CGNAT, some mobile networks). Relays are stateless and
replaceable.

The Iroh library is free and open source (MIT or Apache-2.0). Gyblos runs its
own `iroh-relay` at `na1.relay.gyblos.com`, open to every client and bounded by
per-client rate limits. The public n0 relays are not used. See
[running-a-node.md](running-a-node.md#relays).

Limits that matter here:

- A direct connection reveals each peer's IP to the other. Relay-only mode hides
  it from the other peer, not from the relay.
- One relay (`na1`) is configured by default.
- The JavaScript binding is narrower than the Rust crate: `@number0/iroh` 1.1.0
  exposes no DHT, pkarr or gossip API and has no Intel Mac build.

Iroh docs: [what is iroh](https://docs.iroh.computer/what-is-iroh) ·
[NAT traversal](https://docs.iroh.computer/concepts/nat-traversal) ·
[relays](https://docs.iroh.computer/concepts/relays) ·
[address lookup](https://docs.iroh.computer/concepts/address-lookup) ·
[security and privacy](https://docs.iroh.computer/concepts/security-privacy)

## When to use Rust

TypeScript is the default. Most latency is network round-trips and model
inference, not CPU, so rewriting for speed alone rarely pays off. Use Rust for a
component when at least one of these holds:

1. **The feature only exists natively.** Iroh's Mainline DHT address lookup and
   `iroh-gossip` are Rust crates without TypeScript bindings; seller discovery
   over a DHT is the first candidate.
2. **It runs continuously on user devices.** A node daemon on laptops or phones
   benefits from a small binary, low memory and battery use, and direct
   embedding through Iroh's Swift and Kotlin bindings.
3. **A measured hotspot.** A profiler shows a CPU-bound path (for example
   signature verification or token counting at scale) where Rust gives a clear
   multiple, not a guess.

A Gyblos Rust component runs as a separate sidecar process using JSON-RPC over
stdio or a Unix socket. TypeScript re-verifies the signed envelopes it returns;
the sidecar receives neither keys nor payment headers, and payments stay in
TypeScript. This rule does not replace third-party native bindings such as the
Iroh SDK.

## Identity and limits

The 8004 identity adapter is described in [identity.md](identity.md). What
Gyblos does not do or has not proven, including decentralized discovery, is in
[limitations.md](limitations.md).
