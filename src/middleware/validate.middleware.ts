import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

/**
 * Validates body, query and params against `schema`. On failure, passes a 400
 * VALIDATION_ERROR to the error handler, with the first problem as the message
 * and every problem in `details` as `{ path, message }`.
 *
 * Parsed values (trimmed strings, coerced numbers, defaults) are merged over
 * the originals. Unknown fields are kept for now; routes that must reject or
 * strip them use field whitelists in their controllers.
 */
export const validate = (schema: ZodSchema) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed: any = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (parsed?.body && typeof parsed.body === 'object' && req.body && typeof req.body === 'object') {
        req.body = { ...req.body, ...parsed.body };
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.issues.map((issue) => ({
          path: issue.path.filter((p) => p !== 'body' && p !== 'query' && p !== 'params').join('.'),
          message: issue.message,
        }));
        next(ApiError.withCode(400, 'VALIDATION_ERROR', details[0]?.message || 'Some fields are invalid.', details));
        return;
      }
      next(error);
    }
  };
};
