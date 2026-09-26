export class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 'usage_error',
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

export class PaymentBlockedError extends UsageError {
  constructor(message = 'payment is blocked; pay in the Takealot app') {
    super(message, 'payment_blocked');
    this.name = 'PaymentBlockedError';
  }
}

export class UnsafeUrlError extends UsageError {
  constructor(message = 'unsafe Takealot API URL') {
    super(message, 'unsafe_url');
    this.name = 'UnsafeUrlError';
  }
}
