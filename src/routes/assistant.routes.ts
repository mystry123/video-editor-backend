import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { voiceLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import * as assistantController from '../controllers/assistant.controller';
import { generateImage } from '../controllers/aiImage.controller';
import { addMemorySchema, chatSchema, deleteMemorySchema, generateImageSchema } from '../validators/assistant.validator';

const router: ExpressRouter = Router();
router.use(requireAuth);
router.post('/chat', voiceLimiter, validate(chatSchema), assistantController.chat);
router.post('/image', voiceLimiter, validate(generateImageSchema), generateImage);
router.get('/memory', assistantController.getMemory);
router.post('/memory', validate(addMemorySchema), assistantController.addMemory);
router.delete('/memory/:id', validate(deleteMemorySchema), assistantController.deleteMemory);
export default router;
