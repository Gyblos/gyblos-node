// Owns offline endpoint probes and temporary signed offers for relay policy tests.
// Native relay maps are real; binding is faked before any socket opens and tokens never print.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { generateKeyPairSigner } from '@solana/kit';

import { P2P } from '@gyblos/config';
import {
  signInferenceOffer,
  type OfferTrust,
  type SignedInferenceOffer,
} from '@gyblos/node/offers';

import { recoveryFixture } from './recovery-fixture.js';

const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 65_536;

export const RELAY_TOKEN_SENTINEL = 'PRIVATE_RELAY_TOKEN_SENTINEL';

export const PROBE_ACTIONS = {
  ENDPOINT: 'endpoint',
  BUYER: 'buyer',
  ADMISSION: 'admission',
} as const;

type ProbeAction = (typeof PROBE_ACTIONS)[keyof typeof PROBE_ACTIONS];

export interface EndpointProbe {
  events: string[];
  binds: string[];
  relays?: { url: string; quicPort?: number; token: string }[];
  error?: { code?: string; message: string };
}

function probeScript() {
  const entry = import.meta.resolve('@gyblos/transport-iroh/endpoint');
  const buyer = import.meta.resolve('@gyblos/buyer/buyer');
  const sdk = import.meta.resolve('@number0/iroh');
  // Relay entries report only whether the environment token was attached.
  const replacement = `
    export {RelayMap,RelayMode} from ${JSON.stringify(sdk)};
    export const Endpoint={builder(){
      globalThis.probe.events.push('builder');
      return {
        applyN0(){globalThis.probe.events.push('n0');},
        secretKey(){},alpns(){},
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
          return {boundSockets(){return globalThis.probe.binds;},async close(){}};
        }
      };
    }};`;
  return `
    import {registerHooks} from 'node:module';
    globalThis.probe={events:[],binds:[]};
    globalThis.fetch=()=>{throw new Error('Network forbidden in relay probe');};
    registerHooks({resolve(specifier,context,next){
      if(specifier==='@number0/iroh'&&context.parentURL===${JSON.stringify(entry)})
        return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true};
      return next(specifier,context);
    }});
    try {
      const action=process.env.PROBE_ACTION;
      if(action===${JSON.stringify(PROBE_ACTIONS.BUYER)}){
        const {bindBuyerEndpoint}=await import(${JSON.stringify(buyer)});
        await bindBuyerEndpoint([]);
      } else {
        const {assertConfiguredRelay,bindEndpoint}=await import(${JSON.stringify(entry)});
        if(action===${JSON.stringify(PROBE_ACTIONS.ADMISSION)})
          assertConfiguredRelay(process.env.PROBE_RELAY_URL);
        else await bindEndpoint([]);
      }
    } catch(error) {
      globalThis.probe.error={code:error.code,message:error.message};
    }
    console.log(JSON.stringify(globalThis.probe));`;
}

export function endpointProbe(
  environment: Record<string, string> = {},
  action: ProbeAction = PROBE_ACTIONS.ENDPOINT,
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
  const probe: EndpointProbe = JSON.parse(child.stdout);
  assert.ok(!probe.error?.message.includes(RELAY_TOKEN_SENTINEL));
  return probe;
}

export async function withRelayOffer(
  relayUrl: string,
  run: () => Promise<void>,
) {
  const fixture = await recoveryFixture();
  const owner = await generateKeyPairSigner();
  const previousDirectory = process.cwd();
  try {
    const signed = await fixture.read<SignedInferenceOffer>(P2P.offerFilename);
    const trust = await fixture.read<OfferTrust>(P2P.trustFilename);
    const now = Date.now();
    const offer = {
      ...signed.offer,
      owner: owner.address,
      endpoint: { relayUrl, directAddresses: [] },
      issuedAt: now,
      expiresAt: now + P2P.offerLifetimeMs,
    };
    await fixture.write(
      P2P.offerFilename,
      await signInferenceOffer(offer, owner),
    );
    await fixture.write(P2P.trustFilename, { ...trust, owner: owner.address });
    process.chdir(fixture.directory);
    await run();
  } finally {
    process.chdir(previousDirectory);
    await fixture.close();
  }
}
