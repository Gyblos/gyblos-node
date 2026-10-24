// Provides pointer and keyboard resizing for local prototype panes.
// It changes only layout values; it performs no persistence or platform actions.
import { useRef, useState } from 'react';

type ResizeHandleProps = {
  label: string;
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  initial: number;
  reverse?: boolean;
  controls: string;
  onChange: (value: number) => void;
};
export function ResizeHandle({
  label,
  orientation,
  value,
  min,
  max,
  initial,
  reverse = false,
  controls,
  onChange,
}: ResizeHandleProps) {
  const origin = useRef<{ position: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function change(next: number) {
    onChange(Math.round(Math.max(min, Math.min(max, next))));
  }
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={Math.round(value) + ' pixels'}
      aria-controls={controls}
      tabIndex={0}
      className={'resize-handle ' + orientation}
      data-dragging={dragging}
      title="Drag to resize. Arrow keys adjust; double-click resets."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = {
          position: orientation === 'vertical' ? event.clientX : event.clientY,
          value,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!origin.current) return;
        const position =
          orientation === 'vertical' ? event.clientX : event.clientY;
        change(
          origin.current.value +
            (position - origin.current.position) * (reverse ? -1 : 1),
        );
      }}
      onPointerUp={(event) => {
        origin.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        origin.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        origin.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => change(initial)}
      onKeyDown={(event) => {
        const lower = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
        const higher = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
        if (![lower, higher, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home') change(min);
        else if (event.key === 'End') change(max);
        else
          change(
            value +
              (event.key === higher ? 1 : -1) *
                (reverse ? -1 : 1) *
                (event.shiftKey ? 40 : 10),
          );
      }}
    >
      <span />
    </div>
  );
}
