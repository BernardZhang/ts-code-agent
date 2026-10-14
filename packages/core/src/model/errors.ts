export type ModelErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'protocol'
  | 'json'
  | 'validation'
  | 'unsupported';

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
