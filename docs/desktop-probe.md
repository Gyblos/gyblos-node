# Desktop preview and compatibility probe

An experimental Electron app, targeting macOS, Windows and Linux. Local
packaging currently supports macOS Apple Silicon only; other installers are not
provided. The normal window reuses the approved mockup's Chat, shared controls,
searchable model/tool dropdowns, history, motion, SVG signature, palette and
local artwork. Connect reuses its tool list and model/budget editor; no external
tool is launched. Models, Activity, full-page Settings, appearance, the
adjustable sidebar and full-width status footer use the same mockup components
and styles. The personal wallet is local and protected; inference and Connect
remain simulated.

Chat responses stream synthetic text independently per conversation. New chats,
history selection and switching Chat/Connect leave other responses running and
preserve separate drafts. Stop affects only the visible conversation and keeps
its generated prefix; pausing the simulated connection stops every response
without clearing drafts. Blocked sends explain missing credits or a daily limit
inside the chat instead of opening wallet settings. Choosing a free model clears
only the corresponding paid-model block. All conversations, drafts, theme
choices and connection budgets are in memory and clear when the app closes. They
are not saved to the product home.

The five sample models, prices, free labels and connection budgets are
illustrative, not live availability, payment authorization or enforced tool
spending limits. The chat daily-limit check uses demo credits only. The footer
shows the local connection state, wallet backup reminder and app version; its
presentation does not establish a live network connection. The visible 0.0
balance is a placeholder, not a queried or funded balance. Preview credits are
not the personal wallet balance. No inference, web tool, gateway, existing node
configuration or remote network is used by this UI.

## Navigation and wallet settings

The shared header shows the current route and the sidebar toggle. The sidebar
owns its full-height divider; the header rule starts at that edge. Settings is
above the appearance switch. Chat-only web tools are separate from inference
applications in Connect; model artwork and compact selectors are shared.

Both the corner balance and footer backup reminder navigate to Settings. Only
its explicit Back up wallet action opens the existing backup flow. Copy address
uses a narrow host action: only the completed startup wallet's public address
can be copied, from the owning main frame while its lifecycle is active. No
arbitrary clipboard access, private key or signing capability is exposed.

Add funds opens a local amount form. It rejects an unavailable wallet or missing
verified backup, then always reports payment unavailable. It cannot authorize
payment, change a balance, or enable funding. The existing first-run wallet and
empty-destination restore behavior below is unchanged.

## Protected local wallet

On first launch without an existing wallet, the startup window offers Create
wallet or Restore backup before any key is generated. Restoration recovers the
same address for confirmation; existing complete or partial wallet state is
loaded without replacement. See
[portable backup and recovery](desktop-backup.md) for the flow and its limits.

The main process stores one Ed25519 wallet under
`app.getPath('appData')/gyblos-wallet/wallet-v1`, with only OS-encrypted private
material on disk. Chat/Connect receive only the public address and status;
private material stays in the host process. Funding remains unconditionally
disabled, including after backup verification or restoration. Do not fund this
experimental wallet: external transfers to an address cannot be blocked by the
app. No balance is queried.

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
Missing/corrupt data requires a later recovery mechanism.

OS encryption protects stored data, not a compromised app or account. Plaintext
is temporarily present in main-process memory; JavaScript strings cannot be
reliably zeroed. This is not a Secure Enclave wallet or a portable recovery
backup.

Offline wallet tests use disposable keys and fake OS encryption on the three CI
systems. They do not establish native Keychain, DPAPI or Linux keystore
acceptance, cross-platform recovery or signed-update continuity. Those remain
separate checks.

The [portable backup flow](desktop-backup.md) supports saving, same-address
verification and first-run restoration. Successful saved-file checks persist
protected identity-bound metadata and can set the public backup indicator;
funding remains unconditionally disabled. Current cross-platform automation and
real OS secret-store acceptance must be verified separately.

## Run locally

Use Node 22+ and the repository's pinned pnpm. After a frozen install:

```sh
pnpm desktop:start
```

The app creates fresh temporary Chromium session data and retains renderer
isolation and network denial. Normal Chat does not invoke inference services.
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
real inference, authenticated Connect and persistent conversation storage remain
outside this preview. Generated apps, captures and run evidence stay outside
Git. The normal root checks cover its TypeScript/TSX, lint rules and synthetic
summary/lifecycle regressions; Electron packaging is a separate
platform-specific check.
