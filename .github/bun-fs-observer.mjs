// Forward the two named filesystem exports to the live methods patched by the fault-injection tests.
import filesystem from 'node:fs/promises';

import { mock } from 'bun:test';

mock.module('node:fs/promises', () => ({
  ...filesystem,
  default: filesystem,
  open: (...args) => filesystem.open(...args),
  rename: (...args) => filesystem.rename(...args),
}));
