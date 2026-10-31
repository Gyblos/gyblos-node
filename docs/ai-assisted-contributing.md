# AI-assisted contribution workflow

This repository uses one contribution workflow for human contributors,
Codex, Claude Code and other compatible development tools. The tool may change;
the repository contract does not.

`AGENTS.md` is the authoritative source for repository rules. This document
explains how to apply those rules during a change. If this document or a skill
disagrees with `AGENTS.md`, follow `AGENTS.md`.

## Source of truth

| Source                                  | Role                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| [`AGENTS.md`](../AGENTS.md)             | Public repository rules, ownership, safety and merge policy. |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Short onboarding path for every contributor.                 |
| [`.agents/skills/`](../.agents/skills/) | Canonical procedural skills used by development tools.       |
| [`.claude/skills/`](../.claude/skills/) | Claude Code distribution mirror; do not edit it directly.    |
| `AGENTS.local.md`                       | Optional ignored personal notes; never a team contract.      |

`CLAUDE.md` imports `AGENTS.md` so Claude Code receives the same rules. A
provider-specific configuration may help a tool load the repository, but it
must not redefine ownership, safety, testing or merge decisions.

## The shared change loop

Every implementation task follows the same sequence:

1. **Orient.** Read `AGENTS.md`, inspect the current branch and worktree, and
   consult the code map before deciding where code belongs.
2. **Define scope.** State the goal, affected layer/package, assumptions and
   files likely to change. Keep structural moves separate from behavior
   changes.
3. **Inspect before editing.** Read the relevant public entrypoints, tests,
   exports and existing documentation. Do not rely on chat history as project
   context.
4. **Implement narrowly.** Use one writer, preserve the repository boundaries,
   and add a failing regression first for a behavior change. Keep commits small
   and coherent.
5. **Verify locally.** Run the narrowest relevant check first, then the gates
   required by `AGENTS.md`. Run `pnpm skills:check` after changing a skill.
6. **Review the diff.** Check scope, generated files, symlinks, secrets,
   `.local/` access, imports, tests and documentation before publishing.
7. **Hand off clearly.** Report the exact head, files changed, checks and
   counts, anything not run, known risks and the next action. Never describe an
   unavailable CI check as passing.

The merge decision remains a human repository decision. An assistant may
prepare or review a change, but it does not infer approval from a green check,
an open pull request or a tool response.

## Tool-neutral handoff

Use this shape when handing work from one contributor or tool to another:

```text
Goal: <one sentence>
Scope: <packages/apps/docs and why>
Changed: <files or concise groups>
Validation: <command and exact result/count>
Not verified: <command and reason>
Risks/decisions: <remaining concerns or explicit none>
Next action: <specific next step>
```

The next tool must be able to continue from the branch, files and this report;
it should not need access to a private prompt, transcript or local log.

## Privacy and unavailable infrastructure

Never send keys, tokens, journals, role volumes, raw logs, private prompts or
responses to a model or commit them to the repository. Keep real `.local/`
content out of inspection and use synthetic or temporary fixtures.

When CI minutes, runners or a native dependency are unavailable, continue with
safe local checks where possible and record the limitation exactly. Do not
weaken a test, claim a skipped check passed, or change merge policy to work
around the limitation.
