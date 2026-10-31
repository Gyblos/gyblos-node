---
name: gyblos-contributor-workflow
description: Shared implementation workflow for humans, Codex, Claude Code and other compatible contributors to gyblos-node.
---

# Gyblos contributor workflow

Use this skill for implementation, refactoring, documentation and tooling
changes in `gyblos-node`. It is provider-neutral: the same sequence applies to
Codex, Claude Code and human contributors. Read `AGENTS.md` first; its rules
override this procedure.

The public explanation is [docs/ai-assisted-contributing.md](../../../docs/ai-assisted-contributing.md).
Do not rely on a private prompt, provider-specific memory or an uncommitted
transcript as project context.

## 1. Establish context

1. Confirm the repository, branch/worktree and clean starting state with
   `git status --short --branch`.
2. Read `AGENTS.md` and the relevant sections of `docs/code-standards.md`.
3. Read `gyblos-code-map` before creating, moving or splitting product modules.
4. Search for an existing decision, contract, test or documentation entry
   before creating a new one.
5. Do not read or write a real `.local/`, credentials, journals, funded wallets,
   devnet state or deployment targets.

## 2. Define the change

Write a short scope statement before editing:

- the user-visible or maintenance goal;
- the owning package, app, lab or documentation area;
- assumptions and non-goals;
- whether the work is structural or behavioral;
- the focused validation that will prove it.

Keep structural moves separate from behavior changes. If behavior changes, add
the smallest failing regression through the public entrypoint before fixing it.

## 3. Implement narrowly

Inspect current entrypoints, exports, tests and nearby documentation before
editing. Keep one writer for a change. Preserve dependency direction,
canonical values, wire bytes, paths, journals, test names and counts unless the
scope explicitly changes them. Do not add provider-specific branches to product
code or repository rules.

Prefer small coherent commits. Never hide a boundary, lint or type error with a
baseline, suppression, `any` or an unsafe cast.

## 4. Verify locally

Run the focused test or check first. Then run the applicable repository gates:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:lab
pnpm tooling:test
```

Run `pnpm skills:check` after changing a skill. Report exact passed, failed,
cancelled and skipped counts for product, lab and tooling suites. If a runner,
CI minute, Node version or native dependency is unavailable, record it as not
verified; never report it as passing.

## 5. Review and hand off

Review the staged diff for scope, secrets, `.local/` paths, generated files,
symlinks, imports, tests and documentation. A substantive PR still requires
the three independent read-only reviews defined by `AGENTS.md`; reviewers do
not edit, commit, push or merge.

Hand off using this compact report:

```text
Goal: <one sentence>
Scope: <packages/apps/docs and why>
Changed: <files or concise groups>
Validation: <command and exact result/count>
Not verified: <command and reason>
Risks/decisions: <remaining concerns or explicit none>
Next action: <specific next step>
```

Approval and merge are separate human decisions. Do not infer either from a
green check, a PR state or a model response.
