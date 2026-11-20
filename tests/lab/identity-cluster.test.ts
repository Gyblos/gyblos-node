import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_GENESIS } from '@gyblos/config';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import { assertDevnet } from '../../lab/tools/identity-flow';

void test('cluster verification rejects a mainnet RPC even if its URL says devnet', async () => {
  const url = 'https://devnet.example';
  await assert.rejects(
    assertDevnet(url, async () => 'mainnet-genesis'),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.code === PROTOCOL_ERROR_CODES.WRONG_CLUSTER,
  );
  await assertDevnet(url, async () => DEVNET_GENESIS);
});
