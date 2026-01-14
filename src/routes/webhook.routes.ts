import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import * as webhookController from '../controllers/webhook.controller';
import { createWebhookSchema, updateWebhookSchema } from '../validators/webhook.validator';

const router: ExpressRouter = Router();

// Remotion webhook should be accessible without auth (comes from AWS Lambda)
router.post('/remotion', webhookController.handleRemotionWebhook);

// All other webhook routes require authentication
router.use(requireAuth);

router.post('/', validate(createWebhookSchema), webhookController.createWebhook);
router.get('/', webhookController.listWebhooks);
router.get('/:id', webhookController.getWebhook);
router.put('/:id', validate(updateWebhookSchema), webhookController.updateWebhook);
router.delete('/:id', webhookController.deleteWebhook);
// Testing & Logs
router.post('/:id/test', webhookController.testWebhook);
router.get('/:id/logs', webhookController.getWebhookLogs);

export default router;
