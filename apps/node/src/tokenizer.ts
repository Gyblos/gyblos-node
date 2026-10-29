// Prepares the pinned public recount tokenizer for either role; never starts an engine or reads role keys.
import { prepareModelTokenizer } from '@gyblos/node/artifacts';
import { isMain } from '@gyblos/runtime';

export async function main() {
  await prepareModelTokenizer();
  console.log('Pinned tokenizer verified.');
}

if (isMain(import.meta.url)) await main();
