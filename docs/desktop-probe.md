# Desktop buyer and compatibility probe

An experimental Electron buyer for macOS, Windows and Linux. Local packaging
currently supports macOS Apple Silicon only. Chat, Connections, Models,
Applications, Activity, Payments and Settings share the approved compact visual
system, Instrument Sans and reusable controls.

Native Chat supports two independent payment coordinators: an authenticated
local x402 buyer and the opt-in [PayPal Sandbox session](paypal-sandbox.md).
Switching payment method keeps the conversation and draft and never starts a
payment. Historical simulated responses retain their original provenance. The
web mockup's sample replies are not payment or live-inference evidence.

## x402 chat

The desktop stages the buyer-owned utility executable and runs the same inert
buyer composition as the CLI. It does not import another app into its renderer.
Signed-quote selection decides whether a response is free or paid: a zero-price
offer never creates a transaction, regardless of the budget. Paid execution
retains its existing devnet, model, reasoning, identity, recount and journal
checks. The current paid runtime supports the pinned Qwen3-0.6B configuration
with reasoning off.

Before starting, prepare the buyer using the existing CLI setup, including its
selection, identity configuration and public tokenizer for paid execution. Stop
any other buyer using the same home. In Payments:

1. Choose the **GYBLOS_HOME root**, containing buyer/selection.json.
2. Enter the relay token in the password field, or provide GYBLOS_RELAY_TOKEN in
   the app's launch environment.
3. Start the local buyer. The app uses an ephemeral loopback port and keeps its
   generated bearer credential in the trusted host.
4. Authorize a Chat budget in the displayed asset. Each request reserves the
   configured maximum before transmission; the remaining budget must cover that
   maximum. No funds move merely by approving this local permission.
5. Continue in Chat. Each independent message uses actual buyer execution.
   Positive-price responses settle automatically through x402.
6. Finish the session to close this desktop's permission. Confirmed payment
   references remain in Payments and Activity.

An alternative dialog connects an already running compatible local buyer with
its URL and bearer key. Only literal 127.0.0.1 HTTP endpoints are accepted.
Metadata and the desktop chat route require bearer authentication, reject any
Origin, and bind each request to the buyer process's policy identifier. A
restarted or reconfigured buyer cannot silently execute under an old approval.
There is no automatic prompt retry.

The paying account is the selected buyer role wallet, not necessarily the
separate protected desktop wallet. Only the known devnet USDC mint is labelled
USDC; other test assets display atomic units. This version does not query the
protected desktop wallet's balance or fund it.

The host saves a separate private Chat permission and reservation before each
send. Unfinished or unverified payments block messages and closure, including
after restart. Only explicit buyer proof that a request was never sent can
release its unsent reservation; this never removes or retries a financial
journal entry. Reconciliation remains the existing buyer workflow. Successful
receipts are recorded only after the buyer's chain verification. Their
abbreviated signatures open the fixed Solana devnet explorer through an
owning-main-frame action; the renderer cannot supply arbitrary explorer URLs.

The budget applies to this desktop Chat, not other clients or agents using the
same buyer or wallet. Current x402 settlement is per inference. Finish does not
submit a deferred aggregate payment or independently prove a refund.

## Local history and previews

Conversations and drafts are saved privately in the persistent desktop profile,
including model/payment labels and opaque PayPal or x402 session links.
Restoring never resumes inference, acknowledges a response or authorizes
spending. Incomplete responses reopen as interrupted. Credentials and signed
payment payloads are excluded. Storage is local, not cloud-synchronized or
claimed to encrypt conversation content.

PayPal's descriptive session history remains separate from its financial
journal. x402 history contains verified references and amounts, or an explicit
free result without a fabricated hash. Uncertain values are not displayed as
confirmed spending or available balance. Local dates are observation times, not
necessarily the chain's block time.

The sample model catalog and unimplemented web tools remain previews. Exact-ID
lookup reads bounded signed free announcements from the public index; an
announcement alone is not registry identity, availability or inference proof.
Real x402 Chat uses the selected buyer's model and policy, rather than silently
applying a sample model selection.

The renderer remains network-denied. The host owns the buyer connection,
configuration chooser, credentials and allowlisted explorer action. The PayPal
coordinator continues using its configured local Ollama model and test session.

## Navigation and wallet settings

The shared header shows the current route and the sidebar toggle. The sidebar
owns its full-height divider; the header rule starts at that edge. Settings is
above the appearance switch. Chat-only web tools are separate from inference
applications in Connect; model artwork and compact selectors are shared.

Payments owns the protected desktop wallet and backup actions. The sidebar
provides system status without a permanent footer. Copy address uses a narrow
host action: only the currently selected wallet's public address can be copied,
from the owning main frame while its lifecycle is active. No arbitrary clipboard
access, private key or signing capability is exposed.

Add funds opens a local amount form. It rejects an unavailable wallet or missing
verified backup, then always reports payment unavailable. It cannot authorize
payment, change a balance, or enable funding. Automatic startup and the
Settings-only recovery flow are described below.

## Internal wallet library

The Node-only `@gyblos/desktop/wallet-library` entry is composed by the host
session; the renderer receives public summaries and fixed operation results. It
requires an existing protected desktop wallet. It never creates a replacement
for missing, partial or inaccessible custody.

`summary()` returns only public addresses/statuses. `restore(bytes, password)`
authenticates a portable backup and imports it into a separate address-named
protected store, leaving the original record and active selection unchanged.
Duplicates are refused. `select(address)` explicitly publishes an authenticated,
OS-protected selection; reopening the library retains that address.
`verifyBackup(address, bytes, password)` reuses the existing identity-bound
verification receipt. Restoring alone does not mark a backup verified. Every
summary retains `fundingEnabled: false`, including after verification.

Library paths are owned by config. A private directory lock serializes
instances; a remaining lock is reported busy, never stolen. Failed encrypted
writes and incomplete destinations remain for inspection, never automatically
replaced or deleted. Missing/corrupt selection metadata while the library
directory remains present fails closed rather than selecting another identity.
Deleting or rolling back the entire library is not detected; absence is treated
as a legacy-only installation. Selection publication by atomic rename is the
commit point; cancellation after publication cannot roll it back. Fresh service
instances reload selection from disk; process-crash recovery, Windows directory
fsync and sudden-power-loss recovery are not established. No payment state,
transfer, balance query or raw secret-export API is added. Settings backup
reuses the existing approved encrypted-file workflow, pinned to the selected
address and serialized with restore/select.

## Protected local wallet

On first launch the small ASCII loader automatically prepares a protected wallet
only when its dedicated root is absent or empty. It offers no creation choice,
backup prompt or startup wallet modal. Existing state is read without
initialization; a missing original inside a retained library never generates a
replacement. Settings can restore an encrypted backup alongside the original,
then explicitly select which wallet to use. The selected address and its
verified-backup indicator are reloaded on the next launch. See
[portable backup and recovery](desktop-backup.md) for the flow and its limits.

The main process retains the original Ed25519 wallet under
`app.getPath('appData')/gyblos-wallet/wallet-v1`. Imported identities have
separate address-named stores in the config-owned wallet library, with only
OS-encrypted private material on disk. Chat/Connect receive only the public
address and status; private material stays in the host process. Funding remains
unconditionally disabled, including after backup verification or restoration. Do
not fund this experimental wallet: external transfers to an address cannot be
blocked by the app. No balance is queried.

| Platform | Protection and limits                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Electron asynchronous `safeStorage` backed by Keychain. Consistent code signing is needed before claiming continuity across distributed app updates.                                        |
| Windows  | Asynchronous `safeStorage` backed by DPAPI. This protects against other users, not arbitrary processes in the same user account.                                                            |
| Linux    | Electron 45 synchronous `safeStorage`, restricted to `gnome_libsecret` or KWallet backends. Missing, `basic_text`, unknown and unrecognized backends block creation; no plaintext fallback. |

Linux deliberately uses the encryptor whose backend can be checked. Electron 45
does not expose equivalent async-provider identification; migrating this adapter
is required before upgrading to Electron 46, which removes synchronous methods.
See
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

The persistent instance-lock profile is separate from disposable Chromium
session data. Initialization is shared, and orderly quit waits for it; an
unresponsive OS secret-store prompt may delay quit. Existing, interrupted,
corrupt or inaccessible wallet data is never silently replaced. POSIX
directories/files use owner-only permissions and file/directory flushes; Windows
uses the OS user profile and DPAPI, without claiming equivalent
sudden-power-loss durability. Repeated launches reuse the stored identity.
Partial/corrupt local state is retained for inspection; importing a backup does
not silently repair or replace that state.

OS encryption protects stored data, not a compromised app or account. Plaintext
is temporarily present in main-process memory; JavaScript strings cannot be
reliably zeroed. This is not a Secure Enclave wallet or a portable recovery
backup.

Offline wallet tests use disposable keys and fake OS encryption on the three CI
systems. They do not establish native Keychain, DPAPI or Linux keystore
acceptance, cross-platform recovery or signed-update continuity. Those remain
separate checks.

The [portable backup flow](desktop-backup.md) supports saving, same-address
verification and Settings-only restoration alongside the current wallet.
Successful saved-file checks persist protected identity-bound metadata and can
set the public backup indicator; funding remains unconditionally disabled.
Current cross-platform automation and real OS secret-store acceptance must be
verified separately.

## Run locally

Use Node 24.22.1+ and the repository's pinned pnpm. After a frozen install:

```sh
pnpm desktop:start
```

The app creates fresh temporary Chromium session data and retains renderer
isolation and network denial. Real inference requires an explicitly configured
and authorized buyer or PayPal session. The normal host also starts a resident
utility process with the existing loopback-only Iroh binder and
`@gyblos/node/lifecycle`. It uses an ephemeral identity, no relays/discovery,
and no operational configuration or wallet. The sidebar reads fixed sanitized
host states; readiness requires worker acknowledgement, errors permit a
single-process retry, and quit waits for process exit. Startup and stop
deadlines request termination; a forced exit is never a clean stop. There is no
hard exit bound if the OS refuses process termination.

The separate `--smoke` mode mounts the compatibility view and its one fixed IPC
operation. A utility process imports the pinned Iroh binding and
`@gyblos/node/lifecycle`, performs two synthetic loopback echo cycles, closes
both endpoints after each cycle, reports a closed summary and exits after the
parent acknowledges receipt. No CLI output is parsed to control the app.

The compatibility smoke has no relay/discovery preset, external engine, wallet,
payment, gateway or remote access. No existing node data is read. Cancellation
reports failure rather than claiming graceful endpoint cleanup.

## Check and package

```sh
pnpm desktop:smoke
pnpm desktop:package
```

The smoke runs its compatibility renderer/preload/IPC/worker path in a hidden
window and exits nonzero on failure, including a renderer that never calls the
bridge. A successful result has two cycles, two round trips and `closed: true`.
Timeouts cover startup and request worker termination at its deadline. An
already-cancelled request creates no worker; cancellation before spawn retries
termination at spawn. A created worker reports failure only after its exit
event, including on timeout; this is not a hard completion bound if the
operating system cannot terminate it. Native failures are intentionally reported
without raw SDK errors, identities or socket addresses.

Packaging creates an **unsigned local `.app`**, for macOS arm64 only, under
`apps/desktop/dist/packages/`. It stages compiled assets and the pinned Iroh
packages explicitly; it does not copy the repository or operational directories.
The packaged executable accepts `--smoke` too. It needs neither a globally
installed Node runtime nor workspace links at runtime.

This is not a signed/notarized installer, release or updater. Windows/Linux
installers, Intel Mac packaging, real P2P connectivity, application recovery and
real inference, authenticated Connect remain outside this preview. Generated
apps, captures and run evidence stay outside Git. The normal root checks cover
its TypeScript/TSX, lint rules and synthetic summary/lifecycle regressions;
Electron packaging is a separate platform-specific check.
