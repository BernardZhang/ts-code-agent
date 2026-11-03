export enum ModelErrorCode {
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
  NETWORK = 'network',
  HTTP = 'http',
  PROTOCOL = 'protocol',
  JSON = 'json',
  VALIDATION = 'validation',
  UNSUPPORTED = 'unsupported',
}

export class ModelError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelError';
  }
}
