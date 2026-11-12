// Shared semantic inference operations over injected ports; no financial identities or wire envelopes.
import type { Engine, ChatTokenizer } from '@gyblos/protocol/engine';
import type { InferenceBuildInput, InferenceMeter, InferenceResult } from '@gyblos/protocol/inference';

export function prepareInference(_input: InferenceBuildInput, _options: { engine: Pick<Engine, 'supportsTools'>; meter: InferenceMeter; contextTokens: number }): number { throw new Error('not implemented'); }
export async function generateInference(_options: { engine: Engine; input: InferenceBuildInput; meter: InferenceMeter; contextTokens: number; inputTokens: number; signal: AbortSignal; onText?: (text: string) => Promise<void>; check?: () => void }): Promise<InferenceResult> { throw new Error('not implemented'); }
export function verifyInferenceUsage(_input: InferenceBuildInput, _result: InferenceResult, _meter: ChatTokenizer): InferenceResult['usage'] { throw new Error('not implemented'); }
