import { Router } from 'express';
import authRoutes from './auth.routes';
import templateRoutes from './template.routes';
import fileRoutes from './file.routes';
import transcriptionRoutes from './transcription.routes';
import renderRoutes from './render.routes';
import webhookRoutes from './webhook.routes';

const router: Router = Router();

router.use('/auth', authRoutes);
router.use('/templates', templateRoutes);
router.use('/files', fileRoutes);
router.use('/transcriptions', transcriptionRoutes);
router.use('/render', renderRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
