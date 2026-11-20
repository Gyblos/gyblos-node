# Contributing

You can contribute without write access to this repository, without the private
vault and without any AI tool. The short path:

1. Pick an issue or propose a change.
2. Fork the repository and create a worktree and branch from `develop`.
3. Make a narrow change, with a failing test first for a behavior change.
4. Run `pnpm check` and report the counts.
5. Open a pull request into `develop`.

[AGENTS.md](AGENTS.md) holds the repository rules: package ownership, checks,
privacy and the PR workflow. [docs/code-standards.md](docs/code-standards.md)
holds detailed style, and [tests/README.md](tests/README.md) the test policy.
For product and technical context, read the
[public decisions](docs/public-decisions.md). If a decision you need is missing
or unclear, ask a maintainer instead of inventing a policy.

## Choose a contribution

Search existing issues and pull requests before you start. Use issues for usage
questions, bug reports and feature proposals; see [SUPPORT.md](SUPPORT.md).
Discuss changes to architecture, public contracts, payment behavior or product
policy with a maintainer before you implement them. Small documentation fixes
and focused regressions are welcome without a prior proposal.

Read the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through
the [private security channel](SECURITY.md), not in a public issue or PR. Never
include real credentials, prompts, responses, journals or payment payloads.

## Fork and prepare a branch

Fork `Gyblos/gyblos-node` on GitHub, then run these commands. Replace `YOUR-USER`
with your GitHub user and `describe-the-change` with a short branch name:

```sh
git clone https://github.com/YOUR-USER/gyblos-node.git
cd gyblos-node
git remote add upstream https://github.com/Gyblos/gyblos-node.git
git fetch upstream
git worktree add --detach ../gyblos-contribution upstream/develop
cd ../gyblos-contribution
git switch -c feat/describe-the-change
```

`origin` is your fork; `upstream` is the authoritative repository. Use a prefix
such as `feat/` or `fix/`. A separate worktree per task keeps unrelated changes
apart.

Set the public Git author identity you want before committing. GitHub provides
a noreply address if you prefer not to expose a personal email; commit
authorship is public.

## Set up Node.js and pnpm

The project needs Node.js 24.22.1 or newer and the pnpm version pinned in
[package.json](package.json). Check the tools your terminal selects:

```sh
node --version
pnpm --version
```

If Node is older, select a newer Node 24 with your version manager (for example
`nvm install 24 && nvm use 24`) and open a new terminal. If pnpm is missing or
reports another version, follow the
[pnpm installation guide](https://pnpm.io/installation). Then install the
dependencies:

```sh
pnpm install --frozen-lockfile
```

Installing needs access to the package registry unless every pinned package is
cached. Nothing else needs network access.

## Make the change

Every contributor follows the same loop: orient, define scope, inspect,
implement, verify locally, review and hand off. The step-by-step procedure is
the [contributor workflow skill](.agents/skills/gyblos-contributor-workflow/SKILL.md),
and the [code map](.agents/skills/gyblos-code-map/SKILL.md) says where code
belongs.

- Add a failing test before a behavior fix, then the fix. Report both runs.
- Keep structural moves and behavior changes in separate PRs.
- Keep commits small and coherent.
- For a docs site page (`apps/docs/content/docs`), update the English and the
  Spanish file together. Preview with `pnpm docs:dev` and check the export with
  `pnpm docs:test`.
- Never run `gate:*`, funding, devnet or deployment commands to validate a
  change.

## Verify

1. Run the full checks:

   ```sh
   pnpm check
   ```

   `pnpm check` runs typecheck, lint (including the tooling tests, skill check
   and import boundaries) and every product, standalone package and lab test.
   It needs no funded wallet, engine, Docker, Semgrep account or AI tool. It
   exits with status 0 when everything passes.

2. If you changed the desktop app, also run `pnpm desktop:build`.

3. Report the passed, failed, cancelled and skipped counts for product, lab and
   tooling tests separately. Explain every skipped or unavailable check; a
   skipped native case proves nothing on that host.

## Submit

1. Check the diff for whitespace errors and review it:

   ```sh
   git diff --check
   git diff
   ```

2. Stage only what you reviewed. `git add -p` lets you pick tracked changes;
   add each new file by its path with `git add -- PATH`. Then review what is
   staged:

   ```sh
   git add -p
   git diff --cached
   ```

3. Commit and push:

   ```sh
   git commit -m "Describe the concrete change"
   git push -u origin feat/describe-the-change
   ```

4. Open a pull request from your fork's branch into `Gyblos/gyblos-node:develop`
   and complete the template. Link the issue if there is one. Use English for
   repository content, commits and PRs, and leave unrelated fixes out.

Pull requests also run [Semgrep Community Edition](docs/static-analysis.md).

## Review and merge

Maintainers arrange three independent read-only reviews and decide whether to
merge; you don't need to find reviewers. Answer review with focused follow-up
commits instead of rewriting pushed history. Approval and merge are maintainer
decisions, made with merge commits as `AGENTS.md` requires. Support is best
effort, with no guaranteed response time.

## Using AI tools

AI-assisted contributions follow the same rules and loop as any other. The tool
is interchangeable; the branch, the repository files and the handoff report are
the shared context.

- `AGENTS.md` is the only source of rules. Codex reads it directly, and
  `CLAUDE.md` imports it for Claude Code. A provider-specific file may help a
  tool load the repository, but it never adds or overrides rules. If a skill or
  another document disagrees with `AGENTS.md`, follow `AGENTS.md`.
- Skills are canonical in `.agents/skills/`. Claude Code loads them through the
  mirror in `.claude/skills/`, which holds relative symlinks or, where a
  checkout cannot keep symlinks, identical copies made by
  `pnpm skills:materialize` (`pnpm skills:materialize:replace` replaces symlink
  entries that Git checked out as plain files). Never edit the mirror; run
  `pnpm skills:check` after changing a skill.
- Hand off with the report template in the
  [contributor workflow skill](.agents/skills/gyblos-contributor-workflow/SKILL.md#5-review-and-hand-off).
  The next contributor must be able to continue from the branch, the files and
  that report, without a private prompt, transcript or local log.
- Never send keys, tokens, journals, role volumes, raw logs or private prompts
  and responses to a model. Keep a real `.local/` out of the tool's reach.
- A green check, an open PR or a model response is never approval to merge.

## License and rights

Original project code is licensed under [Apache 2.0](LICENSE). Unless you state
otherwise, a contribution you submit for inclusion is offered under that
license, as described in its contribution terms. No separate CLA or DCO sign-off
is required. Submit only work you have the right to contribute, identify copied
or adapted material, and keep its license and attribution. Third-party
components keep their own terms; see the
[third-party notices](docs/third-party-notices.md). The code license grants no
right to Gyblos or third-party trademarks beyond its stated terms.

## Platform support

| Area                       | Supported                                                         | Verified by CI                                                                                                          |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Development checks         | Node.js 24.22.1+ and the pinned pnpm                              | Linux on every PR into `develop` or `main`, plus targeted Windows x64 tests of the seller and native transport.         |
| Native transport (Iroh)    | macOS ARM64, Linux x64/ARM64, Windows x64; no Intel Mac binding   | Linux, and Windows for the transport and free execution tests.                                                          |
| Desktop wallet and backups | macOS, Linux and Windows                                          | A manual workflow (`desktop-platforms.yml`); it uses simulated OS encryption, so it does not prove keystore protection. |
| Desktop packages           | macOS arm64, Windows x64, Linux x64 (`.deb`, `.tar.gz`); unsigned | `desktop-packages.yml`, run by hand, on packaging changes and for each release.                                         |

For ordinary code PRs to `develop`, Windows tests run from source. Windows- or distribution-sensitive changes also build and test the release archive, npm package, scheduled task and PowerShell installer. All PRs to `main` and pushes to either protected branch run the full suite. The path and platform-change rules live in [the CI selector](.github/scripts/ci-changes.sh).

A configured workflow is not a successful run: report the revision and
platform you tested. For the desktop app, see [docs/desktop.md](docs/desktop.md).
