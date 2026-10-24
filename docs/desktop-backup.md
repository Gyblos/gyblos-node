# Internal portable wallet backup format

The Node-only `@gyblos/desktop/wallet-backup` codec seals supplied Ed25519 PKCS8
material and opens it only after authenticated decryption and comparison with a
caller-supplied expected address. The codec itself has no filesystem operations.
Wallet now offers an explicit, main-process-confirmed encrypted-file backup and
same-address verification through native file dialogs. The renderer sends a
password and receives a fixed status; it never receives a key, path, file
contents or decrypted material. Funding and persistent backup approval remain
disabled; there is no application restore/import flow.

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

The exchange harness demonstrates portable bytes and identity preservation, not
real Keychain/DPAPI/Linux-store acceptance or operational restore. The desktop
file flow below adds user-controlled save/reopen verification. Both
`backupVerified` and `fundingEnabled` remain false; native acceptance,
production restore and persistent identity-bound backup approval remain separate
work.

## Desktop file flow

Choose **Create backup** in Wallet, enter and confirm at least 12 characters,
approve the native confirmation and choose a new filename. Files are encrypted
before writing and created exclusively: existing files are never replaced. A
write failure may retain an incomplete encrypted file; choose another name on
retry. The selected file is not a persistent approval or a funding capability.

Choose **Verify saved file**, enter the password again and select the saved
file. Reading is bounded and rejects directories and symlinks; authenticated
decryption must recover the current address. This does not replace the installed
wallet. Wrong passwords, altered files, another identity and inaccessible
storage return sanitized failure status. Closing the app aborts pending
publication and waits for in-flight work; native derivation itself is not
immediately interruptible. Passwords are not persisted or logged; JavaScript
strings cannot be reliably erased. Native confirmation is consent, not biometric
authentication or malware protection.
