import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ACCEPTANCE_MODES } from '@gyblos/lab-harness/acceptance/constants';

import { AGENT_REPLAY } from './constants';
import { startReplayNetwork } from './network';
import { joinTraces, summarize } from './report';
import { replayAgentSession } from './workload';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    ollama: { type: 'boolean', default: false },
  },
});
const directory =
  values.out ?? (await mkdtemp(join(tmpdir(), 'agent-replay-')));
const file = join(directory, AGENT_REPLAY.outFile);
const mode = values.ollama
  ? ACCEPTANCE_MODES.OLLAMA
  : ACCEPTANCE_MODES.SYNTHETIC;
const signal = AbortSignal.timeout(AGENT_REPLAY.runMs);
const summaries = [];
for (const count of AGENT_REPLAY.sellerCounts) {
  const network = await startReplayNetwork(count, signal, mode);
  try {
    const records = joinTraces(
      count,
      await replayAgentSession(network.url, signal),
      network.traces,
    );
    await appendFile(
      file,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    summaries.push({ ...summarize(records), cooldowns: network.cooldowns });
  } finally {
    await network.close();
  }
}
process.stdout.write(`${JSON.stringify({ mode, file, summaries }, null, 2)}\n`);
