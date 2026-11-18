# Public product and engineering decisions

This index gives you the product and engineering context you need to work on
Gyblos without access to its private decision records. Contracts and rules live
in the documents each row links to. Maintainers keep this index aligned with
confirmed decisions and decide what is appropriate to publish.

Status labels:

- **Decided**: a confirmed product or engineering direction, rule or contract.
- **Proposed**: a direction that may still change.
- **Design limit**: a known property of the design, not a goal.

No label proves that a capability is implemented, tested end to end or ready for
production. For current behavior, read the linked documentation, its tests and
[limitations](limitations.md).

| Topic                        | Status                         | Public context                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository architecture      | Decided                        | Dependencies flow from protocol through core and adapters to node and apps. Adapters are independent; signed contracts and golden vectors belong to protocol. See [architecture](architecture.md) and [repository rules](../AGENTS.md).                                                                                                           |
| Branches and merges          | Decided                        | Work lands in `develop` through PRs; `main` receives only release PRs, and release tags are cut from `main`. PRs merge with merge commits, never squash, and only with explicit founder approval. See [repository maintenance](repository-maintenance.md).                                                                                        |
| Payment safety               | Decided                        | After authorization, uncertain payments must be reconciled before another purchase. Never retry automatically or remove journals or locks to bypass recovery. See [recovery](recovery.md).                                                                                                                                                        |
| Payment direction            | Decided                        | USDC on Solana payment channels is the intended payment model. This direction alone does not establish production availability. See [payments](payments.md) and [limitations](limitations.md).                                                                                                                                                    |
| Receipt privacy              | Decided                        | Full receipts go only to Gyblos and are not published individually. Public data may be broken down by seller and model; buyer data is published only as totals. Each buyer may see their own receipts. See [receipts](receipts.md), the [metrics collector](metrics-collector.md) and the [protocol specification](../packages/protocol/SPEC.md). |
| Inference privacy            | Design limit                   | A seller can read the prompts it processes. Direct connections and relays expose different network metadata. Trusted execution environments are a future possibility, not a present guarantee. See [limitations](limitations.md).                                                                                                                 |
| Identity and verification    | Decided                        | The product does not require KYC or KYB. Address-based identity and optional public signals are separate from model verification. A verified-model seal is intended for audited open-weight models and does not prove every inference. See [identity](identity.md).                                                                               |
| Quote-driven buyer execution | Decided                        | A zero-price signed quote executes without payment transactions. A positive-price quote uses the paid channel. The buyer budget is a ceiling, not a mode switch. See [buyer routing](payment-sessions.md#buyer-routing).                                                                                                                          |
| Version 2 prices             | Decided                        | Prices use atomic units per million tokens; paid charges round up, subject to the authorized ceiling and zero-delivery rules. Version 1 wire values and signing domains remain separate. See the [protocol specification](../packages/protocol/SPEC.md).                                                                                          |
| Rust components              | Decided                        | TypeScript is the default. A Gyblos Rust component runs as a separate sidecar process that receives no keys or payment headers. See [the stack guide](stack.md#when-to-use-rust).                                                                                                                                                                 |
| Discovery                    | Proposed                       | Signed records and multiple discovery sources are part of the design; guarantees vary by component. See [discovery](discovery.md) and [limitations](limitations.md).                                                                                                                                                                              |
| Buyer routing                | Proposed                       | Local selection and comparison of offers are part of the design. Payment safety applies regardless of the routing approach. See [buyer routing](payment-sessions.md#buyer-routing) and [seller selection](architecture.md#seller-selection).                                                                                                      |
| Configuration and reasoning  | Proposed; some details decided | Per-node settings belong in `config.toml`; version 2 catalogs declare supported reasoning levels. See the [configuration guide](configuration.md) and the [protocol specification](../packages/protocol/SPEC.md).                                                                                                                                 |
| Network metrics              | Proposed                       | Metrics and public aggregation stay separate from the decided receipt privacy policy. The [metrics collector](metrics-collector.md) receives signed receipts and observations and serves aggregates only. A receipt signature identifies its signer; it does not independently prove the reported usage.                                          |

## When a decision is missing

If a decision you need is absent, conflicts with another source or lacks the
detail to implement safely, ask a maintainer before you assume a policy.
Maintainers consult the private records and publish the outcome when
appropriate. You never need access to those records.
