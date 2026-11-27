# Desktop app

`apps/desktop` is the Gyblos desktop app: an Electron buyer for macOS, Windows
and Linux. It chats with network sellers through a local buyer, manages
[buyer API keys](buyer-api-keys.md) for coding agents, and keeps a protected
local wallet. This page is for developers working on the app. The public
[desktop app guide](https://docs.gyblos.com/en/buyers/desktop-app) covers
download, first launch and everyday use, and
[apps/desktop/DESIGN.md](../apps/desktop/DESIGN.md) owns the visual system.

The app is experimental and runs on Solana devnet. Its packages are unsigned.

## Screens

| Screen       | What it does                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Chat         | One transcript and draft; the composer picks model, thinking, tools and payment method               |
| Connections  | Buyer API keys, their Base URL and limits, and agent setup ([buyer API keys](buyer-api-keys.md))     |
| Models       | Searchable model list with a network check against the discovery index                               |
| Applications | Web tools; unavailable services show as unavailable                                                  |
| Activity     | Chat consumption, agent inference and confirmed payments                                             |
| Payments     | The local buyer and Chat budget, the protected wallet and its backup, and the PayPal Sandbox summary |
| Settings     | Appearance, the design-system preview and version information                                        |

The status bar shows **Update to** when a newer release exists. Open the notice,
then choose **Open download page** to view the release on GitHub
([Network contact](#network-contact)).

## Run locally

### Prerequisites

- Node 24.22.1 or later and the pnpm version pinned in `package.json`.
- A frozen install: `pnpm install --frozen-lockfile`.

Start the app:

```sh
pnpm desktop:start
```

This builds the app and opens it with fresh temporary Chromium session data. The
renderer stays isolated and has no network access. The host also starts a
resident utility process with the loopback-only Iroh binder and
`@gyblos/node/lifecycle`. It uses an ephemeral identity, no relays or discovery,
and no operational configuration or wallet; the sidebar's system status reads
its fixed, sanitized states.

Real inference needs the local buyer ([Chat with x402](#chat-with-x402)) or a
[PayPal Sandbox session](paypal-sandbox.md).

## Chat with x402

Chat has two independent payment methods: a local x402 buyer and the opt-in
[PayPal Sandbox session](paypal-sandbox.md). Switching method keeps the
conversation and draft and never starts a payment.

### The local buyer

The app starts its own buyer when it launches. On first start it creates a
dedicated buyer home in the app's profile directory with the shared buyer
initializer (`@gyblos/node/buyer-init`) and a devnet USDC buyer role. A new
configuration uses free models only. The buyer is the same buyer-owned
executable the CLI runs (`apps/buyer/src/desktop-worker.ts`, staged as
`buyer-service.cjs`); the renderer never imports another app.

The buyer listens on an ephemeral loopback port, and its bearer credential stays
in the host. If the start fails, use **Retry local buyer**.

To use a buyer you configured yourself instead, choose **Connect a running
buyer** and enter its **Local buyer URL** and **Private buyer connection key**.
Only literal `127.0.0.1` HTTP endpoints are accepted. Stop any other buyer that
uses the same home first.

Relays: the Gyblos relays need no token. Set `GYBLOS_RELAY_TOKEN` in the app's
launch environment only for an owned relay that requires one. `GYBLOS_RELAYS`,
`GYBLOS_BUYER_RELAY_ONLY`, `GYBLOS_IROH_BIND` and `GYBLOS_IROH_EXTERNAL_ADDR`
from that environment are passed to the managed buyer.

### Pay for answers

1. Choose a paid seller in **Models** and confirm the rates, maximum per
   response, channel deposit and duration. You can set an optional total Chat
   budget in **Payments**.
2. Write in **Chat**. Each message runs a real buyer execution. Each request
   reserves the configured maximum before it is sent, so the remaining budget
   must cover that maximum.
3. Channel approvals accumulate for batch settlement. A zero-price offer never
   creates a transaction.
4. Finish the session to close this desktop's permission. Confirmed payment
   references stay in **Payments** and **Activity**.

A legacy buyer profile without channel settings first accepts the spending
maximum, then verifies the channel before the seller can be confirmed.

In **Models**, select a paid offer and choose **Check payment channel** to see
its verified status, remaining escrow and wallet balance. **Check status**
refreshes the observation. When an API key reservation needs review, it first
checks for finalized evidence and reconciles the reservation when possible.
**Refresh wallet** only updates the observation. Before sending to a pinned paid
seller, Chat checks the channel again and keeps the draft if spending is
blocked. If the wallet observation fails, the last verified balance and its time
appear when available.

The Chat model picker checks paid Auto listings against the saved input and
output rates and response maximum before using their reported switching credit.
The buyer checks the signed offer again at dispatch. If the overview is partial,
the picker checks the exact model across up to eight index pages within one
request deadline. Results are capped at 64 listings. If no visible listing
qualifies and the result is still partial, the draft stays available for a later
check.

The signed quote decides whether an answer is free or paid. Paid execution keeps
the buyer's devnet, model, reasoning, identity, recount and journal checks; the
paid runtime supports the pinned Qwen3 0.6B with reasoning off. Finishing does
not submit a deferred aggregate payment or prove a refund.

The paying account is the buyer role's wallet, not the protected desktop wallet.
Only the known devnet USDC mint is labelled USDC; other assets show atomic
units.

### Safety rules

- Metadata and the Chat route require bearer authentication, reject any
  `Origin`, and bind each request to the buyer's policy identifier. A restarted
  or reconfigured buyer cannot run under an old approval.
- The host saves a private Chat permission and reservation before each send.
  Unfinished or unverified payments block new messages and closing, including
  after a restart. Only buyer proof that a request was never sent releases its
  reservation.
- There is no automatic prompt retry, and the app never removes or retries a
  financial journal entry. Resolve uncertain payments with the buyer
  [recovery](recovery.md) commands.
- The budget covers desktop Chat only, not other clients or agents that use the
  same buyer or wallet.
- Receipts are recorded only after the buyer's chain verification. Their
  abbreviated signatures open the fixed Solana devnet explorer through a
  main-frame host action; the renderer cannot supply an explorer URL.

## Local history

Conversations and drafts are saved privately in the persistent desktop profile,
with model and payment labels and opaque PayPal or x402 session links. Failed
turns can record a fixed reason such as an unresolved API key reservation or a
seller refusal. The archive omits remote error text. Credentials and signed
payment payloads are excluded. Storage is local, not synchronized, and
conversation content is not encrypted.

- Restoring history never resumes inference, acknowledges a response or
  authorizes spending. An incomplete response reopens as interrupted. The turn
  shows its recovery action. A verified pre-dispatch refusal records that the
  turn incurred no charge. When an earlier key reservation caused the refusal,
  the turn retains its spending review action. Editing a declined question
  preserves an existing draft in its conversation. A budget status check cannot
  establish a charge for the specific turn. Check status on a key review reads
  whether the authenticated key ledger currently allows requests. A key review
  refusal asks clients to stop automatic retries. Each client controls its retry
  behavior. Before streaming starts, a review refusal returns HTTP 503 for Chat
  Completions and Anthropic Messages or HTTP 400 for Responses, with
  `x-should-retry: false` in each case. A stream that has already started keeps
  HTTP 200 and signals the failure in its final event. For interrupted paid
  responses it can reconcile local spending records against verified payment
  evidence. When the original session is unavailable, review the payment history
  in Payments.
- Earlier desktop versions may decline to load archives containing newer turn
  metadata. An unreadable archive disables saving and preserves the original
  file. Reopen it with the newer desktop version to recover the conversations.
- x402 history holds verified references and amounts, or an explicit free result
  with no hash. Uncertain values never appear as confirmed spending or available
  balance.
- PayPal's session history is separate from its financial journal.
- Local dates are when this device observed a record, not the chain's block
  time.

Chat automatically lists signed network offers and refreshes them while the app
is open. Each paid listing identifies its seller and shows input and output
prices in devnet USDC per million tokens. Choose a seller and confirm the
displayed channel terms. The buyer verifies the seller and quote before sending
the first paid message. An expired listing or a changed price requires a fresh
selection.

A zero maximum per response blocks paid chat. Raise `request.maxAtomic` in the
buyer profile and restart the buyer. If you set a chat budget in Payments, its
remaining amount must cover that maximum. Choosing a seller does not change
either limit. A recorded answer approval counts toward the budget while
settlement is pending. The buyer supplies the deposit and duration shown in the
confirmation.

## Network contact

The renderer has no network access. The host process makes these contacts:

| Destination                                   | When                                                                                                     | How to turn it off                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `api.github.com` release list                 | At start and at most every 5 minutes, to show the update notice. It never downloads or installs anything | `GYBLOS_UPDATE_CHECK=0`                                                |
| Discovery index (`/v1/models`, `/v1/sellers`) | Model network checks and exact-ID lookups                                                                |                                                                        |
| Gyblos relays and sellers                     | While the local buyer runs                                                                               | Stop the buyer                                                         |
| Metrics collector                             | Packaged app only: the managed buyer uploads receipts and telemetry observations, as a release CLI does  | `GYBLOS_OBSERVATIONS=off` stops observations; receipts have no opt-out |
| Solana devnet RPC                             | The buyer's payment and identity checks                                                                  |                                                                        |
| Solana devnet explorer                        | Only when you open a payment reference                                                                   |                                                                        |
| PayPal Sandbox                                | Only during a PayPal Sandbox session                                                                     |                                                                        |

`GYBLOS_COLLECTOR_URL` from the launch environment overrides the collector
address. See [receipts](receipts.md) and [telemetry](telemetry.md) for what is
uploaded.

## Protected local wallet

The app creates its private data folder and starts the buyer without asking for
a folder and without touching protected custody. The wallet starts **locked**:
no address, backup-verification claim or balance is exposed. Passive status,
opening **Payments** and quitting with an unused wallet never consult OS
encryption.

Custody starts only on request:

1. In **Payments → Wallet details**, the user chooses **Set up or unlock
   wallet**.
2. A native explanation appears before any secure-storage availability check,
   encryption or decryption. **Continue** permits access; **Cancel** keeps free
   chat running with the wallet locked.
3. The OS may then prompt. On macOS, any "Gyblos Safe Storage" password goes
   only into the system dialog, never a Gyblos form. Windows normally uses the
   account's DPAPI without a prompt. Linux may ask to unlock GNOME Keyring or
   KWallet.

Denied or unavailable access is not retried until another explicit action.
Approved access creates an Ed25519 wallet only when its dedicated directory is
absent or empty. Existing state is read without creating another identity; a
missing original inside a retained wallet library never generates a replacement.
The active address and backup-verification metadata are checked again on
approved access in each new process and after each wallet operation, never by
background polling.

- The original wallet lives under
  `app.getPath('appData')/gyblos-wallet/wallet-v1`. Restored wallets get
  separate address-named stores in the wallet library, whose paths
  `@gyblos/config` owns. Only OS-encrypted private material is on disk.
- Chat and Connections receive only the public address and status. **Copy
  address** copies only the selected wallet's public address, through a narrow
  host action.
- The app queries no balance for this wallet.

> **Warning:** Funding is disabled in every state, including after backup
> verification or restore. Don't send funds to this wallet's address: the app
> cannot block an external transfer, and it has no supported way to spend or
> recover those funds.

Backup, verification and restore are described in
[Desktop wallet backup and restore](desktop-backup.md).

| Platform | Protection and limits                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Electron asynchronous `safeStorage` backed by Keychain. Continuity across distributed updates needs consistent code signing                                                                    |
| Windows  | Asynchronous `safeStorage` backed by DPAPI. This protects against other users, not other processes in the same account                                                                         |
| Linux    | Electron 45 synchronous `safeStorage`, restricted to the `gnome_libsecret` or KWallet backends. Missing, `basic_text` and unrecognized backends block creation; there is no plaintext fallback |

Linux uses the synchronous encryptor because it can identify the backend;
Electron 45 does not expose that for the asynchronous provider. Upgrading to
Electron 46, which removes the synchronous methods, requires migrating this
adapter. See
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

Durability:

- Existing, interrupted, corrupt or inaccessible wallet data is never silently
  replaced, and importing a backup does not repair it. It is kept for
  inspection.
- POSIX directories and files are owner-only and flushed. Windows relies on the
  user profile and DPAPI, without equivalent power-loss guarantees.
- Explicit unlocking is shared, and an orderly quit waits only for wallet work
  already started. After approval, an unresponsive OS secret-store prompt can
  delay quitting; an unused wallet never does.
- Plaintext is briefly present in main-process memory, and JavaScript strings
  cannot be reliably zeroed. This is not a Secure Enclave wallet.

### Wallet library

The Node-only `@gyblos/desktop/wallet-library` entry is composed by the host
session. It requires an existing protected wallet and never creates a
replacement for missing, partial or inaccessible custody.

- `summary()` returns only public addresses and statuses, always with
  `fundingEnabled: false`.
- `restore(bytes, password)` imports a backup into a separate address-named
  store and leaves the original and the active selection unchanged. Duplicates
  are refused.
- `select(address)` publishes an authenticated, OS-protected selection by atomic
  rename; that rename is the commit point.
- `verifyBackup(address, bytes, password)` reuses the identity-bound
  verification record. Restoring alone does not mark a backup verified.

A private directory lock serializes instances; a remaining lock reports busy and
is never stolen. Failed writes and incomplete destinations stay for inspection.
Missing or corrupt selection metadata, while the library directory exists, fails
closed instead of selecting another wallet. Deleting or rolling back the whole
library is not detected.

## Check and package

```sh
pnpm desktop:smoke
pnpm desktop:package
```

`desktop:smoke` runs the compatibility view in a hidden window. A utility
process loads the pinned Iroh binding and `@gyblos/node/lifecycle`, runs two
synthetic loopback echo cycles, closes both endpoints after each, and reports. A
pass has two cycles, two round trips and `closed: true`; any failure, including
a renderer that never calls the bridge, exits nonzero. The smoke has no relays,
discovery, engine, wallet, payment or remote access, and reads no node data.
Native failures are reported without raw SDK errors, identities or socket
addresses.

`desktop:package` builds an **unsigned** app for one target under
`apps/desktop/dist/packages/`, and its release archives with `.sha256` files
under `apps/desktop/dist/release/`:

| Target         | Archive                          | Built on   |
| -------------- | -------------------------------- | ---------- |
| `darwin-arm64` | `.zip` of `Gyblos.app`           | macOS only |
| `win32-x64`    | `.zip`                           | any OS     |
| `linux-x64`    | `.tar.gz`, and `.deb` (dpkg-deb) | any OS     |

```sh
pnpm desktop:package                       # this machine's target
pnpm desktop:package -- --target win32-x64
```

- Packaging stages compiled assets and the target's pinned Iroh binding; it
  copies no repository or operational directories. To build for another OS, add
  that platform to pnpm `supportedArchitectures` so its binding installs.
- No macOS x64 Iroh binding exists, so there is no Intel Mac package.
- The macOS app is sealed ad hoc, so Gatekeeper offers to open an app from an
  unidentified developer instead of reporting it damaged.
- The `.deb` installs to `/opt/Gyblos` and makes `chrome-sandbox` setuid root,
  which Electron's sandbox needs where unprivileged user namespaces are
  restricted (Ubuntu 24.04).
- The packaged executable accepts `--smoke` and needs no installed Node or
  workspace links.

`.github/workflows/desktop-packages.yml` builds all three targets, starts each
on its own OS with `--smoke` (the `.deb` installed with apt), and keeps them as
artifacts. It runs by hand, on pull requests that change `apps/desktop/scripts/`
or the workflow, and from `release-seller-image.yml`, which passes the tag and
attaches the archives to that GitHub release. The packages have no Developer ID
or code-signing certificate and no automatic updater, so Windows SmartScreen and
macOS Gatekeeper ask once before the first start.

## Limits

- Offline wallet tests use disposable keys and fake OS encryption. They do not
  prove native Keychain, DPAPI or Linux secret-store behavior, cross-platform
  recovery or signed-update continuity. The manual `desktop-platforms.yml`
  workflow covers the backup exchange between systems.
- Utility process start and stop have deadlines that request termination. A
  forced exit is never a clean stop, and there is no hard bound if the OS
  refuses to terminate a process.
- Process-crash recovery, Windows directory fsync and power-loss recovery of the
  wallet library are not established.
