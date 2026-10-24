# Internal portable wallet backup format

The Node-only `@gyblos/desktop/wallet-backup` codec seals supplied Ed25519 PKCS8
material and opens it only after authenticated decryption and comparison with a
caller-supplied expected address. It is not connected to the application,
preload or renderer, does not read a wallet, and has no filesystem operations.
There is no user export/import, backup verification or funding feature yet.

Version 1 is compact UTF-8 JSON with exactly these fields: `format`, `version`,
`kdf`, `cipher`, `keyFormat`, `salt`, `nonce`, `ciphertext`, `tag`. Duplicate
keys, alternate JSON spellings, unknown fields/profiles, invalid base64 and
excessive sizes are rejected before deriving a key. Field order is immaterial.
Canonical values and limits live in
[`constants.ts`](../apps/desktop/src/wallet/backup/constants.ts).

The fixed profile is scrypt N=131072, r=8, p=1 (128 MiB algorithm memory), with
an explicit 192 MiB KDF memory ceiling and one operation per codec instance.
Each seal uses a random 16-byte salt, random 12-byte AES-256-GCM nonce and
16-byte tag. A fixed-order JSON array of format, version, KDF, cipher, key
format, salt and nonce is authenticated as additional data. The encrypted
payload is the original DER private material, not the machine-specific local
ciphertext. No plaintext is returned before authentication completes.

Passwords are exact UTF-8 bytes, 12–1024 bytes; no normalization or trimming.
This length bound is not a password-strength guarantee. Cancellation refuses to
publish a result but does not immediately interrupt an in-flight native scrypt
operation. Buffers are cleared where possible; JavaScript strings cannot be
reliably erased. Losing the file or password loses this recovery route.

The profile follows the existing vault direction and uses
[Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html) primitives;
the scrypt cost matches one of
[OWASP's listed configurations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
This does not establish an independent cryptographic audit or production safety.

## Validation boundary

CI produces fresh unfunded encrypted-key fixtures on macOS, Windows and Linux.
Each system reads all three artifacts, reconstructs the same address and
persists it into a fresh **injected synthetic store**, then reads it with a new
wallet-service instance. Only encrypted disposable fixtures and public expected
addresses are uploaded, with one-day retention and public synthetic test
credentials. No existing keys, user passwords or operational state participate.

This demonstrates portable bytes and identity preservation, not real
Keychain/DPAPI/Linux-store acceptance, a user-saved backup, or an operational
restore flow. Both `backupVerified` and `fundingEnabled` remain false. UI,
sensitive authorization, live-wallet export, secure save/reopen, production
restore and identity-bound verification require a later reviewed change.
