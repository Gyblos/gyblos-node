// drizzle-kit config: generates this Worker's D1 migrations from src/schema.ts into migrations/
// (Wrangler's migrations_dir), numbered after the hand-written 0001-0007 baseline in migrations/meta/.
// Run via the package's db:generate script so paths resolve from this directory.
import { defineConfig } from 'drizzle-kit';

// Deliberately no driver or dbCredentials: only `generate` and `check` run. `push`, `pull` and
// `introspect` must never reach D1 (they would rebuild every table without WITHOUT ROWID).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  migrations: { prefix: 'index' },
  breakpoints: true,
});
