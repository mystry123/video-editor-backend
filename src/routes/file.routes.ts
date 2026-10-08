import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import type { AuthRequest } from '../types';
import { uploadLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkStorageQuota, checkVideoUploadQuota, attachUsageSummary } from '../middleware/quota.middleware';
import * as fileController from '../controllers/file.controller';
import { getUploadUrlSchema, importFromUrlSchema, importFromGoogleDriveSchema } from '../validators/file.validator';

const router: ExpressRouter = Router();

// The browser calls these directly with an upload ticket (it can't read the
// httpOnly session cookies). Everything else on this router needs a session.
const UPLOAD_TICKET_ROUTES: Array<[string, RegExp]> = [
  ['POST', /^\/upload-url$/],
  ['POST', /^\/[^/]+\/complete$/],
  ['POST', /^\/[^/]+\/thumbnail$/],
  ['POST', /^\/import\/url$/],
  ['POST', /^\/import\/google-drive$/],
  ['GET', /^\/import\/[^/]+\/status$/],
];
router.use((req: AuthRequest, _res, next) => {
  req.allowUploadTicket = UPLOAD_TICKET_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(req.path));
  next();
});

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