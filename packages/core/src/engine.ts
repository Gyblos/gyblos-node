// Retains the existing application Engine entrypoint during protocol extraction.
// Engine contracts are owned by protocol; this compatibility path adds no behavior.
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
