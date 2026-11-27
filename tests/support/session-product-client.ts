import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PAID_BUYER } from '@gyblos/buyer/constants';
import { rolePathIn } from '@gyblos/config';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import type { sessionProductHost } from './session-product-host';

export async function buyerClient(
  host: Pick<Awaited<ReturnType<typeof sessionProductHost>>, 'buyer'>,
  request: typeof fetch,
  limitAtomic = '1000',
) {
  const token = (
    await readFile(
      rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
      'utf8',
    )
  ).trim();
  const owner = (url: URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', 'Bearer ' + token);
    return request(url, { ...init, headers });
  };
  const metadata = await owner(
    new URL(BUYER_API.STATUS_PATH, host.buyer().url),
  );
  const policy = parseBuyerApiPolicy(await metadata.json());
  const created = await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': '"' + policy.policyId + '"',
    },
    body: JSON.stringify({
      action: 'create',
      name: 'Synthetic tools',
      limitAtomic,
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const key = parseBuyerApiKeysReply(await created.json()).created;
  assert.ok(key);
  const ask = (maxTokens?: number, signal?: AbortSignal) =>
    request(host.buyer().url, {
      signal,
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key.secret,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: policy.model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_completion_tokens: maxTokens,
      }),
    });
  return { ask, owner, delegated: key.secret };
}
