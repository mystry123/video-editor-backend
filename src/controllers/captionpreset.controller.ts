import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { CaptionPreset, ICaptionStyles, IPreviewStyles } from '../models/CaptionPreset';
import { PRESET_CATEGORIES } from '../constants/preset-categories';

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
      const { category, search, type, tag } = req.query;

      // Build query
      const query: any = {
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
        query.$text = { $search: search as string };
      }

      const presets = await CaptionPreset.find(query)
        .sort({ isSystem: -1, usageCount: -1, createdAt: -1 })
        .select('-__v')
        .lean();

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
        res.status(400).json({ error: 'Invalid preset ID' });
        return;
      }

      const preset = await CaptionPreset.findById(presetId).lean();

      if (!preset) {
        res.status(404).json({ error: 'Preset not found' });
        return;
      }

      // Check access for non-public, non-system presets
      const userId = req.user?._id?.toString();
      if (!preset.isSystem && !preset.isPublic) {
        if (!userId || preset.userId?.toString() !== userId) {
          res.status(403).json({ error: 'Access denied' });
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
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const body: CreatePresetBody = req.body;

      // Validate required fields
      if (!body.name || !body.styles || !body.previewStyles) {
        res.status(400).json({ 
          error: 'Missing required fields: name, styles, previewStyles' 
        });
        return;
      }

      // Check for duplicate name for this user
      const existingPreset = await CaptionPreset.findOne({
        userId: new Types.ObjectId(userId),
        name: body.name,
        isSystem: false,
      });

      if (existingPreset) {
        res.status(409).json({ 
          error: 'You already have a preset with this name' 
        });
        return;
      }

      const preset = await CaptionPreset.create({
        userId: new Types.ObjectId(userId),
        name: body.name,
        description: body.description,
        category: body.category || 'custom',
        tags: body.tags || [],
        styles: body.styles,
        previewStyles: body.previewStyles,
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
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (!Types.ObjectId.isValid(presetId)) {
        res.status(400).json({ error: 'Invalid preset ID' });
        return;
      }

      // Find preset and verify ownership
      const preset = await CaptionPreset.findById(presetId);

      if (!preset) {
        res.status(404).json({ error: 'Preset not found' });
        return;
      }

      if (preset.isSystem) {
        res.status(403).json({ error: 'Cannot edit system presets' });
        return;
      }

      if (preset.userId?.toString() !== userId) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const body: UpdatePresetBody = req.body;

      // Update allowed fields
      if (body.name !== undefined) preset.name = body.name;
      if (body.description !== undefined) preset.description = body.description;
      if (body.category !== undefined) preset.category = body.category;
      if (body.tags !== undefined) preset.tags = body.tags;
      if (body.isPublic !== undefined) preset.isPublic = body.isPublic;
      
      // Update styles (merge with existing)
      if (body.styles) {
        preset.styles = { ...preset.styles, ...body.styles } as any;
      }
      
      // Update preview styles (merge with existing)
      if (body.previewStyles) {
        preset.previewStyles = { ...preset.previewStyles, ...body.previewStyles } as any;
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
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (!Types.ObjectId.isValid(presetId)) {
        res.status(400).json({ error: 'Invalid preset ID' });
        return;
      }

      const preset = await CaptionPreset.findById(presetId);

      if (!preset) {
        res.status(404).json({ error: 'Preset not found' });
        return;
      }

      if (preset.isSystem) {
        res.status(403).json({ error: 'Cannot delete system presets' });
        return;
      }

      if (preset.userId?.toString() !== userId) {
        res.status(403).json({ error: 'Access denied' });
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
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (!Types.ObjectId.isValid(presetId)) {
        res.status(400).json({ error: 'Invalid preset ID' });
        return;
      }

      const sourcePreset = await CaptionPreset.findById(presetId).lean();

      if (!sourcePreset) {
        res.status(404).json({ error: 'Preset not found' });
        return;
      }

      // Check access for non-public, non-system presets
      if (!sourcePreset.isSystem && !sourcePreset.isPublic) {
        if (sourcePreset.userId?.toString() !== userId) {
          res.status(403).json({ error: 'Access denied' });
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
      const presetId = req.params.id;

      if (!Types.ObjectId.isValid(presetId)) {
        res.status(400).json({ error: 'Invalid preset ID' });
        return;
      }

      await CaptionPreset.incrementUsage(presetId);

      res.json({ message: 'Usage recorded' });
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
        res.status(401).json({ error: 'Authentication required' });
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