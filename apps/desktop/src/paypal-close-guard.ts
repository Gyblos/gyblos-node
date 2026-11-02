// Stops ordinary shutdown while an in-process response still needs acknowledgement.
export function createDesktopPaypalCloseGuard(
  blocked: () => boolean,
  notify: () => void,
) {
  return (event: { preventDefault(): void }) => {
    if (!blocked()) return false;
    event.preventDefault();
    notify();
    return true;
  };
}
