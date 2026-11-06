// Exports a stable Markdown URL for every page and locale; only known source pages are generated.
import { notFound } from 'next/navigation';

import { markdownUrl, pageMarkdown } from '../../../lib/markdown';
import { source } from '../../../lib/source';

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return source
    .getPages()
    .map((page) => ({ slug: markdownUrl(page.url).split('/').slice(2) }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const path = `/markdown/${slug.join('/')}`;
  const page = source
    .getPages()
    .find((entry) => markdownUrl(entry.url) === path);
  if (!page) notFound();
  return new Response(await pageMarkdown(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
