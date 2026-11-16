# AI source review

The runner lives in `tooling/security-review`; product packages do not import
it. It provides a manual baseline by app/package and cross-cutting flow, and an
advisory incremental review for PRs targeting `main`. Existing Security and
Static analysis checks keep their existing roles.

## Execution

Use Node 24.22.1+ and the repository pnpm version. Install the isolated Pi
coding agent 1.5.0 runtime with
`npm ci --prefix tooling/security-review/runtime --ignore-scripts`. The runtime
lock includes integrity pins from the installed Pi release manifest for all
registry packages. Set `PI_COMMAND` to the absolute runtime
`node_modules/.bin/pi` path, or use an already installed Pi 1.5.0. No Pi
dependency is added to the product. Select an explicit `openai/<model-id>`
supported by that installation; the runner does not guess a model ID or use
stored ChatGPT credentials.

```sh
pnpm security-review plan baseline
pnpm security-review plan pr --base-ref <base-sha>
pnpm security-review run baseline --dry-run --output /tmp/gyblos-review-new-run
pnpm security-review run baseline --model openai/<model-id> \
  --max-calls 300 --concurrency 3 --output /tmp/gyblos-review-another-run
```

Each output directory must be empty and outside the checkout. Reusing an
artifact filename is rejected. A live invocation reads `OPENAI_API_KEY` from the
environment; never put a key in a command, config file or report.

A run reads immutable Git blobs, includes the real before/after diff for PRs,
divides large surfaces into bounded inputs, and runs independent Pi processes.
Pi has `--no-tools`, no sessions, extensions, MCP, project context, skills,
templates or themes. Each process gets a fresh configuration directory and an
allowlisted environment. Source is sent as model input; it is never executed or
exposed through filesystem tools. The runner does not inspect local role state,
execute tests supplied by a PR, make payments, access live services or deploy.

## Review roles and evidence

Every selected unit gets security, architecture/maintainability and behavior
reviewers. Protocol/crypto, payments/economics, P2P/identity,
concurrency/recovery, desktop/local, supply-chain and tests/evidence reviewers
are selected deterministically from paths, including deleted files and consumers
in cross-cutting flows. Repository rules, tests, deployment files and
unclassified public files have visible coverage units.

Each candidate gets two fresh independent verification sessions. Disagreement
stays pending. Security and quality candidates are separate categories. JSON
keys, verdicts, evidence revisions, line bounds and claimed path coverage are
validated in code. Source-only analysis cannot emit a reproduced `confirmed`
vulnerability or severity. It emits `needs_validation` or `rejected`; runtime
confirmation requires a separately authorized bounded synthetic regression,
followed by review.

`--max-calls` bounds process invocations including both verifier passes. At
least two calls are reserved before hunter work. Skipped tasks,
oversized/binary/non-regular sources, missing input, errors and pending
verification remain visible and cannot produce a clean result. Pi/provider
internal retries and token usage are not a hard dollar cap: configure provider
project spending limits separately.

A Jev/Decisions router is not enabled in this version. Path rules are the
authority; a future classifier may add specialists or prioritize work, never
remove required reviews or decide that a vulnerability exists.

## Reports and limits

Outputs: `review-results.json`, `coverage-ledger.json`, `findings.json`,
`REPORT.md`, `status.txt` and `labels.txt`. The report is explicitly a partial
source-only review. No prior report suppresses current coverage. A clean result
means no retained candidate within completed source tasks; it is not a security
certification.

This baseline does not implement the full security-audit skill's sandboxed
reproduction, iterative coverage-critic waves or prior-run reconciliation. That
methodology remains applicable to the subsequent full audit. Sharded
cross-cutting reviews can miss interactions between chunks. Deterministic
checks, human review and the decided external audit before mainnet remain
necessary.

## GitHub Actions

1. `AI review request` runs on PRs into `main`, without model credentials or
   code checkout.
2. `AI security review` responds through `workflow_run`. GitHub loads its
   workflow from the default branch. It validates the current
   PR/head/base/repository and runs the trusted default-branch runner against
   the immutable PR merge snapshot as data.
3. A separate publisher validates the fixed status, rechecks that the PR head is
   current and that the reviewed base/merge remain unchanged, applies a fixed
   label, and posts a deterministic summary. It never executes or renders model
   text. Stale heads and forks do not receive a review result. A metadata-only
   `AI review state` workflow invalidates old labels on each revision; it uses
   `pull_request_target` without checking out or executing source, installing
   packages or receiving model credentials. Failed analysis publishes error;
   cancelled analysis leaves the pending label rather than preserving clean.
4. `AI security baseline` accepts a manual dispatch only on `main`, records the
   exact dispatch commit and requires an explicit model and invocation budget.

Enable automatic reviews with repository variable `AI_REVIEW_ENABLED=true`, set
`PI_REVIEW_MODEL=openai/<model-id>`, and add the `OPENAI_API_KEY` Actions
secret. The first setup PR cannot activate a default-branch workflow before it
is merged. Precreate these labels: `ai-review:queued`, `ai-review:clean`,
`ai-review:needs-validation`, `ai-review:error`. There is no GitHub App or
`@bot` mention handler in this version.

Actions artifacts contain candidate details and follow repository
visibility/access rules; they expire after seven days. Avoid using public
artifacts for a privately disclosed vulnerability. No model credentials or raw
transcripts are uploaded. Hosted runs and live model calls are separate
operational steps; local tests use a synthetic Pi implementation.
