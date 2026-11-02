// Performs one interactive chat request over the local buyer endpoint.
export interface ChatTurnOptions {
  model: string;
  maxTokens: number;
  prompt: string;
  token?: string;
  write: (text: string) => void;
  signal?: AbortSignal;
}
export interface ChatTurnResult {
  status: 'complete' | 'uncertain' | 'rejected';
  usage?: { input: number; output: number };
  payment?: { verdict: string; charged: string | null; refunded: string | null };
}
export async function chatTurn(
  _options: ChatTurnOptions,
  _request: typeof fetch = fetch,
): Promise<ChatTurnResult> {
  return { status: 'rejected' };
}
