// Startup acceptance assertions for answer/receipt success and fault isolation; never retries an inference.
import { chmod } from 'node:fs/promises';

import { FILE_MODES, HTTP_STATUS, receiptPathsIn } from '@gyblos/config';
import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  publishRecord,
} from '@gyblos/discovery-http';
import {
  CONTROL_LIMITS,
  FREE_EXECUTION_CODES,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { controlHex, controlObject } from '@gyblos/protocol/control-validation';
import { parsePublicV2 } from '@gyblos/protocol/public-v2';

import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import { receiptBody, receiptHttp } from './receipt-http';
import { receiptWait, type ReceiptScenario } from './receipt-startup';
import { confirmedSnapshots } from './receipt-state';

export async function confirmedAnswer(
  run: ReceiptScenario,
  streaming: boolean,
  signal: AbortSignal,
) {
  const calls = run.provider.calls();
  const saved = run.buyer().receipts().saved;
  const response = await receiptHttp(run.buyer().url, streaming, signal);
  acceptanceAssert(response.statusCode === HTTP_STATUS.ok);
  const body = await receiptBody(response);
  acceptanceAssert(body.includes(RECEIPT_ACCEPTANCE.text));
  if (streaming) acceptanceAssert(body.includes('[DONE]'));
  await receiptWait(
    () =>
      !run.buyer().receipts().active &&
      run.buyer().receipts().saved === saved + 1,
    signal,
  );
  acceptanceAssert(run.provider.calls() === calls + 1);
  return (await confirmedSnapshots(run.environment)).length;
}
export async function missingReceipt(
  run: ReceiptScenario,
  signal: AbortSignal,
) {
  const paths = receiptPathsIn(run.environment, P2P_ROLES.BUYER);
  const failures = run.buyer().receipts().failed;
  const calls = run.provider.calls();
  const dials = run.binding.dials();
  await chmod(paths.state, RECEIPT_ACCEPTANCE.unsafeFileMode);
  try {
    const response = await receiptHttp(run.buyer().url, false, signal);
    acceptanceAssert(
      response.statusCode === HTTP_STATUS.ok &&
        (await receiptBody(response)).includes(RECEIPT_ACCEPTANCE.text),
    );
    await receiptWait(
      () =>
        !run.buyer().receipts().active &&
        run.buyer().receipts().failed > failures,
      signal,
    );
    acceptanceAssert(
      run.provider.calls() === calls + 1 && run.binding.dials() === dials + 1,
    );
  } finally {
    await chmod(paths.state, FILE_MODES.privateFile);
  }
}
export async function cancelledAnswer(
  run: ReceiptScenario,
  signal: AbortSignal,
) {
  const calls = run.provider.calls();
  const dials = run.binding.dials();
  const cancelled = run.provider.cancellations();
  run.provider.hold();
  const response = await receiptHttp(run.buyer().url, true, signal);
  try {
    acceptanceAssert(response.statusCode === HTTP_STATUS.ok);
    const iterator = response[Symbol.asyncIterator]();
    let text = '';
    while (!text.includes(RECEIPT_ACCEPTANCE.text)) {
      const part = await iterator.next();
      acceptanceAssert(!part.done && Buffer.isBuffer(part.value));
      text += part.value.toString('utf8');
      acceptanceAssert(text.length <= RECEIPT_ACCEPTANCE.reportBytes);
    }
    response.destroy();
    await receiptWait(() => run.provider.cancellations() > cancelled, signal);
    acceptanceAssert(
      run.provider.calls() === calls + 1 && run.binding.dials() === dials + 1,
    );
  } finally {
    response.destroy();
    run.provider.release();
  }
}
export async function failedAnswer(run: ReceiptScenario, signal: AbortSignal) {
  await run.restart();
  const calls = run.provider.calls();
  const dials = run.binding.dials();
  run.provider.setFailure(true);
  try {
    const response = await receiptHttp(run.buyer().url, false, signal);
    const body = await receiptBody(response);
    acceptanceAssert(
      response.statusCode === HTTP_STATUS.serviceUnavailable &&
        body.includes(FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE),
    );
    acceptanceAssert(response.headers['x-should-retry'] === 'false');
    acceptanceAssert(
      run.provider.calls() === calls + 1 && run.binding.dials() === dials + 1,
    );
  } finally {
    run.provider.setFailure(false);
  }
}
export async function configuredCap(run: ReceiptScenario, signal: AbortSignal) {
  await run.restart(1);
  const calls = run.provider.calls();
  const response = await receiptHttp(run.buyer().url, false, signal);
  const body = await receiptBody(response);
  acceptanceAssert(body.includes(FREE_EXECUTION_CODES.BUYER_CAP));
  acceptanceAssert(run.provider.calls() === calls);
  acceptanceAssert(response.headers['x-should-retry'] === 'false');
}

export async function restartReceiptRoles(run: ReceiptScenario) {
  const old = await confirmedSnapshots(run.environment);
  const rows = await run.index.storage.list({
    model: RECEIPT_ACCEPTANCE.modelId,
    now: Date.now(),
    limit: 1,
    after: null,
  });
  acceptanceAssert(rows.length === 1);
  const envelope = controlObject(JSON.parse(rows[0]!.catalogJson), [
    'record',
    'signature',
  ]);
  const catalog = {
    record: parsePublicV2(envelope.record),
    signature: controlHex(envelope.signature, CONTROL_LIMITS.signatureBytes),
  };
  await run.restart();
  acceptanceAssert(
    (await run.listed()).sellers[0]!.catalog.sequence > run.initialSequence,
  );
  acceptanceAssert(
    (await confirmedSnapshots(run.environment)).length === old.length,
  );
  acceptanceAssert(catalog.record.expiresAt > Date.now());
  let stale = false;
  try {
    await publishRecord({
      baseUrl: run.index.baseUrl,
      record: catalog,
      fetch: run.index.fetch,
    });
  } catch (error) {
    stale =
      error instanceof DiscoveryError &&
      error.code === DISCOVERY_ERROR_CODES.STALE_RECORD;
  }
  acceptanceAssert(stale);
}
