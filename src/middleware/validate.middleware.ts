import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parsed values win; keys only present in the original are kept, at every depth. */
function mergeParsed(original: unknown, parsed: unknown): unknown {
  if (isPlainObject(original) && isPlainObject(parsed)) {
    const result: Record<string, unknown> = { ...original };
    for (const [key, value] of Object.entries(parsed)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      result[key] = mergeParsed(original[key], value);
    }
    return result;
  }
  if (Array.isArray(original) && Array.isArray(parsed) && original.length === parsed.length) {
    return parsed.map((item, i) => mergeParsed(original[i], item));
  }
  return parsed;
}

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
        // Deep merge: a shallow spread would replace nested objects (e.g.
        // data.project) with zod's stripped copies and drop their extra fields.
        req.body = mergeParsed(req.body, parsed.body);
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
