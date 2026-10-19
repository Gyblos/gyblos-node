import { executeGate } from './execute.js';

try {
  console.log(JSON.stringify(await executeGate(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Gate failed.');
  process.exitCode = 1;
}
