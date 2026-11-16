// Protects when roles upload and how they describe themselves: release builds always upload to the
// collector, development builds only with an explicit URL; no network is used here.
import assert from 'node:assert/strict';
import test from 'node:test';

import { COLLECTOR_URL } from '@gyblos/config';
import {
  collectorUrl,
  uploadClient,
} from '@gyblos/node/receipt-uploader-startup';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from '@gyblos/protocol/receipt-upload';

void test('release builds upload to the collector; development builds only with an explicit URL', () => {
  assert.equal(collectorUrl({}), undefined);
  assert.equal(
    collectorUrl({ GYBLOS_VERSION: '0.1.0-beta.12' }),
    COLLECTOR_URL,
  );
  assert.equal(
    collectorUrl({ GYBLOS_COLLECTOR_URL: 'http://localhost:8787/v1/' }),
    'http://localhost:8787/v1',
  );
  assert.equal(
    collectorUrl({
      GYBLOS_VERSION: '0.1.0-beta.12',
      GYBLOS_COLLECTOR_URL: 'https://staging.example/v1',
    }),
    'https://staging.example/v1',
  );
});

void test('the client kind, version, platform and architecture describe the running app', () => {
  assert.deepEqual(
    uploadClient(
      P2P_ROLES.SELLER,
      { GYBLOS_VERSION: '0.1.0-beta.12' },
      { platform: 'linux', arch: 'x64' },
    ),
    {
      kind: RECEIPT_UPLOAD_CLIENTS.SELLER_NODE,
      appVersion: '0.1.0-beta.12',
      platform: RECEIPT_UPLOAD_PLATFORMS.LINUX,
      arch: RECEIPT_UPLOAD_ARCHES.X64,
    },
  );
  assert.equal(
    uploadClient(
      P2P_ROLES.BUYER,
      {},
      { platform: 'darwin', arch: 'arm64', electron: '39.0.0' },
    ).kind,
    RECEIPT_UPLOAD_CLIENTS.BUYER_DESKTOP,
  );
  const cli = uploadClient(
    P2P_ROLES.BUYER,
    { GYBLOS_VERSION: 'not a version!' },
    { platform: 'freebsd', arch: 'riscv64' },
  );
  assert.deepEqual(cli, {
    kind: RECEIPT_UPLOAD_CLIENTS.BUYER_CLI,
    appVersion: '0.0.0-dev',
    platform: RECEIPT_UPLOAD_PLATFORMS.OTHER,
    arch: RECEIPT_UPLOAD_ARCHES.OTHER,
  });
});
