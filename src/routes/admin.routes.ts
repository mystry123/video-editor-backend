import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireSession } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import * as adminController from '../controllers/admin.controller';

const router: ExpressRouter = Router();

// Admins only, and only from a signed-in session — never with an API key.
router.use(requireAuth, requireSession, requireRole(['admin']));

const changePlanSchema = z.object({
  body: z.object({ plan: z.enum(['free', 'pro', 'team', 'admin']) }),
});

const addOverrideSchema = z.object({
  body: z.object({
    field: z.string().min(1),
    value: z.unknown().refine((v) => v !== undefined, 'A value is required'),
    expiresAt: z.string().datetime().nullable().optional(),
    note: z.string().max(200).optional(),
  }),
});

const editPlanSchema = z.object({
  body: z.object({
    name: z.string().max(60).optional(),
    description: z.string().max(300).optional(),
    limits: z.record(z.unknown()).optional(),
  }),
});

router.get('/users', adminController.listUsers);
router.get('/users/:id', adminController.getUserDetail);
router.patch('/users/:id/plan', validate(changePlanSchema), adminController.changeUserPlan);
router.post('/users/:id/overrides', validate(addOverrideSchema), adminController.addUserOverride);
router.delete('/users/:id/overrides/:overrideId', adminController.removeUserOverride);

router.get('/plans', adminController.getPlans);
router.put('/plans/:key', validate(editPlanSchema), adminController.editPlan);

router.get('/audit', adminController.listAudit);

export default router;
