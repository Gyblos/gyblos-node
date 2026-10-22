// Owns the existing snake_case inference usage wire contract.
// It is distinct from the camelCase domain EngineUsage and contains no engine SDK.
export interface EngineWireUsage {
  prompt_eval_count: number;
  eval_count: number;
  total_duration: number;
  load_duration: number;
  prompt_eval_duration: number;
  eval_duration: number;
}
