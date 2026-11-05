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
import { i18n } from '../../../lib/i18n';
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
      <DocsDescription>{page.data.description}</DocsDescription>
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
    alternates: {
      canonical: page.url,
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
