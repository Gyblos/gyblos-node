// Renders one MDX page per language and path, with canonical and hreflang links.
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getMDXComponents } from '../../../components/mdx';
import { PageActions } from '../../../components/page-actions';
import { i18n } from '../../../lib/i18n';
import { markdownUrl } from '../../../lib/markdown';
import { siteUrl } from '../../../lib/shared';
import { source } from '../../../lib/source';

interface PageProps {
  params: Promise<{ lang: string; slug?: string[] }>;
}

export default async function Page(props: PageProps) {
  const { lang, slug } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">
        {page.data.description}
      </DocsDescription>
      <PageActions
        key={page.url}
        markdownUrl={markdownUrl(page.url)}
        spanish={lang === 'es'}
      />
      <DocsBody>
        <MDX
          components={getMDXComponents({ a: createRelativeLink(source, page) })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams('slug', 'lang');
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { lang, slug } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const path = (slug ?? []).join('/');
  return {
    // The home page title already names the site; the template would repeat it.
    title: path ? page.data.title : { absolute: page.data.title },
    description: page.data.description,
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      url: `${siteUrl}${page.url}`,
      type: 'article',
      locale: lang === 'es' ? 'es_ES' : 'en_US',
      alternateLocale: lang === 'es' ? 'en_US' : 'es_ES',
      siteName: 'Gyblos Docs',
    },
    twitter: {
      card: 'summary',
      title: page.data.title,
      description: page.data.description,
    },
    alternates: {
      canonical: page.url,
      types: { 'text/markdown': markdownUrl(page.url) },
      languages: {
        ...Object.fromEntries(
          i18n.languages.map((language) => [
            language,
            `/${language}${path ? `/${path}` : ''}`,
          ]),
        ),
        'x-default': `/${i18n.defaultLanguage}${path ? `/${path}` : ''}`,
      },
    },
  };
}
