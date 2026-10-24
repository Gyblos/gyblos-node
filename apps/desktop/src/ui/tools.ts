// Describes optional web services separately from model/inference providers.
// These adapters are UX previews only; there are no API clients or credentials here.
import { TOOLS } from './constants.js';

export { TOOLS } from './constants.js';
export type ToolId = (typeof TOOLS)[number]['id'];
export function toolName(id: ToolId) {
  return TOOLS.find((tool) => tool.id === id)!.name;
}
