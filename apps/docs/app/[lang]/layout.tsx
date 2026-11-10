// Root layout of every page: fonts, metadata, language provider and the docs sidebar.
import { i18nProvider } from 'fumadocs-ui/i18n';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Provider } from '../../components/provider';
import { i18n } from '../../lib/i18n';
import { baseOptions, translations } from '../../lib/layout.shared';
import { appName, siteUrl } from '../../lib/shared';
import { source } from '../../lib/source';

import '../global.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { template: `%s · ${appName}`, default: appName },
  icons: { icon: '/favicon.svg' },
};

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>;
  children: ReactNode;
}) {
  const { lang } = await params;

  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        <link rel="describedby" href="/llms.txt" />
      </head>
      <body className="flex flex-col min-h-screen">
        <Provider i18n={i18nProvider(translations, lang)}>
          <DocsLayout
            tree={source.getPageTree(lang)}
            {...baseOptions(lang)}
            containerProps={{
              style: {
                gridTemplate:
                  '"sidebar header toc" "sidebar toc-popover toc" "sidebar tabs toc" "sidebar main toc" 1fr / var(--fd-sidebar-col) minmax(0, 1fr) var(--fd-toc-width)',
              },
            }}
          >
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}
