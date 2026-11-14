import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import * as webhookController from '../controllers/webhook.controller';
import { handleRemotionWebhook } from '../controllers/remotionWebhook.controller';
import { createWebhookSchema, updateWebhookSchema } from '../validators/webhook.validator';

const router: ExpressRouter = Router();

// Remotion Lambda's render webhook: no user auth, verified by its signature
// (404 unless RENDER_PROVIDER=lambda with REMOTION_WEBHOOK_URL/SECRET set).
router.post('/remotion', handleRemotionWebhook);

// All other webhook routes require authentication
router.use(requireAuth);

// Secret that signs deliveries to a render's own webhookUrl (before /:id).
router.get('/signing-secret', webhookController.getSigningSecret);
router.post('/', validate(createWebhookSchema), webhookController.createWebhook);
router.get('/', webhookController.listWebhooks);
router.get('/:id', webhookController.getWebhook);
router.put('/:id', validate(updateWebhookSchema), webhookController.updateWebhook);
router.delete('/:id', webhookController.deleteWebhook);
// Testing & Logs
router.post('/:id/test', webhookController.testWebhook);
router.get('/:id/logs', webhookController.getWebhookLogs);

export default router;
