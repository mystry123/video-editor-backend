import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadLimiter, voiceLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import * as voiceController from '../controllers/voice.controller';
import * as audioToolsController from '../controllers/audioTools.controller';
import { cleanUpAudioSchema, createDubSchema, getDubSchema, createOwnVoiceSchema, createSampleUploadSchema, createSpeechSchema, previewVoiceSchema, searchVoicesSchema, soundEffectSchema } from '../validators/voice.validator';

const router: ExpressRouter = Router();

router.use(requireAuth);

router.get('/voices', voiceController.listVoices);
router.get('/voices/search', validate(searchVoicesSchema), voiceController.searchVoices);
router.post('/speech', voiceLimiter, validate(createSpeechSchema), voiceController.createSpeech);
router.post('/preview', voiceLimiter, validate(previewVoiceSchema), voiceController.previewVoice);
router.post('/own/sample-url', uploadLimiter, validate(createSampleUploadSchema), voiceController.createSampleUpload);
router.post('/own', voiceLimiter, validate(createOwnVoiceSchema), voiceController.createOwnVoice);
router.delete('/own', voiceController.deleteOwnVoice);

// Audio tools
router.post('/cleanup', voiceLimiter, validate(cleanUpAudioSchema), audioToolsController.cleanUpAudio);
router.post('/sound-effect', voiceLimiter, validate(soundEffectSchema), audioToolsController.createSoundEffect);
router.get('/dub/languages', audioToolsController.listDubLanguages);
router.post('/dub', voiceLimiter, validate(createDubSchema), audioToolsController.createDub);
router.get('/dub/:id', validate(getDubSchema), audioToolsController.getDub);

export default router;
