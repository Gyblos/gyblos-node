# Desktop preview and compatibility probe

An experimental Electron app, targeting macOS, Windows and Linux. Local
packaging currently supports macOS Apple Silicon only; other installers are not
provided. The normal window reuses the approved mockup's Chat, shared controls,
searchable model/tool dropdowns, history, motion, SVG signature, palette and
local artwork. Connect reuses its tool list and model/budget editor; no external
tool is launched. Models, Activity, full-page Settings, appearance, the
adjustable sidebar and full-width status footer use the same mockup components
and styles. The personal wallet is local and protected; USDC Chat and Connect
remain simulated. An opt-in [PayPal Sandbox session](paypal-sandbox.md) runs a
pinned local Ollama model with test payments for one local seller.

Chat keeps one in-memory conversation and draft when switching USDC preview and
PayPal Sandbox. The method applies to the next message only. Previous responses
retain their payment-method label. PayPal still uses the configured local model
and does not send previous messages as context. Switching method never opens a
checkout or settles a session. Payment selection stays locked during responses
and pending PayPal acknowledgments. Models and Tools use the same searchable
menu with artwork; unimplemented web tools remain disabled previews. Contextual
links show a back arrow, while sidebar destinations reset that journey.

The USDC preview streams synthetic text independently per conversation. New
chats, history selection and switching Chat/Connect leave other responses
running and preserve separate drafts. Stop affects only the visible conversation
and keeps its generated prefix. Local-node availability does not authorize
inference or stop synthetic responses. Blocked sends explain missing credits or
a daily limit inside the chat instead of opening wallet settings. Choosing a
free model clears only the corresponding paid-model block. Conversations and
drafts are saved locally in a private conversation file in the persistent
desktop profile, including model and payment-method labels and opaque links to
shared PayPal sessions. This is display history, not payment authority. Loading
never resumes inference, acknowledges a response, or creates an authorization;
incomplete responses reopen as interrupted. API keys, live execution state and
payment identifiers are excluded. Files have owner-only permissions; this is
local storage, not cloud synchronization or a claim of content encryption.
Corrupt, oversized or inaccessible history is preserved and reported as
unavailable instead of being replaced with an empty chat. Accepted snapshots are
coalesced in the host; graceful exit drains them with a bounded wait, so abrupt
exit or storage failure may lose unsaved changes. Theme choices and connection
budgets remain in memory and clear when the app closes.

Activity separately saves descriptive PayPal Sandbox session metadata in a
private file beside the sandbox state. It contains no chat text, credentials or
payment identifiers, and is never used to authorize or retry payments. Each
observed session separates acknowledged Chat replies, completed agent
inferences, unconfirmed consumption and successful captures. Dates are local
observation times, not transaction dates. Earlier sessions that predate
collection may be unavailable. Storage failures remain visible and do not block,
change or retry financial work. Observation queues metadata independently of
payment IPC. Shutdown closes financial resources before a bounded history flush;
a separate metadata lock protects late writes without holding the payment
journal open. Abrupt exit can lose unsaved descriptive history. USDC preview
activity lists only completed simulated replies in saved conversations; it never
appears as a real payment. Conversation history links new PayPal turns to their
shared payment session; shared totals can include other chats and agents.

The five sample models and their prices remain visible in the Preview catalog;
connection budgets are illustrative, not enforced tool spending limits. Models
also supports an explicit exact-ID lookup of signed free announcements from the
public discovery index. This reads one bounded page and only retains listings
with zero input and output prices. Signature/lifetime checks reuse the discovery
adapter. Announcements do not establish registry identity, latest withdrawal
state, provider availability or a usable inference offer. The chat daily-limit
check uses demo credits only. The footer shows actual local-node state, wallet
backup reminder and app version. “Node ready” means the local Iroh endpoint is
bound, not that providers or the public network are reachable. The visible 0.0
balance is a placeholder, not a queried or funded balance. Preview credits are
not the personal wallet balance. The renderer remains network-denied. Only an
explicit model lookup allows the host to issue an anonymous GET to the fixed
public index in an ephemeral, cookieless session, with redirects denied and a
deadline. The PayPal Sandbox host separately connects to the local Ollama engine
and PayPal Sandbox. The preview does not connect web tools, a gateway, a remote
inference provider or existing node configuration.

Network lookup is lazy: opening the app or Models makes no discovery request.
The current index searches by exact model ID, not a global model enumeration.
The UI distinguishes loading, empty, failed and expired results, reports local
check time and marks a partial first page. It preserves the last submitted ID
when returning to Models. Results stay in memory, are pruned on signed expiry
and are cancelled on replacement or quit. Only sanitized model fields reach the
renderer; no owner, NodeId, signature, endpoint or raw network error crosses the
catalog bridge. The fixed IPC authenticates the current window/main frame and
validates arity and bounded identifiers. Announced entries reuse the model rows
and chat selector with an explicit Chat preview label; selection remains
simulated and does not enable wallet funding. Connect continues using its sample
models. No fallback sample is presented as a network announcement.

## Navigation and wallet settings

The shared header shows the current route and the sidebar toggle. The sidebar
owns its full-height divider; the header rule starts at that edge. Settings is
above the appearance switch. Chat-only web tools are separate from inference
applications in Connect; model artwork and compact selectors are shared.

Both the corner balance and footer backup reminder navigate to Settings. Only
its explicit Back up wallet action opens the existing backup flow. Copy address
uses a narrow host action: only the currently selected wallet's public address
can be copied, from the owning main frame while its lifecycle is active. No
arbitrary clipboard access, private key or signing capability is exposed.

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
isolation and network denial. Normal Chat does not invoke inference services.
The normal host also starts a resident utility process with the existing
loopback-only Iroh binder and `@gyblos/node/lifecycle`. It uses an ephemeral
identity, no relays/discovery, and no operational configuration or wallet. The
footer reads fixed sanitized host states; readiness requires worker
acknowledgement, errors permit a single-process retry, and quit waits for
process exit. Startup and stop deadlines request termination; a forced exit is
never a clean stop. There is no hard exit bound if the OS refuses process
termination.

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
