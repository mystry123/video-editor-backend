// routes/caption.routes.ts

import { Router } from 'express';
import { CaptionProjectController } from '../controllers/caption.controller';
import { CaptionPresetController } from '../controllers/captionpreset.controller';
import { requireAuth } from '../middleware/auth.middleware';
import {
  checkCaptionProjectQuota,
  checkCaptionTranscriptionQuota,
  checkCaptionRenderQuota,
  checkCaptionExportQuota,
  checkCustomPresetQuota,
  checkVideoUploadQuota,
  attachUsageSummary
} from '../middleware/quota.middleware';

const router:Router = Router();

// ============================================================================
// All routes require authentication
// ============================================================================

router.use(requireAuth);
// router.use(attachUsageSummary);

// ============================================================================
// CAPTION PROJECTS - Main Flow
// ============================================================================

/**
 * POST /api/captions/projects
 * 
 * Create a new caption project and start processing
 * Flow: Create → Transcribe → Generate Composition → Render → Done
 * 
 * Request Body:
 * {
 *   fileId: string (required) - Video file ID
 *   presetId?: string - Caption preset to use
 *   settings?: {
 *     position?: 'top' | 'center' | 'bottom',
 *     wordsPerLine?: number,
 *     linesPerPage?: number,
 *     fontSize?: number,
 *     outputFormat?: 'mp4' | 'webm' | 'mov'
 *   }
 *   name?: string - Project name
 * }
 * 
 * Response: { success: true, data: { id, status: "pending" } }
 */
router.post('/projects', checkCaptionProjectQuota, CaptionProjectController.create);

/**
 * GET /api/captions/projects
 * 
 * List user's caption projects
 * 
 * Query Params:
 * - status?: 'pending' | 'transcribing' | 'generating' | 'rendering' | 'completed' | 'failed'
 * - page?: number (default: 1)
 * - limit?: number (default: 20, max: 100)
 * 
 * Response: { success: true, data: [...], pagination: {...} }
 */
router.get('/projects', CaptionProjectController.list);

/**
 * GET /api/captions/projects/:id/status
 * 
 * Get project status for polling
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     id, status, progress (0-100),
 *     stages: {
 *       transcription: { status, progress },
 *       generation: { status, progress },
 *       rendering: { status, progress }
 *     },
 *     message: "Rendering video...",
 *     outputUrl?: string,
 *     error?: string
 *   }
 * }
 */
router.get('/projects/:id/status', CaptionProjectController.getStatus);

/**
 * GET /api/captions/projects/:id
 * 
 * Get full project details
 * 
 * Response: { success: true, data: { ...fullProject } }
 */
router.get('/projects/:id', CaptionProjectController.getOne);

/**
 * POST /api/captions/projects/:id/cancel
 * 
 * Cancel a project in progress
 * 
 * Response: { success: true, message: "Project cancelled" }
 */
router.post('/projects/:id/cancel', CaptionProjectController.cancel);

/**
 * DELETE /api/captions/projects/:id
 * 
 * Delete a project (must not be in progress)
 * 
 * Response: { success: true, message: "Project deleted" }
 */
router.delete('/projects/:id', CaptionProjectController.delete);

/**
 * PATCH /api/captions/projects/:id/preset
 * 
 * Update preset (only before rendering starts)
 * 
 * Request Body: { presetId: string }
 * Response: { success: true, message: "Preset updated" }
 */
router.patch('/projects/:id/preset', CaptionProjectController.updatePreset);


// ============================================================================
// CAPTION PRESETS
// ============================================================================

/**
 * GET /api/captions/presets
 * 
 * List all available presets (system + user's custom)
 * 
 * Query Params:
 * - category?: string - Filter by category
 * - search?: string - Search by name
 * - type?: 'system' | 'custom' | 'all' (default: 'all')
 * 
 * Response: { success: true, data: { presets: [...], total: number } }
 */
router.get('/presets', CaptionPresetController.getAll);



/**
 * GET /api/captions/presets/mine
 * 
 * Get user's custom presets only
 * 
 * Response: { success: true, data: { presets: [...] } }
 */
router.get('/presets/mine', CaptionPresetController.getMyPresets);

/**
 * GET /api/captions/presets/:id
 * 
 * Get a single preset by ID
 * 
 * Response: { success: true, data: { preset } }
 */
router.get('/presets/:id', CaptionPresetController.getOne);

/**
 * POST /api/captions/presets
 * 
 * Create a custom preset
 * 
 * Request Body:
 * {
 *   name: string (required),
 *   styles: { fontFamily, fillColor, highlightColor, ... },
 *   previewStyles?: { text, backgroundColor },
 *   category?: string,
 *   tags?: string[]
 * }
 * 
 * Response: { success: true, data: { preset } }
 */
router.post('/presets', checkCustomPresetQuota, CaptionPresetController.create);

/**
 * PUT /api/captions/presets/:id
 * 
 * Update a custom preset (full update)
 * 
 * Response: { success: true, data: { preset } }
 */
router.put('/presets/:id', CaptionPresetController.update);

/**
 * PATCH /api/captions/presets/:id
 * 
 * Partially update a custom preset
 * 
 * Response: { success: true, data: { preset } }
 */
router.patch('/presets/:id', CaptionPresetController.patch);

/**
 * DELETE /api/captions/presets/:id
 * 
 * Delete a custom preset (cannot delete system presets)
 * 
 * Response: { success: true, message: "Preset deleted" }
 */
router.delete('/presets/:id', CaptionPresetController.delete);

/**
 * POST /api/captions/presets/:id/duplicate
 * 
 * Duplicate any preset as a custom preset
 * 
 * Response: { success: true, data: { preset } }
 */
router.post('/presets/:id/duplicate', checkCustomPresetQuota, CaptionPresetController.duplicate);

/**
 * POST /api/captions/presets/:id/use
 * 
 * Record usage of a preset (for analytics/sorting)
 * 
 * Response: { success: true }
 */
router.post('/presets/:id/use', CaptionPresetController.incrementUsage);


// ============================================================================
// UTILITY ENDPOINTS
// ============================================================================

/**
 * GET /api/captions/settings/defaults
 * 
 * Get default caption settings for a given aspect ratio
 * 
 * Query Params:
 * - width?: number (default: 1920)
 * - height?: number (default: 1080)
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     aspectRatio: 'portrait' | 'landscape',
 *     settings: { fontSize, wordsPerLine, linesPerPage, ... }
 *   }
 * }
 */
router.get('/settings/defaults', (req, res) => {
  const width = parseInt(req.query.width as string) || 1920;
  const height = parseInt(req.query.height as string) || 1080;
  const isPortrait = height > width;

  const settings = isPortrait
    ? {
        fontSize: 5.5,
        wordsPerLine: 4,
        linesPerPage: 2,
        widthPercent: 90,
        heightPercent: 15,
        position: 'bottom',
      }
    : {
        fontSize: 4,
        wordsPerLine: 6,
        linesPerPage: 2,
        widthPercent: 80,
        heightPercent: 20,
        position: 'bottom',
      };

  res.json({
    success: true,
    data: {
      aspectRatio: isPortrait ? 'portrait' : 'landscape',
      width,
      height,
      settings,
    },
  });
});


export default router;