// Supports only the small tool-schema subset that the local sandbox can check.
import { isJsonFields } from '@gyblos/core/engine-provider';

const SCHEMA_FIELDS = [
  '$schema',
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'anyOf',
  'additionalProperties',
  'minimum',
  'maximum',
];
const SCHEMA_DIALECTS = [
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
];
const SCHEMA_TYPES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];
const MAX_DEPTH = 16;

function invalid(): never {
  throw new Error('Unsupported tool schema.');
}
function fields(value: unknown): Record<string, unknown> {
  if (!isJsonFields(value)) return invalid();
  return value;
}
export function checkToolSchema(input: unknown, depth = 0): void {
  const schema = fields(input);
  if (
    depth > MAX_DEPTH ||
    Object.keys(schema).some((key) => !SCHEMA_FIELDS.includes(key))
  )
    return invalid();
  if (
    schema.type !== undefined &&
    (typeof schema.type !== 'string' || !SCHEMA_TYPES.includes(schema.type))
  )
    return invalid();
  if (
    schema.$schema !== undefined &&
    (typeof schema.$schema !== 'string' ||
      !SCHEMA_DIALECTS.includes(schema.$schema))
  )
    return invalid();
  for (const bound of [schema.minimum, schema.maximum])
    if (
      bound !== undefined &&
      (typeof bound !== 'number' || !Number.isFinite(bound))
    )
      return invalid();
  if (
    typeof schema.minimum === 'number' &&
    typeof schema.maximum === 'number' &&
    schema.minimum > schema.maximum
  )
    return invalid();
  if (
    schema.description !== undefined &&
    typeof schema.description !== 'string'
  )
    return invalid();
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  )
    return invalid();
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((entry) => typeof entry !== 'string'))
  )
    return invalid();
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.some(
        (entry) =>
          entry !== null &&
          !['string', 'number', 'boolean'].includes(typeof entry),
      ))
  )
    return invalid();
  if (schema.properties !== undefined) {
    for (const property of Object.values(fields(schema.properties)))
      checkToolSchema(property, depth + 1);
  }
  if (schema.items !== undefined) checkToolSchema(schema.items, depth + 1);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) return invalid();
    for (const item of schema.anyOf) checkToolSchema(item, depth + 1);
  }
}

export function matchesToolSchema(input: unknown, value: unknown): boolean {
  const schema = fields(input);
  if (
    schema.anyOf !== undefined &&
    (!Array.isArray(schema.anyOf) ||
      !schema.anyOf.some((item) => matchesToolSchema(item, value)))
  )
    return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value))
    return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'array' && !Array.isArray(value)) return false;
  if (schema.type === 'object' && !isJsonFields(value)) return false;
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (
    schema.type === 'number' &&
    (typeof value !== 'number' || !Number.isFinite(value))
  )
    return false;
  if (
    typeof value === 'number' &&
    typeof schema.minimum === 'number' &&
    value < schema.minimum
  )
    return false;
  if (
    typeof value === 'number' &&
    typeof schema.maximum === 'number' &&
    value > schema.maximum
  )
    return false;
  if (
    (schema.type === 'string' || schema.type === 'boolean') &&
    typeof value !== schema.type
  )
    return false;
  if (
    Array.isArray(value) &&
    schema.items !== undefined &&
    value.some((item) => !matchesToolSchema(schema.items, item))
  )
    return false;
  if (isJsonFields(value)) {
    const properties =
      schema.properties === undefined ? {} : fields(schema.properties);
    if (
      Array.isArray(schema.required) &&
      schema.required.some(
        (name) => typeof name !== 'string' || !Object.hasOwn(value, name),
      )
    )
      return false;
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        if (!matchesToolSchema(properties[name], item)) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}

export function ollamaToolSchema(input: unknown): Record<string, unknown> {
  const schema = fields(input);
  const {
    $schema: _dialect,
    minimum,
    maximum,
    additionalProperties,
    ...output
  } = schema;
  const details = [
    typeof schema.description === 'string' ? schema.description : '',
    typeof minimum === 'number' ? `Minimum: ${minimum}.` : '',
    typeof maximum === 'number' ? `Maximum: ${maximum}.` : '',
    additionalProperties === false
      ? 'Do not include unspecified properties.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (details) output.description = details;
  if (schema.properties !== undefined)
    output.properties = Object.fromEntries(
      Object.entries(fields(schema.properties)).map(([key, value]) => [
        key,
        ollamaToolSchema(value),
      ]),
    );
  if (schema.items !== undefined) output.items = ollamaToolSchema(schema.items);
  if (Array.isArray(schema.anyOf))
    output.anyOf = schema.anyOf.map(ollamaToolSchema);
  return output;
}
