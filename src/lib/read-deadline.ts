class ReadDeadlineError extends Error {
  readonly statusCode = 503;

  constructor() {
    super('Public read deadline exceeded');
    this.name = 'ReadDeadlineError';
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new ReadDeadlineError();
}

export function abortableRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
