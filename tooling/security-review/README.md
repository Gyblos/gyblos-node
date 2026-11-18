# AI security review

`tooling/security-review` runs an advisory, model-based review of repository
source. It has two modes:

- **Baseline**: a manual review of every app, package and cross-cutting flow.
- **Pull request**: an incremental review of a PR into `develop` or `main`.

It is advisory. The required Security and Static analysis checks keep their
roles
([repository-maintenance.md](../../docs/repository-maintenance.md#workflows)).
Product packages never import this tooling.

## Run it locally

Prerequisites: Node 24.22.1+, the repository's pnpm version, and an OpenAI API
key for live runs. No Pi dependency is added to the product.

1. Install the isolated Pi coding agent 1.5.0 runtime. Its lock pins the
   integrity of every registry package.

   ```sh
   npm ci --prefix tooling/security-review/runtime --ignore-scripts
   ```

2. Point `PI_COMMAND` at the runtime binary, or at an existing Pi 1.5.0:

   ```sh
   export PI_COMMAND="$PWD/tooling/security-review/runtime/node_modules/.bin/pi"
   ```

3. For a live run, export `OPENAI_API_KEY` in your environment. Never put a key
   in a command, config file or report.
4. Plan the review. Planning calls no model.

   ```sh
   pnpm security-review plan baseline
   pnpm security-review plan pr --base-ref <base-sha>
   ```

5. Run it. `--dry-run` builds the plan and writes artifacts without calling Pi.

   ```sh
   pnpm security-review run baseline --dry-run --output /tmp/gyblos-review-new-run
   pnpm security-review run baseline --model openai/<model-id> \
     --max-calls 300 --concurrency 3 --output /tmp/gyblos-review-another-run
   ```

Each output directory must be empty and outside the checkout; reusing an
artifact filename is rejected.

### Options

| Option               | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `--output <dir>`     | Where artifacts go (required for `run`).                                       |
| `--base-ref <sha>`   | The base commit, for pull-request mode.                                        |
| `--source-ref <sha>` | The commit to review. Defaults to `HEAD`.                                      |
| `--root <dir>`       | Review this committed checkout instead of the current one.                     |
| `--model <model>`    | An explicit `openai/<model-id>` that your Pi supports. Defaults to `PI_MODEL`. |
| `--thinking <level>` | Pi thinking level. Defaults to `high`.                                         |
| `--concurrency <n>`  | Maximum parallel Pi tasks. Defaults to 3.                                      |
| `--max-calls <n>`    | Maximum Pi invocations, including both verification passes. Defaults to 300.   |
| `--dry-run`          | Build the plan without calling Pi.                                             |

The runner never guesses a model ID or uses stored ChatGPT credentials.

## What a run does and never does

A run reads immutable Git blobs, includes the real before and after diff for a
PR, splits large surfaces into bounded inputs and runs independent Pi processes.
Pi runs with `--no-tools` and without sessions, extensions, MCP, project
context, skills, templates or themes. Each process gets a fresh configuration
directory and an allowlisted environment. Source is sent as model input only; it
is never executed or exposed through filesystem tools.

The runner never inspects local role state, runs tests supplied by a PR, makes
payments, accesses live services or deploys.

## Reviewers and verification

Every unit gets security, architecture and maintainability, and behavior
reviewers. Specialists (protocol and crypto, payments and economics, P2P and
identity, concurrency and recovery, desktop and local, supply chain, tests and
evidence) are chosen deterministically from paths, including deleted files and
consumers in cross-cutting flows. Repository rules, tests, deployment files and
unclassified public files have visible coverage units. Path rules decide which
reviews run; nothing may remove a required review.

Each candidate finding gets two fresh, independent verification sessions, and a
disagreement stays pending. Code validates JSON keys, verdicts, evidence
revisions, line bounds and claimed path coverage. A source-only review never
claims a reproduced vulnerability or a severity: a candidate ends as
`needs_validation` or `rejected`. Confirming one at runtime needs a separately
authorized, bounded synthetic regression, then review.

`--max-calls` bounds process invocations; at least two calls are reserved before
reviewer work starts. It is not a cost cap, because Pi and the provider retry
internally: set a spending limit on your provider project.

## Reading the results

A run writes `review-results.json`, `coverage-ledger.json`, `findings.json`,
`REPORT.md`, `status.txt` and `labels.txt`. `status.txt` holds one of:

| Status             | Meaning                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `clean`            | No retained candidate within the completed source tasks.                                                        |
| `needs-validation` | A candidate needs runtime validation, a task did not complete or a changed file was excluded; read `REPORT.md`. |
| `error`            | A task or verification failed, or verifications do not match the candidates.                                    |
| `not-run`          | No model was called, as in a `--dry-run`.                                                                       |

Skipped tasks, oversized, binary or non-regular sources, missing input, errors
and pending verification stay visible and can never produce `clean`. No earlier
report suppresses current coverage.

`clean` is not a security certification. The review is source-only and partial:
sharded cross-cutting reviews can miss interactions between chunks, and it does
not do sandboxed reproduction or iterative coverage passes. Deterministic
checks, human review and an external audit remain necessary.

## GitHub Actions

1. **AI review request** runs on PRs into `develop` or `main`. It records the
   event, with no model credentials and no checkout.
2. **AI security review** responds through `workflow_run`, so GitHub loads it
   from the default branch. It checks that the PR, head, base and repository are
   current and runs the trusted runner against the immutable PR merge snapshot
   as data.
3. Its publisher validates the fixed status, rechecks that the head, base and
   merge commit are unchanged, applies one fixed label and posts a deterministic
   summary. It never runs or renders model text. Stale heads and forks get no
   result. Failed analysis publishes `error`; cancelled analysis leaves the
   queued label.
4. **AI review state** clears old labels and sets `ai-review:queued` on each new
   revision. It uses `pull_request_target` only for this metadata change,
   without checking out or running source, installing packages or receiving
   model credentials.
5. **AI security baseline** accepts a manual dispatch only on the default branch
   (`develop`), records the dispatch commit and requires an explicit model and
   invocation budget.

The workflows run only when the repository variable `AI_REVIEW_ENABLED` is
`true`. They read the model from the `PI_REVIEW_MODEL` variable
(`openai/<model-id>`, passed to the runner as `PI_MODEL`) and the key from the
`OPENAI_API_KEY` Actions secret. They use the labels `ai-review:queued`,
`ai-review:clean`, `ai-review:needs-validation` and `ai-review:error`, and clear
a leftover `ai-review:running` label.

A green request check only records the event. A review ran only when the
separate **AI security review** run executed Pi, uploaded its report and posted
an `AI source review` comment for the current head, base and merge commit.
Changes to these workflows take effect after they merge into the default branch.

Actions artifacts hold candidate details, follow repository visibility and
access rules and expire after seven days. Do not use them for a privately
disclosed vulnerability; see [SECURITY.md](../../SECURITY.md). No model
credentials or raw transcripts are uploaded. Local tests use a synthetic Pi
implementation.

The PR comment identifies failed workflow steps and summarizes review failures
using fixed descriptions. Pi reports assistant completion, usage and errors
through its JSON event stream. Only recognized error categories, process counts
and available token totals enter the public diagnostic summary. Missing usage is
shown as unknown. Reported tokens can be partial and are not a billing total.

An explicit exhausted quota or rejected credential stops new Pi processes for
the remainder of that run, including independent verifiers. Already started
processes finish. Each new workflow run checks the provider independently. Pi
session and provider retries are disabled in the isolated settings directory.
Temporary rate limits, invalid response formats and incomplete coverage are
reported separately. The detailed task and verifier records remain in the
artifact.
