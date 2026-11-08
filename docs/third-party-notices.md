# Third-party notices

The root Apache 2.0 license covers original Gyblos code. Third-party packages,
assets and marks retain their own terms. This inventory identifies bundled
material; it is not a grant of rights to another party's trademarks, hosted
services, model weights or datasets. Naming an integration does not license its
provider's brand assets.

## Bundled assets and fixtures

| Material                                    | Source and terms                                               | Preserved notice and provenance                                                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Geist text fonts                            | Vercel Geist, SIL Open Font License 1.1                        | [OFL](../apps/desktop/public/assets/Geist-OFL.txt); [bundled hashes and provenance limits](../apps/desktop/public/assets/font-sources.json)                                                                                          |
| JetBrains Mono text font and mark outlines  | JetBrains Mono, SIL Open Font License 1.1                      | [OFL](../apps/desktop/public/assets/JetBrainsMono-OFL.txt); text-font hash in the font inventory; mark derivation in the brand manifest                                                                                              |
| Model icons                                 | Lobe Icons, MIT, at the source revisions in the manifest       | [MIT](../apps/desktop/public/assets/models/lobe-icons-LICENSE.txt); [sources and hashes](../apps/desktop/public/assets/models/sources.json)                                                                                          |
| Claude Code, Codex, Exa and Firecrawl icons | Lobe Icons, MIT                                                | The same Lobe Icons notice; [sources and hashes](../apps/desktop/public/assets/tools/sources.json)                                                                                                                                   |
| Pi icon                                     | Official Pi press kit, MIT; Earendil Inc. and contributors     | [MIT notice](../apps/desktop/public/assets/tools/pi-LICENSE.txt); official endpoint and bundled hash in the tools manifest                                                                                                           |
| TinyFish icon                               | Official-site asset; TinyFish content and mark rights reserved | Source and hash in the tools manifest. No Apache or MIT license is asserted for this asset; redistribution requires applicable authorization or rights under the owner's terms. See [TinyFish terms](https://www.tinyfish.ai/terms). |
| Gyblos marks                                | Gyblos brand material; font-derived outlines as attributed     | [Brand provenance](../apps/desktop/public/assets/brand/sources.json); code licensing does not grant trademark rights                                                                                                                 |
| Qwen tokenizer fixtures                     | Pinned Qwen source, Apache 2.0                                 | [License](../tests/fixtures/Qwen-LICENSE); [fixture revision and hashes](../tests/fixtures/chat-template-vectors.json)                                                                                                               |

The font inventory records the exact bundled bytes and verified official source
URLs whose bytes match those hashes. The JetBrains Mono source is pinned to a
Git commit; the Geist sources are versioned Google Fonts distribution URLs,
which are not cryptographic Git revisions. These matches do not recover the
original download date or revision, which remain unknown where recorded as such.
Preserve these licenses with copied assets. Do not replace them with the
project's Apache notice.

## Dependencies and local modifications

Dependencies are versioned in workspace manifests and `pnpm-lock.yaml`; their
installed package license files remain authoritative. Preserve required notices
when redistributing their source or compiled output. An inventory of this source
tree does not establish license compliance of a future bundle or installer.

`packages/x402-upto-metered` retains its own Apache 2.0 `LICENSE` and `NOTICE`.
The local `@x402/svm` patch modifies upstream Apache 2.0 code to carry the
multi-recipient distribution; its exact upstream version and purpose are
recorded in `pnpm-workspace.yaml`. Preserve upstream attribution and identify
the Gyblos modification when distributing patched code. No upstream acceptance
is implied.

The Contributor Covenant text retains its source/version attribution links in
`CODE_OF_CONDUCT.md`.

## Public records and model names

Synthetic signing vectors and the deliberately curated public devnet fixtures
are described in the [test fixture policy](../tests/README.md#fixtures-policy).
Their privacy and correlation implications are reviewed separately from
copyright licensing. Do not add private prompts, responses, payment
authorizations, keys or raw captures as fixtures.

The model catalog lists names and capabilities. It does not distribute model
weights or grant their licenses. Operators and redistributors must check the
terms of the specific models, services and assets they choose.

## Native payment-channel test fixture

The test-only SBF fixture in `tests/fixtures/payment-channels-native.so` is
compiled from unmodified
[Solana Foundation payment-channels source](https://github.com/solana-foundation/payment-channels/tree/0c07d5751c8972abf6a219570a3f39a72f46f879),
under MIT. Its [license](../tests/fixtures/payment-channels-native-LICENSE.txt),
[build provenance and digest](../tests/fixtures/payment-channels-native.json),
and [rebuild procedure](paid-native-acceptance.md) are included. It is used only
in LiteSVM tests; it is not a deployment artifact or evidence of equivalence to
any public-network binary. LiteSVM and its native packages retain their upstream
licenses and are development dependencies only.
