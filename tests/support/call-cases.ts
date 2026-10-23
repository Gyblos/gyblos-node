// Registers buyer call-evidence cases: receipts, deposits and lost responses are recorded durably and
// never invented, and diagnostics keep only canonical codes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentResponseHeader } from '@x402/core/http';

import {
  CALL_OUTCOMES,
  CALL_PHASES,
  ERROR_DIAGNOSTICS,
  P2P_JOURNAL_STATES,
} from '@gyblos/buyer/constants';
import { errorDiagnostic } from '@gyblos/buyer/diagnostics';
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import {
  createBuyer,
  type BuyerResponseObservation,
} from '@gyblos/payments-x402';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import { callFault } from './call-fixture.js';

export function registerCallCases() {
  void test('actual call preserves the observed receipt and safe proof failure without another invocation', async () => {
    const { journal, call } = await callFault();
    assert.equal(journal.state, P2P_JOURNAL_STATES.UNCERTAIN);
    assert.equal(call.outcome, CALL_OUTCOMES.UNCERTAIN);
    assert.deepEqual(call.failure, {
      phase: CALL_PHASES.PROOF,
      code: PROTOCOL_ERROR_CODES.TRANSACTION_UNKNOWN,
    });
    assert.deepEqual(journal.failure, call.failure);
    assert.deepEqual(call.observedPayment, {
      status: 200,
      claimSignature: '1'.repeat(64),
    });
    assert.deepEqual(journal.observedPayment, call.observedPayment);
    assert.equal(journal.channelId, 'synthetic-channel');
    assert.equal(journal.ceilingAtomic, '556');
    assert.deepEqual(
      call.metrics?.map(({ status, transport }) => ({ status, transport })),
      [
        { status: 402, transport: 'iroh-direct' },
        { status: 200, transport: 'iroh-direct' },
      ],
    );
    assert.equal('claimSignature' in journal, false);
  });
  void test('actual call retains a discovered deposit as an unverified hint after a later proof failure', async () => {
    const { journal, call } = await callFault({ afterDiscovery: true });
    assert.equal(journal.state, P2P_JOURNAL_STATES.UNCERTAIN);
    assert.equal(call.outcome, CALL_OUTCOMES.UNCERTAIN);
    assert.deepEqual(call.failure, {
      phase: CALL_PHASES.PROOF,
      code: PROTOCOL_ERROR_CODES.TRANSACTION_UNKNOWN,
    });
    assert.equal(
      journal.observedPayment?.depositSignature,
      '1'.repeat(63) + '2',
    );
    assert.equal(journal.observedPayment?.claimSignature, '1'.repeat(64));
    assert.deepEqual(call.observedPayment, journal.observedPayment);
    assert.equal('depositSignature' in journal, false);
    assert.equal('claimSignature' in journal, false);
  });
  void test('actual call preserves body-read phase and keeps an observed receipt unverified', async () => {
    const { journal, call } = await callFault({ invalidBody: true });
    assert.equal(journal.state, P2P_JOURNAL_STATES.UNCERTAIN);
    assert.equal(call.outcome, CALL_OUTCOMES.UNCERTAIN);
    assert.deepEqual(call.failure, {
      phase: CALL_PHASES.RESPONSE,
      code: ERROR_DIAGNOSTICS.RESPONSE_INVALID,
    });
    assert.equal(journal.observedPayment?.claimSignature, '1'.repeat(64));
    assert.equal('claimSignature' in journal, false);
  });
  void test('actual lost response retains authorization and cannot invent a receipt', async () => {
    const { journal, call } = await callFault({ lostResponse: true });
    assert.equal(journal.state, P2P_JOURNAL_STATES.UNCERTAIN);
    assert.equal(call.outcome, CALL_OUTCOMES.UNCERTAIN);
    assert.deepEqual(call.failure, {
      phase: CALL_PHASES.REQUEST,
      code: ERROR_DIAGNOSTICS.UNKNOWN,
    });
    assert.equal(call.observedPayment, undefined);
    assert.equal(journal.channelId, 'synthetic-channel');
  });
  void test('post-proof receipt validation failure preserves the confirmed financial classification', async () => {
    const { journal, call } = await callFault({ afterProof: true });
    assert.equal(journal.state, P2P_JOURNAL_STATES.CONFIRMED);
    assert.equal(call.outcome, CALL_OUTCOMES.CONFIRMED_ERROR);
    assert.deepEqual(call.failure, {
      phase: CALL_PHASES.SETTLEMENT,
      code: PROTOCOL_ERROR_CODES.UNTRUSTED_RECEIPT,
    });
    assert.equal(journal.claimSignature, '1'.repeat(64));
  });
  void test('hostile thrown values cannot break durable uncertain failure recording', async () => {
    const { journal, call } = await callFault({ hostileError: true });
    assert.equal(journal.state, P2P_JOURNAL_STATES.UNCERTAIN);
    assert.deepEqual(call.failure, {
      phase: CALL_PHASES.PROOF,
      code: ERROR_DIAGNOSTICS.UNKNOWN,
    });
    assert.equal(journal.observedPayment?.status, 200);
  });
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
}
