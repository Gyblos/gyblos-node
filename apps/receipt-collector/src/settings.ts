// Validates an explicit private local configuration; never falls back to role homes, wallets or environment credentials.
import { isAbsolute, resolve } from 'node:path';

import {
  controlArray,
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { readPrivateFile } from '@gyblos/runtime/private-file';
import { RECEIPT_RETENTION } from '@gyblos/telemetry-file/retained-receipts';

import { LOCAL_COLLECTOR } from './constants';
import { collectorInvalid } from './errors';

export interface CollectorPrincipal {
  buyerNodeId: string;
  token: string;
  consent: true;
}
export interface CollectorOptions {
  path: string;
  create: boolean;
  retentionMs: number;
  principals: readonly CollectorPrincipal[];
  port: number;
  now?: () => number;
  requestMs?: number;
}
export interface CollectorSettings extends CollectorOptions {
  now: () => number;
  requestMs: number;
}
export function collectorSettings(value: unknown): CollectorSettings {
  try {
    const optional = ['now', 'requestMs'].filter(
      (key) => value && typeof value === 'object' && Object.hasOwn(value, key),
    );
    const input = controlObject(value, [
      'path',
      'create',
      'retentionMs',
      'principals',
      'port',
      ...optional,
    ]);
    if (
      typeof input.path !== 'string' ||
      !isAbsolute(input.path) ||
      resolve(input.path) !== input.path ||
      typeof input.create !== 'boolean'
    )
      return collectorInvalid();
    const principals = controlArray(
      input.principals,
      LOCAL_COLLECTOR.principals,
    ).map((value): CollectorPrincipal => {
      const principal = controlObject(value, [
        'buyerNodeId',
        'token',
        'consent',
      ]);
      if (principal.consent !== true) return collectorInvalid();
      return {
        buyerNodeId: controlHex(principal.buyerNodeId),
        token: controlHex(principal.token, LOCAL_COLLECTOR.tokenBytes),
        consent: true,
      };
    });
    if (
      !principals.length ||
      new Set(principals.map((row) => row.token)).size !== principals.length ||
      new Set(principals.map((row) => row.buyerNodeId)).size !==
        principals.length
    )
      return collectorInvalid();
    if (input.now !== undefined && typeof input.now !== 'function')
      return collectorInvalid();
    const clock = input.now;
    const now: () => number =
      typeof clock === 'function'
        ? () =>
            controlInteger(
              clock(),
              0,
              Number.MAX_SAFE_INTEGER - RECEIPT_RETENTION.maximumMs,
            )
        : Date.now;
    return {
      path: input.path,
      create: input.create,
      retentionMs: controlInteger(
        input.retentionMs,
        1,
        RECEIPT_RETENTION.maximumMs,
      ),
      port: controlInteger(input.port, 0, LOCAL_COLLECTOR.maxPort),
      principals,
      now,
      requestMs:
        input.requestMs === undefined
          ? LOCAL_COLLECTOR.requestMs
          : controlInteger(input.requestMs, 1, LOCAL_COLLECTOR.requestMs),
    };
  } catch {
    return collectorInvalid();
  }
}
export async function loadCollectorSettings(
  path: string,
): Promise<CollectorSettings> {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path)
      return collectorInvalid();
    const text = await readPrivateFile(path, LOCAL_COLLECTOR.configBytes);
    if (text === undefined) return collectorInvalid();
    const input = controlObject(JSON.parse(text), [
      'version',
      'path',
      'create',
      'retentionMs',
      'principals',
      'port',
    ]);
    if (input.version !== LOCAL_COLLECTOR.version) return collectorInvalid();
    return collectorSettings({
      path: input.path,
      create: input.create,
      retentionMs: input.retentionMs,
      principals: input.principals,
      port: input.port,
    });
  } catch {
    return collectorInvalid();
  }
}
