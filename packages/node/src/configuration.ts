// Validates local configuration primitives before consumers touch keys, offers or network resources.
// Validation failures use static codes and never include field contents.
import { isAddress } from '@solana/kit';

import { NODE_CONFIGURATION_LIMITS, type NodeErrorCode } from './constants.js';
import { NodeError } from './errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function configurationObject(
  value: unknown,
  code: NodeErrorCode,
  allowedFields?: readonly string[],
) {
  if (!isRecord(value)) throw new NodeError(code);
  if (
    allowedFields &&
    Object.keys(value).some((key) => !allowedFields.includes(key))
  )
    throw new NodeError(code);
  return value;
}

export function configurationString(value: unknown, code: NodeErrorCode) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > NODE_CONFIGURATION_LIMITS.stringCharacters
  )
    throw new NodeError(code);
  return value;
}

export function configurationAddress(value: unknown, code: NodeErrorCode) {
  const text = configurationString(value, code);
  if (!isAddress(text)) throw new NodeError(code);
  return text;
}

export function configurationNodeId(value: unknown, code: NodeErrorCode) {
  const text = configurationString(value, code);
  if (
    text.length !== NODE_CONFIGURATION_LIMITS.nodeIdHexCharacters ||
    !/^[0-9a-f]+$/.test(text)
  )
    throw new NodeError(code);
  return text;
}

export function configurationRpcUrl(value: unknown, code: NodeErrorCode) {
  const text = configurationString(value, code);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new NodeError(code);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new NodeError(code);
  return text;
}

export function configurationJson(text: string, code: NodeErrorCode): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new NodeError(code);
  }
}
