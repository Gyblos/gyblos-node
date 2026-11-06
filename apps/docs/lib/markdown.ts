// Renders the same compiled MDX used by the site into standalone documents and LLM discovery files.
// Source content stays canonical; this module never reads operator files or calls external services.
import { markdownComponents } from '../components/markdown';
import { i18n } from './i18n';
import { appName, siteUrl } from './shared';
import { source } from './source';

export function markdownUrl(url: string) {
  const segments = url.split('/').filter(Boolean);
  if (segments.length === 1) segments.push('index');
  return `/markdown/${segments.join('/')}.md`;
}

export async function pageMarkdown(
  page: ReturnType<typeof source.getPages>[number],
) {
  const body = await page.data.getText('processed', {
    components: markdownComponents,
  });
  return `# ${page.data.title}\n\n${page.data.description ?? ''}\n\nSource: ${siteUrl}${page.url}\n\n${body.trim()}\n`;
}

export async function fullMarkdown(locale?: string) {
  const pages = source.getPages(locale);
  const documents = await Promise.all(pages.map(pageMarkdown));
  return documents.join('\n---\n\n');
}

export function llmsIndex() {
  const sections = i18n.languages.map((locale) => {
    const links = source
      .getPages(locale)
      .map(
        (page) =>
          `- [${page.data.title}](${siteUrl}${markdownUrl(page.url)}): ${page.data.description ?? ''}`,
      );
    const title = locale === 'es' ? 'Español' : 'English';
    return `## ${title}\n\n${links.join('\n')}\n\n- [Complete ${title} documentation](${siteUrl}/${locale}/llms-full.txt)`;
  });
  return `# ${appName}\n\n> Guides for running a Gyblos node. English and Spanish.\n\nThese guides describe the current invited seller beta on Solana devnet, not mainnet readiness.\nFollow the language and version of the relevant guide. Never share relay tokens, invitation codes or keys.\n\n${sections.join('\n\n')}\n\n## Full documentation\n\n- [All pages in both languages](${siteUrl}/llms-full.txt)\n`;
}
