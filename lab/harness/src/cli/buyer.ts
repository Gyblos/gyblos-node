// CLI that runs the fixed-price paid gate against already-running facilitator/seller hosts and prints
// the evidence JSON; sets a non-zero exit code on failure.
import { isMain } from '@gyblos/runtime';

import { executeGate } from './execute.js';

export async function main() {
  try {
    console.log(JSON.stringify(await executeGate(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Gate failed.');
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
