type AgentResponseOutput = {
  end(text: string, callback: () => void): void;
  onClosed(callback: () => void): () => void;
  destroy(): void;
};

export function drainAgentResponse(
  output: AgentResponseOutput,
  text: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    let detach = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      detach();
      resolve();
    };
    detach = output.onClosed(done);
    if (finished) {
      detach();
      return;
    }
    timer = setTimeout(() => {
      output.destroy();
      done();
    }, timeoutMs);
    try {
      output.end(text, done);
    } catch {
      output.destroy();
      done();
    }
  });
}
