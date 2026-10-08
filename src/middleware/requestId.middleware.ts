// Gives every request an id (reusing a sane incoming X-Request-Id, e.g. from
// the Remix server or nginx), echoes it in the response header, and makes it
// available as req.id for logs and error bodies.

import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('X-Request-Id');
  const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  (req as any).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
