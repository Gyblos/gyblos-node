# Code standards

Detailed conventions behind the short rules in [AGENTS.md](../AGENTS.md). If the
two disagree, AGENTS.md wins. Architecture and ownership are in
[architecture.md](architecture.md); test policy is in
[tests/README.md](../tests/README.md).

## What lint enforces

`pnpm lint` runs ESLint ([eslint.config.js](../eslint.config.js) with the local
rules in [tooling/code-standards.js](../tooling/code-standards.js)),
`prettier --check`, `pnpm tooling:test` and `pnpm boundaries`. Errors fail the
check; warnings are reported and must not grow in a PR.

| Rule                                      | Level | Scope and exceptions                                                                      |
| ----------------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| One declaration per `const`/`let`         | error | All TypeScript.                                                                           |
| `@typescript-eslint/no-explicit-any`      | error | All TypeScript.                                                                           |
| No object-literal `as` assertion          | error | Product, lab and tooling; allowed in `tests/` for invalid inputs and partial SDK doubles. |
| `@typescript-eslint/no-floating-promises` | error | All TypeScript.                                                                           |
| `gyblos/package-boundaries`               | error | `apps`, `packages`, `lab`: a relative import must not leave its package.                  |
| `gyblos/version-pins`                     | error | `packages/config/src/versions.ts` must match the dependency pins in manifests.            |
| `pnpm boundaries` (dependency-cruiser)    | error | Layer direction, adapter and app independence, no product import of lab/tests/tooling.    |
| Import order (prettier sort-imports)      | error | Checked by `prettier --check`; `pnpm format` fixes it.                                    |
| `max-lines-per-function` 80               | warn  | Off for `tests/` and `lab/`; blank lines and comments are not counted.                    |
| `max-lines` 400                           | warn  | All TypeScript.                                                                           |
| `no-magic-numbers`                        | warn  | Off for `packages/config`, `constants.ts` files and tests; -1, 0, 1, 2 are allowed.       |
| `gyblos/structure` (short-name denylist)  | warn  | `apps`, `packages`, `lab`: bindings such as `r`, `res`, `req`, `e`, `env`, `addr`, `sig`. |

Everything else on this page is checked in review, not by lint: module headers,
canonical values and derived types, error catalogs, boundary parsing, naming
beyond the denylist and declaration placement.

Never silence a rule, add a baseline or cast to make a check pass. Fix the code
or, if the rule is wrong, change the rule in a separate tooling PR with a test.

## Module shape

- Start each TypeScript module with a 1-3 line header stating its responsibility
  and the boundary it must not cross.
- Keep functions focused on one named step. Use descriptive names; `i` and `tx`
  are permitted.
- New code is TypeScript, not MJS.
- Use four import groups separated by blank lines: Node builtins, external
  packages, `@gyblos/*` packages, then relative imports. `pnpm format` sorts
  them.
- Keep declarations near their use; there is no declaration-order rank.
- Create handlers, timers and mutable application state inside lifecycle or
  entry functions, never on import. `tests/entrypoint-inertness.test.ts` and
  `tests/lab/entrypoint-inertness.test.ts` check that executable modules are
  inert when imported.

```ts
// Do: preserve order and give each declaration a name.
const request = prepareRequest();
const ceiling = priceRequest(request);
// Avoid: const r = prepareRequest(), c = priceRequest(r);
```

## Canonical values and derived types

Application-owned discrete values shared by runtime behavior and type contracts
(error codes, evidence fallbacks, statuses, case identifiers) have one canonical
definition: named constants or an `as const` catalog in the owning package's
`constants.ts`.

- Derive the type from those values with `typeof`, indexed access or `keyof`.
  Runtime producers, comparisons and assertions import the constants; type
  declarations import the derived type. TypeScript types are erased and supply
  no runtime value.
- Do not repeat a raw string in a type union and its runtime uses. An inline
  literal union is type-safe but is not a single source, even with only one
  runtime producer.
- Example: define `INFERENCE_EVIDENCE_CODES.ASSERTION_FAILED` once (in
  `lab/harness/src/constants.ts`), derive its type, and use the imported member
  when recording an assertion failure. Do not write `'ASSERTION_FAILED'`
  separately in the evidence union and the catch handler.
- Keep ownership: lab evidence diagnostics belong to `lab/harness`; payment
  errors belong to `payments-x402`. Do not widen a closed contract to `string`
  or use casts or `any` to bypass it.
- Search for an existing canonical value before adding one. Do not borrow a
  constant from an unrelated concept because its value matches (an HTTP status
  is not a character limit).
- Raw literals remain fine in the canonical definition itself, descriptive
  messages, private values with no shared contract, and external Node, SDK or
  protocol identifiers with no exported constant. Prefer an upstream exported
  constant; do not copy an external error catalog into an owned union.
- Valid typed test inputs and contract-selection predicates use canonical
  members. Independent expected wire values, deliberately invalid inputs and raw
  external or historical fixtures may stay literal so tests detect contract
  changes. Do not cast invalid owned values in valid fixtures.

## Config and constants

`packages/config` holds operator-changeable values (ports, limits, timeouts,
relays, index URLs) and the local home layout. `config/src/home.ts` is the only
module that builds local paths. Fixed operational values live in the owning
module or its `constants.ts`; config is not a place for unrelated constants.
Dependency versions come from manifests and the lockfile.

## Errors and external boundaries

- New package errors use typed codes from their owning catalog. Plain `Error`
  belongs at executable CLI boundaries. Preserve external SDK error identity and
  propagation.
- Parse external JSON as `unknown`, then validate shape, bounds and trust at the
  boundary. A TypeScript annotation or assertion is not runtime validation.
- Prefer a typed variable or `satisfies` for constructed objects, never an
  object-literal `as` cast.
- Await or return promises. Use `void` only for intentionally detached work
  whose error semantics are understood. Do not swallow errors to satisfy lint.

## Legacy debt

These rules apply to new and modified contracts; existing code is not migrated
automatically. Check producers, types, comparisons and assertions together when
you touch a contract, and report remaining gaps accurately.

- Existing uncoded errors and legacy parsing keep their behavior until a
  separately reviewed behavior change. Do not silently tighten accepted input or
  change error precedence during a refactor.
- Retained legacy fixed config values need not move during unrelated work.
- Existing lint warnings are tracked debt; a PR must not add warnings.
