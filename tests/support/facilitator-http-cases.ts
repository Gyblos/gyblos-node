import assert from 'node:assert/strict';
import { request, ServerResponse } from 'node:http';
import test from 'node:test';

import { UptoSvmScheme } from '@x402/svm/upto/facilitator';
import express from 'express';

import {
  DEVNET,
  FACILITATOR_DIAGNOSTIC_CODES,
  FACILITATOR_STAGES,
} from '@gyblos/payments-x402/constants';

import {
  DIAGNOSTIC_CANARY,
  DIAGNOSTIC_SIGNATURE,
  diagnosticBarrier,
  diagnosticUntil,
  withDiagnosticHost,
} from './facilitator-diagnostic-fixture.js';

export function registerFacilitatorHttpCases() {
  test(
    'diagnostic response-error monitoring preserves unhandled error propagation',
    { timeout: 10000 },
    async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        ServerResponse.prototype,
        'emit',
      );
      const originalEmit = ServerResponse.prototype.emit;
      let captured: ServerResponse | undefined;
      ServerResponse.prototype.emit = function (
        this: ServerResponse,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === 'finish' && this.req.url === '/settle') captured = this;
        return originalEmit.call(this, event, ...args);
      };
      try {
        await withDiagnosticHost({}, async ({ call, calls, records }) => {
          const response = await call(undefined, {});
          await response.json();
          assert.ok(captured);
          const error = new Error(DIAGNOSTIC_CANARY);
          assert.throws(
            () => captured!.emit('error', error),
            (value) => value === error,
          );
          assert.equal(
            records.at(-1)?.stage,
            FACILITATOR_STAGES.RESPONSE_ERROR,
          );
          assert.equal(calls.settle, 0);
        });
      } finally {
        if (descriptor)
          Object.defineProperty(ServerResponse.prototype, 'emit', descriptor);
        else Reflect.deleteProperty(ServerResponse.prototype, 'emit');
      }
    },
  );
  test(
    'diagnostic host fixture restores SDK and fetch when owned listen fails',
    { timeout: 10000 },
    async () => {
      const originalListen = express.application.listen;
      const originalSettle = UptoSvmScheme.prototype.settle;
      const originalVerify = UptoSvmScheme.prototype.verify;
      const originalFetch = globalThis.fetch;
      express.application.listen = () => {
        throw new Error('Synthetic owned listen failure');
      };
      try {
        await assert.rejects(
          withDiagnosticHost({}, async () => {}),
          /Synthetic owned listen failure/,
        );
        assert.equal(UptoSvmScheme.prototype.settle, originalSettle);
        assert.equal(UptoSvmScheme.prototype.verify, originalVerify);
        assert.equal(globalThis.fetch, originalFetch);
      } finally {
        express.application.listen = originalListen;
        UptoSvmScheme.prototype.settle = originalSettle;
        UptoSvmScheme.prototype.verify = originalVerify;
        globalThis.fetch = originalFetch;
      }
    },
  );

  test(
    'facilitator records early close before SDK resolution without aborting or retrying',
    { timeout: 10000 },
    async () => {
      const reached = diagnosticBarrier<void>();
      const release = diagnosticBarrier<void>();
      await withDiagnosticHost(
        {
          settle: async () => {
            reached.resolve();
            await release.promise;
            return {
              success: true,
              network: DEVNET,
              transaction: DIAGNOSTIC_SIGNATURE,
            };
          },
        },
        async ({ url, body, records, calls }) => {
          const client = request(url + '/settle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
          client.on('error', () => {});
          client.end(JSON.stringify(body));
          try {
            await reached.promise;
            client.destroy();
            await diagnosticUntil(() =>
              records.some(
                (row) => row.stage === FACILITATOR_STAGES.RESPONSE_CLOSED,
              ),
            );
            const closed = records.find(
              (row) => row.stage === FACILITATOR_STAGES.RESPONSE_CLOSED,
            )!;
            assert.equal(closed.httpStatus, undefined);
            assert.ok(
              !records.some(
                (row) => row.stage === FACILITATOR_STAGES.SDK_RESULT,
              ),
            );
            release.resolve();
            await diagnosticUntil(() =>
              records.some(
                (row) => row.stage === FACILITATOR_STAGES.SDK_RESULT,
              ),
            );
            const result = records.find(
              (row) => row.stage === FACILITATOR_STAGES.SDK_RESULT,
            )!;
            assert.equal(result.attemptId, closed.attemptId);
            assert.equal(result.sdkSuccess, true);
            assert.equal(calls.settle, 1);
            assert.ok(
              !records.some(
                (row) => row.stage === FACILITATOR_STAGES.RESPONSE_FINISHED,
              ),
            );
          } finally {
            release.resolve();
            client.destroy();
          }
        },
      );
    },
  );
  test(
    'facilitator separates response serialization error from a successful SDK result',
    { timeout: 10000 },
    async () => {
      await withDiagnosticHost(
        {
          settle: async () => ({
            success: true,
            network: DEVNET,
            transaction: DIAGNOSTIC_SIGNATURE,
            toJSON() {
              throw new Error(DIAGNOSTIC_CANARY);
            },
          }),
        },
        async ({ call, records, calls }) => {
          const response = await call();
          assert.equal(response.status, 500);
          await response.json();
          assert.ok(
            records.some(
              (row) =>
                row.stage === FACILITATOR_STAGES.SDK_RESULT &&
                row.sdkSuccess === true,
            ),
          );
          assert.equal(
            records.find(
              (row) => row.stage === FACILITATOR_STAGES.RESPONSE_ERROR,
            )?.code,
            FACILITATOR_DIAGNOSTIC_CODES.RESPONSE_ERROR,
          );
          assert.ok(
            !records.some(
              (row) => row.stage === FACILITATOR_STAGES.SDK_EXCEPTION,
            ),
          );
          assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
          assert.equal(calls.settle, 1);
        },
      );
    },
  );
  for (const [body, status] of [
    ['{', 400],
    ['"' + 'x'.repeat(70 * 1024) + '"', 413],
  ] as const)
    test(
      `facilitator starts diagnostics before parser rejection ${status}`,
      { timeout: 10000 },
      async () => {
        await withDiagnosticHost({}, async ({ url, records, calls }) => {
          const response = await fetch(url + '/settle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          assert.equal(response.status, status);
          await response.text();
          await diagnosticUntil(() =>
            records.some(
              (row) => row.stage === FACILITATOR_STAGES.RESPONSE_FINISHED,
            ),
          );
          assert.equal(records[0]!.stage, FACILITATOR_STAGES.RECEIVED);
          assert.equal(records.at(-1)!.httpStatus, status);
          assert.ok(
            !records.some(
              (row) => row.stage === FACILITATOR_STAGES.SDK_STARTED,
            ),
          );
          assert.equal(calls.settle, 0);
        });
      },
    );
  test(
    'same-channel concurrent attempts retain distinct IDs and a shared instance',
    { timeout: 10000 },
    async () => {
      await withDiagnosticHost({}, async ({ call, records, calls }) => {
        const responses = await Promise.all([call(), call()]);
        for (const response of responses) {
          assert.equal(response.status, 200);
          await response.json();
        }
        await diagnosticUntil(
          () =>
            records.filter(
              (row) => row.stage === FACILITATOR_STAGES.RESPONSE_FINISHED,
            ).length === 2,
        );
        assert.equal(new Set(records.map((row) => row.attemptId)).size, 2);
        assert.equal(new Set(records.map((row) => row.instanceId)).size, 1);
        assert.equal(calls.settle, 2);
        assert.ok(
          !records.some(
            (row) => row.stage === FACILITATOR_STAGES.RESPONSE_CLOSED,
          ),
        );
      });
    },
  );
}
