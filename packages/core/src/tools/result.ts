export enum ToolErrorCode {
  UNKNOWN_TOOL = 'unknown_tool',
  INVALID_ARGUMENTS = 'invalid_arguments',
  EXECUTION_FAILED = 'execution_failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
}

export type ToolResult =
  | {
      success: true;
      output: unknown;
    }
  | {
      success: false;
      error: {
        code: ToolErrorCode;
        message: string;
      };
    };
