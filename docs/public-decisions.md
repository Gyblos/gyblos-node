# Public product and engineering decisions

This index gives contributors the context needed to work on Gyblos without
access to its private research and decision vault. Repository contracts and
rules remain in the documents linked below. Maintainers keep this index aligned
with confirmed decisions and review what is appropriate to publish.

**Decided** describes a product or engineering direction. **Proposed** describes
work that may change. Neither label proves that a capability is implemented,
tested end to end or ready for production. For current behavior and limitations,
consult the linked implementation documentation and tests.

| Topic                       | Status                                     | Public context                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository architecture     | Decided                                    | Dependencies flow from protocol through core and adapters to node and apps. Adapters are independent; signed contracts and golden vectors belong to protocol. See [architecture](architecture.md) and [repository rules](../AGENTS.md).                                                                                                              |
| Payment safety              | Established rule                           | After authorization, uncertain payments must be reconciled before another purchase; never retry automatically or remove journals or locks to bypass recovery. See [recovery](recovery.md).                                                                                                                                                           |
| Payment direction           | Decided product direction                  | USDC on Solana payment channels is the intended payment model. This direction alone does not establish production availability. See [payments](payments.md) and [limitations](limitations.md).                                                                                                                                                       |
| Receipt privacy             | Decided policy                             | Full receipts are not published individually. Public data may be broken down by seller and model; buyer data is published only as totals. Each buyer may see their own receipts. The broader collection and metrics design remains proposed. See [receipt policy](receipt-policy.md) and the [protocol specification](../packages/protocol/SPEC.md). |
| Inference privacy           | Design limit                               | A seller can read the prompts it processes. Direct connections and relays expose different network metadata. Trusted execution environments are a future possibility, not a present guarantee. See [limitations](limitations.md).                                                                                                                    |
| Identity and verification   | Decided direction                          | The product does not require KYC/KYB; address-based identity and optional public signals are separate from model verification. A verified-model seal is intended for audited open-weight models and does not prove every inference. See [identity](identity.md).                                                                                     |
| Version 2 prices            | Decided contract                           | Prices use atomic units per million tokens, with the charge rounded up. Version 1 wire values and signing domains remain separate. See the [protocol specification](../packages/protocol/SPEC.md).                                                                                                                                                   |
| Discovery                   | Proposed overall; parts implemented        | Signed records and multiple discovery sources are part of the design; implementation and operational guarantees vary by component. See [discovery](discovery.md) and [limitations](limitations.md).                                                                                                                                                  |
| Buyer routing               | Proposed overall; parts implemented        | Local selection and comparison of offers are part of the design. Payment safety applies regardless of the routing approach. See [architecture](architecture.md) and [limitations](limitations.md).                                                                                                                                                   |
| Configuration and reasoning | Proposed overall; selected details decided | Per-node settings belong in `gyblos.toml`; version 2 catalogs declare supported reasoning levels. Check the [configuration guide](configuration.md) and [protocol specification](../packages/protocol/SPEC.md) for implemented behavior.                                                                                                             |
| Network metrics             | Proposed                                   | Metrics, collection and public aggregation remain separate from the confirmed receipt privacy policy. A receipt signature identifies its signer; it does not independently prove the reported usage. See [receipt policy](receipt-policy.md).                                                                                                        |

If a needed decision is absent, conflicts with another source or lacks enough
detail to implement safely, raise it with a maintainer before assuming a new
policy. Maintainers consult the private vault and publish the applicable outcome
when appropriate; contributors are not required to access or update the vault.

Future Gyblos Rust components run as separate processes with the boundaries in
[the stack guide](stack.md). Paid-v2 startup is conditional on a configured
payment server; consult [limitations](limitations.md) for validation scope.
