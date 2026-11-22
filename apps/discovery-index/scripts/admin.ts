// Owns founder-only invite/revoke/restore commands. Drizzle compiles mutations for Wrangler;
// the index exposes no admin route. Codes are printed once and only their hashes reach D1.
// --dry-run prints compiled SQL without executing a remote command.
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { isMain } from '@gyblos/runtime';

import {
  REGISTRATION,
  REGISTRATION_STATUS,
  type RegistrationStatus,
} from '../src/constants';
import {
  createInviteQuery,
  setRegistrationStatusQuery,
} from '../src/registration-queries';
import { compileSql, wranglerD1 } from './wrangler-d1';

// RFC 4648 base32 in lowercase: five bits per character out of eight-bit bytes.
const BASE32 = {
  alphabet: 'abcdefghijklmnopqrstuvwxyz234567',
  bitsPerCharacter: 5,
  bitsPerByte: 8,
  mask: 0b11111,
} as const;
const DEFAULT_DAYS = REGISTRATION.inviteLifetimeMs / REGISTRATION.dayMs;
const DAYS = /^[1-9][0-9]?$/;

export interface AdminIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Runs the SQL against the remote D1; tests and --dry-run replace it.
  execute: (sql: string) => void;
  now: () => number;
  random: (bytes: number) => Uint8Array;
}

// RFC 4648 base32, lowercase and unpadded: 16 bytes become 26 characters.
export function base32(bytes: Uint8Array) {
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

export function newInvite(random: AdminIo['random']) {
  const code = `${REGISTRATION.invitePrefix}${base32(random(REGISTRATION.inviteBytes))}`;
  return { code, hash: createHash('sha256').update(code).digest('hex') };
}

function invite(args: readonly string[], output: AdminIo) {
  const { values } = parseArgs({
    args: [...args],
    options: { contact: { type: 'string' }, days: { type: 'string' } },
  });
  const contact = values.contact ?? '';
  const days = values.days ?? String(DEFAULT_DAYS);
  // Validate the supported contact shape before constructing the ORM mutation.
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
    compileSql((database) =>
      createInviteQuery(database, {
        inviteHash: hash,
        contact,
        createdAt: now,
        expiresAt,
      }),
    ),
  );
  output.stdout(
    `Invite for ${contact}, valid until ${new Date(expiresAt).toISOString()} (one use):\n\n  ${code}\n\nSend it to the seller; it is not stored and cannot be shown again.\n`,
  );
  return 0;
}

// Revoked NodeIds cannot be readmitted by an invite (no publish, 403 NODE_REVOKED on registration);
// only `restore` makes them active again.
function setStatus(
  args: readonly string[],
  output: AdminIo,
  status: RegistrationStatus,
) {
  const [nodeId, ...rest] = args;
  const command =
    status === REGISTRATION_STATUS.REVOKED ? 'index:revoke' : 'index:restore';
  if (rest.length || !nodeId || !REGISTRATION.nodeId.test(nodeId)) {
    output.stderr(`usage: pnpm ${command} <NodeId (64 lowercase hex)>\n`);
    return 1;
  }
  output.execute(
    compileSql((database) =>
      setRegistrationStatusQuery(database, nodeId, status),
    ),
  );
  output.stdout(
    status === REGISTRATION_STATUS.REVOKED
      ? `Revoked ${nodeId}: its publishes and registrations are refused until \`pnpm index:restore\`.\n`
      : `Restored ${nodeId}: it may publish again (no effect if it was never registered).\n`,
  );
  return 0;
}

export function runAdmin(argv: readonly string[], output: AdminIo) {
  const [command, ...args] = argv;
  if (command === 'invite') return invite(args, output);
  if (command === 'revoke')
    return setStatus(args, output, REGISTRATION_STATUS.REVOKED);
  if (command === 'restore')
    return setStatus(args, output, REGISTRATION_STATUS.ACTIVE);
  output.stderr(
    'usage: pnpm index:invite --contact <contact> [--days 14] | pnpm index:revoke <NodeId> | pnpm index:restore <NodeId>\n',
  );
  return 1;
}

function wranglerExecute(sql: string) {
  wranglerD1(sql, { target: '--remote', json: false });
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
