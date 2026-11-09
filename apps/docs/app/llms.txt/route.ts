// Static discovery index generated from the published bilingual page collection.
import { llmsIndex } from '../../lib/markdown';

export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsIndex(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
