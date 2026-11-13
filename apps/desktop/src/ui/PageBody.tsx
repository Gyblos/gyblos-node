// Owns buyer page scrolling and responsive insets; never starts application workflows.
import type { ComponentPropsWithRef, ReactNode } from 'react';

export function PageBody({
  ref,
  chat,
  split = false,
  children,
}: {
  ref?: ComponentPropsWithRef<'div'>['ref'];
  chat: boolean;
  split?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      className="content"
      data-layout={chat ? 'chat' : split ? 'split' : undefined}
    >
      {children}
    </div>
  );
}
