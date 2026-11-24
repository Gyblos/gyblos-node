# Guided buyer setup

`pnpm buyer:init` prepares a local buyer from a checkout: it creates the buyer
identity and writes its `selection.json`. It makes no discovery or RPC request,
starts no engine, downloads nothing and sends no payment transaction.

Prerequisites: a checkout with dependencies installed
(`pnpm install --frozen-lockfile`) and an interactive terminal.
`pnpm buyer:init --help` works without one.

```sh
pnpm buyer:init
pnpm buyer:chat
```

Before it saves anything, setup prints a summary similar to the following:

```text
Model: qwen3-0.6b; reasoning: off.
Variant: [none]; Quantization: Q4_K_M.
Maximum output tokens: 4096.
Budget ceiling: 0 USDC per request. Prices: 0 input / 0 output USDC per million tokens.
Channel deposit: 1 USDC. Channel lifetime: 60 minutes.
Sellers: any seller registered in the index, free answers only.
Free signed quotes cause no payment transactions, including with a positive ceiling.
8004 identity verification remains enabled. Existing settings will be refused.
```

Answer `y` or `yes` to save. Then `pnpm buyer:chat` opens a terminal chat; see
[Buyer](running-a-node.md#buyer) for the chat commands and the local buyer
endpoints.

## Short and advanced setup

The default form asks only for a seller's NodeId and, when you give one, that
seller's owner wallet. `pnpm buyer:init --advanced` asks for every field:

| Field                                                     | Short setup                  | Default                           |
| --------------------------------------------------------- | ---------------------------- | --------------------------------- |
| Seller NodeId (Enter for any registered seller)           | asked                        | none: any seller in the index     |
| Seller owner wallet                                       | asked when a NodeId is given | none                              |
| Model ID                                                  | uses the default             | `qwen3-0.6b`                      |
| Variant                                                   | uses the default             | none                              |
| Quantization                                              | uses the default             | `Q4_K_M`                          |
| Maximum output tokens (1 to 32768)                        | uses the default             | `4096`                            |
| Maximum spend per request in USDC                         | uses the default             | `0`                               |
| Maximum input and output price in USDC per million tokens | uses the default             | `0` and `0`                       |
| Discovery index URL                                       | uses the default             | `https://discovery.gyblos.com/v1` |
| Seller relay URL                                          | uses the default             | `https://na1.relay.gyblos.com/`   |
| 8004 devnet RPC URL                                       | uses the default             | `https://api.devnet.solana.com`   |

Guided setup and desktop setup both save a payment session with a 1 USDC deposit
and a one-hour lifetime. The initial request ceiling is zero. Existing paid
profiles must add the session settings before starting. See
[updating an existing payment profile](payment-sessions.md#explicit-startup-policy).

With no seller, setup saves an open-network buyer: no configured sellers and
`"discovery": { "open": true }`. It then uses any seller the index lists whose
8004 agent registry entry matches. Short setup accepts free offers. Advanced
open setup with a positive request maximum and paid rates enables paid Auto (see
[discovery.md](discovery.md#open-discovery)). Short setup does not discover a
model or check a seller's availability.

To name one seller, get its public NodeId and owner wallet from an independent,
trusted source; the seller prints both with `gyblos doctor`. A discovery listing
is not identity proof.

## Answering the questions

- Press Enter to accept the value in brackets. An empty optional field shows as
  `[none]`. A field with a default that can be empty also shows `- to clear`.
- Each answer is checked at once. An invalid answer names the field and gives a
  hint; only that question repeats.
- Custom model names are kept exactly. A name that starts with punctuation or
  contains whitespace asks for confirmation; the buyer checks availability when
  it requests a quote.
- Enter amounts in USDC with up to six decimals (micro-USDC). Price ceilings are
  USDC per million tokens. The file stores exact atomic amounts.

## Spending ceiling

The default spending ceiling and both price ceilings are zero, so the buyer
accepts free quotes only, and `buyer:chat` shows the mode
`automatic (free quotes only)`.

The ceiling applies per request and includes the protocol fee. A positive
ceiling does not force payment: the buyer still chooses free or paid execution
from each verified signed quote. Paid execution also needs devnet SOL and devnet
USDC in the buyer wallet and the pinned tokenizer. CLI setup prepares neither;
run `pnpm node:tokenizer` to install the CLI tokenizer. The desktop buyer
verifies its local copy when a paid profile starts and downloads both pinned
files automatically if the copy is missing or fails verification. See
[Paid endpoint](running-a-node.md#paid-v2-buyer-endpoint).

Stopping a paid desktop chat during tokenizer preparation leaves its budget
available. The app checks readiness with an authenticated, empty request to the
local buyer before it reserves the response budget. If the chat request has
already been sent, the buyer keeps the reservation until the payment outcome is
known.

## Endpoints and relays

The discovery index provides availability only. The generated settings always
enable independent 8004 verification against the configured RPC and never set a
manual-trust override. At runtime the buyer needs both the index and that RPC;
nothing skips discovery or identity checks when they are unavailable.

URLs with a username, password, query or fragment, and remote plain HTTP, are
refused; loopback HTTP is allowed for local services. Keep provider credentials
out of shared configuration and terminal recordings.

The relay must already be allowed by `GYBLOS_RELAYS` (default: the Gyblos
relay). Choosing another relay in the form does not add it to that list, so set
`GYBLOS_RELAYS` before setup and use the same value for chat. The Gyblos relays
admit every client, so chat needs no relay token. `GYBLOS_RELAY_TOKEN` is only
for a relay that requires one: set it privately in the buyer's environment, and
never put it in `selection.json`, a shared command or a recording. Setup does
not ask for, print or save it. See [Relays](running-a-node.md#relays).

The 8004 RPC you enter does not change the payment RPC. Paid execution uses the
`rpcUrl` in the buyer's `role.json`, which role setup takes from
`GYBLOS_RPC_URL` (default `https://api.devnet.solana.com`) when it first creates
the role.

## Local files

Setup saves `selection.json` in the buyer home: `.local/gyblos/buyer/` from a
checkout, or `$GYBLOS_HOME/buyer/` when `GYBLOS_HOME` is set. It creates or
reuses the buyer identity with the devnet USDC mint; existing identities,
journals and other state are kept. The
[`selection.json` reference](running-a-node.md#optional-buyer-selection-and-discovery)
lists every field.

The buyer directory is private (0700) and the settings file is private (0600).
Setup never overwrites settings: it refuses an existing `selection.json`,
including a symlink, before the first question and again when it saves. There is
no force option. To reconfigure, edit the existing file and keep its private
mode.

Cancelling before confirmation changes nothing. If setup is interrupted after
confirmation, new identity files may remain; a rerun reuses them. Inspect the
result before you rerun. Setup does not create a backup or recovery phrase, and
it never resets payment uncertainty or discovery replay history.

## Errors

- `BUYER_INIT_INVALID`: an invalid form value, an unsupported bound or an unsafe
  URL. The message names the field, never its value, and the terminal repeats
  the question.
- `BUYER_INIT_EXISTS`: settings already exist and are preserved. Edit
  `selection.json` to reconfigure.
- `BUYER_INIT_UNAVAILABLE`: unsafe local paths, another setup running, state
  that cannot be read, cancellation during setup, or an existing role with
  another mint. A different mint needs a separate `GYBLOS_HOME`.

A separate `GYBLOS_HOME` creates a separate buyer identity. It does not move
balances, payment history or replay state, so keep the old home for any pending
recovery, reconciliation or withdrawal ([recovery.md](recovery.md)). Never
delete keys or clear journals to make setup succeed.

## For contributors

The CLI is a thin host over `@gyblos/node/buyer-init`, which holds the form
defaults, validation, plan builder and private initializer, so other hosts such
as the desktop app reuse the same rules. Runtime selection, quote verification
and execution stay in the buyer.
