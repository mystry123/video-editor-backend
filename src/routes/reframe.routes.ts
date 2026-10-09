// src/routes/reframe.routes.ts
// AI Reframe API routes — follows transcription.routes.ts pattern

import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import * as reframeController from '../controllers/reframe.controller';

const router: ExpressRouter = Router();

router.use(requireAuth);

// GET /api/v1/reframe — The user's reframes, newest first (one per video and shape)
router.get('/', reframeController.listReframes);

// POST /api/v1/reframe — Start a reframe job
router.post('/', reframeController.createReframe);

// GET /api/v1/reframe/status/:fileId/:aspectRatio — Poll status
router.get('/status/:fileId/:aspectRatio', reframeController.getReframeStatus);

// DELETE /api/v1/reframe/:fileId/:aspectRatio — Remove reframe data
router.delete('/:fileId/:aspectRatio', reframeController.deleteReframe);

export default router;
