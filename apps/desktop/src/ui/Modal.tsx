// Shared compact dialog: focus stays inside an open window and exits are retained by MotionPresence.
import { X } from '@phosphor-icons/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { MODAL_ORIGIN, type ModalOrigin } from './constants';
import { createModalDismissal } from './modal-model';
import { useExiting } from './Motion';
import { IconButton } from './UI';

export function Modal({
  title,
  description,
  children,
  close,
  compact = false,
  size,
  origin,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  compact?: boolean;
  size?: 'sm' | 'md' | 'lg';
  origin?: ModalOrigin;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const exiting = useExiting();
  const dismissal = useRef(createModalDismissal());
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected)
        requestAnimationFrame(() => opener.focus());
    };
  }, []);
  useEffect(() => {
    ref.current?.showModal();
    if (compact) ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [compact]);
  return (
    <dialog
      className={compact ? 'modal compact-picker' : 'modal'}
      data-size={compact ? undefined : (size ?? 'md')}
      data-origin={origin ?? MODAL_ORIGIN.CENTER}
      ref={ref}
      aria-labelledby={titleId}
      inert={exiting}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        dismissal.current.start(
          event,
          event.currentTarget.getBoundingClientRect(),
        );
      }}
      onPointerUp={(event) => {
        if (
          dismissal.current.end(
            event,
            event.currentTarget.getBoundingClientRect(),
          )
        )
          close();
      }}
      onPointerCancel={() => dismissal.current.cancel()}
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
