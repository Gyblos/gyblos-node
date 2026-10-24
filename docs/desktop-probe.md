# Desktop preview and compatibility probe

An experimental macOS Apple Silicon Electron app, built inside this workspace.
The normal window reuses the approved mockup's Chat, shared controls, searchable
model/tool dropdowns, history, motion, SVG signature, palette and local artwork.
Connect reuses its tool list and model/budget editor; no external tool is
launched. Models, Activity, demo wallet, Settings, appearance, the adjustable
sidebar and full-width status footer use the same mockup components and styles.

Chat responses stream synthetic text. Stop preserves the generated prefix; new
chats and history keep their own drafts. Switching Chat/Connect preserves
mounted conversation state. All conversations, theme choices and connection
budgets are in memory and clear when the app closes. They are not saved to the
product home.

The five sample models, prices, free labels and connection budgets are
illustrative, not live availability, payment authorization or enforced tool
spending limits. The chat daily-limit check uses demo credits only. The footer
explicitly labels the connection as simulated and the wallet as a demo. The
synthetic address cannot receive funds; copying it may be unavailable under
Electron isolation. No inference, web tool, gateway, wallet, existing
configuration or remote network is used by this UI.

## Run locally

Use Node 22+ and the repository's pinned pnpm. After a frozen install:

```sh
pnpm desktop:start
```

The app creates a fresh temporary Chromium profile and retains renderer
isolation and network denial. Normal Chat does not invoke native services. The
separate `--smoke` mode mounts the compatibility view and its one fixed IPC
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

This is not a signed/notarized installer, release, updater or final stack
adoption. Windows, Intel Mac, real P2P connectivity, application recovery and
real inference, authenticated Connect and persistent conversation storage remain
outside this preview. Generated apps, captures and run evidence stay outside
Git. The normal root checks cover its TypeScript/TSX, lint rules and synthetic
summary/lifecycle regressions; Electron packaging is a separate
platform-specific check.
