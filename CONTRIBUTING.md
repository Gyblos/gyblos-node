# Contributing

Use English for source, comments, commit messages and pull requests.

## Layout

- `@gyblos/config` owns network, host, path, version and limit constants.
- `@gyblos/runtime` owns process supervision and JSON file operations.
- `@gyblos/gate` owns local gate configuration, journals, locking, measurements and chain observations.
- `@gyblos/application` owns reusable accounting and observation rules.
- `@gyblos/payments-x402` adapts the pinned payment SDK.
- `@gyblos/inference-ollama` owns local generation and independent token counting.
- Apps compose these packages. Scripts are thin, explicitly invoked entrypoints.

Import package APIs through `@gyblos/*`; keep apps and packages independent of `scripts/`. Group imports as Node built-ins, external dependencies, workspace packages, then relative modules. Prettier sorts these groups.

Keep modules below 300 lines, or explain a necessary exception in the PR. Keep signals, child processes, network requests and mutable run state inside explicitly invoked functions. Importing an entrypoint must be inert.

## Checks

Install with `pnpm install --frozen-lockfile`, then run `pnpm typecheck` and `pnpm lint`. Pin added dependencies to exact versions and verify that their releases are at least two weeks old.

The current publication policy keeps acceptance tests, evidence and measurements in the maintainer checkout. Run the private acceptance harness appropriate to the branch and record its result in the PR; those files and their commands are not available in a clean clone. Preserve existing assertions when refactoring.

Use coherent commits that compile and pass the applicable private baseline. Order dependencies before consumers. A behavior-preserving refactor must preserve prices, tolerance, payment states, errors, retry ownership, evidence fields and delivery semantics. Keep functional changes in separate PRs.

The unpaid `pnpm gate:challenge` can compare the 402 contract before and after a refactor. Time, blockhash and slot metadata naturally change. A challenge does not prove payment or refund; a paid gate requires task authorization and confirmed on-chain evidence.

Never commit local keys, salts, signed payloads, journals, measurements, evidence, private tests or internal product documents. Product documentation lives in the separate local Gyblos vault. README and this contribution guide are the public documentation exceptions.
