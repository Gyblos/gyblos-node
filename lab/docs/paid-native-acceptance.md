# Offline payment-channel program acceptance

These lab suites run signed transactions from the installed, patched x402 SDK in
LiteSVM against a bundled SBF build of the official payment-channel program.
Mint, keys, SOL and token balances exist only inside each fresh VM: there is no
RPC client, network listener, live wallet or deployment. Run them whenever you
change payment-channel, withdrawal or payment-session code.

## Run them

LiteSVM is a pinned development dependency; its native package must exist for
your host. No compiler, validator, Docker, funded wallet or real engine is
needed.

```sh
pnpm install --frozen-lockfile
pnpm test:lab
```

To run only the core channel cases:

```sh
node --import tsx --test tests/lab/paid-native.test.ts
```

Missing native support fails these suites instead of reporting acceptance.

The same fixture, loaded through `tests/support/paid-native-vm.ts`, also backs
the other native suites in `tests/lab/`, including channel opening, withdrawal,
abrupt exit (`channel-crash-native.test.ts`), payment sessions and session
renewal. [tests/README.md](../../tests/README.md) lists them.

## Scope

- **Lifecycle.** The cases run SDK channel opening, a payer's signed close,
  metered claims, sealing and distribution. They check the program's real
  account transitions and token balances: refund, seller share, Gyblos fee share
  and the separate program-treasury rounding remainder. The harness only funds
  the VM and sets its clock; channel and token-account bytes are never seeded or
  rewritten, and mint and token-account setup also use signed transactions.
- **Deadlines.** Voucher and closing-grace boundaries are tested just before,
  exactly at and just after each deadline. The VM clock can advance after the
  SDK's checks and simulation succeed, which separates the program rejecting a
  late transaction from a local SDK refusal. A rejected claim leaves the escrow
  intact (it is not a refund); a later seal and distribution prove the principal
  is recovered.
- **Replay and recovery.** Reusing a settlement sends nothing again. A separate
  replay with a fresh blockhash and signature is rejected by channel state, not
  by transaction-history deduplication. Confirmation-loss recovery runs a claim,
  hides its confirmation, then reveals that same transaction after local expiry;
  recovery must finish without a second payout.
- **Signatures.** Executed transactions keep signature and blockhash checks and
  the Ed25519 precompile. Only a cloned VM used for simulation honors the SDK's
  simulation options for partially signed messages and placeholder blockhashes;
  the VM that changes balances never does.

## Limits

The fixture is built with the program's `mainnet-beta` feature because it is
the only build that needs no source change: its treasury constant matches the
SDK's network label, the default localnet treasury is a placeholder, and the
devnet feature needs configuration missing from the pinned source. The label
only selects constants inside the isolated VM. It doesn't enable mainnet in the
product, touch a public network or validate the deployed devnet binary. The
short grace used to test grace equality exists only in this fixture; the
product refuses it and uses a longer grace.

These suites don't run buyer or seller startup, Iroh, an inference engine or
current devnet; synthetic product tests cover that composition. A source build
is not proof of byte equivalence with a deployed program. Before production
payments, verify the target cluster's binary and configuration and run an
explicitly approved live rehearsal. No local reserve guarantees inclusion under
arbitrary RPC delay, congestion or clock drift; see
[limitations.md](../../docs/limitations.md).

## Fixture provenance and rebuild

The [manifest](../../tests/fixtures/payment-channels-native.json) records the
source commit, clean-source condition, lockfile digest, features, architecture,
builder and tool archive digests, and the final ELF digest and size. The
upstream [MIT notice](../../tests/fixtures/payment-channels-native-LICENSE.txt)
is preserved, and the
[target dependency inventory](../../tests/fixtures/payment-channels-native-dependencies.json)
records crate versions, declared and selected licenses and lockfile checksums.
The program source's MIT label does not cover every linked dependency:
Apache-2.0 covers the listed Apache or dual-licensed components and Rust core,
and the MIT-only five8 family keeps its
[own notice](../../tests/fixtures/payment-channels-native-five8-LICENSE.txt).
Host proc-macro and dev crates are excluded. See also
[third-party-notices.md](../../docs/third-party-notices.md). The program is
neither modified nor a mock: SPL distribution batching and every native guard
stay enabled.

To rebuild the fixture:

1. Check out the source at the manifest's commit. Confirm the working tree and
   `Cargo.lock` are unchanged.
2. In a disposable directory, download these official tools and check their
   archive hashes against the manifest:
   - [Agave v3.1.13](https://github.com/anza-xyz/agave/releases/tag/v3.1.13),
     `solana-release-aarch64-apple-darwin.tar.bz2`;
   - [Platform tools v1.52](https://github.com/anza-xyz/platform-tools/releases/tag/v1.52),
     `platform-tools-osx-aarch64.tar.bz2`.
3. Point the extracted SBF SDK's `dependencies/platform-tools` at the verified
   platform tools. Put platform-tools `rust/bin` first in `PATH` and set
   `RUSTC` to its `rustc`.
4. Set a disposable `CARGO_TARGET_DIR`. Set `RUSTFLAGS` to remap `/Users` to
   `/build/users` and the source checkout to `/source`, as the recorded build
   did (the builder also remaps the working directory).
5. Build only the program, without generating clients or IDL or running install
   or deploy scripts:

   ```sh
   cargo-build-sbf \
     --manifest-path program/payment_channels/Cargo.toml \
     --skip-tools-install --no-rustup-override --tools-version v1.52 \
     --no-default-features --features mainnet-beta \
     --arch v0 --sbf-out-dir /tmp/payment-channel-artifact \
     -- --locked
   ```

   Fetching dependencies may need crates.io; running the tests never does. The
   builder may warn about unknown syscall names for some Pinocchio symbols.

6. Verify the digest and size, the license and the source diff, then replace the
   fixture and manifest.
7. Run every native suite on the new ELF. A build or load alone is not enough,
   and never disable native guards, signatures or batching to get a pass.

Only public compiler-provider source paths may remain in precompiled
standard-library strings, never operator paths. Changing any input or digest
needs review and a complete native run; never accept an arbitrary binary by
rehashing it. A matching rebuild on the same host is not a cross-platform
reproducibility claim.
