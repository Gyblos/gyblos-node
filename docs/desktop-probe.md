# Desktop compatibility probe

An experimental macOS Apple Silicon Electron window, built inside this
workspace. It extracts the approved mockup's compact shell, palette and Gyblos
SVG marks; it does not migrate the full mockup or implement Chat/Connect.

## Run locally

Use Node 22+ and the repository's pinned pnpm. After a frozen install:

```sh
pnpm desktop:start
```

The app creates a fresh temporary Chromium profile. Its sandboxed renderer has
one fixed IPC operation. A utility process imports the pinned Iroh binding and
`@gyblos/node/lifecycle`, performs two synthetic loopback echo cycles, closes
both endpoints after each cycle, reports a closed summary and exits after the
parent acknowledges receipt. No CLI output is parsed to control the app.

There is no relay/discovery preset, external engine, wallet, payment, gateway or
remote access. No existing node data is read. Closing the window stops its
worker; interruption reports failure rather than claiming graceful cleanup.

## Check and package

```sh
pnpm desktop:smoke
pnpm desktop:package
```

The smoke runs the same renderer/preload/IPC/worker path in a hidden window and
exits nonzero on failure, including a renderer that never calls the bridge. A
successful result has two cycles, two round trips and `closed: true`. Timeouts
cover startup and request worker termination at its deadline. An
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
production Chat/Connect remain outside this compatibility probe. Generated apps,
captures and run evidence stay outside Git. The normal root checks cover its
TypeScript/TSX, lint rules and synthetic summary/lifecycle regressions; Electron
packaging is a separate platform-specific check.
