# Contributing

Read [AGENTS.md](AGENTS.md) for package ownership, rules, checks, privacy and
the PR workflow, and [docs/code-standards.md](docs/code-standards.md) for
detailed style. See [tests/README.md](tests/README.md) for regression design and
native prerequisites. The [public decision index](docs/public-decisions.md)
provides product and technical context without access to the private vault.
Ask a maintainer when a decision needed for your contribution is missing or
unclear.

## Choose a contribution

Search existing issues and pull requests before starting. Use issues for usage
questions, bug reports and feature proposals; follow [SUPPORT.md](SUPPORT.md).
Discuss changes to architecture, public contracts, payment behavior or product
policy with a maintainer before implementation. Small documentation fixes and
focused regressions are welcome without a prior proposal.

Read the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through
the [private security channel](SECURITY.md), not in a public issue or PR. Never
include real credentials, prompts, responses, journals or payment payloads.

## Fork and prepare a branch

External contributors do not need write access to this repository, the private
vault or any AI tool. Fork `Gyblos/gyblos-node` on GitHub, then replace
`YOUR-USER` and `describe-the-change` below:

```sh
git clone https://github.com/YOUR-USER/gyblos-node.git
cd gyblos-node
git remote add upstream https://github.com/Gyblos/gyblos-node.git
git fetch upstream
git worktree add --detach ../gyblos-contribution upstream/main
cd ../gyblos-contribution
git switch -c codex/describe-the-change
```

`origin` is your fork; `upstream` is the authoritative repository. The branch
prefix is a convention and does not require Codex. Work in this task's worktree
so unrelated changes remain separate. Configure your chosen public Git author
identity before committing; GitHub provides a noreply address if you prefer not
to expose a personal email. Commit authorship becomes public with the repository.

## Set up Node.js and pnpm

The project requires Node.js 24.22.1 or newer and the pnpm version pinned in
[package.json](package.json). For development, use the latest available
security-patched Node.js 24 release. Before installing dependencies, check the
tools selected by the terminal you will use:

```sh
node --version
node -p "process.execPath"
pnpm --version
```

If Node is older than 24.22.1, select a supported version with your existing
version manager, or install one if needed. For example, if you already use nvm:

```sh
nvm install 24
nvm use 24
```

If the terminal still selects an older Node, check your shell's `PATH` and
version-manager initialization, then open a new terminal (including an editor's
integrated terminal) and repeat the checks. `process.execPath` shows the Node
executable actually in use. If pnpm is missing or reports a different version,
use the [pnpm installation guide](https://pnpm.io/installation) to install or
select the version pinned in `package.json`, then check `pnpm --version` again
before running `pnpm install --frozen-lockfile`.

The discovery index's `node:sqlite` tests skip when that module is unavailable. See
[native skips](tests/README.md#native-skips); a skipped case is not a pass.

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

## Verify and submit

Dependency installation needs access to the package registry unless all pinned
packages are cached. It is separate from the offline checks, which need no
funded wallet, running engine or external service:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:lab
pnpm tooling:test
pnpm desktop:build
git diff --check
git diff
git add -p
git diff --cached
git commit -m "Describe the concrete change"
git push -u origin codex/describe-the-change
```

Use the product and lab counts separately, and explain every relevant skipped
or unavailable check. Confirmed bugs require a failing regression before the
fix and a passing run afterward. Never run `gate:*`, funding, devnet or deployment
commands to validate a contribution.

`git add -p` lets you review tracked changes before staging. For new files, use
`git add --` followed by each explicitly reviewed path; do not stage unrelated
work. Inspect `git diff --cached` before committing.

Open a pull request from your fork's branch into `Gyblos/gyblos-node:main` and
complete the template. Use English for repository content, commits and PRs.
Link the issue when one exists. Keep unrelated fixes and structural moves out
of the PR. Review the staged content for sensitive material before pushing.

The initial maintainer is [@gilbertsahumada](https://github.com/gilbertsahumada).
Maintainers arrange the three independent read-only reviews and decide whether
to merge; contributors do not need to hire or coordinate reviewers. Respond to
review with focused follow-up commits instead of rewriting pushed history.
Approval and merge remain separate maintainer decisions, with merge commits as
required by `AGENTS.md`. Support is best effort, with no guaranteed response time.

## License and rights

Original project code is licensed under [Apache 2.0](LICENSE). Unless explicitly
stated otherwise, contributions intentionally submitted for inclusion are offered
under that license, as described in its contribution terms. No separate CLA or
DCO sign-off is required. Submit only work you have the right to contribute,
identify copied or adapted material, and preserve its license and attribution.
Third-party components retain their own terms; see the
[third-party notices](docs/third-party-notices.md). The code license grants no
right to Gyblos or third-party trademarks beyond its stated terms.

## Platform and distribution limits

| Capability                         | Declared scope                                                                      | Evidence limit                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Development checks                 | Node.js 24.22.1+ and pinned pnpm; automatic CI is Linux                             | A configured workflow is not a successful run; report the tested revision and platform.                       |
| Native transport                   | macOS ARM64 and Linux x64/ARM64 bindings; IPv6 loopback required by native fixtures | Windows is unverified; no Intel Mac binding is supplied by the pinned SDK. Skips establish no native support. |
| Desktop build and wallet contracts | Manual Linux/macOS/Windows workflow                                                 | The contracts use simulated OS encryption; they do not prove native keystore protection.                      |
| Desktop packaging                  | Local macOS ARM64 preview only                                                      | No signed production installer or other-platform distribution is promised.                                    |

Opening the source does not publish packages or installers. Consult the
[desktop guide](docs/desktop-probe.md) for current behavior and the
[maintenance checklist](docs/repository-maintenance.md) for release prerequisites.
