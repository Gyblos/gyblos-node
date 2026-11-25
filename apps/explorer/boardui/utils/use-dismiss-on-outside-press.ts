'use client';

import { useEffect, useRef, type RefObject } from 'react';

export function useDismissOnOutsidePress(
  isOpen: boolean,
  onDismiss: () => void,
  refs: RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen, onDismiss, refs]);
}

const REOPEN_GUARD_MS = 400;

export function useTriggerToggle(
  isOpen: boolean,
  triggerRef: RefObject<HTMLElement | null>,
) {
  const suppressReopenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        !triggerRef.current?.contains(event.target)
      )
        return;
      suppressReopenRef.current = true;
      setTimeout(() => {
        suppressReopenRef.current = false;
      }, REOPEN_GUARD_MS);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen, triggerRef]);

  return (next: boolean) => {
    if (next && suppressReopenRef.current) {
      suppressReopenRef.current = false;
      return false;
    }
    return true;
  };
}
