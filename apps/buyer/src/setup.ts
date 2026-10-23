// Prepares only the buyer's pinned public tokenizer; never starts an engine or reads role keys.
import { prepareModelTokenizer } from '@gyblos/node/artifacts';
import { isMain } from '@gyblos/runtime';

export async function main() {
  await prepareModelTokenizer();
  console.log('Pinned buyer tokenizer verified.');
}

if (isMain(import.meta.url)) await main();
