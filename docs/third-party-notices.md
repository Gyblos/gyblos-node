# Third-party notices

The root Apache 2.0 license covers original Gyblos code. Third-party packages,
assets and marks keep their own terms. This page lists the third-party material
bundled in this repository and where its notice lives. It grants no rights to
another party's trademarks, hosted services, model weights or datasets, and
naming an integration does not license its provider's brand assets.

When you copy a bundled asset, keep its license file with it. Never replace a
third-party license with the project's Apache notice.

## Fonts

| Font                       | Where it ships                                                                | Terms and notice                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instrument Sans            | Desktop app (`apps/desktop/public/assets`), docs site (`apps/docs/app/brand`) | SIL Open Font License 1.1: [desktop OFL](../apps/desktop/public/assets/InstrumentSans-OFL.txt), [docs OFL](../apps/docs/public/brand/InstrumentSans-OFL.txt)       |
| Geist                      | Desktop app (`geist-400/500/600.ttf`)                                         | SIL Open Font License 1.1: [OFL](../apps/desktop/public/assets/Geist-OFL.txt)                                                                                      |
| JetBrains Mono             | Desktop app, docs site                                                        | SIL Open Font License 1.1: [desktop OFL](../apps/desktop/public/assets/JetBrainsMono-OFL.txt), [docs OFL](../apps/docs/public/brand/JetBrainsMono-OFL.txt)         |
| Geist Mono (outlines only) | Docs site Gyblos symbol                                                       | SIL Open Font License 1.1: [OFL](../apps/docs/public/brand/GeistMono-OFL.txt); see the [brand attribution](../apps/docs/public/brand/gyblos-brand-attribution.txt) |

The desktop font inventory,
[font-sources.json](../apps/desktop/public/assets/font-sources.json), records
each bundled file's hash and a verified source URL whose bytes match it; where
the original download revision is unknown, the inventory says so. The docs
site's bundled font hashes are in
[brand-assets.json](../apps/docs/brand-assets.json). The explorer
(`apps/explorer`) loads Instrument Sans and JetBrains Mono through
`next/font/google` at build time and bundles no font file in the repository.

## Icons and marks

| Material                                    | Terms                                                                                       | Notice and provenance                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model icons (desktop)                       | Lobe Icons, MIT                                                                             | [MIT](../apps/desktop/public/assets/models/lobe-icons-LICENSE.txt); [sources and hashes](../apps/desktop/public/assets/models/sources.json)                                                                                                                                                                                                                                  |
| Model icons (explorer)                      | Lobe Icons, MIT                                                                             | [MIT notice](../apps/explorer/public/models/LICENSE); monochrome icons of `@lobehub/icons-static-svg` 1.103.0                                                                                                                                                                                                                                                                |
| Claude Code, Codex, Exa and Firecrawl icons | Lobe Icons, MIT                                                                             | The same Lobe Icons notice; [sources and hashes](../apps/desktop/public/assets/tools/sources.json)                                                                                                                                                                                                                                                                           |
| OpenCode icon (desktop)                     | OpenCode, MIT                                                                               | [MIT notice](../apps/desktop/public/assets/tools/opencode-LICENSE.txt); source and hash in the tools manifest                                                                                                                                                                                                                                                                |
| Pi icon (desktop)                           | Official Pi press kit, MIT; Earendil Inc. and contributors                                  | [MIT notice](../apps/desktop/public/assets/tools/pi-LICENSE.txt); source and hash in the tools manifest                                                                                                                                                                                                                                                                      |
| TinyFish icon (desktop)                     | TinyFish content and mark rights reserved                                                   | Source and hash in the tools manifest. No open-source license is asserted; redistribution needs rights under the [TinyFish terms](https://www.tinyfish.ai/terms).                                                                                                                                                                                                            |
| OpenAI, Cursor and Claude icons (docs site) | Fumadocs UI paths, MIT; Simple Icons, CC0-1.0                                               | [Provider icon attribution](../apps/docs/public/third-party-icons.txt)                                                                                                                                                                                                                                                                                                       |
| USDC and Solana marks (explorer)            | USDC icon from cryptocurrency-icons, CC0-1.0; Solana mark under the Solana brand guidelines | [Sources](../apps/explorer/public/tokens/SOURCES.txt). They name the token and the network only; trademarks stay with Circle and the Solana Foundation.                                                                                                                                                                                                                      |
| Gyblos marks                                | Gyblos brand material; font-derived outlines as attributed                                  | Desktop [brand provenance](../apps/desktop/public/assets/brand/sources.json); docs [brand attribution](../apps/docs/public/brand/gyblos-brand-attribution.txt); the explorer's icons and link preview (`apps/explorer/app`) are the website's, with the same [attribution](../apps/explorer/public/gyblos-brand-attribution.txt). Code licensing grants no trademark rights. |

## Test fixtures

| Material                       | Terms                                   | Notice and provenance                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen tokenizer fixtures        | Pinned Qwen source, Apache 2.0          | [License](../tests/fixtures/Qwen-LICENSE); [revision and hashes](../tests/fixtures/chat-template-vectors.json)                                                                                                                        |
| Native payment-channel program | Solana Foundation payment-channels, MIT | [Program license](../tests/fixtures/payment-channels-native-LICENSE.txt), [five8 license](../tests/fixtures/payment-channels-native-five8-LICENSE.txt), [build provenance and digest](../tests/fixtures/payment-channels-native.json) |

The test-only SBF program `tests/fixtures/payment-channels-native.so` is
compiled from unmodified
[Solana Foundation payment-channels source](https://github.com/solana-foundation/payment-channels/tree/0c07d5751c8972abf6a219570a3f39a72f46f879).
Its MIT and MIT-or-Apache-2.0 compiled components are listed in the
[dependency inventory](../tests/fixtures/payment-channels-native-dependencies.json),
and the rebuild procedure is in
[lab/docs/paid-native-acceptance.md](../lab/docs/paid-native-acceptance.md#fixture-provenance-and-rebuild).
It runs only in LiteSVM tests. It is not a deployment artifact or evidence of
equivalence to any public-network program. LiteSVM and its native packages keep
their upstream licenses and are development dependencies only.

Synthetic signing vectors and the curated public devnet fixtures are described
in the [test fixture policy](../tests/README.md#fixtures-policy). Their privacy
is reviewed separately from licensing. Never add private prompts, responses,
payment authorizations, keys or raw captures as fixtures.

## Dependencies and local modifications

Dependencies are versioned in workspace manifests and `pnpm-lock.yaml`; each
installed package's license file is authoritative. Keep required notices when
you redistribute their source or compiled output. This inventory covers the
source tree; it does not establish the license compliance of a bundle or
installer built from it.

- **Desktop builds** redistribute Electron and Chromium. The packaging script
  (`apps/desktop/scripts/package.ts`) generates no separate notices file, so
  review the bundled licenses before distributing a build
  ([repository maintenance](repository-maintenance.md#distribution)).
- **`packages/x402-upto-metered`** keeps its own Apache 2.0 `LICENSE` and
  `NOTICE`.
- **The local `@x402/svm` patch** modifies upstream Apache 2.0 code. Its
  upstream version, what it changes and its upstream status are recorded next to
  its entry in `pnpm-workspace.yaml`. Keep upstream attribution and identify the
  Gyblos modification when you distribute patched code. No upstream acceptance
  is implied.
- **Explorer components** in `apps/explorer/components/board` are adapted from
  BoardUI's free components (MIT); its notice is kept in
  [LICENSE](../apps/explorer/components/board/LICENSE). The BoardUI files
  vendored in `apps/explorer/boardui` keep the same notice in
  [LICENSE](../apps/explorer/boardui/LICENSE), with their
  [sources](../apps/explorer/boardui/SOURCES.txt).
- **The Contributor Covenant** text keeps its source and version attribution in
  `CODE_OF_CONDUCT.md`.

## Model names

The model catalog lists names and capabilities. It does not distribute model
weights or grant their licenses. Operators and redistributors must check the
terms of the models, services and assets they choose.
