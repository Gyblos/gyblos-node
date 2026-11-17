# Repository maintenance

How the public repository is maintained: who reviews and approves changes, the
branch model, the hosted checks and how dependencies are updated. Contributors
follow [CONTRIBUTING.md](../CONTRIBUTING.md); the binding rules are in
[AGENTS.md](../AGENTS.md#workflow-and-merges).

Repository setup and visibility procedures are a maintainer procedure kept
outside the repository. Keep dated checks, audit results and release decisions
in private maintainer records; never publish sensitive findings or raw logs
here.

## Review and approval

Contributors provide a bounded change, a reproduction and exact validation.
Maintainers triage issues, publish the decisions contributors need, arrange the
three independent reviews that `AGENTS.md` requires, and obtain the founder's
explicit approval before merging. Merge with merge commits. CI, an assistant or
an open PR never implies approval.

`CODEOWNERS` routes review to the maintainer. It does not replace the three
reviews. With one maintainer, branches require a PR and successful checks, not a
second human approval; revisit required review counts when another maintainer
joins. Grant the minimum permissions needed, review access before increasing it
and require MFA for accounts with sensitive access. Never share an account or
token for review.

Issues provide general support and design discussion. Maintain labels for bugs,
documentation, proposals, help wanted and good first issues. Label a task for
new contributors only when it has context, non-goals and an observable
completion criterion. Support and security response are best effort, with no
fixed deadline.

## Branch model and releases

- **`develop`** is the integration branch. Every PR targets it.
- **`main`** receives only release PRs from `develop`.
- **Release tags** (`vX.Y.Z`) are cut from `main`. Pushing a tag runs
  `release-seller-image.yml`, which builds, pushes and signs the seller image,
  builds the packaged seller and attaches the desktop packages to that release.
  Publishing the npm package is a separate, opt-in job.

Both `develop` and `main` are protected: changes arrive only through PRs, with
merge commits, and the required checks must pass on the current head. Direct
pushes, force pushes and branch deletion are blocked.

## Workflows

| Workflow (file)                                   | Runs on                                                 | Required |
| ------------------------------------------------- | ------------------------------------------------------- | -------- |
| CI (`ci.yml`)                                     | PRs into and pushes to `develop` and `main`             | yes      |
| Security (`security.yml`)                         | PRs into and pushes to `develop` and `main`             | yes      |
| Static analysis (`semgrep.yml`)                   | PRs into and pushes to `develop` and `main`             | yes      |
| AI review request, state and security review      | PRs into `develop` and `main`, when enabled             | no       |
| AI security baseline (`ai-security-baseline.yml`) | Manual                                                  | no       |
| Desktop packages (`desktop-packages.yml`)         | Manual, PRs that change desktop packaging, release tags | no       |
| Desktop platforms (`desktop-platforms.yml`)       | Manual                                                  | no       |
| Release seller image (`release-seller-image.yml`) | Release tags                                            | no       |

The required check contexts are `CI / check`, `Security / Secrets`,
`Security / Dependencies` and `Static analysis / Semgrep CE`. `CI / check`
passes only when every CI part (docs, static checks, tests, lab, build and the
Windows jobs) succeeded or was skipped.

- **CI** runs Linux checks plus targeted Windows checks.
- **Security** scans every commit a PR or push introduces with Gitleaks default
  rules, full redaction and no allowlist or baseline. Its dependency audit
  includes development dependencies and blocks high and critical advisories; an
  unavailable advisory service fails the check. Triage applicability before
  changing dependencies, and never hide a result with a forced bulk upgrade.
- **Static analysis** checks the tracked JS/TS/TSX snapshot against reviewed
  local Semgrep CE rules ([static-analysis.md](static-analysis.md)). Its stated
  coverage limits do not replace trust-boundary review or synthetic regressions.
- **AI review** workflows run an optional model-based source review; see
  [tooling/security-review/README.md](../tooling/security-review/README.md).
- **Desktop platforms** runs the broader wallet and backup-exchange checks on
  macOS, Windows and Linux. Run it before distributing the desktop app and after
  wallet, backup or restore changes.

### Stacked pull requests

A stacked child PR (based on another branch) intentionally runs none of the
required workflows. It still needs exact-head local checks, three independent
reviews and separate founder approval. Merge a stack top-down into each base,
then merge the bottom PR into `develop` only after its checks pass on the
current combined head. A missing or filtered check is not a passing check.

The branch filter reduces runs; it does not promise a single run. Opening,
updating or reopening the PR into `develop` can run workflows, as can the push
to `develop`. For a local-only task, new commits use `[skip ci]`; report remote
checks as not run, leave the PR open, and never bypass protections or trigger
workflows without authorization.

## Actions security

- Default Actions tokens are read-only and cannot approve PRs.
- Workflows from outside collaborators need approval before they run, on
  GitHub-hosted runners, with no secrets, write tokens or persistent
  credentials.
- Pin third-party actions by commit SHA.
- Never use `pull_request_target` to run PR code. `ai-review-state.yml` uses it
  only to clear labels without checking out the PR; see
  [tooling/security-review/README.md](../tooling/security-review/README.md).
- The Semgrep CE scanner runs with read permissions, without network access or
  credentials, and never builds or runs product source. Do not add secrets or
  environment credentials to the required checks.
- Keep auto-merge disabled.

## Dependency updates

Dependabot proposes weekly npm and GitHub Actions updates, grouping minor and
patch versions. A proposal never authorizes an automatic merge.

The locally patched `@x402/svm` needs a maintainer-led update. The patch and its
upstream status are described next to its entry in `pnpm-workspace.yaml`. An
automated upgrade can fail with `ERR_PNPM_UNUSED_PATCH` because it leaves the
patch for the previous version unused. That is an update-generation failure, not
a vulnerability or a broken install of the pinned version. Never delete the
patch, allow unused patches or add an ignore rule to make that update succeed. A
manual update must port the patch or show that upstream replaces it, keep the
recipient-distribution and recovery behavior, and pass the normal reviews and
checks. Triage any advisory separately.

## Distribution

Opening the source promises no stable release, binary distribution or backport
support. Before distributing desktop binaries, run the desktop platform and
backup-exchange checks, verify the actual keystore, review bundled licenses
([third-party-notices.md](third-party-notices.md)) and prepare a signing,
provenance and update policy. Keep experimental limitations visible in
[limitations.md](limitations.md).
