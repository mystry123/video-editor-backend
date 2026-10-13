import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { voiceLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import * as assistantController from '../controllers/assistant.controller';
import { generateImage } from '../controllers/aiImage.controller';
import * as sessions from '../controllers/chatSession.controller';
import * as director from '../controllers/director.controller';
import {
  addMemorySchema,
  chatSchema,
  directorRunSchema,
  startDirectorSchema,
  createSessionSchema,
  deleteMemorySchema,
  generateImageSchema,
  listSessionsSchema,
  sessionIdSchema,
  updatePreferencesSchema,
  updateSessionSchema,
} from '../validators/assistant.validator';

const router: ExpressRouter = Router();
router.use(requireAuth);
router.post('/chat', voiceLimiter, validate(chatSchema), assistantController.chat);
router.post('/image', voiceLimiter, validate(generateImageSchema), generateImage);
router.get('/preferences', assistantController.getPreferences);
router.put('/preferences', validate(updatePreferencesSchema), assistantController.updatePreferences);
router.get('/sessions', validate(listSessionsSchema), sessions.listSessions);
router.post('/sessions', validate(createSessionSchema), sessions.createSession);
router.get('/sessions/:id', validate(sessionIdSchema), sessions.getSession);
router.put('/sessions/:id', validate(updateSessionSchema), sessions.updateSession);
router.delete('/sessions/:id', validate(sessionIdSchema), sessions.deleteSession);
router.post('/director', voiceLimiter, validate(startDirectorSchema), director.startDirector);
router.get('/director/:id', validate(directorRunSchema), director.getDirector);
router.post('/director/:id/stop', validate(directorRunSchema), director.stopDirector);
router.get('/memory', assistantController.getMemory);
router.post('/memory', validate(addMemorySchema), assistantController.addMemory);
router.delete('/memory/:id', validate(deleteMemorySchema), assistantController.deleteMemory);
export default router;
