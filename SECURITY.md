# Security policy

Gyblos Node is experimental, devnet-only and has not completed an independent
security audit. Don't use mainnet keys, production secrets or real customer
data. See the [known limitations](docs/limitations.md).

## Supported revisions

Security fixes target the `develop` branch and ship in the next release, which
is tagged from `main`. Older releases, commits and experimental branches have no
maintenance commitment, and there is no stable production release or guaranteed
support period. Include the exact release version or commit in your report; the
maintainer assesses older behavior against the current source.

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting form](https://github.com/Gyblos/gyblos-node/security/advisories/new).
If that form is unavailable, email **gilbertsahumada@gmail.com** with a short,
non-sensitive summary and ask for a private way to share details. Don't publish
exploit details in an issue, and never send credentials or wallet material by
email.

Include:

- the affected release or commit, and the component;
- the trust boundary involved and the affected principal or resource;
- preconditions;
- expected and observed behavior;
- the smallest reproduction, using synthetic data.

Mark any configuration you can't observe from the source as unverified.

## Scope

In scope: the code in this repository, including the seller node and `gyblos`
CLI, the local buyer, the desktop app, the install scripts, the seller image and
the release packages. Release seller images are signed with Sigstore; see
[image signature](docs/running-a-node.md#image-signature) for how to verify one.

Test only a local environment you own, with generated unfunded identities and
synthetic services. This policy does not authorize testing deployed services:
the discovery index, the metrics collector (`collector.gyblos.com`), relays, RPC
services, the docs site and download hosts, other people's nodes or other
people's data. Don't make payments, create persistent access, exhaust resources
or go beyond the minimum effect needed to show the issue.

## Handling and disclosure

The maintainers listed in [CODEOWNERS](.github/CODEOWNERS) handle reports on a
best-effort basis, with no guaranteed deadline or bounty. They review the
evidence, coordinate a fix and regression coverage when applicable, and agree
on disclosure and attribution with the reporter. Coordinate disclosure before
you publish details. A private report is never automatically safe to copy into
a public PR, advisory or test fixture.

A confirmed credential exposure requires revocation or rotation: deleting a
file doesn't remove it from Git history or invalidate the credential. Never
clear a payment journal or retry an uncertain payment to reproduce an issue.
