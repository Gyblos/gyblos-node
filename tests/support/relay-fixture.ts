// Owns offline endpoint probes and temporary signed offers for relay policy tests.
// Native relay maps are real; binding is faked before any socket opens, except the
// native bind-failure probe, which opens no network path. Tokens never print.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { HOME_ENVIRONMENT, homeLayout } from '@gyblos/config';

const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 65_536;

export const RELAY_TOKEN_SENTINEL = 'PRIVATE_RELAY_TOKEN_SENTINEL';

export const PROBE_ACTIONS = {
  ENDPOINT: 'endpoint',
  NATIVE_BIND: 'native-bind',
} as const;

// TEST-NET-1 (RFC 5737) is never assigned locally, so a real bind fails before networking.
export const UNASSIGNED_BIND_ADDRESS = '192.0.2.1:0';

type ProbeAction = (typeof PROBE_ACTIONS)[keyof typeof PROBE_ACTIONS];

export interface EndpointProbe {
  events: string[];
  binds: string[];
  alpns?: string[];
  relays?: { url: string; quicPort?: number; token: string }[];
  remote?: { relayUrl: string | null; directAddresses: string[] };
  error?: { code?: string; message: string };
  // Native SDK log lines printed before the probe result (stdout), never their content.
  nativeLogLines: number;
}

function probeScript() {
  const entry = import.meta.resolve('@gyblos/transport-iroh/endpoint');
  const sdk = import.meta.resolve('@number0/iroh');
  // Relay entries report only whether the environment token was attached.
  const replacement = `
    import {SecretKey} from ${JSON.stringify(sdk)};
    export {RelayMap,RelayMode} from ${JSON.stringify(sdk)};
    export const Endpoint={builder(){
      globalThis.probe.events.push('builder');
      let secret;
      return {
        applyN0(){globalThis.probe.events.push('n0');},
        secretKey(value){secret=value;},alpns(values){globalThis.probe.alpns=values.map(value=>Buffer.from(value).toString('utf8'));},
        bindAddr(address){globalThis.probe.binds.push(address);},
        relayMode(mode){
          globalThis.probe.events.push('relay-mode');
          const map=mode.relayMap();
          globalThis.probe.relays=map.urls().map(url=>{
            const relay=map.get(url);
            const token=relay.authToken===undefined?'absent':
              relay.authToken===process.env.GYBLOS_RELAY_TOKEN?'environment':'other';
            return {url:relay.url,quicPort:relay.quicPort,token};
          });
        },
        async bind(){
          globalThis.probe.events.push('bind');
          const sockets=process.env.PROBE_BOUND_SOCKETS;
          return {
            id(){return SecretKey.fromBytes(secret).public();},
            boundSockets(){return sockets?sockets.split(','):globalThis.probe.binds;},
            async connect(remote){
              globalThis.probe.remote={relayUrl:remote.relayUrl()??null,
                directAddresses:remote.directAddresses()};
              throw new Error('Relay probe stops before dialing.');
            },
            async close(){globalThis.probe.events.push('close');}
          };
        }
      };
    }};`;
  const fakes = {
    [entry]: { '@number0/iroh': replacement },
  };
  return `
    import {registerHooks} from 'node:module';
    import {setLogLevel} from ${JSON.stringify(sdk)};
    globalThis.probe={events:[],binds:[]};
    globalThis.fetch=()=>{throw new Error('Network forbidden in relay probe');};
    const action=process.env.PROBE_ACTION;
    const fakes=${JSON.stringify(fakes)};
    if(action===${JSON.stringify(PROBE_ACTIONS.NATIVE_BIND)}) setLogLevel('Trace');
    else registerHooks({resolve(specifier,context,next){
      const source=fakes[context.parentURL]?.[specifier];
      if(source) return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
      return next(specifier,context);
    }});
    try {
      const {bindEndpoint}=await import(${JSON.stringify(entry)});
          const endpoint=await bindEndpoint([...Array(32).keys()],{
            relayOnly:process.env.PROBE_RELAY_ONLY==='1',
            control:process.env.PROBE_CONTROL==='1',
            freeExecution:process.env.PROBE_FREE_EXECUTION==='1',
            batchSessions:process.env.PROBE_BATCH_SESSIONS==='1',
            http:process.env.PROBE_HTTP!=='0',
            bindAddress:process.env.PROBE_BIND_ADDRESS});
          await endpoint.close();
    } catch(error) {
      globalThis.probe.error={code:error.code,message:String(error.message)};
    }
    console.log(JSON.stringify(globalThis.probe));`;
}

export function endpointProbe(
  environment: Record<string, string> = {},
  action: ProbeAction = PROBE_ACTIONS.ENDPOINT,
  cwd?: string,
) {
  const directory =
    cwd === undefined
      ? mkdtempSync(join(tmpdir(), 'gyblos-relay-probe-'))
      : resolve(cwd);
  try {
    const configured = homeLayout(process.env).root;
    const candidate = isAbsolute(configured)
      ? configured
      : join(directory, configured);
    const inside = relative(directory, candidate);
    const root =
      cwd !== undefined && !inside.startsWith('..') && !isAbsolute(inside)
        ? candidate
        : join(directory, 'product');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        probeScript(),
      ],
      {
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          PROBE_ACTION: action,
          ...environment,
          [HOME_ENVIRONMENT.product]: root,
          [HOME_ENVIRONMENT.lab]: join(directory, 'gyblos-probe-lab'),
        },
        cwd: directory,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: OUTPUT_LIMIT_BYTES,
      },
    );
    assert.equal(child.error, undefined);
    assert.ok(
      !child.stdout.includes(RELAY_TOKEN_SENTINEL) &&
        !child.stderr.includes(RELAY_TOKEN_SENTINEL),
      'Relay token sentinel appeared in probe output.',
    );
    assert.equal(child.status, 0, child.stderr);
    const lines = child.stdout.trimEnd().split('\n');
    const result: Omit<EndpointProbe, 'nativeLogLines'> = JSON.parse(
      lines.at(-1) ?? '',
    );
    const probe: EndpointProbe = {
      ...result,
      nativeLogLines: lines.length - 1,
    };
    assert.ok(!probe.error?.message.includes(RELAY_TOKEN_SENTINEL));
    return probe;
  } finally {
    if (cwd === undefined) rmSync(directory, { recursive: true, force: true });
  }
}
