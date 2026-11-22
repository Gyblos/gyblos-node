---
name: delete-comment
description: Audit source-code comments in a repository, classify each as tautology, excuse, stale, or decision record, and remove, report, or migrate it. Use when asked to clean up comments, enforce a no-comments policy, or repeat a comment-removal pass.
---

# Delete code comments

Read `AGENTS.md`, `docs/code-standards.md`, the contributor workflow and the PR workflow first. Follow repository ownership, privacy, issue and validation rules. Declare the paths in scope before scanning. If no narrower section is named, use the whole first-party codebase.

## Inventory and classify

1. Use language-aware parsers or the repository comment scanner to enumerate real comments in every source file in scope. Do not count comment-looking text inside strings, regular expressions, templates or generated output.
2. Review each comment against the current implementation and nearby tests, contracts and docs. Assign exactly one category:
   - **Tautology**: restates names, branches, return values, or behavior that the code already makes clear.
   - **Excuse**: rationalizes a workaround, fake value, unsafe shortcut, or other hack that should be replaced.
   - **Stale**: refers to removed behavior, old names, superseded decisions or facts contradicted by the current implementation.
   - **Decision Record**: states a durable, non-obvious choice and why it was made or what trade-off it accepts.
3. Do not call a comment stale only because it mentions a legacy format. Confirm the format is no longer supported. Do not label a constraint a decision record unless the choice or rationale is durable and non-obvious.

## Apply the category

- Delete tautology and stale comments without changing code behavior.
- For an excuse, delete the comment and file a focused issue that names the implementation, explains the problem, proposes the replacement direction and lists acceptance criteria. Do not hide implementation work in the comment-removal change. If issue access is unavailable, keep the issue body as a handoff draft and state why it could not be filed.
- Move a decision record into `docs/adr/` (or the repository's established ADR location). Record context, decision, consequences and links to the owning code or public contract. If an ADR already records the same decision, link it and delete the duplicate comment instead of creating another record.
- Remove the source comment after moving its durable content. Do not leave a shortened decision in code.

## Maintain the ratchet

Use the repository's no-new-comments lint rule and per-file source-comment budget. Existing comments are grandfathered only by that checked-in budget. New files have a budget of zero unless an approved exception is recorded by maintainers.

After deletions, reduce the affected file budgets in the same change. Never raise a budget, add an inline suppression, or move a comment to another file to bypass the rule. Keep non-source documentation, ADRs and examples outside the source-comment scanner unless the task explicitly includes them.

## Report and validate

- Report counts by category, files changed, issues filed or blocked, ADRs created or updated, and comments still covered by the ratchet.
- Estimate removable lines by counting physical source lines occupied by actual comments; distinguish the current cleanup from the full remaining potential.
- Confirm the code diff changes comments and whitespace only. Run the focused comment check and applicable repository gates when permitted. Follow `AGENTS.md` for behavior tests, exact counts and skipped checks.
