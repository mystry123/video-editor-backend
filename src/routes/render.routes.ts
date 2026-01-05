import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { renderLimiter, progressLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import * as renderController from '../controllers/render.controller';
import { startRenderSchema } from '../validators/render.validator';

const router = Router();

router.use(requireAuth);

router.post('/', renderLimiter, validate(startRenderSchema), renderController.startRender);
router.get('/', renderController.listRenderJobs);
router.get('/:id', renderController.getRenderStatus);
router.get('/:id/progress', progressLimiter, renderController.streamProgress);
router.post('/:id/cancel', renderController.cancelRender);

// Zapier-friendly endpoints
router.post('/zapier/render', renderLimiter, renderController.zapierRender);
router.get('/zapier/:id/poll', renderController.zapierPoll);

export default router;
