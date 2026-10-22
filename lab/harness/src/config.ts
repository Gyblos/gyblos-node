// Preserves the harness configuration entrypoint during wallet extraction.
// Loading belongs to config; JSON persistence remains in runtime.
export {
  configPath,
  defaultMint,
  loadConfig,
  signer,
  type Config,
} from '@gyblos/config/wallet';
export { saveJson } from '@gyblos/runtime';
