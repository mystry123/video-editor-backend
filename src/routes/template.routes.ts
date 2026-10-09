import { Router, type Router as ExpressRouter } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkTemplateQuota, attachUsageSummary } from '../middleware/quota.middleware';
import * as templateController from '../controllers/template.controller';
import {
  createTemplateSchema,
  updateTemplateSchema,
  listTemplatesSchema,
  listTemplateVersionsSchema,
  getTemplateVersionSchema,
  restoreTemplateVersionSchema,
} from '../validators/template.validator';

const router: ExpressRouter = Router();

router.use(requireAuth);
// router.use(attachUsageSummary);

router.post('/', validate(createTemplateSchema), checkTemplateQuota, templateController.createTemplate);
router.get('/', validate(listTemplatesSchema), templateController.listTemplates);
router.get('/:id', templateController.getTemplate);
router.put('/:id', validate(updateTemplateSchema), templateController.updateTemplate);
router.delete('/:id', templateController.deleteTemplate);

// Get all renders for a template
router.get('/:id/renders', templateController.getTemplateRenders);

// Bulk operations
router.post('/bulk-delete', templateController.bulkDeleteTemplates);

// Version management
router.get('/:id/versions', validate(listTemplateVersionsSchema), templateController.getTemplateVersions);
router.get('/:id/versions/:version', validate(getTemplateVersionSchema), templateController.getTemplateVersion);
router.post('/:id/restore/:version', validate(restoreTemplateVersionSchema), templateController.restoreVersion);

// Duplicate
router.post('/:id/duplicate', checkTemplateQuota, templateController.duplicateTemplate);

export default router;
