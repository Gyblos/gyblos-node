# Internal portable wallet backup format

The Node-only `@gyblos/desktop/wallet-backup` codec seals supplied Ed25519 PKCS8
material and opens it only after authenticated decryption and comparison with a
caller-supplied expected address through `open`; the separate internal `recover`
operation derives the address after authentication. The codec itself has no
filesystem operations. Wallet now offers an explicit, main-process-confirmed
encrypted-file backup and same-address verification through native file dialogs.
The renderer sends a password and receives a fixed status; it never receives a
key, path, file contents or decrypted material. Funding and persistent backup
approval remain disabled; there is no application restore/import UI or IPC flow.

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

The manual `Desktop platforms` workflow
(`.github/workflows/desktop-platforms.yml`) produces fresh unfunded
encrypted-key fixtures on macOS, Windows and Linux. Each system reads all three
artifacts, reconstructs the same address and persists it into a fresh **injected
synthetic store**, then reads it with a new wallet-service instance. Only
encrypted disposable fixtures and public expected addresses are uploaded, with
one-day retention and public synthetic test credentials. No existing keys, user
passwords or operational state participate.

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
storage return sanitized failure status. Closing the app aborts before a write
starts and waits for in-flight work. A write already started is allowed to
finish with its encrypted file retained, but reports cancellation rather than
success. Native derivation itself is not immediately interruptible. Passwords
are not persisted or logged; JavaScript strings cannot be reliably erased.
Native confirmation is consent, not biometric authentication or malware
protection.

## Internal restoration into an absent destination

`@gyblos/desktop/wallet-restore` exposes a Node-only restorer. It accepts
supplied backup bytes and a password, authenticates the unchanged v1 format and
derives the address from the recovered Ed25519 key. The original `codec.open`
still requires an expected address; the separate internal `recover` operation
does not weaken that verification contract.

Restoration refuses any existing wallet directory, including empty directories,
files, symlinks and interrupted state. It never reads existing wallet keys,
deletes a directory or replaces another wallet. Authentication and a local
protection round trip occur before exclusive destination reservation. Automatic
creation and restoration share that directory claim, so one can win and the
other must refuse the existing destination.

The recovered key is re-encrypted with the destination protection adapter,
persisted by exclusive final-file creation, and reloaded through a read-only
loader that cannot initialize a replacement identity. Success returns only the
public address/status and both flags remain false. Cancellation before the claim
installs nothing; cancellation or failure after the claim returns
`RECOVERY_REQUIRED` and preserves the encrypted record or directory marker for
inspection. A completed record may exist after interrupted confirmation. There
is no automatic rollback, stale-marker removal or retry that replaces that
state. Filesystem errors are sanitized and the restorer limits itself to one
operation at a time.

This service is not connected to Electron, preload, the UI or automatic startup.
A separate entry before automatic creation remains future work. Tests use fresh
unfunded identities and synthetic protection adapters, including all nine
producer/reader combinations; native Keychain/DPAPI/Linux-store acceptance and
power-loss durability are not established. Funding, persistent backup approval,
signing, payment-state recovery and mobile linking remain disabled or outside
this service.

Restoration validates its reserved directory before writing and checks its
identity again around descriptor I/O. Final record creation is exclusive and
never uses a replacing rename, so a concurrently appearing record is preserved.
This deliberately allows an incomplete encrypted final record after a crash; it
is not atomic whole-record visibility or proof of power-loss durability. The
existing automatic-creation publication path is unchanged. Protected-record
reload now reads at most the configured maximum plus one byte and rejects a
changed descriptor size, including growth after the initial stat.
