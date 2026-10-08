export interface ApiErrorOptions {
  /** Machine-readable code the frontend can branch on, e.g. "RESOLUTION_NOT_ALLOWED". */
  code?: string;
  /** Extra structured data, e.g. which field failed validation. */
  details?: unknown;
}

export class ApiError extends Error {
  statusCode: number;
  isOperational: boolean;
  code?: string;
  details?: unknown;

  constructor(statusCode: number, message: string, isOperational = true, options: ApiErrorOptions = {}) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = options.code;
    this.details = options.details;
    Error.captureStackTrace(this, this.constructor);
  }

  static withCode(statusCode: number, code: string, message: string, details?: unknown): ApiError {
    return new ApiError(statusCode, message, true, { code, details });
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, message);
  }

  static unauthorized(message = 'Unauthorized'): ApiError {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Forbidden'): ApiError {
    return new ApiError(403, message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, message);
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(500, message, false);
  }
}
