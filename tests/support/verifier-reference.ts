export function referenceGenerate(topLogprobs: unknown) {
  return {
    response: ' token',
    done: true,
    logprobs: [{ top_logprobs: topLogprobs }],
  };
}
