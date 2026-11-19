// Owns bounded Pi subprocess I/O. No tools, extensions, MCP, context discovery or target execution are enabled.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MAX_AGENT_OUTPUT_BYTES,
  PI_TASK_TIMEOUT_MS,
  PI_TERMINATE_GRACE_MS,
  REVIEW_FAILURE,
  type PiThinkingLevel,
  type ReviewFailure,
} from './constants';
import type { PiProcessResult } from './types';

export async function preparePiDirectory(directory: string): Promise<void> {
  for (const name of ['tmp', 'config', 'cache', 'pi'])
    await mkdir(join(directory, name));
  await writeFile(
    join(directory, 'pi', 'settings.json'),
    JSON.stringify({
      retry: { enabled: false, provider: { maxRetries: 0 } },
      enableInstallTelemetry: false,
    }),
  );
}
export function buildPiArguments(
  model: string,
  thinking: PiThinkingLevel,
  _prompt: string,
): string[] {
  return [
    '--print',
    '--mode',
    'json',
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
const HTTP = { CLIENT_ERROR: 400, NOT_FOUND: 404, SERVER_ERROR: 500 } as const;
// Only Pi's failed assistant envelope or failed process stderr can identify a provider error.
function providerFailure(message: string): ReviewFailure {
  if (
    /\binsufficient_quota\b|\byou exceeded your current quota\b|\bbilling_hard_limit_reached\b/i.test(
      message,
    )
  )
    return REVIEW_FAILURE.QUOTA;
  if (
    /\binvalid_api_key\b|\bincorrect api key provided\b|^401\b/i.test(message)
  )
    return REVIEW_FAILURE.KEY;
  if (/\brate_limit_exceeded\b|\brate limit reached\b|^429\b/i.test(message))
    return REVIEW_FAILURE.RATE;
  // Pi words provider refusals as "OpenAI API error (<status>): <body>"; only the class is kept, never the text.
  const status = /\bAPI error \((\d{3})\)|^(\d{3})\b/.exec(message);
  const code = Number(status?.[1] ?? status?.[2]);
  if (
    /\bmodel_not_found\b|\bdoes not exist\b/i.test(message) ||
    code === HTTP.NOT_FOUND
  )
    return REVIEW_FAILURE.MODEL;
  if (/\bcontext_length_exceeded\b|\bmaximum context length\b/i.test(message))
    return REVIEW_FAILURE.CONTEXT;
  if (code >= HTTP.SERVER_ERROR || /\bserver_error\b/i.test(message))
    return REVIEW_FAILURE.PROVIDER;
  if (code >= HTTP.CLIENT_ERROR) return REVIEW_FAILURE.REQUEST;
  return REVIEW_FAILURE.PI;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assistantResult(
  output: string,
): Pick<PiProcessResult, 'stdout' | 'failure' | 'reportedTokens'> {
  let result: Pick<PiProcessResult, 'stdout' | 'failure' | 'reportedTokens'> = {
    stdout: '',
    failure: REVIEW_FAILURE.PI,
  };
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const event: unknown = JSON.parse(line);
    if (
      !isRecord(event) ||
      event.type !== 'message_end' ||
      !isRecord(event.message) ||
      event.message.role !== 'assistant'
    )
      continue;
    const message = event.message;
    const usage = message.usage;
    const tokens = isRecord(usage) ? usage.totalTokens : undefined;
    const reported =
      typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0
        ? { reportedTokens: tokens }
        : {};
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      return {
        stdout: '',
        failure: providerFailure(
          typeof message.errorMessage === 'string' ? message.errorMessage : '',
        ),
        ...reported,
      };
    if (message.stopReason === 'length')
      return { stdout: '', failure: REVIEW_FAILURE.LIMIT, ...reported };
    if (message.stopReason !== 'stop' || !Array.isArray(message.content))
      continue;
    result = {
      stdout: message.content
        .filter(isRecord)
        .filter(
          (block) => block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('\n'),
      ...reported,
    };
  }
  return result;
}
function processOutput(
  exitCode: number | null,
  stdout: Buffer[],
  stderr: Buffer[],
): Pick<PiProcessResult, 'stdout' | 'failure' | 'reportedTokens'> {
  if (exitCode !== 0)
    return {
      stdout: '',
      failure: providerFailure(Buffer.concat(stderr).toString('utf8').trim()),
    };
  try {
    return assistantResult(Buffer.concat(stdout).toString('utf8'));
  } catch {
    return { stdout: '', failure: REVIEW_FAILURE.PI };
  }
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
  const diagnostics: Buffer[] = [];
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
  const collect = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_AGENT_OUTPUT_BYTES) target.push(chunk);
    else if (!truncated) {
      truncated = true;
      terminate();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunks, chunk));
  child.stderr.on('data', (chunk: Buffer) => collect(diagnostics, chunk));
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
        ...(!timedOut && !truncated && !signal
          ? processOutput(exitCode, chunks, diagnostics)
          : { stdout: '' }),
        truncated,
        timedOut,
      });
    });
  });
}
