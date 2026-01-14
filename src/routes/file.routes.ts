import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkStorageQuota, checkVideoUploadQuota, attachUsageSummary } from '../middleware/quota.middleware';
import * as fileController from '../controllers/file.controller';
import { getUploadUrlSchema } from '../validators/file.validator';

const router: ExpressRouter = Router();

router.use(requireAuth);
// router.use(attachUsageSummary);

router.post('/upload-url', uploadLimiter, validate(getUploadUrlSchema), fileController.getUploadUrl);
router.post('/:id/complete', fileController.completeUpload);
router.get('/', fileController.listFiles);
router.get('/:id', fileController.getFile);
router.post('/:id/thumbnail', fileController.uploadThumbnail);
router.delete('/:id', fileController.deleteFile);

export default router;
