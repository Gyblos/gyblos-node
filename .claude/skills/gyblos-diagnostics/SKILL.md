---
name: gyblos-diagnostics
description: Investigate Gyblos failures and add content-free operational diagnostics at lifecycle, HTTP and child-process boundaries. Use for missing failure context, flaky tests, log privacy, local log reading or cleanup that masks a primary failure.
---

# Gyblos diagnostics

Read [AGENTS.md](../../../AGENTS.md) first. It owns the rules; this procedure adds
no permissions. Read [docs/diagnostics.md](../../../docs/diagnostics.md) for the
current coverage, schema, controls, bounds and evidence limits. Follow the shared
contributor and PR workflows for implementation and review.

## Investigate

1. Record the exact head, command, host/runtime versions, counts and whether the
   failure happened alone or under the ordinary suite. Preserve the original
   failure evidence privately. A later passing run does not establish a cause.
2. Reproduce in a temporary product/lab home. Read the last validated phase,
   correlation, canonical code, cause category and diagnostic health. For a child,
   include observed exit/signal and stdout/stderr byte counts. Never infer a
   root cause solely from the last phase.
3. Trace ownership and cancellation from the caller through the failing boundary.
   Identify the original failure separately from teardown. Use a controlled
   regression to distinguish competing explanations. Keep the original deadlines,
   skips and concurrency unchanged.
4. For a confirmed bug, demonstrate a failing assertion before the fix. Record
   red and green commands/counts. If historical evidence cannot discriminate the
   trigger, say so even when a related bug is independently proven.

## Add or change a diagnostic boundary

1. Locate the owning package using the code map. Put phase/code catalogs in its
   canonical `constants.ts`; reuse existing codes and safe error mappers.
2. Compose `createDiagnostics` and an injected sink at lifecycle startup. Start a
   local correlation per operation. Report known phase/code/outcome metadata;
   never pass an exception or request to serialization. Keep telemetry and receipt
   channels independent.
3. Preserve the primary failure and emit cleanup failure separately. Close only
   resources the composition owns. Use the existing private-log writer for
   persistence, config-owned paths and a bounded close; library handlers accept a
   sink instead of opening an operator home implicitly.
4. Test the actual boundary with a synthetic secret canary in content, credentials
   and thrown text. Assert useful context and absence of that canary. Also test a
   throwing sink, cancellation/deadline, malformed child output and cleanup
   failure where relevant. Verify unchanged responses, no-retry decisions and
   execution/financial call counts.
5. Update the coverage/operation guide and both public documentation languages.
   Run all local gates and obtain the three independent reviews. Report dropped
   evidence or uninstrumented paths honestly; never describe bounded logging as
   complete capture or proof of production reliability.
