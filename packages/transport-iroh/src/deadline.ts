// Races an operation against a deadline and cancels it on timeout; the payment outcome is then uncertain.
export async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  cancel: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(
            new Error(
              'Transport deadline exceeded; payment outcome may be uncertain.',
            ),
          );
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
