// Harness view of the devnet wallet config: load/locate it and get role signers from @gyblos/config,
// and write JSON via @gyblos/runtime.
export {
  configPath,
  defaultMint,
  loadConfig,
  signer,
  type Config,
} from '@gyblos/config/wallet';
export { saveJson } from '@gyblos/runtime';
