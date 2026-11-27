import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ACCEPTANCE_MODES } from '@gyblos/lab-harness/acceptance/constants';
import { isMain } from '@gyblos/runtime';

import { AGENT_REPLAY } from './constants';
import { startReplayNetwork } from './network';
import { joinTraces, summarize } from './report';
import { replayAgentSession } from './workload';

async function outputFile(out: string | undefined, runId: string) {
  const directory =
    out ?? (await mkdtemp(join(tmpdir(), AGENT_REPLAY.outPrefix)));
  await mkdir(directory, { recursive: true });
  return join(directory, `${AGENT_REPLAY.outPrefix}${runId}.jsonl`);
}

export async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      ollama: { type: 'boolean', default: false },
    },
  });
  const runId = randomUUID();
  const file = await outputFile(values.out, runId);
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
      ).map((record) => ({ runId, mode, ...record }));
      await appendFile(
        file,
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      summaries.push({ ...summarize(records), cooldowns: network.cooldowns });
    } finally {
      await network.close();
    }
  }
  process.stdout.write(
    `${JSON.stringify({ runId, mode, file, summaries }, null, 2)}\n`,
  );
}

if (isMain(import.meta.url)) await main();
