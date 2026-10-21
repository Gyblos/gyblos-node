import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentResponseHeader } from '@x402/core/http';

import { proofObservation } from '@gyblos/cli/p2p/call-evidence';
import {
  createBuyer,
  type BuyerResponseObservation,
} from '@gyblos/payments-x402/buyer';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';

import {
  DIAGNOSTIC_CANARY,
  DIAGNOSTIC_SIGNATURE,
} from './facilitator-diagnostic-fixture.js';

const INVALID_SIGNATURES = [
  '0'.repeat(64),
  'O'.repeat(88),
  DIAGNOSTIC_CANARY.padEnd(64, '0'),
];
const DEPOSIT_SIGNATURE = '1'.repeat(63) + '2';

interface BuyerScenario {
  transaction: string;
  measureResponse: boolean;
  bodyError?: Error;
}

async function observeBuyer(scenario: BuyerScenario) {
  const signer = await generateKeyPairSigner();
  const originalFetch = globalThis.fetch;
  let requests = 0,
    externalCalls = 0,
    signed = 0,
    authorizations = 0;
  let observed: BuyerResponseObservation | undefined;
  const settlement = {
    success: true,
    network: DEVNET,
    payer: signer.address,
    transaction: scenario.transaction,
  };
  globalThis.fetch = async () => {
    externalCalls++;
    throw new Error('External network is forbidden');
  };
  try {
    const buyer = createBuyer(
      {
        ...signer,
        async signTransactions() {
          signed++;
          throw new Error('Payment signing is forbidden');
        },
      },
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
        const response = Response.json(
          { synthetic: true },
          {
            headers: {
              'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement),
            },
          },
        );
        if (scenario.bodyError)
          response.json = async () => {
            throw scenario.bodyError;
          };
        return response;
      },
      async () => {
        authorizations++;
        throw new Error('Authorization is forbidden');
      },
      {
        responseObserved(value) {
          observed = value;
        },
      },
    );
    const request = buyer.request('https://synthetic.invalid/', undefined, {
      measureResponse: scenario.measureResponse,
    });
    if (scenario.bodyError)
      await assert.rejects(request, (error) => error === scenario.bodyError);
    else {
      const result = await request;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { synthetic: true });
      assert.deepEqual(result.settlement, settlement);
      assert.equal(result.authorization, undefined);
    }
    assert.ok(!JSON.stringify(observed).includes(DIAGNOSTIC_CANARY));
    return observed;
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(requests, 1);
    assert.equal(externalCalls, 0);
    assert.equal(signed, 0);
    assert.equal(authorizations, 0);
  }
}

export function registerSignatureBuyerCases() {
  for (const measureResponse of [false, true]) {
    for (const truncated of [false, true])
      test(`signature hints: buyer preserves original ${truncated ? 'body error' : 'result'} and HTTP status with malformed receipt: measured=${measureResponse}`, async () => {
        for (const transaction of INVALID_SIGNATURES) {
          const bodyError = truncated
            ? new SyntaxError(DIAGNOSTIC_CANARY)
            : undefined;
          const observed = await observeBuyer({
            transaction,
            measureResponse,
            bodyError,
          });
          assert.deepEqual(observed, { status: 200 });
        }
      });
    test(`signature hints: buyer retains a valid hint on result and original body failure: measured=${measureResponse}`, async () => {
      for (const bodyError of [undefined, new SyntaxError(DIAGNOSTIC_CANARY)]) {
        const observed = await observeBuyer({
          transaction: DIAGNOSTIC_SIGNATURE,
          measureResponse,
          bodyError,
        });
        assert.deepEqual(observed, {
          status: 200,
          claimSignature: DIAGNOSTIC_SIGNATURE,
        });
      }
    });
  }
  for (const invalidField of ['claimSignature', 'depositSignature', 'both'])
    test(`signature hints: proof projection omits invalid ${invalidField} while retaining neighboring valid hints`, () => {
      for (const malformed of INVALID_SIGNATURES) {
        const claimSignature =
          invalidField === 'depositSignature'
            ? DIAGNOSTIC_SIGNATURE
            : malformed;
        const depositSignature =
          invalidField === 'claimSignature' ? DEPOSIT_SIGNATURE : malformed;
        let observed: ReturnType<typeof proofObservation> | undefined;
        assert.doesNotThrow(() => {
          observed = proofObservation(200, {
            claimSignature,
            depositSignature,
          });
        });
        assert.deepEqual(observed, {
          status: 200,
          ...(invalidField === 'depositSignature'
            ? { claimSignature: DIAGNOSTIC_SIGNATURE }
            : {}),
          ...(invalidField === 'claimSignature'
            ? { depositSignature: DEPOSIT_SIGNATURE }
            : {}),
        });
        assert.ok(!JSON.stringify(observed).includes(malformed));
      }
    });
}
