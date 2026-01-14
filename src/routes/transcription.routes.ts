import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkTranscriptionQuota, attachUsageSummary } from '../middleware/quota.middleware';
import * as transcriptionController from '../controllers/transcription.controller';
import { createTranscriptionSchema } from '../validators/transcription.validator';

const router: ExpressRouter = Router();

router.use(requireAuth);
// router.use(attachUsageSummary);

router.post('/', validate(createTranscriptionSchema), checkTranscriptionQuota, transcriptionController.createTranscription);
router.get('/:id', transcriptionController.getTranscription);
router.get('/file/:fileId', transcriptionController.getTranscriptionByFile);
router.delete('/:id', transcriptionController.deleteTranscription);

export default router;
