// Validates the supported OpenAI-compatible subset without flattening roles or silently dropping options.
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import { controlInteger, controlObject } from '@gyblos/protocol/control-validation';
import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import { FREE_BUYER_CODES, type FreeBuyerCode } from './constants.js';

export class FreeBuyerError extends Error {
  constructor(readonly code: FreeBuyerCode) { super(code); this.name = 'FreeBuyerError'; }
}
export function parseFreeChat(value: unknown, selection: ModelSelection, maximum: number): FreeExecutionBuildInput {
  try {
    const optional = value && typeof value === 'object'
      ? ['stream', 'max_tokens'].filter((key) => Object.hasOwn(value, key)) : [];
    const row = controlObject(value, ['model', 'messages', ...optional]);
    if (row.model !== selection.modelId || (Object.hasOwn(row, 'stream') && row.stream !== false) ||
      !Array.isArray(row.messages) || row.messages.length !== 1)
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    const message = controlObject(row.messages[0], ['role', 'content']);
    if (message.role !== FREE_CHAT_ROLES.USER) throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    const maxTokens = row.max_tokens === undefined ? maximum : controlInteger(row.max_tokens, 1, maximum);
    return { messages: [{ role: FREE_CHAT_ROLES.USER, content: chatText(message.content) }], maxTokens };
  } catch { throw new FreeBuyerError(FREE_BUYER_CODES.INVALID); }
}

function chatText(value: unknown): string {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value) > FREE_EXECUTION.inputBytes)
    throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
  return value;
}
