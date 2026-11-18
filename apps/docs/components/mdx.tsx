// The components MDX pages may use: Fumadocs defaults (Callout, Cards…) plus Steps, and Card with named icons.
import { Card as BaseCard } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

import { sidebarIcon } from './sidebar-icons';

// Pages name a card icon from the site's finite icon catalog (icon="chat"); the Markdown export ignores it.
function Card({ icon, ...props }: ComponentProps<typeof BaseCard>) {
  return (
    <BaseCard
      {...props}
      icon={typeof icon === 'string' ? sidebarIcon(icon) : icon}
    />
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Card,
    Step,
    Steps,
    ...components,
  } satisfies MDXComponents;
}
