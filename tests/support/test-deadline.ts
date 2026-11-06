// Mockable test watchdogs without native capability setup; the default bound remains unchanged.
export class NativeTestDeadlineError extends Error {
  constructor() {
    super('Synthetic native test deadline exceeded');
    this.name = 'NativeTestDeadlineError';
  }
}
export async function within<T>(operation: Promise<T>, milliseconds = 3500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new NativeTestDeadlineError()),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
