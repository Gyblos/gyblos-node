// Narrows owned synthetic JSON for corruption/privacy tests without introducing untyped fixture values.
import { controlObject } from '@gyblos/protocol/control-validation';

export function blockJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a synthetic JSON object.');
  return controlObject(value, Object.keys(value));
}
