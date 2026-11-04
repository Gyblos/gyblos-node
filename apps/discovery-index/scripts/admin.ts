// Founder-only enrollment commands for the discovery index, run from a checkout with a Wrangler login:
//   pnpm index:invite --contact <email or telegram> [--days 14]   prints a one-use invite code
//   pnpm index:revoke <NodeId>                                     stops that seller from publishing
// They write to the remote D1 through Wrangler (no admin route on the index). Only the invite's SHA-256
// reaches D1; the code is printed once here and never stored. --dry-run prints the SQL instead.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '@gyblos/runtime';

import { REGISTRATION, REGISTRATION_STATUS } from '../src/constants';

const WRANGLER = 'wrangler@4.151.1';
const DATABASE = 'gyblos-discovery';
// RFC 4648 base32 in lowercase: five bits per character out of eight-bit bytes.
const BASE32 = {
  alphabet: 'abcdefghijklmnopqrstuvwxyz234567',
  bitsPerCharacter: 5,
  bitsPerByte: 8,
  mask: 0b11111,
} as const;
const DEFAULT_DAYS = REGISTRATION.inviteLifetimeMs / REGISTRATION.dayMs;
const DAYS = /^[1-9][0-9]?$/;

export interface AdminOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Runs the SQL against the remote D1; tests and --dry-run replace it.
  execute: (sql: string) => void;
  now: () => number;
  random: (bytes: number) => Uint8Array;
}

// RFC 4648 base32, lowercase and unpadded: 16 bytes become 26 characters.
function base32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let text = '';
  const { alphabet, bitsPerCharacter, bitsPerByte, mask } = BASE32;
  for (const byte of bytes) {
    value = (value << bitsPerByte) | byte;
    bits += bitsPerByte;
    while (bits >= bitsPerCharacter) {
      text += alphabet[(value >>> (bits - bitsPerCharacter)) & mask];
      bits -= bitsPerCharacter;
    }
  }
  if (bits > 0) text += alphabet[(value << (bitsPerCharacter - bits)) & mask];
  return text;
}

export function newInvite(random: AdminOutput['random']) {
  const code = `${REGISTRATION.invitePrefix}${base32(random(REGISTRATION.inviteBytes))}`;
  return { code, hash: createHash('sha256').update(code).digest('hex') };
}

function invite(args: readonly string[], output: AdminOutput) {
  const { values } = parseArgs({
    args: [...args],
    options: { contact: { type: 'string' }, days: { type: 'string' } },
  });
  const contact = values.contact ?? '';
  const days = values.days ?? String(DEFAULT_DAYS);
  // The pattern admits no quote, so the contact is safe inside the SQL literal below.
  if (!REGISTRATION.contact.test(contact)) {
    output.stderr(
      '--contact is required: an email or telegram handle (letters, digits, @ . _ + -)\n',
    );
    return 1;
  }
  if (!DAYS.test(days) || Number(days) > REGISTRATION.maxInviteDays) {
    output.stderr(`--days takes 1 to ${REGISTRATION.maxInviteDays}\n`);
    return 1;
  }
  const { code, hash } = newInvite(output.random);
  const now = output.now();
  const expiresAt = now + Number(days) * REGISTRATION.dayMs;
  output.execute(
    `INSERT INTO discovery_invites (invite_hash, contact, created_at, expires_at) VALUES ('${hash}', '${contact}', ${now}, ${expiresAt});`,
  );
  output.stdout(
    `Invite for ${contact}, valid until ${new Date(expiresAt).toISOString()} (one use):\n\n  ${code}\n\nSend it to the seller; it is not stored and cannot be shown again.\n`,
  );
  return 0;
}

function revoke(args: readonly string[], output: AdminOutput) {
  const [nodeId, ...rest] = args;
  if (rest.length || !nodeId || !REGISTRATION.nodeId.test(nodeId)) {
    output.stderr('usage: pnpm index:revoke <NodeId (64 lowercase hex)>\n');
    return 1;
  }
  output.execute(
    `UPDATE discovery_registrations SET status = '${REGISTRATION_STATUS.REVOKED}' WHERE node_id = '${nodeId}';`,
  );
  output.stdout(
    `Revoked ${nodeId}: its publishes are refused. A new invite can admit it again.\n`,
  );
  return 0;
}

export function runAdmin(argv: readonly string[], output: AdminOutput) {
  const [command, ...args] = argv;
  if (command === 'invite') return invite(args, output);
  if (command === 'revoke') return revoke(args, output);
  output.stderr(
    'usage: pnpm index:invite --contact <contact> [--days 14] | pnpm index:revoke <NodeId>\n',
  );
  return 1;
}

function wranglerExecute(sql: string) {
  execFileSync(
    'npx',
    [WRANGLER, 'd1', 'execute', DATABASE, '--remote', '--command', sql],
    {
      cwd: resolve(dirname(new URL(import.meta.url).pathname), '..'),
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  process.exitCode = runAdmin(
    argv.filter((arg) => arg !== '--dry-run'),
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      execute: dryRun
        ? (sql) => process.stdout.write(`${sql}\n`)
        : wranglerExecute,
      now: Date.now,
      random: (bytes) => randomBytes(bytes),
    },
  );
}
