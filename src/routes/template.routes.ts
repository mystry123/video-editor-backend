import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import * as templateController from '../controllers/template.controller';
import {
  createTemplateSchema,
  updateTemplateSchema,
  listTemplatesSchema,
} from '../validators/template.validator';

const router: Router = Router();

router.use(requireAuth);

router.post('/', validate(createTemplateSchema), templateController.createTemplate);
router.get('/', validate(listTemplatesSchema), templateController.listTemplates);
router.get('/:id', templateController.getTemplate);
router.put('/:id', validate(updateTemplateSchema), templateController.updateTemplate);
router.delete('/:id', templateController.deleteTemplate);

// Get all renders for a template
router.get('/:id/renders', templateController.getTemplateRenders);

// Bulk operations
router.post('/bulk-delete', templateController.bulkDeleteTemplates);

// Version management
router.get('/:id/versions', templateController.getTemplateVersions);
router.post('/:id/restore/:version', templateController.restoreVersion);

// Duplicate
router.post('/:id/duplicate', templateController.duplicateTemplate);

export default router;
