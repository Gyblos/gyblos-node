type AgentResponseOutput = {
  end(text: string, callback: () => void): void;
  onClosed(callback: () => void): () => void;
  destroy(): void;
};

export function drainAgentResponse(
  _output: AgentResponseOutput,
  _text: string,
  _timeoutMs: number,
): Promise<void> {
  return Promise.resolve();
}
