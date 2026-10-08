import { Router, type Router as ExpressRouter } from 'express';
import authRoutes from './auth.routes';
import templateRoutes from './template.routes';
import fileRoutes from './file.routes';
import transcriptionRoutes from './transcription.routes';
import renderRoutes from './render.routes';
import webhookRoutes from './webhook.routes';
import captionRoutes from './caption.routes';
import projectRoutes from './project.routes';
import reframeRoutes from './reframe.routes';
import adminRoutes from './admin.routes';
const router: ExpressRouter = Router();

router.use('/auth', authRoutes);

router.use('/templates', templateRoutes);
router.use('/files', fileRoutes);
router.use('/transcriptions', transcriptionRoutes);
router.use('/render', renderRoutes);
router.use('/webhooks', webhookRoutes);
// (The unauthenticated /caption-presets router was removed: presets live at /caption/presets.)
router.use('/caption', captionRoutes);
router.use('/projects',projectRoutes)
router.use('/reframe', reframeRoutes);
router.use('/admin', adminRoutes);

export default router;
