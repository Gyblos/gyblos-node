# Offline regression tests

The offline regression suites and their public fixtures are versioned and run
with `pnpm test`. The suite uses synthetic inputs, ephemeral unfunded signers,
mocked RPC/container process creation and temporary files; it requires no funded
wallet, Ollama, Docker, Python or devnet funds. Node discovers
`tests/**/*.test.ts` directly; there is no entrypoint allowlist. Case modules in
`tests/support/` are explicitly registered by those entrypoints.

Public discovery contract tests use ephemeral, unfunded Node/OpenSSL signers.
The committed `packages/protocol/vectors/public-discovery-v1.json` contains only
synthetic public keys, record bytes and signatures, with no retained private
keys. Golden tests verify each catalog/presence/withdrawal with Web Crypto and
an independent OpenSSL verifier. Strict JSON, trust, lifetime, sequence, linked
catalog, alias and size/amount rejection cases do not perform discovery or
register identities. The original private-offer vector/tests remain unchanged.

Paid-call diagnostic cases spawn the real CLI entrypoint using the asynchronous
Node test-loader API. Stubs replace only its direct readiness/payment ports;
locks, temporary persistence, classification and evidence filtering remain real.
Each owned child has a 15-second deadline, forced cleanup and a 64 KiB output
limit per stream. Tests forbid RPC and assert one simulated invocation, without
loading funded keys or authorizing another payment. Receipt and deposit hints
remain unverified when the full proof fails.

Native transport cases require the pinned native Iroh binding and IPv6 loopback
`[::1]`. Before registering those cases, the test helpers probe SDK loading and
an IPv6 loopback socket. Missing bindings or known IPv6 capability errors
produce an explicit per-case skip reason; unexpected import/socket errors fail
the suite. Role setup, proxy-handler and CLI recovery cases require the binding
but do not require IPv6. Other financial, lock, limiter and export cases keep
running. Report passed, failed, cancelled and skipped counts separately; skipped
native cases establish no transport result on that host.

Native fixtures use relay-disabled loopback endpoints and condition-based waits
for connection retirement and admission. The egress-expiry case holds the first
free loopback HTTP response until setup is complete, then stops only its owned
buyer child with `SIGSTOP`. This stops native ACKs on every IPv4/IPv6 path
before backpressure is prepared; no host firewall or relay is changed. The child
never reads response streams and is resumed and terminated during cleanup. This
one process-control case explicitly skips outside macOS/Linux.

Before releasing the HTTP response, test-only server-initiated unidirectional
streams occupy native connection send credit. Small reused 64 KiB writes and 512
KiB per-stream caps keep setup bounded; a real partial native write signals that
connection credit is exhausted. Setup fails explicitly at its deadline or 32 MiB
budget instead of retrying HTTP calls or assuming that 60 responses fill a
buffer. The
[Noq 1.0 window source reference](https://docs.rs/crate/noq-proto/1.0.0/source/src/config/transport.rs)
explains why acknowledged data on a recovered route can prevent the old setup
from filling send credit. Its
[receive-window shrink accounting](https://docs.rs/crate/noq-proto/1.0.0/source/src/connection/streams/state.rs)
does not retract credit already advertised. Setup assumes the pinned binding
allows more than 512 KiB per stream and eventually returns a partial write;
incompatible defaults fail setup explicitly. The observed HTTP write must
independently prove real backpressure.

The observed HTTP response is unchanged: its passthrough observer returns the
original native write promise without delaying, replacing or appending bytes. It
must stay blocked, then be cancelled by the real `egressMs` deadline and close
the connection. No fake clock or rate-window advance is used. Seven other
clients finish their handshakes before that interval; their incomplete ingress
streams occupy every other slot only halfway through it. A healthy peer must use
the released slot while all seven remain occupied. No inference or paid
execution occurs. This is controlled native send-credit exhaustion with a
stopped receiver, not proof that non-reading alone exhausts this SDK's buffers
or a physical-network measurement.

`tests/fixtures/finalized-payment-pair.json` contains selected public metadata
and parsed financial instructions from a saved finalized deposit/claim pair.
Transaction signatures and the decoded public channel-creation nonce support
original identity/PDA checks; that nonce is not a private measurement salt.
Current-account responses and unsigned mutated transaction variants are labeled
synthetic. Do not add encoded payment/voucher payloads, raw logs, credentials or
private endpoint/content data to the fixture.

Raw evidence, measurements, personal agent notes and internal documents remain
outside Git. Public tests, fixtures and documentation are tracked by default
subject to the privacy denylist; review new captures before staging. The
explicitly authorized, allowlisted redacted P2P reports
`lab/evidence/gate-0006.json`, `lab/evidence/gate-0007.json` and
`lab/evidence/gate-0008.json` are the evidence exceptions; never publish raw
role volumes, endpoint addresses, signed payment payloads or private content.
README and the operational guides describe public commands and limitations.
Private captures remain excluded; support case groups are registered through
discovered test entrypoints.

Node owns test registration promises; explicit `void test(...)` keeps
registration ordering and failure handling in the native harness. Product
floating promises remain errors. Deliberately invalid boundary data and partial
SDK doubles may use assertions in tests; product object-literal assertions are
rejected. Keep manual/private probes outside the discovered test tree.
