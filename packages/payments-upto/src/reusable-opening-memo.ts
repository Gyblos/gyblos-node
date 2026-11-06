// Canonical application terms commitment carried by an opening transaction's memo.
import {
  parseTerms,
  type ReusableChannelTerms,
} from './reusable-journal-model';

// PDA and salt are bound by the signed open instruction and are unknown before it is built.
export async function reusableOpeningMemo(
  terms: ReusableChannelTerms,
): Promise<string> {
  const { channelId: _channelId, salt: _salt, ...stable } = parseTerms(terms);
  const canonical = new TextEncoder().encode(
    'gyblos/reusable-open/v1\n' + JSON.stringify(stable),
  );
  return (
    'gyblos-reusable:' +
    Buffer.from(await crypto.subtle.digest('SHA-256', canonical)).toString(
      'hex',
    )
  );
}
