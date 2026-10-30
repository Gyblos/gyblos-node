# Contributing

Read [AGENTS.md](AGENTS.md) for package ownership, rules, checks, privacy and the PR workflow, and [docs/code-standards.md](docs/code-standards.md) for detailed style. See [tests/README.md](tests/README.md) for regression design and native prerequisites. Product decisions remain in the central vault.

## Repository skills

The canonical repository skills live in `.agents/skills/` for Codex. Claude Code
loads the same skills through relative symlinks in `.claude/skills/`. Do not edit
the symlinked mirror directly. Run `pnpm skills:check` after changing a skill.

If the checkout cannot preserve symlinks and the mirror paths are absent, run
`pnpm skills:materialize` to create an identical directory mirror. If Git has
materialized the symlink entries as regular files, review them first and run
`pnpm skills:materialize:replace`. The materialized mirror is accepted by the
same check, but the canonical source remains `.agents/skills/`.
