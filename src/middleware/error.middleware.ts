import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { sendError } from '../utils/errorResponse';

/**
 * The only place errors become responses (see utils/errorResponse.ts for the
 * shape). Client errors log at warn without a stack; server errors log the
 * full error but only ever return a generic message.
 */
export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction): void => {
  const context = { requestId: (req as any).id, path: req.path, method: req.method, userId: (req as any).userId };

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) logger.error({ ...context, err }, err.message);
    else logger.warn({ ...context, code: err.code, status: err.statusCode }, err.message);
    // 5xx ApiErrors (e.g. ApiError.internal) still never leak their text.
    const message = err.statusCode >= 500 && !err.isOperational ? 'Something went wrong on our side. Try again in a moment.' : err.message;
    sendError(req, res, err.statusCode, message, err.code, err.details);
    return;
  }

  // body-parser: JSON over the size limit, or malformed JSON.
  if (err?.type === 'entity.too.large') {
    logger.warn(context, 'Request body too large');
    sendError(req, res, 413, 'This request is too large. Remove some content and try again.', 'PAYLOAD_TOO_LARGE');
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    logger.warn(context, 'Malformed JSON body');
    sendError(req, res, 400, 'The request body is not valid JSON.', 'INVALID_JSON');
    return;
  }

  // Mongoose validation error
  if (err?.name === 'ValidationError' && err.errors) {
    logger.warn({ ...context, err: err.message }, 'Mongoose validation error');
    const details = Object.values(err.errors).map((e: any) => ({ path: e.path, message: e.message }));
    sendError(req, res, 400, (details[0] as any)?.message || 'Some fields are invalid.', 'VALIDATION_ERROR', details);
    return;
  }

  // Mongoose duplicate key error
  if (err?.code === 11000) {
    logger.warn({ ...context, keyValue: err.keyValue }, 'Duplicate key');
    sendError(req, res, 409, 'That already exists.', 'DUPLICATE');
    return;
  }

  // Mongoose cast error (invalid ObjectId)
  if (err?.name === 'CastError') {
    logger.warn({ ...context, value: err.value }, 'Invalid id');
    sendError(req, res, 400, 'Invalid ID format', 'INVALID_ID');
    return;
  }

  // Other errors that carry an explicit client status (e.g. from libraries).
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    logger.warn({ ...context, status }, err?.message || 'Client error');
    sendError(req, res, status, err?.expose && err?.message ? err.message : 'The request could not be processed.');
    return;
  }

  // Don't leak internal errors
  logger.error({ ...context, err }, err?.message || 'Unhandled error');
  sendError(req, res, 500, 'Something went wrong on our side. Try again in a moment.', 'INTERNAL');
};
