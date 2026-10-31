// Standalone loopback collector lifecycle; no node, buyer, registry or outbound transport is started.
import { createServer } from 'node:http';
export interface CollectorPrincipal { buyerNodeId: string; token: string; consent: true; }
export interface CollectorOptions { path: string; create: boolean; retentionMs: number; principals: readonly CollectorPrincipal[]; port: number; now?: () => number; requestMs?: number; }
export async function startLocalCollector(_options: CollectorOptions) {
  const server = createServer((_request, response) => response.writeHead(503).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic stub failure');
  return { url: `http://127.0.0.1:${address.port}/v1/receipts`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
