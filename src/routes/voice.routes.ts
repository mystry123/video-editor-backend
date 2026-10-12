import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadLimiter, voiceLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import * as voiceController from '../controllers/voice.controller';
import { createOwnVoiceSchema, createSampleUploadSchema, createSpeechSchema, previewVoiceSchema } from '../validators/voice.validator';

const router: ExpressRouter = Router();

router.use(requireAuth);

router.get('/voices', voiceController.listVoices);
router.post('/speech', voiceLimiter, validate(createSpeechSchema), voiceController.createSpeech);
router.post('/preview', voiceLimiter, validate(previewVoiceSchema), voiceController.previewVoice);
router.post('/own/sample-url', uploadLimiter, validate(createSampleUploadSchema), voiceController.createSampleUpload);
router.post('/own', voiceLimiter, validate(createOwnVoiceSchema), voiceController.createOwnVoice);
router.delete('/own', voiceController.deleteOwnVoice);

export default router;
