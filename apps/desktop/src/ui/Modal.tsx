// Shared compact dialog: focus stays inside an open window and exits are retained by MotionPresence.
import { X } from '@phosphor-icons/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { useExiting } from './Motion';
import { IconButton } from './UI';

export function Modal({
  title,
  description,
  children,
  close,
  compact = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  compact?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const exiting = useExiting();
  useEffect(() => {
    ref.current?.showModal();
    if (compact) ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [compact]);
  return (
    <dialog
      className={compact ? 'modal compact-picker' : 'modal'}
      ref={ref}
      aria-labelledby={titleId}
      inert={exiting}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <IconButton label="Close dialog" onClick={close}>
          <X size={20} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}
