// Calls only the product buyer's allocated loopback endpoint; response content never enters the public report.
import { request, type IncomingMessage } from 'node:http';

import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';

import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';

export async function receiptHttp(
  url: string,
  streaming = false,
  signal?: AbortSignal,
) {
  const target = new URL(url);
  acceptanceAssert(
    target.protocol === 'http:' && target.hostname === '127.0.0.1',
  );
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        signal: AbortSignal.any([
          AbortSignal.timeout(RECEIPT_ACCEPTANCE.settleMs),
          ...(signal ? [signal] : []),
        ]),
        headers: { 'content-type': 'application/json' },
      },
      resolve,
    );
    outgoing.once('error', reject);
    outgoing.end(
      JSON.stringify({
        model: RECEIPT_ACCEPTANCE.modelId,
        messages: [
          { role: FREE_CHAT_ROLES.USER, content: 'synthetic acceptance input' },
        ],
        max_tokens: RECEIPT_ACCEPTANCE.maxTokens,
        stream: streaming,
      }),
    );
  });
}
export async function receiptBody(response: IncomingMessage) {
  let body = '';
  let bytes = 0;
  for await (const chunk of response) {
    const part: unknown = chunk;
    acceptanceAssert(Buffer.isBuffer(part));
    bytes += part.length;
    acceptanceAssert(bytes <= RECEIPT_ACCEPTANCE.reportBytes);
    body += part.toString('utf8');
  }
  return body;
}
