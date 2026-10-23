// Hosts the native loopback probe outside the renderer and UI process.
// Reports allowlisted fields, waits for receipt, then exits after resources close.
import { runNativeProbe } from './native-probe.js';
import { failedProbe, type ProbeResult } from './probe-model.js';
import { reportProbeResult } from './worker-result.js';

async function main() {
  let result: ProbeResult;
  try {
    result = await runNativeProbe();
  } catch {
    result = failedProbe();
  }
  reportProbeResult(process.parentPort, result, (code) => process.exit(code));
}
void main();
