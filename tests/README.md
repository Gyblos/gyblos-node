# Offline regression tests

The offline regression suites and their public fixtures are versioned and run
with `pnpm test`. The suite uses synthetic inputs, ephemeral unfunded signers,
mocked RPC/container process creation and temporary files; it requires no funded
wallet, Ollama, Docker, Python or devnet funds. Node discovers
`tests/**/*.test.ts` directly; there is no entrypoint allowlist. Case modules in
`tests/support/` are explicitly registered by those entrypoints.

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
for connection retirement and admission. The egress-expiry case retains unread
receive handles and stalls only its own loopback UDP return path to create real
native write backpressure. An owned buyer subprocess is paused with `SIGSTOP`
before it can recover via IPv6, then resumed and terminated during cleanup. That
single process-control case explicitly skips outside macOS/Linux. A passthrough
observer forwards the original native write and finish promises without
replacing or delaying them. Warm-up waits for native finish to settle and a
subsequent event-loop turn before sending the next request; write completion
alone does not establish that the peer slot is free. It advances JavaScript
`Date.now` across an admission window to fill the binding's send buffer within
two per-peer quotas; native clocks and ingress/egress timers remain real. Seven
other incomplete streams keep the remaining slots occupied while expiry closes
the stalled connection and a healthy peer uses its released slot. This is
simulated return-path loss with an unread receiver, not proof that non-reading
alone exhausts this SDK's buffers or a physical-network measurement.

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
