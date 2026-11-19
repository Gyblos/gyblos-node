// Owns the explorer's root layout: fonts, metadata for search engines and link previews, structured
// data, and the page frame. Icons and the link-preview image are the website's (app/ icon files).
import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { SITE } from '../lib/site';

import './globals.css';

const instrument = Instrument_Sans({
  variable: '--font-instrument',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

const jetbrains = JetBrains_Mono({
  variable: '--font-jetbrains',
  subsets: ['latin'],
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.origin),
  title: SITE.title,
  description: SITE.description,
  applicationName: SITE.name,
  alternates: { canonical: '/' },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  openGraph: {
    type: 'website',
    siteName: 'Gyblos',
    locale: 'en_US',
    url: '/',
    title: SITE.title,
    description: SITE.description,
  },
  twitter: {
    card: 'summary_large_image',
    site: SITE.twitter,
    title: SITE.title,
    description: SITE.description,
  },
};

export const viewport: Viewport = {
  themeColor: SITE.themeColor,
  colorScheme: 'light dark',
};

// What the page is, for search and answer engines: a web page of the Gyblos site that publishes a
// live dataset with its public sources.
const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE.origin}/#website`,
      name: SITE.name,
      url: `${SITE.origin}/`,
      description: SITE.description,
      inLanguage: 'en',
      publisher: { '@id': `${SITE.web}/#organization` },
    },
    {
      '@type': 'Organization',
      '@id': `${SITE.web}/#organization`,
      name: 'Gyblos',
      url: SITE.web,
      logo: `${SITE.origin}/apple-icon.png`,
      sameAs: [SITE.docs, 'https://x.com/gyblos'],
    },
    {
      '@type': 'Dataset',
      name: 'Gyblos network metrics',
      description:
        'Daily requests, success rate, tokens and latency of the Gyblos inference network from signed receipts, sellers online with their models, prices and uptime, and USDC settled by Gyblos payment channels on Solana.',
      url: `${SITE.origin}/`,
      isAccessibleForFree: true,
      creator: { '@id': `${SITE.web}/#organization` },
      distribution: [
        {
          '@type': 'DataDownload',
          encodingFormat: 'application/json',
          contentUrl: 'https://collector.gyblos.com/v1/stats/network',
        },
        {
          '@type': 'DataDownload',
          encodingFormat: 'application/json',
          contentUrl: 'https://discovery.gyblos.com/v1/models',
        },
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrument.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <head>
        <link rel="describedby" type="text/plain" href="/llms.txt" />
        <script
          type="application/ld+json"
          // Static JSON from constants; `<` is escaped so no text can close the script.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(STRUCTURED_DATA).replace(/</g, '\\u003c'),
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
