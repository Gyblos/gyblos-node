// Shared responsive main/context composition; callers own state and actions.
import { X } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { IconButton } from './UI';

export function WorkspaceLayout({
  children,
  context,
  contextOpen,
  onCloseContext,
}: {
  children: ReactNode;
  context: ReactNode;
  contextOpen: boolean;
  onCloseContext: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!contextOpen && panel.current?.contains(document.activeElement)) {
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Show connection context"]',
        )
        ?.focus();
    }
  }, [contextOpen]);
  return (
    <div className="ui-motion-workspace" data-context-open={contextOpen}>
      <div className="ui-workspace" data-context-open={contextOpen}>
        <main className="ui-workspace-main">{children}</main>
        <aside
          ref={panel}
          className="ui-context-panel"
          aria-label="Connection context"
          inert={!contextOpen}
          aria-hidden={!contextOpen}
        >
          <header className="ui-context-heading">
            <h2>Connection context</h2>
            <IconButton
              label="Close connection context"
              onClick={onCloseContext}
            >
              <X size={18} />
            </IconButton>
          </header>
          {context}
        </aside>
      </div>
    </div>
  );
}
