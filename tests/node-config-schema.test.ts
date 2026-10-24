// Keeps the published gyblos.toml JSON Schema in step with the validator: both accept every example and
// valid fixture, both reject every invalid fixture except the documented cross-field rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ENGINE_KINDS,
  NODE_CONFIG_LIMITS,
  NODE_CONFIG_VERSION,
  OFFER_CURRENCIES,
} from '@gyblos/node/constants';
import { parseNodeConfig, parseTomlDocument } from '@gyblos/node/node-config';
import { MODEL_CATALOG } from '@gyblos/protocol';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';

import { createValidator } from './support/json-schema.js';
import {
  exampleFiles,
  SCHEMA_PATH,
  VALID_FIXTURES,
} from './support/node-config-fixtures.js';
import { INVALID_FIXTURES } from './support/node-config-invalid.js';

const schema: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function schemaObject() {
  assert.ok(schema !== null && typeof schema === 'object');
  return schema as Record<string, unknown>;
}

const validate = createValidator(schemaObject());

function parse(toml: string) {
  const document = parseTomlDocument(toml);
  assert.ok(document.ok);
  return document.document;
}

function definition(name: string) {
  const definitions = schemaObject().definitions as Record<
    string,
    Record<string, unknown>
  >;
  const found = definitions[name];
  assert.ok(found, name);
  return found;
}

function property(owner: Record<string, unknown>, name: string) {
  return (owner.properties as Record<string, Record<string, unknown>>)[name];
}

void test('the schema accepts every example and valid fixture', () => {
  for (const sample of [...exampleFiles(), ...VALID_FIXTURES])
    assert.equal(validate(parse(sample.toml)), true, sample.name);
});

void test('the schema rejects every invalid fixture the validator rejects, except cross-field rules', () => {
  for (const fixture of INVALID_FIXTURES) {
    if (fixture.code === 'TOML_SYNTAX') continue;
    assert.equal(parseNodeConfig(fixture.toml).ok, false, fixture.name);
    assert.equal(
      validate(parse(fixture.toml)),
      fixture.schemaAccepts === true,
      fixture.name,
    );
  }
});

void test('schema vocabularies come from the canonical catalogs', () => {
  const root = schemaObject();
  assert.deepEqual(property(root, 'version'), {
    description: property(root, 'version')?.description,
    type: 'integer',
    const: NODE_CONFIG_VERSION,
  });
  const catalogNames = MODEL_CATALOG.flatMap((model) => [
    model.id,
    ...model.aliases,
  ]);
  assert.deepEqual(definition('catalogModel').enum, catalogNames);
  assert.deepEqual(property(definition('offer'), 'reasoning')?.items, {
    enum: Object.values(REASONING_LEVELS),
  });
  assert.deepEqual(
    property(definition('engine'), 'kind')?.enum,
    Object.values(ENGINE_KINDS),
  );
  assert.deepEqual(
    property(definition('price'), 'currency')?.enum,
    Object.values(OFFER_CURRENCIES),
  );
  assert.equal(
    property(root, 'offers')?.maxItems,
    NODE_CONFIG_LIMITS.maxOffers,
  );
  assert.equal(
    property(definition('free'), 'daily_token_cap')?.maximum,
    NODE_CONFIG_LIMITS.maxTokenCap,
  );
});
