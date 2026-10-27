---
name: gyblos-code-map
description: Where code goes in gyblos-node and how to add a package. Use before creating, moving or splitting a module, adding a package/adapter/app, deciding which package owns a value or type, or when a boundaries/lint check fails with "Unmapped source package" or an adapter/app independence rule.
---

# Gyblos code map

The binding rules are in `AGENTS.md` (Layers and ownership, Hard rules) and the
style details in `docs/code-standards.md`. This skill only helps apply them. If
they disagree, `AGENTS.md` and `tooling/boundaries/config.ts` win.

## 1. Pick the layer (first match wins)

1. Bytes on the wire, signing domains, record/offer shapes, parsers, golden
   vectors? -> `packages/protocol` (no imports of other workspaces, no SDKs, no
   fs). Changing an existing wire value needs a new protocol version, not a
   refactor.
2. Pure decision over protocol values (pricing, metering, offer trust, quote
   creation/acceptance, control admission, seller selection)? ->
   `packages/core` (protocol + config/runtime only; no SDK, no fs, no
   clock/random of its own: take `now`/a clock and a random source as inputs).
3. Talks to one external system (Ollama, x402/Solana, Iroh, 8004 registry, an
   HTTP index)? -> an adapter `packages/<kind>-<name>`. It may use protocol,
   core, config, runtime and its SDK; never another adapter, `node` or apps.
4. Composes adapters into a running local node for either role (lifecycle,
   roles/keys, seller HTTP, facilitator, control startup)? -> `packages/node`.
5. A process the user starts or deploys (CLI flags, proxy, reconcile, Electron,
   a Worker)? -> `apps/node`, `apps/buyer`, `apps/desktop` or
   `apps/discovery-index`. Apps never import each other; shared logic moves down
   to `packages/node` or core.
6. Operator-changeable value (port, limit, timeout, relay, index URL) or a local
   path? -> `packages/config` (`src/home.ts` for paths). Fixed operational
   values stay in the owning package's `constants.ts`.
7. Platform helper with no product meaning (atomic JSON, private logs,
   processes, memory, loopback guard)? -> `packages/runtime` (config only).
8. Devnet funding, gate runs, exact scheme, lab facilitator, evidence? -> `lab/`
   (may import anything; nothing in product imports it).
9. Offline test -> `tests/*.test.ts` (product, public entries only),
   `tests/lab/` (lab code), helpers in `tests/support/` (no cases); tooling
   tests in `tooling/**/*.test.ts`.

Splitting by concern inside a package uses a filename prefix, as in
`packages/protocol/src/control-*.ts`, `packages/core/src/seller-selection-*.ts`,
`packages/transport-iroh/src/control-{client,server,io}.ts` and
`apps/buyer/src/selection-*.ts`.

## 2. Worked examples from the tree

| Code                                        | Lives in                                                        | Why                                              |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| `selectSellers` filters + weighted sampling | `packages/core/src/seller-selection*.ts`                        | pure policy; caller passes `now`, random, stats  |
| control request framing/validation          | `packages/protocol/src/control-*.ts`, `vectors/control-v2.json` | wire contract                                    |
| `createControlQuote` / `acceptControlQuote` | `packages/core/src/control-quotes.ts`                           | pure quote policy, no adapter                    |
| `ControlAdmission` leases                   | `packages/core/src/control-admission.ts`                        | pure policy with an injected clock               |
| Iroh control client/server                  | `packages/transport-iroh/src/control-*.ts`                      | Iroh I/O only                                    |
| seller control startup/readiness            | `packages/node/src/control-*.ts`                                | composes transport + core                        |
| seller facilitator wiring                   | `packages/node/src/seller.ts`                                   | composition of `payments-x402`                   |
| buyer selection proxy, offer race           | `apps/buyer/src/selection-proxy.ts`, `offer-race.ts`            | executable wiring                                |
| discovery index client                      | `packages/discovery-http`                                       | HTTP adapter; index defaults in `config`         |
| discovery index server (Worker)             | `apps/discovery-index`                                          | deployable app; verification via protocol only   |
| `GYBLOS_HOME` / `GYBLOS_LAB_HOME` layout    | `packages/config/src/home.ts`                                   | single path owner                                |
| `gyblos.toml` validator, precedence         | `packages/node/src/node-config*.ts`, `packages/node/schemas/`   | node composes adapter URL policies; GYB-DOC-026  |
| `gyblos` CLI (`config validate`)            | `apps/node/src/cli.ts`                                          | executable entry; output never prints env values |
| devnet wallet config, `gate:*`              | `lab/harness`                                                   | lab-only                                         |

## 3. Add a package, adapter or app

1. Name it so `layerOf` in `tooling/boundaries/config.ts` maps it: adapters
   must match `payments-*|identity|engine-*|transport-*|discovery-*|telemetry-*`. Any
   other new package name fails with "Unmapped source package"; extending the
   map is a tooling change with a case in `tooling/boundaries/check.test.ts`.
   Every `apps/<name>` maps to the apps layer and gets its own independence
   rule automatically.
2. `package.json`: `"name": "@gyblos/<name>"`, `"private": true`,
   `"type": "module"`, explicit `exports` (`"./x": "./src/x.ts"`),
   `workspace:*` deps only on allowed layers, SDK versions pinned exactly (see
   `packages/discovery-http/package.json`).
3. Add `"@gyblos/<name>": "workspace:*"` to the root `package.json`, run
   `pnpm install` and commit the lockfile. `packages/*` and `apps/*` are already
   in `pnpm-workspace.yaml`; a new `lab/*` package is not.
4. Every module starts with a 1-3 line header (responsibility + boundary it must
   not cross); codes in `constants.ts` (`as const`), typed errors in
   `errors.ts`.
5. Tests in `tests/<name>*.test.ts` via public exports; fixtures in
   `tests/support/`. Write the failing case first.
6. Docs: one row in `docs/architecture.md`, a topical `docs/<name>.md` if it has
   a contract, and a README link. `AGENTS.md` describes adapters by the regex,
   so it changes only for a new adapter kind or layer.
7. `pnpm check` (typecheck incl. desktop renderer; lint = eslint + prettier +
   tooling tests + boundaries; product + lab tests). Report exact counts.

## 4. When a check fails

- `adapter-X-is-independent` / `app-X-is-independent`: move shared code down
  (core or node); do not re-export across.
- `package-boundaries` (eslint): a relative import left its package; import by
  `@gyblos/<name>/<export>` and add the export.
- `Unresolved import`: the target is not in the package's `exports`.
- `Unmapped source package`: see step 3.1.
- Never silence a rule, add a baseline or cast to pass.
