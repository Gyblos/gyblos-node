// A minimal draft-07 JSON Schema evaluator for the keywords the gyblos.toml schema uses; test-only.
// Unknown keywords throw, so the schema cannot rely on a rule this evaluator silently ignores.
type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'markdownDescription',
  'default',
  'examples',
  'definitions',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(type: unknown, value: unknown) {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    default:
      throw new Error(`Unsupported type ${String(type)}`);
  }
}

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createValidator(root: Schema) {
  function resolve(reference: string): Schema {
    const prefix = '#/definitions/';
    if (!reference.startsWith(prefix))
      throw new Error(`Unsupported $ref ${reference}`);
    const definitions = root.definitions;
    const target = isObject(definitions)
      ? definitions[reference.slice(prefix.length)]
      : undefined;
    if (!isObject(target)) throw new Error(`Missing definition ${reference}`);
    return target;
  }

  function keyword(name: string, argument: unknown, value: unknown): boolean {
    const schemas = () => (argument as Schema[]).map((item) => item);
    switch (name) {
      case '$ref':
        return valid(resolve(String(argument)), value);
      case 'type':
        return typeMatches(argument, value);
      case 'const':
        return deepEqual(argument, value);
      case 'enum':
        return (argument as unknown[]).some((item) => deepEqual(item, value));
      case 'not':
        return !valid(argument as Schema, value);
      case 'allOf':
        return schemas().every((item) => valid(item, value));
      case 'oneOf':
        return schemas().filter((item) => valid(item, value)).length === 1;
      case 'pattern':
        return (
          typeof value !== 'string' || new RegExp(String(argument)).test(value)
        );
      case 'minLength':
        return typeof value !== 'string' || value.length >= Number(argument);
      case 'maxLength':
        return typeof value !== 'string' || value.length <= Number(argument);
      case 'minimum':
        return typeof value !== 'number' || value >= Number(argument);
      case 'maximum':
        return typeof value !== 'number' || value <= Number(argument);
      case 'minItems':
        return !Array.isArray(value) || value.length >= Number(argument);
      case 'maxItems':
        return !Array.isArray(value) || value.length <= Number(argument);
      case 'uniqueItems':
        return (
          !Array.isArray(value) ||
          !argument ||
          new Set(value.map((item) => JSON.stringify(item))).size ===
            value.length
        );
      case 'items':
        return (
          !Array.isArray(value) ||
          value.every((item) => valid(argument as Schema, item))
        );
      case 'required':
        return (
          !isObject(value) ||
          (argument as string[]).every((key) => Object.hasOwn(value, key))
        );
      case 'properties':
        return (
          !isObject(value) ||
          Object.entries(argument as Record<string, Schema>).every(
            ([key, schema]) =>
              !Object.hasOwn(value, key) || valid(schema, value[key]),
          )
        );
      case 'additionalProperties':
        return true; // evaluated together with properties in valid()
      default:
        throw new Error(`Unsupported keyword ${name}`);
    }
  }

  function valid(schema: Schema, value: unknown): boolean {
    for (const [name, argument] of Object.entries(schema)) {
      if (ANNOTATIONS.has(name)) continue;
      if (!keyword(name, argument, value)) return false;
    }
    if (schema.additionalProperties === false && isObject(value)) {
      const known = Object.keys(
        isObject(schema.properties) ? schema.properties : {},
      );
      if (Object.keys(value).some((key) => !known.includes(key))) return false;
    }
    return true;
  }

  return (value: unknown) => valid(root, value);
}
