# Repository maintenance and opening checklist

The initial maintainer is
[@gilbertsahumada](https://github.com/gilbertsahumada). This guide describes
maintenance responsibilities and the checks for a public repository. A checklist
item is not evidence that a GitHub setting is enabled. Keep dated checks, audit
results and release decisions in private maintainer records; do not publish
sensitive findings or raw logs here.

## Contribution and review responsibilities

Contributors provide a bounded change, reproduction and exact validation as
described in the contribution guide. Maintainers triage issues, publish
decisions needed by contributors, arrange the three independent reviews in
`AGENTS.md`, and obtain the founder's explicit approval before merging. Use
merge commits; do not infer approval from CI, an assistant or an open PR.

`CODEOWNERS` routes review to the initial maintainer. It does not replace those
reviews or add another human maintainer. With one maintainer, require a PR and
successful checks without configuring an impossible approval by a second human.
Revisit required human review counts when another maintainer joins. Grant the
minimum permissions needed, review access before increasing it and require MFA
for accounts with sensitive access. Never share an account or token for review.

Issues provide general support and design discussion. Maintain labels for bugs,
documentation, proposals, help wanted and good first issues. Label a task for
new contributors only when it has context, non-goals and an observable
completion criterion. Support and security response are best effort, with no
fixed deadline.

## Before changing visibility

- Fix the candidate commit and inventory every remote branch and tag, including
  commits outside `main`. Review all newly visible issues, PRs, reviews,
  attachments, releases, workflow history and available artifacts. Record
  expired or inaccessible material explicitly.
- Scan history with a pinned, verified local secret scanner and complete
  redaction, then review matches in context. Classify synthetic test values and
  public hashes using evidence. No clean scan proves absence of secrets. Revoke
  confirmed credentials before opening; do not rewrite history or delete
  branches without separate authorization.
- Review correlation in devnet evidence, Git authorship and operational resource
  metadata. Record the owner's publication decisions privately without copying
  sensitive values into the repository.
- Verify licensing and preserved third-party notices, public contribution paths,
  support, conduct and the private security reporting procedure.
- Verify installation and checks on the candidate revision; record platform,
  versions, exact suite counts, skips and omissions. Repeat checks for a new
  concern or changed input, not merely to refresh a date.
- Inspect actual Actions permissions, fork policy, runners, environment
  protections and secret access. Source YAML cannot establish hosted settings.
  Require approval before workflows from outside collaborators run; do not
  provide them secrets, write tokens, persistent credentials or self-hosted
  runners.
- Prepare branch protection and security features. If the private repository's
  plan cannot enable them, record that limitation and their immediate activation
  after visibility changes. The founder approves visibility independently of
  PRs.

## Required hosted controls

Protect `main` with mandatory pull requests and successful current checks:
`CI / check`, `Security / Secrets`, `Security / Dependencies` and
`Static analysis / Semgrep CE`. Confirm the actual check contexts from
successful runs before selecting them; display names and API contexts can
differ. Require the branch to be current before merge. Block direct and force
pushes and branch deletion, apply restrictions to administrators and keep
bypasses empty.

Default Actions tokens remain read-only and cannot approve PRs. Require approval
for workflows from all outside collaborators. Use GitHub-hosted runners for
untrusted PRs, pin third-party actions by SHA, and do not use
`pull_request_target` to execute their code. The Semgrep CE job also uses only
read permissions. Its scanner runs without network access or credentials and
does not build or execute product source. Do not add secrets or environment
credentials to these checks.

Enable dependency alerts, secret scanning, push protection, static analysis and
private vulnerability reporting where available. The local Semgrep CE workflow
works with Free and private repositories; hosted code-scanning alerts are a
separate feature and are not provided by this workflow. Keep auto-merge disabled
and Discussions off. Verify account MFA separately without recording credentials
or recovery material. Feature availability does not mean activation.

The security workflow scans all commits introduced by a PR or push with Gitleaks
default rules, full redaction and no repository allowlist or baseline. The
opening review separately scans all reachable history and GitHub surfaces.
Dependency analysis includes development dependencies and blocks high/critical
advisory results; an unavailable advisory service fails the check. Triage
applicability before changing dependencies; never use a forced bulk upgrade to
hide a result. [Static analysis](static-analysis.md) checks the complete tracked
JS/TS/TSX snapshot against reviewed local Semgrep CE rules. Its explicit
coverage limits do not replace trust-boundary review or synthetic regressions.
Dependabot proposes weekly updates; a proposal never authorizes automatic merge.

The locally patched `@x402/svm` dependency needs a maintainer-led update
together with its version-specific patch and Solana compatibility review. An
automated upgrade can fail with `ERR_PNPM_UNUSED_PATCH` when it leaves the patch
for the previous version unused. This is an update-generation failure, not
evidence of a vulnerability or a failing installation of the currently pinned
version. Do not delete the split-distribution patch (`upto` splits, and
`batch-settlement` splits with the client's `approveSplits` check), allow unused
patches or add a dependency ignore rule to make that update succeed. Keep
dependency alerts and the audit active; triage any advisory separately. A manual
update must port or demonstrate that upstream replaces the patch, preserve
recipient-distribution and recovery behavior, and pass the normal reviews and
validation before merge.

## Opening and maintenance

After explicit approval, recheck the candidate and the inventory delta, change
visibility, activate controls and verify anonymous access, license recognition,
private vulnerability reporting, protected-branch behavior and fork CI. Test
fork behavior using a harmless docs-only change; creating that external test
requires authorization to publish it. Do not announce readiness until controls
are checked. If a required control fails, pause contribution intake and fix it
before promotion; making the repository private again cannot recall copies or
public forks.

Keep a private matrix against
[OpenSSF OSPS Baseline 2026-08-28, level 1](https://baseline.openssf.org/versions/2026-08-28)
and project-specific payment, wallet and privacy requirements. Each control
needs an owner, applicability, source or observed evidence, reviewed revision,
current status and closure criterion. Use `meets`, `missing`, `not applicable`
with a reason, or `not verified`. A score or repository community profile is not
a security certification.

No stable release, binary distribution or backport support is promised by
opening the source. Before distributing desktop binaries, run the required
platform and backup-exchange checks, verify the actual keystore, review bundled
licenses and prepare a separate signing, provenance and update policy. Keep
experimental limitations visible and review friction from the first outside
contribution.
