// Wraps ordinary sandbox payment calls so a reviewed capture retains exclusive access.
// It does not validate provider responses or decide payment amounts.
type Operation = <T>(
  run: () => Promise<T>,
  authorizationId?: string,
  isCapture?: boolean,
) => Promise<T>;
type Actions = {
  validateCapture(
    authorizationId: string,
    cents?: number,
    limitCents?: number,
  ): void;
  validateAuthorization(authorizationId: string): void;
  create(
    requestId: string,
    returnState?: string,
    limitCents?: number,
  ): Promise<{ orderId: string; approvalUrl: string }>;
  capture(
    authorizationId: string,
    cents?: number,
    limitCents?: number,
  ): Promise<{ captureId: string }>;
  void(authorizationId: string, limitCents?: number): Promise<void>;
  refund(captureId: string): Promise<void>;
};
export function managedPaypalOperations(
  operation: Operation,
  invalidate: () => void,
  actions: Actions,
) {
  return {
    create: (requestId: string, returnState?: string, limitCents?: number) =>
      operation(async () => {
        invalidate();
        return actions.create(requestId, returnState, limitCents);
      }),
    async capture(authorizationId: string, cents?: number) {
      actions.validateCapture(authorizationId, cents);
      return operation(
        async () => {
          invalidate();
          return actions.capture(authorizationId, cents);
        },
        authorizationId,
        true,
      );
    },
    async void(authorizationId: string, limitCents?: number) {
      actions.validateAuthorization(authorizationId);
      await operation(
        async () => {
          invalidate();
          await actions.void(authorizationId, limitCents);
        },
        authorizationId,
        true,
      );
    },
    refund: (captureId: string) =>
      operation(async () => {
        invalidate();
        await actions.refund(captureId);
      }),
  };
}
