// Validates the supported OpenAI-compatible subset without flattening roles or silently dropping options.
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import {
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  FREE_CHAT_FIELDS,
  type FreeBuyerCode,
} from './constants';

// `param` names the offending request field and `detail` is fixed text or operator-configured values,
// never caller content, so both are safe to return to the client.
export class FreeBuyerError extends Error {
  constructor(
    readonly code: FreeBuyerCode,
    readonly param: string | null = null,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'FreeBuyerError';
  }
}
export interface FreeChatInput extends FreeExecutionBuildInput {
  stream?: true;
}
export const invalidChat = (param: string | null, detail: string) =>
  new FreeBuyerError(FREE_BUYER_CODES.INVALID, param, detail);

export function parseFreeChat(
  value: unknown,
  selection: ModelSelection,
  maximum: number,
  allowStreaming = false,
): FreeChatInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidChat(null, FREE_CHAT_DETAILS.body);
  const extra = Object.keys(value).find(
    (key) => !FREE_CHAT_FIELDS.some((field) => field === key),
  );
  if (extra !== undefined)
    throw invalidChat(
      FREE_CHAT_DETAILS.fieldName.test(extra) ? extra : null,
      FREE_CHAT_DETAILS.fields,
    );
  const row = checked(null, FREE_CHAT_DETAILS.body, () =>
    controlObject(
      value,
      FREE_CHAT_FIELDS.filter((key) => Object.hasOwn(value, key)),
    ),
  );
  if (row.model !== selection.modelId)
    throw invalidChat('model', `model must be ${selection.modelId}`);
  if (
    Object.hasOwn(row, 'stream') &&
    row.stream !== false &&
    !(allowStreaming && row.stream === true)
  )
    throw invalidChat(
      'stream',
      allowStreaming ? FREE_CHAT_DETAILS.stream : FREE_CHAT_DETAILS.noStream,
    );
  const messages = row.messages;
  if (!Array.isArray(messages) || messages.length !== 1)
    throw invalidChat('messages', FREE_CHAT_DETAILS.messages);
  const message = checked('messages', FREE_CHAT_DETAILS.messages, () =>
    controlObject(messages[0], ['role', 'content']),
  );
  if (message.role !== FREE_CHAT_ROLES.USER)
    throw invalidChat('messages', FREE_CHAT_DETAILS.messages);
  const maxTokens =
    row.max_tokens === undefined
      ? maximum
      : checked(
          'max_tokens',
          `max_tokens must be an integer from 1 to ${maximum}`,
          () => controlInteger(row.max_tokens, 1, maximum),
        );
  return {
    messages: [
      { role: FREE_CHAT_ROLES.USER, content: chatText(message.content) },
    ],
    maxTokens,
    ...(row.stream === true ? { stream: true } : {}),
  };
}

// Runs a shared validator and replaces whatever it throws with this field's fixed reason.
function checked<T>(param: string | null, detail: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw invalidChat(param, detail);
  }
}

function chatText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    /[\uD800-\uDFFF]/u.test(value) ||
    Buffer.byteLength(value) > FREE_EXECUTION.inputBytes
  )
    throw invalidChat('messages', FREE_CHAT_DETAILS.content);
  return value;
}
