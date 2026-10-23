// Owns offline endpoint probes and temporary signed offers for relay policy tests.
// Native relay maps are real; binding is faked before any socket opens, except the
// native bind-failure probe, which opens no network path. Tokens never print.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { generateKeyPairSigner } from '@solana/kit';

import { P2P } from '@gyblos/config';
import {
  signInferenceOffer,
  type OfferTrust,
  type SignedInferenceOffer,
} from '@gyblos/node/offers';
import type { RoleConfig } from '@gyblos/node/roles';

import { recoveryFixture } from './recovery-fixture.js';

const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 65_536;

export const RELAY_TOKEN_SENTINEL = 'PRIVATE_RELAY_TOKEN_SENTINEL';

export const PROBE_ACTIONS = {
  ENDPOINT: 'endpoint',
  START_BUYER: 'start-buyer',
  ADMISSION: 'admission',
  NATIVE_BIND: 'native-bind',
} as const;

// TEST-NET-1 (RFC 5737) is never assigned locally, so a real bind fails before networking.
export const UNASSIGNED_BIND_ADDRESS = '192.0.2.1:0';

type ProbeAction = (typeof PROBE_ACTIONS)[keyof typeof PROBE_ACTIONS];

export interface EndpointProbe {
  events: string[];
  binds: string[];
  relays?: { url: string; quicPort?: number; token: string }[];
  remote?: { relayUrl: string | null; directAddresses: string[] };
  error?: { code?: string; message: string };
  // Native SDK log lines printed before the probe result (stdout), never their content.
  nativeLogLines: number;
}

function probeScript() {
  const entry = import.meta.resolve('@gyblos/transport-iroh/endpoint');
  const buyer = import.meta.resolve('@gyblos/buyer/buyer');
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
        secretKey(value){secret=value;},alpns(){},
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
  const chain = `export async function assertProgram(){globalThis.probe.events.push('program');}`;
  const fakes = {
    [entry]: { '@number0/iroh': replacement },
    [buyer]: { '@gyblos/payments-x402/chain': chain },
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
      if(action===${JSON.stringify(PROBE_ACTIONS.START_BUYER)}){
        const {startBuyer}=await import(${JSON.stringify(buyer)});
        await startBuyer();
      } else {
        const {assertConfiguredRelay,bindEndpoint}=await import(${JSON.stringify(entry)});
        if(action===${JSON.stringify(PROBE_ACTIONS.ADMISSION)})
          assertConfiguredRelay(process.env.PROBE_RELAY_URL);
        else {
          const endpoint=await bindEndpoint([...Array(32).keys()],{
            relayOnly:process.env.PROBE_RELAY_ONLY==='1',
            bindAddress:process.env.PROBE_BIND_ADDRESS});
          await endpoint.close();
        }
      }
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
      },
      cwd,
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
  const probe: EndpointProbe = { ...result, nativeLogLines: lines.length - 1 };
  assert.ok(!probe.error?.message.includes(RELAY_TOKEN_SENTINEL));
  return probe;
}

export interface RelayOfferOptions {
  sellerNodeId?: string;
  directAddresses?: string[];
  buyer?: { secret: number[]; nodeId: string };
}

export async function withRelayOffer(
  relayUrl: string | null,
  run: (directory: string) => Promise<void>,
  options: RelayOfferOptions = {},
) {
  const fixture = await recoveryFixture();
  const owner = await generateKeyPairSigner();
  const previousDirectory = process.cwd();
  try {
    const signed = await fixture.read<SignedInferenceOffer>(P2P.offerFilename);
    const trust = await fixture.read<OfferTrust>(P2P.trustFilename);
    const nodeId = options.sellerNodeId ?? signed.offer.nodeId;
    const now = Date.now();
    const offer = {
      ...signed.offer,
      owner: owner.address,
      nodeId,
      endpoint: { relayUrl, directAddresses: options.directAddresses ?? [] },
      issuedAt: now,
      expiresAt: now + P2P.offerLifetimeMs,
    };
    await fixture.write(
      P2P.offerFilename,
      await signInferenceOffer(offer, owner),
    );
    await fixture.write(P2P.trustFilename, {
      ...trust,
      owner: owner.address,
      nodeId,
    });
    if (options.buyer) {
      const role = await fixture.read<RoleConfig>(P2P.roleConfig);
      await fixture.write(P2P.nodeKeyFilename, options.buyer.secret);
      await fixture.write(P2P.roleConfig, {
        ...role,
        nodeId: options.buyer.nodeId,
      });
    }
    process.chdir(fixture.directory);
    await run(fixture.directory);
  } finally {
    process.chdir(previousDirectory);
    await fixture.close();
  }
}
