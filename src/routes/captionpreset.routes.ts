import { Router } from 'express';
import { CaptionPresetController } from '../controllers/captionpreset.controller';

const router:Router = Router();

/**
 * Caption Preset Routes
 * Base path: /api/caption-presets
 */

// ============================================================================
// Public routes (no auth required for reading system/public presets)
// ============================================================================

// GET /api/caption-presets - List all available presets
router.get('/', CaptionPresetController.getAll);



// GET /api/caption-presets/:id - Get single preset
router.get('/:id', CaptionPresetController.getOne);

// ============================================================================
// Protected routes (auth required)
// Apply your auth middleware before these routes in app.ts
// ============================================================================

// GET /api/caption-presets/user/me - Get current user's presets
router.get('/user/me', CaptionPresetController.getMyPresets);

// POST /api/caption-presets - Create new preset
router.post('/', CaptionPresetController.create);

// PUT /api/caption-presets/:id - Update preset (full)
router.put('/:id', CaptionPresetController.update);

// PATCH /api/caption-presets/:id - Update preset (partial)
router.patch('/:id', CaptionPresetController.patch);

// DELETE /api/caption-presets/:id - Delete preset
router.delete('/:id', CaptionPresetController.delete);

// POST /api/caption-presets/:id/duplicate - Duplicate preset
router.post('/:id/duplicate', CaptionPresetController.duplicate);

// POST /api/caption-presets/:id/use - Record usage
router.post('/:id/use', CaptionPresetController.incrementUsage);

export default router;