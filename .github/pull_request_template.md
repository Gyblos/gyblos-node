## Problem and resulting behavior

Describe the problem, intended outcome, owning area, non-goals and related issue.
For a behavior change, give a concrete before/after example. Flag any public API,
wire contract, signing, storage or compatibility change explicitly.

## Validation

Report the tested commit, commands and exact passed/failed/cancelled/skipped
counts for product, lab and tooling separately. Give reasons for relevant skips
and checks not run. Report lint errors/warnings against the base revision.
For a confirmed bug, include the failing regression before the fix and its
passing result afterward. Documentation-only changes may mark this not applicable.

## Review and remaining risks

- [ ] This PR targets `develop` (only release PRs target `main`).
- [ ] The description says `Closes #N` for the issue this PR completes, or `Part of #N` when it is one part of a larger issue.
- [ ] I read the contribution guide and kept behavior changes separate from structural moves.
- [ ] I reviewed the diff for secrets and sensitive data; it contains no real keys, prompts, responses, journals, wallet backups or payment payloads.
- [ ] Documentation reflects the change, its limits and any unverified behavior.
- [ ] Changed docs claims are verified against the current code, and every changed docs site page (`apps/docs`) has its English and Spanish files updated together.
- [ ] A change to how something is used (commands, flags, routes, public data, privacy, seller or buyer steps) updates `docs/` and the docs site in English and Spanish, including `reference/data-and-privacy` when new data becomes public.

List remaining risks or decisions. Maintainers arrange the independent reviews
and decide whether to merge. Contributors do not need private vault access or
AI tooling, and are not responsible for arranging reviewers.
