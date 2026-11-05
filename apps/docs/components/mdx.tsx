// The components MDX pages may use: Fumadocs defaults (Callout, Cards…) plus Steps.
import { Step, Steps } from 'fumadocs-ui/components/steps';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Step,
    Steps,
    ...components,
  } satisfies MDXComponents;
}
