---
name: gyblos-pr-workflow
description: Step-by-step PR workflow for gyblos-node. Use when starting work on a change, finishing or opening a PR, reviewing a PR (structure, behavior-equivalence or security review), reporting gate results, fixing review findings, merging after founder approval, or doing the post-merge vault note update.
---

# Gyblos PR workflow

The rules are in `AGENTS.md` (Tests, Safety and privacy, Workflow and merges,
Worktrees, Vault and decisions). This skill gives the commands and templates. If
they disagree, `AGENTS.md` wins.

## 1. Start in your own detached worktree

```sh
git -C <checkout> fetch origin
git -C <checkout> worktree add --detach <path> origin/main
cd <path>
git switch -c <prefix>/<topic>      # only when you will push a branch
pnpm install --frozen-lockfile
```

Never work in the shared checkout or another agent's worktree. Never delete a
worktree or branch you did not create; as a sub-agent, never delete your own
either: report its path.

## 2. Red, then green (behavior changes)

1. Add the failing case in `tests/` (or `tests/lab/`, `tooling/`) through public
   entries, with a temp `GYBLOS_HOME`/`GYBLOS_LAB_HOME`.
2. Run only that file and record the failure:
   `node --import tsx --test tests/<file>.test.ts`.
3. Commit the test, then implement the fix and re-run until it passes.
4. Run the full gates (section 3). Report the red and green runs in the PR.

Refactors and moves add no behavior: test names and counts stay identical.
Behavior changes and moves go in separate PRs.

## 3. Gates and exact-count report

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint            # includes prettier --check, tooling:test, boundaries
pnpm test
pnpm test:lab
pnpm tooling:test
```

Compare lint warnings with `main` (`pnpm exec eslint .` on both). Report in the
PR body and to the caller using this template:

```text
Gates on <head SHA>:
- install --frozen-lockfile: pass
- typecheck: pass
- lint: 0 errors / <N> warnings (main: <N>) / <M> modules, 0 boundary violations
- product (pnpm test): <total> total / <p> passed / <f> failed / <c> cancelled / <s> skipped
- lab (pnpm test:lab): <total> total / <p> passed / <f> failed / <c> cancelled / <s> skipped (<reason for skips>)
- tooling (pnpm tooling:test): <total> total / <p> passed / <f> failed / <c> cancelled / <s> skipped
- red -> green: <test name> failed on <SHA>, passes on <SHA>   (behavior changes only)
Not verified: <anything not run, and why>
```

## 4. Three independent read-only reviews

Every substantive PR gets three reviewers, each in its own detached worktree at
the PR head, with no write access to the PR branch. Give each the PR number and
head SHA, not your own conclusions.

Shared preamble for every reviewer prompt:

```text
Review PR #<n> in Gyblos/gyblos-node at head <SHA>. Read-only: create your own
detached worktree at that SHA, do not edit, commit, push, comment, merge or
delete anything, and do not run gate:*, funding, devnet or deploy commands, or
read a real .local/. Read AGENTS.md first. Report findings as
P1 (must fix: wrong behavior, security, broken rule), P2 (should fix before
merge), P3 (optional), each with file:line, evidence and a suggested fix.
End with one verdict: READY, READY AFTER P2, or NOT READY.
```

Focus lines, one per reviewer:

- **Structure:** "Check layer placement and ownership against AGENTS.md and
  `tooling/boundaries/config.ts`, package exports, module headers, canonical
  values (`docs/code-standards.md`), doc accuracy and links, file moves with
  history."
- **Behavior equivalence:** "Diff against the merge base. For refactors, prove
  wire values, signing bytes, error codes and precedence, test names/counts,
  journals and paths are unchanged. For behavior changes, check the red/green
  test covers the change and nothing else changed."
- **Security:** "Check input validation at boundaries, payment and journal
  safety (no retry after authorization, uncertain payments block), secrets and
  private data in the diff, loopback-only listeners, import-time side effects,
  and anything that would touch real keys, `.local/`, funds or devnet."

## 5. Single-writer fix loop

1. Collect all reviewer findings; verify each against the code yourself.
2. One writer (you, or one designated agent) fixes the confirmed P1/P2 items in
   small commits; reviewers never edit.
3. Re-run all gates (section 3) and push.
4. Send the new head SHA back to the reviewers that reported findings; repeat
   until each verdict is READY (or READY AFTER P2 with the P2s fixed).
5. Record rejected findings with the reason in the PR body.

## 6. Merge (only after founder approval)

A PR or green CI is never approval. Merge only when the founder explicitly
approved this PR and CI is green on the exact head:

```sh
gh pr checks <n> --repo Gyblos/gyblos-node
gh pr merge <n> --repo Gyblos/gyblos-node --merge --match-head-commit <SHA>
```

Merge commits only, never `--squash` or `--rebase`. Do not pass
`--delete-branch`. Then confirm the post-merge CI on `main` for the merge SHA.

## 7. Post-merge vault update

Contributors without vault access hand off the merged change and validation to
an authorized maintainer. Maintainers and agents with authorized vault access
follow the vault's own `AGENTS.md`; this is the usual shape for
`../gyblos-brain/30 Repos/gyblos-payments.md` (GYB-DOC-007):

1. `git -C ../gyblos-brain status` first; leave unrelated edits alone.
2. Update **Current state** at the top (main SHA, merged PRs, exact gate counts,
   CI links).
3. Add a new dated section directly below Current state for this work (what
   merged, reviews, what remains). Keep older sections unchanged.
4. Bump frontmatter `version` (MINOR for added scope), `revision` +1, `updated`,
   the visible header line, and add a row at the top of the note's
   `## Control de versiones` table.
5. Update the note's row in the registry in `10 Docs/README.md` to the new
   version; add review evidence to the relevant `40 Validation/` note when
   applicable.
6. Commit locally with only those files. Never push the vault without explicit
   approval. Never touch `.obsidian/`.
