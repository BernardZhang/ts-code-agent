export enum EContextErrorCode {
  INVALID_BUDGET = 'context_invalid_budget',
  BUDGET_EXCEEDED = 'context_budget_exceeded',
  INVALID_HISTORY = 'context_invalid_history',
  INVALID_ESTIMATE = 'context_invalid_estimate',
}

export class ContextError extends Error {
  constructor(
    public readonly code: EContextErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ContextError';
  }
}
