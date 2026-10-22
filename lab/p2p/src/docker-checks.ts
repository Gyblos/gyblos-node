import assert from 'node:assert/strict';

import {
  FILE_MODES,
  HTTP_STATUS,
  INFERENCE_REQUEST_LIMITS,
  LOCALHOST,
  P2P,
  PORTS,
  ROUTES,
} from '@gyblos/config';
import { NAT } from '@gyblos/lab-p2p/constants';

import { docker, execute } from './docker-command.js';
import type { prepareDocker } from './docker-prepare.js';

interface ContainerInspection {
  Config: { User: string; Image: string };
  HostConfig: {
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    CapDrop: string[];
    CapAdd: string[] | null;
    SecurityOpt: string[];
    PortBindings: Record<string, unknown> | null;
  };
  Mounts: { Name: string; Destination: string; RW: boolean; Type: string }[];
}

export async function inspectDocker(
  context: Awaited<ReturnType<typeof prepareDocker>>,
) {
  const mounts: string[] = [];
  const roles = [];
  for (const [role, container] of [
    ['buyer', context.buyerContainer],
    ['seller', context.sellerContainer],
  ] as const) {
    const [inspection] = JSON.parse(
      await docker(['inspect', container]),
    ) as ContainerInspection[];
    assert.ok(inspection);
    assert.equal(inspection.Config.User, P2P.docker.user);
    assert.equal(inspection.Config.Image, context.image);
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.HostConfig.Privileged, false);
    assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
    assert.equal(inspection.HostConfig.CapAdd?.length ?? 0, 0);
    assert.ok(
      inspection.HostConfig.SecurityOpt.includes('no-new-privileges:true'),
    );
    assert.equal(
      Object.keys(inspection.HostConfig.PortBindings ?? {}).length,
      0,
    );
    assert.equal(inspection.Mounts.length, 1);
    const mount = inspection.Mounts[0]!;
    assert.equal(mount.Type, 'volume');
    assert.equal(mount.Destination, '/app/.local');
    assert.equal(mount.RW, true);
    mounts.push(mount.Name);
    const files = JSON.parse(
      await execute(container, [
        'node',
        '-e',
        `
      const fs=require('fs'),path=require('path');const result=[];
      function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        const name=path.join(directory,entry.name);
        if(entry.isSymbolicLink())throw new Error('Unexpected private-volume symlink');
        if(entry.isDirectory())walk(name);
        else if(${JSON.stringify([...Object.values(P2P.keys), P2P.nodeKeyFilename])}.includes(entry.name))result.push({name,mode:fs.statSync(name).mode&${P2P.permissionMask}});
      }}walk('.local');console.log(JSON.stringify(result));
    `,
      ]),
    ) as { name: string; mode: number }[];
    const expected =
      role === 'buyer'
        ? [P2P.keys.buyer, P2P.nodeKeyFilename]
        : [
            P2P.keys.owner,
            P2P.keys.facilitator,
            P2P.keys.authorizer,
            P2P.nodeKeyFilename,
          ];
    assert.deepEqual(
      files.map((file) => file.name).sort(),
      expected.map((name) => `${P2P.root}/${name}`).sort(),
    );
    assert.ok(files.every((file) => file.mode === FILE_MODES.privateFile));
    roles.push({
      role,
      nonRoot: true,
      readOnlyRoot: true,
      capabilities: [],
      noPublishedPorts: true,
      keys: files,
    });
  }
  assert.notEqual(mounts[0], mounts[1]);
  const blocked = JSON.parse(
    await execute(context.buyerContainer, [
      'node',
      '-e',
      `
    const ports=JSON.parse(process.argv[1]);(async()=>{const results=[];
    for(const port of ports){let reachable=false;try{await fetch('http://'+process.argv[2]+':'+port+'/',{signal:AbortSignal.timeout(${NAT.negativeProbeMs})});reachable=true;}catch{}
    results.push({port,reachable});}console.log(JSON.stringify(results));})();
  `,
      JSON.stringify([PORTS.ollama, PORTS.facilitator, P2P.sellerPort]),
      context.environment.GYBLOS_P2P_SELLER_IP ?? P2P.docker.sellerIp,
    ]),
  ) as { port: number; reachable: boolean }[];
  assert.ok(blocked.every((result) => !result.reachable));
  const challenge = JSON.parse(
    await execute(context.buyerContainer, [
      'node',
      '-e',
      `
    (async()=>{const response=await fetch(process.argv[1],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),prompt:'Count from one to three.',maxTokens:${INFERENCE_REQUEST_LIMITS.maxOutputTokens}})});
    console.log(JSON.stringify({status:response.status,paymentRequired:response.headers.has('payment-required')}));})();
  `,
      `http://${LOCALHOST}:${P2P.buyerProxyPort}${ROUTES.inference}`,
    ]),
  ) as { status: number; paymentRequired: boolean };
  assert.equal(challenge.status, HTTP_STATUS.paymentRequired);
  assert.equal(challenge.paymentRequired, true);
  return {
    distinctVolumes: true,
    roles,
    loopbackOnlyPorts: blocked,
    nativeIrohChallenge: challenge,
  };
}
