// Signed synthetic quote used by channel wire tests.
import { createControlQuote } from '@gyblos/core/control-quotes';

import { controlFixture } from './control-fixture';

export async function batchQuote() {
  const source = await controlFixture(false);
  const quote = await createControlQuote(
    source.request,
    source.context,
    source.ownerSigner,
  );
  return { quote, now: source.context.now };
}
