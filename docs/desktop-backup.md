# Internal portable wallet backup format

The Node-only `@gyblos/desktop/wallet-backup` codec seals supplied Ed25519 PKCS8
material and opens it only after authenticated decryption and comparison with a
caller-supplied expected address through `open`; the separate internal `recover`
operation derives the address after authentication. The codec itself has no
filesystem operations. Wallet now offers an explicit, main-process-confirmed
encrypted-file backup and same-address verification through native file dialogs.
The renderer sends a password and receives a fixed status; it never receives a
key, path, file contents or decrypted material. Funding remains disabled.
Successful saved-file checks can now be remembered for the current address; this
indicator is not a spending authorization. The loader automatically prepares a
wallet for a new installation. Settings-only restoration adds a separate
protected identity without replacing the current wallet or automatically
selecting the import.

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
[Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html) primitives;
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
file flow below adds user-controlled save/reopen verification. `backupVerified`
is true only after a saved-file check and validation of its protected
identity-bound metadata. `fundingEnabled` remains false in every state; native
custody acceptance and operational recovery remain separate work.

## Desktop file flow

Choose **Back up wallet** in Settings, then **Create backup**, enter and confirm
at least 12 characters, approve the native confirmation and choose a new
filename. Files are encrypted before writing and created exclusively: existing
files are never replaced. A write failure may retain an incomplete encrypted
file; choose another name on retry. Saving alone does not record verification or
provide a funding capability.

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
public address/status and both flags remain false; restoration does not copy the
previous installation's remembered verification. Cancellation before the claim
installs nothing; cancellation or failure after the claim returns
`RECOVERY_REQUIRED` and preserves the encrypted record or directory marker for
inspection. A completed record may exist after interrupted confirmation. There
is no automatic rollback, stale-marker removal or retry that replaces that
state. Filesystem errors are sanitized and the restorer limits itself to one
operation at a time.

The Electron host session calls this service from Settings after the user enters
a password and selects an encrypted file. Restoration adds a separate protected
store, preserves the original wallet, and leaves selection unchanged. The user
explicitly chooses **Use wallet** to persist a different active address.
Settings can create/verify a backup for that active address. Backup requests
carry the displayed address; a stale address is rejected before opening a file
dialog. Restoration alone does not mark the imported wallet's backup verified.

The bridge accepts only bounded action/password/address requests from the main
window's current main frame; paths, backup bytes and keys stay in the host. The
startup window renders only the shared ASCII loader and is not authorized to
perform wallet actions; the host rejects calls originating from its frame.
Public reads are coalesced, and restore/select/backup/copy are serialized so an
overlapping status request cannot invalidate or change the selected wallet. Quit
cancels the handoff and waits for automatic initialization, native file dialogs
and in-flight backup/restore work. An already-started encrypted write may
finish; the main window must not appear afterward. The legacy first-run setup
helper remains internally testable but is no longer registered with Electron.

## Remembered verification

After authenticated saved-file verification, the host rereads the current
protected wallet and atomically stores a separate OS-encrypted metadata record.
It contains only the address, verification schema version, backup format/version
and a domain-separated HMAC-SHA256 tag bound to the current wallet key. No
password, selected path, backup file or private key is stored in that record.
Equivalent PKCS8 encodings are accepted when they derive the current address;
metadata authentication still uses the installed wallet material. The existing
portable backup and wallet record formats are unchanged.

Wallet revalidates this record on restart, when opened and after an operation.
Missing, malformed, oversized, altered, wrong-identity, unsupported-version or
inaccessible metadata means unverified; invalid metadata is retained until a
successful check replaces only that metadata. POSIX storage must be private;
Windows does not claim equivalent POSIX permission enforcement.

Saving a file or restoring a wallet does not create this record. A failed check
does not erase an earlier valid verification. Cancellation before publication
stores no new approval; an atomic rename already started on quit may finish and
its valid record may remain. The app waits for that work. This records a past
check, not continued possession of a usable backup, malware resistance or a
payment capability. Funding remains unconditionally disabled.
