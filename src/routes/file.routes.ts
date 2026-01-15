import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkStorageQuota, checkVideoUploadQuota, attachUsageSummary } from '../middleware/quota.middleware';
import * as fileController from '../controllers/file.controller';
import { getUploadUrlSchema, importFromUrlSchema, importFromGoogleDriveSchema } from '../validators/file.validator';

const router: ExpressRouter = Router();

router.use(requireAuth);

// Existing routes
router.post('/upload-url', uploadLimiter, validate(getUploadUrlSchema), fileController.getUploadUrl);
router.post('/:id/complete', fileController.completeUpload);
router.get('/', fileController.listFiles);
router.get('/:id', fileController.getFile);
router.post('/:id/thumbnail', fileController.uploadThumbnail);
router.delete('/:id', fileController.deleteFile);

// New import routes
router.post('/import/url', uploadLimiter, validate(importFromUrlSchema), fileController.importFromUrl);
router.post('/import/google-drive', uploadLimiter, validate(importFromGoogleDriveSchema), fileController.importFromGoogleDrive);
router.get('/import/:id/status', fileController.getImportStatus);

export default router;