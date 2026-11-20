import assert from 'node:assert/strict';
import test from 'node:test';

import { ERROR_DIAGNOSTICS } from '@gyblos/buyer/constants';
import { errorDiagnostic } from '@gyblos/buyer/diagnostics';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

void test('diagnostic codes discard arbitrary messages, causes and invalid owned codes', () => {
  for (const code of Object.values(PROTOCOL_ERROR_CODES))
    assert.equal(
      errorDiagnostic(new ProtocolError(code, 'PRIVATE_SENTINEL')),
      code,
    );
  const invalid = new ProtocolError(
    PROTOCOL_ERROR_CODES.RPC_HTTP,
    'PRIVATE_SENTINEL',
  );
  Object.defineProperty(invalid, 'code', { value: 'PRIVATE_SENTINEL' });
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  for (const value of [
    invalid,
    cyclic,
    new Error('PRIVATE_SENTINEL'),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('PRIVATE_SENTINEL');
        },
      },
    ),
  ])
    assert.equal(errorDiagnostic(value), ERROR_DIAGNOSTICS.UNKNOWN);
  assert.equal(
    errorDiagnostic(new DOMException('PRIVATE_SENTINEL', 'AbortError')),
    ERROR_DIAGNOSTICS.ABORTED,
  );
  assert.equal(
    errorDiagnostic(new DOMException('PRIVATE_SENTINEL', 'TimeoutError')),
    ERROR_DIAGNOSTICS.TIMEOUT,
  );
});
void test('a stateful error code getter cannot replace a matched canonical diagnostic', () => {
  const canonical = Object.values(PROTOCOL_ERROR_CODES)[0]!;
  const error = new ProtocolError(canonical, 'PRIVATE_SENTINEL');
  let reads = 0;
  Object.defineProperty(error, 'code', {
    get() {
      return ++reads === 1 ? canonical : 'PRIVATE_SENTINEL';
    },
  });
  assert.equal(errorDiagnostic(error), canonical);
  assert.equal(reads, 1);
});
for (const validReceipt of [true, false])
  void test(`shared buyer observes bounded ${validReceipt ? 'valid' : 'invalid'} receipt hints despite a truncated body`, async () => {
    const signer = await generateKeyPairSigner();
    let requests = 0;
    let observed: BuyerResponseObservation | undefined;
    const buyer = createBuyer(
      signer,
      'https://rpc-forbidden.invalid/',
      {
        mint: DEVNET_USDC,
        payTo: signer.address,
        feePayer: signer.address,
        receiverAuthorizer: signer.address,
        maxAtomic: '556',
      },
      async () => {
        requests++;
        return new Response('{PRIVATE_SENTINEL', {
          headers: {
            'PAYMENT-RESPONSE': encodePaymentResponseHeader({
              success: true,
              network: DEVNET,
              payer: signer.address,
              transaction: validReceipt
                ? '1'.repeat(64)
                : 'https://private.invalid/?api_key=PRIVATE_SENTINEL',
            }),
          },
        });
      },
      undefined,
      {
        responseObserved(value) {
          observed = value;
        },
      },
    );
    await assert.rejects(
      buyer.request('https://synthetic.invalid/', undefined, {
        measureResponse: true,
      }),
      SyntaxError,
    );
    assert.equal(requests, 1);
    assert.deepEqual(
      observed,
      validReceipt
        ? { status: 200, claimSignature: '1'.repeat(64) }
        : { status: 200 },
    );
  });
