// Owns bounded Pi subprocess I/O. No tools, extensions, MCP, context discovery or target execution are enabled.
import { spawn } from 'node:child_process';

import {
  MAX_AGENT_OUTPUT_BYTES,
  PI_TASK_TIMEOUT_MS,
  PI_TERMINATE_GRACE_MS,
  type PiThinkingLevel,
} from './constants';
import type { PiProcessResult } from './types';

export function buildPiArguments(
  model: string,
  thinking: PiThinkingLevel,
  _prompt: string,
): string[] {
  return [
    '--print',
    '--no-session',
    '--no-skills',
    '--no-context-files',
    '--no-extensions',
    '--no-mcp',
    '--no-prompt-templates',
    '--no-themes',
    '--no-tools',
    '--model',
    model,
    '--thinking',
    thinking,
  ];
}
export interface RunPiOptions {
  command?: string;
  prefixArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  thinking: PiThinkingLevel;
  prompt: string;
  timeoutMs?: number;
}
export function runPi(options: RunPiOptions): Promise<PiProcessResult> {
  const child = spawn(
    options.command ?? 'pi',
    [
      ...(options.prefixArgs ?? []),
      ...buildPiArguments(options.model, options.thinking, options.prompt),
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let truncated = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    child.kill('SIGTERM');
    killTimer ??= setTimeout(
      () => child.kill('SIGKILL'),
      PI_TERMINATE_GRACE_MS,
    );
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs ?? PI_TASK_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_AGENT_OUTPUT_BYTES) {
      truncated = true;
      terminate();
    } else chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_AGENT_OUTPUT_BYTES) {
      truncated = true;
      terminate();
    }
  });
  // Prompts travel via stdin, avoiding OS argument limits and process-list disclosure.
  child.stdin.on('error', () => {
    /* close/error below supplies the result */
  });
  child.stdin.end(options.prompt);
  return new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once('error', () => {
      clear();
      reject(new Error('Unable to start the pinned Pi executable.'));
    });
    child.once('close', (exitCode, signal) => {
      clear();
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(chunks).toString('utf8'),
        truncated,
        timedOut,
      });
    });
  });
}
