// Bounded local child IPC; only static failures escape, never private message contents.
import assert from 'node:assert/strict';

import {
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import {
  HTTP_MULTI,
  HTTP_MULTI_METHODS,
  type HttpMultiMethod,
} from './http-multiseller-constants';

interface Peer {
  send?(message: object): boolean;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  off(event: 'message', listener: (value: unknown) => void): unknown;
}
export function httpMultiIpc(
  peer: Peer,
  handle: (method: HttpMultiMethod, params: unknown) => Promise<unknown>,
) {
  let next = 0;
  let active = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const send = (message: object) => {
    assert.ok(
      !closed &&
        peer.send &&
        Buffer.byteLength(JSON.stringify(message)) <= HTTP_MULTI.maxBytes,
    );
    peer.send(message);
  };
  const incoming = (value: unknown) => {
    try {
      assert.ok(
        Buffer.byteLength(JSON.stringify(value)) <= HTTP_MULTI.maxBytes,
      );
      const request =
        value !== null &&
        typeof value === 'object' &&
        Object.hasOwn(value, 'method');
      const row = controlObject(
        value,
        request ? ['id', 'method', 'params'] : ['id', 'ok', 'result'],
      );
      const id = controlInteger(row.id, 1);
      if (!request) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (row.ok === true) entry.resolve(row.result);
        else entry.reject(new Error('Synthetic child operation failed'));
        return;
      }
      const method = Object.values(HTTP_MULTI_METHODS).find(
        (item) => item === row.method,
      );
      assert.ok(method && active < HTTP_MULTI.maxPending);
      active++;
      void Promise.resolve()
        .then(() => handle(method, row.params))
        .then(
          (result) => {
            if (!closed) send({ id, ok: true, result: result ?? null });
          },
          () => {
            if (!closed) send({ id, ok: false, result: null });
          },
        )
        .finally(() => {
          active--;
        });
    } catch {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Synthetic IPC failed'));
      }
      pending.clear();
    }
  };
  peer.on('message', incoming);
  return {
    call(method: HttpMultiMethod, params: unknown = null): Promise<unknown> {
      assert.ok(!closed && pending.size < HTTP_MULTI.maxPending);
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Synthetic IPC deadline'));
        }, HTTP_MULTI.operationMs);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error('Synthetic IPC unavailable'));
        }
      });
    },
    close() {
      closed = true;
      peer.off('message', incoming);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Synthetic IPC closed'));
      }
      pending.clear();
    },
  };
}
export type HttpMultiIpc = ReturnType<typeof httpMultiIpc>;
