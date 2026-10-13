import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { searchStockItems } from '../controllers/stock.controller';

const searchSchema = z.object({
  query: z.object({
    kind: z.enum(['photo', 'video']),
    q: z.string().trim().min(1).max(100),
    page: z.string().regex(/^\d{1,2}$/).optional(),
    orientation: z.enum(['horizontal', 'vertical']).optional(),
  }),
});

const router: ExpressRouter = Router();
router.use(requireAuth);
router.get('/search', validate(searchSchema), searchStockItems);
export default router;
