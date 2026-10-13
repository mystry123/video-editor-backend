import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { voiceLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import * as assistantController from '../controllers/assistant.controller';
import { chatSchema } from '../validators/assistant.validator';

const router: ExpressRouter = Router();
router.use(requireAuth);
router.post('/chat', voiceLimiter, validate(chatSchema), assistantController.chat);
export default router;
