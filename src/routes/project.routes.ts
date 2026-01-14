import { Router } from 'express';
import { getAll, getOne, getStatus, update, deleteProject, cancel, search } from '../controllers/project.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router:Router = Router();


router.use(requireAuth)
// List & Stats
router.get('/', getAll);

// Search
router.get('/search', search);

// Single project operations
router.get('/:id', getOne);
router.get('/:id/status', getStatus);
router.patch('/:id', update);
router.delete('/:id', deleteProject);

// Actions
router.post('/:id/cancel', cancel);

export default router;