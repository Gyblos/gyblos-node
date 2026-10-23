// Owns offline endpoint probes and temporary signed offers for relay policy tests.
// Native relay maps are real; endpoint binding is replaced before any socket opens.
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

export interface EndpointProbe {
  events: string[];
  relays?: { url: string; quicPort?: number; authToken?: string }[];
  error?: { code?: string; message: string };
}

export function endpointProbe(environment: Record<string, string> = {}) {
  const entry = import.meta.resolve('@gyblos/transport-iroh/endpoint');
  const sdk = import.meta.resolve('@number0/iroh');
  const replacement = `
    export {RelayMap,RelayMode} from ${JSON.stringify(sdk)};
    export const Endpoint={builder(){
      globalThis.probe.events.push('builder');
      return {
        applyN0(){globalThis.probe.events.push('n0');},
        secretKey(){},alpns(){},bindAddr(){},
        relayMode(mode){
          globalThis.probe.events.push('relay-mode');
          const map=mode.relayMap();
          globalThis.probe.relays=map.urls().map(url=>map.get(url));
        },
        async bind(){globalThis.probe.events.push('bind');return {async close(){}};}
      };
    }};`;
  const script = `
    import {registerHooks} from 'node:module';
    globalThis.probe={events:[]};
    globalThis.fetch=()=>{throw new Error('Network forbidden in relay probe');};
    registerHooks({resolve(specifier,context,next){
      if(specifier==='@number0/iroh'&&context.parentURL===${JSON.stringify(entry)})
        return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true};
      return next(specifier,context);
    }});
    try {
      const {bindEndpoint}=await import(${JSON.stringify(entry)});
      await bindEndpoint([]);
    } catch(error) {
      globalThis.probe.error={code:error.code,message:error.message};
    }
    console.log(JSON.stringify(globalThis.probe));`;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      script,
    ],
    {
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        ...environment,
      },
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as EndpointProbe;
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
