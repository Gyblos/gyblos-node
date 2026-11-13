# Static analysis

The `Static analysis / Semgrep CE` workflow runs on pull requests into `main`
and pushes to `main`. It uses Semgrep Community Edition 1.183.0, pinned by the
official multi-platform image digest in
[the workflow](../.github/workflows/semgrep.yml). No Semgrep account, paid
GitHub security product or subscription is required. Private-repository Actions
usage still counts against the plan's included usage. This job reports its
result as an ordinary Actions check, without hosted SARIF alerts or cloud
analysis.

## Rules and scope

[The eight local rules](../tooling/semgrep/rules.json) are original Apache-2.0
project content. JavaScript and TypeScript rules cover the projected JS/TS/TSX
inputs, with all three extensions exercised by the probes. No upstream registry
rule pack is copied or downloaded.

| Rule                          | Checked pattern                                                             |
| ----------------------------- | --------------------------------------------------------------------------- |
| `gyblos.dynamic-eval`         | Direct `eval` and `globalThis.eval` calls                                   |
| `gyblos.function-constructor` | `Function` calls and constructors                                           |
| `gyblos.shell-exec`           | Imported Node child-process `exec` and `execSync`, including tested aliases |
| `gyblos.shell-option`         | Object options enabling `shell: true`                                       |
| `gyblos.tls-verification`     | Disabled certificate verification and Node's TLS environment bypass         |
| `gyblos.electron-preferences` | Explicitly unsafe Electron isolation, sandbox and web-security preferences  |
| `gyblos.raw-html`             | `innerHTML` assignment and React raw-HTML props                             |
| `gyblos.weak-hash`            | Named imports of lowercase `md5`/`sha1` hashing from Node crypto            |

The source inventory comes from NUL-delimited `git ls-files`. Every tracked
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` file is projected into a
temporary source-only directory, including product, lab, tests and tooling.
Dependencies, Git metadata, local state and ignore/config files are not copied.
Tracked symlinks/hard links, unsupported file types, empty inventories and files
beyond the reviewed limits fail instead of silently reducing coverage. The
limits are 4 MiB per file, 64 MiB in total and 5,000 code files.

An explicit empty ignore file overrides the selected frontend's default ignores.
Inline `nosemgrep` suppressions, Git ignore filtering and the scanner's default
size filter are disabled. The minified-filename probe is included; any omission
fails target accounting. Findings of any severity, malformed reports, analysis
errors, skipped rules or a mismatch between Git's expected paths and Semgrep's
scanned paths fail the job. There is no baseline or allowlist.

## Coverage verification

Before scanning the repository, [the runner](../tooling/semgrep/check.py) checks
[positive and safe-alternative probes](../tooling/semgrep/probes.json) against
the real pinned engine. Every rule must have a positive case, and exact findings
must match the expected rule IDs and paths. Probes include TSX, process-import
aliases, `tests/`, minified filenames, a source larger than the default scanner
limit and an inline suppression comment. Three malformed TS/TSX/JS sources with
a relevant token only in a comment must report analysis errors, without relying
on a security finding to fail. Six incomplete-report cases and a tracked symlink
verify the accounting guards. These are scanner inputs as text; none of the
sample code is executed.

The scanner has no network, login, repository token or Docker socket. Its input
mounts are read-only and its only writable workspace is bounded temporary
scratch. Metrics and version checks are disabled. CPU, memory, process,
file-size and wall-clock limits are enforced. The helper executes repository
tooling, not product code. Logs contain finding identifiers and locations, not
matched source snippets. No paid Semgrep engine, registry fetch, autofix or
analysis upload is used.

The pinned release explicitly selects its supported legacy frontend with normal
semantic rule prefiltering. Target accounting is not proof that every AST was
fully parsed. Three separate no-keyword malformed probes demonstrate that CE can
process a path without syntax-validating it; they record a known limit, not
successful syntax coverage. Typechecking and lint remain independent checks.

## Limits

These rules are a bounded pattern-based security check, not CodeQL-equivalent
coverage or a complete vulnerability audit. Valid TypeScript constructs such as
`export type *` and import-type queries have parser gaps in this version. Normal
semantic prefiltering can avoid parsing a file without relevant patterns; no
reported parser errors are suppressed or filtered. Adding a relevant pattern to
an unsupported source form must fail until the incompatibility is resolved. An
additional compatibility probe checks the known type-only star-export rejection.
See the
[upstream parser issue](https://github.com/semgrep/semgrep/issues/11871). CE
does not establish inter-file or general interprocedural dataflow safety.
Computed/obfuscated APIs, untested import forms and patterns outside these eight
rules can be missed. Recognized safe-looking syntax is not proof that runtime
input is trusted.

The job does not prove signatures, payment arithmetic, authorization, journal
recovery, backup custody, native/Rust security, dependency safety or absence of
secrets. Independent reviews, protocol vectors, regression tests, Gitleaks and
dependency auditing retain their separate responsibilities. Source outside the
listed JavaScript/TypeScript extensions, including this Python helper and
workflow configuration, requires normal review and appropriate other checks.

## Local reproduction and updates

Ordinary contribution checks remain `pnpm check` and `pnpm desktop:build`. Local
scanner reproduction is optional and needs Docker with Linux containers, Git and
GNU `timeout`. Use a fresh disposable clone/worktree without real ignored
`.local` or `.env` state. Set `GITHUB_WORKSPACE` to the absolute checkout path,
`RUNNER_TEMP` to a new temporary directory and `SEMGREP_IMAGE` to the exact
pinned value in the workflow. Run its `Fetch pinned scanner` and
`Verify rule probes and scan every tracked JS/TS/TSX file` command blocks. The
image is fetched before the scanner's offline container starts. No project
installation, wallet, environment secret, engine or operational service is used.

Update the image version and digest together after reviewing the upstream
release. Review rule/probe changes as code, run the full scan and compare exact
file counts; never remove a positive probe or suppress a finding to make CI
pass. A changed rule must retain its positive and nearby safe-alternative cases.
See the [CE engine source](https://github.com/semgrep/semgrep),
[CLI reference](https://docs.semgrep.dev/cli-reference) and
[ignore behavior](https://docs.semgrep.dev/ignoring-files-folders-code).
