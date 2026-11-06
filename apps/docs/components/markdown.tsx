// Markdown forms of the authored MDX components; preserve warnings and links without UI markup.
// New content components need a Markdown form here and an export acceptance check.
import { asMarkdown, md } from 'fumadocs-core/server';
import type { ReactNode } from 'react';

import { siteUrl } from '../lib/shared';

function Container({ children }: { children?: ReactNode }) {
  asMarkdown();
  return children;
}

function Callout({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  asMarkdown();
  return md.linePrefix('> ')`${title ? `**${title}**\n\n` : ''}${children}`;
}

function Card({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children?: ReactNode;
}) {
  asMarkdown();
  return md`[${title}](${new URL(href, siteUrl).href})\n\n${children}\n\n`;
}

export const markdownComponents = {
  Callout,
  Card,
  Cards: Container,
  Steps: Container,
  Step: Container,
};
