import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import * as transcriptionController from '../controllers/transcription.controller';
import { createTranscriptionSchema } from '../validators/transcription.validator';

const router = Router();

router.use(requireAuth);

router.post('/', validate(createTranscriptionSchema), transcriptionController.createTranscription);
router.get('/:id', transcriptionController.getTranscription);
router.get('/file/:fileId', transcriptionController.getTranscriptionByFile);
router.delete('/:id', transcriptionController.deleteTranscription);

export default router;
