# Offline payment-channel program acceptance

The lab executes signed transactions from the installed, patched x402 SDK in
LiteSVM against a bundled SBF build of the official payment-channels program.
The mint, keys, SOL and token balances exist only inside each fresh VM. There is
no RPC client, network listener, live wallet or deployment in this fixture.

Run the ordinary lab gate, or just these cases:

```sh
pnpm install --frozen-lockfile
pnpm test:lab
node --import tsx --test tests/lab/paid-native.test.ts
```

Node and pnpm versions are pinned by the repository. LiteSVM is a pinned
**development dependency**; its native package must be available for the host.
Missing native support fails these tests rather than reporting acceptance. No
compiler, validator, Docker, funded wallet or real engine is needed to run the
bundled fixture.

## Scope

The cases execute SDK channel opening, a payer's signed close, metered claims,
sealing and distribution. They check actual native-program account transitions
and token balances, including the refund, seller share, Gyblos fee share and
separate program-treasury rounding dust. Channel and token-account bytes are
never seeded or rewritten to fabricate a transition; mint/ATA setup also uses
signed transactions. Only VM funding and Clock are initialized by the harness.

Voucher and closing-grace boundaries are tested immediately before, exactly at
and immediately after their deadlines. The VM inclusion clock can advance
**after** successful SDK checks and simulation, independently from local time.
This distinguishes native rejection of late inclusion from a local SDK refusal.
A rejected claim leaves escrow intact: it is not a refund. A later native
seal/distribution explicitly proves principal recovery.

Reusing the same settlement must send nothing again. A separate replay uses a
fresh blockhash and signature, so its rejection exercises native channel state
rather than transaction-history deduplication. Confirmation-loss recovery
executes a claim first, hides its confirmation, then exposes that same native
transaction after local expiry; it must recover without another payout.

Executed transactions retain signature and blockhash verification and the
Ed25519 precompile. Only a **cloned VM for simulation** honors the SDK's RPC
simulation options for partially signed messages and placeholder blockhashes.
Those options never weaken the VM that actually changes balances.

## Treasury compatibility and limits

The unmodified pinned source's `mainnet-beta` feature contains the treasury
constant that matches the SDK's corresponding network label. Its default
localnet treasury is a placeholder; its devnet feature requires a source
configuration that is absent from the pinned tree. This fixture chooses the
source-clean build instead of changing treasury or transfer logic.

**The label selects constants inside an isolated VM. It does not enable product
mainnet, access a public network or validate the deployed devnet binary.** The
product mainnet lock and payment configuration are unchanged. The short grace
used to isolate native grace equality is an SDK/native-only fixture; the product
correctly refuses that unsafe configuration and uses its longer grace.

These tests cover SDK/native-program semantics. They do not run buyer/seller
startup, Iroh, an inference engine or current devnet. Product service/transport
composition has separate synthetic tests. A source build is not evidence of byte
equivalence to a deployed program. The separate legacy paid path,
reusable-channel recovery and fee-policy work are not changed here.

Before financial production acceptance, separately verify the intended cluster's
binary/configuration and run an explicitly approved current-code live rehearsal.
No finite local reserve guarantees inclusion under arbitrary RPC delay,
congestion or clock drift. This lab does not claim 100% safety.

## Fixture provenance and rebuild

The [manifest](../tests/fixtures/payment-channels-native.json) records the exact
source commit, clean-source condition, lockfile digest, features, architecture,
builder/tool archive digests and final ELF digest/size. The upstream program's
[MIT notice](../tests/fixtures/payment-channels-native-LICENSE.txt) is
preserved. The separate
[target dependency inventory](../tests/fixtures/payment-channels-native-dependencies.json)
records crate versions, declared/selected licenses and lockfile checksums. The
program source's MIT label does not cover all linked dependencies: Apache-2.0
covers the listed Apache/dual-licensed components and Rust core, while the
MIT-only five8 family has its preserved copyright/permission notice. Host
proc-macros/dev crates are excluded; compilation is not a claim that all
component code survives linkage. The program is not a modified processor or a
mock; SPL distribution batching and all native guards remain enabled.

To rebuild, use a fresh source checkout at the manifest's commit and verify that
its working tree and Cargo.lock are unchanged. Provision these official tools in
a disposable directory, checking their archive hashes against the manifest:

- [Agave v3.1.13](https://github.com/anza-xyz/agave/releases/tag/v3.1.13),
  `solana-release-aarch64-apple-darwin.tar.bz2`.
- [Platform tools v1.52](https://github.com/anza-xyz/platform-tools/releases/tag/v1.52),
  `platform-tools-osx-aarch64.tar.bz2`.

Point the extracted SBF SDK's `dependencies/platform-tools` at those verified
platform tools. Use its `cargo-build-sbf` directly, with platform-tools
`rust/bin` first in PATH and RUSTC pointing to that directory's rustc; use
`--no-rustup-override` to avoid changing the host toolchain. Build only the
program, without generating clients/IDL or running install/deploy scripts:

```sh
cargo-build-sbf \
  --manifest-path program/payment_channels/Cargo.toml \
  --skip-tools-install --no-rustup-override --tools-version v1.52 \
  --no-default-features --features mainnet-beta \
  --arch v0 --sbf-out-dir /tmp/payment-channel-artifact \
  -- --locked
```

Use a disposable CARGO_TARGET_DIR. The recorded build remaps `/Users` to
`/build/users` and the source checkout to `/source` with RUSTFLAGS; the builder
also enables its default cwd remapping. Only public compiler-provider source
paths may remain in precompiled standard-library strings, never operator paths.
Dependency acquisition may need crates.io; running the tests never does.

This builder's post-processing syscall-name list predates some Pinocchio symbols
and can warn about unknown names. A build or load alone is insufficient: the
acceptance cases must execute and pass on the resulting ELF. Do not disable
native guards, signatures or batching to obtain a pass.

After a rebuild, verify the digest/size, license and source diff before
replacing the fixture or manifest. Changing any input or digest requires review
and a complete native run; never bless an arbitrary supplied binary by rehashing
it. A matching same-host rebuild is not a cross-platform reproducibility claim.
