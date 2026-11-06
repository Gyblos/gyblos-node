// Locale-specific full export so readers need not load the other language.
import { i18n } from '../../../lib/i18n';
import { fullMarkdown } from '../../../lib/markdown';

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lang: string }> },
) {
  const { lang } = await params;
  return new Response(await fullMarkdown(lang), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
