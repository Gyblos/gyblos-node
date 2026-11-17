# Static analysis

The `Static analysis / Semgrep CE` check blocks dangerous JavaScript and
TypeScript patterns, such as `eval`, shell execution, disabled TLS verification
or unsafe Electron preferences. It is a required check on pull requests into and
pushes to `develop` and `main`.

It runs Semgrep Community Edition 1.183.0, pinned by image digest in
[the workflow](../.github/workflows/semgrep.yml), against eight local rules. It
needs no Semgrep account or paid product, and reports as an ordinary Actions
check, without hosted SARIF alerts or cloud analysis.

## When the check fails on your PR

1. Open the failed job log. It lists each finding's rule ID, file and line, not
   the matched source.
2. Find the rule in the table below and replace the pattern with a safe
   alternative. The safe cases in [probes.json](../tooling/semgrep/probes.json)
   show what each rule accepts.
3. If the job failed on accounting instead of a finding (an analysis error, a
   tracked symlink, a file over the size limits, a path mismatch), fix the
   input; the log names the reason.
4. If you believe a rule is wrong, say so in the PR. A rule change is reviewed
   as code, in its own change, with its positive and safe-alternative probes.

Never add `nosemgrep`, a baseline or an allowlist: inline suppressions are
disabled and the job has none.

## Rules and scope

[The eight local rules](../tooling/semgrep/rules.json) are original Apache-2.0
project content. No upstream registry rule pack is copied or downloaded.

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

The inventory comes from NUL-delimited `git ls-files`. Every tracked `.ts`,
`.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` file (product, lab, tests and tooling)
is projected into a temporary source-only directory. Dependencies, Git metadata,
local state and ignore or config files are not copied.

The job fails on:

- any finding, of any severity;
- a malformed report, an analysis error or a skipped rule;
- a mismatch between the paths Git lists and the paths Semgrep scanned;
- tracked symlinks or hard links, unsupported file types or an empty inventory;
- files beyond the limits: 4 MiB per file, 64 MiB in total and 5,000 code files.
  The repository has about 2,100 tracked code files.

Inline `nosemgrep` suppressions, Git ignore filtering and the scanner's default
size filter are disabled, and an explicit empty ignore file replaces the default
ignores.

## Coverage verification

Before scanning the repository, [the runner](../tooling/semgrep/check.py) checks
[positive and safe-alternative probes](../tooling/semgrep/probes.json) against
the pinned engine. Every rule has a positive case, and findings must match the
expected rule IDs and paths exactly. Probes cover TSX, process-import aliases,
`tests/`, minified filenames, a source larger than the default scanner limit and
an inline suppression comment. Malformed TS, TSX and JS sources must report
analysis errors, and incomplete-report cases and a tracked symlink exercise the
accounting guards. Probes are scanner input as text; none is executed.

The scanner runs with no network, login, repository token or Docker socket. Its
inputs are mounted read-only and its only writable space is bounded temporary
scratch. Metrics and version checks are off, and CPU, memory, process, file-size
and wall-clock limits apply. The helper runs repository tooling, never product
code.

## Known limits

- This is a bounded pattern check, not CodeQL-equivalent coverage or a
  vulnerability audit. It does not establish inter-file or interprocedural
  dataflow safety. Computed or obfuscated APIs, untested import forms and
  patterns outside the eight rules can be missed.
- Target accounting does not prove every file was fully parsed. With normal
  semantic prefiltering, Semgrep can skip parsing a file that has no relevant
  token; three malformed probes without keywords record this limit. Typecheck
  and lint stay independent checks.
- Valid TypeScript such as `export type *` and import-type queries has parser
  gaps in this version
  ([upstream issue](https://github.com/semgrep/semgrep/issues/11871)). A
  compatibility probe checks the known type-only star-export rejection, and a
  relevant pattern in an unsupported form fails until it is resolved.
- The check says nothing about signatures, payment arithmetic, authorization,
  journal recovery, backup custody, native code, dependencies or secrets.
  Reviews, protocol vectors, regression tests, Gitleaks and the dependency audit
  cover those. Python, workflow files and other non-JS/TS source need normal
  review.

## Run it locally

You do not need to: `pnpm check` and `pnpm desktop:build` are the ordinary
contribution checks. To reproduce the scan, you need Docker with Linux
containers, Git and GNU `timeout` (`gtimeout` from coreutils on macOS). Use a
fresh disposable clone or worktree with no real ignored `.local` or `.env`
state, then run from its root:

```sh
export GITHUB_WORKSPACE="$PWD"
export RUNNER_TEMP="$(mktemp -d)"
export SEMGREP_IMAGE="$(sed -n 's/^ *SEMGREP_IMAGE: //p' .github/workflows/semgrep.yml)"
docker pull "$SEMGREP_IMAGE"
```

Then run the `Verify rule probes and scan every tracked JS/TS/TSX file` block
from [the workflow](../.github/workflows/semgrep.yml) unchanged. No project
install, wallet, secret, engine or service is used.

## Updating the scanner or rules

- Update the image version and digest together after reviewing the upstream
  release, run the full scan and compare exact file counts.
- Review rule and probe changes as code. A changed rule keeps its positive and
  nearby safe-alternative cases; never remove a positive probe or suppress a
  finding to make CI pass.

References: [CE engine source](https://github.com/semgrep/semgrep),
[CLI reference](https://docs.semgrep.dev/cli-reference),
[ignore behavior](https://docs.semgrep.dev/ignoring-files-folders-code).
