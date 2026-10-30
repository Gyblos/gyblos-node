// Exercises registry refusals through the actual startup HTTP buyer, then checks its durable metadata.
// All registry mutations and state inspection belong to this child’s disposable synthetic home.
import { readFile, stat } from 'node:fs/promises';

import { generateKeyPairSigner } from '@solana/kit';

import {
  FILE_MODES,
  HTTP_STATUS,
  ROLE_FILES,
  rolePathIn,
} from '@gyblos/config';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { IDENTITY_STATE } from '@gyblos/node/constants';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlAtomic,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { acceptanceAssert } from './errors';
import { IDENTITY_ACCEPTANCE } from './identity-constants';
import {
  RECEIPT_ACCEPTANCE_CASES,
  type ReceiptAcceptanceCase,
} from './receipt-constants';
import { receiptBody, receiptHttp } from './receipt-http';
import { confirmedAnswer } from './receipt-phases';
import type { ReceiptScenario } from './receipt-startup';
import { confirmedSnapshots } from './receipt-state';

async function identitySnapshot(run: ReceiptScenario) {
  const path = rolePathIn(
    run.environment,
    P2P_ROLES.BUYER,
    ROLE_FILES.identityState,
  );
  const info = await stat(path);
  acceptanceAssert(
    info.size <= IDENTITY_STATE.maxBytes &&
      (info.mode & FILE_MODES.permissionMask) === FILE_MODES.privateFile,
  );
  const input = controlObject(JSON.parse(await readFile(path, 'utf8')), [
    'schemaVersion',
    'scope',
    'rows',
  ]);
  acceptanceAssert(input.schemaVersion === IDENTITY_STATE.schemaVersion);
  const rows = controlArray(input.rows, IDENTITY_STATE.maxRows);
  acceptanceAssert(rows.length === 1);
  const row = controlObject(rows[0], ['binding', 'revoked']);
  const binding = controlObject(row.binding, [
    'nodeId',
    'owner',
    'asset',
    'sequence',
  ]);
  acceptanceAssert(
    binding.nodeId === run.subject().nodeId && typeof row.revoked === 'boolean',
  );
  return {
    sequence: BigInt(controlAtomic(binding.sequence)),
    owner: binding.owner,
    asset: binding.asset,
    revoked: row.revoked,
  };
}
async function refusedIdentity(run: ReceiptScenario, signal: AbortSignal) {
  const attempts = run.provider.calls();
  const dials = run.binding.dials();
  const stored = await confirmedSnapshots(run.environment);
  const reads = run.registry.counts().reads;
  const listed = await run.listed();
  acceptanceAssert(
    listed.sellers.length === 1 &&
      listed.sellers[0]!.catalog.owner === run.subject().owner,
  );
  const response = await receiptHttp(run.buyer().url, false, signal);
  const body = controlObject(JSON.parse(await receiptBody(response)), [
    'error',
  ]);
  const error = controlObject(body.error, ['message', 'type', 'param', 'code']);
  acceptanceAssert(
    response.statusCode === HTTP_STATUS.serviceUnavailable &&
      error.code === SELLER_SELECTION_CODES.NO_CANDIDATES,
  );
  acceptanceAssert(
    run.provider.calls() === attempts &&
      run.binding.dials() === dials &&
      run.registry.counts().reads > reads,
  );
  acceptanceAssert(
    (await confirmedSnapshots(run.environment)).length === stored.length,
  );
}
export async function receiptIdentityPhases(
  run: ReceiptScenario,
  signal: AbortSignal,
) {
  const cases: ReceiptAcceptanceCase[] = [];
  const initial = IDENTITY_ACCEPTANCE.initialSequence;
  const before = await identitySnapshot(run);
  acceptanceAssert(
    !before.revoked &&
      before.sequence === initial &&
      before.owner === run.subject().owner,
  );
  let refusals = 0;
  const deny = async (name: ReceiptAcceptanceCase) => {
    await refusedIdentity(run, signal);
    refusals++;
    cases.push(name);
  };
  run.registry.available(false);
  try {
    await deny(RECEIPT_ACCEPTANCE_CASES.RPC_OUTAGE);
  } finally {
    run.registry.available(true);
  }
  run.registry.oversized(true);
  try {
    await deny(RECEIPT_ACCEPTANCE_CASES.RPC_LIMIT);
  } finally {
    run.registry.oversized(false);
  }
  const unchanged = await identitySnapshot(run);
  acceptanceAssert(
    unchanged.sequence === before.sequence &&
      unchanged.owner === before.owner &&
      unchanged.asset === before.asset &&
      unchanged.revoked === before.revoked,
  );
  const restore = run.registry.revoke(run.subject().nodeId);
  await deny(RECEIPT_ACCEPTANCE_CASES.REVOKED);
  acceptanceAssert((await identitySnapshot(run)).revoked);
  await run.restartBuyer(true);
  const reads = run.registry.counts().reads;
  await confirmedAnswer(run, false, signal);
  acceptanceAssert(
    run.registry.counts().reads === reads &&
      (await identitySnapshot(run)).revoked,
  );
  cases.push(RECEIPT_ACCEPTANCE_CASES.MANUAL_OVERRIDE);
  await run.restartBuyer();
  await deny(RECEIPT_ACCEPTANCE_CASES.OVERRIDE_REMOVED);
  restore();
  await run.restartBuyer();
  await deny(RECEIPT_ACCEPTANCE_CASES.REVOCATION_RESTART);
  acceptanceAssert(
    (await identitySnapshot(run)).revoked &&
      (await identitySnapshot(run)).sequence === initial &&
      (await identitySnapshot(run)).asset === before.asset,
  );
  const changedOwner = await generateKeyPairSigner();
  await run.registry.bind(
    { ...run.subject(), owner: changedOwner.address },
    initial + 1n,
  );
  await deny(RECEIPT_ACCEPTANCE_CASES.OWNER_CHANGED);
  const changed = await identitySnapshot(run);
  acceptanceAssert(
    !changed.revoked &&
      changed.owner === changedOwner.address &&
      changed.sequence === initial + 1n,
  );
  run.registry.rollback(run.subject().nodeId, initial);
  await run.restartBuyer();
  await deny(RECEIPT_ACCEPTANCE_CASES.ROLLBACK_RESTART);
  acceptanceAssert(
    (await identitySnapshot(run)).sequence === changed.sequence &&
      (await identitySnapshot(run)).owner === changed.owner,
  );
  await run.registry.bind(run.subject(), initial + 2n);
  await run.restart();
  const confirmed = await confirmedAnswer(run, true, signal);
  const recovered = await identitySnapshot(run);
  acceptanceAssert(
    !recovered.revoked &&
      recovered.sequence === initial + 2n &&
      recovered.owner === run.subject().owner,
  );
  cases.push(RECEIPT_ACCEPTANCE_CASES.RECOVERY);
  return { cases, refusals, answers: 2, confirmed };
}
