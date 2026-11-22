// drizzle-kit generates this Worker's D1 migrations from src/schema.ts into migrations/, which
// wrangler applies (`migrations_dir` in wrangler.jsonc). Run it through the package's `db:generate`
// script so paths resolve from this directory. Index prefixes continue after the hand-written
// baseline files (0001-0007); migrations/meta/ holds drizzle-kit's journal and schema snapshots.
// Deliberately no driver or dbCredentials: only `generate` and `check` are used. `push`, `pull` and
// `introspect` must never run against the D1 database (they would rebuild every table without
// WITHOUT ROWID); without credentials they cannot reach it.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  migrations: { prefix: 'index' },
  breakpoints: true,
});
