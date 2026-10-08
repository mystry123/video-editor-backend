// routes/renderLink.routes.ts
//
// GET /r/:id?t=<token>[&download=1] — the Shotline link for a render. Anyone
// with the link may open it; it redirects to a short-lived signed URL for the
// private file, so the bucket is never exposed and the link never expires
// (until the render is deleted).

import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction, type Router as ExpressRouter } from 'express';
import { Types } from 'mongoose';
import { RenderJob } from '../models/RenderJob';
import { presignOutput } from '../services/renderOutput.service';
import { sendError } from '../utils/errorResponse';
import { renderLinkLimiter } from '../middleware/rateLimit.middleware';

const router: ExpressRouter = Router();

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

router.get('/:id', renderLinkLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const notFound = () => sendError(req, res, 404, 'This render link is invalid or the render was deleted.', 'RENDER_LINK_NOT_FOUND');
    if (!Types.ObjectId.isValid(req.params.id) || !token) return notFound();

    const job = await RenderJob.findOne({ _id: req.params.id, status: 'completed' })
      .select('+shareToken +outputBucket +outputKey outputUrl outputFormat')
      .lean();
    if (!job?.shareToken || !sameToken(job.shareToken, token)) return notFound();

    const url = await presignOutput(job, { download: req.query.download === '1' });
    if (!url) return notFound();

    // The signed URL lasts an hour; don't let anything cache the redirect longer than a few minutes.
    res.set('Cache-Control', 'private, max-age=300');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(302, url);
  } catch (error) {
    next(error);
  }
});

export default router;
