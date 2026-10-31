// Negative/recovery checks use only local observations and independent synthetic chain state, never prompt retry.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

import { PAID_BUYER, PAID_VERDICTS } from '@gyblos/buyer/constants';
import { FILE_MODES, rolePathIn } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { paidWait, type PaidAcceptanceHost } from './paid-acceptance-host';
import { paidBody, paidHttp } from './paid-acceptance-http';

export async function paidPreSend(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
) {
  run.dropNextPaid();
  const response = await paidHttp(run, signal);
  await paidBody(response);
  assert.notEqual(response.statusCode, 200);
  assert.equal(run.engine.attempts(), 0);
  assert.equal(run.payments.deposits(), 0);
  assert.equal(run.payments.authorizations(), 1);
}
export async function paidWrongShares(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
) {
  run.payments.wrongShares(true);
  const response = await paidHttp(run, signal);
  const body = await paidBody(response);
  assert.equal(response.statusCode, 200);
  assert.ok(body.includes(PAID_VERDICTS.DISPUTED));
  run.payments.wrongShares(false);
  await run.payments.confirmLast();
}
async function record() {
  const path = rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.recordsFile);
  const found = await stat(path);
  assert.equal(found.mode & 0o777, FILE_MODES.privateFile);
  assert.ok(found.size <= PAID_BUYER.recordsBytes);
  const content = await readFile(path, 'utf8');
  assert.equal(content.includes(PAID_ACCEPTANCE.text), false);
  assert.equal(content.includes('synthetic paid input'), false);
  return content;
}
export async function paidRecovery(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
) {
  run.payments.blockClaims(true);
  const response = await paidHttp(run, signal);
  const body = await paidBody(response);
  assert.equal(response.statusCode, 200);
  assert.ok(body.includes(PAID_VERDICTS.PENDING));
  const row = controlObject(
    JSON.parse((await record()).trim().split('\n').at(-1)!),
    [
      'nodeId',
      'requestDigest',
      'channelId',
      'verdict',
      'expectedAtomic',
      'claimedAtomic',
    ],
  );
  assert.ok(
    typeof row.channelId === 'string' && typeof row.expectedAtomic === 'string',
  );
  const before = run.payments.settlements();
  const attempts = run.engine.attempts();
  await run.restart(true, () => {
    assert.equal(run.payments.settlements(), before);
    run.payments.blockClaims(false);
  });
  await paidWait(() => run.payments.settlements() === before + 1, signal);
  assert.equal(run.engine.attempts(), attempts);
  await run.payments.confirmRecovered(row.expectedAtomic, row.channelId);
  assert.equal(run.payments.settlements(), run.payments.deposits());
}
export const paidPrivateRecords = record;
