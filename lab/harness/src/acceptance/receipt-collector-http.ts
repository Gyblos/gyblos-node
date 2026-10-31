// Sends only synthetic acceptance pairs to an explicitly bound loopback receiver; no uploader or external endpoint.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';

import { HTTP_STATUS } from '@gyblos/config';
import { RECEIPT_COLLECTOR_STATUSES } from '@gyblos/core/constants';
import { canonicalJson } from '@gyblos/protocol';
import { controlObject } from '@gyblos/protocol/control-validation';
import type { ReceiptV1 } from '@gyblos/protocol/receipt';
import { LOCAL_COLLECTOR } from '@gyblos/receipt-collector/constants';
import {
  startLocalCollector,
  type CollectorPrincipal,
} from '@gyblos/receipt-collector/service';

import { acceptanceAssert } from './errors';
import { COLLECTOR_ACCEPTANCE } from './receipt-collector-constants';

async function submit(
  url: string,
  receipt: ReceiptV1,
  token: string,
  signal: AbortSignal,
) {
  const target = new URL(url);
  acceptanceAssert(
    target.protocol === 'http:' && target.hostname === '127.0.0.1',
  );
  return new Promise<unknown>((resolve, reject) => {
    const outgoing = request(
      target,
      {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      },
      (response) => {
        let text = '';
        response.on('data', (part: Buffer) => {
          text += part.toString();
          if (text.length > COLLECTOR_ACCEPTANCE.httpBytes) response.destroy();
        });
        response.once('end', () => {
          try {
            acceptanceAssert(response.statusCode === HTTP_STATUS.ok);
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
        response.once('error', reject);
      },
    );
    outgoing.once('error', reject);
    outgoing.end(canonicalJson(receipt));
  });
}
export async function receiptCollectorHttp(
  root: string,
  receipts: readonly ReceiptV1[],
  signal: AbortSignal,
) {
  acceptanceAssert(receipts.length >= 2);
  let now = Date.now();
  const principals = [
    ...new Set(receipts.map((receipt) => receipt.seller.record.buyerNodeId)),
  ].map((buyerNodeId): CollectorPrincipal => ({
    buyerNodeId,
    token: randomBytes(LOCAL_COLLECTOR.tokenBytes).toString('hex'),
    consent: true,
  }));
  const tokenFor = (receipt: ReceiptV1) =>
    principals.find(
      (principal) =>
        principal.buyerNodeId === receipt.seller.record.buyerNodeId,
    )!.token;
  const path = join(
    root,
    COLLECTOR_ACCEPTANCE.directory,
    COLLECTOR_ACCEPTANCE.httpSnapshot,
  );
  const settings = {
    path,
    create: true,
    retentionMs: COLLECTOR_ACCEPTANCE.httpRetentionMs,
    now: () => now,
    port: 0,
    principals,
  } satisfies Parameters<typeof startLocalCollector>[0];
  const first = await startLocalCollector(settings);
  try {
    for (const receipt of receipts)
      acceptanceAssert(
        controlObject(
          await submit(first.url, receipt, tokenFor(receipt), signal),
          ['status'],
        ).status === RECEIPT_COLLECTOR_STATUSES.STORED,
      );
  } finally {
    await first.close();
  }
  now += settings.retentionMs;
  const second = await startLocalCollector({ ...settings, create: false });
  try {
    acceptanceAssert(
      controlObject(
        await submit(second.url, receipts[0]!, tokenFor(receipts[0]!), signal),
        ['status'],
      ).status === RECEIPT_COLLECTOR_STATUSES.DUPLICATE,
    );
    const snapshot = controlObject(JSON.parse(await readFile(path, 'utf8')), [
      'version',
      'retentionMs',
      'clock',
      'entries',
    ]);
    acceptanceAssert(
      Array.isArray(snapshot.entries) &&
        snapshot.entries.length === receipts.length &&
        snapshot.entries.every(
          (entry: unknown) =>
            controlObject(entry, [
              'key',
              'fingerprint',
              'receivedAt',
              'receipt',
            ]).receipt === null,
        ),
    );
  } finally {
    await second.close();
  }
  return true as const;
}
