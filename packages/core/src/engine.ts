// Re-exports the Engine port from @gyblos/protocol/engine for callers that import it via core.
// Engine contracts are owned by protocol; this module adds no behavior.
export {
  inferenceWireUsage,
  type Engine,
  type EngineCapabilities,
  type EngineDescription,
  type EngineInput,
  type EngineResult,
  type EngineUsage,
  type RecountTokenizer,
} from '@gyblos/protocol/engine';
