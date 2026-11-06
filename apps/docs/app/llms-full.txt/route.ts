// Complete static Markdown export, with each page's title, description and canonical source URL.
import { fullMarkdown } from '../../lib/markdown';

export const dynamic = 'force-static';

export async function GET() {
  return new Response(await fullMarkdown(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
