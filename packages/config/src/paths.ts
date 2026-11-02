// HTTP routes shared by node, buyer and facilitator. Local file locations live in home.ts.
export const ROUTES = {
  health: '/health',
  inference: '/v1/chat/completions',
  agentBase: '/v1',
  models: '/v1/models',
  events: '/facilitator/events',
  verifications: '/facilitator/verifications',
  facilitatorDiagnostics: '/facilitator/diagnostics',
  verify: '/verify',
  supported: '/supported',
  ollamaVersion: '/api/version',
  ollamaTags: '/api/tags',
  ollamaGenerate: '/api/generate',
  inferenceDefinition: 'POST /v1/chat/completions',
} as const;
