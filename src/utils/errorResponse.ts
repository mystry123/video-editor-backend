// utils/errorResponse.ts
//
// The one shape every error response uses:
//
//   { success: false, error, message, code, details?, requestId }
//
// `error` and `message` carry the same user-facing text: `error` keeps older
// frontend code (which reads `data.error`) working; new code reads `message`
// and branches on `code`. `requestId` matches the X-Request-Id header and the
// server logs, so a user-reported failure can be traced.

import type { Request, Response } from 'express';

export interface ErrorBody {
  success: false;
  error: string;
  message: string;
  code: string;
  details?: unknown;
  requestId?: string;
}

/** Default code for a status when the thrower didn't give one. */
export function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'ERROR';
  }
}

export function errorBody(
  req: Request,
  status: number,
  message: string,
  code?: string,
  details?: unknown
): ErrorBody {
  return {
    success: false,
    error: message,
    message,
    code: code || defaultCodeForStatus(status),
    ...(details !== undefined ? { details } : {}),
    ...((req as any).id ? { requestId: (req as any).id } : {}),
  };
}

export function sendError(
  req: Request,
  res: Response,
  status: number,
  message: string,
  code?: string,
  details?: unknown
): void {
  if (res.headersSent) return;
  res.status(status).json(errorBody(req, status, message, code, details));
}
