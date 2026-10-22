import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FILE_MODES, P2P } from '@gyblos/config';

import { NAT } from './constants.js';

export async function docker(
  args: string[],
  input?: Uint8Array,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', async (code) => {
      if (args[0] === 'build') {
        await mkdir(dirname(P2P.docker.buildLog), { recursive: true });
        await writeFile(P2P.docker.buildLog, Buffer.concat(errors), {
          mode: FILE_MODES.privateFile,
        }).catch(() => {});
      }
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else
        reject(
          new Error(
            `Docker ${args[0]} operation failed (${code}); inspect the task container status locally.`,
          ),
        );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function composeArgs(
  project: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return [
    'compose',
    '--project-name',
    project,
    '--file',
    environment.GYBLOS_P2P_SCENARIO?.startsWith('nat-')
      ? NAT.composePath
      : P2P.docker.composePath,
    ...args,
  ];
}

export async function containerId(
  project: string,
  role: string,
  environment: NodeJS.ProcessEnv,
) {
  const id = (
    await docker(
      composeArgs(project, ['ps', '--quiet', role], environment),
      undefined,
      environment,
    )
  ).trim();
  if (!id) throw new Error('Role container missing.');
  return id;
}

export async function execute(
  container: string,
  args: string[],
  input?: Uint8Array,
) {
  return docker(['exec', ...(input ? ['-i'] : []), container, ...args], input);
}

export async function writeContainerFile(
  container: string,
  path: string,
  bytes: Uint8Array,
) {
  await execute(
    container,
    [
      'node',
      '-e',
      `const fs=require('fs');const p=process.argv[1];fs.mkdirSync(require('path').dirname(p),{recursive:true,mode:${FILE_MODES.privateDirectory}});let chunks=[];process.stdin.on('data',x=>chunks.push(x));process.stdin.on('end',()=>fs.writeFileSync(p,Buffer.concat(chunks),{mode:${FILE_MODES.privateFile}}));`,
      path,
    ],
    bytes,
  );
}

export async function readContainerJson<T>(
  container: string,
  path: string,
): Promise<T> {
  return JSON.parse(
    await execute(container, [
      'node',
      '-e',
      `process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`,
      path,
    ]),
  ) as T;
}
