// Shared validation for the local agent protocol translators; no network or payment calls.
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

export function invalidAgentProtocol(): never {
  throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
}
export function protocolObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidAgentProtocol();
  return Object.fromEntries(Object.entries(value));
}
export function protocolFields(
  row: Record<string, unknown>,
  fields: readonly string[],
) {
  if (Object.keys(row).some((key) => !fields.includes(key)))
    invalidAgentProtocol();
}
export function protocolText(value: unknown): string {
  if (typeof value !== 'string') return invalidAgentProtocol();
  return value;
}
export function protocolTextBlocks(
  value: unknown,
  types: readonly string[],
): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > 128)
    return invalidAgentProtocol();
  return value
    .map((item) => {
      const block = protocolObject(item);
      protocolFields(block, ['type', 'text', 'cache_control', 'annotations']);
      if (typeof block.type !== 'string' || !types.includes(block.type))
        return invalidAgentProtocol();
      if (
        block.annotations !== undefined &&
        (!Array.isArray(block.annotations) || block.annotations.length)
      )
        return invalidAgentProtocol();
      if (block.cache_control !== undefined) protocolCache(block.cache_control);
      return protocolText(block.text);
    })
    .join('');
}
export function protocolCache(value: unknown) {
  const cache = protocolObject(value);
  protocolFields(cache, ['type', 'ttl']);
  if (
    cache.type !== 'ephemeral' ||
    (cache.ttl !== undefined && !['5m', '1h'].includes(String(cache.ttl)))
  )
    return invalidAgentProtocol();
}
export function protocolJsonObject(value: unknown) {
  try {
    return protocolObject(JSON.parse(protocolText(value)));
  } catch {
    return invalidAgentProtocol();
  }
}
