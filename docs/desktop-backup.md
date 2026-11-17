# Desktop wallet backup and restore

The desktop app keeps a protected wallet on this machine (see
[Desktop app](desktop.md#protected-local-wallet)). This page covers its portable
encrypted backup: what you can do with it, the file format, and how the host
keeps keys out of the renderer. It is contributor reference; the public
[desktop app guide](https://docs.gyblos.com/en/buyers/desktop-app) covers
installation and everyday use.

In short:

- The wallet starts locked. Every action on this page needs it unlocked first,
  through **Set up or unlock wallet** and the native explanation that follows.
  Normal startup and status reads never consult the OS secret store.
- You choose where the backup file goes, through a native save dialog. The file
  is encrypted with your password before it is written.
- **Verify saved file** proves the file and password recover the current wallet.
  The app remembers that check for the current address.
- **Restore backup** adds the backed-up wallet next to the current one; it never
  replaces it. **Use wallet** switches the active address.
- Funding stays disabled in every state (`fundingEnabled` is always `false`).
  Backup status is not a spending authorization.

> **Warning:** The password is the only way to open the file. If you lose the
> file or the password, this recovery route is gone, and nobody can recover it
> for you. Keep the file somewhere other than this machine.

## Back up the wallet

1. In **Payments**, open **Wallet details** and choose **Back up wallet**.
2. Choose **Create backup**.
3. Enter a **Backup password** of at least 12 characters and confirm it.
4. Choose **Save encrypted file…** and approve the native confirmation.
5. Choose a new filename in the save dialog.

The app never replaces an existing file. If the write fails, an incomplete
encrypted file may remain; choose another name when you retry. Saving alone does
not mark the backup verified.

## Verify the saved file

1. In the same dialog, choose **Verify saved file**.
2. Enter the backup password again.
3. Choose **Choose file and verify…** and select the saved file.

The app reads the file with a size bound, refuses directories and symlinks, and
checks that authenticated decryption recovers the current address. It does not
replace the installed wallet. A wrong password, an altered file, a different
wallet and inaccessible storage each return a fixed failure status without
details.

## Restore a wallet

1. In **Wallet details**, choose **Restore backup**.
2. Enter the **Backup password**, choose **Choose file and restore…** and select
   the encrypted file. The app adds the recovered wallet as a separate protected
   store; the original wallet and the active selection stay unchanged.
3. Choose **Use wallet** on the restored wallet to make it the active address.

Restoring does not mark the restored wallet's backup verified. Back it up and
verify it while it is the active wallet. Backup requests carry the displayed
address, and a stale address is refused before any file dialog opens.

## File format (version 1)

The Node-only codec `@gyblos/desktop/wallet-backup` seals Ed25519 PKCS8 key
material. It has no filesystem operations. `open` returns the key only after
authenticated decryption and a match with a caller-supplied expected address;
the internal `recover` operation derives the address after authentication
instead.

A file is compact UTF-8 JSON with exactly these fields: `format`, `version`,
`kdf`, `cipher`, `keyFormat`, `salt`, `nonce`, `ciphertext`, `tag`. Field order
does not matter. Duplicate keys, alternate JSON spellings, unknown fields or
profiles, invalid base64 and excessive sizes are refused before any key is
derived. Canonical values and limits live in
[`constants.ts`](../apps/desktop/src/wallet/backup/constants.ts).

| Part            | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Key derivation  | scrypt N=131072, r=8, p=1 (128 MiB), with a 192 MiB memory ceiling and one operation per codec instance     |
| Cipher          | AES-256-GCM, random 16-byte salt, random 12-byte nonce, 16-byte tag                                         |
| Associated data | A fixed-order JSON array of format, version, KDF, cipher, key format, salt and nonce                        |
| Plaintext       | The original DER private key, not the machine-specific local ciphertext                                     |
| Password        | Exact UTF-8 bytes, 12 to 1024 bytes, no normalization or trimming. The length bound is not a strength check |

No plaintext is returned before authentication completes. The primitives are
[Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), and the
scrypt cost matches one of
[OWASP's listed configurations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The format has had no independent cryptographic audit.

## Host boundary

The renderer sends an action, a password and an address, and receives a fixed
status. It never receives a key, a path, file contents or decrypted material.

- The bridge accepts only bounded requests from the main window's current main
  frame. The startup window renders only the loader and cannot perform wallet
  actions.
- Public reads return only the session snapshot; they never decrypt or open a
  native dialog. Explicit unlocking is coalesced. Restore, select, backup and
  copy run one at a time, and a locked wallet refuses them without unlocking.
- Quitting cancels pending work and waits only for work already started: an
  approval, protected preparation, a native file dialog, or a backup or restore.
  An unused wallet never delays it. A write that already started may finish with
  its encrypted file retained, but it reports cancellation, not success, and the
  main window does not appear afterward.
- Passwords are never persisted or logged. Native confirmation is consent, not
  biometric authentication or malware protection.

## Restore into an absent destination

`@gyblos/desktop/wallet-restore` is the Node-only restorer the host calls for
**Restore backup**. It authenticates the v1 format and derives the address from
the recovered key; `codec.open` still requires an expected address.

- It refuses any existing destination: a wallet directory, an empty directory, a
  file, a symlink or interrupted state. It never reads existing wallet keys,
  deletes a directory or replaces another wallet.
- Authentication and a local protection round trip happen before it reserves the
  destination exclusively. Wallet creation after approved access and restoration
  share that claim, so one wins and the other refuses.
- The recovered key is re-encrypted with the destination's OS protection,
  written by exclusive file creation, and reloaded through a read-only loader
  that cannot create a replacement identity.
- Success returns only the public address and status, with both flags `false`.
  The previous installation's remembered verification is not copied.
- Cancellation before the claim installs nothing. Cancellation or failure after
  it returns `RECOVERY_REQUIRED` and keeps the encrypted record or directory
  marker for inspection. There is no automatic rollback, stale-marker removal or
  retry that replaces that state.
- Filesystem errors are sanitized, and the restorer runs one operation at a
  time.

## Remembered verification

After an authenticated saved-file check, the host rereads the current protected
wallet and atomically stores a separate OS-encrypted metadata record. It holds
only the address, a verification schema version, the backup format and version,
and a domain-separated HMAC-SHA256 tag keyed by the current wallet key. It never
holds the password, the file path, the backup or the private key. Equivalent
PKCS8 encodings are accepted when they derive the current address.

The app revalidates the record on the first approved access after a restart and
after each wallet operation. Opening a page or polling status never touches the
protected store. Missing, malformed, oversized, altered, wrong-wallet,
unsupported-version or inaccessible metadata means unverified. Invalid metadata
is kept until a successful check replaces it. POSIX storage must be private;
Windows does not enforce equivalent permissions.

Saving a file or restoring a wallet does not create this record, and a failed
check does not erase an earlier valid one. A rename already started at quit may
finish, and its valid record may remain. The record shows that a check passed
once; it does not prove that a usable backup still exists.

## Validation

The manual `Desktop platforms` workflow
(`.github/workflows/desktop-platforms.yml`) creates fresh unfunded encrypted-key
fixtures on macOS, Windows and Linux. Each system reads all three, reconstructs
the same address, stores it in a fresh injected synthetic store, and reads it
back with a new wallet service. Only encrypted disposable fixtures and public
expected addresses are uploaded, with one-day retention. No real keys, user
passwords or operational state take part.

This proves the bytes are portable and the identity survives. It does not prove
real Keychain, DPAPI or Linux secret-store behavior, or an operational restore.

## Limits

- Native scrypt cannot be interrupted. Cancellation refuses to publish a result,
  but an in-flight derivation runs to completion.
- Buffers are cleared where possible; JavaScript strings, including the
  password, cannot be reliably erased.
- OS encryption protects stored data, not a compromised app or user account.
