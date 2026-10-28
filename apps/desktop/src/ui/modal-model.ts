// Only a primary press and release on the backdrop can dismiss a shared dialog.
interface DialogBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface DialogPointer {
  pointerId: number;
  button: number;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
}
function outside(pointer: DialogPointer, bounds: DialogBounds) {
  return (
    pointer.clientX < bounds.left ||
    pointer.clientX > bounds.right ||
    pointer.clientY < bounds.top ||
    pointer.clientY > bounds.bottom
  );
}
export function createModalDismissal() {
  let pressed: number | null = null;
  return {
    start(pointer: DialogPointer, bounds: DialogBounds) {
      pressed =
        pointer.isPrimary && pointer.button === 0 && outside(pointer, bounds)
          ? pointer.pointerId
          : null;
    },
    end(pointer: DialogPointer, bounds: DialogBounds) {
      const dismiss =
        pressed === pointer.pointerId &&
        pointer.isPrimary &&
        pointer.button === 0 &&
        outside(pointer, bounds);
      pressed = null;
      return dismiss;
    },
    cancel() {
      pressed = null;
    },
  };
}
