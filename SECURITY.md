# Security policy

Gyblos Node is experimental, devnet-only and has not completed an independent
security audit. Do not use mainnet keys, production secrets or real customer data.
See the [known limitations](docs/limitations.md).

## Supported revisions

Security fixes target the latest `main` revision. Older commits, experimental
branches and preview binaries have no maintenance commitment. There is no stable
production release or guaranteed support period. Include the exact commit in a
report; the maintainer will assess older behavior against the current source.

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting form](https://github.com/Gyblos/gyblos-node/security/advisories/new).
If that feature is unavailable, email **gilbertsahumada@gmail.com** with a short
non-sensitive summary and ask for a private way to share details. Do not publish
exploit details in an issue or send credentials or wallet material by email.

Include the affected revision and component, the trust boundary involved,
preconditions, expected and observed behavior, and the smallest reproduction
using synthetic data. Explain the affected principal or resource. Configuration
that cannot be observed from source should be identified as unverified.

Test only a local environment you own, with generated unfunded identities and
synthetic services. This policy does not authorize testing deployed discovery
indexes, relays, RPC services, other nodes or other people's data. Do not make
payments, create persistent access, exhaust resources or continue beyond the
minimum effect needed to explain the issue.

## Handling and disclosure

The initial security maintainer is
[@gilbertsahumada](https://github.com/gilbertsahumada). Reports are handled on a
best-effort basis without a guaranteed deadline or bounty. The maintainer will
review the evidence, coordinate a fix and regression coverage when applicable,
and agree on disclosure and attribution with the reporter. Please coordinate
disclosure before publishing details. No private report is automatically safe to
copy into a public PR, advisory or test fixture.

Confirmed credential exposure requires revocation or rotation; deleting a file
does not remove it from Git history or invalidate the credential. Never clear a
payment journal or retry an uncertain payment to reproduce an issue.
