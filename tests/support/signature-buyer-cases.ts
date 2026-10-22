import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentResponseHeader } from '@x402/core/http';

import { proofObservation } from '@gyblos/buyer/call-evidence';
import {
  createBuyer,
  type BuyerResponseObservation,
} from '@gyblos/payments-x402';
import {
  DEVNET,
  DEVNET_USDC,
  type BuyerDiagnosticCode,
} from '@gyblos/payments-x402/constants';

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
  observationError?: Error;
  reporterRejects?: boolean;
}

async function observeBuyer(scenario: BuyerScenario) {
  const signer = await generateKeyPairSigner();
  const originalFetch = globalThis.fetch;
  let requests = 0,
    externalCalls = 0,
    signed = 0,
    authorizations = 0;
  let observed: BuyerResponseObservation | undefined;
  const failures: BuyerDiagnosticCode[] = [];
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
        async responseObserved(value) {
          observed = value;
          if (scenario.observationError) throw scenario.observationError;
        },
        responseObservationFailed: scenario.reporterRejects
          ? async (code) => {
              failures.push(code);
              throw new Error(DIAGNOSTIC_CANARY);
            }
          : (code) => {
              failures.push(code);
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
    assert.ok(!JSON.stringify(failures).includes(DIAGNOSTIC_CANARY));
    return { observed, failures };
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
          const { observed, failures } = await observeBuyer({
            transaction,
            measureResponse,
            bodyError,
          });
          assert.deepEqual(observed, { status: 200 });
          assert.deepEqual(failures, []);
        }
      });
    test(`signature hints: buyer retains a valid hint on result and original body failure: measured=${measureResponse}`, async () => {
      for (const bodyError of [undefined, new SyntaxError(DIAGNOSTIC_CANARY)]) {
        const { observed, failures } = await observeBuyer({
          transaction: DIAGNOSTIC_SIGNATURE,
          measureResponse,
          bodyError,
        });
        assert.deepEqual(observed, {
          status: 200,
          claimSignature: DIAGNOSTIC_SIGNATURE,
        });
        assert.deepEqual(failures, []);
      }
    });
    test(`observation failure: buyer returns the original 200 result with a valid receipt and reports the canonical code: measured=${measureResponse}`, async () => {
      const { observed, failures } = await observeBuyer({
        transaction: DIAGNOSTIC_SIGNATURE,
        measureResponse,
        observationError: new Error(DIAGNOSTIC_CANARY),
      });
      assert.deepEqual(observed, {
        status: 200,
        claimSignature: DIAGNOSTIC_SIGNATURE,
      });
      assert.deepEqual(failures, ['RESPONSE_OBSERVATION_FAILED']);
    });
    test(`observation failure: buyer preserves the original body parse error and reports the canonical code: measured=${measureResponse}`, async () => {
      const { failures } = await observeBuyer({
        transaction: DIAGNOSTIC_SIGNATURE,
        measureResponse,
        bodyError: new SyntaxError(DIAGNOSTIC_CANARY),
        observationError: new Error(DIAGNOSTIC_CANARY),
      });
      assert.deepEqual(failures, ['RESPONSE_OBSERVATION_FAILED']);
    });
    for (const truncated of [false, true])
      test(`observation failure: a rejecting asynchronous reporter neither replaces the ${truncated ? 'body error' : 'result'} nor leaks: measured=${measureResponse}`, async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
          const { failures } = await observeBuyer({
            transaction: DIAGNOSTIC_SIGNATURE,
            measureResponse,
            observationError: new Error(DIAGNOSTIC_CANARY),
            reporterRejects: true,
            ...(truncated
              ? { bodyError: new SyntaxError(DIAGNOSTIC_CANARY) }
              : {}),
          });
          assert.deepEqual(failures, ['RESPONSE_OBSERVATION_FAILED']);
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual(unhandled, []);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      });
    test(`observation failure: a successful observer leaves the result and error unchanged without a code: measured=${measureResponse}`, async () => {
      for (const bodyError of [undefined, new SyntaxError(DIAGNOSTIC_CANARY)]) {
        const { observed, failures } = await observeBuyer({
          transaction: DIAGNOSTIC_SIGNATURE,
          measureResponse,
          bodyError,
        });
        assert.deepEqual(observed, {
          status: 200,
          claimSignature: DIAGNOSTIC_SIGNATURE,
        });
        assert.deepEqual(failures, []);
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
