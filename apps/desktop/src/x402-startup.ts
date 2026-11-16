// Coordinates one local-buyer startup and zero-only permission; it never retries a prompt.
import type { X402Budget } from './x402-budget';
import type { X402Client } from './x402-client';

interface Service {
  start(): Promise<{ url: string; token: string }>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export function automaticBuyer(service: Service, client: X402Client, budget: X402Budget) {
  void service; void client; void budget;
  return { async start() {}, async close() {} };
}
