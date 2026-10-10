import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/errorResponse';
import { Types } from 'mongoose';
import { CaptionPreset, ICaptionStyles, IPreviewStyles } from '../models/CaptionPreset';
import { PRESET_CATEGORIES } from '../constants/preset-categories';
import { env } from '../config/env';
import { recordPresetUse } from '../services/captionPresetUsage.service';
import { createPresetSchema, formatIssues, updatePresetSchema } from '../schemas/captionPreset';
import { CAPTION_STYLE_VERSION, fontUrlOnCdn } from '../schemas/captionStyle';

// ============================================================================
// Types
// ============================================================================

interface AuthenticatedRequest extends Request {
  user?: {
    _id: Types.ObjectId;
    role: string;
  };
}

interface CreatePresetBody {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  styles: ICaptionStyles;
  previewStyles: IPreviewStyles;
  isPublic?: boolean;
}

interface UpdatePresetBody {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  styles?: Partial<ICaptionStyles>;
  previewStyles?: Partial<IPreviewStyles>;
  isPublic?: boolean;
}

// ============================================================================
// Controller
// ============================================================================

export class CaptionPresetController {

  /**
   * GET /api/caption-presets
   * List all available presets for the user (system + own + public)
   */
  static async getAll(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      // Query values as plain strings: `?category[$ne]=x` arrives as an
      // object and would otherwise become a database operator
      const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 100) : undefined);
      const category = text(req.query.category);
      const search = text(req.query.search);
      const type = text(req.query.type);
      const tag = text(req.query.tag);

      // Build query (retired system styles stay out of the galleries)
      const query: any = {
        isHidden: { $ne: true },
        $or: [
          { isSystem: true },
          ...(userId ? [{ userId: new Types.ObjectId(userId) }] : []),
          { isPublic: true },
        ],
      };

      // Filter by category
      if (category && category !== 'all') {
        query.category = category;
      }

      // Filter by type (system, custom, public)
      if (type === 'system') {
        query.isSystem = true;
        delete query.$or;
      } else if (type === 'custom' && userId) {
        query.userId = new Types.ObjectId(userId);
        query.isSystem = false;
        delete query.$or;
      } else if (type === 'public') {
        query.isPublic = true;
        query.isSystem = false;
        delete query.$or;
      }

      // Filter by tag
      if (tag) {
        query.tags = tag;
      }

      // Text search
      if (search) {
        query.$text = { $search: search };
      }

      const found = await CaptionPreset.find(query)
        .sort({ sortOrder: 1, createdAt: 1 })
        .select('-__v')
        .lean();
      // The user's own styles are marked (the editor offers rename/update/
      // delete on them); other users' account ids aren't sent
      const presets = found.map(({ userId: owner, ...preset }) => {
        const isOwn = !!userId && !!owner && String(owner) === userId;
        return { ...preset, isOwn, ...(isOwn && { userId: owner }) };
      });

      // Group by category for frontend
      const groupedByCategory: Record<string, any[]> = {};
      for (const preset of presets) {
        const cat = preset.category || 'other';
        if (!groupedByCategory[cat]) {
          groupedByCategory[cat] = [];
        }
        groupedByCategory[cat].push(preset);
      }

      res.json({
        presets,
        grouped: groupedByCategory,
        categories: PRESET_CATEGORIES,
        total: presets.length,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/caption-presets/:id
   * Get single preset by ID
   */
  static async getOne(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const presetId = req.params.id;

      if (!Types.ObjectId.isValid(presetId)) {
        sendError(req, res, 400, 'Invalid preset ID', 'INVALID_ID');
        return;
      }

      const preset = await CaptionPreset.findById(presetId).lean();

      if (!preset) {
        sendError(req, res, 404, 'Preset not found', 'NOT_FOUND');
        return;
      }

      // Check access for non-public, non-system presets
      const userId = req.user?._id?.toString();
      if (!preset.isSystem && !preset.isPublic) {
        if (!userId || preset.userId?.toString() !== userId) {
          sendError(req, res, 403, 'Access denied', 'FORBIDDEN');
          return;
        }
      }

      res.json({ preset });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/caption-presets
   * Create a new custom preset
   */
  static async create(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      
      if (!userId) {
        sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
        return;
      }

      const parsed = createPresetSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(req, res, 400, `Invalid preset: ${formatIssues(parsed.error)}`, 'VALIDATION_ERROR');
        return;
      }
      const body = parsed.data;
      if (!fontUrlOnCdn(body.styles, env.cdnUrl)) {
        sendError(req, res, 400, 'Invalid preset: styles.fontUrl: must be a font you uploaded', 'VALIDATION_ERROR');
        return;
      }

      // Check for duplicate name for this user
      const existingPreset = await CaptionPreset.findOne({
        userId: new Types.ObjectId(userId),
        name: body.name,
        isSystem: false,
      });

      if (existingPreset) {
        sendError(req, res, 409, 'You already have a preset with this name', 'DUPLICATE');
        return;
      }

      const preset = await CaptionPreset.create({
        userId: new Types.ObjectId(userId),
        name: body.name,
        description: body.description,
        category: body.category || 'custom',
        tags: body.tags || [],
        styles: { ...body.styles, schemaVersion: CAPTION_STYLE_VERSION },
        schemaVersion: CAPTION_STYLE_VERSION,
        ...(body.previewStyles && { previewStyles: body.previewStyles }),
        isSystem: false,
        isPublic: body.isPublic || false,
        usageCount: 0,
      });

      res.status(201).json({ preset });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/caption-presets/:id
   * Update a custom preset (full replacement)
   */
  static async update(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      const presetId = req.params.id;

      if (!userId) {
        sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
        return;
      }

      if (!Types.ObjectId.isValid(presetId)) {
        sendError(req, res, 400, 'Invalid preset ID', 'INVALID_ID');
        return;
      }

      // Find preset and verify ownership
      const preset = await CaptionPreset.findById(presetId);

      if (!preset) {
        sendError(req, res, 404, 'Preset not found', 'NOT_FOUND');
        return;
      }

      if (preset.isSystem) {
        sendError(req, res, 403, 'Cannot edit system presets', 'FORBIDDEN');
        return;
      }

      if (preset.userId?.toString() !== userId) {
        sendError(req, res, 403, 'Access denied', 'FORBIDDEN');
        return;
      }

      const parsed = updatePresetSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(req, res, 400, `Invalid preset: ${formatIssues(parsed.error)}`, 'VALIDATION_ERROR');
        return;
      }
      const body = parsed.data;
      if (!fontUrlOnCdn(body.styles, env.cdnUrl)) {
        sendError(req, res, 400, 'Invalid preset: styles.fontUrl: must be a font you uploaded', 'VALIDATION_ERROR');
        return;
      }

      // Update allowed fields
      if (body.name !== undefined) preset.name = body.name;
      if (body.description !== undefined) preset.description = body.description;
      if (body.category !== undefined) preset.category = body.category;
      if (body.tags !== undefined) preset.tags = body.tags;
      if (body.isPublic !== undefined) preset.isPublic = body.isPublic;

      // A new style replaces the old one (a merge kept stale fields, e.g. a
      // removed animation); validated above
      if (body.styles) {
        preset.styles = { ...body.styles, schemaVersion: CAPTION_STYLE_VERSION } as any;
        preset.schemaVersion = CAPTION_STYLE_VERSION;
        preset.markModified('styles');
      }
      if (body.previewStyles) {
        preset.previewStyles = body.previewStyles as any;
      }

      await preset.save();

      res.json({ preset });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/caption-presets/:id
   * Partially update a custom preset
   */
  static async patch(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Same as update for this implementation
    return CaptionPresetController.update(req, res, next);
  }

  /**
   * DELETE /api/caption-presets/:id
   * Delete a custom preset
   */
  static async delete(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      const presetId = req.params.id;

      if (!userId) {
        sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
        return;
      }

      if (!Types.ObjectId.isValid(presetId)) {
        sendError(req, res, 400, 'Invalid preset ID', 'INVALID_ID');
        return;
      }

      const preset = await CaptionPreset.findById(presetId);

      if (!preset) {
        sendError(req, res, 404, 'Preset not found', 'NOT_FOUND');
        return;
      }

      if (preset.isSystem) {
        sendError(req, res, 403, 'Cannot delete system presets', 'FORBIDDEN');
        return;
      }

      if (preset.userId?.toString() !== userId) {
        sendError(req, res, 403, 'Access denied', 'FORBIDDEN');
        return;
      }

      await CaptionPreset.findByIdAndDelete(presetId);

      res.json({ message: 'Preset deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/caption-presets/:id/duplicate
   * Duplicate a preset (system or own) as a new custom preset
   */
  static async duplicate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      const presetId = req.params.id;
      const { name } = req.body;

      if (!userId) {
        sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
        return;
      }

      if (!Types.ObjectId.isValid(presetId)) {
        sendError(req, res, 400, 'Invalid preset ID', 'INVALID_ID');
        return;
      }

      const sourcePreset = await CaptionPreset.findById(presetId).lean();

      if (!sourcePreset) {
        sendError(req, res, 404, 'Preset not found', 'NOT_FOUND');
        return;
      }

      // Check access for non-public, non-system presets
      if (!sourcePreset.isSystem && !sourcePreset.isPublic) {
        if (sourcePreset.userId?.toString() !== userId) {
          sendError(req, res, 403, 'Access denied', 'FORBIDDEN');
          return;
        }
      }

      // Create duplicate
      const newPreset = await CaptionPreset.create({
        userId: new Types.ObjectId(userId),
        name: name || `${sourcePreset.name} (Copy)`,
        description: sourcePreset.description,
        category: 'custom',
        tags: [...sourcePreset.tags],
        styles: { ...sourcePreset.styles },
        previewStyles: { ...sourcePreset.previewStyles },
        isSystem: false,
        isPublic: false,
        usageCount: 0,
      });

      res.status(201).json({ preset: newPreset });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/caption-presets/:id/use
   * Increment usage count for a preset
   */
  static async incrementUsage(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      const presetId = req.params.id;

      if (!userId) {
        sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
        return;
      }
      if (!Types.ObjectId.isValid(presetId)) {
        sendError(req, res, 400, 'Invalid preset ID', 'INVALID_ID');
        return;
      }
      // What it was used in: one count per user, preset and project
      const projectKey = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
      if (!projectKey || projectKey.length > 100) {
        sendError(req, res, 400, 'projectId is required', 'VALIDATION_ERROR');
        return;
      }

      // Only styles this user may use (system, public or their own)
      const preset = await CaptionPreset.findOne({
        _id: presetId,
        $or: [{ isSystem: true }, { isPublic: true }, { userId: new Types.ObjectId(userId) }],
      }).select('_id');
      if (!preset) {
        sendError(req, res, 404, 'Preset not found', 'NOT_FOUND');
        return;
      }

      const counted = await recordPresetUse(presetId, userId, `template:${projectKey}`);
      res.json({ message: 'Usage recorded', counted });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/caption-presets/user/me
   * Get current user's custom presets only
   */
  static async getMyPresets(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?._id?.toString();

      if (!userId) {
        sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
        return;
      }

      const presets = await CaptionPreset.findUserPresets(userId);

      res.json({ 
        presets,
        total: presets.length,
      });
    } catch (error) {
      next(error);
    }
  }

}