# Contributing

Read [AGENTS.md](AGENTS.md) for package ownership, rules, checks, privacy and
the PR workflow, and [docs/code-standards.md](docs/code-standards.md) for
detailed style. See [tests/README.md](tests/README.md) for regression design and
native prerequisites. The [public decision index](docs/public-decisions.md)
provides product and technical context without access to the private vault.
Ask a maintainer when a decision needed for your contribution is missing or
unclear.

## One workflow for every contributor

The repository uses the same workflow for humans, Codex, Claude Code and other
development tools. See the full [AI-assisted contribution workflow](docs/ai-assisted-contributing.md).

1. Start in your own detached worktree and task branch, read `AGENTS.md`, and
   consult the [code map](.agents/skills/gyblos-code-map/SKILL.md).
2. Define the goal, owning layer, non-goals and validation before editing.
3. Inspect current code and tests; add a failing regression before a behavior
   fix and keep structural work separate.
4. Make a narrow change with one writer and small coherent commits.
5. Run focused local checks, then the applicable repository gates.
6. Review the diff and hand off exact validation, omissions, risks and next
   action. CI or native checks that could not run remain explicitly unverified.

The tool is interchangeable; the branch, repository files and handoff report
are the shared context.

## Repository skills

The canonical repository skills live in `.agents/skills/` for Codex. Claude Code
loads the same skills through relative symlinks in `.claude/skills/`. Do not edit
the symlinked mirror directly. Run `pnpm skills:check` after changing a skill.

The shared implementation procedure is
`.agents/skills/gyblos-contributor-workflow/SKILL.md`; the code ownership map
and PR procedure remain separate skills so they can be consulted independently.

If the checkout cannot preserve symlinks and the mirror paths are absent, run
`pnpm skills:materialize` to create an identical directory mirror. If Git has
materialized the symlink entries as regular files, review them first and run
`pnpm skills:materialize:replace`. The materialized mirror is accepted by the
same check, but the canonical source remains `.agents/skills/`.
